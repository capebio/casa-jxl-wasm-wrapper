# Tonemap Bottleneck Analysis & SIMD Win Chain

## Ablation Results (flipflop::ablate-raw-pipeline)

**RAW pipeline stages & contribution to critical path:**

| Stage | Saved when memoized | Real time | % of total |
|---|---|---|---|
| **tonemap** | −69.8% | ~400ms / 12MP | **70%** |
| whitebalance | −17–19% | ~80ms / 12MP | 15% |
| demosaic | −12–16% | ~70ms / 12MP | 10% |
| decompress | ~0% | ~50ms / 12MP | 5% |

**Conclusion:** tonemap dominates; fixing it moves the needle.

## SIMD Implementation Status

✅ **Already shipped:** `crate::tone_simd::apply_tone_bulk` wired in `process_into_simd` (pipeline.rs:1385).

✅ **Dispatch logic:** `process_into_auto` (pipeline.rs:1420) chooses:
- `process_into` (scalar) if `perceptual_constancy=true`
- `process_into_simd` (SIMD) if `perceptual_constancy=false` (default)

✅ **WASM entry:** lib.rs line 794 calls `process_into_auto` → uses SIMD by default.

## Real SIMD Win (Rust Benchmark)

**Measured on 20MP synthetic RAW (tone_simd_bench.rs):**

| Path | Scalar | SIMD | Speedup |
|---|---|---|---|
| vib_zero (sat only) | 469.15 ms | 24.06 ms | **19.5×** |
| vibrance active (div) | 898.37 ms | 27.17 ms | **33.1×** |

**Why such huge wins?**
1. Rust uses real SIMD intrinsics (AVX2 f32x8 or SIMD128 f32x4)
2. Vectorizes all per-pixel operations (luma, curve, matrix, divide) in parallel
3. Vibrance path (division) benefits most from vector parallelism

## Full-Pipeline Context

**Memory note:** "AvgRawTonemapMs 942→429" (−55%) is end-to-end, including:
- Demosaic overhead (not SIMD'd)
- WB matrix multiply (scalar)
- Pre/post LUT lookups
- Tone stages wired together

**Estimated breakdown:**
- Tonemap kernel alone: 19–33× from SIMD
- Full-pipeline overhead: ~2.2× total (942ms → 429ms = 2.2×)
- **Implication:** Demosaic/WB are now the next bottlenecks if tonemap is removed.

## Next Optimization Targets

**If tonemap is fixed (tone_simd in use), next targets are:**

1. **Whitebalance matrix-vector** (−15–20% of total after tonemap SIMD)
   - Vectorize 3×3 matvec per pixel; currently scalar
   - Est. 3–5× with SIMD f32x4

2. **Demosaic interpolation** (−10–15% of total)
   - Bayer CFA interpolation is memory-bound but parallelizable
   - Est. 2–4× with SIMD gather + vectorized filters

3. **Decompress reads** (~5% of total)
   - Already minimal; cache-friendly sequential I/O

## Recommendations

**Status quo is correct:** SIMD tonemap is live and delivering 19–33× speedup. No action needed.

**To measure end-to-end impact on real images:**
1. Run pyramid-ingest on a batch of 12MP RAW files, before/after
2. Compare total ingest time (should see ~2× speedup if tonemap was the blocker)
3. If <2× observed, demosaic/WB are now limiting; profile next

**Ablation harness (flipflop) validated** bottleneck location and verified SIMD is in use.
