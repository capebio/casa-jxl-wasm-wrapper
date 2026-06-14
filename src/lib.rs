//! Browser entry point for the Olympus ORF → RGB pipeline.
//!
//! Exports `process_orf(bytes)` which parses an ORF blob, decompresses the
//! 12-bit predictive stream, demosaics RGGB → RGB, applies WB/sRGB tone curve
//! and EXIF orientation, returning an interleaved RGB8 buffer plus dims.
//!
//! Encoding (JXL / WebP) is left to JS via jSquash — keeps the wasm small.
//! Stages use rayon (when built with `parallel-wasm` feature + initThreadPool()
//! called). Requires COOP/COEP (already needed for libjxl MT).

use raw_pipeline::decompress;
use raw_pipeline::demosaic;
use raw_pipeline::pipeline;
use raw_pipeline::tiff;

use wasm_bindgen::prelude::*;

// A2: expose rayon thread-pool init to JS when built with --features parallel-wasm
#[cfg(feature = "parallel-wasm")]
pub use wasm_bindgen_rayon::init_thread_pool;

// === Lens 22 demosaic SIMD flip-flop (bench-only; driven by tools/demosaic-flipflop.mjs) ===
// Times are taken in the JS host (wasm32-unknown-unknown has no wall clock); these exports just
// run one demosaic and return a cheap checksum so wasm-bindgen marshalling is constant.
use std::cell::RefCell;
thread_local! {
    static DEMO_BENCH: RefCell<(Vec<u16>, usize, usize)> = const { RefCell::new((Vec::new(), 0, 0)) };
}
fn demo_checksum(v: &[u16]) -> u32 {
    v.iter().fold(0u32, |a, &x| a.wrapping_mul(31).wrapping_add(x as u32))
}
#[wasm_bindgen]
pub fn demosaic_bench_prepare(w: usize, h: usize) {
    let raw: Vec<u16> = (0..w * h).map(|i| (i.wrapping_mul(2654435761) & 0x3fff) as u16).collect();
    DEMO_BENCH.with(|b| *b.borrow_mut() = (raw, w, h));
}
#[wasm_bindgen]
pub fn demosaic_bench_scalar() -> u32 {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        demo_checksum(&demosaic::demosaic_rggb(&g.0, g.1, g.2).unwrap())
    })
}
#[wasm_bindgen]
pub fn demosaic_bench_simd() -> u32 {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        demo_checksum(&demosaic::demosaic_rggb_simd(&g.0, g.1, g.2).unwrap())
    })
}
#[wasm_bindgen]
pub fn demosaic_bench_equal() -> bool {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        demosaic::demosaic_rggb(&g.0, g.1, g.2).unwrap() == demosaic::demosaic_rggb_simd(&g.0, g.1, g.2).unwrap()
    })
}
#[wasm_bindgen]
pub fn demosaic_bench_first_diff() -> i32 {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        let a = demosaic::demosaic_rggb(&g.0, g.1, g.2).unwrap();
        let s = demosaic::demosaic_rggb_simd(&g.0, g.1, g.2).unwrap();
        for i in 0..a.len() {
            if a[i] != s[i] { return i as i32; }
        }
        -1
    })
}

fn demo_checksum3(r: &[u16], g: &[u16], b: &[u16]) -> u32 {
    let mut c = demo_checksum(r);
    c = c.wrapping_mul(31).wrapping_add(demo_checksum(g));
    c = c.wrapping_mul(31).wrapping_add(demo_checksum(b));
    c
}

#[wasm_bindgen]
pub fn demosaic_bench_planar_scalar() -> u32 {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        let (r, gp, bp) = demosaic::demosaic_rggb_planar(&g.0, g.1, g.2).unwrap();
        demo_checksum3(&r, &gp, &bp)
    })
}

#[wasm_bindgen]
pub fn demosaic_bench_planar_simd() -> u32 {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        let (r, gp, bp) = demosaic::demosaic_rggb_planar_simd(&g.0, g.1, g.2).unwrap();
        demo_checksum3(&r, &gp, &bp)
    })
}

#[wasm_bindgen]
pub fn demosaic_bench_planar_equal() -> bool {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        demosaic::demosaic_rggb_planar(&g.0, g.1, g.2).unwrap()
            == demosaic::demosaic_rggb_planar_simd(&g.0, g.1, g.2).unwrap()
    })
}

#[wasm_bindgen]
pub fn demosaic_bench_planar_first_diff() -> i32 {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        let (ra, ga, ba) = demosaic::demosaic_rggb_planar(&g.0, g.1, g.2).unwrap();
        let (rs, gs, bs) = demosaic::demosaic_rggb_planar_simd(&g.0, g.1, g.2).unwrap();
        let n = ra.len();
        for i in 0..n {
            if ra[i] != rs[i] { return i as i32; }
            if ga[i] != gs[i] { return (n + i) as i32; }
            if ba[i] != bs[i] { return (2 * n + i) as i32; }
        }
        -1
    })
}

#[wasm_bindgen]
pub fn demosaic_bench_shuffle_simd() -> u32 {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        demo_checksum(&demosaic::demosaic_rggb_shuffle_simd(&g.0, g.1, g.2).unwrap())
    })
}

#[wasm_bindgen]
pub fn demosaic_bench_shuffle_equal() -> bool {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        demosaic::demosaic_rggb(&g.0, g.1, g.2).unwrap()
            == demosaic::demosaic_rggb_shuffle_simd(&g.0, g.1, g.2).unwrap()
    })
}

#[wasm_bindgen]
pub fn demosaic_bench_shuffle_first_diff() -> i32 {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        let a = demosaic::demosaic_rggb(&g.0, g.1, g.2).unwrap();
        let s = demosaic::demosaic_rggb_shuffle_simd(&g.0, g.1, g.2).unwrap();
        for i in 0..a.len() {
            if a[i] != s[i] { return i as i32; }
        }
        -1
    })
}

/// Result of processing an ORF: RGB8 buffer + dims (post-orientation).
#[wasm_bindgen]
pub struct ProcessResult {
    rgb: Vec<u8>,
    #[wasm_bindgen(readonly)]
    pub width: u32,
    #[wasm_bindgen(readonly)]
    pub height: u32,
    #[wasm_bindgen(readonly)]
    pub orientation: u16,
    #[wasm_bindgen(readonly)]
    pub decompress_ms: f64,
    #[wasm_bindgen(readonly)]
    pub demosaic_ms: f64,
    #[wasm_bindgen(readonly)]
    pub tonemap_ms: f64,
    #[wasm_bindgen(readonly)]
    pub orient_ms: f64,
    #[wasm_bindgen(readonly)]
    pub preview_demosaic_ms: f64,  // fast planar bilinear demosaic for lb/thumb previews
    #[wasm_bindgen(readonly)]
    pub preview_downscale_ms: f64,  // planar downscales for previews (lb + thumb)
    #[wasm_bindgen(readonly)]
    pub fast_preview: bool,  // true if fast planar bilinear + planar down was used for lb/thumb (vs full mhc path)
    #[wasm_bindgen(readonly)]
    pub wb_r_used: f32,
    #[wasm_bindgen(readonly)]
    pub wb_b_used: f32,
    #[wasm_bindgen(readonly)]
    pub color_matrix_from_mn: bool,
    make: String,
    model: String,
    rgb16_lb: Vec<u8>,
    #[wasm_bindgen(readonly)]
    pub lb_w: u32,
    #[wasm_bindgen(readonly)]
    pub lb_h: u32,
    rgb16_thumb: Vec<u8>,
    #[wasm_bindgen(readonly)]
    pub thumb_w: u32,
    #[wasm_bindgen(readonly)]
    pub thumb_h: u32,
    // M3: full master-size 16-bit (packed LE u16, 6 bytes/pixel) for pyramid big levels + 16-bit lightbox path.
    // Only populated when OUT_FULL_16 requested (memory opt; current callers that pass 7 stay 8-bit + lb/thumb only).
    rgb16_full: Vec<u8>,
    #[wasm_bindgen(readonly)]
    pub full16_w: u32,
    #[wasm_bindgen(readonly)]
    pub full16_h: u32,
    color_matrix_flat: [f32; 9],
    // EXIF / metadata exposed for the lightbox info panel.
    lens: String,
    datetime: String,
    #[wasm_bindgen(readonly)]
    pub exposure_num: u32,
    #[wasm_bindgen(readonly)]
    pub exposure_den: u32,
    #[wasm_bindgen(readonly)]
    pub fnumber_num: u32,
    #[wasm_bindgen(readonly)]
    pub fnumber_den: u32,
    #[wasm_bindgen(readonly)]
    pub iso: u32,
    #[wasm_bindgen(readonly)]
    pub focal_length_num: u32,
    #[wasm_bindgen(readonly)]
    pub focal_length_den: u32,
    #[wasm_bindgen(readonly)]
    pub focal_length_35: u16,
    #[wasm_bindgen(readonly)]
    pub gps_lat: f64,
    #[wasm_bindgen(readonly)]
    pub gps_lon: f64,
    #[wasm_bindgen(readonly)]
    pub gps_alt: f64,
    #[wasm_bindgen(readonly)]
    pub has_gps: bool,
    #[wasm_bindgen(readonly)]
    pub quality: u16,
    // 0xFFFF = absent/unknown (mirrors has_gps pattern using explicit bool for GPS)
    #[wasm_bindgen(readonly)]
    pub wb_mode: u16,
    #[wasm_bindgen(readonly)]
    pub wb_from_camera: bool,
}

