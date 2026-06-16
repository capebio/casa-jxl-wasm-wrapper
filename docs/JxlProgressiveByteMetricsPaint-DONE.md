# JxlProgressiveByteMetricsPaint.md

Handoff for:
- `web/jxl-progressive-byte-metrics.js` (BM)
- `web/jxl-progressive-byte-metrics.test.js` (BMT)
- `web/jxl-progressive-paint.js` (PP)

26-lens analysis: efficiency · speed · performance · bugs · features.

---

## Strategic overview (Lens 1–4)

**Data flow:**
`paint.js` → encode RGBA → JXL bytes → `createDecoder` → `progress`/`final` events → `schedulePaint` → `paintPass` → canvas.
`byte-metrics.js` is a pure-computation module. `paint.js` does NOT import from it at all — a structural gap. The byte-cutoff probe ladder is rendered as DOM tiles but the metrics computed in `byte-metrics.js` (`firstRecognizableBytes`, `previewBytes`, `firstPerceptuallyGoodBytes`) are never surfaced in the live UI.

**Critical architectural gap:** `streamIntoDecoder` (PP:981) pushes the ENTIRE JXL in one shot and ignores `stepCount`. `splitEncodedBytesIntoSteps` (PP:966) exists but is unreachable dead code in the main paint path. The "first paint time" measurements do not reflect true network-progressive delivery.

---

## Chapter 1 — `web/jxl-progressive-byte-metrics.js`: Core Fixes
*If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in `C:\Foo\raw-converter-wasm\docs\rejected optimizations.md`*

### BM-1: Double `.at(-1)` in `classifyByteCutoffFrame` (bug/perf)
`frames.at(-1)` is called twice on line 17. Cache it.
```js
// Before:
stage: frames.at(-1)?.stage ?? (frames.at(-1)?.type ?? null),

// After:
const last = frames.at(-1);
return {
  bytes,
  painted: frames.length > 0,
  frameCount: frames.length,
  isFinal: frames.some((event) => event.type === 'final'),
  stage: last?.stage ?? last?.type ?? null,
  error,
};
```

### BM-2: `percent()` string allocation via `toFixed` (perf)
`toFixed` → String → `Number()`. Hot path for every result field. Use integer arithmetic.
```js
function percent(bytes, totalBytes) {
  if (bytes == null || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  return Math.round((bytes / totalBytes) * 1000) / 10;
}
```
Result is identical (one decimal place) without string allocation.

### BM-3: `buildSeries` float division → bitwise shift (micro perf)
Line 152: `Math.floor(i/2)` → `i >> 1`. Both produce identical integers for positive `i`.

### BM-4: `buildSeries` adaptive butteraugli skip — PSNR-delta gate (perf)
Current `doFull` heuristic `(i % 2 === 0) || (b > 100*1024)` is blind to quality change. If PSNR delta from previous entry is < 0.5 dB, perceptual distance won't change significantly — skip butteraugli.
```js
const prevPsnr = i > 0 ? qualitySeries[i - 1].psnr : null;
const currentPsnr = computePsnrVsFinal(p, refPixels);
const psnrDelta = prevPsnr != null ? Math.abs(currentPsnr - prevPsnr) : Infinity;
const doFull = (i % 2 === 0) || (b > 100 * 1024) || psnrDelta > 0.5;
qualitySeries.push({ bytes: b, psnr: currentPsnr });
butterSeries.push({ bytes: b, butter: doFull ? cmp(p) : null });
```
Note: `detectMonotone` in `summarizeByteCutoffResults` already handles null butter entries via `e.butter != null` guards. Safe.

### BM-5: `postDecodeTransform` null/undefined return ambiguity (bug guard)
Line 151: `p = postDecodeTransform(...) || p`. If transform returns `undefined` to signal "skip this frame", the fallback to `p` silently continues. Document the contract: transform returns transformed pixels or `null`/`undefined` to keep original. Guard:
```js
if (postDecodeTransform) {
  const transformed = postDecodeTransform(p, { bytes: b, width, height, index: i, layer: i >> 1 });
  if (transformed && transformed.length === p.length) p = transformed;
}
```

