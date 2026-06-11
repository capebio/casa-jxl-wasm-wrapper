#include <node_api.h>

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <string>
#include <vector>
#include <algorithm>

#if __has_include(<jxl/decode.h>) && __has_include(<jxl/encode.h>)
#define CASABIO_HAVE_LIBJXL 1
#include <jxl/color_encoding.h>
#include <jxl/decode.h>
#include <jxl/encode.h>
#include <jxl/types.h>
#if __has_include(<jxl/thread_parallel_runner.h>)
#include <jxl/thread_parallel_runner.h>
#define CASABIO_HAVE_JXL_THREADS 1
#else
#define CASABIO_HAVE_JXL_THREADS 0
#endif
#else
#define CASABIO_HAVE_LIBJXL 0
#define CASABIO_HAVE_JXL_THREADS 0
#endif

namespace {

#if CASABIO_HAVE_JXL_THREADS
struct ThreadRunnerGuard {
  void* runner;
  ThreadRunnerGuard(void* r) : runner(r) {}
  ~ThreadRunnerGuard() {
    if (runner) {
      JxlThreadParallelRunnerDestroy(runner);
    }
  }
};
#endif

enum class PixelFormatKind { Rgba8, Rgba16, Rgbaf32 };

struct ImageInfo {
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t bits_per_sample = 8;
  bool has_alpha = true;
  bool has_animation = false;
  bool jpeg_reconstruction_available = false;

  // Task 5 decoder extra channels (descriptors only; additive)
  struct DecodedExtra {
    std::string type;
    uint32_t bits_per_sample = 8;
    uint32_t dim_shift = 0;
    std::string name;
    bool has_spot = false;
    float spot_r = 0, spot_g = 0, spot_b = 0, spot_solidity = 0;
  };
  std::vector<DecodedExtra> extra_channels;
};

struct Region {
  uint32_t x = 0;
  uint32_t y = 0;
  uint32_t w = 0;
  uint32_t h = 0;
};

struct DecoderData {
  std::vector<uint8_t> input;
  std::vector<napi_ref> events;
  bool closed = false;
  bool cancelled = false;
};

struct ExtraChannelDesc {
  std::string type;
  uint32_t bits_per_sample = 8;
  uint32_t dim_shift = 0;
  std::string name;
  double distance = -1.0;
  bool has_spot = false;
  float spot_r = 0.0f;
  float spot_g = 0.0f;
  float spot_b = 0.0f;
  float spot_solidity = 0.0f;
  std::vector<uint8_t> pixels;  // optional duck-typed plane data from JS 'pixels' prop (for AddExtraChannelBuffer)
};

struct EncoderData {
  std::vector<uint8_t> pixels;
  std::vector<napi_ref> chunks;
  PixelFormatKind format = PixelFormatKind::Rgba8;
  uint32_t width = 0;
  uint32_t height = 0;
  bool has_alpha = true;
  double distance = 1.0;
  uint32_t effort = 7;
  bool finished = false;
  bool cancelled = false;

  // N-17: metadata/ICC (populated in CreateEncoder; consumed in EncodeAll)
  std::vector<uint8_t> icc;
  std::vector<uint8_t> exif;
  std::vector<uint8_t> xmp;

  // N-18: progressive encode (enables decoder progression events on self-encoded codestreams)
  bool progressive = false;

  // Escape hatch support (advancedFrameSettings)
  std::vector<int32_t> advanced_setting_ids;
  std::vector<int32_t> advanced_setting_values;

  // Task 5: extra channels (additive; 0-EC path unchanged)
  std::vector<ExtraChannelDesc> extra_channels;

  // NV-3 / 3C alphaDistance
  double alpha_distance = -1.0;

  // NV-3 / 3E animation encode fields
  struct FrameDesc {
    std::vector<uint8_t> pixels;
    uint32_t duration = 0;
    std::string name;
  };
  std::vector<FrameDesc> frames;
  bool has_animation = false;
  uint32_t anim_tps_num = 0;
  uint32_t anim_tps_den = 1;
  int32_t anim_loops = 0;

  // NV-3 / 3F customBoxes fields
  struct CustomBoxDesc {
    std::string type;
    std::vector<uint8_t> data;
    bool compress = false;
  };
  std::vector<CustomBoxDesc> custom_boxes;

  // NV-14 zero-copy single-push fields
  napi_ref pinned_input = nullptr;
  void* pinned_data = nullptr;
  size_t pinned_size = 0;
  bool multi_push = false;
};

struct IteratorData {
  std::vector<napi_ref> values;
  size_t index = 0;
};

static napi_value Undefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

static napi_value Throw(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

static napi_value ThrowCode(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message);
  return nullptr;
}

static napi_value MakeString(napi_env env, const char* value) {
  napi_value out;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &out);
  return out;
}

static napi_value MakeBool(napi_env env, bool value) {
  napi_value out;
  napi_get_boolean(env, value, &out);
  return out;
}

static napi_value MakeUint32(napi_env env, uint32_t value) {
  napi_value out;
  napi_create_uint32(env, value, &out);
  return out;
}

static bool GetProp(napi_env env, napi_value object, const char* name, napi_value* out) {
  bool has = false;
  napi_has_named_property(env, object, name, &has);
  if (!has) return false;
  napi_get_named_property(env, object, name, out);
  return true;
}

static uint32_t GetUint32Prop(napi_env env, napi_value object, const char* name, uint32_t fallback) {
  napi_value value;
  if (!GetProp(env, object, name, &value)) return fallback;
  uint32_t out = fallback;
  napi_get_value_uint32(env, value, &out);
  return out;
}

static int32_t GetInt32Prop(napi_env env, napi_value object, const char* name, int32_t fallback) {
  napi_value value;
  if (!GetProp(env, object, name, &value)) return fallback;
  int32_t out = fallback;
  napi_get_value_int32(env, value, &out);
  return out;
}

static bool GetBoolProp(napi_env env, napi_value object, const char* name, bool fallback) {
  napi_value value;
  if (!GetProp(env, object, name, &value)) return fallback;
  bool out = fallback;
  napi_get_value_bool(env, value, &out);
  return out;
}

static double GetNullableNumberProp(napi_env env, napi_value object, const char* name, double fallback) {
  napi_value value;
  if (!GetProp(env, object, name, &value)) return fallback;
  napi_valuetype type;
  napi_typeof(env, value, &type);
  if (type == napi_null || type == napi_undefined) return fallback;
  double out = fallback;
  napi_get_value_double(env, value, &out);
  return out;
}

static std::string GetStringProp(napi_env env, napi_value object, const char* name, const char* fallback) {
  napi_value value;
  if (!GetProp(env, object, name, &value)) return fallback;
  size_t len = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &len);
  std::vector<char> buffer(len + 1, '\0');
  napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &len);
  return std::string(buffer.data(), len);
}

static PixelFormatKind ParsePixelFormat(const std::string& value) {
  if (value == "rgba16") return PixelFormatKind::Rgba16;
  if (value == "rgbaf32") return PixelFormatKind::Rgbaf32;
  return PixelFormatKind::Rgba8;
}

static const char* PixelFormatName(PixelFormatKind format) {
  switch (format) {
    case PixelFormatKind::Rgba16: return "rgba16";
    case PixelFormatKind::Rgbaf32: return "rgbaf32";
    case PixelFormatKind::Rgba8:
    default: return "rgba8";
  }
}

static uint32_t BitsForFormat(PixelFormatKind format) {
  switch (format) {
    case PixelFormatKind::Rgba16: return 16;
    case PixelFormatKind::Rgbaf32: return 32;
    case PixelFormatKind::Rgba8:
    default: return 8;
  }
}

static size_t BytesPerChannel(PixelFormatKind format) {
  switch (format) {
    case PixelFormatKind::Rgba16: return 2;
    case PixelFormatKind::Rgbaf32: return 4;
    case PixelFormatKind::Rgba8:
    default: return 1;
  }
}

// N-18/N-22: parsed once at DecoderClose; avoids per-site strcmp
enum class ProgressionTarget { Header, Dc, Pass, Final };

static ProgressionTarget ParseProgressionTarget(const std::string& s) {
  if (s == "header") return ProgressionTarget::Header;
  if (s == "dc") return ProgressionTarget::Dc;
  if (s == "pass") return ProgressionTarget::Pass;
  return ProgressionTarget::Final;
}

#if CASABIO_HAVE_LIBJXL
static JxlDataType DataTypeForFormat(PixelFormatKind format) {
  switch (format) {
    case PixelFormatKind::Rgba16: return JXL_TYPE_UINT16;
    case PixelFormatKind::Rgbaf32: return JXL_TYPE_FLOAT;
    case PixelFormatKind::Rgba8:
    default: return JXL_TYPE_UINT8;
  }
}

static uint32_t ExponentBitsForFormat(PixelFormatKind format) {
  return format == PixelFormatKind::Rgbaf32 ? 8u : 0u;
}

static JxlExtraChannelType JxlExtraTypeFromString(const std::string& s) {
  if (s == "alpha") return JXL_CHANNEL_ALPHA;
  if (s == "depth") return JXL_CHANNEL_DEPTH;
  if (s == "spot") return JXL_CHANNEL_SPOT_COLOR;
  if (s == "selection") return JXL_CHANNEL_SELECTION_MASK;
  if (s == "thermal") return JXL_CHANNEL_THERMAL;
  // reserved + unknown map to UNKNOWN (libjxl will treat as custom/forward)
  return JXL_CHANNEL_UNKNOWN;
}

// N-22: single source of truth for extra channel type strings (decode descriptors + reservedN).
// Replaces duplicated if/else in DecodeAll and the previous const-char switch.
static std::string JxlExtraTypeName(JxlExtraChannelType t) {
  switch (t) {
    case JXL_CHANNEL_ALPHA: return "alpha";
    case JXL_CHANNEL_DEPTH: return "depth";
    case JXL_CHANNEL_SPOT_COLOR: return "spot";
    case JXL_CHANNEL_SELECTION_MASK: return "selection";
    case JXL_CHANNEL_THERMAL: return "thermal";
    default: {
      int v = static_cast<int>(t);
      if (v >= 7 && v <= 14) {
        char buf[16];
        snprintf(buf, sizeof(buf), "reserved%d", v - 7);
        return std::string(buf);
      }
      return "unknown";
    }
  }
}
#endif

