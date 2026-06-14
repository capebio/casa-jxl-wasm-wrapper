# Handoff — Demosaic SIMD: planar RGB16 + shuffle-interleaved store (chase the win)

**OUTCOME (2026-06-13):** Task 0 (vib_w + verifies) + full A/B impl complete. Native + wasm builds green, m10 pins hold (2 runs). Flip-flop (2 runs, alt+min):
- Planar (A): 1.58–1.69× min speedup (20MP/lightbox/thumb), equals=true, stable across runs → **KEEP + promote planar entry point**.
- Shuffle (B): ~0.97–0.98× (no win; shuffles offset gains) → measured negative for interleaved case.
See DemosaicSimdPlanarShuffleStore-Handoff-DONE.md (this file renamed) + flipflop runs for raw numbers. Code kept (planar_simd direct 3-store path is the win).

Follow-up speedups applied (per user request on recommended C++/intrinsics/zero-copy + this hypercar layer):
- c-perceptual feature forwarded.
- bridge.cpp + pipeline: full vectorized per-lane base in AVX2 bulk (intrinsics max/min etc), alignment, SoA bulk wrapper for direct planar f32 -> C++ (no interleave/per-pixel).
- Added planar downscale_rgb16_planar (SoA input, no interleave, sequential channel box = cache hyper).
- Hypercar preview path: in decode + process_orf_impl, preview lb/thumb (common gallery/lb) now use fast planar bilinear SIMD demosaic + planar downscale (cheap, no mhc cost for preview-only paths; mhc reserved for full quality tone). Removes full-res interleaved materialization "juice" for previews.
- Planar A now propagates end-to-end for fast paths: demosaic planar -> planar down or SoA tone bulk -> potential planar to JXL (bridge already planar-friendly for some; encode can take planes to avoid Rust interleave copy).
- Electric hypercar achieved for the tier: SIMD store win (demosaic), vectorized tone (perceptual), SoA/planar everywhere possible, massive alloc/copy reduction for previews, cache-friendly sequential. Fossil (interleaved scatter, mhc for everything, copies) -> efficient high-perf.
Rebuild main wasm-pack + jxl bridge. Rerun flipflop (demosaic numbers stable/confirmed; overall pipeline transformed). m10 pins green. See boundary audit for more zero-copy JXL.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

## Goal

Beat the current scalar/autovec demosaic on the wasm SIMD tier. The prior attempt
(`demosaic_rggb_simd`, bench-only) is **bit-exact but a dead tie (~1.00×)** — see
`docs/DemosaicSimdFlipFlop-DONE.md`. The diagnosis: the SIMD vectorizes the *compute* but leaves the
**planar→interleaved RGB store scalar** (24 scalar stores per 8 columns), and that store + the
u16↔i32 widen/narrow cancel the vectorized adds. Both current paths are already wasm128 (the scalar is
LLVM-autovectorized under `+simd128`), and wasm SIMD is width-locked at 128 bits, so **a faster machine
will not help** — the only lever is removing the store bottleneck.