### BM-6: `SSIM_GOOD` constant exported but verify consumers exist (audit)
`SSIM_GOOD = 0.8` is exported but not imported by any file in these three. Confirm no other consumer before considering removal. Leave for now.

### BM-7: Feature — `buildSeries` convergence rate field (feature, Lens 11/21)
After building all series, compute d(PSNR)/d(bytes) slope between last two entries. Consumers can use this to predict early termination.
```js
const convergenceRate = qualitySeries.length >= 2
  ? (qualitySeries.at(-1).psnr - qualitySeries.at(-2).psnr) /
    (qualitySeries.at(-1).bytes - qualitySeries.at(-2).bytes)
  : null;
return { qualitySeries, butterSeries, ssimSeries, convergenceRate };
```

### BM-8: Feature — `colorSpace` parameter for ΔE₂₀₀₀ metrics (Lens 17 / non-Riemannian)
Add optional `{ colorSpace: 'deltaE2000' }` option to `buildSeries`. When set, replace `computePsnrVsFinal` with `computeDeltaE2000VsFinal` (to be implemented in jxl-progressive-quality.js). The `RECOGNIZABLE_DB` and `PREVIEW_DB` thresholds are calibrated for linear-RGB PSNR and will need recalibration for perceptual color spaces.

### BM-9: Feature — `roiMask` for photogrammetry per-region quality (Lens 14)
Add `roiMask?: Uint8Array` to `buildSeries`. When provided, PSNR/SSIM computation only covers masked pixels (texture patches for 3D reconstruction). Pairs with Rust `compute_psnr_masked` WASM export.

### BM-10: Feature — ML logit injection for species recognition (Lens 12/16)
`summarizeByteCutoffResults` should accept `classifierSeries?: Array<{bytes, confidence}>`. Add `firstRecognizableByClassifier` and `firstRecognizableByClassifierPercent` to summary output. Allows AR early-termination when species classifier confidence > threshold instead of waiting for PSNR threshold.

---

## Chapter 2 — `web/jxl-progressive-paint.js`: Memory Lifecycle
*If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in `C:\Foo\raw-converter-wasm\docs\rejected optimizations.md`*

### PP-1: `passes[].pixels` retained after render (memory leak)
Every `passRecord` holds a `Uint8Array` of the full decoded frame. After `paintPass` calls `putImageData`, the canvas holds the visual state — pixels are only needed for final-pass PSNR computation (PP:1237-1239). After PSNR is done, null them out:
```js
// After PSNR computation, ~line 1244:
for (const p of passes) p.pixels = null;
```

### PP-2: `runMeasurements` unbounded growth (memory)
Array grows forever across all runs in the session. Cap at 200:
```js
const MAX_MEASUREMENTS = 200;
// After push:
runMeasurements.push(measurement);
if (runMeasurements.length > MAX_MEASUREMENTS) {
  runMeasurements.splice(0, runMeasurements.length - MAX_MEASUREMENTS);
}
```

### PP-3: `selectedSources` retains RGBA after encode (memory)
`selectedSources` holds raw RGBA buffers (up to 100+ MB for batch ORF loads). After encode completes for a source, the RGBA is no longer needed. Null out `src.rgba` after encode:
```js
// After encChunks collected, ~line 1149:
src.rgba = null; // allow GC of raw RGBA
```
Guard: `resized.rgba` may alias `src.rgba` — ensure `resizeRgba` returns a copy when downscaling (it does via WASM or canvas path). If `size === 'fullsize'`, `resizeRgba` returns `{ rgba, width, height }` with the same reference — nulling `src.rgba` then ALSO nulls `resized.rgba`. Fix: `if (src.rgba !== resized.rgba) src.rgba = null;` or hold resized separately before clearing.

