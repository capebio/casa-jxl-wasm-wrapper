# Opus 4.8 — "Seeming Throttle" Findings (Progressive Decode)

**Date:** 2026-06-07
**Branch:** `Opus4.8MaxInvestigationImplementation`
**Input:** `single-progressive` TOON export, 9 rows / 93 passes, `P2200495.ORF`, **`throttle: 0` on every run.**
**Method:** Read-only. Cross-checked the live code against the in-flight implementation (commits below) so already-removed culprits are not re-blamed. No code changed.
**Companion docs:** `Opus4.8MaxInvestigation.md` (the audit being implemented), `Opus4.8Suspicions.md` (leads). This doc is the data-grounded attribution + what is *still* causing the feel.

---

## TL;DR

The page is **not** throttled in this data — `throttle = 0` in all 93 rows, and there is **no injected ms-delay** anywhere on the `throttle == 0` path. The "seeming throttle" is **structural**:

> `emitEveryPass: true` makes the demo perform **one full-frame reconstruction _and_ one full-frame main-thread paint per progressive pass**, serialized. The pass count grows with resolution, and the per-pass cost grows with pixel count, so the penalty is **super-linear in image size**.

Measured penalty vs a one-shot decode of the *same final image*:

| Size | Pixels | Passes | One-shot | Progressive final | Slowdown | First paint vs one-shot final |
|---|---|---|---|---|---|---|
| display `di` 1920×1433 | 2.75 MP | 4 | 158.0 ms | 629.3 ms | **3.98×** | −41% (LATER: 223 vs 158) |
| very-large `vl` 2160×1613 | 3.48 MP | 4 | 170.5 ms | 566.5 ms | **3.32×** | +10% (153 vs 170) |
| original `or` 5240×3912 | 20.5 MP | 12 | 723.0 ms | 6882.6 ms | **9.52×** | −4% (LATER: 749 vs 723) |

**For local bytes, progressive's first paint is no earlier than a one-shot decode of the whole image, and final arrives 3.3–9.5× later.** That is the entire "throttle" feeling: at Original the image refines in 12 visible ~570 ms steps over ~6.9 s, each step a main-thread paint hitch, when one-shot would have delivered the finished image in 0.72 s.

The two highest-leverage fixes are JS-only and already named in the audit but **not yet implemented on this page**: stop forcing every-pass emit/paint (audit **R1**), and stop chunk-feeding + `sleep(0)` for local bytes (audit **T2/R5**).

---

## 1. Read the dashboard's `decMs` column with suspicion (metric trap)

`decMs` is **not** measured decode time. From the live consumer loop:

```js
// jxl-single-progressive.js
const deltaMs = previousPass ? t - previousPass.t_ms : t;   // :863  (wall-clock gap between two emitted passes)
...
pass.paintMs  = performance.now() - paintStart;             // :879
pass.decodeMs = Math.max(0, deltaMs - pass.paintMs);        // :880  (gap MINUS paint)
```

So `decMs = (inter-callback wall-clock) − paintMs`. It lumps together: libjxl decode of newly-fed bytes, the full-frame `JxlDecoderFlushImage` reconstruction, the facade copy-out, the `feedThrottled` chunk pushes + their `await sleep(0)`, the per-pass `await sleep(0)` (`:887`), and **all event-loop scheduling latency** between passes. The relation "cadence ≈ `decMs + paintMs`" is therefore **true by construction**, not evidence of anything.

