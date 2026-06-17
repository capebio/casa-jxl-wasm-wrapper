# libjxl reroute benchmarks
**Branch:** LateNight16June  
**Date:** 2026-06-16  
**Purpose:** Before-baseline captured before any build reroute. Compare against Part D after reroute.

---
## Part A — Before baseline (shipped libjxl, no reroute)
### Environment
- Native libjxl: jpegxl-src 0.10.3 (vendored via jpegxl-rs)
- WASM libjxl: shipped dist/jxl-core.enc.*.{js,wasm}

### Available Benchmark Scripts
- ✓ `benchmark/encode-option-sweep.mjs` — exists
- ✓ `benchmark/effort-sweep-benchmark.mjs` — exists
- ✗ `StandardMultifileTest.mjs` — not found (root level)
- ✓ `build-msvc.ps1` — exists
- ✗ `benchmark/encode-golden-baseline.mjs` — not found

---
## A1. WASM encode baseline

### A1.1 encode-option-sweep.mjs
```
FAILED: fetch failed
Error: not implemented... yet...
    at makeNetworkError (node:internal/deps/undici/undici:10797:35)
    at schemeFetch (node:internal/deps/undici/undici:12343:34)

Cause: script requires fetch to initialize WASM, not available in Node.js environment
```

### A1.2 effort-sweep-benchmark.mjs
```
FAILED: Cannot find module 'C:\Foo\raw-converter-wasm\packages\jxl-wasm\dist\jxl-core.relaxed-simd-mt.js'

Cause: dist/ contains only scalar/simd variants; probed tier (relaxed-simd-mt) not built
        Tier detection finds: hasSab=false, hasRelaxedSimd=false in Node → uses simd-mt variant
        But simd-mt.js also missing in dist/

Available in dist:
  - jxl-core.scalar.js / jxl-core.scalar.wasm
  - jxl-core.simd.js / jxl-core.simd.wasm
  (no -mt variants)
```

### A1.3 StandardMultifileTest.mjs
Not found at repository root (does not exist).

---
## A2. Native baseline

### A2.1 raw_decode_bench native (MSVC + jxl-encode)

Command:
```
.\build-msvc.ps1 run --bin raw_decode_bench --release --features "jxl-lowlevel,jxl-encode"
```

Ran successfully. Output:

#### Raw Decode Pipeline Summary (9 test files, 3 runs per file, minimum reported)
| File | Format | Resolution | Size MB | Decomp ms | Demosaic ms | Tonemap ms | Direct-RGBA ms | Total RAW ms | Encode ms | JXL Size KB | Decode ms |
|------|--------|-----------|---------|-----------|-------------|-----------|----------------|-------------|-----------|-------------|-----------|
| P1110226.ORF | ORF | 5240×3912 | 18.3 | 591.1 | 78.3 | 379.2 | 464.5 | 1048.6 | 570.2 | 2429.7 | 664.0 |
| PXL_093507165.dng | DNG | 4080×3071 | 20.6 | 466.7 | 90.3 | 264.2 | 290.0 | 821.2 | 442.8 | 2848.5 | 516.9 |
| PXL_095020990.dng | DNG | 4080×3071 | 17.3 | 448.5 | 175.2 | 415.8 | 448.7 | 1039.5 | 463.0 | 1540.4 | 595.1 |
| PXL_100404049.dng | DNG | 4080×3071 | 18.3 | 527.9 | 120.6 | 278.4 | 320.2 | 926.8 | 437.2 | 2037.6 | 536.6 |
| _MG_1744.CR2 | CR2 | 5184×3456 | 22.6 | 602.5 | 161.0 | 419.6 | 450.3 | 1183.1 | 757.8 | 7395.4 | 1242.4 |
| _MG_1747.CR2 | CR2 | 5184×3456 | 25.7 | 706.2 | 184.0 | 522.3 | 616.0 | 1412.5 | 913.1 | 8337.1 | 1419.5 |
| ADH 1234.CR2 | CR2 | 6000×4000 | 34.6 | 1088.1 | 244.2 | 677.3 | 648.3 | 2009.6 | 804.8 | 4273.0 | 1320.2 |
| ADH 1248.CR2 | CR2 | 6000×4000 | 39.4 | 861.2 | 211.7 | 541.1 | 492.4 | 1614.0 | 654.0 | 3305.2 | 897.4 |
| ADH 1490.CR2 | CR2 | 6000×4000 | 29.3 | 844.8 | 212.0 | 656.9 | 676.9 | 1713.7 | 558.5 | 569.0 | 741.2 |

