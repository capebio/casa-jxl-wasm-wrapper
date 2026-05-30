# Next Features Handoff — 2026-05-28

**Purpose:** Restart document for future sessions (especially after context is cleared).  
**Context:** Design phase for the first major batch of features is complete. Implementation has begun on the highest-priority items.

---

## 1. Current State Summary

### What Has Been Accomplished

- **11 feature design notes** created in `docs/references/designs/`
- Full coverage of the 2026-05-28 audit list in `REFERENCE_INDEX.md`
- Master index: `designs/DESIGNS_INDEX.md`
- Scaffolding artifacts updated (PROGRESS_LOG, REFERENCE_INDEX, main gaps doc, etc.)
- A Design Phase Completion note exists: `Design_Phase_Completion_2026-05-28.md`

### Implementation Reality Check

As of 2026-05-28:
- The first 5 highest-priority features have real implementation work underway.
- Features 1–4 are reported as nearly complete.
- All implementation is following (or should follow) `FEATURE_IMPLEMENTATION_TEMPLATE.md` and referencing the corresponding design note.

See the top of `PROGRESS_LOG.md` for the latest per-feature status. Current follow-up blockers and the full list of items still needing design notes or production work are tracked in `docs/references/designs/ISSUES.md` (use the Issue Entry Specification at the top of that file).

---

## 2. Features Already Covered by Design Notes

All of the original high-leverage sprint items from the 2026-05-28 HANDOFF have design notes:

- Brotli Effort + basic extra-channel distance
- Decoding Speed tier
- Core Modular controls
- Resampling + Photon Noise
- Full extra channel infrastructure
- Animation / Multi-frame
- Metadata / Container / JPEG reconstruction boxes
- Gain Maps (HDR)
- Patches and Splines (experimental — escape hatch approach)

See `designs/DESIGNS_INDEX.md` for the complete mapped list.

---

## 3. Recommended Next Batch of Features

The following items are the strongest candidates for the **next wave** of design notes. They were either explicitly called out in prior documents or represent logical gaps after the first batch.

### High Priority for Next Wave

| Priority | Feature | Why It Matters | Notes / References |
|----------|---------|----------------|--------------------|
| 1 | **Progressive Encode Options** | Explicitly listed in the original HANDOFF goal as still needing work. The project has very strong progressive *decode*, but encoder-side control (passes, DC/AC emphasis, responsive, group order, etc.) is still weakly exposed. | cjxl_main.cc has extensive handling of `--progressive*` flags. One of the highest-ROI remaining items. |
| 2 | **WASM Build Strategy (Full / Lite / Decode-only)** | Called out as the "Next suggested action" in `CasaWASM_JXL_Feature_Completeness_and_Gaps.md`. Affects Emscripten/CMake configuration, binary size, and which features are compiled in. | Not a single "feature" but an architectural decision that will influence all future work. |
| 3 | **Advanced Decoder Controls & Tuning** | Most design work so far has been encoder-focused. Decoder-side knobs (threading, memory limits, progressive detail levels, etc.) may need better exposure. | Look at libjxl decoder API + existing worker/decode-handler code. |

### Medium / Follow-up Items (All Completed 2026-06)

All items below now have dedicated design notes (see the focused handoffs below for implementation guidance):

- `HANDOFF_HDR_JUMBF_GranularModular_2026-06.md` — covers Additional HDR Signaling, JUMBF, and Granular per-Extra-Channel Modular
- `HANDOFF_AnimationDecode_and_RemainingFrameSettings_2026-06.md` — covers Animation Decode Enhancements and Remaining Low-Level Frame Settings

Detailed guidance for resuming work on these groups lives in those two handoff files.

- Additional HDR signaling → `additional-hdr-signaling.md`
- **JUMBF box support** → `jumbf-box-support.md` (Implemented 2026-06 on `feature/jumbf-box-support` — full exemplar body + living handoff per Phase 3 standard; see PROGRESS_LOG and the note's Cleanup & Handoff)
- Granular per-extra-channel Modular settings → `granular-extra-channel-modular.md`
- Animation decode enhancements → `animation-decode-enhancements.md`
- Remaining low-level frame settings → `remaining-frame-settings.md` (catch-all completeness note)

See `DESIGNS_INDEX.md` for current status of all notes.

---

## 4. How to Restart Work in a Fresh Session

When you start a new conversation with me (or another agent) after clearing context:

1. **Feed the key documents** (in this order):
   - This file (`Next_Features_Handoff_2026-05-28.md`)
   - `docs/references/HANDOFF.md` (original scaffolding handoff)
   - `docs/references/Design_Phase_Completion_2026-05-28.md`
   - `designs/DESIGNS_INDEX.md`

2. **Tell the agent** which feature (or small group of features) you want designed next.

3. **The agent should then**:
   - Read the latest `REFERENCE_INDEX.md`
   - Read `FEATURE_IMPLEMENTATION_TEMPLATE.md`
   - Research the relevant references (especially `cjxl_main.cc.reference.txt`)
   - Produce a new design note in `designs/`

4. After the note is written, you can review it, then hand it + the TEMPLATE to an implementation agent.

---

## 5. Open Questions / Decisions That May Influence the Next Batch

- **Build strategy decision**: Do we want to tackle the Full vs Lite WASM build question before or after the next wave of feature designs?
- How much decoder-side work do we want to prioritize versus continuing to deepen encoder capabilities?
- Are there any new features that have emerged from the implementation work on the first 5 items that should be designed before the "official" next batch?

---

## 6. Useful Commands / Locations

- All design notes: `docs/references/designs/`
- Master index: `docs/references/designs/DESIGNS_INDEX.md`
- Current progress: `docs/references/PROGRESS_LOG.md`
- Process rules: `docs/references/FEATURE_IMPLEMENTATION_TEMPLATE.md`
- Reference sources: `docs/references/` (especially the `cjxl_main.cc` files)

---

**End of Next Features Handoff**

This document + the files referenced above should allow efficient resumption of design note work without losing context.