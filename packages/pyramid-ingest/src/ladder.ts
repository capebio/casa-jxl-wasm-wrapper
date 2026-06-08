import { JXTC_TILE_SIZE, shouldTileTopLevel } from "@casabio/jxl-pyramid";
import { BIG_QUALITY, EFFORT, planLadder, planProxy, qualityToDistance } from "./quality.js";
import { encodeBigLevelsRgba16 } from "./rgb16.js";
import type { DecodedMaster, JxlBackend, Orientation, PyramidLevelBytes } from "./backends.js";

export interface LadderResult {
  levels: PyramidLevelBytes[];
  orientation: Orientation;
  width: number;
  height: number;
}

const GRID_MAX_LONG = 1024;

async function maybeTileTopLevel(
  jxl: JxlBackend,
  levels: PyramidLevelBytes[],
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<PyramidLevelBytes[]> {
  if (!shouldTileTopLevel(width, height)) return levels;
  const tiled = await jxl.encodeTileContainer(rgba, width, height, {
    tileSize: JXTC_TILE_SIZE,
    distance: qualityToDistance(BIG_QUALITY),
    effort: EFFORT,
  });
  const sidecars = levels.slice(0, -1);
  return [...sidecars, { data: tiled, width, height, bitsPerSample: 8, tiled: true }];
}

export async function buildRawLadder(jxl: JxlBackend, decoded: DecodedMaster): Promise<LadderResult> {
  const plan = planLadder();
  const { rgba, rgb16, width, height } = decoded;

  if (rgb16 && rgb16.length > 0) {
    const smallSizes = plan.sidecarSizes.filter((s) => s <= GRID_MAX_LONG);
    const smallDists = plan.sidecarDistances.slice(0, smallSizes.length);
    const smallPlan = { ...plan, sidecarSizes: smallSizes, sidecarDistances: smallDists };
    const smallProduced = await jxl.encodePyramid(rgba, width, height, smallPlan);
    const gridLevels = smallProduced.slice(0, -1).map((l) => ({ ...l, bitsPerSample: 8 as const }));

    let bigLevels = await encodeBigLevelsRgba16(rgb16, width, height, plan);
    if (shouldTileTopLevel(width, height)) {
      bigLevels = bigLevels.slice(0, -1);
      const tiled = await jxl.encodeTileContainer(rgba, width, height, {
        tileSize: JXTC_TILE_SIZE,
        distance: qualityToDistance(BIG_QUALITY),
        effort: EFFORT,
      });
      return {
        levels: [...gridLevels, ...bigLevels, { data: tiled, width, height, bitsPerSample: 8, tiled: true }],
        orientation: decoded.orientation,
        width,
        height,
      };
    }

    return { levels: [...gridLevels, ...bigLevels], orientation: decoded.orientation, width, height };
  }

  const levels = await jxl.encodePyramid(rgba, width, height, plan);
  const finalLevels = await maybeTileTopLevel(
    jxl, levels.map((l) => ({ ...l, bitsPerSample: 8 })), rgba, width, height,
  );
  return {
    levels: finalLevels,
    orientation: decoded.orientation,
    width,
    height,
  };
}

export async function buildJpgLadder(jxl: JxlBackend, jpeg: Uint8Array): Promise<LadderResult> {
  const fullJxl = await jxl.transcodeJpeg(jpeg);
  const decoded = await jxl.decodeToRgba8(fullJxl);
  const produced = await jxl.encodePyramid(decoded.rgba, decoded.width, decoded.height, planLadder());
  const sidecars = produced.slice(0, -1);

  let fullLevel: PyramidLevelBytes;
  if (shouldTileTopLevel(decoded.width, decoded.height)) {
    const tiled = await jxl.encodeTileContainer(decoded.rgba, decoded.width, decoded.height, {
      tileSize: JXTC_TILE_SIZE,
      distance: qualityToDistance(BIG_QUALITY),
      effort: EFFORT,
    });
    fullLevel = { data: tiled, width: decoded.width, height: decoded.height, bitsPerSample: 8, tiled: true };
  } else {
    fullLevel = { data: fullJxl, width: decoded.width, height: decoded.height, bitsPerSample: 8, tiled: false };
  }

  return {
    levels: [...sidecars.map((l) => ({ ...l, bitsPerSample: 8 as const })), fullLevel],
    orientation: "source",
    width: decoded.width,
    height: decoded.height,
  };
}

export async function buildProxyLadder(
  jxl: JxlBackend,
  rgba: Uint8Array,
  width: number,
  height: number,
  size: number,
  orientation: Orientation,
): Promise<LadderResult> {
  const produced = await jxl.encodePyramid(rgba, width, height, planProxy(size));
  const level = produced[0];
  if (!level) throw new Error("proxy encode produced no level");
  return { levels: [{ ...level, bitsPerSample: 8 }], orientation, width, height };
}