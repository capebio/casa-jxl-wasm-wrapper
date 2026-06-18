// packages/jxl-progressive/test/saliency.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldUseSaliency, normaliseCenter, selectBestCenter, } from "../src/saliency-policy.js";
describe("shouldUseSaliency", () => {
    it("returns false for diagnostic image type regardless of confidence", () => {
        assert.equal(shouldUseSaliency({ imageType: "diagnostic", confidence: 0.99, centerCount: 1 }), false);
    });
    it("returns false for herbarium type", () => {
        assert.equal(shouldUseSaliency({ imageType: "herbarium", confidence: 0.99, centerCount: 1 }), false);
    });
    it("returns false for map type", () => {
        assert.equal(shouldUseSaliency({ imageType: "map", confidence: 0.99, centerCount: 1 }), false);
    });
    it("returns false for plate type", () => {
        assert.equal(shouldUseSaliency({ imageType: "plate", confidence: 0.99, centerCount: 1 }), false);
    });
    it("returns false for microscopy type", () => {
        assert.equal(shouldUseSaliency({ imageType: "microscopy", confidence: 0.99, centerCount: 1 }), false);
    });
    it("returns false when confidence < default threshold (0.6)", () => {
        assert.equal(shouldUseSaliency({ imageType: "portrait", confidence: 0.59, centerCount: 1 }), false);
    });
    it("returns false when confidence == 0.6 - epsilon (just below threshold)", () => {
        assert.equal(shouldUseSaliency({ imageType: "portrait", confidence: 0.5999, centerCount: 1 }), false);
    });
    it("returns true when confidence >= default threshold for portrait", () => {
        assert.equal(shouldUseSaliency({ imageType: "portrait", confidence: 0.6, centerCount: 1 }), true);
    });
    it("returns true for macro with high confidence", () => {
        assert.equal(shouldUseSaliency({ imageType: "macro", confidence: 0.8, centerCount: 1 }), true);
    });
    it("returns false when centerCount is 0", () => {
        assert.equal(shouldUseSaliency({ imageType: "portrait", confidence: 0.9, centerCount: 0 }), false);
    });
    it("respects custom confidenceThreshold", () => {
        assert.equal(shouldUseSaliency({ imageType: "portrait", confidence: 0.4, centerCount: 1, confidenceThreshold: 0.3 }), true);
        assert.equal(shouldUseSaliency({ imageType: "portrait", confidence: 0.4, centerCount: 1, confidenceThreshold: 0.5 }), false);
    });
    it("returns true for landscape with confidence above threshold (neutral, allowed)", () => {
        assert.equal(shouldUseSaliency({ imageType: "landscape", confidence: 0.75, centerCount: 1 }), true);
    });
    it("returns false for NaN confidence (fails closed, NaN < th is false)", () => {
        assert.equal(shouldUseSaliency({ imageType: "portrait", confidence: NaN, centerCount: 1 }), false);
        assert.equal(shouldUseSaliency({ imageType: "portrait", confidence: NaN, centerCount: 1, confidenceThreshold: 0.1 }), false);
    });
});
describe("normaliseCenter", () => {
    it("converts pixel centre to 0-1 range", () => {
        const result = normaliseCenter(200, 150, 400, 300);
        assert.equal(result.x, 0.5);
        assert.equal(result.y, 0.5);
    });
    it("handles top-left corner", () => {
        const result = normaliseCenter(0, 0, 800, 600);
        assert.equal(result.x, 0);
        assert.equal(result.y, 0);
    });
    it("handles bottom-right corner", () => {
        const result = normaliseCenter(800, 600, 800, 600);
        assert.equal(result.x, 1);
        assert.equal(result.y, 1);
    });
    it("handles non-square images", () => {
        const result = normaliseCenter(100, 200, 400, 800);
        assert.equal(result.x, 0.25);
        assert.equal(result.y, 0.25);
    });
    it("throws RangeError for non-positive imageWidth/imageHeight (0, negative, NaN)", () => {
        assert.throws(() => normaliseCenter(10, 20, 0, 100), RangeError);
        assert.throws(() => normaliseCenter(10, 20, 100, 0), RangeError);
        assert.throws(() => normaliseCenter(10, 20, -5, 100), RangeError);
        assert.throws(() => normaliseCenter(10, 20, 100, NaN), RangeError);
        assert.throws(() => normaliseCenter(10, 20, NaN, 100), RangeError);
    });
    it("includes the invalid dimensions in the RangeError message", () => {
        assert.throws(() => normaliseCenter(1, 2, 0, 600), /\[saliency-policy\] invalid image dimensions 0x600/);
    });
});
describe("selectBestCenter", () => {
    it("returns null for empty array", () => {
        assert.equal(selectBestCenter([]), null);
    });
    it("returns null when best confidence is below threshold", () => {
        assert.equal(selectBestCenter([{ x: 0.5, y: 0.5, confidence: 0.3 }]), null);
    });
    it("returns the highest-confidence centre above threshold", () => {
        const result = selectBestCenter([
            { x: 0.3, y: 0.3, confidence: 0.7 },
            { x: 0.8, y: 0.8, confidence: 0.9 },
            { x: 0.1, y: 0.1, confidence: 0.5 },
        ]);
        assert.deepEqual(result, { x: 0.8, y: 0.8, confidence: 0.9 });
    });
    it("respects custom threshold", () => {
        const result = selectBestCenter([{ x: 0.5, y: 0.5, confidence: 0.5 }], { threshold: 0.4 });
        assert.deepEqual(result, { x: 0.5, y: 0.5, confidence: 0.5 });
    });
    it("returns null for NaN confidence (fails closed)", () => {
        assert.equal(selectBestCenter([{ x: 0.5, y: 0.5, confidence: NaN }]), null);
        assert.equal(selectBestCenter([{ x: 0.1, y: 0.1, confidence: NaN }], { threshold: 0.0 }), null);
    });
});
//# sourceMappingURL=saliency.test.js.map