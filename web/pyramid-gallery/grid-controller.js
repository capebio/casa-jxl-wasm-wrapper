import { chooseLevelForTarget, shouldUpgrade } from '../../packages/jxl-pyramid/dist/choose-level.js';
import { decodePyramidLevel } from './pyramid-decode.js';
import { createImageStore } from './image-store.js'; // S2; passed in or fallback

const PREFETCH_RING = 1;

/** @typedef {{ contenthash: string; w: number; h: number }} IndexL0 */
/** @typedef {{ imageId: string; aspect: number; l0: IndexL0 }} IndexEntry */

/**
 * @param {object} opts
 * @param {import('@casabio/jxl-session').JxlContext} opts.ctx
 * @param {import('@casabio/jxl-cache').JxlCacheBrowser} [opts.cache]
 * @param {URL} [opts.galleryBase]
 * @param {object} [opts.imageStore] // preferred; from createImageStore S1
 * @param {number} opts.tileSizePx
 * @param {number} [opts.devicePixelRatio]
 * @param {Map<string, IndexEntry>} [opts.indexByImageId]
 * @param {(cellEl: HTMLElement, imageId: string, level: object, decoded: object) => void} [opts.onTilePainted]
 */
export function createGridController({
  ctx,
  cache,
  galleryBase,
  imageStore,
  tileSizePx,
  devicePixelRatio,
  indexByImageId,
  onTilePainted,
}) {
  const store = imageStore || (cache && galleryBase ? createImageStore({ cache, galleryBase }) : null);
  const dpr = devicePixelRatio ?? 1;
  const paintedRank = new Map();
  const inflight = new Map();
  // S2: manifests map + fetchManifest/fetchLevelBytes replaced by imageStore (S1)

  function targetLongEdge() {
    return Math.ceil(tileSizePx * dpr);
  }

  async function decodeForLevel(imageId, level, priority, signal) {
    const jobKey = `${imageId}:${level.contenthash}`;
    if (inflight.has(jobKey)) return inflight.get(jobKey);

    const p = (async () => {
      if (!store) throw new Error('grid-controller requires imageStore (or cache+galleryBase)');
      const bytes = await store.getLevelBytes(level.contenthash);
      return decodePyramidLevel(ctx, bytes, {
        contenthash: level.contenthash,
        priority,
        signal,
      });
    })().finally(() => inflight.delete(jobKey));

    inflight.set(jobKey, p);
    return p;
  }

  function paintCanvas(cellEl, decoded) {
    const canvas = cellEl.querySelector('canvas') ?? document.createElement('canvas');
    if (!canvas.parentElement) cellEl.appendChild(canvas);
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const ctx2d = canvas.getContext('2d');
    const imgData = new ImageData(new Uint8ClampedArray(decoded.pixels), decoded.width, decoded.height);
    ctx2d.putImageData(imgData, 0, 0);
    const hadPaint = canvas.dataset.painted === '1';
    canvas.style.opacity = hadPaint ? '0' : '1';
    canvas.dataset.painted = '1';
    requestAnimationFrame(() => {
      canvas.style.transition = 'opacity 180ms ease';
      canvas.style.opacity = '1';
    });
    return canvas;
  }

  async function paintLevel(cellEl, imageId, level, { priority = 'visible', signal = null } = {}) {
    const rankKey = imageId;
    const current = paintedRank.get(rankKey) ?? null;
    if (!shouldUpgrade(current, level)) return false;

    const decoded = await decodeForLevel(imageId, level, priority, signal);
    if (signal?.aborted) return false;

    paintCanvas(cellEl, decoded);
    paintedRank.set(rankKey, level);
    onTilePainted?.(cellEl, imageId, level, decoded);
    return true;
  }

  async function paintCell(cellEl, imageId, { priority = 'visible', signal = null } = {}) {
    const entry = indexByImageId?.get(imageId);
    if (entry?.l0 && !paintedRank.has(imageId)) {
      await paintLevel(cellEl, imageId, entry.l0, { priority, signal });
      if (signal?.aborted) return;
    }

    if (!store) throw new Error('grid-controller requires imageStore (or cache+galleryBase)');
    const manifest = await store.getManifest(imageId);
    const target = targetLongEdge();
    const level = chooseLevelForTarget(manifest.levels, target);
    if (!level) return;

    await paintLevel(cellEl, imageId, level, { priority, signal });
  }

  function observeGrid(rootEl) {
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const cell = entry.target;
        const imageId = cell.dataset.imageId;
        if (!imageId) continue;
        const ac = new AbortController();
        cell._pyramidAbort?.abort();
        cell._pyramidAbort = ac;
        if (!entry.isIntersecting) {
          ac.abort();
          continue;
        }
        const ring = Number(cell.dataset.prefetchRing ?? '0');
        const priority = ring === 0 ? 'visible' : 'near';
        void paintCell(cell, imageId, { priority, signal: ac.signal }).catch((err) => {
          if (!ac.signal.aborted) console.warn('grid tile', imageId, err);
        });
      }
    }, { root: rootEl, rootMargin: `${tileSizePx * PREFETCH_RING}px` });

    for (const cell of rootEl.querySelectorAll('[data-image-id]')) io.observe(cell);
    return () => io.disconnect();
  }

  return {
    fetchManifest: (id) => store ? store.getManifest(id) : Promise.reject(new Error('no store')),
    paintCell,
    observeGrid,
    targetLongEdge,
  };
}