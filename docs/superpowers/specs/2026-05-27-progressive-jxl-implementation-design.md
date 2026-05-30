# Progressive JXL Streaming — Implementation Design

**Date:** 2026-05-27  
**Status:** Approved  
**Source spec:** `docs/Progressive JXL Encoding Final.md`  
**Scope:** All 6 phases — manifest, profiling, streaming, gallery scheduler, saliency, hardening.

---

## Decisions

| Question | Decision |
|----------|----------|
| Phase scope | All 6 phases |
| Package location | New `packages/jxl-progressive/` |
| Profile runtime | Node (offline build) + browser fallback |
| Gallery scheduler relation to jxl-scheduler | Separate layer; calls `DecodeSession` via `jxl-session`; does not modify jxl-scheduler |

---

## Layer Map

```
Web UI / gallery page
  └─ progressive-scheduler.ts   ← gallery: IntersectionObserver + weighted round-robin
       ├─ progressive-stream.ts ← fetch tier byte range → DecodeSession → frames
       │    └─ jxl-stream.fromRangePrefix + jxl-session.DecodeSession
       ├─ progressive-manifest.ts ← schema v1, validate, tier lookup, hash check
       ├─ progressive-cache.ts    ← manifests + byte ranges + bitmaps → jxl-cache
       └─ saliency-policy.ts      ← encode-time: confidence rules, coord normalisation

progressive-profile.ts           ← build step / browser fallback
  └─ jxl-session.DecodeSession
```

The existing `jxl-scheduler` (worker pool, preemption, dedupe) is **untouched**. `progressive-scheduler` is a gallery-orchestration layer above it.

---

## Package: `packages/jxl-progressive/`

### Dependencies

```json
{
  "dependencies": {
    "@casabio/jxl-core": "workspace:*",
    "@casabio/jxl-session": "workspace:*",
    "@casabio/jxl-stream": "workspace:*",
    "@casabio/jxl-cache": "workspace:*"
  }
}
```

No dependency on `jxl-scheduler` or `jxl-wasm` directly.

### Internal types file: `src/types.ts`

Shared types exported from this file (imported by multiple modules):

- `SessionFactory = () => DecodeSession` — used by both `progressive-profile.ts` and `progressive-scheduler.ts`
- Re-exports `TierName`, `ManifestTier`, `ProgressiveManifest` from `progressive-manifest.ts` for convenience

---

## Module Specifications

### `progressive-manifest.ts`

**Responsible for:** Manifest schema (TypeScript types), validation, tier lookup, hash validation, version migration.

**Types:**

```ts
export type TierName = 'dc' | 'preview' | 'full';

export interface ManifestTier {
  name: TierName;
  byteStart: number;
  byteEnd: number;
  progressionIndex: number | 'final';
  intendedUse: string;
}

export interface ProgressiveManifest {
  version: 1;
  source: {
    width: number;
    height: number;
    hasAlpha: boolean;
    orientation: number;
  };
  jxl: {
    bytes: number;
    sha256: string;
  };
  encoder: {
    name: string;
    libjxlVersion: string;
    flags: string[];
  };
  saliency?: {
    enabled: boolean;
    centerX: number;   // normalised 0–1
    centerY: number;   // normalised 0–1
    confidence: number;
    method: string;
  };
  tiers: ManifestTier[];
}
```

**Functions:**

- `validateManifest(json: unknown): ProgressiveManifest` — throws `ManifestValidationError` on schema failure
- `lookupTier(manifest: ProgressiveManifest, name: TierName): ManifestTier | undefined`
- `checkHash(manifest: ProgressiveManifest, jxlBytes: ArrayBuffer): Promise<boolean>` — SHA-256 via SubtleCrypto / Node crypto
- `migrateManifest(json: unknown): ProgressiveManifest` — stub; throws if version > 1

**Error types:**

- `ManifestValidationError extends Error` — carries `field: string`
- `ManifestStaleError extends Error` — hash mismatch

---

### `progressive-profile.ts`

**Responsible for:** Dry-run decode, recording progression byte offsets, selecting tier boundaries, returning a `ProgressiveManifest`.

