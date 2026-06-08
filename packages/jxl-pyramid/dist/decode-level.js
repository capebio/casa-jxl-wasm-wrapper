import { createDecoder, decodeTileContainerRegionRgba8 } from "@casabio/jxl-wasm";
import { canUseParallelTileWorkers, tilesOverlappingRegion, } from "./tiling.js";
async function decodeWhole(bytes) {
    const decoder = createDecoder({
        format: "rgba8",
        progressionTarget: "final",
        emitEveryPass: false,
        preserveIcc: false,
        preserveMetadata: false,
    });
    let result = null;
    const drain = (async () => {
        for await (const ev of decoder.events()) {
            if (ev.type === "final") {
                const px = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
                result = { pixels: px, width: ev.info.width, height: ev.info.height };
            }
            else if (ev.type === "error") {
                throw new Error(`decode ${ev.code}: ${ev.message}`);
            }
        }
    })();
    await decoder.push(bytes);
    await decoder.close();
    await drain;
    await decoder.dispose();
    if (!result)
        throw new Error("whole-frame decode produced no final frame");
    return result;
}
function stitchTileDecodes(viewport, parts) {
    const pixels = new Uint8Array(viewport.w * viewport.h * 4);
    for (const { region, decoded } of parts) {
        const dx = region.x - viewport.x;
        const dy = region.y - viewport.y;
        for (let row = 0; row < decoded.height; row++) {
            const srcOff = row * decoded.width * 4;
            const dstOff = ((dy + row) * viewport.w + dx) * 4;
            pixels.set(decoded.pixels.subarray(srcOff, srcOff + decoded.width * 4), dstOff);
        }
    }
    return { pixels, width: viewport.w, height: viewport.h };
}
/**
 * Decode a rectangular viewport from a tiled JXTC level.
 * Uses per-tile parallel decode when workers + COOP/COEP are available; otherwise one WASM call.
 */
export async function decodeTiledViewport(source, region, options) {
    const decodeRegion = options?.decodeRegion ?? (async (bytes, r) => {
        const out = await decodeTileContainerRegionRgba8(bytes, r);
        return { pixels: out.pixels, width: out.width, height: out.height };
    });
    const rx = Math.min(Math.max(0, region.x), source.width);
    const ry = Math.min(Math.max(0, region.y), source.height);
    const rw = Math.min(region.w, source.width - rx);
    const rh = Math.min(region.h, source.height - ry);
    if (rw <= 0 || rh <= 0)
        throw new Error("decode region is empty after clamping");
    const viewport = { x: rx, y: ry, w: rw, h: rh };
    const tiles = tilesOverlappingRegion(source.width, source.height, source.tileSize, viewport);
    const wantParallel = options?.parallel !== false && canUseParallelTileWorkers() && tiles.length > 1;
    if (!wantParallel) {
        return decodeRegion(source.bytes, viewport);
    }
    const parts = await Promise.all(tiles.map(async (tileRegion) => ({
        region: tileRegion,
        decoded: await decodeRegion(source.bytes, tileRegion),
    })));
    return stitchTileDecodes(viewport, parts);
}
/** Decode a pyramid level: whole-frame in one shot, or a viewport slice from JXTC. */
export async function decodeLevel(source, region, options) {
    if (source.kind === "whole") {
        if (region !== undefined) {
            throw new Error("region decode requires a tiled level source");
        }
        return decodeWhole(source.bytes);
    }
    const roi = region ?? { x: 0, y: 0, w: source.width, h: source.height };
    return decodeTiledViewport(source, roi, options);
}
//# sourceMappingURL=decode-level.js.map