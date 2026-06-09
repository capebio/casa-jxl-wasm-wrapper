// CoreBudget: centralized token semaphore bounding active WASM worker thread pools.
// sched-1 / sched-6.
// Each live worker holds 1 token for its lifetime (spawn until cleanup).
// MT vs ST cost distinction rejected per spec (would require cross-layer pthread control
// and startMsg changes; violates stateless worker + scope). Callers that need tighter
// heavy-worker caps create a small-capacity instance and share it across Schedulers.
// Default capacity = hardwareConcurrency gives cross-pool total-worker bound without
// regressing single-scheduler maxWorkers behavior.
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
}
export function defaultCoreBudgetCapacity() {
    const nav = globalThis.navigator;
    return Math.max(1, nav?.hardwareConcurrency ?? 4);
}
//# sourceMappingURL=budget.js.map