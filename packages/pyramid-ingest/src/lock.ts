import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// WU-6 / Phase 2 L1-L3: advisory (cooperative) lock for multi-process safety on --out.
// Write locks for ingest/gc/rm/migrate. Read locks for validate/explain.
// Stale detection: dead pid or >24h. wx atomic create. Backoff on contention.
// See HANDOFF-jxl-level3-implementation-plan.md L1/L2/L3 + B1/F1/F5/F6.

export interface AdvisoryLock {
  release(): Promise<void>;
}

interface LockFile {
  kind: "write" | "read";
  pid: number;
  createdAt: number;
}

const LOCK_FILE = ".pyramid-ingest.lock";
const READ_LOCK_PREFIX = ".pyramid-ingest.lock.read.";
const STALE_MS = 24 * 60 * 60 * 1000; // 24h

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function isPidAlive(pid: number): Promise<boolean> {
  try {
    // 0 signal just checks existence (throws ESRCH/EPERM if gone)
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLockFile(p: string): Promise<LockFile | null> {
  try {
    const txt = await readFile(p, "utf8");
    return JSON.parse(txt) as LockFile;
  } catch {
    return null;
  }
}

// ebusy retry (mirrors checkpoint.ts for FS contention on network volumes)
async function withEbusyRetry<T>(op: () => Promise<T>, label = "fs-op", attempts = 3, delayMs = 50): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await op(); } catch (e: any) {
      last = e;
      const code = e && (e.code || e.errno);
      if ((code === "EBUSY" || code === "EAGAIN" || code === "EPERM") && i < attempts - 1) {
        await sleep(delayMs); continue;
      }
      throw e;
    }
  }
  throw last;
}

async function acquireWriteLockFile(lockPath: string, timeoutMs: number, label: string): Promise<AdvisoryLock> {
  await mkdir(dirname(lockPath), { recursive: true });
  const start = Date.now();
  for (;;) {
    const now = Date.now();
    const data: LockFile = { kind: "write", pid: process.pid, createdAt: now };
    try {
      await withEbusyRetry(() => writeFile(lockPath, JSON.stringify(data), { flag: "wx" }), "wx-write-lock");
      return { async release() { await unlink(lockPath).catch(() => {}); } };
    } catch (e: any) {
      if (e && e.code !== "EEXIST") throw e;
    }
    const existing = await readLockFile(lockPath);
    if (existing) {
      const age = Date.now() - existing.createdAt;
      const alive = await isPidAlive(existing.pid);
      if (!alive || age > STALE_MS) {
        await withEbusyRetry(() => unlink(lockPath), "steal-stale").catch(() => {});
        continue;
      }
    }
    if (Date.now() - start > timeoutMs) throw new Error(`acquireWriteLock timeout after ${timeoutMs}ms for ${label}`);
    await sleep(50 + Math.random() * 50);
  }
}

async function acquireReadLockFile(writeLockPath: string, readLockPath: string, timeoutMs: number, label: string): Promise<AdvisoryLock> {
  await mkdir(dirname(writeLockPath), { recursive: true });
  const start = Date.now();
  for (;;) {
    const write = await readLockFile(writeLockPath);
    if (write && write.kind === "write") {
      const age = Date.now() - write.createdAt;
      const alive = await isPidAlive(write.pid);
      if (alive && age <= STALE_MS) {
        if (Date.now() - start > timeoutMs) throw new Error(`acquireReadLock timeout (write held) ${label}`);
        await sleep(50); continue;
      }
    }
    const now = Date.now();
    try {
      await withEbusyRetry(() => writeFile(readLockPath, JSON.stringify({ kind: "read", pid: process.pid, createdAt: now }), { flag: "wx" }), "wx-read-lock");
      return { async release() { await unlink(readLockPath).catch(() => {}); } };
    } catch (e: any) {
      if (e && e.code !== "EEXIST") throw e;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`acquireReadLock timeout after ${timeoutMs}ms for ${label}`);
    await sleep(20);
  }
}

// old writeLockFileAtomic removed (dead: never called by acquires; used weaker non-rename update vs checkpoint rename+ebusy)

async function acquireWriteLock(outDir: string, timeoutMs = 30000): Promise<AdvisoryLock> {
  const lockPath = join(outDir, LOCK_FILE);
  return acquireWriteLockFile(lockPath, timeoutMs, outDir);
}

async function acquireReadLock(outDir: string, timeoutMs = 30000): Promise<AdvisoryLock> {
  const lockPath = join(outDir, LOCK_FILE);
  const readLockPath = join(outDir, `${READ_LOCK_PREFIX}${process.pid}.${Math.random().toString(36).slice(2)}`);
  return acquireReadLockFile(lockPath, readLockPath, timeoutMs, outDir);
}

export { acquireWriteLock, acquireReadLock };

/** Full L3 per-image: write lock for mutate on specific image (rm, targeted migrate). Uses images/<id>/.lock */
export async function acquireImageWriteLock(outDir: string, imageId: string, timeoutMs = 30000): Promise<AdvisoryLock> {
  const lockPath = join(outDir, "images", imageId, ".lock");
  return acquireWriteLockFile(lockPath, timeoutMs, imageId);
}

/** Full L3 per-image read (for targeted validate on image). */
export async function acquireImageReadLock(outDir: string, imageId: string, timeoutMs = 30000): Promise<AdvisoryLock> {
  const writeLockPath = join(outDir, "images", imageId, ".lock");
  const readLockPath = join(outDir, "images", imageId, `.lock.read.${process.pid}.${Math.random().toString(36).slice(2)}`);
  return acquireReadLockFile(writeLockPath, readLockPath, timeoutMs, imageId);
}

// L3 granularity (applied at call sites):
// - write lock: ingest batch, gc, rm, migrate (exclusive mutate on gallery)
// - read lock: validate, explain (shared query)
// Full L3 unlocked: per-image write/read locks (for targeted rm/validate on subset while other work; co-located in images/<id>/.lock )
// Multiple reads coexist; write waits for reads to release + blocks new reads.
// Advisory: cooperative processes only. Stale detection handles crashes.
// Use acquireImage* for finer concurrent safety on individual images (M/I/K/C/T ops).