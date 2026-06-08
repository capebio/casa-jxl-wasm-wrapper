import { expect, test } from "bun:test";
import {
  isJxtcContainer,
  JXTC_MAGIC,
  MASSIVE_LONG_EDGE_THRESHOLD,
  MASSIVE_PIXEL_THRESHOLD,
  parseJxtcHeader,
  shouldTileTopLevel,
  tilesOverlappingRegion,
} from "../src/tiling.js";

test("shouldTileTopLevel gates on long edge OR megapixels", () => {
  expect(shouldTileTopLevel(6000, 4000)).toBe(false);
  expect(shouldTileTopLevel(MASSIVE_LONG_EDGE_THRESHOLD, 1000)).toBe(false);
  expect(shouldTileTopLevel(MASSIVE_LONG_EDGE_THRESHOLD + 1, 1000)).toBe(true);
  expect(shouldTileTopLevel(7000, Math.ceil(MASSIVE_PIXEL_THRESHOLD / 7000) + 1)).toBe(true);
});

test("parseJxtcHeader reads the 32-byte container header", () => {
  const buf = new Uint8Array(32);
  const view = new DataView(buf.buffer);
  view.setUint32(0, JXTC_MAGIC, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, 9000, true);
  view.setUint32(12, 6000, true);
  view.setUint32(16, 512, true);
  view.setUint32(20, 18, true);
  view.setUint32(24, 12, true);
  view.setUint32(28, 1, true);
  expect(isJxtcContainer(buf)).toBe(true);
  expect(parseJxtcHeader(buf)).toEqual({
    imageW: 9000,
    imageH: 6000,
    tileSize: 512,
    tilesX: 18,
    tilesY: 12,
    hasAlpha: true,
  });
});

test("tilesOverlappingRegion returns tile-aligned intersections", () => {
  const tiles = tilesOverlappingRegion(100, 100, 32, { x: 10, y: 10, w: 50, h: 50 });
  expect(tiles.length).toBeGreaterThan(1);
  for (const t of tiles) {
    expect(t.w).toBeGreaterThan(0);
    expect(t.h).toBeGreaterThan(0);
    expect(t.x).toBeGreaterThanOrEqual(10);
    expect(t.y).toBeGreaterThanOrEqual(10);
  }
});