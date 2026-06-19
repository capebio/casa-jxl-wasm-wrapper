// packages/jxl-progressive/src/progressive-scheduler.ts
import { validateManifest, lookupTier, checkHash, } from "./progressive-manifest.js";
import { fetchTier, fetchFull, streamTierFrames, fetchTierWithPrefix, RangeNotSupportedError, HttpError, } from "./progressive-stream.js";
/** Lower priority number = more important. Maps to a score where higher = better. */
export function tierRank(tier) {
    const ranks = { none: 0, dc: 1, preview: 2, full: 3 };
    return ranks[tier];
}
/** Higher score = schedule this job sooner. */
export function fairnessScore(job, now) {
    // (8 - priority): priority 1 → 7, priority 7 → 1
    const importanceScore = 8 - job.priority;
    const starvationBonus = Math.min((now - job.lastServedAt) / 1000, 5);
    const underRefinedBonus = 3 - tierRank(job.currentTier);
    return importanceScore + starvationBonus + underRefinedBonus;
}
function concatUint8Arrays(chunks) {
    const valid = chunks.filter((c) => c.byteLength > 0);
    if (valid.length === 0)
        return new Uint8Array(0);
    if (valid.length === 1)
        return valid[0];
    const total = valid.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of valid) {
        out.set(c, off);
        off += c.byteLength;
    }
    return out;
}
function nextTier(current) {
    const map = { none: "dc", dc: "preview", preview: "full" };
    return map[current] ?? null;
}
/**
 * Gallery-level progressive scheduler.
 *
 * Manages IntersectionObserver, a weighted round-robin job queue,
 * and DecodeSession lifecycle. Does NOT touch jxl-scheduler (worker pool).
 */
