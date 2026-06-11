export declare class LRUCache<V> {
    private maxSize;
    private cache;
    private currentSize;
    private mruKey;
    constructor(maxSize: number);
    get(key: string): V | undefined;
    /**
     * Read a value without updating its LRU position.
     * Use this when inspecting an entry that is about to be evicted so that
     * the Map insertion-order (= LRU order) is not disturbed.
     */
    peek(key: string): V | undefined;
    has(key: string): boolean;
    setMaxSize(n: number): void;
    set(key: string, value: V, size: number): void;
    private evictToFit;
    delete(key: string): void;
    clear(): void;
    getOldestKey(): string | undefined;
    get size(): number;
    get count(): number;
    entriesOldestFirst(): Array<[string, V, number]>;
}
