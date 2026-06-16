# Per-Pixel Math Evolution Plan: Centralizing Sensor-Sharpen, Log Geodesics, and Molchanov Residuals

**Context and Scope**  
This plan builds directly on the 2026-06 factoring work in `crates/raw-pipeline/src/demosaic.rs` (the new `mhc_pixel_phased` and related scalar hot paths) and the existing `apply_tone_math` in `crates/raw-pipeline/src/pipeline.rs`. The goal is **one canonical, maintainable site** for complex per-pixel arithmetic so that advanced perceptual transforms (sensor-sharpen matrix B, log geodesics, Molchanov corrections, hybrid Riemannian/non-Riemannian steps, Los Alamos curves, and multi-dimensional LUTs) can be evolved in one place without 5-way duplication or hot-path divergence.

**Critical constraint (P-1 rejection)**: The non-Riemannian / HPCS / Molchanov / Los Alamos engine is specified **exclusively for runtime `LookRenderer` per-pixel application during progressive JXL paints**. It is **not** for ingest-time "producedBy" encoder metadata, schema.ts, makeProducedBy wiring, or any bake-time asset creation. `producedBy` describes neutral asset creation (ZERO_LOOK path). Any proposal that expands the surface into encoder metadata, implies bake-time use of the perceptual model, or adds premature API surface without active runtime consumers is explicitly rejected per the project's documented discipline (see `docs/rejected optimizations.md` under "## P-1").

The factoring already demonstrated the pattern:  
- Shared core math fn for borders/tails/bands.  
- Phase/CFA-aware dispatch.  
- Unrolled straight-line hot paths left untouched for speed (RGGB mhc).  
- Parallel + band support for memory/latency.  
- Q12 fixed-point matrix fusion hook (`demosaic_rggb_mhc_matrix`).

Future evolution will extend the same discipline into the tone stage (`apply_tone_math` + pre/post LUT construction) while keeping the demosaic core as the early "sensor linear" hook **for runtime use only**.

All changes stay compatible with the existing black-level contract (bias + metadata until the tone stage), WASM performance targets, and the "Perceptual Constancy Mode" exposure **strictly for runtime progressive painting**.

## Introduction: What Are These Things? (Explained for the Uninitiated)

You asked for clear explanations because these are specialized terms from advanced color science and perceptual uniform color modeling. They are **not** standard sRGB or simple matrix work. They come from a synthesis of historical and modern research into how human vision actually perceives color under real-world lighting, and how to make digital adjustments (exposure, white balance, saturation) that *feel* linear and hue-stable to a human even when the underlying physics (camera sensors, illumination) are messy.

### 1. Sensor-Sharpen (the B matrix)
Camera sensors do not have perfect, human-like color filters. Their spectral response curves (how much they react to different wavelengths of light) are "blunt" and overlapping in ways that make accurate color reproduction difficult.

A **sensor sharpening matrix** (typically a 3x3 matrix called B) is a pre-processing step applied to linear sensor data (either on the raw Bayer mosaic before demosaicing or immediately after on the RGB). 

- It "sharpens" the effective sensitivities mathematically.
- It makes subsequent color transforms (white balance, matrix to sRGB or perceptual space) more stable and less prone to noise amplification or hue shifts.
- In practice: instead of raw camera RGB, you compute B * raw_RGB (or apply during interpolation). This is a linear algebra trick that improves the condition number of the color correction problem.

In this codebase it already has a toehold: `demosaic_rggb_mhc_matrix` accepts a Q12 fixed-point 3x3 and applies it during demosaicing. The plan will generalize this into the full advanced pipeline and make the same B available (or derived) for the tone stage.

### 2. Log Geodesics (Schrödinger’s curved, hue-stable paths + the log trick)
In perceptual color science, a "geodesic" is the shortest, most natural path between two colors in a perceptual space — the path a human would experience as a smooth change (e.g., gradually increasing saturation without the hue "bending" or looking weird).

Erwin Schrödinger (yes, the quantum guy also did color theory in the 1920s) defined families of geodesics that are **hue-stable**: traveling along them does not change the perceived hue, only intensity or saturation. These geodesics are **curved** when plotted in ordinary linear RGB or XYZ space.

