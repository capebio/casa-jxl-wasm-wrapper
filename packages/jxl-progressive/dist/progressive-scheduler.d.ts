import type { SessionFactory } from "./types.js";
import type { DecodeFrameEvent } from "@casabio/jxl-session";
import { type ProgressiveManifest } from "./progressive-manifest.js";
import type { ProgressiveCache } from "./progressive-cache.js";
export type Tier = "none" | "dc" | "preview" | "full";
export interface ProgressiveImageJob {
    id: string;
    element: Element;
    jxlUrl: string;
    manifestUrl: string;
    visible: boolean;
    nearViewport: boolean;
    selected: boolean;
    currentTier: Tier;
    targetTier: Tier;
    /** 1 (highest) to 7 (lowest). See priority table in spec. */
    priority: number;
    lastServedAt: number;
    bytesLoaded: number;
    manifest: ProgressiveManifest | null;
    decoderAbort: AbortController | null;
}
export interface GalleryOptions {
    maxActiveDecoders?: number;
    maxConcurrentFetches?: number;
    maxQueuedJobs?: number;
    rootMargin?: string;
    onFrame?: (id: string, frame: DecodeFrameEvent) => void;
    onTier?: (id: string, tier: Tier) => void;
    onError?: (id: string, err: Error) => void;
    manifestSuffix?: string;
    autoProfile?: boolean;
    /** Injected for testing. Default: global IntersectionObserver constructor. */
    intersectionObserverFactory?: (callback: IntersectionObserverCallback, options?: IntersectionObserverInit) => IntersectionObserver;
    /** Injected for testing. Default: globalThis.requestAnimationFrame. */
    rafScheduler?: (fn: FrameRequestCallback) => number;
    /** Injected for testing. Default: globalThis.cancelAnimationFrame. */
    rafCanceller?: (id: number) => void;
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
    private readonly cache;
    private readonly sessionFactory;
    private readonly observer;
    private readonly raf;
    private readonly caf;
    private readonly opts;
    private activeDecoders;
    private rafHandle;
    private destroyed;
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
    private scheduleViewportExitCleanup;
    private scheduleTick;
    private tick;
    private startDecode;
    private fetchAndCacheManifest;
}
//# sourceMappingURL=progressive-scheduler.d.ts.map