// jxl-scheduler/src/pool.ts
// Worker pool: creation, idle reaping, recycling on poison.
// Spec: Section 12.1, 7.2.

import type { PoolWorker, WorkerFactory } from "./types.js";

let workerIdCounter = 0;

export const RESERVED_SESSION_ID = "__jxl_reserved__" as const;

export class WorkerPool {
  private readonly factory: WorkerFactory;
  private readonly maxSize: number;
  private readonly idleTimeoutMs: number;

  private readonly workers = new Map<number, PoolWorker>();
  private readonly idle = new Set<PoolWorker>();
  private readonly active = new Set<PoolWorker>();
  private readonly spawnPromises = new Set<Promise<PoolWorker>>();

  private destroyed = false;
  private spawning = 0;

  constructor(opts: { factory: WorkerFactory; maxSize: number; idleTimeoutMs: number }) {
    this.factory = opts.factory;
    this.maxSize = Math.max(0, opts.maxSize);
    this.idleTimeoutMs = Math.max(0, opts.idleTimeoutMs);
  }

  get size(): number {
    return this.workers.size;
  }

  get idleCount(): number {
    return this.idle.size;
  }

  get activeCount(): number {
    return this.active.size;
  }

  get spawningCount(): number {
    return this.spawning;
  }

  /** Returns a shallow copy for safe external iteration. */
  get idleWorkers(): readonly PoolWorker[] {
    return [...this.idle];
  }

  /** Returns a shallow copy for safe external iteration. */
  get activeWorkers(): readonly PoolWorker[] {
    return [...this.active];
  }

  private get totalAllocatedOrSpawning(): number {
    return this.workers.size + this.spawning;
  }

  // Acquire an idle worker, spawning one if the pool is not full.
  // Returns null if no worker is available and pool is at capacity.
  // The returned worker is immediately reserved so a subsequent acquire()
  // before bind() does not return the same worker.
  async acquire(): Promise<PoolWorker | null> {
    if (this.destroyed) return null;

    const idleWorker = this.takeIdleWorker();
    if (idleWorker) {
      this.reserve(idleWorker);
      return idleWorker;
    }

    if (this.totalAllocatedOrSpawning >= this.maxSize) {
      return null;
    }

    return this.spawnAndReserve();
  }

  bind(worker: PoolWorker, sessionId: string): void {
    if (this.destroyed) {
      this.destroyWorker(worker);
      return;
    }

    if (!this.workers.has(worker.id) || worker.handle.terminated) {
      throw new Error(`[jxl-scheduler] Cannot bind unavailable worker ${worker.id}`);
    }

    if (worker.activeSessionId !== RESERVED_SESSION_ID) {
      throw new Error(
        `[jxl-scheduler] Cannot bind worker ${worker.id}; expected reserved state, got ${worker.activeSessionId}`,
      );
    }

    this.transitionToActive(worker, sessionId);
  }

  release(worker: PoolWorker): void {
    if (!this.workers.has(worker.id)) return;
    this.transitionToIdle(worker);
  }

  /** Destroy and remove a poisoned or crashed worker. */
  recycle(worker: PoolWorker): void {
    if (!this.workers.has(worker.id)) return;
    void this.cleanupAndRemove(worker);
  }

  // Spawn workers eagerly so the first acquire() hits an idle worker rather than
  // paying the factory boot cost.
  prewarm(count: number): void {
    if (this.destroyed || count <= 0) return;

    const toSpawn = Math.min(count, this.maxSize - this.totalAllocatedOrSpawning);
    for (let i = 0; i < toSpawn; i++) {
      void this.spawn()
        .then((worker) => this.handlePrewarmSuccess(worker))
        .catch(() => undefined);
    }
  }

  async shutdown(): Promise<void> {
    this.destroyed = true;

    // Wait for in-flight spawns so no worker escapes cleanup.
    await Promise.allSettled([...this.spawnPromises]);

    const shutdownPromises = [...this.workers.values()].map((worker) =>
      this.cleanupAndRemove(worker, true, 5000),
    );

    await Promise.allSettled(shutdownPromises);

    this.idle.clear();
    this.active.clear();
    this.workers.clear();
  }

  // ─────────────────────────────────────────────────────────────
  // Private Implementation
  // ─────────────────────────────────────────────────────────────

  private async spawnAndReserve(): Promise<PoolWorker | null> {
    let worker: PoolWorker;
    try {
      worker = await this.spawn();
    } catch {
      return null;
    }

    if (this.destroyed || worker.handle.terminated || !this.workers.has(worker.id)) {
      this.destroyWorker(worker);
      return null;
    }

    this.reserve(worker);
    return worker;
  }

