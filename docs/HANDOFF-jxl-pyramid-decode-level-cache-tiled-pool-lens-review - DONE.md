# HANDOFF — jxl-pyramid lens review: decode-level.ts / cache.ts / tiled-decode-pool.ts

22-lens review (strategic, API, pipeline, state, data, kernels, boundaries, support, owl, reversal, astronomy, ML, gaming, photogrammetry, Butteraugli, AR, color-engine, math, hacker, re-pass, gaps ×2, birds-eye), 2026-06-10.
Files: `packages/jxl-pyramid/src/decode-level.ts`, `packages/jxl-pyramid/src/cache.ts`, `packages/jxl-pyramid/src/tiled-decode-pool.ts`.

**Ground rules for all agents:** Respect CLAUDE.md layer invariants and the rejected-optimizations table (no pixel pools, no per-stage budget reset, no drain callbacks in wrong layers). Agents 4 and 5 share one file — run them **sequentially**, Agent 4 first. Each agent edits only its assigned file; if a fix genuinely requires a 1–2 line change in a closely-related file, defer it to the end and request approval first.

---

## Strategic view (Lens 1)

`decode-level.ts` is the direct (main-thread) decode entry: whole-frame and tiled-viewport, with a progressive dc-then-final loop. `tiled-decode-pool.ts` is the parallel sibling: a warmed worker pool with load/decode split (`bytesId`), stream-stitching tiles into a shared `outBuffer`. `cache.ts` provides identity (`getLevelId`) and a byte-budgeted LRU both paths consult. Data flow: container bytes → plan (`prepareDecodePlan`) → per-tile bitstreams/regions → pixels → stitch → viewport buffer → cache.

**Systemic theme:** the two decode paths have drifted. Guards exist in one and not the other (in-flight buffer guard, 16-bit alignment, output validation, cache-hit clone semantics, capacity guard). Several items below are "parity" fixes; the long-term cure is a shared entry-guard helper, noted as deferred.

---

## Agent 1 — decode-level.ts (correctness)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**DL-1 (bug, high): budget-break / skipTiles can cache an incomplete viewport as 'final'.**
In the progressive path, a `budgetMs` deadline break under `errorPolicy: 'skip-tile'` exits the loop with `failedTiles` empty, so line ~258 caches a partially-decoded buffer under the `'final'` key — cache poisoning. Same hole when `skipTiles` is non-empty (skipped tiles were never stitched into a fresh `target`). Additionally, with a caller `outBuffer`, tiles not reached before the break retain stale pixels and are reported nowhere.
Fix: track completeness and record unprocessed tiles:

```ts
let deadlineHit = false;
// in both phase loops, replace `break` with: { deadlineHit = true; break; }
// after phase 2, before result assembly:
if (deadlineHit) {
  for (let i = 0; i < n; i++) {
    const t = plan.tiles[i]!;
    const id = tileIdOf(t, source.tileSize, 0);
    const k = tileKey(id);
    if (!stitchedFinal.has(k)) failedTiles.push(id);   // stitchedFinal: Set<string> filled on successful final stitch
  }
}
const complete = !deadlineHit && failedTiles.length === 0 && !(skipTiles && skipTiles.size > 0);
if (cache && cacheKeyFinal && complete) { /* existing cache.set */ }
```

**DL-2 (bug, high): `decodeWhole` cache hit returns the cache-owned buffer zero-copy, unconditionally.**
Line ~395 `const pixels = cached;` — caller mutation corrupts the cache. The tiled path clones unless `zeroCopyCacheHits`. Fix: `const pixels = options?.zeroCopyCacheHits ? cached : new Uint8Array(cached);`. Also on the outBuf hit path, treat `cached.length < need` as a cache miss (currently fills partially and returns).

**DL-3 (bug, medium): `decodeWhole` outBuf path returns the whole `outBuf`, not `subarray(0, need)`.**
Line ~436 — inconsistent with tiled paths; consumers asserting `pixels.byteLength === w*h*bpp` break. Fix: `res = { pixels: outBuf.byteLength === need ? outBuf : outBuf.subarray(0, need), ... }`.

