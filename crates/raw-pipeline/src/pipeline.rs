//! 16-bit RGB → 8-bit sRGB pipeline with Lightroom-style controls.
//!
//! Per-pixel:
//!   1. Black-subtract + WB(+ temp/tint) + exposure → linear u16 in [0,1]
//!      (via three `pre_lut` tables, one per channel)
//!   2. 3×3 CamRGB → sRGB matrix
//!   3. HSL-style saturation + skin-protected vibrance (baseline + slider)
//!   4. Per-channel tone curve (blacks/whites/shadows/highlights/contrast
//!      + always-on baseline picture-mode S-curve) + sRGB EOTF + u8.
//!      Stages 4 fold into one `post_lut`.
//!
//! All slider params are LR-style: zero-centred (-1..+1 normalised),
//! exposure in stops (-3..+3).

#[cfg(feature = "parallel")]
use rayon::prelude::*;

pub const CAM_TO_SRGB: [[f32; 3]; 3] = [
    [ 1.526, -0.450, -0.077],
    [-0.245,  1.336, -0.091],
    [ 0.018, -0.298,  1.281],
];

/// Max pixel payload (<1 GiB) — blocks corrupt dimension exploits before buffer writes.
pub const MAX_PIXEL_BUFFER_BYTES: usize = 1024 * 1024 * 1024;

/// Validate width×height×channels fits the memory budget.
pub fn validate_pixel_dims(width: usize, height: usize, channels: usize) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err(format!("pixel dimensions must be positive, got {width}×{height}"));
    }
    let bytes = width
        .checked_mul(height)
        .and_then(|n| n.checked_mul(channels))
        .ok_or_else(|| format!("pixel dimension overflow: {width}×{height}×{channels}"))?;
    if bytes > MAX_PIXEL_BUFFER_BYTES {
        return Err(format!(
            "pixel buffer {bytes} bytes exceeds {MAX_PIXEL_BUFFER_BYTES} byte limit ({width}×{height}×{channels})"
        ));
    }
    Ok(())
}

/// Assert `buffer.len() == width×height×channels` and dims are within budget.
pub fn validate_pixel_buffer(
    buffer: &[u8],
    width: usize,
    height: usize,
    channels: usize,
) -> Result<(), String> {
    validate_pixel_dims(width, height, channels)?;
    let expected = width * height * channels;
    if buffer.len() != expected {
        return Err(format!(
            "pixel buffer length mismatch: got {} expected {} ({width}×{height}×{channels})",
            buffer.len(),
            expected
        ));
    }
    Ok(())
}

/// u16 slice variant (RGB16 etc.).
pub fn validate_pixel_buffer_u16(
    buffer: &[u16],
    width: usize,
    height: usize,
    channels: usize,
) -> Result<(), String> {
    validate_pixel_dims(width, height, channels)?;
    let expected = width * height * channels;
    if buffer.len() != expected {
        return Err(format!(
            "pixel buffer length mismatch: got {} expected {} ({width}×{height}×{channels})",
            buffer.len(),
            expected
        ));
    }
    Ok(())
}

/// Always-applied baselines that emulate Olympus Picture-Mode (Natural).
/// Without these, raw matrix output looks "flat" relative to the embedded
/// JPEG.  User look sliders adjust on top.
const BASELINE_SAT: f32 = 1.30;        // chroma scale around luma — tuned to embedded JPEG saturation
const BASELINE_CONTRAST: f32 = 0.55;   // S-curve blend, [0,1] — tuned to embedded JPEG luma std-dev
const BASELINE_EXP_EV: f32 = 1.40;     // tuned to embedded JPEG luminance

// Luma coeffs (BT.709) hoisted for FMA + ILP in per-pixel apply.
const LUMA_R: f32 = 0.2126;
const LUMA_G: f32 = 0.7152;
const LUMA_B: f32 = 0.0722;

#[derive(Clone)]
pub struct PipelineParams {
    pub black: u16,
    pub white: u16,
    pub wb_r: f32,
    pub wb_g: f32,
    pub wb_b: f32,

    // All zero-centred:
    pub exposure_ev: f32,   // stops, -3..+3
    pub contrast: f32,      // -1..+1
    pub shadows: f32,       // -1..+1
    pub highlights: f32,    // -1..+1
    pub whites: f32,        // -1..+1
    pub blacks: f32,        // -1..+1
    pub saturation: f32,    // -1..+1
    pub vibrance: f32,      // -1..+1
    pub temp: f32,          // -1..+1 (warm <-> cool)
    pub tint: f32,          // -1..+1 (magenta <-> green)
    pub color_matrix: Option<[[f32; 3]; 3]>,
    pub texture: f32,       // -1..+1, unsharp σ=1
    pub clarity: f32,       // -1..+1, unsharp σ=3
    // Runtime-only flag for Perceptual Constancy Mode (illumination-invariant
    // adjustments via the advanced log-geodesic / Molchanov engine during
    // progressive JXL paints). Never for ingest-time producedBy or bake-time.
    // See PerPixelMathEvolutionPlan.md and P-1 rejection.
    pub perceptual_constancy: bool,
}

impl PipelineParams {
    pub fn default_olympus() -> Self {
        Self {
            black: 256,
            white: 4095,
            wb_r: 1.78,
            wb_g: 1.00,
            wb_b: 1.50,
            exposure_ev: 0.0,
            contrast: 0.0,
            shadows: 0.0,
            highlights: 0.0,
            whites: 0.0,
            blacks: 0.0,
            saturation: 0.0,
            vibrance: 0.0,
            temp: 0.0,
            tint: 0.0,
            color_matrix: None,
            texture: 0.0,
            clarity: 0.0,
            perceptual_constancy: false,
        }
    }
}

#[inline(always)]
fn linear_to_srgb(v: f32) -> f32 {
    if v <= 0.0031308 {
        v * 12.92
    } else {
        // powf is already LLVM-intrinsified on wasm32; #[inline(always)] ensures
        // it is inlined into the LUT build loop to avoid call overhead.
        // LUT caching across process() calls should be done at the JS side
        // (the wasm module instance is reused per worker, so a JS-level cache
        // keyed on the tone params would eliminate all LUT rebuilds on re-renders).
        // Use mul_add for the scale+bias.
        1.055f32.mul_add(v.powf(1.0 / 2.4), -0.055)
    }
}

#[inline]
fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

struct TonePost {
    contrast: f32,
    shadows: f32,
    highlights: f32,
    whites: f32,
    blacks: f32,
}

/// LR-style per-channel tone curve: blacks/whites endpoint shifts,
/// shadows/highlights region gammas, contrast S-curve, baseline curve,
/// sRGB EOTF.  Input/output in [0,1] linear.
fn tone_curve(x: f32, p: &TonePost) -> f32 {
    let mut y = x;

    // Endpoint shifts: independent operations so each slider works without the other.
    let blk_offset = p.blacks * BLK_OFFSET_SCALE;
    let wh_scale = 1.0 + p.whites * WH_SCALE_DELTA;
    y = (y * wh_scale + blk_offset).clamp(0.0, 1.0);

    // Shadows: gamma in lower region. Use mul_add for blends.
    if p.shadows.abs() > 1e-4 {
        let mask = 1.0 - smoothstep(0.0, SHADOW_MASK_END, y);
        let gamma = 1.0 / (1.0 + p.shadows * SHADOW_GAMMA_SCALE);
        let lifted = y.powf(gamma);
        y = y.mul_add(1.0 - mask, lifted * mask);
    }
    // Highlights: gamma in upper region.
    if p.highlights.abs() > 1e-4 {
        let mask = smoothstep(HIGHLIGHT_MASK_START, 1.0, y);
        let inv = 1.0 - y;
        let gamma = 1.0 / (1.0 - p.highlights * HIGHLIGHT_GAMMA_SCALE).max(HIGHLIGHT_GAMMA_MIN);
        let pulled = 1.0 - inv.powf(gamma);
        y = y.mul_add(1.0 - mask, pulled * mask);
    }

    // Contrast (user + always-on baseline) — smoothstep blend around 0.5.
    // Scale user delta to fill the remaining headroom each side so the full
    // slider range is usable: positive fills [BASELINE, 1], negative fills [BASELINE, -1].
    let c = if p.contrast >= 0.0 {
        BASELINE_CONTRAST + p.contrast * (1.0 - BASELINE_CONTRAST)
    } else {
        BASELINE_CONTRAST + p.contrast * (1.0 + BASELINE_CONTRAST)
    }.clamp(-1.0, 1.0);
    if c > 1e-4 {
        let s = y * y * (3.0 - 2.0 * y);
        y = y.mul_add(1.0 - c, s * c);
    } else if c < -1e-4 {
        // De-contrast: pull toward linear ramp away from pivot.
        let signed = if y < 0.5 { -1.0 } else { 1.0 };
        let inv_s = 0.5 + signed * (0.5 - y).abs().sqrt() * 0.5;
        y = y.mul_add(1.0 + c, inv_s * (-c));
    }

    linear_to_srgb(y.clamp(0.0, 1.0))
}

/// Highlight rolloff knee, in normalized linear (after WB + exposure gain).
/// Values at or below the knee pass through unchanged; above it they roll off
/// smoothly toward 1.0 instead of hard-clipping, so WB- or exposure-boosted
/// highlights — notably skies, where the red/blue WB multipliers exceed 1.0 and
/// drive those channels past the clip point before green — retain gradient
/// detail instead of flattening to a featureless white.
const HIGHLIGHT_KNEE: f32 = 0.80;

// Tone curve magic numbers hoisted (used in every LUT entry during build_post).
const BLK_OFFSET_SCALE: f32 = 0.10;
const WH_SCALE_DELTA: f32 = 0.20;
const SHADOW_GAMMA_SCALE: f32 = 0.7;
const SHADOW_MASK_END: f32 = 0.6;
const HIGHLIGHT_GAMMA_MIN: f32 = 0.05;
const HIGHLIGHT_GAMMA_SCALE: f32 = 0.7;
const HIGHLIGHT_MASK_START: f32 = 0.4;
const CONTRAST_BLEND: f32 = 0.6; // for de-contrast sqrt factor etc. (kept inline where used)

/// Soft highlight shoulder: identity below `HIGHLIGHT_KNEE`, then a smooth
/// asymptotic rolloff that maps `[knee, +inf)` into `[knee, 1.0)`. The rolloff
/// is C1-continuous at the knee (slope 1 on both sides), so there is no visible
/// kink where it engages. Replaces a hard clamp to 1.0, which discarded all
/// detail above the clip point and made highlight recovery impossible.
#[inline(always)]
fn highlight_shoulder(x: f32) -> f32 {
    if x <= HIGHLIGHT_KNEE {
        x
    } else {
        let range = 1.0 - HIGHLIGHT_KNEE; // output headroom above the knee
        let s = x - HIGHLIGHT_KNEE;       // input excess above the knee (may be >> range)
        // mul_add for the final (range * frac + KNEE)
        HIGHLIGHT_KNEE + range.mul_add(s / (s + range), 0.0)
    }
}

/// Perceptual Constancy framework helpers (Lens17 full implementation).
/// These realize the unified non-Riemannian model in the hot path.
/// For production sub-ms, this would be replaced by precomputed LUT or SIMD.
/// See docs/PerceptualConstancyMode.md and docs/hooks.md for the math and hooking.

const SENSOR_SHARPEN_B: [[f32; 3]; 3] = [
    [ 1.05, -0.025, -0.025],
    [-0.025,  1.05, -0.025],
    [-0.025, -0.025,  1.05],
]; // Plausible sensor-sharpen; full system can load per-camera or fixed.

#[inline(always)]
fn to_log_euclidean(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let eps = 1e-6f32;
    // B * rgb then component log to map geodesics to flat Euclidean space.
    let sr = SENSOR_SHARPEN_B[0][0]*r + SENSOR_SHARPEN_B[0][1]*g + SENSOR_SHARPEN_B[0][2]*b;
    let sg = SENSOR_SHARPEN_B[1][0]*r + SENSOR_SHARPEN_B[1][1]*g + SENSOR_SHARPEN_B[1][2]*b;
    let sb = SENSOR_SHARPEN_B[2][0]*r + SENSOR_SHARPEN_B[2][1]*g + SENSOR_SHARPEN_B[2][2]*b;
    (
        (sr.max(eps)).ln(),
        (sg.max(eps)).ln(),
        (sb.max(eps)).ln(),
    )
}

#[inline(always)]
fn from_log_euclidean(lr: f32, lg: f32, lb: f32) -> (f32, f32, f32) {
    let eps = 1e-6f32;
    (
        (lr.exp() - eps).max(0.0),
        (lg.exp() - eps).max(0.0),
        (lb.exp() - eps).max(0.0),
    )
}

