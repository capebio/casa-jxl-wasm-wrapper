# FableSuggestions.md — Lens Review of the Pyramid Decode Trio

**Scope (exactly 3 files):**
- `packages/jxl-pyramid/src/decode-level.ts` — progressive pass coordination, viewport chunking, stitching
- `packages/jxl-pyramid/src/level-source.ts` — level source ingestion, manifest → source handle
- `packages/jxl-pyramid/src/decode-core.ts` — core types, clamps, stitch kernel, TileId, errors, options

Fixes are written so an implementing agent can act without further context. Where a fix would ideally touch a file outside the trio, the suggestion includes an in-scope variant. Tags: **[BUG-CRIT]** correctness failure on real inputs, **[BUG]** latent defect, **[PERF]** speed/memory, **[FEAT]** capability, **[DX]** type-safety/maintainability.

## Executive Summary — fix these first

| ID | Severity | One-liner |
|----|----------|-----------|
| L7-1 | BUG-CRIT | Progressive path passes a header **without `tilesX`/`tilesY`** to `extractTileBitstream` → NaN index math → every real progressive decode fails or extracts garbage |
| L6-1 | BUG-CRIT | Progressive path stitches **full-tile pixel buffers under clipped-rect dimensions** → image corruption / RangeError for any viewport not aligned to the tile grid |
| L4-1 | BUG | Aborted direct decode leaves orphaned promise → **unhandled rejection**; abort listener leaks on long-lived signals |
| L4-2 | BUG | `push()` failure orphans the drain promise in both decode helpers → unhandled rejection |
| L10-R1 | BUG | Cache hit without `outBuffer` returns the cache's **internal mutable buffer** — caller writes poison future hits |
| L2-1 | BUG/DX | `PyramidError` re-exported **type-only** from decode-level → consumer `instanceof` breaks |
| L3-1 | PERF/UX | dc-then-final runs **per-tile DC+final interleaved** — full coarse paint arrives near the end; reorder to all-DC-first |
| L3-2 | PERF | Each tile decoded **twice from scratch**; one decoder session emitting DC progress + final halves decode cost |
| L3-3 | PERF | Direct path without `outBuffer` allocates 2× viewport and does a redundant full memcpy |
| L21-1 | BUG | Fractional region coords (ubiquitous in zoom math) reach byte offsets → RangeError on alloc or silent truncated-offset misalignment |
| L19-1 | BUG | Oversized `outBuffer` leaks into result `.pixels` length and into the cache → a later exact-sized hit throws RangeError |
| L18-1 | BUG | Whole-branch manifest dims/bits never validated → NaN/oversized allocations surface far downstream |
| S-1 | PERF | Viewport-keyed cache is useless under panning; per-**tile** cache (F7 endgame) turns pan overlap into memcpy hits |

F2 (outBuffer hardening) = L5-2, L6-2, L7-4, L10-R4, L19-1, L21-1, L22-1. F6 (format token) = L1-2, L5-1. F7 (TileId unification) = L5-3, L8-4, L4-4, S-1.

---

## Lens 1 — Strategic View: how the three files link and what they pass

**Data flow today:**

```
manifest.PyramidLevel + bytes
   └─ level-source.createLevelSource → LevelSource{kind, bytes, w, h, tileSize?, bitsPerSample, format}
        └─ decode-level.decodeLevel
             ├─ kind=whole → decodeWhole(bytes, bitsPerSample)            [re-derives format from bits]
             └─ kind=tiled → decodeTiledViewport
                  └─ plan.prepareDecodePlan(source, region)               [re-parses header, re-derives format/bpp]
                       → DecodePlan{viewport, tiles: ImageRegion[], header, bits, bpp, format, decodeRegion}
                  ├─ progressive: tiling.extractTileBitstream + createDecoder per tile ×2 → decode-core.stitch → target
                  └─ direct: decodeRegion(bytes, viewport) → target.set
                  → DecodedLevel{pixels, width, height}                   [format token dropped at exit]
decode-core: types (DecodedLevel, RegionDecoder, DecodeOptions, TileId/tileKey, PyramidError), stitch, clamps
```

### L1-1 [DX/PERF] Dual source of truth: LevelSource fields vs re-parsed header
**Issue:** `createLevelSource` already parses the JXTC header and stores `width/height/tileSize/bitsPerSample/format` on the `LevelSource`. The plan layer then re-parses the header from bytes and re-derives `bits/bpp/format`. Two authorities for the same facts; divergence (e.g. a caller hand-builds a `LevelSource` with wrong `tileSize`) is silently possible, and the header parse work is duplicated per source.
**Fix (in-scope variant):** Treat `LevelSource` as the single post-ingest authority. In `decode-level.decodeTiledViewport`, stop trusting `plan.header` for grid math and derive grid facts from `source` directly (this also fixes L7-1):

```ts
const tilesX = Math.ceil(source.width / source.tileSize);
const tilesY = Math.ceil(source.height / source.tileSize);
```

Add a one-time integrity assertion in `createLevelSource` (tiled branch) that manifest entry and header agree when the entry provides dims:

```ts
if ((entry.w && entry.w !== header.imageW) || (entry.h && entry.h !== header.imageH)) {
  throw new PyramidError('JXTC_PARSE',
    `manifest dims ${entry.w}x${entry.h} != container ${header.imageW}x${header.imageH}`);
}
```

(Requires importing `PyramidError` from `./decode-core.js` into level-source.ts — see L8-3.)

### L1-2 [DX/PERF] F6 core: format token derived in four places
**Issue:** `bits === 16 ? 'rgba16' : 'rgba8'` (and the inverse bpp lookup) appears in `createLevelSource` (twice), `decodeWhole`, and the plan layer. `decodeWhole(bytes, bits)` re-derives a token the `LevelSource` already carries.
**Fix:** Centralize in decode-core.ts and consume the carried token everywhere:

```ts
// decode-core.ts
export type PixelFormat = 'rgba8' | 'rgba16';
export const formatFromBits = (bits: 8 | 16): PixelFormat => bits === 16 ? 'rgba16' : 'rgba8';
export const bppOfFormat = (f: PixelFormat): 4 | 8 => f === 'rgba16' ? 8 : 4;
```

- level-source.ts: `const fmt = formatFromBits(header.bitsPerSample);` / `formatFromBits(bits)`.
- decode-level.ts: change `decodeWhole(bytes: Uint8Array, bits: 8 | 16)` to `decodeWhole(bytes: Uint8Array, format: PixelFormat)` and call as `decodeWhole(source.bytes, source.format)`; delete the `bits` hoist in `decodeLevel`.
- Use the `PixelFormat` alias in `LevelSource`, `decodeTileBytesProgressive`, and `DecodeOptions`-adjacent types instead of repeating the literal union.

### L1-3 [BUG-adjacent/DX] Cache-key fragmentation
**Issue:** The viewport cache key template `` `${getLevelId(source)}-${vp.x}-${vp.y}-${vp.w}-${vp.h}-${plan.format}-preview` `` is hand-built **three times** inside `decodeTiledViewport` (cache-read, progressive cache-write, direct cache-write). Any drift between the copies silently splits the cache. Meanwhile decode-core's `tileKey`/`makeTileCacheKey` (F7) are unused by the decode path. The `-preview` suffix is a stale name that does not describe quality (see L9-2).
**Fix:** Add one builder to decode-core.ts and call it at all three sites (compute once into a local at function top):

```ts
// decode-core.ts
export function viewportCacheKey(
  levelId: string, vp: ImageRegion, format: PixelFormat, quality: 'dc' | 'final',
): string {
  return `${levelId}:${vp.x},${vp.y},${vp.w},${vp.h}:${format}:q${quality}`;
}
```

```ts
// decode-level.ts (top of decodeTiledViewport, after plan)
const cacheKey = cache ? viewportCacheKey(getLevelId(source), vp, plan.format, 'final') : undefined;
```

In-memory cache only — no persisted-key migration needed.

---

## Lens 2 — Public API Surface

### L2-1 [BUG/DX] `PyramidError` exported type-only
**Issue:** decode-level.ts line 16: `export type { ..., PyramidError, ... }`. `PyramidError` is a **class**; `export type` strips the runtime binding. A consumer doing `import { PyramidError } from '.../decode-level.js'` gets a type-only import — `err instanceof PyramidError` either fails to compile or (with `isolatedModules`-style transpilers) breaks at runtime.
**Fix:**

```ts
export type { DecodedLevel, RegionDecoder, DecodeOptions, ProgressiveMode } from "./decode-core.js";
export { PyramidError } from "./decode-core.js";
```

### L2-2 [DX] `any`-typed options: `pool`, `workerFactory`, decoder opts casts
**Issue:** `DecodeOptions.pool?: any`, `workerFactory?: () => any`, plus `createDecoder({...} as any)` at three call sites (decodeWhole, decodeTileBytesProgressive, WHOLE_DECODE_OPTS spread). The casts hide real option-name typos from the compiler (e.g. a renamed `progressionTarget` would fail only at runtime).
**Fix:** In decode-core.ts declare minimal structural types and use them:

```ts
export interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error', fn: (ev: any) => void): void;
  terminate(): void;
}
export interface DecoderInit {
  format: PixelFormat;
  progressionTarget: 'dc' | 'final';
  emitEveryPass: boolean;
  preserveIcc: boolean;
  preserveMetadata: boolean;
}
```

Type `workerFactory?: () => WorkerLike`, `pool?: unknown` (until the pool type can be imported without a cycle), and build decoder opts as `const init: DecoderInit = {...}` so excess/missing keys are compiler-checked. If `createDecoder`'s parameter type is narrower than reality, cast **once** at the boundary (`createDecoder(init as Parameters<typeof createDecoder>[0])`) rather than `as any` at every site.

### L2-3 [DX] `DecodeOptions.progressive` bypasses the exported `ProgressiveMode`
**Issue:** decode-core.ts declares `export type ProgressiveMode = 'dc-then-final' | undefined;` but `DecodeOptions.progressive` inlines `'dc-then-final'`. Adding a mode (e.g. `'dc-only'`, L3-4) requires editing two places that can drift.
**Fix:** `progressive?: Exclude<ProgressiveMode, undefined>;` and extend `ProgressiveMode` as the single registry of modes.

### L2-4 [FEAT] Whole-frame path ignores `options` entirely
**Issue:** `decodeLevel(source /* whole */)` accepts `options` but `decodeWhole` receives none: no abort between push/close, no cache, no outBuffer. Tiled and whole paths have asymmetric contracts for the same public entrypoint.
**Fix:** Thread options through:

```ts
async function decodeWhole(
  bytes: Uint8Array, format: PixelFormat, source: { width: number; height: number },
  options?: DecodeOptions,
): Promise<DecodedLevel> {
  const bpp = bppOfFormat(format);
  const need = source.width * source.height * bpp;
  const cacheKey = options?.cache ? `${getLevelId(bytes)}:whole:${format}:qfinal` : undefined;
  if (cacheKey) {
    const hit = options!.cache!.get(cacheKey);
    if (hit) return materialize(hit, source.width, source.height, options); // copy/outBuffer per L10-R1
  }
  // ...existing decode...
  if (options?.signal?.aborted) throw new PyramidError('ABORTED', 'decode aborted');
  // validate res.width/height === source dims (L10-R4), copy into outBuffer if provided (need check per F2),
  // cache.set(cacheKey, copy) if cache.
}
```

Validation that decoded dims equal manifest dims doubles as an integrity check (mislabelled level files surface immediately as `PyramidError('DIM_MISMATCH')` instead of downstream stitch corruption).

---

## Lens 3 — Pipeline Stages (decode → transform → cache → return)

### L3-1 [PERF/UX — high value] dc-then-final interleaves per tile; coarse paint lands last
**Issue:** decode-level.ts lines 67–91: per tile the loop does DC decode → stitch → final decode → stitch, then moves to the next tile. For N tiles the **last tile's DC** arrives at ≈ (2N−1)/2N of total time — the user never sees a complete coarse viewport early, which is the entire point of dc-then-final.
**Fix:** Two phases — all DC first, then all final. `onTile` semantics unchanged (fires per stitch with running `completed`); total steps still `2 × tiles.length`:

