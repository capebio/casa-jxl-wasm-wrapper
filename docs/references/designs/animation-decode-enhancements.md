# Feature Design Note: Animation Decode Enhancements

**Feature:** Improved animation decode support — frame-accurate seeking, better per-frame timing/name metadata exposure, and richer progressive-per-frame decode.  
**Date:** 2026-06  
**Author:** Grok  
**Status:** Design ready for implementation handoff  
**Related Index Section:** Medium follow-up  
**Priority:** Medium — builds on the existing `animation-multi-frame.md` encode note.

---

## 1. Goal & Value

While the encode side for animation is reasonably covered, the decode side for animations still has gaps compared to what professional animation/JXL workflows expect:

- Reliable frame-accurate seeking / random access
- Better exposure of per-frame duration, name, and other metadata on decode
- Progressive decode behavior per animation frame

---

## 2. Reference Analysis

- Existing `animation-multi-frame.md` focused on encode.
- libjxl decoder has good support for animation via frame events and `JxlAnimationHeader`.
- Current CasaWASM decode events expose basic animation info but lack fine-grained seeking and per-frame metadata richness.

---

## 3. Recommended API Shape

Enhance the decode event stream and `ImageInfo` / frame metadata:

- Better `frameName`, `duration`, `isKeyframe` on individual frames.
- New methods or options for frame-accurate seeking (e.g., `seekToFrame`, `seekToTime`).
- Events that clearly distinguish animation frame boundaries during progressive decode.

---

## 4–6. Implementation + Benchmark

- Leverage existing animation decode infrastructure in the worker/session.
- Add seeking support in the stateful decoder.
- In the animation lab: frame scrubber + per-frame metadata display + progressive animation decode demo.

---

## Rationale

Animation is one of JXL’s stronger features. Making the decode side as first-class as the encode side improves the overall story significantly.

**End of design note.**

---

## Implementation Progress

Design note created.

---

## Cleanup & Handoff

Complements the existing animation encode note. Implementation will touch the decode session and progressive event machinery.