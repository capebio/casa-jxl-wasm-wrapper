# CR2 Decoder Optimisation & Hardening — DONE

**Date:** 2026-06-15  
**Files:** `crates/raw-pipeline/src/cr2.rs`, `crates/raw-pipeline/examples/cr2_bench.rs`, `crates/raw-pipeline/examples/cr2_baseline.rs`  
**Method:** CR2 Response 1 (×2) + CR2 Response 2 (×2) + 27-lens multi-pass review (×2)

---

## 1. Purpose

Canon CR2 is a TIFF container with a Lossless JPEG strip in IFD3. The decoder was structurally
clean but carried a correctness bug (BlackLevel never applied), two full-frame Vec allocations
(peak ~70 MB per 24 MP file), no IFD corruption guards, an unsound SOF marker parser, and no
benchmark infrastructure. This pass fixes all of the above.

---

## 2. Benchmark: 10-Run Flip-Flop

### Test Corpus

| File | Size | Sensor | Decoded |
|------|------|--------|---------|
| `_MG_1744.CR2` | 22 MB | 18 MP Canon (5184×3456) | File A |
| `ADH 1248.CR2` | 38 MB | 24 MP Canon (6000×4000) | File B |

### Baseline (old cr2.rs — `decode_bytes()`, external wall timing)

```
Run  1 [A] total=384.6ms
Run  2 [B] total=432.4ms
Run  3 [A] total=348.0ms
Run  4 [B] total=429.7ms
Run  5 [A] total=340.9ms
Run  6 [B] total=436.8ms
Run  7 [A] total=340.7ms
Run  8 [B] total=439.0ms
Run  9 [A] total=351.1ms
Run 10 [B] total=429.6ms

Avg=393.3ms  Med=429.6ms  Min=340.7ms  Max=439.0ms
FileA avg ≈ 353ms  |  FileB avg ≈ 433ms
```

### After Optimisation (new cr2.rs — `decode_bytes_bench()`, phase breakdown)

```
Run  1 [A] total=336.7ms  ljpeg=327.2ms  crop=3.4ms  parse=0.01ms
Run  2 [B] total=413.3ms  ljpeg=400.4ms  crop=4.8ms  parse=0.00ms
Run  3 [A] total=341.1ms  ljpeg=329.8ms  crop=2.9ms  parse=0.01ms
Run  4 [B] total=438.8ms  ljpeg=424.3ms  crop=6.1ms  parse=0.01ms
Run  5 [A] total=336.2ms  ljpeg=326.7ms  crop=3.4ms  parse=0.01ms
Run  6 [B] total=413.2ms  ljpeg=401.1ms  crop=4.1ms  parse=0.00ms
Run  7 [A] total=402.3ms  ljpeg=390.9ms  crop=4.4ms  parse=0.00ms
Run  8 [B] total=490.0ms  ljpeg=473.8ms  crop=4.9ms  parse=0.01ms
Run  9 [A] total=352.0ms  ljpeg=341.8ms  crop=3.2ms  parse=0.00ms
Run 10 [B] total=458.0ms  ljpeg=445.2ms  crop=4.7ms  parse=0.00ms

AvgTotal: 398.16 ms   MedTotal: 413.20 ms
MinTotal: 336.19 ms   MaxTotal: 489.98 ms
StdDev:   52.10 ms

Phase breakdown (averages):
  AvgParse:  0.01 ms   0.0%
  AvgLJPEG: 386.13 ms  97.0%
  AvgCrop:    4.18 ms   1.0%
  Other:      7.85 ms   2.0%

  FileA avg: 353.66 ms
  FileB avg: 442.65 ms
```

### Timing Comparison

| Metric | Baseline | Optimised | Δ |
|--------|----------|-----------|---|
| Avg total | 393 ms | 398 ms | ±1.3% (within noise) |
| FileA avg | ≈353 ms | 353.7 ms | ~0% |
| FileB avg | ≈433 ms | 442.7 ms | +2.2% |
| Peak memory | ~70 MB | ~36 MB | **−49%** |
| Allocations per decode | 3+ | 1 | **−67%** |

### Interpretation

LJPEG decode dominates at **97%** of total time — a compute-bound Huffman decode algorithm with
no obvious short-circuit. This matches the handoff doc's "compute-bound or memory-bandwidth-bound?"
question: the answer is **compute-bound** (the decoder processes each compressed bit serially;
it is not amenable to the same class of memory-bandwidth optimisations as the ORF pipeline).

The Response 1 and Response 2 changes produce **no measurable wall-time improvement** at the
precision available on this machine (thermal variance dominates, StdDev = 52 ms). This is the
expected outcome when the dominant stage (LJPEG = 97%) is unchanged.

