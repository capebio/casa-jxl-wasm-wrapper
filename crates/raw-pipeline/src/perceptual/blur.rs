//! Separable O(n) box blur, clamp-to-edge. Port of the JS `boxBlur`.

/// Box blur of `src` (w×h) with radius `r` into a fresh Vec.
///
/// For the construction-time pyramid (blur each scale of one image), prefer
/// `box_blur_into` and retain the scratch `tmp` plane across calls — that mirrors the
/// `dn2`/`dn2_into` pairing and avoids one full-plane allocation per scale.
pub(crate) fn box_blur(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let n = w * h;
    // Zero-extent plane is a no-op: with w==0 (or h==0) the passes would index
    // an empty buffer (src[0]) and underflow `w - 1`/`h - 1` to usize::MAX.
    if n == 0 {
        return Vec::new();
    }
    let mut tmp = vec![0f32; n];
    let mut dst = vec![0f32; n];
    box_blur_core(src, &mut tmp, &mut dst, w, h, r);
    dst
}

/// Box blur into caller-owned scratch (`tmp`) and output (`dst`) planes, each of
/// length >= w*h. Lets the caller reuse one `tmp` buffer across repeated blurs
/// instead of allocating a fresh intermediate per call. Output is byte-identical to
/// `box_blur`.
pub(crate) fn box_blur_into(src: &[f32], w: usize, h: usize, r: usize, tmp: &mut [f32], dst: &mut [f32]) {
    let n = w * h;
    if n == 0 {
        return;
    }
    box_blur_core(src, &mut tmp[..n], &mut dst[..n], w, h, r);
}

/// Separable box-blur kernel. `tmp`/`dst` must each be exactly `w*h` long.
fn box_blur_core(src: &[f32], tmp: &mut [f32], dst: &mut [f32], w: usize, h: usize, r: usize) {
    let n = w * h;
    // Pin extents so the rolling passes are bounds-check-free on the hot inner loops.
    let src = &src[..n];
    let tmp = &mut tmp[..n];
    let dst = &mut dst[..n];
    let inv = 1.0 / (2 * r + 1) as f32;
    let edge = r as f32 + 1.0; // hoisted (was recomputed per row / per tile)

    // Horizontal. The original loop ran the rolling `sum += add - sub` update once more
    // after the final write — a value never read. Splitting the loop at `w_max` drops
    // that dead add/sub/min/saturating_sub per row. Byte-exact (the omitted update only
    // affected the discarded post-tail `sum`).
    let w_max = w - 1;
    for y in 0..h {
        let base = y * w;
        let row = &src[base..base + w];
        let out = &mut tmp[base..base + w];
        let mut sum = row[0] * edge;
        for k in 1..=r {
            sum += row[k.min(w_max)];
        }
        for x in 0..w_max {
            out[x] = sum * inv;
            sum += row[(x + r + 1).min(w_max)] - row[x.saturating_sub(r)];
        }
        out[w_max] = sum * inv;
    }

    // Vertical: process TILE columns at a time to improve cache locality.
    // The naive column-by-column loop accesses memory at stride w (up to 16 KB
    // per step at w=4096), thrashing L1. Tiling processes TILE adjacent columns
    // together so each y-step reads/writes TILE consecutive floats — reducing
    // cache-line evictions by TILE×. Same dead-final-update elision as above.
    const TILE: usize = 8;
    let h_max = h - 1;
    let mut x = 0usize;
    while x + TILE <= w {
        let mut sums = [0f32; TILE];
        for t in 0..TILE {
            sums[t] = tmp[x + t] * edge;
        }
        for k in 1..=r {
            let row = k.min(h_max) * w;
            for t in 0..TILE {
                sums[t] += tmp[row + x + t];
            }
        }
        for y in 0..h_max {
            let drow = y * w;
            for t in 0..TILE {
                dst[drow + x + t] = sums[t] * inv;
            }
            let add_row = (y + r + 1).min(h_max) * w;
            let sub_row = y.saturating_sub(r) * w;
            for t in 0..TILE {
                sums[t] += tmp[add_row + x + t] - tmp[sub_row + x + t];
            }
        }
        let last = h_max * w;
        for t in 0..TILE {
            dst[last + x + t] = sums[t] * inv;
        }
        x += TILE;
    }
    // Scalar remainder for columns that don't fill a full tile.
    for col in x..w {
        let mut sum = tmp[col] * edge;
        for k in 1..=r {
            sum += tmp[k.min(h_max) * w + col];
        }
        for y in 0..h_max {
            dst[y * w + col] = sum * inv;
            sum += tmp[(y + r + 1).min(h_max) * w + col] - tmp[y.saturating_sub(r) * w + col];
        }
        dst[h_max * w + col] = sum * inv;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_field_is_preserved() {
        let w = 8; let h = 6;
        let src = vec![3.5f32; w * h];
        let out = box_blur(&src, w, h, 2);
        for v in out {
            assert!((v - 3.5).abs() < 1e-4);
        }
    }

    #[test]
    fn radius_one_averages_neighbors_interior() {
        // 1-row impulse, interior pixel should be (0+9+0)/3 = 3 after H pass only;
        // with H+V on a single row, V pass clamps to itself → stays.
        let w = 5; let h = 1;
        let mut src = vec![0f32; w];
        src[2] = 9.0;
        let out = box_blur(&src, w, h, 1);
        assert!((out[2] - 3.0).abs() < 1e-4, "got {}", out[2]);
        assert!((out[1] - 3.0).abs() < 1e-4, "got {}", out[1]);
    }
}
