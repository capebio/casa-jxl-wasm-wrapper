# RAW → JXL Pipeline Benchmarks

This folder tracks encode-decode performance across all supported RAW formats.

## Format Coverage

| Format | Camera type | Decoder |
|--------|------------|---------|
| ORF    | Olympus (E-M1, OM-1) | `raw_pipeline::tiff` + `decompress` |
| DNG    | Pixel 9, Adobe DNG converter | `raw_pipeline::dng` |
| CR2    | Canon EOS (Kiss X4, M5, etc.) | `raw_pipeline::cr2` |

## Pipeline Stages

Each RAW format goes through the same stages:

```
File bytes
  │
  ▼ parse / LJPEG decode          ← format-specific
  │   CR2:  IFD walk + LJPEG strip decode + active-area crop
  │   DNG:  IFD walk + LJPEG tile decode
  │   ORF:  TIFF parse + predictive decompress
  │
  ▼ demosaic (RGGB MHC)           ← shared
  │
  ▼ tonemap (WB + matrix + curve) ← shared
  │
  ▼ RGB8 output → JXL encode (browser-side via jSquash / libjxl)
```

## Running the Benchmark

### Native (fastest, for pipeline profiling)

```powershell
.\build-msvc.ps1 run --bin raw_decode_bench --release 2>&1 | Tee-Object benchmark/results_latest.txt
```

Requires test files at `C:\Foo\raw-converter\tests\` (CR2, DNG, ORF files).  
Writes `benchmark/results_native.json` (includes JXL encode/decode timings, sub-stage breakdowns, and JSON-serialized rows).

### WASM (end-to-end browser timing)

Open `web/jxl-benchmark.html` (served via `npx serve .`) in Chrome with COOP/COEP headers. The page times full pipeline including JXL encode via jSquash.

## Key Metrics

| Metric | What it means |
|--------|--------------|
| `decompress ms` | Parse + LJPEG decode + crop. Bottleneck for CR2 (single-threaded LJPEG). |
| `demosaic ms` | RGGB MHC interpolation. 10–13× slower in WASM vs native (no rayon). |
| `tonemap ms` | WB + color matrix + tone curve. Single-threaded in both native and WASM. |
| `raw ms` | Wall time for full RAW → RGB8 pipeline (decompress + demosaic + tonemap). |
| `encode ms` | JXL encode time (effort=3 / Falcon, quality=90). |
| `decode ms` | JXL decode time (full resolution). |
| `total ms` | End-to-end: raw + encode + decode. |

## WASM vs Native

| Stage | Native (multi-core) | WASM (single-thread) |
|-------|--------------------|--------------------|
| LJPEG decode | ~50–80ms | ~50–80ms (I/O bound) |
| Demosaic 18MP | ~15ms | ~150–200ms |
| Tonemap | ~33ms | ~33ms |
| JXL encode (effort=3) | ~200–400ms | ~400–800ms |
| JXL decode | ~100–300ms | ~200–500ms |

Demosaic is the bottleneck in WASM. See `WASM_DNG_ANALYSIS.md` for full analysis.

## Format Notes

### CR2 (Canon)
- LJPEG with 4 interleaved channels (RGGB), 14-bit precision
- CR2Slices tag tells us the total decoded width (includes optical black)
- Active area crop: center-aligned, offsets forced even to preserve RGGB
- WB from ColorData (MakerNote tag 0x4001): index 63 for ColorData v6+, index 25 for v1–5
- No DNG-style color matrix in file → uses default `pipeline::CAM_TO_SRGB`
- Black: 2048 (14-bit), White: 15300

### DNG (Pixel / Google)
- LJPEG tiles (compression=7), AsShotNeutral for WB
- ForwardMatrix or ColorMatrix for color correction
- CFA aligned to RGGB via `dng::align_to_rggb`

### ORF (Olympus)
- Predictive LJPEG (12-bit), non-standard TIFF magic (IIRO/IIRS)
- WB from Olympus MakerNote (RedBalance/BlueBalance tags)
- Olympus-specific color matrix from MakerNote

## Results Archive

| File | Source | Notes |
|------|--------|-------|
| `results_native.json` | `cargo run --bin raw_decode_bench --release` | Overwritten each run; includes JXL encode/decode timings |
| `raw-format-sweep-results.json` | `node benchmark/raw-format-sweep.mjs` | WASM end-to-end; includes sub-stage breakdowns |
| `results_latest.txt` | native bench (console stdout) | Human-readable; overwritten each run |
| `results_YYYYMMDD.txt` | manual snapshot | Dated archive; copy manually when notable |
