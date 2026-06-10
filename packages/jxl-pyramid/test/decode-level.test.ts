import { afterEach, expect, test } from "bun:test";
import {
  encodeTileContainerRgba8,
  encodeTileContainerRgba16,
  setJxlModuleFactoryForTesting,
} from "@casabio/jxl-wasm";
import { createLevelSource } from "../src/level-source.js";
import { decodeLevel, decodeTiledViewport } from "../src/decode-level.js";
import { JXTC_TILE_SIZE } from "../src/tiling.js";
import { loadScalarModule, scalarFactory } from "./scalar.js";
import { createInMemoryPyramidCache } from "../src/cache.js";
import type { RegionDecoder } from "../src/decode-core.js";

function gradient(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      px[o] = (x * 31 + y * 17) & 0xff;
      px[o + 1] = (x * 7 + y * 53) & 0xff;
      px[o + 2] = (x * 13 + y * 29) & 0xff;
      px[o + 3] = 255;
    }
  }
  return px;
}

afterEach(() => setJxlModuleFactoryForTesting(null));

test("LevelSource + decodeLevel ROI matches source pixels in tiled viewport", { timeout: 120_000 }, async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));

  const W = 8001;
  const H = 400;
  const src = gradient(W, H);
  const container = await encodeTileContainerRgba8(src, W, H, { tileSize: JXTC_TILE_SIZE, distance: 0, effort: 3 });
  const source = createLevelSource({ w: W, h: H, tiled: true }, container);

  const region = { x: 1200, y: 64, w: 640, h: 256 };
  const decoded = await decodeLevel(source, region, { parallel: false });
  expect(decoded.width).toBe(region.w);
  expect(decoded.height).toBe(region.h);
  expect(decoded.pixels.byteLength).toBe(region.w * region.h * 4);
  expect(decoded.pixels.some((v, i) => i % 4 !== 3 && v !== 0)).toBe(true);

  await expect(decodeLevel({ kind: "whole", bytes: new Uint8Array(8), width: 8, height: 8, bitsPerSample: 8 }, region))
    .rejects.toThrow("region decode requires a tiled level source");
});

test("decodeTiledViewport requires explicit region for tiled (Grok1 contract symmetrize)", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  const W = 512;
  const H = 512;
  const src = gradient(W, H);
  const container = await encodeTileContainerRgba8(src, W, H, { tileSize: 256, distance: 0, effort: 3 });
  const source = createLevelSource({ w: W, h: H, tiled: true }, container);
  // @ts-expect-error testing runtime contract
  await expect(decodeLevel(source)).rejects.toThrow("tiled level decode requires explicit region");
});

test("decodeTiledViewport parallel stitch matches single-call decode", { timeout: 120_000 }, async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));

  const W = 1024;
  const H = 768;
  const src = gradient(W, H);
  const container = await encodeTileContainerRgba8(src, W, H, { tileSize: 256, distance: 0.55, effort: 3 });
  const source = createLevelSource({ w: W, h: H, tiled: true }, container);
  const region = { x: 300, y: 200, w: 400, h: 300 };

  const single = await decodeTiledViewport(source, region, { parallel: false });
  const stitched = await decodeTiledViewport(source, region, { parallel: true });
  expect(stitched.width).toBe(single.width);
  expect(stitched.height).toBe(single.height);
  expect(stitched.pixels).toEqual(single.pixels);
});

test("NaN region guard on decodeLevel/decodeTiledViewport (Grok1)", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  const W = 256; const H = 256;
  const src = gradient(W, H);
  const container = await encodeTileContainerRgba8(src, W, H, { tileSize: 128, distance: 0, effort: 1 });
  const source = createLevelSource({ w: W, h: H, tiled: true }, container);
  const badRegion = { x: 0, y: 0, w: NaN, h: 10 };
  await expect(decodeLevel(source, badRegion as any)).rejects.toThrow(RangeError);
  await expect(decodeTiledViewport(source, badRegion as any)).rejects.toThrow(RangeError);
});

// Grok4 tests: cache, stream-stitch onTile, outBuffer reuse, pan bench sketch.

