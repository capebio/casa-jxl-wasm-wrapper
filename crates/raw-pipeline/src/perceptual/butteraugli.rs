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
    let mut sum = 0f64;
    for i in 0..n {
        let m = (mask[i] * 2.0 + 0.15).max(0.15);
        let inv = 1.0 / m;
        let ex = (rx[i] - tx[i]) * inv;
        let ey = (ry[i] - ty[i]) * inv;
        let eb = (rb[i] - tb[i]) * inv;
        let e2 = k.kx * ex * ex + k.ky * ey * ey + k.kb * eb * eb;
        sum += (e2 * (e2 + 1e-12).sqrt()) as f64; // e2^(3/2)
    }
    ((sum / n as f64).powf(1.0 / 3.0)) as f32
}

/// 2× area downsample (box) of one plane → (dst, dw, dh). Port of `dn2`.
pub(crate) fn dn2(src: &[f32], w: usize, h: usize) -> (Vec<f32>, usize, usize) {
    let dw = (w >> 1).max(1);
    let dh = (h >> 1).max(1);
    let mut dst = vec![0f32; dw * dh];
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
    (dst, dw, dh)
}

// ---------------------------------------------------------------------------
// Optimised AOS pipeline types
// ---------------------------------------------------------------------------

/// Pre-scaled opponent-space weights baked into XYB coordinates at conversion
/// time. Comparison becomes `dot(delta, delta)` — no per-pixel weight muls.
/// SX ≈ sqrt(kx=24), SY ≈ sqrt(ky=12), SB is tuned (not exact sqrt(kb=4)).
pub const SX: f32 = 4.899;
pub const SY: f32 = 3.464;
pub const SB: f32 = 1.900;

/// AOS pixel in pre-scaled perceptual space.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct PerceptualPixel {
    pub x: f32,
    pub y: f32,
    pub b: f32,
}

/// One pyramid level: AOS pixels + precomputed inverse mask.
/// `inv_mask[i] = 1.0 / (0.15 + |pixel.y - row_mean_y|)`
pub struct ImageLevel {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<PerceptualPixel>,
    pub inv_mask: Vec<f32>,
}

impl ImageLevel {
    pub fn new(width: usize, height: usize) -> Self {
        let n = width * height;
        ImageLevel {
            width,
            height,
            pixels: vec![PerceptualPixel::default(); n],
            inv_mask: vec![1.0f32 / 0.15; n],
        }
    }
}

/// 3-level perceptual pyramid (full / half / quarter resolution).
pub struct PerceptualImage {
    pub levels: Vec<ImageLevel>,  // always 3 entries, index 0 = full res
}

// ---------------------------------------------------------------------------
// Pyramid builder
// ---------------------------------------------------------------------------

/// AOS 2× box downsample. One loop per output pixel, one traversal.
pub fn downsample_perceptual(
    src: &[PerceptualPixel],
    dst: &mut [PerceptualPixel],
    w: usize,
    h: usize,
    dw: usize,
    dh: usize,
) {
    for y in 0..dh {
        let sy0 = y << 1;
        let sy1 = (sy0 + 1).min(h - 1);
        for x in 0..dw {
            let sx0 = x << 1;
            let sx1 = (sx0 + 1).min(w - 1);
            let a = src[sy0 * w + sx0];
            let b = src[sy0 * w + sx1];
            let c = src[sy1 * w + sx0];
            let d = src[sy1 * w + sx1];
            dst[y * dw + x] = PerceptualPixel {
                x: (a.x + b.x + c.x + d.x) * 0.25,
                y: (a.y + b.y + c.y + d.y) * 0.25,
                b: (a.b + b.b + c.b + d.b) * 0.25,
            };
        }
    }
}

