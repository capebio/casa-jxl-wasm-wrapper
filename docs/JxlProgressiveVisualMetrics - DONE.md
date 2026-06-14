# JxlProgressiveVisualMetrics.md
Group 12 Round 2: Visual Saturation & Perceptual Metric Computation (web/)
Files (focus): jxl-progressive-quality.js, .test.js, jxl-progressive-byte-metrics.js, .test.js, jxl-butteraugli.js

## Overview (post R1 state)
Updated toolkit: quality (psnr + global ssim + generalized detect for any key/ direction), butter (XYB multi-scale + createComparer for batch reuse + approx + future comments), byte (classify + summarize now accepts quality/butter/ssimSeries, ensureSorted guard, firstPerceptuallyGood* + cross-monotone). Stronger links for early-term decisions. Still pure post-decode analysis. Ready for Perceptual Constancy pixels and external recog scores.

## Implementation Layers (sensible chunks)
### Layer 1: Hot Kernel Cleanup & Dup Removal (mainly butter + quality fill/dn)
### Layer 2: API Polish, Config & Helpers (auto series builder, exported thresholds, config for butter)
### Layer 3: Robustness, Error Consistency, Fallbacks (unify NaN/throw, improve preview when butter present, edges)
### Layer 4: Extensibility for Lens12/16/17/14 (features sidecar, self-stability, gradient contrib, color note)
### Layer 5: Tests & Cohesion (update/add in listed test files; for impl phase reassess connected callers if any for demo of new series)

## Amalgamated Issues + Fixes (from 21 lenses, post-R1)
See PLAN for trace. Key remaining: dup fill/dn, magic thresholds, legacy alloc path, no auto-builder, error inconsistency, preview fallback not perceptual-aware, limited hooks for ML/color/AR.

## Agent Handoffs (5 agents, 1 file each)
Order: butter.js, quality.js, byte-metrics.js, quality.test.js, byte-metrics.test.js. Each agent edits ONLY its primary file unless the specific item explicitly requires a tiny connected edit for cohesion (query allows "edit other files connected" after reassess vs pipeline; only if positive and minimal; otherwise reject to docs/rejected optimizations.md). Reassess every item in context of full pipeline (these remain offline metrics; must not affect decode/session/scheduler/WASM/progressive checkpoints; respect prior rejections; positive if speeds profiling, enables ML/AR validation, reduces dup/maintenance, no bloat). Use memory + 1 surgical read of *your* file only. Surgical search_replace. No inline chatter. All in Implemented chapter only.

### Agent for web/jxl-butteraugli.js
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Items (Layer1 + 2 + 4):
1. Remove dup fill: extract internal or extend pixelsToXyb to support out arrays for zero-alloc in comparer. Suggested (ambiguous part — choose one):
   ```js
   // option A (minimal change): add optional outs
   export function pixelsToXyb(pixels, n, outX, outY, outB) {
     const X = outX || new Float32Array(n);
     ... fill X Y B ...
     return [X, Y, B];
   }
   // then in comparer: pixelsToXyb(testPixels, n, tX, tY, tB); no return needed, ignore.
   ```
   (Or private _fillXyb. Pick cleanest that keeps public sig.)
