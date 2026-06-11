import { describe, test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { loadWasmModule } from "../src/wasm-loader.js";
import { expect } from "./expect.js";

function withMockSelf(search: string, fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "self");
    Object.defineProperty(globalThis, "self", {
      value: { location: { search } },
      configurable: true,
      writable: true,
    });
    try {
      await fn();
    } finally {
      if (desc) {
        Object.defineProperty(globalThis, "self", desc);
      } else {
        // @ts-ignore
        delete globalThis.self;
      }
    }
  };
}

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

  test("explicit simd query forces non-threaded tier (override honored)", async () => {
    const forcedTiers: string[] = [];
    const facade = {
      ...fakeFacade(),
      setForcedTier(tier: string) {
        forcedTiers.push(tier);
      },
    };

    const run = withMockSelf("?jxlWorkerTier=simd", async () => {
      const module = await loadWasmModule("https://example.invalid/jxl.wasm", {
        importWasm: async () => facade,
        fetchImpl: async () => {
          throw new Error("not used");
        },
      });

      expect(module).toBe(facade);
      expect(forcedTiers).toEqual(["simd"]);
    });
    await run();
  });

  test("no query string defaults to auto (no forceWorkerSafeTier) — locks W-1 default choice", async () => {
    const forcedTiers: string[] = [];
    const facade = {
      ...fakeFacade(),
      setForcedTier(tier: string) {
        forcedTiers.push(tier);
      },
    };

    // no self.location override — readWorkerLocationSearch returns "", readWorkerTierOverride now returns "auto"
    const module = await loadWasmModule("https://example.invalid/jxl.wasm", {
      importWasm: async () => facade,
      fetchImpl: async () => {
        throw new Error("not used");
      },
    });

    expect(module).toBe(facade);
    expect(forcedTiers).toEqual([]);
  });

  test("worker tier auto query leaves codec tier unforced", async () => {
    const forcedTiers: string[] = [];
    const facade = {
      ...fakeFacade(),
      setForcedTier(tier: string) {
        forcedTiers.push(tier);
      },
    };

    const run = withMockSelf("?jxlWorkerTier=auto", async () => {
      const module = await loadWasmModule("https://example.invalid/jxl.wasm", {
        importWasm: async () => facade,
        fetchImpl: async () => {
          throw new Error("not used");
        },
      });

      expect(module).toBe(facade);
      expect(forcedTiers).toEqual([]);
    });
    await run();
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

  test("has no top-level bare jxl-wasm import in the worker module graph", () => {
    const sourceUrl = new URL("../src/wasm-loader.ts", import.meta.url);
    const compiledUrl = new URL("../../src/wasm-loader.ts", import.meta.url);
    const distUrl = new URL("../dist/wasm-loader.js", import.meta.url);
    const compiledDistUrl = new URL("../../dist/wasm-loader.js", import.meta.url);
    const source = readFileSync(existsSync(sourceUrl) ? sourceUrl : compiledUrl, "utf8");
    const distSource = readFileSync(existsSync(distUrl) ? distUrl : compiledDistUrl, "utf8");

    expect(source.includes('from "@casabio/jxl-wasm"')).toBe(false);
    expect(distSource.includes('from "@casabio/jxl-wasm"')).toBe(false);
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
