import type { PyramidLevel } from "./manifest.js";
import { longEdge } from "./decode-core.js";

interface CacheEntry {
  sorted: Array<{ level: PyramidLevel; long: number }>;
  lastTarget?: number;
  lastLevel?: PyramidLevel;
}

const cache = new WeakMap<readonly PyramidLevel[], CacheEntry>();

/** Smallest pyramid level whose long edge is >= target; else the largest available. */
export function chooseLevelForTarget(
  levels: readonly PyramidLevel[],
  targetLongEdge: number,
): PyramidLevel {
  if (!Number.isFinite(targetLongEdge) || targetLongEdge <= 0) {
    throw new RangeError("targetLongEdge must be positive finite");
  }
  if (levels.length === 0) throw new RangeError("chooseLevelForTarget requires non-empty levels");

  let entry = cache.get(levels);
  if (!entry) {
    const withLong = levels.map((level) => ({ level, long: longEdge(level.w, level.h) }));
    const sorted = withLong.sort((a, b) => a.long - b.long);
    entry = { sorted };
    cache.set(levels, entry);
  }

  if (entry.lastTarget === targetLongEdge && entry.lastLevel !== undefined) {
    return entry.lastLevel;
  }

  const sorted = entry.sorted;
  const maxInfo = sorted[sorted.length - 1]!;
  if (targetLongEdge > maxInfo.long) {
    const fallback = maxInfo.level;
    entry.lastTarget = targetLongEdge;
    entry.lastLevel = fallback;
    return fallback;
  }

  let low = 0;
  let high = sorted.length - 1;
  let best = maxInfo.level;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const info = sorted[mid]!;
    if (info.long >= targetLongEdge) {
      best = info.level;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  entry.lastTarget = targetLongEdge;
  entry.lastLevel = best;

  return best;
}

/** Monotonic rank for upgrade policy (higher = more pixels). */
export function levelRank(level: PyramidLevel): number {
  return level.w * level.h;
}

export function shouldUpgrade(current: PyramidLevel | null, candidate: PyramidLevel): boolean {
  if (current === null) return true;
  return levelRank(candidate) > levelRank(current);
}