**Key behaviour:**

1. Accepts pre-loaded `jxlBytes: ArrayBuffer` — works in both Node and browser (no I/O).
2. Creates a throw-away `DecodeSession` via the provided `sessionFactory`.
3. Feeds bytes in increments of `chunkSize` (default 16 KiB).
4. On each `frame` event from the session, records `{ byteOffset, progressionIndex, stage }`.
5. After all bytes fed, selects tier boundaries:
   - `dc` tier: first progression event where `stage === 'dc'` or first event at < 25% of file
   - `preview` tier: last progression event before 70% of file, or event closest to 50%
   - `full` tier: always `byteEnd = jxlBytes.byteLength`
6. Computes SHA-256 of `jxlBytes`.
7. Returns a `ProgressiveManifest`.

**Signature:**

```ts
export interface ProfileOptions {
  chunkSize?: number;           // default 16384
  encoderName?: string;         // default 'unknown'
  libjxlVersion?: string;       // default 'unknown'
  encoderFlags?: string[];
  saliency?: ProgressiveManifest['saliency'];
  onProgress?: (byteOffset: number, total: number) => void;
  signal?: AbortSignal;
}

// SessionFactory defined in src/types.ts; imported here.

export async function profileJxl(
  jxlBytes: ArrayBuffer,
  sessionFactory: SessionFactory,
  source: { width: number; height: number; hasAlpha: boolean; orientation?: number },
  opts?: ProfileOptions,
): Promise<ProgressiveManifest>
```

**Node helper:** `profileJxlFile(path, sessionFactory, source, opts)` — reads file, calls `profileJxl`, optionally writes `${path}.json`.

**Browser fallback trigger:** If manifest fetch 404s and `AutoProfileOptions.enabled` is set, `progressive-stream.ts` calls `profileJxl` with the full fetched bytes and stores result via `progressive-cache.ts`.

---

### `progressive-stream.ts`

**Responsible for:** Fetching a tier byte range and piping it into a `DecodeSession`; emitting progression frames.

**Functions:**

```ts
export interface TierFetchOptions {
  headers?: HeadersInit;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onRangeNegotiated?: (info: RangeNegotiation) => void;
}

// Fetch byteStart..byteEnd of url and push into session.
// Calls session.close() on completion.
export async function fetchTier(
  url: string,
  tier: ManifestTier,
  session: DecodeSession,
  opts?: TierFetchOptions,
): Promise<void>

// Async iterator of frames from an active DecodeSession.
// Yields every DecodeFrameEvent until session completes or is cancelled.
export async function* streamTierFrames(
  session: DecodeSession,
): AsyncGenerator<DecodeFrameEvent>
```

**Byte range semantics:**

- `tier.byteStart === 0` always (spec: all tiers start from byte 0).
- `fetchTier` calls `fromRangePrefix(url, tier.byteEnd, session, opts)`.
- No `byteStart > 0` range splicing in v1 — each tier is cumulative from byte 0.

**Fallback (no manifest):**

```ts
export async function fetchFull(
  url: string,
  session: DecodeSession,
  opts?: TierFetchOptions,
): Promise<void>
```

---

### `progressive-scheduler.ts`

**Responsible for:** Gallery-level orchestration — IntersectionObserver, job queue, weighted round-robin, priority boosts, concurrency limits.

**Core types:**

```ts
export type Tier = 'none' | 'dc' | 'preview' | 'full';

export interface ProgressiveImageJob {
  id: string;
  element: Element;
  manifestUrl: string;
  jxlUrl: string;
  visible: boolean;
  nearViewport: boolean;
  selected: boolean;
  currentTier: Tier;
  targetTier: Tier;
  priority: number;         // 1–7 per spec priority table
  lastServedAt: number;     // performance.now()
  bytesLoaded: number;
  manifest: ProgressiveManifest | null;
  decoderAbort: AbortController | null;
}

export interface GalleryOptions {
  maxActiveDecoders?: number;    // default 4
  maxConcurrentFetches?: number; // default 3
  maxQueuedJobs?: number;        // default 50
  rootMargin?: string;           // IntersectionObserver margin, default '200px'
  onFrame?: (id: string, frame: DecodeFrameEvent) => void;
  onTier?: (id: string, tier: Tier) => void;
  onError?: (id: string, err: Error) => void;
  manifestSuffix?: string;       // appended to jxlUrl to derive manifestUrl, default '.json'
  autoProfile?: boolean;         // run profiling if manifest missing, default true
}
```

