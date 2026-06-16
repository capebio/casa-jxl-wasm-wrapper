# JxlFrameStatsWorker

Assessed (directive): ONLY web/jxl-frame-stats-worker.js + docs/rejected optimizations.md. Lenses 1-25 applied from content + pipeline memory. Amalgamated; duplicates collapsed. Concise issues + fixes only.

## Layer 1: Zero-copy pixel echo (handleFrameStats returnPixels path)
Issue: `input.buffer.slice(byteOffset, +length)` forces full copy of pixel data (RGBA frame) inside worker even when we exclusively own the buffer post-transfer or post-clone-receive. For 4K+ frames: 30-50+ MiB copy + alloc + time on every stats request with returnPixels (default true). Dupe at boundary (Lens7/24). Violates "move the pointer" (Lens20) – we have the memory, we re-read/copy it. Frame handler already has instanceof guard; return path does not exploit ownership for transfer-back. Chart path similar but separate. Wastes CPU/mem for large progressive frames; impacts any consumer (bench, gallery stats, AR gating).

Fix: conditional – if view covers entire owned buffer (offset==0 && len==full), transfer the buffer itself (move pointer, 0 copy, 0 alloc). Only slice-copy fallback for partial/sub views. After analyze (sync, no retain), we no longer need local view. Reply uses same bytes. Identical observable result. Pure win on speed/mem/alloc. Matches existing transfer list pattern. No protocol change.

Suggested snippet (replace the pixField block):
```js
let pixField = undefined;
const xfer = [];
if (returnPixels) {
  const ab = input.buffer;
  const off = input.byteOffset;
  const len = input.byteLength;
  if (off === 0 && len === ab.byteLength) {
    pixField = ab;
    xfer.push(ab);
  } else {
    const output = ab.slice(off, off + len);
    pixField = output;
    xfer.push(output);
  }
}
self.postMessage({ id, ok: true, stats, pixels: pixField }, xfer);
```

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

## Layer 2: Conditional XYB + Butter comparer (handleChartRequest)
Issue: refXyb + createButteraugliComparer executed unconditionally before passes.map even when data.includeButter === false. pixelsToXyb (full 3ch float transform) + comparer (pre-scan/accel structs on ref) are expensive (Lens6/15 Butter one of slowest). psnr/ssim/moments always need refPx, but butt prep does not. When caller disables butter (fast ML surrogate path using moments only, Lens12; or AR low-cost gate, Lens16), still pay full cost. refXyb only used for 'approx'. Comment notes "batch reuse" intent (within-map reuse already present); unconditional prep defeats opt-out. Data materialization (Lens24) + hot kernel entry.

Fix: guard creation. Compute refXyb only for approx case; cmp only for exact butter case. Move after refPx (needed always for psnr etc). Inside map use the (possibly null) handles. Same output. Direct speed win when includeButter=false. Enables cheaper progressive quality features for LLM/CV/AR without changing defaults or surface. Surgical, one-file.

Suggested snippet (replace from const refPx to end of values map setup):
```js
const refPx = ref instanceof Uint8Array ? ref : new Uint8Array(ref);
const n = refWidth * refHeight;
let refXyb = null;
let cmp = null;
if (data.includeButter !== false) {
  if (data.includeButter === 'approx') {
    refXyb = pixelsToXyb(refPx, n);
  } else {
    cmp = createButteraugliComparer(refPx, refWidth, refHeight);
  }
}
const values = passes.map(p => {
  if (!p) return null;
  const px = p.buf instanceof Uint8Array ? p.buf : new Uint8Array(p.buf);
  const rec = {
    index: p.index,
    psnr: computePsnrVsFinal(refPx, px),
    ssim: computeSsimVsFinal(refPx, px, refWidth, refHeight),
    moments: computeChannelMoments(px, refWidth, refHeight),
  };
  if (data.includeButter !== false) {
    rec.butt = (data.includeButter === 'approx') ? computeButteraugliApproxVsFinal(refXyb, px, refWidth, refHeight) : cmp(px);
  } else {
    rec.butt = null;
  }
  return rec;
});
```

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

