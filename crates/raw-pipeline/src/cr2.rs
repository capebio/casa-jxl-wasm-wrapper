//! Canon CR2 raw decoder.
//!
//! CR2 is a TIFF container with a Canon-specific extension at bytes 8–15.
//! The raw image is stored as a Lossless JPEG (LJPEG) strip in IFD3.
//! White balance is extracted from the Canon MakerNote ColorData tag (0x4001).
//!
//! # Optimisation notes (Response 1 + Response 2)
//!
//! - IFD traversal: zero-allocation visitor pattern (no Vec per IFD).
//! - ColorData WB: parsed directly from file bytes (no Vec<u16>).
//! - BlackLevel: IFD tags 0xC61A / 0xC632 are now applied (was dead stub).
//! - Crop: in-place compaction within the decode buffer; second Vec eliminated.
//! - SOF parser: seg_len bounds-checked before advancing.
//! - IFD entry count capped at 512 for corrupt-file safety.
//! - CR2Slices: validated before use.
//! - ScratchBuffers API: reuse decode buffer across batch calls.
//! - Cr2Timings: per-phase timing for benchmarks.
//! - Multi-lens review: overflow guard on decoded dimensions; vestigial Cfa re-export removed.

use crate::ljpeg;
use anyhow::{anyhow, bail, Context, Result};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct Cr2Image {
    pub width:        usize,
    pub height:       usize,
    pub raw:          Vec<u16>,
    pub black:        u16,
    pub white:        u16,
    pub wb_r:         f32,
    pub wb_g:         f32,
    pub wb_b:         f32,
    pub iso:          Option<u32>,
    pub color_matrix: Option<[[f32; 3]; 3]>,
    pub make:         String,
    pub model:        String,
    pub orientation:  u16,
}

/// Per-phase decode timing. Zero-cost when `time_phases` is false.
#[derive(Debug, Default, Clone)]
pub struct Cr2Timings {
    /// Total wall time for decode_bytes.
    pub total_ms: f64,
    /// TIFF/EXIF/MakerNote parse time.
    pub parse_ms: f64,
    /// LJPEG decode time (dominant stage).
    pub ljpeg_ms: f64,
    /// In-place crop compaction time.
    pub crop_ms: f64,
    /// Bytes in full-frame decode buffer (before crop).
    pub raw_buf_bytes: usize,
    /// Bytes in final cropped output.
    pub crop_buf_bytes: usize,
}

/// Reusable decode-buffer for batch processing. Avoids per-call full-frame allocation.
#[derive(Default)]
pub struct ScratchBuffers {
    pub raw: Vec<u16>,
}

// ---------------------------------------------------------------------------
// Low-level byte helpers
// ---------------------------------------------------------------------------

#[inline(always)]
fn read_u16(data: &[u8], off: usize, le: bool) -> u16 {
    let b = &data[off..off + 2];
    if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) }
}

#[inline(always)]
fn read_u32(data: &[u8], off: usize, le: bool) -> u32 {
    let b = &data[off..off + 4];
    if le { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) }
}

fn type_size(t: u16) -> usize {
    match t {
        1 | 2 | 6 | 7 => 1,
        3 | 8          => 2,
        4 | 9 | 11     => 4,
        5 | 10 | 12    => 8,
        _              => 0,
    }
}

fn entry_first_u32(data: &[u8], dtype: u16, cnt: u32, val: u32, inline_pos: usize, le: bool) -> Option<u32> {
    if cnt == 0 { return None; }
    let ts = type_size(dtype);
    if ts == 0 { return None; }
    let bytes = ts * cnt as usize;
    let p = if bytes <= 4 { inline_pos } else { val as usize };
    if p + ts > data.len() { return None; }
    match dtype {
        1 | 6 => data.get(p).map(|&b| b as u32),
        3 | 8 => Some(read_u16(data, p, le) as u32),
        4 | 9 => Some(read_u32(data, p, le)),
        _     => None,
    }
}

