//! RAW decode pipeline benchmark: ORF, DNG, and CR2.
//!
//! Run: `cargo run --bin raw_decode_bench --release`
//!   or via MSVC toolchain: `.\build-msvc.ps1 run --bin raw_decode_bench --release`
//!
//! Measures each stage independently:
//!   - File I/O (excluded from timing)
//!   - Parse + LJPEG decode (incl. crop for CR2)
//!   - Demosaic (RGGB MHC)
//!   - Tonemap (black/WB/matrix/curve → RGB8)
//!   - JXL encode (effort=3/Falcon, quality=90, native threads)
//!   - JXL decode (jpegxl-rs full decode)
//!   - Total end-to-end (RAW stages only; JXL is additive)
//!
//! Results are written to stdout and to `benchmark/results_native.json`.
//! Schema aligns with WASM `raw-format-sweep-results.json`:
//!   decompressMs = parse+decomp for ORF; full decode for DNG/CR2.
//!   encodeMs / decodeMs use the same effort=3 / quality=90 settings as the
//!   WASM bench, but native threading is used (expected faster than WASM
//!   single-threaded encode).
//!   directRgbaMs: time for pipeline::process_rgba (fused tone→RGBA8 for direct
//!   JXL encode feed, P3/Tauri parity experiment). The reported encode path now
//!   uses 4ch direct rgba to demonstrate never-materialized 3ch intermediate.

use std::path::Path;
use std::time::{Duration, Instant};

use raw_pipeline::{cr2, demosaic, dng, pipeline};

const RUNS: usize = 3;
// Match WASM bench encode settings (targeted-wasm-timings.mjs).
const JXL_QUALITY: f32 = 90.0;

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

// ─── JXL encode / decode ─────────────────────────────────────────────────────

/// Encode buffer (RGB8 or RGBA8) to JXL. num_ch must be 3 or 4.
/// Used for the direct-RGBA (native parity) encode path: tone directly to 4ch
/// and feed encoder without ever materializing a retained 3ch RGB8.
fn bench_jxl_encode_with_ch(data: &[u8], width: u32, height: u32, num_ch: u32) -> Option<(Duration, Vec<u8>)> {
    use jpegxl_rs::encode::{encoder_builder, EncoderFrame, EncoderResult, EncoderSpeed};
    use jpegxl_rs::ThreadsRunner;

    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let mut best = Duration::MAX;
    let mut last_bytes: Vec<u8> = Vec::new();
    for _ in 0..RUNS {
        // Runner must outlive encoder; declared first so it drops last.
        let runner = ThreadsRunner::new(None, Some(threads))?;
        let mut builder = encoder_builder();
        builder.parallel_runner(&runner).speed(EncoderSpeed::Falcon);
        builder.set_jpeg_quality(JXL_QUALITY);
        let mut encoder = builder.build().ok()?;
        let frame = EncoderFrame::new(data).num_channels(num_ch);
        let t = Instant::now();
        let result: EncoderResult<u8> = encoder
            .encode_frame::<u8, u8>(&frame, width, height)
            .ok()?;
        let elapsed = t.elapsed();
        if elapsed < best {
            best = elapsed;
        }
        last_bytes = result.data;
    }
    Some((best, last_bytes))
}

/// Decode JXL bytes via jpegxl-rs. Returns min decode duration over RUNS.
fn bench_jxl_decode(jxl_bytes: &[u8]) -> Option<Duration> {
    use jpegxl_rs::decode::decoder_builder;

    let mut best = Duration::MAX;
    for _ in 0..RUNS {
        let decoder = decoder_builder().build().ok()?;
        let t = Instant::now();
        let _ = decoder.decode(jxl_bytes).ok()?;
        let elapsed = t.elapsed();
        if elapsed < best {
            best = elapsed;
        }
    }
    Some(best)
}

// ─── Result collection ───────────────────────────────────────────────────────

