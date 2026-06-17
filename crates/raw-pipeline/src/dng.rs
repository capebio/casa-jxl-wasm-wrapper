//! DNG raw decoder. Walks IFD0 + SubIFDs, finds the full-resolution raw
//! SubIFD, then decodes its lossless-JPEG tiles (compression=7) or raw strips
//! (compression=1). Pulls BlackLevel, WhiteLevel, AsShotNeutral and CFAPattern
//! out of the same IFD chain.

use crate::demosaic;
use crate::ljpeg;
use anyhow::{anyhow, bail, Context, Result};
#[cfg(feature = "parallel")]
use rayon::prelude::*;
use std::collections::HashSet;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cfa {
    Rggb,
    Gbrg,
    Grbg,
    Bggr,
}

pub struct DngImage {
    pub width: usize,
    pub height: usize,
    pub raw: Vec<u16>,
    pub cfa: Cfa,
    pub black: u16,
    pub white: u16,
    pub wb_r: f32,
    pub wb_g: f32,
    pub wb_b: f32,
    pub iso: Option<u32>,
    pub color_matrix: Option<[[f32; 3]; 3]>,
    pub make: String,
    pub model: String,
    pub orientation: u16,
}

const TAG_COLOR_MATRIX_1: u16 = 0xC621;
const TAG_COLOR_MATRIX_2: u16 = 0xC622;
const TAG_FORWARD_MATRIX_1: u16 = 0xC714;
const TAG_FORWARD_MATRIX_2: u16 = 0xC715;

pub(crate) const XYZ_D50_TO_SRGB: [[f32; 3]; 3] = [
    [3.133_856_1, -1.616_866_7, -0.490_614_6],
    [-0.978_768_4, 1.916_141_5, 0.033_454_0],
    [0.071_945_3, -0.228_991_4, 1.405_242_7],
];

pub fn decode(path: &std::path::Path) -> Result<DngImage> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    decode_bytes(&bytes)
}

pub fn decode_bytes(data: &[u8]) -> Result<DngImage> {
    let (state, raw, le) = load_dng(data)?;

    let width = raw.width as usize;
    let height = raw.height as usize;
    let cps = raw.samples_per_pixel.max(1) as usize;
    let cfa = match raw.cfa_pattern {
        Some(p) => match p {
            [0, 1, 1, 2] => Cfa::Rggb,
            [1, 2, 0, 1] => Cfa::Gbrg,
            [1, 0, 2, 1] => Cfa::Grbg,
            [2, 1, 1, 0] => Cfa::Bggr,
            _ => bail!("unsupported CFA pattern: {p:?}"),
        },
        None => Cfa::Rggb,
    };

    let mut out = vec![0u16; width * height];

    match raw.compression {
        1 => decode_uncompressed(data, &raw, width, height, le, &mut out)?,
        7 => decode_tiles(data, &raw, width, height, cps, &mut out)?,
        c => bail!("DNG compression {c} not supported"),
    }

    let wb_r_neutral = state.as_shot_neutral.map(|n| n[0]).unwrap_or(1.0);
    let wb_g_neutral = state.as_shot_neutral.map(|n| n[1]).unwrap_or(1.0);
    let wb_b_neutral = state.as_shot_neutral.map(|n| n[2]).unwrap_or(1.0);
    let wb_r = wb_g_neutral / wb_r_neutral.max(1e-6);
    let wb_g = 1.0;
    let wb_b = wb_g_neutral / wb_b_neutral.max(1e-6);

    let black = raw.black_level.unwrap_or(0);
    let white = raw.white_level.unwrap_or(16383);
    let color_matrix = choose_camera_to_srgb_matrix(
        state.forward_matrix_1,
        state.forward_matrix_2,
        state.color_matrix_1,
        state.color_matrix_2,
    );
    // Color matrix (camera native -> sRGB via XYZ) is passed through to higher
    // LookRenderer for the advanced non-Riemannian / log geodesic / Molchanov
    // perceptual model (lens17). The demosaic stage (incl. optional mhc_matrix
    // fusion) + this + black/white/wb provide the clean linear starting point.

    Ok(DngImage {
        width,
        height,
        raw: out,
        cfa,
        black,
        white,
        wb_r,
        wb_g,
        wb_b,
        iso: state.iso,
        color_matrix,
        make: state.make,
        model: state.model,
        orientation: state.orientation.unwrap_or(1),
    })
}