#[wasm_bindgen]
impl ProcessResult {
    #[wasm_bindgen(getter)]
    pub fn make(&self) -> String {
        self.make.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn model(&self) -> String {
        self.model.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn lens(&self) -> String {
        self.lens.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn datetime(&self) -> String {
        self.datetime.clone()
    }
}

#[wasm_bindgen]
impl ProcessResult {
    /// Move the RGB buffer out as a `Uint8Array`.  Caller owns the bytes.
    // wasm-bindgen copies Vec<u8> into a JS-owned Uint8Array via
    // getUint8Memory0().slice() before returning, so the Uint8Array remains
    // valid even after the caller calls result.free().
    // Returns empty on subsequent calls (ownership transferred).
    pub fn take_rgb(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rgb)
    }

    /// Borrow the RGB buffer; copies into a fresh JS `Uint8Array`.
    pub fn rgb(&self) -> Vec<u8> {
        self.rgb.clone()
    }

    /// Move the lightbox-sized packed u16 LE buffer out.  Caller owns the bytes.
    // Same copy semantics as take_rgb — safe to use after result.free().
    pub fn take_rgb16_lb(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rgb16_lb)
    }

    /// Move the thumb-sized packed u16 LE buffer out.  Caller owns the bytes.
    // Transfers ownership; returns empty Vec<u8> on subsequent calls.
    pub fn take_rgb16_thumb(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rgb16_thumb)
    }

    /// Move the full-resolution packed u16 LE buffer out (M3 16-bit path). Caller owns the bytes.
    /// Packed 6 bytes per pixel LE (r g b u16). Only non-empty if OUT_FULL_16 was requested.
    pub fn take_rgb16_full(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rgb16_full)
    }

    /// Move the RGBA8 buffer out. Caller owns the bytes.
    /// Performs RGB→RGBA conversion inside WASM using the same tight loop as the
    /// JS-facing rgb_to_rgba, then transfers ownership. This still avoids the
    /// JS-side 3x buffer allocation that the old take_rgb + rgb_to_rgba pattern
    /// required for "encode only" paths.
    pub fn take_rgba(&mut self) -> Vec<u8> {
        rgb_to_rgba(&std::mem::take(&mut self.rgb))
    }

    /// Borrow the RGBA8 buffer (copies).
    pub fn rgba(&self) -> Vec<u8> {
        rgb_to_rgba(&self.rgb)
    }

    /// Return the color matrix used (9 floats, row-major).
    pub fn color_matrix_used(&self) -> Vec<f32> {
        self.color_matrix_flat.to_vec()
    }
}

fn now_ms() -> f64 {
    thread_local! {
        static PERF: std::cell::OnceCell<web_sys::Performance> = const { std::cell::OnceCell::new() };
    }
    PERF.with(|cell| {
        if let Some(perf) = cell.get() {
            return perf.now();
        }
        let perf = web_sys::window()
            .and_then(|w| w.performance())
            .or_else(|| {
                js_sys::global()
                    .dyn_into::<web_sys::WorkerGlobalScope>()
                    .ok()
                    .and_then(|w| w.performance())
            });
        if let Some(perf) = perf {
            let now = perf.now();
            let _ = cell.set(perf);
            now
        } else {
            js_sys::Date::now()
        }
    })
}

#[inline(always)]
fn write_rgb16_le(out: &mut [u8], o: usize, r: u16, g: u16, b: u16) {
    // Manual LE writes — eliminates three small copy_from_slice(2) per pixel in the
    // general (non-integer) downscale fallback path.
    out[o]     = (r & 0xff) as u8;
    out[o + 1] = (r >> 8) as u8;
    out[o + 2] = (g & 0xff) as u8;
    out[o + 3] = (g >> 8) as u8;
    out[o + 4] = (b & 0xff) as u8;
    out[o + 5] = (b >> 8) as u8;
}

/// Pack full-res rgb16 (Vec<u16>, 3 per pixel) to the packed LE 6-byte form used by take_*16.
#[inline]
fn pack_rgb16_full(src: &[u16], w: usize, h: usize) -> Vec<u8> {
    let mut out = vec![0u8; w * h * 6];
    for i in 0..(w * h) {
        let o = i * 6;
        let r = src[i * 3];
        let g = src[i * 3 + 1];
        let b = src[i * 3 + 2];
        write_rgb16_le(&mut out, o, r, g, b);
    }
    out
}

fn downscale_rgb_float_path<F>(
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
    out: &mut Vec<u8>,
    read_pixel: F,
) where
    F: Fn(usize) -> (u32, u32, u32),
{
    // Integer fast path (same principle as the public downscalers).
    // Even if callers usually guard, this makes the helper itself robust.
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let pixel_count = (xstep * ystep) as u32;
        for dy in 0..dh {
            for dx in 0..dw {
                let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
                let x_base = dx * xstep;
                let mut row_base = dy * ystep * sw;
                for _yy in 0..ystep {
                    let mut idx = row_base + x_base;
                    for _xx in 0..xstep {
                        let (r, g, b) = read_pixel(idx);
                        rr += r; gg += g; bb += b;
                        idx += 1;
                    }
                    row_base += sw;
                }
                let o = (dy * dw + dx) * 6;
                write_rgb16_le(out, o, (rr / pixel_count) as u16, (gg / pixel_count) as u16, (bb / pixel_count) as u16);
            }
        }
        return;
    }

    let xr = sw as f32 / dw as f32;
    let yr = sh as f32 / dh as f32;
    let mut o = 0usize;
    for dy in 0..dh {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = ((dy as f32 + 1.0) * yr).min(sh as f32) as usize;
        let y1 = y1.max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = ((dx as f32 + 1.0) * xr).min(sw as f32) as usize;
            let x1 = x1.max(x0 + 1);
            let n = ((y1 - y0) * (x1 - x0)).max(1) as u32;
            let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
            let mut row_base = y0 * sw;
            for _y in y0..y1 {
                for x in x0..x1 {
                    let (r, g, b) = read_pixel(row_base + x);
                    rr += r;
                    gg += g;
                    bb += b;
                }
                row_base += sw;
            }
            write_rgb16_le(out, o, (rr / n) as u16, (gg / n) as u16, (bb / n) as u16);
            o += 6;
        }
    }
}

#[allow(clippy::too_many_arguments)]
/// Box-filter downscale an RGB16 (u16) buffer, outputting packed u16 LE bytes
/// (6 bytes per pixel).  Used to cache a lightbox-sized buffer for live re-render.
///
/// Fast path for integer factors (benefits lb/thumb generation for all RAW formats).
fn downscale_rgb16_impl(src: &[u16], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    let mut out = vec![0u8; dw * dh * 6];

    // Integer fast path for common exact factors (same win as the RGB8/RGBA8 versions).
    // Benefits every lightbox + thumb generation for RAW images.
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let pixel_count = (xstep * ystep) as u32;
        let mut o = 0usize;
        for dy in 0..dh {
            for dx in 0..dw {
                let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
                let x_base = dx * xstep;
                let mut row_base = dy * ystep * sw;
                for _yy in 0..ystep {
                    let mut i = (row_base + x_base) * 3;
                    for _xx in 0..xstep {
                        rr += src[i] as u32;
                        gg += src[i + 1] as u32;
                        bb += src[i + 2] as u32;
                        i += 3;
                    }
                    row_base += sw;
                }
                write_rgb16_le(&mut out, o, (rr / pixel_count) as u16, (gg / pixel_count) as u16, (bb / pixel_count) as u16);
                o += 6;
            }
        }
        return out;
    }

    downscale_rgb_float_path(sw, sh, dw, dh, &mut out, |idx| {
        let i = idx * 3;
        (src[i] as u32, src[i + 1] as u32, src[i + 2] as u32)
    });
    out
}

/// Box-filter downscale directly from the packed LE u8 form (6 bytes/pixel)
/// produced by downscale_rgb16_impl. Avoids a full unpack to Vec<u16> when
/// generating the 360 px thumb from the 1800 px lightbox buffer.
///
/// Also has the integer fast path for common exact scale factors.
fn downscale_packed_rgb16_le(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    let mut out = vec![0u8; dw * dh * 6];

    // Integer fast path for the packed format too (e.g. 1800→360 thumb from lb is exact 5x).
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let pixel_count = (xstep * ystep) as u32;
        let sw6 = sw * 6;
        let mut o = 0usize;
        for dy in 0..dh {
            for dx in 0..dw {
                let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
                let x_base = dx * xstep;
                let mut row_base = dy * ystep * sw6;
                for _yy in 0..ystep {
                    let mut i = row_base + x_base * 6;
                    for _xx in 0..xstep {
                        let r = u16::from_le_bytes([src[i], src[i + 1]]) as u32;
                        let g = u16::from_le_bytes([src[i + 2], src[i + 3]]) as u32;
                        let b = u16::from_le_bytes([src[i + 4], src[i + 5]]) as u32;
                        rr += r;
                        gg += g;
                        bb += b;
                        i += 6;
                    }
                    row_base += sw6;
                }
                write_rgb16_le(&mut out, o, (rr / pixel_count) as u16, (gg / pixel_count) as u16, (bb / pixel_count) as u16);
                o += 6;
            }
        }
        return out;
    }

    downscale_rgb_float_path(sw, sh, dw, dh, &mut out, |idx| {
        let i = idx * 6;
        let r = u16::from_le_bytes([src[i], src[i + 1]]) as u32;
        let g = u16::from_le_bytes([src[i + 2], src[i + 3]]) as u32;
        let b = u16::from_le_bytes([src[i + 4], src[i + 5]]) as u32;
        (r, g, b)
    });
    out
}

fn unpack_rgb16_le(src: &[u8]) -> Vec<u16> {
    // Manual loop for consistency with other hot conversion paths (rgb_to_rgba etc.).
    // Slightly better codegen / less iterator overhead than chunks_exact+map+collect.
    let n = src.len() / 2;
    let mut out = Vec::with_capacity(n);
    let mut i = 0;
    while i < src.len() {
        out.push(u16::from_le_bytes([src[i], src[i + 1]]));
        i += 2;
    }
    out
}

