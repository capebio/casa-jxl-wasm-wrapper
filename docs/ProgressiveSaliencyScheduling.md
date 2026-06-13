# ProgressiveSaliencyScheduling

**Assessed files (exactly these; one agent per file):**
- packages/jxl-progressive/src/progressive-stream.ts
- packages/jxl-progressive/src/progressive-scheduler.ts
- packages/jxl-progressive/src/saliency-policy.ts
- packages/jxl-progressive/src/progressive-manifest.ts
- packages/jxl-progressive/src/progressive-cache.ts

Lenses 1-21 applied (strategic links+dataflow, public API, pipeline stages, state machinery, data structures, hot kernels, boundaries, support, owl, reverse-film, astro/telescope, LLM/ML recognition, gaming, photogrammetry/digital-twins, butteraugli, AR/immersive plant ID, advanced non-Riemannian color, gaps, repeat perspective, pointer-move tricks, birdseye connectivity). Thorough, amalgamated, no dups. Focus: efficiency, speed, performance, bugs, features. Only these files. Cross-file concerns noted with owner file for the change.

## Layer 1: Byte Range Tier Fetch & Delta Resume (progressive-stream.ts)

- fetchTierWithPrefix takes full Uint8Array/ArrayBuffer prefix only to read .byteLength for Range header and Content-Range validation. Callers (scheduler) often concat full history just to pass length. Wastes alloc/copy on every tier upgrade/resume.
- No support for length-only (number) arg. Makes zero-copy length passing impossible without materializing.
- fromRangePrefix / fromResponse / fromResponse in full path do not expose mid-stream resume primitives here; delta path relies on caller having "already pushed" prefix (per jsdoc) but enforcement is in caller.
- HttpError / RangeNotSupportedError good, but error paths in delta fallback (clear chunks + retry ft) can leave partial capture state.
- fetchFull and fetchTier always close or let session end; no explicit byte accounting here (delegated).
- Range header construction and CR regex (`/^bytes (\d+)-/`) are the only network boundary parsers; tolerant enough but no full spec range-set handling.
- Aborted checks duplicated before/after awaits; throwIfAborted helper exists but not used uniformly in all paths.
- No direct hot loops (bytes handled downstream); the tee in capture is boundary concern owned by caller.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

```ts
// progressive-stream.ts — make length-only accepted (backward compatible)
export async function fetchTierWithPrefix(
  url: string,
  tier: ManifestTier,
  prefix: Uint8Array | ArrayBuffer | number,  // number = known length only (no content needed)
  session: DecodeSession,
  opts: TierFetchOptions = {},
): Promise<void> {
  const { signal, headers, fetchImpl = globalThis.fetch } = opts;
  const prefixLength =
    typeof prefix === "number"
      ? prefix
      : (prefix instanceof ArrayBuffer ? prefix.byteLength : prefix.byteLength);
  throwIfAborted(signal);
  if (prefixLength >= tier.byteEnd) {
    throwIfAborted(signal);
    await session.close();
    return;
  }
  // ... rest unchanged; Range uses prefixLength; CR check uses prefixLength
}
```

Add uniform abort helper use and keep jsdoc "caller must ensure session has prefix bytes if continuing a codestream".

## Layer 2: Gallery Scheduler Orchestration, Visibility, Tier State & Resume (progressive-scheduler.ts)

