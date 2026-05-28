# Feature Design Note: Core Modular Controls

**Feature:** JXL_ENC_FRAME_SETTING_MODULAR_* family (group size, predictor, palette, nb_prev_channels, colorspace, etc.)  
**Date:** 2026-05-28  
**Author:** Grok  
**Status:** Design ready for implementation handoff  
**Related Index Section:** 3. Modular Mode & Advanced Modular Controls  
**Priority:** Highest-leverage remaining encoder gap (explicitly called out in HANDOFF sprint list)

---

## 1. Goal & Value

Provide first-class, ergonomic control over libjxl's Modular encoding mode and its key tuning parameters. This is the most powerful remaining set of levers for controlling compression behavior, memory use, and quality/size tradeoffs on images that benefit from (or are forced into) Modular mode.

**Why this is critical for CasaWASM:**
- Scientific, medical, and certain photographic content often compresses *far* better under Modular than VarDCT.
- Many advanced features (extra channels with high bit depth, lossless, certain HDR workflows) are only available or optimal in Modular.
- The handoff document and sprint priorities repeatedly highlight "Core Modular controls (predictor, group size, etc.)" as a top target.
- cjxl_main.cc shows extremely detailed real-world usage of the entire family — this is one of the strongest references we have.

**Scope for first implementation pass:** The highest-impact subset (group size, predictor, force modular, basic palette, nb_prev_channels). Remaining flags (ma_tree_learning_percent, specific colorspace tweaks, etc.) can be added in a follow-up or via a generic escape hatch.

---

## 2. Reference Analysis

| Library                  | Exposure                                                                 | Quality | Notes |
|--------------------------|--------------------------------------------------------------------------|---------|-------|
| **cjxl_main.cc** (primary) | Extremely detailed: `--modular`, `--modular_group_size`, `--modular_predictor`, `--modular_nb_prev_channels`, `--modular_palette_colors`, `--modular_lossy_palette`, `--modular_ma_tree_learning_percent`, color channel percentages, etc. All wired in ProcessFlags. | Outstanding | The single best place to see the full option set used together in production. |
| **inflation/jpegxl-rs**  | Full escape hatch via `set_frame_option` for the entire Modular family   | High    | No dedicated builder methods for most of these. The escape hatch is the intended power-user path. |
| **libvips**              | Mostly implicit (some internal heuristics)                               | Low     | Production wrapper deliberately hides almost all of this. |
| **chafey/libjxl-js**     | Hard-coded a few modular settings in encode()                            | Weak    | Not a good model for controllable API. |
| **libjxl raw**           | Full `JXL_ENC_FRAME_SETTING_MODULAR_*` enum family + `JxlEncoderFrameSettingsSetOption` | Definitive | The source of truth. |

**Strategic takeaway:** We should expose the most useful knobs cleanly while also providing a generic escape hatch (especially important on the Rust side to match jpegxl-rs philosophy).

---

## 3. Recommended API Shape

Because there are many related settings, a nested object is strongly preferred over 8–10 flat fields.

### TypeScript (recommended)

```ts
export interface EncoderOptions {
  // ... existing

  modular?: {
    /** Force Modular mode (true) or VarDCT (false). Omit = auto (libjxl default). */
    force?: boolean;

    /** Group size (0 = auto, or power-of-two values). Affects compression efficiency and memory. */
    groupSize?: number;

    /** Predictor selection (0-15 or specific enum values per libjxl). Major quality knob. */
    predictor?: number;

    /** Number of previous channels to use for prediction. */
    nbPrevChannels?: number;

    /** Enable/disable palette for color channels. */
    palette?: boolean;

    /** Number of palette colors (when palette is enabled). */
    paletteColors?: number;

    /** Allow lossy palette (useful for certain scientific false-color data). */
    lossyPalette?: boolean;

    /** Advanced: tree learning percent (0-100). Rarely needed. */
    maTreeLearningPercent?: number;
  };
}
```

For the very first cut, implement the top four (`force`, `groupSize`, `predictor`, `nbPrevChannels` + `palette` basics) with a clean nested shape. The rest can live under an `advanced` sub-bag or be added later.

### Rust (Tauri)

Mirror the same nested structure or use a `ModularOptions` struct that is passed into the encoder wrapper. Use the escape hatch for anything not yet given a dedicated setter.

---

## 4. WASM Implementation

### bridge.cpp

This will be the largest change of the four notes so far.

