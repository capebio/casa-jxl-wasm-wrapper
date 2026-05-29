#include <node_api.h>

#include <climits>
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
// JxlBool was added to jxl/types.h after v0.10.x — provide fallback.
#ifndef JxlBool
typedef int JxlBool;
#endif
// Gain map support requires libjxl built with gain map symbols (JxlGainMap*).
// Enable by passing -DCASABIO_GAIN_MAP_ENABLED during the node-gyp build.
#if __has_include(<jxl/gain_map.h>) && defined(CASABIO_GAIN_MAP_ENABLED)
#include <jxl/gain_map.h>
#define CASABIO_HAVE_GAIN_MAP 1
#else
#define CASABIO_HAVE_GAIN_MAP 0
#endif
#else
#define CASABIO_HAVE_LIBJXL 0
#define CASABIO_HAVE_GAIN_MAP 0
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
};

struct DecoderData {
  std::vector<uint8_t> input;
  std::vector<napi_ref> events;
  bool closed = false;
  bool cancelled = false;
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
  int32_t brotli_effort = -1;
  int32_t decoding_speed = -1;
  int32_t photon_noise_iso = 0;
  uint32_t resampling = 1;
  // Metadata boxes
  std::vector<uint8_t> icc_profile;
  std::vector<uint8_t> exif;
  std::vector<uint8_t> xmp;
  bool compress_boxes = false;
  bool force_container = false;
  bool raw_codestream = false;
  bool finished = false;
  bool cancelled = false;
  // Animation fields
  bool has_animation = false;
  uint32_t anim_ticks_per_second = 1000;
  uint32_t anim_loop_count = 0;
  struct AnimFrame {
    std::vector<uint8_t> pixels;
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t duration = 0;
    std::string name;
  };
  std::vector<AnimFrame> anim_frames;
  // Modular mode: -1 = auto, 0 = VarDCT, 1 = Modular
  int32_t modular = -1;
  // Modular sub-settings
  int32_t modular_group_size = -1;          // -1 = libjxl default
  int32_t modular_predictor = -1;
  int32_t modular_nb_prev_channels = -1;
  int32_t modular_palette_colors = INT32_MIN; // INT32_MIN = not set
  int32_t modular_lossy_palette = -1;       // -1 = not set
  int32_t modular_ma_tree_learning_percent = -1;
  // Raw JXL_ENC_FRAME_SETTING_* escape hatch
  struct AdvancedSetting { int32_t id; int32_t value; };
  std::vector<AdvancedSetting> advanced_frame_settings;
  // Progressive encode settings (derived from EncoderOptions.progressive / previewFirst / chunked)
  int32_t progressive_dc = 0;   // 0=none, 1=one DC pass
  int32_t progressive_ac = 0;   // 0=disabled, 1=AC progressive
  int32_t qprogressive_ac = 0;  // 0=disabled, 1=quality-progressive AC
  int32_t buffering = 0;        // 0=emit immediately, 2=buffer for chunked streaming
  // Gain map (jhgm box)
  std::vector<uint8_t> gain_map_jxl;
  // Custom metadata boxes
  struct CustomBox {
    std::string type;
    std::vector<uint8_t> data;
    bool compress = false;
  };
  std::vector<CustomBox> custom_boxes;
  // Extra channel fields
  double alpha_distance = -1.0;
  struct NativeExtraChannel {
    uint32_t type = 0; // JxlExtraChannelType value; 0=alpha, 1=depth, 2=spot, 3=selection, 15=unknown
    uint32_t bits_per_sample = 8;
    double distance = -1.0;
    std::string name;
    std::vector<uint8_t> pixels;
  };
  std::vector<NativeExtraChannel> extra_channels;
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

static uint32_t NormalizeResampling(uint32_t value) {
  return (value == 2u || value == 4u || value == 8u) ? value : 1u;
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

// Reads a nullable ArrayBuffer/Buffer property into a vector. Returns empty vector when null/absent.
static std::vector<uint8_t> GetNullableBufferProp(napi_env env, napi_value object, const char* name) {
  napi_value value;
  if (!GetProp(env, object, name, &value)) return {};
  napi_valuetype type;
  napi_typeof(env, value, &type);
  if (type == napi_null || type == napi_undefined) return {};
  void* data = nullptr;
  size_t len = 0;
  bool is_ab = false;
  napi_is_arraybuffer(env, value, &is_ab);
  if (is_ab) {
    napi_get_arraybuffer_info(env, value, &data, &len);
  } else {
    // Accept Buffer (node:buffer) which wraps as ArrayBuffer with offset.
    napi_get_buffer_info(env, value, &data, &len);
  }
  if (data == nullptr || len == 0) return {};
  return std::vector<uint8_t>(static_cast<const uint8_t*>(data),
                               static_cast<const uint8_t*>(data) + len);
}

static PixelFormatKind ParsePixelFormat(const std::string& value) {
  if (value == "rgba16") return PixelFormatKind::Rgba16;
  if (value == "rgbaf32") return PixelFormatKind::Rgbaf32;
  return PixelFormatKind::Rgba8;
}

static uint32_t ParseExtraChannelType(const std::string& type) {
  if (type == "alpha")     return 0;  // JXL_CHANNEL_ALPHA
  if (type == "depth")     return 1;  // JXL_CHANNEL_DEPTH
  if (type == "spot")      return 2;  // JXL_CHANNEL_SPOT_COLOR
  if (type == "selection") return 3;  // JXL_CHANNEL_SELECTION_MASK
  return 15;                          // JXL_CHANNEL_UNKNOWN
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

static const char* ExtraChannelTypeName(uint32_t t) {
  switch (t) {
    case 0: return "alpha";
    case 1: return "depth";
    case 2: return "spot";
    case 3: return "selection";
    case 4: return "black";
    case 5: return "cfa";
    case 6: return "thermal";
    default: return "other";
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

static napi_value MakeImageInfo(napi_env env, const ImageInfo& info) {
  napi_value object;
  napi_create_object(env, &object);
  napi_set_named_property(env, object, "width", MakeUint32(env, info.width));
  napi_set_named_property(env, object, "height", MakeUint32(env, info.height));
  napi_set_named_property(env, object, "bitsPerSample", MakeUint32(env, info.bits_per_sample));
  napi_set_named_property(env, object, "hasAlpha", MakeBool(env, info.has_alpha));
  napi_set_named_property(env, object, "hasAnimation", MakeBool(env, info.has_animation));
  napi_set_named_property(env, object, "jpegReconstructionAvailable", MakeBool(env, info.jpeg_reconstruction_available));
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
  napi_set_named_property(env, event, "info", MakeImageInfo(env, info));
  return event;
}

static napi_value MakeImageEvent(napi_env env, const char* type, const ImageInfo& info, PixelFormatKind format, const std::vector<uint8_t>& pixels) {
  napi_value event;
  napi_create_object(env, &event);
  napi_set_named_property(env, event, "type", MakeString(env, type));
  napi_set_named_property(env, event, "stage", MakeString(env, type));
  napi_set_named_property(env, event, "info", MakeImageInfo(env, info));
  napi_set_named_property(env, event, "pixels", MakeArrayBuffer(env, pixels.data(), pixels.size()));
  napi_set_named_property(env, event, "format", MakeString(env, PixelFormatName(format)));
  napi_set_named_property(env, event, "pixelStride", MakeUint32(env, 4));
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
static bool DecodeAll(napi_env env, DecoderData* data, PixelFormatKind format, const char* progression_target, bool emit_every_pass) {
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) return false;

  int events = JXL_DEC_BASIC_INFO | JXL_DEC_FRAME | JXL_DEC_FULL_IMAGE | JXL_DEC_BOX;
  if (emit_every_pass || strcmp(progression_target, "dc") == 0 || strcmp(progression_target, "pass") == 0) {
    events |= JXL_DEC_FRAME_PROGRESSION;
  }
  if (JxlDecoderSubscribeEvents(dec, events) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec);
    return false;
  }

  if (events & JXL_DEC_FRAME_PROGRESSION) {
    JxlDecoderSetProgressiveDetail(dec, kDC);
  }

  JxlDecoderSetInput(dec, data->input.data(), data->input.size());
  JxlDecoderCloseInput(dec);

  JxlBasicInfo basic;
  memset(&basic, 0, sizeof(basic));
  ImageInfo info;
  bool info_known = false;
  std::vector<uint8_t> pixels;
  JxlPixelFormat pf = {4, DataTypeForFormat(format), JXL_NATIVE_ENDIAN, 0};
  uint32_t frame_index = 0;
  uint32_t frame_duration = 0;
  bool is_last_frame = false;
  std::string frame_name;
  uint32_t anim_tps = 1000;
  uint32_t anim_loops = 0;
  struct DecodedEC {
    JxlExtraChannelInfo info;
    char name[256];
    std::vector<uint8_t> pixels;
  };
  std::vector<DecodedEC> extra_channels_dec;
  bool jhgm_reading = false;
  std::vector<uint8_t> jhgm_buf;
  std::vector<uint8_t> gain_map_jxl;

  for (;;) {
    JxlDecoderStatus status = JxlDecoderProcessInput(dec);
    if (status == JXL_DEC_ERROR || status == JXL_DEC_NEED_MORE_INPUT) {
      JxlDecoderDestroy(dec);
      return false;
    }
    if (status == JXL_DEC_SUCCESS) {
      // Finalize jhgm box accumulation.
      if (jhgm_reading && !jhgm_buf.empty()) {
        size_t remaining = JxlDecoderReleaseBoxBuffer(dec);
        const size_t jhgm_size = jhgm_buf.size() - remaining;
#if CASABIO_HAVE_GAIN_MAP
        if (jhgm_size > 0) {
          JxlGainMapBundle bundle = {};
          size_t bytes_read = 0;
          if (JxlGainMapReadBundle(&bundle, jhgm_buf.data(), jhgm_size, &bytes_read) == JXL_TRUE
              && bundle.gain_map != nullptr && bundle.gain_map_size > 0) {
            gain_map_jxl.assign(bundle.gain_map, bundle.gain_map + bundle.gain_map_size);
          }
        }
#endif
        jhgm_reading = false;
      }
      break;
    }
    if (status == JXL_DEC_BOX) {
      if (jhgm_reading && !jhgm_buf.empty()) {
        JxlDecoderReleaseBoxBuffer(dec);
        jhgm_reading = false;
      }
      JxlBoxType box_type;
      if (JxlDecoderGetBoxType(dec, box_type, JXL_FALSE) == JXL_DEC_SUCCESS) {
        if (box_type[0]=='j' && box_type[1]=='h' && box_type[2]=='g' && box_type[3]=='m') {
          jhgm_buf.resize(65536);
          JxlDecoderSetBoxBuffer(dec, jhgm_buf.data(), jhgm_buf.size());
          jhgm_reading = true;
        }
      }
      continue;
    }
    if (status == JXL_DEC_BOX_NEED_MORE_OUTPUT) {
      if (jhgm_reading && !jhgm_buf.empty()) {
        size_t remaining = JxlDecoderReleaseBoxBuffer(dec);
        const size_t used = jhgm_buf.size() - remaining;
        jhgm_buf.resize(jhgm_buf.size() * 2);
        JxlDecoderSetBoxBuffer(dec, jhgm_buf.data() + used, jhgm_buf.size() - used);
      }
      continue;
    }
    if (status == JXL_DEC_FRAME) {
      JxlFrameHeader frame_header;
      memset(&frame_header, 0, sizeof(frame_header));
      if (JxlDecoderGetFrameHeader(dec, &frame_header) == JXL_DEC_SUCCESS) {
        frame_duration = frame_header.duration;
        is_last_frame  = frame_header.is_last == JXL_TRUE;
        char name_buf[256] = {0};
        if (JxlDecoderGetFrameName(dec, name_buf, sizeof(name_buf)) == JXL_DEC_SUCCESS) {
          frame_name = std::string(name_buf);
        } else {
          frame_name.clear();
        }
      }
      continue;
    }
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
      info.jpeg_reconstruction_available = basic.uses_original_profile == JXL_FALSE ? false : false;
      if (basic.have_animation) {
        anim_tps   = basic.animation.tps_numerator;
        anim_loops = basic.animation.num_loops;
      }
      // Collect extra-channel descriptors.
      const uint32_t num_ec = basic.num_extra_channels;
      extra_channels_dec.resize(num_ec);
      for (uint32_t i = 0; i < num_ec; ++i) {
        memset(&extra_channels_dec[i].info, 0, sizeof(extra_channels_dec[i].info));
        JxlDecoderGetExtraChannelInfo(dec, static_cast<size_t>(i), &extra_channels_dec[i].info);
        memset(extra_channels_dec[i].name, 0, sizeof(extra_channels_dec[i].name));
        JxlDecoderGetExtraChannelName(dec, static_cast<size_t>(i), extra_channels_dec[i].name, 256);
      }
      info_known = true;
      napi_value header = MakeHeaderEvent(env, info);
      if (!extra_channels_dec.empty()) {
        napi_value info_obj;
        napi_get_named_property(env, header, "info", &info_obj);
        napi_value ec_descs;
        napi_create_array_with_length(env, extra_channels_dec.size(), &ec_descs);
        for (uint32_t i = 0; i < static_cast<uint32_t>(extra_channels_dec.size()); ++i) {
          napi_value desc;
          napi_create_object(env, &desc);
          const uint32_t ec_bits = extra_channels_dec[i].info.bits_per_sample > 0 ? extra_channels_dec[i].info.bits_per_sample : 8u;
          napi_set_named_property(env, desc, "type", MakeString(env, ExtraChannelTypeName(static_cast<uint32_t>(extra_channels_dec[i].info.type))));
          napi_set_named_property(env, desc, "bitsPerSample", MakeUint32(env, ec_bits));
          napi_set_named_property(env, desc, "name", MakeString(env, extra_channels_dec[i].name));
          napi_set_element(env, ec_descs, i, desc);
        }
        napi_set_named_property(env, info_obj, "extraChannels", ec_descs);
      }
      data->events.push_back(RefValue(env, header));
      if (strcmp(progression_target, "header") == 0) {
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
      pixels.resize(buffer_size);
      if (JxlDecoderSetImageOutBuffer(dec, &pf, pixels.data(), pixels.size()) != JXL_DEC_SUCCESS) {
        JxlDecoderDestroy(dec);
        return false;
      }
      // Set extra-channel output buffers.
      for (uint32_t i = 0; i < static_cast<uint32_t>(extra_channels_dec.size()); ++i) {
        const uint32_t ec_bits = extra_channels_dec[i].info.bits_per_sample > 0 ? extra_channels_dec[i].info.bits_per_sample : 8u;
        JxlDataType ec_dtype = (ec_bits == 32u) ? JXL_TYPE_FLOAT : (ec_bits == 16u) ? JXL_TYPE_UINT16 : JXL_TYPE_UINT8;
        JxlPixelFormat ec_pf = {1, ec_dtype, JXL_NATIVE_ENDIAN, 0};
        size_t ec_buf_size = 0;
        if (JxlDecoderExtraChannelBufferSize(dec, &ec_pf, &ec_buf_size, i) != JXL_DEC_SUCCESS) continue;
        if (ec_buf_size == 0) continue;
        extra_channels_dec[i].pixels.resize(ec_buf_size);
        JxlDecoderSetExtraChannelBuffer(dec, &ec_pf, extra_channels_dec[i].pixels.data(), ec_buf_size, i);
      }
      continue;
    }
    if (status == JXL_DEC_FRAME_PROGRESSION && info_known && !pixels.empty()) {
      std::vector<uint8_t> flushed(pixels.size());
      if (JxlDecoderSetImageOutBuffer(dec, &pf, flushed.data(), flushed.size()) == JXL_DEC_SUCCESS &&
          JxlDecoderFlushImage(dec) == JXL_DEC_SUCCESS) {
        napi_value progress = MakeImageEvent(env, "progress", info, format, flushed);
        data->events.push_back(RefValue(env, progress));
        JxlDecoderSetImageOutBuffer(dec, &pf, pixels.data(), pixels.size());
      }
      continue;
    }
    if (status == JXL_DEC_FULL_IMAGE) { frame_index++; continue; }
  }

  JxlDecoderDestroy(dec);
  if (!info_known || pixels.empty()) return false;
  napi_value final_ev = MakeImageEvent(env, "final", info, format, pixels);
  napi_set_named_property(env, final_ev, "frameIndex",         MakeUint32(env, frame_index > 0 ? frame_index - 1 : 0));
  napi_set_named_property(env, final_ev, "frameDuration",      MakeUint32(env, frame_duration));
  napi_set_named_property(env, final_ev, "isLastFrame",        MakeBool(env, is_last_frame));
  napi_set_named_property(env, final_ev, "animTicksPerSecond", MakeUint32(env, anim_tps));
  napi_set_named_property(env, final_ev, "animLoopCount",      MakeUint32(env, anim_loops));
  if (!frame_name.empty()) {
    napi_value name_val;
    napi_create_string_utf8(env, frame_name.c_str(), NAPI_AUTO_LENGTH, &name_val);
    napi_set_named_property(env, final_ev, "frameName", name_val);
  }
  if (!extra_channels_dec.empty()) {
    napi_value ec_arr;
    napi_create_array_with_length(env, extra_channels_dec.size(), &ec_arr);
    napi_value planes_arr;
    napi_create_array_with_length(env, extra_channels_dec.size(), &planes_arr);
    for (uint32_t i = 0; i < static_cast<uint32_t>(extra_channels_dec.size()); ++i) {
      const uint32_t ec_bits = extra_channels_dec[i].info.bits_per_sample > 0 ? extra_channels_dec[i].info.bits_per_sample : 8u;
      const char* ec_pf_name = (ec_bits == 32u) ? "rgbaf32" : (ec_bits == 16u) ? "rgba16" : "rgba8";
      napi_value obj;
      napi_create_object(env, &obj);
      napi_set_named_property(env, obj, "type", MakeString(env, ExtraChannelTypeName(static_cast<uint32_t>(extra_channels_dec[i].info.type))));
      napi_set_named_property(env, obj, "bitsPerSample", MakeUint32(env, ec_bits));
      napi_set_named_property(env, obj, "name", MakeString(env, extra_channels_dec[i].name));
      napi_set_named_property(env, obj, "pixelFormat", MakeString(env, ec_pf_name));
      napi_set_named_property(env, obj, "pixels", MakeArrayBuffer(env, extra_channels_dec[i].pixels.data(), extra_channels_dec[i].pixels.size()));
      napi_set_element(env, ec_arr, i, obj);
      napi_value ab = MakeArrayBuffer(env, extra_channels_dec[i].pixels.data(), extra_channels_dec[i].pixels.size());
      napi_set_element(env, planes_arr, i, ab);
    }
    napi_set_named_property(env, final_ev, "extraChannelDescriptors", ec_arr);
    napi_set_named_property(env, final_ev, "extraPlanes", planes_arr);
  }
  if (!gain_map_jxl.empty()) {
    napi_value gm_obj;
    napi_create_object(env, &gm_obj);
    napi_set_named_property(env, gm_obj, "data", MakeArrayBuffer(env, gain_map_jxl.data(), gain_map_jxl.size()));
    napi_set_named_property(env, final_ev, "gainMap", gm_obj);
  }
  data->events.push_back(RefValue(env, final_ev));
  return true;
}

static bool EncodeAll(EncoderData* data, std::vector<uint8_t>* out) {
  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return false;

  // Container / raw-codestream control.
  if (data->raw_codestream) {
    JxlEncoderUseContainer(enc, JXL_FALSE);
  } else if (data->force_container || !data->exif.empty() || !data->xmp.empty() || !data->icc_profile.empty() || !data->custom_boxes.empty()) {
    JxlEncoderUseContainer(enc, JXL_TRUE);
  }

  const uint32_t bits = BitsForFormat(data->format);
  const uint32_t exp_bits = ExponentBitsForFormat(data->format);
  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize = data->width;
  info.ysize = data->height;
  info.bits_per_sample = bits;
  info.exponent_bits_per_sample = exp_bits;
  info.num_color_channels = 3;
  info.num_extra_channels = (data->has_alpha ? 1u : 0u) + static_cast<uint32_t>(data->extra_channels.size());
  info.alpha_bits = data->has_alpha ? bits : 0;
  info.alpha_exponent_bits = data->has_alpha ? exp_bits : 0;

  if (data->has_animation && !data->anim_frames.empty()) {
    info.have_animation             = JXL_TRUE;
    info.animation.tps_numerator    = data->anim_ticks_per_second;
    info.animation.tps_denominator  = 1;
    info.animation.num_loops        = data->anim_loop_count;
    info.animation.have_timecodes   = JXL_FALSE;
    info.xsize = data->anim_frames[0].width;
    info.ysize = data->anim_frames[0].height;
  }

  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc);
    return false;
  }

  // Declare extra channels beyond alpha (must follow SetBasicInfo).
  for (uint32_t i = 0; i < static_cast<uint32_t>(data->extra_channels.size()); ++i) {
    const auto& ec = data->extra_channels[i];
    const uint32_t ec_index = (data->has_alpha ? 1u : 0u) + i;
    JxlExtraChannelInfo ec_info;
    memset(&ec_info, 0, sizeof(ec_info));
    ec_info.type = static_cast<JxlExtraChannelType>(ec.type);
    ec_info.bits_per_sample = ec.bits_per_sample > 0u ? ec.bits_per_sample : 8u;
    ec_info.exponent_bits_per_sample = (ec.bits_per_sample == 32u) ? 8u : 0u;
    if (JxlEncoderSetExtraChannelInfo(enc, ec_index, &ec_info) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return false;
    }
    if (!ec.name.empty()) {
      JxlEncoderSetExtraChannelName(enc, ec_index, ec.name.c_str(), ec.name.size());
    }
  }

  if (!data->icc_profile.empty()) {
    if (JxlEncoderSetICCProfile(enc, data->icc_profile.data(), data->icc_profile.size()) != JXL_ENC_SUCCESS) {
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
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(data->effort));
  if (data->modular >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_MODULAR, static_cast<int64_t>(data->modular));
  if (data->brotli_effort >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_BROTLI_EFFORT, static_cast<int64_t>(data->brotli_effort));
  if (data->decoding_speed >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_DECODING_SPEED, static_cast<int64_t>(data->decoding_speed > 4 ? 4 : data->decoding_speed));
  if (data->photon_noise_iso > 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PHOTON_NOISE, static_cast<int64_t>(data->photon_noise_iso));
  if (data->resampling > 1u) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_RESAMPLING, static_cast<int64_t>(data->resampling));
  for (const auto& adv : data->advanced_frame_settings) {
    JxlEncoderFrameSettingsSetOption(frame, static_cast<JxlEncoderFrameSettingId>(adv.id), static_cast<int64_t>(adv.value));
  }
  // Modular sub-settings.
  if (data->modular_group_size >= 0) JxlEncoderFrameSettingsSetOption(frame, static_cast<JxlEncoderFrameSettingId>(32), static_cast<int64_t>(data->modular_group_size));
  if (data->modular_predictor >= 0) JxlEncoderFrameSettingsSetOption(frame, static_cast<JxlEncoderFrameSettingId>(33), static_cast<int64_t>(data->modular_predictor));
  if (data->modular_nb_prev_channels >= 0) JxlEncoderFrameSettingsSetOption(frame, static_cast<JxlEncoderFrameSettingId>(34), static_cast<int64_t>(data->modular_nb_prev_channels));
  if (data->modular_palette_colors != INT32_MIN) JxlEncoderFrameSettingsSetOption(frame, static_cast<JxlEncoderFrameSettingId>(35), static_cast<int64_t>(data->modular_palette_colors));
  if (data->modular_lossy_palette >= 0) JxlEncoderFrameSettingsSetOption(frame, static_cast<JxlEncoderFrameSettingId>(36), static_cast<int64_t>(data->modular_lossy_palette));
  if (data->modular_ma_tree_learning_percent >= 0) JxlEncoderFrameSettingsSetOption(frame, static_cast<JxlEncoderFrameSettingId>(37), static_cast<int64_t>(data->modular_ma_tree_learning_percent));

  // Per-extra-channel distances.
  if (data->has_alpha && data->alpha_distance >= 0.0) {
    JxlEncoderSetExtraChannelDistance(frame, 0, static_cast<float>(data->alpha_distance));
  }
  for (uint32_t i = 0; i < static_cast<uint32_t>(data->extra_channels.size()); ++i) {
    const auto& ec = data->extra_channels[i];
    if (ec.distance >= 0.0) {
      JxlEncoderSetExtraChannelDistance(frame, (data->has_alpha ? 1u : 0u) + i, static_cast<float>(ec.distance));
    }
  }

  JxlPixelFormat pf = {4, DataTypeForFormat(data->format), JXL_NATIVE_ENDIAN, 0};
  if (data->has_animation) {
    for (const auto& af : data->anim_frames) {
      JxlEncoderFrameSettings* fs = JxlEncoderFrameSettingsCreate(enc, frame);
      {
        JxlFrameHeader fh;
        JxlEncoderInitFrameHeader(&fh);
        fh.duration = af.duration;
        if (JxlEncoderSetFrameHeader(fs, &fh) != JXL_ENC_SUCCESS) {
          JxlEncoderDestroy(enc); return false;
        }
      }
      if (!af.name.empty()) {
        if (JxlEncoderSetFrameName(fs, af.name.c_str()) != JXL_ENC_SUCCESS) {
          JxlEncoderDestroy(enc); return false;
        }
      }
      const size_t expected = static_cast<size_t>(af.width) * af.height * 4 * BytesPerChannel(data->format);
      if (af.pixels.size() < expected ||
          JxlEncoderAddImageFrame(fs, &pf, af.pixels.data(), expected) != JXL_ENC_SUCCESS) {
        JxlEncoderDestroy(enc); return false;
      }
    }
  } else {
    const size_t expected = static_cast<size_t>(data->width) * data->height * 4 * BytesPerChannel(data->format);
    if (data->pixels.size() < expected ||
        JxlEncoderAddImageFrame(frame, &pf, data->pixels.data(), expected) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return false;
    }
    // Extra channel plane buffers (must follow JxlEncoderAddImageFrame).
    for (uint32_t i = 0; i < static_cast<uint32_t>(data->extra_channels.size()); ++i) {
      const auto& ec = data->extra_channels[i];
      if (ec.pixels.empty()) continue;
      const uint32_t ec_index = (data->has_alpha ? 1u : 0u) + i;
      const uint32_t ec_bits = ec.bits_per_sample > 0u ? ec.bits_per_sample : 8u;
      JxlDataType ec_dtype = (ec_bits == 32u) ? JXL_TYPE_FLOAT : (ec_bits == 16u) ? JXL_TYPE_UINT16 : JXL_TYPE_UINT8;
      JxlPixelFormat ec_pf = {1u, ec_dtype, JXL_NATIVE_ENDIAN, 0};
      if (JxlEncoderSetExtraChannelBuffer(frame, &ec_pf, ec.pixels.data(), ec.pixels.size(), ec_index) != JXL_ENC_SUCCESS) {
        JxlEncoderDestroy(enc);
        return false;
      }
    }
  }

  const bool needs_boxes = !data->exif.empty() || !data->xmp.empty() || !data->custom_boxes.empty()
#if CASABIO_HAVE_GAIN_MAP
      || !data->gain_map_jxl.empty()
#endif
      ;
  if (needs_boxes) {
    if (JxlEncoderUseBoxes(enc) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return false;
    }
  }

  const JxlBool compress_flag = data->compress_boxes ? JXL_TRUE : JXL_FALSE;
  if (!data->exif.empty()) {
    if (JxlEncoderAddBox(enc, "Exif", data->exif.data(), data->exif.size(), compress_flag) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return false;
    }
  }
  if (!data->xmp.empty()) {
    if (JxlEncoderAddBox(enc, "xml ", data->xmp.data(), data->xmp.size(), compress_flag) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return false;
    }
  }

  for (const auto& box : data->custom_boxes) {
    if (box.data.empty()) continue;
    char box_type[4] = {' ', ' ', ' ', ' '};
    for (size_t ci = 0; ci < box.type.size() && ci < 4; ++ci) box_type[ci] = box.type[ci];
    const JxlBool compress_box = box.compress ? JXL_TRUE : JXL_FALSE;
    if (JxlEncoderAddBox(enc, box_type, box.data.data(), box.data.size(), compress_box) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return false;
    }
  }

#if CASABIO_HAVE_GAIN_MAP
  if (!data->gain_map_jxl.empty()) {
    JxlGainMapBundle bundle = {};
    bundle.gain_map      = data->gain_map_jxl.data();
    bundle.gain_map_size = static_cast<uint32_t>(data->gain_map_jxl.size());
    size_t bundle_size = 0;
    if (JxlGainMapGetBundleSize(&bundle, &bundle_size) != JXL_TRUE) {
      JxlEncoderDestroy(enc);
      return false;
    }
    std::vector<uint8_t> bundle_bytes(bundle_size);
    size_t bytes_written = 0;
    if (JxlGainMapWriteBundle(&bundle, bundle_bytes.data(), bundle_size, &bytes_written) != JXL_TRUE) {
      JxlEncoderDestroy(enc);
      return false;
    }
    if (JxlEncoderAddBox(enc, "jhgm", bundle_bytes.data(), bytes_written, JXL_FALSE) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return false;
    }
  }
#endif

  JxlEncoderCloseInput(enc);

  out->assign(65536, 0);
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
  std::string target = GetStringProp(env, options, "progressionTarget", "final");
  bool emit_every_pass = GetBoolProp(env, options, "emitEveryPass", false);
  if (!DecodeAll(env, data, format, target.c_str(), emit_every_pass)) {
    return Throw(env, "libjxl decode failed");
  }
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
  if (!EncodeAll(data, &out)) return Throw(env, "libjxl encode failed");
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
  return MakeString(env, "0.1.0-libjxl");
}

static napi_value Probe(napi_env env, napi_callback_info) {
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "loaded", MakeBool(env, CASABIO_HAVE_LIBJXL == 1));
  napi_set_named_property(env, result, "path", MakeString(env, CASABIO_HAVE_LIBJXL ? "libjxl native" : "libjxl unavailable"));
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
  data->distance = GetNullableNumberProp(env, args[0], "distance", GetNullableNumberProp(env, args[0], "quality", 90.0) >= 100.0 ? 0.0 : 1.0);
  data->effort = GetUint32Prop(env, args[0], "effort", 7);
  {
    const double be = GetNullableNumberProp(env, args[0], "brotliEffort", -1.0);
    data->brotli_effort = (be < 0.0) ? -1 : (be > 11.0) ? 11 : static_cast<int32_t>(be);
  }
  {
    const double ds = GetNullableNumberProp(env, args[0], "decodingSpeed", -1.0);
    data->decoding_speed = (ds < 0.0) ? -1 : (ds > 4.0) ? 4 : static_cast<int32_t>(ds);
  }
  {
    const double iso = GetNullableNumberProp(env, args[0], "photonNoiseIso", 0.0);
    data->photon_noise_iso = (iso <= 0.0) ? 0 : static_cast<int32_t>(iso);
  }
  data->resampling = NormalizeResampling(GetUint32Prop(env, args[0], "resampling", 1));
  {
    const double mod = GetNullableNumberProp(env, args[0], "modular", -1.0);
    data->modular = (mod < 0.0) ? -1 : (mod > 1.0) ? 1 : static_cast<int32_t>(mod);
  }

  // Progressive encode: mirror resolveEncoderBridgeSettings() in facade.ts.
  {
    const bool progressive   = GetBoolProp(env, args[0], "progressive",  false);
    const bool preview_first = GetBoolProp(env, args[0], "previewFirst", false);
    const bool chunked       = GetBoolProp(env, args[0], "chunked",      false);
    if (progressive) {
      data->progressive_dc  = 1;
      data->progressive_ac  = preview_first ? 1 : 0;
      data->qprogressive_ac = preview_first ? 1 : 0;
    }
    data->buffering = chunked ? 2 : 0;
  }

  // advancedFrameSettings escape hatch.
  {
    napi_value adv_val;
    if (GetProp(env, args[0], "advancedFrameSettings", &adv_val)) {
      bool is_array = false;
      napi_is_array(env, adv_val, &is_array);
      if (is_array) {
        uint32_t adv_len = 0;
        napi_get_array_length(env, adv_val, &adv_len);
        for (uint32_t ai = 0; ai < adv_len; ++ai) {
          napi_value item;
          napi_get_element(env, adv_val, ai, &item);
          EncoderData::AdvancedSetting setting;
          setting.id    = static_cast<int32_t>(GetNullableNumberProp(env, item, "id",    0.0));
          setting.value = static_cast<int32_t>(GetNullableNumberProp(env, item, "value", 0.0));
          data->advanced_frame_settings.push_back(setting);
        }
      }
    }
  }

  // Modular sub-settings (modularOptions object).
  {
    napi_value mo_val;
    if (GetProp(env, args[0], "modularOptions", &mo_val)) {
      napi_valuetype mo_type;
      napi_typeof(env, mo_val, &mo_type);
      if (mo_type == napi_object) {
        const double gs = GetNullableNumberProp(env, mo_val, "groupSize", -1.0);
        data->modular_group_size = (gs < 0.0) ? -1 : static_cast<int32_t>(gs);
        const double pred = GetNullableNumberProp(env, mo_val, "predictor", -1.0);
        data->modular_predictor = (pred < 0.0) ? -1 : static_cast<int32_t>(pred);
        const double npc = GetNullableNumberProp(env, mo_val, "nbPrevChannels", -1.0);
        data->modular_nb_prev_channels = (npc < 0.0) ? -1 : static_cast<int32_t>(npc);
        const double pc = GetNullableNumberProp(env, mo_val, "paletteColors", static_cast<double>(INT32_MIN));
        data->modular_palette_colors = (pc <= static_cast<double>(INT32_MIN)) ? INT32_MIN : static_cast<int32_t>(pc);
        data->modular_lossy_palette = GetBoolProp(env, mo_val, "lossyPalette", false) ? 1 : -1;
        const double mlp = GetNullableNumberProp(env, mo_val, "maTreeLearningPercent", -1.0);
        data->modular_ma_tree_learning_percent = (mlp < 0.0) ? -1 : static_cast<int32_t>(mlp);
      }
    }
  }

  // Gain map (gainMap.data = JXL naked codestream).
  {
    napi_value gm_val;
    if (GetProp(env, args[0], "gainMap", &gm_val)) {
      napi_valuetype gm_type;
      napi_typeof(env, gm_val, &gm_type);
      if (gm_type == napi_object) {
        napi_value gm_data_val;
        if (GetProp(env, gm_val, "data", &gm_data_val)) {
          ReadBytes(env, gm_data_val, &data->gain_map_jxl);
        }
      }
    }
  }

  // Metadata blobs.
  data->icc_profile = GetNullableBufferProp(env, args[0], "iccProfile");
  data->exif        = GetNullableBufferProp(env, args[0], "exif");
  data->xmp         = GetNullableBufferProp(env, args[0], "xmp");

  // MetadataOptions sub-object (optional).
  {
    napi_value meta_val;
    if (GetProp(env, args[0], "metadata", &meta_val)) {
      napi_valuetype meta_type;
      napi_typeof(env, meta_val, &meta_type);
      if (meta_type == napi_object) {
        data->compress_boxes  = GetBoolProp(env, meta_val, "compressBoxes",  false);
        data->force_container = GetBoolProp(env, meta_val, "forceContainer", false);
        data->raw_codestream  = GetBoolProp(env, meta_val, "rawCodestream",  false);
        // includeICC/Exif/XMP: strip the blob when flag is explicitly false.
        if (!GetBoolProp(env, meta_val, "includeICC",  true)) data->icc_profile.clear();
        if (!GetBoolProp(env, meta_val, "includeExif", true)) data->exif.clear();
        if (!GetBoolProp(env, meta_val, "includeXMP",  true)) data->xmp.clear();
      }
    }
  }

  // Custom metadata boxes.
  {
    napi_value boxes_val;
    if (GetProp(env, args[0], "customBoxes", &boxes_val)) {
      bool is_array = false;
      napi_is_array(env, boxes_val, &is_array);
      if (is_array) {
        uint32_t boxes_len = 0;
        napi_get_array_length(env, boxes_val, &boxes_len);
        for (uint32_t bi = 0; bi < boxes_len; ++bi) {
          napi_value item;
          napi_get_element(env, boxes_val, bi, &item);
          EncoderData::CustomBox box;
          box.type     = GetStringProp(env, item, "type", "    ");
          box.compress = GetBoolProp(env, item, "compress", false);
          napi_value box_data_val;
          if (GetProp(env, item, "data", &box_data_val)) {
            ReadBytes(env, box_data_val, &box.data);
          }
          data->custom_boxes.push_back(std::move(box));
        }
      }
    }
  }

  // Animation options + frames.
  {
    napi_value anim_val;
    if (GetProp(env, args[0], "animation", &anim_val)) {
      napi_valuetype anim_type;
      napi_typeof(env, anim_val, &anim_type);
      if (anim_type == napi_object) {
        data->anim_ticks_per_second = GetUint32Prop(env, anim_val, "ticksPerSecond", 1000);
        data->anim_loop_count       = GetUint32Prop(env, anim_val, "loopCount",      0);
      }
    }
    napi_value frames_val;
    if (GetProp(env, args[0], "frames", &frames_val)) {
      bool is_array = false;
      napi_is_array(env, frames_val, &is_array);
      if (is_array) {
        data->has_animation = true;
        uint32_t length = 0;
        napi_get_array_length(env, frames_val, &length);
        for (uint32_t fi = 0; fi < length; ++fi) {
          napi_value frame_val;
          napi_get_element(env, frames_val, fi, &frame_val);
          EncoderData::AnimFrame af;
          af.width    = GetUint32Prop(env, frame_val, "width",    0);
          af.height   = GetUint32Prop(env, frame_val, "height",   0);
          af.duration = GetUint32Prop(env, frame_val, "duration", 1);
          af.name     = GetStringProp(env, frame_val, "name",     "");
          napi_value data_val;
          if (GetProp(env, frame_val, "data", &data_val)) {
            ReadBytes(env, data_val, &af.pixels);
          }
          data->anim_frames.push_back(std::move(af));
        }
      }
    }
  }

  // Extra channel options.
  data->alpha_distance = GetNullableNumberProp(env, args[0], "alphaDistance", -1.0);
  {
    napi_value ec_arr;
    if (GetProp(env, args[0], "extraChannels", &ec_arr)) {
      bool is_array = false;
      napi_is_array(env, ec_arr, &is_array);
      if (is_array) {
        uint32_t ec_len = 0;
        napi_get_array_length(env, ec_arr, &ec_len);

        napi_value planes_arr;
        bool has_planes = GetProp(env, args[0], "extraChannelPlanes", &planes_arr);
        bool planes_is_array = false;
        uint32_t planes_len = 0;
        if (has_planes) {
          napi_is_array(env, planes_arr, &planes_is_array);
          if (planes_is_array) napi_get_array_length(env, planes_arr, &planes_len);
        }

        for (uint32_t i = 0; i < ec_len; ++i) {
          napi_value ec_item;
          napi_get_element(env, ec_arr, i, &ec_item);
          EncoderData::NativeExtraChannel ec;
          ec.type = ParseExtraChannelType(GetStringProp(env, ec_item, "type", "other"));
          ec.bits_per_sample = GetUint32Prop(env, ec_item, "bitsPerSample", 8);
          ec.distance = GetNullableNumberProp(env, ec_item, "distance", -1.0);
          ec.name = GetStringProp(env, ec_item, "name", "");
          if (planes_is_array && i < planes_len) {
            napi_value plane_val;
            napi_get_element(env, planes_arr, i, &plane_val);
            ReadBytes(env, plane_val, &ec.pixels);
          }
          data->extra_channels.push_back(std::move(ec));
        }
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