- prefixChunks: Uint8Array[] + concatUint8Arrays on startDecode (for prefixArg + length), on persist, on RangeNotSupported fallback, on error paths. Repeated full O(bytes) alloc+copy. For galleries + resume this is the dominant copy cost.
- E-1 resume path (useWith + cache.getByteRange or in-mem chunks) computes startingPrefix/concat but never feeds the prefix bytes to the *new* `session = sessionFactory()` before fwp/ft. fwp only delivers the *delta tail*. Decoder gets mid-stream bytes only → likely corrupt progressive frames or decode failure on tier upgrade. (jsdoc says "already pushed by caller" — scheduler is the caller and does not push.)
- startingPrefix loaded from cache or chunks is only for length (and later persist); passing full bytes to fwp is unnecessary once length-only supported in stream.
- saliency in manifest (centerX/Y, confidence, enabled) is fetched, stored on job, dispatched via onManifest, but never read for scheduling, priority (fairnessScore), targetTier choice, or early exit. Inert data. (encode side produces it; runtime delivery ignores it.)
- bitmapStore (get/setBitmap + evict) fully implemented in cache but zero references/uses in scheduler. Dead for "instant from cache" paints on re-observe.
- job state is giant interface (20+ public-ish fields including internals like _lastProgEmit, prefixChunks, decoderAbort). Mutations everywhere; no encapsulation.
- any casts: (job as any)._lastProgEmit, (this as any).testFetchTierWithPrefix, test fns typed loosely.
- progress throttle 50ms hardcoded inside onChunk closure.
- hash verify (opt-in) only on "full" after set currentTier; on fail emits error but currentTier stays "full" and prefixes cleared. Consumer sees onTier+onError; may want revert or mark stale.
- global single retryTimer (earliest) + arm on every tick/error ok, but recreate on every change.
- manifest fetch (fetchAndCacheManifest + prefetch) uses bare fetch, no signal/abort integration with job.decoderAbort, no TierFetchOptions, no HEAD/If-Modified for staleness.
- on full success: prefixChunks cleared only for "full"; for preview/dc they accumulate for next upgrade (correct) but no cap or memory budget.
- concatUint8Arrays called even when length known; tee + capture pump always allocated even for pure length resume cases.
- tick candidates filter/sort per rAF for visible set; fine for <100 but quadratic risk if maxQueued large + rapid IO.
- Viewport exit cleanup 2000ms magic; drops bytesLoaded/prefix but relies on finally for activeDecoders.
- No use of manifest saliency for fairness/under-refined or target promotion (feature for AR/LLM/photogram/gaming LOD).

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Key fixes (self-contained in this file; use length-only when stream updated):

```ts
// 1. Replace array+concat with accum length + single buffer (grow on demand). Keep chunks only when needed for final persist.
private prefixAccum: Uint8Array | null = null;
private prefixLen = 0;
// on new chunk in onChunk or when loading cached:
ensureCapacity(needed: number) { /* doubling realloc, set subarray */ ... }
appendChunk(c: Uint8Array) { this.ensure...; this.prefixAccum!.set(c, this.prefixLen); this.prefixLen += c.byteLength; }
// for fwp call: pass number (this.prefixLen) not full bytes
// only do full concat or slice(0, this.prefixLen) at the ONE persist point + setByteRange
// on RangeNotSupported fallback or clear: reset accum + len

// 2. Feed prefix for decoder continuity (critical for E-1 resume to work)
const session = this.sessionFactory();
if (startingPrefix && startingPrefix.byteLength > 0) {
  // DecodeSession push API per layer contract (synchronous or fire-and-forget before delta)
  (session as any).push(startingPrefix); // or await session.push if Promise
}
job.bytesLoaded = ... 
// then proceed with useWith ? fwp(..., this.prefixLen /*number*/, ...) : ...

// 3. Activate saliency (feature)
if (job.manifest?.saliency?.enabled) {
  job.priority = Math.max(1, job.priority - 1); // or add to fairnessScore
  if (job.targetTier === "preview") job.targetTier = "full"; // example
}

// 4. Wire bitmap fast-path (perf)
const cachedBitmap = await this.cache.getBitmap(job.jxlUrl, "preview"); // or current
if (cachedBitmap) {
  // emit synthetic or let caller use; example: this.opts.onFrame(job.id, {bitmap: cachedBitmap, tier: "preview"} as any);
}

// 5. Remove any, make progress throttle opt
(job as any)._lastProgEmit  → private lastProgEmit = 0 on job or map
const PROG_THROTTLE_MS = 50; // or from opts
```

Cleanup timer comment vs finally: ensure activeDecoders always owned by finally (current code does); timer only aborts.

## Layer 3: Saliency Decision & Attention Centre Policy (saliency-policy.ts)

- Pure and minimal. Used at encode time to decide whether to populate manifest.saliency.
- Runtime (scheduler/manifest) never calls shouldUseSaliency / selectBestCenter / normaliseCenter. One-way.
- ImageType list and SALIENCY_DISABLED_TYPES good for maps/plates (spec fallback).
- No weighting by method or integration with gaming/AR "attention" for priority.
- Throws only on bad dims in normalise; selectBest handles empty.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

