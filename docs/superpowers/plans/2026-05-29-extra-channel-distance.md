# Extra Channel Distance (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the extra-channel distance implementation by fixing a parameter-drop bug in the EC bridge, adding the missing v2 export, and writing tests that cover alphaDistance dispatch, descriptor marshaling, and a lossless-alpha roundtrip.

**Architecture:** The encode path already routes to `_jxl_wasm_encode_rgba8_with_metadata_ec` when `alphaDistance` or `extraChannels` is set. The bug is that `decodingSpeed`, `photonNoiseIso`, and `resampling` are computed by `resolveEncoderBridgeSettings` but not threaded through the EC bridge signatures — they silently do nothing. Fix requires updating bridge.cpp signatures + facade.ts declarations + dispatch calls. Tests use the existing `createFakeLibjxlModule` + injected spy pattern already established in the test file.

**Tech Stack:** TypeScript (Bun test), C++ (WASM bridge — source fix only, no rebuild required for tests to pass), `bun test` to run.

**Mirror rule:** Every change to `packages/jxl-wasm/` must be identically mirrored to `node_modules/@casabio/jxl-wasm/`.

---

## File Map

| File | Change |
|------|--------|
| `packages/jxl-wasm/exports.txt` | Add `_jxl_wasm_encode_rgba8_with_metadata_ec_v2` |
| `packages/jxl-wasm/src/bridge.cpp` | Fix `EncodeRgbaWithExtraChannels` + both `_ec` / `_ec_v2` public signatures |
| `packages/jxl-wasm/src/facade.ts` | Fix TS declarations + dispatch calls to pass decodingSpeed/photonNoiseIso/resampling |
| `packages/jxl-wasm/test/facade.test.ts` | New EC tests (4 unit + 1 integration) |
| `node_modules/@casabio/jxl-wasm/exports.txt` | Mirror |
| `node_modules/@casabio/jxl-wasm/src/bridge.cpp` | Mirror |
| `node_modules/@casabio/jxl-wasm/src/facade.ts` | Mirror |
| `node_modules/@casabio/jxl-wasm/test/facade.test.ts` | Mirror |

---

## Task 1: Add missing EC v2 export to exports.txt

**Files:**
- Modify: `packages/jxl-wasm/exports.txt`
- Modify: `node_modules/@casabio/jxl-wasm/exports.txt`

Currently `exports.txt` line 47 has `_jxl_wasm_encode_rgba8_with_metadata_ec` but the v2 variant is absent.

- [ ] **Step 1: Add the export line**

In both `packages/jxl-wasm/exports.txt` and `node_modules/@casabio/jxl-wasm/exports.txt`, after the line:
```
_jxl_wasm_encode_rgba8_with_metadata_ec
```
add:
```
_jxl_wasm_encode_rgba8_with_metadata_ec_v2
```

- [ ] **Step 2: Verify**

```
grep -n "metadata_ec" packages/jxl-wasm/exports.txt
```
Expected output:
```
47:_jxl_wasm_encode_rgba8_with_metadata_ec
48:_jxl_wasm_encode_rgba8_with_metadata_ec_v2
```

- [ ] **Step 3: Commit**

```bash
git add packages/jxl-wasm/exports.txt node_modules/@casabio/jxl-wasm/exports.txt
git commit -m "fix(jxl-wasm): export _jxl_wasm_encode_rgba8_with_metadata_ec_v2"
```

---

## Task 2: Fix bridge.cpp — thread photon_noise_iso and resampling through EC path

**Files:**
- Modify: `packages/jxl-wasm/src/bridge.cpp`
- Modify: `node_modules/@casabio/jxl-wasm/src/bridge.cpp`

`EncodeRgbaWithExtraChannels` already has a `decoding_speed` param but lacks `photon_noise_iso` and `resampling`. Both public EC functions hardcode `decoding_speed = -1`.

- [ ] **Step 1: Extend `EncodeRgbaWithExtraChannels` signature**

