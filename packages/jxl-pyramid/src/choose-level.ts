import type { PyramidLevel } from "./manifest.js";

export function longEdge(w: number, h: number): number {
  return Math.max(w, h);
}

/** Smallest pyramid level whose long edge is >= target; else the largest available. */
export function chooseLevelForTarget(
  levels: readonly PyramidLevel[],
  targetLongEdge: number,
): PyramidLevel | null {
  if (levels.length === 0) return null;

  // Simple target memo fast-path (G3-E): bypass on repeated identical targets across ticks.
  if (targetLongEdge === lastTarget) return lastLevel;

  // Precompute/cache sorted view by longEdge (instead of area sort + re-sort every call).
  if (levels !== cachedLevels) {
    cachedLevels = levels;
    cachedSorted = [...levels].sort((a, b) => longEdge(a.w, a.h) - longEdge(b.w, b.h));
    cachedLongs = cachedSorted.map((l) => longEdge(l.w, l.h));
  }

  // Binary search (lower bound) for smallest level with longEdge >= target. O(log N)
  let lo = 0;
  let hi = cachedLongs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cachedLongs[mid] >= targetLongEdge) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  const pick = (lo < cachedSorted.length ? cachedSorted[lo] : cachedSorted[cachedSorted.length - 1]) ?? null;

  lastTarget = targetLongEdge;
  lastLevel = pick;
  return pick;
}

// Cache for sorted view (stable levels array ref from callers).
let cachedLevels: readonly PyramidLevel[] | null = null;
let cachedSorted: PyramidLevel[] = [];
let cachedLongs: number[] = [];

// Simple last target/level memo (bypass search on same target).
let lastTarget: number | undefined;
let lastLevel: PyramidLevel | null = null;

/** Monotonic rank for upgrade policy (higher = more pixels). */
export function levelRank(level: PyramidLevel): number {
  return level.w * level.h;
}

export function shouldUpgrade(current: PyramidLevel | null, candidate: PyramidLevel): boolean {
  if (current === null) return true;
  return levelRank(candidate) > levelRank(current);
}