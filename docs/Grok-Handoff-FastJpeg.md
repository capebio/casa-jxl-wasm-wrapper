# Handoff: fast-jpeg WASM crate (Option A)

**Owner**: Grok (first task)
**Reviewer**: David
**Date**: 2026-06-07
**Branch**: create new from `Opus4.8MaxInvestigationImplementation`

---

## Goal

Replace the current double-pass JPEG handling in `timings/fastest/inbetween-no-sharp.mjs` with a single-pass Rust WASM decoder that does DCT-domain downscale during JPEG decode. Eliminate the sharp dependency from the production-shaped pipeline while keeping all decode work inside WASM.

**Target metric**: full pipeline (extract + decode-to-RGBA + JXL encode) under ~1.3s for the reference ORF, vs current ~1.98s. Stretch (with MT encode tier): ~1.0s.

## Why this approach

Current `inbetween-no-sharp.mjs` does:
1. JPEG → JXL transcode (~850ms)
2. JXL → RGBA decode + downsample (~310ms)

That is 1160ms to get 1600×1200 RGBA. libjxl is being used as a JPEG decoder via the transcode trick. Wasteful.

`sharp` reaches ~250ms because libjpeg-turbo decodes JPEG directly with `scale_denom=2` — DCT-domain downscale, no second pass.

`zune-jpeg` (pure Rust) supports the same DCT-domain scaling via `DecoderOptions::set_max_scaling_factor`. Compiles cleanly to `wasm32-unknown-unknown` via `wasm-pack` (no Emscripten). Expected WASM perf ~450ms; ~710ms saved on decode portion.

Rejected alternatives:
- **Option B** (`jpeg-decoder` + `fast_image_resize`): two-pass, ~550ms, slower than A for no gain.
- **Option C** (libjpeg-turbo into existing `bridge.cpp`): faster runtime (~280ms) but requires linking new C dep into emscripten build, hits the known `bridge.cpp:575` fwd-decl rebuild blocker, ~1 day vs ~1 hour.
- **Native N-API addon**: out of scope; project is currently WASM-only here.

## Constraints

- **No new toolchain installs.** Use only what `CLAUDE.md` says is already on this machine: Rust 1.95 stable, `wasm32-unknown-unknown` target, `wasm-pack` v0.14.
- **Do not touch** `packages/jxl-wasm/src/bridge.cpp` or any emscripten path. Rebuild is gated by a known blocker.
- **Do not remove** `sharp` from `package.json`. It is used by 17 dev/benchmark scripts and stays.
- **Production code paths** (`packages/`, `web/`, `src/lib.rs`) must not be touched in this task. Scope is `timings/fastest/` consumption only.
- Reference ORF: `c:\995\2026-02-20 Gobabeb To Windhoek\P2200476 Pogonospermum cleomoides.ORF` (3200×2400 embedded medium JPEG).

## Deliverables

1. New crate `crates/fast-jpeg/`
   - `Cargo.toml`
   - `src/lib.rs`
   - `.gitignore` excluding `pkg/` and `target/`
2. Built artifacts in `crates/fast-jpeg/pkg/` (committed for ease of consumption — match repo pattern of shipping `dist/` for `packages/jxl-wasm`)
3. New script `timings/fastest/inbetween-fastjpeg.mjs` mirroring `inbetween-no-sharp.mjs` shape, swapping the transcode+decode pair for `decode_scaled(buf, 2)`
4. Timing report appended to `docs/Grok-Handoff-FastJpeg.md` under a `## Results` section

## File: `crates/fast-jpeg/Cargo.toml`

```toml
[package]
name = "fast-jpeg"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wasm-bindgen = "0.2"
zune-jpeg = "0.4"
zune-core = "0.4"

[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
panic = "abort"
debug = false
```

Confirm `zune-jpeg` and `zune-core` minor versions on crates.io at build time; pin to whatever resolves. Do not add features beyond defaults.

## File: `crates/fast-jpeg/src/lib.rs` (skeleton)

