# Optimal Settings Strategy

Central reference for recording encode/decode timings and choosing settings for different scenarios. See the **TOON Output Structure** chapter below for the required file layout.

## TOON Output Structure

Use TOON as a line-oriented, indentation-based encoding of the run ledger. For timing work, the important constraint is that uniform records stay compact and parseable:

- One benchmark run equals one `.toon` file.
- The file starts with a run header, then one or more tabular sections.
- Shared values belong in the header.
- Only values that vary per measurement belong in the table body.
- Each run must record the agent that executed it.
- Use a table-like layout for the repeated timing rows.
- Declare the row fields once in the table header, then emit one row per measurement.
- Keep the row values in a consistent order so the file can be parsed mechanically.

Recommended structure:

```toon
TestName: timing-tests
RunTimestamp: 2026-06-06T02:23:35.184Z
Agent: codex
Tier: simd
Source: mixed
Target: 1600
Quality: 85
Efforts: 3
Modes: std, std+chunked
TimeBase: 2026-06-06T02:

---
runs[4]{t|mode|effort|file|raw_ms|rgba_ms|encode_ms|total_ms|size}:
  23:^49.581@ | std           | 3 | P22004^07@.ORF | 4080.830 | 330.705 | 9842.922 | 14254.457 | 1715365B
  &56.927@    | std^+chunked@ | ~ | ~               | ~        | ~       | 7345.449 | 11756.984 | 1744648B
  24:^01.637@ | &@            | ~ | P22004^77@.jpg | 0        | 0       | 2591.928 | 2591.928  | 560163B
  &04.280@    | &+chunked@    | ~ | ~              | ~        | ~       | 2643.071 | 2643.071  | 574390B
```

Rules for this document:

- Use a single TOON file per run.
- Put all measurements for that run in that file.
- Preserve each measurement timestamp inside the table rows.
- Preserve the agent identity in the run header.
- Do not emit one file per permutation.
- Do not repeat constants in every row.
- Do not use ad hoc nested key trees when the data is a uniform row set.
- Use shorthand for repeated fields:
  - If a field stays unchanged across consecutive rows, omit it until it changes.
  - Use `~` to mean "same as the previous row in this column".
  - Use `prefix^value@suffix` to define a reusable template for the current column. The expanded value is `prefix + value + suffix`.
  - Use `&value@` to reuse the current column template. The expanded value is the previous template's `prefix + value + suffix`.
  - A new `prefix^value@suffix` definition replaces the active template for that column only.
  - Use `TimeBase` for the shared date/hour prefix when useful, then use template shorthand for repeated minute/second prefixes.
  - Use dictionaries only when the repeated values are labels or non-patterned strings; for numbered file series and timestamps, prefer column templates.
  - In numeric timing columns, `0` is canonical shorthand for `0.000`.
  - Always write filesize with a unit suffix such as `B` or `KB`; use that as the final field in the row.
  - The row body should only spell out the delta from the previous row when that is unambiguous.

Template shorthand is column-scoped and must be mechanically expandable. Reserved characters in unquoted cells are `|`, `~`, `^`, `@`, and `&`. If a literal cell needs one, quote the whole cell with double quotes; quoted cells do not expand shorthand.

## Benchmark Recording Rules

- Keep benchmark runs short. Prefer narrowly scoped sweeps over long all-file passes.
- Write every timing result to `docs/outputs/timing tests/`.
- Record each benchmark test run in a single TOON file containing all its measurements.
- Each measurement written should include a datetimestamp.
- Record the agent that ran the benchmark.
- File naming must include the test name and a datetime stamp so interrupted runs can resume cleanly.
- Use TOON (`text/toon`) for the per-run output files, not JSON. For format details, see [ToonInstructions.md](./ToonInstructions.md).
- Treat this document as the human-readable source of truth. The TOON files are the durable timing ledger.

Suggested filename shape:

`<datetime>-<test-name>.toon`

Suggested record contents:

- input files
- permutation settings
- per-file timings
- aggregate timings
- notes on failures or interruption state

## Current Findings (2026-06-05)

### ORF→JXL Progressive (5 files, 1600px long-edge, effort=3, quality=85)

| Metric | Result | Verdict |
|--------|--------|---------|
| **previewFirst** | 0.78–0.90× | ✗ DO NOT USE. Extra DC decode adds overhead vs first pass arrival |
| **downsample=2** | 2.36–2.59× speedup | ✓ SHIP. Thumbnails 2.4× faster |
| **region center 50%** | 2.25–2.72× speedup | ✓ SHIP. ROI lightbox 2.5× faster |

