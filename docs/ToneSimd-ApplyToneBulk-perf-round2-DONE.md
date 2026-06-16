# tone_simd.rs — Round 2: C++/Rust Performance Lens

**File in scope:** `crates/raw-pipeline/src/tone_simd.rs` (edits here only; `pipeline.rs` read for
context). Companion to `docs/ToneSimd-ApplyToneBulk-lens-review.md` (round 1). This pass adds only
**new** performance findings; it does not repeat round 1. Where a round-2 item refines a round-1
handoff, that is stated.

**Established facts (round 1):** SIMD is x86-only ⇒ shipping wasm runs scalar; `process_into_simd`
is benchmark-only (production = scalar `process_into`); parity tolerance is generous (≤0.05 abs OR
<1e-3 rel) so reassociation is safe; `sat`/`vib` are per-image host scalars (confirmed
`derive_tone_inputs`) ⇒ all `c1`/`c2`/`vib6` folding is free, computed once.

---

## New performance findings (deduped, not in round 1)

| # | Finding | Severity |
|---|---------|----------|
| G1 | **Portable-SIMD unification** (`wide`/`pulp` stable, or nightly `core::simd`): one kernel covers AVX-512+AVX2+NEON+wasm-simd128, collapsing round-1 Handoffs B & C into one impl and killing the wasm gap | High (structural) |
| G2 | **2× loop unroll / software-pipeline** the vector body — 3 channel FMA chains underfill 2 FMA ports (lat 4); 6 independent chains hide latency. Downclock-free alternative to AVX-512 | High |
| G3 | **Reciprocal-form `psat` + clamp elimination**: `psat = 1 − mn·inv` (one `fnmadd`), provably ∈[0,1] for `raw_mx>0` ⇒ drop both clamps; mask handles `raw_mx≤0`. Refines round-1 Handoff A | Med-High |
| G4 | **Branchless, autovectorizable scalar kernel + `const VIB_ZERO` monomorphization** — the realistic shipped wasm build (no `+simd128` flag) and non-AVX2 x86 currently run a data-dependent-branch scalar loop LLVM can't vectorize | High (covers baseline wasm) |
| G5 | **Cache resolved kernel in `OnceLock<fn-ptr>`**; + explicit guidance: do **not** rewrite classic tone in C++ (no codegen win, adds FFI cost); + AVX-512 downclock caveat | Low / guidance |
| G6 | *(Cross-file, deferred)* fuse deinterleave+pre-LUT+matrix into one pass; `MaybeUninit` SoA buffers (skip per-block zeroing); 32-B-aligned buffers ⇒ aligned load/store; SIMD post-LUT gather. Now the dominant remaining cost | Note (pipeline.rs) |

---

## Handoff P1 — Portable-SIMD unification (G1)

> If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**File:** `crates/raw-pipeline/src/tone_simd.rs`.

Round 1 proposes three hand-written backends (AVX2 done; AVX-512 = Handoff B; wasm-simd128 =
Handoff C). One portable kernel replaces all three and auto-covers the shipping wasm target plus ARM:

- **Stable option — `wide` crate** (`f32x8`): lightweight, no nightly, no runtime-detect needed
  for wasm/NEON; for x86 keep the existing `is_x86_feature_detected!` gate around an `f32x8` body
  compiled once. Minimal API surface (`max`, `min`, `mul_add`, `cmp_gt`, blend).
- **Stable option — `pulp`**: `pulp::Arch::new().dispatch(|simd| …)` JIT-selects avx512/avx2/neon/
  wasm-simd128 from one closure; richer but heavier dep.
- **Nightly option — `core::simd`** (`#![feature(portable_simd)]`, `Simd<f32, 8>`): zero deps,
  best codegen, but pins nightly.

