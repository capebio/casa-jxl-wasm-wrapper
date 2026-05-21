#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <vector>

#include <jxl/color_encoding.h>
#include <jxl/decode.h>
#include <jxl/encode.h>
#include <jxl/types.h>

struct JxlWasmBuffer {
  uint8_t* data;
  size_t size;
  uint32_t width;
  uint32_t height;
  uint32_t bits_per_sample;
  uint32_t has_alpha;
  int error;
};

// Stateful progressive decoder state
struct JxlWasmDecState {
  JxlDecoder* dec;
  JxlBasicInfo info;
  bool info_known;
  JxlPixelFormat pixel_format;
  std::vector<uint8_t> pixels;   // working pixel buffer
  std::vector<uint8_t> flushed;  // most recent flushed progressive frame copy
  bool flushed_ready;
  bool final_ready;
  bool input_closed;
  int error_code;
};

// Return codes from jxl_wasm_dec_process
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
  JxlWasmBuffer* out = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
  if (out == nullptr) return nullptr;
  out->data = static_cast<uint8_t*>(malloc(size));
  if (out->data == nullptr) {
    free(out);
    return nullptr;
  }
  memcpy(out->data, data, size);
  out->size = size;
  out->width = width;
  out->height = height;
  out->bits_per_sample = bits;
  out->has_alpha = alpha;
  return out;
}

// format: 0=rgba8, 1=rgba16, 2=rgbaf32
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

static JxlWasmBuffer* DecodeRgba(const uint8_t* input, size_t input_size, uint32_t downsample, uint32_t fmt) {
  if (input == nullptr || input_size == 0) return MakeError(1);

  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) return MakeError(2);

  if (JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec); return MakeError(3);
  }

  JxlDecoderSetInput(dec, input, input_size);
  JxlDecoderCloseInput(dec);

  JxlBasicInfo info;
  memset(&info, 0, sizeof(info));
  std::vector<uint8_t> pixels;
  JxlPixelFormat pf = {4, FormatToDataType(fmt), JXL_NATIVE_ENDIAN, 0};

  for (;;) {
    JxlDecoderStatus status = JxlDecoderProcessInput(dec);
    if (status == JXL_DEC_ERROR)           { JxlDecoderDestroy(dec); return MakeError(status); }
    if (status == JXL_DEC_SUCCESS)         { break; }
    if (status == JXL_DEC_NEED_MORE_INPUT) { JxlDecoderDestroy(dec); return MakeError(status); }
    if (status == JXL_DEC_BASIC_INFO) {
      if (JxlDecoderGetBasicInfo(dec, &info) != JXL_DEC_SUCCESS) { JxlDecoderDestroy(dec); return MakeError(10); }
      continue;
    }
    if (status == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t buf_size = 0;
      if (JxlDecoderImageOutBufferSize(dec, &pf, &buf_size) != JXL_DEC_SUCCESS) { JxlDecoderDestroy(dec); return MakeError(11); }
      pixels.resize(buf_size);
      if (JxlDecoderSetImageOutBuffer(dec, &pf, pixels.data(), pixels.size()) != JXL_DEC_SUCCESS) { JxlDecoderDestroy(dec); return MakeError(12); }
      continue;
    }
    if (status == JXL_DEC_FULL_IMAGE) { continue; }
  }

  JxlDecoderDestroy(dec);
  if (pixels.empty() || info.xsize == 0 || info.ysize == 0) return MakeError(13);
  (void)downsample; // downsample applied JS-side after decode
  return MakeBuffer(pixels.data(), pixels.size(), info.xsize, info.ysize, FormatToBits(fmt), 1);
}

static JxlWasmBuffer* EncodeRgba(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t fmt) {
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
  info.num_extra_channels     = 1;
  info.alpha_bits             = bits;
  info.alpha_exponent_bits    = exp_bits;

  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(22); }

  JxlColorEncoding color;
  JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
  if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(23); }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  JxlEncoderSetFrameDistance(frame, distance);
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));

  size_t bytes_per_channel = (fmt == 2) ? 4 : (fmt == 1) ? 2 : 1;
  JxlPixelFormat pf = {4, FormatToDataType(fmt), JXL_NATIVE_ENDIAN, 0};
  const size_t pixel_size = static_cast<size_t>(width) * static_cast<size_t>(height) * 4 * bytes_per_channel;
  if (JxlEncoderAddImageFrame(frame, &pf, pixels, pixel_size) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(24); }
  JxlEncoderCloseInput(enc);

  std::vector<uint8_t> compressed(65536);
  uint8_t* next_out = compressed.data();
  size_t avail_out = compressed.size();
  for (;;) {
    JxlEncoderStatus status = JxlEncoderProcessOutput(enc, &next_out, &avail_out);
    if (status == JXL_ENC_SUCCESS) {
      compressed.resize(static_cast<size_t>(next_out - compressed.data()));
      break;
    }
    if (status == JXL_ENC_NEED_MORE_OUTPUT) {
      const size_t offset = static_cast<size_t>(next_out - compressed.data());
      compressed.resize(compressed.size() * 2);
      next_out = compressed.data() + offset;
      avail_out = compressed.size() - offset;
      continue;
    }
    JxlEncoderDestroy(enc); return MakeError(status);
  }

  JxlEncoderDestroy(enc);
  return MakeBuffer(compressed.data(), compressed.size(), width, height, bits, 1);
}

static JxlWasmBuffer* MakeProgressiveBuffer(const std::vector<uint8_t>& pixels, uint32_t width, uint32_t height, uint32_t bits) {
  return MakeBuffer(pixels.data(), pixels.size(), width, height, bits, 1);
}

