//! Browser entry point for the Olympus ORF → RGB pipeline.
//!
//! Exports `process_orf(bytes)` which parses an ORF blob, decompresses the
//! 12-bit predictive stream, demosaics RGGB → RGB, applies WB/sRGB tone curve
//! and EXIF orientation, returning an interleaved RGB8 buffer plus dims.
//!
//! Encoding (JXL / WebP) is left to JS via jSquash — keeps the wasm small.
//! All stages here are single-threaded; switch to `wasm-bindgen-rayon` if
//! the host can set COOP/COEP and we want to use Web Workers.

use raw_pipeline::decompress;
use raw_pipeline::demosaic;
use raw_pipeline::pipeline;
use raw_pipeline::tiff;

use wasm_bindgen::prelude::*;

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
    pub fn make(&self) -> String { self.make.clone() }
    #[wasm_bindgen(getter)]
    pub fn model(&self) -> String { self.model.clone() }
    #[wasm_bindgen(getter)]
    pub fn lens(&self) -> String { self.lens.clone() }
    #[wasm_bindgen(getter)]
    pub fn datetime(&self) -> String { self.datetime.clone() }
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

    /// Return the color matrix used (9 floats, row-major).
    pub fn color_matrix_used(&self) -> Vec<f32> {
        self.color_matrix_flat.to_vec()
    }
}

fn now_ms() -> f64 {
    let perf = web_sys::window()
        .and_then(|w| w.performance())
        .or_else(|| {
            js_sys::global()
                .dyn_into::<web_sys::WorkerGlobalScope>()
                .ok()
                .and_then(|w| w.performance())
        });
    perf.map(|p| p.now()).unwrap_or(0.0)
}