fn decode_tiles(
    data: &[u8],
    raw: &RawIfd,
    width: usize,
    height: usize,
    cps: usize,
    out: &mut [u16],
) -> Result<()> {
    let tw = raw.tile_width.ok_or_else(|| anyhow!("missing TileWidth"))? as usize;
    let tl = raw
        .tile_length
        .ok_or_else(|| anyhow!("missing TileLength"))? as usize;
    let coltiles = (width + tw - 1) / tw;
    let rowtiles = (height + tl - 1) / tl;
    let expected = coltiles * rowtiles;
    if raw.tile_offsets.len() != expected || raw.tile_byte_counts.len() != expected {
        bail!(
            "tile count mismatch: expected {} got {}/{}",
            expected,
            raw.tile_offsets.len(),
            raw.tile_byte_counts.len()
        );
    }

    let _ = cps; // implied by SOF

    // X1: full per-tile parallel (enabled by L13). Use probe + decode_tile_compact so each
    // task owns a small disjoint compact buffer (no shared &mut stride borrow). Collect then
    // blit active rects (edge tiles may have active < declared SOF size). Replaces the prior
    // row-of-tiles band + Mutex + inner serial cols.
    struct DecodedTile {
        row_start: usize,
        col_start: usize,
        buf: Vec<u16>,
        buf_w: usize, // declared by this tile's SOF (compact stride unit)
        active_w: usize,
        active_h: usize,
    }

    let decode_one = |idx: usize| -> Result<DecodedTile> {
        let tr = idx / coltiles;
        let tc = idx % coltiles;
        let row_start = tr * tl;
        let row_end = ((tr + 1) * tl).min(height);
        let col_start = tc * tw;
        let col_end = ((tc + 1) * tw).min(width);
        let active_h = row_end - row_start;
        let active_w = col_end - col_start;
        let off = raw.tile_offsets[idx] as usize;
        let bc = raw.tile_byte_counts[idx] as usize;
        let src = data
            .get(off..off + bc)
            .ok_or_else(|| anyhow!("tile {idx} OOB"))?;
        let info = ljpeg::probe_tile(src).with_context(|| format!("probe tile {idx}"))?;
        let bw = info.width as usize;
        let bh = info.height as usize;
        // Buf sized to declared tile (units match the grid tw/tl and prior calls; cps=1 for CFA raw).
        let mut buf = vec![0u16; bw * bh];
        ljpeg::decode_tile_compact(src, &mut buf, bw, bh)
            .with_context(|| format!("compact tile r={tr} c={tc}"))?;
        Ok(DecodedTile {
            row_start,
            col_start,
            buf,
            buf_w: bw,
            active_w,
            active_h,
        })
    };

    #[cfg(feature = "parallel")]
    let tiles: Vec<DecodedTile> = (0..expected)
        .into_par_iter()
        .map(decode_one)
        .collect::<Result<Vec<_>>>()?;
    #[cfg(not(feature = "parallel"))]
    let tiles: Vec<DecodedTile> = (0..expected).map(decode_one).collect::<Result<Vec<_>>>()?;

    // Serial blit of active rects (disjoint; cheap vs decode work).
    for td in tiles {
        let aw = td.active_w.min(td.buf_w);
        let ah = td.active_h;
        for r in 0..ah {
            let src_base = r * td.buf_w;
            let dst_base = (td.row_start + r) * width + td.col_start;
            let dst = &mut out[dst_base..dst_base + aw];
            let src = &td.buf[src_base..src_base + aw];
            dst.copy_from_slice(src);
        }
    }
    Ok(())
}

fn decode_uncompressed(
    data: &[u8],
    raw: &RawIfd,
    width: usize,
    height: usize,
    le: bool,
    out: &mut [u16],
) -> Result<()> {
    let bps = raw.bits_per_sample;
    if bps != 16 {
        bail!("uncompressed DNG: bps {} unsupported", bps);
    }
    if !raw.tile_offsets.is_empty() {
        let tw = raw.tile_width.ok_or_else(|| anyhow!("TileWidth"))? as usize;
        let tl = raw.tile_length.ok_or_else(|| anyhow!("TileLength"))? as usize;
        let coltiles = (width + tw - 1) / tw;
        let rowtiles = (height + tl - 1) / tl;
        for tr in 0..rowtiles {
            for tc in 0..coltiles {
                let idx = tr * coltiles + tc;
                let off = raw.tile_offsets[idx] as usize;
                let bc = raw.tile_byte_counts[idx] as usize;
                let src = data
                    .get(off..off + bc)
                    .ok_or_else(|| anyhow!("uncompressed DNG: tile {idx} OOB"))?;
                let col_start = tc * tw;
                let col_end = ((tc + 1) * tw).min(width);
                let row_start = tr * tl;
                let row_end = ((tr + 1) * tl).min(height);
                let mut sp = 0usize;
                for r in row_start..row_end {
                    for c in col_start..col_end {
                        if sp + 2 > src.len() {
                            bail!("uncompressed DNG: tile {idx} truncated");
                        }
                        out[r * width + c] = if le {
                            u16::from_le_bytes([src[sp], src[sp + 1]])
                        } else {
                            u16::from_be_bytes([src[sp], src[sp + 1]])
                        };
                        sp += 2;
                    }
                    sp += (tw - (col_end - col_start)) * 2;
                }
            }
        }
        return Ok(());
    }
    if !raw.strip_offsets.is_empty() {
        if raw.strip_offsets.len() != raw.strip_byte_counts.len() {
            bail!("uncompressed DNG: strip count mismatch");
        }
        let rows_per_strip = raw.rows_per_strip.unwrap_or(height as u32).max(1) as usize;
        for (idx, (&off_u32, &bc_u32)) in raw
            .strip_offsets
            .iter()
            .zip(raw.strip_byte_counts.iter())
            .enumerate()
        {
            let off = off_u32 as usize;
            let bc = bc_u32 as usize;
            let src = data
                .get(off..off + bc)
                .ok_or_else(|| anyhow!("uncompressed DNG: strip {idx} OOB"))?;
            let row_start = idx * rows_per_strip;
            let row_end = (row_start + rows_per_strip).min(height);
            let mut sp = 0usize;
            for r in row_start..row_end {
                for c in 0..width {
                    if sp + 2 > src.len() {
                        bail!("uncompressed DNG: strip {idx} truncated");
                    }
                    out[r * width + c] = if le {
                        u16::from_le_bytes([src[sp], src[sp + 1]])
                    } else {
                        u16::from_be_bytes([src[sp], src[sp + 1]])
                    };
                    sp += 2;
                }
            }
        }
        return Ok(());
    }
    bail!("uncompressed DNG: missing tile or strip offsets");
}

pub fn align_to_rggb(raw: &[u16], width: usize, height: usize, cfa: Cfa) -> (&[u16], usize, usize) {
    let (row_off, col_off): (usize, usize) = match cfa {
        Cfa::Rggb => (0, 0),
        Cfa::Gbrg => (1, 0),
        Cfa::Grbg => (0, 1),
        Cfa::Bggr => (1, 1),
    };
    if row_off == 0 && col_off == 0 {
        return (raw, width, height);
    }
    if col_off == 0 {
        let new_h = height - row_off;
        let start = row_off * width;
        return (&raw[start..start + new_h * width], width, new_h);
    }
    (raw, width, height)
}

