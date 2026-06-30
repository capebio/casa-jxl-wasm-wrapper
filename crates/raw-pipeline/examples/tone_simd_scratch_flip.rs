//! tone_simd_scratch_flip — thermal-cancelled A/B for the parallel SIMD tone path
//! (`pipeline::process_into_simd` / `process_16bit_simd`).
//!
//! PIPE-014. The parallel block loop deinterleaves each 2048-pixel block into r/g/b f32
//! SoA scratch, runs `tone_simd::apply_tone_bulk`, then reinterleaves through the post-LUT.
//! Question: does allocating + zeroing the `[0f32; BLK] × 3` scratch *inside* every block
//! closure cost anything measurable vs. giving each Rayon worker one reusable triple via
//! `for_each_init`?
//!
//!   A = current:  `let mut r = [0f32; BLK]; ...` per block (per-block stack zero).
//!   B = PIPE-014: `for_each_init(|| (vec![…]×3), |(r,g,b), …| …)` — zeroed ~once per worker.
//!
//! Both call the IDENTICAL kernel (deinterleave → apply_tone_bulk → reinterleave), so output
//! is byte-exact; only the scratch lifetime differs. Interleaved start-rotated rounds, round 0
//! dropped, median + %saved. MUST run with the `parallel` feature (that is the path changed).
//!
//! Run: cd crates/raw-pipeline && \
//!      cargo run --release --no-default-features --features parallel --example tone_simd_scratch_flip

use rayon::prelude::*;
use raw_pipeline::tone_simd::{apply_tone_bulk, vib_zero_matrix};
use std::time::Instant;

const BLK: usize = 2048;

const CAM: [[f32; 3]; 3] = [
    [1.526, -0.450, -0.077],
    [-0.245, 1.336, -0.091],
    [0.018, -0.298, 1.281],
];

#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn kernel(
    ob: &mut [u8],
    ib: &[u16],
    r: &mut [f32],
    g: &mut [f32],
    b: &mut [f32],
    pre_r: &[u16],
    pre_g: &[u16],
    pre_b: &[u16],
    post: &[u8],
    m: &[[f32; 3]; 3],
    sat: f32,
    vib: f32,
    vib_zero: bool,
) {
    let np = ib.len() / 3;
    for i in 0..np {
        r[i] = pre_r[ib[i * 3] as usize] as f32;
        g[i] = pre_g[ib[i * 3 + 1] as usize] as f32;
        b[i] = pre_b[ib[i * 3 + 2] as usize] as f32;
    }
    apply_tone_bulk(&mut r[..np], &mut g[..np], &mut b[..np], m, sat, vib, vib_zero);
    for i in 0..np {
        ob[i * 3] = post[(r[i].clamp(0.0, 65535.0) as u16) as usize];
        ob[i * 3 + 1] = post[(g[i].clamp(0.0, 65535.0) as u16) as usize];
        ob[i * 3 + 2] = post[(b[i].clamp(0.0, 65535.0) as u16) as usize];
    }
}

#[allow(clippy::too_many_arguments)]
fn run_a(
    out: &mut [u8], rgb16: &[u16],
    pre_r: &[u16], pre_g: &[u16], pre_b: &[u16], post: &[u8],
    m: &[[f32; 3]; 3], sat: f32, vib: f32, vib_zero: bool,
) {
    out.par_chunks_mut(3 * BLK)
        .zip(rgb16.par_chunks(3 * BLK))
        .for_each(|(ob, ib)| {
            let mut r = [0f32; BLK];
            let mut g = [0f32; BLK];
            let mut b = [0f32; BLK];
            kernel(ob, ib, &mut r, &mut g, &mut b, pre_r, pre_g, pre_b, post, m, sat, vib, vib_zero);
        });
}

#[allow(clippy::too_many_arguments)]
fn run_b(
    out: &mut [u8], rgb16: &[u16],
    pre_r: &[u16], pre_g: &[u16], pre_b: &[u16], post: &[u8],
    m: &[[f32; 3]; 3], sat: f32, vib: f32, vib_zero: bool,
) {
    out.par_chunks_mut(3 * BLK)
        .zip(rgb16.par_chunks(3 * BLK))
        .for_each_init(
            || (vec![0f32; BLK], vec![0f32; BLK], vec![0f32; BLK]),
            |(r, g, b), (ob, ib)| {
                kernel(ob, ib, r, g, b, pre_r, pre_g, pre_b, post, m, sat, vib, vib_zero);
            },
        );
}

