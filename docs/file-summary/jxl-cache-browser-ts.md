# Working Notes: packages/jxl-cache/src/browser.ts
> Two-layer cache — in-memory LRU + OPFS persistent storage; content-agnostic
> Features covered: #1 (Build Architecture — Module Caching, Two-Layer Caching)

---

## Index of Key API

| Symbol | Kind | Purpose |
|--------|------|---------|
| `JxlCacheBrowser` | class | Two-layer cache: memoryCache (LRU) + persistentTracker (OPFS) |
| `init()` | async method | Opens OPFS root and loads manifest. No-op if `persistent=false`. |
| `get(key)` | async method | Memory hit → return; else OPFS read (deduped via inflightGets) |
| `set(key, buffer)` | async method | Write to memory; if OPFS enabled, queue persistent write (deduped via inflightSets) |
| `clear()` | async method | Clears memory + OPFS + inflight maps |
| `stats()` | method | hitRate, memory/persistent sizes, inflight counts |

---

## Feature #1 Coverage

| Feature | Status | Location |
|---------|--------|---------|
| Two-Layer Caching | ✅ Full | LRU memory (fast) + OPFS persistent (durable); memory populated on OPFS hit |
| Content-Agnostic Design | ✅ Full | Cache stores raw `ArrayBuffer` keyed by caller-provided string — no format awareness |
| LRU Eviction (memory) | ✅ Full | `LRUCache` handles eviction at `memoryLimit` |
| LRU Eviction (OPFS) | ✅ Full | `evictPersistentUntilFits()` + `evictPersistentFraction(0.75)` on QuotaExceededError |
| Inflight Deduplication | ✅ Full | `inflightGets` / `inflightSets` Maps prevent concurrent duplicate OPFS ops for same key |
| Manifest Persistence | ✅ Full | OPFS manifest (`__jxl_cache_manifest.json`) persists LRU order across sessions; lazy-written via `scheduleManifestWrite` |
| Hit-Rate Tracking | ✅ Full | `hitCount` / `missCount` → `stats().hitRate` |
| Quota Handling | ✅ Full | `QuotaExceededError` caught → aggressive 75% eviction → retry |

---

## Dedup Invariant (Cross-Layer)

The cache is content-agnostic and keys are caller-provided. Per CLAUDE.md: "The cache must never duplicate entries by sourceKey — it is content-agnostic." The cache stores under the provided key; deduplication of sourceKey is the scheduler's responsibility (DedupeRegistry). These layers are correctly separated. ✅

---

## Bottlenecks & Issues

### 🟡 B1 — OPFS manifest is written on every `set()` (via `scheduleManifestWrite`)
`scheduleManifestWrite()` deduplicates concurrent writes via `manifestPendingWrite ??=` and coalesces multiple dirty flags in `drainManifest()`. However, for a high-volume batch (many `set()` calls), each call marks `manifestDirty = true` and the manifest is re-written after the previous write completes. Under heavy load this could produce many sequential manifest writes.
**Mitigation (current):** `drainManifest()` coalesces — if many `set()` calls arrive while a manifest write is in progress, only one additional write happens after. ✅ Already handled.

### 🟡 B2 — `get()` deduplication: inflight get result is shared but callers may get different outcomes
If two concurrent `get(key)` calls hit the same OPFS pending promise, the second caller awaits the first's result. If the result is `undefined` (miss), both miss. If it's a buffer, both get a hit. The memory cache is populated on hit, so subsequent calls are fast. ✅ Correct.

### 🟡 B3 — `set()` for same key while inflight: chains on previous set
`const previous = this.inflightSets.get(key) ?? Promise.resolve(); const pending = previous.catch(...).then(() => setPersistent(...))`. This serializes concurrent writes for the same key. The second write wins (overwrites with same or different content). Correct but the second write may be redundant if the key is immutable (content-addressed).
**Fix (if keys are content-addressed):** Check if key already exists in persistentTracker before writing.

### 🟢 B4 — `loadManifest` restores OPFS LRU order across sessions
On init, manifest entries are loaded in order into `persistentTracker`. This means eviction preference (oldest-first) survives browser restarts. ✅

### 🟢 B5 — `writePersistentFile` has no retry loop
Per CLAUDE.md: "Retry loop in writePersistentFile duplicates existing QuotaExceededError handling." The retry is correctly handled one level up in `setPersistent` (QuotaExceededError → evict 75% → retry once). No inner retry. ✅

---

## Key Invariants

- Memory cache is always populated on OPFS hit (warm-up on first disk read).
- OPFS is never consulted if `opfsRoot === null` (init failed or `persistent=false`).
- `inflightGets.delete(key)` in `finally` — inflight entry removed even on error.
- Cache layer is invisible to scheduler/session/stream — no protocol event types, no sourceKey, no dedup logic.
- `safeCacheName()` percent-encodes special characters — safe for OPFS file names.
