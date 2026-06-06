# Butteraugli Integration — Findings

**Date:** 2026-06-06  
**Status:** Complete

## What Was Built

`computeButteraugli(pixels1, pixels2, width, height): Promise<number>` — exported from `packages/jxl-wasm/dist/index.js`.

- C++ bridge: `jxl_wasm_butteraugli_compare()` in `bridge.cpp` using `jxl::ButteraugliInterfaceInPlace`
- WASM tiers rebuilt: `simd` + `scalar` (host-toolchain build)
- Return type: float packed as int32 bits; JS unpacks via `Int32Array`/`Float32Array` view alias

## Smoke Test Results

| Test | Distance |
|------|----------|
| Identical 4×4 images | 0.000 |
| Black vs white 4×4 | 316.417 |

Scale reference: 0 = identical, ~1.0 = imperceptible difference, >2.0 = noticeable.

## Key Implementation Fix (bridge)

**Problem:** `jxl::Image3F::Create(nullptr, w, h)` crashes in WASM — `AlignedMemory::Create` fails when `memory_manager=nullptr`.

**Fix:** Call `jxl::MemoryManagerInit(&mem, nullptr)` to populate `mem.alloc = malloc` / `mem.free = free`, then pass `&mem` to all `Create()` calls.

## Key Fix for Benchmark (progressive decode)

**Problem:** All byte-cutoff decodes errored with `JXL decode error: 1`.  
**Root cause:** `emitEveryPass: false` means `progressive_detail=0` → `JXL_DEC_FRAME_PROGRESSION` not subscribed → no intermediate flush events. Closing decoder with incomplete data immediately fails.

**Fix:** Changed `streamDecodeCutoffs` to use `emitEveryPass: true`. This subscribes to `JXL_DEC_FRAME_PROGRESSION`, so completed passes are flushed as `progress` events before the truncation error. The event handler now captures `progress` pixels as fallback when `final` never fires.

## Calibration Results (2 ORFs, 1600px, effort=3, quality=85)

| Cutoff | File size | SSIM | PSNR | Butteraugli | Pass |
|--------|-----------|------|------|-------------|------|
| 10% | ~40KB | error | — | — | DC incomplete |
| 20% | ~80KB | 0.889–0.893 | 21–23 | 70–74 | DC pass |
| 30% | ~120KB | 0.928–0.937 | 23–24 | 62 | DC+some AC |
| 40% | ~160KB | 0.972–0.974 | 25–27 | 62 | DC+some AC |
| **50%** | ~200KB | **0.997–0.998** | **29–30** | **4.6–5.0** | **AC pass 1** |
| 80% | ~320KB | 0.999 | 33–34 | 4.5–5.0 | AC pass 1 (plateau) |
| 90% | ~360KB | 0.999–1.000 | 35–37 | 4.5–5.0 | AC pass 1 (plateau) |
| 100% | ~400–455KB | 1.000 | ∞ | 0.000 | Complete |

**Key finding:** Butteraugli drops sharply from ~62 to ~5 at 50% — this is when the first complete AC refinement pass fits in the stream. The large plateau (80-90% have same BA as 50%) means further bytes add no completed pass until 100%.

## Threshold Calibration

| Threshold | What it finds | Bytes needed |
|-----------|--------------|--------------|
| BA ≤ 1.5 (original default) | Only at 100% (full decode) | 100% |
| **BA ≤ 5.0 (recommended)** | **First AC pass complete** | **~50%** |
| SSIM ≥ 0.9 (original) | DC pass only (blocky) | ~30% |

**SSIM is too optimistic** at 30%: BA=62 means the image is severely degraded even though SSIM says "acceptable". Butteraugli correctly identifies that the DC-pass-only image is not perceptually good.

**Updated default:** `BUTTERAUGLI_THRESHOLD=5.0` for streaming preview use case.

## Usage

```bash
# Standard run with SSIM
SSIM_LIMIT=5 SSIM_TARGET=1600 node benchmark/streaming-ssim-benchmark.mjs

# With Butteraugli (recommended threshold)
SSIM_LIMIT=5 SSIM_TARGET=1600 USE_BUTTERAUGLI=1 BUTTERAUGLI_THRESHOLD=5.0 \
  node benchmark/streaming-ssim-benchmark.mjs
```
