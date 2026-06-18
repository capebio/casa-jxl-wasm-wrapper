# Rust / WASM Integration Map

*Where compiling to WASM (Rust, or C/C++ via Emscripten) actually pays in `browser.ts` — and, just as important, where it would make things slower. A byte cache is mostly I/O- and bookkeeping-bound, not compute-bound, so most of it should stay in JS.*

## The governing rule

WASM earns its place in exactly two situations: it **accelerates a genuine numeric inner loop** (ideally with SIMD over a contiguous buffer), or it **unlocks a better browser API** that's awkward from the main thread (here, OPFS synchronous access handles). It *costs* you whenever it adds a JS↔WASM boundary crossing to an operation that was already cheap. So the discipline is **coarse-grained boundaries**: cross rarely, with large payloads ("read this region," "decay the whole sketch," "write this manifest"), never per-key ("look up this entry"). This is the Copy/Move/View/Alias lens applied to the language boundary.

## Where WASM does NOT help (leave it in JS)

- **The hot path.** A memory hit returns a `SharedArrayBuffer` reference — zero compute, zero copy. Wrapping it in WASM only adds a crossing. This is the canonical "don't touch it" case.
- **The LRU itself.** A doubly-linked-list + map LRU is pointer-chasing; WASM linear memory doesn't make pointer-chasing faster, and you'd pay the boundary on every `get`/`set`. Keep it in JS.
- **The index / coordination.** `has()`, the tracker map, the inflight-promise plumbing — O(1) lookups and async orchestration. Crossing the boundary per lookup is the anti-pattern; these are cheap in JS and belong there.
- **`cacheNameFor`'s SHA-256.** `crypto.subtle.digest` is **already native** (the browser's optimized C++), so a Rust SHA-256 would be equal-or-slower. The only real complaint about it is that it's *async*, which infects call sites. The fix for that is a *synchronous non-cryptographic* hash — you don't need crypto strength to name a cache file — and a tiny sync JS xxHash/FNV gets you there more cheaply than dragging in WASM. WASM is the wrong tool here.
- **A Bloom/Cuckoo filter** (raised earlier): still pointless, in any language — the index already fits in RAM as a hash map.

## Where WASM genuinely helps

### 1. The persistent tier in a Worker, via OPFS sync access handles — highest payoff, highest cost
The current store uses the **async** OPFS API (`createWritable`, `getFile().arrayBuffer()`), which round-trips the whole file through an `ArrayBuffer`. OPFS also exposes **`createSyncAccessHandle`** — synchronous `read`/`write`/`getSize`/`truncate`/`flush`, **worker-only**, and substantially faster because it supports *positioned* I/O without the buffer round-trips. A Rust persistent-store compiled to WASM, running in a dedicated worker and reaching OPFS through `wasm-bindgen`/`web-sys` sync-handle bindings (or Emscripten's WASMFS-OPFS backend for C/C++), buys three things at once:
- **Positioned / partial reads.** Read just a tile or region of a stored JXL without materializing the whole file — this is the direct hook into your existing tile/region-decode work. The cache stops being all-or-nothing.
- **Copy elimination.** Read straight into a typed-array view over a `SharedArrayBuffer` → **one** copy (disk→SAB), removing the intermediate `ArrayBuffer` that the cold path (`getPersistent`) currently forces. That retires the "two copies on the cold path" item without an API change to callers.
- **Off-main-thread I/O.** All file work, plus the binary manifest encode/compaction (Phase C / PR C2), lives in the worker. The `JSON.stringify` stall disappears.

The win here is **not** "Rust does arithmetic faster" — it's a faster *I/O API* plus positioned reads, with WASM/worker as the natural vehicle. This is essentially the B3/PersistentStore component (handoff Phase B) relocated into a worker; treat it as vision-adjacent, not a small PR.

### 2. The W-TinyLFU frequency sketch — only if you build the policy (Phase C / PR C4)
If the trace replay justifies a frequency-aware policy, its core is a **Count-Min Sketch**: a flat array of counters, d hash rows, increment-on-access, min-on-query, periodic halving to age it. Two of those operations are real SIMD candidates over a contiguous buffer:
- **The aging pass** halves the entire counter array — a vectorized `>>1`, ~4–16 lanes wide depending on counter width. On a sketch sized for millions of keys this is where the time is.
- **The multi-row `min`** on query vectorizes across rows.

Keep the counters in WASM linear memory (or a shared buffer) and do the **decay in WASM/SIMD**. But stay surgical: the *per-access increment* is a single typed-array bump and should stay in JS — putting it behind a boundary, thousands of times per second, would cost more than it saves. So even inside the sketch the split is: fine-grained increment in JS, coarse-grained SIMD decay in WASM.

### 3. Binary manifest encode/decode — minor, folds into #1
The log-structured manifest (PR C2) wants compact fixed-width/varint records rather than JSON. Encoding them in the worker's Rust store kills the synchronous `JSON.stringify` and shrinks the files. Real but small, and it rides along with #1 rather than standing alone.

## Prerequisites and caveats

- **Cross-origin isolation is already paid.** `SharedArrayBuffer` construction requires `crossOriginIsolated` (COOP `same-origin` + COEP `require-corp`). The cache already does `new SharedArrayBuffer`, so your deployment must already be isolated — which means the WASM-threads/SIMD prerequisite costs you nothing extra. (If it *weren't* isolated, the cache would already be throwing.)
- **Worker requirement.** Sync access handles only exist in Workers, so #1 inherently means a worker + message protocol. That protocol is the real engineering cost, not the Rust.
- **Rust vs C/C++ path.** Rust reaches OPFS sync handles via `web-sys`; WASMFS-OPFS is the Emscripten/C/C++ route. Given your stack, the `web-sys` path is the natural one.
- **Measure first.** #2 is gated on the same Belady-replay discipline as PR C4 — don't build the SIMD sketch until the trace shows LRU leaving real byte-hit-rate on the table.

## The integration payoff that ties it together

Your JXL decoder and this persistent store both want the *same* thing: OPFS sync handles, positioned reads, and `SharedArrayBuffer` I/O, all in a worker. Co-locating them — the cache hands the decoder a region *directly in shared memory* rather than returning a buffer the decoder then re-reads — removes a copy **and** a boundary crossing in one move. That's the actual reason to spend WASM budget here: not to make the cache's logic faster, but to let the cache and the codec share memory and skip the handoff between them.
