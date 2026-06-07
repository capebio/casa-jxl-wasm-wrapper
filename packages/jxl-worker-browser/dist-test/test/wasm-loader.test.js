import { describe, test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { loadWasmModule } from "../src/wasm-loader.js";
import { expect } from "./expect.js";
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
    test("forces non-threaded simd tier for browser worker codec facade", async () => {
        const forcedTiers = [];
        const facade = {
            ...fakeFacade(),
            setForcedTier(tier) {
                forcedTiers.push(tier);
            },
        };
        const module = await loadWasmModule("https://example.invalid/jxl.wasm", {
            importWasm: async () => facade,
            fetchImpl: async () => {
                throw new Error("not used");
            },
        });
        expect(module).toBe(facade);
        expect(forcedTiers).toEqual(["simd"]);
    });
    test("worker tier auto query leaves codec tier unforced", async () => {
        const globalWithSelf = globalThis;
        const originalSelf = globalWithSelf.self;
        const forcedTiers = [];
        const facade = {
            ...fakeFacade(),
            setForcedTier(tier) {
                forcedTiers.push(tier);
            },
        };
        try {
            globalWithSelf.self = { location: { search: "?jxlWorkerTier=auto" } };
            const module = await loadWasmModule("https://example.invalid/jxl.wasm", {
                importWasm: async () => facade,
                fetchImpl: async () => {
                    throw new Error("not used");
                },
            });
            expect(module).toBe(facade);
            expect(forcedTiers).toEqual([]);
        }
        finally {
            globalWithSelf.self = originalSelf;
        }
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
        await expect(loadWasmModule("https://example.invalid/jxl.wasm", {
            importWasm: async () => ({ loadJxlModule() { } }),
            fetchImpl: async () => new Response(new Uint8Array([0]), { status: 200 }),
        })).rejects.toThrow("does not expose a codec facade");
    });
    test("reports unavailable wasm artifact on non-ok fetch", async () => {
        await expect(loadWasmModule("https://example.invalid/missing.wasm", {
            importWasm: async () => null,
            fetchImpl: async () => new Response(null, { status: 404 }),
        })).rejects.toThrow("WASM not available at https://example.invalid/missing.wasm (404)");
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
//# sourceMappingURL=wasm-loader.test.js.map