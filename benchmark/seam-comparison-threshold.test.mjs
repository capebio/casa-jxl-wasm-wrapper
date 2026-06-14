import test from "node:test";
import assert from "node:assert/strict";

import { assessSeamComparison } from "./seam-comparison-threshold.mjs";

test("minor seam drift is accepted as within tolerance", () => {
  const result = assessSeamComparison({
    mismatches: 734,
    totalBytes: 1048576,
    maxDiff: 11,
  });

  assert.equal(result.status, "warn");
  assert.match(result.message, /within tolerance/i);
  assert.equal(result.shouldFail, false);
});

test("large seam drift fails the comparison", () => {
  const result = assessSeamComparison({
    mismatches: 50000,
    totalBytes: 1048576,
    maxDiff: 64,
  });

  assert.equal(result.status, "fail");
  assert.equal(result.shouldFail, true);
});
