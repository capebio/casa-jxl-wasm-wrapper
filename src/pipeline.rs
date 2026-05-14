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

pub struct PipelineParams {
    pub black: u16,
    pub white: u16,
    pub wb_r: f32,
    pub wb_g: f32,
    pub wb_b: f32,

    // All zero-centred:
    pub exposure_ev: f32,   // stops, -3..+3
    pub contrast: f32,      // -1..+1
    pub highlights: f32,    // -1..+1
    pub shadows: f32,       // -1..+1
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
            highlights: 0.0,
            shadows: 0.0,
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
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
}

/// LR-style per-channel tone curve: blacks/whites endpoint shifts,
/// shadows/highlights region gammas, contrast S-curve, baseline curve,
/// sRGB EOTF.  Input/output in [0,1] linear.
fn tone_curve(x: f32, p: &TonePost) -> f32 {
    let mut y = x;

    // Endpoint shifts.
    let blk_offset = p.blacks * 0.10;
    let wh_scale = 1.0 + p.whites * 0.20;
    y = (y - blk_offset) * wh_scale + blk_offset;
    y = y.clamp(0.0, 1.0);

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
    let c = (p.contrast + BASELINE_CONTRAST).clamp(-1.0, 1.0);
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
    for i in 0..65536u32 {
        let centered = (i as i32 - black as i32).max(0) as f32;
        let n = (centered / denom * gain).clamp(0.0, 1.0);
        lut[i as usize] = (n * 65535.0 + 0.5).min(65535.0) as u16;
    }
    lut
}

