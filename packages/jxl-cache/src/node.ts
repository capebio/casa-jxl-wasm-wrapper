import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { LRUCache } from './lru.js';
import { CacheOptions, JxlCache, safeCacheName } from './browser.js';

function fileNameFor(key: string): string {
  const enc = safeCacheName(key);
  return enc.length <= 150
    ? enc
    : 'sha256-' + createHash('sha256').update(key).digest('hex');
}

let tmpCounter = 0;

export class JxlCacheNode implements JxlCache {
  private readonly memoryCache: LRUCache<ArrayBuffer>;
  private readonly persistentTracker: LRUCache<true>;
  private readonly inflightGets = new Map<string, Promise<ArrayBuffer | undefined>>();

  private hitCount = 0;
  private missCount = 0;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly opts: CacheOptions) {
    this.memoryCache = new LRUCache(opts.memoryLimit);
    this.persistentTracker = new LRUCache(opts.persistentLimit);
  }

  init(): Promise<void> {
    return this.initPromise ??= this.doInit();
  }

  private async doInit(): Promise<void> {
    if (this.opts.persistent && this.opts.basePath) {
      await fs.mkdir(this.opts.basePath, { recursive: true });
      try {
        const files = await fs.readdir(this.opts.basePath);
        const stats = await Promise.all(
          files.map(async file => {
            if (file.includes('.tmp-')) {
              await fs.unlink(path.join(this.opts.basePath!, file)).catch(() => undefined);
              return null;
            }
            const stat = await fs.stat(path.join(this.opts.basePath!, file)).catch(() => null);
            return stat ? { file, stat } : null;
          })
        );
        const valid = stats.filter(Boolean) as Array<{ file: string; stat: import('node:fs').Stats }>;
        valid.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
        for (const { file, stat } of valid) {
          this.persistentTracker.set(file, true, stat.size);
        }
      } catch (e) {
        console.warn('Node cache initialization scan failed', e);
      }
    }
  }

  async get(key: string): Promise<ArrayBuffer | undefined> {
    if (this.initPromise) await this.initPromise.catch(() => undefined);

    const mem = this.memoryCache.get(key);
    if (mem !== undefined) {
      const name = fileNameFor(key);
      this.persistentTracker.get(name);
      this.hitCount++;
      return mem;
    }

    if (!this.opts.persistent || !this.opts.basePath) {
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

  private async getPersistent(key: string): Promise<ArrayBuffer | undefined> {
    if (!this.opts.persistent || !this.opts.basePath) return undefined;

    const name = fileNameFor(key);
    const filePath = path.join(this.opts.basePath, name);

    try {
      const buffer = await fs.readFile(filePath);
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      this.memoryCache.set(key, arrayBuffer, arrayBuffer.byteLength);
      this.persistentTracker.set(name, true, buffer.byteLength);
      return arrayBuffer;
    } catch {
      this.persistentTracker.delete(name);
      return undefined;
    }
  }

  async has(key: string): Promise<boolean> {
    if (this.initPromise) await this.initPromise.catch(() => undefined);
    if (this.memoryCache.has(key)) return true;
    if (this.opts.persistent && this.opts.basePath) {
      const name = fileNameFor(key);
      if (this.persistentTracker.has(name)) return true;
    }
    return false;
  }

  async set(key: string, buffer: ArrayBuffer): Promise<void> {
    if (this.initPromise) await this.initPromise.catch(() => undefined);
    const size = buffer.byteLength;
    this.memoryCache.set(key, buffer, size);

    if (this.opts.persistent && this.opts.basePath) {
      const name = fileNameFor(key);
      const filePath = path.join(this.opts.basePath, name);

      if (size > this.opts.persistentLimit) {
        this.persistentTracker.delete(name);
        await fs.unlink(filePath).catch(() => undefined);
        return;
      }

      while (this.persistentTracker.size + size > this.opts.persistentLimit && this.persistentTracker.count > 0) {
        const oldest = this.persistentTracker.getOldestKey();
        if (oldest === undefined) break;
        this.persistentTracker.delete(oldest);
        await fs.unlink(path.join(this.opts.basePath, oldest)).catch(() => undefined);
      }

      try {
        const tmp = filePath + `.tmp-${process.pid}-${tmpCounter++}`;
        await fs.writeFile(tmp, Buffer.from(buffer));
        await fs.rename(tmp, filePath);
        this.persistentTracker.set(name, true, size);
      } catch (e) {
        console.error('Failed to write to Node cache', e);
      }
    }
  }

  async delete(key: string): Promise<void> {
    if (this.initPromise) await this.initPromise.catch(() => undefined);
    this.memoryCache.delete(key);
    if (this.opts.persistent && this.opts.basePath) {
      const name = fileNameFor(key);
      this.persistentTracker.delete(name);
      await fs.unlink(path.join(this.opts.basePath, name)).catch(() => undefined);
    }
  }

  async clear(): Promise<void> {
    if (this.initPromise) await this.initPromise.catch(() => undefined);
    this.memoryCache.clear();
    this.persistentTracker.clear();
    this.inflightGets.clear();
    if (this.opts.persistent && this.opts.basePath) {
      try {
        const files = await fs.readdir(this.opts.basePath);
        await Promise.allSettled(
          files.map((file) => fs.unlink(path.join(this.opts.basePath!, file)))
        );
      } catch (e) {
        console.warn('Node cache clear failed', e);
      }
    }
  }

  stats() {
    const total = this.hitCount + this.missCount;
    return {
      memory: {
        count: this.memoryCache.count,
        size: this.memoryCache.size,
        limit: this.opts.memoryLimit
      },
      persistent: {
        count: this.persistentTracker.count,
        size: this.persistentTracker.size,
        limit: this.opts.persistentLimit,
        enabled: !!this.opts.persistent && !!this.opts.basePath
      },
      inflight: {
        gets: this.inflightGets.size,
        sets: 0
      },
      hitRate: total > 0 ? this.hitCount / total : null,
    };
  }
}
