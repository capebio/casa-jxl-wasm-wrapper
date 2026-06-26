# Perceptual + Scale-Aware Progressive Manifest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the progressive manifest store a measured perceptual score per tier and a display-scale → earliest-sufficient-tier frontier, then let the live gallery cap decode bytes to the tier appropriate for an element's on-screen size.

**Architecture:** Extends the existing, dormant `@casabio/jxl-progressive` package. The offline profiler (`profileJxl`) already drives a throwaway decode and records progression events; we add (1) per-pass pixel capture + a pluggable metric scorer (SSIM/PSNR pure-JS default, Butteraugli opt-in via the wasm facade), so tier cutoffs become perceptually-driven, and (2) a scale frontier computed by downscaling each captured pass + the final to candidate display sizes and re-scoring. The live gallery consumes the manifest at the push/decode-decision boundary (`web/jxl-progressive-gallery.js`) — never in the coordinator — capping bytes fed to the decoder. Metric and downscaler are injected so package logic is unit-testable with zero WASM rebuild.

**Tech Stack:** TypeScript (package, vitest), pure-JS metric/downscale kernels for tests, `@casabio/jxl-wasm` facade (`computeButteraugli`, `ButteraugliComparator`, `downscale_rgba`) for the production scorers/downscaler, existing `fetchTier` HTTP-Range path for remote assets.

---

## Why this is an extension, not a new build (read first)

Already built and tested in `packages/jxl-progressive/`:
- `ProgressiveManifest` schema + `validateManifest`/`migrateManifest`/`checkHash` (sha256 staleness bind) — `src/progressive-manifest.ts`.
- `profileJxl`/`profileJxlFile` — drives a throwaway decode, records `{byteOffset, stage, progressionIndex}` per pass, writes `${path}.json` sidecar — `src/progressive-profile.ts`.
- `fetchTier`/`fetchTierWithPrefix` — `Range: bytes=0-{byteEnd-1}` prefix + delta fetch, 206/Content-Range validated — `src/progressive-stream.ts`.

Two gaps this plan closes:
- **Gap A — cutoffs are structural, not perceptual.** `selectTiers()` picks byteEnds by hardcoded fractions (dc `<25%`, preview `<70%`) — `progressive-profile.ts:81-121`. No score is stored. The perceptual measurement exists only offline in the byte-benchmark, never fed back. (Reviving a real sidecar quality score was explicitly deferred awaiting a "real metric runner" — `docs/rejected optimizations.md` F-1, line 117.)
- **Gap B — not scale-aware.** One flat tier list keyed on native `source.width/height`. No display-scale frontier; thumbnails over-decode.

## Invariant guardrails (do not violate — each has a prior rejection)

- **byteEnd comes only from real progression events**, never a guessed byte count. Guessing byte thresholds emits corrupt offsets → truncated thumbnail fetches (`docs/rejected optimizations.md` line 51). The profiler already derives byteEnd from decode events; keep it that way.
- **No manifest/tier state in `jxl-progressive-gallery-coordinator.js`** — rejected G5-C1 (line 176): "session protocol must not leak" into the post-arrival sync counter. Tier selection lives at the gallery push boundary (`gallery.js:~698-704`) and in the package, not the coordinator.
- **No per-pass full-frame copy on the live hot decode path.** Per-pass pixel capture happens in the **offline profiler only** (run once at encode/ingest). The live gallery only *caps byte count* fed to the decoder — it never snapshots passes (line 274 warns about hot-path copies).
- **CLAUDE.md layer invariants:** no pixel pool, no drain callback in facade, no batching in session/facade, no cache dedup by sourceKey, no soft preemption, no per-stage budget reset. Byte-capping at the gallery is upstream of the decoder (feed fewer bytes) — it is not a budget/backpressure change.
- **Additive schema only.** New fields are optional; `version` stays `1`. Absent fields → today's behavior exactly (full file, structural tiers).

## Serving model (SSIM eager, Butteraugli lazy, edge-enforced)

Decided with the user:
- **SSIM eager:** the generator scores every asset with the SSIM scorer at ingest → writes `<file>.jxl.json` (single-metric manifest). Cheap, runs for all images.
- **Butteraugli lazy:** computed on the **first premium request** for an asset and cached as `<file>.jxl.butteraugli.json`, keyed by `jxl.sha256`. Avoids paying Butteraugli's heavier cost for assets no premium user ever opens.
- **Single metric per manifest (two sidecars), not a multi-metric map.** Because Butteraugli is lazy, each manifest stays single-metric — the Phase 1-2 schema (`TierScore` with one `metric`, one `scaleFrontier`) is sufficient as-is. The consumer/edge chooses *which sidecar* to read by user tier; it never needs both inside one file.
- **Edge-enforced + client hint:** the client issues a `Range` request for its display tier (perf hint, bypassable). The **edge worker is authoritative** — it picks the metric+ceiling from the user's tier (auth), recomputes the allowed `byteEnd`, and Range-truncates the origin response. A free user physically cannot pull premium bytes. **Security: any premium gate MUST live at the edge/server; a client-only cutoff is advisory.**

```
ingest ──► profileJxlFile(ssim) ──► <id>.jxl.json            (eager, all assets)
premium request ─► edge ─► getOrBuildManifest(id,"butteraugli")
                              │ miss → profileJxlFile(butteraugli) → cache <id>.jxl.butteraugli.json
                              ▼
client hint: Range 0..displayTier ─► EDGE resolves authoritative byteEnd (policy×display) ─► origin Range 0..byteEnd ─► stream
```

## File structure

| File | Create/Modify | Responsibility |
|------|---------------|----------------|
| `packages/jxl-progressive/src/progressive-metrics.ts` | Create | Pure-JS PSNR + single-window SSIM vs a reference frame; `meetsThreshold(metric, value, threshold)` direction helper; `MetricScorer` type. Self-contained (no wasm). |
| `packages/jxl-progressive/src/progressive-manifest.ts` | Modify | Add optional `TierScore` on `ManifestTier`, optional `scaleFrontier` on `ProgressiveManifest`; validate both. |
| `packages/jxl-progressive/src/progressive-profile.ts` | Modify | Capture `frame.pixels` per pass; score each candidate vs final via injected `MetricScorer`; `selectTiersByScore`; build `scaleFrontier` via injected `Downscaler`. |
| `packages/jxl-progressive/src/progressive-scale.ts` | Create | `selectTierForDisplay(manifest, elemW, elemH, dpr)` and `selectFrontierTier(manifest, displayPx)` — pure selection logic. |
| `packages/jxl-progressive/src/progressive-adapters.ts` | Create | Production `butteraugliScorer` (wraps facade `computeButteraugli`/`ButteraugliComparator`) and `wasmDownscaler` (wraps `downscale_rgba`). Imported only by callers that have wasm; never by the pure logic or its tests. |
| `packages/jxl-progressive/src/index.ts` | Modify | Re-export new public surface. |
| `web/jxl-progressive-gallery.js` | Modify | At the push boundary, look up tier for display size and cap `buildPushBatches` to `byteEnd`. Optional manifest provider; absent → full (no change). |
| `packages/jxl-progressive/src/progressive-service.ts` | Create | `getOrBuildManifest(deps, {sha256, metric})` — cache-or-build (lazy Butteraugli). Pure orchestration; profiling + cache I/O injected. |
| `packages/jxl-progressive/src/progressive-edge.ts` | Create | `resolveTierRequest(deps, req)` — authoritative edge decision: policy(userTier)→{metric, maxTier}, load manifest via service, `selectFrontierTier` by display hint, clamp to ceiling → `{rangeEnd, metric, tier}`. |
| `packages/jxl-progressive/test/*.test.ts` | Create | Unit tests per task. |

---

## Phase 1 — Perceptual-scored tiers (Gap A)

### Task 1: Metric kernels + threshold direction

**Files:**
- Create: `packages/jxl-progressive/src/progressive-metrics.ts`
- Test: `packages/jxl-progressive/test/progressive-metrics.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/jxl-progressive/test/progressive-metrics.test.ts
import { describe, it, expect } from "vitest";
import { psnrVsRef, ssimVsRef, meetsThreshold, type MetricName } from "../src/progressive-metrics.js";

function solid(w: number, h: number, r: number, g: number, b: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i*4]=r; px[i*4+1]=g; px[i*4+2]=b; px[i*4+3]=255; }
  return px;
}

describe("progressive-metrics", () => {
  it("psnr is +Infinity for identical buffers", () => {
    const a = solid(8, 8, 100, 150, 200);
    expect(psnrVsRef(a, a)).toBe(Infinity);
  });

  it("psnr decreases as error grows", () => {
    const ref = solid(8, 8, 100, 100, 100);
    const near = solid(8, 8, 102, 100, 100);
    const far = solid(8, 8, 140, 100, 100);
    expect(psnrVsRef(near, ref)).toBeGreaterThan(psnrVsRef(far, ref));
  });

  it("ssim is 1 for identical buffers", () => {
    const a = solid(8, 8, 100, 150, 200);
    expect(ssimVsRef(a, a, 8, 8)).toBeCloseTo(1, 5);
  });

  it("meetsThreshold uses higher-is-better for ssim/psnr, lower-is-better for butteraugli", () => {
    expect(meetsThreshold("psnr", 35, 30)).toBe(true);
    expect(meetsThreshold("psnr", 25, 30)).toBe(false);
    expect(meetsThreshold("ssim", 0.9, 0.85)).toBe(true);
    expect(meetsThreshold("butteraugli", 0.8, 1.0)).toBe(true);   // lower is better
    expect(meetsThreshold("butteraugli", 1.5, 1.0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jxl-progressive && npx vitest run test/progressive-metrics.test.ts`
