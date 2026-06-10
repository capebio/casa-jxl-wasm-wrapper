#include <node_api.h>

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <string>
#include <vector>

#if __has_include(<jxl/decode.h>) && __has_include(<jxl/encode.h>)
#define CASABIO_HAVE_LIBJXL 1
#include <jxl/color_encoding.h>
#include <jxl/decode.h>
#include <jxl/encode.h>
#include <jxl/types.h>
#else
#define CASABIO_HAVE_LIBJXL 0
#endif

namespace {

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
// N-12 helpers (post-decode crop + box). Declared early so DecodeAll can call them.
static void crop_to_region(std::vector<uint8_t>& buf, ImageInfo& info, const Region& r, uint32_t bpp);
static void box_downsample_inplace(std::vector<uint8_t>& buf, ImageInfo& info, uint32_t ds, PixelFormatKind fmt);

// Full definitions for the N-12 helpers (must appear before DecodeAll use in this TU).
static void crop_to_region(std::vector<uint8_t>& buf, ImageInfo& info, const Region& r, uint32_t bpp) {
  uint32_t sx = r.x, sy = r.y, sw = r.w, sh = r.h;
  if (sx >= info.width || sy >= info.height || sw == 0 || sh == 0) {
    buf.clear();
    info.width = 0;
    info.height = 0;
    return;
  }
  sw = std::min(sw, info.width - sx);
  sh = std::min(sh, info.height - sy);
  if (sw == 0 || sh == 0) {
    buf.clear();
    info.width = 0;
    info.height = 0;
    return;
  }
  const size_t src_row = static_cast<size_t>(info.width) * bpp;
  std::vector<uint8_t> out(static_cast<size_t>(sw) * sh * bpp);
  for (uint32_t y = 0; y < sh; ++y) {
    const uint8_t* src = buf.data() + (sy + y) * src_row + sx * bpp;
    std::memcpy(out.data() + y * static_cast<size_t>(sw) * bpp, src, sw * bpp);
  }
  buf = std::move(out);
  info.width = sw;
  info.height = sh;
}

static void box_downsample_inplace(std::vector<uint8_t>& buf, ImageInfo& info, uint32_t ds, PixelFormatKind fmt) {
  if (ds <= 1u) return;
  const uint32_t bpc = BytesPerChannel(fmt);
  const uint32_t bpp = 4u * bpc;
  const uint32_t sw = info.width;
  const uint32_t sh = info.height;
  const uint32_t dw = std::max(1u, (sw + ds - 1u) / ds);
  const uint32_t dh = std::max(1u, (sh + ds - 1u) / ds);
  std::vector<uint8_t> out(static_cast<size_t>(dw) * dh * bpp, 0);
  if (fmt == PixelFormatKind::Rgba8) {
    for (uint32_t y = 0; y < dh; ++y) {
      for (uint32_t x = 0; x < dw; ++x) {
        uint32_t sum[4] = {0};
        uint32_t cnt = 0;
        for (uint32_t yy = 0; yy < ds; ++yy) {
          uint32_t sy = y * ds + yy; if (sy >= sh) break;
          for (uint32_t xx = 0; xx < ds; ++xx) {
            uint32_t sx = x * ds + xx; if (sx >= sw) break;
            const uint8_t* p = buf.data() + (sy * sw + sx) * 4;
            sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; sum[3] += p[3];
            ++cnt;
          }
        }
        uint8_t* d = out.data() + (y * dw + x) * 4;
        if (cnt > 0) {
          d[0] = static_cast<uint8_t>(sum[0] / cnt);
          d[1] = static_cast<uint8_t>(sum[1] / cnt);
          d[2] = static_cast<uint8_t>(sum[2] / cnt);
          d[3] = static_cast<uint8_t>(sum[3] / cnt);
        }
      }
    }
  } else if (fmt == PixelFormatKind::Rgba16) {
    for (uint32_t y = 0; y < dh; ++y) {
      for (uint32_t x = 0; x < dw; ++x) {
        uint32_t sum[4] = {0};
        uint32_t cnt = 0;
        for (uint32_t yy = 0; yy < ds; ++yy) {
          uint32_t sy = y * ds + yy; if (sy >= sh) break;
          for (uint32_t xx = 0; xx < ds; ++xx) {
            uint32_t sx = x * ds + xx; if (sx >= sw) break;
            const uint16_t* p = reinterpret_cast<const uint16_t*>(buf.data() + (sy * sw + sx) * 8);
            sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; sum[3] += p[3];
            ++cnt;
          }
        }
        uint16_t* d = reinterpret_cast<uint16_t*>(out.data() + (y * dw + x) * 8);
        if (cnt > 0) {
          d[0] = static_cast<uint16_t>(sum[0] / cnt);
          d[1] = static_cast<uint16_t>(sum[1] / cnt);
          d[2] = static_cast<uint16_t>(sum[2] / cnt);
          d[3] = static_cast<uint16_t>(sum[3] / cnt);
        }
      }
    }
  } else { // rgbaf32
    for (uint32_t y = 0; y < dh; ++y) {
      for (uint32_t x = 0; x < dw; ++x) {
        float sum[4] = {0.f};
        uint32_t cnt = 0;
        for (uint32_t yy = 0; yy < ds; ++yy) {
          uint32_t sy = y * ds + yy; if (sy >= sh) break;
          for (uint32_t xx = 0; xx < ds; ++xx) {
            uint32_t sx = x * ds + xx; if (sx >= sw) break;
            const float* p = reinterpret_cast<const float*>(buf.data() + (sy * sw + sx) * 16);
            sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; sum[3] += p[3];
            ++cnt;
          }
        }
        float* d = reinterpret_cast<float*>(out.data() + (y * dw + x) * 16);
        if (cnt > 0) {
          d[0] = sum[0] / cnt;
          d[1] = sum[1] / cnt;
          d[2] = sum[2] / cnt;
          d[3] = sum[3] / cnt;
        }
      }
    }
  }
  buf = std::move(out);
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
static bool DecodeAll(napi_env env, DecoderData* data, PixelFormatKind format, ProgressionTarget target, bool emit_every_pass, bool decode_extra_channels, const std::string& progressive_detail, const Region* region, uint32_t downsample) {
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) return false;

  int events = JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE;
  if (emit_every_pass || target == ProgressionTarget::Dc || target == ProgressionTarget::Pass) {
    events |= JXL_DEC_FRAME_PROGRESSION;
  }
  if (JxlDecoderSubscribeEvents(dec, events) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec);
    return false;
  }

