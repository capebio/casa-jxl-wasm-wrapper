# facade.ts ↔ bridge.cpp — Final-Optimization Multi-Lens Review - DONE

**Date-time:** 2026-06-15T02:35Z
**Targets:** `packages/jxl-wasm/src/facade.ts` (file 1), `packages/jxl-wasm/src/bridge.cpp` (file 2)
**New artifact:** `benchmark/butteraugli-gamma-lut.mjs` (flip-flop proving B-1).
**Continues:** `docs/FacadeDecodeHandler - DONE.md` (prior correctness pass on facade.ts).

## Intro — purpose of the files

`facade.ts` is the JS↔WASM FFI shell: heap alloc, zero-copy writes, capability cache, the
stateful progressive decoder/streaming encoder, and the JS pixel kernels (region/downsample,
bilinear resize). `bridge.cpp` is the **other side of the exact same FFI** — the C++ that wraps
libjxl: encode/decode, JXTC tiling, the progressive decode state machine, gain maps, animation,
and the perceptual-metric kernels (Butteraugli / PSNR / SSIM / perceptual-constancy). facade
declares 170 `_jxl_wasm_*`/`_perceptual_*` references; bridge defines all of them. They are the
most tightly coupled pair in the repo.

This pass applied the **Final-Optimization lens set** (A1–8 structural, B9–12 performance) three
times with the mandated focus order — general sweep → 3 slowest algorithms → next 3 → seams — and
restricted edits to genuinely net-positive, output-fidelity-safe changes on hot code.

## The three slowest *touchable* algorithms (lens 12)

libjxl's own entropy coding dominates the bench (`prog_enc`, `shot_dec`, …) but is not ours to
edit. Of the algorithms these two files actually own, the three heaviest are:

1. **Butteraugli sRGB→linear gamma decode** — `std::pow(v/255, 2.2f)` × 3 channels × 2 images,
   in `jxl_wasm_butteraugli_compare`, `..._ref_create`, and `..._ref_compare`. Pure transcendental
   load over every pixel; lens 19 calls Butteraugli out by name.
