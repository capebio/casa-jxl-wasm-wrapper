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

### After fixing the tail to use the unrolled formula — bit-identical, win evaporates
First (block-timed) pass: 20MP 1.03×, lightbox 0.98×, thumb 0.94×. **But those were contaminated by
a concurrent agent's CPU load** (scalar timed in one block, simd in another → a load spike on the simd
block biased it). See the corrected measurement below.

### Corrected: TRUE alternation (scalar,simd,scalar,simd…) + MIN (least-contended run)
Two back-to-back runs. Absolute times swing with background load (20MP: 128 ms vs 168 ms run-to-run),
but the **min-based ratio is rock-stable at ~1.00×** because alternation + min cancel time-varying load:

| context | equal | speedup (min), run1 / run2 | speedup (median) | verdict |
|---|---|--:|--:|---|
| 20MP | true | 0.996 / 1.003 | ~0.99 | **tie → reject** |
| lightbox | true | 1.003 / 1.001 | ~1.00 | **tie → reject** |
| thumb | true | 1.000 / 1.000 | ~1.00 | **tie → reject** |

So the SIMD is neither faster nor slower — a **dead tie** with the scalar path.

## Why a tie (and why a server won't change it)

- **Both paths are wasm128.** The build sets `+simd128` (the production "simd" tier), so LLVM
  auto-vectorizes the *scalar* demosaic too. This is autovec-128 vs hand-128 → tie expected.
- **wasm SIMD is fixed at 128 bits.** Engines (V8 etc.) do **not** auto-widen wasm128 to a server's
  AVX2/AVX-512. A faster server speeds up both paths equally; it cannot make 128-bit hand-SIMD beat
  128-bit autovec. (Confirmed indirectly here: absolute times varied ~30% run-to-run under load, ratio
  did not.)
- **The bottleneck is memory layout, not arithmetic.** Cost is dominated by u16↔i32 widen/narrow and the
  **planar→interleaved RGB store** (8 lanes scattered to `out[col*3 + 0/1/2]`), which the parity-select
  approach leaves scalar. That's a shuffle/store problem a wider server doesn't help.

Matches the prior lens prediction ("autovec is likely good; measure first") and the repo's policy:
**no unproven SIMD in the hot RAW path.**

## Artifacts (bench-only, reproducible)
- `crates/raw-pipeline/src/demosaic.rs` — `demosaic_rggb_simd` (cfg-gated; native delegates to scalar).
- `src/lib.rs` — `demosaic_bench_{prepare,scalar,simd,equal,first_diff}` wasm-bindgen exports.
- `tools/demosaic-flipflop.mjs` — Node A/B + correctness pin.
- Re-run: `$env:RUSTFLAGS="-C target-feature=+simd128"; wasm-pack build --target nodejs --out-dir pkg-bench --release; node tools/demosaic-flipflop.mjs`

## If revisited
A win would require eliminating the interleave cost — e.g. emitting **planar** RGB16 from a SIMD
demosaic (useful anyway for ML/AR consumers) and benching that against a scalar-planar reference, or a
shuffle-based interleave store. Until measured positive, the scalar/autovec path stays.
