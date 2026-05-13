# Lightbox 3-Way Source Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add RAW / JXL / JPEG 3-way source toggle to lightbox with ↑↓ keys and a large centered flash label on every switch.

**Architecture:** Migrate `card._showJpeg: boolean` → `card._sourceMode: 'raw' | 'jxl' | 'jpeg'`. JXL decode is async via jxl-worker (add decode_jxl message type alongside existing encode). A new full-screen overlay div fades in/out on every source switch. Arrow keys ↑↓ cycle sources; spacebar cycles forward; ←→ keep navigating photos.

**Tech Stack:** Vanilla JS, jSquash JXL decoder (already in node_modules), CSS keyframe animation, existing worker pool.

---

## File Map

| File | Change |
|------|--------|
| `web/vendor/jsquash-jxl/codec/dec/jxl_dec.js` | Copy from node_modules |
| `web/vendor/jsquash-jxl/codec/dec/jxl_dec.wasm` | Copy from node_modules |
| `web/vendor/jsquash-jxl/decode.js` | Copy from node_modules |
| `web/jxl-worker.js` | Add `decode_jxl` message handler + decode import |
| `web/main.js` | Migrate state, add cycleSourceForCard, pool.decodeJxl, keyboard, label |
| `web/index.html` | Add `#lb-source-label` div inside `.lightbox-viewport` |
| `web/style.css` | Add `#lb-source-label` styles + `@keyframes lb-source-flash` |

---

### Task 1: Copy JXL decoder assets to vendor

**Files:**
- Create: `web/vendor/jsquash-jxl/codec/dec/jxl_dec.js`
- Create: `web/vendor/jsquash-jxl/codec/dec/jxl_dec.wasm`
- Create: `web/vendor/jsquash-jxl/decode.js`

- [ ] **Step 1: Copy decoder files**

```bash
cp node_modules/@jsquash/jxl/codec/dec/jxl_dec.js web/vendor/jsquash-jxl/codec/dec/jxl_dec.js
cp node_modules/@jsquash/jxl/codec/dec/jxl_dec.wasm web/vendor/jsquash-jxl/codec/dec/jxl_dec.wasm
cp node_modules/@jsquash/jxl/decode.js web/vendor/jsquash-jxl/decode.js
```

- [ ] **Step 2: Fix import path in decode.js**

`node_modules` version imports from `'./codec/dec/jxl_dec.js'` and `'./utils.js'` — those paths are correct for the vendor location. Verify:

```bash
head -5 web/vendor/jsquash-jxl/decode.js
```

Expected output includes:
```
import jxlDecoder from './codec/dec/jxl_dec.js';
import { initEmscriptenModule } from './utils.js';
```

If paths differ, update them to match the above.

- [ ] **Step 3: Commit**

```bash
git add web/vendor/jsquash-jxl/codec/dec/ web/vendor/jsquash-jxl/decode.js
git commit -m "chore: vendor jSquash JXL decoder (dec WASM + decode.js)"
```

---

### Task 2: Add decode_jxl handler to jxl-worker.js

**Files:**
- Modify: `web/jxl-worker.js`

- [ ] **Step 1: Add decoder import at top of jxl-worker.js**

After the existing imports, add:

```js
import decode from './vendor/jsquash-jxl/decode.js';
```

Full top of file should look like:

```js
import { initEmscriptenModule } from './vendor/jsquash-jxl/utils.js';
import { defaultOptions }        from './vendor/jsquash-jxl/meta.js';
import jxlMtFactory              from './vendor/jsquash-jxl/codec/enc/jxl_enc_mt.js';
import decode                    from './vendor/jsquash-jxl/decode.js';
```

- [ ] **Step 2: Add decode_jxl dispatch at the top of self.onmessage**

The current handler starts with `const { id, rgba, ... } = data;` assuming encode.
Replace `self.onmessage = async ({ data }) => {` block's first lines to add a type check:

```js
self.onmessage = async ({ data }) => {
    if (data.type === 'decode_jxl') {
        const { decodeId, url } = data;
        try {
            const resp = await fetch(url);
            const buf  = await resp.arrayBuffer();
            const img  = await decode(buf); // returns { data: Uint8ClampedArray, width, height }
            self.postMessage(
                { type: 'jxl_decoded', decodeId, rgba: img.data, w: img.width, h: img.height },
                [img.data.buffer],
            );
        } catch (err) {
            self.postMessage({ type: 'decode_error', decodeId, error: String(err?.message ?? err) });
        }
        return;
    }

    // --- existing encode path below, unchanged ---
    const { id, rgba, width, height, quality, effort, lossless } = data;
    // ... rest of existing encode code unchanged
```

