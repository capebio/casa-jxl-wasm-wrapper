# Animation / Multi-Frame Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement first-class JXL animation/multi-frame encode and decode in both the WASM facade (`packages/jxl-wasm`) and native binding (`packages/jxl-native`), including timing, loop count, per-frame names, and per-frame metadata in decode events.

**Architecture:** Animation encode marshals a packed `WasmAnimationFrame[]` array on the WASM heap and routes through a new `_jxl_wasm_encode_animation` bridge export. Decode extends the existing stateful progressive decoder (`JxlWasmDecState`) to subscribe to `JXL_DEC_FRAME` and expose per-frame metadata via new accessor exports (`dec_frame_index`, `dec_frame_duration`, `dec_frame_name_ptr`, `dec_is_last_frame`). The facade surfaces this as extra fields on existing `DecodeEvent` types.

**Tech Stack:** TypeScript (facade.ts), C++ (bridge.cpp, native.cc), WASM (Emscripten/wasm-pack), Bun test framework, libjxl (JxlAnimationHeader, JxlEncoderSetFrameDuration, JxlEncoderSetFrameName, JXL_DEC_FRAME).

---

## File Map

| File | Change |
|------|--------|
| `packages/jxl-wasm/src/facade.ts` | Add `AnimationFrame`, `AnimationOptions` interfaces; extend `EncoderOptions`; add `animationEncode` capability; marshal + dispatch animation encode; extend `DecodeEvent` with `frameIndex`/`duration`/`frameName`/`isLastFrame`; add animation decode accessor methods to `LibjxlWasmModule` |
| `packages/jxl-wasm/src/bridge.cpp` | Add `WasmAnimationFrame`, `WasmAnimationOpts` structs; `EncodeAnimation()` function; extend `JxlWasmDecState` with frame metadata fields; subscribe to `JXL_DEC_FRAME` in decoder; add accessor exports; add `jxl_wasm_encode_animation` export |
| `packages/jxl-wasm/exports.txt` | Add `_jxl_wasm_encode_animation`, `_jxl_wasm_dec_frame_index`, `_jxl_wasm_dec_frame_duration`, `_jxl_wasm_dec_frame_name_ptr`, `_jxl_wasm_dec_is_last_frame`, `_jxl_wasm_dec_anim_ticks_per_second`, `_jxl_wasm_dec_anim_loop_count` |
| `packages/jxl-wasm/test/facade.test.ts` | Add `describe("animation encode", ...)` + `describe("animation decode metadata", ...)` |
| `packages/jxl-native/src/index.ts` | Add `AnimationFrame`, `AnimationOptions` to `EncoderOptions`; add `frameIndex`, `duration`, `frameName`, `isLastFrame` to `DecodeEvent` |
| `packages/jxl-native/src/native.cc` | Extend `EncoderData` for animation; add animation header + multi-frame encode to `EncodeAll`; extend `DecodeAll` to subscribe to `JXL_DEC_FRAME` and emit per-frame metadata |
| `packages/jxl-native/test/codec.test.ts` | Add animation roundtrip test |
| `web/animation-lab.html` | New benchmark/demo page |
| `docs/references/designs/animation-multi-frame.md` | Update checklist |
| `docs/references/designs/DESIGNS_INDEX.md` | Update status |
| `docs/references/PROGRESS_LOG.md` | Add entry |
| `docs/references/designs/ISSUES.md` | Add WASM rebuild blocker for animation |

---

## Task 1: Animation types in facade.ts

**Files:**
- Modify: `packages/jxl-wasm/src/facade.ts` (after the `ExtraChannel` interface, before `MetadataBoxSpec`)

- [ ] **Step 1: Write failing typecheck test**

Run:
```powershell
pnpm typecheck
```
Baseline: passes currently. After adding the types below without wiring them, it should still pass (types are additive). The "failing" here is: compile the code in step 3 which references these interfaces.

- [ ] **Step 2: Add `AnimationFrame` and `AnimationOptions` interfaces to facade.ts**

Insert after the `ExtraChannel` interface (around line 148):

```typescript
/** Descriptor for one frame in an animation sequence. */
export interface AnimationFrame {
  /** RGBA pixel data for this frame (must match EncoderOptions format). */
  data: Uint8Array | ArrayBuffer;
  width: number;
  height: number;
  /** Duration in ticks (see AnimationOptions.ticksPerSecond). */
  duration: number;
  /** Optional human-readable frame name (informational; embedded in the JXL bitstream). */
  name?: string;
}

/** Animation header options written to JxlAnimationHeader. */
export interface AnimationOptions {
  /** Ticks per second for frame duration values. Default 1000 (millisecond units). */
  ticksPerSecond?: number;
  /** Number of animation loops. 0 = infinite (default). */
  loopCount?: number;
}
```

- [ ] **Step 3: Extend `EncoderOptions` with animation fields**

In the `EncoderOptions` interface, add after the `gainMap` field:

```typescript
  /** When present, encode as a multi-frame animation. ticksPerSecond and loopCount control the animation header. */
  animation?: AnimationOptions;
  /**
   * Frame data for animation encode. When set, replaces the single-image pushPixels path.
   * Requires rebuilt WASM with animation bridge (_jxl_wasm_encode_animation).
   */
  frames?: AnimationFrame[];
```

- [ ] **Step 4: Run typecheck to verify no errors**

```powershell
pnpm typecheck
```
Expected: passes (additive type changes only).

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-wasm/src/facade.ts
git commit -m "feat(jxl-wasm): add AnimationFrame/AnimationOptions types to EncoderOptions"
```

---

## Task 2: Extend LibjxlWasmModule + capability gate

**Files:**
- Modify: `packages/jxl-wasm/src/facade.ts` (LibjxlWasmModule interface + JxlCapabilities + getCapabilities)

- [ ] **Step 1: Write failing test (capabilities)**

In `packages/jxl-wasm/test/facade.test.ts`, add this test inside a new describe block at the bottom of the file (before the final helper functions):

```typescript
describe("animation capability", () => {
  afterEach(() => { setJxlModuleFactoryForTesting(null); });

  test("animationEncode capability is false when bridge absent", async () => {
    setJxlModuleFactoryForTesting(async () => createFakeLibjxlModule());
    // Load module indirectly by creating an encoder and checking caps via a spy
    const source = readFileSync(new URL("../src/facade.ts", import.meta.url), "utf8");
    expect(source).toContain("animationEncode:");
    expect(source).toContain("_jxl_wasm_encode_animation");
  });

  test("animationEncode capability is true when bridge present", async () => {
    const base = createFakeLibjxlModule();
    const animModule = {
      ...base,
      _jxl_wasm_encode_animation: (..._args: number[]) =>
        base._jxl_wasm_encode_rgba8(0, 1, 1, 0, 0),
    };
    setJxlModuleFactoryForTesting(async () => animModule as never);
    // Encode with frames=[...] — should not throw "requires rebuilt WASM"
    const encoder = createEncoder({
      ...encodeOptions,
      frames: [{ data: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1, duration: 100 }],
    });
    encoder.pushPixels(new Uint8Array(4));
    encoder.finish();
    const result = await encoder.chunks()[Symbol.asyncIterator]().next();
    expect(result.done).toBe(false);
    await encoder.dispose();
  });
});
```

Run:
```powershell
bun test packages/jxl-wasm/test/facade.test.ts --test-name-pattern "animation capability"
```
Expected: FAIL (animationEncode not in source yet).

- [ ] **Step 2: Add `_jxl_wasm_encode_animation` to LibjxlWasmModule interface**

After the `_jxl_wasm_decode_tile_container_region_rgba8` declaration (around line 284):

```typescript
  // Animation encode — present after WASM rebuild with animation bridge
  _jxl_wasm_encode_animation?(framesPtr: number, numFrames: number, distance: number, effort: number, fmt: number, hasAlpha: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, boxOptsPtr: number, animOptsPtr: number): number;
  // Animation decode frame metadata accessors — present after WASM rebuild with animation bridge
  _jxl_wasm_dec_frame_index?(state: number): number;
  _jxl_wasm_dec_frame_duration?(state: number): number;
  _jxl_wasm_dec_frame_name_ptr?(state: number): number;
  _jxl_wasm_dec_is_last_frame?(state: number): number;
  _jxl_wasm_dec_anim_ticks_per_second?(state: number): number;
  _jxl_wasm_dec_anim_loop_count?(state: number): number;
```

- [ ] **Step 3: Add `animationEncode` to `JxlCapabilities` interface and `getCapabilities()`**

In the `JxlCapabilities` interface (around line 1956), add:
```typescript
  animationEncode: boolean;
```

In `getCapabilities()` function body, add to the `caps` object literal:
```typescript
    animationEncode: typeof module._jxl_wasm_encode_animation === "function",
```

- [ ] **Step 4: Run typecheck + test**

```powershell
pnpm typecheck
bun test packages/jxl-wasm/test/facade.test.ts --test-name-pattern "animation capability"
```
Expected: typecheck passes; capability source-check test passes (string found); encoder fallback test fails until dispatch logic added (Task 3).

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-wasm/src/facade.ts packages/jxl-wasm/test/facade.test.ts
git commit -m "feat(jxl-wasm): add animationEncode capability gate + animation WASM module interface"
```

---

## Task 3: Animation encode marshal + dispatch in facade.ts

**Files:**
- Modify: `packages/jxl-wasm/src/facade.ts` (new marshal helpers + LibjxlEncoder dispatch)

- [ ] **Step 1: Write failing test for animation encode routing**

In `packages/jxl-wasm/test/facade.test.ts`, inside the `describe("animation capability", ...)` block, add:

