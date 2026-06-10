# LevelSuggestions — decode-level.ts / level-source.ts / decode-core.ts

23-lens-style review, 2026-06-10. Scope locked to the three files (in-memory analysis).
Tags: [bug] [perf] [eff] [feat] [dx] [test]. Line refs are to the reviewed snapshot.

> **Snapshot warning (2026-06-10):** review and line refs target the trio as of commit `1545de03`. A concurrent agent session (commits `97a48634`…`c6f0f63a`, "Agent 1/4") changed these files since (+458/−111) and its stash/clean cycles deleted this document four times mid-session. Re-validate each finding against HEAD before implementing — some may already be done.

## Lens 1 — Strategic view: roles, links, data flow

Roles: `decode-core.ts` = stateless contract layer (types, error taxonomy, geometry clamps, stitch kernels, abort racing). `level-source.ts` = adapter: manifest entry + bytes → `LevelSource` union; validation choke point. `decode-level.ts` = orchestrator: plan → extract → WASM decode → stitch → cache → progress.

Data flow: `PyramidLevel`+bytes → `createLevelSource` → `LevelSource{kind,bytes,w,h,tileSize,bits,format,bpp,bytesId?}` → `decodeLevel(source, region, options)` → `prepareDecodePlan` → tiles → `extractTileBitstream` → decode → `stitchCropped` into viewport buffer → `DecodedLevel` (+ cache side-channel via `PyramidCache`).

- **L1-1 [bug] Single-parse violation, `hasAlpha` guessed.** `createLevelSource` parses the JXTC header then discards it; `decodeTiledViewport` re-synthesizes one with hardcoded `hasAlpha: true` (decode-level.ts:171). Alpha-less containers get wrong `extractTileBitstream` offsets. Fix: carry `header: TilingJxtcHeader` on the tiled `LevelSource`; use it; delete the synthesis block.
- **L1-2 [feat] Pyramid level index missing.** `LevelSource` doesn't know which level it is → every `tileIdOf(..., 0)` call hardcodes `level: 0`; `TileId.level` lies in telemetry/cache keys. Fix: optional `level?: number` on `LevelSource` (set in `createLevelSource` caller), threaded to `tileIdOf`.
- **L1-3 [dx] JXTC internals leak into orchestrator.** decode-level imports `extractTileBitstream` and rebuilds header geometry plan.ts already owns. Fix: plan returns `{rect, bytes}` per tile (or a tiling helper takes the source); orchestrator stops knowing container layout.
- **L1-4 [eff] Cache-key construction split.** `viewportCacheKey` lives in core; `decodeWhole` builds `${getLevelId(bytes)}-WxH-fmt-whole` inline ×3 (decode-level.ts:387,443). Fix: `wholeCacheKey()` in decode-core; one format, one place. Code: see L19c-1.
- **L1-5 [dx] Identity mismatch.** Tiled path keys cache by `getLevelId(source)` (object), whole path by `getLevelId(bytes)`. Same bytes wrapped in two sources → duplicate tiled entries, deduped whole entries. Pick bytes identity for both.

## Lens 2 — Public API surface

Exports: decode-level → `decodeLevel`, `decodeTiledViewport` + type/value re-exports. decode-core → kernels, keys, errors, `DecodeOptions`, `REGION_DECODER_RGBA8/16`, `pickRegionDecoder`, `raceWithAbort`. level-source → `createLevelSource`, `prepareLevelSource`, `LevelSource`. WASM bindings touched: `createDecoder`, `decodeTileContainerRegionRgba8/16`. Worker message handlers: none in scope (`WorkerLike` duck type only).

- **L2-1 [dx] Unused import.** `stitch` imported at decode-level.ts:7, never used nor re-exported (only `stitchCropped` is). Remove.
- **L2-2 [dx] `pool?: any`** in `DecodeOptions` (decode-core.ts:309). Fix: `pool?: import('./pool.js').PyramidWorkerPool` type-only import — typed, no runtime cycle.
- **L2-3 [dx] Options surface overlaps layers.** `parallel`/`workerFactory`/`pool` are unused by these files (consumed by plan/pool). Split `CoreDecodeOptions` ⊂ `PooledDecodeOptions` so the direct-path signature is honest about what it reads.
- **L2-4 [dx] No nominal plan type.** `let plan: ReturnType<typeof prepareDecodePlan>` (decode-level.ts:103). Export `DecodePlan` from plan.ts.
- **L2-5 [dx] Pointless casts.** `decodeWhole`'s `nominalSource` is typed `LevelSource & {width,height}` yet read via `(nominalSource as any)?.width` (decode-level.ts:376-377). Drop the casts.
- **L2-6 [dx] `prepareLevelSource` marker is opaque.** Writes `bytesId = undefined` so `'bytesId' in source` flips true. Works, but use `bytesId: number | null` (null = reserved, number = pool-assigned) and document the protocol.

## Lens 3 — Pipeline stages (decode → transform → resize → encode → cache → return)

Stages present: decode (WASM) → stitch → cache → return. No transform/resize hooks (see L17-2), no encode (out of scope by design).

- **L3-1 [bug][HIGH] Cache poisoning on budget truncation.** With `errorPolicy:'skip-tile'` + `budgetMs`, deadline `break` exits Phase 1/2 early (decode-level.ts:182,216); un-attempted tiles never enter `failedTiles`; the `failedTiles.length === 0` gate (decode-level.ts:258) then **caches the partial buffer under quality `'final'`**. Every later cache hit serves a half-decoded viewport. Fix: track per-tile final success; cache only on full completion; surface truncation so resume is possible.

  ```ts
  // DecodedLevel additions (decode-core.ts)
  truncated?: boolean;        // budget/abort/demotion ended work early
  remainingTiles?: TileId[];  // tiles whose 'final' never landed (disjoint from failedTiles)

  // decodeTiledViewport — "attempted" is ambiguous; track per-tile final success instead:
  const finalDone: boolean[] = new Array(n).fill(false); // set on final-stitch success (or L6-1 early-final)

  // cache gate — replaces `failedTiles.length === 0` (decode-level.ts:258):
  const fullyDecoded = failedTiles.length === 0 && !skipTiles && finalDone.every(Boolean);
  if (cache && cacheKeyFinal && fullyDecoded) cache.set(cacheKeyFinal, target.slice(0, need));
  if (!finalDone.every(Boolean)) {
    result.truncated = true;
    result.remainingTiles = ids.filter((_, i) => !finalDone[i] && !failedKeys.has(keys[i]));
  }
  ```

