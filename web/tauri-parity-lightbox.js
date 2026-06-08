/**
 * Tauri M2/M3 lightbox parity — CasaBio FilterEngine + 16-bit WebGL HDR path.
 * Complements H29 (Rust apply_look_stream for LR develop sliders) with client-side
 * M2 matrix/tone transforms and optional M3 float-texture rendering.
 */
import { APPROVED_LIGHTBOX_PRESETS } from '../packages/jxl-pyramid/dist/constants.js';
import {
  applyColorMatrixInPlace,
  applyToneMapInPlace,
  buildColorMatrix,
  clampAdjustments,
  computeHistogram,
} from './lightbox/filter-engine.js';
import {
  canUseWebGL16,
  renderRgba16AdjustedToCanvas,
} from './lightbox/webgl-pipeline.js';

const M2_RANGES = {
  brightness: [-100, 100],
  contrast: [-100, 100],
  saturation: [-100, 100],
  shadows: [0, 100],
  highlights: [-100, 0],
  clarity: [0, 100],
  dehaze: [0, 100],
  sharpness: [0, 100],
};

/**
 * @param {{
 *   rootEl: HTMLElement;
 *   canvas: HTMLCanvasElement;
 *   histCanvas?: HTMLCanvasElement | null;
 *   invoke: (cmd: string, args?: object) => Promise<unknown>;
 *   getActiveCard: () => object | null;
 *   onRepaintRequest?: () => void;
 * }} opts
 */
export function createTauriParityLightbox(opts) {
  const { rootEl, canvas, histCanvas, invoke, getActiveCard, onRepaintRequest } = opts;
  const panel = rootEl.querySelector('[data-tauri-m2-panel]');
  const presetSelect = rootEl.querySelector('[data-m2-preset]');
  const toggle16 = rootEl.querySelector('[data-toggle-16bit]');
  const m2Inputs = [...rootEl.querySelectorAll('[data-m2]')];

  const state = {
    preset: 'NONE',
    adjustments: clampAdjustments(),
    use16Bit: false,
    rgb16Cache: null,
    pending16: null,
  };

  function currentM2Adjustments() {
    const raw = {};
    for (const el of m2Inputs) {
      raw[el.dataset.m2] = Number(el.value);
    }
    return clampAdjustments(raw);
  }

  function paintHistogram(rgba, width, height) {
    if (!histCanvas) return;
    const hctx = histCanvas.getContext('2d');
    if (!hctx) return;
    const hist = computeHistogram(rgba, width, height);
    hctx.clearRect(0, 0, histCanvas.width, histCanvas.height);
    const bins = hist.bins;
    const max = Math.max(...hist.y, 1);
    for (let i = 0; i < bins; i++) {
      const h = (hist.y[i] / max) * histCanvas.height;
      hctx.fillStyle = '#ccc';
      hctx.fillRect((i / bins) * histCanvas.width, histCanvas.height - h, histCanvas.width / bins, h);
    }
  }

  /** Apply M2 FilterEngine on top of an RGBA8 baseline (in-place copy). */
  function applyM2ToRgba(rgba, width, height) {
    const adj = state.adjustments;
    const matrix = buildColorMatrix(state.preset, adj);
    applyColorMatrixInPlace(rgba, width, height, matrix);
    applyToneMapInPlace(rgba, width, height, adj.shadows, adj.highlights);
    return rgba;
  }

  function storeBaseline(card, rgba, width, height) {
    if (!card) return;
    card._m2Baseline = new Uint8ClampedArray(rgba);
    card._m2BaselineW = width;
    card._m2BaselineH = height;
  }

  function paintFromBaseline(card) {
    if (!card?._m2Baseline) return false;
    const w = card._m2BaselineW;
    const h = card._m2BaselineH;
    const rgba = new Uint8ClampedArray(card._m2Baseline);
    applyM2ToRgba(rgba, w, h);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
    paintHistogram(rgba, w, h);
    return true;
  }

  async function paint16Bit(card) {
    const id = card?._tauriResult?.id;
    if (id == null) return false;
    state.adjustments = currentM2Adjustments();
    try {
      if (!state.rgb16Cache || state.rgb16Cache.id !== id) {
        const buf = await invoke('get_rgb16_for_id', { id });
        const view = new DataView(buf instanceof ArrayBuffer ? buf : buf);
        const w = view.getUint16(0, true);
        const h = view.getUint16(2, true);
        const body = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf, 4);
        state.rgb16Cache = { id, w, h, body };
      }
      const { w, h, body } = state.rgb16Cache;
      canvas.width = w;
      canvas.height = h;
      renderRgba16AdjustedToCanvas(body, w, h, canvas, state.preset, state.adjustments);
      const ctx = canvas.getContext('2d');
      const img = ctx.getImageData(0, 0, w, h);
      paintHistogram(img.data, w, h);
      return true;
    } catch (e) {
      console.warn('get_rgb16_for_id failed:', e);
      state.use16Bit = false;
      if (toggle16) toggle16.checked = false;
      return paintFromBaseline(card);
    }
  }

  /** Called after Rust/Channel/JXL paint establishes a clean 8-bit baseline. */
  function onBaseFramePainted(card, rgba, width, height) {
    storeBaseline(card, rgba, width, height);
    if (state.use16Bit && card?._sourceMode !== 'jxl' && canUseWebGL16()) {
      paint16Bit(card);
      return;
    }
    paintFromBaseline(card);
  }

  function repaint() {
    const card = getActiveCard();
    if (!card) return;
    state.adjustments = currentM2Adjustments();
    if (state.use16Bit && card._sourceMode !== 'jxl' && canUseWebGL16()) {
      paint16Bit(card);
      return;
    }
    if (paintFromBaseline(card)) return;
    onRepaintRequest?.();
  }

  function resetM2() {
    state.preset = 'NONE';
    state.adjustments = clampAdjustments();
    if (presetSelect) presetSelect.value = 'NONE';
    for (const el of m2Inputs) el.value = '0';
    repaint();
  }

  function sync16ToggleVisibility(card) {
    if (!toggle16) return;
    const rawOnly = card && card._sourceMode !== 'jxl';
    toggle16.closest('label')?.toggleAttribute('hidden', !rawOnly);
    if (!rawOnly && state.use16Bit) {
      state.use16Bit = false;
      toggle16.checked = false;
      state.rgb16Cache = null;
    }
  }

  if (presetSelect) {
    presetSelect.innerHTML = '';
    for (const name of APPROVED_LIGHTBOX_PRESETS) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name === 'NONE' ? 'None' : name.replace(/_/g, ' ');
      presetSelect.appendChild(opt);
    }
    presetSelect.addEventListener('change', () => {
      state.preset = presetSelect.value;
      repaint();
    });
  }

  for (const el of m2Inputs) {
    el.addEventListener('input', () => {
      state.adjustments = currentM2Adjustments();
      repaint();
    });
  }

  const resetBtn = rootEl.querySelector('[data-m2-reset]');
  resetBtn?.addEventListener('click', resetM2);

  toggle16?.addEventListener('change', () => {
    state.use16Bit = !!toggle16.checked;
    state.rgb16Cache = null;
    repaint();
  });

  if (panel) panel.hidden = false;

  return {
    onBaseFramePainted,
    repaint,
    resetM2,
    sync16ToggleVisibility,
    clearCache() {
      state.rgb16Cache = null;
    },
    get state() {
      return state;
    },
  };
}

export { M2_RANGES };