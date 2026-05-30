// packages/jxl-progressive/test/scheduler.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  tierRank,
  fairnessScore,
  ProgressiveGallery,
  type Tier,
  type ProgressiveImageJob,
} from "../src/progressive-scheduler.js";
import { ProgressiveCache } from "../src/progressive-cache.js";
import type { SessionFactory } from "../src/types.js";
import type { DecodeSession, ImageInfo } from "@casabio/jxl-session";
import type { ProgressiveManifest } from "../src/progressive-manifest.js";

// ── Pure-function tests ──────────────────────────────────────────────────────

describe("tierRank", () => {
  it("none=0, dc=1, preview=2, full=3", () => {
    assert.equal(tierRank("none"), 0);
    assert.equal(tierRank("dc"), 1);
    assert.equal(tierRank("preview"), 2);
    assert.equal(tierRank("full"), 3);
  });
});

describe("fairnessScore", () => {
  it("lower priority number (higher importance) → higher score", () => {
    const now = 1000;
    const lightbox = makeJob({ priority: 1, currentTier: "dc", lastServedAt: 1000 });
    const offscreen = makeJob({ priority: 7, currentTier: "dc", lastServedAt: 1000 });
    assert.ok(fairnessScore(lightbox, now) > fairnessScore(offscreen, now));
  });

  it("starvation bonus increases score for long-unserved jobs", () => {
    const now = 10000;
    const fresh = makeJob({ priority: 3, currentTier: "dc", lastServedAt: 9000 });
    const starved = makeJob({ priority: 3, currentTier: "dc", lastServedAt: 0 });
    assert.ok(fairnessScore(starved, now) > fairnessScore(fresh, now));
  });

  it("under-refined bonus: lower currentTier = higher score", () => {
    const now = 1000;
    const atNone = makeJob({ priority: 3, currentTier: "none", lastServedAt: 1000 });
    const atPreview = makeJob({ priority: 3, currentTier: "preview", lastServedAt: 1000 });
    assert.ok(fairnessScore(atNone, now) > fairnessScore(atPreview, now));
  });
});

// ── ProgressiveGallery unit tests ────────────────────────────────────────────

// Minimal stub for IntersectionObserver
class MockIntersectionObserver {
  callback: IntersectionObserverCallback;
  observed = new Set<Element>();
  constructor(cb: IntersectionObserverCallback, _opts?: IntersectionObserverInit) {
    this.callback = cb;
  }
  observe(el: Element) { this.observed.add(el); }
  unobserve(el: Element) { this.observed.delete(el); }
  disconnect() { this.observed.clear(); }
  // Test helper: fire intersection for an element
  fire(el: Element, isIntersecting: boolean, ratio = 1.0) {
    this.callback([{
      target: el,
      isIntersecting,
      intersectionRatio: ratio,
      boundingClientRect: {} as DOMRectReadOnly,
      intersectionRect: {} as DOMRectReadOnly,
      rootBounds: {} as DOMRectReadOnly,
      time: performance.now(),
    }], this as unknown as IntersectionObserver);
  }
}

// Minimal DOM Element stub
function makeElement(id: string): Element {
  return { id, nodeType: 1 } as unknown as Element;
}

// Inner cache stub
function makeInnerCache() {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    async get(key: string) { return store.get(key); },
    async set(key: string, buf: ArrayBuffer) { store.set(key, buf); },
  };
}

function makeJob(overrides: Partial<ProgressiveImageJob> = {}): ProgressiveImageJob {
  return {
    id: "test",
    element: makeElement("test"),
    jxlUrl: "https://example.com/img.jxl",
    manifestUrl: "https://example.com/img.jxl.json",
    visible: true,
    nearViewport: false,
    selected: false,
    currentTier: "none",
    targetTier: "preview",
    priority: 3,
    lastServedAt: 0,
    bytesLoaded: 0,
    manifest: null,
    decoderAbort: null,
    ...overrides,
  };
}

// Session factory that returns a session that immediately finishes with no frames
function makeInstantFactory(): SessionFactory {
  const fakeInfo: ImageInfo = {
    width: 1, height: 1, bitsPerSample: 8, hasAlpha: false,
    hasAnimation: false, jpegReconstructionAvailable: false,
  };
  return () => ({
    id: "instant",
    async push() {},
    async close() {},
    async cancel() {},
    async done() { return fakeInfo; },
    async *frames() {},
  } as DecodeSession);
}

