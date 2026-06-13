import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { contentHash16 } from "./hash.js";
import { fileExists, pMapLimit, readFileOrNull } from "./ingest.js";
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
  | { kind: "level-read-error"; imageId: string; contenthash: string; error: string }
  | { kind: "orphan-level"; contenthash: string }
  | { kind: "orphan-scan-skipped"; reason: string }
  | { kind: "index-stale"; expected: string; got: string }
  | { kind: "index-orphan"; imageId: string };

export async function validate(outDir: string, opts: { verifyHash?: boolean; suggestMigrations?: boolean } = {}): Promise<ValidationReport> {
  const imagesDir = join(outDir, "images");
  const levelsDir = join(outDir, "levels");
  const indexPath = join(outDir, "index.json");

  const issues: ValidationIssue[] = [];
  let totalImages = 0;
  let totalLevels = 0;

  // load index for stale/orphan check
  let indexImages: Array<{ imageId: string; l0?: { contenthash: string } }> = [];
  const idxTxt = await readFileOrNull(indexPath);
  if (idxTxt) {
    try { indexImages = parseGalleryIndex(idxTxt).images || []; } catch { /* bad index: tolerated */ }
  }

  let ids: string[] = [];
  try { ids = await readdir(imagesDir); } catch { ids = []; }

  const allLevelHashesFromManifests = new Set<string>();
  const l0ByImage = new Map<string, string | undefined>(); // VAL-2: cached so index-stale needs no re-read
  const manifestPresent = new Set<string>();
  const suggestions: string[] = [];
  let parseFailures = 0;

  // VAL-3: walk images in bounded parallel (read-only, so safe). Per-image work is independent.
  await pMapLimit(ids, 8, async (id) => {
    const mp = join(imagesDir, id, "manifest.json");
    const txt = await readFileOrNull(mp);
    if (txt === null) return;
    manifestPresent.add(id);
    totalImages++;
    let manifest: any;
    try {
      manifest = parseManifest(txt);
    } catch (e: any) {
      parseFailures++;
      issues.push({ kind: "manifest-parse-error", imageId: id, error: e?.message || String(e) });
      return;
    }
    if (opts.suggestMigrations && (manifest.schema || 1) < 2) {
      suggestions.push(`Image ${id} at schema ${manifest.schema || 1}. Run pyramid-ingest migrate --out ${outDir} --migrate-schema 2 to upgrade.`);
    }
    const lvList = manifest.levels || [];
    totalLevels += lvList.length;
    l0ByImage.set(id, lvList[0]?.contenthash);
    for (const lv of lvList) {
      if (!lv || !lv.contenthash) continue;
      allLevelHashesFromManifests.add(lv.contenthash);
      const lp = join(levelsDir, `${lv.contenthash}.jxl`);
      if (opts.verifyHash) {
        // VAL-3: read once (no separate fileExists); VAL-4: distinguish missing vs read-error vs mismatch.
        try {
          const onDisk = await readFile(lp);
          const actual = contentHash16(onDisk);
          if (actual !== lv.contenthash) {
            issues.push({ kind: "hash-mismatch", imageId: id, contenthash: lv.contenthash, actual });
          }
        } catch (e: any) {
          if (e && e.code === "ENOENT") {
            issues.push({ kind: "missing-level", imageId: id, contenthash: lv.contenthash });
          } else {
            issues.push({ kind: "level-read-error", imageId: id, contenthash: lv.contenthash, error: e?.message || String(e) });
          }
        }
      } else if (!(await fileExists(lp))) {
        issues.push({ kind: "missing-level", imageId: id, contenthash: lv.contenthash });
      }
    }
  });

  // orphan levels: present in levels/ but no manifest references them.
  // VAL-1 DATA-SAFETY: if any manifest failed to parse, its live levels look orphaned — skip the scan
  // rather than report false orphans that an operator-run gc could then delete.
  let levelFiles: string[] = [];
  try { levelFiles = await readdir(levelsDir); } catch { levelFiles = []; }
  if (parseFailures === 0) {
    for (const f of levelFiles) {
      if (!f.endsWith(".jxl")) continue;
      const h = f.slice(0, -4);
      if (!allLevelHashesFromManifests.has(h)) {
        issues.push({ kind: "orphan-level", contenthash: h });
      }
    }
  } else {
    issues.push({ kind: "orphan-scan-skipped", reason: `${parseFailures} manifest(s) failed to parse; orphan detection unsafe` });
  }

  // index cross-checks (VAL-2: reuse l0 cached above — no second manifest read/parse).
  for (const ie of indexImages) {
    if (!manifestPresent.has(ie.imageId)) {
      issues.push({ kind: "index-orphan", imageId: ie.imageId });
      continue;
    }
    const truthL0 = l0ByImage.get(ie.imageId); // undefined when that manifest parse-errored (already reported)
    if (truthL0 && ie.l0 && ie.l0.contenthash !== truthL0) {
      issues.push({ kind: "index-stale", expected: truthL0, got: ie.l0.contenthash });
    }
  }

  const report: ValidationReport = { totalImages, totalLevels, issues };
  if (suggestions.length > 0) report.migrationSuggestions = suggestions;
  return report;
}
