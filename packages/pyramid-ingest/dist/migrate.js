import { readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest, makeProducedBy } from "./schema.js";
import { pMapLimit, readFileOrNull } from "./ingest.js";
import { acquireImageWriteLock } from "./lock.js";
async function atomicWriteJson(path, obj) {
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(obj, null, 2));
    await rename(tmp, path).catch(async (e) => {
        if (e && e.code === "EEXIST") {
            await unlink(tmp).catch(() => { });
        }
        else {
            throw e;
        }
    });
}
/** Shared manifest-migration walk (MIG-4): validate, preserve unknown fields via raw JSON,
 *  per-image write lock (skip on failure — never write unlocked), atomic write, bounded-parallel.
 *  `shouldMigrate`/`transform` operate on the RAW parsed JSON so fields zod would strip survive. */
async function migrateManifests(outDir, shouldMigrate, transform, opts) {
    const imagesDir = join(outDir, "images");
    const report = { migrated: 0, skipped: 0, errors: [] };
    let ids = [];
    try {
        ids = await readdir(imagesDir);
    }
    catch {
        return report;
    }
    await pMapLimit(ids, 8, async (id) => {
        const mpath = join(imagesDir, id, "manifest.json");
        const txt = await readFileOrNull(mpath);
        if (txt === null)
            return;
        try {
            parseManifest(txt); // validate current manifest (throws on invalid)
            const raw = JSON.parse(txt); // MIG-2: preserve fields the zod schema would strip
            if (!shouldMigrate(raw)) {
                report.skipped++;
                return;
            }
            // MIG-1: per-image write lock; a failure to acquire must NOT fall through to an unlocked write.
            let iLock = null;
            if (!opts.dryRun) {
                try {
                    iLock = await acquireImageWriteLock(outDir, id);
                }
                catch (e) {
                    report.errors.push({ path: mpath, error: `lock: ${e?.message || String(e)}` });
                    report.skipped++;
                    return;
                }
            }
            try {
                if (!opts.dryRun)
                    await atomicWriteJson(mpath, transform(raw));
                report.migrated++;
            }
            finally {
                if (iLock)
                    await iLock.release().catch(() => { });
            }
        }
        catch (e) {
            report.errors.push({ path: mpath, error: e?.message || String(e) });
            report.skipped++;
        }
    });
    return report;
}
const SUPPORTED_SCHEMA_TARGETS = [2, 4];
export async function migrateSchema(outDir, targetVersion, opts = {}) {
    // MIG-3: only known schema literals are valid targets; reject unsupported up front.
    if (!SUPPORTED_SCHEMA_TARGETS.includes(targetVersion)) {
        return {
            migrated: 0,
            skipped: 0,
            errors: [{ path: outDir, error: `unsupported --migrate-schema ${targetVersion} (supported: ${SUPPORTED_SCHEMA_TARGETS.join(", ")})` }],
        };
    }
    return migrateManifests(outDir, (raw) => (raw.schema ?? 1) < targetVersion, // MIG-3: upgrade-only; no downgrade, no producedBy churn on no-op
    (raw) => ({ ...raw, schema: targetVersion, producedBy: makeProducedBy() }), opts);
}
// M2: wire --migrate-layout sharded-2 (records layout in manifests for index/compat).
export async function migrateLayout(outDir, target, opts = {}) {
    return migrateManifests(outDir, (raw) => raw.layout !== target, (raw) => ({ ...raw, layout: target }), opts);
}
//# sourceMappingURL=migrate.js.map