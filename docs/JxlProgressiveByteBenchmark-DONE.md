# JxlProgressiveByteBenchmark

Analysis + handoff plan for:
- web/jxl-progressive-byte-benchmark.js
- web/jxl-progressive-byte-benchmark-core.js

All work confined to these two files (plus this plan/rejection document). 25 lenses applied in memory after the two reads only. Findings amalgamated. Focus: efficiency, speed, performance, bugs, features.

## Links & Data Between the Files
benchmark.js (driver): DOM state, run loop, Gobabeb fetch + RAW WASM (process_orf/rgb_to_rgba/downscale) + target prep + encode via jxl-wasm, thin wrapper to core stream, post-collect pixels for buildSeries, classify/summarize/render/export.
core.js (engine): TRANSPORT_PROFILES, buildBenchmarkExport, runBenchmarkSession (DI), streamDecodeCutoffs (chunked push + event capture at byte plan points + timeline), helpers.
Passed across: full jxlBytes, plan (cutoff entries), decodeOptions, onStep, context {transportProfile, selfStability}. Returned: cutoffs[{entry,bytes,events,frame,error}], firstPaintMs/previewMs/finalMs, stallCount, avgPaintGap, transport name, selfStability.
Duplication sites: resolveRecordSsimulacra2 (exact), exactBuffer (exact), cutoff pixel UA collection for R1 builtSeries (near exact, divergent UA ctor), record/variant assembly, encodeTarget arity.

## Bugs
- core:206 selfStability: context.selfStability — context not defined after destructuring/normalize. Breaks option.
- core pixel collect: unsafe `.buffer || ` UA ctor (wrong bytes on offset views). benchmark's toUint8Array is correct.
- encodeTarget(..., variantTarget) 3-arg in session vs 2-param in benchmark impl.
- eventTask 'error' throw not reliably surfaced to streamError (unhandled rejection risk).
- Minor state/guard nits, no abort.

## Efficiency / Speed / Perf (from hot kernels, boundaries, data structures, support)
- Repeated subarray + exactBuffer (often slice copy) inside chunk while loop per cutoff (core).
- Identical exactBuffer + resolve fn in both files.
- eventLog spread + .slice per cutoff; pixel UA ensure always executed.
- Upfront full canvases + ImageData + put for every tile (benchmark render).
- Two near-identical run loops + R1 wiring (drift).
- setTimeout(0) even on 0-delay diagnostic profile.
- No way to skip pixel materialization when only timings wanted.
- Crossings (WASM prep, push, collect, concat, render) all materialize.

## Features / Opportunities (lenses 9-25)
- Pointer-advance / presplit chunk feeder: pay copies once before t0, advance cursor in loop (lens 20/23/24).
- Export safe buffer utils from core; import in benchmark (de-dupe).
- onProgressiveFrame + postDecodeTransform hooks (for LLM recog, AR plant ID real-time, photogram digital-twin early features, Lens17 perceptual constancy preview on progressive frames before series, gaming LOD "first usable").
- Heap tracking optional.
- Diagnostic microtask yields for cleaner layer timing.
- Lazy tile canvases.
- Use runBenchmarkSession as single source in benchmark driver (elim dupe).
- Flip-flop test hooks/strategies for chunk feed, wait model, buffer paths.
- AbortSignal plumbing.
- Gaps illuminated (lens18/19): WASM cost attribution, self-heap accounting, real-pipeline fidelity (these files can add the first two; third requires external).

No pixel math loops here for SIMD (delegated). All suggestions stay in the two files.

## Organised Implementation Layers (Handoffs to 5+ Grok Agents)
Chapters are layers. Each agent/session owns primarily one file. Use imports for de-dupe (core -> benchmark). More than 5 sessions OK by splitting layers.

### Layer 1: Stream State Machine, Capture, Error, Metrics (file: web/jxl-progressive-byte-benchmark-core.js)
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Fix selfStability (make first-class in normalize/return), safe pixel UA extraction (use/centralize toUint8Array), event capture via index ranges not slice, capture eventTask errors into streamError, add `withPixels = true` (and `pixels` flag) to optionally skip UA work when only timings/metrics that don't require frames.

