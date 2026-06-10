// jxl-scheduler/src/pool.ts
// Worker pool: creation, idle reaping, recycling on poison.
// Spec: Section 12.1, 7.2.
//
// WorkerPool owns only worker lifecycle hygiene:
// spawn, reserve, bind, release, recycle, reap, shutdown.
// Scheduling policy — priority, preemption, dedupe, fairness — belongs in Scheduler.

import type { PoolWorker, WorkerFactory, WorkerHandle } from "./types.js";
import { CoreBudget } from "./budget.js";

const DEV =
  typeof process !== "undefined" ? process.env["NODE_ENV"] !== "production" : false;

const DEFAULT_SPAWN_TIMEOUT_MS = 15_000;
const RECYCLE_SHUTDOWN_TIMEOUT_MS = 1_000;
const POOL_SHUTDOWN_TIMEOUT_MS = 5_000;

export const RESERVED_SESSION_ID = "__jxl_reserved__" as const;

export interface WorkerPoolMetrics {
  spawned: number;
  spawnFailed: number;
  acquiredIdle: number;
  acquiredSpawned: number;
  acquireMiss: number;
  released: number;
  recycled: number;
  reaped: number;
  maxObservedSize: number;
  maxObservedSpawning: number;
}

export class WorkerPool {
  private readonly factory: WorkerFactory;
  private readonly maxSize: number;
  private readonly idleTimeoutMs: number;
  private readonly spawnTimeoutMs: number;
  private readonly minIdle: number;

  private readonly workers = new Map<number, PoolWorker>();
  private readonly idle = new Set<PoolWorker>();
  private readonly active = new Set<PoolWorker>();
  private readonly parked = new Set<PoolWorker>(); // explicit parked for paused state (P2a/P2b)
  private readonly spawnPromises = new Set<Promise<PoolWorker>>();

  private destroyed = false;
  private spawning = 0;
  private generation = 0;
  private nextWorkerId = 0;
  private shutdownPromise: Promise<void> | null = null;

  private lastSpawnFailureMs = 0;
  private consecutiveSpawnFailures = 0;

  private readonly coreBudget: CoreBudget | null;
  private readonly workerCost: number;
  private static readonly PREWARM_STAGGER_MS = 16;
  private readonly budgetedCosts = new Map<number, number>();

  private readonly metrics: WorkerPoolMetrics = {
    spawned: 0,
    spawnFailed: 0,
    acquiredIdle: 0,
    acquiredSpawned: 0,
    acquireMiss: 0,
    released: 0,
    recycled: 0,
    reaped: 0,
    maxObservedSize: 0,
    maxObservedSpawning: 0,
  };

