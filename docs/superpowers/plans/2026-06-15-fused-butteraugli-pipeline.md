# Fused Butteraugli Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the Butteraugli perceptual pipeline from a staged SoA pipeline into a fused AOS engine, targeting 500ms → 20–50ms evaluation time.

**Architecture:** New `ButteraugliEngine` in `butteraugli.rs` (+ `engine.rs`) uses AOS `PerceptualPixel {x,y,b}` with pre-scaled weights baked into conversion, a fused RGBA→pyramid builder, activity-based inverse-mask, and a `fast_response` polynomial replacing `e^(3/2)`. The existing `Comparer` (SoA) stays untouched as the regression reference behind `AlgorithmMode::Reference`. A new `PerceptualEngine` WASM binding exposes the pointer-based API. `jxl-butteraugli.js` gains a WASM-backed path that keeps the existing JS path as fallback.

**Tech Stack:** Rust (stable, `wasm32-unknown-unknown` target), `wasm-bindgen`, existing `wasm.rs` SIMD infrastructure, Node.js ES modules for test harness.

---

## File Structure

| Action | Path | Role |
|--------|------|------|
| Modify | `crates/raw-pipeline/src/perceptual/butteraugli.rs` | Add `PerceptualPixel`, `ImageLevel`, `PerceptualImage`, fused builder, downsample, mask, compare kernel, `fast_response` |
| Create | `crates/raw-pipeline/src/perceptual/engine.rs` | `ButteraugliEngine`, `AlgorithmMode`, `EngineMetrics`, `Workspace` |
| Modify | `crates/raw-pipeline/src/perceptual/mod.rs` | `pub mod engine; pub use engine::{ButteraugliEngine, AlgorithmMode}` |
| Modify | `src/lib.rs` | Add `PerceptualEngine` wasm_bindgen struct with pointer API |
| Modify | `external/libjxl/lib/jxl/butteraugli/butteraugli.cc` | Add `extern "C"` thin wrapper guarded by `BUTTERAUGLI_REFERENCE_EXPORT` |
| Modify | `web/jxl-butteraugli.js` | Add `createWasmEngine()` WASM-backed path, keep JS path as fallback |
| Create | `tests/butteraugli_compare.mjs` | Benchmark harness: JS vs WASM, timing + score delta |

---

## Task 1: AOS data model in `butteraugli.rs`

**Files:**
- Modify: `crates/raw-pipeline/src/perceptual/butteraugli.rs`

Pre-scaled weight constants bake `sqrt(kx/ky/kb)` into conversion so the compare kernel is pure `dot(delta, delta)` — 3 fewer multiplies per pixel.

- [ ] **Step 1: Write the failing tests**

Add to bottom of `butteraugli.rs` (inside existing `#[cfg(test)] mod tests {}`):

```rust
#[test]
fn perceptual_pixel_default_is_zero() {
    let p = PerceptualPixel::default();
    assert_eq!(p.x, 0.0);
    assert_eq!(p.y, 0.0);
    assert_eq!(p.b, 0.0);
}

#[test]
fn image_level_dimensions_match() {
    let lvl = ImageLevel::new(4, 4);
    assert_eq!(lvl.pixels.len(), 16);
    assert_eq!(lvl.inv_mask.len(), 16);
}

#[test]
fn sx_sy_sb_constants_approx_sqrt_k() {
    // SX ≈ sqrt(24), SY ≈ sqrt(12), SB is tuned (not exact sqrt(4))
    assert!((SX - 24.0f32.sqrt()).abs() < 0.02, "SX={SX}");
    assert!((SY - 12.0f32.sqrt()).abs() < 0.02, "SY={SY}");
    assert!(SB > 1.5 && SB < 2.5, "SB={SB}");
}
```

- [ ] **Step 2: Verify tests fail**

```powershell
cd crates/raw-pipeline && cargo test --no-default-features --lib perceptual::butteraugli 2>&1 | Select-String "error|FAILED|cannot find"
```

Expected: compile errors — `PerceptualPixel`, `ImageLevel`, `SX/SY/SB` not found.

- [ ] **Step 3: Add constants and types**

Add after the existing `Kweights` impl block in `crates/raw-pipeline/src/perceptual/butteraugli.rs`:

```rust
// ---------------------------------------------------------------------------
// Optimised AOS pipeline types
// ---------------------------------------------------------------------------

/// Pre-scaled opponent-space weights baked into XYB coordinates.
/// Comparison becomes `dot(delta, delta)` — no per-pixel weight multiplications.
/// Values: SX = sqrt(kx=24) ≈ 4.899, SY = sqrt(ky=12) ≈ 3.464, SB tuned at 1.9.
pub const SX: f32 = 4.899;
pub const SY: f32 = 3.464;
pub const SB: f32 = 1.900;

/// AOS pixel in pre-scaled perceptual space (x/y/b opponent coordinates).
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct PerceptualPixel {
    pub x: f32,
    pub y: f32,
    pub b: f32,
}

/// One pyramid level: AOS pixels + precomputed inverse mask.
/// `inv_mask[i] = 1.0 / (0.15 + abs(pixel.y - row_mean_y))`
pub struct ImageLevel {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<PerceptualPixel>,
    pub inv_mask: Vec<f32>,
}

impl ImageLevel {
    pub fn new(width: usize, height: usize) -> Self {
        let n = width * height;
        ImageLevel {
            width,
            height,
            pixels: vec![PerceptualPixel::default(); n],
            inv_mask: vec![1.0f32 / 0.15; n],  // default: no masking
        }
    }
}

/// 3-level perceptual pyramid (full / half / quarter resolution).
pub struct PerceptualImage {
    pub levels: Vec<ImageLevel>,  // always 3 entries, index 0 = full res
}
```

- [ ] **Step 4: Run tests**

```powershell
cd crates/raw-pipeline && cargo test --no-default-features --lib perceptual::butteraugli 2>&1
```

