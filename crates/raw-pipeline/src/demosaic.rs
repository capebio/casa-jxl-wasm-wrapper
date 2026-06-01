//! Bilinear and MHC-corrected Bayer demosaic for RGGB pattern (Olympus default).
//!
//! `demosaic_rggb`: bilinear interpolation (fast).
//! `demosaic_rggb_mhc`: gradient-corrected interpolation (better quality, ~2× slower).
//!
//! Output is interleaved RGB at the same resolution as the raw frame.
//! Each pixel becomes a (R, G, B) triple in 16-bit linear sensor counts.
//! Edges use clamped neighbour coordinates.

#[cfg(feature = "parallel")]
use rayon::prelude::*;

#[inline(always)]
fn at(plane: &[u16], stride: usize, r: usize, c: usize) -> i32 {
    debug_assert!(r * stride + c < plane.len(), "at: OOB {}×{}+{} vs {}", r, stride, c, plane.len());
    unsafe { *plane.get_unchecked(r * stride + c) as i32 }
}

#[inline(always)]
fn clamp(v: isize, lo: isize, hi: isize) -> usize {
    v.clamp(lo, hi) as usize
}

fn validate(raw: &[u16], width: usize, height: usize) -> Result<(), String> {
    let expected = width
        .checked_mul(height)
        .ok_or_else(|| format!("demosaic: {}×{} overflows usize", width, height))?;
    if width == 0 || height == 0 {
        return Err(format!("demosaic: zero dimension {}×{}", width, height));
    }
    if raw.len() != expected {
        return Err(format!(
            "demosaic: buffer length {} != {}×{}",
            raw.len(), width, height
        ));
    }
    Ok(())
}

/// Compute one demosaiced RGB pixel. Caller passes pre-resolved neighbor
/// indices: `rn`/`rs` = north/south row, `cw`/`ce` = west/east col.
/// For border pixels the caller clamps; interior pixels pass `col±1` directly.
#[inline(always)]
fn bayer_pixel(
    raw: &[u16], w: usize,
    row: usize, col: usize,
    rn: usize, rs: usize, cw: usize, ce: usize,
) -> (u16, u16, u16) {
    let (rr, gg, bb) = match (row & 1, col & 1) {
        (0, 0) => {
            let r_v = at(raw, w, row, col);
            let g_v = (at(raw, w, rn, col) + at(raw, w, rs, col)
                     + at(raw, w, row, cw) + at(raw, w, row, ce)) >> 2;
            let b_v = (at(raw, w, rn, cw) + at(raw, w, rn, ce)
                     + at(raw, w, rs, cw) + at(raw, w, rs, ce)) >> 2;
            (r_v, g_v, b_v)
        }
        (0, 1) => {
            let r_v = (at(raw, w, row, cw) + at(raw, w, row, ce)) >> 1;
            let g_v = at(raw, w, row, col);
            let b_v = (at(raw, w, rn, col) + at(raw, w, rs, col)) >> 1;
            (r_v, g_v, b_v)
        }
        (1, 0) => {
            let r_v = (at(raw, w, rn, col) + at(raw, w, rs, col)) >> 1;
            let g_v = at(raw, w, row, col);
            let b_v = (at(raw, w, row, cw) + at(raw, w, row, ce)) >> 1;
            (r_v, g_v, b_v)
        }
        _ => {
            let r_v = (at(raw, w, rn, cw) + at(raw, w, rn, ce)
                     + at(raw, w, rs, cw) + at(raw, w, rs, ce)) >> 2;
            let g_v = (at(raw, w, rn, col) + at(raw, w, rs, col)
                     + at(raw, w, row, cw) + at(raw, w, row, ce)) >> 2;
            let b_v = at(raw, w, row, col);
            (r_v, g_v, b_v)
        }
    };
    (
        rr.clamp(0, 0xFFFF) as u16,
        gg.clamp(0, 0xFFFF) as u16,
        bb.clamp(0, 0xFFFF) as u16,
    )
}