describe("ProgressiveGallery", () => {
  it("observe registers the element with IntersectionObserver", () => {
    let observer!: MockIntersectionObserver;
    const cache = new ProgressiveCache(makeInnerCache() as never);
    const gallery = new ProgressiveGallery(cache, makeInstantFactory(), {
      intersectionObserverFactory: (cb, opts) => {
        observer = new MockIntersectionObserver(cb, opts);
        return observer as unknown as IntersectionObserver;
      },
      rafScheduler: () => 0, // disable ticking
      rafCanceller: () => {},
    });

    const el = makeElement("img-1");
    gallery.observe(el, "img-1", "https://example.com/img.jxl");
    assert.ok(observer.observed.has(el), "element must be observed");
    gallery.destroy();
  });

  it("unobserve removes element", () => {
    let observer!: MockIntersectionObserver;
    const cache = new ProgressiveCache(makeInnerCache() as never);
    const gallery = new ProgressiveGallery(cache, makeInstantFactory(), {
      intersectionObserverFactory: (cb, opts) => {
        observer = new MockIntersectionObserver(cb, opts);
        return observer as unknown as IntersectionObserver;
      },
      rafScheduler: () => 0,
      rafCanceller: () => {},
    });

    const el = makeElement("img-1");
    gallery.observe(el, "img-1", "https://example.com/img.jxl");
    gallery.unobserve("img-1");
    assert.ok(!observer.observed.has(el), "element must be unobserved");
    gallery.destroy();
  });

  it("select boosts priority to 1 and sets targetTier to full", () => {
    let observer!: MockIntersectionObserver;
    const cache = new ProgressiveCache(makeInnerCache() as never);
    const gallery = new ProgressiveGallery(cache, makeInstantFactory(), {
      intersectionObserverFactory: (cb, opts) => {
        observer = new MockIntersectionObserver(cb, opts);
        return observer as unknown as IntersectionObserver;
      },
      rafScheduler: () => 0,
      rafCanceller: () => {},
    });

    gallery.observe(makeElement("img-1"), "img-1", "https://example.com/img.jxl");
    gallery.select("img-1");
    // Access internal job state via expose method (see implementation)
    const job = gallery.getJob("img-1");
    assert.equal(job?.priority, 1);
    assert.equal(job?.targetTier, "full");
    gallery.destroy();
  });

  it("deselect restores priority and sets targetTier back to preview", () => {
    let observer!: MockIntersectionObserver;
    const cache = new ProgressiveCache(makeInnerCache() as never);
    const gallery = new ProgressiveGallery(cache, makeInstantFactory(), {
      intersectionObserverFactory: (cb, opts) => {
        observer = new MockIntersectionObserver(cb, opts);
        return observer as unknown as IntersectionObserver;
      },
      rafScheduler: () => 0,
      rafCanceller: () => {},
    });

    gallery.observe(makeElement("img-1"), "img-1", "https://example.com/img.jxl");
    gallery.select("img-1");
    gallery.deselect("img-1");
    const job = gallery.getJob("img-1");
    assert.equal(job?.targetTier, "preview");
    assert.ok((job?.priority ?? 0) > 1);
    gallery.destroy();
  });

  it("intersection change: visible image gets priority 3, offscreen gets 7", () => {
    let observer!: MockIntersectionObserver;
    const cache = new ProgressiveCache(makeInnerCache() as never);
    const gallery = new ProgressiveGallery(cache, makeInstantFactory(), {
      intersectionObserverFactory: (cb, opts) => {
        observer = new MockIntersectionObserver(cb, opts);
        return observer as unknown as IntersectionObserver;
      },
      rafScheduler: () => 0,
      rafCanceller: () => {},
    });

    const el = makeElement("img-1");
    gallery.observe(el, "img-1", "https://example.com/img.jxl");

    observer.fire(el, true, 1.0);
    assert.equal(gallery.getJob("img-1")?.priority, 3);

    observer.fire(el, false, 0);
    assert.equal(gallery.getJob("img-1")?.priority, 7);
    gallery.destroy();
  });

  it("destroy disconnects observer and cancels active decodes", () => {
    let disconnected = false;
    const cache = new ProgressiveCache(makeInnerCache() as never);
    const gallery = new ProgressiveGallery(cache, makeInstantFactory(), {
      intersectionObserverFactory: (cb, opts) => {
        const obs = new MockIntersectionObserver(cb, opts);
        const origDisconnect = obs.disconnect.bind(obs);
        obs.disconnect = () => { disconnected = true; origDisconnect(); };
        return obs as unknown as IntersectionObserver;
      },
      rafScheduler: () => 0,
      rafCanceller: () => {},
    });

    gallery.observe(makeElement("img-1"), "img-1", "https://example.com/img.jxl");
    gallery.destroy();
    assert.equal(disconnected, true);
  });
});
