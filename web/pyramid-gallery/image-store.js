/**
 * ImageStore — centralized acquisition for pyramid gallery image handling.
 * Manifests + level bytes. Uses JxlCacheBrowser for level content (keyed by contenthash).
 * In-mem cache for manifests (per imageId). Thin layer; no decode, no scheduler policy.
 * S1 of image-store-image-handling-handoff.
 */

/** @typedef {import('../../packages/jxl-pyramid/dist/manifest.js').PyramidManifest} PyramidManifest */

/**
 * Lightweight zero-dep manifest validator (G4-D). Throws on structural violation.
 * @param {any} m
 * @returns {asserts m is PyramidManifest}
 */
function validateManifest(m) {
  if (!m || typeof m !== "object") throw new Error("manifest must be object");
  if (m.schema !== 1) throw new Error("manifest schema must be 1");
  if (typeof m.imageId !== "string" || m.imageId.length === 0) throw new Error("manifest imageId required");
  if (typeof m.width !== "number" || typeof m.height !== "number" || m.width <= 0 || m.height <= 0) {
    throw new Error("manifest width/height must be positive numbers");
  }
  if (!Array.isArray(m.levels)) throw new Error("manifest levels must be array");
  for (const lvl of m.levels) {
    if (!lvl || typeof lvl !== "object") throw new Error("level must be object");
    if (typeof lvl.contenthash !== "string" || lvl.contenthash.length === 0) throw new Error("level contenthash required");
    if (typeof lvl.w !== "number" || typeof lvl.h !== "number" || lvl.w <= 0 || lvl.h <= 0) {
      throw new Error("level w/h must be positive");
    }
    if (typeof lvl.bytes !== "number" || lvl.bytes < 0) throw new Error("level bytes invalid");
    if (lvl.bitsPerSample !== 8 && lvl.bitsPerSample !== 16) throw new Error("level bitsPerSample must be 8 or 16");
    if (typeof lvl.tiled !== "boolean") throw new Error("level tiled must be boolean");
  }
}

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
    // G4-D: lightweight zero-dep structural validation before cache/return (no Zod to keep browser zero-dep)
    validateManifest(manifest);
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
