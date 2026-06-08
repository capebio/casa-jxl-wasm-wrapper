import { chooseLevelForTarget, shouldUpgrade } from '../../packages/jxl-pyramid/dist/choose-level.js';
import { decodePyramidLevel, decodePyramidRegion } from '../pyramid-gallery/pyramid-decode.js';
import { createImageStore } from '../pyramid-gallery/image-store.js'; // type only; passed in
import {
  applyColorMatrixInPlace,
  applyToneMapInPlace,
  buildColorMatrix,
  clampAdjustments,
  computeHistogram,
} from './filter-engine.js';
import {
  adjustedRgba16ForExport,
  canUseWebGL16,
  renderRgba16AdjustedToCanvas,
} from './webgl-pipeline.js';

export function createPyramidLightbox({
  ctx,
  imageStore,
  cache,
  galleryBase,
  rootEl,
  onClose,
}) {
  // S3: imageStore provides getManifest/getLevelBytes (preferred); fallbacks for transitional callers
  const store = imageStore || (cache && galleryBase ? createImageStore({ cache, galleryBase }) : null);
  const state = {
    manifest: null,
    imageId: null,
    preset: 'NONE',
    adjustments: clampAdjustments(),
    zoom: 1,
    panX: 0,
    panY: 0,
    paintedLevel: null,
    use16Bit: false,
    screenCache: new Map(),
  };

  const canvas = rootEl.querySelector('[data-lightbox-canvas]');
  const zoomEl = rootEl.querySelector('[data-zoom-pct]');
  const histCanvas = rootEl.querySelector('[data-histogram]');
  const toggle16 = rootEl.querySelector('[data-toggle-16bit]');
  const exportBtn = rootEl.querySelector('[data-export-roi]');

  // S3: fetchLevelBytes + loadManifest replaced by imageStore (see S1 image-store.js)

  function levelPool() {
    if (!state.manifest) return [];
    if (state.use16Bit) {
      const pool16 = state.manifest.levels.filter((l) => l.bitsPerSample === 16);
      if (pool16.length) return pool16;
    }
    return state.manifest.levels;
  }

  function pickLevel(zoomPct) {
    const screenLong = Math.max(window.innerWidth, window.innerHeight);
    const target = Math.ceil(screenLong * (window.devicePixelRatio || 1) * (zoomPct / 100));
    return chooseLevelForTarget(levelPool(), target);
  }

  function wants16(level) {
    return state.use16Bit && level.bitsPerSample === 16 && canUseWebGL16();
  }

  async function decodeLevel(level, region) {
    const use16 = wants16(level);
    const cacheKey = `${level.contenthash}:${use16 ? '16' : '8'}:${region ? JSON.stringify(region) : 'full'}`;
    if (state.screenCache.has(cacheKey)) return state.screenCache.get(cacheKey);

    const bytes = await store.getLevelBytes(level.contenthash);
    const decoded = await decodePyramidLevel(ctx, bytes, {
      contenthash: level.contenthash,
      format: use16 ? 'rgba16' : 'rgba8',
      priority: 'visible',
      tiled: level.tiled === true,
      region,
    });

    let result;
    if (use16) {
      result = { ...decoded, pixels: new Uint8Array(decoded.pixels), is16: true };
    } else {
      const copy = new Uint8Array(decoded.pixels);
      applyColorMatrixInPlace(copy, decoded.width, decoded.height, buildColorMatrix(state.preset, state.adjustments));
      applyToneMapInPlace(copy, decoded.width, decoded.height, state.adjustments.shadows, state.adjustments.highlights);
      result = { ...decoded, pixels: copy, is16: false };
    }

    if (state.screenCache.size > 8) state.screenCache.clear();
    state.screenCache.set(cacheKey, result);
    return result;
  }

  function paintHistogramFromRgba8(pixels, width, height) {
    if (!histCanvas) return;
    const hctx = histCanvas.getContext('2d');
    const hist = computeHistogram(pixels, width, height);
    hctx.clearRect(0, 0, histCanvas.width, histCanvas.height);
    const bins = hist.bins;
    for (let i = 0; i < bins; i++) {
      const max = Math.max(...hist.y);
      const h = (hist.y[i] / max) * histCanvas.height;
      hctx.fillStyle = '#ccc';
      hctx.fillRect((i / bins) * histCanvas.width, histCanvas.height - h, histCanvas.width / bins, h);
    }
  }

  function paint(decoded, { crossfade = false } = {}) {
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    if (decoded.is16) {
      renderRgba16AdjustedToCanvas(
        decoded.pixels, decoded.width, decoded.height, canvas, state.preset, state.adjustments,
      );
      const ctx2d = canvas.getContext('2d');
      const img = ctx2d.getImageData(0, 0, decoded.width, decoded.height);
      paintHistogramFromRgba8(img.data, decoded.width, decoded.height);
    } else {
      const ctx2d = canvas.getContext('2d');
      ctx2d.putImageData(new ImageData(new Uint8ClampedArray(decoded.pixels), decoded.width, decoded.height), 0, 0);
      paintHistogramFromRgba8(decoded.pixels, decoded.width, decoded.height);
    }
    if (crossfade) {
      canvas.style.opacity = '0';
      requestAnimationFrame(() => {
        canvas.style.transition = 'opacity 220ms ease';
        canvas.style.opacity = '1';
      });
    }
    canvas.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  }

  function viewportRegion(level) {
    const zoomPct = Math.round(state.zoom * 100);
    if (!level.tiled || zoomPct < 95) return undefined;
    const vw = Math.floor(canvas.clientWidth / state.zoom);
    const vh = Math.floor(canvas.clientHeight / state.zoom);
    return {
      x: Math.max(0, Math.floor(-state.panX / state.zoom)),
      y: Math.max(0, Math.floor(-state.panY / state.zoom)),
      w: Math.min(level.w, vw),
      h: Math.min(level.h, vh),
    };
  }

  async function refreshView({ forceLevel = null } = {}) {
    if (!state.manifest) return;
    const zoomPct = Math.round(state.zoom * 100);
    if (zoomEl) zoomEl.textContent = `${zoomPct}%`;
    const level = forceLevel ?? pickLevel(zoomPct);
    if (!level) return;

    const region = viewportRegion(level);
    const tiledRoi = level.tiled && zoomPct >= 95;
    if (!tiledRoi && state.paintedLevel && !shouldUpgrade(state.paintedLevel, level)) {
      return;
    }

    const decoded = await decodeLevel(level, region);
    const upgrading = state.paintedLevel && shouldUpgrade(state.paintedLevel, level);
    state.paintedLevel = level;
    paint(decoded, { crossfade: upgrading });
  }

  async function fetchRoiDecoded(level, region, use16) {
    const bytes = await store.getLevelBytes(level.contenthash);
    if (level.tiled && region) {
      return decodePyramidLevel(ctx, bytes, {
        contenthash: level.contenthash,
        format: use16 ? 'rgba16' : 'rgba8',
        priority: 'visible',
        tiled: true,
        region,
      });
    }
    return decodePyramidRegion(bytes, {
      format: use16 ? 'rgba16' : 'rgba8',
      region,
    });
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function exportRoi() {
    if (!state.manifest) return;
    const zoomPct = Math.round(state.zoom * 100);
    const level = pickLevel(zoomPct);
    if (!level) return;
    const region = viewportRegion(level) ?? { x: 0, y: 0, w: level.w, h: level.h };
    const use16 = wants16(level);

    const decoded = await fetchRoiDecoded(level, region, use16);

    if (use16) {
      const { encodeRgba16 } = await import('@casabio/jxl-wasm');
      const rgba16 = adjustedRgba16ForExport(
        decoded.pixels, decoded.width, decoded.height, state.preset, state.adjustments,
      );
      const enc = await encodeRgba16(rgba16, decoded.width, decoded.height, {
        distance: 0.55,
        effort: 3,
        hasAlpha: false,
      });
      downloadBlob(new Blob([enc.data], { type: 'application/octet-stream' }), `${state.imageId}-roi.jxl`);

      const preview = document.createElement('canvas');
      preview.width = decoded.width;
      preview.height = decoded.height;
      renderRgba16AdjustedToCanvas(
        decoded.pixels, decoded.width, decoded.height, preview, state.preset, state.adjustments,
      );
      const png = await new Promise((resolve) => preview.toBlob(resolve, 'image/png'));
      if (png) downloadBlob(png, `${state.imageId}-roi-preview.png`);
      return;
    }

    const copy = new Uint8Array(decoded.pixels);
    applyColorMatrixInPlace(copy, decoded.width, decoded.height, buildColorMatrix(state.preset, state.adjustments));
    applyToneMapInPlace(copy, decoded.width, decoded.height, state.adjustments.shadows, state.adjustments.highlights);

    const off = document.createElement('canvas');
    off.width = decoded.width;
    off.height = decoded.height;
    off.getContext('2d').putImageData(
      new ImageData(new Uint8ClampedArray(copy), decoded.width, decoded.height), 0, 0,
    );
    const blob = await new Promise((resolve) => off.toBlob(resolve, 'image/png'));
    if (blob) downloadBlob(blob, `${state.imageId}-roi.png`);
  }

  function setPreset(name) {
    state.preset = name;
    state.screenCache.clear();
    void refreshView();
  }

  function setAdjustment(key, value) {
    state.adjustments = clampAdjustments({ ...state.adjustments, [key]: value });
    state.screenCache.clear();
    void refreshView();
  }

  async function open(imageId, seedLevel = null) {
    rootEl.hidden = false;
    if (!store) throw new Error('pyramid-lightbox requires imageStore (or cache+galleryBase)');
    state.manifest = await store.getManifest(imageId);
    state.imageId = imageId;
    state.use16Bit = false;
    if (toggle16) {
      const has16 = state.manifest.levels.some((l) => l.bitsPerSample === 16);
      toggle16.hidden = state.manifest.master.format === 'jpg' || !has16;
      toggle16.checked = false;
    }
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    state.paintedLevel = null;
    state.screenCache.clear();
    if (seedLevel) {
      const bytes = await store.getLevelBytes(seedLevel.contenthash);
      const decoded = await decodePyramidLevel(ctx, bytes, { contenthash: seedLevel.contenthash, priority: 'visible' });
      state.paintedLevel = seedLevel;
      paint({ ...decoded, pixels: new Uint8Array(decoded.pixels), is16: false });
    }
    await refreshView();
  }

  function close() {
    rootEl.hidden = true;
    onClose?.();
  }

  rootEl.querySelector('[data-lightbox-close]')?.addEventListener('click', close);
  rootEl.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    state.zoom = Math.min(8, Math.max(0.25, state.zoom * (ev.deltaY < 0 ? 1.1 : 0.9)));
    void refreshView();
  }, { passive: false });

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas?.addEventListener('pointerdown', (ev) => { dragging = true; lastX = ev.clientX; lastY = ev.clientY; });
  window.addEventListener('pointerup', () => { dragging = false; });
  window.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    state.panX += ev.clientX - lastX;
    state.panY += ev.clientY - lastY;
    lastX = ev.clientX;
    lastY = ev.clientY;
    canvas.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  });

  toggle16?.addEventListener('change', () => {
    state.use16Bit = toggle16.checked && canUseWebGL16();
    state.paintedLevel = null;
    state.screenCache.clear();
    void refreshView();
  });

  exportBtn?.addEventListener('click', () => { void exportRoi(); });

  return { open, close, setPreset, setAdjustment, refreshView, exportRoi, state };
}