  constructor(opts: {
    factory: WorkerFactory;
    maxSize: number;
    idleTimeoutMs: number;
    spawnTimeoutMs?: number;
    minIdle?: number;
    coreBudget?: CoreBudget;
    workerCost?: number;
  }) {
    this.factory = opts.factory;
    this.maxSize = Math.max(0, opts.maxSize);
    this.idleTimeoutMs = Math.max(0, opts.idleTimeoutMs);
    this.spawnTimeoutMs = opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
    this.minIdle = Math.max(0, Math.min(opts.minIdle ?? 0, this.maxSize));
    this.coreBudget = opts.coreBudget ?? null;
    this.workerCost = Math.max(1, Math.floor(opts.workerCost ?? 1));
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

  get parkedCount(): number {
    return this.parked.size;
  }

  get spawningCount(): number {
    return this.spawning;
  }

  get hasCapacity(): boolean {
    return !this.destroyed && this.workers.size + this.spawning < this.maxSize;
  }

  get capacityRemaining(): number {
    return Math.max(0, this.maxSize - this.workers.size - this.spawning);
  }

  /** Returns a shallow copy for safe external iteration. */
  get idleWorkers(): readonly PoolWorker[] {
    return [...this.idle];
  }

  /** Returns a shallow copy for safe external iteration. */
  get activeWorkers(): readonly PoolWorker[] {
    return [...this.active];
  }

  /** Zero-allocation iterator for hot scheduler paths. */
  idleWorkerValues(): IterableIterator<PoolWorker> {
    return this.idle.values();
  }

  /** Zero-allocation iterator for hot scheduler paths. */
  activeWorkerValues(): IterableIterator<PoolWorker> {
    return this.active.values();
  }

  parkedWorkerValues(): IterableIterator<PoolWorker> {
    return this.parked.values();
  }

  private get totalAllocatedOrSpawning(): number {
    return this.workers.size + this.spawning;
  }

  /**
   * Returns a shallow-cloned, frozen snapshot of pool metrics.
   * Internal counters continue to be mutated in place for the active pool
   * (spawned, acquired*, released, etc.), but every caller receives an
   * independent frozen view captured at call time. Retained references do
   * not observe future mutations; external code cannot mutate the live
   * counters through the returned object. sched-4 Metric Object Copy Protection.
   */
  getMetrics(): WorkerPoolMetrics {
    const snapshot = { ...this.metrics };
    return Object.freeze(snapshot);
  }

  healthSnapshot() {
    return {
      destroyed: this.destroyed,
      maxSize: this.maxSize,
      size: this.workers.size,
      idle: this.idle.size,
      active: this.active.size,
      spawning: this.spawning,
      spawnPromises: this.spawnPromises.size,
      capacityRemaining: this.capacityRemaining,
      workers: Array.from(this.workers.values(), (w) => ({
        id: w.id,
        activeSessionId: w.activeSessionId,
        cancelling: w.cancelling,
        terminated: w.handle.terminated,
        hasIdleTimer: w.idleTimer !== null,
        indexedIdle: this.idle.has(w),
        indexedActive: this.active.has(w),
        indexedParked: this.parked.has(w),
      })),
    };
  }

  // Acquire an idle worker, spawning one if the pool is not full.
  // Returns null if no worker is available and pool is at capacity.
  // The returned worker is immediately reserved so a subsequent acquire()
  // before bind() does not return the same worker.
  async acquire(): Promise<PoolWorker | null> {
    if (this.destroyed) return null;

    const idleWorker = this.takeIdleWorker();
    if (idleWorker !== null) {
      if (this.reserve(idleWorker)) {
        this.metrics.acquiredIdle++;
        this.assertInvariants();
        return idleWorker;
      }
      // reserve() returned false — stale worker recycled, fall through to spawn
    }

    if (this.totalAllocatedOrSpawning >= this.maxSize) {
      this.metrics.acquireMiss++;
      return null;
    }

    if (!this.canAttemptSpawn()) {
      this.metrics.acquireMiss++;
      return null;
    }

    const worker = await this.spawnAndReserve();
    if (worker === null) {
      this.metrics.acquireMiss++;
    } else {
      this.metrics.acquiredSpawned++;
    }
    this.assertInvariants();
    return worker;
  }

  // Synchronous fast path: returns an idle worker immediately without any Promise
  // allocation. Returns null if no idle worker is available (caller must fall
  // back to the async acquire() path to spawn a new worker).
  tryAcquireIdle(): PoolWorker | null {
    if (this.destroyed) return null;
    const worker = this.takeIdleWorker();
    if (worker !== null && this.reserve(worker)) {
      this.metrics.acquiredIdle++;
      this.assertInvariants();
      return worker;
    }
    return null;
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
    this.assertInvariants();
  }

  release(worker: PoolWorker): void {
    if (!this.workers.has(worker.id)) return;
    this.transitionToIdle(worker);
    this.metrics.released++;
    this.assertInvariants();
  }

  park(worker: PoolWorker): void {
    if (!this.workers.has(worker.id)) return;
    this.clearIdleTimer(worker);
    this.active.delete(worker);
    this.idle.delete(worker);
    this.parked.add(worker);
    worker.activeSessionId = null;
    worker.cancelling = false;
    this.assertInvariants();
  }

  unpark(worker: PoolWorker): void {
    this.parked.delete(worker);
  }

  /** Destroy and remove a poisoned or crashed worker. */
  recycle(worker: PoolWorker): void {
    if (!this.workers.has(worker.id)) return;
    void this.cleanupAndRemove(worker);
    this.metrics.recycled++;
  }

  // Spawn workers eagerly so the first acquire() hits an idle worker rather than
  // paying the factory boot cost.
  // Staggered to avoid startup pthread pool spikes (sched-6).
  prewarm(count: number): void {
    if (this.destroyed || count <= 0) return;

    const toSpawn = Math.min(count, this.maxSize - this.totalAllocatedOrSpawning);
    if (toSpawn <= 0) return;
    void this.spawnStaggered(toSpawn);
    this.assertInvariants();
  }

  private async spawnStaggered(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      if (this.destroyed) break;
      try {
        const worker = await this.spawn();
        this.handlePrewarmSuccess(worker);
      } catch {
        // spawn already accounts failure; continue stagger
      }
      if (i < n - 1) {
        await new Promise((r) => setTimeout(r, WorkerPool.PREWARM_STAGGER_MS));
      }
    }
  }

  /** Manually evict idle workers, e.g. on memory pressure. Returns count reaped. */
  reapIdle({ preserveMinIdle = true } = {}): number {
    let count = 0;
    for (const worker of this.idle) {
      if (this.parked.has(worker)) {
        this.parked.delete(worker);
        continue;
      }
      if (preserveMinIdle && this.idle.size <= this.minIdle) break;
      this.recycle(worker);
      count++;
    }
    return count;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.shutdownPromise = this.shutdownInner();
    return this.shutdownPromise;
  }

