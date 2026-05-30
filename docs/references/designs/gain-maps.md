# Feature Design Note: Gain Maps (HDR / Tone Mapping Assistance)

**Feature:** JPEG XL Gain Maps (HDR tone mapping assistance metadata, per ISO 21496-1 style or libjxl native gain map support)  
**Date:** 2026-05-28  
**Author:** Grok  
**Status:** Design ready for implementation handoff  
**Related Index Section:** 10. Gain Maps (Additional Features Identified – Audit 2026-05-28)  
**Priority:** Recommended for HDR scientific capture workflows. Builds on the project's existing strong HDR/float pixel support.

---

## 1. Goal & Value

Expose the ability to encode (and later decode) **gain maps** alongside JXL images. Gain maps provide auxiliary data that helps viewers and tone mappers produce better results on HDR or wide-gamut content, especially when the primary image is tone-mapped for SDR displays.

**Why this is important for CasaWASM:**
- The existing pipeline already has excellent HDR foundations: `rgbaf32` support, 16-bit workflows, `LookRenderer` with pre-tonemapped RGB16 buffers, and scientific-grade tone mapping.
- Scientific, medical, and high-end photographic capture increasingly produce HDR data (DNG with floating-point, high-bit-depth sensors, etc.).
- Gain maps are one of the more modern HDR "finishing" features in the JXL ecosystem and are still weakly exposed in most wrappers.
- This is a natural extension of the "feature-maximal" goal and directly addresses the audit item in the REFERENCE_INDEX.
- Pairs extremely well with the existing `apply_look` / tone-mapping infrastructure.

---

## 2. Reference Analysis

Current coverage in the scaffolding is light (as noted in the INDEX audit):

- **REFERENCE_INDEX.md (section 10)** explicitly flags this as an item to add "when relevant for HDR scientific capture."
- **libjxl research** (format_overview.md, changelogs, and HDR-related design docs) — the primary source of truth for how gain maps are represented in the codestream or as auxiliary boxes.
- **cjxl_main.cc** — recommended starting point: search for gain map / HDR related handling and option registration.
- **jpegxl-rs** — will likely surface via raw frame options or dedicated HDR metadata APIs (escape hatch pattern will be needed initially).
- Project context: The CasaWASM stack already supports the pixel formats and tone-mapping state (`LookRenderer`) that make gain map generation and application meaningful.

During implementation, the implementer should pull the latest gain map handling from `cjxl_main.cc` and the libjxl HDR headers/examples.

---

## 3. Recommended API Shape

Gain maps are somewhat orthogonal to classic encoder options. They are often generated from a pair of images (base + HDR master) or from tone-mapping parameters.

### TypeScript (facade)

```ts
export interface GainMapOptions {
  /** The gain map image data (typically lower resolution, single-channel or multi) */
  data: Uint8Array | Uint16Array | Float32Array;

  /** Dimensions of the gain map */
  width: number;
  height: number;

  /** Metadata describing how the gain map should be applied (min/max gain, gamma, etc.) */
  metadata?: {
    minGain?: number;
    maxGain?: number;
    gamma?: number;
    baseHdrHeadroom?: number;
    altHdrHeadroom?: number;
    // Additional fields per libjxl / ISO 21496-1
  };
}

export interface EncoderOptions {
  // ... existing

  /** Attach a gain map for HDR tone-mapping assistance */
  gainMap?: GainMapOptions;

  /** When true, attempt to generate a simple gain map from the tone-mapping state (future enhancement) */
  autoGenerateGainMap?: boolean;
}
```

On the **decode** side, surface gain map presence and data through the existing frame metadata / event system (or a dedicated `gainMap` field on the decoded result).

### Rust (Tauri)

Mirror with a `GainMap` struct. jpegxl-rs (or jpegxl-sys) will determine whether a high-level API or escape hatch is used.

---

## 4. WASM Implementation

### bridge.cpp

- New or extended path to attach gain map data (likely via `JxlEncoderAddBox` for a dedicated gain map box type, or through HDR-specific frame settings).
- If libjxl exposes dedicated gain map APIs (e.g., `JxlEncoderSetGainMap` or similar in recent versions), use them directly.
- Ensure the gain map pixel data is transferred efficiently into WASM memory.