### ORF→JXL JXTC (5 files, transcode pathway)

- `transcodeJpegToJxl` v1 does NOT embed raw JPEG bytes
- Extraction scan (pure JS) would be <1ms if bytes were present
- Feature fires only for container JXLs with explicit JPEG bitstream (v2 or encode-with-recon pathway)

## Current Findings (2026-06-06)

### Correlation-Derived Timing Batch (Tests 13-22, 1 representative file unless format sweep)

All rows were written as TOON ledgers in `docs/outputs/timing tests/` with `raw_ms`, `rgba_ms`, `encode_ms`, `decode_ms`, `total_ms`, and `size`. The repeated RAW decode stage is noisy, so decisions below weight encode/decode/size deltas more heavily than total wall time when the same source file is reused.

| Decision Area | Finding | Recommended Setting |
|---|---:|---|
| Quality ladder | `q80` = 382KB, `q85` = 466KB, `q90` = 614KB, `q95` = 1042KB at 1600px. `q85` is the best lightbox balance; `q90+` grows quickly. | `quality=80` for medium previews, `quality=85` for web lightbox, `quality=90` only for local/detail inspection |
| Modular | Forced VarDCT (`modular=0`) was faster than auto in this run with same bytes; forced Modular was 2.2MB and much slower. | Keep lossy photo output VarDCT/default; avoid forced Modular except lossless/line art |
| Lossless | Lossless Modular was 6.0-6.6MB at 1600px, ~13-14x the lossy bytes, with slower decode. | Use lossless only for archival/local-original workflows |
| Progressive vs local one-shot | Progressive was 466KB vs one-shot 445KB, but final decode and encode were faster in this run. | Keep `progressive=true` for streaming/web; acceptable for local default too |
| Effort window | Effort 3 kept the smaller 466KB output while matching effort 2 timing; effort 4 gave no meaningful size win. | Keep `effort=3`; do not raise to 4 for web |
| Target ladder | 400px q80 = 27KB, 800px q85 = 128KB, 1600px q85 = 466KB, 2400px q85 = 942KB. JXL encode+decode rises from ~0.8s at 400px to ~2.9s at 2400px. | 400px thumbnails, 800px fast preview, 1600px web lightbox, 2400px local/detail only |
| Source format | CR2 RAW decode was slowest (7167ms), DNG fastest (2354ms), ORF middle (3831ms). | Treat RAW decode as source-format bottleneck; JXL settings cannot hide CR2 cost |
| Dots/colorTransform | No byte-size change in this run; some timing variation, likely build/settings noise without visual validation. | Do not lock advanced dots/color transform yet |
| Photon noise ISO | No byte-size change; timing varied without quality/visual validation. | Keep `photonNoiseIso` disabled by default |

### Size/Use Presets

| Use Case | Target | Quality | Effort | Progressive | Expected File From Test_20 | Notes |
|---|---:|---:|---:|---|---:|---|
| Gallery thumbnail | 400 | 80 | 3 | true | 27KB | Small enough for fast lists; decode ~134ms in this run |
| Fast preview / constrained web | 800 | 85 | 3 | true | 128KB | Best total JXL encode+decode timing in target ladder |
| Web lightbox / streaming | 1600 | 85 | 3 | true | 466KB | Current locked default remains right |
| Local detail / high-DPI inspection | 2400 | 85-90 | 3 | true | 942KB at q85 | Use when local CPU/storage matters less than detail |
| Archival / exact RGB | 1600+ | lossless | 3 | true | 6.0-6.6MB at 1600px | Use only when exactness beats latency/bytes |

---

## Benchmark Test Options

Detailed configuration and usage options for backend CLI benchmark scripts (excluding browser-based tests).

### Effort Sweep Benchmark
- **Description:** Encodes ORFs at varying effort levels (default: 3, 5, 7) to compare encode time, file size, decode pass arrival time, and visual quality.
- **Usage:**
  ```bash
  EFFORT_LIMIT=2 EFFORT_TARGET=1600 EFFORT_QUALITY=85 node benchmark/effort-sweep-benchmark.mjs
  ```

### Progressive Byte Benchmark
- **Description:** Encodes JXL using progressive web presets and streams decode at specific cumulative byte cutoffs, recording detailed timing and frame data.
- **Usage:**
  ```bash
  PBB_LIMIT=3 PBB_TARGET=800 PBB_QUALITY=85 PBB_DETAIL=passes node benchmark/progressive-byte-benchmark.mjs
  ```