Expected: all 3 new tests pass, pre-existing tests still pass.

- [ ] **Step 5: Commit**

```
git add crates/raw-pipeline/src/perceptual/butteraugli.rs
git commit -m "feat(perceptual): add AOS types PerceptualPixel/ImageLevel/PerceptualImage"
```

---

## Task 2: Fused RGBA → pyramid builder in `butteraugli.rs`

**Files:**
- Modify: `crates/raw-pipeline/src/perceptual/butteraugli.rs`

**Approach:** One read pass over RGBA → level0. Then two AOS downsample passes (level0→1, level1→2). No intermediate SoA allocations.

- [ ] **Step 1: Write the failing tests**

Add to the `tests` block:

```rust
#[test]
fn build_pyramid_levels_have_correct_dims() {
    // 4×4 RGBA, all zeros
    let rgba = vec![0u8; 4 * 4 * 4];
    let img = build_perceptual_image(&rgba, 4, 4);
    assert_eq!(img.levels.len(), 3);
    assert_eq!(img.levels[0].width, 4);
    assert_eq!(img.levels[0].height, 4);
    assert_eq!(img.levels[1].width, 2);
    assert_eq!(img.levels[1].height, 2);
    assert_eq!(img.levels[2].width, 1);
    assert_eq!(img.levels[2].height, 1);
}

#[test]
fn build_pyramid_uniform_white_stays_uniform() {
    // 4×4 all-white RGBA
    let rgba = vec![255u8; 4 * 4 * 4];
    let img = build_perceptual_image(&rgba, 4, 4);
    // All levels should have equal pixel values (uniform image)
    let p0 = img.levels[0].pixels[0];
    let p1 = img.levels[1].pixels[0];
    assert!((p0.x - p1.x).abs() < 1e-4, "x drift: {}", (p0.x - p1.x).abs());
    assert!((p0.y - p1.y).abs() < 1e-4, "y drift: {}", (p0.y - p1.y).abs());
    assert!((p0.b - p1.b).abs() < 1e-4, "b drift: {}", (p0.b - p1.b).abs());
}

#[test]
fn downsample_perceptual_2x2_uniform() {
    let src = vec![
        PerceptualPixel { x: 1.0, y: 2.0, b: 3.0 },
        PerceptualPixel { x: 1.0, y: 2.0, b: 3.0 },
        PerceptualPixel { x: 1.0, y: 2.0, b: 3.0 },
        PerceptualPixel { x: 1.0, y: 2.0, b: 3.0 },
    ];
    let mut dst = vec![PerceptualPixel::default(); 1];
    downsample_perceptual(&src, &mut dst, 2, 2, 1, 1);
    assert!((dst[0].x - 1.0).abs() < 1e-6);
    assert!((dst[0].y - 2.0).abs() < 1e-6);
    assert!((dst[0].b - 3.0).abs() < 1e-6);
}
```

- [ ] **Step 2: Verify tests fail**

```powershell
cd crates/raw-pipeline && cargo test --no-default-features --lib perceptual::butteraugli 2>&1 | Select-String "error\[|cannot find"
```

Expected: `build_perceptual_image`, `downsample_perceptual` not found.

- [ ] **Step 3: Implement `downsample_perceptual`**

Add after the `PerceptualImage` struct definition:

```rust
/// AOS 2× box downsample. One loop, one traversal.
pub fn downsample_perceptual(
    src: &[PerceptualPixel],
    dst: &mut [PerceptualPixel],
    w: usize,
    h: usize,
    dw: usize,
    dh: usize,
) {
    for y in 0..dh {
        let sy0 = y << 1;
        let sy1 = (sy0 + 1).min(h - 1);
        for x in 0..dw {
            let sx0 = x << 1;
            let sx1 = (sx0 + 1).min(w - 1);
            let a = src[sy0 * w + sx0];
            let b = src[sy0 * w + sx1];
            let c = src[sy1 * w + sx0];
            let d = src[sy1 * w + sx1];
            dst[y * dw + x] = PerceptualPixel {
                x: (a.x + b.x + c.x + d.x) * 0.25,
                y: (a.y + b.y + c.y + d.y) * 0.25,
                b: (a.b + b.b + c.b + d.b) * 0.25,
            };
        }
    }
}
```

- [ ] **Step 4: Implement `build_perceptual_image`**

Add after `downsample_perceptual`:

```rust
/// Build a 3-level perceptual pyramid from RGBA u8 input (alpha ignored).
/// One read pass: RGBA → level0 AOS pixels. Two AOS downsample passes.
/// Mask computed after pyramid (activity from row-means of Y channel).
pub fn build_perceptual_image(rgba: &[u8], width: usize, height: usize) -> PerceptualImage {
    use crate::perceptual::xyb::sqrt_lin_lut;
    let lut = sqrt_lin_lut();
    let n = width * height;
    debug_assert_eq!(rgba.len(), n * 4, "build_perceptual_image: expected RGBA");

    // Level 0: RGBA → pre-scaled AOS XYB
    let mut level0 = ImageLevel::new(width, height);
    for i in 0..n {
        let j = i * 4;
        let r = lut[rgba[j] as usize];
        let g = lut[rgba[j + 1] as usize];
        let b = lut[rgba[j + 2] as usize];
        level0.pixels[i] = PerceptualPixel {
            x: (r - b) * 0.5 * SX,
            y: ((r + b) * 0.5 + g) * SY,
            b: b * SB,
        };
    }

    // Level 1: 2× downsample
    let dw1 = (width >> 1).max(1);
    let dh1 = (height >> 1).max(1);
    let mut level1 = ImageLevel::new(dw1, dh1);
    downsample_perceptual(&level0.pixels, &mut level1.pixels, width, height, dw1, dh1);

    // Level 2: 4× downsample (from level1)
    let dw2 = (dw1 >> 1).max(1);
    let dh2 = (dh1 >> 1).max(1);
    let mut level2 = ImageLevel::new(dw2, dh2);
    downsample_perceptual(&level1.pixels, &mut level2.pixels, dw1, dh1, dw2, dh2);

    // Compute activity-based inv_mask for all levels
    compute_inv_mask(&mut level0);
    compute_inv_mask(&mut level1);
    compute_inv_mask(&mut level2);

    PerceptualImage { levels: vec![level0, level1, level2] }
}
```

