// packages/jxl-progressive/src/progressive-edge.ts
import type { ProgressiveManifest, TierName } from "./progressive-manifest.js";
import type { MetricName } from "./progressive-metrics.js";
import { selectFrontierTier } from "./progressive-scale.js";

const TIER_ORDER: Record<TierName, number> = { dc: 0, preview: 1, full: 2 };

export type TierPolicy = (userTier: string) => { metric: MetricName; maxTier: TierName };

export interface EdgeDeps {
  /** Load (or lazily build) the manifest for this sha+metric. Wrap getOrBuildManifest. */
  getManifest: (sha256: string, metric: MetricName) => Promise<ProgressiveManifest>;
  policy: TierPolicy;
}

export interface EdgeRequest { sha256: string; userTier: string; displayPx: number; }
export interface EdgeResolution { metric: MetricName; tier: TierName; rangeEnd: number; }

/** Authoritative server/edge decision. Display size is a client hint; metric + ceiling
 *  come from policy(userTier). Returns the inclusive Range end the edge fetches from origin. */
export async function resolveTierRequest(deps: EdgeDeps, req: EdgeRequest): Promise<EdgeResolution> {
  const { metric, maxTier } = deps.policy(req.userTier);
  const manifest = await deps.getManifest(req.sha256, metric);

  // Client's display need (hint), defaulting to full if no frontier.
  const wanted = selectFrontierTier(manifest, req.displayPx);
  const wantedTier: TierName = wanted?.tier ?? "full";

  // Clamp to the user's allowed ceiling.
  const effectiveTier: TierName = TIER_ORDER[wantedTier] <= TIER_ORDER[maxTier] ? wantedTier : maxTier;

  const tierEntry = manifest.tiers.find((t) => t.name === effectiveTier)
    ?? manifest.tiers[manifest.tiers.length - 1]!;
  return { metric, tier: effectiveTier, rangeEnd: tierEntry.byteEnd - 1 };
}
