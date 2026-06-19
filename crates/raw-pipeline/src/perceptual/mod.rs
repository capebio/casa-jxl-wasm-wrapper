//! Perceptual image-quality metrics (Butteraugli-approx, SSIM, PSNR).
//! Scalar Rust is the parity oracle; SIMD backends are selected at runtime.
//! See docs/superpowers/specs/2026-06-13-perceptual-metrics-simd-kernel-design.md

mod blur;
pub(crate) mod butteraugli;
mod psnr;
pub(crate) mod ssim;
pub mod telemetry;
pub(crate) mod xyb;
mod simd;
pub use simd::{detect_native, Backend};
// wasm-only: surface the v128 kernels so the bench-wasm harness can A/B them in a
// real wasm runtime (the kernels are arch-gated internally, so this is invisible to
// native builds and adds no native API surface).
#[cfg(target_arch = "wasm32")]
pub use simd::wasm as wasm_kernels;
pub use telemetry::{TelemetryMetrics, RgbHistogram, analyze_fused};

pub use butteraugli::Kweights;

/// Which compute backend to use. `Auto` picks the fastest available at runtime.
/// `ForceScalar` and `Force(id)` exist for the flip-flop bench.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BackendChoice {
    Auto,
    ForceScalar,
    /// Force a specific SIMD path id (see simd::Backend). Ignored if unavailable.
    Force(u8),
}
impl Default for BackendChoice {
    fn default() -> Self {
        BackendChoice::Auto
    }
}

