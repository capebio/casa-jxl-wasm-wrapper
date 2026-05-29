# C2: JXTC Container Encode + Round-Trip ROI Decode (Native Parity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port JXTC tile-container encode + region decode from WASM (bridge.cpp) to the jxl-native N-API addon (native.cc), achieving full round-trip bitstream compatibility with the WASM implementation.

**Architecture:** The JXTC format is a custom container ('JXTC' magic + 32-byte header + 8B-per-tile index + N independent standalone JXL codestreams). We add two synchronous N-API exports (`encodeJxtcRgba8` / `decodeJxtcRegionRgba8`) directly in native.cc using the same libjxl already linked — no Emscripten, no streaming. TypeScript wrappers in index.ts expose them with the same interface shape as the WASM facade.

**Tech Stack:** libjxl (already linked in binding.gyp), N-API v8, node-gyp, TypeScript, bun test

---

## File Map

| File | Change |
|------|--------|
| `packages/jxl-native/src/native.cc` | Add JXTC constants, `JxtcEncodeOneTile`, `JxtcDecodeOneTile`, `EncodeJxtcRgba8` (N-API), `DecodeJxtcRegionRgba8` (N-API), register in `Init` |
| `packages/jxl-native/src/index.ts` | Add `JxtcEncodeOptions`, `JxtcDecodeResult` interfaces; extend `NativeBinding`; add exported `encodeJxtcRgba8` + `decodeJxtcRegionRgba8` functions |
| `packages/jxl-native/test/codec.test.ts` | Add 3 source-inspection tests + 3 runtime roundtrip tests |
| `docs/FEATURE_PARITY_MATRIX.md` | Row 3.3 `❌` → `✅` |
| `docs/references/PROGRESS_LOG.md` | Prepend C2 entry |

---

## JXTC Format Reference (from bridge.cpp lines 1195–1505)

```
[Header 32 bytes]
  offset  0: uint32 magic     = 0x4354584A ('JXTC' little-endian)
  offset  4: uint32 version   = 1
  offset  8: uint32 image_w
  offset 12: uint32 image_h
  offset 16: uint32 tile_size
  offset 20: uint32 tiles_x   = ceil(image_w / tile_size)
  offset 24: uint32 tiles_y   = ceil(image_h / tile_size)
  offset 28: uint32 flags     = bit0 has_alpha

[Index  8 bytes × tile_count]
  per tile: uint32 byte_offset, uint32 byte_length
  tile index = ty * tiles_x + tx (row-major)

[N standalone JXL codestreams]
  each is a complete, self-contained JXL bitstream encoded with RGBA8/RGB8
```

---

## Task 1: Write failing source-inspection tests

**Files:**
- Modify: `packages/jxl-native/test/codec.test.ts`

- [ ] **Step 1: Append JXTC source-inspection describe block**

Add at the end of `packages/jxl-native/test/codec.test.ts`:

```typescript
describe("JXTC tile container in native index.ts", () => {
  test("JxtcEncodeOptions interface is defined", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toContain("export interface JxtcEncodeOptions");
    expect(source).toContain("distance?: number");
    expect(source).toContain("effort?: number");
    expect(source).toContain("hasAlpha?: boolean");
  });

  test("JxtcDecodeResult interface is defined", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toContain("export interface JxtcDecodeResult");
    expect(source).toContain("pixels: ArrayBuffer");
    expect(source).toContain("width: number");
    expect(source).toContain("height: number");
  });

  test("NativeBinding has encodeJxtcRgba8 and decodeJxtcRegionRgba8", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toContain("encodeJxtcRgba8?:");
    expect(source).toContain("decodeJxtcRegionRgba8?:");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```powershell
bun test packages/jxl-native/test/codec.test.ts --testNamePattern "JXTC tile container"
```

Expected: 3 FAIL — "export interface JxtcEncodeOptions" not found.

- [ ] **Step 3: Commit failing tests**

```bash
git add packages/jxl-native/test/codec.test.ts
git commit -m "test(jxl-native): add failing JXTC source-inspection tests for C2"
```

---

## Task 2: Add TypeScript types and exported functions

**Files:**
- Modify: `packages/jxl-native/src/index.ts`

- [ ] **Step 1: Add interfaces after the `AnimationOptions` interface (around line 146)**

```typescript
export interface JxtcEncodeOptions {
  distance?: number;
  effort?: number;
  hasAlpha?: boolean;
}

export interface JxtcDecodeResult {
  pixels: ArrayBuffer;
  width: number;
  height: number;
}
```

- [ ] **Step 2: Extend NativeBinding interface — add two optional fields after `createEncoder?:`**

```typescript
  encodeJxtcRgba8?: (
    pixels: ArrayBuffer,
    width: number,
    height: number,
    tileSize: number,
    options?: JxtcEncodeOptions,
  ) => ArrayBuffer;
  decodeJxtcRegionRgba8?: (
    container: ArrayBuffer,
    x: number,
    y: number,
    w: number,
    h: number,
  ) => JxtcDecodeResult;