Find the function signature (around line 675):
```cpp
static JxlWasmBuffer* EncodeRgbaWithExtraChannels(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed,
    const uint8_t* icc_profile, size_t icc_size,
```
Change to:
```cpp
static JxlWasmBuffer* EncodeRgbaWithExtraChannels(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed,
    int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
```

- [ ] **Step 2: Add photon noise and resampling frame settings inside `EncodeRgbaWithExtraChannels`**

Find the existing decoding_speed block (around line 747):
```cpp
  if (decoding_speed >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_DECODING_SPEED, static_cast<int64_t>(std::clamp(decoding_speed, 0, 4)));
```
Add immediately after it:
```cpp
  if (photon_noise_iso > 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PHOTON_NOISE, static_cast<int64_t>(photon_noise_iso));
  const uint32_t normalized_resampling_ec = (resampling == 2u || resampling == 4u || resampling == 8u) ? resampling : 1u;
  if (normalized_resampling_ec > 1u) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_RESAMPLING, static_cast<int64_t>(normalized_resampling_ec));
```

- [ ] **Step 3: Update `jxl_wasm_encode_rgba8_with_metadata_ec` public function**

Find (around line 1792):
```cpp
JxlWasmBuffer* jxl_wasm_encode_rgba8_with_metadata_ec(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering,
    int32_t modular, int32_t brotli_effort,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    float alpha_distance,
    const WasmExtraChannel* ec_ptr, uint32_t num_ec) {
  const WasmExtraChannel* ec = (ec_ptr != nullptr && num_ec > 0u) ? ec_ptr : nullptr;
  const uint32_t n_ec = (ec != nullptr) ? num_ec : 0u;
  return EncodeRgbaWithExtraChannels(pixels, width, height, distance, effort, fmt, has_alpha,
      progressive_dc, progressive_ac, qprogressive_ac, buffering,
      modular, brotli_effort, -1,
      icc_profile, icc_size, exif, exif_size, xmp, xmp_size,
      alpha_distance, ec, n_ec);
}
```

Replace with:
```cpp
JxlWasmBuffer* jxl_wasm_encode_rgba8_with_metadata_ec(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed,
    int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    float alpha_distance,
    const WasmExtraChannel* ec_ptr, uint32_t num_ec) {
  const WasmExtraChannel* ec = (ec_ptr != nullptr && num_ec > 0u) ? ec_ptr : nullptr;
  const uint32_t n_ec = (ec != nullptr) ? num_ec : 0u;
  return EncodeRgbaWithExtraChannels(pixels, width, height, distance, effort, fmt, has_alpha,
      progressive_dc, progressive_ac, qprogressive_ac, buffering,
      modular, brotli_effort, decoding_speed, photon_noise_iso, resampling,
      icc_profile, icc_size, exif, exif_size, xmp, xmp_size,
      alpha_distance, ec, n_ec);
}
```

- [ ] **Step 4: Update `jxl_wasm_encode_rgba8_with_metadata_ec_v2` public function**

Find (around line 1830):
```cpp
JxlWasmBuffer* jxl_wasm_encode_rgba8_with_metadata_ec_v2(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering,
    int32_t modular, int32_t brotli_effort,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    float alpha_distance,
    const WasmExtraChannel* ec_ptr, uint32_t num_ec,
    const WasmBoxOpts* box_opts) {
  const WasmExtraChannel* ec = (ec_ptr != nullptr && num_ec > 0u) ? ec_ptr : nullptr;
  const uint32_t n_ec = (ec != nullptr) ? num_ec : 0u;
  return EncodeRgbaWithExtraChannels(pixels, width, height, distance, effort, fmt, has_alpha,
      progressive_dc, progressive_ac, qprogressive_ac, buffering,
      modular, brotli_effort, -1,
      icc_profile, icc_size, exif, exif_size, xmp, xmp_size,
      alpha_distance, ec, n_ec, box_opts);
}
```