export class ProgressiveGallery {
    jobs = new Map();
    byElement = new Map();
    cache;
    sessionFactory;
    observer;
    raf;
    caf;
    setTimeoutFn;
    clearTimeoutFn;
    opts;
    activeDecoders = 0;
    rafHandle = null;
    destroyed = false;
    tickPending = false;
    retryTimerId = null;
    armedRetryAt = null;
    inFlightManifestFetches = 0;
    testFetchTier;
    testFetchFull;
    testStreamTierFrames;
    testFetchTierWithPrefix;
    constructor(cache, sessionFactory, opts = {}) {
        this.cache = cache;
        this.sessionFactory = sessionFactory;
        this.raf =
            opts.rafScheduler ??
                ((fn) => globalThis.requestAnimationFrame(fn));
        this.caf =
            opts.rafCanceller ??
                ((id) => globalThis.cancelAnimationFrame(id));
        this.setTimeoutFn =
            opts.timeoutScheduler ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
        this.clearTimeoutFn =
            opts.timeoutCanceller ?? ((id) => globalThis.clearTimeout(id));
        this.testFetchTier = opts.testFetchTier;
        this.testFetchFull = opts.testFetchFull;
        this.testStreamTierFrames = opts.testStreamTierFrames;
        this.testFetchTierWithPrefix = opts.testFetchTierWithPrefix;
        const autoProfile = (opts.autoProfile ?? true) !== false;
        let maxActiveDecoders = opts.maxActiveDecoders;
        if (maxActiveDecoders === undefined && autoProfile) {
            if (typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number") {
                const hw = navigator.hardwareConcurrency | 0;
                maxActiveDecoders = Math.min(4, Math.max(2, Math.floor(hw / 2)));
            }
        }
        maxActiveDecoders = maxActiveDecoders ?? 4;
        this.opts = {
            maxActiveDecoders,
            maxConcurrentFetches: opts.maxConcurrentFetches ?? 3,
            maxQueuedJobs: opts.maxQueuedJobs ?? 50,
            rootMargin: opts.rootMargin ?? "200px",
            onFrame: opts.onFrame ?? (() => { }),
            onTier: opts.onTier ?? (() => { }),
            onError: opts.onError ?? (() => { }),
            onProgress: opts.onProgress ?? (() => { }),
            onManifest: opts.onManifest ?? (() => { }),
            verifyHash: opts.verifyHash ?? false,
            manifestSuffix: opts.manifestSuffix ?? ".json",
            autoProfile: opts.autoProfile ?? true,
        };
        const ioFactory = opts.intersectionObserverFactory ??
            ((cb, ioOpts) => new IntersectionObserver(cb, ioOpts));
        this.observer = ioFactory(this.handleIntersection, {
            rootMargin: this.opts.rootMargin,
            threshold: [0, 0.5, 1.0],
        });
        this.requestTick();
    }
    /** Register an image. `jxlUrl` is the .jxl resource URL. */
    observe(element, id, jxlUrl) {
        if (this.destroyed)
            return;
        if (this.jobs.size >= this.opts.maxQueuedJobs) {
            this.opts.onError(id, new Error(`Gallery at capacity (maxQueuedJobs=${this.opts.maxQueuedJobs}); image will not be displayed`));
            return;
        }
        if (this.jobs.has(id))
            this.unobserve(id);
        const job = {
            id,
            element,
            jxlUrl,
            manifestUrl: jxlUrl + this.opts.manifestSuffix,
            fullyVisible: false,
            visible: false,
            nearViewport: false,
            selected: false,
            currentTier: "none",
            targetTier: "preview",
            priority: 5,
            lastServedAt: 0,
            bytesLoaded: 0,
            prefixAccum: null,
            prefixBytes: 0,
            manifest: null,
            manifestDispatched: false,
            decoderAbort: null,
            cleanupTimer: null,
            errorCount: 0,
            nextRetryAt: 0,
            manifestChecked: false,
        };
        this.jobs.set(id, job);
        this.byElement.set(element, job);
        this.observer.observe(element);
        this.requestTick();
    }
    unobserve(id) {
        const job = this.jobs.get(id);
        if (!job)
            return;
        this.clearCleanupTimer(job);
        if (this.retryTimerId !== null) {
            // job removal may affect earliest; clear armed and will re-arm on next tick if needed
            this.clearTimeoutFn(this.retryTimerId);
            this.retryTimerId = null;
            this.armedRetryAt = null;
        }
        job.decoderAbort?.abort("unobserved");
        job.prefixAccum = null;
        job.prefixBytes = 0;
        delete job.lastProgressEmit;
        this.observer.unobserve(job.element);
        this.byElement.delete(job.element);
        this.jobs.delete(id);
    }
    select(id) {
        const job = this.jobs.get(id);
        if (!job)
            return;
        this.clearCleanupTimer(job);
        job.selected = true;
        job.priority = 1;
        job.targetTier = "full";
        job.errorCount = 0;
        job.nextRetryAt = 0;
        this.requestTick();
    }
    deselect(id) {
        const job = this.jobs.get(id);
        if (!job)
            return;
        job.selected = false;
        job.targetTier = "preview";
        job.errorCount = 0;
        job.nextRetryAt = 0;
        this.recomputePriority(job);
        if (!job.visible && !job.nearViewport) {
            this.scheduleViewportExitCleanup(job);
        }
        this.requestTick();
    }
    setTargetTier(id, tier) {
        const job = this.jobs.get(id);
        if (job) {
            job.targetTier = tier;
            job.errorCount = 0;
            job.nextRetryAt = 0;
            this.requestTick();
        }
    }
    /** Exposed for testing only — returns a copy of the internal job. */
    getJob(id) {
        const job = this.jobs.get(id);
        return job ? { ...job } : undefined;
    }
    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        if (this.rafHandle !== null) {
            this.caf(this.rafHandle);
            this.rafHandle = null;
        }
        if (this.retryTimerId !== null) {
            this.clearTimeoutFn(this.retryTimerId);
            this.retryTimerId = null;
            this.armedRetryAt = null;
        }
        this.observer.disconnect();
        for (const job of this.jobs.values()) {
            this.clearCleanupTimer(job);
            job.decoderAbort?.abort("destroyed");
        }
        this.jobs.clear();
        this.byElement.clear();
    }
    handleIntersection = (entries) => {
        for (const entry of entries) {
            const job = this.byElement.get(entry.target);
            if (!job)
                continue;
            const fullyVisible = entry.isIntersecting && entry.intersectionRatio >= 0.99;
            const partiallyVisible = entry.isIntersecting && entry.intersectionRatio >= 0.5;
            const becameNear = !job.nearViewport && entry.isIntersecting;
            job.fullyVisible = fullyVisible;
            job.visible = partiallyVisible;
            job.nearViewport = entry.isIntersecting;
            this.clearCleanupTimerIfInView(job);
            this.recomputePriority(job);
            if (!job.selected && !job.visible && !job.nearViewport) {
                this.scheduleViewportExitCleanup(job);
            }
            if (becameNear && job.manifest === null && !job.manifestChecked && this.inFlightManifestFetches < this.opts.maxConcurrentFetches) {
                this.prefetchManifest(job);
            }
        }
        this.requestTick();
    };
    clearCleanupTimer(job) {
        if (job.cleanupTimer !== null) {
            this.clearTimeoutFn(job.cleanupTimer);
            job.cleanupTimer = null;
        }
    }
    clearCleanupTimerIfInView(job) {
        if (job.fullyVisible || job.visible || job.nearViewport || job.selected) {
            this.clearCleanupTimer(job);
        }
    }
    recomputePriority(job) {
        if (job.selected) {
            job.priority = 1;
            return;
        }
        job.priority = job.fullyVisible ? 3 : job.visible ? 4 : job.nearViewport ? 5 : 7;
    }
    scheduleViewportExitCleanup(job) {
        if (job.cleanupTimer !== null)
            return;
        job.cleanupTimer = this.setTimeoutFn(() => {
            job.cleanupTimer = null;
            if (!job.visible && !job.selected) {
                job.decoderAbort?.abort("left-viewport");
                job.prefixAccum = null;
                job.prefixBytes = 0;
                job.bytesLoaded = 0;
                delete job.lastProgressEmit;
                // timer only aborts; finally owns activeDecoders decrement (C-2)
            }
        }, 2000);
    }
    requestTick() {
        if (this.destroyed || this.tickPending)
            return;
        this.tickPending = true;
        this.rafHandle = this.raf(() => {
            this.tickPending = false;
            this.rafHandle = null;
            this.tick();
        });
    }
    armEarliestRetryTimer(now) {
        let earliest = null;
        for (const j of this.jobs.values()) {
            if (!j.nextRetryAt || j.nextRetryAt <= now)
                continue;
            const t = j.nextRetryAt;
            if (earliest === null || t < earliest)
                earliest = t;
        }
        if (earliest === null) {
            if (this.retryTimerId !== null) {
                this.clearTimeoutFn(this.retryTimerId);
                this.retryTimerId = null;
                this.armedRetryAt = null;
            }
            return;
        }
        if (this.armedRetryAt === earliest && this.retryTimerId !== null)
            return;
        if (this.retryTimerId !== null) {
            this.clearTimeoutFn(this.retryTimerId);
        }
        const delay = Math.max(0, earliest - now);
        this.armedRetryAt = earliest;
        this.retryTimerId = this.setTimeoutFn(() => {
            this.retryTimerId = null;
            this.armedRetryAt = null;
            if (!this.destroyed)
                this.requestTick();
        }, delay);
    }
    prefetchManifest(job) {
        if (job.manifest !== null || job.manifestChecked)
            return;
        job.manifestChecked = true;
        this.inFlightManifestFetches++;
        void this.fetchAndCacheManifest(job)
            .then((m) => {
            if (m !== null && job.manifest === null) {
                job.manifest = m;
                if (!job.manifestDispatched) {
                    job.manifestDispatched = true;
                    this.opts.onManifest(job.id, m);
                }
            }
        })
            .catch((e) => {
            this.opts.onError(job.id, e instanceof Error ? e : new Error(String(e)));
        })
            .finally(() => {
            this.inFlightManifestFetches = Math.max(0, this.inFlightManifestFetches - 1);
        });
    }
    teeFetch(onChunk) {
        let pump = Promise.resolve();
        const fetchImpl = async (input, init) => {
            const resp = await fetch(input, init);
            if (!resp.ok || resp.body === null)
                return resp;
            const [toDecoder, toCapture] = resp.body.tee();
            pump = (async () => {
                const r = toCapture.getReader();
                try {
                    for (;;) {
                        const { done, value } = await r.read();
                        if (done)
                            break;
                        onChunk(value);
                    }
                }
                catch {
                    /* abort/network: partial is valid prefix for resume */
                }
                finally {
                    r.cancel().catch(() => { });
                }
            })();
            return new Response(toDecoder, resp);
        };
        return { fetchImpl, settled: () => pump };
    }
    tick() {
        if (this.destroyed)
            return;
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        this.armEarliestRetryTimer(now);
        const candidates = [];
        for (const j of this.jobs.values()) {
            if (!j.visible && !j.nearViewport && !j.selected)
                continue;
            if (j.decoderAbort !== null)
                continue;
            if (j.nextRetryAt && now < j.nextRetryAt)
                continue;
            const curRank = tierRank(j.currentTier);
            const tgtRank = tierRank(j.targetTier);
            if (curRank >= tgtRank)
                continue;
            candidates.push({ job: j, score: fairnessScore(j, now) });
        }
        candidates.sort((a, b) => b.score - a.score);
        for (const { job } of candidates) {
            if (this.activeDecoders >= this.opts.maxActiveDecoders)
                break;
            this.startDecode(job).catch((e) => {
                this.opts.onError(job.id, e instanceof Error ? e : new Error(String(e)));
            });
        }
    }
    async startDecode(job) {
        this.activeDecoders++;
        job.nextRetryAt = 0;
        this.clearCleanupTimer(job);
        const abort = new AbortController();
        job.decoderAbort = abort;
        job.lastServedAt =
            typeof performance !== "undefined" ? performance.now() : Date.now();
        let capture = null;
        let capturedBytes = 0;
        try {
            // Load manifest if not already loaded (prefetch may have populated).
            // Capture into a local once — avoids TOCTOU between cache.getManifest,
            // prefetchManifest writes, and the manifestDispatched flag check below.
            let manifest = job.manifest;
            if (manifest === null) {
                manifest = await this.cache.getManifest(job.jxlUrl);
                if (manifest !== null)
                    job.manifest = manifest;
            }
            if (abort.signal.aborted)
                return;
            if (manifest === null && !job.manifestChecked) {
                manifest = await this.fetchAndCacheManifest(job, abort.signal);
                job.manifest = manifest;
                job.manifestChecked = true;
            }
            if (abort.signal.aborted)
                return;
            const wasManifestDispatched = job.manifestDispatched;
            if (manifest && !job.manifestDispatched) {
                job.manifestDispatched = true;
                this.opts.onManifest(job.id, manifest);
            }
            // Saliency-aware: manifest carries center/conf from encode-side policy (saliency-policy.ts).
            // Boost priority + target for images with reliable ROI data so human-important detail arrives first.
            // Only apply the boost once — on the tier when the manifest is first dispatched — to prevent
            // cumulative priority drift across dc→preview→full repeated startDecode calls.
            if (manifest?.saliency?.enabled && !wasManifestDispatched) {
                if (job.priority > 1)
                    job.priority = Math.max(1, job.priority - 1);
                if (job.targetTier === "preview")
                    job.targetTier = "full";
            }
            const target = nextTier(job.currentTier);
            if (target === null)
                return;
            const manifestTier = manifest !== null ? lookupTier(manifest, target) : undefined;
            // Fast path from bitmap cache (in-mem ImageBitmap populated by consumer after prior onFrame).
            // If we already have the decoded result for the next tier, claim instantly, notify, skip network+decode.
            // Positive for revisit perf in galleries without re-paying decode cost.
            if (manifestTier) {
                try {
                    const bm = await this.cache.getBitmap(job.jxlUrl, target);
                    if (bm) {
                        if (abort.signal.aborted)
                            return;
                        job.currentTier = target;
                        this.opts.onTier(job.id, target);
                        // Cache hit: 0 network bytes transferred; report the target so consumers
                        // know the tier is complete without simulating a phantom transfer spike.
                        this.opts.onProgress(job.id, 0, manifestTier.byteEnd);
                        return;
                    }
                }
                catch {
                    // fallthrough to network
                }
            }
            const session = this.sessionFactory();
            // E-1: feed known prefix bytes *locally* to the fresh DecodeSession before delta fetch.
            // fwp only delivers the tail over wire (bandwidth win); decoder needs full logical codestream
            // from byte 0 for correct progressive layer state on tier upgrade. This fulfills the
            // "already pushed into session by caller" contract in fetchTierWithPrefix jsdoc.
            // Without this the delta path would feed mid-stream only -> broken higher-tier progressive frames.
            // (was missing; now positive correctness + resume fix)
            let startingPrefix = null;
            if (job.prefixAccum && job.prefixBytes > 0) {
                startingPrefix = job.prefixAccum.slice(0, job.prefixBytes);
            }
            else if (job.currentTier !== "none") {
                try {
                    const cached = await this.cache.getByteRange(job.jxlUrl, job.currentTier);
                    if (cached && cached.byteLength > 0) {
                        const arr = new Uint8Array(cached);
                        job.prefixAccum = arr;
                        job.prefixBytes = arr.byteLength;
                        startingPrefix = arr;
                    }
                }
                catch {
                    // no prefix available
                }
            }
            if (startingPrefix && startingPrefix.byteLength > 0) {
                await session.push(startingPrefix);
            }
            const ft = this.testFetchTier ?? fetchTier;
            const ff = this.testFetchFull ?? fetchFull;
            const st = this.testStreamTierFrames ?? streamTierFrames;
            const fwp = this.testFetchTierWithPrefix ?? fetchTierWithPrefix;
            job.bytesLoaded = job.prefixBytes || 0;
            const byteTarget = manifestTier?.byteEnd;
            this.opts.onProgress(job.id, job.bytesLoaded, byteTarget);
            const onChunk = (c) => {
                const needed = job.prefixBytes + c.byteLength;
                if (!job.prefixAccum || job.prefixAccum.byteLength < needed) {
                    const oldCap = job.prefixAccum ? job.prefixAccum.byteLength : 0;
                    const newCap = Math.max(needed, oldCap * 2 || 4096);
                    const grown = new Uint8Array(newCap);
                    if (job.prefixAccum && job.prefixBytes > 0) {
                        grown.set(job.prefixAccum.subarray(0, job.prefixBytes));
                    }
                    job.prefixAccum = grown;
                }
                job.prefixAccum.set(c, job.prefixBytes);
                job.prefixBytes += c.byteLength;
                capturedBytes += c.byteLength;
                job.bytesLoaded = job.prefixBytes;
                const emitNow = Date.now();
                if (emitNow - (job.lastProgressEmit || 0) > 50) {
                    job.lastProgressEmit = emitNow;
                    this.opts.onProgress(job.id, job.bytesLoaded, byteTarget);
                }
            };
            // E-1/E-2/E-5 wiring with capture tee at boundary; preserve C-1 fetchDone pattern
            let fetchError;
            const hasPrefix = job.prefixBytes > 0;
            const useWith = manifestTier !== undefined && hasPrefix;
            // build the fetch promise (with optional tee capture)
            let fetchP;
            if (useWith) {
                capture = this.teeFetch(onChunk);
                // pass *length only* (number) to fwp now that it accepts it; no need to concat/ materialise
                // full prefix bytes just for the Range header + CR validation
                const p = fwp(job.jxlUrl, manifestTier, job.prefixBytes, session, {
                    signal: abort.signal,
                    fetchImpl: capture.fetchImpl,
                }).catch(async (e) => {
                    if (e instanceof RangeNotSupportedError && !abort.signal.aborted) {
                        // delta range not supported by server/proxy; discard any partial accum from this attempt
                        // and fall back to full fetch from byte 0 (will rebuild accum via onChunk from scratch).
                        // Drain the old capture pump first so the original toCapture branch releases its reader lock
                        // before we overwrite `capture` with t2 (prevents orphaned locked ReadableStream branch).
                        const oldCapture = capture;
                        if (oldCapture)
                            await oldCapture.settled().catch(() => { });
                        job.prefixAccum = null;
                        job.prefixBytes = 0;
                        capturedBytes = 0;
                        job.bytesLoaded = 0;
                        const t2 = this.teeFetch(onChunk);
                        capture = t2;
                        return ft(job.jxlUrl, manifestTier, session, {
                            signal: abort.signal,
                            fetchImpl: t2.fetchImpl,
                        }).catch((e2) => {
                            if (!abort.signal.aborted)
                                fetchError = e2;
                        });
                    }
                    fetchError = e;
                });
                fetchP = p;
            }
            else if (manifestTier !== undefined) {
                capture = this.teeFetch(onChunk);
                fetchP = ft(job.jxlUrl, manifestTier, session, {
                    signal: abort.signal,
                    fetchImpl: capture.fetchImpl,
                }).catch((e) => { fetchError = e; });
            }
            else {
                capture = this.teeFetch(onChunk);
                fetchP = ff(job.jxlUrl, session, {
                    signal: abort.signal,
                    fetchImpl: capture.fetchImpl,
                }).catch((e) => { fetchError = e; });
            }
            // C-1 style: await frames first, then the fetchP
            for await (const frame of st(session)) {
                if (abort.signal.aborted)
                    break;
                this.opts.onFrame(job.id, frame);
            }
            await fetchP;
            if (fetchError !== undefined && !abort.signal.aborted) {
                throw fetchError instanceof Error ? fetchError : new Error(String(fetchError));
            }
            if (!abort.signal.aborted) {
                const achieved = target;
                job.currentTier = achieved;
                this.opts.onTier(job.id, achieved);
                job.errorCount = 0;
                job.nextRetryAt = 0;
                // E-1: persist captured prefix for tier just completed (after settled; capture may trail)
                if (capture) {
                    await capture.settled().catch(() => { });
                    if (job.prefixAccum && job.prefixBytes > 0) {
                        const fullPrefix = job.prefixAccum.subarray(0, job.prefixBytes);
                        if (fullPrefix.byteLength > 0) {
                            const buffer = fullPrefix.buffer.slice(fullPrefix.byteOffset, fullPrefix.byteOffset + fullPrefix.byteLength);
                            await this.cache.setByteRange(job.jxlUrl, achieved, buffer);
                            // E-5 opt-in
                            if (achieved === "full" && this.opts.verifyHash && job.manifest) {
                                const ok = await checkHash(job.manifest, fullPrefix);
                                if (!ok) {
                                    await this.cache.invalidate(job.jxlUrl);
                                    job.prefixAccum = null;
                                    job.prefixBytes = 0;
                                    job.bytesLoaded = 0;
                                    this.opts.onError(job.id, new Error("Full tier hash verification failed; cache invalidated"));
                                }
                            }
                            if (achieved === "full") {
                                job.prefixAccum = null;
                                job.prefixBytes = 0;
                            }
                        }
                    }
                }
            }
        }
        catch (e) {
            // C-3: inc count, bounded exp backoff or permanent for 404/410; arm timer.
            job.errorCount++;
            const now = typeof performance !== "undefined" ? performance.now() : Date.now();
            if (e instanceof HttpError && (e.status === 404 || e.status === 410)) {
                job.nextRetryAt = Infinity;
            }
            else {
                job.nextRetryAt = now + Math.min(1000 * 2 ** job.errorCount, 30_000);
            }
            this.armEarliestRetryTimer(now);
            if (!abort.signal.aborted) {
                this.opts.onError(job.id, e instanceof Error ? e : new Error(String(e)));
            }
        }
        finally {
            job.decoderAbort = null;
            this.activeDecoders = Math.max(0, this.activeDecoders - 1);
            this.requestTick();
            // partial prefix left in accum for resume (dropped only on C-2 timer / unobserve / full persist)
        }
    }
    async fetchAndCacheManifest(job, signal) {
        const timeoutMs = 10_000;
        const timeoutController = new AbortController();
        const timer = this.setTimeoutFn(() => timeoutController.abort("manifest-timeout"), timeoutMs);
        if (signal) {
            signal.addEventListener("abort", () => timeoutController.abort(signal.reason), { once: true });
        }
        try {
            const resp = await fetch(job.manifestUrl, { signal: timeoutController.signal });
            if (!resp.ok)
                return null;
            const json = await resp.json();
            const manifest = validateManifest(json);
            await this.cache.setManifest(job.jxlUrl, manifest);
            return manifest;
        }
        catch (e) {
            if (signal?.aborted || timeoutController.signal.aborted)
                return null;
            throw e;
        }
        finally {
            this.clearTimeoutFn(timer);
        }
    }
}
//# sourceMappingURL=progressive-scheduler.js.map