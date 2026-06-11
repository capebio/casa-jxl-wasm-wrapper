export interface CacheOptions {
    memoryLimit: number;
    persistentLimit: number;
    persistent?: boolean;
    basePath?: string;
}
export interface JxlCache {
    init(): Promise<void>;
    get(key: string): Promise<ArrayBuffer | undefined>;
    set(key: string, buffer: ArrayBuffer): Promise<void>;
    delete(key: string): Promise<void>;
    has(key: string): Promise<boolean>;
    clear(): Promise<void>;
    stats(): any;
}
export declare function safeCacheName(key: string): string;
export declare function cacheNameFor(key: string): Promise<string>;
export declare class JxlCacheBrowser implements JxlCache {
    private readonly opts;
    private readonly memoryCache;
    private readonly persistentTracker;
    private readonly inflightGets;
    private readonly inflightSets;
    private readonly _encoder;
    private opfsRoot;
    private hitCount;
    private missCount;
    private evictionsCount;
    private quotaEvictionsCount;
    private manifestDirty;
    private manifestPendingWrite;
    private _generation;
    private initPromise;
    private persistentLimit;
    constructor(opts: CacheOptions);
    init(): Promise<void>;
    private doInit;
    get(key: string): Promise<ArrayBuffer | undefined>;
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
            evictions: number;
            quotaEvictions: number;
        };
        inflight: {
            gets: number;
            sets: number;
        };
        hitRate: number | null;
    };
    private getPersistent;
    private setPersistent;
    private writePersistentFile;
    private evictPersistentUntilFits;
    private evictPersistentFraction;
    private removePersistentEntry;
    private loadManifest;
    private reconcile;
    private scheduleManifestWrite;
    private drainManifest;
    private writeManifest;
}
