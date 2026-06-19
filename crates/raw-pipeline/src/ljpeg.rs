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
    // Fast 8-bit prefix table: index = peek(8), value = consume_bits | (category << 8).
    // 0 means code is longer than 8 bits — fall back to full lookup.
    fast8: [u32; 256],
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
        let mut fast8 = [0u32; 256];
        for &(code_len, value, code) in &codes {
            // Full-width table.
            let shift = max_bits as u32 - code_len as u32;
            let lo = (code << shift) as usize;
            let hi = lo + (1 << shift);
            for slot in &mut lookup[lo..hi] {
                *slot = (code_len, value);
            }
            // 8-bit fast table for short codes: map every 8-bit pattern whose
            // top code_len bits match this code → encode (consume|category<<8).
            // Non-zero sentinel: consume ≥ 1 for any valid code.
            if code_len <= 8 {
                let shift8 = 8u32 - code_len as u32;
                let lo8 = (code << shift8) as usize;
                let hi8 = lo8 + (1usize << shift8);
                let entry = (code_len as u32) | ((value as u32) << 8);
                for slot in &mut fast8[lo8..hi8] {
                    *slot = entry;
                }
            }
        }
        Ok(HuffTable { lookup, max_bits, fast8 })
    }

}

/// Per-decode statistics for profiling the entropy decode stages.
#[derive(Debug, Default, Clone)]
pub struct LjpegStats {
    /// LJPEG internal dimensions and parameters.
    pub sof_w: u32,
    pub sof_h: u32,
    pub cps: u8,
    pub precision: u8,
    /// Total Huffman symbols decoded (= sof_w × sof_h × cps).
    pub total_symbols: u64,
    /// How many times BitReader::fill() was called.
    pub fill_calls: u64,
    /// How many 4-byte bulk loads succeeded in fill() (no FF in 4 bytes).
    pub bulk_fill_hits: u64,
    /// How many 1-byte slow-path loads in fill() (FF or near-end).
    pub slow_fill_hits: u64,
    /// Symbols resolved by the fast8 table (code length ≤ 8 bits).
    pub fast8_hits: u64,
    /// Symbols that fell through to the full-width lookup (code length > 8 bits).
    pub slow_huffman_hits: u64,
    /// Calls to get_bits() for magnitude receive (L3); excludes t=0 and t=16 cases.
    pub get_bits_calls: u64,
    /// Total magnitude bits read via get_bits().
    pub get_bits_total_bits: u64,
}

