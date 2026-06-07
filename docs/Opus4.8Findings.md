# Opus 4.8 Findings — Why Progressive Decode Is So Slow

**Date:** 2026-06-06
**Subject:** Progressive decode of `P2200608.ORF` → JXL (2.19 MB encoded, 5240×3912, 78.2 MB RGBA). 59 progressive passes, ~92.6 s decode wall time (~1.5 s per pass). Feels throttled even with "unthrottled" selected.

## TL;DR

The decode is **not** network-throttled. It is **render-bound**. Every 32 KB of stream we feed forces libjxl to re-render the **entire 20-megapixel image** from scratch and then memcpy the full ~82 MB RGBA buffer twice. With ~59 chunks that is ~59 full-frame renders where the codec only ever produces a handful of genuine progressive passes. The linear "+~1.5 s per +32 KB" growth is what makes it *look* like a fixed-rate throttle.

The throttle dropdown is a red herring: setting `throttleKbPerSec = 0` only removes an artificial `sleep()` between chunks (`web/jxl-single-progressive.js:987`). It cannot remove the per-chunk full-image render, which is the real cost.

## Evidence Chain (data → code)

### 1. The "+32 KB per pass" cadence is hardcoded chunking, not the codec

`web/jxl-single-progressive.js:13`
```js
const STEADY_DECODE_CHUNK_BYTES = 32 * 1024;
```
`feedThrottled()` (`:970`) slices the 2.19 MB stream into 32 KB chunks (after a small first-paint ramp of 1/2/4/8/16 KB) and `await decoder.push()`es each one (`:984`). 2.19 MB / 32 KB ≈ 67 chunks → 59 recorded passes. The TOON `+32.0KB` delta per row is exactly this chunk size, **not** a JXL progressive-pass boundary.

### 2. Each chunk triggers a full-image flush in the bridge

`packages/jxl-wasm/src/bridge.cpp` — `jxl_wasm_dec_push()` (`:2002`):
- Every push with data does `s->input_generation++` (`:2025`).
- After `JxlDecoderProcessInput` returns `NEED_MORE_INPUT`, the **opportunistic flush** path fires once per input generation (`:2041-2046`):
```cpp
if (s->frame_started && !s->final_ready &&
    s->opportunistic_flush_generation != s->input_generation &&
    TryFlushProgressiveImage(s)) {
  s->opportunistic_flush_generation = s->input_generation;
  return JXL_DEC_RESULT_PROGRESS;
}
```
Because each 32 KB push is its own generation, **every chunk produces exactly one flush** once the first frame has started. So 59 chunks ≈ 59 flushes.

### 3. A flush is a full 20 MP render + two 82 MB memcpys

`TryFlushProgressiveImage()` (`bridge.cpp:1916`):
```cpp
if (JxlDecoderFlushImage(s->dec) != JXL_DEC_SUCCESS) return false;   // full-frame render
...
memcpy(s->flushed, s->pixels, s->pixels_size);                        // ~82 MB copy
```
`JxlDecoderFlushImage` renders the **whole current image** (dequant → inverse DCT for every decoded group → upsampling → XYB→RGB → RGBA8 conversion across all 20.5 M pixels). It is O(full image) regardless of how few new bytes arrived. Then we `memcpy` the entire 82 MB into `s->flushed`, and the JS side (`facade.ts:1268`, `decTakeFlushed`) transfers another ~82 MB out to JS per pass.

Cost accounting per run:
- Full-frame renders: **~59 × 20.5 MP**
- `memcpy` in bridge: 59 × 82 MB ≈ **4.8 GB**
- buffer hand-off to JS: another ≈ **4.8 GB**

The TOON `decode_ms` (~1300–1900 ms, roughly **constant** as the buffer grows) is the signature of a fixed full-image render cost — if this were entropy-decoding only the new 32 KB, `decode_ms` would be tiny. It is constant because we re-render all 20.5 M pixels every time.

### 4. `progressiveDetail = 'passes'` maximizes the snapshot count

`web/jxl-single-progressive.js:11` → `const PROGRESSIVE_DETAIL = 'passes';` maps to `kPasses` (most granular) in `bridge.cpp:1985`. Combined with the per-generation opportunistic flush, this drives the maximum number of full renders. The encode side used `ProgressiveAc: 2`, which yields only a few *genuine* AC passes (DC + ~2–4 AC refinements) — yet we render ~59 frames.

