import type { GalleryIndex, GalleryIndexEntry } from "./manifest.js";
export interface GridCellLayout {
    imageId: string;
    aspect: number;
    l0: GalleryIndexEntry["l0"];
    /** CSS grid row span (unitless, multiplied by row height in the view). */
    rowSpan: number;
}
/**
 * Compute stable cell layouts from index.json. Uses aspect for height before bytes arrive.
 * `columnWidthPx` is the CSS width of one grid column; row unit = columnWidthPx for square base.
 */
export declare function layoutFromIndex(index: GalleryIndex, columnWidthPx: number): GridCellLayout[];
//# sourceMappingURL=grid-layout.d.ts.map