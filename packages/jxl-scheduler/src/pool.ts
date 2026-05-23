// jxl-scheduler/src/pool.ts
// Worker pool: creation, idle reaping, recycling on poison.
// Spec: Section 12.1, 7.2.

import type { PoolWorker, WorkerHandle, WorkerFactory } from "./types.js";

let workerIdCounter = 0;

export class WorkerPool {
  private readonly factory: WorkerFactory;
  private readonly maxSize: number;
  private readonly idleTimeoutMs: number;
  private readonly workers: Map<number, PoolWorker> = new Map();
  private destroyed = false;

  constructor(opts: { factory: WorkerFactory; maxSize: number; idleTimeoutMs: number }) {
    this.factory = opts.factory;
    this.maxSize = opts.maxSize;
    this.idleTimeoutMs = opts.idleTimeoutMs;
  }

  get size(): number {
    return this.workers.size;
  }

  get idleWorkers(): PoolWorker[] {
    return [...this.workers.values()].filter(
      (w) => w.activeSessionId === null && !w.cancelling && !w.handle.terminated,
    );
  }

  get activeWorkers(): PoolWorker[] {
    return [...this.workers.values()].filter(
      (w) => w.activeSessionId !== null && !w.handle.terminated,
    );
  }

  // Acquire an idle worker, spawning one if the pool is not full.
  // Returns null if no worker is available and pool is at capacity.
  // The returned worker is immediately marked as reserved (activeSessionId = "__reserved__")
  // so a subsequent acquire() before bind() does not return the same worker.
  async acquire(): Promise<PoolWorker | null> {
    if (this.destroyed) return null;

    const idle = this.idleWorkers;
    if (idle.length > 0) {
      const worker = idle[0]!;
      this.clearIdleTimer(worker);
      worker.activeSessionId = "__reserved__";
      return worker;
    }

    if (this.workers.size < this.maxSize) {
      const w = await this.spawn();
      w.activeSessionId = "__reserved__";
      return w;
    }

    return null;
  }

  async spawn(): Promise<PoolWorker> {
    const id = ++workerIdCounter;
    const handle = await this.factory();

    const pw: PoolWorker = {
      id,
      handle,
      activeSessionId: null,
      cancelling: false,
      idleTimer: null,
    };

    handle.onMessage((msg) => {
      // If worker crashes (terminated), recycle.
      if (handle.terminated) {
        this.recycle(pw);
      }
    });

    this.workers.set(id, pw);
    return pw;
  }

  bind(worker: PoolWorker, sessionId: string): void {
    this.clearIdleTimer(worker);
    worker.activeSessionId = sessionId;
  }

  release(worker: PoolWorker): void {
    worker.activeSessionId = null;
    worker.cancelling = false;

    if (this.destroyed) {
      this.destroyWorker(worker);
      return;
    }

    // Start idle timer. Reap if not re-used within idleTimeoutMs.
    worker.idleTimer = setTimeout(() => {
      this.reap(worker);
    }, this.idleTimeoutMs);
  }

  // Destroy and remove a poisoned or crashed worker.
  recycle(worker: PoolWorker): void {
    this.clearIdleTimer(worker);
    this.workers.delete(worker.id);
    if (!worker.handle.terminated) {
      void worker.handle.shutdown(1000).catch(() => undefined);
    }
  }

  private reap(worker: PoolWorker): void {
    if (worker.activeSessionId !== null) return; // re-used before timer fired
    this.recycle(worker);
  }

  private clearIdleTimer(worker: PoolWorker): void {
    if (worker.idleTimer !== null) {
      clearTimeout(worker.idleTimer);
      worker.idleTimer = null;
    }
  }

  private destroyWorker(worker: PoolWorker): void {
    this.workers.delete(worker.id);
    void worker.handle.shutdown(1000).catch(() => undefined);
  }

  // Spawn workers eagerly so the first acquire() hits an idle worker rather than
  // paying the factory boot cost. Workers start their idle timers immediately and
  // are reaped normally if unused within idleTimeoutMs.
  prewarm(count: number): void {
    if (this.destroyed) return;
    const toSpawn = Math.min(count, this.maxSize - this.workers.size);
    for (let i = 0; i < toSpawn; i++) {
      void this.spawn().then((w) => {
        if (this.destroyed) {
          this.destroyWorker(w);
          return;
        }
        w.idleTimer = setTimeout(() => this.reap(w), this.idleTimeoutMs);
      }).catch(() => undefined);
    }
  }

  async shutdown(): Promise<void> {
    this.destroyed = true;
    const shutdowns = [...this.workers.values()].map((w) => {
      this.clearIdleTimer(w);
      return w.handle.shutdown(5000).catch(() => undefined);
    });
    await Promise.allSettled(shutdowns);
    this.workers.clear();
  }
}
