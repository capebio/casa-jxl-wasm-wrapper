# Deferred Optimizations: Timing Tests Required

## Overview

This file tracks optimizations proposed during code reviews that were deferred or rejected specifically because they lack timing/benchmark evidence or require test validation before implementation. These are **not architectural rejections** — they are valid optimizations whose safety or effectiveness cannot be confirmed without measurement.

## Test Resources for Agents

Agents working on any of these items should use one of the following testing approaches:

- **[flipflop](https://example.com)** skill: Advanced benchmark orchestration with A/B control + confidence intervals. Invoke the skill directly for turbo-charged benchmark runs.
- **StandardMultifileTest.mjs**: Suite harness covering real JXL/RAW files. Located at `C:\Foo\raw-converter-wasm\StandardMultifileTest.mjs`. Run with `node StandardMultifileTest.mjs` to verify output correctness.
- **benchmark-metrics-10x.mjs**: Per-codec timing metrics (10 runs). Located at `C:\Foo\raw-converter-wasm\benchmark-metrics-10x.mjs`. Measures end-to-end latency across real test corpus.
- **Custom bench**: Design your own using existing harness patterns in `crates/raw-pipeline/src/bin/raw_decode_bench.rs` or `web/jxl-*.js` benchmark pages. Must include statistical controls (min/median/p95, thermal baseline, cold-start discard).

When submitting results, include: **baseline (ms), optimized (ms), improvement (%), test corpus, runs/samples, thermal variance, statistical significance**.

---

## Tier 1: Critical Path (Cost Centers)

### crates/raw-pipeline/src/pipeline.rs

**[1] PR-1: Clarity pass rayon-row + SIMD vectorization (line 701)** ☐
- **Proposed:** Add rayon parallelism + SIMD (AVX2/wasm128) to the unsharp clarity pass.
- **Deferred reason:** Clarity is single-threaded scalar loop. No isolated baseline established. Thermal variance in prior benches exceeded any plausible gain; no corpus-level measurement confirming clarity is on the critical path.
- **Verify:** Profile a real ORF/DNG file with clarity enabled; confirm time spent in clarity > 5% of total. If yes, benchmark rayon+SIMD branch vs current scalar.
- **Acceptance:** Isolated clarity bench shows >5% improvement on real files with <2% thermal variance.

**[2] PR-6: Luminance NR + downscale parallelism (lines 1393/1503/1493)** ☐
- **Proposed:** Parallelize `apply_luminance_nr` and integer/box downscale paths (currently single-threaded under `parallel` feature gate).
- **Deferred reason:** Only provably on critical path after tone/apply_tone_math kernel (70% cost center, already SIMD). These are downstream; profiler data needed to confirm they are not dominated by tone.
- **Verify:** Run `raw_decode_bench --features jxl-codec` (or native MSVC bench) with flame graph or perf data. Confirm apply_luminance_nr + downscale > 5% of total post-tone.
- **Acceptance:** Profiler shows the two functions as independent cost centers >5% each, then benchmark rayon+SIMD branch.

---

### crates/raw-pipeline/src/ljpeg.rs

**[3] RP-2026-06-12: Replace thread-local DHT cache** ☐
- **Proposed:** Current thread-local DHT cache. Proposed: replace it + add planar decode API + restart-marker hook.
- **Deferred reason:** "Current cache no longer critical path." Current cache rebuild is <1% of CR2 time per CR2-R2 baseline. No benchmark proving the cache is the bottleneck.
- **Verify:** Profile CR2 decode on real Canon files. Confirm DHT rebuild+search is detectable (>1% of LJPEG time).
- **Acceptance:** Bench shows DHT hot spot >1%, then measure cache-replacement proposal.

**[4] PR-7c: DHT linear scan optimization** ☐
- **Proposed:** Optimize DHT table rebuild + linear scan per segment.
- **Deferred reason:** No bench proving DHT cache/scan on critical path. Huffman table rebuild <1% of CR2 time per baseline.
- **Verify:** Same as [3]. Use `raw_decode_bench` CR2 file with thermal baseline (3 runs, discard cold, take min).
- **Acceptance:** Confirms DHT on critical path, then measure replacement.

---

### crates/raw-pipeline/src/demosaic.rs

**[5] RP-2026-06-12: Fuse matrix math into MHC hot kernels + add SIMD + planar APIs** ☐
- **Proposed:** Fuse matrix math into bilinear MHC kernel, add SIMD path (AVX2/wasm128), expose planar/_into output APIs, expose saliency contract.
- **Deferred reason:** "Correctness bug fixed first: Kernel fusion/SIMD/public output-shape expansion are performance and API changes without benchmark evidence in this session."
- **Verify:** Profile DNG file demosaic step in isolation. Confirm matrix math + bilinear interior loop >10% of total demosaic time.
- **Acceptance:** Isolated demosaic bench shows kernel fusion >5% improvement, then API expansion (on separate branch).

**[6] PR-3: WASM SIMD scatter fix (interior-loop scatter, line ~379)** ☐
- **Proposed:** Fix 8-wide SIMD vector followed by 24 scalar stores (scatter eats SIMD win).
- **Deferred reason:** Valid finding; no corpus-level measurement showing it is on the critical path for primary WASM demosaic workload.
- **Verify:** WASM decode of ORF/DNG via web/pkg + profiler or `__jxlPerf` harness. Confirm scatter loop >2% of demosaic time.
- **Acceptance:** Bench shows scatter loop >2% demosaic time, measure SIMD vector consolidation.

**[7] PR-4: CFA match + border-clamp hoist (interior-loop dispatch, line ~838)** ☐
- **Proposed:** Hoist per-pixel 4-way CFA dispatch + border clamp out of interior loop.
- **Deferred reason:** Interior `match` is output-identical reordering, but no demosaic-level bench confirming it is the dominant cost. LJPEG is historically 97% of CR2; DNG tile decode likely bottleneck before this.
- **Verify:** Profile DNG/ORF demosaic in isolation. Confirm CFA dispatch >3% of demosaic time.
- **Acceptance:** Isolated demosaic bench shows dispatch >3%, measure hoist.

---

### packages/jxl-wasm/src/facade.ts + bridge.cpp

**[8] Partial-frame-on-error from facade events() to decode-handler** ☐
- **Proposed:** Capture last good pass on error so truncated progressive decode is not discarded.
- **Deferred reason:** Requires full-frame copy on hot progressive path (detaches buffer), or unsafe post-error `dec_take_flushed` (undefined behavior). Blocked on a bridge-level `dec_take_partial` guarantee. Output-fidelity gate (lens 24).
- **Verify:** Once bridge.cpp/libjxl offers safe partial-frame capture (e.g., `dec_take_partial` libjxl API), measure: (1) pixel data valid at error time (compare to ground truth), (2) memory cost of copy vs zero-copy.
- **Acceptance:** Safe bridge API exists + bench shows acceptable memory cost.

**[9] Box-filter decode-time downsampling (replace nearest-neighbour in DownsampleRgba)** ☐
- **Proposed:** Replace nearest-neighbour with box-filter during downsampling for less aliasing on field/biodiversity images.
- **Deferred reason:** Genuine quality improvement but changes pixel output. Must be gated on golden-image SSIM diffs AND user's own viewer (see feedback: RGB-mean parity ≠ user's viewer).
- **Verify:** (1) Encode real JXL with box-filter downsampling enabled. (2) Decode at various scales. (3) Compare SSIM vs nearest-neighbour baseline. (4) Get user visual confirmation on real biodiversity samples (not just metrics).
- **Acceptance:** SSIM >0.5% improvement (statistically significant) + user visual sign-off.