### 5. paint is not the bottleneck

TOON `paint_ms` ≈ 170–230 ms vs `decode_ms` ≈ 1300–1900 ms. `decodeMs` is derived as `deltaMs − paintMs` (`:682`), i.e. it is dominated by the `await decoder.push()` flush, confirming the WASM render is the cost center.

## Root Cause

**Flush frequency is coupled to chunk count, not to genuine progressive-pass boundaries.** The bridge renders and copies the full 20 MP image once per 32 KB input generation. The number of expensive full-image renders (≈59) vastly exceeds the number of meaningful progressive stages (a handful). This is amplified by a small 32 KB steady chunk size and `progressiveDetail = 'passes'`.

The DONOTCHANGE comment at `bridge.cpp:2035-2040` explains *why* the opportunistic flush exists (small/medium images only emit one real `FRAME_PROGRESSION`, so the UI needs an open-stream snapshot). That rationale is sound for small images but pathological for large ones: it converts every chunk boundary into a full render.

## What Can Be Done To Speed This Up

Ordered by expected impact / effort. (Proposals only — implementation is the next task.)

1. **Decouple flush from chunk count — rate-limit the opportunistic flush.** Gate the opportunistic path on a minimum interval (e.g. wall-clock ms) *and/or* a minimum number of newly-completed groups since the last flush, instead of "once per input generation." Genuine `JXL_DEC_FRAME_PROGRESSION` events (`bridge.cpp:2145`) should still flush immediately; only the *opportunistic* NEED_MORE path needs throttling. Expected: 59 renders → ~5–8 renders, i.e. roughly an order-of-magnitude speedup. Must preserve the small-image guarantee (still flush at least once when the stream closes / on real progression).

2. **Make the steady chunk size adaptive to encoded size.** 32 KB on a 2.19 MB stream is ~67 chunks. Scale `STEADY_DECODE_CHUNK_BYTES` (e.g. target a bounded number of steady chunks, or grow geometrically like the first-paint ramp) so large images don't get over-sliced. Keep small chunks early for fast first paint, then coarsen. Cheap, and directly cuts render count.

3. **Skip the redundant full-buffer memcpy when nothing new was committed.** `TryFlushProgressiveImage` always copies 82 MB even if `FlushImage` committed no new groups. Track a "groups committed since last flush" counter and early-return when zero. Avoids wasted ~82 MB copies on no-op flushes.

4. **Avoid the double 82 MB hand-off where possible.** The bridge copies `pixels → flushed`, then JS takes `flushed` out. For intermediate (non-final) passes the UI only needs the latest snapshot; investigate whether intermediate flushes can hand off a single buffer (or a downsampled preview) rather than a full-res 82 MB copy each pass.

5. **Confirm the SIMD/threaded WASM variant is actually being used.** `dist/` ships `scalar`, `simd`, `simd-mt`, `relaxed-simd-mt`. `FlushImage` of 20 MP on the scalar build is ~1 s; SIMD+threads is several× faster. Threaded variants need COOP/COEP (SharedArrayBuffer) — verify the page is serving those headers and the capability cache (`facade.ts`) is selecting `relaxed-simd-mt`, not silently falling back to `scalar`. A scalar fallback would explain part of the absolute per-render cost.

6. **Lower `progressiveDetail` for large images.** `'passes'` (kPasses) is the most granular. `kLastPasses` or `kDC` reduces the genuine progression events and, combined with (1), the total render count — at the cost of fewer intermediate previews. This is a UX/perf tradeoff worth measuring.

7. **(Bigger) Region/downsampled intermediate render.** For intermediate passes, render a downscaled preview rather than full 20 MP, reserving the full-res render for the final image. libjxl supports skip/downsample on flush in some configurations; needs verification against the bridge's buffer contract.

## Verification Notes

- Findings derived from static read of `web/jxl-single-progressive.js`, `packages/jxl-wasm/src/bridge.cpp`, `packages/jxl-wasm/src/facade.ts`, cross-checked against the TOON run table.
- Not yet reproduced under an instrumented build (no per-flush timing counters added). **Recommended next step before fixing:** add temporary timers around `JxlDecoderFlushImage` and the two memcpys, plus a counter of flushes vs. genuine `FRAME_PROGRESSION` events, to quantify exactly how many renders are wasted. This is the multi-component evidence step (chunk feeder → bridge flush gate → libjxl render → JS hand-off) before committing to fix #1.