**DL-4 (bug, medium): `hasAlpha: true` hardcoded** in the synthesized `exHeader` (line ~171). If `extractTileBitstream` uses `hasAlpha` to reconstruct the standalone tile bitstream header, a no-alpha JXTC container decodes wrong. Verify `extractTileBitstream`'s sensitivity in `tiling.ts` (read-only); if sensitive, plumb `hasAlpha` from the parsed header onto the tiled `LevelSource` (1-line addition to `level-source.ts` — deferred edit, request approval) and use it here. If provably insensitive, replace the literal with a comment stating why.

**DL-5 (bug, medium): capacity guard is dead code.** `(cache as any).capacityBytes` is read at lines ~259, ~286, ~444 but `InMemoryPyramidCache` exposes no such property (its field is private `maxBytes`) — guard never fires, oversized entries reach `set()` and flush the whole LRU (see C-1, Agent 3 adds the getter). After Agent 3 lands, drop the `as any` casts and read the now-typed optional `cache.capacityBytes`.

**DL-6 (robustness, low): `decodeWhole` ignores `signal` after start.** Wrap the drain with the existing `raceWithAbort(p, signal)` helper as `decodeTiledViewport`'s direct branch does. WASM stays uninterruptible mid-push (known contract); this only restores prompt rejection.

---

## Agent 2 — decode-level.ts (performance / features)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**DL-7 (perf, high): progressive path is strictly sequential and on the main thread.**
Each tile awaits a fresh `createDecoder` per stage, one at a time — N tiles ⇒ 2N serial WASM decodes that jank the UI. Two-step fix, in preference order:
(a) When workers are available (`shouldUseParallel`-equivalent conditions), have `decodeTiledViewport`'s `progressive === 'dc-then-final'` branch delegate to `decodeTiledViewportPooled` with `progressive: 'dc-then-final'` (the pooled path already supports `progressiveStage`). Keep the current loop as the no-worker fallback.
(b) In the fallback itself, allow bounded concurrency (2–3 in-flight `decodeTileBytesProgressive` calls via a simple counter/queue) — decoders are independent; ordering of `onTile` per stage may then be out-of-order, which `TileProgress.key` already disambiguates.
Note: the dc→final re-decode (final pass re-parses from byte 0) is inherent to disposable decoders — `decoder.push()` is synchronous and sessions can't pause; do **not** attempt a soft-yield protocol (rejected on sight).

**DL-8 (UX/AR/gaming, medium): center-out tile ordering.**
First-paint quality: order tiles by distance from viewport center so the subject (usually centered — field photography, AR identification) refines first. Apply to the progressive loop's iteration order (sort a copy of `plan.tiles`; do not mutate the plan):

```ts
const cx = vp.x + vp.w / 2, cy = vp.y + vp.h / 2;
const ordered = plan.tiles.slice().sort((a, b) => {
  const da = (a.x + a.w / 2 - cx) ** 2 + (a.y + a.h / 2 - cy) ** 2;
  const db = (b.x + b.w / 2 - cx) ** 2 + (b.y + b.h / 2 - cy) ** 2;
  return da - db;
});
```
Mirrored for the pooled dispatch by Agent 5 (TP-14).

**DL-9 (cleanup, low): duplicated direct-decode epilogue.** The non-pooled direct branch and `decodeWhole` repeat cache-set + capacity-guard + clone logic. Extract a file-local `cacheStore(cache, key, pixels, need)` helper. Pure dedup, no behavior change.

**DL-10 (hygiene, low): progressive block (lines ~162–265) is mis-indented** (merge artifact) — re-indent only; confirm no brace drift; run existing tests.

---

## Agent 3 — cache.ts

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**C-1 (bug, high): oversized insert flushes the entire cache.**
`set()` inserts first, then evicts oldest-first while over budget — a single entry larger than `maxBytes` evicts every existing entry and finally itself: full cache flush, zero benefit. Fix + expose capacity (this also revives the dead guards in both decode paths, DL-5 / TP-12):

