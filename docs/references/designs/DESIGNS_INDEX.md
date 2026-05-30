# JPEG XL Feature Design Notes — Index & Status

**Location:** `docs/references/designs/`  
**Purpose:** This is the master index for all per-feature design proposals produced under the hybrid Grok-synthesis workflow.  
**Last Updated:** 2026-05-28  
**Total Notes:** 11

Each note follows the process described in `FEATURE_IMPLEMENTATION_TEMPLATE.md` and is the primary technical reference when an implementing agent begins work on that feature.

---

## How to Use This Index

1. Identify the feature from the sprint list, HANDOFF, or `REFERENCE_INDEX.md`.
2. Open the corresponding design note.
3. Follow the implementation checklist at the bottom of the note + the full TEMPLATE (branching, benchmark wiring, tests, Cleanup & Handoff block, PROGRESS_LOG entry).
4. For current blockers or broader unfinished business (including the "Next Batch" items that still lack design notes), see `ISSUES.md` (the Issue Entry Specification at the top of that file defines the required context for any agent to jump in).
4. Update this index and the relevant section of `REFERENCE_INDEX.md` when the feature is implemented.

---

## Design Notes by Priority / Category

### Core High-Leverage Encoder Controls (Highest Sprint Priority)

| Note | File | Related INDEX Section | Key Focus | Status |
|------|------|-----------------------|-----------|--------|
| First-Class Advanced Encoder Controls | `first-class-advanced-encoder-controls.md` | June 2026 deep audit (REFERENCE_CODE_AUDIT.md Master Gap List) | GROUP_ORDER + centers (validation), DOTS/PATCHES/EPF/GABORISH, BUFFERING modes + streaming tradeoffs, DISABLE_PERCEPTUAL_HEURISTICS, expert gating, convenience bundles. Nested `advancedControls` + permanent documented `advancedFrameSettings` escape hatch. | Design complete (post-audit handoff) |
| Brotli Effort | `brotli-effort.md` | 7. Brotli Effort | Single integer (0-11), default 9, aux data compression | Implemented on branch `epiccodereview/20260527T054853` |
| Decoding Speed Tier | `decoding-speed-tier.md` | 6. Decoding Speed Tier | 0-4 tiers for faster decode | Implemented on branch `epiccodereview/20260527T054853` |
| Photon Noise | `photon-noise.md` | 5. Photon Noise | `--photon_noise_iso` style control | Design complete |
| Core Modular Controls | `core-modular-controls.md` | 3. Modular Mode & Advanced Modular Controls | Nested `modular: {force, groupSize, predictor, nbPrevChannels, palette...}`. Phased recommendation | Design complete |
| Resampling | `resampling.md` | (Paired with Photon Noise) | Main + extra-channel resampling factors (1/2/4/8) | Design complete |

### Extra Channels

| Note | File | Related INDEX Section | Key Focus | Status |
|------|------|-----------------------|-----------|--------|
| Extra Channel Distance (Basic) | `extra-channel-distance.md` | 4. Extra Channels | `alphaDistance` + minimal `extraChannels[]` declaration + per-channel distance | Design complete (Phase 1) |
| Full Extra Channel Infrastructure | `extra-channel-infrastructure.md` | 4. Extra Channels | Complete `ExtraChannelType` enum, names, spot colors, dimShift, bit depths, decoder symmetry | Implemented in commit <see PROGRESS_LOG + final handoff for SHA> (Phase 2 complete; all checklist items done) |

### Animation & Multi-Frame

| Note | File | Related INDEX Section | Key Focus | Status |
|------|------|-----------------------|-----------|--------|
| Animation / Multi-Frame | `animation-multi-frame.md` | 8. Animation / Multi-Frame | Timing, loopCount, per-frame duration/names, progressive-per-frame decode | Implemented on branch `epiccodereview/20260527T054853` (source-only; WASM + native rebuild pending — see ISSUES.md §9) |

### Metadata, Container & Boxes

| Note | File | Related INDEX Section | Key Focus | Status |
|------|------|-----------------------|-----------|--------|
| Metadata Boxes & Container Decisions | `metadata-boxes-container.md` | 9. Metadata Boxes + Brotli Compression<br>12. Container vs Raw Codestream Decisions + Box Handling | `MetadataOptions` (ICC/Exif/XMP), JPEG reconstruction boxes, container vs raw, custom boxes, compressBoxes | Implemented on branch `epiccodereview/20260527T054853` |

