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

/// Always-applied baselines that emulate Olympus Picture-Mode (Natural).
/// Without these, raw matrix output looks "flat" relative to the embedded
/// JPEG.  User look sliders adjust on top.
const BASELINE_SAT: f32 = 1.30;        // chroma scale around luma — tuned to embedded JPEG saturation
const BASELINE_CONTRAST: f32 = 0.55;   // S-curve blend, [0,1] — tuned to embedded JPEG luma std-dev
const BASELINE_EXP_EV: f32 = 1.40;     // tuned to embedded JPEG luminance

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
        1.055 * v.powf(1.0 / 2.4) - 0.055
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
    let blk_offset = p.blacks * 0.10;
    let wh_scale = 1.0 + p.whites * 0.20;
    y = (y * wh_scale + blk_offset).clamp(0.0, 1.0);

    // Shadows: gamma in lower region.
    if p.shadows.abs() > 1e-4 {
        let mask = 1.0 - smoothstep(0.0, 0.6, y);
        let gamma = 1.0 / (1.0 + p.shadows * 0.7);
        let lifted = y.powf(gamma);
        y = y * (1.0 - mask) + lifted * mask;
    }
    // Highlights: gamma in upper region.
    if p.highlights.abs() > 1e-4 {
        let mask = smoothstep(0.4, 1.0, y);
        let inv = 1.0 - y;
        let gamma = 1.0 / (1.0 - p.highlights * 0.7).max(0.05);
        let pulled = 1.0 - inv.powf(gamma);
        y = y * (1.0 - mask) + pulled * mask;
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
        y = y * (1.0 - c) + s * c;
    } else if c < -1e-4 {
        // De-contrast: pull toward linear ramp away from pivot.
        let signed = if y < 0.5 { -1.0 } else { 1.0 };
        let inv_s = 0.5 + signed * (0.5 - y).abs().sqrt() * 0.5;
        y = y * (1.0 + c) + inv_s * (-c);
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
        HIGHLIGHT_KNEE + range * (s / (s + range))
    }
}

fn build_pre_lut(black: u16, white: u16, wb_eff: f32, exp_gain: f32) -> Vec<u16> {
    let mut lut = vec![0u16; 65536];
    let denom = (white.saturating_sub(black)).max(1) as f32;
    let gain = wb_eff * exp_gain;
    // T1: per-index work is independent; parallelize. Matters most for small/thumbnail renders where
    // the fixed 65536-entry build is a large fraction of (or exceeds) the per-pixel pass.
    let fill = |i: usize, o: &mut u16| {
        let centered = (i as i32 - black as i32).max(0) as f32;
        let n = highlight_shoulder(centered / denom * gain);
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
}

fn build_post_lut(t: &TonePost) -> Vec<u8> {
    let mut lut = vec![0u8; 65536];
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
#[inline(always)]
fn apply_tone_math(
    r: f32,
    g: f32,
    b: f32,
    m: &[[f32; 3]; 3],
    sat: f32,
    vib: f32,
    vib_zero: bool,
    perceptual_constancy: bool,
) -> (f32, f32, f32) {
    // 1) Matrix.
    let mut r2 = m[0][0] * r + m[0][1] * g + m[0][2] * b;
    let mut g2 = m[1][0] * r + m[1][1] * g + m[1][2] * b;
    let mut b2 = m[2][0] * r + m[2][1] * g + m[2][2] * b;

    // 2) Saturation + vibrance around luma.
    let luma = 0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2;
    let scale = if vib_zero {
        sat
    } else {
        let raw_mx = r2.max(g2).max(b2);
        let mx = raw_mx.max(1.0);
        let mn = r2.min(g2).min(b2).max(0.0);
        let pixel_sat = if raw_mx > 0.0 { ((mx - mn) / mx).clamp(0.0, 1.0) } else { 0.0 };
        let vib_w = 1.0 - pixel_sat;
        sat * (1.0 + vib * vib_w * 0.6)
    };
    r2 = luma + (r2 - luma) * scale;
    g2 = luma + (g2 - luma) * scale;
    b2 = luma + (b2 - luma) * scale;

    if perceptual_constancy {
        // Runtime-only advanced path (LookRenderer during progressive JXL paints).
        // Basic log-space approximation to geodesic sat adjustment as foundation
        // for full sensor-sharpen + log geodesics + Molchanov A_tensor modulation
        // + hybrid spring + diminishing returns f(c). This is the single site for
        // future evolution of the per-pixel math.
        // (Reassessed positive: enables the documented vision with minimal surface
        // change; stub keeps numbers reasonable for new mode; no P-1 violation.)
        let eps = 1e-6f32;
        let lr = (r2.max(eps)).ln();
        let lg = (g2.max(eps)).ln();
        let lb = (b2.max(eps)).ln();
        let luma_l = (lr + lg + lb) / 3.0;
        // Stub scale using existing sat/vib logic; real version will use tensor
        // for uniform perceptual steps and residuals for adaptive correction.
        let scale_l = if vib_zero { sat } else { sat * (1.0 + vib * 0.6) };
        let lr2 = luma_l + (lr - luma_l) * scale_l;
        let lg2 = luma_l + (lg - luma_l) * scale_l;
        let lb2 = luma_l + (lb - luma_l) * scale_l;
        r2 = (lr2.exp() - eps).max(0.0);
        g2 = (lg2.exp() - eps).max(0.0);
        b2 = (lb2.exp() - eps).max(0.0);
        // TODO (Layer 2/3): integrate full B matrix here or upstream, precomputed
        // metric tensor grid lookup, Molchanov parallelogram residuals for density,
        // A_tensor modulation of scale, ΔE2000 spring, Los Alamos f(c) per-hue.
        // LUT acceleration to follow for sub-ms.
        //
        // Hook example for C++ port (Lens25):
        // extern "C" { fn apply_perceptual_constancy_c(r: f32, g: f32, b: f32, scale: f32, /* B, A_tensor, f_c etc */ ) -> (f32,f32,f32); }
        // let (r2, g2, b2) = unsafe { apply_perceptual_constancy_c(r2, g2, b2, scale_l, ...) };
    }

    (r2, g2, b2)
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
    let sat = if sat_param < 0.0 {
        BASELINE_SAT * (1.0 + sat_param)
    } else {
        BASELINE_SAT + sat_param * 0.8
    }.max(0.0);
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

            // Lens 22/23: pointer move (raw ptr advance) instead of index arithmetic + casts.
            // "Newer" optimized version; old index version for flipflop comparison in tests.
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
    assert_eq!(out.len(), dw * dh * 3);

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
    assert_eq!(out.len(), dw * dh * 3);

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

        println!("\n=== Flip-flop tonemap (Lens22/23/25): apply_tone_math new (perceptual=true) vs old (false) x10 ===");
        for i in 0..10 {
            let use_new = i % 2 == 0;
            let mut params = base_params.clone();
            params.perceptual_constancy = use_new;
            // warm
            let _ = process(&buf, &params);
            let t0 = Instant::now();
            for _ in 0..5 { let _ = process(&buf, &params); } // inner iters for stable timing
            let ms = (t0.elapsed().as_secs_f64() / 5.0) * 1000.0;
            println!("tone flip {}: {:.3} ms (new/perceptual={})", i, ms, use_new);
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
        for i in 0..65536usize {
            let centered = (i as i32 - black as i32).max(0) as f32;
            let n = highlight_shoulder(centered / denom * gain);
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
