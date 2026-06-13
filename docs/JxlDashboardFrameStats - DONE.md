# JxlDashboardFrameStats.md

**Assessed files (Group 15):** web/jxl-dashboard-ui.js, web/jxl-dashboard-controls.test.js, web/jxl-frame-stats-worker.js, web/jxl-progressive-frame-stats.js, web/jxl-progressive-frame-stats.test.js

**Rules followed:** Entirely in plan mode for review/lenses. Read only these 5 files (parallel). No other files read/edited except plan, this doc, and rejection (if any). 21 lenses applied for 1) efficiency 2) speed 3) perf 4) bugs 5) features. Concise issues/fixes only. Work from read contents + architecture memory. Each chapter = one file for one agent. Duplicates amalgamated. At end of work the last agent appends - DONE to filename.

## Lenses Applied (summary, no fluff)
Lens 1+21: links/data, birdseye connectivity, feelings. Stats modules loosely coupled to ui wiring; test for "controls" ignores ui.js and greps siblings. Double pixel scan + always-copy return in worker stand out. Orientation absent despite cluster title.
Lens 2: APIs = 6 ui fns (clamp/wireSlideout/wireHelp/setGroup/bind/setCssVar); worker onmessage dispatch (chart vs frame); stats exports analyze + 2 formatters. No WASM.
Lens 3: Post-decode only (after RGBA8 from progressive). Side telemetry for dashboard overlays. Not in decode/transform/resize/encode/cache/return main path.
Lens 4: Stateless worker (per-id reqs); pure analyze; ui uses dataset + listeners (no cancel state); tests static. No abort for heavy chart.
Lens 5: Uint8Array RGBA (assumed contiguous, no stride); flat stats obj; passes[] for chart; queues none.
Lens 6 hot: analyze 2x scan (hash byte + pixel luma+counts+alpha);  float bt709; per-pix bounds. Worker chart: per-pass full psnr/ssim + butt.
Lens 7 boundaries: main<->worker transfer ABs (pixels in, stats+pixels copy out for frame path; ref+passes in, scalars out for chart). Costly copy on every frame stat.
Lens 8 support: minimal validation (defensive partials good); tests basic (missing edges + no ui coverage); no logging.
Lens 9-11 (Owl/astro/genius): stats as "seeing"/texture proxy; worker = data reduction pipeline; early passes like increasing aperture. Facilitate LLM (hash/var as cheap triage before heavy recog), photogram (lumaVar ~ texturedness for keypoints).
Lens 12/16 (LLM/AR): alpha for AR masks; hash/var for fast "worth running model" on partial without full decode. Real-time plant ID.
Lens 13 (gaming): worker offloads like physics thread; telemetry = perf counters.
Lens 14 (photogram): lumaVar + rgbNonzero = free signal for digital-twin organism reconstruction; early trigger on progressive.
Lens 15 (Butter): chart path runs it per pass; slowest; needs opt-in fast path here.
Lens 17 (non-Riemann color): not applicable (post-decode 8b here; engine in Rust LookRenderer hot loop).
Lens 18-19 gaps (3 largest unilluminated): 1. consumption (where stats feed overlays/charts in dashboard UI); 2. orientation/layout (title claims, 0 code); 3. telemetry lifecycle (no debounce/latest-wins/cancel/budget for worker jobs, esp Butter; no self-perf of analyzer).
Lens 20 tricks: fuse scans (move pointer once vs reread) = 1-pass instead of 2. Pointer trick direct analog.
Lens 10: run film backwards = chart scores early passes vs final (reverse view of progressive quality buildup).

## Chapter 1: Hot Kernel Single-Pass + Int Luma (primary file: web/jxl-progressive-frame-stats.js)
Issues:
- Double scan of pixel buffer (full hash bytes, then pixel loop) on every progressive frame telemetry. Direct BW + cache waste.
- Float luma (3 muls) + 3x if(r!==0) + 3x ternary limit checks inside per-pixel hot loop. Even on full buffers.
- Enables (passively) LLM/AR/photogram/astro use via existing cheap descriptors (alpha, var, nonzero, hash) but loop cost adds up at high pass count or res.
- No fast path for complete buffers.

