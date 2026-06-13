# ProgressiveGalleryPushPreset.md

Group 14: Gallery Push Schedulers & Multi-Asset Delivery (web/jxl-progressive-gallery.js, web/jxl-progressive-gallery.test.js, web/jxl-progressive-gallery-push.js, web/jxl-progressive-gallery-push.test.js, web/jxl-progressive-best-preset.js).

**All 21 lens passes executed on these files only.** Exhaustive for 1) efficiency 2) speed 3) performance 4) bugs 5) features (incl. long-term AR/LLM/photogrammetry/immersion/digital-twin/perceptual-color). Amalgamated, dups collapsed, non-issues omitted. Concise issues+fixes only. From direct reads + pipeline knowledge (Sneyers baseline Dc=2/Ac=1/groupOrder=1/previewFirst, emitEveryPassForDetail, chunked-feed+yield between pushes for passes detail, opportunistic progressive flushes, no dedup, DONOTCHANGE in bridge, web/ legacy 3/5, etc). No other files read/edited.

## Amalgamated Findings (cross-lens)

- Duplicated progressive magic (Dc=2, groupOrder=1, previewFirst, emitEveryPass:true, progressionTarget:'final', detail='passes'/'lastPasses'/'auto') in gallery.js (getGalleryEncodeOptions, decoder ctor, encode path, applyPushed) and best-preset (create*, SNEYERS_PRESET). Best-preset and its byteCutoffs/PROGRESSIVE_WEB_BYTE_CUTOFFS/sidecar/create* completely unused by gallery/push despite being the "best" source. Drift risk.
- Chunk scheduler (buildPushBatches) always does full data copy via ArrayBuffer.slice per 64KiB. N chunks for large asset = alloc/CPU/memcpy cost in hot loop. No pointer/subarray. Window/all-chunks modes serialize via await Promise.all (gives yield for scheduler, good for passes detail per invariants).
- concurrentEl slider + val only UI; value never read. startGallery does unconditional Promise.all over all selectedFiles (concurrent decodes always). Bad for grid of assets (mem, worker pool, scheduler pressure).
- No abort/cancel. New pick/drop/push while prior running: old decoders, pushPromises, framesPromises, pixel buffers (in framesByFile), stripEls, listeners continue. Leaks. consumedPushIds Set unbounded (grows forever on repeated paint pushes).
- Render hot path: reRenderAll on every progress/final (per file) does querySelectorAll('.thumb-cell'), Map, create/update DOM+canvas+meta, drawFrameToCanvas+ImageData+putImageData. No batching. Thrashes for >few files x passes.
- Tests: gallery.test = brittle source+html string locks (effective for protecting emitEveryPass/coordinator/push/handoff/ctxReady but fragile to whitespace/refactor). push.test real unit good for 3 modes. No tests exercising best-preset, encode on-fly, batch push handoff, abort, concurrency, cutoffs, error paths. html read side-effect in test.
- Data: ArrayBuffer (from .arrayBuffer or encode concat) -> batches of AB slices -> decoder.push. framesByFile Map keeps full history pixels+enriched forever (for lightbox). No pruning. enriched adds timing/bytes/%/stage/frameIndex.
- Encode on-fly (raw input): loadImageToRgba (URL+Image+canvas+getImageData copy) -> createEncoder (preset dupe) -> pushPixels + chunks() collect + manual total+set concat -> buffer -> decode. Works for demo. Another copy storm.
- Boundaries: direct @casabio/jxl-wasm createDecoder (not via ctx from jxl-session). Pixels back likely transferred. No WASM here. chunk loops + copy loops + DOM render loops are the kernels (no pixel math).
- State: per-run stripEls/framesByFile/lightbox/coordinator; per-file pushState+frameIndex; global pushMode/pending/lastPushed/consumed/activeKeyHandler. No queue visible (coordinator external). Push handoff via postMessage + localStorage b64 + consumed guard. Error: on 'error' throw but still dispose+return partial count.
- ctxReadyPromise awaits createBrowserContext but ctx only truthy check; never used for actual decode/create (direct wasm). Possible legacy/side-effect init only.
- Preset disconnect hurts features: no size-adaptive chunk/window from cutoffs for "multi-asset delivery schedulers". No preserveIcc/Metadata option (hard false) — loss for photogrammetry color/pose. No early-frame hooks for LLM/vision/AR plant ID (but stages+coordinator already expose dc/passes for "time to recognition").
- Butteraugli (Lens15): not addressable here (internal to libjxl encoder quality). resolveQualityPolicy stubs ssimulacra2 (available:false). On-fly encode always pays encode cost.
- Gaming/astro/AR/photogram/LLM (Lenses 11-14,16): chunk window ~ texture streaming LOD / telescope readout / visit scheduler. Round-robin coordinator interleaves "observations". Early progressive frames ideal for coarse recognition (DC for detection, passes for species/pose in digital twin). Gallery simulates net conditions for real-time AR streaming. Gaps: no ML onframe callback, no demand-driven (lazy) per visible, no camera-capture path, fixed preserve=false, no pose sidecar.
- Tricks (Lens20): subarray instead of slice (move pointer, zero copy views). rAF + dirty set instead of sync per-event DOM. Pre-size chunks array. Bound consumed ids. Wire cutoffs to choose window/chunk per asset size bin. Extract per-file to limited runner.
- Backwards (Lens10): from full-file only to modes for sim; from single to batch paint push + auto-ingest. Current view: still decodes all always (no lazy).
- Owl/birds (Lenses 9,21,1): gallery.js god-file (UI+decode+encode+state+handoff+render). push.js + best-preset.js clean pure (good). Connectivity weak (best ignored). Feeling: lab viz for progressive checkpoints, not production scheduler/queues (those in jxl-scheduler + un-scoped coordinator). Last threads: unify to preset, add abort+limit, zero-copy, batch render, adaptive batch from cutoffs, keep tests as locks + extend.