struct BitReader<'a> {
    src: &'a [u8],
    pos: usize,
    bits: u64,
    nbits: u32,
    finished: bool,
    real_in_buf: u32,
    truncated: bool,
    // Diagnostics — always tracked, near-zero overhead (fill called rarely).
    fill_calls: u64,
    bulk_hits: u64,
    slow_hits: u64,
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
            fill_calls: 0,
            bulk_hits: 0,
            slow_hits: 0,
        }
    }

    #[inline]
    fn fill(&mut self) {
        self.fill_calls += 1;
        while self.nbits <= 48 && !self.finished {
            let remaining = self.src.len().saturating_sub(self.pos);
            // Fast bulk path: load 4 non-FF bytes as one 32-bit word.
            // Guard: nbits + 32 ≤ 64 when nbits ≤ 32 — no u64 overflow.
            // FF is rare in typical RAW entropy data (1/256 per byte).
            if remaining >= 4 && self.nbits <= 32 {
                let b0 = self.src[self.pos];
                let b1 = self.src[self.pos + 1];
                let b2 = self.src[self.pos + 2];
                let b3 = self.src[self.pos + 3];
                if b0 != 0xFF && b1 != 0xFF && b2 != 0xFF && b3 != 0xFF {
                    let word = ((b0 as u64) << 24)
                        | ((b1 as u64) << 16)
                        | ((b2 as u64) << 8)
                        | (b3 as u64);
                    self.bits = (self.bits << 32) | word;
                    self.nbits += 32;
                    self.real_in_buf += 32;
                    self.pos += 4;
                    self.bulk_hits += 1;
                    continue;
                }
            }
            // Slow path: single byte with FF/stuffing handling.
            if self.pos >= self.src.len() {
                self.finished = true;
                break;
            }
            let b = self.src[self.pos];
            self.pos += 1;
            self.slow_hits += 1;
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
/// Shared LJPEG decode implementation. `COLLECT_STATS=false` compiles away all
/// counter increments at monomorphisation time (dead-code eliminated in release).
#[inline(always)]
fn decode_tile_impl<const COLLECT_STATS: bool>(
    src: &[u8],
    out: &mut [u16],
    base: usize,
    stride_pixels: usize,
    out_pixel_cols: usize,
    out_rows: usize,
) -> Result<LjpegStats> {
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
                // ERR-007: pos + (seg_len - 2) can overflow on wasm32.
                let end = pos.saturating_add(seg_len - 2).min(src.len());
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
                    // SEC-010: pos + total can overflow usize on wasm32 for
                    // file-controlled pos/total values.
                    let val_end = pos.checked_add(total)
                        .filter(|&e| e <= src.len())
                        .ok_or_else(|| anyhow::anyhow!("ljpeg: DHT values EOF"))?;
                    let values = &src[pos..val_end];
                    pos = val_end;
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

    // Validate the caller-supplied output geometry against the real buffer
    // length before any write. The hot loop writes out[base + row*stride_pixels
    // + raw_col] guarded only by raw_col < out_pixel_cols; row_base bounds were
    // never checked, so a too-small `out` or a stride_pixels that doesn't match
    // the real buffer width would index OOB (panic / silent corruption). The
    // max index written is at row=out_rows-1, raw_col=out_pixel_cols-1; require
    // it to be in-bounds. Skipped when nothing is emitted (no writes occur).
    if out_rows > 0 && out_pixel_cols > 0 {
        let max_idx = base
            .checked_add((out_rows - 1).checked_mul(stride_pixels).unwrap_or(usize::MAX))
            .and_then(|v| v.checked_add(out_pixel_cols - 1))
            .unwrap_or(usize::MAX);
        if max_idx >= out.len() {
            bail!(
                "ljpeg: output buffer too small: max write index {} >= out.len() {} \
                 (base={}, stride_pixels={}, out_pixel_cols={}, out_rows={})",
                max_idx,
                out.len(),
                base,
                stride_pixels,
                out_pixel_cols,
                out_rows
            );
        }
    }

    let base_pred = 1i32 << (sof.precision - sos.point_transform - 1);
    let mut br = BitReader::new(&src[pos..]);

    // Pre-resolve Huffman table for each component — avoids Rc deref + Option
    // check inside the hot per-pixel loop.
    let mut comp_tables: [Option<&HuffTable>; MAX_COMPONENTS] = [None; MAX_COMPONENTS];
    for c in 0..cps {
        let id = sos.dht_id[c] as usize;
        let tbl: &HuffTable = match dhts[id].as_deref() {
            Some(t) if t.max_bits > 0 => t,
            _ => bail!("ljpeg: missing huffman table {}", id),
        };
        comp_tables[c] = Some(tbl);
    }

    // Per-component previous values: prev_row[comp][col] of previous row.
    // We keep only the current row's column-0 values plus the running
    // left-neighbour during decode.
    let mut prev_row_first = vec![0i32; cps];

    // Stat counters — zero-cost when COLLECT_STATS=false (dead-code eliminated
    // at monomorphisation time by the compiler in release mode).
    let mut total_symbols = 0u64;
    let mut fast8_hits = 0u64;
    let mut slow_huffman_hits = 0u64;
    let mut get_bits_calls = 0u64;
    let mut get_bits_total_bits = 0u64;

    for row in 0..sof_h {
        let row_base = base + row * stride_pixels;
        let emit_row = row < out_rows;
        // Track left predictor per component (for current row).
        let mut left = [0i32; MAX_COMPONENTS];
        for col in 0..sof_w {
            for comp in 0..cps {
                let predictor = if col == 0 {
                    if row == 0 { base_pred } else { prev_row_first[comp] }
                } else {
                    left[comp]
                };

                // SAFETY: comp < cps, all slots set above.
                let table = comp_tables[comp].unwrap();

                // Fast 8-bit prefix lookup: resolves codes ≤ 8 bits without a
                // second peek. Falls back to full-width table only for long codes.
                let peek8 = br.peek(8);
                let fast_entry = table.fast8[peek8 as usize];
                let (consume, t) = if fast_entry != 0 {
                    if COLLECT_STATS { fast8_hits += 1; }
                    ((fast_entry & 0xFF) as u8, ((fast_entry >> 8) & 0xFF) as u8)
                } else {
                    if COLLECT_STATS { slow_huffman_hits += 1; }
                    let peek_full = br.peek(table.max_bits as u32);
                    let entry = table.lookup[peek_full as usize];
                    if entry.0 == 0 {
                        bail!("ljpeg: invalid huffman code at row={row} col={col} comp={comp}");
                    }
                    entry
                };
                if COLLECT_STATS { total_symbols += 1; }
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
                    if COLLECT_STATS {
                        get_bits_calls += 1;
                        get_bits_total_bits += t as u64;
                    }
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

                if emit_row {
                    let raw_col = col * cps + comp;
                    if raw_col < out_pixel_cols {
                        out[row_base + raw_col] = ((val << sos.point_transform) & 0xFFFF) as u16;
                    }
                }
            }
        }
    }

    Ok(LjpegStats {
        sof_w: sof.width,
        sof_h: sof.height,
        cps: sof.cps,
        precision: sof.precision,
        total_symbols,
        fill_calls: br.fill_calls,
        bulk_fill_hits: br.bulk_hits,
        slow_fill_hits: br.slow_hits,
        fast8_hits,
        slow_huffman_hits,
        get_bits_calls,
        get_bits_total_bits,
    })
}

pub fn decode_tile(
    src: &[u8],
    out: &mut [u16],
    base: usize,
    stride_pixels: usize,
    out_pixel_cols: usize,
    out_rows: usize,
) -> Result<()> {
    decode_tile_impl::<false>(src, out, base, stride_pixels, out_pixel_cols, out_rows)?;
    Ok(())
}

/// Decode one LJPEG tile and return per-stage statistics for profiling.
/// Identical decode path as `decode_tile` plus lightweight counters.
pub fn decode_tile_stats(
    src: &[u8],
    out: &mut [u16],
    base: usize,
    stride_pixels: usize,
    out_pixel_cols: usize,
    out_rows: usize,
) -> Result<LjpegStats> {
    decode_tile_impl::<true>(src, out, base, stride_pixels, out_pixel_cols, out_rows)
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
    fn ljpeg_fast8_resolves_short_codes() {
        // 4 codes at length 3 (canonical: 000→t0, 001→t1, 010→t2, 011→t5).
        // max_bits=3; codes only cover 3-bit prefixes 000–011 → fast8[0..128] filled.
        // 3-bit prefixes 100–111 have no code → fast8[128..256] stays 0 (slow path).
        let bits = [0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0];
        let values = [0u8, 1, 2, 5];
        let tbl = HuffTable::build(&bits, &values).unwrap();
        // fast8[000_xxxxx] (indices 0..32): consume=3, category=0
        assert_eq!(tbl.fast8[0] & 0xFF, 3, "consume for t=0");
        assert_eq!((tbl.fast8[0] >> 8) & 0xFF, 0, "category for first code");
        assert_eq!(tbl.fast8[31] & 0xFF, 3);
        // fast8[011_xxxxx] (indices 96..128): consume=3, category=5
        assert_eq!(tbl.fast8[96] & 0xFF, 3, "consume for t=5");
        assert_eq!((tbl.fast8[96] >> 8) & 0xFF, 5, "category for last code");
        // fast8[128..256]: no code → 0 (slow path will bail with invalid code)
        assert!(tbl.fast8[128..].iter().all(|&e| e == 0), "uncovered prefixes must be 0");
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

    // LJPEG-001: property-based tests for extend() edge cases.
    #[test]
    fn extend_t0_always_zero() {
        // t=0 must always return 0 regardless of diff.
        for diff in [-32768i32, -1, 0, 1, 32767] {
            assert_eq!(extend(diff, 0), 0, "extend({diff}, 0) should be 0");
        }
    }

    #[test]
    fn extend_t16_passthrough() {
        // t=16: half = 1<<15 = 32768. All 16-bit diffs are >= 0 and diff < 32768
        // triggers negative extension. diff >= 32768 passes through.
        let half = 1i32 << 15;
        // diff below half → negative extension
        assert_eq!(extend(half - 1, 16), (half - 1) - ((1i32 << 16) - 1));
        // diff at or above half → positive (passthrough)
        assert_eq!(extend(half, 16), half);
        assert_eq!(extend(65535, 16), 65535);
    }

    #[test]
    fn extend_negative_values() {
        // For t=1: half=1. diff=0 < half → negative: 0 - 1 = -1.
        assert_eq!(extend(0, 1), -1);
        // diff=1 >= half → positive passthrough.
        assert_eq!(extend(1, 1), 1);
    }

    #[test]
    fn extend_t8_range() {
        // t=8: half=128. diff=127 → 127 - 255 = -128. diff=128 → 128 (passthrough).
        assert_eq!(extend(127, 8), 127 - 255);
        assert_eq!(extend(128, 8), 128);
        assert_eq!(extend(255, 8), 255);
    }
}
