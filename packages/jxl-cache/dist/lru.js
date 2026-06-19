export class LRUCache {
    maxSize;
    cache = new Map();
    currentSize = 0;
    mruKey;
    constructor(maxSize) {
        this.maxSize = maxSize;
    }
    get(key) {
        const item = this.cache.get(key);
        if (item) {
            if (key === this.mruKey) {
                return item.value;
            }
            this.cache.delete(key);
            this.cache.set(key, item);
            this.mruKey = key;
            return item.value;
        }
        return undefined;
    }
    /**
     * Read a value without updating its LRU position.
     * Use this when inspecting an entry that is about to be evicted so that
     * the Map insertion-order (= LRU order) is not disturbed.
     */
    peek(key) {
        return this.cache.get(key)?.value;
    }
    has(key) {
        return this.cache.has(key);
    }
    setMaxSize(n) {
        if (!(n >= 0) || !Number.isFinite(n))
            return;
        this.maxSize = n;
        this.evictToFit(0);
    }
    set(key, value, size) {
        if (!(size >= 0) || !Number.isFinite(size))
            return;
        // Single lookup — was has() + get()!
        const existing = this.cache.get(key);
        if (existing !== undefined) {
            this.currentSize -= existing.size;
            this.cache.delete(key);
            if (this.mruKey === key)
                this.mruKey = undefined;
        }
        // Items that can never fit are dropped immediately without evicting
        // anything — callers that evict-before-set have already ensured room.
        if (size > this.maxSize)
            return;
        this.evictToFit(size);
        this.cache.set(key, { value, size });
        this.currentSize += size;
        this.mruKey = key;
    }
    evictToFit(incomingSize) {
        if (this.currentSize + incomingSize <= this.maxSize)
            return;
        for (const [key, item] of this.cache) {
            if (this.currentSize + incomingSize <= this.maxSize)
                break;
            this.currentSize -= item.size;
            this.cache.delete(key);
            if (this.mruKey === key)
                this.mruKey = undefined;
        }
    }
    delete(key) {
        const item = this.cache.get(key);
        if (item) {
            this.currentSize -= item.size;
            this.cache.delete(key);
            if (this.mruKey === key) {
                this.mruKey = undefined;
            }
        }
    }
    clear() {
        this.cache.clear();
        this.currentSize = 0;
        this.mruKey = undefined;
    }
    getOldestKey() {
        return this.cache.keys().next().value;
    }
    get size() {
        return this.currentSize;
    }
    get count() {
        return this.cache.size;
    }
    forEachOldestFirst(fn) {
        for (const [key, { value, size }] of this.cache.entries()) {
            fn(key, value, size);
        }
    }
    entriesOldestFirst() {
        const out = [];
        this.forEachOldestFirst((key, value, size) => out.push([key, value, size]));
        return out;
    }
}
