import type { ImageRegion } from "./tiling.js";
import type { LevelSource } from "./level-source.js";
import { type JxtcHeader as TilingJxtcHeader } from "./tiling.js";
import { type RegionDecoder, type PixelFormat } from "./decode-core.js";
export type JxtcHeader = Readonly<TilingJxtcHeader & {
    version: number;
}>;
export interface DecodePlan {
    viewport: ImageRegion;
    tiles: readonly ImageRegion[];
    header: JxtcHeader;
    bits: 8 | 16;
    bpp: 4 | 8;
    format: PixelFormat;
    decodeRegion: RegionDecoder;
}
export declare function prepareDecodePlan(source: LevelSource, region: ImageRegion): DecodePlan;
/** P6: prefetch ring — expand a viewport by whole tiles, clamped to the image (gaming/AR predictive fetch).
 *  Pure; pass the result to prepareDecodePlan/decode as a normal region. */
export declare function expandRegionByTiles(region: ImageRegion, tileSize: number, marginTiles: number, imageW: number, imageH: number): ImageRegion;
//# sourceMappingURL=plan.d.ts.map