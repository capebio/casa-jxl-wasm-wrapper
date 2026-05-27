import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { LRUCache } from './lru.js';
export class JxlCacheNode {
    opts;
    memoryCache;
    constructor(opts) {
        this.opts = opts;
        this.memoryCache = new LRUCache(opts.memoryLimit);
    }
    async init() {
        if (this.opts.persistent && this.opts.basePath) {
            await fs.mkdir(this.opts.basePath, { recursive: true });
        }
    }
    async get(key) {
        const mem = this.memoryCache.get(key);
        if (mem)
            return mem;
        if (this.opts.persistent && this.opts.basePath) {
            try {
                const filePath = path.join(this.opts.basePath, key);
                const buffer = await fs.readFile(filePath);
                const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
                this.memoryCache.set(key, arrayBuffer, arrayBuffer.byteLength);
                return arrayBuffer;
            }
            catch {
                return undefined;
            }
        }
        return undefined;
    }
    async set(key, buffer) {
        this.memoryCache.set(key, buffer, buffer.byteLength);
        if (this.opts.persistent && this.opts.basePath) {
            try {
                const filePath = path.join(this.opts.basePath, key);
                await fs.writeFile(filePath, Buffer.from(buffer));
            }
            catch (e) {
                console.error('Failed to write to Node cache', e);
            }
        }
    }
    async clear() {
        this.memoryCache.clear();
        if (this.opts.persistent && this.opts.basePath) {
            try {
                const files = await fs.readdir(this.opts.basePath);
                for (const file of files) {
                    await fs.unlink(path.join(this.opts.basePath, file));
                }
            }
            catch { }
        }
    }
    stats() {
        return {
            memory: {
                count: this.memoryCache.count,
                size: this.memoryCache.size,
                limit: this.opts.memoryLimit
            }
        };
    }
}