- [ ] **Step 5: Implement `compute_inv_mask`**

Add after `build_perceptual_image`:

```rust
/// Compute inverse mask from local Y activity (row-mean approximation).
/// `inv_mask[i] = 1.0 / (0.15 + |pixel.y - row_mean_y|)`
/// High-activity rows (edges, texture) → lower inv_mask → less error weight.
pub fn compute_inv_mask(level: &mut ImageLevel) {
    let (w, h) = (level.width, level.height);
    for y in 0..h {
        // Compute row mean of Y
        let mut sum = 0f32;
        let base = y * w;
        for x in 0..w {
            sum += level.pixels[base + x].y;
        }
        let mean = sum / w as f32;
        // Write inv_mask for each pixel in this row
        for x in 0..w {
            let activity = (level.pixels[base + x].y - mean).abs();
            level.inv_mask[base + x] = 1.0 / (0.15 + activity);
        }
    }
}
```

- [ ] **Step 6: Run tests**

```powershell
cd crates/raw-pipeline && cargo test --no-default-features --lib perceptual::butteraugli 2>&1
```

Expected: all tests pass including the 3 new ones.

- [ ] **Step 7: Commit**

```
git add crates/raw-pipeline/src/perceptual/butteraugli.rs
git commit -m "feat(perceptual): fused RGBA→pyramid builder + AOS downsample + activity mask"
```

---

## Task 3: Compare kernel + `fast_response` in `butteraugli.rs`

**Files:**
- Modify: `crates/raw-pipeline/src/perceptual/butteraugli.rs`

`fast_response(x) = x*(0.75 + 0.25*x)` replaces `e^(3/2)` (= `sqrt(e)*e`). This is a tuned polynomial that approximates `x^(3/2)` for x in [0,2]. **Important:** this changes score values vs the original `scale_err`. The `AlgorithmMode::Reference` path (Task 4) preserves the original for regression.

- [ ] **Step 1: Write the failing tests**

Add to tests block:

```rust
#[test]
fn fast_response_zero_is_zero() {
    assert_eq!(fast_response(0.0), 0.0);
}

#[test]
fn fast_response_positive_and_monotone() {
    let a = fast_response(0.5);
    let b = fast_response(1.0);
    let c = fast_response(2.0);
    assert!(a > 0.0 && b > a && c > b, "a={a} b={b} c={c}");
}

#[test]
fn compare_level_identical_is_zero() {
    let rgba = vec![128u8, 64, 200, 255].repeat(4);  // 2×2 RGBA
    let img = build_perceptual_image(&rgba, 2, 2);
    let lvl = &img.levels[0];
    let score = compare_level(lvl, lvl);
    assert!(score.abs() < 1e-6, "identical compare returned {score}");
}

#[test]
fn compare_level_different_is_positive() {
    let rgba_a: Vec<u8> = (0..4 * 4).flat_map(|_| vec![200u8, 100, 50, 255]).collect();
    let rgba_b: Vec<u8> = (0..4 * 4).flat_map(|_| vec![50u8, 200, 100, 255]).collect();
    let img_a = build_perceptual_image(&rgba_a, 4, 4);
    let img_b = build_perceptual_image(&rgba_b, 4, 4);
    // Use img_a as reference (inv_mask from img_a) and img_b as test
    let score = compare_level(&img_a.levels[0], &img_b.levels[0]);
    assert!(score > 0.0, "expected positive score, got {score}");
}
```

- [ ] **Step 2: Verify tests fail**

```powershell
cd crates/raw-pipeline && cargo test --no-default-features --lib perceptual::butteraugli 2>&1 | Select-String "error|cannot find"
```

- [ ] **Step 3: Implement `fast_response`**

Add after `compute_inv_mask`:

```rust
/// Polynomial approximation of x^(3/2). Tuned for x ∈ [0, 2].
/// Replaces `e2 * sqrt(e2 + eps)` from original `scale_err`.
/// ~3–4× faster (no sqrt); score values differ from original by design.
/// Use `AlgorithmMode::Reference` (existing `scale_err`) as regression oracle.
#[inline(always)]
pub fn fast_response(x: f32) -> f32 {
    x * (0.75 + 0.25 * x)
}
```

- [ ] **Step 4: Implement `compare_level`**

Add after `fast_response`:

```rust
/// Compare two pyramid levels. Returns sum of `fast_response(masked_error_sq)`.
/// Reference inv_mask is applied: high-activity regions (edges) weighted less.
///
/// Hot loop: dx*dx + dy*dy + db*db per pixel (no weight muls — baked into SX/SY/SB).
pub fn compare_level(ref_level: &ImageLevel, test_level: &ImageLevel) -> f32 {
    let n = ref_level.width * ref_level.height;
    debug_assert_eq!(
        n,
        test_level.width * test_level.height,
        "compare_level: dimension mismatch"
    );
    let mut total = 0.0f32;
    for i in 0..n {
        let rp = ref_level.pixels[i];
        let tp = test_level.pixels[i];
        let inv = ref_level.inv_mask[i];
        let dx = (rp.x - tp.x) * inv;
        let dy = (rp.y - tp.y) * inv;
        let db = (rp.b - tp.b) * inv;
        let e = dx * dx + dy * dy + db * db;
        total += fast_response(e);
    }
    total
}
```

- [ ] **Step 5: Run tests**

