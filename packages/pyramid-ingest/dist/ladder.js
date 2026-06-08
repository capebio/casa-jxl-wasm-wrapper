import { JXTC_TILE_SIZE, shouldTileTopLevel } from "@casabio/jxl-pyramid";
import { BIG_QUALITY, EFFORT, planLadder, planProxy, qualityToDistance } from "./quality.js";
async function maybeTileTopLevel(jxl, levels, rgba, width, height) {
    if (!shouldTileTopLevel(width, height))
        return levels;
    const tiled = await jxl.encodeTileContainer(rgba, width, height, {
        tileSize: JXTC_TILE_SIZE,
        distance: qualityToDistance(BIG_QUALITY),
        effort: EFFORT,
    });
    const sidecars = levels.slice(0, -1);
    return [...sidecars, { data: tiled, width, height, tiled: true }];
}
export async function buildRawLadder(jxl, decoded) {
    const levels = await jxl.encodePyramid(decoded.rgba, decoded.width, decoded.height, planLadder());
    const finalLevels = await maybeTileTopLevel(jxl, levels, decoded.rgba, decoded.width, decoded.height);
    return {
        levels: finalLevels,
        orientation: decoded.orientation,
        width: decoded.width,
        height: decoded.height,
    };
}
export async function buildJpgLadder(jxl, jpeg) {
    const fullJxl = await jxl.transcodeJpeg(jpeg);
    const decoded = await jxl.decodeToRgba8(fullJxl);
    const produced = await jxl.encodePyramid(decoded.rgba, decoded.width, decoded.height, planLadder());
    const sidecars = produced.slice(0, -1);
    let fullLevel;
    if (shouldTileTopLevel(decoded.width, decoded.height)) {
        const tiled = await jxl.encodeTileContainer(decoded.rgba, decoded.width, decoded.height, {
            tileSize: JXTC_TILE_SIZE,
            distance: qualityToDistance(BIG_QUALITY),
            effort: EFFORT,
        });
        fullLevel = { data: tiled, width: decoded.width, height: decoded.height, tiled: true };
    }
    else {
        fullLevel = { data: fullJxl, width: decoded.width, height: decoded.height, tiled: false };
    }
    return {
        levels: [...sidecars, fullLevel],
        orientation: "source",
        width: decoded.width,
        height: decoded.height,
    };
}
export async function buildProxyLadder(jxl, rgba, width, height, size, orientation) {
    const produced = await jxl.encodePyramid(rgba, width, height, planProxy(size));
    const level = produced[0];
    if (!level)
        throw new Error("proxy encode produced no level");
    return { levels: [level], orientation, width, height };
}
//# sourceMappingURL=ladder.js.map