struct BenchRow {
    file: String,
    format: &'static str,
    width: usize,
    height: usize,
    size_mb: f64,
    /// parse+decomp for ORF; full LJPEG decode for DNG/CR2.
    decompress_ms: f64,
    demosaic_ms: f64,
    tonemap_ms: f64,
    total_ms: f64,
    /// JXL encode time; None if encode failed.
    encode_ms: Option<f64>,
    jxl_size_kb: Option<f64>,
    /// JXL decode time; None if decode failed (requires encode success).
    decode_ms: Option<f64>,
    /// Direct RGBA tone time (process_rgba) — the native "prep" path for encode-only flows.
    /// Measures the fused tone+alpha path that avoids an intermediate RGB8 Vec.
    direct_rgba_ms: Option<f64>,
}

fn opt_f64(v: f64) -> String {
    format!("{:.3}", v)
}

fn json_opt(v: Option<f64>) -> String {
    match v {
        Some(x) => format!("{:.3}", x),
        None => "null".to_string(),
    }
}

fn rows_to_json(rows: &[BenchRow], generated_at: &str) -> String {
    let mut out = String::new();
    out.push_str("{\n");
    out.push_str(&format!("  \"generatedAt\": \"{generated_at}\",\n"));
    out.push_str(&format!("  \"runsPerFile\": {RUNS},\n"));
    out.push_str("  \"reporting\": \"minimum\",\n");
    out.push_str(&format!("  \"jxlQuality\": {JXL_QUALITY},\n"));
    out.push_str("  \"jxlEffort\": 3,\n");
    out.push_str("  \"rows\": [\n");
    for (i, row) in rows.iter().enumerate() {
        let comma = if i + 1 < rows.len() { "," } else { "" };
        out.push_str("    {\n");
        out.push_str(&format!("      \"file\": \"{}\",\n", row.file.replace('\\', "/")));
        out.push_str(&format!("      \"format\": \"{}\",\n", row.format));
        out.push_str(&format!("      \"width\": {},\n", row.width));
        out.push_str(&format!("      \"height\": {},\n", row.height));
        out.push_str(&format!("      \"sizeMB\": {},\n", opt_f64(row.size_mb)));
        out.push_str(&format!("      \"decompressMs\": {},\n", opt_f64(row.decompress_ms)));
        out.push_str(&format!("      \"demosaicMs\": {},\n", opt_f64(row.demosaic_ms)));
        out.push_str(&format!("      \"tonemapMs\": {},\n", opt_f64(row.tonemap_ms)));
        out.push_str(&format!("      \"totalMs\": {},\n", opt_f64(row.total_ms)));
        out.push_str(&format!("      \"encodeMs\": {},\n", json_opt(row.encode_ms)));
        out.push_str(&format!("      \"jxlSizeKB\": {},\n", json_opt(row.jxl_size_kb)));
        out.push_str(&format!("      \"decodeMs\": {},\n", json_opt(row.decode_ms)));
        out.push_str(&format!("      \"directRgbaMs\": {}\n", json_opt(row.direct_rgba_ms)));
        out.push_str(&format!("    }}{comma}\n"));
    }
    out.push_str("  ]\n");
    out.push_str("}\n");
    out
}

// ─── Format benchmarks ───────────────────────────────────────────────────────

