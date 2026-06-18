//! Shared "encode 3 JXL variants for Casabio" routine.
//! Inputs RGBA8 + dimensions + source type + HQ override.
//! Outputs three JXL byte buffers plus the chosen fullsize quality.
//!
//! Built on the BSD-clean `jxl_encode` layer (own FFI over libjxl), replacing
//! the GPL `jpegxl-rs` encoder and the `transmute`-based frame-setting hacks.
//! Reuse is explicit: the sequential variant path and the pyramid loop each hold
//! **one** [`Encoder`](crate::jxl_encode::Encoder) and call `.encode()` per level
//! (only the options change between levels). Under rayon, each parallel branch
//! owns its own `Encoder` (normal owned-value semantics).

use std::sync::atomic::{AtomicBool, Ordering};

use crate::jxl_encode::{Encoder, EncodeOptions, Frame, GroupOrder};

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

impl From<crate::jxl_encode::EncodeError> for EncodeError {
    fn from(e: crate::jxl_encode::EncodeError) -> Self {
        EncodeError::Jxl(e.to_string())
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ProgressiveOpts {
    pub progressive_dc: u32,
    pub group_order: u32,
    pub center: Option<(u32, u32)>,
}

// Variant effort ladder (was jpegxl-rs EncoderSpeed Lightning/Falcon → libjxl Effort).
const EFFORT_THUMB: u8 = 1; // Lightning
const EFFORT_PREVIEW: u8 = 3; // Falcon
const EFFORT_FULL: u8 = 3; // Falcon

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
    encode_variants_cancellable(rgba, width, height, source, hq_override, opts, &AtomicBool::new(false))
}

pub fn encode_variants_cancellable(
    rgba: &[u8],
    width: u32,
    height: u32,
    source: SourceType,
    hq_override: bool,
    opts: ProgressiveOpts,
    cancel: &AtomicBool,
) -> Result<VariantSet, EncodeError> {
    if cancel.load(Ordering::Relaxed) {
        return Err(EncodeError::Cancelled);
    }
    // checked_mul: on 32-bit/wasm usize, width*height*4 can overflow and wrap to a
    // small value that spuriously equals rgba.len(), defeating the contract. None
    // means the requested buffer can't exist on this target → reject.
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|wh| wh.checked_mul(4));
    if width == 0 || height == 0 || expected != Some(rgba.len()) {
        return Err(EncodeError::Input {
            expected: expected.unwrap_or(usize::MAX),
            got: rgba.len(),
        });
    }

    // Detect alpha once from the full-res input; all variant encode calls use this result.
    // RAW images always have alpha=255 → false → 3ch RGB encode path (fast, no extra-channel issues).
    let has_alpha = has_meaningful_alpha(rgba);

