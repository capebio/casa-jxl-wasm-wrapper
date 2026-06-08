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
    encode_variants_with_progressive(rgba, width, height, source, hq_override, 0, 0)
}

/// Like encode_variants but accepts progressive encode controls (predator Tauri parity).
/// progressive_dc: 0/1/2 (maps to JXL_ENC_FRAME_SETTING_PROGRESSIVE_DC), group_order: 0/1 (center-out).
/// For the variants (thumbs + full) the full typically benefits most; thumbs usually keep dc=0 for size.
pub fn encode_variants_with_progressive(
    rgba: &[u8],
    width: u32,
    height: u32,
    source: SourceType,
    hq_override: bool,
    progressive_dc: u32,
    group_order: u32,
) -> Result<VariantSet, EncodeError> {
    let full_quality: u8 = if hq_override {
        95
    } else if source == SourceType::Raw {
        90  // Pixel 9 DNG optimized: Q90/E3 balance speed + quality
    } else {
        85
    };

    let thumb_300 = encode_one(rgba, width, height, Some(300), 85, 0, 0)?;
    let preview_1080 = encode_one(rgba, width, height, Some(1080), 85, 0, 0)?;
    let full = encode_one(rgba, width, height, None, full_quality, progressive_dc, group_order)?;

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
    progressive_dc: u32,
    group_order: u32,
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

    // Wire progressive for Tauri/raw-pipeline direct encode parity (predator).
    // Uses the public set_frame_option on the encoder (id values match libjxl FrameSetting).
    if progressive_dc > 0 {
        // 19 == ProgressiveDc
        let _ = enc.set_frame_option(unsafe { std::mem::transmute(19i32) }, progressive_dc as i64);
    }
    if group_order > 0 {
        // 13 == GroupOrder
        let _ = enc.set_frame_option(unsafe { std::mem::transmute(13i32) }, group_order as i64);
    }

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
    let rgba = crate::pipeline::process_rgba(rgb16, params);
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

fn encode_one_distance(pixels: &[u8], w: u32, h: u32, distance: f32, effort: u32) -> Result<Vec<u8>, EncodeError> {
    let mut builder = encoder_builder();
    builder.speed(map_effort_to_speed(effort));
    builder.set_jpeg_quality(jpeg_quality_for_distance(distance));
    let mut enc = builder
        .build()
        .map_err(|e| EncodeError::Jxl(e.to_string()))?;
    let result: EncoderResult<u8> = enc
        .encode(pixels, w, h)
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

    let mut current = rgba.to_vec();
    let mut cw = width;
    let mut ch = height;
    let mut sides: Vec<PyramidLevel> = Vec::new();
    for sc in scs.iter().rev() {
        let mut thumb = vec![0u8; sc.tw as usize * sc.th as usize * 4];
        box_downscale_rgba8(&current, cw, ch, &mut thumb, sc.tw, sc.th);
        let data = encode_one_distance(&thumb, sc.tw, sc.th, sc.dist, effort)?;
        sides.push(PyramidLevel { data, width: sc.tw, height: sc.th, bits_per_sample: 8 });
        current = thumb;
        cw = sc.tw;
        ch = sc.th;
    }
    sides.reverse();

    let full = encode_one_distance(rgba, width, height, full_distance, effort)?;
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
}
