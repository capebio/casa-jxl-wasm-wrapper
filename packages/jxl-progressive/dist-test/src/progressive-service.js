// In-flight de-dup so two concurrent premium requests build once.
const inflight = new Map();
/** Return the cached manifest for (sha256, metric); on miss build it once (deduping
 *  concurrent misses) and cache it. SSIM is normally pre-cached at ingest; Butteraugli
 *  builds lazily on first request. */
export async function getOrBuildManifest(deps, req) {
    const cached = await deps.loadCached(req.sha256, req.metric);
    if (cached !== null)
        return cached;
    const key = `${req.sha256}:${req.metric}`;
    const existing = inflight.get(key);
    if (existing !== undefined)
        return existing;
    const p = (async () => {
        const built = await deps.build(req.sha256, req.metric);
        await deps.saveCached(req.sha256, req.metric, built);
        return built;
    })();
    inflight.set(key, p);
    try {
        return await p;
    }
    finally {
        inflight.delete(key);
    }
}
//# sourceMappingURL=progressive-service.js.map