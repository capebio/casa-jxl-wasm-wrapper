/** Long-edge threshold for tiled top-level ingest (spec §4 / M4). */
export declare const MASSIVE_LONG_EDGE_THRESHOLD = 8000;
/** Pixel-count threshold for tiled top-level ingest (spec §4 / M4). */
export declare const MASSIVE_PIXEL_THRESHOLD = 40000000;
/** JXTC tile size for massive-scan top levels (rgba8 only in v1). */
export declare const JXTC_TILE_SIZE = 512;
export declare const JXTC_MAGIC = 1129601098;
export interface JxtcHeader {
    imageW: number;
    imageH: number;
    tileSize: number;
    tilesX: number;
    tilesY: number;
    hasAlpha: boolean;
    /** 8 or 16. v1 tiled containers are 8-bit; 16-bit available after JXTC-16 rebuild. */
    bitsPerSample: 8 | 16;
}
/** True when ingest should replace the whole-frame top level with a JXTC container. */
export declare function shouldTileTopLevel(width: number, height: number): boolean;
export declare function isJxtcContainer(bytes: Uint8Array): boolean;
/** Parse the 32-byte JXTC container header (little-endian u32 fields). */
export declare function parseJxtcHeader(bytes: Uint8Array): JxtcHeader;
export interface ImageRegion {
    x: number;
    y: number;
    w: number;
    h: number;
}
/** Tile-aligned intersections between a viewport region and the JXTC grid. */
export declare function tilesOverlappingRegion(imageW: number, imageH: number, tileSize: number, region: ImageRegion): ImageRegion[];
/** COOP/COEP + Worker availability — parallel tile workers are viable. */
export declare function canUseParallelTileWorkers(): boolean;
/** Whether SharedArrayBuffer + crossOriginIsolated allows SAB-backed container bytes for zero-copy fanout to workers (Grok2 SAB opt-in). Split from canUseParallelTileWorkers. */
export declare function canShareContainerBytes(): boolean;
//# sourceMappingURL=tiling.d.ts.map