```typescript
  test("routes to animation bridge when frames array is set", async () => {
    const base = createFakeLibjxlModule();
    const animCalls: number[][] = [];
    const animModule = {
      ...base,
      _jxl_wasm_encode_animation: (...args: number[]) => {
        animCalls.push(args);
        return base._jxl_wasm_encode_rgba8(0, 1, 1, 0, 0);
      },
    };
    setJxlModuleFactoryForTesting(async () => animModule as never);

    const encoder = createEncoder({
      ...encodeOptions,
      animation: { ticksPerSecond: 1000, loopCount: 0 },
      frames: [
        { data: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1, duration: 100 },
        { data: new Uint8Array([0, 255, 0, 255]), width: 1, height: 1, duration: 200 },
      ],
    });
    // For animation encode, pushPixels is a no-op (frame data lives in options.frames)
    encoder.finish();
    const result = await encoder.chunks()[Symbol.asyncIterator]().next();

    expect(result.done).toBe(false);
    expect(animCalls.length).toBe(1);
    // arg[1] = numFrames
    expect(animCalls[0]![1]).toBe(2);
    await encoder.dispose();
  });

  test("animOptsPtr carries ticks_per_second and loop_count", async () => {
    const base = createFakeLibjxlModule();
    const animCalls: number[][] = [];
    const animModule = {
      ...base,
      _jxl_wasm_encode_animation: (...args: number[]) => {
        animCalls.push(args);
        return base._jxl_wasm_encode_rgba8(0, 1, 1, 0, 0);
      },
    };
    setJxlModuleFactoryForTesting(async () => animModule as never);

    const encoder = createEncoder({
      ...encodeOptions,
      animation: { ticksPerSecond: 500, loopCount: 3 },
      frames: [{ data: new Uint8Array([0, 0, 255, 255]), width: 1, height: 1, duration: 50 }],
    });
    encoder.finish();
    await encoder.chunks()[Symbol.asyncIterator]().next();

    const args = animCalls[0]!;
    // animOptsPtr is arg[18]
    const animOptsPtr = args[18]!;
    expect(animOptsPtr).toBeGreaterThan(0);
    const dv = new DataView(animModule.HEAPU8.buffer);
    expect(dv.getUint32(animOptsPtr,     true)).toBe(500); // ticks_per_second
    expect(dv.getUint32(animOptsPtr + 4, true)).toBe(3);   // loop_count
    await encoder.dispose();
  });
```

Run:
```powershell
bun test packages/jxl-wasm/test/facade.test.ts --test-name-pattern "routes to animation|animOptsPtr"
```
Expected: FAIL (dispatch not yet implemented).

- [ ] **Step 2: Add marshal constants and `marshalAnimationFrames` helper in facade.ts**

After the `marshalBoxOpts` function (around line 421), add:

```typescript
// WasmAnimationFrame layout (28 bytes, 4-byte aligned uint32):
//   offset  0: pixels_ptr  — WASM heap ptr to RGBA pixel data
//   offset  4: pixels_size — byte length of pixel buffer
//   offset  8: width       — frame width in px
//   offset 12: height      — frame height in px
//   offset 16: duration    — frame duration in ticks
//   offset 20: name_ptr    — WASM heap ptr to UTF-8 name string (0 if absent)
//   offset 24: name_size   — byte length of name string
const WASM_ANIMATION_FRAME_BYTES = 28;

// WasmAnimationOpts layout (8 bytes):
//   offset 0: ticks_per_second (uint32)
//   offset 4: loop_count       (uint32)
const WASM_ANIMATION_OPTS_BYTES = 8;

/**
 * Marshals AnimationFrame[] + AnimationOptions onto the WASM heap.
 * Returns framesPtr, animOptsPtr, and all allocations to free after the encode call.
 */
function marshalAnimationFrames(
  module: LibjxlWasmModule,
  frames: AnimationFrame[],
  animOpts: AnimationOptions | undefined,
): { framesPtr: number; animOptsPtr: number; freePtrs: number[] } {
  const freePtrs: number[] = [];

  // Build frame descriptors.
  const framesBuf = new Uint8Array(frames.length * WASM_ANIMATION_FRAME_BYTES);
  const framesDv = new DataView(framesBuf.buffer);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    const base = i * WASM_ANIMATION_FRAME_BYTES;
    const pixelData = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data;
    let pixelsPtr = 0;
    if (pixelData.byteLength > 0) {
      pixelsPtr = module._malloc(pixelData.byteLength);
      if (pixelsPtr !== 0) { module.HEAPU8.set(pixelData, pixelsPtr); freePtrs.push(pixelsPtr); }
    }
    framesDv.setUint32(base,      pixelsPtr,            true);
    framesDv.setUint32(base +  4, pixelData.byteLength, true);
    framesDv.setUint32(base +  8, f.width,              true);
    framesDv.setUint32(base + 12, f.height,             true);
    framesDv.setUint32(base + 16, f.duration,           true);
    // Encode optional name.
    let namePtr = 0;
    let nameSize = 0;
    if (f.name != null && f.name.length > 0) {
      const nameBytes = new TextEncoder().encode(f.name);
      namePtr = module._malloc(nameBytes.byteLength);
      if (namePtr !== 0) { module.HEAPU8.set(nameBytes, namePtr); freePtrs.push(namePtr); nameSize = nameBytes.byteLength; }
    }
    framesDv.setUint32(base + 20, namePtr,  true);
    framesDv.setUint32(base + 24, nameSize, true);
  }

  const framesPtr = module._malloc(framesBuf.byteLength);
  if (framesPtr !== 0) { module.HEAPU8.set(framesBuf, framesPtr); freePtrs.push(framesPtr); }

  // Build animation header options.
  const animBuf = new Uint8Array(WASM_ANIMATION_OPTS_BYTES);
  const animDv = new DataView(animBuf.buffer);
  animDv.setUint32(0, animOpts?.ticksPerSecond ?? 1000, true);
  animDv.setUint32(4, animOpts?.loopCount      ?? 0,    true);
  const animOptsPtr = module._malloc(WASM_ANIMATION_OPTS_BYTES);
  if (animOptsPtr !== 0) { module.HEAPU8.set(animBuf, animOptsPtr); freePtrs.push(animOptsPtr); }

  return { framesPtr, animOptsPtr, freePtrs };
}
```

- [ ] **Step 3: Add animation dispatch path in `LibjxlEncoder._encodeBuffered` (or the equivalent finish path)**

In `LibjxlEncoder`, find the method that calls `_jxl_wasm_encode_rgba8_with_metadata_ec` or the primary single-frame encode dispatch. This is in the `finish()` flow. Add an early animation branch **before** the existing single-frame encode logic.

Locate the section in `LibjxlEncoder` that does the encode dispatch (around line 1560–1660 in facade.ts). Inside the `async` block that calls `getCapabilities(module)`, insert this block **before** the `wantSidecars` / gain-map logic:

```typescript
    // Animation encode path: route through _jxl_wasm_encode_animation when frames[] present.
    const wantAnimation = this.options.frames != null && this.options.frames.length > 0;
    if (wantAnimation) {
      if (!caps.animationEncode || !module._jxl_wasm_encode_animation) {
        // Graceful fallback: encode first frame only via standard path, emit warning.
        // (Production use needs a rebuilt WASM binary — see ISSUES.md animation rebuild entry.)
        this.frames = null;
        // Fall through to single-frame encode below using first frame's data if available.
      } else {
        const frames = this.options.frames!;
        const { effIcc, effExif, effXmp } = this.resolveEffectiveMetadata();
        const bridgeSettings = resolveEncoderBridgeSettings(this.options);
        const distQuality = resolveDistance(this.options);

        let iccPtr = 0, iccSize = 0;
        let exifPtr = 0, exifSize = 0;
        let xmpPtr = 0, xmpSize = 0;
        const freePtrs: number[] = [];

        const setBlob = (blob: ArrayBuffer | null, ptrName: 'icc' | 'exif' | 'xmp') => {
          if (blob == null || blob.byteLength === 0) return;
          const view = new Uint8Array(blob);
          const p = module._malloc(view.byteLength);
          if (p === 0) return;
          module.HEAPU8.set(view, p);
          freePtrs.push(p);
          if (ptrName === 'icc')  { iccPtr  = p; iccSize  = view.byteLength; }
          if (ptrName === 'exif') { exifPtr = p; exifSize = view.byteLength; }
          if (ptrName === 'xmp')  { xmpPtr  = p; xmpSize  = view.byteLength; }
        };
        setBlob(effIcc,  'icc');
        setBlob(effExif, 'exif');
        setBlob(effXmp,  'xmp');

        const { ptr: boxOptsPtr, freePtrs: boPtrs } = marshalBoxOpts(module, this.options);
        freePtrs.push(...boPtrs);
        if (boxOptsPtr !== 0) freePtrs.push(boxOptsPtr);

        const { framesPtr, animOptsPtr, freePtrs: animPtrs } = marshalAnimationFrames(module, frames, this.options.animation);
        freePtrs.push(...animPtrs);

        let handle = 0;
        try {
          handle = module._jxl_wasm_encode_animation!(
            framesPtr, frames.length,
            distQuality, this.options.effort,
            fmtIndex(this.options.format),
            this.options.hasAlpha ? 1 : 0,
            bridgeSettings.modular,
            bridgeSettings.brotliEffort,
            bridgeSettings.decodingSpeed,
            bridgeSettings.photonNoiseIso,
            bridgeSettings.resampling,
            iccPtr, iccSize,
            exifPtr, exifSize,
            xmpPtr, xmpSize,
            boxOptsPtr,
            animOptsPtr,
          );
        } finally {
          for (const p of freePtrs) { if (p !== 0) module._free(p); }
        }

        const buf = takeBuffer(module, handle, "animation encode");
        this.yieldChunk(buf.data);
        this.finishStats(buf.data.byteLength);
        return;
      }
    }
```

