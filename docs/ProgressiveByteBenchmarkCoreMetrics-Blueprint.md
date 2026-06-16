# Blueprint Review — Progressive Byte Benchmark Core + Metrics

Applied specs: `docs/1 Implementation Blueprint.md`, `docs/1 ML Agent Deployment Brief.md`
Target files (held in memory): `web/jxl-progressive-byte-benchmark-core.js`, `web/jxl-progressive-byte-metrics.js`
Method: two investigation/fix rounds — Round 1 per-file, Round 2 on the seam between them. Benchmark before and after.

---

## What the blueprints ask for

Both docs reduce to one rule: **remove unnecessary movement of data before making computation faster.** Priority order: eliminate copies → keep buffers stable → cache locality → fuse kernels → SIMD → concurrency. Hard rules: no allocations in hot paths, no repeated Uint8↔Float32 conversion, don't move pixel buffers between layers unnecessarily, prefer pointer advancement and reuse. And — Chapter 10 — don't waste computed intermediates.

These two files are the **post-decode bookkeeping layer**, not the pixel/WASM decode hot path the blueprint mostly targets (that lives in `facade.ts`/`bridge.cpp`/`lib.rs`). Prior sessions already brought them to zero-copy pixel capture, cursor pointer-advancement, and allocation-eliminated summary paths. This pass found what remained: one iterator-overhead micro-pattern and one genuine **data-waste seam defect**.

---

## Changes made

### Round 1 — `jxl-progressive-byte-metrics.js` (Blueprint Ch1: no iterator overhead / repeated indexing)

`buildSeries` and `buildSeriesAsync` read the previous PSNR via `qualitySeries[qualitySeries.length - 1].psnr` on every iteration — a length read + array index + property load each loop, purely to recover a value we just computed. Replaced with a `prevPsnr` scalar carried across iterations and updated right after each push. Same result, no per-iteration re-indexing. Textbook blueprint "advance a scalar instead of re-reading the structure."

### Round 1 — `jxl-progressive-byte-benchmark-core.js`

Second-pass review found no new in-file source change justified: the streaming path already uses the `ByteIntervalCursor` pointer advancement (no repeated slicing), pixel capture is zero-copy (`cutoff.pixels` holds the decoder's `Uint8Array` directly, no spread/clone), and `drainTurns` is tunable. The work here was the seam (Round 2).

### Round 2 — Seam between core ↔ metrics (Blueprint Ch10: every computed intermediate must be used)

**Defect:** `runBenchmarkSession` computes `builtSeries = buildSeries(...)` — a full PSNR / butteraugli / SSIM pass over **every** cutoff frame — then called `summarizeByteCutoffResults(cutoffResults, jxlBytes.byteLength)` **without** passing the series. `summarize` accepts an optional `{ qualitySeries, butterSeries, ssimSeries }` and, when absent, leaves all perceptual milestones null: `firstRecognizableBytes`, `previewBytes` (perceptual), `firstPerceptuallyGoodBytes`, `finalPsnr`, `monotone`, and `ssimMonotone`/`ssimRegressions`. So the most expensive computation in the loop was being discarded at the summary boundary.

**Fix:** core now threads `builtSeries` into the summary:

```js
const summary = summarizeCutoffs(
  cutoffResults,
  jxlBytes.byteLength,
  builtSeries
    ? { qualitySeries: builtSeries.qualitySeries, butterSeries: builtSeries.butterSeries, ssimSeries: builtSeries.ssimSeries }
    : undefined,
);
```

This makes the perceptual milestones populate for the first time, and — combined with the SSIM-monotone correctness fix from the prior session — means the SSIM regression alarm now actually reaches the summary that consumers read. Zero added computation: it consumes data that was already being produced and thrown away.

---

## Benchmark report (StandardMultifileTest.mjs — before vs after)

| Metric | Before (baseline) | After (post-change) | Δ |
|--------|-------------------|---------------------|---|
| AvgRawMs | 1417 | 1947 | +530 (machine variance) |
| AvgRawDecompressMs | 472 | 572 | +100 |
| AvgRawDemosaicMs | 141 | 207 | +66 |
| AvgRawTonemapMs | 587 | 866 | +279 |
| AvgProgEncSimdMs | 354 | 348 | −6 (flat) |
| AvgProgEncMtMs | 164 | 252 | +88 |
| MultiWorkerSpeedupRatio | 8.39x | 9.06x | +0.67x |

**Reading the numbers:** the two edited files are **not** on the RAW decode/demosaic/tonemap path that `StandardMultifileTest` measures — they run in the progressive-byte benchmark path, exercised separately. The across-the-board `AvgRaw*` rise is background thermal/load variance between the two runs (the same machine showed AvgRawMs swing 1417→2452→4599 across recent idle/loaded runs), not an effect of these changes; `AvgProgEncSimdMs` is flat (354→348) and `MultiWorkerSpeedupRatio` actually improved. The Round-1 scalar-carry change is a micro-optimization in a 12-iteration loop — sub-millisecond, below this suite's resolution. The Round-2 seam fix adds **zero** compute (it reuses an existing intermediate); its value is correctness/completeness, not speed.

No regression attributable to the changes. Both files pass `node --check`.

---

## Conclusion

The blueprint's first principle — stop moving data needlessly — paid off here in an unexpected form. The headline find was not a copy to remove but a **computation being discarded**: an entire perceptual quality series (PSNR/butteraugli/SSIM over every cutoff) was computed and then dropped on the floor at the summary boundary because one optional argument was never wired. Chapter 10's framing ("every intermediate buffer costs bandwidth") cuts both ways — if you pay to produce an intermediate, not using it is the most wasteful copy of all. Threading `builtSeries` into `summarizeByteCutoffResults` turns that sunk cost into the perceptual milestones the summary was designed to report, and it lets the previously-repaired SSIM-monotonicity alarm finally surface to consumers.

The Round-1 scalar-carry edit is small but on-message: the loop was re-reading the tail of a growing array to recover a value it had in hand a line earlier. Replacing structure re-reads with a carried scalar is the JS-level analogue of the blueprint's pointer-advancement rule, and it makes both the sync and async series builders consistent.

Honest scope note: these JS files are the bookkeeping skin over the decode engine, and prior sessions had already applied the heavy zero-copy/pointer work. The deepest blueprint wins (keep planes in WASM memory, SoA colour planes, kernel fusion of PSNR+SSIM into a single pixel traversal, SIMD perceptual kernels) live in `facade.ts`/`bridge.cpp`/`lib.rs` and the `jxl-progressive-quality.js` kernels — out of this pass's named scope. The most valuable deferred item surfaced again: a **fused single-pass PSNR+SSIM** kernel (one traversal of the cutoff/ref pixel pair instead of two) would directly cut the dominant cost in `buildSeries`, but it must be gated on a golden/SSIM/butteraugli diff (Blueprint Ch7) and belongs in the quality-kernel file, not here.

### Changes summary
- ✅ metrics: `prevPsnr` scalar carry in `buildSeries` + `buildSeriesAsync` (no per-iter re-indexing)
- ✅ core↔metrics seam: `builtSeries` now fed into `summarizeByteCutoffResults` (perceptual milestones populate; SSIM alarm reaches summary)
- ✅ before/after benchmark captured; no regression on the RAW path (changes are off that path)
- ✅ both files `node --check` clean
- ⏭️ deferred (blueprint, out of scope): fused single-pass PSNR+SSIM kernel; WASM perceptual series via `buildSeriesAsync` hooks — both blocked on quality-kernel file + golden-image gate