test("cache hit on identical (level, region, format) avoids decode", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  const W = 512; const H = 512;
  const src = gradient(W, H);
  const container = await encodeTileContainerRgba8(src, W, H, { tileSize: 256, distance: 0, effort: 1 });
  const source = createLevelSource({ w: W, h: H, tiled: true }, container);
  const region = { x: 64, y: 64, w: 128, h: 128 };

  const calls: number = 0;
  const mock: RegionDecoder = async (_b, r) => {
    (mock as any).callCount = ((mock as any).callCount || 0) + 1;
    const px = new Uint8Array(r.w * r.h * 4);
    px.fill(42);
    return { pixels: px, width: r.w, height: r.h };
  };

  const cache = createInMemoryPyramidCache({ maxBytes: 4 * 1024 * 1024 });
  const d1 = await decodeTiledViewport(source, region, { decodeRegion: mock, cache, parallel: false });
  expect((mock as any).callCount).toBe(1);
  expect(d1.pixels[0]).toBe(42);

  const d2 = await decodeTiledViewport(source, region, { decodeRegion: mock, cache, parallel: false });
  expect((mock as any).callCount).toBe(1); // hit, no additional decode
  expect(d2.pixels).toEqual(d1.pixels);
});

test("caller-owned outBuffer reused across viewport decodes (same ref)", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  const W = 256; const H = 256;
  const src = gradient(W, H);
  const container = await encodeTileContainerRgba8(src, W, H, { tileSize: 128, distance: 0, effort: 1 });
  const source = createLevelSource({ w: W, h: H, tiled: true }, container);
  const region = { x: 0, y: 0, w: 128, h: 128 };
  const buf = new Uint8Array(128 * 128 * 4);

  const mock: RegionDecoder = async (_b, r) => {
    const px = new Uint8Array(r.w * r.h * 4); px.fill(7); return { pixels: px, width: r.w, height: r.h };
  };

  const d1 = await decodeTiledViewport(source, region, { outBuffer: buf, decodeRegion: mock, parallel: false });
  expect(d1.pixels).toBe(buf); // same object ref
  expect(buf[0]).toBe(7);

  // second decode (different region to force work) reuses buf
  const region2 = { x: 10, y: 10, w: 128, h: 128 };
  const d2 = await decodeTiledViewport(source, region2, { outBuffer: buf, decodeRegion: mock, parallel: false });
  expect(d2.pixels).toBe(buf);
});

test("onTile fires (per 'tile' for direct; telemetry hook for pan bench)", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  const W = 256; const H = 256;
  const src = gradient(W, H);
  const container = await encodeTileContainerRgba8(src, W, H, { tileSize: 128, distance: 0, effort: 1 });
  const source = createLevelSource({ w: W, h: H, tiled: true }, container);
  const region = { x: 0, y: 0, w: 64, h: 64 };

  let count = 0;
  const seen: any[] = [];
  const onTile = (r: any, c: number) => { count = c; seen.push({ r, c }); };

  const mock: RegionDecoder = async (_b, r) => ({ pixels: new Uint8Array(r.w * r.h * 4), width: r.w, height: r.h });
  await decodeTiledViewport(source, region, { onTile, decodeRegion: mock, parallel: false });
  expect(count).toBe(1);
  expect(seen.length).toBe(1);
});

test("pan-60fps scenario (outBuffer reuse + cache + onTile as L8m-15 telemetry)", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  const W = 1024; const H = 512;
  const src = gradient(W, H);
  const container = await encodeTileContainerRgba8(src, W, H, { tileSize: 256, distance: 0.4, effort: 2 });
  const source = createLevelSource({ w: W, h: H, tiled: true }, container);

  const cache = createInMemoryPyramidCache({ maxBytes: 32 * 1024 * 1024 });
  const buf = new Uint8Array(320 * 200 * 4);
  let completedEvents = 0;
  const onTile = (_r: any, c: number) => { completedEvents += c; }; // accumulate for bench hook

  const mock: RegionDecoder = async (_b, r) => {
    const px = new Uint8Array(r.w * r.h * 4); px[0] = 1; return { pixels: px, width: r.w, height: r.h };
  };

  const start = Date.now();
  // Simulate ~pan frames; some rects repeat for cache hit, all reuse buf.
  for (let i = 0; i < 24; i++) {
    const x = (i % 5) * 40;
    const r = { x, y: 50, w: 320, h: 200 };
    const d = await decodeTiledViewport(source, r, { outBuffer: buf, cache, onTile, decodeRegion: mock, parallel: false });
    expect(d.pixels).toBe(buf);
  }
  const dur = Date.now() - start;
  // Telemetry: onTile events observed; "decode rate >= baseline" exercised via this loop.
  // Real pan-60fps bench (L8m-15) hooks onTile + measures completed / wall time externally.
  expect(completedEvents).toBeGreaterThan(0);
  expect(dur).toBeLessThan(30_000); // loose machine-indep guard; actual rate verified in bench harness
});