    let full_quality: u8 = if hq_override {
        95
    } else if source == SourceType::Raw {
        90 // Pixel 9 DNG optimized: Q90/E3 balance speed + quality
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
    if cancel.load(Ordering::Relaxed) {
        return Err(EncodeError::Cancelled);
    }

    let preview_src: &[u8] = preview_rgba.as_deref().unwrap_or(rgba);

    let (thumb_rgba, tw, th) = if pw.max(ph) > 300 {
        let scale = 300.0 / pw.max(ph) as f32;
        let dw = (pw as f32 * scale).round().max(1.0) as u32;
        let dh = (ph as f32 * scale).round().max(1.0) as u32;
        (Some(resize_rgba(preview_src, pw, ph, dw, dh)?), dw, dh)
    } else {
        (None, pw, ph)
    };
    if cancel.load(Ordering::Relaxed) {
        return Err(EncodeError::Cancelled);
    }

    let thumb_src: &[u8] = thumb_rgba.as_deref().unwrap_or(preview_src);

    let preview_opts = ProgressiveOpts {
        progressive_dc: 0,
        group_order: opts.group_order,
        center: opts.center,
    };
    let thumb_opts = ProgressiveOpts::default();

    #[cfg(feature = "parallel")]
    let (thumb_300, preview_1080, full) = {
        // Each rayon branch owns its own Encoder (owned-value semantics).
        let (thumb_res, (preview_res, full_res)) = rayon::join(
            || {
                if cancel.load(Ordering::Relaxed) {
                    return Err(EncodeError::Cancelled);
                }
                encode_variant(thumb_src, tw, th, 85, EFFORT_THUMB, thumb_opts, has_alpha, width, height)
            },
            || {
                rayon::join(
                    || {
                        if cancel.load(Ordering::Relaxed) {
                            return Err(EncodeError::Cancelled);
                        }
                        encode_variant(preview_src, pw, ph, 85, EFFORT_PREVIEW, preview_opts, has_alpha, width, height)
                    },
                    || {
                        if cancel.load(Ordering::Relaxed) {
                            return Err(EncodeError::Cancelled);
                        }
                        encode_variant(rgba, width, height, full_quality, EFFORT_FULL, opts, has_alpha, width, height)
                    },
                )
            },
        );
        (thumb_res?, preview_res?, full_res?)
    };

    #[cfg(not(feature = "parallel"))]
    let (thumb_300, preview_1080, full) = {
        // One held Encoder, reused across the whole variant set.
        let mut enc = Encoder::new(EncodeOptions::default())?;
        let t = encode_into(&mut enc, thumb_src, tw, th, 85, EFFORT_THUMB, thumb_opts, has_alpha, width, height)?;
        if cancel.load(Ordering::Relaxed) {
            return Err(EncodeError::Cancelled);
        }
        let p = encode_into(&mut enc, preview_src, pw, ph, 85, EFFORT_PREVIEW, preview_opts, has_alpha, width, height)?;
        if cancel.load(Ordering::Relaxed) {
            return Err(EncodeError::Cancelled);
        }
        let f = encode_into(&mut enc, rgba, width, height, full_quality, EFFORT_FULL, opts, has_alpha, width, height)?;
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

/// Build encode options for one variant level (quality + effort + progressive).
/// Group-order center is scaled from full-res coords into this level's coords.
fn build_opts(
    quality: u8,
    effort: u8,
    prog: ProgressiveOpts,
    w: u32,
    h: u32,
    orig_w: u32,
    orig_h: u32,
) -> EncodeOptions {
    let mut o = EncodeOptions::quality(quality as f32).with_effort(effort);
    if prog.progressive_dc > 0 {
        o.progressive_dc = Some(prog.progressive_dc as i64);
    }
    if prog.group_order > 0 {
        let center = prog.center.map(|(cx, cy)| {
            let sx = if orig_w > 0 { w as f32 / orig_w as f32 } else { 1.0 };
            let sy = if orig_h > 0 { h as f32 / orig_h as f32 } else { 1.0 };
            ((cx as f32 * sx) as i64, (cy as f32 * sy) as i64)
        });
        o.group_order = Some(GroupOrder { center });
    }
    o
}

/// Encode one variant reusing a held [`Encoder`]. RAW (alpha=255) strips to RGB.
#[allow(clippy::too_many_arguments)]
fn encode_into(
    enc: &mut Encoder,
    pixels: &[u8], // RGBA8, w*h*4
    w: u32,
    h: u32,
    quality: u8,
    effort: u8,
    prog: ProgressiveOpts,
    has_alpha: bool,
    orig_w: u32,
    orig_h: u32,
) -> Result<Vec<u8>, EncodeError> {
    // Buffer-shape contract: `pixels` is always RGBA8 here (resize/cascade outputs
    // are RGBA8); rgba_to_rgb strips to RGB internally for the no-alpha path. Assert
    // len before handing (w,h) to the C encoder so a wrong-sized derived buffer is
    // rejected instead of triggering an OOB read inside libjxl.
    let expected = (w as usize)
        .checked_mul(h as usize)
        .and_then(|wh| wh.checked_mul(4));
    if expected != Some(pixels.len()) {
        return Err(EncodeError::Input {
            expected: expected.unwrap_or(usize::MAX),
            got: pixels.len(),
        });
    }
    enc.set_options(build_opts(quality, effort, prog, w, h, orig_w, orig_h));
    let bytes = if has_alpha {
        enc.encode(&Frame::rgba8(pixels, w, h))?
    } else {
        // RAW images always have alpha=255; strip to RGB for smaller output.
        let rgb = rgba_to_rgb(pixels);
        enc.encode(&Frame::rgb(&rgb, w, h))?
    };
    Ok(bytes)
}

/// Encode one variant with a fresh one-shot [`Encoder`] (rayon branch).
#[allow(clippy::too_many_arguments)]
fn encode_variant(
    pixels: &[u8],
    w: u32,
    h: u32,
    quality: u8,
    effort: u8,
    prog: ProgressiveOpts,
    has_alpha: bool,
    orig_w: u32,
    orig_h: u32,
) -> Result<Vec<u8>, EncodeError> {
    let mut enc = Encoder::new(EncodeOptions::default())?;
    encode_into(&mut enc, pixels, w, h, quality, effort, prog, has_alpha, orig_w, orig_h)
}

fn resize_rgba(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Result<Vec<u8>, EncodeError> {
    use image::{imageops, ImageBuffer, Rgba};
    let img: ImageBuffer<Rgba<u8>, &[u8]> =
        ImageBuffer::from_raw(sw, sh, src).ok_or(EncodeError::Resize)?;
    let resized = imageops::resize(&img, dw, dh, imageops::FilterType::Lanczos3);
    Ok(resized.into_raw())
}

/// Convenience for Tauri/native encode flows that hold pre-tone RGB16 + params.
/// Produces the three JXL variants directly from the 16-bit buffer.
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

/// Like `encode_variants_from_rgb16` but with progressive_dc / group_order.
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
#[derive(Debug, Clone)]
pub struct PyramidLevel {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub bits_per_sample: u8,
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
    // extend_from_slice on the 3-byte RGB slice lets LLVM emit a wider copy than
    // three per-byte pushes; output is byte-identical.
    for px in rgba.chunks_exact(4) {
        rgb.extend_from_slice(&px[0..3]);
    }
    rgb
}

fn box_downscale_rgba8(src: &[u8], sw: u32, sh: u32, dst: &mut [u8], dw: u32, dh: u32) {
    if dw == 0 || dh == 0 {
        return;
    }
    let src_len = (sw as usize) * (sh as usize) * 4;
    let dst_len = (dw as usize) * (dh as usize) * 4;
    if src.len() < src_len || dst.len() < dst_len {
        return;
    }

    // exact integer fast path (matches C++ IMPROVEMENT-5)
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        for dy in 0..dh {
            for dx in 0..dw {
                let mut r = 0u32;
                let mut g = 0u32;
                let mut b = 0u32;
                let mut a = 0u32;
                let mut count = 0u32;
                for yy in 0..ystep {
                    let y = dy * ystep + yy;
                    let row = &src[(y as usize * sw as usize * 4)..];
                    for xx in 0..xstep {
                        let x = dx * xstep + xx;
                        let px = &row[(x as usize * 4)..];
                        r += px[0] as u32;
                        g += px[1] as u32;
                        b += px[2] as u32;
                        a += px[3] as u32;
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
            let mut r = 0u32;
            let mut g = 0u32;
            let mut b = 0u32;
            let mut a = 0u32;
            let mut count = 0u32;
            for sy in y0..y1 {
                let row = &src[(sy as usize * sw as usize * 4)..];
                for sx in x0..x1 {
                    let px = &row[(sx as usize * 4)..];
                    r += px[0] as u32;
                    g += px[1] as u32;
                    b += px[2] as u32;
                    a += px[3] as u32;
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

/// Encode one pyramid level (by butteraugli distance) reusing a held [`Encoder`].
fn encode_distance_into(
    enc: &mut Encoder,
    pixels: &[u8],
    w: u32,
    h: u32,
    distance: f32,
    effort: u8,
    has_alpha: bool,
) -> Result<Vec<u8>, EncodeError> {
    // Distance is applied directly (Rate::Distance) — no quality<->distance
    // double conversion. Cleaner than the old jpeg_quality_for_distance hop.
    enc.set_options(EncodeOptions::distance(distance).with_effort(effort));
    let bytes = if has_alpha {
        enc.encode(&Frame::rgba8(pixels, w, h))?
    } else {
        let rgb = rgba_to_rgb(pixels);
        enc.encode(&Frame::rgb(&rgb, w, h))?
    };
    Ok(bytes)
}

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
    let effort = effort.clamp(1, 10) as u8;
    let longer = width.max(height);

    #[derive(Clone, Copy)]
    struct Sc {
        tw: u32,
        th: u32,
        dist: f32,
    }
    let mut scs: Vec<Sc> = Vec::new();
    for (i, &max_dim) in sidecar_sizes.iter().enumerate() {
        if max_dim == 0 || max_dim >= longer {
            continue;
        }
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
    // One held Encoder, reused across every pyramid level (ingest-loop reuse).
    let mut enc = Encoder::new(EncodeOptions::default())?;
    let mut current = rgba.to_vec();
    let mut cw = width;
    let mut ch = height;
    let mut sides: Vec<PyramidLevel> = Vec::new();
    for sc in scs.iter().rev() {
        let mut thumb = vec![0u8; sc.tw as usize * sc.th as usize * 4];
        box_downscale_rgba8(&current, cw, ch, &mut thumb, sc.tw, sc.th);
        let data = encode_distance_into(&mut enc, &thumb, sc.tw, sc.th, sc.dist, effort, has_alpha)?;
        sides.push(PyramidLevel { data, width: sc.tw, height: sc.th, bits_per_sample: 8 });
        current = thumb;
        cw = sc.tw;
        ch = sc.th;
    }
    sides.reverse();

    let full = encode_distance_into(&mut enc, rgba, width, height, full_distance, effort, has_alpha)?;
    sides.push(PyramidLevel { data: full, width, height, bits_per_sample: 8 });
    Ok(sides)
}

/// Convenience for Tauri/native pyramid ingest (PR-7b) that holds pre-tone RGB16 + params.
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
            let cont = buf.len() >= 8 && buf[0] == 0 && buf[3] == 0x0C && &buf[4..8] == b"JXL ";
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
        let rgb16: Vec<u16> = (0..(2 * 2 * 3)).map(|i| 3000 + (i as u16) * 10).collect();
        let params = crate::pipeline::PipelineParams::default_olympus();
        let v = encode_variants_from_rgb16(&rgb16, &params, 2, 2, SourceType::Raw, false).unwrap();
        assert_eq!(v.width, 2);
        assert_eq!(v.height, 2);
        assert!(!v.full.is_empty());
        assert_eq!(v.full_quality, 90);
    }

    #[test]
    fn encode_variants_with_progressive_dc2_smoke() {
        let rgba = solid(64, 64);
        let v = encode_variants_with_progressive(&rgba, 64, 64, SourceType::Raw, false, 2, 1).unwrap();
        assert!(!v.full.is_empty());
        let b = &v.full;
        let cs = b[0] == 0xFF && b[1] == 0x0A;
        let cont = b.len() >= 8 && b[0] == 0 && b[3] == 0x0C && &b[4..8] == b"JXL ";
        assert!(cs || cont);
    }

    #[test]
    fn encode_rgba8_pyramid_smoke() {
        let rgba = solid(200, 150);
        let levels = encode_rgba8_pyramid(&rgba, 200, 150, 0.55, &[128, 256], &[1.45, 1.45], 3).unwrap();
        assert_eq!(levels.len(), 2);
        assert!(levels[0].width <= 128);
        assert_eq!(levels.last().unwrap().width, 200);
        for l in &levels {
            assert!(!l.data.is_empty());
            let b = &l.data;
            let ok = (b.len() >= 2 && b[0] == 0xFF && b[1] == 0x0A)
                || (b.len() >= 8 && b[0] == 0 && b[3] == 0x0C && &b[4..8] == b"JXL ");
            assert!(ok, "pyramid level missing JXL magic");
            assert_eq!(l.bits_per_sample, 8);
        }
    }

    #[test]
    fn pyramid_skips_upscale_and_produces_ascending() {
        let rgba = solid(800, 600);
        let levels = encode_rgba8_pyramid(&rgba, 800, 600, 0.55, &[256, 512, 1024, 2048], &[1.45, 1.45, 1.45, 0.55], 3).unwrap();
        assert!(levels.len() >= 2);
        let last = levels.last().unwrap();
        assert_eq!(last.width, 800);
        assert_eq!(last.height, 600);
        assert!(levels[0].width <= 256);
    }

    #[test]
    fn encode_rgba8_pyramid_from_rgb16_smoke() {
        let rgb16: Vec<u16> = (0..(4 * 4 * 3)).map(|i| 3000 + (i as u16) * 10).collect();
        let params = crate::pipeline::PipelineParams::default_olympus();
        let levels = encode_rgba8_pyramid_from_rgb16(&rgb16, &params, 4, 4, 0.55, &[2], &[1.45], 3).unwrap();
        assert!(!levels.is_empty());
        let last = levels.last().unwrap();
        assert_eq!(last.width, 4);
        assert_eq!(last.height, 4);
        assert_eq!(last.bits_per_sample, 8);
    }

    #[test]
    fn encode_4ch_alpha_does_not_error() {
        let (w, h) = (48u32, 48u32);
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for i in 0..(w * h) as usize {
            rgba[i * 4] = 180;
            rgba[i * 4 + 1] = 90;
            rgba[i * 4 + 2] = 40;
            rgba[i * 4 + 3] = if i % 3 == 0 { 100 } else { 255 };
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

    /// Does the 4ch encode PRESERVE alpha through a full encode->decode round-trip?
    #[test]
    fn encode_4ch_alpha_roundtrips_preserves_alpha() {
        let (w, h) = (64u32, 64u32);
        let n = (w * h) as usize;
        let mut rgba = vec![0u8; n * 4];
        for i in 0..n {
            rgba[i * 4] = 180;
            rgba[i * 4 + 1] = 90;
            rgba[i * 4 + 2] = 40;
            rgba[i * 4 + 3] = if i % 3 == 0 { 100 } else { 255 };
        }
        let vs = encode_variants_with_progressive(&rgba, w, h, SourceType::Other, false, 0, 0)
            .expect("4ch alpha encode failed");
        assert!(vs.has_alpha);

        let (px, dw, dh) = crate::jxl_decode::decode_jxl_rgba8(&vs.full)
            .expect("decode of 4ch-alpha JXL returned None");
        assert_eq!((dw, dh), (w, h), "decoded dims mismatch");
        assert_eq!(px.len(), n * 4, "decoded buffer wrong size");

        let low_alpha = px.chunks_exact(4).filter(|p| p[3] < 200).count();
        let expected = n / 3;
        assert!(
            low_alpha as f64 > expected as f64 * 0.7,
            "ALPHA NOT PRESERVED through encode->decode: {} of ~{} pixels have alpha<200",
            low_alpha,
            expected
        );
    }
}
