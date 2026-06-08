import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const bridge = readFileSync(new URL("../src/bridge.cpp", import.meta.url), "utf8");
const facade = readFileSync(new URL("../src/facade.ts", import.meta.url), "utf8");
const exportsTxt = readFileSync(new URL("../exports.txt", import.meta.url), "utf8");

test("sidecar encoder takes per-level distances; v1 floor only on the null path", () => {
  expect(bridge).toContain("const float* sidecar_distances");
  expect(bridge).toContain("jxl_wasm_encode_rgba8_with_sidecars_v2");
  expect(bridge).toContain("sidecar_distances[i]");
  expect(bridge).toContain("std::max(full_distance, 1.5f)");
});

test("sidecars_v2 symbol is exported", () => {
  expect(exportsTxt).toContain("_jxl_wasm_encode_rgba8_with_sidecars_v2");
});

test("facade declares and wraps sidecars_v2", () => {
  expect(facade).toContain("_jxl_wasm_encode_rgba8_with_sidecars_v2?(");
  expect(facade).toContain("export async function encodeRgba8Pyramid");
  expect(facade).toContain("sidecarsV2:");
});

test("bridge defines a 16-bit area-box downscale", () => {
  expect(bridge).toContain("BoxDownscaleRgba16");
  expect(bridge).toContain("jxl_wasm_downscale_rgba16");
});

test("downscale_rgba16 symbol is exported", () => {
  expect(exportsTxt).toContain("_jxl_wasm_downscale_rgba16");
});

test("facade declares and wraps downscale_rgba16", () => {
  expect(facade).toContain("_jxl_wasm_downscale_rgba16?(");
  expect(facade).toContain("export async function downscaleRgba16");
  expect(facade).toContain("downscaleRgba16:");
});