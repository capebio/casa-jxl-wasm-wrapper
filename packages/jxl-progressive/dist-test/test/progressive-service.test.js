// packages/jxl-progressive/test/progressive-service.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getOrBuildManifest } from "../src/progressive-service.js";
const fakeManifest = (metric) => ({
    version: 1,
    source: { width: 10, height: 10, hasAlpha: false, orientation: 1 },
    jxl: { bytes: 100, sha256: "a".repeat(64) },
    encoder: { name: "t", libjxlVersion: "0", flags: [] },
    tiers: [{ name: "full", byteStart: 0, byteEnd: 100, progressionIndex: "final", intendedUse: "zoom-export", score: { metric, value: 1, reference: "final" } }],
});
describe("getOrBuildManifest", () => {
    it("returns cached manifest without building", async () => {
        let builds = 0;
        const deps = {
            loadCached: async () => fakeManifest("butteraugli"),
            saveCached: async () => { },
            build: async () => { builds++; return fakeManifest("butteraugli"); },
        };
        const m = await getOrBuildManifest(deps, { sha256: "a".repeat(64), metric: "butteraugli" });
        assert.equal(m.tiers[0].score.metric, "butteraugli");
        assert.equal(builds, 0);
    });
    it("builds + caches on cache miss", async () => {
        let saves = 0;
        const deps = {
            loadCached: async () => null,
            saveCached: async () => { saves++; },
            build: async () => fakeManifest("butteraugli"),
        };
        const m = await getOrBuildManifest(deps, { sha256: "a".repeat(64), metric: "butteraugli" });
        assert.equal(m.tiers[0].score.metric, "butteraugli");
        assert.equal(saves, 1);
    });
    it("coalesces concurrent misses into a single build", async () => {
        let builds = 0;
        const deps = {
            loadCached: async () => null,
            saveCached: async () => { },
            build: async () => { builds++; await new Promise((r) => setTimeout(r, 5)); return fakeManifest("butteraugli"); },
        };
        const key = { sha256: "b".repeat(64), metric: "butteraugli" };
        await Promise.all([getOrBuildManifest(deps, key), getOrBuildManifest(deps, key)]);
        assert.equal(builds, 1);
    });
});
//# sourceMappingURL=progressive-service.test.js.map