import type { LevelSource } from "./level-source.js";
export interface PyramidCache {
    get(key: string): Uint8Array | undefined;
    set(key: string, value: Uint8Array): void;
    has(key: string): boolean;
    delete(key: string): void;
    clear(): void;
}
export declare function getLevelId(arg: Uint8Array | LevelSource): string;
export declare function createInMemoryPyramidCache(opts?: {
    maxBytes?: number;
}): PyramidCache;
//# sourceMappingURL=cache.d.ts.map