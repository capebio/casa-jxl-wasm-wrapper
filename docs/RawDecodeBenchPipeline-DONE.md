# raw_decode_bench.rs × pipeline.rs — Multi-Lens Review - DONE

Date: 2026-06-15
Targets:
- File 1: `.worktrees/check-368/src/bin/raw_decode_bench.rs` (named by user)
- File 2 (optimal interface, my choice): `.worktrees/check-368/crates/raw-pipeline/src/pipeline.rs`

## Intro — purpose of the files

`raw_decode_bench.rs` is the native RAW-decode benchmark harness. It drives the
real decode pipeline over ORF / DNG / CR2 corpora and reports per-stage timings
(`parse`, `decompress`, `demosaic`, `tonemap`, `direct-rgba`, JXL encode/decode)
to stdout and to `benchmark/results_native.json`. Its schema is the native
counterpart of the WASM `raw-format-sweep-results.json`, so native and WASM/Tauri
numbers can be compared apples-to-apples (boundary-cost audit, suggested-settings).

`pipeline.rs` is the 16-bit-RGB → 8-bit-sRGB tone pipeline — the cost center the
bench actually measures. The bench's `tonemapMs` is `pipeline::process` and its
`directRgbaMs` is `pipeline::process_rgba`. It owns the pre-LUT (black/WB/exposure
+ highlight shoulder), the 3×3 CamRGB→sRGB matrix, saturation/vibrance, the
post-LUT tone curve, and the optional perceptual-constancy path. It is the single
most important file the bench links: the bench is the instrument, `pipeline.rs` is
the specimen under the lens.

This was the natural file-2 choice over `demosaic.rs`/`decompress.rs`/`cr2.rs`:
project memory records tone/`apply_tone_math` as ~70% of the RAW pipeline and the
established cost center, and it is the stage the bench reports as a headline metric
(`direct_rgba` vs WASM `rgb_to_rgba`).

## Procedure followed

- Round 1 + 2: two lens passes over `raw_decode_bench.rs`.
- Round 3: loaded `pipeline.rs` (file 2) and ran the lens pass over the hot path
  (`process_into`, `process_rgba`, `process_16bit`, `apply_tone_math`, LUT cache).
- Seam pass: examined the bench ↔ pipeline boundary (timed regions, LUT-cache
  reuse across `process`/`process_rgba`, 3ch-vs-4ch output).

## Changes made

### File 1 — `raw_decode_bench.rs`

1. **Bounds guard in `bench_orf` (correctness — lens 4/8).**
   The ORF strip was sliced as
   `&data[strip_offset .. strip_offset + strip_byte_count]` with no bounds check,
   so a malformed/truncated ORF (bad TIFF strip fields) panics the whole bench
   run mid-corpus. `process_orf_to_rgba8` already guards this exact case; the
   primary `bench_orf` did not. Added the matching guard that prints
   `[skip] … strip out of bounds` and returns, so one bad file no longer aborts
   the sweep.

2. **Deterministic corpus selection in `scan_orf_dir` (lens 27 — benchmark integrity).**
   The scanner pushed matches in `read_dir` order, broke at `len() >= limit`, and
   only *then* sorted. Filesystem iteration order is not guaranteed stable across
   runs, so `GOB_SCAN_LIMIT=30` could select a *different* 30 files on different
   runs — silently changing the benchmark population. Now it collects all matches,
   sorts, then truncates to `limit`: the first N files alphabetically, reproducibly.
   Same selection every run = comparable timings every run.

3. **Hoisted filter lowercasing + `rd.flatten()` (micro, support code).**
   `name_filter.to_lowercase()` was recomputed for every directory entry inside the
   loop; hoisted to a single `filter_lc` binding. `for e in rd { if let Ok(e) = e`
   collapsed to `for e in rd.flatten()`.

4. **Divide-by-zero guard on `mpps` (correctness, all three `bench_*` fns).**
   `mp / (demosaic_ms/1000)` produced `inf`/`NaN` if a demosaic stage measured
   0 ms (tiny/degenerate image). Guarded to `0.0` when the denominator is
   non-positive, so the printed MP/s never poisons output with `inf`.

### File 2 — `pipeline.rs`

5. **Removed dead bindings in `PerceptualGrid::new` (build hygiene / correctness).**
   `let vib = 0.0; let vibz = true; let m = &CAM_TO_SRGB;` were all unused
   (the grid is built at a fixed `scale` and samples the post-matrix advanced path
   directly), emitting three `unused variable` warnings. Removed; folded the intent
   into the `scale` comment. No behavior change — the perceptual grid is only built
   when `perceptual_constancy` is set (off in the bench).

## Candidates examined and rejected (logged in `docs/rejected optimizations.md`)

- **Replicate the `process_into` 4× unroll into `process_rgba`/`process_16bit`
  (non-parallel).** The native bench builds with default features (`parallel`), so
  it executes the *rayon* branch, not the scalar 4×-unroll branch. The unroll
  asymmetry has zero effect on any measured bench number; adding it widens scope
  with no evidence of gain. Rejected (no benchmark evidence per CLAUDE.md).
