import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { canUseThreadedWasm } from "../src/index.js";

const globalAny = globalThis as typeof globalThis & { self?: { crossOriginIsolated?: boolean } };
const originalWebAssemblyValidate = WebAssembly.validate;
const originalWebAssemblyInstantiate = WebAssembly.instantiate;
const originalSelf = globalAny.self;

describe("@casabio/jxl-capabilities tiering", () => {
  test("threaded WASM eligibility requires SharedArrayBuffer and cross-origin isolation (wasmThreads term dropped per policy; sab+coi matches detectTier)", () => {
    assert.equal(canUseThreadedWasm(true, true), true);
    assert.equal(canUseThreadedWasm(true, false), false);
    assert.equal(canUseThreadedWasm(false, true), false);
    assert.equal(canUseThreadedWasm(false, false), false);
  });

  test("detectTier and selectedWasmBuild both avoid threaded tiers when crossOriginIsolated is false", async () => {
    // Import the module first so the global stub is not active during the import() await.
    const mod = await import(`../src/index.js?no-mt=${Date.now()}`);

    const selfStub = { crossOriginIsolated: false } as any;
    const isThreadProbe = (view: Uint8Array) => view.includes(0xfe) && view.includes(0x10);
    const isRelaxedProbe = (view: Uint8Array) => view.includes(0xfd) && view.includes(0x80) && view.includes(0x02);
    const isSimdProbe = (view: Uint8Array) => view.includes(0xfd) && view.includes(0x0f);

    try {
      globalAny.self = selfStub;
      (WebAssembly as any).validate = (bytes: BufferSource) => {
        const view = ArrayBuffer.isView(bytes)
          ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : new Uint8Array(bytes);
        if (isThreadProbe(view)) return false;
        if (isRelaxedProbe(view)) return false;
        if (isSimdProbe(view)) return true;
        return false;
      };
      (WebAssembly as any).instantiate = async (bytes: BufferSource) => {
        const view = ArrayBuffer.isView(bytes)
          ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : new Uint8Array(bytes);
        if (isRelaxedProbe(view)) {
          throw new Error("relaxed simd unavailable");
        }
        if (isSimdProbe(view)) {
          return {} as WebAssembly.WebAssemblyInstantiatedSource;
        }
        if (isThreadProbe(view)) {
          return {} as WebAssembly.WebAssemblyInstantiatedSource;
        }
        throw new Error("unexpected wasm probe");
      };

      mod._resetCache();
      const tier = mod.detectTier();
      const capabilities = await mod.getCapabilities();

      assert.equal(tier, "simd");
      assert.equal(capabilities.selectedWasmBuild, "simd");
    } finally {
      (WebAssembly as any).validate = originalWebAssemblyValidate;
      (WebAssembly as any).instantiate = originalWebAssemblyInstantiate;
      globalAny.self = originalSelf;
      mod._resetCache();
    }
  });
});
