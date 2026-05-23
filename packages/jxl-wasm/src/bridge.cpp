#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <algorithm>

#include <jxl/color_encoding.h>
#include <jxl/decode.h>
#include <jxl/encode.h>
#include <jxl/types.h>

// IMPROVEMENT-1: `next` pointer enables sidecar linked-list without extra allocation.
struct JxlWasmBuffer {
  uint8_t* data;
  size_t size;
  uint32_t width;
  uint32_t height;
  uint32_t bits_per_sample;
  uint32_t has_alpha;
  int error;
  JxlWasmBuffer* next;  // sidecar chain (null = last); caller walks and frees individually
};
// WASM32 layout: 8 × 4 bytes = 32 bytes, all 4-byte aligned — safe for HEAPU32 direct reads.

// #11: Streaming encoder state — encode once, yield output in 64 KB chunks.
// #16: Extended with streaming input fields: pre-allocate pixel buffer in WASM,
// push chunks directly, encode on finish — eliminates JS-side pixel accumulation.
struct JxlWasmEncState {
  // Output side (streaming output — shared by both paths)
  uint8_t* outbuf;
  size_t   outbuf_size;
  size_t   taken;         // bytes already returned via enc_take_chunk
  int      error_code;
  // Input side (#16: streaming input — only used when created via enc_create_image)
  uint8_t* pixels_buf;    // pre-allocated full pixel buffer; freed after enc_finish
  size_t   pixels_size;   // total expected bytes: width × height × 4 × bpc
  size_t   pixels_written;
  uint32_t enc_width;
  uint32_t enc_height;
  float    enc_distance;
  uint32_t enc_effort;
  uint32_t enc_fmt;
  uint32_t enc_has_alpha;
};

// IMPROVEMENT-3: raw malloc for progressive decoder avoids std::vector<uint8_t> zero-init.
struct JxlWasmDecState {
  JxlDecoder* dec;
  JxlBasicInfo info;
  bool info_known;
  JxlPixelFormat pixel_format;
  uint8_t* pixels;       // working pixel buffer (raw malloc; null until first NEED_IMAGE_OUT_BUFFER)
  size_t   pixels_size;
  uint8_t* flushed;      // most recent flushed progressive frame (raw malloc; transferred on take)
  size_t   flushed_size;
  bool flushed_ready;
  bool final_ready;
  bool input_closed;
  int error_code;
};

#define JXL_DEC_RESULT_NEED_MORE  0
#define JXL_DEC_RESULT_PROGRESS   1
#define JXL_DEC_RESULT_DONE       2
#define JXL_DEC_RESULT_ERROR     -1

static JxlWasmBuffer* MakeError(int error) {
  JxlWasmBuffer* out = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
  if (out != nullptr) {
    out->error = error;
  }
  return out;
}

static JxlWasmBuffer* MakeBuffer(const uint8_t* data, size_t size, uint32_t width, uint32_t height, uint32_t bits, uint32_t alpha) {
  JxlWasmBuffer* out = static_cast<JxlWasmBuffer*>(malloc(sizeof(JxlWasmBuffer) + size));
  if (out == nullptr) return nullptr;
  out->data = reinterpret_cast<uint8_t*>(out + 1);
  memcpy(out->data, data, size);
  out->size = size;
  out->width = width;
  out->height = height;
  out->bits_per_sample = bits;
  out->has_alpha = alpha;
  out->error = 0;
  out->next = nullptr;
  return out;
}

// IMPROVEMENT-1: Zero-copy buffer — caller transfers ownership of `data`.
// On malloc failure, frees `data` and returns nullptr so caller need not check.
static JxlWasmBuffer* MakeBufferFromOwned(uint8_t* data, size_t size, uint32_t width, uint32_t height, uint32_t bits, uint32_t alpha) {
  JxlWasmBuffer* out = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
  if (out == nullptr) { free(data); return nullptr; }
  out->data = data;
  out->size = size;
  out->width = width;
  out->height = height;
  out->bits_per_sample = bits;
  out->has_alpha = alpha;
  return out;
}

static void FreeBufferNoChain(JxlWasmBuffer* buf) {
  if (buf == nullptr) return;
  if (buf->data != nullptr && buf->data != reinterpret_cast<uint8_t*>(buf + 1)) {
    free(buf->data);
  }
  free(buf);
}

static JxlDataType FormatToDataType(uint32_t fmt) {
  if (fmt == 1) return JXL_TYPE_UINT16;
  if (fmt == 2) return JXL_TYPE_FLOAT;
  return JXL_TYPE_UINT8;
}
static uint32_t FormatToBits(uint32_t fmt) {
  if (fmt == 1) return 16;
  if (fmt == 2) return 32;
  return 8;
}
static uint32_t FormatToExponentBits(uint32_t fmt) {
  return (fmt == 2) ? 8u : 0u;
}

