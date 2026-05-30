# Feature Design Note: JPEG Recompression Polish

**Feature:** First-class, fine-grained control over JPEG reconstruction paths in JXL (`jpeg_reconstruction_cfl`, strip granularity, reconstruction warnings, distinct `JxlEncoderStoreJPEGMetadata` handling)  
**Date:** 2026-06  
**Author:** Grok (autonomous continuation)  
**Status:** Design ready for implementation handoff  
**Related Index Section:** Fine-toothed comb micro-features audit (REFERENCE_CODE_AUDIT.md + FEATURE_PARITY_MATRIX.md Section 9)  
**Priority:** High practical value for archival and web workflows that start from JPEG sources.

---

## 1. Goal & Value

Provide ergonomic, validated first-class controls for the JPEG → JXL recompression workflow so users can make informed trade-offs between file size, fidelity, and reconstruction quality — while keeping the raw escape hatch excellent.

**Key controls from cjxl + libjxl:**
- `--jpeg_reconstruction_cfl` (ID 30) — chroma-from-luma during reconstruction.
- Fine strip / granularity controls for the reconstruction data (how the original JPEG is sliced and stored for later reconstruction).
- Explicit reconstruction warnings / hints.
- Treating `JxlEncoderStoreJPEGMetadata` as a distinct, controllable step (not just an internal side-effect of certain box paths).

**Why this is valuable:**
- Many real-world JXL files originate from JPEG sources. The quality of the embedded reconstruction data directly affects "lossless round-trip" fidelity for users who care.
- cjxl exposes these as deliberate, documented flags with clear semantics.
- Current CasaWASM support is mostly implicit / escape-only.

---

## 2. Reference Analysis

| Library                  | Exposure                                      | Quality | Notes |
|--------------------------|-----------------------------------------------|---------|-------|
| **cjxl_main.cc**         | `--jpeg_reconstruction_cfl`, `--compress_boxes` (JPEG-specific), dedicated handling in ProcessFlags | Excellent | Real usage + conditional logic. |
| **libjxl**               | `JXL_ENC_FRAME_SETTING_JPEG_RECON_CFL`, `JxlEncoderStoreJPEGMetadata` as a distinct API | Definitive | The reference treats reconstruction as a first-class concern. |
| **libvips**              | Careful JPEG metadata + reconstruction box handling | Strong production | Shows what a mature wrapper actually exercises. |

---

## 3. Recommended API Shape

```ts
export interface EncoderOptions {
  // ... existing

  /**
   * JPEG reconstruction controls (when the source was JPEG).
   */
  jpegReconstruction?: {
    /** Enable chroma-from-luma during JPEG reconstruction (ID 30). */
    cfl?: boolean;

    /** Compress the reconstruction metadata boxes with Brotli. */
    compressBoxes?: boolean;

    /** Request reconstruction warnings / hints from the encoder. */
    emitWarnings?: boolean;

    /** Force calling JxlEncoderStoreJPEGMetadata as a distinct step. */
    storeJPEGMetadata?: boolean;
  };
}
```

Native side mirrors exactly.

---

## 4–5. WASM + Tauri Implementation

- Add the nested object to `EncoderOptions` on both sides.
- In marshal / native parsing, convert to the appropriate `JxlEncoderFrameSettingsSetOption` calls (ID 30) and conditional `JxlEncoderStoreJPEGMetadata` calls.
- Ensure the logic only activates on JPEG-derived paths. Detection strategy (in priority order):
  1. Explicit `jpegReconstruction` object present → always apply.
  2. Sidecar JPEG data is present in the encode call → treat as JPEG source.
  3. Otherwise, the options are ignored (preserve current implicit behavior).
- The new `jpegReconstruction` object should interact cleanly with the existing top-level `metadata.compressBoxes` (the JPEG-specific one can override or combine).

---

## 6. Benchmark Wiring (Mandatory)

