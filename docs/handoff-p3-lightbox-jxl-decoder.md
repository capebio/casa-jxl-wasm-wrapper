# Handoff: P3 — Make the Production Lightbox a First-Class JXL Decoder Citizen

**Date:** 2026-06  
**Status:** Ready for execution  
**Owner of previous work:** Grok (this conversation)  
**Trigger:** User wants a clean handoff to continue P3 in a fresh tab/instance.

## 1. Goal & Success Criteria

**Primary Goal:**  
Wire the project's real high-quality JXL decoder (`createDecoder` from `@casabio/jxl-wasm`) into the **production lightbox** (the one users actually use in `web/index.html` + Tauri desktop) so that JXL content benefits from progressive decoding, previews/DC, and ROI/region/tiled decode.

**Success Criteria (minimum shippable for P3):**
- When the lightbox shows a JXL source (or a standalone `.jxl`), the first paint is a DC or early progressive pass instead of waiting for full decode.
- Progressive refinement continues in the background while the user pans, zooms, or applies looks.
- At high zoom / during pan, the decoder is given a viewport region so it does not decode the entire image.
- The existing source cycling (RAW / JXL / JPEG), live editing (Tauri `apply_look` + WASM reprocess), straighten transform, and filmstrip multi-select all continue to work without regression.
- Clear graceful fallback to the current jsquash one-shot path when the advanced decoder is unavailable.
- Measurable win in "time to first useful pixels" and memory usage on large files (can be demonstrated with the existing `lightbox_bench` mindset).

## 2. Current State (What Exists Today)

### The Production Lightbox JXL Path (the problem)
- **Entry point:** `web/main.js` — `drawLightboxForCard()` (mode === 'jxl' branch, ~1970-2015).
- When a card has `._blobUrl` and we are in JXL mode:
  - If `card._jxlDecoded` exists → instant paint from cache.
  - Else → calls `pool.decodeJxl(card._blobUrl, callback, 'high')`.
- `pool.decodeJxl` (lines ~716+) queues work and posts to the **dedicated** `jxl-decode-worker.js`.
- The worker (`web/jxl-decode-worker.js`) does:
  ```js
  import decode from './vendor/jsquash-jxl/decode.js';
  const img = await decode(buf);  // full one-shot
  postMessage({ type: 'jxl_decoded', rgba: img.data, w, h });
  ```
- Result: Full image must arrive before anything is shown. No progressive events, no region, no JXTC benefit.

### The Good Stuff That Already Exists (but is lab-only)
- **Reference implementation:** `web/jxl-progressive-paint.js` (and to a lesser extent `jxl-preset-benchmark.js`).
  - Uses `import { createDecoder } from '@casabio/jxl-wasm'`.
  - Pattern:
    ```js
    const decoder = createDecoder({
      format: 'rgba8',
      region: null,                    // <--- this becomes powerful later
      downsample: 1,
      progressionTarget: 'final',
      emitEveryPass: true,
      progressiveDetail: 'lastPasses' | 'dc' | 'passes' | 'dcProgressive',
      ...
    });
    for await (const ev of decoder.events()) {
      if (ev.type === 'progress' || ev.type === 'final') {
        // paint ev.pixels immediately (respect region if present)
      }
    }
    await decoder.push(bytes);
    await decoder.close();
    decoder.dispose();
    ```
- Full `DecoderOptions`, `Region`, `ProgressiveDetail`, `DecodeEvent` types live in `packages/jxl-wasm/src/facade.ts`.
- C++ fast region crop exists in `bridge.cpp` (`jxl_wasm_decode_*_region`).
- JXTC (tiled container) encode + decode paths exist and are validated in the crop benchmark.
- The main `web/index.html` **already has the import map** for `@casabio/jxl-wasm` (and jxl-core, jxl-session, etc.).

### Important Integration Points That Must Stay Working
- Source cycling (`cycleSourceForCard`, `updateToggleButtonState`).
- Live editing (Tauri `triggerLiveUpdateTauri` / `apply_look` → `lightbox_live` messages that paint directly).
- Straighten post-processing we just shipped (`applyStraightenToLightboxCanvas`).
- Zoom/pan state (`lbZoom`, `lbPanX/Y`, `lbDisplayLongPx`, `syncZoomToDisplayLong`).
- Filmstrip (Phase 1) + multi-select batch apply.
- `setCleanCanvas` hook used by histogram/levels.
- Prefetch/promote logic around the current lightbox image.

## 3. Recommended Phased Approach (Surgical)

Do **not** rewrite the whole decode system in one go. Suggested order:

**P3.1 — Progressive First Paint (biggest perceived win)**
- Make the high-priority lightbox JXL decode path use `createDecoder({emitEveryPass: true, progressiveDetail: 'lastPasses' or 'dc'})`.
- On first `progress` or `final` event, paint the (partial) pixels.
- Keep the existing `card._jxlDecoded` cache for instant re-opens.
- Keep the jsquash worker as a fast fallback (or deprecate it for JXL sources in the lightbox).

**P3.2 — Viewport / ROI Awareness**
- On zoom/pan changes (or periodically), compute the current visible region in image space.
- Pass `region` (and optionally `downsample`) to the decoder.
- Handle `region` in the progressive events (the API already surfaces `ev.region`).
- Re-decode the new visible region when the user pans/zooms significantly (with cancellation).

