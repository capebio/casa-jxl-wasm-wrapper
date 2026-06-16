import { LRUCache } from './lru.js';
const MANIFEST_NAME = '__jxl_cache_manifest.json';
const MAX_NAME = 200;
export function safeCacheName(key) {
    return encodeURIComponent(key).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
export async function cacheNameFor(key) {
    const enc = safeCacheName(key);
    if (enc.length <= MAX_NAME)
        return enc;
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    return 'sha256-' + [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export class JxlCacheBrowser {
    opts;
    memoryCache;
    persistentTracker;
    inflightGets = new Map();
    inflightSets = new Map();
    _encoder = new TextEncoder();
    opfsRoot = null;
    hitCount = 0;
    missCount = 0;
    evictionsCount = 0;
    quotaEvictionsCount = 0;
    manifestDirty = false;
    manifestPendingWrite = null;
    // Incremented on every clear(). Guards async operations that straddle a clear boundary.
    _generation = 0;
    initPromise = null;
    persistentLimit;
    constructor(opts) {
        this.opts = opts;
        this.memoryCache = new LRUCache(opts.memoryLimit);
        this.persistentTracker = new LRUCache(opts.persistentLimit);
        this.persistentLimit = opts.persistentLimit;
    }
    init() {
        return this.initPromise ??= this.doInit();
    }
    async doInit() {
        if (!this.opts.persistent || typeof navigator === 'undefined' || !navigator.storage) {
            return;
        }
        try {
            this.opfsRoot = await navigator.storage.getDirectory();
            const estimate = await navigator.storage.estimate().catch(() => null);
            if (estimate && typeof estimate.quota === 'number') {
                const remaining = typeof estimate.usage === 'number'
                    ? Math.max(0, estimate.quota - estimate.usage)
                    : estimate.quota;
                this.persistentLimit = Math.min(this.opts.persistentLimit, Math.floor(remaining * 0.5));
                this.persistentTracker.setMaxSize(this.persistentLimit);
            }
            await this.loadManifest();
        }
        catch (e) {
            console.warn('OPFS initialization failed', e);
            this.opfsRoot = null;
        }
    }
    async get(key) {
        if (this.initPromise)
            await this.initPromise.catch(() => undefined);
        const mem = this.memoryCache.get(key);
        if (mem !== undefined) {
            this.persistentTracker.get(key);
            this.hitCount++;
            return mem.slice(0);
        }
        if (!this.opfsRoot) {
            this.missCount++;
            return undefined;
        }
        const ps = this.inflightSets.get(key);
        if (ps)
            await ps.catch(() => undefined);
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
    async has(key) {
        if (this.initPromise)
            await this.initPromise.catch(() => undefined);
        if (this.memoryCache.has(key))
            return true;
        if (this.persistentTracker.has(key))
            return true;
        return false;
    }
    async set(key, buffer) {
        if (this.initPromise)
            await this.initPromise.catch(() => undefined);
        const size = buffer.byteLength;
        const master = buffer.slice(0);
        this.memoryCache.set(key, master, size);
        if (!this.opfsRoot || size > this.persistentLimit) {
            if (this.opfsRoot) {
                const previous = this.inflightSets.get(key) ?? Promise.resolve();
                const pending = (async () => {
                    try {
                        await previous;
                    }
                    catch { /* proceed */ }
                    await this.removePersistentEntry(key);
                    this.scheduleManifestWrite();
                })();
                this.inflightSets.set(key, pending);
                try {
                    await pending;
                }
                finally {
                    if (this.inflightSets.get(key) === pending)
                        this.inflightSets.delete(key);
                }
            }
            return;
        }
        const gen = this._generation;
        const previous = this.inflightSets.get(key) ?? Promise.resolve();
        const pending = (async () => {
            try {
                await previous;
            }
            catch { /* proceed */ }
            if (this._generation !== gen)
                return;
            await this.setPersistent(key, master);
        })();
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
    async delete(key) {
        if (this.initPromise)
            await this.initPromise.catch(() => undefined);
        this.memoryCache.delete(key);
        const ps = this.inflightSets.get(key);
        if (ps)
            await ps.catch(() => undefined);
        await this.removePersistentEntry(key);
        this.scheduleManifestWrite();
    }
    async clear() {
        if (this.initPromise)
            await this.initPromise.catch(() => undefined);
        this._generation++;
        this.memoryCache.clear();
        this.persistentTracker.clear();
        this.inflightGets.clear();
        this.inflightSets.clear();
        this.manifestDirty = false;
        if (!this.opfsRoot)
            return;
        try {
            const names = [];
            for await (const name of this.opfsRoot.keys()) {
                names.push(name);
            }
            await Promise.allSettled(names.map((name) => this.opfsRoot.removeEntry(name).catch(() => undefined)));
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
                limit: this.persistentLimit,
                enabled: this.opfsRoot !== null,
                evictions: this.evictionsCount,
                quotaEvictions: this.quotaEvictionsCount,
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
        const gen = this._generation;
        try {
            const entry = this.persistentTracker.get(key);
            const name = entry?.name ?? await cacheNameFor(key);
            const fileHandle = await this.opfsRoot.getFileHandle(name);
            const file = await fileHandle.getFile();
            if (file.size === 0) {
                this.persistentTracker.delete(key);
                this.opfsRoot.removeEntry(name).catch(() => undefined);
                return undefined;
            }
            const buffer = await file.arrayBuffer();
            if (this._generation !== gen)
                return undefined;
            this.memoryCache.set(key, buffer, buffer.byteLength);
            if (entry === undefined) {
                this.persistentTracker.set(key, { name }, buffer.byteLength);
            }
            return buffer.slice(0);
        }
        catch (e) {
            if (e instanceof DOMException && e.name === 'NotFoundError') {
                this.persistentTracker.delete(key);
            }
            else if (e instanceof DOMException) {
                console.warn(`[JxlCacheBrowser] Failed to read persistent entry for "${key}"`, e);
            }
            return undefined;
        }
    }
    async setPersistent(key, buffer) {
        if (!this.opfsRoot)
            return;
        const gen = this._generation;
        const size = buffer.byteLength;
        const name = await cacheNameFor(key);
        await this.evictPersistentUntilFits(size);
        if (this._generation !== gen)
            return;
        try {
            await this.writePersistentFile(name, buffer);
            if (this._generation !== gen)
                return;
            this.persistentTracker.set(key, { name }, size);
        }
        catch (e) {
            if (e instanceof DOMException && e.name === 'QuotaExceededError') {
                this.quotaEvictionsCount++;
                console.info(`[JxlCacheBrowser] Quota exceeded for "${key}", evicting aggressively`);
                await this.evictPersistentFraction(0.75);
                if (this._generation !== gen)
                    return;
                try {
                    await this.writePersistentFile(name, buffer);
                    if (this._generation !== gen)
                        return;
                    this.persistentTracker.set(key, { name }, size);
                }
                catch (retryErr) {
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
            try {
                await writable.abort();
            }
            catch { /* intentionally ignored */ }
            throw writeErr;
        }
    }
    async evictPersistentUntilFits(incomingSize) {
        while (this.persistentTracker.size + incomingSize > this.persistentLimit &&
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
        const entry = this.persistentTracker.peek(key);
        const name = entry?.name ?? await cacheNameFor(key);
        try {
            await this.opfsRoot.removeEntry(name);
        }
        catch {
            // Stale tracker or already removed.
        }
        finally {
            this.persistentTracker.delete(key);
            this.evictionsCount++;
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
                if (typeof entry.key === 'string' && typeof entry.name === 'string' && Number.isFinite(entry.size) && entry.size >= 0) {
                    this.persistentTracker.set(entry.key, { name: entry.name }, entry.size);
                }
            }
        }
        catch {
            // No manifest yet.
        }
        await this.reconcile();
    }
    async reconcile() {
        if (!this.opfsRoot)
            return;
        const onDisk = new Set();
        for await (const name of this.opfsRoot.keys())
            onDisk.add(name);
        onDisk.delete(MANIFEST_NAME);
        this.persistentTracker.forEachOldestFirst((key, entry, size) => {
            if (!onDisk.has(entry.name))
                this.persistentTracker.delete(key);
            else
                onDisk.delete(entry.name);
        });
        await Promise.allSettled([...onDisk].map(n => this.opfsRoot.removeEntry(n).catch(() => undefined)));
    }
    scheduleManifestWrite() {
        this.manifestDirty = true;
        if (this.manifestPendingWrite !== null)
            return;
        this.manifestPendingWrite = new Promise(resolve => setTimeout(resolve, 250))
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
        const performWrite = async () => {
            const gen = this._generation;
            const root = this.opfsRoot;
            if (!root)
                return;
            try {
                const entries = [];
                this.persistentTracker.forEachOldestFirst((key, entry, size) => {
                    entries.push({ key, name: entry.name, size });
                });
                const manifest = { version: 1, entries };
                const encoded = this._encoder.encode(JSON.stringify(manifest));
                if (this._generation !== gen)
                    return;
                await this.writePersistentFile(MANIFEST_NAME, encoded);
                if (this._generation !== gen) {
                    await root.removeEntry(MANIFEST_NAME).catch(() => undefined);
                }
            }
            catch (e) {
                console.warn('[JxlCacheBrowser] Failed to write manifest (non-fatal)', e);
            }
        };
        if (typeof navigator !== 'undefined' && navigator.locks) {
            await navigator.locks.request('jxl-cache-manifest', async () => performWrite());
        }
        else {
            await performWrite();
        }
    }
}