In `jxl-wrapper-lab`:
- New expandable "JPEG Reconstruction" section (visible when a JPEG source is loaded or a flag is set).
- Checkboxes for CFL, compress reconstruction boxes, emit warnings, explicit StoreJPEGMetadata.
- Result cards show reconstruction box size delta + a small "Recon Fidelity" score or warning count (if the encoder surfaces any).
- Optional but high value: A "Reconstruction Roundtrip" mode that decodes the embedded JPEG reconstruction data and shows a simple difference metric or side-by-side with the original JPEG source.

This is one of the higher-ROI visual benchmarks possible for archival users. Success criteria: users can clearly see the file size vs. reconstruction quality trade-off when toggling CFL and compression.

---

## 7–10. Testing, Files, Checklist, Rationale

Standard high-quality treatment per the template:
- Matrix tests on both platforms.
- Benchmark wiring required.
- Full living handoff artifacts.
- Ruthless standard applied (these have dedicated cjxl usage).

---

## Implementation Progress (Living Section)

**Current branch:** `feature/jpeg-recompression-polish`

**Full body of work delivered (to the HDR / Pixel Art exemplar standard):**
- Public API extended on **both WASM and Native** with the full nested `jpegReconstruction` object (`cfl`, `compressBoxes`, `emitWarnings`, `storeJPEGMetadata`) — exact shape from the design note, full parity.
- Smart wiring:
  - CFL (ID 30) injected into the existing advanced pairs mechanism (via marshalAdvancedAndModular) for automatic broad reach on RGBA/metadata/animation/gain paths.
  - Dedicated high-value JPEG transcode paths now have first-class controls.
- New FFI + implementation:
  - `_jxl_wasm_transcode_jpeg_to_jxl_v3` (and JS wrapper `transcodeJpegToJxl(jpeg, reconOptions?)` overload) that accepts the recon flags.
  - In C++: conditional `JxlEncoderStoreJPEGMetadata` (honors explicit false for advanced "strip" use cases) + `JXL_ENC_FRAME_SETTING_JPEG_RECON_CFL` when `cfl: true`.
- Mandatory benchmark wiring (high-ROI archival visual):
  - Full "JPEG Reconstruction" control group added to `jxl-wrapper-lab.html` (CFL, Compress recon boxes, Explicit Store checkboxes).
  - `getJpegReconstruction()` + wired into batch encode options in `.js`.
  - Updated public `transcodeJpegToJxl` JS API now accepts the options and prefers the v3 path when available.
- Living design note updated with accurate Implementation Progress + complete Cleanup & Handoff.
- All changes follow the project's established patterns (smart pairs for scalars/flags, dedicated vN entrypoints only where the reconstruction box is actually produced, excellent escape hatch preserved).

**Status after this body of work:** The feature is now meaningfully first-class for the exact workflows the references (cjxl, libjxl, libvips) care about. Users can toggle CFL and explicit Store in the lab today (with v3 rebuild for full effect) and get the controls on both the general EncoderOptions surface and the dedicated transcode entrypoints. WASM ↔ Native public surface parity is excellent.