```

- [ ] **Step 3: Add exported standalone functions after the `createEncoder` function (around line 270)**

```typescript
export function encodeJxtcRgba8(
  pixels: ArrayBuffer | Uint8Array,
  width: number,
  height: number,
  tileSize: number,
  options?: JxtcEncodeOptions,
): ArrayBuffer {
  const binding = loadNativeBinding();
  if (typeof binding.encodeJxtcRgba8 !== "function") {
    throw new CapabilityMissing(
      "encodeJxtcRgba8 requires a rebuilt jxl-native addon with JXTC support",
    );
  }
  const buf =
    pixels instanceof Uint8Array
      ? pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength)
      : pixels;
  return binding.encodeJxtcRgba8(buf as ArrayBuffer, width, height, tileSize, options);
}

export function decodeJxtcRegionRgba8(
  container: ArrayBuffer | Uint8Array,
  x: number,
  y: number,
  w: number,
  h: number,
): JxtcDecodeResult {
  const binding = loadNativeBinding();
  if (typeof binding.decodeJxtcRegionRgba8 !== "function") {
    throw new CapabilityMissing(
      "decodeJxtcRegionRgba8 requires a rebuilt jxl-native addon with JXTC support",
    );
  }
  const buf =
    container instanceof Uint8Array
      ? container.buffer.slice(container.byteOffset, container.byteOffset + container.byteLength)
      : container;
  return binding.decodeJxtcRegionRgba8(buf as ArrayBuffer, x, y, w, h);
}
```

- [ ] **Step 4: Run source-inspection tests**

```powershell
bun test packages/jxl-native/test/codec.test.ts --testNamePattern "JXTC tile container"
```

Expected: 3 PASS.

- [ ] **Step 5: Run typecheck**

```powershell
cd packages/jxl-native && npx tsc --noEmit && cd ../..
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/jxl-native/src/index.ts
git commit -m "feat(jxl-native): add JxtcEncodeOptions/JxtcDecodeResult types and exported JXTC functions"
```

---

## Task 3: Write failing runtime roundtrip tests

**Files:**
- Modify: `packages/jxl-native/test/codec.test.ts`

- [ ] **Step 1: Add top-level imports for the new functions**

Find the existing import line at the top of the file:

```typescript
import { createDecoder, createEncoder, type DecodeEvent } from "../src/index";
```

Replace with:

```typescript
import {
  createDecoder,
  createEncoder,
  encodeJxtcRgba8,
  decodeJxtcRegionRgba8,
  type DecodeEvent,
} from "../src/index";
```

- [ ] **Step 2: Append runtime roundtrip describe block**

Add at the end of the file (after the JXTC source-inspection block from Task 1):

```typescript
describe("@casabio/jxl-native JXTC round-trip", () => {
  test("encode + decode full image (single tile)", async () => {
    expect(process.env.JXL_NATIVE_INCLUDE_DIR).toBe(nativeIncludeDir);
    expect(process.env.JXL_NATIVE_LIB_DIR).toBe(nativeLibDir);

    // 4×4 RGBA8 gradient — fits in one tile (tileSize=16)
    const pixels = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      pixels[i * 4 + 0] = i * 16;        // R
      pixels[i * 4 + 1] = 255 - i * 16;  // G
      pixels[i * 4 + 2] = 128;           // B
      pixels[i * 4 + 3] = 255;           // A
    }

    const container = encodeJxtcRgba8(pixels.buffer, 4, 4, 16, {
      distance: 0, effort: 1, hasAlpha: true,
    });
    expect(container.byteLength).toBeGreaterThan(32);

    // Verify JXTC magic bytes (little-endian 0x4354584A = 'JXTC')
    const header = new Uint8Array(container, 0, 4);
    expect(header[0]).toBe(0x4a); // 'J'
    expect(header[1]).toBe(0x58); // 'X'
    expect(header[2]).toBe(0x54); // 'T'
    expect(header[3]).toBe(0x43); // 'C'

    const result = decodeJxtcRegionRgba8(container, 0, 0, 4, 4);
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
    expect(result.pixels.byteLength).toBe(4 * 4 * 4);

    const decoded = new Uint8Array(result.pixels);
    for (let i = 0; i < 16; i++) {
      expect(Math.abs(decoded[i * 4 + 0] - pixels[i * 4 + 0])).toBeLessThanOrEqual(1);
      expect(Math.abs(decoded[i * 4 + 1] - pixels[i * 4 + 1])).toBeLessThanOrEqual(1);
      expect(Math.abs(decoded[i * 4 + 2] - pixels[i * 4 + 2])).toBeLessThanOrEqual(1);
    }
  });

  test("encode + decode multi-tile image with ROI per quadrant", async () => {
    expect(process.env.JXL_NATIVE_INCLUDE_DIR).toBe(nativeIncludeDir);
    expect(process.env.JXL_NATIVE_LIB_DIR).toBe(nativeLibDir);

    // 8×8 RGBA8 quadrant image: TL=red, TR=green, BL=blue, BR=white
    const pixels = new Uint8Array(8 * 8 * 4);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const i = (y * 8 + x) * 4;
        const right  = x >= 4;
        const bottom = y >= 4;
        pixels[i + 0] = (!right && !bottom) ? 255 : (right && !bottom) ? 0   : (right && bottom) ? 255 : 0;
        pixels[i + 1] = (!right && !bottom) ? 0   : (right && !bottom) ? 255 : (right && bottom) ? 255 : 0;
        pixels[i + 2] = (!right && !bottom) ? 0   : (right && !bottom) ? 0   : (right && bottom) ? 255 : 255;
        pixels[i + 3] = 255;
      }
    }

    // Encode with tileSize=4 → 2×2 = 4 tiles
    const container = encodeJxtcRgba8(pixels.buffer, 8, 8, 4, {
      distance: 0, effort: 1, hasAlpha: false,
    });

    // Verify header fields via DataView
    const dv = new DataView(container);
    expect(dv.getUint32(0, true)).toBe(0x4354584a); // magic
    expect(dv.getUint32(4, true)).toBe(1);           // version
    expect(dv.getUint32(8, true)).toBe(8);           // image_w
    expect(dv.getUint32(12, true)).toBe(8);          // image_h
    expect(dv.getUint32(16, true)).toBe(4);          // tile_size
    expect(dv.getUint32(20, true)).toBe(2);          // tiles_x
    expect(dv.getUint32(24, true)).toBe(2);          // tiles_y

    // Top-left tile (0,0,4,4) → should be predominantly red
    const tl = decodeJxtcRegionRgba8(container, 0, 0, 4, 4);
    expect(tl.width).toBe(4);
    expect(tl.height).toBe(4);
    const tlPx = new Uint8Array(tl.pixels);
    const tlCenter = (1 * 4 + 1) * 4; // pixel (1,1) in the tile
    expect(tlPx[tlCenter + 0]).toBeGreaterThan(200); // R high
    expect(tlPx[tlCenter + 1]).toBeLessThan(50);     // G low
    expect(tlPx[tlCenter + 2]).toBeLessThan(50);     // B low

    // Bottom-right tile (4,4,4,4) → should be predominantly white
    const br = decodeJxtcRegionRgba8(container, 4, 4, 4, 4);
    expect(br.width).toBe(4);
    expect(br.height).toBe(4);
    const brPx = new Uint8Array(br.pixels);
    const brCenter = (1 * 4 + 1) * 4;
    expect(brPx[brCenter + 0]).toBeGreaterThan(200); // R high
    expect(brPx[brCenter + 1]).toBeGreaterThan(200); // G high
    expect(brPx[brCenter + 2]).toBeGreaterThan(200); // B high
  });

  test("encode + decode cross-tile ROI strip spanning tile boundary", async () => {
    expect(process.env.JXL_NATIVE_INCLUDE_DIR).toBe(nativeIncludeDir);
    expect(process.env.JXL_NATIVE_LIB_DIR).toBe(nativeLibDir);

    // 8×4 RGBA8: left half (x<4) red, right half (x≥4) green
    const pixels = new Uint8Array(8 * 4 * 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 8; x++) {
        const i = (y * 8 + x) * 4;
        pixels[i + 0] = x < 4 ? 255 : 0;
        pixels[i + 1] = x < 4 ? 0 : 255;
        pixels[i + 2] = 0;
        pixels[i + 3] = 255;
      }
    }

    const container = encodeJxtcRgba8(pixels.buffer, 8, 4, 4, {
      distance: 0, effort: 1, hasAlpha: false,
    });

    // Cross-tile strip: x=3..4, y=0..3 (spans the left→right tile boundary)
    const strip = decodeJxtcRegionRgba8(container, 3, 0, 2, 4);
    expect(strip.width).toBe(2);
    expect(strip.height).toBe(4);
    const stripPx = new Uint8Array(strip.pixels);

    for (let row = 0; row < 4; row++) {
      const leftIdx  = (row * 2 + 0) * 4; // x=3 in output → red
      const rightIdx = (row * 2 + 1) * 4; // x=4 in output → green
      expect(stripPx[leftIdx  + 0]).toBeGreaterThan(200); // R at x=3
      expect(stripPx[leftIdx  + 1]).toBeLessThan(50);     // G at x=3
      expect(stripPx[rightIdx + 0]).toBeLessThan(50);     // R at x=4
      expect(stripPx[rightIdx + 1]).toBeGreaterThan(200); // G at x=4
    }
  });
});
```

- [ ] **Step 3: Run tests to confirm failure mode**

```powershell
$env:JXL_NATIVE_INCLUDE_DIR = "C:\Foo\raw-converter\target\release\build\jpegxl-sys-26f294f2024eaecb\out\include"
$env:JXL_NATIVE_LIB_DIR = "C:\TEMP\jxl-mt-libs"
bun test packages/jxl-native/test/codec.test.ts --testNamePattern "JXTC round-trip"
```

Expected: 3 FAIL — `CapabilityMissing: encodeJxtcRgba8 requires a rebuilt jxl-native addon with JXTC support`.

- [ ] **Step 4: Commit failing tests**

```bash
git add packages/jxl-native/test/codec.test.ts
git commit -m "test(jxl-native): add failing JXTC runtime roundtrip tests for C2"
```

---

## Task 4: Port JXTC C++ to native.cc

**Note (2026-06 session):** After completing the RAW Tauri Selective easy wins (Items 5+9 + Item 4 early-return) + C3 polish and creating the B5 handoff, we deliberately did **not** tackle this 349-line C++ insertion in the same session.

Reasons:
- Large self-contained port (exact code block already in this plan) that requires dedicated focus, addon rebuild, new test runs, and bitstream compatibility verification with the WASM side.
- Better done as its own focused slice (similar to how C3 was handled) rather than as a follow-on after small Rust slices.
- Keeps commit slices small and context manageable.

When ready: Start fresh, read this plan from Task 4, insert the block before `SetMethod`, add the TS exports + tests, rebuild, verify, then update matrix/log per the plan.

The anchor point (`static void SetMethod`) is stable.

**Files:**
- Modify: `packages/jxl-native/src/native.cc`

- [ ] **Step 1: Insert JXTC block just before `static void SetMethod` (~line 1061)**

Find this anchor in native.cc:
```cpp
static void SetMethod(napi_env env, napi_value object, const char* name, napi_callback cb, void* data) {
```

Insert the following block immediately before it:

```cpp
// --- JXTC tile container (ported from bridge.cpp) -----------------------
// Format: [32B header][8B×N index][N standalone JXL codestreams]
#define JXTC_MAGIC        0x4354584Au  // 'JXTC' little-endian
#define JXTC_VERSION      1u
#define JXTC_HEADER_BYTES 32u
#define JXTC_INDEX_BYTES  8u

#if CASABIO_HAVE_LIBJXL
static uint8_t* JxtcEncodeOneTile(const uint8_t* rgba, uint32_t w, uint32_t h,
    float distance, uint32_t effort, uint32_t has_alpha, size_t* out_size) {
  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (!enc) return nullptr;
  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize = w; info.ysize = h;
  info.bits_per_sample = 8; info.exponent_bits_per_sample = 0;
  info.num_color_channels = 3;
  info.num_extra_channels = has_alpha ? 1u : 0u;
  info.alpha_bits = has_alpha ? 8u : 0u; info.alpha_exponent_bits = 0;
  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return nullptr; }
  JxlColorEncoding color;
  JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
  if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return nullptr; }
  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  JxlEncoderSetFrameDistance(frame, distance);
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));
  JxlPixelFormat pf = {has_alpha ? 4u : 3u, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
  uint8_t* stripped = nullptr;
  const uint8_t* src = rgba;
  size_t pixel_size;
  if (has_alpha) {
    pixel_size = static_cast<size_t>(w) * h * 4u;
  } else {
    const size_t n = static_cast<size_t>(w) * h;
    pixel_size = n * 3u;
    stripped = static_cast<uint8_t*>(malloc(pixel_size));
    if (!stripped) { JxlEncoderDestroy(enc); return nullptr; }
    for (size_t i = 0; i < n; ++i) {
      stripped[i*3+0] = rgba[i*4+0];
      stripped[i*3+1] = rgba[i*4+1];
      stripped[i*3+2] = rgba[i*4+2];
    }
    src = stripped;
  }
  const JxlEncoderStatus add_s = JxlEncoderAddImageFrame(frame, &pf, src, pixel_size);
  free(stripped);
  if (add_s != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return nullptr; }
  JxlEncoderCloseInput(enc);
  size_t cap = std::max(static_cast<size_t>(4096), pixel_size / 4u);
  uint8_t* outbuf = static_cast<uint8_t*>(malloc(cap));
  if (!outbuf) { JxlEncoderDestroy(enc); return nullptr; }
  uint8_t* next_out = outbuf;
  size_t avail_out = cap;
  for (;;) {
    JxlEncoderStatus s = JxlEncoderProcessOutput(enc, &next_out, &avail_out);
    if (s == JXL_ENC_SUCCESS) {
      *out_size = static_cast<size_t>(next_out - outbuf);
      JxlEncoderDestroy(enc);
      return outbuf;
    }
    if (s == JXL_ENC_NEED_MORE_OUTPUT) {
      const size_t off = static_cast<size_t>(next_out - outbuf);
      cap *= 2u;
      uint8_t* grown = static_cast<uint8_t*>(realloc(outbuf, cap));
      if (!grown) { free(outbuf); JxlEncoderDestroy(enc); return nullptr; }
      outbuf = grown; next_out = outbuf + off; avail_out = cap - off;
      continue;
    }
    free(outbuf); JxlEncoderDestroy(enc); return nullptr;
  }
}