```ts
export interface PyramidCache {
  // ...existing members...
  /** Optional byte capacity; entries larger than this are rejected by set(). */
  readonly capacityBytes?: number;
}

class InMemoryPyramidCache implements PyramidCache {
  get capacityBytes(): number { return this.maxBytes; }
  set(key: string, value: Uint8Array): void {
    if (value.length > this.maxBytes) return;  // reject, don't flush
    // ...existing logic...
  }
}
```

**C-2 (bug/perf, high): `getLevelId` keyed on Uint8Array *view* identity defeats caching for re-sliced views.**
A caller that re-derives `new Uint8Array(buf, off, len)` (or `subarray`) each frame gets a fresh id every call → permanent cache misses plus dead entries occupying LRU budget until evicted. Key by underlying buffer + view window instead:

```ts
const bufIdByBuffer = new WeakMap<ArrayBufferLike, string>();
function bytesId(view: Uint8Array): string {
  let b = bufIdByBuffer.get(view.buffer);
  if (b == null) { b = `B${++levelIdCounter}`; bufIdByBuffer.set(view.buffer, b); }
  return `${b}:${view.byteOffset}:${view.byteLength}`;
}
```
Use inside `getLevelId` for the `Uint8Array` arm (keep the `LevelSource` arm as-is). This directly fixes the pooled-path cache-miss bug TP-13 without touching the pool file. Caveat to verify: content mutated in-place under the same buffer would alias ids — acceptable for this codebase (level bytes are immutable post-ingest); state that assumption in a comment.

**C-3 (telemetry, low): expose `bytesUsed` and `entryCount` getters** on `InMemoryPyramidCache` (trivial reads of existing fields). Enables hit-rate/occupancy dashboards (gap identified under Lens 21 — the pipeline has zero observability today). No behavior change, content-agnostic, stays in-layer.

---

## Agent 4 — tiled-decode-pool.ts (pool lifecycle & state machinery)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**TP-1 (bug, critical): `acquire()` strands already-acquired handles when it enqueues a waiter.**
Lines ~444–461: handles already popped/spawned into `got` (and added to `this.active`) are abandoned when the function returns the waiter promise — they leak in `active` forever, shrinking effective pool capacity permanently. Fix: resolve the waiter with `got` included, or release `got` before enqueueing:

```ts
if (got.length < count && this.all.size >= this.maxSize) {
  const need = count - got.length;
  return new Promise<WorkerHandle[]>((resolve) => {
    const waiter = { want: need, resolve: (hs: WorkerHandle[]) => resolve([...got, ...hs]) };
    this.waiters.push(waiter);
    globalThis.setTimeout(() => {
      const idx = this.waiters.indexOf(waiter);
      if (idx >= 0) { this.waiters.splice(idx, 1); resolve(got); }  // partial is fine, caller adapts
    }, maxWait);
  });
}
```

**TP-2 (bug, critical): waiter timeout never fires — identity comparison always fails.**
`findIndex(w => w.resolve === resolve)` compares against the raw promise resolver, but the stored field is the wrapper `(hs) => resolve(hs)` — never equal, so a busy pool makes `acquire()` hang until some release happens, possibly forever. Fixed by the `indexOf(waiter)` pattern in TP-1. Additionally `destroy()` must drain waiters (`for (const w of this.waiters.splice(0)) w.resolve([]);`) or post-destroy acquirers hang permanently.

**TP-3 (bug, high): `inflightEntry.reject` captures the raw promise `reject`, not `doReject`.**
Line ~104. `destroyHandle` rejecting via this raw reject skips `settled`/`cleanup()`: the pending map entry and its 10 s watchdog timer survive. When the watchdog later fires it calls `setHandleState(h, Bad)` on a **Terminated** handle — in dev that throws inside a timer callback (uncaught). Fix: assign after `doReject` is defined (`inflightEntry.reject = doReject as (e: Error) => void;`), and have `destroyHandle` clear all `h.pending` job timers and clear the map.

