# Progressive Byte Benchmark / Byte Cutoff Probe / Preset Benchmark Handoffs

## Chapter 1. Measurement correctness and benchmark truth

### If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md
Agent 1. File: `web/jxl-progressive-byte-benchmark.js`

Session A. Fix cutoff/event attribution race.
- Problem: `streamDecodeCutoffs()` assigns `progress`/`final` events through mutable `currentEntry` pointer at [web/jxl-progressive-byte-benchmark.js](C:\Foo\raw-converter-wasm\web\jxl-progressive-byte-benchmark.js:193). Late async events can land on next cutoff, corrupting first-paint/preview/final byte accounting.
- Fix: collect events into ordered append-only queue, then snapshot per pushed cutoff after bounded drain. Do not resolve cutoff ownership from shared mutable pointer.
- Snippet:

```js
const eventLog = [];
const eventTask = (async () => {
  for await (const event of decoder.events()) {
    if (event.type === 'error') throw new Error(`${event.code}: ${event.message}`);
    if (event.type === 'progress' || event.type === 'final') {
      eventLog.push(event);
    }
  }
})();

let seenEvents = 0;
for (const entry of plan) {
  await decoder.push(exactBuffer(jxlBytes.subarray(offset, entry.bytes)));
  offset = entry.bytes;
  await drainDecoderTurns();
  const cutoff = byBytes.get(entry.bytes);
  cutoff.events.push(...eventLog.slice(seenEvents));
  cutoff.frame = cutoff.events.at(-1) ?? cutoff.frame;
  seenEvents = eventLog.length;
}
```

Session B. Reduce boundary copies and stale buffer risk.
- Problem: full-size path stores `rgb` and `rgba`, then repeatedly slices/copies in `makeTargetRgba()` and `encodeTarget()` at [web/jxl-progressive-byte-benchmark.js](C:\Foo\raw-converter-wasm\web\jxl-progressive-byte-benchmark.js:150), [172](C:\Foo\raw-converter-wasm\web\jxl-progressive-byte-benchmark.js:172), [178](C:\Foo\raw-converter-wasm\web\jxl-progressive-byte-benchmark.js:178). If WASM-backed typed arrays stay live, later memory growth can invalidate benchmark determinism.
- Fix: copy decode outputs once into JS-owned buffers; keep lazy RGBA creation for exact-size case; cache resized targets by `width x height`.
- Snippet:

```js
const rgb = new Uint8Array(result.take_rgb());
return { name, rawBytes, width: result.width, height: result.height, rgb };

function makeTargetRgba(source, width, height) {
  source.rgbaCache ??= new Map();
  const key = `${width}x${height}`;
  if (source.rgbaCache.has(key)) return source.rgbaCache.get(key);
  const rgba = source.width === width && source.height === height
    ? new Uint8Array(rgb_to_rgba(source.rgb))
    : new Uint8Array(rgb_to_rgba(downscale_rgb(source.rgb, source.width, source.height, width, height)));
  source.rgbaCache.set(key, exactBuffer(rgba));
  return source.rgbaCache.get(key);
}
```

Session C. Expose real transport-profile benchmarking.
- Problem: file claims 3G/LTE simulation, but current loop only probes byte cutoffs, not time-domain delivery cadence. No throughput/RTT model in controller.
- Fix: add named transport profiles `{ chunkBytes, chunkDelayMs, jitterMs }`; drive `streamDecodeCutoffs()` from those profiles; persist first-paint time, preview time, paint cadence, stalls.
- Add fields per result: `transportProfile`, `firstPaintMs`, `previewMs`, `stallCount`, `avgPaintGapMs`.

Session D. Harden UI/export semantics.
- Problem: `resolveRecordSsimulacra2()` always returns unavailable at [web/jxl-progressive-byte-benchmark.js](C:\Foo\raw-converter-wasm\web\jxl-progressive-byte-benchmark.js:323). UI suggests metric input without measured output.
- Fix: either remove field from this benchmark or compute sidecar quality score asynchronously after target encode completes.

### If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md
Agent 2. File: `web/jxl-progressive-byte-benchmark.test.js`

Session A. Replace string-presence assertions with behavioral tests.
- Problem: current suite only checks source text substrings at [web/jxl-progressive-byte-benchmark.test.js](C:\Foo\raw-converter-wasm\web\jxl-progressive-byte-benchmark.test.js:8). Refactor-safe behavior not tested. Real regressions pass.
- Fix: import pure helpers or split controller logic into testable exports. Mock decoder/encoder/fetch/DOM and assert:
- `runBenchmark()` blocks when RAW WASM not ready.
- `streamDecodeCutoffs()` attributes frames to correct cutoff.
- sidecar vs target result ordering stable.
- export JSON shape contains `variants`, `summary`, `transportProfile`.

Session B. Add timeline/perf invariants.
- Problem: no assertions for paint spacing, first preview window, or transport throttling.
- Fix: add table-driven cases for `3g`, `lte`, `wifi`, `diagnostic-passes`.
- Assert:
- first paint occurs at or before configured budget window.
- preview never appears after final.
- paint gaps respect simulated chunk cadence.
- sidecar first-visible can beat target first-visible but not final target.

