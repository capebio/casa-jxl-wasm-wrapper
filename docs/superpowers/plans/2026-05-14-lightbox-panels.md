# Lightbox Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three collapsible panels (Histogram H, Colour Profiles C, Filters F) stacked in the top-right of the lightbox viewport, with 5-handle levels control, 7 built-in + user-saved colour profiles, 12 pipeline filters + 2 CSS overlay filters, Ctrl+1–9 B&W shortcuts, and per-image sidecar persistence.

**Architecture:** All JS-side — no WASM recompile. A new `web/panels.js` file (loaded after `main.js`) owns all panel logic and exposes `mergedLook()` globally. `main.js` gets minimal surgical edits: after-draw histogram hook, look-merge hook in `scheduleLiveUpdate`, keyboard shortcuts, sidecar auto-load in `openLightbox`, and dot badge in `makeCard`. Tauri sidecar uses two new `read_look`/`write_look` commands in `push.rs`.

**Tech Stack:** Vanilla JS (ES2020), CSS custom properties, HTML5 Canvas, `localStorage`, Bun/serve.ts for dev, Tauri `std::fs` for sidecar writes.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `web/panels.js` | **Create** | All panel logic: histogram, levels, profiles, filters, sidecar, user profiles |
| `web/index.html` | **Modify** | Panel HTML shells inside `.lightbox-viewport`; `<script>` for panels.js; overlay divs |
| `web/style.css` | **Modify** | Panel stack, icon buttons, panel bodies, histogram canvas, levels handles, chips |
| `web/main.js` | **Modify** | Hook histogram update after putImageData; merge look in scheduleLiveUpdate; keyboard H/C/F/Ctrl+1-9/Ctrl+S; sidecar auto-load; dot badge |
| `C:\Foo\raw-converter-tauri\src-tauri\src\push.rs` | **Modify** | Add `read_look`, `write_look` Tauri commands |
| `C:\Foo\raw-converter-tauri\src-tauri\src\lib.rs` | **Modify** | Register `read_look`, `write_look` in invoke_handler |

---

## Task 1: Panel shell infrastructure

**Files:**
- Modify: `web/index.html`
- Modify: `web/style.css`
- Create: `web/panels.js`
- Modify: `web/main.js`

- [ ] **Step 1: Add panel HTML to index.html**

Inside `.lightbox-viewport`, immediately after `#lightbox-canvas` (before the badge divs), add:

```html
<div id="lb-panels" class="lb-panels">
  <div id="lb-panel-h" class="lb-panel">
    <button class="lb-panel-btn" data-panel="h" title="Histogram (H)">
      <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
        <rect x="1" y="10" width="2" height="7"/><rect x="4" y="6" width="2" height="11"/>
        <rect x="7" y="3" width="2" height="14"/><rect x="10" y="5" width="2" height="12"/>
        <rect x="13" y="8" width="2" height="9"/><rect x="16" y="12" width="2" height="5"/>
      </svg>
    </button>
    <div class="lb-panel-body" hidden></div>
  </div>
  <div id="lb-panel-c" class="lb-panel">
    <button class="lb-panel-btn" data-panel="c" title="Colour Profiles (C)">
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="9" cy="9" r="7"/>
        <circle cx="6" cy="7" r="2" fill="currentColor" stroke="none"/>
        <circle cx="12" cy="7" r="2" fill="currentColor" stroke="none"/>
        <circle cx="9" cy="12" r="2" fill="currentColor" stroke="none"/>
      </svg>
    </button>
    <div class="lb-panel-body" hidden></div>
  </div>
  <div id="lb-panel-f" class="lb-panel">
    <button class="lb-panel-btn" data-panel="f" title="Filters (F)">
      <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
        <path d="M2 4h14v2L10 12v4l-2-1v-3L2 6V4z"/>
      </svg>
    </button>
    <div class="lb-panel-body" hidden></div>
  </div>
</div>
```

Also add overlay divs for grain/vignette inside `.lightbox-viewport` (after the panel div):

```html
<canvas id="lb-grain-overlay" class="lb-overlay" hidden></canvas>
<div id="lb-vignette-overlay" class="lb-overlay lb-vignette" hidden></div>
```

- [ ] **Step 2: Add panel CSS to style.css**

Append to the lightbox section of `style.css`:

```css
/* ── Lightbox panel stack ── */
.lb-panels {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  z-index: 20;
  pointer-events: all;
}

.lb-panel {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.lb-panel-btn {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.15);
  background: rgba(20,20,20,0.82);
  color: #ccc;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
  flex-shrink: 0;
}
.lb-panel-btn:hover,
.lb-panel-btn.active { background: rgba(60,60,60,0.92); color: #fff; }

.lb-panel-body {
  margin-top: 4px;
  width: 240px;
  background: rgba(18,18,18,0.92);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 8px;
  padding: 10px;
  color: #ddd;
  font-size: 12px;
}

/* ── Overlay filters ── */
.lb-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 15;
}
.lb-vignette {
  background: radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.65) 100%);
}
```

- [ ] **Step 3: Create web/panels.js with toggle logic**

```js
// panels.js — lightbox panels: histogram, colour profiles, filters, sidecar

(function () {
'use strict';

// ── Panel toggle ──────────────────────────────────────────────────
const panelBodies = {};
const panelBtns   = {};

function initPanelToggles() {
  document.querySelectorAll('.lb-panel-btn').forEach(btn => {
    const key = btn.dataset.panel;
    panelBtns[key]   = btn;
    panelBodies[key] = btn.closest('.lb-panel').querySelector('.lb-panel-body');
  });
}

function togglePanel(key) {
  const body = panelBodies[key];
  const btn  = panelBtns[key];
  if (!body) return;
  const opening = body.hidden;
  body.hidden = !opening;
  btn.classList.toggle('active', opening);
  if (key === 'h' && opening) updateHistogramAndLevels();
}

window.togglePanel = togglePanel;

// ── Initialise on DOMContentLoaded ────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initPanelToggles();
  initHistogram();
  initProfiles();
  initFilters();
  initSidecar();
});

})();
```

