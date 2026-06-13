//! Lossless JPEG (SOF3) decoder for DNG tiles.
//!
//! Spec: ITU T.81 Annex H + Adobe DNG. Handles predictor 1 (left), arbitrary
//! component count and precision. No restart markers, no quantisation tables.
//!
//! Output is the raw pixel stream in row-major order, with components
//! interleaved (raw[row * sof_w * cps + ljpeg_col * cps + comp]).

use anyhow::{bail, Result};
use std::cell::RefCell;
use std::rc::Rc;

const MAX_COMPONENTS: usize = 4;

thread_local! {
    static DHT_CACHE: RefCell<Vec<(Vec<u8>, Rc<HuffTable>)>> = RefCell::new(Vec::new());
}

struct HuffTable {
    // Decoded length per code → list of values, plus min/max code per length.
    // We use the canonical method: store (code_len, value) pairs sorted by code.
    // For decode we maintain a max_bits-sized table (right-sized, not fixed 16).
    lookup: Vec<(u8, u8)>, // index = peek(max_bits), (consume_bits, value). 0 if invalid.
    max_bits: u8,
}

impl HuffTable {
    fn build(bits: &[u8; 16], values: &[u8]) -> Result<Self> {
        let total: usize = bits.iter().map(|&b| b as usize).sum();
        if total > values.len() {
            bail!("ljpeg: huffman values shorter than declared");
        }
        let mut codes = Vec::with_capacity(total);
        let mut code: u32 = 0;
        let mut idx = 0usize;
        let mut max_bits = 0u8;
        for len_minus_1 in 0..16usize {
            let n = bits[len_minus_1] as usize;
            let code_len = (len_minus_1 + 1) as u8;
            for _ in 0..n {
                codes.push((code_len, values[idx], code));
                idx += 1;
                code += 1;
                if code_len > max_bits {
                    max_bits = code_len;
                }
            }
            code <<= 1;
        }
        // Build max_bits prefix lookup (L10): for each code, all values whose
        // top `code_len` bits match get filled. Sized 1<<max_bits not 1<<16.
        let table_size = if max_bits == 0 { 1 } else { 1usize << max_bits };
        let mut lookup = vec![(0u8, 0u8); table_size];
        for &(code_len, value, code) in &codes {
            let shift = max_bits as u32 - code_len as u32;
            let lo = (code << shift) as usize;
            let hi = lo + (1 << shift);
            for slot in &mut lookup[lo..hi] {
                *slot = (code_len, value);
            }
        }
        Ok(HuffTable { lookup, max_bits })
    }

}

struct BitReader<'a> {
    src: &'a [u8],
    pos: usize,
    bits: u64,
    nbits: u32,
    finished: bool,
    real_in_buf: u32,
    truncated: bool,
}

impl<'a> BitReader<'a> {
    fn new(src: &'a [u8]) -> Self {
        BitReader {
            src,
            pos: 0,
            bits: 0,
            nbits: 0,
            finished: false,
            real_in_buf: 0,
            truncated: false,
        }
    }

    #[inline]
    fn fill(&mut self) {
        while self.nbits <= 48 && !self.finished {
            if self.pos >= self.src.len() {
                self.finished = true;
                break;
            }
            let b = self.src[self.pos];
            self.pos += 1;
            if b == 0xFF {
                if self.pos >= self.src.len() {
                    self.finished = true;
                    break;
                }
                let next = self.src[self.pos];
                if next == 0x00 {
                    // Stuffed FF.
                    self.pos += 1;
                    self.bits = (self.bits << 8) | 0xFF;
                    self.nbits += 8;
                    self.real_in_buf += 8;
                } else {
                    // Marker — end of compressed stream.
                    self.finished = true;
                    break;
                }
            } else {
                self.bits = (self.bits << 8) | (b as u64);
                self.nbits += 8;
                self.real_in_buf += 8;
            }
        }
    }

    #[inline(always)]
    fn peek(&mut self, n: u32) -> u32 {
        if n == 0 {
            return 0;
        }
        if self.nbits < n {
            self.fill();
        }
        if self.nbits >= n {
            ((self.bits >> (self.nbits - n)) & ((1u64 << n) - 1)) as u32
        } else {
            // Pad with zeros at end of stream.
            let pad = n - self.nbits;
            ((self.bits << pad) & ((1u64 << n) - 1)) as u32
        }
    }

