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
  uint32_t enc_progressive_dc;
  uint32_t enc_progressive_ac;
  uint32_t enc_qprogressive_ac;
  uint32_t enc_buffering;

  // Escape hatch
  int32_t* enc_advanced_ids = nullptr;
  int32_t* enc_advanced_values = nullptr;
  size_t   enc_advanced_count = 0;
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

// Phase 2 extended descriptor: 72 bytes (4-byte aligned), exact match to TS DataView + serialize.
// Field math (no internal padding):
//   0-39: 10 × 4B (type u32, bits u32, distance f32, plane_ptr u32, plane_size u32,
//                  dim_shift u32, spot_r/g/b/solidity f32) = 40 bytes
//   40: name_len (u8) → offset 41
//   41-71: name[31] (UTF-8, truncated/padded) → total 72 bytes.
// sizeof(WasmExtraChannel) == 72 (C++). Used for encode input (plane_ptrs written by TS caller post-malloc)
// and (zeroed fields) for decode-side roundtrip verification via helper.
struct WasmExtraChannel {
  uint32_t type;               // JxlExtraChannelType numeric value (0=ALPHA,1=DEPTH,2=SPOT_COLOR,3=SELECTION_MASK,4=BLACK,5=CFA,6=THERMAL,7..14=RESERVED*,15=UNKNOWN,16=OPTIONAL)
  uint32_t bits;
  float    distance;
  uint32_t plane_ptr;          // u32 WASM memory offset (from _malloc); cast to uint8_t* for plane data (1 channel)
  uint32_t plane_size;
  uint32_t dim_shift;
  float    spot_r, spot_g, spot_b, spot_solidity;
  uint8_t  name_len;
  char     name[31];
};
// sizeof(WasmExtraChannel) == 72 (verified layout: 40 + 1 + 31). Matches EC_BYTES in facade.ts.

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

// Escape hatch helper for advancedFrameSettings (patches, future experimental settings, etc.)
static void ApplyAdvancedFrameSettings(JxlEncoderFrameSettings* frame,
                                       const int32_t* setting_ids,
                                       const int32_t* setting_values,
                                       size_t count) {
  if (frame == nullptr || setting_ids == nullptr || setting_values == nullptr || count == 0) return;
  for (size_t i = 0; i < count; ++i) {
    JxlEncoderFrameSettingsSetOption(
      frame,
      static_cast<JxlEncoderFrameSettingId>(setting_ids[i]),
      static_cast<int64_t>(setting_values[i])
    );
  }
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
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    const int32_t* advanced_ids = nullptr,
    const int32_t* advanced_values = nullptr,
    size_t advanced_count = 0) {
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
    // ICC profile already fully describes the colour space. Setting sRGB color
    // encoding afterwards is redundant and may produce undefined behaviour in
    // some libjxl versions when both are set. Skip when ICC is present.
  } else {
    JxlColorEncoding color;
    JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
    if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(23); }
  }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  JxlEncoderSetFrameDistance(frame, distance);
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PROGRESSIVE_DC, static_cast<int64_t>(progressive_dc));
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PROGRESSIVE_AC, static_cast<int64_t>(progressive_ac));
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_QPROGRESSIVE_AC, static_cast<int64_t>(qprogressive_ac));
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_BUFFERING, static_cast<int64_t>(buffering));

  ApplyAdvancedFrameSettings(frame, advanced_ids, advanced_values, advanced_count);

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

static JxlWasmBuffer* EncodeRgba(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering,
    const int32_t* advanced_ids = nullptr, const int32_t* advanced_values = nullptr, size_t advanced_count = 0) {
  return EncodeRgbaWithMetadata(pixels, width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, nullptr, 0, nullptr, 0, nullptr, 0,
                                advanced_ids, advanced_values, advanced_count);
}

// Core Task 3 encode with full extra channels (Phase 2 descriptor).
// main_pixels: RGBA (or RGB if !has_alpha) in the given fmt.
// ec_desc: pointer to array of num_ec WasmExtraChannel (72B each per struct); each .plane_ptr is valid WASM offset for that channel's 1-channel pixel buffer.
// All extra channel planes are provided separately (even alpha type if used as EC).
static JxlWasmBuffer* EncodeRgbaWithExtraChannels(
    const uint8_t* main_pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering,
    const uint8_t* ec_desc, uint32_t num_ec) {
  if (main_pixels == nullptr || width == 0 || height == 0) return MakeError(20);
  if (num_ec > 16) return MakeError(80); // guard

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
  info.num_extra_channels     = (has_alpha ? 1u : 0u) + num_ec;
  info.alpha_bits             = has_alpha ? bits : 0u;
  info.alpha_exponent_bits    = has_alpha ? exp_bits : 0u;

  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(22); }

  // sRGB default (no ICC support in this EC path for v1 of Task 3; extend later if needed)
  JxlColorEncoding color;
  JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
  if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(23); }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  JxlEncoderSetFrameDistance(frame, distance);
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PROGRESSIVE_DC, static_cast<int64_t>(progressive_dc));
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PROGRESSIVE_AC, static_cast<int64_t>(progressive_ac));
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_QPROGRESSIVE_AC, static_cast<int64_t>(qprogressive_ac));
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_BUFFERING, static_cast<int64_t>(buffering));

  // Per-EC setup: info + name + spot (via struct) + dim_shift + exponent + distance + buffer
  const size_t ec_stride = sizeof(WasmExtraChannel);
  for (uint32_t i = 0; i < num_ec; ++i) {
    const WasmExtraChannel* ec = reinterpret_cast<const WasmExtraChannel*>(ec_desc + i * ec_stride);

    JxlExtraChannelInfo ec_info;
    JxlEncoderInitExtraChannelInfo(static_cast<JxlExtraChannelType>(ec->type), &ec_info);
    ec_info.bits_per_sample = ec->bits;
    ec_info.exponent_bits_per_sample = (ec->bits > 16) ? 8u : 0u;  // conservative; matches FormatTo for float32 case
    ec_info.dim_shift = ec->dim_shift;

    if (ec->type == static_cast<uint32_t>(JXL_CHANNEL_SPOT_COLOR)) {
      ec_info.spot_color[0] = ec->spot_r;
      ec_info.spot_color[1] = ec->spot_g;
      ec_info.spot_color[2] = ec->spot_b;
      ec_info.spot_color[3] = ec->spot_solidity;
    }

    if (JxlEncoderSetExtraChannelInfo(enc, (has_alpha ? 1u : 0u) + i, &ec_info) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(81);
    }

    if (ec->name_len > 0) {
      JxlEncoderSetExtraChannelName(enc, (has_alpha ? 1u : 0u) + i, ec->name, ec->name_len);
    }

    // Per-channel distance (use provided or inherit via -1)
    float ch_dist = (ec->distance > 0.0f) ? ec->distance : -1.0f;
    JxlEncoderSetExtraChannelDistance(frame, (has_alpha ? 1u : 0u) + i, ch_dist);
  }

  // Main frame pixels (alpha bundled if has_alpha; extras are separate)
  const size_t bytes_per_channel = (fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u;
  const uint32_t num_channels = has_alpha ? 4u : 3u;
  JxlPixelFormat pf = {num_channels, FormatToDataType(fmt), JXL_NATIVE_ENDIAN, 0};
  size_t main_size = static_cast<size_t>(width) * height * num_channels * bytes_per_channel;

  if (JxlEncoderAddImageFrame(frame, &pf, main_pixels, main_size) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(24);
  }

  // Now supply the extra channel plane data (1 channel each)
  for (uint32_t i = 0; i < num_ec; ++i) {
    const WasmExtraChannel* ec = reinterpret_cast<const WasmExtraChannel*>(ec_desc + i * ec_stride);
    if (ec->plane_ptr == 0 || ec->plane_size == 0) continue;

    const uint8_t* plane = reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(ec->plane_ptr));
    JxlDataType dt = (ec->bits == 16) ? JXL_TYPE_UINT16 : (ec->bits == 32) ? JXL_TYPE_FLOAT : JXL_TYPE_UINT8;
    JxlPixelFormat pf_ec = {1, dt, JXL_NATIVE_ENDIAN, 0};

    if (JxlEncoderSetExtraChannelBuffer(frame, &pf_ec, plane, ec->plane_size, (has_alpha ? 1u : 0u) + i) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(82);
    }
  }

  JxlEncoderCloseInput(enc);

  // Output buffering (same sizing heuristic as EncodeRgbaWithMetadata)
  const size_t bpc_main = bytes_per_channel;
  const size_t initial_size = std::max(size_t(65536),
      distance == 0.0f ? (static_cast<size_t>(width) * height * 4u * bpc_main) / 2
                       : effort <= 3 ? (static_cast<size_t>(width) * height * 4u * bpc_main) / 12
                       : (static_cast<size_t>(width) * height * 4u * bpc_main) / 10);
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

