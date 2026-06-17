# Decode Timing Probes — Instrumentation Map

All timing probes for the JXL decode pipeline, including existing and new probes with exact file:line locations.

---

## Existing Probes (Already Instrumented)

### facade.ts Decode Metrics

| Probe | Line (approx) | Fires On | Emits (ms) | Notes |
|-------|---------------|----------|-----------|-------|
| `shot_wasm_ms` | ~1570 | One-shot decode finish | Total WASM decode time | Direct call to WASM; excludes I/O |
| `shot_transform_ms` | ~1575 | One-shot after decode | applyRegionAndDownsample + applyTargetResize | JS transformation time |
| `prog_frame_prep_ms` | ~1531 | Progressive frame ready | Time to prepare frame (detach + region + resize) | Does NOT split region/resize |
| `prog_frame_count` | ~1532 | Progressive frame emit | Counter (not time) | Number of frames decoded |
| `decode_scale_used` | ~1556 | One-shot output | Flag: region or scale used | Boolean; 0 or 1 |
| `source_pixels_decoded` | ~1533 | Progressive metadata | W × H (pixel count) | Not a time; count of pixels |

### decode-handler.ts Metrics

| Probe | Line (approx) | Fires On | Emits (ms) | Notes |
|-------|---------------|----------|-----------|-------|
| `time_to_header_ms` | decode-handler ~580 | Header decoded | Time from session start to header ready | Sync measurement in handler |
| `time_to_first_pixel_ms` | decode-handler ~600 | First frame complete | Time from session start to first frame pixels | Via metadata event |
| `copy_to_transfer_ms` | decode-handler ~620 | Frame transfer ready | Time to prepare frame for postMessage | Includes toTransferablePixels |
| `copied_bytes` | decode-handler ~625 | Per postMessage | Total bytes transferred | Not a time; byte count |
| `output_bytes` | decode-handler ~630 | Per frame | Frame size in bytes | W × H × bpc; pixel count |
| `timeToFinalMs` | decode-handler ~640 | Final frame emitted | Time from session start to last frame | Metadata in DecodeFrameMeta |

### JXTC / Tiled Metrics (facade.ts + decode-handler.ts)

| Probe | Lines | Context | Notes |
|-------|-------|---------|-------|
| `jxtc_tile_decode_ms` | ~1210–1250 (facade) | Per tile decoded | Time to decode one JXTC tile |
| `jxtc_tile_count` | ~1250 | Per JXTC batch | Number of tiles in current pass |
| Various tiled_* metrics | Various | Tiled region decoding | See code for full list; not exhaustive here |

---

## New Probes (Phase 4, to Add)

### Probe 1: `heap_set_ms` — Decode Input Copy

**Location**: `packages/jxl-wasm/src/facade.ts`, line ~1472–1483 (batch loop)

**When**: Every `feedDecoder` call (after queuing chunks, before decPush)

**What**: Time to copy queued chunks into WASM heap via `HEAPU8.set()`

**Relevance**: Measures JS↔WASM boundary cost for input; identifies if chunk batching is effective

**Instrumentation**:
```typescript
let woff = 0;
const tHeapSet0 = performance.now();
while (this.chunkQueue.length > this.readIndex && this.chunkQueue[this.readIndex] !== null) {
  const chunk = this.chunkQueue[this.readIndex] as Uint8Array;
  this.chunkQueue[this.readIndex++] = null;
  this.queuedBytes -= chunk.byteLength;
  module.HEAPU8.set(chunk, chunkBufPtr + woff);
  woff += chunk.byteLength;
}
this.options.onMetric?.("heap_set_ms", performance.now() - tHeapSet0);
```

**Expected Range**: 0.1–2 ms (depends on batch size)

---

### Probe 2: `malloc_grow_ms` — WASM Memory Growth

**Location**: `packages/jxl-wasm/src/facade.ts`, line ~1464–1471 (malloc branch)

**When**: On first batch or when batch exceeds `chunkBufCap`

**What**: Time to allocate or reallocate `chunkBufPtr`

**Relevance**: Measures WASM memory allocation cost; identifies if pre-allocation would help

**Instrumentation**:
```typescript
if (batchBytes > chunkBufCap) {
  const tMalloc0 = performance.now();
  if (chunkBufPtr !== 0) module._free(chunkBufPtr);
  chunkBufPtr = module._malloc(batchBytes);
  if (chunkBufPtr === 0) {
    throw new Error("WASM Memory Allocation OOM during progressive stream push");
  }
  chunkBufCap = batchBytes;
  this.options.onMetric?.("malloc_grow_ms", performance.now() - tMalloc0);
}
```