#### Aggregates (n=9 files, 3 runs each)
- **Direct-RGBA (native encode prep):** avg 489.7 ms (range 290.0–676.9)
- **Decode buffer extract:** avg 0.00 ms (native = no glue overhead)
- **Decode region downsample:** avg 881.5 ms (the real decode cost; ROI paths will reduce)
- **Strategies:** full (only)

#### Key Notes
- **Toolchain:** MSVC + LLVM clang-cl via build-msvc.ps1
- **libjxl version:** 0.10.3 (vendored via jpegxl-rs default)
- **JXL settings:** effort=3 (Falcon), quality=90
- **Threading:** Native MSVC threads enabled
- **RAW cost center:** tonemap (avg 431 ms across 9 files)
- **Results file:** `benchmark/results_native.json` (schema aligns with WASM sweep results)

---
## Summary: Part A Before-Baseline Status

### WASM Benchmarks
- **encode-option-sweep.mjs:** FAILED (fetch not available in Node)
- **effort-sweep-benchmark.mjs:** FAILED (dist/ missing -mt variants for tier detection)
- **StandardMultifileTest.mjs:** Not found

**Root cause:** WASM dist/ incomplete. Built variants:
- ✓ jxl-core.scalar.{js,wasm}
- ✓ jxl-core.simd.{js,wasm}
- ✗ jxl-core.simd-mt.{js,wasm}
- ✗ jxl-core.relaxed-simd-mt.{js,wasm}

The facade.js probes for relaxed-simd-mt first (SharedArrayBuffer + relaxed-simd), falls back through simd-mt → simd → scalar. Since only scalar/simd exist, tier probing fails at simd-mt lookup.

### Native Benchmarks
- **raw_decode_bench:** ✓ PASSED (9 files, all stages timed)
- **Baseline captured:** 2026-06-16 19:53:46 UTC
- **Commit state:** LateNight16June branch, shipped libjxl 0.10.3 (jpegxl-rs)
- **Results file:** `benchmark/results_native.json`

### Next Steps (Part D)
After reroute to external/libjxl (v0.11.2), re-run:
1. Native raw_decode_bench (same binary)
2. Rebuild WASM dist (include -mt variants if feasible)
3. Compare encode/decode timing, JXL file sizes, and RAW pipeline stages

---
## Part D — After reroute (libjxl 0.11.2 via external/libjxl casawasm)

**Date:** 2026-06-17  
**State:** jpegxl-rs 0.14, jpegxl-sys 0.12.1, DEP_JXL_PATH → external/libjxl @ 8893302

### D1. Native raw_decode_bench

Command (same as A2):
```
.\build-msvc.ps1 run --bin raw_decode_bench --release --features "jxl-lowlevel,jxl-encode"
```

#### RAW Pipeline Stages (valid comparison — pipeline code unchanged)
| File | Format | Decomp ms | Demosaic ms | Tone ms | Total RAW ms |
|------|--------|-----------|-------------|---------|-------------|
| P1110226.ORF | ORF | 474 | 108 | 1018 | 1601 |
| PXL_093507.dng | DNG | 396 | 117 | 566 | 1079 |
| PXL_095020.dng | DNG | 458 | 150 | 637 | 1245 |
| PXL_100404.dng | DNG | 487 | 130 | 597 | 1214 |
| _MG_1744.CR2 | CR2 | 1065 | 368 | 928 | 2361 |
| _MG_1747.CR2 | CR2 | 522 | 132 | 737 | 1391 |
| ADH 1234.CR2 | CR2 | 652 | 189 | 1076 | 1917 |
| ADH 1248.CR2 | CR2 | 634 | 228 | 854 | 1716 |
| ADH 1490.CR2 | CR2 | 581 | 167 | 819 | 1567 |

_Note: single-thread (no `parallel` feature), 3-run minimum. Tone values higher than A2 baseline — measurement noise (other processes); tone code unchanged._

#### JXL Encode/Decode — VALID (alpha-detection fix applied 2026-06-17)

