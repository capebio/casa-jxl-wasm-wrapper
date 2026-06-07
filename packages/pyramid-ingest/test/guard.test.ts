import { expect, test } from "bun:test";

// The single most important precondition: Plan A's facade export must be present in the
// COMPILED dist that this package resolves to (package.json exports -> dist/index.js).
// If dist is stale (jxl-wasm's build is WASM-only and does not run tsc), this fails loudly.
test("@casabio/jxl-wasm exposes the pyramid encode API", async () => {
  const mod = await import("@casabio/jxl-wasm");
  expect(typeof mod.encodeRgba8Pyramid).toBe("function");
  expect(typeof mod.transcodeJpegToJxl).toBe("function");
  expect(typeof mod.createDecoder).toBe("function");
  expect(typeof mod.setJxlModuleFactoryForTesting).toBe("function");
  expect(typeof mod.setForcedTier).toBe("function");
});