struct LutCache {
    black: u16, white: u16,
    wb_r_bits: u32, wb_g_bits: u32, wb_b_bits: u32, exp_gain_bits: u32,
    contrast_bits: u32, highlights_bits: u32, shadows_bits: u32,
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
            && self.highlights_bits == tone.highlights.to_bits()
            && self.shadows_bits    == tone.shadows.to_bits()
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
    for i in 0..65536u32 {
        let y = tone_curve(i as f32 / 65535.0, t);
        lut[i as usize] = (y * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
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

/// Horizontal pass of separable blur into `temp`.  Channel loop is inside
/// the kernel loop so LLVM can vectorize across the 3 channels together.
fn separable_blur_into(src: &[u16], width: usize, height: usize,
                       kernel: &[f32], temp: &mut [u16]) {
    let half = kernel.len() / 2;
    for y in 0..height {
        for x in 0..width {
            let mut acc = [0f32; 3];
            for (ki, &kv) in kernel.iter().enumerate() {
                let xi = (x as isize + ki as isize - half as isize)
                    .clamp(0, width as isize - 1) as usize;
                let base = (y * width + xi) * 3;
                acc[0] += src[base]     as f32 * kv;
                acc[1] += src[base + 1] as f32 * kv;
                acc[2] += src[base + 2] as f32 * kv;
            }
            let base = (y * width + x) * 3;
            temp[base]     = acc[0].round() as u16;
            temp[base + 1] = acc[1].round() as u16;
            temp[base + 2] = acc[2].round() as u16;
        }
    }
}

fn separable_blur_with_bufs(src: &[u16], width: usize, height: usize, kernel: &[f32],
                             temp: &mut Vec<u16>, out: &mut Vec<u16>) {
    let half = kernel.len() / 2;
    let n = width * height * 3;
    temp.resize(n, 0);
    out.resize(n, 0);
    separable_blur_into(src, width, height, kernel, temp);
    for y in 0..height {
        for x in 0..width {
            let mut acc = [0f32; 3];
            for (ki, &kv) in kernel.iter().enumerate() {
                let yi = (y as isize + ki as isize - half as isize)
                    .clamp(0, height as isize - 1) as usize;
                let base = (yi * width + x) * 3;
                acc[0] += temp[base]     as f32 * kv;
                acc[1] += temp[base + 1] as f32 * kv;
                acc[2] += temp[base + 2] as f32 * kv;
            }
            let base = (y * width + x) * 3;
            out[base]     = acc[0].round() as u16;
            out[base + 1] = acc[1].round() as u16;
            out[base + 2] = acc[2].round() as u16;
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
        for i in 0..rgb16.len() {
            let orig = rgb16[i] as i32;
            let blur = blurred[i] as i32;
            rgb16[i] = (orig + (params.texture * (orig - blur) as f32).round() as i32)
                .clamp(0, 65535) as u16;
        }
    }
    if params.clarity != 0.0 {
        separable_blur_with_bufs(rgb16, width, height, &gaussian_kernel_13(), &mut temp, &mut blurred);
        for i in 0..rgb16.len() {
            let orig = rgb16[i] as i32;
            let blur = blurred[i] as i32;
            // Midtone-weighted USM: weight peaks at 0.5 (midtones) and falls to 0
            // at shadows/highlights, suppressing the dark halo artifact at high-contrast edges.
            let v = orig as f32 / 65535.0;
            let w = 4.0 * v * (1.0 - v);
            rgb16[i] = (orig + (params.clarity * w * (orig - blur) as f32).round() as i32)
                .clamp(0, 65535) as u16;
        }
    }
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
        highlights: params.highlights.clamp(-1.0, 1.0),
        shadows: params.shadows.clamp(-1.0, 1.0),
        whites: params.whites.clamp(-1.0, 1.0),
        blacks: params.blacks.clamp(-1.0, 1.0),
    };

    // Saturation: baseline boost + user delta in [-0.8 .. +0.8] of unit scale.
    let sat = (BASELINE_SAT + params.saturation.clamp(-1.0, 1.0) * 0.8).max(0.0);
    let vib = params.vibrance.clamp(-1.0, 1.0);
    let vib_zero = vib.abs() < 1e-6;

    let fallback = CAM_TO_SRGB;
    let m = params.color_matrix.as_ref().unwrap_or(&fallback);

    let n = rgb16.len() / 3;
    let mut out = vec![0u8; n * 3];

    // LUT cache: rebuild only when params change.  Hot path: slider drag sends
    // the same LUT key repeatedly — avoids 4×65536-entry rebuild per frame.
    LUT_CACHE.with(|cache_cell| {
        let mut cache = cache_cell.borrow_mut();
        if cache.as_ref().map_or(true, |c| {
            !c.matches(params.black, params.white, wb_r, wb_g, wb_b, exp_gain, &tone)
        }) {
            *cache = Some(LutCache {
                black: params.black, white: params.white,
                wb_r_bits: wb_r.to_bits(), wb_g_bits: wb_g.to_bits(),
                wb_b_bits: wb_b.to_bits(), exp_gain_bits: exp_gain.to_bits(),
                contrast_bits:   tone.contrast.to_bits(),
                highlights_bits: tone.highlights.to_bits(),
                shadows_bits:    tone.shadows.to_bits(),
                whites_bits:     tone.whites.to_bits(),
                blacks_bits:     tone.blacks.to_bits(),
                pre_r: build_pre_lut(params.black, params.white, wb_r, exp_gain),
                pre_g: build_pre_lut(params.black, params.white, wb_g, exp_gain),
                pre_b: build_pre_lut(params.black, params.white, wb_b, exp_gain),
                post: build_post_lut(&tone),
            });
        }
        let c = cache.as_ref().unwrap();

        for px in 0..n {
            let r = c.pre_r[rgb16[px * 3]     as usize] as f32;
            let g = c.pre_g[rgb16[px * 3 + 1] as usize] as f32;
            let b = c.pre_b[rgb16[px * 3 + 2] as usize] as f32;

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

            // 3) Tone curve + sRGB + u8 via post-LUT.
            let ri = r2.clamp(0.0, 65535.0) as u16 as usize;
            let gi = g2.clamp(0.0, 65535.0) as u16 as usize;
            let bi = b2.clamp(0.0, 65535.0) as u16 as usize;
            out[px * 3]     = c.post[ri];
            out[px * 3 + 1] = c.post[gi];
            out[px * 3 + 2] = c.post[bi];
        }
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

/// Apply EXIF orientation tag to a packed RGB8 image.
///
/// Handles orientations 3 (180°), 6 (90° CW), 8 (90° CCW).
/// Orientations 1 (normal), 2, 4, 5, 7 are passed through as-is.
/// Mirror/transpose variants (2, 4, 5, 7) are rare in Olympus ORF and not implemented.
pub fn apply_orientation(
    rgb: &[u8],
    width: usize,
    height: usize,
    orientation: u16,
) -> (Vec<u8>, usize, usize) {
    match orientation {
        3 => (rotate_180(rgb, width, height), width, height),
        6 => (rotate_90_cw(rgb, width, height), height, width),
        8 => (rotate_90_ccw(rgb, width, height), height, width),
        _ => (rgb.to_vec(), width, height),
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
    dst.chunks_mut(row_bytes)
        .enumerate()
        .for_each(|(nr, dst_row)| {
            let r = h - 1 - nr;
            let s_row = &src[r * row_bytes..(r + 1) * row_bytes];
            for c in 0..w {
                let sc = w - 1 - c;
                dst_row[c * 3..c * 3 + 3].copy_from_slice(&s_row[sc * 3..sc * 3 + 3]);
            }
        });
    dst
}
