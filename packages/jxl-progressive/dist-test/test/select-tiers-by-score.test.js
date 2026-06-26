// packages/jxl-progressive/test/select-tiers-by-score.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectTiersByScore } from "../src/progressive-profile.js";
const events = [
    { byteOffset: 100, progressionIndex: 0, score: 18 },
    { byteOffset: 250, progressionIndex: 1, score: 22 }, // first to clear dc=20
    { byteOffset: 600, progressionIndex: 2, score: 31 }, // first to clear preview=30
    { byteOffset: 900, progressionIndex: 3, score: 44 },
];
describe("selectTiersByScore", () => {
    it("dc tier = earliest event meeting dc threshold", () => {
        const tiers = selectTiersByScore(events, 1000, "psnr", { dc: 20, preview: 30 });
        const dc = tiers.find((t) => t.name === "dc");
        assert.equal(dc.byteEnd, 250);
        assert.equal(dc.score?.value, 22);
    });
    it("preview tier = earliest event meeting preview threshold, after dc", () => {
        const tiers = selectTiersByScore(events, 1000, "psnr", { dc: 20, preview: 30 });
        const preview = tiers.find((t) => t.name === "preview");
        assert.equal(preview.byteEnd, 600);
    });
    it("always ends with a full tier at total bytes", () => {
        const tiers = selectTiersByScore(events, 1000, "psnr", { dc: 20, preview: 30 });
        const full = tiers.at(-1);
        assert.equal(full.name, "full");
        assert.equal(full.byteEnd, 1000);
        assert.equal(full.progressionIndex, "final");
    });
});
//# sourceMappingURL=select-tiers-by-score.test.js.map