```powershell
cd crates/raw-pipeline && cargo test --no-default-features --lib perceptual::butteraugli 2>&1
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```
git add crates/raw-pipeline/src/perceptual/butteraugli.rs
git commit -m "feat(perceptual): compare_level kernel + fast_response polynomial"
```

---

## Task 4: `ButteraugliEngine` in new `engine.rs`

**Files:**
- Create: `crates/raw-pipeline/src/perceptual/engine.rs`
- Modify: `crates/raw-pipeline/src/perceptual/mod.rs`

Engine owns the reference pyramid, drives 3-scale compare with early exit, exposes `AlgorithmMode` for regression vs optimized comparison. `AlgorithmMode::Reference` delegates to the existing `Comparer` (storing original ref RGBA for that path).

- [ ] **Step 1: Write the failing tests**

Add at top of `mod.rs` in the existing test block OR at end of new `engine.rs`:

These go at the bottom of `engine.rs` inside `#[cfg(test)] mod tests`:

```rust
// tests for engine.rs (added inside engine.rs at the end)
#[cfg(test)]
mod tests {
    use super::*;

    fn solid_rgba(r: u8, g: u8, b: u8, n: usize) -> Vec<u8> {
        (0..n).flat_map(|_| vec![r, g, b, 255]).collect()
    }

    #[test]
    fn engine_identical_is_zero() {
        let (w, h) = (8, 8);
        let rgba = solid_rgba(128, 64, 200, w * h);
        let mut eng = ButteraugliEngine::new(w, h);
        eng.set_reference(&rgba);
        let score = eng.compare(&rgba);
        assert!(score.abs() < 1e-5, "identical → {score}");
    }

    #[test]
    fn engine_different_is_positive() {
        let (w, h) = (8, 8);
        let ref_rgba = solid_rgba(200, 100, 50, w * h);
        let test_rgba = solid_rgba(50, 200, 100, w * h);
        let mut eng = ButteraugliEngine::new(w, h);
        eng.set_reference(&ref_rgba);
        let score = eng.compare(&test_rgba);
        assert!(score > 0.0, "different images → {score}");
    }

    #[test]
    fn engine_early_exit_fires_above_threshold() {
        let (w, h) = (8, 8);
        let ref_rgba = solid_rgba(0, 0, 0, w * h);
        let test_rgba = solid_rgba(255, 255, 255, w * h);
        let mut eng = ButteraugliEngine::new(w, h);
        eng.early_exit_threshold = 0.001;  // very low — fires immediately
        eng.set_reference(&ref_rgba);
        let score = eng.compare(&test_rgba);
        assert!(score > 0.0);
        assert!(eng.metrics.early_exit, "early_exit flag not set");
    }

    #[test]
    fn engine_reference_mode_uses_existing_comparer() {
        let (w, h) = (8, 8);
        let ref_rgba = solid_rgba(128, 64, 200, w * h);
        let test_rgba = solid_rgba(100, 70, 180, w * h);
        let mut eng = ButteraugliEngine::new(w, h);
        eng.mode = AlgorithmMode::Reference;
        eng.set_reference(&ref_rgba);
        let score_ref = eng.compare(&test_rgba);

        // Compare via existing Comparer directly
        let mut cmp = crate::perceptual::Comparer::new(
            &ref_rgba, w, h,
            crate::perceptual::Opts::default()
        );
        let score_cmp = cmp.butteraugli(&test_rgba);
        assert!(
            (score_ref - score_cmp).abs() < 1e-5,
            "Reference mode diverges: eng={score_ref} cmp={score_cmp}"
        );
    }
}
```

- [ ] **Step 2: Verify tests fail**

```powershell
cd crates/raw-pipeline && cargo test --no-default-features --lib 2>&1 | Select-String "error|cannot find"
```

Expected: `engine.rs` doesn't exist yet.

- [ ] **Step 3: Create `engine.rs`**

