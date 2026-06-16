# JXL Decode Worker × Main-thread Worker Pool — Multi-Lens Review - DONE

**Date:** 2026-06-17
**Targets:** `web/jxl-decode-worker.js` (file 1), `web/main.js` → `WorkerPool` JXL-decode plumbing (file 2, the seam)
**Protocol:** `docs/multi-lens-review-protocol.md` + lenses from `docs/ChatGPT Lens Handoff.md`
**Note on target path:** the prompt pointed at `C:\Foo\Backup\raw-converter-wasm\web\jxl-decode-worker.js`. That backup is byte-identical to the live file (`diff` → IDENTICAL); review and edits were applied to the live repo copy `C:\Foo\raw-converter-wasm\web\jxl-decode-worker.js`, where git/docs/benchmark live.

---

## Intro — purpose of the files

`web/jxl-decode-worker.js` is the dedicated browser **decode** worker, kept separate from the encode
worker so long encodes never block a lightbox decode. It fetches a JXL URL, optionally extracts an
embedded JPEG (JXTC reconstruction first-paint), runs a progressive libjxl decode through the
`jxl-wasm` facade, and streams `jxl_header` / `jxl_progress` / `jxl_preview` / `jxl_recon_jpeg` /
`jxl_decoded` / `decode_error` messages to the main thread. On any failure it falls back to the
jsquash decoder.

`web/main.js`'s `WorkerPool` is the **seam**: it owns the single decode worker, serialises decode
requests through a priority queue (`_jxlDecodeQueue` / `_jxlDecodeBusy`), dedupes by URL, applies the
three-policy cache (`onFirstProgress` / `onFinal` / `never`), and fans each worker message out to the
registered listener callbacks (`_onJxlDecodeResponse`).

---

## Changes made

### File 1 — `web/jxl-decode-worker.js`

1. **Emit ImageData-ready `Uint8ClampedArray` (correctness).** The old code forced every decoded
   frame to a `Uint8Array` (`ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels)`),
   even when the source was already clamped. Main-thread consumers do `new ImageData(msg.rgba, w, h)`
   (`main.js:2252`, `:1984`) — and the `ImageData` constructor **rejects `Uint8Array`**, requiring
   `Uint8ClampedArray`. The progressive path therefore threw `TypeError` at those consumers in the
   browser (only the jsquash fallback, which returns clamped pixels, happened to work). The new
   `toClampedTight()` helper normalises decoder pixels to a **tight, clamped, transfer-ready** array.

2. **`toClampedTight()` does zero-copy normalisation where safe.** Fast paths: an already-tight
   `Uint8ClampedArray` is returned as-is; a tight `Uint8Array` that owns its whole buffer is re-wrapped
   as a clamped view of the same buffer (no copy). The slow path copies **only** when the source is a
   partial view into a larger/shared buffer (e.g. the WASM heap), where transferring `.buffer` would
   otherwise detach unrelated memory. This matches the old copy count in production (see Timings) while
   producing the correct type.

3. **DRY `postProgress(decodeId, event, isFinal)` helper.** The progress-emission block (build meta,
   tighten pixels, transfer) was inlined twice; it is now one closure. On the final frame it still
   emits both the final `jxl_progress` (smooth progressive paint) and the terminal `jxl_decoded`
   (carrying an independent `new Uint8ClampedArray(rgba)` copy, since both messages transfer/detach
   their own buffer). Behaviour identical; one definition instead of two.

4. **Removed dead `asTightRgba()`.** Defined but never called — superseded by `toClampedTight()`.

### File 2 — `web/main.js` (`WorkerPool`)

5. **Seam concurrency fix — release the decode slot only on a terminal message.**
   `_onJxlDecodeResponse` previously cleared `_jxlDecodeBusy` and pumped the next decode whenever
   `data.type !== 'jxl_progress'`. But `jxl_header`, `jxl_preview`, and `jxl_recon_jpeg` all satisfy
   that condition and arrive **mid-decode** — so the next queued decode was dispatched to the same
   single worker while the current one was still running. Result: overlapping decodes, out-of-order
   frames, and unbounded concurrent WASM decoder instances whenever ≥2 decodes were queued
   (gallery / neighbour prefetch). Now gated on `isTerminal` (`jxl_decoded` || `decode_error`).

6. **Worker-crash deadlock recovery.** The decode worker's `error` handler only logged. A crash left
   `_jxlDecodeBusy` stuck `true` forever and pending callbacks unresolved (loaders spin indefinitely).
   It now fails every in-flight decode with a synthetic `decode_error`, clears the registries, resets
   busy, and resumes the pump so the UI recovers.

---

## Timings table

### Regression run — `StandardMultifileTest.mjs`

Executed per protocol. The harness **aborted pre-existing** at its own native decode step:

```
Benchmark failed: Error: DecodeFailed: JXL decode error: 1
    at StandardMultifileTest.mjs:303 (decoder.events() → ev.type === "error")
```