// --- Tiled multi-frame encode (ROI support) ---
//
// Encodes a full RGBA8 image as a JXL container with one frame per tile,
// each frame carrying layer_info.have_crop = JXL_TRUE plus crop offsets.
// The resulting file can be decoded with JxlDecoderSetCoalescing(JXL_FALSE)
// + JxlDecoderSkipFrames to retrieve individual tiles without decoding the
// whole image — the core mechanism for true region-of-interest decode in
// libjxl 0.11.x (which has no JxlDecoderSetCropWindow).
static JxlWasmBuffer* EncodeRgba8Tiled(const uint8_t* pixels,
    uint32_t width, uint32_t height, uint32_t tile_size,
    float distance, uint32_t effort, uint32_t has_alpha) {
  if (pixels == nullptr || width == 0 || height == 0 || tile_size == 0) return MakeError(60);

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return MakeError(61);

  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize                    = width;
  info.ysize                    = height;
  info.bits_per_sample          = 8;
  info.exponent_bits_per_sample = 0;
  info.num_color_channels       = 3;
  info.num_extra_channels       = has_alpha ? 1u : 0u;
  info.alpha_bits               = has_alpha ? 8u : 0u;
  info.alpha_exponent_bits      = 0;
  info.have_animation           = JXL_FALSE;

  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(62); }

  JxlColorEncoding color;
  JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
  if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(63); }

  const uint32_t tiles_x         = (width  + tile_size - 1u) / tile_size;
  const uint32_t tiles_y         = (height + tile_size - 1u) / tile_size;
  const uint32_t bytes_per_pixel = has_alpha ? 4u : 3u;

  // Per-tile staging buffer (RGBA8 or RGB8 after stripping alpha).
  uint8_t* tile_buf = static_cast<uint8_t*>(malloc(static_cast<size_t>(tile_size) * tile_size * 4u));
  if (tile_buf == nullptr) { JxlEncoderDestroy(enc); return MakeError(64); }

  JxlPixelFormat pf = {has_alpha ? 4u : 3u, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};

  for (uint32_t ty = 0; ty < tiles_y; ++ty) {
    for (uint32_t tx = 0; tx < tiles_x; ++tx) {
      const uint32_t x0 = tx * tile_size;
      const uint32_t y0 = ty * tile_size;
      const uint32_t tw = std::min(tile_size, width  - x0);
      const uint32_t th = std::min(tile_size, height - y0);

      // Pull tile pixels out of full image, stripping alpha if needed.
      if (has_alpha) {
        for (uint32_t row = 0; row < th; ++row) {
          memcpy(tile_buf + row * tw * 4u,
                 pixels + (static_cast<size_t>(y0 + row) * width + x0) * 4u,
                 tw * 4u);
        }
      } else {
        for (uint32_t row = 0; row < th; ++row) {
          const uint8_t* src = pixels   + (static_cast<size_t>(y0 + row) * width + x0) * 4u;
          uint8_t*       dst = tile_buf + row * tw * 3u;
          for (uint32_t col = 0; col < tw; ++col) {
            dst[col * 3u + 0] = src[col * 4u + 0];
            dst[col * 3u + 1] = src[col * 4u + 1];
            dst[col * 3u + 2] = src[col * 4u + 2];
          }
        }
      }

      JxlFrameHeader fh;
      JxlEncoderInitFrameHeader(&fh);
      fh.duration                      = 0;
      fh.layer_info.have_crop          = JXL_TRUE;
      fh.layer_info.crop_x0            = static_cast<int32_t>(x0);
      fh.layer_info.crop_y0            = static_cast<int32_t>(y0);
      fh.layer_info.xsize              = tw;
      fh.layer_info.ysize              = th;
      fh.layer_info.blend_info.blendmode = JXL_BLEND_REPLACE;
      fh.layer_info.blend_info.source    = 0;
      fh.layer_info.blend_info.alpha     = 0;
      fh.layer_info.blend_info.clamp     = JXL_FALSE;
      fh.layer_info.save_as_reference    = 0;

      JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
      if (frame == nullptr) { free(tile_buf); JxlEncoderDestroy(enc); return MakeError(65); }
      JxlEncoderSetFrameDistance(frame, distance);
      JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));

      if (JxlEncoderSetFrameHeader(frame, &fh) != JXL_ENC_SUCCESS) {
        free(tile_buf); JxlEncoderDestroy(enc); return MakeError(66);
      }

      const size_t tile_pixel_size = static_cast<size_t>(tw) * th * bytes_per_pixel;
      if (JxlEncoderAddImageFrame(frame, &pf, tile_buf, tile_pixel_size) != JXL_ENC_SUCCESS) {
        free(tile_buf); JxlEncoderDestroy(enc); return MakeError(67);
      }
    }
  }
  free(tile_buf);

  JxlEncoderCloseInput(enc);

  // Output capacity heuristic: a quarter of raw RGBA size (lossy compresses well).
  size_t outbuf_cap = std::max(static_cast<size_t>(65536),
      static_cast<size_t>(width) * height);
  uint8_t* outbuf = static_cast<uint8_t*>(malloc(outbuf_cap));
  if (outbuf == nullptr) { JxlEncoderDestroy(enc); return MakeError(68); }
  uint8_t* next_out = outbuf;
  size_t   avail_out = outbuf_cap;
  for (;;) {
    JxlEncoderStatus status = JxlEncoderProcessOutput(enc, &next_out, &avail_out);
    if (status == JXL_ENC_SUCCESS) {
      const size_t final_size = static_cast<size_t>(next_out - outbuf);
      JxlEncoderDestroy(enc);
      return MakeBufferFromOwned(outbuf, final_size, width, height, 8, has_alpha);
    }
    if (status == JXL_ENC_NEED_MORE_OUTPUT) {
      const size_t offset = static_cast<size_t>(next_out - outbuf);
      outbuf_cap *= 2u;
      uint8_t* grown = static_cast<uint8_t*>(realloc(outbuf, outbuf_cap));
      if (grown == nullptr) { free(outbuf); JxlEncoderDestroy(enc); return MakeError(69); }
      outbuf    = grown;
      next_out  = outbuf + offset;
      avail_out = outbuf_cap - offset;
      continue;
    }
    free(outbuf);
    JxlEncoderDestroy(enc);
    return MakeError(static_cast<int>(status));
  }
}

