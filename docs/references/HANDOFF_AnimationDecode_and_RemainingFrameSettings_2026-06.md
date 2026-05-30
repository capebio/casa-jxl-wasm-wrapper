# Handoff: Animation Decode Enhancements + Remaining Low-Level Frame Settings (Notes 4 & 5)

**Date:** 2026-06  
**Context:** All high-priority and most medium design notes from the 2026-05-28 Next Features Handoff have been completed. The final two medium/follow-up items are grouped here for focused continuation work. The user explicitly requested a clean handoff separating these from the first three medium items.

---

## Current Reality (Ground Truth)

### Completed Work (Relevant Context)
- Full set of 2026-06 Phase 3 micro-features (HDR Signaling, Pixel Art, JPEG Recompression, Production Chunked) — all at exemplar standard.
- Progressive Encode Options design note complete.
- Advanced Decoder Controls & Tuning design note complete.
- WASM Build Strategy decision recorded: **Stay with Full builds** for the foreseeable future (see `wasm-build-strategy.md`).
- `additional-hdr-signaling.md`, `jumbf-box-support.md`, and `granular-extra-channel-modular.md` have been authored (see the companion handoff for those).

### State of These Two Notes

**4. Animation Decode Enhancements** (`animation-decode-enhancements.md`)
- Builds directly on the existing `animation-multi-frame.md` (which focused on encode).
- Goal: Frame-accurate seeking, richer per-frame metadata (duration, name, etc.) on decode, and better progressive-per-frame behavior.
- Current CasaWASM decode side exposes basic animation info but lacks fine-grained seeking and metadata richness.
- libjxl has good underlying support via `JxlAnimationHeader` and frame events.
- Recommended next steps: Enhance decode event stream, add seeking APIs (`seekToFrame` / `seekToTime`), improve per-frame metadata exposure, wire into the animation lab for testing.

**5. Remaining Low-Level Frame Settings** (`remaining-frame-settings.md`)
- This is explicitly a **catch-all / completeness note**.
- Purpose: Capture any final niche or low-volume `JXL_ENC_FRAME_SETTING_*` IDs from cjxl/libjxl that still only live in the raw `advancedFrameSettings` escape hatch after all prior design waves.
- Recommended approach: Audit current usage + cjxl_main.cc for any remaining high-value stragglers. For most, the right outcome is excellent documentation + examples in the escape hatch rather than new named fields.
- Status at time of writing: Mostly a "we have covered the important ones" marker. Treat it as a living checklist rather than a large feature.

**Good news:** Both notes are lightweight compared to the Phase 3 work. They do not require massive new infrastructure.

---

## Recommended Order for This Group

1. **Start with Animation Decode Enhancements** (higher user-visible impact, builds on existing animation encode work, good demo potential in the animation lab).
2. **Then Remaining Low-Level Frame Settings** (audit + documentation exercise; can be quick or expanded based on findings).

---

## Process Reminders (Non-Negotiable)

- Follow `FEATURE_IMPLEMENTATION_TEMPLATE.md` exactly.
- Every note must include **mandatory benchmark wiring** (tie into existing animation lab or wrapper-lab where possible).
- Maintain WASM ↔ Native public API parity.
- Produce living "Implementation Progress" + full **Cleanup & Handoff** block in each design note (modeled on `hdr-signaling-color-priority.md` or the advanced encoder controls Phase 1 exemplar).
- Update tracking: `DESIGNS_INDEX.md`, `PROGRESS_LOG.md`, this handoff, and `ISSUES.md`.
- Create dedicated feature branch before any implementation code (`feature/animation-decode-enhancements`, etc.).
- Respect the **ruthless standard**: Only promote controls with real, validated usage in cjxl or production references. The raw `advancedFrameSettings` escape hatch must remain excellent.
- We are operating under the **Full build** decision — do not introduce new Lite/Decode-only build variants unless explicitly directed.

---

## Key Files to Have Open

- The two design notes themselves
- `docs/references/designs/animation-multi-frame.md` (encode foundation)
- `packages/jxl-wasm/src/facade.ts` (current DecoderOptions and decode event shapes)
- `packages/jxl-worker-browser/src/decode-handler.ts` (current animation handling)
- `web/` animation-related labs
- `docs/references/REFERENCE_CODE_AUDIT.md` and `cjxl_main.cc` references for any frame setting audit
- `DESIGNS_INDEX.md` and `PROGRESS_LOG.md`

---

## Success Criteria for This Pair

- Both notes reach the same bar as the Phase 3 and earlier 2026-06 notes.
- Animation decode note delivers clear, implementable API additions with benchmark exposure.
- Remaining frame settings note either promotes 0–2 final items or provides excellent documented escape hatch guidance.
- Full living handoff blocks + PROGRESS_LOG entries produced.
- Tracking documents are current.

---

## What to Do When Resuming

1. Read this handoff + the two design notes end-to-end.
2. Read the companion handoff for notes 1-3 (if you haven't already).
3. Re-read `FEATURE_IMPLEMENTATION_TEMPLATE.md`.
4. Decide order (recommend Animation first).
5. Create dedicated feature branch before touching code.
6. When a meaningful slice is done on either note: produce living progress + full Cleanup & Handoff + tracking updates.

---

**Handoff for Notes 4 & 5 complete.** These are the final two items from the 2026-05-28 Next Features list. Once both are driven to completion, the design note phase for that handoff is fully closed.

Next agent: Proceed with high rigor and the same attention to detail shown on the Phase 3 and Progressive/Decoder notes. 

**End of this handoff.**