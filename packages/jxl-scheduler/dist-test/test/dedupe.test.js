// jxl-scheduler/test/dedupe.test.ts
// Tests for DedupeRegistry: subscription, cancellation, partial-cancel semantics.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DedupeRegistry } from "../src/dedupe.js";
describe("DedupeRegistry", () => {
    it("registers and finds primary session", () => {
        const reg = new DedupeRegistry();
        reg.register("s1", "key-a");
        assert.equal(reg.findPrimary("key-a"), "s1");
        assert.equal(reg.findPrimary("key-b"), null);
    });
    it("fan-out: subscriber sees same primary", () => {
        const reg = new DedupeRegistry();
        reg.register("s1", "key-a");
        const sub = reg.subscribe("s2", "s1");
        assert.equal(sub.primarySessionId, "s1");
        assert.equal(sub.subscriberId, "s2");
        assert.deepEqual(reg.subscribers("s1").sort(), ["s1", "s2"]);
    });
    it("partial cancel: one subscriber gone, primary survives", () => {
        const reg = new DedupeRegistry();
        reg.register("s1", "key-a");
        reg.subscribe("s2", "s1");
        reg.subscribe("s3", "s1");
        const result = reg.cancelSubscriber("s2");
        assert.equal(result.cancelWorker, false, "primary survives when other subscribers exist");
        assert.deepEqual(reg.subscribers("s1").sort(), ["s1", "s3"]);
    });
    it("all cancel: last subscriber gone cancels primary", () => {
        const reg = new DedupeRegistry();
        reg.register("s1", "key-a");
        reg.subscribe("s2", "s1");
        reg.cancelSubscriber("s2");
        const result = reg.cancelSubscriber("s1");
        assert.equal(result.cancelWorker, true, "primary should be cancelled when all subscribers gone");
        assert.equal(reg.findPrimary("key-a"), null, "key removed after all cancel");
    });
    it("complete removes key", () => {
        const reg = new DedupeRegistry();
        reg.register("s1", "key-a");
        reg.complete("s1");
        assert.equal(reg.findPrimary("key-a"), null);
    });
    it("does not allow stale key reuse after primary completes", () => {
        const reg = new DedupeRegistry();
        reg.register("s1", "key-a");
        reg.complete("s1");
        // A new session can now register with the same key.
        reg.register("s2", "key-a");
        assert.equal(reg.findPrimary("key-a"), "s2");
    });
});
//# sourceMappingURL=dedupe.test.js.map