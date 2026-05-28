# Feature Design Note: Extra Channel Distance & Basic Infrastructure

**Feature:** Per-extra-channel distance (`alpha_distance` and the general extra channel distance mechanism) + foundational extra channel declaration support  
**Date:** 2026-05-28  
**Author:** Grok  
**Status:** Design ready for implementation handoff  
**Related Index Section:** 4. Extra Channels  
**Priority:** Explicitly paired with Brotli Effort in the HANDOFF sprint list ("Brotli Effort + basic extra-channel distance"). Foundation for the larger "Full extra channel infrastructure" goal.

---

## 1. Goal & Value

Enable callers to set **per-extra-channel distance** (especially alpha) and provide the basic infrastructure for declaring and encoding extra channels beyond the main color channels.

This is the second half of one of the highest-leverage paired items in the current sprint.

**Why it matters:**
- Alpha channel is the most common extra channel. Being able to tune its compression separately from the color data is extremely valuable (lossless alpha + lossy color is a common request).
- Scientific workflows frequently use additional channels (masks, depth, false-color data, segmentation, etc.).
- The current CasaWASM implementation is weak here compared to the rest of the stack.
- cjxl_main.cc has good real usage of `alpha_distance` and related flags.
- libvips has strong production-grade multi-band → extra channel mapping as a reference.

---

## 2. Reference Analysis

| Library                  | Exposure                                                                 | Quality | Notes |
|--------------------------|--------------------------------------------------------------------------|---------|-------|
| **cjxl_main.cc** (primary) | `--alpha_distance`, handling of extra channel options and per-channel distance in the CLI. Good example of how to expose the concept. | Strong | Best current reference for the "distance per extra channel" UX. |
| **libvips**              | Excellent multi-band mapping in jxlsave.c / jxlload.c. Production battle-testing of extra channel handling. | Excellent | The strongest real-world model for how a high-level wrapper should expose extra channels. |
| **inflation/jpegxl-rs**  | Via `PixelFormat` + metadata / extra channel descriptors                 | Good    | Clean Rust modeling of extra channels. |
| **chafey/libjxl-js**     | Basic via `componentCount`                                               | Weak    | Very limited. |
| **libjxl raw**           | Full ExtraChannel API (`JxlExtraChannelInfo`, `JxlEncoderSetExtraChannelInfo`, `JxlEncoderSetExtraChannelDistance`, etc.) | Definitive | The complete low-level surface. |

**Important observation:** "Extra channels" is not a single frame setting. It involves:
- Declaring the channels (type, bit depth, name, etc.)
- Setting per-channel distance
- Supplying the actual pixel data for those channels during encode

The "basic extra-channel distance" priority is the highest-ROI slice of this larger surface.

---

## 3. Recommended Scope for First Pass

**Phase 1 (this note – "Basic")**
- Support for alpha as a first-class extra channel (most common case).
- Ability to set `alphaDistance` (or general `extraChannelDistances`).
- Simple declaration of a small number of extra channels (type + bits).
- Ability to pass extra channel pixel data alongside main image data.

**Phase 2 (later)**
- Full `JxlExtraChannelInfo` surface (custom names, spot colors, depth, thermal, etc.).
- Per-channel modular predictor / group size overrides.
- Richer metadata on extra channels.

This keeps the first deliverable focused while still satisfying the explicit sprint pairing with Brotli Effort.

---

## 4. Recommended API Shape

### TypeScript

```ts
export interface ExtraChannel {
  type: 'alpha' | 'depth' | 'spot' | 'selection' | 'other';
  bitsPerSample: number;
  /** Optional name / description */
  name?: string;
  /** Per-channel distance (quality). Omit to inherit from main distance. */
  distance?: number;
}

export interface EncoderOptions {
  // ... existing

  /** Extra channels (alpha is the most common). */
  extraChannels?: ExtraChannel[];

  /** Convenience: distance specifically for the alpha channel (if present). */
  alphaDistance?: number;
}
```

When `extraChannels` is supplied, the encode call must also accept the corresponding pixel data (either as additional planes in a multi-plane buffer or as a separate parameter).

### Rust (Tauri)

Similar structure using jpegxl-rs's `ExtraChannelInfo` types where possible, with escape hatches for distance.

---

## 5. WASM Implementation Considerations

This is one of the more invasive changes among the current batch because it touches data layout:

- `bridge.cpp` will need new or extended encode entry points that accept extra channel planes.
- The existing `EncodeRgba` path may grow an `EncodeRgbaWithExtraChannels` sibling or a more general `Encode` that takes a descriptor + planes.
- `JxlEncoderSetExtraChannelInfo` and `JxlEncoderSetExtraChannelDistance` calls must be made before adding image frames.
- Zero-copy / memory views from WASM heap into the extra channel data.

The facade will need corresponding TypeScript changes to accept and marshal the extra data.

This is the note most likely to require some API evolution discussion before implementation begins.

---

## 6. Benchmark Wiring

**Location:** `jxl-wrapper-lab.js` or a dedicated "Alpha & Extra Channels" benchmark page.

**What to demonstrate:**
- Encode with alpha at different `alphaDistance` values while keeping main image distance fixed.
- Show file size impact and visual quality of the alpha channel (use a checkerboard or mask overlay visualization).
- Basic multi-extra-channel example (e.g., RGB + alpha + depth or selection mask).

This is highly visual and will be one of the most compelling demos once working.

---

## 7. Testing

- Roundtrip with alpha at various distances (lossless alpha + lossy color is a key test case).
- Extra channel data must survive encode/decode with correct bit depth and values.
- Default behavior (no extra channels declared) must be unchanged.
- Cross-check against libvips behavior where possible for the multi-band case.

---

## 8. Files & Risk Areas

**Higher risk / more work than previous notes:**
- `packages/jxl-wasm/src/bridge.cpp` (new or extended encode paths + ExtraChannelInfo handling)
- `packages/jxl-wasm/src/facade.ts` (data layout for extra planes)
- Benchmark page (needs good extra-channel test images)
- Potential small public API adjustment

**Rust side:** Will benefit from jpegxl-rs's existing extra channel modeling.

---

## 9. Rationale

- Scoped to "basic" (alpha + per-channel distance + minimal declaration) to deliver the explicit sprint item without boiling the ocean.
- Nested `extraChannels` array chosen for extensibility.
- `alphaDistance` convenience field kept for the 80% case (most people only care about alpha tuning).
- libvips is the strongest reference for the long-term "how should a high-level wrapper feel" direction.

---

## 10. Implementation Checklist

- [ ] Branch: `feature/extra-channel-distance` (or `feature/extra-channels-basic`)
- [ ] Decide on final data-passing shape for extra planes (multi-plane buffer vs separate args)
- [ ] Implement declaration + distance setting in bridge
- [ ] Wire alpha convenience path
- [ ] Build compelling benchmark with visual alpha inspection
- [ ] Tests (especially lossless-alpha + lossy-color)
- [ ] Tauri side
- [ ] Full handoff + PROGRESS_LOG

---

**End of design note.**

This completes the explicit "Brotli Effort + basic extra-channel distance" priority pair from the HANDOFF.

Next logical items (still high priority):
- Full extra channel infrastructure (Phase 2 of the above)
- Resampling controls
- Animation / multi-frame
- Gain maps, patches, etc.

I will continue the iteration with the next one unless you give different direction.