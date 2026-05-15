// Blur vertical-pass benchmark: naive vs tiled vs transpose.
// Run: cargo run --bin blur_bench --release
//
// Tests 13-tap Gaussian (clarity kernel) on a 5240×3912 synthetic image
// — same dimensions as P1100157.ORF.

use std::time::Instant;

const W: usize = 5240;
const H: usize = 3912;

fn k13() -> [f32; 13] {
    [0.0185, 0.0342, 0.0563, 0.0831, 0.1097, 0.1296,
     0.1370,
     0.1296, 0.1097, 0.0831, 0.0563, 0.0342, 0.0185]
}

// Shared: horizontal pass (both methods need this; access is row-major → cache-friendly).
fn h_pass(src: &[u16], w: usize, h: usize, k: &[f32], dst: &mut [u16]) {
    let half = k.len() / 2;
    for y in 0..h {
        for x in 0..w {
            let mut acc = [0f32; 3];
            for (ki, &kv) in k.iter().enumerate() {
                let xi = (x as isize + ki as isize - half as isize).clamp(0, w as isize - 1) as usize;
                let b = (y * w + xi) * 3;
                acc[0] += src[b]   as f32 * kv;
                acc[1] += src[b+1] as f32 * kv;
                acc[2] += src[b+2] as f32 * kv;
            }
            let b = (y * w + x) * 3;
            dst[b]   = acc[0].round() as u16;
            dst[b+1] = acc[1].round() as u16;
            dst[b+2] = acc[2].round() as u16;
        }
    }
}

// CURRENT: naive vertical pass — stride = w*3*2 bytes per kernel tap.
fn v_pass_naive(src: &[u16], w: usize, h: usize, k: &[f32], dst: &mut [u16]) {
    let half = k.len() / 2;
    for y in 0..h {
        for x in 0..w {
            let mut acc = [0f32; 3];
            for (ki, &kv) in k.iter().enumerate() {
                let yi = (y as isize + ki as isize - half as isize).clamp(0, h as isize - 1) as usize;
                let b = (yi * w + x) * 3;
                acc[0] += src[b]   as f32 * kv;
                acc[1] += src[b+1] as f32 * kv;
                acc[2] += src[b+2] as f32 * kv;
            }
            let b = (y * w + x) * 3;
            dst[b]   = acc[0].round() as u16;
            dst[b+1] = acc[1].round() as u16;
            dst[b+2] = acc[2].round() as u16;
        }
    }
}

// OPTION A: tiled vertical — process TILE columns at once so the working set
// (TILE * kernel_len * 3 * 2 bytes) fits in L1 cache.
fn v_pass_tiled<const TILE: usize>(src: &[u16], w: usize, h: usize, k: &[f32], dst: &mut [u16]) {
    let half = k.len() / 2;
    for y in 0..h {
        for x0 in (0..w).step_by(TILE) {
            let x1 = (x0 + TILE).min(w);
            let tile = x1 - x0;
            let mut acc = [[0f32; 3]; TILE];
            for (ki, &kv) in k.iter().enumerate() {
                let yi = (y as isize + ki as isize - half as isize).clamp(0, h as isize - 1) as usize;
                let row = yi * w * 3;
                for xi in 0..tile {
                    let b = row + (x0 + xi) * 3;
                    acc[xi][0] += src[b]   as f32 * kv;
                    acc[xi][1] += src[b+1] as f32 * kv;
                    acc[xi][2] += src[b+2] as f32 * kv;
                }
            }
            for xi in 0..tile {
                let b = (y * w + x0 + xi) * 3;
                dst[b]   = acc[xi][0].round() as u16;
                dst[b+1] = acc[xi][1].round() as u16;
                dst[b+2] = acc[xi][2].round() as u16;
            }
        }
    }
}