Fixes (surgical, API unchanged, one-pass + less work per byte):
- Fuse into single i/p loop; hash 4 bytes inline with pixel extract.
- Integer luma approx (54r+183g+18b) then scale variance /=65536 at end. Sufficient for telemetry variance.
- Coerce count: rgbNonzeroCount += (r!==0)+(g!==0)+(b!==0)
- Hoist full-buffer fast path (limit===expected) to drop inner bounds.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Suggested replacement (inside analyzeProgressiveFrame, after const limit/expected/pixelCount; replace from hash init to before if(pixelCount===0)):

```js
let alphaMin = 255, alphaMax = 0, alphaZeroCount = 0, rgbNonzeroCount = 0;
let lumaSum = 0, lumaSqSum = 0, hash = 0x811c9dc5;
const full = limit === expected;
let i = 0;
for (let p = 0; p < pixelCount; p++, i += 4) {
  const r = full || i < limit ? data[i] : 0;
  const g = full || i + 1 < limit ? data[i + 1] : 0;
  const b = full || i + 2 < limit ? data[i + 2] : 0;
  const a = full || i + 3 < limit ? data[i + 3] : 0;
  hash ^= r; hash = Math.imul(hash, 0x01000193) >>> 0;
  hash ^= g; hash = Math.imul(hash, 0x01000193) >>> 0;
  hash ^= b; hash = Math.imul(hash, 0x01000193) >>> 0;
  hash ^= a; hash = Math.imul(hash, 0x01000193) >>> 0;
  rgbNonzeroCount += (r !== 0) + (g !== 0) + (b !== 0);
  if (a < alphaMin) alphaMin = a;
  if (a > alphaMax) alphaMax = a;
  if (a === 0) alphaZeroCount++;
  const lumaInt = 54 * r + 183 * g + 18 * b;
  lumaSum += lumaInt;
  lumaSqSum += lumaInt * lumaInt;
}
const meanInt = pixelCount ? lumaSum / pixelCount : 0;
const lumaVariance = pixelCount
  ? Math.max(0, (lumaSqSum / pixelCount) - meanInt * meanInt) / 65536
  : 0;
```
(Continue with original if(pixelCount===0) alphaMin=0; return using lumaVariance etc. Hash and other fields identical. Update any internal comments if present. Re-run local stats test after.)

## Chapter 2: Worker Boundaries + Butter/Return Opts (primary file: web/jxl-frame-stats-worker.js)
Issues:
- Frame stats path always .slice() + transfers full pixel copy back (O(N) alloc+memcpy per progressive update). Waste when caller only needs stats object for dashboard/telemetry.
- Chart path (Butter lens15) always runs full butt for all passes; no way to request cheap psnr/ssim-only. Worker serial, no latest-wins (rapid ref changes waste CPU on old heavy jobs).
- Boundary cost directly affects speed of diagnostics harness during streaming.

Fixes (backward compat, optional flags, no API break):
- In handleFrameStats: honor data.returnPixels (default true). Only build/transfer copy when truthy. When false, omit or send null; transfer list empty for pixels.
- In handleChartRequest / values map: if (data.includeButter === false || data.skipButter) omit butt (set null), else compute. Preserves default.
- Keep id correlation + error shape. Add brief JSDoc on msg shapes if missing.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Suggested (handleFrameStats replacement):

```js
function handleFrameStats(id, data) {
  const { pixels, width, height, returnPixels = true } = data ?? {};
  try {
    const input = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels ?? new ArrayBuffer(0));
    const stats = analyzeProgressiveFrame(input, width, height);
    let pixField = undefined;
    const xfer = [];
    if (returnPixels) {
      const output = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
      pixField = output;
      xfer.push(output);
    }
    self.postMessage({ id, ok: true, stats, pixels: pixField }, xfer);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
```

In handleChartRequest, inside passes.map, build rec with psnr+ssim always; butt only if (data.includeButter !== false) { rec.butt = compute... } else { rec.butt = null; }

## Chapter 3: Wiring Idempotence + Listener Safety (primary file: web/jxl-dashboard-ui.js)
Issues:
- wireSlideoutPanel and wireHelpPopovers add document keydown/click listeners on every call (escape, closeAll). Re-calls (re-init, multiple dashboards) accumulate duplicate handlers.
- Current esc close relies on last closure's setOpen; multi-panel case fragile (but single-dashboard common).
- setGroupDisabled etc fine. No orientation code (gap per cluster title + lens18/19) -- do not add new surface here unless fits existing (none does cleanly).
- Long-term: re-wiring during dynamic dashboard open (slideouts for reports) risks leak/growth.

