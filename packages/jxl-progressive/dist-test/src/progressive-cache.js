// packages/jxl-progressive/src/progressive-cache.ts
import { validateManifest, } from "./progressive-manifest.js";
const MANIFEST_KEY_PREFIX = "jxl-progressive:manifest:";
const BYTES_KEY_PREFIX = "jxl-progressive:bytes:";
// Bitmap cache is in-memory only (ImageBitmap is not serialisable to OPFS).
const BITMAP_KEY_PREFIX = "jxl-progressive:bitmap:";
const DEFAULT_MANIFEST_TTL_MS = 3_600_000; // 1 hour
/**
 * Progressive-specific cache layer wrapping JxlCacheBrowser.
 *
 * Key conventions:
 *   Manifests  — "jxl-progressive:manifest:{jxlUrl}"
 *   Byte ranges — "jxl-progressive:bytes:{jxlUrl}#{tierName}"
 *
 * Manifests are stored as UTF-8 JSON (ArrayBuffer). Byte ranges are stored raw.
 */
export class ProgressiveCache {
    inner;
    manifestTtlMs;
    bitmapStore = new Map();
    constructor(inner, opts = {}) {
        this.inner = inner;
        this.manifestTtlMs = opts.manifestTtlMs ?? DEFAULT_MANIFEST_TTL_MS;
    }
    // ---------------------------------------------------------------------------
    // Manifests
    // ---------------------------------------------------------------------------
    async getManifest(jxlUrl) {
        const key = MANIFEST_KEY_PREFIX + jxlUrl;
        const buf = await this.inner.get(key);
        if (buf === undefined || buf.byteLength === 0)
            return null;
        try {
            const text = new TextDecoder().decode(buf);
            const entry = JSON.parse(text);
            if (Date.now() - entry.storedAt > this.manifestTtlMs) {
                // Expired — remove and return null
                void this.inner.set(key, new ArrayBuffer(0)); // empty = sentinel for eviction; jxl-cache LRU will drop it
                return null;
            }
            return validateManifest(entry.manifest);
        }
        catch {
            return null;
        }
    }
    async setManifest(jxlUrl, manifest) {
        const entry = { manifest, storedAt: Date.now() };
        const text = JSON.stringify(entry);
        const nodeBuffer = Buffer.from(text);
        const buf = nodeBuffer.buffer.slice(nodeBuffer.byteOffset, nodeBuffer.byteOffset + nodeBuffer.byteLength);
        await this.inner.set(MANIFEST_KEY_PREFIX + jxlUrl, buf);
    }
    async invalidateManifest(jxlUrl) {
        // Store empty ArrayBuffer to evict — jxl-cache will overwrite the slot.
        // On next get() the empty buffer triggers the parse failure path → returns null.
        await this.inner.set(MANIFEST_KEY_PREFIX + jxlUrl, new ArrayBuffer(0));
    }
    // ---------------------------------------------------------------------------
    // Byte ranges
    // ---------------------------------------------------------------------------
    async getByteRange(jxlUrl, tier) {
        const buf = await this.inner.get(BYTES_KEY_PREFIX + jxlUrl + "#" + tier);
        if (buf === undefined || buf.byteLength === 0)
            return null;
        return buf;
    }
    async setByteRange(jxlUrl, tier, bytes) {
        await this.inner.set(BYTES_KEY_PREFIX + jxlUrl + "#" + tier, bytes);
    }
    // ---------------------------------------------------------------------------
    // Decoded bitmaps (in-memory only)
    // ---------------------------------------------------------------------------
    async getBitmap(jxlUrl, tier) {
        return this.bitmapStore.get(BITMAP_KEY_PREFIX + jxlUrl + "#" + tier) ?? null;
    }
    async setBitmap(jxlUrl, tier, bitmap) {
        this.bitmapStore.set(BITMAP_KEY_PREFIX + jxlUrl + "#" + tier, bitmap);
    }
    /**
     * Evict decoded bitmaps for all URLs except those in `exceptJxlUrls`.
     * Call when memory pressure is detected.
     */
    evictBitmaps(exceptJxlUrls = []) {
        const keep = new Set(exceptJxlUrls.map((u) => BITMAP_KEY_PREFIX + u));
        for (const key of this.bitmapStore.keys()) {
            // key format: "jxl-progressive:bitmap:{jxlUrl}#{tier}"
            const urlPart = key.slice(0, key.lastIndexOf("#"));
            if (!keep.has(urlPart)) {
                this.bitmapStore.delete(key);
            }
        }
    }
    // ---------------------------------------------------------------------------
    // Full invalidation
    // ---------------------------------------------------------------------------
    /** Invalidate all cached data for a URL (manifest + byte ranges + bitmaps). */
    async invalidate(jxlUrl) {
        await this.invalidateManifest(jxlUrl);
        for (const tier of ["dc", "preview", "full"]) {
            await this.inner.set(BYTES_KEY_PREFIX + jxlUrl + "#" + tier, new ArrayBuffer(0));
        }
        for (const key of [...this.bitmapStore.keys()]) {
            if (key.includes(jxlUrl))
                this.bitmapStore.delete(key);
        }
    }
}
//# sourceMappingURL=progressive-cache.js.map