// packages/jxl-progressive/test/cache.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProgressiveCache } from "../src/progressive-cache.js";
// Minimal in-memory stub for JxlCacheBrowser
function makeInnerCache() {
    const store = new Map();
    return {
        store,
        async get(key) { return store.get(key); },
        async set(key, buf) { store.set(key, buf); },
    };
}
const validManifest = {
    version: 1,
    source: { width: 100, height: 100, hasAlpha: false, orientation: 1 },
    jxl: { bytes: 5000, sha256: "a".repeat(64) },
    encoder: { name: "cjxl", libjxlVersion: "0.11.0", flags: [] },
    tiers: [
        { name: "dc", byteStart: 0, byteEnd: 500, progressionIndex: 1, intendedUse: "thumbnail" },
        { name: "full", byteStart: 0, byteEnd: 5000, progressionIndex: "final", intendedUse: "zoom-export" },
    ],
};
describe("ProgressiveCache — manifests", () => {
    it("returns null for unknown jxlUrl", async () => {
        const cache = new ProgressiveCache(makeInnerCache());
        assert.equal(await cache.getManifest("https://example.com/img.jxl"), null);
    });
    it("stores and retrieves a manifest", async () => {
        const cache = new ProgressiveCache(makeInnerCache());
        await cache.setManifest("https://example.com/img.jxl", validManifest);
        const retrieved = await cache.getManifest("https://example.com/img.jxl");
        assert.ok(retrieved !== null);
        assert.equal(retrieved.version, 1);
        assert.equal(retrieved.jxl.bytes, 5000);
    });
    it("invalidateManifest removes the entry", async () => {
        const cache = new ProgressiveCache(makeInnerCache());
        await cache.setManifest("https://example.com/img.jxl", validManifest);
        await cache.invalidateManifest("https://example.com/img.jxl");
        assert.equal(await cache.getManifest("https://example.com/img.jxl"), null);
    });
});
describe("ProgressiveCache — byte ranges", () => {
    it("returns null for unknown byte range", async () => {
        const cache = new ProgressiveCache(makeInnerCache());
        assert.equal(await cache.getByteRange("https://example.com/img.jxl", "dc"), null);
    });
    it("stores and retrieves a byte range", async () => {
        const cache = new ProgressiveCache(makeInnerCache());
        const buf = new ArrayBuffer(1024);
        await cache.setByteRange("https://example.com/img.jxl", "dc", buf);
        const retrieved = await cache.getByteRange("https://example.com/img.jxl", "dc");
        assert.ok(retrieved !== null);
        assert.equal(retrieved.byteLength, 1024);
    });
    it("different tiers stored independently", async () => {
        const cache = new ProgressiveCache(makeInnerCache());
        await cache.setByteRange("https://example.com/img.jxl", "dc", new ArrayBuffer(100));
        await cache.setByteRange("https://example.com/img.jxl", "preview", new ArrayBuffer(500));
        const dc = await cache.getByteRange("https://example.com/img.jxl", "dc");
        const preview = await cache.getByteRange("https://example.com/img.jxl", "preview");
        assert.equal(dc?.byteLength, 100);
        assert.equal(preview?.byteLength, 500);
    });
});
describe("ProgressiveCache — invalidate all", () => {
    it("invalidate removes manifest and byte ranges for a url", async () => {
        const inner = makeInnerCache();
        const cache = new ProgressiveCache(inner);
        await cache.setManifest("https://example.com/img.jxl", validManifest);
        await cache.setByteRange("https://example.com/img.jxl", "dc", new ArrayBuffer(100));
        await cache.invalidate("https://example.com/img.jxl");
        assert.equal(await cache.getManifest("https://example.com/img.jxl"), null);
        assert.equal(await cache.getByteRange("https://example.com/img.jxl", "dc"), null);
    });
    it("does not affect different url", async () => {
        const cache = new ProgressiveCache(makeInnerCache());
        await cache.setManifest("https://example.com/a.jxl", validManifest);
        await cache.setManifest("https://example.com/b.jxl", validManifest);
        await cache.invalidate("https://example.com/a.jxl");
        assert.ok(await cache.getManifest("https://example.com/b.jxl") !== null);
    });
});
//# sourceMappingURL=cache.test.js.map