Consequence: anyone optimizing "decode" from this dashboard is chasing a composite. Real decode (time *inside* `decoder.push`/flush) is unmeasured here. **Recommendation:** instrument true decode separately and relabel the column (see §6, fix #5).

What *is* trustworthy: `t_ms` (pass timestamps), `paintMs` (wrapped around `renderProgressivePass` only), `oneShot_ms`, and the pass count.

---

## 2. Attribution from the 2026-06-07 data (Original, the worst case)

Group C (`or`, default `pac2 qpac2 pdc0`, `go=co`), 12 passes, throttle 0:

- **Wall to final:** 6882.6 ms. One-shot of the same image: **723.0 ms** → **9.52×**.
- **Paint total:** Σ`paintMs` ≈ **1705 ms** (~25% of wall). ~135–195 ms *per pass* — this is `createImageBitmap` of an 82 MB `ImageData` + `drawImage` + the 192 px strip-tile downscale, ×12, on the main thread.
- **"decMs" total:** Σ`decMs` ≈ **5178 ms** (~75% of wall). Dominated by **12 full-frame reconstructions**. A full-image iDCT/upsample is ~constant regardless of how many coefficients have arrived (the transform spans every pixel), so ~12 × (reconstruction slice of the 723 ms one-shot) ≈ the observed ~5.2 s.

**Net:** the run does ~12× the reconstruction work and ~12× the paint work of a single decode, because every progression boundary is materialized as a full pass. Paint is a first-class cost here, not a rounding error — at 20.5 MP it is ~1.7 s by itself.

### Resolution scaling (why big files feel much worse)

Slowdown rises 3.3× → 4.0× → **9.5×** as pixels rise 3.48 → 2.75 → 20.5 MP. Two compounding factors: (a) pass count rises with resolution (4 → 4 → 12), and (b) each pass's reconstruction + 82 MB paint rises with pixels. The audit measured **2.4–2.65×** at 1920 px — but that was the *bench* (`decoder.push(all)` once → 3 passes). The chunk-fed UI at Original is far worse; **this is the gap between the audit's headline and what the page actually feels.**

### First paint buys nothing for local bytes

`di`: pass 1 at 223 ms vs one-shot 158 ms (first pixels arrive *after* one-shot finishes the whole image). `or`: pass 1 at 749 ms vs one-shot 723 ms. Progressive's reason to exist — pixels on screen before the last byte — does not apply when all bytes are already in memory. The demo is paying progressive's cost with none of its benefit.

### Encode-flag sweep: `pac`/`qpac` set the pass count

All at Original:

| Variant | Passes | Final ms | Note |
|---|---|---|---|
| `pac=2, qpac=2` (default) | 12 | 6882.6 | baseline |
| **`pac=0`** | **2** | **1580.7** | DC + final only → 4.4× faster than default |
| **`qpac=0`** | **2** | **1580.7** | DC + final only |
| `qpac=1` | 13 | 7097.9 | slightly more passes |
| `pdc=0/1/2` | 12 / 12 / 12 | 6882 / 6685 / 6875 | progressive-DC flag does **not** change pass count |
| last block (22 passes) | 22 | 8926.1 | see below |

So **progressive AC granularity (`pac`/`qpac`) is what multiplies the work**; `pdc` is free of it. Dropping to `pac=0`/`qpac=0` collapses to 2 passes and ~2.2× one-shot — but that throws away progressive granularity at the *encode* layer. The right lever is the *decode* layer (don't emit/paint every pass) so encode flexibility is preserved.

### The 22-pass outlier (final 8926 ms — slowest of all)

The last block shows 22 passes with **declining** `decMs` (802 → 148) and an unusually large first delta (+1098.9 KB). Declining gaps are the signature of passes that fire *after* the bytes are already buffered (decoder draining a full buffer emits progression events back-to-back, so the inter-callback gap shrinks). The only swept axis left after `pac/qpac/pdc` is **group order**, so this is **most likely `go=tb` (top-bottom)** producing finer spatial progression. **Confidence: medium — please confirm the knob.** Either way it is the worst case: 22 paints (~150 ms each ≈ 3.3 s of paint alone) + 22 reconstructions.

---

## 3. Root-cause chain in the *current* code (post in-flight fixes)

**The worker path is the default** (`decode-in-worker` ships `checked`, `html:206`), so reconstruction runs in the worker and each frame is **structured-clone transferred (82 MB) to main** before paint; `decodeProgressively` (steps below, same shape) is the fallback when the box is unchecked. Per emitted pass:

| # | Step | Location | Cost @ 20.5 MP |
|---|---|---|---|
| 1 | `emitEveryPass: true` → every real `FRAME_PROGRESSION` delivered | `:845` (worker `:932`) | drives N |
| 2 | full-frame `JxlDecoderFlushImage` reconstruction | `bridge.cpp:1937` | dominant compute, ×N |
| 3 | facade copy-out of the frame to JS | facade slice | 82 MB, ×N |
| 4 | `createImageBitmap(new ImageData(82 MB))` then `drawImage` | `:1371–1372` | ~135–195 ms, ×N, main thread |
| 5 | strip-tile downscale `drawImage` into 192 px tile | `renderProgressivePass` `:1210–1217` | small, ×N |
| 6 | `await sleep(0)` (per pass) + `await sleep(0)` per feed chunk | `:887`, `:1196` | macrotask yields; serialize feed↔paint |

On the default worker path, steps 2–3 run in the worker and add **one 82 MB structured-clone transfer to main per pass** before step 4 — so `decMs` (gap − paint) on this run also carries that transfer plus worker message-pump scheduling.

`feedThrottled` still **chunk-feeds local bytes** (1 KB→16 KB ramp then 32 KB steady, `:1183–1186`, consts `:12–13`) and yields `await sleep(0)` between chunks even at throttle 0 (`:1196`). At ~608 KB that is ~19 pushes, each a macrotask boundary. This no longer forces a flush per chunk (see §4) but still adds per-chunk overhead and interleaves the event loop, inflating the gaps that land in `decMs`.

`PROGRESSIVE_DETAIL = 'passes'` (`:11`) is what asks libjxl to surface every progression event. The product worker uses `'lastPasses'`/`'dc'`; the demo does not.

---

## 4. What the in-flight implementation already fixed — do **not** re-blame these

The audit's biggest named culprits are **already landed** on this branch, so they are not what this data is showing:

- **Opportunistic per-generation flush removed** for the open stream — `d2f98af` ("rebuild after removing open-stream opportunistic flush"), `63c345f` (assertion update). The gate still exists in `bridge.cpp` source (`:2048–2050`) but the shipped `pkg` no longer fires it mid-stream. **Result: passes now equal real `FRAME_PROGRESSION` boundaries** (12 at Original), not chunk count (~19). Confirmed by the data: passes < chunks.
- **Multi-second chart freeze / ~3 GB Float32 cascade removed** — `de0869f` part A (cap metrics at 2 MP) + part D (offload to stats worker), and `82d5910` (charts gated behind a toggle; **permanent worker-disable latch fixed**). Charts are not in the decode timing.
- **Synchronous `putImageData` freeze replaced** with async `createImageBitmap` — `de0869f` part B. This is *why* paint now shows as a bounded ~135 ms/pass instead of a multi-second stall, and why each pass yields the loop. Net positive, but it is also what spaces passes into the streaming-like cadence (see §5).
- **Block-border overlay skipped > 4 MP** — `de0869f` part C, `600bf96`. So Original paints carry no border cost; the tile-diff (`4d75d1d`, Uint32) only runs at ≤4 MP.
- **"Decode pacing" commit `1f918bf`** touched only *benchmarks* for this page (its diff is benchmark scripts + the audit doc), **not** `jxl-single-progressive.js`. It injects **no** UI delay. Ruled out as a throttle source.

So the residual throttle-feel is **purely** the structural emit-and-paint-every-pass loop (audit **R1**) plus the still-present chunk-feed/`sleep(0)` (audit **T2/T3/R5**). Those are the items the implementation has **not** reached yet.

---

## 5. Why it *feels* like a network throttle even at `throttle = 0`

There is no artificial delay on this path. The perception comes from three things stacking:

1. **Stepwise reveal:** 12 (or 22) discrete full-frame updates over several seconds, each a visible quality jump — visually identical to watching a progressive image stream over a slow link.
2. **Even cadence:** `await createImageBitmap` (`:1371`) + `await sleep(0)` (`:887`) put a macrotask boundary between passes, so updates land at a regular ~570 ms rhythm (Original) — the steadiness reads as a deliberate rate limit.
3. **Main-thread hitches:** each 82 MB paint briefly blocks the UI thread, so the page feels like it is "working through" the data rather than rendering instantly.

In short: the demo faithfully *simulates streaming* while decoding already-local bytes. That is the bug in perception; the numbers confirm there is no actual throttle.

---

## 6. Recommendations (ranked; impact × ease)

JS-only unless noted. Mapped to the audit's IDs.

1. **R1 — stop forcing every-pass emit/paint for local bytes (highest impact).** Default the page to the product policy: `progressiveDetail: 'lastPasses'` (or a `'dc'` preview + final), `emitEveryPass: false` for the "just decode" path; keep `'passes'` behind an explicit "show every pass" diagnostic toggle. Collapses N from 12 → ~2–3 at Original, removing ~10–11 reconstructions **and** ~10–11 × 82 MB paints. Expected: Original final drops from ~6.9 s toward ~1–1.5 s. This single change kills most of the throttle-feel.
2. **T2 / R5 — don't chunk-feed or `sleep(0)` local bytes.** When all bytes are in memory, push once (or a few large chunks) and let libjxl surface its real boundaries; drop the per-chunk `await sleep(0)` (`:1196`). Removes ~19 macrotask hops and the feed↔paint serialization that inflates `decMs`. Keep chunk+delay strictly behind the throttle control as a network simulator.
3. **Paint at display resolution for intermediates, not 20.5 MP.** The canvas is shown at CSS size; painting a full 82 MB frame 12× then letting CSS downscale is wasteful. Decode/paint intermediate passes at a display downsample (full res only for the final), and/or rAF-coalesce paints so bursts of passes share one paint (the sibling `jxl-progressive-paint.js` already did rAF-coalescing — A2 `1b7bc73`; this page did not get it). Cuts the ~1.7 s paint budget sharply.
4. **R3 — already done; now reduce the per-pass transfer.** `decode-in-worker` already ships `checked` (`html:206`), so decode is off-thread (good). But the worker path pays an **82 MB structured-clone transfer per pass**, and paint is still main-thread. So combine with #1 (fewer passes → fewer transfers + paints) and #3 (smaller intermediate frames → smaller transfers). Do **not** revert the worker default.
5. **Fix the metric.** Instrument true decode (timers inside `push`/flush, exposed via the bridge) and stop labeling `deltaMs − paintMs` as "decode." Otherwise every future perf decision off this dashboard is mis-aimed (§1).
6. **R2 — verify the threaded WASM actually loads in the browser.** `tools/dev-server.mjs:34–35` sends `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`, so MT *can* engage **when the page is served through that dev-server**. Confirm: log `crossOriginIsolated` and which `.wasm` the facade selected. If the page is opened any other way (file://, a static server without the headers), reconstruction runs single-threaded and every per-pass flush is 2–4× slower — which would amplify everything above. Verify before trusting absolute ms.
7. **Bridge-side (needs WASM rebuild), lower priority once R1 lands:** R4 suppress byte-identical flushes (extend the `flush_count == 0` guard at `bridge.cpp:1955` to a "no new groups since last flush" check); R6 drop the redundant COPY-1 `memcpy` for *peek* snapshots. These shrink each remaining pass; R1 reduces how many remain, so do R1 first.

---

## 7. Open items to confirm

- **Decode path:** the default is the **worker** path (`decode-in-worker` ships `checked`, `html:206`), so this run almost certainly carried an 82 MB structured-clone transfer per pass (folded into §3). Confirm the box was checked when the export was produced.
- **The 22-pass block's knob** — likely `go=tb`; confirm (§2).
- **R2 / MT** — log `crossOriginIsolated` + selected `.wasm` for this exact run (§6.6). Resolves whether absolute per-pass cost is single- or multi-threaded.
- **q85 default** — `ca91ac6` aligned the page to q85; the `encMs` column (846–1728 ms, the RAW→JXL re-encode that runs *before* any progressive decode) is a separate large pre-decode cost worth its own pass if "time to first pixel from click" is the metric of interest.
