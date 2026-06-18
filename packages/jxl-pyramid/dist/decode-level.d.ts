import type { ImageRegion } from "./tiling.js";
import type { LevelSource } from "./level-source.js";
import { type DecodedLevel, type DecodeOptions } from "./decode-core.js";
export type { DecodedLevel, RegionDecoder, DecodeOptions, ProgressiveMode, WorkerLike, DecoderInit, PixelFormat, TileProgress } from "./decode-core.js";
export { PyramidError, formatFromBits, bppOfFormat, viewportCacheKey, tileIdOf, tileKey, tileKeyPacked } from "./decode-core.js";
/**
 * Decode a rectangular viewport from a tiled JXTC level.
 * Uses per-tile parallel decode when workers + COOP/COEP are available; otherwise one WASM call.
 */
export declare function decodeTiledViewport(source: Extract<LevelSource, {
    kind: "tiled";
}>, region: ImageRegion, options?: DecodeOptions): Promise<DecodedLevel>;
/** Decode a pyramid level: whole-frame in one shot, or a viewport slice from JXTC. */
export declare function decodeLevel(source: LevelSource, region?: ImageRegion, options?: DecodeOptions): Promise<DecodedLevel>;
/** Pure helper: extrapolate the viewport along its velocity. leadMs ~ one decode round-trip. */
export declare function predictRegion(vp: ImageRegion, velXPxPerMs: number, velYPxPerMs: number, leadMs: number): ImageRegion;
/** Warm the tile cache for a (predicted) region. Never throws; resolves when done or aborted. */
export declare function prefetchViewport(source: Extract<LevelSource, {
    kind: "tiled";
}>, region: ImageRegion, options: Pick<DecodeOptions, 'cache' | 'signal' | 'workerFactory' | 'pool' | 'parallel' | 'coreBudget' | 'cacheDcTiles'>): Promise<void>;
//# sourceMappingURL=decode-level.d.ts.map