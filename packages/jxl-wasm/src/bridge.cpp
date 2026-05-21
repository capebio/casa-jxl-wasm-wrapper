// Thin Emscripten link shim for the libjxl WASM build.
// Borrow the "single bridge TU" pattern from icodec's wasm codecs and keep the
// libjxl symbols pulled in through the export allowlist.

#include <jxl/decode.h>
#include <jxl/encode.h>
#include <jxl/memory_manager.h>

extern "C" {

void jxl_wasm_bridge_anchor(void) {}

}
