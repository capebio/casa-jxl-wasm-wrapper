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
    }).then(() => { nearResolved = true; }).catch(() => {});

    await new Promise<void>((res) => setTimeout(res, 10));
    assert.equal(nearResolved, false, "near job is queued, not immediately assigned");

    const cancelSent = bgWorker.messages.some((m) => m.type === "decode_cancel");
    assert.equal(cancelSent, false, "no decode_cancel sent for near preemption attempt");

    await sched.shutdown();
  });

  it("S1 (P0) — Cancel while paused does not terminate active session on same worker", async () => {
    const workers: FakeWorker[] = [];
    const sched = new Scheduler({
      factory: fakeWorkerFactory(workers),
      maxWorkers: 1,
      idleTimeoutMs: 60_000,
    });

    // Start background session X
    const xPromise = sched.acquireSlot({
      sessionId: "X",
      priority: "background",
      startMsg: makeDecodeStart("X", "background"),
      sourceKey: null,
      signal: null,
    });
    await Promise.resolve();
    await xPromise;

    // Start visible session Y. This preempts X.
    let yResolved = false;
    const yPromise = sched.acquireSlot({
      sessionId: "Y",
      priority: "visible",
      startMsg: makeDecodeStart("Y", "visible"),
      sourceKey: null,
      signal: null,
    }).then((r) => { yResolved = true; return r; });

    await new Promise((r) => setTimeout(r, 10));
    // Emit decode_paused for X so preemption completes, binding Y to the worker
    workers[0]!.emit({ type: "decode_paused", sessionId: "X" } as any);
    await yPromise;
    assert.equal(yResolved, true, "Y is now active on the worker");

    // X is paused. Now cancel X.
    let xCancelled = false;
    sched.onMessage("X", (msg) => {
      if (msg.type === "decode_cancelled") xCancelled = true;
    });
    sched.cancelSession("X");
    assert.equal(xCancelled, true, "X received decode_cancelled locally");

    // Y is still active. Worker posts a message for Y. It should not be discarded.
    let yReceivedMsg = false;
    sched.onMessage("Y", (msg) => {
      if (msg.type === "decode_progress") yReceivedMsg = true;
    });
    workers[0]!.emit({ type: "decode_progress", sessionId: "Y", stage: "header" } as any);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(yReceivedMsg, true, "Y successfully received progress message");

    // Worker posts decode_cancelled for X (arriving late from real thread).
    // This should NOT tear down Y!
    workers[0]!.emit({ type: "decode_cancelled", sessionId: "X" } as any);
    await new Promise((r) => setTimeout(r, 10));

    // Assert Y is still alive and running (e.g. running metrics count is 1)
    assert.equal(sched.getMetrics().running, 1, "Y remains running");

    await sched.shutdown();
  });

  it("S2 (P0) — Pause ack matcher handles natural terminal during preemption select window", async () => {
    const workers: FakeWorker[] = [];
    const sched = new Scheduler({
      factory: fakeWorkerFactory(workers),
      maxWorkers: 1,
      idleTimeoutMs: 60_000,
    });

    // Start background session X
    const xPromise = sched.acquireSlot({
      sessionId: "X",
      priority: "background",
      startMsg: makeDecodeStart("X", "background"),
      sourceKey: null,
      signal: null,
    });
    await Promise.resolve();
    await xPromise;

    // Start visible session Y. This preempts X.
    const yPromise = sched.acquireSlot({
      sessionId: "Y",
      priority: "visible",
      startMsg: makeDecodeStart("Y", "visible"),
      sourceKey: null,
      signal: null,
    });

    await new Promise((r) => setTimeout(r, 10));

    // Emit decode_final (natural terminal) for X instead of decode_paused.
    workers[0]!.emit({ type: "decode_final", sessionId: "X" } as any);

    // The preemption ack matches the terminal message.
    await new Promise((r) => setTimeout(r, 10));
    await yPromise; // should resolve via the terminal acquisition fallback path without recycling or timing out.

    assert.equal(workers[0]!.terminated, false, "worker was not terminated/recycled");

    await sched.shutdown();
  });

  it("S3 (P0) — Encode-victim preemption successfully cancels and rebinds", async () => {
    const workers: FakeWorker[] = [];
    const sched = new Scheduler({
      factory: fakeWorkerFactory(workers),
      maxWorkers: 1,
      idleTimeoutMs: 60_000,
    });

    // Start background encode session
    const encodePromise = sched.acquireSlot({
      sessionId: "enc-1",
      priority: "background",
      startMsg: { type: "encode_start", sessionId: "enc-1", priority: "background" } as any,
      sourceKey: null,
      signal: null,
    });
    await Promise.resolve();
    await encodePromise;

    // Start visible decode session. This preempts the encode session (cancels it).
    const decodePromise = sched.acquireSlot({
      sessionId: "dec-1",
      priority: "visible",
      startMsg: makeDecodeStart("dec-1", "visible"),
      sourceKey: null,
      signal: null,
    });

    await new Promise((r) => setTimeout(r, 10));
    // Emit encode_cancelled from the worker.
    workers[0]!.emit({ type: "encode_cancelled", sessionId: "enc-1" } as any);

    await new Promise((r) => setTimeout(r, 10));
    const boundId = await decodePromise;
    assert.ok(boundId.workerId >= 0, "visible decode session acquired slot");

    await sched.shutdown();
  });

  it("S15 (P3) — maxParkedSessions bounds memory by evicting oldest parked", async () => {
    const workers: FakeWorker[] = [];
    const sched = new Scheduler({
      factory: fakeWorkerFactory(workers),
      maxWorkers: 2,
      maxParkedSessions: 1, // at most 1 parked session
      idleTimeoutMs: 60_000,
    });

    // Start two background sessions
    await sched.acquireSlot({
      sessionId: "bg-1",
      priority: "background",
      startMsg: makeDecodeStart("bg-1", "background"),
      sourceKey: null,
      signal: null,
    });
    await sched.acquireSlot({
      sessionId: "bg-2",
      priority: "background",
      startMsg: makeDecodeStart("bg-2", "background"),
      sourceKey: null,
      signal: null,
    });

    // Now preempt bg-1 with vis-1
    const vis1Promise = sched.acquireSlot({
      sessionId: "vis-1",
      priority: "visible",
      startMsg: makeDecodeStart("vis-1", "visible"),
      sourceKey: null,
      signal: null,
    });
    await new Promise((r) => setTimeout(r, 10));
    workers[0]!.emit({ type: "decode_paused", sessionId: "bg-1" } as any);
    await vis1Promise;

    // Now preempt bg-2 with vis-2
    let bg1Cancelled = false;
    sched.onMessage("bg-1", (msg) => {
      if (msg.type === "decode_cancelled") bg1Cancelled = true;
    });

    const vis2Promise = sched.acquireSlot({
      sessionId: "vis-2",
      priority: "visible",
      startMsg: makeDecodeStart("vis-2", "visible"),
      sourceKey: null,
      signal: null,
    });
    await new Promise((r) => setTimeout(r, 10));
    workers[1]!.emit({ type: "decode_paused", sessionId: "bg-2" } as any);
    await vis2Promise;

    await new Promise((r) => setTimeout(r, 10));

    // Oldest parked (bg-1) should have been cancelled to obey maxParkedSessions: 1
    assert.equal(bg1Cancelled, true, "oldest parked session bg-1 was evicted and cancelled");

    await sched.shutdown();
  });

  it("S14 (P3) — setPriority re-prioritizes queued/running sessions", async () => {
    const workers: FakeWorker[] = [];
    const sched = new Scheduler({
      factory: fakeWorkerFactory(workers),
      maxWorkers: 1,
      idleTimeoutMs: 60_000,
    });

    // Start visible session to consume the only worker slot
    await sched.acquireSlot({
      sessionId: "vis-active",
      priority: "visible",
      startMsg: makeDecodeStart("vis-active", "visible"),
      sourceKey: null,
      signal: null,
    });

    // Queue nr-1 (near) and bg-1 (background)
    const nrPromise = sched.acquireSlot({
      sessionId: "nr-1",
      priority: "near",
      startMsg: makeDecodeStart("nr-1", "near"),
      sourceKey: null,
      signal: null,
    });

    const bgPromise = sched.acquireSlot({
      sessionId: "bg-1",
      priority: "background",
      startMsg: makeDecodeStart("bg-1", "background"),
      sourceKey: null,
      signal: null,
    });

    // Wait for the async acquisition path to fail spawning and place them in the queue.
    await new Promise((r) => setTimeout(r, 20));

    // Demote nr-1 to background, promote bg-1 to visible
    sched.setPriority("nr-1", "background");
    sched.setPriority("bg-1", "visible");

    // Complete the active session to trigger drain. bg-1 (promoted to visible) should drain before nr-1 (demoted to background).
    workers[0]!.emit({ type: "decode_final", sessionId: "vis-active" } as any);

    let bg1Resolved = false;
    let nr1Resolved = false;
    bgPromise.then(() => { bg1Resolved = true; });
    nrPromise.then(() => { nr1Resolved = true; });

    await new Promise((r) => setTimeout(r, 20));

    assert.equal(bg1Resolved, true, "bg-1 (promoted to visible) was assigned a worker");
    assert.equal(nr1Resolved, false, "nr-1 (demoted to background) remains queued");

    await sched.shutdown();
  });
});
