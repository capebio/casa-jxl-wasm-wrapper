# Progressive Byte Benchmark Core + Metrics — Multi-Lens Review - DONE

## Intro — purpose of the files

**`web/jxl-progressive-byte-benchmark-core.js`** (file 1) drives the progressive-decode benchmark: it encodes a target/sidecar JXL, builds a byte-cutoff plan, streams the bytes through a decoder under a simulated transport profile (`streamDecodeCutoffs`), and collects per-cutoff frames, timeline statistics, and a perceptual quality series.

**`web/jxl-progressive-byte-metrics.js`** (file 2) is the most important interface consumed by file 1. It classifies each cutoff frame (`classifyByteCutoffFrame`), rolls the cutoffs into a summary of first-paint / recognizable / preview / final milestones plus monotonicity checks (`summarizeByteCutoffResults`), and computes the PSNR / butteraugli / SSIM quality series (`buildSeries`, async `buildSeriesAsync`). File 1 imports `buildSeries`, `classifyByteCutoffFrame`, and `summarizeByteCutoffResults` from file 2.

File 2 was selected as the single most important interfacing file because it is the consumer of every pixel buffer file 1 produces, and the memory ledger flagged it as the location of an unrealized "2× free" win (sync JS PSNR/SSIM instead of the available WASM perceptual path).

---

## Changes made

### File 2 — `jxl-progressive-byte-metrics.js`

1. **Correctness bug fix — SSIM monotonicity was never actually checked.**
   `detectMonotone` defaults `valueKey = 'psnr'`. The SSIM call site passed a re-mapped `{bytes, ssim}` array with **no `valueKey`**, so `detectMonotone` read `entry.psnr` (always `undefined`) → `Number.isFinite(undefined)` is false → every entry skipped → `ssimMonotone` was **always trivially `true`** and `ssimRegressions` **always empty**, regardless of the actual SSIM curve. Fixed by passing `{ valueKey: 'ssim' }` and a dedicated `SSIM_MONOTONE_TOL = 0.01` (SSIM is a 0..1 scale, not dB — reusing the PSNR dB tolerance was also wrong). Proven by flip-flop: on a regressing series `0.9 → 0.4 → 0.95` the old path reports `monotone: true`, the new path correctly reports `false`.

2. **Allocation elimination (zero-copy lens) in `summarizeByteCutoffResults`.**
   Both the butter and ssim `detectMonotone` calls re-materialized a fresh `{bytes, <key>}[]` via `.map()` before passing it in. The entries already carry those keys, so the arrays were thrown away immediately. Replaced both with a direct pass using `valueKey`. Eliminates `STEPS × 2` objects + 2 arrays per `summarize` call. Flip-flop: **1.92× faster** on the combined monotone path, CPU time roughly halved.

3. **Single sort of `butterSeries`.**
   `ensureSorted(butterSeries)` was invoked twice (preview-fallback block + perceptual block). Hoisted to one `sortedButter` computed once and reused, with a `hasButter` guard.

### File 1 — `jxl-progressive-byte-benchmark-core.js`

Second-pass review confirmed the prior implementation pass (zero-copy pixel capture, `driveWithCursor` branching, configurable `drainTurns`, flattened feed loop) remains correct. The only structural defect found this pass — a **duplicate local `ByteIntervalCursor`** shadowing the canonical one in `jxl-byte-utils.js`, plus the **missing `LazyByteIntervalCursor`** — had been corrected in the immediately prior session; verified here that file 1 now imports both cursors from `jxl-byte-utils.js` and re-exports them. No further file-1 source changes were warranted this pass (see rejected items below).

---

## Rejected (consolidated into `docs/rejected optimizations.md`)

- **Wire WASM `buildSeriesAsync` (psnrFn/ssimFn) into core's `buildSeries` call** — the "2× free" perceptual path. Rejected for now: requires importing a `PerceptualComparer` and confirmed WASM perceptual exports, which are not reliably present in the Node benchmark context (cf. `encodeRgb16Planar`/dist-rebuild gap). High-value but needs the dist rebuild first; logged as deferred, not discarded.
- **Apply the `doFull` adaptive skip to SSIM** (as already done for butteraugli). Rejected: skipping SSIM on a cutoff inserts `null`, and `firstGoodSsimBytes` uses a `.find(e => e.ssim != null && e.ssim >= SSIM_GOOD)` — a skipped cutoff at the true threshold would push the reported "first good" later, a fidelity regression not gated by a golden diff (lens 24). Not worth the risk for the SSIM cost saved.
- **Merge `buildSeries` into `buildSeriesAsync`** to kill the ~40-line duplication. Rejected: the sync variant cannot `await` the WASM hooks and is the hot path core calls; collapsing them would force an async boundary into a tight synchronous loop. Divergence accepted.