/// Bilinear RGGB demosaic — fast path.
///
/// RGGB Bayer pattern:
///   (even row, even col) = R
///   (even row, odd  col) = G (red row)
///   (odd  row, even col) = G (blue row)
///   (odd  row, odd  col) = B
pub fn demosaic_rggb(raw: &[u16], width: usize, height: usize) -> Result<Vec<u16>, String> {
    validate(raw, width, height)?;
    let mut rgb = vec![0u16; width * height * 3];

    let h_max = height - 1;
    let w_max = width  - 1;

    let do_row = |row: usize, out_row: &mut [u16]| {
        let rn = if row == 0     { 0     } else { row - 1 };
        let rs = if row == h_max { h_max } else { row + 1 };

        // Left border (col 0): c_w clamps to 0.
        {
            let (r, g, b) = bayer_pixel(raw, width, row, 0, rn, rs, 0, 1.min(w_max));
            out_row[0] = r; out_row[1] = g; out_row[2] = b;
        }

        // Interior cols — no clamping; 99.9% of pixels on a 20 MP frame.
        for col in 1..w_max {
            let (r, g, b) = bayer_pixel(raw, width, row, col, rn, rs, col - 1, col + 1);
            let o = col * 3;
            out_row[o] = r; out_row[o+1] = g; out_row[o+2] = b;
        }

        // Right border (col w_max): c_e clamps to w_max.
        if width > 1 {
            let col = w_max;
            let (r, g, b) = bayer_pixel(raw, width, row, col, rn, rs, col - 1, col);
            let o = col * 3;
            out_row[o] = r; out_row[o+1] = g; out_row[o+2] = b;
        }
    };

    #[cfg(feature = "parallel")]
    rgb.par_chunks_mut(width * 3).enumerate().for_each(|(row, out_row)| do_row(row, out_row));
    #[cfg(not(feature = "parallel"))]
    rgb.chunks_mut(width * 3).enumerate().for_each(|(row, out_row)| do_row(row, out_row));

    Ok(rgb)
}