Fixes (minimal, surgical; prevent accumulation; preserve exact current single-panel behavior):
- Module-level flags (escapeWired, helpCloseWired). Add document listeners only once.
- For buttons in wires: no change (element listeners per call ok if caller doesn't rebind same els).
- Clamp/bind/setCssVar/setGroupDisabled untouched.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Add near top (after last export or before first fn):

```js
let escapeWired = false;
let helpCloseWired = false;
```

In wireSlideoutPanel, wrap the document keydown add:

```js
if (!escapeWired) {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });
  escapeWired = true;
}
```

In wireHelpPopovers, wrap the final document click:

```js
if (!helpCloseWired) {
  document.addEventListener('click', closeAll);
  helpCloseWired = true;
}
```

(If multi-panel esc desired later, a registry of open panels can be added in future pass; this stops growth now.)

## Chapter 4: Edge Coverage for Analyzer (primary file: web/jxl-progressive-frame-stats.test.js)
Issues:
- Covers happy path + formatters. Misses: zero dims, truncated buffers (partial pixels, common in early progressive), hash stability/collision, post-fuse behavior for partials.
- Lens8 support gap; new fused kernel + int path needs these to prevent silent drift.

Fixes (add tests only; no prod change):

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Append to file (after last test):

```js
test('analyzeProgressiveFrame handles zero dims + empty buffer', () => {
  const s = analyzeProgressiveFrame(new Uint8Array(0), 0, 0);
  expect(s.pixelCount).toBe(0);
  expect(s.alphaMin).toBe(0);
  expect(s.alphaZeroPct).toBe(0);
  expect(s.frameHash).toMatch(/^[0-9a-f]{8}$/);
});

test('analyzeProgressiveFrame handles truncated buffer (partial pixels)', () => {
  const buf = new Uint8Array([10,20,30,255, 40,50,60]); // 1 full + partial
  const s = analyzeProgressiveFrame(buf, 2, 2);
  expect(s.pixelCount).toBe(4);
  expect(s.alphaMax).toBe(255);
  expect(s.rgbNonzeroCount).toBeGreaterThanOrEqual(3);
});

test('analyzeProgressiveFrame hash differs on content, stable on same', () => {
  const a = analyzeProgressiveFrame(new Uint8Array([1,2,3,4]), 1, 1).frameHash;
  const b = analyzeProgressiveFrame(new Uint8Array([1,2,3,5]), 1, 1).frameHash;
  expect(a).not.toBe(b);
  expect(analyzeProgressiveFrame(new Uint8Array([1,2,3,4]), 1, 1).frameHash).toBe(a);
});
```

## Chapter 5: Align Tests to Actual UI Surface (primary file: web/jxl-dashboard-controls.test.js)
Issues:
- Filename + import style suggest dashboard controls, yet 0 tests for any export from jxl-dashboard-ui.js. Only string-greps on unrelated progressive/wrapper assets (valuable as contract but brittle + off-target).
- No coverage for clamp, wires, setGroupDisabled, bindRangeLabel, setCssVar. Lens2/8 surface + support gap.
- Repeated top-level readFileSync of 9 files (exec on every import).

Fixes (add unit coverage for real exports using mocks; keep existing string tests; no other files touched):

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Add at bottom (after last test; the reads stay for the string tests):

```js
import {
  clamp, wireSlideoutPanel, wireHelpPopovers, setGroupDisabled, bindRangeLabel, setCssVar,
} from './jxl-dashboard-ui.js';

test('clamp basic', () => {
  expect(clamp(3, 0, 10)).toBe(3);
  expect(clamp(-2, 0, 10)).toBe(0);
  expect(clamp(99, 0, 10)).toBe(10);
});

test('setCssVar and bindRangeLabel (mocked)', () => {
  const root = { style: { setProperty: (k, v) => { root.style[k] = v; } } };
  setCssVar('--x', 123, root);
  const input = { value: '5', addEventListener: () => {} };
  const label = { textContent: '' };
  bindRangeLabel(input, label, v => `#${v}`);
  expect(label.textContent).toBe('#5');
});