// --- Tiled region decode (ROI support) ---
//
// Decodes only the tiles overlapping `[region_x, region_x+region_w) ×
// [region_y, region_y+region_h)` from a JXL produced by EncodeRgba8Tiled.
// Uses JxlDecoderSetCoalescing(JXL_FALSE) + JxlDecoderSkipFrames to skip
// past frames whose pixel data we don't need. Known limitation in libjxl ≤0.11.x:
// SkipFrames still walks frame headers and may decompress internally — see JXTC
// tile container below for a true ROI alternative.
static JxlWasmBuffer* DecodeRgba8RegionTiled(const uint8_t* input, size_t input_size,
    uint32_t tile_size, uint32_t region_x, uint32_t region_y,
    uint32_t region_w, uint32_t region_h) {
  if (input == nullptr || input_size == 0 || tile_size == 0) return MakeError(70);

  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) return MakeError(71);

  if (JxlDecoderSubscribeEvents(dec,
        JXL_DEC_BASIC_INFO | JXL_DEC_FRAME | JXL_DEC_FULL_IMAGE) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec); return MakeError(72);
  }
  // SetCoalescing check — result will be visible only if it fails (error 73)
  if (JxlDecoderSetCoalescing(dec, JXL_FALSE) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec); return MakeError(73);
  }
  JxlDecoderSetInput(dec, input, input_size);
  JxlDecoderCloseInput(dec);

  // Run decoder until basic info known.
  JxlBasicInfo info{};
  bool info_known = false;
  while (!info_known) {
    JxlDecoderStatus st = JxlDecoderProcessInput(dec);
    if (st == JXL_DEC_BASIC_INFO) {
      if (JxlDecoderGetBasicInfo(dec, &info) != JXL_DEC_SUCCESS) {
        JxlDecoderDestroy(dec); return MakeError(74);
      }
      info_known = true;
      break;
    }
    if (st == JXL_DEC_ERROR || st == JXL_DEC_NEED_MORE_INPUT || st == JXL_DEC_SUCCESS) {
      JxlDecoderDestroy(dec); return MakeError(75);
    }
  }

  // Clamp region to image bounds.
  const uint32_t rx = std::min(region_x, info.xsize);
  const uint32_t ry = std::min(region_y, info.ysize);
  const uint32_t rw = std::min(region_w, info.xsize - rx);
  const uint32_t rh = std::min(region_h, info.ysize - ry);
  if (rw == 0 || rh == 0) { JxlDecoderDestroy(dec); return MakeError(76); }

  const uint32_t tiles_x = (info.xsize + tile_size - 1u) / tile_size;
  const uint32_t tx_min  = rx / tile_size;
  const uint32_t tx_max  = (rx + rw - 1u) / tile_size;
  const uint32_t ty_min  = ry / tile_size;
  const uint32_t ty_max  = (ry + rh - 1u) / tile_size;

  const size_t out_size  = static_cast<size_t>(rw) * rh * 4u;
  uint8_t* out_pixels = static_cast<uint8_t*>(malloc(out_size));
  if (out_pixels == nullptr) { JxlDecoderDestroy(dec); return MakeError(77); }

  size_t tile_buf_cap = static_cast<size_t>(tile_size) * tile_size * 4u;
  uint8_t* tile_buf   = static_cast<uint8_t*>(malloc(tile_buf_cap));
  if (tile_buf == nullptr) { free(out_pixels); JxlDecoderDestroy(dec); return MakeError(78); }

  JxlPixelFormat pf = {4, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};

  // Walk overlapping tiles in row-major order; SkipFrames between non-adjacent ones.
  uint32_t cursor_idx = 0;
  for (uint32_t ty = ty_min; ty <= ty_max; ++ty) {
    for (uint32_t tx = tx_min; tx <= tx_max; ++tx) {
      const uint32_t target_idx = ty * tiles_x + tx;
      if (target_idx > cursor_idx) {
        JxlDecoderSkipFrames(dec, target_idx - cursor_idx);
      }

      uint32_t tile_x0 = 0, tile_y0 = 0, tile_w = 0, tile_h = 0;
      bool got_image = false;
      int process_input_calls = 0;
      while (!got_image) {
        process_input_calls++;
        JxlDecoderStatus st = JxlDecoderProcessInput(dec);
        if (st == JXL_DEC_FRAME) {
          JxlFrameHeader fh{};
          if (JxlDecoderGetFrameHeader(dec, &fh) == JXL_DEC_SUCCESS) {
            tile_x0 = static_cast<uint32_t>(fh.layer_info.crop_x0);
            tile_y0 = static_cast<uint32_t>(fh.layer_info.crop_y0);
            tile_w  = fh.layer_info.xsize;
            tile_h  = fh.layer_info.ysize;
          }
          continue;
        }
        if (st == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
          size_t buf_size = 0;
          if (JxlDecoderImageOutBufferSize(dec, &pf, &buf_size) != JXL_DEC_SUCCESS) {
            free(tile_buf); free(out_pixels); JxlDecoderDestroy(dec); return MakeError(79);
          }
          if (buf_size > tile_buf_cap) {
            uint8_t* grown = static_cast<uint8_t*>(realloc(tile_buf, buf_size));
            if (grown == nullptr) {
              free(tile_buf); free(out_pixels); JxlDecoderDestroy(dec); return MakeError(80);
            }
            tile_buf     = grown;
            tile_buf_cap = buf_size;
          }
          if (JxlDecoderSetImageOutBuffer(dec, &pf, tile_buf, tile_buf_cap) != JXL_DEC_SUCCESS) {
            free(tile_buf); free(out_pixels); JxlDecoderDestroy(dec); return MakeError(81);
          }
          continue;
        }
        if (st == JXL_DEC_FULL_IMAGE) { got_image = true; break; }
        if (st == JXL_DEC_ERROR || st == JXL_DEC_NEED_MORE_INPUT || st == JXL_DEC_SUCCESS) {
          free(tile_buf); free(out_pixels); JxlDecoderDestroy(dec); return MakeError(82);
        }
      }
      cursor_idx = target_idx + 1;

      // Composite tile pixels into the output region. Overlap is in image coords.
      const uint32_t ox0 = std::max(tile_x0, rx);
      const uint32_t oy0 = std::max(tile_y0, ry);
      const uint32_t ox1 = std::min(tile_x0 + tile_w, rx + rw);
      const uint32_t oy1 = std::min(tile_y0 + tile_h, ry + rh);
      if (ox1 <= ox0 || oy1 <= oy0) continue;
      const uint32_t ow = ox1 - ox0;
      const uint32_t oh = oy1 - oy0;

      for (uint32_t row = 0; row < oh; ++row) {
        const uint8_t* src = tile_buf   + ((oy0 - tile_y0 + row) * tile_w + (ox0 - tile_x0)) * 4u;
        uint8_t*       dst = out_pixels + ((oy0 - ry      + row) * rw     + (ox0 - rx))      * 4u;
        memcpy(dst, src, ow * 4u);
      }
    }
  }

  free(tile_buf);
  JxlDecoderDestroy(dec);
  return MakeBufferFromOwned(out_pixels, out_size, rw, rh, 8, 1);
}

