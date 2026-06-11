import type { PyramidLevel } from "./manifest.js";
import { longEdge } from "./decode-core.js";

interface CacheEntry {
  sorted: PyramidLevel[];
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
    entry = {
      sorted: [...levels].sort((a, b) => longEdge(a.w, a.h) - longEdge(b.w, b.h)),
    };
    cache.set(levels, entry);
  }

  if (entry.lastTarget === targetLongEdge && entry.lastLevel !== undefined) {
    return entry.lastLevel;
  }

  const sorted = entry.sorted;
  const maxLevel = sorted[sorted.length - 1]!;
  if (targetLongEdge > longEdge(maxLevel.w, maxLevel.h)) {
    const fallback = levels[levels.length - 1]!;
    entry.lastTarget = targetLongEdge;
    entry.lastLevel = fallback;
    return fallback;
  }

  let low = 0;
  let high = sorted.length - 1;
  let best = maxLevel;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const level = sorted[mid]!;
    if (longEdge(level.w, level.h) >= targetLongEdge) {
      best = level;
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
