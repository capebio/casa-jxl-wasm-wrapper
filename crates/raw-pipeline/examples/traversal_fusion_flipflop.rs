//! Flipflop benchmark: separate frame stats + histogram vs. fused single-pass kernel.
//! Measures memory bandwidth savings of fusing two independent RGBA8 traversals.
//!
//! Run: cargo --release run --example traversal_fusion_flipflop --no-default-features

use raw_pipeline::frame_stats;
use raw_pipeline::perceptual::telemetry;

fn mkbuf(px: usize, seed: u32) -> Vec<u8> {
    let mut d = vec![0u8; px * 4];
    let mut s = seed;
    for slot in d.iter_mut() {
        s = s.wrapping_mul(1103515245).wrapping_add(12345);
        *slot = (s & 0xff) as u8;
    }
    d
}

fn main() {
    let sizes = [
        (1920usize, 1280usize, "2.46MP"),
        (3840usize, 2560usize, "9.83MP"),
        (6016usize, 4016usize, "24.16MP"),
    ];

    #[cfg(target_arch = "x86_64")]
    let has_avx2 = is_x86_feature_detected!("avx2");
    #[cfg(not(target_arch = "x86_64"))]
    let has_avx2 = false;

    println!("\n=== TRAVERSAL FUSION: separate vs fused (min ms/call) === avx2={}\n", has_avx2);

    for (w, h, label) in sizes {
        let px = w * h;
        let buf = mkbuf(px, 7);

        // Separate traversals: frame_stats + histogram (2 passes).
        let separate_passes = |_: &Vec<u8>| {
            // Pass 1: frame stats
            let _stats = frame_stats::analyze(&buf, w, h);
            // Pass 2: histogram (simulated as a separate traversal)
            let mut hist_r = [0u32; 256];
            let mut hist_g = [0u32; 256];
            let mut hist_b = [0u32; 256];
            for chunk in buf.chunks(4) {
                if chunk.len() == 4 {
                    hist_r[chunk[0] as usize] += 1;
                    hist_g[chunk[1] as usize] += 1;
                    hist_b[chunk[2] as usize] += 1;
                }
            }
            (hist_r, hist_g, hist_b)
        };

        // Fused pass: single traversal computes both.
        let fused_pass = |_: &Vec<u8>| telemetry::analyze_fused(&buf, w, h);

        // Benchmark helper.
        let bench = |name: &str, f: &dyn Fn(&Vec<u8>)| -> f64 {
            // Warmup
            for _ in 0..4 {
                std::hint::black_box(f(&buf));
            }
            // Measure
            let mut best = f64::INFINITY;
            for _ in 0..10 {
                let t = std::time::Instant::now();
                for _ in 0..8 {
                    std::hint::black_box(f(&buf));
                }
                let ms = t.elapsed().as_secs_f64() * 1000.0 / 8.0;
                if ms < best {
                    best = ms;
                }
            }
            println!("  {}: {:.3} ms", name, best);
            best
        };

        let sep = bench("separate (2 passes)", &|buf| {
            std::hint::black_box(separate_passes(buf));
        });
        let fused = bench("fused (1 pass)", &|buf| {
            std::hint::black_box(fused_pass(buf));
        });

        let speedup = sep / fused;
        let bandwidth_saved = (1.0 - (fused / sep)) * 100.0;
        println!("  {} speedup: {:.2}x   bandwidth saved: {:.1}%\n", label, speedup, bandwidth_saved);
    }
}
