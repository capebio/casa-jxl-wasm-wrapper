#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <algorithm>
#include <vector>

#include <jxl/color_encoding.h>
#include <jxl/decode.h>
#include <jxl/encode.h>
#include <jxl/thread_parallel_runner.h>
#include <jxl/types.h>
#include "lib/jxl/butteraugli/butteraugli.h"
#include "lib/jxl/image.h"
#include "lib/jxl/memory_manager_internal.h"
#if __has_include(<jxl/gain_map.h>)
#include <jxl/gain_map.h>
#define JXL_GAIN_MAP_SUPPORTED 1
#else
#define JXL_GAIN_MAP_SUPPORTED 0
#endif
// JxlBool was added to jxl/types.h after the WASM build commit — provide fallback.
#ifndef JxlBool
typedef int JxlBool;
#endif

// IMPROVEMENT-1: `next` pointer enables sidecar linked-list without extra allocation.
struct JxlWasmBuffer {
  uint8_t* data;
  uint32_t size;         // explicit uint32 (A6): byte count independent of size_t/MEMORY64.
                         // High word not required for realistic image buffers.
  uint32_t width;
  uint32_t height;
  uint32_t bits_per_sample;
  uint32_t has_alpha;
  int error;
  JxlWasmBuffer* next;  // sidecar chain (null = last); caller walks and frees individually
  uint32_t owned_data;   // 1 = free external data on buffer_free; 0 = inline or borrowed
};
// WASM32 layout: data* + size (u32) + 5x u32 + int + next* + u32. First 7 u32-equivalent
// fields are 4-byte aligned for HEAPU32 direct reads in facade. Pointer width still
// follows target (guard below + TS load assert protect against WASM64 drift).

// A6: compile-time guard. size_t (used for other internal sizes) must be 32-bit or the
// overall FFI assumptions (and any remaining size_t in other structs) drift on MEMORY64.
static_assert(sizeof(size_t) == 4, "JxlWasmBuffer / bridge FFI requires 32-bit size_t; do not build with -sMEMORY64=1");

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
  uint32_t enc_group_order;  // 0=scanline, 1=center-out (predator groupOrder for early recognizable passes)
  int32_t  enc_modular;
  int32_t  enc_brotli_effort;
  int32_t  enc_decoding_speed;
  int32_t  enc_photon_noise_iso;
  uint32_t enc_resampling;
  int32_t  enc_ec_resampling;
  int32_t  enc_epf;            // -1=auto, 0=off, 1-3=strength
  int32_t  enc_gaborish;       // -1=auto, 0=off, 1=on
  int32_t  enc_dots;           // -1=auto, 0=off, 1=on (VarDCT only)
  int32_t  enc_color_transform;// -1=auto, 0=XYB, 1=none, 2=YCbCr
  // CasaSneyers_Parity: intrinsic_size (Ch3) — display dims differ from encoded dims (Retina @2×)
  uint32_t enc_intrinsic_width;  // 0 = not set
  uint32_t enc_intrinsic_height; // 0 = not set
  // CasaSneyers_Parity: disable perceptual heuristics (ID 39) — for fair codec benchmarking
  int32_t  enc_disable_perceptual; // -1=auto, 1=disable butteraugli/XYB psychovisual
  // -1=libjxl automatic, 5/10=forced codestream level.
  int32_t  enc_codestream_level;
  // -1=default, 0=straight/unassociated alpha, 1=premultiplied/associated alpha.
  int32_t  enc_premultiply_alpha;
  // B3: optional metadata stored for enc_finish to pass to EncodeRgbaWithMetadata
  uint8_t* enc_icc;
  size_t   enc_icc_size;
  uint8_t* enc_exif;
  size_t   enc_exif_size;
  uint8_t* enc_xmp;
  size_t   enc_xmp_size;
  // EXIF orientation tag (1..8). 1 = identity, 3 = 180°, 6 = 90° CW, 8 = 90° CCW.
  // Stored in JXL basic info so pixels stay sensor-native — no CPU rotation.
  uint32_t enc_orientation;
};

// IMPROVEMENT-3: raw malloc for progressive decoder avoids std::vector<uint8_t> zero-init.
struct JxlWasmDecState {
  JxlDecoder* dec;
  JxlBasicInfo info;
  bool info_known;
  JxlPixelFormat pixel_format;
  uint8_t* pixels;       // working pixel buffer (raw malloc; null until first NEED_IMAGE_OUT_BUFFER)
  size_t   pixels_size;
  size_t   flushed_size; // bytes for last successful progressive snapshot (borrowed view of pixels)
  bool flushed_ready;
  uint32_t flush_count;     // number of successful TryFlushProgressiveImage calls
  bool suppress_duplicate_progress;
  bool last_progress_hash_valid;
  uint64_t last_progress_hash;
  size_t last_progress_size;
  bool final_ready;
  bool input_closed;
  bool input_set;
  uint8_t* input_buf;    // owned decoder input: unprocessed tail + newly appended bytes
  size_t   input_size;
  size_t   input_capacity;
  size_t   input_generation;
  size_t   opportunistic_flush_generation;
  // Gate for opportunistic flush. libjxl JxlDecoderFlushImage requires JXL_DEC_FRAME to have
  // fired and JXL_DEC_FULL_IMAGE to not yet have fired (per decode.h). Without this gate,
  // pre-frame flush returns useless state.
  bool frame_started;
  int error_code;
  // Gain map (jhgm box accumulation + parsed JXL codestream)
  uint8_t* gm_buf;           // raw jhgm box bytes being accumulated
  size_t   gm_capacity;
  size_t   gm_size;          // bytes written so far
  bool     gm_reading;       // currently accumulating a jhgm box
  uint8_t* gain_map_jxl;     // extracted gain map JXL codestream
  size_t   gain_map_jxl_size;
  bool     gain_map_ready;
  // Per-frame animation metadata (populated on JXL_DEC_FRAME event)
  uint32_t frame_index;          // zero-based frame counter
  uint32_t frame_duration;       // duration in ticks
  char     frame_name[256];      // null-terminated UTF-8 frame name (empty string if absent)
  uint32_t is_last_frame;        // 1 if this is the last animation frame
  // Animation header info (populated after JXL_DEC_BASIC_INFO when have_animation)
  double   anim_ticks_per_second;
  uint32_t anim_loop_count;
};

#define JXL_DEC_RESULT_NEED_MORE  0
#define JXL_DEC_RESULT_PROGRESS   1
#define JXL_DEC_RESULT_DONE       2
#define JXL_DEC_RESULT_FRAME_DONE 3
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
  out->owned_data = 0;
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
  out->owned_data = 1;
  return out;
}

// Borrowed buffer — metadata handle only. Caller must synchronously copy the bytes
// before the producer mutates/frees `data`; buffer_free must not free `data`.
static JxlWasmBuffer* MakeBufferBorrowed(uint8_t* data, size_t size, uint32_t width, uint32_t height, uint32_t bits, uint32_t alpha) {
  JxlWasmBuffer* out = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
  if (out == nullptr) return nullptr;
  out->data = data;
  out->size = size;
  out->width = width;
  out->height = height;
  out->bits_per_sample = bits;
  out->has_alpha = alpha;
  out->owned_data = 0;
  return out;
}

static void FreeBufferNoChain(JxlWasmBuffer* buf) {
  if (buf == nullptr) return;
  if (buf->owned_data && buf->data != nullptr && buf->data != reinterpret_cast<uint8_t*>(buf + 1)) {
    free(buf->data);
  }
  free(buf);
}

// A1: Parallel runner — wires libjxl to the Emscripten pthread pool.
// Only active on threaded builds (-pthread / __EMSCRIPTEN_PTHREADS__).
// Cached as a module-level singleton: creating a runner is expensive (~50 ms).
#ifdef __EMSCRIPTEN_PTHREADS__
static void* g_parallel_runner = nullptr;
static void* GetSharedRunner() {
  if (g_parallel_runner == nullptr) {
    // Pre-warmed Emscripten pool is sized to navigator.hardwareConcurrency
    // (-sPTHREAD_POOL_SIZE in build.mjs); request the matching default worker
    // count so libjxl uses those warm threads instead of running serially.
    // Creating threads beyond the pool would deadlock: the worker thread is
    // blocked synchronously in decode and cannot service new pthread spawns.
    size_t workers = JxlThreadParallelRunnerDefaultNumWorkerThreads();
    g_parallel_runner = JxlThreadParallelRunnerCreate(nullptr, workers);
  }
  return g_parallel_runner;
}
// Inline helpers so the call-site error path can return any type.
static bool ApplyRunnerEnc(JxlEncoder* enc) {
  return JxlEncoderSetParallelRunner(enc, JxlThreadParallelRunner,
                                     GetSharedRunner()) == JXL_ENC_SUCCESS;
}
static bool ApplyRunnerDec(JxlDecoder* dec) {
  return JxlDecoderSetParallelRunner(dec, JxlThreadParallelRunner,
                                     GetSharedRunner()) == JXL_DEC_SUCCESS;
}
#define JXL_SETUP_ENC_RUNNER(enc, err_ret)                       \
  do { if (!ApplyRunnerEnc(enc)) {                               \
    JxlEncoderDestroy(enc); return err_ret; } } while (0)
#define JXL_SETUP_DEC_RUNNER(dec, err_ret)                       \
  do { if (!ApplyRunnerDec(dec)) {                               \
    JxlDecoderDestroy(dec); return err_ret; } } while (0)
#else
#define JXL_SETUP_ENC_RUNNER(enc, err_ret) ((void)0)
#define JXL_SETUP_DEC_RUNNER(dec, err_ret) ((void)0)
#endif

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

static uint32_t NormalizeResampling(uint32_t value) {
  return (value == 2u || value == 4u || value == 8u) ? value : 1u;
}

static int32_t NormalizeOptionalResampling(int32_t value) {
  return (value == 1 || value == 2 || value == 4 || value == 8) ? value : -1;
}

static void ApplyResamplingFrameSettings(JxlEncoderFrameSettings* frame, uint32_t resampling, int32_t ec_resampling) {
  const uint32_t normalized_resampling = NormalizeResampling(resampling);
  if (normalized_resampling > 1u) {
    JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_RESAMPLING, static_cast<int64_t>(normalized_resampling));
  }
  const int32_t normalized_ec_resampling = NormalizeOptionalResampling(ec_resampling);
  if (normalized_ec_resampling >= 1) {
    JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EXTRA_CHANNEL_RESAMPLING, static_cast<int64_t>(normalized_ec_resampling));
  }
}

static JxlDataType BitsToDataType(uint32_t bits) {
  if (bits == 16u) return JXL_TYPE_UINT16;
  if (bits == 32u) return JXL_TYPE_FLOAT;
  return JXL_TYPE_UINT8;
}

// Packed extra-channel descriptor written by the TypeScript facade.
// 20 bytes per entry, all fields 4-byte aligned. DataView layout must match exactly.
struct WasmExtraChannel {
  uint32_t type;       // JxlExtraChannelType value
  uint32_t bits;       // bits_per_sample (8, 16, or 32)
  float    distance;   // per-channel encode distance; < 0.0 = inherit main distance
  uint32_t plane_ptr;  // WASM heap address of single-channel pixel data (0 = not provided)
  uint32_t plane_size; // byte length of plane_ptr buffer
};

// Box-level options: container format control + Brotli metadata compression.
// 20 bytes. All fields uint32, 4-byte aligned. Layout must match TypeScript DataView writes.
struct WasmBoxOpts {
  uint32_t compress_boxes;    // offset  0: Brotli-compress metadata boxes via JxlEncoderAddBox
  uint32_t force_container;   // offset  4: JxlEncoderUseContainer(enc, JXL_TRUE)
  uint32_t raw_codestream;    // offset  8: JxlEncoderUseContainer(enc, JXL_FALSE)
  uint32_t custom_boxes_ptr;  // offset 12: WASM heap ptr to WasmCustomBox[] (0 = none)
  uint32_t num_custom_boxes;  // offset 16
};

// Per-custom-box descriptor — 16 bytes. Layout must match TypeScript DataView writes.
struct WasmCustomBox {
  char     box_type[4]; // offset  0: 4-char JXL box-type identifier
  uint32_t data_ptr;    // offset  4: WASM heap ptr to box data
  uint32_t data_size;   // offset  8: byte length
  uint32_t compress;    // offset 12: 0 or 1
};

// Animation frame descriptor — 32 bytes, 4-byte aligned.
// Layout matches TypeScript DataView writes in marshalAnimationFrames().
// CasaSneyers_Parity (Ch3/Ch9.3.2): blend_mode added at offset 28 for per-frame composition.
struct WasmAnimationFrame {
  uint32_t pixels_ptr;  // offset  0: WASM heap ptr to RGBA pixel data
  uint32_t pixels_size; // offset  4: byte length
  uint32_t width;       // offset  8
  uint32_t height;      // offset 12
  uint32_t duration;    // offset 16: in ticks
  uint32_t name_ptr;    // offset 20: WASM heap ptr to UTF-8 name (0 = none)
  uint32_t name_size;   // offset 24: byte length of name
  uint32_t blend_mode;  // offset 28: JxlBlendMode (0=replace, 1=add, 2=blend, 3=muladd, 4=mul)
};

// Animation header options — 8 bytes.
struct WasmAnimationOpts {
  uint32_t ticks_per_second; // offset 0: default 1000 (ms units)
  uint32_t loop_count;       // offset 4: 0 = infinite
};

// Apply container mode (raw/forced) from WasmBoxOpts. Call right after JxlEncoderCreate.
static JxlEncoderStatus ApplyContainerMode(JxlEncoder* enc, const WasmBoxOpts* opts) {
  if (opts == nullptr) return JXL_ENC_SUCCESS;
  if (opts->raw_codestream) {
    JxlEncoderUseContainer(enc, JXL_FALSE);
  } else if (opts->force_container) {
    JxlEncoderUseContainer(enc, JXL_TRUE);
  }
  return JXL_ENC_SUCCESS;
}

// Add caller-supplied custom boxes to the encoder. Call after all standard boxes.
static JxlEncoderStatus AddCustomBoxes(JxlEncoder* enc, const WasmBoxOpts* opts) {
  if (opts == nullptr || opts->custom_boxes_ptr == 0 || opts->num_custom_boxes == 0)
    return JXL_ENC_SUCCESS;
  const WasmCustomBox* boxes = reinterpret_cast<const WasmCustomBox*>(
      static_cast<uintptr_t>(opts->custom_boxes_ptr));
  for (uint32_t i = 0; i < opts->num_custom_boxes; ++i) {
    const WasmCustomBox& b = boxes[i];
    if (b.data_ptr == 0 || b.data_size == 0) continue;
    const uint8_t* data = reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(b.data_ptr));
    if (JxlEncoderAddBox(enc, b.box_type, data, b.data_size,
                         b.compress ? JXL_TRUE : JXL_FALSE) != JXL_ENC_SUCCESS) {
      return JXL_ENC_ERROR;
    }
  }
  return JXL_ENC_SUCCESS;
}

