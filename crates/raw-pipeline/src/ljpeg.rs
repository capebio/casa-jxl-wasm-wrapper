//! Lossless JPEG (SOF3) decoder for DNG tiles.
//!
//! Spec: ITU T.81 Annex H + Adobe DNG. Handles predictor 1 (left), arbitrary
//! component count and precision. No restart markers, no quantisation tables.
//!
//! Output is the raw pixel stream in row-major order, with components
//! interleaved (raw[row * sof_w * cps + ljpeg_col * cps + comp]).

use anyhow::{bail, Result};
use std::cell::RefCell;
use std::sync::Arc;

const MAX_COMPONENTS: usize = 4;

/// One parsed DHT keyed by its exact wire payload (the 16 length counts plus the
/// value bytes). Storing the key as `[u8; 16]` + `Box<[u8]>` lets a cache lookup
/// compare in place — no per-parse key `Vec` is allocated just to probe.
#[derive(Debug)]
struct DhtCacheEntry {
    bits: [u8; 16],
    values: Box<[u8]>,
    table: Arc<HuffTable>,
}

/// One exact-header plan, covering the normal sequential-tile case (every tile of
/// a DNG strip shares one SOF/DHT/SOS header) without re-parsing markers or
/// re-resolving Huffman tables. Thread-local and bounded to a single entry, so it
/// adds no locks and no unbounded WASM/native growth.
#[derive(Debug)]
struct CachedPlan {
    header: Box<[u8]>,
    plan: LjpegPlan,
}

thread_local! {
    static DHT_CACHE: RefCell<Vec<DhtCacheEntry>> = RefCell::new(Vec::new());
    static LAST_PLAN: RefCell<Option<CachedPlan>> = RefCell::new(None);
}

