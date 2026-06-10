import type { PyramidLevel } from "./manifest.js";
/** Uniform handle for whole-frame JXL or tiled JXTC top levels.
 * bytesId is attached lazily by the pool (Grok 2) for the load/decode protocol to avoid N-clones.
 */
export type LevelSource = {
    kind: "whole";
    bytes: Uint8Array;
    width: number;
    height: number;
    bitsPerSample: 8 | 16;
    bytesId?: number;
} | {
    kind: "tiled";
    bytes: Uint8Array;
    width: number;
    height: number;
    tileSize: number;
    bitsPerSample: 8 | 16;
    bytesId?: number;
};
export declare function createLevelSource(entry: Pick<PyramidLevel, "w" | "h" | "tiled"> & {
    bitsPerSample?: 8 | 16;
}, bytes: Uint8Array): LevelSource;
/**
 * Ensure the LevelSource is "prepared" for worker protocol use (Grok2).
 * Attaches bytesId lazily (the actual numeric value is assigned by the PyramidWorkerPool
 * instance using its own counter so ids are scoped to the pool, not global module).
 * Safe to call multiple times; idempotent on the source object identity.
 */
export declare function prepareLevelSource(source: LevelSource): LevelSource;
//# sourceMappingURL=level-source.d.ts.map