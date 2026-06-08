/** Long-edge threshold for tiled top-level ingest (spec §4 / M4). */
export const MASSIVE_LONG_EDGE_THRESHOLD = 8000;

/** Pixel-count threshold for tiled top-level ingest (spec §4 / M4). */
export const MASSIVE_PIXEL_THRESHOLD = 40_000_000;

/** JXTC tile size for massive-scan top levels (rgba8 only in v1). */
export const JXTC_TILE_SIZE = 512;

export const JXTC_MAGIC = 0x4354_584a; // 'JXTC' little-endian

export interface JxtcHeader {
  imageW: number;
  imageH: number;
  tileSize: number;
  tilesX: number;
  tilesY: number;
  hasAlpha: boolean;
  /** 8 or 16. v1 tiled containers are 8-bit; 16-bit available after JXTC-16 rebuild. */
  bitsPerSample: 8 | 16;
}

/** True when ingest should replace the whole-frame top level with a JXTC container. */
export function shouldTileTopLevel(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  const longEdge = Math.max(width, height);
  return longEdge > MASSIVE_LONG_EDGE_THRESHOLD || width * height > MASSIVE_PIXEL_THRESHOLD;
}

export function isJxtcContainer(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, true) === JXTC_MAGIC;
}

/** Parse the 32-byte JXTC container header (little-endian u32 fields). */
export function parseJxtcHeader(bytes: Uint8Array): JxtcHeader {
  if (bytes.byteLength < 32) throw new Error("JXTC container too small for header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== JXTC_MAGIC) throw new Error("not a JXTC container");
  if (view.getUint32(4, true) !== 1) throw new Error("unsupported JXTC version");
  const imageW = view.getUint32(8, true);
  const imageH = view.getUint32(12, true);
  const tileSize = view.getUint32(16, true);
  const tilesX = view.getUint32(20, true);
  const tilesY = view.getUint32(24, true);
  const flags = view.getUint32(28, true);
  const hasAlpha = (flags & 1) !== 0;
  const bitsPerSample: 8 | 16 = (flags & 2) !== 0 ? 16 : 8;
  return { imageW, imageH, tileSize, tilesX, tilesY, hasAlpha, bitsPerSample };
}

export interface ImageRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Tile-aligned intersections between a viewport region and the JXTC grid. */
export function tilesOverlappingRegion(
  imageW: number,
  imageH: number,
  tileSize: number,
  region: ImageRegion,
): ImageRegion[] {
  if (tileSize <= 0) throw new Error("tileSize must be positive");
  const rx = Math.min(Math.max(0, region.x), imageW);
  const ry = Math.min(Math.max(0, region.y), imageH);
  const rw = Math.min(region.w, imageW - rx);
  const rh = Math.min(region.h, imageH - ry);
  if (rw <= 0 || rh <= 0) return [];

  const txMin = Math.floor(rx / tileSize);
  const txMax = Math.floor((rx + rw - 1) / tileSize);
  const tyMin = Math.floor(ry / tileSize);
  const tyMax = Math.floor((ry + rh - 1) / tileSize);

  const out: ImageRegion[] = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      const tileX0 = tx * tileSize;
      const tileY0 = ty * tileSize;
      const tileW = Math.min(tileSize, imageW - tileX0);
      const tileH = Math.min(tileSize, imageH - tileY0);
      const ox0 = Math.max(tileX0, rx);
      const oy0 = Math.max(tileY0, ry);
      const ox1 = Math.min(tileX0 + tileW, rx + rw);
      const oy1 = Math.min(tileY0 + tileH, ry + rh);
      const ow = ox1 - ox0;
      const oh = oy1 - oy0;
      if (ow > 0 && oh > 0) out.push({ x: ox0, y: oy0, w: ow, h: oh });
    }
  }
  return out;
}

type ParallelRuntime = {
  Worker?: unknown;
  crossOriginIsolated?: boolean;
};

/** COOP/COEP + Worker availability — parallel tile workers are viable. */
export function canUseParallelTileWorkers(): boolean {
  const rt = globalThis as ParallelRuntime;
  if (typeof rt.Worker === "undefined") return false;
  if (typeof rt.crossOriginIsolated === "boolean") return rt.crossOriginIsolated;
  return false;
}