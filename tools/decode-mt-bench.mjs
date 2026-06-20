#!/usr/bin/env node
// decode-mt-bench — realized wasm MT speedup for the REAL RAW decode path
// (process_orf/dng: serial decompress + rayon-parallel demosaic + rayon-parallel tone).
// Same browser+COOP/COEP+pkg-mt approach as tone-mt-bench; ST(pool=1) vs MT(pool=cores)
// over a real RAW file. The serial decompress caps the speedup (Amdahl) — that's the
// honest end-to-end decode number for the gallery-ingest path.
//
//   node tools/decode-mt-bench.mjs [--file <path>] [--reps 8] [--pkg pkg-mt]
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, normalize, relative, sep, extname } from "node:path";
import { chromium } from "playwright";
import { cpus } from "node:os";

const REPO = normalize(join(import.meta.dirname, ".."));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const FILE = argv("--file", "C:/Foo/raw-converter/tests/P1110226.ORF");
const REPS = Number(argv("--reps", "8"));
const PKG = argv("--pkg", "pkg-mt");
const CORES = cpus().length;
const EXT = extname(FILE).toLowerCase();
const FN = { ".orf": "process_orf_with_flags", ".dng": "process_dng_with_flags", ".cr2": "process_cr2_with_flags" }[EXT];
if (!FN) throw new Error("unsupported ext " + EXT);

const MIME = new Map([[".js", "text/javascript"], [".wasm", "application/wasm"], [".html", "text/html"], [".json", "application/json"]]);
const HEADERS = (type) => ({ "Content-Type": type, "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "cross-origin" });

const PAGE = `<!doctype html><meta charset=utf8><body><script type=module>
import initRaw, { ${FN}, initThreadPool } from '/${PKG}/raw_converter_wasm.js';
const log = (m) => { window.__log = (window.__log||'') + m + '\\n'; };
const median = (xs) => xs.slice().sort((a,b)=>a-b)[xs.length>>1];
(async () => {
  try {
    const threads = Number(new URL(location.href).searchParams.get('threads') || '1');
    await initRaw();
    if (typeof initThreadPool !== 'function') throw new Error('initThreadPool not exported');
    if (!self.crossOriginIsolated) throw new Error('not crossOriginIsolated');
    await initThreadPool(threads);
    log('threadpool='+threads);
    const raw = new Uint8Array(await (await fetch('/__file')).arrayBuffer());
    log('raw bytes='+raw.length);
    const run = () => ${FN}(raw, 1, 0,0,0,0,0,0, 0,0,0,0, NaN, NaN, 0, 0); // OUTPUT_FULL_RGB, neutral, camera WB
    // warm
    let res = run();
    const rgb = res.take_rgb(); const W=res.width, H=res.height; if (res.free) res.free();
    let checksum=0; for (let i=0;i<rgb.length;i+=1009) checksum=(checksum+rgb[i])>>>0;
    const times=[];
    for (let r=0;r<${REPS};r++){ const t0=performance.now(); const rr=run(); const b=rr.take_rgb(); if(rr.free) rr.free(); times.push(performance.now()-t0); if(b.length===0) throw new Error('empty'); }
    window.__result = { ok:true, threads, W, H, mp:+(W*H/1e6).toFixed(1), medianMs:+median(times).toFixed(1), minMs:+Math.min(...times).toFixed(1), checksum, iso:self.crossOriginIsolated };
  } catch (e) { window.__result = { ok:false, error: String(e && (e.stack||e.message) || e) }; }
})();
</script>`;

function startServer() {
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/") { res.writeHead(200, HEADERS("text/html")); res.end(PAGE); return; }
    if (u.pathname === "/__file") { try { res.writeHead(200, HEADERS("application/octet-stream")); res.end(readFileSync(FILE)); } catch (e) { res.writeHead(404, HEADERS("text/plain")); res.end(String(e)); } return; }
    let pathname = decodeURIComponent(u.pathname);
    if (pathname === `/${PKG}` || pathname === `/${PKG}/`) pathname = `/${PKG}/raw_converter_wasm.js`;
    const full = normalize(join(REPO, pathname.replace(/^\/+/, "")));
    const rel = relative(REPO, full);
    if (rel.startsWith("..") || rel.split(sep).includes("..")) { res.writeHead(403, HEADERS("text/plain")); res.end("no"); return; }
    let data; try { data = readFileSync(full); } catch { console.error("[404]", u.pathname); res.writeHead(404, HEADERS("text/plain")); res.end("404 " + u.pathname); return; }
    res.writeHead(200, HEADERS(MIME.get(extname(full).toLowerCase()) ?? "application/octet-stream")); res.end(data);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port })));
}

async function runOnce(browser, port, threads) {
  const page = await browser.newPage();
  let logs = "";
  page.on("console", (m) => { logs += "[page] " + m.text() + "\n"; });
  page.on("pageerror", (e) => { logs += "[pageerror] " + (e.stack || e.message) + "\n"; });
  await page.goto(`http://127.0.0.1:${port}/?threads=${threads}`, { waitUntil: "load" });
  let result;
  try { await page.waitForFunction(() => window.__result !== undefined, { timeout: 180000 }); result = await page.evaluate(() => window.__result); }
  catch (e) { result = { ok: false, error: "timeout: " + e.message }; }
  result.log = ((await page.evaluate(() => window.__log || "").catch(() => "")) + "\n" + logs).trim();
  await page.close();
  return result;
}

const { server, port } = await startServer();
const browser = await chromium.launch({ headless: true, args: ["--enable-features=SharedArrayBuffer"] });
const runs = { st: [], mt: [] };
try {
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
const stMed = med(runs.st.map(r => r.medianMs)), mtMed = med(runs.mt.map(r => r.medianMs));
const st0 = runs.st[0], mt0 = runs.mt[0];
const parity = st0.checksum === mt0.checksum;
const speedup = stMed / mtMed, pct = (speedup - 1) * 100;
console.log(st0.log);
console.log(`\ndecode-mt-bench  ${FILE.split(/[\\/]/).pop()}  ${st0.W}×${st0.H} = ${st0.mp} MP  cores=${CORES}  reps=${REPS}`);
console.log(`crossOriginIsolated: ${st0.iso}`);
console.log(`parity (output checksum ST==MT): ${parity ? "PASS" : "FAIL"}  (st=${st0.checksum} mt=${mt0.checksum})`);
console.log(`ST (1 thread):     ${stMed.toFixed(0)} ms/decode`);
console.log(`MT (${CORES} threads): ${mtMed.toFixed(0)} ms/decode`);
console.log(`realized decode speedup: ${speedup.toFixed(2)}×  (+${pct.toFixed(0)}%)  [serial decompress caps it via Amdahl]`);
