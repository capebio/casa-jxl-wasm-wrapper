# Progressive Pathway Timing Investigation

**Date:** 2026-06-07
**Branch:** `Progressive_efficiency`
**Scope:** Read-only audit of the progressive JXL decode/paint pathway, grounded in measured TOON timings under `docs/outputs/timing tests/`. No code changed.

---

## TL;DR

**The "Progressive Paint" demo ships throttled to 100 KB/s by default** (`web/jxl-progressive-paint.html:184`). On a typical 465 KB progressive JXL that injects **~4.6 seconds** of artificial network delay before any decode work — this is almost certainly the throttling the page "feels" like it has. The dropdown offers `Unthrottled`, but it is not the default.

Underneath that, the progressive pathway is **2.4–2.65× slower to final** than one-shot decode, while delivering first pixels only **0–22% earlier** than a one-shot decode delivers the *entire* image. The cost is not the progressive *encode* flag (decoding a progressive-encoded file one-shot is the same speed). The cost is **forced per-pass `JxlDecoderFlushImage` + two full-buffer copies — and the demos feed the file in many small chunks, where every chunk bumps a new "input generation" and triggers another full-frame flush.**

Two highest-leverage changes, both JS/HTML-only, no WASM rebuild:
1. **Default the Progressive Paint throttle to `Unthrottled`** (`html:184`). Removes the ~4.6 s artificial delay.
2. **Stop forcing `emitEveryPass: true` / `progressiveDetail: 'passes'` and stop chunk-feeding local bytes.** Progressive multi-pass only earns its cost under genuine network streaming.

---

## How the pathway works (cost chain)

Per emitted pass, the decoder does the following:

| Step | Location | Cost |
|---|---|---|
| 1. Full-frame iDCT/upsample of all coefficients decoded so far | `bridge.cpp:1937` (`JxlDecoderFlushImage`) | **Dominant compute** — a full reconstruction every pass |
| 2. COPY 1: `memcpy(s->flushed, s->pixels, …)` | `bridge.cpp:1951` | Full buffer (~5–10 MB @1920px; ~82 MB at full res) |
| 3. COPY 2: `HEAPU8.slice(dataPtr, dataPtr+size)` copy-out to JS | `facade.ts:2101` | Full buffer again |
| 4. structured-clone / transfer of pixels to the consumer | session/scheduler | Full buffer |
| 5. (paint UIs) `putImageData` + `drawImage` into canvases | `web/jxl-progressive-paint.js` | Cheap (1–7 ms measured) |

This chain runs **`passCount` times** (typically 3, up to 5), not once.

**Two triggers fire the flush:**

1. **Real progression boundaries** — `JXL_DEC_FRAME_PROGRESSION` → flush (`bridge.cpp:2151-2153`). These are meaningful (genuinely more detail).
2. **Opportunistic per-generation flush** — on every `NEED_MORE_INPUT` generation (`bridge.cpp:2040-2052`, `DONOTCHANGE(progressive-checkpoints)`). Gated by `opportunistic_flush_generation != input_generation`, so each distinct input "generation" produces at most one snapshot. **Under throttled/byte-stepped streaming, each byte-step is a new generation → a new flush → a full redundant iDCT + 2 copies**, even if no new detail arrived.

`emitEveryPass: true` + `progressiveDetail: 'passes'` is what makes libjxl surface every progression event as a delivered pass. The demo surfaces (`jxl-progressive-paint.js:1150`, `jxl-single-progressive.js:745/832`) force this. The **product** decode worker does **not**: `jxl-decode-worker.js:140` uses `progressiveDetail: 'lastPasses'` (and `'dc'` for the preview, line 92), and every one-shot path uses `emitEveryPass: false`. So the every-pass cost is confined to the *demo/benchmark* surfaces.

---

## Measured evidence

All runs 2026-06-06, `simd` tier unless noted.

### Progressive final is 2.4–2.65× slower than one-shot (Test_1, 1920px, 3 RAW files × 3 iters)

`2026-06-06T04-49-00-863Z-test_1_progressive_vs_oneshot.toon`. The harness (`benchmark/test_1_progressive_vs_oneshot.mjs:125`) pushes **all bytes in one `decoder.push()`** — so the multiple passes come *purely* from `emitEveryPass`, not from streaming.

| File | Prog first-paint (avg) | Prog final (avg) | One-shot final (avg) | Final slowdown | First-paint vs one-shot final |
|---|---|---|---|---|---|
| P1110226.ORF | 287 ms | 800 ms | 309 ms | **2.59×** | barely earlier (−7%) |
| ADH 1234.CR2 | 204 ms | 595 ms | 224 ms | **2.65×** | 9% earlier |
| PXL…dng | 220 ms | 689 ms | 282 ms | **2.44×** | 22% earlier |

