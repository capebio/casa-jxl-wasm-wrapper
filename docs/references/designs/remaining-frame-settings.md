# Feature Design Note: Remaining Low-Level Frame Settings

**Feature:** Catch-all completeness record for all `JXL_ENC_FRAME_SETTING_*` IDs from libjxl / cjxl.
**Date:** 2026-06
**Author:** Grok + David (audit pass)
**Status:** Complete — 0 new promotions; 10 IDs in escape hatch with documented guidance
**Related Index Section:** Medium / Follow-up (catch-all)
**Priority:** Low — reference and completeness only

---

## 1. Goal & Value

After all major design notes (first-class-advanced-encoder-controls, core-modular-controls, Phase 3 micro-features, etc.), confirm that no high-value `JXL_ENC_FRAME_SETTING_*` IDs have been missed. This note is the official audit record for the 2026 design wave.

Verdict: **All high-ROI settings are first-class. 0 new promotions required.** The escape hatch is the right home for the remaining niche/low-value IDs.

---

## 2. Coverage Audit — All Frame Setting IDs

| ID | cjxl Name | Coverage | Notes |
|----|-----------|----------|-------|
| 0 | EFFORT | ✅ First-class: `effort` | Core encode option |
| 1 | RESAMPLING | ✅ First-class: `resampling.factor` | `resampling.md` |
| 2 | EXTRA_CHANNEL_RESAMPLING | ✅ First-class: `resampling.extraChannelFactor` | `resampling.md` |
| 3 | ALREADY_DOWNSAMPLED | ✅ First-class: `alreadyDownsampled` | `pixel-art-downsampling.md` |
| 4 | PHOTON_NOISE_ISO | ✅ First-class: `photonNoiseIso` | `photon-noise.md` |
| 5 | NOISE | 🔧 Escape hatch | Low-value synthetic noise toggle |
| 6 | DOTS | 🔧 Escape hatch | Content-adaptive; only affects specific content types |
| 7 | PATCHES | 🔧 Escape hatch | `patches-splines.md` — explicitly escape-hatch-first |
| 8 | EPF | ✅ First-class: `advancedControls.epf` | `first-class-advanced-encoder-controls.md` |
| 9 | GABORISH | ✅ First-class: `advancedControls.gaborish` | `first-class-advanced-encoder-controls.md` |
| 10 | MODULAR | ✅ First-class: `modular.force` | `core-modular-controls.md` |
| 11 | KEEP_INVISIBLE | 🔧 Escape hatch | Niche; only relevant for images with invisible pixels |
| 12 | GROUP_ORDER | ✅ First-class: `advancedControls.groupOrder` | `first-class-advanced-encoder-controls.md` |
| 13 | GROUP_ORDER_CENTER_X | ✅ First-class: `advancedControls.groupOrderCenterX` | Paired with GROUP_ORDER |
| 14 | GROUP_ORDER_CENTER_Y | ✅ First-class: `advancedControls.groupOrderCenterY` | Paired with GROUP_ORDER |
| 15 | RESPONSIVE | 🔧 Escape hatch | Progressive signaling; niche |
| 16 | PROGRESSIVE_AC | 🔧 Escape hatch | Low-level progressive mode flag |
| 17 | QPROGRESSIVE_AC | 🔧 Escape hatch | Low-level progressive mode flag |
| 18 | PROGRESSIVE_DC | 🔧 Escape hatch | Low-level progressive mode flag |
| 19 | CHANNEL_COLORS_GLOBAL_PERCENT | ✅ First-class: `advancedControls.channelColorsGlobalPercent` | CfL tuning |
| 20 | CHANNEL_COLORS_GROUP_PERCENT | ✅ First-class: `advancedControls.channelColorsGroupPercent` | CfL tuning |
| 21 | PALETTE_COLORS | ✅ First-class: `modular.paletteColors` | `core-modular-controls.md` |
| 22 | LOSSY_PALETTE | ✅ First-class: `modular.lossyPalette` | `core-modular-controls.md` |
| 23 | COLOR_TRANSFORM | 🔧 Escape hatch | Internal color transform; rarely needed |
| 24 | MODULAR_COLOR_SPACE | ✅ First-class: `modular.colorSpace` | `core-modular-controls.md` |
| 25 | MODULAR_GROUP_SIZE | ✅ First-class: `modular.groupSize` | `core-modular-controls.md` |
| 26 | MODULAR_PREDICTOR | ✅ First-class: `modular.predictor` | `core-modular-controls.md` |
| 27 | MODULAR_MA_TREE_LEARNING_PERCENT | ✅ First-class: `modular.maTreeLearningPercent` | `core-modular-controls.md` |
| 28 | MODULAR_NB_PREV_CHANNELS | ✅ First-class: `modular.nbPrevChannels` | `core-modular-controls.md` |
| 29 | JPEG_RECON_CFL | ✅ First-class: `jpegReconstruction` (CFL toggle) | `jpeg-recompression-polish.md` |
| 30 | SKIP_BASIC_SIM | ✅ First-class: `advancedControls.disablePerceptualHeuristics` | `first-class-advanced-encoder-controls.md` |
| 31 | DECODING_SPEED | ✅ First-class: `decodingSpeedTier` | `decoding-speed-tier.md` |
| 32 | RESAMPLING_FUNCTION | 🔧 Escape hatch | Niche; affects resampling kernel |
| 33 | BUFFERING | ✅ First-class: `buffering` (lowMemoryMode/preferChunked) | `production-chunked-paths.md` |
| 34 | JPEG_COMPRESS_BOXES | ✅ First-class: `metadata.compressBoxes` | `metadata-boxes-container.md` |
| 35 | UPSAMPLING_MODE | ✅ First-class: `upsamplingMode` | `pixel-art-downsampling.md` |

