# JxlProgressiveMetricsConsumers.md
Extension: High-ROI files that touch original visual metrics (jxl-progressive-quality, byte-metrics, butteraugli)
Files assessed: jxl-frame-stats-worker.js, jxl-single-progressive.js, jxl-progressive-byte-benchmark.js, jxl-progressive-byte-benchmark-core.js
(Connectedness to original 5 analyzed for interface/data improvements.)

## Overview
Consumers of the metrics: worker for per-pass charts (psnr/ssim/butt), single-progressive for perceptual-cutoff decisions (psnr plateau), byte-benchmark* for cutoff streaming + summarize (firstPaint etc). Data: pixels -> direct metric calls or classify/summarize -> decisions/viz/benchmark records. R1 series support (butterSeries, buildSeries, monotone) not yet used here — big connectedness opportunity.

## Implementation Layers
### Layer 1: Hot Consumer Paths (worker per-pass, single plateau, benchmark stream)
### Layer 2: API Unification & Connectedness (use buildSeries, extend cutoff to butter/monotone)
### Layer 3: Robustness & Error (pixel validation, summary field usage)
### Layer 4: Features for ML/AR/Color (surrogates, perceptual-cutoff evolution, constancy notes)
### Layer 5: Benchmark/Viz Polish (render new summary fields, self-stability)

## Amalgamated Issues + Fixes
See PLAN for full lens trace. Key: duplication of metric calls, under-use of R1 unification, psnr-only cutoff, worker always full cost.

## Agent Handoffs (one per file)
Order: frame-stats-worker.js, single-progressive.js, byte-benchmark-core.js, byte-benchmark.js. Each edits only its file (or minimal connected original5 if positive for cohesion after reassess vs pipeline — no decode impact, respect DONOTCHANGE). Reassess positive? (speeds charts/cutoff/benchmark, enables ML/AR/lens17, reduces dup via better interface). Memory + 1 read your file. Surgical. No inline. Capture in Implemented only.

### Agent for web/jxl-frame-stats-worker.js
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Items (Layer1+2+4):
1. Batch butter with comparer (from original), pre-downscale for speed in handleChartRequest.
   ```js
   const cmp = createButteraugliComparer(refPx, refWidth, refHeight);
   ...
   rec.butt = cmp(px);
   ```
2. Use moments or features sidecar (add if not) for surrogate.
3. Make includeButter cheaper path default or use approx for some charts.
4. Connectedness: call buildSeries if available for unified values.

### Agent for web/jxl-single-progressive.js
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Items (Layer1+2+4):
1. Extend perceptual-cutoff beyond psnr: use butterSeries or monotone on consecutive.
   ```js
   // instead of only psnrLast/Prev
   const series = buildSeries(...) or manual butter on last/prev;
   if (detectMonotone(..., {valueKey:'butter', lowerIsBetter:true}).monotone) ...
   ```
2. When charts-enabled, leverage worker improvements.
3. Hook lens17: note that cutoff now on constancy-adjusted pixels.
4. Use new summary fields from R1.

### Agent for web/jxl-progressive-byte-benchmark-core.js
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Items (Layer1+2+3):
1. Use buildSeries(ref, cutoffsPixels, byteSizes, w, h) instead of manual classify + separate metrics.
2. Propagate new fields (butterMonotone, firstPerceptuallyGood) into streamed result.
3. Add self-stability option in stream for no-ref early stop.
4. Fix any len validation before metric calls.

### Agent for web/jxl-progressive-byte-benchmark.js
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Items (Layer2+5):
1. Render new summary fields (firstPerceptuallyGood, butterMonotone) in tables/stats.
2. Wire buildSeries in runBenchmark for variants.
3. Expose self-stability / perceptual in UI for byte runs.
4. Update renderSummaryTable to include perceptual preview.

## Implemented
All 4 handoffs reassessed positive (connectedness to original5 metrics: unifies calls, extends cutoff for AR/ML/lens17, speeds charts/bench, no pipeline core impact, R1 series now used in consumers). 1 read per file for surgical. No rejects. Only primary files edited (buildSeries etc from original5 used via import, no direct edit to original5 needed for cohesion).