// Nearest-neighbour downsampler. Power-of-two factors special-cased to avoid per-pixel std::min.
// src/dst are RGBA with bpp bytes per pixel (4, 8, or 16).
static void DownsampleRgba(const uint8_t* src, uint32_t sw, uint32_t sh,
                           uint8_t* dst, uint32_t dw, uint32_t dh,
                           uint32_t bpp, uint32_t downsample) {
  if (downsample == 2u) {
    for (uint32_t y = 0; y < dh; ++y) {
      const uint8_t* src_row = src + static_cast<size_t>(y * 2u) * sw * bpp;
      uint8_t*       dst_row = dst + static_cast<size_t>(y)       * dw * bpp;
      for (uint32_t x = 0; x < dw; ++x)
        memcpy(dst_row + x * bpp, src_row + x * 2u * bpp, bpp);
    }
  } else if (downsample == 4u) {
    for (uint32_t y = 0; y < dh; ++y) {
      const uint8_t* src_row = src + static_cast<size_t>(y * 4u) * sw * bpp;
      uint8_t*       dst_row = dst + static_cast<size_t>(y)       * dw * bpp;
      for (uint32_t x = 0; x < dw; ++x)
        memcpy(dst_row + x * bpp, src_row + x * 4u * bpp, bpp);
    }
  } else if (downsample == 8u) {
    for (uint32_t y = 0; y < dh; ++y) {
      const uint8_t* src_row = src + static_cast<size_t>(y * 8u) * sw * bpp;
      uint8_t*       dst_row = dst + static_cast<size_t>(y)       * dw * bpp;
      for (uint32_t x = 0; x < dw; ++x)
        memcpy(dst_row + x * bpp, src_row + x * 8u * bpp, bpp);
    }
  } else {
    for (uint32_t y = 0; y < dh; ++y) {
      const uint32_t sy      = std::min(y * downsample, sh - 1u);
      const uint8_t* src_row = src + static_cast<size_t>(sy) * sw * bpp;
      uint8_t*       dst_row = dst + static_cast<size_t>(y)  * dw * bpp;
      for (uint32_t x = 0; x < dw; ++x) {
        const uint32_t sx = std::min(x * downsample, sw - 1u);
        memcpy(dst_row + x * bpp, src_row + sx * bpp, bpp);
      }
    }
  }
}

// IMPROVEMENT-2: Raw malloc replaces std::vector zero-init + MakeBuffer memcpy for decode.
static JxlWasmBuffer* DecodeRgba(const uint8_t* input, size_t input_size, uint32_t downsample, uint32_t fmt) {
  if (input == nullptr || input_size == 0) return MakeError(1);

  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) return MakeError(2);

  if (JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec); return MakeError(3);
  }
  // JxlDecoderSetDownsamplingFactor was removed in libjxl 0.11.x; decode full-res and
  // downsample manually via DownsampleRgba below.

  JxlDecoderSetInput(dec, input, input_size);
  JxlDecoderCloseInput(dec);

  JxlBasicInfo info{};
  uint8_t* pixels_raw = nullptr;
  size_t pixels_size = 0;
  JxlPixelFormat pf = {4, FormatToDataType(fmt), JXL_NATIVE_ENDIAN, 0};

  JxlDecoderStatus status;
  while ((status = JxlDecoderProcessInput(dec)) != JXL_DEC_SUCCESS) {
    if (status == JXL_DEC_ERROR || status == JXL_DEC_NEED_MORE_INPUT) {
      free(pixels_raw); JxlDecoderDestroy(dec); return MakeError(static_cast<int>(status));
    }
    if (status == JXL_DEC_BASIC_INFO) {
      if (JxlDecoderGetBasicInfo(dec, &info) != JXL_DEC_SUCCESS) { free(pixels_raw); JxlDecoderDestroy(dec); return MakeError(10); }
      continue;
    }
    if (status == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t buf_size = 0;
      if (JxlDecoderImageOutBufferSize(dec, &pf, &buf_size) != JXL_DEC_SUCCESS) { free(pixels_raw); JxlDecoderDestroy(dec); return MakeError(11); }
      if (buf_size > pixels_size) {
        free(pixels_raw);
        pixels_raw = static_cast<uint8_t*>(malloc(buf_size));
        if (pixels_raw == nullptr) { JxlDecoderDestroy(dec); return MakeError(14); }
        pixels_size = buf_size;
      }
      // Direct-buffer decode: libjxl writes pixels straight into pixels_raw — no intermediate
      // copy. Result is returned via MakeBufferFromOwned (ownership transfer, no memcpy).
      if (JxlDecoderSetImageOutBuffer(dec, &pf, pixels_raw, pixels_size) != JXL_DEC_SUCCESS) { free(pixels_raw); JxlDecoderDestroy(dec); return MakeError(12); }
      continue;
    }
  }

  JxlDecoderDestroy(dec);
  if (pixels_raw == nullptr || pixels_size == 0 || info.xsize == 0 || info.ysize == 0) {
    free(pixels_raw); return MakeError(13);
  }

  if (downsample <= 1u) {
    return MakeBufferFromOwned(pixels_raw, pixels_size, info.xsize, info.ysize, FormatToBits(fmt), 1);
  }

  const uint32_t out_w    = (info.xsize + downsample - 1u) / downsample;
  const uint32_t out_h    = (info.ysize + downsample - 1u) / downsample;
  const uint32_t bpp      = 4u * (FormatToBits(fmt) >> 3u);
  const size_t   out_size = static_cast<size_t>(out_w) * out_h * bpp;
  uint8_t* out_pixels = static_cast<uint8_t*>(malloc(out_size));
  if (out_pixels == nullptr) { free(pixels_raw); return MakeError(15); }
  DownsampleRgba(pixels_raw, info.xsize, info.ysize, out_pixels, out_w, out_h, bpp, downsample);
  free(pixels_raw);
  return MakeBufferFromOwned(out_pixels, out_size, out_w, out_h, FormatToBits(fmt), 1);
}

