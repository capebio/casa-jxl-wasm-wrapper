// jxl-scheduler/test/scheduler.preemption.test.ts
// Integration tests for preemption: visible job preempts background job.
// Spec: Section 12.2, 21.3.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";
import { FakeWorker, fakeWorkerFactory, makeDecodeStart } from "./helpers.js";

describe("Scheduler preemption", () => {
  it("visible job preempts background job when pool full", async () => {
    const workers: FakeWorker[] = [];
    const sched = new Scheduler({
      factory: fakeWorkerFactory(workers),
      maxWorkers: 1,
      idleTimeoutMs: 60_000,
    });

    // Start a background session.
    const bgPromise = sched.acquireSlot({
      sessionId: "bg-1",
      priority: "background",
      startMsg: makeDecodeStart("bg-1", "background"),
      sourceKey: null,
      signal: null,
    });

    // Wait for the bg session to bind to a worker.
    await Promise.resolve();
    const { workerId: bgWorkerId } = await bgPromise;
    assert.ok(bgWorkerId >= 0, "background session bound to worker");

    // The worker received decode_start.
    const bgWorker = workers[0]!;
    assert.equal(bgWorker.messages[0]?.type, "decode_start");

    // Now submit a visible session. Pool is full; preemption should fire.
    let visibleResolved = false;
    const visiblePromise = sched.acquireSlot({
      sessionId: "vis-1",
      priority: "visible",
      startMsg: makeDecodeStart("vis-1", "visible"),
      sourceKey: null,
      signal: null,
    }).then((r) => { visibleResolved = true; return r; });

    // Simulate: worker receives decode_pause and responds with decode_paused.
    // The scheduler pauses decode victims first so state can resume later.
    await new Promise<void>((res) => setTimeout(res, 10));

    const pauseMsg = bgWorker.messages.find((m) => m.type === "decode_pause" && m.sessionId === "bg-1");
    assert.ok(pauseMsg !== undefined, "scheduler sent decode_pause to background session");

    // Emit decode_paused so scheduler knows preemption complete.
    bgWorker.emit({ type: "decode_paused", sessionId: "bg-1" });

    await new Promise<void>((res) => setTimeout(res, 10));
    assert.ok(visibleResolved, "visible session acquired slot after preemption");

    const visStart = bgWorker.messages.find((m) => m.type === "decode_start" && m.sessionId === "vis-1");
    assert.ok(visStart !== undefined, "visible session's decode_start forwarded to worker");

    await sched.shutdown();
  });

  it("near job does NOT preempt background job", async () => {
    const workers: FakeWorker[] = [];
    const sched = new Scheduler({
      factory: fakeWorkerFactory(workers),
      maxWorkers: 1,
      idleTimeoutMs: 60_000,
    });

    await sched.acquireSlot({
      sessionId: "bg-1",
      priority: "background",
      startMsg: makeDecodeStart("bg-1", "background"),
      sourceKey: null,
      signal: null,
    });

    const bgWorker = workers[0]!;
    const msgsBefore = bgWorker.messages.length;

    // Near job queues instead of preempting.
    let nearResolved = false;
    sched.acquireSlot({
      sessionId: "nr-1",
      priority: "near",
      startMsg: makeDecodeStart("nr-1", "near"),
      sourceKey: null,
      signal: null,
    }).then(() => { nearResolved = true; });

    await new Promise<void>((res) => setTimeout(res, 10));
    assert.equal(nearResolved, false, "near job is queued, not immediately assigned");

    const cancelSent = bgWorker.messages.some((m) => m.type === "decode_cancel");
    assert.equal(cancelSent, false, "no decode_cancel sent for near preemption attempt");

    await sched.shutdown();
  });
});
