import { access, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { contentHash16, imageIdForPath } from "./hash.js";
import { buildJpgLadder, buildProxyLadder, buildRawLadder, type LadderResult } from "./ladder.js";
import {
  buildIndexEntry, buildManifest, isUpToDate, toEntry,
  type GalleryIndex, type LevelEntry, type Manifest,
} from "./manifest.js";

import { parseManifest } from "./schema.js";
import type { Clock, DecodedMaster, JxlBackend, MasterFormat, Orientation, RawBackend, RawFormat, Telemetry } from "./backends.js";

export interface Backends {
  raw: RawBackend;
  jxl: JxlBackend;
  signal?: AbortSignal;
  telemetry?: Telemetry;
  clock?: Clock;
}

export interface IngestOptions {
  outDir: string;
  proxy?: number;
  force?: boolean;
  verifyHash?: boolean;
}

export type IngestOutcome = "written" | "skipped";

export interface BatchResult {
  written: number;
  skipped: number;
  failed: { path: string; error: Error | string }[];
}

export interface IngestPlan {
  imageId: string;
  master: { name: string; format: MasterFormat; mtimeMs: number };
  orientation: Orientation;
  width: number;
  height: number;
  levels: Array<{ data: Uint8Array; width: number; height: number; bitsPerSample?: 8 | 16; tiled?: boolean }>;
  proxy: boolean;
  manifest: Manifest;
}

const RAW_EXT: Record<string, RawFormat> = { ".orf": "orf", ".dng": "dng", ".cr2": "cr2" };

const MAX_MASTER_BYTES = 512 * 1024 * 1024; // high-master-size-unbounded guard

// low-no-retry-on-ebusy + high-atomic-writes: Windows AV/locker EBUSY retry (3x 50ms).
// Used for tmp writes + renames to guarantee durability without partials on target.
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function withEbusyRetry<T>(op: () => Promise<T>, label = "fs-op", attempts = 3, delayMs = 50): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (e: any) {
      last = e;
      const code = e && (e.code || e.errno);
      if ((code === "EBUSY" || code === "EAGAIN" || code === "EPERM") && i < attempts - 1) {
        await sleep(delayMs);
        continue;
      }
      throw e;
    }
  }
  throw last;
}