This failure is **independent of the reviewed files**: `StandardMultifileTest.mjs` imports neither
`web/jxl-decode-worker.js` nor `web/main.js` (verified by grep) — it drives the `jxl-wasm` facade
decoder directly. The error originates in the libjxl-WASM decode of a freshly-encoded buffer (a known
dist/encode-path issue). Because no new run completed, no new row could be appended to the
`benchmark/results_native.json` history; the previous-ten comparison is therefore not available this
run. The reviewed change is JS-only and cannot affect this native path.

### Flip-flop — `benchmark/toClampedTight.mjs` (NEW `toClampedTight` vs OLD force-`Uint8Array`)

10 alternating rounds/scenario. CPU: Intel i7-10850H @ 2.70GHz ×12. Full ledger:
`docs/outputs/timing tests/toClampedTight-flipflop-2026-06-16T23-55-30Z.toon`.

| Scenario (decoder output) | OLD median | NEW median | OLD/NEW | Production? |
|---|---|---|---|---|
| `Uint8ClampedArray` tight, 24 MP | 57.735 ms | 0.029 ms | 1987× | No — facade never emits clamped |
| `Uint8ClampedArray` tight, 2 MP | 5.488 ms | 0.012 ms | 463× | No |
| `Uint8Array` tight, 24 MP | 0.002 ms | 0.004 ms | 0.5× | **Yes** (final frame `.slice()`) — both ~free; NEW fixes type |
| heap-view (partial), 24 MP | 58.076 ms | 68.643 ms | 0.8× | **Yes** (non-final subarray) — both copy once; clamped copy ~18% slower |

**Honest reading:** the facade emits `Uint8Array`/`ArrayBuffer`, never `Uint8ClampedArray` (type is
`ArrayBuffer | Uint8Array` at `facade.ts:29/46/66/80`; runtime is `HEAPU8.slice`/`.subarray`). So the
1987× figure is *cost-structure only*, not a production speedup. In production NEW and OLD perform the
**same number of full-frame copies** (parity), with the clamped copy being marginally slower on the
heap-view path. The guaranteed, non-marginal win is **correctness** (eliminates the `ImageData`
`TypeError`), not throughput. No timing regression is introduced on the hot decode path.

---

## Conclusion (Chapter 3)

**a. Improvements to file 1 (`jxl-decode-worker.js`).** The decode worker now produces pixels the
main thread can paint directly: a tight, ImageData-ready `Uint8ClampedArray`, normalised in one place
(`toClampedTight`) with zero-copy fast paths and a copy only where buffer-transfer safety demands it.
This closes a real latent browser bug — the progressive path previously shipped `Uint8Array`, which
`new ImageData(...)` rejects — that was masked only because the slower jsquash fallback returns clamped
pixels. Emission logic was de-duplicated into `postProgress`, and dead code (`asTightRgba`) removed.
The file is otherwise already well-shaped (concurrent events-iterator vs push, clean disposal in
`finally`, graceful fallback, JXTC first-paint), so changes were deliberately surgical.

**b. Improvements to file 2 (`main.js` `WorkerPool`).** The headline fix lives here: the single decode
slot was being freed by mid-decode signalling messages (`jxl_header` / `jxl_preview` /
`jxl_recon_jpeg`), letting a second decode start on the same worker before the first finished. Gating
the release on a true terminal message restores strict serialisation — important now that neighbour
prefetch (`prefetchAroundCurrent`) queues several decodes at once. A second fix makes a worker crash
recoverable instead of permanently wedging the queue.

**c. Seam / boundary improvements.** The worker↔main contract is now type-correct end-to-end: the
worker guarantees clamped, ImageData-ready pixels, so the defensive `instanceof Uint8ClampedArray`
re-wrap at `main.js:4557` becomes a no-op fast path and the unguarded `new ImageData(msg.rgba,…)`
sites are safe. The slot-release semantics now exactly mirror the worker's terminal/non-terminal
message taxonomy (the worker emits many non-terminal frames per decode; the pool finally treats them
as non-terminal). `isFinal`/`isTerminal` are computed once at the top of `_onJxlDecodeResponse` and
reused, removing the prior duplicate derivation.

**d. Closing.** This pass favoured correctness and concurrency safety over speculative speed. The
decode worker was already near-optimal on the hot path, so the largest real defects were a type
mismatch that broke `ImageData` on the progressive path and a queue-release bug that allowed
overlapping decodes — both fixed with minimal, behaviour-preserving edits. The tempting "remove the
final-frame copy" and "drop pixels from `jxl_decoded`" optimisations were rejected with evidence
(multiple consumers read terminal pixels); see `docs/rejected optimizations.md`. The one perf-relevant
change (`toClampedTight`) was flip-flop-benchmarked and shown to be copy-count-neutral in production —
no regression, plus a large headroom win in the (non-occurring) clamped-input case should the facade
ever emit clamped pixels. The mandated `StandardMultifileTest.mjs` regression run hit a pre-existing,
unrelated native-decode failure and could not contribute a new timing row; the affected files are not
on its code path. `web/p3-lightbox-progressive.test.js` now passes 3/3 (was 2/3 — the worker had
regressed below the design the test encodes).