Expected: FAIL — cannot find module `../src/progressive-metrics.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/jxl-progressive/src/progressive-metrics.ts
export type MetricName = "ssim" | "psnr" | "butteraugli";

/** A scorer compares a candidate RGBA8 frame against a reference RGBA8 frame
 *  of the same dimensions and returns a scalar. Async to allow wasm-backed scorers. */
export type MetricScorer = {
  metric: MetricName;
  score: (candidate: Uint8Array, reference: Uint8Array, w: number, h: number) => Promise<number>;
};

/** PSNR in dB of `candidate` vs `reference` (RGBA8, alpha ignored). Higher is better. */
export function psnrVsRef(candidate: Uint8Array, reference: Uint8Array): number {
  const n = Math.min(candidate.length, reference.length);
  let sumSq = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 3) === 3) continue; // skip alpha
    const d = candidate[i]! - reference[i]!;
    sumSq += d * d;
    count++;
  }
  if (count === 0 || sumSq === 0) return Infinity;
  const mse = sumSq / count;
  return 10 * Math.log10((255 * 255) / mse);
}

/** Single-window global SSIM on luma of `candidate` vs `reference`. Higher is better (max 1). */
export function ssimVsRef(candidate: Uint8Array, reference: Uint8Array, w: number, h: number): number {
  const n = w * h;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let muX = 0, muY = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const lx = 0.299 * candidate[i]! + 0.587 * candidate[i+1]! + 0.114 * candidate[i+2]!;
    const ly = 0.299 * reference[i]! + 0.587 * reference[i+1]! + 0.114 * reference[i+2]!;
    muX += lx; muY += ly;
  }
  muX /= n; muY /= n;
  let vX = 0, vY = 0, cov = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const lx = 0.299 * candidate[i]! + 0.587 * candidate[i+1]! + 0.114 * candidate[i+2]!;
    const ly = 0.299 * reference[i]! + 0.587 * reference[i+1]! + 0.114 * reference[i+2]!;
    vX += (lx - muX) ** 2; vY += (ly - muY) ** 2; cov += (lx - muX) * (ly - muY);
  }
  vX /= n - 1 || 1; vY /= n - 1 || 1; cov /= n - 1 || 1;
  return ((2 * muX * muY + C1) * (2 * cov + C2)) /
         ((muX * muX + muY * muY + C1) * (vX + vY + C2));
}

/** True when `value` is "good enough" for `metric` at `threshold`.
 *  ssim/psnr: higher is better. butteraugli: lower is better. */
export function meetsThreshold(metric: MetricName, value: number, threshold: number): boolean {
  if (metric === "butteraugli") return value <= threshold;
  return value >= threshold;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jxl-progressive && npx vitest run test/progressive-metrics.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-progressive/src/progressive-metrics.ts packages/jxl-progressive/test/progressive-metrics.test.ts
git commit -m "feat(jxl-progressive): perceptual metric kernels (psnr/ssim/threshold)"
```

---

### Task 2: Optional `TierScore` on the manifest schema

**Files:**
- Modify: `packages/jxl-progressive/src/progressive-manifest.ts`
- Test: `packages/jxl-progressive/test/manifest-score.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/jxl-progressive/test/manifest-score.test.ts
import { describe, it, expect } from "vitest";
import { validateManifest, type ProgressiveManifest } from "../src/progressive-manifest.js";

function baseManifest(): ProgressiveManifest {
  return {
    version: 1,
    source: { width: 100, height: 100, hasAlpha: false, orientation: 1 },
    jxl: { bytes: 1000, sha256: "a".repeat(64) },
    encoder: { name: "test", libjxlVersion: "0.12", flags: [] },
    tiers: [
      { name: "dc", byteStart: 0, byteEnd: 200, progressionIndex: 0, intendedUse: "thumbnail" },
      { name: "full", byteStart: 0, byteEnd: 1000, progressionIndex: "final", intendedUse: "zoom-export" },
    ],
  };
}

describe("manifest tier score", () => {
  it("accepts a tier with a valid score", () => {
    const m = baseManifest();
    (m.tiers[0] as any).score = { metric: "psnr", value: 28.5, reference: "final" };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("rejects an unknown score metric", () => {
    const m = baseManifest();
    (m.tiers[0] as any).score = { metric: "vmaf", value: 90, reference: "final" };
    expect(() => validateManifest(m)).toThrow(/score.metric/);
  });

  it("rejects a non-finite score value", () => {
    const m = baseManifest();
    (m.tiers[0] as any).score = { metric: "ssim", value: NaN, reference: "final" };
    expect(() => validateManifest(m)).toThrow(/score.value/);
  });

  it("still accepts a tier with no score (backward compat)", () => {
    expect(() => validateManifest(baseManifest())).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jxl-progressive && npx vitest run test/manifest-score.test.ts`
Expected: FAIL — unknown metric `vmaf` does not throw (validation not present yet).

- [ ] **Step 3: Write minimal implementation**

In `progressive-manifest.ts`, add the type near `ManifestTier`:

```ts
export type ScoreMetric = "ssim" | "psnr" | "butteraugli";

export interface TierScore {
  metric: ScoreMetric;
  /** Metric value of this tier's partial reconstruction vs the reference. */
  value: number;
  /** What the score compares against: the file's own final frame, or the encoder source. */
  reference: "final" | "source";
}

export interface ManifestTier {
  name: TierName;
  byteStart: number;
  byteEnd: number;
  progressionIndex: number | "final";
  intendedUse: string;
  /** Optional measured perceptual score for this tier (Phase A). */
  score?: TierScore;
}
```

Add a `VALID_SCORE_METRICS` set near `VALID_TIER_NAMES`:

```ts
const VALID_SCORE_METRICS = new Set<string>(["ssim", "psnr", "butteraugli"]);
```

Inside the per-tier loop in `validateManifest`, after the `intendedUse` assertion, add:

```ts
    if (t["score"] !== undefined) {
      assertField(typeof t["score"] === "object" && t["score"] !== null, `${f}.score`, `${f}.score must be an object if present`);
      const sc = t["score"] as Record<string, unknown>;
      assertField(VALID_SCORE_METRICS.has(sc["metric"] as string), `${f}.score.metric`, `${f}.score.metric must be ssim|psnr|butteraugli`);
      assertField(typeof sc["value"] === "number" && Number.isFinite(sc["value"] as number), `${f}.score.value`, `${f}.score.value must be a finite number`);
      assertField(sc["reference"] === "final" || sc["reference"] === "source", `${f}.score.reference`, `${f}.score.reference must be "final" or "source"`);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jxl-progressive && npx vitest run test/manifest-score.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-progressive/src/progressive-manifest.ts packages/jxl-progressive/test/manifest-score.test.ts
git commit -m "feat(jxl-progressive): optional per-tier perceptual score in schema"
```

---

### Task 3: Capture per-pass pixels + score tiers in the profiler

**Files:**
- Modify: `packages/jxl-progressive/src/progressive-profile.ts`
- Test: `packages/jxl-progressive/test/profile-score.test.ts`

The existing `framesTask` records only `{byteOffset, stage, progressionIndex}`. Add a parallel capture of the last `pixels` seen at each byte offset, plus the final pixels, then score each emitted tier's candidate pixels vs final using an injected `MetricScorer`. No scorer → no scores (today's behavior).

- [ ] **Step 1: Write the failing test**

