/**
 * ImageStore — centralized acquisition for pyramid gallery image handling.
 * Manifests + level bytes. Uses JxlCacheBrowser for level content (keyed by contenthash).
 * In-mem cache for manifests (per imageId). Thin layer; no decode, no scheduler policy.
 * S1 of image-store-image-handling-handoff.
 */

/** @typedef {import('../../packages/jxl-pyramid/dist/manifest.js').PyramidManifest} PyramidManifest */

/**
 * @param {{ cache: import('@casabio/jxl-cache').JxlCacheBrowser; galleryBase: URL | string }} opts
 */
export function createImageStore({ cache, galleryBase }) {
  const base = galleryBase instanceof URL ? galleryBase : new URL(galleryBase.endsWith('/') ? galleryBase : `${galleryBase}/`);
  const manifestCache = new Map();

  /**
   * @param {string} imageId
   * @returns {Promise<PyramidManifest>}
   */
  async function getManifest(imageId) {
    if (manifestCache.has(imageId)) return manifestCache.get(imageId);
    const url = new URL(`images/${imageId}/manifest.json`, base).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`manifest ${imageId}: ${res.status}`);
    const manifest = await res.json();
    manifestCache.set(imageId, manifest);
    return manifest;
  }

  /**
   * @param {string} contenthash
   * @returns {Promise<Uint8Array>}
   */
  async function getLevelBytes(contenthash) {
    const key = `level:${contenthash}`;
    const cached = await cache.get(key);
    if (cached) return new Uint8Array(cached);
    const url = new URL(`levels/${contenthash}.jxl`, base).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`level ${contenthash}: ${res.status}`);
    const buf = await res.arrayBuffer();
    void cache.set(key, buf);
    return new Uint8Array(buf);
  }

  function clearManifest(imageId) {
    manifestCache.delete(imageId);
  }

  function clearAll() {
    manifestCache.clear();
  }

  return {
    getManifest,
    getLevelBytes,
    clearManifest,
    clearAll,
    get base() { return base; },
  };
}
