# tone_simd.rs — 22-Lens Review & Grok Handoffs

**File in scope:** `crates/raw-pipeline/src/tone_simd.rs` (only this file is edited; cross-file
reads of `pipeline.rs` are for context).

**What it is:** SoA bulk tone math — matrix × RGB + saturation/vibrance — vectorized across
pixels. `apply_tone_bulk` auto-dispatches AVX2+FMA (x86_64) or scalar. Scalar oracle =
`pipeline::apply_tone_math`. Parity asserted ≤0.05 abs OR <1e-3 rel.

## Key context (read before judging value)

1. **Native-only SIMD.** The vector kernel is `#[cfg(target_arch = "x86_64")]`. On
   `wasm32-unknown-unknown` — the *shipping artifact* — `apply_tone_bulk` falls to the per-pixel
   scalar oracle. The advertised "33× tone kernel" never reaches the browser. **This is the single
   largest gap (Lens 21).**
2. **Not yet promoted.** Production decode calls scalar `process_into`. The SIMD path
   (`process_into_simd`) is invoked only by `tiff::bench_tone_e2e_orf`. Work here is
   *measured-but-not-default*; promotion to the live path is a caller change (deferred, cross-file).
3. **Parity discipline is good.** Masked-inv branch already mirrors the scalar `raw_mx>0` guard.
   Tolerance is generous (post-LUT-index domain) → reassociation rewrites are safe.

---

## Consolidated findings (deduped, lens-tagged)

| # | Finding | Lenses | Severity |
|---|---------|--------|----------|
| F1 | **No WASM SIMD128 path** — shipping target runs scalar | 1,7,19,21,22 | **High** |
| F2 | Arithmetic in vib-active hot loop is loose: `vib*0.6`, `1+...`, `1-scale` recomputed per-iter; collapse to 1 FMA for `scale`, 1 FMA for blend (M3/M4/M5) | 18,19,20 | High |
| F3 | `vib_zero` branch lives *inside* the loop; split into specialized loops + add `sat==1.0 && vib_zero` identity fast-path (matrix only) | 13,19 | Med |
| F4 | Only AVX2 (8-wide). Add AVX-512 (16-wide) route for fleet | 1,11,19 | Med |
| F5 | `pub` fn does OOB UB in release if `g`/`b` shorter than `r` (only `debug_assert`). Clamp `n = min(lens)` | 4,8,9 | Med (safety) |
| F6 | Test gaps: no `n=0`, no pure-tail (`n<8`), masked-inv `raw_mx≤0` branch **never exercised**, no NaN test | 8,9,10 | Med |
| F7 | True `_mm256_div_ps` for `1/mx`; `_mm256_rcp_ps` (+opt NR) within tolerance | 18,19 | Low |
| F8 | No matrix-only / scene-linear bulk for ML/AR/astro consumers (linear data, no tone) | 11,12,14,16 | Feature |
| F9 | No SIMD perceptual-constancy bulk; Lens-17 engine has no vector path (per-pixel grid only) | 15,17 | Feature (research) |
| — | *(Cross-file, deferred)* caller re-zeros `[0f32;2048]` per block; deinterleave+LUT+clamp glue around the kernel now dominates and is un-SIMD'd; production still scalar | 3,6,21,22 | Note |

The three unilluminated rooms (Lens 21): **(a)** the WASM target itself; **(b)** the caller glue
(LUT gather 160 ms + f32 convert + clamp + per-block zeroing) that now bounds end-to-end; **(c)** the
perceptual-constancy path, explicitly excluded from bulk.

---

## Handoff A — Tighten the AVX2 vib hot loop (F2, F3, F7)

> If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**File:** `crates/raw-pipeline/src/tone_simd.rs`, fn `apply_tone_bulk_avx2`.
**Do this first** — Handoffs B and C mirror this tightened math.