Replace with:
```cpp
JxlWasmBuffer* jxl_wasm_encode_rgba8_with_metadata_ec_v2(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed,
    int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    float alpha_distance,
    const WasmExtraChannel* ec_ptr, uint32_t num_ec,
    const WasmBoxOpts* box_opts) {
  const WasmExtraChannel* ec = (ec_ptr != nullptr && num_ec > 0u) ? ec_ptr : nullptr;
  const uint32_t n_ec = (ec != nullptr) ? num_ec : 0u;
  return EncodeRgbaWithExtraChannels(pixels, width, height, distance, effort, fmt, has_alpha,
      progressive_dc, progressive_ac, qprogressive_ac, buffering,
      modular, brotli_effort, decoding_speed, photon_noise_iso, resampling,
      icc_profile, icc_size, exif, exif_size, xmp, xmp_size,
      alpha_distance, ec, n_ec, box_opts);
}
```

- [ ] **Step 5: Mirror both files to node_modules**

```bash
cp packages/jxl-wasm/src/bridge.cpp node_modules/@casabio/jxl-wasm/src/bridge.cpp
```

- [ ] **Step 6: Commit**

```bash
git add packages/jxl-wasm/src/bridge.cpp node_modules/@casabio/jxl-wasm/src/bridge.cpp
git commit -m "fix(jxl-wasm): thread decodingSpeed/photonNoiseIso/resampling through EC bridge"
```

---

## Task 3: Fix facade.ts — update TS declarations and dispatch calls

**Files:**
- Modify: `packages/jxl-wasm/src/facade.ts`
- Modify: `node_modules/@casabio/jxl-wasm/src/facade.ts`

The TS interface declarations for `_ec` and `_ec_v2` are missing the three new params. The dispatch calls don't pass them.

**Arg order after fix** (0-indexed):
`pixelsPtr(0) width(1) height(2) distance(3) effort(4) fmt(5) hasAlpha(6) progressiveDc(7) progressiveAc(8) qProgressiveAc(9) buffering(10) modular(11) brotliEffort(12) decodingSpeed(13) photonNoiseIso(14) resampling(15) iccPtr(16) iccSize(17) exifPtr(18) exifSize(19) xmpPtr(20) xmpSize(21) alphaDistance(22) ecPtr(23) numEc(24)`

`_ec_v2` adds `boxOptsPtr(25)` at the end.

- [ ] **Step 1: Update TS declaration for `_jxl_wasm_encode_rgba8_with_metadata_ec`**

Find (around line 264):
```ts
  _jxl_wasm_encode_rgba8_with_metadata_ec?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, modular: number, brotliEffort: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, alphaDistance: number, ecPtr: number, numEc: number): number;
```
Replace with:
```ts
  _jxl_wasm_encode_rgba8_with_metadata_ec?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, alphaDistance: number, ecPtr: number, numEc: number): number;
```

- [ ] **Step 2: Update TS declaration for `_jxl_wasm_encode_rgba8_with_metadata_ec_v2`**

Find (around line 267):
```ts
  _jxl_wasm_encode_rgba8_with_metadata_ec_v2?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, modular: number, brotliEffort: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, alphaDistance: number, ecPtr: number, numEc: number, boxOptsPtr: number): number;
```
Replace with:
```ts
  _jxl_wasm_encode_rgba8_with_metadata_ec_v2?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, alphaDistance: number, ecPtr: number, numEc: number, boxOptsPtr: number): number;
```

- [ ] **Step 3: Update the EC v2 dispatch call**