  private async spawn(): Promise<PoolWorker> {
    this.spawning++;

    const promise = this.spawnInner();
    this.spawnPromises.add(promise);

    try {
      return await promise;
    } finally {
      this.spawning--;
      this.spawnPromises.delete(promise);
    }
  }

  private async spawnInner(): Promise<PoolWorker> {
    const id = ++workerIdCounter;
    const handle = await this.factory();

    const worker: PoolWorker = {
      id,
      handle,
      activeSessionId: null,
      cancelling: false,
      idleTimer: null,
    };

    if (this.destroyed) {
      void handle.shutdown(1000).catch(() => undefined);
      return worker;
    }

    this.workers.set(id, worker);
    this.idle.add(worker);
    this.wireWorker(worker);

    return worker;
  }

  private wireWorker(worker: PoolWorker): void {
    // Forward-compatible: recycles worker on error/exit if the handle supports it.
    // WorkerHandle does not expose these today; optional chaining is a safe noop.
    const handle = worker.handle as typeof worker.handle & {
      onError?: (handler: (err: unknown) => void) => void;
      onExit?: (handler: () => void) => void;
    };

    handle.onError?.(() => this.recycle(worker));
    handle.onExit?.(() => this.recycle(worker));
  }

  private takeIdleWorker(): PoolWorker | null {
    for (const worker of this.idle) {
      this.idle.delete(worker);

      if (
        this.workers.has(worker.id) &&
        worker.activeSessionId === null &&
        !worker.cancelling &&
        !worker.handle.terminated
      ) {
        return worker;
      }

      this.recycle(worker);
    }
    return null;
  }

  private reserve(worker: PoolWorker): void {
    this.clearIdleTimer(worker);
    this.idle.delete(worker);
    this.active.add(worker);
    worker.activeSessionId = RESERVED_SESSION_ID;
    worker.cancelling = false;
  }

  private transitionToActive(worker: PoolWorker, sessionId: string): void {
    this.clearIdleTimer(worker);
    this.idle.delete(worker);
    this.active.add(worker);
    worker.activeSessionId = sessionId;
    worker.cancelling = false;
  }

  private transitionToIdle(worker: PoolWorker): void {
    this.clearIdleTimer(worker);
    this.active.delete(worker);
    worker.activeSessionId = null;
    worker.cancelling = false;

    if (this.destroyed || worker.handle.terminated) {
      this.destroyWorker(worker);
      return;
    }

    this.idle.add(worker);
    this.armIdleTimer(worker);
  }

  private handlePrewarmSuccess(worker: PoolWorker): void {
    if (this.destroyed) {
      this.destroyWorker(worker);
      return;
    }

    // Only arm timer if worker is still idle — acquire() may have taken it.
    if (
      this.workers.has(worker.id) &&
      worker.activeSessionId === null &&
      this.idle.has(worker) &&
      !worker.handle.terminated
    ) {
      this.armIdleTimer(worker);
    }
  }

  private reap(worker: PoolWorker): void {
    if (!this.workers.has(worker.id)) return;
    if (worker.activeSessionId !== null) return;
    this.recycle(worker);
  }

  private armIdleTimer(worker: PoolWorker): void {
    this.clearIdleTimer(worker);

    if (this.idleTimeoutMs <= 0) {
      this.reap(worker);
      return;
    }

    worker.idleTimer = setTimeout(() => this.reap(worker), this.idleTimeoutMs);
  }

  private clearIdleTimer(worker: PoolWorker): void {
    if (worker.idleTimer !== null) {
      clearTimeout(worker.idleTimer);
      worker.idleTimer = null;
    }
  }

  /** Centralised cleanup path. Returns a promise so shutdown() can await all workers. */
  private cleanupAndRemove(
    worker: PoolWorker,
    shouldShutdown = true,
    shutdownTimeoutMs = 1000,
  ): Promise<void> {
    this.clearIdleTimer(worker);
    this.idle.delete(worker);
    this.active.delete(worker);
    this.workers.delete(worker.id);

    worker.activeSessionId = null;
    worker.cancelling = false;

    if (shouldShutdown && !worker.handle.terminated) {
      return worker.handle.shutdown(shutdownTimeoutMs).catch(() => undefined);
    }
    return Promise.resolve();
  }

  private destroyWorker(worker: PoolWorker): void {
    void this.cleanupAndRemove(worker);
  }
}
