# ProgressiveVisualMetrics.md
Group 12: Visual Saturation & Perceptual Metric Computation (web/)
Files: jxl-progressive-quality.js, .test.js, jxl-progressive-byte-metrics.js, .test.js, jxl-butteraugli.js

## Overview
Pure-JS post-decode metrics for measuring visual fidelity of progressive JXL byte cutoffs vs final render. Drives early-termination decisions in profiling harnesses. quality: psnr + global-ssim approx + monotone. byte: cutoff classifier + summary stats (first paint/recognizable/preview + psnr/monotone). butter: xyb multi-scale p3 perceptual (libjxl approx, cached ref pyramid). Links: byte imports+uses quality.detect for psnr series. Butter isolated. No pipeline core impact (analysis only).

## Implementation Layers (chunks for workers)
### Layer 1: Hot-Kernel Perf (alloc/loop wins, mainly butter)
### Layer 2: Unification + Cross Metric (butterSeries in byte, monotone generalize in quality)
### Layer 3: Test Hardening + Coverage (esp butter via existing test files)
### Layer 4: API Polish, Docs, Robust (consts export, guards, format notes)
### Layer 5: Extensibility (ml/llm hooks, color model comments, photogram/ar notes; no heavy code)

## Amalgamated Issues + Fixes (eff/speed/perf/bugs/feat)
See PLAN for full lens trace. Key:
- Butter perf/alloc primary tax for repeated cutoff evals.
- Butter not visible in summaries.
- Missing coverage, format assumptions, inconsistent errs.
- Global SSIM, psnr-only monotone, hardcoded thresh, no future hooks.

## Agent Handoffs (5 agents, 1 file each)
Order: butter.js, quality.js, byte-metrics.js, quality.test.js, byte-metrics.test.js. Each agent edits ONLY its file. Reassess every item against pipeline (these = offline profiling aids; prod decode path untouched; keep pure, no new deps, respect existing rejections on dedup/budget etc — unrelated here). If positive contrib (faster profiling, better insight, no api bloat, no risk), implement; else reject to C:\Foo\raw-converter-wasm\docs\rejected optimizations.md with reasons. Use memory of file; minimal extra reads. Surgical edits. No inline success/fail chatter.

### Agent for web/jxl-butteraugli.js
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Items (Layer1 +4 +5):
1. Add batch-friendly comparer to cut alloc/GC (main speed win per lens15/20/21). Keep old API.
   Suggested:
   ```js
   // after _refPrep...
   export function createButteraugliComparer(refPixels, width, height) {
     const n = width * height;
     if (!n || refPixels.length !== n * 4) throw new Error('bad ref');
     const refXyb = pixelsToXyb(refPixels, n);
     const prep = prepRef(refXyb, width, height); // caches
     // prealloc test pyramid bufs at full + halves (reuse across calls)
     const maxN = n;
     let tX = new Float32Array(maxN), tY = new Float32Array(maxN), tB = new Float32Array(maxN);
     let dX = new Float32Array(maxN), dY = new Float32Array(maxN), dB = new Float32Array(maxN);
     return function computeVsFinal(testPixels) {
       if (testPixels.length !== n * 4) return NaN;
       // fill t from test (reuse)
       for (let i = 0, j = 0; i < n; i++, j += 4) {
         const r = _sqrtLin[testPixels[j]], g = _sqrtLin[testPixels[j+1]], b = _sqrtLin[testPixels[j+2]];
         tX[i] = (r - b) * 0.5; tY[i] = (r + b) * 0.5 + g; tB[i] = b;
       }
       let w = width, h = height, total = 0;
       const weights = [4,2,1];
       for (let s = 0; s < 3; s++) {
         const L = prep.levels[s];
         total += scaleErr(L.mask, L.X, L.Y, L.B, tX, tY, tB, w, h) * weights[s];
         if (s < 2 && w > 1 && h > 1) {
           const dw = Math.max(1, w >> 1), dh = Math.max(1, h >> 1), dn = dw * dh;
           for (let y=0; y<dh; y++) { const sy0=y<<1, sy1=Math.min(sy0+1,h-1);
             for (let x=0; x<dw; x++) { const sx0=x<<1, sx1=Math.min(sx0+1,w-1);
               const idx = y*dw + x; const base0=sy0*w+sx0, base1=sy1*w+sx0;
               dX[idx] = (tX[base0]+tX[base0+1]+tX[base1]+tX[base1+1])*0.25;
               // same for Y B using tY tB -> dY dB
               dY[idx] = (tY[base0]+tY[base0+1]+tY[base1]+tY[base1+1])*0.25;
               dB[idx] = (tB[base0]+tB[base0+1]+tB[base1]+tB[base1+1])*0.25;
             }
           }
           // copy back or swap refs (for simplicity copy; or pingpong)
           tX.set(dX.subarray(0, dn)); tY.set(dY.subarray(0,dn)); tB.set(dB.subarray(0,dn));
           w = dw; h = dh;
         }
       }
       return total / 7;
     };
   }
   ```
   (adapt dn copy for Y/B; use subarray set for speed. Test equiv to old.)