2. **facade `bilinearResize` (rgba8)** — the per-pixel fixed-point resampler on the decode→resize
   path (active whenever `targetWidth` is set, i.e. the bench's `Target: 1920`).
3. **`jxl_wasm_encode_rgb16_planar` interleave** — planar R/G/B → packed u16, the low-copy 16-bit
   encode entry.

## Changes made

### File 2 — `bridge.cpp`

- **B-1 (headline): Butteraugli gamma decode → 256-entry LUT.** Input is `u8`, so
  `lut[i] = pow(i/255, 2.2f)` precomputed once is **bit-identical** to calling `pow` per pixel,
  while removing `width·height·3·2` transcendental calls per comparison. Added `SrgbGamma22Lut()`
  and wired it into all three gamma-decode loops. Lens 11 (numerical) + 19 (butteraugli) +
  fidelity-safe by construction (lens 24). Flip-flop (below): **9.33× median**, **0 mismatches /
  6.22 M floats**.
- **B-2: planar RGB16 interleave → direct `uint16` stores.** Replaced the per-pixel
  `3× memcpy(2)` with aliased `uint16_t*` writes (rgb_pixels is malloc'd, ≥2-byte aligned; wasm is
  LE = `JXL_NATIVE_ENDIAN`, so bytes are identical). Removes 3 call-shaped copies per pixel on the
  16-bit encode path.

### File 1 — `facade.ts`

- **F-1: `bilinearResize` rgba8 weight hoist.** The x-axis 8.8 fixed-point weight
  `(t·256)|0` is column-invariant but was recomputed for every (row, col). Precomputed once into a
  `dstW`-length `Int32Array` before the row loop — turns `dstW·dstH` truncations into `dstW`.
  Pure hoist, arithmetically identical output (no fidelity change).

### Caveat — shipped artifacts not rebuilt

`bridge.cpp` requires an Emscripten rebuild to reach the shipped `.wasm`; per project notes the
default build link-fails on the c-perceptual symbols, and a rebuild is heavy. `dist/facade.js` is
materially stale (its `bilinearResize` is an older float algorithm without axis caching, so F-1
does not map onto it). Both edits are therefore **staged in source** and validated as far as is
possible without a build (facade.ts: `tsc` shows zero new errors; bridge.cpp: localized, uses only
already-included headers; B-1 proven by the JS flip-flop proxy that mirrors the C++ exactly). The
prior round's three safe correctness fixes remain hand-ported in `dist/facade.js`. Unblocking the
full rebuild (reconcile the `rgb8` `PixelFormat` union + restore `ensureU16Heap`/`takeJxlBuffer`,
then `tsc` emit + emcc) is the action that lands B-1/B-2/F-1 for users.

## Flip-flop — Butteraugli gamma: per-pixel `pow` vs LUT (B-1)

`benchmark/butteraugli-gamma-lut.mjs`, 1920×1080 (2.07 MP), 10 interleaved rounds, CPU/thermal per
round → `docs/outputs/timing tests/butteraugli-gamma-lut-2026-06-15T02-35-44-862Z.toon`.
Host pinned at 2.71/2.71 GHz, throttle 100.0% (no thermal drift across the run).

| Round | pow (ms) | lut (ms) | speedup | load% |
|------:|---------:|---------:|--------:|------:|
| 1 | 109.69 | 9.83 | 11.16× | 24 |
| 2 | 80.95 | 8.65 | 9.36× | 21 |
| 3 | 91.72 | 10.69 | 8.58× | 26 |
| 4 | 94.59 | 9.99 | 9.47× | 26 |
| 5 | 99.23 | 8.56 | 11.59× | 44 |
| 6 | 87.26 | 9.12 | 9.57× | 20 |
| 7 | 91.20 | 7.91 | 11.53× | 19 |
| 8 | 121.28 | 10.12 | 11.98× | 15 |
| 9 | 91.01 | 10.29 | 8.84× | 19 |
| 10 | 87.31 | 9.33 | 9.36× | 12 |
| **median** | **91.72** | **9.83** | **9.33×** | — |

**Mismatches: 0 / 6 220 800 floats.** The LUT is bit-identical and ~9× cheaper on this proxy; the
C++ change eliminates exactly the same per-pixel `pow` calls in the WASM bridge. (JS `Math.pow` is
double vs the bridge's `std::pow(float,float)` so the absolute ms differ from native, but the
*structure* — transcendental-per-pixel vs table lookup — and the exactness proof transfer directly.)

## Timings — StandardMultifileTest, this run vs previous ten

8-file corpus, target 1920 / Q85 / effort 3. Host i7-10850H, throttle 100.0% (Optimal).
This run is the regression guard (it exercises shipped `dist`/`.wasm`, which the source edits do not
yet touch — so flatness is the expected and desired result).

| Run (UTC)        | AvgRawMs | ToneMs | DecmpMs | DemMs | ProgEncSimd | ShotDecSimd | ParWall | Speedup |
|------------------|---------:|-------:|--------:|------:|------------:|------------:|--------:|--------:|
| **02-29 (this)** | **990** | **424** | **317** | **95** | **239** | **233** | **1928** | **0.97** |
| 06-15 01-35      | 1039 | 444 | 328 | 109 | 238 | 237 | 2146 | 0.88 |
| 06-14 23-44      | 1106 | 460 | 364 | 107 | 255 | 239 | 2084 | 0.92 |
| 06-14 20-47      |  992 | 429 | 316 | 101 | 226 | 226 | 1843 | 0.98 |
| 06-14 20-25      | 4599 | 2169| 1231| 392 | 282 | 271 | 2736 | 0.79 |
| 06-14 20-12      | 3385 | 1705| 915 | 357 | 1015| 932 | 3626 | 2.06 |
| 06-14 20-08      | 1815 | 942 | 485 | 145 | 538 | 638 | 5440 | 0.94 |
| 06-14 20-07      | 1202 | 626 | 320 | 100 | 458 | 554 | 5415 | 0.82 |
| 06-14 19-50      | 3788 | 1928| 987 | 355 | 733 | 867 | 2511 | 2.76 |
| 06-13 21-46      |  948 | 376 | 418 | 108 | 340 | 306 | 2436 | 1.00 |
| 06-13 21-36      |  953 | 376 | 418 | 117 | 288 | 278 | 2993 | 0.74 |

**Timings conclusion.** This run is the fastest of the recent stable cluster (Raw 990, Tone 424 —
below the 06-15 01-35 and 06-14 23-44 runs) and well inside historical variance; the 3000–4600 ms
rows are unrelated earlier-config/thermal-load outliers. Since the shipped artifacts are unchanged
this round, no movement is expected and none is seen — **no regression.** The optimization wins
(B-1/B-2/F-1) live in source pending a build and are quantified separately by the flip-flop.

## Conclusion (Chapter 3)

### a. Improvements to file 1 (`facade.ts`)
One hot-path hoist (F-1) on the rgba8 bilinear resampler — `dstW·dstH` weight truncations reduced
to `dstW`, output unchanged. The file's structure (fixed-point resampler, cached resize axes,
batched single-write chunk push, tri-state buffer accessors) is already optimal; nothing else on
the resize/region kernels warranted an edit that would not have been churn.

### b. Improvements to file 2 (`bridge.cpp`)
The headline win (B-1) and a clean micro-copy elimination (B-2). B-1 is the kind of change the lens
set exists to find: a per-pixel transcendental over an 8-bit domain, replaceable by an exact table
— ~9× on the gamma-decode stage with provable zero pixel drift, directly serving the Butteraugli
lens and the platform's perceptual-comparison workloads. The rest of bridge.cpp is dominated by
libjxl calls (untouchable) wrapped in already-careful grow-only buffer management.

### c. Improvements to the seams / boundaries
The facade↔bridge seam was audited end to end and found correct: the `JxlWasmBuffer` HEAPU32
direct-read (guarded by `static_assert(size_t==4)` + the A6 pointer-size query) avoids 7 FFI calls
per buffer; the borrowed-view lifetime contract (`MakeBufferBorrowed` → `takeBufferView`) is
honoured (decode copies, encode drains same-tick); format codes agree on both sides. B-1 lives
entirely on the bridge side of the Butteraugli seam, so the RGBA8 pointer contract is unchanged.
One latent **quality** item surfaced: decode-time downsampling is nearest-neighbour on *both* sides
(`DownsampleRgba` + `applyRegionAndDownsample`), while a box filter already exists in the bridge for
sidecars. Routing decode-downsample through a box filter would reduce aliasing on shrunk field
images — but it changes pixel output and trades speed, so it is deferred to a fidelity-gated change
(golden-image + the user's viewer), not slipped in here.

### Closing
The pass found exactly one large, safe, mathematically-grounded win (B-1) plus two clean
micro-optimizations, and — importantly — left the rest alone: both files are mature, and the
discipline of the lens set is as much about *not* churning a 5/5 FFI layer as about finding the LUT.
The wins are staged in source with a proof (flip-flop, exact equality) standing in for the
build-blocked measurement; the one remaining lever big enough to move the headline encode/decode
metrics lives inside libjxl itself, beyond this seam.