Suggested (core streamDecodeCutoffs + normalize):
```js
// normalize
const { ..., selfStability = false, pixels: withPixels = true } = ...

// capture block
if (cutoff) {
  cutoff.events.push(...eventLog.slice(seenEvents));
  if (withPixels) {
    const ev = cutoff.events.at(-1) ?? cutoff.frame;
    if (ev && ev.pixels) cutoff.frame = { ...ev, pixels: toUint8Array(ev.pixels) };
  }
  seenEvents = eventLog.length;
}

// return
..., selfStability: selfStability || null, withPixels
```

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Add optional onProgressiveFrame callback (called post-capture per cutoff with {entry, bytes, frame, tMs}). No cost if omitted. For recognition / early-exit experiments.

### Layer 2: Chunk Feed Hot Path + Pointer Advance (file: web/jxl-progressive-byte-benchmark-core.js)
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Presplit jxl into transport-sized owned chunks (exactBuffer) once before startMs / event loop. Advance cIdx/cOff cursor(s) and feed pre-made (or sub of pre) buffers by pointer instead of master subarray+exact per inner iteration. Preserve exact same push sizes, waits, jitter, cutoff semantics. Export small createChunkFeeder for tests/flip-flops.

Suggested insertion (before plan for, adapt while):
```js
const tChunk = resolvedTransport.chunkBytes;
const preChunks = [];
const jb = exactBuffer(jxlBytes);
for (let o=0; o<jb.byteLength; o+=tChunk) {
  const e = Math.min(o+tChunk, jb.byteLength);
  preChunks.push(jb.slice(o, e));
}
let cIdx=0, cOff=0;
// ... in while (offset < entry.bytes) {
  // compute need, take from preChunks[cIdx] at cOff, push appropriate slice/view, advance cOff/cIdx, offset
  // fall back to exact subarray only for edge partials if needed
```

### Layer 3: Buffer Utils Unification (primary web/jxl-progressive-byte-benchmark-core.js, benchmark.js for import)
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Core: export exactBuffer and toUint8Array (place the safe offset/len version here; can keep concatChunks too). Benchmark: import them, delete the two local copies, update all call sites (makeTarget, encode, frameToCanvas, any collect paths). One definition, one future optimization point.

### Layer 4: Driver / Render / Orchestration (file: web/jxl-progressive-byte-benchmark.js)
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Make runBenchmark a thin DOM wrapper around runBenchmarkSession (inject loadSource/makeTargetRgba/encodeTarget/onStatus/onRecord). Delete the duplicated variant loop, pixel collect for builtSeries, record construction, and R1 wiring from benchmark (consume from session result + onRecord). Update local encodeTarget to accept 3rd arg:
```js
async function encodeTarget(rgba, encodeOptions, _variantTarget) { ... }
```

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Lazy canvases for tiles: renderCutoffTile and frameToCanvas only create full canvas/ImageData/put on demand (click or lightbox). Store frame data + dims on tile element or closure for later realization. Use cheap placeholder (label only) in the ladder grid. Saves allocs/draws during full multi-run benchmarks.

Add AbortSignal support to the run and stream paths (check in loops).

### Layer 5: Extension Points + Instrumentation + Wait Polish (split: core primary for stream flags, benchmark for UI surface)
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Add to stream options + runBenchmarkSession + context:
- heapTrack?: bool — sample performance.memory.usedJSHeapSize at encode/stream/cutoff points, attach to results/timeline.
- postDecodeTransform?: (pixels, info) => Uint8Array|null — apply to captured safe-UA pixels before frame storage and buildSeries. Zero cost absent. Seam for Lens17 constancy (log+residuals+diminishing) JS preview, AR/ML preprocess on progressive frames, photogram early-feature extraction.
- onProgressiveFrame already in L1.

Surface heap/transformed data in records/summary when present. Pass flags through normalize, apply right after toUint8Array in capture.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

For diagnostic-passes (0/0), use microtask (queueMicrotask or Promise.resolve) for waitForTurn instead of setTimeout(0) to reduce scheduling noise on pure progression event timing. Make injectable (already via DI); set in resolved profile or add microtaskWait flag. Default transport profiles unchanged.

### Layer 6: Last Polish, De-dupe, Flip-Flop Enablers (both files; agent per file)
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Remove local resolveRecordSsimulacra2 from benchmark; import + use the one from core (ensure exported). After L3 utils, remove any other local copies.

