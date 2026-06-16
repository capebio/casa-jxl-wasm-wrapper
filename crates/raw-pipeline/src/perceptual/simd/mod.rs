//! Backend identification + runtime dispatch. AVX2 impls land in `avx2`.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Backend {
    Scalar = 0,
    Avx2Strict = 1,
    Avx2Rsqrt = 2,
    /// AVX-512 strict (f32x16, full sqrt + div, fast gather on server CPUs). NOT
    /// benchmarked on the dev machine (i7-10850H has no AVX-512) — kept for the
    /// production fleet; correctness verified by parity tests on real hardware.
    Avx512Strict = 3,
    /// wasm32 v128 SIMD (4-wide f32). Selected at wasm build time when simd128 is on.
    WasmSimd = 4,
    /// AVX-512 rsqrt (rsqrt14/rcp14 approximations for sqrt and 1/m). Alternate
    /// route flip-flopped against Avx512Strict on real hardware.
    Avx512Rsqrt = 5,
}

/// Backend for the current wasm build: WasmSimd when compiled with `+simd128`,
/// else Scalar. (simd128 is a compile-time target feature, not runtime-probed.)
#[cfg(target_arch = "wasm32")]
pub fn detect_wasm() -> Backend {
    #[cfg(target_feature = "simd128")]
    {
        Backend::WasmSimd
    }
    #[cfg(not(target_feature = "simd128"))]
    {
        Backend::Scalar
    }
}

/// Best backend available on this CPU. Prefers AVX-512 when present (its fast
/// gather is the reason it exists here), else AVX2, else scalar. Browser wasm32
/// v128 path is selected via `detect_wasm`.
pub fn detect_native(prefer_rsqrt: bool) -> Backend {
    #[cfg(target_arch = "x86_64")]
    {
        if std::is_x86_feature_detected!("avx512f") && std::is_x86_feature_detected!("avx512bw") {
            return Backend::Avx512Strict;
        }
        if std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma") {
            return if prefer_rsqrt { Backend::Avx2Rsqrt } else { Backend::Avx2Strict };
        }
    }
    let _ = prefer_rsqrt;
    Backend::Scalar
}

#[cfg(target_arch = "x86_64")]
pub mod avx2;

#[cfg(target_arch = "x86_64")]
pub mod avx512;

#[cfg(target_arch = "wasm32")]
pub mod wasm;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detect_returns_something() {
        let b = detect_native(false);
        assert!(matches!(b, Backend::Scalar | Backend::Avx2Strict | Backend::Avx2Rsqrt | Backend::Avx512Strict | Backend::Avx512Rsqrt | Backend::WasmSimd));
    }
}