- [ ] **Step 3: Commit**

```bash
git add web/jxl-worker.js
git commit -m "feat: add decode_jxl message handler to jxl-worker"
```

---

### Task 3: Add pool.decodeJxl() and response routing in main.js

**Files:**
- Modify: `web/main.js` (WorkerPool class, setJxlWorker method)

The pool's `setJxlWorker` currently handles only `done` and encode errors from the jxl-worker. Add a decode callback map alongside it.

- [ ] **Step 1: Add _jxlDecodeCallbacks map to WorkerPool constructor**

In the `constructor(size)` method, after `this.workerForTask = new Map();`, add:

```js
this._jxlDecodeCallbacks = new Map(); // decodeId → callback fn
this._jxlNextDecodeId    = 1;
```

- [ ] **Step 2: Update setJxlWorker to route decode responses**

Find `setJxlWorker(w) {` and replace the `w.addEventListener('message', ...)` inside it:

```js
setJxlWorker(w) {
    this._jxlWorker = w;
    w.addEventListener('message', ({ data }) => {
        // Decode responses use decodeId, not task id.
        if (data.type === 'jxl_decoded' || data.type === 'decode_error') {
            const cb = this._jxlDecodeCallbacks.get(data.decodeId);
            if (cb) { this._jxlDecodeCallbacks.delete(data.decodeId); cb(data); }
            return;
        }
        // Encode responses use task id.
        const t = this.tasks.get(data.id);
        if (!t) return;
        if (data.type === 'done') {
            if (t.handlers.onDone) t.handlers.onDone(data);
        } else {
            if (t.handlers.onError) t.handlers.onError({ type: 'error', error: data.error });
        }
        this.tasks.delete(data.id);
    });
}
```

- [ ] **Step 3: Add pool.decodeJxl() method**

Inside the `WorkerPool` class, after `setThumbLiveHandler(fn)`, add:

```js
decodeJxl(url, callback) {
    const decodeId = this._jxlNextDecodeId++;
    this._jxlDecodeCallbacks.set(decodeId, callback);
    this._jxlWorker.postMessage({ type: 'decode_jxl', decodeId, url });
}
```

- [ ] **Step 4: Commit**

```bash
git add web/main.js
git commit -m "feat: add pool.decodeJxl() with callback routing"
```

---

### Task 4: Add centered source label HTML + CSS

**Files:**
- Modify: `web/index.html`
- Modify: `web/style.css`

- [ ] **Step 1: Add #lb-source-label div to index.html**

Inside `.lightbox-viewport`, after the `<canvas id="lightbox-canvas">` line, add:

```html
<div id="lb-source-label" aria-live="polite"></div>
```

Full viewport block should look like:

```html
<div class="lightbox-viewport">
    <canvas id="lightbox-canvas"></canvas>
    <div id="lb-source-label" aria-live="polite"></div>
    <div class="lb-source-banner" id="lb-source-banner" data-source="jxl">JXL</div>
    <div class="lb-preview-badge" hidden>Camera JPEG</div>
    <div class="lb-loading-badge" hidden>Loading…</div>
</div>
```

- [ ] **Step 2: Add CSS for #lb-source-label**

Add after the existing `.lb-source-banner` block in `style.css`:

```css
/* Large centred flash label — appears briefly on every source switch. */
@keyframes lb-source-flash {
    0%   { opacity: 0;    transform: translate(-50%, -50%) scale(0.85); }
    10%  { opacity: 1;    transform: translate(-50%, -50%) scale(1);    }
    55%  { opacity: 1;    transform: translate(-50%, -50%) scale(1);    }
    100% { opacity: 0;    transform: translate(-50%, -50%) scale(1);    }
}

#lb-source-label {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 20;
    pointer-events: none;
    font-size: 3.5rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    color: #fff;
    text-shadow: 0 2px 16px rgba(0,0,0,0.8);
    background: rgba(0, 0, 0, 0.45);
    padding: 0.25em 0.7em;
    border-radius: 0.3em;
    opacity: 0;
    user-select: none;
}

#lb-source-label.active {
    animation: lb-source-flash 1.5s ease-out forwards;
}
```

- [ ] **Step 3: Commit**

```bash
git add web/index.html web/style.css
git commit -m "feat: add centered #lb-source-label overlay HTML + CSS"
```

