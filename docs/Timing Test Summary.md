# Timing Test Summary

This document summarizes the findings from the execution of the full suite of optimal settings benchmarks. The goal of these tests is to establish the most performant combinations of JXL encoding and decoding options to reduce latency for web-based Raw previews and galleries.

## Tests Analyzed

All tests defined in `docs/Optimal-settings.md` have been successfully implemented, executed, and their timings outputted into `.toon` ledger files.

- [x] **Test 1: Progressive Timing Benchmark (`test_1_progressive_vs_oneshot.mjs`)**
  - Compares the decoding profile of a progressive JXL stream vs a one-shot encode.
- [x] **Test 2: Thumbnail Generation (`test_2_thumbnail_generation.mjs`)**
  - Scenario 1: Encoding small thumbnails (~400px) and measuring decode performance.
- [x] **Test 3: Lightbox Detail View (`test_3_lightbox_view.mjs`)**
  - Scenario 2: Encoding full-size images (~1600px) for lightbox inspection, focusing on ROI first paint.
- [x] **Test 4: Bulk Gallery Image Testing (`test_4_bulk_gallery.mjs`)**
  - Scenario 4: Simulates a gallery load scenario with multiple images decoded sequentially.
- [x] **Test 5: First-Paint Optimization (Streaming) (`test_5_first_paint_streaming.mjs`)**
  - Scenario 5: Evaluates decode performance and visual completeness (PSNR) at cumulative byte cutoffs.
- [x] **Test 6: Policy Matrix Sweep (`test_6_policy_matrix_sweep.mjs`)**
  - Targeted sweep varying effort, quality, progressive, modular, and resampling parameters to identify the best presets.
- [x] **Test 7: P3.1 Feature Benchmark (`test_7_p3_features_benchmark.mjs`)**
  - Isolates and times specific progressive decoding capabilities, such as `previewFirst` (DC-only) vs first AC pass, downsample decoding, and region extraction.

## Analysis and Findings

### 1. Progressive vs One-Shot (Test 1)
- **One-Shot** encodes are generally faster to generate than progressive encodes (~300ms vs ~500ms).
- **Progressive** yields a faster "first frame" or first paint (e.g., ~220ms vs ~280ms) for the end user on full-size decode, making it optimal for the perceived speed of web applications despite a slightly higher encode cost.
- **Verdict:** Use **Progressive** encoding for all web-facing full-size outputs to maximize perceived performance.

### 2. Thumbnail Generation (Test 2 / Scenario 1)
- At 400px target size, encode times are exceptionally fast (< 75ms).
- Downsample=2 decoding (`dec_ds2_ms`) operates in the ~18-48ms range, offering a ~1.0x to 2.4x speedup over full decode depending on the source.
- **Verdict:** For galleries, pre-encoding 400px progressive thumbs at effort=3 and quality=80 gives optimal latency. Utilizing `downsample: 2` on the client side is a viable fallback for very low-power devices, though at 400px the absolute time saving is minimal.

### 3. Lightbox Detail View (Test 3 / Scenario 2)
- At 1600px, Region of Interest (ROI) decoding using `region` (center 50%) takes ~245-415ms, which is frequently faster or on par with the full decode time.
- Progressive first paint combined with ROI gives the best user experience.
- **Verdict:** Use `effort=3`, `quality=85`, and `progressive=true`. Ensure client viewers request ROI crops where possible.

### 4. Effort Sweep (Test 3.1)
- Increasing `effort` from 3 to 5 and 7 significantly inflates encode time (e.g., ~808ms -> ~1829ms -> ~3513ms).
- While effort 7 produces slightly smaller files (~311KB vs ~465KB), the 4x penalty to encode time makes it unsuitable for real-time transcoding.
- **Verdict:** Lock `effort=3` as the standard for on-the-fly transcoding.

### 5. First-Paint Optimization / Streaming (Test 5 / Scenario 5)
- Cutoff testing reveals that at 25% byte arrival, a visually acceptable first pass is decoded (~198ms) with a lower PSNR (~21.8).
- By 50% bytes, the PSNR improves significantly (~28.6) with minimal latency penalty on progressive decode.
- **Verdict:** The `progressive` preset handles the byte streaming natively and successfully provides rapid visual feedback before the file completes downloading.

### 6. Policy Matrix Sweep (Test 6)
- **Modular vs VarDCT (Non-Modular):** Non-modular (VarDCT) encoding (`m=-1` or default) consistently outperforms forced modular (`m=0`) in encode time and file size for photographic RAWs.
- **Resampling:** Resampling (`rs=2`) vs no resampling (`rs=1`) provides a negligible difference in file size but can slightly decrease encode times.
- **Verdict:** Default VarDCT is superior. Stick to standard configurations without forcing modular mode.

### 7. P3.1 Features (Test 7)
- **previewFirst:** Decoding DC-only passes (`prev_dc_ds2_ms`) took ~220-270ms. However, simply decoding the first progressive pass (`full_first_ms`) took only ~165-185ms.
- **Verdict:** As previously hypothesized in `Optimal-settings.md`, do **not** use `previewFirst`. Waiting for the first progressive AC pass is reliably faster than requesting a DC-only preview.
- **Region + Downsample:** Extracting a center 50% region with a `downsample=2` factor (`reg_ds2_ms`) provides the fastest possible paint for a specific area (~200-230ms).

## Conclusion and Recommendations

Based on these results, we can definitively establish the locked-in settings for our transcoding pipeline.

1. **Effort Level:** `3` (Best balance of speed and size).
2. **Quality:** `85` for full-size, `80` for thumbnails.
3. **Progression:** `true` with `progressiveFlavor: 'ac'`.
4. **previewFirst:** `false` (slower than native first pass).
5. **Modular:** Rely on default (VarDCT), do not force.

These settings will be codified into `docs/Tested-settings.md`.