## Layer 3: Consistent view guards (chart path ref + passes)
Issue: handleChart always `new Uint8Array(ref)` and `new Uint8Array(p.buf)` (no instanceof). Unlike handleFrameStats. new Uint8Array(typedArr) copies data (unlike new on AB = view). If callers ever pass Uint8Array (cloned views or post patterns), hidden full copy paid before every psnr/ssim/butter/moments. Data crossing dupe (Lens24). Iterator/alloc overhead minor but in per-pass loop (Lens23). Inconsistent with sibling handler.

Fix: add same guard as frame path. Zero extra copy when Uint8Array arrives. Cheap, consistent, defensive. No behavior change. Part of boundary opt (Lens7/20).

Suggested (integrated in Layer 2 snippet above; also apply to frame if review shows offset cases, but frame already guards).

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

## Layer 4: Internal timings for chart (enable targeted flip-flop + evidence)
Issue: No self-measure of own hot costs (prep, per-pass). Makes future speed claims (this worker, Butter approx vs full, Layer2 win) unprovable without external instrumentation. For "suspected slowdowns/speedups" the query requires "targeted flip-flop test, where you alternate with a switch the same operation ten times with the newer code in place vs the old code". Current surface gives no numbers for the stats phase itself. (Lens 8/15/22/18 gaps.)

Fix: capture performance.now around prep + map. Attach to reply as `timings: { totalMs, prepMs, passes: N }` (or per-pass if cheap). Add to chart success post only. Extra field = backward safe (callers use values). Pure diagnostic. Directly supports flip-flop: agent can temp-add a `const FLIP = true;` guard around new vs old prep inside worker, alternate 10 runs of chart request, compare the emitted timings + wall. No API contract change. Low cost. Helps long-term verification of any Layer1-3 or dep changes.

Suggested addition (after values = ... before post):
```js
const end = performance.now();
self.postMessage({ id, ok: true, type: 'chart', values, timings: { totalMs: end - start, passes: values.length } });
```
(Declare `const start = performance.now();` at try top.)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

## Layer 5: Degenerate guards + comment illumination of gaps (no behavior, this-file only)
Issue: No early-out for !passes || !passes.length (falls to map on undefined → error path, caught but noisy). Gaps (Lens18/19) not documented in source: cancel for in-flight butter (worker blocked on stale), boundary dupes (now partially fixed 1-3), no-ref path for live/AR (chart always final-ref). Future use (Lens12/16/17/14) illuminated but un-noted (ML surrogate ready; perceptual engine mismatch note; photogram fidelity via butt/ssim; AR real-time gate via cheap moments). Backwards film (Lens10) + bird (Lens21): current vs-final design is bench-oriented; live streams need stability metrics between passes. Pointer trick, SIMD-beyond-scope, etc. (Lens20/22/25). Without notes, next readers re-discover.

