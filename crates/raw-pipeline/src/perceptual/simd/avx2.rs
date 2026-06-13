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
    let half = _mm256_set1_ps(0.5); // loop-invariant rsqrt Newton constants
    let threehalf = _mm256_set1_ps(1.5);
    let mut acc = _mm256_setzero_ps();

    let lanes = n / 8 * 8;
    let mut i = 0;
    while i < lanes {
        let m = _mm256_loadu_ps(mask.as_ptr().add(i));
        // m = max(mask*2 + 0.15, 0.15)
        let mm = _mm256_max_ps(_mm256_fmadd_ps(m, v2, v015), v015);
        let inv = if rsqrt_path {
            // rcp(mm) refined one Newton step: r1 = r0 * (2 - mm*r0)
            let r0 = _mm256_rcp_ps(mm);
            _mm256_mul_ps(r0, _mm256_fnmadd_ps(mm, r0, _mm256_set1_ps(2.0)))
        } else {
            _mm256_div_ps(_mm256_set1_ps(1.0), mm)
        };
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
            // y1 = y0 * (1.5 - 0.5*z*y0*y0)  (one Newton step on 1/sqrt(z))
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

/// SSIM moment accumulation over RGBA test+ref. Produces three per-channel sums
/// (sa, saa, sab) for c in 0..3; sb/sbb are precomputed on the reference.
///
/// NOTE: this is a *scalar* u64 reduction, not vectorized. A madd-based SIMD
/// deinterleave gave no measured win in pilot timing (confirmed by the flip-flop
/// bench), so the scalar loop is kept here — inside the avx2 module purely so the
/// dispatcher has one call site. Correctness == scalar oracle by construction.
/// Carries `#[target_feature(enable = "avx2")]` only for call-site uniformity; it
/// uses no AVX2 intrinsics.
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

/// AVX2 RGBA(u8) → planar X/Y/B using i32-gather over the sqrt-linear LUT.
/// `lut` must point to a 256-entry f32 table. Processes 8 px/iter + scalar tail.
#[target_feature(enable = "avx2")]
pub unsafe fn pixels_to_xyb_avx2(
    px: &[u8],
    n: usize,
    lut: *const f32,
    x: &mut [f32],
    y: &mut [f32],
    b: &mut [f32],
) {
    let half = _mm256_set1_ps(0.5);
    let lanes = n / 8 * 8;
    let mut i = 0;
    while i < lanes {
        // Gather the 8 R/G/B bytes (stride 4) for px[i..i+8] into i32 index vectors.
        let mut ri = [0i32; 8];
        let mut gi = [0i32; 8];
        let mut bi = [0i32; 8];
        for l in 0..8 {
            let base = (i + l) * 4;
            ri[l] = *px.get_unchecked(base) as i32;
            gi[l] = *px.get_unchecked(base + 1) as i32;
            bi[l] = *px.get_unchecked(base + 2) as i32;
        }
        let r = _mm256_i32gather_ps(lut, _mm256_loadu_si256(ri.as_ptr() as *const __m256i), 4);
        let g = _mm256_i32gather_ps(lut, _mm256_loadu_si256(gi.as_ptr() as *const __m256i), 4);
        let bb = _mm256_i32gather_ps(lut, _mm256_loadu_si256(bi.as_ptr() as *const __m256i), 4);
        // X=(r-b)*0.5 ; Y=(r+b)*0.5+g ; B=b
        _mm256_storeu_ps(x.as_mut_ptr().add(i), _mm256_mul_ps(_mm256_sub_ps(r, bb), half));
        _mm256_storeu_ps(
            y.as_mut_ptr().add(i),
            _mm256_fmadd_ps(_mm256_add_ps(r, bb), half, g),
        );
        _mm256_storeu_ps(b.as_mut_ptr().add(i), bb);
        i += 8;
    }
    // scalar tail
    let lut_s = core::slice::from_raw_parts(lut, 256);
    while i < n {
        let j = i * 4;
        let r = lut_s[px[j] as usize];
        let g = lut_s[px[j + 1] as usize];
        let bb = lut_s[px[j + 2] as usize];
        x[i] = (r - bb) * 0.5;
        y[i] = (r + bb) * 0.5 + g;
        b[i] = bb;
        i += 1;
    }
}

/// AVX2 2× box downsample of a single plane (w×h) into `dst` (dw×dh).
/// Interior fast path: 8 output px/iter via permutevar8x32 deinterleave;
/// edges handled by scalar remainder.
#[target_feature(enable = "avx2")]
pub unsafe fn downsample_avx2(
    src: &[f32],
    dst: &mut [f32],
    w: usize,
    h: usize,
    dw: usize,
    dh: usize,
) {
    let quarter = _mm256_set1_ps(0.25);
    // Index vectors for _mm256_permutevar8x32_ps to extract even/odd lanes
    // from a 16-float pair of 256-bit registers.
    // Given p00=[s0,s1,s2,s3,s4,s5,s6,s7] and p01=[s8,s9,s10,s11,s12,s13,s14,s15]:
    //   even = [s0,s2,s4,s6, s8,s10,s12,s14]  (indices 0,2,4,6 from p00, 0,2,4,6 from p01)
    //   odd  = [s1,s3,s5,s7, s9,s11,s13,s15]  (indices 1,3,5,7 from p00, 1,3,5,7 from p01)
    // We use _mm256_permutevar8x32_ps on each register with even/odd index vectors,
    // then combine with _mm256_permute2f128_ps.
    //
    // _mm256_permutevar8x32_ps permutes within the full 256-bit register (all 8 lanes).
    // For p00: even_lo_idx=[0,2,4,6,0,2,4,6], odd_lo_idx=[1,3,5,7,1,3,5,7]
    // For p01: same indices
    // Then we take [lo 128 of permuted_p00, lo 128 of permuted_p01] via permute2f128.
    let even_idx = _mm256_setr_epi32(0, 2, 4, 6, 0, 2, 4, 6);
    let odd_idx = _mm256_setr_epi32(1, 3, 5, 7, 1, 3, 5, 7);

    for y in 0..dh {
        let sy0 = y << 1;
        let sy1 = if sy0 + 1 < h { sy0 + 1 } else { h - 1 };
        let row0 = sy0 * w;
        let row1 = sy1 * w;
        let drow = y * dw;
        // Bulk: 8 output px at a time. Each reads 16 src floats per row (2 src px per out px).
        // Need 2*8=16 src floats, which means src indices start at 2*x, length 16.
        // Require 2*x+15 < w, i.e. x <= (w-16)/2 = dw - 8 when w is even.
        // Safe bulk count: we need row0+2*x+15 < w*h and row1+2*x+15 similarly.
        // Simplest: bulk while 2*(x+8) <= w, i.e., x+8 <= dw (w even case).
        // For safety just check 2*x+15 < w for the last bulk iteration.
        // Bulk reads src[2x..2x+16] per row, so the guard `2*x+16 <= w` keeps the
        // load in-bounds; the scalar remainder handles the (clamped) odd-width tail.
        let mut x = 0usize;
        while x + 8 <= dw && 2 * x + 16 <= w {
            // Load 16 consecutive src floats per row starting at src[row0 + 2*x].
            let p00 = _mm256_loadu_ps(src.as_ptr().add(row0 + 2 * x));       // s0..s7
            let p01 = _mm256_loadu_ps(src.as_ptr().add(row0 + 2 * x + 8));   // s8..s15
            let p10 = _mm256_loadu_ps(src.as_ptr().add(row1 + 2 * x));
            let p11 = _mm256_loadu_ps(src.as_ptr().add(row1 + 2 * x + 8));

            // Deinterleave: extract even-indexed lanes (sx0) and odd-indexed (sx1).
            // permutevar8x32 on p00 with even_idx=[0,2,4,6,0,2,4,6]:
            //   lo 4 lanes = s0,s2,s4,s6 (correct even from p00)
            //   hi 4 lanes = s0,s2,s4,s6 (duplicate — discarded)
            // permutevar8x32 on p01 with even_idx:
            //   lo 4 lanes = s8,s10,s12,s14 (correct even from p01)
            //   hi 4 lanes = duplicate — discarded
            // Then permute2f128 with imm8=0x20 takes lo128 of first, lo128 of second.
            let e0_perm = _mm256_permutevar8x32_ps(p00, even_idx);
            let e1_perm = _mm256_permutevar8x32_ps(p01, even_idx);
            let even_r0 = _mm256_permute2f128_ps(e0_perm, e1_perm, 0x20); // [s0,s2,s4,s6,s8,s10,s12,s14]

            let o0_perm = _mm256_permutevar8x32_ps(p00, odd_idx);
            let o1_perm = _mm256_permutevar8x32_ps(p01, odd_idx);
            let odd_r0 = _mm256_permute2f128_ps(o0_perm, o1_perm, 0x20);  // [s1,s3,s5,s7,s9,s11,s13,s15]

            let e0_perm10 = _mm256_permutevar8x32_ps(p10, even_idx);
            let e1_perm10 = _mm256_permutevar8x32_ps(p11, even_idx);
            let even_r1 = _mm256_permute2f128_ps(e0_perm10, e1_perm10, 0x20);

            let o0_perm10 = _mm256_permutevar8x32_ps(p10, odd_idx);
            let o1_perm10 = _mm256_permutevar8x32_ps(p11, odd_idx);
            let odd_r1 = _mm256_permute2f128_ps(o0_perm10, o1_perm10, 0x20);

            // sum = (even_r0 + odd_r0) + (even_r1 + odd_r1)
            let sum = _mm256_add_ps(
                _mm256_add_ps(even_r0, odd_r0),
                _mm256_add_ps(even_r1, odd_r1),
            );
            _mm256_storeu_ps(dst.as_mut_ptr().add(drow + x), _mm256_mul_ps(sum, quarter));
            x += 8;
        }
        // scalar remainder + clamped last column
        while x < dw {
            let sx0 = x << 1;
            let sx1 = if sx0 + 1 < w { sx0 + 1 } else { w - 1 };
            dst[drow + x] = (src[row0 + sx0]
                + src[row0 + sx1]
                + src[row1 + sx0]
                + src[row1 + sx1])
                * 0.25;
            x += 1;
        }
    }
}

#[cfg(test)]
mod xyb_tests {
    use super::*;
    use crate::perceptual::xyb::{pixels_to_xyb, sqrt_lin_lut_ptr};

    #[test]
    fn xyb_avx2_matches_scalar() {
        if !(std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma")) {
            return;
        }
        let n = 1000usize; // non-multiple of 8
        let px: Vec<u8> = (0..n * 4).map(|i| (i * 37 % 256) as u8).collect();
        let (mut sx, mut sy, mut sb) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
        pixels_to_xyb(&px, n, &mut sx, &mut sy, &mut sb);
        let (mut ax, mut ay, mut ab) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
        unsafe { pixels_to_xyb_avx2(&px, n, sqrt_lin_lut_ptr(), &mut ax, &mut ay, &mut ab) };
        for i in 0..n {
            assert!((sx[i] - ax[i]).abs() < 1e-6, "x[{i}] {} vs {}", sx[i], ax[i]);
            assert!((sy[i] - ay[i]).abs() < 1e-6, "y[{i}] {} vs {}", sy[i], ay[i]);
            assert!((sb[i] - ab[i]).abs() < 1e-6, "b[{i}] {} vs {}", sb[i], ab[i]);
        }
    }
}

#[cfg(test)]
mod downsample_tests {
    use super::*;
    use crate::perceptual::butteraugli::dn2;

    #[test]
    fn downsample_avx2_matches_dn2() {
        if !std::is_x86_feature_detected!("avx2") {
            return;
        }
        for (w, h) in [(64usize, 48usize), (65, 49), (2, 2), (33, 17)] {
            let src: Vec<f32> = (0..w * h).map(|i| (i as f32 * 0.013).sin()).collect();
            let (want, dw, dh) = dn2(&src, w, h);
            let mut got = vec![0f32; dw * dh];
            unsafe { downsample_avx2(&src, &mut got, w, h, dw, dh) };
            for i in 0..dw * dh {
                assert!(
                    (want[i] - got[i]).abs() < 1e-5,
                    "({w}x{h})[{i}] {} vs {}",
                    want[i],
                    got[i]
                );
            }
        }
    }
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
