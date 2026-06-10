# Manifest & Cache Implementation Plan

**Scope:** `packages/jxl-pyramid/src/cache.ts` (95 lines) and `packages/jxl-pyramid/src/manifest.ts` (72 lines).
**Source:** 19-lens review (strategic, API, pipeline, state, data structures, hot kernels, boundaries, support, owl, reversal, astronomy, ML, gaming, photogrammetry, butteraugli, AR, perceptual color, gaps, birds-eye). Duplicates amalgamated below.
**Execution model:** Grok agents, **one file per agent**. Sessions may exceed 5; same-file agents run sequentially in the listed order.

---

## Consolidated Findings

### cache.ts

| ID | Severity | Finding |
|----|----------|---------|
| C1 | **P0 bug** | Oversized `set` (value.length > maxBytes) evicts *every* existing entry, then evicts the new entry itself — one oversized insert wipes the whole cache. Needs an early-return guard. |
| C2 | **P0 bug-hardening** | Byte accounting breaks if a cached `Uint8Array`'s buffer is later detached (e.g. transferred via `postMessage`): `v.length` becomes 0, so eviction/delete subtracts 0 while `bytes` still counts the original size → phantom bytes → cache permanently believes it is full and thrashes. Store the length at insert time and use it for all accounting; treat a length mismatch on `get` as a miss. |
| C3 | P1 docs | Cache stores by reference (no defensive copy). A view over the WASM heap can be silently invalidated by `memory.grow` or the next decode. Document the contract on `PyramidCache`: *callers must `slice()` WASM-heap views before `set`; never transfer a cached buffer.* |
| C4 | P1 feature | No telemetry. Add hit/miss/eviction counters and a `bytesUsed` getter — needed to tune the arbitrary 32 MiB default and to feed the metrics collector. |
| C5 | P2 feature | `setMaxBytes(n)` runtime resize with immediate evict-to-fit (AR / memory-pressure / device-thermal shrink). |
| C6 | P1 strategic | `getLevelId` is identity-based (WeakMap + counter): a re-fetch of the same level bytes yields a new array → new ID → cold cache. The manifest already carries a stable `contenthash` per level. Add `makeLevelCacheKey(contenthash, …)` and document identity IDs as fallback-only. Make `contenthash` the universal cache currency (levels, tiles via `makeTileCacheKey(contenthash, tile)`, LUT sidecars, embedding blobs). Note: `instanceof Uint8Array` is realm-local — document the caveat, no fix needed. |
| C7 | P2 feature | Optional `onEvict(key, value)` callback in factory opts — enables L2 write-back tiering to `jxl-cache` (OPFS) at the call site without changing this sync interface. Persistence stays beside the pipeline per layer rules. |
| C8 | P2 feature | `touch(key)`: recency bump without read — lets prefetch heuristics (pan-vector tile prefetch, gaming-style texture streaming) protect tiles from eviction. Skip `pin/unpin` for now (complexity without demonstrated need). |
| C9 | P1 tests | No unit tests. Cover: LRU eviction order, oversized set (post-C1), accounting after delete/clear/replace, detach resilience (post-C2), `getLevelId` B/L distinctness and stability. |
| C10 | Deferred | SIEVE/CLOCK eviction would remove the delete+set write on every hit, but per repo rules adaptive changes require benchmark data. **Do not implement** without a measured hot-path profile. |

### manifest.ts

