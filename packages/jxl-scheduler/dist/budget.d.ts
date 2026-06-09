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
}
export declare function defaultCoreBudgetCapacity(): number;
//# sourceMappingURL=budget.d.ts.map