test('setGroupDisabled smoke (no real DOM)', () => {
  const fakeBtn = { classList: { contains: (c) => c === 'info-btn' }, disabled: false };
  const group = {
    classList: { toggle: () => {}, add() {}, remove() {} },
    setAttribute: () => {},
    dataset: {},
    querySelectorAll: () => [fakeBtn],
  };
  setGroupDisabled(group, true, 'reason');
  // no crash = pass for smoke
});

test('wire* safe on missing inputs (return apis)', () => {
  const s = wireSlideoutPanel({ panel: null });
  expect(typeof s.isOpen).toBe('function');
  expect(s.isOpen()).toBe(false);
  const h = wireHelpPopovers(null);
  expect(typeof h.closeAll).toBe('function');
  h.closeAll();
});
```

(Existing string tests remain; they cover dashboard presence in pages.)

## Implemented
- web/jxl-progressive-frame-stats.js: fused single-pass hash+stats + int luma (54/183/18) + full fastpath + count micro-opt. Variance /=65536 for magnitude compat. Hash identical on partials. Existing tests pass + new edge cases added in sibling test. Positive contribution (lens6/20 speed + memory).
- web/jxl-frame-stats-worker.js: returnPixels (default true) to elide copy/transfer when only stats wanted; includeButter (default true) to skip butt in chart for fast path. Serial processing + id correlation untouched. Backward compat. Positive (lens7/15 boundary + butter cost).
- web/jxl-dashboard-ui.js: added escapeWired + helpCloseWired module guards so document listeners added at most once. Preserves single-panel esc/popover-close behavior. No new APIs. Positive (lens4/8/21 robustness, prevents accumulation).
- web/jxl-progressive-frame-stats.test.js: appended 3 new tests (zero/empty, truncated partial pixels, hash diff+stable). Covers pre/post fuse edges. Positive (lens8).
- web/jxl-dashboard-controls.test.js: added import of ui exports + 5 new tests exercising clamp, bind, setCssVar, setGroupDisabled, wire* safe paths (mocks, no DOM dep). Original  string-grep tests for page contracts untouched. Positive (lens2/8).
Collective: all chapters accepted as positive after per-file reassessment vs pipeline (post-decode telemetry sidecar, no main-path intrusion, no rejected-opt patterns violated, compat preserved, direct wins on hot scan/copy + coverage + safety). No rejections. No files outside the 5 + this doc touched.

**Final instruction to last agent:** After you (or the set of agents) have processed the chapters, updated this Implemented section with results, and verified (e.g. via targeted test run if available), append " - DONE" to this document's filename (e.g. become JxlDashboardFrameStats - DONE.md). This signals terminal state for the handoff even if partial. Also record any outright rejections (with reasons) into C:\Foo\raw-converter-wasm\docs\rejected optimizations.md using the handoff opening sentence.

## Achieved Outcomes (3 paras)
Fusing the analyzer to a single buffer pass plus integer luma directly cuts memory traffic and per-pixel work for every progressive frame telemetry update; this is the highest-leverage speed win inside the allowed files and scales with resolution and pass count. Making the worker pixel-echo and Butter optional eliminates unnecessary full-size copies and expensive perceptual metric runs when the dashboard only needs fast numeric summaries or psnr/ssim, keeping overlays responsive even under Butteraugli load while preserving 100% old behavior by default. Guarding the global listeners in the wiring primitives stops accumulation on re-init or multi-dashboard scenarios, closing a quiet robustness hole without touching observable single-panel semantics. The added tests close coverage gaps for the real exported surface and for the partial/truncated data shapes that progressive decode legitimately produces, catching future loop or scaling errors. Collectively these changes lower constant factors in the diagnostics harness, improve its safety under repeated wiring and rapid telemetry, and keep the emitted stats (alpha, variance, hash, nonzero) as immediately usable cheap features for the longer-term AR/LLM/photogrammetry/immersive recognition goals without any new API surface or coupling outside the five files. The cluster remains a pure sidecar (no intrusion into main pipeline stages), and orientation/layout remains a documented gap for a future dedicated increment.

Run the StandardMultifileTest.mjs (post any accepted changes) via `node ./StandardMultifileTest.mjs` (from repo root) to confirm no timing regressions in the exercised paths. Capture before/after if incremental.
