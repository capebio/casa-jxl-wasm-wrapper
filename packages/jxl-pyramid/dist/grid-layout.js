/**
 * Compute stable cell layouts from index.json. Uses aspect for height before bytes arrive.
 * `columnWidthPx` is the CSS width of one grid column; row unit = columnWidthPx for square base.
 */
export function layoutFromIndex(index, columnWidthPx) {
    // G4-B: guard aspect (and column for safety)
    const safeColumn = Number.isFinite(columnWidthPx) && columnWidthPx > 0 ? columnWidthPx : 1;
    return index.images.map((entry) => {
        const aspect = Number.isFinite(entry.aspect) && entry.aspect > 0 ? entry.aspect : 1.0;
        const columnWidth = safeColumn;
        const rowUnitHeight = columnWidth; // explicit base row unit (square)
        const cellHeight = columnWidth / aspect; // correctly factors columnWidth into height
        return {
            imageId: entry.imageId,
            aspect: entry.aspect,
            l0: entry.l0,
            rowSpan: Math.max(1, Math.round(cellHeight / rowUnitHeight)),
        };
    });
}
//# sourceMappingURL=grid-layout.js.map