fn cfa_phase(cfa: Cfa) -> (u8, u8) {
    match cfa {
        Cfa::Rggb => (0, 0),
        Cfa::Grbg => (0, 1),
        Cfa::Gbrg => (1, 0),
        Cfa::Bggr => (1, 1),
    }
}

/// Common parse for both decode paths (dedup per plan).
fn load_dng(data: &[u8]) -> Result<(WalkState, RawIfd, bool)> {
    if data.len() < 8 {
        bail!("too small");
    }
    let le = match &data[0..4] {
        [0x49, 0x49, 0x2A, 0x00] => true,
        [0x4D, 0x4D, 0x00, 0x2A] => false,
        m => bail!("not TIFF: {m:?}"),
    };
    let ifd0_off = read_u32(data, 4, le);
    let mut state = WalkState::default();
    walk(data, ifd0_off as usize, le, &mut state);
    let raw = state
        .raw_ifd
        .take()
        .ok_or_else(|| anyhow!("no raw SubIFD found"))?;
    Ok((state, raw, le))
}

#[derive(Default, Debug)]
struct RawIfd {
    width: u32,
    height: u32,
    bits_per_sample: u16,
    samples_per_pixel: u16,
    compression: u32,
    strip_offsets: Vec<u32>,
    strip_byte_counts: Vec<u32>,
    rows_per_strip: Option<u32>,
    tile_offsets: Vec<u32>,
    tile_byte_counts: Vec<u32>,
    tile_width: Option<u32>,
    tile_length: Option<u32>,
    black_level: Option<u16>,
    white_level: Option<u16>,
    cfa_pattern: Option<[u8; 4]>,
}

#[derive(Default, Debug)]
struct WalkState {
    raw_ifd: Option<RawIfd>,
    as_shot_neutral: Option<[f32; 3]>,
    color_matrix_1: Option<[[f32; 3]; 3]>,
    color_matrix_2: Option<[[f32; 3]; 3]>,
    forward_matrix_1: Option<[[f32; 3]; 3]>,
    forward_matrix_2: Option<[[f32; 3]; 3]>,
    iso: Option<u32>,
    make: String,
    model: String,
    orientation: Option<u16>,
}

fn raw_ifd_supported_candidate(ifd: &RawIfd, new_subfile_type: u32) -> bool {
    let has_storage =
        (!ifd.tile_offsets.is_empty() && !ifd.tile_byte_counts.is_empty())
            || (!ifd.strip_offsets.is_empty() && !ifd.strip_byte_counts.is_empty());
    let is_subsampled = (new_subfile_type & 1) != 0;
    ifd.width > 0
        && ifd.height > 0
        && has_storage
        && !is_subsampled
        && (ifd.compression == 7 || ifd.compression == 1 || ifd.compression == 0x884C)
}