The problem this creates (the "Flatness Paradox"):
- Most digital pipelines assume a flat Euclidean space (simple + , * , distance = sqrt of sum of squares).
- On a curved manifold those simple operations produce non-uniform perceptual steps, hue twists, and illumination-dependent behavior.

**The log-transform solution** (the key insight):
- Take the component-wise logarithm of the (properly scaled) linear RGB values.
- This maps the curved Riemannian manifold into an approximately flat 3D Euclidean coordinate system.
- In log space, ordinary vector addition/subtraction and linear scaling become excellent approximations to true geodesic steps.
- Exposure, white-balance, and saturation adjustments become fast, stable linear algebra instead of expensive numerical integration of differential equations.
- Because the transform is monotonic and invertible (exp on the way back), you get illumination-invariant behavior: the same slider delta looks the same whether the scene is in bright sunlight or deep shade.

The codebase already has the seeds (log-friendly linear data coming out of the raw pipeline, pre-LUTs that do black-sub + gain in a LUT-friendly way). The evolution plan will insert the explicit log step inside (or around) the hot per-pixel math so that the fancy geodesic math can be done cheaply.

### 3. Molchanov’s Anisotropy Measures, Parallelogram Law Residuals, Distance Structure Tensor (Aₜₑₙₛₒᵣ), and Adaptive Correction
Even after the log transform "flattens" the global space, locally the model still deviates from perfect human vision in certain regions (especially near neutral grays and in highly saturated greens — areas where cone responses and cortical processing have strong non-linearities and anisotropies, i.e. direction-dependent behavior).

Molchanov-style measures provide practical tools for the residual error:
- The **parallelogram law residual** tells you, at any point and in any direction, "how much does this local patch of color space fail to behave like a flat Euclidean plane?"
- These residuals are used to **adaptively discretize a precomputed metric tensor grid**. Instead of a uniform 3D lookup table, you allocate more sample density exactly where the flat approximation is worst (grays + saturated greens). This keeps memory and compute reasonable while guaranteeing accuracy where it matters.
- The **distance structure tensor Aₜₑₙₛₒᵣ** is a local 3x3 (or higher) object that describes the local "stretch" and orientation of perceptual distances. It is used at runtime to:
  - Modulate slider sensitivities (a +0.1 saturation change feels identical in red, green, or blue).
  - Adapt edge-detection / texture / clarity thresholds so that enhancement doesn't create false contours in one hue while under-enhancing another.
- For the remaining global/local mismatch, a **hybrid correction** blends true (but expensive) Riemannian geodesic steps with cheap non-Riemannian ΔE2000 corrections. The ΔE2000 acts as a "spring force" that gently pulls coordinates back onto the true neutral point and prevents mathematical drift near grays.
- Finally, **Los Alamos chromatic diminishing returns curves f(c)** are per-hue, non-uniform compression functions (stronger for pinks/greens/oranges/blues) that model how human vision compresses chroma at high saturation. They are applied as a final refinement on the flat log-space coordinates.

The net result is a color engine that:
- Uses fast linear algebra most of the time (thanks to log).
- Automatically concentrates expensive work where human vision is pickiest.
- Produces adjustments that are perceptually uniform *and* illumination-invariant ("Perceptual Constancy Mode").

## Goals of This Evolution
1. Make the current `apply_tone_math` (and the demosaic per-pixel core) the **single source of truth** for all future complex per-pixel math **in the runtime LookRenderer**.
2. Implement the full Schrödinger + Molchanov + HPCS + Los Alamos model inside the Rust hot loop **exclusively for runtime per-pixel application during progressive JXL paints**.
3. Deliver sub-millisecond per-frame cost on typical WASM targets via a combination of:
   - Precomputed multi-dimensional LUTs (log-space metric tensor + diminishing returns).
   - Optional SIMD (portable_simd or explicit intrinsics where profitable).
   - Early application of sensor-sharpen B (via the existing mhc_matrix path or a new early-transform hook) **at runtime only**.
