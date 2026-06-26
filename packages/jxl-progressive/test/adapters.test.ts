// packages/jxl-progressive/test/adapters.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeButteraugliScorer, makeWasmDownscaler } from "../src/progressive-adapters.js";

describe("adapters", () => {
  it("butteraugli scorer reports metric 'butteraugli' and forwards to computeButteraugli", async () => {
    let calls = 0;
    const compute = async (_a: Uint8Array, _b: Uint8Array, _w: number, _h: number): Promise<number> => { calls++; return 0.42; };
    const scorer = makeButteraugliScorer(compute);
    assert.equal(scorer.metric, "butteraugli");
    const v = await scorer.score(new Uint8Array(16), new Uint8Array(16), 2, 2);
    assert.equal(v, 0.42);
    assert.equal(calls, 1);
  });

  it("wasm downscaler forwards dims to downscale_rgba and returns its bytes", () => {
    let calledWith: number[] = [];
    const ds = (_src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array => {
      calledWith = [sw, sh, dw, dh];
      return new Uint8Array(dw * dh * 4);
    };
    const down = makeWasmDownscaler(ds);
    const out = down(new Uint8Array(64 * 4), 8, 8, 4, 4);
    assert.equal(out.length, 4 * 4 * 4);
    assert.deepEqual(calledWith, [8, 8, 4, 4]);
  });
});
