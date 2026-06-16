# Facade ↔ DecodeHandler — Multi-Lens Review - DONE

**Date-time:** 2026-06-15T01:35Z
**Targets:** `packages/jxl-wasm/src/facade.ts` (file 1), `packages/jxl-worker-browser/src/decode-handler.ts` (file 2)
**Connected edit:** `packages/jxl-wasm/dist/facade.js` (shipped artifact — 3 of the safe fixes hand-ported; see Caveat).

## Intro — purpose of the files

`facade.ts` is the JS↔WASM FFI seam for libjxl. It owns WASM heap allocation, zero-copy
writes, the capability cache, the stateful progressive decoder (`LibjxlDecoder`), the streaming
encoder (`LibjxlEncoder`), region/downsample/bilinear-resize kernels, the JXTC tile container
codec, and the perceptual-metric bridges (Butteraugli / PSNR / SSIM / perceptual-constancy).
Everything that crosses into linear memory passes through here.

`decode-handler.ts` is the primary in-pipeline **consumer** of the facade decoder. One instance
owns one decode session: it feeds chunks into `decoder.push()`, drains `decoder.events()`,
applies the session budget, coalesces `worker_drain` backpressure signals (adaptive HWM + EMA),
converts pixels to transferable buffers, and posts protocol messages to the scheduler.

The seam under review is: **facade emits `DecodeEvent`s → decode-handler forwards them as protocol
messages, transferring pixel buffers.**

## Changes made

All fixes are correctness / robustness / micro-efficiency on **cold, init, and error paths** —
no hot-path (per-pixel / per-chunk) behaviour was altered. Source of truth is `src/facade.ts`.

### File 1 — `src/facade.ts`

1. **`detectTier()` — threading overstated without cross-origin isolation.**
   `typeof SharedArrayBuffer !== "undefined"` returned `true` in browsers that expose SAB but are
   not `crossOriginIsolated`. The selected `*-mt` build then throws when it constructs
   `new WebAssembly.Memory({shared:true})`, and the decode never recovers. Now gated on
   `crossOriginIsolated` (treating `undefined` — Node/Bun — as allowed, so server threads are
   unaffected). Browsers without COOP/COEP cleanly fall back `mt → simd`.

2. **Module-load failure poisoned the cache permanently.**
   `modulePromise ??= …` cached a **rejected** promise; every subsequent `loadLibjxlModule()`
   re-returned the same rejection, so a transient cold-load failure (e.g. a failed `.wasm` fetch)
   killed the codec for the page lifetime. Now the rejected promise is cleared (identity-guarded
   so a newer in-flight attempt is never clobbered), allowing the next decode/encode to retry.

3. **`eventsOneShot()` — missing OOM guard.**
   `module._malloc(totalSize)` was used unchecked; on failure (`0`) the following
   `HEAPU8.set(chunk, 0 + woff)` silently corrupts the heap at address 0. Every other malloc site
   guards `ptr === 0`. Added the same guard (allowing the legitimate `totalSize === 0` case).

4. **OOM buffer leak in `computeButteraugli` / `computePsnrWasm` / `computeSsimWasm`.**
   Pattern was `ptr1 = mallocOrThrow(); ptr2 = mallocOrThrow();` — if the **second** alloc throws,
   `ptr1` is leaked (never freed). Reworked so `ptr2` is allocated inside the `try` and the
   `finally` frees `ptr1` unconditionally and `ptr2` when non-zero.

5. **`floatFromI32Bits()` allocated 3 objects per call** (an `ArrayBuffer` + an `Int32Array` +
   a `Float32Array`) for a 4-byte reinterpret. This runs once per metric result (Butteraugli /
   PSNR / SSIM). Replaced with a module-level reused 4-byte scratch (safe: JS workers are
   single-threaded). Zero allocation per call.

### File 2 — `decode-handler.ts`

No code change. The handler is mature (5/5) and already correct against the live facade contract.
Two passes surfaced no net-positive surgical edit (see Conclusion (b) for what was examined and
why nothing changed). Its relevance is entirely in the **seam** (below).

## Seam findings