### Streaming SSIM Benchmark
- **Description:** Evaluates progressive decode visual quality by measuring SSIM/PSNR against full reference decodes at byte cutoffs, identifying the earliest "acceptable frame" threshold.
- **Usage:**
  ```bash
  SSIM_LIMIT=2 SSIM_TARGET=1600 SSIM_EFFORT=3 SSIM_QUALITY=85 SSIM_THRESHOLD=0.9 node benchmark/streaming-ssim-benchmark.mjs
  ```

### P3.1 Feature Benchmark
- **Description:** Benchmarks specific progressive decoding features, comparing timings for `previewFirst` (DC-only ds=2 vs first AC pass), `downsample=2`, and region-of-interest extraction vs full decode.
- **Usage:**
  ```bash
  P3_LIMIT=5 P3_TARGET=1600 P3_EFFORT=3 P3_QUALITY=85 node benchmark/p3-features-benchmark.mjs
  ```

### Progressive Timing Benchmark (Test_1)
- **Description:** Compares progressive JXL (first-frame arrival) vs 1-shot JXL (final decode) across a size ladder, quantifying whether progressive gives faster first paint. Also tests chunked stream delivery (PT_STEPS equal slices) to simulate byte-by-byte streaming.
- **Usage:**
  ```bash
  PT_LIMIT=3 PT_SIZES=300,800,1600 PT_QUALITY=85 PT_EFFORT=3 PT_STEPS=1,4,8 node benchmark/progressive-timing-benchmark.mjs
  ```
- **Output:** TOON file at `docs/outputs/timing tests/<datetime>-progressive-timing.toon`
- **Key metrics:** `prog_first_ms` vs `shot_final_ms`, speedup multiplier, pass count

### Policy Matrix Sweep
- **Description:** A targeted matrix sweep for tuning the `jxl-policy` preset by testing combinations of effort, quality, lossless, progressive, modular, and resampling options.
- **Usage:**
  ```bash
  PM_FILE=<path_to_raw> PM_REPS=2 PM_TIMEOUT=60000 node benchmark/policy-matrix.mjs
  ```

### DecodingSpeed Sweep (Test_8)
- **Description:** Sweeps `decodingSpeed` (0–3) × effort (3, 5). `decodingSpeed` trades encode work for faster decode; measures encode time, decode time, and file size to find the cheapest setting that keeps decode fast.
- **Usage:**
  ```bash
  TEST8_LIMIT=2 TEST8_TARGET=1600 TEST8_QUALITY=85 TEST8_EFFORTS=3,5 TEST8_DEC_SPEEDS=0,1,2,3 node benchmark/test_8_decoding_speed_sweep.mjs
  ```

### GroupOrder + ProgressiveDc First-Frame (Test_9)
- **Description:** Sweeps `groupOrder` (0=raster scan, 1=center-out) × `progressiveDc` (1, 2). Captures first-frame arrival time to quantify whether center-out ordering accelerates early visual during streaming.
- **Usage:**
  ```bash
  TEST9_LIMIT=3 TEST9_TARGET=1600 TEST9_QUALITY=85 TEST9_EFFORT=3 TEST9_GROUP_ORDERS=0,1 TEST9_PROG_DCS=1,2 node benchmark/test_9_group_order_progressive_dc.mjs
  ```

### EPF + Gaborish Quality Sweep (Test_10)
- **Description:** Sweeps `epf` (0–3) × `gaborish` (0, 1) at effort=3. Measures encode time, decode time, and file size to find the filtering configuration with the best visual quality per byte.
- **Usage:**
  ```bash
  TEST10_LIMIT=3 TEST10_TARGET=1600 TEST10_QUALITY=85 TEST10_EFFORT=3 TEST10_EPF=0,1,2,3 TEST10_GABORISH=0,1 node benchmark/test_10_epf_gaborish_sweep.mjs
  ```

### BrotliEffort vs Encode Time (Test_11)
- **Description:** Sweeps `brotliEffort` (−1=auto, 0, 4, 9, 11) × effort (3, 5). Quantifies whether higher Brotli compression levels meaningfully reduce file size and at what encode-time cost.
- **Usage:**
  ```bash
  TEST11_LIMIT=2 TEST11_TARGET=1600 TEST11_QUALITY=85 TEST11_EFFORTS=3,5 TEST11_BROTLI_LEVELS=-1,0,4,9,11 node benchmark/test_11_brotli_effort_sweep.mjs
  ```