- Accept a `modular_options` struct (or flat fields for simplicity in the C++ ABI).
- After frame settings creation:
  ```cpp
  if (modular.force) {
      JxlEncoderFrameSettingsSetOption(..., JXL_ENC_FRAME_SETTING_MODULAR, *modular.force ? 1 : 0);
  }
  if (modular.group_size) {
      JxlEncoderFrameSettingsSetOption(..., JXL_ENC_FRAME_SETTING_MODULAR_GROUP_SIZE, v);
  }
  // similarly for PREDICTOR, NB_PREV_CHANNELS, PALETTE, etc.
  ```

All the `JXL_ENC_FRAME_SETTING_MODULAR_*` constants are defined in the libjxl headers that are already available during the Emscripten build.

### facade.ts

Translate the nice nested JS object into whatever the bridge expects (flat or small struct). Keep the public API ergonomic.

Consider also exposing a low-level `setModularFrameOption(id, value)` escape hatch for power users and future-proofing (mirrors what jpegxl-rs does).

---

## 5. Tauri / Native Side

This is where the jpegxl-rs escape hatch pattern becomes essential.

```rust
if let Some(mod_opts) = params.modular {
    if let Some(force) = mod_opts.force {
        encoder.set_frame_option(JxlEncoderFrameSetting::Modular, force as i64)?;
    }
    if let Some(gs) = mod_opts.group_size {
        encoder.set_frame_option(JxlEncoderFrameSetting::ModularGroupSize, gs as i64)?;
    }
    // ... predictor, nb_prev_channels, palette_*, etc.
}
```

Over time, the native wrapper can grow a small dedicated `ModularOptions` struct with the most common fields, falling back to the raw escape hatch for the long tail.

---

## 6. Benchmark Wiring (Mandatory)

This is the most important benchmark addition of the current batch.

**Recommended:** Either extend `jxl-wrapper-lab.js` with a "Modular" panel or create a focused `modular-benchmark.html` page (the latter may be cleaner given the number of controls).

**Controls needed:**
- Checkbox: Force Modular mode
- Slider / dropdown: Group size (with "auto" option)
- Predictor selector (the 0-15 range or named presets if libjxl documents friendly names)
- Number input: nbPrevChannels
- Palette on/off + color count
- A good test corpus: synthetic gradients, medical imaging style data, high-bit-depth false color, lossless photographic crops.

**Metrics:** file size, encode time, decode time, and (ideally) a simple "lossless roundtrip error" check when using lossless settings.

This benchmark will become one of the most valuable tools in the entire lab once populated.

---

## 7. Testing

- Matrix of (force Modular + different predictors + group sizes) on representative images.
- Verify that forcing Modular on content that "wants" VarDCT still produces valid (if larger) output.
- Palette + lossy palette behavior.
- Ensure default (no modular options) produces identical output to before.
- Cross-platform parity checks once Tauri side lands.

---

## 8. Files & Scope Expectations

**WASM:**
- `packages/jxl-wasm/src/bridge.cpp` (biggest single file change in this batch)
- `packages/jxl-wasm/src/facade.ts` (nice nested options + optional escape hatch)
- Tests + benchmark page

**Rust:**
- Params struct + escape hatch usage (or dedicated ModularOptions)

**Process:**
- One feature branch (`feature/core-modular-controls` or split into predictor + group-size if the PR grows too large)
- Full Cleanup & Handoff + PROGRESS_LOG at the end

---

## 9. Phasing Recommendation

Because this is the richest feature so far, consider two phases:

**Phase 1 (this note):** `force`, `groupSize`, `predictor`, `nbPrevChannels`, basic palette.
**Phase 2:** lossyPalette, maTreeLearningPercent, specific colorspace tweaks + a mature generic escape hatch.

This keeps the first implementation deliverable while still delivering the "core" controls the sprint cares about.

---

## 10. Rationale

- Nested `modular: { ... }` object chosen for usability and future expansion.
- Prioritize the four settings most frequently mentioned in handoff discussions and cjxl usage.
- Escape hatch on both sides is non-negotiable for long-term power and to match jpegxl-rs design.
- Benchmark is non-negotiable and will be disproportionately valuable.

---

## 11. Implementation Checklist

- [ ] Branch: `feature/core-modular-controls`
- [ ] Define the nested options shape in TS (and Rust)
- [ ] Wire the top 4–5 settings in bridge.cpp
- [ ] Add escape hatch
- [ ] Build substantial benchmark UI (this is the hard part)
- [ ] Tests + parity
- [ ] Tauri side
- [ ] Full handoff artifacts

---

**End of design note.**

This is the fourth note in the current iteration. The next logical item after this is the "basic extra-channel distance" half of the paired priority mentioned in the HANDOFF. I will continue immediately unless directed otherwise.