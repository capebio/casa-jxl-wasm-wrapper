import { access, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { contentHash16, imageIdForPath } from "./hash.js";
import { buildJpgLadder, buildProxyLadder, buildRawLadder, type LadderResult } from "./ladder.js";
import {
  buildIndexEntry, buildManifest, isUpToDate, toEntry,
  type GalleryIndex, type LevelEntry, type Manifest,
} from "./manifest.js";

import { detectFormatByMagic, makeProducedBy, parseManifest } from "./schema.js";
import type { Clock, DecodedMaster, JxlBackend, MasterFormat, Orientation, RawBackend, RawFormat, Telemetry } from "./backends.js";
import { clearCheckpoint, readCheckpoint, writeCheckpoint, type CheckpointState } from "./checkpoint.js";
import { acquireImageWriteLock, type AdvisoryLock } from "./lock.js";

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
  resume?: boolean;  // F2 WU-6: --resume uses checkpoint to skip completed
  chaosTest?: boolean;  // K2: random failure injection for recovery tests
  statMap?: Record<string, { size: number; mtimeMs: number }>;  // C1: from upfront collect to avoid re-stat
}

export type IngestOutcome = "written" | "skipped";

export interface IngestResult {
  outcome: IngestOutcome;
  /** sum of stagedBytes across levels for this image (unlocked copy instrumentation; 0/undef for skipped) */
  stagedBytes?: number;
}

export interface BatchResult {
  written: number;
  skipped: number;
  failed: { path: string; error: Error | string }[];
  // unlocked per-image for runlog / O/M/I/K/C/T events (populated from cp)
  perImage?: Array<{ path: string; outcome: "written" | "skipped" | "failed"; error?: string; stagedBytes?: number }>;
  /** total pixel bytes staged into encoders across all written levels in this batch (unlocked copy instrumentation) */
  totalStagedBytes?: number;
}

export interface IngestPlan {
  imageId: string;
  master: { name: string; format: MasterFormat; mtimeMs: number };
  orientation: Orientation;
  width: number;
  height: number;
  levels: Array<{ data: Uint8Array; width: number; height: number; bitsPerSample?: 8 | 16; tiled?: boolean; convergedByteEnd?: number; stagedBytes?: number }>;
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

export async function fileExists(p: string): Promise<boolean> {
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
): Promise<IngestResult> {
  const format = formatFromPath(masterPath);
  const accept = opts.acceptUnsupported !== false; // Q2 default accept-degraded

  const imageId = await imageIdForPath(masterPath);
  let info: { size: number; mtimeMs: number };
  if (opts.statMap && opts.statMap[masterPath]) {
    info = opts.statMap[masterPath];
  } else {
    const s = await stat(masterPath);
    info = { size: s.size, mtimeMs: s.mtimeMs };
  }
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
    if (uptodate) return { outcome: "skipped" };
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
    return { outcome: "written" };
  }

