import { tileKey } from "./decode-core.js";
const levelIdBySource = new WeakMap();
const bufIdByBuffer = new WeakMap();
const bytesIdCache = new WeakMap();
let idCounter = 0;
// Defensive check: cache module assumes single-realm execution (main thread only).
// If this is imported in a worker or shared across realms, idCounter and WeakMaps will be unsynchronized.
// Use makeLevelCacheKey(contenthash) for multi-realm scenarios.
if (typeof WorkerGlobalScope !== "undefined") {
    console.warn("cache.ts loaded in worker context; level IDs may conflict. Use contenthash-based cache keys instead.");
}
/**
 * Key by underlying buffer + view window instead of view identity.
 * Ensures re-derived views or subarrays of the same buffer share the same ID.
 * Assumption: level bytes are immutable post-ingest.
 */
export function bytesId(view) {
    // Cache the full composite string to avoid template-literal construction on every call.
    let id = bytesIdCache.get(view);
    if (id != null)
        return id;
    let b = bufIdByBuffer.get(view.buffer);
    if (b == null) {
        b = `B${++idCounter}`;
        bufIdByBuffer.set(view.buffer, b);
    }
    id = `${b}:${view.byteOffset}:${view.byteLength}`;
    bytesIdCache.set(view, id);
    return id;
}
/**
 * Stable ID for a LevelSource or Uint8Array. Identity-based fallback for sources without
 * a contenthash — prefer `makeLevelCacheKey(contenthash)` when one is available.
 * `instanceof Uint8Array` is realm-local and will not match across worker boundaries.
 */
export function getLevelId(arg) {
    if (arg instanceof Uint8Array) {
        return bytesId(arg);
    }
    let id = levelIdBySource.get(arg);
    if (id == null) {
        id = arg.bytes instanceof Uint8Array ? bytesId(arg.bytes) : `L${++idCounter}`;
        levelIdBySource.set(arg, id);
    }
    return id;
}
class InMemoryPyramidCache {
    onEvictCb;
    map = new Map();
    bytes = 0;
    maxB;
    hitCount = 0;
    missCount = 0;
    evictionCount = 0;
    constructor(maxBytes, onEvictCb) {
        this.onEvictCb = onEvictCb;
        this.maxB = maxBytes;
    }
    get capacityBytes() { return this.maxB; }
    get bytesUsed() { return this.bytes; }
    get entryCount() { return this.map.size; }
    stats() {
        return {
            hits: this.hitCount,
            misses: this.missCount,
            evictions: this.evictionCount,
            bytesUsed: this.bytes,
            entryCount: this.map.size,
        };
    }
    get(key) {
        const e = this.map.get(key);
        if (!e) {
            this.missCount++;
            return undefined;
        }
        if (e.v.length !== e.len) {
            // Buffer detached (transferred via postMessage) — fix accounting, treat as miss.
            this.bytes -= e.len;
            this.map.delete(key);
            this.missCount++;
            return undefined;
        }
        this.map.delete(key);
        this.map.set(key, e);
        this.hitCount++;
        return e.v;
    }
    set(key, value) {
        if (value.length > this.maxB) {
            this.delete(key);
            return;
        } // C1: oversized → reject, don't wipe cache
        const old = this.map.get(key);
        if (old) {
            this.bytes -= old.len;
            this.map.delete(key);
        }
        const entry = { v: value, len: value.length };
        this.map.set(key, entry);
        this.bytes += entry.len;
        this._evictToFit();
    }
    has(key) {
        return this.map.has(key);
    }
    delete(key) {
        const e = this.map.get(key);
        if (e) {
            this.bytes -= e.len;
            this.map.delete(key);
            // Intentionally no onEvict: explicit deletes are not capacity evictions.
        }
    }
    clear() {
        this.map.clear();
        this.bytes = 0;
        // Intentionally no onEvict: clear is not a capacity eviction.
    }
    setMaxBytes(maxBytes) {
        this.maxB = Math.max(0, maxBytes);
        this._evictToFit();
    }
    touch(key) {
        const e = this.map.get(key);
        if (!e)
            return false;
        this.map.delete(key);
        this.map.set(key, e);
        return true;
    }
    _evictToFit() {
        while (this.bytes > this.maxB && this.map.size > 0) {
            const oldestKey = this.map.keys().next().value;
            const oldest = this.map.get(oldestKey);
            this.bytes -= oldest.len;
            this.map.delete(oldestKey);
            this.evictionCount++;
            this.onEvictCb?.(oldestKey, oldest.v);
        }
    }
}
export function createInMemoryPyramidCache(opts = {}) {
    const max = opts.maxBytes ?? 32 * 1024 * 1024;
    return new InMemoryPyramidCache(max, opts.onEvict);
}
/** Stable cache key from manifest contenthash. Preferred over identity-based getLevelId. */
export function makeLevelCacheKey(contenthash) {
    return `ch:${contenthash}`;
}
/** Canonical key for per-tile cache entries using stable TileId (no ad-hoc coord strings). */
export function makeTileCacheKey(sourceId, tile) {
    return `${sourceId}:${tileKey(tile)}`;
}
export { tileKey };
//# sourceMappingURL=cache.js.map