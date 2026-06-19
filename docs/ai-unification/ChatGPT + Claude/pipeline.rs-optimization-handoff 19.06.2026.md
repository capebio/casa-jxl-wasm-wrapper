# Pipeline.rs — Optimization Handoff

## Context
Rust colour-conditioning + tone pipeline for RAW → display/export.

Per-pixel hot path:
`u16 raw → pre-LUT gather ×3 → f32 → matrix → tone math → post-LUT → u8`

The code is already instruction-level optimised (FMA matrix, AVX2 perceptual path, fused vib-zero path, compact LUTs). **The remaining wins are architectural and memory-bound, not arithmetic.** Do not start by making the maths faster.

A profiler attributes ~70% to a "ToneMap" stage. That is a *stage label*, not a function.

---

## 0. Do this first (blocking)
**Establish what the 70% timer actually covers before touching any kernel.** It almost certainly wraps several things: LUT (re)build, LUT apply, f32↔u16 conversion, clamp/pack, and cache misses. Instrument these sub-spans separately:

- (a) LUT build
- (b) per-pixel apply
- (c) format conversion / pack
- (d) buffer copies during slider drags

Likely finding: **interactive latency is dominated by LUT rebuilds + buffer copies on slider movement, not the inner loop.** If so, the inner-loop work below is secondary to items 6, 10, and the architecture doc.

---

## Ranked changes

### Tier 1 — Low-risk, high-value (hours)

1. **Quantize inside tone math.** `apply_tone_math` returns `(f32,f32,f32)`, forcing a downstream `clamp → cast u16 → lookup → u8` per pixel. Return `(u16,u16,u16)` with a saturating quantize inside the function:
   ```rust
   #[inline]
   fn quantize(v: f32) -> u16 {
       (v * 65535.0 + 0.5).clamp(0.0, 65535.0) as u16
   }
   ```
   The post-LUT then becomes a clean `post[r]`. Removes a clamp + two casts per channel per pixel.

2. **Drop `Arc` in the thread-local cache.** `LutCache` holds `Arc<Vec<u16>>` but lives in `thread_local!` with no sharing. Use owned `Vec<u16>` (or `Rc`). Removes atomic refcount + an indirection it never uses.

3. **Pack the cache key.** Replace ~10 float-bit comparisons per render with a single packed `u128` (or pre-hashed `u64`) key — one compare. Pack: black/white, wb bits, exposure, tone bits, flags.

4. **Make the cache immutable after build.** Drop the `Option` + `borrow_mut → ensure → borrow` dance per render. Hold a permanent `RefCell<LutCache>` (or `Cell<*const LutCache>`).

5. **Fuse the pre-LUTs.** Collapse the three `pre_r/g/b` streams into one compact `Vec<[u16;3]>` (4096 entries ≈ 24 KB). One base pointer, one gather:
   ```rust
   let [r, g, b] = pre_rgb[idx];
   ```
   Expected 5–15% on the tone stage from fewer cache misses and address calcs.

### Tier 2 — Medium (structural)

6. **Replace `powf` in the LUT build with a polynomial.** The tone-curve build hits `v.powf(1.0/2.4)`. Cached, so not per-pixel — but every slider drag triggers a full 65 536-entry rebuild = 65 536 transcendentals. A minimax/Chebyshev degree 4–5 approximation is sufficient at ~16-bit LUT accuracy, turning the build into mul/add. **Directly attacks interactive latency.**

7. **Fuse pre-LUT + camera matrix.** The matrix is constant per image. Bake it into the pre-LUT so the hot loop starts with camera-corrected f32 RGB:
   ```rust
   pre_rgb: [[f32; 3]; N]   // already matrix-applied
   let rgb = pre_rgb[idx];  // no 3 separate lookups, no casts before the matrix
   ```

8. **Compile out per-pixel branches.** `perceptual_constancy` and `vib_zero` are policy decisions, not pixel-level facts. Resolve once before the loop:
   ```rust
   enum ColourPath { FastFused, ToneOnly, PerceptualGrid, FullPrecision }
   match kernel.path { /* branch-free loop per arm */ }
   ```
   Tiny per-branch cost × 24M pixels × 3 channels × many images = structural tax.

### Tier 3 — Architectural (see companion doc)

9. **Collapse matrix + WB + saturation + tone into one compiled transform**, materialised as a single LUT wherever the look is fixed.

10. **RAW16 → OUTPUT8 mega-LUT for the interactive preview path.** With WB/exposure/tone fixed during preview, a 3 × 64 KB (≈192 KB) direct LUT removes the entire per-pixel chain. Preview only — export keeps full math.

11. **Tile the pipeline + planar SoA working buffers** — detailed in the architecture doc.

---

## Acceptance / verification
- Sub-span timings captured **before and after** (item 0).
- Output bit-exact (or within a stated ε) vs. the current path on a regression set. The preview path may diverge within a documented tolerance.
- Slider-drag latency measured **separately** from full-render throughput.
- No `Arc`/atomic ops left in the thread-local hot path.

## Constraints
- Preview and export are allowed to differ — do not force one kernel to serve both.
- Do not touch the perceptual maths (log-euclidean / Molchanov / hybrid-spring) for speed; it is already attacked. Specialise instead (see quality tiers).
