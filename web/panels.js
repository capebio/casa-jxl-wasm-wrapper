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

// ── Stubs for later tasks (replaced in Tasks 2-8) ─────────────────
function initHistogram() {}
function initProfiles()  {}
function initFilters()   {}
function initSidecar()   {}
function updateHistogramAndLevels() {}
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
