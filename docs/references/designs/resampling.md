# Feature Design Note: Resampling Controls

**Feature:** JXL encoder resampling (`JXL_ENC_FRAME_SETTING_RESAMPLING` and related extra-channel resampling)  
**Date:** 2026-05-28  
**Author:** Grok  
**Status:** Design ready for implementation handoff  
**Priority:** Explicitly listed in HANDOFF sprint priorities ("Resampling + Photon Noise"). Part of the advanced encoder control surface that is currently weakly exposed.

---

## 1. Goal & Value

Expose the ability to request that the JXL encoder downsample (resample) the image data by a factor (typically 2×, 4×, or 8×) *before* the main transform and entropy coding. This is a powerful quality/size and encoding-speed control.

**Why this belongs in the CasaWASM feature-maximal push:**
- Useful for generating smaller "preview" or "web" encodes from high-resolution sources without a separate pre-resize step.
- Can produce better perceptual quality at low bitrates compared to pure post-decode downscaling in some cases (because the encoder can optimize the downsampling jointly with the compression).
- Pairs naturally with Photon Noise (both are "pre-transform" controls that affect the character of the final image).
- The project already has strong investment in high-quality WASM resizing (`wasm-resizer-spec.md` + `fast_image_resize` work). Exposing the *encoder-native* resampling path gives users a choice between "resize then encode" vs "let the JXL encoder resample during encode."
- Low-to-medium implementation risk once the pattern for other frame settings is established.

---

## 2. Reference Analysis

Because this feature has lighter coverage in the current `references/` extracts compared to Brotli/Modular/Photon Noise, the analysis relies on:

- Explicit callout in the HANDOFF as a priority item.
- Standard libjxl encoder frame settings (`JXL_ENC_FRAME_SETTING_RESAMPLING` and `JXL_ENC_FRAME_SETTING_EXTRA_CHANNEL_RESAMPLING`).
- cjxl command-line usage (recent versions expose `--resampling` and `--ec_resampling`).
- jpegxl-rs escape hatch pattern (consistent with all other advanced settings we have designed).
- Existing project thinking on downscaling (the WASM resizer spec provides context on desired quality/speed tradeoffs and user expectations).

**Cross-reference recommendation:** When implementing, also consult the current `docs/wasm-resizer-spec.md` so the two downscaling paths (pre-encode in JXL vs post-decode WASM resizer) can be documented together in the benchmark/lab.

---

## 3. Recommended API Shape

### TypeScript (facade)

```ts
export interface EncoderOptions {
  // ... existing fields

  /**
   * Resampling factor for the main image (1 = no resampling, 2/4/8 = downsample by that factor before encoding).
   * Higher values produce smaller files and faster encodes at the cost of detail.
   */
  resampling?: 1 | 2 | 4 | 8;

  /**
   * Per-extra-channel resampling factors (when extra channels are in use).
   * Array should align with `extraChannels`.
   */
  extraChannelResampling?: (1 | 2 | 4 | 8)[];
}
```

For the first cut, supporting the main `resampling` factor + a simple extra-channel array is sufficient. We can add named constants or a small enum later.

### Rust (Tauri)

```rust
pub struct EncodeParams {
    // ...
    pub resampling: Option<u32>,                    // 1, 2, 4, 8
    pub extra_channel_resampling: Option<Vec<u32>>,
}
```

---

## 4. WASM Implementation

### bridge.cpp

After frame settings creation (same pattern as Brotli, Decoding Speed, Photon Noise, Modular):

```cpp
if (options.resampling > 1) {
    JxlEncoderFrameSettingsSetOption(
        frame_settings,
        JXL_ENC_FRAME_SETTING_RESAMPLING,
        options.resampling);
}

if (options.extra_channel_resampling && !options.extra_channel_resampling.empty()) {
    // Apply per extra channel using JXL_ENC_FRAME_SETTING_EXTRA_CHANNEL_RESAMPLING
    // (index-based or via the extra channel API)
}
```