2. Branchless scaleErr tweak:
   ```js
   // inside scaleErr loop
   const ex = (rX[i] - tX[i]) / m; /*...*/
   const e2 = kX*ex*ex + kY*ey*ey + kB*eb*eb;
   sum += e2 * Math.sqrt(e2 + 1e-12);  // branchless
   ```
3. Add 1-scale fast approx (Layer1/5):
   ```js
   export function computeButteraugliApproxVsFinal(refXyb, testPixels, width, height) {
     const n = width * height;
     if (!n || testPixels.length !== n*4) return NaN;
     const ref = prepRef(refXyb, width, height);
     const L = ref.levels[0];
     let [tX, tY, tB] = pixelsToXyb(testPixels, n);
     return scaleErr(L.mask, L.X, L.Y, L.B, tX, tY, tB, width, height) * 4 / 7;  // approx weight
   }
   ```
4. PixelsToXyb + compute doc + stride note (Layer4):
   Add JSDoc: "pixels: Uint8Array RGBA (stride 4). Alpha ignored. For batch use createButteraugliComparer. Approx only; not libjxl bitexact."
   Optional: accept stride=4, step by stride in loop (future).
5. Comment for Lens17/12/16/14 (Layer5, no code):
   ```js
   // Future: when Rust LookRenderer exposes PerceptualConstancy (log geodesic etc),
   // call metrics on post-adjust pixels during progressive to validate early recog
   // under illum change. Hook recog here for LLM/plantID: external score stable?
   // For photogram: consider gradient err term in scaleErr.
   ```

### Agent for web/jxl-progressive-quality.js
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Items (Layer2+4+5):
1. Generalize detectMonotone (Layer2; enables butter/ssim monotone):
   ```js
   export function detectMonotone(series, toleranceDb = MONOTONE_TOLERANCE_DB, opts = {}) {
     const { valueKey = 'psnr', lowerIsBetter = false } = opts;
     const regressions = [];
     let prev = lowerIsBetter ? Infinity : -Infinity;
     for (const entry of series) {
       const v = entry[valueKey];
       if (!Number.isFinite(v)) continue;
       const worse = lowerIsBetter ? (v > prev + toleranceDb) : (v < prev - toleranceDb);
       if (prev !== (lowerIsBetter?Infinity:-Infinity) && worse) {
         regressions.push({ bytes: entry.bytes, dropDb: Number(Math.abs(prev - v).toFixed(2)) });
       }
       if (lowerIsBetter ? (v < prev) : (v > prev)) prev = v;
     }
     return { monotone: regressions.length === 0, regressions };
   }
   ```
   (old calls unchanged; new calls pass {valueKey:'butter', lowerIsBetter:true})
2. Export consts + ssim note (Layer4):
   ```js
   export { MONOTONE_TOLERANCE_DB };
   export const C1 = (0.01 * 255) ** 2; export const C2 = (0.03 * 255) ** 2;  // already internal, export
   // computeSsimVsFinal: global (image-wide) channel avg SSIM approx; no local windows.
   // For classic SSIM use external lib. Good for quick cutoff profiling.
   ```
