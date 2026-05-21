// jxl-scheduler/src/pool.ts
// Worker pool: creation, idle reaping, recycling on poison.
// Spec: Section 12.1, 7.2.
let workerIdCounter = 0;
export class WorkerPool {
    factory;
    maxSize;
    idleTimeoutMs;
    workers = new Map();
    destroyed = false;
    constructor(opts) {
        this.factory = opts.factory;
        this.maxSize = opts.maxSize;
        this.idleTimeoutMs = opts.idleTimeoutMs;
    }
    get size() {
        return this.workers.size;
    }
    get idleWorkers() {
        return [...this.workers.values()].filter((w) => w.activeSessionId === null && !w.cancelling && !w.handle.terminated);
    }
    get activeWorkers() {
        return [...this.workers.values()].filter((w) => w.activeSessionId !== null && !w.handle.terminated);
    }
    // Acquire an idle worker, spawning one if the pool is not full.
    // Returns null if no worker is available and pool is at capacity.
    // The returned worker is immediately marked as reserved (activeSessionId = "__reserved__")
    // so a subsequent acquire() before bind() does not return the same worker.
    async acquire() {
        if (this.destroyed)
            return null;
        const idle = this.idleWorkers;
        if (idle.length > 0) {
            const worker = idle[0];
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
    async spawn() {
        const id = ++workerIdCounter;
        const handle = await this.factory();
        const pw = {
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
    bind(worker, sessionId) {
        this.clearIdleTimer(worker);
        worker.activeSessionId = sessionId;
    }
    release(worker) {
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
    recycle(worker) {
        this.clearIdleTimer(worker);
        this.workers.delete(worker.id);
        if (!worker.handle.terminated) {
            void worker.handle.shutdown(1000).catch(() => undefined);
        }
    }
    reap(worker) {
        if (worker.activeSessionId !== null)
            return; // re-used before timer fired
        this.recycle(worker);
    }
    clearIdleTimer(worker) {
        if (worker.idleTimer !== null) {
            clearTimeout(worker.idleTimer);
            worker.idleTimer = null;
        }
    }
    destroyWorker(worker) {
        this.workers.delete(worker.id);
        void worker.handle.shutdown(1000).catch(() => undefined);
    }
    async shutdown() {
        this.destroyed = true;
        const shutdowns = [...this.workers.values()].map((w) => {
            this.clearIdleTimer(w);
            return w.handle.shutdown(5000).catch(() => undefined);
        });
        await Promise.allSettled(shutdowns);
        this.workers.clear();
    }
}
//# sourceMappingURL=pool.js.map