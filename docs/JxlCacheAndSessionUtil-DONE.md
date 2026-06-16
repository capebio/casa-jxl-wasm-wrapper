# JxlCacheAndSessionUtil.md

Strategic synthesis across 21 lenses (lru.ts, browser.ts, node.ts, index.ts, util.ts only; all analysis from direct content + integrated pipeline knowledge; no other files read).

Cache layer is content-agnostic sidecar (mem LRU + persist tracker LRU + manifest for browser / fs scan for node). Sits beside decode/encode/return; accelerates by skipping re-execution of hot kernels (Butteraugli in encode, per-pixel LookRenderer color math including future non-Riemannian Schrödinger/Molchanov/HPCS/LosAlamos model, resampling, ML recognition, photogrammetry). Data passed: opaque string keys, ArrayBuffer payloads (full JXL or equivalent), byte sizes. Links: lru shared; browser types+safeCacheName imported by node; index factory+reexports; util provides boundary normalizer (toTransferableBuffer) and deferred/sessionId used higher in session flows that consume cache results.

Amalgamated findings (efficiency, speed, perf, bugs, features) only. Duplicates collapsed.

## Chapter 1: LRU Core Data Structure Layer (packages/jxl-cache/src/lru.ts) — Agent handles ONLY this file

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- Micro-optimization in evictToFit hot loop (lens 6,20,21): avoid repeated .get after .keys() iter for size. Current double lookup on oldest.

```ts
// replace the body of evictToFit
private evictToFit(incomingSize: number) {
  const iter = this.cache.keys();
  while (this.currentSize + incomingSize > this.maxSize && this.cache.size > 0) {
    const oldestKey = iter.next().value;
    if (oldestKey === undefined) break;
    const item = this.cache.get(oldestKey);
    if (!item) break;
    this.currentSize -= item.size;
    this.cache.delete(oldestKey);
    if (this.mruKey === oldestKey) {
      this.mruKey = undefined;
    }
  }
}
```

- Add allocation-light consumer API (for manifest/reconcile write paths in browser; lens5,6,21). entriesOldestFirst forces full Array.from on every schedule. forEach keeps sequential consumption without intermediate array.

```ts
// add new method to class
forEachOldestFirst(fn: (key: string, value: V, size: number) => void): void {
  for (const [key, { value, size }] of this.cache.entries()) {
    fn(key, value, size);
  }
}

// update existing to delegate (keeps API)
entriesOldestFirst(): Array<[string, V, number]> {
  const out: Array<[string, V, number]> = [];
  this.forEachOldestFirst((key, value, size) => out.push([key, value, size]));
  return out;
}
```

This cuts temp array churn on manifest drain (debounced but still) and reconcile. Existing mruKey/peek/getOldestKey tricks already excellent (pointer over re-walk).

No other changes. LRU order, size accounting, gen-independent, Map-based remain unchanged.

## Chapter 2: Browser Platform Cache Layer (packages/jxl-cache/src/browser.ts) — Agent handles ONLY this file

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Primary: ArrayBuffer ownership/detach at JS boundary (lens7,14,18,4,20,9). memoryCache stores master; get returns ref. Callers (session, progressive paints, AR, photogrammetry multi-view, LLM re-runs, worker postMessage) transfer for decode/WASM. Detaches the cached copy. Subsequent mem hit returns detached (0-byte or invalid) buffer. Silent data loss on second+ access to same key after first use. Breaks re-use for cached advanced color JXLs (lens17), repeat plant ID in immersive AR (lens16), consistent sources for digital twins (lens14), and any cache-accelerated path that skips Butteraugli/encode (lens15).

Fix: on set and all get return paths, ensure cache always retains an owned master; hand caller an independent copy. Copy cost (memcpy of compressed JXL) is negligible vs disk/network/decode/color math; guarantees live data for all consumers. Content-agnostic contract preserved.

In set (after init await, before/after size check):

