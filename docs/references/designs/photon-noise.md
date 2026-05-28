# Feature Design Note: Photon Noise

**Feature:** JXL_ENC_FRAME_SETTING_PHOTON_NOISE (synthetic photon noise / grain injection via ISO parameter)  
**Date:** 2026-05-28  
**Author:** Grok  
**Status:** Implemented in source; generated WASM rebuild pending  
**Related Index Section:** 5. Photon Noise  
**Priority:** High (explicitly listed in HANDOFF sprint priorities as "Resampling + Photon Noise"; also used as example in FEATURE_IMPLEMENTATION_TEMPLATE)

---

## 1. Goal & Value

Expose the photon noise synthesis feature so encoders can request that libjxl inject realistic, signal-dependent noise during encoding. This is controlled primarily via a target ISO value (`--photon_noise_iso` in cjxl).

**Why CasaWASM should have this:**
- Critical for scientific, medical, and high-fidelity photographic workflows where synthetic grain helps mask quantization artifacts and banding after aggressive compression or tone mapping.
- One of the more "advanced" creative/scientific controls that most thin wrappers omit.
- Directly called out in the current priority list.
- Complements the existing strong color science and progressive work in the project.
- Still relatively low-risk: single frame setting that affects the encoder's noise modeling, not pixel buffers or decoder state.

**Effect:** When enabled with a plausible ISO, the encoder adds correlated noise to the image before or during the transform stage. The noise is designed to survive the compression process and look natural on decode.

---

## 2. Reference Analysis

| Library                  | Exposure                                      | Quality | Notes |
|--------------------------|-----------------------------------------------|---------|-------|
| **cjxl_main.cc** (primary) | `--photon_noise_iso <value>` — fully wired through AddCommandLineOptions + ProcessFlags into frame settings. Best real-world example of usage + validation. | Excellent | The single best reference for how this advanced feature is actually presented and used in production. |
| **libjxl raw**           | `JXL_ENC_FRAME_SETTING_PHOTON_NOISE` (the ISO value is passed as the option argument) | Definitive | Core constant. The setting value is the desired ISO (e.g. 100, 400, 1600, 6400+). |
| **jpegxl-rs**            | Available via escape hatch / raw frame option (pattern already documented for Modular and Brotli families) | High    | No dedicated high-level method in current notes; use the generic setter. |
| **libvips**              | Not listed in the photon noise section        | Negative example | Omitted in the production abstraction — reinforces that exposing it is a differentiator for CasaWASM. |
| **chafey/libjxl-js**     | Not mentioned                                 | Absent  | Not exposed. |

**Key insight from cjxl:** The option is named `--photon_noise_iso` and accepts a real-world ISO number. This is far more user-friendly than a raw 0–N grain amount. We should preserve that mental model.

---

## 3. Recommended API Shape

### TypeScript (facade)

```ts
export interface EncoderOptions {
  // ... existing fields

  /**
   * Target ISO for synthetic photon noise injection.
   * When set (and > 0), enables libjxl's photon noise synthesis.
   * Typical values: 100, 400, 800, 1600, 3200, 6400+ (higher = more noise).
   * 
   * This is an encoder-only feature. The noise is baked into the codestream.
   */
  photonNoiseIso?: number;
}
```

Alternative names considered:
- `photonNoiseIso` (matches cjxl flag closely — recommended)
- `photonNoise` (if we later want to support a 0–1 strength model)

Start with `photonNoiseIso` for direct alignment with the best reference (cjxl).

### Rust (Tauri)

```rust
pub struct EncodeParams {
    // ...
    pub photon_noise_iso: Option<u32>,
}
```

---

## 4. WASM Implementation

### bridge.cpp

After creating frame settings in `EncodeRgba` (and other encode paths):

```cpp
if (options.photon_noise_iso > 0) {
    JxlEncoderFrameSettingsSetOption(
        frame_settings,
        JXL_ENC_FRAME_SETTING_PHOTON_NOISE,
        options.photon_noise_iso);
}
```