// --- Tile container (JXTC) format ---
//
// Stores N independent standalone JXL bitstreams + a byte-offset index.
// Decode seeks directly to needed tiles — zero frame-walk overhead.
// Works on any libjxl version.
//
// Layout:
//   [Header 32B] magic 'JXTC' | version=1 | image_w | image_h |
//                tile_size | tiles_x | tiles_y | flags
//                bit0=has_alpha, bit1=rgba16 payload
//   [Index 8B × N] per tile: offset (4B), length (4B)
//   [N standalone JXL bitstreams]
#define JXTC_MAGIC          0x4354584Au  // 'JXTC' little-endian
#define JXTC_VERSION        1u
#define JXTC_HEADER_BYTES   32u
#define JXTC_INDEX_BYTES    8u

// Encode a single RGBA tile as a standalone JXL bitstream.
// Strips alpha channel inline if !has_alpha. Returns malloc'd buffer; caller frees.
// On failure returns nullptr and leaves *out_size unchanged.
static uint8_t* EncodeStandaloneJxlTile(const uint8_t* rgba_pixels,
    uint32_t width, uint32_t height, float distance, uint32_t effort,
    uint32_t has_alpha, uint32_t fmt, size_t* out_size) {
  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return nullptr;

  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize                    = width;
  info.ysize                    = height;
  info.bits_per_sample          = FormatToBits(fmt);
  info.exponent_bits_per_sample = FormatToExponentBits(fmt);
  info.num_color_channels       = 3;
  info.num_extra_channels       = has_alpha ? 1u : 0u;
  info.alpha_bits               = has_alpha ? FormatToBits(fmt) : 0u;
  info.alpha_exponent_bits      = has_alpha ? FormatToExponentBits(fmt) : 0u;
  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return nullptr; }

  JxlColorEncoding color;
  JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
  if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return nullptr; }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  JxlEncoderSetFrameDistance(frame, distance);
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));

  JxlPixelFormat pf = {has_alpha ? 4u : 3u, FormatToDataType(fmt), JXL_NATIVE_ENDIAN, 0};
  uint8_t* stripped = nullptr;
  const uint8_t* src = rgba_pixels;
  size_t pixel_size;
  const size_t bytes_per_channel = (fmt == 2u) ? 4u : (fmt == 1u) ? 2u : 1u;
  if (has_alpha) {
    pixel_size = static_cast<size_t>(width) * height * 4u * bytes_per_channel;
  } else {
    const size_t n = static_cast<size_t>(width) * height;
    pixel_size = n * 3u * bytes_per_channel;
    stripped = static_cast<uint8_t*>(malloc(pixel_size));
    if (stripped == nullptr) { JxlEncoderDestroy(enc); return nullptr; }
    for (size_t i = 0; i < n; ++i) {
      memcpy(stripped + i * 3u * bytes_per_channel, rgba_pixels + i * 4u * bytes_per_channel, 3u * bytes_per_channel);
    }
    src = stripped;
  }

  const JxlEncoderStatus add_status = JxlEncoderAddImageFrame(frame, &pf, src, pixel_size);
  free(stripped);
  if (add_status != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return nullptr; }

  JxlEncoderCloseInput(enc);

  size_t cap = std::max(static_cast<size_t>(4096), pixel_size / 4u);
  uint8_t* outbuf = static_cast<uint8_t*>(malloc(cap));
  if (outbuf == nullptr) { JxlEncoderDestroy(enc); return nullptr; }
  uint8_t* next_out  = outbuf;
  size_t   avail_out = cap;
  for (;;) {
    JxlEncoderStatus s = JxlEncoderProcessOutput(enc, &next_out, &avail_out);
    if (s == JXL_ENC_SUCCESS) {
      *out_size = static_cast<size_t>(next_out - outbuf);
      JxlEncoderDestroy(enc);
      return outbuf;
    }
    if (s == JXL_ENC_NEED_MORE_OUTPUT) {
      const size_t off = static_cast<size_t>(next_out - outbuf);
      cap *= 2u;
      uint8_t* grown = static_cast<uint8_t*>(realloc(outbuf, cap));
      if (grown == nullptr) { free(outbuf); JxlEncoderDestroy(enc); return nullptr; }
      outbuf    = grown;
      next_out  = outbuf + off;
      avail_out = cap - off;
      continue;
    }
    free(outbuf);
    JxlEncoderDestroy(enc);
    return nullptr;
  }
}

