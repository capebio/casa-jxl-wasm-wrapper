# Feature Design Note: Animation / Multi-Frame Support

**Feature:** Full multi-frame / animation encoding and decoding (timing, looping, frame names, blending, duration control)  
**Date:** 2026-05-28  
**Author:** Grok  
**Status:** Implemented (source-only; WASM + native rebuild pending — see ISSUES.md §9 and §EC-TAURI-01)  
**Related Index Section:** 8. Animation / Multi-Frame  
**Priority:** Part of the advanced feature surface; benefits from the project's existing deep investment in progressive streaming.

---

## 1. Goal & Value

Provide first-class support for creating and consuming multi-frame JXL files (animations, image sequences, "pages" in a document, scientific time series, etc.).

**Why this is valuable for CasaWASM:**
- JXL animation is one of its strongest and most under-appreciated features (excellent compression + progressive decode per frame).
- The existing progressive decode machinery (`jxl-session`, scheduler, worker, facade events) already gives us a huge head start on the decode side.
- Scientific and VFX workflows need reliable multi-frame + timing + per-frame metadata.
- libvips has one of the best production animation handling surfaces among wrappers — we can learn from it.
- Completes the "feature-maximal" mandate.

---

## 2. Reference Analysis

| Library                  | Exposure                                      | Quality | Notes |
|--------------------------|-----------------------------------------------|---------|-------|
| **libvips**              | Excellent support: delay arrays, loop count, blending modes, frame timing | Outstanding | Best high-level production model. |
| **cjxl_main.cc**         | Full handling of multipage/animation input sources and frame-level settings | Strong  | Real CLI usage patterns for animation. |
| **inflation/jpegxl-rs**  | `multiple()` builder / animation API          | Good    | Clean Rust ergonomics for adding frames over time. |
| **libjxl raw**           | `JxlEncoderAddImageFrame` + `JxlEncoderSetFrameDuration`, `JxlEncoderSetFrameName`, animation header settings, `JxlDecoder` multi-frame events | Definitive | The complete surface. |
| **chafey**               | Limited / basic                             | Weak    | Not a strong model. |

**Key takeaway:** libvips + cjxl together give excellent guidance on both the high-level ergonomic API and the low-level wiring.

---

## 3. Recommended API Shape

### Encode (most new work)

```ts
export interface AnimationFrame {
  /** Pixel data for this frame (rgba8/16/f32 or raw planes) */
  data: Uint8Array | Uint16Array | Float32Array | ImageDataLike;
  width: number;
  height: number;

  /** Duration of this frame in ticks (see AnimationOptions.ticksPerSecond) */
  duration: number;

  /** Optional human-readable frame name */
  name?: string;

  /** Optional per-frame blending / disposal info (advanced) */
  blendInfo?: FrameBlendInfo;
}

export interface AnimationOptions {
  /** Ticks per second for duration values (common: 1000 for milliseconds) */
  ticksPerSecond?: number;

  /** Number of loops (0 = infinite) */
  loopCount?: number;

  /** Whether the animation has a proper timing header */
  haveTimecodes?: boolean;
}

export interface EncoderOptions {
  // ... existing single-frame options

  /** When present, the encode is treated as an animation */
  animation?: AnimationOptions;

  /** The actual frame data (replaces single-image data when animating) */
  frames?: AnimationFrame[];
}
```

### Decode (builds on existing progressive session)

The decode side can largely reuse the existing `DecodeSession` / event stream machinery. New events or frame metadata will be needed:

- `frame` event now carries `frameIndex`, `duration`, `name`, `isLastFrame`, etc.
- New top-level animation metadata on the final info object (`loopCount`, `ticksPerSecond`, total duration, etc.).

---

## 4. WASM Implementation

### bridge.cpp

- New or extended encode entry points that accept a sequence of frames.
- Use `JxlEncoderSetAnimationHeader` (or equivalent) before adding frames.
- For each frame: `JxlEncoderAddImageFrame` + `JxlEncoderSetFrameDuration` + optional `JxlEncoderSetFrameName`.
- Proper handling of the animation header (`JxlAnimationHeader`).

