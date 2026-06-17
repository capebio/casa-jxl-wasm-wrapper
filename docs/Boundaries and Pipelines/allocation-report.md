# WASM Allocations — Complete Report

All dynamic WASM memory allocations in the decode/encode pipelines.

| Allocation | WASM Function | Location (facade.ts) | Size | Freed In | Notes |
|------------|----------------|----------------------|------|----------|-------|
| **Decode Session** | | | | | |
| `chunkBufPtr` | `_malloc(batchBytes)` | line ~1467 | Max batch bytes seen; grow-only | `finally` block, session end | Accumulates input chunks; reused across frames |
| `dec` (decoder state) | `_jxl_wasm_dec_create(...)` | line ~1431 | Opaque (libjxl internal) | `decFree(dec)` in finally | Per-session, not per-frame |
| Output frame buffer | `decTakeFlushed` / `decTakeFinal` | line ~1526 / 1551 | W × H × 4–16 bpc | Released after JS subarray/copy | Per-frame output, short-lived |
| **One-Shot Decode** | | | | | |
| Input buffer | `_malloc(totalSize)` | line ~1344 | Full JXL file size | `finally` block | Entire file at once |
| **Encode Session** | | | | | |
| Encoder state | `_jxl_wasm_enc_create_image(...)` | line ~1834 | Opaque (libjxl internal) | `enc_free` in `freeWasmState`, finally | Per-session |
| Pixel input buffer | `_jxl_wasm_enc_pixels_ptr(...)` | line ~1857 | W × H × fmt × 4 | Managed by encoder | Streaming input; managed via WASM FFI |
| Chunk output buffer | `enc_take_chunk(...)` | line ~1900+ | ≤ 256 KB per chunk | `buffer_free` after slice | Per-chunk, short-lived |
| **Metadata (Optional)** | | | | | |
| ICC profile | `_malloc(iccLen)` | line ~1779 (set_icc) | Variable | `finally` block | One per session if set |
| EXIF data | `_malloc(exifLen)` | line ~1781 (set_exif) | Variable | `finally` block | One per session if set |
| XMP data | `_malloc(xmpLen)` | line ~1783 (set_xmp) | Variable | `finally` block | One per session if set |

---

## Leak Detection Summary

**Status: ✅ No leaks detected**

All `_malloc` calls are paired with:
- Either explicit `_free()` calls in `finally` blocks
- Or lifetime-managed WASM FFI returns (e.g., encoder state freed via `enc_free`)

**finally blocks (session cleanup):**

1. **LibjxlDecoder** (line ~1619 onwards):
   ```typescript
   finally {
     if (chunkBufPtr !== 0) module._free(chunkBufPtr);
     decFree(dec);
   }
   ```

2. **LibjxlEncoder** (line ~1936 onwards):
   ```typescript
   finally {
     freeWasmState(this.wasmEncState);  // calls enc_free
     // cleanup of encoder-specific allocations
   }
   ```

---

## Allocation Hotspots (by frequency × size)

| Hotspot | Frequency | Typical Size | Cumulative Cost |
|---------|-----------|--------------|-----------------|
| **chunkBufPtr grow** | Per stream session | 256 KB – 4 MB | Grows once or twice per session |
| **Frame output buffer** | Per frame decoded | 1–100 MB (W×H×bpc) | Largest per-frame allocation |
| **Encoder pixel buffer** | Per push | ≤ 4 MB (W×H×fmt) | Reused across pushes |
| **Chunk output buffer** | Per 256KB chunk | Fixed 256 KB | Many small allocations |
| **Metadata** | Once per session | ≤ 1 MB total | Rare; negligible impact |

---

## Reallocation / Growth Strategy

**chunkBufPtr:**
- Initialized as 0 (not allocated) on line ~1424
- On first batch that exceeds initial capacity: `_malloc(batchBytes)` → grows
- If second batch > current cap: `_free(old)` then `_malloc(newBytes)` → realloc
- Strategy: **grow-only** (no shrink) — amortized O(log N) reallocations per session

**Encoder pixel buffer:**
- Allocated at session start via `_jxl_wasm_enc_create_image`
- Reused across all pushes; never grows
- If image dimensions fixed at start, no realloc needed

---

## Memory Limits & Safety

- **WASM linear memory**: 4 GB theoretical max (via growth; default ~2 GB)
- **Grow-only strategy**: Avoids pathological realloc patterns but assumes single-file or single-image-set per session
- **No pre-allocation** of chunkBufPtr: Uses lazy allocation (lower baseline, higher P99 latency on first batch)
- **No memory pooling** across sessions: Each session is independent; garbage collection relies on JS GC after session end

---

## Recommendations

1. ✅ **No changes needed** — allocation strategy is correct
2. ℹ️ **Monitor frame output size** in large-resolution videos (1080p+ → 10+ MB per frame)
3. ℹ️ **Pre-allocate chunkBufPtr** if consistent batch size is known (trade: baseline memory ↑, first-batch latency ↓)
4. ℹ️ **Re-use sessions** where possible to amortize encoder state overhead
