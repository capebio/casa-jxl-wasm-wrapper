import type { PoolWorker, WorkerFactory } from "./types.js";
import { CoreBudget } from "./budget.js";
export declare const RESERVED_SESSION_ID: "__jxl_reserved__";
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
export declare class WorkerPool {
    private readonly factory;
    private readonly maxSize;
    private readonly idleTimeoutMs;
    private readonly spawnTimeoutMs;
    private readonly minIdle;
    private readonly workers;
    private readonly idle;
    private readonly active;
    private readonly parked;
    private readonly spawnPromises;
    private destroyed;
    private spawning;
    private generation;
    private nextWorkerId;
    private shutdownPromise;
    private lastSpawnFailureMs;
    private consecutiveSpawnFailures;
    private readonly coreBudget;
    private readonly workerCost;
    private static readonly PREWARM_STAGGER_MS;
    private readonly budgetedWorkerIds;
    private readonly metrics;
    constructor(opts: {
        factory: WorkerFactory;
        maxSize: number;
        idleTimeoutMs: number;
        spawnTimeoutMs?: number;
        minIdle?: number;
        coreBudget?: CoreBudget;
    });
    get size(): number;
    get idleCount(): number;
    get activeCount(): number;
    get parkedCount(): number;
    get spawningCount(): number;
    get hasCapacity(): boolean;
    get capacityRemaining(): number;
    /** Returns a shallow copy for safe external iteration. */
    get idleWorkers(): readonly PoolWorker[];
    /** Returns a shallow copy for safe external iteration. */
    get activeWorkers(): readonly PoolWorker[];
    /** Zero-allocation iterator for hot scheduler paths. */
    idleWorkerValues(): IterableIterator<PoolWorker>;
    /** Zero-allocation iterator for hot scheduler paths. */
    activeWorkerValues(): IterableIterator<PoolWorker>;
    parkedWorkerValues(): IterableIterator<PoolWorker>;
    private get totalAllocatedOrSpawning();
    /**
     * Returns a shallow-cloned, frozen snapshot of pool metrics.
     * Internal counters continue to be mutated in place for the active pool
     * (spawned, acquired*, released, etc.), but every caller receives an
     * independent frozen view captured at call time. Retained references do
     * not observe future mutations; external code cannot mutate the live
     * counters through the returned object. sched-4 Metric Object Copy Protection.
     */
    getMetrics(): WorkerPoolMetrics;
    healthSnapshot(): {
        destroyed: boolean;
        maxSize: number;
        size: number;
        idle: number;
        active: number;
        spawning: number;
        spawnPromises: number;
        capacityRemaining: number;
        workers: {
            id: number;
            activeSessionId: string | null;
            cancelling: boolean;
            terminated: boolean;
            hasIdleTimer: boolean;
            indexedIdle: boolean;
            indexedActive: boolean;
            indexedParked: boolean;
        }[];
    };
    acquire(): Promise<PoolWorker | null>;
    tryAcquireIdle(): PoolWorker | null;
    bind(worker: PoolWorker, sessionId: string): void;
    release(worker: PoolWorker): void;
    park(worker: PoolWorker): void;
    unpark(worker: PoolWorker): void;
    /** Destroy and remove a poisoned or crashed worker. */
    recycle(worker: PoolWorker): void;
    prewarm(count: number): void;
    private spawnStaggered;
    /** Manually evict idle workers, e.g. on memory pressure. Returns count reaped. */
    reapIdle({ preserveMinIdle }?: {
        preserveMinIdle?: boolean | undefined;
    }): number;
    shutdown(): Promise<void>;
    private shutdownInner;
    private allocateWorkerId;
    private canAttemptSpawn;
    private noteSpawnFailure;
    private noteSpawnSuccess;
    private noteSize;
    private spawnAndReserve;
    private spawn;
    private spawnInner;
    private createWorkerWithTimeout;
    private wireWorker;
    private takeIdleWorker;
    private reserve;
    private transitionToActive;
    private transitionToIdle;
    private handlePrewarmSuccess;
    private reap;
    private armIdleTimer;
    private clearIdleTimer;
    /** Centralised cleanup path. Returns a promise so shutdown() can await all workers. */
    private cleanupAndRemove;
    private destroyWorker;
    private assertInvariants;
}
//# sourceMappingURL=pool.d.ts.map