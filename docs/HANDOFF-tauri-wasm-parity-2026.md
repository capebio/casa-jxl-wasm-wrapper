# HANDOFF: Tauri / Native Parity with Post-P3.3 WASM JXL + RAW Improvements (June 2026)

**Date**: 2026-06-02 (immediately after P3.3 closeout commit + push)
**Branch**: `benchmarkfeaturechanges` (pushed)
**Latest commit**: `264c5e9` "docs + P3.3: finish useful parts of decode/region boundary (crop benchmark actionables)..."
**Trigger**: "Let's finish off the useful parts of P3.3, then commit and push. After that provide a handoff for matching parity between Tauri and the new WASM improvements."

**Context Window Note**: Start fresh here for Tauri parity work. The entire Boundary Cost Audit + P3.3 decode/region campaign is now documented in the living files below. Do not re-run the browser experiments unless validating a native port.

---

## 1. Mission for This Handoff

Deliver a self-contained brief so the Tauri (native Rust / raw-pipeline / libjxl direct) implementation can reach **feature parity and timing parity-or-better** with the current state of the WASM pipeline *without* paying the browser/JS/WASM boundary costs that drove many of the WASM-side decisions and measurements.

The WASM work (fast-path micro-opts + Boundary Cost Audit phases) produced:
- Concrete data on where copies/handoffs hurt in browser.
- Evidence-based preferences (now in `docs/suggested-settings.md`).
- Self-describing benchmarks (crop benchmark now emits Decode Pixel Handoff + full_decoder_* breakdowns).
- Two major boundaries attacked: RAW→JXL encode prep, and decode pixel handoff / region vs full-file.

Tauri has a fundamentally different cost model (no JS↔WASM, no postMessage/transfer, no HEAPU8.slice, direct Rust ownership, same-process libjxl + raw-pipeline). Many "wins" in WASM are neutral or losses in native; some native opportunities were never visible in browser.

**Success for parity work**: Tauri gallery/lightbox/export paths should at minimum match the *perceived* and *wall* times that the best WASM paths now demonstrate on the same files (Gobabeb set, P2200 herbarium set, etc.), and should be able to do better on region/ROI and full-file latency by using direct paths that were impossible or expensive across the boundary.

---

## 2. Post-P3.3 Current State (WASM Side — What Tauri Should Match or Beat)

### 2.1 Encode Boundary (RAW decode → JXL encode) — Phase 2A measured + closed for browser
- 30-file Gobabeb ORF verification (real browser + real WASM pkg, session-worker harness): `take_rgba` (WASM-side RGB→RGBA) was a consistent **regression** vs pure-JS `rgb_to_rgba(result.take_rgb())`: +10.5 ms mean prep, +~230-260 ms end-to-end (~4-5% slower).
- All regression was inside the `take_rgba()` call + wasm-bindgen glue copy of the 4× buffer. Post-handoff costs (exactBuffer, pushPixels, resize) were ~0 ms in both.
- `docs/suggested-settings.md` now canonically records: **for browser, prefer the JS conversion path**. Keep `take_rgba`/`rgba` surface for Tauri, future direct-RGBA experiments (Phase 2B), and historical A/B.
- Legacy `RAW_RGBA_MODE`, safe-ternary call sites, and A/B harness machinery cleaned up across benchmarks + web/.
- Net for Tauri: evaluate ownership handoff (never materializing the 3× RGB in "caller" memory) separately. The conversion arithmetic itself is not the dominant cost once you are native; direct production inside the tone/convert stage of raw-pipeline (what would have been "take_rgba_direct") is now the interesting native experiment. Do not copy the browser "prefer JS path" rule.

See: `docs/boundary-cost-audit.md` §9–12.2, `docs/suggested-settings.md` (full "what we actually lose" analysis), the 30-file JSONs in `benchmark/runs/`.

### 2.2 Decode Pixel Handoff + Region/ROI vs Full Load — P3.3 (the just-finished part)
**Dataset**: 11 varied files (P2200*.ORF herbarium/sky/plants/blur), tile=128 px, 5 crop sizes, 55 samples. Plus single-file tile-size sweeps. Self-describing reports from `web/jxl-crop-benchmark.html`.

**High-level timings (per-size averages)**:
- Full decode + JS crop: ~2.5–2.9 s (content variance 2.2–3.8 s). Flat with size — the fixed cost of full WASM decode.
- Tiled region: 1.2–2.7 s, high fixed overhead even for tiny crops, scales.
- JXTC (tile container ROI): 9–15 ms at 128 px → 500–870 ms at 2048 px. Dominant win for small/medium views (thumbnails, subjects, zoomed lightbox).

