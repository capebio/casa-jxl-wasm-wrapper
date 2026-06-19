# Pipeline.rs — Target Architecture (reference)

## Principle
The image should not move through a chain of stages — a compiled transform should move through the image. The operations are already fast; the cost is **data movement** and **branchy mega-kernels**. Compile the pipeline state once, then stream pixels through it in a single memory pass.

---

## 1. Compiled RenderKernel
Resolve all policy before the pixel loop into one immutable kernel:

```
RenderKernel {
    pre_lut / decode params
    colour_matrix          // WB × camera × saturation, pre-composed
    perceptual_mode
    tone_lut
    output_transform
    simd_strategy
    path: ColourPath       // FastFused | ToneOnly | PerceptualGrid | FullPrecision
}
```

The pixel loop then carries no `if perceptual`, `if vib_zero`, `if shadows/highlights`.

---

## 2. Unified TransformCache
Replace the separate PreLUT / Tone / Perceptual-grid caches with one cache whose unit of reuse is *"how many images share this look"*, not *"how many pixels share this LUT"* — a much bigger lever.

```
key   = { camera_id, wb, exposure, tone_params, perceptual_params, output_profile }
value = { pre_lut, compiled_matrix, grid_selector, tone/output_lut }
```

A render becomes: look up transform → stream pixels. No per-render rebuild.

---

## 3. Quality tiers
The code already implies these — make them explicit rather than forcing one kernel to serve every purpose:

- **PreviewKernel** — grid + SIMD, approximate, mega-LUT where possible.
- **ExportKernel** — full precision.
- **AnalysisKernel** — maximum perceptual fidelity.

Insisting one pipeline serves all three is where throughput leaks.

---

## 4. Memory movement (the likely dragon)
A 24 MP RGB16 image is ≈144 MB. Each full read+write ≈288 MB; five passes ≈1.4 GB moved. A clever multiply is irrelevant at that traffic.

Targets:

- **Tile (e.g. 64×64).** Load tile → apply *all* transforms in registers/L1 → write once. Replaces N whole-image passes with one.
- **No intermediate f32 image buffers.** Per pixel: load RGB16 → f32 in registers → compiled transform → tone LUT → store RGB16. Kill the materialised `u16 → f32 → … → u16` round-trips.
- **Bulk kernel, not a tuple-returning per-pixel fn:**
  ```rust
  fn transform_tile(src: &[u16], dst: &mut [u16], kernel: &RenderKernel)
  ```
- **Planar / SoA working buffers** (`RRR…/GGG…/BBB…`) to feed the existing `perceptual_apply_full_avx2` path. Deinterleave on decode, interleave once at the end — not per stage.

---

## 5. Cache hierarchy budget
Tone LUT + perceptual grid + tile must coexist in L1/L2 without thrashing. A smaller, less accurate LUT can beat a larger exact one. Size caches to the hierarchy, not to maximal precision.

---

## 6. Don't process discarded pixels
For thumbnails / lightbox previews, downsample **before** colour processing. Full-res colour science on pixels destined for a thumbnail is pure waste. Exports keep full-res ordering.

---

## Sequence
1. Measure the 70% timer's true boundaries.
2. Collapse f32↔u16 crossings.
3. Fuse colour + tone + output encoding into one compiled transform.
4. Split preview / export kernels.
5. Tile the pipeline.
6. Shrink caches to fit the CPU hierarchy.
7. Only then touch the maths.
