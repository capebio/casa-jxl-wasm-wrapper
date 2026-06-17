# Pipeline & Boundary Investigation — Handoff

**Date:** 2026-06-17  
**Branch:** LateNight16June  
**Plan file:** `C:\Users\User\.claude\plans\jazzy-bouncing-metcalfe.md`

---

## What Was Done

Full code-read of the JXL encode/decode pipeline. All buffer lifecycle facts are grounded in source — no guessing. The plan file contains the complete findings.

---

## What Needs To Be Done (in order)

### Phase 1 — Create folder structure

```
docs/Boundaries and Pipelines/
docs/Boundaries and Pipelines/boundary-timings/
```

### Phase 2 — Write 6 static analysis documents

All content is derivable directly from the plan file. Write each document:

**1. `docs/Boundaries and Pipelines/pipeline-map.md`**
Full encode + decode node graph. For each node: name, responsibility, input, output.

Decode nodes: Source → Fetch → DecodeSession.push → scheduler.send → [transfer] → Worker.onmessage → DecodeHandler.onChunk → ChunkRing → feedDecoder → facade.push → WASM heap (chunkBufPtr) → libjxl → WASM output handle → retainBufferView (subarray) → applyRegionAndDownsample → new Uint8Array (detach) → toTransferablePixels → postMessage [transfer] → decode-session handleMessage → frameStream → consumer

Encode nodes: RGBA Source → encode-session.pushPixels → toTransferableBuffer → scheduler.send → [transfer] → Worker.onmessage → EncodeHandler.onPixels → pixelQueue → feedEncoder → facade.pushPixels → HEAPU8.set to enc_pixels_ptr → libjxl enc_finish → enc_take_chunk → HEAPU8.slice → postMessage [transfer] → encode-session handleMessage → caller

**2. `docs/Boundaries and Pipelines/buffer-lifecycle.md`**
Table format, both pipelines. See plan §Decode Copy Map and §Encode Copy Map tables.

**3. `docs/Boundaries and Pipelines/allocation-report.md`**
See plan §WASM Allocations table. Add: no leaks detected, all malloc/free in finally blocks.

**4. `docs/Boundaries and Pipelines/traversal-report.md`**
Key traversals:
- `HEAPU8.set(chunk, chunkBufPtr+woff)` — per batch, full chunk bytes (decode input)
- `HEAPU8.set(view, ptr)` — per pixel chunk (encode input)  
- `applyRegionAndDownsample` — per frame when region/downsample set (JS crop/downsample: O(W×H))
- `applyTargetResize` — per frame when target dims set (bilinear JS resize: O(W×H))
- `HEAPU8.slice(dataPtr, size)` — per encode chunk (copy out of WASM)
- SAB `.slice()` in `toTransferablePixels` — per frame when MT tier active

**5. `docs/Boundaries and Pipelines/boundary-report.md`**
See plan §Heat Scores table. Boundary cost table from plan §Boundary Crossing Summary. Include SIMD/threading status.

**6. `docs/Boundaries and Pipelines/optimization-index.md`**
See plan §Optimization Index table. 8 ranked items already written in plan.

### Phase 3 — Write 2 timing documents

**7. `docs/Boundaries and Pipelines/boundary-timings/decode-timing-probes.md`**
List existing probes (from plan §Timing Already Instrumented) + 3 new ones with exact location:
- `heap_set_ms` — `facade.ts` around line 1478 (inside `HEAPU8.set` in progressive batch)
- `malloc_grow_ms` — `facade.ts` around line 1465 (inside `batchBytes > chunkBufCap` branch)
- `take_frame_ms` — `facade.ts` around line 1526 (wrapping `takeAndWrap(decTakeFlushed(...))`)

**8. `docs/Boundaries and Pipelines/boundary-timings/encode-timing-probes.md`**
List existing probes + 1 new:
- `enc_heap_set_ms` — `facade.ts` around line 1857 (inside `enc_pixels_ptr` branch, after `HEAPU8.set(view, ptr)`)

### Phase 4 — Add 4 timing probes to facade.ts

**Read the file first** (required by Edit tool). Then apply 4 surgical edits.

#### Edit 1: `malloc_grow_ms` probe (~line 1464)

Find:
```typescript
          if (batchBytes > chunkBufCap) {
            if (chunkBufPtr !== 0) module._free(chunkBufPtr);
            chunkBufPtr = module._malloc(batchBytes);
            if (chunkBufPtr === 0) {
              throw new Error("WASM Memory Allocation OOM during progressive stream push");
            }
            chunkBufCap = batchBytes;
          }
```

Replace with:
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

#### Edit 2: `heap_set_ms` probe (~line 1472-1483)

Find:
```typescript
          let woff = 0;
          while (this.chunkQueue.length > this.readIndex && this.chunkQueue[this.readIndex] !== null) {
            const chunk = this.chunkQueue[this.readIndex] as Uint8Array;
            // Null slot immediately so GC can reclaim the Uint8Array after the HEAPU8.set copy.
            this.chunkQueue[this.readIndex++] = null;
            this.queuedBytes -= chunk.byteLength;
            module.HEAPU8.set(chunk, chunkBufPtr + woff);
            woff += chunk.byteLength;
          }
          this.compactQueue();
          result = decPush(dec, chunkBufPtr, batchBytes);
```