// atomic tmp writer helper (unique per pid/rand to avoid collision under concurrency).
async function writeFileAtomic(dest: string, data: Uint8Array): Promise<void> {
  const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await withEbusyRetry(() => writeFile(tmp, data), "write-tmp");
  try {
    await withEbusyRetry(() => rename(tmp, dest), "rename-atomic");
  } catch (e: any) {
    if (e && e.code === "EEXIST") {
      // duplicate content-addressed writer won the race (idempotent); safe to drop our tmp
      await unlink(tmp).catch(() => {});
      return;
    }
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

export function formatFromPath(p: string): MasterFormat | null {
  const lower = p.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = lower.slice(dot);
  const raw = RAW_EXT[ext];
  if (raw) return raw;
  if (ext === ".jpg" || ext === ".jpeg") return "jpg";
  return null;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch (err: any) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

async function decodeMaster(b: Backends, format: MasterFormat, bytes: Uint8Array): Promise<DecodedMaster> {
  // v1 design boundary (pyramid-gallery-design §8, §11; PyramidAgentHandoff §3, §8):
  // - Full master is decoded into RAM to drive the downscale cascade for grid levels.
  // - Target: masters that fit RAM once (rough ~150-200 MP practical).
  // - Long-edge >~8000 px or >~40 MP → "massive scan": top-level full becomes JXTC tiled container (rgba8 in v1).
  // - True gigapixel source-tiled ingest (streaming decode of master without full buffer) is deferred (Phase 4/5).
  // - No attempt to implement sliding-window / block RAW decode here.
  if (format === "jpg") {
    const fullJxl = await b.jxl.transcodeJpeg(bytes);
    const d = await b.jxl.decodeToRgba8(fullJxl);
    return { rgba: d.rgba, width: d.width, height: d.height, orientation: "source" };
  }
  return b.raw.decode(bytes, format);
}

export async function writeLevelFiles(
  outDir: string,
  levels: LadderResult["levels"],
  masterW: number,
  masterH: number,
  verifyHash = false,
): Promise<LevelEntry[]> {
  const levelsDir = join(outDir, "levels");
  await mkdir(levelsDir, { recursive: true });
  const entries: LevelEntry[] = [];
  for (const level of levels) {
    const entry = toEntry(level, masterW, masterH);
    const dest = join(levelsDir, `${entry.contenthash}.jxl`);
    let needWrite = true;
    if (await fileExists(dest)) {
      if (!verifyHash) {
        needWrite = false;
      } else {
        const onDisk = await readFile(dest);
        if (contentHash16(onDisk) === entry.contenthash) {
          needWrite = false;
        }
        // else: bad/truncated content; fallthrough to atomic overwrite
      }
    }
    if (needWrite) {
      await writeFileAtomic(dest, level.data);
    }
    entries.push(entry);
  }
  return entries;
}

export async function computeIngestPlan(
  bytes: Uint8Array,
  format: MasterFormat,
  backends: Backends,
  identity: { imageId: string; masterName: string; mtimeMs: number },
  opts: IngestOptions,
): Promise<IngestPlan> {
  const b = backends;
  const tel = b.telemetry;
  tel?.stage("compute-plan-start", { imageId: identity.imageId, format, proxy: opts.proxy !== undefined });

  let ladder: LadderResult;
  if (opts.proxy !== undefined) {
    const decoded = await decodeMaster(b, format, bytes);
    tel?.stage("decode-master", { w: decoded.width, h: decoded.height });
    ladder = await buildProxyLadder(
      b.jxl, decoded.rgba, decoded.width, decoded.height, opts.proxy, decoded.orientation,
    );
  } else if (format === "jpg") {
    ladder = await buildJpgLadder(b.jxl, bytes);
  } else {
    const decoded = await b.raw.decode(bytes, format);
    tel?.stage("decode-master", { w: decoded.width, h: decoded.height });
    ladder = await buildRawLadder(b.jxl, decoded);
  }

  tel?.stage("ladder-built", { levels: ladder.levels.length, w: ladder.width, h: ladder.height });

  const entries = ladder.levels.map((lv) => toEntry(lv, ladder.width, ladder.height));
  const manifest = buildManifest({
    imageId: identity.imageId,
    master: { name: identity.masterName, format, mtimeMs: identity.mtimeMs },
    orientation: ladder.orientation,
    width: ladder.width,
    height: ladder.height,
    levels: entries,
    proxy: opts.proxy !== undefined,
  });

  tel?.stage("manifest-built", { levels: entries.length });

  return {
    imageId: identity.imageId,
    master: { name: identity.masterName, format, mtimeMs: identity.mtimeMs },
    orientation: ladder.orientation,
    width: ladder.width,
    height: ladder.height,
    levels: ladder.levels,
    proxy: opts.proxy !== undefined,
    manifest,
  };
}

export async function applyIngestPlan(
  plan: IngestPlan,
  backends: Backends,
  opts: IngestOptions,
): Promise<IngestOutcome> {
  const outDir = opts.outDir;
  const imageDir = join(outDir, "images", plan.imageId);
  const manifestPath = join(imageDir, "manifest.json");

  // med-manifesttmp-orphan + B2: clear stale tmp
  await unlink(manifestPath + ".tmp").catch(() => {});

  // write levels (idempotent per contenthash)
  await writeLevelFiles(outDir, plan.levels, plan.width, plan.height, !!opts.verifyHash);

  // write manifest atomically (with EBUSY retry for Windows durability)
  await mkdir(imageDir, { recursive: true });
  const manifestTmp = `${manifestPath}.tmp`;
  try {
    await withEbusyRetry(() => writeFile(manifestTmp, JSON.stringify(plan.manifest, null, 2)), "manifest-tmp");
    await withEbusyRetry(() => rename(manifestTmp, manifestPath), "manifest-rename");
  } catch (e) {
    await unlink(manifestTmp).catch(() => {});
    throw e;
  }
  return "written";
}

export async function ingestImage(
  masterPath: string,
  backends: Backends,
  opts: IngestOptions & { dryRun?: boolean; timeoutMs?: number },
): Promise<IngestOutcome> {
  const format = formatFromPath(masterPath);
  if (!format) throw new Error(`unsupported master format: ${masterPath}`);

  const imageId = imageIdForPath(masterPath);
  const info = await stat(masterPath);
  if (info.size > MAX_MASTER_BYTES) {
    throw new Error(`master too large: ${info.size} bytes (>${MAX_MASTER_BYTES})`);
  }
  const imageDir = join(opts.outDir, "images", imageId);
  const manifestPath = join(imageDir, "manifest.json");

  // med-manifesttmp-orphan + B2: clear stale tmp from prior crash before any check/write
  await unlink(manifestPath + ".tmp").catch(() => {});

  if (!opts.force && opts.proxy === undefined && (await fileExists(manifestPath))) {
    const existing = parseManifest(await readFile(manifestPath, "utf8"));
    if (isUpToDate(existing, info.mtimeMs)) return "skipped";
  }

  const bytes = await readFile(masterPath); // Buffer satisfies Uint8Array; avoids copy (low-readfile)

  const identity = { imageId, masterName: basename(masterPath), mtimeMs: info.mtimeMs };
  const plan = await computeIngestPlan(bytes, format, backends, identity, opts);

  if (opts.dryRun) {
    // F7: bypass apply; caller (CLI) prints plan
    return "written";
  }

  const execP = applyIngestPlan(plan, backends, opts);
  const timeout = opts.timeoutMs;
  if (timeout && timeout > 0) {
    const t = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`ingest timeout after ${timeout}ms for ${masterPath}`)), timeout));
    await Promise.race([execP, t]);
  } else {
    await execP;
  }
  return "written";
}

