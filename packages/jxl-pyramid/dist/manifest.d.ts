/** Supported master image file formats. */
export type MasterFormat = "orf" | "dng" | "cr2" | "jpg";
/** Image orientation handling strategy. */
export type Orientation = "baked" | "source";
/** Target size for a pyramid level, either a long-edge target size (number) or the string "full". */
export type LevelSize = number | "full";
/** Supported bit depths per sample in the JXL stream. */
export type BitsPerSample = 8 | 16;
/** Metadata of the original master image. */
export interface MasterMetadata {
    name: string;
    format: MasterFormat;
    mtimeMs: number;
}
/** Information about a single pyramid level. */
export interface PyramidLevel {
    size: LevelSize;
    w: number;
    h: number;
    bytes: number;
    bitsPerSample: BitsPerSample;
    contenthash: string;
    tiled: boolean;
}
/** The schema definition of `manifest.json` per image. */
export interface PyramidManifest {
    schema: 1;
    imageId: string;
    master: MasterMetadata;
    orientation: Orientation;
    width: number;
    height: number;
    aspect: number;
    levels: PyramidLevel[];
    proxy?: boolean;
}
/** Information about the smallest level (L0 seed) inlined in the gallery index. */
export interface LevelZeroSeed {
    contenthash: string;
    w: number;
    h: number;
}
/** A single image entry within `index.json`. */
export interface GalleryIndexEntry {
    imageId: string;
    aspect: number;
    l0: LevelZeroSeed;
}
/** The schema definition of `index.json` per gallery. */
export interface GalleryIndex {
    schema: 1;
    images: GalleryIndexEntry[];
}
//# sourceMappingURL=manifest.d.ts.map