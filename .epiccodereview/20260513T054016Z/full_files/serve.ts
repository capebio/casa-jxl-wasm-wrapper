// Static file server for the wasm demo.  Maps:
//   /            → web/index.html
//   /web/*       → web/*
//   /pkg/*       → pkg/*
// Adds COOP/COEP headers so SharedArrayBuffer is usable if we wire up
// wasm-bindgen-rayon later — harmless if not.

import { serve } from "bun";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

const ROOT = import.meta.dir;
const PORT = Number(process.env.PORT ?? 5173);

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
        let path = decodeURIComponent(url.pathname);
        if (path === "/") {
            // Redirect rather than internal rewrite so relative URLs in the
            // page resolve against /web/ not /.
            return new Response(null, {
                status: 302,
                headers: { Location: "/web/index.html" },
            });
        }

        // Reject parent-dir traversal in URL-space first, then convert to OS path.
        if (path.includes("..")) return new Response("forbidden", { status: 403 });
        const parts = path.split("/").filter((p) => p.length);
        const fsPath = join(ROOT, ...parts);
        try {
            const data = await readFile(fsPath);
            const ext = extname(fsPath).toLowerCase();
            // Note: deliberately NOT setting COOP/COEP.  Doing so enables
            // SharedArrayBuffer, which then makes jSquash try to spawn a
            // multi-thread worker from esm.sh — and cross-origin Workers
            // are forbidden under COEP.  Single-thread SIMD path works fine.
            return new Response(data, {
                headers: {
                    "Content-Type": MIME[ext] ?? "application/octet-stream",
                    "Cache-Control": "no-cache",
                },
            });
        } catch {
            return new Response("not found: " + parts.join("/"), { status: 404 });
        }
    },
});

console.log(`Serving http://localhost:${PORT}`);