Algebra (host-side constant folding):
```
vib6 = vib*0.6
scale = sat*(1 + vib6*(1-psat)) = sat*(1+vib6) - (sat*vib6)*psat
      = fmadd(-c2, psat, c1),  c1 = sat*(1+vib6),  c2 = sat*vib6
blend: x' = luma + (x-luma)*scale = fmadd(scale, x-luma, luma)   // == luma*(1-scale)+x*scale
```
`raw_mx≤0` ⇒ `psat=0` ⇒ `scale=c1=sat*(1+vib6)`, which equals the scalar oracle there
(`pixel_sat=0, vib_w=1`). Parity preserved.

Rewrite the kernel as **two specialized loops** (kills the per-iter `vib_zero` branch) with a third
identity fast-path:

```rust
let vsat = _mm256_set1_ps(sat);
let one  = _mm256_set1_ps(1.0);
let zero = _mm256_setzero_ps();
let lanes = n / 8 * 8;
let mut i = 0;

macro_rules! load_mat { () => {{
    let vr = _mm256_loadu_ps(r.as_ptr().add(i));
    let vg = _mm256_loadu_ps(g.as_ptr().add(i));
    let vb = _mm256_loadu_ps(b.as_ptr().add(i));
    let r2 = _mm256_fmadd_ps(m00, vr, _mm256_fmadd_ps(m01, vg, _mm256_mul_ps(m02, vb)));
    let g2 = _mm256_fmadd_ps(m10, vr, _mm256_fmadd_ps(m11, vg, _mm256_mul_ps(m12, vb)));
    let b2 = _mm256_fmadd_ps(m20, vr, _mm256_fmadd_ps(m21, vg, _mm256_mul_ps(m22, vb)));
    (r2, g2, b2)
}}; }
macro_rules! store { ($nr:expr,$ng:expr,$nb:expr) => {{
    _mm256_storeu_ps(r.as_mut_ptr().add(i), $nr);
    _mm256_storeu_ps(g.as_mut_ptr().add(i), $ng);
    _mm256_storeu_ps(b.as_mut_ptr().add(i), $nb);
}}; }

if vib_zero && sat == 1.0 {
    // saturation identity ⇒ matrix only (the no-adjust common case)
    while i < lanes { let (r2,g2,b2) = load_mat!(); store!(r2,g2,b2); i += 8; }
} else if vib_zero {
    while i < lanes {
        let (r2,g2,b2) = load_mat!();
        let luma = _mm256_fmadd_ps(lr, r2, _mm256_fmadd_ps(lg, g2, _mm256_mul_ps(lb, b2)));
        let nr = _mm256_fmadd_ps(vsat, _mm256_sub_ps(r2, luma), luma);
        let ng = _mm256_fmadd_ps(vsat, _mm256_sub_ps(g2, luma), luma);
        let nb = _mm256_fmadd_ps(vsat, _mm256_sub_ps(b2, luma), luma);
        store!(nr,ng,nb); i += 8;
    }
} else {
    let vib6 = vib * 0.6;
    let c1     = _mm256_set1_ps(sat * (1.0 + vib6));
    let neg_c2 = _mm256_set1_ps(-(sat * vib6));
    while i < lanes {
        let (r2,g2,b2) = load_mat!();
        let luma = _mm256_fmadd_ps(lr, r2, _mm256_fmadd_ps(lg, g2, _mm256_mul_ps(lb, b2)));
        let raw_mx = _mm256_max_ps(_mm256_max_ps(r2, g2), b2);
        let mx = _mm256_max_ps(raw_mx, one);
        let mn = _mm256_max_ps(_mm256_min_ps(_mm256_min_ps(r2, g2), b2), zero);
        let inv = _mm256_div_ps(one, mx);                          // F7: optional rcp+NR below
        let inv = _mm256_and_ps(inv, _mm256_cmp_ps::<_CMP_GT_OQ>(raw_mx, zero));
        let psat = _mm256_min_ps(_mm256_max_ps(_mm256_mul_ps(_mm256_sub_ps(mx, mn), inv), zero), one);
        let scale = _mm256_fmadd_ps(neg_c2, psat, c1);
        let nr = _mm256_fmadd_ps(scale, _mm256_sub_ps(r2, luma), luma);
        let ng = _mm256_fmadd_ps(scale, _mm256_sub_ps(g2, luma), luma);
        let nb = _mm256_fmadd_ps(scale, _mm256_sub_ps(b2, luma), luma);
        store!(nr,ng,nb); i += 8;
    }
}
// scalar tail (unchanged)
while i < n { /* existing apply_tone_math tail */ }
```

