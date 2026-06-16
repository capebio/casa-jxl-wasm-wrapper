import type { GalleryIndex, GalleryIndexEntry } from "./manifest.js";

export interface GridCellLayout {
  imageId: string;
  aspect: number;
  l0: GalleryIndexEntry["l0"];
  /** CSS grid row span (unitless, multiplied by row height in the view). */
  rowSpan: number;
}

let lastIndex: GalleryIndex | undefined;
let lastColumn = NaN;
let lastLayouts: GridCellLayout[] | undefined;

/**
 * Compute stable cell layouts from index.json. Uses aspect for height before bytes arrive.
 * `columnWidthPx` is the CSS width of one grid column; row unit = columnWidthPx for square base.
 */
export function layoutFromIndex(index: GalleryIndex, columnWidthPx: number): GridCellLayout[] {
  if (index === lastIndex && columnWidthPx === lastColumn && lastLayouts) return lastLayouts;
  // G4-B: guard aspect (and column for safety)
  const safeColumn = Number.isFinite(columnWidthPx) && columnWidthPx > 0 ? columnWidthPx : 1;
  const layouts = index.images.map((entry) => {
    const aspect = Number.isFinite(entry.aspect) && entry.aspect > 0 ? entry.aspect : 1.0;
    const columnWidth = safeColumn;
    const rowUnitHeight = columnWidth; // explicit base row unit (square)
    const cellHeight = columnWidth / aspect; // correctly factors columnWidth into height
    return {
      imageId: entry.imageId,
      aspect,
      l0: entry.l0,
      rowSpan: Math.max(1, Math.round(cellHeight / rowUnitHeight)),
    };
  });
  lastIndex = index;
  lastColumn = columnWidthPx;
  lastLayouts = layouts;
  return layouts;
}
