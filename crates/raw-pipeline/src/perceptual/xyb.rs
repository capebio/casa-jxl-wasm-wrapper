//! sRGB(u8) → sqrt-linear → XYB planar conversion. Port of the JS `pixelsToXyb`.

use std::sync::OnceLock;

/// LUT of sqrt(sRGB_decode(i/255)). Computed in f64 then stored f32 to track the
/// JS table within parity tolerance.
pub(crate) fn sqrt_lin_lut() -> &'static [f32; 256] {
    static LUT: OnceLock<[f32; 256]> = OnceLock::new();
    LUT.get_or_init(|| {
        let mut t = [0f32; 256];
        for (i, slot) in t.iter_mut().enumerate() {
            let v = i as f64 / 255.0;
            let lin = if v <= 0.04045 {
                v / 12.92
            } else {
                ((v + 0.055) / 1.055).powf(2.4)
            };
            *slot = lin.sqrt() as f32;
        }
        t
    })
}

/// Reference to the sqrt-linear LUT for the x86 SIMD gather paths.
/// Returns a &'static reference so callers can avoid raw pointer lifetime ambiguity.
#[cfg(target_arch = "x86_64")]
pub(crate) fn sqrt_lin_lut_ptr() -> &'static [f32; 256] {
    sqrt_lin_lut()
}

/// RGBA (stride 4, alpha ignored) → planar X/Y/B. `x`,`y`,`b_out` len == n.
pub(crate) fn pixels_to_xyb(px: &[u8], n: usize, x: &mut [f32], y: &mut [f32], b_out: &mut [f32]) {
    let lut = sqrt_lin_lut();
    // Pin the active extents once. After this, `px.len() == n*4` and each output
    // plane len == n are facts the loop body can use, so LLVM drops the 4 per-pixel
    // bounds checks (px[j], px[j+1], px[j+2] and the three plane writes). The LUT
    // index is already constant-bounded (u8 → 0..=255). Byte-exact: the XYB
    // arithmetic is untouched, so this stays the SIMD parity oracle.
    let px = &px[..n * 4];
    let x = &mut x[..n];
    let y = &mut y[..n];
    let b_out = &mut b_out[..n];
    let mut j = 0;
    for i in 0..n {
        let r = lut[px[j] as usize];
        let g = lut[px[j + 1] as usize];
        let bb = lut[px[j + 2] as usize];
        x[i] = (r - bb) * 0.5;
        y[i] = (r + bb) * 0.5 + g;
        b_out[i] = bb;
        j += 4;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lut_endpoints() {
        let lut = sqrt_lin_lut();
        assert_eq!(lut[0], 0.0);
        assert!((lut[255] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn xyb_black_and_white() {
        let px = [0u8, 0, 0, 255, 255, 255, 255, 255];
        let (mut x, mut y, mut b) = ([0f32; 2], [0f32; 2], [0f32; 2]);
        pixels_to_xyb(&px, 2, &mut x, &mut y, &mut b);
        assert!(x[0].abs() < 1e-6 && y[0].abs() < 1e-6 && b[0].abs() < 1e-6);
        // white: r=g=b=1 → X=0, Y=(1+1)/2+1=2, B=1
        assert!((x[1]).abs() < 1e-6);
        assert!((y[1] - 2.0).abs() < 1e-6);
        assert!((b[1] - 1.0).abs() < 1e-6);
    }
}