Replace with:
```typescript
          let woff = 0;
          const tHeapSet0 = performance.now();
          while (this.chunkQueue.length > this.readIndex && this.chunkQueue[this.readIndex] !== null) {
            const chunk = this.chunkQueue[this.readIndex] as Uint8Array;
            // Null slot immediately so GC can reclaim the Uint8Array after the HEAPU8.set copy.
            this.chunkQueue[this.readIndex++] = null;
            this.queuedBytes -= chunk.byteLength;
            module.HEAPU8.set(chunk, chunkBufPtr + woff);
            woff += chunk.byteLength;
          }
          this.options.onMetric?.("heap_set_ms", performance.now() - tHeapSet0);
          this.compactQueue();
          result = decPush(dec, chunkBufPtr, batchBytes);
```

#### Edit 3: `take_frame_ms` probe at flushed frame (~line 1526)

Find (inside `if (result === 1)` block):
```typescript
          const tFramePrep0 = performance.now();
          const wrapped = takeAndWrap(decTakeFlushed(dec));
```

Replace with:
```typescript
          const tFramePrep0 = performance.now();
          const tTake0 = performance.now();
          const wrapped = takeAndWrap(decTakeFlushed(dec));
          this.options.onMetric?.("take_frame_ms", performance.now() - tTake0);
```

#### Edit 4: `enc_heap_set_ms` probe (~line 1854-1858)

Find (inside `if (module._jxl_wasm_enc_pixels_ptr && module._jxl_wasm_enc_advance_written)` block):
```typescript
          if (this.streamingInputActive) {
        if (module._jxl_wasm_enc_pixels_ptr && module._jxl_wasm_enc_advance_written) {
          const t0 = performance.now();
          const ptr = module._jxl_wasm_enc_pixels_ptr(this.wasmEncState, view.byteLength);
          if (ptr === 0) throw new Error("JXL streaming pixel push failed (0)");
          module.HEAPU8.set(view, ptr);
          const rc = module._jxl_wasm_enc_advance_written(this.wasmEncState, view.byteLength);
          if (rc !== 0) throw new Error(`JXL streaming pixel push failed (${rc})`);
          this.tMallocCopy += performance.now() - t0;
```

Replace with:
```typescript
          if (this.streamingInputActive) {
        if (module._jxl_wasm_enc_pixels_ptr && module._jxl_wasm_enc_advance_written) {
          const t0 = performance.now();
          const ptr = module._jxl_wasm_enc_pixels_ptr(this.wasmEncState, view.byteLength);
          if (ptr === 0) throw new Error("JXL streaming pixel push failed (0)");
          const tEncHeapSet0 = performance.now();
          module.HEAPU8.set(view, ptr);
          this.options.onMetric?.("enc_heap_set_ms", performance.now() - tEncHeapSet0);
          const rc = module._jxl_wasm_enc_advance_written(this.wasmEncState, view.byteLength);
          if (rc !== 0) throw new Error(`JXL streaming pixel push failed (${rc})`);
          this.tMallocCopy += performance.now() - t0;
```

### Phase 5 — Verify

```powershell
cd packages/jxl-wasm && npx tsc --noEmit
```

No new errors expected — all probes use `?.` optional chaining on `onMetric`, which is already typed as `((name: string, value: number) => void) | undefined` in `DecoderOptions` and available through `this.options`.

---

## Critical Context

**File line numbers are approximate** — verify the exact strings using the snippets above before editing. The old_string in each Edit call must match exactly.

**`this.options.onMetric` in `LibjxlDecoder`**: exists on `DecoderOptions` (line 130). The `LibjxlDecoder` constructor stores `options: DecoderOptions`. All probe calls use `this.options.onMetric?.()` — safe if undefined.

**`this.options.onMetric` does NOT exist in `LibjxlEncoder`**: `EncoderOptions` has no `onMetric`. Probe 4 (`enc_heap_set_ms`) needs to use the existing `console.log` pattern or add to profiling accumulators (`this.tMallocCopy`) — do NOT call `this.options.onMetric` in the encoder. Instead, accumulate timing and post it via `postFinalMetrics`. Simplest: just add `this.tMallocCopy += performance.now() - tEncHeapSet0` alongside the existing `tMallocCopy` accumulator — already done by the original `t0` timing. So Edit 4 is optional; skip if risky.

**facade.ts is 3084 lines** — be precise with old_string matching to avoid Edit failures.

---

## Files to Create/Edit

| Action | File |
|--------|------|
| Create | `docs/Boundaries and Pipelines/pipeline-map.md` |
| Create | `docs/Boundaries and Pipelines/buffer-lifecycle.md` |
| Create | `docs/Boundaries and Pipelines/allocation-report.md` |
| Create | `docs/Boundaries and Pipelines/traversal-report.md` |
| Create | `docs/Boundaries and Pipelines/boundary-report.md` |
| Create | `docs/Boundaries and Pipelines/optimization-index.md` |
| Create | `docs/Boundaries and Pipelines/boundary-timings/decode-timing-probes.md` |
| Create | `docs/Boundaries and Pipelines/boundary-timings/encode-timing-probes.md` |
| Edit | `packages/jxl-wasm/src/facade.ts` (4 probe insertions) |

No other files need changing.