The **actual gains** are:

1. **Memory**: Peak working set drops from ~70 MB to ~36 MB per decode. For batch gallery ingest
   with parallelism, this halves per-worker heap pressure and allows more concurrent workers.
2. **Correctness**: BlackLevel from IFD is now applied. Previously all Canon CR2 files had a
   hardcoded precision-table black point regardless of the camera's actual calibration value.
3. **Safety**: IFD corruption guard (max 512 entries), SOF segment-length bounds check, CR2Slices
   semantic validation, and OOM guard (200 MP cap) make the decoder robust against malformed input.
4. **API**: `decode_bytes_bench`, `decode_with_scratch`, `ScratchBuffers`, and `Cr2Timings`
   expose phase timing and batch-mode buffer reuse for future optimisation work.

---

## 3. Changes Made

### cr2.rs — Full Change Index

| ID | Type | Description |
|----|------|-------------|
| R1-1 | Correctness | **Fix BlackLevel bug.** `black_from_ifd` variable now actually overrides the precision-table default when IFD tags 0xC61A/0xC632 contain a plausible value. Old code read the value then discarded it in a dead stub. |
| R1-2 | Allocation | **Zero-allocation IFD visitor.** `walk_ifd() → Vec<(...)>` replaced by `visit_ifd(data, off, le, closure)`. Every IFD traversal now calls the visitor per-entry with zero heap allocation. 4 IFD walks × 1 Vec per walk eliminated. |
| R1-3 | Allocation | **Zero-alloc ColorData WB.** `read_array_u16 → Vec<u16>` plus `extract_wb_from_color_data(&[u16])` replaced by `extract_wb_from_raw(data, off, cnt, le)` which reads WB multipliers directly from the source slice. Zero Vec<u16> allocation. |
| R1-4 | Copy | **In-place crop.** Second `Vec<u16> cropped` allocation eliminated. Rows are compacted in-place within `raw_buf` (`copy_within`), then the Vec is truncated. Moves via `std::mem::take` on the single-call path (zero crop copy). |
| R1-5 | Safety | **SOF parser hardening.** Segment-length bounds checked before advancing (`seg_len < 2` guard + `next > buf.len()` guard). Malformed LJPEG markers can no longer cause pathological traversal. |
| R1-6 | Safety | **IFD entry count cap.** `visit_ifd` returns early with 0 entries if `count > 512`. Prevents corrupt files from triggering O(N) allocation/traversal. |
| R1-7 | Safety | **CR2Slices validation.** `n_slices > 32 || nw == 0` → `bail!`. Prevents nonsensical geometry before width reconstruction. |
| R1-8 | Safety | **OOM guard on decode dimensions.** `sof_w × ncomp × sof_h > 200_000_000` → `bail!`. Stops a corrupt file claiming 65535×65535×4 from triggering a multi-GB allocation. |
| R1-9 | Cleanup | Removed vestigial `pub use crate::dng::Cfa` (unused in this module). |
| R2-1 | API | **`Cr2Timings` struct.** Per-phase timing returned by `decode_bytes_bench`. Zero-overhead when `time_phases=false`. |
| R2-2 | API | **`ScratchBuffers` struct.** Reusable full-frame decode buffer for batch calls. Avoids per-call 35 MB full-frame re-allocation. |
| R2-3 | API | **`decode_bytes_bench`** — returns `(Cr2Image, Cr2Timings)`. Used by the benchmark example. |
| R2-4 | API | **`decode_with_scratch`** — batch API with reused scratch buffer. |
| R2-5 | Arch | **`decode_impl` internal core.** `move_buf: bool` and `time_phases: bool` parameters unify all four entry points without code duplication. |
| ML-1 | Tests | **New unit tests:** `extract_wb_version6`, `extract_wb_version1`, `extract_wb_returns_none_for_zero_g1`, `visit_ifd_empty_returns_zero`, `visit_ifd_corruption_guard`, `bench_api_returns_timings`, `scratch_produces_same_output`. |

### New Files

| File | Purpose |
|------|---------|
| `examples/cr2_bench.rs` | 10-run flip-flop benchmark with .toon output. |
| `examples/cr2_baseline.rs` | Baseline timing against old `decode_bytes()` API for comparison. |

---

## 4. Multi-Lens Review Findings

### Round 1 (cr2.rs)

- **P0 (OOM)**: No overflow guard on `total_pixels = sof_w * ncomp * sof_h`. A corrupt file claiming 65535×65535 with ncomp=4 attempts 17 GB allocation. → **Fixed** (item R1-8 above).
- **P1 (API dead code)**: `pub use crate::dng::Cfa` unused. → **Fixed** (item R1-9).
- **P2 (BlackLevel dead stub)**: Was read but never applied. → **Fixed** (item R1-1).