### Resampling × Quality Sweep (Test_12)
- **Description:** Sweeps `resampling` (−1=auto, 1=full, 2=half) × quality (75, 85, 90) at effort=3, 1600px. Maps the size–quality–speed surface to find the sweet spot for web delivery.
- **Usage:**
  ```bash
  TEST12_LIMIT=3 TEST12_TARGET=1600 TEST12_EFFORT=3 TEST12_QUALITIES=75,85,90 TEST12_RESAMPLINGS=-1,1,2 node benchmark/test_12_resampling_quality_sweep.mjs
  ```

### Quality Ladder Sweep (Test_13)
- **Description:** Sweeps `quality` (70, 80, 85, 90, 95) at locked lightbox defaults to measure the file-size and timing slope around the current `quality=85` recommendation.
- **Usage:**
  ```bash
  TEST13_LIMIT=3 TEST13_TARGET=1600 TEST13_EFFORT=3 TEST13_QUALITIES=70,80,85,90,95 node benchmark/test_13_quality_ladder_sweep.mjs
  ```

### Modular Mode Sweep (Test_14)
- **Description:** Sweeps `modular` (−1=auto, 0=VarDCT, 1=Modular) at `quality=85`, effort=3 to isolate codec-mode cost without the broader policy matrix.
- **Usage:**
  ```bash
  TEST14_LIMIT=3 TEST14_TARGET=1600 TEST14_QUALITY=85 TEST14_EFFORT=3 TEST14_MODULAR=-1,0,1 node benchmark/test_14_modular_mode_sweep.mjs
  ```

### Lossless Ladder Sweep (Test_15)
- **Description:** Sweeps `lossless` (0, 1) × quality anchors (85, 95) to compare archival output cost against high-quality lossy lightbox output.
- **Usage:**
  ```bash
  TEST15_LIMIT=2 TEST15_TARGET=1600 TEST15_EFFORT=3 TEST15_QUALITIES=85,95 TEST15_LOSSLESS=0,1 node benchmark/test_15_lossless_ladder_sweep.mjs
  ```

### Dots + ColorTransform Sweep (Test_16)
- **Description:** Sweeps `dots` (0, 1) × `colorTransform` (0, 1, 2) at locked lightbox defaults to measure advanced coding-tool impact.
- **Usage:**
  ```bash
  TEST16_LIMIT=2 TEST16_TARGET=1600 TEST16_QUALITY=85 TEST16_EFFORT=3 TEST16_DOTS=0,1 TEST16_COLOR_TRANSFORMS=0,1,2 node benchmark/test_16_dots_color_transform_sweep.mjs
  ```

### PhotonNoiseIso Sweep (Test_17)
- **Description:** Sweeps `photonNoiseIso` (0, 200, 800, 1600) at locked lightbox defaults to measure synthetic-noise size and timing overhead.
- **Usage:**
  ```bash
  TEST17_LIMIT=3 TEST17_TARGET=1600 TEST17_QUALITY=85 TEST17_EFFORT=3 TEST17_PHOTON_NOISE_ISO=0,200,800,1600 node benchmark/test_17_photon_noise_iso_sweep.mjs
  ```

### Progressive Toggle Sweep (Test_18)
- **Description:** Sweeps `progressive` (0, 1) at locked lightbox defaults to compare local/on-computer final decode cost against streaming-ready output.
- **Usage:**
  ```bash
  TEST18_LIMIT=2 TEST18_TARGET=1600 TEST18_QUALITY=85 TEST18_EFFORT=3 TEST18_PROGRESSIVE=0,1 node benchmark/test_18_progressive_toggle_sweep.mjs
  ```

### Effort Shipping Window Sweep (Test_19)
- **Description:** Sweeps `effort` (1, 2, 3, 4) near the current shipping default to find whether effort=3 remains the best speed/size compromise.
- **Usage:**
  ```bash
  TEST19_LIMIT=2 TEST19_TARGET=1600 TEST19_QUALITY=85 TEST19_EFFORTS=1,2,3,4 node benchmark/test_19_effort_shipping_window_sweep.mjs
  ```

### Target Size Ladder Sweep (Test_20)
- **Description:** Sweeps `target` (400, 800, 1600, 2400) to size presets for thumbnails, medium previews, web lightbox, and local/detail viewing. Uses quality 80 for 400px and quality 85 above that.
- **Usage:**
  ```bash
  TEST20_LIMIT=1 TEST20_TARGETS=400,800,1600,2400 TEST20_EFFORT=3 TEST20_THUMB_QUALITY=80 TEST20_QUALITY=85 node benchmark/test_20_target_size_ladder_sweep.mjs
  ```