```ts
// packages/jxl-progressive/test/profile-score.test.ts
import { describe, it, expect } from "vitest";
import { profileJxl } from "../src/progressive-profile.js";
import type { MetricScorer } from "../src/progressive-metrics.js";

// Fake DecodeSession: emits a "dc" pass at 1/4, a "pass" at 3/4, "final" at end.
function makeFakeSessionFactory(passPixels: Record<string, Uint8Array>) {
  return () => {
    let closed = false;
    const frameQueue: Array<{ stage: string; pixels: Uint8Array }> = [];
    let pushedBytes = 0;
    const total = 800;
    return {
      async push(chunk: ArrayBuffer) {
        pushedBytes += chunk.byteLength;
        if (pushedBytes >= total * 0.25 && !frameQueue.find(f => f.stage === "dc")) frameQueue.push({ stage: "dc", pixels: passPixels.dc! });
        if (pushedBytes >= total * 0.75 && !frameQueue.find(f => f.stage === "pass")) frameQueue.push({ stage: "pass", pixels: passPixels.preview! });
      },
      async close() { frameQueue.push({ stage: "final", pixels: passPixels.final! }); closed = true; },
      async cancel() { closed = true; },
      async *frames() { while (!closed || frameQueue.length) { if (frameQueue.length) yield frameQueue.shift()!; else await new Promise(r => setTimeout(r, 0)); } },
    } as any;
  };
}

describe("profileJxl scoring", () => {
  it("attaches a psnr score to each non-final tier when a scorer is given", async () => {
    const w = 4, h = 4;
    const solid = (v: number) => { const p = new Uint8Array(w*h*4); for (let i=0;i<w*h;i++){p[i*4]=v;p[i*4+1]=v;p[i*4+2]=v;p[i*4+3]=255;} return p; };
    const passPixels = { dc: solid(40), preview: solid(120), final: solid(128) };
    const scorer: MetricScorer = {
      metric: "psnr",
      score: async (cand, ref) => { const { psnrVsRef } = await import("../src/progressive-metrics.js"); return psnrVsRef(cand, ref); },
    };
    const bytes = new ArrayBuffer(800);
    const m = await profileJxl(bytes, makeFakeSessionFactory(passPixels), { width: w, height: h, hasAlpha: false }, { scorer, chunkSize: 100 });
    const dc = m.tiers.find(t => t.name === "dc")!;
    expect(dc.score?.metric).toBe("psnr");
    expect(dc.score?.reference).toBe("final");
    expect(Number.isFinite(dc.score!.value)).toBe(true);
  });

  it("omits scores when no scorer is provided (backward compat)", async () => {
    const w = 4, h = 4;
    const solid = (v: number) => { const p = new Uint8Array(w*h*4); for (let i=0;i<w*h;i++){p[i*4]=v;p[i*4+3]=255;} return p; };
    const passPixels = { dc: solid(40), preview: solid(120), final: solid(128) };
    const m = await profileJxl(new ArrayBuffer(800), makeFakeSessionFactory(passPixels), { width: w, height: h, hasAlpha: false }, { chunkSize: 100 });
    expect(m.tiers.every(t => t.score === undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jxl-progressive && npx vitest run test/profile-score.test.ts`
Expected: FAIL — `opts.scorer` ignored; `dc.score` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `progressive-profile.ts`:

Add to imports:

```ts
import type { MetricScorer } from "./progressive-metrics.js";
```

Extend `ProfileOptions`:

```ts
  /** When set, each non-final tier gets a perceptual score (partial pass vs final frame). */
  scorer?: MetricScorer;
  /** Display dimensions passed to the scorer (defaults to source dims). */
}
```

Change the captured event shape and `framesTask` to also retain pixels per offset:

```ts
interface ProgressionEvent {
  byteOffset: number;
  stage: string;
  progressionIndex: number;
  pixels?: Uint8Array;   // last decoded pixels at this offset (for scoring)
}
```

In the `framesTask` loop, capture pixels:

```ts
  const framesTask = (async () => {
    for await (const frame of session.frames()) {
      const px = (frame as { pixels?: ArrayBuffer | Uint8Array }).pixels;
      events.push({
        byteOffset: bytesPushed,
        stage: frame.stage,
        progressionIndex: progressionIdx++,
        pixels: px === undefined ? undefined : (px instanceof Uint8Array ? new Uint8Array(px) : new Uint8Array(px)),
      });
    }
  })();
```

After `const manifest = {...}` is built (before the `saliency` block / `return`), add scoring:

```ts
  if (opts.scorer !== undefined) {
    const finalEvent = [...events].reverse().find((e) => e.pixels !== undefined && e.pixels.length > 0);
    if (finalEvent?.pixels !== undefined) {
      const w = source.width, h = source.height;
      for (const tier of manifest.tiers) {
        if (tier.name === "full" || tier.progressionIndex === "final") continue;
        // Candidate = last captured pixels at or before this tier's byteEnd.
        let cand: Uint8Array | undefined;
        for (const e of events) {
          if (e.byteOffset <= tier.byteEnd && e.pixels !== undefined && e.pixels.length > 0) cand = e.pixels;
        }
        if (cand !== undefined && cand.length === finalEvent.pixels.length) {
          const value = await opts.scorer.score(cand, finalEvent.pixels, w, h);
          tier.score = { metric: opts.scorer.metric, value, reference: "final" };
        }
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jxl-progressive && npx vitest run test/profile-score.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole package test suite (no regressions)**

Run: `cd packages/jxl-progressive && npx vitest run`
Expected: PASS — existing manifest/profile/stream/scheduler tests still green.

- [ ] **Step 6: Commit**

```bash
git add packages/jxl-progressive/src/progressive-profile.ts packages/jxl-progressive/test/profile-score.test.ts
git commit -m "feat(jxl-progressive): score each tier vs final frame in profiler (opt-in scorer)"
```

---

### Task 4: Threshold-driven tier selection (`selectTiersByScore`)

**Files:**
- Modify: `packages/jxl-progressive/src/progressive-profile.ts`
- Test: `packages/jxl-progressive/test/select-tiers-by-score.test.ts`

Today `selectTiers` picks byteEnds by fixed `<25%`/`<70%` fractions. Add `selectTiersByScore` that, given scored progression events, picks the **earliest** byteEnd whose score meets a per-tier threshold — still choosing byteEnd from a real event (guardrail). Falls back to `selectTiers` when scoring is unavailable.

- [ ] **Step 1: Write the failing test**

```ts
// packages/jxl-progressive/test/select-tiers-by-score.test.ts
import { describe, it, expect } from "vitest";
import { selectTiersByScore, type ScoredEvent } from "../src/progressive-profile.js";

