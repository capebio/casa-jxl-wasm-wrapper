import type { MasterFormat, Orientation, PyramidLevelBytes } from "./backends.js";
export type LevelSize = number | "full";
export interface LevelEntry {
    size: LevelSize;
    w: number;
    h: number;
    bytes: number;
    bitsPerSample: 8 | 16;
    contenthash: string;
    tiled: boolean;
}
export interface MasterInfo {
    name: string;
    format: MasterFormat;
    mtimeMs: number;
}
export interface Manifest {
    schema: 1;
    imageId: string;
    master: MasterInfo;
    orientation: Orientation;
    width: number;
    height: number;
    aspect: number;
    levels: LevelEntry[];
    proxy?: true;
}
export interface IndexEntry {
    imageId: string;
    aspect: number;
    l0: {
        contenthash: string;
        w: number;
        h: number;
    };
}
export interface GalleryIndex {
    schema: 1;
    images: IndexEntry[];
}
export declare function levelSize(w: number, h: number, masterW: number, masterH: number): LevelSize;
export declare function toEntry(level: PyramidLevelBytes, masterW: number, masterH: number): LevelEntry;
export declare function buildManifest(args: {
    imageId: string;
    master: MasterInfo;
    orientation: Orientation;
    width: number;
    height: number;
    levels: LevelEntry[];
    proxy?: boolean;
}): Manifest;
export declare function buildIndexEntry(manifest: Manifest): IndexEntry;
export declare function isUpToDate(existing: Manifest, mtimeMs: number): boolean;
//# sourceMappingURL=manifest.d.ts.map