**F7 (optional, low priority — 1 divide / 8 px).** Replace the divide with refined reciprocal:
```rust
let y0 = _mm256_rcp_ps(mx);                                   // ~2^-12 rel
let inv = _mm256_mul_ps(y0, _mm256_fnmadd_ps(mx, y0, _mm256_set1_ps(2.0))); // 1 NR step → ~2^-24
```
Raw `rcp` (no NR) is already within the 1e-3 tolerance since `psat` is clamped; keep the NR step if
parity tests tighten. Benchmark both — divide may already be off the critical path.

**Verify:** `cd crates/raw-pipeline && cargo test --no-default-features --lib tone_simd` (the 3 parity
tests must pass). Bench: `cargo run --release --example tone_simd_bench`.

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

---

## Handoff B — AVX-512 route (F4)

> If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**File:** `crates/raw-pipeline/src/tone_simd.rs`. Depends on Handoff A's tightened math.

Add a 16-wide `apply_tone_bulk_avx512` mirroring the AVX2 kernel, and a dispatch branch in
`apply_tone_bulk` (probe **before** AVX2):
```rust
#[cfg(target_arch = "x86_64")]
{
    if std::is_x86_feature_detected!("avx512f") {
        unsafe { apply_tone_bulk_avx512(r, g, b, m, sat, vib, vib_zero, n) }; return;
    }
    if std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma") {
        unsafe { apply_tone_bulk_avx2(r, g, b, m, sat, vib, vib_zero, n) }; return;
    }
}
```
Gate the fn `#[target_feature(enable = "avx512f")]`. The masked-inv becomes cleaner with mask
registers:
```rust
let gt  = _mm512_cmp_ps_mask::<_CMP_GT_OQ>(raw_mx, zero);   // __mmask16
let inv = _mm512_maskz_div_ps(gt, one, mx);                 // zero where mask false (== AVX2 and)
```
`lanes = n / 16 * 16`; reuse the AVX2 scalar tail. AVX-512 requires nightly intrinsics or
`stdarch` stabilization — if the toolchain rejects `_mm512_*` on stable, document that in the
rejection log and stop (don't force nightly).

**Verify:** same parity tests (they run on whichever route the CPU selects; on an AVX-512 box this
exercises the new path).

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

---

## Handoff C — WASM SIMD128 route (F1 — highest end-user value)

> If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**File:** `crates/raw-pipeline/src/tone_simd.rs`. Depends on Handoff A's math.

The browser is the product; today it runs the per-pixel scalar oracle. Add a 4-wide
`core::arch::wasm32` kernel and dispatch:
```rust
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
{ unsafe { apply_tone_bulk_simd128(r, g, b, m, sat, vib, vib_zero, n) }; return; }
```
Kernel using `v128` / `f32x4_*` (4 px/iter, `lanes = n/4*4`), same three-way specialization as A:
```rust
use core::arch::wasm32::*;
let m00 = f32x4_splat(m[0][0]); /* …9 matrix + 3 luma + vsat splats… */
// matrix:  r2 = f32x4_add(f32x4_mul(m00,vr), f32x4_add(f32x4_mul(m01,vg), f32x4_mul(m02,vb)))
//          (use f32x4_relaxed_madd when target_feature="relaxed-simd")
// luma  :  same shape
// vib-active:
let raw_mx = f32x4_max(f32x4_max(r2,g2), b2);
let mx = f32x4_max(raw_mx, one);
let mn = f32x4_max(f32x4_min(f32x4_min(r2,g2),b2), zero);
let inv = v128_and(f32x4_div(one, mx), f32x4_gt(raw_mx, zero));   // gt → all-ones mask lanes
let psat = f32x4_min(f32x4_max(f32x4_mul(f32x4_sub(mx,mn), inv), zero), one);
let scale = f32x4_add(c1, f32x4_mul(neg_c2, psat));               // or relaxed_madd
let nr = f32x4_add(luma, f32x4_mul(scale, f32x4_sub(r2, luma)));
// store: v128_store(r.as_mut_ptr().add(i) as *mut v128, nr)
```
Notes: SIMD128 needs `-C target-feature=+simd128` at build (already required for the rayon WASM
build per CLAUDE.md). If the crate is also compiled for `wasm32` *without* simd128, the existing
scalar fallback still covers it — keep it. Use unaligned `v128_load`/`v128_store`.

**Verify:** parity tests run natively; additionally add a `#[cfg(target_arch="wasm32")]`-guarded
build check (`cargo build --target wasm32-unknown-unknown --no-default-features
-C target-feature=+simd128` via RUSTFLAGS) to confirm it compiles. Note in your summary that
end-to-end WASM timing needs the browser harness (out of this file's scope).

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

---

## Handoff D — Safety guard + test coverage (F5, F6)

> If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**File:** `crates/raw-pipeline/src/tone_simd.rs`.

**F5 safety.** `apply_tone_bulk` is `pub`; a release-build caller passing a short `g`/`b` triggers
OOB `loadu` (UB). Clamp the working length:
```rust
let n = r.len().min(g.len()).min(b.len());
debug_assert_eq!(g.len(), r.len());
debug_assert_eq!(b.len(), r.len());
```
Apply the same `min` in `apply_tone_bulk_ref`.

**F6 tests.** Add to the `tests` module:
- `parity_empty` — `n=0` (no panic, no-op).
- `parity_pure_tail` — `n=3` and `n=7` (no vector body; only the scalar tail runs).
- `parity_negative_matrix` — exercises the **untested** masked-inv `raw_mx ≤ 0` branch. The current
  `M` keeps post-matrix values positive, so that branch has never run:
  ```rust
  #[test] fn parity_negative_matrix() {
      const NEG: [[f32;3];3] = [[-1.0,-1.0,-1.0],[-1.0,-1.0,-1.0],[-1.0,-1.0,-1.0]];
      // positive inputs → all-negative post-matrix → raw_mx<0 → masked inv path
      let n = 64usize; let (r0,g0,b0) = data(n);
      let (mut sr,mut sg,mut sb)=(r0.clone(),g0.clone(),b0.clone());
      for i in 0..n { let (a,b,c)=apply_tone_math(sr[i],sg[i],sb[i],&NEG,1.3,0.5,false,false);
                      sr[i]=a; sg[i]=b; sb[i]=c; }
      let (mut ar,mut ag,mut ab)=(r0,g0,b0);
      apply_tone_bulk(&mut ar,&mut ag,&mut ab,&NEG,1.3,0.5,false);
      for i in 0..n { /* same ok() tolerance asserts */ }
  }
  ```
- Optionally `parity_nan` — assert NaN inputs propagate identically (scalar vs bulk both NaN).

**Verify:** `cd crates/raw-pipeline && cargo test --no-default-features --lib tone_simd` — all new
tests pass on the SIMD path (run on an AVX2 host) and the scalar path.

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

---

## Handoff E — Scene-linear / matrix-only bulk for ML·AR·astro (F8)

> If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**File:** `crates/raw-pipeline/src/tone_simd.rs`.

Recognition models, AR identification, and astrophotography stacking want **scene-linear** RGB —
the camera matrix applied, *no* tone/sat/vibrance (Lens 11/12/14/16). Today the only way to get it is
`sat==1, vib_zero` plus a LUT round-trip. Expose a dedicated, LUT-free, SIMD matrix-only bulk:
```rust
/// Matrix-only SoA transform (no sat/vibrance, no LUT). Scene-linear output for
/// ML/AR/photogrammetry/astro consumers that need un-toned, illumination-linear RGB.
/// Same dispatch shape as `apply_tone_bulk`.
pub fn apply_matrix_bulk(r: &mut [f32], g: &mut [f32], b: &mut [f32], m: &[[f32;3];3]) { … }
```
Internally this is the `load_mat!` body from Handoff A with an immediate store — reuse the same
AVX2 / AVX-512 / SIMD128 / scalar dispatch. Add one parity test vs a hand-rolled scalar matrix.

This is a pure addition (no behavior change to existing callers). Wiring it into a no-LUT decode
output is a **caller change in `pipeline.rs`** — out of scope; list it as a requested follow-up at
the end, do not edit `pipeline.rs` here.

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

---

## Handoff F — SIMD perceptual-constancy bulk (F9, Lens 17 — research)

> If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**File:** `crates/raw-pipeline/src/tone_simd.rs` (new fn). Reads `PerceptualGrid` from `pipeline.rs`.

`apply_tone_bulk` is classic-only; the non-Riemannian log-Euclidean engine (Lens 17) runs only as a
per-pixel `PerceptualGrid` trilinear sample inside `apply_tone_math(pc=true)`. Provide a vectorized
bulk that SIMD-gathers the grid:
```rust
/// SoA perceptual-constancy tone via vectorized trilinear sampling of PerceptualGrid
/// (coarse N^3 lattice). Targets sub-ms constancy for AR/LLM progressive paints.
pub fn apply_perceptual_bulk(r,g,b, grid: &PerceptualGrid) { … }
```
Design notes:
- Compute lattice cell index + fractional weights per lane (8 lanes AVX2).
- Use `_mm256_i32gather_ps` to fetch the 8 cube corners per channel; trilinear-blend with FMAs.
- Bit-exactness to the scalar grid is not required — assert against the **grid sampler**, not the
  full analytic engine, within a documented tolerance.
- Heavily cross-file (grid layout, `to_log_euclidean`, residual/spring terms live in `pipeline.rs`).
  **Read** them; if you need to expose `PerceptualGrid` fields or a corner-fetch accessor, request
  the `pipeline.rs` edit at the end — do not edit it inline.
- **Speculative / benchmark-gated:** gather throughput may not beat the current arithmetic. Land it
  behind the existing `c-perceptual`/grid feature path and only promote with bench evidence. If a
  bench shows no win, record the rejection.

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

---

## What implementing all of this achieves

The tone kernel today is a clean, parity-disciplined island of speed that, ironically, never reaches
the boats it was built for: the production browser path still runs the scalar oracle, and even the
benchmarked SIMD path is x86-only. The decisive move (Handoff C) carries the vectorized tone math to
`wasm32` via SIMD128, turning a native-only "33× kernel" headline into a real per-frame win in the
lightbox and progressive JXL paints — the place users actually feel it. Handoff B extends the same
math to AVX-512 for the server/ingest fleet, so the offline pyramid-build and benchmark machines get
double-width throughput where it compounds across millions of pixels.

Handoff A is the quiet multiplier underneath both: by constant-folding the vibrance algebra into one
FMA for `scale` and one FMA for the blend, splitting the loop-invariant `vib_zero` branch out of the
hot loop, and short-circuiting the saturation-identity case to a bare matrix transform, every route
(scalar, AVX2, AVX-512, WASM) inherits a tighter inner loop — fewer ops, shorter dependency chains,
better instruction-level parallelism — with no change to results inside the existing tolerance.

Handoffs D and E harden and broaden the surface. D closes a genuine release-mode UB hole on a public
function and lights up the masked-inverse branch that no current test touches, so the parity oracle
finally covers the negative-matrix and pure-tail corners. E exposes a scene-linear, LUT-free matrix
bulk — the un-toned, illumination-linear pixels that recognition models, real-time AR plant ID, and
faint-signal astro stacking actually want — converting an accidental capability into a first-class
API for the platform's machine-vision ambitions.

Handoff F is the long bet: a vectorized trilinear sampler for the non-Riemannian perceptual-constancy
grid, which is the only route to sub-millisecond illumination-invariant adjustment on progressive
arrivals — the precondition for the AR/LLM constancy vision. Together the set converts a benchmark
curiosity into the pipeline's default, fastest tone stage across every target, while opening clean
seams for the colour-science and computer-vision work that follows. The honest caveat threaded through
all of it: the kernel is now fast enough that the un-SIMD'd caller glue (LUT gather, deinterleave,
per-block buffer zeroing) and the still-scalar production wiring are the next real bottlenecks — worth
a follow-up review of `process_into_simd` once these land.