**Class: `ProgressiveGallery`**

```ts
export class ProgressiveGallery {
  constructor(cache: ProgressiveCache, sessionFactory: SessionFactory, opts?: GalleryOptions)

  // Register an image element. id must be unique.
  observe(element: Element, id: string, jxlUrl: string): void

  // Unregister. Cancels active decode, releases decoder.
  unobserve(id: string): void

  // Boost priority to level 1 (lightbox/selected).
  select(id: string): void

  // Remove selection boost.
  deselect(id: string): void

  // Set target tier for an image. Scheduler will advance to it.
  setTargetTier(id: string, tier: Tier): void

  // Tear down: cancel all active decodes, disconnect IntersectionObserver.
  destroy(): void
}
```

**Scheduler tick (runs in rAF loop):**

1. Filter jobs: `visible || nearViewport || selected`.
2. Filter: `tierRank(currentTier) < tierRank(targetTier)`.
3. Sort by `fairnessScore = priority + starvationBonus + underRefinedBonus`.
4. Pick top job not already actively decoding.
5. If `activeDecoders < maxActiveDecoders`: start tier fetch → push to DecodeSession → on frames, call `onFrame`.
6. On tier complete: advance `currentTier`, call `onTier`, re-queue for next tier if needed.

**Priority table (from spec):**

| Condition | Priority |
|-----------|----------|
| Selected / lightbox | 1 |
| Under pointer / focused | 2 |
| Fully visible | 3 |
| Partially visible | 4 |
| Near viewport | 5 |
| Recently visible | 6 |
| Offscreen | 7 |

**Viewport exit policy:** when image leaves viewport, if `memory pressure low` → keep decoder warm for `graceMs` (default 2000ms); else cancel decoder, retain cached bytes.

---

### `progressive-cache.ts`

**Responsible for:** Manifest cache, byte-range cache, decoded bitmap cache; hash-based invalidation; delegates persistence to `jxl-cache`.

**Class: `ProgressiveCache`**

```ts
export interface ProgressiveCacheOptions {
  manifestTtlMs?: number;       // default 3_600_000 (1 hour)
  bitmapMaxBytes?: number;      // default 64 MiB
  byteRangeMaxBytes?: number;   // default 256 MiB
}

export class ProgressiveCache {
  // inner is JxlCacheBrowser (the actual exported class from @casabio/jxl-cache).
  // Manifests serialised as UTF-8 JSON ArrayBuffer; bitmaps stored as RGBA8 ArrayBuffer.
  constructor(inner: JxlCacheBrowser, opts?: ProgressiveCacheOptions)

  // Manifests — keyed by jxlUrl
  getManifest(jxlUrl: string): Promise<ProgressiveManifest | null>
  setManifest(jxlUrl: string, manifest: ProgressiveManifest): Promise<void>
  invalidateManifest(jxlUrl: string): Promise<void>

  // Byte ranges — keyed by `${jxlUrl}#${tierName}`
  getByteRange(jxlUrl: string, tier: TierName): Promise<ArrayBuffer | null>
  setByteRange(jxlUrl: string, tier: TierName, bytes: ArrayBuffer): Promise<void>

  // Decoded bitmaps — keyed by `${jxlUrl}#${tierName}`
  getBitmap(jxlUrl: string, tier: TierName): Promise<ImageBitmap | null>
  setBitmap(jxlUrl: string, tier: TierName, bitmap: ImageBitmap): Promise<void>
  evictBitmaps(exceptIds?: string[]): Promise<void>

  // Invalidate everything for a URL (hash mismatch)
  invalidate(jxlUrl: string): Promise<void>
}
```

**Eviction order (on memory pressure):**

1. Bitmaps for far-offscreen images first.
2. Byte ranges for far-offscreen images.
3. Near-viewport bitmaps.
4. Never evict selected/lightbox entries.

---

### `saliency-policy.ts`

**Responsible for:** Deciding whether to use attention-centre saliency for an encode; normalising coordinates; selecting best centre from multiple candidates.

**Image type enum:**

```ts
export type ImageType =
  | 'portrait' | 'product' | 'macro'    // saliency beneficial
  | 'landscape' | 'habitat'             // saliency neutral/weak
  | 'map' | 'plate' | 'herbarium' | 'microscopy' | 'diagnostic'; // saliency disabled
