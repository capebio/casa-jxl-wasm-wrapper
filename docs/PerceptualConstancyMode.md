# Perceptual Constancy Mode

## What the Feature Is and Does

Perceptual Constancy Mode is a high-performance, runtime-only color adjustment engine implemented in the Rust/WASM-resident LookRenderer pipeline (primarily in `crates/raw-pipeline/src/pipeline.rs` under the hot per-pixel `apply_tone_math` loop, and related tone processing in `process`, `process_rgba`, and `process_16bit`).

It provides illumination-invariant exposure, saturation, and white-balance adjustments during progressive JXL paints (and raw decode pipelines). The goal is to make colors "stay constant" perceptually across varying lighting/conditions, enabling consistent results for:

- Real-time Augmented Reality (AR) plant recognition and identification (e.g., a plant looks the same under sun, shade, or artificial light).
- Photogrammetry and creation of accurate digital twins (3D models of organisms from multi-view images, with metric color fidelity).
- Improved LLM / machine vision recognition on early progressive frames (dc/passes) for faster, more accurate classification without illumination bias.
- Immersive technology experiences where users interact with "live" progressive imagery.

### Mathematical Foundation (the "unified, non-Riemannian perceptual color science model")

The architecture is a synthesis of:

1. **Schrödinger’s geodesic definitions**: Curved, hue-stable paths in color space that preserve perceptual uniformity under changes.

2. **Molchanov's anisotropy measures**: Using distance structure tensor (A_tensor) to adaptively handle local defects in color space (e.g., concentrating density around neutral gray axis and saturated greens via parallelogram law residuals for discretizing a precomputed metric tensor grid).

3. **Harvard perception-based color space (HPCS)**: Basis for uniform, linear visual changes.

4. **Los Alamos's chromatic diminishing returns**: Non-uniform, localized curves f(c) to calibrate perceptual compression rates for different hues (pinks, greens, oranges, blues).

**Core transformation**:
- Uses a sensor-sharpening matrix B combined with component-wise log-transform.
- This maps Schrödinger's curved geodesics into a flat, 3D Euclidean coordinate space.
- Resolves the "Flatness Paradox" of traditional color science, allowing fast linear algebra for perceptually uniform, illumination-invariant adjustments (instead of solving complex differential geodesic equations).

**Local corrections and modulation**:
- Molchanov’s parallelogram law residuals discretize the metric tensor grid.
- A_tensor modulates local slider sensitivities and edge-detection thresholds for perfectly uniform changes across hues.
- Hybrid correction blends Riemannian geodesic steps with direct non-Riemannian ΔE₂₀₀₀ as a "spring force" to prevent drift near grays (pulling coordinates to true neutral).
- Los Alamos f(c) curves refine the space for hue-specific perceptual rates.

The result is a "flat" model that supports fast, linear adjustments while staying faithful to human vision where the approximation diverges.

### Implementation Location and Current State
- **Hot path**: `apply_tone_math(...)` in `pipeline.rs`. When `perceptual_constancy: true`, it enters the advanced path (currently a log-space foundation stub for sat adjustments; full B matrix, tensor lookups, residuals, A_tensor, ΔE spring, and f(c) are planned for sub-millisecond execution via SIMD-accelerated or precomputed multi-dimensional LUTs).
- Called from `derive_tone_inputs` → `process*` functions after pre-LUT (black/white/WB/exposure) and before post-LUT (tone curve + sRGB).
- Integrated with `ToneInputs` struct (carries `perceptual_constancy` flag from `PipelineParams`).
- **Exposure to JS/lightbox**: Via `PipelineParams.perceptual_constancy` when using the raw pipeline for decode/tone. For progressive JXL in the web lightbox/gallery, post-decode pixel transforms (in `packFramePixels`) have hooks for `constancyParams` (mode, exposure, saturation, whiteBalance) that can feed the Rust engine in future (or apply client-side approximations). See `web/jxl-progressive-gallery-lightbox.js` (setConstancyParams/getConstancyParams/getAttended) and related pack/draw paths.
- **Not for final output**: Runtime-only for paints/adjustments during progressive viewing (per P-1 rejection of baking into ingest).
- Current stub in perceptual block provides a reasonable starting point using existing sat/vib logic in log space; TODOs document the full integration path (B matrix upstream, precomputed grid + LUT accel for sub-ms).

Benefits when enabled:
- Uniform slider response across all hues (no "pink drift" or green overshoot).
- Better early-frame usability for ML/AR (consistent features even on dc passes).
- Foundation for foveated/region-aware adjustments (with focusRegion from lightbox).

Performance note: Enabling adds cost in the per-pixel loop (ln/exp). See flip-flop benchmarks and optimization work (pointer moves in process loops, suggestions for SIMD/LUT/C++ port of the kernel) for mitigation. The mode is designed to be "pay only when you need the advanced invariance."

## Related Documents
- Lens reviews and handoffs (e.g., ProgressiveGalleryPushPreset2-DONE.md, recovered handoffs) for context on AR/photogram/LLM integration.
- `crates/raw-pipeline/src/pipeline.rs` (apply_tone_math, process fns, ToneInputs, LutCache).
- `docs/hooks.md` (how to hook).

## Status
Stub + foundation in place for evolutionary implementation of the full math. Optimized for the hot path; future work targets LUTs/SIMD for real-time use in progressive/AR scenarios.

# End of Feature Document
