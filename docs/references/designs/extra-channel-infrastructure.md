# Feature Design Note: Full Extra Channel Infrastructure (Phase 2)

**Feature:** Complete `JxlExtraChannelInfo` support — all extra channel types, custom names, arbitrary bit depths, spot colors, depth/selection/thermal channels, and rich per-channel metadata.  
**Date:** 2026-05-28  
**Author:** Grok  
**Status:** Design ready for implementation handoff (builds directly on the Phase 1 "basic extra-channel distance" note)  
**Related:** `designs/extra-channel-distance.md` (Phase 1 foundation)  
**Priority:** Listed in HANDOFF as "Full extra channel infrastructure" — the logical completion of the high-leverage basic distance work.

---

## 1. Goal & Value

Move from the minimal viable extra-channel support (alpha + per-channel distance) to a production-grade, fully expressive extra channel system that matches or exceeds what serious users of libjxl (scientific imaging, VFX, medical, HDR pipelines, false-color data) actually need.

**Why this completes the priority:**
- Phase 1 gave us the highest-ROI 80% case (alpha distance).
- Full infrastructure unlocks the long tail: multiple extra channels of different types, custom naming, high bit-depth extra data, spot colors, depth maps, selection masks, thermal channels, etc.
- This is what separates a "feature-maximal" wrapper from a thin one.
- libvips already demonstrates strong multi-band → typed extra channel mapping in production; we should aim for comparable (or better) ergonomics on the CasaWASM side.

---

## 2. Reference Analysis

**Primary references (same as Phase 1, now used more deeply):**

- **libjxl raw ExtraChannel API** (`JxlExtraChannelInfo`, `JxlEncoderSetExtraChannelInfo`, `JxlEncoderSetExtraChannelDistance`, `JxlExtraChannelType` enum, etc.) — the definitive surface.
- **libvips** (`jxlsave.c` / `jxlload.c`) — best production model for mapping arbitrary multi-band images to typed extra channels with names and properties.
- **cjxl_main.cc** — real CLI usage of alpha + other extra channel options and distance.
- **jpegxl-rs** — how a modern high-level Rust wrapper models `ExtraChannelInfo` + `PixelFormat` extensions.
- **chafey** — minimal baseline we want to exceed.

The key expansion in Phase 2 is moving from a simple distance + basic type to the full `JxlExtraChannelInfo` struct (type, bits_per_sample, dim_shift, name, optional color info for spots, etc.).

---

## 3. Recommended API Shape (Phase 2)

This note assumes Phase 1 (`extraChannels[]` + `alphaDistance`) has landed. Phase 2 enriches the `ExtraChannel` descriptor.

### TypeScript

```ts
export type ExtraChannelType =
  | 'alpha'
  | 'depth'
  | 'selection'
  | 'spot'           // with optional spot color info
  | 'thermal'
  | 'reserved0' | 'reserved1' | 'reserved2' | 'reserved3' | 'reserved4' | 'reserved5' | 'reserved6' | 'reserved7'
  | 'unknown';

export interface SpotColorInfo {
  red: number;
  green: number;
  blue: number;
  solidity: number;   // 0.0–1.0
}

export interface ExtraChannel {
  type: ExtraChannelType;
  bitsPerSample: number;
  /** Optional. Used for certain channel types. */
  dimShift?: number;
  /** Human-readable or ICC-aware name. Recommended for all non-alpha channels. */
  name?: string;

  /** Per-channel distance (Phase 1). */
  distance?: number;

  /** Only used when type === 'spot' */
  spotColor?: SpotColorInfo;

  /** Optional: custom resampling factor for this channel (see resampling design note) */
  resampling?: 1 | 2 | 4 | 8;
}

export interface EncoderOptions {
  // ...
  extraChannels?: ExtraChannel[];
  alphaDistance?: number;   // convenience (Phase 1)
}
```

On the decode side we will eventually want symmetric `ExtraChannel` metadata in the decoded frame info.

### Rust (Tauri)

Mirror using jpegxl-rs types where they exist (`jpegxl_rs::encode::ExtraChannelInfo` or the raw `JxlExtraChannelInfo` via the sys crate). Provide a rich `ExtraChannel` struct in the high-level wrapper.

---

## 4. Implementation Scope & Phasing

**Phase 2a (recommended first slice of this note):**
- Full `ExtraChannelType` enum surface
- `name` support for all channels
- `bitsPerSample` + `dimShift`
- Spot color info
- All per-channel distance + resampling already designed in prior notes

**Phase 2b:**
- Decoder-side exposure of the full extra channel metadata (currently the bigger gap on the read path)
- Custom modular settings per extra channel (advanced)
- Richer error / validation around bit depth vs declared type