The implementation may live alongside the existing metadata box handling (see `metadata-boxes-container.md`).

### facade.ts

- Accept gain map data + metadata.
- Forward to the bridge.
- On decode, expose any embedded gain map data in a usable form (raw pixels + parsed metadata).

---

## 5. Tauri / Native Side

Follow the same pattern as other advanced HDR/metadata features. Use whatever high-level support jpegxl-rs provides for gain maps / HDR metadata, falling back to the escape hatch.

Because the Tauri side is often used for final archival/export, rich gain map support here will be particularly valuable for scientific users.

---

## 6. Benchmark Wiring (Mandatory)

This is one of the higher-value visual benchmarks possible.

**Recommended:** New or expanded "HDR / Scientific" section in the wrapper lab.

**Demonstrations:**
- Encode an HDR source (float or 16-bit) with and without a gain map.
- Show the base SDR tone-mapped result vs. the gain-map-assisted result (side-by-side or with a viewer that can toggle the gain map).
- Visualize the gain map itself (often a low-res grayscale or multi-channel map).
- Metrics: file size overhead of the gain map, encode/decode cost, and perceptual improvement on HDR displays or in tone-mapping viewers.

Tie this directly to the existing `LookRenderer` and tone-mapping sliders for a compelling "scientific HDR workflow" demo.

---

## 7. Testing

- Roundtrip of images with embedded gain maps (pixel data + metadata fidelity).
- Verify that gain maps survive container vs. raw codestream decisions.
- Test interaction with existing HDR pixel formats (`rgbaf32`).
- Performance: gain maps are usually small, but generation/attachment cost should be measured.
- Decoder correctly reports gain map presence and can return the map data separately if requested.

---

## 8. Files Likely to Change

**WASM:**
- `packages/jxl-wasm/src/bridge.cpp` (new gain map attachment + box or API calls)
- `packages/jxl-wasm/src/facade.ts` (public API + decode exposure)
- `packages/jxl-wasm/test/facade.test.ts`

**Higher level:**
- `web/jxl-wrapper-lab.js` (or new HDR benchmark page)
- Potential small extensions to the decode event/metadata protocol

**Tauri:**
- HDR/metadata encode path

**Cross-links:**
- Update `extra-channel-infrastructure.md` and `metadata-boxes-container.md` if gain maps interact with those systems.
- Reference the existing HDR tone-mapping work in `src/lib.rs` (LookRenderer, etc.).

---

## 9. Edge Cases & Gotchas

- Gain maps are often at a lower resolution than the main image (similar to some thumbnail semantics).
- They are most useful when the primary image has been tone-mapped; the map carries the "difference" information.
- Versioning / compatibility: older JXL decoders should gracefully ignore gain map boxes.
- Generation of the gain map itself can be complex (this note focuses on *transport*; a future helper could auto-generate from Look parameters).

---

## 10. Rationale

- Directly addresses the explicit audit recommendation in the REFERENCE_INDEX.
- Leverages the project's existing world-class HDR / tone-mapping infrastructure (one of the strongest differentiators vs. generic JXL wrappers).
- Keeps the same clean public API + escape hatch philosophy.
- Positions CasaWASM as the go-to library for scientific HDR capture → JXL workflows.

---

## 11. Implementation Checklist

- [ ] Branch: `feature/gain-maps`
- [ ] Pull latest gain map handling from cjxl_main.cc and libjxl HDR docs/headers
- [ ] Implement encode attachment (box or dedicated API)
- [ ] Expose on decode path
- [ ] Public `GainMapOptions` surface in facade
- [ ] HDR / gain map benchmark page (high visual impact)
- [ ] Tests for roundtrip + metadata fidelity
- [ ] Tauri/Rust side
- [ ] Cross-documentation updates (reference existing LookRenderer / HDR work)
- [ ] Full Cleanup & Handoff + PROGRESS_LOG entry

---

**End of design note.**

This is the tenth design note overall. Next up in the remaining list: Patches and Splines (advanced coding tools). Continuing the iteration.