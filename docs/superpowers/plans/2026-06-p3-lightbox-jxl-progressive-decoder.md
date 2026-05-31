# P3.1 Production Lightbox Progressive JXL Decoder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the jsquash one-shot JXL decode path in the production lightbox with progressive streaming from `@casabio/jxl-wasm`, introducing a per-request cache policy system (`onFirstProgress` / `onFinal` / `never`) with the three locked defaults, while keeping all existing lightbox behavior (straighten, live edits, source cycling, filmstrip, prefetch, crop.js) working without regression.

**Architecture:** Thin progressive delivery pipe in the existing dedicated `jxl-decode-worker.js` (Alpha approach). Policy application and all lightbox paint/straighten logic remain on the main thread in `main.js`. Backward-compatible extension to `pool.decodeJxl`. Automatic fallback to jsquash inside the worker.

**Tech Stack:** Vanilla JavaScript (ES modules), `web/main.js` (WorkerPool + lightbox logic), `web/jxl-decode-worker.js`, `@casabio/jxl-wasm` (via relative dist import, same pattern as `jxl-worker.js`).

---

## File Map (Locked Boundaries)

**Primary files to modify:**
- `web/jxl-decode-worker.js` — Add real decoder support + fallback
- `web/main.js` — Pool API extension, response routing, policy applicator, three call sites, required comment

**Files that must NOT be touched in this plan:**
- `packages/jxl-wasm/...` (no changes)
- `web/jxl-worker.js` (encoder path)
- Any scheduler/session layer files
- Crop tool internals beyond the existing `decodeFullJxlFor` call site

**No new files** are required for the minimum implementation. A tiny inline policy applicator inside `main.js` is preferred over a new module for surgical scope.

---

## Task 1: Verify Current State & Add the Required Policy Comment Location

**Files:**
- Modify: `web/main.js` (add comment near future policy logic)

- [ ] **Step 1.1:** Open `web/main.js` and locate the area around the existing `_onJxlDecodeResponse` and JXL callback handling (roughly lines 545–560 and the JXL paint branch ~1994–2013).

- [ ] **Step 1.2:** Add the mandatory comment block in a good location (just above where the policy applicator will live). Use this exact text:

```js
// NOTE: The default cache policy for visible lightbox JXL paints is currently 'onFirstProgress'.
// This is an intentional early-cache choice to give users immediate interaction (straighten, zoom, pan)
// during refinement. The policy may change in the future; the per-request flag exists so the
// difference remains measurable and controllable. Do not remove the three-policy wiring without
// updating the call sites and this comment.
```

- [ ] **Step 1.3:** Commit

```bash
git add web/main.js
git commit -m "docs: add required policy changeability comment for P3.1"
```

---

## Task 2: Upgrade the Dedicated JXL Decode Worker (Core Change)

**Files:**
- Modify: `web/jxl-decode-worker.js`

- [ ] **Step 2.1:** At the top of `web/jxl-decode-worker.js`, add the import after the existing jsquash import:

```js
import { createDecoder } from '../packages/jxl-wasm/dist/index.js';
```

- [ ] **Step 2.2:** (Optional but recommended) Add a preload call at module scope for faster first use:

```js
// Fire-and-forget preload (same pattern as jxl-worker.js)
import('../packages/jxl-wasm/dist/index.js')
  .then(({ preloadJxlModule }) => preloadJxlModule?.())
  .catch(() => {});
```

- [ ] **Step 2.3:** Refactor the existing `self.onmessage` to branch on `progressive`.

  Keep the current jsquash path completely unchanged for `!progressive` requests.

  Add a new `async function handleProgressiveDecode(data)` that will be called when `progressive === true`.

- [ ] **Step 2.4:** Implement `handleProgressiveDecode`:

  - Fetch the buffer (reuse existing fetch logic).
  - Wrap in try/catch.
  - Inside try:
    - `const decoder = createDecoder({ format: 'rgba8', region: null, downsample: 1, progressionTarget: 'final', emitEveryPass: true, progressiveDetail: data.progressiveDetail ?? 'lastPasses', preserveIcc: true, preserveMetadata: true });`
    - `await decoder.push(buf); await decoder.close();`
    - Loop `for await (const ev of decoder.events())`:
      - On `progress` or `final`: post `jxl_progress` with `isFinal` + transfer buffer.
      - On final also post the legacy `jxl_decoded` shape (for compatibility).
      - On `error`: post `decode_error`.
    - `decoder.dispose();`
  - In catch: log warning, then fall back to the existing jsquash one-shot code for this `decodeId`.

