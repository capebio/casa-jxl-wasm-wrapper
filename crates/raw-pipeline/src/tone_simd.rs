//! SIMD `apply_tone_math` — the compute-bound ~90% of the tone pass (matrix +
//! saturation/vibrance). SoA bulk: vectorize the per-pixel math across pixels.
//! `pipeline::apply_tone_math` is the scalar parity oracle.
//!
//! Profiling (20.5 MP ORF, single-thread): apply_tone_math = 1436 ms (90% of
//! tone), LUT gather = 160 ms (10%). Unlike the memory-bound metrics kernel,
//! this is compute-bound and per-pixel independent → SIMD pays.
//!
//! Backends, auto-dispatched by `apply_tone_bulk`:
//!   - x86_64 AVX2+FMA (8-wide)
//!   - wasm32 SIMD128 `f32x4` (4-wide; wasm ships `+simd128`) — the shipping target
//!   - branchless scalar fallback that LLVM autovectorizes (SSE/NEON/baseline wasm)
//!
//! Algebra (folded once on the host): `vib6 = vib*0.6`, `c1 = sat*(1+vib6)`,
//! `c2 = sat*vib6`. Then `scale = c1 - c2*psat`, and per-pixel saturation is
//! `psat = 1 - mn/mx` (masked to 0 when `raw_mx <= 0`) — provably in [0,1] for
//! `raw_mx > 0`, so no clamp. Blend is the lerp `luma + (x-luma)*scale`. All forms
//! are algebraically equal to the oracle within the SIMD reassociation tolerance
//! (parity tests assert ≤0.05 abs OR <1e-3 rel).

#[allow(unused_imports)]
use crate::pipeline::apply_tone_math;

const LUMA_R: f32 = 0.2126;
const LUMA_G: f32 = 0.7152;
const LUMA_B: f32 = 0.0722;

/// Oracle-equivalent tone math for one pixel, const-generic over `vib_zero` so the
/// scalar loop monomorphizes (no per-iter branch) and stays branchless inside —
/// letting LLVM autovectorize the SoA loop on targets without a hand kernel.
/// `c1 = sat*(1+vib*0.6)`, `c2 = sat*vib*0.6` (folded once by the caller).
#[inline(always)]
fn tone_one<const VIB_ZERO: bool>(
    rr: f32, gg: f32, bb: f32, m: &[[f32; 3]; 3], sat: f32, c1: f32, c2: f32,
) -> (f32, f32, f32) {
    let r2 = m[0][0].mul_add(rr, m[0][1].mul_add(gg, m[0][2] * bb));
    let g2 = m[1][0].mul_add(rr, m[1][1].mul_add(gg, m[1][2] * bb));
    let b2 = m[2][0].mul_add(rr, m[2][1].mul_add(gg, m[2][2] * bb));
    let luma = LUMA_R.mul_add(r2, LUMA_G.mul_add(g2, LUMA_B * b2));
    let scale = if VIB_ZERO {
        sat
    } else {
        let raw_mx = r2.max(g2).max(b2);
        let mx = raw_mx.max(1.0);
        let mn = r2.min(g2).min(b2).max(0.0);
        // psat = 1 - mn/mx ∈ [0,1] for raw_mx>0; branchless mask zeroes the raw_mx<=0 case.
        let psat = (1.0 - mn / mx) * ((raw_mx > 0.0) as u32 as f32);
        c1 - c2 * psat
    };
    (
        scale.mul_add(r2 - luma, luma),
        scale.mul_add(g2 - luma, luma),
        scale.mul_add(b2 - luma, luma),
    )
}

