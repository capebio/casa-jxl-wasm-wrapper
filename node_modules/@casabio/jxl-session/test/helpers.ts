// jxl-session/test/helpers.ts
// Test doubles for the session facade. A real Scheduler is driven by
// FakeWorkers, so these tests exercise the genuine jxl-session ↔ jxl-scheduler
// contract without needing a real codec.

import { Scheduler, type WorkerHandle } from "@casabio/jxl-scheduler";
import type { MainToWorkerMessage, WorkerToMainMessage } from "@casabio/jxl-core";

// A controllable fake worker. emit() simulates a worker→main message.
export class FakeWorker implements WorkerHandle {
  readonly messages: MainToWorkerMessage[] = [];
  private handlers: Array<(msg: WorkerToMainMessage) => void> = [];
  private _terminated = false;

  get terminated(): boolean {
    return this._terminated;
  }

  send(msg: MainToWorkerMessage, _transfer: ArrayBuffer[] = []): void {
    this.messages.push(msg);
  }

  onMessage(handler: (msg: WorkerToMainMessage) => void): void {
    this.handlers.push(handler);
  }

  emit(msg: WorkerToMainMessage): void {
    for (const h of this.handlers) h(msg);
  }

  async shutdown(_timeoutMs = 5000): Promise<void> {
    this._terminated = true;
  }
}

// Build a Scheduler backed by FakeWorkers; the returned store collects every
// worker the scheduler spawns so tests can drive them.
export function makeScheduler(maxWorkers = 2): { scheduler: Scheduler; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const scheduler = new Scheduler({
    factory: async () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    maxWorkers,
    // Short idle timeout so a leaked timer (e.g. from a failing test that
    // skips shutdown()) cannot hold the process open.
    idleTimeoutMs: 100,
  });
  return { scheduler, workers };
}

// Wait until the n-th worker exists AND has received its start message.
//
// The factory pushes a worker into `workers` synchronously, but the scheduler
// only wires its message handler and sends decode_start/encode_start later, in
// assignWorker() — a pending microtask. Returning on `workers.length` alone
// would hand back a worker whose handler is not yet wired (emit() would be
// lost) and whose `messages` is still empty. Every session sends exactly one
// start message on assignment, so `messages.length >= 1` is a reliable signal
// that assignWorker() has run.
export async function waitForWorker(workers: FakeWorker[], n = 1): Promise<FakeWorker> {
  for (let i = 0; i < 200; i++) {
    const w = workers[n - 1];
    if (w !== undefined && w.messages.length >= 1) return w;
    await new Promise<void>((r) => setTimeout(r, 2));
  }
  throw new Error(
    `waitForWorker: worker #${n} not ready after timeout (${workers.length} spawned)`,
  );
}

export function tick(ms = 5): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// Minimal ImageInfo fixture.
export function imageInfo(overrides: Partial<import("@casabio/jxl-core").ImageInfo> = {}): import("@casabio/jxl-core").ImageInfo {
  return {
    width: 64,
    height: 48,
    bitsPerSample: 8,
    hasAlpha: false,
    hasAnimation: false,
    jpegReconstructionAvailable: false,
    ...overrides,
  };
}
