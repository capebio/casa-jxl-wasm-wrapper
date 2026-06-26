// packages/jxl-progressive/src/progressive-service.ts
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

export interface ManifestRequest { sha256: string; metric: MetricName; }

// In-flight de-dup so two concurrent premium requests build once.
const inflight = new Map<string, Promise<ProgressiveManifest>>();

/** Return the cached manifest for (sha256, metric); on miss build it once (deduping
 *  concurrent misses) and cache it. SSIM is normally pre-cached at ingest; Butteraugli
 *  builds lazily on first request. */
export async function getOrBuildManifest(deps: ManifestServiceDeps, req: ManifestRequest): Promise<ProgressiveManifest> {
  const cached = await deps.loadCached(req.sha256, req.metric);
  if (cached !== null) return cached;

  const key = `${req.sha256}:${req.metric}`;
  const existing = inflight.get(key);
  if (existing !== undefined) return existing;

  const p = (async () => {
    const built = await deps.build(req.sha256, req.metric);
    await deps.saveCached(req.sha256, req.metric, built);
    return built;
  })();
  inflight.set(key, p);
  try { return await p; }
  finally { inflight.delete(key); }
}
