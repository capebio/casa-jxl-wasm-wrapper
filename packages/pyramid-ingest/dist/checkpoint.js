import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
const CHECKPOINT_FILE = ".pyramid-ingest.checkpoint.json";
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
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
async function writeFileAtomic(dest, data) {
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
            }
            catch { }
        }
    }
    catch (e) {
        if (e && e.code === "EEXIST") {
            await unlink(tmp).catch(() => { });
            return;
        }
        await unlink(tmp).catch(() => { });
        throw e;
    }
}
export async function readCheckpoint(outDir) {
    const p = join(outDir, CHECKPOINT_FILE);
    try {
        const txt = await readFile(p, "utf8");
        return JSON.parse(txt);
    }
    catch {
        return null;
    }
}
export async function writeCheckpoint(outDir, state) {
    const p = join(outDir, CHECKPOINT_FILE);
    await writeFileAtomic(p, JSON.stringify(state)); // compact: I/O + disk win for large batches; machine file
}
export async function clearCheckpoint(outDir) {
    const p = join(outDir, CHECKPOINT_FILE);
    await withEbusyRetry(() => unlink(p), "clear-checkpoint").catch(() => { });
}
//# sourceMappingURL=checkpoint.js.map