static bool ReadBytes(napi_env env, napi_value value, std::vector<uint8_t>* out) {
  bool is_typedarray = false;
  napi_is_typedarray(env, value, &is_typedarray);
  if (is_typedarray) {
    napi_typedarray_type type;
    size_t length = 0;
    void* data = nullptr;
    napi_value arraybuffer;
    size_t byte_offset = 0;
    napi_get_typedarray_info(env, value, &type, &length, &data, &arraybuffer, &byte_offset);
    size_t bytes = length;
    if (type == napi_uint16_array || type == napi_int16_array) bytes *= 2;
    if (type == napi_uint32_array || type == napi_int32_array || type == napi_float32_array) bytes *= 4;
    if (type == napi_float64_array || type == napi_bigint64_array || type == napi_biguint64_array) bytes *= 8;
    const auto* begin = static_cast<const uint8_t*>(data);
    out->insert(out->end(), begin, begin + bytes);
    return true;
  }

  bool is_arraybuffer = false;
  napi_is_arraybuffer(env, value, &is_arraybuffer);
  if (is_arraybuffer) {
    void* data = nullptr;
    size_t bytes = 0;
    napi_get_arraybuffer_info(env, value, &data, &bytes);
    const auto* begin = static_cast<const uint8_t*>(data);
    out->insert(out->end(), begin, begin + bytes);
    return true;
  }

  return false;
}

static napi_value MakeArrayBuffer(napi_env env, const uint8_t* bytes, size_t size) {
  void* data = nullptr;
  napi_value out;
  napi_create_arraybuffer(env, size, &data, &out);
  if (size > 0 && bytes != nullptr) memcpy(data, bytes, size);
  return out;
}

static napi_value MakeExtraChannelObject(napi_env env, const ImageInfo::DecodedExtra& ec) {
  napi_value obj;
  napi_create_object(env, &obj);
  napi_set_named_property(env, obj, "type", MakeString(env, ec.type.c_str()));
  napi_set_named_property(env, obj, "bitsPerSample", MakeUint32(env, ec.bits_per_sample));
  if (ec.dim_shift != 0) {
    napi_set_named_property(env, obj, "dimShift", MakeUint32(env, ec.dim_shift));
  }
  if (!ec.name.empty()) {
    napi_set_named_property(env, obj, "name", MakeString(env, ec.name.c_str()));
  }
  if (ec.has_spot) {
    napi_value spot;
    napi_create_object(env, &spot);
    napi_value r; napi_create_double(env, ec.spot_r, &r);
    napi_set_named_property(env, spot, "red", r);
    napi_value g; napi_create_double(env, ec.spot_g, &g);
    napi_set_named_property(env, spot, "green", g);
    napi_value b; napi_create_double(env, ec.spot_b, &b);
    napi_set_named_property(env, spot, "blue", b);
    napi_value s; napi_create_double(env, ec.spot_solidity, &s);
    napi_set_named_property(env, spot, "solidity", s);
    napi_set_named_property(env, obj, "spotColor", spot);
  }
  return obj;
}

static napi_value MakeImageInfo(napi_env env, const ImageInfo& info) {
  napi_value object;
  napi_create_object(env, &object);
  napi_set_named_property(env, object, "width", MakeUint32(env, info.width));
  napi_set_named_property(env, object, "height", MakeUint32(env, info.height));
  napi_set_named_property(env, object, "bitsPerSample", MakeUint32(env, info.bits_per_sample));
  napi_set_named_property(env, object, "hasAlpha", MakeBool(env, info.has_alpha));
  napi_set_named_property(env, object, "hasAnimation", MakeBool(env, info.has_animation));
  napi_set_named_property(env, object, "jpegReconstructionAvailable", MakeBool(env, info.jpeg_reconstruction_available));
  if (!info.extra_channels.empty()) {
    napi_value arr;
    napi_create_array_with_length(env, info.extra_channels.size(), &arr);
    for (size_t i = 0; i < info.extra_channels.size(); ++i) {
      napi_value item = MakeExtraChannelObject(env, info.extra_channels[i]);
      napi_set_element(env, arr, static_cast<uint32_t>(i), item);
    }
    napi_set_named_property(env, object, "extraChannels", arr);
  }
  return object;
}

static napi_ref RefValue(napi_env env, napi_value value) {
  napi_ref ref;
  napi_create_reference(env, value, 1, &ref);
  return ref;
}

static napi_value MakeHeaderEvent(napi_env env, const ImageInfo& info) {
  napi_value event;
  napi_create_object(env, &event);
  napi_set_named_property(env, event, "type", MakeString(env, "header"));
  napi_value infoObj = MakeImageInfo(env, info);
  napi_set_named_property(env, event, "info", infoObj);
  if (!info.extra_channels.empty()) {
    // also expose at event top-level per native DecodeEvent declared shape (parity + compat)
    napi_value extras;
    napi_get_named_property(env, infoObj, "extraChannels", &extras);
    napi_set_named_property(env, event, "extraChannels", extras);
  }
  return event;
}

static napi_value MakeImageEvent(napi_env env, const char* evtType, const char* stage, const ImageInfo& info, PixelFormatKind format, const std::vector<uint8_t>& pixels) {
  napi_value event;
  napi_create_object(env, &event);
  napi_set_named_property(env, event, "type", MakeString(env, evtType));
  napi_set_named_property(env, event, "stage", MakeString(env, stage));
  napi_value infoObj = MakeImageInfo(env, info);
  napi_set_named_property(env, event, "info", infoObj);
  napi_set_named_property(env, event, "pixels", MakeArrayBuffer(env, pixels.data(), pixels.size()));
  napi_set_named_property(env, event, "format", MakeString(env, PixelFormatName(format)));
  napi_set_named_property(env, event, "pixelStride", MakeUint32(env, 4));
  if (!info.extra_channels.empty()) {
    napi_value extras;
    napi_get_named_property(env, infoObj, "extraChannels", &extras);
    napi_set_named_property(env, event, "extraChannels", extras);
  }
  return event;
}

// N-13: zero-copy path for progress/final when we let libjxl write (or flush) straight into a napi ArrayBuffer.
// Regular (non-external) ABs remain detachable for transferList downstream.
static napi_value MakeImageEventWithAB(napi_env env, const char* evtType, const char* stage, const ImageInfo& info, PixelFormatKind format, napi_value pixelsAb) {
  napi_value event;
  napi_create_object(env, &event);
  napi_set_named_property(env, event, "type", MakeString(env, evtType));
  napi_set_named_property(env, event, "stage", MakeString(env, stage));
  napi_value infoObj = MakeImageInfo(env, info);
  napi_set_named_property(env, event, "info", infoObj);
  napi_set_named_property(env, event, "pixels", pixelsAb);
  napi_set_named_property(env, event, "format", MakeString(env, PixelFormatName(format)));
  napi_set_named_property(env, event, "pixelStride", MakeUint32(env, 4));
  if (!info.extra_channels.empty()) {
    napi_value extras;
    napi_get_named_property(env, infoObj, "extraChannels", &extras);
    napi_set_named_property(env, event, "extraChannels", extras);
  }
  return event;
}

static napi_value MakeDoneResult(napi_env env) {
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "done", MakeBool(env, true));
  return result;
}

static napi_value MakeValueResult(napi_env env, napi_value value) {
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "value", value);
  napi_set_named_property(env, result, "done", MakeBool(env, false));
  return result;
}

static napi_value ResolveImmediate(napi_env env, napi_value value) {
  napi_deferred deferred;
  napi_value promise;
  napi_create_promise(env, &deferred, &promise);
  napi_resolve_deferred(env, deferred, value);
  return promise;
}

static napi_value IteratorNext(napi_env env, napi_callback_info info) {
  napi_value this_arg;
  void* raw = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, &this_arg, &raw);
  auto* data = static_cast<IteratorData*>(raw);
  if (data == nullptr || data->index >= data->values.size()) {
    return ResolveImmediate(env, MakeDoneResult(env));
  }
  napi_value value;
  napi_get_reference_value(env, data->values[data->index++], &value);
  return ResolveImmediate(env, MakeValueResult(env, value));
}

static napi_value IteratorSelf(napi_env env, napi_callback_info info) {
  napi_value this_arg;
  napi_get_cb_info(env, info, nullptr, nullptr, &this_arg, nullptr);
  return this_arg;
}

static void IteratorFinalize(napi_env env, void* raw, void*) {
  auto* data = static_cast<IteratorData*>(raw);
  if (data == nullptr) return;
  for (napi_ref ref : data->values) napi_delete_reference(env, ref);
  delete data;
}

static napi_value MakeIterator(napi_env env, const std::vector<napi_ref>& refs) {
  auto* data = new IteratorData();
  for (napi_ref ref : refs) {
    napi_value value;
    napi_get_reference_value(env, ref, &value);
    data->values.push_back(RefValue(env, value));
  }

  napi_value iterator;
  napi_create_object(env, &iterator);
  napi_wrap(env, iterator, data, IteratorFinalize, nullptr, nullptr);

  napi_value next;
  napi_create_function(env, "next", NAPI_AUTO_LENGTH, IteratorNext, data, &next);
  napi_set_named_property(env, iterator, "next", next);

  napi_value global;
  napi_get_global(env, &global);
  napi_value symbol_ctor;
  napi_get_named_property(env, global, "Symbol", &symbol_ctor);
  napi_value async_iterator_symbol;
  napi_get_named_property(env, symbol_ctor, "asyncIterator", &async_iterator_symbol);
  napi_value self;
  napi_create_function(env, "[Symbol.asyncIterator]", NAPI_AUTO_LENGTH, IteratorSelf, nullptr, &self);
  napi_set_property(env, iterator, async_iterator_symbol, self);

  return iterator;
}