No clamping needed beyond what libjxl itself enforces (very high ISO values are allowed and simply produce stronger noise).

### facade.ts

- Forward the value.
- Optional: document that 0 or omitted = disabled (current behavior).
- Consider a small helper or constant for common ISO stops if desired later (`PHOTON_NOISE_ISO_1600`, etc.), but keep first cut minimal.

---

## 5. Tauri / Native Implementation

Use the escape hatch pattern already established for other advanced settings:

```rust
if let Some(iso) = params.photon_noise_iso {
    if iso > 0 {
        encoder.set_frame_option(
            JxlEncoderFrameSetting::PhotonNoiseIso,  // or the correct constant name
            iso as i64
        )?;
    }
}
```

Once the Rust wrapper has a few of these escape-hatch features (Brotli, Decoding Speed, Photon Noise, Modular), it may be worth adding a small `AdvancedFrameSettings` struct or builder extension for cleanliness. For now, keep each feature independent.

---

## 6. Benchmark Wiring (Mandatory)

**Recommended location:** `web/jxl-wrapper-lab.js` (or a new "Scientific / Grain" section if the lab grows).

**UI elements:**
- Number input or preset buttons for common ISO values: **"Photon noise ISO"**
- Presets: Off (0), 400, 800, 1600, 3200, 6400
- Default: Off
- On change, re-encode a clean gradient or low-contrast scientific-style image.
- Display: side-by-side comparison (original vs encoded), zoomable crop, and a note explaining that the noise is signal-dependent and should look natural in shadows/midtones.

**Success metric:** The user can clearly see realistic grain appear at higher ISO values without obvious patterning or color shifts.

This feature pairs extremely well with any existing tone-mapping or HDR experiments in the lab.

---

## 7. Testing Strategy

- Encode a low-noise source (synthetic gradient or real clean capture) at several ISO values.
- Visually inspect (or use simple variance metrics in test) that noise increases with ISO.
- Confirm that noise is not added when the option is 0 or omitted.
- Roundtrip through decode must succeed and look subjectively correct.
- Performance: photon noise synthesis has some encode cost — worth measuring in the benchmark harness.

---

## 8. Files Likely to Change

**WASM:**
- `packages/jxl-wasm/src/bridge.cpp`
- `packages/jxl-wasm/src/facade.ts`
- `packages/jxl-wasm/test/facade.test.ts`
- `web/jxl-wrapper-lab.js` (or dedicated grain/scientific benchmark page)

**Rust/Tauri:**
- Encode params + wrapper logic

**Docs:**
- PROGRESS_LOG.md entry at completion
- Any central encoder options reference

---

## 9. Edge Cases & Gotchas

- Very high ISO values (e.g. 25600) are valid and will produce strong visible grain.
- Interacts with `effort` and `decodingSpeed` — high effort + photon noise is a valid and useful combination for high-quality grainy output.
- The noise is added in a way that survives the chosen color space and modular/Vardct path.
- This is **not** the same as adding noise in the application before encoding. libjxl's version is signal-dependent and compression-aware.
- Default (disabled) behavior must be exactly preserved.

---

## 10. Rationale & Trade-offs

- Used the cjxl flag name (`photonNoiseIso`) as the primary guide because it is the most complete real-world reference.
- Kept the API dead simple (single number) even though the underlying implementation in libjxl is sophisticated.
- Placed in the same "advanced encoder tunings" area of the benchmark as Brotli and Decoding Speed.
- Explicitly noted as a differentiator vs libvips and chafey.

---

## 11. Implementation Checklist

- [ ] Branch: `feature/photon-noise`
- [x] WASM bridge + facade
- [x] Benchmark UI with good visual test case (gradient or real low-contrast image)
- [x] Tests (forwarding/source coverage; visual roundtrip pending rebuilt WASM)
- [x] Tauri/Rust side
- [x] Cleanup & Handoff + PROGRESS_LOG entry
- [ ] Update this note with links to landed commits

---

**End of design note.**

This is the third in the current priority batch. Next in line (per handoff ordering): Core Modular controls.