fn median(v: &[f64]) -> f64 {
    let mut w: Vec<f64> = v[1..].to_vec();
    w.sort_by(|a, b| a.partial_cmp(b).unwrap());
    w[w.len() / 2]
}

fn run_case(label: &str, w: usize, h: usize) {
    // Deterministic 14-bit corpus.
    let mut lcg: u32 = 0xdead_beef;
    let mut rgb16 = vec![0u16; w * h * 3];
    for px in rgb16.iter_mut() {
        lcg = lcg.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *px = ((lcg >> 16) & 0x3fff) as u16;
    }

    // pre-LUT: simple monotone linearisation; post-LUT: sRGB-ish ramp. Values are irrelevant to
    // the scratch question; only that A and B share them so parity holds.
    let pre_r: Vec<u16> = (0..65536).map(|i| ((i as u32 * 65535 / 16383).min(65535)) as u16).collect();
    let pre_g = pre_r.clone();
    let pre_b = pre_r.clone();
    let post: Vec<u8> = (0..65536).map(|i| (i >> 8) as u8).collect();

    // vib_zero default path (the 90% ingest case) — fused S·M matrix.
    let sat = 1.30f32;
    let m = vib_zero_matrix(&CAM, sat);
    let (vib, vib_zero) = (0.0f32, true);

    let mut da = vec![0u8; w * h * 3];
    let mut db = vec![0u8; w * h * 3];
    run_a(&mut da, &rgb16, &pre_r, &pre_g, &pre_b, &post, &m, sat, vib, vib_zero);
    run_b(&mut db, &rgb16, &pre_r, &pre_g, &pre_b, &post, &m, sat, vib, vib_zero);
    let parity = da == db;

    let rounds = 11usize;
    let (mut ta, mut tb) = (Vec::new(), Vec::new());
    let mut sink = 0u64;
    let mut scratch = vec![0u8; w * h * 3];
    for r in 0..rounds {
        let do_a = |scratch: &mut [u8], sink: &mut u64| {
            let t = Instant::now();
            run_a(scratch, &rgb16, &pre_r, &pre_g, &pre_b, &post, &m, sat, vib, vib_zero);
            *sink = sink.wrapping_add(scratch[scratch.len() / 2] as u64);
            t.elapsed().as_secs_f64() * 1e3
        };
        let do_b = |scratch: &mut [u8], sink: &mut u64| {
            let t = Instant::now();
            run_b(scratch, &rgb16, &pre_r, &pre_g, &pre_b, &post, &m, sat, vib, vib_zero);
            *sink = sink.wrapping_add(scratch[scratch.len() / 2] as u64);
            t.elapsed().as_secs_f64() * 1e3
        };
        if r % 2 == 0 {
            ta.push(do_a(&mut scratch, &mut sink));
            tb.push(do_b(&mut scratch, &mut sink));
        } else {
            tb.push(do_b(&mut scratch, &mut sink));
            ta.push(do_a(&mut scratch, &mut sink));
        }
    }
    std::hint::black_box(sink);

    let (ma, mb) = (median(&ta), median(&tb));
    let saved = (ma - mb) / ma * 100.0;
    let mp = (w * h) as f64 / 1e6;
    println!(
        "{label:>16} {w:>5}×{h:<5} ({mp:>4.1} MP) | A {ma:>7.3}ms  B {mb:>7.3}ms  saved {saved:>6.1}%  parity {}",
        if parity { "EXACT" } else { "*** BROKEN ***" }
    );
}

fn main() {
    let threads = rayon::current_num_threads();
    println!("tone_simd scratch flip — A=per-block stack scratch  B=for_each_init reuse (PIPE-014)");
    println!("rayon workers: {threads}\n");
    run_case("4 MP", 2464, 1632);
    run_case("12 MP", 4240, 2832);
    run_case("24 MP", 6000, 4000);
    run_case("48 MP", 8000, 6000);
    println!("\nGate: B not a regression ⇒ keep (eliminates per-block scratch zero; helps low-bandwidth WASM most).");
}
