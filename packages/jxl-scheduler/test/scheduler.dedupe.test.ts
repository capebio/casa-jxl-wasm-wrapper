// jxl-scheduler/test/scheduler.dedupe.test.ts
// Tests for dedupe / fan-out and partial-cancel semantics.
// Spec: Section 12.4, 21.3.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";
import { FakeWorker, fakeWorkerFactory, makeDecodeStart } from "./helpers.js";

describe("Scheduler dedupe", () => {
  it("second request for same key fans out, not a new decode", async () => {
    const workers: FakeWorker[] = [];
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
    const workers: FakeWorker[] = [];
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

    await new Promise<void>((res) => setTimeout(res, 10));

    const cancelSent = workers.flatMap((w) => w.messages).some(
      (m) => m.type === "decode_cancel" && m.sessionId === "s1",
    );
    assert.equal(cancelSent, false, "primary s1 not cancelled when only subscriber s2 cancels");

    await sched.shutdown();
  });

  it("all cancel: both gone triggers primary cancel", async () => {
    const workers: FakeWorker[] = [];
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

    await new Promise<void>((res) => setTimeout(res, 10));

    const cancelSent = workers.flatMap((w) => w.messages).some(
      (m) => m.type === "decode_cancel" && m.sessionId === "s1",
    );
    assert.ok(cancelSent, "primary cancelled when all subscribers cancel");

    await sched.shutdown();
  });

  it("primary cancel with 2 surviving subscribers: subs complete without hanging", async () => {
    const workers: FakeWorker[] = [];
    const sched = new Scheduler({
      factory: fakeWorkerFactory(workers),
      maxWorkers: 2,
      idleTimeoutMs: 60_000,
    });

    await sched.acquireSlot({
      sessionId: "primary",
      priority: "visible",
      startMsg: makeDecodeStart("primary", "visible"),
      sourceKey: "key-orphan",
      signal: null,
    });

    await sched.acquireSlot({
      sessionId: "sub1",
      priority: "visible",
      startMsg: makeDecodeStart("sub1", "visible"),
      sourceKey: "key-orphan",
      signal: null,
    });

    await sched.acquireSlot({
      sessionId: "sub2",
      priority: "visible",
      startMsg: makeDecodeStart("sub2", "visible"),
      sourceKey: "key-orphan",
      signal: null,
    });

    const sub1Received: any[] = [];
    const sub2Received: any[] = [];
    sched.onMessage("sub1", (m) => sub1Received.push(m));
    sched.onMessage("sub2", (m) => sub2Received.push(m));

    sched.cancelSession("primary");

    const worker = workers[0];
    assert.ok(worker, "worker should be spawned");
    const sawPrimaryCancel = worker.messages.some(
      (m: any) => m.type === "decode_cancel" && m.sessionId === "primary",
    );
    assert.equal(sawPrimaryCancel, false, "no cancel sent to worker because subscriber was promoted");

    // Worker continues to finish, now effectively under sub1 or sub2's identity
    worker.emit({ type: "decode_cancelled", sessionId: "primary" }); // original worker might still send primary id

    await new Promise<void>((r) => setTimeout(r, 20));

    const sub1GotOwn = sub1Received.some(
      (m: any) => m.type === "decode_cancelled" && (m.sessionId === "sub1" || m.sessionId === "sub2"),
    );
    const sub2GotOwn = sub2Received.some(
      (m: any) => m.type === "decode_cancelled" && (m.sessionId === "sub1" || m.sessionId === "sub2"),
    );
    assert.ok(sub1GotOwn, "sub1 received terminal message");
    assert.ok(sub2GotOwn, "sub2 received terminal message");

    sched.completeSession("sub1");
    sched.completeSession("sub2");

    await sched.shutdown();
  });

  it("background primary + visible subscriber escalates primary; findBackgroundWorker excludes it", async () => {
    const workers: FakeWorker[] = [];
    const sched = new Scheduler({
      factory: fakeWorkerFactory(workers),
      maxWorkers: 1,
      idleTimeoutMs: 60_000,
    });

    // Primary background for a sourceKey.
    await sched.acquireSlot({
      sessionId: "bg-primary",
      priority: "background",
      startMsg: makeDecodeStart("bg-primary", "background"),
      sourceKey: "shared-key",
      signal: null,
    });

    // Visible subscriber dedupes onto it.
    await sched.acquireSlot({
      sessionId: "vis-sub",
      priority: "visible",
      startMsg: makeDecodeStart("vis-sub", "visible"),
      sourceKey: "shared-key",
      signal: null,
    });

    // The primary must no longer be selectable for preemption (invariant: visible lane wins).
    const bgWorker = (sched as any).findBackgroundWorker?.();
    assert.equal(bgWorker, null, "escalated primary not selectable by findBackgroundWorker");

    // A new distinct visible request cannot preempt the (now-visible) primary; it queues.
    let thirdAcquired = false;
    const thirdP = sched.acquireSlot({
      sessionId: "vis-3",
      priority: "visible",
      startMsg: makeDecodeStart("vis-3", "visible"),
      sourceKey: "other-key",
      signal: null,
    }).then(() => { thirdAcquired = true; }).catch(() => {});

    await new Promise<void>((r) => setTimeout(r, 10));
    assert.equal(thirdAcquired, false, "distinct visible queued (no preemption of escalated primary)");

    // No pause was sent to the primary's worker (would have happened if still background).
    const pauseSent = workers.some((w) =>
      w.messages.some((m: any) => m.type === "decode_pause" && m.sessionId === "bg-primary"),
    );
    assert.equal(pauseSent, false, "no preemption pause sent to escalated primary");

    // Cleanup.
    sched.cancelSession("vis-3");
    sched.cancelSession("vis-sub");
    sched.cancelSession("bg-primary");
    await sched.shutdown();
  });
});
