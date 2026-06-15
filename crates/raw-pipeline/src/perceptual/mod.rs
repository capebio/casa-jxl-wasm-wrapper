//! Perceptual image-quality metrics (Butteraugli-approx, SSIM, PSNR).
//! Scalar Rust is the parity oracle; SIMD backends are selected at runtime.
//! See docs/superpowers/specs/2026-06-13-perceptual-metrics-simd-kernel-design.md

mod blur;
pub(crate) mod butteraugli;
pub mod engine;
mod psnr;
pub(crate) mod ssim;
pub(crate) mod xyb;
mod simd;
pub use simd::{detect_native, Backend};

pub use butteraugli::Kweights;
pub use engine::{AlgorithmMode, ButteraugliEngine, EngineMetrics};

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
        let n = width * height;
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
            levels.push(Level { x: cx.clone(), y: cy.clone(), b: cb.clone(), mask, w, h });
            if s < 2 && w > 1 && h > 1 {
                let (nx, _, _) = butteraugli::dn2(&cx, w, h);
                let (ny, _, _) = butteraugli::dn2(&cy, w, h);
                let (nb, dw, dh) = butteraugli::dn2(&cb, w, h);
                cx = nx; cy = ny; cb = nb; w = dw; h = dh;
            }
        }
        let (ssim_sb, ssim_sbb) = ssim::ref_moments(ref_rgba, n, 4);
        let backend = match opts.backend {
            BackendChoice::ForceScalar => Backend::Scalar,
            BackendChoice::Force(id) => match id {
                1 => Backend::Avx2Strict,
                2 => Backend::Avx2Rsqrt,
                3 => Backend::Avx512Strict,
                5 => Backend::Avx512Rsqrt,
                _ => Backend::Scalar,
            },
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
        let dn = dw * dh;
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
        self.tx[..dn].copy_from_slice(&self.dx[..dn]);
        self.ty[..dn].copy_from_slice(&self.dy[..dn]);
        self.tb[..dn].copy_from_slice(&self.db[..dn]);
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
        total / 7.0
    }

    pub fn ssim(&self, test: &[u8]) -> f32 {
        if test.len() != self.n * 4 {
            return f32::NAN;
        }
        match self.backend {
            #[cfg(target_arch = "x86_64")]
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
            Backend::Avx2Strict | Backend::Avx2Rsqrt | Backend::Avx512Strict | Backend::Avx512Rsqrt => {
                let sum_sq = unsafe { simd::avx2::ssd_avx2(test, &self.ref_rgba) };
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
        let (mus, vars, ch) = ssim::channel_moments(test, self.n, 4, 3);
        Metrics { butteraugli, ssim, psnr, moments: ChannelMoments { mus, vars, ch } }
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
}
