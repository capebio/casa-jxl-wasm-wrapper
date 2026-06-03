export interface CacheOptions {
    memoryLimit: number;
    persistentLimit: number;
    persistent?: boolean;
    basePath?: string;
}
export declare class JxlCacheBrowser {
    private readonly opts;
    private readonly memoryCache;
    private readonly persistentTracker;
    private readonly inflightGets;
    private readonly inflightSets;
    private readonly _encoder;
    private opfsRoot;
    private hitCount;
    private missCount;
    private manifestDirty;
    private manifestPendingWrite;
    constructor(opts: CacheOptions);
    init(): Promise<void>;
    get(key: string): Promise<ArrayBuffer | undefined>;
    set(key: string, buffer: ArrayBuffer): Promise<void>;
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
    private getPersistent;
    private setPersistent;
    private writePersistentFile;
    private evictPersistentUntilFits;
    private evictPersistentFraction;
    private removePersistentEntry;
    private loadManifest;
    private scheduleManifestWrite;
    private drainManifest;
    private writeManifest;
}
