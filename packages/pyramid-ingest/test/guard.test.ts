import { expect, test } from "bun:test";

test("@casabio/jxl-wasm exposes the pyramid encode API", async () => {
  const mod = await import("@casabio/jxl-wasm");
  expect(typeof mod.encodeRgba8Pyramid).toBe("function");
  expect(typeof mod.transcodeJpegToJxl).toBe("function");
  expect(typeof mod.createDecoder).toBe("function");
  expect(typeof mod.setJxlModuleFactoryForTesting).toBe("function");
  expect(typeof mod.setForcedTier).toBe("function");
});