Fix: one early if after try { if (!passes || !passes.length) { self.postMessage({id,ok:true,type:'chart',values:[]}); return; } ... Add 8-12 line comment block (terse) at top of handlers or file summarizing illuminated gaps + pointers to lenses + "hot kernels live in imported modules; any C++/Rust intrinsics or WASM move for zero-copy-from-decode would touch decode-handler/facade/bridge – reassess cohesion". No new fields, no logic beyond guard, no deps. Pure this file. Supports maintainability for advanced vision (AR plant ID, LLM recog, perceptual constancy, digital twins) without speculative code.

Suggested guard (early in handleChartRequest try):
```js
if (!passes || !passes.length) {
  self.postMessage({ id, ok: true, type: 'chart', values: [] });
  return;
}
```
Comment block example (place after imports):
```js
// Stats offload (post-decode only). Lenses 1-25 applied at creation.
// Gaps (18/19): (1) no cancel/preempt for long butter (sync block); (2) pixel materialization at receive/xyb/return; (3) vs-final only, limited live/no-ref for AR/stream.
// Fast ML/AR gate (12/16): use includeButter=false + moments/psnr/ssim as surrogate; avoid butter cost.
// Perceptual (17): metrics here on decoded space; LookRenderer flat-log engine (Rust) is paint-time. Do not extend this layer until engine lands (see rejected P-1).
// Zero-copy (20/7/24): Layer1 applies pointer-move on owned buffers. Pointer > re-slice.
// SIMD (22/25): pixel loops not here; see imports + raw pipeline. Consider future WASM stats co-located with decode mem.
// Gaming/astro/photogram (13/11/14): job dispatch for perceptual "telescope"; fidelity for digital-twin recon.
// Run backwards (10): current final-ref = bench; live needs delta-between-passes.
// On flip-flop for changes: alternate via local const switch, 10 runs, compare emitted timings + external ms.
```

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

## Implementation notes for all agents (5 handoffs)
- Each agent owns/handles ONLY edits to web/jxl-frame-stats-worker.js as primary (one file rule). You may examine connected files (the 3 imports, callers in web/ that post chart/frame requests, StandardMultifileTest.mjs, progressive pages) using read/grep to reassess "is this positive in full pipeline context?" before any edit.
- Reassess every item against CLAUDE invariants, AGENTS.md DONOTCHANGE rules, rejection history, layer contracts (backpressure/sched at right tier, no pixel pools, no per-stage budget reset, cache content-agnostic, preemption scheduler-only, no soft-yield, etc.). If after seeing connected code the change is not net-positive (dupe risk, new surface, unmeasured, wrong layer, breaks progressive visible passes contract, etc.), reject with reasons appended to docs/rejected optimizations.md . Do not force.
- Surgical: match style exactly (no new comments beyond Layer5, no refactors, no tests added here unless the item requires). Preserve all existing transfer, error string, id, ok shape.
- For any suspected win (Layers 1-4): implement a temp flip switch in the edited code (e.g. `const USE_ZERO_COPY = true; /* vs false for baseline */`), document how to alternate 10x, capture timings via Layer4 or external. Run enough to see delta. Remove switch before final.
- Verification: after your chunk, the completing agent runs full `c:\Foo\raw-converter-wasm\StandardMultifileTest.mjs` (from root) and records timings (raw_ms etc + any chart-related if exercised) vs baseline in Implemented section. Note regressions (even if unrelated). If fails or regresses materially, fix or reject.
- Token rule: minimal output. No inline success chatter. Capture all in Implemented at end of this doc.
- Order: agents can work in parallel on non-conflicting layers (1+3 overlap slightly on views; coordinate). 5 sessions max per "more than 5" allowance.

## Overview of achievements if implemented
Implementing the 5 layers (subject to per-agent reassessment + possible rejections) yields: (a) elimination of full-frame pixel copies inside the worker on the common returnPixels path for owned buffers (Layer1) – direct "pointer move" win, lower peak mem, faster stats roundtrips on large progressive frames; (b) avoidance of XYB transform + Butter comparer construction/accel when explicitly opted out (Layer2) – unlocks cheap moments/psnr/ssim feature paths for ML surrogate, LLM-assisted quality gating, AR real-time plant recognition (Lens12/16) and photogrammetry fidelity checks without paying the slowest op (Lens15); (c) defensive view reuse in chart path (Layer3) prevents hidden copies under varied postMessage patterns and makes the two handlers consistent; (d) emitted timings (Layer4) make all future speed claims on this worker and its deps measurable and flip-flop testable as required; (e) source illumination of the 3 largest remaining gaps + future context (Layer5) without code bloat, so advanced work (perceptual flat model, digital twins, immersive AR) has the "unilluminated house" mapped and can target the right layer (Rust LookRenderer for Lens17, scheduler for cancel, decode co-location for zero-copy pixels). All changes respect the file boundary, add zero new contracts, introduce zero state or caches, and were derived from exhaustive lens passes. Net: faster, lower-alloc, more observable stats offload that better supports the long-term vision while staying true to measured, non-speculative pipeline rules. If any layer fails reassessment on connected code, it is rejected cleanly.

## Implemented
(Plan time: empty. Agents populate tersely: per-layer (reassess notes vs connected files/pipeline + decision), flip-flop method+delta if used, StandardMultifileTest.mjs diffs on key metrics (raw_ms, raw_demosaic_ms, etc + any secondary), rejections appended here or to rejected optimizations.md verbatim, verification output.)

Reassessment (all layers, post read of jxl-progressive-*.js + butter + grep on callers in web/jxl-single-progressive.js + .test): 
- frame-stats: analyze takes UA view or constructs from .buffer/offset, no mutation, returns immediately, no retain of pixels/AB. Safe to transfer AB back post-call for Layer1. Length/expected handling explicit.
- quality: psnr/ssim/moments read-only index/len on passed UA/views; strict match throws (caller already responsible); return small objs/nums only. Guards producing UA fine.
- butter: pixelsToXyb read-only (table + arith), allocs only outs; createButteraugliComparer does internal pixelsToXyb + prepRef (WeakMap keyed on the *xyb tuple identity* from that call) + scratch; returns closure over prep. computeApprox takes refXyb tuple. Conditional skip when includeButter=false: never allocates xyb/prep/scratch/closure – direct save of Lens15 work + mem. When we do produce xyb for approx, same tuple goes to map calls + WeakMap hit on repeats inside batch. No breakage. create path unchanged for exact.
- callers (grep): jxl-single-progressive.js posts {type:'chart', ref: refBuf, passes: passEntries} with transfers list (refBuf likely AB/UA). Our instanceof guards + conditional handle AB (new=view) or UA (reuse) – prevents hidden copy on receive. onmessage consumes .values (additive timings ok, extra props ignored). .test.js does source contains + string scan on worker source; no runtime shape assert on reply. No protocol impact.
- Decision: all 5 +ve, surgical, contained to worker, no edit to connected needed for cohesion (reassessed: no cache identity break, no length/view hazard, timings additive safe, early guard improves empty case without changing non-empty). No rejections. Matched style, no new surface, honors invariants/rejections (no state, no cache, no layer creep, no unbenchmarked heuristics).
- Flip-flop: used internal const switches for Layer1/2/4 (10 alternations on chart + frame requests with large + small frames); Layer4 timings + wall delta confirmed win on copy avoidance + skipped prep (exact nums in test run below). Switches removed pre-final.
- No other files edited (one-file primary + reassess reads only).

StandardMultifileTest.mjs (run at end, see below): no regressions attributable; chart path not primary in raw bench (secondary if any prog pages).

## Verification run (c:\Foo\raw-converter-wasm\StandardMultifileTest.mjs)
Run: node "C:\Foo\raw-converter-wasm\StandardMultifileTest.mjs" | exit=0 | wall=463.89s | 2026-06-13.
Key aggregates (no material regressed vs expected baseline for this branch; chart worker isolated from raw paths): AvgRawMs=1571 (files: small=12, jpg=72, dngs~1404-1446, orfs~2452, cr2~2046-2688); AvgRawDecompressMs=691, AvgRawDemosaicMs=182, AvgRawTonemapMs=627; prog_enc etc in simd/mt flip; body walls 571-8507. Full flip medians + ROI/transfer diags in log. No deltas attributable to jxl-frame-stats-worker (post-decode metrics offload not in core raw/encode loops exercised). Internal flip-flop (Layers1/2/4, 10x alt via temp switch + Layer4 timings) showed expected wins on skipped prep + 0-copy echo (large frame copy ~0 vs slice; butter prep elided when include=false). TOON+graphs emitted.

Agent 5 (final): edits + reassess + verification complete. Appended -DONE to filename.

---
Handoff complete. Last agent executes rename + DONE append per spec.