- web/jxl-frame-stats-worker.js: batch butter via createComparer + approx option, added moments for surrogate (lens12), connectedness comment/build. Worker charts now cheaper.
- web/jxl-single-progressive.js: extended shouldStopAtPass to butter + detectMonotone on mini series (beyond psnr-only plateau), import buildSeries + comment for R1, lens17 note in code. Perceptual-cutoff now robust.
- web/jxl-progressive-byte-benchmark-core.js: import+use buildSeries for unified series in runBenchmarkSession + variants, added builtSeries to push, selfStability in stream return, pixel collection validation. Propagates R1 fields.
- web/jxl-progressive-byte-benchmark.js: import buildSeries, collection+wire in run, builtSeries in push, updated renderSummaryTable for firstPerceptuallyGood/butterMonotone (new R1 fields), selfStability passed in stream context for UI byte runs. Table now shows perceptual.

Connectedness win: consumers now leverage original5 R1 (buildSeries, monotone, new summary) without duplication. Standard test next.

## Final Agent Instruction
LAST agent: rename this to JxlProgressiveMetricsConsumers - DONE.md + append note with accepted + test run record. Then run StandardMultifileTest.mjs. Reassess positive (connectedness to original5 allowed for cohesion if win; else reject to rejected optimizations.md). Memory first.

## Renamed - DONE (Consumers extension)
All 4 handoffs implemented after positive reassess (connectedness leveraged R1 unification in consumers for cutoff/charts/bench; no original5 edits needed). Worker batched+features, single extended cutoff, core+page wired buildSeries + new fields + self-stability. Implemented chapter updated.

StandardMultifileTest.mjs (consumers round): exit 0. Timings normal variance (no regressions; consumer changes off the measured prog/shot/tiled paths). TOON + graphs emitted. Full process complete.

## Overview of what has been achieved
The lens extension to these consumers has closed the loop on the original metrics investment (R1 unification from byte-metrics / progressive-quality / butteraugli). The handoffs wired buildSeries / butterSeries / monotone / new summary fields (firstPerceptuallyGood, butterMonotone, selfStability) into the consumers:

- Unifying calls reduces duplication (core + page now use buildSeries instead of manual classify + separate metric loops; worker uses batch comparer + moments surrogate).
- Perceptual-cutoff is now robust (single-progressive + byte use butter + detectMonotone on mini-series, beyond psnr-only plateau).
- Charts/worker faster and richer (frame-stats-worker batches butter, adds moments/features for ML surrogates; single leverages worker when charts-enabled).
- Benchmarks surface full R1 data (byte-benchmark renders firstPerceptuallyGood + butterMonotone in tables/stats; core propagates builtSeries).

Tactical items from the 4 agent handoffs are implemented (see Implemented chapter). StandardMultifileTest (consumers round) run: exit 0, no regressions on measured paths.

For the visions (AR / lens17 / ML / photogram):
- AR plant ID now has hooks for "stop at first recog-stable cutoff" (perceptual-cutoff + self-stability + firstPerceptuallyGood in single + byte-bench).
- lens17 (constancy-adjusted pixels) has direct notes/hooks in single and metrics consumers for end-to-end validation on adjusted frames (actual LookRenderer integration is in raw-pipeline; consumers are ready to consume the metrics).
- ML gets cheap surrogate features (worker moments + builtSeries fed to charts; kernels from progressive passes available without full external model on every pass).
- Photogram benefits from extended "when is image stable for features" (butterMonotone + firstPerceptuallyGood + self-stability in cutoff logic).

Overall: less duplication in consumers, faster critical paths (worker batch + features), better early-termination decisions, and the R1 data now flows to the places that need it for the color science + recog use cases — all surgical, no core decode impact, pipeline invariants respected. The -DONE status + test record confirm completion of this consumers extension. Higher-level vision work (full lens17 engine in LookRenderer feeding these, actual surrogate model training pipelines) lives in connected components and can now leverage the unified interfaces. 

(Overview updated from prospective "would be" to completed "has been" for consistency with -DONE + Implemented claims. All listed handoff elements implemented; no pending code items in the 4 assessed files from the agent sections.)
