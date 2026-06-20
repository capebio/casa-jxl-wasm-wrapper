# DNG tile path — cps=2 truncation bugfix + band-parallel direct decode

**Date:** 2026-06-20 · **Branch:** `scannerbot/20-06-26-start-16.12` (off `perf/ljpeg-specialized-kernels`)
**File:** `crates/raw-pipeline/src/dng.rs` · **Harness:** `examples/dng_tiles_direct_flip.rs`
**Oracle:** rawpy (external ground truth) + the flip's bit-exact A/B.

Triggered by an architectural audit of `dng.rs` ("eliminate decoded-tile Vecs / stream tiles
into the output"). Measuring first (`examples/dng_decode_scaling`) showed **34% of
`decode_bytes` wall time was NOT decode** — 165 per-tile `Vec` allocs + a single-threaded
serial blit that ran after all parallel work. Implementing the fix surfaced a latent
correctness bug.

---

## 1. Correctness bug (the bigger find) — cps=2 tiles were half-truncated

`decode_tiles` decoded each LJPEG tile into a compact buffer sized **`info.width`** (the SOF
*sample* width) with the comment `// cps=1 for CFA raw`. CFA DNGs from Pixel phones encode
tiles with **cps=2** (two column-interleaved components; the kernel emits
`raw_col = col*cps + comp`), so the reconstructed tile is **`sof_w * cps`** pixels wide.

Concretely for the test asset (`PXL_20260527_180319603.RAW-02.ORIGINAL.dng`):
- tile SOF: `width=128 (samples), height=256, cps=2` → **pixel tile = 256×256**
- grid `TileWidth=256` (165 tiles = 15×11; the tile-count guard enforces this)
- old path decoded into a **128**-wide buffer with `out_pixel_cols=128` → emitted only
  `raw_col < 128` → **kept the left half of every tile; cols 128–255 stayed 0.**

**Ground truth (rawpy)** row 0, cols 124–135:
`[1649, 867, 1647, 859, 1677, 790, 1693, 865, 1658, 857, 1651, 887]`
- old `decode_bytes` (blit): `…, 1649, 867, 1647, 859, 0, 0, 0, 0, …` ❌ (right half zeroed)
- new `decode_bytes` (direct): matches rawpy **exactly** ✅

Why it was never caught: the kernel parity tests compare `decode_c2` against `decode_generic`
— **both** were driven through the same truncating caller, so they agreed (equally wrong).
Nothing compared the full-image output to an external reference. This is an **unreleased
regression on `perf/ljpeg-specialized-kernels`** (the kernel-refactor's `cps=1` assumption).

**Fix:** compute pixel width as `info.width * info.components`. Applied to both:
- the new `decode_tiles` (uses the grid pixel width `tw` directly), and
- the retained `decode_tiles_blit` baseline (`bw = info.width * info.components.max(1)`).

> ⚠️ **Colour-affecting.** Verified bit-exact vs rawpy (stronger than a mean-RGB check), but
> per repo policy a reviewer should eyeball a rendered Pixel DNG before merge.

---

## 2. Perf — band-parallel direct decode (eliminates the Vec + serial blit)

Replaced "decode each tile into a private `Vec` → collect → serial blit into `out`" with
**band-parallel direct decode**: `out.par_chunks_mut(tl*width)` splits the mosaic into
disjoint contiguous row-tile bands; tiles within a band decode serially via the strided
`ljpeg::decode_tile`, writing straight into their sub-rect. No per-tile `Vec`, no second
pass, no `unsafe`.

Why not per-tile parallel direct write? Column-adjacent tiles share rows in a strided
buffer → overlapping `&mut` = UB. That is exactly why the compact+blit existed. Band
granularity (`rowtiles` bands, here 11 ≥ core count) keeps writes disjoint and safe.

**Measured** (`examples/dng_tiles_direct_flip`, interleaved 13-round median, real DNG,
both arms now correct & bit-exact):

| build | A: compact+blit (fixed) | B: band-direct | delta |
|-------|------------------------:|---------------:|------:|
| native `--features parallel` | 65.32 ms | **44.62 ms** | **−31.7%** |
| wasm/serial (no parallel)    | 200.38 ms | **175.99 ms** | **−12.2%** |

Parity: `px_differ_count=0, max_abs_diff=0` on both builds; both match rawpy.

Amdahl note: `decode_bytes` is the RAW-decode cost centre feeding demosaic+tone; this is a
real pipeline stage, not a kernel micro-op. The −31.7%/−12.2% are full-`decode_bytes`
wall-time deltas (parse + entropy decode + placement), not kernel-only.

---

## Verification ladder
- **R0** prior-art: clear (new structural change; not in X1–X9 / rejected-optimizations).
- **R1** build: `cargo build` (default + `--features parallel`) ✔
- **R2** tests: `cargo test --no-default-features --lib` → 148 passed / 8 ignored (== baseline) ✔
- **R3** parity: bit-exact vs the corrected blit baseline **and** vs rawpy external ground truth ✔
- **R4** speed: native −31.7%, wasm −12.2%, interleaved median, ≥5% ✔

## Out of scope / not pursued (from the same audit — with reasons)
- **Active-area / masked-pixel skipping:** `ActiveArea`/`DefaultCrop` tags aren't parsed; it
  would be a new feature that changes output dimensions, not a safe perf edit.
- **Wire the fused `decode_bytes_demosaiced` (tile-native demosaic) into production:** it
  subtracts black *before* demosaic (production subtracts after) → not byte-equivalent;
  separate colour-gated change. Also currently test-only.
- **LJPEG inner-tile parallelism:** restart markers are unsupported/absent (`ljpeg.rs:470`) →
  no independent sub-tile regions. Dead end.
- **Precision churn (u16→f32→u16):** does not occur inside `dng.rs` (all u16; the f32
  conversion is downstream in pipeline/demosaic).
- **ParsedDng dedup / lazy metadata strings / CFA-as-data:** the duplication lives in the
  test-only fused path; metadata/CFA work is once-per-image (cold) → below the noise floor.
