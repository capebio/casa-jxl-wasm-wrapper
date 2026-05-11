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
    make: String,
    model: String,
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

    let t = now_ms();
    let rgb16 = demosaic::demosaic_rggb(&raw, w, h);
    let demosaic_ms = now_ms() - t;
    drop(raw);

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
        make: info.make.clone(),
        model: info.model.clone(),
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
