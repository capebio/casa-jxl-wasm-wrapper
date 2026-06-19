// jxl-scheduler/test/scheduler.worker-crash.test.ts
// Tests for worker_error routing: crash mid-decode → session terminal + cleanup.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";
import { FakeWorker, fakeWorkerFactory, makeDecodeStart } from "./helpers.js";
import type { WorkerToMainMessage } from "@casabio/jxl-core/protocol";

describe("Scheduler worker crash routing", () => {
  it("worker_error with sessionId is routed to session handlers and treated as terminal", async () => {
    const workers: FakeWorker[] = [];
    const sched = new Scheduler({
      factory: fakeWorkerFactory(workers),
      maxWorkers: 1,
      idleTimeoutMs: 60_000,
    });

    const received: WorkerToMainMessage[] = [];
    sched.onMessage("s1", (msg) => received.push(msg));

    await sched.acquireSlot({
      sessionId: "s1",
      priority: "visible",
      startMsg: makeDecodeStart("s1"),
      sourceKey: null,
      signal: null,
    });

    const worker = workers[0]!;

    // Simulate a top-level worker crash mid-decode with a sessionId attributed.
    const crashMsg: WorkerToMainMessage = {
      type: "worker_error",
      code: "UnhandledError",
      message: "WASM heap overflow",
      sessionId: "s1",
    };
    worker.emit(crashMsg);

    // Give microtasks a tick to settle.
    await new Promise<void>((res) => setTimeout(res, 5));

    // The crash message must have been forwarded to the session's handler.
    const forwarded = received.find((m) => m.type === "worker_error");
    assert.ok(forwarded !== undefined, "worker_error forwarded to session handler");
    assert.equal((forwarded as { sessionId?: string }).sessionId, "s1",
      "sessionId preserved in forwarded crash message");

    // The session must be cleaned up: metrics confirm it is no longer running.
    const metrics = sched.getMetrics();
    assert.equal(metrics.running, 0, "session removed from running after crash");

    await sched.shutdown();
  });

  it("worker_error without sessionId is not routed to any session", async () => {
    const workers: FakeWorker[] = [];
    const sched = new Scheduler({
      factory: fakeWorkerFactory(workers),
      maxWorkers: 1,
      idleTimeoutMs: 60_000,
    });

    const received: WorkerToMainMessage[] = [];
    sched.onMessage("s1", (msg) => received.push(msg));

    await sched.acquireSlot({
      sessionId: "s1",
      priority: "visible",
      startMsg: makeDecodeStart("s1"),
      sourceKey: null,
      signal: null,
    });

    const worker = workers[0]!;

    // Emit a worker_error with NO sessionId (e.g. WASM load failure before any session).
    const lifecycleErr: WorkerToMainMessage = {
      type: "worker_error",
      code: "UnhandledError",
      message: "WASM module failed to initialise",
      // no sessionId
    };
    worker.emit(lifecycleErr);

    await new Promise<void>((res) => setTimeout(res, 5));

    // A sessionless crash must not be forwarded to session s1's handlers.
    const forwarded = received.find((m) => m.type === "worker_error");
    assert.equal(forwarded, undefined,
      "sessionless worker_error must not be dispatched to any session handler");

    // s1 is still running (the crash was not attributed to it).
    const metrics = sched.getMetrics();
    assert.equal(metrics.running, 1, "session s1 still running after unattributed crash");

    await sched.shutdown();
  });

  it("worker_error with sessionId carries the sessionId field in the crash message", async () => {
    const workers: FakeWorker[] = [];
    const sched = new Scheduler({
      factory: fakeWorkerFactory(workers),
      maxWorkers: 1,
      idleTimeoutMs: 60_000,
    });

    const received: WorkerToMainMessage[] = [];
    sched.onMessage("s2", (msg) => received.push(msg));

    await sched.acquireSlot({
      sessionId: "s2",
      priority: "visible",
      startMsg: makeDecodeStart("s2"),
      sourceKey: null,
      signal: null,
    });

    const worker = workers[0]!;
    worker.emit({
      type: "worker_error",
      code: "UnhandledRejection",
      message: "promise rejected in decode callback",
      sessionId: "s2",
    });

    await new Promise<void>((res) => setTimeout(res, 5));

    const crash = received.find((m) => m.type === "worker_error") as
      | (WorkerToMainMessage & { sessionId?: string })
      | undefined;
    assert.ok(crash !== undefined, "crash message received");
    assert.equal(crash.sessionId, "s2", "sessionId present in crash message delivered to handler");

    await sched.shutdown();
  });
});