  // N-11: map progressiveDetail (or fallback from emit/target) to the correct JxlProgressiveDetail.
  // Verified against jxl/decode.h + WASM bridge.cpp mapping + jxl-core types comments.
  JxlProgressiveDetail jd = kDC;
  if (progressive_detail == "lastPasses") jd = kLastPasses;
  else if (progressive_detail == "passes") jd = kPasses;
  else if (progressive_detail == "dcProgressive") jd = kDCProgressive;
  else if (emit_every_pass || target == ProgressionTarget::Pass) jd = kLastPasses;
  // else dc / default -> kDC
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
      // N-16: report output depth (via format + BitsForFormat) to match WASM facade + jxl-core ImageInfo
      // expectations on DecodeFrameEvent.info. Source depth (basic.bits_per_sample) would mismatch buffer
      // when downcasting (e.g. 16-bit source -> rgba8 decode). Parity wins; format describes the buffer.
      info.bits_per_sample = BitsForFormat(format);
      info.has_alpha = basic.alpha_bits > 0;
      info.has_animation = basic.have_animation;
      // JPEG reconstruction (extracting original JPEG bytes) is out of scope for this pixel decoder binding.
      // No JXL_DEC_JPEG_RECONSTRUCTION subscription; consumers that need embedded JPEG should use WASM bridge or cjxl.
      info.jpeg_reconstruction_available = false;

