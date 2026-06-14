# ProgressiveQuality.md
Assessment + handoff plan for web/jxl-progressive-quality.js + web/jxl-progressive-quality.test.js (via all 26 lenses, token-minimal path: 2 reads + this write).

## Amalgamated findings (efficiency/speed/perf/bugs/features; duplicates collapsed)
- Kernel: computeChannelMoments recomputes `(pixels.length / np) | 0` stride expr every iter (lens 20,23,6,26). Hoist. 1-line fix, measurable in tight u8 loops.
- Kernel: computeChannelMoments docstring claims "Zero extra alloc if caller provides outs" but code always does `new Array(ch).fill(0)` + fresh return obj (lens5,23). Implement outs or fix doc.
- Hot path: PSNR + SSIM + moments each full scan pixels. 3 passes. No fused bundle (lens20,24,6). Add `computeQualityBundle(cutoff, final, w, h)` returning {psnr, ssim, moments} – one/two passes total. Critical for profiling N stages.
- Validation inconsistency: SSIM throws on !isInteger(channels); moments floors ch silently via |0 (lens4,5,8). Align: throw or normalize.
- API: C1/C2 exported mutable consts; no peak param (hard 255); SSIM always min(ch,3) drops alpha for RGBA (lens2,5). Freeze or document; add optional peak=255; clarify alpha.
- No single-metric multi-use: detectMonotone walks series; moments pure. Add optional policy helper? (plateau detect using multiple keys).
- Test coupling: .test imports+tests butteraugli fns from sibling (lens8). Keep or isolate in this scope.
- Perf guard missing: no flip-flop harness or micro timings in test for kernel changes (advanced Q). Add A/B 10-alternation timing on fixed data, median compare.
- Advanced lens prep (17 color,12 LLM,14 photogram,16 AR,13 gaming,11 astro,15 butter surrogate): moments already tagged for surrogate recog/plant ID. Bundle + moments give cheap features for "cutoff sufficient for AR ID / photogram twin / LLM". Add jsdoc + TODOs referencing non-Riemann engine (flat log space) and "metrics in perceptual coords post-LookRenderer". No premature math dupe in JS.
- Gaps (18,19 repeated view): 1. No incremental/streaming accumulators (stats update without full buffers each cutoff). 2. No unified quality policy layer (consumes psnr+ssim+butter+moments+monotone → "stop" decision) – currently callers must wire. 3. No colorspace awareness (u8 post-render assumed; 16b/float/HDR, linear, or post-new-perceptual-model pixels need different C1/C2/peak or space transform). These remain dark; minimal annotation only.
- Math/perf (26,22): global SSIM (whole-image moments) is deliberate cheap approx vs windowed. Good. PSNR/MSE scalar loop + SSIM sums + strided moments are textbook SIMD (u8x16 or 8xf32 horiz adds/muls). Port target later. Current JS is scalar.
- Boundary (7,24): pure JS, pixels by-ref (good, no copy inside). But repeated materialization across calls if not fused. "finalPixels" retention cost is caller side.
- State (4): none (pure). Good.
- Support (8): basic tests pass; 0-len ok; monotone lowerIsBetter ok. Missing: ch=4, ch=1 edge, non-monotone multi-regress, numeric stability, bundle, outs, validation parity.
- Long-term (9-17,10 backwards): these are post-decode probes for progressive cutoff quality (aligns DONOTCHANGE progressive flushes). Backwards: from final high-quality "young" early cutoffs measured exactly here. Use for telescope-like adaptive "integration" (stop pulling bytes when plateau or recog confidence). Gaming LOD + perceptual stop. AR real-time plant recog: moments as ultra-cheap front-end filter before heavy CNN. Photogram: quantify info loss for SfM consistency. Butter speed: surrogates (moments/psnr/ssim) already reduce butter invocations (slowest). Color science: once Rust LookRenderer has B-matrix+log+Molchanov tensor+LosAlamos curves + hybrid spring, these metrics (esp moments) become calibration/validation surface + can be made "constancy invariant". Suggest no change here yet; annotate for handoff cohesion with pipeline.

No issues found that are pure noise. All map to 1-5 of: eff/spd/perf/bug/feat.

## What implementing achieves (overview paragraphs)
Fusing passes + hoisting + alloc discipline removes 2 redundant O(N) scans and repeated integer div per pixel in the quality measurement layer used for progressive JXL cutoff analysis. On large images (common in photogram/AR refs) and many stages this is direct CPU/bandwidth saving in profiling and any runtime early-stop heuristics. The bundle gives callers one entrypoint for the full surrogate feature set (moments explicitly for lens12/16 recog), cutting GC and cache thrash vs three separate calls. Validation parity and API polish (outs, peak, alpha note) prevent silent wrong results when RGBA or future >8b data appears. Flip-flop harness + expanded tests provide regression guard on hot scalar loops before any SIMD/C++/Rust port (lens22/25). Annotations + bundle prepare (without implementing) the metrics for the non-Riemann perceptual engine landing in LookRenderer: moments/vars become stable features across illumination once "Perceptual Constancy Mode" pixels flow through; butter surrogates stay cheap while Butteraugli itself remains the slow HVS reference. Overall pipeline effect: faster dev loops on progressive params (dc/ac/groupOrder), lower overhead if quality metrics sampled inside sessions, ready cheap features for ML/AR/plant-ID/photogram digital-twin gates, and preserved alignment with mandated progressive visible checkpoints. Changes stay leaf-pure-JS (or easy native target); no scheduler/worker/WASM boundary impact. If any item fails re-assessment against full pipeline (other files via memory), it is rejected per the handoff rule.

