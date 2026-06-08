import { type ImageRegion } from "./tiling.js";
import type { LevelSource } from "./level-source.js";
export interface DecodedLevel {
    pixels: Uint8Array;
    width: number;
    height: number;
}
export type RegionDecoder = (bytes: Uint8Array, region: ImageRegion) => Promise<DecodedLevel>;
/**
 * Decode a rectangular viewport from a tiled JXTC level.
 * Uses per-tile parallel decode when workers + COOP/COEP are available; otherwise one WASM call.
 */
export declare function decodeTiledViewport(source: Extract<LevelSource, {
    kind: "tiled";
}>, region: ImageRegion, options?: {
    parallel?: boolean;
    decodeRegion?: RegionDecoder;
}): Promise<DecodedLevel>;
/** Decode a pyramid level: whole-frame in one shot, or a viewport slice from JXTC. */
export declare function decodeLevel(source: LevelSource, region?: ImageRegion, options?: {
    parallel?: boolean;
    decodeRegion?: RegionDecoder;
}): Promise<DecodedLevel>;
//# sourceMappingURL=decode-level.d.ts.map