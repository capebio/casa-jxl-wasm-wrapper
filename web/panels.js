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
// Stub — replaced in Task 3
function applyLevelsToImageData(_imageData) { /* no-op until Task 3 */ }

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
  const hPanel = document.getElementById('lb-panel-h');
  if (!lbCanvas || !hPanel) return;
  if (hPanel.querySelector('.lb-panel-body').hidden) return;
  const ctx = lbCanvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, lbCanvas.width, lbCanvas.height);
  applyLevelsToImageData(imageData);
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
  initProfiles();
  initFilters();
  initSidecar();
});

})();