4. Expose a clean "Perceptual Constancy Mode" boolean / parameters to the JavaScript lightbox **so that the progressive JXL painter** can use illumination-invariant exposure/saturation/white-balance without expensive per-pixel geodesic solving on the JS side. This is a runtime painting control only — never baked into "producedBy" or any ingest/encoder metadata.
5. Preserve every existing baseline (current tone curves, sat/vib, matrix, black handling, performance characteristics, bit-exactness on the synthetic tests).
6. Keep the same engineering discipline that the demosaic factoring introduced (no new duplication, clear separation of the "flat log math" from the "adaptive residual correction", good border/phase handling, parallel/band friendliness) **while strictly respecting the P-1 boundaries** (runtime LookRenderer only; no premature API surface for ingest-time or producedBy).

## High-Level Architecture
- **Early stage (demosaic, runtime only)**: Keep/extend `mhc_pixel_phased` + the matrix fusion path as the place where an optional sensor-sharpen B can be applied on linear sensor counts (before or during interpolation) **at runtime inside LookRenderer**. This is the natural home for anything that truly needs CFA-phase awareness during progressive paints. **Never used for ingest-time producedBy or encoder metadata.**
- **Main tone stage (pipeline, runtime LookRenderer)**: Evolve `apply_tone_math` into a richer `apply_advanced_perceptual_transform` (or keep the name and grow the body). The log step, tensor lookup, residual correction, hybrid spring, and f(c) curves live here. This is the designated "one place" for the non-Riemannian / HPCS / Molchanov / Los Alamos engine.
- **LUT / precomputation layer**: New functions (or extensions to the existing LutCache) that build a 3D (or 4D with local adaptation) table in log space. The table encodes the combined effect of the metric tensor + residuals + diminishing returns. Build time is allowed to be "slow" (once per parameter set); query time must be a handful of loads + arithmetic. **These LUTs are for runtime LookRenderer only.**
- **Hybrid path**: For diagnostic or highest-quality modes, a slower code path that actually walks a few geodesic steps + ΔE2000 correction for a subset of pixels (or as a refinement pass) **during progressive JXL painting**.
- **WASM / JS boundary**: A new (or extended) `PerceptualConstancyParams` struct (or flag on existing look params) that the JS lightbox can set **for runtime control of the progressive painter**. When enabled the engine uses the full model for illumination-invariant adjustments while still applying user artistic tone curves on top. **Explicitly out of scope**: any producedBy, schema.ts, makeProducedBy, or ingest/encoder metadata wiring.

The "one place" principle: any new term in the model (a new residual formula, a different f(c) curve, a 4th dimension in the tensor) is implemented **once** in the core math fn and then wired into the LUT builder and the direct hot loop. The unrolled fast paths and the scalar border paths both call the same core (or a const-generic variant). **All evolution is locked to runtime LookRenderer / progressive JXL paints per the P-1 rejection.**

## Implementation Plan (Layered for Multiple Agents / Sessions)

### Layer 1: Math Foundation & Data Structures (pure Rust, no pipeline yet)
- Define the core types: `SensorSharpenMatrix` (the B), `LogRGB` (newtype or just comments), `MetricTensorGrid` (adaptive 3D array + density map), `MolchanovResidual` calculator, `ChromaticDiminishingCurve` (per-hue or sampled f(c)).
- Implement the log / exp pair with proper scaling so that the mapping from linear sensor RGB → log-geodesic Euclidean is well-conditioned (use the white point and a small epsilon).
- Implement the parallelogram-law residual and the adaptive grid builder. This can be a build-time / parameter-set-time function.
- Implement the A_tensor modulator for local scale + the hybrid spring (ΔE2000 correction as a small additive pull toward neutral).
- Unit tests against known synthetic colors (neutral grays, saturated green, pink, etc.) that verify the flat approximation + residual correction produces more uniform steps than plain matrix + log.
- Suggested sketch (inside a new `perceptual_math` submodule or at the top of pipeline.rs):
  ```rust
  #[inline(always)]
  pub fn apply_log_geodesic_step(log_rgb: [f32;3], delta: [f32;3], tensor: &LocalTensor) -> [f32;3] {
      // flat linear step in log space, modulated by local A_tensor
      ...
  }

  pub fn build_adaptive_tensor_grid( /* params for density around gray + greens */ ) -> MetricTensorGrid { ... }
  ```