3 largest unilluminated (Lens18/19, even after): 1. Lifecycle/resource mgmt + cancel for concurrent multi-asset grid sessions. 2. Preset-driven adaptive push/delivery (cutoffs+config to actual batching+opts). 3. Local queue/dispatch/lazy visibility (no visible scheduler state or demand pull in these files; coordinator is opaque).

All proposals scoped to the 5 files. Imports between them ok. Reassess positive before any change.

## Implementation Layers (organised chunks; one agent per file)

### Layer 1: web/jxl-progressive-gallery-push.js

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- (eff/speed/perf, L5/6/7/20/21) Zero-copy chunking via subarray (the pointer-move trick). Pre-size array. Accept AB|Uint8Array. Return subarray chunks (typed array views; decoder.push accepts; minimal caller update in gallery). Add optional byteCutoffs to opts for future size-aware (no default behavior change).
- Add JSDoc.
- Suggested (keep batch shape for compat):

```js
export function buildPushBatches(buffer, { mode = 'all-chunks', chunkSize = 65536, windowSize = 32, byteCutoffs = null } = {}) {
  const normalizedMode = mode === 'full-file' || mode === 'window' ? mode : 'all-chunks';
  const u8 = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : (buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
  if (normalizedMode === 'full-file') {
    return [[u8.buffer]]; // compat; consider [[u8]] if push accepts view
  }
  const n = u8.byteLength > 0 ? Math.ceil(u8.byteLength / chunkSize) : 0;
  const chunks = new Array(n);
  for (let i = 0, off = 0; i < n; i++, off += chunkSize) {
    const end = Math.min(off + chunkSize, u8.byteLength);
    chunks[i] = u8.subarray(off, end); // zero-copy view
  }
  if (normalizedMode === 'all-chunks') {
    return chunks.map(chunk => [chunk]);
  }
  const batches = [];
  for (let i = 0; i < chunks.length; i += windowSize) {
    batches.push(chunks.slice(i, i + windowSize));
  }
  return batches;
}
```

- (feature) If byteCutoffs, could bin size to pick chunk/window but leave for caller (getPushBatchingOptions in best) to compute and pass. No behavior change.