static uint8_t* JxtcDecodeOneTile(const uint8_t* input, size_t input_size,
    uint32_t* out_w, uint32_t* out_h) {
  *out_w = 0; *out_h = 0;
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (!dec) return nullptr;
  if (JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec); return nullptr;
  }
  JxlDecoderSetInput(dec, input, input_size);
  JxlDecoderCloseInput(dec);
  JxlBasicInfo binfo{};
  uint8_t* pixels = nullptr;
  size_t pixels_size = 0;
  JxlPixelFormat pf = {4, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
  for (;;) {
    JxlDecoderStatus st = JxlDecoderProcessInput(dec);
    if (st == JXL_DEC_SUCCESS) break;
    if (st == JXL_DEC_ERROR || st == JXL_DEC_NEED_MORE_INPUT) {
      free(pixels); JxlDecoderDestroy(dec); return nullptr;
    }
    if (st == JXL_DEC_BASIC_INFO) {
      if (JxlDecoderGetBasicInfo(dec, &binfo) != JXL_DEC_SUCCESS) { JxlDecoderDestroy(dec); return nullptr; }
      continue;
    }
    if (st == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t buf_size = 0;
      if (JxlDecoderImageOutBufferSize(dec, &pf, &buf_size) != JXL_DEC_SUCCESS) {
        free(pixels); JxlDecoderDestroy(dec); return nullptr;
      }
      if (buf_size > pixels_size) {
        free(pixels);
        pixels = static_cast<uint8_t*>(malloc(buf_size));
        if (!pixels) { JxlDecoderDestroy(dec); return nullptr; }
        pixels_size = buf_size;
      }
      if (JxlDecoderSetImageOutBuffer(dec, &pf, pixels, pixels_size) != JXL_DEC_SUCCESS) {
        free(pixels); JxlDecoderDestroy(dec); return nullptr;
      }
      continue;
    }
  }
  JxlDecoderDestroy(dec);
  *out_w = binfo.xsize; *out_h = binfo.ysize;
  return pixels;
}
#endif  // CASABIO_HAVE_LIBJXL