The existing stateful progressive decoder already fires multiple times; we will need to extend the event protocol so the JS side can distinguish "progressive pass of current frame" vs "new frame".

### facade.ts

- High-level `encodeAnimation(frames, options)` or unified `encode({ frames, animation })`.
- On decode: surface the new animation metadata through the existing event stream or a dedicated `animationInfo` promise / field.

---

## 5. Tauri / Rust Side

jpegxl-rs already has a `multiple()` / animation builder pattern. The native side should be one of the cleaner ports once the WASM reference is solid.

Provide a symmetric `AnimationFrame` + `AnimationOptions` surface in the high-level Rust API.

---

## 6. Benchmark Wiring (Mandatory)

This is high-value and fun to demo.

**Recommended:** New or expanded page in the lab (`animation-benchmark.html` or section in wrapper-lab).

**Must show:**
- Encode a short sequence with varying frame durations
- Live progressive decode of the animation (per-frame progressive is a killer JXL feature)
- Loop count control
- Frame name display
- Side-by-side file size vs equivalent APNG / animated WebP (where possible)
- Per-frame timing accuracy verification

Tie this directly to the existing progressive gallery / lightbox work — animated JXL with progressive per-frame decode is a unique strength.

---

## 7. Testing

- Roundtrip of multi-frame files with varying durations and loop counts.
- Progressive decode of individual frames while the animation header is being streamed.
- Frame name and timing metadata fidelity.
- Infinite loop (0) vs finite loop counts.
- Mixed frame sizes / bit depths (if supported).
- Large numbers of frames (stress test for scheduler / worker).

---

## 8. Files & Considerations

- `packages/jxl-wasm/src/bridge.cpp` — new animation header + multi-frame encode logic
- `packages/jxl-wasm/src/facade.ts` — high-level animation encode + richer decode metadata
- `packages/jxl-worker-browser/src/decode-handler.ts` and scheduler — may need small extensions for frame-boundary events
- Significant new benchmark / demo surface
- Decode-side event protocol may need a small version bump or extension

**Risk note:** Animation decode touches the scheduler / session layer more than pure single-frame encoder options. Coordinate with the progressive team.

---

## 9. Rationale

- Builds on the massive progressive decode investment already in the stack.
- libvips is the strongest ergonomic reference for the high-level animation surface.
- Scoped as a first-class animation API rather than "just multiple calls to single-frame encode" because timing, looping, and progressive-per-frame are first-class concerns.
- Keeps the same clean options + escape-hatch philosophy as the rest of the batch.

---

## 10. Implementation Checklist

- [x] Branch: `epiccodereview/20260527T054853`
- [x] Animation header + multi-frame encode path in bridge (`bridge.cpp` — source-only; WASM rebuild blocked)
- [x] High-level TS animation encode API (`facade.ts`: `AnimationFrame`, `AnimationOptions`, `marshalAnimationFrames`, encode dispatch)
- [x] Extend decode events / metadata for animation info and per-frame timing (`facade.ts` `DecodeEvent`; `eventsProgressive` enrichment; bridge accessor exports)
- [x] Rich animation benchmark / demo (`web/animation-lab.html` — frame strip, encode+decode, stats, capability gate)
- [x] Comprehensive roundtrip + timing tests (facade.test.ts: capability gate, routing, opts layout, decode metadata; native codec.test.ts: source-text checks)
- [x] Tauri/Rust side using jpegxl-rs animation builders (`native.cc` + `index.ts` — source-only; native rebuild blocked)
- [x] Full handoff + PROGRESS_LOG entry (see PROGRESS_LOG 2026-05-29 entry)

---

**End of design note.**

This is the eighth note. Next: Metadata boxes + container decisions (or Gain Maps if higher visual priority). Continuing the iteration.