# Multi-Lens Review Protocol

## Scope & rules
- Work **only** on the files I name. Touch no other source file without asking first — the sole exceptions are the files specified below.
- Run examination in **plan mode**. Thinking is cheap; reading and writing are expensive — spend tokens only on reading the target files and writing the final report.
- Be thorough, meticulous, exhaustive. Think broadly, then deeply. Examine from multiple angles, integrate prior knowledge, and optimize for the long term.

Across every lens pass, hunt for gains in: **efficiency, speed, performance, correctness (bugs), and features** (existing or latent).

## Procedure
1. **Examine** file 1 through the lenses below; scrutinize the code *from memory* and formulate issues, improvements, and fixes.
2. **Apply** each fix only after judging it a net positive. Reject the rest which at the very end after step 8 below will be consolidated and appended to `docs/rejected optimizations.md` with the date-time, target filename(s), and rejection rationale .
3. **Repeat** steps 1–2 (second pass on file 1).
4. **Load** the single most important file that interfaces with file 1.
5. **Repeat** two lens/fix rounds on file 2.
6. **Seam pass:** run the lenses focused on the pipelines, seams, and interchanges *between* the files.
7. **Implement** the resulting fixes.
8. **Report** in one `docs/<combined-target-names>.md` (append a numeric suffix on filename collision), ending the title in `- DONE`.

## Report contents (step 8)
- **Intro:** purpose of the files 
- The **changes** made.
- **Conclusion (Chapter 3):**
  a. improvements to file(s) 1;
  b. improvements to file(s) 2;
  c. improvements to the seams/boundaries between them;
  d. a few closing paragraphs.
- **Headline Features:** append a news-style entry to `docs/Headline Features.md` — date-time, target files, and major findings written for a barely-computer-literate reader. No pleasantries, no filler, no non-issues.
- **Regression run:** execute `c:\Foo\raw-converter-wasm\StandardMultifileTest.mjs` and check for timing regressions.
- **Timings table** (placed immediately *before* the conclusion): this run vs. the previous ten, with exhaustive metrics and its own conclusion.
- **Flip-flop tests:** for any suspected slow/speed change worth isolating, alternate the same operation ten times — new code vs. old (or 2–3 candidate mechanisms) behind a switch. Write the test as `benchmark/<method-name>.mjs`, run it, and evaluate. Emit exhaustive timing output — **CPU and thermals per run** — to `docs/outputs/timing tests/<descriptive-name>-<date-time>.toon`, following `docs/ToonInstructions.md`.

---

## Lenses

### A. Structural sweep
1. **Strategic map** — each file, how they link, and the data they exchange.
2. **Public API surface** — exported functions, WASM bindings, worker message handlers.
3. **Pipeline stages** — decode → transform → resize → encode → cache → return.
4. **State machinery** — session, queue, cancellation, error.
5. **Data structures** — buffers, queues, manifests, tile descriptors, options.
6. **Hot kernels** — pixel/chunk/copy loops, colour transforms, resampling.
7. **Boundary points** — JS↔WASM, worker↔main thread, Rust↔C/C++, memory-copy sites.
8. **Support code** — validation, logging, progress, tests.

### B. Performance deep-dives
9. **SIMD & native intrinsics** — find tight, data-independent scalar loops over `u8`/`u16` buffers in the raw decode/encode hot path (the arithmetic behind `raw_ms`, `raw_demosaic_ms`, `raw_decompress_ms`) and vectorize 8–16 lanes; flag where to hand-code intrinsics or push JS work down into Rust/C++.
10. **Zero-copy & allocation elimination** — at every crossing, ask: *is data duplicated or re-materialized here?* Replace iterator overhead, repeated indexing, redundant casts, and fresh alloc+copy with view/pointer advancement and in-place mutation. (Canonical win: advance the pointer instead of re-reading memory — 300 ms → 0 ms.)
11. **Numerical/algorithmic** — reformulate the math for fewer operations, better precision, or cheaper valid approximations.

### C. Lateral reframing
12. **Owl** — patient, sees wide and near, hunts in the dark, swivels to look behind. Use every sense to sniff out improvements.
13. **Reverse the film** — old→young, back→front, upside-down; read the past with present knowledge.
14. **Astrophysicist** — Einstein-with-code. What astronomical analogies apply? If this code drove a phenomenal telescope imaging the stars, what would it need?
15. **Defocused birds-eye** — step back and feel the whole file graph; what stands out about its connectivity? Chase those threads.

