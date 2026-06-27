import type { ProgressiveManifest, TierName } from "./progressive-manifest.js";
import type { MetricName } from "./progressive-metrics.js";
export type TierPolicy = (userTier: string) => {
    metric: MetricName;
    maxTier: TierName;
};
export interface EdgeDeps {
    /** Load (or lazily build) the manifest for this sha+metric. Wrap getOrBuildManifest. */
    getManifest: (sha256: string, metric: MetricName) => Promise<ProgressiveManifest>;
    policy: TierPolicy;
}
export interface EdgeRequest {
    sha256: string;
    userTier: string;
    displayPx: number;
}
export interface EdgeResolution {
    metric: MetricName;
    tier: TierName;
    rangeEnd: number;
}
/** Authoritative server/edge decision. Display size is a client hint; metric + ceiling
 *  come from policy(userTier). Returns the inclusive Range end the edge fetches from origin. */
export declare function resolveTierRequest(deps: EdgeDeps, req: EdgeRequest): Promise<EdgeResolution>;
//# sourceMappingURL=progressive-edge.d.ts.map