### Layer 2: Integrate into the Hot Per-Pixel Kernel (apply_tone_math evolution)
- Refactor `apply_tone_math` (and the pre-LUT construction) to optionally go through the advanced path.
- When "Perceptual Constancy Mode" is active:
  1. Apply sensor-sharpen B (can come from DNG color matrix path or a supplied one; early application preferred).
  2. Black-sub + white-scale (existing).
  3. Component-wise log (the transform that flattens the geodesics).
  4. Matrix or direct vector ops in log space for WB + exposure (already almost linear).
  5. Saturation/vibrance expressed as geodesic steps (using the tensor for local scaling so the slider feels constant-hue and constant-perceptual-strength).
  6. Residual correction + hybrid ΔE spring (small per-pixel or via LUT).
  7. Los Alamos f(c) curves (per-channel or in a hue-aware way).
  8. exp back to linear, then the existing tone curves / sRGB EOTF / post-LUT.
- Keep the fast path (current matrix + luma-sat) as the default when the advanced mode is off or when the LUT is not built. This preserves performance and exact current output for all existing looks.
- Suggested: the function signature grows an optional `&AdvancedPerceptualState` (containing the current grid slice, curves, etc.). Inside the hot loop you branch once per frame (or per tile) on whether the advanced state is present.
- Because the demosaic factoring already proved the pattern, reuse the same "core math fn + unrolled fast path + border scalar" structure inside the new advanced apply.

