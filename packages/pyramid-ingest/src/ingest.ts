import { access, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { contentHash16, imageIdForPath } from "./hash.js";
import { buildJpgLadder, buildProxyLadder, buildRawLadder, type LadderResult } from "./ladder.js";
import {
  buildIndexEntry, buildManifest, isUpToDate, toEntry,
  type GalleryIndex, type LevelEntry, type Manifest,
} from "./manifest.js";

import { detectFormatByMagic, makeProducedBy, parseManifest } from "./schema.js";
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
  acceptUnsupported?: boolean; // WU-5: default accept-degraded (Q2)
  profileConvergence?: boolean;
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
  levels: Array<{ data: Uint8Array; width: number; height: number; bitsPerSample?: 8 | 16; tiled?: boolean; convergedByteEnd?: number }>;
  proxy: boolean;
  manifest: Manifest;
}

// Extended for WU-5 adversarial: collect + format detect for common raw that may hit Tier 3/5.
const RAW_EXT: Record<string, string> = {
  ".orf": "orf", ".dng": "dng", ".cr2": "cr2",
  ".nef": "nef", ".arw": "arw", ".raf": "raf", ".rw2": "rw2", ".pef": "pef", ".srw": "srw", ".x3f": "x3f",
};

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

export function formatFromPath(p: string): string | null {
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

// WU-5 Tier3/5 helpers (dynamic exifr to avoid hard dep at load; ratified Q3 use exifr).
async function tryExtractEmbeddedJpeg(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    // dynamic so static module load succeeds even if exifr not yet installed in env
    const exifrMod: any = await import("exifr").catch(() => null);
    if (!exifrMod) return null;
    const exifr = exifrMod.default || exifrMod;
    // thumbnail() yields the embedded preview jpeg (medium/high res on many bodies)
    let cand: any = await exifr.thumbnail?.(bytes);
    if (cand) {
      const u8 = cand instanceof Uint8Array ? cand : new Uint8Array(cand);
      if (u8.length > 4096) return u8;
    }
    // fallback: parse for common preview tags
    const parsed: any = await exifr.parse?.(bytes, {
      tiff: true,
      ifd1: true,
      pick: ["Thumbnail", "PreviewImage", "JpgFromRaw", "JpegFromRaw"],
      translateKeys: false,
    }).catch(() => null);
    if (parsed) {
      cand = parsed.Thumbnail || parsed.PreviewImage || parsed.JpgFromRaw || parsed.JpegFromRaw;
      if (cand) {
        const u8 = cand instanceof Uint8Array ? cand : new Uint8Array(cand);
        if (u8.length > 4096) return u8;
      }
    }
  } catch {
    // exifr absent or corrupt file: fall to Tier5 stub
  }
  return null;
}

async function extractBasicMetadata(bytes: Uint8Array): Promise<Record<string, unknown>> {
  try {
    const exifrMod: any = await import("exifr").catch(() => null);
    if (!exifrMod) return {};
    const exifr = exifrMod.default || exifrMod;
    const m: any = await exifr.parse?.(bytes, { tiff: true, gps: false, xmp: false }).catch(() => null);
    if (!m) return {};
    return {
      make: m.Make,
      model: m.Model,
      iso: m.ISO,
      exposure: m.ExposureTime,
      fnumber: m.FNumber,
      focal: m.FocalLength,
    };
  } catch {
    return {};
  }
}

function isNativeRawFormat(f: string | null): f is RawFormat {
  return f === "orf" || f === "dng" || f === "cr2";
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
      b.jxl, decoded.rgba, decoded.width, decoded.height, opts.proxy, decoded.orientation, !!opts.profileConvergence,
    );
  } else if (format === "jpg") {
    ladder = await buildJpgLadder(b.jxl, bytes, !!opts.profileConvergence);
  } else {
    const decoded = await b.raw.decode(bytes, format);
    tel?.stage("decode-master", { w: decoded.width, h: decoded.height });
    ladder = await buildRawLadder(b.jxl, decoded, !!opts.profileConvergence);
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
  const accept = opts.acceptUnsupported !== false; // Q2 default accept-degraded

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
    const uptodate = isUpToDate(existing, info.mtimeMs) || (existing as any).stub === true && existing.master.mtimeMs === info.mtimeMs;
    if (uptodate) return "skipped";
  }

  const bytes = await readFile(masterPath); // Buffer satisfies Uint8Array; avoids copy (low-readfile)

  const identity = { imageId, masterName: basename(masterPath), mtimeMs: info.mtimeMs };

  let plan: IngestPlan | null = null;

  const nativeFmt = isNativeRawFormat(format) ? (format as RawFormat) : null;
  if (nativeFmt) {
    try {
      // Tier 1: native via raw-converter-wasm
      plan = await computeIngestPlan(bytes, nativeFmt, backends, identity, opts);
    } catch (err) {
      if (!accept) throw err;
      plan = await buildFallbackPlan(bytes, format, backends, identity, opts);
    }
  } else if (format === "jpg") {
    plan = await computeIngestPlan(bytes, "jpg", backends, identity, opts);
  } else if (accept) {
    // unknown ext or non-native raw: go straight to Tier3/5 (no native attempt)
    plan = await buildFallbackPlan(bytes, format, backends, identity, opts);
  } else {
    throw new Error(`unsupported master format: ${masterPath}`);
  }

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