#if CASABIO_HAVE_LIBJXL
// NV-13: Fused Crop + Downsample implementation
static void transform_fused(const uint8_t* src, ImageInfo& info, const Region* region, uint32_t ds, PixelFormatKind fmt, std::vector<uint8_t>& dest) {
  uint32_t rx = region ? region->x : 0;
  uint32_t ry = region ? region->y : 0;
  uint32_t rw = region ? region->w : info.width;
  uint32_t rh = region ? region->h : info.height;

  if (rx >= info.width || ry >= info.height || rw == 0 || rh == 0) {
    dest.clear();
    info.width = 0;
    info.height = 0;
    return;
  }
  rw = std::min(rw, info.width - rx);
  rh = std::min(rh, info.height - ry);

  if (rw == 0 || rh == 0) {
    dest.clear();
    info.width = 0;
    info.height = 0;
    return;
  }

  const uint32_t bpc = BytesPerChannel(fmt);
  const uint32_t bpp = 4u * bpc;
  const uint32_t sw = info.width;

  if (ds <= 1) {
    // Fused crop-only path
    dest.resize(static_cast<size_t>(rw) * rh * bpp);
    const size_t src_row_bytes = static_cast<size_t>(sw) * bpp;
    const size_t dest_row_bytes = static_cast<size_t>(rw) * bpp;
    for (uint32_t y = 0; y < rh; ++y) {
      const uint8_t* src_row = src + (ry + y) * src_row_bytes + rx * bpp;
      uint8_t* dest_row = dest.data() + y * dest_row_bytes;
      std::memcpy(dest_row, src_row, dest_row_bytes);
    }
    info.width = rw;
    info.height = rh;
    return;
  }

  // Fused crop + downsample path
  const uint32_t dw = std::max(1u, (rw + ds - 1u) / ds);
  const uint32_t dh = std::max(1u, (rh + ds - 1u) / ds);
  dest.assign(static_cast<size_t>(dw) * dh * bpp, 0);

  const size_t src_row_bytes = static_cast<size_t>(sw) * bpp;
  const size_t dest_row_bytes = static_cast<size_t>(dw) * bpp;

  if (fmt == PixelFormatKind::Rgba8) {
    if (ds == 2) {
      // Specialize ds == 2 (common pyramid case) with flat 2x2 kernel
      for (uint32_t y = 0; y < dh; ++y) {
        uint32_t sy0 = ry + y * 2;
        uint32_t sy1 = sy0 + 1;
        const uint8_t* row0 = src + sy0 * src_row_bytes;
        const uint8_t* row1 = (sy1 < ry + rh) ? (src + sy1 * src_row_bytes) : nullptr;
        uint8_t* dest_row = dest.data() + y * dest_row_bytes;

        for (uint32_t x = 0; x < dw; ++x) {
          uint32_t sx0 = rx + x * 2;
          uint32_t sx1 = sx0 + 1;
          bool has_x1 = (sx1 < rx + rw);

          uint32_t sum[4] = {0};
          uint32_t cnt = 0;

          const uint8_t* p00 = row0 + sx0 * 4;
          sum[0] += p00[0]; sum[1] += p00[1]; sum[2] += p00[2]; sum[3] += p00[3];
          cnt++;

          if (has_x1) {
            const uint8_t* p01 = row0 + sx1 * 4;
            sum[0] += p01[0]; sum[1] += p01[1]; sum[2] += p01[2]; sum[3] += p01[3];
            cnt++;
          }

          if (row1) {
            const uint8_t* p10 = row1 + sx0 * 4;
            sum[0] += p10[0]; sum[1] += p10[1]; sum[2] += p10[2]; sum[3] += p10[3];
            cnt++;

            if (has_x1) {
              const uint8_t* p11 = row1 + sx1 * 4;
              sum[0] += p11[0]; sum[1] += p11[1]; sum[2] += p11[2]; sum[3] += p11[3];
              cnt++;
            }
          }

          dest_row[x * 4 + 0] = sum[0] / cnt;
          dest_row[x * 4 + 1] = sum[1] / cnt;
          dest_row[x * 4 + 2] = sum[2] / cnt;
          dest_row[x * 4 + 3] = sum[3] / cnt;
        }
      }
    } else {
      // General downsample for Rgba8
      for (uint32_t y = 0; y < dh; ++y) {
        uint8_t* dest_row = dest.data() + y * dest_row_bytes;
        for (uint32_t x = 0; x < dw; ++x) {
          uint32_t sum[4] = {0};
          uint32_t cnt = 0;
          for (uint32_t yy = 0; yy < ds; ++yy) {
            uint32_t sy = ry + y * ds + yy;
            if (sy >= ry + rh) break;
            const uint8_t* src_row = src + sy * src_row_bytes;
            for (uint32_t xx = 0; xx < ds; ++xx) {
              uint32_t sx = rx + x * ds + xx;
              if (sx >= rx + rw) break;
              const uint8_t* p = src_row + sx * 4;
              sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; sum[3] += p[3];
              cnt++;
            }
          }
          if (cnt > 0) {
            dest_row[x * 4 + 0] = sum[0] / cnt;
            dest_row[x * 4 + 1] = sum[1] / cnt;
            dest_row[x * 4 + 2] = sum[2] / cnt;
            dest_row[x * 4 + 3] = sum[3] / cnt;
          }
        }
      }
    }
  } else if (fmt == PixelFormatKind::Rgba16) {
    if (ds == 2) {
      for (uint32_t y = 0; y < dh; ++y) {
        uint32_t sy0 = ry + y * 2;
        uint32_t sy1 = sy0 + 1;
        const uint16_t* row0 = reinterpret_cast<const uint16_t*>(src + sy0 * src_row_bytes);
        const uint16_t* row1 = (sy1 < ry + rh) ? reinterpret_cast<const uint16_t*>(src + sy1 * src_row_bytes) : nullptr;
        uint16_t* dest_row = reinterpret_cast<uint16_t*>(dest.data() + y * dest_row_bytes);

        for (uint32_t x = 0; x < dw; ++x) {
          uint32_t sx0 = rx + x * 2;
          uint32_t sx1 = sx0 + 1;
          bool has_x1 = (sx1 < rx + rw);

          uint32_t sum[4] = {0};
          uint32_t cnt = 0;

          const uint16_t* p00 = row0 + sx0 * 4;
          sum[0] += p00[0]; sum[1] += p00[1]; sum[2] += p00[2]; sum[3] += p00[3];
          cnt++;

          if (has_x1) {
            const uint16_t* p01 = row0 + sx1 * 4;
            sum[0] += p01[0]; sum[1] += p01[1]; sum[2] += p01[2]; sum[3] += p01[3];
            cnt++;
          }

          if (row1) {
            const uint16_t* p10 = row1 + sx0 * 4;
            sum[0] += p10[0]; sum[1] += p10[1]; sum[2] += p10[2]; sum[3] += p10[3];
            cnt++;

            if (has_x1) {
              const uint16_t* p11 = row1 + sx1 * 4;
              sum[0] += p11[0]; sum[1] += p11[1]; sum[2] += p11[2]; sum[3] += p11[3];
              cnt++;
            }
          }

          dest_row[x * 4 + 0] = sum[0] / cnt;
          dest_row[x * 4 + 1] = sum[1] / cnt;
          dest_row[x * 4 + 2] = sum[2] / cnt;
          dest_row[x * 4 + 3] = sum[3] / cnt;
        }
      }
    } else {
      for (uint32_t y = 0; y < dh; ++y) {
        uint16_t* dest_row = reinterpret_cast<uint16_t*>(dest.data() + y * dest_row_bytes);
        for (uint32_t x = 0; x < dw; ++x) {
          uint32_t sum[4] = {0};
          uint32_t cnt = 0;
          for (uint32_t yy = 0; yy < ds; ++yy) {
            uint32_t sy = ry + y * ds + yy;
            if (sy >= ry + rh) break;
            const uint16_t* src_row = reinterpret_cast<const uint16_t*>(src + sy * src_row_bytes);
            for (uint32_t xx = 0; xx < ds; ++xx) {
              uint32_t sx = rx + x * ds + xx;
              if (sx >= rx + rw) break;
              const uint16_t* p = src_row + sx * 4;
              sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; sum[3] += p[3];
              cnt++;
            }
          }
          if (cnt > 0) {
            dest_row[x * 4 + 0] = sum[0] / cnt;
            dest_row[x * 4 + 1] = sum[1] / cnt;
            dest_row[x * 4 + 2] = sum[2] / cnt;
            dest_row[x * 4 + 3] = sum[3] / cnt;
          }
        }
      }
    }
  } else { // rgbaf32
    if (ds == 2) {
      for (uint32_t y = 0; y < dh; ++y) {
        uint32_t sy0 = ry + y * 2;
        uint32_t sy1 = sy0 + 1;
        const float* row0 = reinterpret_cast<const float*>(src + sy0 * src_row_bytes);
        const float* row1 = (sy1 < ry + rh) ? reinterpret_cast<const float*>(src + sy1 * src_row_bytes) : nullptr;
        float* dest_row = reinterpret_cast<float*>(dest.data() + y * dest_row_bytes);

        for (uint32_t x = 0; x < dw; ++x) {
          uint32_t sx0 = rx + x * 2;
          uint32_t sx1 = sx0 + 1;
          bool has_x1 = (sx1 < rx + rw);

          float sum[4] = {0.f};
          uint32_t cnt = 0;

          const float* p00 = row0 + sx0 * 4;
          sum[0] += p00[0]; sum[1] += p00[1]; sum[2] += p00[2]; sum[3] += p00[3];
          cnt++;

          if (has_x1) {
            const float* p01 = row0 + sx1 * 4;
            sum[0] += p01[0]; sum[1] += p01[1]; sum[2] += p01[2]; sum[3] += p01[3];
            cnt++;
          }

          if (row1) {
            const float* p10 = row1 + sx0 * 4;
            sum[0] += p10[0]; sum[1] += p10[1]; sum[2] += p10[2]; sum[3] += p10[3];
            cnt++;

            if (has_x1) {
              const float* p11 = row1 + sx1 * 4;
              sum[0] += p11[0]; sum[1] += p11[1]; sum[2] += p11[2]; sum[3] += p11[3];
              cnt++;
            }
          }

          dest_row[x * 4 + 0] = sum[0] / cnt;
          dest_row[x * 4 + 1] = sum[1] / cnt;
          dest_row[x * 4 + 2] = sum[2] / cnt;
          dest_row[x * 4 + 3] = sum[3] / cnt;
        }
      }
    } else {
      for (uint32_t y = 0; y < dh; ++y) {
        float* dest_row = reinterpret_cast<float*>(dest.data() + y * dest_row_bytes);
        for (uint32_t x = 0; x < dw; ++x) {
          float sum[4] = {0.f};
          uint32_t cnt = 0;
          for (uint32_t yy = 0; yy < ds; ++yy) {
            uint32_t sy = ry + y * ds + yy;
            if (sy >= ry + rh) break;
            const float* src_row = reinterpret_cast<const float*>(src + sy * src_row_bytes);
            for (uint32_t xx = 0; xx < ds; ++xx) {
              uint32_t sx = rx + x * ds + xx;
              if (sx >= rx + rw) break;
              const float* p = src_row + sx * 4;
              sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; sum[3] += p[3];
              cnt++;
            }
          }
          if (cnt > 0) {
            dest_row[x * 4 + 0] = sum[0] / cnt;
            dest_row[x * 4 + 1] = sum[1] / cnt;
            dest_row[x * 4 + 2] = sum[2] / cnt;
            dest_row[x * 4 + 3] = sum[3] / cnt;
          }
        }
      }
    }
  }

  info.width = dw;
  info.height = dh;
}

