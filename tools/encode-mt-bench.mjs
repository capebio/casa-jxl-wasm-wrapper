#!/usr/bin/env node
// encode-mt-bench — realized libjxl WASM multithreading speedup for JXL ENCODE.
// The enc.simd-mt artifact already ships (libjxl per-group JxlThreadParallelRunner,
// wired in bridge.cpp); it just was never measured because plain Node can't run the
// pthread tier (modules are -sENVIRONMENT=web,worker → no web Worker in node, so the
// facade falls back to `simd`). So we run it in COOP/COEP-isolated headless Chromium
// and force the tier: simd (ST) vs simd-mt (MT).
//
//   node tools/encode-mt-bench.mjs [--mp 12] [--effort 7] [--reps 3]
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, normalize, relative, sep, extname } from "node:path";
import { chromium } from "playwright";
import { cpus } from "node:os";

const REPO = normalize(join(import.meta.dirname, ".."));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const MP = Number(argv("--mp", "12"));
const EFFORT = Number(argv("--effort", "7"));
const REPS = Number(argv("--reps", "3"));
const CORES = cpus().length;
const W = Math.round(Math.sqrt(MP * 1e6 * 1.5) / 2) * 2;
const H = Math.round((MP * 1e6) / W / 2) * 2;

const MIME = new Map([[".js", "text/javascript"], [".mjs", "text/javascript"], [".wasm", "application/wasm"], [".html", "text/html"], [".json", "application/json"], [".map", "application/json"]]);
const HEADERS = (type) => ({ "Content-Type": type, "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "cross-origin" });

const PAGE = `<!doctype html><meta charset=utf8><body><script type=module>
import { createEncoder, setForcedTier, detectTier } from '/packages/jxl-wasm/dist/index.js';
const log = (m) => { window.__log = (window.__log||'') + m + '\\n'; };
const median = (xs) => xs.slice().sort((a,b)=>a-b)[xs.length>>1];
function exactBuffer(v){ return v.byteOffset===0 && v.byteLength===v.buffer.byteLength ? v.buffer : v.buffer.slice(v.byteOffset, v.byteOffset+v.byteLength); }
async function encodeOnce(pixels, W, H, effort){
  const enc = createEncoder({ width:W, height:H, iccProfile:null, exif:null, xmp:null,
    distance:1.0, quality:90, effort, progressive:false, previewFirst:false, chunked:true,
    format:'rgba8', hasAlpha:true });
  const chunks=[]; let total=0;
  const task=(async()=>{ for await (const c of enc.chunks()){ const u=c instanceof Uint8Array?c:new Uint8Array(c); chunks.push(u); total+=u.byteLength; } })();
  await enc.pushPixels(exactBuffer(pixels));
  await enc.finish(); await task; await enc.dispose();
  return total;
}
(async () => {
  try {
    const tier = new URL(location.href).searchParams.get('tier') || 'simd';
    setForcedTier(tier);
    const iso = self.crossOriginIsolated;
    log('crossOriginIsolated='+iso+' detectTier='+detectTier()+' forced='+tier+' cores='+navigator.hardwareConcurrency);
    const W=${W}, H=${H};
    const pixels = new Uint8Array(W*H*4);
    let s=0x9e3779b9>>>0;
    for (let i=0;i<pixels.length;i++){ s=(s*1664525+1013904223)>>>0; pixels[i]=(s>>>24)&0xff; }
    // warm (also triggers module load + pthread pool spawn)
    let bytes = await encodeOnce(pixels, W, H, ${EFFORT});
    const times=[];
    for (let r=0;r<${REPS};r++){ const t0=performance.now(); bytes=await encodeOnce(pixels, W, H, ${EFFORT}); times.push(performance.now()-t0); }
    window.__result = { ok:true, tier, W, H, mp:+(W*H/1e6).toFixed(1), effort:${EFFORT}, medianMs:+median(times).toFixed(1), minMs:+Math.min(...times).toFixed(1), bytes, iso, detected:detectTier() };
  } catch (e) { window.__result = { ok:false, error: String(e && (e.stack||e.message) || e) }; }
})();
</script>`;

function startServer() {
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/") { res.writeHead(200, HEADERS("text/html")); res.end(PAGE); return; }
    const full = normalize(join(REPO, decodeURIComponent(u.pathname).replace(/^\/+/, "")));
    const rel = relative(REPO, full);
    if (rel.startsWith("..") || rel.split(sep).includes("..")) { res.writeHead(403, HEADERS("text/plain")); res.end("no"); return; }
    let data;
    try { data = readFileSync(full); }
    catch { console.error("[404]", u.pathname); res.writeHead(404, HEADERS("text/plain")); res.end("404 " + u.pathname); return; }
    res.writeHead(200, HEADERS(MIME.get(extname(full).toLowerCase()) ?? "application/octet-stream")); res.end(data);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port })));
}

async function runOnce(browser, port, tier) {
  const page = await browser.newPage();
  let logs = "";
  page.on("console", (m) => { logs += "[page] " + m.text() + "\n"; });
  page.on("pageerror", (e) => { logs += "[pageerror] " + (e.stack || e.message) + "\n"; });
  page.on("requestfailed", (r) => { logs += "[reqfail] " + r.url() + " " + (r.failure()?.errorText || "") + "\n"; });
  await page.goto(`http://127.0.0.1:${port}/?tier=${tier}`, { waitUntil: "load" });
  let result;
  try {
    await page.waitForFunction(() => window.__result !== undefined, { timeout: 300000 });
    result = await page.evaluate(() => window.__result);
  } catch (e) { result = { ok: false, error: "timeout: " + e.message }; }
  result.log = ((await page.evaluate(() => window.__log || "").catch(() => "")) + "\n" + logs).trim();
  await page.close();
  return result;
}

const { server, port } = await startServer();
const browser = await chromium.launch({ headless: true, args: ["--enable-features=SharedArrayBuffer"] });
const runs = { st: [], mt: [] };
try {
  for (let round = 0; round < 2; round++) {
    const order = round % 2 ? [["mt", "simd-mt"], ["st", "simd"]] : [["st", "simd"], ["mt", "simd-mt"]];
    for (const [k, tier] of order) {
      const r = await runOnce(browser, port, tier);
      if (!r.ok) { console.error(`run ${k} (${tier}) FAILED:\n${r.log}`); await browser.close(); server.close(); process.exit(1); }
      runs[k].push(r);
    }
  }
} finally { await browser.close(); server.close(); }

const med = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
const stMed = med(runs.st.map(r => r.medianMs));
const mtMed = med(runs.mt.map(r => r.medianMs));
const st0 = runs.st[0], mt0 = runs.mt[0];
const sizeMatch = st0.bytes === mt0.bytes;
const speedup = stMed / mtMed, pct = (speedup - 1) * 100;
console.log(st0.log);
console.log(`\nencode-mt-bench  ${st0.W}×${st0.H} = ${st0.mp} MP  effort=${EFFORT}  cores=${CORES}  reps=${REPS}`);
console.log(`crossOriginIsolated: ${st0.iso}`);
console.log(`ST tier=simd      detected=${st0.detected}  ${stMed.toFixed(0)} ms/encode  → ${st0.bytes} bytes`);
console.log(`MT tier=simd-mt   detected=${mt0.detected}  ${mtMed.toFixed(0)} ms/encode  → ${mt0.bytes} bytes`);
console.log(`output size match (ST==MT): ${sizeMatch ? "YES" : "NO (st="+st0.bytes+" mt="+mt0.bytes+")"}`);
console.log(`realized encode speedup: ${speedup.toFixed(2)}×  (+${pct.toFixed(0)}%)`);
