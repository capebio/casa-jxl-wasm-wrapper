// jxl-scheduler/test/scheduler.backpressure.test.ts
// Regression tests for waitForDrain promise resolution under cancel/shutdown.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";
import { FakeWorker, fakeWorkerFactory, makeDecodeStart } from "./helpers.js";

describe("Scheduler backpressure", () => {
  it("waitForDrain resolves when paused session is cancelled", async () => {
    const workers: FakeWorker[] = [];
    const sched = new Scheduler({
      factory: fakeWorkerFactory(workers),
      maxWorkers: 1,
      idleTimeoutMs: 60_000,
      pushHwm: 1, // HWM=1 so first waitForDrain immediately queues a waiter
    });

    // Start background session, run it to a worker.
    await sched.acquireSlot({
      sessionId: "bg-1",
      priority: "background",
      startMsg: makeDecodeStart("bg-1", "background"),
      sourceKey: null,
      signal: null,
    });
    const bgWorker = workers[0]!;

    // Preempt bg-1: visible job forces bg-1 to pause.
    const visPromise = sched.acquireSlot({
      sessionId: "vis-1",
      priority: "visible",
      startMsg: makeDecodeStart("vis-1", "visible"),
      sourceKey: null,
      signal: null,
    });
    // Let the preemption machinery send decode_pause.
    await new Promise<void>((r) => setTimeout(r, 10));
    bgWorker.emit({ type: "decode_paused", sessionId: "bg-1" });
    await visPromise;

    // bg-1 is now paused. Simulate an in-flight waitForDrain on it (queueDepth starts at 0 so
    // we manually create the backpressure state via two waitForDrain calls at pushHwm=1).
    // First call bumps queueDepth to 1 and returns immediately (< hwm).
    const drain1 = sched.waitForDrain("bg-1");
    // Second call bumps to 2 >= hwm=1 → queues a waiter promise.
    let drain2Resolved = false;
    const drain2 = sched.waitForDrain("bg-1").then(() => { drain2Resolved = true; });

    // Cancel the paused session — without the fix this promise would never resolve.
    sched.cancelSession("bg-1");

    await Promise.race([
      drain2,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("waitForDrain did not resolve within 500ms")), 500),
      ),
    ]);

    assert.equal(drain2Resolved, true, "waitForDrain resolved on paused-session cancel");

    // drain1 was already resolved (returned immediately), just await for cleanliness.
    await drain1;

    await sched.shutdown();
  });

  it("waitForDrain resolves on shutdown for running session", async () => {
    const workers: FakeWorker[] = [];
    const sched = new Scheduler({
      factory: fakeWorkerFactory(workers),
      maxWorkers: 1,
      idleTimeoutMs: 60_000,
      pushHwm: 1,
    });

    await sched.acquireSlot({
      sessionId: "run-1",
      priority: "visible",
      startMsg: makeDecodeStart("run-1", "visible"),
      sourceKey: null,
      signal: null,
    });

    // First waitForDrain returns immediately (queueDepth < hwm).
    await sched.waitForDrain("run-1");
    // Second queues a waiter.
    let drainResolved = false;
    const drainPromise = sched.waitForDrain("run-1").then(() => { drainResolved = true; });

    // Shutdown without sending terminal from worker — backpressure must still unblock.
    const shutdownPromise = sched.shutdown();

    await Promise.race([
      drainPromise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("waitForDrain did not resolve within 500ms")), 500),
      ),
    ]);

    assert.equal(drainResolved, true, "waitForDrain resolved during scheduler shutdown");

    await shutdownPromise;
  });
});