// Estimate initial output buffer cap (extracted from the triplicated heuristic in
// EncodeRgbaWithMetadata / WithGainMap / WithExtraChannels).
static size_t EstimateOutputCap(uint32_t w, uint32_t h, uint32_t fmt, float distance, uint32_t effort) {
  const size_t raw = static_cast<size_t>(w) * h * 4u *
      ((fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u);
  if (distance == 0.0f) return std::max(size_t(65536), raw / 2);
  if (effort <= 3)      return std::max(size_t(65536), raw / 12);
  return std::max(size_t(65536), raw / 10);
}

// PumpEncoderOutput: consolidates the 7 duplicated JxlEncoderProcessOutput loops
// (EncodeRgbaWithMetadata, WithGainMap, WithExtra, EncodeRgba8Tiled, EncodeStandaloneJxlTileRgba8,
// EncodeAnimation, and the two JPEG transcodes).
// initial_cap: starting malloc size (use EstimateOutputCap or specific).
// max_cap: 0 = uncapped (double until OOM); >0 caps growth (EncodeAnimation uses 128 MiB).
// On success: returns caller-owned malloc buffer, writes *out_size, destroys enc.
// On failure: frees buffer+enc, writes err code to *err, returns nullptr.
static uint8_t* PumpEncoderOutput(JxlEncoder* enc, size_t initial_cap, size_t max_cap,
                                  size_t* out_size, int* err) {
  if (enc == nullptr) { *err = 21; return nullptr; }
  if (initial_cap < 65536u) initial_cap = 65536u;
  uint8_t* outbuf = static_cast<uint8_t*>(malloc(initial_cap));
  if (outbuf == nullptr) { JxlEncoderDestroy(enc); *err = 25; return nullptr; }
  size_t cap = initial_cap;
  uint8_t* next_out = outbuf;
  size_t avail_out = cap;
  for (;;) {
    JxlEncoderStatus status = JxlEncoderProcessOutput(enc, &next_out, &avail_out);
    if (status == JXL_ENC_SUCCESS) {
      *out_size = static_cast<size_t>(next_out - outbuf);
      JxlEncoderDestroy(enc);
      return outbuf;
    }
    if (status == JXL_ENC_NEED_MORE_OUTPUT) {
      const size_t offset = static_cast<size_t>(next_out - outbuf);
      if (max_cap != 0 && cap >= max_cap) {
        free(outbuf);
        JxlEncoderDestroy(enc);
        *err = 216;
        return nullptr;
      }
      size_t next_cap = cap * 2u;
      if (max_cap != 0 && next_cap > max_cap) next_cap = max_cap;
      if (next_cap <= cap) next_cap = cap + 65536u; // safety
      uint8_t* grown = static_cast<uint8_t*>(realloc(outbuf, next_cap));
      if (grown == nullptr) { free(outbuf); JxlEncoderDestroy(enc); *err = 27; return nullptr; }
      outbuf = grown;
      next_out = outbuf + offset;
      avail_out = next_cap - offset;
      cap = next_cap;
      continue;
    }
    free(outbuf);
    JxlEncoderDestroy(enc);
    *err = static_cast<int>(status);
    return nullptr;
  }
}

// Common frame settings applicator (parity for gain-map path + dedupe from the 3 main encoders).
static void ApplyCommonFrameOptions(JxlEncoderFrameSettings* frame,
    float distance, uint32_t effort,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac,
    uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso,
    uint32_t resampling, int32_t ec_resampling,
    int32_t epf, int32_t gaborish, int32_t dots, int32_t color_transform,
    int32_t disable_perceptual) {
  JxlEncoderSetFrameDistance(frame, distance);
  if (distance == 0.0f) JxlEncoderSetFrameLossless(frame, JXL_TRUE);
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));
  ApplyProgressiveFrameSettings(frame, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order);
  if (modular >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_MODULAR, static_cast<int64_t>(modular));
  if (brotli_effort >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_BROTLI_EFFORT, static_cast<int64_t>(brotli_effort));
  if (decoding_speed >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_DECODING_SPEED, static_cast<int64_t>(std::clamp(decoding_speed, 0, 4)));
  if (photon_noise_iso > 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PHOTON_NOISE, static_cast<int64_t>(photon_noise_iso));
  ApplyResamplingFrameSettings(frame, resampling, ec_resampling);
  if (epf >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EPF, static_cast<int64_t>(std::clamp(epf, 0, 3)));
  if (gaborish >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_GABORISH, static_cast<int64_t>(gaborish & 1));
  if (dots >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_DOTS, static_cast<int64_t>(dots & 1));
  if (color_transform >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_COLOR_TRANSFORM, static_cast<int64_t>(std::clamp(color_transform, 0, 2)));
  if (disable_perceptual > 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_DISABLE_PERCEPTUAL_HEURISTICS, 1LL);
}

// Forward declarations — defined later in file, used here first.
static inline void CopyPixel(const uint8_t* src, uint8_t* dst, uint32_t bpp);
static void StripAlphaToRgb(const uint8_t* src, uint8_t* dst, size_t n_pixels, size_t bytes_per_channel);

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
        CopyPixel(src_row + x * 2u * bpp, dst_row + x * bpp, bpp);
    }
  } else if (downsample == 4u) {
    for (uint32_t y = 0; y < dh; ++y) {
      const uint8_t* src_row = src + static_cast<size_t>(y * 4u) * sw * bpp;
      uint8_t*       dst_row = dst + static_cast<size_t>(y)       * dw * bpp;
      for (uint32_t x = 0; x < dw; ++x)
        CopyPixel(src_row + x * 4u * bpp, dst_row + x * bpp, bpp);
    }
  } else if (downsample == 8u) {
    for (uint32_t y = 0; y < dh; ++y) {
      const uint8_t* src_row = src + static_cast<size_t>(y * 8u) * sw * bpp;
      uint8_t*       dst_row = dst + static_cast<size_t>(y)       * dw * bpp;
      for (uint32_t x = 0; x < dw; ++x)
        CopyPixel(src_row + x * 8u * bpp, dst_row + x * bpp, bpp);
    }
  } else {
    for (uint32_t y = 0; y < dh; ++y) {
      const uint32_t sy      = std::min(y * downsample, sh - 1u);
      const uint8_t* src_row = src + static_cast<size_t>(sy) * sw * bpp;
      uint8_t*       dst_row = dst + static_cast<size_t>(y)  * dw * bpp;
      for (uint32_t x = 0; x < dw; ++x) {
        const uint32_t sx = std::min(x * downsample, sw - 1u);
        CopyPixel(src_row + sx * bpp, dst_row + x * bpp, bpp);
      }
    }
  }
}

// IMPROVEMENT-2: Raw malloc replaces std::vector zero-init + MakeBuffer memcpy for decode.
static JxlWasmBuffer* DecodeRgba(const uint8_t* input, size_t input_size, uint32_t downsample, uint32_t fmt) {
  if (input == nullptr || input_size == 0) return MakeError(1);

  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) return MakeError(2);
  JXL_SETUP_DEC_RUNNER(dec, MakeError(58));

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

// Clamp arbitrary uint to a valid JxlOrientation (1..8). Out-of-range → identity.
static inline JxlOrientation ToJxlOrientation(uint32_t o) {
  return (o >= 1u && o <= 8u) ? static_cast<JxlOrientation>(o) : JXL_ORIENT_IDENTITY;
}

static inline void ApplyProgressiveFrameSettings(
    JxlEncoderFrameSettings* frame,
    uint32_t progressive_dc,
    uint32_t progressive_ac,
    uint32_t qprogressive_ac,
    uint32_t buffering,
    uint32_t group_order) {
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PROGRESSIVE_DC, static_cast<int64_t>(progressive_dc));
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PROGRESSIVE_AC, static_cast<int64_t>(progressive_ac));
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_QPROGRESSIVE_AC, static_cast<int64_t>(qprogressive_ac));
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_BUFFERING, static_cast<int64_t>(buffering));
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_GROUP_ORDER, static_cast<int64_t>(group_order));
  if (progressive_dc > 0 || progressive_ac > 0 || qprogressive_ac > 0) {
    JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_RESPONSIVE, 1);
  }
}

static JxlWasmBuffer* EncodeRgbaWithMetadata(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering,
    uint32_t group_order,  // predator: 0=scanline, 1=center-out for early passes
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    const WasmBoxOpts* box_opts = nullptr,
    int32_t epf = -1, int32_t gaborish = -1,
    int32_t dots = -1, int32_t color_transform = -1,
    uint32_t orientation = 1u,
    // CasaSneyers_Parity (Ch3): display dims separate from encoded pixel dims (Retina @2×)
    uint32_t intrinsic_width = 0u, uint32_t intrinsic_height = 0u,
    // CasaSneyers_Parity: disable psychovisual butteraugli/XYB model (ID 39) for fair benchmarking
    int32_t disable_perceptual = -1,
    int32_t codestream_level = -1,
    int32_t premultiply_alpha = -1,
    int32_t ec_resampling = -1) {
  if (pixels == nullptr || width == 0 || height == 0) return MakeError(20);

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return MakeError(21);
  JXL_SETUP_ENC_RUNNER(enc, MakeError(57));
  if (ApplyContainerMode(enc, box_opts) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(54);
  }
  // libjxl 0.11+: JxlEncoderAddBox requires JxlEncoderUseBoxes (distinct from
  // JxlEncoderUseContainer). Must be called before any bytes are written.
  if ((exif != nullptr && exif_size > 0) || (xmp != nullptr && xmp_size > 0)) {
    JxlEncoderUseBoxes(enc);
  }

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
  if (has_alpha && premultiply_alpha >= 0) {
    info.alpha_premultiplied = premultiply_alpha > 0 ? JXL_TRUE : JXL_FALSE;
  }
  // JXL's free rotation: store EXIF orientation in the basic info. Decoders apply
  // the transform via metadata (canvas/CSS), no pixel rotation needed on encode.
  info.orientation            = ToJxlOrientation(orientation);
  // libjxl 0.11+: must declare uses_original_profile before SetBasicInfo when
  // an ICC profile will follow; encoder rejects SetICCProfile if XYB mode is locked in.
  info.uses_original_profile = (icc_profile != nullptr && icc_size > 0) ? JXL_TRUE : JXL_FALSE;
  // CasaSneyers_Parity (Ch3): non-zero signals display dims separate from encoded pixel dims
  // (e.g. Retina @2×). JxlBasicInfo.intrinsic_xsize/ysize; 0 = not set (default).
  if (intrinsic_width > 0u && intrinsic_height > 0u) {
    info.intrinsic_xsize = intrinsic_width;
    info.intrinsic_ysize = intrinsic_height;
  }

  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(22); }
  if (codestream_level == 5 || codestream_level == 10) {
    if (JxlEncoderSetCodestreamLevel(enc, codestream_level) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return MakeError(64);
    }
  }

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
  if (distance == 0.0f) JxlEncoderSetFrameLossless(frame, JXL_TRUE);
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));
  ApplyProgressiveFrameSettings(frame, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order);
  if (modular >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_MODULAR, static_cast<int64_t>(modular));
  if (brotli_effort >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_BROTLI_EFFORT, static_cast<int64_t>(brotli_effort));
  if (decoding_speed >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_DECODING_SPEED, static_cast<int64_t>(std::clamp(decoding_speed, 0, 4)));
  if (photon_noise_iso > 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PHOTON_NOISE, static_cast<int64_t>(photon_noise_iso));
  ApplyResamplingFrameSettings(frame, resampling, ec_resampling);
  if (epf >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EPF, static_cast<int64_t>(std::clamp(epf, 0, 3)));
  if (gaborish >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_GABORISH, static_cast<int64_t>(gaborish & 1));
  if (dots >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_DOTS, static_cast<int64_t>(dots & 1));
  if (color_transform >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_COLOR_TRANSFORM, static_cast<int64_t>(std::clamp(color_transform, 0, 2)));
  // CasaSneyers_Parity: disable psychovisual heuristics (ID 39) — bypass butteraugli/XYB model.
  if (disable_perceptual > 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_DISABLE_PERCEPTUAL_HEURISTICS, 1LL);

  const size_t bytes_per_channel = (fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u;
  // A3: fmt==3 means caller already provides 3-channel RGB (no alpha in buffer).
  const bool input_is_rgb = (fmt == 3u);
  const uint32_t num_channels = (input_is_rgb || !has_alpha) ? 3u : 4u;
  JxlPixelFormat pf = {num_channels, FormatToDataType(fmt), JXL_NATIVE_ENDIAN, 0};

  uint8_t* rgb_pixels = nullptr;
  const uint8_t* encode_src = pixels;
  size_t pixel_size;
  if (input_is_rgb) {
    // Input is already 3-channel RGB — pass through directly, no strip needed.
    pixel_size = static_cast<size_t>(width) * height * 3u * bytes_per_channel;
  } else if (!has_alpha) {
    // 4-channel RGBA with has_alpha=false — strip alpha to 3-channel RGB.
    const size_t n_pixels   = static_cast<size_t>(width) * height;
    const size_t dst_stride = 3u * bytes_per_channel;
    pixel_size = n_pixels * dst_stride;
    rgb_pixels = static_cast<uint8_t*>(malloc(pixel_size));
    if (rgb_pixels == nullptr) { JxlEncoderDestroy(enc); return MakeError(29); }
    StripAlphaToRgb(pixels, rgb_pixels, n_pixels, bytes_per_channel);
    encode_src = rgb_pixels;
  } else {
    pixel_size = static_cast<size_t>(width) * height * 4u * bytes_per_channel;
  }

  const JxlEncoderStatus add_status = JxlEncoderAddImageFrame(frame, &pf, encode_src, pixel_size);
  free(rgb_pixels);
  if (add_status != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(24); }

  const JxlBool compress_flag = (box_opts && box_opts->compress_boxes) ? JXL_TRUE : JXL_FALSE;
  if (exif != nullptr && exif_size > 0) {
    if (JxlEncoderAddBox(enc, "Exif", exif, exif_size, compress_flag) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return MakeError(52);
    }
  }

  if (xmp != nullptr && xmp_size > 0) {
    if (JxlEncoderAddBox(enc, "xml ", xmp, xmp_size, compress_flag) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return MakeError(53);
    }
  }

  if (AddCustomBoxes(enc, box_opts) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(55);
  }

  JxlEncoderCloseInput(enc);

  size_t out_sz = 0;
  int perr = 0;
  const size_t init_cap = EstimateOutputCap(width, height, fmt, distance, effort);
  uint8_t* outbuf = PumpEncoderOutput(enc, init_cap, 0, &out_sz, &perr);
  if (outbuf == nullptr) return MakeError(perr ? perr : 25);
  JxlWasmBuffer* result = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
  if (result == nullptr) { free(outbuf); return MakeError(26); }
  result->data = outbuf;
  result->size = out_sz;
  result->width = width;
  result->height = height;
  result->bits_per_sample = bits;
  result->has_alpha = has_alpha;
  return result;
}

static JxlWasmBuffer* EncodeRgba(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular = -1, int32_t brotli_effort = -1, int32_t decoding_speed = -1, int32_t photon_noise_iso = 0, uint32_t resampling = 1u,
    int32_t epf = -1, int32_t gaborish = -1, int32_t dots = -1, int32_t color_transform = -1,
    uint32_t orientation = 1u) {
  return EncodeRgbaWithMetadata(pixels, width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling, nullptr, 0, nullptr, 0, nullptr, 0, nullptr, epf, gaborish, dots, color_transform, orientation);
}