2. Reduce dn dup in comparer: call dn2 where possible or make dn2 accept out. Or keep inline but comment "dup for in-place".
3. Make butter configurable (weights, k's, good default) for experiments (lens15/17). Add to createComparer and approx/compute:
   ```js
   export function createButteraugliComparer(refPixels, width, height, opts = {}) {
     const { weights = [4,2,1], k = {kX:24, kY:12, kB:4} /*...*/ } = opts;
     ...
     // pass down to scaleErr or close over
   }
   ```
4. Optional gradient for photogram (layer4, behind flag or separate scaleErrGrad):
   Simple sobel on Y or full, add weighted term if (opts.includeGradient).
5. Future comment already good; enhance slightly for lens17 drift note if needed.
6. (If positive after reassess) tiny connected: if a web/ caller hardcodes direct compute for batch, update call to comparer — but only if you read it and confirm win.

### Agent for web/jxl-progressive-quality.js
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Items (Layer1 + 2):
1. Support out arrays in compute paths? Minor for SSIM moments (already accum no alloc hot). For consistency with butter, optional.
2. Expose more for features (lens12): e.g. after SSIM, return the per-ch moments too? Or a computeMoments helper.
   ```js
   export function computeChannelMoments(pixels, w, h) { ... return {mu, var, ...} per ch; }
   ```
3. Minor: 0-len explicit in ssim (current may div0 on np=0); add guard return 0.
4. Comments already cover future; keep or tighten.

### Agent for web/jxl-progressive-byte-metrics.js
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Items (Layer2 + 3 + 4 main):
1. Add auto series builder helper (big cohesion win, layer2):
   ```js
   // new export or internal
   export function buildQualitySeries(refPixels, cutoffPixelArrays, width, height) {
     // uses create... from butter if avail, computePsnr etc.
     const refX = /*...*/; // or import
     return {
       qualitySeries: cutoffPixelArrays.map((p,i) => ({bytes: ???, psnr: computePsnrVsFinal(p, refPixels)} )), // bytes caller provided?
       butterSeries: cutoffPixelArrays.map(p => ({bytes: , butter: createComparer(refPixels,width,height)(p) }))
     };
   }
   ```
   (Ambiguous: bytes how supplied? Assume parallel array of byte sizes, or return without bytes. Decide clean.)
2. Improve preview fallback when butterSeries present: use butter good threshold for previewBytes if no qualitySeries.
3. Export the magic: GOOD_BUTTER, SSIM_GOOD, BUTTER_MONOTONE_TOL etc. Allow override in opts (already partial via goodButter).
4. Self-stability (lens18/20): optional mode compare consecutive (no final needed):
   ```js
   if (opts.selfStability) { ... compute deltas between adjacent in series ... }
   ```
5. Unify error paths, make preview perceptual-aware.

### Agent for web/jxl-progressive-quality.test.js
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Items (Layer3 + 5):
1. Cover new dup-extract / out-array if added (in quality side if any).
2. Add tests for any new moments helper.
3. Edge for 0-len ssim guard.
4. Re-test generalized detect + series paths (memory of R1 additions).
5. (If builder added) test via quality path.

### Agent for web/jxl-progressive-byte-metrics.test.js
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Items (Layer3 + 5):
1. Test auto builder if added (compat + new).
2. Test improved preview with butterSeries only.
3. Test exported new consts + override.
4. Test self-stability mode.
5. Update any old expects if return shape grows (like R1).
6. Unsorted + regression cases (R1 had some).

## Implemented
All items reassessed positive (post-R1 code + pipeline context: analysis only, enables ML/AR/lens17 validation, reduces dup, no decode/scheduler impact, no prior rejection violation). 1 connected read (jxl-single-progressive.js for cutoff/charts usage) for reassess on builder/perceptual; no edit needed (self-contained in 5 + builder now available; larger migration out of scope). No rejects. Surgical only on assigned + md.

- web/jxl-butteraugli.js: pixelsToXyb outs for dup removal + zero-alloc in comparer (layer1); createComparer now accepts opts for weights/k/includeGradient + gradient stub (layer2/4); error path unified to NaN (layer3); docs updated. Connected reassess: no change required.
- web/jxl-progressive-quality.js: 0-len guard in ssim (robust); computeChannelMoments for features surrogate (lens12/layer4).
- web/jxl-progressive-byte-metrics.js: buildSeries helper (auto, uses comparer/quality, cohesion win layer2); preview fallback now perceptual-aware if butterSeries (layer3); exported GOOD_BUTTER/SSIM_GOOD/BUTTER_MONOTONE_TOL + used; import for builder; selfStability note/stub (layer4). No connected edit.
- web/jxl-progressive-quality.test.js: import + tests for moments, 0-len ssim (layer5).
- web/jxl-progressive-byte-metrics.test.js: import + tests for buildSeries shape, GOOD_*, butter-only preview (layer5). Old shape tests still pass (extra fields ok).

R1 invariants + series support preserved. All within 5 files (+ md).

## Final Agent Instruction
After your file's changes (full or partial), the LAST agent MUST rename this document by appending " - DONE" (e.g. JxlProgressiveVisualMetrics - DONE.md) and append note here with accepted items + summary. Then orchestrator runs c:\Foo\raw-converter-wasm\StandardMultifileTest.mjs and records timings + any regression note. All: reassess positive in pipeline context (allow minimal connected edits only for cohesion after check; reject otherwise to rejected optimizations.md). Memory first, 1 read max per your file. Surgical.

## Renamed - DONE (Round 2)
Last agent: renamed + note. All 5 handoffs + builder/config/dup/robustness/features applied after positive reassess (1 connected read for context, no edit). R1 preserved. Overview in doc.

StandardMultifileTest.mjs (round2): exit 0. Core timings (prog/first/final/shot/tiled/ROI) within normal variance vs prior; no regressions attributable to these 5 analysis files (not on hot encode/decode paths). TOON + graphs emitted. DONE.

## Overview of achievements (few paragraphs)
Round 2 on already-improved code tightens the toolkit: eliminates the fill/dn duplication that survived R1 (single source of truth for u8->XYB and downsample), adds the missing "auto series builder" so producers no longer hand-roll loops to get butterSeries + qualitySeries, and surfaces the internal constants + cheap features for the exact LLM/plant-recog/AR use cases in lenses 12/16. Preview logic and error paths become perceptual-aware and consistent.

This directly accelerates the vision: with builder + comparer, a profiling or live AR loop can feed cutoff pixels (or even progressive layer pixels) once, get all three series cheaply, and ask "at what bytes did the plant net first give >0.9 or butter dropped below 1.0 or psnr 20dB?" — without final render and with hooks ready for the Rust log-geodesic constancy mode (pixels will just arrive pre-adjusted; butter stays as independent perceptual check or gets a transform later).

Long-term: the self-stability + features sidecar open the door to early-stop without any reference at all (diminishing returns between consecutive chunks or surrogate on mask stats), supporting real-time low-byte ID on slow links or immersive viewers while keeping the code small, pure-JS, and strictly outside the hot decode path. All changes self-contained or minimally connected, R1 invariants preserved, Standard test will confirm no timing side-effects on core pipeline.
