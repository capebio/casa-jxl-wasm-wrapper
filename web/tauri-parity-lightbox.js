/**
 * Tauri M2/M3 lightbox parity — CasaBio FilterEngine + 16-bit WebGL HDR path.
 * Complements H29 (Rust apply_look_stream for LR develop sliders) with client-side
 * M2 matrix/tone transforms and optional M3 float-texture rendering.
 */
import { APPROVED_LIGHTBOX_PRESETS } from '../packages/jxl-pyramid/dist/constants.js';
import { chooseLevelForTarget } from '../packages/jxl-pyramid/dist/choose-level.js';
import {
  applyColorMatrixInPlace,
  applyToneMapInPlace,
  buildColorMatrix,
  clampAdjustments,
  computeHistogram,
} from './lightbox/filter-engine.js';
import {
  adjustedRgba16ForExport,
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

const M2_SLIDERS = [
  'brightness', 'contrast', 'saturation', 'shadows', 'highlights', 'clarity', 'dehaze', 'sharpness',
];

function parsePackedResponse(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const w = u8[0] | (u8[1] << 8);
  const h = u8[2] | (u8[3] << 8);
  return { w, h, body: u8.subarray(4) };
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * @param {{
 *   rootEl: HTMLElement;
 *   canvas: HTMLCanvasElement;
 *   histCanvas?: HTMLCanvasElement | null;
 *   invoke: (cmd: string, args?: object) => Promise<unknown>;
 *   getActiveCard: () => object | null;
 *   onRepaintRequest?: () => void;
 *   pyramidClient?: { getManifestForId: (id: number) => Promise<object> } | null;
 *   getViewportRegion?: (imgW: number, imgH: number) => { x: number, y: number, w: number, h: number };
 *   getZoom?: () => number;
 * }} opts
 */
export function createTauriParityLightbox(opts) {
  const {
    rootEl,
    canvas,
    histCanvas,
    invoke,
    getActiveCard,
    onRepaintRequest,
    pyramidClient = null,
    getViewportRegion,
    getZoom = null,
  } = opts;
  const panel = rootEl.querySelector('[data-tauri-m2-panel]');
  const presetSelect = rootEl.querySelector('[data-m2-preset]');
  const toggle16 = rootEl.querySelector('[data-toggle-16bit]');
  const exportBtn = rootEl.querySelector('[data-export-roi]');
  const m2Inputs = [...rootEl.querySelectorAll('[data-m2]')];

  const state = {
    preset: 'NONE',
    adjustments: clampAdjustments(),
    use16Bit: false,
    rgb16Lru: createLru(8),
    manifest16: null,
  };

  function createLru(max = 8) {
    const m = new Map();
    return {
      get(k) {
        if (!m.has(k)) return undefined;
        const v = m.get(k);
        m.delete(k);
        m.set(k, v);
        return v;
      },
      set(k, v) {
        if (m.has(k)) m.delete(k);
        m.set(k, v);
        while (m.size > max) {
          const old = m.keys().next().value;
          m.delete(old);
        }
      },
      clear() { m.clear(); },
      get size() { return m.size; },
    };
  }

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

  async function manifestHas16(id) {
    if (!pyramidClient) return false;
    try {
      const manifest = await pyramidClient.getManifestForId(id);
      return manifest.levels.some((l) => l.bitsPerSample === 16);
    } catch {
      return false;
    }
  }

  async function pick16Level(id) {
    if (!pyramidClient) return null;
    const manifest = await pyramidClient.getManifestForId(id);
    const pool16 = manifest.levels.filter((l) => l.bitsPerSample === 16);
    if (!pool16.length) return null;
    const z = (getZoom && typeof getZoom === 'function' ? getZoom() : 1) || 1;
    const screenLong = Math.max(window.innerWidth, window.innerHeight);
    const target = Math.ceil(screenLong * (window.devicePixelRatio || 1) * z);
    return chooseLevelForTarget(pool16, target);
  }

  function cropRgba16Packed(body, srcW, srcH, x, y, w, h) {
    const stride = srcW * 8;
    const rowBytes = w * 8;
    const out = new Uint8Array(w * h * 8);
    for (let row = 0; row < h; row++) {
      const srcOff = (y + row) * stride + x * 8;
      const dstOff = row * rowBytes;
      out.set(body.subarray(srcOff, srcOff + rowBytes), dstOff);
    }
    return out;
  }

  async function fetchRgb16(card) {
    const id = card?._tauriResult?.id;
    if (id == null) return null;

    if (card?._tauriResult?.pyramid_cached && pyramidClient) {
      const level = await pick16Level(id);
      if (!level) return null;
      const ch = level.contenthash;
      // Single LRU key scheme: `${id}:${suffix}` (here suffix = contenthash).
      const key = `${id}:${ch}`;
      const cached = state.rgb16Lru.get(key);
      if (cached) return cached;
      const buf = await invoke('decode_jxl_level_for_id', {
        id,
        contenthash: ch,
        format: 'rgba16',
      });
      const { w, h, body } = parsePackedResponse(buf);
      const rec = { key, id, w, h, body, level };
      state.rgb16Lru.set(key, rec);
      return rec;
    }

    // Same `${id}:${suffix}` key scheme; the full-res (non-pyramid) record uses
    // a fixed suffix so it never collides with the per-contenthash records.
    const key = `${id}:full`;
    const cached = state.rgb16Lru.get(key);
    if (cached) return cached;
    const buf = await invoke('get_rgb16_for_id', { id });
    // invoke() may return either an ArrayBuffer or a typed array; normalize to a
    // Uint8Array view first (respecting any byteOffset/byteLength), matching the
    // sibling parsePackedResponse normalizer.
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (u8.length < 4) {
      throw new Error(`fetchRgb16: buffer too short (${u8.length} bytes, need >= 4)`);
    }
    const w = u8[0] | (u8[1] << 8);
    const h = u8[2] | (u8[3] << 8);
    const body = u8.subarray(4);
    const rec = { key, id, w, h, body, level: null };
    state.rgb16Lru.set(key, rec);
    return rec;
  }

  async function paint16Bit(card) {
    const id = card?._tauriResult?.id;
    if (id == null) return false;
    state.adjustments = currentM2Adjustments();
    try {
      const cached = await fetchRgb16(card);
      if (!cached) return paintFromBaseline(card);
      const { w, h, body } = cached;
      canvas.width = w;
      canvas.height = h;
      renderRgba16AdjustedToCanvas(body, w, h, canvas, state.preset, state.adjustments);
      const ctx = canvas.getContext('2d');
      const img = ctx.getImageData(0, 0, w, h);
      paintHistogram(img.data, w, h);
      return true;
    } catch (e) {
      console.warn('16-bit HDR paint failed:', e);
      state.use16Bit = false;
      if (toggle16) toggle16.checked = false;
      return paintFromBaseline(card);
    }
  }

  /** Called after Rust/Channel/JXL paint establishes a clean 8-bit baseline. */
  function onBaseFramePainted(card, rgba, width, height) {
    storeBaseline(card, rgba, width, height);
    if (state.use16Bit && card?._sourceMode !== 'jxl' && canUseWebGL16()) {
      void paint16Bit(card);
      return;
    }
    paintFromBaseline(card);
  }

  function repaint() {
    const card = getActiveCard();
    if (!card) return;
    state.adjustments = currentM2Adjustments();
    if (state.use16Bit && card._sourceMode !== 'jxl' && canUseWebGL16()) {
      void paint16Bit(card);
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

  async function sync16ToggleVisibility(card) {
    if (!toggle16) return;
    const rawOnly = card && card._sourceMode !== 'jxl';
    let has16 = false;
    if (rawOnly) {
      if (card?._tauriResult?.pyramid_cached) {
        has16 = await manifestHas16(card._tauriResult.id);
      } else if (card?._tauriResult?.id != null) {
        has16 = true;
      }
    }
    const label = toggle16.closest('label');
    if (label) label.hidden = !rawOnly || !has16;
    if (!rawOnly || !has16) {
      if (state.use16Bit) {
        state.use16Bit = false;
        toggle16.checked = false;
        state.rgb16Lru.clear();
      }
    }
  }

  async function exportRoi() {
    const card = getActiveCard();
    const id = card?._tauriResult?.id;
    if (id == null) return;

    state.adjustments = currentM2Adjustments();
    const use16 = state.use16Bit && card._sourceMode !== 'jxl' && canUseWebGL16();

    if (use16) {
      try {
        const cached = await fetchRgb16(card);
        if (!cached) return;
        let { w, h, body, level } = cached;
        let region = { x: 0, y: 0, w, h };
        if (getViewportRegion) {
          region = getViewportRegion(w, h);
        }

        if (level && pyramidClient) {
          const buf = await invoke('decode_pyramid_roi_for_id', {
            id,
            contenthash: level.contenthash,
            x: region.x,
            y: region.y,
            w: region.w,
            h: region.h,
            format: 'rgba16',
          });
          const roi = parsePackedResponse(buf);
          w = roi.w;
          h = roi.h;
          body = roi.body;
        } else if (
          region.x !== 0 || region.y !== 0 || region.w !== w || region.h !== h
        ) {
          body = cropRgba16Packed(body, cached.w, cached.h, region.x, region.y, region.w, region.h);
          w = region.w;
          h = region.h;
        }

        const adjusted = adjustedRgba16ForExport(body, w, h, state.preset, state.adjustments);
        const enc = await invoke('encode_rgba16_jxl', {
          pixels: Array.from(adjusted),
          width: w,
          height: h,
          distance: 0.55,
        });
        const jxlBytes = enc instanceof Uint8Array ? enc : new Uint8Array(enc);
        const stem = (card._file?.name || String(id)).replace(/\.[^.]+$/, '');
        downloadBlob(new Blob([jxlBytes], { type: 'application/octet-stream' }), `${stem}-roi.jxl`);

        const preview = document.createElement('canvas');
        preview.width = w;
        preview.height = h;
        renderRgba16AdjustedToCanvas(body, w, h, preview, state.preset, state.adjustments);
        const png = await new Promise((resolve) => preview.toBlob(resolve, 'image/png'));
        if (png) downloadBlob(png, `${stem}-roi-preview.png`);
        return;
      } catch (e) {
        console.warn('16-bit ROI export failed:', e);
      }
    }

    const ctx = canvas.getContext('2d');
    if (!canvas.width || !canvas.height) return;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return;
    const stem = (card._file?.name || String(id)).replace(/\.[^.]+$/, '');
    downloadBlob(blob, `${stem}-roi.png`);
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
    state.rgb16Lru.clear();
    repaint();
  });

  exportBtn?.addEventListener('click', () => { void exportRoi(); });

  if (panel) panel.hidden = false;

  return {
    onBaseFramePainted,
    repaint,
    resetM2,
    sync16ToggleVisibility,
    exportRoi,
    clearCache() {
      state.rgb16Lru.clear();
      state.manifest16 = null;
    },
    get state() {
      return state;
    },
  };
}

export { M2_RANGES, M2_SLIDERS };