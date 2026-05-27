// jxl-scheduler/test/scheduler.dedupe.test.ts
// Tests for dedupe / fan-out and partial-cancel semantics.
// Spec: Section 12.4, 21.3.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";
import { FakeWorker, fakeWorkerFactory, makeDecodeStart } from "./helpers.js";
describe("Scheduler dedupe", () => {
    it("second request for same key fans out, not a new decode", async () => {
        const workers = [];
        const sched = new Scheduler({
            factory: fakeWorkerFactory(workers),
            maxWorkers: 2,
            idleTimeoutMs: 60_000,
        });
        await sched.acquireSlot({
            sessionId: "s1",
            priority: "visible",
            startMsg: makeDecodeStart("s1", "visible"),
            sourceKey: "key-abc",
            signal: null,
        });
        await sched.acquireSlot({
            sessionId: "s2",
            priority: "visible",
            startMsg: makeDecodeStart("s2", "visible"),
            sourceKey: "key-abc",
            signal: null,
        });
        // Only one decode_start should have been sent (to the primary session's worker).
        const startMsgs = workers.flatMap((w) => w.messages).filter((m) => m.type === "decode_start");
        assert.equal(startMsgs.length, 1, "only one decode_start for deduped sessions");
        await sched.shutdown();
    });
    it("partial cancel: s2 cancels, s1 primary continues", async () => {
        const workers = [];
        const sched = new Scheduler({
            factory: fakeWorkerFactory(workers),
            maxWorkers: 2,
            idleTimeoutMs: 60_000,
        });
        await sched.acquireSlot({
            sessionId: "s1",
            priority: "visible",
            startMsg: makeDecodeStart("s1", "visible"),
            sourceKey: "key-abc",
            signal: null,
        });
        await sched.acquireSlot({
            sessionId: "s2",
            priority: "visible",
            startMsg: makeDecodeStart("s2", "visible"),
            sourceKey: "key-abc",
            signal: null,
        });
        const workerBefore = workers.flatMap((w) => w.messages).length;
        // s2 cancels. s1 is still subscribed so the primary should NOT be cancelled.
        sched.cancelSession("s2");
        await new Promise((res) => setTimeout(res, 10));
        const cancelSent = workers.flatMap((w) => w.messages).some((m) => m.type === "decode_cancel" && m.sessionId === "s1");
        assert.equal(cancelSent, false, "primary s1 not cancelled when only subscriber s2 cancels");
        await sched.shutdown();
    });
    it("all cancel: both gone triggers primary cancel", async () => {
        const workers = [];
        const sched = new Scheduler({
            factory: fakeWorkerFactory(workers),
            maxWorkers: 2,
            idleTimeoutMs: 60_000,
        });
        await sched.acquireSlot({
            sessionId: "s1",
            priority: "visible",
            startMsg: makeDecodeStart("s1", "visible"),
            sourceKey: "key-abc",
            signal: null,
        });
        await sched.acquireSlot({
            sessionId: "s2",
            priority: "visible",
            startMsg: makeDecodeStart("s2", "visible"),
            sourceKey: "key-abc",
            signal: null,
        });
        sched.cancelSession("s2");
        sched.cancelSession("s1");
        await new Promise((res) => setTimeout(res, 10));
        const cancelSent = workers.flatMap((w) => w.messages).some((m) => m.type === "decode_cancel" && m.sessionId === "s1");
        assert.ok(cancelSent, "primary cancelled when all subscribers cancel");
        await sched.shutdown();
    });
});
//# sourceMappingURL=scheduler.dedupe.test.js.map