```

**Functions:**

```ts
// Returns true if saliency encoding is appropriate.
export function shouldUseSaliency(opts: {
  imageType: ImageType;
  confidence: number;       // 0–1
  centerCount: number;      // number of detected attention centres
  confidenceThreshold?: number; // default 0.6
}): boolean

// Normalise pixel coordinates to 0–1 range.
export function normaliseCenter(
  cx: number, cy: number,
  imageWidth: number, imageHeight: number,
): { x: number; y: number }

// From multiple attention centres, pick the best single centre.
// Returns null if no centre is suitable (low confidence, distributed attention).
export function selectBestCenter(
  centers: Array<{ x: number; y: number; confidence: number }>,
  opts?: { threshold?: number },
): { x: number; y: number; confidence: number } | null
```

**Policy rules (from spec):**

- Types `map | plate | herbarium | microscopy | diagnostic` → always `false`, ignore confidence.
- `confidence < threshold (default 0.6)` → `false`.
- `centerCount > 1` and toolchain only supports one centre → choose best or return `false` based on confidence gap.
- Otherwise → `true`.

---

## Tests

### Unit

| File | Coverage |
|------|----------|
| `test/manifest.test.ts` | Schema validation, hash mismatch detection, tier lookup, stale manifest error, migration stub |
| `test/scheduler.test.ts` | `fairnessScore` calculation, round-robin ordering, priority table, starvation bonus, concurrency cap |
| `test/saliency.test.ts` | Each `ImageType` rule, confidence threshold, multi-centre selection, coordinate normalisation |
| `test/cache.test.ts` | Get/set manifest, byte range, bitmap; invalidation; eviction order |

### Integration

| File | Coverage |
|------|----------|
| `test/stream.test.ts` | Mock `DecodeSession`; tier fetch with mock fetch; cancellation; missing manifest fallback |
| `test/profile.test.ts` | Feed real (or synthetic) JXL bytes; verify manifest emitted with ≥1 tier boundary; hash matches |

---

## Demo Page

`web/jxl-progressive-gallery.html` + `web/jxl-progressive-gallery.js`:

- Grid of 12 thumbnail slots.
- Loads manifest JSON per slot; falls back to profiling if missing.
- `ProgressiveGallery` observes each `<img>`-equivalent `<canvas>`.
- Shows per-slot tier badge (none / dc / preview / full).
- Scheduler controls: pause, resume, select image (lightbox).
- Network throttle toggle (simulated via `fetchImpl` wrapper).

---

## Invariants (not to violate)

From `CLAUDE.md`:

- Backpressure remains at scheduler/worker boundary — not in `progressive-stream.ts`.
- Deduplication remains in `jxl-scheduler.DedupeRegistry` — `progressive-cache` does not deduplicate by `sourceKey`.
- Budget is session-level — no per-stage reset in `progressive-stream.ts`.
- No pixel buffer pool for output (transferred ArrayBuffers detach).

---

## Open Questions (deferred)

- Exact `cjxl` flags for saliency (`--center_x`, `--group_order`) need validation against pinned libjxl version before encoding integration.
- Node `profileJxlFile` requires a Node-compatible `DecodeSession` factory — depends on `jxl-worker-node` being wired up.
- `ImageType` classification (auto-detect vs caller-supplied) is out of scope for v1; caller supplies type.
