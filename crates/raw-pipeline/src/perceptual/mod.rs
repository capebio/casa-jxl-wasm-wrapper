//! Perceptual image-quality metrics (Butteraugli-approx, SSIM, PSNR).
//! Scalar Rust is the parity oracle; SIMD backends are selected at runtime.
//! See docs/superpowers/specs/2026-06-13-perceptual-metrics-simd-kernel-design.md

mod blur;
mod butteraugli;
mod psnr;
mod ssim;
mod xyb;
