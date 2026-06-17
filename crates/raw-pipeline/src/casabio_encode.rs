//! Shared "encode 3 JXL variants for Casabio" routine.
//! Inputs RGBA8 + dimensions + source type + HQ override.
//! Outputs three JXL byte buffers plus the chosen fullsize quality.

use jpegxl_rs::encode::EncoderResult;
use jpegxl_rs::encoder_builder;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceType {
    Jpeg,
    Raw,
    Other,
}

#[derive(Debug)]
pub struct VariantSet {
    pub thumb_300: Vec<u8>,
    pub preview_1080: Vec<u8>,
    pub full: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub thumb_w: u32,
    pub thumb_h: u32,
    pub preview_w: u32,
    pub preview_h: u32,
    pub full_quality: u8,
    /// True if the input RGBA had any pixel with alpha < 255.
    /// When false the three encoded variants are RGB (no extra channel).
    pub has_alpha: bool,
}

#[derive(thiserror::Error, Debug)]
pub enum EncodeError {
    #[error("encoder failed: {0}")]
    Jxl(String),
    #[error("resize failed")]
    Resize,
    #[error("invalid input: expected {expected} bytes, got {got}")]
    Input { expected: usize, got: usize },
    #[error("cancelled")]
    Cancelled,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ProgressiveOpts {
    pub progressive_dc: u32,
    pub group_order: u32,
    pub center: Option<(u32, u32)>,
}

pub fn encode_variants(
    rgba: &[u8],
    width: u32,
    height: u32,
    source: SourceType,
    hq_override: bool,
) -> Result<VariantSet, EncodeError> {
    encode_variants_progressive_opts(rgba, width, height, source, hq_override, ProgressiveOpts::default())
}

pub fn encode_variants_with_progressive(
    rgba: &[u8],
    width: u32,
    height: u32,
    source: SourceType,
    hq_override: bool,
    progressive_dc: u32,
    group_order: u32,
) -> Result<VariantSet, EncodeError> {
    encode_variants_progressive_opts(rgba, width, height, source, hq_override, ProgressiveOpts {
        progressive_dc,
        group_order,
        center: None,
    })
}

pub fn encode_variants_progressive_opts(
    rgba: &[u8],
    width: u32,
    height: u32,
    source: SourceType,
    hq_override: bool,
    opts: ProgressiveOpts,
) -> Result<VariantSet, EncodeError> {
    encode_variants_cancellable(rgba, width, height, source, hq_override, opts, &std::sync::atomic::AtomicBool::new(false))
}

pub fn encode_variants_cancellable(
    rgba: &[u8],
    width: u32,
    height: u32,
    source: SourceType,
    hq_override: bool,
    opts: ProgressiveOpts,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<VariantSet, EncodeError> {
    if cancel.load(std::sync::atomic::Ordering::Relaxed) { return Err(EncodeError::Cancelled); }
    if width == 0 || height == 0 || rgba.len() != (width as usize * height as usize * 4) {
        return Err(EncodeError::Input { expected: width as usize * height as usize * 4, got: rgba.len() });
    }

    // Detect alpha once from the full-res input; all variant encode calls use this result.
    // RAW images always have alpha=255 → false → 3ch RGB encode path (fast, no extra-channel issues).
    let has_alpha = has_meaningful_alpha(rgba);

    let full_quality: u8 = if hq_override {
        95
    } else if source == SourceType::Raw {
        90  // Pixel 9 DNG optimized: Q90/E3 balance speed + quality
    } else {
        85
    };

    let max_dim = width.max(height);

    // Cascade resizing: full -> preview (1080) -> thumb (300)
    let (preview_rgba, pw, ph) = if max_dim > 1080 {
        let scale = 1080.0 / max_dim as f32;
        let dw = (width as f32 * scale).round().max(1.0) as u32;
        let dh = (height as f32 * scale).round().max(1.0) as u32;
        (Some(resize_rgba(rgba, width, height, dw, dh)?), dw, dh)
    } else {
        (None, width, height)
    };
    if cancel.load(std::sync::atomic::Ordering::Relaxed) { return Err(EncodeError::Cancelled); }

    let preview_src: &[u8] = preview_rgba.as_deref().unwrap_or(rgba);

    let (thumb_rgba, tw, th) = if pw.max(ph) > 300 {
        let scale = 300.0 / pw.max(ph) as f32;
        let dw = (pw as f32 * scale).round().max(1.0) as u32;
        let dh = (ph as f32 * scale).round().max(1.0) as u32;
        (Some(resize_rgba(preview_src, pw, ph, dw, dh)?), dw, dh)
    } else {
        (None, pw, ph)
    };
    if cancel.load(std::sync::atomic::Ordering::Relaxed) { return Err(EncodeError::Cancelled); }

    let thumb_src: &[u8] = thumb_rgba.as_deref().unwrap_or(preview_src);

    let preview_opts = ProgressiveOpts {
        progressive_dc: 0,
        group_order: opts.group_order,
        center: opts.center,
    };
    let thumb_opts = ProgressiveOpts::default();

    #[cfg(feature = "parallel")]
    let (thumb_300, preview_1080, full) = {
        let (thumb_res, (preview_res, full_res)) = rayon::join(
            || {
                if cancel.load(std::sync::atomic::Ordering::Relaxed) { return Err(EncodeError::Cancelled); }
                encode_one(thumb_src, width, height, tw, th, 85, thumb_opts, jpegxl_rs::encode::EncoderSpeed::Lightning, has_alpha)
            },
            || rayon::join(
                || {
                    if cancel.load(std::sync::atomic::Ordering::Relaxed) { return Err(EncodeError::Cancelled); }
                    encode_one(preview_src, width, height, pw, ph, 85, preview_opts, jpegxl_rs::encode::EncoderSpeed::Falcon, has_alpha)
                },
                || {
                    if cancel.load(std::sync::atomic::Ordering::Relaxed) { return Err(EncodeError::Cancelled); }
                    encode_one(rgba, width, height, width, height, full_quality, opts, jpegxl_rs::encode::EncoderSpeed::Falcon, has_alpha)
                }
            )
        );
        (thumb_res?, preview_res?, full_res?)
    };

    #[cfg(not(feature = "parallel"))]
    let (thumb_300, preview_1080, full) = {
        let t = encode_one(thumb_src, width, height, tw, th, 85, thumb_opts, jpegxl_rs::encode::EncoderSpeed::Lightning, has_alpha)?;
        if cancel.load(std::sync::atomic::Ordering::Relaxed) { return Err(EncodeError::Cancelled); }
        let p = encode_one(preview_src, width, height, pw, ph, 85, preview_opts, jpegxl_rs::encode::EncoderSpeed::Falcon, has_alpha)?;
        if cancel.load(std::sync::atomic::Ordering::Relaxed) { return Err(EncodeError::Cancelled); }
        let f = encode_one(rgba, width, height, width, height, full_quality, opts, jpegxl_rs::encode::EncoderSpeed::Falcon, has_alpha)?;
        (t, p, f)
    };

    Ok(VariantSet {
        thumb_300,
        preview_1080,
        full,
        width,
        height,
        thumb_w: tw,
        thumb_h: th,
        preview_w: pw,
        preview_h: ph,
        full_quality,
        has_alpha,
    })
}

// JxlEncoderFrameSettingId values from libjxl encode.h
// JXL_ENC_FRAME_SETTING_GROUP_ORDER = 13
const JXL_ENC_FRAME_SETTING_GROUP_ORDER: i32 = 13;
// JXL_ENC_FRAME_SETTING_PROGRESSIVE_DC = 19
const JXL_ENC_FRAME_SETTING_PROGRESSIVE_DC: i32 = 19;

fn encode_one(
    pixels: &[u8],
    orig_w: u32,
    orig_h: u32,
    w: u32,
    h: u32,
    quality: u8,
    opts: ProgressiveOpts,
    speed: jpegxl_rs::encode::EncoderSpeed,
    has_alpha: bool,
) -> Result<Vec<u8>, EncodeError> {
    let (pixels_ref, num_channels): (&[u8], u32) = if has_alpha {
        (pixels, 4)
    } else {
        // RAW images always have alpha=255; strip to RGB for smaller output + no extra-channel setup.
        // Caller retains the RGBA buffer so we allocate here.
        let rgb = rgba_to_rgb(pixels);
        // SAFETY: we need a longer lifetime; encode_one is the owner for the scope below.
        // Use a local Vec bound to this function body.
        return encode_one_inner(rgb.as_slice(), w, h, 3, quality, opts, speed, orig_w, orig_h);
    };
    encode_one_inner(pixels_ref, w, h, num_channels, quality, opts, speed, orig_w, orig_h)
}

#[allow(clippy::too_many_arguments)]
fn encode_one_inner(
    pixels: &[u8],
    w: u32,
    h: u32,
    num_channels: u32,
    quality: u8,
    opts: ProgressiveOpts,
    speed: jpegxl_rs::encode::EncoderSpeed,
    orig_w: u32,
    orig_h: u32,
) -> Result<Vec<u8>, EncodeError> {
    let mut enc = encoder_builder()
        .speed(speed)
        .has_alpha(num_channels == 4)
        .jpeg_quality(quality as f32)
        .build()
        .map_err(|e| EncodeError::Jxl(e.to_string()))?;

    // Wire progressive for Tauri/raw-pipeline direct encode parity (predator).
    if opts.progressive_dc > 0 {
        let opt = unsafe { std::mem::transmute(JXL_ENC_FRAME_SETTING_PROGRESSIVE_DC) };
        enc.set_frame_option(opt, opts.progressive_dc as i64)
            .map_err(|e| EncodeError::Jxl(e.to_string()))?;
    }
    if opts.group_order > 0 {
        let opt = unsafe { std::mem::transmute(JXL_ENC_FRAME_SETTING_GROUP_ORDER) };
        enc.set_frame_option(opt, opts.group_order as i64)
            .map_err(|e| EncodeError::Jxl(e.to_string()))?;
        if let Some((cx, cy)) = opts.center {
            let scale_x = w as f32 / orig_w as f32;
            let scale_y = h as f32 / orig_h as f32;
            let cx_scaled = (cx as f32 * scale_x) as i64;
            let cy_scaled = (cy as f32 * scale_y) as i64;
            let _ = enc.set_frame_option(unsafe { std::mem::transmute(14i32) }, cx_scaled);
            let _ = enc.set_frame_option(unsafe { std::mem::transmute(15i32) }, cy_scaled);
        }
    }

    use jpegxl_rs::encode::EncoderFrame;
    let frame = EncoderFrame::new(pixels).num_channels(num_channels);
    let result: EncoderResult<u8> = enc
        .encode_frame(&frame, w, h)
        .map_err(|e| EncodeError::Jxl(e.to_string()))?;
    Ok(result.data)
}

fn resize_rgba(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Result<Vec<u8>, EncodeError> {
    use image::{imageops, ImageBuffer, Rgba};
    let img: ImageBuffer<Rgba<u8>, &[u8]> =
        ImageBuffer::from_raw(sw, sh, src).ok_or(EncodeError::Resize)?;
    let resized = imageops::resize(&img, dw, dh, imageops::FilterType::Lanczos3);
    Ok(resized.into_raw())
}

/// Convenience for Tauri/native encode flows that hold pre-tone RGB16 + params
/// (the output of demosaic etc). Produces the three JXL variants directly from
/// the 16-bit buffer using `pipeline::process_rgba` internally. This is the
/// "direct feed" path: the 3ch RGB8 is never allocated or retained for callers
/// whose only use of the toned pixels is to encode them (gallery ingest, export).
#[cfg(feature = "jxl-encode")]
pub fn encode_variants_from_rgb16(
    rgb16: &[u16],
    params: &crate::pipeline::PipelineParams,
    width: u32,
    height: u32,
    source: SourceType,
    hq_override: bool,
) -> Result<VariantSet, EncodeError> {
    encode_variants_from_rgb16_with_progressive(rgb16, params, width, height, source, hq_override, 0, 0)
}

/// Like encode_variants_from_rgb16 but with progressive_dc / group_order (for Tauri progressive gallery/exports).
#[cfg(feature = "jxl-encode")]
pub fn encode_variants_from_rgb16_with_progressive(
    rgb16: &[u16],
    params: &crate::pipeline::PipelineParams,
    width: u32,
    height: u32,
    source: SourceType,
    hq_override: bool,
    progressive_dc: u32,
    group_order: u32,
) -> Result<VariantSet, EncodeError> {
    let rgba = if params.texture != 0.0 || params.clarity != 0.0 {
        let mut rgb16_mut = rgb16.to_vec();
        crate::pipeline::apply_unsharp_masks(&mut rgb16_mut, width as usize, height as usize, params);
        crate::pipeline::process_rgba(&rgb16_mut, params)
    } else {
        crate::pipeline::process_rgba(rgb16, params)
    };
    encode_variants_with_progressive(&rgba, width, height, source, hq_override, progressive_dc, group_order)
}

// PR-6b: native sidecar pyramid encoder (v2 per-level distances, no 1.5 floor, box cascade).
// Matches WASM encodeRgba8Pyramid + BoxDownscaleRgba8 + EncodeRgba8WithSidecars v2 semantics for M1 8-bit.
// Returns levels smallest-first (sidecars), full last. All 8-bit.
// JPG masters use this only for sidecars (full level is separate lossless transcode in ingest ladder).
// Effort param accepted for signature parity with WASM; speed fixed to Falcon (fast ingest path, matches current variants).

#[derive(Debug, Clone)]
pub struct PyramidLevel {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub bits_per_sample: u8,
}

fn jpeg_quality_for_distance(d: f32) -> f32 {
    if d <= 0.01 { 100.0 } else { (100.0 - (d - 0.1) / 0.09).clamp(30.0, 100.0) }
}

/// Returns true if any pixel has alpha < 255.
/// RAW images always have alpha=255 → returns false → fast 3ch RGB path.
fn has_meaningful_alpha(rgba: &[u8]) -> bool {
    rgba.chunks_exact(4).any(|px| px[3] < 255)
}

/// Strip alpha: RGBA8 interleaved → RGB8 interleaved.
fn rgba_to_rgb(rgba: &[u8]) -> Vec<u8> {
    let n = rgba.len() / 4;
    let mut rgb = Vec::with_capacity(n * 3);
    for px in rgba.chunks_exact(4) {
        rgb.push(px[0]);
        rgb.push(px[1]);
        rgb.push(px[2]);
    }
    rgb
}

/// Encode RGBA8 (4ch) directly via jpegxl-sys, calling JxlEncoderSetExtraChannelInfo
/// to satisfy encode.cc:864 strict extra-channel init check.
/// Reference sys path; jpegxl-rs now patched to call this internally.
/// Only compiled when jxl-lowlevel is active (jpegxl-sys dep is available).
#[cfg(feature = "jxl-lowlevel")]
#[allow(dead_code)]
fn encode_rgba4_sys(
    pixels: &[u8],     // RGBA8, exactly w×h×4 bytes (already sized for target dims)
    w: u32,
    h: u32,
    distance: f32,     // butteraugli distance
    effort: i64,       // 1..10 libjxl speed/effort
    progressive_dc: i64,
    group_order: i64,
    center: Option<(i64, i64)>,
) -> Result<Vec<u8>, EncodeError> {
    use std::ffi::c_void;
    use std::mem::MaybeUninit;
    use jpegxl_sys::encoder::encode::{
        JxlEncoderAddImageFrame, JxlEncoderCloseInput, JxlEncoderCreate,
        JxlEncoderDestroy, JxlEncoderFrameSettingId, JxlEncoderFrameSettingsCreate,
        JxlEncoderFrameSettingsSetOption, JxlEncoderInitBasicInfo,
        JxlEncoderInitExtraChannelInfo, JxlEncoderProcessOutput, JxlEncoderSetBasicInfo,
        JxlEncoderSetExtraChannelInfo, JxlEncoderSetFrameDistance, JxlEncoderSetFrameLossless,
        JxlEncoderStatus,
    };
    use jpegxl_sys::metadata::codestream_header::{JxlExtraChannelInfo, JxlExtraChannelType};
    use jpegxl_sys::common::types::{JxlBool, JxlDataType, JxlEndianness, JxlPixelFormat};

    unsafe {
        let enc = JxlEncoderCreate(std::ptr::null());
        if enc.is_null() {
            return Err(EncodeError::Jxl("JxlEncoderCreate failed".into()));
        }

        // Basic info: RGB + 1 alpha extra channel
        let mut info = MaybeUninit::uninit();
        JxlEncoderInitBasicInfo(info.as_mut_ptr());
        let mut info = info.assume_init();
        info.xsize = w;
        info.ysize = h;
        info.bits_per_sample = 8;
        info.exponent_bits_per_sample = 0;
        info.num_extra_channels = 1;
        info.alpha_bits = 8;
        info.alpha_exponent_bits = 0;
        info.alpha_premultiplied = JxlBool::False;

        if JxlEncoderSetBasicInfo(enc, &info) != JxlEncoderStatus::Success {
            JxlEncoderDestroy(enc);
            return Err(EncodeError::Jxl("JxlEncoderSetBasicInfo failed".into()));
        }

        // Extra channel init — satisfies David's encode.cc:864 check
        let mut ch_info = MaybeUninit::<JxlExtraChannelInfo>::uninit();
        JxlEncoderInitExtraChannelInfo(JxlExtraChannelType::Alpha, ch_info.as_mut_ptr());
        let ch_info = ch_info.assume_init();
        if JxlEncoderSetExtraChannelInfo(enc, 0, &ch_info) != JxlEncoderStatus::Success {
            JxlEncoderDestroy(enc);
            return Err(EncodeError::Jxl("JxlEncoderSetExtraChannelInfo failed".into()));
        }

        // Frame settings
        let fs = JxlEncoderFrameSettingsCreate(enc, std::ptr::null());
        if fs.is_null() {
            JxlEncoderDestroy(enc);
            return Err(EncodeError::Jxl("JxlEncoderFrameSettingsCreate failed".into()));
        }
        JxlEncoderSetFrameLossless(fs, JxlBool::False);
        JxlEncoderSetFrameDistance(fs, distance);
        JxlEncoderFrameSettingsSetOption(fs, JxlEncoderFrameSettingId::Effort, effort);
        if progressive_dc > 0 {
            JxlEncoderFrameSettingsSetOption(fs, JxlEncoderFrameSettingId::ProgressiveDc, progressive_dc);
        }
        if group_order > 0 {
            JxlEncoderFrameSettingsSetOption(fs, JxlEncoderFrameSettingId::GroupOrder, group_order);
            if let Some((cx, cy)) = center {
                JxlEncoderFrameSettingsSetOption(fs, JxlEncoderFrameSettingId::GroupOrderCenterX, cx);
                JxlEncoderFrameSettingsSetOption(fs, JxlEncoderFrameSettingId::GroupOrderCenterY, cy);
            }
        }

        // Add frame (RGBA8)
        let pf = JxlPixelFormat {
            num_channels: 4,
            data_type: JxlDataType::Uint8,
            endianness: JxlEndianness::Native,
            align: 0,
        };
        if JxlEncoderAddImageFrame(fs, &pf, pixels.as_ptr() as *const c_void, pixels.len())
            != JxlEncoderStatus::Success
        {
            JxlEncoderDestroy(enc);
            return Err(EncodeError::Jxl("JxlEncoderAddImageFrame failed".into()));
        }
        JxlEncoderCloseInput(enc);

        // Drain output
        let mut out = Vec::<u8>::new();
        let mut buf = vec![0u8; 1 << 17]; // 128 KiB
        loop {
            let mut next = buf.as_mut_ptr();
            let mut avail = buf.len();
            match JxlEncoderProcessOutput(enc, &mut next, &mut avail) {
                JxlEncoderStatus::Success => {
                    out.extend_from_slice(&buf[..buf.len() - avail]);
                    break;
                }
                JxlEncoderStatus::NeedMoreOutput => {
                    out.extend_from_slice(&buf[..buf.len() - avail]);
                }
                JxlEncoderStatus::Error => {
                    JxlEncoderDestroy(enc);
                    return Err(EncodeError::Jxl("JxlEncoderProcessOutput error".into()));
                }
            }
        }

        JxlEncoderDestroy(enc);
        Ok(out)
    }
}

fn map_effort_to_speed(effort: u32) -> jpegxl_rs::encode::EncoderSpeed {
    use jpegxl_rs::encode::EncoderSpeed::*;
    match effort {
        1 => Lightning,
        2 => Thunder,
        3 => Falcon,
        4 => Cheetah,
        5 => Hare,
        6 => Wombat,
        7 => Squirrel,
        8 => Kitten,
        9 => Tortoise,
        10 => Glacier,
        _ => Falcon,
    }
}

fn box_downscale_rgba8(src: &[u8], sw: u32, sh: u32, dst: &mut [u8], dw: u32, dh: u32) {
    if dw == 0 || dh == 0 { return; }
    let src_len = (sw as usize) * (sh as usize) * 4;
    let dst_len = (dw as usize) * (dh as usize) * 4;
    if src.len() < src_len || dst.len() < dst_len { return; }

    // exact integer fast path (matches C++ IMPROVEMENT-5)
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        for dy in 0..dh {
            for dx in 0..dw {
                let mut r = 0u32; let mut g = 0u32; let mut b = 0u32; let mut a = 0u32; let mut count = 0u32;
                for yy in 0..ystep {
                    let y = dy * ystep + yy;
                    let row = &src[(y as usize * sw as usize * 4)..];
                    for xx in 0..xstep {
                        let x = dx * xstep + xx;
                        let px = &row[(x as usize * 4)..];
                        r += px[0] as u32; g += px[1] as u32; b += px[2] as u32; a += px[3] as u32;
                        count += 1;
                    }
                }
                let out = &mut dst[(dy as usize * dw as usize + dx as usize) * 4..];
                out[0] = (r / count) as u8;
                out[1] = (g / count) as u8;
                out[2] = (b / count) as u8;
                out[3] = (a / count) as u8;
            }
        }
        return;
    }

    // general coverage (ceiling for end)
    for dy in 0..dh {
        let y0 = (dy * sh) / dh;
        let y1 = ((dy + 1) * sh + dh - 1) / dh;
        for dx in 0..dw {
            let x0 = (dx * sw) / dw;
            let x1 = ((dx + 1) * sw + dw - 1) / dw;
            let mut r = 0u32; let mut g = 0u32; let mut b = 0u32; let mut a = 0u32; let mut count = 0u32;
            for sy in y0..y1 {
                let row = &src[(sy as usize * sw as usize * 4)..];
                for sx in x0..x1 {
                    let px = &row[(sx as usize * 4)..];
                    r += px[0] as u32; g += px[1] as u32; b += px[2] as u32; a += px[3] as u32;
                    count += 1;
                }
            }
            let out = &mut dst[(dy as usize * dw as usize + dx as usize) * 4..];
            out[0] = (r / count) as u8;
            out[1] = (g / count) as u8;
            out[2] = (b / count) as u8;
            out[3] = (a / count) as u8;
        }
    }
}

fn encode_one_distance(pixels: &[u8], w: u32, h: u32, distance: f32, effort: u32, has_alpha: bool) -> Result<Vec<u8>, EncodeError> {
    use jpegxl_rs::encode::EncoderFrame;
    if has_alpha {
        let mut enc = encoder_builder()
            .speed(map_effort_to_speed(effort))
            .has_alpha(true)
            .jpeg_quality(jpeg_quality_for_distance(distance))
            .build()
            .map_err(|e| EncodeError::Jxl(e.to_string()))?;
        let frame = EncoderFrame::new(pixels).num_channels(4);
        let result: EncoderResult<u8> = enc
            .encode_frame(&frame, w, h)
            .map_err(|e| EncodeError::Jxl(e.to_string()))?;
        return Ok(result.data);
    }
    let rgb = rgba_to_rgb(pixels);
    let mut enc = encoder_builder()
        .speed(map_effort_to_speed(effort))
        .jpeg_quality(jpeg_quality_for_distance(distance))
        .build()
        .map_err(|e| EncodeError::Jxl(e.to_string()))?;
    let frame = EncoderFrame::new(&rgb).num_channels(3);
    let result: EncoderResult<u8> = enc
        .encode_frame(&frame, w, h)
        .map_err(|e| EncodeError::Jxl(e.to_string()))?;
    Ok(result.data)
}

#[cfg(feature = "jxl-encode")]
pub fn encode_rgba8_pyramid(
    rgba: &[u8],
    width: u32,
    height: u32,
    full_distance: f32,
    sidecar_sizes: &[u32],
    sidecar_distances: &[f32],
    effort: u32,
) -> Result<Vec<PyramidLevel>, EncodeError> {
    if rgba.is_empty() || width == 0 || height == 0 {
        return Err(EncodeError::Jxl("empty or zero-dim input".into()));
    }
    if sidecar_sizes.len() != sidecar_distances.len() {
        return Err(EncodeError::Jxl("sidecar_sizes and sidecar_distances length mismatch".into()));
    }
    let longer = width.max(height);

    #[derive(Clone, Copy)]
    struct Sc { tw: u32, th: u32, dist: f32 }
    let mut scs: Vec<Sc> = Vec::new();
    for (i, &max_dim) in sidecar_sizes.iter().enumerate() {
        if max_dim == 0 || max_dim >= longer { continue; }
        let (tw, th) = if width >= height {
            let tw = max_dim;
            let th = std::cmp::max(1u32, (((max_dim as u64 * height as u64) + (width as u64 / 2)) / (width as u64)) as u32);
            (tw, th)
        } else {
            let th = max_dim;
            let tw = std::cmp::max(1u32, (((max_dim as u64 * width as u64) + (height as u64 / 2)) / (height as u64)) as u32);
            (tw, th)
        };
        scs.push(Sc { tw, th, dist: sidecar_distances[i] });
    }

    let has_alpha = has_meaningful_alpha(rgba);
    let mut current = rgba.to_vec();
    let mut cw = width;
    let mut ch = height;
    let mut sides: Vec<PyramidLevel> = Vec::new();
    for sc in scs.iter().rev() {
        let mut thumb = vec![0u8; sc.tw as usize * sc.th as usize * 4];
        box_downscale_rgba8(&current, cw, ch, &mut thumb, sc.tw, sc.th);
        let data = encode_one_distance(&thumb, sc.tw, sc.th, sc.dist, effort, has_alpha)?;
        sides.push(PyramidLevel { data, width: sc.tw, height: sc.th, bits_per_sample: 8 });
        current = thumb;
        cw = sc.tw;
        ch = sc.th;
    }
    sides.reverse();

    let full = encode_one_distance(rgba, width, height, full_distance, effort, has_alpha)?;
    sides.push(PyramidLevel { data: full, width, height, bits_per_sample: 8 });
    Ok(sides)
}

/// Convenience for Tauri/native pyramid ingest (PR-7b) that holds pre-tone RGB16 + params.
/// Produces 8-bit pyramid levels (M1) directly from the internal rgb16 buffer (like
/// encode_variants_from_rgb16). For M3 this will be extended with 16-bit big levels.
#[cfg(feature = "jxl-encode")]
pub fn encode_rgba8_pyramid_from_rgb16(
    rgb16: &[u16],
    params: &crate::pipeline::PipelineParams,
    width: u32,
    height: u32,
    full_distance: f32,
    sidecar_sizes: &[u32],
    sidecar_distances: &[f32],
    effort: u32,
) -> Result<Vec<PyramidLevel>, EncodeError> {
    let rgba = crate::pipeline::process_rgba(rgb16, params);
    encode_rgba8_pyramid(&rgba, width, height, full_distance, sidecar_sizes, sidecar_distances, effort)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0u8; (w * h * 4) as usize];
        for px in v.chunks_exact_mut(4) {
            px[0] = 200;
            px[1] = 100;
            px[2] = 50;
            px[3] = 255;
        }
        v
    }

