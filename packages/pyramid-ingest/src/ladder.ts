let JXTC_TILE_SIZE = 512;
let shouldTileTopLevel: (w: number, h: number) => boolean = (_w, _h) => false;
try {
  // @ts-expect-error - jxl-pyramid may be absent in some tsc envs (test matrix); runtime fallback below keeps module loadable
  const jp = await import("@casabio/jxl-pyramid");
  if (typeof jp.JXTC_TILE_SIZE === "number") JXTC_TILE_SIZE = jp.JXTC_TILE_SIZE;
  if (typeof jp.shouldTileTopLevel === "function") shouldTileTopLevel = jp.shouldTileTopLevel;
} catch {
  // test env or missing dep; use conservative defaults (no tile for small synthetic masters used in unit tests)
}
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
  // Massive scan gate (spec M4): only the *top* (full) level is replaced by JXTC container.
  // Master was already fully decoded; this does not implement source-tiled streaming ingest.
  if (!shouldTileTopLevel(width, height)) return levels;
  const tiled = await jxl.encodeTileContainer(rgba, width, height, {
    tileSize: JXTC_TILE_SIZE,
    distance: qualityToDistance(BIG_QUALITY),
    effort: EFFORT,
  });
  const sidecars = levels.slice(0, -1);
  return [...sidecars, { data: tiled, width, height, bitsPerSample: 8, tiled: true }];
}

export async function buildRawLadder(jxl: JxlBackend, decoded: DecodedMaster, profileConvergence = false): Promise<LadderResult> {
  const plan = planLadder();
  const { rgba, rgb16, width, height } = decoded;

  const shouldTile = shouldTileTopLevel(width, height);

  if (rgb16 && rgb16.length > 0) {
    const smallSidecars = plan.sidecars.filter((sc) => sc.size <= GRID_MAX_LONG);
    const smallPlan = { ...plan, sidecars: smallSidecars };
    const smallProduced = await jxl.encodePyramid(rgba, width, height, smallPlan);
    const gridLevels = smallProduced.slice(0, -1).map((l) => ({ ...l, bitsPerSample: 8 as const }));

    let bigLevels = await encodeBigLevelsRgba16(rgb16, width, height, plan);
    if (shouldTile) {
      // v1: massive RAW still emits 16-bit 2048 sidecar (bigLevels keeps it), but top full is rgba8 JXTC.
      // 16-bit JXTC for the tiled top level is deferred (requires bridge + ingest path change post-rebuild).
      bigLevels = bigLevels.slice(0, -1);
      const tiled = await jxl.encodeTileContainer(rgba, width, height, {
        tileSize: JXTC_TILE_SIZE,
        distance: qualityToDistance(BIG_QUALITY),
        effort: EFFORT,
      });
      const outLevels = [...gridLevels, ...bigLevels, { data: tiled, width, height, bitsPerSample: 8, tiled: true }];
      if (profileConvergence) await attachConverged(jxl, outLevels);
      return {
        levels: outLevels,
        orientation: decoded.orientation,
        width,
        height,
      };
    }

    const outLevels = [...gridLevels, ...bigLevels];
    if (profileConvergence) await attachConverged(jxl, outLevels);
    return { levels: outLevels, orientation: decoded.orientation, width, height };
  }

  const levels = await jxl.encodePyramid(rgba, width, height, plan);
  const finalLevels = await maybeTileTopLevel(
    jxl, levels.map((l) => ({ ...l, bitsPerSample: 8 })), rgba, width, height,
  );
  if (profileConvergence) await attachConverged(jxl, finalLevels);
  return {
    levels: finalLevels,
    orientation: decoded.orientation,
    width,
    height,
  };
}

async function attachConverged(jxl: JxlBackend, levels: PyramidLevelBytes[]): Promise<void> {
  for (const lvl of levels) {
    const mx = Math.max(lvl.width, lvl.height);
    if (mx >= 1024 && typeof jxl.profileConvergence === "function") {
      try {
        const ce = await jxl.profileConvergence(lvl.data, lvl.width, lvl.height);
        if (ce != null && ce > 0) lvl.convergedByteEnd = ce;
      } catch {
        // graceful: omit on error, single-pass JXL, or no ssim
      }
    }
  }
}

export async function buildJpgLadder(jxl: JxlBackend, jpeg: Uint8Array, profileConvergence = false): Promise<LadderResult> {
  const fullJxl = await jxl.transcodeJpeg(jpeg);
  const decoded = await jxl.decodeToRgba8(fullJxl);
  const produced = await jxl.encodePyramid(decoded.rgba, decoded.width, decoded.height, planLadder());
  const sidecars = produced.slice(0, -1);

  const shouldTile = shouldTileTopLevel(decoded.width, decoded.height);
  let fullLevel: PyramidLevelBytes;
  if (shouldTile) {
    const tiled = await jxl.encodeTileContainer(decoded.rgba, decoded.width, decoded.height, {
      tileSize: JXTC_TILE_SIZE,
      distance: qualityToDistance(BIG_QUALITY),
      effort: EFFORT,
    });
    fullLevel = { data: tiled, width: decoded.width, height: decoded.height, bitsPerSample: 8, tiled: true };
  } else {
    fullLevel = { data: fullJxl, width: decoded.width, height: decoded.height, bitsPerSample: 8, tiled: false };
  }

  const outLevels: PyramidLevelBytes[] = [...sidecars.map((l) => ({ ...l, bitsPerSample: 8 as const })), fullLevel];
  if (profileConvergence) await attachConverged(jxl, outLevels);
  return {
    levels: outLevels,
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
  profileConvergence = false,
): Promise<LadderResult> {
  const produced = await jxl.encodePyramid(rgba, width, height, planProxy(size));
  const level = produced[0];
  if (!level) throw new Error("proxy encode produced no level");
  const outLevels: PyramidLevelBytes[] = [{ ...level, bitsPerSample: 8 }];
  if (profileConvergence) await attachConverged(jxl, outLevels);
  return { levels: outLevels, orientation, width, height };
}