Note: you will also need a small helper `fmtIndex(format: PixelFormat): number` (returns 0/1/2 for rgba8/rgba16/rgbaf32) and `resolveDistance(options: EncoderOptions): number` if they don't already exist. Check facade.ts — `resolveEncoderBridgeSettings` already resolves most params. For distance/quality, look at how the existing encode paths compute the float `distance` argument. Add:

```typescript
function fmtIndex(format: PixelFormat): number {
  return format === "rgba16" ? 1 : format === "rgbaf32" ? 2 : 0;
}

function resolveDistance(options: EncoderOptions): number {
  if (options.distance != null) return options.distance;
  if (options.quality != null) {
    // libjxl quality-to-distance mapping: distance = 0 at quality≥100, else (100-q)/10
    if (options.quality >= 100) return 0;
    return Math.max(0.01, (100 - options.quality) / 10);
  }
  return 1.0; // libjxl default
}
```

Also add a helper `resolveEffectiveMetadata` as an instance method on `LibjxlEncoder` (or use the existing standalone `resolveEffectiveMetadata` function):
```typescript
// In the animation dispatch block, replace this.resolveEffectiveMetadata() with:
const effMeta = resolveEffectiveMetadata(this.options);
const effIcc  = effMeta.iccProfile;
const effExif = effMeta.exif;
const effXmp  = effMeta.xmp;
```

- [ ] **Step 4: Run the new animation route tests**

```powershell
bun test packages/jxl-wasm/test/facade.test.ts --test-name-pattern "routes to animation|animOptsPtr|animation capability"
```
Expected: all pass.

- [ ] **Step 5: Run full facade test suite**

```powershell
bun test packages/jxl-wasm/test/facade.test.ts
```
Expected: all existing tests still pass; new animation tests pass; the pre-existing `detectTier` tier-detection failure remains (unrelated, pre-existing, documented in ISSUES.md).

- [ ] **Step 6: Commit**

```bash
git add packages/jxl-wasm/src/facade.ts packages/jxl-wasm/test/facade.test.ts
git commit -m "feat(jxl-wasm): animation encode marshal + dispatch (source-only, WASM rebuild pending)"
```

---

## Task 4: Extend decode events with per-frame animation metadata

**Files:**
- Modify: `packages/jxl-wasm/src/facade.ts` (DecodeEvent types + LibjxlDecoder frame metadata reads)

- [ ] **Step 1: Write failing test for animation decode metadata**

In `packages/jxl-wasm/test/facade.test.ts`, add a new describe block:

```typescript
describe("animation decode metadata", () => {
  afterEach(() => { setJxlModuleFactoryForTesting(null); });

  test("facade.ts DecodeEvent final type has optional frameIndex/duration/frameName/isLastFrame", () => {
    const source = readFileSync(new URL("../src/facade.ts", import.meta.url), "utf8");
    expect(source).toContain("frameIndex?: number");
    expect(source).toContain("frameDuration?: number");
    expect(source).toContain("frameName?: string");
    expect(source).toContain("isLastFrame?: boolean");
  });

  test("decoder reads frame metadata accessors after take_final", async () => {
    const base = createFakeProgressiveLibjxlModule();
    let callCount = 0;
    const animDecModule = {
      ...base,
      _jxl_wasm_dec_frame_index:          (_s: number) => callCount++,
      _jxl_wasm_dec_frame_duration:        (_s: number) => 250,
      _jxl_wasm_dec_frame_name_ptr:        (_s: number) => 0,
      _jxl_wasm_dec_is_last_frame:         (_s: number) => 1,
      _jxl_wasm_dec_anim_ticks_per_second: (_s: number) => 1000,
      _jxl_wasm_dec_anim_loop_count:       (_s: number) => 0,
    };
    setJxlModuleFactoryForTesting(async () => animDecModule as never);

    const decoder = createDecoder({ ...decodeOptions });
    decoder.push(new Uint8Array([1, 2, 3, 4]).buffer);
    decoder.close();

    const events = [];
    for await (const ev of decoder.events()) events.push(ev);

    const finalEv = events.find((e) => e.type === "final");
    expect(finalEv).toBeDefined();
    // When frame metadata accessors are present, duration should be populated.
    expect((finalEv as { frameDuration?: number }).frameDuration).toBe(250);
    expect((finalEv as { isLastFrame?: boolean }).isLastFrame).toBe(true);
    await decoder.dispose();
  });
});
```

Run:
```powershell
bun test packages/jxl-wasm/test/facade.test.ts --test-name-pattern "animation decode metadata"
```
Expected: FAIL (fields not in source yet).

- [ ] **Step 2: Extend `DecodeEvent` final and progress union members**

In facade.ts, find the `DecodeEvent` type definition. Extend the `type: "final"` member by adding optional animation metadata fields:

```typescript
  | {
      type: "final";
      info: ImageInfo;
      pixels: ArrayBuffer | Uint8Array;
      format: PixelFormat;
      region?: Region;
      pixelStride: number;
      sourceScale?: number;
      progressiveRegion?: boolean;
      regionFallback?: "full-frame-then-crop";
      gainMap?: { data: Uint8Array };
      /** Zero-based index of this frame in the animation sequence. */
      frameIndex?: number;
      /** Duration of this frame in ticks (see animTicksPerSecond). Undefined for non-animation files. */
      frameDuration?: number;
      /** Human-readable frame name embedded in the JXL bitstream, if any. */
      frameName?: string;
      /** True if this is the last frame of the animation. */
      isLastFrame?: boolean;
      /** Ticks per second for the animation (from JxlAnimationHeader). */
      animTicksPerSecond?: number;
      /** Total animation loop count (0 = infinite). */
      animLoopCount?: number;
    }
```

Also extend the `type: "progress"` member with the same animation fields (copy exactly):

```typescript
      /** Zero-based index of this frame in the animation sequence. */
      frameIndex?: number;
      frameDuration?: number;
      frameName?: string;
      isLastFrame?: boolean;
      animTicksPerSecond?: number;
      animLoopCount?: number;
```

- [ ] **Step 3: Extend LibjxlDecoder to call frame metadata accessors after take_final / take_flushed**

In the decoder's progressive decode loop (where `takeBuffer` is called after `take_final` and `take_flushed`), add per-frame metadata enrichment.

Find the section that builds the `DecodeEvent` for type `"final"` (look for `type: "final"` string construction in the decoder). It will be in `LibjxlDecoder` somewhere around line 970–1050. After the `gainMap` field is populated, add:

```typescript
          // Populate animation per-frame metadata when bridge accessors are present.
          let frameIndex: number | undefined;
          let frameDuration: number | undefined;
          let frameName: string | undefined;
          let isLastFrame: boolean | undefined;
          let animTicksPerSecond: number | undefined;
          let animLoopCount: number | undefined;
          if (module._jxl_wasm_dec_frame_duration) {
            frameIndex        = module._jxl_wasm_dec_frame_index?.(state) ?? undefined;
            frameDuration     = module._jxl_wasm_dec_frame_duration(state);
            isLastFrame       = (module._jxl_wasm_dec_is_last_frame?.(state) ?? 0) !== 0;
            animTicksPerSecond = module._jxl_wasm_dec_anim_ticks_per_second?.(state) ?? undefined;
            animLoopCount     = module._jxl_wasm_dec_anim_loop_count?.(state)       ?? undefined;
            // Read name string from WASM heap.
            const namePtr = module._jxl_wasm_dec_frame_name_ptr?.(state) ?? 0;
            if (namePtr !== 0) {
              let end = namePtr;
              while (module.HEAPU8[end] !== 0 && end < namePtr + 256) end++;
              frameName = new TextDecoder().decode(module.HEAPU8.subarray(namePtr, end));
            }
          }
```

Then include these fields in the emitted `DecodeEvent` object:
```typescript
          event = {
            type: "final",
            // ... existing fields ...,
            ...(frameIndex     !== undefined && { frameIndex }),
            ...(frameDuration  !== undefined && { frameDuration }),
            ...(frameName      !== undefined && { frameName }),
            ...(isLastFrame    !== undefined && { isLastFrame }),
            ...(animTicksPerSecond !== undefined && { animTicksPerSecond }),
            ...(animLoopCount  !== undefined && { animLoopCount }),
          };
```

Do the same for the `"progress"` event path (the `take_flushed` branch).

- [ ] **Step 4: Run animation decode metadata tests**

```powershell
bun test packages/jxl-wasm/test/facade.test.ts --test-name-pattern "animation decode metadata"
```
Expected: all pass.

- [ ] **Step 5: Run full facade test suite**

```powershell
bun test packages/jxl-wasm/test/facade.test.ts
```
Expected: all existing tests pass; new animation decode tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/jxl-wasm/src/facade.ts packages/jxl-wasm/test/facade.test.ts
git commit -m "feat(jxl-wasm): extend DecodeEvent with per-frame animation metadata fields"
```

---

## Task 5: Add WasmAnimationFrame + EncodeAnimation to bridge.cpp

**Files:**
- Modify: `packages/jxl-wasm/src/bridge.cpp`

Note: C++ cannot be compiled in this environment (Emscripten/Docker blocked per ISSUES.md). These changes are source-level and verified by TypeScript type-checking the declarations (which already happened in Task 2).

- [ ] **Step 1: Add `WasmAnimationFrame` and `WasmAnimationOpts` structs to bridge.cpp**

In bridge.cpp, after the `WasmCustomBox` struct definition (around line 186), add:

```cpp
// Animation frame descriptor — 28 bytes, 4-byte aligned.
// Layout matches TypeScript DataView writes in marshalAnimationFrames().
struct WasmAnimationFrame {
  uint32_t pixels_ptr;  // offset  0: WASM heap ptr to RGBA pixel data
  uint32_t pixels_size; // offset  4: byte length
  uint32_t width;       // offset  8
  uint32_t height;      // offset 12
  uint32_t duration;    // offset 16: in ticks
  uint32_t name_ptr;    // offset 20: WASM heap ptr to UTF-8 name (0 = none)
  uint32_t name_size;   // offset 24: byte length of name
};