- **Warmup run in `bench()`.** Min-of-3 already discards the cold first-iteration
  outlier for the reported figure; an extra warmup only adds wall time.
- **Cache `process_orf_to_rgba8` re-decode in the P2200 scan.** The ROI scan
  re-reads + re-decodes the file that `bench_orf` already decoded, but that work is
  *outside* every timed region (it only produces pixels to crop). Deduplicating it
  saves scan wall-time but changes nothing measured; not worth the coupling.
- **Emit p50/max alongside min in the JSON.** The schema contract is
  `"reporting": "minimum"`; widening it is a cross-file schema change, out of scope.

## Timings — no timing-affecting change

None of the applied edits touch a timed region or the tone hot path's arithmetic:

| Change | In a timed region? | Hot-path arithmetic? |
|--------|--------------------|----------------------|
| ORF strip bounds guard | No (before `bench()` calls) | No |
| `scan_orf_dir` sort/truncate | No (corpus setup) | No |
| filter hoist / `flatten` | No (setup) | No |
| `mpps` guard | No (reporting line) | No |
| `PerceptualGrid` dead bindings | No (off in bench) | No |

A this-run-vs-previous-ten timings table is therefore not meaningfully producible
from these edits — there is no signal to compare, and fabricating numbers would
violate the grounding rule. The honest result is **no regression by
construction**: the tone kernel bytes are unchanged and the shipped `web/pkg` WASM
was not touched.

Flip-flop A/B tests were considered and judged **not applicable**: there is no
suspected slow/fast mechanism change to isolate (correctness + benchmark-integrity
edits only).

## Conclusion (Chapter 3)

### a. Improvements to file 1 (`raw_decode_bench.rs`)
The harness is now robust to a bad file mid-corpus (no panic-abort), and — more
importantly for a *benchmark* — its corpus selection is deterministic. Before, the
reference-set scans (`GOB_SCAN_LIMIT`, `P2200_SCAN_LIMIT`) could measure a
different set of files run-to-run, making cross-run timing comparison unsound at
the very limit values the harness exists to support. Sort-then-truncate fixes that
at the root. The `mpps`/`inf` guard and filter hoist are small hardening.

### b. Improvements to file 2 (`pipeline.rs`)
The tone hot path is already mature (project optimization score 5/5: rayon, cached
tri-LUT, `mul_add` FMA, pointer-advance loops). The lens pass surfaced no
evidence-backed perf win on the branch the bench exercises; the net-positive change
was build hygiene — three genuinely dead bindings removed from the perceptual-grid
constructor, clearing compiler noise without altering behavior. This is the correct
conservative outcome for a hot file under the "no evidence-free tunables" rule.

### c. Improvements to the seam / boundary
The bench ↔ pipeline seam is sound and worth documenting: `process` and
`process_rgba` are called with identical `PipelineParams`, so the thread-local
`LUT_CACHE` builds the LUTs once on the first `process` call and both stages then
reuse them. Because the bench reports the *minimum* of 3 runs per stage, the
reported `tonemapMs` and `directRgbaMs` both exclude LUT-build cost symmetrically —
they isolate the per-pixel pass cleanly. One nuance noted (not a code change): the
bench's "never materializes a 3ch RGB8" claim is true only of the *encode feed*;
the bench still computes `_rgb8` via `process()` each run as the 4ch-encode
fallback, which is the right robustness trade-off for DNGs where 4ch encode fails.

### d. Closing
The headline value here is benchmark *trustworthiness*, not raw speed. A benchmark
that silently samples a different corpus across runs, or aborts on one malformed
file, produces numbers you cannot reason about — which defeats the purpose of the
native↔WASM parity harness. These edits make the instrument honest. The specimen
under it (`pipeline.rs`) was found already well-tuned on the measured path, and the
review correctly declined to churn it without evidence.

## Verification

- `pipeline.rs` (worktree, file 2): `cargo check --no-default-features --features
  parallel --lib` → **Finished, 0 errors**; the three targeted dead-binding
  warnings are gone (remaining `CONTRAST_BLEND` / `apply_tone_math4` warnings are
  pre-existing and `parallel`-cfg-gated).
- `raw_decode_bench.rs` (file 1): `.\build-msvc.ps1 check --bin raw_decode_bench
  --features "jxl-lowlevel,jxl-encode"` → **Finished, 0 errors**, no new warnings.
  (The default GNU toolchain fails earlier at `dlltool.exe not found` building the
  `cmake`/libjxl vendored dep — a pre-existing toolchain issue, unrelated to these
  edits; MSVC is the documented working path.)
- Regression: `node StandardMultifileTest.mjs` → **exit 0, ✅ pass**. Headline
  metrics in range (`AvgRawMs 1427`, `AvgRawTonemapMs 602`, `AvgScaleMs 105`); this
  is the JS/worker path against shipped `web/pkg`, which these native edits do not
  touch, so no regression was possible or observed. TOON:
  `docs/outputs/timing tests/2026-06-15T07-01-51-428Z-StandardMultifileTest-general.toon`.