static JxlWasmBuffer* EncodeRgbaWithGainMap(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    const uint8_t* gain_map_jxl, size_t gain_map_jxl_size) {
  if (pixels == nullptr || width == 0 || height == 0) return MakeError(20);

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return MakeError(21);
  JXL_SETUP_ENC_RUNNER(enc, MakeError(57));
  if ((exif != nullptr && exif_size > 0) || (xmp != nullptr && xmp_size > 0) || gain_map_jxl_size > 0) {
    JxlEncoderUseBoxes(enc);
  }

  const uint32_t bits     = FormatToBits(fmt);
  const uint32_t exp_bits = FormatToExponentBits(fmt);

  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize                    = width;
  info.ysize                    = height;
  info.bits_per_sample          = bits;
  info.exponent_bits_per_sample = exp_bits;
  info.num_color_channels       = 3;
  info.num_extra_channels       = has_alpha ? 1u : 0u;
  info.alpha_bits               = has_alpha ? bits : 0u;
  info.alpha_exponent_bits      = has_alpha ? exp_bits : 0u;
  info.uses_original_profile    = (icc_profile != nullptr && icc_size > 0) ? JXL_TRUE : JXL_FALSE;

  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(22); }

  if (icc_profile != nullptr && icc_size > 0) {
    if (JxlEncoderSetICCProfile(enc, icc_profile, icc_size) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(51);
    }
  } else {
    JxlColorEncoding color;
    JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
    if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(23); }
  }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  // 2.6: route gain-map through common applicator (parity for epf/gaborish/dots/ct + the rest).
  ApplyCommonFrameOptions(frame, distance, effort,
      progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order,
      modular, brotli_effort, decoding_speed, photon_noise_iso,
      resampling, -1,
      -1, -1, -1, -1, -1);

  const size_t bytes_per_channel = (fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u;
  const bool input_is_rgb = (fmt == 3u);
  const uint32_t num_channels = (input_is_rgb || !has_alpha) ? 3u : 4u;
  JxlPixelFormat pf = {num_channels, FormatToDataType(fmt), JXL_NATIVE_ENDIAN, 0};

  uint8_t* rgb_pixels = nullptr;
  const uint8_t* encode_src = pixels;
  size_t pixel_size;
  if (input_is_rgb) {
    pixel_size = static_cast<size_t>(width) * height * 3u * bytes_per_channel;
  } else if (!has_alpha) {
    const size_t n_pixels   = static_cast<size_t>(width) * height;
    const size_t dst_stride = 3u * bytes_per_channel;
    pixel_size = n_pixels * dst_stride;
    rgb_pixels = static_cast<uint8_t*>(malloc(pixel_size));
    if (rgb_pixels == nullptr) { JxlEncoderDestroy(enc); return MakeError(29); }
    StripAlphaToRgb(pixels, rgb_pixels, n_pixels, bytes_per_channel);
    encode_src = rgb_pixels;
  } else {
    pixel_size = static_cast<size_t>(width) * height * 4u * bytes_per_channel;
  }

  const JxlEncoderStatus add_status = JxlEncoderAddImageFrame(frame, &pf, encode_src, pixel_size);
  free(rgb_pixels);
  if (add_status != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(24); }

  if (exif != nullptr && exif_size > 0) {
    if (JxlEncoderAddBox(enc, "Exif", exif, exif_size, JXL_FALSE) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(52);
    }
  }
  if (xmp != nullptr && xmp_size > 0) {
    if (JxlEncoderAddBox(enc, "xml ", xmp, xmp_size, JXL_FALSE) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(53);
    }
  }

#if JXL_GAIN_MAP_SUPPORTED
  if (gain_map_jxl != nullptr && gain_map_jxl_size > 0) {
    JxlGainMapBundle bundle = {};
    bundle.gain_map      = gain_map_jxl;
    bundle.gain_map_size = static_cast<uint32_t>(gain_map_jxl_size);
    size_t bundle_size = 0;
    if (JxlGainMapGetBundleSize(&bundle, &bundle_size) != JXL_TRUE) {
      JxlEncoderDestroy(enc); return MakeError(60);
    }
    uint8_t* bundle_bytes = static_cast<uint8_t*>(malloc(bundle_size));
    if (bundle_bytes == nullptr) { JxlEncoderDestroy(enc); return MakeError(61); }
    size_t bytes_written = 0;
    if (JxlGainMapWriteBundle(&bundle, bundle_bytes, bundle_size, &bytes_written) != JXL_TRUE) {
      free(bundle_bytes); JxlEncoderDestroy(enc); return MakeError(62);
    }
    const JxlEncoderStatus gm_st = JxlEncoderAddBox(enc, "jhgm", bundle_bytes, bytes_written, JXL_FALSE);
    free(bundle_bytes);
    if (gm_st != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(63); }
  }
#endif

  JxlEncoderCloseInput(enc);

  size_t out_sz = 0;
  int perr = 0;
  const size_t init_cap = EstimateOutputCap(width, height, fmt, distance, effort);
  uint8_t* outbuf = PumpEncoderOutput(enc, init_cap, 0, &out_sz, &perr);
  if (outbuf == nullptr) return MakeError(perr ? perr : 25);
  JxlWasmBuffer* result = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
  if (result == nullptr) { free(outbuf); return MakeError(26); }
  result->data            = outbuf;
  result->size            = out_sz;
  result->width           = width;
  result->height          = height;
  result->bits_per_sample = bits;
  result->has_alpha       = has_alpha;
  return result;
}

// Encode with per-extra-channel distance and optional separate channel planes.
// alpha_distance < 0 -> libjxl default for alpha.
// extra_channels/num_extra_channels describe channels beyond the implicit alpha.
static JxlWasmBuffer* EncodeRgbaWithExtraChannels(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed,
    int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    float alpha_distance,
    const WasmExtraChannel* extra_channels, uint32_t num_extra_channels,
    const WasmBoxOpts* box_opts = nullptr,
    uint32_t orientation = 1u,
    int32_t ec_resampling = -1) {
  if (pixels == nullptr || width == 0 || height == 0) return MakeError(120);

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return MakeError(121);
  JXL_SETUP_ENC_RUNNER(enc, MakeError(57));
  if (ApplyContainerMode(enc, box_opts) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(134);
  }

  const uint32_t bits     = FormatToBits(fmt);
  const uint32_t exp_bits = FormatToExponentBits(fmt);

  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize                    = width;
  info.ysize                    = height;
  info.bits_per_sample          = bits;
  info.exponent_bits_per_sample = exp_bits;
  info.num_color_channels       = 3;
  info.num_extra_channels       = (has_alpha ? 1u : 0u) + num_extra_channels;
  info.alpha_bits               = has_alpha ? bits : 0u;
  info.alpha_exponent_bits      = has_alpha ? exp_bits : 0u;
  info.orientation              = ToJxlOrientation(orientation);

  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(122);
  }

  // Declare extra channels beyond alpha (alpha is declared via BasicInfo above).
  for (uint32_t i = 0; i < num_extra_channels; ++i) {
    const WasmExtraChannel& ec = extra_channels[i];
    const uint32_t ec_index = (has_alpha ? 1u : 0u) + i;
    JxlExtraChannelInfo ec_info;
    memset(&ec_info, 0, sizeof(ec_info));
    ec_info.type = static_cast<JxlExtraChannelType>(ec.type);
    ec_info.bits_per_sample = ec.bits > 0u ? ec.bits : 8u;
    ec_info.exponent_bits_per_sample = (ec.bits == 32u) ? 8u : 0u;
    if (JxlEncoderSetExtraChannelInfo(enc, ec_index, &ec_info) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(130);
    }
  }

  if (icc_profile != nullptr && icc_size > 0) {
    if (JxlEncoderSetICCProfile(enc, icc_profile, icc_size) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(129);
    }
  } else {
    JxlColorEncoding color;
    JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
    if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(123);
    }
  }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  JxlEncoderSetFrameDistance(frame, distance);
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));
  ApplyProgressiveFrameSettings(frame, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order);
  if (modular >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_MODULAR, static_cast<int64_t>(modular));
  if (brotli_effort >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_BROTLI_EFFORT, static_cast<int64_t>(brotli_effort));
  if (decoding_speed >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_DECODING_SPEED, static_cast<int64_t>(std::clamp(decoding_speed, 0, 4)));
  if (photon_noise_iso > 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PHOTON_NOISE, static_cast<int64_t>(photon_noise_iso));
  ApplyResamplingFrameSettings(frame, resampling, ec_resampling);

  // Per-extra-channel distances.
  if (has_alpha && alpha_distance >= 0.0f) {
    JxlEncoderSetExtraChannelDistance(frame, 0, alpha_distance);
  }
  for (uint32_t i = 0; i < num_extra_channels; ++i) {
    const WasmExtraChannel& ec = extra_channels[i];
    if (ec.distance >= 0.0f) {
      JxlEncoderSetExtraChannelDistance(frame, (has_alpha ? 1u : 0u) + i, ec.distance);
    }
  }

  // Main image frame (interleaved RGBA or RGB; libjxl splits alpha from interleaved data).
  const size_t bytes_per_channel = (fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u;
  const uint32_t num_channels = has_alpha ? 4u : 3u;
  JxlPixelFormat pf = {num_channels, FormatToDataType(fmt), JXL_NATIVE_ENDIAN, 0};

  uint8_t* rgb_pixels = nullptr;
  const uint8_t* encode_src = pixels;
  size_t pixel_size;
  if (!has_alpha) {
    const size_t n_pixels   = static_cast<size_t>(width) * height;
    const size_t src_stride = 4u * bytes_per_channel;
    const size_t dst_stride = 3u * bytes_per_channel;
    pixel_size = n_pixels * dst_stride;
    rgb_pixels = static_cast<uint8_t*>(malloc(pixel_size));
    if (rgb_pixels == nullptr) { JxlEncoderDestroy(enc); return MakeError(128); }
    StripAlphaToRgb(pixels, rgb_pixels, n_pixels, bytes_per_channel);
    encode_src = rgb_pixels;
  } else {
    pixel_size = static_cast<size_t>(width) * height * 4u * bytes_per_channel;
  }

  const JxlEncoderStatus add_status = JxlEncoderAddImageFrame(frame, &pf, encode_src, pixel_size);
  free(rgb_pixels);
  if (add_status != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(124); }

  // Extra channel plane buffers (must follow JxlEncoderAddImageFrame).
  for (uint32_t i = 0; i < num_extra_channels; ++i) {
    const WasmExtraChannel& ec = extra_channels[i];
    if (ec.plane_ptr == 0u || ec.plane_size == 0u) continue;
    const uint32_t ec_index = (has_alpha ? 1u : 0u) + i;
    JxlPixelFormat ec_pf = {1u, BitsToDataType(ec.bits > 0u ? ec.bits : 8u), JXL_NATIVE_ENDIAN, 0};
    const void* plane_data = reinterpret_cast<const void*>(static_cast<uintptr_t>(ec.plane_ptr));
    if (JxlEncoderSetExtraChannelBuffer(frame, &ec_pf, plane_data, ec.plane_size, ec_index) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(131);
    }
  }

  const JxlBool compress_flag_ec = (box_opts && box_opts->compress_boxes) ? JXL_TRUE : JXL_FALSE;
  if (exif != nullptr && exif_size > 0) {
    if (JxlEncoderAddBox(enc, "Exif", exif, exif_size, compress_flag_ec) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(132);
    }
  }
  if (xmp != nullptr && xmp_size > 0) {
    if (JxlEncoderAddBox(enc, "xml ", xmp, xmp_size, compress_flag_ec) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(133);
    }
  }
  if (AddCustomBoxes(enc, box_opts) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(135);
  }

  JxlEncoderCloseInput(enc);

  size_t out_sz = 0;
  int perr = 0;
  const size_t init_cap = EstimateOutputCap(width, height, fmt, distance, effort);
  uint8_t* outbuf = PumpEncoderOutput(enc, init_cap, 0, &out_sz, &perr);
  if (outbuf == nullptr) return MakeError(perr ? perr : 125);
  JxlWasmBuffer* result = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
  if (result == nullptr) { free(outbuf); return MakeError(126); }
  result->data = outbuf;
  result->size = out_sz;
  result->width = width;
  result->height = height;
  result->bits_per_sample = bits;
  result->has_alpha = has_alpha;
  return result;
}


// IMPROVEMENT-5: Integer box-filter downscale for RGBA8 thumbnail generation.
// Pixel-perfect averaging avoids aliasing artifacts visible at small sizes.
static void BoxDownscaleRgba8(const uint8_t* src, uint32_t sw, uint32_t sh,
                               uint8_t* dst, uint32_t dw, uint32_t dh) {
  if (dw == 0 || dh == 0) return;

  // Aggressive integer fast path for exact factors (common in thumbnail cascades).
  // Avoids the general ceiling division per output pixel when sw/dw and sh/dh are exact.
  if ((sw % dw == 0) && (sh % dh == 0)) {
    const uint32_t xstep = sw / dw;
    const uint32_t ystep = sh / dh;
    const uint32_t count = xstep * ystep;  // constant; hoist for divide and autovectorizer
    for (uint32_t dy = 0; dy < dh; ++dy) {
      for (uint32_t dx = 0; dx < dw; ++dx) {
        uint32_t r = 0, g = 0, b = 0, a = 0;
        for (uint32_t yy = 0; yy < ystep; ++yy) {
          const uint32_t y = dy * ystep + yy;
          const uint8_t* row = src + y * sw * 4;
          for (uint32_t xx = 0; xx < xstep; ++xx) {
            const uint32_t x = dx * xstep + xx;
            const uint8_t* px = row + x * 4;
            r += px[0]; g += px[1]; b += px[2]; a += px[3];
          }
        }
        uint8_t* out = dst + (dy * dw + dx) * 4;
        out[0] = static_cast<uint8_t>(r / count);
        out[1] = static_cast<uint8_t>(g / count);
        out[2] = static_cast<uint8_t>(b / count);
        out[3] = static_cast<uint8_t>(a / count);
      }
    }
    return;
  }

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
  if (n < 4 || p[0] != 0xFF || p[1] != 0xD8) return false;
  const size_t scan = n < 4096 ? n : 4096;
  for (size_t i = n - 2; i + 2 > n - scan; --i) {
    if (p[i] == 0xFF && p[i + 1] == 0xD9) return true;
    if (i == 0) break;
  }
  return false;
}

// Standard CRC-32 (ISO 3309 / ITU-T V.42) for JXTC tile integrity (bit2).
static uint32_t Crc32(const uint8_t* data, size_t len) {
  static uint32_t table[256];
  static bool inited = false;
  if (!inited) {
    for (uint32_t i = 0; i < 256; ++i) {
      uint32_t c = i;
      for (int j = 0; j < 8; ++j) c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
      table[i] = c;
    }
    inited = true;
  }
  uint32_t c = 0xFFFFFFFFu;
  for (size_t i = 0; i < len; ++i) c = table[(c ^ data[i]) & 0xFF] ^ (c >> 8);
  return c ^ 0xFFFFFFFFu;
}

