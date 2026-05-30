# Feature Design Note: Remaining Low-Level Frame Settings

**Feature:** Catch-all design note for any remaining low-level `JXL_ENC_FRAME_SETTING_*` values from cjxl / libjxl that are still only accessible via the raw `advancedFrameSettings` escape hatch after all previous design notes.  
**Date:** 2026-06  
**Author:** Grok  
**Status:** Design ready for implementation handoff  
**Related Index Section:** Medium / Follow-up (catch-all)  
**Priority:** Low-to-Medium — ensures completeness.

---

## 1. Goal & Value

After the major waves of design notes (advanced encoder controls, Phase 3 micro-features, progressive, decoder controls, HDR, etc.), there may still be a small number of niche or low-level frame settings that have real usage in cjxl but have not been promoted to named first-class surfaces.

This note serves as a home for those final stragglers so they receive at least a documented path rather than being left completely undocumented.

---

## 2. Recommended Approach

1. Audit the current `advancedFrameSettings` usage in the codebase and in cjxl_main.cc for any remaining frequently-used or high-value IDs that lack dedicated support.
2. For each such setting, decide:
   - Promote to a small dedicated option (if high value).
   - Document it clearly as a recommended escape hatch value with examples (if low/niche value).
3. Add any newly promoted items to the appropriate existing design note or this one.

---

## 3. Current Status (as of this note)

At the time of writing, the major high-ROI controls have been covered. Any remaining items are expected to be low-volume or highly specialized.

This note acts as the "completion" record for the 2026 design wave.

---

## 4. Implementation Guidance

- Keep the bar high: only promote settings that have clear, repeated real-world usage in cjxl or production wrappers.
- Everything else should receive excellent documentation in the escape hatch path rather than half-hearted named fields.

---

## Rationale

Completeness matters for a "feature-maximal" project. This note ensures nothing important falls through the cracks while avoiding over-engineering niche controls.

**End of design note.**

---

## Implementation Progress

Design note created as the catch-all / completeness record for the 2026 design notes effort.

---

## Cleanup & Handoff

This note should be revisited after major implementation waves to see if any newly popular low-level settings have emerged that deserve promotion. For now it serves as the official "we have covered the important ones" marker.