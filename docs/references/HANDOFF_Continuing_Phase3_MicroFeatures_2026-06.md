# Handoff: Continuing the 2026-06 Phase 3 Micro-Features Design Notes

**Date:** 2026-06 (post-HDR completion + credits detour)  
**Current Branch at Handoff Creation:** `feature/hdr-signaling-color-priority` (dirty working tree — mostly build artifacts + preset-bench work + prior design session changes)  
**Context:** The long autonomous + steered implementation of the fine-toothed-comb micro-features (from REFERENCE_CODE_AUDIT.md "Fine-Toothed Comb Micro-Features Continuation (2026-06)") reached a natural stopping point after the full rigorous treatment of the HDR Signaling note. The user requested a clean handoff to resume the remaining three notes.

---

## Current Reality (Ground Truth)

### Completed to Full Standard (Exemplar)
**HDR Signaling & Color Priority** (`hdr-signaling-color-priority.md`)
- Full public API surface on both WASM + Native (intensityTarget, premultiply, preferCICPForHDR).
- Smart infrastructure: scalars ride the existing advanced pairs mechanism (automatic broad reach); the policy flag (`preferCICPForHDR`) was explicitly threaded only on the three highest-leverage modern paths (gain map, animation, central EncodeRgbaWithMetadata v2/metadata family).
- Reusable `ApplyColorEncoding` helper extracted in bridge.cpp and applied to **all** remaining color sites (including legacy/ROI paths).
- Rich mandatory benchmark wiring in jxl-wrapper-lab ("HDR Info" badges with intensity + premultiply + CICP/ICC policy, tooltips, control group).
- Native parity (EncoderData parsing + EncodeAll application).
- Acceptance test added to packages/jxl-wasm/test/facade.test.ts (suite stayed green at 72/0).
- Living "Implementation Progress" section + complete high-quality **Cleanup & Handoff** block written in the design note itself (modeled exactly on the advanced-encoder-controls Phase 1 exemplar).
- Matching detailed entry appended to PROGRESS_LOG.md.
- All tracking docs touched where appropriate.

This is the reference standard for any continuation work on the remaining notes.

### Partial Progress (Shared Infrastructure Pass)
During the coordinated "Both 1 & 2", steering turns ("Continue wiring on HDR", "Both 1 & 2", "Do the first two suggestions", etc.), the shared resolution/marshal paths were touched for **all four** Phase 3 notes at once. As a result, the following already exist in the tree:

- `packages/jxl-wasm/src/facade.ts`: `jpegReconstruction`, `upsamplingMode`, `alreadyDownsampled`, `lowMemoryStrategy` / `lowMemoryMode` fields are present in the interface and flow through `resolveEncoderBridgeSettings` + related encode paths. Some forwarding to the C++ bridge already happens.
- `packages/jxl-native/src/index.ts` + `native.cc`: Corresponding fields added in the coordinated parity pass.
- `web/jxl-wrapper-lab.html` + `.js`: Control groups and getters for JPEG Reconstruction (CFL, compress recon boxes, StoreJPEGMetadata toggle), Pixel Art / upsamplingMode (with "nearest (pixel art)" feedback), and "Low Memory / Large Image" section with "Simulate Large Image" suggestions.
- Bridge.cpp has scaffolding comments at the relevant `JxlEncoderStoreJPEGMetadata` sites.

**Good news:** You are **not** starting from a blank slate on the three remaining notes. The visible user surface + basic plumbing is already there. What remains is the "full rigorous treatment" at HDR depth: deliberate smart wiring decisions where policy flags or special logic are needed, richer native application, dedicated tests, deeper lab feedback/metrics (badges, roundtrip fidelity, memory deltas), living progress sections, and complete Cleanup & Handoff blocks.

### State of the Three Remaining Design Notes

1. **JPEG Recompression Polish** (`jpeg-recompression-polish.md`)
   - Has an explicit "**Implementation Progress (Living Section)**" + "**Cleanup & Handoff (JPEG Recompression — Initial Slice)**" block already written.
   - Documents: Public API + lab controls delivered; CFL (ID 30) + conditional Store logic ready to wire following the advanced pairs pattern.
   - Remaining per its own handoff: Full resolution + forwarding, applying `JXL_ENC_FRAME_SETTING_JPEG_RECON_CFL`, making StoreJPEGMetadata conditional, richer result feedback (reconstruction box size delta, fidelity metrics).
   - Detection priority for JPEG source is defined in the note.

2. **Pixel Art & Advanced Downsampling** (`pixel-art-downsampling.md`)
   - Pure design note. Ends after the template sections. No Implementation Progress or handoff block yet.
   - Important interactions documented: `upsamplingMode === 0` (nearest) + resampling > 1 is valid and recommended for pixel art; warnings for photographic misuse.
   - Some shared-surface wiring already exists (from the infrastructure passes). Lab has upsamplingMode select + "nearest (pixel art)" badge in results.
   - Small surface, high delight. Excellent candidate for quick high-quality completion.

3. **Production Low-Memory Chunked Paths** (`production-chunked-paths.md`)
   - Has a partial "**Implementation Progress (Living Section)**".
   - Documents: Recommendation to **evolve the existing `buffering` object** (from Phase 2 advanced controls) rather than a new top-level field — this was already applied.
   - Major benchmark win delivered: Dedicated "Low Memory / Large Image" section in the lab with tradeoff explanations + "Simulate Large Image" toggle/feedback.
   - Status in note: "Well advanced. The visible benchmark value is delivered."
   - Future slice opportunity: Full first-class `JxlOutputProcessor` + custom input source object on the Tauri/native side (where it has the most impact). Browser path already strong via existing streaming entrypoints.

