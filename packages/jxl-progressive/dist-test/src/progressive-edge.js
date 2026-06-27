import { selectFrontierTier } from "./progressive-scale.js";
const TIER_ORDER = { dc: 0, preview: 1, full: 2 };
/** Authoritative server/edge decision. Display size is a client hint; metric + ceiling
 *  come from policy(userTier). Returns the inclusive Range end the edge fetches from origin. */
export async function resolveTierRequest(deps, req) {
    const { metric, maxTier } = deps.policy(req.userTier);
    const manifest = await deps.getManifest(req.sha256, metric);
    // Client's display need (hint), defaulting to full if no frontier.
    const wanted = selectFrontierTier(manifest, req.displayPx);
    const wantedTier = wanted?.tier ?? "full";
    // Clamp to the user's allowed ceiling.
    const effectiveTier = TIER_ORDER[wantedTier] <= TIER_ORDER[maxTier] ? wantedTier : maxTier;
    const tierEntry = manifest.tiers.find((t) => t.name === effectiveTier)
        ?? manifest.tiers[manifest.tiers.length - 1];
    return { metric, tier: effectiveTier, rangeEnd: tierEntry.byteEnd - 1 };
}
//# sourceMappingURL=progressive-edge.js.map