### Source Format Sweep (Test_21)
- **Description:** Sweeps available RAW-family `source_type` values (ORF/RAW/DNG/CR2) at locked lightbox defaults to separate local raw pipeline cost from JXL encode/decode cost.
- **Usage:**
  ```bash
  TEST21_PER_TYPE=1 TEST21_TARGET=1600 TEST21_QUALITY=85 TEST21_EFFORT=3 node benchmark/test_21_source_format_sweep.mjs
  ```

### Modular + Lossless Matrix (Test_22)
- **Description:** Compares lossy auto, lossy VarDCT, and lossless Modular at locked lightbox target to quantify archival/local-computer cost against web settings.
- **Usage:**
  ```bash
  TEST22_LIMIT=2 TEST22_TARGET=1600 TEST22_QUALITY=85 TEST22_EFFORT=3 node benchmark/test_22_modular_lossless_matrix.mjs
  ```

## Desirable Tests

Future or desirable backend benchmarks that would be beneficial to implement or formalize. Metrics below can be filled with ticks (✓) for capability or average timings/findings for continuous measurements.

| TestID | TestName | Brief_descr | Option_A_name vs Option_B_name | .ORF | .RAW | .CR2 | .JPG | small (320px) | medium (800px) | High (1920px) | Original size |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Test_1 | progressive vs 1-shot | Assess total decode time | 430ms vs 230ms | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Test_2 | Thumbnail Generation | Encode and decode low-res thumbs | 400px progressive vs oneshot | ✓ | ✓ | ✓ | ✓ | ✓ |   |   |   |
| Test_3 | Lightbox Detail View | Full-res encoding and ROI paint | Full progressive vs ROI ds=1 | ✓ | ✓ | ✓ | ✓ |   | ✓ | ✓ | ✓ |
| Test_4 | Bulk Image Testing | Batch/Gallery sequential encode | Encode vs decode ms/peak mem | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |   |   |
| Test_5 | First-Paint Streaming | Streaming decode byte cutoffs | 25% vs 50% byte PSNR | ✓ |   | ✓ |   |   | ✓ | ✓ |   |
| Test_6 | Policy Matrix Sweep | Find optimal JXL settings | VarDCT vs Modular / Resampling | ✓ |   | ✓ | ✓ |   | ✓ | ✓ |   |
| Test_7 | P3.1 Feature Benchmark| Progressive decode features | previewFirst vs ds2 vs ROI | ✓ |   | ✓ |   |   | ✓ | ✓ |   |

## Test Scenarios

### 1. Medium-Size (Thumbnail Generation)

**Goal:** Fast preview for galleries, lightbox thumbs.

**Files:** 3–5 representative ORFs, 4608×3456 px native resolution.

**Encode Settings:**
```javascript
{
  target: 400,        // px long-edge (e.g., 400×300)
  effort: 3,          // balance speed/ratio
  quality: 80,        // acceptable thumb quality
  progressive: true,
  progressiveFlavor: 'ac',
  previewFirst: false,  // disabled (adds overhead)
}
```

**Decode Settings:**
- Full: `{ downsample: 1 }`
- Optimized: `{ downsample: 2 }` → expect ~2.4× speedup
- With cache policy: `{ cachePolicy: 'onFinal' }`

**Success Criteria:**
- Thumb encode < 200ms
- Thumb decode < 100ms
- File size < 50KB per thumb

**Results Template:**
```
| File | Encode (ms) | Size (KB) | Decode Full (ms) | Decode DS2 (ms) | Speedup |
|------|-------------|----------|------------------|-----------------|---------|
|      |             |          |                  |                 |         |
```

---

### 2. Full-Size (Lightbox, Detail View)

**Goal:** Fast first-paint for full-res image view (1600–2400px).

**Files:** 3–5 ORFs at full native resolution (5240×3912).

**Encode Settings:**
```javascript
{
  target: 1600,       // px long-edge (typical lightbox)
  effort: 3,          // 400–800ms encode acceptable
  quality: 85,        // web-standard quality
  progressive: true,
  progressiveFlavor: 'ac',
  previewFirst: false,
}
```

**Decode Paths:**
- **First Paint (via region):** center 50% crop at `downsample: 1`
  - Expect ~2.5× speedup vs full
  - Time to painted pixels: ~300ms
