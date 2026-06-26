// packages/jxl-progressive/test/profile-frontier.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildScaleFrontier } from "../src/progressive-profile.js";
const W = 8, H = 8;
function solid(v) {
    const p = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
        p[i * 4] = v;
        p[i * 4 + 1] = v;
        p[i * 4 + 2] = v;
        p[i * 4 + 3] = 255;
    }
    return p;
}
function checker() {
    const p = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
            const v = ((x + y) & 1) ? 255 : 0;
            const i = (y * W + x) * 4;
            p[i] = v;
            p[i + 1] = v;
            p[i + 2] = v;
            p[i + 3] = 255;
        }
    return p;
}
// Box-average downscaler (matches the production wasm downscale_rgba family).
function boxAvg(rgba, w, h, dw, dh) {
    const out = new Uint8Array(dw * dh * 4);
    const xs = w / dw, ys = h / dh;
    for (let y = 0; y < dh; y++)
        for (let x = 0; x < dw; x++) {
            const x0 = Math.floor(x * xs), x1 = Math.max(x0 + 1, Math.floor((x + 1) * xs));
            const y0 = Math.floor(y * ys), y1 = Math.max(y0 + 1, Math.floor((y + 1) * ys));
            let r = 0, g = 0, b = 0, a = 0, cnt = 0;
            for (let sy = y0; sy < y1; sy++)
                for (let sx = x0; sx < x1; sx++) {
                    const si = (sy * w + sx) * 4;
                    r += rgba[si];
                    g += rgba[si + 1];
                    b += rgba[si + 2];
                    a += rgba[si + 3];
                    cnt++;
                }
            const di = (y * dw + x) * 4;
            out[di] = r / cnt;
            out[di + 1] = g / cnt;
            out[di + 2] = b / cnt;
            out[di + 3] = a / cnt;
        }
    return out;
}
describe("buildScaleFrontier", () => {
    it("smaller display sizes select earlier (cheaper) tiers — scale-dependence", async () => {
        const finalPixels = checker();
        const passes = [
            { byteOffset: 1000, progressionIndex: 0, pixels: solid(128) }, // ~avg of checker: matches downsampled, fails at native
            { byteOffset: 5000, progressionIndex: 2, pixels: checker() }, // == final: matches at native
        ];
        const tiers = [
            { name: "dc", byteStart: 0, byteEnd: 1000, progressionIndex: 0, intendedUse: "thumbnail" },
            { name: "preview", byteStart: 0, byteEnd: 5000, progressionIndex: 2, intendedUse: "visible-card" },
            { name: "full", byteStart: 0, byteEnd: 8000, progressionIndex: "final", intendedUse: "zoom-export" },
        ];
        const frontier = await buildScaleFrontier({
            passes, finalPixels, srcW: W, srcH: H, tiers, totalBytes: 8000,
            metric: "psnr", thresholds: { dc: 20, preview: 30 }, displaySizes: [1, 8], downscaler: boxAvg,
        });
        const at1 = frontier.find((e) => e.maxDisplayPx === 1);
        const at8 = frontier.find((e) => e.maxDisplayPx === 8);
        assert.ok(at1.byteEnd < at8.byteEnd, `tiny-display byteEnd ${at1.byteEnd} must be < native ${at8.byteEnd}`);
        assert.equal(at1.tier, "dc");
        assert.equal(at8.tier, "preview");
    });
    it("returns one entry per display size, byteEnds non-decreasing", async () => {
        const finalPixels = solid(128);
        const passes = [{ byteOffset: 1000, progressionIndex: 0, pixels: solid(126) }];
        const tiers = [
            { name: "dc", byteStart: 0, byteEnd: 1000, progressionIndex: 0, intendedUse: "thumbnail" },
            { name: "full", byteStart: 0, byteEnd: 4000, progressionIndex: "final", intendedUse: "zoom-export" },
        ];
        const sizes = [2, 4, 8];
        const frontier = await buildScaleFrontier({
            passes, finalPixels, srcW: W, srcH: H, tiers, totalBytes: 4000,
            metric: "psnr", thresholds: { dc: 20, preview: 30 }, displaySizes: sizes, downscaler: boxAvg,
        });
        assert.equal(frontier.length, sizes.length);
        for (let i = 1; i < frontier.length; i++)
            assert.ok(frontier[i].byteEnd >= frontier[i - 1].byteEnd);
    });
});
//# sourceMappingURL=profile-frontier.test.js.map