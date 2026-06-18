import type { PyramidLevel } from "./manifest.js";
import { type PixelFormat } from "./decode-core.js";
/** Uniform handle for whole-frame JXL or tiled JXTC top levels.
 * Instances are safe to share across concurrent decodes; treat all fields as frozen after creation.
 */
export type LevelSource = {
    kind: "whole";
    bytes: Uint8Array;
    width: number;
    height: number;
    bitsPerSample: 8 | 16;
    format: PixelFormat;
    bpp: 4 | 8;
    level?: number;
} | {
    kind: "tiled";
    bytes: Uint8Array;
    width: number;
    height: number;
    tileSize: number;
    bitsPerSample: 8 | 16;
    format: PixelFormat;
    bpp: 4 | 8;
    version: 1 | 2;
    level?: number;
    tilesX: number;
    tilesY: number;
};
export declare function createLevelSource(entry: Pick<PyramidLevel, "w" | "h" | "tiled"> & {
    bitsPerSample?: 8 | 16;
}, bytes: Uint8Array, levelIndex?: number): LevelSource;
//# sourceMappingURL=level-source.d.ts.map