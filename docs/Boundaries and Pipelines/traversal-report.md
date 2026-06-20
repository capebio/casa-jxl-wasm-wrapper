# Buffer Traversals — Repeated Scans & Copies

Key repeated buffer operations that scan or copy data across boundaries. All locations are in `packages/jxl-wasm/src/facade.ts` unless noted.

| Traversal | Location | Trigger | Complexity | Size | Notes |
|-----------|----------|---------|------------|------|-------|
| **HEAPU8.set(chunk, ptr)** batch loop | line ~1472–1483 | Per decode batch | O(∑ chunk bytes) | Sum of queued chunks | Copies all chunk bytes into heap in one loop; HWM backpressure prevents unbounded growth |
| **HEAPU8.set(view, ptr)** streaming encode | line ~1857–1859 | Per pixel push | O(W×H×fmt) | Pixel chunk size | Copies input pixels to encoder heap; happens per encoder.pushPixels call |
| **applyRegionAndDownsample** | line ~1500–1509 | Per frame if region set | O(W×H) | Frame pixel count | JS cropping + downsampling; one scan if crop or subsample active |
| **applyTargetResize** | line ~1511–1525 | Per frame if dims mismatch | O(W×H) | Frame pixel count | Bilinear resize in JS; full 2-pass scan if target dims ≠ decoded dims |
| **HEAPU8.slice(ptr, size)** output detach | line ~1416 (takeAndWrap) | Per frame (decode) or per 256KB chunk (encode) | O(size) | Frame pixels or chunk bytes | Deep copy from WASM heap to JS backing; necessary (dangling ref safety) |
| **toTransferablePixels SAB.slice** | line ~1417 (if SAB active) | Per frame on MT tiers | O(W×H×bpc) | Frame pixel count | **MT-only**: SAB cannot be transferred; `.slice()` copy required for thread safety |

---

## Traversal Hotspots (by frequency × cost)

### High-Frequency, High-Cost

**1. HEAPU8.set(chunk, ptr) — Decode Batching**
- **Frequency**: Once per batch (typically 10–100 KB per batch)
- **Cost**: O(batch bytes) — direct byte copy
- **When**: `feedDecoder` processes queued chunks
- **Optimization potential**: Moderate — batching already reduces frequency; larger batches amortize overhead
- **Status**: No low-hanging fruit; chunk size is I/O-limited

