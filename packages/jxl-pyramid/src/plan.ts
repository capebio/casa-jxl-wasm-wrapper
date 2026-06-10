import type { ImageRegion } from "./tiling.js";
import type { LevelSource } from "./level-source.js";
import { clampRegion, PyramidError } from "./decode-core.js";
import { parseJxtcHeader, tilesForClampedRegion, type JxtcHeader as TilingJxtcHeader } from "./tiling.js";
import { REGION_DECODER_RGBA8, REGION_DECODER_RGBA16, type RegionDecoder, formatFromBits, bppOfFormat, type PixelFormat } from "./decode-core.js";

// P8: one header type — full tiling header (tilesX/tilesY/hasAlpha now carried, P7) + container version.
export type JxtcHeader = Readonly<TilingJxtcHeader & { version: number }>;

export interface DecodePlan {
  viewport: ImageRegion;
  tiles: ImageRegion[];
  header: JxtcHeader;
  bits: 8 | 16;
  bpp: 4 | 8;
  format: PixelFormat;
  decodeRegion: RegionDecoder;
}

// P3: header memo by bytes identity; frozen and shared (no per-call copies, uniform identity).
const headerMemo = new WeakMap<Uint8Array, JxtcHeader>();
function memoParseHeader(bytes: Uint8Array): JxtcHeader {
  const hit = headerMemo.get(bytes);
  if (hit) return hit;
  const h: JxtcHeader = Object.freeze({ ...parseJxtcHeader(bytes), version: 1 });
  headerMemo.set(bytes, h);
  return h;
}

// P3: memoize only per-source-stable parts; viewport/tiles are per-call (no dead retention, no alias pinning).
interface PlanCore {
  header: JxtcHeader; bits: 8 | 16; bpp: 4 | 8; format: PixelFormat; decodeRegion: RegionDecoder;
}
const coreMemo = new WeakMap<LevelSource, PlanCore>();

export function prepareDecodePlan(source: LevelSource, region: ImageRegion): DecodePlan {
  if (source.kind !== "tiled") {
    throw new PyramidError('BAD_MANIFEST', 'prepareDecodePlan requires tiled LevelSource'); // P2: PyramidError uniformly
  }
  let core = coreMemo.get(source);
  if (core === undefined) {
    const header = memoParseHeader(source.bytes);
    // P1: hand-built sources (decode-level L18-2) may disagree with container bytes → wrong-tile decode. Cross-check.
    if (header.imageW !== source.width || header.imageH !== source.height || header.tileSize !== source.tileSize) {
      throw new PyramidError('DIM_MISMATCH',
        `source ${source.width}x${source.height}/T${source.tileSize} != container ${header.imageW}x${header.imageH}/T${header.tileSize}`);
    }
    const bits = header.bitsPerSample;
    const format = formatFromBits(bits);
    core = {
      header, bits, format, bpp: bppOfFormat(format),
      decodeRegion: bits === 16 ? REGION_DECODER_RGBA16 : REGION_DECODER_RGBA8, // F6 unchanged
    };
    coreMemo.set(source, core);
  }
  // P2: clampRegion asserts finite (PyramidError BAD_REGION) — one validation path for first and repeat calls.
  const viewport = clampRegion(region, source.width, source.height);
  if (viewport.w <= 0 || viewport.h <= 0) {
    throw new PyramidError('BAD_REGION', 'empty region after clamp');
  }
  // P5: already clamped — skip re-validate/re-clamp (T7 core walk).
  const tiles = tilesForClampedRegion(source.width, source.height, source.tileSize, viewport.x, viewport.y, viewport.w, viewport.h);
  return { viewport, tiles, header: core.header, bits: core.bits, bpp: core.bpp, format: core.format, decodeRegion: core.decodeRegion };
}

/** P6: prefetch ring — expand a viewport by whole tiles, clamped to the image (gaming/AR predictive fetch).
 *  Pure; pass the result to prepareDecodePlan/decode as a normal region. */
export function expandRegionByTiles(
  region: ImageRegion, tileSize: number, marginTiles: number, imageW: number, imageH: number,
): ImageRegion {
  const m = Math.max(0, Math.floor(marginTiles)) * tileSize;
  const x0 = Math.max(0, region.x - m);
  const y0 = Math.max(0, region.y - m);
  const x1 = Math.min(imageW, region.x + region.w + m);
  const y1 = Math.min(imageH, region.y + region.h + m);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}