// Fast per-pixel copy for decoder downsample paths (power-of-2 and general).
// Specializes the dominant bpp==4 (rgba8) and bpp==3 cases with direct bytes.
static inline void CopyPixel(const uint8_t* src, uint8_t* dst, uint32_t bpp) {
  if (bpp == 4) {
    dst[0] = src[0]; dst[1] = src[1]; dst[2] = src[2]; dst[3] = src[3];
  } else if (bpp == 3) {
    dst[0] = src[0]; dst[1] = src[1]; dst[2] = src[2];
  } else {
    memcpy(dst, src, bpp);
  }
}

// Fast alpha strip (RGBA -> RGB) for encode paths. Specializes the common 8-bit case
// with direct byte copies to avoid per-pixel memcpy call overhead on millions of pixels.
static void StripAlphaToRgb(const uint8_t* src, uint8_t* dst, size_t n_pixels, size_t bytes_per_channel) {
  const size_t src_stride = 4 * bytes_per_channel;
  const size_t dst_stride = 3 * bytes_per_channel;
  if (bytes_per_channel == 1) {
    for (size_t i = 0; i < n_pixels; ++i) {
      const uint8_t* s = src + i * 4;
      uint8_t* d = dst + i * 3;
      d[0] = s[0]; d[1] = s[1]; d[2] = s[2];
    }
  } else if (bytes_per_channel == 2) {
    // 16-bit: direct three uint16_t copies (mirrors the 8-bit fast path)
    for (size_t i = 0; i < n_pixels; ++i) {
      const uint16_t* s = reinterpret_cast<const uint16_t*>(src + i * src_stride);
      uint16_t* d = reinterpret_cast<uint16_t*>(dst + i * dst_stride);
      d[0] = s[0]; d[1] = s[1]; d[2] = s[2];
    }
  } else {
    for (size_t i = 0; i < n_pixels; ++i) {
      memcpy(dst + i * dst_stride, src + i * src_stride, dst_stride);
    }
  }
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
  JXL_SETUP_ENC_RUNNER(enc, MakeError(57));

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

  size_t out_sz = 0;
  int perr = 0;
  // Tiled uses simpler cap (not the Estimate which assumes full rgba4); keep prior heuristic for byte-id.
  const size_t init_cap = std::max(static_cast<size_t>(65536), static_cast<size_t>(width) * height);
  uint8_t* outbuf = PumpEncoderOutput(enc, init_cap, 0, &out_sz, &perr);
  if (outbuf == nullptr) return MakeError(perr ? perr : 68);
  return MakeBufferFromOwned(outbuf, out_sz, width, height, 8, has_alpha);
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
  JXL_SETUP_DEC_RUNNER(dec, MakeError(58));

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
      while (!got_image) {
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
// Layout (v2 + backward v1 read):
//   [Header 32B] magic 'JXTC' | version (1 or 2) | image_w | image_h |
//                tile_size | tiles_x | tiles_y | flags (bit0=has_alpha, bit1=rgba16, bit2=crc32)
//   [Index] per tile: v1=8B (off+len u32), v2+bit2=12B (off+len+crc32 u32)
//   [N standalone JXL bitstreams]
// v1 readers in this module accept ver==1||2 for flat (num_levels=0) layouts. External v1-strict
// sidecars (jxl-pyramid etc) are deferred per 2.9.
#define JXTC_MAGIC          0x4354584Au  // 'JXTC' little-endian
#define JXTC_VERSION        2u
#define JXTC_HEADER_BYTES   32u
#define JXTC_INDEX_BYTES    8u   // base (overridden by flags&4 for crc)

// Encode a single RGBA8 tile as a standalone JXL bitstream.
// Strips alpha channel inline if !has_alpha. Returns malloc'd buffer; caller frees.
// On failure returns nullptr and leaves *out_size unchanged.
static uint8_t* EncodeStandaloneJxlTileRgba8(const uint8_t* rgba_pixels,
    uint32_t width, uint32_t height, float distance, uint32_t effort,
    uint32_t has_alpha, size_t* out_size) {
  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return nullptr;
  JXL_SETUP_ENC_RUNNER(enc, nullptr);

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
  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return nullptr; }

  JxlColorEncoding color;
  JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
  if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return nullptr; }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  JxlEncoderSetFrameDistance(frame, distance);
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));

  JxlPixelFormat pf = {has_alpha ? 4u : 3u, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
  uint8_t* stripped = nullptr;
  const uint8_t* src = rgba_pixels;
  size_t pixel_size;
  if (has_alpha) {
    pixel_size = static_cast<size_t>(width) * height * 4u;
  } else {
    const size_t n = static_cast<size_t>(width) * height;
    pixel_size = n * 3u;
    stripped = static_cast<uint8_t*>(malloc(pixel_size));
    if (stripped == nullptr) { JxlEncoderDestroy(enc); return nullptr; }
    for (size_t i = 0; i < n; ++i) {
      stripped[i * 3 + 0] = rgba_pixels[i * 4 + 0];
      stripped[i * 3 + 1] = rgba_pixels[i * 4 + 1];
      stripped[i * 3 + 2] = rgba_pixels[i * 4 + 2];
    }
    src = stripped;
  }

  const JxlEncoderStatus add_status = JxlEncoderAddImageFrame(frame, &pf, src, pixel_size);
  free(stripped);
  if (add_status != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return nullptr; }

  JxlEncoderCloseInput(enc);

  size_t out_sz = 0;
  int perr = 0;
  const size_t init_cap = std::max(static_cast<size_t>(4096), pixel_size / 4u);
  uint8_t* outbuf = PumpEncoderOutput(enc, init_cap, 0, &out_sz, &perr);
  if (outbuf == nullptr) { *out_size = 0; return nullptr; }
  *out_size = out_sz;
  return outbuf;
}

// Decode a standalone JXL bitstream to RGBA8. Returns malloc'd pixel buffer; caller frees.
// Writes decoded dimensions to *out_w, *out_h. On failure returns nullptr.
// (Kept for direct callers / symmetry; the hot path for JXTC regions uses the reusing variant.)
static uint8_t* DecodeStandaloneJxlTileRgba8(const uint8_t* input, size_t input_size,
    uint32_t* out_w, uint32_t* out_h) {
  *out_w = 0; *out_h = 0;
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) return nullptr;
  JXL_SETUP_DEC_RUNNER(dec, nullptr);

  if (JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec); return nullptr;
  }
  JxlDecoderSetInput(dec, input, input_size);
  JxlDecoderCloseInput(dec);

  JxlBasicInfo info{};
  uint8_t* pixels = nullptr;
  size_t   pixels_size = 0;
  JxlPixelFormat pf = {4, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};

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

// Reusable-decoder + grow-only scratch variant for DecodeRgba8TileContainerRegion.
// Caller owns the JxlDecoder (create once, JXL_SETUP once, destroy after), and the scratch buffer.
// JxlDecoderReset is used between tiles; runner attached once by caller.
// Returns pointer into *scratch (do not free it); caller copies needed rect then reuses scratch for next tile.
static uint8_t* DecodeJxlTileRgba8Reusing(JxlDecoder* dec,
    uint8_t** scratch, size_t* scratch_cap,
    const uint8_t* input, size_t input_size,
    uint32_t* out_w, uint32_t* out_h) {
  *out_w = 0; *out_h = 0;
  if (dec == nullptr) return nullptr;

  JxlDecoderReset(dec);
  // Re-apply runner after reset (defensive; the shared runner is cheap to set).
  // Only under pthreads build (matches JXL_SETUP_DEC_RUNNER).
#ifdef __EMSCRIPTEN_PTHREADS__
  ApplyRunnerDec(dec);
#endif

  JxlDecoderSetInput(dec, input, input_size);
  JxlDecoderCloseInput(dec);

  JxlBasicInfo info{};
  JxlPixelFormat pf = {4, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};

  for (;;) {
    JxlDecoderStatus st = JxlDecoderProcessInput(dec);
    if (st == JXL_DEC_SUCCESS) break;
    if (st == JXL_DEC_ERROR || st == JXL_DEC_NEED_MORE_INPUT) {
      return nullptr;
    }
    if (st == JXL_DEC_BASIC_INFO) {
      if (JxlDecoderGetBasicInfo(dec, &info) != JXL_DEC_SUCCESS) return nullptr;
      continue;
    }
    if (st == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t buf_size = 0;
      if (JxlDecoderImageOutBufferSize(dec, &pf, &buf_size) != JXL_DEC_SUCCESS) return nullptr;
      if (buf_size > *scratch_cap) {
        uint8_t* grown = static_cast<uint8_t*>(realloc(*scratch, buf_size));
        if (grown == nullptr) return nullptr;
        *scratch = grown;
        *scratch_cap = buf_size;
      }
      if (JxlDecoderSetImageOutBuffer(dec, &pf, *scratch, buf_size) != JXL_DEC_SUCCESS) return nullptr;
      continue;
    }
  }

  *out_w = info.xsize;
  *out_h = info.ysize;
  return *scratch;
}

// Encode RGBA8 image into JXTC tile container.
static JxlWasmBuffer* EncodeRgba8TileContainer(const uint8_t* pixels,
    uint32_t width, uint32_t height, uint32_t tile_size,
    float distance, uint32_t effort, uint32_t has_alpha) {
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

  const size_t tile_stage_bytes = static_cast<size_t>(tile_size) * tile_size * 4u;
  uint8_t* tile_stage = static_cast<uint8_t*>(malloc(tile_stage_bytes));
  if (tile_stage == nullptr) {
    free(tile_bytes); free(tile_lengths); return MakeError(93);
  }

  uint64_t total_tile_bytes = 0;
  for (uint32_t ty = 0; ty < tiles_y; ++ty) {
    for (uint32_t tx = 0; tx < tiles_x; ++tx) {
      const uint32_t x0 = tx * tile_size;
      const uint32_t y0 = ty * tile_size;
      const uint32_t tw = std::min(tile_size, width  - x0);
      const uint32_t th = std::min(tile_size, height - y0);

      for (uint32_t row = 0; row < th; ++row) {
        memcpy(tile_stage + row * tw * 4u,
               pixels + (static_cast<size_t>(y0 + row) * width + x0) * 4u,
               tw * 4u);
      }

      size_t out_size = 0;
      uint8_t* enc_bytes = EncodeStandaloneJxlTileRgba8(tile_stage, tw, th, distance, effort, has_alpha, &out_size);
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

  const uint64_t header_bytes = JXTC_HEADER_BYTES;
  const bool emit_crc = true; // v2 path always includes crc32 for integrity (2.9)
  const uint64_t per_entry = emit_crc ? 12u : 8u;
  const uint64_t index_bytes = static_cast<uint64_t>(tile_count) * per_entry;
  const uint64_t total64     = header_bytes + index_bytes + total_tile_bytes;
  if (total64 > 0xFFFFFFFFull) {
    for (uint32_t i = 0; i < tile_count; ++i) free(tile_bytes[i]);
    free(tile_bytes); free(tile_lengths);
    return MakeError(96);
  }
  const size_t total_size = static_cast<size_t>(total64);
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
  // v2: set bit2 (crc) so index is 12B and integrity is recorded. bit1 (16) remains 0 for this path.
  const uint32_t flags = (has_alpha ? 1u : 0u) | 4u /*crc32*/;
  h32[7] = flags;

  const size_t hb = static_cast<size_t>(header_bytes);
  // v2+bit2 => 12B entries (3x u32); keep index_bytes var as base but stride computed.
  const bool has_crc = (flags & 4u) != 0;
  const size_t per_entry = has_crc ? 12u : 8u;
  const size_t actual_index_bytes = static_cast<size_t>(tile_count) * per_entry;
  uint32_t cursor = static_cast<uint32_t>(hb + actual_index_bytes);
  uint32_t* index = reinterpret_cast<uint32_t*>(output + hb);
  for (uint32_t i = 0; i < tile_count; ++i) {
    const uint32_t off = cursor;
    const uint32_t len = static_cast<uint32_t>(tile_lengths[i]);
    const uint32_t crc = Crc32(tile_bytes[i], tile_lengths[i]);
    if (has_crc) {
      index[i * 3 + 0] = off;
      index[i * 3 + 1] = len;
      index[i * 3 + 2] = crc;
    } else {
      index[i * 2 + 0] = off;
      index[i * 2 + 1] = len;
    }
    memcpy(output + cursor, tile_bytes[i], tile_lengths[i]);
    cursor += len;
    free(tile_bytes[i]);
  }
  free(tile_bytes);
  free(tile_lengths);

  return MakeBufferFromOwned(output, total_size, width, height, 8, has_alpha);
}

// Decode region from a JXTC tile container. Only tiles overlapping the region
// are decoded. Each tile is a standalone JXL — zero frame-walk overhead.
static JxlWasmBuffer* DecodeRgba8TileContainerRegion(const uint8_t* input, size_t input_size,
    uint32_t region_x, uint32_t region_y, uint32_t region_w, uint32_t region_h) {
  if (input == nullptr || input_size < JXTC_HEADER_BYTES) return MakeError(100);

  const uint32_t* h32 = reinterpret_cast<const uint32_t*>(input);
  if (h32[0] != JXTC_MAGIC)   return MakeError(101);
  const uint32_t ver = h32[1];
  if (ver != 1u && ver != 2u) return MakeError(102);
  const uint32_t image_w   = h32[2];
  const uint32_t image_h   = h32[3];
  const uint32_t tile_size = h32[4];
  const uint32_t tiles_x   = h32[5];
  const uint32_t tiles_y   = h32[6];
  if (image_w == 0 || image_h == 0 || tile_size == 0 || tiles_x == 0 || tiles_y == 0) return MakeError(103);

  const uint32_t tile_count = tiles_x * tiles_y;
  const size_t header_bytes = JXTC_HEADER_BYTES;
  const uint32_t flags = h32[7];
  const bool is_16bit  = (flags & 2u) != 0;
  const bool has_crc   = (ver == 2u) && ((flags & 4u) != 0);
  if (is_16bit) return MakeError(110); // 16bit JXTC decode not yet wired to 16-bit composite (deferred)
  const size_t per_entry   = has_crc ? 12u : 8u;
  const size_t index_bytes = static_cast<size_t>(tile_count) * per_entry;
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

  const size_t out_size = static_cast<size_t>(rw) * rh * 4u;
  uint8_t* out_pixels = static_cast<uint8_t*>(calloc(out_size, 1u));
  if (out_pixels == nullptr) return MakeError(106);

  // 1.5: one decoder + runner attachment for the whole region. JxlDecoderReset between
  // independent tile bitstreams. Grow-only scratch replaces per-tile malloc+free of full
  // tile buffers (~16 large allocs avoided for a 4x4 viewport pan).
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) { free(out_pixels); return MakeError(110); }
  JXL_SETUP_DEC_RUNNER(dec, (free(out_pixels), MakeError(58)));
  if (JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec); free(out_pixels); return MakeError(111);
  }

  uint8_t* scratch = nullptr;
  size_t scratch_cap = 0;

  bool region_ok = true;
  for (uint32_t ty = ty_min; ty <= ty_max && region_ok; ++ty) {
    for (uint32_t tx = tx_min; tx <= tx_max && region_ok; ++tx) {
      const uint32_t idx = ty * tiles_x + tx;
      if (idx >= tile_count) { region_ok = false; break; }
      const uint32_t* e = index + idx * (per_entry / 4u);
      const uint32_t offset = e[0];
      const uint32_t length = e[1];
      const uint32_t crc    = has_crc ? e[2] : 0u;
      if (offset < header_bytes + index_bytes || static_cast<size_t>(offset) + length > input_size) {
        region_ok = false; break;
      }
      if (has_crc && Crc32(input + offset, length) != crc) { region_ok = false; break; }

      uint32_t tile_w = 0, tile_h = 0;
      uint8_t* tile_pixels = DecodeJxlTileRgba8Reusing(dec, &scratch, &scratch_cap,
          input + offset, length, &tile_w, &tile_h);
      if (tile_pixels == nullptr) { region_ok = false; break; }

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
          const uint8_t* src = tile_pixels + ((oy0 - tile_y0 + row) * tile_w + (ox0 - tile_x0)) * 4u;
          uint8_t*       dst = out_pixels  + ((oy0 - ry      + row) * rw     + (ox0 - rx))      * 4u;
          memcpy(dst, src, ow * 4u);
        }
      }
      // No free(tile_pixels): it is the scratch; reused for next tile.
    }
  }

  if (!region_ok) {
    free(scratch);
    JxlDecoderDestroy(dec);
    free(out_pixels);
    return MakeError(109);
  }

  // A3: 1px seam blending at internal JXTC tile boundaries using Q8 fixed-point.
  // Source buffer now calloc (no uninit garbage into blends). Bulk is memcpy; seams only.
  // Directional: 0.70/0.30 crossfade (l*179+r*77 vs swapped). Vert then horiz for corners.
  // Lightweight — only touches O(perimeter) pixels.
  {
    // Vertical seams (between tx and tx+1)
    for (uint32_t txx = tx_min + 1; txx <= tx_max; ++txx) {
      const uint32_t abs_seam = txx * tile_size;
      if (abs_seam <= rx || abs_seam >= (rx + rw)) continue;
      const uint32_t localL = (abs_seam - 1) - rx; // right col of left tile
      const uint32_t localR = abs_seam - rx;       // left col of right tile
      if (localL >= rw || localR >= rw) continue;
      for (uint32_t yy = 0; yy < rh; ++yy) {
        uint8_t* pL = out_pixels + ((yy * rw + localL) * 4u);
        uint8_t* pR = out_pixels + ((yy * rw + localR) * 4u);
        for (int c = 0; c < 4; ++c) {
          int l = pL[c];
          int r = pR[c];
          int bL = (l * 179 + r * 77 + 128) >> 8;
          int bR = (l * 77 + r * 179 + 128) >> 8;
          pL[c] = static_cast<uint8_t>(bL);
          pR[c] = static_cast<uint8_t>(bR);
        }
      }
    }
    // Horizontal seams (between ty and ty+1)
    for (uint32_t tyy = ty_min + 1; tyy <= ty_max; ++tyy) {
      const uint32_t abs_seam = tyy * tile_size;
      if (abs_seam <= ry || abs_seam >= (ry + rh)) continue;
      const uint32_t localT = (abs_seam - 1) - ry;
      const uint32_t localB = abs_seam - ry;
      if (localT >= rh || localB >= rh) continue;
      for (uint32_t xx = 0; xx < rw; ++xx) {
        uint8_t* pT = out_pixels + ((localT * rw + xx) * 4u);
        uint8_t* pB = out_pixels + ((localB * rw + xx) * 4u);
        for (int c = 0; c < 4; ++c) {
          int t = pT[c];
          int b = pB[c];
          int bT = (t * 179 + b * 77 + 128) >> 8;
          int bB = (t * 77 + b * 179 + 128) >> 8;
          pT[c] = static_cast<uint8_t>(bT);
          pB[c] = static_cast<uint8_t>(bB);
        }
      }
    }
  }

  // Success path for region: release the per-region scratch and the reused decoder.
  free(scratch);
  JxlDecoderDestroy(dec);
  return MakeBufferFromOwned(out_pixels, out_size, rw, rh, 8, 1);
}

