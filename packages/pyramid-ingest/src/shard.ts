/** Round-robin partition: shard `i` of `n` takes files at indices where idx % n === i. */
export function planShard<T>(files: readonly T[], i: number, n: number): T[] {
  if (!Number.isInteger(n) || n < 1) throw new Error(`shard count must be >= 1, got ${n}`);
  if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error(`shard index ${i} out of range for n=${n}`);
  return files.filter((_, idx) => idx % n === i);
}

/**
 * Pick a worker count: the tightest of available cores, an optional explicit request,
 * and how many per-image RGBA buffers fit in the memory budget. Always >= 1.
 */
export function boundedConcurrency(
  cores: number,
  requested: number | undefined,
  memBudgetBytes: number,
  perImageBytes: number,
): number {
  const byMem = Math.max(1, Math.floor(memBudgetBytes / Math.max(1, perImageBytes)));
  const byCores = Math.max(1, Math.floor(cores) || 1);
  const ceiling = requested && requested > 0 ? Math.floor(requested) : byCores;
  return Math.max(1, Math.min(byCores, ceiling, byMem));
}