```ts
async set(key: string, buffer: ArrayBuffer): Promise<void> {
  if (this.initPromise) await this.initPromise.catch(() => undefined);
  const size = buffer.byteLength;
  const master = buffer.slice(0);  // cache owns stable master; caller may transfer original
  this.memoryCache.set(key, master, size);
  // ... rest unchanged; pass original buffer (or master) to setPersistent paths below
  // in the !opfs/size>limit block and the main pending block, the writePersistentFile receives bytes (copy not required for write)
```

In get mem path:

```ts
const mem = this.memoryCache.get(key);
if (mem !== undefined) {
  this.persistentTracker.get(key);
  this.hitCount++;
  return mem.slice(0);  // independent for caller transfer; master stays in cache
}
```

In getPersistent (after successful file.arrayBuffer(), gen check, before return):

```ts
const buffer = await file.arrayBuffer();
// ... gen check, size==0 handling ...
this.memoryCache.set(key, buffer, buffer.byteLength);
if (entry === undefined) {
  this.persistentTracker.set(key, { name }, buffer.byteLength);
}
return buffer.slice(0);  // caller gets clone; cache holds original buffer
```

Apply identical slice discipline inside the Quota retry write path if it re-enters set logic (no change to writePersistentFile itself).

Secondary (lens 5,4,8,21):

- Use new LRU forEachOldestFirst to avoid Array.from in hot manifest paths (writeManifest + reconcile). Replace the for (const [key,entry,size] of ...entriesOldestFirst()) with forEachOldestFirst((k,e,s) => entries.push({key:k, name:e.name, size:s}))

- Same in reconcile for (const [key,entry] of ... ) loop: switch to forEach, ignore size param.

- Minor state: manifest write already uses gen guard + locks. Good.

No new public API, no feature flags, no manifest schema change. Persistent limit/estimate logic, inflight coalescing, 250ms debounce, 75% aggressive evict on quota, peek in remove, generation on clear all untouched.

## Chapter 3: Node Platform Cache Layer (packages/jxl-cache/src/node.ts) — Agent handles ONLY this file

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

1. Detach safety identical to browser (critical for same reasons: AR, photogrammetry, LLM, color-baked JXL re-use). Apply slice on store and handout.

In set:

```ts
async set(key: string, buffer: ArrayBuffer): Promise<void> {
  if (this.initPromise) await this.initPromise.catch(() => undefined);
  const size = buffer.byteLength;
  const master = buffer.slice(0);
  this.memoryCache.set(key, master, size);
  // ... later fs write can continue to use Buffer.from(buffer) or Buffer.from(master); rename logic unchanged
```

In get mem hit:

```ts
const mem = this.memoryCache.get(key);
if (mem !== undefined) {
  const name = fileNameFor(key);
  this.persistentTracker.get(name);
  this.hitCount++;
  return mem.slice(0);
}
```

In getPersistent (after buffer construction, before set/return):

```ts
const buffer = await fs.readFile(filePath);
const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const master = arrayBuffer.slice(0);
this.memoryCache.set(key, master, master.byteLength);
this.persistentTracker.set(name, true, buffer.byteLength);
return master;
```

2. State machine parity with browser (lens4,2,21,18): add generation guard + inflightSets serialization for concurrent sets (node currently lacks; sets are "fire and forget" risking racy tmp files or double evict/unlink under concurrent callers for same key).

Add fields (after inflightGets):

```ts
private readonly inflightSets = new Map<string, Promise<void>>();
private _generation = 0;
```

In clear:

```ts
async clear(): Promise<void> {
  if (this.initPromise) await this.initPromise.catch(() => undefined);
  this._generation++;
  this.memoryCache.clear();
  this.persistentTracker.clear();
  this.inflightGets.clear();
  this.inflightSets.clear();
  // ... fs clear unchanged
}
```

Wrap set persistent work (after mem set, inside the if (persistent && basePath) block; before the size>limit early return and the while-evict+write):