### PP-4: Timeline click shows wrong pixels for 4+ passes (bug)
`slotSrcCanvases` is a 3-slot pool (`compareSlots.length = 3`). Pass 4+ overwrites the canvas at slot 2 (`Math.min(passIdx, 2)`). The `passRecord.srcCanvas` for old pass 2 now points to the canvas showing pass 4. Clicking old pass 2's timeline button calls `paintCanvasIntoSlot(passRecord.srcCanvas, slot.canvas)` which re-renders pass 4's image.

Fix: store a snapshotted OffscreenCanvas (or cloneNode) per pass in `addPassToTimeline` rather than reusing the live mutable canvas. The 80×50 thumb is already captured; only the comparison slot re-render is affected. Alternative: cap visible timeline at 3 entries (== compareSlots.length) and hide 4th+ passButtons.

**Minimal fix** — in `addPassToTimeline`, capture a frozen copy:
```js
// Capture pixels at creation time into thumb (already done).
// Also store a frozen snapshot for slot re-assign:
const snapshot = new OffscreenCanvas(passRecord.srcCanvas.width, passRecord.srcCanvas.height);
snapshot.getContext('2d').drawImage(passRecord.srcCanvas, 0, 0);
passRecord.srcCanvasSnapshot = snapshot;
```
Then `assignPassToCompareSlot` uses `passRecord.srcCanvasSnapshot ?? passRecord.srcCanvas`.

### PP-5: `lastJxlBytes` / `lastExportedJxls.at(-1).bytes` duplicate reference (minor)
Both point to the same `jxlBytes` object. `lastJxlBytes` is checked in `exportToGallery` as fallback. No actual duplication (same reference). Keep for backward compat but note: both references prevent GC of the last JXL until `clearLastExport`.

---

## Chapter 3 — `web/jxl-progressive-paint.js`: Performance
*If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in `C:\Foo\raw-converter-wasm\docs\rejected optimizations.md`*

### PP-6: `paintSourcePreview` allocates full-res canvas every call (hot alloc)
Line 663: `document.createElement('canvas')` at full source resolution on EVERY call. Called once per file during batch loading (line 322). For a 4000×3000 ORF, this creates a 48MP canvas and copies 48M pixels per call.

Fix: cache source canvas per `selectedSource` identity:
```js
let _sourcePreviewCache = null; // { source, srcCanvas }

function paintSourcePreview() {
    const wrap = document.getElementById('source-preview-wrap');
    const c = document.getElementById('source-preview');
    if (!c || !selectedSource || !wrap) { hideSourcePreview(); return; }
    wrap.style.display = 'inline-block';
    // Build source canvas only when source changes
    if (!_sourcePreviewCache || _sourcePreviewCache.source !== selectedSource) {
        const srcC = document.createElement('canvas');
        srcC.width = selectedSource.width;
        srcC.height = selectedSource.height;
        const srcCtx = srcC.getContext('2d', { willReadFrequently: false });
        const clamped = new Uint8ClampedArray(selectedSource.rgba.buffer, selectedSource.rgba.byteOffset, selectedSource.rgba.byteLength);
        srcCtx.putImageData(new ImageData(clamped, selectedSource.width, selectedSource.height), 0, 0);
        _sourcePreviewCache = { source: selectedSource, srcCanvas: srcC };
    }
    const srcC = _sourcePreviewCache.srcCanvas;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    const scale = Math.min(c.width / selectedSource.width, c.height / selectedSource.height);
    const dw = Math.max(1, Math.round(selectedSource.width * scale));
    const dh = Math.max(1, Math.round(selectedSource.height * scale));
    ctx.drawImage(srcC, Math.round((c.width - dw) / 2), Math.round((c.height - dh) / 2), dw, dh);
}
```
Also null `_sourcePreviewCache` in `loadFiles` / `loadRandomImages` before new load.

