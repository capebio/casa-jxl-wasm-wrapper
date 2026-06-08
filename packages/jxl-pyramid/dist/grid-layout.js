/**
 * Compute stable cell layouts from index.json. Uses aspect for height before bytes arrive.
 * `columnWidthPx` is the CSS width of one grid column; row unit = columnWidthPx for square base.
 */
export function layoutFromIndex(index, columnWidthPx) {
    const base = Math.max(1, columnWidthPx);
    return index.images.map((entry) => ({
        imageId: entry.imageId,
        aspect: entry.aspect,
        l0: entry.l0,
        rowSpan: Math.max(1, Math.round((base / entry.aspect) / base)),
    }));
}
//# sourceMappingURL=grid-layout.js.map