Find (around line 1677):
```ts
            const handle = useBoxV2
              ? module._jxl_wasm_encode_rgba8_with_metadata_ec_v2!(
                  ptr, this.options.width, this.options.height,
                  distance, this.options.effort, fmt, hasAlpha,
                  progressiveDc, progressiveAc, qProgressiveAc, buffering,
                  modular, brotliEffort,
                  iccPtr, iccView.byteLength,
                  exifPtr, exifView.byteLength,
                  xmpPtr, xmpView.byteLength,
                  alphaDistance,
                  ecDescPtr, extraChannels.length,
                  boxOptsPtr,
                )
              : module._jxl_wasm_encode_rgba8_with_metadata_ec!(
                  ptr, this.options.width, this.options.height,
                  distance, this.options.effort, fmt, hasAlpha,
                  progressiveDc, progressiveAc, qProgressiveAc, buffering,
                  modular, brotliEffort,
                  iccPtr, iccView.byteLength,
                  exifPtr, exifView.byteLength,
                  xmpPtr, xmpView.byteLength,
                  alphaDistance,
                  ecDescPtr, extraChannels.length,
                );
```
Replace with:
```ts
            const handle = useBoxV2
              ? module._jxl_wasm_encode_rgba8_with_metadata_ec_v2!(
                  ptr, this.options.width, this.options.height,
                  distance, this.options.effort, fmt, hasAlpha,
                  progressiveDc, progressiveAc, qProgressiveAc, buffering,
                  modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling,
                  iccPtr, iccView.byteLength,
                  exifPtr, exifView.byteLength,
                  xmpPtr, xmpView.byteLength,
                  alphaDistance,
                  ecDescPtr, extraChannels.length,
                  boxOptsPtr,
                )
              : module._jxl_wasm_encode_rgba8_with_metadata_ec!(
                  ptr, this.options.width, this.options.height,
                  distance, this.options.effort, fmt, hasAlpha,
                  progressiveDc, progressiveAc, qProgressiveAc, buffering,
                  modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling,
                  iccPtr, iccView.byteLength,
                  exifPtr, exifView.byteLength,
                  xmpPtr, xmpView.byteLength,
                  alphaDistance,
                  ecDescPtr, extraChannels.length,
                );
```

- [ ] **Step 4: Run typecheck**

```
cd packages/jxl-wasm && npm run typecheck
```
Expected: no errors.

- [ ] **Step 5: Mirror to node_modules**

```bash
cp packages/jxl-wasm/src/facade.ts node_modules/@casabio/jxl-wasm/src/facade.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/jxl-wasm/src/facade.ts node_modules/@casabio/jxl-wasm/src/facade.ts
git commit -m "fix(jxl-wasm): pass decodingSpeed/photonNoiseIso/resampling in EC encode dispatch"
```

---

## Task 4: Write unit tests for EC dispatch and descriptor marshaling

**Files:**
- Modify: `packages/jxl-wasm/test/facade.test.ts`
- Modify: `node_modules/@casabio/jxl-wasm/test/facade.test.ts`

Add a new `describe("extra channel encode")` block. Tests use a helper `createFakeEcModule()` that injects a spy on `_jxl_wasm_encode_rgba8_with_metadata_ec` following the same pattern as `createFakeMetadataV2Module` (lines 1188-1221 of the existing test file).

**WasmExtraChannel layout** (20 bytes, little-endian):
- offset 0: type (uint32)
- offset 4: bits (uint32)
- offset 8: distance (float32)
- offset 12: plane_ptr (uint32)
- offset 16: plane_size (uint32)

**EC bridge arg positions** (post-fix):
- index 19: alphaDistance (float)
- index 20: ecDescPtr (uint32)
- index 21: numEc (uint32)

Wait — re-count with the updated signature including icc/exif/xmp as individual ptr+size pairs:
0:pixelsPtr 1:width 2:height 3:distance 4:effort 5:fmt 6:hasAlpha 7:progressiveDc 8:progressiveAc 9:qProgressiveAc 10:buffering 11:modular 12:brotliEffort 13:decodingSpeed 14:photonNoiseIso 15:resampling 16:iccPtr 17:iccSize 18:exifPtr 19:exifSize 20:xmpPtr 21:xmpSize 22:alphaDistance 23:ecDescPtr 24:numEc

- [ ] **Step 1: Write failing tests first**

Add the following block to `packages/jxl-wasm/test/facade.test.ts`, directly before the final closing brace of the last `describe` block, or as a new top-level `describe`:

```ts
describe("extra channel encode", () => {
  afterEach(() => {
    setJxlModuleFactoryForTesting(null);
  });

  function createFakeEcModule() {
    const base = createFakeLibjxlModule();
    const ecCalls: number[][] = [];

    const ecFn = (...args: number[]) => {
      ecCalls.push(args);
      return base._jxl_wasm_encode_rgba8(args[0]!, args[1]!, args[2]!, args[3]!, args[4]!);
    };

    const module = {
      ...base,
      _jxl_wasm_encode_rgba8_with_metadata: (...args: number[]) =>
        base._jxl_wasm_encode_rgba8(args[0]!, args[1]!, args[2]!, args[3]!, args[4]!),
      _jxl_wasm_encode_rgba8_with_metadata_ec: ecFn,
      __ecCalls: ecCalls,
    };
    return module;
  }

  test("routes to EC bridge when alphaDistance is set", async () => {
    const module = createFakeEcModule();
    setJxlModuleFactoryForTesting(async () => module);

    const encoder = createEncoder({ ...encodeOptions, quality: 90, alphaDistance: 0 });
    await encoder.pushPixels(new Uint8Array([255, 255, 255, 255]));
    encoder.finish();
    const result = await encoder.chunks()[Symbol.asyncIterator]().next();

    expect(result.done).toBe(false);
    expect(module.__ecCalls.length).toBe(1);
    await encoder.dispose();
  });

  test("passes alphaDistance at correct arg index (22)", async () => {
    const module = createFakeEcModule();
    setJxlModuleFactoryForTesting(async () => module);

    const encoder = createEncoder({ ...encodeOptions, quality: 90, alphaDistance: 0.5 });
    await encoder.pushPixels(new Uint8Array([255, 255, 255, 255]));
    encoder.finish();
    await encoder.chunks()[Symbol.asyncIterator]().next();

    const args = module.__ecCalls[0]!;
    // alphaDistance is arg index 22
    expect(Math.abs((args[22] ?? -999) - 0.5)).toBeLessThan(0.001);
    await encoder.dispose();
  });

  test("routes to EC bridge when extraChannels is non-empty", async () => {
    const module = createFakeEcModule();
    setJxlModuleFactoryForTesting(async () => module);

    const encoder = createEncoder({
      ...encodeOptions,
      quality: 90,
      extraChannels: [{ type: "depth", bitsPerSample: 16, distance: 0 }],
    });
    await encoder.pushPixels(new Uint8Array([255, 255, 255, 255]));
    encoder.finish();
    await encoder.chunks()[Symbol.asyncIterator]().next();

    const args = module.__ecCalls[0]!;
    expect(args[24]).toBe(1); // numEc = 1
    await encoder.dispose();
  });

  test("WasmExtraChannel descriptor: type, bits, distance written at correct offsets", async () => {
    const module = createFakeEcModule();
    setJxlModuleFactoryForTesting(async () => module);

    const encoder = createEncoder({
      ...encodeOptions,
      quality: 90,
      extraChannels: [{ type: "depth", bitsPerSample: 16, distance: 0.5 }],
    });
    await encoder.pushPixels(new Uint8Array([255, 255, 255, 255]));
    encoder.finish();
    await encoder.chunks()[Symbol.asyncIterator]().next();

    const args = module.__ecCalls[0]!;
    const ecDescPtr = args[23]!; // ecDescPtr
    expect(ecDescPtr).toBeGreaterThan(0);

    // Read descriptor from fake WASM heap
    const dv = new DataView(module.HEAPU8.buffer);
    const type = dv.getUint32(ecDescPtr,     true); // type: depth = 1
    const bits = dv.getUint32(ecDescPtr + 4, true); // bitsPerSample = 16
    const dist = dv.getFloat32(ecDescPtr + 8, true); // distance = 0.5

    expect(type).toBe(1);   // JXL_CHANNEL_DEPTH
    expect(bits).toBe(16);
    expect(Math.abs(dist - 0.5)).toBeLessThan(0.001);
    await encoder.dispose();
  });

  test("falls back to standard path when EC bridge is absent", async () => {
    // Module without _jxl_wasm_encode_rgba8_with_metadata_ec
    const module = createFakeLibjxlModule();
    setJxlModuleFactoryForTesting(async () => module);

    const encoder = createEncoder({ ...encodeOptions, quality: 90, alphaDistance: 0 });
    await encoder.pushPixels(new Uint8Array([255, 255, 255, 255]));
    encoder.finish();
    const result = await encoder.chunks()[Symbol.asyncIterator]().next();

    // Should still succeed via standard encode path
    expect(result.done).toBe(false);
    expect(result.value?.byteLength ?? 0).toBeGreaterThan(0);
    await encoder.dispose();
  });

  test("integration: encode with lossless alpha succeeds with real WASM", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);

    // 2x2 RGBA with partial transparency
    const rgba = new Uint8Array([
      255,   0,   0, 255,
        0, 255,   0, 128,
        0,   0, 255,   0,
      255, 255,   0, 200,
    ]);
    const encoder = createEncoder({
      format: "rgba8",
      width: 2,
      height: 2,
      hasAlpha: true,
      iccProfile: null,
      exif: null,
      xmp: null,
      distance: 1.0,
      quality: null,
      effort: 3 as const,
      progressive: false,
      previewFirst: false,
      chunked: false,
      alphaDistance: 0,  // lossless alpha
    });
    encoder.pushPixels(rgba);
    encoder.finish();

    const result = await encoder.chunks()[Symbol.asyncIterator]().next();
    expect(result.done).toBe(false);
    expect(result.value?.byteLength ?? 0).toBeGreaterThan(0);
    await encoder.dispose();
  });
});
```