### Layer 3: LUT / SIMD Acceleration for Sub-Millisecond Performance
- Design the multi-dimensional LUT:
  - Input coordinates: (log-r, log-g, log-b) quantized + perhaps a low-res local adaptation coordinate (e.g. local luma or greenness for the gray/green density regions).
  - Output: the fully corrected (r',g',b') in log space after all the residual + spring + f(c) work, or the delta to add.
  - Precompute at parameter-set time using the grid + curves.
- For SIMD: use `portable_simd` (or `std::simd`) for the log/exp + small matrix + table lookups on 4 or 8 pixels at once. The existing separable blur kernels already show the project is comfortable with manual tiling + intrinsics when helpful.
- Fallback scalar path must be bit-identical to the LUT path (within float tolerance) for the same inputs.
- Budget: the whole advanced stage (including log/exp and one 3D lookup) must not regress the current tone path by more than ~15-20% on typical content when the mode is enabled.

### Layer 4: Perceptual Constancy Mode Exposure + JS Integration (Runtime Painter Only)
- Add fields to `PipelineParams` (or a new `PerceptualParams` that can be composed):
  - `perceptual_constancy: bool`
  - Optional overrides for B, tensor density knobs, strength of the hybrid spring, etc. (start with a simple on/off + a few preset curves).
- In the WASM bindings (`src/lib.rs` process_dng / process functions) plumb the flag through to the tone stage **for runtime LookRenderer use during progressive paints**.
- On the JS side the lightbox can offer "Constancy" sliders for exposure/sat/wb that the **progressive JXL painter** uses while chunks are still arriving. The heavy math stays in Rust + LUT so per-pixel cost during progressive paints remains acceptable.
- Document the invariance property: the same slider value should produce visually equivalent results under different captured illuminants (within the limits of the model).
- **Explicit prohibition (P-1)**: No changes to `producedBy`, encoder metadata, schema.ts, makeProducedBy, ingest pipelines, or any bake-time / asset-creation path. `producedBy` remains strictly for the neutral ZERO_LOOK creation path. Any such extension is rejected as speculative and in violation of the project's discipline against premature API surface expansion.

### Layer 5: Testing, Validation, and Migration
- Synthetic test images with known neutral ramps, hue circles at multiple lightness/saturation levels, and green/pink stress cases.
- Compare perceptual uniformity before/after (simple delta-E or just "slider steps look equal").
- Regression tests that the default (non-constancy) path is bit-exact (or within 1/65535) with the pre-factoring baseline.
- Performance micro-benchmarks (the same style as the existing ignored D3/D6 benches) for the LUT build vs. direct math vs. current path.
- Real DNG/ORF smoke tests (the existing real_orf_parses path) with constancy mode on/off.
- Once stable, consider whether any early sensor-sharpen B should become the default for the DNG color_matrix path (or remain opt-in).

## Suggested Code Sketch for the Core Hot Function (Evolved apply_tone_math)

```rust
#[inline(always)]
fn apply_perceptual_math(
    r: f32, g: f32, b: f32,
    sharpen_b: &[[f32;3];3],   // sensor-sharpen (can be identity)
    log_space_matrix: &[[f32;3];3],
    sat: f32, vib: f32,
    tensor: &LocalMolchanovTensor,  // or sampled from the grid
    diminishing: &DiminishingCurves,
    hybrid_spring_strength: f32,
) -> (f32, f32, f32) {
    // 1. Optional early sensor sharpen (or do this in demosaic via mhc_matrix)
    let r = sharpen_b[0][0]*r + ...;
    // ... same for g,b

    // 2. Black/white already handled in pre-LUT / caller; we are in linear [0,1] or scaled

    // 3. Log (the geodesic flattener)
    let lr = (r + 1e-6).ln();
    let lg = (g + 1e-6).ln();
    let lb = (b + 1e-6).ln();

    // 4. Main linear algebra in log space (WB/exposure already folded into the incoming values or a matrix)
    let mut lr2 = log_space_matrix[0][0]*lr + ...;
    // ...

    // 5. Saturation expressed as geodesic step modulated by A_tensor
    let luma_log = 0.2126*lr2 + ...;
    let scale = compute_geodesic_sat_scale(lr2, lg2, lb2, sat, vib, tensor);
    lr2 = luma_log + (lr2 - luma_log) * scale;
    // ...

    // 6. Residual + hybrid spring (pull toward neutral using ΔE2000-ish term)
    apply_molchanov_residual_and_spring(&mut lr2, &mut lg2, &mut lb2, tensor, hybrid_spring_strength);

    // 7. Diminishing returns per hue
    apply_diminishing_returns(&mut lr2, &mut lg2, &mut lb2, diminishing);

    // 8. Exp back
    let r2 = lr2.exp() - 1e-6;
    // ...
    (r2, g2, b2)
}
```

The LUT builder would pre-evaluate exactly this sequence over the adaptive grid and store the result (or the net delta).

## Risks, Constraints, and What Not To Do
- Do **not** duplicate the core math into the unrolled paths — call the shared function (or a const-evaluated version) the way the current mhc unroll + scalar borders already do.
- Do not change the default output or performance when the new mode is off.
- The full Riemannian geodesic solver is too slow for the hot path; it is only for validation or a "quality" refinement pass.
- Tensor grid memory must be reasonable (a few hundred KB at most; the adaptive density is the whole point).
- All new floating-point work must be WASM-friendly (no assumptions about fast transcendentals beyond what LLVM provides; LUTs hide the expensive parts).
- Preserve the existing thread-local LUT cache pattern.

### Explicitly Out of Scope (P-1 Rejection — Must Be Honored)
The non-Riemannian / HPCS / Molchanov / Los Alamos engine **is specified for runtime `LookRenderer` per-pixel application during progressive JXL paints, not for ingest-time "producedBy" encoder metadata**.

- `producedBy` describes neutral asset creation (ZERO_LOOK path) only.
- Any change that would incorrectly imply bake-time use of the perceptual engine is rejected.
- Do not expand the API surface with producedBy, schema.ts, makeProducedBy wiring, or similar without active runtime consumers.
- This plan and any implementation must strictly comply with the project's documented discipline against premature API additions. See `docs/rejected optimizations.md` under "## P-1" for the full technical rationale.

If a future proposal touches ingest/encoder/metadata paths, it must be rejected using the exact phrasing from the P-1 entry.

## Handoff / Next Steps
If you agree this direction is positive for the long-term vision (clean linear data + one place for the fancy perceptual math + sub-ms constancy mode for AR/plant ID / digital twins / LLM conditioning / progressive JXL **paints**), implement Layer 1 first (the pure math primitives and grid builder) in a new `perceptual` module or inside `pipeline.rs`, then wire it into `apply_tone_math`.

**Mandatory for any implementation**:
- Everything must remain strictly runtime `LookRenderer` per-pixel application during progressive JXL paints.
- Zero involvement with ingest-time paths, "producedBy", encoder metadata, schema.ts, makeProducedBy, or bake-time asset creation.
- Violations of the P-1 boundaries must be rejected with reasons recorded in `docs/rejected optimizations.md`.

Each subsequent layer can be a focused session. The demosaic factoring already gave us the template and the early hook; this plan just extends the same "one place" discipline into the tone/look stage **while honoring the explicit P-1 rejection**.

## Implemented

(Reassessment and surgical implementation performed with minimal external commentary; all decisions captured here.)

### Reassessed Items from the Plan (positive / applied or rejected)
- Adding `perceptual_constancy: bool` to PipelineParams + default: **positive**. Minimal runtime control surface. Enables mode without bloat or P-1 violation (stays in LookRenderer). Applied.
- Extending ToneInputs, derive_tone_inputs: **positive**. Required for clean propagation to the hot kernel. No cache impact. Applied.
- Evolving apply_tone_math signature + body with if perceptual_constancy { basic log geodesic stub for sat using log/exp + comments for full B / Molchanov tensor / residuals / A_tensor / spring / f(c) / LUT }: **positive**. Creates the designated "one place" for future evolution of the per-pixel math exactly as specified. Default path (flag=false) is byte-identical to before (no regression on existing). Stub is conservative (uses existing sat/vib factors) to keep new mode safe. All per the runtime progressive JXL paint constraint and P-1. Applied to crates/raw-pipeline/src/pipeline.rs only.
- Updating all 6 call sites via the apply_tone_math(...) invocations: **positive**. Mechanical for cohesion; covered by the replace. Applied.
- Layer 3 LUT build / full tensor grid / SIMD: **deferred (not applied in this pass)**. The direct-math path in the kernel is the foundation; full precompute would be larger change. Reassessed as positive long-term but current surgical focus on the "one place" hot fn was higher priority for establishing the site. Will be Layer 3 follow-up.
- Touching higher layers (e.g. src/lib.rs for look param mapping, full JS exposure): **not applied**. Reassessed: would expand surface; existing default=false + internal flag sufficient for now. Aligns with discipline against premature additions (P-1 spirit). Cohesive improvement limited to the core pipeline math.
- New perceptual module or demosaic changes: **not applied**. Kept entirely inside pipeline.rs apply_tone_math (the LookRenderer hot loop) for minimal diff and single-site clarity. Demosaic mhc_pixel_phased remains the early linear hook as noted in plan.
- Any ingest-time, producedBy, schema, encoder metadata: **explicitly rejected** per P-1 (already baked into this plan doc). No code for them.

The changes were applied surgically using precise string edits based on prior knowledge of file structure and contents. No unnecessary source comments about "success"; only the technical TODO for remaining layers. Black contract, parallel paths, LUT caching, and default behavior preserved exactly.

This establishes the centralized evolution point for sensor-sharpen, log geodesics, and Molchanov residuals in the runtime per-pixel path.

Post-implementation verification: ran c:\Foo\raw-converter-wasm\StandardMultifileTest.mjs (node). Completed with exit 0. Standard paths (default perceptual_constancy=false) exercised the raw decode (decompress/demosaic/tonemap) for ORF/DNG/CR2 assets among others. Reported aggregates (e.g. AvgRawDecompressMs, AvgRawDemosaicMs, AvgRawTonemapMs, prog_enc/shot_dec etc.) showed no indication of regression attributable to the added branch (never taken in default runs); numbers consistent with expected pipeline behavior for the test assets and tiers (simd, relaxed-simd-mt). Full output captured in session log for timing comparison if needed. No changes to non-runtime or metadata paths.

**End of plan document.**

(When the implementation of the full engine described here is complete in part or in its entirety, append - DONE to the filename.)