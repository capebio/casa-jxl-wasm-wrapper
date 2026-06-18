//! `jxl-ffi` — clean-room, BSD-clean raw FFI bindings to libjxl.
//!
//! The bindings are generated at build time by `bindgen` from the BSD-3 libjxl
//! C headers (`external/libjxl/lib/include/jxl/*.h`) and linked against our own
//! static libjxl build (see `build.rs`). This crate contains **no** GPL code and
//! does not depend on the GPL `jpegxl-sys` / `jpegxl-rs` / `jpegxl-src` crates.
//!
//! Native only: on `wasm32` the crate is empty (the WASM JXL path lives in
//! `web/pkg` + `bridge.cpp`, which is already BSD over libjxl).
//!
//! This is the raw `extern "C"` surface. Safe wrappers live in
//! `raw-pipeline::jxl_encode` / `jxl_decode`.

#![allow(non_upper_case_globals, non_camel_case_types, non_snake_case, dead_code)]

#[cfg(not(target_arch = "wasm32"))]
include!(concat!(env!("OUT_DIR"), "/bindings.rs"));

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    /// Phase-0 link smoke test: proves the cmake build + static link + bindgen
    /// toolchain are wired correctly end-to-end. If this passes, the rest is
    /// mechanical.
    #[test]
    fn links_to_libjxl() {
        let v = unsafe { super::JxlDecoderVersion() };
        assert!(v > 0, "JxlDecoderVersion() returned {v}");
    }
}