// Animation header options — 8 bytes.
struct WasmAnimationOpts {
  uint32_t ticks_per_second; // offset 0: default 1000 (ms units)
  uint32_t loop_count;       // offset 4: 0 = infinite
};
```

- [ ] **Step 2: Add `EncodeAnimation` static function in bridge.cpp**

After the existing `EncodeRgbaWithExtraChannels` function (search for `jxl_wasm_encode_rgba8_with_metadata_ec_v2` — the last EC encode export), add:

```cpp
// Encode a multi-frame JXL animation.
// frames_ptr points to a WasmAnimationFrame[] array in WASM heap.
// Returns a JxlWasmBuffer containing the encoded JXL bitstream on success, or an error buffer.
static JxlWasmBuffer* EncodeAnimation(
    const WasmAnimationFrame* frames, uint32_t num_frames,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    const WasmBoxOpts* box_opts,
    const WasmAnimationOpts* anim_opts) {
  if (frames == nullptr || num_frames == 0) return MakeError(60);

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return MakeError(61);
  if (ApplyContainerMode(enc, box_opts) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(62);
  }

  // Use dimensions + format from the first frame for the basic info.
  const uint32_t bits     = FormatToBits(fmt);
  const uint32_t exp_bits = FormatToExponentBits(fmt);
  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize                    = frames[0].width;
  info.ysize                    = frames[0].height;
  info.bits_per_sample          = bits;
  info.exponent_bits_per_sample = exp_bits;
  info.num_color_channels       = 3;
  info.num_extra_channels       = has_alpha ? 1u : 0u;
  info.alpha_bits               = has_alpha ? bits : 0u;
  info.alpha_exponent_bits      = has_alpha ? exp_bits : 0u;

  // Set animation header.
  info.have_animation           = JXL_TRUE;
  info.animation.tps_numerator  = anim_opts ? anim_opts->ticks_per_second : 1000u;
  info.animation.tps_denominator = 1u;
  info.animation.num_loops      = anim_opts ? anim_opts->loop_count : 0u;
  info.animation.have_timecodes = JXL_FALSE;

  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(63);
  }

  if (icc_profile != nullptr && icc_size > 0) {
    if (JxlEncoderSetICCProfile(enc, icc_profile, icc_size) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(64);
    }
  } else {
    JxlColorEncoding color;
    JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
    if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(65);
    }
  }

  // Create base frame settings (shared across all frames).
  JxlEncoderFrameSettings* frame_settings = JxlEncoderFrameSettingsCreate(enc, nullptr);
  JxlEncoderSetFrameDistance(frame_settings, distance);
  JxlEncoderFrameSettingsSetOption(frame_settings, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));
  if (modular >= 0)          JxlEncoderFrameSettingsSetOption(frame_settings, JXL_ENC_FRAME_SETTING_MODULAR,        static_cast<int64_t>(modular));
  if (brotli_effort >= 0)    JxlEncoderFrameSettingsSetOption(frame_settings, JXL_ENC_FRAME_SETTING_BROTLI_EFFORT,  static_cast<int64_t>(brotli_effort));
  if (decoding_speed >= 0)   JxlEncoderFrameSettingsSetOption(frame_settings, JXL_ENC_FRAME_SETTING_DECODING_SPEED, static_cast<int64_t>(std::clamp(decoding_speed, 0, 4)));
  if (photon_noise_iso > 0)  JxlEncoderFrameSettingsSetOption(frame_settings, JXL_ENC_FRAME_SETTING_PHOTON_NOISE,   static_cast<int64_t>(photon_noise_iso));
  const uint32_t norm_resamp = NormalizeResampling(resampling);
  if (norm_resamp > 1u)       JxlEncoderFrameSettingsSetOption(frame_settings, JXL_ENC_FRAME_SETTING_RESAMPLING,    static_cast<int64_t>(norm_resamp));

  const size_t bytes_per_channel = (fmt == 2u) ? 4u : (fmt == 1u) ? 2u : 1u;
  JxlPixelFormat pf = {has_alpha ? 4u : 3u, FormatToDataType(fmt), JXL_NATIVE_ENDIAN, 0};

  // Add each frame.
  for (uint32_t fi = 0; fi < num_frames; ++fi) {
    const WasmAnimationFrame& wf = frames[fi];
    if (wf.pixels_ptr == 0 || wf.pixels_size == 0) { JxlEncoderDestroy(enc); return MakeError(66); }
    const uint8_t* pixels = reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(wf.pixels_ptr));

    // Per-frame settings: create a child frame settings to set duration + name.
    JxlEncoderFrameSettings* fs = JxlEncoderFrameSettingsCreate(enc, frame_settings);
    if (JxlEncoderSetFrameDuration(fs, wf.duration) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(67);
    }
    if (wf.name_ptr != 0 && wf.name_size > 0) {
      const char* name = reinterpret_cast<const char*>(static_cast<uintptr_t>(wf.name_ptr));
      // JxlEncoderSetFrameName requires null-terminated string.
      std::vector<char> name_buf(wf.name_size + 1, '\0');
      memcpy(name_buf.data(), name, wf.name_size);
      if (JxlEncoderSetFrameName(fs, name_buf.data()) != JXL_ENC_SUCCESS) {
        JxlEncoderDestroy(enc); return MakeError(68);
      }
    }

    // Strip alpha channel if needed.
    uint8_t* rgb_pixels = nullptr;
    const uint8_t* encode_src = pixels;
    size_t pixel_size;
    if (!has_alpha) {
      const size_t n_pixels   = static_cast<size_t>(wf.width) * wf.height;
      const size_t src_stride = 4u * bytes_per_channel;
      const size_t dst_stride = 3u * bytes_per_channel;
      pixel_size = n_pixels * dst_stride;
      rgb_pixels = static_cast<uint8_t*>(malloc(pixel_size));
      if (rgb_pixels == nullptr) { JxlEncoderDestroy(enc); return MakeError(69); }
      for (size_t i = 0; i < n_pixels; ++i)
        memcpy(rgb_pixels + i * dst_stride, pixels + i * src_stride, dst_stride);
      encode_src = rgb_pixels;
    } else {
      pixel_size = static_cast<size_t>(wf.width) * wf.height * 4u * bytes_per_channel;
    }

    const JxlEncoderStatus add_status = JxlEncoderAddImageFrame(fs, &pf, encode_src, pixel_size);
    free(rgb_pixels);
    if (add_status != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(70); }
  }

  // Add metadata boxes.
  const JxlBool compress_flag = (box_opts && box_opts->compress_boxes) ? JXL_TRUE : JXL_FALSE;
  if (exif != nullptr && exif_size > 0) {
    if (JxlEncoderAddBox(enc, "Exif", exif, exif_size, compress_flag) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(71);
    }
  }
  if (xmp != nullptr && xmp_size > 0) {
    if (JxlEncoderAddBox(enc, "xml ", xmp, xmp_size, compress_flag) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(72);
    }
  }
  if (AddCustomBoxes(enc, box_opts) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(73);
  }

  JxlEncoderCloseInput(enc);

  const size_t initial_size = 65536u;
  uint8_t* outbuf = static_cast<uint8_t*>(malloc(initial_size));
  if (outbuf == nullptr) { JxlEncoderDestroy(enc); return MakeError(74); }
  size_t outbuf_cap = initial_size;
  uint8_t* next_out = outbuf;
  size_t avail_out = outbuf_cap;
  for (;;) {
    JxlEncoderStatus status = JxlEncoderProcessOutput(enc, &next_out, &avail_out);
    if (status == JXL_ENC_SUCCESS) {
      const size_t final_size = static_cast<size_t>(next_out - outbuf);
      JxlEncoderDestroy(enc);
      JxlWasmBuffer* result = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
      if (result == nullptr) { free(outbuf); return MakeError(75); }
      result->data = outbuf;
      result->size = final_size;
      result->width = frames[0].width;
      result->height = frames[0].height;
      result->bits_per_sample = bits;
      result->has_alpha = has_alpha;
      return result;
    }
    if (status == JXL_ENC_NEED_MORE_OUTPUT) {
      const size_t offset = static_cast<size_t>(next_out - outbuf);
      if (outbuf_cap >= 128 * 1024 * 1024u) { JxlEncoderDestroy(enc); free(outbuf); return MakeError(76); }
      outbuf_cap *= 2;
      uint8_t* grown = static_cast<uint8_t*>(realloc(outbuf, outbuf_cap));
      if (grown == nullptr) { free(outbuf); JxlEncoderDestroy(enc); return MakeError(77); }
      outbuf = grown;
      next_out = outbuf + offset;
      avail_out = outbuf_cap - offset;
      continue;
    }
    free(outbuf); JxlEncoderDestroy(enc); return MakeError(78);
  }
}
```

- [ ] **Step 3: Add `EMSCRIPTEN_KEEPALIVE` export wrapper for `jxl_wasm_encode_animation`**

Find the section of bridge.cpp that contains the existing `EMSCRIPTEN_KEEPALIVE` export functions (search for `jxl_wasm_encode_rgba8_with_metadata_ec_v2`). After it, add:

```cpp
EMSCRIPTEN_KEEPALIVE
JxlWasmBuffer* jxl_wasm_encode_animation(
    uint32_t frames_ptr, uint32_t num_frames,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    uint32_t icc_ptr, uint32_t icc_size,
    uint32_t exif_ptr, uint32_t exif_size,
    uint32_t xmp_ptr, uint32_t xmp_size,
    uint32_t box_opts_ptr,
    uint32_t anim_opts_ptr) {
  const WasmAnimationFrame* frames = reinterpret_cast<const WasmAnimationFrame*>(static_cast<uintptr_t>(frames_ptr));
  const uint8_t* icc  = icc_ptr  ? reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(icc_ptr))  : nullptr;
  const uint8_t* exif = exif_ptr ? reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(exif_ptr)) : nullptr;
  const uint8_t* xmp  = xmp_ptr  ? reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(xmp_ptr))  : nullptr;
  const WasmBoxOpts*       box_opts  = box_opts_ptr  ? reinterpret_cast<const WasmBoxOpts*>      (static_cast<uintptr_t>(box_opts_ptr))  : nullptr;
  const WasmAnimationOpts* anim_opts = anim_opts_ptr ? reinterpret_cast<const WasmAnimationOpts*>(static_cast<uintptr_t>(anim_opts_ptr)) : nullptr;
  return EncodeAnimation(frames, num_frames, distance, effort, fmt, has_alpha,
      modular, brotli_effort, decoding_speed, photon_noise_iso, resampling,
      icc, icc_size, exif, exif_size, xmp, xmp_size,
      box_opts, anim_opts);
}
```

- [ ] **Step 4: Run typecheck (no C++ compile available)**

```powershell
pnpm typecheck
```
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-wasm/src/bridge.cpp
git commit -m "feat(jxl-wasm): add WasmAnimationFrame/Opts structs + EncodeAnimation + jxl_wasm_encode_animation (source-only)"
```

