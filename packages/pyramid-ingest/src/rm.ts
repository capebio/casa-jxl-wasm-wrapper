import { readdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest } from "./schema.js";
import { fileExists } from "./ingest.js";
import { removeOrphans } from "./ingest.js";
import { rebuildIndex } from "./ingest.js";

// F6 (WU-6): --rm. Exact per plan.
export async function removeImage(
  outDir: string,
  imageId: string,
  opts: { dryRun?: boolean; gc?: boolean } = {}
): Promise<{ removedDirs: string[]; removedLevels: string[] }> {
  const removedDirs: string[] = [];
  const removedLevels: string[] = [];

  const imageDir = join(outDir, "images", imageId);
  const manifestPath = join(imageDir, "manifest.json");

  if (!(await fileExists(manifestPath))) {
    // nothing to do or already gone
    return { removedDirs, removedLevels };
  }

  const manifest = parseManifest(await readFile(manifestPath, "utf8"));
  const hashes = (manifest.levels || []).map((l: any) => l.contenthash).filter(Boolean);

  if (!opts.dryRun) {
    // delete the image dir recursively (levels stay until gc or explicit)
    try {
      await rm(imageDir, { recursive: true, force: true });
      removedDirs.push(imageId);
    } catch (e) {
      // best effort
    }
  } else {
    removedDirs.push(imageId); // report intent
  }

  if (opts.gc) {
    // scoped: remove unreferenced after this delete
    const gcRes = await removeOrphans(outDir, { dryRun: opts.dryRun });
    removedLevels.push(...gcRes.removedLevelFiles);
  }

  // caller (cli) does rebuildIndex after
  return { removedDirs, removedLevels };
}