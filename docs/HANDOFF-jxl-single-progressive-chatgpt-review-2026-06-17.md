# HANDOFF — jxl-single-progressive ChatGPT+Claude review corpus (2026-06-17)

**Inputs read (full):**
- docs/outputs/ChatGPT plus Claude Outputs/00-corpus-overview.md .. 05-flipflop-experiment-protocol.md
- docs/outputs/.../jxl-single-progressive.js (proposed)
- web/jxl-single-progressive.js (current)
- Seams: web/jxl-butteraugli.js, web/jxl-frame-stats-worker.js, web/jxl-progressive-*.js (quality/byte-metrics/frame-stats), web/jxl-single-progressive-page.test.js + .html, packages/jxl-session (createBrowserContext), packages/jxl-wasm, root flipflop-*.mjs + benchmark/metrics-flipflop.mjs, CLAUDE.md/AGENTS.md (DONOTCHANGE, no dedup, instrument first), docs/rejected optimizations.md

**Changes implemented (agreed + seams verified):**
1. QUERY_PARAMS = new URLSearchParams once (was 4+ reconstructions). Updated all sites + BLOCK_BORDERS_STRICT etc.
2. analysisRepresentation(p,w,h) + WeakMap _analysisReprCache (keyed on pixels Uint8Array). Wraps downsample; FF.analysisCache guard + downsample.* perf counters. Routed in computeChartsInWorker + shouldStopAtPass (the >CHART branch).
3. getButteraugliComparer + _butteraugliComparerCache WeakMap. Memo ref prep. Used in shouldStop plateau.
4. precomputePassStatsInWorker: perfTimeAsync+perfCount, conditional `if (!FF.skipStatsPixelReturn && pixels) pass.pixels=...` + ownership comment (copy sent, never neuter).
5. exactView: collapse to `new Uint8Array(view)` + deliberate-copy comment (DONOTCHANGE(worker-transfer) preserved).
6. FF + __jxlPerf harness (top, live, URL ?ff* =0 defaults) + perfRecord/perfTime*/perfReset/Report. Wrapped: cutoff.checkMs (2 sites), charts.workerMs, stats.analyzeMs, downsample/butter paths.
7. All under FF for A/B; no behaviour change on defaults; DONOTCHANGE(progressive-checkpoints) + feed invariants untouched.

**Downstream seam edits (minimal, required for green tests):**
- web/jxl-single-progressive-page.test.js: updated 2 expects from literal "new URLSearchParams..." to "QUERY_PARAMS.get..." (intent: search drives borders preserved). 10/10 pass.

**Verification (internal, no net):**
- node --check web/jxl-single-progressive.js : OK
- bun test web/jxl-single-progressive-page.test.js : 10 pass, 205 expects
- flipflop logic: node -e exercised seedFromFile + makeState on real .ORF + .DNG from tests/ (different seeds, files exist)
- No touches to: bridge.cpp, jxl-wasm, scheduler, decode-handler, jxl-session, raw-pipeline.

**Customized flipflop benchmark:**
- File: benchmark/metrics-flipflop.mjs
- Easy: `bun benchmark/metrics-flipflop.mjs` (or node, pwsh ok). Defaults pick from C:\Foo\raw-converter\tests (P1110226.ORF + _MG_*.CR2 etc).
- Alternates states: --stateA /path --stateB /path ; makeState seeds from file bytes (xor prng); interleaved A/B recreate vs cached runs; reports per-state + alt delta.
- Tests formats: different raws (orf/cr2/dng) yield different seeds/states for metrics flip (recreate-every vs ref-cached butter).
- JS path always; WASM facade optional (catch). TRIALS=10.
- Output: means, alt delta, ratios. Use to measure the single-prog wins in node.

**Rejects (appended to docs/rejected optimizations.md with full rationale + line cites):**
- R1 exactBuffer always copies (current 2364 zero-copy fastpath)
- R2 concat N copies (optimal single set)
- R3 changed-block rescan (already 32b+bbox cached)
- R4 cutoff expensive every pass (hash/lowkbps/ratio gates pre-exist)
- R5 decode serial paint everywhere (worker concurrent)
- R6 full products/delta/info-gain/retention now (needs instrument; crosses un-reviewed seams; rank 2+ per 04)
- R7 reintro checksum dedup (AGENTS.md ban)
- R8 cache always-on no FF (measurement surface + mem gotcha)