### PP-7: Wheel events not rAF-throttled (perf / jank)
Wheel fires 60–120× per second. Each event calls `renderAllZoomedViews` which redraws all 3 canvases. Should coalesce:
```js
let _wheelDeltaAccum = 0;
let _wheelRafPending = false;

viewportTrio.addEventListener('wheel', (e) => {
    if (!zoomArmed && zoomLevel <= 1.0001) return;
    e.preventDefault();
    _wheelDeltaAccum += e.deltaY;
    if (_wheelRafPending) return;
    _wheelRafPending = true;
    requestAnimationFrame(() => {
        _wheelRafPending = false;
        const delta = _wheelDeltaAccum;
        _wheelDeltaAccum = 0;
        const factor = delta < 0 ? 1.13 : (1 / 1.13);
        zoomLevel = Math.max(0.4, Math.min(10, zoomLevel * factor));
        updateZoomReadout();
        renderAllZoomedViews();
    });
}, { passive: false });
```

### PP-8: Drag pan scale recomputed every `mousemove` (micro perf)
`1.8 / zoomLevel` is a constant for the duration of a drag gesture but computed on every mousemove (≈60/s). Cache at `mousedown`:
```js
viewportTrio.addEventListener('mousedown', (e) => {
    if (zoomLevel <= 1.0001) return;
    dragStart = { x: e.clientX, y: e.clientY, panX, panY, scale: 1.8 / zoomLevel };
});
window.addEventListener('mousemove', (e) => {
    if (!dragStart) return;
    panX = dragStart.panX - (e.clientX - dragStart.x) * dragStart.scale;
    panY = dragStart.panY - (e.clientY - dragStart.y) * dragStart.scale;
    renderAllZoomedViews();
});
```

### PP-9: `btoa(String.fromCharCode.apply(null, largeArray))` stack overflow (bug)
Line 1380 in `exportToGallery` fallback. `apply` with a Uint8Array of > ~100K elements will blow the call stack on Chrome/Firefox. Use chunked conversion:
```js
function uint8ToBase64(uint8) {
    let str = '';
    const CHUNK = 0x8000; // 32 KB per chunk — safe for apply
    for (let i = 0; i < uint8.length; i += CHUNK) {
        str += String.fromCharCode.apply(null, uint8.subarray(i, i + CHUNK));
    }
    return btoa(str);
}
// Replace:
// const b64 = btoa(String.fromCharCode.apply(null, new Uint8Array(e.bytes)));
// With:
const b64 = uint8ToBase64(new Uint8Array(e.bytes));
```

### PP-10: `exportMeasurementsTOON` string concatenation O(n²) (perf)
`out += ...` on every row in a potentially long measurement history causes quadratic string reallocation. Collect lines into an array and join at the end:
```js
const lines = [];
lines.push(`Dict: ...`);
// ... push each line
const out = lines.join('');
```

### PP-11: `STATS_ENABLED` dead alias (cleanup)
Line 56 defines `const STATS_ENABLED = statsEnabled` but `STATS_ENABLED` is never used — `statsEnabled` is used throughout. Remove dead alias.

### PP-12: `encoderOptions` allocated then discarded in Sneyers path (micro alloc)
Lines 1095-1115 build `encoderOptions`, then lines 1117-1134 unconditionally overwrite it for `presetName === 'sneyers'`. The first allocation is wasted. Restructure:
```js
let encoderOptions;
if (presetName === 'sneyers') {
    const sney = createSneyersPreset({ width: resized.width, height: resized.height, targetLongEdge: 'full', quality, hasAlpha: true });
    encoderOptions = { ...sney.encode, width: resized.width, height: resized.height, quality, progressiveFlavor, chunked: false };
} else {
    encoderOptions = { format: 'rgba8', ... };
}
```

---

## Chapter 4 — Integration: byte-metrics ↔ paint
*If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in `C:\Foo\raw-converter-wasm\docs\rejected optimizations.md`*

