import { describe, expect, test } from "bun:test";
import { loadWasmModule } from "../src/wasm-loader";

describe("loadWasmModule", () => {
  test("returns an imported codec facade without fetching wasm bytes", async () => {
    let fetched = false;
    const facade = fakeFacade();

    const module = await loadWasmModule("https://example.invalid/jxl.wasm", {
      importWasm: async () => facade,
      fetchImpl: async () => {
        fetched = true;
        throw new Error("not used");
      },
    });

    expect(module).toBe(facade);
    expect(fetched).toBe(false);
  });

  test("default import resolves the built jxl-wasm facade from browser package layout", async () => {
    let fetched = false;

    const module = await loadWasmModule("https://example.invalid/jxl.wasm", {
      fetchImpl: async () => {
        fetched = true;
        throw new Error("not used");
      },
    });

    expect(typeof module.createDecoder).toBe("function");
    expect(typeof module.createEncoder).toBe("function");
    expect(fetched).toBe(false);
  });

  test("rejects fetched wasm bytes when package lacks codec facade", async () => {
    await expect(
      loadWasmModule("https://example.invalid/jxl.wasm", {
        importWasm: async () => ({ loadJxlModule() {} }),
        fetchImpl: async () => new Response(new Uint8Array([0]), { status: 200 }),
      }),
    ).rejects.toThrow("does not expose a codec facade");
  });

  test("reports unavailable wasm artifact on non-ok fetch", async () => {
    await expect(
      loadWasmModule("https://example.invalid/missing.wasm", {
        importWasm: async () => null,
        fetchImpl: async () => new Response(null, { status: 404 }),
      }),
    ).rejects.toThrow("WASM not available at https://example.invalid/missing.wasm (404)");
  });
});

function fakeFacade() {
  return {
    createDecoder() {
      throw new Error("not used");
    },
    createEncoder() {
      throw new Error("not used");
    },
  };
}