      // Task 5: collect extra channel descriptors (symmetric to WASM bridge; only metadata, no plane data here)
      uint32_t n_ec = basic.num_extra_channels;
      for (uint32_t i = 0; i < n_ec; ++i) {
        JxlExtraChannelInfo ei{};
        if (JxlDecoderGetExtraChannelInfo(dec, i, &ei) == JXL_DEC_SUCCESS) {
          ImageInfo::DecodedExtra d{};
          // N-22: unified via JxlExtraTypeName table (no duplicate if/else)
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
      napi_value header = MakeHeaderEvent(env, info);
      data->events.push_back(RefValue(env, header));
      if (target == ProgressionTarget::Header) {
        JxlDecoderDestroy(dec);
        return true;
      }
      continue;
    }
    if (status == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t buffer_size = 0;
      if (JxlDecoderImageOutBufferSize(dec, &pf, &buffer_size) != JXL_DEC_SUCCESS) {
        JxlDecoderDestroy(dec);
        return false;
      }
      // N-13: allocate AB up front; libjxl writes final directly here (saves final copy when no region/ds).
      // Progress snapshots still use temp flush ABs (or direct when no xform).
      napi_create_arraybuffer(env, buffer_size, &main_data, &main_ab);
      main_size = buffer_size;
      if (JxlDecoderSetImageOutBuffer(dec, &pf, main_data, main_size) != JXL_DEC_SUCCESS) {
        JxlDecoderDestroy(dec);
        return false;
      }
      // N-20: extract extra channel planes (1ch each) when opt-in. pf_ec per channel bps.
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
      // N-10: early exit for dc (and pass) targets when !emitEveryPass — stops wasted full decode work for
      // thumbnail/embedding/AR-preview (Lenses) and pyramid tile paths. Matches browser facade semantics:
      // low-level events() yields [header, progress-with-stage] then ends; no "final" event for non-final targets.
      // Handler finally + decode-session frames() contract treat the target progress as terminal (no decode_final posted).
      const char* prog_stage = (target == ProgressionTarget::Dc) ? "dc" : "pass";
      napi_value prog_ev_ab = nullptr;
      ImageInfo ev_info = info;
      bool needs_xform = had_region || (ds > 1u);
      if (needs_xform) {
        // Flush to a full-size snap, then post-xform copy into event-sized AB (post-decode crop/ds cost is accepted for native).
        void* snap = nullptr;
        napi_value snap_ab;
        napi_create_arraybuffer(env, main_size, &snap, &snap_ab);
        if (JxlDecoderSetImageOutBuffer(dec, &pf, snap, main_size) == JXL_DEC_SUCCESS &&
            JxlDecoderFlushImage(dec) == JXL_DEC_SUCCESS) {
          std::vector<uint8_t> work(static_cast<uint8_t*>(snap), static_cast<uint8_t*>(snap) + main_size);
          if (had_region && region) crop_to_region(work, ev_info, *region, bytes_per_pixel);
          if (ds > 1u) box_downsample_inplace(work, ev_info, ds, format);
          void* outd = nullptr;
          napi_value out_ab;
          napi_create_arraybuffer(env, work.size(), &outd, &out_ab);
          if (!work.empty() && outd) memcpy(outd, work.data(), work.size());
          prog_ev_ab = out_ab;
          // restore main target for any continued decode (emitEvery case)
          JxlDecoderSetImageOutBuffer(dec, &pf, main_data, main_size);
        }
      } else {
        // N-13: direct flush into event AB (eliminates the flushed-vec + MakeArrayBuffer memcpy per progress)
        void* snap = nullptr;
        napi_value snap_ab;
        napi_create_arraybuffer(env, main_size, &snap, &snap_ab);
        if (JxlDecoderSetImageOutBuffer(dec, &pf, snap, main_size) == JXL_DEC_SUCCESS &&
            JxlDecoderFlushImage(dec) == JXL_DEC_SUCCESS) {
          prog_ev_ab = snap_ab;
          JxlDecoderSetImageOutBuffer(dec, &pf, main_data, main_size);
        }
      }
      if (prog_ev_ab != nullptr) {
        napi_value progress = MakeImageEventWithAB(env, "progress", prog_stage, ev_info, format, prog_ev_ab);
        if (had_region) {
          napi_value rgn;
          napi_create_object(env, &rgn);
          napi_set_named_property(env, rgn, "x", MakeUint32(env, 0));
          napi_set_named_property(env, rgn, "y", MakeUint32(env, 0));
          napi_set_named_property(env, rgn, "w", MakeUint32(env, ev_info.width));
          napi_set_named_property(env, rgn, "h", MakeUint32(env, ev_info.height));
          napi_set_named_property(env, progress, "region", rgn);
        }
        data->events.push_back(RefValue(env, progress));
      }
      // N-10 early terminal for dc/pass when not emitting every pass (matches WASM facade early return after target progress)
      if (!emit_every_pass && target != ProgressionTarget::Final) {
        JxlDecoderDestroy(dec);
        return true;
      }
      continue;
    }
    if (status == JXL_DEC_FULL_IMAGE) continue;
  }

  JxlDecoderDestroy(dec);
  if (!info_known || main_ab == nullptr) return false;

