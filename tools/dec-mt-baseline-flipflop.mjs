// MT-tier dec WASM flipflop, deadlock-safe: ONE fresh page per variant (page close
// tears down the emscripten pthread pool — no in-page module reload, no pool
// accumulation/deadlock). COOP/COEP -> crossOriginIsolated -> SharedArrayBuffer + pthreads.
// OLD = b4a55047 dec.simd-mt (from C:/Temp/dec-flipflop-old), NEW = current dist. No rebuild.
//
//   node tools/dec-mt-baseline-flipflop.mjs
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { normalize, join, extname } from "node:path";
import { chromium } from "playwright";

const REPO = normalize(join(import.meta.dirname, ".."));
const DIST = join(REPO, "packages/jxl-wasm/dist");
const OLD = "C:/Temp/dec-flipflop-old";
const JXL = join(REPO, "docs/Benchmark results/P2200619-prog-p6-q85.jxl");
const REPS = 4;
const ROUNDS = 1;

// hard self-kill: cannot hang the session again
const KILL = setTimeout(() => { console.error("HARD TIMEOUT 5min — exiting"); process.exit(2); }, 300000);

const MIME = new Map([[".js", "text/javascript"], [".wasm", "application/wasm"], [".html", "text/html"]]);
const HEADERS = (t) => ({ "Content-Type": t, "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "cross-origin" });
const send = (res, code, type, data) => { res.writeHead(code, HEADERS(type)); res.end(data); };

// ONE module load for the page's whole life (dir = /dist or /old); no swaps.
const PAGE = (dir) => `<!doctype html><meta charset=utf8><body><script type=module>
import { createDecoder, setJxlModuleFactoryForTesting } from '/dist/facade.js';
const sum = d => { let s=0; for (let i=0;i<d.length;i+=1009) s=(s+d[i])>>>0; return (s^d.length)>>>0; };
setJxlModuleFactoryForTesting(async () => { const m=(await import('${dir}/jxl-core.dec.simd-mt.js')).default; return await m({ locateFile: p => '${dir}/'+p }); });
async function decodeOnce(bytes){
  const dec = createDecoder({ format:'rgba8', region:null, downsample:1, progressionTarget:'final', emitEveryPass:false, preserveIcc:false, preserveMetadata:false });
  let r=null;
  const task=(async()=>{ for await (const ev of dec.events()){ if(ev.type==='error') throw new Error(ev.message); if(ev.type==='final'){ const d=ev.pixels instanceof Uint8Array?ev.pixels:new Uint8Array(ev.pixels); r={w:ev.info.width,h:ev.info.height,sum:sum(d)}; } } })();
  dec.push(bytes); await Promise.resolve(); dec.close(); await task; await dec.dispose();
  if(!r) throw new Error('no final'); return r;
}
const median = xs => xs.slice().sort((a,b)=>a-b)[xs.length>>1];
const trim = xs => { const s=xs.slice().sort((a,b)=>a-b); const k=Math.floor(s.length*0.2); const t=s.slice(k,s.length-k); return t.reduce((a,b)=>a+b,0)/t.length; };
(async () => {
  try {
    if (!self.crossOriginIsolated) throw new Error('not crossOriginIsolated');
    const bytes = new Uint8Array(await (await fetch('/__jxl')).arrayBuffer());
    const t=[]; let dims='', s=0;
    const w0=performance.now(); const warm = await decodeOnce(bytes); dims = warm.w+'x'+warm.h; console.log('warm '+(performance.now()-w0).toFixed(0)+'ms hw='+navigator.hardwareConcurrency+' iso='+self.crossOriginIsolated);
    for (let i=0;i<${REPS};i++){ const t0=performance.now(); const res=await decodeOnce(bytes); const dt=performance.now()-t0; t.push(dt); s=res.sum; console.log('rep '+i+' '+dt.toFixed(0)+'ms'); }
    window.__result = { ok:true, iso:self.crossOriginIsolated, hc:navigator.hardwareConcurrency, dims, median:median(t), trim:trim(t), sum:s, n:t.length };
  } catch (e) { window.__result = { ok:false, error:String(e && (e.stack||e.message) || e) }; }
})();
</script>`;

function startServer() {
  const server = createServer((req, res) => {
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      const p = decodeURIComponent(u.pathname);
      if (p === "/old" || p === "/new") return send(res, 200, "text/html", PAGE(p));
      if (p === "/__jxl") return send(res, 200, "application/octet-stream", readFileSync(JXL));
      let base = null, rest = null;
      if (p.startsWith("/dist/")) { base = DIST; rest = p.slice(6); }
      else if (p.startsWith("/old/")) { base = OLD; rest = p.slice(5); }
      if (!base) return send(res, 404, "text/plain", "404 " + p);
      const full = normalize(join(base, rest));
      if (!full.startsWith(normalize(base))) return send(res, 403, "text/plain", "no");
      return send(res, 200, MIME.get(extname(full).toLowerCase()) ?? "application/octet-stream", readFileSync(full));
    } catch (e) { send(res, 404, "text/plain", "err " + e); }
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port })));
}