// #10: C++ region crop — decode full image with downsampling, then crop in C++.
// crop_* are in original (pre-downsample) image coords.
static JxlWasmBuffer* DecodeRgbaRegion(const uint8_t* input, size_t input_size,
    uint32_t crop_x, uint32_t crop_y, uint32_t crop_w, uint32_t crop_h,
    uint32_t downsample, uint32_t fmt) {
  JxlWasmBuffer* full = DecodeRgba(input, input_size, downsample, fmt);
  if (full == nullptr || full->error != 0) return full;

  const uint32_t ds   = (downsample > 1u) ? downsample : 1u;
  const uint32_t sx   = crop_x / ds;
  const uint32_t sy_  = crop_y / ds;
  const uint32_t sw   = (crop_w + ds - 1u) / ds;
  const uint32_t sh_  = (crop_h + ds - 1u) / ds;
  const uint32_t iw   = full->width;
  const uint32_t ih   = full->height;
  const uint32_t ax   = std::min(sx,  iw);
  const uint32_t ay   = std::min(sy_, ih);
  const uint32_t aw   = std::min(sw,  iw - ax);
  const uint32_t ah   = std::min(sh_, ih - ay);

  if (aw == 0 || ah == 0) {
    FreeBufferNoChain(full); return MakeError(32);  // crop outside image bounds
  }
  if (ax == 0 && ay == 0 && aw == iw && ah == ih) {
    return full;  // no-op crop
  }

  const uint32_t bits         = full->bits_per_sample;
  const uint32_t bps          = (bits == 32u) ? 4u : (bits == 16u) ? 2u : 1u;
  const uint32_t bytes_per_px = 4u * bps;
  const size_t   row_bytes    = static_cast<size_t>(aw) * bytes_per_px;
  const size_t   out_size     = row_bytes * static_cast<size_t>(ah);

  uint8_t* cropped = static_cast<uint8_t*>(malloc(out_size));
  if (cropped == nullptr) { FreeBufferNoChain(full); return MakeError(30); }

  for (uint32_t row = 0; row < ah; ++row) {
    const uint8_t* src = full->data + (static_cast<size_t>(ay + row) * iw + ax) * bytes_per_px;
    memcpy(cropped + row * row_bytes, src, row_bytes);
  }
  FreeBufferNoChain(full);

  JxlWasmBuffer* result = MakeBufferFromOwned(cropped, out_size, aw, ah, bits, 1u);
  return result != nullptr ? result : MakeError(31);
}