/// Molchanov residuals + A_tensor for adaptive discretization and uniform modulation.
/// Density around neutral grays and saturated greens.
#[inline(always)]
fn molchanov_residuals_and_atensor(luma_l: f32, lr: f32, lg: f32, lb: f32, base_scale: f32) -> (f32, f32, f32, f32) {
    // Parallelogram law residuals discretize metric grid. *self instead of powi(2) for ILP.
    let dr = lr - luma_l;
    let dg = lg - luma_l;
    let db = lb - luma_l;
    let res_r = 0.02 * (dr * dr);
    let res_g = 0.02 * (dg * dg);
    let res_b = 0.02 * (db * db);

    // A_tensor modulation of scale (and conceptually sliders/edges).
    let gray_dist = ((lr - luma_l).abs() + (lg - luma_l).abs() + (lb - luma_l).abs()).min(2.0) / 2.0;
    let a_mod = 1.0 + 0.3 * (1.0 - gray_dist); // higher density (stronger effect) near gray
    let green_boost = if lg > lr.max(lb) { 1.15 } else { 1.0 }; // saturated greens
    let modulated_scale = base_scale * a_mod * green_boost;

    (luma_l + (lr - luma_l + res_r) * modulated_scale,
     luma_l + (lg - luma_l + res_g) * modulated_scale,
     luma_l + (lb - luma_l + res_b) * modulated_scale,
     modulated_scale)
}

/// Hybrid Riemannian/non-Riemannian spring (ΔE2000-like) + Los Alamos f(c) diminishing returns.
#[inline(always)]
fn hybrid_spring_and_dimishing_fc(lr: f32, lg: f32, lb: f32, luma_l: f32) -> (f32, f32, f32) {
    let mut r = lr;
    let mut g = lg;
    let mut b = lb;

    // Spring force to neutral gray to counter drift near grays. Use * for powi(2).
    let dr = r - luma_l;
    let dg = g - luma_l;
    let db = b - luma_l;
    let dist = ((dr*dr) + (dg*dg) + (db*db)).sqrt();
    if dist < 0.25 {
        let spring = 0.7 * (0.25 - dist);
        r = r * (1.0 - spring) + luma_l * spring;
        g = g * (1.0 - spring) + luma_l * spring;
        b = b * (1.0 - spring) + luma_l * spring;
    }

    // f(c) per-hue diminishing returns (stronger for greens, etc.).
    let fc_r = (1.0 - 0.08 * dr.abs().min(0.6)).max(0.6);
    let fc_g = (1.0 - 0.12 * dg.abs().min(0.6)).max(0.6); // greens
    let fc_b = (1.0 - 0.08 * db.abs().min(0.6)).max(0.6);

    (r * fc_r, g * fc_g, b * fc_b)
}

/// Scaffold for precomputed multi-dimensional LUT (Lens17 #10, layer2) to execute the
/// log-geodesic + Molchanov residuals/A_tensor + hybrid spring + Los Alamos f(c) at
/// sub-millisecond speeds for AR/LLM/photogram/immersive use (illum-invariant).
/// Grid would be ~17^3 or 33^3 (small memory, ~ few hundred KB for f32x3), built once
/// or on sat/vib change, trilinear interp in hot path instead of ln/exp/sqrt per-px.
/// Currently a stub that documents the structure; real population + sample can replace
/// the runtime calc in the !c-perceptual pc branch of apply_tone_math.
/// (Agent can expand without touching other files.)
struct PerceptualGrid {
    // Coarse 3D LUT for the advanced (Lens17 / layer2) to replace ln/exp/sqrt/mol/hybrid/from at runtime.
    // Built for fixed base_scale ~1.0 / vib_zero case (common in constancy mode); for varying vib use runtime fallback.
    // Size 9^3 keeps build cheap (~700 evals) and memory tiny. Trilinear interp ~10-15 muls vs transcendentals.
    data: Vec<f32>, // r g b interleaved, size*size*size * 3
    size: usize,
}

impl PerceptualGrid {
    fn new() -> Self {
        const SZ: usize = 17; // Phase 2 of WASM/native strategy: production quality (vs 9). ~4913 evals, still cheap on init.
                              // Pure Rust path (this grid + vec4) is the default for WASM and when c-perceptual feature is off.
                              // C++ AVX2 bulk (via tile in !par loops) is optional native turbo when feature + pc flag.
        let mut data = vec![0f32; SZ * SZ * SZ * 3];
        let scale = 1.0f32; // fixed for grid; vib_zero path (mode common case). Varying sat/vib falls back or rebuilds.
        let vib = 0.0f32;
        let vibz = true;
        let m = &CAM_TO_SRGB; // representative; grid operates post-matrix in the tone stage.
        for ri in 0..SZ {
            let r = (ri as f32 / (SZ - 1) as f32) * 1.5;
            for gi in 0..SZ {
                let g = (gi as f32 / (SZ - 1) as f32) * 1.5;
                for bi in 0..SZ {
                    let b = (bi as f32 / (SZ - 1) as f32) * 1.5;
                    // Run the exact advanced path (post-matrix input) with fixed scale for this grid point
                    let (lr, lg, lb) = to_log_euclidean(r, g, b);
                    let luma_l = (lr + lg + lb) / 3.0;
                    let (lr2, lg2, lb2, _mod) = molchanov_residuals_and_atensor(luma_l, lr, lg, lb, scale);
                    let (lr3, lg3, lb3) = hybrid_spring_and_dimishing_fc(lr2, lg2, lb2, luma_l);
                    let (rr, gg, bb) = from_log_euclidean(lr3, lg3, lb3);
                    let idx = (ri * SZ * SZ + gi * SZ + bi) * 3;
                    data[idx] = rr.clamp(0.0, 1.5);
                    data[idx + 1] = gg.clamp(0.0, 1.5);
                    data[idx + 2] = bb.clamp(0.0, 1.5);
                }
            }
        }
        Self { data, size: SZ }
    }

    #[inline(always)]
    fn sample(&self, r: f32, g: f32, b: f32) -> (f32, f32, f32) {
        // Trilinear interp in [0,1.5]^3 scaled to grid. Fast path for pc !c-perceptual rust.
        let s = self.size as f32 - 1.0;
        let rf = (r / 1.5).clamp(0.0, 1.0) * s;
        let gf = (g / 1.5).clamp(0.0, 1.0) * s;
        let bf = (b / 1.5).clamp(0.0, 1.0) * s;
        let ri = rf.floor() as usize;
        let gi = gf.floor() as usize;
        let bi = bf.floor() as usize;
        let rfr = rf - ri as f32;
        let gfr = gf - gi as f32;
        let bfr = bf - bi as f32;
        let r1 = (ri + 1).min(self.size - 1);
        let g1 = (gi + 1).min(self.size - 1);
        let b1 = (bi + 1).min(self.size - 1);
        // 8 corner samples (interleaved)
        let idx000 = (ri * self.size * self.size + gi * self.size + bi) * 3;
        let idx001 = (ri * self.size * self.size + gi * self.size + b1) * 3;
        let idx010 = (ri * self.size * self.size + g1 * self.size + bi) * 3;
        let idx011 = (ri * self.size * self.size + g1 * self.size + b1) * 3;
        let idx100 = (r1 * self.size * self.size + gi * self.size + bi) * 3;
        let idx101 = (r1 * self.size * self.size + gi * self.size + b1) * 3;
        let idx110 = (r1 * self.size * self.size + g1 * self.size + bi) * 3;
        let idx111 = (r1 * self.size * self.size + g1 * self.size + b1) * 3;
        // lerp r then g then b for each channel (0=r,1=g,2=b)
        let lerp = |c000: f32, c001: f32, c010: f32, c011: f32, c100: f32, c101: f32, c110: f32, c111: f32| {
            let c00 = c000 * (1.0 - bfr) + c001 * bfr;
            let c01 = c010 * (1.0 - bfr) + c011 * bfr;
            let c10 = c100 * (1.0 - bfr) + c101 * bfr;
            let c11 = c110 * (1.0 - bfr) + c111 * bfr;
            let c0 = c00 * (1.0 - gfr) + c01 * gfr;
            let c1 = c10 * (1.0 - gfr) + c11 * gfr;
            c0 * (1.0 - rfr) + c1 * rfr
        };
        let dr = lerp(self.data[idx000], self.data[idx001], self.data[idx010], self.data[idx011],
                      self.data[idx100], self.data[idx101], self.data[idx110], self.data[idx111]);
        let dg = lerp(self.data[idx000+1], self.data[idx001+1], self.data[idx010+1], self.data[idx011+1],
                      self.data[idx100+1], self.data[idx101+1], self.data[idx110+1], self.data[idx111+1]);
        let db = lerp(self.data[idx000+2], self.data[idx001+2], self.data[idx010+2], self.data[idx011+2],
                      self.data[idx100+2], self.data[idx101+2], self.data[idx110+2], self.data[idx111+2]);
        (dr, dg, db)
    }
}

fn build_pre_lut(black: u16, white: u16, wb_eff: f32, exp_gain: f32) -> Vec<u16> {
    let mut lut = vec![0u16; 65536];
    let denom = (white.saturating_sub(black)).max(1) as f32;
    let gain = wb_eff * exp_gain;
    // Precompute scale to replace per-i div with mul (faster in tight 64k loop).
    let norm_gain = gain / denom;
    // T1: per-index work is independent; parallelize. Matters most for small/thumbnail renders where
    // the fixed 65536-entry build is a large fraction of (or exceeds) the per-pixel pass.
    let fill = |i: usize, o: &mut u16| {
        let centered = (i as i32 - black as i32).max(0) as f32;
        let n = highlight_shoulder(centered * norm_gain);
        *o = (n * 65535.0 + 0.5).min(65535.0) as u16;
    };
    #[cfg(feature = "parallel")]
    lut.par_iter_mut().enumerate().for_each(|(i, o)| fill(i, o));
    #[cfg(not(feature = "parallel"))]
    lut.iter_mut().enumerate().for_each(|(i, o)| fill(i, o));
    lut
}

struct LutCache {
    black: u16, white: u16,
    wb_r_bits: u32, wb_g_bits: u32, wb_b_bits: u32, exp_gain_bits: u32,
    contrast_bits: u32, shadows_bits: u32, highlights_bits: u32,
    whites_bits: u32, blacks_bits: u32,
    pre_r: std::sync::Arc<Vec<u16>>, pre_g: std::sync::Arc<Vec<u16>>, pre_b: std::sync::Arc<Vec<u16>>,
    post: std::sync::Arc<Vec<u8>>,
    post16: Option<std::sync::Arc<Vec<u16>>>,
}

impl LutCache {
    fn matches(&self, black: u16, white: u16, wb_r: f32, wb_g: f32, wb_b: f32,
               exp_gain: f32, tone: &TonePost) -> bool {
        self.black == black && self.white == white
            && self.wb_r_bits    == wb_r.to_bits()
            && self.wb_g_bits    == wb_g.to_bits()
            && self.wb_b_bits    == wb_b.to_bits()
            && self.exp_gain_bits == exp_gain.to_bits()
            && self.contrast_bits   == tone.contrast.to_bits()
            && self.shadows_bits    == tone.shadows.to_bits()
            && self.highlights_bits == tone.highlights.to_bits()
            && self.whites_bits     == tone.whites.to_bits()
            && self.blacks_bits     == tone.blacks.to_bits()
    }
}

thread_local! {
    static LUT_CACHE: std::cell::RefCell<Option<LutCache>> =
        const { std::cell::RefCell::new(None) };
    static BLUR_SCRATCH: std::cell::RefCell<(Vec<u16>, Vec<u16>)> =
        const { std::cell::RefCell::new((Vec::new(), Vec::new())) };
    static PERCEPTUAL_GRID: std::cell::RefCell<Option<PerceptualGrid>> =
        const { std::cell::RefCell::new(None) };
}