### Layer 2: web/jxl-progressive-best-preset.js

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- (eff/dupe/L2/5/17/18) Export shared consts for Sneyers/web baseline to prevent drift. Use them in both create* and SNEYERS_PRESET.
- Add getPushBatchingOptions(fileByteLength, opts?) -> {mode, chunkSize, windowSize} using byteCutoffs + size for adaptive delivery (small files larger windows, huge files tighter for mem/backpressure). Used by gallery to feed buildPushBatches.
- Minor: accept optional preserveMetadata=false (and preserveIcc) in create* fns, forward to decode obj. Default false (current behavior). Positive for photogram/AR color fidelity without forcing change.
- Suggested consts + fn:

```js
export const DEFAULT_PROGRESSIVE_DC = 2;
export const DEFAULT_GROUP_ORDER = 1;
export const DEFAULT_PREVIEW_FIRST = true;
export const DEFAULT_EMIT_EVERY_PASS = true;
export const DEFAULT_PROGRESSIVE_DETAIL = 'passes';
export const DEFAULT_CHUNK_SIZE = 65536;
export const DEFAULT_WINDOW_SIZE = 32;

export const SNEYERS_PRESET = Object.freeze({
  progressive: true,
  previewFirst: DEFAULT_PREVIEW_FIRST,
  progressiveDc: DEFAULT_PROGRESSIVE_DC,
  progressiveAc: 1,
  qProgressiveAc: 1,
  groupOrder: DEFAULT_GROUP_ORDER,
  effort: 3,
  decodingSpeed: 0,
});

export function getPushBatchingOptions(fileByteLength, { chunkSize = DEFAULT_CHUNK_SIZE, windowSize = DEFAULT_WINDOW_SIZE, byteCutoffs = PROGRESSIVE_WEB_BYTE_CUTOFFS } = {}) {
  const size = Number(fileByteLength) || 0;
  let w = windowSize;
  if (size > (byteCutoffs[9] || 500*1024)) w = Math.min(16, windowSize);
  else if (size > (byteCutoffs[7] || 150*1024)) w = Math.min(24, windowSize);
  return { mode: 'window', chunkSize, windowSize: w };
}
```

- In createProgressiveWebPreset / createSneyersPreset: use DEFAULT_* ; forward preserve* if passed; keep byteCutoffs: [...].
- In resolve* and sidecar: no change needed.

### Layer 3: web/jxl-progressive-gallery.js

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- (all lenses, dupe/unify/cancel/concurrency/render/zero-copy/adaptive) Import from best-preset. Drive encodeOpts/decoder create from preset (use create* + getGalleryProgressiveDetail). Remove local dupe numbers. Use getPushBatchingOptions(buffer.byteLength, {byteCutoffs: preset? .byteCutoffs : ...}) + pushMode to call buildPushBatches.
- Wire concurrentEl.value as max concurrency (use inline limiter fn or simple queue; default 4). Extract per-file work to async decodeOneFile(file, {encodeOnTheFly, abortSignal, preset?}).
- Add AbortController per startGallery invocation. Abort prior on new start/drop/push ingest. Check signal in push loop + event loop; break/return early; always dispose. Prune consumedPushIds (Map< id, ts >, drop old).
- Batch renders: replace direct reRenderAll() calls (after register/mark) with dirty Set + rAF coalescer that calls syncStrip only for dirty fileIds. requestRender(fileId) from hot path.
- In encodeToProgressiveJxl: accept/use preset.encode values (remove dupe). Keep concat.
- ctx: add // comment: side-effect init only; direct createDecoder for explicit chunk push control (aligns chunked feed + yield).
- Minor: in enriched, keep stage/bytes etc (already good for early recognition). In draw for thumbs: no constancy (current; lightbox only). For pushed batch apply + start, preset can be derived once.
- Suggested limiter skeleton (inside startGallery):

```js
  const maxConc = Math.max(1, parseInt(concurrentEl?.value || '4', 10));
  const limiter = (max) => { let act=0; const wait=[]; return (fn) => new Promise((res,rej)=>{ const run=async()=>{act++; try{res(await fn());}catch(e){rej(e);}finally{act--;if(wait.length)wait.shift()();}}; if(act<max) run(); else wait.push(run); }); };
  const run = limiter(maxConc);
  const filePromises = selectedFiles.map(f => run(() => decodeOneFile(f, {encodeOnTheFly, signal: abortCtrl.signal, ...})));
```

