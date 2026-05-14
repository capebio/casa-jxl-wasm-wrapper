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

// ── Pipeline Filters ──────────────────────────────────────────────
let activeFilter    = null;
let grainActive     = false;
let vignetteActive  = false;
let PIPELINE_FILTERS = {
  'B&W Natural': { saturation:-1.0, contrast:0,     temp:0,     tint:0,    highlights:0,     shadows:0,   whites:0,     blacks:0 },
  'B&W Soft':    { saturation:-1.0, contrast:-0.25, temp:0,     tint:0,    highlights:-0.15,  shadows:0.2, whites:0,     blacks:0 },
  'B&W Strong':  { saturation:-1.0, contrast:0.4,   temp:0,     tint:0,    highlights:0,     shadows:0,   whites:0.15,  blacks:-0.15 },
  'B&W Red':     { saturation:-1.0, contrast:0,     temp:0.4,   tint:-0.1, highlights:0,     shadows:0,   whites:0,     blacks:0 },
  'B&W Orange':  { saturation:-1.0, contrast:0,     temp:0.25,  tint:0,    highlights:0,     shadows:0,   whites:0,     blacks:0 },
  'B&W Yellow':  { saturation:-1.0, contrast:0,     temp:0.12,  tint:0,    highlights:0,     shadows:0,   whites:0,     blacks:0 },
  'B&W Green':   { saturation:-1.0, contrast:0,     temp:-0.15, tint:0.2,  highlights:0,     shadows:0,   whites:0,     blacks:0 },
  'B&W Blue':    { saturation:-1.0, contrast:0,     temp:-0.35, tint:0,    highlights:0,     shadows:0,   whites:0,     blacks:0 },
  'Infrared':    { saturation:-1.0, contrast:0,     temp:0.5,   tint:0,    highlights:0.4,   shadows:0,   whites:0.3,   blacks:0 },
  'Fade':          { saturation:0,   contrast:-0.3, temp:0,    tint:0,   highlights:0, shadows:0, whites:-0.1, blacks:0.15 },
  'Cross-process': { saturation:0.3, contrast:0.2,  temp:-0.2, tint:0.3, highlights:0, shadows:0, whites:0,    blacks:0 },
  'Bleach bypass': { saturation:-0.5, contrast:0.4, temp:0,    tint:0,   highlights:0, shadows:0, whites:0,    blacks:0, clarity:0.2 },
};

const BW_NAMES       = ['B&W Natural','B&W Soft','B&W Strong','B&W Red','B&W Orange','B&W Yellow','B&W Green','B&W Blue','Infrared'];
window.BW_NAMES = BW_NAMES;
const CREATIVE_NAMES = ['Fade','Cross-process','Bleach bypass'];

function setActiveFilter(name) {
  if (name === null) { activeFilter = null; }
  else { activeFilter = (activeFilter === name) ? null : name; }
  renderFilterChips();
  if (typeof window.scheduleLiveUpdate === 'function') window.scheduleLiveUpdate();
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
  buildOverlayChips();
}

function buildOverlayChips() {
  const el = document.getElementById('lb-overlay-chips');
  if (!el) return;
  el.innerHTML = '';

  const grainBtn = document.createElement('button');
  grainBtn.className = 'lb-chip' + (grainActive ? ' lb-chip-active' : '');
  grainBtn.textContent = 'Film grain';
  grainBtn.addEventListener('click', toggleGrain);
  el.appendChild(grainBtn);

  const vigBtn = document.createElement('button');
  vigBtn.className = 'lb-chip' + (vignetteActive ? ' lb-chip-active' : '');
  vigBtn.textContent = 'Vignette';
  vigBtn.addEventListener('click', toggleVignette);
  el.appendChild(vigBtn);
}

function toggleGrain() {
  grainActive = !grainActive;
  const canvas = document.getElementById('lb-grain-overlay');
  if (!canvas) return;
  if (grainActive) {
    canvas.style.display = 'block';
    drawGrain(canvas);
  } else {
    canvas.style.display = 'none';
  }
  buildOverlayChips();
}

function toggleVignette() {
  vignetteActive = !vignetteActive;
  const el = document.getElementById('lb-vignette-overlay');
  if (el) el.style.display = vignetteActive ? 'block' : 'none';
  buildOverlayChips();
}

function drawGrain(canvas) {
  const w = canvas.width  || canvas.offsetWidth  || 800;
  const h = canvas.height || canvas.offsetHeight || 600;
  canvas.width  = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <filter id="noise">
      <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
    </filter>
    <rect width="100%" height="100%" filter="url(#noise)" opacity="1"/>
  </svg>`;
  const blob = new Blob([svg], {type: 'image/svg+xml'});
  const url  = URL.createObjectURL(blob);
  const img  = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

function initFilters() {
  renderFilterChips();
}
function initSidecar()   {}
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
  const look = typeof window.currentLook === 'function' ? window.currentLook() : {};
  const entry = { name: name.trim(), look, filter: activeFilter };
  const existing = profiles.findIndex(p => p.name === name.trim());
  if (existing >= 0) profiles[existing] = entry;
  else profiles.push(entry);
  saveUserProfiles(profiles);
  renderUserProfileChips();
}

function loadUserProfileByIndex(idx) {
  const profiles = loadUserProfiles();
  const p = profiles[idx];
  if (!p) return;
  if (typeof window.applyLookValues === 'function') window.applyLookValues(p.look);
  if (p.filter && typeof setActiveFilter === 'function') setActiveFilter(p.filter);
  activeProfile = p.name;
  renderProfileChips();
}

window.saveCurrentAsProfile  = saveCurrentAsProfile;
window.loadUserProfileByIndex = loadUserProfileByIndex;

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

let activeProfile = null;

const LOOK_PARAMS = ['exposureEv','contrast','highlights','shadows','whites','blacks',
                     'saturation','vibrance','temp','tint','texture','clarity'];

function clampLook(k, v) {
  if (k === 'exposureEv') return Math.max(-3, Math.min(3, v));
  return Math.max(-1, Math.min(1, v));
}

window.mergedLook = function mergedLook(baseLook) {
  const pDeltas = activeProfile ? (BUILTIN_PROFILES[activeProfile] || getUserProfile(activeProfile) || {}) : {};
  const fDeltas = activeFilter  ? (PIPELINE_FILTERS[activeFilter]  || {}) : {};
  const out = Object.assign({}, baseLook);
  for (const k of LOOK_PARAMS) {
    out[k] = clampLook(k, (out[k] ?? 0) + (pDeltas[k] ?? 0) + (fDeltas[k] ?? 0));
  }
  return out;
};

function setActiveProfile(name) {
  activeProfile = (activeProfile === name) ? null : name;
  renderProfileChips();
  if (typeof window.scheduleLiveUpdate === 'function') window.scheduleLiveUpdate();
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

function initProfiles() {
  renderProfileChips();
}
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
