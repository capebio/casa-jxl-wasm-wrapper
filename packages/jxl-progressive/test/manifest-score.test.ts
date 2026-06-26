// packages/jxl-progressive/test/manifest-score.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateManifest, type ProgressiveManifest } from "../src/progressive-manifest.js";

function baseManifest(): ProgressiveManifest {
  return {
    version: 1,
    source: { width: 100, height: 100, hasAlpha: false, orientation: 1 },
    jxl: { bytes: 1000, sha256: "a".repeat(64) },
    encoder: { name: "test", libjxlVersion: "0.12", flags: [] },
    tiers: [
      { name: "dc", byteStart: 0, byteEnd: 200, progressionIndex: 0, intendedUse: "thumbnail" },
      { name: "full", byteStart: 0, byteEnd: 1000, progressionIndex: "final", intendedUse: "zoom-export" },
    ],
  };
}

describe("manifest tier score", () => {
  it("accepts a tier with a valid score", () => {
    const m = baseManifest();
    (m.tiers[0] as { score?: unknown }).score = { metric: "psnr", value: 28.5, reference: "final" };
    assert.doesNotThrow(() => validateManifest(m));
  });

  it("rejects an unknown score metric", () => {
    const m = baseManifest();
    (m.tiers[0] as { score?: unknown }).score = { metric: "vmaf", value: 90, reference: "final" };
    assert.throws(() => validateManifest(m), /score\.metric/);
  });

  it("rejects a non-finite score value", () => {
    const m = baseManifest();
    (m.tiers[0] as { score?: unknown }).score = { metric: "ssim", value: NaN, reference: "final" };
    assert.throws(() => validateManifest(m), /score\.value/);
  });

  it("accepts a tier with no score (backward compat)", () => {
    assert.doesNotThrow(() => validateManifest(baseManifest()));
  });
});