    #[inline(always)]
    fn consume(&mut self, n: u32) {
        if n > self.real_in_buf {
            self.truncated = true;
            self.real_in_buf = 0;
        } else {
            self.real_in_buf -= n;
        }
        if self.nbits >= n {
            self.nbits -= n;
            self.bits &= (1u64 << self.nbits).wrapping_sub(1);
        } else {
            self.nbits = 0;
            self.bits = 0;
        }
    }

    #[inline(always)]
    fn get_bits(&mut self, n: u32) -> u32 {
        if n == 0 {
            return 0;
        }
        if self.nbits < n {
            self.fill();
        }
        if n > self.real_in_buf {
            self.truncated = true;
        }
        let avail = self.nbits.min(n);
        let mut v = if avail > 0 {
            ((self.bits >> (self.nbits - avail)) & ((1u64 << avail) - 1)) as u32
        } else {
            0
        };
        self.nbits -= avail;
        self.bits &= (1u64 << self.nbits).wrapping_sub(1);
        self.real_in_buf = self.real_in_buf.saturating_sub(avail);
        if avail < n {
            v <<= n - avail;
        }
        v
    }
}

#[inline(always)]
fn extend(diff: i32, t: u32) -> i32 {
    if t == 0 {
        return 0;
    }
    let half = 1i32 << (t - 1);
    if diff < half {
        diff - ((1i32 << t) - 1)
    } else {
        diff
    }
}

#[derive(Default, Debug)]
struct Sof {
    precision: u8,
    height: u32,
    width: u32,
    cps: u8,
    comp_ids: [u8; MAX_COMPONENTS],
}

#[derive(Default, Debug)]
struct Sos {
    predictor: u8,
    point_transform: u8,
    // For each component (in scan order), the DHT id used.
    dht_id: [u8; MAX_COMPONENTS],
}

fn read_marker(src: &[u8], pos: &mut usize) -> Result<u8> {
    while *pos + 1 < src.len() {
        if src[*pos] == 0xFF {
            let m = src[*pos + 1];
            *pos += 2;
            if m == 0x00 || m == 0xFF {
                continue;
            }
            return Ok(m);
        }
        *pos += 1;
    }
    bail!("ljpeg: unexpected EOF looking for marker");
}

fn read_u16_be(src: &[u8], pos: &mut usize) -> Result<u16> {
    if *pos + 2 > src.len() {
        bail!("ljpeg: EOF reading u16");
    }
    let v = u16::from_be_bytes([src[*pos], src[*pos + 1]]);
    *pos += 2;
    Ok(v)
}

fn read_u8(src: &[u8], pos: &mut usize) -> Result<u8> {
    if *pos >= src.len() {
        bail!("ljpeg: EOF reading u8");
    }
    let v = src[*pos];
    *pos += 1;
    Ok(v)
}