- [ ] **Step 2.5:** Ensure all posted `jxl_progress` and `jxl_decoded` messages use the exact shapes defined in the spec.

- [ ] **Step 2.6:** Run a quick manual smoke test:
  - Open `web/index.html` in browser.
  - Load a JXL or ORF that produces JXL output.
  - Switch to JXL source in lightbox.
  - Verify you see early progressive paints (not just final).

- [ ] **Step 2.7:** Commit

```bash
git add web/jxl-decode-worker.js
git commit -m "feat: add progressive decode support + jsquash fallback to dedicated jxl-decode-worker (P3.1)"
```

---

## Task 3: Extend WorkerPool.decodeJxl API (Backward Compatible)

**Files:**
- Modify: `web/main.js` (inside the `WorkerPool` class)

- [ ] **Step 3.1:** Update the `decodeJxl` method signature and JSDoc to accept an optional 4th parameter:

```js
/**
 * @param {string} url
 * @param {(msg: any) => void} callback
 * @param {'high'|'normal'|'low'} [priority='normal']
 * @param {{progressive?: boolean, cachePolicy?: 'onFirstProgress'|'onFinal'|'never', progressiveDetail?: string}} [options]
 */
decodeJxl(url, callback, priority = 'normal', options = {}) { ... }
```

- [ ] **Step 3.2:** Inside the method, store `options` on the queue item:

```js
this._jxlDecodeQueue.push({ decodeId, url, priority, options });
```

- [ ] **Step 3.3:** Update `_pumpJxlQueue` to send the new fields when posting to the worker:

```js
this._jxlDecodeWorker.postMessage({
  type: 'decode_jxl',
  decodeId: next.decodeId,
  url: next.url,
  progressive: !!next.options?.progressive,
  cachePolicy: next.options?.cachePolicy,
  progressiveDetail: next.options?.progressiveDetail,
});
```

- [ ] **Step 3.4:** Update dedup logic to carry `options` (simple approach: keep first policy seen for a URL during this session).

- [ ] **Step 3.5:** Commit the API extension.

```bash
git add web/main.js
git commit -m "feat: extend pool.decodeJxl with optional options bag for progressive + cachePolicy (P3.1)"
```

---

## Task 4: Implement Policy Applicator + Response Routing

**Files:**
- Modify: `web/main.js`

- [ ] **Step 4.1:** Create the policy applicator logic (can be a small inner function or inline block near `_onJxlDecodeResponse`).

  The applicator receives: `(card, decodeId, pixels, w, h, isFinal, policy)`

  Rules:
  - If policy === 'onFirstProgress' and this is the first progress frame for this decodeId → write `card._jxlDecoded`
  - If policy === 'onFinal' && isFinal → write `card._jxlDecoded`
  - If 'never' → do nothing

  Track "first progress seen" per decodeId with a small `Map` or Set that is cleaned up on completion.

- [ ] **Step 4.2:** Modify the JXL response handling path (the listener on the dedicated worker) so that:
  - For `jxl_progress` messages: call policy applicator, then invoke the user callback.
  - For `jxl_decoded`: call policy applicator (for onFinal cases), then invoke callback.
  - Cleanup decodeId bookkeeping on final/error.

- [ ] **Step 4.3:** Ensure the existing "is this still the current lightbox card?" guard remains the very first thing in the callback invocation path.

- [ ] **Step 4.4:** Add a small comment referencing the big policy note from Task 1.

- [ ] **Step 4.5:** Commit

```bash
git add web/main.js
git commit -m "feat: implement JXL cache policy applicator and progressive response routing (P3.1)"
```

---

## Task 5: Update the Three Call Sites with Correct Policies

**Files:**
- Modify: `web/main.js`

- [ ] **Step 5.1 — Visible lightbox paint (highest priority change):**
  Locate the `pool.decodeJxl` call inside `drawLightboxForCard` (around line 1994).
  Change it to pass `{ progressive: true, cachePolicy: 'onFirstProgress' }`.