fn read_ascii(data: &[u8], cnt: u32, val: u32, inline_pos: usize) -> String {
    if cnt == 0 { return String::new(); }
    let (p, len) = if cnt <= 4 { (inline_pos, cnt as usize) } else { (val as usize, cnt as usize) };
    // Checked add: on 32-bit/wasm `p + len` (both from file-controlled u32) can wrap below
    // data.len() and pass an unchecked compare, then `&data[p..p + len]` panics. Same valid
    // output: in-bounds returns the string; OOB/overflow returns empty (unchanged behaviour).
    match p.checked_add(len) {
        Some(end) if end <= data.len() => {}
        _ => return String::new(),
    }
    String::from_utf8_lossy(&data[p..p + len])
        .trim_end_matches('\0')
        .to_string()
}

// ---------------------------------------------------------------------------
// Zero-allocation IFD visitor  (Response 1 item 4)
// ---------------------------------------------------------------------------

/// Walk TIFF IFD at `off`, calling `visitor(tag, dtype, cnt, val, inline_pos)` for each
/// entry. Returns the next-IFD offset (0 on error). Entry count capped at 512 to guard
/// against corrupt-file infinite traversal.
fn visit_ifd<F: FnMut(u16, u16, u32, u32, usize)>(
    data: &[u8],
    off: usize,
    le: bool,
    mut visitor: F,
) -> u32 {
    if off + 2 > data.len() { return 0; }
    let count = read_u16(data, off, le) as usize;
    if count > 512 { return 0; } // corruption guard (item 14)
    for i in 0..count {
        let e = off + 2 + i * 12;
        if e + 12 > data.len() { break; }
        let tag        = read_u16(data, e,     le);
        let dtype      = read_u16(data, e + 2, le);
        let cnt        = read_u32(data, e + 4, le);
        let val        = read_u32(data, e + 8, le);
        let inline_pos = e + 8;
        visitor(tag, dtype, cnt, val, inline_pos);
    }
    let next_pos = off + 2 + count * 12;
    if next_pos + 4 <= data.len() { read_u32(data, next_pos, le) } else { 0 }
}

// ---------------------------------------------------------------------------
// Zero-alloc ColorData WB extraction  (Response 1 item 5)
// ---------------------------------------------------------------------------

/// Extract WB multipliers directly from file bytes — no Vec<u16> allocation.
/// Reads version word then navigates to the AsShot WB index.
fn extract_wb_from_raw(data: &[u8], off: usize, cnt: u32, le: bool) -> Option<(f32, f32)> {
    // Checked offset derivation: `off` is file-controlled (val as usize from MakerNote tag).
    // On 32-bit/wasm `off + 2` and `base + 8` (base = off + wb_index*2) can wrap below
    // data.len() and defeat the bounds guard, reading unrelated bytes as WB multipliers.
    // For valid files base is small and in-bounds, so WB is unchanged.
    if cnt < 1 || off.checked_add(2).map_or(true, |e| e > data.len()) { return None; }
    let version   = read_u16(data, off, le);
    let wb_index: usize = if version >= 6 { 63 } else { 25 };
    if (cnt as usize) < wb_index + 4 { return None; }
    let base = match off.checked_add(wb_index * 2) {
        Some(b) => b,
        None => return None,
    };
    if base.checked_add(8).map_or(true, |e| e > data.len()) { return None; }
    let r  = read_u16(data, base,     le) as f32;
    let g1 = read_u16(data, base + 2, le) as f32;
    // g2 = read_u16(data, base + 4, le) — not used
    let b  = read_u16(data, base + 6, le) as f32;
    if g1 < 1.0 { return None; }
    Some((r / g1, b / g1))
}

// ---------------------------------------------------------------------------
// LJPEG SOF3 scan  (Response 1 item 13 — hardened)
// ---------------------------------------------------------------------------

/// Parse SOF3 marker inside a LJPEG stream. Returns (precision, height, width, ncomp).
/// Segment lengths are bounds-checked before advancing to prevent malformed-marker traversal.
fn parse_ljpeg_sof(data: &[u8], strip_off: usize, strip_len: usize) -> Option<(u8, u16, u16, u8)> {
    let end = (strip_off + strip_len).min(data.len());
    let buf = &data[strip_off..end];
    let mut i = 0;
    while i + 3 < buf.len() {
        if buf[i] != 0xFF { i += 1; continue; }
        let marker = buf[i + 1];
        if marker == 0xC3 {
            if i + 10 > buf.len() { return None; }
            let precision = buf[i + 4];
            let height    = u16::from_be_bytes([buf[i + 5], buf[i + 6]]);
            let width     = u16::from_be_bytes([buf[i + 7], buf[i + 8]]);
            let ncomp     = buf[i + 9];
            return Some((precision, height, width, ncomp));
        }
        match marker {
            0xD8 => { i += 2; continue; }  // SOI — no length field
            0xDA | 0xD9 => return None,     // SOS (data starts) or EOI
            _ => {}
        }
        // Variable-length segment: validate seg_len before advancing.
        if i + 4 > buf.len() { return None; }
        let seg_len = u16::from_be_bytes([buf[i + 2], buf[i + 3]]) as usize;
        if seg_len < 2 { return None; }           // malformed: length includes itself
        let next = i + 2 + seg_len;
        if next > buf.len() { return None; }       // OOB guard
        i = next;
    }
    None
}