    // Uniform opaque RGBA helper (alpha=255 → stays on the 3ch RAW path).
    // Was referenced by the progressive smokes but never defined → pre-existing
    // `cargo test --features jxl-encode` compile break (predates the stash recovery).
    fn solid(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0u8; (w * h * 4) as usize];
        for px in v.chunks_exact_mut(4) {
            px[0] = 120;
            px[1] = 120;
            px[2] = 120;
            px[3] = 255;
        }
        v
    }

    #[test]
    fn encodes_three_variants_with_jxl_magic() {
        let rgba = gradient(2000, 1500);
        let v = encode_variants(&rgba, 2000, 1500, SourceType::Jpeg, false).unwrap();
        assert_eq!(v.full_quality, 85);
        for buf in [&v.thumb_300, &v.preview_1080, &v.full] {
            assert!(!buf.is_empty());
            let cs = buf[0] == 0xFF && buf[1] == 0x0A;
            let cont =
                buf.len() >= 8 && buf[0] == 0 && buf[3] == 0x0C && &buf[4..8] == b"JXL ";
            assert!(cs || cont, "missing JXL magic");
        }
    }

    #[test]
    fn raw_default_q90() {
        let rgba = gradient(100, 100);
        let v = encode_variants(&rgba, 100, 100, SourceType::Raw, false).unwrap();
        assert_eq!(v.full_quality, 90);
    }

    #[test]
    fn hq_override_forces_q95() {
        let rgba = gradient(100, 100);
        let v = encode_variants(&rgba, 100, 100, SourceType::Jpeg, true).unwrap();
        assert_eq!(v.full_quality, 95);
    }

    #[test]
    fn encode_variants_from_rgb16_smoke() {
        // Minimal: 2x2 white-ish rgb16 → variants via direct rgba path.
        // Requires jxl-encode feature (tests run with default features).
        let rgb16: Vec<u16> = (0..(2 * 2 * 3)).map(|i| 3000 + (i as u16) * 10).collect();
        let params = crate::pipeline::PipelineParams::default_olympus();
        let v = encode_variants_from_rgb16(&rgb16, &params, 2, 2, SourceType::Raw, false).unwrap();
        assert_eq!(v.width, 2);
        assert_eq!(v.height, 2);
        assert!(!v.full.is_empty());
        // full for Raw is q90
        assert_eq!(v.full_quality, 90);
    }

    #[test]
    fn encode_variants_with_progressive_dc2_smoke() {
        // Tauri predator parity: exercise the progressive path (Dc=2 + group=1) produces valid JXL.
        let rgba = solid(64, 64);
        let v = encode_variants_with_progressive(&rgba, 64, 64, SourceType::Raw, false, 2, 1).unwrap();
        assert!(!v.full.is_empty());
        // smoke that magic still present
        let b = &v.full;
        let cs = b[0] == 0xFF && b[1] == 0x0A;
        let cont = b.len() >= 8 && b[0] == 0 && b[3] == 0x0C && &b[4..8] == b"JXL ";
        assert!(cs || cont);
    }

    #[test]
    fn encode_rgba8_pyramid_smoke() {
        let rgba = solid(200, 150);
        // 256/1024/2048 all <200? no: 256>200 long so only sides <200 skipped? wait sizes 128,256 but use <long
        let levels = encode_rgba8_pyramid(&rgba, 200, 150, 0.55, &[128, 256], &[1.45, 1.45], 3).unwrap();
        // 128 valid side + full (256 skipped as >= long)
        assert_eq!(levels.len(), 2);
        assert!(levels[0].width <= 128);
        assert_eq!(levels.last().unwrap().width, 200);
        for l in &levels {
            assert!(!l.data.is_empty());
            let b = &l.data;
            let ok = (b.len() >= 2 && b[0] == 0xFF && b[1] == 0x0A) ||
                     (b.len() >= 8 && b[0] == 0 && b[3] == 0x0C && &b[4..8] == b"JXL ");
            assert!(ok, "pyramid level missing JXL magic");
            assert_eq!(l.bits_per_sample, 8);
        }
    }

    #[test]
    fn pyramid_skips_upscale_and_produces_ascending() {
        let rgba = solid(800, 600);
        let levels = encode_rgba8_pyramid(&rgba, 800, 600, 0.55, &[256, 512, 1024, 2048], &[1.45, 1.45, 1.45, 0.55], 3).unwrap();
        // all 4 sides + full (1024>800? 1024>800 skip, 2048 skip; so 256,512 +full =3
        assert!(levels.len() >= 2);
        // last must be full
        let last = levels.last().unwrap();
        assert_eq!(last.width, 800);
        assert_eq!(last.height, 600);
        // first smallest
        assert!(levels[0].width <= 256);
    }

    #[test]
    fn encode_rgba8_pyramid_from_rgb16_smoke() {
        // Direct feed for Tauri/PR-7b pyramid ingest, mirroring encode_variants_from_rgb16.
        let rgb16: Vec<u16> = (0..(4 * 4 * 3)).map(|i| 3000 + (i as u16) * 10).collect();
        let params = crate::pipeline::PipelineParams::default_olympus();
        let levels = encode_rgba8_pyramid_from_rgb16(
            &rgb16, &params, 4, 4, 0.55, &[2], &[1.45], 3
        ).unwrap();
        assert!(!levels.is_empty());
        let last = levels.last().unwrap();
        assert_eq!(last.width, 4);
        assert_eq!(last.height, 4);
        assert_eq!(last.bits_per_sample, 8);
    }

    // Open-thread reproduction: does the 4-channel (alpha<255) path actually encode
    // under jxl-encode alone, or error at libjxl's extra-channel init (encode.cc)?
    // RGB16 smokes above only hit the alpha=255 → 3ch path; this forces 4ch.
    #[test]
    fn encode_4ch_alpha_does_not_error() {
        let (w, h) = (48u32, 48u32);
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for i in 0..(w * h) as usize {
            rgba[i * 4] = 180;
            rgba[i * 4 + 1] = 90;
            rgba[i * 4 + 2] = 40;
            rgba[i * 4 + 3] = if i % 3 == 0 { 100 } else { 255 }; // some alpha<255 → 4ch path
        }
        let res = encode_variants_with_progressive(&rgba, w, h, SourceType::Other, false, 0, 0);
        assert!(res.is_ok(), "4ch alpha encode errored: {:?}", res.err());
        let vs = res.unwrap();
        assert!(vs.has_alpha, "expected has_alpha=true for alpha<255 input");
        assert!(
            !vs.full.is_empty() && !vs.thumb_300.is_empty() && !vs.preview_1080.is_empty(),
            "encoded 4ch variants must be non-empty"
        );
    }

    // The real question: does the 4ch encode actually PRESERVE alpha through a full
    // encode->decode round-trip, or does the high-level path silently drop it (which
    // would mean the jxl-lowlevel gate was guarding a real correctness gap)?
    // Encode an alpha pattern, decode back to RGBA8, assert the low-alpha pixels survive.
    #[cfg(feature = "jxl-lowlevel")]
    #[test]
    fn encode_4ch_alpha_roundtrips_preserves_alpha() {
        let (w, h) = (64u32, 64u32);
        let n = (w * h) as usize;
        let mut rgba = vec![0u8; n * 4];
        for i in 0..n {
            rgba[i * 4] = 180;
            rgba[i * 4 + 1] = 90;
            rgba[i * 4 + 2] = 40;
            rgba[i * 4 + 3] = if i % 3 == 0 { 100 } else { 255 }; // ~1/3 pixels alpha=100
        }
        let vs = encode_variants_with_progressive(&rgba, w, h, SourceType::Other, false, 0, 0)
            .expect("4ch alpha encode failed");
        assert!(vs.has_alpha);

        // Decode the full variant back to RGBA8 (forces 4ch output; alpha=255 if absent).
        let (px, dw, dh) = crate::jxl_lowlevel::decode_jxl_rgba8(&vs.full)
            .expect("decode of 4ch-alpha JXL returned None (invalid/undecodable output)");
        assert_eq!((dw, dh), (w, h), "decoded dims mismatch");
        assert_eq!(px.len(), n * 4, "decoded buffer wrong size");

        // If alpha was preserved, ~1/3 of pixels should still read alpha<200.
        // If the encoder dropped alpha, every decoded alpha would be 255 → count 0.
        let low_alpha = px.chunks_exact(4).filter(|p| p[3] < 200).count();
        let expected = n / 3;
        assert!(
            low_alpha as f64 > expected as f64 * 0.7,
            "ALPHA NOT PRESERVED through encode->decode: {} of ~{} pixels have alpha<200 \
             (encoder likely flattened alpha to 255)",
            low_alpha, expected
        );
    }
}
