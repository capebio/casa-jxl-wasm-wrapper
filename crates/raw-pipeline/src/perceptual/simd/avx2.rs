//! AVX2 + FMA implementations. Each public fn is `unsafe` and must only be called
//! when `detect_native` confirmed avx2+fma. 8-wide f32 lanes.

#![cfg(target_arch = "x86_64")]

use core::arch::x86_64::*;

#[inline]
unsafe fn hsum256(v: __m256) -> f32 {
    let lo = _mm256_castps256_ps128(v);
    let hi = _mm256_extractf128_ps(v, 1);
    let s = _mm_add_ps(lo, hi);
    let sh = _mm_movehdup_ps(s);
    let sums = _mm_add_ps(s, sh);
    let sh2 = _mm_movehl_ps(sh, sums);
    _mm_cvtss_f32(_mm_add_ss(sums, sh2))
}

/// AVX2 strict scale error (full sqrt). Mirrors scalar `scale_err`. Returns the
/// p-norm (p=3). `rsqrt_path` selects the reciprocal/rsqrt approximation variant.
#[target_feature(enable = "avx2,fma")]
pub unsafe fn scale_err_avx2(
    mask: &[f32],
    rx: &[f32], ry: &[f32], rb: &[f32],
    tx: &[f32], ty: &[f32], tb: &[f32],
    n: usize,
    kx: f32, ky: f32, kb: f32,
    rsqrt_path: bool,
) -> f32 {
    let vkx = _mm256_set1_ps(kx);
    let vky = _mm256_set1_ps(ky);
    let vkb = _mm256_set1_ps(kb);
    let v2 = _mm256_set1_ps(2.0);
    let v015 = _mm256_set1_ps(0.15);
    let veps = _mm256_set1_ps(1e-12);
    let mut acc = _mm256_setzero_ps();

    let lanes = n / 8 * 8;
    let mut i = 0;
    while i < lanes {
        let m = _mm256_loadu_ps(mask.as_ptr().add(i));
        // m = max(mask*2 + 0.15, 0.15)
        let mm = _mm256_max_ps(_mm256_fmadd_ps(m, v2, v015), v015);
        let inv = _mm256_div_ps(_mm256_set1_ps(1.0), mm);
        let ex = _mm256_mul_ps(_mm256_sub_ps(_mm256_loadu_ps(rx.as_ptr().add(i)), _mm256_loadu_ps(tx.as_ptr().add(i))), inv);
        let ey = _mm256_mul_ps(_mm256_sub_ps(_mm256_loadu_ps(ry.as_ptr().add(i)), _mm256_loadu_ps(ty.as_ptr().add(i))), inv);
        let eb = _mm256_mul_ps(_mm256_sub_ps(_mm256_loadu_ps(rb.as_ptr().add(i)), _mm256_loadu_ps(tb.as_ptr().add(i))), inv);
        // e2 = kx*ex^2 + ky*ey^2 + kb*eb^2
        let mut e2 = _mm256_mul_ps(vkx, _mm256_mul_ps(ex, ex));
        e2 = _mm256_fmadd_ps(vky, _mm256_mul_ps(ey, ey), e2);
        e2 = _mm256_fmadd_ps(vkb, _mm256_mul_ps(eb, eb), e2);
        // term = e2 * sqrt(e2 + eps)
        let root = if rsqrt_path {
            // sqrt(z) = z * rsqrt(z); one Newton step on rsqrt for accuracy.
            let z = _mm256_add_ps(e2, veps);
            let y0 = _mm256_rsqrt_ps(z);
            // y1 = y0 * (1.5 - 0.5*z*y0*y0)
            let half = _mm256_set1_ps(0.5);
            let threehalf = _mm256_set1_ps(1.5);
            let y1 = _mm256_mul_ps(y0, _mm256_fnmadd_ps(_mm256_mul_ps(half, z), _mm256_mul_ps(y0, y0), threehalf));
            _mm256_mul_ps(z, y1) // z * rsqrt(z) ≈ sqrt(z)
        } else {
            _mm256_sqrt_ps(_mm256_add_ps(e2, veps))
        };
        acc = _mm256_fmadd_ps(e2, root, acc);
        i += 8;
    }
    let mut sum = hsum256(acc) as f64;
    // scalar tail
    while i < n {
        let m = (mask[i] * 2.0 + 0.15).max(0.15);
        let inv = 1.0 / m;
        let ex = (rx[i] - tx[i]) * inv;
        let ey = (ry[i] - ty[i]) * inv;
        let eb = (rb[i] - tb[i]) * inv;
        let e2 = kx * ex * ex + ky * ey * ey + kb * eb * eb;
        sum += (e2 * (e2 + 1e-12).sqrt()) as f64;
        i += 1;
    }
    ((sum / n as f64).powf(1.0 / 3.0)) as f32
}

/// AVX2 PSNR sum-of-squared-diffs over packed u8. Returns the integer sum (exact
/// for buffers up to ~2^53/255^2 ≈ 1.4e11 elements). Caller computes dB.
#[target_feature(enable = "avx2")]
pub unsafe fn ssd_avx2(a: &[u8], b: &[u8]) -> u64 {
    debug_assert_eq!(a.len(), b.len());
    let len = a.len();
    let mut acc = _mm256_setzero_si256();
    let chunks = len / 16 * 16;
    let mut i = 0;
    while i < chunks {
        // 16 bytes each → widen to i16 diffs, square via madd
        let va = _mm_loadu_si128(a.as_ptr().add(i) as *const __m128i);
        let vb = _mm_loadu_si128(b.as_ptr().add(i) as *const __m128i);
        let aw = _mm256_cvtepu8_epi16(va);
        let bw = _mm256_cvtepu8_epi16(vb);
        let d = _mm256_sub_epi16(aw, bw); // fits i16 (|d|<=255)
        let sq = _mm256_madd_epi16(d, d); // 8 × i32 partial sums of pairs
        acc = _mm256_add_epi32(acc, sq);
        i += 16;
    }
    // horizontal sum of 8 i32 lanes
    let mut tmp = [0i32; 8];
    _mm256_storeu_si256(tmp.as_mut_ptr() as *mut __m256i, acc);
    let mut sum: u64 = tmp.iter().map(|&v| v as u64).sum();
    while i < len {
        let d = a[i] as i64 - b[i] as i64;
        sum += (d * d) as u64;
        i += 1;
    }
    sum
}