describe("selectTiersByScore", () => {
  const events: ScoredEvent[] = [
    { byteOffset: 100, progressionIndex: 0, score: 18 }, // below preview, above nothing
    { byteOffset: 250, progressionIndex: 1, score: 22 }, // first to clear dc=20
    { byteOffset: 600, progressionIndex: 2, score: 31 }, // first to clear preview=30
    { byteOffset: 900, progressionIndex: 3, score: 44 },
  ];

  it("dc tier = earliest event meeting dc threshold", () => {
    const tiers = selectTiersByScore(events, 1000, "psnr", { dc: 20, preview: 30 });
    const dc = tiers.find(t => t.name === "dc")!;
    expect(dc.byteEnd).toBe(250);
    expect(dc.score?.value).toBe(22);
  });

  it("preview tier = earliest event meeting preview threshold, after dc", () => {
    const tiers = selectTiersByScore(events, 1000, "psnr", { dc: 20, preview: 30 });
    const preview = tiers.find(t => t.name === "preview")!;
    expect(preview.byteEnd).toBe(600);
  });

  it("always ends with a full tier at total bytes", () => {
    const tiers = selectTiersByScore(events, 1000, "psnr", { dc: 20, preview: 30 });
    const full = tiers.at(-1)!;
    expect(full.name).toBe("full");
    expect(full.byteEnd).toBe(1000);
    expect(full.progressionIndex).toBe("final");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jxl-progressive && npx vitest run test/select-tiers-by-score.test.ts`
Expected: FAIL — `selectTiersByScore` / `ScoredEvent` not exported.

- [ ] **Step 3: Write minimal implementation**

In `progressive-profile.ts`, add (and export):

```ts
import { meetsThreshold, type MetricName } from "./progressive-metrics.js";

export interface ScoredEvent {
  byteOffset: number;
  progressionIndex: number;
  score: number;
}

export interface ScoreThresholds {
  dc: number;
  preview: number;
}

/** Choose dc/preview byteEnds as the earliest progression event whose score clears
 *  the tier threshold. byteEnd always comes from a real event (never a guessed byte
 *  count — see docs/rejected optimizations.md line 51). Full tier is always total. */
export function selectTiersByScore(
  events: ScoredEvent[],
  totalBytes: number,
  metric: MetricName,
  thresholds: ScoreThresholds,
): ManifestTier[] {
  const tiers: ManifestTier[] = [];
  const firstMeeting = (t: number) =>
    events.find((e) => e.byteOffset > 0 && e.byteOffset < totalBytes && meetsThreshold(metric, e.score, t));

  const dcEvent = firstMeeting(thresholds.dc);
  if (dcEvent !== undefined) {
    tiers.push({
      name: "dc", byteStart: 0, byteEnd: dcEvent.byteOffset, progressionIndex: dcEvent.progressionIndex,
      intendedUse: "thumbnail", score: { metric, value: dcEvent.score, reference: "final" },
    });
  }

  const previewEvent = firstMeeting(thresholds.preview);
  if (previewEvent !== undefined && previewEvent.byteOffset > (dcEvent?.byteOffset ?? 0)) {
    tiers.push({
      name: "preview", byteStart: 0, byteEnd: previewEvent.byteOffset, progressionIndex: previewEvent.progressionIndex,
      intendedUse: "visible-card", score: { metric, value: previewEvent.score, reference: "final" },
    });
  }

  tiers.push({ name: "full", byteStart: 0, byteEnd: totalBytes, progressionIndex: "final", intendedUse: "zoom-export" });
  return tiers;
}
```

Then wire it into `profileJxl`: when `opts.scorer` is set, score every event during the scoring pass (not just tier candidates) and build tiers via `selectTiersByScore`; otherwise use the existing structural `selectTiers`. Replace the Task-3 scoring block with:

```ts
  let tiers: ManifestTier[];
  if (opts.scorer !== undefined) {
    const finalEvent = [...events].reverse().find((e) => e.pixels !== undefined && e.pixels.length > 0);
    const scored: ScoredEvent[] = [];
    if (finalEvent?.pixels !== undefined) {
      for (const e of events) {
        if (e.pixels === undefined || e.pixels.length !== finalEvent.pixels.length) continue;
        const value = await opts.scorer.score(e.pixels, finalEvent.pixels, source.width, source.height);
        scored.push({ byteOffset: e.byteOffset, progressionIndex: e.progressionIndex, score: value });
      }
    }
    tiers = scored.length > 0
      ? selectTiersByScore(scored, jxlBytes.byteLength, opts.scorer.metric, opts.thresholds ?? { dc: defaultDcThreshold(opts.scorer.metric), preview: defaultPreviewThreshold(opts.scorer.metric) })
      : selectTiers(events, jxlBytes.byteLength);
  } else {
    tiers = selectTiers(events, jxlBytes.byteLength);
  }
```

Update the `manifest` literal to use `tiers,` instead of `tiers: selectTiers(...)`. Add `thresholds?: ScoreThresholds;` to `ProfileOptions`, and the metric-aware defaults:

```ts
function defaultDcThreshold(m: MetricName): number { return m === "butteraugli" ? 3.0 : m === "ssim" ? 0.7 : 20; }
function defaultPreviewThreshold(m: MetricName): number { return m === "butteraugli" ? 1.5 : m === "ssim" ? 0.9 : 30; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/jxl-progressive && npx vitest run test/select-tiers-by-score.test.ts test/profile-score.test.ts`
Expected: PASS. Note the Task-3 test still passes because scored tiers carry `.score`.

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-progressive/src/progressive-profile.ts packages/jxl-progressive/test/select-tiers-by-score.test.ts
git commit -m "feat(jxl-progressive): threshold-driven perceptual tier selection"
```

---

## Phase 2 — Scale-aware frontier (Gap B)

### Task 5: `scaleFrontier` schema + lookup

**Files:**
- Modify: `packages/jxl-progressive/src/progressive-manifest.ts`
- Create: `packages/jxl-progressive/src/progressive-scale.ts`
- Test: `packages/jxl-progressive/test/progressive-scale.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/jxl-progressive/test/progressive-scale.test.ts
import { describe, it, expect } from "vitest";
import { validateManifest, type ProgressiveManifest } from "../src/progressive-manifest.js";
import { selectFrontierTier, selectTierForDisplay } from "../src/progressive-scale.js";

function m(): ProgressiveManifest {
  return {
    version: 1,
    source: { width: 4000, height: 3000, hasAlpha: false, orientation: 1 },
    jxl: { bytes: 100000, sha256: "a".repeat(64) },
    encoder: { name: "t", libjxlVersion: "0.12", flags: [] },
    tiers: [
      { name: "dc", byteStart: 0, byteEnd: 8000, progressionIndex: 0, intendedUse: "thumbnail" },
      { name: "preview", byteStart: 0, byteEnd: 40000, progressionIndex: 2, intendedUse: "visible-card" },
      { name: "full", byteStart: 0, byteEnd: 100000, progressionIndex: "final", intendedUse: "zoom-export" },
    ],
    scaleFrontier: [
      { maxDisplayPx: 256, tier: "dc", byteEnd: 8000, score: { metric: "psnr", value: 36, reference: "final" } },
      { maxDisplayPx: 1024, tier: "preview", byteEnd: 40000, score: { metric: "psnr", value: 34, reference: "final" } },
      { maxDisplayPx: 99999, tier: "full", byteEnd: 100000, score: { metric: "psnr", value: 99, reference: "final" } },
    ],
  };
}

describe("scale frontier", () => {
  it("validates a manifest with a scaleFrontier", () => {
    expect(() => validateManifest(m())).not.toThrow();
  });
  it("rejects a frontier entry whose byteEnd exceeds jxl.bytes", () => {
    const bad = m(); bad.scaleFrontier![0]!.byteEnd = 200000;
    expect(() => validateManifest(bad)).toThrow(/scaleFrontier/);
  });
  it("selectFrontierTier picks the smallest tier covering the display size", () => {
    expect(selectFrontierTier(m(), 200)!.tier).toBe("dc");
    expect(selectFrontierTier(m(), 800)!.tier).toBe("preview");
    expect(selectFrontierTier(m(), 5000)!.tier).toBe("full");
  });
  it("selectTierForDisplay multiplies element size by DPR (longest edge)", () => {
    // 180px element at DPR 2 → 360px longest edge → needs preview, not dc
    const sel = selectTierForDisplay(m(), 180, 120, 2);
    expect(sel.tier).toBe("preview");
    expect(sel.byteEnd).toBe(40000);
  });
  it("selectTierForDisplay falls back to tiers heuristic when no frontier", () => {
    const noFrontier = m(); delete noFrontier.scaleFrontier;
    const sel = selectTierForDisplay(noFrontier, 100, 100, 1);
    expect(["dc", "preview", "full"]).toContain(sel.tier);
    expect(sel.byteEnd).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jxl-progressive && npx vitest run test/progressive-scale.test.ts`
Expected: FAIL — `progressive-scale.js` missing; `scaleFrontier` not validated.

- [ ] **Step 3: Write minimal implementation**

In `progressive-manifest.ts` add the types:

```ts
export interface ScaleFrontierEntry {
  /** Longest-edge display pixels this entry covers (inclusive upper bound). */
  maxDisplayPx: number;
  tier: TierName;
  /** Denormalized from tiers[tier].byteEnd so a consumer can Range-fetch directly. */
  byteEnd: number;
  score: TierScore;
}
```

Add `scaleFrontier?: ScaleFrontierEntry[];` to `ProgressiveManifest`. After the tiers cross-checks in `validateManifest`, add:

```ts
  if (obj["scaleFrontier"] !== undefined) {
    assertField(Array.isArray(obj["scaleFrontier"]), "scaleFrontier", "scaleFrontier must be an array if present");
    const fr = obj["scaleFrontier"] as unknown[];
    assertField(fr.length <= 16, "scaleFrontier", "scaleFrontier must have <= 16 entries");
    for (let i = 0; i < fr.length; i++) {
      const e = fr[i] as Record<string, unknown>;
      const f = `scaleFrontier[${i}]`;
      assertField(typeof e === "object" && e !== null, f, `${f} must be an object`);
      assertField(typeof e["maxDisplayPx"] === "number" && (e["maxDisplayPx"] as number) > 0, `${f}.maxDisplayPx`, `${f}.maxDisplayPx must be a positive number`);
      assertField(VALID_TIER_NAMES.has(e["tier"] as string), `${f}.tier`, `${f}.tier must be dc|preview|full`);
      assertField(typeof e["byteEnd"] === "number" && (e["byteEnd"] as number) > 0 && (e["byteEnd"] as number) <= (jxl["bytes"] as number), `${f}.byteEnd`, `${f}.byteEnd must be in (0, jxl.bytes]`);
      if (i > 0) assertField((e["maxDisplayPx"] as number) > (fr[i-1] as Record<string, unknown>)["maxDisplayPx"], `${f}.maxDisplayPx`, `${f}.maxDisplayPx must be strictly ascending`);
    }
  }
```

Create `progressive-scale.ts`:

```ts
// packages/jxl-progressive/src/progressive-scale.ts
import type { ProgressiveManifest, TierName, ManifestTier } from "./progressive-manifest.js";

export interface TierSelection { tier: TierName; byteEnd: number; }

/** Pick the frontier entry whose maxDisplayPx covers `displayPx` (longest edge).
 *  Returns undefined when the manifest has no frontier. */
export function selectFrontierTier(manifest: ProgressiveManifest, displayPx: number): { tier: TierName; byteEnd: number; maxDisplayPx: number } | undefined {
  const fr = manifest.scaleFrontier;
  if (fr === undefined || fr.length === 0) return undefined;
  for (const e of fr) if (displayPx <= e.maxDisplayPx) return e;
  const last = fr[fr.length - 1]!;
  return last;
}

/** Choose a tier for an on-screen element. Uses the scale frontier when present;
 *  otherwise a structural heuristic over tiers (longest-edge thresholds). */
export function selectTierForDisplay(manifest: ProgressiveManifest, elementWidth: number, elementHeight: number, dpr: number): TierSelection {
  const longestEdge = Math.max(elementWidth, elementHeight) * (dpr > 0 ? dpr : 1);
  const frontier = selectFrontierTier(manifest, longestEdge);
  if (frontier !== undefined) return { tier: frontier.tier, byteEnd: frontier.byteEnd };

  // Fallback: no frontier → pick by longest-edge buckets against available tiers.
  const byName = (n: TierName): ManifestTier | undefined => manifest.tiers.find((t) => t.name === n);
  if (longestEdge <= 384 && byName("dc")) { const t = byName("dc")!; return { tier: "dc", byteEnd: t.byteEnd }; }
  if (longestEdge <= 1280 && byName("preview")) { const t = byName("preview")!; return { tier: "preview", byteEnd: t.byteEnd }; }
  const full = byName("full") ?? manifest.tiers[manifest.tiers.length - 1]!;
  return { tier: full.name, byteEnd: full.byteEnd };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jxl-progressive && npx vitest run test/progressive-scale.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-progressive/src/progressive-manifest.ts packages/jxl-progressive/src/progressive-scale.ts packages/jxl-progressive/test/progressive-scale.test.ts
git commit -m "feat(jxl-progressive): scale frontier schema + display-size tier selection"
```

---

### Task 6: Build the frontier in the profiler (injected downscaler)

**Files:**
- Modify: `packages/jxl-progressive/src/progressive-profile.ts`
- Test: `packages/jxl-progressive/test/profile-frontier.test.ts`

For each configured display size, downscale every captured pass + the final to that size (longest-edge box), re-score, and record the earliest tier that clears the threshold at that scale. Downscaler is injected (pure-JS box default for tests; wasm `downscale_rgba` in production via `progressive-adapters.ts`). This is the core of Gap B: a pass that fails at native res may pass at thumbnail size, so the frontier byteEnd shrinks as display size shrinks.

- [ ] **Step 1: Write the failing test**

```ts
// packages/jxl-progressive/test/profile-frontier.test.ts
import { describe, it, expect } from "vitest";
import { buildScaleFrontier, type ScoredPass } from "../src/progressive-profile.js";

// Pure-JS nearest-neighbour downscaler (deterministic) for the test.
const boxDown = (rgba: Uint8Array, w: number, h: number, dw: number, dh: number): Uint8Array => {
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const sx = Math.floor(x * w / dw), sy = Math.floor(y * h / dh);
    const si = (sy * w + sx) * 4, di = (y * dw + x) * 4;
    out[di]=rgba[si]!; out[di+1]=rgba[si+1]!; out[di+2]=rgba[si+2]!; out[di+3]=255;
  }
  return out;
};

describe("buildScaleFrontier", () => {
  it("smaller display sizes select earlier (cheaper) tiers", async () => {
    const w = 64, h = 64;
    const solid = (v: number) => { const p = new Uint8Array(w*h*4); for (let i=0;i<w*h;i++){p[i*4]=v;p[i*4+1]=v;p[i*4+2]=v;p[i*4+3]=255;} return p; };
    // dc is far from final at native res but identical once downsampled to a flat block.
    const passes: ScoredPass[] = [
      { byteOffset: 1000, progressionIndex: 0, pixels: solid(120) },  // dc
      { byteOffset: 5000, progressionIndex: 2, pixels: solid(127) },  // preview
    ];
    const finalPixels = solid(128);
    const tiers = [
      { name: "dc" as const, byteStart: 0, byteEnd: 1000, progressionIndex: 0, intendedUse: "thumbnail" },
      { name: "preview" as const, byteStart: 0, byteEnd: 5000, progressionIndex: 2, intendedUse: "visible-card" },
      { name: "full" as const, byteStart: 0, byteEnd: 8000, progressionIndex: "final" as const, intendedUse: "zoom-export" },
    ];
    const frontier = await buildScaleFrontier({
      passes, finalPixels, srcW: w, srcH: h, tiers, totalBytes: 8000,
      metric: "psnr", thresholds: { dc: 20, preview: 30 },
      displaySizes: [16, 32, 64], downscaler: boxDown,
    });
    // At 16px (heavy downsample) dc should already clear preview threshold → tier "dc".
    // At 64px (native) dc may not clear → larger tier.
    const at16 = frontier.find(e => e.maxDisplayPx === 16)!;
    const at64 = frontier.find(e => e.maxDisplayPx === 64)!;
    expect(at16.byteEnd).toBeLessThanOrEqual(at64.byteEnd);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jxl-progressive && npx vitest run test/profile-frontier.test.ts`
Expected: FAIL — `buildScaleFrontier` / `ScoredPass` not exported.

- [ ] **Step 3: Write minimal implementation**

In `progressive-profile.ts` add (and export):

```ts
import type { ScaleFrontierEntry } from "./progressive-manifest.js";

export type Downscaler = (rgba: Uint8Array, w: number, h: number, dw: number, dh: number) => Uint8Array;

export interface ScoredPass {
  byteOffset: number;
  progressionIndex: number;
  pixels: Uint8Array;
}

export interface BuildFrontierArgs {
  passes: ScoredPass[];
  finalPixels: Uint8Array;
  srcW: number;
  srcH: number;
  tiers: ManifestTier[];
  totalBytes: number;
  metric: MetricName;
  thresholds: ScoreThresholds;
  /** Longest-edge display sizes to compute frontier entries for, ascending. */
  displaySizes: number[];
  downscaler: Downscaler;
  scorerAt?: (cand: Uint8Array, ref: Uint8Array, w: number, h: number) => Promise<number> | number;
}

function dimsForLongestEdge(srcW: number, srcH: number, longest: number): { dw: number; dh: number } {
  const edge = Math.max(srcW, srcH);
  if (longest >= edge) return { dw: srcW, dh: srcH };
  const scale = longest / edge;
  return { dw: Math.max(1, Math.round(srcW * scale)), dh: Math.max(1, Math.round(srcH * scale)) };
}

/** For each display size, find the earliest pass that clears the preview threshold
 *  once both pass and final are downsampled to that size; map it to the smallest
 *  covering tier. Demonstrates scale-dependence: a pass insufficient at native res
 *  can be sufficient at thumbnail res. */
export async function buildScaleFrontier(args: BuildFrontierArgs): Promise<ScaleFrontierEntry[]> {
  const { passes, finalPixels, srcW, srcH, tiers, totalBytes, metric, thresholds, displaySizes, downscaler } = args;
  const score = args.scorerAt ?? (async (c: Uint8Array, r: Uint8Array, w: number, h: number) => {
    const { psnrVsRef, ssimVsRef } = await import("./progressive-metrics.js");
    return metric === "ssim" ? ssimVsRef(c, r, w, h) : psnrVsRef(c, r);
  });
  const tierForByteEnd = (be: number): ManifestTier =>
    tiers.find((t) => t.byteEnd >= be) ?? tiers[tiers.length - 1]!;

  const out: ScaleFrontierEntry[] = [];
  for (const longest of displaySizes) {
    const { dw, dh } = dimsForLongestEdge(srcW, srcH, longest);
    const refDown = downscaler(finalPixels, srcW, srcH, dw, dh);
    let chosen: { byteEnd: number; tier: TierName; value: number } | undefined;
    for (const p of passes) {
      const candDown = downscaler(p.pixels, srcW, srcH, dw, dh);
      const value = await score(candDown, refDown, dw, dh);
      if (meetsThreshold(metric, value, thresholds.preview)) {
        const t = tierForByteEnd(p.byteOffset);
        chosen = { byteEnd: t.byteEnd, tier: t.name, value };
        break;
      }
    }
    const fallback = tiers[tiers.length - 1]!;
    const e = chosen ?? { byteEnd: fallback.byteEnd, tier: fallback.name, value: thresholds.preview };
    out.push({ maxDisplayPx: longest, tier: e.tier, byteEnd: e.byteEnd, score: { metric, value: e.value, reference: "final" } });
  }
  return out;
}
```

Then, in `profileJxl`, when `opts.scorer` and `opts.displaySizes` and `opts.downscaler` are all set, populate `manifest.scaleFrontier`:

```ts
  if (opts.scorer !== undefined && opts.displaySizes !== undefined && opts.downscaler !== undefined) {
    const finalEvent = [...events].reverse().find((e) => e.pixels !== undefined && e.pixels.length > 0);
    if (finalEvent?.pixels !== undefined) {
      const passes: ScoredPass[] = events
        .filter((e) => e.pixels !== undefined && e.pixels.length === finalEvent.pixels!.length)
        .map((e) => ({ byteOffset: e.byteOffset, progressionIndex: e.progressionIndex, pixels: e.pixels! }));
      manifest.scaleFrontier = await buildScaleFrontier({
        passes, finalPixels: finalEvent.pixels, srcW: source.width, srcH: source.height,
        tiers: manifest.tiers, totalBytes: jxlBytes.byteLength, metric: opts.scorer.metric,
        thresholds: opts.thresholds ?? { dc: defaultDcThreshold(opts.scorer.metric), preview: defaultPreviewThreshold(opts.scorer.metric) },
        displaySizes: opts.displaySizes, downscaler: opts.downscaler,
      });
    }
  }
```

Add to `ProfileOptions`: `displaySizes?: number[];` and `downscaler?: Downscaler;`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jxl-progressive && npx vitest run test/profile-frontier.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full package suite**

Run: `cd packages/jxl-progressive && npx vitest run`
Expected: PASS (all phases).

- [ ] **Step 6: Commit**

```bash
git add packages/jxl-progressive/src/progressive-profile.ts packages/jxl-progressive/test/profile-frontier.test.ts
git commit -m "feat(jxl-progressive): build scale frontier from downsampled per-pass scores"
```

---

### Task 7: Production adapters (wasm Butteraugli scorer + downscaler) and exports

**Files:**
- Create: `packages/jxl-progressive/src/progressive-adapters.ts`
- Modify: `packages/jxl-progressive/src/index.ts`
- Test: `packages/jxl-progressive/test/adapters.test.ts`

These bind the injected `MetricScorer`/`Downscaler` to the real wasm. They are imported only by callers that have wasm loaded; the pure logic and its tests never import them.

> Perf note: the profiler scores many passes against **one** final frame, so a ref-reuse comparator (`ButteraugliComparator.create(final, w, h)` then `.compare(pass)`) is the natural fit. Caveat (memory `project-butteraugli-refcache-20260626`): the current wasm bridge deep-copies the reference on every call regardless, so ref-reuse buys little until that bridge is fixed. `makeButteraugliScorer` takes an injected compute fn, so swapping `computeButteraugli` ↔ a comparator-backed closure is a one-line change with no logic-test impact.

- [ ] **Step 1: Write the failing test** (smoke: shape only, wasm mocked)

```ts
// packages/jxl-progressive/test/adapters.test.ts
import { describe, it, expect, vi } from "vitest";
import { makeButteraugliScorer, makeWasmDownscaler } from "../src/progressive-adapters.js";

describe("adapters", () => {
  it("butteraugli scorer reports metric 'butteraugli' and forwards to computeButteraugli", async () => {
    const compute = vi.fn(async () => 0.42);
    const scorer = makeButteraugliScorer(compute as any);
    expect(scorer.metric).toBe("butteraugli");
    const v = await scorer.score(new Uint8Array(16), new Uint8Array(16), 2, 2);
    expect(v).toBe(0.42);
    expect(compute).toHaveBeenCalledOnce();
  });

  it("wasm downscaler forwards dims to downscale_rgba and returns its bytes", () => {
    const ds = vi.fn((src: Uint8Array, _sw: number, _sh: number, dw: number, dh: number) => new Uint8Array(dw * dh * 4));
    const down = makeWasmDownscaler(ds as any);
    const out = down(new Uint8Array(64 * 4), 8, 8, 4, 4);
    expect(out.length).toBe(4 * 4 * 4);
    expect(ds).toHaveBeenCalledWith(expect.any(Uint8Array), 8, 8, 4, 4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jxl-progressive && npx vitest run test/adapters.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/jxl-progressive/src/progressive-adapters.ts
import type { MetricScorer } from "./progressive-metrics.js";
import type { Downscaler } from "./progressive-profile.js";

/** Wrap the facade's computeButteraugli(a, b, w, h) into a MetricScorer.
 *  In production: import { computeButteraugli } from "@casabio/jxl-wasm". */
export function makeButteraugliScorer(
  computeButteraugli: (a: Uint8Array, b: Uint8Array, w: number, h: number) => Promise<number>,
): MetricScorer {
  return { metric: "butteraugli", score: (cand, ref, w, h) => computeButteraugli(cand, ref, w, h) };
}

/** Wrap the Rust wasm downscale_rgba(src, src_w, src_h, dst_w, dst_h) into a Downscaler.
 *  In production: import init, { downscale_rgba } from the raw-pipeline wasm pkg. */
export function makeWasmDownscaler(
  downscaleRgba: (src: Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number) => Uint8Array,
): Downscaler {
  return (rgba, w, h, dw, dh) => downscaleRgba(rgba, w, h, dw, dh);
}
```

Add to `index.ts`:

```ts
// Metrics + scale + adapters (Phase A/B)
export { psnrVsRef, ssimVsRef, meetsThreshold } from "./progressive-metrics.js";
export type { MetricName, MetricScorer } from "./progressive-metrics.js";
export { selectTierForDisplay, selectFrontierTier } from "./progressive-scale.js";
export type { TierSelection } from "./progressive-scale.js";
export { selectTiersByScore, buildScaleFrontier } from "./progressive-profile.js";
export type { Downscaler, ScoredEvent, ScoredPass, ScoreThresholds } from "./progressive-profile.js";
export { makeButteraugliScorer, makeWasmDownscaler } from "./progressive-adapters.js";
export type { ScaleFrontierEntry, TierScore, ScoreMetric } from "./progressive-manifest.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jxl-progressive && npx vitest run test/adapters.test.ts`
Expected: PASS.

- [ ] **Step 5: Build the package (typecheck the new surface)**

Run: `cd packages/jxl-progressive && npx tsc -p tsconfig.json --noEmit`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/jxl-progressive/src/progressive-adapters.ts packages/jxl-progressive/src/index.ts packages/jxl-progressive/test/adapters.test.ts
git commit -m "feat(jxl-progressive): wasm butteraugli/downscale adapters + public exports"
```

---

## Phase 3 — Wire the live gallery (decode-time tier capping)

**Reality:** the live gallery (`web/jxl-progressive-gallery.js`) loads whole local files into memory (`file.arrayBuffer()`, gallery.js:674) and feeds **all** bytes (`buildPushBatches` over the full buffer, gallery.js:698-714). `setForcedTier` selects the CPU codec variant, not data tiers (facade.ts:638). There is no network streaming. So the realizable win here is **capping decoded bytes per display tier** (less decode CPU/memory for thumbnails). The `fetchTier` Range path (already built) is the same `selectTierForDisplay` decision applied to remote URLs — wired identically when assets are served over HTTP.

### Task 8: Cap pushed bytes to the display tier in the gallery

**Files:**
- Modify: `web/jxl-progressive-gallery.js` (insertion at the push boundary, ~698-704)
- Test: `web/jxl-progressive-gallery-tier-cap.test.js`

The gallery already imports from the package via `@casabio/jxl-wasm`; add an import of `selectTierForDisplay` from `@casabio/jxl-progressive`. Gate the capping behind an **optional manifest provider** on the gallery options — absent → full file (today's behavior, zero change). Keep it out of the coordinator (guardrail G5-C1).

- [ ] **Step 1: Write the failing test** (pure helper, no DOM/wasm)

Extract the capping decision into a tiny pure helper so it is testable without a browser:

```js
// web/jxl-progressive-gallery-tier-cap.test.js
import { describe, it, expect } from "vitest";
import { capBytesForDisplay } from "./jxl-progressive-gallery-tier-cap.js";

const manifest = {
  version: 1,
  source: { width: 4000, height: 3000, hasAlpha: false, orientation: 1 },
  jxl: { bytes: 100000, sha256: "a".repeat(64) },
  encoder: { name: "t", libjxlVersion: "0.12", flags: [] },
  tiers: [
    { name: "dc", byteStart: 0, byteEnd: 8000, progressionIndex: 0, intendedUse: "thumbnail" },
    { name: "preview", byteStart: 0, byteEnd: 40000, progressionIndex: 2, intendedUse: "visible-card" },
    { name: "full", byteStart: 0, byteEnd: 100000, progressionIndex: "final", intendedUse: "zoom-export" },
  ],
  scaleFrontier: [
    { maxDisplayPx: 256, tier: "dc", byteEnd: 8000, score: { metric: "psnr", value: 36, reference: "final" } },
    { maxDisplayPx: 1024, tier: "preview", byteEnd: 40000, score: { metric: "psnr", value: 34, reference: "final" } },
    { maxDisplayPx: 99999, tier: "full", byteEnd: 100000, score: { metric: "psnr", value: 99, reference: "final" } },
  ],
};

describe("capBytesForDisplay", () => {
  it("returns full byteLength when no manifest", () => {
    expect(capBytesForDisplay(null, 100, 100, 1, 100000)).toBe(100000);
  });
  it("caps to dc tier for a tiny thumbnail", () => {
    expect(capBytesForDisplay(manifest, 120, 80, 1, 100000)).toBe(8000);
  });
  it("caps to preview tier for a card-sized element (DPR aware)", () => {
    expect(capBytesForDisplay(manifest, 180, 120, 2, 100000)).toBe(40000); // 180*2=360 → preview
  });
  it("never exceeds the actual buffer length", () => {
    expect(capBytesForDisplay(manifest, 5000, 5000, 2, 50000)).toBe(50000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/jxl-progressive-gallery-tier-cap.test.js`
Expected: FAIL — module `./jxl-progressive-gallery-tier-cap.js` missing.

- [ ] **Step 3: Write minimal implementation**

```js
// web/jxl-progressive-gallery-tier-cap.js
import { selectTierForDisplay } from "@casabio/jxl-progressive";

/**
 * Decide how many leading bytes of an encoded JXL to decode for an element of the
 * given on-screen size. Returns bufferLength unchanged when no manifest is available
 * (today's behavior). Result is clamped to bufferLength.
 *
 * @param {import("@casabio/jxl-progressive").ProgressiveManifest | null | undefined} manifest
 * @param {number} elementWidth  CSS px
 * @param {number} elementHeight CSS px
 * @param {number} dpr           devicePixelRatio
 * @param {number} bufferLength  total encoded bytes available
 * @returns {number} byte count to feed the decoder
 */
export function capBytesForDisplay(manifest, elementWidth, elementHeight, dpr, bufferLength) {
  if (!manifest) return bufferLength;
  const sel = selectTierForDisplay(manifest, elementWidth, elementHeight, dpr);
  const cap = sel?.byteEnd ?? bufferLength;
  return Math.min(cap, bufferLength);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run web/jxl-progressive-gallery-tier-cap.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire it into the gallery push boundary**

In `web/jxl-progressive-gallery.js`, add near the other imports:

```js
import { capBytesForDisplay } from './jxl-progressive-gallery-tier-cap.js';
```

At the push boundary (the `getPushBatchingOptions` / `buildPushBatches` block around lines 698-704), before `buildPushBatches`, compute the cap and slice the buffer view. Use the strip element's measured size and `devicePixelRatio`; read an optional `opts.getManifest(fileId)` provider (undefined → no cap):

```js
        // Display-aware tier cap (no-op when no manifest provider / no manifest).
        const stripEl = /* existing element ref for this image's strip/card */ targetStripEl;
        const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;
        const manifest = typeof opts.getManifest === 'function' ? (opts.getManifest(fileId) ?? null) : null;
        const elemW = stripEl?.clientWidth ?? buffer.byteLength;   // fallbacks keep full decode if unmeasured
        const elemH = stripEl?.clientHeight ?? buffer.byteLength;
        const capBytes = capBytesForDisplay(manifest, elemW, elemH, dpr, buffer.byteLength);
        const decodeBuffer = capBytes < buffer.byteLength ? buffer.subarray(0, capBytes) : buffer;

        const pushOpts = getPushBatchingOptions(decodeBuffer.byteLength, { /* …existing… */ });
        const pushBatches = buildPushBatches(decodeBuffer, { mode: pushMode, ...pushOpts });
```

> Note for the implementer: `targetStripEl` and `fileId` already exist in that scope as the per-image render target and id; reuse the existing identifiers rather than introducing new ones. `buffer` is the `Uint8Array`/ArrayBuffer view from `file.arrayBuffer()`; `subarray` keeps it zero-copy. Do **not** add manifest state to `jxl-progressive-gallery-coordinator.js` (guardrail G5-C1).

- [ ] **Step 6: Run the gallery test suite + the new test**

Run: `npx vitest run web/jxl-progressive-gallery-tier-cap.test.js web/jxl-progressive-gallery-frame.test.js`
Expected: PASS. Existing gallery tests unaffected (capping is no-op without a manifest provider).

- [ ] **Step 7: Commit**

```bash
git add web/jxl-progressive-gallery-tier-cap.js web/jxl-progressive-gallery-tier-cap.test.js web/jxl-progressive-gallery.js
git commit -m "feat(gallery): cap decoded bytes to display-appropriate manifest tier"
```

---

### Task 9: End-to-end manifest generation example + docs

**Files:**
- Create: `benchmark/generate-perceptual-manifest.mjs`
- Modify: `docs/suggested-settings.md`

A runnable Node script that profiles a real `.jxl` with both metrics + the scale frontier, writing the enriched sidecar. Proves the whole pipeline on a real file and documents the recipe.

- [ ] **Step 1: Write the example script**

```js
// benchmark/generate-perceptual-manifest.mjs
// Usage: node benchmark/generate-perceptual-manifest.mjs <file.jxl> <width> <height> [metric]
import { profileJxlFile, makeButteraugliScorer, makeWasmDownscaler } from "../packages/jxl-progressive/dist/index.js";
import { createBrowserContext } from "../packages/jxl-session/dist/index.js";
import { computeButteraugli } from "@casabio/jxl-wasm";
// downscale_rgba comes from the raw-pipeline wasm pkg; import per your build output path.
import init, { downscale_rgba } from "../web/pkg/raw_pipeline.js";

const [path, w, h, metric = "psnr"] = process.argv.slice(2);
await init();

const ctx = createBrowserContext();
const sessionFactory = () => ctx.createDecodeSession({ format: "rgba8", emitEveryPass: true, progressionTarget: "final", progressiveDetail: "passes" });

const scorer = metric === "butteraugli"
  ? makeButteraugliScorer((a, b, ww, hh) => computeButteraugli(a, b, ww, hh))
  : { metric, score: async (c, r, ww, hh) => { const m = await import("../packages/jxl-progressive/dist/progressive-metrics.js"); return metric === "ssim" ? m.ssimVsRef(c, r, ww, hh) : m.psnrVsRef(c, r); } };

const manifest = await profileJxlFile(path, sessionFactory, { width: Number(w), height: Number(h), hasAlpha: false }, {
  scorer,
  downscaler: makeWasmDownscaler(downscale_rgba),
  displaySizes: [256, 512, 1024, 2048],
  encoderName: "casabio",
  writeManifest: true,
});
console.log(JSON.stringify(manifest, null, 2));
```

- [ ] **Step 2: Build the package dist + run on a real fixture**

Run:
```bash
cd packages/jxl-progressive && npx tsc -p tsconfig.json && cd ../..
node benchmark/generate-perceptual-manifest.mjs <a-real>.jxl <W> <H> psnr
```
Expected: prints a manifest where `tiers[].score` is populated and `scaleFrontier[].byteEnd` is **non-decreasing** with `maxDisplayPx`, and writes `<a-real>.jxl.json`.

- [ ] **Step 3: Document the recipe**

Append to `docs/suggested-settings.md` a "Perceptual + scale-aware manifest" section: how to run the generator, that the score reference is the file's own final frame (diminishing-returns cutoff, not absolute quality), that Butteraugli requires a wasm build with the butteraugli bridge (`computeButteraugli` throws `CapabilityMissing` otherwise), and that the gallery caps decode bytes only when a manifest provider is supplied.

- [ ] **Step 4: Commit**

```bash
git add benchmark/generate-perceptual-manifest.mjs docs/suggested-settings.md
git commit -m "docs(jxl-progressive): perceptual+scale manifest generator + recipe"
```

---

## Phase 4 — Tiered serving (lazy Butteraugli + edge enforcement)

### Task 10: Lazy manifest service (cache-or-build)

**Files:**
- Create: `packages/jxl-progressive/src/progressive-service.ts`
- Test: `packages/jxl-progressive/test/progressive-service.test.ts`

Pure orchestration: return the cached manifest for `(sha256, metric)`; on miss, build it (the real builder = `profileJxlFile` with the chosen scorer) and cache it. SSIM is normally pre-cached at ingest; Butteraugli builds on first request. All I/O is injected so the logic is testable without fs/wasm.

- [ ] **Step 1: Write the failing test**

```ts
// packages/jxl-progressive/test/progressive-service.test.ts
import { describe, it, expect, vi } from "vitest";
import { getOrBuildManifest, type ManifestServiceDeps } from "../src/progressive-service.js";
import type { ProgressiveManifest } from "../src/progressive-manifest.js";

const fakeManifest = (metric: string): ProgressiveManifest => ({
  version: 1, source: { width: 10, height: 10, hasAlpha: false, orientation: 1 },
  jxl: { bytes: 100, sha256: "a".repeat(64) }, encoder: { name: "t", libjxlVersion: "0", flags: [] },
  tiers: [{ name: "full", byteStart: 0, byteEnd: 100, progressionIndex: "final", intendedUse: "zoom-export", score: { metric: metric as any, value: 1, reference: "final" } }],
});

describe("getOrBuildManifest", () => {
  it("returns cached manifest without building", async () => {
    const build = vi.fn();
    const deps: ManifestServiceDeps = { loadCached: async () => fakeManifest("butteraugli"), saveCached: vi.fn(), build: build as any };
    const m = await getOrBuildManifest(deps, { sha256: "a".repeat(64), metric: "butteraugli" });
    expect(m.tiers[0]!.score!.metric).toBe("butteraugli");
    expect(build).not.toHaveBeenCalled();
  });

  it("builds + caches on cache miss", async () => {
    const save = vi.fn();
    const deps: ManifestServiceDeps = { loadCached: async () => null, saveCached: save, build: async () => fakeManifest("butteraugli") };
    const m = await getOrBuildManifest(deps, { sha256: "a".repeat(64), metric: "butteraugli" });
    expect(m.tiers[0]!.score!.metric).toBe("butteraugli");
    expect(save).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent misses into a single build (no duplicate work)", async () => {
    let builds = 0;
    const deps: ManifestServiceDeps = {
      loadCached: async () => null, saveCached: vi.fn(),
      build: async () => { builds++; await new Promise(r => setTimeout(r, 5)); return fakeManifest("butteraugli"); },
    };
    const key = { sha256: "a".repeat(64), metric: "butteraugli" as const };
    await Promise.all([getOrBuildManifest(deps, key), getOrBuildManifest(deps, key)]);
    expect(builds).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jxl-progressive && npx vitest run test/progressive-service.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jxl-progressive && npx vitest run test/progressive-service.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-progressive/src/progressive-service.ts packages/jxl-progressive/test/progressive-service.test.ts
git commit -m "feat(jxl-progressive): lazy cache-or-build manifest service (dedup concurrent builds)"
```

---

### Task 11: Authoritative edge tier resolver

**Files:**
- Create: `packages/jxl-progressive/src/progressive-edge.ts`
- Test: `packages/jxl-progressive/test/progressive-edge.test.ts`

The edge takes the client's *display hint* (trusted as a hint) but is authoritative on metric + ceiling via an injected `policy(userTier)`. It loads the metric-appropriate manifest through the service, picks the frontier tier for the display size, then clamps to the user's allowed max tier. Returns the `rangeEnd` the edge will request from origin. A free user requesting a huge display size still cannot exceed their `maxTier` ceiling.

- [ ] **Step 1: Write the failing test**

```ts
// packages/jxl-progressive/test/progressive-edge.test.ts
import { describe, it, expect } from "vitest";
import { resolveTierRequest, type EdgeDeps, type TierPolicy } from "../src/progressive-edge.js";
import type { ProgressiveManifest } from "../src/progressive-manifest.js";

function manifest(metric: string): ProgressiveManifest {
  return {
    version: 1, source: { width: 4000, height: 3000, hasAlpha: false, orientation: 1 },
    jxl: { bytes: 100000, sha256: "a".repeat(64) }, encoder: { name: "t", libjxlVersion: "0", flags: [] },
    tiers: [
      { name: "dc", byteStart: 0, byteEnd: 8000, progressionIndex: 0, intendedUse: "thumbnail" },
      { name: "preview", byteStart: 0, byteEnd: 40000, progressionIndex: 2, intendedUse: "visible-card" },
      { name: "full", byteStart: 0, byteEnd: 100000, progressionIndex: "final", intendedUse: "zoom-export" },
    ],
    scaleFrontier: [
      { maxDisplayPx: 256, tier: "dc", byteEnd: 8000, score: { metric: metric as any, value: 36, reference: "final" } },
      { maxDisplayPx: 1024, tier: "preview", byteEnd: 40000, score: { metric: metric as any, value: 34, reference: "final" } },
      { maxDisplayPx: 99999, tier: "full", byteEnd: 100000, score: { metric: metric as any, value: 99, reference: "final" } },
    ],
  };
}

const policy: TierPolicy = (userTier) =>
  userTier === "premium" ? { metric: "butteraugli", maxTier: "full" } : { metric: "ssim", maxTier: "preview" };

const deps: EdgeDeps = { getManifest: async (_sha, metric) => manifest(metric), policy };

describe("resolveTierRequest", () => {
  it("premium gets butteraugli manifest + full ceiling", async () => {
    const r = await resolveTierRequest(deps, { sha256: "a".repeat(64), userTier: "premium", displayPx: 4000 });
    expect(r.metric).toBe("butteraugli");
    expect(r.rangeEnd).toBe(100000 - 1);
  });

  it("free user is clamped to preview ceiling even when zoomed", async () => {
    const r = await resolveTierRequest(deps, { sha256: "a".repeat(64), userTier: "free", displayPx: 4000 });
    expect(r.metric).toBe("ssim");
    expect(r.rangeEnd).toBe(40000 - 1);   // clamped to preview, NOT full
    expect(r.tier).toBe("preview");
  });

  it("small display selects an earlier tier within the ceiling", async () => {
    const r = await resolveTierRequest(deps, { sha256: "a".repeat(64), userTier: "premium", displayPx: 200 });
    expect(r.rangeEnd).toBe(8000 - 1);    // dc, under the full ceiling
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jxl-progressive && npx vitest run test/progressive-edge.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/jxl-progressive/src/progressive-edge.ts
import type { ProgressiveManifest, TierName } from "./progressive-manifest.js";
import type { MetricName } from "./progressive-metrics.js";
import { selectFrontierTier } from "./progressive-scale.js";

const TIER_ORDER: Record<TierName, number> = { dc: 0, preview: 1, full: 2 };

export type TierPolicy = (userTier: string) => { metric: MetricName; maxTier: TierName };

export interface EdgeDeps {
  /** Load (or lazily build) the manifest for this sha+metric. Wrap getOrBuildManifest. */
  getManifest: (sha256: string, metric: MetricName) => Promise<ProgressiveManifest>;
  policy: TierPolicy;
}

export interface EdgeRequest { sha256: string; userTier: string; displayPx: number; }
export interface EdgeResolution { metric: MetricName; tier: TierName; rangeEnd: number; }

/** Authoritative server/edge decision. Display size is a client hint; metric + ceiling
 *  come from policy(userTier). Returns the inclusive Range end the edge fetches from origin. */
export async function resolveTierRequest(deps: EdgeDeps, req: EdgeRequest): Promise<EdgeResolution> {
  const { metric, maxTier } = deps.policy(req.userTier);
  const manifest = await deps.getManifest(req.sha256, metric);

  // Client's display need (hint), defaulting to full if no frontier.
  const wanted = selectFrontierTier(manifest, req.displayPx);
  const wantedTier: TierName = wanted?.tier ?? "full";

  // Clamp to the user's allowed ceiling.
  const effectiveTier: TierName = TIER_ORDER[wantedTier] <= TIER_ORDER[maxTier] ? wantedTier : maxTier;

  const tierEntry = manifest.tiers.find((t) => t.name === effectiveTier)
    ?? manifest.tiers[manifest.tiers.length - 1]!;
  return { metric, tier: effectiveTier, rangeEnd: tierEntry.byteEnd - 1 };
}
```

Add to `index.ts`:

```ts
export { getOrBuildManifest } from "./progressive-service.js";
export type { ManifestServiceDeps, ManifestRequest } from "./progressive-service.js";
export { resolveTierRequest } from "./progressive-edge.js";
export type { EdgeDeps, EdgeRequest, EdgeResolution, TierPolicy } from "./progressive-edge.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jxl-progressive && npx vitest run test/progressive-edge.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-progressive/src/progressive-edge.ts packages/jxl-progressive/test/progressive-edge.test.ts packages/jxl-progressive/src/index.ts
git commit -m "feat(jxl-progressive): authoritative edge tier resolver (policy + display hint + ceiling clamp)"
```

> **Deployment (outside this package, deploy-target specific):** an edge worker (Cloudflare Worker / Lambda@Edge / origin middleware) wires `resolveTierRequest` to real auth + origin: authenticate → `resolveTierRequest` → `fetch(originUrl, { headers: { Range: 'bytes=0-' + rangeEnd } })` → stream the 206 to the client. The lazy `build` dep = `profileJxlFile(<origin .jxl>, sessionFactory, dims, { scorer: makeButteraugliScorer(...), downscaler: makeWasmDownscaler(...), displaySizes:[256,512,1024,2048] })`. Requires a wasm-capable runtime at the edge for the Butteraugli build (or build on origin and cache to KV). Not implemented here — the package provides the pure decision + service; deployment glue is environment-specific.

---

## Self-review

**Spec coverage:**
- Gap A (perceptual cutoff) → Tasks 1-4 (metrics, schema score, profiler scoring, threshold selection).
- Gap B (scale frontier) → Tasks 5-6 (schema + lookup, frontier build).
- Both metrics configurable → `MetricScorer` injection; SSIM/PSNR pure-JS, Butteraugli adapter (Task 7). **SSIM eager** (Task 9 generator default) / **Butteraugli lazy** (Task 10 service).
- Wire live → Tasks 8 (decode-byte cap) + 9 (generator/recipe). Remote Range path reuses `selectTierForDisplay` + existing `fetchTier`.
- Tiered serving (premium=Butteraugli, free=SSIM; edge-enforced + client hint) → Task 10 (lazy cache-or-build, concurrent-dedup) + Task 11 (authoritative resolver: policy metric + ceiling clamp; client display is a hint). Premium gate enforced at edge, not client (bypass-proof).
- "How many times does butteraugli run" answer is honored: scoring is offline in the profiler (once per asset), never on the live decode path.

**Type consistency:** `MetricScorer.score(cand, ref, w, h)` is the single scorer signature used by profiler (Task 3/4) and adapters (Task 7); `Downscaler(rgba, w, h, dw, dh)` is used by `buildScaleFrontier` (Task 6) and `makeWasmDownscaler` (Task 7); `TierScore { metric, value, reference }` is defined in Task 2 and reused in Tasks 4/5/6; `selectTierForDisplay → { tier, byteEnd }` is produced in Task 5 and consumed in Task 8.

**Placeholder scan:** every code/test step contains complete code. The only deliberately-symbolic identifiers are the *existing* gallery scope variables (`targetStripEl`, `fileId`, `buffer`) in Task 8 Step 5 — flagged with an implementer note to reuse what's already there rather than invent names.

**Open verification items (not blockers, confirm during execution):**
- Confirm the decode frame event field is `pixels` for partial passes in the package's `@casabio/jxl-session` version (verified in `packages/jxl-session/src/decode-session.ts:231,348-350`; the fake session in tests mirrors this).
- Confirm the raw-pipeline wasm export path for `downscale_rgba` in the web build output used by `benchmark/generate-perceptual-manifest.mjs` (Task 9 import path may differ per build).

## Execution handoff

Branch from the active development branch, not `main` (CLAUDE.md Branch Management). Phases 1-2 + Tasks 10-11 are pure TS (no WASM rebuild) — the lazy service and edge resolver inject all I/O/wasm. Butteraugli *scoring* (Tasks 7/9, and the lazy `build` dep in Task 10) needs a wasm build with the butteraugli bridge; SSIM/PSNR need none. The edge worker itself (auth + origin Range fetch) is deploy-target-specific glue outside this package — Task 11 ships the testable decision, not the deployment.
