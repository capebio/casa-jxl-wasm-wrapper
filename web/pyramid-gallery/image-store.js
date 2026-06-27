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
const MANIFEST_CACHE_MAX = 64;

export function createImageStore({ cache, galleryBase }) {
  // Normalize galleryBase: accept a URL, an absolute URL string, or a relative path string.
  // `new URL(string)` throws on a relative input, so resolve relatives against the document
  // location (falling back to a neutral base in non-browser/test environments).
  const base = galleryBase instanceof URL
    ? galleryBase
    : (() => {
        const withSlash = galleryBase.endsWith('/') ? galleryBase : `${galleryBase}/`;
        const docBase = (typeof document !== 'undefined' && document.baseURI)
          || (typeof location !== 'undefined' && location.href)
          || undefined;
        return new URL(withSlash, docBase);
      })();
  // Bounded LRU (insertion-order Map) so a long gallery session can't grow the manifest
  // cache without limit, consistent with the size-bounded level-byte cache.
  const manifestCache = new Map();
  // In-flight fetch promises so concurrent first-callers don't double-fetch/double-validate.
  const manifestInflight = new Map();
  const levelInflight = new Map();

  /** Insert into the bounded manifest cache, evicting the least-recently-used entry. */
  function manifestCacheSet(imageId, manifest) {
    manifestCache.delete(imageId);
    manifestCache.set(imageId, manifest);
    if (manifestCache.size > MANIFEST_CACHE_MAX) {
      const oldest = manifestCache.keys().next().value;
      if (oldest !== undefined) manifestCache.delete(oldest);
    }
  }

  /**
   * @param {string} imageId
   * @returns {Promise<PyramidManifest>}
   */
  async function getManifest(imageId) {
    if (manifestCache.has(imageId)) {
      // LRU touch: move to most-recently-used position.
      const m = manifestCache.get(imageId);
      manifestCache.delete(imageId);
      manifestCache.set(imageId, m);
      return m;
    }
    // In-flight dedup: concurrent first-callers share one fetch+validate.
    const pending = manifestInflight.get(imageId);
    if (pending) return pending;
    const p = (async () => {
      const url = new URL(`images/${imageId}/manifest.json`, base).href;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`manifest ${imageId}: ${res.status}`);
      const manifest = await res.json();
      // G4-D: lightweight zero-dep structural validation before cache/return (no Zod to keep browser zero-dep)
      validateManifest(manifest);
      manifestCacheSet(imageId, manifest);
      return manifest;
    })();
    manifestInflight.set(imageId, p);
    try {
      return await p;
    } finally {
      manifestInflight.delete(imageId);
    }
  }

  /**
   * @param {string} contenthash
   * @returns {Promise<Uint8Array>}
   */
  async function getLevelBytes(contenthash) {
    const key = `level:${contenthash}`;
    const cached = await cache.get(key);
    if (cached) return new Uint8Array(cached);
    // In-flight dedup: concurrent callers share one fetch (and one cache.set) for the
    // same contenthash; each caller still gets its own Uint8Array wrapper over the buffer.
    let p = levelInflight.get(key);
    if (!p) {
      p = (async () => {
        const url = new URL(`levels/${contenthash}.jxl`, base).href;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`level ${contenthash}: ${res.status}`);
        const buf = await res.arrayBuffer();
        void cache.set(key, buf);
        return buf;
      })();
      levelInflight.set(key, p);
    }
    try {
      const buf = await p;
      return new Uint8Array(buf);
    } finally {
      levelInflight.delete(key);
    }
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