**Decode Pixel Handoff Metrics (the actual boundary costs, captured via onMetric + tiled mapping + full proxy)**:
- `decode_buffer_extract_ms` (facade take/ownership + HEAP slice or direct for region): **avg 3.8 ms** over 55 samples (0.1–12 ms). Cheap. "Keeping bulk in WASM + explicit transfer" works.
- `decode_region_downsample_ms` (the decode work for requested pixels): **avg 542 ms** (344–912 ms). This is mostly the WASM/libjxl decode cost itself for the region (mapped from tiled_* metrics). Explains why JXTC total << region_downsample avg — JXTC only decodes needed tiles.
- `decode_toarraybuffer_ms`: not visible (this bench uses direct createDecoder, not the worker + DecodeHandler path).

**Key WASM lessons from the numbers**:
- The handoff/extract/ownership transfer is *not* the bottleneck (few ms). The win from "region" strategies is avoiding decode work on unneeded pixels.
- Full-file "long load" (the user pain point) is almost entirely the WASM decode compute for the whole image + final extract + (for crops) JS-side crop. Even when `region` is passed to the standard progressive decoder, many paths still do full decode then crop in JS (facade `eventsProgressive` + `takeAndWrap` + `applyRegionAndDownsample`; `cppDidCrop` only in oneShot path today).
- Tile region has extra ~1.1–1.5 s overhead (tile grid/assembly) on top of its decode work.
- JXTC wins big because the container + offset index lets the decoder seek to only the relevant independent tile streams with minimal libjxl work.
- Progressive + `emitEveryPass: true` + low `progressionTarget` ("dc"/"pass") already hides perceived latency for full loads in production paths (jxl-decode-worker, progressive gallery sessions).

**Production main paths today (post P3.3 light exposure)**:
- Lightbox/gallery thumbs + full opens (via `pool.decodeJxl` → dedicated `jxl-decode-worker.js`): already progressive + `emitEveryPass: true`, `region: null`, `downsample: 1`. Good for perceived full-file perf.
- Subject/crop focus: still full decode then canvas crop/zoom (`decodeFullJxlFor` + `focusOnRegion`).
- The measurement vehicle (`jxl-crop-benchmark.html`) exercises all three strategies + emits the handoff tables automatically on "Copy MD".
- JXTC/tiled fns are present and exercised in facade + crop bench (`decodeTiledRegionRgba8`, `decodeTileContainerRegionRgba8`, encode counterparts). Not yet defaulted in gallery encode/decode for assets that have `_crop`/`_subjects`.

See: `docs/boundary-cost-audit.md` §13 (full tables, per-file rows, actionables list, the exact pasted 11-file report), `docs/suggested-settings.md` (the "Decode Strategy" section we added in closeout), `web/jxl-crop-benchmark.js` (the collector + `copyCropResultsMd` that made reports self-describing), `web/jxl-decode-worker.js` and `web/jxl-progressive.js` (the comments added for visibility).

---

## 3. WASM-Specific Costs & Why Native Can (Must) Do Better

Browser/WASM cost model that drove the data:
- Every pixel buffer that crosses JS↔WASM: malloc + HEAP.set (or glue copy on return) + later possible slice in toArrayBuffer + postMessage transfer (detach).
- `take_rgba` vs JS path: 4× buffer return + glue copy vs 3× + V8 conversion. Environment-specific (Node-targeted harness liked take; real Chromium + session pipeline did not).
- Progressive region: still often pays full decode cost because early-crop isn't plumbed everywhere; JS crop after extract is "free" relative to decode but the decode work was wasted.
- Decode handoff: the 3.8 ms extract is the *visible* boundary; the hundreds of ms are inside WASM for the pixels that were asked for.

Native (Tauri / direct Rust):
- No heap boundary for RAW→JXL inside the same process: raw-pipeline can produce a buffer that libjxl encoder consumes directly (or with a single small view).
- Region decode: libjxl's `JxlDecoderSetCropEnabled` / frame-box aware paths + the existing C++ region fns (`jxl_wasm_decode_*_region`, tiled, JXTC) can be called directly from Rust without any extract/copy to "JS". Always-zero-copy region is possible for the final consumer.
- Progressive: same libjxl progression events, but you can paint the low-res DC/pass directly into a Tauri surface / texture without the worker hop or ArrayBuffer transfer tax. Full-file perceived latency can be even lower.
- Ownership: Vecs stay in Rust; you decide when (or if) to hand a view or owned pixels to the UI layer.
- Metrics: you can log the same `onMetric` names (or equivalent) plus native-only (source_pixels_decoded will be authoritative; no "proxy" needed).

**Do not repeat**:
- The browser A/B for `take_rgba` preference.
- Instrumenting "boundary extract ms" as a primary target (it was already cheap).
- Assuming "full decode then crop" is acceptable for ROIs just because the JS crop was fast.

---

