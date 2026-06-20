#!/usr/bin/env node
// tone-mt-bench — realized wasm multithreading speedup for the tone pipeline.
// Drives LookRenderer.render() (the per-slider parallel tone path: process_auto →
// process_into_simd → rayon par_chunks) over a synthetic 24MP rgb16 buffer in
// headless Chromium with COOP/COEP so SharedArrayBuffer + the rayon pool work.
//
// MT vs ST = two page loads of the SAME threaded pkg-mt: ?threads=1 (rayon pool of
// 1 = serial) vs ?threads=<cores>. wasm-bindgen-rayon's pool is once-init per page,
// so a fresh load per thread count is the clean A/B. Parity: render output checksum
// must match across thread counts (par_chunks is deterministic).
//
//   node tools/tone-mt-bench.mjs [--mp 24] [--reps 15] [--pkg pkg-mt]
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, normalize, relative, sep, extname } from "node:path";
import { chromium } from "playwright";
import { cpus } from "node:os";

const REPO = normalize(join(import.meta.dirname, ".."));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const MP = Number(argv("--mp", "24"));
const REPS = Number(argv("--reps", "15"));
const PKG = argv("--pkg", "pkg-mt");
const CORES = cpus().length;
// pick dims for ~MP megapixels, even
const W = Math.round(Math.sqrt(MP * 1e6 * 1.5) / 2) * 2;
const H = Math.round((MP * 1e6) / W / 2) * 2;

const MIME = new Map([[".js", "text/javascript"], [".mjs", "text/javascript"], [".wasm", "application/wasm"], [".html", "text/html"], [".json", "application/json"]]);
const HEADERS = (type) => ({ "Content-Type": type, "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "cross-origin" });

const PAGE = `<!doctype html><meta charset=utf8><body><script type=module>
import initRaw, { LookRenderer, initThreadPool } from '/${PKG}/raw_converter_wasm.js';
const log = (m) => { window.__log = (window.__log||'') + m + '\\n'; };
const median = (xs) => xs.slice().sort((a,b)=>a-b)[xs.length>>1];
(async () => {
  try {
    const threads = Number(new URL(location.href).searchParams.get('threads') || '1');
    await initRaw();
    const iso = self.crossOriginIsolated;
    log('crossOriginIsolated='+iso);
    if (typeof initThreadPool !== 'function') throw new Error('initThreadPool not exported — pkg not built with parallel-wasm');
    if (!iso) throw new Error('not crossOriginIsolated — COOP/COEP missing, SAB unavailable');
    await initThreadPool(threads);
    log('threadpool='+threads);
    // synthetic packed u16-LE rgb16 buffer: 6 bytes/px
    const W=${W}, H=${H}, N=W*H;
    const buf = new Uint8Array(N*6);
    let s = 0x9e3779b9>>>0;
    for (let i=0;i<buf.length;i++){ s=(s*1664525+1013904223)>>>0; buf[i]=(s>>>24)&0xff; }
    const lr = new LookRenderer(buf, W, H, 1, new Float32Array(0)); // matrix len!=9 → CAM_TO_SRGB
    const render = () => lr.render(1.0,1.0, 0,0,0,0,0,0, 0,0, 0,0, 0,0); // neutral, texture=clarity=0 → parallel path
    // warm
    let out = render();
    let checksum = 0; for (let i=0;i<out.length;i+=997) checksum=(checksum+out[i])>>>0;
    // timed
    const times=[];
    for (let r=0;r<${REPS};r++){ const t0=performance.now(); out=render(); times.push(performance.now()-t0); }
    window.__result = { ok:true, threads, W, H, mp:+(N/1e6).toFixed(1), medianMs:+median(times).toFixed(2), minMs:+Math.min(...times).toFixed(2), checksum, iso };
  } catch (e) { window.__result = { ok:false, error: String(e && (e.stack||e.message) || e) }; }
})();
</script>`;

function startServer() {
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/") { res.writeHead(200, HEADERS("text/html")); res.end(PAGE); return; }
    // wasm-bindgen-rayon workerHelpers does `import('../../..')` which resolves to the
    // pkg dir URL (e.g. /pkg-mt/); map a bare-dir request to the main module JS.
    let pathname = decodeURIComponent(u.pathname);
    if (pathname === `/${PKG}` || pathname === `/${PKG}/`) pathname = `/${PKG}/raw_converter_wasm.js`;
    const full = normalize(join(REPO, pathname.replace(/^\/+/, "")));
    const rel = relative(REPO, full);
    if (rel.startsWith("..") || rel.split(sep).includes("..")) { res.writeHead(403, HEADERS("text/plain")); res.end("no"); return; }
    let data;
    try { data = readFileSync(full); }
    catch { console.error("[404]", u.pathname); res.writeHead(404, HEADERS("text/plain")); res.end("404 " + u.pathname); return; }
    res.writeHead(200, HEADERS(MIME.get(extname(full).toLowerCase()) ?? "application/octet-stream")); res.end(data);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port })));
}

