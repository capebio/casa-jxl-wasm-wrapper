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

test("floor removed — sub-floor distance beats the old 1.5 clamp on the same level", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(async () => module);

  const W = 512, H = 512;
  const px = gradient(W, H);

  const q95 = await encodeRgba8Pyramid(px, W, H, {
    fullDistance: 1.0, sidecarSizes: [256], sidecarDistances: [0.55], effort: 3,
  });
  const atFloor = await encodeRgba8Pyramid(px, W, H, {
    fullDistance: 1.0, sidecarSizes: [256], sidecarDistances: [1.5], effort: 3,
  });

  expect(q95.length).toBe(2);
  expect(atFloor.length).toBe(2);
  expect(q95[0]!.width).toBe(256);
  expect(atFloor[0]!.width).toBe(256);
  expect(q95[1]!.width).toBe(512);
  expect(atFloor[1]!.width).toBe(512);

  expect(q95[0]!.data.byteLength).toBeGreaterThan(atFloor[0]!.data.byteLength * 1.15);

  const fullDelta = Math.abs(q95[1]!.data.byteLength - atFloor[1]!.data.byteLength);
  expect(fullDelta / atFloor[1]!.data.byteLength).toBeLessThan(0.02);

  setJxlModuleFactoryForTesting(null);
});

test("cascade produces the requested ladder in ascending order", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(async () => module);

  const W = 1280, H = 960;
  const px = gradient(W, H);
  const levels = await encodeRgba8Pyramid(px, W, H, {
    fullDistance: 0.55,
    sidecarSizes: [256, 512, 1024],
    sidecarDistances: [1.45, 1.45, 1.45],
    effort: 3,
  });

  expect(levels.map((l) => l.width)).toEqual([256, 512, 1024, 1280]);
  for (let i = 1; i < levels.length; i++) {
    expect(levels[i]!.width).toBeGreaterThan(levels[i - 1]!.width);
  }
  expect(levels[0]!.height).toBe(192);
  expect(levels.every((l) => l.bitsPerSample === 8)).toBe(true);

  setJxlModuleFactoryForTesting(null);
});

test("downscaleRgba16 averages 2x2 blocks correctly", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(async () => module);

  const src = new Uint16Array([
    1000, 2000, 3000, 4000,   5000, 6000, 7000, 8000,
    9000, 10000, 11000, 12000, 13000, 14000, 15000, 16000,
  ]);
  const out = await downscaleRgba16(src, 2, 2, 1, 1);
  expect(out.length).toBe(4);
  expect(out[0]).toBe((1000 + 5000 + 9000 + 13000) / 4);
  expect(out[1]).toBe((2000 + 6000 + 10000 + 14000) / 4);
  expect(out[2]).toBe((3000 + 7000 + 11000 + 15000) / 4);
  expect(out[3]).toBe((4000 + 8000 + 12000 + 16000) / 4);

  setJxlModuleFactoryForTesting(null);
});