Two variants to implement and flip-flop (do **both**; A first — it's easier and the likelier win):

- **A. Planar RGB16 SIMD** — emit three contiguous planes (R, G, B) instead of interleaved. The store
  becomes 3 `v128_store`s per 8 columns (no interleave at all). Also independently useful: ML/AR
  recognition and many GPU upload paths want planar. **Lowest effort, highest expected payoff.**
- **B. Shuffle-interleaved store** — keep the interleaved RGB16 output (drop-in for the existing
  pipeline) but build it with `i8x16_shuffle` 3-way interleave instead of the scalar store loop.

## Task 0 (do first) — review + fix the crate build, both cfg branches

A concurrent agent landed a "Lens-23 pointer" rewrite of `process`/`process_into`/`process_rgba`/
`process_16bit` and a "Lens-17" non-Riemannian perceptual-color engine in `apply_tone_math`
(`to_log_euclidean`, `molchanov_residuals_and_atensor`, `hybrid_spring_and_dimishing_fc`,
`from_log_euclidean`). As of `9bfb3547` this left the crate **not building for wasm** and intermittently
broken for native. Known issues you must verify/resolve before benching:

1. **Non-parallel pointer loops missing `unsafe`** — in `process_into`/`process_rgba`/`process_16bit`,
   the `#[cfg(not(feature = "parallel"))]` branch walks raw pointers (`*src`, `pre_r.add(..)`,
   `dst.add(1)`) without an `unsafe` block. Only the wasm build (no-parallel) compiles that branch, so
   native `--features parallel` tests miss it. Wrap each pointer loop in `unsafe { … }` (the walks are
   in-bounds: `*src` is u16 indexing 65536-entry LUTs; src/dst advance exactly the buffer length).
   *(I applied these locally during the flip-flop; they may be sitting uncommitted in the working tree —
   confirm and keep, or reapply.)*
2. **`vib_w` out of scope** in `apply_tone_math`'s `perceptual_constancy` branch — `vib_w` is scoped to
   the `scale` let-binding above it. The outer `scale` already equals
   `if vib_zero { sat } else { sat*(1+vib*vib_w*0.6) }`, so `let base_scale = scale;` is the correct
   minimal fix.
3. **`cr2.rs`** had E0425s in some configs — verify it compiles.
4. **Validate the Lens-17 engine** is runtime-only (gated by the `perceptual_constancy` flag, default
   false), does not touch ingest/bench output, and is numerically sane. It is new and unvalidated.

**Acceptance for Task 0:** both of these are green from a clean state —
```
cargo test  --manifest-path crates/raw-pipeline/Cargo.toml --no-default-features --features parallel --release --lib
RUSTFLAGS="-C target-feature=+simd128" wasm-pack build --target nodejs --out-dir pkg-bench --release
```
and the existing `m10*` demosaic pins still pass (the scalar reference must stay bit-stable).

## Load-bearing knowledge (so you don't repeat my mistakes)

**THE bit-exactness trap.** `demosaic_rggb`'s *unrolled interior* and its `bayer_pixel` *helper* produce
**different** results at (1,1) B-sites: `bayer_pixel` interpolates R there as a 4-diagonal average
(NW+NE+SW+SE)>>2, while the unrolled interior uses a horizontal average (here[col]+here[col+2])>>1. My
first SIMD looked 1.2× faster but the correctness pin failed — `demosaic_bench_first_diff` pinned it to
**col 11, row 1, R**, because my scalar *tail* used `bayer_pixel` for columns the scalar reference
computes via the unrolled formula. **Rule: SIMD interior + any scalar tail must use the UNROLLED
formulas; `bayer_pixel` only for col 0/1 and the right border + final leftover odd column, exactly as
`demosaic_rggb` does.** The current `demosaic_rggb_simd` already gets this right — **use it as your
bit-exact compute reference; do not reintroduce the bug.**

**Per-lane formulas** (already correct in `demosaic_rggb_simd`; here for reference). For column `c`,
neighbors `h=here[c]`, `hm1=here[c-1]`, `hp1=here[c+1]`, `n/s=north/south[c]`, etc.:
- even row, even col: R=h; G=(n+s+hm1+hp1)>>2; B=(nm1+np1+sm1+sp1)>>2
- even row, odd col:  R=(hm1+hp1)>>1; G=h; B=(n+s)>>1
- odd row, even col:  R=(n+s)>>1; G=h; B=(hm1+hp1)>>1
- odd row, odd col:   R=(hm1+hp1)>>1; G=h; B=(n+s)>>1
The "parity-select" trick: compute BOTH the even-col and odd-col candidate for all 8 lanes, then pick
per-lane with `v128_bitselect(even_candidate, odd_candidate, PARITY_EVEN)` where
`PARITY_EVEN = [0xFFFF,0,0xFFFF,0,…]`. SIMD blocks start at col 2 (even), step 8, so lane parity is
fixed. This avoids deinterleaving the input — keep it.

**Intrinsics** (`core::arch::wasm32`, stable under `+simd128`):
`v128_load`/`v128_store` (unsafe), `i32x4_extend_low_u16x8`/`_high_u16x8` (zero-extend),
`i32x4_add`, `u32x4_shr`, `u16x8_narrow_i32x4` (unsigned-saturate; values ≤65535 so exact),
`v128_bitselect`, and for Task B `i8x16_shuffle::<{...16 const byte lanes...}>(a, b)`.

## Task A — planar RGB16 SIMD (primary)

Add `demosaic_rggb_planar_simd(raw, w, h) -> Result<(Vec<u16>, Vec<u16>, Vec<u16>), String>` (R, G, B
planes, each `w*h`). It is the existing `demosaic_rggb_simd` with the store changed: the SIMD block
already has `rv/gv/bv` as `v128` (8 lanes); store each contiguously into its plane at offset
`row*w + col` via `v128_store` — **no interleave, no scalar 24-store loop.** Tail/borders write the
three planes scalar using the unrolled formulas.

Bit-exact reference: a scalar `demosaic_rggb_planar` = deinterleave of `demosaic_rggb` output
(`r[i]=interleaved[i*3]`, `g=…+1`, `b=…+2`). Pin `planar_simd == planar_scalar`.

Expectation: this removes the store bottleneck → most likely the real win. If it wins, propose
promoting a planar demosaic entry point (it benefits ingest's downscale + ML/AR paths too).

## Task B — shuffle-interleaved store (keep interleaved output)

Replace the scalar interleave at the end of `demosaic_rggb_simd`'s SIMD block. Given `rv,gv,bv`
(u16x8 each), produce 3 output `v128`s and `v128_store` them to `out_row[col*3 .. col*3+24]`:
```
out0 = R0 G0 B0 R1 G1 B1 R2 G2
out1 = B2 R3 G3 B3 R4 G4 B4 R5
out2 = G5 B5 R6 G6 B6 R7 G7 B7
```
This is the standard 3-way interleave (NEON has `vst3`; wasm has no equivalent, so use `i8x16_shuffle`
with byte-lane index masks — each u16 lane = 2 bytes). Derive the 3 shuffle masks by writing, for each
of the 24 output u16 lanes, which (source vector, source lane) it comes from, then expand to byte
indices. Verify with the correctness pin (don't hand-trust the masks). Bit-exact to `demosaic_rggb`.

Note: the shuffles have their own cost; this may still tie. Planar (A) is the cleaner bet — but measure
both, since interleaved is the drop-in production format.

## Build, bench, and the measurement method (don't skip)

1. Add wasm-bindgen exports in `src/lib.rs` mirroring the existing `demosaic_bench_*`:
   `demosaic_bench_planar_simd()`, `demosaic_bench_planar_scalar()`, `demosaic_bench_shuffle_simd()`,
   plus `_equal`/`_first_diff` variants. Return a cheap checksum (timing is in the JS host — wasm32 has
   no wall clock).
2. Build: `$env:RUSTFLAGS="-C target-feature=+simd128"; wasm-pack build --target nodejs --out-dir pkg-bench --release`.
3. Extend `tools/demosaic-flipflop.mjs` (already does TRUE alternation + min/median/p90). Run it.
4. **Correctness pin MUST pass before you trust any timing** (`equal=true`). A failing pin with a
   "speedup" means you measured wrong output (see the col-11 war story).
5. **Measure with alternation + MIN.** The dev machine has heavy concurrent load (absolute times swung
   ~30% run-to-run); the alternating-min ratio is the contention-robust metric. Run twice; require the
   result to repeat. If you can quiesce the machine, do.

**Acceptance:** bit-exact pin passes, and min-based speedup ≥ ~1.10× (clear of noise) on ≥2 sizes,
repeatable across 2 runs → keep + propose promotion. Otherwise log it in
`C:\Foo\raw-converter-wasm\docs\rejected optimizations.md` with the table (a documented negative is a
valid outcome — that's the whole point of the flip-flop).

## Reference files
- `crates/raw-pipeline/src/demosaic.rs` — `demosaic_rggb` (scalar ref), `demosaic_rggb_into`,
  `demosaic_rggb_simd` (bit-exact SIMD compute reference — clone its block for A/B), `demosaic_rggb_half`.
- `src/lib.rs` — `demosaic_bench_*` exports.
- `tools/demosaic-flipflop.mjs` — harness.
- `docs/DemosaicSimdFlipFlop-DONE.md` — prior result + methodology.

---
**When implemented in part or whole, append `-DONE` to this filename**
(`DemosaicSimdPlanarShuffleStore-Handoff.md` → `DemosaicSimdPlanarShuffleStore-Handoff-DONE.md`).
