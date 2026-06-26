// packages/jxl-progressive/test/progressive-edge.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveTierRequest, type EdgeDeps, type TierPolicy } from "../src/progressive-edge.js";
import type { ProgressiveManifest, ScoreMetric } from "../src/progressive-manifest.js";

function manifest(metric: ScoreMetric): ProgressiveManifest {
  return {
    version: 1,
    source: { width: 4000, height: 3000, hasAlpha: false, orientation: 1 },
    jxl: { bytes: 100000, sha256: "a".repeat(64) },
    encoder: { name: "t", libjxlVersion: "0", flags: [] },
    tiers: [
      { name: "dc", byteStart: 0, byteEnd: 8000, progressionIndex: 0, intendedUse: "thumbnail" },
      { name: "preview", byteStart: 0, byteEnd: 40000, progressionIndex: 2, intendedUse: "visible-card" },
      { name: "full", byteStart: 0, byteEnd: 100000, progressionIndex: "final", intendedUse: "zoom-export" },
    ],
    scaleFrontier: [
      { maxDisplayPx: 256, tier: "dc", byteEnd: 8000, score: { metric, value: 36, reference: "final" } },
      { maxDisplayPx: 1024, tier: "preview", byteEnd: 40000, score: { metric, value: 34, reference: "final" } },
      { maxDisplayPx: 99999, tier: "full", byteEnd: 100000, score: { metric, value: 99, reference: "final" } },
    ],
  };
}

const policy: TierPolicy = (userTier) =>
  userTier === "premium" ? { metric: "butteraugli", maxTier: "full" } : { metric: "ssim", maxTier: "preview" };

const deps: EdgeDeps = { getManifest: async (_sha, metric) => manifest(metric), policy };

describe("resolveTierRequest", () => {
  it("premium gets butteraugli manifest + full ceiling", async () => {
    const r = await resolveTierRequest(deps, { sha256: "a".repeat(64), userTier: "premium", displayPx: 4000 });
    assert.equal(r.metric, "butteraugli");
    assert.equal(r.rangeEnd, 100000 - 1);
  });

  it("free user is clamped to preview ceiling even when zoomed", async () => {
    const r = await resolveTierRequest(deps, { sha256: "a".repeat(64), userTier: "free", displayPx: 4000 });
    assert.equal(r.metric, "ssim");
    assert.equal(r.rangeEnd, 40000 - 1); // clamped to preview, NOT full
    assert.equal(r.tier, "preview");
  });

  it("small display selects an earlier tier within the ceiling", async () => {
    const r = await resolveTierRequest(deps, { sha256: "a".repeat(64), userTier: "premium", displayPx: 200 });
    assert.equal(r.rangeEnd, 8000 - 1); // dc, under the full ceiling
  });
});
