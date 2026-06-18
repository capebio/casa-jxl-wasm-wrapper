# `browser.ts` Bug Ledger

*Verified against the actual source. Severity reflects real impact, not rhetorical weight. "Mitigated/Overstated" rows are kept so nobody re-litigates them.*

## P0 — correctness, fix first

### B1. delete / set resurrection (no tombstone)
`delete()` awaits the *current* `inflightSets.get(key)` and then removes the file + tracker entry. But a `set(key)` that begins **after** `delete` reads the inflight map never joins that serialization chain, and `delete` has no knowledge of it. With the common "invalidate then refresh" pattern, the `set`'s file write can land *after* `delete`'s `removeEntry`, and the deleted key comes back on disk and in the tracker.
- **Root:** no per-key ordering between `delete` and a *subsequent* `set`; no tombstone.
- **Fix:** a per-key generation/tombstone map. `delete` bumps the key's generation; `set` captures the generation at entry and refuses to commit (file + tracker) if it changed. `delete` and `set` for the same key must serialize through one chain.

### B2. orphaned file on `clear()` after a completed write
In `setPersistent`, after `writePersistentFile` succeeds there is `if (this._generation !== gen) return;` *before* `persistentTracker.set`. If a `clear()` lands in that window, the file is on disk but the tracker never learns of it. `reconcile()` only runs at init, so the orphan survives the whole session — consuming quota and skewing accounting until the next restart.
- **Root:** the generation guard skips the *bookkeeping* but does not undo the *physical write*.
- **Fix:** in the stale branch, delete the file just written before returning. (General rule from the lenses: on a stale async result, undo the physical effect, don't merely skip the logical one.)

### B10. concurrent evict→write has no mutex → over-eviction *and* over-fill *(found in pass 2)*
There is no mutual exclusion over the `evictPersistentUntilFits → writePersistentFile → tracker.set` critical section. Trace two concurrent large `set`s, limit 100, current size 50 (item X=50), each incoming 60. Both enter `evictPersistentUntilFits(60)`. `removePersistentEntry` only does `tracker.delete` in its `finally`, *after* the awaited `removeEntry` syscall — so when set-B checks, X is still present, and both pick the **same** `getOldestKey()` and both evict X (the second hits `NotFoundError`, **double-incrementing the eviction count** — compounds B4). Both loops then see size 0, both write 60 → **tracker.size = 120, past the limit**, with no further eviction, because each evicted only enough to fit *its own* incoming against a stale view.
- **Root:** read-decide-evict-write is not atomic; `navigator.locks` is used for the manifest write but **not** for this sequence — the locking discipline is half-applied.
- **Fix:** serialize evict→write→commit per store via an internal async queue or the same `navigator.locks` scope. Fixing this also makes B5 (size drift) and B4 (double-count) converge.

## P1 — integrity / accuracy

### B13. `evictPersistentFraction(0.75)` is count-based for a byte problem *(found in pass 2)*
Under quota pressure the aggressive path evicts 75% **by count**. If the pressure is caused by a few huge files, evicting 75% of *count* (mostly small files) may not free enough *bytes*, and the retry-once-then-give-up structure then **silently drops the persist**. Unit mismatch: a byte-quota problem solved with a count-fraction.
- **Fix:** target bytes — evict oldest until `freed ≥ incoming + headroom`. Derive the amount from the byte deficit, not the magic `0.75`.

### B3. crash window between file and manifest
Order is: write file → `tracker.set` → debounced (`scheduleManifestWrite`, 250 ms) manifest write. A crash in that window leaves a file with no manifest entry. On next init, `reconcile()` **deletes** every on-disk file the tracker doesn't recognize — so a crash *discards valid cache entries*.
- **Note:** the transcript's proposed fix ("reconcile should *adopt* orphans") is **not possible** as written: `cacheNameFor` hashes long keys with SHA-256, which is one-way, so the key cannot be recovered from an orphan filename. Adoption would require the key to be recoverable.
- **Fix options (pick one in handoff):** (a) write the manifest entry *before* the file is considered committed; (b) embed the key in a small file header so orphans become self-describing and genuinely adoptable; (c) keep a durable append-only `key→name` log. This is a design decision, not a one-liner.

### B4. eviction counter conflates four events
`removePersistentEntry` does `this.evictionsCount++` in its `finally`. It is called by capacity eviction, quota eviction, `delete()`, and stale cleanup alike. `stats().persistent.evictions` therefore means nothing.
- **Fix:** separate counters — `evictedCapacity`, `evictedQuota`, `deleted`, `reconciled`. Increment at the call sites, not inside the shared remover.

### B5. persistent-size drift
`persistentTracker.size` is used as the authoritative byte count, but B2 (and any failed-write-after-partial-effect path) can leave bytes on disk that the tracker never counts. Over a long session the limit calculation grows optimistic.
- **Fix:** mostly falls out of fixing B2; optionally have `reconcile` recompute size from disk and correct the tracker.

## P2 — hardening / semantics

### B6. `has()` reports belief, not availability
Returns `true` from the tracker (an index) when the underlying file may be gone, so `has(k) === true` can coexist with `get(k) === undefined`.
- **Fix (now):** document the cache semantics explicitly. **(Later):** split into `resident()` / `stored()` / `available()` per the vision doc.

### B7. `safeCacheName` collision with hashed namespace
Short keys pass through `encodeURIComponent`; long keys become `sha256-<hex>`. A short user key of the literal form `sha256-<64 hex>` lives in the same namespace as a hashed long key and could, adversarially, collide. Astronomically unlikely, trivially preventable.
- **Fix:** prefix the two namespaces, e.g. `raw-` and `hash-`.

### B8. manifest entry size not bounded
`loadManifest` accepts any `entry.size >= 0`. A corrupted manifest with a huge size poisons LRU accounting.
- **Fix:** also reject `entry.size > persistentLimit`.

### B9. reconcile is O(n) at init
Full directory enumeration on every startup; a startup cost for large caches.
- **Fix (later):** budgeted/lazy/sampled reconcile. Architectural; defer.

### B11. reconcile mutates the tracker while iterating it — *verify `lru.js`* *(found in pass 2)*
`reconcile()` calls `forEachOldestFirst((key,…) => { … this.persistentTracker.delete(key) })`, deleting during iteration. Whether that's safe depends entirely on `lru.js`: if it's a linked-list+map and `delete` unlinks the node the iterator holds, you get skipped entries or a thrown iterator. The *eviction* loops are safe (they re-fetch `getOldestKey` each turn); this one is not obviously safe.
- **Fix:** confirm `lru.js` tolerates delete-during-`forEachOldestFirst`. If not, collect the keys to drop into an array first, then delete in a second pass.

### B12. metrics conflate three different hit-rates *(found in pass 2)*
`hitRate = hits/(hits+misses)` is request-weighted. With item sizes spanning ~1000×, request-hit-rate can look excellent while **byte-hit-rate** is poor (you hit on tiny thumbnails, miss on big originals). Byte-hit-rate is the figure that predicts saved decode/bandwidth and is the only one that can tune an eviction policy. The deduped-get path also counts one physical read serving two callers as two hits, blending *request* hits with *object* hits.
- **Fix:** track `hitBytes`/`missBytes` (and a physical-read counter) alongside the request counts. Cheap, and a prerequisite for any policy work.

## Mitigated or overstated — do not re-open

- **Memory "hundreds of MB / five copies":** inaccurate for current code. `set` performs exactly **one** mandatory copy (caller buffer → SAB) and then passes a SAB *view* to OPFS — the code comment confirms this is deliberate. The cold read path (`getPersistent`) has two copies (disk → ArrayBuffer → SAB), the second of which is forced by the OPFS API returning a plain ArrayBuffer. Hot path (memory hit) is zero-copy. The only way to drop the write-side copy is to accept SAB/ownership from the caller — an API change, not a bug.
- **Duplicate writers, different buffers:** mostly handled by `inflightSets` chaining plus immediate memory update. The only residual is the `clear()`-boundary case, already covered by B2.
- **Manifest write starvation:** the 250 ms debounce in `scheduleManifestWrite` gates the drain loop; low risk.
- **`cacheNameFor` Node/WebCrypto trap:** this is `Browser.ts`; the `basePath` Node hint is an interface artifact. Low priority, note only.
- **OPFS handle lifetime during `clear()`:** implementation-dependent and theoretical; no concrete repro.