Reading: when bytes are already local, progressive's first paint is *no earlier* than a one-shot decode of the whole image — yet you pay ~2.5× to reach final. This is a bad trade for local bytes. Three passes ≈ three full reconstructions ≈ the ~2.5× factor.

### The progressive *encode flag* is cheap; the flushing is the cost (Test_18)

`2026-06-06T10-20-07-189Z-test_18_progressive_toggle_sweep.toon` (relaxed-simd-mt, 1600px): decoding a progressive-encoded asset *one-shot* is **406 ms** vs **459 ms** for the non-progressive asset — i.e. roughly equal. The penalty in Test_1 therefore comes from per-pass flushing during the streamed decode, not from the bitstream layout.

### Redundant identical passes waste whole reconstructions (single-progressive UI)

`single-progressive-2026-06-06T16-19-57-317Z.toon`, `P2200616.ORF`:

- **tiny 160×119:** `passCount: 2`, `uniqueFrameHashes: 1` — both passes have identical `frameHash e3f0cd96`, identical `rgbNonzeroCount`, identical `lumaVariance`. The second pass produced **zero new visual information** yet cost +6.97 ms. `oneShot_ms: 33.82`, progressive `final_ms: 262` → `speedup: 0.13`.
- **small 320×239:** `passCount: 3`, `uniqueFrameHashes: 3` (here the passes do differ). `oneShot 39 ms` vs progressive `final 83 ms` → `speedup: 0.85`.

### Cold-start tax on the first decode of a session

Same file, same run: the tiny image's **pass 1 `decode_ms` = 254 ms**, while the larger small image's pass 1 `decode_ms` = 45 ms. A smaller image cannot intrinsically decode 5× slower — the 254 ms is **WASM module instantiation / first-decoder cold start** paid by whichever decode runs first. `preloadJxlModule` exists and is used by `jxl-decode-worker.js` / `jxl-worker.js`, but the progressive demo pages don't call it.

### The MT tier matters and does load in the bench (Test_8)

`2026-06-06T09-36-15-979Z-test_8_decoding_speed_sweep.toon` ran on **relaxed-simd-mt**, decode ≈ 427–636 ms at 1600px, `decoding_speed=2` among the fastest (confirms the shipped ds=2 default). The iDCT in step 1 above is multithreaded **only** under `__EMSCRIPTEN_PTHREADS__` via the cached runner (`bridge.cpp:192-205`), which needs SharedArrayBuffer + `crossOriginIsolated` (COOP/COEP). If a browser page isn't cross-origin-isolated, `detectTier` falls back to single-threaded `simd` and **every** per-pass flush's iDCT runs single-threaded.

---

## Throttling analysis

The page *feels* throttled because — by default — it is. Three distinct mechanisms, in descending severity:

### 1. Progressive Paint ships with a 100 KB/s throttle as the default

`web/jxl-progressive-paint.html:180-186`:

```html
<select id="throttle-rate" class="prog-select">
  <option value="0">Unthrottled</option>
  <option value="2048">2 MB/s</option>
  <option value="500">500 KB/s</option>
  <option value="100" selected>100 KB/s</option>   <!-- DEFAULT -->
  <option value="50">50 KB/s</option>
</select>
```

When throttle > 0, `feedThrottled` (`jxl-progressive-paint.js:566-577`) feeds 16 KB chunks with `msPerChunk = (16/1) * (1000/100) = 160 ms` between each. A 465 KB file = ~29 chunks × 160 ms = **~4.6 s of pure injected delay** before counting any decode/paint. This is a network-simulation tool that has become the default for a decode-speed demo. **By contrast, `jxl-single-progressive.html:157` defaults to `Unthrottled`** — so the two sibling demos behave very differently out of the box.

### 2. Unthrottled still pays a `setTimeout(0)` macrotask per chunk (single-progressive)

`jxl-single-progressive.js` always routes through `feedThrottled` (`:1134`), even at throttle = 0. The zero-throttle branch still yields per chunk:

```js
const delayMs = throttleKbPerSec > 0 ? ((end - start) / 1024) * (1000 / throttleKbPerSec) : 0;
if (delayMs > 0 && offset < jxlBytes.byteLength) await sleep(delayMs);
else if (offset < jxlBytes.byteLength) await sleep(0);   // <-- unthrottled path
```

