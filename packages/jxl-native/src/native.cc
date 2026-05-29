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

  int events = JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE;
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

  for (;;) {
    JxlDecoderStatus status = JxlDecoderProcessInput(dec);
    if (status == JXL_DEC_ERROR || status == JXL_DEC_NEED_MORE_INPUT) {
      JxlDecoderDestroy(dec);
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
      info.jpeg_reconstruction_available = basic.uses_original_profile == JXL_FALSE ? false : false;
      info_known = true;
      napi_value header = MakeHeaderEvent(env, info);
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
    if (status == JXL_DEC_FULL_IMAGE) continue;
  }

  JxlDecoderDestroy(dec);
  if (!info_known || pixels.empty()) return false;
  napi_value final = MakeImageEvent(env, "final", info, format, pixels);
  data->events.push_back(RefValue(env, final));
  return true;
}

static bool EncodeAll(EncoderData* data, std::vector<uint8_t>* out) {
  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return false;

  // Container / raw-codestream control.
  if (data->raw_codestream) {
    JxlEncoderUseContainer(enc, JXL_FALSE);
  } else if (data->force_container || !data->exif.empty() || !data->xmp.empty() || !data->icc_profile.empty()) {
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
  info.num_extra_channels = data->has_alpha ? 1 : 0;
  info.alpha_bits = data->has_alpha ? bits : 0;
  info.alpha_exponent_bits = data->has_alpha ? exp_bits : 0;

  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc);
    return false;
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
  if (data->brotli_effort >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_BROTLI_EFFORT, static_cast<int64_t>(data->brotli_effort));
  if (data->decoding_speed >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_DECODING_SPEED, static_cast<int64_t>(data->decoding_speed > 4 ? 4 : data->decoding_speed));
  if (data->photon_noise_iso > 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PHOTON_NOISE, static_cast<int64_t>(data->photon_noise_iso));
  if (data->resampling > 1u) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_RESAMPLING, static_cast<int64_t>(data->resampling));

  JxlPixelFormat pf = {4, DataTypeForFormat(data->format), JXL_NATIVE_ENDIAN, 0};
  const size_t expected = static_cast<size_t>(data->width) * data->height * 4 * BytesPerChannel(data->format);
  if (data->pixels.size() < expected ||
      JxlEncoderAddImageFrame(frame, &pf, data->pixels.data(), expected) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc);
    return false;
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