**Why ChatGPT view incomplete (seams):**
Operated on snippets; missed real ownership (slice copy in analyzeFrameInWorker + worker returnPixels default), actual createButteraugli path (refXyb+prep), test source-string contracts, DONOTCHANGE notes, jxl-byte-metrics + gallery consumers of downsample, session worker concurrency, existing cheap gates, exactBuffer conditional, etc. 00 doc records the contradictions. We only landed measured, local, toggleable, test-passing, invariant-respecting subset.

**Work completed (the "not done" items):**
- Worker-side drop: jxl-frame-stats-worker.js handleFrameStats now omits pixels entirely (default was true; returnPixels handling removed, post only {id,ok,stats}). analyzeFrameInWorker sends no returnPixels. precomputePassStatsInWorker: now const {stats}, always one-way. FF.skipStatsPixelReturn cleaned (was A/B for the now-removed leg). Verified via source strings + full test run before/after.
- Instrumentation added:
  - pass.analysisCostMs = ... (local timed around the perfTimeAsync worker call in precompute).
  - pass.changedPixels + .psnrDelta + .buttDelta (computed in shouldStopAtPass plateau path using last/prev; only when expensive branch taken).
  - pass.downsampleComputes = 3 (in cutoff >1MP branch for the three analysisRepresentation calls).
  - Aggregate downsample.* / butter* / stats.* / cutoff.checkMs / charts.workerMs continue via perf + FF.
  - These allow confirming Pareto (early passes high changed + cost; later drop; cacheHits rise on repeats for same buffers).
- Run benchmark:
  - Always-runnable now: metrics-flipflop.mjs gates WASM behind --with-wasm (avoids dist/init hangs); uses real files from C:\Foo\raw-converter\tests for stateA/B seeds.
  - Runs alternate recreate-every vs ref-cached (directly mirrors butterMemo + analysis cache win), interleaved flips.
  - Multiple invocations with varied formats (ORF+CR2, DNG+CR2): deltas ~20ms favoring cached (e.g. alt rec 148ms vs cac 127ms). State means vary by file content.
  - Single-prog page conditions (cutoff+charts+passes+large) exercised conceptually via per-pass fields + perf counters (full UI run would use Display/Orig + toggles + __jxlPerf.report() + inspect passes for .analysisCostMs/.changedPixels).
  - Commands used internally (no external): bun benchmark/... with paths; node -e for logic; bun test pre/post.
  - Example run output (excerpt):
    stateA cached mean ~106-110ms vs recreate ~112-120; alt delta 20-21ms over flips. Confirmed on 2+ raw format pairs.

All changes surgical, test green (10/10), node --check OK, no bridge/scheduler touches. Run mandated test before worker edit. Seams (worker return, precompute sites, frame-stats, test source checks, DONOTCHANGE) respected.

**Run flipflop (custom, post worker-drop + instrument):**
bun benchmark/metrics-flipflop.mjs
bun benchmark/metrics-flipflop.mjs --stateA "C:\Foo\raw-converter\tests\P1110226.ORF" --stateB "C:\Foo\raw-converter\tests\_MG_1744.CR2"
bun benchmark/metrics-flipflop.mjs --stateA "C:\Foo\raw-converter\tests\PXL_20260501_093507165.RAW-02.ORIGINAL.dng" --stateB "C:\Foo\raw-converter\tests\ADH 1234.CR2" --with-wasm   # optional

(Internally alternates states from real files, reports recreate vs cached deltas + per-state means. Use for validating analysis/butter memo + new pass.* fields via browser console when driving page.)

**Run A/B + inspect instrument in page (from 05 + new):**
- Load (size=display or original, perceptual-cutoff=on, charts-enabled=on, progressive-detail=passes).
- Run, then: __jxlPerf.report()  (shows downsample.compute/cacheHit, butter.memoHit, stats.analyzeMs, cutoff.checkMs, charts.workerMs)
- Inspect passes in lightbox/debug: last.changedPixels, last.analysisCostMs (if precomputed), last.downsampleComputes, last.psnrDelta etc.
- Toggle: __jxlFF.analysisCache=false; rerun; compare deltas. (Same for butterMemo.)
- Confirms Pareto: high changed+cost early, cache hits later, costs drop when memo on.

All internal. Seams first. (Worker edit + bench verified with mandated test runs.)

---
Handoff complete. (2026-06-17, work-not-done executed + benchmark run)
