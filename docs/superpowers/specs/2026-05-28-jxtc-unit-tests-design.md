# JXTC Unit Tests — Design

**Date:** 2026-05-28  
**Scope:** `packages/jxl-wasm/test/jxtc.test.ts`  
**Approach:** Integration tests using real WASM (Option A)

## Goal

Add automated correctness and error-code coverage for the JXTC tile container encode/decode path (`encodeTileContainerRgba8` / `decodeTileContainerRegionRgba8`). These run via `bun test` in Node/Bun, not in the browser. The browser benchmark page (`web/jxl-crop-benchmark.html`) handles perf testing separately.

## Constraints

- No new test infrastructure. Follow the pattern in `packages/jxl-wasm/test/facade.test.ts`.
- All tests use the real WASM via `setJxlModuleFactoryForTesting(loadPreferredLibjxlModule)`.
- `loadPreferredLibjxlModule` loads `../dist/jxl-core.scalar.js` (scalar tier, always available in Node/Bun where `detectTier()` returns `"scalar"`).
- Test images are tiny (8×8, 16×16) to keep encode time negligible.
- Use `distance: 0` (lossless) for any test that checks pixel correctness.

## File

```
packages/jxl-wasm/test/jxtc.test.ts
```

## Imports

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  encodeTileContainerRgba8,
  decodeTileContainerRegionRgba8,
  setJxlModuleFactoryForTesting,
} from "../src/index";
```

`loadPreferredLibjxlModule` is copied inline from `facade.test.ts` (loads scalar dist, falls back to fake module if dist is missing).

## Helper

```typescript
function makeRgba8(
  w: number,
  h: number,
  fill?: (i: number) => [number, number, number, number],
): Uint8Array
```

Generates a `w × h` RGBA8 buffer with a deterministic per-pixel pattern (default: `[i%256, (i*3)%256, (i*7)%256, 255]`). Used for pixel-exact round-trip verification.

## Test Cases

### Correctness (distance: 0, lossless)

All tests use `tileSize: 4`.

| Test | Image | Region | Expected output dims | Notes |
|------|-------|--------|----------------------|-------|
| Round-trip full image | 8×8 | {x:0, y:0, w:8, h:8} | 8×8 | Pixels byte-for-byte equal to input |
| One tile exactly | 8×8 | {x:0, y:0, w:4, h:4} | 4×4 | Single tile, no stitching |
| Crosses 2 tiles (horizontal) | 8×8 | {x:2, y:0, w:4, h:4} | 4×4 | Spans tile columns 0 and 1, row 0 |
| Crosses 4 tiles | 8×8 | {x:2, y:2, w:4, h:4} | 4×4 | All four tiles of a 2×2 grid |
| Crosses 9 tiles | 16×16 | {x:2, y:2, w:8, h:8} | 8×8 | 4×4 tile grid; region spans 3×3 tiles |
| Clamped to image edge | 8×8 | {x:6, y:6, w:4, h:4} | 2×2 | C++ clamps: rx=6, rw=min(4,8-6)=2 |

### Error cases

Error messages from `takeBuffer` have the form `"JXL tile container region decode failed (N)"`.

| Test | Container bytes | Region | Expected error code |
|------|----------------|--------|---------------------|
| Bad magic (101) | 32 zero bytes | {0,0,4,4} | 101 |
| Wrong version (102) | 32B: JXTC magic + version=2 | {0,0,4,4} | 102 |
| Zero-area region (105) | Valid 8×8 container | {9999,9999,4,4} | 105 |

For error 102, craft bytes with `DataView`:
```typescript
const buf = new Uint8Array(32);
const v = new DataView(buf.buffer);
v.setUint32(0, 0x4354584A, true); // 'JXTC' LE
v.setUint32(4, 2, true);           // version = 2 (unsupported)
```

Zero-area (105): region `{x:9999, y:9999, w:4, h:4}` on an 8×8 image. C++ clamps `rx = min(9999, 8) = 8`, then `rw = min(4, 8-8) = 0` → error 105.

## Success Criteria

- `bun test packages/jxl-wasm/test/jxtc.test.ts` passes with 9 tests green.
- No new fakes or mocks added — real WASM only.
- Correctness tests verify output dimensions; round-trip test also verifies pixel bytes.
- Error tests match on the numeric code in the thrown message.
