// packages/jxl-progressive/src/progressive-scheduler.ts

import type { SessionFactory } from "./types.js";
import type { DecodeFrameEvent } from "@casabio/jxl-session";
import {
  validateManifest,
  lookupTier,
  checkHash,
  type ProgressiveManifest,
  type TierName,
} from "./progressive-manifest.js";
import {
  fetchTier,
  fetchFull,
  streamTierFrames,
  fetchTierWithPrefix,
  RangeNotSupportedError,
  HttpError,
} from "./progressive-stream.js";
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
  intersectionObserverFactory?: (
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) => IntersectionObserver;
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
export function tierRank(tier: Tier): number {
  const ranks: Record<Tier, number> = { none: 0, dc: 1, preview: 2, full: 3 };
  return ranks[tier];
}

/** Higher score = schedule this job sooner. */
export function fairnessScore(job: ProgressiveImageJob, now: number): number {
  // (8 - priority): priority 1 → 7, priority 7 → 1
  const importanceScore = 8 - job.priority;
  const starvationBonus = Math.min((now - job.lastServedAt) / 1000, 5);
  const underRefinedBonus = 3 - tierRank(job.currentTier);
  return importanceScore + starvationBonus + underRefinedBonus;
}

function concatUint8Arrays(chunks: readonly Uint8Array[]): Uint8Array {
  const valid = chunks.filter((c) => c.byteLength > 0);
  if (valid.length === 0) return new Uint8Array(0);
  if (valid.length === 1) return valid[0]!;
  const total = valid.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of valid) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function nextTier(current: Tier): Tier | null {
  const map: Partial<Record<Tier, Tier>> = { none: "dc", dc: "preview", preview: "full" };
  return map[current] ?? null;
}

/**
 * Gallery-level progressive scheduler.
 *
 * Manages IntersectionObserver, a weighted round-robin job queue,
 * and DecodeSession lifecycle. Does NOT touch jxl-scheduler (worker pool).
 */
export class ProgressiveGallery {
  private readonly jobs = new Map<string, ProgressiveImageJob>();
  private readonly byElement = new Map<Element, ProgressiveImageJob>();
  private readonly cache: ProgressiveCache;
  private readonly sessionFactory: SessionFactory;
  private readonly observer: IntersectionObserver;
  private readonly raf: (fn: FrameRequestCallback) => number;
  private readonly caf: (id: number) => void;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => any;
  private readonly clearTimeoutFn: (id: any) => void;
  private readonly opts: Required<
    Omit<GalleryOptions, "intersectionObserverFactory" | "rafScheduler" | "rafCanceller" | "timeoutScheduler" | "timeoutCanceller" | "testFetchTier" | "testFetchFull" | "testStreamTierFrames" | "testFetchTierWithPrefix">
  >;
  private activeDecoders = 0;
  private rafHandle: number | null = null;
  private destroyed = false;
  private tickPending = false;
  private retryTimerId: any = null;
  private armedRetryAt: number | null = null;
  private inFlightManifestFetches = 0;
  /**
   * Dirty-flag caches candidate list across RAF ticks.
   * starvationBonus is time-dependent, so always updated; rebuild only on state change.
   * Set true on any mutation that changes which jobs qualify or their relative ranking structure
   * (observe, unobserve, select, deselect, intersection change, decode completion/abort).
   */
  private candidatesDirty = true;
  private cachedCandidates: Array<{ job: ProgressiveImageJob; score: number }> = [];
  private readonly testFetchTier: GalleryOptions["testFetchTier"];
  private readonly testFetchFull: GalleryOptions["testFetchFull"];
  private readonly testStreamTierFrames: GalleryOptions["testStreamTierFrames"];
  private readonly testFetchTierWithPrefix?: typeof fetchTierWithPrefix;

