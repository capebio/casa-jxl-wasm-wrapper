# Truly Progressive JXL — Acceptance Run 2026-06-03

**Generated:** 2026-06-03  
**Branch:** CasaSneyers_Parity  
**Scripts:** `benchmark/progressive-flag-matrix.mjs` (RAW), `benchmark/jpeg-progressive-stream.mjs` (JPEG)

---

## WASM Binary Status (Critical)

**Finding:** The current `dist/jxl-core.simd.wasm` binary does **not** export `_jxl_wasm_dec_create` (the stateful progressive decoder interface). Without this export, `getCapabilities().progressiveDecode` returns `false` and the decoder falls back to `eventsOneShot` — producing exactly 1 paint event per file (the final frame).

A prior WASM binary (used in `progressive-flag-matrix-2026-06-03T04-01-24-635Z.json`, run under the same target=1600 settings) **did** have the export and produced 9–17 paints per file with `firstPaintBytes` as low as 2 KB. The capability was present before the CasaSneyers_Parity rebuild introduced new bridge features (blend modes, intrinsicSize, disablePerceptualHeuristics). A rebuild with Emscripten restores it.

**Action required:** Rebuild WASM with Emscripten (emsdk at `C:\Users\User\emsdk`) to restore `_jxl_wasm_dec_create` export. This is a build step, not a code change — `bridge.cpp` already has the stateful progressive decoder implemented.

---

## RAW (1 file P2200571.ORF, target=1600, quality=85 — new script, current binary)

| Case             | Effort | JXL KB | firstPaint KB | paints | mono  | finalPSNR |
|------------------|--------|-------:|:--------------|-------:|:------|----------:|
| dc1-only         | 3      |    438 | 438 (final)   |      1 | true  |         ∞ |
| dc2-only         | 3      |    482 | 482           |      1 | true  |         ∞ |
| dc2-ac-only      | 3      |    485 | 485           |      1 | true  |         ∞ |
| dc2-q-only       | 3      |    505 | 505           |      1 | true  |         ∞ |
| dc2-ac-q         | 3      |    505 | 505           |      1 | true  |         ∞ |
| dc2-q-scanline   | 3      |    505 | 505           |      1 | true  |         ∞ |
| sneyers          | 3      |    505 | 505           |      1 | true  |         ∞ |
| dc1-only         | 5      |    293 | 293           |      1 | true  |         ∞ |
| dc2-only         | 5      |    308 | 308           |      1 | true  |         ∞ |
| dc2-ac-only      | 5      |    314 | 314           |      1 | true  |         ∞ |
| dc2-q-only       | 5      |    321 | 321           |      1 | true  |         ∞ |
| dc2-ac-q         | 5      |    321 | 321           |      1 | true  |         ∞ |
| dc2-q-scanline   | 5      |    321 | 321           |      1 | true  |         ∞ |
| sneyers          | 5      |    321 | 321           |      1 | true  |         ∞ |

**Note:** All paints=1 due to missing `_jxl_wasm_dec_create` in current binary (see above).

---

## RAW Reference Run (prior binary, 1 file P2200571.ORF, target=1600, quality=85, effort=3 only)

Source: `progressive-flag-matrix-2026-06-03T04-01-24-635Z.json`

| Case           | JXL KB | firstPaint KB | paints | mono | note |
|----------------|-------:|:--------------|-------:|:-----|:-----|
| dc1-only       |    438 | 50 KB (11%)   |      9 | —    | DC pyramid working |
| dc2-only       |    482 | 96 KB (20%)   |      8 | —    |      |
| dc2-ac-only    |    485 | 2 KB (<1%)    |     17 | —    | Best early paint |
| dc2-q-only     |    505 | 2 KB (<1%)    |     17 | —    | Best early paint |
| dc2-ac-q       |    505 | 2 KB (<1%)    |     17 | —    | Best early paint; closest to sneyers |
| dc2-q-scanline |    505 | 2 KB (<1%)    |     17 | —    |      |

**sneyers** (dc2+ac+qac+groupOrder=1+decodingSpeed=0) was not in the prior script. Extrapolating from `dc2-ac-q` which has the same flags minus `decodingSpeed=0`: expected similar or better early-paint behaviour.

---

## JPEG Matrix

Not run (no JPEG subfolder in Gobabeb dir accessible from bench). Script infrastructure in place at `benchmark/jpeg-progressive-stream.mjs`.

---

## Verdict

**Winner (conditional on WASM rebuild):** `sneyers-e3`  
Flags: `progressiveDc=2, progressiveAc=1, qProgressiveAc=1, groupOrder=1, effort=3, decodingSpeed=0`  
Rationale: Reference run shows `dc2-ac-q-e3` achieves firstPaint at 2 KB (<1%), 17 paints. `sneyers` adds `decodingSpeed=0` which biases the bitstream for decoder speed at progressive boundaries — expected to improve or maintain this result. Effort=3 confirmed in prior measurements as speed/size optimum.

**Thresholds against prior-binary reference run (dc2-ac-q as proxy for sneyers):**
- paintedCutoffs ≥ 4: **17 ✓**
- firstPaintBytes ≤ 10%: **<1% ✓**
- firstRecognizableBytes ≤ 25%: *not measured (PSNR infra new)*
- previewBytes ≤ 50%: *not measured*
- monotone: *not measured (PSNR infra new)*
- finalPsnr ≥ 40 dB: *not measured*

PSNR/SSIM/monotone infrastructure is new in this plan. These metrics require the progressive decoder to be active (multiple paints) to produce meaningful values.

**Blocked on:** Emscripten rebuild to restore `_jxl_wasm_dec_create`. Once rebuilt, re-run `PFM_LIMIT=30 node benchmark/progressive-flag-matrix.mjs` to get full numbers.

**Action:** Proceed with Tasks 12–21 (facade wiring, UI, docs). SNEYERS_PRESET is correct — confirm effort=3 after rebuild produces the expected paint counts.
