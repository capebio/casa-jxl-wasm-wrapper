import { contentHash16 } from "./hash.js";
function round4(x) {
    return Math.round(x * 10000) / 10000;
}
export function levelSize(w, h, masterW, masterH) {
    if (w === masterW && h === masterH)
        return "full";
    return Math.max(w, h);
}
export function toEntry(level, masterW, masterH) {
    return {
        size: levelSize(level.width, level.height, masterW, masterH),
        w: level.width,
        h: level.height,
        bytes: level.data.length,
        bitsPerSample: 8,
        contenthash: contentHash16(level.data),
        tiled: level.tiled === true,
    };
}
export function buildManifest(args) {
    const levels = [...args.levels].sort((a, b) => a.w * a.h - b.w * b.h);
    const manifest = {
        schema: 1,
        imageId: args.imageId,
        master: args.master,
        orientation: args.orientation,
        width: args.width,
        height: args.height,
        aspect: round4(args.width / args.height),
        levels,
    };
    if (args.proxy)
        manifest.proxy = true;
    return manifest;
}
export function buildIndexEntry(manifest) {
    const l0 = manifest.levels[0];
    if (!l0)
        throw new Error(`manifest ${manifest.imageId} has no levels`);
    return {
        imageId: manifest.imageId,
        aspect: manifest.aspect,
        l0: { contenthash: l0.contenthash, w: l0.w, h: l0.h },
    };
}
export function isUpToDate(existing, mtimeMs) {
    return existing.proxy !== true && Math.round(existing.master.mtimeMs) === Math.round(mtimeMs);
}
//# sourceMappingURL=manifest.js.map