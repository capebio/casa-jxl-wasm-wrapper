# HANDOFF — jxl-pyramid: level-source / decode-level / decode-core / tiled-decode-pool / cache — 22-lens review

Date: 2026-06-12. Branch: Parallel-Wasm-Lens.
Scope (exclusive): `packages/jxl-pyramid/src/level-source.ts`, `decode-level.ts`, `decode-core.ts`, `tiled-decode-pool.ts`, `cache.ts`.
Prior handoff (HANDOFF-jxl-pyramid-decode-level-cache-tiled-pool-lens-review) is implemented (DL-1..DL-9, L18-x, L20-x, Agent6-x markers present). All items below are **new** findings on the current code.

Connectivity recap (Lens 1): `decode-level.decodeLevel` is the public entry. Tiled requests plan via `plan.ts`, check the viewport LRU in `cache.ts`, then either (a) direct single WASM ROI call, (b) progressive per-tile main-thread loop, or (c) delegate to `tiled-decode-pool.decodeTiledViewportPooled`, which fans tiles across a persistent worker pool using the load/decode `bytesId` protocol. `level-source.ts` constructs the uniform `LevelSource` handle both paths consume. `cache.ts` provides identity (`getLevelId`/`bytesId`) and the LRU. The two decode paths are supposed to be interchangeable behind `decodeLevel`; several findings below are cases where they have drifted apart (different cache keys, different region snapping, different buffer guards) so the "same request" behaves differently depending on which path fires.

## Finding index

| # | File | Sev | Title |
|---|------|-----|-------|
| P1-A | decode-level.ts | **P0** | outBuffer + progressive + workers always throws BUFFER_IN_USE (self-conflict via buffersInFlight) |
| P1-B | tiled-decode-pool.ts | **P0** | CoreBudget token leak on handle failure; waiter path bypasses budget; acquire-after-activate deadlock window |
| P1-C | cache.ts (+both decode paths) | P1 | Viewport cache key schism: direct path "L#" ids vs pooled path "B#" ids → guaranteed cross-path miss, double decode, double storage |
| P1-D | tiled-decode-pool.ts | P1 | Worker dead before `ready` → `decodeTiledViewportPooled` hangs forever |
| P1-E | decode-level.ts | P1 | Non-progressive parallel decode unreachable from decodeTiledViewport (docstring contradicts code) |
| P1-F | decode-level.ts / pool | P1 | Pooled path receives unsnapped (possibly fractional) region; fractional `need` → RangeError or corrupt stitch |
| P1-G | decode-core.ts | P1 | `tileKeyPacked` dev guard dereferences bare `process` → ReferenceError in unbundled browser ESM |
| P1-H | tiled-decode-pool.ts | P1 | `sabByBytesId` strong Map retains full container copies until pool destroy (unbounded growth) |
| P2-a | tiled-decode-pool.ts | P2 | 10 s hard watchdog fires before longer configured requestTimeoutMs |
| P2-b | decode-level.ts | P2 | decodeWhole skips buffersInFlight guard (tiled paths enforce it) |
| P2-c | decode-core.ts | P2 | ensureIccProfile races concurrent callers (memoizes value, not promise) |
| P2-d | level-source.ts | P2 | prepareLevelSource is dead protocol vestige (pool uses WeakMap, never the property) |
| P2-e | level-source.ts | P2 | Tiled branch ignores manifest w/h — silent manifest↔container mismatch |
| P2-f | both decode files | P2 | Duplicate `cacheStore` implementations with divergent slice semantics |
| P2-g | decode-level.ts | P2 | Pooled delegation silently drops errorPolicy:'skip-tile' / skipTiles semantics |
| P2-h | tiled-decode-pool.ts | P2 | finalizeDirectDecode builds TileId with `tileSize = vp.w` (wrong semantics vs direct path) |
| P2-i | decode-core.ts | P2 | TileProgress.decodeMs / bytesDecoded declared but never populated |
| F-1 | decode-level + pool + cache | Feature | **Per-tile LRU caching** (makeTileCacheKey shipped but unused) — kills white grid lines on pan |
| F-2 | decode-level.ts | Feature | Velocity-aware neighborhood prefetch API (`prefetchViewport` + `predictRegion`) |
| F-3 | decode-level.ts | Feature | DC-quality viewport/tile caching for instant coarse repaint |
| F-4 | level-source.ts/decode-core | Feature | Thread real pyramid `level` into TileId (currently hardcoded 0 everywhere) |
| R-1 | — | Rejected-with-alternative | "Cache eviction aborts in-flight pool decodes" — wrong coupling; use generation AbortController instead (documented in Agent 6) |

