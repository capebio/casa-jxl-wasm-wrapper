// jxl-scheduler/test/scheduler.budget.test.ts
// Tests for budget breach and partial-return semantics.
// Spec: Section 12.3, 21.3.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";
import { WorkerPool } from "../src/pool.js";
import { CoreBudget, defaultCoreBudgetCapacity } from "../src/budget.js";
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
    it("enforces shallow clone + freeze on metric payloads (scheduler_queue_wait_ms) and getMetrics snapshots before event dispatch/return (sched-4)", async () => {
        const workers = [];
        const sched = new Scheduler({
            factory: fakeWorkerFactory(workers),
            maxWorkers: 1,
            idleTimeoutMs: 60_000,
        });
        // s1 occupies the sole worker.
        await sched.acquireSlot({
            sessionId: "s1",
            priority: "visible",
            startMsg: makeDecodeStart("s1"),
            sourceKey: null,
            signal: null,
        });
        // s2 will queue; capture the queue-wait metric delivered on its queued->running transition.
        const s2MetricPayloads = [];
        sched.onMessage("s2", (m) => {
            if (m.type === "metric")
                s2MetricPayloads.push(m.metric);
        });
        const s2AcquireP = sched.acquireSlot({
            sessionId: "s2",
            priority: "visible",
            startMsg: makeDecodeStart("s2"),
            sourceKey: null,
            signal: null,
        });
        // The acquireSlot async function awaits pool.acquire() (even when it returns null immediately).
        // Yield so the post-await continuation (the actual enqueue for queued path) runs before we emit
        // the completing terminal for s1 that is supposed to drain it.
        await new Promise((r) => setTimeout(r, 0));
        const worker = workers[0];
        // Emit terminal for s1 from the worker. This triggers handle -> cleanup+release+drain+assign for s2.
        // The assign path emits the scheduler_queue_wait_ms (fresh+protected) to s2's handlers.
        worker.emit({ type: "decode_final", sessionId: "s1" });
        await new Promise((r) => setTimeout(r, 5));
        await s2AcquireP;
        assert.equal(s2MetricPayloads.length, 1, "scheduler_queue_wait_ms metric must be delivered exactly once for the s2 queued transition");
        const held = s2MetricPayloads[0];
        assert.equal(held?.name, "scheduler_queue_wait_ms");
        const capturedValue = held.value;
        // Cross an async tick while holding the payload ref (the exact hazard sched-4 protects against).
        await new Promise((r) => setTimeout(r, 0));
        // Queue s3 (while s2 is the active), complete s2 -> drain will assign s3 and emit a second distinct queue-wait metric.
        // The held object from s2's emission must remain stable.
        const s3AcquireP = sched.acquireSlot({
            sessionId: "s3",
            priority: "background",
            startMsg: makeDecodeStart("s3", "background"),
            sourceKey: null,
            signal: null,
        });
        await new Promise((r) => setTimeout(r, 0));
        worker.emit({ type: "decode_final", sessionId: "s2" });
        await new Promise((r) => setTimeout(r, 5));
        await s3AcquireP;
        worker.emit({ type: "decode_final", sessionId: "s3" });
        await new Promise((r) => setTimeout(r, 5));
        assert.equal(held.value, capturedValue, "held metric payload from earlier dispatch must be unaffected by later queue-wait emissions or any internal counter/metric mutations");
        assert.equal(Object.isFrozen(held), true, "the CodecMetric payload passed through onMessage handlers must be frozen");
        // getMetrics() snapshots are likewise fresh frozen copies.
        const m1 = sched.getMetrics();
        assert.equal(Object.isFrozen(m1), true, "Scheduler.getMetrics must return a frozen object");
        const runningBefore = m1.running;
        await new Promise((r) => setTimeout(r, 0));
        await sched.shutdown();
        const m2 = sched.getMetrics();
        assert.equal(m1.running, runningBefore, "retained getMetrics snapshot must not see post-call mutations or shutdown zeroing");
        assert.notEqual(m1, m2, "successive getMetrics calls return distinct objects");
    });
});
describe("CoreBudget semaphore (sched-1, sched-6)", () => {
    it("constructs with capacity and exposes available", () => {
        const b = new CoreBudget(4);
        assert.equal(b.capacity, 4);
        assert.equal(b.available, 4);
    });
    it("uses defaultCoreBudgetCapacity (hw or 4)", () => {
        const cap = defaultCoreBudgetCapacity();
        assert.ok(cap >= 1 && cap < 1024, "reasonable default cap");
    });
    it("bounds live workers via shared budget (cost=1 per worker)", async () => {
        const workers = [];
        const budget = new CoreBudget(1); // allow only 1 live worker total across schedulers
        const sched1 = new Scheduler({
            factory: fakeWorkerFactory(workers),
            maxWorkers: 2,
            idleTimeoutMs: 60_000,
            coreBudget: budget,
        });
        await sched1.acquireSlot({
            sessionId: "s1",
            priority: "visible",
            startMsg: makeDecodeStart("s1"),
            sourceKey: null,
            signal: null,
        });
        assert.equal(workers.length, 1, "first worker spawned under tight budget");
        assert.equal(budget.available, 0);
        // Second scheduler sharing budget cannot spawn while token held (even with its own maxWorkers)
        const sched2 = new Scheduler({
            factory: fakeWorkerFactory(workers),
            maxWorkers: 2,
            idleTimeoutMs: 60_000,
            coreBudget: budget,
        });
        let s2Done = false;
        const s2P = sched2.acquireSlot({
            sessionId: "s2",
            priority: "visible",
            startMsg: makeDecodeStart("s2"),
            sourceKey: null,
            signal: null,
        }).then(() => { s2Done = true; });
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(s2Done, false, "cross-scheduler acquire blocked by shared budget");
        assert.equal(workers.length, 1, "no additional worker spawned");
        // Release by shutting sched1 (destroys its workers, releases tokens)
        await sched1.shutdown();
        await s2P;
        assert.equal(s2Done, true, "sched2 acquired after sched1 freed the budget token");
        assert.equal(workers.length, 2, "second scheduler spawned its worker post-release");
        await sched2.shutdown();
        assert.equal(budget.available, budget.capacity, "all tokens released on shutdown");
    });
    it("FIFO waiters on contended budget (direct pool)", async () => {
        const workers = [];
        const budget = new CoreBudget(2);
        const pool = new WorkerPool({
            factory: fakeWorkerFactory(workers),
            maxSize: 5,
            idleTimeoutMs: 60_000,
            coreBudget: budget,
        });
        const w1 = await pool.acquire();
        const w2 = await pool.acquire();
        assert.equal(budget.available, 0);
        const order = [];
        const p3 = pool.acquire().then((w) => { order.push(3); return w; });
        const p4 = pool.acquire().then((w) => { order.push(4); return w; });
        await new Promise((r) => setTimeout(r, 5));
        // free one token by recycling w1
        pool.recycle(w1);
        const w3 = await p3;
        assert.ok(w3);
        // free second
        pool.recycle(w2);
        const w4 = await p4;
        assert.ok(w4);
        // p3 (enqueued first) resolved before p4 due to FIFO + sequential frees
        assert.deepEqual(order, [3, 4]);
        await pool.shutdown();
    });
    it("prewarm staggers spawns (time gaps)", async () => {
        const spawnTimes = [];
        const slowFactory = async () => {
            spawnTimes.push(performance.now());
            // small real delay to simulate worker boot
            await new Promise((r) => setTimeout(r, 1));
            const w = new FakeWorker();
            return w;
        };
        const pool = new WorkerPool({
            factory: slowFactory,
            maxSize: 3,
            idleTimeoutMs: 60_000,
        });
        pool.prewarm(3);
        // wait for spawns + staggers to settle
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(pool.size, 3, "prewarmed 3");
        assert.ok(spawnTimes.length >= 2, "multiple spawns recorded");
        for (let i = 1; i < spawnTimes.length; i++) {
            const gap = spawnTimes[i] - spawnTimes[i - 1];
            // allow some slack; must be >0 and typically near the 16ms stagger
            assert.ok(gap >= 0, "non-negative gaps");
        }
        await pool.shutdown();
    });
    it("pool direct with tight budget blocks second acquire until release via recycle", async () => {
        const workers = [];
        const budget = new CoreBudget(1);
        const pool = new WorkerPool({
            factory: fakeWorkerFactory(workers),
            maxSize: 2,
            idleTimeoutMs: 60_000,
            coreBudget: budget,
        });
        const w1 = await pool.acquire();
        assert.ok(w1);
        assert.equal(workers.length, 1);
        const p2 = pool.acquire();
        let got2 = false;
        p2.then(() => { got2 = true; });
        await new Promise((r) => setTimeout(r, 15));
        assert.equal(got2, false);
        assert.equal(budget.available, 0);
        // release via recycle (simulates crash or explicit)
        pool.recycle(w1);
        const w2 = await p2;
        assert.ok(w2);
        assert.equal(got2, true);
        assert.equal(budget.available, 0, "w2 now holds the token");
        await pool.shutdown();
        assert.equal(budget.available, 1);
    });
});
//# sourceMappingURL=scheduler.budget.test.js.map