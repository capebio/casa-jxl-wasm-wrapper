# JPEG XL Feature Design Notes — Index & Status

**Location:** `docs/references/designs/`  
**Purpose:** This is the master index for all per-feature design proposals produced under the hybrid Grok-synthesis workflow.  
**Last Updated:** 2026-06 (Phase 3 micro-features completion)  
**Total Notes:** 15 (11 core + 4 Phase 3 fine-toothed-comb)

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

## 2026-06 Medium / Follow-up Design Notes (Completion of Next Features Handoff)

| Note | File | Related | Key Focus | Status |
|------|------|---------|-----------|--------|
| Additional HDR Signaling | `additional-hdr-signaling.md` | Medium follow-up | Mastering Display Color Volume + CLLI | Design complete (2026-06) |
| JUMBF Box Support | `jumbf-box-support.md` | Medium follow-up | First-class JUMBF embedding (C2PA etc.) via pure-TS sugar over custom boxes | Implemented on branch `feature/jumbf-box-support` (exemplar: zero-FFI, rich lab demo with sample stub, full living handoff) |
| Granular per-Extra-Channel Modular Settings | `granular-extra-channel-modular.md` | Medium follow-up | Per-channel Modular controls for extra channels | Interface + lab scaffolding + test on `feature/granular-extra-channel-modular` (future-proof surface + honest libjxl scoping; deeper per-EC application future slice) |
| Animation Decode Enhancements | `animation-decode-enhancements.md` | Medium follow-up | Frame-accurate seeking + richer per-frame metadata on decode | Design complete (2026-06) |
| Remaining Low-Level Frame Settings | `remaining-frame-settings.md` | Catch-all | Final stragglers from cjxl | Design complete (2026-06) — completeness record |

All Medium / Follow-up items from the 2026-05-28 Next Features Handoff now have design notes.

---

## 2026-06 Phase 3 Micro-Features (Fine-Toothed Comb Continuation)

All four notes completed to full exemplar standard on dedicated branches (see individual design notes for living Implementation Progress + Cleanup & Handoff blocks; HDR was the reference standard):

- `hdr-signaling-color-priority.md` — intensityTarget / premultiply / preferCICPForHDR (smart pairs + universal helper, rich badges, full parity + test).
- `jpeg-recompression-polish.md` — jpegReconstruction (CFL ID 30 via pairs + v3 conditional Store transcode, lab control group).
- `pixel-art-downsampling.md` — upsamplingMode (0=nearest) + alreadyDownsampled (pairs IDs 55/56, pixel-art-specific lab wiring).
- `production-chunked-paths.md` — lowMemoryMode + preferChunkedAPI inside buffering (ID 34 promotion, Simulate 8K educational section). Implemented on `feature/production-chunked-paths` (full body + living handoff 2026-06).

**Single source of truth for parity + exposure:** `docs/FEATURE_PARITY_MATRIX.md` §9 (new dedicated table with all four ✅ + wrapper-lab details).

See `HANDOFF_Continuing_Phase3_MicroFeatures_2026-06.md` (now marked complete) and `PROGRESS_LOG.md` for the full log + rationale.

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