  constructor(
    cache: ProgressiveCache,
    sessionFactory: SessionFactory,
    opts: GalleryOptions = {},
  ) {
    this.cache = cache;
    this.sessionFactory = sessionFactory;
    this.raf =
      opts.rafScheduler ??
      ((fn) => globalThis.requestAnimationFrame(fn));
    this.caf =
      opts.rafCanceller ??
      ((id) => globalThis.cancelAnimationFrame(id));
    this.setTimeoutFn =
      opts.timeoutScheduler ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
    this.clearTimeoutFn =
      opts.timeoutCanceller ?? ((id: any) => globalThis.clearTimeout(id));
    this.testFetchTier = opts.testFetchTier;
    this.testFetchFull = opts.testFetchFull;
    this.testStreamTierFrames = opts.testStreamTierFrames;
    (this as any).testFetchTierWithPrefix = (opts as any).testFetchTierWithPrefix;
    const autoProfile = (opts.autoProfile ?? true) !== false;
    let maxActiveDecoders = opts.maxActiveDecoders;
    if (maxActiveDecoders === undefined && autoProfile) {
      if (typeof navigator !== "undefined" && typeof (navigator as any).hardwareConcurrency === "number") {
        const hw = (navigator as any).hardwareConcurrency | 0;
        maxActiveDecoders = Math.min(4, Math.max(2, Math.floor(hw / 2)));
      }
    }
    maxActiveDecoders = maxActiveDecoders ?? 4;
    this.opts = {
      maxActiveDecoders,
      maxConcurrentFetches: opts.maxConcurrentFetches ?? 3,
      maxQueuedJobs: opts.maxQueuedJobs ?? 50,
      rootMargin: opts.rootMargin ?? "200px",
      onFrame: opts.onFrame ?? (() => {}),
      onTier: opts.onTier ?? (() => {}),
      onError: opts.onError ?? (() => {}),
      onProgress: opts.onProgress ?? (() => {}),
      onManifest: opts.onManifest ?? (() => {}),
      verifyHash: opts.verifyHash ?? false,
      manifestSuffix: opts.manifestSuffix ?? ".json",
      autoProfile: opts.autoProfile ?? true,
    };
    const ioFactory =
      opts.intersectionObserverFactory ??
      ((cb, ioOpts) => new IntersectionObserver(cb, ioOpts));
    this.observer = ioFactory(this.handleIntersection, {
      rootMargin: this.opts.rootMargin,
      threshold: [0, 0.5, 1.0],
    });
    this.requestTick();
  }

