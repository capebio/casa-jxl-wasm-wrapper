import type { LevelSource } from "./level-source.js";
import { tileKey, type TileId } from "./decode-core.js";
/**
 * By-reference in-memory L1 cache. Callers must `slice()` any WASM-heap view before
 * `set` — a `memory.grow` silently invalidates views into the old heap. Never transfer
 * a cached buffer's ArrayBuffer via postMessage. Cache IDs are realm-local: if tiles
 * decode in workers the cache must live on exactly one thread (main).
 */
export interface PyramidCache {
    get(key: string): Uint8Array | undefined;
    set(key: string, value: Uint8Array): void;
    has(key: string): boolean;
    delete(key: string): void;
    clear(): void;
    readonly capacityBytes?: number;
    readonly bytesUsed?: number;
    readonly entryCount?: number;
    stats?(): PyramidCacheStats;
    /** Resize capacity; evicts oldest entries immediately if over the new limit. */
    setMaxBytes?(maxBytes: number): void;
    /** Recency bump without a read. Returns false if the key is absent. */
    touch?(key: string): boolean;
}
export interface PyramidCacheStats {
    hits: number;
    misses: number;
    evictions: number;
    bytesUsed: number;
    entryCount: number;
}
/**
 * Key by underlying buffer + view window instead of view identity.
 * Ensures re-derived views or subarrays of the same buffer share the same ID.
 * Assumption: level bytes are immutable post-ingest.
 */
export declare function bytesId(view: Uint8Array): string;
/**
 * Stable ID for a LevelSource or Uint8Array. Identity-based fallback for sources without
 * a contenthash — prefer `makeLevelCacheKey(contenthash)` when one is available.
 * `instanceof Uint8Array` is realm-local and will not match across worker boundaries.
 */
export declare function getLevelId(arg: Uint8Array | LevelSource): string;
export declare function createInMemoryPyramidCache(opts?: {
    maxBytes?: number;
    /** Fired for capacity evictions only — NOT for delete() or clear(). Enables L2 write-back to jxl-cache/OPFS at the call site. */
    onEvict?: (key: string, value: Uint8Array) => void;
}): PyramidCache;
/** Stable cache key from manifest contenthash. Preferred over identity-based getLevelId. */
export declare function makeLevelCacheKey(contenthash: string): string;
/** Canonical key for per-tile cache entries using stable TileId (no ad-hoc coord strings). */
export declare function makeTileCacheKey(sourceId: string, tile: TileId): string;
export type { TileId };
export { tileKey };
//# sourceMappingURL=cache.d.ts.map