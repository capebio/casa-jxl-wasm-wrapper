# P3.1 — Production Lightbox Progressive JXL Decoder

**Date:** 2026-06  
**Status:** Design Approved  
**Phase:** P3.1 (Progressive First Paint)  
**Owner:** Grok (per handoff)  
**Related Documents:**
- Original Handoff: `docs/handoff-p3-lightbox-jxl-decoder.md`
- Lightbox Implementation Decisions: `docs/lightbox-impl-decisions.md`

---

## 1. Goal & Success Criteria

**Primary Goal**  
Wire the project's high-quality JXL decoder (`createDecoder` from `@casabio/jxl-wasm`) into the production lightbox (the one used in `web/index.html` + Tauri desktop) so that JXL content benefits from progressive decoding, delivering early usable pixels instead of waiting for a full one-shot decode.

**Minimum Shippable Success Criteria for P3.1**

- When the lightbox shows a JXL source (or standalone `.jxl`), the first paint is a DC or early progressive pass (using `progressiveDetail: 'lastPasses'`) instead of waiting for a full one-shot decode.
- Progressive refinement continues in the background while the user pans, zooms, or interacts with the straighten slider.
- The existing source cycling (RAW / JXL / JPEG), live editing (`lightbox_live`), straighten post-processing, and filmstrip multi-select continue to work without regression.
- Clear, automatic graceful fallback to the current jsquash one-shot path when the advanced decoder is unavailable or fails.
- The three cache policies are wired and produce the expected behavior:
  - Visible lightbox paint → `'onFirstProgress'`
  - Background prefetch → `'onFinal'`
  - `decodeFullJxlFor` (crop.js) → `'onFinal'`
- Measurable improvement in "time to first useful pixels" on large files (demonstrable via manual timing or existing benchmark mindset).

---

## 2. Scope and Non-Goals (P3.1 Only)

**In Scope**
- Replace the one-shot jsquash path for JXL sources in the production lightbox with progressive streaming from the real decoder.
- Implement a per-request cache policy system (`'onFirstProgress'`, `'onFinal'`, `'never'`) with the locked defaults above.
- Upgrade the dedicated `jxl-decode-worker.js` to support progressive delivery while preserving isolation from heavy encoding work.
- Keep all changes surgical and backward-compatible for existing call sites.

**Explicitly Out of Scope for P3.1**
- Viewport / ROI / region decode on zoom or pan (P3.2).
- JXTC (tiled container) fast-path (P3.3).
- Animated JXL multi-frame navigation.
- JXL container embedded previews as first paint.
- Any changes to the main encoder worker (`jxl-worker.js`) or the full `jxl-session` / scheduler stack.
- Exposing the policy flag in user-facing UI.
- Heavy cancellation protocol or explicit abort messages to the worker.

**Note on JXTC**  
Even for full-size decodes (no region), JXTC-encoded files can show faster wall-time completion and better progressive behavior due to tiled parallelism and improved memory access patterns in libjxl. However, the *highest-leverage* benefit of JXTC occurs when combined with region/ROI requests during zoom and pan. Therefore JXTC integration is deliberately deferred to P3.2/P3.3.

---

## 3. Background and Current State

The production lightbox JXL path currently routes through:
- `drawLightboxForCard()` (mode === 'jxl')
- `pool.decodeJxl(url, callback, priority)`
- Dedicated `web/jxl-decode-worker.js` using jsquash one-shot decode

This forces a full decode before any pixels are shown. The high-quality progressive implementation (`createDecoder` + `emitEveryPass`) exists and is battle-tested in lab pages (`jxl-progressive-paint.js`, crop benchmark, etc.) and inside `jxl-worker.js`, but has not yet been wired into the real user-facing lightbox.

---

## 4. Design Decisions

### 4.1 Overall Approach — Alpha (Locked)

Upgrade the *existing dedicated* `jxl-decode-worker.js` to use the real decoder for progressive requests. The worker acts as a thin progressive delivery pipe. All policy decisions and lightbox-specific paint logic remain on the main thread in `main.js`.

This was chosen over:
- Bypassing the dedicated worker entirely (loses isolation contract).
- Creating a third worker.
- Moving policy logic into the worker.

### 4.2 Cache Policy System (Locked)

Three policies, passed per-request via `pool.decodeJxl(url, callback, priority, options)`:

- `'onFirstProgress'`: Write `card._jxlDecoded` on the first usable progress frame. Used for the visible lightbox paint path.
- `'onFinal'`: Only write on the final frame. Used for prefetch and `decodeFullJxlFor`.
- `'never'`: Never write the shared cache from this path.

