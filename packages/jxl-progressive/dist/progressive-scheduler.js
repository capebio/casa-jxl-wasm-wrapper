// packages/jxl-progressive/src/progressive-scheduler.ts
import { validateManifest, lookupTier, } from "./progressive-manifest.js";
import { fetchTier, fetchFull, streamTierFrames } from "./progressive-stream.js";
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
    cache;
    sessionFactory;
    observer;
    raf;
    caf;
    opts;
    activeDecoders = 0;
    rafHandle = null;
    destroyed = false;
    constructor(cache, sessionFactory, opts = {}) {
        this.cache = cache;
        this.sessionFactory = sessionFactory;
        this.raf =
            opts.rafScheduler ??
                ((fn) => globalThis.requestAnimationFrame(fn));
        this.caf =
            opts.rafCanceller ??
                ((id) => globalThis.cancelAnimationFrame(id));
        this.opts = {
            maxActiveDecoders: opts.maxActiveDecoders ?? 4,
            maxConcurrentFetches: opts.maxConcurrentFetches ?? 3,
            maxQueuedJobs: opts.maxQueuedJobs ?? 50,
            rootMargin: opts.rootMargin ?? "200px",
            onFrame: opts.onFrame ?? (() => { }),
            onTier: opts.onTier ?? (() => { }),
            onError: opts.onError ?? (() => { }),
            manifestSuffix: opts.manifestSuffix ?? ".json",
            autoProfile: opts.autoProfile ?? true,
        };
        const ioFactory = opts.intersectionObserverFactory ??
            ((cb, ioOpts) => new IntersectionObserver(cb, ioOpts));
        this.observer = ioFactory(this.handleIntersection, {
            rootMargin: this.opts.rootMargin,
            threshold: [0, 0.5, 1.0],
        });
        this.scheduleTick();
    }
    /** Register an image. `jxlUrl` is the .jxl resource URL. */
    observe(element, id, jxlUrl) {
        if (this.destroyed)
            return;
        if (this.jobs.size >= this.opts.maxQueuedJobs)
            return;
        const job = {
            id,
            element,
            jxlUrl,
            manifestUrl: jxlUrl + this.opts.manifestSuffix,
            visible: false,
            nearViewport: false,
            selected: false,
            currentTier: "none",
            targetTier: "preview",
            priority: 5,
            lastServedAt: 0,
            bytesLoaded: 0,
            manifest: null,
            decoderAbort: null,
        };
        this.jobs.set(id, job);
        this.observer.observe(element);
    }
    unobserve(id) {
        const job = this.jobs.get(id);
        if (!job)
            return;
        job.decoderAbort?.abort("unobserved");
        this.observer.unobserve(job.element);
        this.jobs.delete(id);
    }
    select(id) {
        const job = this.jobs.get(id);
        if (!job)
            return;
        job.selected = true;
        job.priority = 1;
        job.targetTier = "full";
    }
    deselect(id) {
        const job = this.jobs.get(id);
        if (!job)
            return;
        job.selected = false;
        job.priority = job.visible ? 3 : 5;
        job.targetTier = "preview";
    }
    setTargetTier(id, tier) {
        const job = this.jobs.get(id);
        if (job)
            job.targetTier = tier;
    }
    /** Exposed for testing only — returns a copy of the internal job. */
    getJob(id) {
        return this.jobs.get(id);
    }
    destroy() {
        this.destroyed = true;
        if (this.rafHandle !== null)
            this.caf(this.rafHandle);
        this.observer.disconnect();
        for (const job of this.jobs.values()) {
            job.decoderAbort?.abort("destroyed");
        }
        this.jobs.clear();
    }
    handleIntersection = (entries) => {
        for (const entry of entries) {
            for (const job of this.jobs.values()) {
                if (job.element !== entry.target)
                    continue;
                const fullyVisible = entry.isIntersecting && entry.intersectionRatio >= 1.0;
                const partiallyVisible = entry.isIntersecting && entry.intersectionRatio >= 0.5;
                job.visible = partiallyVisible;
                job.nearViewport = entry.isIntersecting;
                if (job.selected) {
                    // Selected jobs keep priority 1 regardless.
                }
                else if (fullyVisible) {
                    job.priority = 3;
                }
                else if (partiallyVisible) {
                    job.priority = 4;
                }
                else if (job.nearViewport) {
                    job.priority = 5;
                }
                else {
                    job.priority = 7;
                    this.scheduleViewportExitCleanup(job);
                }
                break;
            }
        }
    };
    scheduleViewportExitCleanup(job) {
        const graceMs = 2000;
        setTimeout(() => {
            if (!job.visible && !job.selected && job.decoderAbort !== null) {
                job.decoderAbort.abort("left-viewport");
                job.decoderAbort = null;
                this.activeDecoders = Math.max(0, this.activeDecoders - 1);
            }
        }, graceMs);
    }
    scheduleTick() {
        if (this.destroyed)
            return;
        this.rafHandle = this.raf(() => {
            this.tick();
            this.scheduleTick();
        });
    }
    tick() {
        if (this.destroyed)
            return;
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        const candidates = [...this.jobs.values()]
            .filter((j) => j.visible || j.nearViewport || j.selected)
            .filter((j) => tierRank(j.currentTier) < tierRank(j.targetTier))
            .filter((j) => j.decoderAbort === null)
            .sort((a, b) => fairnessScore(b, now) - fairnessScore(a, now));
        for (const job of candidates) {
            if (this.activeDecoders >= this.opts.maxActiveDecoders)
                break;
            void this.startDecode(job);
        }
    }
    async startDecode(job) {
        this.activeDecoders++;
        const abort = new AbortController();
        job.decoderAbort = abort;
        job.lastServedAt =
            typeof performance !== "undefined" ? performance.now() : Date.now();
        try {
            // Load manifest if not already loaded
            if (job.manifest === null) {
                job.manifest = await this.cache.getManifest(job.jxlUrl);
            }
            if (job.manifest === null) {
                job.manifest = await this.fetchAndCacheManifest(job);
            }
            const target = nextTier(job.currentTier);
            if (target === null)
                return;
            const manifestTier = job.manifest !== null ? lookupTier(job.manifest, target) : undefined;
            const session = this.sessionFactory();
            if (manifestTier !== undefined) {
                void fetchTier(job.jxlUrl, manifestTier, session, { signal: abort.signal });
            }
            else {
                void fetchFull(job.jxlUrl, session, { signal: abort.signal });
            }
            for await (const frame of streamTierFrames(session)) {
                if (abort.signal.aborted)
                    break;
                this.opts.onFrame(job.id, frame);
            }
            if (!abort.signal.aborted) {
                job.currentTier = target;
                this.opts.onTier(job.id, target);
            }
        }
        catch (e) {
            if (!abort.signal.aborted) {
                this.opts.onError(job.id, e instanceof Error ? e : new Error(String(e)));
            }
        }
        finally {
            job.decoderAbort = null;
            this.activeDecoders = Math.max(0, this.activeDecoders - 1);
        }
    }
    async fetchAndCacheManifest(job) {
        try {
            const resp = await fetch(job.manifestUrl);
            if (!resp.ok)
                return null;
            const json = await resp.json();
            const manifest = validateManifest(json);
            await this.cache.setManifest(job.jxlUrl, manifest);
            return manifest;
        }
        catch {
            return null;
        }
    }
}
//# sourceMappingURL=progressive-scheduler.js.map