import type { ImageRegion } from "./tiling.js";
import type { LevelSource } from "./level-source.js";
import { type RegionDecoder } from "./decode-core.js";
export interface JxtcHeader {
    imageW: number;
    imageH: number;
    tileSize: number;
    bitsPerSample: 8 | 16;
    version: number;
}
export interface DecodePlan {
    viewport: ImageRegion;
    tiles: ImageRegion[];
    header: JxtcHeader;
    bits: 8 | 16;
    bpp: 4 | 8;
    format: 'rgba8' | 'rgba16';
    decodeRegion: RegionDecoder;
}
export declare function precomputeTileGrid(W: number, H: number, T: number): ImageRegion[];
export declare function prepareDecodePlan(source: LevelSource, region: ImageRegion): DecodePlan;
//# sourceMappingURL=plan.d.ts.map