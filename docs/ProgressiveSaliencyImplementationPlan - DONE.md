# ProgressiveSaliencyImplementationPlan

Multi-lens review (19 lenses: strategic, API, pipeline, state, data structures, hot kernels, boundaries, support, owl, reversal, astronomy, ML, gaming, photogrammetry, Butteraugli, AR, color-engine, gap analysis, bird's-eye) of:

- `packages/jxl-progressive/src/progressive-stream.ts` (Agent 1)
- `packages/jxl-progressive/src/saliency-policy.ts` (Agent 2)
- `packages/jxl-progressive/src/progressive-scheduler.ts` (Agents 3, 4, 5 — **sequential**, same file)

## Ground rules for all agents

1. **One source file per agent** (listed above). The matching test file under `packages/jxl-progressive/test/` **is in scope** for the agent's own items — add/adjust tests there. No other files.
2. Read `docs/rejected optimizations.md` entries for these files first. Do **not** re-propose: B1 sort→scan in `selectBestCenter`, new policy exports/options/ImageTypes (Agent B record), `convergedByteEnd` clamp (D6 — schema v1 has no such field; verified again 2026-06-10), soft preemption, pixel pools, drain callbacks (CLAUDE.md table).
3. Agents 3 → 4 → 5 run in that order (same file; later agents build on earlier fixes). Agents 1 and 2 are independent and can run any time.
4. Verification: `npm test` (or the package's vitest run) for `packages/jxl-progressive` must pass before claiming completion.

## Data-flow map (context, no action)

`ProgressiveGallery.tick()` (RAF) picks jobs by `fairnessScore` → `startDecode()` creates a `DecodeSession` via injected `SessionFactory` → fire-and-forget `fetchTier`/`fetchFull` (progressive-stream) pushes HTTP bytes into the session → gallery consumes `streamTierFrames(session)` and forwards frames via `onFrame`. Manifests come from `ProgressiveCache.getManifest` or network (`validateManifest`). Tiers are **cumulative from byte 0**; `fetchTierWithPrefix` (shipped, currently **unconsumed**) supports delta upgrades: push cached prefix → Range-fetch tail. `saliency-policy.ts` is encode-side policy with no runtime consumer, but `ProgressiveManifest.saliency` (centerX/centerY/confidence) already flows to the client.

**Design invariant — keep the tier step-walk.** `startDecode` upgrades one tier per pass (`nextTier`) so every visible image gets DC before any image gets preview/full (gallery fairness). Do not "optimize" this into direct-to-target fetching; with prefix reuse (E-1) the step-walk's byte overhead disappears while fairness is preserved.

---

## Agent 1 — `progressive-stream.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### 1-A (BUG, correctness) Validate `Content-Range` start in `fetchTierWithPrefix`

A 206 whose range start ≠ `prefix.length` (misbehaving proxy/CDN, normalized or shifted range) is currently spliced after the prefix verbatim → silently corrupt codestream, decoder error far from the cause. Validate the header; on mismatch cancel the session and throw `RangeNotSupportedError` so the scheduler's fallback path (plain `fetchTier`) recovers.

```ts
if (resp.status !== 206) { /* existing path */ }
const cr = resp.headers.get("Content-Range"); // "bytes <start>-<end>/<total>"
const m = cr === null ? null : /^bytes (\d+)-/.exec(cr);
if (m === null || Number(m[1]) !== prefix.length) {
  await session.cancel("Content-Range mismatch for delta fetch; scheduler will fallback");
  throw new RangeNotSupportedError(url);
}
```

This is HTTP-protocol correctness at the stream layer, not format validation (which stays with libjxl).

### 1-B (IMPROVEMENT, error typing) Typed `HttpError` for `fetchFull`

`fetchFull` throws a bare `Error` with the status baked into the message. Scheduler-side retry/backoff (Agent 3, C-3) wants to classify transient (429/5xx) vs permanent (404/410) without string matching. Add:

```ts
export class HttpError extends Error {
  constructor(public readonly status: number, public readonly statusText: string, url: string) {
    super(`[progressive-stream] HTTP ${status} ${statusText}: ${url}`);
    this.name = "HttpError";
  }
}
```

Throw it in `fetchFull`'s `!resp.ok` branch (message unchanged → existing tests keep passing on `.message`).

### 1-C (NIT, consistency) Abort check before the prefix-covers `close()`

In `fetchTierWithPrefix`, the `prefix.length >= tier.byteEnd` branch closes the session without re-checking the signal, while every other transition is guarded. Add `throwIfAborted(signal);` immediately before `await session.close();` so an abort raced against a cache hit doesn't deliver a "successful" close.

---

## Agent 2 — `saliency-policy.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**Context you must weigh:** the full Agent-B bundle (B1–B6) was rejected — this module is a near-island (no runtime consumer; `ProgressiveManifest.saliency` is the encode-side output that does reach clients). The rejection record names a "B2-only minimal path" as the acceptable future shape. The two items below are exactly that minimal hardening — **zero new exports, options, types, or ImageTypes**. If you judge the "wait for a consumer" condition as still controlling, reject with that reason.

### 2-A (BUG, latent) NaN-safe threshold checks

`NaN` confidence passes both gates: `NaN < threshold` is `false`, so `shouldUseSaliency({ confidence: NaN, ... })` returns `true` and `selectBestCenter` can return a NaN-confidence centre that then poisons `manifest.saliency.confidence`. Invert the comparisons so NaN fails closed:

```ts
// shouldUseSaliency
if (!(confidence >= confidenceThreshold)) return false;
// selectBestCenter
if (best === undefined || !(best.confidence >= threshold)) return null;
```

### 2-B (BUG, latent — the acknowledged "B2") Non-finite guard in `normaliseCenter`

`imageWidth`/`imageHeight` of 0 (or NaN) yields Infinity/NaN normalised centres that would be serialized into manifests. Minimal guard, no new surface:

```ts
if (!(imageWidth > 0) || !(imageHeight > 0)) {
  throw new RangeError(`[saliency-policy] invalid image dimensions ${imageWidth}x${imageHeight}`);
}
```

Also add one JSDoc line on the module header noting its output lands in `ProgressiveManifest.saliency` (the consumer linkage), so the island status is documented rather than rediscovered.

---

## Agent 3 — `progressive-scheduler.ts` (correctness pass — run FIRST)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### C-1 (BUG, critical) Fire-and-forget fetch: unhandled rejection + false tier advance

`startDecode` does `void fetchTier(...)`. Every fetch failure (416, network drop, abort) rejects a promise nobody handles → `unhandledrejection` events in browsers, process warnings in Node. Worse: when the fetch fails and cancels the session, `frames()` may end without throwing, the loop exits with `abort.signal.aborted === false`, and the job is **marked upgraded** (`currentTier = target`, `onTier` fired) for a tier that never arrived — and `onError` never fires. Fix by capturing the promise:

```ts
let fetchError: unknown;
const fetchDone = (manifestTier !== undefined
  ? fetchTier(job.jxlUrl, manifestTier, session, { signal: abort.signal })
  : fetchFull(job.jxlUrl, session, { signal: abort.signal })
).catch((e: unknown) => { fetchError = e; });

for await (const frame of streamTierFrames(session)) {
  if (abort.signal.aborted) break;
  this.opts.onFrame(job.id, frame);
}
await fetchDone;
if (fetchError !== undefined && !abort.signal.aborted) {
  throw fetchError instanceof Error ? fetchError : new Error(String(fetchError));
}

if (!abort.signal.aborted) { /* existing tier-advance */ }
```

The `.catch` is attached synchronously, so no rejection ever goes unhandled even if `frames()` throws first.

### C-2 (BUG) Viewport-exit cleanup timer double-decrements `activeDecoders`

The timer aborts, nulls `job.decoderAbort`, **and decrements** `activeDecoders`; `startDecode`'s `finally` then decrements again for the same decode. `Math.max(0, …)` masks it at zero, but mid-flight the undercount over-admits decoders past `maxActiveDecoders`. Also: timers stack (one per exit event, none stored), survive `destroy()`/`unobserve()`, and are untestable (no injectable clock). Fix — the timer only aborts; `finally` owns accounting:

```ts
// job field: cleanupTimer: ReturnType<typeof setTimeout> | null  (init null)
private scheduleViewportExitCleanup(job: ProgressiveImageJob): void {
  if (job.cleanupTimer !== null) return;
  job.cleanupTimer = this.setTimeoutFn(() => {
    job.cleanupTimer = null;
    if (!job.visible && !job.selected) job.decoderAbort?.abort("left-viewport");
  }, 2000);
}
```

Clear the timer (`clearTimeoutFn` + null) when the job becomes visible/nearViewport again, in `select()`, `unobserve()`, and `destroy()`. Add `timeoutScheduler?`/`timeoutCanceller?` to `GalleryOptions` mirroring the existing raf injectables (default `setTimeout`/`clearTimeout`) so the 2 s grace becomes testable.

### C-3 (BUG) Retry storm on persistent failure

After `onError`, the job keeps `currentTier < targetTier` and `decoderAbort === null`, so the next tick re-admits it immediately — a dead URL is re-fetched at decode-slot speed forever (CPU, network, server hammering). Add bounded exponential backoff (job fields `errorCount: number`, `nextRetryAt: number`, both init 0):

- In `startDecode`'s catch: `job.errorCount++; job.nextRetryAt = now + Math.min(1000 * 2 ** job.errorCount, 30_000);`
- On success: reset both to 0.
- In `tick()`'s filter: `.filter((j) => now >= j.nextRetryAt)`.
- Optional refinement with 1-B: `HttpError` with status 404/410 → set `nextRetryAt = Infinity` (permanent; job effectively parked until `setTargetTier`/`select` resets it — reset both fields in those mutators).

These constants are bounded-standard backoff, justified by the storm bug — not a speculative tunable.

### C-4 (BUG, perf) Manifest 404 re-fetched on every tier pass

`fetchAndCacheManifest` returning `null` leaves `job.manifest === null`, so every `startDecode` re-fetches the manifest (repeated 404 + latency on each of dc/preview/full). Add job field `manifestChecked: boolean` (init false); set true after the first network attempt regardless of outcome; guard the fetch with it. (`getManifest` cache lookup can still run — it's cheap and TTL-driven.)

### C-5 (BUG, doc/behavior mismatch) `getJob` returns live internal object

Docstring says "returns a copy"; it returns the mutable internal job — tests can corrupt scheduler state. Return `{ ...job }` (shallow copy is what the docstring promises; fields are primitives + refs).

### C-6 (NIT) `destroy()` hygiene

Make idempotent (`if (this.destroyed) return;`), null `rafHandle` after cancel, and clear all `cleanupTimer`s (with C-2).

### C-7 (BUG, logic) `deselect()` mis-ranks offscreen jobs

`deselect` sets `priority = visible ? 3 : 5` — an offscreen job gets near-viewport priority 5 (not 7) and keeps `targetTier "preview"`, scheduling a fetch for something offscreen. Extract one helper used by both `handleIntersection` and `deselect` (latest IO state lives on the job):

```ts
private recomputePriority(job: ProgressiveImageJob): void {
  if (job.selected) { job.priority = 1; return; }
  job.priority = job.visible ? 3 : job.nearViewport ? 5 : 7;
}
```

(Note: `visible` stores partial visibility; the fully-visible-3 vs partial-4 distinction needs a `fullyVisible` job field if preserved — acceptable to collapse 3/4 here or add the field; pick one and keep `handleIntersection` and `deselect` consistent.)

### C-8 (NIT, robustness) Fully-visible epsilon

Browsers report `intersectionRatio` fractionally below 1.0 at the `1.0` threshold (subpixel layout). Use `>= 0.99`.

### C-9 (BUG, leak) `observe()` with duplicate id

Re-observing an existing id overwrites the job but never unobserves the old element → IntersectionObserver leak and a stale `decoderAbort` never aborted. First line: `if (this.jobs.has(id)) this.unobserve(id);`.

---

## Agent 4 — `progressive-scheduler.ts` (efficiency pass — run AFTER Agent 3)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### D-1 (PERF, headline) Event-driven tick instead of perpetual 60 fps RAF loop

`scheduleTick` re-arms RAF unconditionally: an idle gallery burns a filter+sort over all jobs 60×/s forever (battery, main-thread). Replace with a coalescing dirty-flag:

```ts
private tickPending = false;
private requestTick(): void {
  if (this.destroyed || this.tickPending) return;
  this.tickPending = true;
  this.rafHandle = this.raf(() => {
    this.tickPending = false;
    this.rafHandle = null;
    this.tick();
  });
}
```

Call `requestTick()` from: constructor (initial), `handleIntersection`, `observe`, `select`/`deselect`/`setTargetTier`, `startDecode`'s `finally` (slot freed), and when C-3 sets `nextRetryAt` (arm a one-shot `timeoutScheduler` for the earliest retry so a sole failing job isn't stranded). Delete the self-re-arming `scheduleTick`. Semantics preserved: RAF still coalesces bursts to one tick/frame; background-tab behavior unchanged (RAF was already frozen there).

### D-2 (PERF) O(1) element→job lookup in `handleIntersection`

Current code is O(entries × jobs) — 50 jobs × a burst of entries on fast scroll is thousands of comparisons per callback. Maintain `private readonly byElement = new Map<Element, ProgressiveImageJob>()` updated in `observe`/`unobserve`/`destroy`; `handleIntersection` becomes a direct `.get(entry.target)`. (Also removes the subtle "two jobs share an element → second never updates" break.)

### D-3 (PERF, micro) Don't recompute `fairnessScore` inside the sort comparator

The comparator calls it twice per comparison (O(n log n) recomputes, each allocating a `ranks` record via `tierRank`). Map once to `[score, job]` pairs, sort on score. Hoist `tierRank`'s `ranks` object to module scope while there.

### D-4 (PERF, network) No-manifest fallback downloads the entire file per tier step

With `manifest === null`, each step (none→dc, dc→preview, preview→full) runs `fetchFull` — the **whole resource downloaded and decoded up to 3×**. After a successful `fetchFull`, the session has consumed every byte; nothing more is fetchable. Set `job.currentTier = job.targetTier` (not `target`) on the fallback path's success, and fire `onTier` with that. One conditional; eliminates 2 redundant full downloads per manifest-less image.

### D-5 (PERF, latency + wires dead option) Manifest prefetch for near-viewport jobs

`maxConcurrentFetches` is declared, defaulted, and never read; manifest fetch currently happens inside `startDecode`, spending a scarce decoder slot on a small JSON round-trip. Prefetch instead: when a job first becomes `nearViewport` (in `handleIntersection`), if `manifest === null && !manifestChecked` and in-flight prefetches < `maxConcurrentFetches`, fire `void this.prefetchManifest(job)` (the existing `fetchAndCacheManifest` + an in-flight counter + `manifestChecked` from C-4, with a `.catch(() => {})`). By the time the job wins a decoder slot the tier table is already local. Keep the in-`startDecode` lookup as fallback.

---

## Agent 5 — `progressive-scheduler.ts` (feature pass — run AFTER Agent 4)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### E-1 (FEATURE, headline) Prefix-delta tier upgrades — stop re-downloading the prefix

Today every upgrade re-fetches bytes 0..byteEnd: an image walked dc→preview→full downloads the dc prefix 3× and the preview prefix 2×. The earlier E1 proposal was rejected **solely on scope** (needed cache-interface and stream-file edits). Both blockers are gone, verified 2026-06-10: `fetchTierWithPrefix` + `RangeNotSupportedError` shipped in progressive-stream (commit 0575cb1d), and `ProgressiveCache.getByteRange/setByteRange(jxlUrl, tier)` already exist. Everything below is scheduler-file-only.

**Capture at the network boundary** via the injectable `fetchImpl` (no DecodeSession wrapping — ingestion stays a single ordered push stream, per the clean-ingestion guardrail):

```ts
function teeFetch(onChunk: (c: Uint8Array) => void): { fetchImpl: typeof fetch; settled: () => Promise<void> } {
  let pump: Promise<void> = Promise.resolve();
  const fetchImpl: typeof fetch = async (input, init) => {
    const resp = await fetch(input, init);
    if (!resp.ok || resp.body === null) return resp;
    const [toDecoder, toCapture] = resp.body.tee();
    pump = (async () => {
      const r = toCapture.getReader();
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        onChunk(value);
      }
    })().catch(() => { /* abort/network error: partial capture is still a valid prefix */ });
    return new Response(toDecoder, resp); // preserves status (incl. 206) + headers
  };
  return { fetchImpl, settled: () => pump };
}
```

**Wiring in `startDecode`** (job fields `prefixChunks: Uint8Array[]`, `prefixBytes: number`):

1. Resolve starting prefix: in-memory `concat(job.prefixChunks)` if non-empty, else `await this.cache.getByteRange(job.jxlUrl, job.currentTier)` when `currentTier !== "none"` (convert to `Uint8Array`), else none.
2. With a prefix and a `manifestTier`: call `fetchTierWithPrefix(url, manifestTier, session, prefix, { signal, fetchImpl })`. On `RangeNotSupportedError`: clear captured chunks, fall back to plain `fetchTier` (tee captures from byte 0 again). Without a prefix: `fetchTier` as today — tee captures the whole cumulative prefix.
3. `onChunk` appends to `job.prefixChunks` (chunks arrive in stream order; with the prefix path, memory layout = cachedPrefix ++ capturedTail).
4. On successful tier completion: `await tee.settled()` (capture branch may trail the decode branch), then `void this.cache.setByteRange(job.jxlUrl, target, concatenatedPrefixBuffer)` — keyed by the tier just completed, matching the cache's cumulative-range key convention.
5. Retention: drop `prefixChunks` after full-tier persistence; also drop them in the C-2 cleanup timer and `unobserve` (bounded memory; cache holds completed tiers). Partial chunks from an aborted fetch are **kept** until cleanup — a viewport flicker resumes from the partial prefix instead of byte 0.

Tee backpressure note: the capture branch reads eagerly so `tee()` buffering never exceeds the bytes we are deliberately retaining anyway (≤ tier byteEnd).

Net effect: dc→preview→full transfers ≈ `fullEnd` bytes total instead of `dcEnd + previewEnd + fullEnd` (measured shape: ~40–60% transfer reduction on 3-tier walks), and aborted work becomes resumable. The decoder still re-decodes the prefix (CPU) — network is the scarce resource for remote galleries; this trade is deliberate.

### E-2 (FEATURE) Wire `bytesLoaded` + `onProgress`

`job.bytesLoaded` is declared and never written (open-loop scheduler, acknowledged in the E1 record). The E-1 tee already sees every byte: set `job.bytesLoaded = startingPrefixLength + capturedBytes` in `onChunk`, and add `onProgress?: (id: string, bytesLoaded: number, byteTarget: number | undefined) => void` to `GalleryOptions` (byteTarget = `manifestTier?.byteEnd`). Gives galleries real loading bars and gives future adaptive policies their feedback signal. Throttle to ≥1 frame between calls if chunk rate is high (reuse `raf` coalescing or a simple `now - lastEmit > 50` guard).

### E-3 (FEATURE, small) `onManifest` callback

The manifest (dimensions, orientation, `saliency` centre, tier byte sizes) reaches the scheduler but is invisible to the app — `getJob` is test-only. Add `onManifest?: (id: string, manifest: ProgressiveManifest) => void`, fired once per job when the manifest is first obtained (cache or network; flag on the job). Unlocks, with zero further scheduler surface: aspect-ratio placeholders before the first frame (CLS elimination), saliency-driven `object-position` crops for thumbnails (the first real client-side consumer of the saliency pipeline), and byte-budget UI. Pairs with D-5 (manifest arrives early).

### E-4 (FEATURE, wires dead option — flag for scrutiny) `autoProfile`

`autoProfile` defaults to `true` and does nothing — dead, misleading API surface. Minimal honest wiring: when `autoProfile !== false` and the caller did **not** set `maxActiveDecoders`, derive it as `Math.min(4, Math.max(2, Math.floor(navigator.hardwareConcurrency / 2)))` (guard `typeof navigator`). Bounded above by the existing default (4), so behavior only ever gets more conservative on weak devices. CLAUDE.md's "no tunables without evidence" applies — if you judge the heuristic unjustified, the alternative is to document the option as reserved/no-op in its JSDoc; do one or the other, not nothing.

### E-5 (FEATURE, opt-in integrity) Hash verification on full tier

`checkHash` (progressive-manifest) is exported and unused. Once E-1 captures full-tier bytes, add `verifyHash?: boolean` (default **false**) to `GalleryOptions`: after persisting a `full` tier, `const ok = await checkHash(job.manifest, buf)`; on mismatch `await this.cache.invalidate(job.jxlUrl)` (method exists), reset the job's prefix state, and surface via `onError` with a descriptive Error. Default-off because SHA-256 over full files is real CPU; opt-in for archival/photogrammetry consumers where byte fidelity is contractual.

---

## Deferred — do NOT implement (coordination points outside these files)

- **`convergedByteEnd` clamp** — manifest schema v1 has no such field (re-verified in `progressive-manifest.ts`); D6 rejection stands until ingest+schema ship it. When it lands: `Math.min` clamp on the full-tier `byteEnd` plus a `requireFullBytes` bypass for photogrammetry (D6's recorded "positive elements").
- **Validating `manifest.saliency` in `validateManifest`** — progressive-manifest.ts is out of scope; currently the block passes through unvalidated. Worth a future item.
- **Direct-to-target tier jumps** — rejected by design analysis here (breaks gallery fairness; see invariant above). Recorded so it isn't re-proposed.
- **Persisting partial (non-tier-boundary) prefixes to OPFS** — cache keys are per-tier; partials stay in-memory only (E-1 step 5).

## What implementing this achieves

The correctness pass (Agents 1–3) closes the silent failure modes of the progressive path: fetch failures currently vanish into unhandled rejections while jobs are stamped as upgraded with bytes that never arrived; a single dead URL turns the tick loop into a retry storm; a mistimed viewport exit corrupts the decoder-slot accounting that the whole admission system depends on; and a misbehaving CDN can splice mismatched ranges into a codestream undetected. After this pass, every byte path either completes, fails loudly through `onError` with typed causes, or backs off — the scheduler's bookkeeping (`activeDecoders`, tier state, timers) becomes an invariant rather than a hope, and the policy module can no longer emit NaN into manifests that ship to every client.

The efficiency and feature passes (Agents 4–5) convert the gallery from open-loop and wasteful to closed-loop and frugal. An idle gallery stops consuming 60 ticks per second; intersection bursts cost O(1) per entry; manifest-less images stop downloading themselves three times. The headline change — prefix-delta upgrades over the already-shipped `fetchTierWithPrefix` and the already-existing byte-range cache — cuts tier-walk transfer by roughly half and makes aborted work resumable, which directly serves the field/offline reality of a biodiversity platform: flaky rural bandwidth wastes nothing, viewport flicker costs nothing, and revisited specimens paint from local bytes. `bytesLoaded`/`onProgress` finally gives the scheduler (and future adaptive policies) the feedback signal the E1 record diagnosed as missing.

Strategically, `onManifest` is the smallest possible door to the largest pending payoffs: layout-stable galleries (dimensions before first paint), the first genuine client-side consumer of the saliency pipeline (subject-centred thumbnail crops — and later, attention-aware AR and ML crop hints from the same field), and opt-in hash integrity for the photogrammetry/digital-twin work where a JXL is not a picture but a measurement. Each agent's scope is one file, every cross-file dependency named here already exists in the tree, and everything speculative has been pinned to the rejection log — so the plan upgrades the pipeline without re-opening any settled argument.
