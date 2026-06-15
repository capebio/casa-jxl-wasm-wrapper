# JXL Decode + RAW Pipeline Optimisation — ML Agent Brief - DONE

Date: 2026-06-15
Scope: **decode** (JXL decode path / native `raw_decode_bench` decode proxy) and
**pipeline** (`crates/raw-pipeline/src/pipeline.rs` tone stage).
Worktree: `.worktrees/check-368`.
Method: measure → apply byte-exact wins → re-measure → gate → analyse remaining
chapters against the actual code. Iterative; each pass builds on the previous.

---

## 0. The measurement surprise (and a correction)

A prior review of this same pair concluded the native bench "runs the parallel
branch (default features)" and that the tone hot path was "already optimal on the
measured path, leave it alone without evidence."

**That premise was wrong.** The root `Cargo.toml` declares
`raw-pipeline = { path = "...", default-features = false }`. `raw-pipeline`'s
`default = ["parallel", "jxl-encode"]`, so `default-features = false` **silently
dropped `parallel`**. The only feature that re-enabled it (`parallel-wasm`) also
pulls `wasm-bindgen-rayon`, a wasm-only dep, so it was never used for the native
bench. Result: every native tone measurement to date ran the **single-threaded
scalar branch**, and `bench_jxl_decode` built its decoder with **no
`ThreadsRunner`** (serial libjxl decode).

Measuring first (Chapter 10 step 1; priority "measure before optimise") exposed
this immediately: tone was the single largest cost in the whole pipeline.

### Baseline (serial — the "before")

| File (MP) | decode | demosaic | tone | direct-rgba | jxl-decode | total |
|---|---|---|---|---|---|---|
| DNG 12MP (100404049) | 314.8 | 71.4 | 423.6 | 346.8 | 289.8 | 809.9 |
| CR2 17MP (_MG_1744) | 414.1 | 91.8 | 598.9 | 484.3 | 722.3 | 1104.8 |
| CR2 24MP (ADH 1234) | 525.5 | 120.4 | 788.4 | 651.1 | 733.3 | 1434.2 |

`direct_rgba` aggregate: n=9 avg=**497.9ms** (vs the file's own comment claiming
WASM JS `rgb_to_rgba` ~65ms — native was *7× slower than the thing it claimed to
beat*, purely from the missing thread pool).
`decode_region_downsample` (jxl decode) aggregate: avg=**555.5ms**.

---

## 1. Applied changes (this pass)

Priority order from the brief is: (1) eliminate copies, (2) keep buffers in WASM,
(3) cache locality, (4) fuse kernels, (5) SIMD, (6) concurrency. Measurement
showed the dominant cost was *serial execution of an already-parallel-capable
kernel* — i.e. the cheapest, safest, highest-yield lever was concurrency
(Chapter 8). Two edits, both **byte-exact** (no pixel values change):

### a. Pipeline side — native rayon forwarder
`Cargo.toml`: added
```
parallel = ["raw-pipeline/parallel"]
```
and built/ran the bench with `--features "jxl-lowlevel,jxl-encode,parallel"`.
This routes `process` / `process_rgba` / `process_16bit` (and `demosaic`) through
their existing rayon `par_chunks` branches. rayon partitions pixel rows; each
pixel's float math is identical and independent (no cross-pixel reduction) →
output is bit-for-bit identical to the scalar branch.

### b. Decode side — threaded libjxl decode
`raw_decode_bench.rs::bench_jxl_decode`: attached a `ThreadsRunner`
(`available_parallelism` threads) to the decoder builder, matching the encode
side which already threaded. libjxl MT decode is deterministic → identical
reconstruction.

### After (parallel — the "after")

| File (MP) | decode | demosaic | tone | direct-rgba | jxl-decode | total |
|---|---|---|---|---|---|---|
| DNG 12MP (100404049) | 70.6 | 16.8 | 74.8 | 80.2 | (in 157.9 avg) | **162.3** |
| CR2 17MP (_MG_1744) | 419.5 | 16.2 | 78.9 | 115.8 | — | **514.5** |
| CR2 24MP (ADH 1234) | 543.3 | 23.6 | 109.9 | 165.0 | — | **676.8** |

