import { contentHash16 } from "./hash.js";
import type { MasterFormat, Orientation, PyramidLevelBytes } from "./backends.js";

export type LevelSize = number | "full";

export interface LevelEntry {
  size: LevelSize;
  w: number;
  h: number;
  bytes: number;
  bitsPerSample: 8 | 16;
  contenthash: string;
  tiled: boolean;
}

export interface MasterInfo {
  name: string;
  format: MasterFormat;
  mtimeMs: number;
}

export interface Manifest {
  schema: 1;
  imageId: string;
  master: MasterInfo;
  orientation: Orientation;
  width: number;
  height: number;
  aspect: number;
  levels: LevelEntry[];
  proxy?: true;
}

export interface IndexEntry {
  imageId: string;
  aspect: number;
  l0: { contenthash: string; w: number; h: number };
}

export interface GalleryIndex {
  schema: 1;
  images: IndexEntry[];
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

export function levelSize(w: number, h: number, masterW: number, masterH: number): LevelSize {
  if (w === masterW && h === masterH) return "full";
  return Math.max(w, h);
}

export function toEntry(level: PyramidLevelBytes, masterW: number, masterH: number): LevelEntry {
  return {
    size: levelSize(level.width, level.height, masterW, masterH),
    w: level.width,
    h: level.height,
    bytes: level.data.length,
    bitsPerSample: level.bitsPerSample ?? 8,
    contenthash: contentHash16(level.data),
    tiled: level.tiled === true,
  };
}

export function buildManifest(args: {
  imageId: string;
  master: MasterInfo;
  orientation: Orientation;
  width: number;
  height: number;
  levels: LevelEntry[];
  proxy?: boolean;
}): Manifest {
  const levels = [...args.levels].sort((a, b) => a.w * a.h - b.w * b.h);
  const manifest: Manifest = {
    schema: 1,
    imageId: args.imageId,
    master: args.master,
    orientation: args.orientation,
    width: args.width,
    height: args.height,
    aspect: round4(args.width / args.height),
    levels,
  };
  if (args.proxy) manifest.proxy = true;
  return manifest;
}

export function buildIndexEntry(manifest: Manifest): IndexEntry {
  const l0 = manifest.levels[0];
  if (!l0) throw new Error(`manifest ${manifest.imageId} has no levels`);
  return {
    imageId: manifest.imageId,
    aspect: manifest.aspect,
    l0: { contenthash: l0.contenthash, w: l0.w, h: l0.h },
  };
}

export function isUpToDate(existing: Manifest, mtimeMs: number): boolean {
  return existing.proxy !== true && Math.round(existing.master.mtimeMs) === Math.round(mtimeMs);
}