Lens notes with no action: Lens 15 (Butteraugli) — encode-time concern, absent from these decode-side files, nothing to do here. Lens 17 (non-Riemannian colour) — lives in `LookRenderer`/`pipeline.rs`, not this layer; the only touchpoint is ICC pass-through (already present via `ensureIccProfile`). Recurring-rejection check done: per-tile caching here is the PyramidCache's own decoded-pixel LRU (its stated purpose — `makeTileCacheKey` already lives in cache.ts), not the content-agnostic jxl-cache layer, and no transferred-buffer pooling is proposed.

---

## Agent 1 — `tiled-decode-pool.ts` (P0/P1 correctness batch)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

### 1.1 (P0) CoreBudget token accounting is leaky and bypassable — P1-B

Current flow in `PyramidWorkerPool`:
- `acquire()` (≈ lines 436–511): handles are popped/spawned and moved to `active` **first**; CoreBudget tokens are acquired **after** (lines ~497–508). Two defects:
  1. **Waiter path bypass**: when the pool is at cap, `acquire` returns inside the waiter branch (`return new Promise...`, ~line 472) *before* the CoreBudget block — those handles (both `got` and the later waiter-resolved ones) never acquire tokens.
  2. **Deadlock window**: if `coreBudget.acquire()` blocks (scheduler saturated), the handles already sit in `active`, unusable by anyone, while the caller is suspended — pool capacity is held hostage to the budget.
- `release()` (≈ lines 514–529): `budgetReleaseCount` only increments for handles successfully returned to idle. Handles that went `Bad`/`Terminated`/had pending jobs are destroyed via `destroyHandle` and **their tokens are never released**. Every worker failure permanently shrinks the shared budget → eventual stall of both pyramid and scheduler pools.

Fix shape (track grant size per batch, release exactly that):

```ts
// acquire(): move budget acquisition BEFORE activation; degrade instead of blocking.
// Pseudocode of the intended order:
//   1. compute want = count
//   2. granted = tryAcquire tokens one-by-one up to want; if 0 granted and pool would
//      otherwise return handles, await acquire(workerCost) for exactly ONE token
//      (bounded degradation: never block for the full batch).
//   3. only activate (idle.pop / spawnOne) as many handles as granted tokens.
//   4. stamp the batch: (h as any)._budgetTokens = workerCost on each granted handle,
//      or return a batch object; simplest robust fix is a per-handle marker:
interface WorkerHandle { /* ... */ budgetCharged?: boolean }
// release()/destroyHandle(): release budget for every handle with budgetCharged,
// then clear the flag — independent of whether it re-enters idle or is destroyed:
private releaseBudget(h: WorkerHandle) {
  if (h.budgetCharged && this.coreBudget) {
    this.coreBudget.release(this.workerCost);
    h.budgetCharged = false;
  }
}
// call releaseBudget(h) in BOTH release() (all handles) and destroyHandle().
```

Also charge waiter-resolved handles (in the `release()` waiter-drain loop) before handing them over, with `tryAcquire` and fallback to giving fewer handles. Keep the hot-path property: `tryAcquire` first, `await` only on contention.

### 1.2 (P1) Worker death before `ready` hangs the pooled decode — P1-D

`decodeTiledViewportPooled` does `await Promise.all(liveHandles.map(h => h.ready))` (≈ line 1107) with **no timeout**. If a worker script fails to boot, the `error` event fires `destroyHandle(h, "worker error")` — but `destroyHandle` never settles `h.ready`, so the await suspends forever. `acquire()`'s own ready-race has a `maxWait` timeout, but line 1107 re-awaits unbounded.

Fix (two small changes):

```ts
private destroyHandle(h: WorkerHandle, reason: string) {
  if (h.state === HandleState.Terminated) return;
  if (!h.readySettled) { h.readySettled = true; h._readyResolve?.(); } // never strand awaiters
  // ... existing body
}
```

And at line ~1107, filter dead handles after the await instead of trusting all of them:

```ts
await Promise.all(liveHandles.map((h) => h.ready));
const usable = liveHandles.filter(h => h.state !== HandleState.Terminated && h.state !== HandleState.Bad);
if (usable.length === 0) { /* p.release(liveHandles); fall back to direct decode */ }
```

(Resolving rather than rejecting `ready` is deliberate — every consumer already `.catch(() => {})`s it; rejection adds unhandled-rejection risk for zero benefit.)

### 1.3 (P1) `sabByBytesId` unbounded retention — P1-H

`this.sabByBytesId` is a strong `Map<number, SharedArrayBuffer>` holding a full copy of every container ever loaded with `useSAB`. `bytesIdBySource` is a WeakMap (source can GC) but the SAB copy lives until `destroy()`. A gallery session touching hundreds of levels grows this without bound.