/// In-place SoA tone math over `r`/`g`/`b`. Dispatches AVX2+FMA (x86_64), SIMD128
/// (wasm32), else the branchless scalar path. Length is clamped to the shortest
/// slice so a misuse can't read out of bounds in the unsafe kernels.
#[inline]
pub fn apply_tone_bulk(
    r: &mut [f32],
    g: &mut [f32],
    b: &mut [f32],
    m: &[[f32; 3]; 3],
    sat: f32,
    vib: f32,
    vib_zero: bool,
) {
    let n = r.len().min(g.len()).min(b.len());
    debug_assert_eq!(g.len(), r.len());
    debug_assert_eq!(b.len(), r.len());
    #[cfg(target_arch = "x86_64")]
    {
        if std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma") {
            unsafe { apply_tone_bulk_avx2(r, g, b, m, sat, vib, vib_zero, n) };
            return;
        }
    }
    // wasm32 ships with `+simd128` (see .cargo/config.toml) so the SIMD128 body
    // is always valid — no runtime detect needed (same idiom as demosaic.rs).
    #[cfg(target_arch = "wasm32")]
    {
        apply_tone_bulk_wasm(r, g, b, m, sat, vib, vib_zero, n);
        return;
    }
    #[allow(unreachable_code)]
    apply_tone_bulk_scalar(r, g, b, m, sat, vib, vib_zero, n);
}

/// Scalar-forced bulk (the branchless parity path), exposed for benchmarking against
/// the SIMD path. Production callers use `apply_tone_bulk` (auto-dispatches).
pub fn apply_tone_bulk_ref(
    r: &mut [f32], g: &mut [f32], b: &mut [f32],
    m: &[[f32; 3]; 3], sat: f32, vib: f32, vib_zero: bool,
) {
    let n = r.len().min(g.len()).min(b.len());
    apply_tone_bulk_scalar(r, g, b, m, sat, vib, vib_zero, n);
}