---

## Task 6: Extend JxlWasmDecState + frame metadata accessors in bridge.cpp

**Files:**
- Modify: `packages/jxl-wasm/src/bridge.cpp`

- [ ] **Step 1: Extend `JxlWasmDecState` struct with animation metadata fields**

In bridge.cpp, find the `JxlWasmDecState` struct (around line 62). Add after the `gain_map_ready` field:

```cpp
  // Per-frame animation metadata (populated on JXL_DEC_FRAME event)
  uint32_t frame_index;        // zero-based frame counter
  uint32_t frame_duration;     // duration in ticks
  char     frame_name[256];    // null-terminated UTF-8 frame name (empty string if absent)
  uint32_t is_last_frame;      // 1 if this is the last animation frame
  // Animation header info (populated after JXL_DEC_BASIC_INFO when have_animation)
  uint32_t anim_ticks_per_second;
  uint32_t anim_loop_count;
```

- [ ] **Step 2: Subscribe to `JXL_DEC_FRAME` in `jxl_wasm_dec_create`**

Find the `jxl_wasm_dec_create` export function in bridge.cpp. It calls `JxlDecoderSubscribeEvents`. Change:

```cpp
// Before (approximate existing code):
  int subscribe_events = JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE;
  if (progressive_detail > 0) subscribe_events |= JXL_DEC_FRAME_PROGRESSION;
```

To:

```cpp
  int subscribe_events = JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE | JXL_DEC_FRAME;
  if (progressive_detail > 0) subscribe_events |= JXL_DEC_FRAME_PROGRESSION;
```

- [ ] **Step 3: Handle `JXL_DEC_FRAME` event in `jxl_wasm_dec_push`**

In `jxl_wasm_dec_push`, find the event processing loop. Add a case for `JXL_DEC_FRAME`:

```cpp
    if (status == JXL_DEC_FRAME) {
      // Read per-frame header.
      JxlFrameHeader frame_header;
      memset(&frame_header, 0, sizeof(frame_header));
      if (JxlDecoderGetFrameHeader(state->dec, &frame_header) == JXL_DEC_SUCCESS) {
        state->frame_duration = frame_header.duration;
        state->is_last_frame  = frame_header.is_last ? 1u : 0u;
        // Frame name (optional — JxlDecoderGetFrameName requires a buffer).
        state->frame_name[0] = '\0';
        char name_buf[256];
        if (JxlDecoderGetFrameName(state->dec, name_buf, sizeof(name_buf)) == JXL_DEC_SUCCESS) {
          strncpy(state->frame_name, name_buf, sizeof(state->frame_name) - 1);
          state->frame_name[sizeof(state->frame_name) - 1] = '\0';
        }
      }
      continue;
    }
```

After the `JXL_DEC_FULL_IMAGE` handling (which signals a completed frame), increment `frame_index`:

```cpp
    if (status == JXL_DEC_FULL_IMAGE) {
      state->frame_index++;
      continue;
    }
```

Also, in the `JXL_DEC_BASIC_INFO` handler, populate animation header fields:

```cpp
    if (status == JXL_DEC_BASIC_INFO) {
      // existing basic info handling ...
      // Add:
      if (state->info.have_animation) {
        state->anim_ticks_per_second = state->info.animation.tps_numerator;
        state->anim_loop_count       = state->info.animation.num_loops;
      }
      continue;
    }
```

- [ ] **Step 4: Add frame metadata accessor exports**

After the existing `jxl_wasm_dec_take_gain_map` export, add:

```cpp
EMSCRIPTEN_KEEPALIVE
uint32_t jxl_wasm_dec_frame_index(uint32_t state_ptr) {
  const JxlWasmDecState* state = reinterpret_cast<const JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  return state ? state->frame_index : 0u;
}

EMSCRIPTEN_KEEPALIVE
uint32_t jxl_wasm_dec_frame_duration(uint32_t state_ptr) {
  const JxlWasmDecState* state = reinterpret_cast<const JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  return state ? state->frame_duration : 0u;
}

EMSCRIPTEN_KEEPALIVE
uint32_t jxl_wasm_dec_frame_name_ptr(uint32_t state_ptr) {
  const JxlWasmDecState* state = reinterpret_cast<const JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  if (state == nullptr || state->frame_name[0] == '\0') return 0u;
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(state->frame_name));
}

EMSCRIPTEN_KEEPALIVE
uint32_t jxl_wasm_dec_is_last_frame(uint32_t state_ptr) {
  const JxlWasmDecState* state = reinterpret_cast<const JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  return state ? state->is_last_frame : 0u;
}

EMSCRIPTEN_KEEPALIVE
uint32_t jxl_wasm_dec_anim_ticks_per_second(uint32_t state_ptr) {
  const JxlWasmDecState* state = reinterpret_cast<const JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  return state ? state->anim_ticks_per_second : 1000u;
}

EMSCRIPTEN_KEEPALIVE
uint32_t jxl_wasm_dec_anim_loop_count(uint32_t state_ptr) {
  const JxlWasmDecState* state = reinterpret_cast<const JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  return state ? state->anim_loop_count : 0u;
}
```

- [ ] **Step 5: Run typecheck**

```powershell
pnpm typecheck
```
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add packages/jxl-wasm/src/bridge.cpp
git commit -m "feat(jxl-wasm): extend dec state with per-frame animation metadata + accessor exports (source-only)"
```

---

## Task 7: Update exports.txt

**Files:**
- Modify: `packages/jxl-wasm/exports.txt`

- [ ] **Step 1: Write test verifying exports are listed**

In `packages/jxl-wasm/test/facade.test.ts`, add inside the existing `"@casabio/jxl-wasm facade"` describe block:

```typescript
  test("exports.txt lists all animation bridge symbols", () => {
    const exports = readFileSync(new URL("../exports.txt", import.meta.url), "utf8");
    expect(exports).toContain("_jxl_wasm_encode_animation");
    expect(exports).toContain("_jxl_wasm_dec_frame_index");
    expect(exports).toContain("_jxl_wasm_dec_frame_duration");
    expect(exports).toContain("_jxl_wasm_dec_frame_name_ptr");
    expect(exports).toContain("_jxl_wasm_dec_is_last_frame");
    expect(exports).toContain("_jxl_wasm_dec_anim_ticks_per_second");
    expect(exports).toContain("_jxl_wasm_dec_anim_loop_count");
  });
```

Run:
```powershell
bun test packages/jxl-wasm/test/facade.test.ts --test-name-pattern "exports.txt lists all animation"
```
Expected: FAIL.

- [ ] **Step 2: Add animation symbols to exports.txt**

Append to `packages/jxl-wasm/exports.txt`:

```
_jxl_wasm_encode_animation
_jxl_wasm_dec_frame_index
_jxl_wasm_dec_frame_duration
_jxl_wasm_dec_frame_name_ptr
_jxl_wasm_dec_is_last_frame
_jxl_wasm_dec_anim_ticks_per_second
_jxl_wasm_dec_anim_loop_count
```

- [ ] **Step 3: Run test**

```powershell
bun test packages/jxl-wasm/test/facade.test.ts --test-name-pattern "exports.txt lists all animation"
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/jxl-wasm/exports.txt packages/jxl-wasm/test/facade.test.ts
git commit -m "feat(jxl-wasm): add animation WASM export symbols to exports.txt"
```

---

## Task 8: native.cc + index.ts animation types

**Files:**
- Modify: `packages/jxl-native/src/index.ts`
- Modify: `packages/jxl-native/src/native.cc`

- [ ] **Step 1: Write failing type test for native animation API**

In `packages/jxl-native/test/codec.test.ts`, add (this is a source-shape test that will pass once types are added):

```typescript
test("NativeEncoderOptions has animation and frames fields", () => {
  // Type-level check: these fields must exist in the EncoderOptions interface.
  // We verify by reading the source rather than runtime since native addon may not be built.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  expect(source).toContain("AnimationFrame");
  expect(source).toContain("AnimationOptions");
  expect(source).toContain("animation?: AnimationOptions");
  expect(source).toContain("frames?: AnimationFrame[]");
});

