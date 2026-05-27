// jxl-scheduler/test/scheduler.budget.test.ts
// Tests for budget breach and partial-return semantics.
// Spec: Section 12.3, 21.3.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";
import { FakeWorker, fakeWorkerFactory, makeDecodeStart } from "./helpers.js";
describe("Scheduler budget breach", () => {
    it("forwards decode_budget_exceeded message with partial pixels to caller handlers", async () => {
        const workers = [];
        const sched = new Scheduler({
            factory: fakeWorkerFactory(workers),
            maxWorkers: 1,
            idleTimeoutMs: 60_000,
        });
        const received = [];
        sched.onMessage("s1", (msg) => received.push(msg));
        const startMsg = { ...makeDecodeStart("s1", "visible"), budgetMs: 100 };
        await sched.acquireSlot({
            sessionId: "s1",
            priority: "visible",
            startMsg,
            sourceKey: null,
            signal: null,
        });
        const worker = workers[0];
        const partialPixels = new ArrayBuffer(4);
        const budgetMsg = {
            type: "decode_budget_exceeded",
            sessionId: "s1",
            stage: "dc",
            pixels: partialPixels,
            info: {
                width: 1, height: 1, bitsPerSample: 8,
                hasAlpha: false, hasAnimation: false, jpegReconstructionAvailable: false,
            },
            format: "rgba8",
            pixelStride: 4,
        };
        worker.emit(budgetMsg);
        await new Promise((res) => setTimeout(res, 5));
        const forwarded = received.find((m) => m.type === "decode_budget_exceeded");
        assert.ok(forwarded !== undefined, "budget exceeded message forwarded to caller");
        await sched.shutdown();
    });
});
//# sourceMappingURL=scheduler.budget.test.js.map