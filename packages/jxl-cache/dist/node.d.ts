import { CacheOptions, JxlCache } from './browser.js';
export declare class JxlCacheNode implements JxlCache {
    private readonly opts;
    private readonly memoryCache;
    private readonly persistentTracker;
    private readonly inflightGets;
    private hitCount;
    private missCount;
    private initPromise;
    constructor(opts: CacheOptions);
    init(): Promise<void>;
    private doInit;
    get(key: string): Promise<ArrayBuffer | undefined>;
    private getPersistent;
    has(key: string): Promise<boolean>;
    set(key: string, buffer: ArrayBuffer): Promise<void>;
    delete(key: string): Promise<void>;
    clear(): Promise<void>;
    stats(): {
        memory: {
            count: number;
            size: number;
            limit: number;
        };
        persistent: {
            count: number;
            size: number;
            limit: number;
            enabled: boolean;
        };
        inflight: {
            gets: number;
            sets: number;
        };
        hitRate: number | null;
    };
}