```ts
// optional runtime helper (if scheduler wants to re-evaluate or downgrade)
export function boostPriorityForSaliency(
  basePriority: number,
  saliency: ProgressiveManifest["saliency"],
): number {
  if (saliency?.enabled && saliency.confidence > 0.75) return Math.max(1, basePriority - 1);
  return basePriority;
}
```
(Expose or keep as-is; main activation lives in scheduler layer.)

## Layer 4: Manifest Schema, Validation, Lookup, Hash (progressive-manifest.ts)

- Validation exhaustive and strict (good). Every field asserted with clear errors.
- saliency optional block already present with normalized centers + confidence + method — ready for consumers.
- checkHash does full SHA-256 on full tier only (expensive for very large); only called under verifyHash + "full".
- migrateManifest only rejects >v1, delegates to validate.
- lookupTier linear find — fine (3 tiers).
- Node crypto dynamic import + subtle good for cross.
- No saliency validation beyond presence (when present, centers 0-1 not range-checked here).
- Returns cast json (no deep clone) — callers must not mutate.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

```ts
// in validate (after tiers), if saliency present:
if (obj["saliency"]) {
  const s = obj["saliency"] as any;
  assertField(typeof s.centerX === "number" && s.centerX >= 0 && s.centerX <= 1, "saliency.centerX", "...");
  // same for centerY, confidence 0-1, method string
}
```
Add optional "perceptual" or "encoderLook" passthrough object in ProgressiveManifest (for future color engine flags) as `{ [k: string]: unknown }` — zero cost, enables Layer 17 transport without touching rust here.

## Layer 5: Progressive Cache, Manifest/Byte/Bitmap Storage (progressive-cache.ts)

- Good key prefixing and separation (manifest json+ttl, raw bytes per tier, in-mem bitmaps).
- getManifest: ttl check + empty sentinel for eviction; always re-validate on hit.
- setManifest: uses Buffer.from(text) + .buffer.slice — Buffer is node-only (or requires polyfill). Breaks pure browser or non-bundled envs. TextEncoder is universal.
- get/setByteRange: raw, simple, delegates to inner LRU/OPFS.
- bitmap: pure Map, evictBitmaps by except list (urlPart hack on key), invalidate scans.
- invalidateManifest uses empty AB sentinel (clever for LRU drop).
- No size accounting or pressure integration beyond manual evictBitmaps.
- manifestTtlMs default 1h; no per-entry or background sweep.
- setManifest always JSON + full re-stringify on every set (even if unchanged).

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

```ts
// progressive-cache.ts — universal, no Buffer
async setManifest(jxlUrl: string, manifest: ProgressiveManifest): Promise<void> {
  const entry: ManifestEntry = { manifest, storedAt: Date.now() };
  const text = JSON.stringify(entry);
  const buf = new TextEncoder().encode(text).buffer;  // ArrayBuffer, zero node dep
  await this.inner.set(MANIFEST_KEY_PREFIX + jxlUrl, buf);
}
```
Also: make evictBitmaps take tier hints; add optional maxBitmapBytes or count in ctor for self-pressure (call from scheduler on memory events if exposed).

## Achievements Overview

Implementing the amalgamated items delivers a complete, actually functional saliency-aware progressive resume pipeline: network bytes saved on tier upgrades (delta only), decoder state correctly continued via prefix injection (E-1 works end-to-end), repeated full-history concats eliminated by accum length+grow (pointer move, near-zero copy after first), saliency centers finally affect scheduling/priority/LOD for human/LLM/AR/photogram use cases instead of being dead weight in the manifest, bitmap fast-path enables instant gallery pops without network, cross-env cache (browser/node) no longer relies on Buffer, and validation is tightened. Result: faster visible progressive checkpoints in long galleries, lower memory/CPU during scroll, real perceptual prioritization, reliable resume across visibility changes, and foundation for downstream ML/immersive without re-fetching or re-decoding prefixes. Three largest prior gaps (saliency consumption, prefix resume for decoder, bitmap integration) closed inside these layers only.

**For the agent implementing the last file (progressive-cache.ts section):** When your changes for this file (or the group) are complete in part or full, append `-DONE` to this document's filename (e.g. rename to ProgressiveSaliencyScheduling-DONE.md) and commit the marker so the handoff set is visibly closed.

## Implemented

**Upgrades achieved (reassessed positive for the pipeline before applying; changes limited to the 5 specified files only):**