**[10] Fixed-point (8.8) rewrite of bilinearResize rgba16/rgbaf32 branches** ☐
- **Proposed:** Extend rgba8's 8.8 fixed-point to rgba16/float for ALU saving.
- **Deferred reason:** Changes rounding + pixel values for high-bit-depth output — fidelity risk on exactly the path the biodiversity platform cares about. Marginal ALU saving not worth it.
- **Verify:** If pursued: pixel-exact parity test on real 16-bit + float images. Confirm rounding behavior matches current double-precision path.
- **Acceptance:** Pixel-exact output or acceptable SSIM delta <0.1 dB, user sign-off.

**[11] Per-call alloc of x-weight array in bilinearResize as cross-frame cache** ☐
- **Proposed:** Store hoisted xtIs[] on the ResizePlan for reuse across frames instead of per-call Int32Array(dstW).
- **Deferred reason:** ResizePlan already caches resize axes; adding third parallel array widens plan contract for <1% gain, risks staleness if dstW changes.
- **Verify:** Measure (1) per-call Int32Array(dstW) alloc cost vs benefit, (2) cache hit rate if stored on plan (how often does dstW stay constant across frames?).
- **Acceptance:** Profiler shows Int32Array alloc >1% of resize time AND cache hit rate >70% across test sequence.

