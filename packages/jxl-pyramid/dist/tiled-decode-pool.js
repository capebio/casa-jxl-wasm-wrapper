import { decodeTileContainerRegionRgba8 } from "@casabio/jxl-wasm";
import { canUseParallelTileWorkers, parseJxtcHeader, tilesOverlappingRegion, } from "./tiling.js";
function stitch(viewport, parts) {
    const pixels = new Uint8Array(viewport.w * viewport.h * 4);
    for (const { region, decoded } of parts) {
        const dx = region.x - viewport.x;
        const dy = region.y - viewport.y;
        for (let row = 0; row < decoded.height; row++) {
            pixels.set(decoded.pixels.subarray(row * decoded.width * 4, (row + 1) * decoded.width * 4), ((dy + row) * viewport.w + dx) * 4);
        }
    }
    return { pixels, width: viewport.w, height: viewport.h };
}
let nextWorkerId = 0;
function decodeTileWithWorker(worker, bytes, region) {
    const id = ++nextWorkerId;
    return new Promise((resolve, reject) => {
        const onMessage = (ev) => {
            if (ev.data.id !== id)
                return;
            worker.removeEventListener("message", onMessage);
            if (ev.data.ok) {
                resolve({
                    pixels: new Uint8Array(ev.data.pixels),
                    width: ev.data.width,
                    height: ev.data.height,
                });
            }
            else {
                reject(new Error(ev.data.error));
            }
        };
        worker.addEventListener("message", onMessage);
        // Structured clone copies bytes per worker (no transfer — shared container).
        worker.postMessage({ id, bytes, region });
    });
}
async function decodeTilesParallel(containerBytes, tiles, workerFactory) {
    const rt = globalThis;
    const poolSize = Math.min(rt.navigator?.hardwareConcurrency ?? 4, tiles.length);
    const workers = Array.from({ length: poolSize }, workerFactory);
    try {
        const results = new Array(tiles.length);
        let next = 0;
        await Promise.all(workers.map(async (worker) => {
            while (true) {
                const idx = next++;
                if (idx >= tiles.length)
                    break;
                const region = tiles[idx];
                const decoded = await decodeTileWithWorker(worker, containerBytes, region);
                results[idx] = { region, decoded };
            }
        }));
        return results;
    }
    finally {
        for (const w of workers)
            w.terminate();
    }
}
/**
 * Decode a tiled viewport with optional parallel per-tile workers.
 * Falls back to a single WASM ROI decode when workers unavailable.
 */
export async function decodeTiledViewportPooled(containerBytes, region, options) {
    const header = parseJxtcHeader(containerBytes);
    const rx = Math.min(Math.max(0, region.x), header.imageW);
    const ry = Math.min(Math.max(0, region.y), header.imageH);
    const rw = Math.min(region.w, header.imageW - rx);
    const rh = Math.min(region.h, header.imageH - ry);
    if (rw <= 0 || rh <= 0)
        throw new Error("empty tiled viewport");
    const viewport = { x: rx, y: ry, w: rw, h: rh };
    const decodeRegion = options?.decodeRegion ?? (async (bytes, r) => {
        const out = await decodeTileContainerRegionRgba8(bytes, r);
        return { pixels: out.pixels, width: out.width, height: out.height };
    });
    const tiles = tilesOverlappingRegion(header.imageW, header.imageH, header.tileSize, viewport);
    const wantParallel = options?.parallel !== false
        && canUseParallelTileWorkers()
        && tiles.length > 1
        && options?.workerFactory !== undefined;
    if (!wantParallel) {
        return decodeRegion(containerBytes, viewport);
    }
    const parts = await decodeTilesParallel(containerBytes, tiles, options.workerFactory);
    return stitch(viewport, parts);
}
//# sourceMappingURL=tiled-decode-pool.js.map