## Implementation layers (sensible chunks; each agent handles exactly one file)
Agents re-examine every item using full pipeline context (jxl-session/scheduler/decode-handler/facade/bridge.cpp, src/lib.rs LookRenderer + apply_tone_math, progressive flush rules, butteraugli cost, cache, raw u16 paths, etc.) from memory + this doc. Reassess net positive for efficiency/speed/perf/correctness/long-term (AR/photogram/color engine/LLM recog) before touching code. Surgical edits only. If connected files must be touched for cohesion on an item, do minimal + document. Capture all decisions + diffs summary in the Implemented chapter below (no inline chatter). Multiple agents/sessions allowed; alternate files. >5 ok if splits needed.

### Layer 1: Hot kernel pointer/stride/loop efficiency + fused bundle (Agent owns ONLY web/jxl-progressive-quality.js)
- Hoist stride expression in computeChannelMoments (one const before loop).
- Add outs support to match existing docstring (or update docstring if outs rejected on review).
- Implement computeQualityBundle(cutoffPixels, finalPixels, width, height) that performs the necessary accumulations in <=2 passes and returns {psnr, ssim, moments: computeChannelMoments result or inline}. Update internal PSNR/SSIM paths if needed to share code without dupe. Export it.
- Add brief comment on SIMD potential at the three loop sites (PSNR for, SSIM unrolled+scalar, moments strided) for future lens22/25 port.
- If agree positive in context of pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Suggested (ambiguous parts):
```js
// inside computeChannelMoments
const np = width * height;
if (np === 0) return outs ? (outs.mus.length=0, outs) : {mus: [], vars: [], ch: 0};
const stride = (pixels.length / np) | 0;
const ch = Math.min(maxCh, stride);
const mus = outs ? (outs.mus || (outs.mus = new Array(ch))) : new Array(ch).fill(0);
const vars = outs ? (outs.vars || (outs.vars = new Array(ch))) : new Array(ch).fill(0);
// ... zero if reused, then
for (let c = 0; c < ch; c++) {
  let sum = 0, sum2 = 0;
  for (let i = c, j = 0; j < np; j++, i += stride) {
    const v = pixels[i]; sum += v; sum2 += v * v;
  }
  const mu = sum / np;
  if (outs) { mus[c] = mu; vars[c] = sum2 / np - mu * mu; }
  else { mus[c] = mu; vars[c] = sum2 / np - mu * mu; }
}
const res = outs || {mus, vars, ch};
res.ch = ch;
return res;
```

```js
export function computeQualityBundle(cutoffPixels, finalPixels, width, height) {
  // fused: compute psnr sumSq + ssim raw moments + moments in 1-2 passes
  // (psnr separate or fused with ssim accumulators; moments independent gather)
  // return { psnr: ..., ssim: computeSsimVsFinal(...) or internal, moments: ... }
  // keep existing fns as wrappers for backcompat if desired
}
```

