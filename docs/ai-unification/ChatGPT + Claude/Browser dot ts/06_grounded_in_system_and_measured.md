# `browser.ts` — Grounded in the System, and Measured

*The Doc 1–5 handoff was written reading `jxl-cache/browser.ts` in isolation. This doc grounds it in the actual data-flow of the pipeline (the ecosystem map), corrects what the missing context changes, and replaces the perf guesses with **flipflop A/B numbers**. Companion to Doc 4 (handoff) and Doc 5 (WASM map).*

---

## 1. What this cache actually is, in the flow

`JxlCacheBrowser` caches **encoded JXL bytes**, keyed by a content `sourceKey`. It sits *beside* the decode pipeline (`jxl-stream → jxl-session → jxl-scheduler → jxl-worker-browser → libjxl`), not inside it. Three system facts the handoff docs could not see — each load-bearing:

- **The memory tier holds `SharedArrayBuffer`s for a reason.** A cache hit returns a SAB *reference*, which is `postMessage`'d to a decode worker **without detaching**. A plain `ArrayBuffer` would detach on transfer and could not be re-served. So regression test #1 ("memory hit returns the same SAB ref, zero-copy, no detach") is not a nicety — it is the contract that lets the cache feed workers cheaply. **This is exactly why Doc 5's "don't WASM the hot path" is right:** the hot path's whole value is *being a SAB you can hand to a worker for free*.

- **"Positioned / partial reads" (Doc 5 #1) is real because the codec already does ROI.** The decoder has `decode_jxtc_region` + the JXTC tile container + `decode_region` — it can decode just a viewport. A cache that stores a JXTC container and reads *a region* via an OPFS sync access handle feeds that directly. The cache stops being all-or-nothing **because the codec is already not all-or-nothing.** That is the integration, and it's concrete, not aspirational.

- **Dedup belongs to the scheduler; the cache's coalescing is byte-level only.** `inflightGets/inflightSets` (the future `RequestCoalescer`, B1) coalesces *byte requests*. Session-level fan-out dedup lives in `jxl-scheduler`'s `DedupeRegistry`. Keep them separate — the cache must stay **content-agnostic** (no magic-byte checks; format validation is libjxl's job). That also means handoff **A3 option (b)** — a small `{key,size}` header on each cache file — is fine: it's *cache metadata*, not content sniffing.

---

## 2. Where the time really is — measured, not guessed

All four run through the `flipflop` vehicle (interleaved A/B, thermal-cancelling), Node, fractal-sized inputs. Journal: `docs/outputs/timing tests/flipflop/flipflopjournal.toon`. Tests live in `.flipflop/tests/`; the WASM kernels in `.flipflop/wasm/sketch/`.

| question | A → B | result | verdict |
|---|---|---|---|
| `cacheNameFor` hashing | async SHA‑256 → **sync 64‑bit FNV** | **−98.7%** (286 ms → 3.4 ms @ 4096 keys) | **SHIP** ✅ (done) |
| manifest flush encode | `JSON.stringify` → **tight binary** | **−40%** (9.1 ms → 5.5 ms @ 16k entries) | worth it, but structural |
| Count‑Min aging (W‑TinyLFU) | JS scalar → **WASM SIMD `u16x8_shr`** | **−87%** (8.9 ms → 1.2 ms @ 8.4M counters) | **WASM earns it** ✅ *if policy is justified* |
| hash in WASM | sync JS → **WASM + byte marshalling** | **+37–52% (slower)** | **keep in JS** ❌ — boundary beats the cheap op |

This is Doc 5's governing rule, *validated*: WASM wins the contiguous SIMD numeric loop (decay) and **loses** the cheap per-key op (hash), exactly as predicted. The single biggest immediate win was the simplest one — deleting `crypto.subtle`.

Two cautions the measurements surfaced:
- **A *naive* binary manifest encoder (array `.push`) was 4× *slower* than `JSON.stringify`.** Native JSON is fast; the format win only appears with a pre-sized buffer + `encodeInto`. The real C2 payoff is **not** "binary is faster to encode" — it's *not re-serializing the whole tracker every 250 ms* and *moving the stall off the main thread*. Don't ship a hand-rolled binary encoder for the encode speed alone.
- **OPFS sync access handles (Doc 5 #1) cannot be honestly flip-flopped in Node** — OPFS is browser-only and sync handles are worker-only. That win is real but must be measured in the browser harness (`verify` / Chrome CDP), not here. Don't quote a Node number for it.

---

## 3. What I changed (over and above the handoff)

**Shipped now — sync `cacheNameFor` (folds in handoff A5 / B7):**
- `cacheNameFor` is now **synchronous** — a two-lane FNV‑1a (64-bit). The three persistent call sites (`getPersistent`, `setPersistent`, `removePersistentEntry`) drop their `await`. This removes the async infection the SHA-256 forced through the whole persistent path, and is ~98.7% faster on the hashing itself.
- The two namespaces are **prefixed `raw-` / `hash-`**, which kills B7 (a short key shaped like `hash-<hex>` can no longer collide with a hashed long key) for free.
- Tests added: `test/cache-name.test.ts` (5 cases — sync, namespacing, determinism, distinct-hash, B7). `bun test` green (9/9).
- **One-time cost:** the persisted filename scheme changes, so the existing OPFS cache is effectively reset once on upgrade. Acceptable for a cache; flagged here so it isn't a surprise. (Stored manifest names are opaque and keep working for already-cached entries; only fresh writes use the new scheme.)

---

## 4. The roadmap, re-prioritised by evidence + system fit

1. **Correctness first (unchanged):** handoff A1, A2, A7, A8 are real races; do them. A5 is partly done (namespacing landed with the sync hash).
2. **The one true I/O win — relocate `PersistentStore` into a worker on OPFS sync access handles.** This is Doc 5 #1 *and* handoff B3/PersistentStore *and* the cold-path "two copies" fix, all the same move. It reads straight into a SAB view (one copy, disk→SAB) and lets the **cache hand the decoder a region directly in shared memory** — removing a copy *and* a boundary at the cache→decoder handoff. Measure in the browser harness. This is the 10× lever, not the cache's logic.
3. **Manifest: go log-structured + off-main-thread (C2),** for the *stall*, not the bytes. Pairs with #2 (it's encoded in the worker).
4. **Only if a replayed real trace shows LRU below Belady (C0→C4):** build W‑TinyLFU behind the `EvictionPolicy` seam — and put **only the decay** in WASM SIMD (the +87% is real), keeping the per-access increment in JS.
5. **For Casabio specifically (the vision doc's "value" axis):** LRU kills the wrong byte — a rare 10‑year-old observation is "old," a fresh 50 MB thumbnail is "new." The `EvictionPolicy` seam (B6) is what makes `age + size + recreationCost + importance` possible later. Don't build it now; don't foreclose it.

**Do not** WASM the hot path, the LRU, the index, or the hash (all measured or reasoned to lose). Leaner came from *deleting* crypto, not adding a language.
