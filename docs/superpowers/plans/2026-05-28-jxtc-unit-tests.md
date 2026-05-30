# JXTC Unit Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 9 automated correctness and error-code tests for `encodeTileContainerRgba8` / `decodeTileContainerRegionRgba8` in `packages/jxl-wasm/test/jxtc.test.ts`, running via `bun test`.

**Architecture:** Single test file following the `facade.test.ts` pattern — real WASM loaded via `setJxlModuleFactoryForTesting`, no fakes. The JS-side `tileSize` validation in `facade.ts` currently rejects `tileSize < 16`; the spec uses `tileSize: 4` on 8×8 images, so the guard must be relaxed to `< 1` (let libjxl decide the actual minimum) before the test file can run.

**Tech Stack:** Bun test runner, TypeScript, real `jxl-core.scalar.js` WASM dist.

---

## Known Blocker — tileSize Validation

`packages/jxl-wasm/src/facade.ts:524-526`:
```typescript
if (!Number.isInteger(tileSize) || tileSize < 16) {
  throw new Error(`tileSize must be an integer ≥ 16, got ${tileSize}`);
}
```

All spec correctness tests use `tileSize: 4` on 8×8 images (2×2 tile grid). The guard fires before WASM is reached. The ≥ 16 lower bound is a JS-side guess — libjxl imposes no such limit. Task 1 relaxes it.

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `packages/jxl-wasm/src/facade.ts` | Modify (line 524) | Relax tileSize minimum from 16 → 1 |
| `packages/jxl-wasm/test/jxtc.test.ts` | Create | All 9 JXTC unit tests |

---

## Task 1: Relax tileSize validation in facade.ts

**Files:**
- Modify: `packages/jxl-wasm/src/facade.ts:524`

- [ ] **Step 1: Read current validation**

Open `packages/jxl-wasm/src/facade.ts` and locate the two copies of the tileSize guard (around lines 405–408 for `encodeTiledRgba8`, and lines 524–526 for `encodeTileContainerRgba8`). Only the JXTC copy (the second one) needs changing — the tiled encode copy (`encodeTiledRgba8`) is unrelated to this spec.

- [ ] **Step 2: Change the JXTC tileSize minimum**

In `encodeTileContainerRgba8` (around line 524), change:

```typescript
  if (!Number.isInteger(tileSize) || tileSize < 16) {
    throw new Error(`tileSize must be an integer ≥ 16, got ${tileSize}`);
  }
```

to:

```typescript
  if (!Number.isInteger(tileSize) || tileSize < 1) {
    throw new Error(`tileSize must be a positive integer, got ${tileSize}`);
  }
```

- [ ] **Step 3: Typecheck**

```powershell
cd packages/jxl-wasm && npx tsc --noEmit
```

Expected: no errors. If errors appear, fix before continuing.

- [ ] **Step 4: Commit**

```bash
git add packages/jxl-wasm/src/facade.ts
git commit -m "fix(jxl-wasm): relax tileSize minimum in encodeTileContainerRgba8 to allow unit tests with small images"
```

---

## Task 2: Create the test file skeleton

**Files:**
- Create: `packages/jxl-wasm/test/jxtc.test.ts`

This task writes the file with imports, helpers, and describe blocks — no test bodies yet. This lets you confirm the file compiles before filling in test logic.

- [ ] **Step 1: Write the skeleton**

