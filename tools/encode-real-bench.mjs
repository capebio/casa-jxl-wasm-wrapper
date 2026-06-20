#!/usr/bin/env node
// encode-real-bench — REAL-image JXL encode timing (random noise is worst-case;
// real photos encode far faster). Decodes a real RAW → RGBA (shipped pkg, ST — decode
// time is not measured), then encodes via the jxl-wasm facade at a forced tier +
// effort + distance, in a COOP/COEP browser so the simd-mt pthread tier engages.
// Goal: find settings/levers that bring full-res encode under 1 second.
//
//   node tools/encode-real-bench.mjs [--file <raw>] [--tier simd-mt] [--effort 7] [--dist 1.0] [--reps 3]
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, normalize, relative, sep, extname } from "node:path";
import { chromium } from "playwright";
import { cpus } from "node:os";

const REPO = normalize(join(import.meta.dirname, ".."));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const FILE = argv("--file", "C:/Foo/raw-converter/tests/_MG_1750.CR2");
const TIER = argv("--tier", "simd-mt");
const EFFORT = Number(argv("--effort", "7"));
const DIST = Number(argv("--dist", "1.0"));
const REPS = Number(argv("--reps", "3"));
const LOSSLESS = args.includes("--lossless");
const FN = { ".orf": "process_orf_with_flags", ".dng": "process_dng_with_flags", ".cr2": "process_cr2_with_flags" }[extname(FILE).toLowerCase()];

const MIME = new Map([[".js", "text/javascript"], [".wasm", "application/wasm"], [".html", "text/html"], [".json", "application/json"]]);
const HEADERS = (t) => ({ "Content-Type": t, "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "cross-origin" });

const PAGE = `<!doctype html><meta charset=utf8><body><script type=module>
import initRaw, { ${FN} } from '/pkg/raw_converter_wasm.js';
import { createEncoder, setForcedTier, detectTier } from '/packages/jxl-wasm/dist/index.js';
const log = (m) => { window.__log = (window.__log||'') + m + '\\n'; };
const median = (xs) => xs.slice().sort((a,b)=>a-b)[xs.length>>1];
function exactBuffer(v){ return v.byteOffset===0 && v.byteLength===v.buffer.byteLength ? v.buffer : v.buffer.slice(v.byteOffset, v.byteOffset+v.byteLength); }
async function encodeOnce(rgba, W, H, effort, dist, lossless, hasAlpha){
  const enc = createEncoder({ width:W, height:H, iccProfile:null, exif:null, xmp:null,
    distance: lossless?0:dist, quality: lossless?100:90, lossless, effort, progressive:false, previewFirst:false, chunked:true,
    format:'rgba8', hasAlpha });
  const chunks=[]; let total=0;
  const task=(async()=>{ for await (const c of enc.chunks()){ const u=c instanceof Uint8Array?c:new Uint8Array(c); chunks.push(u); total+=u.byteLength; } })();
  await enc.pushPixels(exactBuffer(rgba));
  await enc.finish(); await task; await enc.dispose();
  return total;
}
(async () => {
  try {
    const q = new URL(location.href).searchParams;
    const tier=q.get('tier'), effort=+q.get('effort'), dist=+q.get('dist'), lossless=q.get('lossless')==='1';
    const alpha=q.get('alpha')!=='0';
    setForcedTier(tier);
    await initRaw();
    log('crossOriginIsolated='+self.crossOriginIsolated+' detectTier='+detectTier()+' forced='+tier+' cores='+navigator.hardwareConcurrency);
    const raw = new Uint8Array(await (await fetch('/__file')).arrayBuffer());
    const res = ${FN}(raw, 1, 0,0,0,0,0,0, 0,0,0,0, NaN, NaN, 0, 0);
    const rgba = res.take_rgba(); const W=res.width, H=res.height; if(res.free) res.free();
    log('decoded '+W+'x'+H+' ('+(W*H/1e6).toFixed(1)+'MP) rgba='+rgba.length);
    let bytes = await encodeOnce(rgba, W, H, effort, dist, lossless, alpha); // warm
    const times=[];
    for (let r=0;r<${REPS};r++){ const t0=performance.now(); bytes=await encodeOnce(rgba, W, H, effort, dist, lossless, alpha); times.push(performance.now()-t0); }
    window.__result = { ok:true, tier, effort, dist, lossless, alpha, W, H, mp:+(W*H/1e6).toFixed(1), medianMs:+median(times).toFixed(0), minMs:+Math.min(...times).toFixed(0), bytes, detected:detectTier() };
  } catch (e) { window.__result = { ok:false, error: String(e && (e.stack||e.message) || e) }; }
})();
</script>`;

function startServer() {
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/") { res.writeHead(200, HEADERS("text/html")); res.end(PAGE); return; }
    if (u.pathname === "/__file") { try { res.writeHead(200, HEADERS("application/octet-stream")); res.end(readFileSync(FILE)); } catch (e) { res.writeHead(404, HEADERS("text/plain")); res.end(String(e)); } return; }
    const full = normalize(join(REPO, decodeURIComponent(u.pathname).replace(/^\/+/, "")));
    const rel = relative(REPO, full);
    if (rel.startsWith("..") || rel.split(sep).includes("..")) { res.writeHead(403, HEADERS("text/plain")); res.end("no"); return; }
    let data; try { data = readFileSync(full); } catch { res.writeHead(404, HEADERS("text/plain")); res.end("404 " + u.pathname); return; }
    res.writeHead(200, HEADERS(MIME.get(extname(full).toLowerCase()) ?? "application/octet-stream")); res.end(data);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port })));
}

async function run(tier, effort, dist, lossless) {
  const { server, port } = await startServer();
  const browser = await chromium.launch({ headless: true, args: ["--enable-features=SharedArrayBuffer"] });
  try {
    const page = await browser.newPage();
    let logs = "";
    page.on("console", (m) => { logs += "[page] " + m.text() + "\n"; });
    page.on("pageerror", (e) => { logs += "[pageerror] " + (e.stack || e.message) + "\n"; });
    const ll = lossless ? "1" : "0";
    await page.goto(`http://127.0.0.1:${port}/?tier=${tier}&effort=${effort}&dist=${dist}&lossless=${ll}`, { waitUntil: "load" });
    let result;
    try { await page.waitForFunction(() => window.__result !== undefined, { timeout: 300000 }); result = await page.evaluate(() => window.__result); }
    catch (e) { result = { ok: false, error: "timeout: " + e.message }; }
    result.log = ((await page.evaluate(() => window.__log || "").catch(() => "")) + "\n" + logs).trim();
    return result;
  } finally { await browser.close(); server.close(); }
}

const r = await run(TIER, EFFORT, DIST, LOSSLESS);
if (!r.ok) { console.error("FAILED:\n" + r.log.split("\n").filter(l => !/take_chunk|facade profile/.test(l)).join("\n")); process.exit(1); }
console.log(r.log.split("\n").filter(l => /crossOriginIsolated|decoded/.test(l)).join("\n"));
console.log(`\nencode-real-bench  ${FILE.split(/[\\/]/).pop()}  ${r.W}×${r.H} = ${r.mp}MP  tier=${r.tier}(${r.detected})  effort=${r.effort}  ${r.lossless?'LOSSLESS':'dist='+r.dist}  cores=${cpus().length}`);
console.log(`encode: ${r.medianMs} ms median (min ${r.minMs})  → ${(r.bytes/1e6).toFixed(2)} MB`);
console.log(`UNDER 1s: ${r.medianMs < 1000 ? "YES ✓" : "NO — " + r.medianMs + "ms"}`);