static napi_value EncodeJxtcRgba8(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value args[5];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 4) return Throw(env, "encodeJxtcRgba8: requires pixels, width, height, tileSize");
#if CASABIO_HAVE_LIBJXL
  std::vector<uint8_t> pixel_bytes;
  if (!ReadBytes(env, args[0], &pixel_bytes))
    return Throw(env, "encodeJxtcRgba8: invalid pixels argument");
  uint32_t width = 0, height = 0, tile_size = 0;
  napi_get_value_uint32(env, args[1], &width);
  napi_get_value_uint32(env, args[2], &height);
  napi_get_value_uint32(env, args[3], &tile_size);
  float    distance  = 1.0f;
  uint32_t effort    = 7;
  uint32_t has_alpha = 1;
  if (argc >= 5) {
    napi_valuetype t; napi_typeof(env, args[4], &t);
    if (t == napi_object) {
      distance  = static_cast<float>(GetNullableNumberProp(env, args[4], "distance", 1.0));
      effort    = GetUint32Prop(env, args[4], "effort", 7);
      has_alpha = GetBoolProp(env, args[4], "hasAlpha", true) ? 1u : 0u;
    }
  }
  if (width == 0 || height == 0 || tile_size == 0)
    return Throw(env, "encodeJxtcRgba8: invalid dimensions or tileSize");
  if (pixel_bytes.size() != static_cast<size_t>(width) * height * 4u)
    return Throw(env, "encodeJxtcRgba8: pixel buffer size mismatch");

  const uint32_t tiles_x    = (width  + tile_size - 1u) / tile_size;
  const uint32_t tiles_y    = (height + tile_size - 1u) / tile_size;
  const uint32_t tile_count = tiles_x * tiles_y;

  std::vector<uint8_t*> tile_bytes(tile_count, nullptr);
  std::vector<size_t>   tile_lengths(tile_count, 0);
  std::vector<uint8_t>  tile_stage(static_cast<size_t>(tile_size) * tile_size * 4u);
  size_t total_tile_bytes = 0;
  bool ok = true;

  for (uint32_t ty = 0; ty < tiles_y && ok; ++ty) {
    for (uint32_t tx = 0; tx < tiles_x && ok; ++tx) {
      const uint32_t x0 = tx * tile_size;
      const uint32_t y0 = ty * tile_size;
      const uint32_t tw = std::min(tile_size, width  - x0);
      const uint32_t th = std::min(tile_size, height - y0);
      for (uint32_t row = 0; row < th; ++row) {
        memcpy(tile_stage.data() + row * tw * 4u,
               pixel_bytes.data() + (static_cast<size_t>(y0 + row) * width + x0) * 4u,
               tw * 4u);
      }
      size_t out_size = 0;
      uint8_t* enc = JxtcEncodeOneTile(tile_stage.data(), tw, th, distance, effort, has_alpha, &out_size);
      if (!enc) { ok = false; break; }
      const uint32_t idx    = ty * tiles_x + tx;
      tile_bytes[idx]       = enc;
      tile_lengths[idx]     = out_size;
      total_tile_bytes     += out_size;
    }
  }
  if (!ok) {
    for (auto* b : tile_bytes) free(b);
    return Throw(env, "encodeJxtcRgba8: tile encode failed");
  }

  const size_t header_sz = JXTC_HEADER_BYTES;
  const size_t index_sz  = static_cast<size_t>(tile_count) * JXTC_INDEX_BYTES;
  const size_t total_sz  = header_sz + index_sz + total_tile_bytes;
  void* out_data = nullptr;
  napi_value out_ab;
  napi_create_arraybuffer(env, total_sz, &out_data, &out_ab);
  auto* output = static_cast<uint8_t*>(out_data);

  auto* h32 = reinterpret_cast<uint32_t*>(output);
  h32[0] = JXTC_MAGIC; h32[1] = JXTC_VERSION;
  h32[2] = width;      h32[3] = height;
  h32[4] = tile_size;  h32[5] = tiles_x;
  h32[6] = tiles_y;    h32[7] = has_alpha ? 1u : 0u;

  uint32_t cursor = static_cast<uint32_t>(header_sz + index_sz);
  auto* index = reinterpret_cast<uint32_t*>(output + header_sz);
  for (uint32_t i = 0; i < tile_count; ++i) {
    index[i * 2 + 0] = cursor;
    index[i * 2 + 1] = static_cast<uint32_t>(tile_lengths[i]);
    memcpy(output + cursor, tile_bytes[i], tile_lengths[i]);
    cursor += static_cast<uint32_t>(tile_lengths[i]);
    free(tile_bytes[i]);
  }
  return out_ab;
