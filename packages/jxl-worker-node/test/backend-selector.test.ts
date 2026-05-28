import { describe, test } from "node:test";
import { expect } from "./expect.js";
import { selectBackend } from "../src/backend-selector.js";

describe("selectBackend", () => {
  test("attaches a wasm build tier when WASM wins selection", async () => {
    const backend = await selectBackend({
      env: {},
      importNative: async () => {
        throw new Error("native unavailable");
      },
      importWasm: async () => fakeCodecModule(),
    });

    expect(backend.type).toBe("wasm");
    expect(backend.wasmBuild).toBeDefined();
    expect(["relaxed-simd-mt", "simd-mt", "simd", "scalar"]).toContain(backend.wasmBuild);
  });

  test("skips imported native module without codec facade and falls back to WASM", async () => {
    const backend = await selectBackend({
      env: {},
      importNative: async () => ({ loadNativeBinding() {} }),
      importWasm: async () => fakeCodecModule(),
    });

    expect(backend.type).toBe("wasm");
    expect(backend.module).toBeDefined();
  });

  test("falls back when native facade cannot load its addon", async () => {
    const backend = await selectBackend({
      env: {},
      importNative: async () => ({
        createDecoder() {},
        createEncoder() {},
        loadNativeBinding() {
          throw new Error("missing addon");
        },
      }),
      importWasm: async () => fakeCodecModule(),
    });

    expect(backend.type).toBe("wasm");
  });

  test("rejects a native binding that reports loaded false", async () => {
    const backend = await selectBackend({
      env: {},
      importNative: async () => ({
        loadNativeBinding() {
          return {
            probe() {
              return { loaded: false, path: "stub" };
            },
            createDecoder() {},
            createEncoder() {},
          };
        },
      }),
      importWasm: async () => fakeCodecModule(),
    });

    expect(backend.type).toBe("wasm");
  });

  test("JXL_FORCE_WASM skips native import", async () => {
    let nativeImported = false;
    const backend = await selectBackend({
      env: { JXL_FORCE_WASM: "1" },
      importNative: async () => {
        nativeImported = true;
        return fakeCodecModule();
      },
      importWasm: async () => fakeCodecModule(),
    });

    expect(backend.type).toBe("wasm");
    expect(nativeImported).toBe(false);
  });

  test("throws CapabilityMissing when neither backend exposes codec facade", async () => {
    await expect(
      selectBackend({
        env: {},
        importNative: async () => ({ probe() {} }),
        importWasm: async () => ({ loadJxlModule() {} }),
      }),
    ).rejects.toThrow("Neither jxl-native nor jxl-wasm exposes a codec facade");
  });
});

function fakeCodecModule() {
  return {
    createDecoder() {
      throw new Error("not used");
    },
    createEncoder() {
      throw new Error("not used");
    },
  };
}