#[inline]
fn apply_tone_bulk_scalar(
    r: &mut [f32], g: &mut [f32], b: &mut [f32],
    m: &[[f32; 3]; 3], sat: f32, vib: f32, vib_zero: bool, n: usize,
) {
    let vib6 = vib * 0.6;
    let (c1, c2) = (sat * (1.0 + vib6), sat * vib6);
    if vib_zero {
        for i in 0..n {
            let (nr, ng, nb) = tone_one::<true>(r[i], g[i], b[i], m, sat, c1, c2);
            r[i] = nr; g[i] = ng; b[i] = nb;
        }
    } else {
        for i in 0..n {
            let (nr, ng, nb) = tone_one::<false>(r[i], g[i], b[i], m, sat, c1, c2);
            r[i] = nr; g[i] = ng; b[i] = nb;
        }
    }
}

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
    let one = _mm256_set1_ps(1.0);
    let zero = _mm256_setzero_ps();

    let lanes = n / 8 * 8;
    let mut i = 0;
    if vib_zero && sat == 1.0 {
        // saturation identity → matrix only (no luma/blend).
        while i < lanes {
            let vr = _mm256_loadu_ps(r.as_ptr().add(i));
            let vg = _mm256_loadu_ps(g.as_ptr().add(i));
            let vb = _mm256_loadu_ps(b.as_ptr().add(i));
            let r2 = _mm256_fmadd_ps(m00, vr, _mm256_fmadd_ps(m01, vg, _mm256_mul_ps(m02, vb)));
            let g2 = _mm256_fmadd_ps(m10, vr, _mm256_fmadd_ps(m11, vg, _mm256_mul_ps(m12, vb)));
            let b2 = _mm256_fmadd_ps(m20, vr, _mm256_fmadd_ps(m21, vg, _mm256_mul_ps(m22, vb)));
            _mm256_storeu_ps(r.as_mut_ptr().add(i), r2);
            _mm256_storeu_ps(g.as_mut_ptr().add(i), g2);
            _mm256_storeu_ps(b.as_mut_ptr().add(i), b2);
            i += 8;
        }
    } else if vib_zero {
        let vsat = _mm256_set1_ps(sat);
        while i < lanes {
            let vr = _mm256_loadu_ps(r.as_ptr().add(i));
            let vg = _mm256_loadu_ps(g.as_ptr().add(i));
            let vb = _mm256_loadu_ps(b.as_ptr().add(i));
            let r2 = _mm256_fmadd_ps(m00, vr, _mm256_fmadd_ps(m01, vg, _mm256_mul_ps(m02, vb)));
            let g2 = _mm256_fmadd_ps(m10, vr, _mm256_fmadd_ps(m11, vg, _mm256_mul_ps(m12, vb)));
            let b2 = _mm256_fmadd_ps(m20, vr, _mm256_fmadd_ps(m21, vg, _mm256_mul_ps(m22, vb)));
            let luma = _mm256_fmadd_ps(lr, r2, _mm256_fmadd_ps(lg, g2, _mm256_mul_ps(lb, b2)));
            let nr = _mm256_fmadd_ps(vsat, _mm256_sub_ps(r2, luma), luma);
            let ng = _mm256_fmadd_ps(vsat, _mm256_sub_ps(g2, luma), luma);
            let nb = _mm256_fmadd_ps(vsat, _mm256_sub_ps(b2, luma), luma);
            _mm256_storeu_ps(r.as_mut_ptr().add(i), nr);
            _mm256_storeu_ps(g.as_mut_ptr().add(i), ng);
            _mm256_storeu_ps(b.as_mut_ptr().add(i), nb);
            i += 8;
        }
    } else {
        let vib6 = vib * 0.6;
        let c1 = _mm256_set1_ps(sat * (1.0 + vib6));
        let neg_c2 = _mm256_set1_ps(-(sat * vib6));
        while i < lanes {
            let vr = _mm256_loadu_ps(r.as_ptr().add(i));
            let vg = _mm256_loadu_ps(g.as_ptr().add(i));
            let vb = _mm256_loadu_ps(b.as_ptr().add(i));
            let r2 = _mm256_fmadd_ps(m00, vr, _mm256_fmadd_ps(m01, vg, _mm256_mul_ps(m02, vb)));
            let g2 = _mm256_fmadd_ps(m10, vr, _mm256_fmadd_ps(m11, vg, _mm256_mul_ps(m12, vb)));
            let b2 = _mm256_fmadd_ps(m20, vr, _mm256_fmadd_ps(m21, vg, _mm256_mul_ps(m22, vb)));
            let luma = _mm256_fmadd_ps(lr, r2, _mm256_fmadd_ps(lg, g2, _mm256_mul_ps(lb, b2)));
            let raw_mx = _mm256_max_ps(_mm256_max_ps(r2, g2), b2);
            let mx = _mm256_max_ps(raw_mx, one);
            let mn = _mm256_max_ps(_mm256_min_ps(_mm256_min_ps(r2, g2), b2), zero);
            let inv = _mm256_div_ps(one, mx);
            // psat = (1 - mn*inv), masked to 0 where raw_mx <= 0. No clamp needed.
            let psat = _mm256_and_ps(
                _mm256_fnmadd_ps(mn, inv, one),
                _mm256_cmp_ps::<_CMP_GT_OQ>(raw_mx, zero),
            );
            let scale = _mm256_fmadd_ps(neg_c2, psat, c1);
            let nr = _mm256_fmadd_ps(scale, _mm256_sub_ps(r2, luma), luma);
            let ng = _mm256_fmadd_ps(scale, _mm256_sub_ps(g2, luma), luma);
            let nb = _mm256_fmadd_ps(scale, _mm256_sub_ps(b2, luma), luma);
            _mm256_storeu_ps(r.as_mut_ptr().add(i), nr);
            _mm256_storeu_ps(g.as_mut_ptr().add(i), ng);
            _mm256_storeu_ps(b.as_mut_ptr().add(i), nb);
            i += 8;
        }
    }
    // scalar tail via the oracle → guaranteed parity on the ragged end.
    while i < n {
        let (r2, g2, b2) = apply_tone_math(r[i], g[i], b[i], m, sat, vib, vib_zero, false);
        r[i] = r2; g[i] = g2; b[i] = b2;
        i += 1;
    }
}