#[inline(always)]
fn target_dims(w: usize, h: usize, long_edge: usize) -> (usize, usize) {
    if w >= h {
        let lw = w.min(long_edge);
        (lw, ((h * lw) / w).max(1))
    } else {
        let lh = h.min(long_edge);
        (((w * lh) / h).max(1), lh)
    }
}

// Output flag bits for process_orf_with_flags.
const OUT_FULL_RGB8: u32 = 1; // full-resolution RGB8 for JXL encoding
const OUT_LIGHTBOX: u32 = 2; // 1800 px RGB16 for LookRenderer
const OUT_THUMB: u32 = 4; // 360 px RGB16 for thumb LookRenderer
const OUT_FULL_16: u32 = 8; // full-resolution RGB16 (M3: RAW {2048,full} pyramid levels; 16-bit lightbox/ROI/export). Grid levels and JPG stay 8-bit.
// Skip apply_orientation on the OUT_FULL_RGB8 output. Pixels and width/height
// stay in sensor orientation; consumer reads `orientation` to know how to display
// (or to pass to JXL encoder via basic info). Saves the 60–200 MB intermediate
// rotate when feeding the encoder (JXL stores orientation as metadata).
const OUT_NO_ORIENT: u32 = 8;

struct LookOverrides {
    wb_r: f32,
    wb_b: f32,
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
}

struct OrfDecoded {
    rgb16: Vec<u16>,
    w: usize,
    h: usize,
    info: tiff::OrfInfo,
    decompress_ms: f64,
    demosaic_ms: f64,
    wb_from_camera: bool,
    params: pipeline::PipelineParams,
    color_matrix_from_mn: bool,
    color_matrix_flat: [f32; 9],
    // Hypercar: precomputed fast planar bilinear + planar down for lb/thumb (cheap SIMD path, no mhc cost for preview).
    // Packed LE u8 6B/px. Avoids full-res interleaved materialization for common preview paths.
    lb_packed: Vec<u8>,
    lb_w: usize,
    lb_h: usize,
    thumb_packed: Vec<u8>,
    thumb_w: usize,
    thumb_h: usize,
    preview_demosaic_ms: f64,  // fast planar bilinear demosaic for previews
    preview_downscale_ms: f64,  // planar downscales for lb + thumb previews
    fast_preview: bool,  // fast planar path used for previews
}

/// Shared ORF decode path: parse → validate → decompress → demosaic → NR → WB/matrix setup.
/// Returns pre-tonemapped RGB16 and all metadata.  Called by process_orf_impl.
fn decode_orf_raw(data: &[u8]) -> Result<OrfDecoded, JsError> {
    let info = tiff::parse(data).map_err(|e| JsError::new(&e))?;

    if info.compression != 1 {
        return Err(JsError::new(&format!(
            "compression {} not supported (expected Olympus 12-bit, comp=1)",
            info.compression
        )));
    }

    validate_orf_structure(data, &info)?;

    let w = info.width as usize;
    let h = info.height as usize;
    // strip bounds already validated by validate_orf_structure above
    let strip_end = info.strip_offset as usize + info.strip_byte_count as usize;
    let strip = &data[info.strip_offset as usize..strip_end];

    let t = now_ms();
    let raw = decompress::decompress(strip, w, h).map_err(|e| JsError::new(&e))?;
    let decompress_ms = now_ms() - t;

    // Hypercar fast path for previews (OUT_LIGHTBOX/THUMB): always use planar bilinear SIMD demosaic + planar downscale.
    // Cheap (SIMD planar store win), no mhc cost for common gallery/lb paths. mhc only for full quality tone when OUT_FULL_RGB8.
    let (lb_w, lb_h) = target_dims(w, h, 1800);
    let (thumb_w, thumb_h) = target_dims(w, h, 360);
    let t_dem = now_ms();
    let (pr, pg, pb) = demosaic::demosaic_rggb_planar(&raw, w, h).map_err(|e| JsError::new(&e))?;
    let preview_demosaic_ms = now_ms() - t_dem;  // just the fast planar bilinear demosaic
    let t_down = now_ms();
    let lb_packed = downscale_rgb16_planar(&pr, &pg, &pb, w, h, lb_w, lb_h);
    let thumb_packed = downscale_rgb16_planar(&pr, &pg, &pb, w, h, thumb_w, thumb_h);
    let preview_downscale_ms = now_ms() - t_down;  // the two planar downs for previews (lb + thumb)
    let fast_preview = true;  // we always compute and use the fast planar path for previews now

    let mut params = pipeline::PipelineParams::default_olympus();
    // Trust camera WB_RBLevels (ImageProcessing 0x0100 / MakerNote 0x1017/1018/1029)
    // unconditionally.  This is the calibration the in-camera JPEG uses, so
    // matching it gives colour fidelity to the embedded preview.  Gray-world
    // fallback only when the camera didn't store WB at all (very rare).
    //
    // Earlier versions discarded camera WB for "manual" modes 16..=67 (presets)
    // and 256..=259 / 512..=515 (One-Touch / Custom) — but those modes still
    // store the correct per-shot WB and discarding them produced washed-out,
    // colour-cast output vs. the embedded JPEG.
    let wb_from_camera = info.wb_r.is_some() && info.wb_b.is_some();
    if wb_from_camera {
        if let Some(r) = info.wb_r {
            params.wb_r = r;
        }
        if let Some(b) = info.wb_b {
            params.wb_b = b;
        }
    } else {
        let (ar, ab) = pipeline::auto_wb_rggb(&raw, w, h, params.black);
        params.wb_r = ar;
        params.wb_b = ab;
    }
    let color_matrix_from_mn = info.color_matrix.is_some();
    if let Some(m) = info.color_matrix {
        params.color_matrix = Some(m);
    }

    let color_matrix_flat: [f32; 9] = {
        let m = params.color_matrix.unwrap_or(pipeline::CAM_TO_SRGB);
        [
            m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2],
        ]
    };

    let t = now_ms();
    let mut rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).map_err(|e| JsError::new(&e))?;
    let demosaic_ms = now_ms() - t;
    drop(raw);

    // ISO-gated luminance NR — applied pre-downscale so both lb and thumb benefit.
    let nr_strength = match info.iso.unwrap_or(0) {
        iso if iso >= 6400 => 0.50f32,
        iso if iso >= 3200 => 0.35,
        iso if iso >= 1600 => 0.20,
        _ => 0.0,
    };
    if nr_strength > 0.0 {
        pipeline::apply_luminance_nr(&mut rgb16, w, h, nr_strength);
    }

    Ok(OrfDecoded {
        rgb16,
        w,
        h,
        info,
        decompress_ms,
        demosaic_ms,
        wb_from_camera,
        params,
        color_matrix_from_mn,
        color_matrix_flat,
        lb_packed,
        lb_w,
        lb_h,
        thumb_packed,
        thumb_w,
        thumb_h,
        preview_demosaic_ms,
        preview_downscale_ms,
        fast_preview,
    })
}