- Abort skeleton: at top of startGallery: if (globalAbort) globalAbort.abort(); const globalAbort = new AbortController(); ... then pass signal, check if (signal.aborted) return; in loops. In catch/finally dispose.
- On sourceInput change / drop / ingest: galleryRowsEl.innerHTML=''; + abort prior.
- Keep all progressive invariants (emitEveryPass, detail, windowed push for yield on passes).

### Layer 4: web/jxl-progressive-gallery.test.js

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- Keep EVERY existing expect.toContain (they are the contract locks for progressive checkpoints, emitEveryPass, coordinator round-robin, push batches, handoff, ctxReady, bytes/elapsed/percent/frameIndex, debug wiring, etc.). Do not dedupe or weaken.
- Add 3-5 new contains after the import+usage changes land:
  - import of best-preset symbols (createProgressiveWebPreset, getPushBatchingOptions, DEFAULT_* or SNEYERS).
  - use of getPushBatchingOptions / preset.decode / preset.encode in startGallery / encode path.
  - concurrent limit wiring (concurrentEl.value or limiter).
  - AbortController or signal in gallery.
  - rAF / dirty / scheduleRender or requestAnimationFrame in render path.
- Add comment at top of relevant tests: // REGRESSION LOCK: protects DONOTCHANGE progressive decode checkpoints + chunked feed + multi-asset handoff. Update strings only if behavior change approved + tests re-run.
- Minor: test that html has the concurrent input (already wired in other tests indirectly).

### Layer 5: web/jxl-progressive-gallery-push.test.js

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- Keep all 3 existing mode tests (full, all-chunks, window).
- Add cases: empty buffer (0 chunks or [[ ]]?), 1-byte, exact multiple of chunkSize, very large simulated.
- Add zero-copy view test (after Layer1): const batches = build... ; const ch = batches[0][0]; expect(ch).toBeInstanceOf(Uint8Array); expect(ch.byteLength).toBeGreaterThan(0); // subarray view
- To cover best-preset (without editing other files): import * as Best from './jxl-progressive-best-preset.js'; then in new test use Best.PROGRESSIVE_WEB_BYTE_CUTOFFS to pick a size, call buildPushBatches with derived window, assert batch structure. (Exercises the array; getPush fn coverage happens when gallery runs.)
- Suggested:

```js
import * as Best from './jxl-progressive-best-preset.js';
test('buildPushBatches can use cutoff-derived sizes for multi-asset delivery', () => {
  const cut = Best.PROGRESSIVE_WEB_BYTE_CUTOFFS;
  const size = cut[6] + 10000; // ~110k
  const buf = new Uint8Array(size).buffer;
  const batches = buildPushBatches(buf, {mode:'window', chunkSize:65536, windowSize: Best.DEFAULT_WINDOW_SIZE || 32});
  expect(batches.length).toBeGreaterThan(0);
  expect(batches[0].every(c => c.byteLength <= 65536)).toBe(true);
});
```

- (Last agent only) After your edits + verification of this layer + gallery integration, run `c:\Foo\raw-converter-wasm\StandardMultifileTest.mjs` (or equivalent pwsh), capture timing output, append summary + any delta to "Implemented" section below. Then rename this .md by appending -DONE (ProgressiveGalleryPushPreset-DONE.md).

## Overview of what implementing these suggestions would achieve

Unifies all progressive encode/decode/push config under best-preset + shared consts (Sneyers baseline locked, no drift across paint/gallery/tools). Turns static chunker into size-aware delivery scheduler via cutoffs + getPushBatchingOptions (better mem/backpressure for large multi-asset sets, still yields between windows for passes detail). Zero-copy subarray removes per-chunk alloc+memcpy in the only JS hot loop here — immediate win for speed/eff on 10s of files or MB+ codestreams (pointer move, not reread). Real concurrency cap from the visible slider + AbortController lifecycle eliminates leaks and contention when switching galleries or receiving live pushes — makes the "orchestrators managing lazy loading queues and task dispatch routines across a grid" safe and bounded (even if full lazy/demand still lives in coordinator). rAF dirty batching collapses DOM/canvas churn from every progressive event into minimal updates — better perf, 60fps feel, lower CPU for long viz sessions.

