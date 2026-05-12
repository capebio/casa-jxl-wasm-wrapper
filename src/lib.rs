//! Browser entry point for the Olympus ORF → RGB pipeline.
//!
//! Exports `process_orf(bytes)` which parses an ORF blob, decompresses the
//! 12-bit predictive stream, demosaics RGGB → RGB, applies WB/sRGB tone curve
//! and EXIF orientation, returning an interleaved RGB8 buffer plus dims.
//!
//! Encoding (JXL / WebP) is left to JS via jSquash — keeps the wasm small.
//! All stages here are single-threaded; switch to `wasm-bindgen-rayon` if
//! the host can set COOP/COEP and we want to use Web Workers.

mod decompress;
mod demosaic;
mod pipeline;
mod tiff;

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
    color_matrix_flat: [f32; 9],
}

#[wasm_bindgen]
impl ProcessResult {
    #[wasm_bindgen(getter)]
    pub fn make(&self) -> String { self.make.clone() }
    #[wasm_bindgen(getter)]
    pub fn model(&self) -> String { self.model.clone() }
}

#[wasm_bindgen]
impl ProcessResult {
    /// Move the RGB buffer out as a `Uint8Array`.  Caller owns the bytes.
    pub fn take_rgb(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rgb)
    }

    /// Borrow the RGB buffer; copies into a fresh JS `Uint8Array`.
    pub fn rgb(&self) -> Vec<u8> {
        self.rgb.clone()
    }

    /// Move the lightbox-sized packed u16 LE buffer out.  Caller owns the bytes.
    pub fn take_rgb16_lb(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rgb16_lb)
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
        let y0 = (dy as f32 * yr) as usize;
        let y1 = (((dy as f32) + 1.0) * yr) as usize;
        let y1 = y1.min(sh).max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = (((dx as f32) + 1.0) * xr) as usize;
            let x1 = x1.min(sw).max(x0 + 1);

            let (mut rr, mut gg, mut bb, mut n) = (0u32, 0u32, 0u32, 0u32);
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * sw + x) * 3;
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

    let w = info.width as usize;
    let h = info.height as usize;
    let strip_end = info.strip_offset as usize + info.strip_byte_count as usize;
    if strip_end > data.len() {
        return Err(JsError::new("strip extends past end of file"));
    }
    let strip = &data[info.strip_offset as usize..strip_end];

    let t = now_ms();
    let raw = decompress::decompress(strip, w, h);
    let decompress_ms = now_ms() - t;

    let mut params = pipeline::PipelineParams::default_olympus();
    // Gray-world auto-WB whenever MakerNote didn't supply usable values;
    // far better than the hardcoded 1.78/1.50 daylight fallback when the
    // scene is mixed-light or the camera variant uses a tag layout we
    // don't parse yet.
    if info.wb_r.is_none() || info.wb_b.is_none() {
        let (ar, ab) = pipeline::auto_wb_rggb(&raw, w, h, params.black);
        if info.wb_r.is_none() { params.wb_r = ar; }
        if info.wb_b.is_none() { params.wb_b = ab; }
    } else {
        if let Some(r) = info.wb_r { params.wb_r = r; }
        if let Some(b) = info.wb_b { params.wb_b = b; }
    }
    let color_matrix_from_mn = info.color_matrix.is_some();
    if let Some(m) = info.color_matrix { params.color_matrix = Some(m); }

    // Capture which matrix will be used (MakerNote or fallback).
    let color_matrix_flat: [f32; 9] = {
        let m = params.color_matrix.unwrap_or(pipeline::CAM_TO_SRGB);
        [m[0][0],m[0][1],m[0][2], m[1][0],m[1][1],m[1][2], m[2][0],m[2][1],m[2][2]]
    };

    let t = now_ms();
    let mut rgb16 = demosaic::demosaic_rggb(&raw, w, h);
    let demosaic_ms = now_ms() - t;
    drop(raw);

    // Compute lightbox-sized rgb16 for live re-render cache (pre-tonemap, pre-orientation).
    const LB_LONG_EDGE: usize = 1800;
    let (lb_w, lb_h) = if w >= h {
        let lw = w.min(LB_LONG_EDGE);
        (lw, ((h * lw) / w).max(1))
    } else {
        let lh = h.min(LB_LONG_EDGE);
        (((w * lh) / h).max(1), lh)
    };
    let rgb16_lb = downscale_rgb16_impl(&rgb16, w, h, lb_w, lb_h);

    let t = now_ms();
    if wb_r_override.is_finite() && wb_r_override > 0.0 {
        params.wb_r = wb_r_override;
    }
    if wb_b_override.is_finite() && wb_b_override > 0.0 {
        params.wb_b = wb_b_override;
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
        color_matrix_flat,
    })
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
    if src.len() != sw * sh * 3 {
        return Err(JsError::new("src length mismatch"));
    }
    let xr = sw as f32 / dw as f32;
    let yr = sh as f32 / dh as f32;
    let mut out = vec![0u8; dw * dh * 3];
    for dy in 0..dh {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = (((dy as f32) + 1.0) * yr) as usize;
        let y1 = y1.min(sh).max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = (((dx as f32) + 1.0) * xr) as usize;
            let x1 = x1.min(sw).max(x0 + 1);

            let (mut rr, mut gg, mut bb, mut n) = (0u32, 0u32, 0u32, 0u32);
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * sw + x) * 3;
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
    let mut rgb16: Vec<u16> = (0..n)
        .map(|i| u16::from_le_bytes([rgb16_bytes[i * 2], rgb16_bytes[i * 2 + 1]]))
        .collect();

    // 2. Build PipelineParams
    let mut params = pipeline::PipelineParams::default_olympus();
    params.wb_r = wb_r;
    params.wb_b = wb_b;
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
#[wasm_bindgen]
pub fn rgb_to_rgba(rgb: &[u8]) -> Vec<u8> {
    let n = rgb.len() / 3;
    let mut out = Vec::with_capacity(n * 4);
    for i in 0..n {
        out.push(rgb[i * 3]);
        out.push(rgb[i * 3 + 1]);
        out.push(rgb[i * 3 + 2]);
        out.push(255);
    }
    out
}