// N-20: gate extra channel plane extraction behind opt-in so common RGBA path pays zero.
// N-15 design note (batch mode constraint): DecodeAll materializes *all* requested events (header + 0..N progress + final)
// with their pixel ArrayBuffers into DecoderData::events before returning. Each strong napi_ref keeps the AB alive
// until DecoderDispose (or GC finalize). With emitEveryPass + progressiveDetail:"passes" this is N*frame_bytes peak
// (intentional for the iterator snapshot model; streaming/live iterator with incremental ProcessInput + release between
// yields is the long-term fix but explicitly out of scope per Agent 2 constraints — do not build a push()-time decode loop here).
// Future agents: batching is a known deliberate tradeoff for simple napi iterator surface + transferList compatibility.
static bool DecodeAll(napi_env env, DecoderData* data, PixelFormatKind format, ProgressionTarget target, bool emit_every_pass, bool decode_extra_channels, const std::string& progressive_detail, const Region* region, uint32_t downsample, bool preserve_icc) {
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) return false;

#if CASABIO_HAVE_JXL_THREADS
  void* runner = JxlThreadParallelRunnerCreate(nullptr, JxlThreadParallelRunnerDefaultNumWorkerThreads());
  ThreadRunnerGuard runner_guard(runner);
  if (runner) {
    if (JxlDecoderSetParallelRunner(dec, JxlThreadParallelRunner, runner) != JXL_DEC_SUCCESS) {
      // handled
    }
  }
#endif

  int events = JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE | JXL_DEC_FRAME;
  if (preserve_icc) {
    events |= JXL_DEC_COLOR_ENCODING;
  }
  if (emit_every_pass || target == ProgressionTarget::Dc || target == ProgressionTarget::Pass) {
    events |= JXL_DEC_FRAME_PROGRESSION;
  }
  if (JxlDecoderSubscribeEvents(dec, events) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec);
    return false;
  }

  // N-11: map progressiveDetail (or fallback from emit/target) to the correct JxlProgressiveDetail.
  JxlProgressiveDetail jd = kDC;
  if (progressive_detail == "lastPasses") jd = kLastPasses;
  else if (progressive_detail == "passes") jd = kPasses;
  else if (progressive_detail == "dcProgressive") jd = kDCProgressive;
  else if (emit_every_pass || target == ProgressionTarget::Pass) jd = kLastPasses;
  if (events & JXL_DEC_FRAME_PROGRESSION) {
    JxlDecoderSetProgressiveDetail(dec, jd);
  }

  JxlDecoderSetInput(dec, data->input.data(), data->input.size());
  JxlDecoderCloseInput(dec);

  JxlBasicInfo basic;
  memset(&basic, 0, sizeof(basic));
  ImageInfo info;
  bool info_known = false;
  JxlPixelFormat pf = {4, DataTypeForFormat(format), JXL_NATIVE_ENDIAN, 0};

  // N-20: per-EC plane storage (populated at NEED_IMAGE_OUT_BUFFER when gated)
  std::vector<std::vector<uint8_t>> ec_planes;

  // N-12/N-13: main decode target as napi AB (direct write for final when no xform)
  napi_value main_ab = nullptr;
  void* main_data = nullptr;
  size_t main_size = 0;
  bool had_region = (region != nullptr);
  uint32_t ds = (downsample >= 1 && downsample <= 8) ? downsample : 1u;
  uint32_t bytes_per_pixel = 4u * BytesPerChannel(format);

  bool header_emitted = false;
  std::vector<uint8_t> icc_bytes;

  auto emit_header = [&]() {
    if (header_emitted) return;
    napi_value header = MakeHeaderEvent(env, info);
    if (!icc_bytes.empty()) {
      napi_value icc_ab = MakeArrayBuffer(env, icc_bytes.data(), icc_bytes.size());
      napi_set_named_property(env, header, "iccProfile", icc_ab);
    }
    data->events.push_back(RefValue(env, header));
    header_emitted = true;
  };

  struct DecodedFrame {
    napi_value pixels_ab;
    ImageInfo info;
    uint32_t duration = 0;
    std::string name;
    uint32_t index = 0;
  };
  std::vector<DecodedFrame> decoded_frames;
  uint32_t current_frame_index = 0;
  uint32_t current_frame_duration = 0;
  std::string current_frame_name;

  for (;;) {
    JxlDecoderStatus status = JxlDecoderProcessInput(dec);
    if (status == JXL_DEC_ERROR) {
      JxlDecoderDestroy(dec);
      ThrowCode(env, "InvalidJXL", "libjxl decode error (DEC_ERROR)");
      return false;
    }
    if (status == JXL_DEC_NEED_MORE_INPUT) {
      JxlDecoderDestroy(dec);
      // After CloseInput this means truncated input (N-19)
      ThrowCode(env, "TruncatedInput", "libjxl decode truncated (NEED_MORE_INPUT after close)");
      return false;
    }
    if (status == JXL_DEC_SUCCESS) break;
    
    if (status == JXL_DEC_BASIC_INFO) {
      if (JxlDecoderGetBasicInfo(dec, &basic) != JXL_DEC_SUCCESS) {
        JxlDecoderDestroy(dec);
        return false;
      }
      info.width = basic.xsize;
      info.height = basic.ysize;
      info.bits_per_sample = BitsForFormat(format);
      info.has_alpha = basic.alpha_bits > 0;
      info.has_animation = basic.have_animation;
      info.jpeg_reconstruction_available = false;

      uint32_t n_ec = basic.num_extra_channels;
      for (uint32_t i = 0; i < n_ec; ++i) {
        JxlExtraChannelInfo ei{};
        if (JxlDecoderGetExtraChannelInfo(dec, i, &ei) == JXL_DEC_SUCCESS) {
          ImageInfo::DecodedExtra d{};
          d.type = JxlExtraTypeName(ei.type);
          d.bits_per_sample = ei.bits_per_sample;
          d.dim_shift = ei.dim_shift;
          if (ei.type == JXL_CHANNEL_SPOT_COLOR) {
            d.has_spot = true;
            d.spot_r = ei.spot_color[0];
            d.spot_g = ei.spot_color[1];
            d.spot_b = ei.spot_color[2];
            d.spot_solidity = ei.spot_color[3];
          }
          if (ei.name_length > 0) {
            std::vector<char> nm(ei.name_length + 1, '\0');
            if (JxlDecoderGetExtraChannelName(dec, i, nm.data(), nm.size()) == JXL_DEC_SUCCESS) {
              d.name.assign(nm.data(), ei.name_length);
            }
          }
          info.extra_channels.push_back(d);
        }
      }

      if (decode_extra_channels && n_ec > 0) {
        ec_planes.assign(n_ec, std::vector<uint8_t>());
      }

      info_known = true;
      if (!preserve_icc) {
        emit_header();
        if (target == ProgressionTarget::Header) {
          JxlDecoderDestroy(dec);
          return true;
        }
      }
      continue;
    }

    if (status == JXL_DEC_COLOR_ENCODING) {
      size_t icc_size = 0;
      if (JxlDecoderGetICCProfileSize(dec, JXL_COLOR_PROFILE_TARGET_DATA, &icc_size) == JXL_DEC_SUCCESS && icc_size > 0) {
        icc_bytes.resize(icc_size);
        if (JxlDecoderGetColorAsICCProfile(dec, JXL_COLOR_PROFILE_TARGET_DATA, icc_bytes.data(), icc_size) != JXL_DEC_SUCCESS) {
          icc_bytes.clear();
        }
      }
      emit_header();
      if (target == ProgressionTarget::Header) {
        JxlDecoderDestroy(dec);
        return true;
      }
      continue;
    }

    if (status == JXL_DEC_FRAME) {
      if (basic.have_animation) {
        JxlFrameHeader fh;
        if (JxlDecoderGetFrameHeader(dec, &fh) == JXL_DEC_SUCCESS) {
          current_frame_duration = fh.duration;
          current_frame_name.clear();
          if (fh.name_length > 0) {
            std::vector<char> fnm(fh.name_length + 1, '\0');
            if (JxlDecoderGetFrameName(dec, fnm.data(), fnm.size()) == JXL_DEC_SUCCESS) {
              current_frame_name.assign(fnm.data(), fh.name_length);
            }
          }
        }
      }
      continue;
    }

    if (status == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      emit_header();
      size_t buffer_size = 0;
      if (JxlDecoderImageOutBufferSize(dec, &pf, &buffer_size) != JXL_DEC_SUCCESS) {
        JxlDecoderDestroy(dec);
        return false;
      }
      napi_create_arraybuffer(env, buffer_size, &main_data, &main_ab);
      main_size = buffer_size;
      if (JxlDecoderSetImageOutBuffer(dec, &pf, main_data, main_size) != JXL_DEC_SUCCESS) {
        JxlDecoderDestroy(dec);
        return false;
      }
      if (decode_extra_channels && !ec_planes.empty()) {
        for (uint32_t i = 0; i < ec_planes.size(); ++i) {
          uint32_t bps = (i < info.extra_channels.size() && info.extra_channels[i].bits_per_sample)
                             ? info.extra_channels[i].bits_per_sample : 8u;
          JxlDataType dt = (bps == 16) ? JXL_TYPE_UINT16 : (bps > 16 ? JXL_TYPE_FLOAT : JXL_TYPE_UINT8);
          JxlPixelFormat pf_ec = {1, dt, JXL_NATIVE_ENDIAN, 0};
          size_t ec_size = 0;
          if (JxlDecoderExtraChannelBufferSize(dec, &pf_ec, &ec_size, i) == JXL_DEC_SUCCESS && ec_size > 0) {
            ec_planes[i].resize(ec_size);
            JxlDecoderSetExtraChannelBuffer(dec, &pf_ec, ec_planes[i].data(), ec_size, i);
          }
        }
      }
      continue;
    }

    if (status == JXL_DEC_FRAME_PROGRESSION && info_known && main_ab != nullptr) {
      emit_header();
      const char* prog_stage = (target == ProgressionTarget::Dc) ? "dc" : "pass";
      napi_value prog_ev_ab = nullptr;
      ImageInfo ev_info = info;
      bool needs_xform = had_region || (ds > 1u);
      if (needs_xform) {
        void* snap = nullptr;
        napi_value snap_ab;
        napi_create_arraybuffer(env, main_size, &snap, &snap_ab);
        bool flushed = JxlDecoderSetImageOutBuffer(dec, &pf, snap, main_size) == JXL_DEC_SUCCESS &&
                       JxlDecoderFlushImage(dec) == JXL_DEC_SUCCESS;
        JxlDecoderSetImageOutBuffer(dec, &pf, main_data, main_size);
        if (flushed) {
          std::vector<uint8_t> work;
          transform_fused(static_cast<const uint8_t*>(snap), ev_info, region, ds, format, work);
          void* outd = nullptr;
          napi_value out_ab;
          napi_create_arraybuffer(env, work.size(), &outd, &out_ab);
          if (!work.empty() && outd) memcpy(outd, work.data(), work.size());
          prog_ev_ab = out_ab;
        }
      } else {
        void* snap = nullptr;
        napi_value snap_ab;
        napi_create_arraybuffer(env, main_size, &snap, &snap_ab);
        bool flushed = JxlDecoderSetImageOutBuffer(dec, &pf, snap, main_size) == JXL_DEC_SUCCESS &&
                       JxlDecoderFlushImage(dec) == JXL_DEC_SUCCESS;
        JxlDecoderSetImageOutBuffer(dec, &pf, main_data, main_size);
        if (flushed) {
          prog_ev_ab = snap_ab;
        }
      }
      if (prog_ev_ab != nullptr) {
        napi_value progress = MakeImageEventWithAB(env, "progress", prog_stage, ev_info, format, prog_ev_ab);
        if (had_region) {
          napi_value rgn;
          napi_create_object(env, &rgn);
          // NV-21 Region echo
          napi_set_named_property(env, rgn, "x", MakeUint32(env, region->x));
          napi_set_named_property(env, rgn, "y", MakeUint32(env, region->y));
          napi_set_named_property(env, rgn, "w", MakeUint32(env, ev_info.width));
          napi_set_named_property(env, rgn, "h", MakeUint32(env, ev_info.height));
          napi_set_named_property(env, progress, "region", rgn);
        }
        data->events.push_back(RefValue(env, progress));
      }
      if (!emit_every_pass && target != ProgressionTarget::Final) {
        JxlDecoderDestroy(dec);
        return true;
      }
      continue;
    }

    if (status == JXL_DEC_FULL_IMAGE) {
      if (basic.have_animation) {
        ImageInfo ev_info = info;
        napi_value frame_pixels_ab = main_ab;
        bool needs_xform = had_region || (ds > 1u);
        if (needs_xform) {
          std::vector<uint8_t> work;
          transform_fused(static_cast<const uint8_t*>(main_data), ev_info, region, ds, format, work);
          void* outd = nullptr;
          napi_value out_ab;
          napi_create_arraybuffer(env, work.size(), &outd, &out_ab);
          if (!work.empty() && outd) memcpy(outd, work.data(), work.size());
          frame_pixels_ab = out_ab;
        } else {
          void* outd = nullptr;
          napi_value out_ab;
          napi_create_arraybuffer(env, main_size, &outd, &out_ab);
          if (outd && main_data) memcpy(outd, main_data, main_size);
          frame_pixels_ab = out_ab;
        }

        DecodedFrame df;
        df.pixels_ab = frame_pixels_ab;
        df.info = ev_info;
        df.duration = current_frame_duration;
        df.name = current_frame_name;
        df.index = current_frame_index;
        decoded_frames.push_back(df);

        current_frame_index++;
      }
      continue;
    }
  }

  JxlDecoderDestroy(dec);
  emit_header();

  if (basic.have_animation) {
    if (decoded_frames.empty()) return false;
    for (size_t i = 0; i < decoded_frames.size() - 1; ++i) {
      const auto& df = decoded_frames[i];
      napi_value ev = MakeImageEventWithAB(env, "progress", "progress", df.info, format, df.pixels_ab);
      napi_set_named_property(env, ev, "frameIndex", MakeUint32(env, df.index));
      napi_set_named_property(env, ev, "frameDuration", MakeUint32(env, df.duration));
      if (!df.name.empty()) {
        napi_set_named_property(env, ev, "frameName", MakeString(env, df.name.c_str()));
      }
      if (had_region) {
        napi_value rgn;
        napi_create_object(env, &rgn);
        napi_set_named_property(env, rgn, "x", MakeUint32(env, region->x));
        napi_set_named_property(env, rgn, "y", MakeUint32(env, region->y));
        napi_set_named_property(env, rgn, "w", MakeUint32(env, df.info.width));
        napi_set_named_property(env, rgn, "h", MakeUint32(env, df.info.height));
        napi_set_named_property(env, ev, "region", rgn);
      }
      data->events.push_back(RefValue(env, ev));
    }
    const auto& df = decoded_frames.back();
    napi_value ev = MakeImageEventWithAB(env, "final", "final", df.info, format, df.pixels_ab);
    napi_set_named_property(env, ev, "frameIndex", MakeUint32(env, df.index));
    napi_set_named_property(env, ev, "frameDuration", MakeUint32(env, df.duration));
    if (!df.name.empty()) {
      napi_set_named_property(env, ev, "frameName", MakeString(env, df.name.c_str()));
    }
    uint32_t tps_den = basic.animation.tps_denominator > 0 ? basic.animation.tps_denominator : 1u;
    uint32_t tps = basic.animation.tps_numerator / tps_den;
    if (tps == 0) tps = 1;
    napi_set_named_property(env, ev, "animTicksPerSecond", MakeUint32(env, tps));
    if (had_region) {
      napi_value rgn;
      napi_create_object(env, &rgn);
      napi_set_named_property(env, rgn, "x", MakeUint32(env, region->x));
      napi_set_named_property(env, rgn, "y", MakeUint32(env, region->y));
      napi_set_named_property(env, rgn, "w", MakeUint32(env, df.info.width));
      napi_set_named_property(env, rgn, "h", MakeUint32(env, df.info.height));
      napi_set_named_property(env, ev, "region", rgn);
    }
    data->events.push_back(RefValue(env, ev));
    return true;
  }

  if (main_ab == nullptr) return false;

  ImageInfo ev_info = info;
  napi_value final_pixels_ab = main_ab;
  bool needs_xform = had_region || (ds > 1u);
  if (needs_xform) {
    std::vector<uint8_t> work;
    transform_fused(static_cast<const uint8_t*>(main_data), ev_info, region, ds, format, work);
    void* outd = nullptr;
    napi_value out_ab;
    napi_create_arraybuffer(env, work.size(), &outd, &out_ab);
    if (!work.empty() && outd) memcpy(outd, work.data(), work.size());
    final_pixels_ab = out_ab;
  }
  napi_value final = MakeImageEventWithAB(env, "final", "final", ev_info, format, final_pixels_ab);
  if (had_region) {
    napi_value rgn;
    napi_create_object(env, &rgn);
    napi_set_named_property(env, rgn, "x", MakeUint32(env, region->x));
    napi_set_named_property(env, rgn, "y", MakeUint32(env, region->y));
    napi_set_named_property(env, rgn, "w", MakeUint32(env, ev_info.width));
    napi_set_named_property(env, rgn, "h", MakeUint32(env, ev_info.height));
    napi_set_named_property(env, final, "region", rgn);
  }
  if (decode_extra_channels && !ec_planes.empty()) {
    napi_value arr;
    napi_create_array_with_length(env, ec_planes.size(), &arr);
    for (size_t i = 0; i < ec_planes.size(); ++i) {
      napi_value ab = MakeArrayBuffer(env, ec_planes[i].data(), ec_planes[i].size());
      napi_set_element(env, arr, static_cast<uint32_t>(i), ab);
    }
    napi_set_named_property(env, final, "extraPlanes", arr);
  }
  data->events.push_back(RefValue(env, final));
  return true;
}