**Expected Range**: 0.01–0.5 ms (typically fires 1–2× per stream session)

---

### Probe 3: `take_frame_ms` — Decode Output Detach

**Location**: `packages/jxl-wasm/src/facade.ts`, line ~1525–1526 (takeAndWrap call)

**When**: Every progressive frame ready; every one-shot decode complete

**What**: Time to detach output from WASM heap and prepare for transfer (includes applyRegionAndDownsample + applyTargetResize)

**Relevance**: Measures WASM→JS boundary cost; identifies if frame copy or region/resize is bottleneck

**Instrumentation**:
```typescript
const tFramePrep0 = performance.now();
const tTake0 = performance.now();
const wrapped = takeAndWrap(decTakeFlushed(dec));
this.options.onMetric?.("take_frame_ms", performance.now() - tTake0);
```

**Expected Range**: 1–20 ms (depends on frame size and region/resize activity)

**Related**: Compare with `prog_frame_prep_ms` (should be same value or slightly higher if region/resize included)

---

## Optional Probes (Not Phase 4, but Recommended for Future)

### Probe 4a: `region_crop_ms` — Region Crop Only (Split from `prog_frame_prep_ms`)

**Location**: `packages/jxl-wasm/src/facade.ts`, inside `applyRegionAndDownsample`

**When**: If region active

**What**: Time to crop and downsample frame in JS

**Relevance**: Identifies if region crops are a bottleneck; needed to justify C++ optimization

**Instrumentation**: (Not in Phase 4; defer pending data)

---

### Probe 4b: `target_resize_ms` — Resize Only (Split from `prog_frame_prep_ms`)

**Location**: `packages/jxl-wasm/src/facade.ts`, inside `applyTargetResize`

**When**: If output dims ≠ requested dims

**What**: Time to bilinear resize frame in JS

**Relevance**: Identifies if resizes are a bottleneck; needed to justify WASM kernel

**Instrumentation**: (Not in Phase 4; defer pending data)

---

## Probe Emission Strategy

### DecoderOptions.onMetric callback

```typescript
onMetric?: (name: string, value: number) => void
```

Available on `LibjxlDecoder` constructor options (line 130).

All new probes use `this.options.onMetric?.("probe_name", value)` — safe if callback not provided.

### Test Integration

To enable metrics in existing tests:

```typescript
const decoder = new LibjxlDecoder({
  onMetric: (name, value) => {
    console.log(`[metric] ${name} = ${value.toFixed(2)} ms`);
  }
});
```

### Production Monitoring

Metrics exposed via callback can be:
1. Logged to console (dev)
2. Sent to analytics backend (production)
3. Written to performance observer (browser DevTools)
4. Aggregated in time-series database (observability)

---

## Verification (Phase 5)

After Phase 4 edits:

```powershell
cd packages/jxl-wasm && npx tsc --noEmit
```

Expected: Zero new errors (all probes use `?.` optional chaining).

Then test with any existing test that sets `onMetric`:

```bash
npm test
```

Verify new probes appear in metric output (search test logs for `heap_set_ms`, `malloc_grow_ms`, `take_frame_ms`).

---

## Probe Placement Rationale

| Probe | Why Here | Why Not Elsewhere |
|-------|----------|-------------------|
| `heap_set_ms` | Batch-level; captures entire copy loop at once | Not per-chunk (would have 1000s of calls per stream) |
| `malloc_grow_ms` | Rare event (1–2× per session); isolated in if-branch | Not per-batch (fires only on growth) |
| `take_frame_ms` | Frame-level; captures detach + region + resize | Not per-pixel (violates no-inner-loop rule) |

---

## Dashboard / Telemetry Hints

After collecting metrics for 1–2 weeks in production:

| Metric | Alert If | Indicates |
|--------|----------|-----------|
| `heap_set_ms` > 5 ms | Possible bottleneck (high batch size or slow memory) | Consider larger batches or pre-allocation |
| `malloc_grow_ms` > 1 ms | Rare; WASM memory fragmentation | Unlikely; WASM allocator usually fast |
| `take_frame_ms` > 10 ms | Frame copy / region crop / resize slow | Potential for Rank #2–4 optimizations |
| `take_frame_ms` > 50 ms | Possible stall or timeout | Check for UI blocking or worker overload |

Baseline (scalar tier, 1080p, single decode):
- `heap_set_ms`: ~0.2–0.5 ms per batch
- `malloc_grow_ms`: ~0.05 ms (fires ~2× per session, negligible)
- `take_frame_ms`: ~3–5 ms per frame (no region/resize)