// Encode a multi-frame JXL animation.
// frames points to a WasmAnimationFrame[] array; returns JxlWasmBuffer with encoded bitstream.
static JxlWasmBuffer* EncodeAnimation(
    const WasmAnimationFrame* frames, uint32_t num_frames,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    const WasmBoxOpts* box_opts,
    const WasmAnimationOpts* anim_opts) {
  if (frames == nullptr || num_frames == 0) return MakeError(200);

  const uint32_t ref_w = frames[0].width;
  const uint32_t ref_h = frames[0].height;
  for (uint32_t i = 1; i < num_frames; ++i) {
    if (frames[i].width != ref_w || frames[i].height != ref_h) return MakeError(219);
  }

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return MakeError(201);
  JXL_SETUP_ENC_RUNNER(enc, MakeError(57));
  if (ApplyContainerMode(enc, box_opts) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(202);
  }

  const uint32_t bits     = FormatToBits(fmt);
  const uint32_t exp_bits = FormatToExponentBits(fmt);
  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize                    = frames[0].width;
  info.ysize                    = frames[0].height;
  info.bits_per_sample          = bits;
  info.exponent_bits_per_sample = exp_bits;
  info.num_color_channels       = 3;
  info.num_extra_channels       = has_alpha ? 1u : 0u;
  info.alpha_bits               = has_alpha ? bits : 0u;
  info.alpha_exponent_bits      = has_alpha ? exp_bits : 0u;

  info.have_animation            = JXL_TRUE;
  info.animation.tps_numerator   = anim_opts ? anim_opts->ticks_per_second : 1000u;
  info.animation.tps_denominator = 1u;
  info.animation.num_loops       = anim_opts ? anim_opts->loop_count : 0u;
  info.animation.have_timecodes  = JXL_FALSE;

  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(203);
  }

  if (icc_profile != nullptr && icc_size > 0) {
    if (JxlEncoderSetICCProfile(enc, icc_profile, icc_size) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(204);
    }
  } else {
    JxlColorEncoding color;
    JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
    if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(205);
    }
  }

  JxlEncoderFrameSettings* frame_settings = JxlEncoderFrameSettingsCreate(enc, nullptr);
  JxlEncoderSetFrameDistance(frame_settings, distance);
  JxlEncoderFrameSettingsSetOption(frame_settings, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));
  if (modular >= 0)         JxlEncoderFrameSettingsSetOption(frame_settings, JXL_ENC_FRAME_SETTING_MODULAR,        static_cast<int64_t>(modular));
  if (brotli_effort >= 0)   JxlEncoderFrameSettingsSetOption(frame_settings, JXL_ENC_FRAME_SETTING_BROTLI_EFFORT,  static_cast<int64_t>(brotli_effort));
  if (decoding_speed >= 0)  JxlEncoderFrameSettingsSetOption(frame_settings, JXL_ENC_FRAME_SETTING_DECODING_SPEED, static_cast<int64_t>(std::clamp(decoding_speed, 0, 4)));
  if (photon_noise_iso > 0) JxlEncoderFrameSettingsSetOption(frame_settings, JXL_ENC_FRAME_SETTING_PHOTON_NOISE,   static_cast<int64_t>(photon_noise_iso));
  const uint32_t norm_resamp = NormalizeResampling(resampling);
  if (norm_resamp > 1u)      JxlEncoderFrameSettingsSetOption(frame_settings, JXL_ENC_FRAME_SETTING_RESAMPLING,    static_cast<int64_t>(norm_resamp));

  const size_t bytes_per_channel = (fmt == 2u) ? 4u : (fmt == 1u) ? 2u : 1u;
  JxlPixelFormat pf = {has_alpha ? 4u : 3u, FormatToDataType(fmt), JXL_NATIVE_ENDIAN, 0};

  for (uint32_t fi = 0; fi < num_frames; ++fi) {
    const WasmAnimationFrame& wf = frames[fi];
    if (wf.pixels_ptr == 0 || wf.pixels_size == 0) { JxlEncoderDestroy(enc); return MakeError(206); }
    const uint8_t* pixels = reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(wf.pixels_ptr));

    JxlEncoderFrameSettings* fs = JxlEncoderFrameSettingsCreate(enc, frame_settings);
    {
      JxlFrameHeader fh;
      JxlEncoderInitFrameHeader(&fh);
      fh.duration = wf.duration;
      // CasaSneyers_Parity (Ch3/Ch9.3.2): per-frame blend mode (Replace/Add/Blend/MulAdd/Mul).
      // blend_mode field added at offset 28 of WasmAnimationFrame in this build.
      // Clamp to valid JxlBlendMode range (0-4); 0 = JXL_BLEND_REPLACE (default/safe).
      const uint32_t bm = std::min(wf.blend_mode, static_cast<uint32_t>(4));
      fh.layer_info.blend_info.blendmode = static_cast<JxlBlendMode>(bm);
      fh.layer_info.blend_info.source    = 0;
      fh.layer_info.blend_info.alpha     = 0;
      fh.layer_info.blend_info.clamp     = JXL_FALSE;
      if (JxlEncoderSetFrameHeader(fs, &fh) != JXL_ENC_SUCCESS) {
        JxlEncoderDestroy(enc); return MakeError(207);
      }
    }
    if (wf.name_ptr != 0 && wf.name_size > 0) {
      const char* name = reinterpret_cast<const char*>(static_cast<uintptr_t>(wf.name_ptr));
      std::vector<char> name_buf(wf.name_size + 1, '\0');
      memcpy(name_buf.data(), name, wf.name_size);
      if (JxlEncoderSetFrameName(fs, name_buf.data()) != JXL_ENC_SUCCESS) {
        JxlEncoderDestroy(enc); return MakeError(208);
      }
    }

    uint8_t* rgb_pixels = nullptr;
    const uint8_t* encode_src = pixels;
    size_t pixel_size;
    if (!has_alpha) {
      const size_t n_pixels   = static_cast<size_t>(wf.width) * wf.height;
      const size_t src_stride = 4u * bytes_per_channel;
      const size_t dst_stride = 3u * bytes_per_channel;
      pixel_size = n_pixels * dst_stride;
      rgb_pixels = static_cast<uint8_t*>(malloc(pixel_size));
      if (rgb_pixels == nullptr) { JxlEncoderDestroy(enc); return MakeError(209); }
      for (size_t i = 0; i < n_pixels; ++i)
        memcpy(rgb_pixels + i * dst_stride, pixels + i * src_stride, dst_stride);
      encode_src = rgb_pixels;
    } else {
      pixel_size = static_cast<size_t>(wf.width) * wf.height * 4u * bytes_per_channel;
    }

    const JxlEncoderStatus add_status = JxlEncoderAddImageFrame(fs, &pf, encode_src, pixel_size);
    free(rgb_pixels);
    if (add_status != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(210); }
  }

  const JxlBool compress_flag = (box_opts && box_opts->compress_boxes) ? JXL_TRUE : JXL_FALSE;
  if (exif != nullptr && exif_size > 0) {
    if (JxlEncoderAddBox(enc, "Exif", exif, exif_size, compress_flag) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(211);
    }
  }
  if (xmp != nullptr && xmp_size > 0) {
    if (JxlEncoderAddBox(enc, "xml ", xmp, xmp_size, compress_flag) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(212);
    }
  }
  if (AddCustomBoxes(enc, box_opts) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(213);
  }
  JxlEncoderCloseInput(enc);

  size_t out_sz = 0;
  int perr = 0;
  const size_t init_cap = 65536u;
  const size_t max_cap  = 128u * 1024u * 1024u;
  uint8_t* outbuf = PumpEncoderOutput(enc, init_cap, max_cap, &out_sz, &perr);
  if (outbuf == nullptr) return MakeError(perr ? perr : 214);
  JxlWasmBuffer* result = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
  if (result == nullptr) { free(outbuf); return MakeError(215); }
  result->data            = outbuf;
  result->size            = out_sz;
  result->width           = frames[0].width;
  result->height          = frames[0].height;
  result->bits_per_sample = bits;
  result->has_alpha       = has_alpha;
  return result;
}

extern "C" {

void jxl_wasm_bridge_anchor(void) {}

// Forward declaration for transcode used in encode_auto.
JxlWasmBuffer* jxl_wasm_transcode_jpeg_to_jxl(const uint8_t* jpeg, size_t jpeg_size);

// --- Stateful progressive decoder ---

static uint64_t HashProgressiveSample(const uint8_t* data, size_t size) {
  uint64_t h = 1469598103934665603ull;
  const size_t stride = 4096;
  for (size_t i = 0; i < size; i += stride) {
    h ^= data[i];
    h *= 1099511628211ull;
  }
  const size_t tail_start = size > 256 ? size - 256 : 0;
  for (size_t i = tail_start; i < size; ++i) {
    h ^= data[i];
    h *= 1099511628211ull;
  }
  return h ^ static_cast<uint64_t>(size);
}

static bool TryFlushProgressiveImage(JxlWasmDecState* s) {
  if (s == nullptr || s->dec == nullptr || !s->info_known || s->final_ready || s->pixels == nullptr) return false;
  if (s->pixels_size == 0) return false;

  // Don't swap libjxl's output buffer mid-decode. Prior implementation set the buffer to
  // s->flushed, called FlushImage, then restored to s->pixels — that buffer flip-flop
  // corrupted libjxl's internal write tracking, leaving the final FULL_IMAGE write
  // incomplete (most pixels untouched, surfacing as solid-red garbage to the consumer).
  //
  // libjxl writes partial decode INTO whatever buffer was set at NEED_IMAGE_OUT_BUFFER
  // (= s->pixels here, zeroed once on init so unfilled regions are transparent black).
  // FlushImage just commits any pending groups into that buffer. JS immediately copies a
  // borrowed snapshot from s->pixels before the next ProcessInput call. The main s->pixels
  // buffer keeps accumulating groups across subsequent FlushImage + ProcessInput calls,
  // with libjxl free to overwrite earlier-decoded pixels at higher quality per its contract.
  if (JxlDecoderFlushImage(s->dec) != JXL_DEC_SUCCESS) return false;

  // All-zero guard: skip after first successful flush — once real pixels have been emitted
  // the buffer cannot regress to all-zero. Avoids scanning 82+ MB per pass on every flush.
  if (s->flush_count == 0) {
    const uint64_t* w = reinterpret_cast<const uint64_t*>(s->pixels);
    const size_t nwords = s->pixels_size / sizeof(uint64_t);
    bool any_nonzero = false;
    for (size_t i = 0; i < nwords; ++i) {
      if (w[i] != 0) { any_nonzero = true; break; }
    }
    if (!any_nonzero) {
      for (size_t i = nwords * sizeof(uint64_t); i < s->pixels_size; ++i) {
        if (s->pixels[i] != 0) { any_nonzero = true; break; }
      }
    }
    if (!any_nonzero) return false;
  }

  if (s->suppress_duplicate_progress) {
    const uint64_t h = HashProgressiveSample(s->pixels, s->pixels_size);
    if (s->last_progress_hash_valid &&
        s->last_progress_size == s->pixels_size &&
        s->last_progress_hash == h) {
      return false;
    }
    s->last_progress_hash = h;
    s->last_progress_size = s->pixels_size;
    s->last_progress_hash_valid = true;
  }

  s->flushed_size = s->pixels_size;
  s->flushed_ready = true;
  s->flush_count++;
  return true;
}

static JxlWasmDecState* DecCreateInternal(uint32_t format, uint32_t progressive_detail, uint32_t flags) {
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) return nullptr;
  JXL_SETUP_DEC_RUNNER(dec, nullptr);

  int events = JXL_DEC_BASIC_INFO | JXL_DEC_FRAME | JXL_DEC_FULL_IMAGE | JXL_DEC_BOX;
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
  s->suppress_duplicate_progress = (flags & 1u) != 0;
  return s;
}