**TP-4 (perf, high): abort terminates the worker instead of cancel+reuse.**
`decodeTileWithWorker`'s abort paths post `cancel` *and then* `terminate()` + `HandleState.Terminated`. Pan/zoom in an interactive viewer is an abort storm — every gesture destroys warmed workers and forces cold respawn (WASM re-init), exactly what the pool exists to avoid. Fix: on abort, post `cancel`, delete the pending job, reject the promise — leave the worker alive and `Active`; `release()` then returns it to idle (its `pending` is empty). The worker finishes its current synchronous push (ms-scale) and is reusable. Keep terminate only for the timeout/watchdog paths (genuinely stuck worker).

**TP-5 (perf, high): one failed tile terminates every handle in the batch.**
`decodeTilesParallel` catch block (lines ~772–781) terminates all handles — one corrupt tile wipes the entire warm pool. The `controller.abort()` already rejects in-flight sibling jobs. Fix: drop the terminate-all loop; reject each handle's pending jobs (with timer cleanup) and post best-effort `cancel`, but keep handles alive; let `release()` re-idle them. Workers are stateless between requests (protocol contract), so a failed decode does not poison a worker — only `OOM`/`INTERNAL` replies should mark a handle `Bad` (the `onMessage` path already does this).

**TP-6 (bug, medium): `process.env.NODE_ENV` crashes un-bundled browser ESM** (`process` is not defined → ReferenceError in `setHandleState`, the hot transition fn). Guard: `const DEV = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';` hoisted to module scope, branch on `DEV`.

**TP-7 (bug, medium): `whenReady()` can never resolve.** Single 0 ms re-check; if the pool isn't ready then, the promise hangs. Implement properly with what already exists:

```ts
whenReady(): Promise<void> {
  const have = () => this.idle.length + this.active.size;
  if (have() >= this.minIdle) return Promise.resolve();
  const pending = [...this.all].filter(h => !h.readySettled).map(h => h.ready.catch(() => {}));
  return Promise.all(pending).then(() => {});
}
```

**TP-8 (bug, medium): `getOrCreatePool` factory identity check is a comment, not code.** A second caller with a different `workerFactory` silently reuses the pool built on the old factory. Store the factory ref alongside `pool`; if it differs and pool is Active with inflight, throw the existing `FACTORY_CONFLICT`; if idle, destroy-and-recreate.

**TP-9 (bug, medium): `allocateBytesId` stamps `source.bytesId` globally but ids are pool-scoped.** With two pools (explicit `options.pool` + singleton), pool B trusts a stamp minted by pool A; B's own `nextBytesId` can mint the same number for *different* bytes → a worker decodes the wrong container. Fix: per-pool `WeakMap<LevelSource, number>` instead of mutating the source object.

**TP-10 (leak, low): `visibilitychange` listener never removed.** Store the bound listener; `removeEventListener` in `destroy()`. (Post-destroy it is harmless today only because `prewarmAsync` checks state — still a leak per explicit-pool instance.)

**TP-11 (cleanup, low): acquire's "ready filter" pushes the handle on every branch** (lines ~465–479) — it is an await-with-timeout, not a filter, and it awaits sequentially (worst case `count × maxWait`). Replace with one parallel wait: `await Promise.race([Promise.all(got.map(h => h.ready.catch(() => {}))), delay(maxWait)]);` then return `got`. Also delete the dead `killHandle` shim and the unused `PendingJob.region` clone (or use it for TP-15 retry — coordinate with Agent 5).

---