/// MHC-corrected RGGB demosaic — quality path.
///
/// Adds a Laplacian correction term to each interpolated channel, derived from
/// the known channel's 2nd derivative.  This eliminates most of the colour
/// zipper artefacts that bilinear produces at high-contrast edges (text, branches).
///
/// Correction formulas (integer arithmetic, divide by 8 or 4):
///   G at R: 8G = 2(G_N+G_E+G_S+G_W) + 4R_C − R_N2 − R_E2 − R_S2 − R_W2
///   G at B: 8G = 2(G_N+G_E+G_S+G_W) + 4B_C − B_N2 − B_E2 − B_S2 − B_W2
///   R at GR: 4R = 2(R_E+R_W) + 2G_C − G_E2 − G_W2
///   B at GR: 4B = 2(B_N+B_S) + 2G_C − G_N2 − G_S2
///   R at GB: 4R = 2(R_N+R_S) + 2G_C − G_N2 − G_S2
///   B at GB: 4B = 2(B_E+B_W) + 2G_C − G_E2 − G_W2
///   R at B:  8R = 2(R_NE+R_NW+R_SE+R_SW) + 4B_C − B_N2 − B_E2 − B_S2 − B_W2
///
/// All results clamped to [0, 65535].
pub fn demosaic_rggb_mhc(raw: &[u16], width: usize, height: usize) -> Result<Vec<u16>, String> {
    validate(raw, width, height)?;
    let mut rgb = vec![0u16; width * height * 3];

    let w_max = (width - 1) as isize;
    let h_max = (height - 1) as isize;

    let do_row = |row: usize, out_row: &mut [u16]| {
        let r = row as isize;
        let r_n  = clamp(r - 1, 0, h_max);
        let r_s  = clamp(r + 1, 0, h_max);
        let r_n2 = clamp(r - 2, 0, h_max);
        let r_s2 = clamp(r + 2, 0, h_max);
        let r_c  = row;

        for col in 0..width {
            let c    = col as isize;
            let c_w  = clamp(c - 1, 0, w_max);
            let c_e  = clamp(c + 1, 0, w_max);
            let c_w2 = clamp(c - 2, 0, w_max);
            let c_e2 = clamp(c + 2, 0, w_max);

            let (rr, gg, bb) = match (row & 1, col & 1) {
                // R pixel (even row, even col)
                (0, 0) => {
                    let rc  = at(raw, width, r_c,  col);
                    // Cardinal G neighbors at distance 1
                    let gn  = at(raw, width, r_n,  col);
                    let ge  = at(raw, width, r_c,  c_e);
                    let gs  = at(raw, width, r_s,  col);
                    let gw  = at(raw, width, r_c,  c_w);
                    // R pixels 2 steps away (same parity — all R)
                    let rn2 = at(raw, width, r_n2, col);
                    let re2 = at(raw, width, r_c,  c_e2);
                    let rs2 = at(raw, width, r_s2, col);
                    let rw2 = at(raw, width, r_c,  c_w2);
                    // MHC: 8G = 2(G_N+G_E+G_S+G_W) + 4R_C − R_N2 − R_E2 − R_S2 − R_W2
                    let g_mhc = (2*(gn + ge + gs + gw) + 4*rc - rn2 - re2 - rs2 - rw2) >> 3;
                    // B: bilinear from 4 diagonal B neighbors
                    let b_v = (at(raw, width, r_n, c_w)
                               + at(raw, width, r_n, c_e)
                               + at(raw, width, r_s, c_w)
                               + at(raw, width, r_s, c_e)) >> 2;
                    (rc, g_mhc.clamp(0, 65535), b_v.clamp(0, 65535))
                }
                // G in R row (even row, odd col)
                (0, 1) => {
                    let gc  = at(raw, width, r_c,  col);
                    // R at distance 1 E/W (same row, even cols → R)
                    let re  = at(raw, width, r_c,  c_e);
                    let rw  = at(raw, width, r_c,  c_w);
                    // B at distance 1 N/S (odd rows, odd col → B)
                    let bn  = at(raw, width, r_n,  col);
                    let bs  = at(raw, width, r_s,  col);
                    // G at distance 2 E/W (same row, odd cols → G)
                    let ge2 = at(raw, width, r_c,  c_e2);
                    let gw2 = at(raw, width, r_c,  c_w2);
                    // G at distance 2 N/S (even rows, odd col → G)
                    let gn2 = at(raw, width, r_n2, col);
                    let gs2 = at(raw, width, r_s2, col);
                    // 4R = 2(R_E+R_W) + 2G_C − G_E2 − G_W2
                    let r_v = (2*(re + rw) + 2*gc - ge2 - gw2) >> 2;
                    // 4B = 2(B_N+B_S) + 2G_C − G_N2 − G_S2
                    let b_v = (2*(bn + bs) + 2*gc - gn2 - gs2) >> 2;
                    (r_v.clamp(0, 65535), gc, b_v.clamp(0, 65535))
                }
                // G in B row (odd row, even col)
                (1, 0) => {
                    let gc  = at(raw, width, r_c,  col);
                    // R at distance 1 N/S (even rows, even col → R)
                    let rn  = at(raw, width, r_n,  col);
                    let rs  = at(raw, width, r_s,  col);
                    // B at distance 1 E/W (odd row, odd cols → B)
                    let be  = at(raw, width, r_c,  c_e);
                    let bw  = at(raw, width, r_c,  c_w);
                    // G at distance 2 N/S (odd rows, even col → G)
                    let gn2 = at(raw, width, r_n2, col);
                    let gs2 = at(raw, width, r_s2, col);
                    // G at distance 2 E/W (odd row, even cols → G)
                    let ge2 = at(raw, width, r_c,  c_e2);
                    let gw2 = at(raw, width, r_c,  c_w2);
                    // 4R = 2(R_N+R_S) + 2G_C − G_N2 − G_S2
                    let r_v = (2*(rn + rs) + 2*gc - gn2 - gs2) >> 2;
                    // 4B = 2(B_E+B_W) + 2G_C − G_E2 − G_W2
                    let b_v = (2*(be + bw) + 2*gc - ge2 - gw2) >> 2;
                    (r_v.clamp(0, 65535), gc, b_v.clamp(0, 65535))
                }
                // B pixel (odd row, odd col)
                _ => {
                    let bc  = at(raw, width, r_c,  col);
                    // Cardinal G neighbors at distance 1
                    let gn  = at(raw, width, r_n,  col);
                    let ge  = at(raw, width, r_c,  c_e);
                    let gs  = at(raw, width, r_s,  col);
                    let gw  = at(raw, width, r_c,  c_w);
                    // B pixels 2 steps away (same parity — all B)
                    let bn2 = at(raw, width, r_n2, col);
                    let be2 = at(raw, width, r_c,  c_e2);
                    let bs2 = at(raw, width, r_s2, col);
                    let bw2 = at(raw, width, r_c,  c_w2);
                    // MHC: 8G = 2(G_N+G_E+G_S+G_W) + 4B_C − B_N2 − B_E2 − B_S2 − B_W2
                    let g_mhc = (2*(gn + ge + gs + gw) + 4*bc - bn2 - be2 - bs2 - bw2) >> 3;
                    // R: bilinear from 4 diagonal R neighbors + B Laplacian correction
                    // 8R = 2(R_NE+R_NW+R_SE+R_SW) + 4B_C − B_N2 − B_E2 − B_S2 − B_W2
                    let rne = at(raw, width, r_n, c_e);
                    let rnw = at(raw, width, r_n, c_w);
                    let rse = at(raw, width, r_s, c_e);
                    let rsw = at(raw, width, r_s, c_w);
                    let r_v = (2*(rne + rnw + rse + rsw) + 4*bc - bn2 - be2 - bs2 - bw2) >> 3;
                    (r_v.clamp(0, 65535), g_mhc.clamp(0, 65535), bc)
                }
            };

            let o = col * 3;
            out_row[o]     = rr as u16;
            out_row[o + 1] = gg as u16;
            out_row[o + 2] = bb as u16;
        }
    };

    #[cfg(feature = "parallel")]
    rgb.par_chunks_mut(width * 3).enumerate().for_each(|(row, out_row)| do_row(row, out_row));
    #[cfg(not(feature = "parallel"))]
    rgb.chunks_mut(width * 3).enumerate().for_each(|(row, out_row)| do_row(row, out_row));

    Ok(rgb)
}
