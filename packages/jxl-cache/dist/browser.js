import { LRUCache } from './lru.js';
const MANIFEST_NAME = '__jxl_cache_manifest.json';
function safeCacheName(key) {
    return encodeURIComponent(key).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
export class JxlCacheBrowser {
    opts;
    memoryCache;
    persistentTracker;
    inflightGets = new Map();
    inflightSets = new Map();
    opfsRoot = null;
    hitCount = 0;
    missCount = 0;
    manifestDirty = false;
    manifestPendingWrite = null;
    constructor(opts) {
        this.opts = opts;
        this.memoryCache = new LRUCache(opts.memoryLimit);
        this.persistentTracker = new LRUCache(opts.persistentLimit);
    }
    async init() {
        if (!this.opts.persistent || typeof navigator === 'undefined' || !navigator.storage) {
            return;
        }
        try {
            this.opfsRoot = await navigator.storage.getDirectory();
            await this.loadManifest();
        }
        catch (e) {
            console.warn('OPFS initialization failed', e);
            this.opfsRoot = null;
        }
    }
    async get(key) {
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
            if (result !== undefined)
                this.hitCount++;
            else
                this.missCount++;
            return result;
        }
        const pending = this.getPersistent(key);
        this.inflightGets.set(key, pending);
        try {
            const result = await pending;
            if (result !== undefined)
                this.hitCount++;
            else
                this.missCount++;
            return result;
        }
        finally {
            this.inflightGets.delete(key);
        }
    }
    async set(key, buffer) {
        const size = buffer.byteLength;
        this.memoryCache.set(key, buffer, size);
        if (!this.opfsRoot || size > this.opts.persistentLimit)
            return;
        const previous = this.inflightSets.get(key) ?? Promise.resolve();
        const pending = previous
            .catch(() => undefined)
            .then(() => this.setPersistent(key, buffer));
        this.inflightSets.set(key, pending);
        try {
            await pending;
        }
        finally {
            if (this.inflightSets.get(key) === pending) {
                this.inflightSets.delete(key);
            }
        }
    }
    async clear() {
        this.memoryCache.clear();
        this.persistentTracker.clear();
        this.inflightGets.clear();
        this.inflightSets.clear();
        this.manifestDirty = false;
        if (!this.opfsRoot)
            return;
        try {
            for await (const name of this.opfsRoot.keys()) {
                try {
                    await this.opfsRoot.removeEntry(name);
                }
                catch {
                    // Continue clearing remaining entries.
                }
            }
        }
        catch (e) {
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
    async getPersistent(key) {
        if (!this.opfsRoot)
            return undefined;
        try {
            const entry = this.persistentTracker.get(key);
            const name = entry?.name ?? safeCacheName(key);
            const fileHandle = await this.opfsRoot.getFileHandle(name);
            const file = await fileHandle.getFile();
            if (file.size === 0)
                return undefined;
            const buffer = await file.arrayBuffer();
            // Guard against a clear() that ran while we were awaiting OPFS I/O.
            // If opfsRoot was nulled out or the persistentTracker no longer knows
            // this key (both happen during clear()), skip the promotion so we don't
            // inject a stale entry into the freshly-cleared memory cache.
            if (this.opfsRoot === null)
                return undefined;
            this.memoryCache.set(key, buffer, buffer.byteLength);
            if (entry === undefined) {
                this.persistentTracker.set(key, { name }, buffer.byteLength);
            }
            return buffer;
        }
        catch (e) {
            if (e instanceof DOMException && e.name !== 'NotFoundError') {
                console.warn(`[JxlCacheBrowser] Failed to read persistent entry for "${key}"`, e);
            }
            return undefined;
        }
    }
    async setPersistent(key, buffer) {
        if (!this.opfsRoot)
            return;
        const size = buffer.byteLength;
        const name = safeCacheName(key);
        await this.evictPersistentUntilFits(size);
        try {
            await this.writePersistentFile(name, buffer);
            this.persistentTracker.set(key, { name }, size);
        }
        catch (e) {
            if (e instanceof Error && e.name === 'QuotaExceededError') {
                console.info(`[JxlCacheBrowser] Quota exceeded for "${key}", evicting aggressively`);
                await this.evictPersistentFraction(0.75);
                try {
                    await this.writePersistentFile(name, buffer);
                    this.persistentTracker.set(key, { name }, size);
                }
                catch (retryErr) {
                    // Persistent store is full even after aggressive eviction — treat as
                    // a non-fatal miss; the entry remains in the memory cache only.
                    console.warn(`[JxlCacheBrowser] Persistent store still full after eviction, skipping persist for "${key}"`, retryErr);
                    return;
                }
            }
            else {
                console.error(`[JxlCacheBrowser] Failed to persist "${key}"`, e);
                throw e;
            }
        }
        this.scheduleManifestWrite();
    }
    async writePersistentFile(name, buffer) {
        if (!this.opfsRoot)
            return;
        const fileHandle = await this.opfsRoot.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable();
        try {
            await writable.write(buffer);
            await writable.close();
        }
        catch (writeErr) {
            // Abort the stream so the browser can release the lock; ignore abort
            // errors so the original write error is always what propagates.
            try {
                await writable.abort();
            }
            catch { /* intentionally ignored */ }
            throw writeErr;
        }
    }
    async evictPersistentUntilFits(incomingSize) {
        while (this.persistentTracker.size + incomingSize > this.opts.persistentLimit &&
            this.persistentTracker.count > 0) {
            const oldest = this.persistentTracker.getOldestKey();
            if (oldest === undefined)
                break;
            await this.removePersistentEntry(oldest);
        }
    }
    async evictPersistentFraction(fraction) {
        const target = Math.max(1, Math.ceil(this.persistentTracker.count * fraction));
        for (let i = 0; i < target && this.persistentTracker.count > 0; i++) {
            const oldest = this.persistentTracker.getOldestKey();
            if (oldest === undefined)
                break;
            await this.removePersistentEntry(oldest);
        }
    }
    async removePersistentEntry(key) {
        if (!this.opfsRoot)
            return;
        // peek() instead of get() — we must not promote the eviction candidate to
        // MRU position while we are in the middle of LRU eviction.
        const entry = this.persistentTracker.peek(key);
        const name = entry?.name ?? safeCacheName(key);
        try {
            await this.opfsRoot.removeEntry(name);
        }
        catch {
            // Stale tracker or already removed.
        }
        finally {
            this.persistentTracker.delete(key);
        }
    }
    async loadManifest() {
        if (!this.opfsRoot)
            return;
        try {
            const handle = await this.opfsRoot.getFileHandle(MANIFEST_NAME);
            const file = await handle.getFile();
            const manifest = JSON.parse(await file.text());
            if (manifest.version !== 1)
                return;
            for (const entry of manifest.entries) {
                this.persistentTracker.set(entry.key, { name: entry.name }, entry.size);
            }
        }
        catch {
            // No manifest yet.
        }
    }
    scheduleManifestWrite() {
        this.manifestDirty = true;
        if (this.manifestPendingWrite !== null)
            return;
        this.manifestPendingWrite = Promise.resolve()
            .then(() => this.drainManifest())
            .finally(() => { this.manifestPendingWrite = null; });
    }
    async drainManifest() {
        while (this.manifestDirty) {
            this.manifestDirty = false;
            await this.writeManifest();
        }
    }
    async writeManifest() {
        if (!this.opfsRoot)
            return;
        try {
            const entries = [];
            for (const [key, entry, size] of this.persistentTracker.entriesOldestFirst()) {
                entries.push({ key, name: entry.name, size });
            }
            const manifest = { version: 1, entries };
            const encoded = new TextEncoder().encode(JSON.stringify(manifest));
            // Slice the backing buffer to the exact byte range of the encoded view —
            // TextEncoder may return a Uint8Array that does not start at offset 0 or
            // does not extend to the end of its backing ArrayBuffer.
            const manifestBuffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
            await this.writePersistentFile(MANIFEST_NAME, manifestBuffer);
        }
        catch (e) {
            console.warn('[JxlCacheBrowser] Failed to write manifest (non-fatal)', e);
        }
    }
}