`sleep(0)` is `setTimeout(resolve, 0)` (`:2153`). Browsers clamp `setTimeout` to a **~4 ms minimum** under nesting, and it is a **macrotask** — it yields the entire event loop (rendering included) every chunk. ~19 chunks on a 465 KB file ≈ **~76 ms** of timer overhead that no one asked for, plus the serialization cost of a full event-loop turn between each push. The same `sleep(0)` also runs once per pass (`:844`, `:931`) — minor by comparison.

### 3. Chunk count multiplies the flush cost (both demos) — the hidden throttle

This is the structural one. Every `decoder.push(chunk)` bumps `input_generation` (`bridge.cpp:2031`), and **each generation triggers one opportunistic full-frame flush** at the next `NEED_MORE_INPUT` (`bridge.cpp:2047-2052`) — i.e. a full `JxlDecoderFlushImage` iDCT (`:1937`) + COPY 1 memcpy (`:1951`) + COPY 2 slice (`facade.ts:2101`). There is **no dirty check** after the first flush (the all-zero guard at `bridge.cpp:1955` only fires for `flush_count == 0`), so identical-content snapshots still pay the full reconstruction.

So the number of full reconstructions scales with **how finely the file is chunked**, not with how many visually-distinct passes exist:

| Feed path | Chunking | Flushes on a 465 KB file |
|---|---|---|
| Bench (Test_1, `decoder.push(all)` once) | 1 push | **3** (real `FRAME_PROGRESSION` only) |
| progressive-paint `streamIntoDecoder` (unthrottled) | `requestedPassCount` steps (default 2, max 8) | 2–8 |
| progressive-paint `feedThrottled` (default 100 KB/s) | 16 KB chunks | **~29** |
| single-progressive `feedThrottled` | 1→16 KB ramp, then 32 KB | **~19** (each behind a `sleep(0)`) |

The UIs therefore do **6–10× the flush work of the bench**, and — per the tiny-image evidence (2 passes, identical `frameHash`) — much of it reconstructs unchanged pixels. The chunked feed is effectively a second, self-inflicted throttle stacked on top of the explicit KB/s one.

### Fixes (folded into the ranked list as T1–T3)

- **T1 (HTML one-liner):** default `jxl-progressive-paint.html:184` throttle to `value="0"` (Unthrottled). Removes ~4.6 s. Keep the throttle as an opt-in network sim.
- **T2 (JS-only):** on the unthrottled path, do not chunk and do not `sleep(0)` — push once (or in a few large chunks) and let libjxl surface real passes. Collapses ~19–29 flushes to ~3 and removes the timer overhead.
- **T3 (JS-only):** if a yield is genuinely needed to let paint happen between feeds, use a `MessageChannel` zero-delay macrotask (no 4 ms clamp) or drive paint from rAF independently of the feed loop, instead of `setTimeout(0)`.

---

## Ranked opportunities

Impact × ease. "JS-only" = no WASM rebuild. T1–T3 are the throttling fixes above.

### R1 — Don't force every-pass flushing for local bytes *(JS-only, highest impact)*

For bytes already in memory, `emitEveryPass: true` + `progressiveDetail: 'passes'` buys ≤22% earlier first paint at a 2.5× final-time cost (Test_1). Progressive's payoff is **network streaming**, where the alternative is a blank screen until the last byte. The demos conflate "show me the passes" (a diagnostic) with "decode this file" (the product path).

- **Change:** default the progressive demo surfaces to the product policy — `progressiveDetail: 'lastPasses'` or a `'dc'` preview + final, matching `jxl-decode-worker.js:140`. Reserve `'passes'` for an explicit opt-in "show every pass" diagnostic toggle.
- **Evidence:** Test_1 (2.5× final penalty for ≤22% first-paint gain); product worker already proves `lastPasses`/`dc` is the shipping choice.
- **Risk:** low. This is what the product already does; only the lab pages over-emit.
- **Expected:** progressive demo final time drops toward one-shot (~2.5× on local files); first paint still arrives via the DC/last-pass preview.

### R2 — Verify the multithreaded tier actually engages in the browser *(verify-only; potentially 2–4× for free)*

The per-pass iDCT is the dominant cost and is single-threaded unless the page is cross-origin-isolated. `jxl-progressive-paint.js` / `jxl-single-progressive.js` contain **no `crossOriginIsolated` check and no tier assertion**.

- **Change:** at page load, log `crossOriginIsolated` + `detectTier()`; ensure the dev server and any hosting send `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` so `simd-mt`/`relaxed-simd-mt` loads.
- **Risk:** none to verify. If currently falling back to `simd`, enabling MT is a large iDCT win with zero algorithm change.
- **Expected:** if MT is *not* currently active in-browser, 2–4× on every flush's reconstruction.