// Decode a standalone JXL bitstream to RGBA. Returns malloc'd pixel buffer; caller frees.
// Writes decoded dimensions to *out_w, *out_h. On failure returns nullptr.
static uint8_t* DecodeStandaloneJxlTile(const uint8_t* input, size_t input_size,
    uint32_t fmt, uint32_t* out_w, uint32_t* out_h) {
  *out_w = 0; *out_h = 0;
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) return nullptr;

  if (JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec); return nullptr;
  }
  JxlDecoderSetInput(dec, input, input_size);
  JxlDecoderCloseInput(dec);

  JxlBasicInfo info{};
  uint8_t* pixels = nullptr;
  size_t   pixels_size = 0;
  JxlPixelFormat pf = {4, FormatToDataType(fmt), JXL_NATIVE_ENDIAN, 0};

  for (;;) {
    JxlDecoderStatus st = JxlDecoderProcessInput(dec);
    if (st == JXL_DEC_SUCCESS) break;
    if (st == JXL_DEC_ERROR || st == JXL_DEC_NEED_MORE_INPUT) {
      free(pixels); JxlDecoderDestroy(dec); return nullptr;
    }
    if (st == JXL_DEC_BASIC_INFO) {
      if (JxlDecoderGetBasicInfo(dec, &info) != JXL_DEC_SUCCESS) { JxlDecoderDestroy(dec); return nullptr; }
      continue;
    }
    if (st == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t buf_size = 0;
      if (JxlDecoderImageOutBufferSize(dec, &pf, &buf_size) != JXL_DEC_SUCCESS) {
        free(pixels); JxlDecoderDestroy(dec); return nullptr;
      }
      if (buf_size > pixels_size) {
        free(pixels);
        pixels = static_cast<uint8_t*>(malloc(buf_size));
        if (pixels == nullptr) { JxlDecoderDestroy(dec); return nullptr; }
        pixels_size = buf_size;
      }
      if (JxlDecoderSetImageOutBuffer(dec, &pf, pixels, pixels_size) != JXL_DEC_SUCCESS) {
        free(pixels); JxlDecoderDestroy(dec); return nullptr;
      }
      continue;
    }
  }

  JxlDecoderDestroy(dec);
  *out_w = info.xsize;
  *out_h = info.ysize;
  return pixels;
}

// Encode RGBA image into JXTC tile container.
static JxlWasmBuffer* EncodeTileContainer(const uint8_t* pixels,
    uint32_t width, uint32_t height, uint32_t tile_size,
    float distance, uint32_t effort, uint32_t has_alpha, uint32_t fmt) {
  if (pixels == nullptr || width == 0 || height == 0 || tile_size == 0) return MakeError(90);

  const uint32_t tiles_x    = (width  + tile_size - 1u) / tile_size;
  const uint32_t tiles_y    = (height + tile_size - 1u) / tile_size;
  const uint32_t tile_count = tiles_x * tiles_y;
  if (tile_count == 0) return MakeError(91);

  uint8_t** tile_bytes   = static_cast<uint8_t**>(calloc(tile_count, sizeof(uint8_t*)));
  size_t*   tile_lengths = static_cast<size_t*>(  calloc(tile_count, sizeof(size_t)));
  if (tile_bytes == nullptr || tile_lengths == nullptr) {
    free(tile_bytes); free(tile_lengths); return MakeError(92);
  }

  const size_t bytes_per_channel = (fmt == 2u) ? 4u : (fmt == 1u) ? 2u : 1u;
  const size_t bytes_per_pixel = 4u * bytes_per_channel;
  const size_t tile_stage_bytes = static_cast<size_t>(tile_size) * tile_size * bytes_per_pixel;
  uint8_t* tile_stage = static_cast<uint8_t*>(malloc(tile_stage_bytes));
  if (tile_stage == nullptr) {
    free(tile_bytes); free(tile_lengths); return MakeError(93);
  }

  size_t total_tile_bytes = 0;
  for (uint32_t ty = 0; ty < tiles_y; ++ty) {
    for (uint32_t tx = 0; tx < tiles_x; ++tx) {
      const uint32_t x0 = tx * tile_size;
      const uint32_t y0 = ty * tile_size;
      const uint32_t tw = std::min(tile_size, width  - x0);
      const uint32_t th = std::min(tile_size, height - y0);

      for (uint32_t row = 0; row < th; ++row) {
        memcpy(tile_stage + static_cast<size_t>(row) * tw * bytes_per_pixel,
               pixels + (static_cast<size_t>(y0 + row) * width + x0) * bytes_per_pixel,
               static_cast<size_t>(tw) * bytes_per_pixel);
      }

      size_t out_size = 0;
      uint8_t* enc_bytes = EncodeStandaloneJxlTile(tile_stage, tw, th, distance, effort, has_alpha, fmt, &out_size);
      if (enc_bytes == nullptr) {
        for (uint32_t i = 0; i < tile_count; ++i) free(tile_bytes[i]);
        free(tile_bytes); free(tile_lengths); free(tile_stage);
        return MakeError(94);
      }
      const uint32_t idx = ty * tiles_x + tx;
      tile_bytes[idx]   = enc_bytes;
      tile_lengths[idx] = out_size;
      total_tile_bytes += out_size;
    }
  }
  free(tile_stage);

  const size_t header_bytes = JXTC_HEADER_BYTES;
  const size_t index_bytes  = static_cast<size_t>(tile_count) * JXTC_INDEX_BYTES;
  const size_t total_size   = header_bytes + index_bytes + total_tile_bytes;
  uint8_t* output = static_cast<uint8_t*>(malloc(total_size));
  if (output == nullptr) {
    for (uint32_t i = 0; i < tile_count; ++i) free(tile_bytes[i]);
    free(tile_bytes); free(tile_lengths);
    return MakeError(95);
  }

  uint32_t* h32 = reinterpret_cast<uint32_t*>(output);
  h32[0] = JXTC_MAGIC;
  h32[1] = JXTC_VERSION;
  h32[2] = width;
  h32[3] = height;
  h32[4] = tile_size;
  h32[5] = tiles_x;
  h32[6] = tiles_y;
  h32[7] = (has_alpha ? 1u : 0u) | ((fmt == 1u) ? 2u : 0u);

  uint32_t cursor = static_cast<uint32_t>(header_bytes + index_bytes);
  uint32_t* index = reinterpret_cast<uint32_t*>(output + header_bytes);
  for (uint32_t i = 0; i < tile_count; ++i) {
    index[i * 2 + 0] = cursor;
    index[i * 2 + 1] = static_cast<uint32_t>(tile_lengths[i]);
    memcpy(output + cursor, tile_bytes[i], tile_lengths[i]);
    cursor += static_cast<uint32_t>(tile_lengths[i]);
    free(tile_bytes[i]);
  }
  free(tile_bytes);
  free(tile_lengths);

  return MakeBufferFromOwned(output, total_size, width, height, FormatToBits(fmt), has_alpha);
}