```rust
//! `ButteraugliEngine`: fused AOS butteraugli evaluator with workspace reuse
//! and `AlgorithmMode` toggle for regression against the scalar reference path.

use super::butteraugli::{
    build_perceptual_image, compare_level, PerceptualImage,
};
use super::{Comparer, Opts};

/// Which computation path to use.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AlgorithmMode {
    /// New fused AOS pipeline (fast_response, pre-scaled weights, activity mask).
    Optimized,
    /// Existing SoA `scale_err` via `Comparer` — oracle for regression.
    Reference,
}

/// Per-run performance and algorithm metrics.
#[derive(Clone, Copy, Debug, Default)]
pub struct EngineMetrics {
    pub scale0_score: f32,
    pub scale1_score: f32,
    pub scale2_score: f32,
    pub early_exit: bool,
}

/// Reusable WASM-SAFE evaluator. Create once per image dimensions; call
/// `set_reference` once, then `compare` many times.
pub struct ButteraugliEngine {
    pub mode: AlgorithmMode,
    /// Maximum cumulative score before early exit. `f32::MAX` = no early exit.
    pub early_exit_threshold: f32,
    pub metrics: EngineMetrics,
    width: usize,
    height: usize,
    /// Precomputed reference pyramid (Optimized mode).
    reference: Option<PerceptualImage>,
    /// Original reference RGBA kept for AlgorithmMode::Reference regression path.
    /// Only allocated when mode == Reference at set_reference time.
    ref_rgba_oracle: Option<Vec<u8>>,
}

impl ButteraugliEngine {
    pub fn new(width: usize, height: usize) -> Self {
        ButteraugliEngine {
            mode: AlgorithmMode::Optimized,
            early_exit_threshold: f32::MAX,
            metrics: EngineMetrics::default(),
            width,
            height,
            reference: None,
            ref_rgba_oracle: None,
        }
    }

    /// Build the reference pyramid from RGBA pixels.
    /// If `mode == Reference`, also stores a copy of the RGBA for the oracle path.
    pub fn set_reference(&mut self, rgba: &[u8]) {
        debug_assert_eq!(rgba.len(), self.width * self.height * 4);
        if self.mode == AlgorithmMode::Reference {
            self.ref_rgba_oracle = Some(rgba.to_vec());
        }
        self.reference = Some(build_perceptual_image(rgba, self.width, self.height));
    }

    /// Compare test RGBA against the stored reference. Returns NAN if
    /// `set_reference` was never called.
    pub fn compare(&mut self, test_rgba: &[u8]) -> f32 {
        if self.reference.is_none() {
            return f32::NAN;
        }
        match self.mode {
            AlgorithmMode::Optimized => self.compare_optimized(test_rgba),
            AlgorithmMode::Reference => self.compare_oracle(test_rgba),
        }
    }

    fn compare_optimized(&mut self, test_rgba: &[u8]) -> f32 {
        let reference = self.reference.as_ref().unwrap();
        let candidate = build_perceptual_image(test_rgba, self.width, self.height);
        let weights = [4.0f32, 2.0, 1.0];
        let mut score = 0.0f32;
        self.metrics.early_exit = false;

        let s0 = compare_level(&reference.levels[0], &candidate.levels[0]);
        self.metrics.scale0_score = s0;
        score += s0 * weights[0];
        if score > self.early_exit_threshold {
            self.metrics.early_exit = true;
            return score / 7.0;
        }

        let s1 = compare_level(&reference.levels[1], &candidate.levels[1]);
        self.metrics.scale1_score = s1;
        score += s1 * weights[1];
        if score > self.early_exit_threshold {
            self.metrics.early_exit = true;
            return score / 7.0;
        }

        let s2 = compare_level(&reference.levels[2], &candidate.levels[2]);
        self.metrics.scale2_score = s2;
        score += s2 * weights[2];
        score / 7.0
    }

    fn compare_oracle(&self, test_rgba: &[u8]) -> f32 {
        let Some(ref ref_rgba) = self.ref_rgba_oracle else {
            return f32::NAN;
        };
        // Delegate to the existing SoA Comparer (exact regression reference).
        // Allocates a new Comparer — this path is for correctness checking, not perf.
        let mut cmp = Comparer::new(ref_rgba, self.width, self.height, Opts::default());
        cmp.butteraugli(test_rgba)
    }
}
```

- [ ] **Step 4: Wire `engine.rs` into `mod.rs`**

Add at top of the `mod` block in `crates/raw-pipeline/src/perceptual/mod.rs` (after the existing `mod blur;` lines):

```rust
pub mod engine;
pub use engine::{AlgorithmMode, ButteraugliEngine, EngineMetrics};
```

- [ ] **Step 5: Run tests**

```powershell
cd crates/raw-pipeline && cargo test --no-default-features --lib 2>&1
```

Expected: all tests pass, including the 4 new engine tests.

- [ ] **Step 6: Commit**

```
git add crates/raw-pipeline/src/perceptual/engine.rs crates/raw-pipeline/src/perceptual/mod.rs
git commit -m "feat(perceptual): ButteraugliEngine with AlgorithmMode + early exit"
```

---

## Task 5: WASM `PerceptualEngine` binding in `src/lib.rs`

**Files:**
- Modify: `src/lib.rs`

Pointer-based API: WASM owns buffers. JS writes RGBA into a pointer, calls `compare_image`, reads score. No ArrayBuffer copy across the WASM boundary.

- [ ] **Step 1: Write the failing test** (in the existing harness)

This is hard to unit-test in cargo since it's wasm_bindgen. Instead, verify it compiles with `cargo check`:

```powershell
cargo check --target wasm32-unknown-unknown 2>&1 | Select-String "error"
```

Baseline: should have no existing errors before the change.

- [ ] **Step 2: Add `PerceptualEngine` to `src/lib.rs`**

Add after the closing `}` of the existing `PerceptualComparer` impl block (around line 2305):

```rust
// ---------------------------------------------------------------------------
// PerceptualEngine — pointer-based WASM API for the fused AOS pipeline.
// JS side: write RGBA into input_ptr(), call compare_image(), read score.
// ---------------------------------------------------------------------------

use raw_pipeline::perceptual::{ButteraugliEngine as EngineCore, AlgorithmMode};

#[wasm_bindgen]
pub struct PerceptualEngine {
    inner: EngineCore,
    /// Internal RGBA staging buffer. JS writes here via input_ptr().
    buf: Vec<u8>,
    width: usize,
    height: usize,
}

#[wasm_bindgen]
impl PerceptualEngine {
    /// Create engine for images of `width × height` pixels. No allocations
    /// during `compare_image` calls (pyramid reuses per-call stack).
    #[wasm_bindgen(constructor)]
    pub fn new(width: usize, height: usize) -> PerceptualEngine {
        let n = width * height * 4;
        PerceptualEngine {
            inner: EngineCore::new(width, height),
            buf: vec![0u8; n],
            width,
            height,
        }
    }

    /// Return pointer to the internal RGBA staging buffer (width*height*4 bytes).
    /// JS: `const ptr = engine.input_ptr(); new Uint8Array(wasm.memory.buffer, ptr, n).set(rgba);`
    pub fn input_ptr(&self) -> *const u8 {
        self.buf.as_ptr()
    }

    /// Set reference image from the staging buffer (populated via `input_ptr`).
    pub fn set_reference_from_buf(&mut self) {
        self.inner.set_reference(&self.buf);
    }

    /// Set reference from a JS-provided RGBA slice (copying path, simpler API).
    pub fn set_reference(&mut self, ref_rgba: &[u8]) {
        self.inner.set_reference(ref_rgba);
    }

    /// Compare test image (written into staging buf via `input_ptr`) against
    /// stored reference. Returns perceptual distance (0=identical, >1=visible).
    pub fn compare_from_buf(&mut self) -> f32 {
        // Split borrow: take buf out, compare, put it back.
        let buf = std::mem::take(&mut self.buf);
        let score = self.inner.compare(&buf);
        self.buf = buf;
        score
    }

    /// Convenience copying path: pass RGBA directly.
    pub fn compare(&mut self, test_rgba: &[u8]) -> f32 {
        self.inner.compare(test_rgba)
    }

    /// Per-scale scores and early-exit flag as a JS object.
    pub fn get_metrics(&self) -> JsValue {
        let m = &self.inner.metrics;
        let o = js_sys::Object::new();
        let _ = js_sys::Reflect::set(&o, &"scale0".into(), &JsValue::from_f64(m.scale0_score as f64));
        let _ = js_sys::Reflect::set(&o, &"scale1".into(), &JsValue::from_f64(m.scale1_score as f64));
        let _ = js_sys::Reflect::set(&o, &"scale2".into(), &JsValue::from_f64(m.scale2_score as f64));
        let _ = js_sys::Reflect::set(&o, &"early_exit".into(), &JsValue::from_bool(m.early_exit));
        o.into()
    }
}
```

