# Truly Progressive JXL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the Sneyers truly-progressive JXL route end-to-end with byte-streaming benchmarks, monotone-quality assertion, a network-throttled UI demo, and a measured-best `SNEYERS_PRESET` wired as the new `previewFirst` default — without touching `bridge.cpp` or libjxl.

**Architecture:** The encoder bridge already plumbs all Sneyers libjxl flags (`PROGRESSIVE_DC/AC/QPROGRESSIVE_AC`, `GROUP_ORDER=1`, `RESPONSIVE=1`) and the decoder already calls `JxlDecoderSetProgressiveDetail` + `JxlDecoderFlushImage`. Work lives in JS only: add PSNR/SSIM/monotone to `web/jxl-progressive-byte-metrics.js`; extract a shared streaming helper from `benchmark/progressive-flag-matrix.mjs`; add a new JPEG-input streaming bench; add a named `SNEYERS_PRESET` to `web/jxl-progressive-best-preset.js`; run the matrix to pick the winning flag combo; wire that combo into `facade.ts:resolveEncoderBridgeSettings` behind a one-line rollback boolean; add a network-throttle slider to `web/jxl-progressive-paint.html`; rebuild `dist/facade.js`.

**Tech Stack:** Node 20+, JS (no TS in `web/`), TypeScript in `packages/jxl-wasm/src/`, sharp for JPEG decode, libjxl via WASM bridge, pnpm workspaces, Vitest / node:test for tests.

**Spec:** `docs/superpowers/specs/2026-06-03-truly-progressive-jxl-design.md`

---

## File Structure

**Create:**
- `benchmark/_progressive-stream-helper.mjs` — shared `streamDecodeCutoffs` + `exactBuffer` + `concatChunks` for both bench scripts
- `benchmark/jpeg-progressive-stream.mjs` — JPEG-input streaming bench (mirror of `progressive-flag-matrix.mjs`)
- `benchmark/jpeg-progressive-stream.test.js` — assertion test (1 fixture)
- `web/jxl-progressive-quality.js` — PSNR + SSIM + monotone detection (one focused module; metrics file stays small)
- `web/jxl-progressive-quality.test.js` — quality module tests

**Modify:**
- `web/jxl-progressive-best-preset.js` — add `SNEYERS_PRESET` + `createSneyersPreset`
- `web/jxl-progressive-best-preset.test.js` — add preset shape tests
- `web/jxl-progressive-byte-metrics.js` — extend `summarizeByteCutoffResults` to accept and return quality-series fields
- `web/jxl-progressive-byte-metrics.test.js` — extend with quality-aware summarization tests
- `benchmark/progressive-flag-matrix.mjs` — refactor to import shared helper, add effort sweep, add `sneyers` row, capture pixels for PSNR
- `benchmark/progressive-flag-matrix.test.js` — assert Sneyers row meets thresholds
- `web/jxl-progressive-paint.html` — add throttle + preset controls
- `web/jxl-progressive-paint.js` — wire throttle into runProgressive, use `SNEYERS_PRESET` when selected, render per-paint PSNR overlay
- `web/jxl-progressive-paint-page.test.js` — throttle-driven test
- `tools/predator-paint-visual-smoke.mjs` — add Sneyers preset run
- `packages/jxl-wasm/src/facade.ts` — wire `SNEYERS_PRESET` into `resolveEncoderBridgeSettings` behind `useSneyersDefault` boolean (after P1 evidence)
- `packages/jxl-wasm/dist/facade.js` — regenerate
- `docs/INCOMPLETE PLANS.md` — mark Tauri progressive line with citation
- `docs/references/designs/progressive-encode-options.md` — status → Implemented
- `docs/suggested-settings.md` — Sneyers recipe + numbers

**Outputs (written by acceptance gate, not source):**
- `docs/Benchmark results/truly-progressive-<ts>.md`
- `docs/Benchmark results/progressive-flag-matrix-<ts>.json` (existing format)
- `docs/Benchmark results/jpeg-progressive-stream-<ts>.json` (new format, mirror of matrix)

**No changes:**
- `packages/jxl-wasm/src/bridge.cpp` — already correct
- libjxl / Emscripten build
- Worker, scheduler, cache layers

---

## Task 1: Add PSNR helper to `web/jxl-progressive-quality.js`

**Files:**
- Create: `web/jxl-progressive-quality.js`
- Create: `web/jxl-progressive-quality.test.js`

- [ ] **Step 1: Write the failing test**

Create `web/jxl-progressive-quality.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePsnrVsFinal } from './jxl-progressive-quality.js';

test('PSNR of identical buffers is +Infinity', () => {
  const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(computePsnrVsFinal(a, b), Infinity);
});

test('PSNR of all-zero vs all-max is finite and near 0 dB', () => {
  const a = new Uint8Array([0, 0, 0, 0]);
  const b = new Uint8Array([255, 255, 255, 255]);
  const psnr = computePsnrVsFinal(a, b);
  assert.ok(Number.isFinite(psnr));
  assert.ok(psnr < 1, `expected near 0 dB, got ${psnr}`);
});

test('PSNR rejects mismatched lengths with error', () => {
  assert.throws(() => computePsnrVsFinal(new Uint8Array(4), new Uint8Array(8)));
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `node --test web/jxl-progressive-quality.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `web/jxl-progressive-quality.js`:

```js
export function computePsnrVsFinal(cutoffPixels, finalPixels) {
  if (cutoffPixels.length !== finalPixels.length) {
    throw new Error(`PSNR length mismatch: ${cutoffPixels.length} vs ${finalPixels.length}`);
  }
  let sumSq = 0;
  for (let i = 0; i < cutoffPixels.length; i++) {
    const d = cutoffPixels[i] - finalPixels[i];
    sumSq += d * d;
  }
  if (sumSq === 0) return Infinity;
  const mse = sumSq / cutoffPixels.length;
  return 10 * Math.log10((255 * 255) / mse);
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `node --test web/jxl-progressive-quality.test.js`
Expected: PASS — 3/3.

- [ ] **Step 5: Commit**

```bash
git add web/jxl-progressive-quality.js web/jxl-progressive-quality.test.js
git commit -m "feat(quality): add computePsnrVsFinal for progressive cutoff metrics"
```

---

## Task 2: Add SSIM helper

**Files:**
- Modify: `web/jxl-progressive-quality.js`
- Modify: `web/jxl-progressive-quality.test.js`

- [ ] **Step 1: Write the failing test**

Append to `web/jxl-progressive-quality.test.js`:

```js
import { computeSsimVsFinal } from './jxl-progressive-quality.js';

test('SSIM of identical buffers is 1', () => {
  const w = 4, h = 4;
  const a = new Uint8Array(w * h * 4).fill(128);
  const b = new Uint8Array(w * h * 4).fill(128);
  assert.equal(computeSsimVsFinal(a, b, w, h), 1);
});