/// Shared output stage: conditionally compute lb, thumb, and full RGB8 from
/// pre-decoded ORF data according to `output_flags`.  Absent outputs have empty
/// buffers and zero dims in the returned `ProcessResult`.
fn process_orf_impl(
    decoded: OrfDecoded,
    output_flags: u32,
    look: &LookOverrides,
) -> Result<ProcessResult, JsError> {
    let OrfDecoded {
        mut rgb16,
        w,
        h,
        info,
        decompress_ms,
        demosaic_ms,
        wb_from_camera,
        mut params,
        color_matrix_from_mn,
        color_matrix_flat,
        lb_packed,
        lb_w,
        lb_h,
        thumb_packed,
        thumb_w,
        thumb_h,
        preview_demosaic_ms,
        preview_downscale_ms,
        fast_preview,
    } = decoded;

    // Hypercar: use precomputed fast planar bilinear + planar down for lb/thumb (cheap SIMD, no mhc for preview paths).
    // The old down from (mhc) rgb16 is bypassed for previews; full rgb16 only for OUT_FULL_RGB8 tone.
    // M3 full-res 16-bit packed (for pyramid RAW 2048/full levels). Only when OUT_FULL_16 flag set.
    let (rgb16_full, out_full16_w, out_full16_h) = if output_flags & OUT_FULL_16 != 0 {
        let packed = pack_rgb16_full(&rgb16, w, h);
        (packed, w as u32, h as u32)
    } else {
        (vec![], 0, 0)
    };
    let (rgb16_lb, out_lb_w, out_lb_h) = if output_flags & OUT_LIGHTBOX != 0 {
        (lb_packed, lb_w, lb_h)
    } else {
        (vec![], 0, 0)
    };

    let (rgb16_thumb, out_thumb_w, out_thumb_h) = if output_flags & OUT_THUMB != 0 {
        (thumb_packed, thumb_w, thumb_h)
    } else {
        (vec![], 0, 0)
    };

    if look.wb_r.is_finite() && look.wb_r > 0.0 {
        params.wb_r = look.wb_r.min(8.0);
    }
    if look.wb_b.is_finite() && look.wb_b > 0.0 {
        params.wb_b = look.wb_b.min(8.0);
    }
    raw_pipeline::pipeline::apply_look_params(
        &mut params,
        look.exposure_ev,
        look.contrast,
        look.highlights,
        look.shadows,
        look.whites,
        look.blacks,
        look.saturation,
        look.vibrance,
        look.temp,
        look.tint,
        look.texture,
        look.clarity,
    );

    let t = now_ms();
    let (final_rgb, final_w, final_h, tonemap_ms, orient_ms) = if output_flags & OUT_FULL_RGB8 != 0
    {
        if params.texture != 0.0 || params.clarity != 0.0 {
            pipeline::apply_unsharp_masks(&mut rgb16, w, h, &params);
        }
        // Lens 23/24: use process_into + preallocated buffer to avoid internal Vec alloc
        // inside the tone path (reuses the "into" pattern from demosaic/pipeline).
        let mut rgb8 = vec![0u8; w * h * 3];
        pipeline::process_into(&rgb16, &params, &mut rgb8);
        let tonemap_ms = now_ms() - t;
        drop(rgb16);
        let t2 = now_ms();
        // OUT_NO_ORIENT lets the encoder use JXL's basic-info orientation field
        // — no CPU rotate, no 60–200 MB intermediate buffer.
        let skip_orient = (output_flags & OUT_NO_ORIENT) != 0;
        let (fr, fw, fh) = if skip_orient || info.orientation == 1 {
            (rgb8, w, h)
        } else {
            pipeline::apply_orientation(rgb8, w, h, info.orientation)
        };
        (fr, fw, fh, tonemap_ms, now_ms() - t2)
    } else {
        drop(rgb16);
        (vec![], 0, 0, 0.0, 0.0)
    };

    Ok(ProcessResult {
        rgb: final_rgb,
        width: final_w as u32,
        height: final_h as u32,
        orientation: info.orientation,
        decompress_ms,
        demosaic_ms,
        tonemap_ms,
        orient_ms,
        preview_demosaic_ms,
        preview_downscale_ms,
        fast_preview,
        wb_r_used: params.wb_r,
        wb_b_used: params.wb_b,
        color_matrix_from_mn,
        make: info.make,
        model: info.model,
        rgb16_lb,
        lb_w: out_lb_w as u32,
        lb_h: out_lb_h as u32,
        rgb16_thumb,
        thumb_w: out_thumb_w as u32,
        thumb_h: out_thumb_h as u32,
        rgb16_full,
        full16_w: out_full16_w,
        full16_h: out_full16_h,
        color_matrix_flat,
        lens: info.lens,
        datetime: info.datetime,
        // Rational fields use 0/0 as absent-sentinel (JS checks den==0 before dividing).
        exposure_num: info.exposure.map(|(n, _)| n).unwrap_or(0),
        exposure_den: info.exposure.map(|(_, d)| d).unwrap_or(0),
        fnumber_num: info.fnumber.map(|(n, _)| n).unwrap_or(0),
        fnumber_den: info.fnumber.map(|(_, d)| d).unwrap_or(0),
        iso: info.iso.unwrap_or(0),
        focal_length_num: info.focal_length.map(|(n, _)| n).unwrap_or(0),
        focal_length_den: info.focal_length.map(|(_, d)| d).unwrap_or(0),
        focal_length_35: info.focal_length_35.unwrap_or(0),
        gps_lat: info.gps_lat.unwrap_or(0.0),
        gps_lon: info.gps_lon.unwrap_or(0.0),
        gps_alt: info.gps_alt.unwrap_or(0.0),
        has_gps: info.gps_lat.is_some() && info.gps_lon.is_some(),
        quality: info.quality.unwrap_or(0),
        wb_mode: info.wb_mode.unwrap_or(0xFFFF),
        wb_from_camera,
    })
}

/// Central structural validation for ORF inputs.  Runs before the pipeline so
/// user-facing errors are produced in one place rather than scattered across
/// individual functions.  Internal guards in demosaic/decompress remain as
/// defence-in-depth but should never fire if this passes.
fn validate_orf_structure(data: &[u8], info: &tiff::OrfInfo) -> Result<(), JsError> {
    const MAX_DIM: u32 = 16_384;
    const MAX_PIXELS: usize = 50_000_000; // 50 MP

    if info.width == 0 || info.height == 0 {
        return Err(JsError::new("ORF: zero image dimension"));
    }
    if info.width > MAX_DIM || info.height > MAX_DIM {
        return Err(JsError::new(&format!(
            "ORF: dimension {}×{} exceeds maximum {}",
            info.width, info.height, MAX_DIM
        )));
    }
    let n = (info.width as usize)
        .checked_mul(info.height as usize)
        .ok_or_else(|| JsError::new("ORF: width×height overflows"))?;
    if n > MAX_PIXELS {
        return Err(JsError::new(&format!(
            "ORF: {} pixels exceeds 50 MP limit",
            n
        )));
    }
    let strip_end = (info.strip_offset as usize)
        .checked_add(info.strip_byte_count as usize)
        .ok_or_else(|| JsError::new("ORF: strip offset+length overflows"))?;
    if strip_end > data.len() {
        return Err(JsError::new("ORF: strip extends past end of file"));
    }
    Ok(())
}

/// Parse + decode an ORF file blob.  Returns an error string on failure.
///
/// All look params are LR-style, zero-centred (-1..+1 normalised), except
/// `exposure_ev` which is in stops.  `wb_r_override` / `wb_b_override`:
/// pass NaN (or ≤0) to use MakerNote / defaults.
///
/// Always generates full RGB8, 1800 px lightbox RGB16, and 360 px thumbnail RGB16.
/// Use `process_orf_with_flags` to skip unused outputs (e.g. batch JXL encoding
/// only needs full RGB8, not lb/thumb).
#[wasm_bindgen]
pub fn process_orf(
    data: &[u8],
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
    wb_r_override: f32,
    wb_b_override: f32,
    texture: f32,
    clarity: f32,
) -> Result<ProcessResult, JsError> {
    let look = LookOverrides {
        wb_r: wb_r_override,
        wb_b: wb_b_override,
        exposure_ev,
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
        saturation,
        vibrance,
        temp,
        tint,
        texture,
        clarity,
    };
    process_orf_impl(
        decode_orf_raw(data)?,
        OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB,
        &look,
    )
}

/// Variant of `process_orf` with explicit output flags to skip unused pipeline stages.
///
/// `output_flags` is a bitmask of:
/// - `1`: full-resolution RGB8 (needed for JXL encoding)
/// - `2`: 1800 px lightbox RGB16 cache (needed to construct a `LookRenderer`)
/// - `4`: 360 px thumbnail RGB16 cache (needed to construct a thumb `LookRenderer`)
///
/// Absent outputs have empty buffers and zero dims in `ProcessResult`.
/// Pass `7` for classic (no full16). For M3 16-bit big levels pass e.g. 15 (7|8).
#[wasm_bindgen]
pub fn process_orf_with_flags(
    data: &[u8],
    output_flags: u32,
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
    wb_r_override: f32,
    wb_b_override: f32,
    texture: f32,
    clarity: f32,
) -> Result<ProcessResult, JsError> {
    let look = LookOverrides {
        wb_r: wb_r_override,
        wb_b: wb_b_override,
        exposure_ev,
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
        saturation,
        vibrance,
        temp,
        tint,
        texture,
        clarity,
    };
    process_orf_impl(decode_orf_raw(data)?, output_flags, &look)
}

/// Rotated RGB8 buffer with updated dimensions.
#[wasm_bindgen]
pub struct RotateResult {
    rgb: Vec<u8>,
    #[wasm_bindgen(readonly)]
    pub width: u32,
    #[wasm_bindgen(readonly)]
    pub height: u32,
}

#[wasm_bindgen]
impl RotateResult {
    // Transfers ownership; returns empty Vec<u8> on subsequent calls.
    pub fn take_rgb(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rgb)
    }
}

/// Rotate an RGB8 buffer clockwise by `turns` × 90°  (0=0°, 1=90°, 2=180°, 3=270°).
/// Returns the rotated buffer and new (width, height).
#[wasm_bindgen]
pub fn rotate_rgb8(
    src: &[u8],
    width: u32,
    height: u32,
    turns: u32,
) -> Result<RotateResult, JsError> {
    let w = width as usize;
    let h = height as usize;
    let expected = w
        .checked_mul(h)
        .and_then(|n| n.checked_mul(3))
        .ok_or_else(|| JsError::new("rotate_rgb8: dimensions overflow"))?;
    if src.len() != expected {
        return Err(JsError::new(&format!(
            "rotate_rgb8: src length {} != {}×{}×3",
            src.len(),
            w,
            h
        )));
    }
    let (rgb, nw, nh) = match turns % 4 {
        0 => (src.to_vec(), w, h),
        1 => (pipeline::rotate_90_cw(src, w, h), h, w),
        2 => (pipeline::rotate_180(src, w, h), w, h),
        3 => (pipeline::rotate_90_ccw(src, w, h), h, w),
        _ => unreachable!(),
    };
    Ok(RotateResult {
        rgb,
        width: nw as u32,
        height: nh as u32,
    })
}