**2. applyRegionAndDownsample — Region Crops**
- **Frequency**: Per frame if region active (uncommon in baseline decode)
- **Cost**: O(W×H) — linear scan with arithmetic
- **When**: Decode result has roi / subsample set
- **Optimization potential**: **HIGH** — move to C++ (one-shot already has `cppDidCrop` flag; progressive doesn't)
- **Status**: Progressive path missing C++ crop; would save ~20% frame time for region queries

**3. applyTargetResize — Client-Side Resize**
- **Frequency**: Per frame if target dims set
- **Cost**: O(W×H) bilinear (4 neighbors per pixel)
- **When**: Decoder output size ≠ requested size
- **Optimization potential**: **MEDIUM** — move to WASM bilinear kernel (currently JS-only)
- **Status**: No current WASM resize; would save ~10–30% for resize-heavy workloads

### Medium-Frequency, Medium-Cost

**4. HEAPU8.set(view, ptr) — Encode Input**
- **Frequency**: Per encoder.pushPixels call (one per image region / chunk)
- **Cost**: O(W×H×fmt) — direct byte copy
- **When**: Feeding pixels to encoder
- **Optimization potential**: LOW — input encapsulation is necessary; no free optimizations
- **Status**: Already optimal; only optimization is batching at caller level

**5. HEAPU8.slice(ptr, size) — Decode Output Detach**
- **Frequency**: Per frame
- **Cost**: O(W×H×bpc) — linear byte copy
- **When**: Frame ready; must detach from WASM heap before memory can grow
- **Optimization potential**: **MEDIUM** — delay free() until after postMessage to enable zero-copy transfer (architectural change)
- **Status**: Possible but requires API redesign; not done

**6. SAB.slice() Copy (MT Tier Only)**
- **Frequency**: Per frame (MT tier only)
- **Cost**: O(W×H×bpc) — redundant copy
- **When**: SharedArrayBuffer active on multi-threaded tier
- **Optimization potential**: **HIGH** (for MT workloads) — use Atomics.waitAsync + ring buffer to share pixels without copy
- **Status**: Not done; complex architectural change; medium priority

---

## Data Movement Summary

### Decode Path (Per-Frame)

```
Chunks (∑KB)  ──HEAPU8.set──>  WASM heap
WASM heap  ──HEAPU8.slice──>  JS Uint8Array  (COPY #1)
JS Array  ──applyRegion?──>  Cropped Array   (if region; COPY #2)
JS Array  ──applyResize?──>  Resized Array   (if resize; COPY #3)
JS Array  ──SAB.slice?──────>  SAB Array      (if MT; COPY #4)
Final     ──postMessage──────>  Main thread   (transfer, zero-cost)
```

**Baseline: 1–2 copies per frame. With region + resize + SAB: up to 4 copies** (unlikely concurrence).

### Encode Path (Per-Push)

```
Pixels (∑KB)  ──HEAPU8.set──>  WASM heap     (COPY #1)
WASM heap  ──HEAPU8.slice──>  JS chunk      (COPY #2, per 256KB out)
JS chunk  ──postMessage──────>  Main thread  (transfer, zero-cost)
```

**Baseline: 2 copies per push (input + output chunk)**.

---

## Recommendations

| Priority | Opportunity | Effort | Impact | Action |
|----------|-------------|--------|--------|--------|
| **P0** | Measure applyRegionAndDownsample % of frame time | Low | Unblock P1 decision | Add `region_crop_ms` probe (Phase 4) |
| **P1** | Move region crop to C++ (progressive path) | Medium | HIGH (region queries 20% faster) | Architectural change; defer pending region usage data |
| **P2** | WASM bilinear resize kernel | Medium | MEDIUM (resize queries 10–30% faster) | Create `resize_ms` probe; profile first |
| **P3** | SAB ring-buffer (MT tier optimization) | High | HIGH (MT tier zero-copy) | Complex; defer; track separately |
| **P4** | Pre-allocate chunkBufPtr at session start | Low | LOW (baseline memory ↑, first-batch latency ↓) | Optional optimization for low-latency applications |

---

## P0 Measurement Results — 2026-06-20 (settles P1/#2)

**Probes wired** (`facade.ts` progressive path): `region_crop_ms` (cumulative `applyRegionAndDownsample` time, a subset of `take_frame_ms`) and `prog_frame_resize_ms`, emitted beside `prog_frame_prep_ms`. Combined with the existing `decode_scale_used` (= `resolvedDownsample`), production telemetry can now bucket frames by downsample factor.

**Bench** (`.flipflop/tests/region-crop-downsample.mjs`): `applyRegionAndDownsample` measured in isolation on full-frame rgba8 at photo sizes — exactly the JS pass a C++ migration would replace. Verbatim copy of the facade function; flipflop interleaved/thermally-fair medians.

`median_warm_ms` @ **4096² (16.7 MP)**, baseline = `full-copy` (the irreducible per-frame detach copy):

| config (bpc=1) | ms | vs full-copy | trust | pipeline meaning |
|----------------|-----|-------------|-------|------------------|
| full-copy | 12.9 | — | high | no-region frame copy |
| crop50-ds1 | 3.8 | **−70%** | low (variance) | region crop, full-res — row memcpy |
| full-ds2 | 27.6 | **+114%** | high | downsample 2× preview — per-pixel gather |
| full-ds4 | 9.8 | −24% | low (variance) | downsample 4× preview |
| crop50-ds2 | 10.4 | +19% | high | ROI + 2× preview |

Scales linearly with output-pixel count (2048²: full-copy 3.6 / crop-ds1 1.3 / full-ds2 10.2 / full-ds4 4.9 / crop-ds2 5.0 ms). Thermal `unknown` (no LibreHardwareMonitor; static desktop freq) — lean on interleave + stdev; the two load-bearing rows (full-copy, full-ds2 @4096) are `trust:high`.

### Verdict

The original P1 ("move region crop to C++") was **mis-aimed**: the *crop* is not the cost.

1. **Pure region crop (downsample=1) — NO-GO.** Uses native `TypedArray.set` row memcpy; 3.8 ms @16 MP, already *cheaper than a full-frame copy*. C++ would add a cropped-size slice-out copy and cannot beat memcpy — net loss. Most full-res progressive + region queries hit this path.
2. **Per-pixel downsample gather (ds≥2) — CONDITIONAL-GO, gated on telemetry.** `full-ds2` at 27.6 ms (2.1× a full copy, `trust:high`) is the only genuinely expensive JS, and it **compounds per emitted pass** under `emitEveryPass`. The C++ machinery already exists (`DownsampleRgba`, `bridge.cpp:379`) and is *already used by the one-shot path*. BUT downscaled previews usually take the one-shot (C++) route, not progressive — so progressive+downsample frames may be rare.

**Re-scoped P1**: not "crop → C++", but "**skip JS downsample on progressive flush; route the flushed buffer through the existing C++ `DownsampleRgba`**" — and ship it only if production `region_crop_ms` with `decode_scale_used > 1` shows real, repeated cost. Pure-crop (ds1) frames stay in JS. Gate per CLAUDE.md (adaptive change needs benchmark data); this measurement bounds the upside, telemetry must confirm frequency. Needs a WASM rebuild.

---

## Notes

- **No per-pixel probes**: All traversals are instrumented at batch/frame level (per handoff: "no probes inside tight inner loops per-pixel").
- **Existing probes**: `prog_frame_prep_ms` includes applyRegion + applyResize time. As of 2026-06-20, `region_crop_ms` + `prog_frame_resize_ms` split these out (see P0 Results above).
- **New probes** (Phase 4): Add `heap_set_ms`, `malloc_grow_ms`, `take_frame_ms`, `enc_heap_set_ms` to isolate specific boundaries.