Note: Extra-channel resampling is typically set via `JxlEncoderSetExtraChannelInfo` + distance/resampling on the specific channel, or the dedicated frame setting. The exact call depends on libjxl version — the cjxl source is the best guide during implementation.

### facade.ts

Straightforward forwarding + light validation that the factor is one of the allowed powers of two.

Consider also exposing a helper or documenting the interaction with the existing `downscale_rgba` / `LookRenderer` path in the RAW pipeline (`src/lib.rs`).

---

## 5. Tauri / Native Side

Use the escape hatch (as with the previous four advanced settings):

```rust
if let Some(factor) = params.resampling {
    if factor > 1 {
        encoder.set_frame_option(JxlEncoderFrameSetting::Resampling, factor as i64)?;
    }
}
// Similar for extra channel resampling
```

Over time these can be grouped under an `AdvancedEncodeOptions` or `ResamplingOptions` struct for ergonomics.

---

## 6. Benchmark Wiring (Mandatory)

This is an excellent candidate for visual demonstration.

**Recommended location:** Extend the existing `jxl-wrapper-lab.js` or create a small "Downscaling Strategies" tab that compares three paths side-by-side:

1. Full-res encode → decode → WASM resizer (current strong path)
2. Pre-resize with WASM resizer → encode at target size
3. Encode with native JXL `resampling` factor (new)

**UI controls:**
- Dropdown or buttons for resampling factor: 1 / 2 / 4 / 8
- Checkbox or separate control for extra-channel resampling when relevant
- Metrics: final file size, encode time, decode time, and a visual crop comparison (especially on high-frequency detail and text)

**Synergy opportunity:** The benchmark can become the canonical place to educate users on when to use each downscaling strategy.

---

## 7. Testing

- Encode the same high-resolution source at resampling=1, 2, 4, 8.
- Verify monotonic decrease in file size and encode time.
- Visual quality regression test on a set of detail-rich images (text, fine textures, gradients).
- Confirm that extra-channel resampling (when implemented) affects only the specified channels.
- Default (1 or omitted) must be bit-identical to previous behavior.

---

## 8. Files Expected to Change

**WASM:**
- `packages/jxl-wasm/src/bridge.cpp`
- `packages/jxl-wasm/src/facade.ts`
- `packages/jxl-wasm/test/facade.test.ts`
- `web/jxl-wrapper-lab.js` (or new downscaling comparison page)

**Rust:**
- Encode params + escape hatch usage

**Docs / Process:**
- Link this note to `docs/wasm-resizer-spec.md` during implementation for user guidance.
- PROGRESS_LOG entry + Cleanup & Handoff at completion.

---

## 9. Edge Cases & Interactions

- Resampling interacts with `effort`, `decodingSpeed`, `photonNoiseIso`, and Modular settings. High effort + resampling=4 can still be useful.
- When using extra channels, mismatched resampling between color and extra channels can produce surprising alignment results — document this clearly.
- Not all images benefit equally; content with strong high-frequency detail loses more than smooth photographic content.
- The resampling happens inside libjxl before the color transform / modular or VarDCT stage.

---

## 10. Rationale

- Scoped to the core `resampling` factor + extra-channel variant to match the "Resampling + Photon Noise" priority pair.
- Explicitly calls out synergy with the existing high-quality WASM resizer work so the two paths are not developed in isolation.
- Uses the same escape-hatch + clean nested options pattern established in the previous four notes for consistency.

---

## 11. Implementation Checklist

- [ ] Branch: `feature/resampling`
- [ ] Wire main `resampling` factor in bridge + facade
- [ ] Add extra-channel resampling support (or defer to a small follow-up)
- [ ] Build the comparative downscaling benchmark (high value)
- [ ] Tests + visual regression set
- [ ] Tauri side
- [ ] Cross-link documentation with the existing resizer spec
- [ ] Full handoff artifacts + PROGRESS_LOG entry

---

**End of design note.**

This is the sixth note in the ongoing iteration. Next: Full extra channel infrastructure (Phase 2), followed by Animation/Multi-Frame. Continuing immediately.