Create `packages/jxl-wasm/test/jxtc.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  encodeTileContainerRgba8,
  decodeTileContainerRegionRgba8,
  setJxlModuleFactoryForTesting,
} from "../src/index";

// ---------------------------------------------------------------------------
// WASM loader (copied inline from facade.test.ts — not imported)
// ---------------------------------------------------------------------------

async function loadPreferredLibjxlModule() {
  try {
    const imported = await import("../dist/jxl-core.scalar.js");
    if (typeof imported.default === "function") {
      const baseUrl = new URL("../dist/", import.meta.url);
      const module = await imported.default({
        locateFile: (path: string) => new URL(path, baseUrl).href,
      });
      if (module && typeof module._malloc === "function" && typeof module._jxl_wasm_encode_rgba8 === "function") {
        return module;
      }
    }
  } catch {}
  // dist not built — skip WASM tests gracefully (scaffold only)
  return null as never;
}

// ---------------------------------------------------------------------------
// Pixel helpers
// ---------------------------------------------------------------------------

/**
 * Generate a w×h RGBA8 buffer with a deterministic per-pixel pattern.
 * Default: [i%256, (i*3)%256, (i*7)%256, 255]
 */
function makeRgba8(
  w: number,
  h: number,
  fill?: (i: number) => [number, number, number, number],
): Uint8Array {
  const buf = new Uint8Array(w * h * 4);
  const fn = fill ?? ((i) => [i % 256, (i * 3) % 256, (i * 7) % 256, 255]);
  for (let i = 0; i < w * h; i++) {
    const [r, g, b, a] = fn(i);
    buf[i * 4 + 0] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("JXTC tile container — correctness (distance: 0, tileSize: 4)", () => {
  beforeEach(() => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
  });

  afterEach(() => {
    setJxlModuleFactoryForTesting(null);
  });

  // Tests go here in Task 3
});

describe("JXTC tile container — error codes", () => {
  beforeEach(() => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
  });

  afterEach(() => {
    setJxlModuleFactoryForTesting(null);
  });

  // Tests go here in Task 4
});
```

- [ ] **Step 2: Typecheck**

```powershell
cd packages/jxl-wasm && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Confirm file is discovered**

```powershell
bun test packages/jxl-wasm/test/jxtc.test.ts
```

Expected: `0 tests` (empty describes), no crash.

- [ ] **Step 4: Commit**

```bash
git add packages/jxl-wasm/test/jxtc.test.ts
git commit -m "test(jxl-wasm): add jxtc.test.ts skeleton with helpers"
```

---

## Task 3: Correctness tests (6 tests)

**Files:**
- Modify: `packages/jxl-wasm/test/jxtc.test.ts` (fill the correctness describe block)

All tests use `tileSize: 4` and `distance: 0` (lossless). Each test encodes an image into a JXTC container, then decodes a region and verifies output dimensions. The round-trip test additionally verifies pixel bytes.

- [ ] **Step 1: Write all 6 correctness tests**

Replace the `// Tests go here in Task 3` comment inside the correctness describe block with:

```typescript
  test("round-trip full image — pixels byte-for-byte equal to input", async () => {
    const input = makeRgba8(8, 8);
    const container = await encodeTileContainerRgba8(input, 8, 8, { tileSize: 4, distance: 0 });

    const { pixels, width, height } = await decodeTileContainerRegionRgba8(container, { x: 0, y: 0, w: 8, h: 8 });

    expect(width).toBe(8);
    expect(height).toBe(8);
    expect(pixels.byteLength).toBe(8 * 8 * 4);
    expect(Array.from(pixels)).toEqual(Array.from(input));
  });

  test("one tile exactly — single tile, no stitching", async () => {
    const input = makeRgba8(8, 8);
    const container = await encodeTileContainerRgba8(input, 8, 8, { tileSize: 4, distance: 0 });

    const { width, height } = await decodeTileContainerRegionRgba8(container, { x: 0, y: 0, w: 4, h: 4 });

    expect(width).toBe(4);
    expect(height).toBe(4);
  });

  test("crosses 2 tiles horizontally — spans tile columns 0 and 1, row 0", async () => {
    const input = makeRgba8(8, 8);
    const container = await encodeTileContainerRgba8(input, 8, 8, { tileSize: 4, distance: 0 });

    const { width, height } = await decodeTileContainerRegionRgba8(container, { x: 2, y: 0, w: 4, h: 4 });

    expect(width).toBe(4);
    expect(height).toBe(4);
  });

  test("crosses 4 tiles — all four tiles of a 2×2 grid", async () => {
    const input = makeRgba8(8, 8);
    const container = await encodeTileContainerRgba8(input, 8, 8, { tileSize: 4, distance: 0 });

    const { width, height } = await decodeTileContainerRegionRgba8(container, { x: 2, y: 2, w: 4, h: 4 });

    expect(width).toBe(4);
    expect(height).toBe(4);
  });

  test("crosses 9 tiles — 4×4 tile grid, region spans 3×3 tiles", async () => {
    const input = makeRgba8(16, 16);
    const container = await encodeTileContainerRgba8(input, 16, 16, { tileSize: 4, distance: 0 });

    const { width, height } = await decodeTileContainerRegionRgba8(container, { x: 2, y: 2, w: 8, h: 8 });

    expect(width).toBe(8);
    expect(height).toBe(8);
  });

  test("clamped to image edge — C++ clamps rx=6 rw=min(4,8-6)=2", async () => {
    const input = makeRgba8(8, 8);
    const container = await encodeTileContainerRgba8(input, 8, 8, { tileSize: 4, distance: 0 });

    const { width, height } = await decodeTileContainerRegionRgba8(container, { x: 6, y: 6, w: 4, h: 4 });

    expect(width).toBe(2);
    expect(height).toBe(2);
  });
```

