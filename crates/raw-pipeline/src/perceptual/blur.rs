//! Separable O(n) box blur, clamp-to-edge. Port of the JS `boxBlur`.

/// Box blur of `src` (w×h) with radius `r` into a fresh Vec.
pub(crate) fn box_blur(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let n = w * h;
    // Zero-extent plane is a no-op: with w==0 (or h==0) the passes would index
    // an empty buffer (src[0]) and underflow `w - 1`/`h - 1` to usize::MAX.
    if n == 0 {
        return Vec::new();
    }
    let mut tmp = vec![0f32; n];
    let mut dst = vec![0f32; n];
    let inv = 1.0 / (2 * r + 1) as f32;

    // Horizontal
    for y in 0..h {
        let base = y * w;
        let mut sum = src[base] * (r as f32 + 1.0);
        for k in 1..=r {
            sum += src[base + k.min(w - 1)];
        }
        for x in 0..w {
            tmp[base + x] = sum * inv;
            let add = src[base + (x + r + 1).min(w - 1)];
            let sub = src[base + x.saturating_sub(r)];
            sum += add - sub;
        }
    }

    // Vertical
    for x in 0..w {
        let mut sum = tmp[x] * (r as f32 + 1.0);
        for k in 1..=r {
            sum += tmp[k.min(h - 1) * w + x];
        }
        for y in 0..h {
            dst[y * w + x] = sum * inv;
            let add = tmp[(y + r + 1).min(h - 1) * w + x];
            let sub = tmp[y.saturating_sub(r) * w + x];
            sum += add - sub;
        }
    }

    dst
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