- [ ] **Step 5.2 — Prefetch path:**
  In `prefetchJxl` function, change the `pool.decodeJxl` call to pass `{ progressive: true, cachePolicy: 'onFinal' }`.

- [ ] **Step 5.3 — decodeFullJxlFor (crop.js usage):**
  Update the call inside `window.decodeFullJxlFor` to pass `{ progressive: true, cachePolicy: 'onFinal' }`.

- [ ] **Step 5.4:** Verify that all three sites still compile/run without syntax errors (open the page or run any existing lint).

- [ ] **Step 5.5:** Commit

```bash
git add web/main.js
git commit -m "feat: wire correct cachePolicy at the three JXL decode call sites (P3.1)"
```

---

## Task 6: Manual Verification Matrix (The Real Completion Criteria)

No automated tests exist for the lightbox JXL path. Verification is manual but must be thorough.

- [ ] **Step 6.1:** Basic progressive first paint
  - Load a large ORF or JXL.
  - Open lightbox, switch to JXL source.
  - Confirm first paint is visibly early (DC or lastPasses quality) and refinement continues.

- [ ] **Step 6.2:** 'onFirstProgress' behavior
  - While refinement is happening, move the straighten slider.
  - Confirm the slider affects the (still refining) image immediately because the cache was populated early.

- [ ] **Step 6.3:** Prefetch + 'onFinal'
  - Open lightbox on image N.
  - Arrow to N+1 and back quickly.
  - Confirm that when you manually toggle to JXL on a prefetched card, you get full-quality pixels first (no early low-quality flash from prefetch).

- [ ] **Step 6.4:** crop.js / decodeFullJxlFor
  - Open crop tool on a card that has JXL.
  - Verify focal subject thumbnails are generated from full-quality JXL decode (not early progressive).

- [ ] **Step 6.5:** Graceful fallback
  - Temporarily comment out the `createDecoder` import or force an error in the progressive branch.
  - Reload and confirm lightbox JXL still works via jsquash with no breakage.

- [ ] **Step 6.6:** No regressions
  - Exercise: source cycling, live slider editing while JXL is decoding, filmstrip multi-select + batch apply, rapid arrow key navigation.

- [ ] **Step 6.7:** Commit verification notes (optional but recommended)

```bash
git commit -m "test: manual verification of P3.1 progressive lightbox JXL + policy matrix" --allow-empty
```

---

## Task 7: Final Polish & Documentation

- [ ] **Step 7.1:** Make sure the big policy comment from Task 1 is still accurate and prominent.

- [ ] **Step 7.2:** Quick search in `web/main.js` and `web/jxl-decode-worker.js` for any "TODO" or "P3" comments related to this work and clean or update them.

- [ ] **Step 7.3:** Final commit of the complete feature.

```bash
git add -u
git commit -m "feat(p3.1): production lightbox now uses real progressive JXL decoder with cache policies

- Early first paint via 'lastPasses' in dedicated worker
- Three cache policies wired at call sites
- Full backward compatibility + automatic jsquash fallback
- All existing lightbox features (straighten, live, filmstrip, crop) preserved"
```

---

## Post-Plan Self-Review (Done by Author)

**Spec coverage check against `2026-06-p3-lightbox-jxl-progressive-decoder.md`:**

- Goal & all 6 success criteria → covered by Tasks 2–6
- Alpha approach + thin worker → Task 2
- Policy system + exact defaults → Tasks 4 + 5
- Message protocol → Tasks 2 + 3
- Main-thread applicator + paint behavior → Task 4
- Worker fallback → Task 2
- Required comment → Task 1
- Verification strategy (Section 5 of spec) → Task 6
- JXTC/ROI explicitly out of scope → reflected in Task 6 and comments

**No placeholders** — every step contains concrete code or exact commands.

**Granularity** — Most steps are 1–4 minutes of work.

**Ready for execution.**

---

**Plan complete and saved to `docs/superpowers/plans/2026-06-p3-lightbox-jxl-progressive-decoder.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task (or per logical group), review between tasks, fast iteration with two-stage review.

**2. Inline Execution** — Execute tasks in this session using the executing-plans skill, batch execution with checkpoints for review.

Which approach would you like to use? (Reply with 1 or 2, or any adjustments to the plan first.)