---

### Task 5: Migrate _showJpeg → _sourceMode and implement cycleSourceForCard

**Files:**
- Modify: `web/main.js`

- [ ] **Step 1: Add DOM ref for #lb-source-label**

After `const lbSourceBanner = lightbox.querySelector('#lb-source-banner');`, add:

```js
const lbSourceLabelEl = document.getElementById('lb-source-label');
```

- [ ] **Step 2: Add showSourceLabel() helper**

After the `flashSourceBanner()` function, add:

```js
let _sourceLabelKey = 0;
function showSourceLabel(text) {
    if (!lbSourceLabelEl) return;
    lbSourceLabelEl.textContent = text;
    lbSourceLabelEl.classList.remove('active');
    // Force reflow so re-adding class restarts animation.
    void lbSourceLabelEl.offsetWidth;
    _sourceLabelKey++;
    lbSourceLabelEl.dataset.key = _sourceLabelKey;
    lbSourceLabelEl.classList.add('active');
}
```

- [ ] **Step 3: Replace card._showJpeg with card._sourceMode**

Find every occurrence of `card._showJpeg` in main.js and replace:

| Old | New |
|-----|-----|
| `card._showJpeg = false;` | `card._sourceMode = 'raw';` |
| `card._showJpeg = !card._showJpeg;` | *(remove — cycleSourceForCard replaces this)* |
| `card && card._showJpeg` | `card && card._sourceMode === 'jpeg'` |
| `!!card._showJpeg` | `card._sourceMode === 'jpeg'` |

There are occurrences in:
- `startConvert` (re-process path): change `card._showJpeg = false;` → `card._sourceMode = 'raw';`
- `updateToggleButtonState`: see Task 6
- `drawLightboxForCard`: see Step 4

- [ ] **Step 4: Update drawLightboxForCard for 3 states**

Replace the existing `drawLightboxForCard(card)` function:

```js
function drawLightboxForCard(card) {
    const mode = card._sourceMode ?? 'raw';

    if (mode === 'jpeg') {
        if (card._embeddedPreview && card._lightbox) {
            const { w, h } = card._lightbox;
            const { bmp, orientation } = card._embeddedPreview;
            drawJpegToTargetDims(lightboxCanvas, bmp, orientation || 1, w, h);
            lbPreviewBadge.hidden = false;
            lbLoadingBadge.hidden = true;
            updateToggleButtonState(card);
            return;
        }
        // Fallback: no pair yet, treat as raw.
        card._sourceMode = 'raw';
    }

    if (mode === 'jxl') {
        if (!card._blobUrl) {
            // JXL not ready yet — fall back to raw.
            card._sourceMode = 'raw';
        } else {
            lbPreviewBadge.hidden = true;
            lbLoadingBadge.hidden = false;
            updateToggleButtonState(card);
            pool.decodeJxl(card._blobUrl, (msg) => {
                if (lightboxIndex < 0 || cards[lightboxIndex] !== card) return;
                if (msg.type === 'decode_error') {
                    console.warn('JXL decode error:', msg.error);
                    lbLoadingBadge.hidden = true;
                    return;
                }
                lightboxCanvas.width  = msg.w;
                lightboxCanvas.height = msg.h;
                const ctx = lightboxCanvas.getContext('2d');
                ctx.putImageData(new ImageData(msg.rgba, msg.w, msg.h), 0, 0);
                lbLoadingBadge.hidden = true;
                resetLbZoom();
            });
            return;
        }
    }

    // mode === 'raw' (or fallback)
    if (card._lightbox) {
        const { rgb, w, h } = card._lightbox;
        drawCanvas(lightboxCanvas, w, h, rgb);
        lbPreviewBadge.hidden = true;
        lbLoadingBadge.hidden = true;
    } else if (card._embeddedPreview) {
        const { bmp, orientation } = card._embeddedPreview;
        drawBitmapOriented(lightboxCanvas, bmp, orientation || 1);
        lbPreviewBadge.hidden = false;
        lbLoadingBadge.hidden = true;
    } else {
        lightboxCanvas.width = 1;
        lightboxCanvas.height = 1;
        lbPreviewBadge.hidden = true;
        lbLoadingBadge.hidden = false;
    }
    updateToggleButtonState(card);
}
```

- [ ] **Step 5: Replace toggleJpegForCard with cycleSourceForCard**

Delete the existing `toggleJpegForCard(card)` function entirely and replace with:

```js
// dir: +1 = forward (raw→jxl→jpeg→raw), -1 = backward
function cycleSourceForCard(card, dir = 1) {
    const order = ['raw', 'jxl', 'jpeg'];
    const available = order.filter(m => {
        if (m === 'raw')  return !!card._lightbox;
        if (m === 'jxl')  return !!card._blobUrl;
        if (m === 'jpeg') return !!card._embeddedPreview;
        return false;
    });
    if (available.length < 2) return; // nothing to toggle
    const cur = available.indexOf(card._sourceMode ?? 'raw');
    const next = available[(cur + dir + available.length) % available.length];
    card._sourceMode = next;
    const labels = { raw: 'RAW', jxl: 'JXL', jpeg: 'JPEG' };
    refreshThumbToggleButton(card);
    if (lightboxIndex >= 0 && cards[lightboxIndex] === card) {
        liveInFlight = false;
        livePendingLook = null;
        drawLightboxForCard(card);
        resetLbZoom();
        flashSourceBanner();
        showSourceLabel(labels[next]);
        // Re-apply live look when switching back to raw.
        if (next === 'raw') scheduleLiveUpdate();
    }
    redrawThumbRotated(card);
}
```

- [ ] **Step 6: Update all callers of toggleJpegForCard → cycleSourceForCard**

Find all calls to `toggleJpegForCard` and replace:

| Location | Old | New |
|----------|-----|-----|
| Thumb `.thumb-toggle-jpeg` click | `toggleJpegForCard(card)` | `cycleSourceForCard(card, 1)` |
| `lbToggleJpegBtn` click | `toggleJpegForCard(cards[lightboxIndex])` | `cycleSourceForCard(cards[lightboxIndex], 1)` |
| Spacebar keydown | `toggleJpegForCard(cards[lightboxIndex])` | `cycleSourceForCard(cards[lightboxIndex], 1)` |

- [ ] **Step 7: Update openLightbox to reset sourceMode**

In `openLightbox(card)`, replace `resetLookSliders();` block — ensure `card._sourceMode = 'raw';` is set before `drawLightboxForCard`:

```js
function openLightbox(card) {
    lightboxIndex = cards.indexOf(card);
    lbRotation = card._file?.name ? (userRotations[card._file.name] ?? 0) : 0;
    card._sourceMode = 'raw';
    resetLookSliders();
    drawLightboxForCard(card);
    flashSourceBanner();
    showSourceLabel('RAW');
    renderInfoPanel(card);
    lightbox.hidden = false;
    resetLbZoom();
}
```

- [ ] **Step 8: Update nextInLightbox to reset sourceMode**

In `nextInLightbox(dir)`, after `lightboxIndex = (lightboxIndex + dir + ...) % cards.length;`, add:

```js
const card = cards[lightboxIndex];
if (card) card._sourceMode = 'raw';
```

And after `resetLookSliders();` before `drawLightbox();`, ensure the label fires:

```js
function nextInLightbox(dir) {
    if (lightboxIndex < 0) return;
    lightboxIndex = (lightboxIndex + dir + cards.length) % cards.length;
    const card = cards[lightboxIndex];
    if (card) card._sourceMode = 'raw';
    liveInFlight = false;
    livePendingLook = null;
    resetLookSliders();
    drawLightbox();
    showSourceLabel('RAW');
}
```

- [ ] **Step 9: Commit**

```bash
git add web/main.js
git commit -m "feat: migrate _showJpeg→_sourceMode, implement cycleSourceForCard + showSourceLabel"
```

---

### Task 6: Update toggle button and small banner for 3 states

**Files:**
- Modify: `web/main.js` (updateToggleButtonState, refreshThumbToggleButton)

- [ ] **Step 1: Update updateToggleButtonState**

Replace the existing `updateToggleButtonState(card)` function:

```js
function updateToggleButtonState(card) {
    const mode = card?._sourceMode ?? 'raw';
    const labels = { raw: 'RAW', jxl: 'JXL', jpeg: 'JPEG' };
    const havePair = !!(card && card._lightbox && card._embeddedPreview);
    if (lbToggleJpegBtn) {
        lbToggleJpegBtn.disabled = !havePair;
        lbToggleJpegBtn.textContent = labels[mode] ?? 'RAW';
        lbToggleJpegBtn.classList.toggle('showing-jpeg', mode === 'jpeg');
    }
    if (lbSourceBanner) {
        const srcAttr = mode === 'raw' ? 'raw' : mode === 'jxl' ? 'jxl' : 'jpeg';
        lbSourceBanner.textContent = labels[mode] ?? 'RAW';
        lbSourceBanner.setAttribute('data-source', srcAttr);
        const hasContent = !!(card && (card._lightbox || card._embeddedPreview));
        lbSourceBanner.hidden = !hasContent;
    }
}
```

