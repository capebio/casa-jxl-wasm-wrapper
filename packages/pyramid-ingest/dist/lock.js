import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { hostname } from "node:os";
const LOCK_FILE = ".pyramid-ingest.lock";
const READ_LOCK_PREFIX = ".pyramid-ingest.lock.read.";
const STALE_MS = 24 * 60 * 60 * 1000; // 24h
async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
async function isPidAlive(pid) {
    try {
        // 0 signal just checks existence (throws ESRCH/EPERM if gone)
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
async function readLockFile(p) {
    try {
        const txt = await readFile(p, "utf8");
        return JSON.parse(txt);
    }
    catch {
        return null;
    }
}
// LOCK-2: a lock is stale if older than STALE_MS, or (same host only) its pid is gone.
// Cross-host locks can't be liveness-checked, so they rely on age alone.
async function isLockStale(lock) {
    if (Date.now() - lock.createdAt > STALE_MS)
        return true;
    if (lock.host && lock.host !== hostname())
        return false;
    return !(await isPidAlive(lock.pid));
}
// LOCK-1/LOCK-3: a writer must drain live readers before proceeding. Read locks live beside the write
// lock as `${basename(writeLockPath)}.read.*`. Stale read locks (dead pid / aged out) are pruned here.
async function waitForReadLocksToClear(writeLockPath, deadline, label) {
    const dir = dirname(writeLockPath);
    const rlPrefix = `${basename(writeLockPath)}.read.`;
    for (;;) {
        let entries;
        try {
            entries = await readdir(dir);
        }
        catch {
            return;
        } // dir gone → no readers
        let live = 0;
        for (const e of entries) {
            if (!e.startsWith(rlPrefix))
                continue;
            const full = join(dir, e);
            const lf = await readLockFile(full);
            if (!lf)
                continue; // unreadable / mid-write — ignore this pass
            if (await isLockStale(lf))
                await unlink(full).catch(() => { }); // prune (LOCK-3)
            else
                live++;
        }
        if (live === 0)
            return;
        if (Date.now() > deadline)
            throw new Error(`acquireWriteLock timeout: ${live} read lock(s) held for ${label}`);
        await sleep(50 + Math.random() * 50);
    }
}
// ebusy retry (mirrors checkpoint.ts for FS contention on network volumes)
async function withEbusyRetry(op, label = "fs-op", attempts = 3, delayMs = 50) {
    let last;
    for (let i = 0; i < attempts; i++) {
        try {
            return await op();
        }
        catch (e) {
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
async function acquireWriteLockFile(lockPath, timeoutMs, label) {
    await mkdir(dirname(lockPath), { recursive: true });
    const start = Date.now();
    for (;;) {
        const now = Date.now();
        const data = { kind: "write", pid: process.pid, host: hostname(), createdAt: now };
        try {
            await withEbusyRetry(() => writeFile(lockPath, JSON.stringify(data), { flag: "wx" }), "wx-write-lock");
            // The write-lock file now blocks NEW readers; LOCK-1: also drain readers already holding.
            // On timeout, release our write lock (we couldn't get exclusivity) and propagate.
            try {
                await waitForReadLocksToClear(lockPath, start + timeoutMs, label);
            }
            catch (e) {
                await unlink(lockPath).catch(() => { });
                throw e;
            }
            return { async release() { await unlink(lockPath).catch(() => { }); } };
        }
        catch (e) {
            if (e && e.code !== "EEXIST")
                throw e; // includes the drain-timeout above → propagate out
        }
        const existing = await readLockFile(lockPath);
        if (existing && (await isLockStale(existing))) {
            await withEbusyRetry(() => unlink(lockPath), "steal-stale").catch(() => { });
            continue;
        }
        if (Date.now() - start > timeoutMs)
            throw new Error(`acquireWriteLock timeout after ${timeoutMs}ms for ${label}`);
        await sleep(50 + Math.random() * 50);
    }
}
async function acquireReadLockFile(writeLockPath, readLockPath, timeoutMs, label) {
    await mkdir(dirname(writeLockPath), { recursive: true });
    const start = Date.now();
    for (;;) {
        // 1. if a live writer holds the write lock, wait for it.
        const write = await readLockFile(writeLockPath);
        if (write && write.kind === "write" && !(await isLockStale(write))) {
            if (Date.now() - start > timeoutMs)
                throw new Error(`acquireReadLock timeout (write held) ${label}`);
            await sleep(50);
            continue;
        }
        // 2. optimistically claim our (unique) read lock.
        const data = { kind: "read", pid: process.pid, host: hostname(), createdAt: Date.now() };
        try {
            await withEbusyRetry(() => writeFile(readLockPath, JSON.stringify(data), { flag: "wx" }), "wx-read-lock");
        }
        catch (e) {
            if (e && e.code !== "EEXIST")
                throw e;
            if (Date.now() - start > timeoutMs)
                throw new Error(`acquireReadLock timeout after ${timeoutMs}ms for ${label}`);
            await sleep(20);
            continue;
        }
        // 3. re-check: if a writer raced in between (1) and (2), yield to it (LOCK-1 symmetry).
        const write2 = await readLockFile(writeLockPath);
        if (write2 && write2.kind === "write" && !(await isLockStale(write2))) {
            await unlink(readLockPath).catch(() => { });
            if (Date.now() - start > timeoutMs)
                throw new Error(`acquireReadLock timeout (write raced) ${label}`);
            await sleep(50);
            continue;
        }
        return { async release() { await unlink(readLockPath).catch(() => { }); } };
    }
}
// old writeLockFileAtomic removed (dead: never called by acquires; used weaker non-rename update vs checkpoint rename+ebusy)
async function acquireWriteLock(outDir, timeoutMs = 30000) {
    const lockPath = join(outDir, LOCK_FILE);
    return acquireWriteLockFile(lockPath, timeoutMs, outDir);
}
async function acquireReadLock(outDir, timeoutMs = 30000) {
    const lockPath = join(outDir, LOCK_FILE);
    const readLockPath = join(outDir, `${READ_LOCK_PREFIX}${process.pid}.${Math.random().toString(36).slice(2)}`);
    return acquireReadLockFile(lockPath, readLockPath, timeoutMs, outDir);
}
export { acquireWriteLock, acquireReadLock };
/** Full L3 per-image: write lock for mutate on specific image (rm, targeted migrate). Uses images/<id>/.lock */
export async function acquireImageWriteLock(outDir, imageId, timeoutMs = 30000) {
    const lockPath = join(outDir, "images", imageId, ".lock");
    return acquireWriteLockFile(lockPath, timeoutMs, imageId);
}
/** Full L3 per-image read (for targeted validate on image). */
export async function acquireImageReadLock(outDir, imageId, timeoutMs = 30000) {
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
//# sourceMappingURL=lock.js.map