- **Pixel ownership across the seam is sound.** Facade decode events always hand the consumer an
  *owned copy*: progressive frames go through `new Uint8Array(buf.data)` (or a fresh resize/crop
  buffer) before `buf.release()` frees the WASM handle; one-shot frames likewise. So
  decode-handler's `toTransferablePixels()` can transfer (detach) the buffer with no risk of a
  dangling view into linear memory. The zero-copy `takeBufferView` subarray path is confined to
  the **encode** chunk drain (a different consumer) — it never reaches decode-handler.

- **Half-wired partial-frame-on-error contract (latent gap).** decode-handler's `error` arm reads
  `event.partialPixels`, `event.partialInfo`, `event.partialPixelStride`, and `event.partialStage`
  (decode-handler.ts:537–540) and is fully prepared to forward a salvaged partial frame. **The
  facade never populates any of them** — its `events()` catch emits only `{code, message}`. So a
  truncated-stream decode discards every already-flushed progressive pass. Wiring this safely was
  evaluated and **rejected** (see rejected-optimizations log + Conclusion (c)): the only safe
  capture costs either a per-pass full-frame copy on the hot path or a `take_flushed` on a libjxl
  decoder already in an error state (undefined / possibly-corrupt output — fails the
  output-fidelity lens). Recorded as a feature recommendation, not shipped.

## Timings — this run vs previous ten

`StandardMultifileTest.mjs`, 8-file corpus, target 1920 / Q85 / effort 3. Host: i7-10850H,
12 cores, 63.8 GB, throttling 100.0% (Optimal). Latest row = post-change run.

| Run (UTC)           | AvgRawMs | ToneMs | DecmpMs | DemMs | ProgEncSimd | ShotDecSimd | ParWall | Speedup |
|---------------------|---------:|-------:|--------:|------:|------------:|------------:|--------:|--------:|
| **2026-06-15 01:35 (this)** | **1039** | **444** | **328** | **109** | **238** | **237** | **2146** | **0.88** |
| 2026-06-14 23:44    | 1106 | 460 | 364 | 107 | 255 | 239 | 2084 | 0.92 |
| 2026-06-14 20:47    |  992 | 429 | 316 | 101 | 226 | 226 | 1843 | 0.98 |
| 2026-06-14 20:25    | 4599 | 2169| 1231| 392 | 282 | 271 | 2736 | 0.79 |
| 2026-06-14 20:12    | 3385 | 1705| 915 | 357 | 1015| 932 | 3626 | 2.06 |
| 2026-06-14 20:08    | 1815 | 942 | 485 | 145 | 538 | 638 | 5440 | 0.94 |
| 2026-06-14 20:07    | 1202 | 626 | 320 | 100 | 458 | 554 | 5415 | 0.82 |
| 2026-06-14 19:50    | 3788 | 1928| 987 | 355 | 733 | 867 | 2511 | 2.76 |
| 2026-06-13 21:46    |  948 | 376 | 418 | 108 | 340 | 306 | 2436 | 1.00 |
| 2026-06-13 21:36    |  953 | 376 | 418 | 117 | 288 | 278 | 2993 | 0.74 |
| 2026-06-13 21:11    |  933 | 372 | 416 | 106 | 315 | 293 | 2723 | 0.86 |

**Timings conclusion.** The post-change run lands inside the recent stable cluster (the 06-13 and
06-14-late runs: Raw 933–1106 ms, Tone 372–460 ms, ProgEncSimd 226–340 ms). The 3000–4600 ms
outliers are unrelated earlier-config / thermal-load runs, not regressions. Crucially the changed
code paths (tier probe, module init, OOM/error handling, metric reinterpret) are **not on the
measured RAW-decode / encode / decode hot paths**, so identical timing is the *expected* result —
and is what we observe. **No timing regression.** Built-in flip-flop core (simd↔mt, 3 interleaved
rounds) ran clean: FlipProgSpdX 2.0, FlipFinalSpdX 0.9 — consistent with history.

**Flip-flop isolation:** none authored. The protocol calls for a dedicated `benchmark/<method>.mjs`
flip-flop only for a *suspected slow/speed change worth isolating*. These edits are cold/error/init
only and provably off the hot path; isolating them would measure noise. The harness's own
simd↔mt flip-flop is the relevant signal and shows no movement.