fn bench_dng(path: &str, rows: &mut Vec<BenchRow>) {
    let Ok(data) = std::fs::read(path) else {
        eprintln!("  [skip] {path} — not found");
        return;
    };
    let size_mb = data.len() as f64 / 1e6;

    let (decode_dur, img) = bench(|| dng::decode_bytes(&data).expect("DNG decode"));
    let w = img.width;
    let h = img.height;
    let mp = w * h;

    let (raw_aligned, aw, ah) = dng::align_to_rggb(&img.raw, w, h, img.cfa);
    let (demosaic_dur, rgb16) = bench(|| {
        demosaic::demosaic_rggb_mhc(raw_aligned, aw, ah).expect("demosaic")
    });

    let mut params = pipeline::PipelineParams::default_olympus();
    params.black = img.black;
    params.white = img.white;
    params.wb_r = img.wb_r;
    params.wb_b = img.wb_b;
    params.color_matrix = img.color_matrix;
    let (tone_dur, _rgb8) = bench(|| pipeline::process(&rgb16, &params));
    let (direct_rgba_dur, rgba8) = bench(|| pipeline::process_rgba(&rgb16, &params));

    // Use direct RGBA + 4ch encode for the measured JXL path (Tauri direct-feed parity).
    // This never materializes a standalone owned 3ch RGB8 for the encode-only case.
    let jxl = bench_jxl_encode_with_ch(&rgba8, w as u32, h as u32, 4);
    let encode_ms = jxl.as_ref().map(|(d, _)| ms(*d));
    let jxl_size_kb = jxl.as_ref().map(|(_, b)| b.len() as f64 / 1024.0);
    let decode_ms = jxl.as_ref().and_then(|(_, b)| bench_jxl_decode(b)).map(|d| ms(d));

    let name = Path::new(path).file_name().unwrap().to_string_lossy();
    let total = decode_dur + demosaic_dur + tone_dur;
    let mpps = mp as f64 / 1e6 / (ms(demosaic_dur) / 1000.0);

    println!("DNG  {name}");
    println!("  {w}×{h}  {:.1} MB  ({} MP)", size_mb, mp / 1_000_000);
    println!(
        "  decode {:.1}ms  demosaic {:.1}ms ({:.1} MP/s)  tone {:.1}ms  direct-rgba {:.1}ms  total {:.1}ms",
        ms(decode_dur), ms(demosaic_dur), mpps, ms(tone_dur), ms(direct_rgba_dur), ms(total)
    );
    println!("  WB R={:.3} B={:.3}  black={}  white={}", img.wb_r, img.wb_b, img.black, img.white);
    match (encode_ms, jxl_size_kb, decode_ms) {
        (Some(enc), Some(sz), Some(dec)) =>
            println!("  jxl encode {enc:.1}ms  {sz:.1} KB  decode {dec:.1}ms  (via direct rgba)"),
        _ =>
            println!("  jxl encode/decode: failed"),
    }
    println!();

    rows.push(BenchRow {
        file: name.into_owned(),
        format: "DNG",
        width: w,
        height: h,
        size_mb,
        decompress_ms: ms(decode_dur),
        demosaic_ms: ms(demosaic_dur),
        tonemap_ms: ms(tone_dur),
        total_ms: ms(total),
        encode_ms,
        jxl_size_kb,
        decode_ms,
        direct_rgba_ms: Some(ms(direct_rgba_dur)),
    });
}

fn bench_cr2(path: &str, rows: &mut Vec<BenchRow>) {
    let Ok(data) = std::fs::read(path) else {
        eprintln!("  [skip] {path} — not found");
        return;
    };
    let size_mb = data.len() as f64 / 1e6;

    let (decode_dur, img) = bench(|| cr2::decode_bytes(&data).expect("CR2 decode"));
    let w = img.width;
    let h = img.height;
    let mp = w * h;

    let (demosaic_dur, rgb16) = bench(|| {
        demosaic::demosaic_rggb_mhc(&img.raw, w, h).expect("demosaic")
    });

    let mut params = pipeline::PipelineParams::default_olympus();
    params.black = img.black;
    params.white = img.white;
    params.wb_r = img.wb_r;
    params.wb_b = img.wb_b;
    params.color_matrix = img.color_matrix;
    let (tone_dur, _rgb8) = bench(|| pipeline::process(&rgb16, &params));
    let (direct_rgba_dur, rgba8) = bench(|| pipeline::process_rgba(&rgb16, &params));

    // Use direct RGBA + 4ch encode for the measured JXL path (Tauri direct-feed parity).
    // This never materializes a standalone owned 3ch RGB8 for the encode-only case.
    let jxl = bench_jxl_encode_with_ch(&rgba8, w as u32, h as u32, 4);
    let encode_ms = jxl.as_ref().map(|(d, _)| ms(*d));
    let jxl_size_kb = jxl.as_ref().map(|(_, b)| b.len() as f64 / 1024.0);
    let decode_ms = jxl.as_ref().and_then(|(_, b)| bench_jxl_decode(b)).map(|d| ms(d));

    let name = Path::new(path).file_name().unwrap().to_string_lossy();
    let total = decode_dur + demosaic_dur + tone_dur;
    let mpps = mp as f64 / 1e6 / (ms(demosaic_dur) / 1000.0);

    println!("CR2  {name}");
    println!("  {w}×{h}  {:.1} MB  ({} MP)", size_mb, mp / 1_000_000);
    println!(
        "  decode {:.1}ms  demosaic {:.1}ms ({:.1} MP/s)  tone {:.1}ms  direct-rgba {:.1}ms  total {:.1}ms",
        ms(decode_dur), ms(demosaic_dur), mpps, ms(tone_dur), ms(direct_rgba_dur), ms(total)
    );
    println!("  WB R={:.3} B={:.3}  black={}  white={}  ISO={:?}", img.wb_r, img.wb_b, img.black, img.white, img.iso);
    match (encode_ms, jxl_size_kb, decode_ms) {
        (Some(enc), Some(sz), Some(dec)) =>
            println!("  jxl encode {enc:.1}ms  {sz:.1} KB  decode {dec:.1}ms  (via direct rgba)"),
        _ =>
            println!("  jxl encode/decode: failed"),
    }
    println!();

    rows.push(BenchRow {
        file: name.into_owned(),
        format: "CR2",
        width: w,
        height: h,
        size_mb,
        decompress_ms: ms(decode_dur),
        demosaic_ms: ms(demosaic_dur),
        tonemap_ms: ms(tone_dur),
        total_ms: ms(total),
        encode_ms,
        jxl_size_kb,
        decode_ms,
        direct_rgba_ms: Some(ms(direct_rgba_dur)),
    });
}