Recommendation: `wide` for the smallest blast radius, or `core::simd` if the crate can take nightly.
Keep the scalar fallback. Sketch (`wide`):
```rust
use wide::f32x8;
let m00 = f32x8::splat(m[0][0]); /* … */
let c1 = f32x8::splat(sat*(1.0+vib6));
let neg_c2 = f32x8::splat(-(sat*vib6));
// matrix: r2 = m00.mul_add(vr, m01.mul_add(vg, m02*vb));   (etc.)
// psat (see P3 form): let inv = one/mx;
//   let psat = (one - mn*inv) & raw_mx.cmp_gt(zero);        // wide returns mask type
// scale = neg_c2.mul_add(psat, c1);
// blend: nr = scale.mul_add(r2 - luma, luma);
```
**Adding a dependency edits `Cargo.toml`** — request that at the end; do not edit it inline. If you
take this, mark round-1 Handoffs B and C as superseded (note it in the rejection log with the
reason "subsumed by portable-SIMD P1"). Bench native AVX2 to confirm `wide` matches the hand-rolled
intrinsics before deleting `apply_tone_bulk_avx2`; if `wide` regresses on x86, keep AVX2 and use the
portable path only for wasm/NEON.

**Verify:** `cd crates/raw-pipeline && cargo test --no-default-features --lib tone_simd`; build
`--target wasm32-unknown-unknown` to confirm the portable path compiles for the shipping target.

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

---

## Handoff P2 — 2× unroll / software pipelining (G2)

> If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**File:** `crates/raw-pipeline/src/tone_simd.rs`, vector kernel(s).

Per 8-px iteration there are only 3 independent FMA chains (r2/g2/b2). FMA latency ~4 cyc, 2 FMA
ports ⇒ the chains can't saturate the ports; throughput is latency-bound. Process **two vectors per
iteration** (`i` and `i+8`) with separate register sets so 6 chains overlap:
```rust
let lanes = n / 16 * 16;
while i < lanes {
    let (a_r,a_g,a_b) = load_block(i);
    let (b_r,b_g,b_b) = load_block(i+8);
    // interleave the matrix/luma/psat/blend for block A and block B …
    store_block(i,   …);
    store_block(i+8, …);
    i += 16;
}
// then the existing 8-wide loop for the [lanes, n/8*8) remainder, then scalar tail
```
This is a **downclock-free** throughput win and stacks under any backend (AVX2 or portable). On CPUs
where AVX-512 downclocks, 2×AVX2-unrolled often beats 16-wide — benchmark P2 vs round-1 Handoff B and
keep the winner per-arch. Watch register pressure: 16-wide × two blocks may spill on AVX2 (16 YMM);
if it spills, unroll only the matrix+blend and share the constant splats.

**Verify:** parity tests unchanged; `cargo run --release --example tone_simd_bench` before/after.

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

---

## Handoff P3 — Reciprocal-form psat, clamp elimination (G3)

> If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**File:** `crates/raw-pipeline/src/tone_simd.rs`. Refines/merges with round-1 Handoff A's vib path.

`pixel_sat = (mx − mn)/mx = 1 − mn/mx`. With `mn = max(min(...),0) ≥ 0` and `mx = max(raw_mx,1) ≥ 1`,
for `raw_mx>0` we have `mn ≤ raw_mx ≤ mx` ⇒ `mn·inv ∈ [0,1]` ⇒ `psat ∈ [0,1]` **without clamping**.
The only special case (`raw_mx ≤ 0`, scalar sets `pixel_sat=0`) is handled by masking psat to 0.
Replace the round-1 psat block with:
```rust
let inv  = _mm256_div_ps(one, mx);                                  // or rcp+NR (round-1 F7)
let psat = _mm256_and_ps(_mm256_fnmadd_ps(mn, inv, one),            // 1 − mn·inv
                         _mm256_cmp_ps::<_CMP_GT_OQ>(raw_mx, zero)); // 0 when raw_mx≤0
let scale = _mm256_fmadd_ps(neg_c2, psat, c1);
```
Net vs round-1 A: drops `sub(mx,mn)`, the separate `mul`, the `and(inv,gt)`, and **both** `max`/`min`
clamps — `fnmadd` fuses the multiply, mask folds the special case. ~3 fewer vector ops per iteration
in the vibrance-active loop. Mirror the same form in every backend (P1/P2). Algebraically identical
to the oracle; parity holds (verify the round-1 Handoff-D negative-matrix test, which finally
exercises this masked branch).

**Verify:** `cargo test --no-default-features --lib tone_simd`.

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

---

## Handoff P4 — Branchless autovectorizable scalar + const-generic (G4)