static bool EncodeAll(napi_env env, EncoderData* data, std::vector<uint8_t>* out) {
  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return false;

#if CASABIO_HAVE_JXL_THREADS
  void* runner = JxlThreadParallelRunnerCreate(nullptr, JxlThreadParallelRunnerDefaultNumWorkerThreads());
  ThreadRunnerGuard runner_guard(runner);
  if (runner) {
    if (JxlEncoderSetParallelRunner(enc, JxlThreadParallelRunner, runner) != JXL_ENC_SUCCESS) {
      // ignore
    }
  }
#endif

  const uint32_t bits = BitsForFormat(data->format);
  const uint32_t exp_bits = ExponentBitsForFormat(data->format);
  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize = data->width;
  info.ysize = data->height;
  info.bits_per_sample = bits;
  info.exponent_bits_per_sample = exp_bits;
  info.num_color_channels = 3;
  const uint32_t alpha_ec_count = data->has_alpha ? 1u : 0u;
  const uint32_t extra_ec_count = static_cast<uint32_t>(data->extra_channels.size());
  info.num_extra_channels = alpha_ec_count + extra_ec_count;
  info.alpha_bits = data->has_alpha ? bits : 0;
  info.alpha_exponent_bits = data->has_alpha ? exp_bits : 0;
  
  // NV-12 / 3D uses_original_profile check
  if (data->distance == 0.0 || !data->icc.empty()) info.uses_original_profile = JXL_TRUE;

  if (data->has_animation && !data->frames.empty()) {
    info.have_animation = JXL_TRUE;
    info.animation.tps_numerator = data->anim_tps_num;
    info.animation.tps_denominator = data->anim_tps_den;
    info.animation.num_loops = data->anim_loops;
  }

  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc);
    return false;
  }

  // N-17: ICC profile if supplied (wide-gamut masters); else sRGB. Prerequisite for perceptual colour / herbarium fidelity.
  if (!data->icc.empty()) {
    if (JxlEncoderSetICCProfile(enc, data->icc.data(), data->icc.size()) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return false;
    }
  } else {
    JxlColorEncoding color;
    JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
    if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return false;
    }
  }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  if (data->distance == 0.0) {
    JxlEncoderSetFrameLossless(frame, JXL_TRUE);
  }
  JxlEncoderSetFrameDistance(frame, static_cast<float>(data->distance));
  if (JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(data->effort)) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc);
    return false;
  }

  // N-18: map progressive:true to frame settings so that decoder can emit progression events for our own encodes.
  if (data->progressive) {
    JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PROGRESSIVE_AC, 1);
    JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_QPROGRESSIVE_AC, 1);
    JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PROGRESSIVE_DC, 1);
  }
  // previewFirst / chunked remain unimplemented (one-line comments per N-18; silent ignore is the documented gap, not a drop)

  // Escape hatch for advancedFrameSettings (patches etc.)
  if (!data->advanced_setting_ids.empty() &&
      data->advanced_setting_ids.size() == data->advanced_setting_values.size()) {
    for (size_t i = 0; i < data->advanced_setting_ids.size(); ++i) {
      if (JxlEncoderFrameSettingsSetOption(
            frame,
            static_cast<JxlEncoderFrameSettingId>(data->advanced_setting_ids[i]),
            static_cast<int64_t>(data->advanced_setting_values[i])) != JXL_ENC_SUCCESS) {
        JxlEncoderDestroy(enc);
        return false;
      }
    }
  }

  // Task 5: extra channel setup (info, name, spot, distance) - mirrors bridge.cpp exactly; additive only
  for (uint32_t i = 0; i < extra_ec_count; ++i) {
    const ExtraChannelDesc& ec = data->extra_channels[i];
    uint32_t ec_idx = alpha_ec_count + i;

    // N-22: hoist type lookup (was called twice per EC for spot check)
    JxlExtraChannelType ec_type = JxlExtraTypeFromString(ec.type);
    JxlExtraChannelInfo ec_info;
    JxlEncoderInitExtraChannelInfo(ec_type, &ec_info);
    ec_info.bits_per_sample = ec.bits_per_sample;
    ec_info.exponent_bits_per_sample = (ec.bits_per_sample > 16) ? 8u : 0u;
    ec_info.dim_shift = ec.dim_shift;

    if (ec.has_spot && ec_type == JXL_CHANNEL_SPOT_COLOR) {
      ec_info.spot_color[0] = ec.spot_r;
      ec_info.spot_color[1] = ec.spot_g;
      ec_info.spot_color[2] = ec.spot_b;
      ec_info.spot_color[3] = ec.spot_solidity;
    }

    if (JxlEncoderSetExtraChannelInfo(enc, ec_idx, &ec_info) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return false;
    }

    if (!ec.name.empty()) {
      JxlEncoderSetExtraChannelName(enc, ec_idx, ec.name.c_str(), ec.name.size());
    }

    // NV-8 extra channel distance check
    float ch_dist = (ec.distance >= 0.0) ? static_cast<float>(ec.distance) : -1.0f;
    JxlEncoderSetExtraChannelDistance(frame, ec_idx, ch_dist);
  }

  // NV-3 / 3C alpha extra channel distance setup
  if (data->has_alpha && data->alpha_distance >= 0.0) {
    JxlEncoderSetExtraChannelDistance(frame, 0, static_cast<float>(data->alpha_distance));
  }

  const uint32_t color_channels = 3u + (data->has_alpha ? 1u : 0u);
  JxlPixelFormat pf = {color_channels, DataTypeForFormat(data->format), JXL_NATIVE_ENDIAN, 0};

  // NV-3 / 3E animation encoding support
  if (data->has_animation && !data->frames.empty()) {
    const size_t bpc = BytesPerChannel(data->format);
    const size_t frame_expected = static_cast<size_t>(data->width) * data->height * color_channels * bpc;

    for (size_t fi = 0; fi < data->frames.size(); ++fi) {
      JxlFrameHeader fh;
      JxlEncoderInitFrameHeader(&fh);
      fh.duration = data->frames[fi].duration;
      fh.is_last = (fi + 1 == data->frames.size());
      JxlEncoderSetFrameHeader(frame, &fh);
      if (!data->frames[fi].name.empty()) {
        JxlEncoderSetFrameName(frame, data->frames[fi].name.c_str());
      }
      if (JxlEncoderAddImageFrame(frame, &pf, data->frames[fi].pixels.data(), frame_expected) != JXL_ENC_SUCCESS) {
        JxlEncoderDestroy(enc);
        return false;
      }
    }
  } else {
    const size_t expected = static_cast<size_t>(data->width) * data->height * color_channels * BytesPerChannel(data->format);
    // NV-14 zero-copy push check
    const uint8_t* pixels_ptr = data->pinned_input ? static_cast<const uint8_t*>(data->pinned_data) : data->pixels.data();
    const size_t pixels_size = data->pinned_input ? data->pinned_size : data->pixels.size();

    if (pixels_size != expected ||
        JxlEncoderAddImageFrame(frame, &pf, pixels_ptr, expected) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return false;
    }
  }

  // Supply extra channel plane buffers (1ch each) if caller provided 'pixels' data via duck-type
  for (uint32_t i = 0; i < extra_ec_count; ++i) {
    const ExtraChannelDesc& ec = data->extra_channels[i];
    if (ec.pixels.empty()) continue;
    uint32_t ec_idx = alpha_ec_count + i;

    JxlDataType dt = (ec.bits_per_sample == 16) ? JXL_TYPE_UINT16 : (ec.bits_per_sample == 32) ? JXL_TYPE_FLOAT : JXL_TYPE_UINT8;
    JxlPixelFormat pf_ec = {1, dt, JXL_NATIVE_ENDIAN, 0};

    if (JxlEncoderSetExtraChannelBuffer(frame, &pf_ec, ec.pixels.data(), ec.pixels.size(), ec_idx) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return false;
    }
  }

  // EXIF + XMP + customBoxes (NV-3 / 3F)
  if (!data->exif.empty() || !data->xmp.empty() || !data->custom_boxes.empty()) {
    JxlEncoderUseBoxes(enc);
    if (!data->exif.empty()) {
      const auto& e = data->exif;
      bool has_prefix = (e.size() >= 4 && e[0] == 0 && e[1] == 0 && e[2] == 0 && e[3] == 0);
      if (has_prefix) {
        JxlEncoderAddBox(enc, "Exif", e.data(), e.size(), JXL_FALSE);
      } else {
        std::vector<uint8_t> prefixed(4 + e.size());
        prefixed[0] = prefixed[1] = prefixed[2] = prefixed[3] = 0;
        if (!e.empty()) memcpy(prefixed.data() + 4, e.data(), e.size());
        JxlEncoderAddBox(enc, "Exif", prefixed.data(), prefixed.size(), JXL_FALSE);
      }
    }
    if (!data->xmp.empty()) {
      JxlEncoderAddBox(enc, "xml ", data->xmp.data(), data->xmp.size(), JXL_FALSE);
    }
    for (const auto& b : data->custom_boxes) {
      JxlEncoderAddBox(enc, b.type.c_str(), b.data.data(), b.data.size(),
                       b.compress ? JXL_TRUE : JXL_FALSE);
    }
    JxlEncoderCloseBoxes(enc);
  }

  JxlEncoderCloseInput(enc);

  // N-21: seed output buffer from heuristic (pixels/10, >=64KiB) to skip most doublings on large encodes.
  // Final MakeArrayBuffer still copies once; chunk-list avoided for simplicity (crosses port once).
  {
    size_t seed = 65536;
    const size_t pixel_bytes = static_cast<size_t>(data->width) * data->height * 4 * BytesPerChannel(data->format);
    if (pixel_bytes > 0) {
      size_t h = pixel_bytes / 10;
      if (h < 65536) h = 65536;
      seed = h;
    }
    out->assign(seed, 0);
  }
  uint8_t* next_out = out->data();
  size_t avail_out = out->size();
  for (;;) {
    JxlEncoderStatus status = JxlEncoderProcessOutput(enc, &next_out, &avail_out);
    if (status == JXL_ENC_SUCCESS) {
      out->resize(static_cast<size_t>(next_out - out->data()));
      JxlEncoderDestroy(enc);
      return true;
    }
    if (status == JXL_ENC_NEED_MORE_OUTPUT) {
      size_t offset = static_cast<size_t>(next_out - out->data());
      out->resize(out->size() * 2);
      next_out = out->data() + offset;
      avail_out = out->size() - offset;
      continue;
    }
    JxlEncoderDestroy(enc);
    return false;
  }
}
#endif