## Agent 5 — tiled-decode-pool.ts (decode path: perf, parity, features) — run after Agent 4

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**TP-12 (parity bundle, high): pooled path is missing guards the direct path has.** Add, mirroring `decodeTiledViewport`:
- `buffersInFlight` WeakSet guard on caller `outBuffer` (export the WeakSet from decode-level or duplicate the 3-line guard locally — prefer a tiny shared export; deferred-edit approval if moving it to decode-core).
- 16-bit alignment check: `bpp === 8 && outBuffer.byteOffset % 2 !== 0` → `INVALID_BUFFER_ALIGNMENT`.
- Cache-hit clone semantics: line ~874 returns the cache-owned buffer zero-copy unconditionally → clone unless `options.zeroCopyCacheHits` (same bug class as DL-2).
- Cache-hit outBuf: validate `cached.length` covers `need` and never exceeds `ob` (`ob.set(cached)` with `cached.length > ob.byteLength` throws RangeError mid-frame); on mismatch treat as miss.
- Validate direct-decoder output (`validateDecodedOutput(direct, vp, bpp)`) on the three non-parallel fallback blocks.

**TP-13 (bug, high): every `cache.set` in this file stores `new Uint8Array(outBuffer)` — the *whole* buffer.** With a caller-provided oversized `outBuffer` this caches trailing garbage and inflates entries (and triggers the RangeError above on a later hit). Fix everywhere: `cache.set(cacheKeyFinal, outBuffer.slice(0, need))`, gated by the capacity guard (`cache.capacityBytes === undefined || need <= cache.capacityBytes`) once Agent 3's C-1 lands. Note: the Uint8Array-overload entry constructs a fresh `source` object per call, so `getLevelId(source)` never repeats — cache hit rate was 0% on that path; Agent 3's C-2 fixes identity, but additionally key by bytes here: `viewportCacheKey(getLevelId(source.bytes), ...)` so both overloads share keys.

**TP-14 (perf, high): SAB is allocated and copied once *per worker*.** Lines ~948–951 inside the per-handle loop — N workers ⇒ N SharedArrayBuffers ⇒ N full container copies, strictly worse than structured clone. Hoist: create one SAB per `bytesId` (cache it, e.g. `Map<number, SharedArrayBuffer>` on the pool, cleared on destroy), copy once, post the same SAB to every worker. That is the entire point of SAB: one physical copy, shared.

**TP-15 (feature, medium): plumb `options.budgetMs` → `deadlineMs`.** `decodeTilesParallel` accepts `deadlineMs` but callers pass `undefined`. Compute **once** at entry — `const deadlineMs = options.budgetMs != null ? performance.now() + options.budgetMs : undefined;` — and pass the same absolute deadline to both the dc and final passes (single session-level budget; per-stage reset is rejected-on-sight).

**TP-16 (feature, medium): finish `TileProgress` in pooled `onTile`.** The `tId` is computed then discarded (`void tId`). Pass the third argument the direct path already provides — this is also the ML/AR hook (DC-stage pixels become available per tile for early classifier inference before final refinement):

```ts
const prog: TileProgress = tId ? {
  id: tId, key: tileKey(tId),
  stage: opts.progressiveStage ?? 'final',
  completed: completedCount,
  total: tiles.length * (opts.progressiveStage ? 2 : 1), // caller-consistent semantics; verify against direct path
} : undefined as any;
opts.onTile?.(region, completedCount, prog);
```
(Verify `completed`/`total` semantics against the direct path's two-phase counting and match it.)

**TP-17 (leak, medium): abort listeners accumulate on the shared signal.** `decodeTileWithWorker` adds one `{ once: true }` listener per tile on `effectiveSignal`; a 1000-tile viewport adds 1000 listeners released only on abort or signal GC. Remove in `cleanup()` (`signal.removeEventListener('abort', onAbort)`). Same for `decodeTilesParallel`'s outer `opts.signal.addEventListener('abort', → controller.abort())` — remove after `Promise.all(coros)` settles (or pass `{ signal: AbortSignal.timeout… }`-style scoped registration via an internal AbortController used as `addEventListener`'s `signal` option).