JxlWasmDecState* jxl_wasm_dec_create(uint32_t format, uint32_t progressive_detail) {
  return DecCreateInternal(format, progressive_detail, 0);
}

JxlWasmDecState* jxl_wasm_dec_create_x(uint32_t format, uint32_t progressive_detail, uint32_t flags) {
  return DecCreateInternal(format, progressive_detail, flags);
}

int jxl_wasm_dec_push(JxlWasmDecState* s, const uint8_t* data, size_t size) {
  if (s == nullptr || s->error_code != 0) return JXL_DEC_RESULT_ERROR;
  if (data != nullptr && size > 0) {
    size_t remaining = 0;
    if (s->input_set) {
      remaining = JxlDecoderReleaseInput(s->dec);
      if (remaining > s->input_size) remaining = 0;
      if (remaining > 0) {
        memmove(s->input_buf, s->input_buf + (s->input_size - remaining), remaining);
      }
      s->input_size = remaining;
      s->input_set = false;
    }

    const size_t needed = s->input_size + size;
    if (needed > s->input_capacity) {
      // Geometric growth eliminates O(n²) memcpy on every append (A1).
      // Track capacity separately; realloc only on overflow, then double.
      size_t new_cap = s->input_capacity ? s->input_capacity : 65536u;
      while (new_cap < needed) {
        size_t next = new_cap * 2;
        if (next <= new_cap) { next = needed; } // overflow guard
        new_cap = next;
      }
      uint8_t* grown = static_cast<uint8_t*>(realloc(s->input_buf, new_cap));
      if (grown == nullptr) { s->error_code = 15; return JXL_DEC_RESULT_ERROR; }
      s->input_buf = grown;
      s->input_capacity = new_cap;
    }
    memcpy(s->input_buf + s->input_size, data, size);
    s->input_size = needed;
    s->input_generation++;
    JxlDecoderSetInput(s->dec, s->input_buf, s->input_size);
    s->input_set = true;
  }

  JxlDecoderStatus status;
  while (true) {
    status = JxlDecoderProcessInput(s->dec);

    if (status == JXL_DEC_NEED_MORE_INPUT) {
      // DONOTCHANGE(progressive-checkpoints): Surface one snapshot per input
      // generation. libjxl may emit only one true FRAME_PROGRESSION event for
      // small/medium images; progressive UI needs this open-stream
      // opportunistic flush path. Removing it collapses Single Progressive back
      // to one non-final stage plus final.
      // Keep the generation gate so callers cannot drain the same snapshot forever.
      if (s->frame_started && !s->final_ready &&
          s->opportunistic_flush_generation != s->input_generation &&
          TryFlushProgressiveImage(s)) {
        s->opportunistic_flush_generation = s->input_generation;
        return JXL_DEC_RESULT_PROGRESS;
      }
      if (s->input_closed) {
        s->error_code = static_cast<int>(status);
        return JXL_DEC_RESULT_ERROR;
      }
      return JXL_DEC_RESULT_NEED_MORE;
    }
    if (status == JXL_DEC_SUCCESS) {
      s->final_ready = true;
      // Finalize gain map if a jhgm box was being read
      if (s->gm_reading && s->gm_buf != nullptr) {
        size_t remaining = JxlDecoderReleaseBoxBuffer(s->dec);
        s->gm_size = s->gm_capacity - remaining;
        s->gm_reading = false;
#if JXL_GAIN_MAP_SUPPORTED
        if (s->gm_size > 0) {
          JxlGainMapBundle bundle = {};
          size_t bytes_read = 0;
          if (JxlGainMapReadBundle(&bundle, s->gm_buf, s->gm_size, &bytes_read) == JXL_TRUE
              && bundle.gain_map != nullptr && bundle.gain_map_size > 0) {
            uint8_t* jxl = static_cast<uint8_t*>(malloc(bundle.gain_map_size));
            if (jxl != nullptr) {
              memcpy(jxl, bundle.gain_map, bundle.gain_map_size);
              s->gain_map_jxl      = jxl;
              s->gain_map_jxl_size = bundle.gain_map_size;
              s->gain_map_ready    = true;
            }
          }
        }
#endif
        free(s->gm_buf);
        s->gm_buf      = nullptr;
        s->gm_capacity = 0;
        s->gm_size     = 0;
      }
      // 1.7: input_buf is dead weight after full decode (tens of MB). Free early;
      // dec_free will see null. Safe: no code path re-reads input after DONE.
      free(s->input_buf);
      s->input_buf = nullptr;
      s->input_size = 0;
      s->input_capacity = 0;
      s->input_set = false;
      return JXL_DEC_RESULT_DONE;
    }
    if (status == JXL_DEC_ERROR) { s->error_code = static_cast<int>(status); return JXL_DEC_RESULT_ERROR; }

    if (status == JXL_DEC_FRAME) {
      s->frame_started = true;
      JxlFrameHeader frame_header;
      memset(&frame_header, 0, sizeof(frame_header));
      if (JxlDecoderGetFrameHeader(s->dec, &frame_header) == JXL_DEC_SUCCESS) {
        s->frame_duration = frame_header.duration;
        s->is_last_frame  = frame_header.is_last ? 1u : 0u;
        s->frame_name[0]  = '\0';
        char name_buf[256];
        if (JxlDecoderGetFrameName(s->dec, name_buf, sizeof(name_buf)) == JXL_DEC_SUCCESS) {
          strncpy(s->frame_name, name_buf, sizeof(s->frame_name) - 1);
          s->frame_name[sizeof(s->frame_name) - 1] = '\0';
        }
      }
      continue;
    }
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
        if (s->info.have_animation) {
          s->anim_ticks_per_second = s->info.animation.tps_denominator > 0
            ? (double)s->info.animation.tps_numerator / s->info.animation.tps_denominator
            : (double)s->info.animation.tps_numerator;
          s->anim_loop_count       = s->info.animation.num_loops;
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
      // Zero only on the first frame (frame_index==0). This buffer is (re)established
      // before any writes for that image. For frame 0 (still images, first anim frame,
      // and all truncated-stream progressive cases) this guarantees transparent black
      // for unfilled groups in opportunistic snapshots — the red-garbage regression
      // case. For animation frames >0 we intentionally leave prior frame pixels as
      // background; libjxl will overwrite by FULL_IMAGE and partial progressive
      // checkpoints for later frames benefit from not flashing to black.
      // The zero is still unconditional for frame 0 even on growth reallocs.
      if (s->frame_index == 0) {
        memset(s->pixels, 0, s->pixels_size);
      }
      if (JxlDecoderSetImageOutBuffer(s->dec, &s->pixel_format, s->pixels, s->pixels_size) != JXL_DEC_SUCCESS) {
        s->error_code = 12; return JXL_DEC_RESULT_ERROR;
      }
      continue;
    }
    if (status == JXL_DEC_FRAME_PROGRESSION) {
      if (TryFlushProgressiveImage(s)) return JXL_DEC_RESULT_PROGRESS;
      continue;
    }
    if (status == JXL_DEC_FULL_IMAGE) {
      s->final_ready = true;
      s->frame_index++;
      if (s->info.have_animation && !s->is_last_frame) return JXL_DEC_RESULT_FRAME_DONE;
      continue;
    }
    if (status == JXL_DEC_BOX) {
      // Finalize any previously-read jhgm box
      if (s->gm_reading && s->gm_buf != nullptr) {
        size_t remaining = JxlDecoderReleaseBoxBuffer(s->dec);
        s->gm_size = s->gm_capacity - remaining;
        s->gm_reading = false;
#if JXL_GAIN_MAP_SUPPORTED
        if (s->gm_size > 0 && !s->gain_map_ready) {
          JxlGainMapBundle bundle = {};
          size_t bytes_read = 0;
          if (JxlGainMapReadBundle(&bundle, s->gm_buf, s->gm_size, &bytes_read) == JXL_TRUE
              && bundle.gain_map != nullptr && bundle.gain_map_size > 0) {
            uint8_t* jxl = static_cast<uint8_t*>(malloc(bundle.gain_map_size));
            if (jxl != nullptr) {
              memcpy(jxl, bundle.gain_map, bundle.gain_map_size);
              s->gain_map_jxl      = jxl;
              s->gain_map_jxl_size = bundle.gain_map_size;
              s->gain_map_ready    = true;
            }
          }
        }
#endif
        free(s->gm_buf);
        s->gm_buf      = nullptr;
        s->gm_capacity = 0;
        s->gm_size     = 0;
      }
      // Start reading a new jhgm box if not yet captured
      if (!s->gain_map_ready) {
        JxlBoxType box_type = {};
        if (JxlDecoderGetBoxType(s->dec, box_type, JXL_FALSE) == JXL_DEC_SUCCESS
            && memcmp(box_type, "jhgm", 4) == 0) {
          const size_t initial = 65536;
          uint8_t* buf = static_cast<uint8_t*>(malloc(initial));
          if (buf != nullptr) {
            s->gm_buf      = buf;
            s->gm_capacity = initial;
            s->gm_size     = 0;
            s->gm_reading  = true;
            JxlDecoderSetBoxBuffer(s->dec, s->gm_buf, s->gm_capacity);
          }
        }
      }
      continue;
    }
    if (status == JXL_DEC_BOX_NEED_MORE_OUTPUT) {
      if (!s->gm_reading || s->gm_buf == nullptr) { continue; }
      size_t remaining = JxlDecoderReleaseBoxBuffer(s->dec);
      const size_t written = s->gm_capacity - remaining;
      const size_t new_cap = s->gm_capacity * 2u;
      uint8_t* grown = static_cast<uint8_t*>(realloc(s->gm_buf, new_cap));
      if (grown == nullptr) {
        free(s->gm_buf);
        s->gm_buf = nullptr; s->gm_capacity = 0; s->gm_size = 0; s->gm_reading = false;
      } else {
        s->gm_buf      = grown;
        s->gm_capacity = new_cap;
        s->gm_size     = written;
        JxlDecoderSetBoxBuffer(s->dec, s->gm_buf + written, new_cap - written);
      }
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

// Progress returns a borrowed pixels handle; final transfers pixel ownership.
JxlWasmBuffer* jxl_wasm_dec_take_flushed(JxlWasmDecState* s) {
  if (s == nullptr || !s->flushed_ready || !s->info_known || s->pixels == nullptr) return nullptr;
  s->flushed_ready = false;
  const uint32_t bits = (s->pixel_format.data_type == JXL_TYPE_UINT16) ? 16u : (s->pixel_format.data_type == JXL_TYPE_FLOAT) ? 32u : 8u;
  JxlWasmBuffer* buf = MakeBufferBorrowed(s->pixels, s->flushed_size, s->info.xsize, s->info.ysize, bits, 1);
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
  free(s->pixels);       // no-op if ownership was transferred via dec_take_final
  free(s->input_buf);
  free(s->gm_buf);       // no-op if box was fully consumed or never started
  free(s->gain_map_jxl); // no-op if ownership was transferred via dec_take_gain_map
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
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order, uint32_t resampling) {
  return EncodeRgba(pixels, width, height, distance, effort, 0, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, -1, -1, -1, 0, resampling);
}
JxlWasmBuffer* jxl_wasm_encode_rgba16(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order, uint32_t resampling) {
  return EncodeRgba(pixels, width, height, distance, effort, 1, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, -1, -1, -1, 0, resampling);
}
JxlWasmBuffer* jxl_wasm_encode_rgbaf32(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order, uint32_t resampling) {
  return EncodeRgba(pixels, width, height, distance, effort, 2, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, -1, -1, -1, 0, resampling);
}

JxlWasmBuffer* jxl_wasm_encode_rgba8_x(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling) {
  return EncodeRgba(pixels, width, height, distance, effort, 0, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling);
}
JxlWasmBuffer* jxl_wasm_encode_rgba16_x(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling) {
  return EncodeRgba(pixels, width, height, distance, effort, 1, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling);
}
JxlWasmBuffer* jxl_wasm_encode_rgbaf32_x(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling) {
  return EncodeRgba(pixels, width, height, distance, effort, 2, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling);
}

// fmt: 0=rgba8, 1=rgba16, 2=rgbaf32.  Matches the TypeScript facade type.
// Previously this function had no fmt param and hardcoded 0, which also
// shifted every subsequent argument by one slot in the WASM call frame.
JxlWasmBuffer* jxl_wasm_encode_rgba8_with_metadata(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size, const uint8_t* exif, size_t exif_size, const uint8_t* xmp, size_t xmp_size) {
  return EncodeRgbaWithMetadata(pixels, width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, -1, -1, -1, 0, resampling, icc_profile, icc_size, exif, exif_size, xmp, xmp_size);
}

JxlWasmBuffer* jxl_wasm_encode_rgba8_with_metadata_x(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size, const uint8_t* exif, size_t exif_size, const uint8_t* xmp, size_t xmp_size) {
  return EncodeRgbaWithMetadata(pixels, width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling, icc_profile, icc_size, exif, exif_size, xmp, xmp_size);
}

// Extra-channel encode: per-channel distance + optional separate plane buffers.
// ec_ptr: WASM heap address of WasmExtraChannel[num_ec] (0 when num_ec == 0).
// alpha_distance < 0 -> libjxl default for alpha; ignored when has_alpha == 0.
JxlWasmBuffer* jxl_wasm_encode_rgba8_with_metadata_ec(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed,
    int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    float alpha_distance,
    const WasmExtraChannel* ec_ptr, uint32_t num_ec,
    int32_t ec_resampling) {
  const WasmExtraChannel* ec = (ec_ptr != nullptr && num_ec > 0u) ? ec_ptr : nullptr;
  const uint32_t n_ec = (ec != nullptr) ? num_ec : 0u;
  return EncodeRgbaWithExtraChannels(pixels, width, height, distance, effort, fmt, has_alpha,
      progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order,
      modular, brotli_effort, decoding_speed, photon_noise_iso, resampling,
      icc_profile, icc_size, exif, exif_size, xmp, xmp_size,
      alpha_distance, ec, n_ec, nullptr, 1u, ec_resampling);
}

// --- Box-options v2 encode ---
// Extends _x / _ec with WasmBoxOpts for container control, box compression, and custom boxes.
// box_opts: WASM heap ptr to WasmBoxOpts (nullptr = default behaviour).

JxlWasmBuffer* jxl_wasm_encode_rgba8_with_metadata_v2(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    const WasmBoxOpts* box_opts) {
  return EncodeRgbaWithMetadata(pixels, width, height, distance, effort, fmt, has_alpha,
      progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order,
      modular, brotli_effort, decoding_speed, photon_noise_iso, resampling,
      icc_profile, icc_size, exif, exif_size, xmp, xmp_size, box_opts);
}

// v3: v2 + EXIF orientation (1..8). Pixels stay sensor-native; rotation lives in JXL basic info.
JxlWasmBuffer* jxl_wasm_encode_rgba8_with_metadata_v3(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    const WasmBoxOpts* box_opts,
    uint32_t orientation) {
  return EncodeRgbaWithMetadata(pixels, width, height, distance, effort, fmt, has_alpha,
      progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order,
      modular, brotli_effort, decoding_speed, photon_noise_iso, resampling,
      icc_profile, icc_size, exif, exif_size, xmp, xmp_size, box_opts,
      -1, -1, -1, -1, orientation);
}

JxlWasmBuffer* jxl_wasm_encode_rgba8_with_metadata_ec_v2(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed,
    int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    float alpha_distance,
    const WasmExtraChannel* ec_ptr, uint32_t num_ec,
    const WasmBoxOpts* box_opts,
    int32_t ec_resampling) {
  const WasmExtraChannel* ec = (ec_ptr != nullptr && num_ec > 0u) ? ec_ptr : nullptr;
  const uint32_t n_ec = (ec != nullptr) ? num_ec : 0u;
  return EncodeRgbaWithExtraChannels(pixels, width, height, distance, effort, fmt, has_alpha,
      progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order,
      modular, brotli_effort, decoding_speed, photon_noise_iso, resampling,
      icc_profile, icc_size, exif, exif_size, xmp, xmp_size,
      alpha_distance, ec, n_ec, box_opts, 1u, ec_resampling);
}

// Gain map encode: same as _with_metadata_x but attaches a jhgm box (JXL gain map).
// gain_map_jxl: pre-encoded JXL codestream (the gain map image); 0 → no box added.
// When JXL_GAIN_MAP_SUPPORTED is 0 (old libjxl), encodes normally without the box.
JxlWasmBuffer* jxl_wasm_encode_with_gain_map(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    const uint8_t* gain_map_jxl, size_t gain_map_jxl_size) {
  return EncodeRgbaWithGainMap(pixels, width, height, distance, effort, fmt, has_alpha,
      progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order,
      modular, brotli_effort, decoding_speed, photon_noise_iso, resampling,
      icc_profile, icc_size, exif, exif_size, xmp, xmp_size,
      gain_map_jxl, gain_map_jxl_size);
}

JxlWasmBuffer* jxl_wasm_encode_animation(
    uint32_t frames_ptr, uint32_t num_frames,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    uint32_t icc_ptr, uint32_t icc_size,
    uint32_t exif_ptr, uint32_t exif_size,
    uint32_t xmp_ptr, uint32_t xmp_size,
    uint32_t box_opts_ptr,
    uint32_t anim_opts_ptr) {
  const WasmAnimationFrame* frames = reinterpret_cast<const WasmAnimationFrame*>(static_cast<uintptr_t>(frames_ptr));
  const uint8_t* icc  = icc_ptr  ? reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(icc_ptr))  : nullptr;
  const uint8_t* exif = exif_ptr ? reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(exif_ptr)) : nullptr;
  const uint8_t* xmp  = xmp_ptr  ? reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(xmp_ptr))  : nullptr;
  const WasmBoxOpts*       box_opts  = box_opts_ptr  ? reinterpret_cast<const WasmBoxOpts*>      (static_cast<uintptr_t>(box_opts_ptr))  : nullptr;
  const WasmAnimationOpts* anim_opts = anim_opts_ptr ? reinterpret_cast<const WasmAnimationOpts*>(static_cast<uintptr_t>(anim_opts_ptr)) : nullptr;
  return EncodeAnimation(frames, num_frames, distance, effort, fmt, has_alpha,
      modular, brotli_effort, decoding_speed, photon_noise_iso, resampling,
      icc, icc_size, exif, exif_size, xmp, xmp_size,
      box_opts, anim_opts);
}