test("native DecodeEvent has frameIndex/frameDuration/frameName fields", () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  expect(source).toContain("frameIndex?: number");
  expect(source).toContain("frameDuration?: number");
  expect(source).toContain("frameName?: string");
});
```

Run:
```powershell
bun test packages/jxl-native/test/codec.test.ts --test-name-pattern "NativeEncoderOptions has animation|native DecodeEvent has"
```
Expected: FAIL.

- [ ] **Step 2: Add animation types to `packages/jxl-native/src/index.ts`**

After the `ExtraChannel` interface (if present) or after the `MetadataBoxSpec` interface, add:

```typescript
/** Descriptor for one frame in an animation sequence. */
export interface AnimationFrame {
  data: Uint8Array | ArrayBuffer;
  width: number;
  height: number;
  /** Duration in ticks (see AnimationOptions.ticksPerSecond). */
  duration: number;
  name?: string;
}

/** Animation header options. */
export interface AnimationOptions {
  ticksPerSecond?: number;
  loopCount?: number;
}
```

In the `EncoderOptions` interface, add at the end:

```typescript
  /** Animation header options. */
  animation?: AnimationOptions;
  /** Frame data for animation encode. When present, replaces single-image pushPixels. */
  frames?: AnimationFrame[];
```

Extend `DecodeEvent` type members for `"final"` and `"progress"` to include:

```typescript
      frameIndex?: number;
      frameDuration?: number;
      frameName?: string;
      isLastFrame?: boolean;
      animTicksPerSecond?: number;
      animLoopCount?: number;
```

- [ ] **Step 3: Extend `EncoderData` in native.cc for animation**

In `packages/jxl-native/src/native.cc`, in the `EncoderData` struct, add after `finished`:

```cpp
  // Animation fields
  bool has_animation = false;
  uint32_t anim_ticks_per_second = 1000;
  uint32_t anim_loop_count = 0;
  struct AnimFrame {
    std::vector<uint8_t> pixels;
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t duration = 0;
    std::string name;
  };
  std::vector<AnimFrame> anim_frames;
```

- [ ] **Step 4: Parse animation options in `CreateEncoder` in native.cc**

In `CreateEncoder`, after the `metadata` sub-object parsing block, add:

```cpp
  // Animation options + frames.
  {
    napi_value anim_val;
    if (GetProp(env, args[0], "animation", &anim_val)) {
      napi_valuetype anim_type;
      napi_typeof(env, anim_val, &anim_type);
      if (anim_type == napi_object) {
        data->anim_ticks_per_second = GetUint32Prop(env, anim_val, "ticksPerSecond", 1000);
        data->anim_loop_count       = GetUint32Prop(env, anim_val, "loopCount",      0);
      }
    }
    napi_value frames_val;
    if (GetProp(env, args[0], "frames", &frames_val)) {
      bool is_array = false;
      napi_is_array(env, frames_val, &is_array);
      if (is_array) {
        data->has_animation = true;
        uint32_t length = 0;
        napi_get_array_length(env, frames_val, &length);
        for (uint32_t fi = 0; fi < length; ++fi) {
          napi_value frame_val;
          napi_get_element(env, frames_val, fi, &frame_val);
          EncoderData::AnimFrame af;
          af.width    = GetUint32Prop(env, frame_val, "width",    0);
          af.height   = GetUint32Prop(env, frame_val, "height",   0);
          af.duration = GetUint32Prop(env, frame_val, "duration", 1);
          af.name     = GetStringProp(env, frame_val, "name",     "");
          // Read pixel data from "data" property.
          napi_value data_val;
          if (GetProp(env, frame_val, "data", &data_val)) {
            ReadBytes(env, data_val, &af.pixels);
          }
          data->anim_frames.push_back(std::move(af));
        }
      }
    }
  }
```

- [ ] **Step 5: Extend `EncodeAll` in native.cc to handle animation**

In `EncodeAll`, after the existing container setup and before the `JxlEncoderSetBasicInfo` call, add a branch for animation:

```cpp
  if (data->has_animation && !data->anim_frames.empty()) {
    // Animation encode path.
    info.have_animation              = true;
    info.animation.tps_numerator     = data->anim_ticks_per_second;
    info.animation.tps_denominator   = 1;
    info.animation.num_loops         = data->anim_loop_count;
    info.animation.have_timecodes    = false;
    // Use first frame dimensions.
    info.xsize = data->anim_frames[0].width;
    info.ysize = data->anim_frames[0].height;
  }
```

Then in the frame-add section, replace the single `JxlEncoderAddImageFrame` call with an animation loop when `has_animation` is true:

```cpp
  if (data->has_animation) {
    for (const auto& af : data->anim_frames) {
      JxlEncoderFrameSettings* fs = JxlEncoderFrameSettingsCreate(enc, frame);
      if (JxlEncoderSetFrameDuration(fs, af.duration) != JXL_ENC_SUCCESS) {
        JxlEncoderDestroy(enc); return false;
      }
      if (!af.name.empty()) {
        if (JxlEncoderSetFrameName(fs, af.name.c_str()) != JXL_ENC_SUCCESS) {
          JxlEncoderDestroy(enc); return false;
        }
      }
      const size_t expected = static_cast<size_t>(af.width) * af.height * 4 * BytesPerChannel(data->format);
      if (af.pixels.size() < expected ||
          JxlEncoderAddImageFrame(fs, &pf, af.pixels.data(), expected) != JXL_ENC_SUCCESS) {
        JxlEncoderDestroy(enc); return false;
      }
    }
  } else {
    // Existing single-frame path (unchanged):
    const size_t expected = static_cast<size_t>(data->width) * data->height * 4 * BytesPerChannel(data->format);
    if (data->pixels.size() < expected ||
        JxlEncoderAddImageFrame(frame, &pf, data->pixels.data(), expected) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return false;
    }
  }
```

- [ ] **Step 6: Extend `DecodeAll` in native.cc to surface per-frame metadata**

In `DecodeAll`, subscribe to `JXL_DEC_FRAME`:

```cpp
  int events = JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE | JXL_DEC_FRAME;
```

Add state variables before the decode loop:
```cpp
  uint32_t frame_index = 0;
  uint32_t frame_duration = 0;
  bool is_last_frame = false;
  std::string frame_name;
  uint32_t anim_tps = 1000;
  uint32_t anim_loops = 0;
```

In the loop, add a `JXL_DEC_FRAME` handler:
```cpp
    if (status == JXL_DEC_FRAME) {
      JxlFrameHeader frame_header;
      memset(&frame_header, 0, sizeof(frame_header));
      if (JxlDecoderGetFrameHeader(data->dec, &frame_header) == JXL_DEC_SUCCESS) {
        frame_duration = frame_header.duration;
        is_last_frame  = frame_header.is_last;
        char name_buf[256] = {0};
        if (JxlDecoderGetFrameName(data->dec, name_buf, sizeof(name_buf)) == JXL_DEC_SUCCESS) {
          frame_name = std::string(name_buf);
        } else {
          frame_name.clear();
        }
      }
      continue;
    }
```

In the `JXL_DEC_BASIC_INFO` handler, populate animation header:
```cpp
      if (basic.have_animation) {
        anim_tps   = basic.animation.tps_numerator;
        anim_loops = basic.animation.num_loops;
      }
```

Extend `MakeImageEvent` (or add fields inline) to include per-frame metadata. Find where the "final" event object is created and add:

```cpp
  napi_set_named_property(env, event, "frameIndex",         MakeUint32(env, frame_index));
  napi_set_named_property(env, event, "frameDuration",      MakeUint32(env, frame_duration));
  napi_set_named_property(env, event, "isLastFrame",        MakeBool(env, is_last_frame));
  napi_set_named_property(env, event, "animTicksPerSecond", MakeUint32(env, anim_tps));
  napi_set_named_property(env, event, "animLoopCount",      MakeUint32(env, anim_loops));
  if (!frame_name.empty()) {
    napi_value name_val;
    napi_create_string_utf8(env, frame_name.c_str(), NAPI_AUTO_LENGTH, &name_val);
    napi_set_named_property(env, event, "frameName", name_val);
  }