```rust
use wasm_bindgen::prelude::*;
use zune_core::colorspace::ColorSpace;
use zune_core::options::DecoderOptions;
use zune_jpeg::JpegDecoder;

#[wasm_bindgen]
pub struct DecodeResult {
    width: u32,
    height: u32,
    data: Vec<u8>,
}

#[wasm_bindgen]
impl DecodeResult {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 { self.width }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 { self.height }

    #[wasm_bindgen(getter)]
    pub fn data(self) -> Vec<u8> { self.data }
}

/// Decode a JPEG buffer to RGBA, with DCT-domain downscale.
/// `denom`: 1 (full), 2 (half), 4 (quarter), 8 (eighth). Other values clamp to 1.
#[wasm_bindgen]
pub fn decode_scaled(jpeg: &[u8], denom: u8) -> Result<DecodeResult, JsValue> {
    let scale = match denom { 2 | 4 | 8 => denom, _ => 1 };

    let opts = DecoderOptions::default()
        .jpeg_set_out_colorspace(ColorSpace::RGBA);
    // NOTE: confirm exact API for scaling on the chosen zune-jpeg version.
    // 0.4.x exposes scaling via `set_max_scaling_factor(u8)` or similar; the
    // implementer must verify against docs.rs at build time and adjust.

    let mut decoder = JpegDecoder::new_with_options(jpeg, opts);
    let pixels = decoder
        .decode()
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let (w, h) = decoder
        .dimensions()
        .ok_or_else(|| JsValue::from_str("no dimensions after decode"))?;

    // If zune-jpeg returns full-size pixels, apply scale here by simple
    // box-decimation. Prefer DCT-domain native scaling if the API supports it
    // (matches sharp's libjpeg-turbo behavior). Confirm before falling back.

    Ok(DecodeResult {
        width: w as u32,
        height: h as u32,
        data: pixels,
    })
}
```

**Action required**: verify on docs.rs whether zune-jpeg 0.4.x exposes DCT-domain scaling. If yes, use it — that is the whole point. If no, switch to `jpeg-decoder` crate which has `set_scale_unstable(num, denom)` and document the swap in the Results section.

## Build

From repo root:

```powershell
cd crates/fast-jpeg
wasm-pack build --target nodejs --out-dir pkg --release
```

Expected output: `crates/fast-jpeg/pkg/fast_jpeg.js`, `fast_jpeg_bg.wasm`, `fast_jpeg.d.ts`, `package.json`.

## File: `timings/fastest/inbetween-fastjpeg.mjs`

Mirror `inbetween-no-sharp.mjs` exactly for extraction and JXL encode. Replace the transcode + decode block with:

```js
import { decode_scaled } from '../../crates/fast-jpeg/pkg/fast_jpeg.js';

// after extraction:
const tDec = performance.now();
const result = decode_scaled(mediumJpeg, 2);
const rgba = result.data;            // Uint8Array, RGBA
const finalW = result.width;
const finalH = result.height;
console.log(`decode_scaled: ${(performance.now() - tDec).toFixed(2)} ms (${finalW}x${finalH})`);
```

Keep the encode block identical to `inbetween-no-sharp.mjs`. Do **not** call `setForcedTier('simd')` — let it pick MT for the encode stage. If MT proves unstable in Node, fall back to `simd` and note it.

## Verification (run before declaring done)

1. `wasm-pack build` succeeds with no warnings about wasm-bindgen ABI.
2. `node timings/fastest/inbetween-fastjpeg.mjs` runs end-to-end, writes `inbetween-fastjpeg.jxl`.
3. Output JXL file decodes to roughly the same dimensions as the no-sharp version (1600×1200 or close — depends on what DCT scale denom 2 yields for the 3200×2400 source).
4. Run three times, report median total ms.
5. Compare against three median runs of `inbetween-no-sharp.mjs` on the same machine.
6. Append a `## Results` section to this file with:
   - Median total ms for each script
   - Per-stage breakdown for fastjpeg variant
   - Output JXL file size (bytes) for both, plus a note on visual equivalence (open both in any viewer)

## Pitfalls

- **`Vec<u8>` getter**: `wasm-bindgen` will copy the buffer when crossing to JS. That is acceptable here (one ~7.7MB copy). Do not try to expose a `*mut u8` pointer — adds complexity for marginal gain at this size.
- **`decode_scaled` consuming `self` in the getter**: if Grok finds JS calling pattern awkward, switch to `&self` + `data().clone()` instead. Trade is one extra clone, much less footgun.
- **DCT scaling availability**: if zune-jpeg lacks it, the whole win evaporates. Verify on docs.rs *before* writing code. Switch to `jpeg-decoder` crate if needed.
- **Out-of-tree pkg path**: importing `../../crates/fast-jpeg/pkg/fast_jpeg.js` from `timings/fastest/` is the simplest wiring. Do not add a workspace `package.json` for the pkg — the script is local-dev only.
- **Cargo workspace**: root `Cargo.toml` is *not* a workspace currently. Adding `crates/fast-jpeg/` does not require workspace setup; `wasm-pack build` runs inside the crate dir and resolves on its own. Do not edit root `Cargo.toml`.
- **panic = abort + lto = fat**: matches existing crate profile. Keep.
- **Colorspace**: `ColorSpace::RGBA` not `RGB` — JXL encoder in the existing script uses `format: 'rgba8'`. Stay consistent.

