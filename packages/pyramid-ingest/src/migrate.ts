import { readdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest } from "./schema.js";
import { makeProducedBy } from "./schema.js";
import { fileExists } from "./ingest.js";
import { acquireImageWriteLock } from "./lock.js";

// M1/M2/M4 per plan (unlocked by WU-6 + V3 + locks).
// Focus M1 schema migrate (v1->2 re-emit with current producedBy + schema:2).
// M2 layout deferred (Phase3 tile-all may have affected; F13 sharded not fully active).
// Suggestions integrated via validate report.

export interface MigrationReport {
  migrated: number;
  skipped: number; // already at target or errors
  errors: Array<{ path: string; error: string }>;
}

export async function migrateSchema(
  outDir: string,
  targetVersion: number,
  opts: { dryRun?: boolean } = {}
): Promise<MigrationReport> {
  const imagesDir = join(outDir, "images");
  const report: MigrationReport = { migrated: 0, skipped: 0, errors: [] };

  let ids: string[] = [];
  try { ids = await readdir(imagesDir); } catch { return report; }

  for (const id of ids) {
    const mpath = join(imagesDir, id, "manifest.json");
    if (!(await fileExists(mpath))) continue;

    try {
      const txt = await readFile(mpath, "utf8");
      const m = parseManifest(txt);

      if (m.schema === targetVersion) {
        report.skipped++;
        continue;
      }

      // full L3: per-image lock for migrate mutate
      let iLock: any = null;
      if (!opts.dryRun) {
        try { iLock = await acquireImageWriteLock(outDir, id); } catch {}
      }

      // pure transform: force current producedBy + target schema (additive)
      const updated = {
        ...m,
        schema: targetVersion as 2,
        producedBy: makeProducedBy(),
      };

      if (!opts.dryRun) {
        const tmp = `${mpath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        await writeFile(tmp, JSON.stringify(updated, null, 2));
        await rename(tmp, mpath).catch(async (e: any) => {
          if (e && e.code === "EEXIST") {
            await unlink(tmp).catch(() => {});
          } else {
            throw e;
          }
        });
      }
      report.migrated++;
      if (iLock) await iLock.release().catch(() => {});
    } catch (e: any) {
      report.errors.push({ path: mpath, error: e?.message || String(e) });
      report.skipped++;
    }
  }

  return report;
}

// M2: wire --migrate-layout sharded-2 (additive for future; current post-phase3 is flat, but record layout in manifests for index/compat).
export async function migrateLayout(outDir: string, target: "sharded-2", opts: { dryRun?: boolean } = {}): Promise<MigrationReport> {
  const imagesDir = join(outDir, "images");
  const report: MigrationReport = { migrated: 0, skipped: 0, errors: [] };

  let ids: string[] = [];
  try { ids = await readdir(imagesDir); } catch { return report; }

  for (const id of ids) {
    const mpath = join(imagesDir, id, "manifest.json");
    if (!(await fileExists(mpath))) continue;

    try {
      const txt = await readFile(mpath, "utf8");
      const m = parseManifest(txt);

      if ((m as any).layout === target) {
        report.skipped++;
        continue;
      }

      // full L3: per-image lock for migrate
      let iLock: any = null;
      if (!opts.dryRun) {
        try { iLock = await acquireImageWriteLock(outDir, id); } catch {}
      }

      const updated = {
        ...m,
        layout: target,
      };

      if (!opts.dryRun) {
        const tmp = `${mpath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        await writeFile(tmp, JSON.stringify(updated, null, 2));
        await rename(tmp, mpath).catch(async (e: any) => {
          if (e && e.code === "EEXIST") {
            await unlink(tmp).catch(() => {});
          } else {
            throw e;
          }
        });
      }
      report.migrated++;
      if (iLock) await iLock.release().catch(() => {});
    } catch (e: any) {
      report.errors.push({ path: mpath, error: e?.message || String(e) });
      report.skipped++;
    }
  }

  return report;
}