- **L3-2 [bug] skipTiles without outBuffer → black rects as final.** Resume contract assumes prior pixels exist, but with no `outBuffer`, `target` is fresh zeroed memory; skipped rects stay black, result is returned — and cached as final. Fix: throw when `skipTiles` is set without `outBuffer`; exclude from cache whenever `skipTiles` is non-empty (enforced by the `!skipTiles` term in the L3-1 gate).
- **L3-3 [bug] Unreadable whole-cache writes.** `decodeWhole` with `!haveNominal`: `cache.set` keys by actual dims (decode-level.ts:441-448) but `cache.get` only runs when `haveNominal` (decode-level.ts:386) — entries can never be read. Pure memory + copy waste. Fix: skip the set when `!haveNominal`.
- **L3-4 [feat] Whole path silently ignores `progressive`.** Whole-frame DC is the cheapest first paint in JXL. Either implement (DC pass → `onTile(stage:'dc')` → final) or throw on `progressive` + whole so callers learn the truth.
- **L3-5 [feat] DC viewport never cached.** `viewportCacheKey` supports `q:'dc'` but nothing writes it. After Phase 1, one `cache.set(dcKey, snapshot)` copy buys instant coarse paint on revisit/re-pan while final decodes.

## Lens 4 — State machinery (session / queue / cancellation / error)

Functions are stateless (good); the only shared state is module-level `buffersInFlight: WeakSet`.

- **L4-1 [bug] `buffersInFlight` guard missing in `decodeWhole`.** Tiled path registers outBuffer (decode-level.ts:122,127); whole path accepts `outBuffer` with no registration → two concurrent whole decodes into one buffer corrupt silently. Fix: same add/try/finally in `decodeWhole`. Also a tiled+whole pair sharing a buffer is only half-guarded.
- **L4-2 [bug] `decodeWhole` unabortable after entry.** Signal checked once at :369; `push`/`close`/drain never raced. Tiled direct path uses `raceWithAbort` (decode-level.ts:272). Fix: race the pipeline as one promise.

  ```ts
  // decodeWhole — race the whole pipeline, not individual awaits; dispose stays in finally:
  const pipeline = (async () => {
    await decoder.push(bytes);
    await decoder.close();
    return await drainOutcome;
  })();
  const out = signal ? await raceWithAbort(pipeline, signal) : await pipeline;
  ```

- **L4-3 [eff] Abort latency in progressive loops.** Signal checked only at loop tops; the in-flight tile await is unraced, so abort waits a full tile. Pass `signal` into `decodeTileBytesProgressive`, check between push/close/drain.
- **L4-4 [dx] `raceWithAbort` discards `signal.reason`.** Attach it: `new PyramidError('ABORTED', 'decode aborted', signal.reason)` — preserves caller's reason chain (decode-core.ts:244).
- **L4-5 [feat] Resume state half-built.** `failedTiles` lists decode errors but not un-attempted tiles (budget/abort), so callers can't construct the complement `skipTiles` set. With L3-1's `remainingTiles`:

  ```ts
  // decode-core.ts — semantics: skipTiles skips BOTH stages of a tile, so only fully-final tiles
  // qualify; resume REQUIRES the same outBuffer (prior pixels are the data for skipped rects).
  export function skipSetFrom(result: DecodedLevel, allIds: readonly TileId[]): ReadonlySet<string> {
    const redo = new Set<string>(
      [...(result.failedTiles ?? []), ...(result.remainingTiles ?? [])].map(tileKey),
    );
    const skip = new Set<string>();
    for (const id of allIds) {
      const k = tileKey(id);
      if (!redo.has(k)) skip.add(k);
    }
    return skip;
  }
  ```

## Lens 5 — Data structures (buffers, queues, manifests, tile descriptors, options)

- **L5-1 [bug] Asymmetric OOM caps.** Whole branch caps 1 GiB / 2^24 dims (level-source.ts:44); tiled branch trusts `parseJxtcHeader`, and `decodeTiledViewport` allocates `need = vp.w*vp.h*bpp` unchecked (decode-level.ts:113,161). Fix: mirror the cap in the tiled branch of `createLevelSource` and cap `need` with `PyramidError('OOM')`.
- **L5-2 [eff] `failedTiles` post-pass dedup.** Array + rebuild Set + second loop (decode-level.ts:248-257). Replace with insert-time guard: keep `failedKeys: Set<string>`, check at push site, drop the post-pass.
- **L5-3 [eff] Tile id/key built twice per tile.** Phase 1 and Phase 2 each call `tileIdOf` + `tileKey` (decode-level.ts:186-187,220-221). Precompute `ids[i]`/`keys[i]` alongside `tileBytesList` — one pass, reused by both phases, `skipTiles` lookups, and progress objects.
- **L5-4 [dx] `DecodeOptions` is a 13-field bag** mixing direct/pooled/progressive concerns. Non-breaking now: group the doc comments. Later: nest `progressive?: { mode, errorPolicy, budgetMs, skipTiles }`.
- **L5-5 [dx] `tileKeyPacked` bounds unchecked.** Silently collides at col/row ≥ 2^20. Verified: max documented values (level 8191, row/col 2^20−1) hit exactly `Number.MAX_SAFE_INTEGER` — safe but zero headroom. Add a dev-mode assert; document exactness (decode-core.ts:282-284).

## Lens 6 — Hot kernels (pixel/chunk/copy loops, colour transforms, resampling)

No pixel math in these files (decode lives in WASM); the hot loops are copies and the per-tile decode driver.