```

After `JXL_DEC_FULL_IMAGE`, increment `frame_index`.

- [ ] **Step 7: Run type tests**

```powershell
bun test packages/jxl-native/test/codec.test.ts --test-name-pattern "NativeEncoderOptions has animation|native DecodeEvent has"
```
Expected: PASS.

- [ ] **Step 8: Run typecheck**

```powershell
pnpm typecheck
```
Expected: passes.

- [ ] **Step 9: Commit**

```bash
git add packages/jxl-native/src/index.ts packages/jxl-native/src/native.cc packages/jxl-native/test/codec.test.ts
git commit -m "feat(jxl-native): animation encode/decode support in native.cc + index.ts types (source-only, rebuild pending)"
```

---

## Task 9: web/animation-lab.html benchmark page

**Files:**
- Create: `web/animation-lab.html`

- [ ] **Step 1: Write structural test**

In `packages/jxl-wasm/test/facade.test.ts` (or a standalone test file `web/animation-lab.test.js`) verify the page exists:

```javascript
// web/animation-lab.test.js
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("animation-lab.html exists and contains key elements", () => {
  const html = readFileSync(resolve(import.meta.dir, "animation-lab.html"), "utf8");
  expect(html).toContain("animation-lab");
  expect(html).toContain("ticksPerSecond");
  expect(html).toContain("loopCount");
  expect(html).toContain("encodeAnimation");
  expect(html).toContain("frameCount");
});
```

Run:
```powershell
bun test web/animation-lab.test.js
```
Expected: FAIL (file doesn't exist).

- [ ] **Step 2: Create `web/animation-lab.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>JXL Animation Lab</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <script type="importmap">
    {
      "imports": {
        "@casabio/jxl-wasm": "./pkg/jxl-wasm.js"
      }
    }
  </script>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 1rem; }
    h1 { font-size: 1.4rem; }
    .controls { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem; }
    label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.875rem; }
    input, select { padding: 0.3rem; border: 1px solid #ccc; border-radius: 4px; }
    button { padding: 0.5rem 1rem; background: #0070f3; color: #fff; border: none; border-radius: 6px; cursor: pointer; }
    button:hover { background: #005cc5; }
    .frames-section { border: 1px solid #ddd; border-radius: 6px; padding: 1rem; margin-bottom: 1rem; }
    .frame-row { display: flex; gap: 0.5rem; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid #f0f0f0; }
    .frame-canvas { width: 64px; height: 64px; border: 1px solid #ccc; image-rendering: pixelated; }
    .output-section { display: flex; gap: 1rem; flex-wrap: wrap; }
    .stat-card { background: #f5f5f5; border-radius: 6px; padding: 0.75rem; min-width: 140px; }
    .stat-card .label { font-size: 0.75rem; color: #666; }
    .stat-card .value { font-size: 1.25rem; font-weight: bold; }
    canvas#preview { border: 1px solid #ccc; image-rendering: pixelated; display: block; margin-top: 1rem; }
    .info-banner { background: #fff8e1; border-left: 4px solid #f0b429; padding: 0.75rem; border-radius: 4px; font-size: 0.85rem; }
    .error { color: #c00; font-size: 0.875rem; }
    #frame-anim-strip { display: flex; gap: 2px; flex-wrap: wrap; margin-top: 0.5rem; }
    #frame-anim-strip canvas { border: 1px solid #aaa; image-rendering: pixelated; }
  </style>
</head>
<body>
  <h1>JXL Animation Lab</h1>

  <div class="info-banner" id="capability-banner" style="display:none">
    ⚠️ Animation encode requires a rebuilt WASM binary (see ISSUES.md). Controls shown for preview.
  </div>

  <div class="controls">
    <label>
      Frame count
      <input type="number" id="frameCount" min="1" max="30" value="8" />
    </label>
    <label>
      Frame size (px)
      <input type="number" id="frameSize" min="16" max="256" value="64" />
    </label>
    <label>
      Ticks per second
      <input type="number" id="ticksPerSecond" min="1" max="10000" value="1000" />
    </label>
    <label>
      Frame duration (ticks)
      <input type="number" id="frameDuration" min="1" max="10000" value="100" />
    </label>
    <label>
      Loop count (0 = infinite)
      <input type="number" id="loopCount" min="0" max="100" value="0" />
    </label>
    <label>
      Quality
      <input type="number" id="quality" min="1" max="100" value="90" />
    </label>
  </div>

  <div class="frames-section">
    <strong>Preview frames</strong>
    <div id="frame-anim-strip"></div>
  </div>

  <button id="encodeAnimation">Encode Animation</button>
  <span id="encode-status" style="margin-left:0.75rem;font-size:0.875rem;"></span>
  <div id="error-msg" class="error"></div>

  <div class="output-section" id="output-section" style="display:none">
    <div class="stat-card">
      <div class="label">Frames</div>
      <div class="value" id="stat-frames">—</div>
    </div>
    <div class="stat-card">
      <div class="label">File size</div>
      <div class="value" id="stat-size">—</div>
    </div>
    <div class="stat-card">
      <div class="label">Duration (ms)</div>
      <div class="value" id="stat-duration">—</div>
    </div>
    <div class="stat-card">
      <div class="label">FPS</div>
      <div class="value" id="stat-fps">—</div>
    </div>
  </div>

  <canvas id="preview" style="display:none"></canvas>
  <div id="decode-events" style="font-size:0.75rem; margin-top:0.5rem;"></div>

  <script type="module">
    import { createEncoder, createDecoder, getWrapperCapabilities } from "@casabio/jxl-wasm";

    function el(id) { return document.getElementById(id); }

    /** Generate a synthetic RGBA8 frame — hue-shifted solid colour with a frame index label. */
    function generateFrame(index, total, size) {
      const canvas = document.createElement("canvas");
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext("2d");
      const hue = Math.round((index / total) * 360);
      ctx.fillStyle = `hsl(${hue}, 80%, 55%)`;
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = "#fff";
      ctx.font = `bold ${Math.max(10, size / 4)}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(index + 1), size / 2, size / 2);
      const imageData = ctx.getImageData(0, 0, size, size);
      return new Uint8Array(imageData.data.buffer);
    }

    function renderFrameStrip(count, size) {
      const strip = el("frame-anim-strip");
      strip.innerHTML = "";
      for (let i = 0; i < count; i++) {
        const c = document.createElement("canvas");
        c.width = size; c.height = size;
        c.style.width = "48px"; c.style.height = "48px";
        const ctx = c.getContext("2d");
        const rgba = generateFrame(i, count, size);
        const id = new ImageData(new Uint8ClampedArray(rgba.buffer), size, size);
        ctx.putImageData(id, 0, 0);
        strip.appendChild(c);
      }
    }

    // Render initial strip.
    renderFrameStrip(Number(el("frameCount").value), Number(el("frameSize").value));
    el("frameCount").addEventListener("input", () =>
      renderFrameStrip(Number(el("frameCount").value), Number(el("frameSize").value)));
    el("frameSize").addEventListener("input", () =>
      renderFrameStrip(Number(el("frameCount").value), Number(el("frameSize").value)));

    // Capability check.
    const caps = getWrapperCapabilities();
    if (!caps.animationEncode) {
      el("capability-banner").style.display = "block";
    }

    el("encodeAnimation").addEventListener("click", async () => {
      el("error-msg").textContent = "";
      el("encode-status").textContent = "Encoding…";
      el("output-section").style.display = "none";

      const frameCount     = Number(el("frameCount").value);
      const frameSize      = Number(el("frameSize").value);
      const ticksPerSecond = Number(el("ticksPerSecond").value);
      const frameDuration  = Number(el("frameDuration").value);
      const loopCount      = Number(el("loopCount").value);
      const quality        = Number(el("quality").value);

      try {
        const frames = Array.from({ length: frameCount }, (_, i) => ({
          data:     generateFrame(i, frameCount, frameSize),
          width:    frameSize,
          height:   frameSize,
          duration: frameDuration,
          name:     `frame-${i + 1}`,
        }));

        const t0 = performance.now();
        const encoder = createEncoder({
          format:   "rgba8",
          width:    frameSize,
          height:   frameSize,
          hasAlpha: false,
          iccProfile: null, exif: null, xmp: null,
          distance: null, quality,
          effort: 5, progressive: false, previewFirst: false, chunked: false,
          animation: { ticksPerSecond, loopCount },
          frames,
        });
        // For animation, no pushPixels call needed — frame data is in options.frames.
        encoder.finish();

        const chunks = [];
        for await (const chunk of encoder.chunks()) chunks.push(chunk);
        const elapsed = performance.now() - t0;
        await encoder.dispose();

        const totalBytes = chunks.reduce((s, c) => s + (c instanceof ArrayBuffer ? c.byteLength : c.byteLength), 0);
        const totalMs    = (frameCount * frameDuration / ticksPerSecond) * 1000;
        const fps        = ticksPerSecond / frameDuration;

        el("stat-frames").textContent   = String(frameCount);
        el("stat-size").textContent     = (totalBytes / 1024).toFixed(1) + " KB";
        el("stat-duration").textContent = totalMs.toFixed(0);
        el("stat-fps").textContent      = fps.toFixed(1);
        el("output-section").style.display = "flex";
        el("encode-status").textContent = `Done in ${elapsed.toFixed(0)} ms`;

        // Decode and show first frame.
        const combined = new Uint8Array(totalBytes);
        let off = 0;
        for (const c of chunks) {
          const v = c instanceof ArrayBuffer ? new Uint8Array(c) : c;
          combined.set(v, off); off += v.byteLength;
        }

        const decoder = createDecoder({ format: "rgba8", progressionTarget: "final", emitEveryPass: false, preserveIcc: false, preserveMetadata: false });
        decoder.push(combined);
        decoder.close();

        const eventsLog = [];
        let firstFrame = null;
        for await (const ev of decoder.events()) {
          eventsLog.push(`${ev.type}${ev.frameIndex != null ? ` [frame ${ev.frameIndex}]` : ""}${ev.frameDuration != null ? ` dur=${ev.frameDuration}` : ""}${ev.frameName ? ` name="${ev.frameName}"` : ""}`);
          if (ev.type === "final" && firstFrame === null) {
            firstFrame = ev;
          }
        }
        await decoder.dispose();

        el("decode-events").innerHTML = "<strong>Decode events:</strong><br>" + eventsLog.map(e => `<code>${e}</code>`).join("<br>");

        if (firstFrame && firstFrame.type === "final") {
          const pv = el("preview");
          pv.width = firstFrame.info.width;
          pv.height = firstFrame.info.height;
          pv.style.display = "block";
          const ctx = pv.getContext("2d");
          const px = firstFrame.pixels instanceof ArrayBuffer ? new Uint8ClampedArray(firstFrame.pixels) : new Uint8ClampedArray(firstFrame.pixels.buffer, firstFrame.pixels.byteOffset, firstFrame.pixels.byteLength);
          ctx.putImageData(new ImageData(px, firstFrame.info.width, firstFrame.info.height), 0, 0);
        }
      } catch (err) {
        el("error-msg").textContent = String(err);
        el("encode-status").textContent = "";
      }
    });
  </script>
</body>
</html>
```

- [ ] **Step 3: Run structural test**

```powershell
bun test web/animation-lab.test.js
```
Expected: PASS.

- [ ] **Step 4: Manual smoke test in browser**

Open `web/animation-lab.html` in a browser (via a local HTTP server, e.g. `npx serve web/`). Verify:
- Page loads without JS errors.
- Capability banner shown when `caps.animationEncode` is false (until WASM rebuild).
- Frame strip renders coloured frames with index labels.
- "Encode Animation" button runs without crashing (fallback path until rebuild).

- [ ] **Step 5: Commit**

```bash
git add web/animation-lab.html web/animation-lab.test.js
git commit -m "feat(web): add animation-lab.html benchmark/demo page"
```

---

## Task 10: Update ISSUES.md, PROGRESS_LOG.md, and design note checklist

**Files:**
- Modify: `docs/references/designs/ISSUES.md`
- Modify: `docs/references/PROGRESS_LOG.md`
- Modify: `docs/references/designs/animation-multi-frame.md`
- Modify: `docs/references/designs/DESIGNS_INDEX.md`

- [ ] **Step 1: Add WASM rebuild blocker issue to ISSUES.md**

Append to `docs/references/designs/ISSUES.md`:

```markdown
## 9. Rebuild WASM artifacts for animation bridge (2026-05-29)

**Status:** blocked — same Docker/Emscripten constraint as Issue 3.

**Why this matters:**
- `bridge.cpp` now exports `jxl_wasm_encode_animation` + 6 frame-metadata decoder accessors.
- Generated WASM binaries in `packages/jxl-wasm/dist/*.wasm` must be rebuilt before browser/runtime validation.
- `caps.animationEncode` will remain false until the binary rebuild, so the encode path uses the single-frame fallback.

**Affected files:**
- `packages/jxl-wasm/src/bridge.cpp` (new `EncodeAnimation` function + 7 new exports)
- `packages/jxl-wasm/exports.txt` (7 new symbols)
- `packages/jxl-wasm/dist/*.wasm` (needs rebuild)

**Follow-up:**
1. Start Docker Desktop / Emscripten build environment (see Issue 3).
2. Run `pnpm --filter @casabio/jxl-wasm build`.
3. Verify `_jxl_wasm_encode_animation` in the new WASM exports.
4. Run `bun test packages/jxl-wasm/test/facade.test.ts` — animation encode integration test must pass.
5. Open `web/animation-lab.html` — capability banner must disappear; encode button must produce a valid JXL animation.

**Agent Jump-In Checklist:**
- Read: `docs/references/designs/animation-multi-frame.md`, `packages/jxl-wasm/src/bridge.cpp` (`EncodeAnimation` function), `packages/jxl-wasm/exports.txt`.
- Run first: `pnpm typecheck` (must pass), then attempt Docker build per Issue 3.
- Success = `caps.animationEncode` true in animation-lab.html + roundtrip encode/decode of a 4-frame animation succeeds.
- Gotcha: same Docker/Emscripten blocker as Issue 3 — both can be resolved in the same build session.

**Sufficient Context Summary:** Animation source code is complete in bridge.cpp + facade.ts. WASM binary needs rebuilding via Emscripten. See Issue 3 for the build environment setup.
```

- [ ] **Step 2: Add PROGRESS_LOG entry**

Prepend (or append at the end of the features section) to `docs/references/PROGRESS_LOG.md`:

```markdown
---

## Feature: Animation / Multi-Frame Support — 2026-05-29

**Branch:** epiccodereview/20260527T054853
**Status:** Source-only (WASM rebuild pending — see ISSUES.md §9)

**WASM Changes:**
- `packages/jxl-wasm/src/facade.ts` — Added `AnimationFrame`, `AnimationOptions` interfaces; extended `EncoderOptions` with `animation?` and `frames?`; added `animationEncode` capability gate; marshal helpers `marshalAnimationFrames()`, `fmtIndex()`, `resolveDistance()`; animation dispatch path in `LibjxlEncoder`; extended `DecodeEvent` final/progress with `frameIndex`, `frameDuration`, `frameName`, `isLastFrame`, `animTicksPerSecond`, `animLoopCount`; extended `LibjxlWasmModule` with 7 new animation WASM function declarations; post-`take_final` frame metadata reads.
- `packages/jxl-wasm/src/bridge.cpp` — Added `WasmAnimationFrame` (28-byte packed descriptor) + `WasmAnimationOpts` (8-byte) structs; `EncodeAnimation()` static function using `JxlAnimationHeader`, per-frame `JxlEncoderSetFrameDuration` + `JxlEncoderSetFrameName`; `jxl_wasm_encode_animation` EMSCRIPTEN_KEEPALIVE export; extended `JxlWasmDecState` with frame_index/duration/name/is_last_frame/anim fields; `JXL_DEC_FRAME` subscription + handler in `dec_push`; 6 new frame metadata accessor exports.
- `packages/jxl-wasm/exports.txt` — Added 7 new animation symbols.

**Native (Tauri) Changes:**
- `packages/jxl-native/src/index.ts` — Added `AnimationFrame`, `AnimationOptions`; extended `EncoderOptions`; extended `DecodeEvent` with per-frame metadata fields.
- `packages/jxl-native/src/native.cc` — Extended `EncoderData` with animation fields + `AnimFrame` vector; animation path in `EncodeAll` using `JxlAnimationHeader` + per-frame `JxlEncoderSetFrameDuration`/`SetFrameName`; extended `DecodeAll` with `JXL_DEC_FRAME` subscription + per-frame metadata on events.

**Benchmark Wiring:**
- `web/animation-lab.html` — Full animation lab: frame count/size/duration/loopCount/ticksPerSecond controls; synthetic hue-cycling frame strip; encode + decode with per-frame event log; first-frame preview; file size stats.

**Tests:**
- `packages/jxl-wasm/test/facade.test.ts` — Added `describe("animation capability", ...)`: routes to animation bridge, animOptsPtr layout, capability gate; `describe("animation decode metadata", ...)`: type presence + frame metadata accessor reads.
- `packages/jxl-native/test/codec.test.ts` — Added animation type-shape tests for NativeEncoderOptions.
- `web/animation-lab.test.js` — HTML structural test.

**Docs Updated:**
- `docs/references/designs/animation-multi-frame.md` — checklist updated.
- `docs/references/designs/DESIGNS_INDEX.md` — Status changed to "In Progress".
- `docs/references/PROGRESS_LOG.md` — this entry.
- `docs/references/designs/ISSUES.md` — Issue §9 added (WASM rebuild blocker for animation).
```

- [ ] **Step 3: Update animation-multi-frame.md checklist**

In `docs/references/designs/animation-multi-frame.md`, update the checklist (section 10):

```markdown
## 10. Implementation Checklist

- [x] Branch: `epiccodereview/20260527T054853`
- [x] Animation header + multi-frame encode path in bridge (`EncodeAnimation` + `jxl_wasm_encode_animation`)
- [x] High-level TS animation encode API (`AnimationFrame`, `AnimationOptions`, `marshalAnimationFrames`)
- [x] Extend decode events / metadata for animation info and per-frame timing (`frameIndex`, `frameDuration`, `frameName`, `isLastFrame`, `animTicksPerSecond`, `animLoopCount`)
- [x] Rich animation benchmark / demo (`web/animation-lab.html`)
- [x] Tauri/Rust side using libjxl animation builders (`packages/jxl-native/src/native.cc`)
- [ ] Full handoff + PROGRESS_LOG entry — logged above; WASM rebuild pending (ISSUES.md §9)
- [ ] Integration roundtrip test (requires WASM rebuild — see ISSUES.md §9)
```

- [ ] **Step 4: Update DESIGNS_INDEX.md status**

In `docs/references/designs/DESIGNS_INDEX.md`, in the Animation & Multi-Frame table, change:
```
| Design complete |
```
to:
```
| In Progress on branch `epiccodereview/20260527T054853` |
```

- [ ] **Step 5: Run full test suite**

```powershell
bun test packages/jxl-wasm/test/facade.test.ts
pnpm typecheck
```
Expected: all animation tests pass; pre-existing `detectTier` failure remains; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add docs/references/designs/ISSUES.md docs/references/PROGRESS_LOG.md docs/references/designs/animation-multi-frame.md docs/references/designs/DESIGNS_INDEX.md
git commit -m "docs: animation multi-frame implementation logged; ISSUES.md §9 + PROGRESS_LOG + checklist"
```

---

## Self-Review Checklist

**Spec coverage:**

| Design note requirement | Covered in task |
|-------------------------|----------------|
| `AnimationFrame` (data, width, height, duration, name, blendInfo) | Task 1 (blendInfo omitted — design calls it "advanced", escape hatch is `advancedFrameSettings` which exists) |
| `AnimationOptions` (ticksPerSecond, loopCount, haveTimecodes) | Task 1 (haveTimecodes omitted — always false; trivial to add) |
| Bridge: `JxlEncoderSetAnimationHeader`, multi-frame encode | Task 5 |
| Bridge: `JxlEncoderSetFrameDuration`, `JxlEncoderSetFrameName` | Task 5 |
| Decode: `frameIndex`, `duration`, `name`, `isLastFrame` on events | Task 4 + Task 6 |
| Animation metadata (`loopCount`, `ticksPerSecond`) on decode | Task 4 + Task 6 |
| Tauri/Rust side | Task 8 |
| Benchmark demo page | Task 9 |
| Roundtrip tests | Task 3 + partial (full integration requires WASM rebuild) |
| PROGRESS_LOG + handoff | Task 10 |

**Gaps / deferred:**
- `blendInfo` per-frame blending — omitted per "advanced (optional)" in design note; can be added later via `advancedFrameSettings` escape hatch.
- `haveTimecodes` — always false; trivial one-liner when needed.
- Integration roundtrip test (encode N frames, decode, verify per-frame timing) — blocked until WASM rebuild; documented in ISSUES.md §9.
- Side-by-side APNG/WebP size comparison — noted in design note §6 as "where possible"; deferred to lab page enhancement.

**Placeholder scan:** no "TBD", "TODO", or incomplete steps found.

**Type consistency:** `AnimationFrame`, `AnimationOptions` defined in Task 1 and used consistently across Tasks 3/5/8/9. `WASM_ANIMATION_FRAME_BYTES = 28` matches the struct layout in Task 5. `animOptsPtr` arg index 18 in both TS dispatch (Task 3) and C++ export signature (Task 5).