### R3 — Decode off the main thread for the paint demo *(JS-only)*

`jxl-progressive-paint.js:2` imports `createDecoder` directly → decode runs on the **main thread**. Each pass's iDCT + COPY 1 + COPY 2 blocks the UI thread and janks the very paint it's trying to showcase. `jxl-single-progressive.js` already has a `decode-in-worker` path (`decodeProgressivelyViaWorker`, line 825) but the checkbox ships **unchecked** (`jxl-single-progressive.html:206`).

- **Change:** default `decode-in-worker` ON; give the paint page a worker decode path too.
- **Risk:** low — the worker path exists and is tested.
- **Expected:** paint cadence smooths out; main thread free during the (still multi-pass) decode.

### R4 — Suppress redundant identical flushes in the bridge *(WASM rebuild)*

The tiny-image case emitted 2 passes with identical content (above). The opportunistic path (`bridge.cpp:2047-2052`) gates on input *generation*, not on whether new groups actually landed — so an input step that adds bytes but completes no new group still triggers a full iDCT + COPY 1 + COPY 2.

- **Change:** extend the existing all-zero guard (`bridge.cpp:1955`, currently `flush_count == 0` only) to a "no new groups since last flush" check — e.g. track libjxl's decoded-group/pass counter and bail before step 1 if unchanged, or compare a strided sample hash before COPY 1. Must never suppress the final.
- **Risk:** medium — needs a reliable "did anything change" signal; over-suppression would drop a real pass.
- **Expected:** eliminates wasted whole-frame reconstructions on small/medium images that re-flush identical content.

### R5 — Stop synthetic byte-splitting for local bytes *(JS-only)*