export async function ingestBatch(
  files: readonly string[],
  backends: Backends,
  opts: IngestOptions & { concurrency?: number; dryRun?: boolean; timeoutMs?: number },
): Promise<BatchResult> {
  const result: BatchResult = { written: 0, skipped: 0, failed: [] };
  const workers = Math.max(1, Math.min(opts.concurrency ?? 1, files.length || 1));
  let next = 0;
  const tel = backends.telemetry;
  const total = files.length;
  const run = async (): Promise<void> => {
    for (;;) {
      if (backends.signal?.aborted) return;
      const idx = next++;
      if (idx >= files.length) return;
      const path = files[idx]!;
      tel?.progress(idx + 1, total, path);
      try {
        const outcome = await ingestImage(path, backends, opts);
        if (outcome === "written") result.written++;
        else result.skipped++;
      } catch (err) {
        // O5: store full Error (not .message) so CLI -v can emit stack
        result.failed.push({ path, error: err instanceof Error ? err : String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, () => run()));
  return result;
}

export async function rebuildIndex(outDir: string): Promise<GalleryIndex> {
  const imagesDir = join(outDir, "images");
  const index: GalleryIndex = { schema: 1, images: [] };
  let imageIds: string[];
  try {
    imageIds = await readdir(imagesDir);
  } catch {
    imageIds = [];
  }
  for (const id of imageIds) {
    const manifestPath = join(imagesDir, id, "manifest.json");
    if (!(await fileExists(manifestPath))) continue;
    let manifest: Manifest;
    try {
      manifest = parseManifest(await readFile(manifestPath, "utf8"));
    } catch (err) {
      process.stderr.write(
        `warning: skipping unreadable manifest ${manifestPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }
    if (manifest.proxy) continue;
    index.images.push(buildIndexEntry(manifest));
  }
  // INVARIANT (D3): index order deterministic across readdir / fs. Do not remove this sort.
  index.images.sort((a, b) => (a.imageId < b.imageId ? -1 : a.imageId > b.imageId ? 1 : 0));

  // high-atomic-writes + B9: tmp + rename for index.json (reader never sees partial/truncated JSON)
  const indexPath = join(outDir, "index.json");
  const tmp = `${indexPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await withEbusyRetry(() => writeFile(tmp, JSON.stringify(index, null, 2)), "write-index-tmp");
  await withEbusyRetry(() => rename(tmp, indexPath), "rename-index");
  return index;
}