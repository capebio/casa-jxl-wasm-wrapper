// packages/jxl-progressive/test/progressive-metrics.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { psnrVsRef, ssimVsRef, meetsThreshold } from "../src/progressive-metrics.js";
function solid(w, h, r, g, b) {
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        px[i * 4] = r;
        px[i * 4 + 1] = g;
        px[i * 4 + 2] = b;
        px[i * 4 + 3] = 255;
    }
    return px;
}
describe("progressive-metrics", () => {
    it("psnr is +Infinity for identical buffers", () => {
        const a = solid(8, 8, 100, 150, 200);
        assert.equal(psnrVsRef(a, a), Infinity);
    });
    it("psnr decreases as error grows", () => {
        const ref = solid(8, 8, 100, 100, 100);
        const near = solid(8, 8, 102, 100, 100);
        const far = solid(8, 8, 140, 100, 100);
        assert.ok(psnrVsRef(near, ref) > psnrVsRef(far, ref));
    });
    it("ssim is 1 for identical buffers", () => {
        const a = solid(8, 8, 100, 150, 200);
        assert.ok(Math.abs(ssimVsRef(a, a, 8, 8) - 1) < 1e-5);
    });
    it("meetsThreshold: higher-is-better for ssim/psnr, lower-is-better for butteraugli", () => {
        assert.equal(meetsThreshold("psnr", 35, 30), true);
        assert.equal(meetsThreshold("psnr", 25, 30), false);
        assert.equal(meetsThreshold("ssim", 0.9, 0.85), true);
        assert.equal(meetsThreshold("butteraugli", 0.8, 1.0), true);
        assert.equal(meetsThreshold("butteraugli", 1.5, 1.0), false);
    });
});
//# sourceMappingURL=progressive-metrics.test.js.map