## 4. Concrete Recommendations for Tauri to Reach / Exceed WASM Parity

### 4.1 Encode (RAW → JXL)
- Implement / prefer a direct-RGBA production path inside `crates/raw-pipeline` (the Phase 2B idea). This is now higher-leverage in native than it was in browser.
- Keep the `take_rgba` / `rgba` surface on `ProcessResult` (or equivalent) for callers that want the ownership move without retaining RGB.
- For pure "decode RAW → encode JXL, discard pixels" flows in Tauri export/gallery ingest: wire the pipeline to feed the encoder without an intermediate owned RGB8 that then gets converted.
- Measure on the same Gobabeb 30-file set (or the P2200 set) using whatever high-fidelity harness exists on the Tauri side. Target: prep + encode time <= the best WASM "JS path" numbers, ideally better by the saved boundary copies.

### 4.2 Decode — Region/ROI (the biggest user-visible win from P3.3 data)
- **Default to JXTC/tiled ROI when available for crops, thumbs, subject focus, zoomed/panned lightbox views.**
  - At encode time: when a file has `_crop` or `_subjects` (or on user request), produce a JXTC container (or at least tiled JXL) so the fast path is possible later. This is the prerequisite for the 10-50× crop wins.
  - At decode time: if a region is requested *and* the bitstream is a JXTC or tiled stream, call the direct tiled/JXTC decode entrypoints (the equivalents of `decodeTileContainerRegionRgba8` / `decodeTiledRegionRgba8`). These are already implemented in the shared bridge/facade; expose them cleanly from the Tauri codec layer.
  - Fallback: standard decode + C++ region crop (the `_region` fns) or full + crop. Emit a metric when you fall back so you can see how often the fast path is available.
- For lightbox "focus on subject" and crop tool thumbs: pass the normalized subject rect (or pixel rect at current decode res) down to the decoder instead of decoding full then cropping on canvas. This directly attacks the "full file load" cost for the common case of viewing a sub-region.

### 4.3 Decode — Full Loads / Gallery / Lightbox Open
- Use progressive decode (same `progressionTarget` / `emitEveryPass` / `progressiveDetail` controls) to deliver DC or early-pass low-res as soon as possible, then refine.
- Paint the early frames immediately (Tauri texture / egui / whatever surface). This can beat the WASM perceived latency because there is no worker hop.
- Consider default initial `downsample: 2` or `4` for the very first paint of huge files, then refine on demand or on zoom.
- The ~2.5–3 s full-file wall time in WASM is mostly unavoidable compute for the whole image on the libjxl side; native can only win on plumbing + perceived (progressive) + skipping work for regions.

### 4.4 Decode Pixel Handoff / Ownership (the cheap part)
- The WASM side already has efficient "grow-only + MakeBufferFromOwned" transfer (see `bridge.cpp` comments around `jxl_wasm_dec_take_flushed` / `take_final` and facade `takeAndWrap` / `readBufferView`).
- In native: keep decoded pixels (or flushed progressive buffers) in Rust-owned memory as long as possible. Only allocate the final UI-visible buffer at the last moment, or use zero-copy views into the decoder's output when the surface can consume it directly.
- If you surface the same metric names (`decode_buffer_extract_ms` etc.) for apples-to-apples, expect the "extract" number to be near zero or just the final blit cost.

### 4.5 Shared / Measurement
- Wire the same `onMetric` / `CodecMetric` hooks that the WASM facade emits (`decode_buffer_extract_ms`, `decode_region_downsample_ms`, `source_pixels_decoded`, `full_decoder_*`, tiled/jxtc_* variants, etc.). This lets you compare runs on identical files using the crop benchmark style reports or a Tauri equivalent.
- Port (or share) the crop benchmark logic so you can run "Tile vs JXTC vs Full-then-crop" (or the native equivalents) on the same 11-file set and produce comparable MD/JSON.
- Update `docs/suggested-settings.md` (or add a Tauri-specific section) once you have native numbers.
- The `crates/raw-pipeline` + direct libjxl bindings are the place for the "always prefer efficient path" logic. The JS scheduler/session/worker layers (preemption, dedup, backpressure, progressive policy) have no direct equivalent cost in native — you get to keep the good parts (progressive streaming, region awareness) without the orchestration tax.

### 4.6 Avoid / De-prioritize (browser-only artifacts)
- Replicating the full `take_rgba` vs JS conversion A/B and its harnesses as the default choice.
- Adding "pixel buffer pools for output" in the native path (the transfer/detach issues were WASM+worker specific; native Vec reuse is already straightforward).
- Treating `buffer_extract` time as a primary optimization target.
- Forcing every decode through the progressive session machinery if a direct one-shot + region is cheaper for a given use (Tauri can choose per-call).

---