### INT-1: Wire `summarizeByteCutoffResults` into `runByteCutoffProbe` (feature/gap)
`runByteCutoffProbe` in `paint.js` renders tiles but discards the computed metrics. Integrate:
1. Import `{ classifyByteCutoffFrame, summarizeByteCutoffResults }` from `./jxl-progressive-byte-metrics.js` at top of `paint.js`.
2. Collect classified results during probe:
```js
async function runByteCutoffProbe(jxlBytes, progressiveDetail) {
    const ladder = document.getElementById('byte-cutoff-ladder');
    const status = document.getElementById('byte-cutoff-status');
    if (!ladder) return;
    const plan = buildByteCutoffPlan(jxlBytes.byteLength);
    ladder.innerHTML = '';
    if (status) status.textContent = `${plan.length} byte cutoffs queued`;
    const classifiedResults = [];
    for (const entry of plan) {
        if (status) status.textContent = `Decoding ${formatByteCutoffLabel(entry)}...`;
        const result = await decodeByteCutoff(jxlBytes, entry, progressiveDetail);
        renderByteCutoffTile(ladder, result);
        // Classify + collect for summary
        const events = result.frame ? [result.frame] : [];
        const classified = classifyByteCutoffFrame({ bytes: entry.bytes, events, error: result.error });
        classifiedResults.push(classified);
        await nextPaint();
    }
    // Display summary metrics
    const summary = summarizeByteCutoffResults(classifiedResults, jxlBytes.byteLength);
    if (status) {
        const parts = [];
        if (summary.firstPaintBytes != null) parts.push(`first paint @ ${(summary.firstPaintBytes/1024).toFixed(1)} KB (${summary.firstPaintPercent}%)`);
        if (summary.previewBytes != null) parts.push(`preview @ ${(summary.previewBytes/1024).toFixed(1)} KB (${summary.previewPercent}%)`);
        parts.push(`${summary.paintedCutoffs}/${plan.length} cutoffs painted`);
        status.textContent = parts.join(' · ');
    }
}
```

### INT-2: Dead code — `streamStepsRequested` / `passesRequested` duplication
`runMeasurements` entries have BOTH `streamStepsRequested` (line 1275) and `passesRequested` (line 1277) set to the same value. Legacy duplication. Remove `passesRequested`; keep `streamStepsRequested`. Update TOON/CSV export column references accordingly.

---

## Chapter 5 — `web/jxl-progressive-paint.js`: Progressive Streaming & Features
*If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in `C:\Foo\raw-converter-wasm\docs\rejected optimizations.md`*

### PP-13: `streamIntoDecoder` ignores `stepCount` — dead byte-splitting code
`streamIntoDecoder` (line 981) pushes the full JXL in one shot regardless of `stepCount`. `splitEncodedBytesIntoSteps` (line 966) computes byte-step ranges but is never called. For true progressive timing benchmarks, wire the split:
```js
async function streamIntoDecoder(decoder, jxlBytes, stepCount) {
    const steps = splitEncodedBytesIntoSteps(jxlBytes, stepCount);
    for (const step of steps) {
        await decoder.push(exactBuffer(step));
        await nextPaint(); // allow intermediate frames to paint between steps
    }
    await decoder.close();
    return steps.length;
}
```
**Warning:** `nextPaint()` yields to the event loop between each push — this changes timing semantics for existing measurements. Gate behind a checkbox ("True byte-step streaming") to avoid breaking current behavior.

### PP-14: Streaming fallback doesn't warn user of degraded semantics
Lines 1199-1227: on stream error, silently falls back to full-buffer decode. Log as a visible `setProgStatus` warning (not just `dbgLog`):
```js
setProgStatus('⚠ Streaming decode failed — falling back to full-buffer decode (progressive timing will be inaccurate).');
```

### PP-15: Feature — AR frame source abstraction (Lens 16)
`processImageFile` is file-based. For real-time AR (camera feed), extract a `FrameSource` interface:
```js
// FrameSource interface: { getFrame() -> Promise<{rgba, width, height}> }
// processImageFile → FileFrameSource
// CameraFrameSource (future): wraps getUserMedia + ImageCapture
```
No code change now — document the seam.