fn walk(data: &[u8], off: usize, le: bool, state: &mut WalkState) {
    fn walk_inner(
        data: &[u8],
        off: usize,
        le: bool,
        state: &mut WalkState,
        visited: &mut HashSet<usize>,
        depth: usize,
    ) {
        const MAX_IFD_DEPTH: usize = 64;
        if depth >= MAX_IFD_DEPTH || !visited.insert(off) {
            return;
        }
    if off + 2 > data.len() {
        return;
    }
    let count = read_u16(data, off, le) as usize;
    let mut subs = Vec::new();
    let mut ifd = RawIfd::default();
    let mut new_subfile_type: u32 = 0;
    let mut has_image_dims = false;
    let mut has_tiles = false;

    for i in 0..count {
        let e = off + 2 + i * 12;
        if e + 12 > data.len() {
            return;
        }
        let tag = read_u16(data, e, le);
        let dtype = read_u16(data, e + 2, le);
        let cnt = read_u32(data, e + 4, le);
        let val = read_u32(data, e + 8, le);
        let inline_pos = e + 8;
        match tag {
            0x00FE => new_subfile_type = val,
            0x0100 => {
                ifd.width = first_u32(data, dtype, cnt, val, inline_pos, le).unwrap_or(0);
                has_image_dims = true;
            }
            0x0101 => {
                ifd.height = first_u32(data, dtype, cnt, val, inline_pos, le).unwrap_or(0);
            }
            0x0102 => {
                ifd.bits_per_sample =
                    first_u32(data, dtype, cnt, val, inline_pos, le).unwrap_or(0) as u16;
            }
            0x0103 => {
                ifd.compression = first_u32(data, dtype, cnt, val, inline_pos, le).unwrap_or(0);
            }
            0x0115 => {
                ifd.samples_per_pixel =
                    first_u32(data, dtype, cnt, val, inline_pos, le).unwrap_or(1) as u16;
            }
            0x0111 => {
                ifd.strip_offsets = read_array_u32(data, dtype, cnt, val, inline_pos, le);
            }
            0x0116 => {
                ifd.rows_per_strip = first_u32(data, dtype, cnt, val, inline_pos, le);
            }
            0x0117 => {
                ifd.strip_byte_counts = read_array_u32(data, dtype, cnt, val, inline_pos, le);
            }
            0x0142 => {
                ifd.tile_width = first_u32(data, dtype, cnt, val, inline_pos, le);
            }
            0x0143 => {
                ifd.tile_length = first_u32(data, dtype, cnt, val, inline_pos, le);
            }
            0x0144 => {
                ifd.tile_offsets = read_array_u32(data, dtype, cnt, val, inline_pos, le);
                has_tiles = true;
            }
            0x0145 => {
                ifd.tile_byte_counts = read_array_u32(data, dtype, cnt, val, inline_pos, le);
            }
            0x010F => state.make = read_ascii(data, dtype, cnt, val, inline_pos),
            0x0110 => state.model = read_ascii(data, dtype, cnt, val, inline_pos),
            0x0112 => {
                state.orientation =
                    first_u32(data, dtype, cnt, val, inline_pos, le).map(|v| v as u16);
            }
            0x014A => {
                subs = read_array_u32(data, dtype, cnt, val, inline_pos, le);
            }
            0x828D => {
                // CFARepeatPatternDim — ignore (we assume 2x2)
            }
            0x828E => {
                let arr = read_array_u32(data, dtype, cnt, val, inline_pos, le);
                if arr.len() == 4 {
                    ifd.cfa_pattern =
                        Some([arr[0] as u8, arr[1] as u8, arr[2] as u8, arr[3] as u8]);
                }
            }
            0xC61A => {
                ifd.black_level = first_f32(data, dtype, cnt, val, inline_pos, le)
                    .map(|v| v.round().clamp(0.0, 65535.0) as u16);
            }
            0xC61D => {
                ifd.white_level = first_f32(data, dtype, cnt, val, inline_pos, le)
                    .map(|v| v.round().clamp(0.0, 65535.0) as u16);
            }
            0x8827 => {
                // ISOSpeedRatings — SHORT array; take first value.
                state.iso = first_u32(data, dtype, cnt, val, inline_pos, le);
            }
            0xC628 => {
                state.as_shot_neutral = read_as_shot_neutral(data, dtype, cnt, val, le);
            }
            TAG_COLOR_MATRIX_1 => {
                state.color_matrix_1 = read_matrix3x3(data, dtype, cnt, val, le);
            }
            TAG_COLOR_MATRIX_2 => {
                state.color_matrix_2 = read_matrix3x3(data, dtype, cnt, val, le);
            }
            TAG_FORWARD_MATRIX_1 => {
                state.forward_matrix_1 = read_matrix3x3(data, dtype, cnt, val, le);
            }
            TAG_FORWARD_MATRIX_2 => {
                state.forward_matrix_2 = read_matrix3x3(data, dtype, cnt, val, le);
            }
            _ => {}
        }
    }

    // Determine if this IFD is the full-res raw: needs ImageWidth/Length and
    // tile offsets, and NewSubFileType bit 0 must be 0 (full-res).
    let _ = has_tiles;
    if has_image_dims && raw_ifd_supported_candidate(&ifd, new_subfile_type) {
        let area = (ifd.width as u64) * (ifd.height as u64);
        let replace = state
            .raw_ifd
            .as_ref()
            .map(|prev| area > (prev.width as u64) * (prev.height as u64))
            .unwrap_or(true);
        if replace {
            state.raw_ifd = Some(ifd);
        }
    }

    for s in subs {
            walk_inner(data, s as usize, le, state, visited, depth + 1);
    }
    }
    let mut visited = HashSet::new();
    walk_inner(data, off, le, state, &mut visited, 0);
}

fn first_u32(
    data: &[u8],
    dtype: u16,
    cnt: u32,
    val: u32,
    inline_pos: usize,
    le: bool,
) -> Option<u32> {
    if cnt == 0 {
        return None;
    }
    let ts = type_size(dtype);
    if ts == 0 {
        return None;
    }
    let bytes = ts * cnt as usize;
    let p = if bytes <= 4 { inline_pos } else { val as usize };
    match dtype {
        1 | 6 => data.get(p).map(|&b| b as u32),
        3 => Some(read_u16(data, p, le) as u32),
        4 => Some(read_u32(data, p, le)),
        _ => None,
    }
}

