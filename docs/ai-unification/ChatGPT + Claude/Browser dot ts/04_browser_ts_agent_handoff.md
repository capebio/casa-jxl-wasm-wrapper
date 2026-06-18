# `browser.ts` Agent Handoff

*A PR ladder for Claude Code. Two phases: **A — correctness** (do first; mostly behaviour-preserving), then **B — structure** (refactor; strictly behaviour-preserving, gated on A). Each PR is small and independently reviewable. IDs reference the bug ledger (Doc 3).*

## Standing instructions for the agent

- **Preserve discovered invariants.** Do not "simplify" the generation guard, the SAB-ownership decision, the inflight chaining, or reconcile out of existence. If a change would relax one of these, stop and flag it.
- **Surgical, not rewrites.** Targeted diffs. No file-wide reflows. No renames except where a PR explicitly calls for one.
- **Each PR adds its own test** (see acceptance criteria). A PR that can't be tested probably isn't ready.
- **No new public API** in Phase A unless the ledger names it.

## Phase A — Correctness

### PR A1 — tombstone to kill delete/set resurrection (B1)
Add `private keyGeneration = new Map<string, number>()`. `delete(key)` increments it. `set(key)` captures the value at entry; before committing (tracker.set and/or the file write) it re-checks and aborts the commit if the key's generation advanced. Route `delete` and same-key `set` through one serialization chain so ordering is deterministic.
- **Accept:** test `delete(A)` racing a subsequently-started `set(A)` → after both settle, `A` is absent from disk and tracker. Existing set-then-delete still ends absent.

### PR A2 — undo physical write on stale generation (B2)
In `setPersistent`, the post-write `if (this._generation !== gen) return;` must `removeEntry(name)` before returning. Same pattern in the quota-retry branch.
- **Accept:** test `set(A)` whose write completes, with a `clear()` injected immediately after the write resolves → OPFS contains no file for `A` and the tracker is empty. No orphan survives the session.

