export type RequestedWorkerTier = "auto" | "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar";
export interface PoolPressureMetrics {
    poolIdle: number;
    poolSize: number;
    poolSpawning: number;
}
export declare function parseRequestedWorkerTier(url?: string): RequestedWorkerTier;
export declare function appendWorkerTierQuery(url: string | undefined, tier: RequestedWorkerTier): string | undefined;
export declare function withWorkerTier(url: string | undefined, tier: RequestedWorkerTier): string | undefined;
export declare function isMtRequestedTier(tier: RequestedWorkerTier): boolean;
export declare function shouldUseMtImmediately(metrics: PoolPressureMetrics, maxWorkers: number, budgetAvailable: number, mtCost: number): boolean;
//# sourceMappingURL=tier-routing.d.ts.map