- [ ] **Step 4: Load panels.js in index.html**

Add after the existing `<script src="web/main.js">` tag:

```html
<script src="web/panels.js"></script>
```

- [ ] **Step 5: Add H / C / F keyboard shortcuts to main.js**

In `web/main.js`, inside the lightbox keyboard handler block (around line 1843, where `Escape` is handled), add before the closing brace of the lightbox-open block:

```js
if (e.key === 'h' || e.key === 'H') { e.preventDefault(); togglePanel('h'); return; }
if (e.key === 'c' || e.key === 'C') { e.preventDefault(); togglePanel('c'); return; }
if (e.key === 'f' || e.key === 'F') { e.preventDefault(); togglePanel('f'); return; }
```

- [ ] **Step 6: Verify in browser**

Run `bun serve.ts` from `C:\Foo\raw-converter-wasm`. Open `http://localhost:5173`. Load an ORF, open lightbox. Press H, C, F — each panel icon should toggle a dark panel body open/closed. Check DevTools console for errors.

- [ ] **Step 7: Commit**

```bash
git add web/index.html web/style.css web/panels.js web/main.js
git commit -m "feat(lightbox): add collapsible H/C/F panel shell infrastructure"
```

---

## Task 2: Histogram canvas + L/RGB toggle

**Files:**
- Modify: `web/panels.js`
- Modify: `web/main.js`

- [ ] **Step 1: Add histogram HTML into panel H body**

In `web/index.html`, replace the empty `<div class="lb-panel-body" hidden></div>` for panel H with:

```html
<div class="lb-panel-body" hidden>
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
    <span style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.05em">Histogram</span>
    <button id="lb-hist-mode" class="lb-chip lb-chip-active" style="padding:2px 8px;font-size:11px">L</button>
  </div>
  <canvas id="lb-hist-canvas" width="220" height="80" style="width:220px;height:80px;display:block"></canvas>
  <!-- levels handles added in Task 3 -->
</div>
```

- [ ] **Step 2: Add histogram CSS to style.css**

```css
/* ── Histogram ── */
#lb-hist-canvas { border-radius: 4px; background: #0d0d0d; }

.lb-chip {
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 4px;
  color: #bbb;
  cursor: pointer;
  font-size: 12px;
  padding: 3px 10px;
  transition: background 0.12s, color 0.12s;
}
.lb-chip:hover  { background: rgba(255,255,255,0.14); color: #fff; }
.lb-chip-active { background: rgba(255,255,255,0.22); color: #fff; border-color: rgba(255,255,255,0.35); }
```

- [ ] **Step 3: Implement histogram in panels.js**

Replace the `initHistogram()` stub call with this full implementation (add inside the IIFE before `initPanelToggles`):

```js
// ── Histogram ─────────────────────────────────────────────────────
let histMode = 'L'; // 'L' or 'RGB'

function initHistogram() {
  const modeBtn = document.getElementById('lb-hist-mode');
  if (!modeBtn) return;
  modeBtn.addEventListener('click', () => {
    histMode = histMode === 'L' ? 'RGB' : 'L';
    modeBtn.textContent = histMode;
    updateHistogramAndLevels();
  });
}

function computeHistogram(pixels) {
  const lum = new Uint32Array(256);
  const r   = new Uint32Array(256);
  const g   = new Uint32Array(256);
  const b   = new Uint32Array(256);
  for (let i = 0; i < pixels.length; i += 4) {
    const rv = pixels[i], gv = pixels[i+1], bv = pixels[i+2];
    lum[Math.round(0.299 * rv + 0.587 * gv + 0.114 * bv)]++;
    r[rv]++; g[gv]++; b[bv]++;
  }
  return { lum, r, g, b };
}

function drawHistogram(hist) {
  const canvas = document.getElementById('lb-hist-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  function drawCurve(data, colour) {
    let maxVal = 1;
    for (let i = 0; i < 256; i++) if (data[i] > maxVal) maxVal = data[i];
    const logMax = Math.log1p(maxVal);
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * W;
      const y = H - (Math.log1p(data[i]) / logMax) * H;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = colour;
    ctx.fill();
  }

  if (histMode === 'L') {
    drawCurve(hist.lum, 'rgba(220,220,220,0.85)');
  } else {
    drawCurve(hist.r, 'rgba(220,60,60,0.55)');
    drawCurve(hist.g, 'rgba(60,200,60,0.55)');
    drawCurve(hist.b, 'rgba(60,120,255,0.55)');
  }
}

function updateHistogramAndLevels() {
  const lbCanvas = document.getElementById('lightbox-canvas');
  if (!lbCanvas || document.getElementById('lb-panel-h').querySelector('.lb-panel-body').hidden) return;
  const ctx = lbCanvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, lbCanvas.width, lbCanvas.height);
  applyLevelsToImageData(imageData); // no-op if all default; defined in Task 3
  ctx.putImageData(imageData, 0, 0);
  const hist = computeHistogram(imageData.data);
  drawHistogram(hist);
}

window.updateHistogramAndLevels = updateHistogramAndLevels;
```

- [ ] **Step 4: Add stub for applyLevelsToImageData (filled in Task 3)**

Add directly after the histogram block inside the IIFE:

```js
// Stub — replaced in Task 3
function applyLevelsToImageData(_imageData) { /* no-op until Task 3 */ }
```

- [ ] **Step 5: Hook histogram update into main.js after putImageData**

In `web/main.js` find the `putImageData` call in the live handler (line ~565). After it, add:

```js
if (typeof updateHistogramAndLevels === 'function') updateHistogramAndLevels();
```