  /** Register an image. `jxlUrl` is the .jxl resource URL. */
  observe(element: Element, id: string, jxlUrl: string): void {
    if (this.destroyed) return;
    if (this.jobs.size >= this.opts.maxQueuedJobs) {
      this.opts.onError(id, new Error(`Gallery at capacity (maxQueuedJobs=${this.opts.maxQueuedJobs}); image will not be displayed`));
      return;
    }
    if (this.jobs.has(id)) this.unobserve(id);
    const job: ProgressiveImageJob = {
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
    this.candidatesDirty = true;
    this.requestTick();
  }

  unobserve(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
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
    this.candidatesDirty = true;
  }

  select(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    this.clearCleanupTimer(job);
    job.selected = true;
    job.priority = 1;
    job.targetTier = "full";
    job.errorCount = 0;
    job.nextRetryAt = 0;
    this.candidatesDirty = true;
    this.requestTick();
  }

  deselect(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.selected = false;
    job.targetTier = "preview";
    job.errorCount = 0;
    job.nextRetryAt = 0;
    this.recomputePriority(job);
    if (!job.visible && !job.nearViewport) {
      this.scheduleViewportExitCleanup(job);
    }
    this.candidatesDirty = true;
    this.requestTick();
  }

  setTargetTier(id: string, tier: Tier): void {
    const job = this.jobs.get(id);
    if (job) {
      job.targetTier = tier;
      job.errorCount = 0;
      job.nextRetryAt = 0;
      this.requestTick();
    }
  }

  /** Exposed for testing only — returns a copy of the internal job. */
  getJob(id: string): ProgressiveImageJob | undefined {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  destroy(): void {
    if (this.destroyed) return;
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

  private handleIntersection = (entries: IntersectionObserverEntry[]): void => {
    for (const entry of entries) {
      const job = this.byElement.get(entry.target);
      if (!job) continue;
      const fullyVisible =
        entry.isIntersecting && entry.intersectionRatio >= 0.99;
      const partiallyVisible =
        entry.isIntersecting && entry.intersectionRatio >= 0.5;
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
    this.candidatesDirty = true;
    this.requestTick();
  };

  private clearCleanupTimer(job: ProgressiveImageJob): void {
    if (job.cleanupTimer !== null) {
      this.clearTimeoutFn(job.cleanupTimer);
      job.cleanupTimer = null;
    }
  }

  private clearCleanupTimerIfInView(job: ProgressiveImageJob): void {
    if (job.fullyVisible || job.visible || job.nearViewport || job.selected) {
      this.clearCleanupTimer(job);
    }
  }

  private recomputePriority(job: ProgressiveImageJob): void {
    if (job.selected) {
      job.priority = 1;
      return;
    }
    job.priority = job.fullyVisible ? 3 : job.visible ? 4 : job.nearViewport ? 5 : 7;
  }

  private scheduleViewportExitCleanup(job: ProgressiveImageJob): void {
    if (job.cleanupTimer !== null) return;
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

  private requestTick(): void {
    if (this.destroyed || this.tickPending) return;
    this.tickPending = true;
    this.rafHandle = this.raf(() => {
      this.tickPending = false;
      this.rafHandle = null;
      this.tick();
    });
  }

  private armEarliestRetryTimer(now: number): void {
    let earliest: number | null = null;
    for (const j of this.jobs.values()) {
      if (!j.nextRetryAt || j.nextRetryAt <= now) continue;
      const t = j.nextRetryAt;
      if (earliest === null || t < earliest) earliest = t;
    }
    if (earliest === null) {
      if (this.retryTimerId !== null) {
        this.clearTimeoutFn(this.retryTimerId);
        this.retryTimerId = null;
        this.armedRetryAt = null;
      }
      return;
    }
    if (this.armedRetryAt === earliest && this.retryTimerId !== null) return;
    if (this.retryTimerId !== null) {
      this.clearTimeoutFn(this.retryTimerId);
    }
    const delay = Math.max(0, earliest - now);
    this.armedRetryAt = earliest;
    this.retryTimerId = this.setTimeoutFn(() => {
      this.retryTimerId = null;
      this.armedRetryAt = null;
      if (!this.destroyed) this.requestTick();
    }, delay);
  }

  private prefetchManifest(job: ProgressiveImageJob): void {
    if (job.manifest !== null || job.manifestChecked) return;
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
      .catch((e: unknown) => {
        this.opts.onError(job.id, e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        this.inFlightManifestFetches = Math.max(0, this.inFlightManifestFetches - 1);
      });
  }

  private teeFetch(onChunk: (c: Uint8Array) => void): { fetchImpl: typeof fetch; settled: () => Promise<void> } {
    let pump: Promise<void> = Promise.resolve();
    const fetchImpl: typeof fetch = async (input, init) => {
      const resp = await fetch(input, init);
      if (!resp.ok || resp.body === null) return resp;
      const [toDecoder, toCapture] = resp.body.tee();
      pump = (async () => {
        const r = toCapture.getReader();
        try {
          for (;;) {
            const { done, value } = await r.read();
            if (done) break;
            onChunk(value);
          }
        } catch {
          /* abort/network: partial is valid prefix for resume */
        } finally {
          r.cancel().catch(() => {});
        }
      })();
      return new Response(toDecoder, resp);
    };
    return { fetchImpl, settled: () => pump };
  }

  private tick(): void {
    if (this.destroyed) return;
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    this.armEarliestRetryTimer(now);

    // Dirty-flag caches candidate list across RAF ticks. starvationBonus is time-dependent,
    // so always updated; rebuild only on state change (job set, visibility, tiers, abort transitions).
    let candidates: Array<{ job: ProgressiveImageJob; score: number }>;
    if (this.candidatesDirty) {
      candidates = [];
      for (const j of this.jobs.values()) {
        if (!j.visible && !j.nearViewport && !j.selected) continue;
        if (j.decoderAbort !== null) continue;
        if (j.nextRetryAt && now < j.nextRetryAt) continue;
        const curRank = tierRank(j.currentTier);
        const tgtRank = tierRank(j.targetTier);
        if (curRank >= tgtRank) continue;
        candidates.push({ job: j, score: fairnessScore(j, now) });
      }
      candidates.sort((a, b) => b.score - a.score);
      this.cachedCandidates = candidates;
      this.candidatesDirty = false;
    } else {
      // State unchanged: update time-dependent starvationBonus and re-sort in-place.
      for (const c of this.cachedCandidates) {
        c.score = fairnessScore(c.job, now);
      }
      this.cachedCandidates.sort((a, b) => b.score - a.score);
      candidates = this.cachedCandidates;
    }

    for (const { job } of candidates) {
      if (this.activeDecoders >= this.opts.maxActiveDecoders) break;
      this.startDecode(job).catch((e: unknown) => {
        this.opts.onError(job.id, e instanceof Error ? e : new Error(String(e)));
      });
    }
  }

  private async startDecode(job: ProgressiveImageJob): Promise<void> {
    this.activeDecoders++;
    job.nextRetryAt = 0;
    this.clearCleanupTimer(job);
    const abort = new AbortController();
    job.decoderAbort = abort;
    job.lastServedAt =
      typeof performance !== "undefined" ? performance.now() : Date.now();

    let capture: { fetchImpl: typeof fetch; settled: () => Promise<void> } | null = null;
    let capturedBytes = 0;

    try {
      // Load manifest if not already loaded (prefetch may have populated).
      // Capture into a local once — avoids TOCTOU between cache.getManifest,
      // prefetchManifest writes, and the manifestDispatched flag check below.
      let manifest = job.manifest;
      if (manifest === null) {
        manifest = await this.cache.getManifest(job.jxlUrl);
        if (manifest !== null) job.manifest = manifest;
      }
      if (abort.signal.aborted) return;
      if (manifest === null && !job.manifestChecked) {
        manifest = await this.fetchAndCacheManifest(job, abort.signal);
        job.manifest = manifest;
        job.manifestChecked = true;
      }
      if (abort.signal.aborted) return;
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
        if (job.priority > 1) job.priority = Math.max(1, job.priority - 1);
        if (job.targetTier === "preview") job.targetTier = "full";
      }

      const target = nextTier(job.currentTier);
      if (target === null) return;

      const manifestTier =
        manifest !== null ? lookupTier(manifest, target as TierName) : undefined;

      // Fast path from bitmap cache (in-mem ImageBitmap populated by consumer after prior onFrame).
      // If we already have the decoded result for the next tier, claim instantly, notify, skip network+decode.
      // Positive for revisit perf in galleries without re-paying decode cost.
      if (manifestTier) {
        try {
          const bm = await this.cache.getBitmap(job.jxlUrl, target as TierName);
          if (bm) {
            if (abort.signal.aborted) return;
            job.currentTier = target;
            this.opts.onTier(job.id, target);
            // Cache hit: 0 network bytes transferred; report the target so consumers
            // know the tier is complete without simulating a phantom transfer spike.
            this.opts.onProgress(job.id, 0, manifestTier.byteEnd);
            return;
          }
        } catch {
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
      let startingPrefix: Uint8Array | null = null;
      if (job.prefixAccum && job.prefixBytes > 0) {
        startingPrefix = job.prefixAccum.slice(0, job.prefixBytes);
      } else if (job.currentTier !== "none") {
        try {
          const cached = await this.cache.getByteRange(
            job.jxlUrl,
            job.currentTier as "dc" | "preview" | "full",
          );
          if (cached && cached.byteLength > 0) {
            const arr = new Uint8Array(cached);
            job.prefixAccum = arr;
            job.prefixBytes = arr.byteLength;
            startingPrefix = arr;
          }
        } catch {
          // no prefix available
        }
      }

      if (startingPrefix && startingPrefix.byteLength > 0) {
        await session.push(startingPrefix);
      }

      const ft: any = this.testFetchTier ?? fetchTier;
      const ff: any = this.testFetchFull ?? fetchFull;
      const st: any = this.testStreamTierFrames ?? streamTierFrames;
      const fwp = this.testFetchTierWithPrefix ?? fetchTierWithPrefix;

      job.bytesLoaded = job.prefixBytes || 0;
      const byteTarget = manifestTier?.byteEnd;
      this.opts.onProgress(job.id, job.bytesLoaded, byteTarget);

      const onChunk = (c: Uint8Array) => {
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
      let fetchError: unknown;
      const hasPrefix = job.prefixBytes > 0;
      const useWith = manifestTier !== undefined && hasPrefix;

      // build the fetch promise (with optional tee capture)
      let fetchP: Promise<unknown>;
      if (useWith) {
        capture = this.teeFetch(onChunk);
        // pass *length only* (number) to fwp now that it accepts it; no need to concat/ materialise
        // full prefix bytes just for the Range header + CR validation
        const p = (fwp as any)(job.jxlUrl, manifestTier, job.prefixBytes, session, {
          signal: abort.signal,
          fetchImpl: capture.fetchImpl,
        }).catch(async (e: unknown) => {
          if (e instanceof RangeNotSupportedError && !abort.signal.aborted) {
            // delta range not supported by server/proxy; discard any partial accum from this attempt
            // and fall back to full fetch from byte 0 (will rebuild accum via onChunk from scratch).
            // Drain the old capture pump first so the original toCapture branch releases its reader lock
            // before we overwrite `capture` with t2 (prevents orphaned locked ReadableStream branch).
            const oldCapture = capture;
            if (oldCapture) await oldCapture.settled().catch(() => {});
            job.prefixAccum = null;
            job.prefixBytes = 0;
            capturedBytes = 0;
            job.bytesLoaded = 0;
            const t2 = this.teeFetch(onChunk);
            capture = t2;
            return ft(job.jxlUrl, manifestTier, session, {
              signal: abort.signal,
              fetchImpl: t2.fetchImpl,
            }).catch((e2: unknown) => {
              if (!abort.signal.aborted) fetchError = e2;
            });
          }
          fetchError = e;
        });
        fetchP = p;
      } else if (manifestTier !== undefined) {
        capture = this.teeFetch(onChunk);
        fetchP = ft(job.jxlUrl, manifestTier, session, {
          signal: abort.signal,
          fetchImpl: capture.fetchImpl,
        }).catch((e: unknown) => { fetchError = e; });
      } else {
        capture = this.teeFetch(onChunk);
        fetchP = ff(job.jxlUrl, session, {
          signal: abort.signal,
          fetchImpl: capture.fetchImpl,
        }).catch((e: unknown) => { fetchError = e; });
      }

      // C-1 style: await frames first, then the fetchP
      for await (const frame of st(session)) {
        if (abort.signal.aborted) break;
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
          await capture.settled().catch(() => {});
          if (job.prefixAccum && job.prefixBytes > 0) {
            const fullPrefix = job.prefixAccum.subarray(0, job.prefixBytes);
            if (fullPrefix.byteLength > 0) {
              const buffer = fullPrefix.buffer.slice(
                fullPrefix.byteOffset,
                fullPrefix.byteOffset + fullPrefix.byteLength,
              );
              await this.cache.setByteRange(job.jxlUrl, achieved as "dc" | "preview" | "full", buffer as ArrayBuffer);
              // E-5 opt-in
              if (achieved === "full" && this.opts.verifyHash && job.manifest) {
                const ok = await checkHash(job.manifest, fullPrefix);
                if (!ok) {
                  await this.cache.invalidate(job.jxlUrl);
                  job.prefixAccum = null;
                  job.prefixBytes = 0;
                  job.bytesLoaded = 0;
                  this.opts.onError(
                    job.id,
                    new Error("Full tier hash verification failed; cache invalidated"),
                  );
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
    } catch (e) {
      // C-3: inc count, bounded exp backoff or permanent for 404/410; arm timer.
      job.errorCount++;
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (e instanceof HttpError && (e.status === 404 || e.status === 410)) {
        job.nextRetryAt = Infinity;
      } else {
        job.nextRetryAt = now + Math.min(1000 * 2 ** job.errorCount, 30_000);
      }
      this.armEarliestRetryTimer(now);
      if (!abort.signal.aborted) {
        this.opts.onError(
          job.id,
          e instanceof Error ? e : new Error(String(e)),
        );
      }
    } finally {
      job.decoderAbort = null;
      this.activeDecoders = Math.max(0, this.activeDecoders - 1);
      this.candidatesDirty = true;
      this.requestTick();
      // partial prefix left in accum for resume (dropped only on C-2 timer / unobserve / full persist)
    }
  }

  private async fetchAndCacheManifest(
    job: ProgressiveImageJob,
    signal?: AbortSignal,
  ): Promise<ProgressiveManifest | null> {
    const timeoutMs = 10_000;
    const timeoutController = new AbortController();
    const timer = this.setTimeoutFn(() => timeoutController.abort("manifest-timeout"), timeoutMs);
    if (signal) {
      signal.addEventListener("abort", () => timeoutController.abort(signal.reason), { once: true });
    }
    try {
      const resp = await fetch(job.manifestUrl, { signal: timeoutController.signal });
      if (!resp.ok) return null;
      const json: unknown = await resp.json();
      const manifest = validateManifest(json);
      await this.cache.setManifest(job.jxlUrl, manifest);
      return manifest;
    } catch (e) {
      if (signal?.aborted || timeoutController.signal.aborted) return null;
      throw e;
    } finally {
      this.clearTimeoutFn(timer);
    }
  }
}
