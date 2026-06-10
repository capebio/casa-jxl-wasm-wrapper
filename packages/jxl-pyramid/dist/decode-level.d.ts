import type { ImageRegion } from "./tiling.js";
import type { LevelSource } from "./level-source.js";
import { type DecodedLevel, type DecodeOptions } from "./decode-core.js";
export type { DecodedLevel, RegionDecoder, DecodeOptions, PyramidError } from "./decode-core.js";
/**
 * Decode a rectangular viewport from a tiled JXTC level.
 * Uses per-tile parallel decode when workers + COOP/COEP are available; otherwise one WASM call.
 */
export declare function decodeTiledViewport(source: Extract<LevelSource, {
    kind: "tiled";
}>, region: ImageRegion, options?: DecodeOptions): Promise<DecodedLevel>;
/** Decode a pyramid level: whole-frame in one shot, or a viewport slice from JXTC. */
export declare function decodeLevel(source: LevelSource, region?: ImageRegion, options?: DecodeOptions): Promise<DecodedLevel>;
//# sourceMappingURL=decode-level.d.ts.map