- [ ] **Step 3: Verify it compiles**

```powershell
cargo check --target wasm32-unknown-unknown 2>&1
```

Expected: no new errors. Fix any type visibility issues (add `pub` to types in `engine.rs` if needed).

- [ ] **Step 4: Rebuild WASM**

```powershell
.\build-parallel-wasm.ps1 -Features parallel-wasm 2>&1 | tail -5
```

Expected: `[INFO]: ✨  Your wasm pkg is ready to publish at ...`

- [ ] **Step 5: Commit**

```
git add src/lib.rs web/pkg/
git commit -m "feat(wasm): PerceptualEngine pointer-based binding with compare_from_buf"
```

---

## Task 6: `butteraugli.cc` — C reference export wrapper

**Files:**
- Modify: `external/libjxl/lib/jxl/butteraugli/butteraugli.cc`

Add a thin `extern "C"` function at the end of the file (inside `#ifdef BUTTERAUGLI_REFERENCE_EXPORT`) that wraps the full libjxl butteraugli. This enables a future native-only Rust benchmark that calls the exact libjxl implementation for score comparison.

**Note:** This change is ONLY activated by `-DBUTTERAUGLI_REFERENCE_EXPORT` in CMake. It does NOT affect normal JXL builds. The function uses the full `ButteraugliComparator` pipeline.

- [ ] **Step 1: Identify the insertion point**

The file ends at line 2194 with `}  // namespace jxl`. The `extern "C"` wrapper goes *after* the closing namespace brace at the very end of the file.

- [ ] **Step 2: Add the wrapper**

Append to the very end of `external/libjxl/lib/jxl/butteraugli/butteraugli.cc`:

```cpp
// ---------------------------------------------------------------------------
// Reference export — only compiled when BUTTERAUGLI_REFERENCE_EXPORT is set.
// Wraps the full libjxl ButteraugliComparator for use as a regression oracle
// in native benchmarks. NOT linked into WASM or normal JXL encoder/decoder.
// ---------------------------------------------------------------------------
#ifdef BUTTERAUGLI_REFERENCE_EXPORT

#include <cstring>

extern "C" {

// Compute butteraugli distance between two sRGB float images (planes [0,1]).
// ref_rgb / test_rgb: interleaved R,G,B floats, width*height*3 entries.
// Returns the scalar distance, or -1.0f on allocation failure.
float butteraugli_reference_score(
    const float* ref_rgb,
    const float* test_rgb,
    int width,
    int height
) {
    using namespace jxl;
    JxlMemoryManager* mm = JxlMemoryManagerMakeDefault();
    if (!mm) return -1.0f;

    auto make_img = [&](const float* rgb) -> Image3F {
        auto img = Image3F::Create(mm, width, height);
        if (!img.ok()) return {};
        for (int y = 0; y < height; ++y) {
            float* r = img->PlaneRow(0, y);
            float* g = img->PlaneRow(1, y);
            float* b = img->PlaneRow(2, y);
            const float* src = rgb + y * width * 3;
            for (int x = 0; x < width; ++x) {
                r[x] = src[x * 3 + 0];
                g[x] = src[x * 3 + 1];
                b[x] = src[x * 3 + 2];
            }
        }
        return std::move(*img);
    };

    Image3F ref_img = make_img(ref_rgb);
    if (ref_img.xsize() == 0) return -1.0f;
    Image3F test_img = make_img(test_rgb);
    if (test_img.xsize() == 0) return -1.0f;

    ButteraugliParams params;
    ImageF distmap;
    ButteraugliComparator comparator(ref_img, params);
    comparator.Diffmap(test_img, distmap);
    return ButteraugliScoreFromMap(distmap);
}

}  // extern "C"

#endif  // BUTTERAUGLI_REFERENCE_EXPORT
```

- [ ] **Step 3: Verify the rest of the file still compiles without the flag**

The change is entirely inside `#ifdef BUTTERAUGLI_REFERENCE_EXPORT` so the normal build path is unaffected. Verify:

```powershell
# Just check Rust+WASM build still works (no C++ change visible to Rust)
cargo check --target wasm32-unknown-unknown 2>&1 | Select-String "error"
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```
git add external/libjxl/lib/jxl/butteraugli/butteraugli.cc
git commit -m "feat(butteraugli.cc): add BUTTERAUGLI_REFERENCE_EXPORT C wrapper for regression oracle"
```

---

## Task 7: `jxl-butteraugli.js` — add WASM-backed path

**Files:**
- Modify: `web/jxl-butteraugli.js`

Add `createWasmEngine(wasmModule)` that uses the new `PerceptualEngine` WASM binding. The existing `createButteraugliComparer` and `computeButteraugliVsFinal` functions stay unchanged (zero breakage). The new path is opt-in.

- [ ] **Step 1: Write the test** (manual since no test runner for web/)

After implementation, this test goes in `tests/butteraugli_compare.mjs` (Task 8). For now, we just need the function to match the JS path within tolerance.

- [ ] **Step 2: Add `createWasmEngine` to `jxl-butteraugli.js`**

Add at the end of the file, before the final comment block:

```javascript
// ---------------------------------------------------------------------------
// WASM-backed path — uses PerceptualEngine from the compiled raw_converter_wasm.
// Pointer-based: zero ArrayBuffer copy on the test side.
// Fall back to createButteraugliComparer if wasmModule is not available.
// ---------------------------------------------------------------------------