### HDR & Advanced / Experimental

| Note | File | Related INDEX Section | Key Focus | Status |
|------|------|-----------------------|-----------|--------|
| Gain Maps (HDR) | `gain-maps.md` | 10. Gain Maps (HDR / Tone Mapping Assistance) | `GainMapOptions` + metadata for HDR tone-mapping assistance. Leverages existing LookRenderer / HDR pipeline | Design complete |
| Patches and Splines | `patches-splines.md` | 11. Patches and Splines (Advanced Coding Tools) | Recommended strong escape hatch (`advancedFrameSettings`) + optional high-level toggles. Explicitly experimental / content-dependent | Design complete |

---

## Coverage of the REFERENCE_INDEX Audit (2026-05-28)

| Audit Item | Covered By | Notes |
|------------|------------|-------|
| 10. Gain Maps | `gain-maps.md` | Full dedicated note |
| 11. Patches and Splines | `patches-splines.md` | Full dedicated note (escape-hatch first) |
| 12. Container vs Raw Codestream + Box Handling | `metadata-boxes-container.md` | Well covered (container, reconstruction boxes, stripping, compression). No separate note needed. |

All items in the 2026-05-28 audit section now have design coverage.

---

## Cross-References & Dependencies

- **Parity tracking**: See the authoritative `docs/FEATURE_PARITY_MATRIX.md` (docs/ root) for the *complete* WASM vs Tauri/Native + Benchmark exposure status of every feature (raw pipeline, JXL controls, scheduling, perf arch, desktop specifics). This is the single source of truth for parity and lab exposure. It was created/extended in the 2026-06 unification pass and supersedes the earlier partial comparison documents.
- Many notes recommend grouping related controls in the same benchmark page (`jxl-wrapper-lab.js` or dedicated tabs).
- **Escape hatch pattern** is recommended consistently for advanced/experimental settings (see `patches-splines.md`, `core-modular-controls.md`, `gain-maps.md`).
- **Benchmark wiring** is mandatory in every note per the TEMPLATE.
- Several notes reference synergy with existing project work:
  - HDR / Gain Maps → existing `LookRenderer` + tone-mapping infrastructure (`src/lib.rs`)
  - Resampling → existing `wasm-resizer-spec.md`
  - Animation → existing progressive decode stack

---

## 2026-06 Phase 3 Micro-Features (Fine-Toothed Comb Continuation)

All four notes now have dedicated branches and exemplar-level implementation (HDR signaling completed earlier; JPEG recompression, Pixel Art, and this Production Chunked note completed in sequence):

- `hdr-signaling-color-priority.md` — full (public API, smart CICP policy threading, ApplyColorEncoding helper, rich "HDR Info" badges, native parity, tests, living docs).
- `jpeg-recompression-polish.md` — (see its own living progress).
- `pixel-art-downsampling.md` — (see its own living progress).
- `production-chunked-paths.md` — **completed on `feature/production-chunked-paths`** (first-class `lowMemoryMode` + `preferChunkedAPI` inside `buffering`, smart ID 34 promotion, full "Low Memory / Large Image" lab section with 8K Simulate + memory delta, native parity, acceptance test, full Cleanup & Handoff + PROGRESS_LOG entry).

See `HANDOFF_Continuing_Phase3_MicroFeatures_2026-06.md` and `PROGRESS_LOG.md` for the full continuation log.

## Next Steps (After Design Phase)

When ready to implement any note:

1. Follow `FEATURE_IMPLEMENTATION_TEMPLATE.md` exactly (mandatory branching, benchmark, cleanup/handoff, PROGRESS_LOG).
2. Update this `DESIGNS_INDEX.md` (change Status to "In Progress" / "Implemented in commit X").
3. Update the corresponding section in `REFERENCE_INDEX.md`.
4. Append a proper entry to `PROGRESS_LOG.md`.

---

## Status Legend

- **Design complete** — Note written and ready for implementation handoff.
- **In Progress** — An agent has started implementation on the feature branch.
- **Implemented** — Feature landed (with link to commit/PR).

---

**End of DESIGNS_INDEX.md**

This document should be kept up to date as the primary navigation aid for the growing collection of design notes.