Also find `drawLightboxForCard` or wherever `putImageData` is called for initial draw and add the same line after each call.

- [ ] **Step 6: Verify**

Open lightbox on a real ORF. Press H. Histogram canvas should show a curve. Click the `L` button — it should toggle to `RGB` (three coloured curves). Verify no console errors.

- [ ] **Step 7: Commit**

```bash
git add web/index.html web/style.css web/panels.js web/main.js
git commit -m "feat(histogram): add live histogram with L/RGB toggle"
```

---

## Task 3: Levels control (5 draggable handles)

**Files:**
- Modify: `web/index.html`
- Modify: `web/panels.js`
- Modify: `web/style.css`

- [ ] **Step 1: Add levels HTML below histogram canvas in index.html**

Replace the `<!-- levels handles added in Task 3 -->` comment with:

```html
<div class="lb-levels-wrap">
  <div class="lb-levels-row lb-levels-input" title="Input levels">
    <div class="lb-levels-track">
      <div class="lb-lvl-handle" id="lb-lvl-in-black"  data-lvl="inBlack"  style="left:0%"   title="Black point"></div>
      <div class="lb-lvl-handle lb-lvl-mid" id="lb-lvl-in-mid" data-lvl="inMid" style="left:50%" title="Midtone gamma"></div>
      <div class="lb-lvl-handle" id="lb-lvl-in-white"  data-lvl="inWhite"  style="left:100%" title="White point"></div>
    </div>
  </div>
  <div class="lb-levels-row lb-levels-output" title="Output levels">
    <div class="lb-levels-track">
      <div class="lb-lvl-handle" id="lb-lvl-out-black" data-lvl="outBlack" style="left:0%"   title="Output black"></div>
      <div class="lb-lvl-handle" id="lb-lvl-out-white" data-lvl="outWhite" style="left:100%" title="Output white"></div>
    </div>
  </div>
  <div style="display:flex;justify-content:flex-end;margin-top:6px">
    <button id="lb-levels-reset" class="lb-chip" style="font-size:11px;padding:2px 8px">Reset</button>
  </div>
</div>
```

- [ ] **Step 2: Add levels CSS to style.css**

```css
/* ── Levels ── */
.lb-levels-wrap { margin-top: 8px; }

.lb-levels-row { margin-bottom: 4px; }
.lb-levels-row.lb-levels-input  { opacity: 1; }
.lb-levels-row.lb-levels-output { opacity: 0.75; }

.lb-levels-track {
  position: relative;
  height: 16px;
  background: linear-gradient(to right, #000, #fff);
  border-radius: 3px;
  margin: 0 8px;
}
.lb-levels-output .lb-levels-track {
  background: linear-gradient(to right, #333, #eee);
}

.lb-lvl-handle {
  position: absolute;
  top: -3px;
  width: 0;
  height: 0;
  border-left: 7px solid transparent;
  border-right: 7px solid transparent;
  border-bottom: 13px solid #fff;
  transform: translateX(-7px);
  cursor: ew-resize;
  filter: drop-shadow(0 1px 2px rgba(0,0,0,0.8));
  z-index: 2;
}
.lb-lvl-handle.lb-lvl-mid {
  border-bottom-color: #aaa;
  top: 3px;
}
.lb-lvl-handle:hover { border-bottom-color: #ffdd44; }
```

- [ ] **Step 3: Implement levels state + remap formula in panels.js**

Replace the `applyLevelsToImageData` stub with this full implementation. Add the levels state and logic block:

```js
// ── Levels ────────────────────────────────────────────────────────
const levelsState = { inBlack: 0, inMid: 1.0, inWhite: 255, outBlack: 0, outWhite: 255 };

const LEVELS_DEFAULTS = { inBlack: 0, inMid: 1.0, inWhite: 255, outBlack: 0, outWhite: 255 };

function levelsIsDefault() {
  return levelsState.inBlack === 0 && levelsState.inMid === 1.0 &&
         levelsState.inWhite === 255 && levelsState.outBlack === 0 && levelsState.outWhite === 255;
}

function remapPixel(v, inB, inM, inW, outB, outW) {
  const range = inW - inB;
  if (range <= 0) return outB;
  const normalized = Math.max(0, Math.min(1, (v - inB) / range));
  const gamma = Math.pow(normalized, 1.0 / inM);
  return Math.round(outB + gamma * (outW - outB));
}

function applyLevelsToImageData(imageData) {
  if (levelsIsDefault()) return;
  const { inBlack: inB, inMid: inM, inWhite: inW, outBlack: outB, outWhite: outW } = levelsState;
  // Build LUT for speed (256 values, applied to all channels)
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = remapPixel(i, inB, inM, inW, outB, outW);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i]   = lut[d[i]];
    d[i+1] = lut[d[i+1]];
    d[i+2] = lut[d[i+2]];
    // alpha unchanged
  }
}

function syncHandlePosition(key) {
  const el = document.getElementById(`lb-lvl-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`);
  if (!el) return;
  let pct;
  if (key === 'inBlack')  pct = (levelsState.inBlack  / 255) * 100;
  else if (key === 'inWhite')  pct = (levelsState.inWhite  / 255) * 100;
  else if (key === 'inMid') {
    // gamma 0.1–10 mapped logarithmically to 0–100%
    pct = (1 - (Math.log(levelsState.inMid) / Math.log(10) + 1) / 2) * 100;
    pct = Math.max(0, Math.min(100, pct));
  }
  else if (key === 'outBlack') pct = (levelsState.outBlack / 255) * 100;
  else if (key === 'outWhite') pct = (levelsState.outWhite / 255) * 100;
  el.style.left = pct.toFixed(1) + '%';
}

function initLevels() {
  const handles = document.querySelectorAll('.lb-lvl-handle');

  handles.forEach(handle => {
    const key = handle.dataset.lvl;
    let dragging = false, startX = 0, startVal = 0;

    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      dragging = true;
      startX   = e.clientX;
      startVal = levelsState[key];
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup',  onUp);
    });

    function onMove(e) {
      if (!dragging) return;
      const track = handle.closest('.lb-levels-track');
      const trackW = track.getBoundingClientRect().width;
      const dx = e.clientX - startX;
      const dpct = dx / trackW;

      if (key === 'inMid') {
        // log scale: centre = 1.0, left = brighter (>1), right = darker (<1)
        const logStart = Math.log(startVal) / Math.log(10);
        const newLog = Math.max(-1, Math.min(1, logStart - dpct));
        levelsState.inMid = Math.pow(10, newLog);
      } else {
        const dval = dpct * 255;
        let newVal = Math.round(Math.max(0, Math.min(255, startVal + dval)));
        if (key === 'inBlack')  newVal = Math.min(newVal, levelsState.inWhite  - 1);
        if (key === 'inWhite')  newVal = Math.max(newVal, levelsState.inBlack  + 1);
        if (key === 'outBlack') newVal = Math.min(newVal, levelsState.outWhite - 1);
        if (key === 'outWhite') newVal = Math.max(newVal, levelsState.outBlack + 1);
        levelsState[key] = newVal;
      }
      syncHandlePosition(key);
      updateHistogramAndLevels();
    }

    function onUp() {
      dragging = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',  onUp);
    }
  });

  document.getElementById('lb-levels-reset')?.addEventListener('click', () => {
    Object.assign(levelsState, LEVELS_DEFAULTS);
    ['inBlack','inMid','inWhite','outBlack','outWhite'].forEach(syncHandlePosition);
    updateHistogramAndLevels();
  });
}
```

