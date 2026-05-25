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

    /// Return the color matrix used (9 floats, row-major).
    pub fn color_matrix_used(&self) -> Vec<f32> {
        self.color_matrix_flat.to_vec()
    }
}

fn now_ms() -> f64 {
    let perf = web_sys::window().and_then(|w| w.performance()).or_else(|| {
        js_sys::global()
            .dyn_into::<web_sys::WorkerGlobalScope>()
            .ok()
            .and_then(|w| w.performance())
    });
    perf.map(|p| p.now()).unwrap_or(0.0)
}

#[allow(clippy::too_many_arguments)]
fn apply_look_params(
    params: &mut pipeline::PipelineParams,
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
                    rr += src[i] as u32;
                    gg += src[i + 1] as u32;
                    bb += src[i + 2] as u32;
                    n += 1;
                }
            }
            let n = n.max(1);
            let rv = (rr / n) as u16;
            let gv = (gg / n) as u16;
            let bv = (bb / n) as u16;
            let o = (dy * dw + dx) * 6;
            out[o] = (rv & 0xff) as u8;
            out[o + 1] = (rv >> 8) as u8;
            out[o + 2] = (gv & 0xff) as u8;
            out[o + 3] = (gv >> 8) as u8;
            out[o + 4] = (bv & 0xff) as u8;
            out[o + 5] = (bv >> 8) as u8;
        }
    }
    out
}

fn unpack_rgb16_le(src: &[u8]) -> Vec<u16> {
    src.chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect()
}

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
    } = decoded;

    let (lb_w, lb_h) = target_dims(w, h, 1800);
    let (rgb16_lb, out_lb_w, out_lb_h) = if output_flags & OUT_LIGHTBOX != 0 {
        let lb = downscale_rgb16_impl(&rgb16, w, h, lb_w, lb_h);
        (lb, lb_w, lb_h)
    } else {
        (vec![], 0, 0)
    };

    let (thumb_w, thumb_h) = target_dims(w, h, 360);
    let (rgb16_thumb, out_thumb_w, out_thumb_h) = if output_flags & OUT_THUMB != 0 {
        let thumb = if output_flags & OUT_LIGHTBOX != 0 {
            downscale_rgb16_impl(&unpack_rgb16_le(&rgb16_lb), lb_w, lb_h, thumb_w, thumb_h)
        } else {
            downscale_rgb16_impl(&rgb16, w, h, thumb_w, thumb_h)
        };
        (thumb, thumb_w, thumb_h)
    } else {
        (vec![], 0, 0)
    };

    if look.wb_r.is_finite() && look.wb_r > 0.0 {
        params.wb_r = look.wb_r.min(8.0);
    }
    if look.wb_b.is_finite() && look.wb_b > 0.0 {
        params.wb_b = look.wb_b.min(8.0);
    }
    apply_look_params(
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
        let rgb8 = pipeline::process(&rgb16, &params);
        let tonemap_ms = now_ms() - t;
        drop(rgb16);
        let t2 = now_ms();
        let (fr, fw, fh) = if info.orientation == 1 {
            (rgb8, w, h)
        } else {
            pipeline::apply_orientation(&rgb8, w, h, info.orientation)
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
/// Pass `7` to match the behaviour of `process_orf`.
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

/// Box-filter downscale an RGBA8 buffer.  Useful for thumbnail generation.
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
    let xr = sw as f32 / dw as f32;
    let yr = sh as f32 / dh as f32;
    let mut out = vec![0u8; dw * dh * 4];
    for dy in 0..dh {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = ((dy as f32 + 1.0) * yr).min(sh as f32) as usize;
        let y1 = y1.max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = ((dx as f32 + 1.0) * xr).min(sw as f32) as usize;
            let x1 = x1.max(x0 + 1);
            let (mut rr, mut gg, mut bb, mut aa, mut n) = (0u32, 0u32, 0u32, 0u32, 0u32);
            for y in y0..y1 {
                let row_base = y * sw;
                for x in x0..x1 {
                    let i = (row_base + x) * 4;
                    rr += src[i] as u32;
                    gg += src[i + 1] as u32;
                    bb += src[i + 2] as u32;
                    aa += src[i + 3] as u32;
                    n += 1;
                }
            }
            let n = n.max(1);
            let o = (dy * dw + dx) * 4;
            out[o] = (rr / n) as u8;
            out[o + 1] = (gg / n) as u8;
            out[o + 2] = (bb / n) as u8;
            out[o + 3] = (aa / n) as u8;
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
    apply_look_params(
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
        let (final_rgb, _, _) = pipeline::apply_orientation(&rgb8, w, h, orientation);
        Ok(final_rgb)
    }
}

/// Convert interleaved RGB8 → RGBA8 (alpha = 255).  HTML canvas wants RGBA.
// Input must be a multiple of 3 bytes; trailing bytes are ignored.
#[wasm_bindgen]
pub fn rgb_to_rgba(rgb: &[u8]) -> Vec<u8> {
    let n = rgb.len() / 3;
    let mut out = vec![0u8; n * 4];
    for (src, dst) in rgb.chunks_exact(3).zip(out.chunks_exact_mut(4)) {
        dst[0] = src[0];
        dst[1] = src[1];
        dst[2] = src[2];
        dst[3] = 255;
    }
    out
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
            color_matrix,
        })
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
        apply_look_params(
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

        if self.orientation == 1 {
            Ok(rgb8)
        } else {
            let (final_rgb, _, _) =
                pipeline::apply_orientation(&rgb8, self.width, self.height, self.orientation);
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

    let t = now_ms();
    let dng_img = raw_pipeline::dng::decode_bytes(data)
        .map_err(|e| JsError::new(&format!("DNG decode: {}", e)))?;
    let decode_ms = now_ms() - t;

    let w = dng_img.width;
    let h = dng_img.height;
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

    // Align to RGGB (CFA-dependent)
    let (raw_aligned, aw, ah) = raw_pipeline::dng::align_to_rggb(&dng_img.raw, w, h, dng_img.cfa);

    let t = now_ms();
    let mut rgb16 = demosaic::demosaic_rggb_mhc(&raw_aligned, aw, ah)
        .map_err(|e| JsError::new(&format!("demosaic: {}", e)))?;
    let demosaic_ms = now_ms() - t;

    // Build pipeline params from DNG metadata
    let mut params = pipeline::PipelineParams::default_olympus();
    params.black = dng_img.black;
    params.white = dng_img.white;
    params.wb_r = dng_img.wb_r;
    params.wb_b = dng_img.wb_b;
    params.color_matrix = dng_img.color_matrix;
    let color_matrix_flat: [f32; 9] = {
        let m = params.color_matrix.unwrap_or(pipeline::CAM_TO_SRGB);
        [
            m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2],
        ]
    };

    // TODO(G3): raw_pipeline::dng::DngImage does not expose ISO; use a fixed
    // fallback until upstream surfaces it.
    let iso = 100u32;
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
        orientation: dng_img.orientation,
        make: dng_img.make,
        model: dng_img.model,
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
            downscale_rgb16_impl(&unpack_rgb16_le(&rgb16_lb), lb_w, lb_h, thumb_w, thumb_h)
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
    apply_look_params(
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
        let (fr, fw, fh) = if orientation == 1 {
            (rgb8, aw, ah)
        } else {
            pipeline::apply_orientation(&rgb8, aw, ah, orientation)
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
/// Single-threaded (no rayon in WASM).  Look params: LR-style (-1..+1), except
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