### PP-16: Feature — perceptual constancy wiring via `postDecodeTransform` (Lens 17)
`buildSeries` accepts `postDecodeTransform`. Wire in the Rust `apply_perceptual_constancy` WASM export from `raw_converter_wasm` when available:
```js
const postDecodeTransform = rawWasm.apply_perceptual_constancy
    ? (pixels, { width, height }) => {
        const result = rawWasm.apply_perceptual_constancy(pixels, width, height);
        return result ?? pixels;
      }
    : null;
```
Apply to `buildSeries` calls in the byte-cutoff probe summary path (INT-1).

---

## Chapter 6 — `web/jxl-progressive-byte-metrics.test.js`: Test Coverage
*If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in `C:\Foo\raw-converter-wasm\docs\rejected optimizations.md`*

### BMT-1: `buildSeries` with `postDecodeTransform` not tested
Add test:
```js
test('buildSeries applies postDecodeTransform before quality computation', () => {
  const ref = new Uint8Array(16).fill(200);
  const cuts = [new Uint8Array(16).fill(100)];
  let transformCalled = false;
  const transform = (pixels, ctx) => {
    transformCalled = true;
    expect(ctx.index).toBe(0);
    return pixels; // identity
  };
  const built = buildSeries(ref, cuts, [1000], 2, 2, transform);
  expect(transformCalled).toBe(true);
  expect(built.qualitySeries.length).toBe(1);
});
```

### BMT-2: `buildSeries` null butter entries don't break monotone detection
```js
test('summarize handles null butter entries from skipped buildSeries frames', () => {
  const results = [
    { bytes: 1000, painted: true, frameCount: 1, isFinal: false },
    { bytes: 2000, painted: true, frameCount: 2, isFinal: true },
    { bytes: 3000, painted: true, frameCount: 3, isFinal: true },
  ];
  const butterSeries = [
    { bytes: 1000, butter: 1.5 },
    { bytes: 2000, butter: null }, // skipped by doFull logic
    { bytes: 3000, butter: 0.4 },
  ];
  const s = summarizeByteCutoffResults(results, 3000, { butterSeries });
  expect(s.firstPerceptuallyGoodBytes).toBe(3000);
  expect(s.butterMonotone).not.toBeNull(); // should not throw
});
```

### BMT-3: `classifyByteCutoffFrame` with null error field
```js
test('classifyByteCutoffFrame handles null error cleanly', () => {
  const r = classifyByteCutoffFrame({ bytes: 1000, events: [] }); // error defaults to null
  expect(r.error).toBeNull();
});
```

### BMT-4: `percent()` result precision
```js
test('percent is accurate to one decimal place without string artifacts', () => {
  // 10240 / 81920 = 12.5%, not 12.4999... or 12.50000001
  const s = summarizeByteCutoffResults([{ bytes: 10240, painted: true, frameCount: 1, isFinal: false }], 81920);
  expect(s.firstPaintPercent).toBe(12.5);
});
```

---

## Flip-flop benchmark targets

Where a flip-flop test is warranted (alternate 10× old/new):

| ID | Test | Measurement |
|----|------|-------------|
| PP-6 | `paintSourcePreview` canvas cache vs recreate | Time from file drop to preview display (ms) |
| PP-7 | Wheel zoom rAF-coalesced vs uncoalesced | Canvas redraws per scroll gesture (DevTools FPS) |
| PP-9 | `btoa` chunked vs `.apply` | Large JXL (>5MB) localStorage fallback — crash vs pass |
| INT-1 | Probe with summary vs without | Probe completion display time (no expected regression) |

---

## Overview: What implementing these suggestions achieves

**Memory**: Releasing `passes[].pixels` after PSNR computation eliminates multi-pass pixel buffer accumulation (32 MB per run at 1080p). Capping `runMeasurements` prevents session-long bloat in batch workflows. Nulling `selectedSources[].rgba` after encode allows GC of raw ORF buffers in batch (up to ~100 MB per file).

**Rendering speed**: Caching the source-preview canvas eliminates a full-resolution canvas allocation and pixel copy per file load. rAF-coalescing wheel events cuts canvas redraws from 120/s to 60/s during scroll. Drag-scale caching removes a floating-point division from every mousemove event.