// Decode region from a JXTC tile container. Only tiles overlapping the region
// are decoded. Each tile is a standalone JXL — zero frame-walk overhead.
static JxlWasmBuffer* DecodeTileContainerRegion(const uint8_t* input, size_t input_size,
    uint32_t region_x, uint32_t region_y, uint32_t region_w, uint32_t region_h, uint32_t fmt) {
  if (input == nullptr || input_size < JXTC_HEADER_BYTES) return MakeError(100);

  const uint32_t* h32 = reinterpret_cast<const uint32_t*>(input);
  if (h32[0] != JXTC_MAGIC)   return MakeError(101);
  if (h32[1] != JXTC_VERSION) return MakeError(102);
  const uint32_t image_w   = h32[2];
  const uint32_t image_h   = h32[3];
  const uint32_t tile_size = h32[4];
  const uint32_t tiles_x   = h32[5];
  const uint32_t tiles_y   = h32[6];
  const uint32_t flags     = h32[7];
  if (image_w == 0 || image_h == 0 || tile_size == 0 || tiles_x == 0 || tiles_y == 0) return MakeError(103);
  const bool header_has_alpha = (flags & 1u) != 0;
  const bool header_is_rgba16 = (flags & 2u) != 0;
  const bool expected_is_rgba16 = (fmt == 1u);
  if (header_is_rgba16 != expected_is_rgba16) return MakeError(110);

  const uint32_t tile_count = tiles_x * tiles_y;
  const size_t header_bytes = JXTC_HEADER_BYTES;
  const size_t index_bytes  = static_cast<size_t>(tile_count) * JXTC_INDEX_BYTES;
  if (input_size < header_bytes + index_bytes) return MakeError(104);
  const uint32_t* index = reinterpret_cast<const uint32_t*>(input + header_bytes);

  const uint32_t rx = std::min(region_x, image_w);
  const uint32_t ry = std::min(region_y, image_h);
  const uint32_t rw = std::min(region_w, image_w - rx);
  const uint32_t rh = std::min(region_h, image_h - ry);
  if (rw == 0 || rh == 0) return MakeError(105);

  const uint32_t tx_min = rx / tile_size;
  const uint32_t tx_max = (rx + rw - 1u) / tile_size;
  const uint32_t ty_min = ry / tile_size;
  const uint32_t ty_max = (ry + rh - 1u) / tile_size;

  const size_t bytes_per_channel = (fmt == 2u) ? 4u : (fmt == 1u) ? 2u : 1u;
  const size_t bytes_per_pixel = 4u * bytes_per_channel;
  const size_t out_size = static_cast<size_t>(rw) * rh * bytes_per_pixel;
  uint8_t* out_pixels = static_cast<uint8_t*>(malloc(out_size));
  if (out_pixels == nullptr) return MakeError(106);

  for (uint32_t ty = ty_min; ty <= ty_max; ++ty) {
    for (uint32_t tx = tx_min; tx <= tx_max; ++tx) {
      const uint32_t idx = ty * tiles_x + tx;
      if (idx >= tile_count) { free(out_pixels); return MakeError(107); }
      const uint32_t offset = index[idx * 2 + 0];
      const uint32_t length = index[idx * 2 + 1];
      if (offset < header_bytes + index_bytes || static_cast<size_t>(offset) + length > input_size) {
        free(out_pixels); return MakeError(108);
      }

      uint32_t tile_w = 0, tile_h = 0;
      uint8_t* tile_pixels = DecodeStandaloneJxlTile(input + offset, length, fmt, &tile_w, &tile_h);
      if (tile_pixels == nullptr) { free(out_pixels); return MakeError(109); }

      const uint32_t tile_x0 = tx * tile_size;
      const uint32_t tile_y0 = ty * tile_size;
      const uint32_t ox0 = std::max(tile_x0, rx);
      const uint32_t oy0 = std::max(tile_y0, ry);
      const uint32_t ox1 = std::min(tile_x0 + tile_w, rx + rw);
      const uint32_t oy1 = std::min(tile_y0 + tile_h, ry + rh);

      if (ox1 > ox0 && oy1 > oy0) {
        const uint32_t ow = ox1 - ox0;
        const uint32_t oh = oy1 - oy0;
        for (uint32_t row = 0; row < oh; ++row) {
          const uint8_t* src = tile_pixels + ((static_cast<size_t>(oy0 - tile_y0 + row) * tile_w + (ox0 - tile_x0)) * bytes_per_pixel);
          uint8_t*       dst = out_pixels  + ((static_cast<size_t>(oy0 - ry) + row) * rw + (ox0 - rx)) * bytes_per_pixel;
          memcpy(dst, src, static_cast<size_t>(ow) * bytes_per_pixel);
        }
      }
      free(tile_pixels);
    }
  }

  return MakeBufferFromOwned(out_pixels, out_size, rw, rh, FormatToBits(fmt), header_has_alpha ? 1u : 0u);
}

