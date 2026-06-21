# Multi-format image ingestion (bit-depth aware)

Date: 2026-06-21
Branch: `feat/multi-format-ingest`
Status: approved (brainstorm), pending implementation plan

## Goal

Let a user upload **PNG, JPEG, GIF, WebP, AVIF, TIFF, and EXR** (in addition to the
existing RAW + JXL) and have each decode cleanly into the existing convert/preview/
encode pipeline. Browser-only — no native binary, no server. EXR (and 16-bit TIFF)
must preserve high bit depth (float / 16-bit), not be flattened to 8-bit.

Out of scope: PNM/PPM/PGM/PFM, PGX (explicitly dropped). No libjxl-extras WASM build.

## Constraints

- **Browser-only.** Everything compiles to `wasm32-unknown-unknown` and runs client-side.
  The new Rust decoder crates must be wasm-safe (`exr` with `default-features = false`
  to drop its std-threads feature).
- **Reuse existing patterns.** SDR ingestion already exists in `web/jxl-benchmark.js`
  `processImageFile` (RAW → `process_orf`, else `createImageBitmap`). Extend, don't replace.
- **No heavy deps.** Two focused Rust crates (`exr`, `tiff`) over the existing
  `raw-pipeline` wasm build — not libjxl-extras + PNG/zlib/EXR C deps.
- **Surgical.** Touch the ingestion dispatcher, raw-pipeline decoders, the wasm
  exports, and tests. Do not refactor unrelated pipeline code.

## Approach (chosen)

Hybrid, **bit-depth aware**:

- **SDR-8bit path** — PNG, JPEG, GIF, WebP, AVIF → browser `createImageBitmap` →
  canvas → `rgba8`. Zero new deps. AVIF availability follows the user's browser.
- **High-bit path** — EXR (`f32` linear HDR), general RGB TIFF (`u8`/`u16`) → new
  Rust decoders in `raw-pipeline` → fed into the pipeline at native depth.

Rationale: the browser already decodes the common SDR formats (and your code does
exactly this today). libjxl-extras has **no TIFF at all** and dragging it into wasm
is far heavier than two pure-Rust crates. The pipeline already models `f32` (the
`Sample` trait + `process_16bit`), so a high-bit branch is a natural fit, not a rewrite.

## Architecture

```
upload (file/drop)
  └─ detectFormat(bytes, name)         magic-byte sniff + extension fallback
       ├─ raw  (orf/dng/cr2)  → process_orf/dng/cr2   (existing)        → rgb8/rgb16
       ├─ jxl                 → jsquash-jxl / bridge   (existing)        → rgba8
       ├─ sdr  (png/jpg/gif/webp/avif) → createImageBitmap → canvas      → rgba8
       └─ hdr  (exr/tiff)     → decode_exr / decode_tiff (NEW, wasm)     → f32 / u16
            └─ unified {pixels, format: 'rgba8'|'rgb16'|'f32', w, h}
                 └─ look / preview / casaencoder  (encode at native depth)
```

### Components

1. **`detectFormat(bytes, name)`** (JS, `web/`) — pure classifier. Input: header bytes
   + filename. Output: one of `raw | jxl | sdr | exr | tiff`. Magic bytes:
   EXR `76 2f 31 01`, TIFF `49 49 2a 00` / `4d 4d 00 2a`, PNG `89 50 4e 47`,
   GIF `47 49 46`, JPEG `ff d8 ff`, RIFF/WEBP, AVIF (`ftyp` brand `avif`/`avis`).
   Note: RAW formats are TIFF-containers — extension disambiguates orf/dng/cr2 from RGB tiff.

2. **`decode_exr(bytes) -> DecodedImage`** (Rust, `raw-pipeline`, wasm export) — `exr`
   crate, read RGBA (or RGB) float planes → interleaved `Vec<f32>`, dims, channel count.
   Linear scene-referred values preserved (may exceed 1.0).