async function runVariant(browser, port, variant) {
  const ctx = await browser.newContext();          // fresh context => fresh worker pool
  const page = await ctx.newPage();
  let logs = "";
  page.on("console", m => { logs += "[page] " + m.text() + "\n"; });
  page.on("pageerror", e => { logs += "[pageerror] " + (e.stack || e.message) + "\n"; });
  await page.goto(`http://127.0.0.1:${port}/${variant}`, { waitUntil: "load" });
  let r;
  try { await page.waitForFunction(() => window.__result !== undefined, { timeout: 180000 }); r = await page.evaluate(() => window.__result); }
  catch (e) { r = { ok: false, error: "page timeout: " + e.message }; }
  console.log(`--- ${variant} ---\n${logs.trim()}`);
  await ctx.close();                               // tears down all pthread workers
  return r;
}

const { server, port } = await startServer();
const browser = await chromium.launch({ headless: true, args: ["--enable-features=SharedArrayBuffer"] });
const pooled = { old: [], new: [] }; const meta = {};
try {
  for (let round = 0; round < ROUNDS; round++) {
    const order = round % 2 ? ["new", "old"] : ["old", "new"];
    for (const v of order) {
      const r = await runVariant(browser, port, v);
      if (!r.ok) { console.error(`variant ${v} FAILED:\n${r.error}`); await browser.close(); server.close(); clearTimeout(KILL); process.exit(1); }
      pooled[v].push(r.median); meta[v] = r;
    }
  }
} finally { await browser.close(); server.close(); }
clearTimeout(KILL);

const med = xs => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
const mO = med(pooled.old), mN = med(pooled.new);
const dMed = ((mO - mN) / mO) * 100;
console.log(`\n=== MT-tier dec flipflop (dec.simd-mt, fresh-page-per-variant)  [${meta.old.dims}, hw=${meta.old.hc}, iso=${meta.old.iso}, ${ROUNDS} rounds x ${REPS} reps] ===`);
console.log(`  byte-exact OLD==NEW: ${meta.old.sum === meta.new.sum ? "YES" : "NO (!!)"}  (O=${meta.old.sum} N=${meta.new.sum})`);
console.log(`  OLD per-page medians ${pooled.old.map(x => x.toFixed(0)).join(",")} -> ${mO.toFixed(1)}ms`);
console.log(`  NEW per-page medians ${pooled.new.map(x => x.toFixed(0)).join(",")} -> ${mN.toFixed(1)}ms`);
console.log(`  NEW vs OLD (MT): ${dMed >= 0 ? "-" : "+"}${Math.abs(dMed).toFixed(1)}%  (negative = NEW slower)`);
