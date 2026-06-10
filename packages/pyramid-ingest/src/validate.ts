import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { contentHash16 } from "./hash.js";
import { fileExists } from "./ingest.js";  // reuse (defined in ingest.ts)
import { parseManifest, parseGalleryIndex } from "./schema.js";

// F5 (WU-6): --validate. Exact per plan.
export interface ValidationReport {
  totalImages: number;
  totalLevels: number;
  issues: ValidationIssue[];
  // M4: suggestions for --validate --suggest-migrations (unlocked)
  migrationSuggestions?: string[];
}

export type ValidationIssue =
  | { kind: "manifest-parse-error"; imageId: string; error: string }
  | { kind: "missing-level"; imageId: string; contenthash: string }
  | { kind: "hash-mismatch"; imageId: string; contenthash: string; actual: string }
  | { kind: "orphan-level"; contenthash: string }
  | { kind: "index-stale"; expected: string; got: string };

export async function validate(outDir: string, opts: { verifyHash?: boolean; suggestMigrations?: boolean } = {}): Promise<ValidationReport> {
  const imagesDir = join(outDir, "images");
  const levelsDir = join(outDir, "levels");
  const indexPath = join(outDir, "index.json");

  const issues: ValidationIssue[] = [];
  let totalImages = 0;
  let totalLevels = 0;

  // load index for stale check
  let indexImages: Array<{ imageId: string; l0?: { contenthash: string } }> = [];
  try {
    const idxTxt = await readFile(indexPath, "utf8");
    const idx = parseGalleryIndex(idxTxt);
    indexImages = idx.images || [];
  } catch {
    // no index or bad: will be reported via other or ignored for now
  }

  // walk images/<id>/manifest.json
  let ids: string[] = [];
  try { ids = await readdir(imagesDir); } catch { ids = []; }

  const allLevelHashesFromManifests = new Set<string>();
  const suggestions: string[] = [];

  for (const id of ids) {
    const mp = join(imagesDir, id, "manifest.json");
    if (!(await fileExists(mp))) continue;
    totalImages++;
    let manifest: any;
    try {
      manifest = parseManifest(await readFile(mp, "utf8"));
      if (opts.suggestMigrations && (manifest.schema || 1) < 2) {
        suggestions.push(`Image ${id} at schema ${manifest.schema || 1}. Run pyramid-ingest migrate --out ${outDir} --migrate-schema 2 to upgrade.`);
      }
    } catch (e: any) {
      issues.push({ kind: "manifest-parse-error", imageId: id, error: e?.message || String(e) });
      continue;
    }
    const lvList = manifest.levels || [];
    totalLevels += lvList.length;
    for (const lv of lvList) {
      if (!lv || !lv.contenthash) continue;
      allLevelHashesFromManifests.add(lv.contenthash);
      const lp = join(levelsDir, `${lv.contenthash}.jxl`);
      if (!(await fileExists(lp))) {
        issues.push({ kind: "missing-level", imageId: id, contenthash: lv.contenthash });
        continue;
      }
      if (opts.verifyHash) {
        try {
          const onDisk = await readFile(lp);
          const actual = contentHash16(onDisk);
          if (actual !== lv.contenthash) {
            issues.push({ kind: "hash-mismatch", imageId: id, contenthash: lv.contenthash, actual });
          }
        } catch (e: any) {
          issues.push({ kind: "hash-mismatch", imageId: id, contenthash: lv.contenthash, actual: "read-error" });
        }
      }
    }
  }

  // orphan levels: present in levels/ but no manifest references them
  let levelFiles: string[] = [];
  try { levelFiles = await readdir(levelsDir); } catch { levelFiles = []; }
  for (const f of levelFiles) {
    if (!f.endsWith(".jxl")) continue;
    const h = f.slice(0, -4);
    if (!allLevelHashesFromManifests.has(h)) {
      issues.push({ kind: "orphan-level", contenthash: h });
    }
  }

  // index-stale (simple: if index l0 not matching a manifest l0 for that id)
  // (lightweight; full cross in T tests)
  for (const ie of indexImages) {
    const mp = join(imagesDir, ie.imageId, "manifest.json");
    if (await fileExists(mp)) {
      try {
        const m = parseManifest(await readFile(mp, "utf8"));
        const l0 = (m.levels || [])[0];
        if (l0 && ie.l0 && ie.l0.contenthash !== l0.contenthash) {
          issues.push({ kind: "index-stale", expected: l0.contenthash, got: ie.l0.contenthash });
        }
      } catch {}
    }
  }

  const report: ValidationReport = { totalImages, totalLevels, issues };
  if (suggestions.length > 0) report.migrationSuggestions = suggestions;
  return report;
}