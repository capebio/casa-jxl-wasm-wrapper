// Static file server for the wasm demo.  Maps:
//   /            → web/index.html
//   /web/*       → web/*
//   /pkg/*       → pkg/*
// Adds COOP/COEP headers so SharedArrayBuffer is usable if we wire up
// wasm-bindgen-rayon later — harmless if not.

import { serve } from "bun";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, normalize, sep } from "node:path";

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

serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);
        const path = decodeURIComponent(url.pathname);
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
                    .filter((entry) => entry.isFile())
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