static napi_value DecoderPush(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  void* raw = nullptr;
  napi_get_cb_info(env, info, &argc, args, nullptr, &raw);
  auto* data = static_cast<DecoderData*>(raw);
  if (data == nullptr || argc < 1) return Throw(env, "decoder.push requires bytes");
  if (data->closed) return Throw(env, "decoder is already closed");
  if (data->cancelled) return Throw(env, "decoder is cancelled");
  if (!ReadBytes(env, args[0], &data->input)) return Throw(env, "decoder.push expects ArrayBuffer or Uint8Array");
  return Undefined(env);
}

static napi_value DecoderClose(napi_env env, napi_callback_info info) {
  void* raw = nullptr;
  napi_value this_arg;
  napi_get_cb_info(env, info, nullptr, nullptr, &this_arg, &raw);
  auto* data = static_cast<DecoderData*>(raw);
  if (data == nullptr) return Throw(env, "decoder is invalid");
  if (data->closed) return Undefined(env);

  // NV-11: Honor cancel at close
  if (data->cancelled) {
    std::vector<uint8_t>().swap(data->input);
    data->closed = true;
    return Undefined(env);
  }

  data->closed = true;
#if CASABIO_HAVE_LIBJXL
  napi_value options;
  napi_get_named_property(env, this_arg, "_options", &options);
  PixelFormatKind format = ParsePixelFormat(GetStringProp(env, options, "format", "rgba8"));
  std::string target_str = GetStringProp(env, options, "progressionTarget", "final");
  bool emit_every_pass = GetBoolProp(env, options, "emitEveryPass", false);
  bool decode_extra = GetBoolProp(env, options, "decodeExtraChannels", true);
  std::string prog_detail = GetStringProp(env, options, "progressiveDetail", "");
  ProgressionTarget target = ParseProgressionTarget(target_str);
  bool preserve_icc = GetBoolProp(env, options, "preserveIcc", false);

  // N-12: region/downsample (post-decode for native; libjxl direct ROI is in WASM bridge only)
  Region reg{0, 0, 0, 0};
  bool has_region = false;
  napi_value regv;
  if (GetProp(env, options, "region", &regv)) {
    napi_valuetype rt;
    napi_typeof(env, regv, &rt);
    if (rt == napi_object) {
      uint32_t x = GetUint32Prop(env, regv, "x", 0);
      uint32_t y = GetUint32Prop(env, regv, "y", 0);
      uint32_t w = GetUint32Prop(env, regv, "w", 0);
      uint32_t h = GetUint32Prop(env, regv, "h", 0);
      if (w > 0 && h > 0) {
        reg = Region{x, y, w, h};
        has_region = true;
      }
    }
  }
  uint32_t downsample = GetUint32Prop(env, options, "downsample", 1);
  if (downsample != 1 && downsample != 2 && downsample != 4 && downsample != 8) downsample = 1;

  // NV-6: Clear+shrink on failure path / No silent false
  if (!DecodeAll(env, data, format, target, emit_every_pass, decode_extra, prog_detail, has_region ? &reg : nullptr, downsample, preserve_icc)) {
    bool pending = false;
    napi_is_exception_pending(env, &pending);
    if (!pending) ThrowCode(env, "DecodeFailed", "libjxl decode failed (internal)");
    std::vector<uint8_t>().swap(data->input);
    return nullptr;
  }
  // N-14: drop input bytes promptly after successful decode.
  std::vector<uint8_t>().swap(data->input);
  return Undefined(env);
#else
  return Throw(env, "jxl-native was built without libjxl headers");
#endif
}

