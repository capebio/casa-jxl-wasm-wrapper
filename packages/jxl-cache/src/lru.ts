export class LRUCache<V> {
  private cache = new Map<string, { value: V, size: number }>();
  private currentSize = 0;

  constructor(private maxSize: number) {}

  get(key: string): V | undefined {
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
  peek(key: string): V | undefined {
    return this.cache.get(key)?.value;
  }

  set(key: string, value: V, size: number): void {
    // Items that can never fit are dropped immediately without evicting
    // anything — callers that evict-before-set have already ensured room.
    if (size > this.maxSize) return;

    if (this.cache.has(key)) {
      this.currentSize -= this.cache.get(key)!.size;
      this.cache.delete(key);
    }

    const iter = this.cache.keys();
    while (this.currentSize + size > this.maxSize && this.cache.size > 0) {
      const oldestKey = iter.next().value;
      if (oldestKey === undefined) break;
      this.currentSize -= this.cache.get(oldestKey)!.size;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, { value, size });
    this.currentSize += size;
  }

  delete(key: string): void {
    const item = this.cache.get(key);
    if (item) {
      this.currentSize -= item.size;
      this.cache.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
    this.currentSize = 0;
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

  entriesOldestFirst(): Array<[string, V, number]> {
    return Array.from(this.cache.entries(), ([key, { value, size }]) => [key, value, size]);
  }
}
