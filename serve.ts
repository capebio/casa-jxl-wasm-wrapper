// Static file server for the wasm demo.  Maps:
//   /            → web/index.html
//   /web/*       → web/*
//   /pkg/*       → pkg/*
// Adds COOP/COEP headers so SharedArrayBuffer is usable if we wire up
// wasm-bindgen-rayon later — harmless if not.

import { serve } from "bun";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, normalize, sep } from "node:path";
import { createDecoder, createEncoder } from "./packages/jxl-wasm/dist/facade.js";

const ROOT = import.meta.dir;
const PORT = Number(process.env.PORT ?? 9000);
const RANDOM_ORF_FOLDER = String.raw`C:\995\2026-02-17 Dave at Kyffhauser`;
const RANDOM_GOBABEB_FOLDER = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const TIMINGS_DIR = join(ROOT, "timings");

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript",
    ".mjs":  "application/javascript",
    ".css":  "text/css",
    ".wasm": "application/wasm",
    ".json": "application/json",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".svg":  "image/svg+xml",
    ".ts":   "application/typescript",
};

// --- /api/jxl-crop cache ---
// Key: "file:x:y:w:h:distance:effort" → encoded crop JXL bytes.
// Capped at 50 entries; oldest evicted on overflow (Map insertion order).
const JXL_CROP_CACHE = new Map<string, Uint8Array>();
const JXL_CROP_CACHE_MAX = 50;

async function handleJxlCrop(url: URL): Promise<Response> {
    const p = url.searchParams;
    const file     = p.get("file") ?? "";
    const x        = parseInt(p.get("x") ?? "", 10);
    const y        = parseInt(p.get("y") ?? "", 10);
    const w        = parseInt(p.get("w") ?? "", 10);
    const h        = parseInt(p.get("h") ?? "", 10);
    const distance = Math.max(0, Math.min(25, parseFloat(p.get("distance") ?? "1.0")));
    const effort   = Math.max(1, Math.min(9, parseInt(p.get("effort") ?? "4", 10))) as 1|2|3|4|5|6|7|8|9;

    if (!file || [x, y, w, h].some((v) => !Number.isInteger(v) || v < 0) || w === 0 || h === 0) {
        return new Response("bad params: file, x, y, w, h required; w and h must be > 0", { status: 400 });
    }

    const cacheKey = `${file}:${x}:${y}:${w}:${h}:${distance}:${effort}`;
    const cached = JXL_CROP_CACHE.get(cacheKey);
    if (cached !== undefined) {
        return new Response(cached, {
            headers: {
                "Content-Type": "image/jxl",
                "Cache-Control": "public, max-age=31536000, immutable",
                "Cross-Origin-Opener-Policy":   "same-origin",
                "Cross-Origin-Embedder-Policy": "require-corp",
            },
        });
    }

    // Read source JXL from local filesystem.
    let sourceBytes: Uint8Array;
    try {
        sourceBytes = await readFile(file);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return new Response("source file not found", { status: 404 });
        return new Response("failed to read source file", {
            status: 500,
            headers: { "X-Jxl-Error": String(err) },
        });
    }

    // Decode JXL → RGBA8 crop region.
    let pixels: ArrayBuffer | Uint8Array | null = null;
    let cropW = w;
    let cropH = h;
    try {
        const decoder = createDecoder({
            format: "rgba8",
            region: { x, y, w, h },
            downsample: 1,
            progressionTarget: "final",
            emitEveryPass: false,
            preserveIcc: false,
            preserveMetadata: false,
        });
        decoder.push(sourceBytes);
        await decoder.close();
        for await (const event of decoder.events()) {
            if (event.type === "error") {
                return new Response("JXL decode failed: " + event.message, {
                    status: 500,
                    headers: { "X-Jxl-Error": event.code },
                });
            }
            if (event.type === "final") {
                pixels = event.pixels;
                cropW  = event.info.width;
                cropH  = event.info.height;
                break;
            }
        }
        await decoder.dispose();
    } catch (err) {
        return new Response("JXL decode error", {
            status: 500,
            headers: { "X-Jxl-Error": String(err) },
        });
    }
    if (pixels === null) {
        return new Response("JXL decode produced no final frame", { status: 500 });
    }

    // Re-encode crop region as JXL.
    let cropJxl: Uint8Array;
    try {
        const encoder = createEncoder({
            format: "rgba8",
            width: cropW,
            height: cropH,
            hasAlpha: true,
            iccProfile: null,
            exif: null,
            xmp: null,
            distance,
            quality: null,
            effort,
            progressive: false,
            previewFirst: false,
            chunked: false,
        });
        await encoder.pushPixels(pixels);
        await encoder.finish();
        const chunks: Uint8Array[] = [];
        for await (const chunk of encoder.chunks()) {
            chunks.push(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk);
        }
        await encoder.dispose();
        const totalLen = chunks.reduce((n, c) => n + c.byteLength, 0);
        cropJxl = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) { cropJxl.set(chunk, offset); offset += chunk.byteLength; }
    } catch (err) {
        return new Response("JXL encode error", {
            status: 500,
            headers: { "X-Jxl-Error": String(err) },
        });
    }

    // Store in cache, evict oldest if over limit.
    if (JXL_CROP_CACHE.size >= JXL_CROP_CACHE_MAX) {
        JXL_CROP_CACHE.delete(JXL_CROP_CACHE.keys().next().value!);
    }
    JXL_CROP_CACHE.set(cacheKey, cropJxl);

    return new Response(cropJxl, {
        headers: {
            "Content-Type": "image/jxl",
            "Cache-Control": "public, max-age=31536000, immutable",
            "Cross-Origin-Opener-Policy":   "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
        },
    });
}

serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);
        const path = decodeURIComponent(url.pathname);
        if (path === "/api/jxl-crop" && req.method === "GET") {
            return handleJxlCrop(url);
        }
        if (path === "/api/timings" && req.method === "POST") {
            try {
                const payload = (await req.json()) as { filename?: string; markdown?: string };
                const markdown = String(payload?.markdown ?? "");
                if (!markdown) return new Response("missing markdown", { status: 400 });
                const rawName = String(payload?.filename ?? "");
                const safeName = basename(rawName || `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
                const filename = safeName.toLowerCase().endsWith(".md") ? safeName : `${safeName}.md`;
                await mkdir(TIMINGS_DIR, { recursive: true });
                const fsPath = join(TIMINGS_DIR, filename);
                await writeFile(fsPath, markdown, "utf8");
                return new Response(JSON.stringify({ path: fsPath }), {
                    headers: { "Content-Type": "application/json" },
                });
            } catch (err) {
                console.error("timings write error:", err);
                return new Response("failed to write timings", { status: 500 });
            }
        }
        if (path === "/api/random-orf") {
            try {
                const entries = await readdir(RANDOM_ORF_FOLDER, { withFileTypes: true });
                const orfs = entries
                    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".orf")
                    .map((entry) => entry.name);
                if (!orfs.length) return new Response("no ORF files found", { status: 404 });
                const name = orfs[Math.floor(Math.random() * orfs.length)];
                const fsPath = join(RANDOM_ORF_FOLDER, name);
                const data = await readFile(fsPath);
                return new Response(data, {
                    headers: {
                        "Content-Type": "application/octet-stream",
                        "Cache-Control": "no-cache",
                        "Cross-Origin-Opener-Policy":   "same-origin",
                        "Cross-Origin-Embedder-Policy": "require-corp",
                        "X-File-Name": name,
                        "X-File-Size": String(data.byteLength),
                        "X-Source-Folder": RANDOM_ORF_FOLDER,
                    },
                });
            } catch (err) {
                console.error("random orf error:", err);
                return new Response("failed to load random orf", { status: 500 });
            }
        }
        if (path === "/api/random-gobabeb") {
            try {
                const entries = await readdir(RANDOM_GOBABEB_FOLDER, { withFileTypes: true });
                const files = entries
                    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".orf")
                    .map((entry) => entry.name);
                if (!files.length) return new Response("no files found", { status: 404 });
                const name = files[Math.floor(Math.random() * files.length)];
                const fsPath = join(RANDOM_GOBABEB_FOLDER, name);
                const data = await readFile(fsPath);
                return new Response(data, {
                    headers: {
                        "Content-Type": "application/octet-stream",
                        "Cache-Control": "no-cache",
                        "Cross-Origin-Opener-Policy":   "same-origin",
                        "Cross-Origin-Embedder-Policy": "require-corp",
                        "X-File-Name": name,
                        "X-File-Size": String(data.byteLength),
                        "X-Source-Folder": RANDOM_GOBABEB_FOLDER,
                    },
                });
            } catch (err) {
                console.error("random gobabeb error:", err);
                return new Response("failed to load random gobabeb file", { status: 500 });
            }
        }
        // Worker falls back to this URL when import maps aren't available (pre-Chrome 114).
        // Serve the scalar WASM so the worker can bootstrap without T-WASM-BUILD.
        if (path === "/packages/jxl-worker-browser/dist/jxl-core.wasm") {
            const wasmPath = join(ROOT, "packages", "jxl-wasm", "dist", "jxl-core.scalar.wasm");
            try {
                const data = await readFile(wasmPath);
                return new Response(data, {
                    headers: {
                        "Content-Type": "application/wasm",
                        "Cache-Control": "no-cache",
                        "Cross-Origin-Opener-Policy":   "same-origin",
                        "Cross-Origin-Embedder-Policy": "require-corp",
                    },
                });
            } catch {
                return new Response("jxl-core.scalar.wasm not found", { status: 404 });
            }
        }
        if (path === "/") {
            // Redirect rather than internal rewrite so relative URLs in the
            // page resolve against /web/ not /.
            return new Response(null, {
                status: 302,
                headers: { Location: "/web/index.html" },
            });
        }

        const parts = path.split("/").filter((p) => p.length);
        const fsPath = normalize(join(ROOT, ...parts));
        // Reject any path that escapes ROOT (covers literal "..", URL-encoded,
        // double-encoded, and Windows backslash variants after normalize()).
        if (!fsPath.startsWith(ROOT + sep) && fsPath !== ROOT) {
            return new Response("forbidden", { status: 403 });
        }
        try {
            const data = await readFile(fsPath);
            const ext = extname(fsPath).toLowerCase();
            // COOP + COEP enable SharedArrayBuffer for jxl-worker.js, which runs
            // the Pthread-based libjxl MT codec.  All resources are same-origin
            // (no CDN), so require-corp is safe.
            return new Response(data, {
                headers: {
                    "Content-Type": MIME[ext] ?? "application/octet-stream",
                    "Cache-Control": "no-cache",
                    "Cross-Origin-Opener-Policy":   "same-origin",
                    "Cross-Origin-Embedder-Policy": "require-corp",
                },
            });
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "ENOENT") return new Response("not found: " + parts.join("/"), { status: 404 });
            if (code === "EACCES") return new Response("forbidden", { status: 403 });
            console.error("serve error:", err);
            return new Response("internal server error", { status: 500 });
        }
    },
});

console.log(`Serving http://localhost:${PORT}`);
