// panels.js — lightbox panels: histogram, colour profiles, filters, sidecar
// Loaded as plain script after main.js. Uses globals exposed by main.js on window.

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
    btn.addEventListener('click', () => togglePanel(key));
  });
}

function togglePanel(key) {
  const body = panelBodies[key];
  const btn  = panelBtns[key];
  if (!body || !btn) return;
  const opening = body.hidden;
  body.hidden = !opening;
  btn.classList.toggle('active', opening);
  if (key === 'h' && opening && typeof updateHistogramAndLevels === 'function') {
    updateHistogramAndLevels();
  }
}

window.togglePanel = togglePanel;

// ── Stubs for later tasks (replaced in Tasks 3-8) ─────────────────
function initProfiles()  {}
function initFilters()   {}
function initSidecar()   {}
// ── Clean canvas cache ────────────────────────────────────────────
// Stores a copy of the last WASM-rendered pixels before levels are applied.
// updateHistogramAndLevels always starts from this clean copy so dragging
// a levels handle doesn't compound the transform on each tick.
let _cleanData = null; // Uint8ClampedArray
let _cleanW    = 0;
let _cleanH    = 0;

function setCleanCanvas(imageData) {
  _cleanData = new Uint8ClampedArray(imageData.data); // deep copy
  _cleanW    = imageData.width;
  _cleanH    = imageData.height;
  updateHistogramAndLevels();
}

window.setCleanCanvas = setCleanCanvas;

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
  const idMap = { inBlack: 'lb-lvl-in-black', inMid: 'lb-lvl-in-mid',
                  inWhite: 'lb-lvl-in-white', outBlack: 'lb-lvl-out-black', outWhite: 'lb-lvl-out-white' };
  const el = document.getElementById(idMap[key]);
  if (!el) return;
  let pct;
  if (key === 'inBlack')  pct = (levelsState.inBlack  / 255) * 100;
  else if (key === 'inWhite')  pct = (levelsState.inWhite  / 255) * 100;
  else if (key === 'inMid') {
    // gamma 0.1–10 mapped logarithmically: log10(1.0)=0 → 50%, larger=brighter(left)
    const logVal = Math.log10(levelsState.inMid); // range -1 to +1
    pct = (1 - (logVal + 1) / 2) * 100;
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
      startVal = key === 'inMid' ? Math.log10(levelsState.inMid) : levelsState[key];
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup',  onUp);
    });

    function onMove(e) {
      if (!dragging) return;
      const track = handle.closest('.lb-levels-track');
      const trackW = track.getBoundingClientRect().width;
      if (trackW === 0) return;
      const dx = e.clientX - startX;
      const dpct = dx / trackW;

      if (key === 'inMid') {
        // log scale: left = brighter (gamma > 1), right = darker (gamma < 1)
        const newLog = Math.max(-1, Math.min(1, startVal - dpct));
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

window.levelsState = levelsState;
window.syncHandlePosition = syncHandlePosition;

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
  const hPanel = document.getElementById('lb-panel-h');
  if (!hPanel) return;
  const lbCanvas = document.getElementById('lightbox-canvas');
  if (!lbCanvas) return;
  if (!_cleanData || _cleanW === 0 || _cleanH === 0) return;
  if (hPanel.querySelector('.lb-panel-body').hidden) return;

  // Work from the clean pre-levels copy, never from the already-leveled canvas
  const workBuf = new Uint8ClampedArray(_cleanData);
  const imageData = new ImageData(workBuf, _cleanW, _cleanH);
  applyLevelsToImageData(imageData);
  const ctx = lbCanvas.getContext('2d');
  ctx.putImageData(imageData, 0, 0);
  // imageData was modified in-place by applyLevelsToImageData — histogram reflects post-levels output
  const hist = computeHistogram(imageData.data);
  drawHistogram(hist);
}

window.updateHistogramAndLevels = updateHistogramAndLevels;

// ── Initialise on DOMContentLoaded ────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initPanelToggles();
  initHistogram();
  initLevels();
  initProfiles();
  initFilters();
  initSidecar();
});

})();