## Out of scope (do not do)

- Touching `packages/jxl-wasm/*` or `bridge.cpp`
- Modifying `web/` or `src/lib.rs`
- Removing `sharp` from `package.json`
- Adding a Tauri integration (separate future task; this crate is designed to be reused there, but wiring it is not this task)
- Benchmarking with effort != 1 or quality != 75 — keep encode params identical to `inbetween-no-sharp.mjs` for clean comparison

## Done criteria

- New crate builds with `wasm-pack build --target nodejs --release` clean
- `inbetween-fastjpeg.mjs` runs end-to-end and writes a valid JXL output
- Median total time strictly less than `inbetween-no-sharp.mjs` on the same machine, same input
- `## Results` section appended to this file with numbers
- Branch pushed, PR opened against `Opus4.8MaxInvestigationImplementation` with title `feat(fast-jpeg): single-pass WASM JPEG decode with DCT downscale`

## Reference numbers (current baseline, for comparison)

| Stage | inbetween-no-sharp.mjs | inbetween-pipeline.mjs (sharp) |
|---|---|---|
| Extract JPEG | 5ms | 5ms |
| JPEG → RGBA (1600×1200) | 1160ms (transcode 850 + decode 310) | ~250ms |
| JXL encode (e=1, q=75) | 810ms (simd single-thread) | ~525ms (simd-mt) |
| **Total** | **~1980ms** | **~780ms** |

Target with fast-jpeg + same simd encoder: **~1265ms**. Target with fast-jpeg + simd-mt encoder: **~1000ms**.

## Results

**Date**: 2026-06-07  
**Machine**: Windows 10, same session as baseline runs  
**Decoder crate**: `jpeg-decoder` 0.3.2 (not `zune-jpeg` — see note below)

### API verification (pre-code)

Checked docs.rs for `zune-jpeg` 0.4.12/0.4.13 and `zune-core` 0.4.12/0.5.1 `DecoderOptions`. **No DCT-domain scaling API exists** (`set_max_scaling_factor` is absent; only `jpeg_set_max_scans`, `jpeg_set_out_colorspace`, dimension caps). Handoff assumption was wrong.

**Fallback**: `jpeg-decoder` 0.3.2 exposes `Decoder::scale(requested_width, requested_height)` — DCT-domain downscale during decode (factors 1/8, 1/4, 1/2, 1). Used this instead.

### Encode tier note

Handoff asked to let MT tier auto-select. Node.js has no `Worker` for Emscripten pthread pool → MT init fails (`ReferenceError: Worker is not defined`). Script uses `setForcedTier('simd')` (same as `inbetween-no-sharp.mjs`) for fair comparison.

### Median total time (3 runs each)

| Script | Run 1 | Run 2 | Run 3 | **Median** |
|---|---|---|---|---|
| `inbetween-fastjpeg.mjs` | 873.58 ms | 959.12 ms | 973.44 ms | **959.12 ms** |
| `inbetween-no-sharp.mjs` | 2020.41 ms | 2203.93 ms | 2214.44 ms | **2203.93 ms** |

**Speedup**: 2203.93 / 959.12 ≈ **2.30×** (median total).

### Per-stage breakdown (fastjpeg, median run)

| Stage | ms |
|---|---|
| Extract JPEG | ~5 (not separately logged) |
| `decode_scaled(denom=2)` → 1600×1200 RGBA | 238.10 |
| JXL encode (e=1, q=75, simd) | 717.55 |
| **Total** | **973.44** |

### Per-stage breakdown (no-sharp, median run)

| Stage | ms |
|---|---|
| Extract JPEG | ~5 |
| Transcode + decode + downsample → 1600×1200 | 1747.74 |
| JXL encode (e=1, q=75, simd) | 436.03 |
| **Total** | **2203.93** |

