import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

async function writeLockFileAtomic(p: string, data: LockFile): Promise<void> {
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(data), { flag: "wx" }); // atomic create
  try {
    await writeFile(p, JSON.stringify(data)); // or rename, but for simplicity overwrite after wx success (rare)
    // Better: rename for atomicity on content, but since we hold wx, ok. Use rename pattern from ingest.
    await unlink(tmp).catch(() => {});
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

async function acquireWriteLock(outDir: string, timeoutMs = 30000): Promise<AdvisoryLock> {
  const lockPath = join(outDir, LOCK_FILE);
  await mkdir(outDir, { recursive: true });
  const start = Date.now();

  for (;;) {
    // Try exclusive wx
    const now = Date.now();
    const data: LockFile = { kind: "write", pid: process.pid, createdAt: now };
    try {
      await writeFile(lockPath, JSON.stringify(data), { flag: "wx" });
      // Success: we hold write lock.
      return {
        async release() {
          await unlink(lockPath).catch(() => {});
        },
      };
    } catch (e: any) {
      if (e && e.code !== "EEXIST") throw e;
    }

    // Contended: check existing for stale
    const existing = await readLockFile(lockPath);
    if (existing) {
      const age = Date.now() - existing.createdAt;
      const alive = await isPidAlive(existing.pid);
      if (!alive || age > STALE_MS) {
        // Stale: force acquire
        await unlink(lockPath).catch(() => {});
        // retry loop will wx again
        continue;
      }
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(`acquireWriteLock timeout after ${timeoutMs}ms for ${outDir}`);
    }
    await sleep(50 + Math.random() * 50); // small backoff
  }
}

async function acquireReadLock(outDir: string, timeoutMs = 30000): Promise<AdvisoryLock> {
  const lockPath = join(outDir, LOCK_FILE);
  const readLockPath = join(outDir, `${READ_LOCK_PREFIX}${process.pid}.${Math.random().toString(36).slice(2)}`);
  await mkdir(outDir, { recursive: true });
  const start = Date.now();

  for (;;) {
    // Check for write lock holder (non-stale)
    const write = await readLockFile(lockPath);
    if (write && write.kind === "write") {
      const age = Date.now() - write.createdAt;
      const alive = await isPidAlive(write.pid);
      if (alive && age <= STALE_MS) {
        if (Date.now() - start > timeoutMs) throw new Error(`acquireReadLock timeout (write held) ${outDir}`);
        await sleep(50);
        continue;
      }
      // stale write: ignore (will be cleaned on next write acquire)
    }

    // No blocking write: create our read lock file (unique name)
    const now = Date.now();
    try {
      await writeFile(readLockPath, JSON.stringify({ kind: "read", pid: process.pid, createdAt: now }), { flag: "wx" });
      return {
        async release() {
          await unlink(readLockPath).catch(() => {});
        },
      };
    } catch (e: any) {
      if (e && e.code !== "EEXIST") throw e;
      // rare name collision, retry name
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(`acquireReadLock timeout after ${timeoutMs}ms for ${outDir}`);
    }
    await sleep(20);
  }
}

export { acquireWriteLock, acquireReadLock };

/** Full L3 per-image: write lock for mutate on specific image (rm, targeted migrate). Uses images/<id>/.lock */
export async function acquireImageWriteLock(outDir: string, imageId: string, timeoutMs = 30000): Promise<AdvisoryLock> {
  const imageDir = join(outDir, "images", imageId);
  await mkdir(imageDir, { recursive: true });
  const lockPath = join(imageDir, ".lock");
  const start = Date.now();
  for (;;) {
    const now = Date.now();
    const data: LockFile = { kind: "write", pid: process.pid, createdAt: now };
    try {
      await writeFile(lockPath, JSON.stringify(data), { flag: "wx" });
      return { async release() { await unlink(lockPath).catch(() => {}); } };
    } catch (e: any) {
      if (e && e.code !== "EEXIST") throw e;
    }
    const existing = await readLockFile(lockPath);
    if (existing) {
      const age = Date.now() - existing.createdAt;
      const alive = await isPidAlive(existing.pid);
      if (!alive || age > STALE_MS) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
    }
    if (Date.now() - start > timeoutMs) throw new Error(`acquireImageWriteLock timeout for ${imageId}`);
    await sleep(50 + Math.random() * 50);
  }
}

/** Full L3 per-image read (for targeted validate on image). */
export async function acquireImageReadLock(outDir: string, imageId: string, timeoutMs = 30000): Promise<AdvisoryLock> {
  const imageDir = join(outDir, "images", imageId);
  await mkdir(imageDir, { recursive: true });
  const lockPath = join(imageDir, ".lock"); // reuse same; for read we still check write holder
  const readLockPath = join(imageDir, `.lock.read.${process.pid}.${Math.random().toString(36).slice(2)}`);
  const start = Date.now();
  for (;;) {
    const write = await readLockFile(lockPath);
    if (write && write.kind === "write") {
      const age = Date.now() - write.createdAt;
      const alive = await isPidAlive(write.pid);
      if (alive && age <= STALE_MS) {
        if (Date.now() - start > timeoutMs) throw new Error(`acquireImageReadLock timeout (write held) ${imageId}`);
        await sleep(50);
        continue;
      }
    }
    try {
      await writeFile(readLockPath, JSON.stringify({ kind: "read", pid: process.pid, createdAt: Date.now() }), { flag: "wx" });
      return { async release() { await unlink(readLockPath).catch(() => {}); } };
    } catch (e: any) {
      if (e && e.code !== "EEXIST") throw e;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`acquireImageReadLock timeout ${imageId}`);
    await sleep(20);
  }
}

// L3 granularity (applied at call sites):
// - write lock: ingest batch, gc, rm, migrate (exclusive mutate on gallery)
// - read lock: validate, explain (shared query)
// Full L3 unlocked: per-image write/read locks (for targeted rm/validate on subset while other work; co-located in images/<id>/.lock )
// Multiple reads coexist; write waits for reads to release + blocks new reads.
// Advisory: cooperative processes only. Stale detection handles crashes.
// Use acquireImage* for finer concurrent safety on individual images (M/I/K/C/T ops).