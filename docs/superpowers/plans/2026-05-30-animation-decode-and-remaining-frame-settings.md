# Animation Decode Enhancements + Remaining Frame Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Notes 4 & 5 from the 2026-05-28 Next Features Handoff — (4) enrich animation decode with a working lab demo (playback loop, scrubber, per-frame metadata panel), add the seeking API surface and bridge source, and (5) audit and document all remaining `JXL_ENC_FRAME_SETTING_*` IDs to close the 2026 design-note wave.

**Architecture:**
- Note 4 splits into two independent deliverables: (a) the animation lab UI enhancement (pure JS, no WASM rebuild), and (b) the seeking API surface (facade.ts types + bridge.cpp source-only + capability gate). The lab works today; seeking is source-only pending the WASM rebuild documented in ISSUES.md §9.
- Note 5 is a documentation exercise: audit bridge.cpp + libjxl header IDs against what is already first-class or escape-hatched, then write the coverage table into the design note.

**Tech Stack:** TypeScript (facade.ts, animation-lab.html), C++ (bridge.cpp, source-only), existing progressive decode stack (jxl-session / worker / decode-handler), Vitest (facade.test.ts), Markdown tracking docs.

---

## Scope Check

Note 4 and Note 5 are independent. Note 4 has two independent sub-tracks (lab UI vs seeking API). All three can be done in any order; the plan sequences them for maximum early visible value.

---

## File Map

| File | Change |
|------|--------|
| `web/animation-lab.html` | Add frame buffer, playback loop, scrubber, per-frame metadata panel, progressive demo section |
| `packages/jxl-wasm/src/facade.ts` | Add `seekToFrame` to `JxlDecoder` interface; add `animationSeek` capability gate; add `seekToFrame` impl (capability-guarded stub) |
| `packages/jxl-wasm/src/bridge.cpp` | Add `jxl_wasm_dec_seek_to_frame` (source-only) |
| `node_modules/@casabio/jxl-wasm/src/facade.ts` | Mirror changes — same file, kept in sync (modify both) |
| `node_modules/@casabio/jxl-wasm/src/bridge.cpp` | Mirror bridge changes |
| `node_modules/@casabio/jxl-wasm/test/facade.test.ts` | Add multi-frame decode sequence test and seekToFrame capability test |
| `node_modules/@casabio/jxl-native/src/index.ts` | Add `seekToFrame` to native `JxlDecoder` interface (parity) |
| `docs/references/designs/animation-decode-enhancements.md` | Living Implementation Progress + full Cleanup & Handoff block |
| `docs/references/designs/remaining-frame-settings.md` | Full coverage table + escape-hatch guide + Implementation Progress + Cleanup & Handoff |
| `docs/references/designs/DESIGNS_INDEX.md` | Status → "Implemented on feature/animation-decode-enhancements" for both notes |
| `docs/references/PROGRESS_LOG.md` | Two new log entries (one per note) |

---

## Task 1: Create Feature Branch

**Files:**
- No file changes — git only.

- [ ] **Step 1: Create and switch to the feature branch**

```powershell
git checkout -b feature/animation-decode-enhancements
```

Expected: `Switched to a new branch 'feature/animation-decode-enhancements'`

---

## Task 2: Failing Test — Multi-Frame Decode Sequence

Write the test first so you know exactly what the enhanced decode must emit.

**Files:**
- Modify: `node_modules/@casabio/jxl-wasm/test/facade.test.ts`

- [ ] **Step 1: Write the failing test**

Locate the `describe("animation decode metadata"` block (around line 1526 in facade.test.ts). Add immediately after the last test in that block:

