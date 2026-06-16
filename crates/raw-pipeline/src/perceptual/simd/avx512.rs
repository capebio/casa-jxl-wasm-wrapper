//! AVX-512 implementations (f32x16). Mirrors the AVX2 module at 2× width, with
//! the fast `vgatherdps` that motivates this path on server CPUs.
//!
//! NOT executed on the dev machine (i7-10850H lacks AVX-512); the parity tests
//! below skip unless `avx512f`+`avx512bw` are detected. Each public fn is `unsafe`
//! and must only be called after `detect_native` confirmed AVX-512.

#![cfg(target_arch = "x86_64")]

use core::arch::x86_64::*;

/// AVX-512 strict scale error (p=3). `rsqrt_path` swaps `1/m` and `sqrt(e2)` for
/// refined rcp14/rsqrt14 approximations. Mirrors `avx2::scale_err_avx2`.
#[target_feature(enable = "avx512f")]
pub unsafe fn scale_err_avx512(
    mask: &[f32],
    rx: &[f32], ry: &[f32], rb: &[f32],
    tx: &[f32], ty: &[f32], tb: &[f32],
    n: usize,
    kx: f32, ky: f32, kb: f32,
    rsqrt_path: bool,
) -> f32 {
    let vkx = _mm512_set1_ps(kx);
    let vky = _mm512_set1_ps(ky);
    let vkb = _mm512_set1_ps(kb);
    let v2 = _mm512_set1_ps(2.0);
    let v015 = _mm512_set1_ps(0.15);
    let veps = _mm512_set1_ps(1e-12);
    let vone = _mm512_set1_ps(1.0);
    let half = _mm512_set1_ps(0.5);
    let threehalf = _mm512_set1_ps(1.5);
    let mut acc = _mm512_setzero_ps();

    let lanes = n / 16 * 16;
    let mut i = 0;
    while i < lanes {
        let m = _mm512_loadu_ps(mask.as_ptr().add(i));
        let mm = _mm512_max_ps(_mm512_fmadd_ps(m, v2, v015), v015);
        let inv = if rsqrt_path {
            // rcp14(mm) refined one Newton step: r1 = r0 * (2 - mm*r0)
            let r0 = _mm512_rcp14_ps(mm);
            _mm512_mul_ps(r0, _mm512_fnmadd_ps(mm, r0, v2))
        } else {
            _mm512_div_ps(vone, mm)
        };
        let ex = _mm512_mul_ps(_mm512_sub_ps(_mm512_loadu_ps(rx.as_ptr().add(i)), _mm512_loadu_ps(tx.as_ptr().add(i))), inv);
        let ey = _mm512_mul_ps(_mm512_sub_ps(_mm512_loadu_ps(ry.as_ptr().add(i)), _mm512_loadu_ps(ty.as_ptr().add(i))), inv);
        let eb = _mm512_mul_ps(_mm512_sub_ps(_mm512_loadu_ps(rb.as_ptr().add(i)), _mm512_loadu_ps(tb.as_ptr().add(i))), inv);
        let mut e2 = _mm512_mul_ps(vkx, _mm512_mul_ps(ex, ex));
        e2 = _mm512_fmadd_ps(vky, _mm512_mul_ps(ey, ey), e2);
        e2 = _mm512_fmadd_ps(vkb, _mm512_mul_ps(eb, eb), e2);
        let root = if rsqrt_path {
            let z = _mm512_add_ps(e2, veps);
            let y0 = _mm512_rsqrt14_ps(z);
            let y1 = _mm512_mul_ps(y0, _mm512_fnmadd_ps(_mm512_mul_ps(half, z), _mm512_mul_ps(y0, y0), threehalf));
            _mm512_mul_ps(z, y1)
        } else {
            _mm512_sqrt_ps(_mm512_add_ps(e2, veps))
        };
        acc = _mm512_fmadd_ps(e2, root, acc);
        i += 16;
    }
    let mut sum = _mm512_reduce_add_ps(acc) as f64;
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

/// AVX-512 RGBA(u8) → planar X/Y/B via 16-wide `vgatherdps` over the sqrt-linear
/// LUT. This is the fast-gather path that motivates AVX-512 here.
#[target_feature(enable = "avx512f")]
pub unsafe fn pixels_to_xyb_avx512(px: &[u8], n: usize, lut: *const f32, x: &mut [f32], y: &mut [f32], b: &mut [f32]) {
    let half = _mm512_set1_ps(0.5);
    let lanes = n / 16 * 16;
    let mut i = 0;
    while i < lanes {
        let mut ri = [0i32; 16];
        let mut gi = [0i32; 16];
        let mut bi = [0i32; 16];
        for l in 0..16 {
            let base = (i + l) * 4;
            ri[l] = *px.get_unchecked(base) as i32;
            gi[l] = *px.get_unchecked(base + 1) as i32;
            bi[l] = *px.get_unchecked(base + 2) as i32;
        }
        let r = _mm512_i32gather_ps::<4>(_mm512_loadu_si512(ri.as_ptr() as *const __m512i), lut);
        let g = _mm512_i32gather_ps::<4>(_mm512_loadu_si512(gi.as_ptr() as *const __m512i), lut);
        let bb = _mm512_i32gather_ps::<4>(_mm512_loadu_si512(bi.as_ptr() as *const __m512i), lut);
        _mm512_storeu_ps(x.as_mut_ptr().add(i), _mm512_mul_ps(_mm512_sub_ps(r, bb), half));
        _mm512_storeu_ps(y.as_mut_ptr().add(i), _mm512_fmadd_ps(_mm512_add_ps(r, bb), half, g));
        _mm512_storeu_ps(b.as_mut_ptr().add(i), bb);
        i += 16;
    }
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

/// AVX-512 2× box downsample (16 output px/iter interior, scalar edge). Uses
/// `permutex2var_ps` to split 32 contiguous src floats into even (sx0) / odd (sx1).
#[target_feature(enable = "avx512f")]
pub unsafe fn downsample_avx512(src: &[f32], dst: &mut [f32], w: usize, h: usize, dw: usize, dh: usize) {
    let quarter = _mm512_set1_ps(0.25);
    // even = src indices 0,2,...,30 ; odd = 1,3,...,31 across the concatenated a||b.
    let even_idx = _mm512_setr_epi32(0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30);
    let odd_idx = _mm512_setr_epi32(1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31);
    for yy in 0..dh {
        let sy0 = yy << 1;
        let sy1 = if sy0 + 1 < h { sy0 + 1 } else { h - 1 };
        let row0 = sy0 * w;
        let row1 = sy1 * w;
        let drow = yy * dw;
        let mut xx = 0usize;
        while xx + 16 <= dw && 2 * xx + 32 <= w {
            let a0 = _mm512_loadu_ps(src.as_ptr().add(row0 + 2 * xx));
            let b0 = _mm512_loadu_ps(src.as_ptr().add(row0 + 2 * xx + 16));
            let a1 = _mm512_loadu_ps(src.as_ptr().add(row1 + 2 * xx));
            let b1 = _mm512_loadu_ps(src.as_ptr().add(row1 + 2 * xx + 16));
            let even_r0 = _mm512_permutex2var_ps(a0, even_idx, b0);
            let odd_r0 = _mm512_permutex2var_ps(a0, odd_idx, b0);
            let even_r1 = _mm512_permutex2var_ps(a1, even_idx, b1);
            let odd_r1 = _mm512_permutex2var_ps(a1, odd_idx, b1);
            let sum = _mm512_add_ps(_mm512_add_ps(even_r0, odd_r0), _mm512_add_ps(even_r1, odd_r1));
            _mm512_storeu_ps(dst.as_mut_ptr().add(drow + xx), _mm512_mul_ps(sum, quarter));
            xx += 16;
        }
        while xx < dw {
            let sx0 = xx << 1;
            let sx1 = if sx0 + 1 < w { sx0 + 1 } else { w - 1 };
            dst[drow + xx] = (src[row0 + sx0] + src[row0 + sx1] + src[row1 + sx0] + src[row1 + sx1]) * 0.25;
            xx += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::perceptual::butteraugli::{scale_err, dn2, Kweights};
    use crate::perceptual::xyb::{pixels_to_xyb, sqrt_lin_lut_ptr};

    fn avx512() -> bool {
        std::is_x86_feature_detected!("avx512f") && std::is_x86_feature_detected!("avx512bw")
    }

    #[test]
    fn scale_err_avx512_matches_scalar() {
        if !avx512() { eprintln!("avx512 unavailable — skipping"); return; }
        let n = 1000usize;
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
        let rel = |a: f32, b: f32| (a - b).abs() / a.abs().max(b.abs()).max(1e-12);
        for rsqrt in [false, true] {
            let got = unsafe { scale_err_avx512(&mask, &rx, &ry, &rb, &tx, &ty, &tb, n, k.kx, k.ky, k.kb, rsqrt) };
            assert!(rel(want, got) < 1e-4, "rsqrt={rsqrt} rel={} want={want} got={got}", rel(want, got));
        }
    }

    #[test]
    fn xyb_avx512_matches_scalar() {
        if !avx512() { return; }
        let n = 1000usize;
        let px: Vec<u8> = (0..n * 4).map(|i| (i * 37 % 256) as u8).collect();
        let (mut sx, mut sy, mut sb) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
        pixels_to_xyb(&px, n, &mut sx, &mut sy, &mut sb);
        let (mut ax, mut ay, mut ab) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
        unsafe { pixels_to_xyb_avx512(&px, n, sqrt_lin_lut_ptr(), &mut ax, &mut ay, &mut ab); }
        for i in 0..n {
            assert!((sx[i] - ax[i]).abs() < 1e-6);
            assert!((sy[i] - ay[i]).abs() < 1e-6);
            assert!((sb[i] - ab[i]).abs() < 1e-6);
        }
    }

    #[test]
    fn downsample_avx512_matches_dn2() {
        if !avx512() { return; }
        for (w, h) in [(64usize, 48usize), (65, 49), (2, 2), (33, 17)] {
            let src: Vec<f32> = (0..w * h).map(|i| (i as f32 * 0.013).sin()).collect();
            let (want, dw, dh) = dn2(&src, w, h);
            let mut got = vec![0f32; dw * dh];
            unsafe { downsample_avx512(&src, &mut got, w, h, dw, dh); }
            for i in 0..dw * dh {
                assert!((want[i] - got[i]).abs() < 1e-5);
            }
        }
    }
}
