//! `ButteraugliEngine`: fused AOS butteraugli evaluator with workspace reuse
//! and `AlgorithmMode` toggle for regression against the scalar reference path.

use super::butteraugli::{build_perceptual_image, compare_level, PerceptualImage};
use super::{Comparer, Opts};

/// Which computation path to use.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AlgorithmMode {
    /// New fused AOS pipeline (fast_response, pre-scaled weights, activity mask).
    Optimized,
    /// Existing SoA `scale_err` via `Comparer` — oracle for regression.
    /// Stores a copy of the reference RGBA for the oracle path.
    Reference,
}

/// Per-run algorithm metrics.
#[derive(Clone, Copy, Debug, Default)]
pub struct EngineMetrics {
    pub scale0_score: f32,
    pub scale1_score: f32,
    pub scale2_score: f32,
    pub early_exit: bool,
}

/// Reusable evaluator. Create once per image dimensions; call `set_reference`
/// once, then `compare` many times without allocating inside the hot path.
pub struct ButteraugliEngine {
    pub mode: AlgorithmMode,
    /// Maximum cumulative score before early exit. `f32::MAX` = no early exit.
    pub early_exit_threshold: f32,
    pub metrics: EngineMetrics,
    width: usize,
    height: usize,
    reference: Option<PerceptualImage>,
    /// Copy of reference RGBA kept only when mode == Reference (regression path).
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

    /// Build reference pyramid from RGBA pixels.
    /// Stores original RGBA when `mode == Reference`.
    pub fn set_reference(&mut self, rgba: &[u8]) {
        debug_assert_eq!(rgba.len(), self.width * self.height * 4);
        if self.mode == AlgorithmMode::Reference {
            self.ref_rgba_oracle = Some(rgba.to_vec());
        } else {
            self.ref_rgba_oracle = None;
        }
        self.reference = Some(build_perceptual_image(rgba, self.width, self.height));
    }

    /// Compare test RGBA against stored reference. Returns NAN if
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
        // Delegate to the existing SoA Comparer. Allocates a new Comparer per call —
        // this path is for correctness checking only, not for performance.
        let mut cmp = Comparer::new(ref_rgba, self.width, self.height, Opts::default());
        cmp.butteraugli(test_rgba)
    }
}

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
        eng.early_exit_threshold = 0.001;
        eng.set_reference(&ref_rgba);
        let score = eng.compare(&test_rgba);
        assert!(score > 0.0);
        assert!(eng.metrics.early_exit, "early_exit flag not set");
    }

    #[test]
    fn engine_reference_mode_matches_comparer() {
        let (w, h) = (8, 8);
        let ref_rgba = solid_rgba(128, 64, 200, w * h);
        let test_rgba = solid_rgba(100, 70, 180, w * h);

        let mut eng = ButteraugliEngine::new(w, h);
        eng.mode = AlgorithmMode::Reference;
        eng.set_reference(&ref_rgba);
        let score_ref = eng.compare(&test_rgba);

        let mut cmp = Comparer::new(&ref_rgba, w, h, Opts::default());
        let score_cmp = cmp.butteraugli(&test_rgba);
        assert!(
            (score_ref - score_cmp).abs() < 1e-5,
            "Reference mode diverges: eng={score_ref} cmp={score_cmp}"
        );
    }
}
