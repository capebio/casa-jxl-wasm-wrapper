export type RequestedWorkerTier = "auto" | "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar";
export interface PoolPressureMetrics {
  poolIdle: number;
  poolSize: number;
  poolSpawning: number;
}

const TIER_QUERY_KEY = "jxlWorkerTier";

export function parseRequestedWorkerTier(url?: string): RequestedWorkerTier {
  if (!url) return "auto";
  try {
    const parsed = new URL(url, "https://dummy.invalid");
    const tier = parsed.searchParams.get(TIER_QUERY_KEY);
    if (tier === "relaxed-simd-mt" || tier === "simd-mt" || tier === "simd" || tier === "scalar" || tier === "auto") {
      return tier;
    }
  } catch {
    // malformed -> conservative auto
  }
  return "auto";
}

export function appendWorkerTierQuery(url: string | undefined, tier: RequestedWorkerTier): string | undefined {
  if (url === undefined) return undefined;
  let parsed: URL;
  let hadOrigin: boolean;
  try {
    parsed = new URL(url);
    hadOrigin = true;
  } catch {
    parsed = new URL(url, "https://dummy.invalid");
    hadOrigin = false;
  }
  parsed.searchParams.set(TIER_QUERY_KEY, tier);
  return hadOrigin ? parsed.toString() : parsed.pathname + parsed.search + parsed.hash;
}

export function withWorkerTier(url: string | undefined, tier: RequestedWorkerTier): string | undefined {
  return appendWorkerTierQuery(url, tier);
}

export function isMtRequestedTier(tier: RequestedWorkerTier): boolean {
  return tier === "relaxed-simd-mt" || tier === "simd-mt";
}

export function shouldUseMtImmediately(
  metrics: PoolPressureMetrics,
  maxWorkers: number,
  budgetAvailable: number,
  mtCost: number,
): boolean {
  if (metrics.poolIdle > 0) return true;
  const hasSpawnCapacity = metrics.poolSize + metrics.poolSpawning < maxWorkers;
  return hasSpawnCapacity && budgetAvailable >= mtCost;
}
