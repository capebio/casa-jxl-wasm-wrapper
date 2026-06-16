# HANDOFF — jxl-cache 22-Lens Review: `lru.ts` / `browser.ts` / `node.ts`

Date: 2026-06-11. Files reviewed: `packages/jxl-cache/src/lru.ts`, `packages/jxl-cache/src/browser.ts`, `packages/jxl-cache/src/node.ts`.

## Guardrails — already-rejected ideas. Do NOT re-propose

From `docs/rejected optimizations.md` (§ jxl-cache): **Cache-9** OPFS sync access handles (dedicated-worker only); **G2-1** dedupe-aware caching (scheduler's job); **G2-2** memory-pressure eviction (non-standard API); **G2-3** concurrent-set coalescing (last caller must win); **G2-5** getStream() helper; **G2-6** write retry loop; **G2-7** cache-aware DecodeSession wrapper; **G2-9** cached-buffer content validation (cache is content-agnostic; libjxl validates). Layer invariants: no sourceKey storage, no session-protocol knowledge, no magic-byte checks.

Nothing below violates these. Where a finding is adjacent to a rejection, the distinction is stated inline.

## Strategic view (Lens 1/22)

`lru.ts` is a size-budgeted Map-order LRU used twice by `browser.ts`: once holding real `ArrayBuffer`s (memory tier), once holding `{name}` stubs mirroring OPFS files (persistent tier), with a JSON manifest persisting LRU order across sessions. `node.ts` is a stunted sibling: memory tier only, plus unbounded, unsanitized, non-atomic flat-file persistence — it ignores `persistentLimit` entirely. The dominant systemic risks are (a) divergence between the persistent tracker and what is actually on disk (crash windows, races with `clear()`), and (b) node.ts being ~3 years of hardening behind browser.ts while sharing the same public contract via `createJxlCache()`.

---

## Findings

### lru.ts

**L1 (P1, bug — stale entry survives oversize re-set).** `set()` returns early when `size > maxSize` *before* removing an existing entry under the same key. Re-setting a key with a larger-than-budget buffer leaves the **old** value live → `get(key)` serves stale data while the caller believes it stored the new one. Fix — move the same-key removal above the early return:

```ts
set(key: string, value: V, size: number): void {
  if (this.cache.has(key)) {
    this.currentSize -= this.cache.get(key)!.size;
    this.cache.delete(key);
  }
  if (size > this.maxSize) return; // moved below removal
  ...
}
```

**L2 (P2, perf — MRU fast path).** `get()` always does `delete`+`set` to re-order, even when the key is already most-recent (common: repeated tile access in paint loops). Track `private mruKey: string | undefined`; on `get`, if `key === this.mruKey` skip the two Map ops; update `mruKey` at the end of `set()` and on promoting `get()`; clear it in `delete()`/`clear()` when it matches. Pure win, no semantic change.

**L3 (P3, hardening).** `set()` trusts `size`. A `NaN`/negative size permanently corrupts `currentSize` (eviction storms or unbounded growth). Guard: `if (!(size >= 0) || !Number.isFinite(size)) return;` — matches the existing silent-drop style.

**L4 (P3, API).** Add `has(key): boolean` (plain `this.cache.has(key)`, no promotion) and `setMaxSize(n: number)` (update `maxSize`, then evict-oldest until `currentSize <= maxSize`). `setMaxSize` enables B16's init-time quota sizing; `has` backs B12/N7.

### browser.ts

**B1 (P1, bug — stale persistent shadow).** In `set()`, when `size > opts.persistentLimit` the persist step is skipped — but an **older, smaller** persisted file for the same key remains on disk and in the tracker. Once the new buffer is evicted from memory, `get()` resurrects the old version. Fix: in that branch, route a removal through the inflight chain (preserving last-wins ordering): chain `removePersistentEntry(key)` + `scheduleManifestWrite()` instead of plain `return`.

**B2 (P1, race — late persist resurrects entries after clear()).** `setPersistent` snapshots `_generation` when *it* starts — i.e. after `await previous` in the inflight chain. A `set()` issued before `clear()` whose persist starts after `clear()` sees the fresh generation and happily writes into the wiped store. Snapshot at issue time instead:

```ts
async set(key: string, buffer: ArrayBuffer): Promise<void> {
  const size = buffer.byteLength;
  this.memoryCache.set(key, buffer, size);
  if (!this.opfsRoot || size > this.opts.persistentLimit) { /* B1 removal path */ return; }
  const gen = this._generation;                       // snapshot NOW
  const previous = this.inflightSets.get(key) ?? Promise.resolve();
  const pending = (async () => {
    try { await previous; } catch { /* proceed */ }
    if (this._generation !== gen) return;             // clear() ran since issue
    await this.setPersistent(key, buffer);
  })();
  ...
}
```

**B3 (P1, race — manifest TOCTOU).** `writeManifest` checks `_generation` immediately before `writePersistentFile`, but `clear()` can run *during* the awaited write → a stale manifest file is re-created in a supposedly-empty store, resurrecting phantom entries next session. Fix: re-check after the write and undo:

```ts
await this.writePersistentFile(MANIFEST_NAME, encoded);
if (this._generation !== gen) {
  await this.opfsRoot.removeEntry(MANIFEST_NAME).catch(() => undefined);
}
```

**B4 (P1, robustness — self-healing phantom entries).** If the manifest lists a file that no longer exists (partial clear crash, browser housekeeping), `getPersistent` catches `NotFoundError`, returns miss — but the tracker entry survives forever, inflating `persistentTracker.size` and triggering premature eviction of real entries. Same for the `file.size === 0` path (leaves a zero-byte file *and* tracker entry). Fix: on `NotFoundError` → `this.persistentTracker.delete(key)`; on zero-size → delete tracker entry and `removeEntry(name).catch(...)`.

**B5 (P1, robustness — init-time reconcile).** Inverse of B4: a crash between file write and manifest write leaves **orphan files** invisible to every future session — a permanent quota leak. After `loadManifest()`, reconcile both directions in one O(N) directory listing:

```ts
private async reconcile(): Promise<void> {
  if (!this.opfsRoot) return;
  const onDisk = new Set<string>();
  for await (const name of (this.opfsRoot as IterableDirectoryHandle).keys()) onDisk.add(name);
  onDisk.delete(MANIFEST_NAME);
  for (const [key, entry] of this.persistentTracker.entriesOldestFirst()) {
    if (!onDisk.has(entry.name)) this.persistentTracker.delete(key);  // phantom
    else onDisk.delete(entry.name);
  }
  // leftovers = orphans from crash between file write and manifest write
  await Promise.allSettled([...onDisk].map(n => this.opfsRoot!.removeEntry(n).catch(() => undefined)));
}
```

**B6 (P2, correctness — init idempotency + gating).** `init()` is not memoized (double-call double-loads the manifest; concurrent calls race) and `get`/`set` issued before `init()` resolves silently degrade to memory-only (cold-start thundering herd refetches). Fix: `private initPromise: Promise<void> | null = null; init() { return this.initPromise ??= this.doInit(); }`, and at the top of `get`/`set`/`delete`: `if (this.initPromise) await this.initPromise.catch(() => undefined);`.

**B7 (P2, cross-session perf — memory hits look cold to disk evictor).** A memory hit never bumps `persistentTracker` recency, so the *hottest* entries appear oldest to persistent eviction and their files are deleted first — after a reload, the most-used items are exactly the ones gone. One line in `get()`'s memory-hit branch: `this.persistentTracker.get(key);` (Map ops only, no I/O; order persists on next manifest write).

**B8 (P2, consistency — read-your-writes).** If an entry is evicted from memory while its persist is still in flight, `get()` reads OPFS mid-write → miss/stale. Before `getPersistent`, await any pending set: `const ps = this.inflightSets.get(key); if (ps) await ps.catch(() => undefined);`.

**B9 (P2, robustness — long keys overflow OPFS name limits).** `safeCacheName` of a long URL key (signed S3 URLs easily exceed 1 KiB) can exceed implementation name limits → persist fails forever for those keys. The tracker/manifest already support arbitrary key→name mapping; only name *generation* changes. Deterministic hash fallback keeps the trackerless-fallback path in `getPersistent` working:

```ts
const MAX_NAME = 200;
async function cacheNameFor(key: string): Promise<string> {
  const enc = safeCacheName(key);
  if (enc.length <= MAX_NAME) return enc;
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return 'sha256-' + [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
```

(All call sites — `getPersistent`, `setPersistent`, `removePersistentEntry` — are already async.)

**B10 (P2, hardening — manifest field validation).** `loadManifest` trusts `entry.size`; a corrupted manifest with `NaN`/negative sizes poisons `currentSize` (see L3). Skip malformed entries: `typeof key === 'string' && typeof name === 'string' && Number.isFinite(size) && size >= 0`. This validates the cache's **own metadata**, not cached content — distinct from rejected G2-9.

**B11 (P2, feature — `delete(key)`).** No way to invalidate one entry today (`clear()` nukes everything). Needed for pyramid-level regeneration / re-encode flows. `memoryCache.delete(key)`; await pending inflight set for the key; `removePersistentEntry(key)`; `scheduleManifestWrite()`.

**B12 (P3, feature — `has(key)`).** Non-promoting existence probe so schedulers can choose decode-vs-fetch without loading bytes: memory `peek()` ?? tracker `peek()`. Must NOT promote (peek only) and must respect B6 gating.

**B13 (P3, perf).** `writeManifest` copies the encoded manifest via `encoded.buffer.slice(...)`. `FileSystemWritableFileStream.write()` accepts a `BufferSource` and respects view bounds — widen `writePersistentFile(buffer: ArrayBuffer | Uint8Array)` and pass `encoded` directly; delete the slice and its comment.

**B14 (P3, perf — manifest write debounce).** Manifest currently rewritten up to ~2× per burst window via microtask coalescing; during ingest bursts that is O(entries) JSON per write. Replace `Promise.resolve()` with a ~250 ms timer in `scheduleManifestWrite`. Safe **only after B5** (orphan reconcile covers the wider crash window). Keep `drainManifest` loop unchanged.

**B15 (P3, telemetry).** Add counters to `stats().persistent`: `evictions` (increment in `removePersistentEntry`), `quotaEvictions` (increment in the `QuotaExceededError` branch). Cheap, aids field diagnosis of thrash on constrained devices.

**B16 (P3, optional — standard-API quota sizing + multi-tab manifest lock).** (a) At init, cap the persistent budget via `navigator.storage.estimate()`: `persistentTracker.setMaxSize(Math.min(opts.persistentLimit, Math.floor((est.quota ?? Infinity) * 0.5)))` (requires L4). This is init-time sizing via a **standard** API — distinct from rejected G2-2 (runtime pressure-driven eviction via non-standard API). (b) Two tabs share one OPFS origin and fight over the manifest (last-writer-wins divergence; B4/B5 self-heal the damage next session). Cheap mitigation: `if (navigator.locks) await navigator.locks.request('jxl-cache-manifest', () => this.writeManifest())`. Both items are reject-if-unconvinced candidates.

### node.ts

**N1 (P0, security/bug — raw key in path).** `path.join(basePath, key)` with caller-supplied keys: `../`-style keys **escape basePath** (write/delete outside the cache dir); keys containing `/` create subdirectories that `clear()`'s flat `readdir`+`unlink` never removes (leak + EISDIR noise); `:*?"<>|` are illegal on Windows. Fix: export `safeCacheName` from `browser.ts` (node.ts already imports `CacheOptions` from there) and add a sync long-name hash via `node:crypto`:

```ts
import { createHash } from 'node:crypto';
function fileNameFor(key: string): string {
  const enc = safeCacheName(key);
  return enc.length <= 150
    ? enc
    : 'sha256-' + createHash('sha256').update(key).digest('hex');
}
```

Use `fileNameFor` in `get`/`set`/`clear`-adjacent paths. Note: existing on-disk caches keyed by raw names become unreachable (cold restart) — acceptable for a cache.

**N2 (P0, bug — non-atomic writes corrupt the store).** `fs.writeFile` truncate-then-write means a crash or two concurrent `set()`s for one key can interleave → torn file later served to the decoder as a "valid" cache hit. The cache is content-agnostic by mandate (G2-9), so **atomicity is the only legitimate defense**:

```ts
const tmp = filePath + `.tmp-${process.pid}-${tmpCounter++}`;
await fs.writeFile(tmp, Buffer.from(buffer));
await fs.rename(tmp, filePath);   // atomic on POSIX; MOVEFILE_REPLACE_EXISTING on Windows
```

`clear()` and the N3 init scan must skip/delete `*.tmp-*` leftovers.

**N3 (P0, gap — `persistentLimit` never enforced).** Disk grows unbounded on long CLI/ingest runs. Port the browser's tracker pattern, simplified: key the tracker by **file name** (no manifest, no key-inversion problem — `get`/`set` recompute `fileNameFor(key)` directly; the tracker exists purely for size accounting and eviction order). Seed at init: `readdir` + `stat`, sort ascending `mtimeMs`, `tracker.set(name, true, size)`. Before each persist: evict-oldest (`unlink` + `tracker.delete`) until `tracker.size + incoming <= persistentLimit`; skip persist entirely when `incoming > persistentLimit` (and unlink any existing file for that name — N-side mirror of B1). Bump recency on read hit and on memory hit (mirror of B7).

**N4 (P2, perf — inflight read dedupe).** Multi-worker node decode can issue concurrent `get(key)` → N redundant file reads of multi-MB buffers. Port the browser `inflightGets` map verbatim.

**N5 (P2, parity — stats/clear/logging).** `stats()` lacks the `persistent` section, hit/miss counters, and `hitRate` (add after N3, same shape as browser including `enabled`). `clear()` unlinks serially — use `Promise.allSettled` over the list; the bare `catch {}` should at least `console.warn` (browser parity).

**N6 (P2, correctness — init memo + gating).** Same as B6: memoize `init()`, and `get`/`set` should await `initPromise` so writes before/around init don't fail on a missing directory (currently a logged ENOENT and a silently lost persist).

**N7 (P3, feature parity).** `delete(key)` (memory + unlink + tracker) and `has(key)` (memory peek ?? tracker peek after N3).

**N8 (P3, structure — shared interface).** Define `export interface JxlCache { init; get; set; delete; has; clear; stats }` next to `CacheOptions` in `browser.ts`; both classes `implements JxlCache`. Updating `createJxlCache`'s return type in `index.ts` is a **deferred edit — request approval first** per the agent rules. Optionally relocate `CacheOptions`/`safeCacheName` to a `types.ts` — only if the import direction bothers the implementer; not required.

### Domain lenses — outcomes folded in above

Lenses 11–17 (astronomy/LLM/gaming/photogrammetry/AR/color-LUT/Butteraugli) all reduce to the same conclusion: this layer best serves them by staying **content-agnostic but trustworthy** — embeddings, LUT blobs, pyramid tiles, and photogrammetry tile sets are all just `ArrayBuffer`s under stable keys. What those workloads actually need from the cache is: single-entry invalidation (B11/N7), cheap existence probes for fetch-vs-decode decisions (B12/N7), survival of multi-GB field datasets without quota leaks or corruption (B5, N2, N3), warm-restart fidelity (B7), and long-URL keys not breaking persistence (B9/N1). Butteraugli (Lens 15) cannot be sped up *in* this layer; the cache's contribution is making re-encode results reliably cacheable so Butteraugli runs once per (content, effort, distance) — a caller-side key-composition concern, no code change here.

---

## Agent handoffs

Execution order: **Agent 1 first** (L1/L4 underpin B1/B16). Then Agents 2→3 sequentially (same file), and Agents 4→5 sequentially (same file); the 2→3 and 4→5 tracks may run in parallel with each other. Each agent: check repo test conventions before adding tests; new test files under `packages/jxl-cache/test/` are allowed; edits to files other than your own must be deferred and approved (exception: agreed exports listed in your section).

### Agent 1 — `packages/jxl-cache/src/lru.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Scope: **L1** (move same-key removal above the oversize early-return — stale-entry bug; keep the doc comment about callers accurate), **L2** (mruKey fast path; ensure `delete`/`clear`/eviction invalidate a matching `mruKey`), **L3** (finite/non-negative size guard), **L4** (`has(key)`; `setMaxSize(n)` that evicts down using the existing iterator pattern). Add unit tests for: oversize re-set removes the old entry; repeated `get` of MRU key preserves order and value; `setMaxSize` shrink evicts oldest-first and fixes `currentSize`.

### Agent 2 — `packages/jxl-cache/src/browser.ts` (correctness & races)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Scope: **B1** (stale persistent shadow on oversize re-set — route removal through the inflight chain to preserve last-wins; do not coalesce sets, G2-3), **B2** (generation snapshot at issue time — snippet above), **B3** (manifest delete-after-write on generation mismatch), **B4** (self-heal: tracker.delete on NotFoundError; tracker.delete + removeEntry on zero-size file), **B6** (init memoization + `await initPromise` gating in `get`/`set`), **B7** (memory hit bumps `persistentTracker` recency — one line), **B8** (get awaits pending inflight set for the key before OPFS read), **B10** (manifest entry shape validation — metadata only, explicitly not content validation). Tests: clear-during-pending-set leaves store empty; manifest never resurrects post-clear; phantom tracker entry healed on first miss.

### Agent 3 — `packages/jxl-cache/src/browser.ts` (robustness & features)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Run after Agent 2. Scope: **B5** (`reconcile()` after `loadManifest` — snippet above), **B9** (`cacheNameFor` with SHA-256 fallback for encoded names > 200 chars), **B11** (`delete(key)`), **B12** (`has(key)`, peek-only), **B13** (pass `Uint8Array` view straight to `write()`, drop the slice), **B14** (250 ms manifest debounce — only with B5 landed), **B15** (eviction/quota counters in `stats()`), **B16** (optional pair: `storage.estimate()` init-time cap via `LRUCache.setMaxSize` — argue distinction from G2-2 if implementing; `navigator.locks` around manifest writes). B16 items are the most rejectable here — judge on merit.

### Agent 4 — `packages/jxl-cache/src/node.ts` (safety)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Scope: **N1** (filename sanitization + sync hash fallback — snippet above; requires exporting `safeCacheName` from `browser.ts`, an agreed cross-file export; document the cold-restart consequence), **N2** (temp-file + rename atomic writes; tmp cleanup in `clear()`), **N4** (inflight get dedupe), **N6** (init memo + gating). Tests: key `../escape` stays inside basePath; key with `/` round-trips; concurrent sets of one key leave a valid (last-written) file; tmp leftovers cleaned by `clear()`.

### Agent 5 — `packages/jxl-cache/src/node.ts` (parity & features)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Run after Agent 4. Scope: **N3** (name-keyed eviction tracker, mtime-seeded init scan skipping `*.tmp-*`, evict-before-write, oversize-skip with stale-file unlink, recency bumps on hits), **N5** (stats parity + parallel clear + warn-on-failure), **N7** (`delete(key)`, `has(key)`), **N8** (`JxlCache` interface in `browser.ts`, both classes implement it; the `index.ts` return-type change and any `types.ts` relocation are deferred edits — request approval before touching them). Tests: writes beyond `persistentLimit` evict oldest-by-mtime; oversize set removes prior persisted file; stats shape matches browser.

---

## What implementing this achieves

The correctness tier (L1, B1–B4, N1, N2) closes the gaps through which this cache can actively lie: serving a stale buffer after an oversize re-set, resurrecting entries after a `clear()` it claimed to honor, presenting torn node-side files as valid hits, and — worst — letting a hostile or merely unusual key write outside its own directory. For a layer whose mandate is to be content-agnostic and invisible, "never serves wrong bytes, never leaks writes outside its sandbox" is the entire trust contract, and today all four of those properties fail under reachable conditions.

The robustness tier (B5–B10, N3–N6) makes the cache self-healing across the messy realities of field use that this platform explicitly targets: crashes mid-write no longer leak quota forever, manifests and directories re-converge automatically at startup, multi-worker and multi-tab access degrade gracefully instead of silently diverging, hot entries survive page reloads because disk eviction finally sees memory-tier recency, and node deployments stop growing without bound. Together these turn the persistent tier from "best-effort, trust it less the longer it runs" into something an offline botanical survey can lean on for weeks.

The feature tier (B11–B16, L4, N7, N8) is small but unlocks caller patterns the pipeline already wants: single-entry invalidation for pyramid regeneration, cheap `has()` probes so schedulers can choose decode-vs-fetch without pulling megabytes, unified typing across runtimes, and quota-aware sizing on constrained devices. None of it adds protocol knowledge, format awareness, or dedup logic — the layer boundaries that earned this package its 5/5 stay exactly where they are.