---

### packages/jxl-worker-browser/src/decode-handler.ts

**[12] D-5: JS-Side Speculative Chunk Coalescing** ☐
- **Proposed:** Coalesce multiple small chunks using `Buffer.concat` before `decoder.push()` when queue depth high + total size <1 MiB.
- **Deferred reason:** "No Empirical Benchmark Support." Speculative memory + GC overhead may outweigh FFI savings. Conflicts with progressive rendering latency (first-paint metrics).
- **Verify:** Benchmark on real JXL stream with varying chunk sizes (1 KB, 10 KB, 100 KB). Measure: (1) decode time, (2) GC pressure (heap size), (3) time-to-first-frame.
- **Acceptance:** Bench shows >3% decode speedup on small-chunk streams, no increase in heap pressure, no regression in time-to-first-frame.

**[13] R14-D2: Add pause check between inner while iterations** ☐
- **Proposed:** Add pause check inside `decoder.push()` inner loop for better interruptibility.
- **Deferred reason:** `push()` is strictly synchronous (no await/microtask yield between iterations). Premise is false for any JXL decode fitting in single event-loop turn. Existing check at outer loop (before `waitForQueueItem`) is correct location.
- **Verify:** Not applicable — premise is architectural, not timing. Reject or clarify if new async-resumable push API added to libjxl.
- **Acceptance:** N/A unless libjxl changes architecture.

---

### crates/raw-pipeline/src/dng.rs

**[14] RP-2026-06-12: Parsed LjpegPlan + shared decode plan + DngDecodePlan provenance** ☐
- **Proposed:** Introduce `LjpegPlan`, share decode plan across tiles, bounded tile queue, structured `DngDecodePlan` provenance object.
- **Deferred reason:** "Larger architectural refactor: cross-file (dng.rs, ljpeg.rs); rework tile decode ownership + cache lifetime. Needs dedicated measurement pass against new baseline."
- **Verify:** (1) Establish baseline on real DNG files with current architecture. (2) Implement LjpegPlan + provenance on isolated branch. (3) Bench end-to-end DNG decode.
- **Acceptance:** >5% improvement measured on DNG decode end-to-end, no output regression.

**[15] PR-5: Uncompressed tile/strip parallel + hoisted byte-order** ☐
- **Proposed:** Add rayon parallelism + hoist per-pixel endianness branch for uncompressed DNG tile/strip decode.
- **Deferred reason:** Fully serial with per-pixel endian branch. Rayon + hoist would help — but uncompressed DNG tiles uncommon in current corpus. Reject until corpus of uncompressed DNGs exists.
- **Verify:** Acquire real uncompressed DNG files (or generate synthetic test suite). Benchmark `process_into` on uncompressed vs compressed DNG.
- **Acceptance:** Uncompressed DNG >10% of target corpus AND >5% improvement measured.

---

## Tier 2: Secondary Path (Important but Not Critical)

### crates/raw-pipeline/src/cr2.rs

**[16] CR2-R2: Concurrency inside CR2 decode** ☐
- **Proposed:** Split LJPEG strip into segments for parallel Huffman decode across restart intervals.
- **Deferred reason:** Canon CR2 is single-strip stream with continuous Huffman state. No restart markers in most Canon files. A future pass could analyse whether files consistently use restart intervals; if so, parallelism becomes feasible. Estimate: 3–4× on 4-core machine.
- **Verify:** Scan test corpus of real Canon CR2 files. Count how many have valid restart markers (0xFFD0–0xFFD7). If >80% of corpus, benchmark parallel Huffman decode proposal.
- **Acceptance:** >80% of test corpus has restart markers, benchmark shows >3× improvement on those files.

