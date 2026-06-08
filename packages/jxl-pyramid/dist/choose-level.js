export function longEdge(w, h) {
    return Math.max(w, h);
}
/** Smallest pyramid level whose long edge is >= target; else the largest available. */
export function chooseLevelForTarget(levels, targetLongEdge) {
    if (levels.length === 0)
        return null;
    const sorted = [...levels].sort((a, b) => a.w * a.h - b.w * b.h);
    const pick = sorted.find((l) => longEdge(l.w, l.h) >= targetLongEdge);
    return pick ?? sorted[sorted.length - 1] ?? null;
}
/** Monotonic rank for upgrade policy (higher = more pixels). */
export function levelRank(level) {
    return level.w * level.h;
}
export function shouldUpgrade(current, candidate) {
    if (current === null)
        return true;
    return levelRank(candidate) > levelRank(current);
}
//# sourceMappingURL=choose-level.js.map