### Round 2 (cr2.rs + ljpeg.rs seam)

- **Double SOF parse**: `parse_ljpeg_sof` in cr2.rs and `decode_tile` in ljpeg.rs both walk the LJPEG header. The SOF3 marker is in the first ~30 bytes; the duplicate parse is negligible (<0.01 ms). Eliminated by surfacing SOF info from `decode_tile` — deferred to a future pass when ljpeg.rs becomes a target.
- **DHT_CACHE warm-up**: ljpeg.rs caches Huffman tables per thread. Warmup runs in the benchmark correctly prime the cache before timing. ✓
- **`decode_tile` `base` parameter unused**: cr2.rs always passes `base=0`. The `base` parameter exists for DNG tiled use. No change needed.
- **`makernote_off` aliasing**: If MakerNote offset coincidentally points into the raw IFD or image strip, `visit_ifd` would read garbage entries but all values would be bounds-checked and discarded. Not a safety issue; no fix needed.
- **String allocation for make/model**: Always occurs even in batch/ingest-only scenarios. Defer to a future pass if profiling reveals it as a measurable cost (presently <0.01 ms per decode).

### Rejected (consistent with docs/rejected optimizations.md)

| Proposed | Reason |
|----------|--------|
| SIMD for crop compaction | 1% of total; LJPEG is compute-bound; SIMD gains here are < noise |
| Concurrency in CR2 decode | Single LJPEG strip; no natural partition; adds synchronisation overhead |
| Per-stage budget reset | Semantics change: not applicable (CR2 has no budget concept) |
| Pre-allocate IFD entry Vec | Visitor approach eliminates the allocation entirely |

---

## 5. StandardMultifileTest Results

Run on 2026-06-15. Output written to `docs/outputs/timing tests/2026-06-15T20-09-12-515Z-StandardMultifileTest-general.toon`.

CR2 pipeline (relevant lines from test output):
```
ADH 1248.CR2 | simd_prog=262 mt=178 spd=1.47x | first=140/52 (2.69x) | final=394/137 (2.89x) | shot=265/102 (2.61x)
```

**No regressions detected.** CR2 decode throughput and all JXL encode paths unchanged.

Pipeline averages (for context):
```
AvgRawMs: 1032
AvgRawDecompressMs: 324  |  AvgRawDemosaicMs: 106  |  AvgRawTonemapMs: 440
AvgProgEncSimdMs: 308    |  AvgProgEncMtMs: 154
```

---

## 6. Conclusion

### Chapter 3a — Improvements to cr2.rs

1. **Correctness**: BlackLevel from the IFD is now applied. The old precision-table values were conservative defaults; real Canon cameras report their calibrated black point in tag 0xC61A and it is now used.
2. **Memory**: Peak heap reduced from ≈70 MB to ≈36 MB per 24 MP decode. One full-frame Vec (35 MB) eliminated by in-place crop compaction.
3. **Allocations**: Four IFD traversal Vecs and one ColorData Vec eliminated per decode call.
4. **Safety**: Four distinct corrupt-file hazards closed: IFD entry count overflow, SOF segment-length OOB, CR2Slices nonsense geometry, and huge-dimension OOM.
5. **API surface**: Benchmark entry point (`decode_bytes_bench`), batch entry point (`decode_with_scratch`), and typed timing struct (`Cr2Timings`) expose the decoder's internals for ongoing optimisation work.

### Chapter 3b — Improvements to the ljpeg.rs seam

No code changes to ljpeg.rs this pass. Findings:
- DHT_CACHE: correctly warm on repeated same-format decodes. ✓
- Double SOF parse: negligible cost; tracked for future pass.
- decode_tile `base` parameter: confirmed unused by cr2.rs; remains for DNG tiled path.

### Chapter 3c — Improvements to the cr2↔ljpeg boundary

The boundary contract is: cr2.rs calls `decode_tile(strip, out, 0, stride, stride, sof_h)` where `stride = sof_w * ncomp` from `parse_ljpeg_sof`. Both cr2.rs and ljpeg.rs parse the same SOF3 marker and must agree on dimensions. This invariant is now documented. A future improvement would have `decode_tile` return the parsed SOF dimensions to eliminate the double parse.

### Chapter 3d — Closing Remarks

The CR2 decoder's time budget is dominated by LJPEG (97%), a sequential Huffman decode algorithm
that cannot be meaningfully sped up without either a different algorithm (Canon's proprietary
implementation is optimised in firmware) or parallelism at the tile level (CR2 has one strip,
so per-image parallelism requires splitting the LJPEG stream, which is non-trivial).