/// wasm32 SIMD128 (`f32x4`) bulk tone math — the wasm peer of `apply_tone_bulk_avx2`.
/// Baseline simd128 has no fused multiply-add intrinsic; `mul`+`add` is used, which
/// stays inside the same reassociation tolerance the parity tests assert.
#[cfg(target_arch = "wasm32")]
fn apply_tone_bulk_wasm(
    r: &mut [f32], g: &mut [f32], b: &mut [f32],
    m: &[[f32; 3]; 3], sat: f32, vib: f32, vib_zero: bool, n: usize,
) {
    use core::arch::wasm32::*;
    let (m00, m01, m02) = (f32x4_splat(m[0][0]), f32x4_splat(m[0][1]), f32x4_splat(m[0][2]));
    let (m10, m11, m12) = (f32x4_splat(m[1][0]), f32x4_splat(m[1][1]), f32x4_splat(m[1][2]));
    let (m20, m21, m22) = (f32x4_splat(m[2][0]), f32x4_splat(m[2][1]), f32x4_splat(m[2][2]));
    let (lr, lg, lb) = (f32x4_splat(LUMA_R), f32x4_splat(LUMA_G), f32x4_splat(LUMA_B));
    let one = f32x4_splat(1.0);
    let zero = f32x4_splat(0.0);

    let lanes = n / 4 * 4;
    let mut i = 0;
    unsafe {
        if vib_zero && sat == 1.0 {
            while i < lanes {
                let vr = v128_load(r.as_ptr().add(i) as *const v128);
                let vg = v128_load(g.as_ptr().add(i) as *const v128);
                let vb = v128_load(b.as_ptr().add(i) as *const v128);
                let r2 = f32x4_add(f32x4_mul(m00, vr), f32x4_add(f32x4_mul(m01, vg), f32x4_mul(m02, vb)));
                let g2 = f32x4_add(f32x4_mul(m10, vr), f32x4_add(f32x4_mul(m11, vg), f32x4_mul(m12, vb)));
                let b2 = f32x4_add(f32x4_mul(m20, vr), f32x4_add(f32x4_mul(m21, vg), f32x4_mul(m22, vb)));
                v128_store(r.as_mut_ptr().add(i) as *mut v128, r2);
                v128_store(g.as_mut_ptr().add(i) as *mut v128, g2);
                v128_store(b.as_mut_ptr().add(i) as *mut v128, b2);
                i += 4;
            }
        } else if vib_zero {
            let vsat = f32x4_splat(sat);
            while i < lanes {
                let vr = v128_load(r.as_ptr().add(i) as *const v128);
                let vg = v128_load(g.as_ptr().add(i) as *const v128);
                let vb = v128_load(b.as_ptr().add(i) as *const v128);
                let r2 = f32x4_add(f32x4_mul(m00, vr), f32x4_add(f32x4_mul(m01, vg), f32x4_mul(m02, vb)));
                let g2 = f32x4_add(f32x4_mul(m10, vr), f32x4_add(f32x4_mul(m11, vg), f32x4_mul(m12, vb)));
                let b2 = f32x4_add(f32x4_mul(m20, vr), f32x4_add(f32x4_mul(m21, vg), f32x4_mul(m22, vb)));
                let luma = f32x4_add(f32x4_mul(lr, r2), f32x4_add(f32x4_mul(lg, g2), f32x4_mul(lb, b2)));
                let nr = f32x4_add(luma, f32x4_mul(vsat, f32x4_sub(r2, luma)));
                let ng = f32x4_add(luma, f32x4_mul(vsat, f32x4_sub(g2, luma)));
                let nb = f32x4_add(luma, f32x4_mul(vsat, f32x4_sub(b2, luma)));
                v128_store(r.as_mut_ptr().add(i) as *mut v128, nr);
                v128_store(g.as_mut_ptr().add(i) as *mut v128, ng);
                v128_store(b.as_mut_ptr().add(i) as *mut v128, nb);
                i += 4;
            }
        } else {
            let vib6 = vib * 0.6;
            let c1 = f32x4_splat(sat * (1.0 + vib6));
            let neg_c2 = f32x4_splat(-(sat * vib6));
            while i < lanes {
                let vr = v128_load(r.as_ptr().add(i) as *const v128);
                let vg = v128_load(g.as_ptr().add(i) as *const v128);
                let vb = v128_load(b.as_ptr().add(i) as *const v128);
                let r2 = f32x4_add(f32x4_mul(m00, vr), f32x4_add(f32x4_mul(m01, vg), f32x4_mul(m02, vb)));
                let g2 = f32x4_add(f32x4_mul(m10, vr), f32x4_add(f32x4_mul(m11, vg), f32x4_mul(m12, vb)));
                let b2 = f32x4_add(f32x4_mul(m20, vr), f32x4_add(f32x4_mul(m21, vg), f32x4_mul(m22, vb)));
                let luma = f32x4_add(f32x4_mul(lr, r2), f32x4_add(f32x4_mul(lg, g2), f32x4_mul(lb, b2)));
                let raw_mx = f32x4_max(f32x4_max(r2, g2), b2);
                let mx = f32x4_max(raw_mx, one);
                let mn = f32x4_max(f32x4_min(f32x4_min(r2, g2), b2), zero);
                let inv = f32x4_div(one, mx);
                // psat = (1 - mn*inv), masked to 0 where raw_mx <= 0. No clamp needed.
                let psat = v128_and(f32x4_sub(one, f32x4_mul(mn, inv)), f32x4_gt(raw_mx, zero));
                let scale = f32x4_add(c1, f32x4_mul(neg_c2, psat));
                let nr = f32x4_add(luma, f32x4_mul(scale, f32x4_sub(r2, luma)));
                let ng = f32x4_add(luma, f32x4_mul(scale, f32x4_sub(g2, luma)));
                let nb = f32x4_add(luma, f32x4_mul(scale, f32x4_sub(b2, luma)));
                v128_store(r.as_mut_ptr().add(i) as *mut v128, nr);
                v128_store(g.as_mut_ptr().add(i) as *mut v128, ng);
                v128_store(b.as_mut_ptr().add(i) as *mut v128, nb);
                i += 4;
            }
        }
    }
    // scalar tail via the oracle → guaranteed parity.
    while i < n {
        let (r2, g2, b2) = apply_tone_math(r[i], g[i], b[i], m, sat, vib, vib_zero, false);
        r[i] = r2; g[i] = g2; b[i] = b2;
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

    fn ok(a: f32, b: f32) -> bool {
        // Tone values live in the 0..65535 post-LUT-index domain; an absolute diff
        // < 1.0 can't move the output past the adjacent LUT entry. FMA reassociation
        // noise is ~0.005 abs, so |Δ| < 0.05 (10× noise) OR rel < 1e-3 is the real
        // parity criterion — a true logic error would diverge far past it.
        (a - b).abs() < 0.05 || (a - b).abs() / a.abs().max(b.abs()).max(1e-6) < 1e-3
    }

    fn oracle(r: &[f32], g: &[f32], b: &[f32], m: &[[f32; 3]; 3], sat: f32, vib: f32, vib_zero: bool)
        -> (Vec<f32>, Vec<f32>, Vec<f32>) {
        let (mut sr, mut sg, mut sb) = (r.to_vec(), g.to_vec(), b.to_vec());
        for i in 0..r.len() {
            let (r2, g2, b2) = apply_tone_math(sr[i], sg[i], sb[i], m, sat, vib, vib_zero, false);
            sr[i] = r2; sg[i] = g2; sb[i] = b2;
        }
        (sr, sg, sb)
    }

    fn assert_parity(sr: &[f32], sg: &[f32], sb: &[f32], ar: &[f32], ag: &[f32], ab: &[f32]) {
        for i in 0..sr.len() {
            assert!(ok(sr[i], ar[i]), "r[{i}] {} vs {}", sr[i], ar[i]);
            assert!(ok(sg[i], ag[i]), "g[{i}] {} vs {}", sg[i], ag[i]);
            assert!(ok(sb[i], ab[i]), "b[{i}] {} vs {}", sb[i], ab[i]);
        }
    }

    // Auto-dispatched path (SIMD on capable hosts).
    fn check(m: &[[f32; 3]; 3], vib_zero: bool, sat: f32, vib: f32, n: usize) {
        let (r0, g0, b0) = data(n);
        let (sr, sg, sb) = oracle(&r0, &g0, &b0, m, sat, vib, vib_zero);
        let (mut ar, mut ag, mut ab) = (r0.clone(), g0.clone(), b0.clone());
        apply_tone_bulk(&mut ar, &mut ag, &mut ab, m, sat, vib, vib_zero);
        assert_parity(&sr, &sg, &sb, &ar, &ag, &ab);
    }

    // Branchless scalar path explicitly (not reached by check() on SIMD hosts).
    fn check_scalar(m: &[[f32; 3]; 3], vib_zero: bool, sat: f32, vib: f32, n: usize) {
        let (r0, g0, b0) = data(n);
        let (sr, sg, sb) = oracle(&r0, &g0, &b0, m, sat, vib, vib_zero);
        let (mut ar, mut ag, mut ab) = (r0.clone(), g0.clone(), b0.clone());
        apply_tone_bulk_ref(&mut ar, &mut ag, &mut ab, m, sat, vib, vib_zero);
        assert_parity(&sr, &sg, &sb, &ar, &ag, &ab);
    }

    #[test]
    fn parity_vib_zero() { check(&M, true, 1.30, 0.0, 1000); }
    #[test]
    fn parity_vibrance_active() { check(&M, false, 1.30, 0.5, 1000); }
    #[test]
    fn parity_desaturate() { check(&M, false, 0.7, -0.4, 1000); }

    #[test]
    fn parity_identity_fast_path() { check(&M, true, 1.0, 0.0, 1000); }

    #[test]
    fn parity_empty() {
        let mut e: Vec<f32> = vec![];
        let (mut a, mut bb) = (Vec::<f32>::new(), Vec::<f32>::new());
        apply_tone_bulk(&mut a, &mut bb, &mut e, &M, 1.3, 0.5, false);
    }

    #[test]
    fn parity_pure_tail() {
        // n < lane width → only the scalar tail runs.
        check(&M, false, 1.30, 0.5, 3);
        check(&M, false, 1.30, 0.5, 7);
        check(&M, true, 1.0, 0.0, 5);
    }

    #[test]
    fn parity_negative_matrix() {
        // All-negative post-matrix → raw_mx <= 0 → exercises the masked-inv branch
        // that the positive M never reaches.
        const NEG: [[f32; 3]; 3] = [[-1.0, -1.0, -1.0], [-1.0, -1.0, -1.0], [-1.0, -1.0, -1.0]];
        check(&NEG, false, 1.30, 0.5, 64);
        check_scalar(&NEG, false, 1.30, 0.5, 64);
    }

    #[test]
    fn parity_scalar_paths() {
        check_scalar(&M, true, 1.30, 0.0, 1000);
        check_scalar(&M, false, 1.30, 0.5, 1000);
        check_scalar(&M, false, 0.7, -0.4, 1000);
        check_scalar(&M, true, 1.0, 0.0, 1000);
    }
}