extern "C" {

void jxl_wasm_bridge_anchor(void) {}

// Forward declaration for transcode used in encode_auto.
JxlWasmBuffer* jxl_wasm_transcode_jpeg_to_jxl(const uint8_t* jpeg, size_t jpeg_size);

// --- Stateful progressive decoder ---

JxlWasmDecState* jxl_wasm_dec_create(uint32_t format, uint32_t progressive_detail) {
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) return nullptr;

  int events = JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE;
  if (progressive_detail != 0) events |= JXL_DEC_FRAME_PROGRESSION;
  if (JxlDecoderSubscribeEvents(dec, events) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec); return nullptr;
  }
  if (progressive_detail != 0) {
    JxlProgressiveDetail detail = kDC;
    switch (progressive_detail) {
      case 1: detail = kDC; break;
      case 2: detail = kLastPasses; break;
      case 3: detail = kPasses; break;
      case 4: detail = kDCProgressive; break;
      default:
        JxlDecoderDestroy(dec); return nullptr;
    }
    if (JxlDecoderSetProgressiveDetail(dec, detail) != JXL_DEC_SUCCESS) {
      JxlDecoderDestroy(dec); return nullptr;
    }
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

    if (status == JXL_DEC_NEED_MORE_INPUT) {
      if (s->input_closed) {
        s->error_code = static_cast<int>(status);
        return JXL_DEC_RESULT_ERROR;
      }
      return JXL_DEC_RESULT_NEED_MORE;
    }
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

JxlWasmBuffer* jxl_wasm_encode_rgba8(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering) {
  return EncodeRgba(pixels, width, height, distance, effort, 0, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering);
}
JxlWasmBuffer* jxl_wasm_encode_rgba16(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering) {
  return EncodeRgba(pixels, width, height, distance, effort, 1, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering);
}
JxlWasmBuffer* jxl_wasm_encode_rgbaf32(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering) {
  return EncodeRgba(pixels, width, height, distance, effort, 2, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering);
}

// fmt: 0=rgba8, 1=rgba16, 2=rgbaf32.  Matches the TypeScript facade type.
// Previously this function had no fmt param and hardcoded 0, which also
// shifted every subsequent argument by one slot in the WASM call frame.
JxlWasmBuffer* jxl_wasm_encode_rgba8_with_metadata(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering,
    const uint8_t* icc_profile, size_t icc_size, const uint8_t* exif, size_t exif_size, const uint8_t* xmp, size_t xmp_size) {
  return EncodeRgbaWithMetadata(pixels, width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, icc_profile, icc_size, exif, exif_size, xmp, xmp_size);
}

// Advanced escape hatch variant
JxlWasmBuffer* jxl_wasm_encode_rgba8_with_metadata_adv(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering,
    const uint8_t* icc_profile, size_t icc_size, const uint8_t* exif, size_t exif_size, const uint8_t* xmp, size_t xmp_size,
    const int32_t* advanced_ids, const int32_t* advanced_values, size_t advanced_count) {
  return EncodeRgbaWithMetadata(pixels, width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, icc_profile, icc_size, exif, exif_size, xmp, xmp_size,
                                advanced_ids, advanced_values, advanced_count);
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
  return EncodeRgba(data, width, height, distance, effort, fmt, has_alpha, 0, 0, 0, 0);
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
        std::max(distance, 1.5f), std::min(effort, 5u), 0, 1u, 0, 0, 0, 0);
    if (sidecar == nullptr) continue;

    // Prepend: descending iteration + prepend = ascending chain.
    sidecar->next = sc_chain;
    sc_chain = sidecar;
  }
  free(cascade_owned);

  JxlWasmBuffer* full = EncodeRgba(pixels, width, height, distance, effort, 0, has_alpha, 0, 0, 0, 0);
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
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering) {
  if (s == nullptr) return -1;
  if (s->error_code != 0) return s->error_code;
  JxlWasmBuffer* buf = EncodeRgba(pixels, width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering);
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
    uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering,
    const int32_t* advanced_ids, const int32_t* advanced_values, size_t advanced_count) {
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
  s->enc_progressive_dc = progressive_dc;
  s->enc_progressive_ac = progressive_ac;
  s->enc_qprogressive_ac = qprogressive_ac;
  s->enc_buffering = buffering;

  if (advanced_count > 0 && advanced_ids && advanced_values) {
    s->enc_advanced_count = advanced_count;
    s->enc_advanced_ids   = (int32_t*)malloc(advanced_count * sizeof(int32_t));
    s->enc_advanced_values = (int32_t*)malloc(advanced_count * sizeof(int32_t));
    if (s->enc_advanced_ids && s->enc_advanced_values) {
      memcpy(s->enc_advanced_ids, advanced_ids, advanced_count * sizeof(int32_t));
      memcpy(s->enc_advanced_values, advanced_values, advanced_count * sizeof(int32_t));
    } else {
      free(s->enc_advanced_ids);
      free(s->enc_advanced_values);
      s->enc_advanced_count = 0;
    }
  }
  return s;
}

