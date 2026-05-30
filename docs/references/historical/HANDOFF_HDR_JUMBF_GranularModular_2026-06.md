# Handoff: Additional HDR Signaling + JUMBF + Granular Extra-Channel Modular (Notes 1-3)

**Date:** 2026-06  
**Context:** This handoff covers the first three medium/follow-up design notes from the 2026-05-28 Next Features Handoff. The user requested these be grouped separately from notes 4 & 5 (Animation Decode and Remaining Frame Settings) for focused continuation work. All higher-priority items (Phase 3 micro-features, Progressive Encode, Advanced Decoder Controls, and the WASM Build Strategy decision) have already been completed.

---

## Current Reality (Ground Truth)

### Completed Work (Relevant Context)
- All 2026-06 Phase 3 micro-features completed to exemplar standard on dedicated branches.
- Progressive Encode Options design note complete.
- Advanced Decoder Controls & Tuning design note complete.
- WASM Build Strategy: Decision recorded to **stay with Full builds** for the foreseeable future (`wasm-build-strategy.md`).
- Notes 4 & 5 (Animation Decode Enhancements + Remaining Low-Level Frame Settings) have their own dedicated handoff.

### State of These Three Notes

**1. Additional HDR Signaling** (`additional-hdr-signaling.md`)
- Direct continuation of `hdr-signaling-color-priority.md` (intensityTarget, premultiply, preferCICPForHDR).
- Focus: Mastering Display Color Volume (primaries, white point, luminance) + Content Light Level Information (MaxCLL / MaxFALL).
- Important for professional, scientific, and archival HDR masters.
- Builds nicely on existing Gain Maps and HDR pipeline work (`LookRenderer`, etc.).
- Recommended API: Extend HDR options with a `hdrMetadata` object containing `masteringDisplay` and `contentLight`.
- Low-risk implementation (mostly metadata passthrough).

**2. JUMBF Box Support** (`jumbf-box-support.md`)
- Goal: First-class support for embedding and reading JUMBF boxes (primarily for C2PA / content authenticity and archival standards).
- Current project already has solid custom box support (`customBoxes` + v2 metadata paths).
- This is mostly a specialized, ergonomic case of existing box infrastructure.
- Recommended shape: `jumbfBoxes?: readonly JUMBFBox[]` on EncoderOptions, plus decode-side exposure.
- Priority driver: Growing importance of C2PA and structured provenance metadata.

**3. Granular per-Extra-Channel Modular Settings** (`granular-extra-channel-modular.md`)
- Builds on `core-modular-controls.md` and the extra channel infrastructure notes.
- Goal: Allow per-extra-channel Modular parameters (predictor, groupSize, palette, MA tree, etc.) instead of global inheritance.
- Strong value for mixed content (smooth alpha + different depth maps + sparse selection masks).
- Recommended shape: Extend the existing `ExtraChannel` interface with an optional `modular` sub-object.
- Good demo potential in the extra channels lab section.

**Good news:** All three notes are relatively self-contained and have lower implementation surface area than the Phase 3 work. They benefit from the strong foundations already built (HDR signaling, custom boxes, Modular + Extra Channels).

---

## Recommended Order for This Group

Suggested order (high to lower immediate value / natural dependencies):

1. **Additional HDR Signaling** — Builds directly on recent high-quality HDR work. Good continuity and professional user impact.
2. **Granular per-Extra-Channel Modular Settings** — Natural extension of existing Modular + Extra Channel notes. Strong technical fit.
3. **JUMBF Box Support** — More standalone; can be done at any point but has growing real-world relevance (C2PA).

You may reorder based on user priorities or implementation readiness.

---

## Process Reminders (Non-Negotiable)

- Follow `FEATURE_IMPLEMENTATION_TEMPLATE.md` exactly.
- Mandatory benchmark wiring in `jxl-wrapper-lab` (or dedicated pages) for each note.
- Full WASM ↔ Native public API + behavioral parity.
- Living "Implementation Progress" section + complete high-quality **Cleanup & Handoff** block in each design note (use `hdr-signaling-color-priority.md` or advanced encoder controls Phase 1 as the exemplar).
- Update all tracking documents: `DESIGNS_INDEX.md`, `PROGRESS_LOG.md`, this handoff, `Next_Features_Handoff_2026-05-28.md`, and `ISSUES.md`.
- Create dedicated feature branch **before any code changes**.
- Ruthless standard: Only first-class promotion for controls with dedicated, validated usage in cjxl or production references. Keep the raw `advancedFrameSettings` escape hatch excellent.
- We are committed to the **Full build** strategy — do not propose new build variants unless explicitly asked.

