import { chooseLevelForTarget, shouldUpgrade } from '../../packages/jxl-pyramid/dist/choose-level.js';
import { decodePyramidLevel } from './pyramid-decode.js';

const PREFETCH_RING = 1;

/** @typedef {{ contenthash: string; w: number; h: number }} IndexL0 */
/** @typedef {{ imageId: string; aspect: number; l0: IndexL0 }} IndexEntry */

/**
 * @param {object} opts
 * @param {import('@casabio/jxl-session').JxlContext} opts.ctx
 * @param {import('@casabio/jxl-cache').JxlCacheBrowser} opts.cache
 * @param {URL} opts.galleryBase
 * @param {number} opts.tileSizePx
 * @param {number} [opts.devicePixelRatio]
 * @param {Map<string, IndexEntry>} [opts.indexByImageId]
 * @param {(cellEl: HTMLElement, imageId: string, level: object, decoded: object) => void} [opts.onTilePainted]
 */
export function createGridController({
  ctx,
  cache,
  galleryBase,
  tileSizePx,
  devicePixelRatio,
  indexByImageId,
  onTilePainted,
}) {
  const dpr = devicePixelRatio ?? 1;
  const manifests = new Map();
  const paintedRank = new Map();
  const inflight = new Map();

  async function fetchManifest(imageId) {
    if (manifests.has(imageId)) return manifests.get(imageId);
    const url = new URL(`images/${imageId}/manifest.json`, galleryBase).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`manifest ${imageId}: ${res.status}`);
    const manifest = await res.json();
    manifests.set(imageId, manifest);
    return manifest;
  }

  async function fetchLevelBytes(contenthash) {
    const key = `level:${contenthash}`;
    const cached = await cache.get(key);
    if (cached) return new Uint8Array(cached);
    const url = new URL(`levels/${contenthash}.jxl`, galleryBase).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`level ${contenthash}: ${res.status}`);
    const buf = await res.arrayBuffer();
    void cache.set(key, buf);
    return new Uint8Array(buf);
  }

  function targetLongEdge() {
    return Math.ceil(tileSizePx * dpr);
  }

  async function decodeForLevel(imageId, level, priority, signal) {
    const jobKey = `${imageId}:${level.contenthash}`;
    if (inflight.has(jobKey)) return inflight.get(jobKey);

    const p = (async () => {
      const bytes = await fetchLevelBytes(level.contenthash);
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

    const manifest = await fetchManifest(imageId);
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

  return { fetchManifest, paintCell, observeGrid, targetLongEdge };
}