/// Box-filter downscale an RGB16 (u16) buffer, outputting packed u16 LE bytes
/// (6 bytes per pixel).  Used to cache a lightbox-sized buffer for live re-render.
fn downscale_rgb16_impl(src: &[u16], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    let xr = sw as f32 / dw as f32;
    let yr = sh as f32 / dh as f32;
    let mut out = vec![0u8; dw * dh * 6];
    for dy in 0..dh {
        // y bounds depend only on dy — hoist outside dx loop.
        let y0 = (dy as f32 * yr) as usize;
        let y1 = ((dy as f32 + 1.0) * yr).min(sh as f32) as usize;
        let y1 = y1.max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = ((dx as f32 + 1.0) * xr).min(sw as f32) as usize;
            let x1 = x1.max(x0 + 1);

            let (mut rr, mut gg, mut bb, mut n) = (0u32, 0u32, 0u32, 0u32);
            for y in y0..y1 {
                let row_base = y * sw;
                for x in x0..x1 {
                    let i = (row_base + x) * 3;
                    rr += src[i]     as u32;
                    gg += src[i + 1] as u32;
                    bb += src[i + 2] as u32;
                    n  += 1;
                }
            }
            let n = n.max(1);
            let rv = (rr / n) as u16;
            let gv = (gg / n) as u16;
            let bv = (bb / n) as u16;
            let o = (dy * dw + dx) * 6;
            out[o    ] = (rv & 0xff) as u8;
            out[o + 1] = (rv >> 8)   as u8;
            out[o + 2] = (gv & 0xff) as u8;
            out[o + 3] = (gv >> 8)   as u8;
            out[o + 4] = (bv & 0xff) as u8;
            out[o + 5] = (bv >> 8)   as u8;
        }
    }
    out
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
        return Err(JsError::new(&format!("ORF: {} pixels exceeds 50 MP limit", n)));
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
        if let Some(r) = info.wb_r { params.wb_r = r; }
        if let Some(b) = info.wb_b { params.wb_b = b; }
    } else {
        let (ar, ab) = pipeline::auto_wb_rggb(&raw, w, h, params.black);
        params.wb_r = ar;
        params.wb_b = ab;
    }
    let color_matrix_from_mn = info.color_matrix.is_some();
    if let Some(m) = info.color_matrix { params.color_matrix = Some(m); }

    // Capture which matrix will be used (MakerNote or fallback).
    let color_matrix_flat: [f32; 9] = {
        let m = params.color_matrix.unwrap_or(pipeline::CAM_TO_SRGB);
        [m[0][0],m[0][1],m[0][2], m[1][0],m[1][1],m[1][2], m[2][0],m[2][1],m[2][2]]
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

    // Compute lightbox + thumb rgb16 caches (pre-tonemap, pre-orientation).
    const LB_LONG_EDGE: usize = 1800;
    let (lb_w, lb_h) = if w >= h {
        let lw = w.min(LB_LONG_EDGE);
        (lw, ((h * lw) / w).max(1))
    } else {
        let lh = h.min(LB_LONG_EDGE);
        (((w * lh) / h).max(1), lh)
    };
    let rgb16_lb = downscale_rgb16_impl(&rgb16, w, h, lb_w, lb_h);

    const THUMB_LONG_EDGE: usize = 360;
    let (thumb_w, thumb_h) = if w >= h {
        let tw = w.min(THUMB_LONG_EDGE);
        (tw, ((h * tw) / w).max(1))
    } else {
        let th = h.min(THUMB_LONG_EDGE);
        (((w * th) / h).max(1), th)
    };
    let rgb16_thumb = downscale_rgb16_impl(&rgb16, w, h, thumb_w, thumb_h);

    let t = now_ms();
    if wb_r_override.is_finite() && wb_r_override > 0.0 {
        params.wb_r = wb_r_override.min(8.0);
    }
    if wb_b_override.is_finite() && wb_b_override > 0.0 {
        params.wb_b = wb_b_override.min(8.0);
    }
    if exposure_ev.is_finite()  { params.exposure_ev = exposure_ev; }
    if contrast.is_finite()     { params.contrast    = contrast; }
    if highlights.is_finite()   { params.highlights  = highlights; }
    if shadows.is_finite()      { params.shadows     = shadows; }
    if whites.is_finite()       { params.whites      = whites; }
    if blacks.is_finite()       { params.blacks      = blacks; }
    if saturation.is_finite()   { params.saturation  = saturation; }
    if vibrance.is_finite()     { params.vibrance    = vibrance; }
    if temp.is_finite()         { params.temp        = temp; }
    if tint.is_finite()         { params.tint        = tint; }
    if texture.is_finite()      { params.texture     = texture; }
    if clarity.is_finite()      { params.clarity     = clarity; }
    if params.texture != 0.0 || params.clarity != 0.0 {
        pipeline::apply_unsharp_masks(&mut rgb16, w, h, &params);
    }
    let rgb8 = pipeline::process(&rgb16, &params);
    let tonemap_ms = now_ms() - t;
    drop(rgb16);

    let t = now_ms();
    let (final_rgb, final_w, final_h) =
        pipeline::apply_orientation(&rgb8, w, h, info.orientation);
    let orient_ms = now_ms() - t;
    drop(rgb8);

    Ok(ProcessResult {
        rgb: final_rgb,
        width: final_w as u32,
        height: final_h as u32,
        orientation: info.orientation,
        decompress_ms,
        demosaic_ms,
        tonemap_ms,
        orient_ms,
        wb_r_used: params.wb_r,
        wb_b_used: params.wb_b,
        color_matrix_from_mn,
        make: info.make.clone(),
        model: info.model.clone(),
        rgb16_lb,
        lb_w: lb_w as u32,
        lb_h: lb_h as u32,
        rgb16_thumb,
        thumb_w: thumb_w as u32,
        thumb_h: thumb_h as u32,
        color_matrix_flat,
        lens: info.lens.clone(),
        datetime: info.datetime.clone(),
        // Rational fields use 0/0 as absent-sentinel (JS checks den==0 before dividing).
        exposure_num: info.exposure.map(|(n, _)| n).unwrap_or(0),
        exposure_den: info.exposure.map(|(_, d)| d).unwrap_or(0),
        fnumber_num:  info.fnumber.map(|(n, _)| n).unwrap_or(0),
        fnumber_den:  info.fnumber.map(|(_, d)| d).unwrap_or(0),
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
pub fn rotate_rgb8(src: &[u8], width: u32, height: u32, turns: u32) -> Result<RotateResult, JsError> {
    let w = width as usize;
    let h = height as usize;
    let expected = w.checked_mul(h).and_then(|n| n.checked_mul(3))
        .ok_or_else(|| JsError::new("rotate_rgb8: dimensions overflow"))?;
    if src.len() != expected {
        return Err(JsError::new(&format!(
            "rotate_rgb8: src length {} != {}×{}×3", src.len(), w, h
        )));
    }
    let (rgb, nw, nh) = match turns % 4 {
        0 => (src.to_vec(), w, h),
        1 => (pipeline::rotate_90_cw(src, w, h),  h, w),
        2 => (pipeline::rotate_180(src, w, h),     w, h),
        3 => (pipeline::rotate_90_ccw(src, w, h), h, w),
        _ => unreachable!(),
    };
    Ok(RotateResult { rgb, width: nw as u32, height: nh as u32 })
}

/// Box-filter downscale an RGB8 buffer.  Useful for thumbnail generation.
#[wasm_bindgen]
pub fn downscale_rgb(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
) -> Result<Vec<u8>, JsError> {
    let (sw, sh, dw, dh) = (src_w as usize, src_h as usize, dst_w as usize, dst_h as usize);
    let expected_len = sw.checked_mul(sh).and_then(|n| n.checked_mul(3))
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
    let xr = sw as f32 / dw as f32;
    let yr = sh as f32 / dh as f32;
    let mut out = vec![0u8; dw * dh * 3];
    for dy in 0..dh {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = ((dy as f32 + 1.0) * yr).min(sh as f32) as usize;
        let y1 = y1.max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = ((dx as f32 + 1.0) * xr).min(sw as f32) as usize;
            let x1 = x1.max(x0 + 1);

            let (mut rr, mut gg, mut bb, mut n) = (0u32, 0u32, 0u32, 0u32);
            for y in y0..y1 {
                let row_base = y * sw;
                for x in x0..x1 {
                    let i = (row_base + x) * 3;
                    rr += src[i] as u32;
                    gg += src[i + 1] as u32;
                    bb += src[i + 2] as u32;
                    n += 1;
                }
            }
            let n = n.max(1);
            let o = (dy * dw + dx) * 3;
            out[o] = (rr / n) as u8;
            out[o + 1] = (gg / n) as u8;
            out[o + 2] = (bb / n) as u8;
        }
    }
    Ok(out)
}

/// Re-apply tonemap + orientation to a cached lightbox-sized rgb16 buffer.
///
/// `rgb16_bytes` is packed u16 LE (6 bytes per pixel).
/// `color_matrix_flat` is 9 f32s row-major; pass a slice of len != 9 to use the
/// built-in fallback.
#[wasm_bindgen]
pub fn apply_look(
    rgb16_bytes: &[u8],
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
    // 1. Unpack u16 LE bytes → Vec<u16>
    let n = rgb16_bytes.len() / 2;
    let expected_pixels = (width as usize).checked_mul(height as usize)
        .ok_or_else(|| JsError::new("apply_look: dimensions overflow"))?;
    if n != expected_pixels * 3 {
        return Err(JsError::new(&format!(
            "apply_look: rgb16_bytes length {} != {}×{}×6",
            rgb16_bytes.len(), width, height
        )));
    }
    let mut rgb16: Vec<u16> = rgb16_bytes
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();

    // 2. Build PipelineParams
    let mut params = pipeline::PipelineParams::default_olympus();
    // Guard against 0/NaN/negative wb values from callers; use olympus defaults as fallback.
    if wb_r.is_finite() && wb_r > 0.0 { params.wb_r = wb_r; }
    if wb_b.is_finite() && wb_b > 0.0 { params.wb_b = wb_b; }
    // Falls back to built-in CAM_TO_SRGB if caller passes wrong-length slice.
    if color_matrix_flat.len() == 9 {
        let mut m = [[0f32; 3]; 3];
        for r in 0..3 {
            for c in 0..3 {
                m[r][c] = color_matrix_flat[r * 3 + c];
            }
        }
        params.color_matrix = Some(m);
    }
    if exposure_ev.is_finite()  { params.exposure_ev = exposure_ev; }
    if contrast.is_finite()     { params.contrast    = contrast; }
    if highlights.is_finite()   { params.highlights  = highlights; }
    if shadows.is_finite()      { params.shadows     = shadows; }
    if whites.is_finite()       { params.whites      = whites; }
    if blacks.is_finite()       { params.blacks      = blacks; }
    if saturation.is_finite()   { params.saturation  = saturation; }
    if vibrance.is_finite()     { params.vibrance    = vibrance; }
    if temp.is_finite()         { params.temp        = temp; }
    if tint.is_finite()         { params.tint        = tint; }
    if texture.is_finite()      { params.texture     = texture; }
    if clarity.is_finite()      { params.clarity     = clarity; }

    let w = width as usize;
    let h = height as usize;

    if params.texture != 0.0 || params.clarity != 0.0 {
        pipeline::apply_unsharp_masks(&mut rgb16, w, h, &params);
    }
    let rgb8 = pipeline::process(&rgb16, &params);
    let (final_rgb, _, _) = pipeline::apply_orientation(&rgb8, w, h, orientation);
    Ok(final_rgb)
}

/// Convert interleaved RGB8 → RGBA8 (alpha = 255).  HTML canvas wants RGBA.
// Input must be a multiple of 3 bytes; trailing bytes are ignored.
#[wasm_bindgen]
pub fn rgb_to_rgba(rgb: &[u8]) -> Vec<u8> {
    let n = rgb.len() / 3;
    let mut out = Vec::with_capacity(n * 4);
    for chunk in rgb.chunks_exact(3) {
        out.extend_from_slice(&[chunk[0], chunk[1], chunk[2], 255]);
    }
    out
}