  // Final emission (N-13 direct path when possible; N-12 xform applied post)
  ImageInfo ev_info = info;
  napi_value final_pixels_ab = main_ab;
  size_t final_bytes = main_size;
  bool needs_xform = had_region || (ds > 1u);
  if (needs_xform) {
    std::vector<uint8_t> work(static_cast<uint8_t*>(main_data), static_cast<uint8_t*>(main_data) + main_size);
    if (had_region && region) crop_to_region(work, ev_info, *region, bytes_per_pixel);
    if (ds > 1u) box_downsample_inplace(work, ev_info, ds, format);
    void* outd = nullptr;
    napi_value out_ab;
    napi_create_arraybuffer(env, work.size(), &outd, &out_ab);
    if (!work.empty() && outd) memcpy(outd, work.data(), work.size());
    final_pixels_ab = out_ab;
    final_bytes = work.size();
  }
  napi_value final = MakeImageEventWithAB(env, "final", "final", ev_info, format, final_pixels_ab);
  if (had_region) {
    napi_value rgn;
    napi_create_object(env, &rgn);
    napi_set_named_property(env, rgn, "x", MakeUint32(env, 0));
    napi_set_named_property(env, rgn, "y", MakeUint32(env, 0));
    napi_set_named_property(env, rgn, "w", MakeUint32(env, ev_info.width));
    napi_set_named_property(env, rgn, "h", MakeUint32(env, ev_info.height));
    napi_set_named_property(env, final, "region", rgn);
  }
  // N-20: attach extraPlanes on final (gated; depth/thermal etc for photogrammetry/ecology)
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

static bool EncodeAll(EncoderData* data, std::vector<uint8_t>* out) {
  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return false;

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
  if (data->distance == 0.0) info.uses_original_profile = JXL_TRUE;

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

    float ch_dist = (ec.distance > 0.0) ? static_cast<float>(ec.distance) : -1.0f;
    JxlEncoderSetExtraChannelDistance(frame, ec_idx, ch_dist);
  }

  const uint32_t color_channels = 3u + (data->has_alpha ? 1u : 0u);
  JxlPixelFormat pf = {color_channels, DataTypeForFormat(data->format), JXL_NATIVE_ENDIAN, 0};
  const size_t expected = static_cast<size_t>(data->width) * data->height * color_channels * BytesPerChannel(data->format);
  if (data->pixels.size() < expected ||
      JxlEncoderAddImageFrame(frame, &pf, data->pixels.data(), expected) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc);
    return false;
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

  // N-17: EXIF (with 4-byte BE TIFF offset prefix if raw) + XMP boxes. GPS etc must survive for georeferenced / Lens 12/14.
  if (!data->exif.empty() || !data->xmp.empty()) {
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
  data->closed = true;
#if CASABIO_HAVE_LIBJXL
  napi_value options;
  napi_get_named_property(env, this_arg, "_options", &options);
  PixelFormatKind format = ParsePixelFormat(GetStringProp(env, options, "format", "rgba8"));
  std::string target_str = GetStringProp(env, options, "progressionTarget", "final");
  bool emit_every_pass = GetBoolProp(env, options, "emitEveryPass", false);
  bool decode_extra = GetBoolProp(env, options, "decodeExtraChannels", false);
  std::string prog_detail = GetStringProp(env, options, "progressiveDetail", "");
  ProgressionTarget target = ParseProgressionTarget(target_str);

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

  // N-19: ...
  if (!DecodeAll(env, data, format, target, emit_every_pass, decode_extra, prog_detail, has_region ? &reg : nullptr, downsample)) {
    return nullptr;
  }
  // N-14: drop (potentially hundreds of MB) input bytes promptly after successful decode.
  // The vector would otherwise live until dispose()/GC. shrink_to_fit releases the reservation.
  data->input.clear();
  data->input.shrink_to_fit();
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
    data->input.clear();
  }
  return Undefined(env);
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
#if CASABIO_HAVE_LIBJXL
  std::vector<uint8_t> out;
  if (!EncodeAll(data, &out)) return ThrowCode(env, "EncodeFailed", "libjxl encode failed");
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
    data->pixels.clear();
    data->icc.clear();
    data->exif.clear();
    data->xmp.clear();
    data->extra_channels.clear();  // release any EC plane data early (additive)
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
  data->distance = GetNullableNumberProp(env, args[0], "distance", default_distance);
  data->effort = GetUint32Prop(env, args[0], "effort", 7);

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
  // previewFirst / chunked declared on EncoderOptions but remain unimplemented (N-18: document ignore, not a silent drop)

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

        // Duck-type plane pixels for encode buffer (use 'pixels' per spec guidance; also try 'data' for flexibility)
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