/// Build a 3-level perceptual pyramid from RGBA u8 input (alpha ignored).
/// One read pass: RGBA → level0 AOS pixels. Two AOS downsample passes.
/// Mask computed after pyramid via activity from row-means of Y channel.
pub fn build_perceptual_image(rgba: &[u8], width: usize, height: usize) -> PerceptualImage {
    use crate::perceptual::xyb::sqrt_lin_lut;
    let lut = sqrt_lin_lut();
    let n = width * height;
    debug_assert_eq!(rgba.len(), n * 4, "build_perceptual_image: expected RGBA");

    // Level 0: RGBA → pre-scaled AOS XYB
    let mut level0 = ImageLevel::new(width, height);
    for i in 0..n {
        let j = i * 4;
        let r = lut[rgba[j] as usize];
        let g = lut[rgba[j + 1] as usize];
        let b = lut[rgba[j + 2] as usize];
        level0.pixels[i] = PerceptualPixel {
            x: (r - b) * 0.5 * SX,
            y: ((r + b) * 0.5 + g) * SY,
            b: b * SB,
        };
    }

    // Level 1: 2× downsample
    let dw1 = (width >> 1).max(1);
    let dh1 = (height >> 1).max(1);
    let mut level1 = ImageLevel::new(dw1, dh1);
    downsample_perceptual(&level0.pixels, &mut level1.pixels, width, height, dw1, dh1);

    // Level 2: 4× downsample (from level1)
    let dw2 = (dw1 >> 1).max(1);
    let dh2 = (dh1 >> 1).max(1);
    let mut level2 = ImageLevel::new(dw2, dh2);
    downsample_perceptual(&level1.pixels, &mut level2.pixels, dw1, dh1, dw2, dh2);

    compute_inv_mask(&mut level0);
    compute_inv_mask(&mut level1);
    compute_inv_mask(&mut level2);

    PerceptualImage { levels: vec![level0, level1, level2] }
}

/// Compute inverse mask from local Y activity (row-mean approximation).
/// High-activity rows tolerate more error → lower inv_mask value.
pub fn compute_inv_mask(level: &mut ImageLevel) {
    let (w, h) = (level.width, level.height);
    for y in 0..h {
        let base = y * w;
        let mut sum = 0f32;
        for x in 0..w {
            sum += level.pixels[base + x].y;
        }
        let mean = sum / w as f32;
        for x in 0..w {
            let activity = (level.pixels[base + x].y - mean).abs();
            level.inv_mask[base + x] = 1.0 / (0.15 + activity);
        }
    }
}

// ---------------------------------------------------------------------------
// Compare kernel
// ---------------------------------------------------------------------------

/// Polynomial approximation of x^(3/2). Tuned for x ∈ [0, 2].
/// Replaces `e2 * sqrt(e2 + eps)` from `scale_err`. ~3–4× faster (no sqrt).
/// Score values differ from original by design; use AlgorithmMode::Reference
/// (existing scale_err) as regression oracle.
#[inline(always)]
pub fn fast_response(x: f32) -> f32 {
    x * (0.75 + 0.25 * x)
}

