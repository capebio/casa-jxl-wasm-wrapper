// packages/jxl-progressive/test/progressive-scale.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../src/progressive-manifest.js";
import { selectFrontierTier, selectTierForDisplay } from "../src/progressive-scale.js";
function m() {
    return {
        version: 1,
        source: { width: 4000, height: 3000, hasAlpha: false, orientation: 1 },
        jxl: { bytes: 100000, sha256: "a".repeat(64) },
        encoder: { name: "t", libjxlVersion: "0.12", flags: [] },
        tiers: [
            { name: "dc", byteStart: 0, byteEnd: 8000, progressionIndex: 0, intendedUse: "thumbnail" },
            { name: "preview", byteStart: 0, byteEnd: 40000, progressionIndex: 2, intendedUse: "visible-card" },
            { name: "full", byteStart: 0, byteEnd: 100000, progressionIndex: "final", intendedUse: "zoom-export" },
        ],
        scaleFrontier: [
            { maxDisplayPx: 256, tier: "dc", byteEnd: 8000, score: { metric: "psnr", value: 36, reference: "final" } },
            { maxDisplayPx: 1024, tier: "preview", byteEnd: 40000, score: { metric: "psnr", value: 34, reference: "final" } },
            { maxDisplayPx: 99999, tier: "full", byteEnd: 100000, score: { metric: "psnr", value: 99, reference: "final" } },
        ],
    };
}
describe("scale frontier", () => {
    it("validates a manifest with a scaleFrontier", () => {
        assert.doesNotThrow(() => validateManifest(m()));
    });
    it("rejects a frontier entry whose byteEnd exceeds jxl.bytes", () => {
        const bad = m();
        bad.scaleFrontier[0].byteEnd = 200000;
        assert.throws(() => validateManifest(bad), /scaleFrontier/);
    });
    it("selectFrontierTier picks the smallest tier covering the display size", () => {
        assert.equal(selectFrontierTier(m(), 200).tier, "dc");
        assert.equal(selectFrontierTier(m(), 800).tier, "preview");
        assert.equal(selectFrontierTier(m(), 5000).tier, "full");
    });
    it("selectTierForDisplay multiplies element size by DPR (longest edge)", () => {
        // 180px element at DPR 2 → 360px longest edge → needs preview, not dc
        const sel = selectTierForDisplay(m(), 180, 120, 2);
        assert.equal(sel.tier, "preview");
        assert.equal(sel.byteEnd, 40000);
    });
    it("selectTierForDisplay falls back to tiers heuristic when no frontier", () => {
        const noFrontier = m();
        delete noFrontier.scaleFrontier;
        const sel = selectTierForDisplay(noFrontier, 100, 100, 1);
        assert.ok(["dc", "preview", "full"].includes(sel.tier));
        assert.ok(sel.byteEnd > 0);
    });
});
//# sourceMappingURL=progressive-scale.test.js.map