import { BIG_QUALITY, EFFORT, planLadder, planProxy, qualityToDistance } from "./quality.js";
import { encodeBigLevelsRgba16, packedRgb16ToRgba16, targetDimsForLongEdge } from "./rgb16.js";
import type { DecodedMaster, JxlBackend, Orientation, PyramidLevelBytes } from "./backends.js";

export interface LadderResult {
  levels: PyramidLevelBytes[];
  orientation: Orientation;
  width: number;
  height: number;
}

const GRID_MAX_LONG = 1024;
const TILE_SIZE = 256;

export async function buildRawLadder(jxl: JxlBackend, decoded: DecodedMaster, profileConvergence = false): Promise<LadderResult> {
  const plan = planLadder();
  const { rgba, rgb16, width, height } = decoded;
  const masterLong = Math.max(width, height);

  if (rgb16 && rgb16.length > 0) {
    // 8-bit grid levels (<=1024) via rgba8 downscale + tile
    const gridLevels: PyramidLevelBytes[] = [];
    let cur8 = rgba;
    let cw = width, ch = height;
    const gridTargets = plan.sidecars.filter((sc) => sc.size <= GRID_MAX_LONG);
    for (const sc of gridTargets) {
      const dst = targetDimsForLongEdge(width, height, sc.size);
      if (dst.w !== cw || dst.h !== ch) {
        cur8 = await jxl.downscaleRgba8(cur8, cw, ch, dst.w, dst.h);
        cw = dst.w; ch = dst.h;
      }
      const data = await jxl.encodeTileContainer(cur8, cw, ch, {
        tileSize: TILE_SIZE,
        distance: sc.distance,
        effort: EFFORT,
      });
      gridLevels.push({ data, width: cw, height: ch, bitsPerSample: 8, tiled: true });
    }

    // 16-bit levels (2048+) via rgb16 downscale + encodeTileContainer16
    let cur16 = packedRgb16ToRgba16(rgb16, width, height);
    let cw16 = width, ch16 = height;
    const bigSidecars = plan.sidecars
      .filter((sc) => sc.size >= 2048 && sc.size < masterLong)
      .sort((a, b) => b.size - a.size);
    const bigTargets = [
      { longEdge: masterLong, distance: plan.fullDistance },
      ...bigSidecars.map((sc) => ({ longEdge: sc.size, distance: sc.distance })),
    ];
    const bigLevels: PyramidLevelBytes[] = [];
    const enc16 = jxl.encodeTileContainer16;
    if (typeof enc16 !== "function") {
      throw new Error("encodeTileContainer16 required for 16-bit tiled levels (Phase 3)");
    }
    for (const t of bigTargets) {
      const dst = targetDimsForLongEdge(width, height, t.longEdge);
      if (dst.w !== cw16 || dst.h !== ch16) {
        cur16 = (await jxl.downscaleRgba16!(cur16, cw16, ch16, dst.w, dst.h)) as Uint16Array;
        cw16 = dst.w; ch16 = dst.h;
      }
      const data = await enc16(cur16 as any, cw16, ch16, {
        tileSize: TILE_SIZE,
        distance: t.distance,
        effort: EFFORT,
      });
      bigLevels.push({ data, width: cw16, height: ch16, bitsPerSample: 16, tiled: true });
    }

    const outLevels = [...gridLevels, ...bigLevels];
    if (profileConvergence) await attachConverged(jxl, outLevels);
    return { levels: outLevels, orientation: decoded.orientation, width, height };
  }

  // 8-bit only path (all levels via downscale + encodeTileContainer)
  const levels: PyramidLevelBytes[] = [];
  let cur = rgba;
  let cw = width, ch = height;
  const sideTargets = plan.sidecars.filter((sc) => sc.size < masterLong);
  const targets = [...sideTargets, { size: masterLong, distance: qualityToDistance(BIG_QUALITY) }];
  targets.sort((a, b) => a.size - b.size);
  for (const t of targets) {
    const dst = targetDimsForLongEdge(width, height, t.size);
    if (dst.w !== cw || dst.h !== ch) {
      cur = await jxl.downscaleRgba8(cur, cw, ch, dst.w, dst.h);
      cw = dst.w; ch = dst.h;
    }
    const data = await jxl.encodeTileContainer(cur, cw, ch, {
      tileSize: TILE_SIZE,
      distance: t.distance,
      effort: EFFORT,
    });
    levels.push({ data, width: cw, height: ch, bitsPerSample: 8, tiled: true });
  }
  if (profileConvergence) await attachConverged(jxl, levels);
  return {
    levels,
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
  // For JPG, transcode then decode solely to obtain rgba pixels representing the decoded source;
  // all levels (incl. full) are then produced as JXTC via encodeTileContainer (no monolithic fallback).
  const fullJxl = await jxl.transcodeJpeg(jpeg);
  const decoded = await jxl.decodeToRgba8(fullJxl);
  const w = decoded.width, h = decoded.height;
  const masterLong = Math.max(w, h);

  const plan = planLadder();
  const sideTargets = plan.sidecars.filter((sc) => sc.size < masterLong);
  const targets = [...sideTargets, { size: masterLong, distance: qualityToDistance(BIG_QUALITY) }];
  targets.sort((a, b) => a.size - b.size);

  const levels: PyramidLevelBytes[] = [];
  let cur = decoded.rgba;
  let cw = w, ch = h;
  for (const t of targets) {
    const dst = targetDimsForLongEdge(w, h, t.size);
    if (dst.w !== cw || dst.h !== ch) {
      cur = await jxl.downscaleRgba8(cur, cw, ch, dst.w, dst.h);
      cw = dst.w; ch = dst.h;
    }
    const data = await jxl.encodeTileContainer(cur, cw, ch, {
      tileSize: TILE_SIZE,
      distance: t.distance,
      effort: EFFORT,
    });
    levels.push({ data, width: cw, height: ch, bitsPerSample: 8, tiled: true });
  }
  if (profileConvergence) await attachConverged(jxl, levels);
  return {
    levels,
    orientation: "source",
    width: w,
    height: h,
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