## Conclusion (Chapter 3)

### a. Improvements to file 1 (`facade.ts`)

Five defects fixed, all on non-hot paths: a real browser-tier failure mode (mt build selected with
no cross-origin isolation), a permanent module-poisoning on transient load failure, a silent
heap-corruption-on-OOM in the one-shot decoder, a triple-malloc leak in the three perceptual-metric
helpers, and a per-call 3-object allocation in the int-bits→float reinterpret. None changes pixel
output; #1 and #2 are the highest-impact (they convert "codec permanently dead" into "codec works"
or "codec retries"). The file remains a dense, well-factored 5/5 — the FFI discipline (grow-only
buffers, capability `WeakMap`, retain/take/view tri-state buffer accessors, batched single-write
chunk push) is intact and was not disturbed.

### b. Improvements to file 2 (`decode-handler.ts`)

None applied — and that is the correct outcome. The two passes specifically checked: the
`ChunkRing` power-of-two mask arithmetic (correct), the double-budget-check ordering that avoids
materialising `event.pixels` when already over budget (correct and deliberate), the
`toTransferablePixels` SAB-copy fallback (correct — and now *more* likely to matter given fix #1
keeps mt/SAB builds off non-isolated pages, so the SAB branch is hit only where SAB truly works),
the pre-allocated reused message objects (safe because `postMessage` structured-clones
synchronously), and the adaptive-HWM EMA cache. Each is already at the local optimum; any edit
would be churn against the CLAUDE invariants (backpressure-at-this-boundary, no pixel pool, no
per-stage budget reset).

### c. Improvements to the seam / boundary

The seam's pixel-lifetime contract is already safe (owned copies on the decode path), which is the
property that *matters* for the transfer-and-detach model — confirmed, not changed. The one real
seam gap is the **half-wired partial-frame-on-error path**: a ready consumer and a silent producer.
It is a genuine latent feature (salvaging the last good progressive pass from a truncated field
image is squarely valuable for the biodiversity/lightbox use-case), but every safe implementation
either regresses the zero-extra-copy hot path or emits unprovable pixels from a libjxl decoder in
an error state. It is therefore documented as a recommendation and logged as rejected-for-now,
pending a bridge-level `dec_take_partial` that can guarantee a clean last-rendered frame.

### Closing

This was a hardening pass on a mature seam rather than a redesign. The headline value is turning
two silent "codec is now permanently broken" failure modes (non-isolated mt selection; poisoned
module promise) into graceful fallback / retry, plus removing two memory hazards (one-shot OOM
corruption, metric-helper leak) that only bite under pressure — exactly when you least want them.
The decode-handler needed nothing, which is the strongest possible statement about its current
quality. The single open opportunity (partial-frame salvage) is now precisely scoped: it is blocked
on a fidelity guarantee from `bridge.cpp`, not on JS plumbing.

## Caveat — shipped artifact (`dist/facade.js`)

`dist/` is committed and the regression harness imports it, but it is **materially stale** vs `src`
(~2108 vs ~2805 lines; missing `ButteraugliComparator`, `computePsnrWasm`, `computeSsimWasm`,
planar RGB16 encode, etc.). A clean `tsc` emit is currently blocked by **pre-existing** type errors
unrelated to this work (`rgb8` absent from the `PixelFormat` union, `ensureU16Heap`/`takeJxlBuffer`
undefined, `loader.ts:52` arity) — fixing those is out of scope for a facade review. To still
benefit real users, the three fixes that exist cleanly in the stale dist (tier COI gate, one-shot
OOM guard, module-poison clear) were hand-ported into `dist/facade.js` and `node --check`-verified.
The remaining src-only fixes (metric-helper leak, `floatFromI32Bits` scratch) will surface when
dist is rebuilt. **Recommendation:** unblock the dist rebuild by reconciling the `PixelFormat`
union with the `rgb8` usages and restoring `ensureU16Heap`/`takeJxlBuffer`, then run the full tsc
emit so src and dist reconverge.
