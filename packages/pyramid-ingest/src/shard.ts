import { availableParallelism } from "node:os";

/**
 * Compute safe concurrency bounded by cores, explicit request, and mem budget.
 * PER_IMAGE_BYTES guard prevents OOM on high-MP masters.
 */
export function boundedConcurrency(
  avail: number,
  requested: number | undefined,
  memBudgetBytes: number,
  perImageBytes: number,
): number {
  let c = requested != null ? requested : avail;
  c = Math.max(1, Math.min(c, avail || 1));
  if (memBudgetBytes > 0 && perImageBytes > 0) {
    const memBound = Math.max(1, Math.floor(memBudgetBytes / perImageBytes));
    c = Math.min(c, memBound);
  }
  return c;
}

/**
 * 0-based shard split for --shard i/N deterministic partition.
 * Used for fan-out across machines / processes without overlap.
 */
export function planShard<T>(items: readonly T[], i: number, n: number): T[] {
  if (n <= 0) return items.slice();
  return items.filter((_, k) => (k % n) === i);
}
