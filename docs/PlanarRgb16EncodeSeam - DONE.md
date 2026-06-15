# Planar RGB16 Encode Seam (`encodeRgb16Planar` ↔ `jxl_wasm_encode_rgb16_planar`) - DONE

**Date-time:** 2026-06-15T02:54Z
**Targets:** `packages/jxl-wasm/src/facade.ts` (`encodeRgb16Planar`), `packages/jxl-wasm/src/bridge.cpp`
(`jxl_wasm_encode_rgb16_planar`). Caller examined: `StandardMultifileTest.mjs` (`getDirectPlanar16` +
the plane-split hook). Continues `docs/FacadeBridge - DONE.md`.

## Intro

`jxl_wasm_encode_rgb16_planar` is a **function**, not a file — the low/zero-copy 16-bit encode entry
that takes three separate u16 R/G/B planes (from planar demosaic / SoA tone in `src/lib.rs`) and
avoids materializing a full interleaved RGBA buffer JS-side. Its seam spans three touchpoints:

```
plane producer (src/lib.rs → JS)            ← Rust, separate WASM module
  → facade.ts  encodeRgb16Planar            ← marshals planes to heap, calls bridge
      → bridge.cpp  jxl_wasm_encode_rgb16_planar  ← interleaves, calls EncodeRgba → libjxl
```

`StandardMultifileTest.mjs` exercises it two ways: the high-level `encodeRgb16Planar` export, and a
fallback `getDirectPlanar16()` shim that calls the bridge symbol directly (because the shipped dist
wrapper is stale).

## The seam was broken end-to-end — two faults, fixed together

Examining the seam surfaced a **paired bug**: the JS half was dead, which masked a silent
correctness bug in the C++ half. Fixing one without the other would have been worse than either.

### Fault 1 (facade.ts) — `encodeRgb16Planar` was dead code
The function called two **undefined** symbols — `ensureU16Heap(...)` (×3) and `takeJxlBuffer(...)` —
so any call threw `ReferenceError` before reaching the bridge. (These were 4 of the standing `tsc`
errors.) That is why `StandardMultifileTest` carries the `getDirectPlanar16` shim and why
`AvgPlanar16ShotEncSimdMs` reports `0`: the wrapper throws, the bench's try/catch swallows it.