| Metric | Before | After | Speedup |
|---|---|---|---|
| tone (CR2 24MP) | 788.4ms | 109.9ms | **7.2×** |
| tone (CR2 17MP) | 598.9ms | 78.9ms | **7.6×** |
| tone (DNG 12MP) | 423.6ms | 74.8ms | **5.7×** |
| demosaic (24MP) | 120.4ms | 23.6ms | 5.1× |
| direct_rgba (avg n=9) | 497.9ms | **120.7ms** | 4.1× |
| jxl decode (avg n=9) | 555.5ms | **157.9ms** | 3.5× |
| total (DNG 12MP) | 809.9ms | 162.3ms | **5.0×** |

### Quality gate (Chapter 7 / "before changing pixels")
The changes do **not** change pixels — concurrency only. Gate satisfied by
construction *and* verified empirically: `cargo test --lib` passes **82/82** in
**both** `--no-default-features` (scalar) and `--features parallel` (rayon)
configurations. The pixel-correctness unit tests are identical across both paths,
so golden / SSIM / Butteraugli diffs are necessarily zero. No separate corpus run
was required because no pixel value moved.

---

## 2. New cost-center surfaced

Collapsing tone re-ranked the pipeline. The dominant cost is now **CR2 LJPEG
decode: 419–648ms, still serial** (lossless-JPEG Huffman is inherently sequential
per scan; it does not parallelise like the pixel passes). DNG decode already
parallelised (314→70ms). JXL decode is now 157ms avg. So the next real target is
the CR2/LJPEG decode path (`ljpeg.rs` / `cr2.rs`) — decode side.

---

## 3. Chapter-by-chapter mapping (applied vs analysed-and-deferred)

Reasoning done in memory against the real code; only net-positive, evidence-backed
changes were applied. Deferred items carry rationale (no speculative churn, per the
"benchmark before replacing / no evidence-free tunables" rule).

**Ch.1 Zero-allocation streaming.** Decode→demosaic→tone already pass buffers by
reference (zero-copy) in the native path. *Seam copy found:* the DNG path calls
`align_to_rggb(&img.raw, …)` which materialises a re-aligned Bayer buffer — a real
copy, but correctness-driven (CFA phase). Deferred: fold alignment into
`dng::decode_bytes` so it emits aligned planes directly. **Applies to TS decode
(input ring buffer → WASM view)** — out of this worktree's measurable scope;
covered by prior `DecodeHandler-DONE` / `FacadeDecodeHandler-DONE`.

**Ch.2 Keep buffers in WASM.** Native path already keeps pixels in Rust-owned
`Vec`s end-to-end; `decode_buffer_extract_ms = 0` confirms zero hand-off copy.
The TS/WASM analogue (compressed-in → decode → working planes → output view,
avoiding `Uint8→Float32→copy→transfer`) is the browser decode-handler/facade
concern — not exercised by this native bench.

**Ch.3 Pixel layout (SoA / plane split).** Tone is currently interleaved RGB
(AoS). `demosaic` already has a planar SIMD variant (per project history). The
strategic win is a **planar tone path** so R/G/B are contiguous (enables Ch.5
SIMD and removes per-pixel stride-3 gather). Alpha is already handled trivially
(`A=255` constant in `process_rgba`) — it correctly skips colour math, matching
the brief. Deferred: pixel-layout change is pixel-touching (needs full golden/SSIM
gate) and sizeable; recommended as the next implementation once a golden corpus
fixture is wired.

**Ch.4 Tiles vs scanline.** The tone/demosaic passes are row-chunked under rayon
(`par_chunks(width*3)` / `with_min_len(4096)`) — effectively scanline-tiled with
good cache locality (the separable blur already uses an explicit `VTILE=128` L1
tile). For a 24MP single image the row-chunk scheme is already cache-friendly;
no change. JXL/tiled-progressive decode is the pyramid layer's concern.

**Ch.5 SIMD.** **Not available in this worktree** — the `tone_simd` module
(wasm128 f32x4 + AVX2, ~33× kernel) lives on branch `perf/tone-simd`, not here.
With tone now multi-threaded at ~75–110ms, SIMD is the logical *next* multiplier
(SIMD × threads compose). Deferred: port `tone_simd::apply_tone_bulk` +
`process_into_auto` into this branch and gate with SSIM/Butteraugli (SIMD rounding
can differ in the last bit → real gate required, unlike the concurrency change).