#[derive(Clone)]
pub struct Opts {
    pub weights: [f32; 3],
    pub k: Kweights,
    pub backend: BackendChoice,
}
impl Default for Opts {
    fn default() -> Self {
        Opts { weights: [4.0, 2.0, 1.0], k: Kweights::default(), backend: BackendChoice::Auto }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ChannelMoments {
    pub mus: [f32; 3],
    pub vars: [f32; 3],
    pub ch: usize,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Metrics {
    pub butteraugli: f32,
    pub ssim: f32,
    pub psnr: f32,
    pub moments: ChannelMoments,
}

struct Level {
    x: Vec<f32>,
    y: Vec<f32>,
    b: Vec<f32>,
    mask: Vec<f32>,
    w: usize,
    h: usize,
}

/// Precomputes all reference-side work once; evaluates many test images against it.
pub struct Comparer {
    width: usize,
    height: usize,
    n: usize,
    opts: Opts,
    backend: Backend,
    levels: Vec<Level>,
    ref_rgba: Vec<u8>,
    // SSIM reference autos (per channel, RGBA stride 4)
    ssim_sb: [u64; 3],
    ssim_sbb: [u64; 3],
    // reusable test-side scratch
    tx: Vec<f32>,
    ty: Vec<f32>,
    tb: Vec<f32>,
    dx: Vec<f32>,
    dy: Vec<f32>,
    db: Vec<f32>,
}

impl Comparer {
    pub fn new(ref_rgba: &[u8], width: usize, height: usize, opts: Opts) -> Self {
        // Reject overflowing dimensions before they wrap `n` (the master bound the
        // unsafe SIMD kernels trust). On wasm32 usize is 32-bit, so this is reachable.
        let n = width
            .checked_mul(height)
            .and_then(|n| n.checked_mul(4).map(|_| n))
            .expect("width*height*4 overflows usize");
        assert_eq!(ref_rgba.len(), n * 4, "ref must be RGBA");
        // Build reference XYB pyramid + masks (3 scales, blur radius ~w/64 clamped 1..8).
        let (mut rx, mut ry, mut rb) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
        xyb::pixels_to_xyb(ref_rgba, n, &mut rx, &mut ry, &mut rb);
        let mut levels = Vec::with_capacity(3);
        let (mut w, mut h) = (width, height);
        let (mut cx, mut cy, mut cb) = (rx, ry, rb);
        for s in 0..3 {
            let blur_r = ((w >> 6).max(1)).min(8);
            let mask = blur::box_blur(&cy, w, h, blur_r);
            if s < 2 && w > 1 && h > 1 {
                // Not the last level: clone cx/cy/cb so we can keep using them for dn2.
                levels.push(Level { x: cx.clone(), y: cy.clone(), b: cb.clone(), mask, w, h });
                let dw = (w >> 1).max(1);
                let dh = (h >> 1).max(1);
                let dn = dw * dh;
                // Pre-allocate output buffers and use dn2_into to avoid the hidden
                // allocation inside dn2 (PERC-09: makes allocation explicit at the call site).
                let mut nx = vec![0f32; dn];
                let mut ny = vec![0f32; dn];
                let mut nb = vec![0f32; dn];
                butteraugli::dn2_into(&cx, &mut nx, w, h, dw, dh);
                butteraugli::dn2_into(&cy, &mut ny, w, h, dw, dh);
                butteraugli::dn2_into(&cb, &mut nb, w, h, dw, dh);
                cx = nx; cy = ny; cb = nb; w = dw; h = dh;
            } else {
                // Last level (s==2, or image too small to downsample): move cx/cy/cb
                // directly into the Level — saves 3 × n f32 allocations (up to 288 MB at 24MP).
                levels.push(Level { x: cx, y: cy, b: cb, mask, w, h });
                break;
            }
        }
        let (ssim_sb, ssim_sbb) = ssim::ref_moments(ref_rgba, n, 4);
        let backend = match opts.backend {
            BackendChoice::ForceScalar => Backend::Scalar,
            // A forced SIMD id is honoured only if this CPU actually supports the
            // required target features; otherwise dispatching a #[target_feature]
            // kernel is UB/SIGILL. Fall back to the next-best supported backend
            // (avx512 -> avx2 -> scalar). For a CPU that HAS the feature this is a
            // no-op; it only guards CPUs that lack it.
            BackendChoice::Force(id) => resolve_forced_backend(id),
            // rsqrt variant stays opt-in (Force(2)) until the flip-flop bench
            // promotes it; Auto picks strict sqrt for now. Target-aware.
            BackendChoice::Auto => {
                #[cfg(target_arch = "x86_64")]
                {
                    detect_native(false)
                }
                #[cfg(target_arch = "wasm32")]
                {
                    simd::detect_wasm()
                }
                #[cfg(not(any(target_arch = "x86_64", target_arch = "wasm32")))]
                {
                    Backend::Scalar
                }
            }
        };
        Comparer {
            width, height, n, opts, backend, levels,
            ref_rgba: ref_rgba.to_vec(),
            ssim_sb, ssim_sbb,
            tx: vec![0f32; n], ty: vec![0f32; n], tb: vec![0f32; n],
            dx: vec![0f32; n], dy: vec![0f32; n], db: vec![0f32; n],
        }
    }

    fn fill_test_xyb(&mut self, test: &[u8]) {
        match self.backend {
            #[cfg(target_arch = "x86_64")]
            Backend::Avx2Strict | Backend::Avx2Rsqrt => unsafe {
                simd::avx2::pixels_to_xyb_avx2(
                    test, self.n, xyb::sqrt_lin_lut_ptr(),
                    &mut self.tx, &mut self.ty, &mut self.tb,
                );
            },
            #[cfg(target_arch = "x86_64")]
            Backend::Avx512Strict | Backend::Avx512Rsqrt => unsafe {
                simd::avx512::pixels_to_xyb_avx512(
                    test, self.n, xyb::sqrt_lin_lut_ptr(),
                    &mut self.tx, &mut self.ty, &mut self.tb,
                );
            },
            #[cfg(target_arch = "wasm32")]
            Backend::WasmSimd => simd::wasm::pixels_to_xyb_wasm(
                test, self.n, xyb::sqrt_lin_lut(),
                &mut self.tx, &mut self.ty, &mut self.tb,
            ),
            _ => xyb::pixels_to_xyb(test, self.n, &mut self.tx, &mut self.ty, &mut self.tb),
        }
    }

    fn downsample_dispatch(&mut self, w: usize, h: usize, dw: usize, dh: usize) {
        match self.backend {
            #[cfg(target_arch = "x86_64")]
            Backend::Avx2Strict | Backend::Avx2Rsqrt => unsafe {
                simd::avx2::downsample_avx2(&self.tx, &mut self.dx, w, h, dw, dh);
                simd::avx2::downsample_avx2(&self.ty, &mut self.dy, w, h, dw, dh);
                simd::avx2::downsample_avx2(&self.tb, &mut self.db, w, h, dw, dh);
            },
            #[cfg(target_arch = "x86_64")]
            Backend::Avx512Strict | Backend::Avx512Rsqrt => unsafe {
                simd::avx512::downsample_avx512(&self.tx, &mut self.dx, w, h, dw, dh);
                simd::avx512::downsample_avx512(&self.ty, &mut self.dy, w, h, dw, dh);
                simd::avx512::downsample_avx512(&self.tb, &mut self.db, w, h, dw, dh);
            },
            #[cfg(target_arch = "wasm32")]
            Backend::WasmSimd => {
                simd::wasm::downsample_wasm(&self.tx, &mut self.dx, w, h, dw, dh);
                simd::wasm::downsample_wasm(&self.ty, &mut self.dy, w, h, dw, dh);
                simd::wasm::downsample_wasm(&self.tb, &mut self.db, w, h, dw, dh);
            },
            _ => {
                downsample_inplace(&self.tx, &mut self.dx, w, h, dw, dh);
                downsample_inplace(&self.ty, &mut self.dy, w, h, dw, dh);
                downsample_inplace(&self.tb, &mut self.db, w, h, dw, dh);
            }
        }
        // Swap tx↔dx (and ty↔dy, tb↔db) so the downsampled output is now in
        // tx/ty/tb — ready for the next scale's scale_err_dispatch — while dx/dy/db
        // are recycled as the scratch for the following downsample. This replaces
        // 3×dw*dh×4 bytes of memcpy (up to 288 MB at scale 0 for a 24 MP image)
        // with 3 pointer swaps (zero-copy, PERC-04). Both Vecs remain large enough
        // for all scales since tx/dx are sized to n (full resolution) at construction.
        // Only tx[..dw*dh]/ty[..dw*dh]/tb[..dw*dh] are valid after this swap; the
        // stale tail in the now-dx buffer is never read by scale_err_dispatch (which
        // uses lvl.w*lvl.h as its bound) and is overwritten on the next downsample.
        std::mem::swap(&mut self.tx, &mut self.dx);
        std::mem::swap(&mut self.ty, &mut self.dy);
        std::mem::swap(&mut self.tb, &mut self.db);
    }

    /// 3-scale butteraugli. Mutates test scratch (tx/ty/tb get downsampled in place).
    pub fn butteraugli(&mut self, test: &[u8]) -> f32 {
        if test.len() != self.n * 4 {
            return f32::NAN;
        }
        self.fill_test_xyb(test);
        let (mut w, mut h) = (self.width, self.height);
        let mut total = 0f32;
        for s in 0..3 {
            let e = self.scale_err_dispatch(s) * self.opts.weights[s];
            total += e;
            if s < 2 && w > 1 && h > 1 {
                let (dw, dh) = ((w >> 1).max(1), (h >> 1).max(1));
                self.downsample_dispatch(w, h, dw, dh);
                w = dw; h = dh;
            }
        }
        // Divide by the actual sum of weights rather than the hardcoded 7.0 (the sum
        // of the default [4, 2, 1]). Any caller supplying custom Opts.weights would
        // otherwise receive a result scaled by 7.0/sum(custom_weights) — silently wrong.
        let weight_sum: f32 = self.opts.weights.iter().sum();
        // Use assert! (not debug_assert!) so callers passing Opts { weights: [0.0, ..] }
        // or NaN weights get a clear panic in release builds rather than silent NaN propagation
        // through Metrics and downstream comparisons.
        assert!(
            weight_sum.is_finite() && weight_sum > 0.0,
            "Opts.weights must sum to a finite positive value, got {weight_sum}"
        );
        total / weight_sum
    }

    pub fn ssim(&self, test: &[u8]) -> f32 {
        if test.len() != self.n * 4 {
            return f32::NAN;
        }
        match self.backend {
            #[cfg(target_arch = "x86_64")]
            // AVX-512 arms intentionally call the avx2 ssim kernel: no AVX-512 SSIM
            // implementation exists yet, and all shipping AVX-512 CPUs have avx2+fma.
            Backend::Avx2Strict | Backend::Avx2Rsqrt | Backend::Avx512Strict | Backend::Avx512Rsqrt => {
                let (sa, saa, sab) = unsafe { simd::avx2::ssim_moments_avx2(test, &self.ref_rgba, self.n) };
                ssim::finalize_ssim(&sa, &self.ssim_sb, &saa, &self.ssim_sbb, &sab, self.n, 3)
            }
            _ => ssim::ssim_with_ref(test, &self.ref_rgba, self.n, 4, &self.ssim_sb, &self.ssim_sbb),
        }
    }

    pub fn psnr(&self, test: &[u8]) -> f32 {
        if test.len() != self.n * 4 {
            return f32::NAN;
        }
        match self.backend {
            #[cfg(target_arch = "x86_64")]
            // AVX-512 arms intentionally call the avx2 psnr (ssd) kernel: no AVX-512
            // PSNR implementation exists yet; avx2+fma is implied by AVX-512 hardware.
            Backend::Avx2Strict | Backend::Avx2Rsqrt | Backend::Avx512Strict | Backend::Avx512Rsqrt => {
                let sum_sq = unsafe { simd::avx2::ssd_avx2(test, &self.ref_rgba) };
                if sum_sq == 0 {
                    return f32::INFINITY;
                }
                let mse = sum_sq as f64 / test.len() as f64;
                (10.0 * (255.0f64 * 255.0 / mse).log10()) as f32
            }
            #[cfg(target_arch = "wasm32")]
            Backend::WasmSimd => {
                let sum_sq = simd::wasm::ssd_wasm(test, &self.ref_rgba);
                if sum_sq == 0 {
                    return f32::INFINITY;
                }
                let mse = sum_sq as f64 / test.len() as f64;
                (10.0 * (255.0f64 * 255.0 / mse).log10()) as f32
            }
            _ => psnr::psnr(test, &self.ref_rgba),
        }
    }

    fn scale_err_dispatch(&self, s: usize) -> f32 {
        let lvl = &self.levels[s];
        let cur_n = lvl.w * lvl.h; // reference-side dims are the source of truth
        let (tx, ty, tb) = (&self.tx[..cur_n], &self.ty[..cur_n], &self.tb[..cur_n]);
        let k = &self.opts.k;
        match self.backend {
            #[cfg(target_arch = "x86_64")]
            Backend::Avx2Strict => unsafe {
                simd::avx2::scale_err_avx2(&lvl.mask, &lvl.x, &lvl.y, &lvl.b, tx, ty, tb, cur_n, k.kx, k.ky, k.kb, false)
            },
            #[cfg(target_arch = "x86_64")]
            Backend::Avx2Rsqrt => unsafe {
                simd::avx2::scale_err_avx2(&lvl.mask, &lvl.x, &lvl.y, &lvl.b, tx, ty, tb, cur_n, k.kx, k.ky, k.kb, true)
            },
            #[cfg(target_arch = "x86_64")]
            Backend::Avx512Strict => unsafe {
                simd::avx512::scale_err_avx512(&lvl.mask, &lvl.x, &lvl.y, &lvl.b, tx, ty, tb, cur_n, k.kx, k.ky, k.kb, false)
            },
            #[cfg(target_arch = "x86_64")]
            Backend::Avx512Rsqrt => unsafe {
                simd::avx512::scale_err_avx512(&lvl.mask, &lvl.x, &lvl.y, &lvl.b, tx, ty, tb, cur_n, k.kx, k.ky, k.kb, true)
            },
            #[cfg(target_arch = "wasm32")]
            Backend::WasmSimd => simd::wasm::scale_err_wasm(&lvl.mask, &lvl.x, &lvl.y, &lvl.b, tx, ty, tb, cur_n, k.kx, k.ky, k.kb),
            _ => butteraugli::scale_err(&lvl.mask, &lvl.x, &lvl.y, &lvl.b, tx, ty, tb, cur_n, k),
        }
    }

    /// All three metrics. Scalar version calls each path; the SIMD override in a
    /// later task fuses the deinterleave.
    pub fn all(&mut self, test: &[u8]) -> Metrics {
        let butteraugli = self.butteraugli(test);
        let ssim = self.ssim(test);
        let psnr = self.psnr(test);
        // Match the per-metric graceful path: a short buffer makes the three calls
        // above return NaN, so do not let channel_moments index OOB and panic.
        let moments = if test.len() == self.n * 4 {
            let (mus, vars, ch) = ssim::channel_moments(test, self.n, 4, 3);
            ChannelMoments { mus, vars, ch }
        } else {
            ChannelMoments::default()
        };
        Metrics { butteraugli, ssim, psnr, moments }
    }
}

/// Resolve a forced backend id to a backend this CPU can actually execute.
///
/// The SIMD kernels are `#[target_feature(...)]` `unsafe` fns: invoking one on a
/// CPU that lacks the feature is undefined behaviour (typically SIGILL). Only the
/// `Auto` arm runs through `detect_native`, so `Force(id)` must do its own runtime
/// check here and degrade to the next-best supported backend
/// (avx512 -> avx2 -> scalar). Unknown ids fall through to `Scalar`.
///
/// Note: the AVX-512 SSIM/PSNR paths reuse the `#[target_feature(enable="avx2,fma")]`
/// kernels, so an AVX-512 id additionally requires avx2+fma (true on all shipping
/// AVX-512 hardware, but verified here rather than assumed).
fn resolve_forced_backend(id: u8) -> Backend {
    #[cfg(target_arch = "x86_64")]
    {
        let has_avx2 = std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma");
        let has_avx512 = has_avx2
            && std::is_x86_feature_detected!("avx512f")
            && std::is_x86_feature_detected!("avx512bw");
        return match id {
            1 if has_avx2 => Backend::Avx2Strict,
            2 if has_avx2 => Backend::Avx2Rsqrt,
            3 if has_avx512 => Backend::Avx512Strict,
            5 if has_avx512 => Backend::Avx512Rsqrt,
            // Forced AVX-512 on a CPU without it: fall back to AVX2 if available.
            3 if has_avx2 => Backend::Avx2Strict,
            5 if has_avx2 => Backend::Avx2Rsqrt,
            // id=4 is Backend::WasmSimd (discriminant 4). WasmSimd is not a valid x86_64
            // backend — map explicitly to Scalar rather than falling through silently,
            // so a bench user passing Force(4) on x86_64 gets a clear fallback.
            4 => Backend::Scalar,
            _ => Backend::Scalar,
        };
    }
    #[cfg(target_arch = "wasm32")]
    {
        // id=4 is Backend::WasmSimd (discriminant 4); all other ids fall back to Scalar.
        // Without this branch, Force(4) on wasm32 silently returns Scalar, making
        // the flip-flop bench override useless on the primary production target.
        return if id == 4 { Backend::WasmSimd } else { Backend::Scalar };
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "wasm32")))]
    {
        let _ = id;
        Backend::Scalar
    }
}

