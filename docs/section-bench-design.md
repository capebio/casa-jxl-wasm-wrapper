# Pipeline Section Bench — design

Permanent harness to answer, for any change (raw-pipeline **or** libjxl): *where did
the impact land* — which pipeline **section**, encode vs decode, first-paint vs full,
and the whole **RAW→lightbox** wall.

## What it measures

Per file, native, single binary (`crates/raw-pipeline/examples/pipeline_section_bench.rs`):

| section | source | isolates |
|---|---|---|
| `raw_parse` | `cr2/dng::decode_bytes`, ORF `tiff`+`decompress` | demux + LJPEG/decompress |
| `demosaic` | `demosaic::*` | CFA → RGB16 |
| `tone` | `pipeline::process_into_auto` | develop → RGB8 |
| `encode` | libjxl (`jxl_casaencoder`) | JXL encode (separate measure) |
| `decode_full` | libjxl (`jxl_casadecoder`) | JXL full decode (separate measure) |
| `ttfp` | `decode_progressive_first_total` | time-to-first-paint (first progressive frame) |
| `load_e2e` | sum | **RAW bytes → full image ready in a lightbox** (no render, just the wall) |
| `ttfp_e2e` | sum | RAW → first paint |

Develop **colour** fidelity is irrelevant: we encode then decode the *same* RGB8, so
quality is a JXL roundtrip property regardless of develop. Develop only needs correct
dimensions — so the per-format glue can't silently corrupt the timing.

## Files (one per format)

`.dng` (PXL), `.cr2` (ADH), `.orf` (P1110226). No `.raw` in the corpus — add one and
extend `FILES` when available.

## Two modes (`benchmark/run-section-bench.mjs <mode> [reps] [effort]`)

- **`relative`** — current build vs the **last persisted run** (`section-history/section-bench-last.json`).
  The moving-forward regression detector: run it after each change; it prints per-section
  deltas vs last time and re-saves. (Cross-time, so not interleaved — repetition only.)
- **`absolute`** — current build vs the **libjxl 0.11.2 anchor**, **interleaved** A/B in one
  wall window (thermal-cancelled), 5-rep median. The stable reference comparison.

5-rep median both modes. Output: per-file console table + a self-contained inline-SVG
grouped-bar graph (`docs/outputs/timing tests/section-bench-*.html`) + JSON.

## Noise-floor control (built in)

`raw_parse`/`demosaic`/`tone` are the **same raw-pipeline code** in both builds, so in
absolute mode their A/B ratio is pure measurement noise. Their spread = the noise floor;
a real signal must beat it. (First real run: those sat at 0.89–1.29x while `ttfp` hit
2.0–2.5x → ttfp is genuine, encode/decode ~parity at e3.)

## Build recipe

```
# current (submodule main):
build-msvc.ps1 build --release -p raw-pipeline --example pipeline_section_bench
copy target\...\pipeline_section_bench.exe  C:\temp\psbench_main.exe

# 0.11.2 anchor (worktree at tag v0.11.2; needs third_party submodules):
git -C external/libjxl-012 worktree add --detach C:\Tmp\libjxl-0112 v0.11.2
cd C:\Tmp\libjxl-0112 && git submodule update --init third_party/{highway,brotli,skcms,libpng,zlib}
LIBJXL_SOURCE_DIR=C:\Tmp\libjxl-0112  build-msvc.ps1 build ... --example pipeline_section_bench
copy ... C:\temp\psbench_0112.exe
# (delete C:\Tmp\...\build\jxl-ffi-* to force a libjxl recompile when switching source)
```

## Borrows from

`jxl_encdec_ab.rs` (enc/dec/butter timing), `run-jxl-ab-flipflop.mjs` (interleave/median/
SVG graph), StandardMultifileTest (stage-timer idea, corpus), `decode_progressive_first_total`
(TTFP). First absolute run: ttfp **2.0–2.5x** faster on the fork — the e3 win is first-paint.
