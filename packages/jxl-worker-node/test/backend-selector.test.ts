import { describe, test } from "node:test";
import { expect } from "./expect.js";
import { selectBackend } from "../src/backend-selector.js";

describe("selectBackend", () => {
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
    ).rejects.toThrow("Neither jxl-native nor jxl-wasm exposes a codec facade. Install usable @casabio/jxl-native or @casabio/jxl-wasm artifacts. Diagnostics:");
  });

  test("ESM default interop: can resolve loadNativeBinding from default property", async () => {
    const backend = await selectBackend({
      env: {},
      importNative: async () => ({
        default: {
          loadNativeBinding() {
            return fakeCodecModule();
          },
        },
      }),
      importWasm: async () => fakeCodecModule(),
    });

    expect(backend.type).toBe("native");
  });

  test("JXL_FORCE_NATIVE=1 throws on native failure and stops fallback to WASM", async () => {
    await expect(
      selectBackend({
        env: { JXL_FORCE_NATIVE: "1" },
        importNative: async () => ({
          loadNativeBinding() {
            throw new Error("addon compilation failed");
          },
        }),
        importWasm: async () => fakeCodecModule(),
      }),
    ).rejects.toThrow("JXL_FORCE_NATIVE=1 but native backend failed to load. Diagnostics:");
  });

  test("uses onDiagnostic option callback", async () => {
    const diagnostics: string[] = [];
    await expect(
      selectBackend({
        env: {},
        importNative: async () => null,
        importWasm: async () => null,
        onDiagnostic: (msg) => diagnostics.push(msg),
      }),
    ).rejects.toThrow();

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.some(d => d.includes("Failed to import @casabio/jxl-native"))).toBe(true);
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
