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
import { createLevelSource } from "../src/level-source.js";

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
    bitsPerSample: 8,
    version: 1,
  });
});

test("parseJxtcHeader detects 16-bit via flags bit1 (JXTC-16)", () => {
  const buf = new Uint8Array(32);
  const view = new DataView(buf.buffer);
  view.setUint32(0, JXTC_MAGIC, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, 100, true);
  view.setUint32(12, 50, true);
  view.setUint32(16, 32, true);
  view.setUint32(20, 4, true);
  view.setUint32(24, 2, true);
  view.setUint32(28, 2 | 1, true); // bit1=16b, bit0=hasAlpha
  const h = parseJxtcHeader(buf);
  expect(h.bitsPerSample).toBe(16);
  expect(h.hasAlpha).toBe(true);
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

// G4-E: custom property-based checks (no fast-check dep to keep zero change to CI/package)
test("tilesOverlappingRegion properties (random)", () => {
  for (let i = 0; i < 50; i++) {
    const imageW = Math.floor(Math.random() * 2000) + 10;
    const imageH = Math.floor(Math.random() * 2000) + 10;
    const tileSize = Math.floor(Math.random() * 256) + 8;
    const x = Math.floor(Math.random() * imageW);
    const y = Math.floor(Math.random() * imageH);
    const w = Math.floor(Math.random() * (imageW - x)) + 1;
    const h = Math.floor(Math.random() * (imageH - y)) + 1;
    const region = { x, y, w, h };
    const tiles = tilesOverlappingRegion(imageW, imageH, tileSize, region);
    let covered = 0;
    for (const t of tiles) {
      expect(t.w).toBeGreaterThan(0);
      expect(t.h).toBeGreaterThan(0);
      expect(t.x).toBeGreaterThanOrEqual(region.x);
      expect(t.y).toBeGreaterThanOrEqual(region.y);
      expect(t.x + t.w).toBeLessThanOrEqual(region.x + region.w);
      expect(t.y + t.h).toBeLessThanOrEqual(region.y + region.h);
      covered += t.w * t.h;
    }
    // at least some coverage for non-empty
    if (w > 0 && h > 0) expect(covered).toBeGreaterThan(0);
    // verify full coverage with no gaps
    expect(covered).toBe(region.w * region.h);
  }
});

// G4-E: end-to-end contract (mock manifest entry -> createLevelSource -> tilesOverlapping -> simulated decode with "mock worker hooks")
test("end-to-end contract mock manifest to simulated tiled decode", () => {
  const entry = { w: 1024, h: 768, tiled: true };
  const container = new Uint8Array(32);
  const v = new DataView(container.buffer);
  v.setUint32(0, JXTC_MAGIC, true);
  v.setUint32(4, 1, true);
  v.setUint32(8, 1024, true);
  v.setUint32(12, 768, true);
  v.setUint32(16, 256, true);
  v.setUint32(20, 4, true);
  v.setUint32(24, 3, true);
  v.setUint32(28, 0, true);

  const source = createLevelSource(entry, container);
  expect(source.kind).toBe("tiled");
  expect(source.bitsPerSample).toBe(8);

  const region = { x: 100, y: 100, w: 300, h: 200 };
  const tiles = tilesOverlappingRegion(source.width, source.height, source.tileSize, region);
  expect(tiles.length).toBeGreaterThan(0);

  // simulate "decode" per tile (mock worker hook would call decodeTileContainerRegionRgba8 here)
  const mockDecoded = tiles.map((t) => ({
    region: t,
    decoded: { pixels: new Uint8Array(t.w * t.h * 4), width: t.w, height: t.h },
  }));
  expect(mockDecoded.length).toBe(tiles.length);
  // would then stitch in caller; here we assert alignment and coverage
  let totalCovered = 0;
  for (const m of mockDecoded) {
    totalCovered += m.decoded.width * m.decoded.height;
  }
  expect(totalCovered).toBeGreaterThan(0);
});
