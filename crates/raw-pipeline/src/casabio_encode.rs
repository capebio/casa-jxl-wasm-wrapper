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
    pub full_quality: u8,
}

#[derive(thiserror::Error, Debug)]
pub enum EncodeError {
    #[error("encoder failed: {0}")]
    Jxl(String),
    #[error("resize failed")]
    Resize,
}

pub fn encode_variants(
    rgba: &[u8],
    width: u32,
    height: u32,
    source: SourceType,
    hq_override: bool,
) -> Result<VariantSet, EncodeError> {
    let full_quality: u8 = if hq_override {
        95
    } else if source == SourceType::Raw {
        90  // Pixel 9 DNG optimized: Q90/E3 balance speed + quality
    } else {
        85
    };

    let thumb_300 = encode_one(rgba, width, height, Some(300), 85)?;
    let preview_1080 = encode_one(rgba, width, height, Some(1080), 85)?;
    let full = encode_one(rgba, width, height, None, full_quality)?;

    Ok(VariantSet {
        thumb_300,
        preview_1080,
        full,
        width,
        height,
        full_quality,
    })
}

fn encode_one(
    rgba: &[u8],
    width: u32,
    height: u32,
    long_edge: Option<u32>,
    quality: u8,
) -> Result<Vec<u8>, EncodeError> {
    let (pixels, w, h) = match long_edge {
        Some(target) if width.max(height) > target => {
            let scale = target as f32 / width.max(height) as f32;
            let dw = (width as f32 * scale).round() as u32;
            let dh = (height as f32 * scale).round() as u32;
            (resize_rgba(rgba, width, height, dw, dh)?, dw, dh)
        }
        _ => (rgba.to_vec(), width, height),
    };

    // `quality` on the builder is a Butteraugli distance (lower = higher quality);
    // `set_jpeg_quality` accepts a 0..100 JPEG-style factor and maps it via libjxl.
    let mut builder = encoder_builder();
    builder.speed(jpegxl_rs::encode::EncoderSpeed::Falcon);
    builder.set_jpeg_quality(quality as f32);
    let mut enc = builder
        .build()
        .map_err(|e| EncodeError::Jxl(e.to_string()))?;

    let result: EncoderResult<u8> = enc
        .encode(&pixels, w, h)
        .map_err(|e| EncodeError::Jxl(e.to_string()))?;
    Ok(result.data)
}

fn resize_rgba(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Result<Vec<u8>, EncodeError> {
    use image::{imageops, ImageBuffer, RgbaImage};
    let img: RgbaImage = ImageBuffer::from_raw(sw, sh, src.to_vec()).ok_or(EncodeError::Resize)?;
    let resized = imageops::resize(&img, dw, dh, imageops::FilterType::Lanczos3);
    Ok(resized.into_raw())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32) -> Vec<u8> {
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
        let rgba = solid(2000, 1500);
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
        let rgba = solid(100, 100);
        let v = encode_variants(&rgba, 100, 100, SourceType::Raw, false).unwrap();
        assert_eq!(v.full_quality, 90);
    }

    #[test]
    fn hq_override_forces_q95() {
        let rgba = solid(100, 100);
        let v = encode_variants(&rgba, 100, 100, SourceType::Jpeg, true).unwrap();
        assert_eq!(v.full_quality, 95);
    }
}
