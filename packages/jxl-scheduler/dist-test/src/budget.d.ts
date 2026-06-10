export declare class CoreBudget {
    readonly capacity: number;
    private tokens;
    private readonly waiters;
    constructor(capacity: number);
    get available(): number;
    /** FIFO acquire. Blocks until cost tokens free. */
    acquire(cost?: number): Promise<void>;
    release(cost?: number): void;
    private drainWaiters;
    /** Non-blocking: deduct cost if available, else false. Never queues. */
    tryAcquire(cost?: number): boolean;
    /**
     * Acquire preferring MT cost (N). If tokens < N right now, fall back to cost=1
     * (ST worker) and either take immediately or queue for 1 (FIFO). Never enqueues
     * a high-cost waiter that could starve 1-cost requests when partial tokens free.
     * Returns the granted cost (N or 1). For tier-choosing callers that can spawn
     * matching ST/MT worker script.
     */
    acquireWithFallback(mtCost: number): Promise<number>;
}
export declare function defaultCoreBudgetCapacity(): number;
/** Global CoreBudget sized to hardwareConcurrency. Shared across all schedulers/contexts for sched-1. */
export declare const globalCoreBudget: CoreBudget;
//# sourceMappingURL=budget.d.ts.map