//! Backend identification + runtime dispatch. AVX2 impls land in `avx2`.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Backend {
    Scalar = 0,
    Avx2Strict = 1,
    Avx2Rsqrt = 2,
}

/// Best backend available on this CPU. Browser wasm32 v128/relaxed paths are added in Plan 2.
pub fn detect_native(prefer_rsqrt: bool) -> Backend {
    #[cfg(target_arch = "x86_64")]
    {
        if std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma") {
            return if prefer_rsqrt { Backend::Avx2Rsqrt } else { Backend::Avx2Strict };
        }
    }
    let _ = prefer_rsqrt;
    Backend::Scalar
}

#[cfg(target_arch = "x86_64")]
pub mod avx2;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detect_returns_something() {
        let b = detect_native(false);
        assert!(matches!(b, Backend::Scalar | Backend::Avx2Strict | Backend::Avx2Rsqrt));
    }
}