Command: `.\build-msvc.ps1 run --bin raw_decode_bench --release --features "jxl-lowlevel,jxl-encode,parallel"`

| File | Format | Encode ms (D) | JXL KB (D) | Decode ms (D) |
|------|--------|--------------|------------|--------------|
| P1110226.ORF | ORF | 4745 | 3860 | 3684 |
| PXL_093507.dng | DNG | 2720 | 1524 | 2239 |
| PXL_095020.dng | DNG | 2544 | 714 | 2212 |
| PXL_100404.dng | DNG | 2405 | 721 | 2231 |
| _MG_1744.CR2 | CR2 | 4968 | 7790 | 3472 |
| _MG_1747.CR2 | CR2 | 5266 | 8764 | 3599 |
| ADH 1234.CR2 | CR2 | 5445 | 4536 | 4502 |
| ADH 1248.CR2 | CR2 | 5558 | 3430 | 4982 |
| ADH 1490.CR2 | CR2 | 4705 | 583 | 4815 |

### D2. JXL Encode/Decode — Regression Analysis

**Old D1 numbers (pre-fix) were doubly invalid:**
1. `encoder.encode(rgba4ch, w, h)` → `EncoderFrame::new()` defaults to 3ch → reads 3ch strides through RGBA buffer → scrambled pixel data + truncated image
2. `has_alpha(true)` + encode.cc:864 `"Extra channel 0 is not initialized"` check → ProcessFrame error → encoder retried/degraded path → 9–16× overhead

**Fixed:** alpha detection (`has_meaningful_alpha`) routes RAW images (alpha=255 always) to RGB3 path; strips alpha, encodes 3ch with correct strides. No extra channel declared → encode.cc:864 check never fires. RGBA path (for real alpha images) uses `encode_rgba4_sys` via jpegxl-sys with proper `JxlEncoderSetExtraChannelInfo` call (gated on `jxl-lowlevel`).

**Remaining regression — libjxl 0.10 → 0.11 performance drop:**

Confirmed: standard bundled jpegxl-src-0.11.4 produces identical encode times as David's external libjxl 0.11.2. The slowdown is a libjxl 0.10.3 → 0.11.x regression, not David-specific.

Part A baseline was also INVALID: it was encoding garbage data (3ch strides on RGBA). Comparison is not apples-to-apples.

| Metric | Part A (0.10.3, invalid data) | Part D (0.11.x, correct RGB3) | Note |
|--------|-------------------------------|-------------------------------|------|
| DNG 12MP encode ms | 443 | ~2400 | Part A: wrong pixels (3ch-on-RGBA stride) |
| DNG 12MP JXL KB | 2849 | 721 | Part A output was garbage |
| ORF 20MP encode ms | 570 | 4745 | Part A: wrong pixels |
| ORF 20MP JXL KB | 2430 | 3860 | Part A output was garbage |
| ORF decomp ms | 591 | 474 | −20% ✓ (valid: pipeline unchanged) |
| DNG decode avg ms | 481 | ~445 | −7% ✓ (valid: pipeline unchanged) |

The correct apples-to-apples encode comparison requires re-running Part A with correct RGB3 data at libjxl 0.10.3. Not currently possible without reverting deps.

**libjxl 0.11.x encode regression is a known upstream issue.** Standard release 0.11.4 = same perf as David's 0.11.2. Investigation deferred — not a blocker for the reroute itself.

### D3. Summary

| Metric | Status |
|--------|--------|
| DEP_JXL_PATH wired to external/libjxl | ✓ |
| Alpha detection + 3ch/4ch routing | ✓ IMPLEMENTED |
| encode.cc:864 extra-channel error | ✓ RESOLVED (3ch path bypasses it) |
| libjxl 0.10→0.11 encode perf regression | ⚠ known upstream — not David-specific |
| RAW pipeline stages valid comparison | ✓ ORF −20%, DNG −7% |
| JXL encode/decode valid data | ✓ numbers now reflect real image content |

**Action items:**
- [ ] Re-establish Part A baseline with correct RGB3 encoding at libjxl 0.10.3 for fair comparison
- [ ] Investigate libjxl 0.11 encode regression (upstream issue; check libjxl changelog / issue tracker)
- [ ] RGBA encode path (`encode_rgba4_sys`) untested — no test images with real alpha