- [ ] **Step 2: Run the correctness tests**

```powershell
bun test packages/jxl-wasm/test/jxtc.test.ts --test-name-pattern "correctness"
```

Expected: 6 tests pass. If any fail, read the error message — most likely causes:
- `CapabilityMissing`: WASM dist was not built with JXTC bridge. Run `node packages/jxl-wasm/scripts/build.mjs` or check `docs/` for the JXTC build instructions.
- `tileSize must be a positive integer`: Task 1 was not completed — the validation fix was not applied.
- Pixel mismatch on round-trip: verify `distance: 0` was passed and WASM is lossless at distance 0.

- [ ] **Step 3: Commit**

```bash
git add packages/jxl-wasm/test/jxtc.test.ts
git commit -m "test(jxl-wasm): JXTC correctness tests — round-trip, single tile, stitching, edge clamp"
```

---

## Task 4: Error-code tests (3 tests)

**Files:**
- Modify: `packages/jxl-wasm/test/jxtc.test.ts` (fill the error describe block)

Error messages have the form `"JXL tile container region decode failed (N)"` — produced by `readBufferView` in `facade.ts` when the WASM returns a handle with `dataPtr === 0` or `size === 0` and a non-zero `errorCode`. Match on the numeric suffix `"(N)"`.

- [ ] **Step 1: Write all 3 error tests**

Replace the `// Tests go here in Task 4` comment inside the error describe block with:

```typescript
  test("bad magic (101) — 32 zero bytes rejected at JXTC magic check", async () => {
    const badBytes = new Uint8Array(32); // all zeros — no JXTC magic

    await expect(
      decodeTileContainerRegionRgba8(badBytes, { x: 0, y: 0, w: 4, h: 4 }),
    ).rejects.toThrow("(101)");
  });

  test("wrong version (102) — JXTC magic present but version=2 unsupported", async () => {
    const buf = new Uint8Array(32);
    const v = new DataView(buf.buffer);
    v.setUint32(0, 0x4354584a, true); // 'JXTC' little-endian
    v.setUint32(4, 2, true);           // version = 2 (unsupported)

    await expect(
      decodeTileContainerRegionRgba8(buf, { x: 0, y: 0, w: 4, h: 4 }),
    ).rejects.toThrow("(102)");
  });

  test("zero-area region (105) — out-of-bounds region clamps to zero area", async () => {
    // Need a valid JXTC container to get past magic/version checks.
    const input = makeRgba8(8, 8);
    const container = await encodeTileContainerRgba8(input, 8, 8, { tileSize: 4, distance: 0 });

    // C++ clamps: rx = min(9999, 8) = 8, rw = min(4, 8 - 8) = 0 → error 105 (zero area)
    await expect(
      decodeTileContainerRegionRgba8(container, { x: 9999, y: 9999, w: 4, h: 4 }),
    ).rejects.toThrow("(105)");
  });
```

- [ ] **Step 2: Run the error tests**