  // ─────────────────────────────────────────────────────────────
  // Private Implementation
  // ─────────────────────────────────────────────────────────────

  private async shutdownInner(): Promise<void> {
    this.destroyed = true;
    this.generation++;

    // Wait for in-flight spawns so no worker escapes cleanup.
    await Promise.allSettled([...this.spawnPromises]);

    const shutdownPromises = Array.from(this.workers.values(), (worker) =>
      this.cleanupAndRemove(worker, true, POOL_SHUTDOWN_TIMEOUT_MS),
    );

    await Promise.allSettled(shutdownPromises);

    this.idle.clear();
    this.active.clear();
    this.parked.clear();
    this.workers.clear();
  }

  private allocateWorkerId(): number {
    return ++this.nextWorkerId;
  }

  private canAttemptSpawn(): boolean {
    if (this.consecutiveSpawnFailures === 0) return true;
    const backoffMs = Math.min(5_000, 100 * 2 ** Math.min(6, this.consecutiveSpawnFailures - 1));
    return performance.now() - this.lastSpawnFailureMs >= backoffMs;
  }

  private noteSpawnFailure(): void {
    this.consecutiveSpawnFailures++;
    this.lastSpawnFailureMs = performance.now();
    this.metrics.spawnFailed++;
  }

  private noteSpawnSuccess(): void {
    this.consecutiveSpawnFailures = 0;
    this.lastSpawnFailureMs = 0;
  }

  private noteSize(): void {
    this.metrics.maxObservedSize = Math.max(this.metrics.maxObservedSize, this.workers.size);
    this.metrics.maxObservedSpawning = Math.max(this.metrics.maxObservedSpawning, this.spawning);
  }

  private async spawnAndReserve(): Promise<PoolWorker | null> {
    let worker: PoolWorker;
    try {
      worker = await this.spawn();
      this.noteSpawnSuccess();
    } catch {
      this.noteSpawnFailure();
      return null;
    }

    if (this.destroyed || worker.handle.terminated || !this.workers.has(worker.id)) {
      this.destroyWorker(worker);
      return null;
    }

    if (!this.reserve(worker)) return null;
    return worker;
  }

  private async spawn(): Promise<PoolWorker> {
    let acquiredBudget = false;
    let actualCost = this.workerCost;
    if (this.coreBudget) {
      // For workerCost > 1 (MT pools) we acquire full declared cost (queues in FIFO if needed).
      // Dynamic fallback to ST (cost 1 + tier switch) is done by callers via budget.acquireWithFallback
      // before selecting worker script URL / factory variant.
      await this.coreBudget.acquire(this.workerCost);
      acquiredBudget = true;
      actualCost = this.workerCost;
    }

    this.spawning++;
    this.noteSize();

    const promise = this.spawnInner();
    this.spawnPromises.add(promise);

    try {
      const worker = await promise;
      if (acquiredBudget) {
        if (this.workers.has(worker.id)) {
          this.budgetedCosts.set(worker.id, actualCost);
        } else {
          this.coreBudget!.release(actualCost);
        }
      }
      return worker;
    } catch (err) {
      if (acquiredBudget) {
        this.coreBudget!.release(actualCost);
      }
      throw err;
    } finally {
      this.spawning--;
      this.spawnPromises.delete(promise);
    }
  }

  private async spawnInner(): Promise<PoolWorker> {
    const generation = this.generation;
    const id = this.allocateWorkerId();
    const handle = await this.createWorkerWithTimeout();

    const worker: PoolWorker = {
      id,
      handle,
      activeSessionId: null,
      cancelling: false,
      idleTimer: null,
    };

    if (this.destroyed || generation !== this.generation) {
      void handle.shutdown(RECYCLE_SHUTDOWN_TIMEOUT_MS).catch(() => undefined);
      return worker;
    }

    this.workers.set(id, worker);
    this.idle.add(worker);
    this.wireWorker(worker);
    this.metrics.spawned++;
    this.noteSize();

    return worker;
  }