**[17] CR2-R1: SIMD for crop compaction** ☐
- **Proposed:** Vectorize in-place crop loop (`copy_within` per row) with SIMD (wasm128/AVX2).
- **Deferred reason:** Crop is 1.0% of total CR2 time. LJPEG is 97%. Max gain from 10× speedup of crop is 0.9% end-to-end. Thermal noise in benches exceeds this by 50×.
- **Verify:** Profile real CR2 decode. Confirm crop >2% of time in your benchmark environment (baseline drift from 2026-06-15 session).
- **Acceptance:** Crop >2% of time AND >3% improvement measured with <1% thermal variance.

---

### crates/raw-pipeline/src/perceptual/simd/

**[18] PR-7a: AVX2 f64 lane drop (frame_stats.rs:127)** ☐
- **Proposed:** Luma accumulation currently falls back to scalar f64 per lane instead of vectorized f64 reduction.
- **Deferred reason:** Output-changing (accumulator precision). Needs ADR sign-off per deferred f32→f64 item. Micro-opt without correctness sign-off.
- **Verify:** (1) User/architecture review: is f64 accumulation acceptable or must stay f32? (2) If f64 approved, measure bench before/after (likely <1% impact).
- **Acceptance:** Architecture decision made + bench confirms no regression.

---

### web/jxl-progressive-byte-benchmark.js

**[19] Wire WASM buildSeriesAsync (PSNR/SSIM via PerceptualComparer) into core's sync buildSeries** ☐
- **Proposed:** Replace JS PSNR/SSIM with WASM perceptual kernel (2× free performance).
- **Deferred reason:** High-value but blocked on dist rebuild. Requires importing PerceptualComparer + confirmed WASM exports (not reliably present in Node benchmark context due to dist-rebuild gap).
- **Verify:** (1) Rebuild wasm package via `build-parallel-wasm.ps1` or equivalent. (2) Verify facade.ts exports PerceptualComparer + hooks. (3) Benchmark byte-benchmark with/without WASM metrics.
- **Acceptance:** Dist rebuilt, WASM exports verified, >50% speedup on metric calculation (2× free).

**[20] Apply doFull adaptive skip to SSIM (as already done for Butteraugli)** ☐
- **Proposed:** Skip SSIM metric calculation on cutoff threshold (like Butteraugli adaptive path).
- **Deferred reason:** Skipping inserts null; `firstGoodSsimBytes` uses `.find(e => e.ssim != null)`. A skipped threshold would report "first good SSIM" later (fidelity regression) without golden/SSIM diff gate.
- **Verify:** Measure SSIM cost vs Butteraugli. If SSIM alone >10% of total metric time, and user accepts slightly later "first good" reporting, propose with gate.
- **Acceptance:** SSIM >10% of metric time, user accepts fidelity change, bench confirms savings.

---

### crates/raw-pipeline/src/frame_stats.rs + web/jxl-frame-stats-worker.js

**[21] Progressive Perceptual Analysis Worker: TEMPORAL DELTA ANALYSIS** ☐
- **Proposed:** Track per-pixel delta (prev vs current pass) for convergence/acceleration surrogate.
- **Deferred reason:** psnrDelta gating + detectMonotone already provide surrogate. Pixel delta would alloc extra buffers per pass (memory cost similar to another metric pass), only useful for "changed regions" (not present). No caller consumes delta for refinement beyond existing plateau.
- **Verify:** Profile real progressive JXL sequence. Measure: (1) overhead of extra delta alloc per pass, (2) utility (would delta allow earlier stop vs psnrDelta?).
- **Acceptance:** Delta serum overhead <5% AND demonstrates >3% fewer passes needed for same quality.

