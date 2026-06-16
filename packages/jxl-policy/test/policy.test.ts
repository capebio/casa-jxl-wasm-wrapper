import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDecodePolicy,
  applyEncodePolicy,
  isDecodePolicyName,
  isEncodePolicyName,
  downsampleForContainer,
  decodePolicies,
  encodePolicies,
  type DecodePolicyName,
  type EncodePolicyName
} from "../src/index.js";

describe("@casabio/jxl-policy", () => {
  // 1. Caller wins
  test("caller wins: explicitly supplied options override policy defaults", () => {
    const opts = applyDecodePolicy("thumbnail", { format: "rgba8", downsample: 2 });
    assert.equal(opts.downsample, 2);
    assert.equal(opts.progressionTarget, "dc"); // still fills other gaps
  });

  // 2. Gap fill
  test("gap fill: empty base options receive all default policy fields", () => {
    const opts = applyDecodePolicy("viewer", { format: "rgba8" });
    assert.equal(opts.progressionTarget, "final");
    assert.equal(opts.emitEveryPass, true);
    assert.equal(opts.priority, "visible");
    assert.equal("downsample" in opts, false); // viewer has no downsample policy
  });

  // 3. Falsy preservation
  test("falsy preservation: explicit falsy caller values are preserved (?? instead of ||)", () => {
    const opts = applyDecodePolicy("viewer", { format: "rgba8", emitEveryPass: false });
    assert.equal(opts.emitEveryPass, false); // should stay false, not be overridden by viewer policy (true)
  });

  // 4. Explicit-undefined key
  test("explicit-undefined key: ensure explicit undefined keys in base do not result in present-but-undefined keys in output", () => {
    const opts = applyDecodePolicy("viewer", { format: "rgba8", downsample: undefined } as any);
    assert.equal("downsample" in opts, false);
  });

  // 5. Idempotence
  test("idempotence: applying a policy twice yields the same result as applying it once", () => {
    const decodeNames: DecodePolicyName[] = ["thumbnail", "gallery", "viewer", "export", "prefetch", "mlInference"];
    for (const name of decodeNames) {
      const base = { format: "rgba8" as const };
      const once = applyDecodePolicy(name, base);
      const twice = applyDecodePolicy(name, once);
      assert.deepEqual(once, twice);
    }

    const encodeNames: EncodePolicyName[] = ["thumbnail", "viewer", "archival"];
    for (const name of encodeNames) {
      const base = { format: "rgba8" as const, width: 100, height: 100, hasAlpha: false };
      const once = applyEncodePolicy(name, base);
      const twice = applyEncodePolicy(name, once);
      assert.deepEqual(once, twice);
    }
  });

  // 6. Unknown name throws
  test("unknown name throws RangeError with useful message, and guards function correctly", () => {
    assert.throws(
      () => applyDecodePolicy("bogus" as any, { format: "rgba8" }),
      (err: Error) => {
        assert(err instanceof RangeError);
        assert(err.message.includes('Unknown decode policy "bogus"'));
        assert(err.message.includes("thumbnail, gallery, viewer"));
        return true;
      }
    );

    assert.throws(
      () => applyEncodePolicy("bogus" as any, { format: "rgba8", width: 100, height: 100, hasAlpha: false }),
      (err: Error) => {
        assert(err instanceof RangeError);
        assert(err.message.includes('Unknown encode policy "bogus"'));
        assert(err.message.includes("thumbnail, viewer, archival"));
        return true;
      }
    );

    assert.equal(isDecodePolicyName("viewer"), true);
    assert.equal(isDecodePolicyName("mlInference"), true);
    assert.equal(isDecodePolicyName("bogus"), false);

    assert.equal(isEncodePolicyName("viewer"), true);
    assert.equal(isEncodePolicyName("bogus"), false);
  });

  // 7. Frozen tables
  test("frozen tables: attempting to mutate policy tables throws in strict mode or is ignored", () => {
    assert.throws(() => {
      (decodePolicies as any).thumbnail = { progressionTarget: "final" };
    }, TypeError);

    assert.throws(() => {
      (encodePolicies as any).viewer = { effort: 9 };
    }, TypeError);
  });

  // 8. Passthrough
  test("passthrough: unrelated base fields survive apply functions untouched", () => {
    const fakeSignal = {} as AbortSignal;
    const fakeMetric = () => {};
    const decoded = applyDecodePolicy("viewer", {
      format: "rgba8",
      signal: fakeSignal,
      budgetMs: 123,
      onMetric: fakeMetric,
    });

    assert.equal(decoded.signal, fakeSignal);
    assert.equal(decoded.budgetMs, 123);
    assert.equal(decoded.onMetric, fakeMetric);

    const encoded = applyEncodePolicy("viewer", {
      format: "rgba8",
      width: 100,
      height: 100,
      hasAlpha: false,
      signal: fakeSignal,
      onMetric: fakeMetric,
    });

    assert.equal(encoded.signal, fakeSignal);
    assert.equal(encoded.onMetric, fakeMetric);
  });

  // 9. Helper math
  test("helper math: downsampleForContainer computes correct power-of-two downsample factor", () => {
    // 1. (4000,3000,200,150) -> 8 (ratio 20, log2(20)=4, min(4,3)=3, 1<<3=8)
    assert.equal(downsampleForContainer(4000, 3000, 200, 150), 8);

    // 2. (4000,3000,1000,750) -> 4 (ratio 4, log2(4)=2, min(2,3)=2, 1<<2=4)
    assert.equal(downsampleForContainer(4000, 3000, 1000, 750), 4);

    // 3. (800,600,640,480) -> 1 (ratio 1.25, ratio < 2 -> 1)
    assert.equal(downsampleForContainer(800, 600, 640, 480), 1);

    // 4. (4000,3000,2001,1501) -> 1 (ratio 1.99, ratio < 2 -> 1)
    assert.equal(downsampleForContainer(4000, 3000, 2001, 1501), 1);

    // 5. (4000,3000,2000,1500) -> 2 (ratio 2, log2(2)=1, min(1,3)=1, 1<<1=2)
    assert.equal(downsampleForContainer(4000, 3000, 2000, 1500), 2);

    // 6. Zero/negative dimensions -> 1
    assert.equal(downsampleForContainer(0, 3000, 200, 150), 1);
    assert.equal(downsampleForContainer(4000, -5, 200, 150), 1);
    assert.equal(downsampleForContainer(4000, 3000, 0, 150), 1);
    assert.equal(downsampleForContainer(4000, 3000, 200, -100), 1);
  });
});