Add `initLevels()` call inside `DOMContentLoaded`:

```js
document.addEventListener('DOMContentLoaded', () => {
  initPanelToggles();
  initHistogram();
  initLevels();
  initProfiles();
  initFilters();
  initSidecar();
});
```

- [ ] **Step 4: Verify remap formula in browser console**

Open DevTools console and paste:

```js
// Should return 0, 128, 255 for identity
[0, 128, 255].map(v => remapPixel(v, 0, 1.0, 255, 0, 255));
// Should return [0, 102, 255] — black-clipped at 50
[50, 128, 255].map(v => remapPixel(v, 50, 1.0, 255, 0, 255));
```

Expected: `[0, 128, 255]` then `[0, 102, 255]`.

- [ ] **Step 5: Verify in browser**

Open lightbox, press H. Drag the black point handle right — image shadows should clip to black. Drag white point left — highlights clip to white. Drag midtone handle — image brightens/darkens. Click Reset — image returns to normal.

- [ ] **Step 6: Commit**

```bash
git add web/index.html web/style.css web/panels.js
git commit -m "feat(histogram): add 5-handle levels control with remap LUT"
```

---

## Task 4: Colour profiles (built-ins)

**Files:**
- Modify: `web/index.html`
- Modify: `web/panels.js`
- Modify: `web/main.js`

- [ ] **Step 1: Add profiles HTML to panel C body in index.html**

Replace empty panel C body with:

```html
<div class="lb-panel-body" hidden>
  <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Built-in</div>
  <div id="lb-profile-chips" class="lb-chip-group"></div>
  <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.05em;margin:10px 0 8px">My Profiles</div>
  <div id="lb-user-profile-chips" class="lb-chip-group"></div>
  <div style="margin-top:8px;font-size:11px;color:#666">
    Ctrl+Shift+S save &nbsp;·&nbsp; Ctrl+Shift+L load &nbsp;·&nbsp; Ctrl+Shift+1–0 quick-load
  </div>
</div>
```

Add chip-group CSS to `style.css`:

```css
.lb-chip-group { display: flex; flex-wrap: wrap; gap: 5px; }
```

- [ ] **Step 2: Implement profiles in panels.js**

Add after the levels block:

```js
// ── Colour Profiles ───────────────────────────────────────────────
const BUILTIN_PROFILES = {
  'Natural':   { contrast:0, saturation:0, vibrance:0, temp:0, tint:0, highlights:0, shadows:0, whites:0, blacks:0, clarity:0 },
  'Vivid':     { contrast:0.2, saturation:0.3, vibrance:0.2, temp:0, tint:0, highlights:0, shadows:0, whites:0, blacks:0, clarity:0 },
  'Muted':     { contrast:-0.15, saturation:-0.3, vibrance:0, temp:0, tint:0, highlights:0, shadows:0.1, whites:0, blacks:0, clarity:0 },
  'Portrait':  { contrast:0, saturation:0.1, vibrance:0, temp:0.05, tint:0, highlights:-0.1, shadows:0.15, whites:0, blacks:0, clarity:0 },
  'Monotone':  { contrast:0, saturation:-1.0, vibrance:0, temp:0, tint:0, highlights:0, shadows:0, whites:0, blacks:0, clarity:0 },
  'i-Enhance': { contrast:0.1, saturation:0.2, vibrance:0.3, temp:0, tint:0, highlights:0, shadows:0, whites:0, blacks:0, clarity:0.1 },
  'Flat':      { contrast:-0.4, saturation:-0.1, vibrance:0, temp:0, tint:0, highlights:-0.3, shadows:0.3, whites:0, blacks:0, clarity:0 },
};

let activeProfile = null; // null = none

const LOOK_PARAMS = ['exposureEv','contrast','highlights','shadows','whites','blacks',
                     'saturation','vibrance','temp','tint','texture','clarity'];

function clampLook(k, v) {
  if (k === 'exposureEv') return Math.max(-3, Math.min(3, v));
  return Math.max(-1, Math.min(1, v));
}

// Called by main.js (injected into scheduleLiveUpdate)
window.mergedLook = function mergedLook(baseLook) {
  const pDeltas = activeProfile ? (BUILTIN_PROFILES[activeProfile] || getUserProfile(activeProfile) || {}) : {};
  const fDeltas = activeFilter  ? (PIPELINE_FILTERS[activeFilter] || {}) : {};
  const out = Object.assign({}, baseLook);
  for (const k of LOOK_PARAMS) {
    out[k] = clampLook(k, (out[k] ?? 0) + (pDeltas[k] ?? 0) + (fDeltas[k] ?? 0));
  }
  return out;
};

function setActiveProfile(name) {
  activeProfile = (activeProfile === name) ? null : name;
  renderProfileChips();
  if (typeof scheduleLiveUpdate === 'function') scheduleLiveUpdate();
}

window.setActiveProfile = setActiveProfile;

function renderProfileChips() {
  const el = document.getElementById('lb-profile-chips');
  if (!el) return;
  el.innerHTML = '';
  Object.keys(BUILTIN_PROFILES).forEach(name => {
    const btn = document.createElement('button');
    btn.className = 'lb-chip' + (activeProfile === name ? ' lb-chip-active' : '');
    btn.textContent = name;
    btn.addEventListener('click', () => setActiveProfile(name));
    el.appendChild(btn);
  });
  renderUserProfileChips();
}

function initProfiles() {
  renderProfileChips();
}
```

