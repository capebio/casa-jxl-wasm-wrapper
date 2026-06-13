//! End-to-end per-stage profile of the ORF → RGB8 pipeline. Locates the real
//! cost center (decompress / demosaic / tone) on a real file.
//!
//! Run: cargo run -p raw-pipeline --release --no-default-features \
//!        --example pipeline_profile -- <path-to.orf>
//! Default file: C:/Foo/raw-converter/tests/P1110226.ORF

use raw_pipeline::tiff::{bench_pipeline_orf, bench_tone_split_orf};
use std::fs;

fn med(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "C:/Foo/raw-converter/tests/P1110226.ORF".to_string());
    let data = fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    println!("profiling {} ({} KB)", path, data.len() / 1024);

    let _ = bench_pipeline_orf(&data).expect("decode (warmup)");
    let runs = 7;
    let (mut dec, mut dem, mut tone) = (Vec::new(), Vec::new(), Vec::new());
    let mut wh = (0u32, 0u32);
    for _ in 0..runs {
        let b = bench_pipeline_orf(&data).expect("decode");
        dec.push(b.decompress_ms);
        dem.push(b.demosaic_ms);
        tone.push(b.tone_ms);
        wh = (b.width, b.height);
    }
    let (d, m, t) = (med(dec), med(dem), med(tone));
    let total = d + m + t;
    let mp = wh.0 as f64 * wh.1 as f64 / 1e6;
    println!("{}x{}  ({:.1} MP), median of {} runs", wh.0, wh.1, mp, runs);
    println!("  decompress {:9.2} ms  {:5.1}%", d, 100.0 * d / total);
    println!("  demosaic   {:9.2} ms  {:5.1}%", m, 100.0 * m / total);
    println!("  tone       {:9.2} ms  {:5.1}%", t, 100.0 * t / total);
    println!("  ───────────────────────────────");
    println!("  TOTAL      {:9.2} ms  ({:.1} ms/MP)", total, total / mp);

    // Sub-profile the tone pass (single-thread): apply_tone_math vs LUT gather.
    let _ = bench_tone_split_orf(&data);
    let (mut full, mut luto) = (Vec::new(), Vec::new());
    for _ in 0..runs {
        let (f, l) = bench_tone_split_orf(&data).expect("tone split");
        full.push(f);
        luto.push(l);
    }
    let (f, l) = (med(full), med(luto));
    let math = (f - l).max(0.0);
    println!("\ntone sub-profile (single-thread, median of {}):", runs);
    println!("  LUT gather+store {:9.2} ms  {:5.1}%", l, 100.0 * l / f);
    println!("  apply_tone_math  {:9.2} ms  {:5.1}%  (matrix + sat/vibrance + divide)", math, 100.0 * math / f);
    println!("  tone full        {:9.2} ms", f);
}