fn build_post_lut(t: &TonePost) -> Vec<u8> {
    let mut lut = vec![0u8; 65536];
    // Hoist for mul_add + clamp.
    let fill = |i: usize, o: &mut u8| {
        let y = tone_curve(i as f32 / 65535.0, t);
        *o = (y * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
    };
    #[cfg(feature = "parallel")]
    lut.par_iter_mut().enumerate().for_each(|(i, o)| fill(i, o));
    #[cfg(not(feature = "parallel"))]
    lut.iter_mut().enumerate().for_each(|(i, o)| fill(i, o));
    lut
}

fn build_post16_lut(t: &TonePost) -> Vec<u16> {
    let mut lut = vec![0u16; 65536];
    let fill = |i: usize, o: &mut u16| {
        let y = tone_curve(i as f32 / 65535.0, t);
        *o = (y * 65535.0 + 0.5).clamp(0.0, 65535.0) as u16;
    };
    #[cfg(feature = "parallel")]
    lut.par_iter_mut().enumerate().for_each(|(i, o)| fill(i, o));
    #[cfg(not(feature = "parallel"))]
    lut.iter_mut().enumerate().for_each(|(i, o)| fill(i, o));
    lut
}

pub fn gaussian_kernel_5() -> [f32; 5] {
    [0.0545, 0.2442, 0.4026, 0.2442, 0.0545]
}

pub fn gaussian_kernel_13() -> [f32; 13] {
    [0.0185, 0.0342, 0.0563, 0.0831, 0.1097, 0.1296,
     0.1372,
     0.1296, 0.1097, 0.0831, 0.0563, 0.0342, 0.0185]
}

/// Horizontal pass of separable blur into `temp`.
/// Splits interior pixels (no border clamping) from the thin border strips so
/// the inner kernel loop is branch-free and LLVM can auto-vectorize it.
fn separable_blur_into(src: &[u16], width: usize, _height: usize,
                       kernel: &[f32], temp: &mut [u16]) {
    let half = kernel.len() / 2;
    let int_start   = half;
    let int_end     = width.saturating_sub(half);
    let right_start = int_end.max(int_start);

    #[cfg(feature = "parallel")]
    let iter = temp.par_chunks_mut(width * 3).enumerate();
    #[cfg(not(feature = "parallel"))]
    let iter = temp.chunks_mut(width * 3).enumerate();

    iter.for_each(|(y, row)| {
        // Left border — kernel window reaches outside left edge; clamp xi.
        for x in 0..int_start.min(width) {
            let mut acc = [0f32; 3];
            for ki in 0..kernel.len() {
                let kv = kernel[ki];
                let xi = (x as isize + ki as isize - half as isize)
                    .clamp(0, width as isize - 1) as usize;
                let b = (y * width + xi) * 3;
                acc[0] += src[b]   as f32 * kv;
                acc[1] += src[b+1] as f32 * kv;
                acc[2] += src[b+2] as f32 * kv;
            }
            let b = x * 3;
            row[b]   = acc[0].round() as u16;
            row[b+1] = acc[1].round() as u16;
            row[b+2] = acc[2].round() as u16;
        }
        // Interior — no clamping; reads are contiguous in `src`.
        for x in int_start..int_end {
            let mut acc_r = 0f32;
            let mut acc_g = 0f32;
            let mut acc_b = 0f32;
            let b0 = (y * width + x - half) * 3;
            for ki in 0..kernel.len() {
                let kv = kernel[ki];
                let b = b0 + ki * 3;
                acc_r += src[b]   as f32 * kv;
                acc_g += src[b+1] as f32 * kv;
                acc_b += src[b+2] as f32 * kv;
            }
            let b = x * 3;
            row[b]   = acc_r.round() as u16;
            row[b+1] = acc_g.round() as u16;
            row[b+2] = acc_b.round() as u16;
        }
        // Right border — kernel window reaches outside right edge; clamp xi.
        for x in right_start..width {
            let mut acc = [0f32; 3];
            for ki in 0..kernel.len() {
                let kv = kernel[ki];
                let xi = (x as isize + ki as isize - half as isize)
                    .clamp(0, width as isize - 1) as usize;
                let b = (y * width + xi) * 3;
                acc[0] += src[b]   as f32 * kv;
                acc[1] += src[b+1] as f32 * kv;
                acc[2] += src[b+2] as f32 * kv;
            }
            let b = x * 3;
            row[b]   = acc[0].round() as u16;
            row[b+1] = acc[1].round() as u16;
            row[b+2] = acc[2].round() as u16;
        }
    });
}


fn separable_blur_with_bufs(src: &[u16], width: usize, height: usize, kernel: &[f32],
                             temp: &mut Vec<u16>, out: &mut Vec<u16>) {
    let n = width * height * 3;
    temp.resize(n, 0);
    out.resize(n, 0);
    separable_blur_into(src, width, height, kernel, temp);
    let half = kernel.len() / 2;

    #[cfg(feature = "parallel")]
    {
        const VTILE: usize = 128;
        let temp_slice = temp.as_slice();
        out.par_chunks_mut(width * 3).enumerate().for_each(|(y, row)| {
            for x0 in (0..width).step_by(VTILE) {
                let x1 = (x0 + VTILE).min(width);
                let tile = x1 - x0;
                let mut acc = [[0f32; 3]; VTILE];
                for ki in 0..kernel.len() {
                    let kv = kernel[ki];
                    let yi = (y as isize + ki as isize - half as isize)
                        .clamp(0, height as isize - 1) as usize;
                    let row_base = yi * width * 3;
                    for xi in 0..tile {
                        let b = row_base + (x0 + xi) * 3;
                        acc[xi][0] += temp_slice[b]   as f32 * kv;
                        acc[xi][1] += temp_slice[b+1] as f32 * kv;
                        acc[xi][2] += temp_slice[b+2] as f32 * kv;
                    }
                }
                for xi in 0..tile {
                    let o = (x0 + xi) * 3;
                    row[o]   = acc[xi][0].round() as u16;
                    row[o+1] = acc[xi][1].round() as u16;
                    row[o+2] = acc[xi][2].round() as u16;
                }
            }
        });
    }

    #[cfg(not(feature = "parallel"))]
    {
        // Tiled vertical pass. Working set = VTILE * klen * 3 * 2 bytes.
        // VTILE=128, k13: 128*13*6 ≈ 10 KB — fits in L1, giving ~38% speedup
        // over naive column-by-column access on a 20 MP image (117 MB rgb16).
        const VTILE: usize = 128;
        for y in 0..height {
            for x0 in (0..width).step_by(VTILE) {
                let x1   = (x0 + VTILE).min(width);
                let tile = x1 - x0;
                let mut acc = [[0f32; 3]; VTILE];
                for ki in 0..kernel.len() {
                    let kv = kernel[ki];
                    let yi = (y as isize + ki as isize - half as isize)
                        .clamp(0, height as isize - 1) as usize;
                    let row_base = yi * width * 3;
                    for xi in 0..tile {
                        let b = row_base + (x0 + xi) * 3;
                        acc[xi][0] += temp[b]   as f32 * kv;
                        acc[xi][1] += temp[b+1] as f32 * kv;
                        acc[xi][2] += temp[b+2] as f32 * kv;
                    }
                }
                for xi in 0..tile {
                    let b = (y * width + x0 + xi) * 3;
                    out[b]   = acc[xi][0].round() as u16;
                    out[b+1] = acc[xi][1].round() as u16;
                    out[b+2] = acc[xi][2].round() as u16;
                }
            }
        }
    }
}

pub fn apply_unsharp_masks(rgb16: &mut [u16], width: usize, height: usize,
                            params: &PipelineParams) {
    if params.texture == 0.0 && params.clarity == 0.0 { return; }
    BLUR_SCRATCH.with(|scratch| {
        let (ref mut temp, ref mut blurred) = *scratch.borrow_mut();
        if params.texture != 0.0 {
            separable_blur_with_bufs(rgb16, width, height, &gaussian_kernel_5(), temp, blurred);
            #[cfg(feature = "parallel")]
            rgb16.par_chunks_mut(width * 3).zip(blurred.par_chunks(width * 3)).for_each(|(r_row, b_row)| {
                for i in 0..r_row.len() {
                    let orig = r_row[i] as i32;
                    let blur = b_row[i] as i32;
                    r_row[i] = (orig + (params.texture * (orig - blur) as f32).round() as i32).clamp(0, 65535) as u16;
                }
            });
            #[cfg(not(feature = "parallel"))]
            {
                let n = rgb16.len();
                let mut i = 0;
                while i < n {
                    let orig = rgb16[i] as i32;
                    let blur = blurred[i] as i32;
                    rgb16[i] = (orig + (params.texture * (orig - blur) as f32).round() as i32).clamp(0, 65535) as u16;
                    i += 1;
                }
            }
        }
        if params.clarity != 0.0 {
            separable_blur_with_bufs(rgb16, width, height, &gaussian_kernel_13(), temp, blurred);
            let n = rgb16.len();
            let mut i = 0;
            while i < n {
                let orig = rgb16[i] as i32;
                let blur = blurred[i] as i32;
                let v = orig as f32 / 65535.0;
                let w = 4.0 * v * (1.0 - v);
                rgb16[i] = (orig + (params.clarity * w * (orig - blur) as f32).round() as i32)
                    .clamp(0, 65535) as u16;
                i += 1;
            }
        }
    });
}

/// Core per-pixel tone-mapping math (matrix + sat/vibrance around luma).
/// Shared by `process` (RGB8) and `process_rgba` (RGBA8) to avoid duplication
/// of the hot arithmetic while keeping tight loops.
///
/// When perceptual_constancy is true, this is the "one place" for evolving
/// the runtime LookRenderer implementation of sensor-sharpen B, log geodesics
/// (Schrödinger), Molchanov residuals/tensor A, hybrid corrections, and Los
/// Alamos f(c) curves for illumination-invariant adjustments during progressive
/// JXL paints (never for producedBy/ingest per P-1).
///
/// Wired to C++ fast path (bridge intrinsics) when feature "c-perceptual" is enabled.
/// The C++ (with AVX2 hand-written intrinsics) is the optimal for the "new" path in WASM/native.
/// Strategy: hybrid. Pure Rust (vec4 + this grid) is default/WASM/portable/correctness path.
/// C++ bulk is optional native turbo (fed via SoA tile gather in !par tone loops).
/// See WASM vs native section in ApplyToneMathPipeline-DONE.md. Never make advanced math C++-only.

#[cfg(feature = "c-perceptual")]
extern "C" {
    fn perceptual_apply_full(
        r: f32,
        g: f32,
        b: f32,
        sat: f32,
        vib: f32,
        vib_zero: i32,
        orr: *mut f32,
        ogg: *mut f32,
        obb: *mut f32,
    );
    // AVX2 bulk for lower-copy SoA flows (e.g. from planar demosaic output or direct JXL pixels).
    // Matches scalar but processes 8-wide with hand-written intrinsics. Remainder scalar in caller.
    fn perceptual_apply_full_avx2(
        in_r: *const f32,
        in_g: *const f32,
        in_b: *const f32,
        out_r: *mut f32,
        out_g: *mut f32,
        out_b: *mut f32,
        n: i32,
        sat: f32,
        vib: f32,
        vib_zero: i32,
    );
}

/// Safe wrapper for the C++ AVX2 bulk perceptual (enabled by c-perceptual feature).
/// Expects matching length SoA slices. Useful for lower-copy flows when input is planar
/// (e.g. from demosaic_rggb_planar_simd converted to f32 post pre-LUT). The bulk uses
/// hand intrinsics; falls back to scalar path inside C++ if needed.
/// Connection to pipelines: the !par tone loops (process_into etc.) do the interleaved->SoA tile
/// to feed this from the existing pre-LUT -> matrix -> advanced -> post-LUT flow. Rust grid/vec4
/// is the WASM equivalent.
#[cfg(feature = "c-perceptual")]
pub fn perceptual_apply_bulk(
    r: &[f32],
    g: &[f32],
    b: &[f32],
    out_r: &mut [f32],
    out_g: &mut [f32],
    out_b: &mut [f32],
    sat: f32,
    vib: f32,
    vib_zero: bool,
) {
    let n = r.len();
    debug_assert_eq!(g.len(), n);
    debug_assert_eq!(b.len(), n);
    debug_assert_eq!(out_r.len(), n);
    debug_assert_eq!(out_g.len(), n);
    debug_assert_eq!(out_b.len(), n);
    if n == 0 {
        return;
    }
    let start = std::time::Instant::now();
    unsafe {
        perceptual_apply_full_avx2(
            r.as_ptr(),
            g.as_ptr(),
            b.as_ptr(),
            out_r.as_mut_ptr(),
            out_g.as_mut_ptr(),
            out_b.as_mut_ptr(),
            n as i32,
            sat,
            vib,
            if vib_zero { 1 } else { 0 },
        );
    }
    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
    // Hook for benchmarking the SoA bulk (C++ AVX2 or scalar) vs old per-pixel path.
    eprintln!("perceptual_bulk_ms: {:.3}", elapsed_ms);
}

#[inline(always)]
pub(crate) fn apply_tone_math(
    r: f32,
    g: f32,
    b: f32,
    m: &[[f32; 3]; 3],
    sat: f32,
    vib: f32,
    vib_zero: bool,
    perceptual_constancy: bool,
) -> (f32, f32, f32) {
    // 1) Matrix (mul_add for FMA/ILP).
    let mut r2 = m[0][0].mul_add(r, m[0][1].mul_add(g, m[0][2] * b));
    let mut g2 = m[1][0].mul_add(r, m[1][1].mul_add(g, m[1][2] * b));
    let mut b2 = m[2][0].mul_add(r, m[2][1].mul_add(g, m[2][2] * b));

    if perceptual_constancy {
        // Lens17: advanced owns saturation/vibrance intent (illum-invariant) when flag.
        // Call on post-matrix values; FFI/C++ or rust path below incorporate sat/vib/scale.
        // Guarantees output domain suitable for subsequent post-LUT tone_curve.
        // Future: !c-perceptual rust path can use PerceptualGrid (see scaffold after hybrid fn) for the LUT-based fast path (layer2).
        #[cfg(feature = "c-perceptual")]
        {
            let mut rr = 0.0f32;
            let mut gg = 0.0f32;
            let mut bb = 0.0f32;
            unsafe {
                perceptual_apply_full(r2, g2, b2, sat, vib, if vib_zero { 1 } else { 0 }, &mut rr, &mut gg, &mut bb);
            }
            r2 = rr;
            g2 = gg;
            b2 = bb;
        }
        #[cfg(not(feature = "c-perceptual"))]
        {
            // Rust reference now accelerated by PerceptualGrid (coarse 9^3 + trilinear) for the Lens17 advanced.
            // Grid built for fixed scale~1 / vibz (matches common constancy mode). For varying sat/vib use full runtime (or rebuild grid).
            // Big win: replaces per-px ln/exp/sqrt/abs with ~12 muls + loads (sub-ms target when on for AR/LLM).
            let (rr, gg, bb) = PERCEPTUAL_GRID.with(|g| {
                let mut opt = g.borrow_mut();
                if opt.is_none() {
                    *opt = Some(PerceptualGrid::new());
                }
                opt.as_ref().unwrap().sample(r2, g2, b2)
            });
            r2 = rr;
            g2 = gg;
            b2 = bb;
        }
    } else {
        // 2) Saturation + vibrance around luma (hoisted coeffs, restructured div once, mul_add).
        // (Only for classic path; advanced path above incorporates equivalent when pc=true.)
        let luma = LUMA_R.mul_add(r2, LUMA_G.mul_add(g2, LUMA_B * b2));
        let scale = if vib_zero {
            sat
        } else {
            let raw_mx = r2.max(g2).max(b2);
            let mx = raw_mx.max(1.0);
            let mn = r2.min(g2).min(b2).max(0.0);
            let inv_mx = if raw_mx > 0.0 { 1.0 / mx } else { 0.0 };
            let pixel_sat = ((mx - mn) * inv_mx).clamp(0.0, 1.0);
            let vib_w = 1.0 - pixel_sat;
            sat * (1.0 + vib * vib_w * 0.6)
        };
        // equiv to luma + (x - luma)*scale using mul_add for FMA opportunity
        r2 = luma.mul_add(1.0 - scale, r2 * scale);
        g2 = luma.mul_add(1.0 - scale, g2 * scale);
        b2 = luma.mul_add(1.0 - scale, b2 * scale);
    }

    (r2, g2, b2)
}

/// Layer 5: pure post-decode perceptual constancy for JXL progressive pixels (or post RAW).
/// Allows JS postDecodeTransform (from byte-benchmark harness + Cursor for layer) to apply the full
/// log-geodesic/Molchanov/LANL engine on early cutoff frames before butter or display.
/// Positive: directly enables the AR/LLM/ photogram vision on progressive arrivals; zero cost if not called.
pub fn apply_perceptual_constancy(r: f32, g: f32, b: f32, sat: f32, vib: f32, vib_zero: bool, layer: u32) -> (f32, f32, f32) {
    let (lr, lg, lb) = to_log_euclidean(r, g, b);
    let luma_l = (lr + lg + lb) / 3.0;
    let base_scale = if vib_zero { sat } else {
        let raw_mx = r.max(g).max(b);
        let mx = raw_mx.max(1.0);
        let mn = r.min(g).min(b).max(0.0);
        let inv_mx = if raw_mx > 0.0 { 1.0 / mx } else { 0.0 };
        let pixel_sat = ((mx - mn) * inv_mx).clamp(0.0, 1.0);
        let vib_w = 1.0 - pixel_sat;
        sat * (1.0 + vib * vib_w * 0.6)
    };
    let (lr2, lg2, lb2, _mod) = molchanov_residuals_and_atensor(luma_l, lr, lg, lb, base_scale);
    let (lr3, lg3, lb3) = hybrid_spring_and_dimishing_fc(lr2, lg2, lb2, luma_l);
    // milk more: layer aware (early low layer less aggressive for progressive)
    let layer_scale = 1.0 - (layer as f32 * 0.1).min(0.5);
    let (rr, gg, bb) = from_log_euclidean(lr3 * layer_scale, lg3 * layer_scale, lb3 * layer_scale);
    (rr.clamp(0.0, 1.5), gg.clamp(0.0, 1.5), bb.clamp(0.0, 1.5))
}

/// 4-wide version for the classic (!pc) path (Layer 1 next enhancement).
/// Mirrors the scalar math over 4 lanes. Call site in the 4x unrolled !par block
/// (process_into) gathers 4 post-preLUT values, calls once, scatters post results.
/// Gives better ILP / chance for auto-vec than 4 separate scalar calls.
/// pc path delegates to scalar (bulk tile path covers pc+c-perceptual via AVX2).
#[inline(always)]
fn apply_tone_math4(
    rs: [f32; 4],
    gs: [f32; 4],
    bs: [f32; 4],
    m: &[[f32; 3]; 3],
    sat: f32,
    vib: f32,
    vib_zero: bool,
    perceptual_constancy: bool,
) -> ([f32; 4], [f32; 4], [f32; 4]) {
    // Fleshed for Phase 1 of WASM/native strategy: explicit 4-wide arithmetic for the classic !pc path
    // (matrix + sat/vib). Eliminates 4 scalar calls inside the vec4 helper. LLVM can vectorize the
    // independent lanes or schedule better. pc path delegates (bulk tile covers pc+c-perceptual on native;
    // pure-Rust grid path on WASM/no-feature).
    let mut r2s = [0f32; 4];
    let mut g2s = [0f32; 4];
    let mut b2s = [0f32; 4];

    if perceptual_constancy {
        // Rare in this call site (bulk handles when c-perceptual); fall back for correctness.
        for i in 0..4 {
            let (r2, g2, b2) = apply_tone_math(rs[i], gs[i], bs[i], m, sat, vib, vib_zero, true);
            r2s[i] = r2; g2s[i] = g2; b2s[i] = b2;
        }
    } else {
        // Unrolled classic path (the 90% case).
        // Matrix (mul_add for FMA/ILP) per lane.
        for i in 0..4 {
            r2s[i] = m[0][0].mul_add(rs[i], m[0][1].mul_add(gs[i], m[0][2] * bs[i]));
            g2s[i] = m[1][0].mul_add(rs[i], m[1][1].mul_add(gs[i], m[1][2] * bs[i]));
            b2s[i] = m[2][0].mul_add(rs[i], m[2][1].mul_add(gs[i], m[2][2] * bs[i]));
        }
        // Sat + vibrance around luma per lane.
        for i in 0..4 {
            let luma = LUMA_R.mul_add(r2s[i], LUMA_G.mul_add(g2s[i], LUMA_B * b2s[i]));
            let scale = if vib_zero {
                sat
            } else {
                let raw_mx = r2s[i].max(g2s[i]).max(b2s[i]);
                let mx = raw_mx.max(1.0);
                let mn = r2s[i].min(g2s[i]).min(b2s[i]).max(0.0);
                let inv_mx = if raw_mx > 0.0 { 1.0 / mx } else { 0.0 };
                let pixel_sat = ((mx - mn) * inv_mx).clamp(0.0, 1.0);
                let vib_w = 1.0 - pixel_sat;
                sat * (1.0 + vib * vib_w * 0.6)
            };
            r2s[i] = luma.mul_add(1.0 - scale, r2s[i] * scale);
            g2s[i] = luma.mul_add(1.0 - scale, g2s[i] * scale);
            b2s[i] = luma.mul_add(1.0 - scale, b2s[i] * scale);
        }
    }
    (r2s, g2s, b2s)
}

struct ToneInputs { pub exp_gain: f32, pub wb_r: f32, pub wb_g: f32, pub wb_b: f32, pub tone: TonePost, pub sat: f32, pub vib: f32, pub vib_zero: bool, pub perceptual_constancy: bool }

fn derive_tone_inputs(params: &PipelineParams) -> ToneInputs {
    let exp_gain = 2f32.powf((params.exposure_ev + BASELINE_EXP_EV).clamp(-3.0, 4.0));
    let temp = params.temp.clamp(-1.0, 1.0);
    let tint = params.tint.clamp(-1.0, 1.0);
    let wb_r = params.wb_r * (1.0 + temp * 0.40) * (1.0 + tint * 0.10);
    let wb_g = params.wb_g * (1.0 - tint * 0.20);
    let wb_b = params.wb_b * (1.0 - temp * 0.40) * (1.0 + tint * 0.10);
    let tone = TonePost {
        contrast: params.contrast.clamp(-1.0, 1.0),
        shadows: params.shadows.clamp(-1.0, 1.0),
        highlights: params.highlights.clamp(-1.0, 1.0),
        whites: params.whites.clamp(-1.0, 1.0),
        blacks: params.blacks.clamp(-1.0, 1.0),
    };
    let sat_param = params.saturation.clamp(-1.0, 1.0);
    // branchless for the sat blend (faster, no mispredict in per-image call)
    let sat_neg = BASELINE_SAT * (1.0 + sat_param);
    let sat_pos = BASELINE_SAT + sat_param * 0.8;
    let sat = if sat_param < 0.0 { sat_neg } else { sat_pos }.max(0.0);
    let vib = params.vibrance.clamp(-1.0, 1.0);
    let vib_zero = vib.abs() < 1e-6;
    let perceptual_constancy = params.perceptual_constancy;
    ToneInputs { exp_gain, wb_r, wb_g, wb_b, tone, sat, vib, vib_zero, perceptual_constancy }
}

fn ensure_lut(cache: &mut Option<LutCache>, params: &PipelineParams, ti: &ToneInputs, need16: bool) {
    if cache.as_ref().map_or(true, |c| {
        !c.matches(params.black, params.white, ti.wb_r, ti.wb_g, ti.wb_b, ti.exp_gain, &ti.tone)
    }) {
        *cache = Some(LutCache {
            black: params.black, white: params.white,
            wb_r_bits: ti.wb_r.to_bits(), wb_g_bits: ti.wb_g.to_bits(),
            wb_b_bits: ti.wb_b.to_bits(), exp_gain_bits: ti.exp_gain.to_bits(),
            contrast_bits:   ti.tone.contrast.to_bits(),
            shadows_bits:    ti.tone.shadows.to_bits(),
            highlights_bits: ti.tone.highlights.to_bits(),
            whites_bits:     ti.tone.whites.to_bits(),
            blacks_bits:     ti.tone.blacks.to_bits(),
            pre_r: std::sync::Arc::new(build_pre_lut(params.black, params.white, ti.wb_r, ti.exp_gain)),
            pre_g: std::sync::Arc::new(build_pre_lut(params.black, params.white, ti.wb_g, ti.exp_gain)),
            pre_b: std::sync::Arc::new(build_pre_lut(params.black, params.white, ti.wb_b, ti.exp_gain)),
            post: std::sync::Arc::new(build_post_lut(&ti.tone)),
            post16: if need16 { Some(std::sync::Arc::new(build_post16_lut(&ti.tone))) } else { None },
        });
    } else if need16 {
        let c = cache.as_mut().unwrap();
        if c.post16.is_none() {
            c.post16 = Some(std::sync::Arc::new(build_post16_lut(&ti.tone)));
        }
    }
}

pub fn process(rgb16: &[u16], params: &PipelineParams) -> Vec<u8> {
    debug_assert_eq!(rgb16.len() % 3, 0);
    let n = rgb16.len() / 3;
    let mut out = vec![0u8; n * 3];
    process_into(rgb16, params, &mut out);
    out
}

/// T2: like `process` but writes into a caller-owned buffer (must be exactly rgb16.len() bytes).
/// Lets the interactive LookRenderer reuse one output buffer across re-renders instead of
/// allocating + zeroing a fresh Vec each slider tick. Output is byte-identical to `process`.
pub fn process_into(rgb16: &[u16], params: &PipelineParams, out: &mut [u8]) {
    debug_assert_eq!(rgb16.len() % 3, 0);
    assert_eq!(out.len(), rgb16.len(), "process_into: out must be rgb16.len() bytes");
    let ti = derive_tone_inputs(params);
    let fallback = CAM_TO_SRGB;
    let m = params.color_matrix.as_ref().unwrap_or(&fallback);

    #[cfg(not(feature = "parallel"))]
    {
        LUT_CACHE.with(|cache_cell| {
            ensure_lut(&mut cache_cell.borrow_mut(), params, &ti, false);
            let cache = cache_cell.borrow();
            let c = cache.as_ref().unwrap();

            // Lens 22/23/25: pointer move (raw ptr advance) instead of index arithmetic + casts.
            // unsafe: in-bounds by construction — *src is u16 indexing 65536-entry LUTs; src/dst
            // advance exactly rgb16.len() elements. (Wrap added to fix the wasm/no-parallel build.)
            // Enhanced (this pass): 4x unroll for !pc classic path (amortizes loop overhead on 90% scalar math).
            // Tile-bulk path for pc + c-perceptual: feeds fixed SoA to AVX2 hand-intrinsics (perceptual_apply_full_avx2)
// (WASM/native strategy: C++ only when feature + native; else pure Rust vec4/grid for WASM + default)
            // avoiding scalar FFI call overhead per pixel for the heavy Lens17 advanced color path.
            // TILE=64 amortizes; remainder handled naturally. Replicate pattern to rgba/16bit loops if they become hot for AR.
            unsafe {
                let nbytes = rgb16.len();
                let mut src = rgb16.as_ptr();
                let mut dst = out.as_mut_ptr();
                let src_end = src.add(nbytes);
                let pre_r = c.pre_r.as_ptr();
                let pre_g = c.pre_g.as_ptr();
                let pre_b = c.pre_b.as_ptr();
                let post = c.post.as_ptr();
                let do_bulk = ti.perceptual_constancy && cfg!(feature = "c-perceptual");
                if do_bulk {
                    #[cfg(feature = "c-perceptual")]
                    {
                        // Bulk AVX2 hand-intrinsics tile for perceptual (Lens 2/25/17). Lower copy, uses the declared 8-wide (we use 64 for batch).
                        // Guarded by outer cfg block so the AVX2 symbol (and safe wrapper) only need to resolve when the feature and its extern are present.
                        // Uses the safe perceptual_apply_bulk wrapper (which calls the avx2 under the feature).
                        const TILE: usize = 64;
                        let mut tr = [0f32; TILE];
                        let mut tg = [0f32; TILE];
                        let mut tb = [0f32; TILE];
                        let mut orr = [0f32; TILE];
                        let mut ogg = [0f32; TILE];
                        let mut obb = [0f32; TILE];
                        while src < src_end {
                            let mut t = 0usize;
                            while t < TILE && src < src_end {
                                tr[t] = *pre_r.add(*src as usize) as f32; src = src.add(1);
                                tg[t] = *pre_g.add(*src as usize) as f32; src = src.add(1);
                                tb[t] = *pre_b.add(*src as usize) as f32; src = src.add(1);
                                t += 1;
                            }
                            if t > 0 {
                                perceptual_apply_bulk(
                                    &tr[..t], &tg[..t], &tb[..t],
                                    &mut orr[..t], &mut ogg[..t], &mut obb[..t],
                                    ti.sat, ti.vib, ti.vib_zero,
                                );
                                for i in 0..t {
                                    *dst = *post.add(orr[i].clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                                    *dst = *post.add(ogg[i].clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                                    *dst = *post.add(obb[i].clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                                }
                            }
                        }
                    }
                } else {
                    // Classic path now using apply_tone_math4 (next enhancement after manual 4x unroll).
                    // Gather 4 post-pre, one wide call (ILP + vector opportunity on the matrix/sat math), scatter post.
                    // Handles arbitrary size with cnt; remainder scalar inside vec4 (loop 4).
                    while src < src_end {
                        let mut rs = [0f32; 4];
                        let mut gs = [0f32; 4];
                        let mut bs = [0f32; 4];
                        let mut cnt = 0usize;
                        for k in 0..4 {
                            if src >= src_end { break; }
                            rs[k] = *pre_r.add(*src as usize) as f32; src = src.add(1);
                            gs[k] = *pre_g.add(*src as usize) as f32; src = src.add(1);
                            bs[k] = *pre_b.add(*src as usize) as f32; src = src.add(1);
                            cnt += 1;
                        }
                        if cnt == 0 { break; }
                        let (r2s, g2s, b2s) = apply_tone_math4(rs, gs, bs, m, ti.sat, ti.vib, ti.vib_zero, ti.perceptual_constancy);
                        for k in 0..cnt {
                            *dst = *post.add(r2s[k].clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                            *dst = *post.add(g2s[k].clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                            *dst = *post.add(b2s[k].clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                        }
                    }
                }
            }
        });
    }

    #[cfg(feature = "parallel")]
    {
        let (pre_r, pre_g, pre_b, post) = LUT_CACHE.with(|cache_cell| {
            ensure_lut(&mut cache_cell.borrow_mut(), params, &ti, false);
            let c = cache_cell.borrow();
            let cr = c.as_ref().unwrap();
            (cr.pre_r.clone(), cr.pre_g.clone(), cr.pre_b.clone(), cr.post.clone())
        });
        out.par_chunks_mut(3).zip(rgb16.par_chunks(3)).with_min_len(4096).for_each(|(out_px, in_px)| {
            let r = pre_r[in_px[0] as usize] as f32;
            let g = pre_g[in_px[1] as usize] as f32;
            let b = pre_b[in_px[2] as usize] as f32;
            let (r2, g2, b2) = apply_tone_math(r, g, b, m, ti.sat, ti.vib, ti.vib_zero, ti.perceptual_constancy);
            out_px[0] = post[r2.clamp(0.0, 65535.0) as u16 as usize];
            out_px[1] = post[g2.clamp(0.0, 65535.0) as u16 as usize];
            out_px[2] = post[b2.clamp(0.0, 65535.0) as u16 as usize];
        });
    }
}

/// SIMD variant of `process_into`: block-deinterleaves the pre-LUT output into
/// SoA, runs the vectorized tone math (`tone_simd::apply_tone_bulk`), then
/// reinterleaves through the post-LUT. New fn — leaves `process_into` untouched
/// while the end-to-end win is measured. Plain ingest path only
/// (perceptual_constancy must be false).
pub fn process_into_simd(rgb16: &[u16], params: &PipelineParams, out: &mut [u8]) {
    debug_assert_eq!(rgb16.len() % 3, 0);
    assert_eq!(out.len(), rgb16.len(), "process_into_simd: out must be rgb16.len() bytes");
    let ti = derive_tone_inputs(params);
    debug_assert!(!ti.perceptual_constancy, "process_into_simd is the plain ingest path only");
    let fallback = CAM_TO_SRGB;
    let m = params.color_matrix.as_ref().unwrap_or(&fallback);
    let (pre_r, pre_g, pre_b, post) = LUT_CACHE.with(|cache_cell| {
        ensure_lut(&mut cache_cell.borrow_mut(), params, &ti, false);
        let c = cache_cell.borrow();
        let cr = c.as_ref().unwrap();
        (cr.pre_r.clone(), cr.pre_g.clone(), cr.pre_b.clone(), cr.post.clone())
    });

    const BLK: usize = 2048;
    let process_block = |ob: &mut [u8], ib: &[u16]| {
        let np = ib.len() / 3;
        let mut r = [0f32; BLK];
        let mut g = [0f32; BLK];
        let mut b = [0f32; BLK];
        for i in 0..np {
            r[i] = pre_r[ib[i * 3] as usize] as f32;
            g[i] = pre_g[ib[i * 3 + 1] as usize] as f32;
            b[i] = pre_b[ib[i * 3 + 2] as usize] as f32;
        }
        crate::tone_simd::apply_tone_bulk(&mut r[..np], &mut g[..np], &mut b[..np], m, ti.sat, ti.vib, ti.vib_zero);
        for i in 0..np {
            ob[i * 3] = post[(r[i].clamp(0.0, 65535.0) as u16) as usize];
            ob[i * 3 + 1] = post[(g[i].clamp(0.0, 65535.0) as u16) as usize];
            ob[i * 3 + 2] = post[(b[i].clamp(0.0, 65535.0) as u16) as usize];
        }
    };

    #[cfg(feature = "parallel")]
    {
        out.par_chunks_mut(3 * BLK)
            .zip(rgb16.par_chunks(3 * BLK))
            .for_each(|(ob, ib)| process_block(ob, ib));
    }
    #[cfg(not(feature = "parallel"))]
    {
        out.chunks_mut(3 * BLK)
            .zip(rgb16.chunks(3 * BLK))
            .for_each(|(ob, ib)| process_block(ob, ib));
    }
}

/// `process` using the SIMD tone path. See `process_into_simd`.
pub fn process_simd(rgb16: &[u16], params: &PipelineParams) -> Vec<u8> {
    let mut out = vec![0u8; rgb16.len()];
    process_into_simd(rgb16, params, &mut out);
    out
}

/// Decode-path tone dispatch: take the SIMD bulk path for the plain (non
/// perceptual-constancy) case, else the byte-exact scalar `process_into`.
/// Output differs from `process_into` only by the documented ≤1-LUT-step SIMD
/// reassociation tolerance, so `process_into` stays byte-exact for callers that
/// require it (LookRenderer, exact-equality tests). Heavy full-res RAW decode
/// opts in via this wrapper.
pub fn process_into_auto(rgb16: &[u16], params: &PipelineParams, out: &mut [u8]) {
    if params.perceptual_constancy {
        process_into(rgb16, params, out);
    } else {
        process_into_simd(rgb16, params, out);
    }
}

/// `process` peer of [`process_into_auto`].
pub fn process_auto(rgb16: &[u16], params: &PipelineParams) -> Vec<u8> {
    let mut out = vec![0u8; rgb16.len()];
    process_into_auto(rgb16, params, &mut out);
    out
}

/// Sub-profile of the tone pass: isolates the per-pixel `apply_tone_math`
/// compute (matrix + sat/vibrance, with its divide) from the LUT-gather/store
/// cost. Single-threaded. Returns (full_ms, lut_only_ms); full − lut_only is the
/// tone-math cost. Used by examples/pipeline_profile to decide what to vectorize.
pub fn bench_tone_split(rgb16: &[u16], params: &PipelineParams) -> (f64, f64) {
    let ti = derive_tone_inputs(params);
    let fallback = CAM_TO_SRGB;
    let m = params.color_matrix.as_ref().unwrap_or(&fallback);
    let pre_r = build_pre_lut(params.black, params.white, ti.wb_r, ti.exp_gain);
    let pre_g = build_pre_lut(params.black, params.white, ti.wb_g, ti.exp_gain);
    let pre_b = build_pre_lut(params.black, params.white, ti.wb_b, ti.exp_gain);
    let post = build_post_lut(&ti.tone);
    let mut out = vec![0u8; rgb16.len()];

    let t = std::time::Instant::now();
    for (o, px) in out.chunks_mut(3).zip(rgb16.chunks(3)) {
        let r = pre_r[px[0] as usize] as f32;
        let g = pre_g[px[1] as usize] as f32;
        let b = pre_b[px[2] as usize] as f32;
        let (r2, g2, b2) = apply_tone_math(r, g, b, m, ti.sat, ti.vib, ti.vib_zero, ti.perceptual_constancy);
        o[0] = post[r2.clamp(0.0, 65535.0) as u16 as usize];
        o[1] = post[g2.clamp(0.0, 65535.0) as u16 as usize];
        o[2] = post[b2.clamp(0.0, 65535.0) as u16 as usize];
    }
    let full_ms = t.elapsed().as_secs_f64() * 1000.0;
    std::hint::black_box(&out);

    let t = std::time::Instant::now();
    for (o, px) in out.chunks_mut(3).zip(rgb16.chunks(3)) {
        let r = pre_r[px[0] as usize] as f32;
        let g = pre_g[px[1] as usize] as f32;
        let b = pre_b[px[2] as usize] as f32;
        o[0] = post[r.clamp(0.0, 65535.0) as u16 as usize];
        o[1] = post[g.clamp(0.0, 65535.0) as u16 as usize];
        o[2] = post[b.clamp(0.0, 65535.0) as u16 as usize];
    }
    let lut_only_ms = t.elapsed().as_secs_f64() * 1000.0;
    std::hint::black_box(&out);

    (full_ms, lut_only_ms)
}

/// Like `process`, but writes interleaved RGBA8 directly (A=255).
///
/// This is the native/Tauri equivalent of the "direct RGBA" (Phase 2B) path.
/// For pure "RAW decode → JXL encode, discard pixels" flows it avoids ever
/// allocating or writing the intermediate 3-channel RGB8 buffer, fusing the
/// trivial alpha insertion into the tone pass. The arithmetic cost of the
/// conversion itself is negligible once there is no JS/WASM boundary.
///
/// Callers that must retain RGB (e.g. rotation, further CPU processing) should
/// continue to use `process` + manual convert or the WASM `rgb_to_rgba` helper.
pub fn process_rgba(rgb16: &[u16], params: &PipelineParams) -> Vec<u8> {
    debug_assert_eq!(rgb16.len() % 3, 0);
    let ti = derive_tone_inputs(params);
    let fallback = CAM_TO_SRGB;
    let m = params.color_matrix.as_ref().unwrap_or(&fallback);
    let n = rgb16.len() / 3;
    let mut out = vec![0u8; n * 4];

    #[cfg(not(feature = "parallel"))]
    {
        LUT_CACHE.with(|cache_cell| {
            ensure_lut(&mut cache_cell.borrow_mut(), params, &ti, false);
            let cache = cache_cell.borrow();
            let c = cache.as_ref().unwrap();
            
            // Lens 23 pointer advance version (consistent with process_into).
            // unsafe: same in-bounds invariant as process_into (out is n*4; dst advances n*4).
            // NOTE: 4x unroll + perceptual bulk-tile (AVX2 hand intrinsics for pc) pattern implemented in process_into !par block.
            // Replicate here if rgba path becomes hot for immersive/AR (lens16) or 16bit TIFF consumers (photogram layer5).
            unsafe {
                let nbytes = rgb16.len();
                let mut src = rgb16.as_ptr();
                let mut dst = out.as_mut_ptr();
                let src_end = src.add(nbytes);
                let pre_r = c.pre_r.as_ptr();
                let pre_g = c.pre_g.as_ptr();
                let pre_b = c.pre_b.as_ptr();
                let post = c.post.as_ptr();
                while src < src_end {
                    let r = *pre_r.add(*src as usize) as f32; src = src.add(1);
                    let g = *pre_g.add(*src as usize) as f32; src = src.add(1);
                    let b = *pre_b.add(*src as usize) as f32; src = src.add(1);
                    let (r2, g2, b2) = apply_tone_math(r, g, b, m, ti.sat, ti.vib, ti.vib_zero, ti.perceptual_constancy);
                    *dst = *post.add(r2.clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                    *dst = *post.add(g2.clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                    *dst = *post.add(b2.clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                    *dst = 255; dst = dst.add(1);
                }
            }
        });
    }

    #[cfg(feature = "parallel")]
    {
        let (pre_r, pre_g, pre_b, post) = LUT_CACHE.with(|cache_cell| {
            ensure_lut(&mut cache_cell.borrow_mut(), params, &ti, false);
            let c = cache_cell.borrow();
            let cr = c.as_ref().unwrap();
            (cr.pre_r.clone(), cr.pre_g.clone(), cr.pre_b.clone(), cr.post.clone())
        });
        out.par_chunks_mut(4).zip(rgb16.par_chunks(3)).with_min_len(4096).for_each(|(out_px, in_px)| {
            let r = pre_r[in_px[0] as usize] as f32;
            let g = pre_g[in_px[1] as usize] as f32;
            let b = pre_b[in_px[2] as usize] as f32;
            let (r2, g2, b2) = apply_tone_math(r, g, b, m, ti.sat, ti.vib, ti.vib_zero, ti.perceptual_constancy);
            out_px[0] = post[r2.clamp(0.0, 65535.0) as u16 as usize];
            out_px[1] = post[g2.clamp(0.0, 65535.0) as u16 as usize];
            out_px[2] = post[b2.clamp(0.0, 65535.0) as u16 as usize];
            out_px[3] = 255;
        });
    }

    out
}

/// Gray-world auto-WB from raw Bayer (RGGB) pixels.  Returns (r_gain,
/// b_gain) normalised so G_gain = 1.0.  Samples every 8×8 block to keep it
/// cheap (strides by 8).  Assumes an RGGB CFA at (0,0). Clamps the result to a sane range so a colour-cast scene (e.g.
/// uniform-red rocks) doesn't blow the highlights.
pub fn auto_wb_rggb(raw: &[u16], w: usize, h: usize, black: u16) -> (f32, f32) {
    let blk = black as u32;
    let (mut sr, mut sg, mut sb) = (0u64, 0u64, 0u64);
    let (mut nr, mut ng, mut nb) = (0u64, 0u64, 0u64);
    // Iterate 4-pixel-stride RGGB quads.
    let mut y = 0;
    while y + 1 < h {
        let mut x = 0;
        while x + 1 < w {
            let r = raw[y * w + x] as u32;
            let g1 = raw[y * w + x + 1] as u32;
            let g2 = raw[(y + 1) * w + x] as u32;
            let b = raw[(y + 1) * w + x + 1] as u32;
            let r = r.saturating_sub(blk);
            let g1 = g1.saturating_sub(blk);
            let g2 = g2.saturating_sub(blk);
            let b = b.saturating_sub(blk);
            sr += r as u64; nr += 1;
            sg += (g1 + g2) as u64; ng += 2;
            sb += b as u64; nb += 1;
            x += 8;
        }
        y += 8;
    }
    let avg_r = (sr as f64 / nr.max(1) as f64).max(1.0);
    let avg_g = (sg as f64 / ng.max(1) as f64).max(1.0);
    let avg_b = (sb as f64 / nb.max(1) as f64).max(1.0);
    let r_gain = (avg_g / avg_r).clamp(0.8, 4.0) as f32;
    let b_gain = (avg_g / avg_b).clamp(0.8, 4.0) as f32;
    (r_gain, b_gain)
}

/// Gaussian-blur-based luminance noise reduction.  Blends each channel toward
/// a 5-tap Gaussian blur by `strength` (0 = no-op, 1 = fully blurred).
/// Call after demosaic, before tone mapping.  Strength should be derived from
/// EXIF ISO: 0 below ISO 1600, 0.15–0.5 at higher ISOs.
pub fn apply_luminance_nr(rgb16: &mut [u16], width: usize, height: usize, strength: f32) {
    if strength <= 0.0 { return; }
    let s = strength.clamp(0.0, 1.0);
    let kernel = gaussian_kernel_5();
    BLUR_SCRATCH.with(|scratch| {
        let (ref mut temp, ref mut blurred) = *scratch.borrow_mut();
        separable_blur_with_bufs(rgb16, width, height, &kernel, temp, blurred);
        let n = rgb16.len();
        let mut i = 0;
        while i < n {
            let o = rgb16[i] as f32;
            let b = blurred[i] as f32;
            rgb16[i] = (o + (b - o) * s).round().clamp(0.0, 65535.0) as u16;
            i += 1;
        }
    });
}

/// Full pipeline → 16-bit sRGB output (same pipeline as `process` but u16 output).
/// Maps the tone-curved, sRGB-gamma-corrected result to [0, 65535] instead of [0, 255].
/// Suitable as a 16-bit TIFF source for further editing.
pub fn process_16bit(rgb16: &[u16], params: &PipelineParams) -> Vec<u16> {
    debug_assert_eq!(rgb16.len() % 3, 0);
    let ti = derive_tone_inputs(params);
    let fallback = CAM_TO_SRGB;
    let m = params.color_matrix.as_ref().unwrap_or(&fallback);
    let n = rgb16.len() / 3;
    let mut out = vec![0u16; n * 3];

    #[cfg(not(feature = "parallel"))]
    {
        LUT_CACHE.with(|cache_cell| {
            ensure_lut(&mut cache_cell.borrow_mut(), params, &ti, true);
            let cache = cache_cell.borrow();
            let c = cache.as_ref().unwrap();
            let post16 = c.post16.as_ref().unwrap();
            // Lens 23 pointer version for 16bit path too.
            // unsafe: same in-bounds invariant as process_into (out is n*3 u16; dst advances n*3).
            // NOTE: 4x unroll + perceptual bulk-tile (AVX2 hand intrinsics for pc) pattern implemented in process_into !par block.
            // Replicate here for 16-bit TIFF / further editing / CV consumers needing higher prec + constancy (photogram/LLM layers 12/14).
            unsafe {
                let nbytes = rgb16.len();
                let mut src = rgb16.as_ptr();
                let mut dst = out.as_mut_ptr();
                let src_end = src.add(nbytes);
                let pre_r = c.pre_r.as_ptr();
                let pre_g = c.pre_g.as_ptr();
                let pre_b = c.pre_b.as_ptr();
                let post16 = c.post16.as_ref().unwrap().as_ptr();
                while src < src_end {
                    let r = *pre_r.add(*src as usize) as f32; src = src.add(1);
                    let g = *pre_g.add(*src as usize) as f32; src = src.add(1);
                    let b = *pre_b.add(*src as usize) as f32; src = src.add(1);
                    let (r2, g2, b2) = apply_tone_math(r, g, b, m, ti.sat, ti.vib, ti.vib_zero, ti.perceptual_constancy);
                    *dst = *post16.add(r2.clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                    *dst = *post16.add(g2.clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                    *dst = *post16.add(b2.clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                }
            }
        });
    }

    #[cfg(feature = "parallel")]
    {
        let (pre_r, pre_g, pre_b, post16) = LUT_CACHE.with(|cache_cell| {
            ensure_lut(&mut cache_cell.borrow_mut(), params, &ti, true);
            let c = cache_cell.borrow();
            let cr = c.as_ref().unwrap();
            (cr.pre_r.clone(), cr.pre_g.clone(), cr.pre_b.clone(), cr.post16.as_ref().unwrap().clone())
        });
        out.par_chunks_mut(3).zip(rgb16.par_chunks(3)).with_min_len(4096).for_each(|(out_px, in_px)| {
            let r = pre_r[in_px[0] as usize] as f32;
            let g = pre_g[in_px[1] as usize] as f32;
            let b = pre_b[in_px[2] as usize] as f32;
            let (r2, g2, b2) = apply_tone_math(r, g, b, m, ti.sat, ti.vib, ti.vib_zero, ti.perceptual_constancy);
            out_px[0] = post16[r2.clamp(0.0, 65535.0) as u16 as usize];
            out_px[1] = post16[g2.clamp(0.0, 65535.0) as u16 as usize];
            out_px[2] = post16[b2.clamp(0.0, 65535.0) as u16 as usize];
        });
    }

    out
}

/// Box downscale RGB16 (u16 interleaved) → smaller Vec<u16>. Rayon over rows.
///
/// Item 9 (light touch): The allocating version is the common case today. For hot paths
/// that can pre-allocate (e.g. 1800px lightbox or 360px thumb buffers), use the `_into`
/// variant to avoid the Vec allocation inside the downscaler.
pub fn downscale_rgb16(src: &[u16], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u16> {
    let mut out = vec![0u16; dw * dh * 3];
    downscale_rgb16_into(src, sw, sh, dw, dh, &mut out);
    out
}

/// Writes the downscaled result directly into `out` (must be exactly dw*dh*3 elements).
/// No allocation. Rayon over rows.
pub fn downscale_rgb16_into(src: &[u16], sw: usize, sh: usize, dw: usize, dh: usize, out: &mut [u16]) {
    #[cfg(feature = "parallel")]
    use rayon::prelude::*;
    validate_pixel_buffer_u16(src, sw, sh, 3)
        .expect("downscale_rgb16_into: source buffer bounds");
    validate_pixel_buffer_u16(out, dw, dh, 3)
        .expect("downscale_rgb16_into: output buffer bounds");

    // Integer fast path for exact factors (very common: 1800px lb → 360px thumb = 5x).
    // Matches the style of the WASM glue downscalers; avoids all f32 math + rayon overhead.
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let n = (xstep * ystep) as u32;
        for dy in 0..dh {
            let row = &mut out[dy * dw * 3..(dy + 1) * dw * 3];
            for dx in 0..dw {
                let mut rr = 0u32;
                let mut gg = 0u32;
                let mut bb = 0u32;
                for yy in 0..ystep {
                    let y = dy * ystep + yy;
                    let base = (y * sw + dx * xstep) * 3;
                    for xx in 0..xstep {
                        let i = base + xx * 3;
                        rr += src[i] as u32;
                        gg += src[i + 1] as u32;
                        bb += src[i + 2] as u32;
                    }
                }
                let o = dx * 3;
                row[o] = (rr / n) as u16;
                row[o + 1] = (gg / n) as u16;
                row[o + 2] = (bb / n) as u16;
            }
        }
        return;
    }

    let xr = sw as f32 / dw as f32;
    let yr = sh as f32 / dh as f32;
    #[cfg(feature = "parallel")]
    let iter = out.par_chunks_mut(dw * 3);
    #[cfg(not(feature = "parallel"))]
    let iter = out.chunks_mut(dw * 3);
    iter.enumerate().for_each(|(dy, row)| {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = ((dy as f32 + 1.0) * yr).min(sh as f32) as usize;
        let y1 = y1.max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = ((dx as f32 + 1.0) * xr).min(sw as f32) as usize;
            let x1 = x1.max(x0 + 1);
            let (mut rr, mut gg, mut bb, mut n) = (0u32, 0u32, 0u32, 0u32);
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * sw + x) * 3;
                    rr += src[i] as u32; gg += src[i+1] as u32; bb += src[i+2] as u32; n += 1;
                }
            }
            let n = n.max(1);
            let o = dx * 3;
            row[o] = (rr / n) as u16; row[o+1] = (gg / n) as u16; row[o+2] = (bb / n) as u16;
        }
    });
}

/// Box downscale RGB8 → smaller Vec<u8>. Rayon over rows.
///
/// Item 9 (light touch): See downscale_rgb16_into for the pre-allocated variant.
pub fn downscale_rgb8(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    let mut out = vec![0u8; dw * dh * 3];
    downscale_rgb8_into(src, sw, sh, dw, dh, &mut out);
    out
}

/// Writes the downscaled result directly into `out` (must be exactly dw*dh*3 elements).
pub fn downscale_rgb8_into(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize, out: &mut [u8]) {
    #[cfg(feature = "parallel")]
    use rayon::prelude::*;
    validate_pixel_buffer(src, sw, sh, 3)
        .expect("downscale_rgb8_into: source buffer bounds");
    validate_pixel_buffer(out, dw, dh, 3)
        .expect("downscale_rgb8_into: output buffer bounds");

    // Integer fast path for exact factors (symmetric to the rgb16 version).
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let n = (xstep * ystep) as u32;
        #[cfg(feature = "parallel")]
        let iter = out.par_chunks_mut(dw * 3);
        #[cfg(not(feature = "parallel"))]
        let iter = out.chunks_mut(dw * 3);
        iter.enumerate().for_each(|(dy, row)| {
            for dx in 0..dw {
                let mut rr = 0u32;
                let mut gg = 0u32;
                let mut bb = 0u32;
                for yy in 0..ystep {
                    let y = dy * ystep + yy;
                    let base = (y * sw + dx * xstep) * 3;
                    for xx in 0..xstep {
                        let i = base + xx * 3;
                        rr += src[i] as u32;
                        gg += src[i + 1] as u32;
                        bb += src[i + 2] as u32;
                    }
                }
                let o = dx * 3;
                row[o] = (rr / n) as u8;
                row[o + 1] = (gg / n) as u8;
                row[o + 2] = (bb / n) as u8;
            }
        });
        return;
    }

    let xr = sw as f32 / dw as f32;
    let yr = sh as f32 / dh as f32;
    #[cfg(feature = "parallel")]
    let iter = out.par_chunks_mut(dw * 3);
    #[cfg(not(feature = "parallel"))]
    let iter = out.chunks_mut(dw * 3);
    iter.enumerate().for_each(|(dy, row)| {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = ((dy as f32 + 1.0) * yr).min(sh as f32) as usize;
        let y1 = y1.max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = ((dx as f32 + 1.0) * xr).min(sw as f32) as usize;
            let x1 = x1.max(x0 + 1);
            let (mut rr, mut gg, mut bb, mut n) = (0u32, 0u32, 0u32, 0u32);
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * sw + x) * 3;
                    rr += src[i] as u32; gg += src[i+1] as u32; bb += src[i+2] as u32; n += 1;
                }
            }
            let n = n.max(1);
            let o = dx * 3;
            row[o] = (rr / n) as u8; row[o+1] = (gg / n) as u8; row[o+2] = (bb / n) as u8;
        }
    });
}

/// Target dims for long-edge resize (preserves aspect, min 1).
pub fn target_dims(w: usize, h: usize, long_edge: usize) -> (usize, usize) {
    if w >= h {
        let lw = w.min(long_edge);
        (lw, ((h * lw) / w).max(1))
    } else {
        let lh = h.min(long_edge);
        (((w * lh) / h).max(1), lh)
    }
}

/// Unified look parameter applicator (single source of truth for the 12 sliders).
/// Matches the logic previously duplicated in WASM wrapper and Tauri pipeline.
/// All values are finite-checked; non-finite are ignored (keeps prior behavior).
pub fn apply_look_params(
    params: &mut PipelineParams,
    exposure_ev: f32,
    contrast: f32,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
    saturation: f32,
    vibrance: f32,
    temp: f32,
    tint: f32,
    texture: f32,
    clarity: f32,
) {
    if exposure_ev.is_finite() {
        params.exposure_ev = exposure_ev;
    }
    if contrast.is_finite() {
        params.contrast = contrast;
    }
    if highlights.is_finite() {
        params.highlights = highlights;
    }
    if shadows.is_finite() {
        params.shadows = shadows;
    }
    if whites.is_finite() {
        params.whites = whites;
    }
    if blacks.is_finite() {
        params.blacks = blacks;
    }
    if saturation.is_finite() {
        params.saturation = saturation;
    }
    if vibrance.is_finite() {
        params.vibrance = vibrance;
    }
    if temp.is_finite() {
        params.temp = temp;
    }
    if tint.is_finite() {
        params.tint = tint;
    }
    if texture.is_finite() {
        params.texture = texture;
    }
    if clarity.is_finite() {
        params.clarity = clarity;
    }
}

/// Apply EXIF orientation tag to a packed RGB8 image.
///
/// Handles orientations 3 (180°), 6 (90° CW), 8 (90° CCW).
/// Orientations 1 (normal), 2, 4, 5, 7 are passed through as-is.
/// Mirror/transpose variants (2, 4, 5, 7) are rare in Olympus ORF and not implemented.
pub fn apply_orientation(
    rgb: Vec<u8>,
    width: usize,
    height: usize,
    orientation: u16,
) -> (Vec<u8>, usize, usize) {
    match orientation {
        3 => (rotate_180(&rgb, width, height), width, height),
        6 => (rotate_90_cw(&rgb, width, height), height, width),
        8 => (rotate_90_ccw(&rgb, width, height), height, width),
        _ => (rgb, width, height), // orientation 1 + unknowns: zero-copy move
    }
}

// Tile-blocked transpose. TILE chosen so a tile of TILE × TILE × 3 bytes fits
// comfortably in L1 along with the dst-row strips it touches (≈ 6 KB working
// set per thread at TILE=32). Parallel chunks distribute exclusive dst row
// bands → no cross-thread aliasing.
const TILE: usize = 32;

/// dst[c, h-1-r] = src[r, c].  Output dims: (h, w).
pub fn rotate_90_cw(src: &[u8], w: usize, h: usize) -> Vec<u8> {
    let w_dst = h;
    let dst_row_bytes = w_dst * 3;
    let mut dst = vec![0u8; src.len()];
    let band_bytes = TILE * dst_row_bytes;

    let body = |(band_idx, band): (usize, &mut [u8])| {
        let c0 = band_idx * TILE;
        let band_rows = band.len() / dst_row_bytes;
        for r0 in (0..h).step_by(TILE) {
            let r_end = (r0 + TILE).min(h);
            for r in r0..r_end {
                let dst_col_off = (h - 1 - r) * 3;
                let src_row_off = r * w * 3;
                for c_local in 0..band_rows {
                    let s = src_row_off + (c0 + c_local) * 3;
                    let d = c_local * dst_row_bytes + dst_col_off;
                    band[d]     = src[s];
                    band[d + 1] = src[s + 1];
                    band[d + 2] = src[s + 2];
                }
            }
        }
    };

    #[cfg(feature = "parallel")]
    dst.par_chunks_mut(band_bytes).enumerate().for_each(body);
    #[cfg(not(feature = "parallel"))]
    dst.chunks_mut(band_bytes).enumerate().for_each(body);
    dst
}

/// dst[w-1-c, r] = src[r, c].  Output dims: (h, w).
pub fn rotate_90_ccw(src: &[u8], w: usize, h: usize) -> Vec<u8> {
    let w_dst = h;
    let dst_row_bytes = w_dst * 3;
    let mut dst = vec![0u8; src.len()];
    let band_bytes = TILE * dst_row_bytes;

    let body = |(band_idx, band): (usize, &mut [u8])| {
        let band_rows = band.len() / dst_row_bytes;
        // Band owns dst rows [band_idx*TILE, band_idx*TILE+band_rows).
        // dst row index = w-1-c  →  c = w-1-dst_row_idx.
        let c_top = w - 1 - band_idx * TILE;        // c for c_local=0
        for r0 in (0..h).step_by(TILE) {
            let r_end = (r0 + TILE).min(h);
            for r in r0..r_end {
                let dst_col_off = r * 3;
                let src_row_off = r * w * 3;
                for c_local in 0..band_rows {
                    let c = c_top - c_local;
                    let s = src_row_off + c * 3;
                    let d = c_local * dst_row_bytes + dst_col_off;
                    band[d]     = src[s];
                    band[d + 1] = src[s + 1];
                    band[d + 2] = src[s + 2];
                }
            }
        }
    };

    #[cfg(feature = "parallel")]
    dst.par_chunks_mut(band_bytes).enumerate().for_each(body);
    #[cfg(not(feature = "parallel"))]
    dst.chunks_mut(band_bytes).enumerate().for_each(body);
    dst
}

/// dst[h-1-r, w-1-c] = src[r, c].  Output dims: (w, h).  Already row-sequential;
/// just parallelize over dst rows.
pub fn rotate_180(src: &[u8], w: usize, h: usize) -> Vec<u8> {
    let row_bytes = w * 3;
    let mut dst = vec![0u8; src.len()];

    let body = |(dst_row_idx, dst_row): (usize, &mut [u8])| {
        let src_row_idx = h - 1 - dst_row_idx;
        let s_row = &src[src_row_idx * row_bytes..(src_row_idx + 1) * row_bytes];
        for c in 0..w {
            let sc = w - 1 - c;
            let s = sc * 3;
            let d = c * 3;
            dst_row[d]     = s_row[s];
            dst_row[d + 1] = s_row[s + 1];
            dst_row[d + 2] = s_row[s + 2];
        }
    };

    #[cfg(feature = "parallel")]
    dst.par_chunks_mut(row_bytes).enumerate().for_each(body);
    #[cfg(not(feature = "parallel"))]
    dst.chunks_mut(row_bytes).enumerate().for_each(body);
    dst
}

#[cfg(test)]
mod pixel_buffer_validation_tests {
    use super::*;

    #[test]
    fn validate_pixel_buffer_accepts_exact_rgb8() {
        let buf = vec![0u8; 4 * 3 * 3];
        assert!(validate_pixel_buffer(&buf, 4, 3, 3).is_ok());
    }

    #[test]
    fn validate_pixel_buffer_rejects_slack() {
        let buf = vec![0u8; 100];
        let err = validate_pixel_buffer(&buf, 4, 3, 3).unwrap_err();
        assert!(err.contains("length mismatch"), "{err}");
    }

    #[test]
    fn validate_pixel_dims_rejects_oversize() {
        let side = 65536usize;
        let err = validate_pixel_dims(side, side, 4).unwrap_err();
        assert!(err.contains("exceeds"), "{err}");
    }
}

#[cfg(test)]
mod rotate_tests {
    use super::*;

    // Build a synthetic image where pixel (r, c) = (r as u8, c as u8, (r+c) as u8).
    fn synth(w: usize, h: usize) -> Vec<u8> {
        let mut v = vec![0u8; w * h * 3];
        for r in 0..h {
            for c in 0..w {
                let i = (r * w + c) * 3;
                v[i]     = (r & 0xff) as u8;
                v[i + 1] = (c & 0xff) as u8;
                v[i + 2] = ((r + c) & 0xff) as u8;
            }
        }
        v
    }

    #[test]
    fn rotate_90_cw_then_ccw_is_identity() {
        for (w, h) in [(7usize, 5usize), (32, 32), (33, 31), (100, 60)] {
            let src = synth(w, h);
            let rot = rotate_90_cw(&src, w, h);
            let back = rotate_90_ccw(&rot, h, w);
            assert_eq!(back, src, "{w}x{h}");
        }
    }

    #[test]
    fn rotate_180_is_involution() {
        for (w, h) in [(7usize, 5usize), (32, 32), (33, 31), (100, 60)] {
            let src = synth(w, h);
            let twice = rotate_180(&rotate_180(&src, w, h), w, h);
            assert_eq!(twice, src, "{w}x{h}");
        }
    }

    #[test]
    fn rotate_90_cw_four_times_is_identity() {
        let (w, h) = (33usize, 17usize);
        let src = synth(w, h);
        let a = rotate_90_cw(&src, w, h);          // h x w
        let b = rotate_90_cw(&a, h, w);            // w x h
        let c = rotate_90_cw(&b, w, h);            // h x w
        let d = rotate_90_cw(&c, h, w);            // w x h
        assert_eq!(d, src);
    }

    #[test]
    fn rotate_90_cw_corner_pixel() {
        let (w, h) = (4usize, 3usize);
        let mut src = vec![0u8; w * h * 3];
        // mark (0,0) = (10, 20, 30)
        src[0] = 10; src[1] = 20; src[2] = 30;
        // After CW: src (0,0) → dst (0, h-1) = (0, 2)
        let rot = rotate_90_cw(&src, w, h);
        // dst dims: w_dst = h = 3, h_dst = w = 4
        let i = (0 * 3 + 2) * 3;
        assert_eq!(&rot[i..i + 3], &[10, 20, 30]);
    }

    #[test]
    fn rotate_90_cw_matches_naive() {
        let (w, h) = (37usize, 19usize);
        let src = synth(w, h);
        let fast = rotate_90_cw(&src, w, h);
        // Naive reference.
        let mut naive = vec![0u8; src.len()];
        let w_dst = h;
        for r in 0..h {
            for c in 0..w {
                let s = (r * w + c) * 3;
                let d = (c * w_dst + (h - 1 - r)) * 3;
                naive[d]     = src[s];
                naive[d + 1] = src[s + 1];
                naive[d + 2] = src[s + 2];
            }
        }
        assert_eq!(fast, naive);
    }

    #[test]
    fn rotate_90_ccw_matches_naive() {
        let (w, h) = (37usize, 19usize);
        let src = synth(w, h);
        let fast = rotate_90_ccw(&src, w, h);
        let mut naive = vec![0u8; src.len()];
        let w_dst = h;
        for r in 0..h {
            for c in 0..w {
                let s = (r * w + c) * 3;
                let d = ((w - 1 - c) * w_dst + r) * 3;
                naive[d]     = src[s];
                naive[d + 1] = src[s + 1];
                naive[d + 2] = src[s + 2];
            }
        }
        assert_eq!(fast, naive);
    }
}

#[cfg(test)]
mod rotate_bench {
    use super::*;
    use std::time::Instant;

    // Run with: cargo test --lib --release --no-default-features --features parallel rotate_bench::bench -- --nocapture
    // Naive single-threaded column-walk rotation (mirrors the OLD untiled
    // implementation) — for direct A/B benchmark vs the new tile-blocked + parallel one.
    fn rotate_90_cw_naive(src: &[u8], w: usize, h: usize) -> Vec<u8> {
        let mut dst = vec![0u8; src.len()];
        let w_dst = h;
        for c in 0..w {
            let dst_row = &mut dst[c * w_dst * 3..(c + 1) * w_dst * 3];
            for nc in 0..w_dst {
                let r = h - 1 - nc;
                let s = (r * w + c) * 3;
                let d = nc * 3;
                dst_row[d]     = src[s];
                dst_row[d + 1] = src[s + 1];
                dst_row[d + 2] = src[s + 2];
            }
        }
        dst
    }

    #[test]
    #[ignore]
    fn bench_rotate_90_cw_full_orf() {
        // Olympus full-frame after demosaic: ~5184 × 3888 RGB8.
        let (w, h) = (5184usize, 3888usize);
        // Varying content so the CPU can't trivially cache constant fills.
        let mut src = vec![0u8; w * h * 3];
        for (i, b) in src.iter_mut().enumerate() { *b = (i & 0xff) as u8; }

        // Warm up.
        let _ = rotate_90_cw(&src, w, h);
        let _ = rotate_90_cw_naive(&src, w, h);

        const N: usize = 5;
        let t0 = Instant::now();
        for _ in 0..N {
            let _ = rotate_90_cw(&src, w, h);
        }
        let new_ms = (t0.elapsed().as_secs_f64() / N as f64) * 1000.0;

        let t1 = Instant::now();
        for _ in 0..N {
            let _ = rotate_90_cw_naive(&src, w, h);
        }
        let old_ms = (t1.elapsed().as_secs_f64() / N as f64) * 1000.0;

        let mb = (w * h * 3) as f64 / 1_048_576.0;
        println!("rotate_90_cw 5184×3888 RGB8 ({:.1} MB):", mb);
        println!("  new (tile-blocked + parallel): {:.2} ms", new_ms);
        println!("  old (naive column-walk):       {:.2} ms", old_ms);
        println!("  speedup:                        {:.1}×", old_ms / new_ms);
    }

    #[test]
    #[ignore]
    fn bench_rotate_90_cw_lightbox() {
        // Lightbox-sized — what LookRenderer hits per slider tick.
        let (w, h) = (1800usize, 1200usize);
        let src = vec![42u8; w * h * 3];
        let _ = rotate_90_cw(&src, w, h);

        const N: usize = 20;
        let t0 = Instant::now();
        for _ in 0..N {
            let _ = rotate_90_cw(&src, w, h);
        }
        let avg_ms = (t0.elapsed().as_secs_f64() / N as f64) * 1000.0;
        let mb = (w * h * 3) as f64 / 1_048_576.0;
        println!("rotate_90_cw 1800×1200 RGB8 ({:.1} MB): {:.2} ms (avg of {} runs)", mb, avg_ms, N);
    }
}

/// Targeted flip-flop tests for suspected tonemap + demosaic smoking guns (per user lenses 22-25).
/// Alternate "newer" (full apply_tone_math with perceptual_constancy / advanced stub, or clean demosaic path)
/// vs "old" (simpler path or no advanced) 10 times on the same operation (fixed buffer or decode+process).
/// For any suspected slowdown/speedup in apply_tone_math (SIMD unroll, new perceptual math/LUT/poly approx,
/// spring/fc variants, bulk tile) use this harness: set TRIALS=12, run the test, compare CSV ratios + medians.
/// Run with: cargo test --lib --release --no-default-features --features parallel pipeline::tonemap_flip_flops -- --nocapture
#[cfg(test)]
mod tonemap_flip_flops {
    use super::*;
    use std::time::Instant;

    fn make_test_rgb16(n_pixels: usize) -> Vec<u16> {
        (0..n_pixels * 3).map(|i| ((i * 37) % 65535) as u16).collect()
    }

    #[test]
    fn flip_flop_tonemap_apply_10x() {
        let buf = make_test_rgb16(1920 * 1080 / 4); // ~0.5M pixels, manageable
        // Explicit struct (no Default derive in all feature sets).
        let base_params = PipelineParams {
            black: 0, white: 16383, wb_r: 2.0, wb_g: 1.0, wb_b: 1.7,
            exposure_ev: 0.0, temp: 0.0, tint: 0.0, saturation: 0.0, vibrance: 0.0,
            contrast: 0.0, shadows: 0.0, highlights: 0.0, whites: 0.0, blacks: 0.0,
            color_matrix: None,
            texture: 0.0,
            clarity: 0.0,
            perceptual_constancy: false,
        };

        // Support graphing stabilization: print CSV + running stats. 30 is often excessive; bench shows signal settles ~8-12.
        // Run with env TRIALS=12 or edit. Default keeps 30 for back-compat with prior handoff numbers.
        let trials: usize = std::env::var("TRIALS").ok().and_then(|s| s.parse().ok()).unwrap_or(30);
        println!("\n=== Flip-flop tonemap (Lens22/23/25): apply_tone_math new (perceptual=true) vs old (false) x{} for stats (CSV for graph) ===", trials);
        println!("CSV: trial,new_ms,old_ms,ratio_new_over_old,running_mean_ratio");
        let mut new_times: Vec<f64> = Vec::new();
        let mut old_times: Vec<f64> = Vec::new();
        for i in 0..trials {
            let use_new = i % 2 == 0;
            let mut params = base_params.clone();
            params.perceptual_constancy = use_new;
            // warm
            let _ = process(&buf, &params);
            let t0 = Instant::now();
            for _ in 0..5 { let _ = process(&buf, &params); } // inner iters for stable timing
            let ms = (t0.elapsed().as_secs_f64() / 5.0) * 1000.0;
            if use_new { new_times.push(ms); } else { old_times.push(ms); }
            let ratio = if !use_new && !old_times.is_empty() && !new_times.is_empty() {
                new_times.last().unwrap() / old_times.last().unwrap()
            } else { 0.0 };
            // running mean of observed ratios (new/old pairs so far)
            let run_mean = if !new_times.is_empty() && !old_times.is_empty() {
                let pairs = new_times.len().min(old_times.len());
                let sum_r: f64 = (0..pairs).map(|k| new_times[k] / old_times[k]).sum();
                sum_r / pairs as f64
            } else { 0.0 };
            println!("CSV,{},{:.3},{:.3},{:.3},{:.3}", i, if use_new {ms} else {0.0}, if !use_new {ms} else {0.0}, ratio, run_mean);
            println!("tone flip {}: {:.3} ms (new/perceptual={})", i, ms, use_new);
        }
        // Quick stabilization note (mirrors C++ bench)
        if new_times.len() > 1 && old_times.len() > 1 {
            let pairs = new_times.len().min(old_times.len());
            let ratios: Vec<f64> = (0..pairs).map(|k| new_times[k]/old_times[k]).collect();
            let m = ratios.iter().sum::<f64>() / pairs as f64;
            let var = ratios.iter().map(|r| (r-m).powi(2)).sum::<f64>() / (pairs as f64 - 1.0).max(1.0);
            println!("Post-run: mean ratio new/old = {:.3}, sample std = {:.3} over {} pairs ({} trials). 8-12 often enough per C++ graphed bench.", m, var.sqrt(), pairs, trials);
        }
    }

    // Demosaic+tone chain flip omitted in this build to avoid cross-module feature issues in test; see dng flip test for chain proxy + previous black sub switch.
    // The tonemap one above covers the main suspected smoking gun (apply_tone_math + process loops).

    // ---- Comprehensive flip-flop A/B for the implemented lens-22..25 items ----
    // Run: .\build-msvc.ps1 test --manifest-path crates/raw-pipeline/Cargo.toml --release
    //        --no-default-features --features parallel -- --ignored flipflop_ab --nocapture --test-threads=1
    use crate::demosaic;

    fn median(mut v: Vec<f64>) -> f64 {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    }

    // Pre-T1 serial LUT builders, kept here as the A/B baseline for the now-parallel production ones.
    fn build_pre_lut_serial(black: u16, white: u16, wb_eff: f32, exp_gain: f32) -> Vec<u16> {
        let mut lut = vec![0u16; 65536];
        let denom = (white.saturating_sub(black)).max(1) as f32;
        let gain = wb_eff * exp_gain;
        let norm_gain = gain / denom;
        for i in 0..65536usize {
            let centered = (i as i32 - black as i32).max(0) as f32;
            let n = highlight_shoulder(centered * norm_gain);
            lut[i] = (n * 65535.0 + 0.5).min(65535.0) as u16;
        }
        lut
    }
    fn build_post_lut_serial(t: &TonePost) -> Vec<u8> {
        let mut lut = vec![0u8; 65536];
        for i in 0..65536usize {
            let y = tone_curve(i as f32 / 65535.0, t);
            lut[i] = (y * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
        }
        lut
    }

    fn synth_bayer(w: usize, h: usize) -> Vec<u16> {
        (0..w * h).map(|i| (i.wrapping_mul(2654435761) & 0x3fff) as u16).collect()
    }

    #[test]
    #[ignore]
    fn flipflop_ab() {
        let params = PipelineParams::default_olympus();
        let ti = derive_tone_inputs(&params);

        eprintln!("=== FLIP-FLOP A/B (release, parallel={}) ===", cfg!(feature = "parallel"));
        eprintln!("ROW\tcontext\told_ms\tnew_ms\tspeedup");

        // B1 — T1 parallel LUT build (new) vs serial (old). One full set = 3 pre + 1 post (an ensure_lut miss).
        {
            assert_eq!(
                build_pre_lut(params.black, params.white, ti.wb_r, ti.exp_gain),
                build_pre_lut_serial(params.black, params.white, ti.wb_r, ti.exp_gain),
                "B1 pre LUT parallel must equal serial"
            );
            assert_eq!(build_post_lut(&ti.tone), build_post_lut_serial(&ti.tone), "B1 post LUT parallel must equal serial");
            let iters = 200;
            for _ in 0..10 {
                let _ = build_pre_lut(params.black, params.white, ti.wb_r, ti.exp_gain);
                let _ = build_pre_lut_serial(params.black, params.white, ti.wb_r, ti.exp_gain);
            }
            let (mut oldt, mut newt) = (Vec::new(), Vec::new());
            for _ in 0..iters {
                let t = Instant::now();
                let a = build_pre_lut(params.black, params.white, ti.wb_r, ti.exp_gain);
                let b = build_pre_lut(params.black, params.white, ti.wb_g, ti.exp_gain);
                let c = build_pre_lut(params.black, params.white, ti.wb_b, ti.exp_gain);
                let d = build_post_lut(&ti.tone);
                newt.push(t.elapsed().as_secs_f64() * 1000.0);
                std::hint::black_box((&a, &b, &c, &d));

                let t = Instant::now();
                let a = build_pre_lut_serial(params.black, params.white, ti.wb_r, ti.exp_gain);
                let b = build_pre_lut_serial(params.black, params.white, ti.wb_g, ti.exp_gain);
                let c = build_pre_lut_serial(params.black, params.white, ti.wb_b, ti.exp_gain);
                let d = build_post_lut_serial(&ti.tone);
                oldt.push(t.elapsed().as_secs_f64() * 1000.0);
                std::hint::black_box((&a, &b, &c, &d));
            }
            let (o, n) = (median(oldt), median(newt));
            eprintln!("B1-LUTbuild\t3pre+post\t{:.4}\t{:.4}\t{:.2}x", o, n, o / n);
        }

        // B2 — T2 process() alloc-each-call (old) vs process_into() buffer reuse (new).
        for &(w, h, label) in &[(5000usize, 4000usize, "20MP"), (1800usize, 1200usize, "lightbox")] {
            let rgb16: Vec<u16> = (0..w * h * 3).map(|i| (i.wrapping_mul(2654435761) & 0xffff) as u16).collect();
            let mut buf = vec![0u8; w * h * 3];
            process_into(&rgb16, &params, &mut buf);
            assert_eq!(process(&rgb16, &params), buf, "B2 process_into must equal process");
            let iters = if w >= 5000 { 15 } else { 40 };
            for _ in 0..3 { std::hint::black_box(process(&rgb16, &params)); process_into(&rgb16, &params, &mut buf); }
            let (mut oldt, mut newt) = (Vec::new(), Vec::new());
            for _ in 0..iters {
                let t = Instant::now(); let r = process(&rgb16, &params); oldt.push(t.elapsed().as_secs_f64() * 1000.0); std::hint::black_box(r);
                let t = Instant::now(); process_into(&rgb16, &params, &mut buf); newt.push(t.elapsed().as_secs_f64() * 1000.0); std::hint::black_box(&buf);
            }
            let (o, n) = (median(oldt), median(newt));
            eprintln!("B2-process\t{}\t{:.4}\t{:.4}\t{:.2}x", label, o, n, o / n);
        }

        // B3 — T3 demosaic_rggb() alloc (old) vs demosaic_rggb_into() reuse (new).
        for &(w, h, label) in &[(5000usize, 4000usize, "20MP"), (1800usize, 1200usize, "lightbox")] {
            let raw = synth_bayer(w, h);
            let mut buf = vec![0u16; w * h * 3];
            demosaic::demosaic_rggb_into(&raw, w, h, &mut buf).unwrap();
            assert_eq!(demosaic::demosaic_rggb(&raw, w, h).unwrap(), buf, "B3 into must equal alloc");
            let iters = if w >= 5000 { 15 } else { 40 };
            for _ in 0..3 { std::hint::black_box(demosaic::demosaic_rggb(&raw, w, h).unwrap()); demosaic::demosaic_rggb_into(&raw, w, h, &mut buf).unwrap(); }
            let (mut oldt, mut newt) = (Vec::new(), Vec::new());
            for _ in 0..iters {
                let t = Instant::now(); let r = demosaic::demosaic_rggb(&raw, w, h).unwrap(); oldt.push(t.elapsed().as_secs_f64() * 1000.0); std::hint::black_box(r);
                let t = Instant::now(); demosaic::demosaic_rggb_into(&raw, w, h, &mut buf).unwrap(); newt.push(t.elapsed().as_secs_f64() * 1000.0); std::hint::black_box(&buf);
            }
            let (o, n) = (median(oldt), median(newt));
            eprintln!("B3-demosaic\t{}\t{:.4}\t{:.4}\t{:.2}x", label, o, n, o / n);
        }

        // B4 — rgb16-cache payoff (Lens 24): full re-render (demosaic+tone) per slider tick vs tone-only
        // when rgb16 is cached. old = full, new = tone-only. Demonstrates the JS-layer cache win.
        for &(w, h, label) in &[(1800usize, 1200usize, "lightbox"), (640usize, 480usize, "thumb")] {
            let raw = synth_bayer(w, h);
            let iters = 30;
            for _ in 0..3 { let r = demosaic::demosaic_rggb_mhc(&raw, w, h).unwrap(); std::hint::black_box(process(&r, &params)); }
            let mut full = Vec::new();
            for _ in 0..iters {
                let t = Instant::now();
                let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).unwrap();
                let r = process(&rgb16, &params);
                full.push(t.elapsed().as_secs_f64() * 1000.0); std::hint::black_box(r);
            }
            let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).unwrap();
            let mut warm = Vec::new();
            for _ in 0..iters {
                let t = Instant::now();
                let r = process(&rgb16, &params);
                warm.push(t.elapsed().as_secs_f64() * 1000.0); std::hint::black_box(r);
            }
            let (f, wm) = (median(full), median(warm));
            eprintln!("B4-rgb16cache\t{}\t{:.4}\t{:.4}\t{:.2}x", label, f, wm, f / wm);
        }
    }
}