- [ ] **Step 3: Inject mergedLook into scheduleLiveUpdate in main.js**

In `web/main.js`, find `scheduleLiveUpdate` (around line 527). Find the inner call to `triggerLiveUpdate(currentLook())` (or wherever `currentLook()` is called to feed the live update) and change it to:

```js
const look = typeof mergedLook === 'function' ? mergedLook(currentLook()) : currentLook();
triggerLiveUpdate(look);
```

If `triggerLiveUpdate` is called with a look already passed in elsewhere, find that call and wrap it similarly.

- [ ] **Step 4: Verify in browser console**

With panels.js loaded, paste into console:

```js
// Vivid should add 0.3 sat to a base of 0.0
const base = { exposureEv:0, contrast:0, highlights:0, shadows:0, whites:0, blacks:0,
               saturation:0, vibrance:0, temp:0, tint:0, texture:0, clarity:0 };
activeProfile = 'Vivid';
const result = mergedLook(base);
console.assert(Math.abs(result.saturation - 0.3) < 0.001, 'Vivid sat should be 0.3');
console.assert(Math.abs(result.contrast   - 0.2) < 0.001, 'Vivid contrast should be 0.2');
activeProfile = null;
```

Expected: no assertion errors.

- [ ] **Step 5: Verify in browser**

Open lightbox. Press C. Click "Vivid" — image should update with more saturation/contrast. Click Vivid again — deselects, image returns to base.

- [ ] **Step 6: Commit**

```bash
git add web/index.html web/style.css web/panels.js web/main.js
git commit -m "feat(profiles): add 7 built-in colour profiles with delta merge"
```

---

## Task 5: User profiles (save / load / slots)

**Files:**
- Modify: `web/panels.js`
- Modify: `web/main.js`

- [ ] **Step 1: Implement user profile storage in panels.js**

Add after the `initProfiles` function:

```js
// ── User profiles ─────────────────────────────────────────────────
const USER_PROFILES_KEY = 'raw-profiles';

function loadUserProfiles() {
  try { return JSON.parse(localStorage.getItem(USER_PROFILES_KEY) || '[]'); }
  catch { return []; }
}

function saveUserProfiles(profiles) {
  localStorage.setItem(USER_PROFILES_KEY, JSON.stringify(profiles));
}

function getUserProfile(name) {
  return loadUserProfiles().find(p => p.name === name)?.look ?? null;
}

function saveCurrentAsProfile(name) {
  if (!name || !name.trim()) return;
  const profiles = loadUserProfiles();
  const look = typeof mergedLook === 'function'
    ? Object.assign({}, typeof currentLook === 'function' ? currentLook() : {})
    : {};
  const existing = profiles.findIndex(p => p.name === name);
  const entry = { name: name.trim(), look, filter: activeFilter };
  if (existing >= 0) profiles[existing] = entry;
  else profiles.push(entry);
  saveUserProfiles(profiles);
  renderUserProfileChips();
}

function loadUserProfileByIndex(idx) {
  const profiles = loadUserProfiles();
  const p = profiles[idx];
  if (!p) return;
  if (typeof applyLookValues === 'function') applyLookValues(p.look);
  if (p.filter) setActiveFilter(p.filter);
  activeProfile = null;
  renderProfileChips();
}

function renderUserProfileChips() {
  const el = document.getElementById('lb-user-profile-chips');
  if (!el) return;
  el.innerHTML = '';
  const profiles = loadUserProfiles();
  profiles.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.className = 'lb-chip' + (activeProfile === p.name ? ' lb-chip-active' : '');
    btn.textContent = `${i + 1}. ${p.name}`;
    btn.title = `Ctrl+Shift+${(i + 1) % 10}`;
    btn.addEventListener('click', () => loadUserProfileByIndex(i));
    el.appendChild(btn);
  });
}
```

- [ ] **Step 2: Add Ctrl+Shift+S / L / 1–0 to main.js keyboard handler**

In the keyboard handler block in `web/main.js` (around line 1813), add inside the global key handler (not gated by lightbox-open):

```js
// User profiles
if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
  e.preventDefault();
  const name = prompt('Save profile as:');
  if (name && typeof saveCurrentAsProfile === 'function') saveCurrentAsProfile(name);
  return;
}
if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'L') {
  e.preventDefault();
  if (typeof togglePanel === 'function') togglePanel('c');
  return;
}
const slotMatch = (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.match(/^[0-9]$/);
if (slotMatch) {
  e.preventDefault();
  const idx = e.key === '0' ? 9 : parseInt(e.key, 10) - 1;
  if (typeof loadUserProfileByIndex === 'function') loadUserProfileByIndex(idx);
  return;
}
```