fn bench_orf(path: &str, rows: &mut Vec<BenchRow>) {
    use raw_pipeline::{decompress, tiff};

    let Ok(data) = std::fs::read(path) else {
        eprintln!("  [skip] {path} — not found");
        return;
    };
    let size_mb = data.len() as f64 / 1e6;

    let (parse_dur, info) = bench(|| tiff::parse(&data).expect("ORF parse"));
    let w = info.width as usize;
    let h = info.height as usize;
    let mp = w * h;
    let strip = &data[info.strip_offset as usize
        ..info.strip_offset as usize + info.strip_byte_count as usize];

    let (decomp_dur, raw) = bench(|| decompress::decompress(strip, w, h).expect("ORF decompress"));
    let (demosaic_dur, rgb16) = bench(|| demosaic::demosaic_rggb(&raw, w, h).expect("demosaic"));

    let mut params = pipeline::PipelineParams::default_olympus();
    if let Some(r) = info.wb_r { params.wb_r = r; }
    if let Some(b) = info.wb_b { params.wb_b = b; }
    if let Some(m) = info.color_matrix { params.color_matrix = Some(m); }
    let (tone_dur, _rgb8) = bench(|| pipeline::process(&rgb16, &params));
    let (direct_rgba_dur, rgba8) = bench(|| pipeline::process_rgba(&rgb16, &params));

    // Use direct RGBA + 4ch encode for the measured JXL path (Tauri direct-feed parity).
    // This never materializes a standalone owned 3ch RGB8 for the encode-only case.
    let jxl = bench_jxl_encode_with_ch(&rgba8, w as u32, h as u32, 4);
    let encode_ms = jxl.as_ref().map(|(d, _)| ms(*d));
    let jxl_size_kb = jxl.as_ref().map(|(_, b)| b.len() as f64 / 1024.0);
    let decode_ms = jxl.as_ref().and_then(|(_, b)| bench_jxl_decode(b)).map(|d| ms(d));

    let name = Path::new(path).file_name().unwrap().to_string_lossy();
    let total = parse_dur + decomp_dur + demosaic_dur + tone_dur;
    let mpps = mp as f64 / 1e6 / (ms(demosaic_dur) / 1000.0);

    println!("ORF  {name}");
    println!("  {w}×{h}  {:.1} MB  ({} MP)", size_mb, mp / 1_000_000);
    println!(
        "  parse {:.1}ms  decomp {:.1}ms  demosaic {:.1}ms ({:.1} MP/s)  tone {:.1}ms  direct-rgba {:.1}ms  total {:.1}ms",
        ms(parse_dur), ms(decomp_dur), ms(demosaic_dur), mpps, ms(tone_dur), ms(direct_rgba_dur), ms(total)
    );
    match (encode_ms, jxl_size_kb, decode_ms) {
        (Some(enc), Some(sz), Some(dec)) =>
            println!("  jxl encode {enc:.1}ms  {sz:.1} KB  decode {dec:.1}ms  (via direct rgba)"),
        _ =>
            println!("  jxl encode/decode: failed"),
    }
    println!();

    rows.push(BenchRow {
        file: name.into_owned(),
        format: "ORF",
        width: w,
        height: h,
        size_mb,
        // decompressMs = parse+decomp combined. WASM ProcessResult.decompress_ms
        // covers only the decompress step; parse overhead is noted here.
        decompress_ms: ms(parse_dur) + ms(decomp_dur),
        demosaic_ms: ms(demosaic_dur),
        tonemap_ms: ms(tone_dur),
        total_ms: ms(total),
        encode_ms,
        jxl_size_kb,
        decode_ms,
        direct_rgba_ms: Some(ms(direct_rgba_dur)),
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

fn main() {
    println!("=== RAW Decode Pipeline Benchmark ===");
    println!("Runs per file: {RUNS} (reporting minimum)");
    println!("JXL: effort=3 (Falcon), quality={JXL_QUALITY}\n");

    let test_dir = r"C:\Foo\raw-converter\tests";
    let mut rows: Vec<BenchRow> = Vec::new();

    bench_orf(&format!("{test_dir}\\P1110226.ORF"), &mut rows);

    bench_dng(&format!("{test_dir}\\PXL_20260501_093507165.RAW-02.ORIGINAL.dng"), &mut rows);
    bench_dng(&format!("{test_dir}\\PXL_20260501_095020990.RAW-02.ORIGINAL.dng"), &mut rows);
    bench_dng(&format!("{test_dir}\\PXL_20260501_100404049.RAW-02.ORIGINAL.dng"), &mut rows);

    bench_cr2(&format!("{test_dir}\\_MG_1744.CR2"), &mut rows);
    bench_cr2(&format!("{test_dir}\\_MG_1747.CR2"), &mut rows);
    bench_cr2(&format!("{test_dir}\\ADH 1234.CR2"), &mut rows);
    bench_cr2(&format!("{test_dir}\\ADH 1248.CR2"), &mut rows);
    bench_cr2(&format!("{test_dir}\\ADH 1490.CR2"), &mut rows);

    println!("=== Done ===");
    println!("Tip: use --release + MSVC toolchain for representative numbers:");
    println!("     .\\build-msvc.ps1 run --bin raw_decode_bench --release 2>&1 | tee benchmark/results_latest.txt");

    if rows.is_empty() {
        eprintln!("[warn] no files processed; JSON not written");
        return;
    }

    let generated_at = approximate_iso8601_utc();
    let json = rows_to_json(&rows, &generated_at);
    let out_path = "benchmark/results_native.json";
    match std::fs::write(out_path, &json) {
        Ok(()) => println!("\nResults written to {out_path}"),
        Err(e) => eprintln!("\n[warn] could not write {out_path}: {e}"),
    }
}

fn approximate_iso8601_utc() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let days = secs / 86400;
    let y400 = days / 146097;
    let rem = days % 146097;
    let y100 = (rem / 36524).min(3);
    let rem = rem - y100 * 36524;
    let y4 = rem / 1461;
    let rem = rem % 1461;
    let y1 = (rem / 365).min(3);
    let year = y400 * 400 + y100 * 100 + y4 * 4 + y1 + 1970;
    let day_of_year = rem - y1 * 365;
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let months: [u64; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1u32;
    let mut dom = day_of_year;
    for mlen in &months {
        if dom < *mlen { break; }
        dom -= mlen;
        month += 1;
    }
    format!("{year:04}-{month:02}-{:02}T{h:02}:{m:02}:{s:02}Z", dom + 1)
}