| ID | Severity | Finding |
|----|----------|---------|
| M1 | **P0 schema bug** | Comment admits `convergedByteEnd` lives "on levels too in some" but `PyramidLevel` lacks the field. Per-level early-abort is the whole point of the feature. Add `convergedByteEnd?: number` to `PyramidLevel`; keep the manifest-level field as whole-file fallback; delete the vague comment. |
| M2 | **P0 type hole** | `producedBy?: any` defeats type checking. Type it: `{ tool: string; version: string; params?: Record<string, unknown> }`. |
| M3 | P1 feature | No runtime validation anywhere — manifests are `JSON.parse`d and cast blindly. Add `parsePyramidManifest(json: unknown)` / `parseGalleryIndex(json: unknown)` in a **new file** `manifest-validate.ts` (keeps manifest.ts types-only): accept schema 1\|2 (normalize 1→2 defaults), reject schema > 2 with a clear error, check required fields, aspect ≈ width/height, levels ascending with last `"full"`, non-empty contenthash. Export `MANIFEST_SCHEMA_VERSION = 2`, `INDEX_SCHEMA_VERSION = 1`. Hand-rolled — no zod dependency. |
| M4 | P1 feature | `tiled: boolean` is insufficient for the in-flight tiling work (`tiling.ts`, `docs/PlanTilingGridImplementationPlan.md`): clients cannot compute tile addressing without a grid descriptor. Add `tiling?: { tileSize: number; cols: number; rows: number }` on `PyramidLevel`, required-when-`tiled` enforced by the M3 validator. **Coordinate field names with the tiling grid plan before implementing.** |
| M5 | P2 feature | `LevelZeroSeed` lacks `bytes` (prefetch sizing/progress) and the index has no instant placeholder. Add `bytes?: number` to `LevelZeroSeed` and `thumbhash?: string` (~28-byte hash) to `GalleryIndexEntry` — instant gallery skeletons and AR overlay anchoring before any JXL bytes arrive. |
| M6 | P2 robustness | `MasterMetadata.mtimeMs` alone is a weak staleness signal. Add `sizeBytes?: number`. |
| M7 | P2 additive schema extensions (types-only, all optional, zero runtime cost; gate each on actual producer support) | • `color?: { space?: "srgb" \| "display-p3" \| (string & {}); iccHash?: string; lutHash?: string }` on `PyramidManifest` — content-addressed LUT sidecars for the Perceptual Constancy Mode engine (the existing `PyramidCache` already stores them as opaque `Uint8Array`, no cache change needed). • `recognition?: { embeddings?: Array<{ model: string; dim: number; hash: string }>; labels?: Array<{ taxon: string; confidence: number; source: string }> }` — ML/species-ID sidecars, Darwin-Core-friendly. • `group?: string` on `GalleryIndexEntry` — specimen/occurrence grouping for multi-view photogrammetry sets. • `qualityCurve?: Array<[bytes: number, distance: number]>` on `PyramidLevel` — sampled butteraugli curve computed once at ingest so clients/agents pick their own bytes↔quality cutoff without ever re-running butteraugli client-side. |
| M8 | P1 docs | Document `convergedByteEnd` semantics in-source: *viewer-only download optimization; photogrammetry/archival consumers must ignore it and fetch full level bytes* (a digital-twin reconstruction from visually-saturated truncation would silently degrade geometry). |
| M9 | P3 feature | `GalleryIndex` is a flat array — at 10k+ images index.json hits ~1 MB. Add optional `next?: string` pagination cursor for sharded indexes. Low priority. |
| M10 | P1 tests | Validator fixtures: schema 0/1/2/3, missing fields, bad aspect, non-ascending levels, tiled-without-tiling-descriptor. |

### Cross-cutting (document in both files' JSDoc; no code)

- **contenthash is the universal currency** — cache keys, LUT sidecars, embeddings, l0 seeds all address by it (birds-eye finding; everything above flows from this).
- **Single-owner rule:** `levelIdCounter`/WeakMaps are module-global *per realm*. If tiles decode in workers, the cache and its IDs live on exactly one thread (main). Document it.
- **L1/L2 layering:** `PyramidCache` is the intentionally-sync in-memory L1; OPFS persistence is `jxl-cache` beside the pipeline. Do not make this interface async; tier at the call site via C7's `onEvict`.

---

## Agent Handoffs

> Each agent touches exactly one file. G1→G2→G3 sequential; G4→G5/G6 sequential; the two tracks are independent and may run in parallel.

### Agent G1 — `cache.ts`: correctness (C1, C2, C3)

Replace the raw `Map<string, Uint8Array>` with length-snapshotted entries:

```ts
interface CacheEntry { v: Uint8Array; len: number }

class InMemoryPyramidCache implements PyramidCache {
  private readonly map = new Map<string, CacheEntry>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(key: string): Uint8Array | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.v.length !== e.len) {        // buffer was detached → treat as miss
      this.bytes -= e.len;
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);              // LRU bump
    this.map.set(key, e);
    return e.v;
  }

  set(key: string, value: Uint8Array): void {
    if (value.length > this.maxBytes) { this.delete(key); return; }  // C1: never wipe cache for one oversized entry
    const old = this.map.get(key);
    if (old) { this.bytes -= old.len; this.map.delete(key); }
    this.map.set(key, { v: value, len: value.length });
    this.bytes += value.length;
    while (this.bytes > this.maxBytes && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value as string;
      const oldest = this.map.get(oldestKey)!;
      this.bytes -= oldest.len;        // C2: snapshot length, immune to detach
      this.map.delete(oldestKey);
    }
  }
  // delete()/clear(): subtract e.len, not v.length
}
```

