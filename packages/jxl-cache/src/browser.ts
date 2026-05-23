import { LRUCache } from './lru.js';

export interface CacheOptions {
  memoryLimit: number;     // e.g. 128 * 1024 * 1024 (128 MiB)
  persistentLimit: number; // e.g. 1024 * 1024 * 1024 (1 GiB)
  persistent?: boolean;
  basePath?: string;       // for Node.js
}

interface PersistentEntry {
  name: string;
}

type WritableFileHandle = FileSystemFileHandle & {
  createWritable(): Promise<FileSystemWritableFileStream>;
};

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  keys(): AsyncIterable<string>;
};

const MANIFEST_NAME = '__jxl_cache_manifest.json';

function safeCacheName(key: string): string {
  return encodeURIComponent(key).replace(/[!'()*]/g, c =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export class JxlCacheBrowser {
  private readonly memoryCache: LRUCache<ArrayBuffer>;
  private readonly persistentTracker: LRUCache<PersistentEntry>;
  private readonly inflightGets = new Map<string, Promise<ArrayBuffer | undefined>>();
  private readonly inflightSets = new Map<string, Promise<void>>();

  private opfsRoot: FileSystemDirectoryHandle | null = null;
  private hitCount = 0;
  private missCount = 0;
  private manifestDirty = false;
  private manifestPendingWrite: Promise<void> | null = null;

  constructor(private readonly opts: CacheOptions) {
    this.memoryCache = new LRUCache(opts.memoryLimit);
    this.persistentTracker = new LRUCache(opts.persistentLimit);
  }

  async init(): Promise<void> {
    if (!this.opts.persistent || typeof navigator === 'undefined' || !navigator.storage) {
      return;
    }

    try {
      this.opfsRoot = await navigator.storage.getDirectory();
      await this.loadManifest();
    } catch (e) {
      console.warn('OPFS initialization failed', e);
      this.opfsRoot = null;
    }
  }

  async get(key: string): Promise<ArrayBuffer | undefined> {
    const mem = this.memoryCache.get(key);
    if (mem !== undefined) {
      this.hitCount++;
      return mem;
    }

    if (!this.opfsRoot) {
      this.missCount++;
      return undefined;
    }

    const existing = this.inflightGets.get(key);
    if (existing !== undefined) {
      const result = await existing;
      if (result !== undefined) this.hitCount++; else this.missCount++;
      return result;
    }

    const pending = this.getPersistent(key);
    this.inflightGets.set(key, pending);

    try {
      const result = await pending;
      if (result !== undefined) this.hitCount++; else this.missCount++;
      return result;
    } finally {
      this.inflightGets.delete(key);
    }
  }

  async set(key: string, buffer: ArrayBuffer): Promise<void> {
    const size = buffer.byteLength;
    this.memoryCache.set(key, buffer, size);

    if (!this.opfsRoot || size > this.opts.persistentLimit) return;

    const previous = this.inflightSets.get(key) ?? Promise.resolve();

    const pending = previous
      .catch(() => undefined)
      .then(() => this.setPersistent(key, buffer));

    this.inflightSets.set(key, pending);

    try {
      await pending;
    } finally {
      if (this.inflightSets.get(key) === pending) {
        this.inflightSets.delete(key);
      }
    }
  }

  async clear(): Promise<void> {
    this.memoryCache.clear();
    this.persistentTracker.clear();
    this.inflightGets.clear();
    this.inflightSets.clear();
    this.manifestDirty = false;

    if (!this.opfsRoot) return;

    try {
      for await (const name of (this.opfsRoot as IterableDirectoryHandle).keys()) {
        try {
          await this.opfsRoot.removeEntry(name);
        } catch {
          // Continue clearing remaining entries.
        }
      }
    } catch (e) {
      console.warn('[JxlCacheBrowser] Partial clear failure — OPFS directory iteration failed', e);
    }
  }

  stats() {
    const total = this.hitCount + this.missCount;
    return {
      memory: {
        count: this.memoryCache.count,
        size: this.memoryCache.size,
        limit: this.opts.memoryLimit,
      },
      persistent: {
        count: this.persistentTracker.count,
        size: this.persistentTracker.size,
        limit: this.opts.persistentLimit,
        enabled: this.opfsRoot !== null,
      },
      inflight: {
        gets: this.inflightGets.size,
        sets: this.inflightSets.size,
      },
      hitRate: total > 0 ? this.hitCount / total : null,
    };
  }

  private async getPersistent(key: string): Promise<ArrayBuffer | undefined> {
    if (!this.opfsRoot) return undefined;

    try {
      const entry = this.persistentTracker.get(key);
      const name = entry?.name ?? safeCacheName(key);

      const fileHandle = await this.opfsRoot.getFileHandle(name);
      const file = await fileHandle.getFile();

      if (file.size === 0) return undefined;

      const buffer = await file.arrayBuffer();

      this.memoryCache.set(key, buffer, buffer.byteLength);

      if (entry === undefined) {
        this.persistentTracker.set(key, { name }, buffer.byteLength);
      }

      return buffer;
    } catch (e) {
      if (e instanceof DOMException && e.name !== 'NotFoundError') {
        console.warn(`[JxlCacheBrowser] Failed to read persistent entry for "${key}"`, e);
      }
      return undefined;
    }
  }

  private async setPersistent(key: string, buffer: ArrayBuffer): Promise<void> {
    if (!this.opfsRoot) return;

    const size = buffer.byteLength;
    const name = safeCacheName(key);

    await this.evictPersistentUntilFits(size);

    try {
      await this.writePersistentFile(name, buffer);
      this.persistentTracker.set(key, { name }, size);
    } catch (e) {
      if (e instanceof Error && e.name === 'QuotaExceededError') {
        console.info(`[JxlCacheBrowser] Quota exceeded for "${key}", evicting aggressively`);
        await this.evictPersistentFraction(0.75);
        await this.writePersistentFile(name, buffer);
        this.persistentTracker.set(key, { name }, size);
      } else {
        console.error(`[JxlCacheBrowser] Failed to persist "${key}"`, e);
        throw e;
      }
    }

    this.scheduleManifestWrite();
  }

  private async writePersistentFile(name: string, buffer: ArrayBuffer): Promise<void> {
    if (!this.opfsRoot) return;

    const fileHandle = await this.opfsRoot.getFileHandle(name, { create: true });
    const writable = await (fileHandle as WritableFileHandle).createWritable();

    try {
      await writable.write(buffer);
    } finally {
      await writable.close();
    }
  }

  private async evictPersistentUntilFits(incomingSize: number): Promise<void> {
    while (
      this.persistentTracker.size + incomingSize > this.opts.persistentLimit &&
      this.persistentTracker.count > 0
    ) {
      const oldest = this.persistentTracker.getOldestKey();
      if (oldest === undefined) break;
      await this.removePersistentEntry(oldest);
    }
  }

  private async evictPersistentFraction(fraction: number): Promise<void> {
    const target = Math.max(1, Math.ceil(this.persistentTracker.count * fraction));

    for (let i = 0; i < target && this.persistentTracker.count > 0; i++) {
      const oldest = this.persistentTracker.getOldestKey();
      if (oldest === undefined) break;
      await this.removePersistentEntry(oldest);
    }
  }

  private async removePersistentEntry(key: string): Promise<void> {
    if (!this.opfsRoot) return;

    const entry = this.persistentTracker.get(key);
    const name = entry?.name ?? safeCacheName(key);

    try {
      await this.opfsRoot.removeEntry(name);
    } catch {
      // Stale tracker or already removed.
    } finally {
      this.persistentTracker.delete(key);
    }
  }

  private async loadManifest(): Promise<void> {
    if (!this.opfsRoot) return;

    try {
      const handle = await this.opfsRoot.getFileHandle(MANIFEST_NAME);
      const file = await handle.getFile();
      const manifest = JSON.parse(await file.text()) as {
        version: 1;
        entries: Array<{ key: string; name: string; size: number }>;
      };

      if (manifest.version !== 1) return;

      for (const entry of manifest.entries) {
        this.persistentTracker.set(entry.key, { name: entry.name }, entry.size);
      }
    } catch {
      // No manifest yet.
    }
  }

  private scheduleManifestWrite(): void {
    this.manifestDirty = true;

    if (this.manifestPendingWrite !== null) return;

    this.manifestPendingWrite = Promise.resolve()
      .then(() => this.drainManifest())
      .finally(() => { this.manifestPendingWrite = null; });
  }

  private async drainManifest(): Promise<void> {
    while (this.manifestDirty) {
      this.manifestDirty = false;
      await this.writeManifest();
    }
  }

  private async writeManifest(): Promise<void> {
    if (!this.opfsRoot) return;

    try {
      const entries: Array<{ key: string; name: string; size: number }> = [];

      for (const [key, entry, size] of this.persistentTracker.entriesOldestFirst()) {
        entries.push({ key, name: entry.name, size });
      }

      const manifest = { version: 1 as const, entries };
      const encoded = new TextEncoder().encode(JSON.stringify(manifest));

      await this.writePersistentFile(MANIFEST_NAME, encoded.buffer as ArrayBuffer);
    } catch (e) {
      console.warn('[JxlCacheBrowser] Failed to write manifest (non-fatal)', e);
    }
  }
}