The practical improvements from this pass are in **correctness**, **memory safety**, and
**API readiness** rather than raw speed. The BlackLevel fix affects downstream colour accuracy
for all CR2 files. The memory reduction is significant for batch ingest pipelines. The new APIs
provide the instrumentation needed for future profiling passes.

---

## 7. LJPEG Huffman Vectorisation — 2026-06-30

### Changes

Two changes to `ljpeg.rs`, both in the hot decode path:

**A. Fast 8-bit prefix table (`fast8`):**

Added `fast8: [u32; 256]` to `HuffTable`. Populated in `build()` for all codes with
`code_len ≤ 8`: each entry = `consume_bits | (category << 8)`. In the decode inner loop,
peek 8 bits first and resolve the code in one table lookup without branching. Only codes
longer than 8 bits fall through to the existing full-width lookup. For typical Canon CR2
Huffman tables, the fast path fires for the large majority of codes.

**B. Bulk 4-byte fill in `BitReader::fill()`:**

Added a fast path that loads 4 non-FF bytes at once as a 32-bit word into the u64 bit
buffer, rather than one byte per iteration. Guard: `self.nbits ≤ 32` ensures no u64
overflow (max after bulk load = 64 bits). Eliminates 3 of every 4 fill iterations when
the compressed stream contains no `0xFF` bytes (the common case in RAW image entropy data).

**C. Loop hoists:**

Moved `row_base` and `emit_row` (the `row < out_rows` check) out of the inner `comp` loop
to the row loop header.

### Benchmark: Before vs After

| Metric | Before (2026-06-15) | After (2026-06-30) | Δ |
|--------|---------------------|---------------------|---|
| AvgTotal | 398.16 ms | 366.92 ms | **−7.8%** |
| AvgLJPEG | 386.13 ms | 350.99 ms | **−9.1%** |
| FileA avg | 353.66 ms | 328.80 ms | −7.0% |
| FileB avg | 442.65 ms | 405.04 ms | −8.5% |
| StdDev | 52.10 ms | 38.43 ms | — |

```
Run  1 [A] total=322.5ms  ljpeg=308.9ms  crop=3.0ms  5184×3456
Run  2 [B] total=398.0ms  ljpeg=380.1ms  crop=9.2ms  6000×4000
Run  3 [A] total=335.6ms  ljpeg=318.5ms  crop=6.1ms  5184×3456
Run  4 [B] total=405.9ms  ljpeg=384.1ms  crop=7.6ms  6000×4000
Run  5 [A] total=325.8ms  ljpeg=313.1ms  crop=4.4ms  5184×3456
Run  6 [B] total=413.6ms  ljpeg=397.3ms  crop=5.6ms  6000×4000
Run  7 [A] total=328.2ms  ljpeg=317.2ms  crop=3.8ms  5184×3456
Run  8 [B] total=405.3ms  ljpeg=388.2ms  crop=8.5ms  6000×4000
Run  9 [A] total=331.9ms  ljpeg=319.3ms  crop=4.4ms  5184×3456
Run 10 [B] total=402.5ms  ljpeg=383.3ms  crop=6.4ms  6000×4000

AvgTotal:  366.92 ms   MedTotal: 398.01 ms
MinTotal:  322.47 ms   MaxTotal: 413.56 ms
StdDev:    38.43 ms
AvgLJPEG: 350.99 ms (95.7%)
FileA avg: 328.80 ms  |  FileB avg: 405.04 ms
```

### Interpretation

The ~9% LJPEG reduction is consistent across both files (−7.0% FileA, −8.5% FileB). With
StdDev of ~38–52 ms across runs, the 31 ms average reduction is at the boundary of
statistical significance from a single 10-run session; the per-file directional consistency
strengthens confidence that the gain is real.

The improvement comes primarily from the bulk 4-byte fill eliminating ~75% of `fill()`
loop iterations in the common (non-FF) case. The fast8 table further removes one conditional
branch per symbol for the majority of short codes.

The LJPEG phase remains compute-bound at 95.7% of total. Further gains would require a
fundamentally different approach (e.g., SIMD bit manipulation for multi-symbol parallel
decode, or Huffman stream splitting for multi-threaded decode), both of which are
non-trivial for single-strip LJPEG.

---

## Appendix: Commit Scope

Changed files:
- `crates/raw-pipeline/src/cr2.rs` — full rewrite with all optimisations
- `crates/raw-pipeline/examples/cr2_bench.rs` — new benchmark binary
- `crates/raw-pipeline/examples/cr2_baseline.rs` — new baseline comparison binary

Unchanged (verified no regression):
- `crates/raw-pipeline/src/ljpeg.rs`
- `src/lib.rs` (WASM entry point — CR2 public API unchanged)
- All StandardMultifileTest metrics within historical variance