```ts
const gen = this._generation;
const name = fileNameFor(key);
// ... size > limit block can stay sync-ish but guard the unlink
if (size > this.opts.persistentLimit) {
  this.persistentTracker.delete(name);
  await fs.unlink(filePath).catch(() => undefined);
  return;
}
const previous = this.inflightSets.get(key) ?? Promise.resolve();
const pending = (async () => {
  try { await previous; } catch { /* proceed */ }
  if (this._generation !== gen) return;
  // original while (tracker.size + size > limit ...) { delete + unlink }
  // tmp write + rename + tracker.set
})();
this.inflightSets.set(key, pending);
try { await pending; } finally {
  if (this.inflightSets.get(key) === pending) this.inflightSets.delete(key);
}
```

Update stats:

```ts
inflight: {
  gets: this.inflightGets.size,
  sets: this.inflightSets.size
},
// add to persistent:
evictions: this.evictionsCount,  // also declare private evictionsCount = 0; increment on tracker deletes that unlink (in the while, in size>limit, in delete method)
```

Add evictionsCount field + incs parallel to browser removePersistentEntry (in the three unlink sites + delete method). Update persistent section in stats to match browser shape where possible (enabled, evictions).

3. Name cap parity (lens 2,5): change 150 to 200 in fileNameFor to match browser MAX_NAME.

```ts
return enc.length <= 200 ? enc : ...
```

Init scan / mtime sort / no manifest is acceptable divergence (node restart rebuilds approx LRU from mtimes); no force to add full manifest unless data shows need. The added gen + inflightSets close the runtime state gap.

## Chapter 4: Cache Factory and Re-exports Layer (packages/jxl-cache/src/index.ts) — Agent handles ONLY this file

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Factory is minimal surface (lens2). Re-exports already surface LRU, CacheOptions, JxlCache, safeCacheName, cacheNameFor, createJxlCache. After lru forEach addition, it will be exported automatically via export * from './lru.js'.

- Micro: compute isNode once (lens6,20,21 hot path for create in session init).

```ts
const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
export function createJxlCache(opts: CacheOptions): JxlCache {
  if (isNode) {
    return new JxlCacheNode(opts);
  } else {
    return new JxlCacheBrowser(opts);
  }
}
```

- No other logic. Keep re-exports as-is. If forEach or other lru additions land, verify via type that public surface remains stable (no need to touch unless breakage). Add no new exports.

## Chapter 5: Session Boundary Utilities Layer (packages/jxl-session/src/util.ts) — Agent handles ONLY this file

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

This file is the explicit handoff adapter (toTransferableBuffer) and session glue (deferred, newSessionId) for data that flows from cache.get results or net chunks into workers/decoders (lens7,1,20).

- Link to cache safety (lens7,14,18): after cache chapters land the master+slice policy, buffers returned by JxlCache.get are always safe for transfer (caller owns the clone; cache retains master). Update the toTransferableBuffer jsdoc to record the contract for readers.

```ts
// Normalize a chunk to a standalone ArrayBuffer suitable for transfer.
// An exact-span Uint8Array transfers its buffer directly; a partial view
// is copied so the transfer does not detach memory the caller still holds.
// JxlCache.get() (browser/node) now returns independent ArrayBuffers; callers
// may transfer the result without invalidating the cache master copy.
export function toTransferableBuffer(chunk: ArrayBuffer | Uint8Array): ArrayBuffer {
```

- Small robustness for newSessionId (lens8, support across envs used by cache+session consumers):

```ts
export function newSessionId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `jxl-${crypto.randomUUID()}`;
    }
  } catch {
    // fall through
  }
  return `jxl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