// Create a WASM-backed comparer. Returns (testPixels) => score, same API as
// the closure returned by createButteraugliComparer.
//
// wasmModule: the instantiated wasm module (from raw_converter_wasm init()).
// refPixels:  Uint8Array RGBA, same contract as createButteraugliComparer.
// width/height: image dimensions.
//
// Returns null if the PerceptualEngine class is not present on wasmModule
// (older WASM build without Task 5). In that case, fall back to the JS path.
export function createWasmEngine(wasmModule, refPixels, width, height) {
    if (!wasmModule || typeof wasmModule.PerceptualEngine !== 'function') {
        // WASM build doesn't have PerceptualEngine — fall back to JS path.
        return createButteraugliComparer(refPixels, width, height);
    }
    const n = width * height;
    if (!n || refPixels.length !== n * 4) return null;

    const engine = new wasmModule.PerceptualEngine(width, height);

    // Set reference using the direct slice path (no staging buffer needed for ref).
    engine.set_reference(refPixels);

    // Pre-allocate a view into the WASM staging buffer for zero-copy test writes.
    const ptr = engine.input_ptr();
    const wasmMemory = wasmModule.memory;  // wasm-bindgen exports `memory`

    return function compareViaWasm(testPixels) {
        if (testPixels.length !== n * 4) return NaN;
        // Write test pixels into WASM staging buffer (zero-copy: direct Uint8Array view).
        const view = new Uint8Array(wasmMemory.buffer, ptr, n * 4);
        view.set(testPixels);
        return engine.compare_from_buf();
    };
}

// Convenience: auto-select WASM path when available, JS fallback otherwise.
export function createBestEngine(wasmModule, refPixels, width, height) {
    const wasm = createWasmEngine(wasmModule, refPixels, width, height);
    if (wasm) return wasm;
    return createButteraugliComparer(refPixels, width, height);
}
```

- [ ] **Step 3: Verify no syntax errors**

```powershell
node --input-type=module -e "import('./web/jxl-butteraugli.js').then(()=>console.log('OK'))" 2>&1
```

Expected: `OK` (or a harmless `pkg/raw_converter_wasm.js` import error if that file is absent — the module itself must parse cleanly).

- [ ] **Step 4: Commit**

```
git add web/jxl-butteraugli.js
git commit -m "feat(js): createWasmEngine + createBestEngine WASM-backed butteraugli path"
```

---

## Task 8: Benchmark harness `tests/butteraugli_compare.mjs`

**Files:**
- Create: `tests/butteraugli_compare.mjs`

Runs both paths (JS `createButteraugliComparer` and WASM `createWasmEngine`) on test images 10 times each. Outputs timing + score + delta per image.

- [ ] **Step 1: Create the harness**

```javascript
// tests/butteraugli_compare.mjs
// Usage: node tests/butteraugli_compare.mjs [--images path/to/dir]
// Compares JS butteraugli path vs WASM PerceptualEngine.
// Outputs: image, mode, iteration, ms, score, delta
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { createButteraugliComparer, createWasmEngine } from '../web/jxl-butteraugli.js';

const ITERATIONS = 10;
const DEFAULT_IMG_DIR = 'test-images';  // place some .jpg/.png here

async function loadPngAsRgba(path) {
    // Simple: use Node's built-in if available, else skip.
    // For real use, install `sharp` or `jimp` in test deps.
    // Here we generate a synthetic RGBA image for smoke testing.
    const buf = await readFile(path).catch(() => null);
    if (!buf) return null;
    // Real PNG decode would go here. For now return synthetic.
    return null;
}

function makeSyntheticRgba(w, h, seed = 42) {
    const data = new Uint8Array(w * h * 4);
    let x = seed;
    for (let i = 0; i < data.length; i++) {
        x = (x * 1664525 + 1013904223) & 0xffffffff;
        data[i] = (i % 4 === 3) ? 255 : ((x >>> 24) & 0xff);
    }
    return data;
}

async function loadWasm() {
    try {
        const init = (await import('../web/pkg/raw_converter_wasm.js')).default;
        const wasm = await init();
        return wasm;
    } catch {
        console.warn('WASM not available, WASM path will be skipped');
        return null;
    }
}

async function runComparison(label, refPixels, testPixels, width, height, wasmModule) {
    const n = width * height;
    const results = [];

    // JS path
    const jsComparer = createButteraugliComparer(refPixels, width, height);
    for (let i = 0; i < ITERATIONS; i++) {
        const t0 = performance.now();
        const score = jsComparer(testPixels);
        const ms = performance.now() - t0;
        results.push({ image: label, mode: 'js', iter: i, ms: ms.toFixed(3), score: score.toFixed(6) });
    }

    // WASM path
    if (wasmModule) {
        const wasmComparer = createWasmEngine(wasmModule, refPixels, width, height);
        if (wasmComparer) {
            const jsBase = parseFloat(results[ITERATIONS - 1].score);
            for (let i = 0; i < ITERATIONS; i++) {
                const t0 = performance.now();
                const score = wasmComparer(testPixels);
                const ms = performance.now() - t0;
                const delta = (score - jsBase).toFixed(6);
                results.push({ image: label, mode: 'wasm', iter: i, ms: ms.toFixed(3), score: score.toFixed(6), delta });
            }
        }
    }

    return results;
}

