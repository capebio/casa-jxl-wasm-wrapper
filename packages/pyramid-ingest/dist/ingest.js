import { access, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { imageIdForPath } from "./hash.js";
import { buildJpgLadder, buildProxyLadder, buildRawLadder } from "./ladder.js";
import { buildIndexEntry, buildManifest, isUpToDate, toEntry, } from "./manifest.js";
const RAW_EXT = { ".orf": "orf", ".dng": "dng", ".cr2": "cr2" };
export function formatFromPath(p) {
    const lower = p.toLowerCase();
    const dot = lower.lastIndexOf(".");
    if (dot < 0)
        return null;
    const ext = lower.slice(dot);
    const raw = RAW_EXT[ext];
    if (raw)
        return raw;
    if (ext === ".jpg" || ext === ".jpeg")
        return "jpg";
    return null;
}
async function fileExists(p) {
    try {
        await access(p);
        return true;
    }
    catch {
        return false;
    }
}
async function decodeMaster(b, format, bytes) {
    if (format === "jpg") {
        const fullJxl = await b.jxl.transcodeJpeg(bytes);
        const d = await b.jxl.decodeToRgba8(fullJxl);
        return { rgba: d.rgba, width: d.width, height: d.height, orientation: "source" };
    }
    return b.raw.decode(bytes, format);
}
export async function writeLevelFiles(outDir, levels, masterW, masterH) {
    const levelsDir = join(outDir, "levels");
    await mkdir(levelsDir, { recursive: true });
    const entries = [];
    for (const level of levels) {
        const entry = toEntry(level, masterW, masterH);
        const dest = join(levelsDir, `${entry.contenthash}.jxl`);
        if (!(await fileExists(dest)))
            await writeFile(dest, level.data);
        entries.push(entry);
    }
    return entries;
}
export async function ingestImage(masterPath, backends, opts) {
    const format = formatFromPath(masterPath);
    if (!format)
        throw new Error(`unsupported master format: ${masterPath}`);
    const imageId = imageIdForPath(masterPath);
    const info = await stat(masterPath);
    const imageDir = join(opts.outDir, "images", imageId);
    const manifestPath = join(imageDir, "manifest.json");
    if (!opts.force && opts.proxy === undefined && (await fileExists(manifestPath))) {
        const existing = JSON.parse(await readFile(manifestPath, "utf8"));
        if (isUpToDate(existing, info.mtimeMs))
            return "skipped";
    }
    const bytes = new Uint8Array(await readFile(masterPath));
    let ladder;
    if (opts.proxy !== undefined) {
        const decoded = await decodeMaster(backends, format, bytes);
        ladder = await buildProxyLadder(backends.jxl, decoded.rgba, decoded.width, decoded.height, opts.proxy, decoded.orientation);
    }
    else if (format === "jpg") {
        ladder = await buildJpgLadder(backends.jxl, bytes);
    }
    else {
        const decoded = await backends.raw.decode(bytes, format);
        ladder = await buildRawLadder(backends.jxl, decoded);
    }
    const entries = await writeLevelFiles(opts.outDir, ladder.levels, ladder.width, ladder.height);
    const manifest = buildManifest({
        imageId,
        master: { name: basename(masterPath), format, mtimeMs: info.mtimeMs },
        orientation: ladder.orientation,
        width: ladder.width,
        height: ladder.height,
        levels: entries,
        proxy: opts.proxy !== undefined,
    });
    await mkdir(imageDir, { recursive: true });
    const manifestTmp = `${manifestPath}.tmp`;
    await writeFile(manifestTmp, JSON.stringify(manifest, null, 2));
    await rename(manifestTmp, manifestPath);
    return "written";
}
export async function ingestBatch(files, backends, opts) {
    const result = { written: 0, skipped: 0, failed: [] };
    const workers = Math.max(1, Math.min(opts.concurrency ?? 1, files.length || 1));
    let next = 0;
    const run = async () => {
        for (;;) {
            const idx = next++;
            if (idx >= files.length)
                return;
            const path = files[idx];
            try {
                const outcome = await ingestImage(path, backends, opts);
                if (outcome === "written")
                    result.written++;
                else
                    result.skipped++;
            }
            catch (err) {
                result.failed.push({ path, error: err instanceof Error ? err.message : String(err) });
            }
        }
    };
    await Promise.all(Array.from({ length: workers }, () => run()));
    return result;
}
export async function rebuildIndex(outDir) {
    const imagesDir = join(outDir, "images");
    const index = { schema: 1, images: [] };
    let imageIds;
    try {
        imageIds = await readdir(imagesDir);
    }
    catch {
        imageIds = [];
    }
    for (const id of imageIds) {
        const manifestPath = join(imagesDir, id, "manifest.json");
        if (!(await fileExists(manifestPath)))
            continue;
        let manifest;
        try {
            manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        }
        catch (err) {
            process.stderr.write(`warning: skipping unreadable manifest ${manifestPath}: ${err instanceof Error ? err.message : String(err)}\n`);
            continue;
        }
        if (manifest.proxy)
            continue;
        index.images.push(buildIndexEntry(manifest));
    }
    index.images.sort((a, b) => (a.imageId < b.imageId ? -1 : a.imageId > b.imageId ? 1 : 0));
    await writeFile(join(outDir, "index.json"), JSON.stringify(index, null, 2));
    return index;
}
//# sourceMappingURL=ingest.js.map