- [ ] **Step 2: Add data-source="raw" style to style.css**

After the existing `.lb-source-banner[data-source="jxl"]` block, add:

```css
.lb-source-banner[data-source="raw"] {
    background: rgba(20, 120, 40, 0.55);
    border-color: rgba(100, 220, 120, 0.4);
}
```

- [ ] **Step 3: Update refreshThumbToggleButton**

The thumb toggle button currently shows 'JPEG'/'JXL'. Keep it simple — show current mode:

```js
function refreshThumbToggleButton(card) {
    const btn = card.querySelector('.thumb-toggle-jpeg');
    if (!btn) return;
    const available = ['raw', 'jxl', 'jpeg'].filter(m => {
        if (m === 'raw')  return !!card._lightbox;
        if (m === 'jxl')  return !!card._blobUrl;
        if (m === 'jpeg') return !!card._embeddedPreview;
    });
    btn.hidden = available.length < 2;
    if (available.length < 2) return;
    const mode = card._sourceMode ?? 'raw';
    const labels = { raw: 'RAW', jxl: 'JXL', jpeg: 'JPEG' };
    btn.textContent = labels[mode] ?? 'RAW';
    btn.classList.toggle('showing-jpeg', mode === 'jpeg');
}
```

- [ ] **Step 4: Commit**

```bash
git add web/main.js web/style.css
git commit -m "feat: update toggle button + banner for 3-way raw/jxl/jpeg mode"
```

---

### Task 7: Add ↑↓ keyboard shortcuts for source cycling

**Files:**
- Modify: `web/main.js` (keydown handler)

- [ ] **Step 1: Add ↑↓ to the lightbox keydown block**

In the `document.addEventListener('keydown', ...)` handler, inside the `if (lightbox.hidden) return;` block, add after the existing `ArrowLeft`/`ArrowRight` lines:

```js
else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (lightboxIndex >= 0) cycleSourceForCard(cards[lightboxIndex], 1);
}
else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (lightboxIndex >= 0) cycleSourceForCard(cards[lightboxIndex], -1);
}
```

- [ ] **Step 2: Update title attributes on the toggle button in index.html**

Find the `lb-toggle-jpeg` button and update its title:

```html
<button class="lb-btn lb-toggle-jpeg" aria-label="Cycle source: RAW / JXL / JPEG"
        title="Cycle source: RAW → JXL → JPEG (Space / ↑↓)">RAW</button>
```

- [ ] **Step 3: Commit**

```bash
git add web/main.js web/index.html
git commit -m "feat: add ↑↓ keyboard shortcuts to cycle lightbox source"
```

---

### Task 8: Smoke test in browser

- [ ] **Step 1: Start dev server**

```bash
npx serve web -l 5174 --cors
```

Or use whichever serve command is in use (check `serve.ts` or package scripts).

- [ ] **Step 2: Verify checklist**

Open `http://localhost:5174` in browser, drop 2–3 ORF files. Wait for encode to complete. Then verify:

| Action | Expected |
|--------|----------|
| Click thumbnail → lightbox opens | Big "RAW" label flashes centered, small banner shows RAW (green) |
| Press Space | Cycles RAW→JXL: loading badge appears, JXL decodes at full-res, "JXL" label flashes |
| Press Space again | Cycles JXL→JPEG: "JPEG" label flashes, camera JPEG shown at 1800px |
| Press Space again | Back to RAW: "RAW" flashes |
| Press ↑ | Steps forward one source |
| Press ↓ | Steps backward (RAW→JPEG skipping JXL) |
| Press ← → | Navigate photos — each resets to RAW, "RAW" label flashes |
| Adjust slider while in RAW | Live re-render applies |
| Switch to JPEG, back to RAW | Slider look re-applies (scheduleLiveUpdate called) |
| Adjust slider while in JXL | No re-render (expected — JXL is a static decode) |
| Source not available (JPEG not extracted yet) | That mode skipped silently |

- [ ] **Step 3: Final commit if any fixups were needed**

```bash
git add -p
git commit -m "fix: lightbox source toggle smoke-test fixups"
```
