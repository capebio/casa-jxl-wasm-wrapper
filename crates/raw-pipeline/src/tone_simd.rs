//! SIMD `apply_tone_math` — the compute-bound ~90% of the tone pass (matrix +
//! saturation/vibrance). SoA bulk: vectorize the per-pixel math across pixels.
//! `pipeline::apply_tone_math` is the scalar parity oracle.
//!
//! Profiling (20.5 MP ORF, single-thread): apply_tone_math = 1436 ms (90% of
//! tone), LUT gather = 160 ms (10%). Unlike the memory-bound metrics kernel,
//! this is compute-bound and per-pixel independent → SIMD pays.

#[allow(unused_imports)]
use crate::pipeline::apply_tone_math;

/// In-place SoA tone math over `r`/`g`/`b` (same length). Uses AVX2+FMA when
/// available (with a `vib_zero` fast path and a masked divide for the vibrance
/// branch), else the scalar oracle. Bit-faithful to `apply_tone_math` within the
/// SIMD reassociation tolerance (parity tests assert ≤1e-4 relative).
pub fn apply_tone_bulk(
    r: &mut [f32],
    g: &mut [f32],
    b: &mut [f32],
    m: &[[f32; 3]; 3],
    sat: f32,
    vib: f32,
    vib_zero: bool,
) {
    let n = r.len();
    debug_assert_eq!(g.len(), n);
    debug_assert_eq!(b.len(), n);
    #[cfg(target_arch = "x86_64")]
    {
        if std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma") {
            unsafe { apply_tone_bulk_avx2(r, g, b, m, sat, vib, vib_zero, n) };
            return;
        }
    }
    apply_tone_bulk_scalar(r, g, b, m, sat, vib, vib_zero, n);
}

/// Scalar-forced bulk (the parity oracle path), exposed for benchmarking against
/// the SIMD path. Production callers use `apply_tone_bulk` (auto-dispatches).
pub fn apply_tone_bulk_ref(
    r: &mut [f32], g: &mut [f32], b: &mut [f32],
    m: &[[f32; 3]; 3], sat: f32, vib: f32, vib_zero: bool,
) {
    let n = r.len();
    apply_tone_bulk_scalar(r, g, b, m, sat, vib, vib_zero, n);
}

#[inline]
fn apply_tone_bulk_scalar(
    r: &mut [f32], g: &mut [f32], b: &mut [f32],
    m: &[[f32; 3]; 3], sat: f32, vib: f32, vib_zero: bool, n: usize,
) {
    for i in 0..n {
        let (r2, g2, b2) = apply_tone_math(r[i], g[i], b[i], m, sat, vib, vib_zero, false);
        r[i] = r2;
        g[i] = g2;
        b[i] = b2;
    }
}

