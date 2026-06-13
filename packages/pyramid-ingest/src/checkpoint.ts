import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// F2 (WU-6): checkpoint for --resume crash recovery.
// Exact shape per HANDOFF plan. Atomic write via tmp+rename + ebusy (mirrors ingest.ts pattern).
// Cleared on clean exit. Main coordinator persists; workers see opts.

export interface CheckpointState {
  version: "1";               // schema for resume forward-compat
  batchId: string;            // UUID per invocation
  startedAt: number;
  inFlight: string[];         // master paths currently being processed
  completed: { path: string; outcome: "written" | "skipped"; stagedBytes?: number; durationMs?: number }[];
  failed: { path: string; error: string; code?: string }[];
}

const CHECKPOINT_FILE = ".pyramid-ingest.checkpoint.json";

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

async function writeFileAtomic(dest: string, data: string): Promise<void> {
  const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await withEbusyRetry(() => writeFile(tmp, data), "write-tmp");
  try {
    await withEbusyRetry(() => rename(tmp, dest), "rename-atomic");
    // durability for crash recovery on cluster FS / power loss (win32 rename often sufficient)
    if (process.platform !== "win32") {
      try {
        const fd = await open(dest, "r");
        await fd.sync();
        await fd.close();
      } catch {}
    }
  } catch (e: any) {
    if (e && e.code === "EEXIST") {
      await unlink(tmp).catch(() => {});
      return;
    }
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

export async function readCheckpoint(outDir: string): Promise<CheckpointState | null> {
  const p = join(outDir, CHECKPOINT_FILE);
  try {
    const txt = await readFile(p, "utf8");
    return JSON.parse(txt) as CheckpointState;
  } catch {
    return null;
  }
}

export async function writeCheckpoint(outDir: string, state: CheckpointState): Promise<void> {
  const p = join(outDir, CHECKPOINT_FILE);
  await writeFileAtomic(p, JSON.stringify(state)); // compact: I/O + disk win for large batches; machine file
}

export async function clearCheckpoint(outDir: string): Promise<void> {
  const p = join(outDir, CHECKPOINT_FILE);
  await withEbusyRetry(() => unlink(p), "clear-checkpoint").catch(() => {});
}