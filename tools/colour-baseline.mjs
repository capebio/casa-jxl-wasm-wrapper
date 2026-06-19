#!/usr/bin/env node
// colour-baseline — establish colour parity baseline (mean RGB + luma variance)
// for demosaic MHC refactor validation.
// Usage: node tools/colour-baseline.mjs --raw <path>
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize, relative, sep, extname } from "node:path";
import { chromium } from "playwright";

const REPO = normalize(join(import.meta.dirname, ".."));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const RAW = argv("--raw", "C:/Foo/raw-converter/tests/P1110226.ORF");
const EXT = extname(RAW).toLowerCase();
const FN = { ".orf": "process_orf_with_flags", ".dng": "process_dng_with_flags", ".cr2": "process_cr2_with_flags" }[EXT];
if (!FN) throw new Error(`unsupported raw ext: ${RAW}`);

const MIME = new Map([[".js","text/javascript"],[".mjs","text/javascript"],[".wasm","application/wasm"],[".html","text/html"],[".json","application/json"]]);
const HEADERS = (t) => ({ "Content-Type": t, "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "cross-origin" });

const PAGE = `<!doctype html><meta charset=utf8><body><script type=module>
import initRaw, { ${FN}, rgb_to_rgba } from '/pkg/raw_converter_wasm.js';
(async () => {
  try {
    await initRaw();
    const raw = new Uint8Array(await (await fetch('/__file')).arrayBuffer());
    const t0 = performance.now();
    const res = ${FN}(raw, 1, 0,0,0,0,0,0, 0, 0,0,0, NaN, NaN, 0, 0);
    const decodeMs = performance.now() - t0;
    const rgb = res.take_rgb(); const w = res.width, h = res.height; if (res.free) res.free();
    const rgba = rgb_to_rgba(rgb);
    const px = w * h;
    let rSum=0, gSum=0, bSum=0, lSum=0, lSqSum=0;
    for (let i=0; i<rgba.length; i+=4) {
      const r=rgba[i], g=rgba[i+1], b=rgba[i+2];
      rSum+=r; gSum+=g; bSum+=b;
      const L = (54*r + 183*g + 18*b) / 256;
      lSum+=L; lSqSum+=L*L;
    }
    const meanR=rSum/px, meanG=gSum/px, meanB=bSum/px;
    const meanLuma=lSum/px;
    const lumaVariance=Math.max(0, lSqSum/px - meanLuma*meanLuma);
    window.__result = { ok:true, w, h, decodeMs, meanR, meanG, meanB, meanLuma, lumaVariance };
  } catch(e) { window.__result = { ok:false, error:String(e&&(e.stack||e.message)||e) }; }
})();
</script>`;

function startServer() {
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/") { res.writeHead(200, HEADERS("text/html")); res.end(PAGE); return; }
    if (u.pathname === "/__file") {
      try { res.writeHead(200, HEADERS("application/octet-stream")); res.end(readFileSync(RAW)); }
      catch(e) { res.writeHead(404, HEADERS("text/plain")); res.end(String(e)); }
      return;
    }
    const full = normalize(join(REPO, decodeURIComponent(u.pathname).replace(/^\/+/,"")));
    const rel = relative(REPO, full);
    if (rel.startsWith("..") || rel.split(sep).includes("..")) { res.writeHead(403, HEADERS("text/plain")); res.end("no"); return; }
    try { res.writeHead(200, HEADERS(MIME.get(extname(full).toLowerCase()) ?? "application/octet-stream")); res.end(readFileSync(full)); }
    catch { res.writeHead(404, HEADERS("text/plain")); res.end("404 " + u.pathname); }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port })));
}

const { server, port } = await startServer();
const browser = await chromium.launch({ headless: true, args: ["--enable-features=SharedArrayBuffer"] });
let result;
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__result !== undefined, { timeout: 120000 });
  result = await page.evaluate(() => window.__result);
} finally { await browser.close(); server.close(); }

if (!result?.ok) { console.error("FAILED:", result?.error); process.exit(1); }
const r = result;
console.log(JSON.stringify({
  file: RAW,
  dims: `${r.w}x${r.h}`,
  decodeMs: +r.decodeMs.toFixed(1),
  meanRGB: [+r.meanR.toFixed(3), +r.meanG.toFixed(3), +r.meanB.toFixed(3)],
  meanLuma: +r.meanLuma.toFixed(3),
  lumaVariance: +r.lumaVariance.toFixed(3),
}, null, 2));