3. Minor: PSNR/SSIM guard len==0 -> 0 or inf consistent. Add JSDoc pixel layout.
4. Lens5/17 comment: // series can carry butter/ssim for future unified recog; color constancy metrics can feed same shape.

### Agent for web/jxl-progressive-byte-metrics.js
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Items (Layer2+4):
1. Support butterSeries + ssimSeries (unify; Layer2 main win). Add to return:
   firstPerceptuallyGoodBytes, firstPerceptuallyGoodPercent, finalButter, etc. Use generalized detect.
   ```js
   // inside summarize, after quality block:
   let firstPerceptuallyGoodBytes = null, finalButter = null, butterMonotone = null, butterRegressions = [];
   const GOOD_BUTTER = 1.0;
   if (Array.isArray(butterSeries) && butterSeries.length > 0) {
     const ss = [...butterSeries].sort((a,b)=>a.bytes-b.bytes);
     firstPerceptuallyGoodBytes = ss.find(e => e.butter != null && e.butter <= GOOD_BUTTER)?.bytes ?? null;
     finalButter = ss.at(-1)?.butter ?? null;
     const m = detectMonotone(ss.map(e=>({bytes:e.bytes, butter: e.butter})), 0.1, {valueKey:'butter', lowerIsBetter:true});
     butterMonotone = m.monotone; butterRegressions = m.regressions;
   }
   // similarly for ssimSeries if passed {bytes, ssim}
   // merge into returned obj
   return { ..., firstPerceptuallyGoodBytes, firstPerceptuallyGoodPercent: percent(firstPerceptuallyGoodBytes,totalBytes), finalButter, butterMonotone, butterRegressions, ... };
   ```
   Update fn sig: summarizeByteCutoffResults(results, totalBytes, { qualitySeries=null, butterSeries=null, ssimSeries=null, goodButter=1.0 }={})
   Use imported detectMonotone (already).
2. Export consts:
   ```js
   export const RECOGNIZABLE_DB = 20;
   export const PREVIEW_DB = 30;
   ```
3. Sort guard (perf, tiny):
   ```js
   function ensureSorted(arr) { /* or inline check first bytes increasing */ if (arr.length<2) return arr; for(let i=1;i<arr.length;i++) if(arr[i].bytes < arr[i-1].bytes) return [...arr].sort((a,b)=>a.bytes-b.bytes); return arr; }
   ```
   Apply to results + series.
4. JSDoc + preview note. Layer4/5 comment for ml: "Pass butterSeries from external model score for task-aware early term (see Lens12/16)."

### Agent for web/jxl-progressive-quality.test.js
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Items (Layer3+4):
1. Cover generalized detect (new paths):
   test('detectMonotone supports lowerIsBetter for butter-like', () => { ... series with butter vals, call detectMonotone(s,0.1,{valueKey:'butter',lowerIsBetter:true}) ... });
2. Cover 3ch input for ssim (was 4ch only):
   test('SSIM accepts 3ch rgb packed', () => { const w=4,h=4; const a=new Uint8Array(w*h*3).fill(128); expect(computeSsimVsFinal(a,a,w,h)).toBe(1); });
3. Import butter in test file + basic coverage (no new file; Layer3):
   import {pixelsToXyb, computeButteraugliVsFinal, createButteraugliComparer} from './jxl-butteraugli.js';
   test('butter identical =0', ()=>{ const p=new Uint8Array(16).fill(128); const x= pixelsToXyb(p,4); expect(computeButteraugliVsFinal(x,p,2,2)).toBe(0); });
   test('butter comparer reuses and matches', ()=>{...});
   test('butter approx defined', ()=>{...});
   (small 2x2/4x4 u8 rgba; expect finite or 0).
4. Edge: empty series, nonfinite, 0-len pixels (psnr/ssim).