Fix: bound it with insertion-order eviction (it is a Map — same trick as InMemoryPyramidCache), e.g. keep ≤ 8 SABs or ≤ 256 MiB total. On eviction, also delete the bytesId from every `bytesIdByWorker` set so workers reload on next use. Check `worker-protocol.ts` for an `unload`/`evict` message; if one exists, post it so the worker frees its reference; if not, note in your report that worker-side memory is only reclaimed on worker reap (idle timer) and consider proposing the protocol message as a deferred cross-file request.

### 1.4 (P2) Watchdog vs requestTimeout interplay — P2-a

`decodeTileWithWorker` arms an unconditional 10 000 ms watchdog (≈ line 152–159) *in addition to* the configurable `requestTimer`. If a caller configures `requestTimeoutMs = 30_000` (large 16-bit tiles, slow devices), the watchdog terminates the worker at 10 s anyway. Fix: `const watchdogMs = Math.max(10_000, (requestTimeoutMs ?? 0) * 1.5);` — or skip arming the watchdog entirely when `requestTimer` exists (one timer fewer per tile; they are redundant when both present).

### 1.5 (P2) finalizeDirectDecode TileId semantics — P2-h

Line ~834: `tileIdOf(vp, Math.max(vp.w, 1), 0)` uses the viewport width as `tileSize`, producing col/row that disagree with the direct path's `tileIdOf(vp, source.tileSize, 0)` in decode-level.ts. Thread the real `tileSize` into `finalizeDirectDecode` (it is available at every call site via `source.tileSize`) so progress identities are consistent across paths.

### 1.6 (P2) Snap region at pooled entry — P1-F (pool half; Agent 2 owns the caller half)

`decodeTiledViewportPooled` validates finiteness only (≈ lines 1024–1026). Add, after the finite check:

```ts
import { assertFiniteRegion, snapRegionToIntegers } from "./decode-core.js";
assertFiniteRegion(region);
region = snapRegionToIntegers(region);
```