/// Box-filter downscale an RGB8 buffer.  Useful for thumbnail generation.
///
/// Fast path: when src dims are exact integer multiple of dst (common for 1/2, 1/4, 1/8 thumbs),
/// uses a much faster integer stepping loop with no f32 math or edge cases.
#[wasm_bindgen]
pub fn downscale_rgb(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
) -> Result<Vec<u8>, JsError> {
    let (sw, sh, dw, dh) = (
        src_w as usize,
        src_h as usize,
        dst_w as usize,
        dst_h as usize,
    );
    let expected_len = sw
        .checked_mul(sh)
        .and_then(|n| n.checked_mul(3))
        .ok_or_else(|| JsError::new("downscale_rgb: dimensions overflow"))?;
    if src.len() != expected_len {
        return Err(JsError::new("src length mismatch"));
    }
    if dst_w == 0 || dst_h == 0 {
        return Err(JsError::new("downscale_rgb: dst dimensions must be > 0"));
    }
    if src_w == 0 || src_h == 0 {
        return Err(JsError::new("downscale_rgb: src dimensions must be > 0"));
    }
    let mut out = vec![0u8; dw * dh * 3];

    // Big-brain fast path: exact integer downsample factors (very common for thumbs 1/2, 1/4, 1/8).
    // This is dramatically faster and has better cache behavior than the general box filter.
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let pixel_count = (xstep * ystep) as u32;
        let mut o = 0usize;
        for dy in 0..dh {
            for dx in 0..dw {
                let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
                let x_base = dx * xstep;
                let mut row_base = dy * ystep * sw;
                for _yy in 0..ystep {
                    let mut i = (row_base + x_base) * 3;
                    for _xx in 0..xstep {
                        rr += src[i] as u32;
                        gg += src[i + 1] as u32;
                        bb += src[i + 2] as u32;
                        i += 3;
                    }
                    row_base += sw;
                }
                out[o]     = (rr / pixel_count) as u8;
                out[o + 1] = (gg / pixel_count) as u8;
                out[o + 2] = (bb / pixel_count) as u8;
                o += 3;
            }
        }
        return Ok(out);
    }

    let xr = sw as f32 / dw as f32;
    let yr = sh as f32 / dh as f32;
    let mut o = 0usize;
    for dy in 0..dh {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = ((dy as f32 + 1.0) * yr).min(sh as f32) as usize;
        let y1 = y1.max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = ((dx as f32 + 1.0) * xr).min(sw as f32) as usize;
            let x1 = x1.max(x0 + 1);
            let x_count = x1 - x0;
            let n = ((y1 - y0) * x_count).max(1) as u32;
            let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
            let mut row_base = (y0 * sw + x0) * 3;
            for _y in y0..y1 {
                let mut i = row_base;
                for _ in 0..x_count {
                    rr += src[i] as u32;
                    gg += src[i + 1] as u32;
                    bb += src[i + 2] as u32;
                    i += 3;
                }
                row_base += sw * 3;
            }
            out[o]     = (rr / n) as u8;
            out[o + 1] = (gg / n) as u8;
            out[o + 2] = (bb / n) as u8;
            o += 3;
        }
    }
    Ok(out)
}

/// Planar SoA downscale (hypercar layer): 3 separate contiguous planes in (R/G/B from demosaic_planar).
/// Zero interleave cost. Sequential per-channel box filter = massive cache win vs interleaved scatter.
/// Outputs packed LE u8 6B/px (same as before) for drop-in use in lb/thumb paths. Integer fast path per plane.
fn downscale_rgb16_planar(r: &[u16], g: &[u16], b: &[u16], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    let mut out = vec![0u8; dw * dh * 6];
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let pixel_count = (xstep * ystep) as u32;
        let mut o = 0usize;
        for dy in 0..dh {
            for dx in 0..dw {
                let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
                let x_base = dx * xstep;
                let mut row_base = dy * ystep * sw;
                for _yy in 0..ystep {
                    let mut idx = row_base + x_base;
                    for _xx in 0..xstep {
                        rr += r[idx] as u32; gg += g[idx] as u32; bb += b[idx] as u32;
                        idx += 1;
                    }
                    row_base += sw;
                }
                write_rgb16_le(&mut out, o, (rr / pixel_count) as u16, (gg / pixel_count) as u16, (bb / pixel_count) as u16);
                o += 6;
            }
        }
        return out;
    }
    downscale_rgb_float_path(sw, sh, dw, dh, &mut out, |idx| {
        (r[idx] as u32, g[idx] as u32, b[idx] as u32)
    });
    out
}

/// Box-filter downscale an RGBA8 buffer.  Useful for thumbnail generation.
///
/// Fast path: when src dims are exact integer multiple of dst (common for 1/2, 1/4, 1/8 thumbs),
/// uses a much faster integer stepping loop with no f32 math or edge cases.
#[wasm_bindgen]
pub fn downscale_rgba(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
) -> Result<Vec<u8>, JsError> {
    let (sw, sh, dw, dh) = (
        src_w as usize,
        src_h as usize,
        dst_w as usize,
        dst_h as usize,
    );
    let expected_len = sw
        .checked_mul(sh)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| JsError::new("downscale_rgba: dimensions overflow"))?;
    if src.len() != expected_len {
        return Err(JsError::new("src length mismatch"));
    }
    if dst_w == 0 || dst_h == 0 {
        return Err(JsError::new("downscale_rgba: dst dimensions must be > 0"));
    }
    if src_w == 0 || src_h == 0 {
        return Err(JsError::new("downscale_rgba: src dimensions must be > 0"));
    }

    let mut out = vec![0u8; dw * dh * 4];

    // Same big-brain integer fast path as downscale_rgb for common power-of-two thumbnail cases.
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let pixel_count = (xstep * ystep) as u32;
        let mut o = 0usize;
        for dy in 0..dh {
            for dx in 0..dw {
                let (mut rr, mut gg, mut bb, mut aa) = (0u32, 0u32, 0u32, 0u32);
                let x_base = dx * xstep;
                let mut row_base = dy * ystep * sw;
                for _yy in 0..ystep {
                    let mut i = (row_base + x_base) * 4;
                    for _xx in 0..xstep {
                        rr += src[i]     as u32;
                        gg += src[i + 1] as u32;
                        bb += src[i + 2] as u32;
                        aa += src[i + 3] as u32;
                        i += 4;
                    }
                    row_base += sw;
                }
                out[o]     = (rr / pixel_count) as u8;
                out[o + 1] = (gg / pixel_count) as u8;
                out[o + 2] = (bb / pixel_count) as u8;
                out[o + 3] = (aa / pixel_count) as u8;
                o += 4;
            }
        }
        return Ok(out);
    }

    let xr = sw as f32 / dw as f32;
    let yr = sh as f32 / dh as f32;
    let mut o = 0usize;
    for dy in 0..dh {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = ((dy as f32 + 1.0) * yr).min(sh as f32) as usize;
        let y1 = y1.max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = ((dx as f32 + 1.0) * xr).min(sw as f32) as usize;
            let x1 = x1.max(x0 + 1);
            let x_count = x1 - x0;
            let n = ((y1 - y0) * x_count).max(1) as u32;
            let (mut rr, mut gg, mut bb, mut aa) = (0u32, 0u32, 0u32, 0u32);
            let mut row_base = (y0 * sw + x0) * 4;
            for _y in y0..y1 {
                let mut i = row_base;
                for _ in 0..x_count {
                    rr += src[i]     as u32;
                    gg += src[i + 1] as u32;
                    bb += src[i + 2] as u32;
                    aa += src[i + 3] as u32;
                    i += 4;
                }
                row_base += sw * 4;
            }
            out[o]     = (rr / n) as u8;
            out[o + 1] = (gg / n) as u8;
            out[o + 2] = (bb / n) as u8;
            out[o + 3] = (aa / n) as u8;
            o += 4;
        }
    }
    Ok(out)
}

/// Re-apply tonemap + orientation to a cached lightbox-sized rgb16 buffer.
///
/// `rgb16_src` is flat RGB16 (3 u16 per pixel, interleaved).  For repeated slider
/// edits prefer `LookRenderer`, which owns the buffer inside WASM and avoids the
/// JS→WASM transfer on each call.
/// `color_matrix_flat` is 9 f32s row-major; pass a slice of len != 9 to use the
/// built-in fallback.
#[wasm_bindgen]
pub fn apply_look(
    rgb16_src: &[u16],
    width: u32,
    height: u32,
    orientation: u16,
    wb_r: f32,
    wb_b: f32,
    color_matrix_flat: &[f32],
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
) -> Result<Vec<u8>, JsError> {
    let w = width as usize;
    let h = height as usize;
    let expected_len = w
        .checked_mul(h)
        .and_then(|px| px.checked_mul(3))
        .ok_or_else(|| JsError::new("apply_look: dimensions overflow"))?;
    if rgb16_src.len() != expected_len {
        return Err(JsError::new(&format!(
            "apply_look: rgb16 length {} != {}×{}×3",
            rgb16_src.len(),
            w,
            h
        )));
    }
    let mut params = pipeline::PipelineParams::default_olympus();
    if wb_r.is_finite() && wb_r > 0.0 {
        params.wb_r = wb_r;
    }
    if wb_b.is_finite() && wb_b > 0.0 {
        params.wb_b = wb_b;
    }
    if color_matrix_flat.len() == 9 {
        let mut m = [[0f32; 3]; 3];
        for r in 0..3 {
            for c in 0..3 {
                m[r][c] = color_matrix_flat[r * 3 + c];
            }
        }
        params.color_matrix = Some(m);
    }
    raw_pipeline::pipeline::apply_look_params(
        &mut params,
        exposure_ev,
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
        saturation,
        vibrance,
        temp,
        tint,
        texture,
        clarity,
    );

    // Defer clone to only when unsharp masking is needed (texture or clarity nonzero).
    // For the common no-sharpening path the borrow is sufficient and we avoid an
    // unnecessary full-resolution copy.
    let rgb8 = if params.texture != 0.0 || params.clarity != 0.0 {
        let mut rgb16 = rgb16_src.to_vec();
        pipeline::apply_unsharp_masks(&mut rgb16, w, h, &params);
        pipeline::process(&rgb16, &params)
    } else {
        pipeline::process(rgb16_src, &params)
    };
    if orientation == 1 {
        Ok(rgb8)
    } else {
        let (final_rgb, _, _) = pipeline::apply_orientation(rgb8, w, h, orientation);
        Ok(final_rgb)
    }
}

