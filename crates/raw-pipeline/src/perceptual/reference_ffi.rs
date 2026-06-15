//! FFI declaration for the libjxl butteraugli reference oracle.
//!
//! The C symbol `butteraugli_reference_score` is implemented in
//! `external/libjxl/lib/jxl/butteraugli/butteraugli.cc` inside
//! `#ifdef BUTTERAUGLI_REFERENCE_EXPORT`. It is only linked when building
//! the native regression-test binary with that define set.
//!
//! This file documents the contract; it is NOT compiled into WASM or any
//! normal build. Use it if you wire a native benchmark that needs exact
//! libjxl scores alongside the optimised Rust engine for comparison.

/// Signature of the C export added to butteraugli.cc.
///
/// ```
/// float butteraugli_reference_score(
///     const float* ref_rgb,   // interleaved R,G,B in [0,1], width*height*3 entries
///     const float* test_rgb,  // same layout
///     int width,
///     int height
/// );
/// ```
///
/// Returns the scalar butteraugli distance, or -1.0 on error.
/// Build requirement: link against libjxl with -DBUTTERAUGLI_REFERENCE_EXPORT.
#[cfg(feature = "libjxl-reference")]
extern "C" {
    pub fn butteraugli_reference_score(
        ref_rgb: *const f32,
        test_rgb: *const f32,
        width: i32,
        height: i32,
    ) -> f32;
}