// ---------------------------------------------------------------------------
// Per-model camera colour matrices (CR2 has no DNG ColorMatrix tag)
// ---------------------------------------------------------------------------

/// dcraw/libraw-style camera characterisation matrices (XYZ -> camera RGB, scaled *10000),
/// keyed on the EXIF Model string. Values are taken VERBATIM from dcraw `adobe_coeff`
/// (the canonical published source) — never transcribed from memory (a wrong coefficient
/// degrades colour worse than the generic fallback). Add the bodies actually shot here;
/// unknown models return None and the pipeline keeps the generic `CAM_TO_SRGB` fallback
/// (no regression). Format: row-major [r0g0b0, r1g1b1, r2g2b2].
fn canon_cam_xyz(model: &str) -> Option<[i32; 9]> {
    Some(match model.trim() {
        // EOS 550D == Kiss X4 == Rebel T2i (one body, regional names).
        // Source: dcraw / libraw adobe_coeff (XYZ->cam *10000), cross-checked.
        "Canon EOS 550D" | "Canon EOS Kiss X4" | "Canon EOS REBEL T2i" =>
            [6941, -1164, -857, -3825, 11597, 2534, -416, 1540, 6039],
        "Canon EOS M5" =>
            [8532, -701, -1167, -4095, 11879, 2508, -797, 2424, 7010],
        _ => return None,
    })
}

/// Camera->sRGB matrix for a Canon body, or None (→ pipeline uses the generic CAM_TO_SRGB
/// fallback). Mirrors the DNG path (dng::choose_camera_to_srgb_matrix): treat the published
/// XYZ->cam like a DNG ColorMatrix, invert to camera->XYZ, then apply XYZ_D50_TO_SRGB. This
/// keeps CR2 colour consistent with how DNG colour is rendered in this pipeline.
fn canon_color_matrix(make: &str, model: &str) -> Option<[[f32; 3]; 3]> {
    if !make.to_ascii_lowercase().contains("canon") {
        return None;
    }
    let raw = canon_cam_xyz(model)?;
    let cam_xyz = [
        [raw[0] as f32 / 10000.0, raw[1] as f32 / 10000.0, raw[2] as f32 / 10000.0],
        [raw[3] as f32 / 10000.0, raw[4] as f32 / 10000.0, raw[5] as f32 / 10000.0],
        [raw[6] as f32 / 10000.0, raw[7] as f32 / 10000.0, raw[8] as f32 / 10000.0],
    ];
    let cam_to_xyz = crate::dng::invert3x3(cam_xyz)?;
    Some(crate::dng::mul3x3(crate::dng::XYZ_D50_TO_SRGB, cam_to_xyz))
}

// ---------------------------------------------------------------------------
// Decode entry points
// ---------------------------------------------------------------------------

/// Decode CR2 from raw bytes. Single call, no second Vec allocation.
pub fn decode_bytes(data: &[u8]) -> Result<Cr2Image> {
    let mut buf = Vec::new();
    decode_impl(data, &mut buf, true, false, false).map(|(img, _, _)| img)
}

/// Decode with per-phase timings for benchmarking.
pub fn decode_bytes_bench(data: &[u8]) -> Result<(Cr2Image, Cr2Timings)> {
    let mut buf = Vec::new();
    decode_impl(data, &mut buf, true, true, false).map(|(img, t, _)| (img, t))
}

