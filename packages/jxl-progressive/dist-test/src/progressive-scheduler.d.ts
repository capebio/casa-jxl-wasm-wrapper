import type { SessionFactory } from "./types.js";
import type { DecodeFrameEvent } from "@casabio/jxl-session";
import { type ProgressiveManifest } from "./progressive-manifest.js";
import { fetchTier, fetchFull, streamTierFrames, fetchTierWithPrefix } from "./progressive-stream.js";
import type { ProgressiveCache } from "./progressive-cache.js";
export type Tier = "none" | "dc" | "preview" | "full";
export interface ProgressiveImageJob {
    id: string;
    element: Element;
    jxlUrl: string;
    manifestUrl: string;
    fullyVisible: boolean;
    visible: boolean;
    nearViewport: boolean;
    selected: boolean;
    currentTier: Tier;
    targetTier: Tier;
    /** 1 (highest) to 7 (lowest). See priority table in spec. */
    priority: number;
    lastServedAt: number;
    bytesLoaded: number;
    /** Single accum buffer + logical length for known prefix bytes of currentTier.
     *  Replaces prefixChunks[] + repeated concat to avoid O(bytes) copy on every resume/upgrade/persist.
     *  Appends during capture; only sliced at persist or for local decoder feed.
     */
    prefixAccum: Uint8Array | null;
    prefixBytes: number;
    /** Last time onProgress was emitted (throttled). */
    lastProgressEmit?: number;
    manifest: ProgressiveManifest | null;
    manifestDispatched: boolean;
    decoderAbort: AbortController | null;
    cleanupTimer: ReturnType<typeof setTimeout> | null;
    errorCount: number;
    nextRetryAt: number;
    manifestChecked: boolean;
}
export interface GalleryOptions {
    maxActiveDecoders?: number;
    maxConcurrentFetches?: number;
    maxQueuedJobs?: number;
    rootMargin?: string;
    onFrame?: (id: string, frame: DecodeFrameEvent) => void;
    onTier?: (id: string, tier: Tier) => void;
    onError?: (id: string, err: Error) => void;
    onProgress?: (id: string, bytesLoaded: number, byteTarget: number | undefined) => void;
    onManifest?: (id: string, manifest: ProgressiveManifest) => void;
    verifyHash?: boolean;
    manifestSuffix?: string;
    autoProfile?: boolean;
    /** Injected for testing. Default: global IntersectionObserver constructor. */
    intersectionObserverFactory?: (callback: IntersectionObserverCallback, options?: IntersectionObserverInit) => IntersectionObserver;
    /** Injected for testing. Default: globalThis.requestAnimationFrame. */
    rafScheduler?: (fn: FrameRequestCallback) => number;
    /** Injected for testing. Default: globalThis.cancelAnimationFrame. */
    rafCanceller?: (id: number) => void;
    /** Injected for testing. Default: globalThis.setTimeout. */
    timeoutScheduler?: (fn: () => void, delay: number) => any;
    /** Injected for testing. Default: globalThis.clearTimeout. */
    timeoutCanceller?: (id: any) => void;
    /** Test overrides (for scheduler.test injection of fetch/stream). */
    testFetchTier?: typeof fetchTier;
    testFetchFull?: typeof fetchFull;
    testStreamTierFrames?: typeof streamTierFrames;
    /** Test injection for E-1 prefix path. */
    testFetchTierWithPrefix?: typeof fetchTierWithPrefix;
}
/** Lower priority number = more important. Maps to a score where higher = better. */
export declare function tierRank(tier: Tier): number;
/** Higher score = schedule this job sooner. */
export declare function fairnessScore(job: ProgressiveImageJob, now: number): number;
/**
 * Gallery-level progressive scheduler.
 *
 * Manages IntersectionObserver, a weighted round-robin job queue,
 * and DecodeSession lifecycle. Does NOT touch jxl-scheduler (worker pool).
 */
export declare class ProgressiveGallery {
    private readonly jobs;
    private readonly byElement;
    private readonly cache;
    private readonly sessionFactory;
    private readonly observer;
    private readonly raf;
    private readonly caf;
    private readonly setTimeoutFn;
    private readonly clearTimeoutFn;
    private readonly opts;
    private activeDecoders;
    private rafHandle;
    private destroyed;
    private tickPending;
    private retryTimerId;
    private armedRetryAt;
    private inFlightManifestFetches;
    /**
     * Dirty-flag caches candidate list across RAF ticks.
     * starvationBonus is time-dependent, so always updated; rebuild only on state change.
     * Set true on any mutation that changes which jobs qualify or their relative ranking structure
     * (observe, unobserve, select, deselect, intersection change, decode completion/abort).
     */
    private candidatesDirty;
    private cachedCandidates;
    private readonly testFetchTier;
    private readonly testFetchFull;
    private readonly testStreamTierFrames;
    private readonly testFetchTierWithPrefix?;
    constructor(cache: ProgressiveCache, sessionFactory: SessionFactory, opts?: GalleryOptions);
    /** Register an image. `jxlUrl` is the .jxl resource URL. */
    observe(element: Element, id: string, jxlUrl: string): void;
    unobserve(id: string): void;
    select(id: string): void;
    deselect(id: string): void;
    setTargetTier(id: string, tier: Tier): void;
    /** Exposed for testing only — returns a copy of the internal job. */
    getJob(id: string): ProgressiveImageJob | undefined;
    destroy(): void;
    private handleIntersection;
    private clearCleanupTimer;
    private clearCleanupTimerIfInView;
    private recomputePriority;
    private scheduleViewportExitCleanup;
    private requestTick;
    private armEarliestRetryTimer;
    private prefetchManifest;
    private teeFetch;
    private tick;
    private startDecode;
    private fetchAndCacheManifest;
}
//# sourceMappingURL=progressive-scheduler.d.ts.map