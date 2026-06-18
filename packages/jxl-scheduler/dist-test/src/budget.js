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
    _waitersHead = 0;
    // Cached once at construction — release() is a hot path (called on every worker
    // completion) and env-sniffing on every call adds measurable overhead at high
    // worker-turnover rates.
    _devMode;
    constructor(capacity) {
        this.capacity = capacity;
        if (!Number.isFinite(capacity) || capacity < 0) {
            throw new Error("[jxl-scheduler] CoreBudget capacity must be finite >= 0");
        }
        this.tokens = capacity;
        this._devMode = !CoreBudget._isProduction();
    }
    get available() {
        return this.tokens;
    }
    get pendingCount() {
        return this.waiters.length - this._waitersHead;
    }
    /** FIFO acquire. Blocks until cost tokens free. */
    async acquire(cost = 1) {
        if (cost <= 0)
            return;
        if (cost > this.capacity) {
            throw new Error(`[jxl-scheduler] CoreBudget: cost ${cost} exceeds capacity ${this.capacity}`);
        }
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
        const next = this.tokens + cost;
        if (next > this.capacity && this._devMode) {
            console.warn(`[jxl-scheduler] CoreBudget over-release: ${this.tokens}+${cost} > ${this.capacity}`);
        }
        this.tokens = Math.min(this.capacity, next);
        this.drainWaiters();
    }
    /**
     * Returns true when running in production mode. Checks both Node.js and
     * browser/bundler conventions so DEV-mode warnings fire in all environments.
     */
    static _isProduction() {
        // Node.js
        if (typeof process !== "undefined" && process.env["NODE_ENV"] === "production")
            return true;
        // Vite / webpack DefinePlugin / similar bundlers expose __DEV__
        if (typeof globalThis.__DEV__ === "boolean") {
            return !globalThis.__DEV__;
        }
        return false;
    }
    drainWaiters() {
        while (this._waitersHead < this.waiters.length) {
            const w = this.waiters[this._waitersHead];
            if (this.tokens >= w.needed) {
                this._waitersHead++;
                this.tokens -= w.needed;
                // Compact when fully consumed or head passes the halfway mark (mirrors queue.ts).
                if (this._waitersHead >= this.waiters.length) {
                    this.waiters.length = 0;
                    this._waitersHead = 0;
                }
                else if (this._waitersHead > 64 && this._waitersHead * 2 > this.waiters.length) {
                    this.waiters.copyWithin(0, this._waitersHead);
                    this.waiters.length -= this._waitersHead;
                    this._waitersHead = 0;
                }
                w.resolve();
            }
            else {
                break;
            }
        }
    }
    /**
     * Non-blocking: deduct cost if available, else return false. Never queues.
     * Unlike acquire(), cost > capacity returns false rather than throwing —
     * callers using this path should check capacity themselves if needed.
     */
    tryAcquire(cost = 1) {
        if (cost <= 0)
            return true;
        if (cost > this.capacity) {
            return false;
        }
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
        if (this.tokens >= mtCost && mtCost <= this.capacity) {
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