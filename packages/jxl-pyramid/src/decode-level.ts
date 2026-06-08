import { createDecoder, decodeTileContainerRegionRgba8, decodeTileContainerRegionRgba16 } from "@casabio/jxl-wasm";
import {
  canUseParallelTileWorkers,
  tilesOverlappingRegion,
  type ImageRegion,
} from "./tiling.js";
import type { LevelSource } from "./level-source.js";

export interface DecodedLevel {
  pixels: Uint8Array;
  width: number;
  height: number;
}

export type RegionDecoder = (
  bytes: Uint8Array,
  region: ImageRegion,
) => Promise<DecodedLevel>;

async function decodeWhole(bytes: Uint8Array): Promise<DecodedLevel> {
  const decoder = createDecoder({
    format: "rgba8",
    progressionTarget: "final",
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
  });
  let result: DecodedLevel | null = null;
  const drain = (async () => {
    for await (const ev of decoder.events()) {
      if (ev.type === "final") {
        const px = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
        result = { pixels: px, width: ev.info.width, height: ev.info.height };
      } else if (ev.type === "error") {
        throw new Error(`decode ${ev.code}: ${ev.message}`);
      }
    }
  })();
  await decoder.push(bytes);
  await decoder.close();
  await drain;
  await decoder.dispose();
  if (!result) throw new Error("whole-frame decode produced no final frame");
  return result;
}

function pickRegionDecoder(bits: 8 | 16): RegionDecoder {
  if (bits === 16) {
    return async (bytes, r) => {
      const out = await decodeTileContainerRegionRgba16(bytes, r);
      return { pixels: out.pixels, width: out.width, height: out.height };
    };
  }
  return async (bytes, r) => {
    const out = await decodeTileContainerRegionRgba8(bytes, r);
    return { pixels: out.pixels, width: out.width, height: out.height };
  };
}

function stitchTileDecodes(
  viewport: ImageRegion,
  parts: { region: ImageRegion; decoded: DecodedLevel }[],
  bytesPerPixel: 4 | 8 = 4,
): DecodedLevel {
  const pixels = new Uint8Array(viewport.w * viewport.h * bytesPerPixel);
  const dstStride = viewport.w * bytesPerPixel;
  for (const { region, decoded } of parts) {
    const dx = region.x - viewport.x;
    const dy = region.y - viewport.y;
    const srcStride = decoded.width * bytesPerPixel;
    if (decoded.width === viewport.w && dx === 0) {
      // Stride-aligned fast path (I4): full-width tile is contiguous block.
      pixels.set(decoded.pixels, dy * dstStride);
    } else {
      for (let row = 0; row < decoded.height; row++) {
        const srcOff = row * srcStride;
        const dstOff = ((dy + row) * viewport.w + dx) * bytesPerPixel;
        pixels.set(decoded.pixels.subarray(srcOff, srcOff + srcStride), dstOff);
      }
    }
  }
  return { pixels, width: viewport.w, height: viewport.h };
}

/**
 * Decode a rectangular viewport from a tiled JXTC level.
 * Uses per-tile parallel decode when workers + COOP/COEP are available; otherwise one WASM call.
 */
export async function decodeTiledViewport(
  source: Extract<LevelSource, { kind: "tiled" }>,
  region: ImageRegion,
  options?: {
    parallel?: boolean;
    decodeRegion?: RegionDecoder;
  },
): Promise<DecodedLevel> {
  const bits = source.bitsPerSample ?? 8;
  const decodeRegion = options?.decodeRegion ?? pickRegionDecoder(bits);

  const rx = Math.min(Math.max(0, region.x), source.width);
  const ry = Math.min(Math.max(0, region.y), source.height);
  const rw = Math.min(region.w, source.width - rx);
  const rh = Math.min(region.h, source.height - ry);
  if (rw <= 0 || rh <= 0) throw new Error("decode region is empty after clamping");
  const viewport: ImageRegion = { x: rx, y: ry, w: rw, h: rh };

  const tiles = tilesOverlappingRegion(source.width, source.height, source.tileSize, viewport);
  const wantParallel = options?.parallel !== false && canUseParallelTileWorkers() && tiles.length > 1;

  if (!wantParallel) {
    return decodeRegion(source.bytes, viewport);
  }

  const parts = await Promise.all(
    tiles.map(async (tileRegion) => ({
      region: tileRegion,
      decoded: await decodeRegion(source.bytes, tileRegion),
    })),
  );
  const bpp: 4 | 8 = bits === 16 ? 8 : 4;
  return stitchTileDecodes(viewport, parts, bpp);
}

/** Decode a pyramid level: whole-frame in one shot, or a viewport slice from JXTC. */
export async function decodeLevel(
  source: LevelSource,
  region?: ImageRegion,
  options?: { parallel?: boolean; decodeRegion?: RegionDecoder },
): Promise<DecodedLevel> {
  if (source.kind === "whole") {
    if (region !== undefined) {
      throw new Error("region decode requires a tiled level source");
    }
    return decodeWhole(source.bytes);
  }
  const roi = region ?? { x: 0, y: 0, w: source.width, h: source.height };
  return decodeTiledViewport(source, roi, options);
}