// WU-5: Tier 3 (embedded JPEG via exifr) or Tier 5 (structured stub manifest, no index entry).
async function buildFallbackPlan(
  bytes: Uint8Array,
  format: string | null,
  backends: Backends,
  identity: { imageId: string; masterName: string; mtimeMs: number },
  opts: IngestOptions,
): Promise<IngestPlan> {
  const b = backends;
  const detected = format || detectFormatByMagic(bytes) || "unknown";

  // Tier 3
  const jpeg = await tryExtractEmbeddedJpeg(bytes);
  if (jpeg && jpeg.length > 0) {
    const ladder = await buildJpgLadder(b.jxl, jpeg, !!opts.profileConvergence); // reuse jpg path (transcode + pyramid, may tile)
    const entries = ladder.levels.map((lv) => toEntry(lv, ladder.width, ladder.height));
    const manifest = buildManifest({
      imageId: identity.imageId,
      master: { name: identity.masterName, format: detected as any, mtimeMs: identity.mtimeMs },
      orientation: ladder.orientation,
      width: ladder.width,
      height: ladder.height,
      levels: entries,
      proxy: opts.proxy !== undefined,
    });
    return {
      imageId: identity.imageId,
      master: { name: identity.masterName, format: detected as any, mtimeMs: identity.mtimeMs },
      orientation: ladder.orientation,
      width: ladder.width,
      height: ladder.height,
      levels: ladder.levels,
      proxy: opts.proxy !== undefined,
      manifest,
    };
  }

  // Tier 5: structured stub (Q1/Q5). Minimal dummy to satisfy v1 shape; excluded from index.
  const meta = await extractBasicMetadata(bytes);
  const stubBase = {
    schema: 1 as const,
    imageId: identity.imageId,
    master: { name: identity.masterName, format: detected as any, mtimeMs: identity.mtimeMs },
    orientation: "source" as const,
    width: 1,
    height: 1,
    aspect: 1,
    levels: [] as any[],
    stub: true as const,
    metadata: Object.keys(meta).length ? meta : undefined,
    producedBy: makeProducedBy(),
  };
  const manifest = parseManifest(JSON.stringify(stubBase));
  return {
    imageId: identity.imageId,
    master: { name: identity.masterName, format: detected as any, mtimeMs: identity.mtimeMs },
    orientation: "source",
    width: 1,
    height: 1,
    levels: [],
    proxy: false,
    manifest,
  };
}

export async function ingestBatch(
  files: readonly string[],
  backends: Backends,
  opts: IngestOptions & { concurrency?: number; dryRun?: boolean; timeoutMs?: number },
): Promise<BatchResult> {
  const result: BatchResult = { written: 0, skipped: 0, failed: [] };
  const tel = backends.telemetry;
  const total = files.length;
  const conc = Math.max(1, Math.min(opts.concurrency ?? 1, files.length || 1));

  // Test fakes (synthetic small bytes + patched jxl) must stay in-process; real workers create own backends + force simd.
  const useThreadPool = !(backends as any).__testInProcess;

  if (!useThreadPool) {
    // Legacy in-process (tests, fakes, deterministic). Uses injected backends.
    let next = 0;
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
          result.failed.push({ path, error: err instanceof Error ? err : String(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: conc }, () => run()));
    return result;
  }

  // WU-8: real multi-threaded worker pool. Main only coordinates; each worker does full ingest (decode+encode+fs).
  // Workers are created with forced 'simd' (see ingest-worker.ts). Exactly 1 core per active worker.
  const { Worker } = await import("node:worker_threads");
  const workers: InstanceType<typeof Worker>[] = [];
  const pending = new Map<number, { resolve: (o: IngestOutcome) => void; reject: (e: any) => void }>();
  let jobId = 0;
  let nextFile = 0;

  for (let i = 0; i < conc; i++) {
    const w = new Worker(new URL("./ingest-worker.ts", import.meta.url), { type: "module" });
    w.on("message", (m: any) => {
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        m.ok ? p.resolve(m.outcome) : p.reject(m.error);
      }
    });
    w.on("error", (e) => {
      // surface hard worker crash to current pending if any; others will see on next
      for (const [, p] of pending) p.reject(e);
      pending.clear();
    });
    workers.push(w);
  }

  const dispatchers: Promise<void>[] = [];
  for (let wi = 0; wi < conc; wi++) {
    const w = workers[wi]!;
    const runOne = async () => {
      for (;;) {
        if (backends.signal?.aborted) break;
        const idx = nextFile++;
        if (idx >= files.length) break;
        const path = files[idx]!;
        tel?.progress(idx + 1, total, path);
        const id = ++jobId;
        const p = new Promise<IngestOutcome>((resolve, reject) => pending.set(id, { resolve, reject }));
        w.postMessage({ id, path, opts });
        try {
          const outcome = await p;
          if (outcome === "written") result.written++;
          else result.skipped++;
        } catch (err) {
          result.failed.push({ path, error: err instanceof Error ? err : String(err) });
        }
      }
    };
    dispatchers.push(runOne());
  }

  await Promise.all(dispatchers);

  // cleanup
  await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
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
    if (manifest.proxy || (manifest as any).stub) continue; // Q5: stubs excluded from central index
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