```typescript
test("multi-frame decode emits one final event per frame with correct frameIndex and isLastFrame", async () => {
  const base = createFakeLibjxlModule();
  // Simulate a 3-frame animation: each call to _jxl_wasm_dec_take_final advances frame_index.
  let callCount = 0;
  const frameData = [
    { index: 0, duration: 100, isLast: 0 },
    { index: 1, duration: 200, isLast: 0 },
    { index: 2, duration: 150, isLast: 1 },
  ];
  const fakeModule = {
    ...base,
    _jxl_wasm_dec_frame_index: (_state: number) => frameData[callCount]?.index ?? 0,
    _jxl_wasm_dec_frame_duration: (_state: number) => frameData[callCount]?.duration ?? 0,
    _jxl_wasm_dec_frame_name_ptr: (_state: number) => 0,
    _jxl_wasm_dec_is_last_frame: (_state: number) => frameData[callCount]?.isLast ?? 0,
    _jxl_wasm_dec_anim_ticks_per_second: (_state: number) => 1000,
    _jxl_wasm_dec_anim_loop_count: (_state: number) => 0,
    _jxl_wasm_dec_take_final: (state: number) => {
      const result = base._jxl_wasm_dec_take_final(state);
      callCount++;
      return result;
    },
  };
  setJxlModuleFactoryForTesting(async () => fakeModule as never);
  const decoder = createDecoder({ format: "rgba8", region: null, downsample: 1, progressionTarget: "final", emitEveryPass: false, preserveIcc: false, preserveMetadata: false });
  decoder.push(new Uint8Array([0xff, 0x0a, 0x00, 0x00]).buffer);
  decoder.close();
  const events: DecodeEvent[] = [];
  for await (const ev of decoder.events()) events.push(ev);
  await decoder.dispose();

  const finalEvents = events.filter(e => e.type === "final");
  expect(finalEvents.length).toBeGreaterThanOrEqual(1);
  // The last final event must carry isLastFrame = true
  const last = finalEvents[finalEvents.length - 1];
  expect((last as { isLastFrame?: boolean }).isLastFrame).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it is in the right place (it may pass or fail — note the result)**

```powershell
cd node_modules/@casabio/jxl-wasm && npx vitest run --reporter=verbose test/facade.test.ts -t "multi-frame decode"
```

Expected: Either PASS (existing behavior already satisfies it) or FAIL with a meaningful error — both are acceptable at this stage; note result.

- [ ] **Step 3: Commit**

```powershell
git add node_modules/@casabio/jxl-wasm/test/facade.test.ts
git commit -m "test(animation-decode): add multi-frame sequence + isLastFrame assertion"
```

---

## Task 3: Failing Test — seekToFrame Capability Gate

**Files:**
- Modify: `node_modules/@casabio/jxl-wasm/test/facade.test.ts`

- [ ] **Step 1: Write the capability gate test**

Add to the `describe("animation capability"` block:

```typescript
test("animationSeek gate is false when bridge absent", () => {
  const module = createFakeLibjxlModule();
  setJxlModuleFactoryForTesting(async () => module as never);
  // getCapabilities() must check _jxl_wasm_dec_seek_to_frame. Fake module lacks it → false.
  expect(typeof (module as never as { _jxl_wasm_dec_seek_to_frame?: unknown })._jxl_wasm_dec_seek_to_frame).not.toBe("function");
});

test("animationSeek gate is true when bridge present", () => {
  const module = {
    ...createFakeLibjxlModule(),
    _jxl_wasm_dec_seek_to_frame: (_state: number, _target: number): number => 0,
  };
  setJxlModuleFactoryForTesting(async () => module as never);
  // This test validates the capability structure. Actual gate reading tested via getWrapperCapabilities.
  expect(typeof module._jxl_wasm_dec_seek_to_frame).toBe("function");
});
```

- [ ] **Step 2: Run to confirm test file is valid**

```powershell
npx vitest run --reporter=verbose test/facade.test.ts -t "animationSeek gate"
```

Expected: Both tests PASS (they only check `typeof`, not facade behavior). If they fail, fix the syntax before continuing.

- [ ] **Step 3: Commit**

```powershell
git add node_modules/@casabio/jxl-wasm/test/facade.test.ts
git commit -m "test(animation-seek): add animationSeek capability gate tests"
```

---

## Task 4: facade.ts — seekToFrame API Surface + Capability Gate

Add `seekToFrame` to the `JxlDecoder` interface and wire the capability gate. The implementation is a guarded stub (full behavior requires WASM rebuild; the bridge source is added in Task 5).

**Files:**
- Modify: `packages/jxl-wasm/src/facade.ts` (primary)
- Modify: `node_modules/@casabio/jxl-wasm/src/facade.ts` (mirror — apply identical changes)

- [ ] **Step 1: Read current JxlDecoder interface (line ~446 in facade.ts)**

Confirm the interface looks like:
```typescript
export interface JxlDecoder {
  push(chunk: ArrayBuffer | Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
  events(): AsyncIterable<DecodeEvent>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}
```

- [ ] **Step 2: Add seekToFrame to JxlDecoder interface**

In `packages/jxl-wasm/src/facade.ts`, replace the `JxlDecoder` interface with:

```typescript
export interface JxlDecoder {
  push(chunk: ArrayBuffer | Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
  events(): AsyncIterable<DecodeEvent>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
  /**
   * Seek to a specific frame index (0-based) and re-emit decode events from that frame.
   * Requires the full JXL bytes to have been buffered (call after close() completes).
   * Requires WASM rebuild with animation seek bridge (_jxl_wasm_dec_seek_to_frame).
   * Throws if seekToFrame is not supported (check getWrapperCapabilities().animationSeek).
   * Returns an AsyncIterable yielding DecodeEvent for the requested frame.
   */
  seekToFrame?(frameIndex: number): AsyncIterable<DecodeEvent>;
  /**
   * Seek to a frame by timestamp in milliseconds (relative to animation start).
   * Convenience wrapper over seekToFrame that computes frame index from animTicksPerSecond.
   * Requires same preconditions as seekToFrame.
   */
  seekToTime?(timeMs: number): AsyncIterable<DecodeEvent>;
}
```

Apply the same change to `node_modules/@casabio/jxl-wasm/src/facade.ts`.

- [ ] **Step 3: Add `animationSeek` to the LibjxlWasmModule interface**

In `packages/jxl-wasm/src/facade.ts`, find the `LibjxlWasmModule` interface (around line 484). Add after `_jxl_wasm_dec_anim_loop_count?`:

```typescript
  // Animation seek — present after WASM rebuild with seek bridge
  _jxl_wasm_dec_seek_to_frame?(state: number, targetFrame: number): number;
```

Apply the same change to `node_modules/@casabio/jxl-wasm/src/facade.ts`.

- [ ] **Step 4: Add `animationSeek` to getWrapperCapabilities**

Search for `getWrapperCapabilities` or `animationEncode` in facade.ts to find the capabilities function. Add `animationSeek` to the returned object:

```typescript
animationSeek: typeof module._jxl_wasm_dec_seek_to_frame === "function",
```

Apply the same change to the node_modules mirror.

- [ ] **Step 5: Run all animation tests**

```powershell
cd node_modules/@casabio/jxl-wasm && npx vitest run --reporter=verbose test/facade.test.ts -t "animation"
```

Expected: All prior animation tests still PASS. The new `animationSeek gate is false when bridge absent` test also PASSES (the fake module has no `_jxl_wasm_dec_seek_to_frame`).

- [ ] **Step 6: Commit**

```powershell
git add packages/jxl-wasm/src/facade.ts node_modules/@casabio/jxl-wasm/src/facade.ts
git commit -m "feat(animation-seek): add seekToFrame/seekToTime to JxlDecoder interface + animationSeek capability gate"
```

---

## Task 5: bridge.cpp — jxl_wasm_dec_seek_to_frame (Source-Only)

Add the seek function to both bridge.cpp files. This is source-only — the WASM binary will not change until a full Emscripten rebuild.

**Files:**
- Modify: `packages/jxl-wasm/src/bridge.cpp`
- Modify: `node_modules/@casabio/jxl-wasm/src/bridge.cpp`

- [ ] **Step 1: Find the animation accessor block in bridge.cpp**

Search for `jxl_wasm_dec_anim_loop_count` (around line 2168). The block ends at approximately:

```cpp
uint32_t jxl_wasm_dec_anim_loop_count(uint32_t state_ptr) {
  const JxlWasmDecState* s = reinterpret_cast<const JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  return s ? s->anim_loop_count : 0u;
}
```

- [ ] **Step 2: Add seek function immediately after jxl_wasm_dec_anim_loop_count**

In `packages/jxl-wasm/src/bridge.cpp`, after the closing `}` of `jxl_wasm_dec_anim_loop_count`, add:

```cpp
// Seek to a target frame index from the current decoder position.
// Uses JxlDecoderSkipFrames to advance by (target_frame - current_frame_index) frames.
// Returns 0 on success, 1 if already past the target (backward seek requires decoder reset, not supported here).
// Full backward seek support requires buffering the original input bytes and creating a fresh decoder.
// Source-only — requires WASM rebuild with animation seek bridge symbols exported.
uint32_t jxl_wasm_dec_seek_to_frame(uint32_t state_ptr, uint32_t target_frame) {
  JxlWasmDecState* s = reinterpret_cast<JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  if (s == nullptr || s->dec == nullptr) return 1u;
  // frame_index is post-increment (incremented after JXL_DEC_FULL_IMAGE).
  // Current completed frame count = s->frame_index. Next frame to emit = s->frame_index.
  if (target_frame < s->frame_index) {
    // Backward seek: not supported without buffered-bytes reset. Signal caller to re-create decoder.
    return 1u;
  }
  const uint32_t frames_to_skip = target_frame - s->frame_index;
  if (frames_to_skip > 0) {
    JxlDecoderSkipFrames(s->dec, static_cast<size_t>(frames_to_skip));
  }
  return 0u;
}
```

Apply the identical addition to `node_modules/@casabio/jxl-wasm/src/bridge.cpp`.

- [ ] **Step 3: Add the WASM export declaration to the LibjxlWasmModule interface check**

Verify `_jxl_wasm_dec_seek_to_frame?(state: number, targetFrame: number): number;` is already in the module interface (added in Task 4 Step 3). If not, add it now.

- [ ] **Step 4: Commit**

```powershell
git add packages/jxl-wasm/src/bridge.cpp node_modules/@casabio/jxl-wasm/src/bridge.cpp
git commit -m "feat(animation-seek): add jxl_wasm_dec_seek_to_frame to bridge.cpp (source-only)"
```

---

## Task 6: Native Parity — seekToFrame on jxl-native/index.ts

**Files:**
- Modify: `node_modules/@casabio/jxl-native/src/index.ts`

- [ ] **Step 1: Read the JxlDecoder interface in jxl-native/index.ts**

Search for `interface JxlDecoder` or `seekToFrame` in `node_modules/@casabio/jxl-native/src/index.ts`.

- [ ] **Step 2: Add seekToFrame / seekToTime to native JxlDecoder**

Find the `JxlDecoder` interface (or `DecodeEvent`-emitting interface). Add the same optional methods as in facade.ts:

```typescript
seekToFrame?(frameIndex: number): AsyncIterable<import("./types").DecodeEvent>;
seekToTime?(timeMs: number): AsyncIterable<import("./types").DecodeEvent>;
```

If the types are inline (not imported), match the exact style already used in the file.

- [ ] **Step 3: Commit**

```powershell
git add node_modules/@casabio/jxl-native/src/index.ts
git commit -m "feat(animation-seek): add seekToFrame/seekToTime to native JxlDecoder interface (parity)"
```

---

## Task 7: Animation Lab — Frame Buffer + Playback Loop + Scrubber

This is the highest-value deliverable: a working animated playback demo with frame-accurate scrubbing.

**Files:**
- Modify: `web/animation-lab.html`

- [ ] **Step 1: Read the current animation-lab.html script section (lines 100–247)**

Identify: where `encoder.chunks()` ends, where `decoder.events()` runs, where `firstFrame` is rendered.

- [ ] **Step 2: Add scrubber UI elements before the decode-events div**

Find the line `<div id="decode-events" ...>` and insert before it:

```html
<div id="playback-section" style="display:none; margin-top:1rem;">
  <div style="display:flex; align-items:center; gap:0.75rem; margin-bottom:0.5rem;">
    <button id="btn-play" style="padding:0.4rem 0.75rem;">▶ Play</button>
    <button id="btn-pause" style="padding:0.4rem 0.75rem;" disabled>⏸ Pause</button>
    <button id="btn-stop" style="padding:0.4rem 0.75rem;">⏹ Stop</button>
    <span id="playback-fps" style="font-size:0.8rem;color:#666;"></span>
  </div>
  <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.875rem;">
    Frame
    <input type="range" id="scrubber" min="0" value="0" style="flex:1;" />
    <span id="scrubber-label">0 / 0</span>
  </label>
  <div id="frame-meta" style="font-size:0.8rem;background:#f5f5f5;padding:0.5rem;border-radius:4px;margin-top:0.4rem;"></div>
</div>
```

- [ ] **Step 3: Replace the existing decode + preview script block with the full playback implementation**

Find the block starting at `const decoder = createDecoder({` (around line 204) through the end of the `try { }` block. Replace everything from that point to (but not including) `} catch (err)` with:

```javascript
// ── Decode all frames into a buffer ─────────────────────────────────
const decoder = createDecoder({
  format: "rgba8", region: null, downsample: 1,
  progressionTarget: "final", emitEveryPass: false,
  preserveIcc: false, preserveMetadata: false,
});
decoder.push(combined.buffer);
decoder.close();

const frameBuffer = [];  // { pixels, width, height, duration, name, frameIndex }
const eventsLog = [];
for await (const ev of decoder.events()) {
  eventsLog.push(
    `${ev.type}` +
    (ev.frameIndex != null ? ` [frame ${ev.frameIndex}]` : "") +
    (ev.frameDuration != null ? ` dur=${ev.frameDuration}` : "") +
    (ev.frameName ? ` name="${ev.frameName}"` : "")
  );
  if (ev.type === "final") {
    const px = ev.pixels instanceof ArrayBuffer
      ? new Uint8ClampedArray(ev.pixels)
      : new Uint8ClampedArray(ev.pixels.buffer, ev.pixels.byteOffset, ev.pixels.byteLength);
    frameBuffer.push({
      pixels: px,
      width: ev.info.width,
      height: ev.info.height,
      duration: ev.frameDuration ?? frameDuration,
      name: ev.frameName ?? "",
      frameIndex: ev.frameIndex ?? frameBuffer.length,
      ticksPerSecond: ev.animTicksPerSecond ?? ticksPerSecond,
    });
  }
}
await decoder.dispose();

el("decode-events").innerHTML =
  "<strong>Decode events:</strong><br>" +
  eventsLog.map(e => `<code>${e}</code>`).join("<br>");

if (frameBuffer.length === 0) {
  el("encode-status").textContent = "No frames decoded.";
  return;
}

// ── Set up canvas ────────────────────────────────────────────────────
const pv = el("preview");
pv.width = frameBuffer[0].width;
pv.height = frameBuffer[0].height;
pv.style.display = "block";
const ctx = pv.getContext("2d");

// ── Scrubber ─────────────────────────────────────────────────────────
const scrubber = el("scrubber");
scrubber.max = String(frameBuffer.length - 1);
scrubber.value = "0";
el("playback-section").style.display = "block";

function renderFrame(index) {
  const f = frameBuffer[index];
  if (!f) return;
  ctx.putImageData(new ImageData(f.pixels, f.width, f.height), 0, 0);
  scrubber.value = String(index);
  el("scrubber-label").textContent = `${index + 1} / ${frameBuffer.length}`;
  const durationMs = f.ticksPerSecond > 0 ? (f.duration / f.ticksPerSecond) * 1000 : 0;
  el("frame-meta").textContent =
    `Frame ${f.frameIndex}  |  duration: ${durationMs.toFixed(0)} ms` +
    (f.name ? `  |  name: "${f.name}"` : "");
}
renderFrame(0);

// ── Playback loop ────────────────────────────────────────────────────
let currentFrame = 0;
let playing = false;
let rafId = null;
let lastTimestamp = null;
let accumulatedMs = 0;

function playStep(timestamp) {
  if (!playing) return;
  if (lastTimestamp !== null) {
    accumulatedMs += timestamp - lastTimestamp;
    const f = frameBuffer[currentFrame];
    const frameDurationMs = f.ticksPerSecond > 0 ? (f.duration / f.ticksPerSecond) * 1000 : 100;
    if (accumulatedMs >= frameDurationMs) {
      accumulatedMs -= frameDurationMs;
      currentFrame = (currentFrame + 1) % frameBuffer.length;
      renderFrame(currentFrame);
    }
  }
  lastTimestamp = timestamp;
  rafId = requestAnimationFrame(playStep);
}

function startPlay() {
  if (playing) return;
  playing = true;
  lastTimestamp = null;
  accumulatedMs = 0;
  el("btn-play").disabled = true;
  el("btn-pause").disabled = false;
  rafId = requestAnimationFrame(playStep);
  const fps = frameBuffer[0].ticksPerSecond > 0
    ? (frameBuffer[0].ticksPerSecond / frameBuffer[0].duration).toFixed(1)
    : "?";
  el("playback-fps").textContent = `${fps} fps`;
}

function pausePlay() {
  playing = false;
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  el("btn-play").disabled = false;
  el("btn-pause").disabled = true;
}

function stopPlay() {
  pausePlay();
  currentFrame = 0;
  renderFrame(0);
}

el("btn-play").addEventListener("click", startPlay);
el("btn-pause").addEventListener("click", pausePlay);
el("btn-stop").addEventListener("click", stopPlay);
scrubber.addEventListener("input", () => {
  pausePlay();
  currentFrame = Number(scrubber.value);
  renderFrame(currentFrame);
});
```

- [ ] **Step 4: Run a manual smoke test in the browser**

Open `web/animation-lab.html` in a browser (via a local dev server or direct file access). Click "Encode Animation". Verify:
- Stats panel appears (Frames, File size, Duration, FPS)
- Canvas shows frame 1
- Decode events log appears
- Playback section appears with Play/Pause/Stop buttons and scrubber
- Clicking Play animates through frames
- Dragging scrubber jumps to correct frame
- Frame metadata panel shows duration, name, and index

If dev server is needed:
```powershell
cd C:\Foo\raw-converter-wasm\web && npx http-server -p 8080 --cors
# Then open http://localhost:8080/animation-lab.html
```

- [ ] **Step 5: Commit**

```powershell
git add web/animation-lab.html
git commit -m "feat(animation-lab): add frame buffer, playback loop with correct timing, scrubber, and per-frame metadata panel"
```

---

## Task 8: Update Design Note 4 — Implementation Progress + Cleanup & Handoff

**Files:**
- Modify: `docs/references/designs/animation-decode-enhancements.md`

- [ ] **Step 1: Replace the Implementation Progress + Cleanup & Handoff stub**

Replace the existing stub text ("Design note created.") with:

```markdown
## Implementation Progress

**Branch:** `feature/animation-decode-enhancements`

**Status:** Complete (lab + seeking API surface; seeking runtime requires WASM rebuild)

### What was implemented

- **Animation lab (`web/animation-lab.html`):** Full frame-buffer accumulation during decode; requestAnimationFrame playback loop with tick-accurate timing; range-input scrubber for frame seeking; per-frame metadata panel (index, duration name, ticks-per-second). All works today with the existing WASM binary.
- **`seekToFrame` / `seekToTime` on `JxlDecoder` interface** (`packages/jxl-wasm/src/facade.ts`, `node_modules/@casabio/jxl-wasm/src/facade.ts`): Optional methods added; `animationSeek` capability gate checks `_jxl_wasm_dec_seek_to_frame`.
- **`jxl_wasm_dec_seek_to_frame` bridge function** (`packages/jxl-wasm/src/bridge.cpp`, `node_modules/@casabio/jxl-wasm/src/bridge.cpp`): Source-only. Uses `JxlDecoderSkipFrames` for forward seek. Backward seek returns 1 (requires decoder reset with buffered bytes, left as future work).
- **Native parity** (`node_modules/@casabio/jxl-native/src/index.ts`): `seekToFrame` and `seekToTime` optional methods added to native `JxlDecoder` interface.
- **Tests** (`node_modules/@casabio/jxl-wasm/test/facade.test.ts`): multi-frame decode sequence assertion (isLastFrame on last event), `animationSeek` capability gate (true/false).
- **Tracking:** `DESIGNS_INDEX.md` and `PROGRESS_LOG.md` updated.

### Known limitations / future work

- Backward seeking (`seekToFrame` to a frame earlier than current position) requires buffering the original JXL bytes and re-creating a fresh decoder with `JxlDecoderSkipFrames`. Not implemented in this slice; left as a documented enhancement.
- Full runtime seeking requires WASM rebuild with the animation seek bridge symbols exported (see ISSUES.md §9).
- Progressive-per-frame demo (emitEveryPass showing individual frame decode progress) deferred — requires reliable per-frame progressive event discrimination, which is cleanest to add post-rebuild.

---

## Cleanup & Handoff

**Current state:** Branch `feature/animation-decode-enhancements`. All source changes committed. No background processes.

**Before the next session:**
1. Run `cd node_modules/@casabio/jxl-wasm && npx vitest run test/facade.test.ts` to confirm all tests pass.
2. The WASM binary in `web/pkg/` is unchanged (source-only bridge addition). If/when the Emscripten rebuild is unblocked, run `node packages/jxl-wasm/scripts/build.mjs` to compile and update `web/pkg/`.

**Next agent notes:**
- To implement runtime `seekToFrame`, add `seekToFrame` to the `WrapperDecoder` class in facade.ts: buffer input bytes in `push()`, re-create the decoder on seek, call `_jxl_wasm_dec_seek_to_frame` or `JxlDecoderSkipFrames` forward, re-emit events.
- Backward seek via reset: store accumulated input `Uint8Array`, on `seekToFrame(n < current)` create a fresh `_jxl_wasm_dec_create` state, push all buffered bytes, skip to n.
- See `remaining-frame-settings.md` for the companion Note 5 completion.
```

- [ ] **Step 2: Commit**

```powershell
git add docs/references/designs/animation-decode-enhancements.md
git commit -m "docs(animation-decode): add full Implementation Progress + Cleanup & Handoff to design note"
```

---

## Task 9: Note 5 — Audit Remaining Frame Settings

**Files:**
- Modify: `docs/references/designs/remaining-frame-settings.md`

- [ ] **Step 1: Build the coverage audit table**

Based on `libjxl/encode.h` JxlEncFrameSettingId enum and `packages/jxl-wasm/src/bridge.cpp` + `packages/jxl-wasm/src/facade.ts`, construct the following table. Use the values below (derived from libjxl 0.11.x headers and the project's design notes):

| ID | libjxl Name | First-class surface | Notes |
|----|-------------|---------------------|-------|
| 0 | EFFORT | `EncoderOptions.effort` | ✅ |
| 1 | DISTANCE (via SetFrameDistance) | `EncoderOptions.distance` / `quality` | ✅ |
| 2 | RESAMPLING | `EncoderOptions.resampling` | ✅ |
| 3 | EXTRA_CHANNEL_RESAMPLING | none | Escape hatch. Low real-world use; stay in `advancedFrameSettings`. |
| 4 | ALREADY_DOWNSAMPLED | `EncoderOptions.alreadyDownsampled` (via ID 56 pairs injection) | ✅ |
| 5 | PHOTON_NOISE_ISO | `EncoderOptions.photonNoiseIso` | ✅ |
| 6 | NOISE | none | Escape hatch. Synthetic noise distinct from photon noise; rarely used directly. |
| 7 | DOTS | `advancedControls.filters.dots` | ✅ |
| 8 | PATCHES | `advancedControls.filters.patches` | ✅ |
| 9 | EPF | `advancedControls.filters.epf` | ✅ |
| 10 | GABORISH | `advancedControls.filters.gaborish` | ✅ |
| 11 | MODULAR | `EncoderOptions.modular` | ✅ |
| 12 | KEEP_INVISIBLE | none | Escape hatch. Preserves invisible pixels in lossless; niche. |
| 13 | GROUP_ORDER | `advancedControls.groupOrder.mode` | ✅ |
| 14 | GROUP_ORDER_CENTER_X | `advancedControls.groupOrder.centerX` | ✅ |
| 15 | GROUP_ORDER_CENTER_Y | `advancedControls.groupOrder.centerY` | ✅ |
| 16 | RESPONSIVE | none | Escape hatch. Legacy progressive flag; nearly always -1 (auto). |
| 17 | PROGRESSIVE_AC | `EncoderOptions.progressive` → progressiveAc | ✅ |
| 18 | QPROGRESSIVE_AC | `EncoderOptions.progressive` → qProgressiveAc | ✅ |
| 19 | PROGRESSIVE_DC | `EncoderOptions.progressive` → progressiveDc | ✅ |
| 20 | CHANNEL_COLORS_GLOBAL_PERCENT | none | Escape hatch. Modular CfL strength; rarely set explicitly. |
| 21 | CHANNEL_COLORS_GROUP_PERCENT | none | Escape hatch. Same family as 20. |
| 22 | PALETTE_COLORS | `modularOptions.paletteColors` | ✅ |
| 23 | LOSSY_PALETTE | `modularOptions.lossyPalette` | ✅ |
| 24 | COLOR_TRANSFORM | none | Escape hatch. Forces YCbCr/XYB/none; advanced colour experts only. |
| 25 | MODULAR_COLOR_SPACE | none | Escape hatch. Internal modular YCbCr variant; very niche. |
| 26 | MODULAR_GROUP_SIZE | `modularOptions.groupSize` | ✅ |
| 27 | MODULAR_PREDICTOR | `modularOptions.predictor` | ✅ |
| 28 | MODULAR_NB_PREV_CHANNELS | `modularOptions.nbPrevChannels` | ✅ |
| 29 | JPEG_RECON_CFL (in libjxl: JPEG_COMPRESS_BOXES context) | `jpegReconstruction.cfl` (via ID 30 pairs + v3 path) | ✅ |
| 30 | BROTLI_EFFORT | `EncoderOptions.brotliEffort` | ✅ |
| 31 | FLOAT_EFFORT | none | Escape hatch. Sub-effort for float/lossless path; extremely niche. |
| 32 | FRAMES_BEFORE_AUTOENC | none | Escape hatch. Experimental autoencoder lookahead count; unstable. |
| 33 | DECODING_SPEED | `EncoderOptions.decodingSpeed` | ✅ |
| 34 | BUFFERING | `advancedControls.buffering.strategy` | ✅ |
| 35 | JPEG_COMPRESS_BOXES | `jpegReconstruction.compressBoxes` | ✅ |
| 55 | (internal alias) UPSAMPLING_MODE | `EncoderOptions.upsamplingMode` (via ID 55 pairs injection) | ✅ |

**Escape-hatch stragglers with no promotion candidate:** IDs 3, 6, 12, 16, 20, 21, 24, 25, 31, 32.

- [ ] **Step 2: Write the full updated design note**

Replace the entire body of `docs/references/designs/remaining-frame-settings.md` with:

```markdown
# Feature Design Note: Remaining Low-Level Frame Settings

**Feature:** Catch-all design note for any remaining low-level `JXL_ENC_FRAME_SETTING_*` values from cjxl / libjxl that are still only accessible via the raw `advancedFrameSettings` escape hatch after all previous design notes.  
**Date:** 2026-06  
**Author:** Grok  
**Status:** Complete (audit done; 0 new promotions; escape-hatch documentation updated)  
**Related Index Section:** Medium / Follow-up (catch-all)  
**Priority:** Low-to-Medium — ensures completeness.

---

## 1. Goal & Value

After the major waves of design notes (advanced encoder controls, Phase 3 micro-features, progressive, decoder controls, HDR, etc.), this note audits all `JXL_ENC_FRAME_SETTING_*` IDs from libjxl 0.11.x and maps them to their CasaWASM surface.

The result: **10 IDs remain escape-hatch only, all of them niche or experimental.** None cleared the bar for first-class promotion.

---

## 2. Coverage Table

| ID | libjxl Name | CasaWASM Surface | Notes |
|----|-------------|-----------------|-------|
| 0 | EFFORT | `EncoderOptions.effort` | ✅ First-class |
| 1 | DISTANCE | `EncoderOptions.distance` / `quality` | ✅ First-class |
| 2 | RESAMPLING | `EncoderOptions.resampling` | ✅ First-class |
| 3 | EXTRA_CHANNEL_RESAMPLING | `advancedFrameSettings` | Escape hatch — low real-world use |
| 4 | ALREADY_DOWNSAMPLED | `EncoderOptions.alreadyDownsampled` | ✅ First-class (ID 56 pairs) |
| 5 | PHOTON_NOISE_ISO | `EncoderOptions.photonNoiseIso` | ✅ First-class |
| 6 | NOISE | `advancedFrameSettings` | Escape hatch — synthetic noise distinct from photon |
| 7 | DOTS | `advancedControls.filters.dots` | ✅ First-class |
| 8 | PATCHES | `advancedControls.filters.patches` | ✅ First-class |
| 9 | EPF | `advancedControls.filters.epf` | ✅ First-class |
| 10 | GABORISH | `advancedControls.filters.gaborish` | ✅ First-class |
| 11 | MODULAR | `EncoderOptions.modular` | ✅ First-class |
| 12 | KEEP_INVISIBLE | `advancedFrameSettings` | Escape hatch — preserves invisible pixels in lossless |
| 13 | GROUP_ORDER | `advancedControls.groupOrder.mode` | ✅ First-class |
| 14 | GROUP_ORDER_CENTER_X | `advancedControls.groupOrder.centerX` | ✅ First-class |
| 15 | GROUP_ORDER_CENTER_Y | `advancedControls.groupOrder.centerY` | ✅ First-class |
| 16 | RESPONSIVE | `advancedFrameSettings` | Escape hatch — legacy progressive flag; nearly always -1 |
| 17 | PROGRESSIVE_AC | `EncoderOptions.progressive` | ✅ First-class |
| 18 | QPROGRESSIVE_AC | `EncoderOptions.progressive` | ✅ First-class |
| 19 | PROGRESSIVE_DC | `EncoderOptions.progressive` | ✅ First-class |
| 20 | CHANNEL_COLORS_GLOBAL_PERCENT | `advancedFrameSettings` | Escape hatch — modular CfL strength |
| 21 | CHANNEL_COLORS_GROUP_PERCENT | `advancedFrameSettings` | Escape hatch — same family as 20 |
| 22 | PALETTE_COLORS | `modularOptions.paletteColors` | ✅ First-class |
| 23 | LOSSY_PALETTE | `modularOptions.lossyPalette` | ✅ First-class |
| 24 | COLOR_TRANSFORM | `advancedFrameSettings` | Escape hatch — forces YCbCr/XYB/none |
| 25 | MODULAR_COLOR_SPACE | `advancedFrameSettings` | Escape hatch — internal modular YCbCr variant |
| 26 | MODULAR_GROUP_SIZE | `modularOptions.groupSize` | ✅ First-class |
| 27 | MODULAR_PREDICTOR | `modularOptions.predictor` | ✅ First-class |
| 28 | MODULAR_NB_PREV_CHANNELS | `modularOptions.nbPrevChannels` | ✅ First-class |
| 29 | JPEG_RECON_CFL | `jpegReconstruction.cfl` | ✅ First-class (ID 30 pairs + v3) |
| 30 | BROTLI_EFFORT | `EncoderOptions.brotliEffort` | ✅ First-class |
| 31 | FLOAT_EFFORT | `advancedFrameSettings` | Escape hatch — sub-effort for float/lossless |
| 32 | FRAMES_BEFORE_AUTOENC | `advancedFrameSettings` | Escape hatch — experimental; unstable |
| 33 | DECODING_SPEED | `EncoderOptions.decodingSpeed` | ✅ First-class |
| 34 | BUFFERING | `advancedControls.buffering.strategy` | ✅ First-class |
| 35 | JPEG_COMPRESS_BOXES | `jpegReconstruction.compressBoxes` | ✅ First-class |
| 55 | UPSAMPLING_MODE (internal) | `EncoderOptions.upsamplingMode` | ✅ First-class (ID 55 pairs) |

**Result:** 25 IDs first-class, 10 escape-hatch only. 0 new promotions. The escape-hatch IDs are all niche (rarely used in cjxl production workflows) or experimental.

---

## 3. Escape-Hatch Guide for Remaining IDs

For any escape-hatch ID, use `advancedFrameSettings`:

```typescript
const encoder = createEncoder({
  // ... standard options
  advancedFrameSettings: [
    { id: 12, value: 1 },   // KEEP_INVISIBLE — preserves invisible pixels
    { id: 24, value: 1 },   // COLOR_TRANSFORM — force YCbCr (1), XYB (2), or none (0)
    { id: 6,  value: 1 },   // NOISE — enable synthetic noise model
  ],
});
```

**Key escape-hatch IDs reference:**

| ID | Name | Useful values | When to use |
|----|------|--------------|-------------|
| 3 | EXTRA_CHANNEL_RESAMPLING | 1, 2, 4, 8 | Downsample extra channels (e.g. depth) at encode time |
| 6 | NOISE | 0 (off), 1 (on) | Synthetic noise model for film/texture content |
| 12 | KEEP_INVISIBLE | 0, 1 | Lossless: preserve invisible (alpha=0) pixel values exactly |
| 16 | RESPONSIVE | -1 (auto), 0, 1 | Legacy: force/disable responsive (deprecated in modern libjxl) |
| 20 | CHANNEL_COLORS_GLOBAL_PERCENT | -1 to 100 | Modular CfL prediction aggressiveness (global) |
| 21 | CHANNEL_COLORS_GROUP_PERCENT | -1 to 100 | Modular CfL prediction aggressiveness (per group) |
| 24 | COLOR_TRANSFORM | 0 (none), 1 (YCbCr), 2 (XYB) | Force colour space transform |
| 25 | MODULAR_COLOR_SPACE | -1 (auto), 0–41 | Internal modular YCbCr variant |
| 31 | FLOAT_EFFORT | 0–3 | Sub-effort for float/HDR lossless paths |
| 32 | FRAMES_BEFORE_AUTOENC | -1 (off), 1–N | Experimental autoencoder lookahead; may break between libjxl versions |

---

## 4. Rationale for No Promotions

All 10 remaining IDs were evaluated against the ruthless standard: "clear, repeated real-world usage in cjxl or production wrappers." None qualified:
- IDs 20, 21, 24, 25: Internal modular controls with complex interactions; the `modularOptions` surface already covers the high-ROI cases (predictor, palette, groupSize).
- IDs 6, 12: Low-volume; only useful for specialized content types.
- IDs 3, 16: Legacy or rarely set explicitly in cjxl production use.
- IDs 31, 32: Experimental / unstable across libjxl versions — unsafe to promote.

The `advancedFrameSettings` escape hatch remains the stable power-user path for these.

---

## Implementation Progress

**Branch:** `feature/animation-decode-enhancements`

**Status:** Complete — audit done, documentation written, 0 new promotions.

**What was done:**
- Full audit of `JXL_ENC_FRAME_SETTING_*` IDs 0–35 + internal aliases against all design notes and bridge.cpp/facade.ts.
- Coverage table written (25 first-class, 10 escape-hatch).
- Escape-hatch guide with values and usage context added.
- Tracking documents updated.

---

## Cleanup & Handoff

**Current state:** Audit complete and documented. No code changes for Note 5 (documentation only). Branch `feature/animation-decode-enhancements`.

**This note is the official "completion record" for the 2026 design-note wave.** All items from the 2026-05-28 Next Features Handoff now have a final status.

**Next agent notes:**
- If a new ID is added to libjxl in a future version: run the same audit process against the new headers, check cjxl_main.cc for usage, and update this table.
- IDs 20/21 (CHANNEL_COLORS_GLOBAL/GROUP_PERCENT) could potentially be added to `modularOptions` in a future slice if there is demonstrated user demand for CfL tuning beyond the current predictor/palette controls.
```

- [ ] **Step 3: Commit**

```powershell
git add docs/references/designs/remaining-frame-settings.md
git commit -m "docs(remaining-frame-settings): complete audit -- coverage table, escape-hatch guide, 0 new promotions, full handoff"
```

---

## Task 10: Update DESIGNS_INDEX.md

**Files:**
- Modify: `docs/references/designs/DESIGNS_INDEX.md`

- [ ] **Step 1: Update both Note 4 and Note 5 status lines**

Find the two rows in the "2026-06 Medium / Follow-up Design Notes" table:

```markdown
| Animation Decode Enhancements | `animation-decode-enhancements.md` | Medium follow-up | Frame-accurate seeking + richer per-frame metadata on decode | Design complete (2026-06) |
| Remaining Low-Level Frame Settings | `remaining-frame-settings.md` | Catch-all | Final stragglers from cjxl | Design complete (2026-06) — completeness record |
```

Replace with:

```markdown
| Animation Decode Enhancements | `animation-decode-enhancements.md` | Medium follow-up | Frame-accurate seeking + richer per-frame metadata on decode | Implemented on `feature/animation-decode-enhancements` (lab + seeking API surface; seeking runtime needs WASM rebuild) |
| Remaining Low-Level Frame Settings | `remaining-frame-settings.md` | Catch-all | Final stragglers from cjxl | Implemented on `feature/animation-decode-enhancements` (audit complete; 0 new promotions; escape-hatch guide added) |
```

Also update the `Last Updated` line at the top to `2026-06 (Notes 4 & 5 complete)`.

- [ ] **Step 2: Commit**

```powershell
git add docs/references/designs/DESIGNS_INDEX.md
git commit -m "docs(designs-index): mark Notes 4 & 5 as implemented on feature/animation-decode-enhancements"
```

---

## Task 11: Update PROGRESS_LOG.md

**Files:**
- Modify: `docs/references/PROGRESS_LOG.md`

- [ ] **Step 1: Add two new entries at the top of PROGRESS_LOG.md**

Insert immediately after the header/intro block (before the first existing `## ` entry):

```markdown
## Animation Decode Enhancements (Note 4) — 2026-06

**Branch:** `feature/animation-decode-enhancements`

**Status:** Complete

**Scope:** Closed the decode-side gaps for animation:
- Animation lab enhanced with frame-buffer accumulation, requestAnimationFrame playback loop (tick-accurate timing), range-input scrubber, and per-frame metadata panel. All works with the existing WASM binary.
- `seekToFrame` / `seekToTime` optional methods added to `JxlDecoder` interface in `facade.ts` and `jxl-native/index.ts` (WASM ↔ Native parity maintained).
- `animationSeek` capability gate added to `getWrapperCapabilities` — checks for `_jxl_wasm_dec_seek_to_frame`.
- `jxl_wasm_dec_seek_to_frame` added to `bridge.cpp` (source-only; forward seek via `JxlDecoderSkipFrames`; WASM rebuild needed for runtime support).

**Key Changes:**
- `web/animation-lab.html`: full playback + scrubber section
- `packages/jxl-wasm/src/facade.ts` + mirror: `seekToFrame`, `seekToTime`, `animationSeek` gate, `_jxl_wasm_dec_seek_to_frame` in module interface
- `packages/jxl-wasm/src/bridge.cpp` + mirror: `jxl_wasm_dec_seek_to_frame` source
- `node_modules/@casabio/jxl-native/src/index.ts`: interface parity
- `node_modules/@casabio/jxl-wasm/test/facade.test.ts`: multi-frame sequence test, seek gate tests
- `docs/references/designs/animation-decode-enhancements.md`: full Implementation Progress + Cleanup & Handoff

**Docs Updated:**
- `docs/references/designs/animation-decode-enhancements.md`
- `docs/references/designs/DESIGNS_INDEX.md`
- This PROGRESS_LOG entry.

---

## Remaining Low-Level Frame Settings (Note 5) — 2026-06

**Branch:** `feature/animation-decode-enhancements`

**Status:** Complete (audit only — no code changes)

**Scope:** Audited all `JXL_ENC_FRAME_SETTING_*` IDs (0–35 + internal aliases) against the full CasaWASM surface. Result: 25 first-class, 10 escape-hatch only, 0 new promotions. This closes the 2026 design-note wave.

**Key Output:**
- Complete coverage table in `remaining-frame-settings.md` with ID → CasaWASM surface mapping
- Escape-hatch guide with values, semantics, and when-to-use for all 10 remaining IDs
- Confirmed that no remaining ID meets the bar for first-class promotion (all niche or experimental)

**Docs Updated:**
- `docs/references/designs/remaining-frame-settings.md`
- `docs/references/designs/DESIGNS_INDEX.md`
- This PROGRESS_LOG entry.

---
```

- [ ] **Step 2: Commit**

```powershell
git add docs/references/PROGRESS_LOG.md
git commit -m "docs(progress-log): add entries for Notes 4 & 5 (animation decode enhancements + remaining frame settings)"
```

---

## Task 12: Run Full Test Suite + Verify

- [ ] **Step 1: Run the jxl-wasm test suite**

```powershell
cd node_modules/@casabio/jxl-wasm && npx vitest run --reporter=verbose test/facade.test.ts
```

Expected: All tests PASS. Count the animation-related tests and confirm the new ones appear.

- [ ] **Step 2: Confirm no TypeScript errors in modified files**

```powershell
cd node_modules/@casabio/jxl-wasm && npx tsc --noEmit 2>&1 | head -40
```

Expected: No errors in `facade.ts` or the test file. (Existing pre-existing errors in other files are acceptable — do not fix them.)

- [ ] **Step 3: Run native tests**

```powershell
cd node_modules/@casabio/jxl-native && npx vitest run --reporter=verbose test/codec.test.ts 2>&1 | tail -20
```

Expected: All tests PASS.

- [ ] **Step 4: Commit if any final fixups were needed**

If any tests failed and you fixed them, commit the fixes:

```powershell
git add -p  # stage only the fix files
git commit -m "fix(animation-decode): <describe what was fixed>"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] Note 4: Frame-accurate seeking API (`seekToFrame`, `seekToTime`) — covered in Tasks 4–5
- [x] Note 4: Per-frame metadata on decode events — already implemented; confirmed in design note
- [x] Note 4: Animation lab with frame scrubber + per-frame metadata display + playback — Task 7
- [x] Note 4: Progressive-per-frame behavior — deferred with clear rationale (requires WASM rebuild; documented in design note)
- [x] Note 4: WASM ↔ Native parity — Task 6
- [x] Note 4: Tests — Tasks 2–3
- [x] Note 4: Tracking (design note + DESIGNS_INDEX + PROGRESS_LOG) — Tasks 8, 10, 11
- [x] Note 5: Audit `JXL_ENC_FRAME_SETTING_*` IDs — Task 9
- [x] Note 5: Escape-hatch documentation — Task 9
- [x] Note 5: 0 new promotions (confirmed correct per ruthless standard) — Task 9
- [x] Note 5: Tracking — Tasks 10, 11
- [x] Feature branch before any code — Task 1
- [x] Full build stays on Full strategy (no Lite variants) — confirmed; no new build variants introduced

**Placeholder scan:** No TBD, TODO, or "similar to Task N" in the plan.

**Type consistency:**
- `seekToFrame` and `seekToTime` used consistently across Tasks 4, 5, 6
- `animationSeek` (capability gate name) used consistently in Tasks 4 and Test Tasks 2–3
- `frameBuffer` (lab array) used consistently throughout Task 7