### PR A3 — crash-safe manifest ordering (B3) — *design decision required*
The transcript's "adopt orphans" is impossible (hashed keys are irreversible). Choose and implement one:
- **(a)** treat a file as committed only after its manifest entry is durable (write/append manifest before returning success); or
- **(b)** prepend a small self-describing header (`{key,size}`) to each cache file so orphans are genuinely adoptable, and change `reconcile` to adopt rather than delete; or
- **(c)** maintain an append-only `key→name` log alongside the manifest.
Recommend (b) if you want reconcile to *preserve* data after a crash (the ledger's stated goal); (a) is the smaller change if "lose-on-crash is acceptable, just don't lose silently" is good enough.
- **Accept:** simulate crash (drop the manifest write) after several sets → on re-init, valid entries are recovered, not deleted (for b/c) or are deleted *and counted as such* (for a).

### PR A4 — split eviction accounting (B4)
Replace the single `evictionsCount++` in `removePersistentEntry` with cause-specific counters incremented at the call sites: `evictedCapacity`, `evictedQuota`, `deleted`, `reconciled`. Update `stats()`.
- **Accept:** a capacity eviction, a `delete`, and a reconcile each increment only their own counter.

### PR A5 — cheap hardening (B7, B8)
`safeCacheName` (or `cacheNameFor`) emits prefixed namespaces `raw-` / `hash-`. `loadManifest` also rejects `entry.size > persistentLimit`.
- **Accept:** a key of the literal form `sha256-<hex>` and a long key that hashes to the same hex map to different filenames. A manifest entry with an oversized `size` is dropped.

### PR A6 — document `has()` semantics (B6)
Doc comment stating `has()` reflects the index, so `has() === true` does not guarantee `get()` succeeds. No behaviour change yet.
- **Accept:** comment present; no logic touched.

### PR A7 — serialize the evict→write→commit critical section (B10)
Wrap `evictPersistentUntilFits → writePersistentFile → tracker.set` in a per-store async mutex (an internal promise-chain queue, or reuse the `navigator.locks` scope already used for the manifest). Only one writer may evict-and-write at a time. This also makes B4 (double-count) and B5 (size drift) converge.
- **Accept:** two concurrent large `set`s that each require eviction never push `tracker.size` past `persistentLimit`, and the evicted item is counted exactly once.

### PR A8 — fix delete-during-iteration in reconcile (B11)
First confirm whether `lru.js` tolerates `delete` inside `forEachOldestFirst`. If not, have `reconcile` collect the keys-to-drop into an array during iteration, then delete them in a second pass.
- **Accept:** reconcile over a tracker containing several stale entries removes *all* of them with no skipped entries and no iterator error.

## Phase B — Structure (gated on Phase A green)

Strictly behaviour-preserving. Land in this order; each is a pure extraction/rename.

- **PR B1 — extract `RequestCoalescer`** wrapping `inflightGets`/`inflightSets` (`run(key, factory)`). The code already names this concept.
- **PR B2 — extract `PersistentIndex`** = `persistentTracker` + manifest + `reconcile`. The belief layer, separated from the bytes.
- **PR B3 — extract `PersistentStore`** = OPFS byte I/O only (`writePersistentFile`, `getFileHandle`, `removeEntry`).
- **PR B4 — rename** `memoryCache → memoryResidency`, `persistentTracker → persistentIndex`. Mechanical, compiler-checked.
- **PR B5 — introduce `type ResourceId = string`** as an opaque alias; thread it through internal signatures. **No structural identity object** — that is the rabbit hole. One alias, nothing more.
- **PR B6 — make `EvictionPolicy` pluggable** (LRU as the default implementation). No new policy yet.

Stop after B6. Value-aware eviction, representation/materialization, and delta encoding belong to the vision doc and are explicitly out of scope for this handoff.

## Phase C — Performance & accounting (measure-first; independent of B)

Ordered so that measurement precedes any policy change — don't build a smarter cache on a guess.

- **PR C0 — instrument before optimizing (B12).** Add `hitBytes`/`missBytes`, a physical-read counter, and the cause-split eviction counters from A4. Add an optional access-trace hook (log `(op, key, size, hit)`), gated behind a flag, so a real Casabio session can be replayed offline. This is the prerequisite for C4 and the antidote to vibe-tuning.
- **PR C1 — batch + parallelize eviction syscalls.** Replace the serial `await removePersistentEntry` loop: compute the eviction set with a pure in-memory pass, apply tracker bookkeeping synchronously, then issue all `removeEntry` calls through one `Promise.allSettled`. Latency drops from `n × syscall` to ~OPFS-concurrency-bounded. (Depends on A7's mutex so the set is computed atomically.)
  - **Accept:** evicting k items issues k removes concurrently; tracker state identical to the serial version.
- **PR C2 — log-structured manifest (B3-adjacent).** Stop re-serializing the whole tracker per flush (O(n) write amplification + a synchronous `JSON.stringify` stall at 10k entries). Append compact binary records (`set k→name size` / `del k`); compact to a snapshot when log size > ~2× snapshot size. Pairs naturally with A3 option (c).
  - **Accept:** a single `set` appends one record, not a full rewrite; replay of log+snapshot reconstructs the tracker exactly.
- **PR C3 — byte-target eviction fraction (B13).** Replace `evictPersistentFraction(0.75)` with "evict oldest until `freed ≥ deficit + headroom`," deficit derived from bytes, not count.
  - **Accept:** quota pressure from a few huge files frees enough bytes in one pass; no silent persist-drop.
- **PR C4 — (gated on C0 trace) size-/frequency-aware policy.** Only if the replay shows LRU materially below Belady-MIN on the real trace: implement Greedy-Dual-Size (H = L + freq·cost/size, evict min-H) or W-TinyLFU admission (Count-Min Sketch frequency, admit candidate only if it beats the victim; small LRU window for recency bursts). Behind the `EvictionPolicy` seam from B6, LRU staying the default.
  - **Accept:** offline replay shows the new policy's byte-hit-rate ≥ LRU's on the captured trace; if it doesn't, don't ship it.

Magic constants (`0.5` of remaining quota, the `250 ms` debounce, any retained fraction) become named, configurable fields so C0's trace can tune them.

## Regression suite to add up front (before A1)

These tests encode the invariants and should stay green through both phases:
1. memory hit returns the same SAB reference (zero-copy, no detach).
2. concurrent `set(A,v1)` + `set(A,v2)` → memory holds `v2`; disk converges to one consistent file.
3. `clear()` during an in-flight `set` leaves no orphan (A2).
4. `delete(A)` then `set(A)` does not resurrect (A1).
5. crash-before-manifest does not silently lose entries (A3).
6. counters attribute each removal to the correct cause (A4).
7. two concurrent large `set`s requiring eviction never exceed `persistentLimit` (A7).
8. reconcile drops *every* stale entry with no skips (A8).