/// Convert interleaved RGB8 → RGBA8 (alpha = 255).  HTML canvas wants RGBA.
// Input must be a multiple of 3 bytes; trailing bytes are ignored.
// Manual indexing version — tends to produce tighter codegen than chunks+zip
// for this extremely hot conversion path (called on every RAW frame).
#[wasm_bindgen]
pub fn rgb_to_rgba(rgb: &[u8]) -> Vec<u8> {
    let n = rgb.len() / 3;
    let mut out = vec![255u8; n * 4];
    let mut si = 0usize;
    let mut di = 0usize;
    for _ in 0..n {
        out[di] = rgb[si];
        out[di + 1] = rgb[si + 1];
        out[di + 2] = rgb[si + 2];
        si += 3;
        di += 4;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_rgba_via_rgb_to_rgba_roundtrip() {
        // Basic sanity: the take_rgba path ultimately uses the same conversion
        // as the public rgb_to_rgba helper.
        let rgb = vec![10, 20, 30, 40, 50, 60];
        // We can't easily unit-test take_rgba without a full ProcessResult,
        // but we can at least ensure the shared helper is stable.
        let expected = rgb_to_rgba(&rgb);
        assert_eq!(expected.len(), 8);
        assert_eq!(&expected[0..4], &[10, 20, 30, 255]);
    }

    #[test]
    fn raw_pipeline_direct_rgba_available_for_native_parity() {
        // Smoke that the direct-RGBA entry (for Tauri P3 encode parity) is linked
        // and produces correct channel count + sentinel alpha. The heavy impl
        // and benches live in the raw-pipeline crate.
        let rgb16 = vec![2048u16; 2 * 2 * 3];
        let params = raw_pipeline::pipeline::PipelineParams::default_olympus();
        let rgba = raw_pipeline::pipeline::process_rgba(&rgb16, &params);
        assert_eq!(rgba.len(), 16);
        assert!(rgba.chunks_exact(4).all(|px| px[3] == 255));
    }
}

/// WASM-resident rendering state for a single image (lightbox or thumbnail).
///
/// Owns the pre-tonemapped RGB16 buffer.  Slider changes call `render()` without
/// transferring pixel data between JS and WASM — the JS→WASM transfer happens once
/// at construction; every subsequent edit stays inside WASM.
///
/// When `texture` and `clarity` are both zero (the common case), `render` reads the
/// internal buffer without cloning.  When either is nonzero, a clone is made before
/// in-place sharpening so the cached buffer is never mutated.
#[wasm_bindgen]
pub struct LookRenderer {
    rgb16: Vec<u16>,
    width: usize,
    height: usize,
    orientation: u16,
    // When false, `render()` returns sensor-orientation RGB8 (sensor width/height)
    // and the consumer is responsible for applying the rotation — typically via
    // a CSS / canvas-transform draw, which is free on the GPU. When true (legacy
    // default), the rotation is baked into pixels during render.
    apply_rotation: bool,
    color_matrix: [[f32; 3]; 3],
}

#[wasm_bindgen]
impl LookRenderer {
    /// Construct from a packed u16-LE buffer (6 bytes per pixel, as returned by
    /// `take_rgb16_lb` / `take_rgb16_thumb`), dims, EXIF orientation, and a
    /// 9-element row-major colour matrix.  Pass a slice of length != 9 to use
    /// the built-in `CAM_TO_SRGB` fallback.
    #[wasm_bindgen(constructor)]
    pub fn new(
        rgb16_bytes: &[u8],
        width: u32,
        height: u32,
        orientation: u16,
        color_matrix_flat: &[f32],
    ) -> Result<LookRenderer, JsError> {
        Self::new_with_options(rgb16_bytes, width, height, orientation, color_matrix_flat, true)
    }

    /// Variant of `new` that lets the caller opt out of CPU rotation in
    /// `render()`. When `apply_rotation` is `false`, `render()` returns
    /// sensor-orientation RGB8 (same dims as `rgb16` source) and the JS side
    /// must apply the EXIF rotation at display time (canvas/CSS transform).
    /// Saves a full-buffer transpose per slider tick for non-identity orientations.
    pub fn new_with_options(
        rgb16_bytes: &[u8],
        width: u32,
        height: u32,
        orientation: u16,
        color_matrix_flat: &[f32],
        apply_rotation: bool,
    ) -> Result<LookRenderer, JsError> {
        let w = width as usize;
        let h = height as usize;
        let expected = w
            .checked_mul(h)
            .and_then(|px| px.checked_mul(6))
            .ok_or_else(|| JsError::new("LookRenderer: dimensions overflow"))?;
        if rgb16_bytes.len() != expected {
            return Err(JsError::new(&format!(
                "LookRenderer: bytes {} != {}×{}×6",
                rgb16_bytes.len(),
                w,
                h
            )));
        }
        let rgb16 = unpack_rgb16_le(rgb16_bytes);
        let color_matrix = if color_matrix_flat.len() == 9 {
            [
                [
                    color_matrix_flat[0],
                    color_matrix_flat[1],
                    color_matrix_flat[2],
                ],
                [
                    color_matrix_flat[3],
                    color_matrix_flat[4],
                    color_matrix_flat[5],
                ],
                [
                    color_matrix_flat[6],
                    color_matrix_flat[7],
                    color_matrix_flat[8],
                ],
            ]
        } else {
            pipeline::CAM_TO_SRGB
        };
        Ok(Self {
            rgb16,
            width: w,
            height: h,
            orientation,
            apply_rotation,
            color_matrix,
        })
    }

    /// EXIF orientation tag (1..8) stored at construction. Consumers using
    /// `apply_rotation=false` read this to drive display-time rotation.
    #[wasm_bindgen(getter)]
    pub fn orientation(&self) -> u16 {
        self.orientation
    }

    /// Source-buffer dimensions (sensor orientation, pre-rotation).
    #[wasm_bindgen(getter)]
    pub fn native_width(&self) -> u32 {
        self.width as u32
    }

    #[wasm_bindgen(getter)]
    pub fn native_height(&self) -> u32 {
        self.height as u32
    }

    /// Apply look parameters and return an RGB8 buffer (post-orientation).
    /// Only the output RGB8 crosses the WASM boundary on each call.
    #[allow(clippy::too_many_arguments)]
    pub fn render(
        &self,
        wb_r: f32,
        wb_b: f32,
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
    ) -> Result<Vec<u8>, JsError> {
        let mut params = pipeline::PipelineParams::default_olympus();
        if wb_r.is_finite() && wb_r > 0.0 {
            params.wb_r = wb_r;
        }
        if wb_b.is_finite() && wb_b > 0.0 {
            params.wb_b = wb_b;
        }
        params.color_matrix = Some(self.color_matrix);
        raw_pipeline::pipeline::apply_look_params(
            &mut params,
            exposure_ev,
            contrast,
            highlights,
            shadows,
            whites,
            blacks,
            saturation,
            vibrance,
            temp,
            tint,
            texture,
            clarity,
        );

        let rgb8 = if params.texture != 0.0 || params.clarity != 0.0 {
            let mut rgb16 = self.rgb16.clone();
            pipeline::apply_unsharp_masks(&mut rgb16, self.width, self.height, &params);
            pipeline::process(&rgb16, &params)
        } else {
            pipeline::process(&self.rgb16, &params)
        };

        if !self.apply_rotation || self.orientation == 1 {
            Ok(rgb8)
        } else {
            let (final_rgb, _, _) =
                pipeline::apply_orientation(rgb8, self.width, self.height, self.orientation);
            Ok(final_rgb)
        }
    }
}

/// EXIF metadata extracted without demosaic/tonemap.  Use for gallery thumbnails,
/// batch preflight, and sort-by-date/lens/GPS without a full decode.
#[wasm_bindgen]
pub struct OrfMetadata {
    make: String,
    model: String,
    lens: String,
    datetime: String,
    #[wasm_bindgen(readonly)]
    pub width: u32,
    #[wasm_bindgen(readonly)]
    pub height: u32,
    #[wasm_bindgen(readonly)]
    pub orientation: u16,
    #[wasm_bindgen(readonly)]
    pub iso: u32,
    #[wasm_bindgen(readonly)]
    pub has_gps: bool,
    #[wasm_bindgen(readonly)]
    pub gps_lat: f64,
    #[wasm_bindgen(readonly)]
    pub gps_lon: f64,
}

#[wasm_bindgen]
impl OrfMetadata {
    #[wasm_bindgen(getter)]
    pub fn make(&self) -> String {
        self.make.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn model(&self) -> String {
        self.model.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn lens(&self) -> String {
        self.lens.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn datetime(&self) -> String {
        self.datetime.clone()
    }
}

/// Parse ORF EXIF metadata only — no decompress, no demosaic, no tonemap.
/// Returns camera, lens, exposure, GPS for batch ingest and gallery views.
#[wasm_bindgen]
pub fn parse_orf_metadata(data: &[u8]) -> Result<OrfMetadata, JsError> {
    let info = tiff::parse(data).map_err(|e| JsError::new(&e))?;
    Ok(OrfMetadata {
        make: info.make,
        model: info.model,
        lens: info.lens,
        datetime: info.datetime,
        width: info.width,
        height: info.height,
        orientation: info.orientation,
        iso: info.iso.unwrap_or(0),
        has_gps: info.gps_lat.is_some() && info.gps_lon.is_some(),
        gps_lat: info.gps_lat.unwrap_or(0.0),
        gps_lon: info.gps_lon.unwrap_or(0.0),
    })
}

/// Timing results for the decompress + demosaic stages only.
/// Skips tonemap, downscale, and orientation — isolates raw decode cost.
#[wasm_bindgen]
pub struct DecodeBench {
    #[wasm_bindgen(readonly)]
    pub decompress_ms: f64,
    #[wasm_bindgen(readonly)]
    pub demosaic_ms: f64,
    #[wasm_bindgen(readonly)]
    pub width: u32,
    #[wasm_bindgen(readonly)]
    pub height: u32,
}

/// Benchmark ORF decompress + demosaic without tonemap/downscale/orientation.
/// Use to measure decoder cost in isolation when tuning WASM flags or algorithms.
#[wasm_bindgen]
pub fn bench_decode_orf(data: &[u8]) -> Result<DecodeBench, JsError> {
    let info = tiff::parse(data).map_err(|e| JsError::new(&e))?;
    validate_orf_structure(data, &info)?;
    let w = info.width as usize;
    let h = info.height as usize;
    let strip_end = info.strip_offset as usize + info.strip_byte_count as usize;
    let strip = &data[info.strip_offset as usize..strip_end];
    let t = now_ms();
    let raw = decompress::decompress(strip, w, h).map_err(|e| JsError::new(&e))?;
    let decompress_ms = now_ms() - t;
    let t = now_ms();
    let _rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).map_err(|e| JsError::new(&e))?;
    let demosaic_ms = now_ms() - t;
    Ok(DecodeBench {
        decompress_ms,
        demosaic_ms,
        width: info.width,
        height: info.height,
    })
}

struct DngDecoded {
    rgb16: Vec<u16>,
    aw: usize,
    ah: usize,
    params: pipeline::PipelineParams,
    color_matrix_flat: [f32; 9],
    decode_ms: f64,
    demosaic_ms: f64,
    orientation: u16,
    make: String,
    model: String,
    iso: u32,
}

/// Shared DNG decode path: decode bytes → validate → align CFA → demosaic → NR → WB/params setup.
/// Returns pre-tonemapped RGB16 and all metadata.  Called by process_dng_impl.
fn decode_dng_raw(data: &[u8]) -> Result<DngDecoded, JsError> {
    const MAX_DIM: u32 = 8192;
    const MAX_PIXELS: usize = 50_000_000;

    // X2: fused DNG decode+demosaic (strip with halo for RGGB). Returns pre-NR rgb16 + meta + internal ms.
    // Old decode_bytes + align + full demosaic removed for this path to avoid full mosaic + full RGB residency.
    let fused = raw_pipeline::dng::decode_bytes_demosaiced(data)
        .map_err(|e| JsError::new(&format!("DNG decode: {}", e)))?;

    let w = fused.width;
    let h = fused.height;
    if w == 0 || h == 0 {
        return Err(JsError::new("DNG: zero image dimension"));
    }
    if (w as u32) > MAX_DIM || (h as u32) > MAX_DIM {
        return Err(JsError::new(&format!(
            "DNG: dimension {}×{} exceeds maximum {}",
            w, h, MAX_DIM
        )));
    }
    if w.checked_mul(h).unwrap_or(MAX_PIXELS + 1) > MAX_PIXELS {
        return Err(JsError::new(&format!(
            "DNG: {} pixels exceeds 50 MP limit",
            w * h
        )));
    }

    let mut rgb16 = fused.rgb;
    let aw = fused.width;
    let ah = fused.height;
    let decode_ms = fused.decode_ms;
    let demosaic_ms = fused.demosaic_ms;

    // Build pipeline params from DNG metadata (post-fused)
    let mut params = pipeline::PipelineParams::default_olympus();
    params.black = fused.black;
    params.white = fused.white;
    params.wb_r = fused.wb_r;
    params.wb_b = fused.wb_b;
    params.color_matrix = fused.color_matrix;
    let color_matrix_flat: [f32; 9] = {
        let m = params.color_matrix.unwrap_or(pipeline::CAM_TO_SRGB);
        [
            m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2],
        ]
    };

    // Use ISO from DNG metadata for NR strength; fall back to 100 if absent.
    let iso = fused.iso.unwrap_or(100);
    let nr_strength = match iso {
        iso if iso >= 6400 => 0.50f32,
        iso if iso >= 3200 => 0.35,
        iso if iso >= 1600 => 0.20,
        _ => 0.0,
    };
    if nr_strength > 0.0 {
        pipeline::apply_luminance_nr(&mut rgb16, aw, ah, nr_strength);
    }

    Ok(DngDecoded {
        rgb16,
        aw,
        ah,
        params,
        color_matrix_flat,
        decode_ms,
        demosaic_ms,
        orientation: fused.orientation,
        make: fused.make,
        model: fused.model,
        iso,
    })
}

/// Shared DNG output stage: conditionally compute lb, thumb, and full RGB8 from
/// pre-decoded DNG data according to `output_flags`.  Absent outputs have empty
/// buffers and zero dims in the returned `ProcessResult`.
fn process_dng_impl(
    decoded: DngDecoded,
    output_flags: u32,
    look: &LookOverrides,
) -> Result<ProcessResult, JsError> {
    let DngDecoded {
        mut rgb16,
        aw,
        ah,
        mut params,
        color_matrix_flat,
        decode_ms,
        demosaic_ms,
        orientation,
        make,
        model,
        iso,
    } = decoded;

    // M3 full-res 16-bit (DNG path).
    let (rgb16_full, out_full16_w, out_full16_h) = if output_flags & OUT_FULL_16 != 0 {
        let packed = pack_rgb16_full(&rgb16, aw, ah);
        (packed, aw as u32, ah as u32)
    } else {
        (vec![], 0, 0)
    };

    // Compute lightbox + thumb caches (pre-tonemap, pre-orientation)
    let (lb_w, lb_h) = target_dims(aw, ah, 1800);
    let (rgb16_lb, out_lb_w, out_lb_h) = if output_flags & OUT_LIGHTBOX != 0 {
        let lb = downscale_rgb16_impl(&rgb16, aw, ah, lb_w, lb_h);
        (lb, lb_w, lb_h)
    } else {
        (vec![], 0, 0)
    };

    let (thumb_w, thumb_h) = target_dims(aw, ah, 360);
    let (rgb16_thumb, out_thumb_w, out_thumb_h) = if output_flags & OUT_THUMB != 0 {
        let thumb = if output_flags & OUT_LIGHTBOX != 0 {
            // Same packed optimization as the main path for consistency and speed.
            downscale_packed_rgb16_le(&rgb16_lb, lb_w, lb_h, thumb_w, thumb_h)
        } else {
            downscale_rgb16_impl(&rgb16, aw, ah, thumb_w, thumb_h)
        };
        (thumb, thumb_w, thumb_h)
    } else {
        (vec![], 0, 0)
    };

    // Apply look parameters
    if look.wb_r.is_finite() && look.wb_r > 0.0 {
        params.wb_r = look.wb_r.min(8.0);
    }
    if look.wb_b.is_finite() && look.wb_b > 0.0 {
        params.wb_b = look.wb_b.min(8.0);
    }
    raw_pipeline::pipeline::apply_look_params(
        &mut params,
        look.exposure_ev,
        look.contrast,
        look.highlights,
        look.shadows,
        look.whites,
        look.blacks,
        look.saturation,
        look.vibrance,
        look.temp,
        look.tint,
        look.texture,
        look.clarity,
    );

    let t = now_ms();
    let (final_rgb, final_w, final_h, tonemap_ms, orient_ms) = if output_flags & OUT_FULL_RGB8 != 0
    {
        if params.texture != 0.0 || params.clarity != 0.0 {
            pipeline::apply_unsharp_masks(&mut rgb16, aw, ah, &params);
        }
        let rgb8 = pipeline::process(&rgb16, &params);
        let tonemap_ms = now_ms() - t;
        drop(rgb16);
        let t2 = now_ms();
        let skip_orient = (output_flags & OUT_NO_ORIENT) != 0;
        let (fr, fw, fh) = if skip_orient || orientation == 1 {
            (rgb8, aw, ah)
        } else {
            pipeline::apply_orientation(rgb8, aw, ah, orientation)
        };
        (fr, fw, fh, tonemap_ms, now_ms() - t2)
    } else {
        drop(rgb16);
        (vec![], 0, 0, 0.0, 0.0)
    };

    Ok(ProcessResult {
        rgb: final_rgb,
        width: final_w as u32,
        height: final_h as u32,
        orientation,
        decompress_ms: decode_ms,
        demosaic_ms,
        tonemap_ms,
        orient_ms,
        preview_demosaic_ms: 0.0,
        preview_downscale_ms: 0.0,
        fast_preview: false,
        wb_r_used: params.wb_r,
        wb_b_used: params.wb_b,
        color_matrix_from_mn: params.color_matrix.is_some(),
        make,
        model,
        rgb16_lb,
        lb_w: out_lb_w as u32,
        lb_h: out_lb_h as u32,
        rgb16_thumb,
        thumb_w: out_thumb_w as u32,
        thumb_h: out_thumb_h as u32,
        rgb16_full,
        full16_w: out_full16_w,
        full16_h: out_full16_h,
        color_matrix_flat,
        lens: String::new(),
        datetime: String::new(),
        exposure_num: 0,
        exposure_den: 1,
        fnumber_num: 0,
        fnumber_den: 1,
        iso,
        focal_length_num: 0,
        focal_length_den: 1,
        focal_length_35: 0,
        gps_lat: 0.0,
        gps_lon: 0.0,
        gps_alt: 0.0,
        has_gps: false,
        quality: 0,
        wb_mode: 0xFFFF,
        wb_from_camera: true,
    })
}

/// Parse + decode a DNG file blob. Returns an error string on failure.
/// (Rayon when parallel-wasm feature active.) Look params: LR-style (-1..+1), except
/// exposure_ev in stops.  Pass NaN/≤0 for wb_r_override/wb_b_override to use defaults.
///
/// Always generates full RGB8, 1800 px lightbox RGB16, and 360 px thumbnail RGB16.
/// Use `process_dng_with_flags` to skip unused outputs (e.g. batch JXL encoding
/// only needs full RGB8, not lb/thumb).
#[wasm_bindgen]
pub fn process_dng(
    data: &[u8],
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
    wb_r_override: f32,
    wb_b_override: f32,
    texture: f32,
    clarity: f32,
) -> Result<ProcessResult, JsError> {
    let look = LookOverrides {
        wb_r: wb_r_override,
        wb_b: wb_b_override,
        exposure_ev,
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
        saturation,
        vibrance,
        temp,
        tint,
        texture,
        clarity,
    };
    process_dng_impl(
        decode_dng_raw(data)?,
        OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB,
        &look,
    )
}

/// Variant of `process_dng` with explicit output flags to skip unused pipeline stages.
///
/// `output_flags` is a bitmask of:
/// - `1`: full-resolution RGB8 (needed for JXL encoding)
/// - `2`: 1800 px lightbox RGB16 cache (needed to construct a `LookRenderer`)
/// - `4`: 360 px thumbnail RGB16 cache (needed to construct a thumb `LookRenderer`)
///
/// Absent outputs have empty buffers and zero dims in `ProcessResult`.
/// Pass `7` to match the behaviour of `process_dng`.
#[wasm_bindgen]
pub fn process_dng_with_flags(
    data: &[u8],
    output_flags: u32,
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
    wb_r_override: f32,
    wb_b_override: f32,
    texture: f32,
    clarity: f32,
) -> Result<ProcessResult, JsError> {
    let look = LookOverrides {
        wb_r: wb_r_override,
        wb_b: wb_b_override,
        exposure_ev,
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
        saturation,
        vibrance,
        temp,
        tint,
        texture,
        clarity,
    };
    process_dng_impl(decode_dng_raw(data)?, output_flags, &look)
}

// ─── CR2 pipeline ─────────────────────────────────────────────────────────────

struct Cr2Decoded {
    rgb16: Vec<u16>,
    aw: usize,
    ah: usize,
    params: pipeline::PipelineParams,
    color_matrix_flat: [f32; 9],
    decode_ms: f64,
    demosaic_ms: f64,
    orientation: u16,
    make: String,
    model: String,
    iso: u32,
}

/// Generic Canon EOS cam-to-sRGB matrix (dcraw/LibRaw coefficients).
/// Used as the fallback when a CR2 file does not embed its own color matrix.
const CANON_CAM_TO_SRGB: [[f32; 3]; 3] = [
    [ 0.4592, 0.3810, 0.1595],
    [ 0.1638, 0.7718, 0.0644],
    [ 0.0388, 0.0791, 0.8824],
];

fn decode_cr2_raw(data: &[u8]) -> Result<Cr2Decoded, JsError> {
    const MAX_DIM: u32 = 8192;
    const MAX_PIXELS: usize = 50_000_000;

    let t = now_ms();
    let cr2 = raw_pipeline::cr2::decode_bytes(data)
        .map_err(|e| JsError::new(&format!("CR2 decode: {}", e)))?;
    let decode_ms = now_ms() - t;

    let w = cr2.width;
    let h = cr2.height;
    if w == 0 || h == 0 {
        return Err(JsError::new("CR2: zero image dimension"));
    }
    if (w as u32) > MAX_DIM || (h as u32) > MAX_DIM {
        return Err(JsError::new(&format!(
            "CR2: dimension {}×{} exceeds maximum {}",
            w, h, MAX_DIM
        )));
    }
    if w.checked_mul(h).unwrap_or(MAX_PIXELS + 1) > MAX_PIXELS {
        return Err(JsError::new(&format!(
            "CR2: {} pixels exceeds 50 MP limit",
            w * h
        )));
    }

    // CR2 is always RGGB — no align_to_rggb step.
    let t = now_ms();
    let mut rgb16 = demosaic::demosaic_rggb_mhc(&cr2.raw, w, h)
        .map_err(|e| JsError::new(&format!("CR2 demosaic: {}", e)))?;
    let demosaic_ms = now_ms() - t;

    let mut params = pipeline::PipelineParams::default_olympus();
    params.black = cr2.black;
    params.white = cr2.white;
    params.wb_r = cr2.wb_r;
    params.wb_b = cr2.wb_b;
    params.color_matrix = cr2.color_matrix;
    let color_matrix_flat: [f32; 9] = {
        let m = params.color_matrix.unwrap_or(CANON_CAM_TO_SRGB);
        [m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]]
    };

    let iso = cr2.iso.unwrap_or(100);
    let nr_strength = match iso {
        iso if iso >= 6400 => 0.50f32,
        iso if iso >= 3200 => 0.35,
        iso if iso >= 1600 => 0.20,
        _ => 0.0,
    };
    if nr_strength > 0.0 {
        pipeline::apply_luminance_nr(&mut rgb16, w, h, nr_strength);
    }

    Ok(Cr2Decoded {
        rgb16,
        aw: w,
        ah: h,
        params,
        color_matrix_flat,
        decode_ms,
        demosaic_ms,
        orientation: cr2.orientation,
        make: cr2.make,
        model: cr2.model,
        iso,
    })
}

fn process_cr2_impl(
    decoded: Cr2Decoded,
    output_flags: u32,
    look: &LookOverrides,
) -> Result<ProcessResult, JsError> {
    process_dng_impl(
        DngDecoded {
            rgb16: decoded.rgb16,
            aw: decoded.aw,
            ah: decoded.ah,
            params: decoded.params,
            color_matrix_flat: decoded.color_matrix_flat,
            decode_ms: decoded.decode_ms,
            demosaic_ms: decoded.demosaic_ms,
            orientation: decoded.orientation,
            make: decoded.make,
            model: decoded.model,
            iso: decoded.iso,
        },
        output_flags,
        look,
    )
}

/// Parse + decode a Canon CR2 file blob.
///
/// Always generates full RGB8, 1800 px lightbox RGB16, and 360 px thumbnail RGB16.
/// Use `process_cr2_with_flags` to skip unused outputs.
#[wasm_bindgen]
pub fn process_cr2(
    data: &[u8],
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
    wb_r_override: f32,
    wb_b_override: f32,
    texture: f32,
    clarity: f32,
) -> Result<ProcessResult, JsError> {
    let look = LookOverrides {
        wb_r: wb_r_override,
        wb_b: wb_b_override,
        exposure_ev,
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
        saturation,
        vibrance,
        temp,
        tint,
        texture,
        clarity,
    };
    process_cr2_impl(
        decode_cr2_raw(data)?,
        OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB,
        &look,
    )
}

/// Variant of `process_cr2` with explicit output flags.
///
/// `output_flags` bitmask: 1 = full RGB8, 2 = 1800 px lightbox RGB16, 4 = 360 px thumb RGB16, 8 = full RGB16 (M3).
/// Pass `7` for classic; 15 for M3 full16 too.
#[wasm_bindgen]
pub fn process_cr2_with_flags(
    data: &[u8],
    output_flags: u32,
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
    wb_r_override: f32,
    wb_b_override: f32,
    texture: f32,
    clarity: f32,
) -> Result<ProcessResult, JsError> {
    let look = LookOverrides {
        wb_r: wb_r_override,
        wb_b: wb_b_override,
        exposure_ev,
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
        saturation,
        vibrance,
        temp,
        tint,
        texture,
        clarity,
    };
    process_cr2_impl(decode_cr2_raw(data)?, output_flags, &look)
}

// ---------------------------------------------------------------------------
// Perceptual metrics (Butteraugli-approx / SSIM / PSNR) — wasm-bindgen binding.
// Precompute the reference once, evaluate many test images against it. The kernel
// lives in raw-pipeline (shared with native/Tauri); here we only expose it.
// ---------------------------------------------------------------------------

use raw_pipeline::perceptual::{Comparer as PerceptualCore, Metrics, Opts};

#[wasm_bindgen]
pub struct PerceptualComparer {
    inner: PerceptualCore,
    scratch: Vec<u8>, // grow-only RGBA staging for the zero-copy path
}

#[wasm_bindgen]
impl PerceptualComparer {
    #[wasm_bindgen(constructor)]
    pub fn new(ref_rgba: &[u8], width: usize, height: usize) -> PerceptualComparer {
        let n = width * height;
        let inner = PerceptualCore::new(ref_rgba, width, height, Opts::default());
        PerceptualComparer { inner, scratch: vec![0u8; n * 4] }
    }

    /// Copying convenience path: pass RGBA, get {butteraugli, ssim, psnr} as a JS object.
    pub fn all(&mut self, test_rgba: &[u8]) -> JsValue {
        metrics_to_js(&self.inner.all(test_rgba))
    }

    pub fn butteraugli(&mut self, test_rgba: &[u8]) -> f32 {
        self.inner.butteraugli(test_rgba)
    }
    pub fn ssim(&self, test_rgba: &[u8]) -> f32 {
        self.inner.ssim(test_rgba)
    }
    pub fn psnr(&self, test_rgba: &[u8]) -> f32 {
        self.inner.psnr(test_rgba)
    }

    /// Zero-copy: returns a pointer into the wasm heap staging buffer of `len`
    /// bytes. JS writes the test RGBA straight here (no ArrayBuffer copy across
    /// the boundary), then calls `all_at(len)`. Grows the buffer if needed; the
    /// returned pointer is valid until the next `input_ptr` call.
    pub fn input_ptr(&mut self, len: usize) -> *mut u8 {
        if self.scratch.len() < len {
            self.scratch.resize(len, 0);
        }
        self.scratch.as_mut_ptr()
    }

    /// Compute all three metrics over the `len` bytes previously written into the
    /// staging buffer via `input_ptr`.
    pub fn all_at(&mut self, len: usize) -> JsValue {
        // Split the borrow: take the staging buffer out, evaluate, put it back.
        let buf = std::mem::take(&mut self.scratch);
        let m = self.inner.all(&buf[..len]);
        self.scratch = buf;
        metrics_to_js(&m)
    }
}

fn metrics_to_js(m: &Metrics) -> JsValue {
    let o = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&o, &"butteraugli".into(), &JsValue::from_f64(m.butteraugli as f64));
    let _ = js_sys::Reflect::set(&o, &"ssim".into(), &JsValue::from_f64(m.ssim as f64));
    let _ = js_sys::Reflect::set(&o, &"psnr".into(), &JsValue::from_f64(m.psnr as f64));
    o.into()
}
