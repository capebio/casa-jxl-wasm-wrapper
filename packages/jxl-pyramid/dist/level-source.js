import { isJxtcContainer, parseJxtcHeader } from "./tiling.js";
export function createLevelSource(entry, bytes) {
    if (entry.tiled) {
        if (!isJxtcContainer(bytes)) {
            throw new Error("manifest level is tiled but bytes are not a JXTC container");
        }
        const header = parseJxtcHeader(bytes);
        return {
            kind: "tiled",
            bytes,
            width: header.imageW,
            height: header.imageH,
            tileSize: header.tileSize,
            bitsPerSample: header.bitsPerSample,
        };
    }
    // whole branch now carries bitsPerSample (Grok1 fix for contracts-003)
    return {
        kind: "whole",
        bytes,
        width: entry.w,
        height: entry.h,
        bitsPerSample: entry.bitsPerSample ?? 8,
    };
}
/**
 * Ensure the LevelSource is "prepared" for worker protocol use (Grok2).
 * Attaches bytesId lazily (the actual numeric value is assigned by the PyramidWorkerPool
 * instance using its own counter so ids are scoped to the pool, not global module).
 * Safe to call multiple times; idempotent on the source object identity.
 */
export function prepareLevelSource(source) {
    if (source.bytesId != null)
        return source;
    // Marker; the pool will overwrite with a real id the first time this source is used for a decode.
    source.bytesId = undefined;
    return source;
}
//# sourceMappingURL=level-source.js.map