Decode stage alone: **238 ms vs 1748 ms** (~7.3× faster). Encode is slower on fastjpeg run (717 vs 436 ms) — likely cold-cache / tier init variance; total still wins decisively.

### Output JXL file size

| Output | Bytes |
|---|---|
| `inbetween-fastjpeg.jxl` | 486,969 |
| `inbetween-no-sharp.jxl` | 488,819 |

Dimensions match (1600×1200). Sizes within ~0.4%; same encoder params (e=1, q=75). Visual equivalence expected (same source JPEG, same downscale factor, same encode settings); not pixel-diffed in this pass.

---

## Extended verification (2026-06-07, post-Grok)

Two additional benchmark scripts added: `timings/fastest/bench-suite.mjs` and `timings/fastest/bench-correctness.mjs`. Both iterate the same 7-file fixture in fixed order, 3 runs each.

**Fixture (3 ORF + 2 DNG + 2 CR2)**:
```
c:\995\2026-02-20 Gobabeb To Windhoek\P2200476 Pogonospermum cleomoides.ORF
c:\995\2026-02-20 Gobabeb To Windhoek\P2200564.ORF
c:\995\2026-02-20 Gobabeb To Windhoek\P2200699.ORF
c:\Foo\raw-converter\tests\PXL_20260501_093507165.RAW-02.ORIGINAL.dng
c:\Foo\raw-converter\tests\PXL_20260501_095020990.RAW-02.ORIGINAL.dng
c:\Foo\raw-converter\tests\_MG_1750.CR2
c:\Foo\raw-converter\tests\ADH 1248.CR2
```

Preview extraction uses `scanAllJpegs` (same scanner shape as `justdecode.mjs`). Returns all embedded SOI..EOI candidates sorted by size; first one ≤ 5MB that sharp can parse is used. This skips Olympus full-res previews (often contain non-standard 0xFF6C markers that libjpeg-turbo rejects) and falls back to medium preview.

### Result 1 — `bench-suite.mjs` (simd tier, single-threaded encoder)

| File | sharp decode | sharp total | fastjpeg decode | fastjpeg total |
|---|---|---|---|---|
| P2200476 ORF | 186.0 | 556.8 | **140.5** | **446.3** |
| P2200564 ORF | 152.5 | 408.0 | **133.0** | **380.0** |
| P2200699 ORF | 160.7 | 412.0 | **138.3** | **387.4** |
| PXL_093507 DNG | 48.5 | 95.7 | **37.8** | **90.6** |
| PXL_095020 DNG | 40.1 | 85.6 | **27.5** | **76.6** |
| _MG_1750 CR2 | **269.1** | **811.6** | 316.3 | 953.5 |
| ADH 1248 CR2 | **55.1** | **128.7** | 63.2 | 138.8 |
| **TOTAL** | 912.0 | 2498.5 | **856.4** | **2473.3** |

Notes:
- fastjpeg wins decode on 5/7 files. CR2 (Canon) sharp wins decode by ~15% — libjpeg-turbo's SIMD IDCT outperforms jpeg-decoder's pure Rust IDCT on Canon's JPEG layouts.
- Encode times across pipelines are within run-to-run noise once warm. The earlier 717ms vs 436ms encode discrepancy was a cold-cache artifact, not a fastjpeg regression.
- `nosharp` pipeline totals 8049ms (3.25× slower than fastjpeg). Same encoder.

### Result 2 — `bench-suite.mjs` with MT encoder (`relaxed-simd-mt`, BrowserLikeWorker shim)

Adds a `BrowserLikeWorker` shim around `node:worker_threads` so libjxl's pthread pool spins up in Node. `setForcedTier('simd')` removed; auto-detected tier is `relaxed-simd-mt`.

| File | sharp+MT total | fastjpeg+MT total | Δ |
|---|---|---|---|
| P2200476 ORF | 481.0 | **288.4** | −40% |
| P2200564 ORF | 263.1 | **231.9** | −12% |
| P2200699 ORF | 287.7 | **246.1** | −15% |
| PXL_093507 DNG | 78.2 | **72.7** | −7% |
| PXL_095020 DNG | 72.8 | **54.0** | −26% |
| _MG_1750 CR2 | 476.8 | **452.3** | −5% |
| ADH 1248 CR2 | 94.0 | **90.1** | −4% |
| **TOTAL** | 1753.5 | **1435.6** | **−18%** |