/// Compare two pyramid levels. Returns sum of fast_response(masked_error_sq).
/// Reference inv_mask applied: high-activity pixels weighted down.
/// Hot loop: pure dot(delta, delta) — weights baked into SX/SY/SB at build time.
pub fn compare_level(ref_level: &ImageLevel, test_level: &ImageLevel) -> f32 {
    let n = ref_level.width * ref_level.height;
    debug_assert_eq!(n, test_level.width * test_level.height, "compare_level: dim mismatch");
    let mut total = 0.0f32;
    for i in 0..n {
        let rp = ref_level.pixels[i];
        let tp = test_level.pixels[i];
        let inv = ref_level.inv_mask[i];
        let dx = (rp.x - tp.x) * inv;
        let dy = (rp.y - tp.y) * inv;
        let db = (rp.b - tp.b) * inv;
        let e = dx * dx + dy * dy + db * db;
        total += fast_response(e);
    }
    total
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

    // ---- AOS type tests ----

    #[test]
    fn perceptual_pixel_default_is_zero() {
        let p = PerceptualPixel::default();
        assert_eq!(p.x, 0.0);
        assert_eq!(p.y, 0.0);
        assert_eq!(p.b, 0.0);
    }

    #[test]
    fn image_level_dimensions_match() {
        let lvl = ImageLevel::new(4, 4);
        assert_eq!(lvl.pixels.len(), 16);
        assert_eq!(lvl.inv_mask.len(), 16);
    }

    #[test]
    fn sx_sy_sb_constants_approx_sqrt_k() {
        assert!((SX - 24.0f32.sqrt()).abs() < 0.02, "SX={SX}");
        assert!((SY - 12.0f32.sqrt()).abs() < 0.02, "SY={SY}");
        assert!(SB > 1.5 && SB < 2.5, "SB={SB}");
    }

    // ---- Pyramid builder tests ----

    #[test]
    fn build_pyramid_levels_have_correct_dims() {
        let rgba = vec![0u8; 4 * 4 * 4];
        let img = build_perceptual_image(&rgba, 4, 4);
        assert_eq!(img.levels.len(), 3);
        assert_eq!(img.levels[0].width, 4);
        assert_eq!(img.levels[0].height, 4);
        assert_eq!(img.levels[1].width, 2);
        assert_eq!(img.levels[1].height, 2);
        assert_eq!(img.levels[2].width, 1);
        assert_eq!(img.levels[2].height, 1);
    }

    #[test]
    fn build_pyramid_uniform_white_stays_uniform() {
        let rgba = vec![255u8; 4 * 4 * 4];
        let img = build_perceptual_image(&rgba, 4, 4);
        let p0 = img.levels[0].pixels[0];
        let p1 = img.levels[1].pixels[0];
        assert!((p0.x - p1.x).abs() < 1e-4, "x drift: {}", (p0.x - p1.x).abs());
        assert!((p0.y - p1.y).abs() < 1e-4, "y drift: {}", (p0.y - p1.y).abs());
        assert!((p0.b - p1.b).abs() < 1e-4, "b drift: {}", (p0.b - p1.b).abs());
    }

    #[test]
    fn downsample_perceptual_2x2_uniform() {
        let src = vec![
            PerceptualPixel { x: 1.0, y: 2.0, b: 3.0 },
            PerceptualPixel { x: 1.0, y: 2.0, b: 3.0 },
            PerceptualPixel { x: 1.0, y: 2.0, b: 3.0 },
            PerceptualPixel { x: 1.0, y: 2.0, b: 3.0 },
        ];
        let mut dst = vec![PerceptualPixel::default(); 1];
        downsample_perceptual(&src, &mut dst, 2, 2, 1, 1);
        assert!((dst[0].x - 1.0).abs() < 1e-6);
        assert!((dst[0].y - 2.0).abs() < 1e-6);
        assert!((dst[0].b - 3.0).abs() < 1e-6);
    }

    // ---- Compare kernel tests ----

    #[test]
    fn fast_response_zero_is_zero() {
        assert_eq!(fast_response(0.0), 0.0);
    }

    #[test]
    fn fast_response_positive_and_monotone() {
        let a = fast_response(0.5);
        let b = fast_response(1.0);
        let c = fast_response(2.0);
        assert!(a > 0.0 && b > a && c > b, "a={a} b={b} c={c}");
    }

    #[test]
    fn compare_level_identical_is_zero() {
        let rgba = vec![128u8, 64, 200, 255].repeat(4);
        let img = build_perceptual_image(&rgba, 2, 2);
        let lvl = &img.levels[0];
        let score = compare_level(lvl, lvl);
        assert!(score.abs() < 1e-6, "identical compare returned {score}");
    }

    #[test]
    fn compare_level_different_is_positive() {
        let rgba_a: Vec<u8> = (0..16).flat_map(|_| vec![200u8, 100, 50, 255]).collect();
        let rgba_b: Vec<u8> = (0..16).flat_map(|_| vec![50u8, 200, 100, 255]).collect();
        let img_a = build_perceptual_image(&rgba_a, 4, 4);
        let img_b = build_perceptual_image(&rgba_b, 4, 4);
        let score = compare_level(&img_a.levels[0], &img_b.levels[0]);
        assert!(score > 0.0, "expected positive score, got {score}");
    }
}
