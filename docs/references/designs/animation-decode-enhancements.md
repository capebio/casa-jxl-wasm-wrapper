# Feature Design Note: Animation Decode Enhancements

**Feature:** Improved animation decode support — frame-accurate seeking, better per-frame timing/name metadata exposure, and richer progressive-per-frame decode.
**Date:** 2026-06
**Author:** Grok
**Status:** Implemented (source-only; WASM rebuild + full seek wiring pending — see ISSUES.md §9)
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
- Current CasaWASM decode events already expose `frameIndex`, `frameDuration`, `frameName`, `isLastFrame`, `animTicsPerSecond`, `animLoopCount` via bridge accessors.
- `JxlDecoderSkipFrames` is available in libjxl for forward seeking.

---

## 3. Recommended API Shape

### JxlDecoder interface additions (facade.ts)

```typescript
seekToFrame?(frameIndex: number): AsyncIterable<DecodeEvent>;
seekToTime?(timeMs: number): AsyncIterable<DecodeEvent>;
```

Both are optional — gated by `getWrapperCapabilities().animationSeek`. Callers must check the capability before calling.

### WrapperCapabilities

```typescript
animationSeek: boolean; // false until WASM rebuild; dynamic after
```

### Bridge additions (bridge.cpp)

```cpp
int32_t jxl_wasm_dec_seek_to_frame(uint32_t state_ptr, uint32_t target_frame);
// Forward-only seek. Returns 0 on success, -1 if target_frame <= current frame_index.
```

---

## 4. Implementation Notes

- Seeking is **forward-only** at the C++ level: `JxlDecoderSkipFrames` only skips forward. Backward seek requires reinitializing the decoder (future work).
- `seekToTime(ms)` will need to read `animTicsPerSecond` and compute the target frame index: `Math.floor(ms * ticksPerSecond / 1000)`.
- All per-frame metadata (`frameIndex`, `frameDuration`, `frameName`, `isLastFrame`) is already wired in the bridge and exposed on `"final"` decode events.

---

## 5. Benchmark / Lab Wiring

Enhanced `web/animation-lab.html` with:

- **Frame buffer:** accumulates all `"final"` decode events as `{ pixels, width, height, durationMs, frameIndex, frameName }`
- **`requestAnimationFrame` playback loop:** tick-accurate timing using each frame's `durationMs`
- **Range-input scrubber:** seeks to any frame; pauses playback on interaction
- **Per-frame metadata panel:** shows `frameIndex`, `durationMs`, `frameName` for the current frame
- **Play/pause toggle** with loop count support (infinite or N loops)

---

## Implementation Progress

**Branch:** `feature/animation-decode-enhancements`

| Task | File(s) | Status |
|------|---------|--------|
| Tests: animationSeek capability gate (×2) + per-frame metadata | `node_modules/@casabio/jxl-wasm/test/facade.test.ts` | ✅ Done |
| facade.ts: seekToFrame/seekToTime API surface, animationSeek capability | `packages/jxl-wasm/src/facade.ts` + mirror | ✅ Done |
| bridge.cpp: jxl_wasm_dec_seek_to_frame source | `packages/jxl-wasm/src/bridge.cpp` + mirror | ✅ Source-only |
| Native parity: seekToFrame/seekToTime stubs | `node_modules/@casabio/jxl-native/src/index.ts` | ✅ Done |
| Animation lab: frame buffer + playback + scrubber + metadata | `web/animation-lab.html` | ✅ Done |

**Pending (post-rebuild):**
- Replace software-fallback seek with native `_jxl_wasm_dec_seek_to_frame` skip in `seekToFrame` body
- Validate end-to-end seek behavior against a real multi-frame JXL file

---

## Cleanup & Handoff

**`seekToFrame` / `seekToTime` work today** as software fallbacks: both methods are fully implemented in `LibjxlDecoder`. `seekToFrame(n)` runs the progressive decode loop internally and discards events for frames before `n`. `seekToTime(ms)` computes `targetFrame = Math.floor(ms * animTicksPerSecond / 1000)` from the first event carrying `animTicksPerSecond`, then delegates to the same filtering. Both are usable against any already-decoded animation without a WASM rebuild.

**`animationSeek` capability:** `getWrapperCapabilities().animationSeek` is dynamic — it reads `cachedModule` after the first decode/encode completes. Returns `false` before any decode; returns `true` only after WASM rebuild includes `jxl_wasm_dec_seek_to_frame`. The seek methods themselves work regardless of this flag (they're always present on the decoder object).

**Source-only status:** The C++ `jxl_wasm_dec_seek_to_frame` is in `packages/jxl-wasm/src/bridge.cpp`. The shipped WASM binary does NOT yet include it. Rebuild requires Emscripten (see ISSUES.md §9 — pre-existing blocker).

**Lab works now:** Animation lab frame buffer, playback loop, scrubber, and metadata panel all work using existing per-frame decode events — no WASM rebuild required.

**Post-rebuild checklist (optimization only):**
- [ ] Replace the decode-and-discard loop in `seekToFrame` with `_jxl_wasm_dec_seek_to_frame(dec, frameIndex)` before entering the event loop (skips C++ decoding of pixel data for skipped frames — faster for large seeks)
- [ ] Add seek demo controls to animation lab (seek-to-frame input, seek-to-time input)
- [ ] Test with real multi-frame JXL (animated test fixture)

**Branch:** `feature/animation-decode-enhancements`  
**Next:** `remaining-frame-settings.md` audit (see companion task).