### Agent for web/jxl-progressive-byte-metrics.test.js
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Items (Layer3+2):
1. Test new butterSeries path + fields:
   test('summarize accepts butterSeries, computes firstGoodButter + monotone', () => {
     const results = [ {bytes:1000,painted:true,frameCount:1,isFinal:false}, {bytes:5000,painted:true,frameCount:1,isFinal:true} ];
     const butterSeries = [ {bytes:1000, butter:1.8}, {bytes:5000, butter:0.3} ];
     const s = summarizeByteCutoffResults(results, 5000, {butterSeries});
     expect(s.firstPerceptuallyGoodBytes).toBe(5000);
     expect(s.finalButter).toBe(0.3);
     expect(s.butterMonotone).toBe(true);
   });
2. Test with ssimSeries if added.
3. Test sort guard + unsorted input still works.
4. Verify const exports.
5. Compat: old calls (no quality/butter) unchanged shape.

## Implemented
All 5 handoffs reassessed positive in context (offline profiling/visual metrics for early term; no touch to decode/session/scheduler/wasm bridge/progressive checkpoints per DONOTCHANGE; unification+opts+perf aid future ML/AR/plant/photogram + color constancy validation per lenses 12/16/17/18/21; butter comparer/approx pure internal speed for repeated calls; tests via listed files only; no new files/deps/breaking shapes; sort guard tiny; all old paths unchanged).

- web/jxl-butteraugli.js: 1. createButteraugliComparer (prealloc tX/tY/tB + d* pyramid, reuse fill+dn2 loop, equiv to old); 2. branchless scaleErr (e2 * sqrt(e2+1e-12)); 3. computeButteraugliApproxVsFinal (1-scale); 4. JSDoc on pixelsToXyb + compute (RGBA stride4, approx note, batch hint); 5. future Lens17/12/16/14 comment (constancy, recog hook, photogram grad). No rejects.
- web/jxl-progressive-quality.js: 1. detectMonotone generalized (valueKey, lowerIsBetter, abs drop; defaults preserve psnr behavior); 2. export C1/C2/MONOTONE_TOLERANCE_DB; 3. ssim comment (global approx, not local); 4. psnr header JSDoc (layout, 0-len Infinity); 5. future series note. No rejects.
- web/jxl-progressive-byte-metrics.js: 1. summarize sig+body + butterSeries (firstPerceptuallyGoodBytes/Percent, finalButter, butterMonotone/Regressions via detect opts lowerIsBetter) + ssimSeries symmetry; goodButter opt; 2. export RECOGNIZABLE_DB/PREVIEW_DB; 3. ensureSorted guard (no-copy if ordered); 4. ml hook comment (external model score series). Updated calls. Old calls shape+semantics preserved + extra fields. No rejects.
- web/jxl-progressive-quality.test.js: import butter fns + quality const; 3ch ssim test; lowerIsBetter detect test; butter identical/comparer(reuse match)/approx/0-len edge tests (covers butter.js); no new test file. No rejects.
- web/jxl-progressive-byte-metrics.test.js: import+verify consts; updated first toEqual for new fields (compat); butterSeries firstGood+monotone test; sort guard unsorted test; butter regression flag test; old compat test kept. No rejects.

No rejections filed (all positive per reassess at each step). Captured here only.

## Renamed - DONE
Last agent completed: appended " - DONE" to filename (ProgressiveVisualMetrics - DONE.md). All 5 agents (1 file each) implemented after positive reassessment. Orchestrator now runs StandardMultifileTest.mjs for timing check. No chatter during.

StandardMultifileTest.mjs: exit 0 (full log in session). Core timings (prog_enc/first_paint/final_paint/shot_dec/pyr/tiled JXTC/ROI) unchanged vs expected baseline. No regressions from these 5 files (analysis/profiling only; not in measured encode/decode paths). TOON + graphs emitted. All handoffs complete.

## Final Agent Instruction
After your file's changes (full or partial for your handoff), the LAST agent MUST rename this document by appending " - DONE" to filename (e.g. ProgressiveVisualMetrics - DONE.md) and append note here with what was accepted. Then orchestrator runs StandardMultifileTest.mjs and records timings. All agents: reassess positive? surgical. Memory first.