static napi_value DecoderEvents(napi_env env, napi_callback_info info) {
  void* raw = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &raw);
  auto* data = static_cast<DecoderData*>(raw);
  if (data == nullptr) return Throw(env, "decoder is invalid");
  return MakeIterator(env, data->events);
}

static napi_value DecoderCancel(napi_env env, napi_callback_info info) {
  void* raw = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &raw);
  auto* data = static_cast<DecoderData*>(raw);
  if (data != nullptr) data->cancelled = true;
  return Undefined(env);
}

static napi_value DecoderDispose(napi_env env, napi_callback_info info) {
  void* raw = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &raw);
  auto* data = static_cast<DecoderData*>(raw);
  if (data != nullptr) {
    for (napi_ref ref : data->events) napi_delete_reference(env, ref);
    data->events.clear();
    std::vector<uint8_t>().swap(data->input); // NV-9 real release
  }
  return Undefined(env);
}

static void release_pinned(napi_env env, EncoderData* data) {
  if (data->pinned_input != nullptr) {
    napi_delete_reference(env, data->pinned_input);
    data->pinned_input = nullptr;
    data->pinned_data = nullptr;
    data->pinned_size = 0;
  }
}

static napi_value EncoderPushPixels(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  void* raw = nullptr;
  napi_get_cb_info(env, info, &argc, args, nullptr, &raw);
  auto* data = static_cast<EncoderData*>(raw);
  if (data == nullptr || argc < 1) return Throw(env, "encoder.pushPixels requires bytes");
  if (data->finished) return Throw(env, "encoder is already finished");
  if (data->cancelled) return Throw(env, "encoder is cancelled");

  // NV-14: zero-copy single-push fast path
  if (!data->multi_push && data->pinned_input == nullptr) {
    void* input_buf_ptr = nullptr;
    size_t input_buf_len = 0;
    bool parsed = false;
    bool is_ta = false;
    napi_is_typedarray(env, args[0], &is_ta);
    if (is_ta) {
      napi_value ab;
      size_t offset = 0;
      size_t length = 0;
      napi_typedarray_type type;
      if (napi_get_typedarray_info(env, args[0], &type, &length, &input_buf_ptr, &ab, &offset) == napi_ok) {
        size_t el_size = 1;
        if (type == napi_int16_array || type == napi_uint16_array) el_size = 2;
        else if (type == napi_int32_array || type == napi_uint32_array || type == napi_float32_array) el_size = 4;
        else if (type == napi_float64_array) el_size = 8;
        input_buf_len = length * el_size;
        parsed = true;
      }
    } else {
      if (napi_get_arraybuffer_info(env, args[0], &input_buf_ptr, &input_buf_len) == napi_ok) {
        parsed = true;
      }
    }
    
    if (parsed && input_buf_ptr != nullptr && input_buf_len > 0) {
      napi_create_reference(env, args[0], 1, &data->pinned_input);
      data->pinned_data = input_buf_ptr;
      data->pinned_size = input_buf_len;
      return Undefined(env);
    }
  }

  // Fallback or second push:
  data->multi_push = true;
  if (data->pinned_input != nullptr) {
    data->pixels.assign(static_cast<uint8_t*>(data->pinned_data), static_cast<uint8_t*>(data->pinned_data) + data->pinned_size);
    napi_delete_reference(env, data->pinned_input);
    data->pinned_input = nullptr;
    data->pinned_data = nullptr;
    data->pinned_size = 0;
  }

  if (!ReadBytes(env, args[0], &data->pixels)) return Throw(env, "encoder.pushPixels expects ArrayBuffer or Uint8Array");
  return Undefined(env);
}

static napi_value EncoderFinish(napi_env env, napi_callback_info info) {
  void* raw = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &raw);
  auto* data = static_cast<EncoderData*>(raw);
  if (data == nullptr) return Throw(env, "encoder is invalid");
  if (data->finished) return Undefined(env);
  data->finished = true;

  // NV-11: Honor cancel at finish
  if (data->cancelled) {
    release_pinned(env, data);
    std::vector<uint8_t>().swap(data->pixels);
    return ThrowCode(env, "Cancelled", "encoder is cancelled");
  }

#if CASABIO_HAVE_LIBJXL
  // NV-5 / 3A: Pixel size strict check + RGBA strip fast path
  const size_t bpc = BytesPerChannel(data->format);
  const uint32_t ch = 3u + (data->has_alpha ? 1u : 0u);
  const size_t expected = (size_t)data->width * data->height * ch * bpc;

  if (data->has_animation) {
    for (size_t i = 0; i < data->frames.size(); ++i) {
      auto& f = data->frames[i];
      if (f.pixels.size() != expected) {
        const size_t rgba_size = (size_t)data->width * data->height * 4u * bpc;
        if (!data->has_alpha && f.pixels.size() == rgba_size) {
          uint8_t* p = f.pixels.data();
          const size_t px = (size_t)data->width * data->height;
          for (size_t j = 0; j < px; ++j) {
            std::memmove(p + j * 3 * bpc, p + j * 4 * bpc, 3 * bpc);
          }
          f.pixels.resize(expected);
        } else {
          release_pinned(env, data);
          return ThrowCode(env, "PixelSizeMismatch", "Frame pushPixels byte length does not match width*height*channels*bpc");
        }
      }
    }
  } else {
    const size_t actual_size = data->pinned_input ? data->pinned_size : data->pixels.size();
    if (actual_size != expected) {
      const size_t rgba_size = (size_t)data->width * data->height * 4u * bpc;
      if (!data->has_alpha && actual_size == rgba_size) {
        // Fallback from zero copy to copy path so we can strip safely in our own buffer
        if (data->pinned_input) {
          data->pixels.assign(static_cast<uint8_t*>(data->pinned_data), static_cast<uint8_t*>(data->pinned_data) + data->pinned_size);
          napi_delete_reference(env, data->pinned_input);
          data->pinned_input = nullptr;
          data->pinned_data = nullptr;
          data->pinned_size = 0;
        }
        uint8_t* p = data->pixels.data();
        const size_t px = (size_t)data->width * data->height;
        for (size_t i = 0; i < px; ++i) {
          std::memmove(p + i * 3 * bpc, p + i * 4 * bpc, 3 * bpc);
        }
        data->pixels.resize(expected);
      } else {
        release_pinned(env, data);
        return ThrowCode(env, "PixelSizeMismatch", "pushPixels byte length does not match width*height*channels*bpc");
      }
    }
  }

  std::vector<uint8_t> out;
  bool ok = EncodeAll(env, data, &out);
  release_pinned(env, data); // release ref immediately
  if (!ok) return ThrowCode(env, "EncodeFailed", "libjxl encode failed");

  napi_value chunk = MakeArrayBuffer(env, out.data(), out.size());
  data->chunks.push_back(RefValue(env, chunk));
  return Undefined(env);
#else
  return Throw(env, "jxl-native was built without libjxl headers");
#endif
}

static napi_value EncoderChunks(napi_env env, napi_callback_info info) {
  void* raw = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &raw);
  auto* data = static_cast<EncoderData*>(raw);
  if (data == nullptr) return Throw(env, "encoder is invalid");
  return MakeIterator(env, data->chunks);
}

static napi_value EncoderCancel(napi_env env, napi_callback_info info) {
  void* raw = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &raw);
  auto* data = static_cast<EncoderData*>(raw);
  if (data != nullptr) data->cancelled = true;
  return Undefined(env);
}

static napi_value EncoderDispose(napi_env env, napi_callback_info info) {
  void* raw = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &raw);
  auto* data = static_cast<EncoderData*>(raw);
  if (data != nullptr) {
    for (napi_ref ref : data->chunks) napi_delete_reference(env, ref);
    data->chunks.clear();
    release_pinned(env, data);
    // NV-9: release capacities with swap
    std::vector<uint8_t>().swap(data->pixels);
    std::vector<uint8_t>().swap(data->icc);
    std::vector<uint8_t>().swap(data->exif);
    std::vector<uint8_t>().swap(data->xmp);
    std::vector<ExtraChannelDesc>().swap(data->extra_channels);
    std::vector<EncoderData::CustomBoxDesc>().swap(data->custom_boxes);
    std::vector<EncoderData::FrameDesc>().swap(data->frames);
  }
  return Undefined(env);
}

static void DecoderFinalize(napi_env env, void* raw, void*) {
  auto* data = static_cast<DecoderData*>(raw);
  if (data == nullptr) return;
  for (napi_ref ref : data->events) napi_delete_reference(env, ref);
  delete data;
}

static void EncoderFinalize(napi_env env, void* raw, void*) {
  auto* data = static_cast<EncoderData*>(raw);
  if (data == nullptr) return;
  for (napi_ref ref : data->chunks) napi_delete_reference(env, ref);
  if (data->pinned_input != nullptr) {
    napi_delete_reference(env, data->pinned_input);
  }
  delete data;
}

static void SetMethod(napi_env env, napi_value object, const char* name, napi_callback cb, void* data) {
  napi_value fn;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, data, &fn);
  napi_set_named_property(env, object, name, fn);
}

static napi_value Version(napi_env env, napi_callback_info) {
  // N-16: append runtime libjxl version (maj*1e6 + min*1e3 + patch) for diagnosability.
  // Static prefix kept for semver of the binding itself.
#if CASABIO_HAVE_LIBJXL
  uint32_t v = JxlDecoderVersion();
  char buf[64];
  // snprintf is available; keep simple.
  int n = snprintf(buf, sizeof(buf), "0.1.0-libjxl+%u.%u.%u", v / 1000000u, (v / 1000u) % 1000u, v % 1000u);
  if (n > 0 && n < (int)sizeof(buf)) return MakeString(env, buf);
#endif
  return MakeString(env, "0.1.0-libjxl");
}

