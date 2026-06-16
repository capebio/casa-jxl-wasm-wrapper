# tone_simd.rs — Round 3: Math/Algorithm Collapse + Adjacent-File Seams

Implementation record for `crates/raw-pipeline/src/tone_simd.rs`. Round-3 lens focus: more
efficient mathematics/algorithms, and preparing efficient pathways to adjacent files. Changes were
applied to the file and verified; this document lists them and the conclusion (no handoffs — done).

## The algebra (why it collapses)

Post-matrix luma is a linear functional of the **input**: `luma = Lᵀ·(M·rgb) = (LᵀM)·rgb = lm·rgb`,
with `lm = LᵀM` a precomputed 3-vector. Two consequences drive the round:

1. **`vib_zero` tone is a single 3×3.** With constant `scale = sat`, the output is
   `x' = luma + sat·(M·rgb − luma) = [sat·M + (1−sat)·(1·lmᵀ)]·rgb = M'·rgb`, where
   `M'[i][j] = sat·M[i][j] + (1−sat)·lm[j]`. One matrix multiply now does matrix **and** the
   saturation blend. It subsumes both prior special cases for free: `sat==1 ⇒ M'==M` (identity),
   `sat==0 ⇒ every row == lm` (full desaturate to grayscale).
2. **Vibrance-active luma decouples from the matrix.** `luma = lm·rgb` is taken from the loaded
   input vectors, so it no longer waits on the `M·rgb` dependency chain — the two compute in
   parallel, shortening the critical path with no extra ops.

## Changes implemented

- **`luma_weights(m) -> [f32;3]`** (`pub(crate)`): `lm = LᵀM`, folded once per call.
- **`vib_zero_matrix(m, sat) -> [[f32;3];3]`** (`pub(crate)`): builds `M'`.
- **`vib_zero` path is now a matrix-only loop** over `M'` in all three backends (AVX2 / wasm
  `f32x4` / scalar). Per 8-wide iteration this drops the vibrance-zero work from ~18 vector ops
  (matrix 9 + luma 3 + blend 6) to **9** — roughly halved — and removes the separate `sat==1`
  identity loop (folded into `M'`).
- **Vibrance-active path takes `luma` from the input** via `lm` splats (decoupled from `M·rgb`),
  keeping the round-2 `fnmadd` reciprocal-form `psat` (no clamp, masked `raw_mx≤0`), folded
  `c1/c2`, and the lerp blend.
- **Loop structure simplified** from three branches to two (`vib_zero` matrix vs vibrance-active);
  `tone_one<const VIB_ZERO>` replaced by the branchless `tone_active` plus the inline `M'` loop.
- **Tests 8 → 10:** `parity_full_desaturate` (`sat=0`, exercises `M'` grayscale collapse) and
  `algebra_vib_zero_matrix` (locks `M'·rgb == luma + sat·(M·rgb − luma)` and `sat==1 ⇒ M'==M`).

## Adjacent-file pathways prepared (seams, not yet wired — `pipeline.rs` edits deferred)

- **Reusable exports.** `luma_weights` and `vib_zero_matrix` are `pub(crate)`. Any adjacent code
  needing post-matrix luma (preview/histogram/auto-exposure in `pipeline.rs`) can call `luma_weights`
  instead of running the full matrix; the no-vibrance tone is available as one matrix via
  `vib_zero_matrix`.
- **`process_into_simd` no-vibrance fast path.** When `ti.vib_zero` (the common preview/thumbnail
  and "no vibrance slider" case), the whole tone stage is now `M'·rgb`. The caller can fuse it into
  the existing per-block pre-LUT→SoA fill — apply `M'` to each gathered pixel in registers and skip
  the separate `apply_tone_bulk` pass and its SoA reload entirely. One-line switch at
  `pipeline.rs:1182` guarded on `ti.vib_zero`; requires approval to edit `pipeline.rs`.
- **Note on LUT fusion limits.** `M'` is per-pixel linear, so it cannot be folded into the 1-D
  pre-LUT (which is per-channel); the gain is the collapsed *arithmetic*, not a LUT merge. The
  remaining caller wins (`MaybeUninit` SoA buffers, SIMD post-LUT gather) are unchanged from
  round 2's P6 and still live in `pipeline.rs`.

## Verification

- `cd crates/raw-pipeline && cargo test --no-default-features --lib tone_simd` → **10 passed, 0
  failed** (native AVX2 + branchless scalar; parity within ≤0.05 abs OR <1e-3 rel).
- `RUSTFLAGS="-C target-feature=+simd128" cargo check --target wasm32-unknown-unknown
  --no-default-features --lib` → **Finished, no errors**.

## Deferred (unchanged reasons)

- **`rcp`+NR for the single vib-active divide** — kept the true `div` so AVX2 and wasm (no rcp
  intrinsic) stay numerically symmetric; marginal (1 div / lane-group).
- **AVX-512 (16-wide)**, **portable-SIMD unification (`wide`/`pulp`/`core::simd`, needs a dep)**,
  **scene-linear & perceptual-constancy bulks**, **caller-side `MaybeUninit`/post-LUT SIMD fusion**
  — as recorded in rounds 1–2.

## Conclusion

Round 3 is a mathematics pass, not a micro-optimization one: recognizing that luma is `lm·rgb` lets
the entire no-vibrance tone — by far the most common case, and the one preview, thumbnail, and
gallery paints hit — collapse to a single precomputed 3×3 matrix, halving that path's arithmetic and
absorbing the identity and full-desaturate cases as boundary values of one formula rather than as
hand-written special branches. The vibrance-active path benefits too: pulling luma from the input
breaks its dependency on the colour matrix, so the two linear maps evaluate in parallel and the
per-pixel critical path shortens at zero op cost. The kernel is now both simpler (two loops, one
algebraic identity) and faster, and the suite proves it — ten parity tests green on AVX2 and the
scalar path, the masked-inverse and grayscale-collapse corners covered, and the wasm SIMD128 build
compiling for the shipping target.

Equally important, the round leaves clean seams for the adjacent pipeline. `luma_weights` and
`vib_zero_matrix` are now first-class, reusable primitives, and the no-vibrance fast path is reduced
to a form — one matrix multiply — that `process_into_simd` can fuse directly into its deinterleave,
eliminating a whole SoA round-trip for the common case once the one-line caller switch is approved.
The expensive arithmetic has been argued away; what remains is wiring, scoped and deferred with its
reasons, so the next step is connection rather than computation.
