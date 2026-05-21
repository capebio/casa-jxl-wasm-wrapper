import { LRUCache } from './lru.js';

export interface CacheOptions {
  memoryLimit: number;     // e.g. 128 * 1024 * 1024 (128 MiB)
  persistentLimit: number; // e.g. 1024 * 1024 * 1024 (1 GiB)
  persistent?: boolean;
  basePath?: string;       // for Node.js
}

export class JxlCacheBrowser {
  private memoryCache: LRUCache<ArrayBuffer>;
  private persistentTracker: LRUCache<null>; // Only tracks keys and sizes
  private opfsRoot: FileSystemDirectoryHandle | null = null;

  constructor(private opts: CacheOptions) {
    this.memoryCache = new LRUCache(opts.memoryLimit);
    this.persistentTracker = new LRUCache(opts.persistentLimit);
  }

  async init(): Promise<void> {
    if (this.opts.persistent && typeof navigator !== 'undefined' && navigator.storage) {
      try {
        this.opfsRoot = await navigator.storage.getDirectory();
        // Ideally we'd scan OPFS to populate persistentTracker here.
      } catch (e) {
        console.warn('OPFS initialization failed', e);
      }
    }
  }

  async get(key: string): Promise<ArrayBuffer | undefined> {
    const mem = this.memoryCache.get(key);
    if (mem) return mem;

    if (this.opfsRoot) {
      try {
        const fileHandle = await this.opfsRoot.getFileHandle(key);
        const file = await fileHandle.getFile();
        const buffer = await file.arrayBuffer();
        this.memoryCache.set(key, buffer, buffer.byteLength);
        this.persistentTracker.get(key); // update LRU order
        return buffer;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  async set(key: string, buffer: ArrayBuffer): Promise<void> {
    const size = buffer.byteLength;
    this.memoryCache.set(key, buffer, size);

    if (this.opfsRoot) {
      try {
        // Handle persistent eviction before writing
        while (this.persistentTracker.size + size > this.opts.persistentLimit && this.persistentTracker.count > 0) {
          const oldest = this.persistentTracker.getOldestKey();
          if (oldest) {
            try {
              await this.opfsRoot.removeEntry(oldest);
              this.persistentTracker.delete(oldest);
            } catch {
              // If remove fails, still delete from tracker to avoid infinite loop
              this.persistentTracker.delete(oldest);
            }
          }
        }
        
        const fileHandle = await this.opfsRoot.getFileHandle(key, { create: true });
        // @ts-ignore
        const writable = await fileHandle.createWritable();
        await writable.write(buffer);
        await writable.close();
        this.persistentTracker.set(key, null, size);
      } catch (e) {
        if (e instanceof Error && e.name === 'QuotaExceededError') {
          // Emergency clear of half the oldest items
          for (let i = 0; i < Math.max(1, this.persistentTracker.count / 2); i++) {
            const oldest = this.persistentTracker.getOldestKey();
            if (oldest) {
              try {
                await this.opfsRoot.removeEntry(oldest);
                this.persistentTracker.delete(oldest);
              } catch {
                this.persistentTracker.delete(oldest);
              }
            }
          }
        }
      }
    }
  }

  async clear(): Promise<void> {
    this.memoryCache.clear();
    this.persistentTracker.clear();
    if (this.opfsRoot) {
      // @ts-ignore
      for await (const name of this.opfsRoot.keys()) {
        await this.opfsRoot.removeEntry(name);
      }
    }
  }

  stats() {
    return {
      memory: {
        count: this.memoryCache.count,
        size: this.memoryCache.size,
        limit: this.opts.memoryLimit
      },
      persistent: {
        count: this.persistentTracker.count,
        size: this.persistentTracker.size,
        limit: this.opts.persistentLimit
      }
    };
  }
}