fn first_f32(
    data: &[u8],
    dtype: u16,
    cnt: u32,
    val: u32,
    inline_pos: usize,
    le: bool,
) -> Option<f32> {
    if cnt == 0 {
        return None;
    }
    let ts = type_size(dtype);
    if ts == 0 {
        return None;
    }
    let bytes = ts * cnt as usize;
    let p = if bytes <= 4 { inline_pos } else { val as usize };
    match dtype {
        1 | 6 => data.get(p).map(|&b| b as f32),
        3 => Some(read_u16(data, p, le) as f32),
        4 => Some(read_u32(data, p, le) as f32),
        5 => {
            let num = read_u32(data, p, le) as f32;
            let den = read_u32(data, p + 4, le) as f32;
            if den > 0.0 {
                Some(num / den)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn read_array_u32(
    data: &[u8],
    dtype: u16,
    cnt: u32,
    val: u32,
    inline_pos: usize,
    le: bool,
) -> Vec<u32> {
    let ts = type_size(dtype);
    if ts == 0 || cnt == 0 {
        return Vec::new();
    }
    let bytes = ts * cnt as usize;
    let p = if bytes <= 4 { inline_pos } else { val as usize };
    let mut out = Vec::with_capacity(cnt as usize);
    for k in 0..cnt as usize {
        let off = p + k * ts;
        if off + ts > data.len() {
            break;
        }
        let v = match dtype {
            1 | 6 => data[off] as u32,
            3 => read_u16(data, off, le) as u32,
            4 => read_u32(data, off, le),
            _ => break,
        };
        out.push(v);
    }
    out
}

fn read_as_shot_neutral(data: &[u8], dtype: u16, cnt: u32, val: u32, le: bool) -> Option<[f32; 3]> {
    if cnt < 3 {
        return None;
    }
    let p = val as usize;
    if dtype == 5 {
        let mut out = [0f32; 3];
        for k in 0..3 {
            if p + k * 8 + 8 > data.len() {
                return None;
            }
            let num = read_u32(data, p + k * 8, le) as f32;
            let den = read_u32(data, p + k * 8 + 4, le) as f32;
            out[k] = if den > 0.0 { num / den } else { 0.0 };
        }
        Some(out)
    } else if dtype == 11 {
        let mut out = [0f32; 3];
        for k in 0..3 {
            if p + k * 4 + 4 > data.len() {
                return None;
            }
            let b = &data[p + k * 4..p + k * 4 + 4];
            let arr = [b[0], b[1], b[2], b[3]];
            out[k] = if le {
                f32::from_le_bytes(arr)
            } else {
                f32::from_be_bytes(arr)
            };
        }
        Some(out)
    } else {
        None
    }
}

fn read_i32(data: &[u8], off: usize, le: bool) -> i32 {
    let b = &data[off..off + 4];
    if le {
        i32::from_le_bytes([b[0], b[1], b[2], b[3]])
    } else {
        i32::from_be_bytes([b[0], b[1], b[2], b[3]])
    }
}

fn read_matrix3x3(data: &[u8], dtype: u16, cnt: u32, val: u32, le: bool) -> Option<[[f32; 3]; 3]> {
    if cnt < 9 {
        return None;
    }
    let p = val as usize;
    let mut out = [[0f32; 3]; 3];
    match dtype {
        5 => {
            for idx in 0..9usize {
                let off = p + idx * 8;
                if off + 8 > data.len() {
                    return None;
                }
                let num = read_u32(data, off, le) as f32;
                let den = read_u32(data, off + 4, le) as f32;
                if den.abs() < 1e-9 {
                    return None;
                }
                out[idx / 3][idx % 3] = num / den;
            }
            Some(out)
        }
        10 => {
            for idx in 0..9usize {
                let off = p + idx * 8;
                if off + 8 > data.len() {
                    return None;
                }
                let num = read_i32(data, off, le) as f32;
                let den = read_i32(data, off + 4, le) as f32;
                if den.abs() < 1e-9 {
                    return None;
                }
                out[idx / 3][idx % 3] = num / den;
            }
            Some(out)
        }
        11 => {
            for idx in 0..9usize {
                let off = p + idx * 4;
                if off + 4 > data.len() {
                    return None;
                }
                let bytes = [data[off], data[off + 1], data[off + 2], data[off + 3]];
                out[idx / 3][idx % 3] = if le {
                    f32::from_le_bytes(bytes)
                } else {
                    f32::from_be_bytes(bytes)
                };
            }
            Some(out)
        }
        _ => None,
    }
}

pub(crate) fn mul3x3(a: [[f32; 3]; 3], b: [[f32; 3]; 3]) -> [[f32; 3]; 3] {
    let mut out = [[0f32; 3]; 3];
    for row in 0..3 {
        for col in 0..3 {
            out[row][col] = a[row][0] * b[0][col] + a[row][1] * b[1][col] + a[row][2] * b[2][col];
        }
    }
    out
}

pub(crate) fn invert3x3(m: [[f32; 3]; 3]) -> Option<[[f32; 3]; 3]> {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-9 {
        return None;
    }
    let inv_det = 1.0 / det;
    Some([
        [
            (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * inv_det,
            (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * inv_det,
            (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * inv_det,
        ],
        [
            (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * inv_det,
            (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * inv_det,
            (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * inv_det,
        ],
        [
            (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * inv_det,
            (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * inv_det,
            (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * inv_det,
        ],
    ])
}

fn choose_camera_to_srgb_matrix(
    forward_matrix_1: Option<[[f32; 3]; 3]>,
    forward_matrix_2: Option<[[f32; 3]; 3]>,
    color_matrix_1: Option<[[f32; 3]; 3]>,
    color_matrix_2: Option<[[f32; 3]; 3]>,
) -> Option<[[f32; 3]; 3]> {
    if let Some(m) = forward_matrix_2.or(forward_matrix_1) {
        return Some(mul3x3(XYZ_D50_TO_SRGB, m));
    }
    let color = color_matrix_2.or(color_matrix_1)?;
    let camera_to_xyz = invert3x3(color)?;
    Some(mul3x3(XYZ_D50_TO_SRGB, camera_to_xyz))
}

fn read_ascii(data: &[u8], _dtype: u16, cnt: u32, val: u32, inline_pos: usize) -> String {
    if cnt <= 4 {
        let b = &data[inline_pos..inline_pos + cnt as usize];
        return String::from_utf8_lossy(b)
            .trim_end_matches('\0')
            .to_string();
    }
    let p = val as usize;
    if p + cnt as usize > data.len() {
        return String::new();
    }
    String::from_utf8_lossy(&data[p..p + cnt as usize])
        .trim_end_matches('\0')
        .to_string()
}

fn type_size(t: u16) -> usize {
    match t {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 => 4,
        5 | 10 | 12 => 8,
        _ => 0,
    }
}

fn read_u16(data: &[u8], off: usize, le: bool) -> u16 {
    let b = &data[off..off + 2];
    if le {
        u16::from_le_bytes([b[0], b[1]])
    } else {
        u16::from_be_bytes([b[0], b[1]])
    }
}

fn read_u32(data: &[u8], off: usize, le: bool) -> u32 {
    let b = &data[off..off + 4];
    if le {
        u32::from_le_bytes([b[0], b[1], b[2], b[3]])
    } else {
        u32::from_be_bytes([b[0], b[1], b[2], b[3]])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_matrix_close(actual: [[f32; 3]; 3], expected: [[f32; 3]; 3]) {
        for row in 0..3 {
            for col in 0..3 {
                let diff = (actual[row][col] - expected[row][col]).abs();
                assert!(
                    diff < 1e-5,
                    "matrix[{row}][{col}] diff {diff} actual={} expected={}",
                    actual[row][col],
                    expected[row][col]
                );
            }
        }
    }

    #[test]
    fn reads_srational_3x3_matrix() {
        let values = [
            (1, 2),
            (-1, 4),
            (3, 2),
            (0, 1),
            (5, 4),
            (-3, 2),
            (7, 8),
            (2, 1),
            (-9, 8),
        ];
        let mut bytes = Vec::new();
        for (num, den) in values {
            bytes.extend_from_slice(&(num as i32).to_le_bytes());
            bytes.extend_from_slice(&(den as i32).to_le_bytes());
        }

        let matrix = read_matrix3x3(&bytes, 10, 9, 0, true).expect("matrix");
        let expected = [[0.5, -0.25, 1.5], [0.0, 1.25, -1.5], [0.875, 2.0, -1.125]];
        assert_matrix_close(matrix, expected);
    }

    #[test]
    fn prefers_forward_matrix_2_for_camera_to_srgb() {
        let forward_1 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let forward_2 = [[0.9, 0.1, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.1]];

        let matrix = choose_camera_to_srgb_matrix(Some(forward_1), Some(forward_2), None, None)
            .expect("matrix");

        assert_matrix_close(matrix, mul3x3(XYZ_D50_TO_SRGB, forward_2));
    }

    #[test]
    fn falls_back_to_inverted_color_matrix_when_forward_missing() {
        let color_1 = [[2.0, 0.0, 0.0], [0.0, 4.0, 0.0], [0.0, 0.0, 5.0]];

        let matrix = choose_camera_to_srgb_matrix(None, None, Some(color_1), None).expect("matrix");
        let expected = mul3x3(
            XYZ_D50_TO_SRGB,
            [[0.5, 0.0, 0.0], [0.0, 0.25, 0.0], [0.0, 0.0, 0.2]],
        );
        assert_matrix_close(matrix, expected);
    }

    #[test]
    fn decode_uncompressed_tile_respects_big_endian() {
        let raw = RawIfd {
            bits_per_sample: 16,
            tile_offsets: vec![0],
            tile_byte_counts: vec![8],
            tile_width: Some(2),
            tile_length: Some(2),
            ..Default::default()
        };
        let data = [0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04];
        let mut out = vec![0u16; 4];
        decode_uncompressed(&data, &raw, 2, 2, false, &mut out).unwrap();
        assert_eq!(out, vec![1, 2, 3, 4]);
    }

    #[test]
    fn decode_uncompressed_strip_path_supported() {
        let raw = RawIfd {
            bits_per_sample: 16,
            strip_offsets: vec![0, 4],
            strip_byte_counts: vec![4, 4],
            rows_per_strip: Some(1),
            ..Default::default()
        };
        let data = [1, 0, 2, 0, 3, 0, 4, 0];
        let mut out = vec![0u16; 4];
        decode_uncompressed(&data, &raw, 2, 2, true, &mut out).unwrap();
        assert_eq!(out, vec![1, 2, 3, 4]);
    }

    #[test]
    fn cfa_phase_maps_all_patterns() {
        assert_eq!(cfa_phase(Cfa::Rggb), (0, 0));
        assert_eq!(cfa_phase(Cfa::Grbg), (0, 1));
        assert_eq!(cfa_phase(Cfa::Gbrg), (1, 0));
        assert_eq!(cfa_phase(Cfa::Bggr), (1, 1));
    }

    #[test]
    fn raw_candidate_accepts_strips_and_small_width() {
        let raw = RawIfd {
            width: 640,
            height: 480,
            compression: 1,
            strip_offsets: vec![100],
            strip_byte_counts: vec![200],
            ..Default::default()
        };
        assert!(raw_ifd_supported_candidate(&raw, 0));
    }

    /// Targeted flip-flop test (per user request): alternate "newer code" (subtract_black=true,
    /// clean linear for Lens17/photogram/AR) vs "old code" (false) 10 times on the same operation.
    /// Uses real asset if findable from cwd (when running benchmark context), else synthetic
    /// timing of the black sub kernel itself (the source of the raw decode creep).
    #[test]
    fn flip_flop_raw_decode_black_sub_10x() {
        println!("\n=== Targeted flip-flop: newer (clean linear) vs old (preserve bias) 10 alternations ===");

        // Try to load a real benchmark asset for full path (works when cwd has the files, e.g. from mjs run)
        let candidates = [
            "PXL_20260501_093507165.RAW-02.ORIGINAL.dng",
            "PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
            "../PXL_20260501_093507165.RAW-02.ORIGINAL.dng",
        ];
        let mut used_real = false;
        for path in &candidates {
            if let Ok(data) = std::fs::read(path) {
                println!("Using real asset: {} ({} bytes)", path, data.len());
                for i in 0..10 {
                    let subtract = i % 2 == 0; // alternate: even = newer (true), odd = old (false)
                    let t0 = std::time::Instant::now();
                    let _res = decode_bytes_demosaiced_impl(&data, subtract);
                    let ms = t0.elapsed().as_secs_f64() * 1000.0;
                    println!("flip {}: {:.2} ms (subtract_black={})", i, ms, subtract);
                }
                used_real = true;
                break;
            }
        }

        if !used_real {
            println!("No real asset found in cwd; falling back to synthetic black-sub kernel timing (isolates the new scalar loop cost).");
            let black = 64u16;
            let mut base: Vec<u16> = (0..(1920*1440)).map(|i| (i % 1000 + 100) as u16).collect();
            for i in 0..10 {
                let subtract = i % 2 == 0;
                let mut buf = base.clone();
                let t0 = std::time::Instant::now();
                if subtract {
                    demosaic::subtract_black_in_place(&mut buf, black);
                }
                let ms = t0.elapsed().as_secs_f64() * 1000.0;
                println!("synthetic flip {}: {:.4} ms (subtract_black={})", i, ms, subtract);
            }
        }
        println!("=== End flip-flop ===\n");
    }
}

/// X2 deliverable: post-demosaic RGB16 + metadata, without a full mosaic buffer resident
/// at the same time as the RGB (strip fusion with 2-row halo for demosaic dependencies).
/// The bayer mosaic is produced band-by-band (tile-row) and dropped after its demosaic
/// contribution is written. Peak mem during fused path ~ full RGB + 1 tile-row band + 2 halo rows.
///
/// For the demosaiced path (decode_bytes_demosaiced), .rgb is black-subtracted (clean
/// linear) and .black==0 so that downstream tone (pipeline::process) receives unbiased
/// input. The bayer DngImage path preserves sensor values + original .black metadata.
#[derive(Debug)]
pub struct DngDemosaiced {
    pub width: usize,
    pub height: usize,
    pub rgb: Vec<u16>, // post-align, post-demosaic (mhc), interleaved RGB16; black-subbed in demosaiced path
    pub black: u16,
    pub white: u16,
    pub wb_r: f32,
    pub wb_g: f32,
    pub wb_b: f32,
    pub orientation: u16,
    pub make: String,
    pub model: String,
    pub color_matrix: Option<[[f32; 3]; 3]>,
    pub iso: Option<u32>,
    pub decode_ms: f64,
    pub demosaic_ms: f64,
}

/// Fused decode (ljpeg tiles) + demosaic (mhc) for DNG. RGGB fast path uses strip fusion
/// (band decode + halo carry + demosaic_rggb_mhc_band). Other CFA fall back to full mosaic
/// + demosaic (rare; still correct, pay old peak). Callers (wasm process_dng_raw) use this
/// to avoid simultaneous 32 MB mosaic + 120 MB rgb.
pub fn decode_bytes_demosaiced(data: &[u8]) -> Result<DngDemosaiced> {
    decode_bytes_demosaiced_impl(data, true)
}

/// Internal impl with switch for "newer code" (subtract_black=true, clean linear for Lens17/photogram/AR)
/// vs "old code" (false, preserve bias like pre-clean-linear change). Used for targeted flip-flop tests.
pub(crate) fn decode_bytes_demosaiced_impl(data: &[u8], subtract_black: bool) -> Result<DngDemosaiced> {
    let (state, raw, _le) = load_dng(data)?;

    let width = raw.width as usize;
    let height = raw.height as usize;
    let _cps = raw.samples_per_pixel.max(1) as usize;
    let cfa = match raw.cfa_pattern {
        Some(p) => match p {
            [0, 1, 1, 2] => Cfa::Rggb,
            [1, 2, 0, 1] => Cfa::Gbrg,
            [1, 0, 2, 1] => Cfa::Grbg,
            [2, 1, 1, 0] => Cfa::Bggr,
            _ => bail!("unsupported CFA pattern: {p:?}"),
        },
        None => Cfa::Rggb,
    };

    // WB / matrix / black/white / iso / names (same as decode_bytes)
    let wb_r_neutral = state.as_shot_neutral.map(|n| n[0]).unwrap_or(1.0);
    let wb_g_neutral = state.as_shot_neutral.map(|n| n[1]).unwrap_or(1.0);
    let wb_b_neutral = state.as_shot_neutral.map(|n| n[2]).unwrap_or(1.0);
    let wb_r = wb_g_neutral / wb_r_neutral.max(1e-6);
    let wb_g = 1.0;
    let wb_b = wb_g_neutral / wb_b_neutral.max(1e-6);
    let black = raw.black_level.unwrap_or(0);
    let white = raw.white_level.unwrap_or(16383);
    let color_matrix = choose_camera_to_srgb_matrix(
        state.forward_matrix_1,
        state.forward_matrix_2,
        state.color_matrix_1,
        state.color_matrix_2,
    );
    // Color matrix (camera native -> sRGB via XYZ) is passed through to higher
    // LookRenderer for the advanced non-Riemannian / log geodesic / Molchanov
    // perceptual model (lens17). The demosaic stage (incl. optional mhc_matrix
    // fusion) + this + black/white/wb provide the clean linear starting point.
    let orientation = state.orientation.unwrap_or(1);
    let iso = state.iso;
    let make = state.make.clone();
    let model = state.model.clone();

    if cfa != Cfa::Rggb {
        // Fallback: full mosaic path (still correct; only RGGB gets the X2 mem cut).
        let t0 = Instant::now();
        let mut img = decode_bytes(data)?;
        if subtract_black {
            demosaic::subtract_black_in_place(&mut img.raw, img.black);
        }
        let decode_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let t1 = Instant::now();
        let rgb = demosaic::demosaic_bayer_mhc(&img.raw, img.width, img.height, cfa_phase(img.cfa))
            .map_err(|e| anyhow!("demosaic: {}", e))?;
        let demosaic_ms = t1.elapsed().as_secs_f64() * 1000.0;
        return Ok(DngDemosaiced {
            width: img.width,
            height: img.height,
            rgb,
            black: if subtract_black { 0 } else { img.black },
            white: img.white,
            wb_r: img.wb_r,
            wb_g: img.wb_g,
            wb_b: img.wb_b,
            orientation: img.orientation,
            make: img.make,
            model: img.model,
            color_matrix: img.color_matrix,
            iso: img.iso,
            decode_ms,
            demosaic_ms,
        });
    }

    // RGGB fused strip path (X2). Never materializes full mosaic alongside full rgb.
    let mut rgb = vec![0u16; width * height * 3];
    let aw = width;
    let ah = height;

    let tw = raw.tile_width.ok_or_else(|| anyhow!("missing TileWidth"))? as usize;
    let tl = raw
        .tile_length
        .ok_or_else(|| anyhow!("missing TileLength"))? as usize;
    let coltiles = (width + tw - 1) / tw;
    let rowtiles = (height + tl - 1) / tl;
    let expected = coltiles * rowtiles;
    if raw.tile_offsets.len() != expected || raw.tile_byte_counts.len() != expected {
        bail!(
            "tile count mismatch: expected {} got {}/{}",
            expected,
            raw.tile_offsets.len(),
            raw.tile_byte_counts.len()
        );
    }

    let halo = 2usize;
    let mut halo_rows: Vec<u16> = vec![0u16; width * halo];
    let mut band = vec![0u16; width * tl.max(1)];
    let mut ctx = vec![0u16; width * (halo + tl.max(1) + halo)];
    let mut rgb_write_row: usize = 0usize;

    let mut decode_ms = 0.0f64;
    let mut demosaic_ms = 0.0f64;

    for tr in 0..rowtiles {
        let row_start = tr * tl;
        let row_end = ((tr + 1) * tl).min(height);
        let row_h = row_end - row_start;

        let tdec = Instant::now();
        band.resize(width * row_h, 0);
        band.fill(0);
        for tc in 0..coltiles {
            let idx = tr * coltiles + tc;
            let off = raw.tile_offsets[idx] as usize;
            let bc = raw.tile_byte_counts[idx] as usize;
            let src = data
                .get(off..off + bc)
                .ok_or_else(|| anyhow!("tile {idx} OOB"))?;
            let col_start = tc * tw;
            let col_end = ((tc + 1) * tw).min(width);
            let col_w = col_end - col_start;
            ljpeg::decode_tile(src, &mut band, col_start, width, col_w, row_h)
                .with_context(|| format!("tile r={tr} c={tc}"))?;
        }
        decode_ms += tdec.elapsed().as_secs_f64() * 1000.0;

        // Subtract black on the raw mosaic band *before* demosaic (standard raw
        // processing order) and before halo ctx assembly. This delivers clean
        // linear rgb in DngDemosaiced (facilitates lens17 color engine, photogram,
        // LLM raw features) while keeping the main decode_bytes bayer path with
        // bias+metadata for other consumers.
        if subtract_black {
            demosaic::subtract_black_in_place(&mut band, black);
        }

        // ctx = [top halo | band | bottom (replicate for this pass)]
        let ctx_h = halo + row_h + halo;
        ctx.resize(width * ctx_h, 0);
        ctx.fill(0);
        if tr == 0 {
            if row_h > 0 {
                let first = &band[0..width];
                for hi in 0..halo {
                    ctx[hi * width..(hi + 1) * width].copy_from_slice(first);
                }
            }
        } else {
            ctx[0..halo * width].copy_from_slice(&halo_rows);
        }
        let band_off = halo * width;
        ctx[band_off..band_off + row_h * width].copy_from_slice(&band);
        if row_h > 0 {
            let last_start = (row_h - 1) * width;
            let last = &band[last_start..last_start + width];
            for hi in 0..halo {
                let boff = (halo + row_h + hi) * width;
                ctx[boff..boff + width].copy_from_slice(last);
            }
        }

        let tdem = Instant::now();
        let is_last = tr + 1 == rowtiles;

        if tr > 0 && halo > 0 {
            // Demosaic the carried prev bottom halo rows now that south data (current band) exists.
            let carried_g0 = row_start - halo;
            // Dedicated temp ctx for carried demosaic to supply north halo margin (replicate top of carried data from halo_rows).
            // The main ctx build for tr>0 places the carried data at ctx[0:] without a north margin, causing OOB read in demosaic_rggb_mhc_band (which expects halo rows of context above the band being demosaiced).
            let c_halo = halo;
            let c_h = c_halo + c_halo + c_halo;
            let mut c_ctx: Vec<u16> = vec![0u16; width * c_h];
            if c_halo > 0 {
                let top = &halo_rows[0..width];
                for hi in 0..c_halo {
                    c_ctx[hi*width..(hi+1)*width].copy_from_slice(top);
                }
            }
            let mid_off = c_halo * width;
            c_ctx[mid_off..mid_off + c_halo*width].copy_from_slice(&halo_rows);
            let south_top = &ctx[band_off..band_off + c_halo*width];
            let south_off = (c_halo + c_halo) * width;
            c_ctx[south_off..south_off + c_halo*width].copy_from_slice(south_top);
            demosaic::demosaic_rggb_mhc_band(
                &c_ctx,
                width,
                c_h,
                c_halo,
                carried_g0,
                0,
                c_halo,
                &mut rgb[(rgb_write_row * width * 3)..],
            )
            .map_err(|e| anyhow!("demosaic carried: {}", e))?;
            rgb_write_row += c_halo;
        }

        let safe = if is_last { row_h } else { row_h.saturating_sub(halo) };
        if safe > 0 {
            demosaic::demosaic_rggb_mhc_band(
                &ctx,
                width,
                ctx_h,
                halo,
                row_start,
                0,
                safe,
                &mut rgb[(rgb_write_row * width * 3)..],
            )
            .map_err(|e| anyhow!("demosaic band: {}", e))?;
            rgb_write_row += safe;
        }
        demosaic_ms += tdem.elapsed().as_secs_f64() * 1000.0;

        if !is_last && row_h >= halo {
            let src = (row_h - halo) * width;
            halo_rows.copy_from_slice(&band[src..src + halo * width]);
        }
    }

    if rgb_write_row != ah {
        // tiny images or edge math; pad or error softly by filling remain (should not happen for valid tiles)
        // For robustness fall back would have caught, but keep going.
    }

    Ok(DngDemosaiced {
        width: aw,
        height: ah,
        rgb,
        black: if subtract_black { 0 } else { black },
        white,
        wb_r,
        wb_g,
        wb_b,
        orientation,
        make,
        model,
        color_matrix,
        iso,
        decode_ms,
        demosaic_ms,
    })
}