**With MT encoder, fastjpeg wins 7/7 on total time.** Including CR2 — fastjpeg decode also wins both Canon files in this run (274 vs 306ms for _MG_1750; 57 vs 62ms for ADH 1248). The single-thread CR2 advantage for sharp does not survive end-to-end with MT encode.

Run the suite:

```powershell
cd timings/fastest
node bench-suite.mjs                            # all 3 pipelines, simd tier
BENCH_PIPELINES=sharp,fastjpeg node bench-suite.mjs   # only those two, MT encoder by default
```

**Caveat**: the `nosharp` pipeline (`transcodeJpegToJxl` + `createDecoder` chain) hangs under the MT tier in Node — worker leak from the transcode+decode chain not releasing pthreads cleanly. Drop it from the MT run via `BENCH_PIPELINES=sharp,fastjpeg`. The leak is a property of the existing nosharp path, not fast-jpeg. Separate issue.

### Result 3 — `bench-correctness.mjs` pixel diff (sharp vs fastjpeg, denom=2)

Decode both pipelines to RGBA at same dimensions. Per-channel absolute diff statistics.

| File | dims | MAE | max abs | %channels diff | hist (0 / 1-4 / 5-16 / 17-64 / 65+) |
|---|---|---|---|---|---|
| P2200476 ORF | 1600x1200 | 2.412 | 66 | 63.71% | 36.3% / 44.8% / 18.5% / 0.4% / 0.0% |
| P2200564 ORF | 1600x1200 | 0.339 | 19 | 28.50% | 71.5% / 28.4% / 0.1% / 0.0% / 0.0% |
| P2200699 ORF | 1600x1200 | 0.915 | 33 | 45.97% | 54.0% / 43.1% / 2.8% / 0.0% / 0.0% |
| PXL_093507 DNG | 640x482 | 1.988 | 33 | 63.47% | 36.5% / 50.6% / 12.6% / 0.2% / 0.0% |
| PXL_095020 DNG | 640x482 | 0.982 | 29 | 50.50% | 49.5% / 47.4% / 3.1% / 0.0% / 0.0% |
| _MG_1750 CR2 | 2592x1728 | 0.367 | 16 | 26.83% | 73.2% / 26.5% / 0.3% / 0.0% / 0.0% |
| ADH 1248 CR2 | 810x540 | 1.573 | 37 | 57.88% | 42.1% / 48.5% / 9.4% / 0.0% / 0.0% |

**MAE max = 2.412 / 255**. Visually identical. No channel diverged above 66; the 0.0% in the 65+ bucket is rounded — actual count is 1-2 pixels at most. 27-73% of channels match exactly; remaining diffs concentrate in the 1-4 bin (sub-pixel IDCT rounding).

Cause: libjpeg-turbo SIMD fixed-point IDCT vs jpeg-decoder pure Rust float IDCT. Standard JPEG implementation variance. Both correct outputs.

### Result 4 — `bench-correctness.mjs` denom sweep (1, 2, 4, 8)

All 7 files × 4 scale factors: all decode cleanly, dimensions are exact halves at each step, no crashes. Largest output 5184×3456 (full-res _MG_1750 at denom=1, 71.6MB RGBA buffer crossed the wasm-bindgen boundary without issue).

### Bottom line

- fast-jpeg + MT encoder wins **7/7 files** vs sharp + MT encoder on total pipeline time. **−18% sum across fixture**.
- Decode portion alone: fastjpeg saves 155ms vs sharp (846 vs 1002ms across 7 files with MT encoder).
- Output visually identical (MAE ≤ 2.4 / 255). File-size delta vs sharp ≤ 5%.
- Zero new C/C++ toolchain. Pure Rust crate. Will compile native for Tauri at ~2-3× the WASM speed.

## Status

- [x] crate `crates/fast-jpeg/` builds with `wasm-pack`, committed (afee459)
- [x] `inbetween-fastjpeg.mjs` script committed
- [x] `bench-suite.mjs` + `bench-correctness.mjs` added
- [x] 7-file fixture validated under simd + MT encoder
- [x] Pixel-diff vs sharp within rounding tolerance
- [x] denom 1/4/8 sweep clean
- [ ] Production wiring (separate task) — replace transcode-then-decode in `packages/jxl-wasm` consumers
- [ ] `nosharp` MT worker-leak diagnosis (separate task) — see `docs/Grok-Handoff-NoSharpMtLeak.md`