extern "C" {

void jxl_wasm_bridge_anchor(void) {}

// --- Stateful progressive decoder ---

// format: 0=rgba8, 1=rgba16, 2=rgbaf32
JxlWasmDecState* jxl_wasm_dec_create(uint32_t format) {
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) return nullptr;

  int events = JXL_DEC_BASIC_INFO | JXL_DEC_FRAME_PROGRESSION | JXL_DEC_FULL_IMAGE;
  if (JxlDecoderSubscribeEvents(dec, events) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec); return nullptr;
  }
  if (JxlDecoderSetProgressiveDetail(dec, kDC) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec); return nullptr;
  }

  JxlWasmDecState* s = static_cast<JxlWasmDecState*>(calloc(1, sizeof(JxlWasmDecState)));
  if (s == nullptr) { JxlDecoderDestroy(dec); return nullptr; }
  s->dec = dec;
  s->pixel_format = { 4, FormatToDataType(format), JXL_NATIVE_ENDIAN, 0 };
  return s;
}

// Push bytes into the decoder and process pending events.
// Returns JXL_DEC_RESULT_* constant.
int jxl_wasm_dec_push(JxlWasmDecState* s, const uint8_t* data, size_t size) {
  if (s == nullptr || s->error_code != 0) return JXL_DEC_RESULT_ERROR;
  if (data != nullptr && size > 0)
    JxlDecoderSetInput(s->dec, data, size);

  for (;;) {
    JxlDecoderStatus status = JxlDecoderProcessInput(s->dec);
    if (status == JXL_DEC_NEED_MORE_INPUT) return JXL_DEC_RESULT_NEED_MORE;
    if (status == JXL_DEC_SUCCESS) { s->final_ready = true; return JXL_DEC_RESULT_DONE; }
    if (status == JXL_DEC_ERROR) { s->error_code = static_cast<int>(status); return JXL_DEC_RESULT_ERROR; }

    if (status == JXL_DEC_BASIC_INFO) {
      if (JxlDecoderGetBasicInfo(s->dec, &s->info) == JXL_DEC_SUCCESS)
        s->info_known = true;
      continue;
    }
    if (status == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t buf_size = 0;
      if (JxlDecoderImageOutBufferSize(s->dec, &s->pixel_format, &buf_size) != JXL_DEC_SUCCESS) {
        s->error_code = 11; return JXL_DEC_RESULT_ERROR;
      }
      s->pixels.resize(buf_size);
      if (JxlDecoderSetImageOutBuffer(s->dec, &s->pixel_format, s->pixels.data(), s->pixels.size()) != JXL_DEC_SUCCESS) {
        s->error_code = 12; return JXL_DEC_RESULT_ERROR;
      }
      continue;
    }
    if (status == JXL_DEC_FRAME_PROGRESSION) {
      if (!s->pixels.empty() && s->info_known) {
        size_t flush_size = 0;
        if (JxlDecoderImageOutBufferSize(s->dec, &s->pixel_format, &flush_size) == JXL_DEC_SUCCESS) {
          std::vector<uint8_t> flush_buf(flush_size);
          if (JxlDecoderSetImageOutBuffer(s->dec, &s->pixel_format, flush_buf.data(), flush_buf.size()) == JXL_DEC_SUCCESS) {
            if (JxlDecoderFlushImage(s->dec) == JXL_DEC_SUCCESS) {
              s->flushed = std::move(flush_buf);
              s->flushed_ready = true;
              // Re-point output buffer back to working pixels for final image
              JxlDecoderSetImageOutBuffer(s->dec, &s->pixel_format, s->pixels.data(), s->pixels.size());
              return JXL_DEC_RESULT_PROGRESS;
            }
          }
        }
      }
      continue;
    }
    if (status == JXL_DEC_FULL_IMAGE) { continue; }
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

// Returns a buffer with flushed progressive pixels (caller must free), or null.
JxlWasmBuffer* jxl_wasm_dec_take_flushed(JxlWasmDecState* s) {
  if (s == nullptr || !s->flushed_ready || !s->info_known) return nullptr;
  s->flushed_ready = false;
  const uint32_t bits = (s->pixel_format.data_type == JXL_TYPE_UINT16) ? 16u : (s->pixel_format.data_type == JXL_TYPE_FLOAT) ? 32u : 8u;
  return MakeProgressiveBuffer(s->flushed, s->info.xsize, s->info.ysize, bits);
}

// Returns a buffer with final pixels (caller must free), or null.
JxlWasmBuffer* jxl_wasm_dec_take_final(JxlWasmDecState* s) {
  if (s == nullptr || !s->final_ready || s->pixels.empty() || !s->info_known) return nullptr;
  s->final_ready = false;
  const uint32_t bits = (s->pixel_format.data_type == JXL_TYPE_UINT16) ? 16u : (s->pixel_format.data_type == JXL_TYPE_FLOAT) ? 32u : 8u;
  return MakeProgressiveBuffer(s->pixels, s->info.xsize, s->info.ysize, bits);
}

void jxl_wasm_dec_free(JxlWasmDecState* s) {
  if (s == nullptr) return;
  if (s->dec != nullptr) JxlDecoderDestroy(s->dec);
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

JxlWasmBuffer* jxl_wasm_encode_rgba8(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort) {
  return EncodeRgba(pixels, width, height, distance, effort, 0);
}
JxlWasmBuffer* jxl_wasm_encode_rgba16(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort) {
  return EncodeRgba(pixels, width, height, distance, effort, 1);
}
JxlWasmBuffer* jxl_wasm_encode_rgbaf32(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort) {
  return EncodeRgba(pixels, width, height, distance, effort, 2);
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

void jxl_wasm_buffer_free(JxlWasmBuffer* buffer) {
  if (buffer == nullptr) return;
  free(buffer->data);
  free(buffer);
}

}