static JxlWasmBuffer* EncodeRgbaWithMetadata(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size) {
  if (pixels == nullptr || width == 0 || height == 0) return MakeError(20);

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return MakeError(21);

  const uint32_t bits     = FormatToBits(fmt);
  const uint32_t exp_bits = FormatToExponentBits(fmt);

  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize                  = width;
  info.ysize                  = height;
  info.bits_per_sample        = bits;
  info.exponent_bits_per_sample = exp_bits;
  info.num_color_channels     = 3;
  info.num_extra_channels     = has_alpha ? 1u : 0u;
  info.alpha_bits             = has_alpha ? bits : 0u;
  info.alpha_exponent_bits    = has_alpha ? exp_bits : 0u;

  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(22); }

  if (icc_profile != nullptr && icc_size > 0) {
    if (JxlEncoderSetICCProfile(enc, icc_profile, icc_size) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return MakeError(51);
    }
  }

  JxlColorEncoding color;
  JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
  if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(23); }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  JxlEncoderSetFrameDistance(frame, distance);
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));

  const size_t bytes_per_channel = (fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u;
  const uint32_t num_channels = has_alpha ? 4u : 3u;
  JxlPixelFormat pf = {num_channels, FormatToDataType(fmt), JXL_NATIVE_ENDIAN, 0};

  // Strip alpha channel via raw malloc (avoids std::vector zero-init overhead).
  uint8_t* rgb_pixels = nullptr;
  const uint8_t* encode_src = pixels;
  size_t pixel_size;
  if (!has_alpha) {
    const size_t n_pixels  = static_cast<size_t>(width) * height;
    const size_t src_stride = 4u * bytes_per_channel;
    const size_t dst_stride = 3u * bytes_per_channel;
    pixel_size = n_pixels * dst_stride;
    rgb_pixels = static_cast<uint8_t*>(malloc(pixel_size));
    if (rgb_pixels == nullptr) { JxlEncoderDestroy(enc); return MakeError(29); }
    for (size_t i = 0; i < n_pixels; ++i)
      memcpy(rgb_pixels + i * dst_stride, pixels + i * src_stride, dst_stride);
    encode_src = rgb_pixels;
  } else {
    pixel_size = static_cast<size_t>(width) * height * 4u * bytes_per_channel;
  }

  const JxlEncoderStatus add_status = JxlEncoderAddImageFrame(frame, &pf, encode_src, pixel_size);
  free(rgb_pixels);
  if (add_status != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(24); }

  if (exif != nullptr && exif_size > 0) {
    if (JxlEncoderAddBox(enc, "Exif", exif, exif_size, JXL_FALSE) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return MakeError(52);
    }
  }

  if (xmp != nullptr && xmp_size > 0) {
    if (JxlEncoderAddBox(enc, "xml ", xmp, xmp_size, JXL_FALSE) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return MakeError(53);
    }
  }

  JxlEncoderCloseInput(enc);

  const size_t initial_size = std::max(size_t(65536),
      distance == 0.0f ? (static_cast<size_t>(width) * height * 4u * ((fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u)) / 2
                       : effort <= 3 ? (static_cast<size_t>(width) * height * 4u * ((fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u)) / 12
                       : (static_cast<size_t>(width) * height * 4u * ((fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u)) / 10);
  uint8_t* outbuf = static_cast<uint8_t*>(malloc(initial_size));
  if (outbuf == nullptr) { JxlEncoderDestroy(enc); return MakeError(25); }
  size_t outbuf_cap = initial_size;
  uint8_t* next_out = outbuf;
  size_t avail_out = outbuf_cap;
  for (;;) {
    JxlEncoderStatus status = JxlEncoderProcessOutput(enc, &next_out, &avail_out);
    if (status == JXL_ENC_SUCCESS) {
      const size_t final_size = static_cast<size_t>(next_out - outbuf);
      JxlEncoderDestroy(enc);
      JxlWasmBuffer* result = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
      if (result == nullptr) { free(outbuf); return MakeError(26); }
      result->data = outbuf;
      result->size = final_size;
      result->width = width;
      result->height = height;
      result->bits_per_sample = bits;
      result->has_alpha = has_alpha;
      return result;
    }
    if (status == JXL_ENC_NEED_MORE_OUTPUT) {
      const size_t offset = static_cast<size_t>(next_out - outbuf);
      outbuf_cap *= 2u;
      uint8_t* grown = static_cast<uint8_t*>(realloc(outbuf, outbuf_cap));
      if (grown == nullptr) { free(outbuf); JxlEncoderDestroy(enc); return MakeError(27); }
      outbuf = grown;
      next_out = outbuf + offset;
      avail_out = outbuf_cap - offset;
      continue;
    }
    free(outbuf);
    JxlEncoderDestroy(enc); return MakeError(static_cast<int>(status));
  }
}

static JxlWasmBuffer* EncodeRgba(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha) {
  return EncodeRgbaWithMetadata(pixels, width, height, distance, effort, fmt, has_alpha, nullptr, 0, nullptr, 0, nullptr, 0);
}

// IMPROVEMENT-5: Integer box-filter downscale for RGBA8 thumbnail generation.
// Pixel-perfect averaging avoids aliasing artifacts visible at small sizes.
static void BoxDownscaleRgba8(const uint8_t* src, uint32_t sw, uint32_t sh,
                               uint8_t* dst, uint32_t dw, uint32_t dh) {
  if (dw == 0 || dh == 0) return;
  for (uint32_t dy = 0; dy < dh; ++dy) {
    const uint32_t y0 = (dy * sh) / dh;
    const uint32_t y1 = ((dy + 1u) * sh + dh - 1u) / dh;  // ceiling division
    for (uint32_t dx = 0; dx < dw; ++dx) {
      const uint32_t x0 = (dx * sw) / dw;
      const uint32_t x1 = ((dx + 1u) * sw + dw - 1u) / dw;
      uint32_t r = 0, g = 0, b = 0, a = 0, count = 0;
      for (uint32_t sy = y0; sy < y1; ++sy) {
        const uint8_t* row = src + sy * sw * 4;
        for (uint32_t sx = x0; sx < x1; ++sx) {
          const uint8_t* px = row + sx * 4;
          r += px[0]; g += px[1]; b += px[2]; a += px[3];
          ++count;
        }
      }
      uint8_t* out = dst + (dy * dw + dx) * 4;
      out[0] = static_cast<uint8_t>(r / count);
      out[1] = static_cast<uint8_t>(g / count);
      out[2] = static_cast<uint8_t>(b / count);
      out[3] = static_cast<uint8_t>(a / count);
    }
  }
}

static bool LooksLikeJpeg(const uint8_t* p, size_t n) {
  return n >= 4 && p[0] == 0xFF && p[1] == 0xD8 && p[n - 2] == 0xFF && p[n - 1] == 0xD9;
}

extern "C" {

void jxl_wasm_bridge_anchor(void) {}

// Forward declaration for transcode used in encode_auto.
JxlWasmBuffer* jxl_wasm_transcode_jpeg_to_jxl(const uint8_t* jpeg, size_t jpeg_size);

// --- Stateful progressive decoder ---

JxlWasmDecState* jxl_wasm_dec_create(uint32_t format, uint32_t want_progressive) {
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) return nullptr;

  int events = JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE;
  if (want_progressive) events |= JXL_DEC_FRAME_PROGRESSION;
  if (JxlDecoderSubscribeEvents(dec, events) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec); return nullptr;
  }
  if (want_progressive && JxlDecoderSetProgressiveDetail(dec, kDC) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec); return nullptr;
  }

  JxlWasmDecState* s = static_cast<JxlWasmDecState*>(calloc(1, sizeof(JxlWasmDecState)));
  if (s == nullptr) { JxlDecoderDestroy(dec); return nullptr; }
  s->dec = dec;
  s->pixel_format = { 4, FormatToDataType(format), JXL_NATIVE_ENDIAN, 0 };
  return s;
}

int jxl_wasm_dec_push(JxlWasmDecState* s, const uint8_t* data, size_t size) {
  if (s == nullptr || s->error_code != 0) return JXL_DEC_RESULT_ERROR;
  if (data != nullptr && size > 0)
    JxlDecoderSetInput(s->dec, data, size);

  JxlDecoderStatus status;
  while (true) {
    status = JxlDecoderProcessInput(s->dec);

    if (status == JXL_DEC_NEED_MORE_INPUT) return JXL_DEC_RESULT_NEED_MORE;
    if (status == JXL_DEC_SUCCESS) { s->final_ready = true; return JXL_DEC_RESULT_DONE; }
    if (status == JXL_DEC_ERROR) { s->error_code = static_cast<int>(status); return JXL_DEC_RESULT_ERROR; }

    if (status == JXL_DEC_BASIC_INFO) {
      if (JxlDecoderGetBasicInfo(s->dec, &s->info) == JXL_DEC_SUCCESS) {
        s->info_known = true;
        // Pre-allocate pixels buffer now that dimensions are known — avoids the first
        // malloc on NEED_IMAGE_OUT_BUFFER and lets realloc extend in-place later.
        const size_t bpc = (s->pixel_format.data_type == JXL_TYPE_FLOAT) ? 4u :
                           (s->pixel_format.data_type == JXL_TYPE_UINT16) ? 2u : 1u;
        const size_t expected = static_cast<size_t>(s->info.xsize) * s->info.ysize * 4u * bpc;
        if (expected > 0 && expected > s->pixels_size) {
          uint8_t* grown = static_cast<uint8_t*>(realloc(s->pixels, expected));
          if (grown != nullptr) { s->pixels = grown; s->pixels_size = expected; }
        }
      }
      continue;
    }
    if (status == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t buf_size = 0;
      if (JxlDecoderImageOutBufferSize(s->dec, &s->pixel_format, &buf_size) != JXL_DEC_SUCCESS) {
        s->error_code = 11; return JXL_DEC_RESULT_ERROR;
      }
      // Grow-only: realloc can extend in-place (no content copy needed since libjxl
      // overwrites the entire buffer); falls back to relocate when in-place not possible.
      if (buf_size > s->pixels_size) {
        uint8_t* grown = static_cast<uint8_t*>(realloc(s->pixels, buf_size));
        if (grown == nullptr) { s->error_code = 14; return JXL_DEC_RESULT_ERROR; }
        s->pixels = grown;
        s->pixels_size = buf_size;
      }
      if (JxlDecoderSetImageOutBuffer(s->dec, &s->pixel_format, s->pixels, s->pixels_size) != JXL_DEC_SUCCESS) {
        s->error_code = 12; return JXL_DEC_RESULT_ERROR;
      }
      continue;
    }
    if (status == JXL_DEC_FRAME_PROGRESSION) {
      if (!s->info_known || s->pixels == nullptr) continue;
      size_t flush_size = 0;
      if (JxlDecoderImageOutBufferSize(s->dec, &s->pixel_format, &flush_size) != JXL_DEC_SUCCESS) continue;
      if (flush_size > s->flushed_size) {
        uint8_t* grown = static_cast<uint8_t*>(realloc(s->flushed, flush_size));
        if (grown == nullptr) { s->flushed_size = 0; continue; }
        s->flushed = grown;
        s->flushed_size = flush_size;
      }
      if (JxlDecoderSetImageOutBuffer(s->dec, &s->pixel_format, s->flushed, s->flushed_size) == JXL_DEC_SUCCESS) {
        if (JxlDecoderFlushImage(s->dec) == JXL_DEC_SUCCESS) {
          s->flushed_ready = true;
          // Restore main buffer for final image.
          JxlDecoderSetImageOutBuffer(s->dec, &s->pixel_format, s->pixels, s->pixels_size);
          return JXL_DEC_RESULT_PROGRESS;
        }
      }
      continue;
    }
    if (status == JXL_DEC_FULL_IMAGE) {
      s->final_ready = true;
      continue;
    }
  }
}

void jxl_wasm_dec_close_input(JxlWasmDecState* s) {
  if (s != nullptr && !s->input_closed) {
    JxlDecoderCloseInput(s->dec);
    s->input_closed = true;
  }
}

uint32_t jxl_wasm_dec_width(const JxlWasmDecState* s) {
  return (s != nullptr && s->info_known) ? s->info.xsize : 0;
}

uint32_t jxl_wasm_dec_height(const JxlWasmDecState* s) {
  return (s != nullptr && s->info_known) ? s->info.ysize : 0;
}

int jxl_wasm_dec_error(const JxlWasmDecState* s) {
  return s != nullptr ? s->error_code : -1;
}

// IMPROVEMENT-4: Ownership transfer — zero-copy take_flushed/take_final.
// After transfer, s->flushed/pixels are null; jxl_wasm_dec_free won't double-free.
JxlWasmBuffer* jxl_wasm_dec_take_flushed(JxlWasmDecState* s) {
  if (s == nullptr || !s->flushed_ready || !s->info_known || s->flushed == nullptr) return nullptr;
  s->flushed_ready = false;
  const uint32_t bits = (s->pixel_format.data_type == JXL_TYPE_UINT16) ? 16u : (s->pixel_format.data_type == JXL_TYPE_FLOAT) ? 32u : 8u;
  JxlWasmBuffer* buf = MakeBufferFromOwned(s->flushed, s->flushed_size, s->info.xsize, s->info.ysize, bits, 1);
  s->flushed = nullptr;
  s->flushed_size = 0;
  return buf;
}

JxlWasmBuffer* jxl_wasm_dec_take_final(JxlWasmDecState* s) {
  if (s == nullptr || !s->final_ready || s->pixels == nullptr || !s->info_known) return nullptr;
  s->final_ready = false;
  const uint32_t bits = (s->pixel_format.data_type == JXL_TYPE_UINT16) ? 16u : (s->pixel_format.data_type == JXL_TYPE_FLOAT) ? 32u : 8u;
  JxlWasmBuffer* buf = MakeBufferFromOwned(s->pixels, s->pixels_size, s->info.xsize, s->info.ysize, bits, 1);
  s->pixels = nullptr;
  s->pixels_size = 0;
  return buf;
}

void jxl_wasm_dec_free(JxlWasmDecState* s) {
  if (s == nullptr) return;
  if (s->dec != nullptr) JxlDecoderDestroy(s->dec);
  free(s->pixels);   // no-op if ownership was transferred via dec_take_final
  free(s->flushed);  // no-op if ownership was transferred via dec_take_flushed
  free(s);
}

JxlWasmBuffer* jxl_wasm_decode_rgba8(const uint8_t* input, size_t input_size, uint32_t downsample) {
  return DecodeRgba(input, input_size, downsample, 0);
}
JxlWasmBuffer* jxl_wasm_decode_rgba16(const uint8_t* input, size_t input_size, uint32_t downsample) {
  return DecodeRgba(input, input_size, downsample, 1);
}
JxlWasmBuffer* jxl_wasm_decode_rgbaf32(const uint8_t* input, size_t input_size, uint32_t downsample) {
  return DecodeRgba(input, input_size, downsample, 2);
}

JxlWasmBuffer* jxl_wasm_encode_rgba8(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t has_alpha) {
  return EncodeRgba(pixels, width, height, distance, effort, 0, has_alpha);
}
JxlWasmBuffer* jxl_wasm_encode_rgba16(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t has_alpha) {
  return EncodeRgba(pixels, width, height, distance, effort, 1, has_alpha);
}
JxlWasmBuffer* jxl_wasm_encode_rgbaf32(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t has_alpha) {
  return EncodeRgba(pixels, width, height, distance, effort, 2, has_alpha);
}

JxlWasmBuffer* jxl_wasm_encode_rgba8_with_metadata(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t has_alpha, const uint8_t* icc_profile, size_t icc_size, const uint8_t* exif, size_t exif_size, const uint8_t* xmp, size_t xmp_size) {
  return EncodeRgbaWithMetadata(pixels, width, height, distance, effort, 0, has_alpha, icc_profile, icc_size, exif, exif_size, xmp, xmp_size);
}

// Routes JPEG bytes to lossless transcode; otherwise encodes as RGBA pixels.
// For JPEG input, width/height/fmt/has_alpha are ignored.
JxlWasmBuffer* jxl_wasm_encode_auto(
    const uint8_t* data, size_t data_size,
    uint32_t width, uint32_t height,
    float distance, uint32_t effort,
    uint32_t fmt, uint32_t has_alpha) {
  if (data == nullptr || data_size == 0) return MakeError(50);
  if (LooksLikeJpeg(data, data_size)) {
    return jxl_wasm_transcode_jpeg_to_jxl(data, data_size);
  }
  return EncodeRgba(data, width, height, distance, effort, fmt, has_alpha);
}

// Encode full image + N sidecar thumbnails in one call.
// Returns a `->next` linked list: sidecars smallest-first, full image last.
// sidecar_max_dims must be sorted ascending by the caller (JS does this).
// Caller walks and frees each node individually via jxl_wasm_buffer_free.
//
// Cascade: each thumbnail is derived from the next-larger thumbnail rather than
// the full image, so total downscale work scales with the number of output pixels
// rather than (num_sidecars × full-image pixels).
JxlWasmBuffer* jxl_wasm_encode_rgba8_with_sidecars(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t has_alpha,
    const uint32_t* sidecar_max_dims, uint32_t num_sidecars) {
  if (pixels == nullptr || width == 0 || height == 0) return MakeError(20);

  // Pass 1: collect valid (tw, th) pairs in ascending order.
  struct SidecarDim { uint32_t tw, th; };
  const uint32_t MAX_SC = 16u;
  SidecarDim sc_dims[MAX_SC];
  uint32_t sc_count = 0;

  for (uint32_t i = 0; i < num_sidecars && sc_count < MAX_SC; ++i) {
    const uint32_t max_dim = (sidecar_max_dims != nullptr) ? sidecar_max_dims[i] : 0u;
    const uint32_t longer  = (width >= height) ? width : height;
    if (max_dim == 0 || max_dim >= longer) continue;
    uint32_t tw, th;
    if (width >= height) {
      tw = max_dim;
      th = std::max(1u, (max_dim * height + width / 2u) / width);
    } else {
      th = max_dim;
      tw = std::max(1u, (max_dim * width + height / 2u) / height);
    }
    sc_dims[sc_count++] = { tw, th };
  }

  // Pass 2: cascade descending (largest first), prepend to chain.
  // Descending iteration + prepend = ascending output chain (smallest first).
  // Each thumbnail downscaled from previous (larger) thumbnail, not from full image.
  // If a malloc fails the cascade falls back to the nearest available larger source.
  JxlWasmBuffer* sc_chain    = nullptr;
  const uint8_t* cascade_src = pixels;
  uint32_t       cascade_sw  = width;
  uint32_t       cascade_sh  = height;
  uint8_t*       cascade_owned = nullptr;  // non-null when cascade_src is malloc'd

  for (int32_t i = static_cast<int32_t>(sc_count) - 1; i >= 0; --i) {
    const uint32_t tw = sc_dims[i].tw;
    const uint32_t th = sc_dims[i].th;

    uint8_t* thumb = static_cast<uint8_t*>(malloc(static_cast<size_t>(tw) * th * 4u));
    if (thumb == nullptr) continue;  // skip level; cascade_src unchanged for smaller levels

    BoxDownscaleRgba8(cascade_src, cascade_sw, cascade_sh, thumb, tw, th);

    // Previous cascade source no longer needed — free it before taking the new one.
    free(cascade_owned);
    cascade_owned = thumb;
    cascade_src   = thumb;
    cascade_sw    = tw;
    cascade_sh    = th;

    // Thumbnails tolerate more loss; cap effort at 5 to keep encode fast.
    JxlWasmBuffer* sidecar = EncodeRgba(thumb, tw, th,
        std::max(distance, 1.5f), std::min(effort, 5u), 0, 1u);
    if (sidecar == nullptr) continue;

    // Prepend: descending iteration + prepend = ascending chain.
    sidecar->next = sc_chain;
    sc_chain = sidecar;
  }
  free(cascade_owned);

  JxlWasmBuffer* full = EncodeRgba(pixels, width, height, distance, effort, 0, has_alpha);
  if (full == nullptr) {
    JxlWasmBuffer* cur = sc_chain;
    while (cur != nullptr) { JxlWasmBuffer* nxt = cur->next; FreeBufferNoChain(cur); cur = nxt; }
    return MakeError(28);
  }
  if (sc_chain == nullptr) return full;

  // Walk sidecar chain to tail and append full image.
  JxlWasmBuffer* tail = sc_chain;
  while (tail->next != nullptr) tail = tail->next;
  tail->next = full;
  return sc_chain;
}

uint8_t* jxl_wasm_buffer_data(JxlWasmBuffer* buffer) {
  return buffer == nullptr ? nullptr : buffer->data;
}

size_t jxl_wasm_buffer_size(JxlWasmBuffer* buffer) {
  return buffer == nullptr ? 0 : buffer->size;
}

uint32_t jxl_wasm_buffer_width(JxlWasmBuffer* buffer) {
  return buffer == nullptr ? 0 : buffer->width;
}

uint32_t jxl_wasm_buffer_height(JxlWasmBuffer* buffer) {
  return buffer == nullptr ? 0 : buffer->height;
}

uint32_t jxl_wasm_buffer_bits_per_sample(JxlWasmBuffer* buffer) {
  return buffer == nullptr ? 0 : buffer->bits_per_sample;
}

uint32_t jxl_wasm_buffer_has_alpha(JxlWasmBuffer* buffer) {
  return buffer == nullptr ? 0 : buffer->has_alpha;
}

int jxl_wasm_buffer_error(JxlWasmBuffer* buffer) {
  return buffer == nullptr ? -1 : buffer->error;
}

// Returns the `next` sidecar pointer for chain traversal (0 = last node).
JxlWasmBuffer* jxl_wasm_buffer_next(JxlWasmBuffer* buffer) {
  return (buffer == nullptr) ? nullptr : buffer->next;
}

void jxl_wasm_buffer_free(JxlWasmBuffer* buffer) {
  if (buffer == nullptr) return;
  // Inline data (MakeBuffer): lives in the same allocation — free once.
  // External data (MakeBufferFromOwned / encoder no-copy): separate allocation — free both.
  // Does NOT recurse through ->next; caller walks and frees the sidecar chain individually.
  if (buffer->data != nullptr && buffer->data != reinterpret_cast<uint8_t*>(buffer + 1)) {
    free(buffer->data);
  }
  free(buffer);
}

// --- #10: Region decode exports ---

JxlWasmBuffer* jxl_wasm_decode_rgba8_region(const uint8_t* input, size_t input_size,
    uint32_t cx, uint32_t cy, uint32_t cw, uint32_t ch, uint32_t downsample) {
  return DecodeRgbaRegion(input, input_size, cx, cy, cw, ch, downsample, 0);
}
JxlWasmBuffer* jxl_wasm_decode_rgba16_region(const uint8_t* input, size_t input_size,
    uint32_t cx, uint32_t cy, uint32_t cw, uint32_t ch, uint32_t downsample) {
  return DecodeRgbaRegion(input, input_size, cx, cy, cw, ch, downsample, 1);
}
JxlWasmBuffer* jxl_wasm_decode_rgbaf32_region(const uint8_t* input, size_t input_size,
    uint32_t cx, uint32_t cy, uint32_t cw, uint32_t ch, uint32_t downsample) {
  return DecodeRgbaRegion(input, input_size, cx, cy, cw, ch, downsample, 2);
}

// --- #11: Streaming encoder ---

JxlWasmEncState* jxl_wasm_enc_create(void) {
  return static_cast<JxlWasmEncState*>(calloc(1, sizeof(JxlWasmEncState)));
}

int jxl_wasm_enc_push_pixels(JxlWasmEncState* s,
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha) {
  if (s == nullptr) return -1;
  if (s->error_code != 0) return s->error_code;
  JxlWasmBuffer* buf = EncodeRgba(pixels, width, height, distance, effort, fmt, has_alpha);
  if (buf == nullptr) { s->error_code = 25; return s->error_code; }
  if (buf->error != 0) { int ec = buf->error; FreeBufferNoChain(buf); s->error_code = ec; return ec; }
  // EncodeRgba always uses a separate outbuf (not inline) — steal the pointer.
  s->outbuf      = buf->data;
  s->outbuf_size = buf->size;
  buf->data = nullptr;  // prevent FreeBufferNoChain double-free
  FreeBufferNoChain(buf);
  return 0;
}

// Returns a JxlWasmBuffer* containing the next chunk of encoded output, or 0 when exhausted.
// 256 KB strikes a balance: 4× fewer FFI crossings than 64 KB without excessive peak JS heap.
JxlWasmBuffer* jxl_wasm_enc_take_chunk(JxlWasmEncState* s) {
  static const size_t CHUNK = 262144;
  if (s == nullptr || s->outbuf == nullptr || s->taken >= s->outbuf_size) return nullptr;
  const size_t remaining = s->outbuf_size - s->taken;
  const size_t take = (remaining < CHUNK) ? remaining : CHUNK;
  // MakeBuffer inlines data — no separate allocation to track; safe for buffer_free.
  JxlWasmBuffer* chunk = MakeBuffer(s->outbuf + s->taken, take, 0, 0, 8, 0);
  if (chunk != nullptr) s->taken += take;
  return chunk;
}

int jxl_wasm_enc_error(const JxlWasmEncState* s) {
  return s != nullptr ? s->error_code : -1;
}

// --- #16: Streaming input encoder ---

// Pre-allocate the full pixel buffer in WASM so JS never needs to accumulate pixels.
// Returns nullptr on invalid dimensions or malloc failure.
JxlWasmEncState* jxl_wasm_enc_create_image(
    uint32_t width, uint32_t height,
    float distance, uint32_t effort,
    uint32_t fmt, uint32_t has_alpha) {
  if (width == 0 || height == 0) return nullptr;
  const size_t bpc        = (fmt == 2u) ? 4u : (fmt == 1u) ? 2u : 1u;
  const size_t pixel_size = static_cast<size_t>(width) * height * 4u * bpc;

  JxlWasmEncState* s = static_cast<JxlWasmEncState*>(calloc(1, sizeof(JxlWasmEncState)));
  if (s == nullptr) return nullptr;
  s->pixels_buf = static_cast<uint8_t*>(malloc(pixel_size));
  if (s->pixels_buf == nullptr) { free(s); return nullptr; }

  s->pixels_size   = pixel_size;
  s->enc_width     = width;
  s->enc_height    = height;
  s->enc_distance  = distance;
  s->enc_effort    = effort;
  s->enc_fmt       = fmt;
  s->enc_has_alpha = has_alpha;
  return s;
}

// Copy `size` bytes from `data` into the pixel buffer at the current write offset.
// Returns 0 on success, non-zero on error (overflow or bad state).
int jxl_wasm_enc_push_chunk(JxlWasmEncState* s, const uint8_t* data, size_t size) {
  if (s == nullptr || data == nullptr) return -1;
  if (s->error_code != 0) return s->error_code;
  if (s->pixels_buf == nullptr) { s->error_code = -2; return -2; }
  if (size == 0) return 0;
  if (s->pixels_written + size > s->pixels_size) { s->error_code = -3; return -3; }
  memcpy(s->pixels_buf + s->pixels_written, data, size);
  s->pixels_written += size;
  return 0;
}

// Encode the accumulated pixel buffer. Frees pixels_buf on completion (success or error).
// Output becomes available via enc_take_chunk. Returns 0 on success, non-zero on error.
int jxl_wasm_enc_finish(JxlWasmEncState* s) {
  if (s == nullptr) return -1;
  if (s->error_code != 0) return s->error_code;
  if (s->pixels_buf == nullptr) { s->error_code = -2; return -2; }
  if (s->pixels_written != s->pixels_size) { s->error_code = -4; return -4; }

  JxlWasmBuffer* buf = EncodeRgba(
      s->pixels_buf, s->enc_width, s->enc_height,
      s->enc_distance, s->enc_effort, s->enc_fmt, s->enc_has_alpha);

  // libjxl is done with the pixel data — free it now to reclaim memory.
  free(s->pixels_buf);
  s->pixels_buf    = nullptr;
  s->pixels_size   = 0;
  s->pixels_written = 0;

  if (buf == nullptr) { s->error_code = 25; return 25; }
  if (buf->error != 0) { int ec = buf->error; FreeBufferNoChain(buf); s->error_code = ec; return ec; }

  // Steal the output buffer pointer from JxlWasmBuffer — avoids a memcpy.
  s->outbuf      = buf->data;
  s->outbuf_size = buf->size;
  buf->data = nullptr;
  FreeBufferNoChain(buf);
  return 0;
}

void jxl_wasm_enc_free(JxlWasmEncState* s) {
  if (s == nullptr) return;
  free(s->pixels_buf);  // no-op after enc_finish (set to nullptr); safety net on cancel
  free(s->outbuf);
  free(s);
}

// --- #15: Lossless JPEG → JXL transcode ---

JxlWasmBuffer* jxl_wasm_transcode_jpeg_to_jxl(const uint8_t* jpeg, size_t jpeg_size) {
  if (jpeg == nullptr || jpeg_size == 0) return MakeError(40);

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return MakeError(41);

  if (JxlEncoderStoreJPEGMetadata(enc, JXL_TRUE) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(42);
  }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  if (frame == nullptr) { JxlEncoderDestroy(enc); return MakeError(43); }

  if (JxlEncoderAddJPEGFrame(frame, jpeg, jpeg_size) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(44);
  }
  JxlEncoderCloseInput(enc);

  const size_t initial_cap = std::max(size_t(65536), jpeg_size / 2);
  uint8_t* outbuf = static_cast<uint8_t*>(malloc(initial_cap));
  if (outbuf == nullptr) { JxlEncoderDestroy(enc); return MakeError(45); }
  size_t outbuf_cap = initial_cap;
  uint8_t* next_out = outbuf;
  size_t avail_out = outbuf_cap;

  for (;;) {
    JxlEncoderStatus status = JxlEncoderProcessOutput(enc, &next_out, &avail_out);
    if (status == JXL_ENC_SUCCESS) {
      const size_t final_size = static_cast<size_t>(next_out - outbuf);
      JxlEncoderDestroy(enc);
      JxlWasmBuffer* result = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
      if (result == nullptr) { free(outbuf); return MakeError(46); }
      result->data = outbuf;
      result->size = final_size;
      return result;
    }
    if (status == JXL_ENC_NEED_MORE_OUTPUT) {
      const size_t offset = static_cast<size_t>(next_out - outbuf);
      outbuf_cap *= 2;
      uint8_t* grown = static_cast<uint8_t*>(realloc(outbuf, outbuf_cap));
      if (grown == nullptr) { free(outbuf); JxlEncoderDestroy(enc); return MakeError(47); }
      outbuf = grown;
      next_out = outbuf + offset;
      avail_out = outbuf_cap - offset;
      continue;
    }
    free(outbuf);
    JxlEncoderDestroy(enc);
    return MakeError(static_cast<int>(status));
  }
}

}