```powershell
bun test packages/jxl-wasm/test/jxtc.test.ts --test-name-pattern "error codes"
```

Expected: 3 tests pass. If any fail:
- `"(101)"` not thrown: check that `decodeTileContainerRegionRgba8` doesn't silently swallow the error — verify the WASM function is exported in the dist.
- `"(102)"` not thrown: check the DataView byte order — `0x4354584a` is `JXTC` in little-endian (J=0x4A, X=0x58, T=0x54, C=0x43).
- `"(105)"` not thrown: the container encode may have failed silently — wrap the encode in its own expect and assert no throw first.

- [ ] **Step 3: Run the full suite**

```powershell
bun test packages/jxl-wasm/test/jxtc.test.ts
```

Expected output:
```
bun test v1.x
packages/jxl-wasm/test/jxtc.test.ts:
✓ JXTC tile container — correctness (distance: 0, tileSize: 4) > round-trip full image — pixels byte-for-byte equal to input
✓ JXTC tile container — correctness (distance: 0, tileSize: 4) > one tile exactly — single tile, no stitching
✓ JXTC tile container — correctness (distance: 0, tileSize: 4) > crosses 2 tiles horizontally — spans tile columns 0 and 1, row 0
✓ JXTC tile container — correctness (distance: 0, tileSize: 4) > crosses 4 tiles — all four tiles of a 2×2 grid
✓ JXTC tile container — correctness (distance: 0, tileSize: 4) > crosses 9 tiles — 4×4 tile grid, region spans 3×3 tiles
✓ JXTC tile container — correctness (distance: 0, tileSize: 4) > clamped to image edge — C++ clamps rx=6 rw=min(4,8-6)=2
✓ JXTC tile container — error codes > bad magic (101) — 32 zero bytes rejected at JXTC magic check
✓ JXTC tile container — error codes > wrong version (102) — JXTC magic present but version=2 unsupported
✓ JXTC tile container — error codes > zero-area region (105) — out-of-bounds region clamps to zero area

 9 pass
 0 fail
```

- [ ] **Step 4: Commit**

```bash
git add packages/jxl-wasm/test/jxtc.test.ts
git commit -m "test(jxl-wasm): JXTC error-code tests — bad magic (101), wrong version (102), zero-area (105)"
```

---

## Self-Review Against Spec

**Spec coverage:**

| Spec requirement | Covered |
|-----------------|---------|
| Round-trip full image, pixels equal | ✓ Task 3 |
| One tile exactly, 4×4 output | ✓ Task 3 |
| Crosses 2 tiles horizontal | ✓ Task 3 |
| Crosses 4 tiles | ✓ Task 3 |
| Crosses 9 tiles (16×16) | ✓ Task 3 |
| Clamped to image edge → 2×2 | ✓ Task 3 |
| Bad magic → error 101 | ✓ Task 4 |
| Wrong version → error 102 | ✓ Task 4 |
| Zero-area region → error 105 | ✓ Task 4 |
| No new fakes/mocks — real WASM only | ✓ `loadPreferredLibjxlModule` throughout |
| `bun test` — 9 tests green | ✓ Task 4 step 3 |
| `setJxlModuleFactoryForTesting(null)` in afterEach | ✓ Task 2 skeleton |
| `tileSize: 4` for all correctness tests | ✓ (requires Task 1 validation fix) |

**Placeholder scan:** None — all steps contain actual code.

**Type consistency:**
- `makeRgba8` returns `Uint8Array` — passed directly to `encodeTileContainerRgba8` which accepts `ArrayBuffer | Uint8Array`. ✓
- `encodeTileContainerRgba8` returns `Promise<Uint8Array>` — passed to `decodeTileContainerRegionRgba8` as `ArrayBuffer | Uint8Array`. ✓
- `decodeTileContainerRegionRgba8` returns `Promise<{ pixels: Uint8Array; width: number; height: number }>`. ✓
- `DataView` constructed on `buf.buffer` (ArrayBuffer). ✓
- `0x4354584a` little-endian: bytes [0x4a, 0x58, 0x54, 0x43] = J X T C. ✓
