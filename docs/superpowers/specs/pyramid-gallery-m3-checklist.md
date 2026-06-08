# Milestone M3: 16-bit RAW Path — Verification Checklist & Specifications

**Milestone Status:** Foundation complete + verified (M3 HDR/16-bit). Ingest 16-bit big-levels, encodeRgba16+downscaleRgba16+take_rgb16_full, manifest bitsPerSample, raw-backend, pyramid-lightbox 16 toggle + decode 'rgba16', webgl-pipeline (RGBA16F/FS dither + CPU mirror + adjusted export), ROI via decodePyramidRegion + encodeRgba16. 40/40 pyramid-ingest + 6/6+ bridge + web lightbox string tests pass. Docker jxl-wasm rebuild (encode/decode rgba16 bridges) + raw WASM done.
**Target Branch:** `feat/pyramid-m3-raw16-webgl-roi`
**To see M3 live (per user handoff):** 
1. Re-ingest RAW masters: `node packages/pyramid-ingest/dist/cli.js --out /path/to/gallery-out --force /path/to/raw-masters-dir` (or bun equiv; uses current raw-backend which requests 16 + rgb16.ts for 2048/full).
2. Serve the out dir (e.g. via tools/dev-server or static).
3. Open web/pyramid-gallery/pyramid-gallery.html → enter gallery root URL → Load → click a re-ingested RAW thumbnail → lightbox → enable "16-bit HDR (RAW)" toggle (only visible for RAW with 16 levels) → WebGL (or CPU) shader paint + live adjustments in float + dither.
4. Zoom/ pan / Export crop: for 16 gets -roi.jxl (16-bit) + -roi-preview.png (8 dither).
Old manifests are 8-only; grid + JPG paths untouched.

This document contains the acceptance checklist, bit-depth behavior specifications, 16-bit toggle user guide, and highlight/shadow recovery comparisons for Milestone M3 (16-bit RAW and WebGL) of the Pyramid Gallery Pipeline.

---

## 1. Acceptance Checklist

Use this checklist to verify that all M3 goals are met in the ingest pipeline and the WebGL-enabled lightbox.

### 1.1 Ingest & Bit Depth
- [x] **16-bit Bridge Integration:** `src/lib.rs` and WASM compiled (OUT_FULL_16=8, rgb16_full/take_rgb16_full/pack in orf/dng/cr2, web/pkg). jxl-wasm Docker rebuild supplies encode/decode rgba16.
- [x] **Adaptive Bit Depths:** `packages/pyramid-ingest/src/ladder.ts` + `rgb16.ts` (encodeBigLevelsRgba16 via downscaleRgba16+encodeRgba16) produce 16 for RAW 2048/full when rgb16 present; grid <=1024 and all JPG =8. (40/40 ingest tests incl "emits 16-bit big levels").
- [x] **Schema Compatibility:** `manifest.ts` writes per-level `bitsPerSample: 8|16`; no schema bump. Clients (levelPool, wants16) filter dynamically.
- [x] **JPEG Guard:** Only RAW decode path requests OUT_FULL_16 + feeds rgb16 to buildRawLadder; JPG path never produces 16 levels.

### 1.2 WebGL Pipeline & Dithering
- [x] **16-bit Capability Detection:** `pyramid-lightbox.js` levelPool() + wants16() filter manifest.levels by bitsPerSample===16; canUseWebGL16() probe.
- [x] **RAW-only 16-bit Toggle:** html: `<input data-toggle-16bit /> 16-bit HDR (RAW)`; js: default false, hidden for jpg or !has16, on change sets use16Bit + clear cache + refreshView. (Spec default OFF preserved.)
- [x] **WebGL Float Textures:** `webgl-pipeline.js` createHdrRenderer: webgl2 RGBA16F (or RGBA32F FBO) or OES_texture_float + WEBGL_color_buffer_float fallback; uploadSource converts u16 bytes to float tex.
- [x] **Float-Space Recovery Math:** Shader (and CPU mirror) run buildColorMatrix + luma-masked shadows lift / highlights compress in float before clamp. `renderRgba16AdjustedToCanvas` + `adjustedRgba16ForExport` are the primary path.
- [x] **Floyd-Steinberg Dithering:** `floydSteinbergDitherToCanvas` (err diffusion 3ch) + putImageData for final 8-bit canvas. Histogram from post-dither 8.
- [x] **Crop-to-Feature ROI Export:** `exportRoi` + `fetchRoiDecoded` (decodePyramidRegion or decodePyramidLevel+tiled for region) at format rgba16 when use16; then `adjustedRgba16ForExport` + `encodeRgba16` → `${id}-roi.jxl` (16-bit edited) + dithered `${id}-roi-preview.png`. Non-16 path emits 8 png only. (16 JXL is the HDR file export; PNG is preview.)

