# Feature Design Note: Metadata Boxes & Container Decisions

**Feature:** Full control over JXL container vs raw codestream, which metadata boxes to include/strip/compress, JPEG reconstruction boxes, and box-level Brotli compression.  
**Date:** 2026-05-28  
**Author:** Grok  
**Status:** Design ready for implementation handoff  
**Related Index Section:** 9. Metadata Boxes + Brotli Compression  
**Priority:** Important for production fidelity (EXIF/XMP/ICC preservation, JPEG reconstruction, container size).

---

## 1. Goal & Value

Give callers precise control over the container format and the rich box ecosystem that travels with a JXL codestream.

**Why this matters for a feature-maximal wrapper:**
- Most real-world JXL usage wants the container (`.jxl` files) so that EXIF, XMP, ICC, JUMBF, and JPEG reconstruction data can travel with the image.
- JPEG reconstruction boxes are one of JXL's killer features for near-lossless migration of existing JPEG archives.
- Box compression (Brotli) was partially addressed in the Brotli Effort note; this note completes the picture with *which* boxes exist and how they are managed.
- Scientific and archival workflows care deeply about metadata fidelity and container decisions.
- cjxl_main.cc has the most extensive real-world handling of these options.

---

## 2. Reference Analysis

- **cjxl_main.cc** — by far the richest reference. Extensive logic around `--container`, `--compress_boxes`, metadata stripping, JPEG reconstruction (`--jpeg_reconstruction`), box compression, etc.
- **inflation/jpegxl-rs** — `add_metadata` with compress flag + container control.
- **libvips** — pragmatic production choices about what boxes to preserve.
- **libjxl raw** — `JxlEncoderUseContainer`, `JxlEncoderAddBox`, `JxlEncoderSetICCProfile`, `JxlEncoderAddJPEGReconstructionBox`, etc.

The pattern is clear: give high-level convenience for the common cases (preserve EXIF/XMP/ICC, optional JPEG recon) while providing an escape hatch for power users who want to add arbitrary boxes or strip everything.

---

## 3. Recommended API Shape

### TypeScript

```ts
export interface MetadataOptions {
  /** Include ICC profile (default true when present in source) */
  includeICC?: boolean;

  /** Include EXIF (default true) */
  includeExif?: boolean;

  /** Include XMP (default true) */
  includeXMP?: boolean;

  /** Include JUMBF (default false for now) */
  includeJUMBF?: boolean;

  /** Create JPEG reconstruction box when input was JPEG (very powerful) */
  jpegReconstruction?: boolean;

  /** Compress non-pixel boxes with Brotli (see Brotli Effort note for the effort level) */
  compressBoxes?: boolean;

  /** Force container format even for raw codestream scenarios */
  forceContainer?: boolean;

  /** Raw codestream only (no container/boxes at all) */
  rawCodestream?: boolean;
}

export interface EncoderOptions {
  // ...
  metadata?: MetadataOptions;

  /** For advanced users: add completely custom boxes */
  customBoxes?: Array<{
    type: string;          // 4-byte box type
    data: Uint8Array;
    compress?: boolean;
  }>;
}
```

### Rust

Similar structure. jpegxl-rs already has good `add_metadata` + container helpers; expose them cleanly and add the reconstruction and custom box paths.

---

## 4. WASM Implementation

### bridge.cpp

- `JxlEncoderUseContainer`
- `JxlEncoderSetICCProfile`
- `JxlEncoderAddBox` for Exif (`Exif` box with TIFF header prefix), XMP (`xml `), etc.
- `JxlEncoderAddJPEGReconstructionBox` when the feature is requested and source data is available.
- Respect `compressBoxes` + the Brotli effort setting from the earlier note.

The existing `EncodeRgba` path already receives (but currently ignores) `iccProfile`, `exif`, `xmp` fields in `EncoderOptions`. This note finally wires them.

### facade.ts

- Surface the rich `metadata` bag.
- Accept raw ICC / EXIF / XMP blobs from the caller (or extract them from input if we add that capability later).
- For JPEG reconstruction, the caller must supply the original JPEG bytes.

---

## 5. Tauri Side

jpegxl-rs has solid metadata helpers. The native implementation should be relatively straightforward once the WASM reference behavior is locked.

---

## 6. Benchmark Wiring

Add a "Metadata Fidelity" section in the wrapper lab:

- Controls for the various `include*` and `jpegReconstruction` toggles.
- Upload a JPEG with rich EXIF/XMP → encode with/without reconstruction box.
- Show resulting file size + ability to roundtrip back to near-original JPEG.
- Display extracted metadata after decode (EXIF dump, XMP, etc.).

JPEG reconstruction is one of the most impressive JXL demos possible.

---

## 7. Testing

- Roundtrip preservation of ICC, EXIF, XMP.
- JPEG reconstruction fidelity (size and visual quality of the reconstructed JPEG).
- Container vs raw codestream output when requested.
- Box compression impact (combined with Brotli Effort setting).
- Stripping behavior (e.g., `includeExif: false`).

---

## 8. Files

- `packages/jxl-wasm/src/bridge.cpp` (the biggest change — finally wiring the metadata fields that have been present but ignored)
- `packages/jxl-wasm/src/facade.ts`
- `packages/jxl-wasm/test/facade.test.ts`
- Benchmark / lab pages
- Tauri side

**Note:** This is one of the higher-ROI "finish the job" features because the facade already declares the fields.

---

## 9. Rationale

- Completes the work started in the Brotli Effort note (box compression) and the ignored metadata fields in the current bridge.
- Prioritizes the most common real-world needs (ICC/EXIF/XMP + JPEG recon) while providing an escape hatch for custom boxes.
- Makes the "feature-maximal" claim credible for archival and production use.

---

## 10. Implementation Checklist

- [ ] Branch: `feature/metadata-boxes-container`
- [ ] Wire the long-ignored `iccProfile` / `exif` / `xmp` paths in bridge.cpp
- [ ] Full `MetadataOptions` surface + custom boxes
- [ ] JPEG reconstruction box support
- [ ] Container vs raw control
- [ ] Rich metadata benchmark (especially JPEG recon demo)
- [ ] Tauri parity
- [ ] Update any earlier notes that referenced "metadata ignored for now"
- [ ] Full handoff + PROGRESS_LOG

---

**End of design note.**

This is the ninth design note produced in the current iteration. 

Next candidates: Gain Maps (HDR), Patches & Splines, or any remaining items from the REFERENCE_INDEX audit.

Continuing the iteration unless directed otherwise.