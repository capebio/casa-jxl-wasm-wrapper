// CoreBudget: centralized token semaphore bounding active WASM worker thread pools.
// sched-1 / sched-6.
// ST workers (simd/scalar) cost 1 token. MT workers (relaxed-simd-mt/simd-mt) cost N=hardwareConcurrency.
// Pools declare their workerCost at construction. acquire(N) queues FIFO for MT; callers may use
// acquireWithFallback for dynamic ST fallback instead of queuing high cost. Global instance shared
// by JxlContext schedulers for cross-pool bound. Default cap = hardwareConcurrency.
export class CoreBudget {
    capacity;
    tokens;
    waiters = [];
    constructor(capacity) {
        this.capacity = capacity;
        if (!Number.isFinite(capacity) || capacity < 0) {
            throw new Error("[jxl-scheduler] CoreBudget capacity must be finite >= 0");
        }
        this.tokens = capacity;
    }
    get available() {
        return this.tokens;
    }
    /** FIFO acquire. Blocks until cost tokens free. */
    async acquire(cost = 1) {
        if (cost <= 0)
            return;
        if (this.tokens >= cost) {
            this.tokens -= cost;
            return;
        }
        return new Promise((resolve) => {
            this.waiters.push({ needed: cost, resolve });
        });
    }
    release(cost = 1) {
        if (cost <= 0)
            return;
        this.tokens = Math.min(this.capacity, this.tokens + cost);
        this.drainWaiters();
    }
    drainWaiters() {
        while (this.waiters.length > 0) {
            const w = this.waiters[0];
            if (this.tokens >= w.needed) {
                this.waiters.shift();
                this.tokens -= w.needed;
                w.resolve();
            }
            else {
                break;
            }
        }
    }
    /** Non-blocking: deduct cost if available, else false. Never queues. */
    tryAcquire(cost = 1) {
        if (cost <= 0)
            return true;
        if (this.tokens >= cost) {
            this.tokens -= cost;
            return true;
        }
        return false;
    }
    /**
     * Acquire preferring MT cost (N). If tokens < N right now, fall back to cost=1
     * (ST worker) and either take immediately or queue for 1 (FIFO). Never enqueues
     * a high-cost waiter that could starve 1-cost requests when partial tokens free.
     * Returns the granted cost (N or 1). For tier-choosing callers that can spawn
     * matching ST/MT worker script.
     */
    async acquireWithFallback(mtCost) {
        if (mtCost <= 1) {
            await this.acquire(1);
            return 1;
        }
        if (this.tokens >= mtCost) {
            this.tokens -= mtCost;
            return mtCost;
        }
        // Fallback to ST cost=1 (may queue if 0 available). Reuses core acquire+drain for determinism.
        await this.acquire(1);
        return 1;
    }
}
export function defaultCoreBudgetCapacity() {
    const nav = globalThis.navigator;
    return Math.max(1, nav?.hardwareConcurrency ?? 4);
}
/** Global CoreBudget sized to hardwareConcurrency. Shared across all schedulers/contexts for sched-1. */
export const globalCoreBudget = new CoreBudget(defaultCoreBudgetCapacity());
//# sourceMappingURL=budget.js.map