Verify `plan.ts → prepareDecodePlan` first: if it already snaps, document that at the call site instead and skip the change (don't double-snap). If it doesn't, a fractional region makes `need = vp.w * vp.h * bpp` non-integral and `new Uint8Array(need)` throws RangeError.

### 1.7 (micro) Dead/duplicated bits

- `waiters[].expiresAt` is written, never read (removal is via the captured `setTimeout`) — delete the field.
- `onMessage` pixel coercion (≈ lines 623–627): the third branch `new Uint8Array(p)` is unreachable after `parseWorkerReply` filtered to `Uint8Array | ArrayBuffer` — collapse to two branches.
- When `opts.onTile` is undefined in `decodeTilesParallel`, skip building `TileProgress`/`tileKey` strings per tile (string concat per tile per stage for nobody).

---

## Agent 2 — `decode-level.ts` (path-parity batch)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

### 2.1 (P0) Self-inflicted BUFFER_IN_USE on the pooled delegation — P1-A

Order of operations in `decodeTiledViewport`:
1. Lines ~151–159: caller `outBuffer` is validated and **added to `buffersInFlight`**.
2. Line ~183: `progressive === 'dc-then-final'` + parallel ⇒ `return decodeTiledViewportPooled(source, region, options)`.
3. Pooled entry (tiled-decode-pool.ts ~1061): `if (buffersInFlight.has(options.outBuffer)) throw new PyramidError('BUFFER_IN_USE', ...)`.

So the documented flagship combination — caller-recycled buffer + progressive + workers — **always throws**. The `finally` in decode-level removes the buffer afterwards, so it's not sticky, but the decode never runs.

Fix: hoist the delegation decision **above** the outBuffer registration block. The delegation needs only `plan`, `options`, and `canUseParallelTileWorkers()`; nothing before line 151 depends on `buffersInFlight`. Sketch:

```ts
// after plan computed, BEFORE the outBuf block:
const canParallel = canUseParallelTileWorkers();
if (progressiveWanted && !options?.decodeRegion
    && shouldUseParallel(options, plan.tiles.length, canParallel)
    && options?.errorPolicy !== 'skip-tile' && !options?.skipTiles) {   // see 2.3
  return decodeTiledViewportPooled(source, snappedRegion, options);     // see 2.2
}
```

Add a regression test: outBuffer + progressive + mock workerFactory must decode, not throw.

### 2.2 (P1) Pass the snapped region to the pooled path — P1-F (caller half)

Line ~184 currently forwards the **original** `region` even though `snappedRegion` was computed at line ~133. Forward `snappedRegion`. (Agent 1 hardens the pooled entry independently; both sides should hold.)

### 2.3 (P2) Delegation silently drops skip-tile semantics — P2-g

The pooled path is fail-fast only (documented in DecodeOptions). But the delegation at line ~183 fires regardless of `errorPolicy`/`skipTiles`, so a caller asking for `'skip-tile'` + workers silently gets fail-fast and loses resume support. Gate the delegation as in the 2.1 snippet, keeping those requests on the direct progressive path which implements them.

### 2.4 (P1) Restore non-progressive parallel decode — P1-E

Docstring of `decodeTiledViewport` (line ~117): "Uses per-tile parallel decode when workers + COOP/COEP are available; otherwise one WASM call." Reality: the only delegation is inside the `progressive === 'dc-then-final'` branch. A plain `decodeLevel(source, region, { workerFactory })` on an 8-core machine runs **one** synchronous WASM ROI call. Multi-core tiling for ordinary pans was the pool's reason to exist.

Fix: extend the (hoisted, per 2.1) delegation:

```ts
const parallelEligible = !options?.decodeRegion
  && shouldUseParallel(options, plan.tiles.length, canParallel)
  && options?.errorPolicy !== 'skip-tile' && !options?.skipTiles;
if (parallelEligible && (progressive === 'dc-then-final' || progressive === undefined)) {
  return decodeTiledViewportPooled(source, snappedRegion, options);
}
```

`decodeTiledViewportPooled` already handles the non-progressive case (its `else` branch calls `decodeTilesParallel` once with `progressTotal = tiles.length`). Note `!options?.decodeRegion` is required: tests inject mock `decodeRegion` and must keep the one-shot direct path. After this lands, the budget/onTile semantics of the pooled non-progressive path serve plain pans too — verify the existing pooled tests still pass and add one: non-progressive + workerFactory + >1 tile ⇒ pooled path taken (spy on pool.acquire).

### 2.5 (P2) decodeWhole misses the buffersInFlight guard — P2-b

Tiled paths register/check `outBuffer` in `buffersInFlight`; `decodeWhole` (lines ~452+) writes into `outBuf` with neither the `has()` check nor the `add()`/`delete()` bracket. Concurrent whole+tiled decodes into one recycled buffer interleave undetected. Mirror the tiled guard: check `buffersInFlight.has(outBuf)` → throw `BUFFER_IN_USE`; `add` before decode, `delete` in `finally`. Also enforce the 16-bit even-offset alignment check here (`bpp === 8 && outBuf.byteOffset % 2 !== 0` → `INVALID_BUFFER_ALIGNMENT`) for parity with tiled.

### 2.6 (P2) Populate TileProgress.decodeMs — P2-i (direct-path half)

In the progressive direct path, wrap each `decodeTileBytesProgressive` call:

```ts
const t0 = performance.now();
const dcPixels = await decodeTileBytesProgressive(item.bytes, plan.format, 'dc');
const decodeMs = performance.now() - t0;
// ...
const prog: TileProgress = { id, key, stage: 'dc', completed, total, decodeMs, bytesDecoded: item.bytes.byteLength };
```

`bytesDecoded` is free here (`item.bytes.byteLength` from `extractTileBitstream`). This activates the AR/ML cost-accounting fields that decode-core declared (P3, Lens 12/14/16) but never wired. Pooled half: main thread can time `decodeTileWithWorker` round-trip — Agent 1 may add `decodeMs` there opportunistically; `bytesDecoded` is unknown to the pooled main thread (worker holds the container) — leave undefined rather than inventing a protocol change.

### 2.7 (micro)

- `let failedTiles` (line ~193) is never reassigned — `const`.
- Phase-2 loop runs all items after `deadlineHit` just to early-return each — hoist `if (deadlineHit) return;` check before scheduling phase 2 at all (skip the whole `runWithBoundedConcurrency` call).

---

## Agent 3 — `cache.ts` (identity unification)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

### 3.1 (P1) Unify level identity: derive LevelSource ids from bytes — P1-C

Today `getLevelId` has two regimes:
- `Uint8Array` → `bytesId(view)` → `"B7:0:123456"` (buffer + window; stable across re-derived views).
- `LevelSource` → WeakMap per **object identity** → `"L3"`.

Consequences:
1. decode-level keys viewport cache entries with `getLevelId(source)` (`"L#"`); tiled-decode-pool keys with `getLevelId(source.bytes)` (`"B#:…"`). Same level, same viewport, two different keys ⇒ the pooled and direct paths can never hit each other's entries, and a request that flips paths (e.g. once Agent 2 restores delegation) re-decodes and stores a duplicate.
2. `decodeTiledViewportPooled`'s raw-bytes overload constructs a **fresh** LevelSource per call — under object-identity ids each call would get a new "L#" and the cache would never hit at all (the pool only dodges this today because it happens to key by bytes).

Fix — make bytes the canonical identity:

```ts
export function getLevelId(arg: Uint8Array | LevelSource): string {
  if (arg instanceof Uint8Array) return bytesId(arg);
  let id = levelIdBySource.get(arg);
  if (id == null) {
    id = (arg as any).bytes instanceof Uint8Array ? bytesId((arg as any).bytes) : `L${++levelIdCounter}`;
    levelIdBySource.set(arg, id);
  }
  return id;
}
```

This keeps the WeakMap as a memo (one `bytesId` computation per source) and the `L#` branch only as a fallback for byte-less test doubles. Both decode paths then converge on identical keys with **zero call-site edits**. Migration note: in-memory cache entries are session-scoped, so no persisted-key compatibility concern. Add a test: `getLevelId(source) === getLevelId(source.bytes)` for a created LevelSource, and two LevelSources wrapping the same buffer view share an id (that is the pan-cache win).

### 3.2 (P2) Optional eviction hook (telemetry only)

Add to `createInMemoryPyramidCache` opts: `onEvict?: (key: string, bytes: number) => void`, invoked in the `set()` eviction loop and `delete()`. Strictly observational — no abort coupling (see R-1 reasoning in Agent 6). Enables the viewer to log thrash (evictions/sec) and auto-size `maxBytes`. Keep the interface `PyramidCache` unchanged (hook is a constructor opt, not an interface member) so duck-typed caches stay valid.

### 3.3 (micro)

- `levelIdCounter` is shared between `B`/`L` namespaces — harmless, but rename to `idCounter` so nobody assumes density.
- Document on `PyramidCache.get` that returned arrays must be treated as immutable when `zeroCopyCacheHits` is in play (callers exist in both decode files); a one-line JSDoc prevents the aliasing foot-gun.

---

## Agent 4 — `decode-core.ts` (portability + shared helpers)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

### 4.1 (P1) `tileKeyPacked` crashes unbundled browsers — P1-G

Line ~295: `if (process.env.NODE_ENV !== 'production')` — bare `process` reference. tiled-decode-pool already does this correctly (`const DEV = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'`). In a no-bundler browser ESM context this is a ReferenceError the first time any hot map packs a key. Fix: hoist the same `DEV` module const in decode-core and use it (also export it so the pool can import instead of duplicating — optional).

### 4.2 (P2) ensureIccProfile: memoize the promise, not the value — P2-c

Two concurrent `preserveMetadata` decodes of the same source both find `key in source` false and both spin up a header decoder (duplicate WASM work; second result wins harmlessly but wastefully). Standard fix:

```ts
const key = '_iccProfile';           // now stores Promise<Uint8Array|null>
if (key in (source as any)) return (source as any)[key];
const p = (async () => { /* existing body, returning icc|null */ })();
(source as any)[key] = p;
return p;
```

Callers already `await`, so storing the promise is transparent. Keep the `catch → null` inside the IIFE so a failed probe memoizes `null` (current behavior).

### 4.3 (P2) One `cacheStore` to rule them — P2-f

decode-level.ts (~line 86) and tiled-decode-pool.ts (~line 804) each define `cacheStore` with different slice behavior (decode-level branches `byteLength >= need`; pool always `slice(0, need)`). Move a single canonical implementation here:

```ts
export function cacheStore(cache: PyramidCache | undefined, key: string | undefined, pixels: Uint8Array, need: number): void {
  if (!cache || !key) return;
  const cap = cache.capacityBytes;
  if (cap !== undefined && need > cap) return;
  cache.set(key, pixels.byteLength > need ? pixels.slice(0, need) : pixels.slice());
}
```

(`slice()` on an exact-size array equals `slice(0, need)`; the copy is mandatory because the source may be a caller-recycled outBuffer.) Then delete both local copies — that is a 2-line edit in each sibling file; per protocol, implement here and request the two deletions at the end.

### 4.4 (P2) TileProgress contract — P2-i (declaration half)

`decodeMs`/`bytesDecoded` are declared "population deferred". Agents 1/2 populate them. Your job: tighten the JSDoc from "deferred" to the actual semantics (`decodeMs` = wall time of the tile's decode stage as observed by the dispatching thread; `bytesDecoded` = compressed input bytes when known, else undefined) so consumers don't guess.

### 4.5 (micro)

- `raceWithAbort` pre-aborted branch: include `signal.reason` in the message when it is a string — debugging nicety, zero hot-path cost.
- `stitch` fast path comment block (~lines 127–130) is three lines explaining one removed branch; compress to one line (cold-text hygiene, Lens 19 hot/cold split).

---

## Agent 5 — `level-source.ts` (contract hygiene)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

### 5.1 (P2) `prepareLevelSource` is dead code — P2-d

It stamps `(source as any).bytesId = undefined` as a "marker", but `PyramidWorkerPool.allocateBytesId` resolves ids exclusively through its instance `bytesIdBySource` WeakMap and never reads or writes the property. The lone caller is `decodeTiledViewportPooled` (~line 1022), whose call is a no-op. Two options:
- **Delete** `prepareLevelSource`, the `bytesId?` fields on both `LevelSource` variants, and the pooled call site (cross-file: request at end). Preferred — one less lie in the protocol docs.
- Or **wire it for real**: have `allocateBytesId` fast-path `if (typeof (source as any).bytesId === 'number') return source.bytesId;` and write the allocated id back. This saves a WeakMap lookup per decode — measurable nowhere. Take the delete unless you find another consumer via grep (`bytesId` also names an unrelated string function in cache.ts — don't confuse them).

### 5.2 (P2) Validate manifest dims against JXTC header — P2-e

The tiled branch parses the container header and **ignores** `entry.w`/`entry.h` entirely. A corrupted manifest or mismatched sidecar (wrong pyramid level paired with wrong bytes — a real ingest hazard for the biodiversity corpus where sidecars are regenerated) sails through and the viewer renders the wrong level size. Cheap guard:

```ts
if ((entry.w && entry.w !== header.imageW) || (entry.h && entry.h !== header.imageH)) {
  throw new PyramidError('BAD_MANIFEST',
    `manifest says ${entry.w}x${entry.h} but JXTC header says ${header.imageW}x${header.imageH}`);
}
```

Check how `entry.w/h` are typed in `manifest.ts` (`Pick<PyramidLevel, "w" | "h" | "tiled">`) — if they are required numbers, drop the truthiness guards and compare directly.

### 5.3 (Feature, small) Carry the pyramid level index — F-4

Every `tileIdOf(..., 0)` call in decode-level.ts and the `tileLevel ?? 0` in the pool hardcode `level: 0`, so `TileProgress.id.level` and `tileKey` ("L0-…") are constant lies for any pyramid with >1 level. Telemetry, `skipTiles` resume sets shared across levels, and the per-tile cache (Agents 6/7) all benefit from honest levels. Add `level?: number` to both `LevelSource` variants, populate from a new optional `levelIndex` param on `createLevelSource(entry, bytes, levelIndex?)` (callers that don't pass it keep 0 — fully backward compatible), and request the sibling edits (decode-level: `tileIdOf(t, source.tileSize, source.level ?? 0)`; pool: pass `source.level ?? 0` as `tileLevel`) at the end per protocol.

### 5.4 (micro) Precompute grid shape

`decode-level` recomputes `tilesX/tilesY = Math.ceil(width/tileSize)` per progressive call (and builds a synthetic `exHeader`). Since `parseJxtcHeader` already returned `tilesX/tilesY`, carry them on the tiled `LevelSource` (`tilesX: header.tilesX, tilesY: header.tilesY`) and request the decode-level simplification (use `source.tilesX` and drop the recompute; the synthetic `exHeader` then needs no `Math.ceil`) at the end. Micro, but it removes a place where the synthetic header could drift from the parsed one (`hasAlpha: true` guess, `version ?? 1` fallback).

---

## Agent 6 — `decode-level.ts` (features: per-tile cache, prefetch, DC reuse) — run AFTER Agents 1–5

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

### 6.1 (Feature, high ROI) Per-tile caching in the progressive direct path — F-1

The structural flaw in today's cache: entries are keyed by **exact viewport rect** (`viewportCacheKey`), so a 1-pixel pan is a total miss and every tile re-decodes. Meanwhile `cache.ts` ships `makeTileCacheKey(sourceId, tile)` — designed for exactly this — **with zero callers**. The progressive direct path already decodes *full grid tiles* (`extractTileBitstream` + `stitchCropped`), so tile pixels are viewport-independent and perfectly reusable.

Implement (direct progressive path only — the pooled path is Agent 7):

1. Key: `` `${makeTileCacheKey(levelId, id)}:${plan.format}:final` `` where `levelId = getLevelId(source)` (unified by Agent 3) and `id = tileIdOf(t, source.tileSize, source.level ?? 0)`.
2. Phase 2 (final), per tile, **before** decoding: `const hit = cache?.get(tkey); if (hit) { stitchTileIntoViewport(target!, vp, t, hit, source, plan.bpp); ...progress/onTile as success; return; }` — note `stitchTileIntoViewport` expects the *full decoded tile* buffer, which is exactly what we cache; verify `hit.byteLength === decodedW*decodedH*bpp` (recompute decodedW/H as `stitchTileIntoViewport` does) and treat mismatch as a miss.
3. After a successful final decode: `cache?.set(tkey, finalPixels)` — **no slice needed**: `finalPixels` came fresh from `decodeTileBytesProgressive` and is not aliased anywhere after stitching (the current code drops it). Zero-copy insert. Respect `cache.capacityBytes` (skip if a single tile exceeds it; ~256 KiB for 256² rgba8, 2 MiB for 512² rgba16).
4. Do **not** cache DC-stage pixels under the final key. Optional flag `cacheDcTiles?: boolean` on DecodeOptions may store them under `:dc` (see 6.3); default off.
5. Keep the whole-viewport `cacheKeyFinal` entry as-is (it is the O(1) fast path for exact repeats); tile entries are the partial-overlap workhorse. They share one LRU budget — that is fine, recency sorts it out.
6. Tests: pan a viewport by half a tile; assert second decode only decodes the newly exposed tile column (count `createDecoder` invocations via mock).

### 6.2 (Feature) Prefetch API — F-2 (the user's "neighborhood warming" ask)

`level-source.ts` does not compute visibility (the viewer does), so the right shape here is a *mechanism, not policy* pair of exports in decode-level.ts:

```ts
/** Pure helper: extrapolate the viewport along its velocity. leadMs ~ one decode round-trip. */
export function predictRegion(vp: ImageRegion, velXPxPerMs: number, velYPxPerMs: number, leadMs: number): ImageRegion {
  return { x: vp.x + velXPxPerMs * leadMs, y: vp.y + velYPxPerMs * leadMs, w: vp.w, h: vp.h };
}

/** Warm the tile cache for a (predicted) region. Never throws; resolves when done or aborted. */
export async function prefetchViewport(
  source: Extract<LevelSource, { kind: "tiled" }>,
  region: ImageRegion,
  options: Pick<DecodeOptions, 'cache' | 'signal' | 'workerFactory' | 'pool' | 'parallel' | 'coreBudget'>,
): Promise<void> {
  if (!options.cache) return;                       // pointless without a cache
  try {
    await decodeTiledViewport(source, region, { ...options, errorPolicy: 'skip-tile', progressive: undefined });
  } catch { /* prefetch is best-effort by definition */ }
}
```

Notes: with 6.1/7.1 in place, this populates tile-granular entries any future viewport reuses — the prefetched rect need not match the future request. Clamp the predicted region to image bounds via `clampRegion` before decoding. Document the cancellation pattern (this is also the corrected form of the "link cache eviction to decode aborts" idea — see R-1): **the viewer holds one `AbortController` per prefetch generation and aborts it whenever a real viewport request lands or velocity reverses.** Cache eviction must *not* abort decodes — eviction means "least recently used", not "no longer wanted"; an in-flight decode for a visible tile whose old entry got evicted is still wanted. Generation-abort expresses actual intent and already flows through every layer via the existing `signal` plumbing. Record this reasoning in `docs/rejected optimizations.md` as the disposition of the eviction-abort proposal.

Priority hygiene: prefetch must not starve visible decodes. Cheapest contention control without new tunables: pass through `coreBudget` and recommend callers give prefetch a pre-aborted-on-interaction signal; if you find `pool.acquire`'s `maxWaitMs` reachable through DecodeOptions, plumb `{ maxWaitMs: 0 }` for prefetch so it yields instantly under contention — if not reachable, note it as a deferred cross-file request to Agent 7's file rather than widening DecodeOptions speculatively.

### 6.3 (Feature, optional) DC-quality reuse — F-3

With `cacheDcTiles` on, phase 1 stores DC tile pixels under `...:dc`; on a later progressive request, phase 1 checks `:final` first (skip both stages, stitch final), then `:dc` (stitch instantly, skip the DC decode, still run final). This makes pan-back during progressive browsing paint coarse content in ~0 ms. Strictly additive; gate everything behind the flag; DC entries are small (DC is 1:8 scale… **verify**: if `decodeTileBytesProgressive('dc')` returns full-resolution upsampled DC pixels — same byteLength as final — the cache cost equals final tiles and the flag should default off and say so in JSDoc).

---

## Agent 7 — `tiled-decode-pool.ts` (per-tile cache in the pooled path) — run AFTER Agents 1–3 and 6

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

### 7.1 (Feature, high ROI) Tile-granular cache in `decodeTilesParallel` — F-1 (pooled half)

Precondition check (do this first): the direct path caches **full grid tiles**; the pooled path asks workers to decode `region = plan.tiles[i]`, which may be the *viewport-clipped* intersection at viewport edges. Inspect `plan.ts → prepareDecodePlan`: if `plan.tiles` are grid tiles clipped only to the image, pixels are already reusable — proceed directly. If they are clipped to the viewport, change the pooled request regions to **image-clipped full grid tiles** (derive from `tileIdOf` col/row: `x = col*tileSize, y = row*tileSize, w = min(tileSize, width-x), h = min(tileSize, height-y)`) and stitch with `stitchCropped` (already exported from decode-core; the direct path's `stitchTileIntoViewport` in decode-level shows the exact call shape). Cost: a few extra pixel rows decoded at viewport edges; benefit: every tile decoded anywhere becomes reusable everywhere. If you determine the extra decode cost is unacceptable for tiny viewports (e.g. viewport ≪ tileSize), fall back to caching only unclipped (interior) tiles — they dominate pans anyway.

Then:
1. In `decodeTiledViewportPooled`, when `options.cache` is set, pre-partition `orderedTiles` into hits/misses using the same key scheme as Agent 6.1 (`makeTileCacheKey(getLevelId(source), id)` + `:${format}:final`). Stitch hits immediately (synchronously, before acquiring workers), fire `onTile` for each, and only dispatch misses to `decodeTilesParallel`. If **all** tiles hit, skip pool acquisition entirely — a pan-back costs zero workers.
2. In the `decodeTilesParallel` success path (~line 909–925), after `stitch(...)` and before the `pixels = null` drop: `if (tileCache && stage === 'final') tileCache.set(tkey, decoded.pixels as Uint8Array);` — the worker reply pixels arrived via structured clone/transfer and are exclusively owned here; inserting them into the cache **instead of nulling** is zero-copy. (This is not the rejected "pixel buffer pool" — there is no release lifecycle; the cache owns the buffer outright and LRU-evicts it.) Only cache when the decoded region is a full grid tile per the precondition above.
3. Plumb `tileCache`/`sourceLevelId`/`tileSize` through `decodeTilesParallel`'s opts bag rather than new positional params (it already has 4 trailing positionals — Lens 8 hygiene: fold `deadlineMs/requestTimeoutMs/tileSize/tileLevel` into the opts object while you are there, updating the two internal call sites and `__testing` consumers).
4. Progress accounting: cache hits count toward `completed`/`total` so `onTile` consumers see a monotonic completion sequence identical to the all-decode case.
5. Tests: two overlapping pooled viewport decodes; assert the second dispatches only non-overlapping tiles (count worker postMessages); assert zero acquisitions on full overlap.

### 7.2 (micro) Center-out sort duplication

The center-out comparator now exists in decode-level (~lines 228–232) and the pool (~lines 1124–1128) verbatim. After Agent 4 lands shared helpers in decode-core, move this to decode-core as `sortCenterOut(tiles, vp)` and import from both (request the decode-level edit at the end). One implementation, one set of tests, and a single place to upgrade to Hilbert-order if profiling ever justifies it (it currently does not — n is tens of tiles; do not add a tunable).

---

## What implementing this achieves

The pyramid layer currently has two decode engines — a main-thread progressive path and a worker pool — that were built to be interchangeable but have drifted into observable disagreement: they key the same cache with different identities, snap regions differently, guard buffers differently, and one of their flagship combinations (recycled buffer + progressive + workers) throws on contact. Agents 1–5 are a convergence pass: after them, a viewport request produces the same cache entries, the same TileId telemetry, the same buffer-safety guarantees, and the same error taxonomy regardless of which engine serves it, and the pool's resource accounting (CoreBudget tokens, SAB retention, ready-promise lifecycle) no longer leaks under failure. These are not speculative hardenings — the BUFFER_IN_USE self-conflict, the budget leak, and the ready-hang are deterministic failures reachable from documented option combinations.

The performance recovery is equally concrete. Restoring the non-progressive pooled delegation (2.4) returns plain pans — the most common gesture in the viewer — to multi-core decode instead of one synchronous WASM call, an expected near-linear speedup on the tile-bound portion. Unifying cache identity (3.1) means the direct and pooled paths stop double-decoding and double-storing each other's viewports, effectively doubling the useful capacity of the existing 32 MiB LRU for mixed workloads.

The feature arc (Agents 6–7) changes the cache's unit of account from "exact viewport rectangle" to "grid tile", activating the `makeTileCacheKey` infrastructure that has been shipped but dormant. This is the megatexture/texture-streaming model from game engines applied to JXL pyramids: a pan by half a tile re-decodes one tile column instead of the whole viewport, a pan-back costs zero decodes and zero worker acquisitions, and the velocity-prefetch API lets the viewer warm tiles just ahead of motion so the white grid lines the user described never enter the frame. Because prefetch lands in the same tile-granular cache, prediction errors are not wasted — any future viewport overlapping the prediction reuses the tiles. The corrected cancellation model (generation AbortControllers owned by the viewer, not eviction-coupled aborts) gives the "stop stale work instantly on zoom" behavior the original idea wanted, expressed through plumbing that already exists in every layer.

For the longer arc — the biodiversity platform, AR identification, photogrammetry QC — the smaller items compound: honest per-level TileIds and populated `decodeMs`/`bytesDecoded` turn TileProgress into a real cost-and-identity stream for ML budgeting and re-capture decisions; manifest-versus-header dimension validation catches sidecar mispairings at ingest instead of at render; and ICC pass-through now survives concurrent requests without duplicate probes. None of it adds tunables, none of it crosses into the jxl-scheduler's territory, and every change keeps the two-engine architecture — it just makes both engines tell the same story.