uint32_t jxl_wasm_dec_has_gain_map(const JxlWasmDecState* s) {
  return (s != nullptr && s->gain_map_ready) ? 1u : 0u;
}

// Ownership-transfer: returns a JxlWasmBuffer whose data/size fields hold the raw
// jhgm codestream bytes. Caller must free via jxl_wasm_buffer_free. Returns null
// when no gain map was decoded.
JxlWasmBuffer* jxl_wasm_dec_take_gain_map(JxlWasmDecState* s) {
  if (s == nullptr || !s->gain_map_ready || s->gain_map_jxl == nullptr) return nullptr;
  s->gain_map_ready = false;
  JxlWasmBuffer* buf = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
  if (buf == nullptr) {
    free(s->gain_map_jxl);
    s->gain_map_jxl      = nullptr;
    s->gain_map_jxl_size = 0;
    return nullptr;
  }
  buf->data = s->gain_map_jxl;
  buf->size = s->gain_map_jxl_size;
  s->gain_map_jxl      = nullptr;
  s->gain_map_jxl_size = 0;
  return buf;
}

uint32_t jxl_wasm_dec_frame_index(uint32_t state_ptr) {
  const JxlWasmDecState* s = reinterpret_cast<const JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  // frame_index is incremented on JXL_DEC_FULL_IMAGE (post-completion); subtract 1 for zero-based result.
  return s && s->frame_index > 0u ? s->frame_index - 1u : 0u;
}

uint32_t jxl_wasm_dec_frame_duration(uint32_t state_ptr) {
  const JxlWasmDecState* s = reinterpret_cast<const JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  return s ? s->frame_duration : 0u;
}

uint32_t jxl_wasm_dec_frame_name_ptr(uint32_t state_ptr) {
  const JxlWasmDecState* s = reinterpret_cast<const JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  if (s == nullptr || s->frame_name[0] == '\0') return 0u;
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(s->frame_name));
}

uint32_t jxl_wasm_dec_is_last_frame(uint32_t state_ptr) {
  const JxlWasmDecState* s = reinterpret_cast<const JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  return s ? s->is_last_frame : 0u;
}

double jxl_wasm_dec_anim_ticks_per_second(uint32_t state_ptr) {
  const JxlWasmDecState* s = reinterpret_cast<const JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  return s ? s->anim_ticks_per_second : 1000.0;
}

uint32_t jxl_wasm_dec_anim_loop_count(uint32_t state_ptr) {
  const JxlWasmDecState* s = reinterpret_cast<const JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  return s ? s->anim_loop_count : 0u;
}

// Forward-only seek: skip frames to reach target_frame (zero-based, as exposed by jxl_wasm_dec_frame_index).
// Returns 0 on success, -1 if target is at or before the current position (cannot seek backward).
int32_t jxl_wasm_dec_seek_to_frame(uint32_t state_ptr, uint32_t target_frame) {
  JxlWasmDecState* s = reinterpret_cast<JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  if (s == nullptr) return -1;
  // s->frame_index is post-increment (count of fully decoded frames); target_frame is zero-based.
  // target_frame < s->frame_index means we are already past it; == means it is the next to decode.
  if (target_frame < s->frame_index) return -1;
  uint32_t skip = target_frame - s->frame_index;
  if (skip == 0) return 0;
  JxlDecoderSkipFrames(s->dec, static_cast<size_t>(skip));
  return 0;
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
  return EncodeRgba(data, width, height, distance, effort, fmt, has_alpha, 0, 0, 0, 0, 0);
}

JxlWasmBuffer* jxl_wasm_encode_auto_x(
    const uint8_t* data, size_t data_size,
    uint32_t width, uint32_t height,
    float distance, uint32_t effort,
    uint32_t fmt, uint32_t has_alpha,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling) {
  if (data == nullptr || data_size == 0) return MakeError(50);
  if (LooksLikeJpeg(data, data_size)) {
    return jxl_wasm_transcode_jpeg_to_jxl(data, data_size);
  }
  return EncodeRgba(data, width, height, distance, effort, fmt, has_alpha, 0, 0, 0, 0, 0, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling);
}

// Encode full image + N sidecar thumbnails in one call.
// Returns a `->next` linked list: sidecars smallest-first, full image last.
// sidecar_max_dims must be sorted ascending by the caller (JS does this).
// Caller walks and frees each node individually via jxl_wasm_buffer_free.
//
// Cascade: each thumbnail is derived from the next-larger thumbnail rather than
// the full image, so total downscale work scales with the number of output pixels
// rather than (num_sidecars × full-image pixels).
static JxlWasmBuffer* EncodeRgba8WithSidecars(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t has_alpha,
    const uint32_t* sidecar_max_dims, uint32_t num_sidecars,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling) {
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
        std::max(distance, 1.5f), std::min(effort, 5u), 0, 1u, 0, 0, 0, 0, 0,
        modular, brotli_effort, decoding_speed, photon_noise_iso);
    if (sidecar == nullptr || sidecar->error != 0) continue;  // aux sidecar tier failed (OOM or encode err); skip, do not link, do not fail container encode. Cascade already safe (no wild next ptrs).

    // Prepend: descending iteration + prepend = ascending chain.
    sidecar->next = sc_chain;
    sc_chain = sidecar;
  }
  free(cascade_owned);

  JxlWasmBuffer* full = EncodeRgba(pixels, width, height, distance, effort, 0, has_alpha, 0, 0, 0, 0, 0,
      modular, brotli_effort, decoding_speed, photon_noise_iso, resampling);
  if (full == nullptr || full->error != 0) {
    JxlWasmBuffer* cur = sc_chain;
    while (cur != nullptr) { JxlWasmBuffer* nxt = cur->next; FreeBufferNoChain(cur); cur = nxt; }
    if (full) FreeBufferNoChain(full);
    return MakeError(full && full->error ? full->error : 28);
  }
  if (sc_chain == nullptr) return full;

  // Walk sidecar chain to tail and append full image.
  JxlWasmBuffer* tail = sc_chain;
  while (tail->next != nullptr) tail = tail->next;
  tail->next = full;
  return sc_chain;
}

JxlWasmBuffer* jxl_wasm_encode_rgba8_with_sidecars(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t has_alpha,
    const uint32_t* sidecar_max_dims, uint32_t num_sidecars, uint32_t resampling) {
  return EncodeRgba8WithSidecars(pixels, width, height, distance, effort, has_alpha, sidecar_max_dims, num_sidecars, -1, -1, -1, 0, resampling);
}