**Summary:** 26 first-class, 10 escape-hatch. 0 new promotions.

---

## 3. Escape Hatch — Documented Guidance

The following IDs have confirmed real libjxl support but are not promoted. They should be used via `advancedFrameSettings`:

```typescript
// Example: enable noise synthesis
encoder.setAdvancedFrameSetting(5, 1);

// Example: disable patches
encoder.setAdvancedFrameSetting(7, 0);

// Example: keep invisible pixels
encoder.setAdvancedFrameSetting(11, 1);

// Example: override color transform (0=auto, 1=XYB, 2=None)
encoder.setAdvancedFrameSetting(23, 2);

// Example: set responsive (progressive signaling)
encoder.setAdvancedFrameSetting(15, 1);
```

**Escape hatch IDs and when to use them:**

| ID | When to use |
|----|-------------|
| 5 NOISE | Only if you want to add synthetic noise for stylistic effect. Default (auto) is usually correct. |
| 6 DOTS | Only if testing halftone/dot-pattern rendering behavior. Very niche. |
| 7 PATCHES | See `patches-splines.md` — try escape hatch first. |
| 11 KEEP_INVISIBLE | When images have meaningful data in alpha=0 pixels that must survive round-trip. |
| 15 RESPONSIVE | Low-level progressive signaling; use `progressive: true` high-level option instead. |
| 16 PROGRESSIVE_AC | Only if you need fine-grained progressive AC pass control. Rarely needed. |
| 17 QPROGRESSIVE_AC | Same as above. |
| 18 PROGRESSIVE_DC | Same as above. |
| 23 COLOR_TRANSFORM | Override internal color space transform. Only useful for special debugging or format studies. |
| 32 RESAMPLING_FUNCTION | Override the resampling kernel (e.g., Lanczos variant). Very niche. |

---

## 4. Rationale for Not Promoting

Each escape-hatch ID was evaluated against the ruthless standard:
- **Real, validated usage in cjxl or production references?**
- **User-visible benefit with a clear, non-expert explanation?**

IDs 5, 6, 11, 15–18, 23, 32 failed at least one criterion. The correct outcome is the escape hatch with good documentation — which is what this note provides.

---

## Implementation Progress

No implementation code needed. This note is a documentation and audit artifact only.

| Task | Status |
|------|--------|
| Audit all JXL_ENC_FRAME_SETTING_* IDs (0–35) | ✅ Done |
| Confirm 0 new promotions | ✅ Confirmed |
| Write escape-hatch guidance table | ✅ Done |
| Reference all related design notes | ✅ Done |

---

## Cleanup & Handoff

This is the official "we have covered the important ones" marker for the 2026 design wave. No follow-up implementation required.

**If new frame settings are added in a future libjxl version:** Re-audit this table. Check `jxl/encode.h` in the updated libjxl for any new `JXL_ENC_FRAME_SETTING_*` entries.

**Companion notes:**
- `first-class-advanced-encoder-controls.md` — master advanced controls note
- `core-modular-controls.md` — all modular settings
- `patches-splines.md` — detailed escape-hatch guidance for patches/splines
- `pixel-art-downsampling.md` — upsamplingMode + alreadyDownsampled
- `jpeg-recompression-polish.md` — JPEG recon CFL

**End of design note.**
