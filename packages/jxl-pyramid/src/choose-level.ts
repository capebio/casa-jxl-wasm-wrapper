import type { PyramidLevel } from "./manifest.js";
import { longEdge } from "./decode-core.js";

/** Smallest pyramid level whose long edge is >= target; else the largest available. */
export function chooseLevelForTarget(
  levels: readonly PyramidLevel[],
  targetLongEdge: number,
): PyramidLevel {
  if (!Number.isFinite(targetLongEdge) || targetLongEdge <= 0) {
    throw new RangeError("targetLongEdge must be positive finite");
  }
  if (levels.length === 0) throw new RangeError("chooseLevelForTarget requires non-empty levels");
  // Preferred per Grok 1: drop sort entirely; manifest is ingest-sorted (area order from pyramid-ingest).
  // Selection by longEdge find still works for the common increasing-longEdge case; mixed-aspect property test will police.
  return levels.find((l) => longEdge(l.w, l.h) >= targetLongEdge) ?? levels[levels.length - 1]!;
}

/** Monotonic rank for upgrade policy (higher = more pixels). */
export function levelRank(level: PyramidLevel): number {
  return level.w * level.h;
}

export function shouldUpgrade(current: PyramidLevel | null, candidate: PyramidLevel): boolean {
  if (current === null) return true;
  return levelRank(candidate) > levelRank(current);
}
