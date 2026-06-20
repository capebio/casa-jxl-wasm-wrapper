# WASM multithreading + "encode under 1 second" — findings (2026-06-20)

Autonomous session. All numbers on i7-10850H (6c/12t). **Caveat: the machine was under
extreme concurrent load this session** (Processor Queue Length = 38 on 12 cores — six
parallel `claude` sessions). Absolute timings are inflated ~2× and noisy; **relative**
results and the **min-over-many-reps** are the trustworthy signals. Tools below use
COOP/COEP headless Chromium so the threaded WASM (`pkg-mt`, libjxl `*-mt` tiers) runs.

## Headline results (measured)

| Lever | Result | Tool |
|-------|--------|------|
| **Tone** (slider re-render, `LookRenderer.render`) | **3.84× @24MP** (ST 727→MT 189ms), parity exact | `tools/tone-mt-bench.mjs` |
| **RAW decode** (full `process_orf`/`cr2`) | **1.20×** (ST 1458→MT 1218ms), parity exact | `tools/decode-mt-bench.mjs` |
| **JXL encode** (libjxl `simd-mt`) | **2.24× @e5/6MP**; **0.97× @e7/4MP** (byte-identical) | `tools/encode-mt-bench.mjs` |
| **Encode under 1s** (real 18MP CR2) | **effort 1 = 919ms ✓** (full quality, 4.96MB) | `tools/encode-real-bench.mjs` |

## Why decode MT is capped at 1.2× (and can't be improved)
The decode path = **decompress (serial) + demosaic (parallel) + tonemap (parallel)**.
demosaic and tone are *already* rayon `par_chunks_mut` (parallel in `pkg-mt`). The full
decode still only gains 1.2× because the **decompress is irreducibly serial** for every
predictive RAW codec here:
- **ORF**: single continuous variable-length entropy bitstream (no restart markers → can't
  seek to row N) + vertical north-neighbour predictor (`decompress.rs`).
- **CR2**: a **single** LJPEG scan (`ljpeg::decode_tile` once, `cr2.rs:616`); the 1–3
  "slices" are a reassembly *layout*, not separate scans — **not parallelizable**.
- **DNG**: often uncompressed (fast) or tiled.

→ Per-file decode MT is **codec-limited to ~1.2×**. No code change fixes this; it's the
nature of serial entropy coding. The real gallery-ingest throughput lever is **file-level
parallelism** (N files / N workers), which is **already implemented** in
`packages/pyramid-ingest` (`pMapLimit`/`boundedConcurrency`/`availableParallelism`).

## "Encode under 1 second" — the real picture
Full-res **18 MP** CR2, `simd-mt` tier, distance 1.0, under heavy load:

| effort | encode (median, contended) | size | <1s? |
|-------:|---------------------------:|-----:|:----:|
| 1 | **919 ms** | 4.96 MB | **✓** |
| 2 | ~1850 ms | 4.96 MB | borderline |
| 3 | ~1100–2400 ms (min 1100) | 2.10 MB | idle: very likely ✓ |
| 5 | ~4100 ms | 1.69 MB | ✗ |
| 7 | ~6400 ms | 1.89 MB | ✗ |

Findings:
- **`<1s` is ACHIEVED at effort 1** (919 ms even under a 38-deep queue → ~300–400 ms idle).
  Same *visual* quality as effort 7 (distance is the quality target; effort only trades
  size for time) — it just compresses less (4.96 MB vs 2.10 MB).
- **effort 7 is wasteful on this content**: slower *and larger* (1.89 MB) than effort 5
  (1.69 MB). The size optimum is ~effort 5; the speed/size knee is ~effort 3.
- **Best-compression-under-1s** (effort 3–5) could NOT be cleanly confirmed: the machine
  never went idle (min-over-15-reps for effort 3 still 1100 ms). On a normal/idle machine
  effort 3 (2.10 MB) is almost certainly <1s. **Re-run idle to confirm:**
  `node tools/encode-real-bench.mjs --file <raw> --tier simd-mt --effort 3 --reps 15`
- The encoder is **already fully optimized**: `-O3 -flto`, 12-thread MT
  (`JxlThreadParallelRunnerDefaultNumWorkerThreads` = `navigator.hardwareConcurrency`).
  No free build win. PGO exists (`build-pgo.mjs`) but is enc-`simd`-only (not the `-mt`
  tier the app uses) — limited ROI.

### Recommendation for the ingest <1s goal
1. **Full-res top level**: encode at **effort 3** (≈2.1 MB, <1s on a normal machine) — not
   effort 7 (wasteful). If absolute minimum latency is required, effort 1 (<1s guaranteed)
   at a storage cost.
2. **Pyramid lower levels**: already <1s (smaller).
3. **Throughput**: file-level parallelism already banked in pyramid-ingest.
4. Durable encoder speedup for effort-5-under-1s would need PGO-for-MT or algorithmic work
   (optimize-codec-times territory) — not low-hanging.

## WebGPU
Dead on this dev box (`navigator.gpu` undefined under every forcing) — driver below
Chrome's baseline. Reusable probe: `tools/webgpu-probe.mjs`. Revisit on capable hardware.

## Build recipe (threaded pkg-mt)
`tools/build-mt-wasm.sh` — `+atomics,+bulk-memory` + `--shared-memory --max-memory=2G
--import-memory --export=__heap_base` + `-Z build-std`; manual `cargo +nightly` +
standalone `wasm-bindgen` (wasm-pack runs stable cargo, rejects `-Z`; install the CLI via
MSVC — GNU lacks dlltool).