// Advanced escape hatch variant of the streaming input creator
JxlWasmEncState* jxl_wasm_enc_create_image_adv(
    uint32_t width, uint32_t height,
    float distance, uint32_t effort,
    uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering,
    const int32_t* advanced_ids, const int32_t* advanced_values, size_t advanced_count) {
  return jxl_wasm_enc_create_image(width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering,
                                   advanced_ids, advanced_values, advanced_count);
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

// Direct-write fast path: JS writes straight into the pre-allocated pixel buffer.
// Returns null on overflow or bad state; caller must follow with enc_advance_written.
uint8_t* jxl_wasm_enc_pixels_ptr(JxlWasmEncState* s, size_t size) {
  if (s == nullptr || s->error_code != 0 || s->pixels_buf == nullptr) return nullptr;
  if (s->pixels_written + size > s->pixels_size) return nullptr;
  return s->pixels_buf + s->pixels_written;
}

int jxl_wasm_enc_advance_written(JxlWasmEncState* s, size_t size) {
  if (s == nullptr) return -1;
  if (s->error_code != 0) return s->error_code;
  if (s->pixels_buf == nullptr) { s->error_code = -2; return -2; }
  if (s->pixels_written + size > s->pixels_size) { s->error_code = -3; return -3; }
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
      s->enc_distance, s->enc_effort, s->enc_fmt, s->enc_has_alpha,
      s->enc_progressive_dc, s->enc_progressive_ac, s->enc_qprogressive_ac, s->enc_buffering,
      s->enc_advanced_ids, s->enc_advanced_values, s->enc_advanced_count);

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
  free(s->pixels_buf);
  free(s->outbuf);
  free(s->enc_advanced_ids);
  free(s->enc_advanced_values);
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

// --- Tiled ROI exports ---

// Encode RGBA8 as a tiled multi-frame JXL. Each frame is one tile of
// tile_size × tile_size pixels (edges clipped) carrying layer_info.have_crop.
// Decode using jxl_wasm_decode_region_tiled_rgba8 below — the same tile_size
// must be passed back on decode.
JxlWasmBuffer* jxl_wasm_encode_tiled_rgba8(const uint8_t* pixels,
    uint32_t width, uint32_t height, uint32_t tile_size,
    float distance, uint32_t effort, uint32_t has_alpha) {
  return EncodeRgba8Tiled(pixels, width, height, tile_size, distance, effort, has_alpha);
}

// Decode only the tiles overlapping `[region_x, region_x+region_w) ×
// [region_y, region_y+region_h)`. Composites them into a tightly-packed
// RGBA8 buffer with width=clamped_w, height=clamped_h.
JxlWasmBuffer* jxl_wasm_decode_region_tiled_rgba8(const uint8_t* input, size_t input_size,
    uint32_t tile_size, uint32_t region_x, uint32_t region_y,
    uint32_t region_w, uint32_t region_h) {
  return DecodeRgba8RegionTiled(input, input_size, tile_size, region_x, region_y, region_w, region_h);
}

// --- JXTC tile container exports ---
//
// True ROI decode via per-tile independent JXL bitstreams + byte-offset index.
// Bypasses libjxl frame-walk overhead — each tile is a fresh decoder.
// Encode: jxl_wasm_encode_tile_container_rgba8 / rgba16
// Decode: jxl_wasm_decode_tile_container_region_rgba8 / rgba16
JxlWasmBuffer* jxl_wasm_encode_tile_container_rgba8(const uint8_t* pixels,
    uint32_t width, uint32_t height, uint32_t tile_size,
    float distance, uint32_t effort, uint32_t has_alpha) {
  return EncodeTileContainer(pixels, width, height, tile_size, distance, effort, has_alpha, 0u);
}

JxlWasmBuffer* jxl_wasm_decode_tile_container_region_rgba8(const uint8_t* input, size_t input_size,
    uint32_t region_x, uint32_t region_y, uint32_t region_w, uint32_t region_h) {
  return DecodeTileContainerRegion(input, input_size, region_x, region_y, region_w, region_h, 0u);
}

JxlWasmBuffer* jxl_wasm_encode_tile_container_rgba16(const uint8_t* pixels,
    uint32_t width, uint32_t height, uint32_t tile_size,
    float distance, uint32_t effort, uint32_t has_alpha) {
  return EncodeTileContainer(pixels, width, height, tile_size, distance, effort, has_alpha, 1u);
}

JxlWasmBuffer* jxl_wasm_decode_tile_container_region_rgba16(const uint8_t* input, size_t input_size,
    uint32_t region_x, uint32_t region_y, uint32_t region_w, uint32_t region_h) {
  return DecodeTileContainerRegion(input, input_size, region_x, region_y, region_w, region_h, 1u);
}

// --- Task 3: Extra channel encode FFI (rgba8 main + arbitrary ECs via packed 72B descriptors) ---
JxlWasmBuffer* jxl_wasm_encode_rgba8_with_extra_channels(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t has_alpha,
    const uint8_t* ec_desc_ptr, uint32_t num_ec) {
  // progressive* and buffering default to 0 (non-progressive, default buffering) for this entrypoint
  return EncodeRgbaWithExtraChannels(pixels, width, height, distance, effort, 0 /*fmt8*/, has_alpha,
                                     0, 0, 0, 0, ec_desc_ptr, num_ec);
}

// Decode-side helper for roundtrip test verification only (no public ImageInfo change).
// Decodes only header, extracts all extra channel descriptors (names via GetExtraChannelName),
// packs into a JxlWasmBuffer using the *exact same 72B WasmExtraChannel layout* as encode input
// (distance/plane_ptr/plane_size zeroed; dim/spot/name populated). This ensures consistent
// DataView offsets in TS test (type@0, bits@4, dim@20, spot@24, name_len@40, name@41).
// Caller (test) walks via buffer_data/size. Returns error buffer on failure.
JxlWasmBuffer* jxl_wasm_get_extra_channels(const uint8_t* input, size_t input_size) {
  if (input == nullptr || input_size == 0) return MakeError(90);

  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) return MakeError(91);
  if (JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec); return MakeError(92);
  }
  JxlDecoderSetInput(dec, input, input_size);
  JxlDecoderCloseInput(dec);

  JxlBasicInfo binfo{};
  bool have_info = false;
  JxlDecoderStatus st;
  while ((st = JxlDecoderProcessInput(dec)) != JXL_DEC_SUCCESS) {
    if (st == JXL_DEC_ERROR || st == JXL_DEC_NEED_MORE_INPUT) { JxlDecoderDestroy(dec); return MakeError(93); }
    if (st == JXL_DEC_BASIC_INFO) {
      if (JxlDecoderGetBasicInfo(dec, &binfo) != JXL_DEC_SUCCESS) { JxlDecoderDestroy(dec); return MakeError(94); }
      have_info = true;
      break;
    }
  }
  if (!have_info) { JxlDecoderDestroy(dec); return MakeError(95); }

  const uint32_t n = binfo.num_extra_channels;
  const size_t out_stride = 72; // exact match to sizeof(WasmExtraChannel) / EC_BYTES for consistent offsets in tests
  const size_t out_size = n * out_stride;
  uint8_t* out = static_cast<uint8_t*>(malloc(out_size ? out_size : 1));
  if (out == nullptr && n > 0) { JxlDecoderDestroy(dec); return MakeError(96); }
  memset(out, 0, out_size ? out_size : 1);

  for (uint32_t i = 0; i < n; ++i) {
    JxlExtraChannelInfo ei;
    if (JxlDecoderGetExtraChannelInfo(dec, i, &ei) != JXL_DEC_SUCCESS) {
      free(out); JxlDecoderDestroy(dec); return MakeError(97);
    }
    uint8_t* slot = out + i * out_stride;
    // Pack using *exact* 72B struct offsets (zero distance/planes; dim/spot/name filled).
    // Matches C++ WasmExtraChannel + TS serializeExtraChannelsForWasm + DataView in facade.test.ts
    *reinterpret_cast<uint32_t*>(slot + 0) = static_cast<uint32_t>(ei.type);
    *reinterpret_cast<uint32_t*>(slot + 4) = ei.bits_per_sample;
    // distance@8, plane_ptr@12, plane_size@16 left 0 (memset)
    *reinterpret_cast<uint32_t*>(slot + 20) = ei.dim_shift;
    if (ei.type == JXL_CHANNEL_SPOT_COLOR) {
      memcpy(slot + 24, ei.spot_color, 16);  // spot_r/g/b/solidity at 24-39
    }
    uint32_t name_len = ei.name_length;
    if (name_len > 31) name_len = 31;
    *reinterpret_cast<uint8_t*>(slot + 40) = static_cast<uint8_t>(name_len);
    if (name_len > 0) {
      char nm[32] = {0};
      if (JxlDecoderGetExtraChannelName(dec, i, nm, 32) == JXL_DEC_SUCCESS) {
        memcpy(slot + 41, nm, name_len);
      }
    }
  }
  JxlDecoderDestroy(dec);

  JxlWasmBuffer* buf = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
  if (buf == nullptr) { free(out); return MakeError(98); }
  buf->data = out;
  buf->size = out_size;
  buf->width = 0; buf->height = 0; buf->bits_per_sample = 0; buf->has_alpha = 0; buf->error = 0;
  return buf;
}

}