// OPTION B: transpose → horizontal → transpose back.
// Uses a cache-tiled 32×32 block transpose.
fn transpose_tiled(src: &[u16], sw: usize, sh: usize, dst: &mut [u16]) {
    const T: usize = 32;
    for ty in (0..sh).step_by(T) {
        for tx in (0..sw).step_by(T) {
            for y in ty..(ty + T).min(sh) {
                for x in tx..(tx + T).min(sw) {
                    let si = (y * sw + x) * 3;
                    let di = (x * sh + y) * 3;
                    dst[di]   = src[si];
                    dst[di+1] = src[si+1];
                    dst[di+2] = src[si+2];
                }
            }
        }
    }
}

fn v_pass_via_transpose(
    src: &[u16], w: usize, h: usize, k: &[f32],
    dst: &mut [u16], s1: &mut Vec<u16>, s2: &mut Vec<u16>,
) {
    let n = w * h * 3;
    s1.resize(n, 0);
    s2.resize(n, 0);
    transpose_tiled(src, w, h, s1);       // W×H → H×W
    h_pass(s1, h, w, k, s2);             // horizontal on transposed
    transpose_tiled(s2, h, w, dst);       // H×W → W×H
}

fn time_fn(name: &str, runs: usize, mut f: impl FnMut()) {
    // 1 warmup, then `runs` timed runs
    f();
    let mut ms: Vec<f64> = (0..runs).map(|_| {
        let t = Instant::now();
        f();
        t.elapsed().as_secs_f64() * 1000.0
    }).collect();
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("  {:30}  min={:6.0}ms  med={:6.0}ms  max={:6.0}ms",
             name, ms[0], ms[runs / 2], ms[runs - 1]);
}

fn main() {
    let n = W * H * 3;
    let mb = n as f64 * 2.0 / 1024.0 / 1024.0;
    println!("Image: {}×{} ({:.0} MP), rgb16 = {:.0} MB", W, H, (W*H) as f64 / 1e6, mb);
    println!("Kernel: 13-tap (clarity). Runs = 5.\n");

    let kernel = k13();
    let src: Vec<u16> = (0..n).map(|i| (i % 65536) as u16).collect();
    let mut temp = vec![0u16; n];
    let mut out  = vec![0u16; n];
    let mut s1: Vec<u16> = Vec::new();
    let mut s2: Vec<u16> = Vec::new();

    // Pre-compute horizontal pass (shared; not under comparison here).
    h_pass(&src, W, H, &kernel, &mut temp);

    println!("Vertical pass only (after shared horizontal pass):");
    time_fn("naive (current)", 5, || v_pass_naive(&temp, W, H, &kernel, &mut out));
    time_fn("tiled-16", 5,        || v_pass_tiled::<16>(&temp, W, H, &kernel, &mut out));
    time_fn("tiled-32", 5,        || v_pass_tiled::<32>(&temp, W, H, &kernel, &mut out));
    time_fn("tiled-64", 5,        || v_pass_tiled::<64>(&temp, W, H, &kernel, &mut out));
    time_fn("tiled-128", 5,       || v_pass_tiled::<128>(&temp, W, H, &kernel, &mut out));
    time_fn("transpose+hpass+T", 5, || v_pass_via_transpose(&temp, W, H, &kernel, &mut out, &mut s1, &mut s2));

    println!("\nFull blur round-trip (h_pass + v_pass):");
    time_fn("current (h+v naive)", 5, || {
        h_pass(&src, W, H, &kernel, &mut temp);
        v_pass_naive(&temp, W, H, &kernel, &mut out);
    });
    time_fn("h+v tiled-64", 5, || {
        h_pass(&src, W, H, &kernel, &mut temp);
        v_pass_tiled::<64>(&temp, W, H, &kernel, &mut out);
    });
    time_fn("h+transpose+h+T", 5, || {
        h_pass(&src, W, H, &kernel, &mut temp);
        v_pass_via_transpose(&temp, W, H, &kernel, &mut out, &mut s1, &mut s2);
    });
}