/// Decode one self-contained LJPEG bitstream. Output buffer must be writable
/// at `[base + r * stride + c * cps + comp]` for r in 0..sof.height,
/// c in 0..sof.width, comp in 0..sof.cps.
pub fn decode_tile(
    src: &[u8],
    out: &mut [u16],
    base: usize,
    stride_pixels: usize,
    out_pixel_cols: usize,
    out_rows: usize,
) -> Result<()> {
    if src.len() < 4 || src[0] != 0xFF || src[1] != 0xD8 {
        bail!("ljpeg: missing SOI");
    }
    let mut pos = 2usize;

    let mut sof = Sof::default();
    let mut sos = Sos::default();
    let mut dhts: [Option<Rc<HuffTable>>; 4] = [None, None, None, None];
    let mut have_sof = false;
    let mut have_sos = false;

    while !have_sos {
        let marker = read_marker(src, &mut pos)?;
        match marker {
            0xC3 => {
                let _seg_len = read_u16_be(src, &mut pos)?;
                sof.precision = read_u8(src, &mut pos)?;
                sof.height = read_u16_be(src, &mut pos)? as u32;
                sof.width = read_u16_be(src, &mut pos)? as u32;
                sof.cps = read_u8(src, &mut pos)?;
                if sof.cps as usize > MAX_COMPONENTS {
                    bail!("ljpeg: too many components ({})", sof.cps);
                }
                for i in 0..sof.cps as usize {
                    sof.comp_ids[i] = read_u8(src, &mut pos)?;
                    let _h_v = read_u8(src, &mut pos)?;
                    let _tq = read_u8(src, &mut pos)?;
                }
                have_sof = true;
            }
            0xC4 => {
                let seg_len = read_u16_be(src, &mut pos)? as usize;
                if seg_len < 2 { bail!("ljpeg: segment length {} < 2", seg_len); }
                let end = (pos + seg_len - 2).min(src.len());
                while pos < end {
                    let tcth = read_u8(src, &mut pos)?;
                    let tc = tcth >> 4;
                    let th = tcth & 0x0F;
                    if tc != 0 {
                        bail!("ljpeg: DHT non-DC table class {}", tc);
                    }
                    if th >= 4 {
                        bail!("ljpeg: DHT id {} out of range", th);
                    }
                    let mut bits = [0u8; 16];
                    for b in &mut bits {
                        *b = read_u8(src, &mut pos)?;
                    }
                    let total: usize = bits.iter().map(|&b| b as usize).sum();
                    if pos + total > src.len() {
                        bail!("ljpeg: DHT values EOF");
                    }
                    let values = &src[pos..pos + total];
                    pos += total;
                    // L11: thread-local exact-payload cache (Rc, WASM-safe). Key = bits[16]++values.
                    let key: Vec<u8> = bits.iter().copied().chain(values.iter().copied()).collect();
                    let cached = DHT_CACHE.with(|c| {
                        let cache = c.borrow();
                        cache.iter().find(|(k, _)| k == &key).map(|(_, t)| t.clone())
                    });
                    let tbl = if let Some(t) = cached {
                        t
                    } else {
                        let t = Rc::new(HuffTable::build(&bits, values)?);
                        DHT_CACHE.with(|c| {
                            let mut cache = c.borrow_mut();
                            cache.push((key, t.clone()));
                            if cache.len() > 8 {
                                cache.remove(0); // FIFO evict
                            }
                        });
                        t
                    };
                    dhts[th as usize] = Some(tbl);
                }
            }
            0xDA => {
                let _seg_len = read_u16_be(src, &mut pos)?;
                let ns = read_u8(src, &mut pos)? as usize;
                if !have_sof {
                    bail!("ljpeg: SOS before SOF");
                }
                if ns != sof.cps as usize {
                    bail!("ljpeg: SOS component count mismatch");
                }
                for i in 0..ns {
                    let cs = read_u8(src, &mut pos)?;
                    let tdta = read_u8(src, &mut pos)?;
                    let td = tdta >> 4;
                    // Map cs back to SOF component index so td applies to the
                    // correct component slot in our decode loop.
                    let comp_idx = (0..sof.cps as usize)
                        .find(|&k| sof.comp_ids[k] == cs)
                        .unwrap_or(i);
                    sos.dht_id[comp_idx] = td;
                }
                sos.predictor = read_u8(src, &mut pos)?;
                let _se = read_u8(src, &mut pos)?;
                let ahal = read_u8(src, &mut pos)?;
                sos.point_transform = ahal & 0x0F;
                have_sos = true;
            }
            0xD9 => bail!("ljpeg: EOI before SOS"),
            0xDD => {
                let seg_len = read_u16_be(src, &mut pos)? as usize;
                if seg_len != 4 { bail!("ljpeg: bad DRI length {}", seg_len); }
                let interval = read_u16_be(src, &mut pos)?;
                if interval != 0 { bail!("ljpeg: restart markers unsupported (DRI={})", interval); }
            }
            _ => {
                // Skip unknown segment.
                let seg_len = read_u16_be(src, &mut pos)? as usize;
                if seg_len < 2 { bail!("ljpeg: segment length {} < 2", seg_len); }
                pos += seg_len - 2;
            }
        }
    }

    if sos.predictor != 1 {
        bail!("ljpeg: predictor {} not supported", sos.predictor);
    }

    if sof.precision < 2 || sof.precision > 16 {
        bail!("ljpeg: precision {} unsupported", sof.precision);
    }
    if sos.point_transform >= sof.precision {
        bail!("ljpeg: point transform {} >= precision {}", sos.point_transform, sof.precision);
    }

    let cps = sof.cps as usize;
    if cps == 0 || cps > MAX_COMPONENTS {
        bail!("ljpeg: bad component count");
    }
    let sof_w = sof.width as usize;
    let raw_cols = sof_w * cps;
    if raw_cols < out_pixel_cols {
        bail!(
            "ljpeg: SOF raw cols {} less than output width {}",
            raw_cols,
            out_pixel_cols
        );
    }
    let sof_h = sof.height as usize;
    if sof_h < out_rows {
        bail!(
            "ljpeg: SOF height {} less than output height {}",
            sof_h,
            out_rows
        );
    }

    let base_pred = 1i32 << (sof.precision - sos.point_transform - 1);
    let mut br = BitReader::new(&src[pos..]);

    // Per-component previous values: prev_row[comp][col] of previous row.
    // We keep only the current row's column-0 values plus the running
    // left-neighbour during decode.
    let mut prev_row_first = vec![0i32; cps];

    for row in 0..sof_h {
        // Track left predictor per component (for current row).
        let mut left = [0i32; MAX_COMPONENTS];
        for col in 0..sof_w {
            for comp in 0..cps {
                let predictor = if col == 0 {
                    if row == 0 {
                        base_pred
                    } else {
                        prev_row_first[comp]
                    }
                } else {
                    left[comp]
                };

                let table = match &dhts[sos.dht_id[comp] as usize] {
                    Some(t) => t,
                    None => bail!("ljpeg: missing huffman table {}", sos.dht_id[comp]),
                };
                if table.max_bits == 0 {
                    bail!("ljpeg: missing huffman table {}", sos.dht_id[comp]);
                }
                let peek = br.peek(table.max_bits as u32);
                let (consume, t) = table.lookup[peek as usize];
                if consume == 0 {
                    bail!("ljpeg: invalid huffman code at row={row} col={col} comp={comp}");
                }
                br.consume(consume as u32);
                if br.truncated {
                    bail!("ljpeg: entropy bitstream exhausted at row={row} col={col} comp={comp}");
                }
                if t == 16 {
                    if sof.precision != 16 {
                        bail!("ljpeg: category 16 exceeds precision {}", sof.precision);
                    }
                } else if t > sof.precision {
                    bail!("ljpeg: category {} exceeds precision {}", t, sof.precision);
                }
                let diff = if t == 0 {
                    0
                } else if t == 16 {
                    // JPEG T.81 Annex H: category=precision means diff = -2^(P-1)
                    // with no additional bits read.
                    -32768i32
                } else {
                    let bits = br.get_bits(t as u32) as i32;
                    if br.truncated {
                        bail!("ljpeg: entropy bitstream exhausted at row={row} col={col} comp={comp}");
                    }
                    extend(bits, t as u32)
                };

                let val = predictor.wrapping_add(diff);
                left[comp] = val;
                if col == 0 {
                    prev_row_first[comp] = val;
                }

                let raw_col = col * cps + comp;
                if row < out_rows && raw_col < out_pixel_cols {
                    // Lens 23 next: hoist row base to avoid repeated row*stride mul/add inside per-comp
                    let row_base = base + row * stride_pixels;
                    let off = row_base + raw_col;
                    out[off] = ((val << sos.point_transform) & 0xFFFF) as u16;
                }
            }
        }
    }

    Ok(())
}