- [ ] **Step 3: Add Ctrl+1–9 / Ctrl+0 for B&W quick-select to main.js**

In the same keyboard handler (must check that it's NOT Shift to avoid colliding with slot keys):

```js
// B&W quick-select (Ctrl+1–9 / Ctrl+0)
const bwMatch = (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.match(/^[0-9]$/);
if (bwMatch) {
  e.preventDefault();
  const BW_KEYS = ['B&W Natural','B&W Soft','B&W Strong','B&W Red','B&W Orange',
                   'B&W Yellow','B&W Green','B&W Blue','Infrared'];
  const bwIdx = e.key === '0' ? -1 : parseInt(e.key, 10) - 1;
  if (typeof setActiveFilter === 'function') setActiveFilter(bwIdx < 0 ? null : BW_KEYS[bwIdx]);
  return;
}
```

- [ ] **Step 4: Verify in browser**

Open lightbox. Press `Ctrl+Shift+S`, enter "My Test". Profile appears in My Profiles section. Press `Ctrl+Shift+1` — it loads. Press `Ctrl+2` — B&W Soft applies. Press `Ctrl+0` — filter clears.

- [ ] **Step 5: Commit**

```bash
git add web/panels.js web/main.js
git commit -m "feat(profiles): add user profile save/load with Ctrl+Shift shortcuts"
```

---

## Task 6: Pipeline filters (B&W suite + creative looks)

**Files:**
- Modify: `web/index.html`
- Modify: `web/panels.js`

- [ ] **Step 1: Add filters HTML to panel F body in index.html**

Replace empty panel F body with:

```html
<div class="lb-panel-body" hidden>
  <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">B&amp;W</div>
  <div id="lb-bw-chips" class="lb-chip-group"></div>
  <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.05em;margin:10px 0 8px">Creative</div>
  <div id="lb-creative-chips" class="lb-chip-group"></div>
  <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.05em;margin:10px 0 8px">Overlays</div>
  <div id="lb-overlay-chips" class="lb-chip-group"></div>
  <div style="margin-top:8px;font-size:11px;color:#666">Ctrl+1–9 B&amp;W · Ctrl+0 clear</div>
</div>
```

- [ ] **Step 2: Implement pipeline filters in panels.js**

Add after the user profiles block:

```js
// ── Pipeline Filters ──────────────────────────────────────────────
const PIPELINE_FILTERS = {
  'B&W Natural': { saturation:-1.0, contrast:0,     temp:0,     tint:0,    highlights:0,    shadows:0,    whites:0,     blacks:0 },
  'B&W Soft':    { saturation:-1.0, contrast:-0.25, temp:0,     tint:0,    highlights:-0.15, shadows:0.2,  whites:0,     blacks:0 },
  'B&W Strong':  { saturation:-1.0, contrast:0.4,   temp:0,     tint:0,    highlights:0,    shadows:0,    whites:0.15,  blacks:-0.15 },
  'B&W Red':     { saturation:-1.0, contrast:0,     temp:0.4,   tint:-0.1, highlights:0,    shadows:0,    whites:0,     blacks:0 },
  'B&W Orange':  { saturation:-1.0, contrast:0,     temp:0.25,  tint:0,    highlights:0,    shadows:0,    whites:0,     blacks:0 },
  'B&W Yellow':  { saturation:-1.0, contrast:0,     temp:0.12,  tint:0,    highlights:0,    shadows:0,    whites:0,     blacks:0 },
  'B&W Green':   { saturation:-1.0, contrast:0,     temp:-0.15, tint:0.2,  highlights:0,    shadows:0,    whites:0,     blacks:0 },
  'B&W Blue':    { saturation:-1.0, contrast:0,     temp:-0.35, tint:0,    highlights:0,    shadows:0,    whites:0,     blacks:0 },
  'Infrared':    { saturation:-1.0, contrast:0,     temp:0.5,   tint:0,    highlights:0.4,  shadows:0,    whites:0.3,   blacks:0 },
  'Fade':          { saturation:0,    contrast:-0.3,  temp:0,     tint:0,    highlights:0,    shadows:0,    whites:-0.1,  blacks:0.15, vibrance:0, clarity:0 },
  'Cross-process': { saturation:0.3,  contrast:0.2,   temp:-0.2,  tint:0.3,  highlights:0,    shadows:0,    whites:0,     blacks:0, vibrance:0, clarity:0 },
  'Bleach bypass': { saturation:-0.5, contrast:0.4,   temp:0,     tint:0,    highlights:0,    shadows:0,    whites:0,     blacks:0, vibrance:0, clarity:0.2 },
};

const BW_NAMES       = ['B&W Natural','B&W Soft','B&W Strong','B&W Red','B&W Orange','B&W Yellow','B&W Green','B&W Blue','Infrared'];
const CREATIVE_NAMES = ['Fade','Cross-process','Bleach bypass'];

let activeFilter = null; // null = none

function setActiveFilter(name) {
  activeFilter = (activeFilter === name) ? null : name;
  renderFilterChips();
  if (typeof scheduleLiveUpdate === 'function') scheduleLiveUpdate();
}

window.setActiveFilter = setActiveFilter;

function renderFilterChips() {
  function buildChips(containerId, names) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '';
    names.forEach(name => {
      const btn = document.createElement('button');
      btn.className = 'lb-chip' + (activeFilter === name ? ' lb-chip-active' : '');
      btn.textContent = name;
      btn.addEventListener('click', () => setActiveFilter(name));
      el.appendChild(btn);
    });
  }
  buildChips('lb-bw-chips',       BW_NAMES);
  buildChips('lb-creative-chips', CREATIVE_NAMES);
}

function initFilters() {
  renderFilterChips();
  initOverlayFilters();
}
```

- [ ] **Step 3: Verify filter merge in browser console**

```js
const base = { exposureEv:0, contrast:0, highlights:0, shadows:0, whites:0, blacks:0,
               saturation:0.2, vibrance:0, temp:0, tint:0, texture:0, clarity:0 };
activeFilter = 'B&W Red';
const r = mergedLook(base);
console.assert(Math.abs(r.saturation - (-1.0 + 0.2)) < 0.001, 'B&W Red: sat should be -0.8');
console.assert(Math.abs(r.temp - 0.4) < 0.001, 'B&W Red: temp should be 0.4');
activeFilter = null;
```

Expected: no assertion errors.

- [ ] **Step 4: Verify in browser**

Open lightbox, press F. Click "B&W Red" — image goes warm-toned black and white. Click again — deselects. Press Ctrl+4 — B&W Red applies via keyboard shortcut.

- [ ] **Step 5: Commit**

```bash
git add web/index.html web/panels.js
git commit -m "feat(filters): add 12 pipeline filters with B&W suite and creative looks"
```

---

## Task 7: CSS overlay filters (film grain + vignette)

**Files:**
- Modify: `web/panels.js`

- [ ] **Step 1: Implement overlay filter logic in panels.js**

Add the `initOverlayFilters` function (referenced in Task 6's `initFilters`):

```js
// ── CSS Overlay Filters ───────────────────────────────────────────
let grainActive   = false;
let vignetteActive = false;

function initGrainCanvas() {
  const canvas = document.getElementById('lb-grain-overlay');
  if (!canvas) return;
  const W = canvas.width  = canvas.offsetWidth  || 1280;
  const H = canvas.height = canvas.offsetHeight || 800;
  const ctx = canvas.getContext('2d');
  // SVG feTurbulence via OffscreenCanvas isn't universally available —
  // use manual random noise for compatibility
  const imgData = ctx.createImageData(W, H);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.floor(Math.random() * 255);
    d[i] = d[i+1] = d[i+2] = v;
    d[i+3] = 38; // ~15% opacity
  }
  ctx.putImageData(imgData, 0, 0);
}

function setGrain(on) {
  grainActive = on;
  const el = document.getElementById('lb-grain-overlay');
  if (!el) return;
  el.hidden = !on;
  if (on) initGrainCanvas();
}

function setVignette(on) {
  vignetteActive = on;
  const el = document.getElementById('lb-vignette-overlay');
  if (!el) return;
  el.hidden = !on;
}

function initOverlayFilters() {
  const el = document.getElementById('lb-overlay-chips');
  if (!el) return;

  function makeChip(label, onClick, isActive) {
    const btn = document.createElement('button');
    btn.className = 'lb-chip' + (isActive() ? ' lb-chip-active' : '');
    btn.textContent = label;
    btn.dataset.overlay = label;
    btn.addEventListener('click', () => {
      onClick();
      btn.classList.toggle('lb-chip-active', isActive());
    });
    return btn;
  }

  el.appendChild(makeChip('Film grain', () => setGrain(!grainActive),   () => grainActive));
  el.appendChild(makeChip('Vignette',   () => setVignette(!vignetteActive), () => vignetteActive));
}
```

- [ ] **Step 2: Verify in browser**

Open lightbox, press F. Click "Film grain" — noise texture overlays the image. Click again — removes. Click "Vignette" — dark edges appear. Both can be active simultaneously.

- [ ] **Step 3: Commit**

```bash
git add web/panels.js
git commit -m "feat(filters): add film grain and vignette CSS overlay filters"
```

---

## Task 8: Sidecar persistence (Ctrl+S, auto-load, dot badge)

**Files:**
- Modify: `web/panels.js`
- Modify: `web/main.js`
- Modify: `web/style.css`
- Modify: `C:\Foo\raw-converter-tauri\src-tauri\src\push.rs`
- Modify: `C:\Foo\raw-converter-tauri\src-tauri\src\lib.rs`

- [ ] **Step 1: Add Tauri read_look / write_look commands to push.rs**

In `C:\Foo\raw-converter-tauri\src-tauri\src\push.rs`, after the existing `push_to_planner` function, add:

```rust
#[tauri::command]
pub async fn read_look(path: String) -> Result<Option<String>, String> {
    let look_path = format!("{}.look.json", path);
    match std::fs::read_to_string(&look_path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn write_look(path: String, json: String) -> Result<(), String> {
    let look_path = format!("{}.look.json", path);
    std::fs::write(&look_path, &json).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register commands in lib.rs**

In `C:\Foo\raw-converter-tauri\src-tauri\src\lib.rs`, find the `tauri::generate_handler!` macro and add the new commands:

```rust
.invoke_handler(tauri::generate_handler![
    pipeline::process_file,
    pipeline::apply_look,
    push::pick_files,
    push::push_to_planner,
    push::get_token,
    push::set_token,
    push::get_settings,
    push::set_settings,
    push::read_look,   // add
    push::write_look,  // add
])
```

- [ ] **Step 3: Build Tauri to verify commands compile**

```powershell
$env:PATH = "C:\Program Files\LLVM\bin;C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64;" + $env:PATH
$env:LLVMInstallDir = "C:\Program Files\LLVM"
$env:LLVMToolsVersion = "22"
Set-Location C:\Foo\raw-converter-tauri
cargo build -p raw-converter-tauri 2>&1 | Select-Object -Last 5
```

Expected: `Finished` with no errors.

- [ ] **Step 4: Implement sidecar in panels.js**

Add the full sidecar block after the overlay filters:

```js
// ── Sidecar persistence ───────────────────────────────────────────
let _sidecarFilePath = null; // set by main.js when lightbox opens

function sidecarKey(filename) { return `raw-sidecar:${filename}`; }

function buildSidecarObject(filename) {
  return {
    filename,
    look: typeof currentLook === 'function' ? currentLook() : {},
    profile: activeProfile,
    filter:  activeFilter,
    levels:  Object.assign({}, levelsState),
  };
}

function applySidecar(data) {
  if (!data) return;
  if (data.look  && typeof applyLookValues  === 'function') applyLookValues(data.look);
  if (data.profile !== undefined) { activeProfile = data.profile; renderProfileChips(); }
  if (data.filter  !== undefined) { activeFilter  = data.filter;  renderFilterChips(); }
  if (data.levels) {
    Object.assign(levelsState, data.levels);
    ['inBlack','inMid','inWhite','outBlack','outWhite'].forEach(syncHandlePosition);
  }
}

async function saveSidecar(filename) {
  const obj  = buildSidecarObject(filename);
  const json = JSON.stringify(obj);
  if (typeof IS_TAURI !== 'undefined' && IS_TAURI && _sidecarFilePath) {
    try { await invoke('write_look', { path: _sidecarFilePath, json }); }
    catch (e) { console.warn('write_look failed:', e); }
  }
  localStorage.setItem(sidecarKey(filename), json);
}

async function loadSidecar(filename, filePath) {
  _sidecarFilePath = filePath ?? null;
  let data = null;
  if (typeof IS_TAURI !== 'undefined' && IS_TAURI && filePath) {
    try {
      const raw = await invoke('read_look', { path: filePath });
      if (raw) data = JSON.parse(raw);
    } catch {}
  }
  if (!data) {
    const raw = localStorage.getItem(sidecarKey(filename));
    if (raw) try { data = JSON.parse(raw); } catch {}
  }
  if (data) applySidecar(data);
  return !!data;
}

function markCardSidecar(filename, hasSidecar) {
  const cards = document.querySelectorAll('.thumb');
  cards.forEach(card => {
    const nameEl = card.querySelector('.name');
    if (nameEl && nameEl.textContent === filename) {
      let dot = card.querySelector('.sidecar-dot');
      if (hasSidecar && !dot) {
        dot = document.createElement('div');
        dot.className = 'sidecar-dot';
        card.appendChild(dot);
      } else if (!hasSidecar && dot) {
        dot.remove();
      }
    }
  });
}

window.saveSidecar  = saveSidecar;
window.loadSidecar  = loadSidecar;
window.markCardSidecar = markCardSidecar;

function initSidecar() { /* no DOM setup needed */ }
```

- [ ] **Step 5: Add sidecar dot CSS to style.css**

```css
/* ── Sidecar dot badge ── */
.sidecar-dot {
  position: absolute;
  bottom: 6px;
  right: 6px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #4a9eff;
  box-shadow: 0 0 4px rgba(74,158,255,0.7);
  pointer-events: none;
  z-index: 5;
}
```

- [ ] **Step 6: Add Ctrl+S to main.js keyboard handler**

In the keyboard handler in `web/main.js`, add (in the lightbox-open block):

```js
if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 's') {
  e.preventDefault();
  const card = cards[lightboxIndex];
  if (card && typeof saveSidecar === 'function') {
    const filename = card._filename || card.querySelector('.name')?.textContent;
    const filePath = card._filePath ?? null; // Tauri cards set _filePath
    saveSidecar(filename).then(() => markCardSidecar(filename, true));
  }
  return;
}
```

- [ ] **Step 7: Auto-load sidecar in openLightbox in main.js**

In `openLightbox(card)` in `web/main.js` (line ~1658), after the function opens the lightbox and before `triggerLiveUpdate`, add:

```js
if (typeof loadSidecar === 'function') {
  const filename = card._filename || card.querySelector('.name')?.textContent;
  const filePath = card._filePath ?? null;
  loadSidecar(filename, filePath);
}
```

- [ ] **Step 8: Verify in browser (WASM path)**

Open `http://localhost:5173`. Load ORF, open lightbox. Set Vivid profile + B&W Red filter. Press Ctrl+S. Close lightbox. Reopen — profile and filter should restore. Blue dot should appear on card thumbnail.

- [ ] **Step 9: Commit**

```bash
# Commit wasm side
cd C:\Foo\raw-converter-wasm
git add web/panels.js web/main.js web/style.css
git commit -m "feat(sidecar): add Ctrl+S per-image look persistence with dot badge"

# Commit Tauri side
cd C:\Foo\raw-converter-tauri
git add src-tauri/src/push.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): add read_look / write_look sidecar commands"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| H/C/F panels, top-right stack, collapse to icon | Task 1 |
| H/C/F keyboard toggle | Task 1 |
| Histogram L/RGB modes, log scale | Task 2 |
| Recompute after every draw | Task 2 |
| 5-handle levels, remap formula, reset | Task 3 |
| Histogram reflects remapped output | Task 2 (applyLevels called before histogram read) |
| 7 built-in profiles, deselect | Task 4 |
| Look merge order (base + profile + filter) | Tasks 4, 6 |
| User profiles: Ctrl+Shift+S/L/1–0 | Task 5 |
| localStorage storage for user profiles | Task 5 |
| 9 B&W pipeline filters | Task 6 |
| 3 creative pipeline filters | Task 6 |
| Ctrl+1–9 B&W / Ctrl+0 clear | Task 5 |
| Film grain + vignette CSS overlays, independent | Task 7 |
| Ctrl+S sidecar save | Task 8 |
| Auto-load on lightbox open | Task 8 |
| Dot badge on card | Task 8 |
| Tauri: sidecar next to ORF via read_look/write_look | Task 8 |
| Browser: sidecar in localStorage | Task 8 |
| IS_TAURI=false path unbroken | Tasks 1–8 (all conditional or additive) |