Add JSDoc on `PyramidCache` (C3): by-reference storage; callers must `slice()` WASM-heap views before `set`; never transfer a cached buffer's `ArrayBuffer`; single-owner (one thread/realm).

**Acceptance:** oversized `set` leaves existing entries untouched; detaching a cached buffer never corrupts `bytes`; existing callers compile unchanged (public API identical).

### Agent G2 — `cache.ts`: API additions (C4, C5, C6, C7, C8)

Run after G1 merges. All additive; `PyramidCache` interface gains optional members only.

```ts
export interface PyramidCacheStats { hits: number; misses: number; evictions: number; bytesUsed: number; entryCount: number }

export interface PyramidCache {
  get(key: string): Uint8Array | undefined;
  set(key: string, value: Uint8Array): void;
  has(key: string): boolean;
  delete(key: string): void;
  clear(): void;
  stats?(): PyramidCacheStats;        // C4
  setMaxBytes?(maxBytes: number): void; // C5: evict-to-fit immediately
  touch?(key: string): boolean;       // C8: recency bump, no read; false if absent
}

export function createInMemoryPyramidCache(opts: {
  maxBytes?: number;
  onEvict?: (key: string, value: Uint8Array) => void; // C7: capacity evictions only — NOT delete()/clear()
} = {}): PyramidCache { … }

/** C6: preferred stable key — manifest contenthash, not ephemeral identity IDs. */
export function makeLevelCacheKey(contenthash: string): string {
  return `ch:${contenthash}`;
}
```

`maxBytes` clamps to `>= 0` in the factory. Document on `getLevelId`: identity-based fallback for sources without a contenthash; `instanceof Uint8Array` is realm-local. **Do not** implement SIEVE/CLOCK (C10) — benchmark-gated per repo rules.

**Acceptance:** stats counters move on hit/miss/evict; `setMaxBytes(0)` empties the cache via `onEvict`-visible evictions; `touch` on a missing key returns false and allocates nothing.

### Agent G3 — `test/cache.test.ts` (new file): C9

Cover, against the post-G2 build: LRU eviction order (oldest-first); recency bump via `get` and via `touch`; oversized `set` no-wipe; accounting exactness after replace/delete/clear (assert `stats().bytesUsed`); detach simulation (`structuredClone(buf, { transfer })` or worker round-trip) → `get` misses, bytes stay consistent; `getLevelId` returns distinct `B*`/`L*` ids, stable per object, fresh per new object; `onEvict` fires for capacity evictions only; `setMaxBytes` shrink evicts to fit.

### Agent G4 — `manifest.ts`: schema corrections (M1, M2, M4, M5, M6, M8)

```ts
export interface PyramidLevel {
  size: LevelSize;
  w: number;
  h: number;
  bytes: number;
  bitsPerSample: BitsPerSample;
  contenthash: string;
  tiled: boolean;
  /** Required when tiled. Grid descriptor so clients address tiles without decoding. (M4 — names per PlanTilingGridImplementationPlan.md) */
  tiling?: { tileSize: number; cols: number; rows: number };
  /**
   * Byte offset of visual saturation for this level (precomputed butteraugli cutoff).
   * Viewer-only download optimization: progressive viewers may abort the fetch here.
   * Photogrammetry / archival / ML consumers MUST ignore it and fetch all `bytes`. (M1, M8)
   */
  convergedByteEnd?: number;
}

export interface ProducedBy { tool: string; version: string; params?: Record<string, unknown> } // M2

export interface MasterMetadata {
  name: string;
  format: MasterFormat;
  mtimeMs: number;
  sizeBytes?: number; // M6: pair with mtimeMs for staleness checks
}

export interface LevelZeroSeed { contenthash: string; w: number; h: number; bytes?: number } // M5

export interface GalleryIndexEntry {
  imageId: string;
  aspect: number;
  l0: LevelZeroSeed;
  thumbhash?: string; // M5: ~28-byte placeholder; instant skeleton / AR anchor
}
```

In `PyramidManifest`: `producedBy?: ProducedBy` replaces `any`; `convergedByteEnd?: number` stays as whole-file fallback with the M8 comment; the `// on levels too in some` comment is deleted. All changes additive → still schema 2, no version bump.

**Acceptance:** `tsc` clean across the package; no `any` remains; every new field optional.

### Agent G5 — `src/manifest-validate.ts` (new file): M3 + M10

Runtime validation, hand-rolled, types-only import from `./manifest.js`:

