# Milestone M2: 8-bit Lightbox — Verification Checklist & Specifications

**Milestone Status:** Planned & Approved (M2 Lightbox Stage)
**Target Branch:** `feat/pyramid-m2-lightbox-8bit`

This document contains the acceptance checklist, preset constants documentation, slider definitions, and manual QA checklist for Milestone M2 (8-bit Lightbox with adjustments) of the Pyramid Gallery Pipeline.

---

## 1. Acceptance Checklist

Use this checklist to verify that all M2 goals are met in the lightbox UI and the `filter-engine.ts` layers.

### 1.1 UI & Viewport Invariants
- [ ] **Adaptive Level Selection:** Lightbox chooses the optimal JXL level to load based on `screenLongEdge × devicePixelRatio`.
- [ ] **Smooth Zoom Ladder:** Zooming upgrades progressively from `L1/L2` (loaded for the grid) to `2048` and finally to `full`, crossfading smoothly on upgrade.
- [ ] **Canvas-Based Panning:** Panning uses a lightweight canvas 2D matrix transform, triggering ZERO re-decodes while panning until the zoom level changes.
- [ ] **Live Zoom Readout:** A live zoom percentage text matches the CasaBio `txtZoomPct` element behavior.
- [ ] **Monotonic Cache/LRU:** Lightbox holds decoded screen-bitmaps in an LRU cache to prevent re-decoding when flipping between recent images.
- [ ] **Dual Dispatcher Priorities:** Currently viewed image decoding takes high priority in the scheduler over background prefetch image decodes (current page > prefetch pages).

### 1.2 Parity & Adjustments (FilterEngine)
- [ ] **Preset Parity:** All 12 approved CasaBio presets are supported and produce correct color-matrix outputs.
- [ ] **Slider Parity:** All 8 adjustment parameters map to correct color transformations and render live at 60fps on canvas/WebGL.
- [ ] **Live Histogram:** A real-time histogram displays the red, green, blue, and luminance distribution of the currently visible screen pixels, updating instantly as sliders move.
- [ ] **No Android Dependency:** No compile-time, build-time, or run-time dependency exists on the external `CplusplusTest` Android project path. All color-matrix math is self-contained.

---

## 2. Approved Lightbox Presets & Intended Visual Roles

These presets correspond strictly to the CasaBio `FilterEngine` color matrices.

| Preset Name | Constants Reference | Primary Visual Role |
|:---|:---|:---|
| **BW** | `LightboxPreset.BW` | Standard high-contrast black-and-white conversion. |
| **BW_HIGH** | `LightboxPreset.BW_HIGH` | Black-and-white with crushed shadows and bright highlights. |
| **BW_SOFT** | `LightboxPreset.BW_SOFT` | Low-contrast black-and-white, preserving midtone details. |
| **SEPIA** | `LightboxPreset.SEPIA` | Classic warm, brownish-tint monochrome wash. |
| **INVERT** | `LightboxPreset.INVERT` | Inverted color channels (e.g. for film negative preview). |
| **BOTANICAL** | `LightboxPreset.BOTANICAL` | Enhanced greens and yellows, optimized for botanical specimens. |
| **WARM** | `LightboxPreset.WARM` | Shift toward amber/red spectrum (temperature increase). |
| **COOL** | `LightboxPreset.COOL` | Shift toward blue spectrum (temperature decrease). |
| **DEHAZE** | `LightboxPreset.DEHAZE` | Coarse contrast expansion in midtones to cut through glare. |
| **BLUEPRINT** | `LightboxPreset.BLUEPRINT` | Deep blue monochrome with high white contrast (cyanotype style). |
| **CHLOROPHYLL** | `LightboxPreset.CHLOROPHYLL` | Extremely high green-channel isolation and amplification. |
| **NONE** | `LightboxPreset.NONE` | Neutral state (identity color matrix). Pass-through. |

---

## 3. Slider Labels & Help Copy

These labels and explanations must be shown in the lightbox adjustment panel.

| Slider Key | User-Facing Label | Help/Description Copy | Value Range | Default |
|:---|:---|:---|:---|:---:|
| **brightness** | Brightness | Adjusts the overall exposure of the image. | -100% to +100% | 0% |
| **contrast** | Contrast | Adjusts the difference between light and dark areas. | -100% to +100% | 0% |
| **saturation** | Saturation | Controls the intensity and purity of colors. | -100% to +100% | 0% |
| **shadows** | Shadows | Lifts detail in dark areas without clipping highlights. | 0% to +100% | 0% |
| **highlights** | Highlights | Compresses detail in bright areas to prevent clipping. | -100% to 0% | 0% |
| **clarity** | Clarity | Adds local midtone contrast for extra definition and texture. | 0% to +100% | 0% |
| **dehaze** | Dehaze | Removes atmospheric haze, fog, or lens flare. | 0% to +100% | 0% |
| **sharpness** | Sharpness | Sharpens fine details using high-pass filtering. | 0% to +100% | 0% |

---

## 4. Manual QA Interactive Checklist

Follow these steps in the browser to manually verify correct lightbox behavior.

- [ ] **Opening Transition:** Click a grid image. It must open immediately in the lightbox, seeding the layout with the already-cached `L0` (256px) or `L1` (512px) grid thumbnail first, then crossfading to `2048` or `full` level when decoded.
- [ ] **Zooming & Scaling:** Double-click or pinch-zoom to 100%. The zoom readout must update to `100%`. The image must upgrade to the `full` level and render crisp details.
- [ ] **Panning Snappiness:** Pan the zoomed-in image. Panning must feel instant and maintain 60fps, with zero lagging or blank screen tiles.
- [ ] **Flipping Performance:** Press Left/Right arrow keys to flip images. Transition must feel instantaneous for already-cached images, and must load adjacent images in the background.
- [ ] **Adjustments Live Feed:** Drag the **Saturation** slider to `-100%`. The image must immediately become black-and-white. The **Histogram** must instantly compress to a single grayscale line.
- [ ] **Preset Switching:** Select the **Botanical** preset. Greens must instantly pop. Moving other sliders should stack on top of the preset's base transformation.
- [ ] **Reset Behavior:** Click the "Reset" button. All sliders must return to `0` and the preset to `NONE`, with the image returning to its original state.

---

## 5. Basic Test Specification

A unit test file `filter-engine.test.ts` must be written by the implementer to assert the following:
1. **Name Completeness:** Verifies that all 12 elements of the `APPROVED_LIGHTBOX_PRESETS` list exist, and that they match the `LightboxPreset` enum.
2. **Preset Safety:** Asserts that calling the filter engine with an unsupported preset throws an explicit error instead of failing silently.
3. **Parameter Validity:** Asserts that only the 8 approved adjustment parameters (`brightness`, `contrast`, etc.) can be modified, and their values are clamped strictly within their specified ranges.
