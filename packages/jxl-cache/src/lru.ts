export class LRUCache<V> {
  private cache = new Map<string, { value: V, size: number }>();
  private currentSize = 0;
  private mruKey: string | undefined;

  constructor(private maxSize: number) {}

  get(key: string): V | undefined {
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
  peek(key: string): V | undefined {
    return this.cache.get(key)?.value;
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  setMaxSize(n: number): void {
    if (!(n >= 0) || !Number.isFinite(n)) return;
    this.maxSize = n;
    this.evictToFit(0);
  }

  set(key: string, value: V, size: number): void {
    if (!(size >= 0) || !Number.isFinite(size)) return;

    if (this.cache.has(key)) {
      this.currentSize -= this.cache.get(key)!.size;
      this.cache.delete(key);
      if (this.mruKey === key) {
        this.mruKey = undefined;
      }
    }

    // Items that can never fit are dropped immediately without evicting
    // anything — callers that evict-before-set have already ensured room.
    if (size > this.maxSize) return;

    this.evictToFit(size);

    this.cache.set(key, { value, size });
    this.currentSize += size;
    this.mruKey = key;
  }

  private evictToFit(incomingSize: number) {
    const iter = this.cache.keys();
    while (this.currentSize + incomingSize > this.maxSize && this.cache.size > 0) {
      const oldestKey = iter.next().value;
      if (oldestKey === undefined) break;
      const item = this.cache.get(oldestKey);
      if (!item) break;
      this.currentSize -= item.size;
      this.cache.delete(oldestKey);
      if (this.mruKey === oldestKey) {
        this.mruKey = undefined;
      }
    }
  }

  delete(key: string): void {
    const item = this.cache.get(key);
    if (item) {
      this.currentSize -= item.size;
      this.cache.delete(key);
      if (this.mruKey === key) {
        this.mruKey = undefined;
      }
    }
  }

  clear(): void {
    this.cache.clear();
    this.currentSize = 0;
    this.mruKey = undefined;
  }

  getOldestKey(): string | undefined {
    return this.cache.keys().next().value;
  }

  get size(): number {
    return this.currentSize;
  }

  get count(): number {
    return this.cache.size;
  }

  forEachOldestFirst(fn: (key: string, value: V, size: number) => void): void {
    for (const [key, { value, size }] of this.cache.entries()) {
      fn(key, value, size);
    }
  }

  entriesOldestFirst(): Array<[string, V, number]> {
    const out: Array<[string, V, number]> = [];
    this.forEachOldestFirst((key, value, size) => out.push([key, value, size]));
    return out;
  }
}