  const execP = applyIngestPlan(plan, backends, opts);
  const timeout = opts.timeoutMs;
  if (timeout && timeout > 0) {
    const t = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`ingest timeout after ${timeout}ms for ${masterPath}`)), timeout));
    await Promise.race([execP, t]);
  } else {
    await execP;
  }
  const stagedBytes = (plan.levels || []).reduce((s: number, lv: any) => s + (lv.stagedBytes || 0), 0);

  // C2: persistent mtime/status cache update on write (for fast future resume/validate without re-stat)
  try {
    const cachePath = join(opts.outDir, ".pyramid-ingest.mtimecache.json");
    let c: Record<string, number> = {};
    try { c = JSON.parse(await readFile(cachePath, "utf8") || "{}"); } catch {}
    c[masterPath] = info.mtimeMs;
    const tmp = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(c));
    await rename(tmp, cachePath).catch(async (e: any) => { if (e && e.code === "EEXIST") await unlink(tmp).catch(()=>{}); else throw e; });
  } catch {}

  return { outcome: "written", stagedBytes: stagedBytes || undefined };
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
  opts: IngestOptions & { concurrency?: number; dryRun?: boolean; timeoutMs?: number; resume?: boolean },
): Promise<BatchResult> {
  const result: BatchResult = { written: 0, skipped: 0, failed: [] };
  const tel = backends.telemetry;
  let activeFiles = [...files];
  const total = activeFiles.length;
  const conc = Math.max(1, Math.min(opts.concurrency ?? 1, activeFiles.length || 1));

  // F2 resume: filter using checkpoint (completed + failed skipped; inFlight will be retried)
  let checkpoint: CheckpointState | null = null;
  if (opts.resume) {
    checkpoint = await readCheckpoint(opts.outDir);
    if (checkpoint) {
      const skip = new Set([...checkpoint.completed.map(c => c.path), ...checkpoint.failed.map(f => f.path)]);
      activeFiles = activeFiles.filter(p => !skip.has(p));
      // note: inFlight from prior will be retried by re-entering the loops
    }
  }
  const batchId = checkpoint?.batchId || randomUUID();
  const startedAt = checkpoint?.startedAt || Date.now();
  // local working state (merged with loaded on persist)
  const cpState: CheckpointState = checkpoint || { batchId, startedAt, inFlight: [], completed: [], failed: [] };

  async function persistCheckpoint() {
    // simple persist (plan suggests debounce ~1s; for correctness always write here)
    await writeCheckpoint(opts.outDir, cpState).catch(() => {});
  }

  // Test fakes (synthetic small bytes + patched jxl) must stay in-process; real workers create own backends + force simd.
  const useThreadPool = !(backends as any).__testInProcess;

  if (!useThreadPool) {
    // Legacy in-process (tests, fakes, deterministic). Uses injected backends.
    let next = 0;
    const run = async (): Promise<void> => {
      for (;;) {
        if (backends.signal?.aborted) return;
        const idx = next++;
        if (idx >= activeFiles.length) return;
        const path = activeFiles[idx]!;
        const imageId = await imageIdForPath(path);
        // full L3: acquire per-image write lock only for real mutate (skip in dry-run to avoid side-effect dirs; cross-proc for live runs)
        let imgLock: AdvisoryLock | null = null;
        if (!opts.dryRun) {
          try { imgLock = await acquireImageWriteLock(opts.outDir, imageId); } catch {}
        }
        // F2: track inFlight + persist before work
        if (!cpState.inFlight.includes(path)) cpState.inFlight.push(path);
        await persistCheckpoint();
        tel?.progress(idx + 1, total, path);
        if (opts.chaosTest && Math.random() < 0.25) {
          throw new Error("chaos-test injected failure (for K2 resume/GC recovery test)");
        }
        tel?.event?.("image-start", { path, imageId, idx: idx + 1, total });
        const t0 = Date.now();
        try {
          const res = await ingestImage(path, backends, opts);
          const outcome = res.outcome;
          const dur = Date.now() - t0;
          // move out of inFlight
          cpState.inFlight = cpState.inFlight.filter(p => p !== path);
          if (outcome === "written") {
            result.written++;
            cpState.completed.push({ path, outcome: "written", stagedBytes: res.stagedBytes, durationMs: dur });
          } else {
            result.skipped++;
            cpState.completed.push({ path, outcome: "skipped" });
          }
          tel?.event?.("image-end", { path, imageId, outcome, durationMs: dur });
          await persistCheckpoint();
        } catch (err) {
          const dur = Date.now() - t0;
          cpState.inFlight = cpState.inFlight.filter(p => p !== path);
          const msg = err instanceof Error ? err.message : String(err);
          cpState.failed.push({ path, error: msg });
          tel?.event?.("image-failed", { path, imageId, error: msg, durationMs: dur });
          await persistCheckpoint();
          result.failed.push({ path, error: err instanceof Error ? err : String(err) });
        } finally {
          await imgLock?.release().catch(() => {});
        }
      }
    };
    await Promise.all(Array.from({ length: conc }, () => run()));
    if (!opts.dryRun) await clearCheckpoint(opts.outDir).catch(() => {});
    result.perImage = [
      ...cpState.completed,
      ...cpState.failed.map(f => ({ path: f.path, outcome: "failed" as const, error: f.error })),
    ];
    const s = cpState.completed.reduce((sum: number, c: any) => sum + (c.stagedBytes || 0), 0);
    if (s > 0) (result as any).totalStagedBytes = s;
    return result;
  }

  // WU-8: real multi-threaded worker pool. Main only coordinates; each worker does full ingest (decode+encode+fs).
  // Workers are created with forced 'simd' (see ingest-worker.ts). Exactly 1 core per active worker.
  const { Worker } = await import("node:worker_threads");
  const workers: InstanceType<typeof Worker>[] = [];
  const pending = new Map<number, { resolve: (o: any) => void; reject: (e: any) => void }>();
  let jobId = 0;
  let nextFile = 0;

  for (let i = 0; i < conc; i++) {
    const w = new Worker(new URL("./ingest-worker.ts", import.meta.url), { type: "module" });
    w.on("message", (m: any) => {
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        if (m.ok) {
          p.resolve(m.stagedBytes !== undefined ? { outcome: m.outcome, stagedBytes: m.stagedBytes, durationMs: m.durationMs } : m.outcome);
        } else {
          p.reject(m.error);
        }
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
        if (idx >= activeFiles.length) break;
        const path = activeFiles[idx]!;
        const imageId = await imageIdForPath(path);
        // full L3: per-image write lock held for worker job duration only for real runs (dry-run avoids mkdir side effects)
        let imgLock: AdvisoryLock | null = null;
        if (!opts.dryRun) {
          try { imgLock = await acquireImageWriteLock(opts.outDir, imageId); } catch {}
        }
        // F2: inFlight + persist (main coordinator side for worker dispatch)
        if (!cpState.inFlight.includes(path)) cpState.inFlight.push(path);
        await persistCheckpoint();
        tel?.progress(idx + 1, total, path);
        if (opts.chaosTest && Math.random() < 0.25) {
          throw new Error("chaos-test injected failure (for K2 resume/GC recovery test)");
        }
        tel?.event?.("image-start", { path, imageId, idx: idx + 1, total });
        const id = ++jobId;
        const p = new Promise<IngestOutcome>((resolve, reject) => pending.set(id, { resolve, reject }));
        w.postMessage({ id, path, opts });
        const tJob = Date.now();
        try {
          const outcomeOrRes: any = await p;  // may be string (old) or IngestResult (new) with duration from inside worker (C/T)
          const outcome = typeof outcomeOrRes === "string" ? outcomeOrRes : outcomeOrRes.outcome;
          const staged = typeof outcomeOrRes === "string" ? undefined : outcomeOrRes.stagedBytes;
          const dur = typeof outcomeOrRes === "string" ? (Date.now() - tJob) : (outcomeOrRes.durationMs ?? (Date.now() - tJob));
          cpState.inFlight = cpState.inFlight.filter(pth => pth !== path);
          if (outcome === "written") {
            result.written++;
            cpState.completed.push({ path, outcome: "written", ...(staged ? {stagedBytes: staged} : {}), durationMs: dur });
          } else {
            result.skipped++;
            cpState.completed.push({ path, outcome: "skipped" });
          }
          tel?.event?.(outcome === "written" || outcome === "skipped" ? "image-end" : "image-failed", { path, imageId, outcome, durationMs: dur });
          await persistCheckpoint();
        } catch (err) {
          const dur = Date.now() - tJob;
          cpState.inFlight = cpState.inFlight.filter(pth => pth !== path);
          const msg = err instanceof Error ? err.message : String(err);
          cpState.failed.push({ path, error: msg });
          tel?.event?.("image-failed", { path, imageId, error: msg, durationMs: dur });
          await persistCheckpoint();
          result.failed.push({ path, error: err instanceof Error ? err : String(err) });
        } finally {
          await imgLock?.release().catch(() => {});
        }
      }
    };
    dispatchers.push(runOne());
  }

  await Promise.all(dispatchers);

  // cleanup
  await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
  if (!opts.dryRun) await clearCheckpoint(opts.outDir).catch(() => {});
  result.perImage = [
    ...cpState.completed,
    ...cpState.failed.map(f => ({ path: f.path, outcome: "failed" as const, error: f.error })),
  ];
  const s = cpState.completed.reduce((sum: number, c: any) => sum + (c.stagedBytes || 0), 0);
  if (s > 0) (result as any).totalStagedBytes = s;
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

// F1/B1 (WU-6): remove unreferenced level files + empty image dirs.
// Called by --gc. Conservative (scan manifests for refs). Returns what was removed.
// Dry-run reports without delete. Uses atomic unlinks where possible (best-effort).
export interface GcResult {
  removedLevelFiles: string[];
  removedImageDirs: string[];
}

export async function removeOrphans(outDir: string, opts: { dryRun?: boolean } = {}): Promise<GcResult> {
  const levelsDir = join(outDir, "levels");
  const imagesDir = join(outDir, "images");
  const removedLevelFiles: string[] = [];
  const removedImageDirs: string[] = [];

  // 1. collect all referenced contenthashes from manifests
  const referenced = new Set<string>();
  let ids: string[] = [];
  try { ids = await readdir(imagesDir); } catch { ids = []; }
  for (const id of ids) {
    const mp = join(imagesDir, id, "manifest.json");
    if (!(await fileExists(mp))) continue;
    try {
      const m = parseManifest(await readFile(mp, "utf8"));
      for (const lv of (m.levels || [])) {
        if (lv && lv.contenthash) referenced.add(lv.contenthash);
      }
    } catch { /* skip bad */ }
  }

  // 2. scan levels/ for orphans
  let levelFiles: string[] = [];
  try { levelFiles = await readdir(levelsDir); } catch { levelFiles = []; }
  for (const f of levelFiles) {
    if (!f.endsWith(".jxl")) continue;
    const h = f.replace(/\.jxl$/, "");
    if (!referenced.has(h)) {
      const full = join(levelsDir, f);
      if (!opts.dryRun) {
        await unlink(full).catch(() => {});
      }
      removedLevelFiles.push(f);
    }
  }

  // 3. empty image dirs (no manifest or empty)
  for (const id of ids) {
    const idDir = join(imagesDir, id);
    const mp = join(idDir, "manifest.json");
    const hasManifest = await fileExists(mp);
    if (!hasManifest) {
      // try remove dir (may have partials)
      try {
        if (!opts.dryRun) {
          // best effort recursive clean
          const entries = await readdir(idDir).catch(() => [] as string[]);
          for (const e of entries) await unlink(join(idDir, e)).catch(() => {});
          await (require("node:fs/promises").rmdir || unlink)(idDir).catch(() => {}); // node 14+ rmdir deprecated but simple
        }
        removedImageDirs.push(id);
      } catch {}
    }
  }

  return { removedLevelFiles, removedImageDirs };
}