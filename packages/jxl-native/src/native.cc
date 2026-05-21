#include <node_api.h>

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

static napi_value init(napi_env env, napi_value exports) {
  napi_value fn;

  napi_create_function(env, "version", NAPI_AUTO_LENGTH, version, nullptr, &fn);
  napi_set_named_property(env, exports, "version", fn);

  napi_create_function(env, "probe", NAPI_AUTO_LENGTH, probe, nullptr, &fn);
  napi_set_named_property(env, exports, "probe", fn);

  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