```ts
export const MANIFEST_SCHEMA_VERSION = 2;
export const INDEX_SCHEMA_VERSION = 1;

export class ManifestValidationError extends Error {
  constructor(message: string, public readonly path: string) { super(`${path}: ${message}`); }
}

/** Accepts schema 1|2 (normalizes 1 → 2 defaults: stub=false, proxy=false). Throws on schema > 2. */
export function parsePyramidManifest(json: unknown): PyramidManifest { … }
export function parseGalleryIndex(json: unknown): GalleryIndex { … }
```

Checks: required fields with typeof guards; `schema > MANIFEST_SCHEMA_VERSION` → explicit "newer than reader" error; `Math.abs(aspect - width / height) < 1e-3`; numeric level sizes strictly ascending with `"full"` last; non-empty `contenthash`; `tiled === true` requires `tiling` (post-G4); `convergedByteEnd <= bytes` when both present. Second session: `test/manifest-validate.test.ts` with M10 fixtures (schema 0/1/2/3, missing fields, bad aspect, non-ascending levels, tiled-without-descriptor, convergedByteEnd > bytes).

**Acceptance:** schema-1 fixture normalizes losslessly; schema-3 fixture throws `ManifestValidationError` naming the path; all fixtures pass.

### Agent G6 — `manifest.ts`: optional extension blocks (M7, M9) — runs after G4

Additive optional types only; no validator changes beyond shape checks; each block lands only when its producer exists:

```ts
/** Content-addressed color sidecars for Perceptual Constancy Mode (LUT blobs cacheable in PyramidCache as opaque bytes). */
export interface ColorInfo { space?: "srgb" | "display-p3" | (string & {}); iccHash?: string; lutHash?: string }

/** ML sidecars: embeddings + taxon labels (Darwin-Core-friendly). */
export interface RecognitionInfo {
  embeddings?: Array<{ model: string; dim: number; hash: string }>;
  labels?: Array<{ taxon: string; confidence: number; source: string }>;
}

// PyramidManifest += color?: ColorInfo; recognition?: RecognitionInfo;
// PyramidLevel   += qualityCurve?: Array<[bytes: number, distance: number]>;  // sampled butteraugli, ingest-computed
// GalleryIndexEntry += group?: string;   // specimen/occurrence id for multi-view photogrammetry sets
// GalleryIndex   += next?: string;       // M9 pagination cursor (sharded index), low priority
```

**Acceptance:** `tsc` clean; existing manifests still parse; no required fields added.

### Sequencing

| Order | Track A (cache) | Track B (manifest) |
|-------|-----------------|--------------------|
| 1 | G1 correctness | G4 schema corrections |
| 2 | G2 API additions | G5 validator (+ test session) |
| 3 | G3 tests | G6 extensions |

---

## Overview

Implementing this plan converts the two quietest files in jxl-pyramid from "works on the happy path" to load-bearing infrastructure. The cache work (G1–G3) removes two real failure modes — a single oversized insert silently wiping every cached tile, and detached-buffer accounting drift that leaves the cache permanently thrashing — and then makes the cache observable and adjustable: hit/miss/eviction stats to justify or retune the 32 MiB default with data, runtime resizing for memory-pressured AR sessions, an eviction hook that enables OPFS write-back tiering without violating the sync-L1/async-L2 layer boundary, and `touch` for gaming-style prefetch protection during panning.

The manifest work (G4–G6) closes the gap between the design and the types: `convergedByteEnd` finally lands where it operates (per level), the tiling grid descriptor lets clients address tiles without decoding — directly unblocking the in-flight tiling effort — and a small hand-rolled validator means a malformed or future-versioned manifest fails loudly at parse time instead of as undefined behavior deep in the decode path. The optional extension blocks then make the manifest the single content-addressed index for everything downstream the project cares about: precomputed butteraugli quality curves so no client ever re-runs the slowest operation in the pipeline, LUT sidecars for the perceptual color engine, embedding and taxon-label sidecars for species recognition, thumbhash placeholders for instant gallery and AR rendering, and specimen grouping for photogrammetry multi-view sets.

The unifying move, surfaced by nearly every lens, is making `contenthash` the universal currency between the two files: manifests declare content-addressed artifacts, and the cache stores any of them — tiles, levels, LUTs, embeddings — under stable content keys instead of ephemeral identity IDs. That single convention is what lets one small sync cache and one types-only schema file serve the viewer, the offline field kit, the ML pipeline, and the digital-twin reconstruction path without growing layer violations.