async function runOnce(browser, port, threads) {
  const page = await browser.newPage();
  let logs = "";
  page.on("console", (m) => { logs += "[page] " + m.text() + "\n"; });
  page.on("pageerror", (e) => { logs += "[pageerror] " + (e.stack || e.message) + "\n"; });
  page.on("requestfailed", (r) => { logs += "[reqfail] " + r.url() + " " + (r.failure()?.errorText || "") + "\n"; });
  await page.goto(`http://127.0.0.1:${port}/?threads=${threads}`, { waitUntil: "load" });
  let result;
  try {
    await page.waitForFunction(() => window.__result !== undefined, { timeout: 120000 });
    result = await page.evaluate(() => window.__result);
  } catch (e) {
    result = { ok: false, error: "timeout waiting for __result: " + e.message };
  }
  result.log = ((await page.evaluate(() => window.__log || "").catch(() => "")) + "\n" + logs).trim();
  await page.close();
  return result;
}

const { server, port } = await startServer();
const browser = await chromium.launch({ headless: true, args: ["--enable-features=SharedArrayBuffer"] });
const runs = { st: [], mt: [] };
try {
  // interleave ST/MT across 3 rounds to cancel drift
  for (let round = 0; round < 3; round++) {
    const order = round % 2 ? [["mt", CORES], ["st", 1]] : [["st", 1], ["mt", CORES]];
    for (const [k, t] of order) {
      const r = await runOnce(browser, port, t);
      if (!r.ok) { console.error(`run ${k} threads=${t} FAILED:\n${r.log}`); await browser.close(); server.close(); process.exit(1); }
      runs[k].push(r);
    }
  }
} finally { await browser.close(); server.close(); }

const med = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
const stMed = med(runs.st.map(r => r.medianMs));
const mtMed = med(runs.mt.map(r => r.medianMs));
const st0 = runs.st[0], mt0 = runs.mt[0];
const parity = st0.checksum === mt0.checksum;
const speedup = stMed / mtMed, pct = (speedup - 1) * 100;
console.log(st0.log);
console.log(`\ntone-mt-bench  ${st0.W}×${st0.H} = ${st0.mp} MP  cores=${CORES}  reps=${REPS}  pkg=${PKG}`);
console.log(`crossOriginIsolated: ${st0.iso}`);
console.log(`parity (render checksum ST==MT): ${parity ? "PASS" : "FAIL"}  (st=${st0.checksum} mt=${mt0.checksum})`);
console.log(`ST (1 thread):     ${stMed.toFixed(2)} ms/render`);
console.log(`MT (${CORES} threads): ${mtMed.toFixed(2)} ms/render`);
console.log(`realized speedup: ${speedup.toFixed(2)}×  (+${pct.toFixed(0)}%)   vs ~3.25× native ceiling`);
if (!parity) process.exit(2);
