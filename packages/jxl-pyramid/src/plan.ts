import type { ImageRegion } from "./tiling.js";
import type { LevelSource } from "./level-source.js";
import { clampRegion } from "./decode-core.js";
import { parseJxtcHeader, tilesOverlappingRegion, type JxtcHeader as TilingJxtcHeader } from "./tiling.js";
import { pickRegionDecoder, REGION_DECODER_RGBA8, REGION_DECODER_RGBA16, type RegionDecoder, formatFromBits, bppOfFormat, type PixelFormat } from "./decode-core.js";

export interface JxtcHeader {
  imageW: number;
  imageH: number;
  tileSize: number;
  bitsPerSample: 8 | 16;
  version: number;
}

export interface DecodePlan {
  viewport: ImageRegion;
  tiles: ImageRegion[];
  header: JxtcHeader;
  bits: 8 | 16;
  bpp: 4 | 8;
  format: PixelFormat;
  decodeRegion: RegionDecoder;
}

// Memoized header parse: WeakMap by containerBytes identity (Grok1)
const headerMemo = new WeakMap<Uint8Array, JxtcHeader>();

function memoParseHeader(bytes: Uint8Array): JxtcHeader {
  const hit = headerMemo.get(bytes);
  if (hit) return hit;
  const th: TilingJxtcHeader = parseJxtcHeader(bytes);
  const h: JxtcHeader = {
    imageW: th.imageW,
    imageH: th.imageH,
    tileSize: th.tileSize,
    bitsPerSample: th.bitsPerSample,
    version: 1,
  };
  headerMemo.set(bytes, h);
  return h;
}

// Memoized tile grid by (W,H,T) triple. Key as string for simplicity (small).
const gridMemo = new Map<string, ImageRegion[]>();

export function precomputeTileGrid(W: number, H: number, T: number): ImageRegion[] {
  const key = `${W}:${H}:${T}`;
  const hit = gridMemo.get(key);
  if (hit) return hit;
  // Delegate to existing (validated) tilesOverlappingRegion with full rect to get grid? 
  // But for plan we want the grid tiles for the (clamped) viewport only; precompute full? 
  // Per spec: precomputeTileGrid(W, H, T) — used inside prepare for the viewport.
  // Implement as the tiles for a full-image region request (or memo helper).
  const fullRegion: ImageRegion = { x: 0, y: 0, w: W, h: H };
  const tiles = tilesOverlappingRegion(W, H, T, fullRegion);
  gridMemo.set(key, tiles);
  return tiles;
}

// Memoized per LevelSource (identity of source object)
const planMemo = new WeakMap<LevelSource, DecodePlan>();

export function prepareDecodePlan(source: LevelSource, region: ImageRegion): DecodePlan {
  if (source.kind !== "tiled") {
    throw new Error("prepareDecodePlan requires tiled LevelSource");
  }
  // WeakMap hit on source ref
  const cached = planMemo.get(source);
  if (cached) {
    // Still clamp per-call region (viewport can vary); header/decoder/grid stable per source
    const clamped = clampRegion(region, source.width, source.height);
    if (clamped.w <= 0 || clamped.h <= 0) {
      throw new RangeError("empty region after clamp");
    }
    // derive tiles for this viewport (grid precompute can be used for full but we use direct for ROI)
    const tiles = tilesOverlappingRegion(source.width, source.height, source.tileSize, clamped);
    return {
      viewport: clamped,
      tiles,
      header: cached.header,
      bits: cached.bits,
      bpp: cached.bpp,
      format: cached.format,
      decodeRegion: cached.decodeRegion,
    };
  }

  if (!Number.isFinite(region.x) || !Number.isFinite(region.y) || !Number.isFinite(region.w) || !Number.isFinite(region.h)) {
    throw new RangeError("region x,y,w,h must be finite");
  }
  const headerRaw = memoParseHeader(source.bytes);
  const header: JxtcHeader = { ...headerRaw };
  const bits = header.bitsPerSample;
  const format = formatFromBits(bits);
  // F6: format token derived once from header (manifest bits) and carried on DecodePlan/LevelSource.
  const decodeRegion: RegionDecoder = bits === 16 ? REGION_DECODER_RGBA16 : REGION_DECODER_RGBA8;
  const bpp: 4 | 8 = bppOfFormat(format);

  const viewport = clampRegion(region, source.width, source.height);
  if (viewport.w <= 0 || viewport.h <= 0) {
    throw new RangeError("empty region after clamp");
  }
  const tiles = tilesOverlappingRegion(source.width, source.height, source.tileSize, viewport);

  const plan: DecodePlan = { viewport, tiles, header, bits, bpp, format, decodeRegion };
  planMemo.set(source, plan);
  return plan;
}