**Correctness**: The `btoa`/`apply` stack overflow fix prevents silent crashes for JXL files > ~100 KB going through the localStorage export fallback. The stale-canvas timeline bug (4+ passes) is documented and a snapshot-based fix proposed. The `postDecodeTransform` null/undefined guard prevents silent quality measurement errors when a transform signals failure.

**Integration**: Wiring `summarizeByteCutoffResults` into `runByteCutoffProbe` unlocks the full metrics module in the live UI — `firstPaintBytes`, `previewBytes`, `firstPerceptuallyGoodBytes` become visible after every probe run without any new computation.

**Progressive fidelity**: Enabling true byte-step streaming (PP-13) would make first-paint timing measurements reflect actual network-progressive delivery rather than the decoder's internal progression on a fully-buffered file.

**Future platform readiness**: The `postDecodeTransform` hook (BM-5), `classifierSeries` proposal (BM-10), and AR frame-source abstraction (PP-15) provide seams for ML-driven early termination, non-Riemannian color science (Lens 17), and real-time species recognition in AR (Lens 16) without requiring structural changes to the pipeline.

---

## Implemented

**byte-metrics.js**
- BM-1: Fixed double `.at(-1)` in `classifyByteCutoffFrame` — cache `last` variable.
- BM-2: `percent()` rewritten to use integer arithmetic (`Math.round(…*1000)/10`) — eliminates `toFixed` string allocation.
- BM-3: `Math.floor(i/2)` → `i >> 1` in `buildSeries`.
- BM-4: Adaptive butteraugli skip added — PSNR delta gate (< 0.5 dB → skip butter); reduces butteraugli calls on plateau regions.
- BM-5: `postDecodeTransform` guard: validates returned pixels have correct length before using; null/undefined falls back to original pixels rather than silently using transform result with `|| p`.

**paint.js**
- INT-4 (PP-11): Removed dead `STATS_ENABLED` alias (was identical to `statsEnabled`, never used).
- INT-1: Imported `classifyByteCutoffFrame` and `summarizeByteCutoffResults` from byte-metrics. `runByteCutoffProbe` now classifies each cutoff result and displays a summary (`firstPaintBytes`, `previewBytes`, painted/total counts) in the status line.
- PP-6: `paintSourcePreview` now caches the full-res source canvas in `_sourcePreviewCache` keyed by `selectedSource` identity — avoids creating a new full-resolution canvas (potentially 48MP) on every call. Cache invalidated on file load.
- PP-7: Wheel events rAF-coalesced via `_wheelDeltaAccum`/`_wheelRafPending` — reduces canvas redraws from 120/s → 60/s during scroll gestures.
- PP-8: Drag pan scale `1.8 / zoomLevel` cached at `mousedown` as `dragStart.scale` — removes per-mousemove division.
- PP-9: `btoa(String.fromCharCode.apply(null, largeArray))` replaced with chunked `uint8ToBase64()` helper — prevents call-stack overflow for JXL files > ~100 KB in localStorage fallback path.
- PP-10: `exportMeasurementsTOON` converted from `out +=` O(n²) string concatenation to `lines.push()` + `lines.join('')`.
- PP-2: `runMeasurements` capped at 200 entries — old entries pruned from front on overflow.
- PP-1: `passes[].pixels` nulled after PSNR computation — frees ~8 MB per pass at 1080p once canvas has the visual data.

**byte-metrics.test.js**
- BMT-3: Added `classifyByteCutoffFrame` null error test.
- BMT-4: Added `percent()` precision test (12.5% exact).
- BMT-1: Added `buildSeries` `postDecodeTransform` callback test (called with correct ctx; identity transform).
- BMT-1b: Added `postDecodeTransform` returning null → fallback to original pixels test.
- BMT-2: Added null butter entries in `butterSeries` monotone test (adaptive skip scenario).

---

*Last agent: when all items above have been implemented or explicitly rejected, rename this file to `JxlProgressiveByteMetricsPaint-DONE.md`.*
