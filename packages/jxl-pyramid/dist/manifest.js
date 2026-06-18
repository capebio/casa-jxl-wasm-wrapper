// manifest.ts
// Interfaces for the Pyramid Gallery manifest and index schemas (M0-M7).
// Conforms strictly to the 2026-06-07-pyramid-gallery-design.md specification.
/**
 * Pick a download cutoff (bytes) for a level from its encode-time quality curve.
 * Feed the result to the stream layer's maxBytes (same mechanism as convergedByteEnd).
 *
 * - With thresholds: returns the first curve point meeting EVERY provided threshold
 *   (points missing a thresholded metric do not qualify), or undefined if none does
 *   (caller downloads the full level).
 * - With an empty target ({}): falls back to the level's convergedByteEnd.
 * - No curve and no convergedByteEnd: undefined.
 */
export function pickByteEndForQuality(level, target = {}) {
    const { maxButteraugli, minSsim } = target;
    const hasThreshold = maxButteraugli !== undefined || minSsim !== undefined;
    const curve = level.qualityCurve;
    if (hasThreshold && curve && curve.length > 0) {
        for (const pt of curve) {
            if (maxButteraugli !== undefined && !(pt.butteraugli !== undefined && pt.butteraugli <= maxButteraugli))
                continue;
            if (minSsim !== undefined && !(pt.ssim !== undefined && pt.ssim >= minSsim))
                continue;
            if (pt.bytes > 0 && pt.bytes < level.bytes)
                return pt.bytes;
            return undefined;
        }
        return undefined;
    }
    if (!hasThreshold && level.convergedByteEnd != null && level.convergedByteEnd > 0 && level.convergedByteEnd < level.bytes) {
        return level.convergedByteEnd;
    }
    return undefined;
}
//# sourceMappingURL=manifest.js.map