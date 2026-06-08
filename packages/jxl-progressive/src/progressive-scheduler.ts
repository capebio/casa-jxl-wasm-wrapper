// packages/jxl-progressive/src/progressive-scheduler.ts

import type { SessionFactory } from "./types.js";
import type { DecodeFrameEvent } from "@casabio/jxl-session";
import {
  validateManifest,
  lookupTier,
  type ProgressiveManifest,
  type TierName,
} from "./progressive-manifest.js";
import { fetchTier, fetchFull, streamTierFrames, createTtffTimer } from "./progressive-stream.js";
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
  /** DC tier size in bytes (from manifest), reported with TTFF for bytesToFirstFrame. */
  dcByteSize?: number;
  /** @internal TTFF start captured before decoder session (via createTtffTimer in stream). */
  ttffStartMs?: number;
  ttffReported?: boolean;
}

export interface GalleryOptions {
  maxActiveDecoders?: number;
  maxConcurrentFetches?: number;
  maxQueuedJobs?: number;
  rootMargin?: string;
  onFrame?: (id: string, frame: DecodeFrameEvent) => void;
  onTier?: (id: string, tier: Tier) => void;
  onError?: (id: string, err: Error) => void;
  /** Callback for Time-To-First-Frame (TTFF) metrics. Fires exactly once per job on first frame emission. */
  onFirstFrame?: (id: string, elapsedMs: number, bytesToFirstFrame: number) => void;
  manifestSuffix?: string;
  autoProfile?: boolean;
  /** Default true: signals that DC tier should be instantly blurred/upscaled at render (plumbed to callers). */
  dcBlurUp?: boolean;
  /** Explicit low-power/data-saver override; if unset, auto-detected from navigator.connection.saveData + battery. */
  lowPowerMode?: boolean;
  /** Injected for testing. Default: globalThis.fetch. Plumbed to manifest fetches and range tier fetches. */
  fetchImpl?: typeof fetch;
  /** Injected for testing. Default: global IntersectionObserver constructor. */
  intersectionObserverFactory?: (
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) => IntersectionObserver;
  /** Injected for testing. Default: globalThis.requestAnimationFrame. */
  rafScheduler?: (fn: FrameRequestCallback) => number;
  /** Injected for testing. Default: globalThis.cancelAnimationFrame. */
  rafCanceller?: (id: number) => void;
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
  private readonly cache: ProgressiveCache;
  private readonly sessionFactory: SessionFactory;
  private readonly observer: IntersectionObserver;
  private readonly raf: (fn: FrameRequestCallback) => number;
  private readonly caf: (id: number) => void;
  private readonly opts: Required<
    Omit<GalleryOptions, "intersectionObserverFactory" | "rafScheduler" | "rafCanceller">
  >;
  private readonly fetchImpl: typeof fetch;
  private lowPowerMode: boolean;
  private readonly preconnected = new Set<string>();
  private activeDecoders = 0;
  private rafHandle: number | null = null;
  private destroyed = false;

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
    this.opts = {
      maxActiveDecoders: opts.maxActiveDecoders ?? 4,
      maxConcurrentFetches: opts.maxConcurrentFetches ?? 3,
      maxQueuedJobs: opts.maxQueuedJobs ?? 50,
      rootMargin: opts.rootMargin ?? "200px",
      onFrame: opts.onFrame ?? (() => {}),
      onTier: opts.onTier ?? (() => {}),
      onError: opts.onError ?? (() => {}),
      onFirstFrame: opts.onFirstFrame ?? (() => {}),
      manifestSuffix: opts.manifestSuffix ?? ".json",
      autoProfile: opts.autoProfile ?? true,
      dcBlurUp: opts.dcBlurUp ?? true,
    };
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.lowPowerMode =
      opts.lowPowerMode !== undefined ? opts.lowPowerMode : this.detectLowPower();
    const ioFactory =
      opts.intersectionObserverFactory ??
      ((cb, ioOpts) => new IntersectionObserver(cb, ioOpts));
    this.observer = ioFactory(this.handleIntersection, {
      rootMargin: this.opts.rootMargin,
      threshold: [0, 0.5, 1.0],
    });
    this.scheduleTick();
  }

  /** Register an image. `jxlUrl` is the .jxl resource URL. */
  observe(element: Element, id: string, jxlUrl: string): void {
    if (this.destroyed) return;
    if (this.jobs.size >= this.opts.maxQueuedJobs) return;
    const job: ProgressiveImageJob = {
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
    this.ensurePreconnect(jxlUrl);
    this.observer.observe(element);
  }

  unobserve(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.decoderAbort?.abort("unobserved");
    this.observer.unobserve(job.element);
    this.jobs.delete(id);
  }

  select(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.selected = true;
    job.priority = 1;
    job.targetTier = "full";
  }

  deselect(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.selected = false;
    job.priority = job.visible ? 3 : 5;
    job.targetTier = "preview";
  }

  setTargetTier(id: string, tier: Tier): void {
    const job = this.jobs.get(id);
    if (job) job.targetTier = tier;
  }

  /** Exposed for testing only — returns a copy of the internal job. */
  getJob(id: string): ProgressiveImageJob | undefined {
    return this.jobs.get(id);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafHandle !== null) {
      try { this.caf(this.rafHandle); } catch {}
      clearTimeout(this.rafHandle as any);
    }
    this.observer.disconnect();
    for (const job of this.jobs.values()) {
      job.decoderAbort?.abort("destroyed");
    }
    this.jobs.clear();
  }

  private detectLowPower(): boolean {
    if (typeof navigator === "undefined") return false;
    const nav: any = navigator;
    if (nav.connection?.saveData) return true;
    // Battery check async; set flag later if low.
    if (typeof nav.getBattery === "function") {
      nav
        .getBattery()
        .then((bat: any) => {
          if (bat && (bat.level <= 0.2 || (!bat.charging && bat.level <= 0.5))) {
            this.lowPowerMode = true;
          }
        })
        .catch(() => {});
    }
    return false;
  }

  private ensurePreconnect(url: string): void {
    if (typeof document === "undefined") return;
    try {
      const origin = new URL(url).origin;
      if (this.preconnected.has(origin)) return;
      this.preconnected.add(origin);
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = origin;
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    } catch {}
  }

  private getEffectiveTarget(job: ProgressiveImageJob): Tier {
    if (this.lowPowerMode && !job.selected) {
      return tierRank(job.targetTier) > tierRank("dc") ? "dc" : job.targetTier;
    }
    return job.targetTier;
  }

  private handleIntersection = (entries: IntersectionObserverEntry[]): void => {
    for (const entry of entries) {
      for (const job of this.jobs.values()) {
        if (job.element !== entry.target) continue;
        const fullyVisible =
          entry.isIntersecting && entry.intersectionRatio >= 1.0;
        const partiallyVisible =
          entry.isIntersecting && entry.intersectionRatio >= 0.5;
        job.visible = partiallyVisible;
        job.nearViewport = entry.isIntersecting;

        if (job.selected) {
          // Selected jobs keep priority 1 regardless.
        } else if (fullyVisible) {
          job.priority = 3;
        } else if (partiallyVisible) {
          job.priority = 4;
        } else if (job.nearViewport) {
          job.priority = 5;
        } else {
          job.priority = 7;
          this.scheduleViewportExitCleanup(job);
        }
        break;
      }
    }
  };

  private scheduleViewportExitCleanup(job: ProgressiveImageJob): void {
    const graceMs = 2000;
    setTimeout(() => {
      if (!job.visible && !job.selected && job.decoderAbort !== null) {
        job.decoderAbort.abort("left-viewport");
        job.decoderAbort = null;
        this.activeDecoders = Math.max(0, this.activeDecoders - 1);
      }
    }, graceMs);
  }

  private scheduleTick(): void {
    if (this.destroyed) return;
    this.rafHandle = this.raf(() => {
      this.tick();
      this.scheduleTick();
    });
  }

  private tick(): void {
    if (this.destroyed) return;
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const candidates = [...this.jobs.values()]
      .filter((j) => j.visible || j.nearViewport || j.selected)
      .filter((j) => tierRank(j.currentTier) < tierRank(this.getEffectiveTarget(j)))
      .filter((j) => j.decoderAbort === null)
      .sort((a, b) => fairnessScore(b, now) - fairnessScore(a, now));

    const maxActive = this.lowPowerMode
      ? Math.min(1, this.opts.maxActiveDecoders)
      : this.opts.maxActiveDecoders;
    for (const job of candidates) {
      if (this.activeDecoders >= maxActive) break;
      void this.startDecode(job);
    }
  }

  private async startDecode(job: ProgressiveImageJob): Promise<void> {
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

      if (job.manifest && job.dcByteSize == null) {
        const dcTier = lookupTier(job.manifest, "dc" as TierName);
        if (dcTier) job.dcByteSize = dcTier.byteEnd;
      }

      const target = nextTier(job.currentTier);
      if (target === null) return;

      const manifestTier =
        job.manifest !== null ? lookupTier(job.manifest, target as TierName) : undefined;

      // Capture TTFF timer immediately before opening decoder session (per Phase 1).
      const ttff = createTtffTimer();
      job.ttffStartMs = ttff.start;

      const session = this.sessionFactory();

      const fetchOpts: any = { signal: abort.signal, fetchImpl: this.fetchImpl };
      const isFirstTierForJob = job.currentTier === "none";
      const isHighPrio = job.visible || job.selected || job.priority <= 3;
      fetchOpts.priority = isFirstTierForJob && isHighPrio ? "high" : "low";

      if (manifestTier !== undefined) {
        void fetchTier(job.jxlUrl, manifestTier, session, fetchOpts);
      } else {
        void fetchFull(job.jxlUrl, session, fetchOpts);
      }

      for await (const frame of streamTierFrames(session)) {
        if (abort.signal.aborted) break;
        if (!job.ttffReported && job.ttffStartMs != null) {
          const elapsed = ttff.getElapsed();
          const bytes = job.dcByteSize ?? manifestTier?.byteEnd ?? 0;
          this.opts.onFirstFrame(job.id, elapsed, bytes);
          job.ttffReported = true;
        }
        this.opts.onFrame(job.id, frame);
      }

      if (!abort.signal.aborted) {
        job.currentTier = target;
        this.opts.onTier(job.id, target);
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        this.opts.onError(
          job.id,
          e instanceof Error ? e : new Error(String(e)),
        );
      }
    } finally {
      job.decoderAbort = null;
      this.activeDecoders = Math.max(0, this.activeDecoders - 1);
    }
  }

  private async fetchAndCacheManifest(
    job: ProgressiveImageJob,
  ): Promise<ProgressiveManifest | null> {
    try {
      const resp = await this.fetchImpl(job.manifestUrl);
      if (!resp.ok) return null;
      const json: unknown = await resp.json();
      const manifest = validateManifest(json);
      await this.cache.setManifest(job.jxlUrl, manifest);
      return manifest;
    } catch {
      return null;
    }
  }
}