> If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**File:** `crates/raw-pipeline/src/tone_simd.rs`, `apply_tone_bulk_scalar` (the path used by the
shipped wasm build when `+simd128` isn't set, and by non-AVX2 x86).

Today the scalar path calls `apply_tone_math` per pixel, whose `if raw_mx > 0.0 { 1.0/mx } else
{ 0.0 }` data-dependent branch blocks LLVM autovectorization. Rewrite as a branchless SoA loop so
LLVM vectorizes it for SSE/NEON/wasm-simd128 automatically — free SIMD on targets without a hand
kernel:
```rust
#[inline]
fn apply_tone_bulk_scalar_branchless<const VIB_ZERO: bool>(
    r: &mut [f32], g: &mut [f32], b: &mut [f32],
    m: &[[f32;3];3], sat: f32, vib: f32, n: usize,
) {
    let vib6 = vib*0.6; let c1 = sat*(1.0+vib6); let c2 = sat*vib6;
    for i in 0..n {
        let (rr,gg,bb) = (r[i], g[i], b[i]);
        let r2 = m[0][0].mul_add(rr, m[0][1].mul_add(gg, m[0][2]*bb));
        let g2 = m[1][0].mul_add(rr, m[1][1].mul_add(gg, m[1][2]*bb));
        let b2 = m[2][0].mul_add(rr, m[2][1].mul_add(gg, m[2][2]*bb));
        let luma = LUMA_R.mul_add(r2, LUMA_G.mul_add(g2, LUMA_B*b2));
        let scale = if VIB_ZERO { sat } else {
            let raw_mx = r2.max(g2).max(b2);
            let mx = raw_mx.max(1.0);
            let mn = r2.min(g2).min(b2).max(0.0);
            let psat = (1.0 - mn/mx) * ((raw_mx > 0.0) as u32 as f32); // branchless mask
            c1 - c2*psat                                              // == sat*(1+vib6*(1-psat))
        };
        r[i] = scale.mul_add(r2 - luma, luma);
        g[i] = scale.mul_add(g2 - luma, luma);
        b[i] = scale.mul_add(b2 - luma, luma);
    }
}
```
Dispatch on `vib_zero` once to pick the monomorphized `true`/`false` instance (no per-iter branch).
The `(cond as u32 as f32)` multiply is the branchless equivalent of the masked inverse — keeps oracle
parity (`raw_mx≤0 ⇒ scale=c1=sat*(1+vib6)`). Confirm the loop autovectorizes
(`RUSTFLAGS="-C target-feature=+simd128" cargo build --target wasm32-unknown-unknown --release`,
inspect with `--emit=asm` or `wasm-objdump` for `f32x4` ops). This may make round-1 Handoff C
unnecessary if autovec is good enough — bench before committing to hand intrinsics.

**Verify:** `cargo test --no-default-features --lib tone_simd` (parity on both `VIB_ZERO` instances).

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

---

## Handoff P5 — Dispatch caching + C++/AVX-512 guidance (G5)

> If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**File:** `crates/raw-pipeline/src/tone_simd.rs`.

The caller invokes `apply_tone_bulk` per 2048-px block, re-running `is_x86_feature_detected!` (cached
atomic + branch) every block. Resolve the kernel once:
```rust
use std::sync::OnceLock;
type Kernel = unsafe fn(&mut [f32], &mut [f32], &mut [f32], &[[f32;3];3], f32, f32, bool, usize);
static KERNEL: OnceLock<Kernel> = OnceLock::new();
fn kernel() -> Kernel { *KERNEL.get_or_init(|| {
    #[cfg(target_arch="x86_64")]
    { if std::is_x86_feature_detected!("avx512f") { return apply_tone_bulk_avx512; }
      if std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma") { return apply_tone_bulk_avx2; } }
    apply_tone_bulk_scalar_dyn
}) }
```
(micro-optimization; skip if P1's portable path lands, which dispatches internally.)

**Two explicit rejections to record if proposed elsewhere:**
- **"Rewrite classic tone in C++ for speed"** — no codegen advantage. Rust `#[target_feature]`
  emits the same AVX2/AVX-512 as clang; moving the classic path to C++ only adds an FFI boundary
  (per-block crossing) and a second parity oracle to maintain. The existing C++ bridge is justified
  only for the `c-perceptual` engine, not classic tone.
- **AVX-512 downclock** — round-1 Handoff B's 16-wide path can *lose* on client CPUs that drop
  frequency under AVX-512. Treat B as benchmark-gated; prefer P2 (2×AVX2 unroll) where downclock is
  observed. Record the per-arch decision rather than unconditionally enabling avx512f.

**Verify:** parity tests + bench show no regression from the `OnceLock` indirection.

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

---

## Handoff P6 — Caller fusion & buffer layout (G6, deferred / cross-file)

> If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**Primary file in scope:** `crates/raw-pipeline/src/tone_simd.rs` — but the wins live in
`pipeline.rs::process_into_simd`. **Do not edit `pipeline.rs` inline**; document the change and
request approval at the end. With the kernel now compute-tight (round 1 + P1–P4), the surrounding
glue dominates:

1. **Per-block zeroing.** `let mut r = [0f32; BLK]` zeros 24 KB/block before fully overwriting
   `[..np]`. Use `MaybeUninit::<[f32;BLK]>::uninit()` and write `np` lanes (tail beyond `np` is never
   read). Removes a 24 KB memset per block × thousands of blocks.
2. **Fuse deinterleave + pre-LUT + matrix.** Currently: interleaved `u16` → pre-LUT gather → SoA f32
   → matrix (separate read/write of 24 KB). The pre-LUT gather and the matrix multiply can be fused
   so each pixel is read once and the matrix runs on the gathered values in registers, halving SoA
   traffic. (Tone is compute-bound, but the SoA round-trip is pure overhead.)
3. **Aligned buffers.** Wrap the SoA arrays in `#[repr(align(32))]` (or `align(64)` for AVX-512) so
   the kernel can use aligned `load`/`store` instead of `loadu`/`storeu`.
4. **SIMD post-LUT.** `post[(x.clamp(0,65535) as u16) as usize]` is a scalar gather to `u8`;
   consider `_mm256_i32gather_epi32` + pack, or batching, for the 160 ms LUT cost (round-1 measured).

To enable (2)/(3) from this file, you may add a fused entry point in `tone_simd.rs`
(e.g. `apply_tone_bulk_from_u16(rgb16, pre_luts, m, …, out_f32)`); the caller switch to it is the
`pipeline.rs` change requested at the end.

**Verify:** end-to-end parity + timing via `tiff::bench_tone_e2e_orf` (the existing scalar-vs-SIMD
harness) once the caller is wired.

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

---

## What round 2 achieves

Round 1 made the tone kernel reach every target and tightened its algebra; round 2 attacks the codegen
and structure beneath it. The pivotal item is P1: a single portable-SIMD kernel (stable `wide`/`pulp`
or nightly `core::simd`) that compiles to AVX-512, AVX2, NEON, and wasm-simd128 from one source —
folding round-1's separate AVX-512 and wasm handoffs into one maintained path and, crucially, giving
the shipping browser real vectorized tone without a bespoke intrinsic file. P4 backs that up for the
realistic baseline build: a branchless, const-generic scalar loop that LLVM autovectorizes on its
own, so even a wasm artifact compiled without `+simd128` stops paying the per-pixel branch, and
non-AVX2 x86 gets free SSE.

P2 and P3 compound on whichever backend wins. P2's 2× unroll fills the idle FMA ports that three
channel chains leave open — a frequency-safe throughput gain that, on downclock-prone client CPUs,
can beat a naïve AVX-512 switch (P5 makes that a measured, per-arch decision rather than a default).
P3 removes roughly three vector ops from every vibrance-active pixel by proving the saturation ratio
is already in range, eliminating two clamps and fusing the divide into a single `fnmadd` — pure
arithmetic the compiler won't discover on its own.

The honest centre of gravity, named in both rounds and concentrated in P6, is that the kernel is now
faster than the glue around it. Per-block 24 KB zeroing, the deinterleave→pre-LUT→SoA round-trip, the
unaligned loads, and the scalar post-LUT gather in `process_into_simd` are the next real bottleneck,
and the genuinely large win is fusing the pre-LUT gather with the matrix so each pixel is touched
once. P5's guidance closes the loop by ruling out a tempting dead end — rewriting the classic path in
C++ buys nothing over Rust's `target_feature`, only an FFI seam and a second oracle. Implemented
together, these turn a benchmark-only, x86-only curiosity into the pipeline's default tone stage:
one portable kernel, autovectorized fallback, frequency-aware width selection, and a clear, approved
path to fuse away the remaining overhead — and they keep the C++ bridge reserved for the one place it
earns its cost, the perceptual-constancy engine.
