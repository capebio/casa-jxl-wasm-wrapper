import type { ProgressiveManifest } from "./progressive-manifest.js";
import type { MetricName } from "./progressive-metrics.js";
export interface ManifestServiceDeps {
    /** Return the cached manifest for this sha+metric, or null on miss. */
    loadCached: (sha256: string, metric: MetricName) => Promise<ProgressiveManifest | null>;
    /** Persist a freshly built manifest (e.g. write <id>.<metric>.json or KV put). */
    saveCached: (sha256: string, metric: MetricName, manifest: ProgressiveManifest) => Promise<void>;
    /** Build the manifest for this sha+metric (real impl: profileJxlFile with the matching scorer). */
    build: (sha256: string, metric: MetricName) => Promise<ProgressiveManifest>;
}
export interface ManifestRequest {
    sha256: string;
    metric: MetricName;
}
/** Return the cached manifest for (sha256, metric); on miss build it once (deduping
 *  concurrent misses) and cache it. SSIM is normally pre-cached at ingest; Butteraugli
 *  builds lazily on first request. */
export declare function getOrBuildManifest(deps: ManifestServiceDeps, req: ManifestRequest): Promise<ProgressiveManifest>;
//# sourceMappingURL=progressive-service.d.ts.map