import { rm } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest } from "./schema.js";
import { readFileOrNull, removeOrphans } from "./ingest.js";
// F6 (WU-6): --rm. Exact per plan.
export async function removeImage(outDir, imageId, opts = {}) {
    const removedDirs = [];
    const removedLevels = [];
    const imageDir = join(outDir, "images", imageId);
    const manifestPath = join(imageDir, "manifest.json");
    // RM-4: single read instead of fileExists()+readFile().
    const txt = await readFileOrNull(manifestPath);
    if (txt === null) {
        // nothing to do or already gone
        return { removedDirs, removedLevels };
    }
    // RM-1: a corrupt manifest must NOT block removal — that is exactly when rm is most needed.
    // We don't use this image's hash list (gc below does a full refcount scan), so parsing is
    // only a best-effort validation; failure is non-fatal.
    try {
        parseManifest(txt);
    }
    catch { /* proceed to remove regardless */ }
    if (!opts.dryRun) {
        // delete the image dir recursively (levels stay until gc or explicit)
        try {
            await rm(imageDir, { recursive: true, force: true });
            removedDirs.push(imageId);
        }
        catch {
            // best effort
        }
    }
    else {
        removedDirs.push(imageId); // report intent
    }
    if (opts.gc) {
        // RM-3: full-store orphan scan. A level may be shared across images (content-addressed dedup),
        // so a targeted delete by this manifest's hashes would be unsafe; the full refcount scan is the
        // correct choice. removeOrphans now refuses to delete when any manifest is unparseable.
        const gcRes = await removeOrphans(outDir, { dryRun: opts.dryRun });
        removedLevels.push(...gcRes.removedLevelFiles);
    }
    // caller (cli) does rebuildIndex after
    return { removedDirs, removedLevels };
}
//# sourceMappingURL=rm.js.map