#else
  return Throw(env, "encodeJxtcRgba8: jxl-native built without libjxl");
#endif
}

static napi_value DecodeJxtcRegionRgba8(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value args[5];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 5) return Throw(env, "decodeJxtcRegionRgba8: requires container, x, y, w, h");
#if CASABIO_HAVE_LIBJXL
  std::vector<uint8_t> container_bytes;
  if (!ReadBytes(env, args[0], &container_bytes))
    return Throw(env, "decodeJxtcRegionRgba8: invalid container argument");
  uint32_t rx = 0, ry = 0, rw = 0, rh = 0;
  napi_get_value_uint32(env, args[1], &rx);
  napi_get_value_uint32(env, args[2], &ry);
  napi_get_value_uint32(env, args[3], &rw);
  napi_get_value_uint32(env, args[4], &rh);

  const uint8_t* input      = container_bytes.data();
  const size_t   input_size = container_bytes.size();
  if (input_size < JXTC_HEADER_BYTES) return Throw(env, "decodeJxtcRegionRgba8: container too small");

  const auto* h32 = reinterpret_cast<const uint32_t*>(input);
  if (h32[0] != JXTC_MAGIC)   return Throw(env, "decodeJxtcRegionRgba8: bad magic");
  if (h32[1] != JXTC_VERSION) return Throw(env, "decodeJxtcRegionRgba8: unsupported version");
  const uint32_t image_w   = h32[2];
  const uint32_t image_h   = h32[3];
  const uint32_t tile_size = h32[4];
  const uint32_t tiles_x   = h32[5];
  const uint32_t tiles_y   = h32[6];
  if (image_w == 0 || image_h == 0 || tile_size == 0 || tiles_x == 0 || tiles_y == 0)
    return Throw(env, "decodeJxtcRegionRgba8: invalid header");

  const uint32_t tile_count = tiles_x * tiles_y;
  const size_t   index_sz   = static_cast<size_t>(tile_count) * JXTC_INDEX_BYTES;
  if (input_size < JXTC_HEADER_BYTES + index_sz)
    return Throw(env, "decodeJxtcRegionRgba8: container truncated before index");
  const auto* idx_table = reinterpret_cast<const uint32_t*>(input + JXTC_HEADER_BYTES);

  const uint32_t crx = std::min(rx, image_w);
  const uint32_t cry = std::min(ry, image_h);
  const uint32_t crw = std::min(rw, image_w - crx);
  const uint32_t crh = std::min(rh, image_h - cry);
  if (crw == 0 || crh == 0) return Throw(env, "decodeJxtcRegionRgba8: empty region");

  const uint32_t tx_min = crx / tile_size;
  const uint32_t tx_max = (crx + crw - 1u) / tile_size;
  const uint32_t ty_min = cry / tile_size;
  const uint32_t ty_max = (cry + crh - 1u) / tile_size;

  const size_t out_pixel_size = static_cast<size_t>(crw) * crh * 4u;
  void* out_data = nullptr;
  napi_value out_ab;
  napi_create_arraybuffer(env, out_pixel_size, &out_data, &out_ab);
  auto* out_pixels = static_cast<uint8_t*>(out_data);

  for (uint32_t ty = ty_min; ty <= ty_max; ++ty) {
    for (uint32_t tx = tx_min; tx <= tx_max; ++tx) {
      const uint32_t i = ty * tiles_x + tx;
      if (i >= tile_count) return Throw(env, "decodeJxtcRegionRgba8: tile index OOB");
      const uint32_t offset = idx_table[i * 2 + 0];
      const uint32_t length = idx_table[i * 2 + 1];
      if (static_cast<size_t>(offset) + length > input_size)
        return Throw(env, "decodeJxtcRegionRgba8: tile data OOB");

      uint32_t tile_w = 0, tile_h = 0;
      uint8_t* tile_px = JxtcDecodeOneTile(input + offset, length, &tile_w, &tile_h);
      if (!tile_px) return Throw(env, "decodeJxtcRegionRgba8: tile decode failed");

      const uint32_t tile_x0 = tx * tile_size;
      const uint32_t tile_y0 = ty * tile_size;
      const uint32_t ox0 = std::max(tile_x0, crx);
      const uint32_t oy0 = std::max(tile_y0, cry);
      const uint32_t ox1 = std::min(tile_x0 + tile_w, crx + crw);
      const uint32_t oy1 = std::min(tile_y0 + tile_h, cry + crh);

      if (ox1 > ox0 && oy1 > oy0) {
        const uint32_t ow = ox1 - ox0;
        const uint32_t oh = oy1 - oy0;
        for (uint32_t row = 0; row < oh; ++row) {
          const uint8_t* src = tile_px   + ((oy0 - tile_y0 + row) * tile_w + (ox0 - tile_x0)) * 4u;
          uint8_t*       dst = out_pixels + ((oy0 - cry     + row) * crw    + (ox0 - crx))     * 4u;
          memcpy(dst, src, ow * 4u);
        }
      }
      free(tile_px);
    }
  }

  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "pixels", out_ab);
  napi_set_named_property(env, result, "width",  MakeUint32(env, crw));
  napi_set_named_property(env, result, "height", MakeUint32(env, crh));
  return result;
