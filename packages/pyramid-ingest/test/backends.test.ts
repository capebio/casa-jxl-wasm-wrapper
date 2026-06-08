import { expect, test, afterEach } from "bun:test";
import sharp from "sharp";
import { setForcedTier, setJxlModuleFactoryForTesting } from "@casabio/jxl-wasm";
import { createJxlBackend } from "../src/backends";
import { loadScalarModule, scalarFactory } from "./scalar";

afterEach(() => {
  setJxlModuleFactoryForTesting(null);
});

async function jpegFixture(w: number, h: number): Promise<Uint8Array> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      raw[o] = (x * 31 + y * 17) & 0xff;
      raw[o + 1] = (x * 7 + y * 53) & 0xff;
      raw[o + 2] = (x * 13 + y * 29) & 0xff;
    }
  }
  const jpg = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
  return new Uint8Array(jpg);
}

test("createJxlBackend transcodes a JPEG and decodes it back to RGBA8", async () => {
  setForcedTier("simd");
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));

  const jxl = createJxlBackend();
  const jpeg = await jpegFixture(640, 480);

  const transcoded = await jxl.transcodeJpeg(jpeg);
  expect(transcoded.byteLength).toBeGreaterThan(0);

  const decoded = await jxl.decodeToRgba8(transcoded);
  expect(decoded.width).toBe(640);
  expect(decoded.height).toBe(480);
  expect(decoded.rgba.length).toBe(640 * 480 * 4);
});

test("createJxlBackend.encodePyramid returns ascending 8-bit levels, full last", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));

  const jxl = createJxlBackend();
  const W = 1280, H = 960;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = i & 0xff; rgba[i + 1] = (i >> 3) & 0xff; rgba[i + 2] = (i >> 6) & 0xff; rgba[i + 3] = 255;
  }
  const levels = await jxl.encodePyramid(rgba, W, H, {
    fullDistance: 0.55, sidecarSizes: [256, 512, 1024], sidecarDistances: [1.45, 1.45, 1.45], effort: 3,
  });
  expect(levels.map((l) => l.width)).toEqual([256, 512, 1024, 1280]);
  for (let i = 1; i < levels.length; i++) {
    expect(levels[i]!.width).toBeGreaterThan(levels[i - 1]!.width);
  }
  expect(levels[0]!.data.byteLength).toBeGreaterThan(0);
});