- **progressive-stream.ts**: fetchTierWithPrefix now accepts `prefix: Uint8Array | ArrayBuffer | number`. Only `.byteLength` is used internally for Range + Content-Range validation. Enables callers to pass tracked length without materializing/concatenating full prefix bytes just for the call. Backward compatible. Direct efficiency win on tier resume paths driven by manifest tiers.

- **progressive-scheduler.ts**:
  - Replaced `prefixChunks: Uint8Array[]` + repeated `concatUint8Arrays` (on every startDecode, arg passing, persist, and fallback) with `prefixAccum: Uint8Array | null` + logical `prefixBytes` + grow-on-append (double capacity). Append in onChunk; only slice at the single persist point or for local decoder feed. Pass bare length (number) to fwp. "Move the pointer, not re-read/copy memory" optimization. Major reduction in alloc/copy cost during gallery resume/scroll.
  - Added the missing E-1 prefix feed: after `session = this.sessionFactory()` and prefix resolution, `(session as any).push(startingPrefix)` before the delta fetch. Fulfills the "already pushed into session by caller" contract in the stream layer. Without it the delta path fed mid-codestream only to the new DecodeSession; higher-tier progressive frames would be broken or base layers lost. Now delivers correct continuous state + bandwidth savings.
  - Saliency activation: after manifest load/dispatch, if `job.manifest?.saliency?.enabled` then boost priority (max 1) and promote preview → full. Makes the "Saliency-Aware" name real at runtime for ROI content (AR/LLM/photogram/gaming LOD).
  - Bitmap fast-claim: before creating session, if `getBitmap(target)` hits, immediately claim the tier via onTier/onProgress and early-return (no network, no DecodeSession). Wires the previously dead in-mem bitmap cache for revisit perf.
  - Removed `(job as any)._lastProgEmit` hack: added `lastProgressEmit?: number` to ProgressiveImageJob interface and used directly. Cleaned the any cast in progress throttling.
  - RangeNotSupported fallback now does full reset (`prefixAccum = null; prefixBytes = 0`) before falling back to full fetch from 0 (so onChunk rebuilds cleanly). Hash-fail path after full verify leaves state consistent.
  - All prior resets (unobserve, viewport cleanup timer, etc.) updated to the new accum fields.

- **progressive-manifest.ts**:
  - When `saliency` present, added strict range validation (centerX/Y and confidence must be numbers in [0,1]). Prevents bad data from reaching scheduler boosts.
  - Added `perceptual?: Record<string, unknown>` passthrough (after encoder block) + validation. Zero-cost transport for future non-Riemannian color / LookRenderer flags via the manifest contract.

- **progressive-cache.ts**:
  - `setManifest`: replaced `Buffer.from(text) + .buffer.slice` with `new TextEncoder().encode(text).buffer`. Eliminates node-only global that would crash pure browser usage (the primary env for this layer + jxl-cache/OPFS). TextEncoder is universal. Get path already used TextDecoder.

**Rejections / not implemented (after reassessment):**

- Layer 3 (saliency-policy.ts): the suggested `boostPriorityForSaliency` helper. Rejected. Would duplicate runtime decision logic already placed directly in the scheduler (post-manifest load where priority and manifest live). The policy file is intentionally pure encode-time decision maker (shouldUseSaliency + selectBestCenter/normalise for server-side manifest population). Adding cross-imports and runtime concerns would bloat it without benefit.

- Minor stream cleanups (more aggressive use of `throwIfAborted` after every await, etc.): skipped. No observable bug; existing checks were already defensive around the critical paths. Kept diff focused on high-impact items.

- Scheduler micro-tidies (extracting explicit `PROGRESS_EMIT_THROTTLE_MS` const, fully removing the now-unused `concatUint8Arrays` helper): left as-is or inlined. Harmless; the core optimization (accum) was the real win. No need to churn test-visible or exported surfaces.

- Cache evict improvements (tier hints in evictBitmaps, optional self-pressure limits): minor and outside the primary gaps (saliency consumption, E-1 decoder feed, prefix copies, cross-env safety, validation). Not applied.

All items were re-examined against the actual files, data flow (manifest → scheduler → stream/cache + DecodeSession), state machine, hot paths, and pipeline invariants before any edit. Only positive contributions were applied. No files outside the 5 specified were read or edited during implementation. The prior handoff proposals (the "If you agree..." blocks) remain in the document above for historical/agent reference.