---

## 2. Bit-Depth Behavior: RAW vs. JPG Masters

This table illustrates the strict separation of bit-depth assets between RAW and JPEG masters.

| Master File Format | Pyramid Level | Ingest Bit Depth | JXL Target Quality | Client Toggle Effect | WebGL Path |
|:---|:---|:---:|:---:|:---|:---|
| **RAW** (orf/dng/cr2) | `{256, 512, 1024}` | **8-bit** | q85 (`1.45`) | N/A (Always 8-bit) | Standard 2D Canvas |
| **RAW** (orf/dng/cr2) | `{2048, full}` | **16-bit** | q95 (`0.55`) | Enables real highlight recovery | WebGL float shader |
| **JPEG** (jpg/jpeg) | `{256, 512, 1024}` | **8-bit** | q85 (`1.45`) | Disabled / Hidden | Standard 2D Canvas |
| **JPEG** (jpg/jpeg) | `{2048, full}` | **8-bit** | Lossless / q95 | Disabled / Hidden | Standard 2D Canvas |

### Why is 16-bit RAW-Only?
JPEG files are natively 8-bit per channel and their color values are already tone-mapped and clamped. Once highlight detail is blown in an 8-bit JPEG, those pixels are forever white (`255, 255, 255`) and cannot be recovered. 

RAW files carry 12-bit to 16-bit linear sensor data containing 12 to 15 stops of dynamic range. Even if an area appears blown in standard sRGB rendering, the extra bit-depth headroom inside the 16-bit JXL allows the WebGL float shader to pull those values back below `1.0` (white) and recover authentic texture, color, and structure.

---

## 3. User Guide & Interface Copy: "16-bit HDR" Toggle

### UI Label:
`[ ] Enable 16-bit Dynamic Range (RAW Only)`

### Tooltip / Help Text:
> "Decodes the uncompressed 16-bit camera sensor data directly into a WebGL floating-point pipeline. This unlocks professional highlight recovery and shadow-lifting, allowing you to restore details in overexposed skies or deep shadows without introducing color banding."

### Fallback Notification (for JPEG files or when WebGL fails):
> "16-bit Dynamic Range is not available for this image because it was captured as an 8-bit JPEG. High dynamic range recovery requires a RAW file master."

---

## 4. Highlight Recovery Comparison & Verification Guide

Use these test cases to visually and programmatically confirm that highlight and shadow recovery is functioning correctly on the approved test fixtures.

### Fixture: `c:\Foo\raw-converter\tests\PXL_20260527_180319603.RAW-02.ORIGINAL.dng`
- **Symptom in 8-bit path:** The sky and cloud highlights appear completely washed out (flat white). Dragging the **Highlights** slider to `-100%` turns the sky flat gray (no detail retrieved, just darkened clipping).
- **Behavior in 16-bit path:** Dragging the **Highlights** slider to `-100%` pulls the cloud textures back into view. Intricate, fine shapes and subtle blue sky transitions become visible. Programmatic check: pixels that were clipped white (`255, 255, 255`) now display diverse, low-variance color values.

### Fixture: `c:\995\2026-02-20 Gobabeb To Windhoek\P2200566 Adenolobus pechuelii.ORF`
- **Symptom in 8-bit path:** Shadows under the specimen leaves are dark black. Dragging the **Shadows** slider to `+100%` lifts the shadows but introduces visible color banding, noise, and digital artifacts.
- **Behavior in 16-bit path:** Dragging the **Shadows** slider to `+100%` reveals delicate botanical veins and hair structures inside the shadow. The transition remains perfectly smooth with zero banding or stair-stepping due to Floyd-Steinberg dithering.