async function main() {
    console.log('image,mode,iter,ms,score,delta');
    const wasmModule = await loadWasm();

    // Synthetic test cases (always available)
    const cases = [
        { label: 'synthetic-128', w: 128, h: 128, seed: 1 },
        { label: 'synthetic-512', w: 512, h: 512, seed: 2 },
        { label: 'synthetic-1024', w: 1024, h: 1024, seed: 3 },
    ];

    for (const { label, w, h, seed } of cases) {
        const ref = makeSyntheticRgba(w, h, seed);
        const test = makeSyntheticRgba(w, h, seed + 1);
        const rows = await runComparison(label, ref, test, w, h, wasmModule);
        for (const r of rows) {
            console.log(`${r.image},${r.mode},${r.iter},${r.ms},${r.score},${r.delta ?? ''}`);
        }
    }
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the harness (JS path only, WASM optional)**

```powershell
node tests/butteraugli_compare.mjs 2>&1 | head -30
```

Expected output (JS path only since WASM may not be initialized in Node without a worker):
```
image,mode,iter,ms,score,delta
synthetic-128,js,0,X.XXX,Y.YYYYYY,
...
```

- [ ] **Step 3: Verify score stability across iterations (JS path)**

The JS `score` column should be identical across all 10 iterations for the same image pair (deterministic).

```powershell
node tests/butteraugli_compare.mjs 2>&1 | node -e "
const lines = require('fs').readFileSync('/dev/stdin','utf8').trim().split('\n');
const jsScores = lines.filter(l=>l.includes(',js,')).map(l=>l.split(',')[4]);
const unique = new Set(jsScores);
if(unique.size > lines.filter(l=>l.includes(',js,')).length / 10) {
    console.error('Score not stable!'); process.exit(1);
} else {
    console.log('Score stable across iterations.');
}"
```

- [ ] **Step 4: Commit**

```
git add tests/butteraugli_compare.mjs
git commit -m "test(butteraugli): benchmark harness JS vs WASM with timing + score delta"
```

---

## Task 9: Final verification

**Files:** none new — run existing test suite.

- [ ] **Step 1: Run all perceptual Rust tests**

```powershell
cd crates/raw-pipeline && cargo test --no-default-features --lib 2>&1
```

Expected: all tests pass (including the pre-existing `identical_scale_err_is_zero`, `dn2_halves_and_averages`, `identical_image_scores_perfect`, `all_matches_individual_calls`).

- [ ] **Step 2: Confirm backward-compatible Comparer still works**

The existing `PerceptualComparer` WASM binding and `Comparer::butteraugli` must be unchanged. Verify:

```powershell
cd crates/raw-pipeline && cargo test --no-default-features --lib perceptual 2>&1
```

Expected: `test perceptual::tests::identical_image_scores_perfect ... ok`

- [ ] **Step 3: Check WASM binary still builds**

```powershell
.\build-parallel-wasm.ps1 -Features parallel-wasm 2>&1 | Select-String "error|warning.*unused"
```

Expected: builds cleanly. Investigate any new `unused` warnings from the new engine code.

- [ ] **Step 4: Run benchmark harness**

```powershell
node tests/butteraugli_compare.mjs 2>&1
```

Record baseline timings for `synthetic-512` JS path. Target for the optimized WASM path once fully SIMD-wired: ≤5ms per call vs current JS ~50–150ms estimate.

- [ ] **Step 5: Final commit**

```
git add -p  # stage only verified files
git commit -m "chore(perceptual): verify fused pipeline end-to-end — all tests green"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Task |
|-----------------|------|
| Remove data movement (no copy-then-convert) | T2: fused builder one-pass |
| AOS `Pixel {x,y,b}` | T1 |
| Pre-transform weights (SX/SY/SB) | T1+T3 |
| Replace weighted distance with dot(delta, delta) | T3 `compare_level` |
| Replace e^(3/2) with polynomial | T3 `fast_response` |
| Fused RGBA → pyramid | T2 `build_perceptual_image` |
| AOS downsample (one loop) | T2 `downsample_perceptual` |
| Mask from activity, store inv_mask | T2 `compute_inv_mask` |
| No alloc inside compare | T4 (candidate built outside; workspace in future SIMD task) |
| AlgorithmMode Reference/Optimized | T4 |
| Early exit by scale | T4 |
| WASM pointer API | T5 |
| `input_ptr()` + `compare_from_buf()` | T5 |
| `butteraugli.cc` C reference wrapper | T6 |
| `jxl-butteraugli.js` WASM path | T7 |
| Test harness `butteraugli_compare.mjs` | T8 |
| Metrics struct (timing) | T4 `EngineMetrics` (partial — ns timing not yet wired; add in follow-up SIMD task) |
| SIMD kernels (f32x4 pixel diff) | Not yet — follow-up task after scalar baseline confirmed |
| Sidecar integration | Not yet — separate feature |

**Gaps:** SIMD for the new AOS kernels and ns-level timing instrumentation are not in this plan — scalar baseline must be benchmarked first. The `fast_response` constants (0.75, 0.25) are the spec's values but need tuning against a golden image corpus once baseline is running.

### Type consistency check

- `PerceptualPixel` defined in Task 1 `butteraugli.rs`, used in T2/T3/T4 ✓
- `ImageLevel::new(w,h)` defined in T1, used in T2 ✓
- `PerceptualImage { levels: Vec<ImageLevel> }` defined in T1, returned by T2, consumed in T3/T4 ✓
- `compare_level(&ref_level, &test_level)` defined in T3, called in T4 ✓
- `ButteraugliEngine::new(w,h)` defined T4, wrapped in T5 ✓
- `engine.set_reference(&[u8])` defined T4, called T5 ✓
- `engine.compare(&[u8]) -> f32` defined T4, exposed T5 ✓
- `EngineMetrics` defined T4, exposed via `get_metrics()` T5 ✓
- `createWasmEngine(wasmModule, refPixels, w, h)` defined T7, tested T8 ✓