JxlWasmBuffer* jxl_wasm_encode_rgba8_with_sidecars_x(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t has_alpha,
    const uint32_t* sidecar_max_dims, uint32_t num_sidecars,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling) {
  return EncodeRgba8WithSidecars(pixels, width, height, distance, effort, has_alpha, sidecar_max_dims, num_sidecars, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling);
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

// A6: runtime word-size query for TS load assert (defensive; static_assert above is primary).
uint32_t jxl_wasm_pointer_size(void) {
  return sizeof(void*);
}

void jxl_wasm_buffer_free(JxlWasmBuffer* buffer) {
  if (buffer == nullptr) return;
  // Inline data (MakeBuffer): lives in the same allocation — free once.
  // External data (MakeBufferFromOwned / encoder no-copy): separate allocation — free both.
  // Does NOT recurse through ->next; caller walks and frees the sidecar chain individually.
  if (buffer->owned_data && buffer->data != nullptr && buffer->data != reinterpret_cast<uint8_t*>(buffer + 1)) {
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
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order, uint32_t resampling) {
  if (s == nullptr) return -1;
  if (s->error_code != 0) return s->error_code;
  JxlWasmBuffer* buf = EncodeRgba(pixels, width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, -1, -1, -1, 0, resampling);
  if (buf == nullptr) { s->error_code = 25; return s->error_code; }
  if (buf->error != 0) { int ec = buf->error; FreeBufferNoChain(buf); s->error_code = ec; return ec; }
  // EncodeRgba always uses a separate outbuf (not inline) — steal the pointer.
  s->outbuf      = buf->data;
  s->outbuf_size = buf->size;
  buf->data = nullptr;  // prevent FreeBufferNoChain double-free
  FreeBufferNoChain(buf);
  return 0;
}

int jxl_wasm_enc_push_pixels_x(JxlWasmEncState* s,
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling) {
  if (s == nullptr) return -1;
  if (s->error_code != 0) return s->error_code;
  JxlWasmBuffer* buf = EncodeRgba(pixels, width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling);
  if (buf == nullptr) { s->error_code = 25; return s->error_code; }
  if (buf->error != 0) { int ec = buf->error; FreeBufferNoChain(buf); s->error_code = ec; return ec; }
  s->outbuf      = buf->data;
  s->outbuf_size = buf->size;
  buf->data = nullptr;
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
  // MakeBufferBorrowed: zero-copy handle into live outbuf (eliminates per-chunk C++ memcpy / performance-1).
  // JS takeBuffer + HEAPU8.slice materializes the owned copy for the yielded chunk.
  // outbuf must stay alive for all borrows; enc_free (after chunks() drain) does the free.
  JxlWasmBuffer* chunk = MakeBufferBorrowed(s->outbuf + s->taken, take, 0, 0, 8, 0);
  if (chunk != nullptr) {
    s->taken += take;
    // No early free / null here. Borrowed views into outbuf remain valid only while
    // the allocation lives; enc_free (post-drain in JS chunks() finally) releases it.
  }
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
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order, uint32_t resampling) {
  if (width == 0 || height == 0) return nullptr;
  const size_t bpc        = (fmt == 2u) ? 4u : (fmt == 1u) ? 2u : 1u;
  const size_t channels   = (fmt == 3u) ? 3u : 4u;  // A3: rgb8 has no alpha plane
  const size_t pixel_size = static_cast<size_t>(width) * height * channels * bpc;

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
  s->enc_group_order = group_order;
  s->enc_modular = -1;
  s->enc_brotli_effort = -1;
  s->enc_decoding_speed = -1;
  s->enc_photon_noise_iso = 0;
  s->enc_resampling = NormalizeResampling(resampling);
  s->enc_ec_resampling = -1;
  s->enc_epf = -1;
  s->enc_gaborish = -1;
  s->enc_dots = -1;
  s->enc_color_transform = -1;
  s->enc_intrinsic_width = 0u;
  s->enc_intrinsic_height = 0u;
  s->enc_disable_perceptual = -1;
  s->enc_codestream_level = -1;
  s->enc_premultiply_alpha = -1;
  s->enc_orientation = 1u;
  return s;
}

JxlWasmEncState* jxl_wasm_enc_create_image_x(
    uint32_t width, uint32_t height,
    float distance, uint32_t effort,
    uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    int32_t jpeg_keep_exif, int32_t jpeg_keep_xmp, int32_t jpeg_keep_jumbf,
    int32_t already_downsampled, int32_t upsampling_mode, int32_t ec_resampling) {
  JxlWasmEncState* s = jxl_wasm_enc_create_image(width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, resampling);
  if (s != nullptr) {
    (void)jpeg_keep_exif; (void)jpeg_keep_xmp; (void)jpeg_keep_jumbf; (void)already_downsampled; (void)upsampling_mode;
    s->enc_modular = modular;
    s->enc_brotli_effort = brotli_effort;
    s->enc_decoding_speed = decoding_speed;
    s->enc_photon_noise_iso = photon_noise_iso;
    s->enc_ec_resampling = NormalizeOptionalResampling(ec_resampling);
  }
  return s;
}

JxlWasmEncState* jxl_wasm_enc_create_image_y(
    uint32_t width, uint32_t height,
    float distance, uint32_t effort,
    uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    int32_t epf, int32_t gaborish, int32_t dots, int32_t patches, int32_t color_transform,
    int32_t center_x, int32_t center_y,
    int32_t jpeg_keep_exif, int32_t jpeg_keep_xmp, int32_t jpeg_keep_jumbf,
    int32_t already_downsampled, int32_t upsampling_mode, int32_t ec_resampling) {
  (void)patches; (void)center_x; (void)center_y;
  JxlWasmEncState* s = jxl_wasm_enc_create_image_x(width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling, jpeg_keep_exif, jpeg_keep_xmp, jpeg_keep_jumbf, already_downsampled, upsampling_mode, ec_resampling);
  if (s != nullptr) {
    s->enc_epf = epf;
    s->enc_gaborish = gaborish;
    s->enc_dots = dots;
    s->enc_color_transform = color_transform;
  }
  return s;
}

// _z variant: same as _y plus orientation (1..8, EXIF semantics). When >1, JXL
// records the rotation in basic info and pixels stay sensor-native — no CPU rotate.
JxlWasmEncState* jxl_wasm_enc_create_image_z(
    uint32_t width, uint32_t height,
    float distance, uint32_t effort,
    uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    int32_t epf, int32_t gaborish, int32_t dots, int32_t patches, int32_t color_transform,
    uint32_t orientation,
    int32_t center_x, int32_t center_y,
    int32_t jpeg_keep_exif, int32_t jpeg_keep_xmp, int32_t jpeg_keep_jumbf,
    int32_t already_downsampled, int32_t upsampling_mode, int32_t ec_resampling) {
  JxlWasmEncState* s = jxl_wasm_enc_create_image_y(width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling, epf, gaborish, dots, patches, color_transform, center_x, center_y, jpeg_keep_exif, jpeg_keep_xmp, jpeg_keep_jumbf, already_downsampled, upsampling_mode, ec_resampling);
  if (s != nullptr) {
    s->enc_orientation = (orientation >= 1u && orientation <= 8u) ? orientation : 1u;
  }
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

  // B3: use metadata path when ICC/EXIF/XMP were set via jxl_wasm_enc_set_metadata,
  // eliminating the buffered-encode malloc+copy that was forced when metadata was present.
  JxlWasmBuffer* buf = EncodeRgbaWithMetadata(
      s->pixels_buf, s->enc_width, s->enc_height,
      s->enc_distance, s->enc_effort, s->enc_fmt, s->enc_has_alpha,
      s->enc_progressive_dc, s->enc_progressive_ac, s->enc_qprogressive_ac, s->enc_buffering, s->enc_group_order,
      s->enc_modular, s->enc_brotli_effort, s->enc_decoding_speed, s->enc_photon_noise_iso, s->enc_resampling,
      s->enc_icc, s->enc_icc_size, s->enc_exif, s->enc_exif_size, s->enc_xmp, s->enc_xmp_size,
      nullptr, s->enc_epf, s->enc_gaborish, s->enc_dots, s->enc_color_transform,
      s->enc_orientation,
      s->enc_intrinsic_width, s->enc_intrinsic_height,
      s->enc_disable_perceptual,
      s->enc_codestream_level,
      s->enc_premultiply_alpha,
      s->enc_ec_resampling);

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
  free(s->enc_icc);
  free(s->enc_exif);
  free(s->enc_xmp);
  free(s);
}

// B3: Store ICC/EXIF/XMP for the streaming-input path. Must be called before enc_finish.
// Copies the data into WASM-owned buffers so JS can release its copies immediately.
// Returns 0 on success, -1 on malloc failure.
int jxl_wasm_enc_set_metadata(JxlWasmEncState* s,
    const uint8_t* icc, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size) {
  if (s == nullptr) return -1;
  free(s->enc_icc);  s->enc_icc = nullptr;  s->enc_icc_size = 0;
  free(s->enc_exif); s->enc_exif = nullptr; s->enc_exif_size = 0;
  free(s->enc_xmp);  s->enc_xmp = nullptr;  s->enc_xmp_size = 0;
  if (icc != nullptr && icc_size > 0) {
    s->enc_icc = static_cast<uint8_t*>(malloc(icc_size));
    if (s->enc_icc == nullptr) return -1;
    memcpy(s->enc_icc, icc, icc_size);
    s->enc_icc_size = icc_size;
  }
  if (exif != nullptr && exif_size > 0) {
    s->enc_exif = static_cast<uint8_t*>(malloc(exif_size));
    if (s->enc_exif == nullptr) return -1;
    memcpy(s->enc_exif, exif, exif_size);
    s->enc_exif_size = exif_size;
  }
  if (xmp != nullptr && xmp_size > 0) {
    s->enc_xmp = static_cast<uint8_t*>(malloc(xmp_size));
    if (s->enc_xmp == nullptr) return -1;
    memcpy(s->enc_xmp, xmp, xmp_size);
    s->enc_xmp_size = xmp_size;
  }
  return 0;
}

// CasaSneyers_Parity (Ch3): intrinsic_size setter — call before enc_finish.
// Sets the JXL display dimensions independently from the encoded pixel dimensions.
// w=0 or h=0 clears the override (no intrinsic_size in the output codestream).
void jxl_wasm_enc_set_intrinsic_size(JxlWasmEncState* s, uint32_t w, uint32_t h) {
  if (s == nullptr) return;
  s->enc_intrinsic_width  = w;
  s->enc_intrinsic_height = h;
}

// CasaSneyers_Parity (ID 39): frame flags setter — call before enc_finish.
// disable_perceptual=1 bypasses the butteraugli/XYB psychovisual model for fair benchmarking.
// disable_perceptual=0 or -1 restores default perceptual optimization.
void jxl_wasm_enc_set_frame_flags(JxlWasmEncState* s, int32_t disable_perceptual) {
  if (s == nullptr) return;
  s->enc_disable_perceptual = disable_perceptual;
}

// Force codestream level for workflows that need Level 10 (e.g. black/CMYK EC).
// level=-1/other leaves libjxl automatic; accepted explicit levels are 5 and 10.
void jxl_wasm_enc_set_codestream_level(JxlWasmEncState* s, int32_t level) {
  if (s == nullptr) return;
  s->enc_codestream_level = (level == 5 || level == 10) ? level : -1;
}

// Force alpha association signaling for the main alpha channel.
// This does not rewrite pixel values; callers must provide data matching the signal.
void jxl_wasm_enc_set_alpha_premultiply(JxlWasmEncState* s, int32_t premultiply) {
  if (s == nullptr) return;
  s->enc_premultiply_alpha = premultiply > 0 ? 1 : 0;
}

// --- #15: Lossless JPEG → JXL transcode ---

JxlWasmBuffer* jxl_wasm_transcode_jpeg_to_jxl(const uint8_t* jpeg, size_t jpeg_size) {
  if (jpeg == nullptr || jpeg_size == 0) return MakeError(40);

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return MakeError(41);
  JXL_SETUP_ENC_RUNNER(enc, MakeError(57));

  if (JxlEncoderStoreJPEGMetadata(enc, JXL_TRUE) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(42);
  }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  if (frame == nullptr) { JxlEncoderDestroy(enc); return MakeError(43); }

  if (JxlEncoderAddJPEGFrame(frame, jpeg, jpeg_size) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(44);
  }
  JxlEncoderCloseInput(enc);

  size_t out_sz = 0;
  int perr = 0;
  const size_t init_cap = std::max(size_t(65536), jpeg_size / 2);
  uint8_t* outbuf = PumpEncoderOutput(enc, init_cap, 0, &out_sz, &perr);
  if (outbuf == nullptr) return MakeError(perr ? perr : 45);
  JxlWasmBuffer* result = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
  if (result == nullptr) { free(outbuf); return MakeError(46); }
  result->data = outbuf;
  result->size = out_sz;
  return result;
}

// --- #15b: JPEG → JXL transcode with additional metadata boxes ---
// Adds EXIF/XMP injection, custom boxes, container control, and box compression on top of
// the lossless JPEG transcode. JPEG reconstruction box is implicit via JxlEncoderAddJPEGFrame.
JxlWasmBuffer* jxl_wasm_transcode_jpeg_to_jxl_v2(
    const uint8_t* jpeg, size_t jpeg_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    const WasmBoxOpts* box_opts) {
  if (jpeg == nullptr || jpeg_size == 0) return MakeError(40);

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return MakeError(41);
  JXL_SETUP_ENC_RUNNER(enc, MakeError(57));

  if (JxlEncoderStoreJPEGMetadata(enc, JXL_TRUE) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(42);
  }
  if (ApplyContainerMode(enc, box_opts) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(160);
  }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  if (frame == nullptr) { JxlEncoderDestroy(enc); return MakeError(43); }

  if (JxlEncoderAddJPEGFrame(frame, jpeg, jpeg_size) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(44);
  }

  const JxlBool compress_flag = (box_opts && box_opts->compress_boxes) ? JXL_TRUE : JXL_FALSE;
  if (exif != nullptr && exif_size > 0) {
    if (JxlEncoderAddBox(enc, "Exif", exif, exif_size, compress_flag) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(161);
    }
  }
  if (xmp != nullptr && xmp_size > 0) {
    if (JxlEncoderAddBox(enc, "xml ", xmp, xmp_size, compress_flag) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(162);
    }
  }
  if (AddCustomBoxes(enc, box_opts) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(163);
  }

  JxlEncoderCloseInput(enc);

  size_t out_sz = 0;
  int perr = 0;
  const size_t init_cap = std::max(size_t(65536), jpeg_size / 2);
  uint8_t* outbuf = PumpEncoderOutput(enc, init_cap, 0, &out_sz, &perr);
  if (outbuf == nullptr) return MakeError(perr ? perr : 45);
  JxlWasmBuffer* result = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
  if (result == nullptr) { free(outbuf); return MakeError(46); }
  result->data = outbuf;
  result->size = out_sz;
  return result;
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
// Encode: jxl_wasm_encode_tile_container_rgba8(pixels, w, h, tile_size, distance, effort, has_alpha)
// Decode: jxl_wasm_decode_tile_container_region_rgba8(bytes, size, rx, ry, rw, rh)
JxlWasmBuffer* jxl_wasm_encode_tile_container_rgba8(const uint8_t* pixels,
    uint32_t width, uint32_t height, uint32_t tile_size,
    float distance, uint32_t effort, uint32_t has_alpha) {
  return EncodeRgba8TileContainer(pixels, width, height, tile_size, distance, effort, has_alpha);
}

JxlWasmBuffer* jxl_wasm_decode_tile_container_region_rgba8(const uint8_t* input, size_t input_size,
    uint32_t region_x, uint32_t region_y, uint32_t region_w, uint32_t region_h) {
  return DecodeRgba8TileContainerRegion(input, input_size, region_x, region_y, region_w, region_h);
}

// 256-entry sRGB->linear LUT (gamma 2.2 approx) for Butteraugli input.
// 8-bit source only; built once, zero accuracy change vs per-pixel pow.
static const float* SrgbToLinearLut() {
  static float lut[256];
  static bool init = false;
  if (!init) {
    for (int i = 0; i < 256; ++i) {
      lut[i] = std::pow(i * (1.0f / 255.0f), 2.2f);
    }
    init = true;
  }
  return lut;
}

// Butteraugli perceptual distance between two RGBA8 images.
// img1_data, img2_data: RGBA8 buffers, width*height*4 bytes each.
// Returns: float distance bits packed in int32 (0=identical, ~1.0=imperceptible,
//          >2.0=noticeable), or -1 on allocation/comparison failure.
// The caller in facade.ts reinterprets the int32 bits back to float via
// Int32Array/Float32Array view aliasing.
extern "C" int32_t jxl_wasm_butteraugli_compare(
    const uint8_t* img1_data, const uint8_t* img2_data,
    uint32_t width, uint32_t height) {
  // Use default malloc/free memory manager (nullptr fills in defaults via MemoryManagerInit)
  JxlMemoryManager mem;
  if (!jxl::MemoryManagerInit(&mem, nullptr)) return -1;

  const float* lut = SrgbToLinearLut();

  // Build linear-light float Image3F (planar RGB, sRGB gamma decoded)
  auto build_image = [&](const uint8_t* data) -> jxl::StatusOr<jxl::Image3F> {
    JXL_ASSIGN_OR_RETURN(jxl::Image3F img,
                         jxl::Image3F::Create(&mem, width, height));
    for (size_t y = 0; y < height; ++y) {
      float* JXL_RESTRICT rr = img.PlaneRow(0, y);
      float* JXL_RESTRICT gr = img.PlaneRow(1, y);
      float* JXL_RESTRICT br = img.PlaneRow(2, y);
      const uint8_t* src = data + y * width * 4u;
      for (size_t x = 0; x < width; ++x) {
        // sRGB approximate gamma decode via LUT (replaces 3x pow per pixel)
        rr[x] = lut[src[x * 4u + 0u]];
        gr[x] = lut[src[x * 4u + 1u]];
        br[x] = lut[src[x * 4u + 2u]];
      }
    }
    return img;
  };

  auto img1_or = build_image(img1_data);
  if (!img1_or.ok()) return -1;
  auto img2_or = build_image(img2_data);
  if (!img2_or.ok()) return -1;
  auto diffmap_or = jxl::ImageF::Create(&mem, width, height);
  if (!diffmap_or.ok()) return -1;

  // Extract values — ok() already verified above; value_() is safe to call
  jxl::Image3F img1 = std::move(img1_or).value_();
  jxl::Image3F img2 = std::move(img2_or).value_();
  jxl::ImageF diffmap = std::move(diffmap_or).value_();

  jxl::ButteraugliParams params;
  double diffvalue = 0.0;
  if (!jxl::ButteraugliInterfaceInPlace(std::move(img1), std::move(img2),
                                        params, diffmap, diffvalue)) {
    return -1;
  }

  const float dist = static_cast<float>(diffvalue);
  int32_t bits;
  memcpy(&bits, &dist, 4);
  return bits;
}

// Butteraugli with optional downsample for fast screening (P2/Lens15).
// downsample ∈ {2,4}: BoxDownscale both inputs first, compare at reduced res.
// Scores are *not* comparable across different downsample factors (different pixel counts).
// downsample=1 or other: full-res (delegates to non-ds path).
extern "C" int32_t jxl_wasm_butteraugli_compare_ds(
    const uint8_t* img1_data, const uint8_t* img2_data,
    uint32_t width, uint32_t height, uint32_t downsample) {
  if (downsample != 2 && downsample != 4) {
    return jxl_wasm_butteraugli_compare(img1_data, img2_data, width, height);
  }

  const uint32_t dw = (width + downsample - 1u) / downsample;
  const uint32_t dh = (height + downsample - 1u) / downsample;
  if (dw == 0 || dh == 0) {
    return jxl_wasm_butteraugli_compare(img1_data, img2_data, width, height);
  }

  const size_t ds_bytes = static_cast<size_t>(dw) * dh * 4u;
  uint8_t* ds1 = static_cast<uint8_t*>(malloc(ds_bytes));
  uint8_t* ds2 = static_cast<uint8_t*>(malloc(ds_bytes));
  if (!ds1 || !ds2) {
    free(ds1); free(ds2);
    return jxl_wasm_butteraugli_compare(img1_data, img2_data, width, height);
  }

  BoxDownscaleRgba8(img1_data, width, height, ds1, dw, dh);
  BoxDownscaleRgba8(img2_data, width, height, ds2, dw, dh);

  const int32_t res = jxl_wasm_butteraugli_compare(ds1, ds2, dw, dh);

  free(ds1);
  free(ds2);
  return res;
}

}