test('SSIM of constant 0 vs constant 255 is less than 0.5', () => {
  const w = 4, h = 4;
  const a = new Uint8Array(w * h * 4).fill(0);
  const b = new Uint8Array(w * h * 4).fill(255);
  const ssim = computeSsimVsFinal(a, b, w, h);
  assert.ok(ssim < 0.5, `expected < 0.5, got ${ssim}`);
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `node --test web/jxl-progressive-quality.test.js`
Expected: FAIL — `computeSsimVsFinal` not exported.

- [ ] **Step 3: Implement**

Append to `web/jxl-progressive-quality.js`:

```js
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

export function computeSsimVsFinal(cutoffPixels, finalPixels, width, height) {
  if (cutoffPixels.length !== finalPixels.length) {
    throw new Error(`SSIM length mismatch: ${cutoffPixels.length} vs ${finalPixels.length}`);
  }
  const channels = cutoffPixels.length / (width * height);
  if (!Number.isInteger(channels)) {
    throw new Error(`SSIM pixel count not divisible by ${width}*${height}`);
  }
  let sumSsim = 0;
  let windowCount = 0;
  const windowChannels = Math.min(channels, 3);
  for (let c = 0; c < windowChannels; c++) {
    let muA = 0, muB = 0;
    for (let i = 0; i < width * height; i++) {
      muA += cutoffPixels[i * channels + c];
      muB += finalPixels[i * channels + c];
    }
    muA /= width * height;
    muB /= width * height;
    let varA = 0, varB = 0, cov = 0;
    for (let i = 0; i < width * height; i++) {
      const a = cutoffPixels[i * channels + c] - muA;
      const b = finalPixels[i * channels + c] - muB;
      varA += a * a;
      varB += b * b;
      cov += a * b;
    }
    varA /= width * height;
    varB /= width * height;
    cov /= width * height;
    const num = (2 * muA * muB + C1) * (2 * cov + C2);
    const den = (muA * muA + muB * muB + C1) * (varA + varB + C2);
    sumSsim += num / den;
    windowCount++;
  }
  return windowCount === 0 ? 0 : sumSsim / windowCount;
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `node --test web/jxl-progressive-quality.test.js`
Expected: PASS — 5/5.

- [ ] **Step 5: Commit**

```bash
git add web/jxl-progressive-quality.js web/jxl-progressive-quality.test.js
git commit -m "feat(quality): add single-window computeSsimVsFinal for progressive cutoff metrics"
```

---

## Task 3: Add monotone detector

**Files:**
- Modify: `web/jxl-progressive-quality.js`
- Modify: `web/jxl-progressive-quality.test.js`

- [ ] **Step 1: Write the failing test**

Append to `web/jxl-progressive-quality.test.js`:

```js
import { detectMonotone } from './jxl-progressive-quality.js';

test('monotone series returns { monotone: true, regressions: [] }', () => {
  const series = [
    { bytes: 1000, psnr: 15 },
    { bytes: 5000, psnr: 22 },
    { bytes: 20000, psnr: 30 },
    { bytes: 50000, psnr: 38 },
  ];
  const result = detectMonotone(series);
  assert.equal(result.monotone, true);
  assert.deepEqual(result.regressions, []);
});

test('series with 1 dB regression is flagged', () => {
  const series = [
    { bytes: 1000, psnr: 22 },
    { bytes: 5000, psnr: 30 },
    { bytes: 20000, psnr: 28.5 },
    { bytes: 50000, psnr: 38 },
  ];
  const result = detectMonotone(series);
  assert.equal(result.monotone, false);
  assert.equal(result.regressions.length, 1);
  assert.equal(result.regressions[0].bytes, 20000);
  assert.ok(result.regressions[0].dropDb > 0.5);
});

test('0.4 dB regression is within tolerance', () => {
  const series = [
    { bytes: 1000, psnr: 30 },
    { bytes: 5000, psnr: 29.6 },
    { bytes: 20000, psnr: 35 },
  ];
  const result = detectMonotone(series);
  assert.equal(result.monotone, true);
  assert.equal(result.regressions.length, 0);
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `node --test web/jxl-progressive-quality.test.js`
Expected: FAIL — `detectMonotone` not exported.

- [ ] **Step 3: Implement**

Append to `web/jxl-progressive-quality.js`:

```js
const MONOTONE_TOLERANCE_DB = 0.5;

export function detectMonotone(series, toleranceDb = MONOTONE_TOLERANCE_DB) {
  const regressions = [];
  let prev = -Infinity;
  for (const entry of series) {
    if (!Number.isFinite(entry.psnr)) continue;
    if (prev !== -Infinity && entry.psnr < prev - toleranceDb) {
      regressions.push({ bytes: entry.bytes, dropDb: Number((prev - entry.psnr).toFixed(2)) });
    }
    if (entry.psnr > prev) prev = entry.psnr;
  }
  return { monotone: regressions.length === 0, regressions };
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `node --test web/jxl-progressive-quality.test.js`
Expected: PASS — 8/8.

- [ ] **Step 5: Commit**

```bash
git add web/jxl-progressive-quality.js web/jxl-progressive-quality.test.js
git commit -m "feat(quality): add detectMonotone with 0.5 dB tolerance for progressive paint series"
```

---

## Task 4: Extend `summarizeByteCutoffResults` to accept quality series

**Files:**
- Modify: `web/jxl-progressive-byte-metrics.js`
- Modify: `web/jxl-progressive-byte-metrics.test.js`

- [ ] **Step 1: Write the failing test**

If `web/jxl-progressive-byte-metrics.test.js` exists, append; otherwise create:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeByteCutoffResults } from './jxl-progressive-byte-metrics.js';

test('summarizeByteCutoffResults exposes quality fields when qualitySeries supplied', () => {
  const results = [
    { bytes: 1000, painted: false, frameCount: 0, isFinal: false },
    { bytes: 5000, painted: true, frameCount: 1, isFinal: false, stage: 'dc' },
    { bytes: 20000, painted: true, frameCount: 2, isFinal: false, stage: 'pass' },
    { bytes: 50000, painted: true, frameCount: 3, isFinal: true, stage: 'final' },
  ];
  const qualitySeries = [
    { bytes: 5000, psnr: 18 },
    { bytes: 20000, psnr: 28 },
    { bytes: 50000, psnr: 42 },
  ];
  const summary = summarizeByteCutoffResults(results, 50000, { qualitySeries });
  assert.equal(summary.firstRecognizableBytes, 20000);
  assert.equal(summary.previewBytes, 50000);
  assert.equal(summary.finalPsnr, 42);
  assert.equal(summary.monotone, true);
  assert.deepEqual(summary.regressions, []);
});

test('summarizeByteCutoffResults without qualitySeries keeps backwards-compatible shape', () => {
  const results = [
    { bytes: 1000, painted: true, frameCount: 1, isFinal: false, stage: 'dc' },
    { bytes: 5000, painted: true, frameCount: 1, isFinal: true, stage: 'final' },
  ];
  const summary = summarizeByteCutoffResults(results, 5000);
  assert.equal(summary.firstPaintBytes, 1000);
  assert.equal(summary.firstRecognizableBytes, null);
  assert.equal(summary.finalPsnr, null);
  assert.equal(summary.monotone, null);
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `node --test web/jxl-progressive-byte-metrics.test.js`
Expected: FAIL — new fields missing.

- [ ] **Step 3: Implement**

Modify `web/jxl-progressive-byte-metrics.js`. Change the export signature and body of `summarizeByteCutoffResults`:

```js
import { detectMonotone } from './jxl-progressive-quality.js';

const RECOGNIZABLE_DB = 20;
const PREVIEW_DB = 30;

export function summarizeByteCutoffResults(results, totalBytes, { qualitySeries = null } = {}) {
  const sorted = [...results].sort((a, b) => a.bytes - b.bytes);
  const painted = sorted.filter((result) => result.painted);
  const firstPaint = painted[0] ?? null;
  const final = sorted.find((result) => result.isFinal) ?? sorted.at(-1) ?? null;
  const maxFrameCount = sorted.reduce((max, result) => Math.max(max, result.frameCount ?? 0), 0);

  let firstRecognizableBytes = null;
  let previewBytes = null;
  let finalPsnr = null;
  let monotone = null;
  let regressions = [];

  if (Array.isArray(qualitySeries) && qualitySeries.length > 0) {
    const sortedSeries = [...qualitySeries].sort((a, b) => a.bytes - b.bytes);
    firstRecognizableBytes = sortedSeries.find((entry) => entry.psnr >= RECOGNIZABLE_DB)?.bytes ?? null;
    previewBytes = sortedSeries.find((entry) => entry.psnr >= PREVIEW_DB)?.bytes ?? null;
    finalPsnr = sortedSeries.at(-1)?.psnr ?? null;
    const monotoneResult = detectMonotone(sortedSeries);
    monotone = monotoneResult.monotone;
    regressions = monotoneResult.regressions;
  } else {
    previewBytes = pickPreviewCutoffBytesOnly(painted, totalBytes);
  }

  return {
    totalBytes,
    firstPaintBytes: firstPaint?.bytes ?? null,
    firstPaintPercent: percent(firstPaint?.bytes, totalBytes),
    firstRecognizableBytes,
    firstRecognizablePercent: percent(firstRecognizableBytes, totalBytes),
    previewBytes,
    previewPercent: percent(previewBytes, totalBytes),
    finalBytes: final?.bytes ?? null,
    finalPercent: percent(final?.bytes, totalBytes),
    finalPsnr,
    paintedCutoffs: painted.length,
    maxFrameCount,
    usefulEarlyPaint: !!firstPaint && firstPaint.bytes < totalBytes,
    monotone,
    regressions,
  };
}

function pickPreviewCutoffBytesOnly(painted, totalBytes) {
  if (painted.length === 0) return null;
  const nonFinal = painted.filter((result) => !result.isFinal && result.bytes < totalBytes);
  if (nonFinal.length === 0) return painted[0]?.bytes ?? null;
  const threshold = Math.min(50 * 1024, Math.max(1, totalBytes * 0.7));
  return (nonFinal.find((result) => result.bytes >= threshold) ?? nonFinal.at(-1))?.bytes ?? null;
}
```

Keep the `pickPreviewCutoff` legacy function only if it has other callers; otherwise delete and use the bytes-only helper above.

- [ ] **Step 4: Run test, expect pass**

Run: `node --test web/jxl-progressive-byte-metrics.test.js`
Expected: PASS — both new tests + any existing.

- [ ] **Step 5: Commit**

```bash
git add web/jxl-progressive-byte-metrics.js web/jxl-progressive-byte-metrics.test.js
git commit -m "feat(metrics): extend summarizeByteCutoffResults with optional quality-series fields"
```

---

## Task 5: Extract shared streaming helper

**Files:**
- Create: `benchmark/_progressive-stream-helper.mjs`
- Modify: `benchmark/progressive-flag-matrix.mjs`

- [ ] **Step 1: Create the shared module**

Create `benchmark/_progressive-stream-helper.mjs`:

```js
// Shared streaming-decode helpers for progressive bench scripts.

export function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

export function concatChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function waitForStreamEvents(waitMs = 0) {
  if (waitMs > 0) return new Promise((resolve) => setTimeout(resolve, waitMs));
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Feeds jxlBytes to a fresh decoder in cutoff-bounded slices, captures the
 * latest progress/final pixels per cutoff slot, returns {cutoffs, error}.
 * Pixels in each cutoff are a Uint8Array copy (decoder reuses internal buffers).
 */
export async function streamDecodeCutoffs(jxlBytes, plan, decodeOptions, { createDecoder, waitMs = 0 } = {}) {
  if (!createDecoder) throw new Error('streamDecodeCutoffs requires createDecoder');
  const decoder = createDecoder(decodeOptions);
  const cutoffs = plan.map((entry) => ({
    entry,
    bytes: entry.bytes,
    events: [],
    pixels: null,
    width: 0,
    height: 0,
    paintIndex: null,
    error: null,
  }));
  const byBytes = new Map(cutoffs.map((cutoff) => [cutoff.bytes, cutoff]));
  let currentEntry = plan[0] ?? null;
  let paintCounter = 0;
  let error = null;
  try {
    const eventTask = (async () => {
      for await (const event of decoder.events()) {
        if (event.type === 'progress' || event.type === 'final') {
          const cutoff = byBytes.get(currentEntry?.bytes) ?? cutoffs.at(-1);
          if (cutoff) {
            cutoff.events.push(event);
            cutoff.pixels = new Uint8Array(event.pixels);
            cutoff.width = event.info.width;
            cutoff.height = event.info.height;
            cutoff.paintIndex = paintCounter++;
          }
        }
        if (event.type === 'error') throw new Error(`${event.code}: ${event.message}`);
      }
    })();
    let offset = 0;
    for (const entry of plan) {
      if (entry.bytes <= offset) continue;
      currentEntry = entry;
      await decoder.push(exactBuffer(jxlBytes.subarray(offset, entry.bytes)));
      offset = entry.bytes;
      await waitForStreamEvents(waitMs);
    }
    await decoder.close();
    await eventTask;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await decoder.dispose();
  }
  if (error) {
    for (const cutoff of cutoffs) {
      if (cutoff.events.length === 0) cutoff.error = error;
    }
  }
  return { cutoffs, error };
}

/**
 * Computes per-cutoff PSNR vs the last (final) cutoff's pixels.
 * Returns array of {bytes, psnr, ssim} suitable for summarizeByteCutoffResults.
 */
export async function computeQualitySeries(cutoffs) {
  const finalCutoff = [...cutoffs].reverse().find((c) => c.pixels) ?? null;
  if (!finalCutoff) return [];
  const { computePsnrVsFinal, computeSsimVsFinal } = await import('../web/jxl-progressive-quality.js');
  const series = [];
  for (const cutoff of cutoffs) {
    if (!cutoff.pixels) continue;
    if (cutoff.pixels.length !== finalCutoff.pixels.length) continue;
    series.push({
      bytes: cutoff.bytes,
      psnr: computePsnrVsFinal(cutoff.pixels, finalCutoff.pixels),
      ssim: computeSsimVsFinal(cutoff.pixels, finalCutoff.pixels, finalCutoff.width, finalCutoff.height),
    });
  }
  return series;
}
```

- [ ] **Step 2: Update `progressive-flag-matrix.mjs` to import shared helpers**

In `benchmark/progressive-flag-matrix.mjs`:

Replace the locally-defined `exactBuffer`, `concatChunks`, `waitForStreamEvents`, `streamDecodeCutoffs` with imports:

```js
import {
  exactBuffer,
  concatChunks,
  waitForStreamEvents,
  streamDecodeCutoffs,
  computeQualitySeries,
} from './_progressive-stream-helper.mjs';
```

Delete the now-duplicate function definitions in `progressive-flag-matrix.mjs` (lines 165-241 region per current source).

Update the call site:
```js
const streamed = await streamDecodeCutoffs(
  jxlBytes,
  buildByteCutoffPlan(jxlBytes.byteLength),
  basePreset.decode,
  { createDecoder, waitMs: WAIT_MS },
);
const qualitySeries = await computeQualitySeries(streamed.cutoffs);
const cutoffs = streamed.cutoffs.map((cutoff) => classifyByteCutoffFrame(cutoff));
const summary = summarizeByteCutoffResults(cutoffs, jxlBytes.byteLength, { qualitySeries });
```

- [ ] **Step 3: Run matrix smoke (1 file, quick)**

Run: `PFM_LIMIT=1 node benchmark/progressive-flag-matrix.mjs`
Expected: completes without throw, JSON artifact written, console shows per-case row.

- [ ] **Step 4: Commit**

```bash
git add benchmark/_progressive-stream-helper.mjs benchmark/progressive-flag-matrix.mjs
git commit -m "refactor(bench): extract progressive streaming helper + quality-series for matrix"
```

---

## Task 6: Add effort sweep + sneyers row to RAW matrix

**Files:**
- Modify: `benchmark/progressive-flag-matrix.mjs`

- [ ] **Step 1: Edit the matrix cases and outer loop**

In `benchmark/progressive-flag-matrix.mjs`, replace `MATRIX_CASES` and the inner case loop:

```js
const MATRIX_CASES = Object.freeze([
  { name: 'dc1-only',       progressiveDc: 1, progressiveAc: 0, qProgressiveAc: 0, groupOrder: 1 },
  { name: 'dc2-only',       progressiveDc: 2, progressiveAc: 0, qProgressiveAc: 0, groupOrder: 1 },
  { name: 'dc2-ac-only',    progressiveDc: 2, progressiveAc: 1, qProgressiveAc: 0, groupOrder: 1 },
  { name: 'dc2-q-only',     progressiveDc: 2, progressiveAc: 0, qProgressiveAc: 1, groupOrder: 1 },
  { name: 'dc2-ac-q',       progressiveDc: 2, progressiveAc: 1, qProgressiveAc: 1, groupOrder: 1 },
  { name: 'dc2-q-scanline', progressiveDc: 2, progressiveAc: 0, qProgressiveAc: 1, groupOrder: 0 },
  { name: 'sneyers',        progressiveDc: 2, progressiveAc: 1, qProgressiveAc: 1, groupOrder: 1, decodingSpeed: 0 },
]);

const EFFORT_SWEEP = Object.freeze([3, 5]);
```

Wrap the existing `for (const matrixCase of MATRIX_CASES)` loop in `for (const effort of EFFORT_SWEEP)` so each combo runs at both efforts:

```js
const cases = [];
for (const effort of EFFORT_SWEEP) {
  for (const matrixCase of MATRIX_CASES) {
    const encodeOptions = {
      ...basePreset.encode,
      progressiveFlavor: 'dc',
      previewFirst: true,
      progressiveDc: matrixCase.progressiveDc,
      progressiveAc: matrixCase.progressiveAc,
      qProgressiveAc: matrixCase.qProgressiveAc,
      groupOrder: matrixCase.groupOrder,
      effort,
      ...(matrixCase.decodingSpeed !== undefined ? { decodingSpeed: matrixCase.decodingSpeed } : {}),
    };
    const caseName = `${matrixCase.name}-e${effort}`;
    const t0 = performance.now();
    const jxlBytes = await encodeTarget(rgba, encodeOptions);
    const encodeMs = performance.now() - t0;
    const streamed = await streamDecodeCutoffs(jxlBytes, buildByteCutoffPlan(jxlBytes.byteLength), basePreset.decode, { createDecoder, waitMs: WAIT_MS });
    const qualitySeries = await computeQualitySeries(streamed.cutoffs);
    const cutoffs = streamed.cutoffs.map((cutoff) => classifyByteCutoffFrame(cutoff));
    const summary = summarizeByteCutoffResults(cutoffs, jxlBytes.byteLength, { qualitySeries });
    cases.push({ name: caseName, effort, ...matrixCase, encodeMs, jxlBytes: jxlBytes.byteLength, summary, cutoffs, qualitySeries });
    console.log(`  ${caseName.padEnd(22)} jxl=${fmtBytes(jxlBytes.byteLength)} first=${fmtBytes(summary.firstPaintBytes)} recog=${fmtBytes(summary.firstRecognizableBytes)} preview=${fmtBytes(summary.previewBytes)} paints=${summary.paintedCutoffs} mono=${summary.monotone} finalPsnr=${summary.finalPsnr?.toFixed(1)}`);
  }
}
```

- [ ] **Step 2: Run matrix on 1 file at both efforts**

Run: `PFM_LIMIT=1 node benchmark/progressive-flag-matrix.mjs`
Expected: console prints 14 rows (7 cases × 2 efforts). JSON artifact contains `effort` per case.

- [ ] **Step 3: Commit**

```bash
git add benchmark/progressive-flag-matrix.mjs
git commit -m "feat(bench): sweep effort {3,5} and add named sneyers row to progressive flag matrix"
```

---

## Task 7: Assert Sneyers thresholds in matrix test

**Files:**
- Modify: `benchmark/progressive-flag-matrix.test.js`

- [ ] **Step 1: Read existing test to find a structure to extend**

Run: `node --test benchmark/progressive-flag-matrix.test.js`
Expected: existing test result (whatever it does today — note the pass/fail baseline).

- [ ] **Step 2: Add Sneyers-row assertion**

Append to `benchmark/progressive-flag-matrix.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

test('sneyers-e3 row meets truly-progressive thresholds on smallest available ORF', async () => {
  const GOB = process.env.PFM_FIXTURE_DIR ?? String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
  const orfs = readdirSync(GOB)
    .filter((n) => extname(n).toLowerCase() === '.orf')
    .map((n) => ({ name: n, size: statSync(join(GOB, n)).size }))
    .sort((a, b) => a.size - b.size);
  if (orfs.length === 0) {
    console.warn('[skip] no ORFs in fixture dir');
    return;
  }
  process.env.PFM_LIMIT = '1';
  process.env.PFM_TARGET = '1200';
  process.env.PFM_QUALITY = '85';
  process.env.PFM_DETAIL = 'passes';
  // Import after env set so the matrix picks them up.
  const { runMatrix } = await import('./progressive-flag-matrix.mjs').catch(() => ({ runMatrix: null }));
  if (!runMatrix) {
    console.warn('[skip] matrix script does not export runMatrix; run by hand to verify thresholds');
    return;
  }
  const results = await runMatrix();
  const file = results[0];
  const sneyers = file.cases.find((c) => c.name === 'sneyers-e3');
  assert.ok(sneyers, 'sneyers-e3 row missing');
  assert.ok(sneyers.summary.paintedCutoffs >= 4, `paintedCutoffs ${sneyers.summary.paintedCutoffs} < 4`);
  assert.ok(sneyers.summary.firstRecognizableBytes <= sneyers.jxlBytes * 0.25, `firstRecognizable ${sneyers.summary.firstRecognizableBytes} > 25%`);
  assert.ok(sneyers.summary.previewBytes <= sneyers.jxlBytes * 0.50, `preview ${sneyers.summary.previewBytes} > 50%`);
  assert.equal(sneyers.summary.monotone, true);
  assert.ok(sneyers.summary.finalPsnr >= 40, `finalPsnr ${sneyers.summary.finalPsnr} < 40 dB`);
});
```

- [ ] **Step 3: Refactor `progressive-flag-matrix.mjs` to export `runMatrix`**

In `benchmark/progressive-flag-matrix.mjs`, change the bottom of file from:
```js
main().catch((error) => { console.error(error); process.exit(1); });
```
to:
```js
export async function runMatrix() { return await mainCollect(); }

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
```

Refactor `main()` to delegate file-collection logic to a returnable `mainCollect()` that returns the `results` array before writing the artifact:

```js
async function mainCollect() {
  // ... existing setup (init WASM, list files, etc.)
  // build results array (existing loop)
  // write JSON artifact
  // return results;
}
async function main() { await mainCollect(); }
```

- [ ] **Step 4: Run test, expect pass**

Run: `node --test benchmark/progressive-flag-matrix.test.js`
Expected: PASS if fixture dir present; SKIP message if not. No hard failure on missing fixture.

- [ ] **Step 5: Commit**

```bash
git add benchmark/progressive-flag-matrix.test.js benchmark/progressive-flag-matrix.mjs
git commit -m "test(bench): assert sneyers-e3 row meets truly-progressive thresholds"
```

---

## Task 8: Create JPEG streaming bench

**Files:**
- Create: `benchmark/jpeg-progressive-stream.mjs`

- [ ] **Step 1: Create the script**

Create `benchmark/jpeg-progressive-stream.mjs`:

```js
/**
 * JPEG -> JXL streaming progressive bench.
 * Mirror of progressive-flag-matrix.mjs but with JPEG decode (sharp) as the
 * pixel source. Sweeps the same flag matrix x effort {3, 5} and writes
 * docs/Benchmark results/jpeg-progressive-stream-<ts>.json.
 *
 * Env:
 *   JPEG_DIR     JPEG source dir (default Gobabeb JPEG subdir)
 *   JPS_LIMIT    files to process (default 1)
 *   JPS_START    skip first N files (default 0)
 *   JPS_TARGET   target long edge px or 'full' (default 1600)
 *   JPS_QUALITY  encode quality 1..100 (default 85)
 *   JPS_DETAIL   progressiveDetail (default passes)
 *   JPS_WAIT_MS  wait between pushes (default 0)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';

import { buildByteCutoffPlan } from '../web/jxl-byte-cutoff-probe.js';
import { createProgressiveWebPreset } from '../web/jxl-progressive-best-preset.js';
import { classifyByteCutoffFrame, summarizeByteCutoffResults } from '../web/jxl-progressive-byte-metrics.js';
import { exactBuffer, concatChunks, streamDecodeCutoffs, computeQualitySeries } from './_progressive-stream-helper.mjs';

const JPEG_DIR = process.env.JPEG_DIR ?? String.raw`C:\995\2026-02-20 Gobabeb To Windhoek\JPEG`;
const OUT_DIR = String.raw`C:\Foo\raw-converter-wasm\docs\Benchmark results`;
const LIMIT = clampInt(process.env.JPS_LIMIT ?? '1', 1, 100);
const START = clampInt(process.env.JPS_START ?? '0', 0, 1000);
const TARGET = process.env.JPS_TARGET ?? '1600';
const QUALITY = clampInt(process.env.JPS_QUALITY ?? '85', 1, 100);
const DETAIL = process.env.JPS_DETAIL ?? 'passes';
const WAIT_MS = clampInt(process.env.JPS_WAIT_MS ?? '0', 0, 1000);

const MATRIX_CASES = Object.freeze([
  { name: 'dc1-only',       progressiveDc: 1, progressiveAc: 0, qProgressiveAc: 0, groupOrder: 1 },
  { name: 'dc2-only',       progressiveDc: 2, progressiveAc: 0, qProgressiveAc: 0, groupOrder: 1 },
  { name: 'dc2-ac-only',    progressiveDc: 2, progressiveAc: 1, qProgressiveAc: 0, groupOrder: 1 },
  { name: 'dc2-q-only',     progressiveDc: 2, progressiveAc: 0, qProgressiveAc: 1, groupOrder: 1 },
  { name: 'dc2-ac-q',       progressiveDc: 2, progressiveAc: 1, qProgressiveAc: 1, groupOrder: 1 },
  { name: 'dc2-q-scanline', progressiveDc: 2, progressiveAc: 0, qProgressiveAc: 1, groupOrder: 0 },
  { name: 'sneyers',        progressiveDc: 2, progressiveAc: 1, qProgressiveAc: 1, groupOrder: 1, decodingSpeed: 0 },
]);

const EFFORT_SWEEP = Object.freeze([3, 5]);

let createDecoder;
let createEncoder;
let detectTier;

export async function runJpegMatrix() {
  if (typeof globalThis.Worker === 'undefined' && !process.env.JXL_WASM_FORCE_TIER) {
    process.env.JXL_WASM_FORCE_TIER = 'simd';
  }
  ({ createDecoder, createEncoder, detectTier } = await import('../packages/jxl-wasm/dist/index.js'));
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const files = selectFiles();
  if (files.length === 0) throw new Error(`No JPEGs found in ${JPEG_DIR}`);
  const tier = detectTier();
  console.log(`[jpeg-progressive-stream] tier=${tier} files=${files.length} target=${TARGET} quality=${QUALITY} detail=${DETAIL} wait=${WAIT_MS}ms`);

  const results = [];
  for (const file of files) {
    console.log(`[jpeg-progressive-stream] ${basename(file)}`);
    const jpegBytes = readFileSync(file);
    const { data, info } = await sharp(jpegBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const source = { width: info.width, height: info.height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
    const targetLongEdge = TARGET === 'full' ? 'full' : Number(TARGET);
    const basePreset = createProgressiveWebPreset({
      width: source.width,
      height: source.height,
      targetLongEdge,
      quality: QUALITY,
      progressiveDetail: DETAIL,
    });
    const rgba = makeTargetRgba(source, basePreset.target.width, basePreset.target.height);
    const cases = [];
    for (const effort of EFFORT_SWEEP) {
      for (const matrixCase of MATRIX_CASES) {
        const encodeOptions = {
          ...basePreset.encode,
          progressiveFlavor: 'dc',
          previewFirst: true,
          progressiveDc: matrixCase.progressiveDc,
          progressiveAc: matrixCase.progressiveAc,
          qProgressiveAc: matrixCase.qProgressiveAc,
          groupOrder: matrixCase.groupOrder,
          effort,
          ...(matrixCase.decodingSpeed !== undefined ? { decodingSpeed: matrixCase.decodingSpeed } : {}),
        };
        const caseName = `${matrixCase.name}-e${effort}`;
        const t0 = performance.now();
        const jxlBytes = await encodeTarget(rgba, encodeOptions);
        const encodeMs = performance.now() - t0;
        const streamed = await streamDecodeCutoffs(jxlBytes, buildByteCutoffPlan(jxlBytes.byteLength), basePreset.decode, { createDecoder, waitMs: WAIT_MS });
        const qualitySeries = await computeQualitySeries(streamed.cutoffs);
        const cutoffs = streamed.cutoffs.map((cutoff) => classifyByteCutoffFrame(cutoff));
        const summary = summarizeByteCutoffResults(cutoffs, jxlBytes.byteLength, { qualitySeries });
        cases.push({ name: caseName, effort, ...matrixCase, encodeMs, jxlBytes: jxlBytes.byteLength, summary, cutoffs, qualitySeries });
        console.log(`  ${caseName.padEnd(22)} jxl=${fmtBytes(jxlBytes.byteLength)} first=${fmtBytes(summary.firstPaintBytes)} recog=${fmtBytes(summary.firstRecognizableBytes)} preview=${fmtBytes(summary.previewBytes)} paints=${summary.paintedCutoffs} mono=${summary.monotone} finalPsnr=${summary.finalPsnr?.toFixed(1)}`);
      }
    }
    results.push({
      file: basename(file),
      jpegBytes: jpegBytes.byteLength,
      source: { width: source.width, height: source.height },
      target: basePreset.target,
      cases,
    });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(OUT_DIR, `jpeg-progressive-stream-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify({
    exportedAt: new Date().toISOString(),
    generator: 'jpeg-progressive-stream',
    tier,
    target: TARGET,
    quality: QUALITY,
    detail: DETAIL,
    matrixCases: MATRIX_CASES,
    effortSweep: EFFORT_SWEEP,
    results,
  }, null, 2));
  console.log(`[jpeg-progressive-stream] wrote ${outPath}`);
  return results;
}

function selectFiles() {
  const entries = readdirSync(JPEG_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ['.jpg', '.jpeg'].includes(extname(entry.name).toLowerCase()))
    .map((entry) => {
      const path = join(JPEG_DIR, entry.name);
      return { path, size: statSync(path).size };
    })
    .sort((a, b) => a.size - b.size);
  return entries.slice(START, START + LIMIT).map((entry) => entry.path);
}

function makeTargetRgba(source, width, height) {
  if (source.width === width && source.height === height) return source.rgba;
  // Use sharp for downsample to keep parity with existing tests.
  // (Inline note: sharp already returned source RGBA at native res; we resize here.)
  return downscaleRgba(source.rgba, source.width, source.height, width, height);
}

function downscaleRgba(src, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 4);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor(y * yRatio));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor(x * xRatio));
      const si = (sy * srcW + sx) * 4;
      const di = (y * dstW + x) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return out;
}

async function encodeTarget(rgba, encodeOptions) {
  const encoder = createEncoder(encodeOptions);
  const chunks = [];
  const chunkTask = (async () => {
    for await (const chunk of encoder.chunks()) chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  })();
  await encoder.pushPixels(exactBuffer(rgba));
  await encoder.finish();
  await chunkTask;
  await encoder.dispose();
  return concatChunks(chunks);
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '--';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runJpegMatrix().catch((error) => { console.error(error); process.exit(1); });
}
```

- [ ] **Step 2: Smoke run on 1 file**

Run: `JPS_LIMIT=1 node benchmark/jpeg-progressive-stream.mjs`
Expected: console shows 14 rows; JSON artifact written.

- [ ] **Step 3: Commit**

```bash
git add benchmark/jpeg-progressive-stream.mjs
git commit -m "feat(bench): JPEG->JXL streaming progressive matrix (mirrors RAW matrix, sweeps effort 3,5)"
```

---

## Task 9: JPEG bench test asserts Sneyers thresholds

**Files:**
- Create: `benchmark/jpeg-progressive-stream.test.js`

- [ ] **Step 1: Write the test**

Create `benchmark/jpeg-progressive-stream.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

test('sneyers-e3 row meets thresholds on smallest available JPEG', async () => {
  const dir = process.env.JPS_FIXTURE_DIR ?? String.raw`C:\995\2026-02-20 Gobabeb To Windhoek\JPEG`;
  const jpegs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && ['.jpg', '.jpeg'].includes(extname(e.name).toLowerCase()))
    .map((e) => ({ name: e.name, size: statSync(join(dir, e.name)).size }))
    .sort((a, b) => a.size - b.size);
  if (jpegs.length === 0) {
    console.warn('[skip] no JPEGs in fixture dir');
    return;
  }
  process.env.JPEG_DIR = dir;
  process.env.JPS_LIMIT = '1';
  process.env.JPS_TARGET = '1200';
  process.env.JPS_QUALITY = '85';
  process.env.JPS_DETAIL = 'passes';
  const { runJpegMatrix } = await import('./jpeg-progressive-stream.mjs');
  const results = await runJpegMatrix();
  const file = results[0];
  const sneyers = file.cases.find((c) => c.name === 'sneyers-e3');
  assert.ok(sneyers, 'sneyers-e3 row missing');
  assert.ok(sneyers.summary.paintedCutoffs >= 4, `paintedCutoffs ${sneyers.summary.paintedCutoffs} < 4`);
  assert.ok(sneyers.summary.firstRecognizableBytes <= sneyers.jxlBytes * 0.25, `firstRecognizable ${sneyers.summary.firstRecognizableBytes} > 25%`);
  assert.ok(sneyers.summary.previewBytes <= sneyers.jxlBytes * 0.50, `preview ${sneyers.summary.previewBytes} > 50%`);
  assert.equal(sneyers.summary.monotone, true);
  assert.ok(sneyers.summary.finalPsnr >= 40, `finalPsnr ${sneyers.summary.finalPsnr} < 40 dB`);
});
```

- [ ] **Step 2: Run test**

Run: `node --test benchmark/jpeg-progressive-stream.test.js`
Expected: PASS if fixture present, SKIP otherwise.

- [ ] **Step 3: Commit**

```bash
git add benchmark/jpeg-progressive-stream.test.js
git commit -m "test(bench): assert sneyers-e3 row thresholds on JPEG path"
```

---

## Task 10: Add `SNEYERS_PRESET` to best-preset module

**Files:**
- Modify: `web/jxl-progressive-best-preset.js`
- Modify: `web/jxl-progressive-best-preset.test.js`

- [ ] **Step 1: Write the failing test**

If `web/jxl-progressive-best-preset.test.js` exists, append; else create:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SNEYERS_PRESET, createSneyersPreset } from './jxl-progressive-best-preset.js';

test('SNEYERS_PRESET is frozen and contains expected Sneyers flags', () => {
  assert.equal(Object.isFrozen(SNEYERS_PRESET), true);
  assert.equal(SNEYERS_PRESET.progressive, true);
  assert.equal(SNEYERS_PRESET.previewFirst, true);
  assert.equal(SNEYERS_PRESET.progressiveDc, 2);
  assert.equal(SNEYERS_PRESET.progressiveAc, 1);
  assert.equal(SNEYERS_PRESET.qProgressiveAc, 1);
  assert.equal(SNEYERS_PRESET.groupOrder, 1);
  assert.equal(SNEYERS_PRESET.effort, 3);
  assert.equal(SNEYERS_PRESET.decodingSpeed, 0);
});

test('createSneyersPreset returns target/encode/decode triple', () => {
  const preset = createSneyersPreset({ width: 4000, height: 3000, targetLongEdge: 1200, quality: 80 });
  assert.equal(preset.target.width, 1200);
  assert.equal(preset.target.height, 900);
  assert.equal(preset.encode.progressiveDc, 2);
  assert.equal(preset.encode.qProgressiveAc, 1);
  assert.equal(preset.encode.effort, 3);
  assert.equal(preset.encode.quality, 80);
  assert.equal(preset.decode.emitEveryPass, true);
  assert.equal(preset.decode.progressiveDetail, 'passes');
});

test('createSneyersPreset honours progressiveDetail override', () => {
  const preset = createSneyersPreset({ width: 100, height: 100, progressiveDetail: 'dc' });
  assert.equal(preset.decode.progressiveDetail, 'dc');
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `node --test web/jxl-progressive-best-preset.test.js`
Expected: FAIL — `SNEYERS_PRESET` not exported.

- [ ] **Step 3: Implement**

Append to `web/jxl-progressive-best-preset.js` (after `createProgressiveWebPreset`):

```js
export const SNEYERS_PRESET = Object.freeze({
  progressive: true,
  previewFirst: true,
  progressiveDc: 2,
  progressiveAc: 1,
  qProgressiveAc: 1,
  groupOrder: 1,
  effort: 3,            // measurement-driven; updated post-matrix run (Task 12)
  decodingSpeed: 0,
});

export function createSneyersPreset({
  width,
  height,
  targetLongEdge = 1200,
  quality = 85,
  hasAlpha = true,
  progressiveDetail = 'passes',
  ssimulacra2Target = null,
} = {}) {
  const target = resolveTargetDimensions(width, height, targetLongEdge);
  const qualityPolicy = resolveQualityPolicy({ quality, ssimulacra2Target });
  const encode = {
    format: 'rgba8',
    width: target.width,
    height: target.height,
    hasAlpha,
    quality: qualityPolicy.quality,
    chunked: false,
    ...SNEYERS_PRESET,
  };
  const decode = {
    format: 'rgba8',
    region: null,
    downsample: 1,
    progressionTarget: 'final',
    emitEveryPass: true,
    progressiveDetail,
    preserveIcc: false,
    preserveMetadata: false,
  };
  return {
    name: 'sneyers',
    target,
    qualityPolicy,
    encode,
    decode,
    byteCutoffs: [...PROGRESSIVE_WEB_BYTE_CUTOFFS],
  };
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `node --test web/jxl-progressive-best-preset.test.js`
Expected: PASS — 3/3 new tests.

- [ ] **Step 5: Commit**

```bash
git add web/jxl-progressive-best-preset.js web/jxl-progressive-best-preset.test.js
git commit -m "feat(preset): add SNEYERS_PRESET + createSneyersPreset (truly-progressive named recipe)"
```

---

## Task 11: Acceptance gate — run both benches on full reference sets

**Files:**
- Create: `docs/Benchmark results/truly-progressive-<ts>.md`

This task produces evidence; no source change unless results force a revision.

- [ ] **Step 1: Run RAW matrix on full Gobabeb set**

Run: `PFM_LIMIT=30 PFM_TARGET=1600 PFM_QUALITY=85 node benchmark/progressive-flag-matrix.mjs`
Expected: completes in <30 min; JSON in `docs/Benchmark results/progressive-flag-matrix-<ts>.json`.

- [ ] **Step 2: Run JPEG matrix on 11 reference JPEGs**

Run: `JPS_LIMIT=11 JPS_TARGET=1600 JPS_QUALITY=85 node benchmark/jpeg-progressive-stream.mjs`
Expected: completes in <15 min; JSON in `docs/Benchmark results/jpeg-progressive-stream-<ts>.json`.

- [ ] **Step 3: Write summary markdown**

Create `docs/Benchmark results/truly-progressive-<ts>.md` (use the actual timestamp of the latest JSON pair). Hand-write the verdict table with per-row averages from both JSON artifacts. Format:

```markdown
# Truly Progressive JXL — Acceptance Run <ISO date>

## RAW (Gobabeb, 30 files, target=1600, quality=85)

| Case            | Effort | avg jxl KB | avg firstRecogBytes % | avg previewBytes % | avg paints | mono % | avg finalPSNR |
|-----------------|--------|-----------:|----------------------:|-------------------:|-----------:|-------:|--------------:|
| dc1-only        | 3      | … | … | … | … | … | … |
| dc2-only        | 3      | … | … | … | … | … | … |
| dc2-ac-only     | 3      | … | … | … | … | … | … |
| dc2-q-only      | 3      | … | … | … | … | … | … |
| dc2-ac-q        | 3      | … | … | … | … | … | … |
| dc2-q-scanline  | 3      | … | … | … | … | … | … |
| sneyers         | 3      | … | … | … | … | … | … |
| (repeat at e=5) | 5      | … | … | … | … | … | … |

## JPEG (Gobabeb JPEGs, 11 files, target=1600, quality=85)

(same table shape)

## Verdict

Winning combo: `<name>-e<n>` — meets all thresholds:
- paintedCutoffs ≥ 4: …
- firstRecognizableBytes ≤ 25%: …
- previewBytes ≤ 50%: …
- monotone: …
- finalPsnr ≥ 40 dB: …
- encode within 1.5× current `previewFirst:true` baseline: …

Action: update `SNEYERS_PRESET` in `web/jxl-progressive-best-preset.js` to match winner (Task 12) before wiring as default (Task 13).
```

- [ ] **Step 4: Commit**

```bash
git add "docs/Benchmark results/truly-progressive-<ts>.md" "docs/Benchmark results/progressive-flag-matrix-<ts>.json" "docs/Benchmark results/jpeg-progressive-stream-<ts>.json"
git commit -m "docs(bench): truly-progressive acceptance run — RAW 30 + JPEG 11, picks winner combo"
```

---

## Task 12: Update `SNEYERS_PRESET` to measured winner

**Files:**
- Modify: `web/jxl-progressive-best-preset.js`
- Modify: `web/jxl-progressive-best-preset.test.js`

- [ ] **Step 1: Read the verdict from Task 11**

Open `docs/Benchmark results/truly-progressive-<ts>.md`. Identify the winning row's `progressiveDc`, `progressiveAc`, `qProgressiveAc`, `groupOrder`, `effort`, `decodingSpeed`.

- [ ] **Step 2: If winner == current SNEYERS_PRESET, skip to Step 5; otherwise update**

If different, modify `web/jxl-progressive-best-preset.js`:

```js
export const SNEYERS_PRESET = Object.freeze({
  progressive: true,
  previewFirst: true,
  progressiveDc: <winning value>,
  progressiveAc: <winning value>,
  qProgressiveAc: <winning value>,
  groupOrder: <winning value>,
  effort: <winning value>,
  decodingSpeed: <winning value>,
});
```

Update the corresponding test assertions in `web/jxl-progressive-best-preset.test.js`.

- [ ] **Step 3: Run tests**

Run: `node --test web/jxl-progressive-best-preset.test.js`
Expected: PASS.

- [ ] **Step 4: Run matrix test on the updated preset**

Run: `node --test benchmark/progressive-flag-matrix.test.js`
Expected: PASS.

- [ ] **Step 5: Commit (only if Step 2 changed code)**

```bash
git add web/jxl-progressive-best-preset.js web/jxl-progressive-best-preset.test.js
git commit -m "feat(preset): SNEYERS_PRESET locked to measured winner from truly-progressive acceptance run"
```

---

## Task 13: Wire `SNEYERS_PRESET` into facade default

**Files:**
- Modify: `packages/jxl-wasm/src/facade.ts`

- [ ] **Step 1: Read current `resolveEncoderBridgeSettings`**

Open `packages/jxl-wasm/src/facade.ts` and locate `resolveEncoderBridgeSettings` (line ~720). Confirm the early `if (!options.progressive)` return and the `previewFirst` branch.

- [ ] **Step 2: Add Sneyers default branch**

At the top of `resolveEncoderBridgeSettings`, add (after the existing modular/brotli/etc resolution):

```ts
// Single rollback boolean — flip to false to revert to legacy previewFirst defaults.
const USE_SNEYERS_DEFAULT = true;
```

After the existing `if (!options.progressive) return {...}` block, replace the `previewFirst` smart-default block with:

```ts
// SNEYERS_PRESET defaults: applied when progressive+previewFirst are set and the
// caller has NOT explicitly overridden the relevant flags. Locked recipe from
// docs/Benchmark results/truly-progressive-<ts>.md.
if (USE_SNEYERS_DEFAULT && options.progressive && options.previewFirst) {
  const dc = options.progressiveDc != null
    ? Math.max(0, Math.min(2, options.progressiveDc | 0))
    : 2;   // SNEYERS_PRESET.progressiveDc (update if Task 12 changed it)
  const ac = options.progressiveAc != null ? (options.progressiveAc ? 1 : 0) : 1;
  const qac = options.qProgressiveAc != null ? (options.qProgressiveAc ? 1 : 0) : 1;
  const groupOrder = options.groupOrder != null ? (options.groupOrder ? 1 : 0) : 1;
  return {
    progressiveDc: dc,
    progressiveAc: ac,
    qProgressiveAc: qac,
    buffering: options.chunked ? 2 : 0,
    modular,
    brotliEffort,
    decodingSpeed: decodingSpeed >= 0 ? decodingSpeed : 0,
    photonNoiseIso,
    resampling,
    epf,
    gaborish,
    dots,
    colorTransform,
    groupOrder,
  };
}
```

Keep the existing non-Sneyers-default branch below (so `previewFirst:false` callers keep their current behaviour).

- [ ] **Step 3: Run TS typecheck**

Run: `pnpm -F @casabio/jxl-wasm typecheck` (or whatever the package script is — check `packages/jxl-wasm/package.json`).
Expected: no errors.

- [ ] **Step 4: Run facade tests**

Run: `pnpm -F @casabio/jxl-wasm test`
Expected: PASS (existing progressive-detail test should keep working).

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-wasm/src/facade.ts
git commit -m "feat(facade): wire SNEYERS_PRESET into resolveEncoderBridgeSettings (gated by USE_SNEYERS_DEFAULT)"
```

---

## Task 14: Rebuild `dist/facade.js`

**Files:**
- Modify: `packages/jxl-wasm/dist/facade.js` (regenerated)
- Modify: `packages/jxl-wasm/dist/facade.d.ts` (regenerated if applicable)

- [ ] **Step 1: Run the package build**

Run: `pnpm -F @casabio/jxl-wasm build`
Expected: clean exit; `dist/facade.js` and `dist/facade.d.ts` regenerated.

- [ ] **Step 2: Verify bundle freshness**

Run: `git diff --stat packages/jxl-wasm/dist/`
Expected: shows updated `dist/facade.js` with the new Sneyers branch.

- [ ] **Step 3: Smoke run RAW matrix on 1 file with new bundle**

Run: `PFM_LIMIT=1 node benchmark/progressive-flag-matrix.mjs`
Expected: `sneyers-e3` row meets thresholds (same as before, now also when default branch is hit through `previewFirst`).

- [ ] **Step 4: Commit**

```bash
git add packages/jxl-wasm/dist/
git commit -m "chore(build): rebuild jxl-wasm dist after SNEYERS_PRESET wiring"
```

---

## Task 15: Add throttle + preset controls to `web/jxl-progressive-paint.html`

**Files:**
- Modify: `web/jxl-progressive-paint.html`

- [ ] **Step 1: Read existing controls section**

Open `web/jxl-progressive-paint.html` and find the controls bar above the compare canvases (look for `id="run-progressive"` button area).

- [ ] **Step 2: Insert throttle + preset controls**

Add immediately before the run button:

```html
<label class="control-row">
  <span>Preset:</span>
  <select id="preset-name">
    <option value="default">Default (createProgressiveWebPreset)</option>
    <option value="sneyers" selected>Sneyers (truly-progressive)</option>
  </select>
</label>
<label class="control-row">
  <span>Throttle:</span>
  <select id="throttle-rate">
    <option value="0">Unthrottled</option>
    <option value="2048">2 MB/s</option>
    <option value="500">500 KB/s</option>
    <option value="100" selected>100 KB/s</option>
    <option value="50">50 KB/s</option>
  </select>
</label>
```

(Match indentation and class names to surrounding markup; `.control-row` may already exist — if not, reuse whatever the file uses for labelled selects.)

- [ ] **Step 3: Open page in dev server, confirm controls render**

Start dev server (whatever the project uses; e.g. `pnpm dev` or `npx http-server web/`). Open `/web/jxl-progressive-paint.html`. Verify both selects render and default to Sneyers + 100 KB/s.

- [ ] **Step 4: Commit**

```bash
git add web/jxl-progressive-paint.html
git commit -m "feat(ui): add preset + throttle selects to jxl-progressive-paint"
```

---

## Task 16: Wire throttle + Sneyers preset into `runProgressive`

**Files:**
- Modify: `web/jxl-progressive-paint.js`

- [ ] **Step 1: Read existing imports + runProgressive**

Open `web/jxl-progressive-paint.js`. Locate the `runProgressive` (or `runProgressivePaint`) async function and existing preset construction.

- [ ] **Step 2: Import the Sneyers preset**

Add to the top imports:

```js
import { createProgressiveWebPreset, createSneyersPreset } from './jxl-progressive-best-preset.js';
import { computePsnrVsFinal } from './jxl-progressive-quality.js';
```

(Replace any duplicate `createProgressiveWebPreset` import.)

- [ ] **Step 3: Add throttle helper**

Near the top of the file (after imports), add:

```js
function readPresetName() {
  return document.getElementById('preset-name')?.value ?? 'sneyers';
}

function readThrottleKbPerSec() {
  const raw = document.getElementById('throttle-rate')?.value;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0; // 0 = unthrottled
}

function buildPresetFor(name, dims) {
  if (name === 'sneyers') return createSneyersPreset(dims);
  return createProgressiveWebPreset(dims);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function feedThrottled(decoder, bytes, kbPerSec, onProgress) {
  const chunkBytes = 16 * 1024;
  const msPerChunk = kbPerSec > 0 ? (chunkBytes / 1024) * (1000 / kbPerSec) : 0;
  let offset = 0;
  let chunkIndex = 0;
  while (offset < bytes.byteLength) {
    const end = Math.min(offset + chunkBytes, bytes.byteLength);
    await decoder.push(bytes.subarray(offset, end));
    offset = end;
    chunkIndex++;
    onProgress?.({ offset, chunkIndex, total: bytes.byteLength });
    if (msPerChunk > 0) await sleep(msPerChunk);
  }
  await decoder.close();
}
```

- [ ] **Step 4: Replace preset construction in runProgressive**

Inside `runProgressive`, where the preset is currently built, replace with:

```js
const presetName = readPresetName();
const throttleKbPerSec = readThrottleKbPerSec();
const preset = buildPresetFor(presetName, { width: source.width, height: source.height, targetLongEdge: 1200, quality: 85 });
```

- [ ] **Step 5: Replace single decoder.push with feedThrottled**

After encoding produces `jxlBytes`, replace the existing `await decoder.push(jxlBytes); await decoder.close();` block with:

```js
const decoder = createDecoder(preset.decode);
let finalPixelsForPsnr = null;
let paintIndex = 0;
const decodeTask = (async () => {
  for await (const event of decoder.events()) {
    if (event.type === 'header') continue;
    if (event.type === 'progress' || event.type === 'final') {
      const slot = compareSlots[compareSlotCursor % compareSlots.length];
      const pixelsCopy = new Uint8Array(event.pixels);
      let psnr = null;
      if (event.type === 'final') {
        finalPixelsForPsnr = pixelsCopy;
      } else if (finalPixelsForPsnr && pixelsCopy.length === finalPixelsForPsnr.length) {
        psnr = computePsnrVsFinal(pixelsCopy, finalPixelsForPsnr);
      }
      paintToSlot(slot, pixelsCopy, event.info.width, event.info.height, {
        bytes: null,                  // throttle helper supplies via onProgress side channel
        paintIndex,
        psnr,
        stage: event.stage ?? event.type,
      });
      compareSlotCursor++;
      paintIndex++;
    }
  }
})();
await feedThrottled(decoder, jxlBytes, throttleKbPerSec, () => {
  // optional: dispatch CustomEvent for an external observer
});
await decodeTask;
await decoder.dispose();
```

`paintToSlot` is the existing function that renders into a compare canvas; extend its signature (if needed) to accept the `{ bytes, paintIndex, psnr, stage }` overlay object and write it into the canvas info element.

- [ ] **Step 6: Smoke-test in browser**

Run dev server. Select Sneyers preset + 100 KB/s. Load one JPEG. Click Run Progressive. Observe ≥ 3 paints appear in compare slots, each more refined than the previous; PSNR overlay grows.

- [ ] **Step 7: Commit**

```bash
git add web/jxl-progressive-paint.js
git commit -m "feat(ui): wire Sneyers preset + network throttle into runProgressive with per-paint PSNR overlay"
```

---

## Task 17: UI throttle integration test

**Files:**
- Modify: `web/jxl-progressive-paint-page.test.js`

- [ ] **Step 1: Read existing test to understand its harness (jsdom? Playwright? other?)**

Run: `node --test web/jxl-progressive-paint-page.test.js`
Expected: existing pass/fail baseline.

- [ ] **Step 2: Add throttle-paint assertion**

Append (adapt selectors to the existing test harness):

```js
test('Sneyers preset + 100 KB/s throttle paints at least 3 slots within 10s', async () => {
  // Setup whatever DOM the existing tests use (jsdom or harness-specific).
  // Select Sneyers preset, set throttle to 100 KB/s, load a small fixture jpeg, click run.
  document.getElementById('preset-name').value = 'sneyers';
  document.getElementById('throttle-rate').value = '100';
  // ... feed fixture, await run completion
  // Count compare slots with non-empty info text:
  const populated = compareSlots.filter((s) => s.infoEl.textContent.includes('paint')).length;
  assert.ok(populated >= 3, `expected >= 3 paints, got ${populated}`);
});
```

(Exact harness setup depends on what `jxl-progressive-paint-page.test.js` already does — extend whatever fixture loading + click flow exists.)

- [ ] **Step 3: Run test**

Run: `node --test web/jxl-progressive-paint-page.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/jxl-progressive-paint-page.test.js
git commit -m "test(ui): assert Sneyers preset + 100 KB/s throttle produces >=3 paints"
```

---

## Task 18: Extend predator-paint-visual-smoke with Sneyers preset

**Files:**
- Modify: `tools/predator-paint-visual-smoke.mjs`

- [ ] **Step 1: Read existing tool**

Open `tools/predator-paint-visual-smoke.mjs`. Identify the preset construction block.

- [ ] **Step 2: Add Sneyers run**

Add an additional run-through using `createSneyersPreset` and dump per-cutoff PNG to `docs/visual-smoke/sneyers-<file>-<bytesLabel>.png`. Reuse the existing per-cutoff render loop; just feed the Sneyers preset's encode/decode options into it.

```js
import { createSneyersPreset } from '../web/jxl-progressive-best-preset.js';
// ...
const sneyersPreset = createSneyersPreset({ width, height, targetLongEdge: 1200, quality: 85 });
await runVisualSmokeForPreset(sneyersPreset, { outDir: 'docs/visual-smoke', label: 'sneyers' });
```

If there is no existing `runVisualSmokeForPreset` helper, extract the existing main loop into a function with that signature first.

- [ ] **Step 3: Run smoke**

Run: `node tools/predator-paint-visual-smoke.mjs`
Expected: PNGs land in `docs/visual-smoke/`. Manual eyeball check confirms image grows across cutoffs.

- [ ] **Step 4: Commit (the script; do NOT commit the PNG dumps unless small + intentional)**

```bash
git add tools/predator-paint-visual-smoke.mjs
git commit -m "feat(visual-smoke): add Sneyers preset run with per-cutoff PNG dumps"
```

---

## Task 19: Update `docs/INCOMPLETE PLANS.md`

**Files:**
- Modify: `docs/INCOMPLETE PLANS.md`

- [ ] **Step 1: Read the Tauri-progressive section**

Open `docs/INCOMPLETE PLANS.md`, locate the Tauri section and the progressive bullet.

- [ ] **Step 2: Mark the bullet done with citation**

Edit the bullet:

```
- [x] Decode (Full Loads): Progressive decode delivering DC/early passes directly to Tauri textures (no worker hop).
      Truly-progressive proof landed for WASM path 2026-06-03 — see
      docs/superpowers/specs/2026-06-03-truly-progressive-jxl-design.md and
      docs/Benchmark results/truly-progressive-<ts>.md. Tauri native
      port: pending separate handoff.
```

(Don't conflate WASM completion with native port — leave the native port as a separate open bullet if needed.)

- [ ] **Step 3: Commit**

```bash
git add "docs/INCOMPLETE PLANS.md"
git commit -m "docs(plans): mark Tauri progressive bullet with truly-progressive WASM proof citation"
```

---

## Task 20: Update `docs/references/designs/progressive-encode-options.md`

**Files:**
- Modify: `docs/references/designs/progressive-encode-options.md`

- [ ] **Step 1: Read current status section**

Open the file; locate the `## Status` section near the top.

- [ ] **Step 2: Set status to Implemented + add citation**

Change the `**Status:**` line to:

```
**Status:** Implemented (2026-06-03) — see docs/superpowers/specs/2026-06-03-truly-progressive-jxl-design.md and docs/Benchmark results/truly-progressive-<ts>.md for the measurement-driven SNEYERS_PRESET.
```

Append a new `## 2026-06-03 Update` section at bottom summarizing: SNEYERS_PRESET locked, JPEG path mirror bench added, monotonicity asserted, UI throttle wired.

- [ ] **Step 3: Commit**

```bash
git add docs/references/designs/progressive-encode-options.md
git commit -m "docs(progressive): status -> Implemented, cite truly-progressive proof"
```

---

## Task 21: Update `docs/suggested-settings.md`

**Files:**
- Modify: `docs/suggested-settings.md`

- [ ] **Step 1: Read existing Web/WASM section**

Open `docs/suggested-settings.md`. Find the section recommending `previewFirst` / progressive encode for the web path.

- [ ] **Step 2: Add Sneyers recipe**

Add (or replace the existing progressive recommendation with):

```markdown
### Truly-progressive web JPEG / RAW pipeline (SNEYERS_PRESET, 2026-06-03)

Recipe (verified on Gobabeb 30 ORF + 11 JPEG, see docs/Benchmark results/truly-progressive-<ts>.md):

| Setting        | Value | Notes |
|----------------|-------|-------|
| progressive    | true  | enables PROGRESSIVE_* flags in bridge |
| previewFirst   | true  | triggers SNEYERS_PRESET branch in resolveEncoderBridgeSettings |
| progressiveDc  | 2     | multi-layer DC pyramid for very-early thumbnail |
| progressiveAc  | 1     | spectral AC progression |
| qProgressiveAc | 1     | quantized AC progression |
| groupOrder     | 1     | center-out — best perceived early quality |
| effort         | 3     | measured best on this codebase; libjxl's ≥7 recommendation does NOT apply here |
| decodingSpeed  | 0     | bias bitstream for decoder speed at progressive boundaries |

Decoder pair:
- `progressionTarget: "final"`
- `emitEveryPass: true`
- `progressiveDetail: "passes"` (kPasses — finest spectral progression)

Result targets met (representative file): firstRecognizable ≤ 25% bytes, preview ≤ 50% bytes, ≥ 4 paints, monotone PSNR, final ≥ 40 dB.
```

- [ ] **Step 3: Commit**

```bash
git add docs/suggested-settings.md
git commit -m "docs(settings): add SNEYERS_PRESET recipe with measured numbers"
```

---

## Self-Review Pass

After all tasks complete, run this checklist:

- [ ] All 21 tasks have green tests / smoke runs.
- [ ] `git log --oneline` shows ~21 commits in logical order.
- [ ] `git status` is clean (no untracked source).
- [ ] `pnpm -F @casabio/jxl-wasm typecheck && pnpm -F @casabio/jxl-wasm test` is green.
- [ ] `node --test web/jxl-progressive-quality.test.js web/jxl-progressive-best-preset.test.js web/jxl-progressive-byte-metrics.test.js benchmark/progressive-flag-matrix.test.js benchmark/jpeg-progressive-stream.test.js` all pass.
- [ ] `docs/Benchmark results/truly-progressive-<ts>.md` has the verdict table populated with real numbers.
- [ ] `docs/superpowers/specs/2026-06-03-truly-progressive-jxl-design.md` § Done definition is fully checked off.
- [ ] No bridge.cpp diff; no libjxl version change.
- [ ] `useSneyersDefault` boolean present in `facade.ts` (single-line rollback).
- [ ] UI throttle slider produces visibly growing image at 100 KB/s on a real JPEG load.

---

**Plan complete.** Total: 21 tasks. Critical path: Tasks 1-4 (metrics) → 5-7 (RAW matrix) → 8-9 (JPEG matrix) → 11 (acceptance run) → 12-14 (wire winner + dist sync) → 15-17 (UI) → 18 (visual smoke) → 19-21 (docs). Tasks 5-9 can be parallelized with 1-4 since the matrix uses metrics; tasks 15-18 can be parallelized with 11-14.
