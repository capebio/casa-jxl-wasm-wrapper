import type { PoolWorker, WorkerFactory } from "./types.js";
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
    private readonly spawnPromises;
    private destroyed;
    private spawning;
    private generation;
    private nextWorkerId;
    private shutdownPromise;
    private lastSpawnFailureMs;
    private consecutiveSpawnFailures;
    private readonly metrics;
    constructor(opts: {
        factory: WorkerFactory;
        maxSize: number;
        idleTimeoutMs: number;
        spawnTimeoutMs?: number;
        minIdle?: number;
    });
    get size(): number;
    get idleCount(): number;
    get activeCount(): number;
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
    private get totalAllocatedOrSpawning();
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
        }[];
    };
    acquire(): Promise<PoolWorker | null>;
    tryAcquireIdle(): PoolWorker | null;
    bind(worker: PoolWorker, sessionId: string): void;
    release(worker: PoolWorker): void;
    /** Destroy and remove a poisoned or crashed worker. */
    recycle(worker: PoolWorker): void;
    prewarm(count: number): void;
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