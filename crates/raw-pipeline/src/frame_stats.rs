//! Native frame-stats telemetry kernel (server path). RGBA8 single-pass reduction:
//! alpha min/max, alpha-zero count, rgb-nonzero count, luma mean/variance accumulators,
//! and an 8-lane word-hash (content-sensitive change id). Mirrors the wasm `frame_stats`
//! kernel in raw-converter-wasm/src/lib.rs, but here the server can use AVX2 (256-bit).
//!
//! The hash is a de-serialized word-hash (8 independent lanes by pixel index % 8) — the
//! audit of frameHash consumers showed the value never escapes a single run, so the
//! algorithm is free; this form vectorizes (one xor + one mul per 8 px on AVX2).
//!
//! scalar and avx2 produce bit-identical results (the bench asserts it).

const PRIME: u32 = 0x0100_0193;
const OFFSET: u32 = 0x811c_9dc5;

#[inline]
fn lane_seed(k: u32) -> u32 {
    // 8 distinct, well-spread seeds.
    OFFSET ^ k.wrapping_mul(0x9e37_79b9)
}

#[inline]
fn combine_lanes(lanes: &[u32; 8]) -> u32 {
    let mut h = OFFSET;
    for &l in lanes.iter() {
        h = (h ^ l).wrapping_mul(PRIME);
    }
    h
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameStats {
    pub alpha_min: u32,
    pub alpha_max: u32,
    pub alpha_zero: u32,
    pub rgb_nonzero: u32,
    pub luma_sum: f64,
    pub luma_sq: f64,
    pub hash: u32,
    pub pixel_count: usize,
}

impl FrameStats {
    pub fn mean_luma(&self) -> f64 {
        if self.pixel_count == 0 { 0.0 } else { self.luma_sum / self.pixel_count as f64 }
    }
    pub fn luma_variance(&self) -> f64 {
        if self.pixel_count == 0 { return 0.0; }
        let m = self.mean_luma();
        ((self.luma_sq / self.pixel_count as f64) - m * m).max(0.0) / 65536.0
    }
}

/// Portable scalar kernel. 8-lane word-hash (matches AVX2). Tail-safe.
pub fn analyze_scalar(d: &[u8], px: usize) -> FrameStats {
    let (mut a_min, mut a_max, mut a_zero, mut rgb_nz) = (255u32, 0u32, 0u32, 0u32);
    let (mut l_sum, mut l_sq) = (0f64, 0f64);
    let mut lanes = [
        lane_seed(0), lane_seed(1), lane_seed(2), lane_seed(3),
        lane_seed(4), lane_seed(5), lane_seed(6), lane_seed(7),
    ];
    for p in 0..px {
        let i = p * 4;
        let r = d[i] as u32;
        let g = d[i + 1] as u32;
        let b = d[i + 2] as u32;
        let a = d[i + 3] as u32;
        let w = u32::from_le_bytes([d[i], d[i + 1], d[i + 2], d[i + 3]]);
        let lane = p & 7;
        lanes[lane] = (lanes[lane] ^ w).wrapping_mul(PRIME);
        rgb_nz += (r != 0) as u32 + (g != 0) as u32 + (b != 0) as u32;
        if a < a_min { a_min = a; }
        if a > a_max { a_max = a; }
        if a == 0 { a_zero += 1; }
        let l = 54 * r + 183 * g + 18 * b;
        let lf = l as f64;
        l_sum += lf;
        l_sq += lf * lf;
    }
    if px == 0 { a_min = 255; a_max = 0; }
    FrameStats {
        alpha_min: a_min, alpha_max: a_max, alpha_zero: a_zero, rgb_nonzero: rgb_nz,
        luma_sum: l_sum, luma_sq: l_sq, hash: combine_lanes(&lanes), pixel_count: px,
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn analyze_avx2(d: &[u8], px: usize) -> FrameStats {
    use core::arch::x86_64::*;

    let chunks = px / 8; // 8 px = 32 bytes per __m256i
    let (mut a_zero, mut rgb_nz) = (0u32, 0u32);
    let (mut l_sum, mut l_sq) = (0f64, 0f64);

    // 8-lane word-hash, fully vectorized (lane k accumulates pixels where p%8==k).
    let mut hv = _mm256_setr_epi32(
        lane_seed(0) as i32, lane_seed(1) as i32, lane_seed(2) as i32, lane_seed(3) as i32,
        lane_seed(4) as i32, lane_seed(5) as i32, lane_seed(6) as i32, lane_seed(7) as i32,
    );
    let prime_v = _mm256_set1_epi32(PRIME as i32);

    // alpha min/max via masked u8 reductions; RGB lanes neutralized.
    let rgb_or = _mm256_set1_epi32(0x00FF_FFFFu32 as i32);  // bytes r,g,b -> 0xff, a -> 0x00
    let alpha_and = _mm256_set1_epi32(0xFF00_0000u32 as i32); // a kept, r,g,b -> 0
    let mut vmin = _mm256_set1_epi8(-1); // 0xff
    let mut vmax = _mm256_setzero_si256();
    let zero = _mm256_setzero_si256();

    // luma weights [54,183,18,0] repeated; madd_epi16 over u16-extended pixels.
    let wv = _mm256_set_epi16(
        0, 18, 183, 54, 0, 18, 183, 54, 0, 18, 183, 54, 0, 18, 183, 54,
    );

    let mut arr_lo = [0i32; 8];
    let mut arr_hi = [0i32; 8];

    for c in 0..chunks {
        let pv = _mm256_loadu_si256(d.as_ptr().add(c * 32) as *const __m256i);

        // hash: lanes ^= pixel_words; lanes *= prime
        hv = _mm256_mullo_epi32(_mm256_xor_si256(hv, pv), prime_v);

        // alpha min/max
        vmin = _mm256_min_epu8(vmin, _mm256_or_si256(pv, rgb_or));
        vmax = _mm256_max_epu8(vmax, _mm256_and_si256(pv, alpha_and));

        // zero bytes -> 32-bit mask
        let zmask = _mm256_movemask_epi8(_mm256_cmpeq_epi8(pv, zero)) as u32;
        a_zero += (zmask & 0x8888_8888).count_ones();          // alpha bytes (3,7,...,31)
        rgb_nz += 24 - (zmask & 0x7777_7777).count_ones();     // 24 rgb bytes / 8 px

        // luma: widen 2x4px halves to u16, madd by weights -> i32 pairs, combine
        let lo16 = _mm256_cvtepu8_epi16(_mm256_castsi256_si128(pv));     // first 4 px
        let hi16 = _mm256_cvtepu8_epi16(_mm256_extracti128_si256(pv, 1)); // next 4 px
        _mm256_storeu_si256(arr_lo.as_mut_ptr() as *mut __m256i, _mm256_madd_epi16(lo16, wv));
        _mm256_storeu_si256(arr_hi.as_mut_ptr() as *mut __m256i, _mm256_madd_epi16(hi16, wv));
        // each pixel = two adjacent i32 lanes summed
        let luma = [
            arr_lo[0] + arr_lo[1], arr_lo[2] + arr_lo[3], arr_lo[4] + arr_lo[5], arr_lo[6] + arr_lo[7],
            arr_hi[0] + arr_hi[1], arr_hi[2] + arr_hi[3], arr_hi[4] + arr_hi[5], arr_hi[6] + arr_hi[7],
        ];
        for &lz in luma.iter() {
            let lf = lz as f64;
            l_sum += lf;
            l_sq += lf * lf;
        }
    }

    // reduce alpha min/max over alpha lanes only
    let mut mins = [0u8; 32];
    let mut maxs = [0u8; 32];
    _mm256_storeu_si256(mins.as_mut_ptr() as *mut __m256i, vmin);
    _mm256_storeu_si256(maxs.as_mut_ptr() as *mut __m256i, vmax);
    let mut a_min = 255u32;
    let mut a_max = 0u32;
    let mut k = 3;
    while k < 32 {
        if (mins[k] as u32) < a_min { a_min = mins[k] as u32; }
        if (maxs[k] as u32) > a_max { a_max = maxs[k] as u32; }
        k += 4;
    }

    // hash lanes back to scalar; fold tail pixels in
    let mut lanes = [0u32; 8];
    _mm256_storeu_si256(lanes.as_mut_ptr() as *mut __m256i, hv);

    for p in (chunks * 8)..px {
        let i = p * 4;
        let r = d[i] as u32;
        let g = d[i + 1] as u32;
        let b = d[i + 2] as u32;
        let a = d[i + 3] as u32;
        let w = u32::from_le_bytes([d[i], d[i + 1], d[i + 2], d[i + 3]]);
        let lane = p & 7;
        lanes[lane] = (lanes[lane] ^ w).wrapping_mul(PRIME);
        rgb_nz += (r != 0) as u32 + (g != 0) as u32 + (b != 0) as u32;
        if a < a_min { a_min = a; }
        if a > a_max { a_max = a; }
        if a == 0 { a_zero += 1; }
        let l = 54 * r + 183 * g + 18 * b;
        let lf = l as f64;
        l_sum += lf;
        l_sq += lf * lf;
    }
    if px == 0 { a_min = 255; a_max = 0; }

    FrameStats {
        alpha_min: a_min, alpha_max: a_max, alpha_zero: a_zero, rgb_nonzero: rgb_nz,
        luma_sum: l_sum, luma_sq: l_sq, hash: combine_lanes(&lanes), pixel_count: px,
    }
}

/// Runtime-dispatched entry. Uses AVX2 when present, else the scalar kernel.
pub fn analyze(pixels: &[u8], width: usize, height: usize) -> FrameStats {
    let px = width.saturating_mul(height);
    let limit = pixels.len().min(px * 4);
    // Truncated buffers fall back to scalar (zero-fill semantics not needed server-side;
    // a complete frame is the norm). Guard against under-length to avoid OOB.
    if limit < px * 4 {
        return analyze_scalar(&zero_padded(pixels, px * 4), px);
    }
    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("avx2") {
            return unsafe { analyze_avx2(pixels, px) };
        }
    }
    analyze_scalar(pixels, px)
}

#[cfg(target_arch = "x86_64")]
fn zero_padded(src: &[u8], len: usize) -> Vec<u8> {
    let mut v = vec![0u8; len];
    let n = src.len().min(len);
    v[..n].copy_from_slice(&src[..n]);
    v
}
#[cfg(not(target_arch = "x86_64"))]
fn zero_padded(src: &[u8], len: usize) -> Vec<u8> {
    let mut v = vec![0u8; len];
    let n = src.len().min(len);
    v[..n].copy_from_slice(&src[..n]);
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn mkbuf(px: usize, seed: u32) -> Vec<u8> {
        let mut d = vec![0u8; px * 4];
        let mut s = seed;
        for slot in d.iter_mut() {
            s = s.wrapping_mul(1103515245).wrapping_add(12345);
            *slot = (s & 0xff) as u8;
        }
        d
    }

    #[test]
    fn scalar_avx2_parity() {
        for (w, h) in [(64usize, 48usize), (101, 49), (1920, 1280)] {
            let buf = mkbuf(w * h, (w + h) as u32);
            let sc = analyze_scalar(&buf, w * h);
            #[cfg(target_arch = "x86_64")]
            if is_x86_feature_detected!("avx2") {
                let av = unsafe { analyze_avx2(&buf, w * h) };
                assert_eq!(sc, av, "scalar vs avx2 mismatch at {}x{}", w, h);
            }
        }
    }

    #[test]
    #[ignore] // run explicitly: cargo test --no-default-features --release -- --ignored --nocapture native_bench
    fn native_bench() {
        let sizes = [(1920usize, 1280usize, "2.46MP"), (1024, 1024, "1.05MP")];
        println!("\n=== NATIVE frame-stats: scalar vs AVX2 (min ms/call over trials) ===");
        #[cfg(target_arch = "x86_64")]
        let has_avx2 = is_x86_feature_detected!("avx2");
        #[cfg(not(target_arch = "x86_64"))]
        let has_avx2 = false;
        println!("avx2 available: {}", has_avx2);
        for (w, h, label) in sizes {
            let px = w * h;
            let buf = mkbuf(px, 7);
            let bench = |f: &dyn Fn() -> FrameStats| {
                for _ in 0..8 { std::hint::black_box(f()); }
                let mut best = f64::INFINITY;
                for _ in 0..12 {
                    let t = Instant::now();
                    for _ in 0..10 { std::hint::black_box(f()); }
                    let ms = t.elapsed().as_secs_f64() * 1000.0 / 10.0;
                    if ms < best { best = ms; }
                }
                best
            };
            let sc = bench(&|| analyze_scalar(&buf, px));
            #[cfg(target_arch = "x86_64")]
            let av = if has_avx2 { bench(&|| unsafe { analyze_avx2(&buf, px) }) } else { f64::NAN };
            #[cfg(not(target_arch = "x86_64"))]
            let av = f64::NAN;
            println!(
                "{}: scalar {:.3} ms   avx2 {:.3} ms   speedup {:.2}x",
                label, sc, av, sc / av
            );
        }
    }
}