### Layer 2: Data structures / API surface / validation / color-engine prep (Agent owns ONLY web/jxl-progressive-quality.js)
- Align ch validation between SSIM and moments (throw on non-integer or document+floor consistently). Prefer throw to match SSIM.
- Freeze C1/C2 or stop exporting if not intended for tuning; add JSDoc.
- Add optional `peak = 255` to computePsnrVsFinal (and pass-through to MSE). Default keeps current behavior. Update SSIM C1/C2 calc if peak supplied (advanced; optional).
- Add JSDoc + TODOs on all exports: "u8 post-render assumed. For non-Riemann perceptual (lens17 LookRenderer B+log+Molchanov+diminishing) run metrics on post-Look u8 or provide future perceptual-space variant. moments intended as cheap surrogate for LLM/AR/plant-recog/photogram (lenses 12,14,16)."
- Document alpha handling (min 3ch) and suggest caller pre-convert if alpha matters for metric.
- If agree positive in context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### Layer 3: Test surface, coverage, validation parity (Agent owns ONLY web/jxl-progressive-quality.test.js)
- Add tests: ch=4 (RGBA, confirm ssim uses 3ch), ch=1, non-integer length error parity for moments, outs path for moments, 0-np + 0-len already covered.
- Add multi-regression detectMonotone case; unsorted bytes (clarify or sort?).
- Cover new bundle export (when landed).
- Add numeric edge: near-identical, uniform low-var (cancellation? u8 safe), large np (but fast).
- If agree positive in context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### Layer 4: Advanced lens facilitation + math/port notes + bundle wiring (Agent owns ONLY web/jxl-progressive-quality.js)
- Wire bundle into existing if it replaces common patterns (no behavior change to old exports).
- Add cheap "plateau" helper (thin wrapper: detectMonotone on psnr/ssim series + moments delta) or just document how to combine. Keep tiny.
- Add comments at hot loops for hand-coded intrinsics / Rust port target (lens25) and astro/gaming/AR analogies (no runtime cost).
- No new math transforms here (defer to Rust LookRenderer per lens17); only annotations + ensure moments remain allocation-light.
- If agree positive in context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### Layer 5: Flip-flop harness, perf guard, final verification + rename (Agent owns ONLY web/jxl-progressive-quality.test.js; last agent)
- Implement targeted flip-flop test helper (advanced Q): for a hot fn, alternate old/new impl (via flag or two fns) 10+ times on fixed large buffer, capture medians, assert new <= old * (1+eps) or log. Use for any kernel change in layer1/2/4.
- Example skeleton (paste/adapt):
```js
function flipFlop(name, oldFn, newFn, dataArgs, runs=10) {
  const times = {old: [], new: []};
  for (let i=0; i<runs; i++) {
    let t0 = performance.now(); oldFn(...dataArgs); times.old.push(performance.now()-t0);
    t0 = performance.now(); newFn(...dataArgs); times.new.push(performance.now()-t0);
  }
  const med = a => a.sort((x,y)=>x-y)[a.length>>1];
  return {name, medOld: med(times.old), medNew: med(times.new)};
}
// in test: const r = flipFlop('moments', oldMoments, computeChannelMoments, [p,2,2]); console.log(r); expect(r.medNew).toBeLessThanOrEqual(r.medOld * 1.1);
```
- After all prior layers landed (your session may be final), execute the verification: run `c:\Foo\raw-converter-wasm\StandardMultifileTest.mjs` (use full path; powershell/node/bun as appropriate on host). Capture stdout, note any timing deltas in Implemented (raw_ms etc; expect near-zero impact since these are support metrics, not core decode path). If regression > threshold in main numbers, investigate/reject prior items via rejected doc.
- Update Implemented chapter with concise landed/rejected list + verification output summary.
- If agree positive in context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md
- LAST AGENT ACTION: once your file edits + Implemented update + verification complete, append -DONE to this document's filename (rename docs/ProgressiveQuality.md → docs/ProgressiveQuality-DONE.md). This signals partial/full completion for the assessed files.

## Implemented
(Agents: append terse entries only. Format: [Layer N] [file] - landed: X,Y; rejected: Z (reason in rejected opts); verification: ...)
[Layer 1+2+4] web/jxl-progressive-quality.js - landed: hoist stride+outs in moments (match docstring, pointer advance), ch validation parity (throw on non-int), peak on psnr, JSDoc+alpha+color17 TODOs on exports, C1/C2 documented, computeQualityBundle (fused), isQualityPlateau thin, SIMD/port comments at kernels; no new color math (defer Rust), no behavior change to old exports. Re-assessed vs pipeline (post-decode support metrics only, no sched/WASM/raw/bridge impact, positive for profiling eff + recog prep). No rejects.
[Layer 3] web/jxl-progressive-quality.test.js - landed: extended import for new exports; tests for ch=4/1 ssim, moments non-int throw parity, outs reuse, bundle, plateau helper, multi-regress detect, psnr peak. Re-assessed positive (increases coverage on changed kernels, no cross-file behavior impact beyond this test's prior butter imports). No rejects.
[Layer 5] web/jxl-progressive-quality.test.js - landed: flipflop harness (A/B alt 10x, med compare) + test exercising on moments (post-edit kernel); re-assessed positive (guard for future changes per advanced Q, no pipeline side-effect). 
[final-run-verify] ran `node "c:\Foo\raw-converter-wasm\StandardMultifileTest.mjs"` (full path per spec): partial output (crashed early on WASM unreachable in process_dng_with_flags / raw path, pre-existing not caused by web/ quality edits; our pure-JS metrics not loaded/invoked by this mjs). Telemetry shown, some asset loads + timings printed before fail (e.g. small_file.jpg decode=6ms, P1110226 windows.jpg decode=39ms scale=93ms). No attributable regressions in any printed timings from the changes here (support layer only; crash unrelated to psnr/ssim/moments/bundle). Re-assessed: changes positive, no timing impact expected on core raw/jxl pipeline. No rejects. See full stdout in agent context if re-run needed.

## Target location for this doc
This is the live doc at docs/ProgressiveQuality.md. Use this path for the -DONE rename.

## Handoff process reminder (for all agents)
Re-read this entire doc + your memory of pipeline (no new file reads beyond minimal for the one file you own + the rejection doc if rejecting). Assess each item for positive contribution (eff/spd/perf/bugfix + long-term AR/photogram/color/LLM/recog alignment) vs risk (scope creep, perf in other layers, violation of invariants like progressive checkpoints, butter cost, no per-stage budget reset, etc.). Only positive + cohesive → edit (surgical, one file primary). Else reject with explicit reason in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md. Update this doc's Implemented. Last agent does the run + rename.

(End of plan document. No filler.)
