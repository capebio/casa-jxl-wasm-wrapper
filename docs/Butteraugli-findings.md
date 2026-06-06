# Butteraugli Integration — Findings

**Date:** 2026-06-06  
**Status:** Complete

## What Was Built

`computeButteraugli(pixels1, pixels2, width, height): Promise<number>` — exported from `packages/jxl-wasm/dist/index.js`.

- C++ bridge: `jxl_wasm_butteraugli_compare()` in `bridge.cpp` using `jxl::ButteraugliInterfaceInPlace`
- WASM tiers rebuilt: `simd` + `scalar` (host-toolchain build, ~3 hrs Emscripten compile)
- Return type: float packed as int32 bits; JS unpacks via `Int32Array`/`Float32Array` view alias

## Smoke Test Results

| Test | Distance |
|------|----------|
| Identical 4×4 images | 0.000 |
| Black vs white 4×4 | 316.417 |

Scale reference: 0 = identical, ~1.0 = imperceptible difference, >2.0 = noticeable.

## Key Implementation Fix

**Problem:** `jxl::Image3F::Create(nullptr, w, h)` crashes in WASM — `AlignedMemory::Create` fails when `memory_manager=nullptr`.

**Fix:** Call `jxl::MemoryManagerInit(&mem, nullptr)` to populate `mem.alloc = malloc` / `mem.free = free`, then pass `&mem` to all `Create()` calls.

## Benchmark Integration

`USE_BUTTERAUGLI=1 BUTTERAUGLI_THRESHOLD=1.5 node benchmark/streaming-ssim-benchmark.mjs`

Added to `streaming-ssim-benchmark.mjs`:
- `USE_BUTTERAUGLI` env var (default off)
- `BUTTERAUGLI_THRESHOLD` env var (default 1.5)
- Per-cutoff `BA=X.XXX` in console output
- `butteraugli` field in JSON cutoff records

## Byte-Cutoff Limitation (Pre-existing)

All cutoffs below 100% produce `DecodeFailed: JXL decode error: 1`. This is a pre-existing issue (confirmed in June 5 benchmark results) unrelated to butteraugli.

**Root cause:** `progressionTarget: 'final'` + truncated byte stream → decoder requires complete data to emit a final event. Partial JXL data fails to decode.

**Consequence:** Butteraugli distance is only measurable at 100% cutoff, where it's trivially 0 (full decode = reference).

**To fix for progressive quality measurement:** Switch to `emitEveryPass: true` and capture intermediate pass events, or use `progressionTarget: 'preview'` for first-available decode. Out of scope for this task.

## SSIM Threshold vs Butteraugli Threshold

SSIM is not sensitive enough at early byte cutoffs (all error anyway). Butteraugli would be more perceptually meaningful if partial decodes were available. Recommended thresholds when partial decodes work:

| Butteraugli distance | Perceptual quality |
|---------------------|-------------------|
| 0–0.5 | Excellent, nearly identical |
| 0.5–1.5 | Good, minor artifacts |
| 1.5–3.0 | Acceptable, visible but minor |
| >3.0 | Noticeable degradation |

Default `BUTTERAUGLI_THRESHOLD=1.5` is a reasonable "acceptable quality" boundary.
