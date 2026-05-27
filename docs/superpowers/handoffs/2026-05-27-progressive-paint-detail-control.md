# Handoff — Wire `progressiveDetail` selector into `jxl-progressive-paint.html`

**Date:** 2026-05-27
**Branch:** `epiccodereview/20260527T054853`
**Predecessor commit:** `aa5408c feat(progressive): plumb progressiveDetail through DecodeOptions → worker`

---

## Context

This session plumbed `progressiveDetail` (libjxl `JxlProgressiveDetail`) end-to-end through the session/worker path so callers using `DecodeSession` (not just direct `createDecoder()`) can pick the detail level. libjxl was pinned to ≥ v0.11.2 to guarantee the upstream VarDCT progressive-decode regression fix (libjxl #4223) is present.

`web/jxl-progressive-paint.html` is the standalone test page that exercises progressive VarDCT decode end-to-end against the real WASM dist — encode → stream-in-steps → decode with `emitEveryPass=true`. It currently **derives** `progressiveDetail` from pass count (`getRequestedProgressiveDetail`) and offers no UI to override.

## Goal

Expose `progressiveDetail` as a first-class UI control on the paint test so the user can A/B `kDC` vs `kLastPasses` vs `kPasses` vs `kDCProgressive` against a real VarDCT bitstream — and see which one libjxl 0.11.2 actually fires events for on which kinds of input.

## What is already in place

| Layer | File | State |
|---|---|---|
| C bridge | `packages/jxl-wasm/src/bridge.cpp:727` | maps `progressive_detail` 1..4 → `kDC | kLastPasses | kPasses | kDCProgressive` |
| Facade | `packages/jxl-wasm/src/facade.ts:203` `resolveDecoderProgressiveDetail` | maps `ProgressiveDetail` string → 0..4 |
| `DecodeOptions` | `packages/jxl-core/src/types.ts` | `progressiveDetail?: "dc" | "lastPasses" | "passes" | "dcProgressive"` ✅ |
| `MsgDecodeStart` | `packages/jxl-core/src/protocol.ts` | `progressiveDetail: … | null` ✅ |
| Session | `packages/jxl-session/src/decode-session.ts` | maps `opts.progressiveDetail ?? null` ✅ |
| Browser worker | `packages/jxl-worker-browser/src/decode-handler.ts` | forwards when non-null ✅ |
| Node worker | `packages/jxl-worker-node/src/decode-handler.ts` | forwards when non-null ✅ |
| Paint page **JS** | `web/jxl-progressive-paint.js:416` | uses `getRequestedProgressiveDetail(stepCount)` — `stepCount>=6 → "passes"`, `>=4 → "lastPasses"`, else `"dc"` |
| Paint page **HTML** | `web/jxl-progressive-paint.html` | no `progressiveDetail` UI |

The paint page already calls `createDecoder({ ..., progressiveDetail })` directly (facade, not session) at `web/jxl-progressive-paint.js:457-466`. The recently-added VarDCT round-trip test (`packages/jxl-wasm/test/progressive-detail.test.ts`) exercises the same path against the WASM dist and passes.

## What still needs doing

### 1. Add detail selector to HTML

Insert a fourth `prog-option-group` after the existing `Passes` group (`web/jxl-progressive-paint.html` around line 101). Default to `auto` so existing behaviour is preserved when nothing is touched. **Note:** DC + AC (`kDCProgressive`) is not available in libjxl v0.11.2 (the pinned version); only Auto, DC, Last passes, and All passes are exposed:

```html
<div class="prog-option-group">
    <span class="prog-setting-label">Detail:</span>
    <div class="prog-radio-group">
        <label class="prog-radio-btn"><input type="radio" name="prog-detail" value="auto" checked /> Auto</label>
        <label class="prog-radio-btn"><input type="radio" name="prog-detail" value="dc" /> DC</label>
        <label class="prog-radio-btn"><input type="radio" name="prog-detail" value="lastPasses" /> Last passes</label>
        <label class="prog-radio-btn"><input type="radio" name="prog-detail" value="passes" /> All passes</label>
    </div>
    <!-- Note: DC + AC (kDCProgressive) not available in libjxl v0.11.2; may be added in future version -->
</div>
```

No new CSS — `prog-option-group` / `prog-radio-group` / `prog-radio-btn` already styled in `web/jxl-progressive-paint.css`.

### 2. Wire selector in `web/jxl-progressive-paint.js`

Replace lines 416–418 in `runProgressivePaintTest()`:

```js
const progressiveDetail = getRequestedProgressiveDetail(requestedPassCount);
const previewFirst = !!(document.getElementById('prog-preview-first')?.checked);
const progressiveFlavor = getRequestedProgressiveFlavor(requestedPassCount, previewFirst);
```

with:

```js
const detailChoice = document.querySelector('input[name="prog-detail"]:checked')?.value ?? 'auto';
const progressiveDetail = detailChoice === 'auto'
    ? getRequestedProgressiveDetail(requestedPassCount)
    : detailChoice;
const previewFirst = !!(document.getElementById('prog-preview-first')?.checked);
const progressiveFlavor = getRequestedProgressiveFlavor(requestedPassCount, previewFirst);
```

The existing `getRequestedProgressiveDetail` helper (lines 230–234) stays — it is the implementation of the `auto` policy.

### 3. Update the comparison panel caption

`renderProgressiveComparison` at `web/jxl-progressive-paint.js:374` already accepts `progressiveDetail` and prints `detail=${progressiveDetail}` at line 397. Nothing to change — it will pick up the user-chosen value automatically.

### 4. Encoder coupling — careful

The encoder is configured at `web/jxl-progressive-paint.js:425-439` with `progressiveFlavor` derived from pass count + preview-first. Decoder detail level and encoder progressive flavor are **independent** in libjxl, but they interact:

- `progressiveFlavor='dc'` → encoder writes DC only, no AC passes → `progressiveDetail='passes'` or `'lastPasses'` on decode will yield 0 progress events (just final).
- `progressiveFlavor='ac'` → encoder writes DC + multiple AC passes → all four detail levels are meaningful.

Decide whether to:
- **(a)** leave the encoder alone (user has to also tick `Preview 1st` or pick ≥3 passes to get AC); or
- **(b)** auto-upgrade `progressiveFlavor` to `'ac'` when detail is anything other than `'auto'` or `'dc'`.

Option **(b)** matches what users will expect ("if I picked Last passes I want to see passes"). Suggested implementation:

```js
const progressiveFlavor = (detailChoice !== 'auto' && detailChoice !== 'dc')
    ? 'ac'
    : getRequestedProgressiveFlavor(requestedPassCount, previewFirst);
```

### 5. Add a "passes observed" counter to the result row

Currently the comparison table shows `passCount` (number of progress + final events). When `progressiveDetail='dc'` this will be 2 (DC + final); when `'passes'` on a noisy VarDCT image, expect 3–5. This is the most useful number to surface for "did libjxl 0.11.2's fix actually do anything?" diagnostics. Already wired — no change needed, just make sure the user knows where to look.

### 6. Tests to add

`web/jxl-progressive-paint-page.test.js` (string-grep style — same pattern as existing tests). Note: omit `dcProgressive` since `kDCProgressive` is not available in libjxl v0.11.2:

```js
const html = readFileSync(new URL('./jxl-progressive-paint.html', import.meta.url), 'utf8');
expect(html).toContain('name="prog-detail"');
expect(html).toContain('value="auto"');
expect(html).toContain('value="dc"');
expect(html).toContain('value="lastPasses"');
expect(html).toContain('value="passes"');

const js = readFileSync(new URL('./jxl-progressive-paint.js', import.meta.url), 'utf8');
expect(js).toContain('input[name="prog-detail"]:checked');
```

No functional test needed — the WASM-level round-trip is covered by `packages/jxl-wasm/test/progressive-detail.test.ts`.

### 7. Browser verification

Run `bun serve.ts`, open `http://localhost:9000/web/jxl-progressive-paint.html`, then:

1. Load a random Gobabeb ORF (or any 8MP+ image — small images often produce only 1–2 passes).
2. Size: 1920. Quality: 85. Passes: 4. **Detail: All passes**. **Preview 1st**: on.
3. Run. Expect ≥ 3 entries in the timeline strip; first one labelled `stage=dc`, rest `stage=pass`.
4. Re-run with **Detail: DC** — expect exactly 2 entries (1 partial + 1 final).
5. Re-run with **Detail: Last passes** on a high-quality / large image — expect fewer entries than `All passes`, biased to later in the stream (closer to final-frame quality).

Document any observation surprises (e.g. `dcProgressive` collapsing to a single event on small images) inline in `web/jxl-progressive-paint.html` near the new control as a `panel-note`.

## Non-obvious gotchas

- **`progressionTarget` stays `'final'`.** Do NOT set it to `'pass'` — the user wants every pass *and* the final frame, which only `emitEveryPass=true` + `progressionTarget='final'` produces.
- **Direct facade path, not session.** The paint page calls `createDecoder()` from `@casabio/jxl-wasm` directly, not via `DecodeSessionImpl`. The session-path plumbing landed in `aa5408c` exists for `web/jxl-progressive.js` (the other progressive page) and any future caller — it is **not** used by the paint page. Don't get confused; both paths now support `progressiveDetail` independently.
- **Encoder progressiveFlavor is per-frame at encode time.** Changing it requires a re-encode, which the run button already does. No staleness risk.
- **WASM detail flag bit.** `bridge.cpp:732` adds `JXL_DEC_FRAME_PROGRESSION` to the event mask **only** when `progressive_detail != 0`. Facade returns 0 when `progressionTarget==='header'` or when `progressionTarget==='final' && !emitEveryPass`. Paint page never hits either — safe.
- **No transferred-buffer concerns.** `makePassCanvas` (line 271) clones via `new Uint8ClampedArray(arr.buffer, …)`, but the underlying pixels were never detached (facade keeps ownership during the `for await` loop). Existing behaviour is correct; no changes needed.

## Files this handoff expects you to touch

- `web/jxl-progressive-paint.html` — add radio group
- `web/jxl-progressive-paint.js` — read selector, conditionally pin `progressiveFlavor='ac'`
- `web/jxl-progressive-paint-page.test.js` — string-grep asserts
- (optional) `docs/Overview and features of the CasaWASM JXL wrapper.md` — update the Progressive Paint Test Page bullet at line 115 to mention the detail selector

## Verification before commit

```bash
bun test web/jxl-progressive-paint-page.test.js
bun test packages/jxl-wasm/test/progressive-detail.test.ts   # regression guard
bun serve.ts   # then exercise the page per §7 above
```

## Out of scope

- Surfacing `progressiveDetail` on `web/jxl-progressive.js` (the other page, w/ thumb bench). Could be added later; same pattern.
- Functional `≥ N progress events` assertion in the WASM test. Today's test asserts round-trip only; libjxl event counts vary by image and are not stable enough to assert in CI.
- libjxl version bump beyond v0.11.2 (already pinned at floor in `packages/jxl-wasm/scripts/build.mjs`).