- **L6-1 [perf][HIGH] Progressive decodes every tile bitstream twice from byte 0.** DC session + final session ≈ 1.3–1.5× one full decode per tile. `decodeTileBytesProgressive` already receives `final` events during the DC stage on fast/small tiles (decode-level.ts:316-322) and discards that fact. Fix A (free):

  ```ts
  // decodeTileBytesProgressive returns what it actually reached:
  ): Promise<{ px: Uint8Array; reached: 'dc' | 'final' }>
  // dc stage: pixels from a 'final' event mean the tile fully decoded in one shot:
  if (stage === 'dc') return { ok: true, px, reached: ev.type === 'final' ? 'final' : 'dc' };

  // Phase 1 caller — progress accounting stays exact (total = n*2): emit the tile's 'final'
  // tick immediately so consumers still see completed reach total:
  const { px, reached } = await decodeTileBytesProgressive(tileBytesList[i], plan.format, 'dc');
  stitchTileIntoViewport(target, vp, t, px, source, plan.bpp);
  completed += 1;
  onTile?.(t, completed, { id, key, stage: 'dc', completed, total });
  if (reached === 'final') {
    finalDone[i] = true;
    completed += 1;
    onTile?.(t, completed, { id, key, stage: 'final', completed, total });
  }
  // Phase 2: if (finalDone[i]) continue; // ticks already emitted above
  ```

  Fix B (bigger): one decoder with `progressionTarget:'final'` + DC flush event per tile — single parse; stash per-tile final promises to preserve all-DC-first paint order; gate by tile count (n live decoders = WASM memory).