/// Box 2× downsample of a plane held in the first `w*h` of `src` into `dst`.
fn downsample_inplace(src: &[f32], dst: &mut [f32], w: usize, h: usize, dw: usize, dh: usize) {
    for y in 0..dh {
        let sy0 = y << 1;
        let sy1 = (sy0 + 1).min(h - 1);
        for x in 0..dw {
            let sx0 = x << 1;
            let sx1 = (sx0 + 1).min(w - 1);
            dst[y * dw + x] = (src[sy0 * w + sx0]
                + src[sy0 * w + sx1]
                + src[sy1 * w + sx0]
                + src[sy1 * w + sx1])
                * 0.25;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checker(w: usize, h: usize) -> Vec<u8> {
        let mut v = vec![0u8; w * h * 4];
        for i in 0..w * h {
            let on = ((i % w) ^ (i / w)) & 1 == 1;
            let c = if on { 200 } else { 40 };
            v[i * 4] = c; v[i * 4 + 1] = c / 2; v[i * 4 + 2] = c / 3; v[i * 4 + 3] = 255;
        }
        v
    }

    #[test]
    fn identical_image_scores_perfect() {
        let (w, h) = (16, 16);
        let img = checker(w, h);
        let mut cmp = Comparer::new(&img, w, h, Opts::default());
        assert!(cmp.butteraugli(&img).abs() < 1e-4);
        assert!((cmp.ssim(&img) - 1.0).abs() < 1e-4);
        assert_eq!(cmp.psnr(&img), f32::INFINITY);
    }

    #[test]
    fn all_is_idempotent() {
        // Calling all() twice on the same Comparer must produce identical Metrics.
        // This verifies that tx/ty/tb mutation from the butteraugli pass is reset
        // correctly and does not corrupt subsequent calls.
        let (w, h) = (16, 16);
        let img = checker(w, h);
        let mut noisy = img.clone();
        for (i, p) in noisy.iter_mut().enumerate() {
            if i % 4 != 3 { *p = p.saturating_add(((i * 7) % 11) as u8); }
        }
        let mut cmp = Comparer::new(&img, w, h, Opts::default());
        let m1 = cmp.all(&noisy);
        let m2 = cmp.all(&noisy);
        assert!((m1.butteraugli - m2.butteraugli).abs() < 1e-6, "butteraugli not idempotent");
        assert!((m1.ssim - m2.ssim).abs() < 1e-6, "ssim not idempotent");
        assert!((m1.psnr - m2.psnr).abs() < 1e-3, "psnr not idempotent");
    }

    #[test]
    fn all_matches_individual_calls() {
        let (w, h) = (16, 16);
        let img = checker(w, h);
        let mut noisy = img.clone();
        for (i, p) in noisy.iter_mut().enumerate() {
            if i % 4 != 3 { *p = p.saturating_add(((i * 7) % 11) as u8); }
        }
        let mut cmp = Comparer::new(&img, w, h, Opts::default());
        let m = cmp.all(&noisy);
        let mut cmp2 = Comparer::new(&img, w, h, Opts::default());
        assert!((m.butteraugli - cmp2.butteraugli(&noisy)).abs() < 1e-5);
        assert!((m.ssim - cmp2.ssim(&noisy)).abs() < 1e-6);
        assert!((m.psnr - cmp2.psnr(&noisy)).abs() < 1e-3);
    }

    /// Parity guard: all() must produce the same values as the three individual calls
    /// on the same Comparer instance. This guards any future fused test-side pass
    /// (e.g., PERC-02) against introducing divergent rounding or state mutation.
    /// Uses the same Comparer for both paths to catch internal state bugs.
    #[test]
    fn all_fused_parity_vs_individual_same_comparer() {
        let (w, h) = (32, 32);
        let img = checker(w, h);
        let mut noisy = img.clone();
        for (i, p) in noisy.iter_mut().enumerate() {
            if i % 4 != 3 { *p = p.saturating_add(((i * 13) % 17) as u8); }
        }
        let mut cmp = Comparer::new(&img, w, h, Opts::default());
        // Call all() first — this mutates tx/ty/tb via butteraugli.
        let m = cmp.all(&noisy);
        // Call individual metrics on the same Comparer after all() resets state.
        let ba = cmp.butteraugli(&noisy);
        let ss = cmp.ssim(&noisy);
        let ps = cmp.psnr(&noisy);
        assert!(
            (m.butteraugli - ba).abs() < 1e-5,
            "butteraugli: all()={} vs individual={}", m.butteraugli, ba
        );
        assert!(
            (m.ssim - ss).abs() < 1e-6,
            "ssim: all()={} vs individual={}", m.ssim, ss
        );
        assert!(
            (m.psnr - ps).abs() < 1e-3,
            "psnr: all()={} vs individual={}", m.psnr, ps
        );
    }
}
