//! Butteraugli-approx scale error + 2× area downsample. Port of the JS
//! `scaleErr` and `dn2`. `scale_err` returns the per-scale p-norm (p=3).

/// Per-channel weights (opponent X highest, luminance Y mid, blue B lowest).
#[derive(Clone, Copy)]
pub struct Kweights {
    pub kx: f32,
    pub ky: f32,
    pub kb: f32,
}
impl Default for Kweights {
    fn default() -> Self {
        Kweights { kx: 24.0, ky: 12.0, kb: 4.0 }
    }
}

/// Scalar reference p-norm error at one scale. `sum` accumulates in f64 to match
/// the JS number semantics; the `(mask*2+0.15).max(0.15)` clamp is kept literal.
pub(crate) fn scale_err(
    mask: &[f32],
    rx: &[f32], ry: &[f32], rb: &[f32],
    tx: &[f32], ty: &[f32], tb: &[f32],
    n: usize,
    k: &Kweights,
) -> f32 {
    // Empty input has no samples; dividing 0.0/0.0 below would yield NaN and
    // poison the weighted butteraugli total. Guard the degenerate case (valid
    // n > 0 inputs are unaffected). Mirrors the np == 0 guards in ssim.rs.
    if n == 0 {
        return 0.0;
    }
    // Pin all seven inputs to the active length once so the per-pixel loop proves
    // every index in-bounds and LLVM elides the bounds checks (the SIMD kernels
    // already carry an equivalent `len >= n` guard). Byte-exact: the arithmetic and
    // the f64 reduction order are unchanged — reassociating into `base * inv²` would
    // shift rounding and break parity, so it is deliberately NOT done here. This
    // stays the bit-reference for scale_err_{avx2,avx512,wasm}.
    let mask = &mask[..n];
    let rx = &rx[..n];
    let ry = &ry[..n];
    let rb = &rb[..n];
    let tx = &tx[..n];
    let ty = &ty[..n];
    let tb = &tb[..n];
    let (kx, ky, kb) = (k.kx, k.ky, k.kb);
    let mut sum = 0f64;
    for i in 0..n {
        let m = (mask[i] * 2.0 + 0.15).max(0.15);
        let inv = 1.0 / m;
        let ex = (rx[i] - tx[i]) * inv;
        let ey = (ry[i] - ty[i]) * inv;
        let eb = (rb[i] - tb[i]) * inv;
        let e2 = kx * ex * ex + ky * ey * ey + kb * eb * eb;
        sum += (e2 * (e2 + 1e-12).sqrt()) as f64; // e2^(3/2)
    }
    // cbrt() is faster and more accurate than powf(1.0/3.0) (two transcendentals).
    ((sum / n as f64).cbrt()) as f32
}

/// 2× area downsample (box) of one plane → (dst, dw, dh). Port of `dn2`.
///
/// Allocates its own output Vec. For construction-time use where a pre-allocated
/// buffer is available, prefer `dn2_into` to avoid the internal allocation.
pub(crate) fn dn2(src: &[f32], w: usize, h: usize) -> (Vec<f32>, usize, usize) {
    // A 0-extent source has no pixels to sample. The `.max(1)` below would still
    // claim a 1x1 destination, and `h - 1` / `w - 1` would underflow usize and
    // panic on the empty `src` index. Return an empty plane for degenerate input
    // (the sole real caller is guarded by `w > 1 && h > 1`, so valid downsamples
    // are unaffected).
    if w == 0 || h == 0 {
        return (Vec::new(), 0, 0);
    }
    let dw = (w >> 1).max(1);
    let dh = (h >> 1).max(1);
    let mut dst = vec![0f32; dw * dh];
    dn2_into(src, &mut dst, w, h, dw, dh);
    (dst, dw, dh)
}

/// 2× area downsample (box) into a caller-supplied output slice.
/// `dst` must have length >= dw*dh where dw=(w>>1).max(1), dh=(h>>1).max(1).
/// Avoids the internal allocation of `dn2`; useful when the caller pre-allocates
/// the destination buffer (e.g. during Comparer construction to reduce peak RSS).
pub(crate) fn dn2_into(src: &[f32], dst: &mut [f32], w: usize, h: usize, dw: usize, dh: usize) {
    // Production pyramid path: w>1, h>1, dw=w/2, dh=h/2. There the `.min(w-1)`/`.min(h-1)`
    // edge clamps provably never fire — floor-halving drops any odd final row/column
    // before it could be sampled, so `2x+1 <= w-1` and `2y+1 <= h-1` for every output.
    // Emit a clamp-free 2×2 box reduction over chunked rows: `chunks_exact` lets LLVM
    // prove the four loads + store in-bounds (no per-pixel bounds checks, no per-pixel
    // `min`). The four-add order is preserved, so the result is byte-identical to the
    // clamped loop and this stays the parity oracle for downsample_{avx2,avx512,wasm}.
    if w > 1 && h > 1 && dw == w >> 1 && dh == h >> 1 {
        let src = &src[..w * h];
        let dst = &mut dst[..dw * dh];
        for (dst_row, rows) in dst.chunks_exact_mut(dw).zip(src.chunks_exact(w * 2)) {
            let (top, bottom) = rows.split_at(w);
            for ((t, b), o) in top
                .chunks_exact(2)
                .zip(bottom.chunks_exact(2))
                .zip(dst_row.iter_mut())
            {
                *o = (t[0] + t[1] + b[0] + b[1]) * 0.25;
            }
        }
        return;
    }
    // Edge-clamped fallback for 1-pixel dimensions or non-standard destination geometry.
    for y in 0..dh {
        let sy0 = y << 1;
        let sy1 = (sy0 + 1).min(h - 1);
        for x in 0..dw {
            let sx0 = x << 1;
            let sx1 = (sx0 + 1).min(w - 1);
            dst[y * dw + x] = (src[sy0 * w + sx0]
                + src[sy0 * w + sx1]
                + src[sy1 * w + sx0]
                + src[sy1 * w + sx1])
                * 0.25;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_scale_err_is_zero() {
        let n = 16;
        let z = vec![0.5f32; n];
        let mask = vec![0.3f32; n];
        let e = scale_err(&mask, &z, &z, &z, &z, &z, &z, n, &Kweights::default());
        assert!(e.abs() < 1e-6, "got {e}");
    }

    #[test]
    fn dn2_halves_and_averages() {
        // 2x2 all-ones → 1x1 == 1.0
        let src = vec![1.0f32; 4];
        let (d, dw, dh) = dn2(&src, 2, 2);
        assert_eq!((dw, dh), (1, 1));
        assert!((d[0] - 1.0).abs() < 1e-6);
    }
}