### D. Mission-facing (Casabio)
16. **LLM / machine recognition** — make organism recognition faster, better, more accurate.
17. **Photogrammetry / digital twins** — facilitate digital representations of organisms.
18. **Augmented reality** — facilitate real-time plant recognition and identification.
19. **Butteraugli** — one of the slowest JXL operations; facilitate it within these layers if appropriate.
20. **Perceptual colour model** — a non-Riemannian model (Schrödinger geodesics, Molchanov anisotropy, HPCS, chromatic diminishing returns) mapping curved, hue-stable geodesics into flat Euclidean space via a sensor-sharpening matrix **B** and a component-wise log-transform, enabling illumination-invariant, perceptually uniform adjustment by linear algebra instead of differential geodesics. **If this pipeline surfaces in these files,** design a SIMD-accelerated / precomputed multi-dimensional LUT in Rust for sub-millisecond log, exp, and local-spline transforms; **otherwise ignore this lens.**

### E. Gap-finding
21. **Gaps, pass 1** — if each lens lights one room, name the three largest rooms still dark.
22. **Gaps, pass 2** — repeat from a different vantage.

### F. Added lenses (gap-targeted)
23. **Concurrency & shared-memory safety** — before enabling threading/SIMD, audit data races, atomics, `SharedArrayBuffer` aliasing, worker-pool sizing and saturation, and deadlock/teardown ordering.
24. **Output-fidelity gating** — for any optimization that touches pixels (colour transforms, resampling, demosaic), prove it doesn't regress output: gate on a golden-image / SSIM / butteraugli diff, not on timing alone.
25. **Memory lifetime & peak** — track WASM linear-memory growth, fragmentation, and peak working set on large rasters/tiles; bound it before it OOMs.
26. **Cross-boundary teardown** — on cancel or error, ensure in-flight WASM work unwinds cleanly with no leaked buffers, handles, or orphaned worker promises.
27. **Benchmark integrity** — verify per-stage timers/counters are accurate and low-overhead, and that measurements are reproducible (pin cores, control thermal throttling) so flip-flop results reflect signal, not noise.

## G. Final optimization

I want you to apply the following lenses in order during review. Do the following three times: (  Prioritize findings that improve efficiency, speed, correctness, and long-term feature enablement. Focus effort on a general sweep, then the three slowest algorithms first, then the next three, then the next three. Then focus on the interactions between algorithms within the file(s) for final optimizations.)

## A. Structural & Mapping Lenses

**1. Strategic Pipeline Map**  
Map the given files, how they connect, and exactly what data flows between them (buffers, objects, ownership). Identify hidden data duplication or unnecessary materialization.

**2. Public API & Binding Surface**  
List all exported functions, WASM/FFI bindings, worker message handlers, and call sites. Look for fine-grained calls that can be batched into coarser ones.

**3. Pipeline Stage Decomposition**  
Break the flow into decode → transform → resize/scale → encode → cache → return. Flag stages that re-read data or rebuild structures already computed upstream.

**4. State Machinery Audit**  
Examine session state, queues, cancellation, and error paths. Ensure clean unwinding and no leaked resources on early exit or error.

**5. Data Structure Inventory**  
Catalog all buffers, queues, manifests, tile descriptors, options objects, and level representations. Challenge object wrappers, repeated allocations, and non-contiguous layouts.

**6. Hot Kernel Identification**  
Locate every tight pixel/chunk/copy loop, colour transform, resampling, and aggregation loop. These are the primary targets for the three-iteration optimization pass.

**7. Boundary & Crossing Audit**  
Map every JS↔WASM, worker↔main, Rust↔C, or memory-copy boundary. Count crossings and measure marshalling cost. Prioritize zero-copy or single-call designs.

**8. Support & Validation Code**  
Review tests, logging, progress reporting, and validation. Ensure any optimization is gated by output fidelity (SSIM, perceptual diff, golden images) before timing claims.

---

## B. Performance Deep-Dive Lenses (Hacker + Mathematical)

**9. SIMD & Vectorization Readiness**  
Find scalar loops over u8/u16/f32 buffers. Assess readiness for 8–16 lane vectorization or portable SIMD. Flag where intrinsics or layout changes would unlock big wins.

**10. Zero-Copy & Allocation Elimination**  
At every step ask: “Is this data being duplicated, re-allocated, or re-materialized?” Replace with pointer advancement, views, in-place mutation, or arena/pool reuse. Classic win: streaming accumulation instead of separate passes.

**11. Numerical & Algorithmic Reformulation**  
Look for expensive math (pow, sqrt, divisions in hot loops). Replace with cheap polynomials, pre-scaled channels, precomputed inverse values, or lookup tables. Exploit mathematical identities and monotonicity.

**12. Three-Iteration Slowest-Algorithm Focus (Mandatory)**  
After initial lens passes, explicitly identify and optimize the current top 3 slowest algorithms, then the next 3, then the next 3. Do not optimize cold code.