```ts
if (progressive === 'dc-then-final' && !options?.decodeRegion) {
  let completed = 0;
  const tileBytesList = plan.tiles.map((t) => extractTileBitstream(source.bytes, t, exHeader)); // exHeader: L7-1
  for (let i = 0; i < plan.tiles.length; i++) {           // Phase 1: coarse full-viewport paint
    if (signal?.aborted) throw new PyramidError('ABORTED', 'decode aborted');
    const px = await decodeTileBytesProgressive(tileBytesList[i], plan.format, 'dc');
    stitchTileIntoViewport(target, vp, plan.tiles[i], px, source, plan.bpp); // L6-1 helper
    onTile?.(plan.tiles[i], ++completed);
  }
  for (let i = 0; i < plan.tiles.length; i++) {           // Phase 2: refine
    if (signal?.aborted) throw new PyramidError('ABORTED', 'decode aborted');
    const px = await decodeTileBytesProgressive(tileBytesList[i], plan.format, 'final');
    stitchTileIntoViewport(target, vp, plan.tiles[i], px, source, plan.bpp);
    onTile?.(plan.tiles[i], ++completed);
  }
  // ...cache.set + return as today
}
```

Time-to-complete-coarse-paint drops from ~95% of total to ~ (DC cost / total) ≈ 10–20%.

### L3-2 [PERF — high value] Tile decoded twice from scratch; use one session, two emissions
**Issue:** `decodeTileBytesProgressive` is called twice per tile, each call creating a decoder, pushing the full bitstream, and decoding from byte 0. The final pass re-does all DC work; total cost ≈ 1.3–2× a single full decode, plus 2× decoder create/dispose overhead (see L7-2).
**Fix:** One decoder session per tile with `progressionTarget: 'final', emitEveryPass: true`; deliver the first progress emission as the DC paint and the final event as the refine. The event handling already present in `decodeTileBytesProgressive` (it accepts `progress`/`preview` events) shows the facade emits these.

```ts
/** One session: resolves DC-ish first paint via onCoarse, returns final pixels. */
async function decodeTileTwoEmit(
  tileBytes: Uint8Array, format: PixelFormat,
  onCoarse: (px: Uint8Array) => void,
): Promise<Uint8Array> {
  const decoder = createDecoder({
    format, progressionTarget: 'final', emitEveryPass: true,
    preserveIcc: false, preserveMetadata: false,
  } satisfies DecoderInit);
  const drain = (async () => {
    let coarseSent = false;
    for await (const ev of decoder.events()) {
      if ((ev.type === 'progress' || (ev as any).type === 'preview') && (ev as any).pixels && !coarseSent) {
        coarseSent = true;
        const p = (ev as any).pixels;
        onCoarse(p instanceof Uint8Array ? p : new Uint8Array(p));
      } else if (ev.type === 'final') {
        return ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
      } else if (ev.type === 'error') {
        throw new PyramidError('INTERNAL', `tile decode ${ (ev as any).code }: ${ev.message}`);
      }
    }
    throw new PyramidError('INTERNAL', 'tile decode produced no final frame');
  })();
  const drainSafe = drain.catch((e) => { throw e; });           // see L4-2 for the orphan-safe pattern
  try {
    await decoder.push(tileBytes);
    await decoder.close();
    return await drainSafe;
  } catch (e) {
    drain.catch(() => {});                                       // defuse orphan
    throw e;
  } finally {
    await Promise.resolve(decoder.dispose()).catch(() => {});
  }
}
```

Note: combine with L3-1 by restructuring as phase-1 = first emission of each tile's session — but holding N open decoder sessions may exceed WASM memory. Pragmatic order: implement L3-1 (pure reorder) first; apply L3-2 only if sessions can be bounded (e.g. 2–4 concurrent). If both are wanted simultaneously with bounded memory, run a window of K sessions: tile i's coarse emission stitched immediately, final awaited before window slides. Verify the facade emits a progress event early enough (before full AC decode) for this to beat two passes — benchmark before adopting (CLAUDE.md: heuristic changes need data).

### L3-3 [PERF] Direct path: redundant allocation + memcpy when caller has no outBuffer
**Issue:** Lines 54–60 + 111: with no `outBuffer`, `target = new Uint8Array(need)` is allocated, the decoder **also** allocates `direct.pixels` (same size), then `target.set(direct.pixels)` copies the whole viewport. 2× memory, one wasted full-viewport memcpy, every non-pooled direct decode.
**Fix:** Allocate `target` lazily — only for the progressive path or when `outBuffer` exists. Direct path returns the decoder's buffer after validating it (L10-R4):

```ts
// direct path
const direct = await raceWithAbort(p, signal);                  // L4-1 helper
validateDecodedOutput(direct, vp, plan.bpp);                    // L10-R4
let pixels: Uint8Array;
if (options?.outBuffer) {
  options.outBuffer.set(direct.pixels);                          // size pre-validated at entry
  pixels = options.outBuffer;
} else {
  pixels = direct.pixels;                                        // zero-copy hand-off
}
if (cache && cacheKey) cache.set(cacheKey, new Uint8Array(pixels.subarray(0, need)));
onTile?.(vp, 1);
return { pixels, width: vp.w, height: vp.h };
```

Move the `target` allocation into the progressive branch (the only remaining user).

### L3-4 [FEAT] `'dc-only'` progressive mode — coarse-only decode for previews/screening
**Issue:** No way to ask for just the cheap coarse pass. Use cases: thumbnail-quality pan previews, ML screening (Lens 12), AR periphery (Lens 16), butteraugli pre-screen (Lens 15). DC-only is ~the cost of phase 1 alone.
**Fix:** Extend the mode registry and run only phase 1:

```ts
// decode-core.ts
export type ProgressiveMode = 'dc-then-final' | 'dc-only' | undefined;
```

In `decodeTiledViewport`, the L3-1 structure makes this trivial: run phase 1; if mode is `'dc-only'`, skip phase 2 and cache under quality `'dc'` (`viewportCacheKey(..., 'dc')` — distinct key from final, which is why L1-3 adds the quality segment). Document: dc-only results must never be cached under the final-quality key.

### L3-5 [PERF] Cache write can exceed cache capacity → pure churn
**Issue:** `cache.set(key, new Uint8Array(target))` copies and inserts unconditionally. A 4096×4096 rgba8 viewport is 64 MB; against the default 32 MB in-memory cache this evicts **everything** and then evicts itself — every decode pays a 64 MB copy for zero hit-rate.
**Fix:** Let the cache veto oversized entries. Extend the interface (decode-core consumes it; the interface lives in cache.ts but the in-scope change is the guard at the call sites):

```ts
// decode-level.ts — guard all cache.set sites
const wouldFit = (cache as any).capacityBytes === undefined || need <= (cache as any).capacityBytes;
if (cache && cacheKey && wouldFit) cache.set(cacheKey, new Uint8Array(target));
```

Cleaner follow-up outside scope: add optional `capacityBytes?: number` to `PyramidCache` and have `createInMemoryPyramidCache` set it.

---

## Lens 4 — State Machinery (session, queue, cancellation, error)

### L4-1 [BUG] Direct-path abort: orphaned rejection, leaked listener, pointless inner controller
**Issue:** Lines 97–109. Three defects: (a) if abort wins the race, `p` keeps running and its eventual rejection (the decoder failing after teardown) is **unhandled** — process-level `unhandledRejection` in Node, console noise in browsers; (b) the `'abort'` listener added to the caller's signal is never removed on normal completion — a viewer reusing one master `AbortSignal` across hundreds of pans accumulates dead listeners; (c) the inner `AbortController` adds an allocation and a hop for nothing — the race can listen on the outer signal directly.
**Fix:** Single helper in decode-core.ts, used by direct path (and decodeWhole per L2-4):

```ts
// decode-core.ts
export async function raceWithAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) { p.catch(() => {}); throw new PyramidError('ABORTED', 'decode aborted'); }
  let onAbort: () => void;
  const abortP = new Promise<never>((_, rej) => {
    onAbort = () => rej(new PyramidError('ABORTED', 'decode aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([p, abortP]);
  } catch (e) {
    p.catch(() => {});            // defuse in-flight decode if abort won
    throw e;
  } finally {
    signal.removeEventListener('abort', onAbort!);
  }
}
```

WASM still runs to completion in-flight (documented, unavoidable); this only fixes the JS-side hygiene.

### L4-2 [BUG] Drain-promise orphaned when `push()`/`close()` throws (both helpers)
**Issue:** `decodeWhole` (lines 194–218) and `decodeTileBytesProgressive` (134–161): if `decoder.push(bytes)` throws (malformed bitstream), control never reaches `await drain`, and when the events iterator subsequently errors/ends, the drain promise rejects with **no awaiter** → unhandled rejection. Additionally the `if (drainErr) throw drainErr` after `await drain` is dead code — if drain rejected, the `await` already threw; the mutable `drainErr`/`drainError` flags add no information.
**Fix:** Replace the flag pattern with a swallowed-rejection mirror; await the mirror, drop the flags:

```ts
const drain = (async () => { /* ...event loop, return px or throw... */ })();
const drainOutcome = drain.then(
  (px) => ({ ok: true as const, px }),
  (err) => ({ ok: false as const, err }),
);                                // drainOutcome never rejects → no orphan possible
try {
  await decoder.push(bytes);
  await decoder.close();
  const out = await drainOutcome;
  if (!out.ok) throw out.err;
  return out.px;
} finally {
  await Promise.resolve(decoder.dispose()).catch(() => {});
}
```

If push throws, the `finally` disposes, drain settles into `drainOutcome` harmlessly, push's error propagates. Apply identically in both functions (or extract one shared `runDecoderSession(decoder, bytes, drainBody)` helper in decode-level.ts).

### L4-3 [BUG] Abort window missed between DC and final pass of the same tile
**Issue:** The progressive loop checks `signal?.aborted` once per tile, **before** DC. An abort raised during the DC decode is ignored and the (more expensive) final decode of that tile still runs — worst case a full extra tile decode after cancellation.
**Fix:** With the L3-1 two-phase loop this is already solved (check at the top of each phase iteration). If L3-1 is not adopted, add `if (signal?.aborted) throw new PyramidError('ABORTED', 'decode aborted');` between the DC stitch and the final decode.

