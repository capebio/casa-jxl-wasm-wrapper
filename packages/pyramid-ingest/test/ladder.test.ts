import { expect, test, afterEach } from "bun:test";
import { setJxlModuleFactoryForTesting } from "@casabio/jxl-wasm";
import { buildRawLadder, buildJpgLadder, buildProxyLadder } from "../src/ladder";
import { createJxlBackend, type JxlBackend, type DecodedMaster } from "../src/backends";
import { loadScalarModule, scalarFactory } from "./scalar";

afterEach(() => setJxlModuleFactoryForTesting(null));

function gradientRgba(w: number, h: number): Uint8Array {
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

test("buildRawLadder keeps every encoded level, ascending, full last, all 8-bit baked", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  const jxl = createJxlBackend();
  const W = 1280, H = 960;
  const decoded: DecodedMaster = { rgba: gradientRgba(W, H), width: W, height: H, orientation: "baked" };

  const ladder = await buildRawLadder(jxl, decoded);
  expect(ladder.orientation).toBe("baked");
  expect(ladder.width).toBe(W);
  expect(ladder.height).toBe(H);
  expect(ladder.levels.map((l) => l.width)).toEqual([256, 512, 1024, 1280]);
});

test("buildJpgLadder substitutes the lossless transcode as the full level", async () => {
  const transcodeBytes = new Uint8Array([0xff, 0x0a, 0x42, 0x13]);
  const fake: JxlBackend = {
    async transcodeJpeg() { return transcodeBytes; },
    async decodeToRgba8() { return { rgba: gradientRgba(1280, 960), width: 1280, height: 960 }; },
    async encodePyramid(_rgba, _w, _h, opts) {
      const sidecars = opts.sidecarSizes.filter((s) => s < 1280).map((s) => ({
        data: new Uint8Array([s & 0xff]), width: s, height: Math.round((s * 960) / 1280),
      }));
      return [...sidecars, { data: new Uint8Array([0xde, 0xad]), width: 1280, height: 960 }];
    },
  };
  const ladder = await buildJpgLadder(fake, new Uint8Array([1, 2, 3]));
  expect(ladder.orientation).toBe("source");
  expect(ladder.levels.map((l) => l.width)).toEqual([256, 512, 1024, 1280]);
  const full = ladder.levels[ladder.levels.length - 1]!;
  expect(full.data).toEqual(transcodeBytes);
});

test("buildProxyLadder returns exactly one level", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  const jxl = createJxlBackend();
  const W = 2000, H = 1500;
  const ladder = await buildProxyLadder(jxl, gradientRgba(W, H), W, H, 512, "baked");
  expect(ladder.levels).toHaveLength(1);
  expect(Math.max(ladder.levels[0]!.width, ladder.levels[0]!.height)).toBe(512);
});