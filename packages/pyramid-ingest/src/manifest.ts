import { contentHash16 } from "./hash.js";
import type { MasterFormat, Orientation, PyramidLevelBytes } from "./backends.js";
import { makeProducedBy, manifestSchema, manifestSchemaV1 } from "./schema.js";
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
    ...(level.qualityCurve && level.qualityCurve.length > 0 ? { qualityCurve: level.qualityCurve } : {}),
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
    schema: 2 as const,  // V3 Phase2 (discrim + compat; v1 still readable)
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
  return manifestSchema.parse(base) as any;  // V3 union (accepts 1 or 2); emitted schema:2 now
}

export function buildIndexEntry(manifest: Manifest): IndexEntry {
  const l0 = manifest.levels?.[0];
  if (!l0) throw new Error(`manifest ${manifest.imageId} has no levels`);
  // aspect is optional on v1 manifests; the index schema requires it, so fail loudly here
  // (previously undefined would flow through and fail galleryIndexSchema.parse later).
  if (manifest.aspect == null) throw new Error(`manifest ${manifest.imageId} has no aspect`);
  return {
    imageId: manifest.imageId,
    aspect: manifest.aspect,
    l0: { contenthash: l0.contenthash, w: l0.w, h: l0.h },
  };
}

export function isUpToDate(existing: Manifest, mtimeMs: number, proxy = false): boolean {
  // mtime exact match (low-mtime-rounding): drop rounding for determinism; fs mtimes are comparable at ms.
  // P7: proxy flag match for skip (when caller requests proxy, only proxy manifests count as uptodate)
  const proxyOk = proxy ? existing.proxy === true : existing.proxy !== true;
  return proxyOk && existing.master.mtimeMs === mtimeMs;
}