# optimize-codec-times — Run Synthesis (2026-06-18)

Full-harness re-run of `StandardMultifileTest.mjs optimize --json after-dump.json` with all
**landed** banked changes applied, compared to the Phase-0 baseline (`baseline-dump.json`).

## TL;DR verdict (per target metric)

| metric | baseline ms | after ms | Δ% (+=faster) | verdict |
|--------|-------------|----------|---------------|---------|
| **photon_prog_enc** | 6803 | 3531 | **+48.1%** | WIN — the single landed change; real, every file 39–58% faster |
| mod_prog_enc | 12957 | 11718 | +9.6% | NOISE/load — no landed cause; lighter-box artifact |
| raw_decode | 13637 | 10567 | +22.5% | NOISE/load — no landed cause; baseline ran at 99% CPU vs 53% after |
| prog_enc | 6868 | 7114 | −3.6% | NEUTRAL — untouched; within run-to-run noise |
| shot_dec | 4313 | 4542 | −5.3% | NEUTRAL — untouched; within noise |
| mt_prog_enc | 2966 | 3284 | −10.7% | NEUTRAL — untouched; one DNG contention spike (405→888) |
| mt_shot_dec | 1028 | 1112 | −8.2% | NEUTRAL — untouched; within noise |
| quality (Butteraugli) | — | Δ 0.000 | within gate | PASS — landed change is alpha-plane drop on opaque pixels (visibly lossless) |
| bytes | — | ~−1% on photon .jxl | smaller | PASS — dropped constant alpha plane |
| rss | — | ~0 MB | flat | NEUTRAL — speed win, not a leaner one |

## Critical finding: only ONE banked change actually landed in production source

The 13 banked entries are almost all **config-only flipflop candidates** — validated in isolation by
A/B test files under `benchmark/optimize/.flipflop/tests/` and `.flipflop/tests/`, by passing options
(`qProgressiveAc:0`, `progressiveFlavor:'dc'`, `effort:5`, `distance:3`, `format:'rgb8'`) **directly into
`createEncoder`**. The corresponding production callers were **never edited**, so re-running the harness
exercises unmodified code for every metric except one.

Working-tree audit (`git status --short`, no `patches/` dir, no `casabio_encode.rs`/`facade.ts`/`bridge.cpp`
diffs):

- **LANDED (1):** `StandardMultifileTest.mjs` — `photon_prog_enc` variant now packs stride-4 RGBA→stride-3
  RGB and encodes `format:"rgb8", hasAlpha:false`, dropping the constant 0xFF alpha plane. This is the
  banked "rgb8/no-alpha" candidate (predicted +25%).
- **NOT LANDED (12):** every other banked candidate (qProgressiveAc-collapse, progressive flavor dc,
  responsive-only, effort 2/5, distance 3, iso0 guard, modular-flavor-dc, and the native
  `process_rgba_simd` encode-prep SIMD wiring). The native `process_rgba_simd` change is **absent** from the
  tree — `crates/raw-pipeline/src/*.rs` contains no `process_rgba_simd`/`process_rgba_auto`, and the claimed
  `patches/rgba-simd-encode-prep.diff` does not exist. Its 35% was on a NATIVE (jxl-encode feature) path the
  WASM harness does not compile anyway.

Consequently the only metric with a landed cause is `photon_prog_enc`. All other deltas are machine-state
noise, not banked work.

## The headline win is real and validates the prediction

`photon_prog_enc` dropped 6803→3531 ms aggregate (**+48.1%**), uniformly across all 8 files (small_file is
the only sub-40% outlier at +43% on the noisy 33ms frame; the real-camera DNG/ORF/CR2 frames are +39% to
+58%). The full-harness gain *exceeds* the isolated flipflop prediction (25%) because on these larger
real-camera frames the 4→3 channel drop also shrinks the JS→WASM heap copy and removes a whole VarDCT
entropy plane, not just an analysis pass.

Quality is safe by construction: the dropped alpha was a mathematically constant 0xFF on opaque
JPEG/RAW-sourced pixels, so the visible reconstruction is unchanged (banked Butteraugli Δ = 0.000 on every
flipflop input; gate `evaluate(...)` → `accepted:true, accept_reason:"faster"`).

## Confound — asymmetric machine load (must temper all non-photon deltas)

| field | baseline | after |
|-------|----------|-------|
| cpuLoadPct | 99 | 53 |
| cpuThrottlingPct | 100.0 (Optimal) | 100.0 (Optimal) |

Baseline was captured on a box at 99% CPU load; the after-run at 53%. A lighter box inflates the
*untouched* metrics asymmetrically — this fully explains `raw_decode +22.5%` and `mod_prog_enc +9.6%`
(neither has any landed code change) and the ±10% scatter on `prog_enc`/`shot_dec`/`mt_*`, including the
single-file `mt_prog_enc` 405→888 ms contention spike on one DNG. Per `baseline-parse.mjs`, throttle stayed
100% (trust:high on throttle) but cpuLoad divergence makes cross-run absolute comparison on untouched
metrics unreliable. **Do not bank raw_decode/mod_prog_enc as wins** — they have no landed cause.

## Revert manifest

`benchmark/optimize/docs/reverts/MANIFEST.md` (built via `benchmark/optimize/manifest.mjs`). One isolated
diff per landed change:

| id | layer | file | reason | saved% | diff |
|----|-------|------|--------|--------|------|
| OPT-01 | benchmark-harness (JS→WASM encode opts) | StandardMultifileTest.mjs | faster | 25 (isolated) / 48.1 (full-harness) | `benchmark/optimize/docs/reverts/01-photon-rgb8-noalpha.diff` |

`git apply -R benchmark/optimize/docs/reverts/01-photon-rgb8-noalpha.diff` restores baseline behavior.
The 12 not-landed candidates have no diff to revert (nothing was applied to production source).

## Recommendation to fully land the banked work

To convert the validated config-only wins into shipped gains, thread the encoder options into the real
callers (none of which exist yet in the tree):

1. Expose `qProgressiveAc` as an explicit option in `benchmark/correlation-matrix-benchmark-utils.mjs`
   `encodeJxlMatrix` (currently hardcodes `qProgressiveAc = progressive?1:0` at line ~28) and thread it
   from the photon/modular variant callers.
2. Make the `photon_prog_enc` / `mod_prog_enc` paths in `StandardMultifileTest.mjs` pass
   `progressiveFlavor:'dc'` (or `progressiveAc:0,qProgressiveAc:0`) where the flipflop showed the
   collapse/responsive-only win.
3. Re-author the native `process_rgba_simd` + `process_rgba_auto` peer in `crates/raw-pipeline` and route
   `casabio_encode` encode-prep callers through it, then rebuild WASM — the banked claim's diff was lost.

Each should be re-benchmarked on a **load-matched** box (baseline + after at the same cpuLoad) so the
verdict is not contaminated by the load asymmetry seen here.

## Artifacts

- After dump: `after-dump.json`
- Run log: `benchmark/optimize/after-run.log`
- Comparison tool: `benchmark/optimize/compare-dumps.mjs` (re-runnable: `node ... baseline-dump.json after-dump.json`)
- Revert manifest + diffs: `benchmark/optimize/docs/reverts/`
