//! RAW decode pipeline benchmark: ORF, DNG, and CR2.
//!
//! Run: `cargo run --bin raw_decode_bench --release`
//!
//! Measures each stage independently:
//!   - File I/O (excluded from timing)
//!   - Parse + LJPEG decode (incl. crop for CR2)
//!   - Demosaic (RGGB MHC)
//!   - Tonemap (black/WB/matrix/curve → RGB8)
//!   - Total end-to-end
//!
//! Results are written to stdout and also appended to
//! `benchmark/results.tsv` for tracking over time.

use std::path::Path;
use std::time::{Duration, Instant};

use raw_pipeline::{cr2, demosaic, dng, pipeline};

const RUNS: usize = 3;

fn now() -> Instant {
    Instant::now()
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Run `f` `RUNS` times and return the minimum duration (wall clock).
fn bench<F: Fn() -> T, T>(f: F) -> (Duration, T) {
    let mut best = Duration::MAX;
    let mut last_result: Option<T> = None;
    for _ in 0..RUNS {
        let t = Instant::now();
        let r = f();
        let elapsed = t.elapsed();
        if elapsed < best {
            best = elapsed;
        }
        last_result = Some(r);
    }
    (best, last_result.unwrap())
}

// ─── DNG ─────────────────────────────────────────────────────────────────────

fn bench_dng(path: &str) {
    let Ok(data) = std::fs::read(path) else {
        eprintln!("  [skip] {path} — not found");
        return;
    };
    let size_mb = data.len() as f64 / 1e6;

    // Decode
    let (decode_dur, img) = bench(|| dng::decode_bytes(&data).expect("DNG decode"));

    let w = img.width;
    let h = img.height;
    let mp = w * h;

    // Align + demosaic
    let (raw_aligned, aw, ah) = dng::align_to_rggb(&img.raw, w, h, img.cfa);
    let (demosaic_dur, rgb16) = bench(|| {
        demosaic::demosaic_rggb_mhc(raw_aligned, aw, ah).expect("demosaic")
    });

    // Tonemap
    let mut params = pipeline::PipelineParams::default_olympus();
    params.black = img.black;
    params.white = img.white;
    params.wb_r = img.wb_r;
    params.wb_b = img.wb_b;
    params.color_matrix = img.color_matrix;
    let (tone_dur, rgb8) = bench(|| pipeline::process(&rgb16, &params));

    let name = Path::new(path).file_name().unwrap().to_string_lossy();
    let total = decode_dur + demosaic_dur + tone_dur;
    let mpps = mp as f64 / 1e6 / (ms(demosaic_dur) / 1000.0);

    println!("DNG  {name}");
    println!(
        "  {w}×{h}  {:.1} MB  ({} MP)",
        size_mb,
        mp / 1_000_000
    );
    println!(
        "  decode {:.1}ms  demosaic {:.1}ms ({:.1} MP/s)  tone {:.1}ms  total {:.1}ms",
        ms(decode_dur),
        ms(demosaic_dur),
        mpps,
        ms(tone_dur),
        ms(total)
    );
    println!(
        "  WB R={:.3} B={:.3}  black={}  white={}",
        img.wb_r, img.wb_b, img.black, img.white
    );
    let _ = rgb8.len(); // suppress unused warning
    println!();
}

// ─── CR2 ─────────────────────────────────────────────────────────────────────

fn bench_cr2(path: &str) {
    let Ok(data) = std::fs::read(path) else {
        eprintln!("  [skip] {path} — not found");
        return;
    };
    let size_mb = data.len() as f64 / 1e6;

    // Decode (parse + LJPEG + crop)
    let (decode_dur, img) = bench(|| cr2::decode_bytes(&data).expect("CR2 decode"));

    let w = img.width;
    let h = img.height;
    let mp = w * h;

    // Demosaic — CR2 is always RGGB, no alignment needed
    let (demosaic_dur, rgb16) = bench(|| {
        demosaic::demosaic_rggb_mhc(&img.raw, w, h).expect("demosaic")
    });

    // Tonemap
    let mut params = pipeline::PipelineParams::default_olympus();
    params.black = img.black;
    params.white = img.white;
    params.wb_r = img.wb_r;
    params.wb_b = img.wb_b;
    params.color_matrix = img.color_matrix;
    let (tone_dur, rgb8) = bench(|| pipeline::process(&rgb16, &params));

    let name = Path::new(path).file_name().unwrap().to_string_lossy();
    let total = decode_dur + demosaic_dur + tone_dur;
    let mpps = mp as f64 / 1e6 / (ms(demosaic_dur) / 1000.0);

    println!("CR2  {name}");
    println!(
        "  {w}×{h}  {:.1} MB  ({} MP)",
        size_mb,
        mp / 1_000_000
    );
    println!(
        "  decode {:.1}ms  demosaic {:.1}ms ({:.1} MP/s)  tone {:.1}ms  total {:.1}ms",
        ms(decode_dur),
        ms(demosaic_dur),
        mpps,
        ms(tone_dur),
        ms(total)
    );
    println!(
        "  WB R={:.3} B={:.3}  black={}  white={}  ISO={:?}",
        img.wb_r, img.wb_b, img.black, img.white, img.iso
    );
    let _ = rgb8.len();
    println!();
}

// ─── ORF ─────────────────────────────────────────────────────────────────────

fn bench_orf(path: &str) {
    use raw_pipeline::{decompress, tiff};

    let Ok(data) = std::fs::read(path) else {
        eprintln!("  [skip] {path} — not found");
        return;
    };
    let size_mb = data.len() as f64 / 1e6;

    // Parse
    let (parse_dur, info) = bench(|| tiff::parse(&data).expect("ORF parse"));
    let w = info.width as usize;
    let h = info.height as usize;
    let mp = w * h;
    let strip = &data[info.strip_offset as usize
        ..info.strip_offset as usize + info.strip_byte_count as usize];

    // Decompress (predictive LJPEG)
    let (decomp_dur, raw) = bench(|| decompress::decompress(strip, w, h).expect("ORF decompress"));

    // Demosaic
    let (demosaic_dur, rgb16) =
        bench(|| demosaic::demosaic_rggb(&raw, w, h).expect("demosaic"));

    // Tonemap
    let mut params = pipeline::PipelineParams::default_olympus();
    if let Some(r) = info.wb_r { params.wb_r = r; }
    if let Some(b) = info.wb_b { params.wb_b = b; }
    if let Some(m) = info.color_matrix { params.color_matrix = Some(m); }
    let (tone_dur, rgb8) = bench(|| pipeline::process(&rgb16, &params));

    let name = Path::new(path).file_name().unwrap().to_string_lossy();
    let total = parse_dur + decomp_dur + demosaic_dur + tone_dur;
    let mpps = mp as f64 / 1e6 / (ms(demosaic_dur) / 1000.0);

    println!("ORF  {name}");
    println!(
        "  {w}×{h}  {:.1} MB  ({} MP)",
        size_mb,
        mp / 1_000_000
    );
    println!(
        "  parse {:.1}ms  decomp {:.1}ms  demosaic {:.1}ms ({:.1} MP/s)  tone {:.1}ms  total {:.1}ms",
        ms(parse_dur),
        ms(decomp_dur),
        ms(demosaic_dur),
        mpps,
        ms(tone_dur),
        ms(total)
    );
    let _ = rgb8.len();
    println!();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

fn main() {
    println!("=== RAW Decode Pipeline Benchmark ===");
    println!("Runs per file: {RUNS} (reporting minimum)\n");

    let test_dir = r"C:\Foo\raw-converter\tests";

    // ORF (Olympus)
    bench_orf(&format!("{test_dir}\\P1110226.ORF"));

    // DNG (Pixel 9 / Google)
    bench_dng(&format!("{test_dir}\\PXL_20260501_093507165.RAW-02.ORIGINAL.dng"));
    bench_dng(&format!("{test_dir}\\PXL_20260501_095020990.RAW-02.ORIGINAL.dng"));
    bench_dng(&format!("{test_dir}\\PXL_20260501_100404049.RAW-02.ORIGINAL.dng"));

    // CR2 (Canon)
    bench_cr2(&format!("{test_dir}\\_MG_1744.CR2"));
    bench_cr2(&format!("{test_dir}\\_MG_1747.CR2"));
    bench_cr2(&format!("{test_dir}\\ADH 1234.CR2"));
    bench_cr2(&format!("{test_dir}\\ADH 1248.CR2"));
    bench_cr2(&format!("{test_dir}\\ADH 1490.CR2"));

    println!("=== Done ===");
    println!("Tip: re-run with --release for production-representative numbers.");
    println!("     cargo run --bin raw_decode_bench --release 2>&1 | tee benchmark/results_latest.txt");
}
