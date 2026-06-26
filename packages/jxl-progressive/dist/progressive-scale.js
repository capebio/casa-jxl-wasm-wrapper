/** Pick the frontier entry whose maxDisplayPx covers `displayPx` (longest edge).
 *  Returns undefined when the manifest has no frontier. */
export function selectFrontierTier(manifest, displayPx) {
    const fr = manifest.scaleFrontier;
    if (fr === undefined || fr.length === 0)
        return undefined;
    for (const e of fr)
        if (displayPx <= e.maxDisplayPx)
            return e;
    return fr[fr.length - 1];
}
/** Choose a tier for an on-screen element. Uses the scale frontier when present;
 *  otherwise a structural heuristic over tiers (longest-edge thresholds). */
export function selectTierForDisplay(manifest, elementWidth, elementHeight, dpr) {
    const longestEdge = Math.max(elementWidth, elementHeight) * (dpr > 0 ? dpr : 1);
    const frontier = selectFrontierTier(manifest, longestEdge);
    if (frontier !== undefined)
        return { tier: frontier.tier, byteEnd: frontier.byteEnd };
    // Fallback: no frontier → pick by longest-edge buckets against available tiers.
    const byName = (n) => manifest.tiers.find((t) => t.name === n);
    if (longestEdge <= 384 && byName("dc")) {
        const t = byName("dc");
        return { tier: "dc", byteEnd: t.byteEnd };
    }
    if (longestEdge <= 1280 && byName("preview")) {
        const t = byName("preview");
        return { tier: "preview", byteEnd: t.byteEnd };
    }
    const full = byName("full") ?? manifest.tiers[manifest.tiers.length - 1];
    return { tier: full.name, byteEnd: full.byteEnd };
}
//# sourceMappingURL=progressive-scale.js.map