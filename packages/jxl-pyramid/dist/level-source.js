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
        };
    }
    return { kind: "whole", bytes, width: entry.w, height: entry.h };
}
//# sourceMappingURL=level-source.js.map