import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  decodeTileContainerRegionRgba8,
  encodeTileContainerRgba8,
  setJxlModuleFactoryForTesting,
} from "../src/index";

async function loadPreferredLibjxlModule() {
  const imported = await import("../dist/jxl-core.scalar.js");
  if (typeof imported.default !== "function") {
    throw new Error("jxl-core.scalar.js did not export a loader function");
  }

  const baseUrl = new URL("../dist/", import.meta.url);
  const module = await imported.default({
    locateFile: (path: string) => new URL(path, baseUrl).href,
  });
  if (!module || typeof module._malloc !== "function" || typeof module._jxl_wasm_encode_rgba8 !== "function") {
    throw new Error("scalar WASM module missing required exports");
  }

  return module;
}

function makeRgba8(
  width: number,
  height: number,
  fill?: (i: number) => [number, number, number, number],
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const next = fill ?? ((i: number) => [i % 256, (i * 3) % 256, (i * 7) % 256, 255]);

  for (let i = 0; i < width * height; i++) {
    const [r, g, b, a] = next(i);
    const offset = i * 4;
    pixels[offset + 0] = r;
    pixels[offset + 1] = g;
    pixels[offset + 2] = b;
    pixels[offset + 3] = a;
  }

  return pixels;
}

describe("JXTC tile container - correctness (distance: 0, tileSize: 4)", () => {
  beforeEach(() => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
  });

  afterEach(() => {
    setJxlModuleFactoryForTesting(null);
  });

  test("round-trip full image - pixels byte-for-byte equal to input", { timeout: 10000 }, async () => {
    const input = makeRgba8(8, 8, () => [0, 0, 0, 255]);
    const container = await encodeTileContainerRgba8(input, 8, 8, { tileSize: 4, distance: 0 });

    const { pixels, width, height } = await decodeTileContainerRegionRgba8(container, { x: 0, y: 0, w: 8, h: 8 });

    expect(width).toBe(8);
    expect(height).toBe(8);
    expect(pixels.byteLength).toBe(8 * 8 * 4);
    expect(Array.from(pixels)).toEqual(Array.from(input));
  });

  test("one tile exactly - single tile, no stitching", { timeout: 10000 }, async () => {
    const input = makeRgba8(8, 8);
    const container = await encodeTileContainerRgba8(input, 8, 8, { tileSize: 4, distance: 0 });

    const { pixels, width, height } = await decodeTileContainerRegionRgba8(container, { x: 0, y: 0, w: 4, h: 4 });

    expect(width).toBe(4);
    expect(height).toBe(4);
    expect(pixels.byteLength).toBe(4 * 4 * 4);
  });

  test("crosses 2 tiles horizontally - spans tile columns 0 and 1, row 0", { timeout: 10000 }, async () => {
    const input = makeRgba8(8, 8);
    const container = await encodeTileContainerRgba8(input, 8, 8, { tileSize: 4, distance: 0 });

    const { pixels, width, height } = await decodeTileContainerRegionRgba8(container, { x: 2, y: 0, w: 4, h: 4 });

    expect(width).toBe(4);
    expect(height).toBe(4);
    expect(pixels.byteLength).toBe(4 * 4 * 4);
  });

  test("crosses 4 tiles - all four tiles of a 2x2 grid", { timeout: 10000 }, async () => {
    const input = makeRgba8(8, 8);
    const container = await encodeTileContainerRgba8(input, 8, 8, { tileSize: 4, distance: 0 });

    const { pixels, width, height } = await decodeTileContainerRegionRgba8(container, { x: 2, y: 2, w: 4, h: 4 });

    expect(width).toBe(4);
    expect(height).toBe(4);
    expect(pixels.byteLength).toBe(4 * 4 * 4);
  });

  test("crosses 9 tiles - 4x4 tile grid, region spans 3x3 tiles", { timeout: 15000 }, async () => {
    const input = makeRgba8(16, 16);
    const container = await encodeTileContainerRgba8(input, 16, 16, { tileSize: 4, distance: 0 });

    const { pixels, width, height } = await decodeTileContainerRegionRgba8(container, { x: 2, y: 2, w: 8, h: 8 });

    expect(width).toBe(8);
    expect(height).toBe(8);
    expect(pixels.byteLength).toBe(8 * 8 * 4);
  });

  test("clamped to image edge - C++ clamps rx=6 rw=min(4,8-6)=2", { timeout: 10000 }, async () => {
    const input = makeRgba8(8, 8);
    const container = await encodeTileContainerRgba8(input, 8, 8, { tileSize: 4, distance: 0 });

    const { pixels, width, height } = await decodeTileContainerRegionRgba8(container, { x: 6, y: 6, w: 4, h: 4 });

    expect(width).toBe(2);
    expect(height).toBe(2);
    expect(pixels.byteLength).toBe(2 * 2 * 4);
  });
});

describe("JXTC tile container - error codes", () => {
  beforeEach(() => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
  });

  afterEach(() => {
    setJxlModuleFactoryForTesting(null);
  });

  test("bad magic (101) - 32 zero bytes rejected at JXTC magic check", { timeout: 10000 }, async () => {
    const badBytes = new Uint8Array(32);

    await expect(
      decodeTileContainerRegionRgba8(badBytes, { x: 0, y: 0, w: 4, h: 4 }),
    ).rejects.toThrow("(101)");
  });

  test("wrong version (102) - JXTC magic present but version=2 unsupported", { timeout: 15000 }, async () => {
    const buf = new Uint8Array(32);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0x4354584a, true);
    view.setUint32(4, 2, true);

    await expect(
      decodeTileContainerRegionRgba8(buf, { x: 0, y: 0, w: 4, h: 4 }),
    ).rejects.toThrow("(102)");
  });

  test("zero-area region (105) - out-of-bounds region clamps to zero area", { timeout: 10000 }, async () => {
    const input = makeRgba8(8, 8);
    const container = await encodeTileContainerRgba8(input, 8, 8, { tileSize: 4, distance: 0 });

    await expect(
      decodeTileContainerRegionRgba8(container, { x: 9999, y: 9999, w: 4, h: 4 }),
    ).rejects.toThrow("(105)");
  });
});