---

## Key Files & Context to Review

- The three design notes themselves
- `hdr-signaling-color-priority.md` + `gain-maps.md` (for HDR note)
- `extra-channel-infrastructure.md` + `core-modular-controls.md` (for granular modular note)
- Existing custom box / metadata handling in `facade.ts` and `bridge.cpp` (for JUMBF)
- `web/jxl-wrapper-lab.*` (benchmark wiring opportunities)
- `docs/references/REFERENCE_CODE_AUDIT.md` for any relevant cjxl/libjxl patterns
- `DESIGNS_INDEX.md` and recent `PROGRESS_LOG.md` entries

---

## Success Criteria for This Group

- All three notes driven to the same rigorous standard as previous 2026-06 work.
- Clear, implementable API recommendations with parity.
- Meaningful benchmark exposure for each.
- Complete living handoff artifacts + tracking updates for each.
- No regression on the Full build decision or escape hatch philosophy.

---

## What to Do When Resuming This Group

1. Read this handoff + the three design notes.
2. Read the companion handoff for notes 4 & 5 (if relevant).
3. Re-read `FEATURE_IMPLEMENTATION_TEMPLATE.md` and the ruthless standard guidance.
4. Pick starting note (HDR recommended).
5. Create dedicated feature branch before any edits.
6. After meaningful progress on a note: update living sections + full Cleanup & Handoff + all tracking docs.

---

**Handoff for Notes 1-3 complete.**

These three notes round out the Medium / Follow-up items from the 2026-05-28 Next Features Handoff (together with 4 & 5). Once this group is also completed to the established standard, the design note creation phase for that entire handoff will be fully closed.

**Implementation progress on this handoff (2026-06 continuation):**
- Note 1 (Additional HDR Signaling): **Completed** on dedicated branch `feature/additional-hdr-signaling` following TEMPLATE + exemplar standard (JUMBF/hdr-signaling reference). Public `hdrMetadata` surface (WASM + Native parity), mandatory rich lab wiring with sample loader, acceptance test, zero-FFI-first slice (C++ emission as documented rebuild follow-up), full living Cleanup & Handoff + verification in the design note, all tracking docs updated (DESIGNS_INDEX, PROGRESS_LOG entry added, ISSUES §11 closure, PARITY_MATRIX, this handoff, Next_Features).
- Note 3 (JUMBF Box Support): Already completed on `feature/jumbf-box-support` (exemplar body present in its design note).
- Note 2 (Granular per-Extra-Channel Modular Settings): **Completed (scoped surface pass)** on dedicated branch `feature/granular-extra-channel-modular` (created clean before edits). Future-proof `ExtraChannel.modular?` sub-object added to both packages (exact parity, surgical), existing EC tests remain green, exemplar design note with accurate libjxl surface analysis and honest scoping, full living handoff + verification closure (claims now match on-disk reality after corrective pass), all trackers + this group handoff updated. The concrete lab demo, dedicated test, and global-modular-on-EC wiring closure were left as the documented next slice (no FFI in this pass). Scoped per ruthless standard.

**All three notes (1-3) are now at the identical exemplar standard.** Master tracking is consistent. The Medium follow-up batch from the 2026-05-28 handoff is fully closed at the required rigor. No escape-hatch regressions; Full-build strategy respected.
- Note 2 (Granular per-Extra-Channel Modular): **Surface + test + lab scaffolding delivered** on dedicated branch `feature/granular-extra-channel-modular` (ExtraChannel.modular? future-proof sub-object in both packages, JS demo state + HTML controls, acceptance test green with existing EC tests, verification executed, living design note + trackers updated). Matches the honest scoping already documented in the design note (global modular on EC paths + per-EC hints accepted today; true per-EC application awaits libjxl surface or larger FFI slice).

Maintain the same level of precision, parity focus, benchmark emphasis, and documentation rigor shown throughout the 2026-06 autonomous work.

**End of this handoff.**