## 5. Key Files & Cross-References (Start Here)

**Living strategic record**
- `docs/boundary-cost-audit.md` — especially §12 (30-file encode), §13 (11-file P3.3 crop + full actionables + handoff numbers), earlier Tier lists and traces.
- `docs/suggested-settings.md` — the canonical "what to do in browser" + the new "Decode Strategy" section for crops vs full. Update this (or add Tauri subsection) with native data.
- `docs/HANDOFF-boundary-cost-audit-2026.md` — the prior campaign handoff (historical).

**Measurement / validation (use these to prove parity)**
- `web/jxl-crop-benchmark.html` + `.js` — the page + collector that produced the data driving the settings. Run equivalent on Tauri; the MD export now includes the Decode Pixel Handoff table automatically.
- `benchmark/session-worker-timings-browser.js` (and the .mjs orchestrators) — high-fidelity encode path timings (the ones that proved the take regression).
- `benchmark/runs/*.json` from the Gobabeb and crop runs (reference data).

**WASM implementation (the "new improvements" Tauri should match or beat directly)**
- `src/lib.rs` — current `ProcessResult`, `take_*`, `rgb_to_rgba` (post-simplification).
- `packages/jxl-wasm/src/facade.ts` — `createDecoder`, eventsProgressive / oneShot paths, applyRegionAndDownsample, decodeTiledRegionRgba8, decodeTileContainerRegionRgba8, the onMetric emission points, JxlDecoder wrapper.
- `packages/jxl-wasm/src/bridge.cpp` — JxlWasmDecState, MakeBufferFromOwned, the region/tiled/JXTC C++ fns, grow-only buffers, early crop (cppDidCrop).
- `packages/jxl-worker-browser/src/decode-handler.ts` — toArrayBuffer (the defensive copy point), postMessage transfer discipline, budget, pause/resume.
- `packages/jxl-session/src/decode-session.ts` + `packages/jxl-scheduler/src/scheduler.ts` — the public DecodeSession + preemption/dedup/backpressure (the "intelligence"; native may not need the full scheduler but can reuse policy ideas).
- `web/jxl-decode-worker.js` — current production decode path for lightbox (progressive createDecoder call site).
- `web/jxl-progressive.js` — session-based progressive streaming used by gallery.

**Other**
- `crates/raw-pipeline` (the shared tone/convert/demosaic that both WASM and Tauri use) — this is where direct-RGBA and any "always efficient" defaults belong.
- `docs/rejected optimizations.md` — read before proposing anything that was already considered and discarded on the WASM side.

---

## 6. Immediate Next Steps (Suggested Order)

1. Read §13 of the audit + the Decode Strategy section of suggested-settings end-to-end. Look at one of the pasted crop MD reports to internalize the numbers.
2. Stand up (or reuse) a Tauri-side timing harness that can run the same 30-file Gobabeb set and the 11-file P2200 set, emitting comparable metrics (rgbaPrep or equivalent, full decode wall, region decode times, any handoff/extract costs).
3. Implement the direct-RGBA production experiment in raw-pipeline + wire a caller that measures it head-to-head with the current take_rgb + convert path. Record in suggested-settings.
4. Wire JXTC/tiled production for files that carry crop/subject sidecars (or on demand). Then wire the corresponding ROI decode in the Tauri lightbox / thumb / subject paths. Re-run the crop-benchmark equivalent and show JXTC numbers beating the WASM ones (or at least matching the "9-15 ms for 128 px" class).
5. Make progressive the default for full-res opens in the Tauri lightbox/gallery, with immediate paint of early passes. Measure time-to-first-useful-pixels vs the old one-shot path.
6. Add the same onMetric surface (or a Tauri-native equivalent) so future comparisons are apples-to-apples.
7. Update the audit + suggested-settings with the native results. Close the loop on "parity achieved / exceeded".

---

## 7. Guiding Principles (Carry These Forward)

- **Data over taste**: Every preference in suggested-settings came from real multi-file runs on real hardware. Do the same for native.
- **Different cost model**: What was expensive in browser (boundary copies, glue, transfers) is free or different in native. Re-evaluate every "recommended" path.
- **Share the efficient core**: raw-pipeline + the libjxl bridge functions (region, tiled, JXTC, progressive flush) are the shared asset. The JS scheduler/facade glue is WASM-only scaffolding.
- **Keep the measurement loop tight**: The crop benchmark's "select files → generate tiled/JXTC → run → Copy MD" iteration speed is what let us act on the 11-file data quickly. Replicate that speed for Tauri.
- **Surgical + verified**: Same rules as the WASM campaign. No speculative refactors. Verify on the real files.

**You now have everything the WASM side learned the hard way.** Go make the native side the obvious winner on the same workloads.

— Grok (post P3.3 closeout)