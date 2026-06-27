import type { JxlCacheBrowser } from "@casabio/jxl-cache";
import { type ProgressiveManifest, type TierName } from "./progressive-manifest.js";
export interface ProgressiveCacheOptions {
    /** Manifest TTL in ms. After expiry, getManifest returns null. Default 1 hour. */
    manifestTtlMs?: number;
}
/**
 * Progressive-specific cache layer wrapping JxlCacheBrowser.
 *
 * Key conventions:
 *   Manifests  — "jxl-progressive:manifest:{jxlUrl}"
 *   Byte ranges — "jxl-progressive:bytes:{jxlUrl}\0{tierName}"
 *
 * Manifests are stored as UTF-8 JSON (ArrayBuffer). Byte ranges are stored raw.
 */
export declare class ProgressiveCache {
    private readonly inner;
    private readonly manifestTtlMs;
    private readonly bitmapStore;
    constructor(inner: JxlCacheBrowser, opts?: ProgressiveCacheOptions);
    getManifest(jxlUrl: string): Promise<ProgressiveManifest | null>;
    setManifest(jxlUrl: string, manifest: ProgressiveManifest): Promise<void>;
    invalidateManifest(jxlUrl: string): Promise<void>;
    getByteRange(jxlUrl: string, tier: TierName): Promise<ArrayBuffer | null>;
    setByteRange(jxlUrl: string, tier: TierName, bytes: ArrayBuffer): Promise<void>;
    getBitmap(jxlUrl: string, tier: TierName): Promise<ImageBitmap | null>;
    setBitmap(jxlUrl: string, tier: TierName, bitmap: ImageBitmap): Promise<void>;
    /**
     * Evict decoded bitmaps for all URLs except those in `exceptJxlUrls`.
     * Call when memory pressure is detected.
     */
    evictBitmaps(exceptJxlUrls?: string[]): void;
    /** Invalidate all cached data for a URL (manifest + byte ranges + bitmaps). */
    invalidate(jxlUrl: string): Promise<void>;
}
//# sourceMappingURL=progressive-cache.d.ts.map