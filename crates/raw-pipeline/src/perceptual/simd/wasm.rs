//! wasm32 v128 SIMD kernels (4-wide f32). Mirrors the scalar oracle; verified
//! against the JS reference in Node (wasm intrinsics can't run under `cargo test`).
//! The whole module requires the build to enable `+simd128`.
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::*;

/// 4-wide horizontal sum.
#[inline]
fn hsum(v: v128) -> f32 {
    f32x4_extract_lane::<0>(v)
        + f32x4_extract_lane::<1>(v)
        + f32x4_extract_lane::<2>(v)
        + f32x4_extract_lane::<3>(v)
}

/// wasm v128 scale error (p=3). Strict full sqrt; mirrors scalar `scale_err`.
pub fn scale_err_wasm(
    mask: &[f32], rx: &[f32], ry: &[f32], rb: &[f32],
    tx: &[f32], ty: &[f32], tb: &[f32], n: usize,
    kx: f32, ky: f32, kb: f32,
) -> f32 {
    // All seven slices are read via v128_load up to index `lanes < n` and indexed
    // up to `n-1` in the scalar tail. Encode the caller's >= n length invariant so
    // a desynced level size traps in debug instead of OOB-reading wasm memory.
    debug_assert!(
        mask.len() >= n && rx.len() >= n && ry.len() >= n && rb.len() >= n
            && tx.len() >= n && ty.len() >= n && tb.len() >= n,
        "scale_err_wasm: a slice is shorter than n"
    );
    let vkx = f32x4_splat(kx);
    let vky = f32x4_splat(ky);
    let vkb = f32x4_splat(kb);
    let v2 = f32x4_splat(2.0);
    let v015 = f32x4_splat(0.15);
    let veps = f32x4_splat(1e-12);
    let one = f32x4_splat(1.0);
    let mut acc = f32x4_splat(0.0);
    let lanes = n / 4 * 4;
    let mut i = 0;
    unsafe {
        while i < lanes {
            let m = v128_load(mask.as_ptr().add(i) as *const v128);
            let mm = f32x4_max(f32x4_add(f32x4_mul(m, v2), v015), v015);
            let inv = f32x4_div(one, mm);
            let ex = f32x4_mul(f32x4_sub(v128_load(rx.as_ptr().add(i) as *const v128), v128_load(tx.as_ptr().add(i) as *const v128)), inv);
            let ey = f32x4_mul(f32x4_sub(v128_load(ry.as_ptr().add(i) as *const v128), v128_load(ty.as_ptr().add(i) as *const v128)), inv);
            let eb = f32x4_mul(f32x4_sub(v128_load(rb.as_ptr().add(i) as *const v128), v128_load(tb.as_ptr().add(i) as *const v128)), inv);
            let e2 = f32x4_add(
                f32x4_add(f32x4_mul(vkx, f32x4_mul(ex, ex)), f32x4_mul(vky, f32x4_mul(ey, ey))),
                f32x4_mul(vkb, f32x4_mul(eb, eb)),
            );
            let root = f32x4_sqrt(f32x4_add(e2, veps));
            acc = f32x4_add(acc, f32x4_mul(e2, root));
            i += 4;
        }
    }
    let mut sum = hsum(acc) as f64;
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

/// wasm v128 RGBA→planar XYB. Scalar LUT loads (no wasm gather) + vector arithmetic.
pub fn pixels_to_xyb_wasm(px: &[u8], n: usize, lut: &[f32; 256], x: &mut [f32], y: &mut [f32], b: &mut [f32]) {
    // Reads px via get_unchecked up to (n-1)*4+2 and v128_store/index x/y/b up to
    // n-1. Encode the caller's length invariant so a wrapped/mismatched n (wasm32
    // usize is 32-bit) traps in debug instead of OOB-reading/writing wasm memory.
    debug_assert!(
        px.len() >= n * 4 && x.len() >= n && y.len() >= n && b.len() >= n,
        "pixels_to_xyb_wasm: px shorter than n*4 or an output plane shorter than n"
    );
    let half = f32x4_splat(0.5);
    let lanes = n / 4 * 4;
    let mut i = 0;
    unsafe {
        while i < lanes {
            let mut r = [0f32; 4];
            let mut g = [0f32; 4];
            let mut bb = [0f32; 4];
            for l in 0..4 {
                let j = (i + l) * 4;
                r[l] = lut[*px.get_unchecked(j) as usize];
                g[l] = lut[*px.get_unchecked(j + 1) as usize];
                bb[l] = lut[*px.get_unchecked(j + 2) as usize];
            }
            let rv = v128_load(r.as_ptr() as *const v128);
            let gv = v128_load(g.as_ptr() as *const v128);
            let bv = v128_load(bb.as_ptr() as *const v128);
            v128_store(x.as_mut_ptr().add(i) as *mut v128, f32x4_mul(f32x4_sub(rv, bv), half));
            v128_store(y.as_mut_ptr().add(i) as *mut v128, f32x4_add(f32x4_mul(f32x4_add(rv, bv), half), gv));
            v128_store(b.as_mut_ptr().add(i) as *mut v128, bv);
            i += 4;
        }
    }
    while i < n {
        let j = i * 4;
        let r = lut[px[j] as usize];
        let g = lut[px[j + 1] as usize];
        let bb = lut[px[j + 2] as usize];
        x[i] = (r - bb) * 0.5;
        y[i] = (r + bb) * 0.5 + g;
        b[i] = bb;
        i += 1;
    }
}

/// wasm v128 2× box downsample. Kept scalar: the 4-wide even/odd deinterleave
/// overhead rarely beats scalar at this width; the Node flip-flop (Task D2) can
/// revisit if profiling warrants.
pub fn downsample_wasm(src: &[f32], dst: &mut [f32], w: usize, h: usize, dw: usize, dh: usize) {
    for y in 0..dh {
        let sy0 = y << 1;
        let sy1 = (sy0 + 1).min(h - 1);
        for x in 0..dw {
            let sx0 = x << 1;
            let sx1 = (sx0 + 1).min(w - 1);
            dst[y * dw + x] = (src[sy0 * w + sx0] + src[sy0 * w + sx1] + src[sy1 * w + sx0] + src[sy1 * w + sx1]) * 0.25;
        }
    }
}
