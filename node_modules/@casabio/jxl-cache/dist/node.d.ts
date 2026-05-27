import { CacheOptions } from './browser.js';
export declare class JxlCacheNode {
    private opts;
    private memoryCache;
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
    };
}
