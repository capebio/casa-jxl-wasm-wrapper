import { expect, test } from "bun:test";

import { makePgoScenarioManifest, pickPgoSourceFiles } from "../../jxl-test-corpus/scripts/generate-pgo-fixtures.mjs";
import { compareEncodeBenchmarks, mean } from "../scripts/benchmark-pgo.mjs";

test("PPM corpus manifest uses scenario-based v2 layout", () => {
  const manifest = makePgoScenarioManifest();
  expect(manifest.version).toBe(2);
  expect(manifest.scenarios.map((scenario) => scenario.name)).toEqual([
    "gallery-scroll",
    "pyramid-ladder",
    "metadata-sidecars",
    "hiquality-archival",
  ]);
  expect(manifest.scenarios[0]?.files).toEqual(["tiles/256/*.ppm"]);
  expect(manifest.scenarios[1]?.files).toEqual(["full/*.ppm"]);
  expect(manifest.scenarios[2]?.files).toEqual(["full/withmeta/*.ppm"]);
});

test("source picker honors explicit files before directory scan", () => {
  const picked = pickPgoSourceFiles({
    sources: ["a.ORF", "b.ORF", "c.ORF"],
    limit: 2,
  });
  expect(picked).toEqual(["a.ORF", "b.ORF"]);
});

test("benchmark comparison reports relative win and default recommendation threshold", () => {
  const comparison = compareEncodeBenchmarks({
    baselineMs: [100, 102, 98],
    candidateMs: [90, 91, 89],
  });
  expect(mean([100, 102, 98])).toBe(100);
  expect(comparison.baselineMeanMs).toBe(100);
  expect(comparison.candidateMeanMs).toBe(90);
  expect(comparison.relativeGain).toBeCloseTo(0.1, 6);
  expect(comparison.meetsDefaultThreshold).toBe(true);
});

test("benchmark comparison rejects default-on when gain is below 2%", () => {
  const comparison = compareEncodeBenchmarks({
    baselineMs: [100, 101, 99],
    candidateMs: [99, 100, 98],
  });
  expect(comparison.relativeGain).toBeLessThan(0.02);
  expect(comparison.meetsDefaultThreshold).toBe(false);
});