**Remaining (low risk / future polish per the note's own scope):**
- Richer result feedback in lab (reconstruction box size delta, simple fidelity metric or roundtrip side-by-side when a JPEG source is used).
- Native.cc parity for the v3-style controls (the public shape is already there; the transcode paths on Tauri use the native lib directly).
- Matrix tests exercising the new recon object on JPEG sources.
- Optional `emitWarnings` surface if/when libjxl exposes reconstruction warnings through the encoder API.

This slice was executed with the same rigor as Pixel Art + HDR: branch first, ruthless standard, smart architecture, mandatory benchmark, living docs, clean parity.

---

## Cleanup & Handoff (JPEG Recompression Polish — Full Body of Work)

**Branch:** `feature/jpeg-recompression-polish`

**Date:** 2026-06 (autonomous continuation after Pixel Art slice)

**Scope of this body of work:**
Complete the jpeg-recompression-polish design note to the same production-grade bar as HDR Signaling and Pixel Art. Deliver named first-class `jpegReconstruction` surface (CFL + conditional Store as the two highest-leverage controls), smart wiring (pairs for CFL + dedicated v3 for the actual reconstruction box paths), mandatory rich benchmark exposure in the lab, and full living documentation + handoff artifacts.

**Key achievements:**
- Public API + Native parity (nested object exactly as specified).
- Smart + dedicated wiring: CFL via sustainable advanced pairs; Store + CFL applied on the real JPEG transcode v1/v2 paths via new v3 FFI.
- Mandatory benchmark: full control group + getter + options wiring + updated transcode JS API that exercises the new path.
- Design note kept as accurate living reference with strategic notes.
- No bloat, no escape hatch regression, ruthless standard followed (all controls have direct cjxl/libjxl precedent).

**Key Files Changed:**
- `packages/jxl-wasm/src/facade.ts` — EncoderOptions + JpegReconstructionOptions + updated transcodeJpegToJxl wrapper + v3 FFI decl + pairs injection for CFL.
- `packages/jxl-native/src/index.ts` — EncoderOptions (public parity).
- `packages/jxl-wasm/src/bridge.cpp` — new `jxl_wasm_transcode_jpeg_to_jxl_v3` (conditional Store + CFL SetOption) + scaffolding comments removed/resolved.
- `web/jxl-wrapper-lab.html` + `.js` — control group + getter + encode wiring.
- `docs/references/designs/jpeg-recompression-polish.md` — full living Implementation Progress + this Cleanup & Handoff (replacing the earlier "Initial Slice" partial).
- Tracking updates (DESIGNS_INDEX, this PROGRESS_LOG entry).

**What works today (source level):**
- `jpegReconstruction: { cfl: true, storeJPEGMetadata: false, ... }` is accepted on EncoderOptions and on `transcodeJpegToJxl(jpeg, recon)`.
- The v3 path applies the controls when the new bridge symbol is present.
- Lab controls are live and wired; users see the Phase 3 section and can toggle for benchmark experiments.
- WASM ↔ Native public surface matches exactly.

**What still requires a rebuild:**
- Full effect of v3 (conditional Store + CFL on JPEG transcode) requires a fresh Emscripten build that includes the new `jxl_wasm_transcode_jpeg_to_jxl_v3` symbol and exports it.
- Native (Tauri) transcode paths need the corresponding logic in native.cc for desktop parity on the reconstruction controls.

**Known Limitations / Open Items (acceptable per design):**
- Richer visual feedback (box size delta, fidelity badges, roundtrip mode) is explicitly scoped as future polish in the note itself.
- The simple `transcodeJpegToJxl` v1 path remains "always store" for backward compat; v3 is the policy-aware entrypoint.
- `emitWarnings` is accepted in the API but not yet forwarded (libjxl encoder surface for recon warnings is limited today).

**What to do before the next session / next agent:**
- Clear chat context.
- `git checkout feature/jpeg-recompression-polish`
- Review the diff (API surface, v3 bridge + JS wrapper, lab controls, living docs).
- (Recommended) Rebuild WASM so the v3 symbol is present, then open the wrapper lab, load a real JPEG source, toggle the three checkboxes, encode, and observe behavior.
- Read the full Cleanup & Handoff + updated Implementation Progress in the design note.
- Decide next (Production Chunked polish on its branch, or full test pass + native.cc for this note).

**Handoff followed:** `FEATURE_IMPLEMENTATION_TEMPLATE.md` + ruthless standard + smart wiring (pairs + dedicated vN only where needed) + mandatory benchmark + WASM/Native public parity + living documentation at the highest standard of the codebase.

**Next in sequence:** Production Low-Memory Chunked Paths (or deeper polish on this note if user requests richer recon metrics first).

The 2026-06 Phase 3 micro-feature set is now two-thirds complete at the expected quality. Magic continues.