- **Full (streaming):** progressive passes, multiple cutoffs
  - Monitor pass arrival times
- **With cache:** Benchmark `onProgress` vs `onFinal` policies

**Success Criteria:**
- First paint < 400ms (center ROI)
- Full decode < 1000ms
- File size 400–600KB

**Results Template:**
```
| File | Encode (ms) | Size (KB) | First Paint ROI (ms) | Full (ms) | Speedup |
|------|-------------|----------|----------------------|-----------|---------|
|      |             |          |                      |           |         |
```

---

### 3. Progressive Testing (Effort Sweep)

**Goal:** Measure effort vs encode time vs decode smoothness.

**Files:** 1–2 reference ORFs, 1600px target.

**Effort Levels:** 3, 5, 7

**For each:**
```javascript
{ effort, quality: 85, progressive: true, progressiveFlavor: 'ac' }
```

**Metrics:**
- Encode time
- JXL file size
- Decode: first pass arrival, total passes, final time
- Pass timing sequence (when does visual quality plateau?)

**Example Results:**
```
| Effort | Encode (ms) | Size (KB) | Passes | First Pass (ms) | Final (ms) |
|--------|-------------|----------|--------|-----------------|-----------|
| 3      | 450         | 450      | 2      | 280             | 800       |
| 5      | 650         | 420      | 3      | 250             | 900       |
| 7      | 1200        | 380      | 5      | 220             | 1100      |
```

---

### 4. Bulk Image Testing (Galleries)

**Goal:** Measure batch encode/decode for multi-image lightbox.

**Setup:**
- 10 ORFs, medium size (400px target)
- Sequential encode
- Sequential decode (simulating gallery scroll)

**Metrics:**
- Total encode time
- Total decode time
- Average per-image timings
- Peak memory usage

**Results:**
```
| Scenario | Files | Avg Encode (ms) | Avg Decode (ms) | Total Time (s) | Mem Peak (MB) |
|----------|-------|-----------------|-----------------|----------------|---------------|
| Thumb    | 10    |                 |                 |                |               |
```

---

### 5. First-Paint Optimization (Streaming)

**Goal:** Minimize perceived load time in browser.

**Approach:**
1. Encode progressive JXL (effort=3)
2. Measure byte arrival times (cumulative % of file)
3. Decode at each byte cutoff → measure visual completeness
4. Find "first acceptable frame" (e.g., 70% SSIM)

**Test Cases:**
- Full image at different bandwidths (simulated via byte cutoffs)
- Region ROI (center 50%) at same bandwidths
- With/without downsample=2 fallback

**Results Template:**
```
| Bytes (%) | Time (ms) | PSNR | Region Time (ms) | Speedup |
|-----------|-----------|------|------------------|---------|
| 25        |           |      |                  |         |
| 50        |           |      |                  |         |
| 75        |           |      |                  |         |
| 100       |           |      |                  |         |
```

### 6. Timing Harness Default Alignment

- The `web/jxl-single-progressive` timing surface was starting new runs from `q95` (`very-high`), which made the larger presets look "stuck" because the encode work ballooned before the first useful decode milestone.
- The page default now matches the locked web-facing preset from `docs/Tested-settings.md`: `quality=85` (`medium`) for timing runs.
- Keep `q95` available only as an explicit inspection choice. Do not use it as the default for timing work.

---

## Decision Checkpoints

After each benchmark batch, update:

### Thumbnail Path (400px)
- [ ] Encode time acceptable (<200ms)?
- [ ] File size reasonable (<50KB)?
- [ ] Cache policy worthwhile?
- **Decision:** effort level + quality

### Full-Size Path (1600px)
- [ ] ROI first-paint fast enough (<400ms)?
- [ ] Full decode time <1000ms?
- [ ] Progressive passes visible benefit?
- **Decision:** effort level + quality + cache policy

### Progressive Detail
- [ ] Do more passes improve UX?
- [ ] Effort 3 vs 5 vs 7 trade-off?
- **Decision:** which effort to ship

---

## Implementation Checklist

- [ ] Benchmark p3 features complete (previewFirst, region, downsample)
  - [x] ORF progressive (effort=3): previewFirst disabled, region+downsample ship
  - [ ] Effort sweep (3/5/7): which is optimal?
  - [ ] Streaming byte-cutoff test
- [ ] Verify cache policies in production context
- [ ] A/B test first-paint metrics with real users
- [ ] Document final settings in README/CLAUDE.md
