import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendWorkerTierQuery,
  parseRequestedWorkerTier,
  shouldUseMtImmediately,
} from "../src/tier-routing.js";

describe("tier routing helpers", () => {
  it("parses explicit MT tier from wasmUrl", () => {
    assert.equal(parseRequestedWorkerTier("/worker.js?jxlWorkerTier=relaxed-simd-mt"), "relaxed-simd-mt");
    assert.equal(parseRequestedWorkerTier("/worker.js?jxlWorkerTier=simd-mt"), "simd-mt");
    assert.equal(parseRequestedWorkerTier("/worker.js"), "auto");
  });

  it("adds or replaces jxlWorkerTier query", () => {
    assert.equal(
      appendWorkerTierQuery("/worker.js?foo=1", "simd"),
      "/worker.js?foo=1&jxlWorkerTier=simd",
    );
    assert.equal(
      appendWorkerTierQuery("/worker.js?jxlWorkerTier=relaxed-simd-mt", "simd"),
      "/worker.js?jxlWorkerTier=simd",
    );
  });

  it("allows immediate MT only when idle worker or spawn budget is available", () => {
    assert.equal(
      shouldUseMtImmediately({ poolIdle: 1, poolSize: 1, poolSpawning: 0 }, 2, 0, 4),
      true,
    );
    assert.equal(
      shouldUseMtImmediately({ poolIdle: 0, poolSize: 1, poolSpawning: 0 }, 2, 4, 4),
      true,
    );
    assert.equal(
      shouldUseMtImmediately({ poolIdle: 0, poolSize: 2, poolSpawning: 0 }, 2, 4, 4),
      false,
    );
    assert.equal(
      shouldUseMtImmediately({ poolIdle: 0, poolSize: 1, poolSpawning: 1 }, 2, 4, 4),
      false,
    );
  });
});
