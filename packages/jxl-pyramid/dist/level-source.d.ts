import type { PyramidLevel } from "./manifest.js";
/** Uniform handle for whole-frame JXL or tiled JXTC top levels. */
export type LevelSource = {
    kind: "whole";
    bytes: Uint8Array;
    width: number;
    height: number;
} | {
    kind: "tiled";
    bytes: Uint8Array;
    width: number;
    height: number;
    tileSize: number;
};
export declare function createLevelSource(entry: Pick<PyramidLevel, "w" | "h" | "tiled">, bytes: Uint8Array): LevelSource;
//# sourceMappingURL=level-source.d.ts.map