#else
  return Throw(env, "decodeJxtcRegionRgba8: jxl-native built without libjxl");
#endif
}
```

- [ ] **Step 2: Register in Init — add two lines after `createEncoder` registration**

Find in `Init`:
```cpp
  SetMethod(env, exports, "createEncoder", CreateEncoder, nullptr);
  return exports;
```

Change to:
```cpp
  SetMethod(env, exports, "createEncoder",          CreateEncoder,          nullptr);
  SetMethod(env, exports, "encodeJxtcRgba8",        EncodeJxtcRgba8,        nullptr);
  SetMethod(env, exports, "decodeJxtcRegionRgba8",  DecodeJxtcRegionRgba8,  nullptr);
  return exports;
```

- [ ] **Step 3: Commit C++ changes**

```bash
git add packages/jxl-native/src/native.cc
git commit -m "feat(jxl-native): port JXTC tile container encode+decode from bridge.cpp"
```

---

## Task 5: Rebuild addon and verify all tests

**Files:** none (build artifacts not committed)

- [ ] **Step 1: Rebuild**

```powershell
$env:JXL_NATIVE_INCLUDE_DIR = "C:\Foo\raw-converter\target\release\build\jpegxl-sys-26f294f2024eaecb\out\include"
$env:JXL_NATIVE_LIB_DIR     = "C:\TEMP\jxl-mt-libs"
Set-Location packages/jxl-native
npm run build
Set-Location ../..
```

Expected: node-gyp exits 0 (`gyp info ok`). The new `jxl_native.node` replaces `build/Release/jxl_native.node`.

- [ ] **Step 2: Run full codec test suite**

```powershell
$env:JXL_NATIVE_INCLUDE_DIR = "C:\Foo\raw-converter\target\release\build\jpegxl-sys-26f294f2024eaecb\out\include"
$env:JXL_NATIVE_LIB_DIR     = "C:\TEMP\jxl-mt-libs"
bun test packages/jxl-native/test/codec.test.ts
```

Expected: **18 pass, 0 fail** (prior 12 + 6 new JXTC tests).

- [ ] **Step 3: No commit needed for build artifacts**

---

## Task 6: Update parity matrix and progress log

**Files:**
- Modify: `docs/FEATURE_PARITY_MATRIX.md`
- Modify: `docs/references/PROGRESS_LOG.md`

- [ ] **Step 1: Update matrix row 3.3**

In `docs/FEATURE_PARITY_MATRIX.md`, find the row:
```
| 3 | JXTC tile-container encode + zero-overhead round-trip ROI decode | ✅ (p...
```

Change the Tauri column from:
```
❌ (only standard JXL via jpegxl-rs; no JXTC)
```
to:
```
✅ (encodeJxtcRgba8 / decodeJxtcRegionRgba8 in jxl-native N-API; bitstream-compatible with WASM; 3 roundtrip tests)
```

- [ ] **Step 2: Prepend progress log entry**

After the first `---` in `docs/references/PROGRESS_LOG.md`, insert:

```markdown
## C2: JXTC Container Encode + Round-Trip ROI Decode (Native Parity) — 2026-05-29

**Branch:** `finishing_feature_parity`
**Status:** Complete

**Scope:** Ported JXTC tile-container encode and region decode from WASM (bridge.cpp) to the jxl-native N-API addon (native.cc). The format is bitstream-compatible with the existing WASM implementation. Two synchronous N-API functions exposed: `encodeJxtcRgba8` (full image → JXTC container) and `decodeJxtcRegionRgba8` (ROI → RGBA8 pixels, decodes only overlapping tiles).

**Changes — `packages/jxl-native/src/native.cc`:**
- Added `JXTC_MAGIC`, `JXTC_VERSION`, `JXTC_HEADER_BYTES`, `JXTC_INDEX_BYTES` constants.
- Added `JxtcEncodeOneTile`: single RGBA8 tile → standalone JXL codestream (malloc'd, caller frees).
- Added `JxtcDecodeOneTile`: standalone JXL codestream → RGBA8 pixels (malloc'd, caller frees).
- Added `EncodeJxtcRgba8` N-API function: assembles full JXTC container from all tiles.
- Added `DecodeJxtcRegionRgba8` N-API function: decodes only tiles overlapping the requested region.
- Registered both in `Init()`.

**Changes — `packages/jxl-native/src/index.ts`:**
- Added `JxtcEncodeOptions` and `JxtcDecodeResult` interfaces.
- Extended `NativeBinding` with optional `encodeJxtcRgba8` and `decodeJxtcRegionRgba8` fields.
- Added exported `encodeJxtcRgba8` and `decodeJxtcRegionRgba8` standalone functions with `CapabilityMissing` guard.

**Changes — `packages/jxl-native/test/codec.test.ts`:**
- Added static import of `encodeJxtcRgba8`, `decodeJxtcRegionRgba8`.
- Added 3 source-inspection tests (JxtcEncodeOptions, JxtcDecodeResult, NativeBinding fields).
- Added 3 runtime roundtrip tests: single-tile lossless round-trip, multi-tile with per-quadrant ROI, cross-tile strip at tile boundary.

**Verification:** `bun test packages/jxl-native/test/codec.test.ts` — 18 pass, 0 fail.

**Docs Updated:**
- `docs/FEATURE_PARITY_MATRIX.md` row 3.3 → ✅.

---
```

- [ ] **Step 3: Commit docs**

```bash
git add docs/FEATURE_PARITY_MATRIX.md docs/references/PROGRESS_LOG.md
git commit -m "docs: log C2 JXTC native parity complete in matrix + progress log"
```

---

## Out of Scope (Follow-up)

The Tauri Rust encode path (`raw-pipeline/src/casabio_encode.rs` via jpegxl-rs) has no JXTC support yet. This would require a pure-Rust JXTC implementation (not using jxl-native). Matrix row 7.2 still notes "No progressive/JXTC yet" for the Rust path. That is a separate task (C3) not covered here.
