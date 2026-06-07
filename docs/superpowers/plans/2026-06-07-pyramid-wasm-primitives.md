# Pyramid WASM Primitives (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two C++ bridge primitives the pyramid ingest needs — a per-level-distance sidecar pyramid encoder (no quality floor) and a 16-bit area-box downscale — exported, wrapped in the TS facade, and verified.

**Architecture:** Edit `packages/jxl-wasm/src/bridge.cpp` (C++ libjxl bridge), register two new symbols in `exports.txt`, add TS declarations + high-level wrappers + capability flags in `src/facade.ts`. Tests follow the repo's two-tier convention: fast **source-shape** tests (read source as text, assert substrings — no rebuild) for the red/green loop, then **runtime** tests (load `dist/jxl-core.scalar.js`, call the real export) gated behind one Emscripten rebuild.

**Tech Stack:** C++ (libjxl bridge, `extern "C"` exports), Emscripten build (`scripts/build.mjs`, 4 tiers), TypeScript facade, `bun:test`.

**Scope notes / verified facts (do not re-investigate):**
- Exports are driven by `exports.txt` → `build.mjs:255` `-sEXPORTED_FUNCTIONS=@exports.txt`. New export = append the `_`-prefixed symbol there.
- `extern "C" {` opens at `bridge.cpp:1935` and spans past the existing public sidecar wrapper (`jxl_wasm_encode_rgba8_with_sidecars`, ends `bridge.cpp:2689`). Public exports go inside this block.
- `EncodeRgba(...)` signature is at `bridge.cpp:733`; arg order: `(pixels,width,height,distance,effort,fmt,has_alpha,progressive_dc,progressive_ac,qprogressive_ac,buffering,group_order,modular,brotli_effort,decoding_speed,photon_noise_iso,resampling,...)`. `fmt` 0/1/2 = rgba8/16/f32.
- Existing v1 sidecar internals: static `EncodeRgba8WithSidecars` (`bridge.cpp:2602-2682`, floor at `2658` `std::max(distance,1.5f)`, full encode un-floored at `2668`); public wrapper `2684-2689`. `BoxDownscaleRgba8` at `bridge.cpp:1084-1138`.
- `index.ts` is `export * from "./facade.js"` — exporting a function from `facade.ts` re-exports it automatically. **No `index.ts` edit needed.**
- `web/pkg` (Rust RAW pipeline) already exports `process_orf` / `process_dng` / `process_cr2` / `downscale_rgba` (`web/pkg/raw_converter_wasm.d.ts:218,237,263,202`). **No Rust rebuild in Plan A.** (It is git-ignored, so ripgrep won't match it — that is expected.)
- `takeBuffer(module, handle, op)` (`facade.ts:2188`) returns `LibjxlBuffer` `{ data: Uint8Array; width; height; bitsPerSample: 8|16|32; ... }`. Chains are walked via `_jxl_wasm_buffer_next`.
- facade helpers available: `loadLibjxlModule()`, `copyOrBorrowInput(input, false)`, `CapabilityMissing`, `takeBuffer`.
- Test runner is **bun**: `bun test <path>` from repo root. Existing references: `test/progressive-detail.test.ts` (source-shape), `test/jxtc.test.ts` (runtime via `dist/jxl-core.scalar.js`).

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `packages/jxl-wasm/src/bridge.cpp` | Modify | Add `BoxDownscaleRgba16` (static), `EncodeRgba8WithSidecarsV2` (static), and two `extern "C"` exports: `jxl_wasm_encode_rgba8_with_sidecars_v2`, `jxl_wasm_downscale_rgba16` |
| `packages/jxl-wasm/exports.txt` | Modify | Append `_jxl_wasm_encode_rgba8_with_sidecars_v2`, `_jxl_wasm_downscale_rgba16` |
| `packages/jxl-wasm/src/facade.ts` | Modify | Module-interface decls, capability flags, two exported wrappers: `encodeRgba8Pyramid`, `downscaleRgba16` |
| `packages/jxl-wasm/test/pyramid-bridge.test.ts` | Create | Source-shape tests (no rebuild) |
| `packages/jxl-wasm/test/pyramid-bridge-runtime.test.ts` | Create | Runtime tests against rebuilt scalar WASM |

---

## Task 1: Per-level-distance sidecar pyramid (`sidecars_v2`)

**Files:**
- Modify: `packages/jxl-wasm/src/bridge.cpp` (insert static fn after line 2682; insert export after line 2689)
- Modify: `packages/jxl-wasm/exports.txt`
- Modify: `packages/jxl-wasm/src/facade.ts` (decl after line 334; caps at 2077/2101; wrapper near line 906)
- Test: `packages/jxl-wasm/test/pyramid-bridge.test.ts`

- [ ] **Step 1: Write the failing source-shape test**

Create `packages/jxl-wasm/test/pyramid-bridge.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const bridge = readFileSync(new URL("../src/bridge.cpp", import.meta.url), "utf8");
const facade = readFileSync(new URL("../src/facade.ts", import.meta.url), "utf8");
const exportsTxt = readFileSync(new URL("../exports.txt", import.meta.url), "utf8");

test("bridge defines a per-level-distance sidecar encoder with no quality floor", () => {
  expect(bridge).toContain("EncodeRgba8WithSidecarsV2");
  expect(bridge).toContain("jxl_wasm_encode_rgba8_with_sidecars_v2");
  // per-level distance comes from the caller's array, not a clamped scalar
  expect(bridge).toContain("const float* sidecar_distances");
  expect(bridge).toContain("sc_dims[i].dist");
  expect(bridge).toContain("// per-level distance - NO 1.5 floor");
});

test("sidecars_v2 symbol is exported", () => {
  expect(exportsTxt).toContain("_jxl_wasm_encode_rgba8_with_sidecars_v2");
});

test("facade declares and wraps sidecars_v2", () => {
  expect(facade).toContain("_jxl_wasm_encode_rgba8_with_sidecars_v2?(");
  expect(facade).toContain("export async function encodeRgba8Pyramid");
  expect(facade).toContain("sidecarsV2:");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/jxl-wasm/test/pyramid-bridge.test.ts`
Expected: FAIL — all three tests fail (`toContain` assertions not met; strings absent).

- [ ] **Step 3: Add the static `EncodeRgba8WithSidecarsV2` to `bridge.cpp`**

Insert immediately AFTER the existing static `EncodeRgba8WithSidecars` (after its closing brace at line 2682) and BEFORE the public wrapper `jxl_wasm_encode_rgba8_with_sidecars` (line 2684):

```cpp
// Per-level-distance variant of the sidecar pyramid encoder.
// distances[i] pairs with sidecar_max_dims[i] (input order); a dim skipped because
// it is >= the long edge consumes its distance slot too. Full image is encoded at
// full_distance. Cascade + output-chain ordering are identical to the v1 function.
static JxlWasmBuffer* EncodeRgba8WithSidecarsV2(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float full_distance, const float* sidecar_distances, uint32_t effort, uint32_t has_alpha,
    const uint32_t* sidecar_max_dims, uint32_t num_sidecars,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling) {
  if (pixels == nullptr || width == 0 || height == 0) return MakeError(20);

  struct SidecarDim { uint32_t tw, th; float dist; };
  const uint32_t MAX_SC = 16u;
  SidecarDim sc_dims[MAX_SC];
  uint32_t sc_count = 0;

  for (uint32_t i = 0; i < num_sidecars && sc_count < MAX_SC; ++i) {
    const uint32_t max_dim = (sidecar_max_dims != nullptr) ? sidecar_max_dims[i] : 0u;
    const uint32_t longer  = (width >= height) ? width : height;
    if (max_dim == 0 || max_dim >= longer) continue;
    uint32_t tw, th;
    if (width >= height) {
      tw = max_dim;
      th = std::max(1u, (max_dim * height + width / 2u) / width);
    } else {
      th = max_dim;
      tw = std::max(1u, (max_dim * width + height / 2u) / height);
    }
    const float d = (sidecar_distances != nullptr) ? sidecar_distances[i] : full_distance;
    sc_dims[sc_count++] = { tw, th, d };
  }

  JxlWasmBuffer* sc_chain    = nullptr;
  const uint8_t* cascade_src = pixels;
  uint32_t       cascade_sw  = width;
  uint32_t       cascade_sh  = height;
  uint8_t*       cascade_owned = nullptr;

  for (int32_t i = static_cast<int32_t>(sc_count) - 1; i >= 0; --i) {
    const uint32_t tw = sc_dims[i].tw;
    const uint32_t th = sc_dims[i].th;

    uint8_t* thumb = static_cast<uint8_t*>(malloc(static_cast<size_t>(tw) * th * 4u));
    if (thumb == nullptr) continue;

    BoxDownscaleRgba8(cascade_src, cascade_sw, cascade_sh, thumb, tw, th);

    free(cascade_owned);
    cascade_owned = thumb;
    cascade_src   = thumb;
    cascade_sw    = tw;
    cascade_sh    = th;

    // per-level distance - NO 1.5 floor (caller owns per-level quality).
    JxlWasmBuffer* sidecar = EncodeRgba(thumb, tw, th,
        sc_dims[i].dist, std::min(effort, 5u), 0, 1u, 0, 0, 0, 0, 0,
        modular, brotli_effort, decoding_speed, photon_noise_iso);
    if (sidecar == nullptr) continue;

    sidecar->next = sc_chain;
    sc_chain = sidecar;
  }
  free(cascade_owned);

  JxlWasmBuffer* full = EncodeRgba(pixels, width, height, full_distance, effort, 0, has_alpha, 0, 0, 0, 0, 0,
      modular, brotli_effort, decoding_speed, photon_noise_iso, resampling);
  if (full == nullptr) {
    JxlWasmBuffer* cur = sc_chain;
    while (cur != nullptr) { JxlWasmBuffer* nxt = cur->next; FreeBufferNoChain(cur); cur = nxt; }
    return MakeError(28);
  }
  if (sc_chain == nullptr) return full;

  JxlWasmBuffer* tail = sc_chain;
  while (tail->next != nullptr) tail = tail->next;
  tail->next = full;
  return sc_chain;
}
```

- [ ] **Step 4: Add the public export to `bridge.cpp`**

Insert immediately AFTER the existing public wrapper `jxl_wasm_encode_rgba8_with_sidecars` (after its closing brace at line 2689). It is inside the `extern "C"` block:

```cpp
JxlWasmBuffer* jxl_wasm_encode_rgba8_with_sidecars_v2(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float full_distance, const float* sidecar_distances, uint32_t effort, uint32_t has_alpha,
    const uint32_t* sidecar_max_dims, uint32_t num_sidecars, uint32_t resampling) {
  return EncodeRgba8WithSidecarsV2(pixels, width, height, full_distance, sidecar_distances,
      effort, has_alpha, sidecar_max_dims, num_sidecars, -1, -1, -1, 0, resampling);
}
```

- [ ] **Step 5: Register the export in `exports.txt`**

Append one line (the leading underscore is required):

```
_jxl_wasm_encode_rgba8_with_sidecars_v2
```

- [ ] **Step 6: Declare the function on the module interface in `facade.ts`**

Insert after line 334 (right after the existing `_jxl_wasm_encode_rgba8_with_sidecars?` declaration):

```ts
  // Per-level-distance pyramid encode (present after WASM rebuild with sidecars_v2 bridge)
  _jxl_wasm_encode_rgba8_with_sidecars_v2?(pixelsPtr: number, width: number, height: number, fullDistance: number, sidecarDistancesPtr: number, effort: number, hasAlpha: number, sidecarDimsPtr: number, numSidecars: number, resampling: number): number;
```

- [ ] **Step 7: Add the capability flag in `facade.ts`**

In `interface JxlCapabilities` (line 2071), add after `sidecars: boolean;` (line 2077):

```ts
  sidecarsV2: boolean;
```

In `getCapabilities` (line 2083), add after the `sidecars:` entry (ends line 2103):

```ts
    sidecarsV2:
      typeof module._jxl_wasm_encode_rgba8_with_sidecars_v2 === "function" &&
      typeof module._jxl_wasm_buffer_next === "function",
```

- [ ] **Step 8: Add the `encodeRgba8Pyramid` wrapper in `facade.ts`**

Insert after the `encodeTileContainer` helper (after its closing brace at line 906):

```ts
/** One pyramid level produced by encodeRgba8Pyramid. Ordered smallest-first, full image last. */
export interface PyramidLevel {
  data: Uint8Array;
  width: number;
  height: number;
  bitsPerSample: 8 | 16 | 32;
}

/**
 * Encode an RGBA8 image into a JXL pyramid in one WASM call: each sidecar level is
 * area-box downscaled (cascaded, smallest from previous) and encoded at its OWN distance
 * (no 1.5 floor); the full image is encoded at `fullDistance`. `sidecarSizes[i]` is a
 * long-edge target and pairs with `sidecarDistances[i]`. Sizes >= the image long edge are
 * skipped by the bridge. Returns levels smallest-first, full image last.
 */
export async function encodeRgba8Pyramid(
  pixels: ArrayBuffer | Uint8Array,
  width: number,
  height: number,
  options: {
    fullDistance: number;
    sidecarSizes: readonly number[];
    sidecarDistances: readonly number[];
    effort?: number;
    hasAlpha?: boolean;
    resampling?: number;
  },
): Promise<PyramidLevel[]> {
  const module = await loadLibjxlModule();
  const encodeFn = module._jxl_wasm_encode_rgba8_with_sidecars_v2;
  const nextFn = module._jxl_wasm_buffer_next;
  if (!encodeFn || !nextFn) {
    throw new CapabilityMissing("Pyramid encode requires a rebuilt WASM with the sidecars_v2 bridge");
  }
  const sizes = [...options.sidecarSizes];
  const dists = [...options.sidecarDistances];
  if (sizes.length !== dists.length) {
    throw new Error(`sidecarSizes (${sizes.length}) and sidecarDistances (${dists.length}) must be the same length`);
  }
  const effort = options.effort ?? 3;
  const hasAlpha = options.hasAlpha !== false;
  const resampling = options.resampling ?? 1;

  const view = copyOrBorrowInput(pixels, false);
  const expectedBytes = width * height * 4;
  if (view.byteLength < expectedBytes) {
    throw new Error(`Pixel buffer too small: ${view.byteLength} < ${expectedBytes}`);
  }

  const ptr = module._malloc(view.byteLength);
  if (ptr === 0) throw new Error("WASM malloc failed for pyramid encode");
  const dimsPtr = module._malloc(Math.max(4, sizes.length * 4));
  const distPtr = module._malloc(Math.max(4, dists.length * 4));
  if (dimsPtr === 0 || distPtr === 0) {
    module._free(ptr);
    if (dimsPtr !== 0) module._free(dimsPtr);
    if (distPtr !== 0) module._free(distPtr);
    throw new Error("WASM malloc failed for pyramid encode params");
  }
  try {
    module.HEAPU8.set(view, ptr);
    // Write params as little-endian byte images (no HEAPU32/HEAPF32 dependency — not
    // exported on every tier). WASM is little-endian, matching TypedArray byte order.
    module.HEAPU8.set(new Uint8Array(new Uint32Array(sizes).buffer), dimsPtr);
    module.HEAPU8.set(new Uint8Array(new Float32Array(dists).buffer), distPtr);

    const levels: PyramidLevel[] = [];
    let handle = encodeFn(ptr, width, height, options.fullDistance, distPtr, effort, hasAlpha ? 1 : 0, dimsPtr, sizes.length, resampling);
    while (handle !== 0) {
      const next = nextFn(handle);
      try {
        const buf = takeBuffer(module, handle, "pyramid encode");
        levels.push({ data: buf.data, width: buf.width, height: buf.height, bitsPerSample: buf.bitsPerSample });
      } catch (err) {
        let cur = next;
        while (cur !== 0) { const nxt = nextFn(cur); module._jxl_wasm_buffer_free(cur); cur = nxt; }
        throw err;
      }
      handle = next;
    }
    return levels;
  } finally {
    module._free(ptr);
    module._free(dimsPtr);
    module._free(distPtr);
  }
}
```

- [ ] **Step 9: Run the source-shape test to verify it passes**

Run: `bun test packages/jxl-wasm/test/pyramid-bridge.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 10: Typecheck the facade**

Run: `cd packages/jxl-wasm && bun run typecheck`
Expected: PASS — `tsc --noEmit` reports no errors. (If `loadLibjxlModule` / `copyOrBorrowInput` / `CapabilityMissing` / `takeBuffer` are not yet in scope at the insertion point, they are module-level in `facade.ts` — no import needed.)

- [ ] **Step 11: Commit**

```bash
git add packages/jxl-wasm/src/bridge.cpp packages/jxl-wasm/exports.txt packages/jxl-wasm/src/facade.ts packages/jxl-wasm/test/pyramid-bridge.test.ts
git commit -m "feat(jxl-wasm): per-level-distance sidecar pyramid encoder (sidecars_v2)"
```

---

## Task 2: 16-bit area-box downscale (`downscale_rgba16`)

**Files:**
- Modify: `packages/jxl-wasm/src/bridge.cpp` (static fn after line 1138; export inside `extern "C"`, after the Task 1 export)
- Modify: `packages/jxl-wasm/exports.txt`
- Modify: `packages/jxl-wasm/src/facade.ts` (decl, caps, wrapper)
- Test: `packages/jxl-wasm/test/pyramid-bridge.test.ts` (extend)

- [ ] **Step 1: Add failing source-shape assertions**

Append to `packages/jxl-wasm/test/pyramid-bridge.test.ts`:

```ts
test("bridge defines a 16-bit area-box downscale", () => {
  expect(bridge).toContain("BoxDownscaleRgba16");
  expect(bridge).toContain("jxl_wasm_downscale_rgba16");
});

test("downscale_rgba16 symbol is exported", () => {
  expect(exportsTxt).toContain("_jxl_wasm_downscale_rgba16");
});

test("facade declares and wraps downscale_rgba16", () => {
  expect(facade).toContain("_jxl_wasm_downscale_rgba16?(");
  expect(facade).toContain("export async function downscaleRgba16");
  expect(facade).toContain("downscaleRgba16:");
});
```

- [ ] **Step 2: Run test to verify the new assertions fail**

Run: `bun test packages/jxl-wasm/test/pyramid-bridge.test.ts`
Expected: FAIL — the 3 new tests fail; the 3 from Task 1 still pass.

- [ ] **Step 3: Add `BoxDownscaleRgba16` to `bridge.cpp`**

Insert immediately AFTER `BoxDownscaleRgba8` (after its closing brace at line 1138) and BEFORE `LooksLikeJpeg` (line 1140):

```cpp
// 16-bit sibling of BoxDownscaleRgba8 for RAW pyramid levels (4 channels x uint16,
// interleaved). uint64 accumulators keep large downscale factors overflow-safe.
static void BoxDownscaleRgba16(const uint16_t* src, uint32_t sw, uint32_t sh,
                               uint16_t* dst, uint32_t dw, uint32_t dh) {
  if (dw == 0 || dh == 0) return;

  if ((sw % dw == 0) && (sh % dh == 0)) {
    const uint32_t xstep = sw / dw;
    const uint32_t ystep = sh / dh;
    for (uint32_t dy = 0; dy < dh; ++dy) {
      for (uint32_t dx = 0; dx < dw; ++dx) {
        uint64_t r = 0, g = 0, b = 0, a = 0, count = 0;
        for (uint32_t yy = 0; yy < ystep; ++yy) {
          const uint32_t y = dy * ystep + yy;
          const uint16_t* row = src + static_cast<size_t>(y) * sw * 4;
          for (uint32_t xx = 0; xx < xstep; ++xx) {
            const uint32_t x = dx * xstep + xx;
            const uint16_t* px = row + static_cast<size_t>(x) * 4;
            r += px[0]; g += px[1]; b += px[2]; a += px[3];
            ++count;
          }
        }
        uint16_t* out = dst + (static_cast<size_t>(dy) * dw + dx) * 4;
        out[0] = static_cast<uint16_t>(r / count);
        out[1] = static_cast<uint16_t>(g / count);
        out[2] = static_cast<uint16_t>(b / count);
        out[3] = static_cast<uint16_t>(a / count);
      }
    }
    return;
  }

  for (uint32_t dy = 0; dy < dh; ++dy) {
    const uint32_t y0 = (dy * sh) / dh;
    const uint32_t y1 = ((dy + 1u) * sh + dh - 1u) / dh;  // ceiling division
    for (uint32_t dx = 0; dx < dw; ++dx) {
      const uint32_t x0 = (dx * sw) / dw;
      const uint32_t x1 = ((dx + 1u) * sw + dw - 1u) / dw;
      uint64_t r = 0, g = 0, b = 0, a = 0, count = 0;
      for (uint32_t sy = y0; sy < y1; ++sy) {
        const uint16_t* row = src + static_cast<size_t>(sy) * sw * 4;
        for (uint32_t sx = x0; sx < x1; ++sx) {
          const uint16_t* px = row + static_cast<size_t>(sx) * 4;
          r += px[0]; g += px[1]; b += px[2]; a += px[3];
          ++count;
        }
      }
      uint16_t* out = dst + (static_cast<size_t>(dy) * dw + dx) * 4;
      out[0] = static_cast<uint16_t>(r / count);
      out[1] = static_cast<uint16_t>(g / count);
      out[2] = static_cast<uint16_t>(b / count);
      out[3] = static_cast<uint16_t>(a / count);
    }
  }
}
```

- [ ] **Step 4: Add the public export to `bridge.cpp`**

Insert immediately AFTER the `jxl_wasm_encode_rgba8_with_sidecars_v2` export added in Task 1 (inside the `extern "C"` block). Caller allocates `dst` (`dw*dh*4` uint16 = `dw*dh*8` bytes):

```cpp
void jxl_wasm_downscale_rgba16(const uint16_t* src, uint32_t sw, uint32_t sh,
                               uint16_t* dst, uint32_t dw, uint32_t dh) {
  BoxDownscaleRgba16(src, sw, sh, dst, dw, dh);
}
```

- [ ] **Step 5: Register the export in `exports.txt`**

Append:

```
_jxl_wasm_downscale_rgba16
```

- [ ] **Step 6: Declare the function on the module interface in `facade.ts`**

Insert immediately after the `_jxl_wasm_encode_rgba8_with_sidecars_v2?` declaration added in Task 1:

```ts
  // 16-bit area-box downscale (present after WASM rebuild with downscale_rgba16 bridge)
  _jxl_wasm_downscale_rgba16?(srcPtr: number, sw: number, sh: number, dstPtr: number, dw: number, dh: number): void;
```

- [ ] **Step 7: Add the capability flag in `facade.ts`**

In `interface JxlCapabilities`, add after `sidecarsV2: boolean;`:

```ts
  downscaleRgba16: boolean;
```

In `getCapabilities`, add after the `sidecarsV2:` entry:

```ts
    downscaleRgba16: typeof module._jxl_wasm_downscale_rgba16 === "function",
```

- [ ] **Step 8: Add the `downscaleRgba16` wrapper in `facade.ts`**

Insert immediately after the `encodeRgba8Pyramid` function added in Task 1:

```ts
/**
 * Area-box downscale an RGBA16 buffer (4 channels x uint16, interleaved) inside WASM.
 * Used to build 16-bit RAW pyramid levels (e.g. full -> 2048) with no 8-bit roundtrip.
 */
export async function downscaleRgba16(
  src: Uint16Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Promise<Uint16Array> {
  const module = await loadLibjxlModule();
  const fn = module._jxl_wasm_downscale_rgba16;
  if (!fn) {
    throw new CapabilityMissing("16-bit downscale requires a rebuilt WASM with the downscale_rgba16 bridge");
  }
  if (src.length < srcWidth * srcHeight * 4) {
    throw new Error(`Source buffer too small: ${src.length} < ${srcWidth * srcHeight * 4}`);
  }
  const srcBytes = srcWidth * srcHeight * 4 * 2;
  const dstBytes = dstWidth * dstHeight * 4 * 2;
  const srcPtr = module._malloc(srcBytes);
  const dstPtr = module._malloc(dstBytes);
  if (srcPtr === 0 || dstPtr === 0) {
    if (srcPtr !== 0) module._free(srcPtr);
    if (dstPtr !== 0) module._free(dstPtr);
    throw new Error("WASM malloc failed for 16-bit downscale");
  }
  try {
    module.HEAPU8.set(new Uint8Array(src.buffer, src.byteOffset, srcBytes), srcPtr);
    fn(srcPtr, srcWidth, srcHeight, dstPtr, dstWidth, dstHeight);
    const out = new Uint16Array(dstWidth * dstHeight * 4);
    out.set(new Uint16Array(module.HEAPU8.buffer, dstPtr, out.length));
    return out;
  } finally {
    module._free(srcPtr);
    module._free(dstPtr);
  }
}
```

- [ ] **Step 9: Run the source-shape test to verify it passes**

Run: `bun test packages/jxl-wasm/test/pyramid-bridge.test.ts`
Expected: PASS — all 6 tests pass.

- [ ] **Step 10: Typecheck**

Run: `cd packages/jxl-wasm && bun run typecheck`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/jxl-wasm/src/bridge.cpp packages/jxl-wasm/exports.txt packages/jxl-wasm/src/facade.ts packages/jxl-wasm/test/pyramid-bridge.test.ts
git commit -m "feat(jxl-wasm): 16-bit area-box downscale (downscale_rgba16)"
```

---

## Task 3: Rebuild WASM + runtime verification

This is the one heavy step: an Emscripten rebuild regenerates `dist/jxl-core.*.{js,wasm}` from the edited `bridge.cpp` + `exports.txt`. The runtime tests cannot pass until this succeeds.

**Files:**
- Regenerate: `packages/jxl-wasm/dist/*` (build output, committed in this repo)
- Test: `packages/jxl-wasm/test/pyramid-bridge-runtime.test.ts`

- [ ] **Step 1: Write the runtime test**

Create `packages/jxl-wasm/test/pyramid-bridge-runtime.test.ts`:

```ts
import { expect, test } from "bun:test";
import { downscaleRgba16, encodeRgba8Pyramid, setJxlModuleFactoryForTesting } from "../src/index";

async function loadScalarModule() {
  const imported = await import("../dist/jxl-core.scalar.js");
  if (typeof imported.default !== "function") {
    throw new Error("jxl-core.scalar.js did not export a loader function");
  }
  const baseUrl = new URL("../dist/", import.meta.url);
  const module = await imported.default({
    locateFile: (path: string) => new URL(path, baseUrl).href,
  });
  if (!module || typeof module._malloc !== "function") {
    throw new Error("scalar WASM module missing required exports");
  }
  return module;
}

function gradient(width: number, height: number): Uint8Array {
  // Non-flat content so quality/distance actually affects encoded size.
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      px[o] = (x * 31 + y * 17) & 0xff;
      px[o + 1] = (x * 7 + y * 53) & 0xff;
      px[o + 2] = (x * 13 + y * 29) & 0xff;
      px[o + 3] = 255;
    }
  }
  return px;
}

test("sidecars_v2 export is present in scalar build", async () => {
  const module = await loadScalarModule();
  expect(typeof module._jxl_wasm_encode_rgba8_with_sidecars_v2).toBe("function");
  expect(typeof module._jxl_wasm_downscale_rgba16).toBe("function");
});

test("per-level distance is honored (no 1.5 floor) — higher distance yields fewer bytes", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(async () => module);

  const W = 512, H = 512;
  const px = gradient(W, H);

  // Same image + sidecar size; only the 256-level distance changes.
  const sharp = await encodeRgba8Pyramid(px, W, H, {
    fullDistance: 1.0, sidecarSizes: [256], sidecarDistances: [0.5], effort: 3,
  });
  const coarse = await encodeRgba8Pyramid(px, W, H, {
    fullDistance: 1.0, sidecarSizes: [256], sidecarDistances: [3.0], effort: 3,
  });

  // 2 levels each: [256 sidecar, full], smallest-first.
  expect(sharp.length).toBe(2);
  expect(coarse.length).toBe(2);
  expect(sharp[0]!.width).toBe(256);
  expect(coarse[0]!.width).toBe(256);

  // distance 0.5 (higher quality) must be meaningfully larger than 3.0 (lower quality).
  // Under the old 1.5 floor both would clamp to 1.5 and be ~equal — so a clear gap proves
  // the floor is gone and per-level distance is applied.
  expect(sharp[0]!.data.byteLength).toBeGreaterThan(coarse[0]!.data.byteLength * 1.3);

  setJxlModuleFactoryForTesting(null);
});

test("downscaleRgba16 averages 2x2 blocks correctly", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(async () => module);

  // 2x2 image, 4 channels uint16. Each of the four pixels a distinct constant block;
  // downscale 2x2 -> 1x1 must average to the mean of the four.
  const src = new Uint16Array([
    1000, 2000, 3000, 4000,   5000, 6000, 7000, 8000,
    9000, 10000, 11000, 12000, 13000, 14000, 15000, 16000,
  ]);
  const out = await downscaleRgba16(src, 2, 2, 1, 1);
  expect(out.length).toBe(4);
  // mean of channel c across the 4 pixels
  expect(out[0]).toBe((1000 + 5000 + 9000 + 13000) / 4);   // 7000
  expect(out[1]).toBe((2000 + 6000 + 10000 + 14000) / 4);  // 8000
  expect(out[2]).toBe((3000 + 7000 + 11000 + 15000) / 4);  // 9000
  expect(out[3]).toBe((4000 + 8000 + 12000 + 16000) / 4);  // 10000

  setJxlModuleFactoryForTesting(null);
});
```

- [ ] **Step 2: Run the runtime test to verify it fails (stale dist)**

Run: `bun test packages/jxl-wasm/test/pyramid-bridge-runtime.test.ts`
Expected: FAIL — the current committed `dist/jxl-core.scalar.js` predates the new exports, so `module._jxl_wasm_encode_rgba8_with_sidecars_v2` is `undefined` and the first test fails.

- [ ] **Step 3: Rebuild the WASM (all tiers)**

`exports.txt` is the `-sEXPORTED_FUNCTIONS` input, so it MUST already contain the two new symbols (done in Tasks 1-2) before building. Run from the repo root:

```powershell
cmd /c "call C:\Users\User\emsdk\emsdk_env.bat >nul && node packages/jxl-wasm/scripts/build.mjs --host-toolchain"
```

Expected: build completes; `packages/jxl-wasm/dist/jxl-core.{scalar,simd,simd-mt,relaxed-simd-mt}.{js,wasm}` are regenerated along with `*.size-report.txt` and `build-manifest.json`. Build is multi-minute (it clones/builds libjxl v0.11.2 in `%TEMP%/jxl-wasm-work`) and requires the local emsdk.

Notes:
- If `emcc` cannot find a new symbol named in `exports.txt`, the build errors with "undefined exported symbol" — that means the C++ name in `bridge.cpp` does not match the `_`-stripped name in `exports.txt`. Verify both names.
- The forward-decl blocker mentioned in CLAUDE.md is already resolved (`bridge.cpp:1940`); no action needed.
- If the host emsdk path differs, fall back to the Docker path documented in CLAUDE.md (`docker.io/emscripten/emsdk`).

- [ ] **Step 4: Run the runtime test to verify it passes**

Run: `bun test packages/jxl-wasm/test/pyramid-bridge-runtime.test.ts`
Expected: PASS — all 4 runtime tests pass.

- [ ] **Step 5: Run the full jxl-wasm test suite (no regressions)**

Run: `bun test packages/jxl-wasm/test/`
Expected: PASS — all existing tests (`facade`, `jxtc`, `loader`, `progressive-*`) plus the two new files pass. (The v1 sidecar path was not modified, so `facade`/sidecar tests are unaffected.)

- [ ] **Step 6: Commit**

```bash
git add packages/jxl-wasm/dist packages/jxl-wasm/test/pyramid-bridge-runtime.test.ts
git commit -m "build(jxl-wasm): rebuild dist with sidecars_v2 + downscale_rgba16; runtime tests"
```

---

## Self-Review

**1. Spec coverage (Plan A slice of `2026-06-07-pyramid-gallery-design.md` §12 Build Deps + §3/§4 encode primitives):**
- "Parameterize the sidecar distance floor to per-level distances" → Task 1 (`EncodeRgba8WithSidecarsV2`, distance from `sc_dims[i].dist`, no `std::max(...,1.5f)`). ✓
- "16-bit big levels need a 16-bit box downscale (`BoxDownscaleRgba16` + `_jxl_wasm_downscale_rgba16`)" → Task 2. ✓
- "one JS↔WASM crossing" cascade-in-C++ → `encodeRgba8Pyramid` makes a single `encodeFn` call; downscale happens inside the bridge. ✓
- "confirm `process_cr2` export / web/pkg rebuild" → verified already present; explicitly out of scope (documented in header). ✓ (Consumed in Plan B.)
- 16-bit JXTC (deferred) and f32 (out) → not in Plan A. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step shows the command and expected result. ✓

**3. Type consistency:**
- C++ `EncodeRgba8WithSidecarsV2` params match the public `jxl_wasm_encode_rgba8_with_sidecars_v2` forwarding call (order: pixels,width,height,full_distance,sidecar_distances,effort,has_alpha,sidecar_max_dims,num_sidecars,resampling; internal adds modular/brotli/decoding_speed/photon defaults). ✓
- facade decl arg list `(pixelsPtr,width,height,fullDistance,sidecarDistancesPtr,effort,hasAlpha,sidecarDimsPtr,numSidecars,resampling)` matches the C++ export signature and the `encodeFn(...)` call site. ✓
- `encodeRgba8Pyramid` returns `PyramidLevel[]`; `PyramidLevel.bitsPerSample` typed `8|16|32` to match `LibjxlBuffer.bitsPerSample`. ✓
- `downscaleRgba16(src, srcWidth, srcHeight, dstWidth, dstHeight)` matches the export `(srcPtr,sw,sh,dstPtr,dw,dh)`. ✓
- Capability names `sidecarsV2` / `downscaleRgba16` used identically in interface, `getCapabilities`, and source-shape tests. ✓

**Reviewer caveat to confirm during execution:** insertion line numbers (e.g., 2682/2689/334/1138) are from the current `bridge.cpp` / `facade.ts`; if earlier tasks shift lines, anchor by the named neighbor (function/comment) rather than the absolute number.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-07-pyramid-wasm-primitives.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