**[22] Progressive Perceptual Analysis Worker: STRUCTURAL STATISTICS SHARING** ☐
- **Proposed:** Unify moments (mu/var), blur, gradient, luma into single pass (one mean/var/grad/lum feed SSIM+Butteraugli+saliency).
- **Deferred reason:** Deep fusion requires changes to hot paths; current cost low; no evidence shared JS struct wins vs separate passes.
- **Verify:** Profile worker on real image. Measure: (1) separate passes cost (current), (2) unify overhead. If unify saves >10% worker time, benchmark.
- **Acceptance:** Unified path shows >10% improvement on worker time + no output regression.

**[23] Progressive Perceptual Analysis Worker: RESULT MEMORY FORMAT** ☐
- **Proposed:** Change result objects to typed arrays for better transfer + perf on large series.
- **Deferred reason:** N small (typically <20 passes). Current object format fine for single consumer. Changing would require caller + test updates with unclear GC benefit for small N.
- **Verify:** Measure GC pressure on real progressive sequence. If heap pressure >10% of frame data, benchmark typed-array refactor.
- **Acceptance:** GC proves problematic (>10% overhead) AND typed-array refactor shows >5% improvement.

**[24] Progressive Perceptual Analysis Worker: CONFIDENCE AND STOP CONDITIONS** ☐
- **Proposed:** Add {score, confidence, action: continue|refine|stop} decision logic in worker.
- **Deferred reason:** Policy (plateau detection, epsilon rules) correctly lives in caller, not worker. Worker stays data provider.
- **Verify:** Design is architectural, not timing-based. If user wants worker-side intelligence, document policy spec first.
- **Acceptance:** Not a timing deferral — requires policy decision + spec.

**[25] Progressive Perceptual Analysis Worker: DARK-LENS OPPORTUNITIES** ☐
- **Proposed:** Entropy scoring, multi-scale feature pyramid, temporal convolution rate, SharedArrayBuffer.
- **Deferred reason:** All marked "investigate but do not force" + research items. No current consumers. Would require new architecture + mutable shared views. Premature.
- **Verify:** Assess: (1) real-world benefit (plant recognition / digital twin use), (2) integration effort. Defer until concrete use case + consumer exist.
- **Acceptance:** Use case exists + consumer integrated.

---

## Tier 3: Lower Impact / Offline Path

### web/jxl-decode-worker.js

**[26] DW-3: Short-circuit extractEmbeddedJpegs to find only first JPEG** ☐
- **Proposed:** Only `jpegs[0]` is used; scan just to first JPEG instead of all SOIs.
- **Deferred reason:** Only runs on rare JXTC reconstruction containers, off hot path. Scanning for second SOI is still required to validate restart intervals (preserving exact semantics). For single-JPEG containers, that's the whole buffer anyway.
- **Verify:** Profile rare JXTC file. Measure extractEmbeddedJpegs cost vs total decode. If >0.5% of decode time, benchmark short-circuit.
- **Acceptance:** extractEmbeddedJpegs >0.5% of JXTC decode + bench confirms measurable gain.

---

## Uncertain File Origins / Unclear Scope

**[27] R14-F14: Replace distanceFromQuality(q) formula with libjxl reference** ☐
- **Location:** Unknown (possibly facade.ts or jxl-wasm encode logic)
- **Proposed:** Update quality-to-distance formula to match libjxl reference.
- **Deferred reason:** Proposed formula diverges from existing calibrated behavior. Changing shifts encoded file sizes + visual quality for all callers without controlled A/B comparison.
- **Verify:** (1) Locate distanceFromQuality in codebase. (2) Benchmark end-to-end: encode JXL at various efforts with old vs new formula. (3) Measure filesize + SSIM parity.
- **Acceptance:** User confirms behavior change acceptable, benchmarks show SSIM parity or improvement.

---

## Legend

- **☐** = Incomplete (not yet measured/implemented)
- **Deferred reason** = Why timing/benchmark evidence is needed
- **Verify** = Specific benchmarking steps
- **Acceptance** = Criteria to unlock implementation

## See Also

- `docs/rejected optimizations.md` — Complete rejection rationale + technical deep-dives
- `CLAUDE.md` — "Adaptive/heuristic changes require benchmark data. Do not add tunables without evidence."
- `docs/superpowers/plans/2026-06-16-tone-simd-lut-gather-jsWasm.md` — Related ToneSimd LUT plan with benchmark hooks
