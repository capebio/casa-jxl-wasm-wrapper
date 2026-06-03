export class LRUCache {
    maxSize;
    cache = new Map();
    currentSize = 0;
    constructor(maxSize) {
        this.maxSize = maxSize;
    }
    get(key) {
        const item = this.cache.get(key);
        if (item) {
            this.cache.delete(key);
            this.cache.set(key, item);
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
    set(key, value, size) {
        // Items that can never fit are dropped immediately without evicting
        // anything — callers that evict-before-set have already ensured room.
        if (size > this.maxSize)
            return;
        if (this.cache.has(key)) {
            this.currentSize -= this.cache.get(key).size;
            this.cache.delete(key);
        }
        const iter = this.cache.keys();
        while (this.currentSize + size > this.maxSize && this.cache.size > 0) {
            const oldestKey = iter.next().value;
            if (oldestKey === undefined)
                break;
            this.currentSize -= this.cache.get(oldestKey).size;
            this.cache.delete(oldestKey);
        }
        this.cache.set(key, { value, size });
        this.currentSize += size;
    }
    delete(key) {
        const item = this.cache.get(key);
        if (item) {
            this.currentSize -= item.size;
            this.cache.delete(key);
        }
    }
    clear() {
        this.cache.clear();
        this.currentSize = 0;
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
    entriesOldestFirst() {
        return Array.from(this.cache.entries(), ([key, { value, size }]) => [key, value, size]);
    }
}