3. **`decode_tiff(bytes) -> DecodedImage`** (Rust, `raw-pipeline`, wasm export) — `tiff`
   crate, decode general RGB(A) TIFF → `u8` or `u16` per the file's bit depth + dims.
   Distinct from the existing Bayer-oriented `tiff.rs`.

4. **f32 pipeline ingress** — audit: does a real `f32` entry exist end-to-end
   (look/tone + `casaencoder` `Frame<f32>`), or only `u8`/`u16`? Wire the gap. The
   `Sample` trait already implements `f32`; the encoder accepts `Frame::rgb/rgba` over
   `S: Sample`. The likely gap is the look/preview stage and a wasm `process_*_f32`
   entry. Add the minimal real path; do not fabricate.

5. **Ingestion dispatcher** (JS) — extend `processImageFile` (or a shared module) to
   call `detectFormat` and route to the right decoder, returning the unified shape.

### Decoder crate placement

`crates/raw-pipeline/Cargo.toml`, behind a feature (e.g. `image-formats`), wasm-enabled:
```toml
exr  = { version = "1", default-features = false }   # no std threads → wasm-safe
tiff = { version = "0.9" }
```
Exports added to the wasm surface alongside `process_orf` etc.

## Data flow / output contract

`DecodedImage { pixels, width, height, channels, format }` where `format ∈
{ rgba8, rgb16, f32 }`. The pipeline picks the matching `Sample` type. EXR → `f32`
linear; 16-bit TIFF → `rgb16`; 8-bit TIFF + all SDR → `rgba8`.

## Error handling

- Unknown / unsupported format → surfaced to UI as a clear message (mirrors the
  existing `Unknown file type` branch), never a silent failure.
- Decoder error (corrupt EXR/TIFF) → `Result` → UI error, no panic across the wasm
  boundary.
- AVIF unsupported by browser → `createImageBitmap` rejects → caught → "AVIF not
  supported by this browser" hint.

## Testing — synthetic Mandelbrot, clean round-trip

Port `generate-fractal-tiff.mjs` (Mandelbrot, view `x∈[-2.5,1]`, `y∈[-1.25,1.25]`)
to **smooth/continuous escape-time** with **HDR range (>1.0)** and emit:
- **f32 EXR** (`mandelbrot_f32.exr`)
- **16-bit TIFF** (`mandelbrot_u16.tiff`)
- (keep 8-bit TIFF for the SDR/tiff path)

Round-trip assertions (native `cargo test` + in-browser render via playwright/flipflopdom):
1. `decode_exr(mandelbrot_f32.exr)` → dims match, no `NaN`/`Inf`, HDR values >1.0 survive.
2. f32 → pipeline → output: value parity within tolerance vs the generator's source
   buffer (account for any documented tone/colour transform), channel separation
   preserved (the palette is deliberately non-grey).
3. Visual: rendered output of the synthetic image is clean (no banding/clipping/garbage)
   — screenshot compared, "clean at the other side."
4. `decode_tiff` u8 + u16 both decode to correct dims/values.

## Success criteria

- User can drop PNG/JPEG/GIF/WebP/AVIF/TIFF/EXR and see a correct preview, all in-browser.
- EXR decodes to f32 and traverses the pipeline without losing bit depth (HDR values
  intact through the f32 branch).
- Synthetic Mandelbrot EXR + 16-bit TIFF round-trip clean (tests green, visual clean).
- No regression to existing RAW / JXL ingestion.
- `wasm-pack build` succeeds with the new crates; bundle growth bounded to the two crates.

## Risks

- `exr` threads feature must be off for wasm (build-break otherwise).
- f32 ingress may be the real engineering if the pipeline only has u8/u16 today.
- General RGB TIFF variety (tiles/strips, planar config, bit depths) — `tiff` crate
  covers the common cases; exotic TIFFs may error (acceptable, surfaced).
- AVIF coverage = browser-dependent (documented, not a code gap).
