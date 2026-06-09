import { contentHash16 } from "./hash.js";
import type { MasterFormat, Orientation, PyramidLevelBytes } from "./backends.js";
import { makeProducedBy, manifestSchemaV1 } from "./schema.js";
import type {
  Manifest,
  IndexEntry,
  GalleryIndex,
  LevelEntry,
  LevelSize,
  MasterInfo,
} from "./schema.js";

export type {
  Manifest,
  IndexEntry,
  GalleryIndex,
  LevelEntry,
  LevelSize,
  MasterInfo,
} from "./schema.js";

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
    ...(level.convergedByteEnd != null ? { convergedByteEnd: level.convergedByteEnd } : {}),
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
  const base = {
    schema: 1 as const,
    imageId: args.imageId,
    master: args.master,
    orientation: args.orientation,
    width: args.width,
    height: args.height,
    aspect: round4(args.width / args.height),
    levels,
    producedBy: makeProducedBy(),
    ...(args.proxy ? { proxy: true as const } : {}),
  };
  return manifestSchemaV1.parse(base);
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
  // mtime exact match (low-mtime-rounding): drop rounding for determinism; fs mtimes are comparable at ms.
  return existing.proxy !== true && existing.master.mtimeMs === mtimeMs;
}