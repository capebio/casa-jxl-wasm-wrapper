// packages/jxl-progressive/src/progressive-cache.ts

import type { JxlCacheBrowser } from "@casabio/jxl-cache";
import {
  validateManifest,
  type ProgressiveManifest,
  type TierName,
} from "./progressive-manifest.js";

export interface ProgressiveCacheOptions {
  /** Manifest TTL in ms. After expiry, getManifest returns null. Default 1 hour. */
  manifestTtlMs?: number;
}

interface ManifestEntry {
  manifest: ProgressiveManifest;
  storedAt: number;
}

const MANIFEST_KEY_PREFIX = "jxl-progressive:manifest:";
const BYTES_KEY_PREFIX = "jxl-progressive:bytes:";
// Bitmap cache is in-memory only (ImageBitmap is not serialisable to OPFS).
const BITMAP_KEY_PREFIX = "jxl-progressive:bitmap:";

// Null byte is never valid in a URL or tier name, making it a safe separator.
const TIER_SEP = "\0";

const _textDecoder = new TextDecoder();

const DEFAULT_MANIFEST_TTL_MS = 3_600_000; // 1 hour

/**
 * Progressive-specific cache layer wrapping JxlCacheBrowser.
 *
 * Key conventions:
 *   Manifests  — "jxl-progressive:manifest:{jxlUrl}"
 *   Byte ranges — "jxl-progressive:bytes:{jxlUrl}\0{tierName}"
 *
 * Manifests are stored as UTF-8 JSON (ArrayBuffer). Byte ranges are stored raw.
 */
export class ProgressiveCache {
  private readonly inner: JxlCacheBrowser;
  private readonly manifestTtlMs: number;
  private readonly bitmapStore = new Map<string, ImageBitmap>();

  constructor(
    inner: JxlCacheBrowser,
    opts: ProgressiveCacheOptions = {},
  ) {
    this.inner = inner;
    this.manifestTtlMs = opts.manifestTtlMs ?? DEFAULT_MANIFEST_TTL_MS;
  }

  // ---------------------------------------------------------------------------
  // Manifests
  // ---------------------------------------------------------------------------

  async getManifest(jxlUrl: string): Promise<ProgressiveManifest | null> {
    const key = MANIFEST_KEY_PREFIX + jxlUrl;
    const buf = await this.inner.get(key);
    if (buf === undefined || buf.byteLength === 0) return null;
    try {
      const text = _textDecoder.decode(buf);
      const entry = JSON.parse(text) as ManifestEntry;
      if (Date.now() - entry.storedAt > this.manifestTtlMs) {
        // Expired — delete the entry so subsequent reads miss cleanly.
        await this.inner.delete(key);
        return null;
      }
      return validateManifest(entry.manifest);
    } catch {
      // Corrupt entry — evict it so the cache self-heals on next setManifest.
      await this.inner.delete(key).catch(() => undefined);
      return null;
    }
  }

  async setManifest(
    jxlUrl: string,
    manifest: ProgressiveManifest,
  ): Promise<void> {
    const entry: ManifestEntry = { manifest, storedAt: Date.now() };
    const text = JSON.stringify(entry);
    // Universal (browser + node): TextEncoder always present. Avoids Buffer (node-only)
    // which would crash pure browser usage of progressive cache + jxl-cache.
    const buf = new TextEncoder().encode(text).buffer;
    await this.inner.set(MANIFEST_KEY_PREFIX + jxlUrl, buf);
  }

  async invalidateManifest(jxlUrl: string): Promise<void> {
    await this.inner.delete(MANIFEST_KEY_PREFIX + jxlUrl);
  }

  // ---------------------------------------------------------------------------
  // Byte ranges
  // ---------------------------------------------------------------------------

  async getByteRange(
    jxlUrl: string,
    tier: TierName,
  ): Promise<ArrayBuffer | null> {
    const buf = await this.inner.get(BYTES_KEY_PREFIX + jxlUrl + TIER_SEP + tier);
    if (buf === undefined || buf.byteLength === 0) return null;
    return buf;
  }

  async setByteRange(
    jxlUrl: string,
    tier: TierName,
    bytes: ArrayBuffer,
  ): Promise<void> {
    await this.inner.set(BYTES_KEY_PREFIX + jxlUrl + TIER_SEP + tier, bytes);
  }

  // ---------------------------------------------------------------------------
  // Decoded bitmaps (in-memory only)
  // ---------------------------------------------------------------------------

  async getBitmap(
    jxlUrl: string,
    tier: TierName,
  ): Promise<ImageBitmap | null> {
    return this.bitmapStore.get(BITMAP_KEY_PREFIX + jxlUrl + TIER_SEP + tier) ?? null;
  }

  async setBitmap(
    jxlUrl: string,
    tier: TierName,
    bitmap: ImageBitmap,
  ): Promise<void> {
    this.bitmapStore.set(BITMAP_KEY_PREFIX + jxlUrl + TIER_SEP + tier, bitmap);
  }

  /**
   * Evict decoded bitmaps for all URLs except those in `exceptJxlUrls`.
   * Call when memory pressure is detected.
   */
  evictBitmaps(exceptJxlUrls: string[] = []): void {
    const keep = new Set(
      exceptJxlUrls.map((u) => BITMAP_KEY_PREFIX + u + TIER_SEP),
    );
    for (const key of this.bitmapStore.keys()) {
      // key format: "jxl-progressive:bitmap:{jxlUrl}\0{tier}"
      const sepIdx = key.indexOf(TIER_SEP);
      const urlPart = sepIdx === -1 ? key : key.slice(0, sepIdx + 1);
      if (!keep.has(urlPart)) {
        this.bitmapStore.delete(key);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Full invalidation
  // ---------------------------------------------------------------------------

  /** Invalidate all cached data for a URL (manifest + byte ranges + bitmaps). */
  async invalidate(jxlUrl: string): Promise<void> {
    await this.invalidateManifest(jxlUrl);
    for (const tier of ["dc", "preview", "full"] as TierName[]) {
      await this.inner.delete(BYTES_KEY_PREFIX + jxlUrl + TIER_SEP + tier);
    }
    const bitmapPrefix = BITMAP_KEY_PREFIX + jxlUrl + TIER_SEP;
    for (const key of this.bitmapStore.keys()) {
      if (key.startsWith(bitmapPrefix)) this.bitmapStore.delete(key);
    }
  }
}
