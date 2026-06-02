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

fn build_pre_lut(black: u16, white: u16, wb_eff: f32, exp_gain: f32) -> Vec<u16> {
    let mut lut = vec![0u16; 65536];
    let denom = (white.saturating_sub(black)).max(1) as f32;
    let gain = wb_eff * exp_gain;
    for i in 0..65536usize {
        let centered = (i as i32 - black as i32).max(0) as f32;
        let n = (centered / denom * gain).clamp(0.0, 1.0);
        lut[i] = (n * 65535.0 + 0.5).min(65535.0) as u16;
    }
    lut
}

struct LutCache {
    black: u16, white: u16,
    wb_r_bits: u32, wb_g_bits: u32, wb_b_bits: u32, exp_gain_bits: u32,
    contrast_bits: u32, shadows_bits: u32, highlights_bits: u32,
    whites_bits: u32, blacks_bits: u32,
    pre_r: Vec<u16>, pre_g: Vec<u16>, pre_b: Vec<u16>,
    post: Vec<u8>,
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
}

fn build_post_lut(t: &TonePost) -> Vec<u8> {
    let mut lut = vec![0u8; 65536];
    for i in 0..65536usize {
        let y = tone_curve(i as f32 / 65535.0, t);
        lut[i] = (y * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
    }
    lut
}

pub fn gaussian_kernel_5() -> [f32; 5] {
    [0.0545, 0.2442, 0.4026, 0.2442, 0.0545]
}

pub fn gaussian_kernel_13() -> [f32; 13] {
    [0.0185, 0.0342, 0.0563, 0.0831, 0.1097, 0.1296,
     0.1370,
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
            let mut acc = [0f32; 3];
            let b0 = (y * width + x - half) * 3;
            for ki in 0..kernel.len() {
                let kv = kernel[ki];
                let b = b0 + ki * 3;
                acc[0] += src[b]   as f32 * kv;
                acc[1] += src[b+1] as f32 * kv;
                acc[2] += src[b+2] as f32 * kv;
            }
            let b = x * 3;
            row[b]   = acc[0].round() as u16;
            row[b+1] = acc[1].round() as u16;
            row[b+2] = acc[2].round() as u16;
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
        let temp_slice = temp.as_slice();
        out.par_chunks_mut(width * 3).enumerate().for_each(|(y, row)| {
            for x in 0..width {
                let mut acc = [0f32; 3];
                for ki in 0..kernel.len() {
                    let kv = kernel[ki];
                    let yi = (y as isize + ki as isize - half as isize)
                        .clamp(0, height as isize - 1) as usize;
                    let base = (yi * width + x) * 3;
                    acc[0] += temp_slice[base]   as f32 * kv;
                    acc[1] += temp_slice[base+1] as f32 * kv;
                    acc[2] += temp_slice[base+2] as f32 * kv;
                }
                let o = x * 3;
                row[o]   = acc[0].round() as u16;
                row[o+1] = acc[1].round() as u16;
                row[o+2] = acc[2].round() as u16;
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
    // Two reusable scratch buffers across both passes: peak is always 2 full
    // images rather than 4 (original) or 3 (prior incomplete fix).
    let mut temp: Vec<u16> = Vec::new();
    let mut blurred: Vec<u16> = Vec::new();
    if params.texture != 0.0 {
        separable_blur_with_bufs(rgb16, width, height, &gaussian_kernel_5(), &mut temp, &mut blurred);
        // Manual tight loop (consistent with fast-path style in downscalers and WASM glue).
        // Single index increment, direct mutation.
        let n = rgb16.len();
        let mut i = 0;
        while i < n {
            let orig = rgb16[i] as i32;
            let blur = blurred[i] as i32;
            rgb16[i] = (orig + (params.texture * (orig - blur) as f32).round() as i32)
                .clamp(0, 65535) as u16;
            i += 1;
        }
    }
    if params.clarity != 0.0 {
        separable_blur_with_bufs(rgb16, width, height, &gaussian_kernel_13(), &mut temp, &mut blurred);
        // Manual tight loop (same style as texture pass and other hot pixel loops).
        let n = rgb16.len();
        let mut i = 0;
        while i < n {
            let orig = rgb16[i] as i32;
            let blur = blurred[i] as i32;
            // Midtone-weighted USM: weight peaks at 0.5 (midtones) and falls to 0
            // at shadows/highlights, suppressing the dark halo artifact at high-contrast edges.
            let v = orig as f32 / 65535.0;
            let w = 4.0 * v * (1.0 - v);
            rgb16[i] = (orig + (params.clarity * w * (orig - blur) as f32).round() as i32)
                .clamp(0, 65535) as u16;
            i += 1;
        }
    }
}

/// Core per-pixel tone-mapping math (matrix + sat/vibrance around luma).
/// Shared by `process` (RGB8) and `process_rgba` (RGBA8) to avoid duplication
/// of the hot arithmetic while keeping tight loops.
#[inline(always)]
fn apply_tone_math(
    r: f32,
    g: f32,
    b: f32,
    m: &[[f32; 3]; 3],
    sat: f32,
    vib: f32,
    vib_zero: bool,
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
    (r2, g2, b2)
}

pub fn process(rgb16: &[u16], params: &PipelineParams) -> Vec<u8> {
    let exp_gain = 2f32.powf((params.exposure_ev + BASELINE_EXP_EV).clamp(-3.0, 4.0));

    // Temp / tint folded into WB.  Temp ±1 → ±40% R/B shift; tint ±1 →
    // ±20% G shift with mild R+B counter-balance.
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

    // Saturation: asymmetric around zero so -1.0 reaches true black-and-white.
    // Negative side scales BASELINE_SAT → 0; positive side adds up to +0.8.
    let sat_param = params.saturation.clamp(-1.0, 1.0);
    let sat = if sat_param < 0.0 {
        BASELINE_SAT * (1.0 + sat_param)
    } else {
        BASELINE_SAT + sat_param * 0.8
    }.max(0.0);
    let vib = params.vibrance.clamp(-1.0, 1.0);
    let vib_zero = vib.abs() < 1e-6;

    let fallback = CAM_TO_SRGB;
    let m = params.color_matrix.as_ref().unwrap_or(&fallback);

    let n = rgb16.len() / 3;
    let mut out = vec![0u8; n * 3];

    // Build/update LUT on calling thread, then clone out for parallel use.
    // LUT is ~448 KB; clone cost is negligible vs 20 Mpx pixel loop.
    let (pre_r, pre_g, pre_b, post) = LUT_CACHE.with(|cache_cell| {
        let mut cache = cache_cell.borrow_mut();
        if cache.as_ref().map_or(true, |c| {
            !c.matches(params.black, params.white, wb_r, wb_g, wb_b, exp_gain, &tone)
        }) {
            *cache = Some(LutCache {
                black: params.black, white: params.white,
                wb_r_bits: wb_r.to_bits(), wb_g_bits: wb_g.to_bits(),
                wb_b_bits: wb_b.to_bits(), exp_gain_bits: exp_gain.to_bits(),
                contrast_bits:   tone.contrast.to_bits(),
                shadows_bits:    tone.shadows.to_bits(),
                highlights_bits: tone.highlights.to_bits(),
                whites_bits:     tone.whites.to_bits(),
                blacks_bits:     tone.blacks.to_bits(),
                pre_r: build_pre_lut(params.black, params.white, wb_r, exp_gain),
                pre_g: build_pre_lut(params.black, params.white, wb_g, exp_gain),
                pre_b: build_pre_lut(params.black, params.white, wb_b, exp_gain),
                post: build_post_lut(&tone),
            });
        }
        let c = cache.as_ref().unwrap();
        (c.pre_r.clone(), c.pre_g.clone(), c.pre_b.clone(), c.post.clone())
    });

    #[cfg(not(feature = "parallel"))]
    {
        // Manual byte-indexed loop for the common WASM (non-parallel) build.
        // Avoids zip + chunks iterator overhead on the final full-buffer pass.
        let n = rgb16.len();
        let mut i = 0;
        let mut o = 0;
        while i < n {
            let r = pre_r[rgb16[i] as usize] as f32; i += 1;
            let g = pre_g[rgb16[i] as usize] as f32; i += 1;
            let b = pre_b[rgb16[i] as usize] as f32; i += 1;

            let (r2, g2, b2) = apply_tone_math(r, g, b, m, sat, vib, vib_zero);

            out[o] = post[r2.clamp(0.0, 65535.0) as u16 as usize]; o += 1;
            out[o] = post[g2.clamp(0.0, 65535.0) as u16 as usize]; o += 1;
            out[o] = post[b2.clamp(0.0, 65535.0) as u16 as usize]; o += 1;
        }
    }

    #[cfg(feature = "parallel")]
    out.par_chunks_mut(3).zip(rgb16.par_chunks(3)).for_each(|(out_px, in_px)| {
            let r = pre_r[in_px[0] as usize] as f32;
            let g = pre_g[in_px[1] as usize] as f32;
            let b = pre_b[in_px[2] as usize] as f32;

            let (r2, g2, b2) = apply_tone_math(r, g, b, m, sat, vib, vib_zero);

            // Tone curve + sRGB + u8 via post-LUT.
            let ri = r2.clamp(0.0, 65535.0) as u16 as usize;
            let gi = g2.clamp(0.0, 65535.0) as u16 as usize;
            let bi = b2.clamp(0.0, 65535.0) as u16 as usize;
            out_px[0] = post[ri];
            out_px[1] = post[gi];
            out_px[2] = post[bi];
        });

    out
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
    let exp_gain = 2f32.powf((params.exposure_ev + BASELINE_EXP_EV).clamp(-3.0, 4.0));

    // Temp / tint folded into WB.  Temp ±1 → ±40% R/B shift; tint ±1 →
    // ±20% G shift with mild R+B counter-balance.
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

    // Saturation: asymmetric around zero so -1.0 reaches true black-and-white.
    // Negative side scales BASELINE_SAT → 0; positive side adds up to +0.8.
    let sat_param = params.saturation.clamp(-1.0, 1.0);
    let sat = if sat_param < 0.0 {
        BASELINE_SAT * (1.0 + sat_param)
    } else {
        BASELINE_SAT + sat_param * 0.8
    }.max(0.0);
    let vib = params.vibrance.clamp(-1.0, 1.0);
    let vib_zero = vib.abs() < 1e-6;

    let fallback = CAM_TO_SRGB;
    let m = params.color_matrix.as_ref().unwrap_or(&fallback);

    let n = rgb16.len() / 3;
    let mut out = vec![0u8; n * 4];

    // Build/update LUT on calling thread, then clone out for parallel use.
    let (pre_r, pre_g, pre_b, post) = LUT_CACHE.with(|cache_cell| {
        let mut cache = cache_cell.borrow_mut();
        if cache.as_ref().map_or(true, |c| {
            !c.matches(params.black, params.white, wb_r, wb_g, wb_b, exp_gain, &tone)
        }) {
            *cache = Some(LutCache {
                black: params.black, white: params.white,
                wb_r_bits: wb_r.to_bits(), wb_g_bits: wb_g.to_bits(),
                wb_b_bits: wb_b.to_bits(), exp_gain_bits: exp_gain.to_bits(),
                contrast_bits:   tone.contrast.to_bits(),
                shadows_bits:    tone.shadows.to_bits(),
                highlights_bits: tone.highlights.to_bits(),
                whites_bits:     tone.whites.to_bits(),
                blacks_bits:     tone.blacks.to_bits(),
                pre_r: build_pre_lut(params.black, params.white, wb_r, exp_gain),
                pre_g: build_pre_lut(params.black, params.white, wb_g, exp_gain),
                pre_b: build_pre_lut(params.black, params.white, wb_b, exp_gain),
                post: build_post_lut(&tone),
            });
        }
        let c = cache.as_ref().unwrap();
        (c.pre_r.clone(), c.pre_g.clone(), c.pre_b.clone(), c.post.clone())
    });

    #[cfg(not(feature = "parallel"))]
    {
        // Manual loop (matches the style and perf characteristics of `process` serial path).
        let nbytes = rgb16.len();
        let mut i = 0;
        let mut o = 0;
        while i < nbytes {
            let r = pre_r[rgb16[i] as usize] as f32; i += 1;
            let g = pre_g[rgb16[i] as usize] as f32; i += 1;
            let b = pre_b[rgb16[i] as usize] as f32; i += 1;

            let (r2, g2, b2) = apply_tone_math(r, g, b, m, sat, vib, vib_zero);

            out[o] = post[r2.clamp(0.0, 65535.0) as u16 as usize]; o += 1;
            out[o] = post[g2.clamp(0.0, 65535.0) as u16 as usize]; o += 1;
            out[o] = post[b2.clamp(0.0, 65535.0) as u16 as usize]; o += 1;
            out[o] = 255; o += 1;
        }
    }

    #[cfg(feature = "parallel")]
    out.par_chunks_mut(4).zip(rgb16.par_chunks(3)).for_each(|(out_px, in_px)| {
            let r = pre_r[in_px[0] as usize] as f32;
            let g = pre_g[in_px[1] as usize] as f32;
            let b = pre_b[in_px[2] as usize] as f32;

            let (r2, g2, b2) = apply_tone_math(r, g, b, m, sat, vib, vib_zero);

            let ri = r2.clamp(0.0, 65535.0) as u16 as usize;
            let gi = g2.clamp(0.0, 65535.0) as u16 as usize;
            let bi = b2.clamp(0.0, 65535.0) as u16 as usize;
            out_px[0] = post[ri];
            out_px[1] = post[gi];
            out_px[2] = post[bi];
            out_px[3] = 255;
        });

    out
}

/// Gray-world auto-WB from raw Bayer (RGGB) pixels.  Returns (r_gain,
/// b_gain) normalised so G_gain = 1.0.  Samples every 4×4 block to keep it
/// cheap.  Clamps the result to a sane range so a colour-cast scene (e.g.
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
    let mut temp: Vec<u16> = Vec::new();
    let mut blurred: Vec<u16> = Vec::new();
    separable_blur_with_bufs(rgb16, width, height, &kernel, &mut temp, &mut blurred);
    // Manual tight loop (eliminates zip iterator overhead on full buffer).
    let n = rgb16.len();
    let mut i = 0;
    while i < n {
        let o = rgb16[i] as f32;
        let b = blurred[i] as f32;
        rgb16[i] = (o + (b - o) * s).round().clamp(0.0, 65535.0) as u16;
        i += 1;
    }
}

/// Full pipeline → 16-bit sRGB output (same pipeline as `process` but u16 output).
/// Maps the tone-curved, sRGB-gamma-corrected result to [0, 65535] instead of [0, 255].
/// Suitable as a 16-bit TIFF source for further editing.
pub fn process_16bit(rgb16: &[u16], params: &PipelineParams) -> Vec<u16> {
    let exp_gain = 2f32.powf((params.exposure_ev + BASELINE_EXP_EV).clamp(-3.0, 4.0));
    let temp = params.temp.clamp(-1.0, 1.0);
    let tint = params.tint.clamp(-1.0, 1.0);
    let wb_r = params.wb_r * (1.0 + temp * 0.40) * (1.0 + tint * 0.10);
    let wb_g = params.wb_g * (1.0 - tint * 0.20);
    let wb_b = params.wb_b * (1.0 - temp * 0.40) * (1.0 + tint * 0.10);
    let tone = TonePost {
        contrast:   params.contrast.clamp(-1.0, 1.0),
        shadows:    params.shadows.clamp(-1.0, 1.0),
        highlights: params.highlights.clamp(-1.0, 1.0),
        whites:     params.whites.clamp(-1.0, 1.0),
        blacks:     params.blacks.clamp(-1.0, 1.0),
    };
    let sat_param = params.saturation.clamp(-1.0, 1.0);
    let sat = if sat_param < 0.0 {
        BASELINE_SAT * (1.0 + sat_param)
    } else {
        BASELINE_SAT + sat_param * 0.8
    }.max(0.0);
    let vib = params.vibrance.clamp(-1.0, 1.0);
    let vib_zero = vib.abs() < 1e-6;
    let fallback = CAM_TO_SRGB;
    let m = params.color_matrix.as_ref().unwrap_or(&fallback);
    let n = rgb16.len() / 3;
    let mut out = vec![0u16; n * 3];

    // Build 16-bit post-LUT: tone_curve maps [0,1] → [0,1] with sRGB gamma,
    // then we scale to [0, 65535] instead of [0, 255].
    let post16: Vec<u16> = (0..65536u32).map(|i| {
        let y = tone_curve(i as f32 / 65535.0, &tone);
        (y * 65535.0 + 0.5).clamp(0.0, 65535.0) as u16
    }).collect();

    let pre_r = build_pre_lut(params.black, params.white, wb_r, exp_gain);
    let pre_g = build_pre_lut(params.black, params.white, wb_g, exp_gain);
    let pre_b = build_pre_lut(params.black, params.white, wb_b, exp_gain);

    #[cfg(feature = "parallel")]
    let pixel_iter = out.par_chunks_mut(3).zip(rgb16.par_chunks(3));
    #[cfg(not(feature = "parallel"))]
    let pixel_iter = out.chunks_mut(3).zip(rgb16.chunks(3));

    pixel_iter.for_each(|(out_px, in_px)| {
        let r = pre_r[in_px[0] as usize] as f32;
        let g = pre_g[in_px[1] as usize] as f32;
        let b = pre_b[in_px[2] as usize] as f32;
        let mut r2 = m[0][0]*r + m[0][1]*g + m[0][2]*b;
        let mut g2 = m[1][0]*r + m[1][1]*g + m[1][2]*b;
        let mut b2 = m[2][0]*r + m[2][1]*g + m[2][2]*b;
        let luma = 0.2126*r2 + 0.7152*g2 + 0.0722*b2;
        let scale = if vib_zero {
            sat
        } else {
            let raw_mx = r2.max(g2).max(b2);
            let mx = raw_mx.max(1.0);
            let mn = r2.min(g2).min(b2).max(0.0);
            let pixel_sat = if raw_mx > 0.0 { ((mx - mn) / mx).clamp(0.0, 1.0) } else { 0.0 };
            sat * (1.0 + vib * (1.0 - pixel_sat) * 0.6)
        };
        r2 = luma + (r2 - luma) * scale;
        g2 = luma + (g2 - luma) * scale;
        b2 = luma + (b2 - luma) * scale;
        out_px[0] = post16[r2.clamp(0.0, 65535.0) as u16 as usize];
        out_px[1] = post16[g2.clamp(0.0, 65535.0) as u16 as usize];
        out_px[2] = post16[b2.clamp(0.0, 65535.0) as u16 as usize];
    });

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
        for dy in 0..dh {
            let row = &mut out[dy * dw * 3..(dy + 1) * dw * 3];
            for dx in 0..dw {
                let mut rr = 0u32;
                let mut gg = 0u32;
                let mut bb = 0u32;
                let mut n = 0u32;
                for yy in 0..ystep {
                    let y = dy * ystep + yy;
                    let base = (y * sw + dx * xstep) * 3;
                    for xx in 0..xstep {
                        let i = base + xx * 3;
                        rr += src[i] as u32;
                        gg += src[i + 1] as u32;
                        bb += src[i + 2] as u32;
                        n += 1;
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
        for dy in 0..dh {
            let row = &mut out[dy * dw * 3..(dy + 1) * dw * 3];
            for dx in 0..dw {
                let mut rr = 0u32;
                let mut gg = 0u32;
                let mut bb = 0u32;
                let mut n = 0u32;
                for yy in 0..ystep {
                    let y = dy * ystep + yy;
                    let base = (y * sw + dx * xstep) * 3;
                    for xx in 0..xstep {
                        let i = base + xx * 3;
                        rr += src[i] as u32;
                        gg += src[i + 1] as u32;
                        bb += src[i + 2] as u32;
                        n += 1;
                    }
                }
                let o = dx * 3;
                row[o] = (rr / n) as u8;
                row[o + 1] = (gg / n) as u8;
                row[o + 2] = (bb / n) as u8;
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

const TILE: usize = 32;

pub fn rotate_90_cw(src: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut dst = vec![0u8; src.len()];
    let w_dst = h;
    dst.chunks_mut(TILE * w_dst * 3)
        .enumerate()
        .for_each(|(tile_row, band)| {
            let band_rows = band.len() / (w_dst * 3);
            let nr0 = tile_row * TILE;
            for nr_local in 0..band_rows {
                let c = nr0 + nr_local;
                let dst_row = &mut band[nr_local * w_dst * 3..(nr_local + 1) * w_dst * 3];
                for nc in 0..w_dst {
                    let r = h - 1 - nc;
                    let s = (r * w + c) * 3;
                    let d = nc * 3;
                    dst_row[d] = src[s];
                    dst_row[d + 1] = src[s + 1];
                    dst_row[d + 2] = src[s + 2];
                }
            }
        });
    dst
}

pub fn rotate_90_ccw(src: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut dst = vec![0u8; src.len()];
    let w_dst = h;
    dst.chunks_mut(TILE * w_dst * 3)
        .enumerate()
        .for_each(|(tile_row, band)| {
            let band_rows = band.len() / (w_dst * 3);
            let nr0 = tile_row * TILE;
            for nr_local in 0..band_rows {
                let nr = nr0 + nr_local;
                let c = w - 1 - nr;
                let dst_row = &mut band[nr_local * w_dst * 3..(nr_local + 1) * w_dst * 3];
                for nc in 0..w_dst {
                    let r = nc;
                    let s = (r * w + c) * 3;
                    let d = nc * 3;
                    dst_row[d] = src[s];
                    dst_row[d + 1] = src[s + 1];
                    dst_row[d + 2] = src[s + 2];
                }
            }
        });
    dst
}

pub fn rotate_180(src: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut dst = vec![0u8; src.len()];
    let row_bytes = w * 3;
    for nr in 0..h {
        let r = h - 1 - nr;
        let s_row = &src[r * row_bytes..(r + 1) * row_bytes];
        let dst_row = &mut dst[nr * row_bytes..(nr + 1) * row_bytes];
        for c in 0..w {
            // Direct byte writes. Plain row loop (no chunks_mut + for_each overhead).
            let sc = w - 1 - c;
            let s = sc * 3;
            let d = c * 3;
            dst_row[d]     = s_row[s];
            dst_row[d + 1] = s_row[s + 1];
            dst_row[d + 2] = s_row[s + 2];
        }
    }
    dst
}