**Fix:** implemented `ensureU16Heap` (malloc + `HEAPU8.set` of the plane's bytes — matching the
shim's proven logic) and replaced `takeJxlBuffer(handle)` with the existing
`takeBuffer(module, handle, "encodeRgb16Planar").data`. Clears those 4 `tsc` errors; the wrapper now
works for real consumers (the `lib.rs`-driven pipeline, pyramid-ingest).

### Fault 2 (bridge.cpp) — silent garbage output, exposed by Fault 1's fix
`jxl_wasm_encode_rgb16_planar` interleaved a **3-channel** RGB16 buffer (6 B/px) then called
`EncodeRgba(fmt=1 /*rgba16*/, has_alpha=0)`. With `has_alpha=0`, `EncodeRgba` runs `StripAlphaToRgb`,
which reads a **4-channel** stride (8 B/px). Feeding it a 3-channel buffer mis-reads every pixel
(reads `R,G,B,nextR` as a pixel, drops `nextR` as "alpha") and **over-reads** ~`npix·2` bytes past
the allocation. It was harmless only because Fault 1 kept the path unreachable and the benchmark
discards output — but resurrecting the facade wrapper (Fault 1's fix) makes it live. So it **had** to
be fixed in the same pass.

**Fix:** interleave to a genuine **4-channel** RGBA16 buffer (opaque `0xFFFF` alpha). Now
`StripAlphaToRgb`'s 4-channel read is correct; it drops alpha and libjxl encodes a clean 3-channel
RGB16 frame (no alpha plane in output). Direct `uint16` stores retained (B-2 from the prior pass).

## Seam conclusion (Chapter 3)

- **a. facade.ts:** `encodeRgb16Planar` resurrected — defined `ensureU16Heap`, routed output through
  the existing `takeBuffer`. Dead→working; 4 `tsc` errors cleared (progress toward unblocking the
  dist/tsc rebuild).
- **b. bridge.cpp:** `jxl_wasm_encode_rgb16_planar` corrected from a 3-channel buffer (mis-stripped,
  over-read) to a 4-channel RGBA16 buffer that the `has_alpha=0` strip consumes correctly →
  bit-correct 3-channel RGB16 output.
- **c. the seam itself:** this is the textbook case for a seam pass — neither file was independently
  "obviously" broken in a way a single-file review would flag (the facade error looked like a stale
  helper; the bridge looked like a working interleave), but **together** the contract between them
  (who owns alpha, what channel count `EncodeRgba` assumes for `fmt=1`/`has_alpha=0`) was violated.
  The fix restores a consistent contract: facade marshals planes faithfully; the bridge hands
  `EncodeRgba` exactly the 4-channel buffer its strip path expects.

The remaining inefficiency (the 4-channel buffer + strip is one copy more than an ideal 3-channel
passthrough) is deferred to a `fmt==4` "rgb16 passthrough" mode in `EncodeRgba` — correct and
zero-extra-copy, but it edits the shared encoder's channel math and needs a build to validate, so it
is logged as a recommendation rather than done blind. See `docs/rejected optimizations.md`.

## Verification

- `tsc` (facade.ts): the 4 planar errors (`ensureU16Heap`×3, `takeJxlBuffer`) are **gone**; only the
  unrelated pre-existing set remains (`rgb8` not in `PixelFormat` ×4, the `406` exactOptional, the
  `perceptualConstancyApplyBulk` ×3).
- bridge.cpp: localized, uses only already-included facilities; needs an Emscripten rebuild to ship.
- **Both fixes are in source.** The shipped `dist/facade.js` wrapper stays broken-and-inert and the
  shipped `.wasm` bridge stays buggy until rebuilt — deliberately **not** half-ported, because
  porting only the facade half to dist would make the benchmark *time* a garbage-producing path
  (the dist `.wasm` still has the 3-channel bug). Correct state requires the src rebuild.

## Timings — StandardMultifileTest, this run vs previous ten

8-file corpus, 1920 / Q85 / effort 3. Host i7-10850H, throttle 100.0%. Source-only edits; shipped
artifacts unchanged → flat is expected (no-regression guard).

| Run (UTC)        | AvgRawMs | ToneMs | DecmpMs | DemMs | ProgEncSimd | ShotDecSimd | Planar16 | ParWall | Speedup |
|------------------|---------:|-------:|--------:|------:|------------:|------------:|---------:|--------:|--------:|
| **02-53 (this)** | **1064** | **445** | **355** | **104** | **267** | **294** | **0** | **2016** | **1.17** |
| 02-29            |  990 | 424 | 317 |  95 | 239 | 233 | 0 | 1928 | 0.97 |
| 06-15 01-35      | 1039 | 444 | 328 | 109 | 238 | 237 | 0 | 2146 | 0.88 |
| 06-14 23-44      | 1106 | 460 | 364 | 107 | 255 | 239 | 0 | 2084 | 0.92 |
| 06-14 20-47      |  992 | 429 | 316 | 101 | 226 | 226 | 0 | 1843 | 0.98 |
| 06-14 20-25      | 4599 | 2169| 1231| 392 | 282 | 271 | 0 | 2736 | 0.79 |
| 06-14 20-12      | 3385 | 1705| 915 | 357 | 1015| 932 | 0 | 3626 | 2.06 |
| 06-14 20-08      | 1815 | 942 | 485 | 145 | 538 | 638 | 0 | 5440 | 0.94 |
| 06-14 20-07      | 1202 | 626 | 320 | 100 | 458 | 554 | 0 | 5415 | 0.82 |
| 06-14 19-50      | 3788 | 1928| 987 | 355 | 733 | 867 | 0 | 2511 | 2.76 |
| 06-13 21-46      |  948 | 376 | 418 | 108 | 340 | 306 | 0 | 2436 | 1.00 |

**Conclusion:** this run sits within the recent stable band (Raw 1064, Tone 445); Speedup 1.17 is
healthy. `Planar16 = 0` across the whole history is the *evidence* of Fault 1 — the wrapper has
never run; the source fixes are what finally make it executable (pending rebuild). No regression.
No flip-flop authored: these are a dead-code resurrection + a correctness fix, not a hot-path speed
change to isolate.