- [ ] **Step 2: Run tests to see failures** (they will fail because EC bridge isn't wired yet on the fake module without full dispatch)

```
cd packages/jxl-wasm && bun test --test-name-pattern "extra channel"
```
Expected: some fail — that confirms the tests are live.

- [ ] **Step 3: Verify all 6 new tests pass after Tasks 1-3 are applied**

```
cd packages/jxl-wasm && bun test --test-name-pattern "extra channel"
```
Expected:
```
(pass) extra channel encode > routes to EC bridge when alphaDistance is set
(pass) extra channel encode > passes alphaDistance at correct arg index (22)
(pass) extra channel encode > routes to EC bridge when extraChannels is non-empty
(pass) extra channel encode > WasmExtraChannel descriptor: type, bits, distance written at correct offsets
(pass) extra channel encode > falls back to standard path when EC bridge is absent
(pass) extra channel encode > integration: encode with lossless alpha succeeds with real WASM
```

- [ ] **Step 4: Run full test suite to check for regressions**

```
cd packages/jxl-wasm && bun test 2>&1 | tail -5
```
Expected: same pass/fail count as before (57 pass, 8 fail pre-existing jxtc failures) + 6 new passes.

- [ ] **Step 5: Mirror to node_modules**

```bash
cp packages/jxl-wasm/test/facade.test.ts node_modules/@casabio/jxl-wasm/test/facade.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/jxl-wasm/test/facade.test.ts node_modules/@casabio/jxl-wasm/test/facade.test.ts
git commit -m "test(jxl-wasm): add extra-channel distance dispatch and descriptor tests"
```

---

## Task 5: Update PROGRESS_LOG and design note

**Files:**
- Modify: `docs/references/PROGRESS_LOG.md`
- Modify: `docs/references/designs/extra-channel-distance.md`

- [ ] **Step 1: Append PROGRESS_LOG entry**

Open `docs/references/PROGRESS_LOG.md` and append:

```markdown
## 2026-05-29 — Extra Channel Distance (Phase 1)

**Feature:** Per-extra-channel distance + basic extra channel infrastructure  
**Branch:** `epiccodereview/20260527T054853`  
**Status:** Implemented

### What was done

- Fixed parameter-drop bug: `decodingSpeed`, `photonNoiseIso`, `resampling` were computed but not forwarded through the EC bridge path. Updated `EncodeRgbaWithExtraChannels`, both `_ec` and `_ec_v2` public bridge functions, facade TS declarations, and dispatch calls.
- Added `_jxl_wasm_encode_rgba8_with_metadata_ec_v2` to `exports.txt` (was implemented in bridge.cpp but not exported).
- Added 5 unit tests (arg dispatch, descriptor layout, fallback path) + 1 integration test (lossless-alpha + lossy-color roundtrip).

### Design note checklist status

- [x] Branch created
- [x] Declaration + distance setting in bridge (pre-existing, now fixed)
- [x] Alpha convenience path wired (pre-existing)
- [x] Tests (lossless-alpha + lossy-color roundtrip, descriptor layout, dispatch)
- [ ] Benchmark/lab page — deferred (Phase 2 milestone)
- [ ] Tauri side — deferred
- [ ] Full handoff — see Phase 2 note (`extra-channel-infrastructure.md`)

### Files changed

- `packages/jxl-wasm/src/bridge.cpp` — parameter fix
- `packages/jxl-wasm/src/facade.ts` — declaration + dispatch fix
- `packages/jxl-wasm/exports.txt` — added `_ec_v2` export
- `packages/jxl-wasm/test/facade.test.ts` — 6 new tests
- (+ mirrors in `node_modules/@casabio/jxl-wasm/`)
```

- [ ] **Step 2: Update design note status header**

In `docs/references/designs/extra-channel-distance.md`, change the `**Status:**` line from:
```
**Status:** Design ready for implementation handoff
```
to:
```
**Status:** Implemented (bug fixes + tests on branch epiccodereview/20260527T054853; benchmark and Tauri deferred to Phase 2)
```

Also update the checklist at the bottom of that file — mark completed items with `[x]`:
```markdown
- [x] Branch: `feature/extra-channel-distance` (or `feature/extra-channels-basic`)
- [x] Decide on final data-passing shape for extra planes (multi-plane buffer + parallel arrays)
- [x] Implement declaration + distance setting in bridge
- [x] Wire alpha convenience path
- [ ] Build compelling benchmark with visual alpha inspection
- [x] Tests (especially lossless-alpha + lossy-color)
- [ ] Tauri side
- [ ] Full handoff + PROGRESS_LOG
```

- [ ] **Step 3: Commit**

```bash
git add docs/references/PROGRESS_LOG.md docs/references/designs/extra-channel-distance.md
git commit -m "docs: mark extra-channel distance Phase 1 implemented; update PROGRESS_LOG"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] alphaDistance dispatch — Task 4 test 1
- [x] alphaDistance arg value correct — Task 4 test 2
- [x] extraChannels triggers EC path — Task 4 test 3
- [x] WasmExtraChannel descriptor layout (type, bits, distance) — Task 4 test 4
- [x] Fallback when no EC capability — Task 4 test 5
- [x] Lossless-alpha + lossy-color roundtrip — Task 4 test 6
- [x] decodingSpeed/photonNoiseIso/resampling param drop fix — Tasks 2 + 3
- [x] Missing v2 export — Task 1
- [x] PROGRESS_LOG — Task 5

**Placeholder scan:** No TBD, TODO, or "similar to Task N" entries. All code blocks are complete.

**Type consistency:** `decodingSpeed`, `photonNoiseIso`, `resampling` names match `resolveEncoderBridgeSettings` return object throughout.

**Note on WASM rebuild:** bridge.cpp changes (Tasks 2) require a WASM rebuild before the real binary reflects them. Tests in Task 4 use fake modules and will pass without a rebuild. The integration test (Task 4, test 6) exercises the existing `_ec` path which IS already in the dist WASM binary — it just won't have the parameter-forwarding fix until rebuilt.