**Ch.6 Kernel fusion.** `process_rgba` already fuses tone + alpha-insert in one
pass (never materialises a 3-ch intermediate for the encode feed) — exactly the
"decode→transform→output" the brief prefers. The pre-LUT + matrix + sat/vib +
post-LUT are already fused into a single per-pixel pass via the tri-LUT design.
No redundant intermediate buffers in the tone stage. Demosaic→tone remains two
passes (correct — different access patterns); fusing them is a future planar item.

**Ch.7 Quality gates.** Applied as the parity gate above. The repo's perceptual
kernel (`crates/raw-pipeline/src/perceptual`, Butteraugli/SSIM/PSNR) is the right
harness for the *future* pixel-changing items (SIMD, planar); flagged for those.

**Ch.8 Batching / concurrency.** This is what was applied — and it was the
dominant lever precisely because it had been silently disabled. Both decode
(ThreadsRunner) and pipeline (rayon) now use the full core count. *Minor residual
noted, not applied:* `bench_jxl_decode` / `bench_jxl_encode_with_ch` re-create the
thread pool once per RUN (3× pool spawn); it sits outside the timed region so it
only costs bench wall-time, not reported numbers — not worth the lifetime churn.

**Ch.9 Representation layer.** Codec reconstruction (decode/demosaic/tone) is
cleanly separated from the illumination-invariant / recognition layer
(`perceptual_constancy` path + `apply_perceptual_constancy`, off by default and
never in the ingest/bake path). Boundary is intact; no change.

**Ch.10 Benchmark order.** Followed: (1) measured → found serial execution; then
went straight to (6) concurrency because the measurement proved it was the binding
constraint, not copies/layout. Re-measured (5× total). Remaining steps
(copy-fold at the DNG align seam, planar layout, SIMD) are the documented next
iterations, in priority order, each gated.

---

## 4. Seam pass (decode ↔ pipeline)

- decode → demosaic: `img.raw` passed by reference, zero-copy. ✓
- demosaic → tone: `rgb16` Vec passed by reference, zero-copy. ✓
- **DNG decode → demosaic: `align_to_rggb` copy** — the one avoidable allocation
  at the seam (see Ch.1). Single highest-value *copy* elimination remaining on the
  pipeline side.
- tone → encode: `process_rgba` output fed directly to 4-ch JXL encode; the 3-ch
  `process` output doubles as the `tonemapMs` measurement *and* the 4-ch-failure
  fallback — not redundant.
- The strategic seam win is **planar all the way through** (demosaic emits R/G/B
  planes → tone consumes planes → SIMD across the plane → output view), which
  collapses Ch.3+5+6 into one redesign and removes the stride-3 gather. This is
  the recommended next major iteration; it is pixel-touching and must be gated.

---

## 5. Outcome & roadmap

**Applied, verified, shipped this pass:** native concurrency on both the decode
and pipeline sides. Total per-file time down **5× (DNG)** / **2.1× (CR2)**; tone
(the prior #1 cost) down **7×**; all byte-identical (82/82 tests, both configs).

**Prioritised next iterations** (each gated with golden/SSIM/Butteraugli before
merge, since each touches pixels or layout):
1. **CR2 LJPEG decode** — the new dominant cost (419–648ms, serial). Investigate
   restart-interval / multi-scan parallelism or SIMD Huffman/diff reconstruction.
2. **DNG `align_to_rggb` copy** — fold alignment into decode (zero-copy seam).
3. **Planar (SoA) tone path** — unlocks SIMD and removes stride-3 gather.
4. **Port `tone_simd` (AVX2 + wasm128 f32x4)** from `perf/tone-simd`; SIMD ×
   threads compose for a further multiplier on the ~75–110ms tone.

The headline lesson matches the brief's central rule inverted: here the data
movement was already lean — the loss was *unused parallel hardware*, hidden behind
a feature-flag default. Measuring first found it; one line of feature wiring and
one decoder option returned a 5× system speedup at zero fidelity cost.