**Default mapping (locked):**
- Visible lightbox (`drawLightboxForCard`, high priority): `'onFirstProgress'`
- Prefetch: `'onFinal'`
- `decodeFullJxlFor` (crop.js): `'onFinal'`

A prominent comment must exist next to the policy application logic noting that the default behavior may change and that the flag exists to keep the difference controllable.

### 4.3 Message Protocol (Locked — Section 1)

**Request** (from pool to worker):
```js
{
  type: 'decode_jxl',
  decodeId,
  url,
  progressive: true,
  cachePolicy: '...',
  progressiveDetail?: 'lastPasses' | ...
}
```

**Responses**:
- `jxl_progress` (multiple times, with `isFinal` flag)
- `jxl_decoded` (legacy shape, emitted on final for compatibility)
- `decode_error`

The worker never interprets `cachePolicy`.

### 4.4 Main-Thread Behavior (Locked — Section 2)

- Policy applicator lives in one narrow place in the response handling path.
- Every `jxl_progress` for the current lightbox card triggers paint + `setCleanCanvas` + `applyStraightenToLightboxCanvas` + `syncZoomToDisplayLong`.
- The early cache write under `'onFirstProgress'` enables responsive straighten/zoom during refinement.
- Live `lightbox_live` paints continue to take precedence and are unaffected.

### 4.5 Worker Implementation (Locked — Section 4)

- Uses `import { createDecoder } from '../packages/jxl-wasm/dist/index.js'` (same pattern as `jxl-worker.js`).
- `progressive: true` → attempt real progressive decode with `emitEveryPass: true` and `progressiveDetail: 'lastPasses'` (or passed value).
- Try/catch around progressive path with automatic fallback to the existing jsquash one-shot code.
- Posts `jxl_progress` for every frame + legacy `jxl_decoded` on final.
- Remains small and focused. No card state or policy logic.

### 4.6 Pool / API Surface (Locked — Section 3)

- `decodeJxl(url, callback, priority = 'normal', options = {})` — fully backward compatible.
- Queue items carry the options.
- Response routing calls the policy applicator then invokes the original callback (which may now be called multiple times for progressive requests).
- Existing guards (`lightboxIndex` + card identity checks) remain the primary cancellation mechanism.

---

## 5. Verification Strategy

### 5.1 Required Demonstrations

- Early progressive paint visible on large JXLs in the production lightbox.
- Refinement continues during straighten, pan, zoom, and live editing.
- All three policy behaviors produce the expected cache population timing.
- No regressions across source cycling, filmstrip, crop tool, and live updates.
- Automatic fallback to jsquash when the real decoder is unavailable.

### 5.2 Testing Approach

- Manual testing in browser + Tauri desktop with small and very large JXL files.
- Exercise the three distinct call sites.
- Use the progressive paint lab as a behavioral reference.
- Keep the ability to force the old path for direct A/B comparison.
- No new automated test files required for the initial delivery.

### 5.3 Completion Criteria

P3.1 is complete when the success criteria in Section 1 are met, the required comment about policy changeability exists in the code, and the change has been documented in this design spec.

---

## 6. Risks and Mitigations

- **Risk**: Multiple callback invocations per decode break existing code.  
  **Mitigation**: All current lightbox callbacks already contain defensive "is this still the current card?" guards.

- **Risk**: Early straighten on low-quality progressive frames looks bad.  
  **Mitigation**: This is the accepted behavior for `'onFirstProgress'`; the policy flag allows future adjustment.

- **Risk**: Worker grows too large or complex.  
  **Mitigation**: Strict adherence to the "thin pipe" model defined in this spec.

---

## 7. Deferred Work (Future Phases)

- **P3.2**: Viewport/ROI awareness (`region` + `downsample` on zoom/pan). This is the phase where efficient partial decoding becomes possible.
- **P3.3**: JXTC integration, container previews, animated JXL support, and decode strategy UI.
- Explicit worker cancellation protocol (only if profiling shows significant wasted work).

---

## 8. Open Questions / Future Considerations

- Should `'onFirstProgress'` remain the default for visible lightbox use long-term, or should we move to a more conservative default?
- When should we expose the policy flag (or a "Decode full quality" affordance) to power users doing heavy editing on JXL sources?
- Will we eventually want a small debug badge showing decode strategy / passes / bytes (as hinted in the original handoff)?

---

**Document Status**  
All major design sections (1–5) were reviewed and approved incrementally during the design process. This document consolidates those decisions into a single reviewable artifact.

**Next Step**  
Transition to implementation planning only after user review and approval of this document.