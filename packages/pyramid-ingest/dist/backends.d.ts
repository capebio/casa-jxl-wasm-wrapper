export type MasterFormat = "orf" | "dng" | "cr2" | "jpg";
export type RawFormat = "orf" | "dng" | "cr2";
export type Orientation = "baked" | "source";
export interface DecodedMaster {
    rgba: Uint8Array;
    width: number;
    height: number;
    orientation: Orientation;
}
export interface PyramidLevelBytes {
    data: Uint8Array;
    width: number;
    height: number;
    tiled?: boolean;
}
export interface TileContainerEncodeOptions {
    tileSize: number;
    distance: number;
    effort: number;
}
export interface PyramidEncodeOptions {
    fullDistance: number;
    sidecarSizes: readonly number[];
    sidecarDistances: readonly number[];
    effort: number;
}
export interface RawBackend {
    decode(bytes: Uint8Array, format: RawFormat): Promise<DecodedMaster>;
}
export interface JxlBackend {
    encodePyramid(rgba: Uint8Array, width: number, height: number, opts: PyramidEncodeOptions): Promise<PyramidLevelBytes[]>;
    encodeTileContainer(rgba: Uint8Array, width: number, height: number, opts: TileContainerEncodeOptions): Promise<Uint8Array>;
    transcodeJpeg(jpeg: Uint8Array): Promise<Uint8Array>;
    decodeToRgba8(jxl: Uint8Array): Promise<{
        rgba: Uint8Array;
        width: number;
        height: number;
    }>;
}
export declare function createJxlBackend(): JxlBackend;
//# sourceMappingURL=backends.d.ts.map