### L4-4 [FEAT — F7] Resume-after-abort: skip already-delivered tiles
**Issue:** A pan/zoom viewer aborts mid-viewport constantly. Re-requesting the same viewport re-decodes tiles that were already stitched and painted before the abort. There is no way to express "these tiles are done."
**Fix:** TileId-keyed skip set on options; caller records keys from `onTile` (paired with L8-4's TileId delivery):

```ts
// decode-core.ts — DecodeOptions addition
/** Tiles (by tileKey) already final-stitched into outBuffer from a prior aborted run over the
 *  SAME viewport+outBuffer. Skipped tiles still increment completedCount so totals stay stable. */
skipTiles?: ReadonlySet<string>;
```

```ts
// decode-level.ts — inside each phase loop, before decode
const id = tileIdOf(t, source.tileSize, levelIndex);            // L5-3
if (options?.skipTiles?.has(tileKey(id))) { onTile?.(t, ++completed); continue; }
```

Only valid when the caller reuses the same `outBuffer` (the pixels must still be there) — document that requirement on the option. `levelIndex`: see L5-3 note on where the level number comes from.

### L4-5 [DX] `PyramidError` ignores native `cause` chaining
**Issue:** decode-core.ts lines 111–116: the constructor takes `cause` but doesn't pass it to `super`, so `err.cause` works only via the public field while native error-chain tooling (Node `util.inspect`, devtools "Caused by") misses it.
**Fix:**

```ts
constructor(public code: PyramidErrorCode, message: string, cause?: unknown) {
  super(message, cause !== undefined ? { cause } : undefined);
  this.name = 'PyramidError';
  this.cause = cause; // keep field for older lib targets
}
```

Requires `lib: ["ES2022"]` (or `ES2022.Error`) in tsconfig; if the build targets lower, keep the field-only form and note it.

---

## Lens 5 — Data Structures (buffers, manifests, tile descriptors, options)

### L5-1 [PERF/DX — F6] Carry `bpp` on `LevelSource`; type the format once
**Issue:** `LevelSource` carries `bitsPerSample` and `format` but not `bpp`; every consumer re-derives `bpp` (`bits === 16 ? 8 : 4`). F6 asks for the token to flow monotonically with **no hot-path conversion lookups**.
**Fix:** With L1-2's helpers in place:

```ts
// level-source.ts
export type LevelSource =
  | { kind: "whole"; bytes: Uint8Array; width: number; height: number;
      bitsPerSample: 8 | 16; format: PixelFormat; bpp: 4 | 8; bytesId?: number }
  | { kind: "tiled"; bytes: Uint8Array; width: number; height: number; tileSize: number;
      bitsPerSample: 8 | 16; format: PixelFormat; bpp: 4 | 8; bytesId?: number };
```

Populate in `createLevelSource` via `bppOfFormat(fmt)`. Downstream, `need = vp.w * vp.h * source.bpp` no longer needs the plan for byte math (useful for pre-validating `outBuffer` before planning).

### L5-2 [BUG/F2] `outBuffer` validated for size but not for rgba16 alignment
**Issue:** For `format === 'rgba16'` the natural consumer view is `Uint16Array` over the result. `new Uint16Array(ob.buffer, ob.byteOffset, ...)` **throws** when `byteOffset` is odd. Nothing stops a caller handing a deliberately offset subarray (e.g. a slice out of a pooled arena at an odd offset); the decode then succeeds but the buffer is unusable as 16-bit pixels — failure surfaces far from the cause.
**Fix:** Extend the entry validation in `decodeTiledViewport` (and `decodeWhole` once L2-4 lands):

```ts
if (options?.outBuffer) {
  const ob = options.outBuffer;
  if (ob.byteLength < need) throw new PyramidError('INVALID_BUFFER_SIZE',
    `outBuffer too small (${ob.byteLength} < ${need})`);
  if (plan.bpp === 8 && (ob.byteOffset & 1) !== 0) throw new PyramidError('INVALID_BUFFER_ALIGNMENT',
    `rgba16 outBuffer must be 2-byte aligned (byteOffset ${ob.byteOffset})`);
}
```

(For SIMD-friendly consumers, recommend — in the option's doc comment — allocating outBuffers at offset 0 of a fresh ArrayBuffer, which is ≥8-byte aligned; do not hard-require 16-byte alignment.)

### L5-3 [DX/F7] TileId exists but nothing produces one; tiles travel as bare rects
**Issue:** decode-core defines `TileId`/`tileKey`, cache.ts defines `makeTileCacheKey` — and the decode path never constructs a `TileId`. Tiles flow as clipped `ImageRegion`s; abort tracking, telemetry, and future per-tile caching each would re-invent col/row math.
**Fix:** One canonical constructor in decode-core.ts:

```ts
/** F7: canonical TileId for a (possibly clipped) tile rect — col/row from the grid origin the rect falls in. */
export function tileIdOf(rect: ImageRegion, tileSize: number, level: number): TileId {
  return { level, col: Math.floor(rect.x / tileSize), row: Math.floor(rect.y / tileSize) };
}
```

`level` is not currently known inside `decodeTiledViewport` (a `LevelSource` is level-anonymous). Two options, pick A: (A) add optional `levelIndex?: number` to both `LevelSource` variants, set by whoever materializes the source from the manifest (defaults to 0 when absent); (B) accept `level: number` on `DecodeOptions`. A keeps the fact with the data it describes. Then use `tileIdOf` in L4-4 (skipTiles), L8-4 (onTile/telemetry), and any per-tile cache keys via `makeTileCacheKey`.

### L5-4 [PERF/F7] String tile keys are fine for logs, slow for hot maps — add a packed numeric key
**Issue:** `tileKey` builds `` `L${level}-C${col}-R${row}` `` — three number→string conversions + concat + string hashing on every map probe. For per-tile bookkeeping touched in loops (skip sets, abort registries, telemetry counters) a numeric key is materially cheaper.
**Fix:**

```ts
// decode-core.ts
/** Packed numeric tile key: level < 8192, col/row < 2^20 (covers 2^20 × 512px ≈ 5.4e8 px sides).
 *  Safe-integer arithmetic (no 32-bit overflow): level·2^40 + row·2^20 + col < 2^53. */
export function tileKeyPacked(tile: TileId): number {
  return tile.level * 0x10000000000 + tile.row * 0x100000 + tile.col;
}
```

Keep string `tileKey` for logs/cache-key segments; use `tileKeyPacked` + `Set<number>`/`Map<number, T>` for hot-path registries (L4-4's skip set may accept either; prefer numeric and convert at the boundary).

### L5-5 [FEAT] `DecodedLevel` drops the format token at the exit boundary
**Issue:** `DecodedLevel{pixels, width, height}` — the caller must thread `format`/`bpp` out-of-band to interpret `pixels` (is it 4 or 8 bytes per pixel?). Every downstream consumer (painter, LookRenderer, ML, photogrammetry) re-plumbs this.
**Fix:** Optional, non-breaking:

```ts
export interface DecodedLevel {
  pixels: Uint8Array;
  width: number;
  height: number;
  /** Pixel format of `pixels`. Optional for back-compat; all in-repo producers set it. */
  format?: PixelFormat;
}
```

Set it at all four return sites in decode-level.ts (cache-hit, progressive, direct, whole). `RegionDecoder` implementations may omit it; `decodeTiledViewport` stamps `plan.format` on the result regardless.

### L5-6 [BUG] `prepareLevelSource` early-return can never fire for its own marker
**Issue:** level-source.ts lines 50–55: first call sets `(source as any).bytesId = undefined` (own property, value `undefined`). Second call checks `source.bytesId != null` — `undefined != null` is **false**, so the "idempotent" early-return never triggers for prepared-but-unassigned sources; the function re-stamps every time. Harmless today, but the guard is dead and the marker is invisible to `!= null` checks elsewhere (a pool testing `bytesId != null` cannot distinguish "never prepared" from "prepared, awaiting id" — which the comment says is the point of the marker).
**Fix:** Presence check, and say what the marker means:

```ts
export function prepareLevelSource(source: LevelSource): LevelSource {
  if ('bytesId' in source) return source;   // already prepared (id may still be pending assignment)
  (source as any).bytesId = undefined;      // own-property marker; pool overwrites with its scoped id
  return source;
}
```

### L5-7 [DX] `PyramidErrorCode`'s `| string` erases the union
**Issue:** decode-core.ts line 109: `| string` makes every code assignable, so the named codes provide no checking and no autocomplete — `'ABORTTED'` compiles.
**Fix:** Keep open-endedness without erasure:

```ts
export type PyramidErrorCode =
  | 'ABORTED' | 'POOL_DESTROYED' | 'FACTORY_CONFLICT' | 'TIMEOUT' | 'INVALID_REPLY'
  | 'EMPTY_LEVELS' | 'BAD_REGION' | 'JXTC_PARSE' | 'OOM' | 'INTERNAL'
  | 'INVALID_BUFFER_SIZE' | 'INVALID_BUFFER_ALIGNMENT' | 'STITCH_OOB'
  | 'DECODER_OUTPUT_MISMATCH' | 'DIM_MISMATCH'
  | (string & {});   // open for extensions, but known codes keep autocomplete + typo distance
```

(Adds the codes introduced elsewhere in this document.)

---

## Lens 6 — Hot Kernels (pixel/copy loops, stitching)

### L6-1 [BUG-CRIT] Progressive stitch: full-tile pixels labelled with clipped-rect dimensions
**Issue:** `plan.tiles` are **viewport-clipped intersection rects** (a tile half-outside the viewport yields e.g. a 256×512 rect). `extractTileBitstream` + decode, however, produce the **full tile's** pixels (e.g. 512×512). decode-level.ts lines 73–81 then build `{ pixels: dcPixels, width: t.w, height: t.h }` — claiming clipped dims for a full-tile buffer — and hand it to `stitch`, which computes `srcStride = t.w * bpp` while the buffer's real row stride is `fullTileW * bpp`. Results for any viewport not aligned to the 512 grid: diagonal-smeared corruption (row-stride walk-off), or `RangeError` from the fast path (`outBuffer.set` of an oversized buffer), or silent overwrite of neighbouring viewport rows. Tile-aligned tests pass; real pans fail.
**Fix:** Crop-aware stitch. Add to decode-core.ts (the kernel belongs beside `stitch`):

```ts
/**
 * Stitch a sub-rectangle of a decoded full tile into the viewport buffer.
 * srcRect is in image coordinates and must lie within the decoded tile; the decoded tile's
 * top-left in image coordinates is (srcOriginX, srcOriginY) with row stride decodedW·bpp.
 */
export function stitchCropped(
  outBuffer: Uint8Array, viewport: ImageRegion, srcRect: ImageRegion,
  decodedPixels: Uint8Array, decodedW: number, decodedH: number,
  srcOriginX: number, srcOriginY: number, bytesPerPixel: 4 | 8,
): void {
  const cropX = srcRect.x - srcOriginX, cropY = srcRect.y - srcOriginY;
  if (cropX < 0 || cropY < 0 || cropX + srcRect.w > decodedW || cropY + srcRect.h > decodedH) {
    throw new PyramidError('STITCH_OOB',
      `crop ${srcRect.w}x${srcRect.h}@(${cropX},${cropY}) outside decoded ${decodedW}x${decodedH}`);
  }
  const expected = decodedW * decodedH * bytesPerPixel;
  if (decodedPixels.byteLength !== expected) {
    throw new PyramidError('DECODER_OUTPUT_MISMATCH',
      `decoded tile bytes ${decodedPixels.byteLength} != ${decodedW}x${decodedH}x${bytesPerPixel}`);
  }
  const dx = srcRect.x - viewport.x, dy = srcRect.y - viewport.y;
  if (dx < 0 || dy < 0 || dx + srcRect.w > viewport.w || dy + srcRect.h > viewport.h) {
    throw new PyramidError('STITCH_OOB',
      `dst ${srcRect.w}x${srcRect.h}@(${dx},${dy}) outside viewport ${viewport.w}x${viewport.h}`);
  }
  const srcStride = decodedW * bytesPerPixel;
  const dstStride = viewport.w * bytesPerPixel;
  const rowBytes = srcRect.w * bytesPerPixel;
  let srcOff = (cropY * decodedW + cropX) * bytesPerPixel;
  let dstOff = (dy * viewport.w + dx) * bytesPerPixel;
  if (rowBytes === srcStride && rowBytes === dstStride) {        // full-width, both aligned
    outBuffer.set(decodedPixels.subarray(srcOff, srcOff + rowBytes * srcRect.h), dstOff);
    return;
  }
  for (let row = 0; row < srcRect.h; row++) {
    outBuffer.set(decodedPixels.subarray(srcOff, srcOff + rowBytes), dstOff);
    srcOff += srcStride;
    dstOff += dstStride;
  }
}
```

And in decode-level.ts wrap the per-tile call (used by both phases of L3-1):

```ts
function stitchTileIntoViewport(
  target: Uint8Array, vp: ImageRegion, t: ImageRegion,
  px: Uint8Array, source: Extract<LevelSource, { kind: 'tiled' }>, bpp: 4 | 8,
): void {
  const ts = source.tileSize;
  const originX = Math.floor(t.x / ts) * ts;
  const originY = Math.floor(t.y / ts) * ts;
  const fullW = Math.min(ts, source.width - originX);
  const fullH = Math.min(ts, source.height - originY);
  stitchCropped(target, vp, t, px, fullW, fullH, originX, originY, bpp);
}
```

**DC-scale caveat:** if the facade's `progressionTarget: 'dc'` emission returns 1/8-scale pixels rather than upsampled full-res, `DECODER_OUTPUT_MISMATCH` will fire on the DC phase. That error is the *correct* behaviour of this fix (it converts today's silent corruption into a diagnosable error). If it fires, add a nearest-neighbour 8× expand before stitching:

```ts
function expandDc8x(dc: Uint8Array, dcW: number, dcH: number, fullW: number, fullH: number, bpp: 4 | 8): Uint8Array {
  const out = new Uint8Array(fullW * fullH * bpp);
  for (let y = 0; y < fullH; y++) {
    const sy = Math.min(dcH - 1, y >> 3);
    for (let x = 0; x < fullW; x++) {
      const sx = Math.min(dcW - 1, x >> 3);
      out.copyWithin // — no; per-pixel copy:
      const so = (sy * dcW + sx) * bpp, dо = (y * fullW + x) * bpp;
      for (let b = 0; b < bpp; b++) out[dо + b] = dc[so + b];
    }
  }
  return out;
}
```

(Detect via `px.byteLength === Math.ceil(fullW/8) * Math.ceil(fullH/8) * bpp`.)

### L6-2 [BUG/F2] `stitch` has no bounds/size validation — negative offsets and oversized sources corrupt silently
**Issue:** decode-core.ts lines 67–94. `stitch` trusts `tile` to lie inside `viewport` and `decoded.pixels` to match `decoded.width × decoded.height × bpp`. A tile rect outside the viewport gives negative `dx/dy`: negative `dstOff` sometimes throws (`set` rejects negative offsets) but `dx < 0` with `dy > 0` can still land in-bounds at the wrong position — **silent pixel corruption**. Oversized `decoded.pixels` on the fast path writes past the intended rows.
**Fix (F2 core):** Add the same four checks `stitchCropped` has (dst-in-viewport, exact source byteLength) to `stitch`, throwing `PyramidError('STITCH_OOB' | 'DECODER_OUTPUT_MISMATCH', ...)`. Cost: four integer comparisons per tile vs a multi-KB memcpy — unmeasurable. The fast path additionally needs `decoded.height + dy <= viewport.h` before `set`.

### L6-3 [PERF — micro] Cache-hit copy and row-subarray churn — acceptable, leave alone
**Noted, no action:** `ob.set(cached)` on cache-hit is one unavoidable memcpy (caller asked for their buffer). The per-row `subarray` allocations in `stitch` (≤512 short-lived views per tile) are nursery-collected and dominated by the memcpy; replacing `set(subarray)` with manual loops measures slower in V8. Documented here so it isn't "optimized" later (cf. CLAUDE.md rejected-list ethos).

---

## Lens 7 — Boundary Points (JS↔WASM, module seams, copy inventory)

### L7-1 [BUG-CRIT] `plan.header as any` crosses the seam missing `tilesX`/`tilesY`
**Issue:** decode-level.ts line 71: `extractTileBitstream(source.bytes, t, plan.header as any)`. The plan's header type carries `{imageW, imageH, tileSize, bitsPerSample, version}` — **no `tilesX`/`tilesY`** — while `extractTileBitstream` indexes the container with `header.tilesX/tilesY`. At runtime: `tilesX === undefined` → the `tilesX <= 0` guard passes (`undefined <= 0` is `false`) → `idx = ty * undefined + tx` = `NaN` → `indexOff = NaN` → `DataView.getUint32(NaN)` coerces to offset 0 (ToIndex(NaN) = 0) → reads the **magic word as the tile offset** → "tile data OOB" error or a 1-byte garbage extraction that fails decode with a misleading message. The `as any` is the exact spot the type system was pointing at the bug. Every progressive decode on a real JXTC container is broken; mock-based tests of the one-shot path never execute this line.
**Fix (in-scope, no plan-layer edit needed):** Build a complete header locally from the authoritative `LevelSource` (ties into L1-1):

```ts
// decode-level.ts — progressive branch, before the loop
const exHeader = {
  imageW: source.width,
  imageH: source.height,
  tileSize: source.tileSize,
  tilesX: Math.ceil(source.width / source.tileSize),
  tilesY: Math.ceil(source.height / source.tileSize),
  hasAlpha: false,                      // not consulted by extractTileBitstream
  bitsPerSample: source.bitsPerSample,
} satisfies Parameters<typeof extractTileBitstream>[2];
```

Then `extractTileBitstream(source.bytes, t, exHeader)` — **delete the `as any`**. Follow-up (optional, outside trio): add `tilesX/tilesY` to the plan's header copy so the cast pressure never returns.

### L7-2 [PERF] Decoder create/dispose ×2 per tile — boundary overhead dominates small tiles
**Issue:** Each `createDecoder` call sets up WASM-side decoder state; each `dispose` tears it down. The progressive path pays this **2N times** for N tiles (N times after L3-2). For 512px rgba8 tiles the fixed FFI/session cost is a meaningful fraction of decode time.
**Fix directions, in order of preference:** (1) adopt L3-2 (halves sessions outright); (2) if the facade exposes (or can cheaply expose) a `decoder.reset()` that returns the session to pre-push state without freeing WASM buffers, reuse **one** decoder across the loop — the facade's grow-only realloc buffers (per CLAUDE.md) make this allocation-stable. Do not build a decoder pool inside decode-level (worker/pool lifecycle is the scheduler's layer); a single sequential-reuse instance inside one `decodeTiledViewport` call violates no layer invariant. Gate (2) on the facade actually having/gaining `reset`; otherwise skip.

### L7-3 [PERF/FEAT] Copy inventory across the boundary — and the one elimination that matters
**Inventory per progressive tile today:** ① WASM heap → `ev.pixels` copy-out, ② `stitch` copy into `target`, ③ `cache.set` full-viewport copy, ④ (direct path only) `target.set(direct.pixels)` (removed by L3-3), ⑤ (cache-hit) `ob.set(cached)`.
② is the stitch itself (necessary). ③ is ownership transfer (necessary while cache stores plain arrays). ① is the eliminable one: a facade-level `decodeInto(buffer, byteOffset, rowStrideBytes)` that lets libjxl write rows straight into a caller-provided JS buffer view would fuse ①+② — the decoder writes each tile row directly at its stitched position in `target`. That is the true F2 endgame ("DC and final AC passes write directly in-place... without any intermediate memory copy").
**Action in this trio:** define the option surface now so the facade can land later without API churn:

```ts
// decode-core.ts — RegionDecoder stays; add the into-variant type for future wiring
export type RegionDecoderInto = (
  bytes: Uint8Array, region: ImageRegion,
  out: Uint8Array, dstOffsetBytes: number, dstStrideBytes: number,
) => Promise<{ width: number; height: number }>;
```

Document on `DecodeOptions.outBuffer` that when the facade ships `decodeInto`, the progressive path will write tile rows in place and `onTile` semantics will not change.

### L7-4 [BUG-adjacent/F2] Decoder output crossing back is never validated (direct path)
Covered as L10-R4 (the reversal lens found it); listed here because it is a boundary-trust issue: `decodeRegion` is caller-overridable, so the boundary contract (dims and byte count match the plan) must be enforced at the seam, not assumed.

---

## Lens 8 — Support Code (validation, logging, progress, tests)

### L8-1 [DX] Finite-region validation triplicated; centralize
**Issue:** The identical `Number.isFinite(region.x) && ...` block appears in `decodeTiledViewport` (29–31) and `decodeLevel` (183–185) — and both run on the same call (tiled path validates twice). decode-core's `clampRegion` separately NaN-checks only `imageW/H`, not the region (NaN region coords flow through `clampPositive`, which returns NaN for NaN input: `NaN <= 0` and `NaN >= max` are both false).
**Fix:** One helper in decode-core.ts; call it in `decodeTiledViewport` and at the top of `clampRegion`; delete the copy in `decodeLevel` (its tiled branch delegates to `decodeTiledViewport`, which validates):

```ts
export function assertFiniteRegion(r: ImageRegion): void {
  // single-expression NaN/Infinity screen: any non-finite member poisons the sum
  if (!Number.isFinite(r.x + r.y + r.w + r.h)) {
    throw new PyramidError('BAD_REGION', `region must have finite x,y,w,h (got ${r.x},${r.y},${r.w},${r.h})`);
  }
}
```

Note this also migrates the error type from bare `RangeError` to `PyramidError('BAD_REGION')` — see L8-3.

### L8-2 [PERF — micro] `clampRegion` fast path allocates a clone for the common in-bounds case
**Issue:** decode-core.ts lines 52–54: the early-out returns `{ x: r.x, y: r.y, w: r.w, h: r.h }` — a fresh object per decode call even when nothing was clamped.
**Fix:** Return `region` itself on the fast path and document immutability ("callers must not mutate the returned region; it may alias the input"). The plan layer stores it into a frozen-by-convention plan; no in-repo caller mutates. One allocation saved per decode — small, but it is on every hot call and costs one line.

### L8-3 [DX] Error taxonomy inconsistent across the trio
**Issue:** Same-class failures throw different types: bad region → `RangeError` (decode-level) but `PyramidError('ABORTED')` for aborts; level-source throws bare `Error` for JXTC mismatches; buffer problems → `PyramidError`. Callers cannot write one `catch (e) { if (e instanceof PyramidError) ... }` policy.
**Fix:** All throws in the three files become `PyramidError` with codes: `BAD_REGION` (finite/empty region), `JXTC_PARSE` (level-source container mismatches, including L1-1's dim check), `DIM_MISMATCH` (L2-4/L10-R4), keeping `ABORTED`, `INVALID_BUFFER_SIZE`, etc. level-source.ts gains `import { PyramidError } from './decode-core.js'` (no cycle: decode-core imports nothing from level-source). The two `throw new Error(...)` sites in `decodeLevel` (whole-with-region, tiled-without-region) become `PyramidError('BAD_REGION', ...)`.

### L8-4 [FEAT — F7] Progress is countable but not addressable; telemetry has no spine
**Issue:** `onTile(region, completedCount)` gives no total (caller can't render "7/24") and no stable identity (caller can't correlate DC vs final emissions of the same tile, can't key telemetry, can't build L4-4's skip set).
**Fix:** Backwards-compatible widening:

```ts
// decode-core.ts
export interface TileProgress {
  id: TileId;            // via tileIdOf (L5-3)
  key: string;           // tileKey(id) — precomputed, callers use it directly for sets/telemetry
  stage: 'dc' | 'final';
  completed: number;     // running count across all stages
  total: number;         // tiles × stages (2× for dc-then-final, 1× otherwise)
}
// DecodeOptions:
onTile?: (region: ImageRegion, completedCount: number, progress?: TileProgress) => void;
```

decode-level passes the third argument at every `onTile` call site (`stage: 'final'` for direct/one-shot). Existing two-arg callers are untouched. This single hook now serves progress UI, telemetry, abort/resume bookkeeping — F7's "single clean structure".

### L8-5 [FEAT] Test list — each maps to a finding this review caught by reading, which a test would have caught by running
Add under `packages/jxl-pyramid/test/`:
1. **Progressive, non-tile-aligned viewport** (e.g. region `{x: 100, y: 100, w: 700, h: 700}` over a 1024×1024 2×2-tile container): pixels match the one-shot ROI decode byte-for-byte → catches L6-1 **and** L7-1 (currently fails on both).
2. **Abort during direct decode with a reused signal:** assert no `unhandledRejection` (Node: `process.on('unhandledRejection')` trap) and `getEventListeners(signal)` count returns to baseline → L4-1.
3. **Malformed tile bytes:** `push` throws; assert no unhandled rejection from the drain → L4-2.
4. **Cache hit, no outBuffer, caller mutates result, second hit:** second result must be pristine → L10-R1.
5. **rgba16 with odd-offset outBuffer subarray:** expect `INVALID_BUFFER_ALIGNMENT` → L5-2.
6. **`instanceof PyramidError` on an error imported from decode-level** → L2-1.
7. **dc-then-final ordering:** record `onTile` order; all-DC-before-any-final after L3-1.
8. **Custom `decodeRegion` returning wrong-size pixels:** expect `DECODER_OUTPUT_MISMATCH`, not silent corruption → L10-R4.
9. **Fractional region** (`{x: 100.25, y: 0, w: 511.5, h: 512}`): decodes successfully, result covers the requested rect, byte-identical to the snapped integer region → L21-1.
10. **Oversized outBuffer then exact-sized cache hit:** decode with 2×need buffer, re-request with exact-need buffer; second call must succeed and `.pixels.length === need` on both → L19-1.
11. **Concurrent decodes sharing one outBuffer:** second call rejects with `BUFFER_IN_USE` → L22-1.
12. **Whole-source manifest with `bitsPerSample: 12` / negative dims / NaN dims:** `createLevelSource` throws `BAD_MANIFEST` → L18-1.

---

## Lens 9 — The Owl Lens (sniff, listen, look behind)

### L9-1 [DX] Smell inventory: every `as any` in the trio marks a real defect or a missing type
`plan.header as any` → was hiding BUG-CRIT L7-1. `createDecoder({...} as any)` ×2 → hides option-shape drift (L2-2). `(source as any).bytesId` → hides the marker semantics bug (L5-6). `pool?: any` / `workerFactory?: () => any` → L2-2. **Rule for this package:** an `as any` at a module seam is a finding, not a style choice; each fix above removes one. After implementing, `rg "as any" packages/jxl-pyramid/src/{decode-level,level-source,decode-core}.ts` should return only the `(source as any).bytesId` write (typed mutation of an optional field — acceptable, commented).

### L9-2 [DX] The `-preview` cache-key suffix is fossil vocabulary
**Issue:** Nothing in the path produces a "preview" — the key stores final-quality viewport pixels. The word misleads the next reader into thinking a separate full-quality key exists. With dc-only (L3-4) arriving, quality becomes a real axis.
**Fix:** Subsumed by L1-3's `viewportCacheKey(..., quality)`; the suffix becomes `q:final`/`q:dc`. In-memory cache → no migration.

### L9-3 [DX] Review-archaeology comments outweigh code in places
**Issue:** Tags like "(Grok1)", "(Grok4 micro-opt)", "cites L3m-2 L21m-2 L8pm-3" record *which review* proposed a line, not *why the line must hold*. They are noise to the next reader and will be false after this round of changes (lines move, reviews supersede).
**Fix:** When touching a line for the fixes above, rewrite its comment to state the constraint (e.g. `longEdge`: "ternary — hot path, avoids Math.max dispatch" or delete; `stitch` header keeps the stride-contract sentence, drops the citation). Do not do a comment-only sweep (no-opportunistic-refactor rule); fold it into the functional edits.

### L9-4 [Owl ears — listen to what's silent] `parallel` option is accepted and never read in this file
**Issue:** `DecodeOptions.parallel` exists; `decodeTiledViewport` never consults it (pooled path lives elsewhere; the progressive branch ignores it too). A caller setting `parallel: true` with `progressive: 'dc-then-final'` silently gets sequential decode.
**Fix:** Document on the option ("progressive mode currently decodes sequentially; `parallel` applies to the pooled one-shot path only"), or honor it with bounded concurrency in the progressive phases (window of `min(4, navigator.hardwareConcurrency ?? 2)` tiles per `Promise.all` batch, stitching as each settles — order within a phase doesn't matter since rects are disjoint). Document-only is acceptable; silent ignoring is not.

---

## Lens 10 — Run the Film Backwards (4 reversals)

### L10-R1 [BUG] Reverse read↔write: the cache hit hands out the cache's own bytes
**Forward film:** decode → copy into cache → later hit returns pixels. **Backwards:** caller *writes* into what the cache *returned* — `return { pixels: cached, ... }` (line 50) exposes the internal stored array. A caller that tints, composites, or runs Lens-17 transforms in place poisons every future hit of that key.
**Fix:** Copy on hit when the caller provided no buffer; zero-copy stays available explicitly:

```ts
// DecodeOptions:
/** Return cache hits by reference (no defensive copy). Caller promises not to mutate. */
zeroCopyCacheHits?: boolean;
```

```ts
if (cached) {
  if (options?.outBuffer) { /* existing validated ob.set path */ }
  const px = options?.zeroCopyCacheHits ? cached : new Uint8Array(cached);
  return { pixels: px, width: vp.w, height: vp.h, format: plan.format };
}
```

### L10-R2 [PERF] Reverse one-caller↔many-callers: concurrent same-key decodes both miss, both pay
**Backwards:** two viewers (or a pan re-entry) request the same viewport while the first decode is in flight — both miss the cache, both decode the full viewport. The pipeline-level dedupe lives in the scheduler (CLAUDE.md), but jxl-pyramid sits beside that pipeline and has no dedupe at all.
**Fix:** In-flight registry scoped **per cache instance** (no module-global state; only active when a cache is supplied, since the cache key is the identity):

```ts
// decode-level.ts (module scope)
const inflightByCache = new WeakMap<PyramidCache, Map<string, Promise<Uint8Array>>>();
```

On miss: register a promise that resolves to the **pristine cached copy**; concurrent callers `await` it and then apply their own outBuffer/copy materialization (each caller's buffer differs — share the decode, not the buffer). Remove the entry in `finally`. ~25 lines; skip if multi-consumer same-viewport is not yet a real pattern — flag for the viewer integration milestone.

### L10-R3 [PERF/UX] Reverse scan order: last tile first → no order is sacred → decode center-out
**Backwards:** running the tile loop in reverse changes nothing semantically (disjoint rects) — which proves the scan order is a free variable. Row-major order paints the top edge first; users look at the **center** of a viewport.
**Fix:** Opt-in ordering on `DecodeOptions`:

```ts
/** Tile decode order. 'scan' (default) = row-major; 'center-out' = nearest-to-viewport-center first. */
tileOrder?: 'scan' | 'center-out';
```

```ts
let tiles = plan.tiles;
if (options?.tileOrder === 'center-out') {
  const cx = vp.x + vp.w / 2, cy = vp.y + vp.h / 2;
  tiles = plan.tiles.slice().sort((a, b) =>
    ((a.x + a.w / 2 - cx) ** 2 + (a.y + a.h / 2 - cy) ** 2) -
    ((b.x + b.w / 2 - cx) ** 2 + (b.y + b.h / 2 - cy) ** 2));
}
```

Applies to both progressive phases (use `tiles`, not `plan.tiles`, in the loops). Never mutate `plan.tiles` — the plan is memoized per source.

### L10-R4 [BUG/F2] Reverse validation direction: inputs are checked, outputs are trusted
**Backwards:** the function distrusts the caller's region and buffer, yet **trusts whatever the decoder returns**. `decodeRegion` is caller-overridable (`options.decodeRegion`), so the direct path's `target.set(direct.pixels)` happily copies a wrong-sized or wrong-format buffer: smaller → top-of-viewport garbage below; larger → `RangeError` with no context; rgba16-decoder-on-rgba8-plan → byte-doubled smear.
**Fix:** Output gate at the seam, used by the direct path (and `decodeWhole` per L2-4):

```ts
// decode-core.ts
export function validateDecodedOutput(d: DecodedLevel, expected: ImageRegion, bpp: 4 | 8): void {
  if (d.width !== expected.w || d.height !== expected.h) {
    throw new PyramidError('DECODER_OUTPUT_MISMATCH',
      `decoder returned ${d.width}x${d.height}, expected ${expected.w}x${expected.h}`);
  }
  const need = expected.w * expected.h * bpp;
  if (d.pixels.byteLength !== need) {
    throw new PyramidError('DECODER_OUTPUT_MISMATCH',
      `decoder returned ${d.pixels.byteLength} bytes, expected ${need}`);
  }
}
```

---

## Lens 11 — The Astronomer's Lens

The pyramid **is** a telescope stack: levels are focal lengths, the viewport is the eyepiece, DC passes are quick-look frames, the cache is the plate archive. Three suggestions fall out of taking the analogy seriously:

### L11-1 [FEAT — F7 extension] Hierarchical tile addressing (the HEALPix move)
**Issue:** Sky surveys index hierarchically: every cell knows its parent and children, so a coarse plate can stand in while fine plates arrive. `TileId` has `level` but no cross-level algebra — a viewer wanting "paint the parent tile scaled 2× while the child decodes" must derive the relationship by hand, and will derive it differently in each call site.
**Fix:** Pure functions beside `TileId` in decode-core.ts (dyadic pyramid assumed — each level halves dimensions; document that assumption):

```ts
/** Parent tile one level coarser (dyadic pyramid: level-1 covers 2×2 tiles of this level). */
export function parentTileOf(t: TileId): TileId {
  return { level: t.level - 1, col: t.col >> 1, row: t.row >> 1 };
}
/** The up-to-4 children one level finer. Callers clip against that level's grid extent. */
export function childTilesOf(t: TileId): TileId[] {
  const l = t.level + 1, c = t.col << 1, r = t.row << 1;
  return [{level: l, col: c, row: r}, {level: l, col: c + 1, row: r},
          {level: l, col: c, row: r + 1}, {level: l, col: c + 1, row: r + 1}];
}
```

Combined with `makeTileCacheKey`, a viewer checks `parentTileOf` keys for instant stand-in pixels before any decode starts — the "finder scope" frame.

### L11-2 [FEAT] Quick-look protocol: cached DC as the acquisition frame
Sequencing rule for callers, enabled by L3-4 + L1-3's quality-keyed cache: on viewport change, ① serve cached `q:dc` (or parent-level via L11-1) instantly, ② run `dc-only` decode if nothing cached, ③ schedule `dc-then-final`. Steps ① and ② are sub-frame-budget. No new code beyond L3-4/L1-3 — record the protocol in the `ProgressiveMode` doc comment so the viewer layer implements it once, correctly.

### L11-3 [PERF] Adaptive optics = L10-R3's center-out, with a guide star
`tileOrder: 'center-out'` is the static version of telescope pointing. The dynamic version — caller supplies the fixation point (cursor, gaze, detected subject) instead of assuming center:

```ts
/** Focus point (image coords) for 'center-out' ordering; defaults to viewport center. */
focusPoint?: { x: number; y: number };
```

One-line change to the L10-R3 comparator (`cx = options?.focusPoint?.x ?? vp.x + vp.w / 2`). This is also the AR foveation primitive (Lens 16) and the saliency hook (Lens 12) — one option serves three roadmap items.

---

## Lens 12 — LLM & Machine Recognition

### L12-1 [FEAT] DC-only decode as the embedding feed
Species-ID models and CLIP-style embedders downsample inputs to ≤512px anyway — full AC decode is wasted work for recognition. L3-4's `dc-only` mode delivers recognition-grade pixels at ~1/8 the decode cost. **Action beyond L3-4:** none in these files; note in the mode's doc comment: "dc-only output is intended for ML screening/embedding; pair with `tileOrder: 'center-out'` + `focusPoint` for detector-guided refinement."

### L12-2 [FEAT] Stable tile addressing = stable annotation keys
**Issue:** Recognition outputs (species labels, bounding boxes, embeddings) need durable keys to attach to. Pixel coords break across level changes; ad-hoc strings break across sessions.
**Fix:** Already built by F7 once L5-3 lands: `makeTileCacheKey(sourceId, tileId)` with a **content-derived** sourceId (the manifest's `contenthash`, not the ephemeral WeakMap `getLevelId`) is the durable annotation key. Concrete change: accept an optional stable id on the source —

```ts
// level-source.ts — both variants
/** Stable content identity (e.g. manifest contenthash) for durable cache/annotation keys.
 *  When absent, runtime-scoped ids are used and keys do not survive reloads. */
contentId?: string;
```

`createLevelSource` copies it from a widened entry param (`entry: Pick<PyramidLevel, 'w' | 'h' | 'tiled'> & { bitsPerSample?: 8 | 16; contenthash?: string }`). decode-level's cache key builder prefers `source.contentId ?? getLevelId(source)` — which also upgrades the viewport cache from session-scoped to content-addressed for free.

### L12-3 [FEAT] Strided sub-views for zero-copy ML handoff
**Issue:** After `onTile`, an ML consumer wanting that tile's pixels must know the stitched buffer's stride and slice it themselves — re-deriving geometry this module already knows.
**Fix:** Extend L8-4's `TileProgress` with a view descriptor (no copy, just arithmetic the module already did):

```ts
export interface TileProgress {
  // ...as L8-4...
  /** Strided view of this tile's pixels inside the stitched buffer:
   *  rows start at byteOffset, advance by strideBytes, rowBytes valid bytes each, rect.h rows. */
  view: { byteOffset: number; strideBytes: number; rowBytes: number };
}
```

Populated from the stitch math (`dstOff`, `dstStride`, `rowBytes`) at zero extra cost. A recognition worker can `subarray` rows straight into a tensor without re-deriving layout.

---

## Lens 13 — Principles from Gaming

### L13-1 [PERF/UX] Frame-budgeted decode loop (the game-loop tick)
**Issue:** Game engines never let a system run unbounded inside a frame. The progressive loop awaits per tile — microtask yields only — so if `createDecoder` work runs on the main thread, rAF paints are starved during long viewports: stutter exactly when the user pans.
**Fix:** Macrotask yield on a time budget between tiles (both phases):

```ts
// decode-level.ts (module scope)
const FRAME_YIELD_BUDGET_MS = 12;
const yieldToFrame = (): Promise<void> =>
  (globalThis as any).scheduler?.yield?.() ?? new Promise<void>((r) => setTimeout(r, 0));
```

```ts
// in each phase loop, after onTile
if (performance.now() - sliceStart > FRAME_YIELD_BUDGET_MS) {
  await yieldToFrame();
  sliceStart = performance.now();
}
```

Opt-in via `DecodeOptions.yieldBetweenTiles?: boolean` (default off — Node/worker contexts shouldn't pay the macrotask hop; the browser-main-thread caller opts in). No effect on results, only on scheduling.

### L13-2 [FEAT] Mip-chain streaming: prefetch ring at DC quality
Games stream texture mips for the camera's *next* position. Equivalent here: after a viewport completes, decode a one-tile-wide ring around it at `dc-only` quality into the quality-keyed cache (L3-4 + L1-3) so the next pan hits warm coarse pixels. **Placement:** caller/viewer layer drives *when*; these files only need what already exists after L3-4 (callable cheap mode + dc cache keys) plus L4-4's skip set so the ring decode never duplicates the visible viewport's tiles. Document the recipe on `ProgressiveMode`.

### L13-3 [PERF] Object pooling done right: the outBuffer is the pool — say so
**Issue:** Gaming's lesson is pre-allocated, recycled buffers. `outBuffer` already enables this, but nothing documents the contract, and L10-R1 showed how easily ownership rules rot without one.
**Fix:** Doc block on `outBuffer` in decode-core.ts stating the full contract: caller owns it; must be ≥ `vp.w·vp.h·bpp` (post-clamp viewport may be smaller than requested region — compute via clamped dims); 2-byte aligned for rgba16 (L5-2); contents are garbage until the first `onTile`; valid rows grow per `onTile`; reuse across pans requires either full overwrite or L4-4's skipTiles; never hand the same buffer to two concurrent decodes. Each clause is a support ticket pre-answered.

---

## Lens 14 — Photogrammetry & Digital Twins

Digital-twin reconstruction needs three things from a decode layer: **radiometric fidelity** (16-bit, color-managed), **geometric exactness** (no resampling, known provenance), **deterministic addressing** (re-derivable pixel↔source mapping).

### L14-1 [BUG-adjacent/FEAT] `preserveIcc: false` is hardcoded — color truth is discarded
**Issue:** `WHOLE_DECODE_OPTS` and both progressive decoder configs set `preserveIcc: false, preserveMetadata: false`. For gallery painting that's right; for photogrammetric texture capture and Lens-17 color science it silently destroys the color-management chain — reconstructed twins inherit unspecified color.
**Fix:** Surface it without changing defaults:

```ts
// decode-core.ts — DecodeOptions
/** Preserve ICC/color metadata through decode (photogrammetry/color-science consumers).
 *  Default false (painting path). */
preserveColorProfile?: boolean;
```

Thread to every `createDecoder` site: `preserveIcc: options?.preserveColorProfile ?? false` (and likewise `preserveMetadata`). `WHOLE_DECODE_OPTS` stays frozen as the default template; build the final init object by spread + override. If the facade returns ICC bytes on an event, pass them through on `DecodedLevel` as optional `icc?: Uint8Array` — populate when present, ignore otherwise.

### L14-2 [FEAT] Per-tile provenance for reconstruction pipelines
**Issue:** A photogrammetry pipeline must answer "which container bytes produced this pixel region, at what quality?" After stitching, that mapping is gone.
**Fix:** L8-4 + L12-3 already carry `{id, key, stage, view}` per tile — that *is* the provenance record. Remaining gap: nothing ties it to content identity → closed by L12-2's `contentId`. Optional convenience: `DecodedLevel.provenance?: TileProgress[]` (populated only when a new `DecodeOptions.collectProvenance?: boolean` is set, to avoid retaining N records for callers that don't care). Ten lines: push each `TileProgress` into an array alongside the `onTile` call, attach on return.

### L14-3 [DX] State the exactness guarantee where consumers will read it
**Issue:** The layer's strongest photogrammetry property is implicit: region decodes are **native-resolution crops** — no interpolation, no resampling, pixel (x,y) of the output is pixel (vp.x+x, vp.y+y) of the level image. Unstated guarantees get accidentally broken (someone "helpfully" adds smoothing at a seam) and can't be relied on by twin builders.
**Fix:** Doc comment on `decodeLevel`/`decodeTiledViewport`: "Guarantee: output pixels are an exact axis-aligned crop of the decoded level at native resolution; this layer never resamples, blends, or color-converts. Geometric mapping: out(x,y) ≡ level(vp.x+x, vp.y+y)." Add the L8-5 test that asserts byte-equality between a tiled-viewport decode and the same crop of a whole-frame decode (which simultaneously regression-guards L6-1).

---

## Lens 15 — Butteraugli (perceptual metric cost) in These Layers

Butteraugli itself runs encoder-side; these files can't speed up its inner loops. What they *can* do is starve it of redundant work and feed it without copies:

### L15-1 [PERF] DC-pass pre-screening: don't run the slow metric where the cheap one settles it
A butteraugli pass over full-res tiles is O(W·H) with a huge constant. The DC image (64× fewer pixels after 8× downsample) is a usable proxy screen: tiles whose DC-level difference is already far below (or above) the decision threshold need no full-res metric. **Enabled by:** L3-4 (`dc-only` decode of both candidates) + L12-3 (strided per-tile views to compare without re-slicing). The screening logic itself belongs to the encoder/quality harness, not these files — but it is only *possible* if dc-only and per-tile views exist. No further action here; cite this as motivation on L3-4.

### L15-2 [PERF] rgba16 + zero-copy feed for the metric
Butteraugli on 8-bit quantized buffers measures quantization, not codec quality, near thresholds. F6's monotone rgba16 path (L1-2/L5-1) plus the `decodeInto` future (L7-3) lets a quality harness decode reference and candidate straight into two halves of one WASM-adjacent buffer — no JS-side copies before the metric call. Action in this trio: none beyond L1-2/L5-1/L7-3; recorded so the quality-harness milestone knows the dependencies are deliberate.

### L15-3 [PERF] Tile-parallel metric with early exit, in decode order
Per-tile butteraugli is embarrassingly parallel and can short-circuit the moment any tile exceeds the distance budget. `tileOrder: 'center-out'` + `focusPoint` (L10-R3/L11-3) lets the harness evaluate perceptually-critical tiles first, so failing candidates are rejected after 1–2 tile decodes instead of a full viewport. Again: the loop lives in the harness; the ordering and per-tile delivery primitives live here and are already specified above.

---

## Lens 16 — Immersive / Augmented Reality

(The lens prompt was truncated at "...Augmented Reality to". Assumption: AR overlay/inspection of organism imagery — headset or phone — where decode latency, frame pacing, and power budgets dominate. Proceeding on that basis.)

### L16-1 [FEAT] Foveated decode = priority region at final, periphery at DC
**Issue:** AR has a hard truth: the user perceives full detail only at the fixation point, and the device can't afford full-detail everywhere. The trio is one option short of expressing this.
**Fix:** Compose existing pieces into one option:

```ts
// decode-core.ts — DecodeOptions
/** Foveated decode: tiles intersecting this image-space rect get dc+final; all other
 *  viewport tiles stop at dc. Requires progressive: 'dc-then-final'. */
priorityRegion?: ImageRegion;
```

Implementation in the L3-1 two-phase loop: phase 1 (DC) runs over all tiles; phase 2 (final) filters to tiles intersecting `priorityRegion` (simple rect-overlap test — `!(t.x + t.w <= pr.x || pr.x + pr.w <= t.x || ...)`). `total` for `TileProgress` = `tiles.length + priorityTiles.length`. Cache note: a foveated result is *mixed quality* — do **not** write the viewport-level `q:final` cache entry unless every tile ran final (guard: `priorityTiles.length === tiles.length`).

### L16-2 [PERF] Frame pacing and power: the AR loop is L13-1 + L3-4 with different constants
Headset budget ≈ 11ms (90Hz) → `yieldBetweenTiles` with the budget made an option rather than a constant: change L13-1's constant to `DecodeOptions.yieldBudgetMs?: number` (default 12). Battery saver = `dc-only` + smaller `priorityRegion`. Pose-predicted prefetch = L13-2's ring, biased along the motion vector by the caller (it owns pose; it just shifts the prefetch region it requests). No new machinery — this lens validates that the primitives compose; record the recipe in the package README when these land.

---

## Lens 17 — The Non-Riemannian Perceptual Color Engine

The engine itself lands in Rust (`apply_tone_math`, LookRenderer) — but its stated delivery vehicle is "illumination-invariant adjustments **during progressive JXL paints**", which is exactly this trio's loop. Four integration requirements, in dependency order:

### L17-1 [ARCH — the load-bearing decision] Apply look in WASM before copy-out, not in JS after stitch
**Issue:** A JS-side per-pixel transform after stitching forfeits the LUT/SIMD work: pixels would cross WASM→JS, get re-uploaded to the LookRenderer's WASM heap, transform, and cross back — two boundary copies per repaint, precisely what the sub-millisecond LUT budget cannot afford.
**Fix (option surface now, bridge work later):** Mirror L7-3's pattern — define the passthrough so the facade/bridge can fuse decode+look in one heap pass (decoder output buffer → LUT applied in C++/Rust → single copy-out):

```ts
// decode-core.ts — DecodeOptions
/** Opaque look-transform parameters forwarded to the decode facade. When the facade supports
 *  fused decode+look (Perceptual Constancy Mode), pixels are transformed in WASM before copy-out;
 *  otherwise the option is ignored and the caller applies look downstream. Cache interaction: see
 *  cache-purity rule (L17-3). */
lookParams?: unknown;
```

Thread `lookParams` into the `createDecoder` init objects (the facade ignores unknown keys until it supports them — verify, else gate on a capability check). This single field is the contract that lets points 8–10 of the engine plan ship without re-touching the pyramid layer.

### L17-2 [FEAT — interim path] `transformTile` hook for the JS-prototype phase
**Issue:** Before the fused bridge exists, the engine team needs to prototype against real progressive paints.
**Fix:** Post-stitch, per-tile hook — strided, in-place, fires per stage so DC paints can use the cheap approximation LUT and final the full spline path:

```ts
// decode-core.ts — DecodeOptions
/** Prototype hook: called after each tile stitch, before onTile. Transforms pixels in place
 *  within the stitched buffer via the strided view. Superseded by lookParams once the facade
 *  fuses decode+look. */
transformTile?: (
  buffer: Uint8Array,
  view: { byteOffset: number; strideBytes: number; rowBytes: number; rows: number },
  stage: 'dc' | 'final',
  format: PixelFormat,
) => void;
```

decode-level calls it with the same numbers the stitch just used (L12-3's view + `rows: t.h`). In-place mutation of `target` is safe — rects are disjoint, and the hook runs before `onTile` so painters always see transformed pixels.

### L17-3 [BUG-prevention — the cache-purity rule] Cache stores pristine pixels only; look applies after read
**Issue:** Look parameters are not in the cache key. If transformed pixels reach `cache.set`, a slider change serves stale-look hits — wrong pixels with no error. (This is the same shape as the Lens-1 "logic-2 / single-buffer" guardrail class: invariants that prevent silent wrongness.)
**Fix (ordering rule + one shadow buffer):** When `cache && (transformTile || lookParams-applied-in-facade)`: maintain a pristine shadow — stitch into `target`, copy the tile's rect into `shadow` (same stitch math, ~free relative to decode), *then* transform `target`. `cache.set` writes `shadow`. Allocate `shadow = new Uint8Array(need)` lazily only when both features are active (one extra viewport allocation, only for look+cache callers). Cache reads symmetrically: hit → copy out (L10-R1) → `transformTile(copy, fullView, 'final', format)` before return. State the invariant as a comment at both cache.set sites: **"cache must remain look-independent; transforms apply post-read, never pre-write."**

### L17-4 [PERF — prerequisites already specified] 16-bit, aligned, format-tagged
The engine's log-space math is unusable on 8-bit-quantized input (posterization in the shadows the Harvard-space transform would amplify). Its prerequisites in this trio are all already specified: monotone rgba16 token flow (L1-2, L5-1), 2-byte alignment guarantee for `Uint16Array` views (L5-2), format tag on the result so the LookRenderer binds the right kernel without sniffing (L5-5), ICC preservation for the sensor-sharpening matrix B's input characterization (L14-1). Implement those four and the color engine plugs in without further changes here. SIMD tail note for the Rust side: clipped edge tiles produce arbitrary-width rects — the WASM LUT kernel must handle non-multiple-of-4 row widths (scalar tail loop), since this layer correctly refuses to pad rects (padding would violate L14-3's exactness guarantee).

---

# Gap Lenses (18–23) — angles the original 17 did not cover

Coverage audit of Lenses 1–17 found six unexamined angles: **adversarial input**, **memory lifecycle**, **failure modes/partial results**, **numerical edge cases**, **concurrency/reentrancy**, and **layer-invariant compliance**. (Considered and dismissed for lack of surface in a decode layer: i18n, accessibility, schema versioning — the JXTC version gate lives outside the trio.)

---

## Lens 18 — Adversarial Input & Trust Boundaries

The tiled branch inherits tiling's G4-A header validation; the **whole branch and hand-built sources have no equivalent**.

### L18-1 [BUG] `createLevelSource` whole branch trusts the manifest entry completely
**Issue:** level-source.ts lines 31–41: `entry.w`, `entry.h`, `entry.bitsPerSample` come from parsed JSON. No check that dims are positive integers, no decode-size cap (the tiled branch gets a 1 GiB cap via `parseJxtcHeader`; the whole branch gets nothing), and `bitsPerSample: 12` (possible via any cast or hand-written JSON) silently falls into the `!== 16 → rgba8` bucket — wrong format with no error. NaN dims propagate into `LevelSource.width/height` and surface later as confusing failures in whatever consumes them.
**Fix:**

```ts
// level-source.ts — whole branch, before constructing the source
const bits = entry.bitsPerSample ?? 8;
if (bits !== 8 && bits !== 16) {
  throw new PyramidError('BAD_MANIFEST', `bitsPerSample must be 8 or 16 (got ${bits})`);
}
if (!Number.isInteger(entry.w) || !Number.isInteger(entry.h) || entry.w <= 0 || entry.h <= 0) {
  throw new PyramidError('BAD_MANIFEST', `level dims must be positive integers (got ${entry.w}x${entry.h})`);
}
if (entry.w * entry.h * bppOfFormat(formatFromBits(bits)) > (1 << 30)) {
  throw new PyramidError('OOM', `level ${entry.w}x${entry.h}@${bits}bit exceeds 1GiB decode cap`);
}
```

Add `'BAD_MANIFEST'` to the L5-7 code union. Mirrors the tiled branch's cap so both `LevelSource` variants carry the same safety guarantee.

### L18-2 [BUG-adjacent] Hand-built tiled sources: `tileSize` never re-checked at decode time
**Issue:** `LevelSource` is a public type — nothing forces construction through `createLevelSource`. A hand-built source with `tileSize: 0` reaches the L7-1 fix's `Math.ceil(source.width / source.tileSize)` → `Infinity` → `extractTileBitstream` fails with a misleading "tile out of JXTC grid". With `tileSize: 0.5` (fractional), grid math degrades silently.
**Fix:** One guard at `decodeTiledViewport` entry (beside the existing finite-region check):

```ts
if (!Number.isInteger(source.tileSize) || source.tileSize <= 0 ||
    !Number.isInteger(source.width) || source.width <= 0 ||
    !Number.isInteger(source.height) || source.height <= 0) {
  throw new PyramidError('BAD_MANIFEST', `tiled source dims/tileSize must be positive integers`);
}
```

### L18-3 [DX] `contentId` (L12-2) joins keys with `:` — constrain it
**Issue:** Once user-supplied `contentId` participates in `viewportCacheKey`/`makeTileCacheKey` (both `:`-delimited), an id containing `:` can collide two logically distinct keys.
**Fix:** Document on the field ("must be a hex/base64url content hash; must not contain `:`") and enforce cheaply in `createLevelSource`: `if (entry.contenthash?.includes(':')) throw new PyramidError('BAD_MANIFEST', ...)`.

### L18-4 [DX] Tile bitstream views must never be transferred
**Issue:** `extractTileBitstream` returns a **subarray view into `source.bytes`**. Any future caller that posts one to a worker with a transfer list detaches the whole container — every subsequent tile of every viewport on that source breaks. The hazard is invisible at the call site.
**Fix:** One sentence on the function's doc comment (tiling.ts owns it, but the in-trio consumers should carry the warning where the views are produced in decode-level): "tile bytes are views into the container; copy (`slice()`) before any postMessage transfer."

---

## Lens 19 — Memory Lifecycle, GC Pressure & Peak Footprint

### L19-1 [BUG] Oversized `outBuffer` contaminates the result and the cache
**Issue:** The size check is `ob.byteLength < need` — larger is allowed (correct for pooled arenas). But then: (a) `return { pixels: target, ... }` hands back the **whole oversized buffer** — `.pixels.length` no longer equals `w·h·bpp`, breaking any consumer that derives geometry from length (ImageData construction, tensor reshapes); (b) `cache.set(key, new Uint8Array(target))` copies the **entire oversized buffer** into the cache — wasted bytes, and worse: a later cache hit served into an exactly-sized `outBuffer` executes `ob.set(cached)` with `cached.length > ob.length` → **RangeError "source is too large"** on a path that worked yesterday. Decode succeeds, cache poisons, failure detonates on an unrelated later call.
**Fix:** Trim at both boundaries, all paths (progressive, direct, cache-hit):

```ts
// returns: pixels is ALWAYS exactly need bytes — a subarray view of outBuffer when provided
const pixels = target.byteLength === need ? target : target.subarray(0, need);
return { pixels, width: vp.w, height: vp.h, format: plan.format };
```

```ts
// cache writes: copy exactly the viewport bytes, never the container buffer
if (cache && cacheKey) cache.set(cacheKey, target.slice(0, need));
```

(`slice` copies — required for cache ownership; `subarray` views — correct for the return.) Document on `outBuffer`: "result `.pixels` is a `need`-byte view into this buffer." Cache-hit path symmetric: `return { pixels: ob.subarray(0, need), ... }`.

### L19-2 [PERF] Allocation census — where the bytes go per progressive viewport
For N tiles: N×(DC tile buffer) + N×(final tile buffer) + `target` + cache copy ≈ `2·N·tileBytes + 2·need`. After L3-2 (single session) the DC buffers halve; after S-1 (per-tile cache) repeat viewports drop to `need` + memcpys. Peak concurrent: `target` + ≤2 tile buffers (sequential loop) — the layer is not allocation-bound; **no pooling warranted** (and CLAUDE.md R1-2 rejects output pools). Recorded so future "add a buffer pool" proposals have the numbers to argue against.

### L19-3 [PERF — note, out-of-trio] Plan memo retains the first region's tile array
The per-source plan memo keeps the originally-planned `tiles`/`viewport` alive for the source's lifetime even though hits rebuild tiles per call. Bounded (one array per source), but trimming the memoized plan to `{header, bits, bpp, format, decodeRegion}` would drop the stale rects. Plan layer is outside the trio — one-line note for its next touch.

### L19-4 [DX] State the peak-memory formula where integrators will look
Doc comment on `decodeTiledViewport`: "Peak memory ≈ `vp.w·vp.h·bpp` (target) + ≤2 full-tile buffers (`tileSize²·bpp` each) + transient decoder state; plus one viewport copy if `cache` is set." AR/mobile integrators (Lens 16) budget against this.

---

## Lens 20 — Failure Modes, Partial Results & Graceful Degradation

### L20-1 [FEAT] One corrupt tile kills the whole viewport
**Issue:** Any tile decode error rejects `decodeTiledViewport` entirely — yet the caller's `outBuffer` already holds every previously-stitched tile, and `onTile` already announced them. For a viewer, one damaged tile in a 24-tile viewport should degrade, not blank the screen.
**Fix:** Tolerance policy + structured partial result:

```ts
// decode-core.ts — DecodeOptions
/** Per-tile failure handling. 'fail-fast' (default, current behavior) rejects on first error.
 *  'skip-tile' zero-fills the failed tile's rect, records it, and continues. */
errorPolicy?: 'fail-fast' | 'skip-tile';
// DecodedLevel
failedTiles?: TileId[];   // present (possibly empty) only when errorPolicy === 'skip-tile'
```

```ts
// decode-level.ts — per-tile try/catch in both phases
try {
  px = await decodeTileBytesProgressive(tileBytesList[i], plan.format, stage);
} catch (e) {
  if (options?.errorPolicy !== 'skip-tile') throw e;
  zeroFillRect(target, vp, t, plan.bpp);          // deterministic holes (fresh allocs are pre-zeroed;
  failed.push(tileIdOf(t, source.tileSize, lvl)); //  this matters for REUSED outBuffers)
  onTile?.(t, ++completed);                        // count advances so totals stay coherent
  continue;
}
```

```ts
function zeroFillRect(target: Uint8Array, vp: ImageRegion, t: ImageRegion, bpp: number): void {
  const rowBytes = t.w * bpp, dstStride = vp.w * bpp;
  let off = ((t.y - vp.y) * vp.w + (t.x - vp.x)) * bpp;
  for (let r = 0; r < t.h; r++) { target.fill(0, off, off + rowBytes); off += dstStride; }
}
```

**Cache rule:** a viewport with `failedTiles.length > 0` must **not** be written to the viewport-level cache (it would serve holes forever); per-tile cache (S-1) is unaffected — failed tiles simply aren't stored.

### L20-2 [FEAT] No time budget — runaway viewports on slow devices
**Issue:** The session layer has `decode_budget_exceeded` semantics (graceful partial-frame end); the pyramid path has nothing — a 50-tile progressive decode on a throttled phone runs to completion regardless of whether the user is still there.
**Fix:** Call-level deadline, measured once from entry — **deliberately mirrors the CLAUDE.md budget contract: elapsed-from-start, no per-stage reset (DH-5)**:

```ts
// DecodeOptions
/** Max elapsed ms for the whole decode call (entry to return). On expiry: 'fail-fast' →
 *  PyramidError('TIMEOUT'); 'skip-tile' → return partial with remaining tiles in failedTiles. */
budgetMs?: number;
```

```ts
const deadline = options?.budgetMs != null ? performance.now() + options.budgetMs : Infinity;
// top of each phase-loop iteration:
if (performance.now() > deadline) {
  if (options?.errorPolicy === 'skip-tile') { recordRemainingAsFailed(); break; }
  throw new PyramidError('TIMEOUT', `decode budget ${options!.budgetMs}ms exceeded after ${completed} steps`);
}
```

With `skip-tile` + dc-then-final this naturally degrades to "DC everywhere, final where time allowed" — the budget-exceeded analogue of a partial frame. Pairs with L4-4: the caller re-issues with `skipTiles` to finish later.

### L20-3 [DX] Partial-state contract after abort/failure — write it down
After an abort or fail-fast rejection mid-progressive, the caller's `outBuffer` legitimately contains a prefix of stitched tiles (already announced via `onTile`). That is a feature (paint survives), but only if stated. Add to the L13-3 ownership doc: "on rejection, previously-announced tiles remain valid in outBuffer; un-announced regions are unspecified; reuse with `skipTiles` to resume."

---

## Lens 21 — Numerical Edge Cases

### L21-1 [BUG] Fractional region coordinates break byte math
**Issue:** Real viewers produce fractional regions constantly (`zoom * cssPixels`, devicePixelRatio scaling). The entry checks test only `Number.isFinite` — `{x: 100.25, y: 0, w: 511.5, h: 512}` passes. Consequences: `need = vp.w·vp.h·bpp` is fractional → `new Uint8Array(fractional)` throws RangeError (no-outBuffer path); with `outBuffer`, fractional `need` makes the `<` size check semantically fuzzy, and fractional `dx/dy/strides` reach `TypedArray.set`/`subarray`, whose ToInteger truncation **silently misaligns rows** — corruption with no error. Mixed throw/corrupt depending on path = worst failure class.
**Fix:** Snap at the boundary, expand-to-cover (never shrink the request):

```ts
// decode-core.ts
/** Snap fractional regions to integers: floor the origin, ceil the far edge.
 *  Output always covers the requested rect. Identity (no alloc) for integer input. */
export function snapRegionToIntegers(r: ImageRegion): ImageRegion {
  if (Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.w) && Number.isInteger(r.h)) return r;
  const x = Math.floor(r.x), y = Math.floor(r.y);
  return { x, y, w: Math.ceil(r.x + r.w) - x, h: Math.ceil(r.y + r.h) - y };
}
```

Apply in `decodeTiledViewport` immediately after `assertFiniteRegion` (L8-1), before planning. Chosen over throwing: every caller would otherwise reimplement the same floor/ceil, divergently. Note the implication for `outBuffer` sizing: callers must size against the **snapped, clamped** viewport — covered by the L13-3 contract sentence ("compute via clamped dims").

### L21-2 [DX] Degenerate-region behavior: document, and unify the error
Region fully outside the image clamps to zero area → today a bare `RangeError("empty region after clamp")` surfaces from the plan layer. After L8-3 the in-trio rethrow should be `PyramidError('BAD_REGION')`. Wrap the `prepareDecodePlan` call:

```ts
let plan: DecodePlan;
try { plan = prepareDecodePlan(source, region); }
catch (e) {
  throw e instanceof PyramidError ? e
    : new PyramidError('BAD_REGION', `region ${region.x},${region.y},${region.w},${region.h} unplannable`, e);
}
```

Doc on `decodeLevel`: "zero-area regions (after clamping to image bounds) are an error, not an empty result" — callers wanting probe semantics check bounds first.

### L21-3 [note] Overflow caps
Tiled sources: capped at 1 GiB by header validation upstream. Whole sources: uncapped until L18-1 lands — that finding closes this lens's remaining overflow hole. Cross-ref only.

---

## Lens 22 — Concurrency & Reentrancy

### L22-1 [FEAT — cheap insurance] Same `outBuffer` in two concurrent decodes = interleaved garbage
**Issue:** Two in-flight `decodeTiledViewport` calls stitching into one buffer corrupt each other with no error — the classic viewer bug when pan handlers fire faster than decodes finish (precisely the scenario `skipTiles`/abort serve). Nothing detects it.
**Fix:** Identity guard, always-on (a WeakSet probe is nanoseconds against a multi-ms decode):

```ts
// decode-level.ts — module scope
const buffersInFlight = new WeakSet<Uint8Array>();
```

```ts
if (options?.outBuffer) {
  if (buffersInFlight.has(options.outBuffer)) {
    throw new PyramidError('BUFFER_IN_USE', 'outBuffer is already in use by a concurrent decode');
  }
  buffersInFlight.add(options.outBuffer);
}
try {
  // ...entire existing body...
} finally {
  if (options?.outBuffer) buffersInFlight.delete(options.outBuffer);
}
```

Add `'BUFFER_IN_USE'` to the L5-7 union. **Known limit (deliberate):** guards exact view identity only — two distinct subarrays over one arena are allowed (legal when disjoint, and overlap detection would cost range bookkeeping). Catches the common bug, permits the valid pattern; say both in the doc comment.

### L22-2 [note] Cache write races are benign; decode races are L10-R2's job
Two concurrent same-key decodes both `cache.set` — last write wins with identical content; the in-memory cache's Map operations are atomic per call (single-threaded JS). No fix needed beyond L10-R2's in-flight dedupe, which removes the duplicated *work*.

### L22-3 [note] Shared `LevelSource` under concurrency is safe by construction
Plan memoization is keyed by source identity and written synchronously (no await between miss-check and set); `prepareLevelSource`'s marker write is idempotent in effect. The only mutable field is `bytesId`, owned by the pool layer. One sentence on the `LevelSource` type doc: "instances are safe to share across concurrent decodes; treat all fields as frozen after creation."

---

## Lens 23 — Layer-Invariant Compliance (CLAUDE.md cross-check)

Audit of the trio **and** of this document's own suggestions against the repo's standing invariants and rejection log:

| Invariant / rejection | Verdict |
|---|---|
| Backpressure lives at scheduler/worker boundary only | **Clean.** Trio adds none; sequential awaits self-throttle. L13-1's yield is scheduling courtesy, not backpressure. |
| Dedupe lives in scheduler; cache stays content-agnostic | **Compliant with a fence.** L10-R2's in-flight map is per-`PyramidCache`, decode-promise-scoped, beside the jxl-stream pipeline (different package, different consumers). The cache itself still stores one entry per content key — no sourceKey duplication (G2-1 respected). Do **not** migrate that dedupe into jxl-cache. |
| Budget = elapsed-from-start, never per-stage reset (DH-5/DH6-5) | **Compliant by construction.** L20-2 computes one deadline at entry; phases share it. |
| No output pixel pool with release lifecycle (R1-2/R2-2/DH-2) | **Compliant.** `outBuffer` is caller-owned recycling (the sanctioned pattern); L22-1 adds safety without pool semantics; L19-2 documents why no internal pool is warranted. |
| Format validation belongs to libjxl | **Compliant.** All container checks here are JXTC *framing* (index math), not JXL bitstream sniffing; decode errors still surface via decoder error events. |
| No new tunables without benchmark evidence | **One flag to watch:** L3-2 (single-session two-emit) is explicitly benchmark-gated in its writeup; L13-1's `FRAME_YIELD_BUDGET_MS` ships opt-in with a fixed default, not a tunable surface. |

---

# Final Sweep — last speedups found

### S-1 [PERF — the big one left] Per-tile cache: the viewport key cannot serve panning; the tile grid can
**Issue:** The only cache today is keyed by the **exact viewport rect**. Pan by one pixel → new key → full re-decode of every tile, although up to ~95% of the tile set is unchanged. Viewport keys only ever hit on exact-repeat views (tab return, zoom toggle). The grid, by contrast, is stable: tiles are content-addressed by `(level, col, row)` regardless of viewport — this is what F7's `TileId`/`makeTileCacheKey` were built for, and nothing uses them.
**Fix:** Tile-granular caching inside the progressive loop, storing **full-tile** pixel buffers (not viewport-clipped — reusable by any future viewport):

```ts
// decode-level.ts — progressive branch (after L3-1 + L6-1 + L5-3 land)
const sourceId = source.contentId ?? getLevelId(source);
const lvl = source.levelIndex ?? 0;
const tKeys = tiles.map((t) => makeTileCacheKey(sourceId, tileIdOf(t, source.tileSize, lvl)));

// Phase 1 (DC) — serve final-quality from cache when available (best wins), else dc-quality, else decode
for (let i = 0; i < tiles.length; i++) {
  const cachedFinal = cache?.get(`${tKeys[i]}:qfinal`);
  if (cachedFinal) {
    stitchTileIntoViewport(target, vp, tiles[i], cachedFinal, source, plan.bpp);
    finalDone[i] = true;
    onTile?.(tiles[i], ++completed); onTile?.(tiles[i], ++completed); // both stages satisfied
    continue;
  }
  let dcPx = cache?.get(`${tKeys[i]}:qdc`);
  if (!dcPx) {
    dcPx = await decodeTileBytesProgressive(tileBytesList[i], plan.format, 'dc');
    cache?.set(`${tKeys[i]}:qdc`, dcPx);     // zero-copy insert: buffer is decoder-fresh, never mutated
  }
  stitchTileIntoViewport(target, vp, tiles[i], dcPx, source, plan.bpp);
  onTile?.(tiles[i], ++completed);
}
// Phase 2 (final) — skip finalDone[i]; after decode: cache?.set(`${tKeys[i]}:qfinal`, px) then stitch
```

**Numbers:** 512² rgba8 tile = 1 MiB; cache hit = one ≤1 MiB memcpy (~0.1 ms) vs a full tile decode (~10–50 ms) — two orders of magnitude on every overlapping tile of every pan. **Accounting rules:** (a) for tiled sources, stop writing the viewport-level key entirely — tile entries compose better and don't blow the LRU with multi-MB monoliths (keep viewport keys for `whole` sources via L2-4); (b) default 32 MiB cache ≈ 32 tiles ≈ 2–3 viewports of headroom — recommend a dedicated `createInMemoryPyramidCache({maxBytes: 128 << 20})` for viewer use; (c) tile buffers enter the cache by reference (decoder-fresh, this layer never mutates them) — zero insert cost; (d) this is what makes the L13-2 prefetch ring real: ring decodes at `dc-only` fill grid-stable keys the next pan actually hits. **Layer check:** content-keyed, no sourceKey duplication, no session knowledge — compliant (Lens 23).

### S-2 [PERF — micro] Fail-fast `outBuffer` validation before planning
With L5-1's `bpp` carried on `LevelSource`, the `need`-vs-`outBuffer` size/alignment checks can run **before** `prepareDecodePlan` for the common full-viewport case — note the subtlety that `need` must use the clamped viewport, so pre-plan validation may only *reject early* when `outBuffer < region-implied-need` AND the region is already in-bounds (`x≥0, y≥0, x+w≤source.width, y+h≤source.height` — four comparisons). Saves header-memo lookup + clamp + tile enumeration on the error path; zero cost on the happy path. Worth it only because viewers hit the error path during buffer-pool resizing races; skip if that's not observed.

### S-3 [PERF] Single-tile viewport fast path: skip target + stitch entirely
**Issue:** A viewport that exactly equals one full tile (common: thumbnails, fitted small images, aligned 512² pans) still pays `target` allocation + per-row stitch.
**Fix:** In the progressive branch, when `tiles.length === 1` and the tile rect equals both the full tile and the viewport (`t.x % tileSize === 0 && t.y % tileSize === 0 && t.w === fullW && t.h === fullH && t.w === vp.w && t.h === vp.h`) and no `outBuffer` was supplied: return the decoder's final buffer directly (`{ pixels: finalPx, width: vp.w, height: vp.h, format }`), with the DC emission still delivered via `onTile` after an in-place... — no: with no `outBuffer` there is nowhere persistent to stitch DC; deliver DC by returning early only for `dc-only` mode, and for `dc-then-final` keep DC in a transient buffer announced via `onTile`+`TileProgress.view` against that transient. Net effect: zero `target` allocation, zero stitch copies for the most common small-image case. (With an `outBuffer`, L7-3's future `decodeInto` is the equivalent win; until then outBuffer callers keep one stitch copy.)

### S-4 [PERF — measured-no] Sweep candidates examined and rejected, so they stay rejected
(a) Replacing `stitch`'s `set(subarray)` rows with manual byte loops — slower in V8 (memcpy intrinsic wins); (b) pooling tile pixel buffers — detach/ownership hazards for ~nothing (L19-2 census shows allocation isn't the bound); (c) caching `extractTileBitstream` results — they're zero-copy subarray views already, the "extraction" is 6 DataView reads; (d) `Promise.all` over both stages of one tile — stages are sequentially dependent by definition; (e) micro-batching `onTile` callbacks — they're already per-tile, and coalescing trades paint latency for nothing. Recorded per the repo's rejected-optimizations discipline so they aren't re-proposed.

---

## Cross-Reference: the three named optimizations

**F2 (harden outBuffer, in-place passes, no intermediate copies):** L5-2 (alignment), entry size checks (existing, kept), L10-R4 (output validation), L6-1/L6-2 (stitch bounds — the in-place writes are now provably in-bounds), L3-3 (drop the direct-path intermediate copy), L7-3 + L17-1 (the zero-copy endgame), L13-3 (the ownership contract, documented).

**F6 (first-class format token, monotone flow):** L1-2 (single derivation, `decodeWhole` consumes the token), L5-1 (`bpp` carried), L5-5 (token on the result), L2-3 (mode/format unions referenced not inlined), L14-1/L17-4 (consumers that justify it).

**F7 (stable TileId + tileKey unification):** L5-3 (`tileIdOf` — the missing producer), L5-4 (packed key for hot maps), L1-3 (key builder unification), L8-4 (TileProgress: progress+telemetry+identity in one), L4-4 (abort/resume on tile keys), L11-1 (cross-level algebra), L12-2 (content-stable ids).

## Suggested implementation order

1. **P0 correctness:** L7-1, L6-1 (+ test L8-5.1) — progressive mode currently cannot work on real containers.
2. **P1 bugs:** L21-1 (fractional regions), L19-1 (oversized-buffer cache poisoning), L4-1, L4-2, L10-R1, L2-1, L18-1/L18-2 (+ tests L8-5.2/3/4/6/9/10/12).
3. **P1 performance:** L3-1 (pure reorder), L3-3, **S-1 (per-tile cache — largest remaining win)**, S-3; then L3-2 behind a benchmark.
4. **F2/F6/F7 batch:** L5-1..L5-7, L1-2, L1-3, L10-R4, L6-2, L8-1..L8-4, L22-1 (+ test L8-5.11).
5. **Resilience:** L20-1 (skip-tile policy), L20-2 (budgetMs), L20-3 docs.
6. **Features as pulled by roadmap:** L3-4, L10-R3/L11-3, L4-4, L13-1, L16-1, L17-1..L17-3, L12-2/L12-3, L14-1/L14-2, S-2 (only if buffer-resize races observed).