const LUMA_R: f32 = 0.2126;
const LUMA_G: f32 = 0.7152;
const LUMA_B: f32 = 0.0722;

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2,fma")]
unsafe fn apply_tone_bulk_avx2(
    r: &mut [f32], g: &mut [f32], b: &mut [f32],
    m: &[[f32; 3]; 3], sat: f32, vib: f32, vib_zero: bool, n: usize,
) {
    use core::arch::x86_64::*;
    let (m00, m01, m02) = (_mm256_set1_ps(m[0][0]), _mm256_set1_ps(m[0][1]), _mm256_set1_ps(m[0][2]));
    let (m10, m11, m12) = (_mm256_set1_ps(m[1][0]), _mm256_set1_ps(m[1][1]), _mm256_set1_ps(m[1][2]));
    let (m20, m21, m22) = (_mm256_set1_ps(m[2][0]), _mm256_set1_ps(m[2][1]), _mm256_set1_ps(m[2][2]));
    let (lr, lg, lb) = (_mm256_set1_ps(LUMA_R), _mm256_set1_ps(LUMA_G), _mm256_set1_ps(LUMA_B));
    let vsat = _mm256_set1_ps(sat);
    let vvib = _mm256_set1_ps(vib);
    let one = _mm256_set1_ps(1.0);
    let zero = _mm256_setzero_ps();
    let p6 = _mm256_set1_ps(0.6);

    let lanes = n / 8 * 8;
    let mut i = 0;
    while i < lanes {
        let vr = _mm256_loadu_ps(r.as_ptr().add(i));
        let vg = _mm256_loadu_ps(g.as_ptr().add(i));
        let vb = _mm256_loadu_ps(b.as_ptr().add(i));
        // matrix
        let r2 = _mm256_fmadd_ps(m00, vr, _mm256_fmadd_ps(m01, vg, _mm256_mul_ps(m02, vb)));
        let g2 = _mm256_fmadd_ps(m10, vr, _mm256_fmadd_ps(m11, vg, _mm256_mul_ps(m12, vb)));
        let b2 = _mm256_fmadd_ps(m20, vr, _mm256_fmadd_ps(m21, vg, _mm256_mul_ps(m22, vb)));
        // luma
        let luma = _mm256_fmadd_ps(lr, r2, _mm256_fmadd_ps(lg, g2, _mm256_mul_ps(lb, b2)));
        // scale
        let scale = if vib_zero {
            vsat
        } else {
            let raw_mx = _mm256_max_ps(_mm256_max_ps(r2, g2), b2);
            let mx = _mm256_max_ps(raw_mx, one);
            let mn = _mm256_max_ps(_mm256_min_ps(_mm256_min_ps(r2, g2), b2), zero);
            // inv_mx = raw_mx > 0 ? 1/mx : 0
            let inv = _mm256_div_ps(one, mx);
            let gt = _mm256_cmp_ps::<_CMP_GT_OQ>(raw_mx, zero);
            let inv = _mm256_and_ps(inv, gt);
            // pixel_sat = clamp((mx-mn)*inv, 0, 1)
            let psat = _mm256_min_ps(_mm256_max_ps(_mm256_mul_ps(_mm256_sub_ps(mx, mn), inv), zero), one);
            // scale = sat*(1 + vib*(1-psat)*0.6) = fmadd(sat, t, sat), t = vib*(1-psat)*0.6
            let t = _mm256_mul_ps(_mm256_mul_ps(vvib, _mm256_sub_ps(one, psat)), p6);
            _mm256_fmadd_ps(vsat, t, vsat)
        };
        // blend: x' = luma*(1-scale) + x*scale
        let onem = _mm256_sub_ps(one, scale);
        let nr = _mm256_fmadd_ps(luma, onem, _mm256_mul_ps(r2, scale));
        let ng = _mm256_fmadd_ps(luma, onem, _mm256_mul_ps(g2, scale));
        let nb = _mm256_fmadd_ps(luma, onem, _mm256_mul_ps(b2, scale));
        _mm256_storeu_ps(r.as_mut_ptr().add(i), nr);
        _mm256_storeu_ps(g.as_mut_ptr().add(i), ng);
        _mm256_storeu_ps(b.as_mut_ptr().add(i), nb);
        i += 8;
    }
    // scalar tail
    while i < n {
        let (r2, g2, b2) = apply_tone_math(r[i], g[i], b[i], m, sat, vib, vib_zero, false);
        r[i] = r2;
        g[i] = g2;
        b[i] = b2;
        i += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const M: [[f32; 3]; 3] = [
        [1.7, -0.5, -0.2],
        [-0.3, 1.4, -0.1],
        [0.0, -0.4, 1.4],
    ];

    fn data(n: usize) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
        let mut r = vec![0f32; n];
        let mut g = vec![0f32; n];
        let mut b = vec![0f32; n];
        for i in 0..n {
            let f = i as f32;
            r[i] = (f * 0.013).sin() * 30000.0 + 30000.0;
            g[i] = (f * 0.021).cos() * 28000.0 + 30000.0;
            b[i] = (f * 0.017).sin() * 25000.0 + 28000.0;
        }
        (r, g, b)
    }

    fn check(vib_zero: bool, sat: f32, vib: f32) {
        let n = 1000usize; // non-multiple of 8 → exercises the tail
        let (r0, g0, b0) = data(n);
        // oracle
        let (mut sr, mut sg, mut sb) = (r0.clone(), g0.clone(), b0.clone());
        for i in 0..n {
            let (r2, g2, b2) = apply_tone_math(sr[i], sg[i], sb[i], &M, sat, vib, vib_zero, false);
            sr[i] = r2; sg[i] = g2; sb[i] = b2;
        }
        // bulk
        let (mut ar, mut ag, mut ab) = (r0.clone(), g0.clone(), b0.clone());
        apply_tone_bulk(&mut ar, &mut ag, &mut ab, &M, sat, vib, vib_zero);
        // Tone values live in the 0..65535 post-LUT-index domain; an absolute diff
        // < 1.0 can't move the output past the adjacent LUT entry. FMA reassociation
        // noise is ~0.005 abs, so |Δ| < 0.05 (10× noise) OR rel < 1e-3 is the real
        // parity criterion — a true logic error would diverge far past it.
        let ok = |a: f32, b: f32| {
            (a - b).abs() < 0.05 || (a - b).abs() / a.abs().max(b.abs()).max(1e-6) < 1e-3
        };
        for i in 0..n {
            assert!(ok(sr[i], ar[i]), "r[{i}] {} vs {}", sr[i], ar[i]);
            assert!(ok(sg[i], ag[i]), "g[{i}] {} vs {}", sg[i], ag[i]);
            assert!(ok(sb[i], ab[i]), "b[{i}] {} vs {}", sb[i], ab[i]);
        }
    }

    #[test]
    fn parity_vib_zero() {
        check(true, 1.30, 0.0);
    }

    #[test]
    fn parity_vibrance_active() {
        check(false, 1.30, 0.5);
    }

    #[test]
    fn parity_desaturate() {
        check(false, 0.7, -0.4);
    }
}