---

## 5. WASM + Bridge Considerations

This is the most data-layout-heavy change in the entire current batch of notes.

- The encode path must accept a variable number of extra channel planes, each with potentially different bit depths and types.
- `bridge.cpp` will need a more general encode entry point (or a descriptor + array-of-views approach) rather than the current RGBA-centric signatures.
- Memory management and zero-copy transfer of extra channel data from JS becomes more complex when bit depths are not 8-bit.
- On the decode side, the facade and events will need to surface the extra channel descriptors + pixel data.

This is the feature most likely to benefit from a small "codec session" or "encode request" builder object instead of ever-growing parameter lists.

---

## 6. Benchmark & Demonstration

A dedicated "Extra Channels Lab" page (or major expansion of the wrapper lab) is warranted.

**Must demonstrate:**
- RGB + alpha (different distance)
- RGB + depth map (16-bit)
- RGB + multiple spot colors with names and solidity
- False-color / thermal + selection mask
- Visual inspection tools for individual channels (false-color overlays, histograms, etc.)

This becomes one of the strongest differentiators vs other JXL wrappers.

---

## 7. Testing Strategy

- Roundtrips for every supported `ExtraChannelType` at various bit depths.
- Name roundtripping (especially non-ASCII / long names).
- Spot color metadata preservation.
- Mixed bit-depth extra channels in a single image.
- Performance with many extra channels (scientific use case).
- Decoder must correctly report the full `ExtraChannel` descriptors.

---

## 8. Files & Risk

**Higher complexity than previous notes:**
- `packages/jxl-wasm/src/bridge.cpp` (generalized encode + full ExtraChannelInfo handling)
- `packages/jxl-wasm/src/facade.ts` (rich descriptor types + multi-plane data passing)
- Decode path (facade + events) for symmetry
- Significant benchmark / lab UI work
- Tauri side will be easier if jpegxl-rs already has good modeling

**Recommendation:** Treat this as a multi-PR effort even within the WASM side.

---

## 9. Rationale

- Explicitly builds on the Phase 1 note so implementers have a clear migration path.
- Prioritizes the parts that deliver the "full infrastructure" feeling (types + names + spot colors) over the absolute longest tail.
- Calls out the data-layout and decode-side symmetry challenges early.
- Keeps consistency with the escape-hatch + clean public API pattern used throughout this design batch.

---

## 10. Implementation Checklist

- [x] Branch: `feature/full-extra-channel-infrastructure`
- [x] Enrich the `ExtraChannel` type with full `ExtraChannelType` + spot + name + dimShift
- [x] Generalized encode path in bridge.cpp that can handle the richer descriptors (72B WasmExtraChannel)
- [x] Decoder-side extra channel metadata exposure (important for roundtrip completeness)
- [x] Substantial Extra Channels Lab benchmark page (wired in Task 6)
- [x] Comprehensive type + bit-depth matrix tests
- [x] Tauri/Rust side (jxl-native parity)
- [x] Update the earlier `extra-channel-distance.md` note with "Phase 1 complete, see this note for Phase 2"
- [x] Full handoff + PROGRESS_LOG

---

## 11. Implementation Notes

**Deviations from design:**
- 72B descriptor chosen (vs original 56B estimate) for clean packing of spot + dim + name (no overlap); verified sizeof in C++ + TS DataView.
- Decoder extraPlanes delivered only on progressive "final" + some progress stages (not every flush for ECs in initial impl; matches main pixel behavior).
- No high-level Encoder.addExtraPlane sugar yet (low-level + synthetic in lab only; per "Phase 2 complete" scope).
- Reserved channels mapped to reserved0–7 + unknown; full 16+ JXL enum not exhaustively enumerated beyond forward-compat slots.

**Benchmark screenshots description (Task 6):** The Extra Channels panel in jxl-wrapper-lab includes dynamic rows for all 5+ types, spot color pickers + solidity sliders, synthetic plane generators (depth ramps, thermal noise, selection checker, spot solids), and post-decode Channel Inspector grid (small canvases + min/max/hist readouts per EC). Visual verification performed for alpha+spot, depth16, mixed, named thermal cases. Roundtrip descriptor logs emitted to console.

**Decisions made:**
- Full symmetry on DecodedExtraChannel (readonly, omits encode-only fields) for header/final + events.
- TDD: failing matrix + roundtrip tests written early; bridge symbols guarded in tests.
- Native parity via mirror structs + type maps (no shared 72B; semantic only).
- dimShift supported in descriptor/encode but default 0 in most lab/UI paths.
- All prior Tasks 2-6 approved before this final slice.

---

**End of design note.**

This is the seventh note overall. Next in the queue: Animation / Multi-Frame. Continuing.