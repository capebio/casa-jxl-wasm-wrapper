# JXL Option Matrix Report

**Image:** small_file.jpg (300×225)  
**Generated:** 2026-05-30 16:05:18  
**Cells:** 360  
**Pivot:** quality × effort

> ⚠️ This run used fallback WASM builds — advanced options (modular, brotliEffort, decodingSpeed) had limited or no effect.

### Encode Time (median ms) — lower is better

> Lower values are faster. Color not shown in markdown.

| quality \ effort | 1 | 3 | 5 | 7 | 9 |
|----------|---------|---------|---------|---------|---------|
| **70** | 29ms | 41ms | 163ms | 376ms | 1491ms |
| **80** | 25ms | 41ms | 170ms | 314ms | 1240ms |
| **88** | 29ms | 47ms | 172ms | 311ms | 1256ms |
| **95** | 30ms | 48ms | 176ms | 308ms | 1268ms |

### Output Size (median KB) — lower is better

> Smaller files are better.

| quality \ effort | 1 | 3 | 5 | 7 | 9 |
|----------|---------|---------|---------|---------|---------|
| **70** | 6.9KB | 6.3KB | 5.0KB | 5.2KB | 4.6KB |
| **80** | 9.1KB | 8.5KB | 7.0KB | 7.1KB | 6.6KB |
| **88** | 13.3KB | 12.4KB | 11.4KB | 11.2KB | 10.7KB |
| **95** | 20.2KB | 19.1KB | 18.0KB | 18.0KB | 17.2KB |

## Per-Factor Summaries (median time)

**effort**

- 1: 28ms
- 3: 44ms
- 5: 172ms
- 7: 320ms
- 9: 1299ms

**quality**

- 70: 164ms
- 80: 170ms
- 88: 172ms
- 95: 176ms

## Top Combinations

### Fastest

| Time | Size | Config |
|------|------|--------|
| 20ms | 6.9KB | progressive=false previewFirst=false chunked=false resampling=1 effort=1 quality=70 |
| 21ms | 9.1KB | progressive=false previewFirst=false chunked=false resampling=1 effort=1 quality=80 |

### Smallest Files

| Size | Time | Config |
|------|------|--------|
| 4.6KB | 1560ms | progressive=false previewFirst=false chunked=false resampling=1 effort=9 quality=70 |

---

*Source: C:\Foo\raw-converter-wasm\benchmark\runs\2026-05-30T15-49-18\matrix-results.json*

## Predator Progressive Layer Metrics (2026-06-03 addendum)

**Script:** `node benchmark/predator-progressive-metrics.mjs --image "c:\Foo\raw-converter\tests\small_file.jpg"`

**Sweep:** 18 cells (progressiveDc × groupOrder × effort at 3/5/7). Base: progressive=true, previewFirst=true, quality=85, full decoder flags (emitEveryPass + progressiveDetail:'passes') matching paint path. Tier=simd (non-mt).

**Key artifacts:**
- `predator-progressive-layers-2026-06-03T05-35-40.json`
- `predator-progressive-layers-2026-06-03T05-35-40.csv`

**Summary table (from run):**

| progressiveDc | groupOrder | effort | encodeMs | sizeKB | progressEvents | firstProgressBytes | firstProgressMs |
|---------------|------------|--------|----------|--------|----------------|--------------------|-----------------|
| 0 | 0 | 3 | 101.7 | 11.3 | 2 | 11.3k | 71.1 |
| 0 | 0 | 5 | 103.6 | 9.7 | 2 | 9.7k | 10.4 |
| 0 | 0 | 7 | 106.7 | 9.6 | 2 | 9.6k | 8.7 |
| 0 | 1 | 3 | 15.2 | 11.3 | 2 | 11.3k | 12.4 |
| 0 | 1 | 5 | 46.1 | 9.7 | 2 | 9.7k | 8.1 |
| 0 | 1 | 7 | 79.9 | 9.6 | 2 | 9.6k | 8.1 |
| 1 | 0 | 3 | 20.0 | 11.5 | 2 | 11.5k | 11.9 |
| 1 | 0 | 5 | 49.9 | 9.6 | 2 | 9.6k | 8.1 |
| 1 | 0 | 7 | 83.3 | 9.5 | 2 | 9.5k | 8.6 |
| 1 | 1 | 3 | 26.8 | 11.5 | 2 | 11.5k | 11.2 |
| 1 | 1 | 5 | 53.3 | 9.6 | 2 | 9.6k | 9.5 |
| 1 | 1 | 7 | 86.6 | 9.5 | 2 | 9.5k | 7.1 |
| 2 | 0 | 3 | 23.0 | 14.1 | 2 | 14.1k | 10.0 |
| 2 | 0 | 5 | 48.7 | 12.2 | 2 | 12.2k | 9.3 |
| 2 | 0 | 7 | 83.0 | 12.1 | 2 | 12.1k | 8.4 |
| 2 | 1 | 3 | 21.2 | 14.1 | 2 | 14.1k | 10.1 |
| 2 | 1 | 5 | 45.1 | 12.2 | 2 | 12.2k | 7.9 |
| 2 | 1 | 7 | 79.7 | 12.1 | 2 | 12.1k | 6.9 |

**Key observations (see HANDOFF-predator-continuation-2026-06-encode-matrix.md for full analysis):**
- Event count fixed at **2** for all combos on this real small photo ref (no increase from Dc=2; contrast to synthetic noise tests ≥3).
- `firstProgressBytes` == total size in all cases under natural-chunk incremental feed (first progress surfaced post-full-codestream in the collection loop).
- Strong encode-time win for `groupOrder=1` (center-out) at low effort.
- `progressiveDc=2` adds ~20-25% size for no additional event count here.
- The matrix (web/jxl-correlation-matrix + worker) now also collects + surfaces these layer metrics (Prog Events, 1st Prog ms/KB) for any progressive + Dc/group sweep via the page.
- Recommendation: for small images, `groupOrder=1 + previewFirst` high value (speed + center visual). Dc=2 if you need extra DC detail and can pay size. Full-file event count is weak proxy for "bytes to recognizable"; prefer byte-cutoff/prefix probe (see progressive-byte-benchmark + paint cutoff) for future.

*Generated from predator-progressive-layers-2026-06-03T05-35-40 data. Update with page A/B visuals or larger refs (Gobabeb) + prefix-probe numbers when available. (Probe enhancement + matrix minB column now live; fresh synthetic runs produce minBytesToFirstProgress.)*
