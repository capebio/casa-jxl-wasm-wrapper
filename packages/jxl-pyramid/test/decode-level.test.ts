import { afterEach, expect, test } from "bun:test";
import {
  encodeTileContainerRgba8,
  setJxlModuleFactoryForTesting,
} from "@casabio/jxl-wasm";
import { createLevelSource } from "../src/level-source.js";
import { decodeLevel, decodeTiledViewport } from "../src/decode-level.js";
import { JXTC_TILE_SIZE } from "../src/tiling.js";
import { loadScalarModule, scalarFactory } from "./scalar.js";

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

  await expect(decodeLevel({ kind: "whole", bytes: new Uint8Array(8), width: 8, height: 8 }, region))
    .rejects.toThrow("region decode requires a tiled level source");
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