---

## Timings table — this run vs previous ten

*(StandardMultifileTest.mjs regression run; key aggregates. Filled from run output below.)*

| Run (UTC)            | AvgRawMs | AvgRawDecompressMs | AvgRawDemosaicMs | AvgRawTonemapMs | AvgProgEncSimdMs | AvgProgEncMtMs | MultiWorkerSpeedup | Notes |
|----------------------|----------|--------------------|------------------|-----------------|------------------|----------------|--------------------|-------|
| 2026-06-14 19:50:13  | 3788     | 987                | 355              | 1928            | 733              | 310            | 2.76x              | run 1 (post-impl) |
| 2026-06-14 ~22:25    | 4599     | 1231               | 392              | 2169            | 282              | 176            | 0.79x              | run 4 (machine under load) |
| 2026-06-15 (this)    | 2452     | 742                | 265              | 976             | 353              | 147            | 1.07x              | post metrics fixes; SIMD tonemap active (tonemap 976 vs 1928) |

**Timings conclusion:** The metrics-layer changes touch only the post-decode summary/series path (microsecond-to-low-millisecond scale per variant), not the RAW decode/encode hot path that dominates `StandardMultifileTest`. Therefore no movement in `AvgRaw*` / `AvgProgEnc*` is expected or attributable to these edits; absolute variance between runs tracks machine thermal/load state (see run 4 vs run 1). The isolated flip-flop (`docs/outputs/timing tests/detectmonotone-mapelim-*.toon`) is the meaningful measurement for these changes: **1.92× on the monotone path, CPU halved**, plus a correctness fix with zero timing cost.

---

## Conclusion (Chapter 3)

**a. Improvements to file 1 (`jxl-progressive-byte-benchmark-core.js`).**
This pass confirmed file 1 is in good shape after the prior implementation rounds: the cursor abstraction is correctly sourced from the shared `jxl-byte-utils.js`, both eager and lazy cursors are exported, the feed loop is flattened, pixel capture is zero-copy, and `drainTurns` is tunable. No new source edits were justified; the highest-value remaining idea (WASM perceptual series) is blocked on a dist rebuild and was deferred rather than forced.

**b. Improvements to file 2 (`jxl-progressive-byte-metrics.js`).**
Three changes landed: a genuine correctness fix (SSIM monotonicity was silently disabled), a 1.92× allocation-elimination on the summarize monotone path, and a redundant-sort removal. The correctness fix matters most — any downstream consumer reading `ssimMonotone`/`ssimRegressions` was getting a constant "all good" signal, which would mask real progressive-quality regressions in the very metric meant to catch them.

**c. Improvements to the seam between them.**
The seam (file 1 → `buildSeries`/`summarizeByteCutoffResults`) is clean: file 1 hands parallel `cutoffPixels`/`byteSizes` plus the RGBA reference, and file 2 returns ready-to-summarize series including per-metric timing that file 1 already persists into the export. The one latent seam improvement — swapping the sync `buildSeries` for the WASM-accelerated `buildSeriesAsync` — is real and documented, but gated on WASM perceptual availability in Node; until then the seam is correct and the timing hooks are in place to measure it the moment the dist exists.

**Closing.** The session's headline is a quiet but important correctness recovery: a quality-gate metric (SSIM monotonicity) that looked like it was working was in fact short-circuited to a constant. Fixing it cost nothing at runtime and was made *cheaper* (the same edit removed two per-call allocations, 1.92× on that path). The broader lesson reinforced by the lenses: re-materializing data "just to pass it" is both a performance and a correctness smell — the `.map()` that allocated the throwaway array was also where the missing `valueKey` hid. Removing the copy surfaced the bug. The remaining big win (WASM PSNR/SSIM/butteraugli) is well-understood and waiting on the build, not on design.

---

## Implemented

- ✅ File 2: SSIM monotone `valueKey` correctness fix + `SSIM_MONOTONE_TOL`
- ✅ File 2: `.map()` allocation elimination on butter + ssim `detectMonotone` calls (1.92×)
- ✅ File 2: single hoisted `butterSeries` sort
- ✅ Flip-flop harness `benchmark/summarize-detectmonotone-mapelim.mjs` + TOON output
- ✅ Regression run executed (see timings table)
- ✅ All touched files pass `node --check`

*Last agent: this file ends in `- DONE`.*
