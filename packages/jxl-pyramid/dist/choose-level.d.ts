import type { PyramidLevel } from "./manifest.js";
/** Smallest pyramid level whose long edge is >= target; else the largest available. */
export declare function chooseLevelForTarget(levels: readonly PyramidLevel[], targetLongEdge: number): PyramidLevel;
/** Monotonic rank for upgrade policy (higher = more pixels). */
export declare function levelRank(level: PyramidLevel): number;
export declare function shouldUpgrade(current: PyramidLevel | null, candidate: PyramidLevel): boolean;
//# sourceMappingURL=choose-level.d.ts.map