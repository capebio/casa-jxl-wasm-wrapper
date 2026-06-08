# Milestone M3: 16-bit RAW Path — Verification Checklist & Specifications

**Milestone Status:** Planned & Approved (M3 HDR/16-bit Stage)
**Target Branch:** `feat/pyramid-m3-raw16-webgl-roi`

This document contains the acceptance checklist, bit-depth behavior specifications, 16-bit toggle user guide, and highlight/shadow recovery comparisons for Milestone M3 (16-bit RAW and WebGL) of the Pyramid Gallery Pipeline.

---

## 1. Acceptance Checklist

Use this checklist to verify that all M3 goals are met in the ingest pipeline and the WebGL-enabled lightbox.

### 1.1 Ingest & Bit Depth
- [ ] **16-bit Bridge Integration:** `src/lib.rs` and WASM are compiled to expose the internal full-resolution `RGB16` RAW buffers.
- [ ] **Adaptive Bit Depths:** Ingest produces 16-bit JXL for RAW `{2048, full}` levels, while RAW grid levels `{256, 512, 1024}` and ALL JPEG levels remain 8-bit.
- [ ] **Schema Compatibility:** Varying bit depths across levels of the same image do not trigger a schema version bump or break existing clients. Manifest records `bitsPerSample: 16` on RAW `{2048, full}`.
- [ ] **JPEG Guard:** Ingest never emits 16-bit levels for JPEG master inputs; they are clamped to 8-bit since no extra bit-depth headroom exists.

### 1.2 WebGL Pipeline & Dithering
- [ ] **16-bit Capability Detection:** Client checks the manifest to detect if a level has `bitsPerSample === 16` before allocating high-precision resources.
- [ ] **RAW-only 16-bit Toggle:** A user-facing "16-bit HDR" toggle is added to the lightbox, defaulting to OFF (displaying the fast 8-bit JXL).
- [ ] **WebGL Float Textures:** When enabled, the 16-bit JXL level is decoded into a WebGL floating-point texture (`gl.RGBA16F` or `gl.RGBA32F`), avoiding CPU clipping.
- [ ] **Float-Space Recovery Math:** Highlights compression and shadows lift are computed in high-precision float space, unlocking real highlights recovery (no clipping).
- [ ] **Floyd-Steinberg Dithering:** Before rendering to the 8-bit sRGB canvas, WebGL downconverts the precision using a Floyd-Steinberg dither pass to prevent visual banding in gradients.
- [ ] **Crop-to-Feature ROI Export:** Clicking "Export Crop" decodes only the requested region of interest (ROI) bounding box using `decodeRegionLod` at high precision and outputs the crop.

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