### Tracking Documents Status
- `docs/references/designs/DESIGNS_INDEX.md`: Phase 3 section correctly lists all four as "Design ready (2026-06)". Needs update once slices land.
- `docs/FEATURE_PARITY_MATRIX.md`: Section 9 (micro-features from the fine audit) exists and was populated during the audit pass. Individual feature rows will need parity + benchmark exposure columns updated.
- `docs/references/REFERENCE_CODE_AUDIT.md`: Contains the "Fine-Toothed Comb Micro-Features Continuation (2026-06)" section that generated these four notes.
- `docs/references/PROGRESS_LOG.md`: Contains the detailed HDR completion entry + prior autonomous run entries. The master HANDOFF file is stale (still reflects early advanced-controls Phase 1 state).
- `docs/references/HANDOFF_Autonomous_Design_Notes_Implementation_2026-06.md`: Outdated "Current State" section. The new focused handoff (this file) is the active continuation artifact.

---

## Recommended Continuation Process (Follow Exactly)

1. **Clean the tree** (`git status` will show a lot of noise from node_modules, target/, build logs, and preset-bench work). Consider `git stash` or a fresh worktree for note work.

2. **Decide order**. Suggested (high to lower immediate user delight):
   - Pixel Art (small surface, huge visible win in lab for a passionate community; nearest-neighbor is non-negotiable for many creators).
   - JPEG Recompression (builds directly on the "Initial Slice" already documented in its note; strong archival/web value).
   - Production Chunked (mostly polish + docs on already-strong paths; the big Tauri `JxlEncoderAddChunkedFrame` work can be a later dedicated slice).

3. **For each note you pick up**:
   - Read the design note **completely** (including its current partial progress/handoff if present).
   - Re-read the relevant micro-feature section in `REFERENCE_CODE_AUDIT.md`.
   - Re-read the **HDR Signaling** note end-to-end as the current gold-standard exemplar (especially the smart wiring rationale, Cleanup & Handoff block structure, and lab badge patterns).
   - Create a **new dedicated feature branch** before any code or doc edits (`feature/jpeg-recompression-polish-continuation`, `feature/pixel-art-downsampling`, etc.).
   - Follow the full TEMPLATE + ruthless standard from prior notes.
   - **Mandatory**: Deep lab wiring with visible feedback (badges, metrics, roundtrip modes, "Simulate Large Image" style educational affordances).
   - Maintain WASM ↔ Native public API + behavioral parity.
   - Add tests (at minimum acceptance through the public `createEncoder` → finish path, plus any matrix cases).
   - At the end of the meaningful slice/note body: Write a full living **Implementation Progress** update + a complete **Cleanup & Handoff** block modeled precisely on the HDR one (scope, achievements, files changed, what works today vs. rebuild-needed, limitations, recommended reviewer commands, rationale for any smart vs. brute decisions).
   - Append a matching standalone entry to `PROGRESS_LOG.md`.
   - Update `DESIGNS_INDEX.md`, `FEATURE_PARITY_MATRIX.md`, and the master HANDOFF pointer.
   - Commit with a message referencing the design note.

4. **Ruthless Standard Reminder** (never relax):
   - Anything that is only possible via the raw `advancedFrameSettings` escape hatch stays Orange at best.
   - The escape hatch itself must remain excellent, stable, and well-documented.
   - No gold-plating. No speculative abstractions. Surgical changes that match existing patterns.

5. **Smart Wiring Principle** (from the HDR work):
   - Scalars that can ride the existing advanced/modular pairs mechanism should do so (sustainable broad reach).
   - Policy / behavioral flags that change encoding strategy (CICP priority, JPEG CFL intent, etc.) should be explicitly threaded only on the high-impact modern paths (gain map, animation, central v2/metadata, etc.) + universal helper conversion for the rest.
   - Always document the trade-off decision clearly in the design note.

---

## Immediate Next Actions for the Resuming Agent / User

1. Read this handoff + the four Phase 3 design notes + the end of `hdr-signaling-color-priority.md` (Cleanup block).
2. Read the "Fine-Toothed Comb" section in `REFERENCE_CODE_AUDIT.md`.
3. Run `git status` and decide on tree hygiene / worktree.
4. Pick the first note (recommend Pixel Art for quick high-visibility win).
5. Create the feature branch **before** touching any files.
6. When you have a meaningful slice done, produce the living progress + full handoff block + PROGRESS_LOG entry + tracking doc updates exactly as the HDR exemplar did.

---

## What "Done" Looks Like for the Remaining Three

Each note should eventually reach the same bar as HDR:
- First-class named surface (no longer escape-only for the documented use cases).
- Correct smart application of the controls (not brute-force everywhere).
- Excellent, educational mandatory wiring in jxl-wrapper-lab with visible feedback/metrics.
- Full WASM + Native parity on the public shape and behavior.
- Green tests.
- Living documentation with honest trade-off rationale.
- Complete Cleanup & Handoff block inside the design note + PROGRESS_LOG entry.

When all four Phase 3 notes have reached this bar, the "2026-06 Fine-Toothed Comb Micro-Features" work is complete. Update the master HANDOFF and DESIGNS_INDEX accordingly and celebrate.

---

**Handoff complete.** The foundation is strong, the partial wins from the shared passes are real, and the path forward is clear and repeatable. Resume at the same standard of rigor the user has come to expect.

**End of handoff document.**