/// Decode with full LJPEG stage statistics (for profiling only — slightly slower due to counters).
pub fn decode_bytes_with_ljpeg_stats(data: &[u8]) -> Result<(Cr2Image, ljpeg::LjpegStats)> {
    let mut buf = Vec::new();
    decode_impl(data, &mut buf, true, false, true)
        .map(|(img, _, stats)| (img, stats.expect("capture_stats=true always yields Some")))
}

/// Decode reusing scratch buffer to avoid per-call full-frame allocation (batch mode).
/// The scratch.raw buffer grows to full-frame size on the first call and is reused thereafter.
pub fn decode_with_scratch(data: &[u8], scratch: &mut ScratchBuffers) -> Result<Cr2Image> {
    decode_impl(data, &mut scratch.raw, false, false, false).map(|(img, _, _)| img)
}

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

/// `move_buf`: when true, moves `raw_buf` into the returned Cr2Image (no copy of crop data).
///             when false, clones crop data from raw_buf (scratch retains capacity).
fn decode_impl(
    data:           &[u8],
    raw_buf:        &mut Vec<u16>,
    move_buf:       bool,
    time_phases:    bool,
    capture_stats:  bool,
) -> Result<(Cr2Image, Cr2Timings, Option<ljpeg::LjpegStats>)> {
    let t_total = time_phases.then(std::time::Instant::now);

    // Minimum: TIFF header (8) + CR2 extension (8) = 16 bytes.
    if data.len() < 16 {
        bail!("CR2: file too small ({} bytes)", data.len());
    }

    let le = match &data[0..4] {
        [0x49, 0x49, 0x2A, 0x00] => true,
        [0x4D, 0x4D, 0x00, 0x2A] => false,
        m => bail!("CR2: not a TIFF file (magic {:?})", m),
    };

    if &data[8..10] != b"CR" {
        bail!("CR2: missing Canon CR marker at offset 8");
    }

    let ifd0_off    = read_u32(data, 4,  le) as usize;
    let raw_ifd_off = read_u32(data, 12, le) as usize;

    // -----------------------------------------------------------------------
    // Parse pass: IFD0 → ExifIFD → MakerNote → RAW IFD
    // -----------------------------------------------------------------------
    let t_parse = time_phases.then(std::time::Instant::now);

    // IFD0: image dimensions, orientation, strings, ExifIFD pointer
    let mut img_width:    u32 = 0;
    let mut img_height:   u32 = 0;
    let mut orientation:  u16 = 1;
    let mut make          = String::new();
    let mut model         = String::new();
    let mut exif_ifd_off: u32 = 0;

    visit_ifd(data, ifd0_off, le, |tag, dtype, cnt, val, ip| match tag {
        0x0100 => img_width    = entry_first_u32(data, dtype, cnt, val, ip, le).unwrap_or(0),
        0x0101 => img_height   = entry_first_u32(data, dtype, cnt, val, ip, le).unwrap_or(0),
        0x0112 => orientation  = entry_first_u32(data, dtype, cnt, val, ip, le).unwrap_or(1) as u16,
        0x010F => make         = read_ascii(data, cnt, val, ip),
        0x0110 => model        = read_ascii(data, cnt, val, ip),
        0x8769 => exif_ifd_off = val,
        _      => {}
    });

    if img_width == 0 || img_height == 0 {
        bail!("CR2: zero image dimensions in IFD0 (w={}, h={})", img_width, img_height);
    }

    // ExifIFD: ISO, MakerNote pointer
    let mut iso:           Option<u32> = None;
    let mut makernote_off: u32 = 0;
    let mut makernote_len: u32 = 0;

    if exif_ifd_off > 0 && (exif_ifd_off as usize) < data.len() {
        visit_ifd(data, exif_ifd_off as usize, le, |tag, dtype, cnt, val, ip| match tag {
            0x8827 => iso           = entry_first_u32(data, dtype, cnt, val, ip, le),
            0x927C => { makernote_off = val; makernote_len = cnt; }
            _      => {}
        });
    }

    // Canon MakerNote: zero-alloc WB extraction (item 5)
    let mut wb_r: f32 = 2.0;
    let mut wb_b: f32 = 1.7;

    if makernote_off > 0 && makernote_len >= 2 {
        let mn_off = makernote_off as usize;
        // Checked add: makernote_off is file-controlled; `mn_off + 2` can wrap on 32-bit.
        if mn_off.checked_add(2).map_or(false, |e| e <= data.len()) {
            visit_ifd(data, mn_off, le, |tag, dtype, cnt, val, ip| {
                if tag == 0x4001 && dtype == 3 && cnt > 0 {
                    let bytes = 2 * cnt as usize;
                    let p = if bytes <= 4 { ip } else { val as usize };
                    if let Some((r, b)) = extract_wb_from_raw(data, p, cnt, le) {
                        wb_r = r;
                        wb_b = b;
                    }
                }
            });
        }
    }

    // RAW IFD: strip address, CR2Slices, BlackLevel (item 1)
    if raw_ifd_off == 0 || raw_ifd_off >= data.len() {
        bail!("CR2: invalid raw IFD offset {}", raw_ifd_off);
    }

    let mut strip_offset:     u32 = 0;
    let mut strip_byte_count: u32 = 0;
    let mut cr2_slices:       [u16; 3] = [0; 3];
    let mut have_slices:      bool = false;
    let mut black_from_ifd:   u16 = 0;

    visit_ifd(data, raw_ifd_off, le, |tag, dtype, cnt, val, ip| match tag {
        0x0111 => strip_offset     = entry_first_u32(data, dtype, cnt, val, ip, le).unwrap_or(0),
        0x0117 => strip_byte_count = entry_first_u32(data, dtype, cnt, val, ip, le).unwrap_or(0),
        0xC640 if dtype == 3 && cnt >= 3 => {
            let bytes = 2 * cnt as usize;
            let p = if bytes <= 4 { ip } else { val as usize };
            if p + 6 <= data.len() {
                cr2_slices[0] = read_u16(data, p,     le);
                cr2_slices[1] = read_u16(data, p + 2, le);
                cr2_slices[2] = read_u16(data, p + 4, le);
                have_slices = cr2_slices[0] > 0;
            }
        }
        // BlackLevel tags: 0xC61A (first plausible value wins) (item 1 fix)
        0xC61A | 0xC632 if black_from_ifd == 0 => {
            if let Some(b) = entry_first_u32(data, dtype, cnt, val, ip, le) {
                if b > 0 && b < 8192 {
                    black_from_ifd = b as u16;
                }
            }
        }
        _ => {}
    });

    let parse_ms = t_parse.map_or(0.0, |t| t.elapsed().as_secs_f64() * 1000.0);

    if strip_offset == 0 || strip_byte_count == 0 {
        bail!("CR2: missing strip offset or byte count in raw IFD");
    }

    let strip_off = strip_offset     as usize;
    let strip_len = strip_byte_count as usize;
    if strip_off + strip_len > data.len() {
        bail!("CR2: strip [{}..{}] out of bounds (file size {})",
              strip_off, strip_off + strip_len, data.len());
    }

    // -----------------------------------------------------------------------
    // SOF3 parse
    // -----------------------------------------------------------------------
    let (precision, sof_h, sof_w, ncomp) = parse_ljpeg_sof(data, strip_off, strip_len)
        .ok_or_else(|| anyhow!("CR2: could not find SOF3 marker in LJPEG strip"))?;

    let sof_h = sof_h as usize;
    let sof_w = sof_w as usize;
    let ncomp = ncomp as usize;

    if sof_w == 0 || sof_h == 0 || ncomp == 0 {
        bail!("CR2: invalid SOF3 dimensions {}×{} ncomp={}", sof_w, sof_h, ncomp);
    }
    // Overflow guard: corrupt files can claim huge dimensions → OOM (multi-lens review).
    // No known RAW sensor exceeds 200 MP.
    let total_check = (sof_w as u64)
        .saturating_mul(ncomp as u64)
        .saturating_mul(sof_h as u64);
    if total_check > 200_000_000 {
        bail!("CR2: implausible decoded dimensions {}×{}×{} = {} px", sof_w, sof_h, ncomp, total_check);
    }

    // CR2Slices: validated before use (item 15)
    let decoded_width: usize = if have_slices {
        let n  = cr2_slices[0] as usize;
        let nw = cr2_slices[1] as usize;
        let lw = cr2_slices[2] as usize;
        if n > 32 || nw == 0 {
            bail!("CR2: implausible CR2Slices [{} {} {}]", n, nw, lw);
        }
        n * nw + lw
    } else {
        sof_w * ncomp
    };

    // -----------------------------------------------------------------------
    // LJPEG decode — single allocation, in-place crop eliminates second Vec
    // -----------------------------------------------------------------------
    let stride        = sof_w * ncomp;

    // The decode buffer's true row length is `stride` (decode_tile is called with
    // stride_pixels = stride below); the crop steps source addresses by `stride` while
    // bounds-checking/centering against `decoded_width`. For valid CR2 files the CR2Slices
    // triple satisfies n*nw + lw == sof_w*ncomp, so these are equal. If they differ the
    // file is inconsistent and the stride-stepped crop would shear/garble (or panic);
    // fail explicitly instead of emitting corrupt pixels. Guard-only — no valid output change.
    if decoded_width != stride {
        bail!(
            "CR2: CR2Slices width {} disagrees with LJPEG stride {} (sof_w={} ncomp={})",
            decoded_width, stride, sof_w, ncomp
        );
    }

    let total_pixels  = stride * sof_h;
    let raw_buf_bytes = total_pixels * 2;

    raw_buf.resize(total_pixels, 0);

    let strip_bytes = &data[strip_off..strip_off + strip_len];
    let t_ljpeg = time_phases.then(std::time::Instant::now);
    let ljpeg_stats = if capture_stats {
        let s = ljpeg::decode_tile_stats(strip_bytes, raw_buf, 0, stride, stride, sof_h)
            .with_context(|| "CR2: LJPEG decode failed")?;
        Some(s)
    } else {
        ljpeg::decode_tile(strip_bytes, raw_buf, 0, stride, stride, sof_h)
            .with_context(|| "CR2: LJPEG decode failed")?;
        None
    };
    let ljpeg_ms = t_ljpeg.map_or(0.0, |t| t.elapsed().as_secs_f64() * 1000.0);

    // -----------------------------------------------------------------------
    // Black/white levels: IFD value overrides precision-table default (item 1)
    // -----------------------------------------------------------------------
    let (mut black, white) = match precision {
        14 => (2048u16, 15300u16),
        12 => (512u16,  4095u16),
        // precision is an unchecked u8 from the LJPEG SOF3 marker. `1u16 << precision`
        // overflows (panic in debug, wrong value in release) for precision >= 16. Guard:
        // precision >= 16 saturates white to u16::MAX; valid 8/10-bit paths are unchanged.
        _ if precision >= 16 => (0u16, u16::MAX),
        _  => (0u16, (1u16 << precision).saturating_sub(1)),
    };
    if black_from_ifd > 0 && black_from_ifd < white {
        black = black_from_ifd;
    }

    // -----------------------------------------------------------------------
    // Crop geometry
    // -----------------------------------------------------------------------
    let crop_w = img_width  as usize;
    let crop_h = img_height as usize;

    if decoded_width < crop_w || sof_h < crop_h {
        bail!("CR2: decoded size {}×{} smaller than expected {}×{}",
              decoded_width, sof_h, crop_w, crop_h);
    }

    let mut left = (decoded_width - crop_w) / 2;
    let mut top  = (sof_h - crop_h) / 2;
    // Preserve RGGB Bayer pattern: both offsets must be even.
    if left & 1 != 0 { left -= 1; }
    if top  & 1 != 0 { top  -= 1; }

    if left + crop_w > decoded_width || top + crop_h > sof_h {
        bail!("CR2: crop region [left={}, top={}, w={}, h={}] exceeds decoded {}×{}",
              left, top, crop_w, crop_h, decoded_width, sof_h);
    }

    // -----------------------------------------------------------------------
    // In-place crop: compact rows within raw_buf — no second Vec (items 8,9)
    // -----------------------------------------------------------------------
    let t_crop = time_phases.then(std::time::Instant::now);
    let crop_needed = top != 0 || left != 0 || decoded_width != crop_w;
    if crop_needed {
        for row in 0..crop_h {
            let src = (top + row) * stride + left;
            let dst = row * crop_w;
            raw_buf.copy_within(src..src + crop_w, dst);
        }
    }
    raw_buf.truncate(crop_w * crop_h);
    let crop_ms        = t_crop.map_or(0.0, |t| t.elapsed().as_secs_f64() * 1000.0);
    let crop_buf_bytes = crop_w * crop_h * 2;

    // -----------------------------------------------------------------------
    // Build return value
    // -----------------------------------------------------------------------
    let raw_out = if move_buf {
        std::mem::take(raw_buf)     // zero-copy — raw_buf left empty
    } else {
        raw_buf[..crop_w * crop_h].to_vec()   // batch mode: clone crop, retain capacity
    };

    let total_ms = t_total.map_or(0.0, |t| t.elapsed().as_secs_f64() * 1000.0);

    let timings = Cr2Timings {
        total_ms, parse_ms, ljpeg_ms, crop_ms,
        raw_buf_bytes, crop_buf_bytes,
    };

    Ok((Cr2Image {
        width:        crop_w,
        height:       crop_h,
        raw:          raw_out,
        black,
        white,
        wb_r,
        wb_g:         1.0,
        wb_b,
        iso,
        color_matrix: canon_color_matrix(&make, &model),
        make,
        model,
        orientation,
    }, timings, ljpeg_stats))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_too_small_data() {
        let result = decode_bytes(&[0u8; 8]);
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("CR2"), "error should mention CR2: {msg}");
    }

    #[test]
    fn rejects_non_tiff_magic() {
        let mut data = vec![0u8; 16];
        data[0] = 0x42;
        data[1] = 0x42;
        assert!(decode_bytes(&data).is_err());
    }

    #[test]
    fn rejects_missing_cr_marker() {
        let mut data = vec![0u8; 16];
        data[0] = 0x49; data[1] = 0x49; data[2] = 0x2A; data[3] = 0x00;
        data[8] = 0x00; data[9] = 0x00;
        let result = decode_bytes(&data);
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("CR marker"), "error should mention CR marker: {msg}");
    }

    // Zero-alloc WB extraction from raw file bytes
    #[test]
    fn extract_wb_version6() {
        let mut data = vec![0u8; 140]; // 70 u16s × 2 bytes
        // Write version=6 at offset 0
        data[0] = 6; data[1] = 0; // version = 6 LE
        // WB at index 63: offset 63*2 = 126
        let r:  u16 = 2166;
        let g1: u16 = 1024;
        let b:  u16 = 1789;
        data[126] = (r  & 0xFF) as u8; data[127] = (r  >> 8) as u8;
        data[128] = (g1 & 0xFF) as u8; data[129] = (g1 >> 8) as u8;
        data[130] = 0; data[131] = 0; // g2
        data[132] = (b  & 0xFF) as u8; data[133] = (b  >> 8) as u8;
        let (wb_r, wb_b) = extract_wb_from_raw(&data, 0, 70, true).unwrap();
        let er = 2166.0 / 1024.0;
        let eb = 1789.0 / 1024.0;
        assert!((wb_r - er).abs() < 1e-4, "wb_r={wb_r} expected={er}");
        assert!((wb_b - eb).abs() < 1e-4, "wb_b={wb_b} expected={eb}");
    }

    #[test]
    fn extract_wb_version1() {
        let mut data = vec![0u8; 60]; // 30 u16s × 2 bytes
        data[0] = 1; data[1] = 0; // version = 1 LE
        // WB at index 25: offset 25*2 = 50
        let r:  u16 = 1800;
        let g1: u16 = 1024;
        let b:  u16 = 1600;
        data[50] = (r  & 0xFF) as u8; data[51] = (r  >> 8) as u8;
        data[52] = (g1 & 0xFF) as u8; data[53] = (g1 >> 8) as u8;
        data[54] = 0; data[55] = 0; // g2
        data[56] = (b  & 0xFF) as u8; data[57] = (b  >> 8) as u8;
        let (wb_r, wb_b) = extract_wb_from_raw(&data, 0, 30, true).unwrap();
        assert!((wb_r - 1800.0 / 1024.0).abs() < 1e-4);
        assert!((wb_b - 1600.0 / 1024.0).abs() < 1e-4);
    }

    #[test]
    fn extract_wb_returns_none_for_zero_g1() {
        let mut data = vec![0u8; 140];
        data[0] = 6; // version = 6
        // R at 126..128, G1 at 128..130 = 0
        data[126] = 0xD0; data[127] = 0x07; // R = 2000
        // G1 stays 0
        assert!(extract_wb_from_raw(&data, 0, 70, true).is_none());
    }

    #[test]
    fn visit_ifd_empty_returns_zero() {
        // Empty IFD (count=0) should not call visitor and return next offset
        let mut data = vec![0u8; 8];
        data[0] = 0; data[1] = 0; // count = 0
        // next offset at bytes 2..6
        data[2] = 0; data[3] = 0; data[4] = 0; data[5] = 0;
        let mut called = false;
        let next = visit_ifd(&data, 0, true, |_, _, _, _, _| { called = true; });
        assert!(!called);
        assert_eq!(next, 0);
    }

    #[test]
    fn visit_ifd_corruption_guard() {
        // IFD claiming > 512 entries should return 0, no visitor calls
        let mut data = vec![0u8; 4];
        data[0] = 0xFF; data[1] = 0x03; // count = 1023 LE
        let mut called = false;
        let next = visit_ifd(&data, 0, true, |_, _, _, _, _| { called = true; });
        assert!(!called);
        assert_eq!(next, 0);
    }

    #[test]
    fn real_cr2_decodes() {
        let path = std::env::var("CR2_TEST_FILE")
            .unwrap_or_else(|_| r"C:\Foo\raw-converter\tests\_MG_1744.CR2".into());
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(_) => return, // file not present — skip
        };
        let img = decode_bytes(&data).expect("CR2 decode failed");
        assert_eq!(img.width,  5184, "width");
        assert_eq!(img.height, 3456, "height");
        assert!(img.wb_r > 1.0 && img.wb_r < 5.0, "wb_r={}", img.wb_r);
        assert!(img.wb_b > 1.0 && img.wb_b < 5.0, "wb_b={}", img.wb_b);
        assert_eq!(img.raw.len(), img.width * img.height);
        assert!(img.iso.is_some());
        assert!(!img.make.is_empty());
        assert!(!img.model.is_empty());
    }

    #[test]
    fn bench_api_returns_timings() {
        let path = std::env::var("CR2_TEST_FILE")
            .unwrap_or_else(|_| r"C:\Foo\raw-converter\tests\_MG_1744.CR2".into());
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(_) => return,
        };
        let (img, t) = decode_bytes_bench(&data).expect("bench decode failed");
        assert_eq!(img.raw.len(), img.width * img.height);
        assert!(t.total_ms > 0.0, "total_ms should be positive: {}", t.total_ms);
        assert!(t.ljpeg_ms > 0.0, "ljpeg_ms should be positive: {}", t.ljpeg_ms);
        assert!(t.ljpeg_ms <= t.total_ms, "ljpeg_ms={} > total_ms={}", t.ljpeg_ms, t.total_ms);
        assert!(t.raw_buf_bytes > t.crop_buf_bytes,
            "raw_buf_bytes={} should exceed crop_buf_bytes={}", t.raw_buf_bytes, t.crop_buf_bytes);
    }

    #[test]
    fn scratch_produces_same_output() {
        let path = std::env::var("CR2_TEST_FILE")
            .unwrap_or_else(|_| r"C:\Foo\raw-converter\tests\_MG_1744.CR2".into());
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(_) => return,
        };
        let img1 = decode_bytes(&data).expect("decode 1");
        let mut sc = ScratchBuffers::default();
        let img2 = decode_with_scratch(&data, &mut sc).expect("decode 2");
        assert_eq!(img1.raw, img2.raw, "scratch must produce identical output");
        assert_eq!(img1.black, img2.black);
        assert_eq!(img1.wb_r.to_bits(), img2.wb_r.to_bits());
    }

    #[test]
    fn canon_color_matrix_resolves_for_known_bodies() {
        for model in ["Canon EOS 550D", "Canon EOS Kiss X4", "Canon EOS M5"] {
            let m = canon_color_matrix("Canon", model)
                .unwrap_or_else(|| panic!("no camera matrix for {model}"));
            for row in &m {
                for v in row {
                    assert!(v.is_finite(), "non-finite coeff in matrix for {model}");
                }
            }
            // sane camera->sRGB: green->green dominant and in a believable range
            assert!(m[1][1] > 0.3 && m[1][1] < 2.0, "G->G out of range for {model}: {}", m[1][1]);
        }
        // unknown / non-Canon → None (pipeline keeps the generic CAM_TO_SRGB fallback)
        assert!(canon_color_matrix("Canon", "Canon EOS 9999X").is_none());
        assert!(canon_color_matrix("OM Digital Solutions", "OM-5").is_none());
    }
}