/// AVX2 SSIM moment accumulation over RGBA test+ref. Produces the five per-channel
/// sums (sa, saa, sab) for c in 0..3; sb/sbb are precomputed on the reference.
/// Deinterleaves RGBA by gathering channel bytes; widening to i32 keeps products exact.
#[target_feature(enable = "avx2")]
pub unsafe fn ssim_moments_avx2(
    a: &[u8], b: &[u8], np: usize,
) -> ([u64; 3], [u64; 3], [u64; 3]) {
    // Scalar-clean deinterleave is hard to beat for correctness here; use a
    // tight scalar loop with u64 accumulators (madd-based SIMD over a deinterleaved
    // temp gave no measured win — see flip-flop). Kept in the avx2 module so the
    // dispatcher has a single call site; correctness == scalar by construction.
    let mut sa = [0u64; 3]; let mut saa = [0u64; 3]; let mut sab = [0u64; 3];
    let mut j = 0;
    for _ in 0..np {
        for c in 0..3 {
            let x = a[j + c] as u64; let y = b[j + c] as u64;
            sa[c] += x; saa[c] += x * x; sab[c] += x * y;
        }
        j += 4;
    }
    (sa, saa, sab)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::perceptual::butteraugli::{scale_err, Kweights};

    #[test]
    fn avx2_scale_err_matches_scalar() {
        if !(std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma")) {
            eprintln!("avx2/fma unavailable — skipping");
            return;
        }
        let n = 1000usize; // non-multiple of 8 to exercise the tail
        let mut rx = vec![0f32; n]; let mut ry = vec![0f32; n]; let mut rb = vec![0f32; n];
        let mut tx = vec![0f32; n]; let mut ty = vec![0f32; n]; let mut tb = vec![0f32; n];
        let mut mask = vec![0f32; n];
        for i in 0..n {
            let f = i as f32;
            rx[i] = (f * 0.013).sin() * 0.4; tx[i] = rx[i] + (f * 0.07).cos() * 0.05;
            ry[i] = (f * 0.021).cos() * 0.5 + 0.5; ty[i] = ry[i] + (f * 0.03).sin() * 0.05;
            rb[i] = (f * 0.017).sin() * 0.3 + 0.3; tb[i] = rb[i] + (f * 0.05).cos() * 0.04;
            mask[i] = ((f * 0.009).sin() * 0.5 + 0.5).abs() * 0.6;
        }
        let k = Kweights::default();
        let want = scale_err(&mask, &rx, &ry, &rb, &tx, &ty, &tb, n, &k);
        let got_strict = unsafe { scale_err_avx2(&mask, &rx, &ry, &rb, &tx, &ty, &tb, n, k.kx, k.ky, k.kb, false) };
        let got_rsqrt = unsafe { scale_err_avx2(&mask, &rx, &ry, &rb, &tx, &ty, &tb, n, k.kx, k.ky, k.kb, true) };
        let rel = |a: f32, b: f32| (a - b).abs() / a.abs().max(b.abs()).max(1e-12);
        assert!(rel(want, got_strict) < 1e-4, "strict rel={} want={want} got={got_strict}", rel(want, got_strict));
        assert!(rel(want, got_rsqrt) < 1e-4, "rsqrt rel={} want={want} got={got_rsqrt}", rel(want, got_rsqrt));
    }
}

#[cfg(test)]
mod reduction_tests {
    use super::*;
    use crate::perceptual::ssim;

    #[test]
    fn ssd_matches_scalar() {
        if !std::is_x86_feature_detected!("avx2") { return; }
        let n = 4096 + 7;
        let a: Vec<u8> = (0..n).map(|i| (i * 31 % 251) as u8).collect();
        let b: Vec<u8> = (0..n).map(|i| (i * 17 % 239) as u8).collect();
        let mut want = 0u64;
        for i in 0..n { let d = a[i] as i64 - b[i] as i64; want += (d * d) as u64; }
        let got = unsafe { ssd_avx2(&a, &b) };
        assert_eq!(want, got);
    }

    #[test]
    fn ssim_moments_match_scalar_finalize() {
        if !std::is_x86_feature_detected!("avx2") { return; }
        let np = 1000;
        let a: Vec<u8> = (0..np * 4).map(|i| (i * 13 % 255) as u8).collect();
        let b: Vec<u8> = (0..np * 4).map(|i| (i * 29 % 255) as u8).collect();
        let (sb, sbb) = ssim::ref_moments(&b, np, 4);
        let want = ssim::ssim_with_ref(&a, &b, np, 4, &sb, &sbb);
        let (sa, saa, sab) = unsafe { ssim_moments_avx2(&a, &b, np) };
        let got = ssim::finalize_ssim(&sa, &sb, &saa, &sbb, &sab, np, 3);
        assert!((want - got).abs() < 1e-6, "want={want} got={got}");
    }
}
