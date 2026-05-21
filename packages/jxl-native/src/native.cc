#include <node_api.h>

static napi_value throw_stub(napi_env env, napi_callback_info info) {
  napi_throw_error(env, nullptr, "jxl-native codec stub is not implemented");
  return nullptr;
}

static napi_value make_stub_method(napi_env env, const char* name) {
  napi_value fn;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, throw_stub, nullptr, &fn);
  return fn;
}

static void add_stub_method(napi_env env, napi_value object, const char* name) {
  napi_value fn = make_stub_method(env, name);
  napi_set_named_property(env, object, name, fn);
}

static napi_value make_decoder(napi_env env) {
  napi_value decoder;
  napi_create_object(env, &decoder);
  add_stub_method(env, decoder, "push");
  add_stub_method(env, decoder, "close");
  add_stub_method(env, decoder, "events");
  add_stub_method(env, decoder, "cancel");
  add_stub_method(env, decoder, "dispose");
  return decoder;
}

static napi_value make_encoder(napi_env env) {
  napi_value encoder;
  napi_create_object(env, &encoder);
  add_stub_method(env, encoder, "pushPixels");
  add_stub_method(env, encoder, "finish");
  add_stub_method(env, encoder, "chunks");
  add_stub_method(env, encoder, "cancel");
  add_stub_method(env, encoder, "dispose");
  return encoder;
}

static napi_value version(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_create_string_utf8(env, "0.1.0-scaffold", NAPI_AUTO_LENGTH, &result);
  return result;
}

static napi_value probe(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_create_object(env, &result);

  napi_value loaded;
  napi_get_boolean(env, false, &loaded);
  napi_set_named_property(env, result, "loaded", loaded);

  napi_value path;
  napi_create_string_utf8(env, "source stub", NAPI_AUTO_LENGTH, &path);
  napi_set_named_property(env, result, "path", path);

  return result;
}

static napi_value create_decoder(napi_env env, napi_callback_info info) {
  return make_decoder(env);
}

static napi_value create_encoder(napi_env env, napi_callback_info info) {
  return make_encoder(env);
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value fn;

  napi_create_function(env, "version", NAPI_AUTO_LENGTH, version, nullptr, &fn);
  napi_set_named_property(env, exports, "version", fn);

  napi_create_function(env, "probe", NAPI_AUTO_LENGTH, probe, nullptr, &fn);
  napi_set_named_property(env, exports, "probe", fn);

  napi_create_function(env, "createDecoder", NAPI_AUTO_LENGTH, create_decoder, nullptr, &fn);
  napi_set_named_property(env, exports, "createDecoder", fn);

  napi_create_function(env, "createEncoder", NAPI_AUTO_LENGTH, create_encoder, nullptr, &fn);
  napi_set_named_property(env, exports, "createEncoder", fn);

  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