`streamIntoDecoder` (`jxl-progressive-paint.js:951`) splits the in-memory file into `requestedPassCount` artificial byte-steps. Each step is a new input generation → an opportunistic flush (R4's path) → a redundant reconstruction — passes manufactured by the *harness*, not by the bitstream.

- **Change:** when all bytes are local, push once and let libjxl surface its real `FRAME_PROGRESSION` boundaries. Keep byte-stepping only behind an explicit "simulate network throttle" control.
- **Risk:** low. Removes self-inflicted flushes; real progression passes are unaffected.
- **Expected:** fewer, meaningful passes; less redundant iDCT on the local-file path.

### R6 — Zero-copy progressive peek: drop COPY 1 *(WASM rebuild)*

Each pass pays **both** COPY 1 (`memcpy s->flushed ← s->pixels`, `bridge.cpp:1951`) and COPY 2 (`HEAPU8.slice`, `facade.ts:2101`). COPY 1 exists to hand JS an ownership-transferable buffer while `s->pixels` keeps accumulating. For a *peek* snapshot, JS already copies at COPY 2 — so COPY 1 is redundant if JS reads `s->pixels` directly within the same synchronous tick (before the next `ProcessInput` overwrites it).

- **Change:** expose `s->pixels` as a read-only view for progress snapshots; keep the owned-buffer transfer only for the *final*. Heed the warning at `bridge.cpp:1926` — do **not** swap libjxl's output buffer; only read it.
- **Risk:** medium — JS must finish its slice before the next `ProcessInput`. The facade decode loop is synchronous within a tick (`facade.ts:1208-1251`), so this holds, but it must be enforced.
- **Expected:** saves one full-buffer memcpy per pass (~5–10 MB @1920px, ~82 MB at full res, × passCount).

### R7 — Prewarm the WASM module on the demo pages *(JS-only)*

The 254 ms cold-start pass-1 (above) is module instantiation, not decode. `preloadJxlModule` already exists and is used by the product workers.

- **Change:** call `preloadJxlModule()` on demo page load (idle) so the first user decode doesn't eat instantiation.
- **Risk:** none.
- **Expected:** removes the one-off cold-start spike from the first decode of a session.

### R8 — Gate the serial bench probes *(dev-loop only, JS-only)*

`runProgressivePaintTest` (`jxl-progressive-paint.js:997`) runs the progressive decode, then a one-shot comparison (line 1227), then `runByteCutoffProbe` (line 1301) **serially**, each a full decode. Fine for a lab page, but it inflates wall-clock and conflates what's being measured.

- **Change:** put the comparison/probe behind a flag (default off for the interactive view).
- **Risk:** none.
- **Expected:** faster lab iteration; cleaner single-decode timing.

### R9 — Quality charts: kill the redundant second pixel round-trip and the fallback freeze *(JS-only; Single Progressive)*

At run end, `jxl-single-progressive.js:592` fires `void computeAndDrawChartsAsync(decode.passes, targetRgba)` to draw the PSNR / SSIM / Butteraugli charts. The genuinely heavy math (SSIM + Butteraugli + XYB conversion) is **already off the main thread** — `computeChartsInWorker` (`:174`) posts to `jxl-frame-stats-worker.js`, whose `'chart'` handler (`worker:26-46`) computes all three metrics in one pass. The synchronous `drawPsnrChart` / `drawSsimChart` / `drawButtChart` trio (`:1684-1759`) is only the **`catch` fallback** (`:218-222`). So the common claim "the charts compute metrics synchronously on the main thread and freeze the UI" describes the fallback path, not the live one.

Two real costs remain:

1. **Latched-disable fallback can hard-freeze every subsequent run.** A single worker error routes through `onerror` → `disableStatsWorker`, which sets `_statsWorkerDisabled = true` **permanently** (`:126-133`). After one trip, *every* later run takes the fully-synchronous fallback (SSIM + Butteraugli on the main thread, back-to-back, no yield) — the massive freeze. Diagnose via console: `[charts] worker failed; falling back to sync` / `[stats-worker] disabling after error`.
2. **Redundant second pixel round-trip + main-thread downsample.** Every run *already* round-trips all pass pixels through the same worker once, unconditionally, via `precomputePassStatsInWorker` (`:877`, `:988`) for the frame-stats (hash/luma/alpha) used by the perceptual-cutoff logic. The charts then transfer every pass's pixels a **second** time (`:185`), and `computeChartsInWorker` downsamples the reference + **every pass** on the main thread first (canvas `putImageData`→`drawImage`→`getImageData`, `:36-51`, `:175`/`:180`) before transferring — an O(passes) main-thread image loop at Display/Very-Large sizes.

- **Change (ideal — option C):** fold `psnr`/`ssim`/`butt` into the existing per-pass frame-stats worker message (`precomputePassStatsInWorker`), eliminating the second round-trip entirely. Compute incrementally as passes land (reference `targetRgba` is usually known up front); fall back to an end-of-run batch only when the reference is the final-pass pixels. Move the downsample into the worker (OffscreenCanvas) so the main thread does ~zero metric work.
- **Gate it.** Charting is test-only, so put the metric computation behind a `chartsEnabled` flag: **off → zero penalty** (worker skips the branch; identical to today's non-graphing cost). **on → cheaper than today** (one round-trip + one transfer instead of two). Decode timing is unaffected either way — pass `t_ms` / `first_ms` / `final_ms` are stamped at pass creation (`:1030`), before any stats/chart work.
- **Robustness:** don't latch `_statsWorkerDisabled` permanently on a single transient error; and if the sync fallback is kept, yield (`await sleep(0)`) between passes so even it degrades gracefully instead of freezing.
- **Risk:** low–medium. The worker + `'chart'` handler already exist; this is mostly rewiring plus a gate. The incremental-vs-final reference split needs care.
- **Expected:** removes the second per-pass pixel transfer and the main-thread downsample loop on the graphing path; removes the latched full-freeze entirely; no penalty when charts are off.

---

## Priority

1. **T1** — one-line HTML change; removes the ~4.6 s default throttle that makes the page feel slow. Do first.
2. **T2 / R5** — stop chunk-feeding + `sleep(0)` for local bytes; collapses ~19–29 redundant flushes to ~3 and drops timer overhead. JS-only.
3. **R1** — stop forcing every-pass; mirrors what the product already ships. JS-only.
4. **R2** — verify MT engagement; potentially free 2–4× if the page isn't cross-origin-isolated.
5. **R3 / T3** — off-main-thread decode + non-`setTimeout` yield; smooths cadence. JS-only.
6. **R4 / R6** — bridge-side (need a WASM rebuild): kill redundant identical flushes, then drop COPY 1.
7. **R9** — charts: stop latch-disabling the worker (fixes the full-freeze), fold metrics into the existing per-pass round-trip, gate behind `chartsEnabled`. JS-only.
8. **R7 / R8** — prewarm, bench gating; low-risk cleanups.

## Notes / non-issues

- The `memset(s->pixels, 0, …)` zeroing (`bridge.cpp:2145`) is on `NEED_IMAGE_OUT_BUFFER`, which is once per decode under grow-only realloc — not per pass. Already well-handled; not a hot spot.
- The all-zero scan (`bridge.cpp:1955`) is already correctly guarded to `flush_count == 0`.
- The chunk-batching `decPush` (`facade.ts:1208-1251`, IMPROVEMENT-7) already coalesces queued chunks into one WASM write per tick — good; no change needed there.
- `decoding_speed=2` is confirmed a sound default (Test_8). Not a lever here.
