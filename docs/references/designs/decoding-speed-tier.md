# Feature Design Note: Decoding Speed Tier

**Feature:** JXL_ENC_FRAME_SETTING_DECODING_SPEED (encoder hint for faster decoder performance)  
**Date:** 2026-05-28  
**Author:** Grok (synthesized from REFERENCE_INDEX + handoff priorities)  
**Status:** Design ready for implementation handoff  
**Related Index Section:** 6. Decoding Speed Tier  
**Priority:** High-leverage (explicitly listed in HANDOFF sprint items alongside Brotli Effort)

---

## 1. Goal & Value

Expose the `DECODING_SPEED` encoder frame setting so callers can request that the produced JXL codestream be optimized for faster decoding on the consumer side.

**Why it matters (especially for CasaWASM + Casabio):**
- Scientific / medical / high-volume viewers often care more about decode latency than the last 5% of file size.
- Progressive decode UX benefits dramatically when the encoder has produced a "fast decode" stream.
- Very low risk / high reward: another single integer frame setting (0–4 range).
- Complements the existing strong progressive streaming work already in the stack.
- Directly called out in the current sprint priorities.

**Important clarification:** This is an **encoder** setting. It does not change decoder behavior at runtime; it changes *how the encoder writes the codestream* so that a standards-compliant decoder can decode it faster (simpler entropy, different grouping, reduced complexity in certain tools, etc.).

---

## 2. Reference Analysis

| Library                  | Exposure                                      | Quality | Notes |
|--------------------------|-----------------------------------------------|---------|-------|
| **cjxl_main.cc** (primary) | `--faster_decoding <0-4>` mapped in ProcessFlags to DECODING_SPEED | Excellent | Real CLI usage + validation. Higher numbers = faster decode, usually some size/quality cost. |
| **inflation/jpegxl-rs**  | `decoding_speed` field on encoder params      | High    | Direct field — cleanest high-level API among references. Recommended pattern for Tauri. |
| **libvips**              | `tier` option (maps to the same libjxl concept) | Good    | Pragmatic production exposure under a shorter name. |
| **libjxl raw**           | `JXL_ENC_FRAME_SETTING_DECODING_SPEED` via `JxlEncoderFrameSettingsSetOption` | Definitive | Range is 0–4 (0 = default = best decode quality/slowest; 4 = fastest decode). |
| **chafey/libjxl-js**     | Not mentioned                                 | Absent  | Not exposed in the thin binding. |

**Synthesis:** jpegxl-rs gives the nicest high-level shape (`decoding_speed`). cjxl_main.cc gives the battle-tested CLI mapping and help text. Raw constant is the implementation truth.

---

## 3. Recommended API Shape (WASM + Tauri parity)

### TypeScript (facade)

Add to `EncoderOptions`:

```ts
export interface EncoderOptions {
  // ... existing

  /**
   * Decoder speed tier hint (0-4).
   * 0 = default (best quality / slowest decode for given effort)
   * 4 = fastest possible decode (some size/quality tradeoff)
   * 
   * Only affects how the encoder structures the codestream.
   */
  decodingSpeed?: number;   // or decodeSpeedTier for clarity
}
```

Naming recommendation: `decodingSpeed` (matches jpegxl-rs field closely) or `decodeSpeedTier` for readability. `decodingSpeed` is shorter and consistent with the constant.

### Rust (Tauri side)

```rust
pub struct EncodeParams {
    // ...
    pub decoding_speed: Option<u32>,   // 0-4
}
```

Direct field on the params — exactly how jpegxl-rs models it.

---

## 4. WASM Implementation

### bridge.cpp

In `EncodeRgba` and any other encode entry points (after frame settings creation):

```cpp
if (options.decoding_speed >= 0) {
    int v = std::clamp(options.decoding_speed, 0, 4);
    JxlEncoderFrameSettingsSetOption(
        frame_settings,
        JXL_ENC_FRAME_SETTING_DECODING_SPEED,
        v);
}
```

Apply on both one-shot and any multi-frame paths.

### facade.ts

- Forward `decodingSpeed` from JS options into the native call.
- Optional: light JS-side clamping + warning for out-of-range.
- Document clearly that this is an *encode-time* hint only.

No new WASM exports required.

---

## 5. Tauri / Native (Rust)

Use the direct field that jpegxl-rs already provides:

```rust
if let Some(speed) = params.decoding_speed {
    encoder.set_decoding_speed(speed);   // or the exact method name in the crate
    // Fallback to raw frame option escape hatch if no dedicated setter
}
```

This is one of the cleanest features to port because jpegxl-rs already models it as a first-class field.

---

## 6. Benchmark Wiring (Mandatory)

**Recommended location:** `web/jxl-wrapper-lab.js` (same page as Brotli Effort control for grouping "advanced encoder tunings").

**UI:**
- Slider or segmented control: **"Decode speed tier"** 0–4
- Default: 0
- Live description line that updates:
  - 0: Best decode quality (default)
  - 1–2: Balanced
  - 3–4: Fastest decode (larger files or slight quality cost possible)
- On change, re-encode a representative image (preferably one with complex modular content or high resolution).
- Metrics to show: encode time, decode time (via the existing timing harness), final file size, and visual diff if possible.

**Value demonstration:** The benchmark should make the decode-time win obvious. This feature is especially compelling for the progressive gallery / lightbox use cases already in flight.

---

## 7. Testing

- Encode the same source at tiers 0, 2, 4.
- Measure decode time on the WASM side (already instrumented in many tests).
- Expect monotonic improvement in decode speed as tier increases (with possible file size increase).
- Ensure default (0 or omitted) produces bit-identical output to previous behavior.
- Cross-check: the produced JXL must still decode correctly on libjxl reference decoder (roundtrip tests).

---

## 8. Files Expected to Change (Implementation Phase)

**WASM:**
- `packages/jxl-wasm/src/bridge.cpp`
- `packages/jxl-wasm/src/facade.ts`
- `packages/jxl-wasm/test/facade.test.ts`
- `web/jxl-wrapper-lab.js` (or the controls dashboard)

**Rust/Tauri:**
- Encode params struct + wrapper in the native package
- Any Tauri command surface

**Docs & Process:**
- Append to `references/PROGRESS_LOG.md` at completion
- Possibly add a row to any central "JXL encoder options" table in the overview docs

---

## 9. Edge Cases & Gotchas

- Tier 4 can increase file size noticeably on some images; the tradeoff must be visible in the benchmark.
- Interacts with `effort`: high effort + high decoding speed is still useful.
- Does **not** affect progressive vs non-progressive structure (those are separate settings).
- Safe default = 0 (current implicit behavior).
- Range is small (0-4) — validation is trivial.

---

## 10. Rationale

- Named `decodingSpeed` in TS to stay close to jpegxl-rs field name and the libjxl constant.
- Grouped in the same benchmark page as Brotli Effort (both are "aux / codestream structure" tunings that don't change pixel encoding fundamentals).
- WASM first, then Rust — consistent with overall strategy.
- This is one of the highest-UX-impact, lowest-code-risk features remaining.

---

## 11. Implementation Checklist

- [ ] Branch: `feature/decoding-speed-tier`
- [ ] Implement WASM side (bridge + facade + validation)
- [ ] Wire benchmark control + decode-time measurement
- [ ] Add tests (size + decode timing matrix)
- [ ] Port to Tauri/Rust side using jpegxl-rs direct field
- [ ] Cleanup & Handoff block + PROGRESS_LOG entry
- [ ] Update this note with implementation pointers

---

**End of design note.** This is the second in the current sprint batch (after Brotli Effort). Ready for the next.