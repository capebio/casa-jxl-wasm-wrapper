//! PSNR (MSE → dB) over packed u8 buffers. Exact integer accumulation.

/// Mean-squared-error PSNR in dB over the full byte buffer (alpha included, to
/// match the legacy JS `computePsnrVsFinal`). Returns +inf for identical inputs.
pub(crate) fn psnr(a: &[u8], b: &[u8]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let mut sum_sq: u64 = 0;
    for i in 0..a.len() {
        let d = a[i] as i32 - b[i] as i32;
        sum_sq += (d * d) as u64;
    }
    if sum_sq == 0 {
        return f32::INFINITY;
    }
    let mse = sum_sq as f64 / a.len() as f64;
    (10.0 * (255.0f64 * 255.0 / mse).log10()) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_is_infinite() {
        let a = [10u8, 20, 30, 255, 40, 50, 60, 255];
        assert_eq!(psnr(&a, &a), f32::INFINITY);
    }

    #[test]
    fn known_mse_matches_formula() {
        // Two pixels, one byte differs by 10 → sum_sq = 100, len = 8, mse = 12.5
        let a = [10u8, 20, 30, 255, 40, 50, 60, 255];
        let mut b = a;
        b[0] = 20; // diff 10
        let expected = 10.0f64 * (255.0f64 * 255.0 / (100.0 / 8.0)).log10();
        assert!((psnr(&a, &b) as f64 - expected).abs() < 1e-3);
    }
}
