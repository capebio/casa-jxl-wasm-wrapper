# Demosaic wasm128-SIMD Flip-Flop — Result (Lens 22)

**Verdict: REJECT.** An explicit `wasm128` SIMD bilinear RGGB demosaic, once made bit-identical to the
scalar path, is **not faster** than the existing scalar + LLVM-autovectorized code — slightly slower at
the common lightbox/thumbnail sizes. Kept as bench-only evidence so this is not re-derived.

## How it was measured (the "treatment")

- New `demosaic::demosaic_rggb_simd` (bench-only; **never wired into production decode**). Interior is
  explicit `core::arch::wasm32` SIMD using a parity-mask `v128_bitselect` (compute both CFA-phase
  candidates for all 8 lanes, select by a static even/odd mask — no deinterleave shuffles). Borders +
  tail reuse `demosaic_rggb`'s exact unrolled pair loop so the whole row is bit-identical.
- Built real wasm with `RUSTFLAGS="-C target-feature=+simd128"`, `wasm-pack build --target nodejs`
  into `pkg-bench/` (shipped `pkg/` untouched).
- Driven from Node (`tools/demosaic-flipflop.mjs`): timing in the JS host (wasm32 has no wall clock),
  correctness pin (`demosaic_bench_equal` = full Vec equality computed inside wasm), median of N,
  single-thread (matches the default single-thread production wasm).

## Results

### First attempt — caught a real bug
| context | equal | scalar ms | simd ms | speedup |
|---|---|--:|--:|--:|
| 20MP | **false** | 247.88 | 204.04 | 1.21× |
| lightbox | **false** | 22.90 | 20.07 | 1.14× |
| thumb | **false** | 2.93 | 2.63 | 1.11× |

The "1.1–1.2×" was an illusion: the SIMD was producing **wrong** output. `demosaic_bench_first_diff`
pinpointed col 11 row 1 (R) — my scalar *tail* used the `bayer_pixel` helper, whose (1,1)-site R is a
4-diagonal average, while `demosaic_rggb`'s unrolled interior uses a horizontal average. The two
disagree, so any column my SIMD pushed into the bayer_pixel tail mismatched.

### After fixing the tail to use the unrolled formula — bit-identical, and the win evaporates
| context | equal | scalar ms | simd ms | speedup | verdict |
|---|---|--:|--:|--:|---|
| 20MP | true | 154.80 | 149.57 | **1.03×** | reject (<3%) |
| lightbox | true | 16.17 | 16.52 | **0.98×** | reject (slower) |
| thumb | true | 2.03 | 2.16 | **0.94×** | reject (slower) |

## Why no win

The bottleneck isn't the neighbor arithmetic — LLVM already autovectorizes the scalar demosaic well.
The explicit SIMD pays for: u16→i32 widen + i32→u16 narrow per channel, and especially the
**planar→interleaved RGB store** (8 lanes scattered to `out[col*3 + 0/1/2]`), which the parity-select
approach defers to a scalar interleave. That store + the widen/narrow overhead cancel the vectorized
adds. At small sizes the SIMD setup is pure overhead → slightly slower.

This matches the prior lens prediction ("autovec is likely good; measure before committing SIMD") and
the repo's evidence-gated policy: **do not put unproven SIMD in the hot RAW path.**

## Artifacts (bench-only, reproducible)
- `crates/raw-pipeline/src/demosaic.rs` — `demosaic_rggb_simd` (cfg-gated; native delegates to scalar).
- `src/lib.rs` — `demosaic_bench_{prepare,scalar,simd,equal,first_diff}` wasm-bindgen exports.
- `tools/demosaic-flipflop.mjs` — Node A/B + correctness pin.
- Re-run: `$env:RUSTFLAGS="-C target-feature=+simd128"; wasm-pack build --target nodejs --out-dir pkg-bench --release; node tools/demosaic-flipflop.mjs`

## If revisited
A win would require eliminating the interleave cost — e.g. emitting **planar** RGB16 from a SIMD
demosaic (useful anyway for ML/AR consumers) and benching that against a scalar-planar reference, or a
shuffle-based interleave store. Until measured positive, the scalar/autovec path stays.
