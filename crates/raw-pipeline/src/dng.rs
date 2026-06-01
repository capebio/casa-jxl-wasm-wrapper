//! DNG raw decoder. Walks IFD0 + SubIFDs, finds the full-resolution raw
//! SubIFD, then decodes its lossless-JPEG tiles (compression=7) or raw strips
//! (compression=1). Pulls BlackLevel, WhiteLevel, AsShotNeutral and CFAPattern
//! out of the same IFD chain.

use crate::ljpeg;
use anyhow::{anyhow, bail, Context, Result};
#[cfg(feature = "parallel")]
use rayon::prelude::*;
use std::sync::Mutex;

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

const XYZ_D50_TO_SRGB: [[f32; 3]; 3] = [
    [3.133_856_1, -1.616_866_7, -0.490_614_6],
    [-0.978_768_4, 1.916_141_5, 0.033_454_0],
    [0.071_945_3, -0.228_991_4, 1.405_242_7],
];

pub fn decode(path: &std::path::Path) -> Result<DngImage> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    decode_bytes(&bytes)
}

pub fn decode_bytes(data: &[u8]) -> Result<DngImage> {
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
        .ok_or_else(|| anyhow!("no raw SubIFD found"))?;

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
        1 => decode_uncompressed(data, &raw, width, height, &mut out)?,
        7 => decode_tiles(data, &raw, width, height, cps, &mut out)?,
        c => bail!("DNG compression {c} not supported"),
    }

    let wb_r_neutral = state.as_shot_neutral.map(|n| n[0]).unwrap_or(0.5);
    let wb_g_neutral = state.as_shot_neutral.map(|n| n[1]).unwrap_or(1.0);
    let wb_b_neutral = state.as_shot_neutral.map(|n| n[2]).unwrap_or(0.6);
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

    let out_mtx = Mutex::new(out);
    let _ = cps; // implied by SOF
    #[cfg(feature = "parallel")]
    let iter = (0..rowtiles).into_par_iter();
    #[cfg(not(feature = "parallel"))]
    let mut iter = (0..rowtiles).into_iter();
    iter.try_for_each(|tr| -> Result<()> {
        let row_start = tr * tl;
        let row_end = ((tr + 1) * tl).min(height);
        let row_height = row_end - row_start;
        let mut row_band = vec![0u16; width * row_height];
        for tc in 0..coltiles {
            let idx = tr * coltiles + tc;
            let off = raw.tile_offsets[idx] as usize;
            let bc = raw.tile_byte_counts[idx] as usize;
            let src = data
                .get(off..off + bc)
                .ok_or_else(|| anyhow!("tile {idx} OOB"))?;
            let col_start = tc * tw;
            let col_end = ((tc + 1) * tw).min(width);
            let col_width = col_end - col_start;
            ljpeg::decode_tile(src, &mut row_band, col_start, width, col_width, row_height)
                .with_context(|| format!("tile r={tr} c={tc}"))?;
        }
        let mut guard = out_mtx.lock().unwrap();
        let dst_start = row_start * width;
        guard[dst_start..dst_start + row_band.len()].copy_from_slice(&row_band);
        Ok(())
    })?;
    Ok(())
}

fn decode_uncompressed(
    data: &[u8],
    raw: &RawIfd,
    width: usize,
    height: usize,
    out: &mut [u16],
) -> Result<()> {
    let bps = raw.bits_per_sample;
    if raw.tile_offsets.is_empty() {
        bail!("uncompressed DNG: strip-offset path not implemented");
    }
    if bps != 16 {
        bail!("uncompressed DNG: bps {} unsupported", bps);
    }
    let tw = raw.tile_width.ok_or_else(|| anyhow!("TileWidth"))? as usize;
    let tl = raw.tile_length.ok_or_else(|| anyhow!("TileLength"))? as usize;
    let coltiles = (width + tw - 1) / tw;
    let rowtiles = (height + tl - 1) / tl;
    for tr in 0..rowtiles {
        for tc in 0..coltiles {
            let idx = tr * coltiles + tc;
            let off = raw.tile_offsets[idx] as usize;
            let bc = raw.tile_byte_counts[idx] as usize;
            let src = &data[off..off + bc];
            let col_start = tc * tw;
            let col_end = ((tc + 1) * tw).min(width);
            let row_start = tr * tl;
            let row_end = ((tr + 1) * tl).min(height);
            let mut sp = 0;
            for r in row_start..row_end {
                for c in col_start..col_end {
                    out[r * width + c] = u16::from_le_bytes([src[sp], src[sp + 1]]);
                    sp += 2;
                }
                sp += (tw - (col_end - col_start)) * 2;
            }
        }
    }
    Ok(())
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

#[derive(Default, Debug)]
struct RawIfd {
    width: u32,
    height: u32,
    bits_per_sample: u16,
    samples_per_pixel: u16,
    compression: u32,
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

fn walk(data: &[u8], off: usize, le: bool, state: &mut WalkState) {
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
    let is_subsampled = (new_subfile_type & 1) != 0;
    if has_image_dims
        && has_tiles
        && !is_subsampled
        && (ifd.compression == 7 || ifd.compression == 1 || ifd.compression == 0x884C)
        && ifd.width > 1000
    {
        if state.raw_ifd.is_none() || ifd.width > state.raw_ifd.as_ref().unwrap().width {
            state.raw_ifd = Some(ifd);
        }
    }

    for s in subs {
        walk(data, s as usize, le, state);
    }
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

fn mul3x3(a: [[f32; 3]; 3], b: [[f32; 3]; 3]) -> [[f32; 3]; 3] {
    let mut out = [[0f32; 3]; 3];
    for row in 0..3 {
        for col in 0..3 {
            out[row][col] = a[row][0] * b[0][col] + a[row][1] * b[1][col] + a[row][2] * b[2][col];
        }
    }
    out
}

fn invert3x3(m: [[f32; 3]; 3]) -> Option<[[f32; 3]; 3]> {
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
}