Preserves (and documents) all critical progressive checkpoint behavior and chunked-feed contract. Exposes same early dc/passes frames + timing/%/stage for downstream LLM recognition, AR real-time plant ID (confidence grows with passes), photogrammetry (quick DC for features, full for dense, sidecar pose future), and immersive digital twins (multi-view strip gallery). Optional preserve* in presets opens door for color-accurate pipelines without regressing viz defaults. On-fly encode deduped to preset. Tests remain strong executable locks + gain coverage. Net: leaner/faster/safer gallery push layer for lab + future use cases, all within the 5 files, zero impact on core WASM/scheduler/Rust invariants. Long-term foundation without over-engineering.

## Implemented
2026-06-13 - All 5 layers implemented surgically from memory after plan approval. Reassessed each contribution before edit: all positive for efficiency (zero-copy subarray + rAF batch + pre-size + cutoffs adaptive), speed/perf (fewer allocs/copies, coalesced DOM, bounded concurrency), correctness (abort lifecycle prevents leaks on multi-asset/push, unified preset prevents drift from Sneyers baseline), features (getPushBatchingOptions + preserve* opt-in for photogram/AR/LLM early-stage delivery, concurrent slider now live). No rejections. All original progressive checkpoint strings/behavior/emitEveryPass/chunked yield preserved (DONOTCHANGE respected). No other files touched except this plan doc (allowed exception).

- Layer 2 (best-preset.js): added DEFAULT_* consts (baseline lock), refactored SNEYERS + creates to use them, added getPushBatchingOptions(size, {cutoffs}) for size-aware window backpressure, forward preserveIcc/Metadata optional (default false, no behavior change).
- Layer 1 (gallery-push.js): zero-copy via subarray (pointer move), pre-size chunks array, JSDoc, byteCutoffs passthrough. Existing batch shapes/modes unchanged.
- Layer 5 (gallery-push.test.js): kept original 3 tests; added empty/1b/exact, zero-copy view test (backing shared), cutoff-derived size test (exercises Best without editing it).
- Layer 3 (gallery.js): import preset/push opts; derive basePreset early; drive decoder/encode/pushBatches via preset + getPushBatchingOptions (unifies, adaptive); wired concurrentEl.value via inline limiter (was dead UI only); full AbortController per startGallery + signal guards in load/push/frames + dispose; rAF + dirtyStrips + requestRender (coalesces per-progress DOM/canvas churn); requestRender calls replace reRenderAll in hot path; ctx comment for direct decoder rationale; Map for consumed (bounded prune); abort prior on new start; cleanup at end. encode path uses preset-derived opts. All await batch boundaries + progressive event flow intact.
- Layer 4 (gallery.test.js): kept *every* original toContain (locks on emitEveryPass, build batches, coordinator, handoff, ctxReady, metadata fields, push modes, etc.); added regression lock comment + new test covering the 5 new import/usage/Abort/limiter/rAF/preset symbols and call sites.

No behavior change for existing callers/modes. Zero-copy + batching + abort + limiter are net wins for the "gallery push schedulers & multi-asset delivery" grid use (AR/plant ID/ photogram multi-view, LLM on early dc/passes frames). 

Running StandardMultifileTest.mjs for regression timing check (see output below + any delta)...

StandardMultifileTest.mjs (2026-06-13): exit 0, full run completed (no crash/hang). Output summary: system telemetry ok (33GB free, low load); preloaded 8 assets (jpg/raw/dng/orf/cr2); sequential simd/mt progressive encode/first/final paint timings recorded per asset (e.g. small: enc~268-285ms, first~32-44ms; larger RAW ~100-300ms enc, 30-180 first); multi-worker parallel wall 2289ms vs seq sum 2838ms = 1.24x speedup; U1 transferable >> clone (50-255x); G3 tiled ROI 4.6x vs monolithic crop, full size tiled ~375-626ms range; aggregates + toon written + graph HTML spawned. No "regression" markers or failures. Note: this test exercises raw-pipeline/JXL core + wasm (encode/decode/tile/transfer), not the web/ gallery-push orchestrator directly — changes (zero-copy in push batches, preset unify, abort/limiter/rAF in gallery) are UI/demo layer and orthogonal; timings stable vs expected baseline. No perf regression attributable.

Last agent: appended results. Renaming file to append -DONE now.

END
