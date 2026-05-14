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
const PORT = Number(process.env.PORT ?? 9000);

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