#[derive(Debug)]
struct HuffTable {
    // Canonical decode tables. Each entry packs `consume_bits | (category << 8)`
    // into a u16; entry 0 is the invalid/too-long sentinel (any valid code has
    // consume ≥ 1). `lookup` is indexed by peek(max_bits) for the cold long-code
    // fallback; `fast8` by peek(8) for the hot ≤8-bit path.
    lookup: Vec<u16>, // index = peek(max_bits). 0 if invalid.
    max_bits: u8,
    // Fast 8-bit prefix table: 512 B (was 1 KiB as u32) → better L1 residency on
    // the per-symbol hot path. 0 means the code is longer than 8 bits — fall back
    // to `lookup`.
    fast8: [u16; 256],
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
            // An oversubscribed (malformed) table would drive `code` past
            // `2^code_len`; left unchecked, `code << shift` then indexes past the
            // `1<<max_bits` lookup slice and panics on attacker-controlled bytes.
            // Reject it cleanly instead.
            let limit = 1u32 << code_len;
            for _ in 0..n {
                if code >= limit {
                    bail!("ljpeg: oversubscribed huffman table");
                }
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
        let mut lookup = vec![0u16; table_size];
        let mut fast8 = [0u16; 256];
        for &(code_len, value, code) in &codes {
            // Packed entry shared by both tables: consume | category<<8 (≠ 0).
            let entry = (code_len as u16) | ((value as u16) << 8);
            // Full-width table.
            let shift = max_bits as u32 - code_len as u32;
            let lo = (code << shift) as usize;
            let hi = lo + (1 << shift);
            for slot in &mut lookup[lo..hi] {
                *slot = entry;
            }
            // 8-bit fast table for short codes: map every 8-bit pattern whose
            // top code_len bits match this code. Non-zero sentinel: consume ≥ 1.
            if code_len <= 8 {
                let shift8 = 8u32 - code_len as u32;
                let lo8 = (code << shift8) as usize;
                let hi8 = lo8 + (1usize << shift8);
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
    /// Histogram of decoded Huffman categories (magnitude bit-counts), indexed
    /// by category 0..=16. Drives the fusion-vs-special-case decision: a
    /// distribution concentrated at 0/1/2 favours per-category special paths,
    /// a spread-out one favours fused receive.
    pub category_hist: [u64; 17],
}

struct BitReader<'a, const COLLECT_STATS: bool> {
    src: &'a [u8],
    pos: usize,
    bits: u64,
    nbits: u32,
    finished: bool,
    real_in_buf: u32,
    truncated: bool,
    // Diagnostics — only written when COLLECT_STATS, so the production decode path
    // (decode_tile) carries no refill telemetry stores at all.
    fill_calls: u64,
    bulk_hits: u64,
    slow_hits: u64,
}

impl<'a, const COLLECT_STATS: bool> BitReader<'a, COLLECT_STATS> {
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
        if COLLECT_STATS {
            self.fill_calls += 1;
        }
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
                    if COLLECT_STATS {
                        self.bulk_hits += 1;
                    }
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
            if COLLECT_STATS {
                self.slow_hits += 1;
            }
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

/// Prepared LJPEG decode state: everything resolvable from the bitstream header
/// (geometry, precision, predictor, and per-component Huffman tables) computed
/// **once** by [`LjpegPlan::prepare`], so the per-pixel kernels carry no parsing
/// or table-construction cost. Mirrors the JXL encoder's prepared-state design:
/// parse/plan once, then dispatch to a specialized kernel.
#[derive(Debug, Clone)]
pub struct LjpegPlan {
    /// SOF image width (samples per row, *before* component interleave).
    pub width: usize,
    /// SOF image height (rows).
    pub height: usize,
    /// Component count (1 for CFA RAW; 2–4 for some interleaved layouts).
    pub components: usize,
    /// Sample precision in bits (2..=16).
    pub precision: u8,
    /// SOS point transform (low-bit shift applied to reconstructed samples).
    pub point_transform: u8,
    /// SOS predictor selector (only predictor 1 / left is supported).
    pub predictor: u8,
    /// Resolved Huffman table per scan component (Arc-shared with the DHT cache).
    tables: [Option<Arc<HuffTable>>; MAX_COMPONENTS],
    /// Byte offset in `src` where the entropy-coded segment begins.
    entropy_offset: usize,
}

/// Return a clone of the cached plan iff `src` begins with the exact header
/// bytes it was built from. The plan depends only on those header bytes
/// (geometry/precision/tables); the entropy segment is re-read from the live
/// `src` on every decode, so reusing the plan is byte-exact.
#[inline]
fn cached_plan(src: &[u8]) -> Option<LjpegPlan> {
    LAST_PLAN.with(|slot| {
        let slot = slot.borrow();
        let entry = slot.as_ref()?;
        let header = entry.header.as_ref();
        if src.len() >= header.len() && &src[..header.len()] == header {
            Some(entry.plan.clone())
        } else {
            None
        }
    })
}

/// Record `plan` under its exact header prefix (`src[..entropy_offset]`) for the
/// next same-header tile. Bounded to one entry per thread.
#[inline]
fn cache_plan(src: &[u8], plan: &LjpegPlan) {
    debug_assert!(plan.entropy_offset <= src.len());
    LAST_PLAN.with(|slot| {
        *slot.borrow_mut() = Some(CachedPlan {
            header: src[..plan.entropy_offset].to_vec().into_boxed_slice(),
            plan: plan.clone(),
        });
    });
}

impl LjpegPlan {
    /// Parse SOI..SOS, build/resolve the Huffman tables, and validate the
    /// header. No entropy decoding happens here. The returned plan borrows
    /// nothing from `src` (table data is owned via Arc); only [`entropy`] reads
    /// back into `src`, so the same plan can decode the same bytes repeatedly.
    pub fn prepare(src: &[u8]) -> Result<Self> {
        if src.len() < 4 || src[0] != 0xFF || src[1] != 0xD8 {
            bail!("ljpeg: missing SOI");
        }
        // Fast path: the previous tile's plan, if this tile's header is byte-identical.
        if let Some(plan) = cached_plan(src) {
            return Ok(plan);
        }
        let mut pos = 2usize;

        let mut sof = Sof::default();
        let mut sos = Sos::default();
        let mut dhts: [Option<Arc<HuffTable>>; 4] = [None, None, None, None];
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
                        // L11: thread-local exact-payload cache (WASM-safe). Probe by
                        // comparing the wire payload in place — no key Vec allocated.
                        let cached = DHT_CACHE.with(|c| {
                            c.borrow()
                                .iter()
                                .find(|e| e.bits == bits && e.values.as_ref() == values)
                                .map(|e| e.table.clone())
                        });
                        let tbl = if let Some(t) = cached {
                            t
                        } else {
                            let t = Arc::new(HuffTable::build(&bits, values)?);
                            DHT_CACHE.with(|c| {
                                let mut cache = c.borrow_mut();
                                cache.push(DhtCacheEntry {
                                    bits,
                                    values: values.to_vec().into_boxed_slice(),
                                    table: t.clone(),
                                });
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
                    // Skip unknown segment. `seg_len` is attacker-controlled: guard
                    // the lower bound (>= 2) and the upper bound (advance must stay
                    // within the buffer) with checked arithmetic — on wasm32 a raw
                    // `pos += seg_len - 2` could leave `pos` past `src.len()`.
                    let seg_len = read_u16_be(src, &mut pos)? as usize;
                    if seg_len < 2 { bail!("ljpeg: segment length {} < 2", seg_len); }
                    let next = match pos.checked_add(seg_len - 2) {
                        Some(p) if p <= src.len() => p,
                        _ => bail!("ljpeg: segment length {} runs past buffer", seg_len),
                    };
                    pos = next;
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
        if sof.width == 0 || sof.height == 0 {
            bail!("ljpeg: zero SOF dimension");
        }

        // Resolve the Huffman table for each scan component once, so the kernels
        // index a small Arc array instead of re-looking-up by DHT id per pixel.
        let mut tables: [Option<Arc<HuffTable>>; MAX_COMPONENTS] = Default::default();
        for c in 0..cps {
            let id = sos.dht_id[c] as usize;
            match &dhts[id] {
                Some(t) if t.max_bits > 0 => tables[c] = Some(t.clone()),
                _ => bail!("ljpeg: missing huffman table {}", id),
            }
        }

        let plan = LjpegPlan {
            width: sof.width as usize,
            height: sof.height as usize,
            components: cps,
            precision: sof.precision,
            point_transform: sos.point_transform,
            predictor: sos.predictor,
            tables,
            entropy_offset: pos,
        };
        cache_plan(src, &plan);
        Ok(plan)
    }

    /// The entropy-coded segment of `src` (bytes after the SOS header).
    #[inline]
    fn entropy<'a>(&self, src: &'a [u8]) -> &'a [u8] {
        &src[self.entropy_offset..]
    }
}

/// Validate caller-supplied output geometry against the plan and the real `out`
/// buffer length before any kernel writes. The kernels write
/// `out[base + row*stride_pixels + raw_col]` guarded only by
/// `raw_col < out_pixel_cols`; the max index written is at row=out_rows-1,
/// raw_col=out_pixel_cols-1, so require that to be in-bounds. Skipped when
/// nothing is emitted (no writes occur).
fn geometry_check(
    plan: &LjpegPlan,
    out: &[u16],
    base: usize,
    stride_pixels: usize,
    out_pixel_cols: usize,
    out_rows: usize,
) -> Result<()> {
    let raw_cols = plan.width * plan.components;
    if raw_cols < out_pixel_cols {
        bail!(
            "ljpeg: SOF raw cols {} less than output width {}",
            raw_cols,
            out_pixel_cols
        );
    }
    if plan.height < out_rows {
        bail!(
            "ljpeg: SOF height {} less than output height {}",
            plan.height,
            out_rows
        );
    }
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
    Ok(())
}

/// Run the prepared plan: validate geometry, then dispatch **once** to a
/// specialized kernel. The single-component cases (CFA RAW) route to the
/// monomorphized `decode_c1::<PRECISION>` — fixing `components = 1` and the
/// precision lets the compiler drop the inner component loop, the per-pixel
/// table indirection, and the dynamic category/precision branches. Everything
/// else falls back to the generic kernel.
fn execute<const COLLECT_STATS: bool>(
    plan: &LjpegPlan,
    src: &[u8],
    out: &mut [u16],
    base: usize,
    stride_pixels: usize,
    out_pixel_cols: usize,
    out_rows: usize,
) -> Result<LjpegStats> {
    geometry_check(plan, out, base, stride_pixels, out_pixel_cols, out_rows)?;
    match (plan.components, plan.precision) {
        (1, 12) => decode_c1::<12, COLLECT_STATS>(plan, src, out, base, stride_pixels, out_pixel_cols, out_rows),
        (1, 14) => decode_c1::<14, COLLECT_STATS>(plan, src, out, base, stride_pixels, out_pixel_cols, out_rows),
        (1, 16) => decode_c1::<16, COLLECT_STATS>(plan, src, out, base, stride_pixels, out_pixel_cols, out_rows),
        (2, 12) => decode_c2::<12, COLLECT_STATS>(plan, src, out, base, stride_pixels, out_pixel_cols, out_rows),
        (2, 14) => decode_c2::<14, COLLECT_STATS>(plan, src, out, base, stride_pixels, out_pixel_cols, out_rows),
        (2, 16) => decode_c2::<16, COLLECT_STATS>(plan, src, out, base, stride_pixels, out_pixel_cols, out_rows),
        _ => decode_generic::<COLLECT_STATS>(plan, src, out, base, stride_pixels, out_pixel_cols, out_rows),
    }
}

/// Decode one Huffman category (magnitude bit-count) from `br` using the
/// fast8 prefix table with a full-width fallback, consume its bits, and return
/// the category. Shared verbatim by both kernels so they stay bit-identical.
#[inline(always)]
fn next_category<const COLLECT_STATS: bool>(
    br: &mut BitReader<'_, COLLECT_STATS>,
    table: &HuffTable,
    fast8_hits: &mut u64,
    slow_huffman_hits: &mut u64,
    total_symbols: &mut u64,
    category_hist: &mut [u64; 17],
) -> Result<u8> {
    // Fast 8-bit prefix lookup: resolves codes ≤ 8 bits without a second peek.
    // Falls back to the full-width table only for long codes. Both tables pack
    // consume | category<<8 into a u16; 0 is the invalid/too-long sentinel.
    let peek8 = br.peek(8);
    let fast_entry = table.fast8[peek8 as usize];
    let (consume, t) = if fast_entry != 0 {
        if COLLECT_STATS { *fast8_hits += 1; }
        ((fast_entry & 0xFF) as u8, (fast_entry >> 8) as u8)
    } else {
        if COLLECT_STATS { *slow_huffman_hits += 1; }
        let peek_full = br.peek(table.max_bits as u32);
        let entry = table.lookup[peek_full as usize];
        if entry == 0 {
            bail!("ljpeg: invalid huffman code");
        }
        ((entry & 0xFF) as u8, (entry >> 8) as u8)
    };
    if COLLECT_STATS {
        *total_symbols += 1;
        if (t as usize) < category_hist.len() {
            category_hist[t as usize] += 1;
        }
    }
    br.consume(consume as u32);
    if br.truncated {
        bail!("ljpeg: entropy bitstream exhausted");
    }
    Ok(t)
}

/// Resolve the signed predictor difference for category `t`. `PRECISION` is a
/// const so the category/precision guards fold at compile time. Bit-identical
/// to the original inline diff math; shared by the monomorphized kernels.
#[inline(always)]
fn decode_diff<const PRECISION: u8, const COLLECT_STATS: bool>(
    br: &mut BitReader<'_, COLLECT_STATS>,
    t: u8,
    get_bits_calls: &mut u64,
    get_bits_total_bits: &mut u64,
) -> Result<i32> {
    if t == 16 {
        // JPEG T.81 Annex H: category=precision means diff = -2^(P-1) with no
        // additional bits read. Only valid when precision is exactly 16.
        if PRECISION != 16 {
            bail!("ljpeg: category 16 exceeds precision {}", PRECISION);
        }
        return Ok(-32768i32);
    } else if t > PRECISION {
        bail!("ljpeg: category {} exceeds precision {}", t, PRECISION);
    }
    if t == 0 {
        return Ok(0);
    }
    if COLLECT_STATS {
        *get_bits_calls += 1;
        *get_bits_total_bits += t as u64;
    }
    let bits = br.get_bits(t as u32) as i32;
    if br.truncated {
        bail!("ljpeg: entropy bitstream exhausted");
    }
    Ok(extend(bits, t as u32))
}

/// Monomorphized single-component (CFA RAW) kernel. `PRECISION` is a const so
/// the category/precision guards and `base_pred` fold at compile time; with
/// `components = 1` the output column index is just `col`, the predictor state
/// is two scalars, and there is a single Huffman table — no per-pixel
/// component loop or array indexing. Bit-identical to [`decode_generic`].
#[inline(always)]
fn decode_c1<const PRECISION: u8, const COLLECT_STATS: bool>(
    plan: &LjpegPlan,
    src: &[u8],
    out: &mut [u16],
    base: usize,
    stride_pixels: usize,
    out_pixel_cols: usize,
    out_rows: usize,
) -> Result<LjpegStats> {
    let table = plan.tables[0].as_deref().expect("c1: table[0] resolved in prepare");
    let point_transform = plan.point_transform;
    let base_pred = 1i32 << (PRECISION - point_transform - 1);
    let width = plan.width;
    let height = plan.height;
    let mut br = BitReader::<COLLECT_STATS>::new(plan.entropy(src));

    let mut total_symbols = 0u64;
    let mut fast8_hits = 0u64;
    let mut slow_huffman_hits = 0u64;
    let mut get_bits_calls = 0u64;
    let mut get_bits_total_bits = 0u64;
    let mut category_hist = [0u64; 17];

    // Predictor-1 state: column-0 value of the previous row (scalar).
    let mut prev_row_first = 0i32;

    for row in 0..height {
        let row_base = base + row * stride_pixels;
        let emit_row = row < out_rows;
        let mut left = 0i32;
        for col in 0..width {
            let predictor = if col == 0 {
                if row == 0 { base_pred } else { prev_row_first }
            } else {
                left
            };

            let t = next_category::<COLLECT_STATS>(
                &mut br, table, &mut fast8_hits, &mut slow_huffman_hits, &mut total_symbols,
                &mut category_hist,
            )?;
            let diff = decode_diff::<PRECISION, COLLECT_STATS>(
                &mut br, t, &mut get_bits_calls, &mut get_bits_total_bits,
            )?;

            let val = predictor.wrapping_add(diff);
            left = val;
            if col == 0 {
                prev_row_first = val;
            }

            if emit_row && col < out_pixel_cols {
                // SAFETY: row<out_rows + col<out_pixel_cols ⇒ index ≤ the maximum
                // validated < out.len() by geometry_check before this kernel runs.
                // Same redundant-bounds-check elision as the measured decode_c2.
                unsafe { *out.get_unchecked_mut(row_base + col) = ((val << point_transform) & 0xFFFF) as u16; }
            }
        }
    }

    Ok(LjpegStats {
        sof_w: width as u32,
        sof_h: height as u32,
        cps: 1,
        precision: PRECISION,
        total_symbols,
        fill_calls: br.fill_calls,
        bulk_fill_hits: br.bulk_hits,
        slow_fill_hits: br.slow_hits,
        fast8_hits,
        slow_huffman_hits,
        get_bits_calls,
        get_bits_total_bits,
        category_hist,
    })
}

/// Monomorphized two-component kernel — the dominant real-world CFA RAW layout
/// (Pixel DNG, Canon CR2 lossless JPEG both encode as cps=2). Unrolling the
/// component loop into two independent scalar predictor chains (`left0/left1`,
/// `prev0/prev1`) with two fixed Huffman tables removes the inner `for comp`
/// loop, the per-pixel `comp_tables[comp]` / `left[comp]` array indexing, and
/// (via the const `PRECISION`) the dynamic category guards. Bit-identical to
/// [`decode_generic`] for `components == 2`.
#[inline(always)]
fn decode_c2<const PRECISION: u8, const COLLECT_STATS: bool>(
    plan: &LjpegPlan,
    src: &[u8],
    out: &mut [u16],
    base: usize,
    stride_pixels: usize,
    out_pixel_cols: usize,
    out_rows: usize,
) -> Result<LjpegStats> {
    let table0 = plan.tables[0].as_deref().expect("c2: table[0] resolved in prepare");
    let table1 = plan.tables[1].as_deref().expect("c2: table[1] resolved in prepare");
    let point_transform = plan.point_transform;
    let base_pred = 1i32 << (PRECISION - point_transform - 1);
    let width = plan.width;
    let height = plan.height;
    let mut br = BitReader::<COLLECT_STATS>::new(plan.entropy(src));

    let mut total_symbols = 0u64;
    let mut fast8_hits = 0u64;
    let mut slow_huffman_hits = 0u64;
    let mut get_bits_calls = 0u64;
    let mut get_bits_total_bits = 0u64;
    let mut category_hist = [0u64; 17];

    // Column-0 value of the previous row, per component (scalars).
    let mut prev0 = 0i32;
    let mut prev1 = 0i32;

    for row in 0..height {
        let row_base = base + row * stride_pixels;
        let emit_row = row < out_rows;
        let mut left0 = 0i32;
        let mut left1 = 0i32;
        for col in 0..width {
            let at_col0 = col == 0;
            // --- component 0 ---
            let pred0 = if at_col0 {
                if row == 0 { base_pred } else { prev0 }
            } else {
                left0
            };
            let t0 = next_category::<COLLECT_STATS>(
                &mut br, table0, &mut fast8_hits, &mut slow_huffman_hits, &mut total_symbols,
                &mut category_hist,
            )?;
            let diff0 = decode_diff::<PRECISION, COLLECT_STATS>(
                &mut br, t0, &mut get_bits_calls, &mut get_bits_total_bits,
            )?;
            let val0 = pred0.wrapping_add(diff0);
            left0 = val0;
            if at_col0 { prev0 = val0; }

            // --- component 1 ---
            let pred1 = if at_col0 {
                if row == 0 { base_pred } else { prev1 }
            } else {
                left1
            };
            let t1 = next_category::<COLLECT_STATS>(
                &mut br, table1, &mut fast8_hits, &mut slow_huffman_hits, &mut total_symbols,
                &mut category_hist,
            )?;
            let diff1 = decode_diff::<PRECISION, COLLECT_STATS>(
                &mut br, t1, &mut get_bits_calls, &mut get_bits_total_bits,
            )?;
            let val1 = pred1.wrapping_add(diff1);
            left1 = val1;
            if at_col0 { prev1 = val1; }

            if emit_row {
                let raw_col0 = col * 2;
                if raw_col0 < out_pixel_cols {
                    // SAFETY: row<out_rows + raw_col0<out_pixel_cols ⇒ index ≤ the
                    // maximum validated < out.len() by geometry_check before this
                    // kernel runs. Eliding the redundant bounds check is a measured
                    // ~1.7% on the cps=2 write path.
                    unsafe { *out.get_unchecked_mut(row_base + raw_col0) = ((val0 << point_transform) & 0xFFFF) as u16; }
                }
                let raw_col1 = raw_col0 + 1;
                if raw_col1 < out_pixel_cols {
                    // SAFETY: as above; raw_col1 < out_pixel_cols.
                    unsafe { *out.get_unchecked_mut(row_base + raw_col1) = ((val1 << point_transform) & 0xFFFF) as u16; }
                }
            }
        }
    }

    Ok(LjpegStats {
        sof_w: width as u32,
        sof_h: height as u32,
        cps: 2,
        precision: PRECISION,
        total_symbols,
        fill_calls: br.fill_calls,
        bulk_fill_hits: br.bulk_hits,
        slow_fill_hits: br.slow_hits,
        fast8_hits,
        slow_huffman_hits,
        get_bits_calls,
        get_bits_total_bits,
        category_hist,
    })
}

/// Generic kernel: arbitrary component count and precision. Identical decode
/// math to the original fused implementation; the only structural change is
/// that parsing/table resolution now lives in [`LjpegPlan::prepare`].
fn decode_generic<const COLLECT_STATS: bool>(
    plan: &LjpegPlan,
    src: &[u8],
    out: &mut [u16],
    base: usize,
    stride_pixels: usize,
    out_pixel_cols: usize,
    out_rows: usize,
) -> Result<LjpegStats> {
    let cps = plan.components;
    let sof_w = plan.width;
    let sof_h = plan.height;
    let precision = plan.precision;
    let point_transform = plan.point_transform;
    let base_pred = 1i32 << (precision - point_transform - 1);
    let mut br = BitReader::<COLLECT_STATS>::new(plan.entropy(src));

    // Pre-resolve table refs to a plain `&HuffTable` array — no per-pixel Option
    // tag/unwrap. Slots [cps..] alias table0 and are never indexed (comp < cps).
    let table0 = plan.tables[0]
        .as_deref()
        .expect("generic: table[0] resolved in prepare");
    let mut comp_tables: [&HuffTable; MAX_COMPONENTS] = [table0; MAX_COMPONENTS];
    for c in 1..cps {
        comp_tables[c] = plan.tables[c]
            .as_deref()
            .expect("generic: table resolved in prepare");
    }

    // Per-component column-0 value of the previous row (stack, no heap alloc).
    let mut prev_row_first = [0i32; MAX_COMPONENTS];

    let mut total_symbols = 0u64;
    let mut fast8_hits = 0u64;
    let mut slow_huffman_hits = 0u64;
    let mut get_bits_calls = 0u64;
    let mut get_bits_total_bits = 0u64;
    let mut category_hist = [0u64; 17];

    for row in 0..sof_h {
        let row_base = base + row * stride_pixels;
        let emit_row = row < out_rows;
        let mut left = [0i32; MAX_COMPONENTS];
        for col in 0..sof_w {
            let first_col = col == 0;
            // One multiply per source column; the per-component index is just +1.
            let mut raw_col = col * cps;
            for comp in 0..cps {
                let predictor = if first_col {
                    if row == 0 { base_pred } else { prev_row_first[comp] }
                } else {
                    left[comp]
                };

                let table = comp_tables[comp];

                let t = next_category::<COLLECT_STATS>(
                    &mut br, table, &mut fast8_hits, &mut slow_huffman_hits, &mut total_symbols,
                    &mut category_hist,
                )?;

                if t == 16 {
                    if precision != 16 {
                        bail!("ljpeg: category 16 exceeds precision {}", precision);
                    }
                } else if t > precision {
                    bail!("ljpeg: category {} exceeds precision {}", t, precision);
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
                        bail!("ljpeg: entropy bitstream exhausted");
                    }
                    extend(bits, t as u32)
                };

                let val = predictor.wrapping_add(diff);
                left[comp] = val;
                if first_col {
                    prev_row_first[comp] = val;
                }

                if emit_row && raw_col < out_pixel_cols {
                    // SAFETY: row<out_rows + raw_col<out_pixel_cols ⇒ index ≤ the
                    // max validated < out.len() by geometry_check before this kernel
                    // runs. Same validated unchecked-store model as decode_c1/c2.
                    unsafe {
                        *out.get_unchecked_mut(row_base + raw_col) =
                            ((val << point_transform) & 0xFFFF) as u16;
                    }
                }
                raw_col += 1;
            }
        }
    }

    Ok(LjpegStats {
        sof_w: sof_w as u32,
        sof_h: sof_h as u32,
        cps: cps as u8,
        precision,
        total_symbols,
        fill_calls: br.fill_calls,
        bulk_fill_hits: br.bulk_hits,
        slow_fill_hits: br.slow_hits,
        fast8_hits,
        slow_huffman_hits,
        get_bits_calls,
        get_bits_total_bits,
        category_hist,
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
    let plan = LjpegPlan::prepare(src)?;
    execute::<false>(&plan, src, out, base, stride_pixels, out_pixel_cols, out_rows)?;
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
    let plan = LjpegPlan::prepare(src)?;
    execute::<true>(&plan, src, out, base, stride_pixels, out_pixel_cols, out_rows)
}

/// Force the generic kernel regardless of component count / precision. Exists
/// for A/B parity benchmarking (`decode_c1` vs `decode_generic`) and for tests
/// that assert the specialized and generic paths are bit-identical.
#[doc(hidden)]
pub fn decode_tile_generic(
    src: &[u8],
    out: &mut [u16],
    base: usize,
    stride_pixels: usize,
    out_pixel_cols: usize,
    out_rows: usize,
) -> Result<()> {
    let plan = LjpegPlan::prepare(src)?;
    geometry_check(&plan, out, base, stride_pixels, out_pixel_cols, out_rows)?;
    decode_generic::<false>(&plan, src, out, base, stride_pixels, out_pixel_cols, out_rows)?;
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
                // Skip unknown segment. `seg_len` is attacker-controlled: guard
                // the lower bound (>= 2) and the upper bound (advance must stay
                // within the buffer) with checked arithmetic — on wasm32 a raw
                // `pos += seg_len - 2` could leave `pos` past `src.len()`.
                let seg_len = read_u16_be(src, &mut pos)? as usize;
                if seg_len < 2 { bail!("ljpeg: segment length {} < 2", seg_len); }
                let next = match pos.checked_add(seg_len - 2) {
                    Some(p) if p <= src.len() => p,
                    _ => bail!("ljpeg: segment length {} runs past buffer", seg_len),
                };
                pos = next;
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

    // Precision-14, cps=1 variant of the minimal stream: identical Huffman +
    // entropy, only the SOF precision byte changes 0x08 -> 0x0E. The diff
    // sequence is precision-independent ([-28,+1,+2,+1]); with base_pred =
    // 1<<(14-0-1) = 8192 the reconstructed pixels are [8164,8165,8166,8167].
    // This routes through the monomorphized decode_c1::<14> kernel.
    fn make_minimal_sof3_p14() -> Vec<u8> {
        let mut src = make_minimal_sof3();
        // SOF precision byte: SOI(2) + FFC3(2) + seglen(2) = offset 6.
        assert_eq!(src[6], 0x08, "expected prec byte at offset 6");
        src[6] = 0x0E; // 14-bit
        src
    }

    #[test]
    fn l16_decode_c1_matches_generic_and_known_p14() {
        let src = make_minimal_sof3_p14();
        // Dispatched path (cps=1, precision=14 -> decode_c1::<14>).
        let mut out_c1 = vec![0u16; 4];
        decode_tile(&src, &mut out_c1, 0, 2, 2, 2).expect("c1 decode ok");
        assert_eq!(&out_c1[..], &[8164u16, 8165, 8166, 8167], "decode_c1 known output");
        // Generic path on the same input must be byte-identical.
        let mut out_gen = vec![0u16; 4];
        decode_tile_generic(&src, &mut out_gen, 0, 2, 2, 2).expect("generic decode ok");
        assert_eq!(out_c1, out_gen, "decode_c1 must match decode_generic byte-for-byte");
    }

    // Minimal 1x1, cps=2, precision=14 stream → routes through decode_c2::<14>.
    // Shared DHT (codes 000=t0,001=t1,010=t2,011=t5). Entropy 0x32 = 0011_0010:
    //   comp0: 001 (t1) + bit 1 -> diff +1 -> 8192+1 = 8193
    //   comp1: 001 (t1) + bit 0 -> diff -1 -> 8192-1 = 8191
    fn make_minimal_cps2_p14() -> Vec<u8> {
        vec![
            0xFF, 0xD8,
            // SOF3: len=0x0E, prec=14, h=1, w=1, cps=2, comp0(id1), comp1(id2)
            0xFF, 0xC3, 0x00, 0x0E,
            0x0E, 0x00, 0x01, 0x00, 0x01, 0x02,
            0x01, 0x11, 0x00,
            0x02, 0x11, 0x00,
            // DHT id0: 4 codes at len3, values [0,1,2,5]
            0xFF, 0xC4, 0x00, 0x17,
            0x00,
            0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,
            0,1,2,5,
            // SOS: ns=2, comp0(cs1 td0), comp1(cs2 td0), pred=1, se=0, ahal=0
            0xFF, 0xDA, 0x00, 0x0A,
            0x02, 0x01, 0x00, 0x02, 0x00,
            0x01, 0x00, 0x00,
            // entropy + pad
            0x32, 0x00,
        ]
    }

    #[test]
    fn l17_decode_c2_matches_generic_and_known_p14() {
        let src = make_minimal_cps2_p14();
        // Dispatched path (cps=2, precision=14 -> decode_c2::<14>).
        let mut out_c2 = vec![0u16; 2];
        decode_tile(&src, &mut out_c2, 0, 2, 2, 1).expect("c2 decode ok");
        assert_eq!(&out_c2[..], &[8193u16, 8191], "decode_c2 known output");
        // Generic path on the same input must be byte-identical.
        let mut out_gen = vec![0u16; 2];
        decode_tile_generic(&src, &mut out_gen, 0, 2, 2, 1).expect("generic decode ok");
        assert_eq!(out_c2, out_gen, "decode_c2 must match decode_generic byte-for-byte");
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
    fn ljpeg_rejects_oversubscribed_huffman_table() {
        // 2 codes at len1 use up both 1-bit prefixes (0,1); the next length then
        // has no room, so `code` outruns its width. Must bail, not panic on a
        // slice index past the 1<<max_bits lookup table.
        let bits = [2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let values = [0u8; 5];
        let err = HuffTable::build(&bits, &values).unwrap_err();
        assert!(
            err.to_string().contains("oversubscribed huffman table"),
            "got: {}",
            err
        );
    }

    #[test]
    fn ljpeg_plan_cache_reuses_identical_header() {
        // Reset both thread-local caches so the assertion isolates the plan cache.
        LAST_PLAN.with(|slot| *slot.borrow_mut() = None);
        DHT_CACHE.with(|cache| cache.borrow_mut().clear());

        let src = make_minimal_sof3();
        let first = LjpegPlan::prepare(&src).expect("first plan");

        // Clear the DHT cache so a *full* re-parse would build a fresh HuffTable
        // (distinct Arc). A matching Arc therefore proves the plan cache fired.
        DHT_CACHE.with(|cache| cache.borrow_mut().clear());
        let second = LjpegPlan::prepare(&src).expect("cached plan");

        assert!(
            std::sync::Arc::ptr_eq(
                first.tables[0].as_ref().unwrap(),
                second.tables[0].as_ref().unwrap(),
            ),
            "plan cache should return the same Arc-shared tables for an identical header"
        );
    }

    #[test]
    fn ljpeg_stats_path_still_collects_counters() {
        // The const-generic BitReader must keep emitting full telemetry on the
        // stats path even though decode_tile carries none.
        let src = make_minimal_sof3();
        let mut out = vec![0u16; 4];
        let stats = decode_tile_stats(&src, &mut out, 0, 2, 2, 2).expect("stats decode");

        assert_eq!(&out[..], &[100u16, 101, 102, 103]);
        assert_eq!(stats.total_symbols, 4);
        assert_eq!(stats.fast8_hits, 4);
        assert_eq!(stats.slow_huffman_hits, 0);
        assert_eq!(stats.get_bits_calls, 4);
        assert_eq!(stats.get_bits_total_bits, 9);
        assert!(stats.fill_calls > 0, "fill_calls must still be counted on the stats path");
        assert_eq!(stats.category_hist[1], 2);
        assert_eq!(stats.category_hist[2], 1);
        assert_eq!(stats.category_hist[5], 1);
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