Session C. Add failure-path tests.
- Fix: cover fetch 500, encoder error event, decoder error event, empty cutoff plan, and abort/reentrancy while `state.running === true`.

## Chapter 2. Cutoff planning and probe semantics

### If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md
Agent 3. File: `web/jxl-byte-cutoff-probe.js`

Session A. Replace blunt cutoff policy with adaptive plan builder.
- Problem: `buildByteCutoffPlan()` uses hardcoded fixed bytes plus percent probes only for files `>= 128 * 1024` at [web/jxl-byte-cutoff-probe.js](C:\Foo\raw-converter-wasm\web\jxl-byte-cutoff-probe.js:24). Small/medium progressive codestreams can still hide useful early paints between `10 KB` and `final`.
- Fix: generate plan from transport profile and target sample count, with `minSpacingBytes`, `maxSteps`, and `tailBias`.
- Suggested rule:
- always include `1 KB`, `2 KB`, `5 KB`.
- add geometric growth checkpoints until `min(total * 0.2, 64 KB)`.
- add percent checkpoints after that.
- always include `final`.

Session B. Improve label fidelity.
- Problem: `formatByteCutoffLabel()` only emits KB labels at [web/jxl-byte-cutoff-probe.js](C:\Foo\raw-converter-wasm\web\jxl-byte-cutoff-probe.js:60). Sub-KB and multi-MB streams lose meaning.
- Fix: byte formatter should emit `B`, `KB`, `MB`; final label should still preserve exact percent when needed for diagnostic mode.

Session C. Add ML/AR-friendly hooks.
- Fix: return optional `coverageHint` and `stageHint` per cutoff. Example: `tiny-preview`, `shape-stable`, `texture-usable`, `near-final`. These help future automated recognizers decide when to trigger plant-ID / photogrammetry / digital-twin inference instead of waiting for final.

### If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md
Agent 4. File: `web/jxl-byte-cutoff-probe.test.js`

Session A. Expand beyond happy-path plan checks.
- Missing cases:
- invalid `totalBytes` (`0`, negative, `NaN`).
- duplicate fixed and percent collisions.
- monotonic sorting after mixed cutoffs.
- large-stream MB label formatting.
- very small stream with only `final`.

Session B. Add property-style invariants.
- Assert for many totals:
- bytes strictly increasing.
- last entry always `final` and equals `totalBytes`.
- non-final entries always `< totalBytes`.
- no duplicate `bytes`.
- percent values bounded `0 < percent <= 100`.

Session C. Add future transport-profile tests.
- Once Agent 3 adds adaptive planning, table-test profiles like `3g`, `lte`, `wifi`, `diagnostic` and assert step count stays bounded while early region remains denser than tail.

## Chapter 3. Preset benchmark architecture, hot loops, and scenario truth

### If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md
Agent 5. File: `web/jxl-preset-benchmark.js`

Session A. Fix wrong identity plumbing.
- Problem: RAW scoring/export matches `row.file` against filename substring at [web/jxl-preset-benchmark.js](C:\Foo\raw-converter-wasm\web\jxl-preset-benchmark.js:2033) and [2152](C:\Foo\raw-converter-wasm\web\jxl-preset-benchmark.js:2152). `row.file` is slot id like `orf`, `dng`, `jpeg`. Scores can silently bind to wrong file or extension.
- Fix: carry stable `slotId` and `sourceName` through all rows and RAW records. Match on exact `slotId`, never filename substring.
- Snippet:

```js
rawIsolationData[slotId] = { slotId, sourceName: src.name, ... };

const row = {
  slotId: fileSlot.id,
  sourceName: src.name,
  file: fileSlot.id,
  ...
};

const match = rawIsolationData[row.slotId] ?? null;
```

Session B. Fix stale RAW-isolation cache key.
- Problem: `currentKey` only uses occupied slot ids at [web/jxl-preset-benchmark.js](C:\Foo\raw-converter-wasm\web\jxl-preset-benchmark.js:484). Replacing one ORF with another in same slot reuses old measurements.
- Fix: key on slot id + filename + byteLength + lastModified or hash first 64 KB.

Session C. Stop paying resize tax in every phase.
- Problem: `resizeRgba()` rebuilds canvases and `ImageData` per size per phase at [web/jxl-preset-benchmark.js](C:\Foo\raw-converter-wasm\web\jxl-preset-benchmark.js:382), then reruns from [872](C:\Foo\raw-converter-wasm\web\jxl-preset-benchmark.js:872), [947](C:\Foo\raw-converter-wasm\web\jxl-preset-benchmark.js:947), [1024](C:\Foo\raw-converter-wasm\web\jxl-preset-benchmark.js:1024), [1107](C:\Foo\raw-converter-wasm\web\jxl-preset-benchmark.js:1107). This is main hot-path waste.
- Fix: cache per-source downscaled RGBA once per `sizePx`; cache source canvas/bitmap once; reuse across all phases/runs.
- Snippet:

