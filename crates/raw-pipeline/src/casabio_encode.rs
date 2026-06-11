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
                encode_one(thumb_src, width, height, tw, th, 85, thumb_opts, jpegxl_rs::encode::EncoderSpeed::Lightning)
            },
            || rayon::join(
                || {
                    if cancel.load(std::sync::atomic::Ordering::Relaxed) { return Err(EncodeError::Cancelled); }
                    encode_one(preview_src, width, height, pw, ph, 85, preview_opts, jpegxl_rs::encode::EncoderSpeed::Falcon)
                },
                || {
                    if cancel.load(std::sync::atomic::Ordering::Relaxed) { return Err(EncodeError::Cancelled); }
                    encode_one(rgba, width, height, width, height, full_quality, opts, jpegxl_rs::encode::EncoderSpeed::Falcon)
                }
            )
        );
        (thumb_res?, preview_res?, full_res?)
    };

    #[cfg(not(feature = "parallel"))]
    let (thumb_300, preview_1080, full) = {
        let t = encode_one(thumb_src, width, height, tw, th, 85, thumb_opts, jpegxl_rs::encode::EncoderSpeed::Lightning)?;
        if cancel.load(std::sync::atomic::Ordering::Relaxed) { return Err(EncodeError::Cancelled); }
        let p = encode_one(preview_src, width, height, pw, ph, 85, preview_opts, jpegxl_rs::encode::EncoderSpeed::Falcon)?;
        if cancel.load(std::sync::atomic::Ordering::Relaxed) { return Err(EncodeError::Cancelled); }
        let f = encode_one(rgba, width, height, width, height, full_quality, opts, jpegxl_rs::encode::EncoderSpeed::Falcon)?;
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
) -> Result<Vec<u8>, EncodeError> {
    // `quality` on the builder is a Butteraugli distance (lower = higher quality);
    // `set_jpeg_quality` accepts a 0..100 JPEG-style factor and maps it via libjxl.
    let mut builder = encoder_builder();
    builder.speed(speed);
    builder.set_jpeg_quality(quality as f32);
    builder.has_alpha(true);
    let mut enc = builder
        .build()
        .map_err(|e| EncodeError::Jxl(e.to_string()))?;

    // Wire progressive for Tauri/raw-pipeline direct encode parity (predator).
    // Uses the public set_frame_option on the encoder (id values match libjxl FrameSetting).
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
            // Fallback: transmuting for GroupOrderCenterX/Y if not in enum (14 and 15)
            let _ = enc.set_frame_option(unsafe { std::mem::transmute(14i32) }, cx_scaled);
            let _ = enc.set_frame_option(unsafe { std::mem::transmute(15i32) }, cy_scaled);
        }
    }

    use jpegxl_rs::encode::EncoderFrame;
    let frame = EncoderFrame::new(pixels).num_channels(4);
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
}