**TP-18 (robustness, medium): validate worker reply pixel length before stitch.** `parseWorkerReply` checks types only; a short buffer makes `stitch` read out of bounds of the decoded tile. After parse: `if (pixels.byteLength < reply.w * reply.h * bpp) → reject INVALID_REPLY` (bpp known from the request's format; thread it or recompute from format).

**TP-19 (resilience, medium): retry a failed tile once on a surviving handle** before failing the whole batch (matters for photogrammetry coverage — a digital-twin reconstruction wants every tile, and one transient worker hiccup currently aborts the viewport). Bounded: one retry, only if `!controller.signal.aborted` and at least one healthy handle remains; otherwise propagate as today. Depends on TP-5 (workers no longer terminated en masse).

**TP-20 (simplification, low): collapse `inflight` Set into `pending` Map.** Two structures track the same jobs; replies do `Array.from(h.inflight).find(...)` — O(n) per reply. `pending`'s `PendingJob` already holds `reject`; `destroyHandle` can iterate `pending.values()`. One structure, less drift, O(1) lookup.

**TP-21 (encapsulation, low): replace `(p as any).bytesIdByWorker` poking with a pool method** `ensureLoaded(handles, bytesId, bytes, useSAB)` that owns the per-worker load-once logic (and the TP-14 SAB cache).

**TP-22 (UX, low): center-out tile ordering at dispatch** — same rationale and snippet as DL-8; sort `plan.tiles` copy before `decodeTilesParallel`. With work-stealing (`next++`) the hottest (central) tiles dispatch first naturally.

**TP-23 (cleanup, low): the direct/fallback epilogue (decode → `outBuffer.set` → cache.set → `onTile`) is repeated three times** — extract a local helper; apply TP-12/TP-13 fixes once inside it.

---

## Deferred / cross-layer (list only — do not implement without approval)

- **Shared entry-guard helper in decode-core** (outBuffer validation, in-flight guard, cache hit/store semantics) used by both decode paths — ends the parity drift this review is full of.
- **Worker-side post-decode transform hook** (per-tile LUT application point for the non-Riemannian perceptual color engine, Lens 17) — protocol change; natural location is the worker decode loop, so pixels get one touch. Design-only for now.
- **OPFS-backed PyramidCache adapter** bridging to `jxl-cache` (persistent tile cache across sessions; field/offline use). Keys already content-agnostic; needs async `get` → interface evolution.
- **Telemetry counters** (cache hit rate, worker utilization, tile decode ms percentiles) — Lens 21 gap: pipeline currently has zero observability. C-3 is the first stone.
- **Butteraugli (Lens 15):** not present in these layers; the tile-parallel pool is reusable later for per-tile distance scoring on the encode side. No change here.

---

## Overview — what implementing this achieves

The correctness tier removes four silent data-corruption channels: incomplete viewports cached as final (DL-1), cache-owned buffers handed out mutable (DL-2, TP-12), whole-outBuffer cache writes storing trailing garbage that later throws mid-frame (TP-13), and the oversized-entry full-cache flush (C-1). Together with the identity fix (C-2), the cache goes from "actively dangerous and near-zero hit rate on the pooled path" to a trustworthy layer — the single biggest practical win, since a viewport cache hit replaces an entire multi-tile decode.

The lifecycle tier makes the worker pool behave like a pool. Today an abort (every pan/zoom gesture), a single corrupt tile, or contention at capacity respectively destroys warm workers (TP-4), wipes the entire pool (TP-5), or hangs/strands handles permanently (TP-1/TP-2/TP-3). After these fixes, workers survive the normal turbulence of an interactive viewer, which is where the pool's warm-start advantage actually pays: sustained pan/zoom keeps WASM instances hot instead of respawning them every gesture, and the failure paths degrade to single-tile retries (TP-19) instead of viewport-wide aborts.

The experience tier compounds these: progressive decode moves off the main thread and gains parallelism (DL-7), tiles refine center-out so the organism in frame sharpens first (DL-8/TP-22 — directly serving the AR identification and field-use vision), budget enforcement reaches the pooled path (TP-15), and per-tile stage progress (TP-16) gives downstream ML hooks a DC-resolution image per tile before final refinement — a classifier can begin species inference on the coarse pass while the fine pass is still streaming. The deferred list then points at the next horizon: persistent OPFS tile caching for offline fieldwork, a worker-side hook for the perceptual color engine, and the observability needed to measure all of it.
