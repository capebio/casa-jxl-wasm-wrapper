/**
 * PR-8b: Tauri WebView pyramid gallery client — manifest + level bytes via invoke,
 * level picker aligned with @casabio/jxl-pyramid chooseLevelForTarget.
 * (M2: tauri-parity-lightbox.js owns the zoom-aware 16bit ladder + contenthash LRU for lightbox decodes;
 *  this client keeps thumb path + upgradeVisibleCards.)
 */

import { chooseLevelForTarget, shouldUpgrade, levelRank } from '../packages/jxl-pyramid/dist/choose-level.js';

const THUMB_LONG_EDGE = 360;

/**
 * @param {object} opts
 * @param {(cmd: string, args?: object) => Promise<unknown>} opts.invoke
 * @param {number} [opts.devicePixelRatio]
 */
export function createTauriPyramidClient({ invoke, devicePixelRatio = 1 }) {
  const manifestById = new Map();
  const levelBytesCache = new Map();
  const paintedRank = new Map();

  function targetLongEdge() {
    return Math.ceil(THUMB_LONG_EDGE * devicePixelRatio);
  }

  function parseRgbResponse(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    // Wire format is fixed: little-endian u16 width @0, u16 height @2, body @4.
    // u16 caps each dimension at 65535; surface an explicit error instead of
    // silently wrapping if a level ever exceeds that. (If the protocol grows a
    // wider field, update both this reader and the Rust writer together.)
    if (u8.length < 4) {
      throw new Error(`parseRgbResponse: buffer too short (${u8.length} bytes, need >= 4)`);
    }
    const w = u8[0] | (u8[1] << 8);
    const h = u8[2] | (u8[3] << 8);
    const rgb = u8.subarray(4);
    return { w, h, rgb };
  }

  function rgbToRgbaArr(rgb) {
    const n = rgb.length / 3;
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      out[i * 4] = rgb[j];
      out[i * 4 + 1] = rgb[j + 1];
      out[i * 4 + 2] = rgb[j + 2];
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  async function getManifestForId(id) {
    if (manifestById.has(id)) return manifestById.get(id);
    const manifest = await invoke('get_pyramid_manifest_for_id', { id });
    manifestById.set(id, manifest);
    return manifest;
  }

  async function getLevelBytes(contenthash) {
    if (levelBytesCache.has(contenthash)) return levelBytesCache.get(contenthash);
    const buf = await invoke('get_pyramid_level_bytes', { contenthash });
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    levelBytesCache.set(contenthash, bytes);
    return bytes;
  }

  async function decodeLevel(id, contenthash, format = 'rgba8') {
    const buf = await invoke('decode_jxl_level_for_id', {
      id,
      contenthash,
      // Explicit mapping so the wire value does not silently depend on the Rust
      // default if that default ever changes.
      format: format === 'rgba16' ? 'rgba16' : 'rgba8',
    });
    return parseRgbResponse(buf);
  }

  async function paintLevelToCanvas(card, id, level) {
    const { w, h, rgb } = await decodeLevel(id, level.contenthash);
    const long = Math.max(w, h);
    const targetW = long > THUMB_LONG_EDGE ? Math.max(1, Math.round(w * THUMB_LONG_EDGE / long)) : w;
    const targetH = long > THUMB_LONG_EDGE ? Math.max(1, Math.round(h * THUMB_LONG_EDGE / long)) : h;
    const bmp = await createImageBitmap(
      new ImageData(rgbToRgbaArr(rgb), w, h),
      { resizeWidth: targetW, resizeHeight: targetH, resizeQuality: 'high' },
    );
    const canvas = card.querySelector('canvas');
    if (!canvas) return false;
    canvas.width = targetW;
    canvas.height = targetH;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    if (card._jxlThumbBmp && card._jxlThumbBmp !== bmp) {
      try { card._jxlThumbBmp.close(); } catch {}
    }
    card._jxlThumbBmp = bmp;
    card._jxlThumbW = targetW;
    card._jxlThumbH = targetH;
    card.classList.remove('embedded-thumb');
    return true;
  }

  /**
   * L0 one-shot seed, then monotonic upgrade via chooseLevelForTarget.
   * @param {HTMLElement} card
   * @param {{ id: number, pyramid_l0?: { contenthash: string, w: number, h: number }, pyramid_cached?: boolean }} result
   */
  async function paintThumb(card, result) {
    if (!result?.pyramid_cached || !result?.pyramid_l0 || result.id == null) return false;
    const id = result.id;
    const rankKey = String(id);
    const l0 = result.pyramid_l0;

    const current = paintedRank.get(rankKey) ?? null;
    if (current === null || shouldUpgrade(current, l0)) {
      const ok = await paintLevelToCanvas(card, id, l0);
      if (ok) paintedRank.set(rankKey, l0);
    }

    try {
      const manifest = await getManifestForId(id);
      const pick = chooseLevelForTarget(manifest.levels, targetLongEdge());
      if (!pick) return true;
      const painted = paintedRank.get(rankKey) ?? null;
      if (!shouldUpgrade(painted, pick)) return true;
      const ok = await paintLevelToCanvas(card, id, pick);
      if (ok) paintedRank.set(rankKey, pick);
    } catch (err) {
      console.warn('[tauri-pyramid] level upgrade failed', err);
    }
    return true;
  }

  /** Re-upgrade visible cards when DPR changes (viewport upgrade). */
  async function upgradeVisibleCards(cards) {
    const target = targetLongEdge();
    for (const card of cards) {
      const result = card?._tauriResult;
      if (!result?.pyramid_cached || result.id == null) continue;
      try {
        const manifest = await getManifestForId(result.id);
        const pick = chooseLevelForTarget(manifest.levels, target);
        if (!pick) continue;
        const rankKey = String(result.id);
        const painted = paintedRank.get(rankKey) ?? null;
        if (!shouldUpgrade(painted, pick)) continue;
        const ok = await paintLevelToCanvas(card, result.id, pick);
        if (ok) paintedRank.set(rankKey, pick);
      } catch (err) {
        console.warn('[tauri-pyramid] viewport upgrade failed', err);
      }
    }
  }

  function clearCache() {
    manifestById.clear();
    levelBytesCache.clear();
    paintedRank.clear();
  }

  return {
    targetLongEdge,
    getManifestForId,
    getLevelBytes,
    decodeLevel,
    paintThumb,
    upgradeVisibleCards,
    clearCache,
    levelRank,
  };
}