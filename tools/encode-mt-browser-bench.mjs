// Browser encode-MT bench: times the relaxed-simd-mt enc module encoding a PPM
// at effort 3 in real Chromium (COOP/COEP → SharedArrayBuffer → libjxl Web-Worker
// threads). Interleaved plain vs PGO, several rounds. min is the headline.
//   node encode-mt-browser-bench.mjs <ppm> [reps=15] [rounds=5]
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { chromium } from "playwright";

const DIST = "C:/Foo/raw-converter-wasm/packages/jxl-wasm/dist";
const PPM = process.argv[2] || "C:/Foo/raw-converter-wasm/packages/jxl-test-corpus/full/PXL_20260527_180319603.RAW-02.ORIGINAL.ppm";
const REPS = Number(process.argv[3] || 15);
const ROUNDS = Number(process.argv[4] || 5);
const MODS = { plain: "jxl-core.enc.relaxed-simd-mt.plain.js", pgo: "jxl-core.enc.relaxed-simd-mt.js" };

const MIME = new Map([[".js","text/javascript"],[".wasm","application/wasm"],[".html","text/html"]]);
const H = (t) => ({ "Content-Type": t, "Cross-Origin-Opener-Policy":"same-origin",
  "Cross-Origin-Embedder-Policy":"require-corp", "Cross-Origin-Resource-Policy":"cross-origin" });

const PAGE = (which) => `<!doctype html><meta charset=utf8><body><script type=module>
import createJxlModule from '/dist/${MODS[which]}';
const med = xs => xs.slice().sort((a,b)=>a-b)[xs.length>>1];
(async()=>{ try {
  if(!self.crossOriginIsolated) throw new Error('not crossOriginIsolated');
  const mod = await createJxlModule({ locateFile: f => '/dist/'+f });
  const ppm = new Uint8Array(await (await fetch('/__ppm')).arrayBuffer());
  // parse P6
  let i=0,tok=[]; const ws=b=>b===32||b===9||b===10||b===13;
  while(tok.length<4){ while(i<ppm.length&&ws(ppm[i]))i++; if(ppm[i]===35){while(i<ppm.length&&ppm[i]!==10)i++;continue;} let s=i; while(i<ppm.length&&!ws(ppm[i]))i++; tok.push(new TextDecoder().decode(ppm.subarray(s,i))); } i++;
  const w=+tok[1],h=+tok[2],off=i; const rgb=ppm.subarray(off,off+w*h*3);
  const rgba=new Uint8Array(w*h*4); for(let p=0,s=0,d=0;p<w*h;p++,s+=3,d+=4){rgba[d]=rgb[s];rgba[d+1]=rgb[s+1];rgba[d+2]=rgb[s+2];rgba[d+3]=255;}
  const enc=()=>{ const ptr=mod._malloc(rgba.length); mod.HEAPU8.set(rgba,ptr);
    const hd=mod._jxl_wasm_encode_tile_container_rgba8(ptr,w,h,256,1.0,3,0);
    let sz=0; if(hd){sz=mod._jxl_wasm_buffer_size(hd); mod._jxl_wasm_buffer_free(hd);} mod._free(ptr); return sz; };
  const kb=(enc()/1024)|0; const t=[];
  for(let r=0;r<${REPS};r++){ const a=performance.now(); enc(); t.push(performance.now()-a); }
  window.__result={ ok:true, w, h, kb, median:+med(t).toFixed(0), min:+Math.min(...t).toFixed(0), iso:self.crossOriginIsolated };
} catch(e){ window.__result={ ok:false, error:String(e&&(e.stack||e.message)||e) }; } })();
</script>`;

const server = createServer((req,res)=>{
  const u = new URL(req.url, "http://127.0.0.1");
  if (u.pathname === "/__ppm") { res.writeHead(200, H("application/octet-stream")); res.end(readFileSync(PPM)); return; }
  const m = u.searchParams.get("which");
  if (u.pathname === "/" ) { res.writeHead(200, H("text/html")); res.end(PAGE(m||"plain")); return; }
  if (u.pathname.startsWith("/dist/")) {
    const full = normalize(join(DIST, u.pathname.slice(6)));
    try { const d = readFileSync(full); res.writeHead(200, H(MIME.get(extname(full).toLowerCase())??"application/octet-stream")); res.end(d); }
    catch { res.writeHead(404, H("text/plain")); res.end("404"); } return;
  }
  res.writeHead(404, H("text/plain")); res.end("404");
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const port = server.address().port;
const browser = await chromium.launch({ headless:true, args:["--enable-features=SharedArrayBuffer"] });
async function run(which){
  const page = await browser.newPage(); let log="";
  page.on("console",m=>log+="[p] "+m.text()+"\n"); page.on("pageerror",e=>log+="[e] "+(e.stack||e.message)+"\n");
  await page.goto(`http://127.0.0.1:${port}/?which=${which}`,{waitUntil:"load"});
  let r; try{ await page.waitForFunction(()=>window.__result!==undefined,{timeout:180000}); r=await page.evaluate(()=>window.__result);}catch(e){r={ok:false,error:"timeout "+e.message,log};}
  if(!r.ok) r.log=log; await page.close(); return r;
}
console.log(`encode-mt browser bench  ${PPM.split(/[\\/]/).pop()}  reps=${REPS} rounds=${ROUNDS}`);
for (let rd=1; rd<=ROUNDS; rd++){
  const a = await run("plain"), b = await run("pgo");
  if(!a.ok){console.error("PLAIN FAIL:\n"+a.log); break;}
  if(!b.ok){console.error("PGO FAIL:\n"+b.log); break;}
  console.log(`R${rd} PLAIN median=${a.median} min=${a.min} ${a.kb}KB iso=${a.iso} | PGO median=${b.median} min=${b.min} ${b.kb}KB`);
}
await browser.close(); server.close();