  private async createWorkerWithTimeout(): Promise<WorkerHandle> {
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    try {
      return await Promise.race([
        this.factory(),
        new Promise<never>((_, reject) => {
          timeout = globalThis.setTimeout(
            () =>
              reject(
                new Error(
                  `[jxl-scheduler] Worker spawn timed out after ${this.spawnTimeoutMs}ms`,
                ),
              ),
            this.spawnTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
    }
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
      if (this.parked.has(worker)) {
        this.parked.delete(worker);
        continue;
      }
      if (
        this.workers.has(worker.id) &&
        worker.activeSessionId === null &&
        !worker.cancelling &&
        !worker.handle.terminated
      ) {
        // Remove before returning; reserve() will also call idle.delete
        // (no-op), but that is safe and cheaper than the previous pattern
        // of always deleting first then calling recycle/reserve.
        this.idle.delete(worker);
        return worker;
      }
      // Stale: recycle() → cleanupAndRemove() handles idle.delete.
      this.recycle(worker);
    }
    return null;
  }

  private reserve(worker: PoolWorker): boolean {
    if (
      this.destroyed ||
      !this.workers.has(worker.id) ||
      worker.handle.terminated ||
      worker.cancelling
    ) {
      this.recycle(worker);
      return false;
    }

    this.clearIdleTimer(worker);
    this.idle.delete(worker);
    this.active.add(worker);
    worker.activeSessionId = RESERVED_SESSION_ID;
    worker.cancelling = false;
    return true;
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
    void this.cleanupAndRemove(worker);
    this.metrics.reaped++;
  }

  private armIdleTimer(worker: PoolWorker): void {
    this.clearIdleTimer(worker);

    if (this.idleTimeoutMs <= 0) {
      if (this.idle.size > this.minIdle) this.reap(worker);
      return;
    }

    // Keep below minIdle floor warm indefinitely.
    if (this.idle.size <= this.minIdle) return;

    worker.idleTimer = globalThis.setTimeout(() => {
      if (this.idle.size > this.minIdle) this.reap(worker);
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(worker: PoolWorker): void {
    if (worker.idleTimer !== null) {
      globalThis.clearTimeout(worker.idleTimer);
      worker.idleTimer = null;
    }
  }

  /** Centralised cleanup path. Returns a promise so shutdown() can await all workers. */
  private cleanupAndRemove(
    worker: PoolWorker,
    shouldShutdown = true,
    shutdownTimeoutMs = RECYCLE_SHUTDOWN_TIMEOUT_MS,
  ): Promise<void> {
    this.clearIdleTimer(worker);
    this.idle.delete(worker);
    this.active.delete(worker);
    this.parked.delete(worker);
    this.workers.delete(worker.id);

    worker.activeSessionId = null;
    worker.cancelling = false;

    const cost = this.budgetedCosts.get(worker.id) ?? this.workerCost;
    if (this.budgetedCosts.delete(worker.id) && this.coreBudget) {
      this.coreBudget.release(cost);
    }

    if (shouldShutdown && !worker.handle.terminated) {
      return worker.handle.shutdown(shutdownTimeoutMs).catch(() => undefined);
    }
    return Promise.resolve();
  }

  private destroyWorker(worker: PoolWorker): void {
    void this.cleanupAndRemove(worker);
  }

  private assertInvariants(): void {
    if (!DEV) return;

    for (const worker of this.idle) {
      if (!this.workers.has(worker.id)) {
        throw new Error(`[jxl-scheduler] Idle worker ${worker.id} missing from workers map`);
      }
      if (this.active.has(worker)) {
        throw new Error(`[jxl-scheduler] Worker ${worker.id} is both idle and active`);
      }
      if (worker.activeSessionId !== null) {
        throw new Error(
          `[jxl-scheduler] Idle worker ${worker.id} has activeSessionId=${worker.activeSessionId}`,
        );
      }
      if (worker.handle.terminated) {
        throw new Error(`[jxl-scheduler] Idle worker ${worker.id} is terminated`);
      }
    }

    for (const worker of this.active) {
      if (!this.workers.has(worker.id)) {
        throw new Error(`[jxl-scheduler] Active worker ${worker.id} missing from workers map`);
      }
      if (worker.activeSessionId === null) {
        throw new Error(`[jxl-scheduler] Active worker ${worker.id} has no activeSessionId`);
      }
      if (worker.handle.terminated) {
        throw new Error(`[jxl-scheduler] Active worker ${worker.id} is terminated`);
      }
    }

    if (this.idle.size + this.active.size + this.parked.size > this.workers.size) {
      throw new Error("[jxl-scheduler] Worker index sizes exceed workers map size");
    }

    for (const worker of this.parked) {
      if (!this.workers.has(worker.id)) {
        throw new Error(`[jxl-scheduler] Parked worker ${worker.id} missing from workers map`);
      }
      if (this.idle.has(worker) || this.active.has(worker)) {
        throw new Error(`[jxl-scheduler] Worker ${worker.id} is parked and also in idle/active`);
      }
    }

    if (this.workers.size + this.spawning > this.maxSize) {
      throw new Error(
        `[jxl-scheduler] Pool exceeds maxSize: workers=${this.workers.size}, spawning=${this.spawning}, max=${this.maxSize}`,
      );
    }
  }
}