static napi_value Probe(napi_env env, napi_callback_info) {
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "loaded", MakeBool(env, CASABIO_HAVE_LIBJXL == 1));
  // N-16: return a path-like identifier (not the literal phrase) so upper layers see a module-ish "path".
  // Real fs path to the .node is resolved in index.ts loadNativeBinding (candidate that succeeded).
  napi_set_named_property(env, result, "path", MakeString(env, CASABIO_HAVE_LIBJXL ? "jxl-native.node" : "libjxl unavailable"));
  return result;
}

static napi_value CreateDecoder(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) return Throw(env, "createDecoder requires options");
  auto* data = new DecoderData();
  napi_value object;
  napi_create_object(env, &object);
  napi_wrap(env, object, data, DecoderFinalize, nullptr, nullptr);
  napi_set_named_property(env, object, "_options", args[0]);
  SetMethod(env, object, "push", DecoderPush, data);
  SetMethod(env, object, "close", DecoderClose, data);
  SetMethod(env, object, "events", DecoderEvents, data);
  SetMethod(env, object, "cancel", DecoderCancel, data);
  SetMethod(env, object, "dispose", DecoderDispose, data);
  return object;
}

static napi_value CreateEncoder(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) return Throw(env, "createEncoder requires options");

  auto* data = new EncoderData();
  data->format = ParsePixelFormat(GetStringProp(env, args[0], "format", "rgba8"));
  data->width = GetUint32Prop(env, args[0], "width", 0);
  data->height = GetUint32Prop(env, args[0], "height", 0);
  data->has_alpha = GetBoolProp(env, args[0], "hasAlpha", true);
  double quality = GetNullableNumberProp(env, args[0], "quality", -1.0);
#if CASABIO_HAVE_LIBJXL
  double default_distance = (quality < 0.0) ? 1.0
      : static_cast<double>(JxlEncoderDistanceFromQuality(static_cast<float>(quality)));
#else
  double default_distance = (quality >= 100.0) ? 0.0 : 1.0;
#endif
  
  // NV-20 distance clamp [0.0, 25.0]
  data->distance = GetNullableNumberProp(env, args[0], "distance", default_distance);
  if (data->distance < 0.0) data->distance = 0.0;
  if (data->distance > 25.0) data->distance = 25.0;

  // NV-20 effort clamp [1, 9]
  data->effort = GetUint32Prop(env, args[0], "effort", 7);
  if (data->effort < 1) data->effort = 1;
  if (data->effort > 9) data->effort = 9;

  // N-17: read declared metadata/ICC buffers (nulls mean absent). Use GetProp to avoid MakeString temps (N-22).
  napi_value iccv, exifv, xmpv;
  if (GetProp(env, args[0], "iccProfile", &iccv)) {
    napi_valuetype t; napi_typeof(env, iccv, &t);
    if (t != napi_null && t != napi_undefined) {
      std::vector<uint8_t> buf;
      if (ReadBytes(env, iccv, &buf)) data->icc = std::move(buf);
    }
  }
  if (GetProp(env, args[0], "exif", &exifv)) {
    napi_valuetype t; napi_typeof(env, exifv, &t);
    if (t != napi_null && t != napi_undefined) {
      std::vector<uint8_t> buf;
      if (ReadBytes(env, exifv, &buf)) data->exif = std::move(buf);
    }
  }
  if (GetProp(env, args[0], "xmp", &xmpv)) {
    napi_valuetype t; napi_typeof(env, xmpv, &t);
    if (t != napi_null && t != napi_undefined) {
      std::vector<uint8_t> buf;
      if (ReadBytes(env, xmpv, &buf)) data->xmp = std::move(buf);
    }
  }

  data->progressive = GetBoolProp(env, args[0], "progressive", false);

  // Parse advancedFrameSettings escape hatch (array of {id, value})
  napi_value adv;
  if (GetProp(env, args[0], "advancedFrameSettings", &adv)) {
    bool is_array = false;
    napi_is_array(env, adv, &is_array);
    if (is_array) {
      uint32_t len = 0;
      napi_get_array_length(env, adv, &len);
      if (len > 0) {
        std::vector<int32_t> ids(len);
        std::vector<int32_t> values(len);
        for (uint32_t i = 0; i < len; ++i) {
          napi_value item;
          napi_get_element(env, adv, i, &item);
          ids[i] = GetInt32Prop(env, item, "id", 0);
          values[i] = GetInt32Prop(env, item, "value", 0);
        }
        data->advanced_setting_ids = std::move(ids);
        data->advanced_setting_values = std::move(values);
      }
    }
  }

  // Task 5: parse extraChannels array (additive, 0-EC unchanged). Supports descriptors + optional 'pixels' for plane data (duck-type for native higher-level, preserves ExtraChannel TS shape for parity).
  napi_value ec_arr;
  if (GetProp(env, args[0], "extraChannels", &ec_arr)) {
    bool is_array = false;
    napi_is_array(env, ec_arr, &is_array);
    if (is_array) {
      uint32_t len = 0;
      napi_get_array_length(env, ec_arr, &len);
      data->extra_channels.reserve(len);
      for (uint32_t i = 0; i < len; ++i) {
        napi_value item;
        napi_get_element(env, ec_arr, i, &item);
        ExtraChannelDesc d;
        d.type = GetStringProp(env, item, "type", "unknown");
        d.bits_per_sample = GetUint32Prop(env, item, "bitsPerSample", 8);
        d.dim_shift = GetUint32Prop(env, item, "dimShift", 0);
        d.name = GetStringProp(env, item, "name", "");
        d.distance = GetNullableNumberProp(env, item, "distance", -1.0);

        napi_value spotv;
        if (GetProp(env, item, "spotColor", &spotv)) {
          napi_valuetype st;
          napi_typeof(env, spotv, &st);
          if (st == napi_object) {
            d.has_spot = true;
            d.spot_r = static_cast<float>(GetNullableNumberProp(env, spotv, "red", 0.0));
            d.spot_g = static_cast<float>(GetNullableNumberProp(env, spotv, "green", 0.0));
            d.spot_b = static_cast<float>(GetNullableNumberProp(env, spotv, "blue", 0.0));
            d.spot_solidity = static_cast<float>(GetNullableNumberProp(env, spotv, "solidity", 0.0));
          }
        }

        napi_value datav;
        if (GetProp(env, item, "pixels", &datav) || GetProp(env, item, "data", &datav)) {
          napi_valuetype dt;
          napi_typeof(env, datav, &dt);
          if (dt != napi_null && dt != napi_undefined) {
            std::vector<uint8_t> plane;
            if (ReadBytes(env, datav, &plane)) {
              d.pixels = std::move(plane);
            }
          }
        }

        data->extra_channels.push_back(std::move(d));
      }
    }
  }

  // NV-3 / 3C alphaDistance
  data->alpha_distance = GetNullableNumberProp(env, args[0], "alphaDistance", -1.0);

  // NV-3 / 3E animation encode options
  napi_value anim;
  if (GetProp(env, args[0], "animation", &anim)) {
    napi_valuetype t;
    napi_typeof(env, anim, &t);
    if (t == napi_object) {
      data->has_animation = true;
      double tps = GetNullableNumberProp(env, anim, "ticksPerSecond", 1.0);
      if (tps <= 0.0) tps = 1.0;
      data->anim_tps_num = static_cast<uint32_t>(tps);
      data->anim_tps_den = 1;
      data->anim_loops = static_cast<int32_t>(GetNullableNumberProp(env, anim, "loopCount", 0.0));
    }
  }

  napi_value frames_arr;
  if (GetProp(env, args[0], "frames", &frames_arr)) {
    bool is_array = false;
    napi_is_array(env, frames_arr, &is_array);
    if (is_array) {
      data->has_animation = true;
      uint32_t len = 0;
      napi_get_array_length(env, frames_arr, &len);
      data->frames.reserve(len);
      for (uint32_t i = 0; i < len; ++i) {
        napi_value item;
        napi_get_element(env, frames_arr, i, &item);
        EncoderData::FrameDesc fd;
        fd.duration = static_cast<uint32_t>(GetNullableNumberProp(env, item, "duration", 1.0));
        fd.name = GetStringProp(env, item, "name", "");
        napi_value fdatav;
        if (GetProp(env, item, "data", &fdatav)) {
          ReadBytes(env, fdatav, &fd.pixels);
        }
        data->frames.push_back(std::move(fd));
      }
    }
  }

  // NV-3 / 3F customBoxes
  napi_value cb_arr;
  if (GetProp(env, args[0], "customBoxes", &cb_arr)) {
    bool is_array = false;
    napi_is_array(env, cb_arr, &is_array);
    if (is_array) {
      uint32_t len = 0;
      napi_get_array_length(env, cb_arr, &len);
      data->custom_boxes.reserve(len);
      for (uint32_t i = 0; i < len; ++i) {
        napi_value item;
        napi_get_element(env, cb_arr, i, &item);
        EncoderData::CustomBoxDesc cb;
        cb.type = GetStringProp(env, item, "type", "");
        if (cb.type.size() != 4) {
          release_pinned(env, data);
          return ThrowCode(env, "InvalidBoxType", "custom box type must be exactly 4 characters");
        }
        cb.compress = GetBoolProp(env, item, "compress", false);
        napi_value bdatav;
        if (GetProp(env, item, "data", &bdatav)) {
          ReadBytes(env, bdatav, &cb.data);
        }
        data->custom_boxes.push_back(std::move(cb));
      }
    }
  }

  napi_value object;
  napi_create_object(env, &object);
  napi_wrap(env, object, data, EncoderFinalize, nullptr, nullptr);
  SetMethod(env, object, "pushPixels", EncoderPushPixels, data);
  SetMethod(env, object, "finish", EncoderFinish, data);
  SetMethod(env, object, "chunks", EncoderChunks, data);
  SetMethod(env, object, "cancel", EncoderCancel, data);
  SetMethod(env, object, "dispose", EncoderDispose, data);
  return object;
}

static napi_value Init(napi_env env, napi_value exports) {
  SetMethod(env, exports, "version", Version, nullptr);
  SetMethod(env, exports, "probe", Probe, nullptr);
  SetMethod(env, exports, "createDecoder", CreateDecoder, nullptr);
  SetMethod(env, exports, "createEncoder", CreateEncoder, nullptr);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