- **L6-2 [eff] Dead fast-path clause.** `stitch`'s `decoded.height + dy <= viewport.h` (decode-core.ts:119) is already guaranteed by the STITCH_OOB throw at :112. Drop or comment as dead.
- **L6-3 [dx] `zeroFillRect` silently returns on OOB** (decode-level.ts:74) while the stitch kernels throw `STITCH_OOB` for the same caller-bug class. Throw (or dev-assert) — silent skip hides geometry bugs in skip-tile paths.
- **L6-4 [perf] Budget overshoot by one tile.** Deadline checked before each decode; a tile starting at deadline−1ms runs to completion. Predictive stop: EMA of per-tile decode ms, halt when `now + ema > deadline`. Needs benchmark data before tuning (house rule on heuristics) — but the hook (timing per tile) is free; see L8-2. Mechanics: see the L18-3 executor.
- **L6-5 [eff] Row-loop subarray churn: keep as-is.** 2 views/row GC pressure is dominated by memcpy; hand-rolled element loops are slower. Verdict: no change (documenting so it isn't "optimized" later).

## Lens 7 — Boundary points (JS↔WASM, worker↔main, memory copies)

Copy audit, direct progressive path, per tile: (1) bytes → WASM heap upload, (2) WASM → JS pixel event, (3) pixels → viewport stitch memcpy, (4) viewport → cache slice, (5) cache → caller copy on hit (default). Worst case 5 copies of pixel-scale data.

- **L7-1 [perf] Repeated bytes upload across pans.** `decodeRegion(source.bytes, vp)` and per-tile pushes re-upload the same level bytes into the WASM heap on every decode call; a pan session re-uploads megabytes repeatedly. `LevelSource.bytesId` already exists for the pool protocol ("avoid N-clones") — extend the same idea to the facade: `pinBytes(bytes) → id`, region/tile decode by id. Plumbing, not batching, so it respects layer rules.
- **L7-2 [perf] Decode-into-dest (kill copy #3).** Facade decodes into its own buffer; we stitch-copy after. Add optional `dest {buffer, byteOffset, rowStrideBytes}` to the region decoders — libjxl supports strided output buffers — so WASM writes rows directly into the viewport buffer. Deletes one full tile-size copy per tile; also unlocks the GPU-stride feature (L14-2).
- **L7-3 [eff] Cache boundary trusted blindly.** `cache.get` result used unvalidated (decode-level.ts:133-142): a wrong-size entry (format migration, eviction-truncating impl) throws a raw `RangeError` from `outBuf.set` or silently corrupts. Validate `cached.byteLength === need`; mismatch ⇒ treat as miss + delete entry.
- **L7-4 [dx] Rust↔C/C++: not present in these files** (bridge.cpp downstream of facade). Worker↔main likewise lives in pool/worker files. No action here; boundary inventory recorded for completeness.

## Lens 8 — Support code (validation, logging, progress, tests)

Validation: strong (finite/snap/clamp/output-mismatch/alignment). Logging: none. Progress: `onTile` + `TileProgress`.

- **L8-1 [test] Missing tests** (decode-level.test.ts gaps): (a) budget truncation ⇒ no cache write + truncation reported (L3-1); (b) `skipTiles` without `outBuffer` rejected (L3-2); (c) concurrent `decodeWhole` sharing an outBuffer (L4-1); (d) whole-path cache hit then caller mutation — cache must stay clean (L9-1); (e) alpha-less JXTC through the progressive path (L1-1); (f) abort mid-Phase-1 → listeners cleaned, `ABORTED` thrown, no unhandled rejections.
- **L8-2 [feat] `TileProgress` lacks timing.** Add optional `decodeMs?: number`, `bytesIn?: number` — feeds the EMA stop (L6-4), telemetry, and AR frame budgeting (L16-3). Zero cost when `onTile` absent.
- **L8-3 [dx] No trace hook.** One optional `options.trace?(event: {phase, key, ms})` beats future console sprinkles; tree-shakes to nothing when unused.
- **L8-4 [dx] Hygiene.** `let failedTiles` never reassigned → `const` (decode-level.ts:154); progressive block decode-level.ts:162-245 is mis-indented (body sits at `if` level) — pure format fix but it actively misleads readers about scope.
- **L8-5 [dx] `(cache as any).capacityBytes` ×3** (decode-level.ts:259,286,444). Declare `capacityBytes?: number` on `PyramidCache` and add `fitsCache(cache, bytes): boolean` in decode-core; deletes all three casts and the triplicated logic.

## Lens 9 — Owl (near/far sight, hearing, looking behind)

Far sight = compare the two paths side by side; the whole path is the tiled path's neglected twin.

- **L9-1 [bug] Whole cache hit is zero-copy without opt-in.** `decodeWhole` returns the cache's internal buffer directly (`const pixels = cached;` decode-level.ts:395) while the tiled path copies unless `zeroCopyCacheHits`. Caller paints/mutates ⇒ poisoned cache for every later hit. Fix: `zeroCopyHits ? cached : new Uint8Array(cached)` — mirror tiled.
- **L9-2 [bug] Short cache entry silently truncated into outBuf.** `outBuf.set(cached.length >= need ? cached.subarray(0, need) : cached)` (decode-level.ts:392) accepts undersized entries without error → partial pixels presented as a full frame. Throw or treat as miss (pairs with L7-3).
- **L9-3 [dx] Whole path returns the entire outBuf** (decode-level.ts:393,436), not `subarray(0, need)` like tiled (decode-level.ts:137,280). Consumers measuring `pixels.byteLength` misread. Align on subarray.
- **L9-4 [feat] Night vision: zero-filled holes are premultiplied-transparent black.** Viewers compositing on white show hard black squares for skipped tiles. Offer fill style (neutral gray / leave-previous when outBuffer recycled) or document the compositing expectation loudly.
- **L9-5 [eff] Hearing: the pipeline is silent** — no stage timings anywhere (confirms L8-2 priority). An owl that can't hear its prey starves; ship `decodeMs` first, tune later.

## Lens 10 — Run the film backwards (4 findings, each a reversal)

- **L10-R1 [feat][HIGH] Reverse the cache grain: tile-level, not viewport-level.** Today caching happens *after* assembly (exact-rect `viewportCacheKey`), so any 1px pan misses 100%. Reversed: cache *before* assembly, per tile; stitch from cached tiles, decode only the missing ones. Overlapping viewports during pan reuse ~all tiles. The keys (`TileId`, `tileKey`) already exist — this is what they were built for.

  ```ts
  // decode-core.ts — tile cache stores the FULL decoded tile (clipped decodedW×decodedH at image
  // edges), never viewport-cropped pixels; lookups recompute decodedW/H from source dims so
  // validation is exact for edge tiles.
  export const tileCacheKey = (
    levelId: string, id: TileId, format: PixelFormat, q: 'dc' | 'final',
  ): string => `${levelId}:t${tileKeyPacked(id)}:${format}:q${q}:v${CACHE_SCHEMA_VERSION}`;

  // decodeTiledViewport, per tile:
  const tk = tileCacheKey(levelId, ids[i], plan.format, stage);
  const hit = tileCache.get(tk);
  if (hit && hit.byteLength === decodedW * decodedH * plan.bpp) {
    stitchTileIntoViewport(target, vp, t, hit, source, plan.bpp); // no decode
  } else {
    const { px } = await decodeTileBytesProgressive(tileBytesList[i], plan.format, stage);
    tileCache.set(tk, px); // safe to retain: stitch copies, never aliases px
    stitchTileIntoViewport(target, vp, t, px, source, plan.bpp);
  }
  // CAVEAT: with onTileTransform (L17-2) mutating px in place, cache BEFORE the transform
  // (cache raw, re-apply look on hit) or key by look-id; never cache transformed pixels
  // under the raw key.
  ```

- **L10-R2 [feat] Reverse priority under pressure: demote, don't truncate.** When the deadline nears in Phase 2, current code stops — half-sharp, half-missing. Reversed: spend remaining budget finishing *DC everywhere*. A uniformly coarse image beats a torn one. Mechanics: see the L18-3 executor's demotion branch; pairs with L3-1's truncation reporting.
- **L10-R3 [bug] Assume failure, prove success: pre-zero recycled canvases.** With recycled `outBuffer` + `skip-tile`, a budget break leaves *stale pixels from the previous pan* in un-attempted tile rects — worse than black: plausible wrong imagery.

  ```ts
  // decodeTiledViewport, before Phase 1 — only the recycled-buffer + skip-tile combination
  // can leak stale pixels:
  if (outBuf && errorPolicy === 'skip-tile') {
    if (!skipTiles || skipTiles.size === 0) {
      target.fill(0, 0, need);                  // no resume data to preserve: wipe all
    } else {
      for (let i = 0; i < n; i++) {             // preserve only rects resume will skip
        if (!skipTiles.has(keys[i])) zeroFillRect(target, vp, plan.tiles[i], plan.bpp);
      }
    }
  }
  ```

- **L10-R4 [feat] Run the errors backwards: retry pass.** Failures are pushed forward into `failedTiles` and forgotten. Reversed: after Phase 2, if budget remains, replay `failedTiles` once (transient OOM/GC errors often succeed on retry); only then zero-fill survivors. One bounded loop, removes most black holes at zero happy-path cost.

## Lens 11 — Astronomy (telescopes on the code)

The pyramid *is* an astronomy survey: levels = plate-scale ladder, tiles = sky patches, region decode = cutout service, progressive DC = quick-look frame.

- **L11-1 [feat] HiPS/Morton tile ordering.** Astronomy's HiPS serves hierarchical tiles in Z-order for spatial locality. Iterate `plan.tiles` in Morton order → adjacent decodes touch adjacent tile-cache entries (L10-R1); combines with center-out (L13-1) as "spiral survey".

  ```ts
  // Morton/Z-order comparator (col,row < 2^16 — true for any plausible level):
  function part1by1(v: number): number {
    v = (v | (v << 8)) & 0x00ff00ff;
    v = (v | (v << 4)) & 0x0f0f0f0f;
    v = (v | (v << 2)) & 0x33333333;
    v = (v | (v << 1)) & 0x55555555;
    return v;
  }
  export const mortonOrder = (a: TileId, b: TileId): number =>
    ((part1by1(a.col) | (part1by1(a.row) << 1)) >>> 0) -
    ((part1by1(b.col) | (part1by1(b.row) << 1)) >>> 0);

  // Center-out comparator (L13-1 / L16-1) — cx,cy in image px, tileSize from source:
  export const centerOut = (cx: number, cy: number, tileSize: number) =>
    (a: TileId, b: TileId): number => {
      const h = tileSize / 2;
      const da = (a.col * tileSize + h - cx) ** 2 + (a.row * tileSize + h - cy) ** 2;
      const db = (b.col * tileSize + h - cx) ** 2 + (b.row * tileSize + h - cy) ** 2;
      return da - db;
    };
  ```

- **L11-2 [feat] WCS for specimens.** Every FITS tile carries world coordinates; our `LevelSource` carries none. Optional affine `imageToWorld: [a,b,c,d,tx,ty]` on `LevelSource` → georeferenced herbarium sheets (mm grid), collection-site coordinates, coordinate-true annotation overlays at every pyramid level. One field, no decode-path cost.
- **L11-3 [feat] Magnitude-limited serving: per-tile `convergedByteEnd`.** Astronomy serves magnitude-limited previews; our ratified `convergedByteEnd` truncates at the visually-converged byte per *image*. JXTC gives the natural refinement: per-tile converged offsets in the manifest → tile fetch/decode stops early per tile. Measured offline at ingest, honored in stream layer; these files only need the manifest field passed through `LevelSource`.
- **L11-4 [dx] Name the cutout.** `decodeLevel(source, region)` *is* an IIIF `region=`/astro cutout API. Document the equivalence so interop (IIIF Image API for the biodiversity platform) maps 1:1 onto existing functions instead of growing a parallel path.

## Lens 12 — LLM / machine recognition

- **L12-1 [feat] `'dc-only'` mode as inference prefilter.** Phase 1 alone (full-size pixels, 1/8 detail) is ideal classifier/embedding input at a fraction of decode cost. Add `progressive: 'dc-only'` (Phase 1, cache under `q:'dc'`, return). Recognition pipeline: classify on DC → decode `final` only for tiles the model flags (its attention map becomes the `skipTiles` complement). Species-ID triage across thousands of specimens without full decodes.
- **L12-2 [feat] Tensor export helper (JS-side).** `toTensor(decoded, {layout: 'HWC'|'CHW', dtype: 'f32', dropAlpha: true})` → Float32Array, normalized. JS-side packing per the ratified packedRgb16 precedent; no WASM change, no new deps; removes every consumer's bespoke RGBA→RGB float loop.
- **L12-3 [feat] Priority-ordered decode.** Optional `tileOrder?: (a: TileId, b: TileId) => number` (or precomputed priority array from manifest saliency scores computed offline) — informative tiles decode first, so a recognition pipeline streaming via `onTile` sees its answer before the decode finishes. Same hook implements center-out (L13-1) and foveation (L16-1). Wiring: see the L18-3 executor's `buildUnits`.
- **L12-4 [feat] Annotation contract.** `TileId`/`tileKey` are stable and deterministic — document them as the alignment contract for Darwin Core occurrence ↔ tile mapping (annotation store keyed by `tileKey` at level L). Requires honest `TileId.level` first (L1-2).

## Lens 13 — Gaming principles

- **L13-1 [feat] Center-out tile order.** Sort `plan.tiles` by distance² from viewport center before Phase 1 — players (users) look at the middle; perceived latency drops for free. Code: `centerOut` comparator under L11-1; plugged in via L12-3's `tileOrder`.
- **L13-2 [perf] Fixed-timestep discipline.** Games never let one job blow the frame; we let one tile blow `budgetMs` (L6-4). EMA-projected stop + DC demotion (L10-R2) = the gaming "drop LOD, never drop frame" rule. Gate tuning on benchmark numbers per house rule.
- **L13-3 [feat] Velocity prefetch.** Texture streaming decodes ahead of camera motion. Viewer passes pan velocity → spend leftover budget decoding the leading edge of the *next* viewport. With tile-grain cache (L10-R1) results are reusable whatever the user does next. These files need nothing beyond L10-R1 + docs; scheduling itself belongs to the caller/pool.
- **L13-4 [dx] LOD pop mitigation is already possible — document it.** `onTile` reports `stage: 'dc' | 'final'`; the crossfade recipe (paint DC, alpha-blend final over ~100ms) needs zero engine change. A doc paragraph prevents someone "adding" it to the decode layer.
- **L13-5 [dx] Occlusion culling exists — it's `skipTiles`.** Name the pattern in docs for viewer devs (tiles hidden behind UI/overlays → skip). No code.

## Lens 14 — Photogrammetry / digital twins

- **L14-1 [feat][HIGH] Metadata survives nowhere.** `WHOLE_DECODE_OPTS` and the tile driver hardcode `preserveIcc: false, preserveMetadata: false` (decode-core.ts:37-42; decode-level.ts:307-313). Camera intrinsics/EXIF — the lifeblood of SfM — are stripped at every decode. Plumb `preserveMetadata?/preserveIcc?: boolean` through `DecodeOptions` into both `DecoderInit` sites; expose on `DecodedLevel`.
- **L14-2 [feat] Strided output for atlases/GPU.** Stitch kernels assume `dstStride = viewport.w * bpp`. Optional `rowStrideBytes` (≥ that) on the outBuffer contract → decode straight into power-of-two texture atlases / 256-byte-aligned WebGPU rows without a repack pass. Touches offset math in `stitch`/`stitchCropped`/`zeroFillRect` only; combines with decode-into-dest (L7-2).
- **L14-3 [feat] Per-tile sharpness score.** Opt-in variance-of-Laplacian (or Tenengrad) over decoded tile pixels, reported in `TileProgress` → blur-aware tile selection for MVS patches, keypoint-reliability masks, automatic best-focus frame pick for twin texturing. Costs one extra pass over tile pixels; strictly opt-in.
- **L14-4 [test] Determinism contract.** Multi-view matching assumes identical bytes ⇒ identical pixels across sessions/devices. libjxl is deterministic; pin it: checksum test on a fixture through both whole and tiled paths, documented as a guarantee.
- **L14-5 [feat] `failedTiles` → occlusion/confidence mask.** Tiny helper mapping `failedTiles` + viewport geometry to a binary mask → reconstruction pipelines weight those regions out instead of ingesting zero-filled black as "texture".

## Lens 15 — Butteraugli cost (what these layers can do)

Butteraugli itself runs at encode/QA time, not in these files — so the win here is *avoiding* and *shrinking* its invocations.

- **L15-1 [feat] Manifest-borne scores.** Compute per-tile butteraugli once at ingest (offline, amortized) → manifest. Client layers never re-verify; quality-ladder decisions ("which tiles deserve `final`?", L10-R2/L12-1) read scores instead of running the metric. Same pattern as ratified `convergedByteEnd`.
- **L15-2 [perf] DC prefilter for QA loops.** Butteraugli on DC-stage pixels (same dimensions, 1/8 detail) as the cheap screen; only tiles scoring near threshold get the full-res check. Order-of-magnitude fewer full-res comparisons; `'dc-only'` mode (L12-1) is the enabler.
- **L15-3 [perf] Incremental QA via tile identity.** Re-verify only retried/re-encoded tiles (stable `tileKey` diffing) instead of whole-level metric runs. `TileId` makes per-tile QA bookkeeping trivial.
- **L15-4 [eff] If client-side butteraugli ever lands:** feed it the single stitched viewport buffer (reuse `outBuffer`), never per-tile JS↔WASM hops — the call shape, not the kernel, dominates at tile granularity.

## Lens 16 — AR / immersive (prompt truncated; assuming in-field AR overlay of specimens/organisms)

- **L16-1 [feat] Foveated decode.** Generalize center-out to a gaze point: `priorityCenter?: {x, y}` (or just the L12-3 ordering hook with `centerOut(gazeX, gazeY, tileSize)`) — eye-tracked HMDs paint the fovea first, periphery can even stay DC (foveated *quality*, not just order: combine with L10-R2 demotion).
- **L16-2 [feat] Pose-predictive overscan.** Head motion predicts the next viewport; caller decodes an expanded region in the motion direction. Engine needs nothing new — tile-grain cache (L10-R1) makes overscan cheap because off-screen tiles are reusable, not wasted.
- **L16-3 [perf] Never-miss-vsync budget.** Per-frame `budgetMs` + EMA stop (L6-4) + DC demotion (L10-R2) = AR's hard frame deadline. Thermal throttle ⇒ caller shrinks budget; engine already honors it. `decodeMs` telemetry (L8-2) closes the control loop.
- **L16-4 [feat] GPU upload path.** `rowStrideBytes` (L14-2) with 256-byte alignment ⇒ `device.queue.writeTexture`/`texSubImage2D` straight from `outBuffer`, no repack. Stereo: cache keys are region+format (eye-agnostic) so both eyes share decoded tiles already — state it in docs.
- **L16-5 [feat] Persistent spatial anchors.** `tileKey` at a true level (L1-2) = stable anchor id for AR annotations pinned to specimen regions across sessions (same contract as L12-4).

## Lens 17 — Unified perceptual color engine (log-flattened geodesic space, LUT in Rust/WASM)

What the decode trio must provide so the LookRenderer engine (pipeline.rs) can do its job:

- **L17-1 [feat][HIGH] ICC pass-through.** The sensor-sharpening matrix B and log-transform need the *source* color space; `preserveIcc: false` is hardcoded at both decoder sites (same fix as L14-1). Expose `iccProfile?: Uint8Array` on `DecodedLevel` when requested — without it, Perceptual Constancy Mode runs on wrong-primaries input.
- **L17-2 [feat][HIGH] Pre-stitch transform hook.** Runs the WASM LUT (`apply_tone_math`) per tile while the tile is L1/L2-cache-hot, instead of a second full-viewport read+write pass after assembly. Caller-supplied, so layer purity holds; the DC pass gets the look too — no "flash of un-graded pixels".

  ```ts
  // DecodeOptions (decode-core.ts) — contract: synchronous, in-place, byteLength-preserving.
  onTileTransform?: (pixels: Uint8Array, region: ImageRegion, format: PixelFormat) => void;

  // call site (decodeTiledViewport, both stages — DC gets the look too):
  const { px } = await decodeTileBytesProgressive(tileBytesList[i], plan.format, stage);
  options?.onTileTransform?.(px, t, plan.format); // mutate in place; throws propagate as tile errors
  stitchTileIntoViewport(target, vp, t, px, source, plan.bpp);
  // interaction with tile cache: see L10-R1 caveat (cache raw pixels, not transformed).
  ```

- **L17-3 [feat] Alignment for SIMD LUTs.** 16-bit path only enforces even `byteOffset` (decode-level.ts:124). LUT kernels want 16-byte (WASM SIMD) alignment. Optional `requireAlignment?: 4|8|16` on `DecodeOptions` → fail loud (`INVALID_BUFFER_ALIGNMENT`) instead of silently hitting the scalar path.
- **L17-4 [feat] Format headroom.** `PixelFormat = 'rgba8' | 'rgba16'` is closed; the log/exp/spline pipeline will want float intermediates. Reserve `'rgba16f' | 'rgba32f'` in the union + `bppOfFormat` mapping now (cheap, type-level), implement decoders later — avoids a breaking churn through every signature when the engine ships.
- **L17-5 [dx] Document the color state of decoded pixels.** Is `rgba16` linear or sRGB-encoded? XYB already resolved by the facade? The metric-tensor grid calibration depends on knowing the exact transfer function per format. One authoritative comment in decode-core + a facade-contract test.

---

## Priority rollup

| Rank | Item | Why |
|---|---|---|
| 1 | L3-1 budget-truncation cache poisoning | Correctness: serves broken pixels forever after |
| 2 | L10-R3 stale pixels in recycled outBuffer | Correctness: plausible-but-wrong imagery |
| 3 | L9-1 whole-path zero-copy cache hit | Correctness: cache poisoning via caller mutation |
| 4 | L1-1 `hasAlpha: true` guess | Correctness: wrong bitstream offsets, alpha-less containers |
| 5 | L6-1 double decode per tile in progressive | Perf: 1.3–2× tile decode cost |
| 6 | L10-R1 tile-grain cache | Perf/UX: pans hit cache instead of 100% miss |
| 7 | L4-1/L4-2 decodeWhole guards (in-flight, abort) | Correctness parity with tiled path |
| 8 | L14-1/L17-1 metadata+ICC plumb-through | Unblocks photogrammetry + color engine |
| 9 | L12-3 ordering hook (center-out/saliency/fovea) | One hook serves three roadmap visions |
| 10 | L8-2 `decodeMs` in TileProgress | Prereq for every adaptive behavior above |

---

## Lens 18 — Strategic wins & unlock tricks

Three structural wins that each collapse many findings into one change:

- **L18-1 [feat][STRATEGIC] LevelSource as the contract object, not a dumb record.** Six findings (L1-1 header, L1-2 level index, L11-2 world transform, L11-3 per-tile convergedByteEnd, L12-3 saliency priorities, L15-1 butteraugli scores) are all the same move: ingest-time knowledge must ride the `LevelSource` into decode-time. Enrich it once in `createLevelSource` (header + level + optional manifest sidecar data); everything downstream stops guessing and re-deriving. One type change, six findings unlocked.
- **L18-2 [feat][STRATEGIC] Quality is a lattice, not a line.** `(TileId × quality)` is the natural unit of work: cacheable (`viewportCacheKey` already has `q:`), skippable (`skipTiles`), reportable (`TileProgress.stage`). L10-R1 tile cache, L3-5 DC caching, L12-1 dc-only, L10-R2 demotion are projections of one concept. Name it (`WorkUnit`), and scheduling/caching/resume all speak the same currency.
- **L18-3 [feat][STRATEGIC] Promote the plan from geometry to program.** `prepareDecodePlan` returns geometry; the orchestrator then hand-codes Phase 1/Phase 2 as duplicated 70-line loops. Make the plan an ordered list of `WorkUnit`s; `decodeTiledViewport` collapses to a single executor loop. Ordering, retry, demotion, resume, dc-only become *plan transformations* — data, not control flow.

  ```ts
  type Quality = 'dc' | 'final';
  interface WorkUnit { i: number; tile: ImageRegion; id: TileId; key: string; q: Quality }

  function buildUnits(plan: DecodePlan, mode: 'dc-only' | 'dc-then-final' | 'final',
                      order?: (a: TileId, b: TileId) => number): WorkUnit[] {
    const mk = (q: Quality): WorkUnit[] =>
      plan.tiles.map((t, i) => ({ i, tile: t, id: plan.ids[i], key: plan.keys[i], q }));
    const dc = mk('dc'), fin = mk('final');
    if (order) { dc.sort((a, b) => order(a.id, b.id)); fin.sort((a, b) => order(a.id, b.id)); }
    return mode === 'dc-then-final' ? [...dc, ...fin] : mode === 'dc-only' ? dc : fin;
  }

  // one loop replaces Phase 1 + Phase 2 (queue.shift is O(n); n ≤ 4096 per L19a-1):
  const queue = buildUnits(plan, mode, options?.tileOrder);
  let demoted = false;
  while (queue.length > 0) {
    const u = queue.shift()!;
    if (signal?.aborted) throw new PyramidError('ABORTED', 'decode aborted');
    if (deadline != null && demoted && performance.now() > deadline) break; // hard stop after demotion
    if (deadline != null && !demoted && performance.now() + emaMs > deadline) {
      if (errorPolicy !== 'skip-tile') throw new PyramidError('TIMEOUT', 'budgetMs exceeded');
      for (let k = queue.length - 1; k >= 0; k--) {
        if (queue[k]!.q === 'final') queue.splice(k, 1); // demotion (L10-R2): keep dc, drop final
      }
      demoted = true; // → truncated reporting per L3-1
    }
    if (skipTiles?.has(u.key) || (u.q === 'final' && finalDone[u.i])) { tick(u); continue; }
    try {
      await decodeUnit(u); // decode + onTileTransform + stitch + finalDone bookkeeping (L6-1/L17-2)
      tick(u);
    } catch (e) {
      if (errorPolicy !== 'skip-tile') throw e;
      zeroFillRect(target, vp, u.tile, plan.bpp);
      fail(u);
    }
  }
  ```

Memory/code tricks:

- **L18-4 [eff] WeakMap memoization keyed on LevelSource.** Pans re-extract the same tile bitstreams every call. `WeakMap<LevelSource, Map<packedTileKey, Uint8Array>>` caches extraction (and later, pinned WASM bytesId per L7-1). GC reclaims with the source; no lifecycle code. Same trick `getLevelId` already uses — generalize it.
- **L18-5 [eff] Verify extraction returns views, not copies.** If `extractTileBitstream` copies, tiled decode pays a full bitstream copy per tile per pan; subarray views into `source.bytes` are free. One assertion in a test pins the contract.
- **L18-6 [eff] Phases as data.** Implemented by `buildUnits` above — the two-phase structure becomes one array order; duplicated loop bodies and the dedup post-pass fall out.
- **L18-7 [perf][explore] Native-resolution DC transport.** DC is 1/8-detail but ships as a full-size buffer — 64× more bytes across the WASM→JS boundary than information content. If the facade could emit DC at native 1/8 resolution and the viewer upscales on GPU (canvas/texture scale), the boundary copy shrinks 64×. Facade-level change; measure before committing (contract today: full-size pixels, relied on by stitch).

## Lens 19 — Missed perspectives (three complementary lenses, implemented)

The 17 lenses assumed: good-faith inputs, resource abundance, and the present tense. Three complements: the adversary (malice), the field (scarcity), deep time (years).

### 19a — Adversary lens

- **L19a-1 [bug] Tile-count DoS.** Caps guard buffer *bytes* (L5-1) but not tile *count*: crafted header with `tileSize: 1` on a large image → `plan.tiles` with millions of entries + a `tileBytesList` to match, before any byte cap trips. Cap viewport tile count (e.g., ≤ 4096) and floor `tileSize` (≥ 64) at `createLevelSource`/plan time.
- **L19a-2 [bug] Tile-table integrity.** Untrusted JXTC offsets: JS `subarray` clamps silently, so out-of-range offsets yield truncated bitstreams (decoder error — handled), but *overlapping/aliased* offsets decode the wrong pixels into the right rect — integrity failure, not a crash; annotations and measurements land on wrong imagery. Validate the tile table once at parse: monotonic, in-range, non-overlapping.
- **L19a-3 [bug] Decompression bomb on the whole path.** `!haveNominal` accepts any self-reported `info.width/height` — a tiny crafted JXL can demand a multi-GB pixel buffer. Mirror the 1 GiB cap against self-reported dims before accepting the final event's pixels.

### 19b — Field lens (battery, low-end devices, offline)

- **L19b-1 [feat] Power-aware quality policy.** Battery = bytes decoded. `navigator.connection.saveData` / `getBattery()` → caller maps to `'dc-only'` (L12-1) + demotion (L10-R2) + per-tile convergedByteEnd (L11-3). Engine needs nothing beyond already-proposed items; ship the mapping table in docs so field mode is a config, not a fork.
- **L19b-2 [feat] Configurable memory ceiling.** The 1 GiB cap is a desktop constant; field Androids want 64–128 MB. `maxViewportBytes?: number` on `DecodeOptions` (default = current cap), enforced where `need` is computed. One knob, low-end devices stop OOM-killing the tab.
- **L19b-3 [dx] Offline contract.** Cache interface here is sync (`get/set`); OPFS (jxl-cache) is async. Right answer for the hot path: keep sync, document the preload pattern (hydrate memory cache from OPFS before decode loop) — herbarium-in-pocket without an async hole in the per-tile loop.
- **L19b-4 [eff] Race-to-idle note.** Sequential progressive decode is often *better* for battery than parallel burst (sustained vs peak power) — when the pool lands, make parallelism opt-in per power state rather than default-max.

### 19c — Deep-time lens (versioning, migration, provenance)

- **L19c-1 [bug] Cache entries are unversioned.** Any future change to pixel semantics (e.g., fixing rgba16 linearization per L17-5) silently serves stale-semantics pixels from OPFS/LRU across deploys.

  ```ts
  // decode-core.ts
  export const CACHE_SCHEMA_VERSION = 1; // bump on ANY change to decoded-pixel semantics

  export function wholeCacheKey(levelId: string, w: number, h: number, format: PixelFormat): string {
    return `${levelId}:${w}x${h}:${format}:whole:v${CACHE_SCHEMA_VERSION}`;
  }
  // viewportCacheKey and tileCacheKey (L10-R1) gain the same `:v${CACHE_SCHEMA_VERSION}` suffix.
  ```

- **L19c-2 [feat] Container version on LevelSource.** `parseJxtcHeader` knows the container; `LevelSource` doesn't carry a version → JXTC v2 can't branch downstream. Carry `containerVersion`; rides along with L18-1.
- **L19c-3 [feat] Provenance for the scientific record.** Specimens feed measurements; measurements need traceable pixels. Opt-in `provenance?: { levelId, level, decoderVersion, schemaVersion }` on `DecodedLevel` — which bytes, which level, which decoder produced these pixels. Cheap strings; turns decoded output into citable evidence.

## Lens 20 — The relaxed, unfocused eye

Soft-focus patterns across the whole session:

- **L20-1 The whole path is systematically second-class.** Eight separate findings are "whole lacks what tiled has" (in-flight guard, abort racing, copy policy, subarray, progressive, caps). Don't patch eight holes: model whole as the degenerate tiled case (one tile = whole image) through the L18-3 executor. Parity by construction, one code path to test.
- **L20-2 An options bag is becoming a policy object.** The session kept adding fields (ordering, alignment, budget, metadata, ceiling...). Before `DecodeOptions` hits 25 fields: a compiled `DecodePolicy` (validated once, reused across pans) is the shape wanting to be born — viewers re-validate identical options on every pan today.
- **L20-3 Cache handling is creeping into the orchestrator.** ~9 findings touch cache concerns inside decode-level (keys, capacity, copy policy, validation, versioning). Extract a `CacheGateway` in decode-core owning key+validate+copy+capacity+version; L7-3, L9-1, L9-2, L19c-1 become one implementation instead of four patches.
- **L20-4 Structure before options.** Most proposals are additive options — sprawl risk. The three L18 structural wins absorb most behavior variation as plan/policy transforms. Sequence: structure first (L18-1/2/3, L20-1/3), then the option-level findings mostly *fall out* or shrink.
- **L20-5 Nothing was measured.** Every perf claim in this document is static reasoning. House rule: benchmark before tuning. First implementation step should be the bench harness + `decodeMs` telemetry (L8-2), then L6-1/L7-1/L10-R1 in evidence order.

---

## Session summary — what implementing all of this achieves

First, the decode trio becomes *trustworthy*. Today a budget-truncated or resumed decode can cache half-painted viewports as final, hand back another pan's stale pixels, or let a caller's paint operation silently poison the shared cache — and a hostile or merely malformed JXTC container can decode wrong pixels into right places or exhaust memory. The correctness tier (poisoning gates, pre-zeroed canvases, whole/tiled parity via one executor path, tile-table validation, caps, cache versioning) turns the layer into something a biodiversity platform can cite: every pixel either honestly decoded, honestly coarse, or honestly absent — with provenance to say which.

Second, it gets *fast where users feel it*. Skipping the redundant second full decode when a tile already reached final, tile-grain caching so a pan reuses everything it overlaps, pinned bytes and decode-into-dest to stop re-copying megabytes across the WASM boundary, center-out ordering, DC demotion under budget, and DC-quality caching together change the feel of the viewer: first meaningful paint in tens of milliseconds, pans that hit cache instead of re-decoding the world, frame budgets that degrade to "uniformly soft" instead of "torn". The telemetry hook makes every one of these claims measurable before it's tuned.

Third — and strategically largest — the same small set of primitives becomes the platform for every stated vision. An enriched LevelSource carries ingest-time knowledge (real header, level index, world coordinates, per-tile convergence/saliency/quality scores); the (tile × quality) work-unit lattice plus one ordering hook then serves machine recognition (DC-prefilter species triage, saliency-first decode), photogrammetry (metadata/ICC survival, strided GPU output, sharpness masks, determinism), AR field use (foveation, frame budgets, anchors), the perceptual color engine (ICC pass-through, pre-stitch transform while tiles are cache-hot, SIMD alignment), and field ecology itself (power-aware quality, memory ceilings, offline preload). One decode layer, many instruments looking through it — the architecture stops being a viewer component and becomes the optical bench the whole observatory mounts on.