**P3.3 — JXL Container Previews + JXTC + Polish**
- When a JXL blob arrives, first try to extract/use any embedded preview/DC before (or in parallel with) full progressive decode.
- Prefer JXTC decode path when the file was produced that way (zero frame-walking overhead for ROI).
- Wire multi-frame progressive navigation for animated JXLs inside the lightbox.
- Expose a tiny "JXL decode strategy" badge or debug info in the lightbox (passes used, region size, bytes decoded, etc.).

## 4. Key Files You Will Touch

| File | Role | Notes |
|------|------|-------|
| `web/main.js` | Lightbox painting + decode call sites | The JXL branches in `drawLightboxForCard`, calls to `pool.decodeJxl`, interaction with `applyStraightenToLightboxCanvas`. |
| `web/jxl-decode-worker.js` | Current one-shot path | Likely the place to upgrade, or create a parallel progressive version. Keep it isolated (the whole point of this worker). |
| `web/main.js` (pool object) | `decodeJxl`, priority, queuing | May need new options like `progressive: true`, `onProgress`, region support. |
| `packages/jxl-wasm/src/facade.ts` | The real API | Study `createDecoder`, `DecoderOptions`, `JxlDecoder.events()`, region handling. |
| `web/jxl-progressive-paint.js` | Gold-standard reference | Copy the pattern, not the UI. |
| `web/index.html` | Import map | Already has `@casabio/jxl-wasm` — you can import directly in main context if you choose a non-worker path for some decodes. |

Also relevant (for compatibility):
- `web/crop.js` (straighten now lives here too via the geometry function we added).
- Tauri side (`src-tauri/src/pipeline.rs`) — only for understanding the "RAW is primary" policy; do not change backend unless you want native jxl-oxide region decode later.

## 5. Important Gotchas & Constraints (from prior work)

- The lightbox has **three source modes** that must coexist: `raw` (Tauri Rgb16 or WASM lightbox RGB), `jxl`, `jpeg` (embedded).
- Live editing paints **directly** onto `lightboxCanvas` via `lightbox_live` messages (see `pool.setLiveHandler`). Progressive JXL decode must not fight this.
- We just added `applyStraightenToLightboxCanvas(card)` as a post-process. Any new decoder must play nicely with it (or we may want to move straighten earlier in the pipeline later).
- Cancellation is critical — users open a lightbox and then immediately arrow to the next image. The old worker path has some dedup/priority promotion; new progressive sessions must be cancelable cleanly.
- The dedicated worker exists precisely to keep long Emscripten-pthread encodes from blocking lightbox decodes. Do not accidentally make the main pool do heavy progressive work on the UI thread.
- `card._jxlDecoded` is used as a "prefetched full decode" cache. Progressive work may want to populate it on the final pass.
- Side effects on canvas size, `setCleanCanvas`, zoom state, and filmstrip primary highlight must be preserved.

## 6. Suggested First Steps for the Next Agent

1. Read this handoff + `docs/lightbox-impl-decisions.md` (especially the P3 section and the straighten decisions).
2. Run the current lightbox with a few large JXLs and time "open → first pixels" and memory while zoomed.
3. Study the exact call sites in `main.js:1970` (JXL mode) and the pool's `decodeJxl` + `_onJxlDecodeResponse`.
4. Prototype in a throwaway branch or console: import `createDecoder` in the main context (the import map allows it) and stream a JXL progressively into the lightbox canvas. Prove the event loop works.
5. Decide the integration shape:
   - Option A (cleaner long-term): Give the dedicated `jxl-decode-worker.js` the ability to use the real decoder for progressive requests (pass options down).
   - Option B: For lightbox JXL sources, bypass the worker and do progressive decode in a high-priority web worker that has access to the WASM module.
6. Start with P3.1 only (progressive, no region yet). Get the first early pass painting while refinement continues.
7. Wire the existing `progress` / `final` events to the same painting + straighten + `setCleanCanvas` path used today.

## 7. Open Questions / Decisions for You

- Should the progressive JXL path in the lightbox still go through the dedicated worker, or can we create a new "progressive lightbox decode worker" that loads the full jxl-wasm module?
- What should the default `progressiveDetail` be for lightbox use? (`'lastPasses'` is often the sweet spot for visual quality vs latency.)
- When the user is in "JXL" source mode and does heavy slider work, do we want to switch to a full decode automatically (or give them a "Decode full for editing" button)?
- How do we surface decode strategy / stats to the user (or at least in debug mode)?

## 8. Verification Strategy

- Manual: Large ORF → JXL, open in lightbox, switch to JXL source, observe time-to-first-pixels + refinement while panning.
- Compare with current jsquash path (keep a way to force fallback).
- Zoom to 300–400% and pan aggressively — confirm memory stays reasonable and only visible area is decoded (add console metrics if needed).
- Exercise the full matrix: straighten + progressive JXL + live look + filmstrip multi-select + source cycling.
- Run existing lightbox-related tests + the progressive paint lab to ensure we didn't regress the reference implementation.

---

**You now have everything needed to execute P3 cleanly.**

Previous work (filmstrip + multi-select batch apply + live straighten slider + geometry + render post-process) is already merged into the main lightbox and must continue to function.

When you're ready, start with P3.1 (progressive first paint). The biggest user-visible win happens there.

Good luck — this is the piece that makes the lightbox actually *feel* like a JXL-native experience.