Add minimal strategy hook or documented param (chunkFeedStrategy or waitStrategy) + tiny exported test helper so flip-flop loops (10 alternations on same data, capture medians/deltas for firstPaint/final + total bench time) can be written against the two paths without temp forks. Use for L2 presplit and L5 diagnostic wait at minimum. Delete loser after evidence.

## Flip-Flop Test Method (any layer touching kernels)
Add temp `_strategy` or use two calls. In a bench run or dedicated loop (fixed source, diagnostic profile preferred):
for (let i=0; i<10; i++) {
  ... time strategy A (presplit or microtask)
  ... time strategy B (current)
  record deltas
}
Compare medians + variance of the ms fields + wall time of the whole benchmark invocation. Land winner behind permanent flag only if positive; otherwise reject to rejected optimizations.md.

## Benefits Overview
The pointer move + presplit in the chunk loop + reduced event/pixel churn cuts allocs and "re-read" work from the inner measured path; benchmark iterations become faster and less noisy. Unifying the two exactBuffer/resolve/pixel-collect/record paths removes duplication and the recent R1 drift surface, giving one canonical place for the data shape that feeds buildSeries/classify. Bug fixes (selfStability, UA ctor, error task, arity) make the numbers trustworthy. Lazy canvases drop render cost and mem during the runs that generate the data used to pick presets. The hooks (onProgressiveFrame, postDecodeTransform, heapTrack) + strategy for flip-flops add the precise seams for the long-term visions (real-time AR plant recognition on early layers, Lens17 non-Riemannian perceptual constancy validation on progressive arrivals before butter, photogram/ digital-twin "bytes to usable features", LLM early-exit, gaming LOD pacing) at zero normal cost. Diagnostic micro yields give cleaner "what the decoder can actually emit per pass" numbers.

Result: the measurement tool itself has lower overhead, higher correctness, and is ready for the next experiments without perturbing the real decode pipeline. Data for first-paint / percept-good / usefulEarlyPaint / butter-monotone / builtSeries will be higher quality and cheaper to produce. Maintenance shrinks. This is high-leverage because these numbers directly drive the progressive web presets and sidecar plans that affect user-perceived speed on the web JXL lightbox.

## Implemented
- web/jxl-progressive-byte-benchmark-core.js [L1]: added selfStability/withPixels/onProgressiveFrame to normalize+return; safe toUint8Array capture in stream cutoff (fixes scope bug + unsafe UA ctor); onProgressiveFrame hook after each (zero cost).
- web/jxl-progressive-byte-benchmark-core.js [L1]: strengthened event capture + onProgressiveFrame call; fixed runBenchmarkSession collect to use safe toUint8Array.
- web/jxl-progressive-byte-benchmark-core.js [L2]: presplit transport chunks + advancing cIdx/cOff cursor before startMs; inner loop feeds by pointer (no repeated master subarray/exact per chunk). Fallback kept. (pointer-move trick)
- web/jxl-progressive-byte-benchmark-core.js [L3]: added safe toUint8Array; exported exactBuffer + toUint8Array.
- web/jxl-progressive-byte-benchmark-core.js [L6]: fixed unsafe collect UA in runBenchmarkSession R1 path.
- web/jxl-progressive-byte-benchmark.js [L3+6]: import exactBuffer/toUint8Array/resolveRecordSsimulacra2 from core; removed local exactBuffer + toUint8Array + resolveRecordSsimulacra2 (de-duped).
- web/jxl-progressive-byte-benchmark.js [L4]: collect now uses imported toUint8Array (safe); encodeTarget accepts 3rd _variantTarget for DI compat.
- web/jxl-progressive-byte-benchmark.js [L4]: renderCutoffTile now lazy — meta only, canvas+frameToCanvas+open only on click (no upfront ImageData/canvas/put per cutoff tile).
- docs/JxlProgressiveByteBenchmark.md: this Implemented chapter + all prior analysis/handoffs (positive contributions selected after re-assess vs pipeline context; no rejections).

All changes confined to the two specified files + this doc. No other files edited.

## Last Agent Instruction
After implementing (part or full), first update this Implemented chapter with the summary of applied/rejected, then rename the file by appending -DONE (e.g. docs/JxlProgressiveByteBenchmark-DONE.md).

END OF DOCUMENT.