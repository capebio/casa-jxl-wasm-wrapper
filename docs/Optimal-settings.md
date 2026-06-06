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