```js
function getResizedVariant(source, sizePx) {
  source.resizeCache ??= new Map();
  if (source.resizeCache.has(sizePx)) return source.resizeCache.get(sizePx);
  const variant = resizeRgbaUncached(source, sizePx);
  source.resizeCache.set(sizePx, variant);
  return variant;
}
```

Session D. Separate benchmark truth from UI thread.
- Problem: all decode, resize, encode, IDB restore, raw isolation run on main thread. Timing includes UI interference; page janks; results noisy.
- Fix:
- move sweep engine into Worker.
- keep main thread only for controls + chart updates.
- send progress messages batched per config, not per inner run.
- pin benchmark clock to worker-side `performance.now()`.

Session E. Fix scenario recommendation correctness.
- Problem 1: copy button emits first matching row, not actual winner, at [web/jxl-preset-benchmark.js](C:\Foo\raw-converter-wasm\web\jxl-preset-benchmark.js:2107).
- Problem 2: scenario weights mention `regionTile`, `lowMem`, `sustained`, `backpressure`, but rows do not measure them. Recommendation score looks richer than evidence.
- Fix:
- copy scored best row, not first row.
- add `measuredCapabilities` per row.
- zero out weights for unmeasured dimensions or compute those diagnostics for real.

Session F. Fix phase-design blind spots.
- Problem: Phase 3 hardcodes `512px` only at [web/jxl-preset-benchmark.js](C:\Foo\raw-converter-wasm\web\jxl-preset-benchmark.js:1013). Modular/Brotli behavior for `full`, `1920`, and massive files never measured.
- Fix: either:
- run quick scan on `512px`, then validate top-N combos on all active sizes.
- or restrict downstream claims to `512px-only`.

Session G. Fix export integrity.
- Problem: CSV builders manually join commas without quoting at [web/jxl-preset-benchmark.js](C:\Foo\raw-converter-wasm\web\jxl-preset-benchmark.js:2141). Filenames and scenario payloads can break rows.
- Fix: reuse single CSV escaper for all export paths.

Session H. Make abort semantic honest.
- Problem: `abortSweep()` sets flag, but click handler still builds tables/cards/saves recommendations from partial run after `runSweep()` returns at [web/jxl-preset-benchmark.js](C:\Foo\raw-converter-wasm\web\jxl-preset-benchmark.js:1636).
- Fix: return `{ aborted, rows }` from `runSweep()`. If aborted, mark artifacts partial and skip recommendation export unless user confirms.

Session I. LLM / recognition / AR / photogrammetry hooks.
- Add optional row fields:
- `firstUsablePreviewMs`
- `shapeStableMs`
- `textureStableMs`
- `roiCandidateMs`
- `tileReadyMs`
- `lookRenderMs`
- Why: these files become useful front-door telemetry for plant recognition, digital twin capture, and AR lightbox readiness. LLM/vision systems care about first semantically usable frame, not only final decode.

Session J. Butteraugli path containment.
- Butteraugli itself not in this file, but this file can keep it off hot loops.
- Fix:
- gate expensive perceptual metrics behind post-sweep top-K finalists only.
- never compute heavy quality metric inside inner sweep loops.
- store placeholder `qualityPending` during sweep, fill later.

Session K. Color-engine future-proofing.
- For upcoming perceptual-constancy LUT work, benchmark row schema should reserve:
- `colorMode`
- `toneMathLutId`
- `lookPassCount`
- `simdPath`
- `previewColorStableMs`
- This avoids rebreaking export/tests when non-Riemannian perceptual mode lands.

## Chapter 4. Cross-file merge rules

Duplicate findings already merged here:
- Behavioral tests replace string-search tests across benchmark/probe surfaces.
- Stable identity keys replace filename-substring matching.
- Transport profiles replace byte-only shorthand where time-to-usable-frame matters.
- Semantic preview milestones supplement byte/final metrics for ML, AR, photogrammetry, and progressive UX.
- Expensive perceptual quality work stays outside hot inner loops.

## Chapter 5. Execution order

Recommended order:
1. Agent 3 and Agent 4 first. Probe contract becomes stable.
2. Agent 1 and Agent 2 second. Benchmark controller and tests align to stable cutoff semantics.
3. Agent 5 last. Preset benchmark can then import same transport/stage language and export schema.

Last agent instruction:
- After all accepted work from this document is implemented and merged, append `- DONE` to this filename.

## Overview

Implementing this set lifts benchmark truth first. Cutoff attribution becomes trustworthy, transport simulation becomes time-real instead of byte-only shorthand, and scenario outputs stop claiming evidence they did not measure. That changes these files from demo harnesses into instrumentation surfaces usable for pipeline decisions.

Second effect: large speedup with less noise. Cached resizes, stable row identity, worker-side execution, and deferred heavy quality scoring cut wasted CPU and make results repeatable. That matters for future progressive JXL tuning, perceptual-color-engine rollout, and any AR / recognition workflow that needs earliest semantically useful frame rather than only final bytes.
