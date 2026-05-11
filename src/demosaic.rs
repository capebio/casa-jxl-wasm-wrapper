//! Bilinear Bayer demosaic for RGGB pattern (Olympus default).
//!
//! Output is interleaved RGB at the same resolution as the raw frame.
//! Each pixel becomes a (R, G, B) triple in 16-bit linear sensor counts.
//! Edges use clamped neighbour coordinates (cheap to compute, visually fine).
//!
//! Single-threaded in the wasm build — rayon needs SharedArrayBuffer + a JS
//! worker bootstrap (wasm-bindgen-rayon) that adds hosting requirements.
//! Add later if perf demands.

#[inline(always)]
fn at(plane: &[u16], stride: usize, r: usize, c: usize) -> i32 {
    unsafe { *plane.get_unchecked(r * stride + c) as i32 }
}

#[inline(always)]
fn clamp(v: isize, lo: isize, hi: isize) -> usize {
    v.clamp(lo, hi) as usize
}

/// RGGB Bayer pattern:
///   (even row, even col) = R
///   (even row, odd  col) = G (red row)
///   (odd  row, even col) = G (blue row)
///   (odd  row, odd  col) = B
pub fn demosaic_rggb(raw: &[u16], width: usize, height: usize) -> Vec<u16> {
    assert_eq!(raw.len(), width * height);
    let mut rgb = vec![0u16; width * height * 3];

    let w_max = (width - 1) as isize;
    let h_max = (height - 1) as isize;

    rgb.chunks_mut(width * 3)
        .enumerate()
        .for_each(|(row, out_row)| {
            let r = row as isize;
            let r_n = clamp(r - 1, 0, h_max);
            let r_s = clamp(r + 1, 0, h_max);
            let r_c = row;

            for col in 0..width {
                let c = col as isize;
                let c_w = clamp(c - 1, 0, w_max);
                let c_e = clamp(c + 1, 0, w_max);

                let (rr, gg, bb) = match (row & 1, col & 1) {
                    // R pixel
                    (0, 0) => {
                        let r_v = at(raw, width, r_c, col);
                        let g_v = (at(raw, width, r_n, col)
                            + at(raw, width, r_s, col)
                            + at(raw, width, r_c, c_w)
                            + at(raw, width, r_c, c_e))
                            >> 2;
                        let b_v = (at(raw, width, r_n, c_w)
                            + at(raw, width, r_n, c_e)
                            + at(raw, width, r_s, c_w)
                            + at(raw, width, r_s, c_e))
                            >> 2;
                        (r_v, g_v, b_v)
                    }
                    // G in red row
                    (0, 1) => {
                        let r_v = (at(raw, width, r_c, c_w) + at(raw, width, r_c, c_e)) >> 1;
                        let g_v = at(raw, width, r_c, col);
                        let b_v = (at(raw, width, r_n, col) + at(raw, width, r_s, col)) >> 1;
                        (r_v, g_v, b_v)
                    }
                    // G in blue row
                    (1, 0) => {
                        let r_v = (at(raw, width, r_n, col) + at(raw, width, r_s, col)) >> 1;
                        let g_v = at(raw, width, r_c, col);
                        let b_v = (at(raw, width, r_c, c_w) + at(raw, width, r_c, c_e)) >> 1;
                        (r_v, g_v, b_v)
                    }
                    // B pixel
                    _ => {
                        let r_v = (at(raw, width, r_n, c_w)
                            + at(raw, width, r_n, c_e)
                            + at(raw, width, r_s, c_w)
                            + at(raw, width, r_s, c_e))
                            >> 2;
                        let g_v = (at(raw, width, r_n, col)
                            + at(raw, width, r_s, col)
                            + at(raw, width, r_c, c_w)
                            + at(raw, width, r_c, c_e))
                            >> 2;
                        let b_v = at(raw, width, r_c, col);
                        (r_v, g_v, b_v)
                    }
                };

                let o = col * 3;
                out_row[o] = rr.clamp(0, 0xFFFF) as u16;
                out_row[o + 1] = gg.clamp(0, 0xFFFF) as u16;
                out_row[o + 2] = bb.clamp(0, 0xFFFF) as u16;
            }
        });

    rgb
}