/// Decode into a caller-provided compact tile buffer (tile_w * tile_h * cps u16s).
/// Callers blit tiles into the frame and may decode many tiles in parallel.
pub fn decode_tile_compact(src: &[u8], out: &mut [u16], tile_w: usize, tile_h: usize) -> Result<()> {
    decode_tile(src, out, 0, tile_w, tile_w, tile_h)
}

#[derive(Debug)]
pub struct TileInfo {
    pub width: u32,
    pub height: u32,
    pub components: u8,
    pub precision: u8,
}

/// Parse markers up to SOF only — cheap planning probe, no entropy decode.
pub fn probe_tile(src: &[u8]) -> Result<TileInfo> {
    if src.len() < 4 || src[0] != 0xFF || src[1] != 0xD8 {
        bail!("ljpeg: missing SOI");
    }
    let mut pos = 2usize;

    let mut sof = Sof::default();
    let mut have_sof = false;

    while !have_sof {
        let marker = read_marker(src, &mut pos)?;
        match marker {
            0xC3 => {
                let _seg_len = read_u16_be(src, &mut pos)?;
                sof.precision = read_u8(src, &mut pos)?;
                sof.height = read_u16_be(src, &mut pos)? as u32;
                sof.width = read_u16_be(src, &mut pos)? as u32;
                sof.cps = read_u8(src, &mut pos)?;
                if sof.cps as usize > MAX_COMPONENTS {
                    bail!("ljpeg: too many components ({})", sof.cps);
                }
                for i in 0..sof.cps as usize {
                    sof.comp_ids[i] = read_u8(src, &mut pos)?;
                    let _h_v = read_u8(src, &mut pos)?;
                    let _tq = read_u8(src, &mut pos)?;
                }
                have_sof = true;
            }
            0xD9 => bail!("ljpeg: EOI before SOF"),
            _ => {
                // Skip unknown segment.
                let seg_len = read_u16_be(src, &mut pos)? as usize;
                if seg_len < 2 { bail!("ljpeg: segment length {} < 2", seg_len); }
                pos += seg_len - 2;
            }
        }
    }

    Ok(TileInfo {
        width: sof.width,
        height: sof.height,
        components: sof.cps,
        precision: sof.precision,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Hand-built minimal SOF3: SOI + SOF3(1comp,2x2,prec=8) + DHT (codes for t=0,1,2,5 at len3) + SOS(Pt=0,pred=1) + entropy for pixels [100,101,102,103] around base=128.
    fn make_minimal_sof3() -> Vec<u8> {
        vec![
            0xFF, 0xD8,
            // SOF3
            0xFF, 0xC3, 0x00, 0x0B,
            0x08, 0x00, 0x02, 0x00, 0x02, 0x01,
            0x01, 0x11, 0x00,
            // DHT: len=0x17, tcTh=0, bits with 4 at [2], values [0,1,2,5]
            0xFF, 0xC4, 0x00, 0x17,
            0x00,
            0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,
            0,1,2,5,
            // SOS
            0xFF, 0xDA, 0x00, 0x08,
            0x01, 0x01, 0x00,
            0x01, 0x00, 0x00,
            // entropy: 21 bits packed (see construction in thinking trace)
            0x63, 0x35, 0x18,
        ]
    }

    #[test]
    fn l15_a_minimal_sof3_decodes_to_known() {
        let src = make_minimal_sof3();
        let mut out = vec![0u16; 4];
        decode_tile(&src, &mut out, 0, 2, 2, 2).expect("decode ok");
        assert_eq!(&out[..], &[100u16, 101, 102, 103]);
    }

    #[test]
    fn l15_b_seg_len_lt_2_errors_not_panic() {
        // Hit DHT arm with seg_len=1
        let src = vec![0xFF, 0xD8, 0xFF, 0xC4, 0x00, 0x01, 0x00];
        let mut out = vec![0u16; 1];
        let e = decode_tile(&src, &mut out, 0, 1, 1, 1).unwrap_err();
        let msg = e.to_string();
        assert!(msg.contains("ljpeg: segment length 1 < 2"), "got: {}", msg);
    }

    #[test]
    fn l15_c_point_transform_ge_precision_errors() {
        // SOI + SOF3(prec=8) + SOS(Pt=8) — bail after SOS before base_pred; no DHT/entropy needed
        let src = vec![
            0xFF, 0xD8,
            0xFF, 0xC3, 0x00, 0x0B,
            0x08, 0x00, 0x02, 0x00, 0x02, 0x01,
            0x01, 0x11, 0x00,
            // SOS with Pt=8
            0xFF, 0xDA, 0x00, 0x08,
            0x01, 0x01, 0x00,
            0x01, 0x00, 0x08,
        ];
        let mut out = vec![0u16; 1];
        let e = decode_tile(&src, &mut out, 0, 1, 1, 1).unwrap_err();
        let msg = e.to_string();
        assert!(msg.contains("ljpeg: point transform 8 >= precision 8"), "got: {}", msg);
    }

    #[test]
    fn l15_d_dri_nonzero_errors() {
        // Insert DRI (len=4, interval=1) after SOF, before DHT; parser hits 0xDD arm before SOS
        let mut src = make_minimal_sof3();
        // insert after SOF (at index ~2+2+11=15? but easier splice after known SOF prefix
        // SOF ends at byte offset 2(SOI)+2+11=15, insert at 15 (before DHT FF)
        let dri = vec![0xFF, 0xDD, 0x00, 0x04, 0x00, 0x01];
        src.splice(15..15, dri);
        let mut out = vec![0u16; 4];
        let e = decode_tile(&src, &mut out, 0, 2, 2, 2).unwrap_err();
        let msg = e.to_string();
        assert!(msg.contains("ljpeg: restart markers unsupported (DRI=1)"), "got: {}", msg);
    }

    #[test]
    fn ljpeg_probe_and_compact_work_for_minimal() {
        let src = make_minimal_sof3();
        let info = probe_tile(&src).expect("probe ok");
        assert_eq!(info.width, 2);
        assert_eq!(info.height, 2);
        assert_eq!(info.components, 1);
        assert_eq!(info.precision, 8);
        let sz = (info.width as usize) * (info.height as usize) * (info.components as usize);
        let mut out = vec![0u16; sz];
        // cps=1 path: pass tile_w as stride/out_pixel_cols
        decode_tile_compact(&src, &mut out, info.width as usize, info.height as usize).expect("compact ok");
        assert_eq!(&out[..], &[100u16, 101, 102, 103]);
    }

    #[test]
    fn ljpeg_probe_errors_on_missing_soi() {
        let src = vec![0x00, 0x01];
        let e = probe_tile(&src).unwrap_err();
        assert!(e.to_string().contains("ljpeg: missing SOI"), "got: {}", e);
    }

    #[test]
    fn ljpeg_predictor_unsupported_still_bails() {
        // L12 not implemented (unwarranted for Olympus-primary corpus; current bail is acceptable hygiene)
        // Use a fresh src with predictor=7 (no mutation of shared helper needed)
        let src_bad = vec![
            0xFF, 0xD8,
            0xFF, 0xC3, 0x00, 0x0B,
            0x08, 0x00, 0x02, 0x00, 0x02, 0x01,
            0x01, 0x11, 0x00,
            0xFF, 0xDA, 0x00, 0x08,
            0x01, 0x01, 0x00,
            0x07, 0x00, 0x00, // predictor=7
        ];
        let mut out = vec![0u16; 4];
        let e = decode_tile(&src_bad, &mut out, 0, 2, 2, 2).unwrap_err();
        let msg = e.to_string();
        assert!(msg.contains("ljpeg: predictor 7 not supported"), "got: {}", msg);
    }

    #[test]
    fn ljpeg_huffman_lookup_right_sized() {
        // L10: build yields 1<<max_bits not 1<<16
        let bits = [0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0];
        let values = [0u8,1,2,5];
        let tbl = HuffTable::build(&bits, &values).unwrap();
        assert_eq!(tbl.max_bits, 3);
        assert_eq!(tbl.lookup.len(), 1 << 3, "L10 right-size: expected 8, got {}", tbl.lookup.len());
    }

    #[test]
    fn ljpeg_dht_cache_functional_across_calls() {
        // L11: cache hit path exercised (same DHT bytes) — still decodes correctly
        let src = make_minimal_sof3();
        let mut out1 = vec![0u16; 4];
        decode_tile(&src, &mut out1, 0, 2, 2, 2).unwrap();
        let mut out2 = vec![0u16; 4];
        decode_tile(&src, &mut out2, 0, 2, 2, 2).unwrap();
        assert_eq!(out1, out2);
    }

    #[test]
    fn ljpeg_truncated_entropy_errors() {
        let mut src = make_minimal_sof3();
        src.pop();
        let mut out = vec![0u16; 4];
        let err = decode_tile(&src, &mut out, 0, 2, 2, 2).unwrap_err();
        assert!(err.to_string().contains("ljpeg: entropy bitstream exhausted"), "got: {}", err);
    }

    #[test]
    fn ljpeg_rejects_huffman_category_above_precision() {
        let src = vec![
            0xFF, 0xD8,
            0xFF, 0xC3, 0x00, 0x0B,
            0x08, 0x00, 0x01, 0x00, 0x01, 0x01,
            0x01, 0x11, 0x00,
            0xFF, 0xC4, 0x00, 0x14,
            0x00,
            1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            9,
            0xFF, 0xDA, 0x00, 0x08,
            0x01, 0x01, 0x00,
            0x01, 0x00, 0x00,
            0x00,
        ];
        let mut out = vec![0u16; 1];
        let err = decode_tile(&src, &mut out, 0, 1, 1, 1).unwrap_err();
        assert!(err.to_string().contains("ljpeg: category 9 exceeds precision 8"), "got: {}", err);
    }
}