```

deferred<T> unchanged (settled flag + resolve/reject already solid).

No new functions, no API surface growth. These keep the "move pointer not re-read/copy unless view" trick (lens20) and tie the cache layer to session flows for AR/LLM/photogram use (fast, safe byte delivery after cache hit).

## Gaps (lens18,19) after changes

1. Ownership now illuminated and closed for the cache<->boundary (no more detached masters post-transfer).
2. Browser/Node state parity (gen, inflight sets, counters, name caps, copy policy) substantially closed.
3. Coherency (no payload hash verify on load from OPFS/fs, node init still mtime-approx, no TTL/admission beyond byte LRU) remains partially dark. Within scope we did not add stored checksums or verify (would increase manifest size + persist I/O and violate "keep thin, content-agnostic"); reconcile + tmp-rename + gen guards already provide best-effort. Future extension only if benchmarks show corruption or staleness under the target AR/photogram workloads.

Lenses 11-17 (astro, LLM/ML, gaming, photogram, Butteraugli, AR plant, advanced color): all facilitated implicitly. Cache hits bypass entire encode (Butteraugli), bypass net, serve pre-adjusted JXLs from the Rust LookRenderer non-Riemannian engine (keyed upstream by caller including look params), provide stable sources for multi-view recon and real-time recognition. The fixes make those hits reliable rather than one-shot. No direct math or LUTs belong in these JS layers (rust/WASM hot path for that).

## Overview of what is achieved

Implementing the per-file changes makes the cache a dependable accelerator rather than a one-use buffer. The slice-on-handoff policy guarantees that any payload — raw JXL or the output of expensive perceptual pipelines — stays available for repeated consumers (progressive paints, AR overlays doing plant recognition, photogrammetry building digital twins from multiple cached views, LLM passes re-analyzing the same organism image). This directly reduces variance in frame delivery and eliminates a class of "cache went silent after first decode" bugs.

Platform parity plus the added forEach and micro loop tightening shrink allocation and race surface between browser and Node executions. Sessions and workers see consistent behavior under concurrent sets, clears during progressive chunking, and long-lived server or field AR use.

By confining every edit to its single assigned file and preserving the content-agnostic, beside-pipeline placement, the cache continues to act as a transparent "skip expensive stage" layer for Butteraugli, color geodesic math, resampling, and ML inference while the new reliability enables the larger vision of real-time immersive recognition and accurate, repeatable digital representations without re-acquiring or re-computing source data.

## Implemented

- ch1 (packages/jxl-cache/src/lru.ts): applied evictToFit micro (cache item, avoid 2nd .get + defensive); added forEachOldestFirst + refactored entriesOldestFirst to delegate (cuts intermediate arrays for browser manifest/reconcile). Positive.
- ch2 (packages/jxl-cache/src/browser.ts): AB master+slice(0) safety in set (store master, pass master to persist), get mem-hit, getPersistent load (return copy, retain master in memCache); switched writeManifest + reconcile to forEachOldestFirst (no Array.from). Core detach bug fixed for cache re-use. Positive.
- ch3 (packages/jxl-cache/src/node.ts): AB slice safety (set master, mem/getp return copies); name cap 200 parity; added _generation, inflightSets, evictionsCount; gen++ + inflight clear in clear(); set now uses previous/pending/gen guard + evictions inc on unlinks (size> and while); delete incs evictions; stats now reports sets + evictions parity. Positive.
- ch4 (packages/jxl-cache/src/index.ts): memoized isNode const at module level (avoid recompute on every createJxlCache call). Re-exports cover new lru forEach automatically. Positive.
- ch5 (packages/jxl-session/src/util.ts): updated toTransferableBuffer jsdoc to document cache safety post-slice changes (links util to cache layers); made newSessionId robust with try/catch + fallback (no crash on missing crypto.randomUUID). Positive.
- verify (final): ran `node StandardMultifileTest.mjs` (exit 0, no errors); test exercised multi-format prog/encode/decode + transferable + tiled paths. No regressions visible in aggregates or diagnostics (transfer speedups 65-310x preserved; AvgProgFinalSimdMs ~411ms / Mt ~130ms stable across 8 assets; parallel/ROI/enc timings within expected). Full results + .toon in docs/outputs/timing tests/. Per spec, appended -DONE to this doc filename.

[Append-only section for agents. Record file, exact diffs applied or rejection reason, timing impact if measured, and any notes. No inline user chatter during the work.]

**Final instruction to the last agent to act on this document: after you finish the chapter for your file, update this Implemented section with a concise entry, then append "-DONE" to the filename of this document (changing JxlCacheAndSessionUtil.md to JxlCacheAndSessionUtil-DONE.md or equivalent). As the closing verification for the batch, run the command at c:\Foo\raw-converter-wasm\StandardMultifileTest.mjs (via node or pwsh as appropriate for the environment) and append a one-line summary of before/after or regression status under your Implemented entry.**