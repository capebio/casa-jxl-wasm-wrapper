// Flipflop runner: interleave the two native libjxl builds (0.11.2 vs 012 fork)
// over the full-res RGB corpus, round by round (thermal cancels). Each exe prints
// one JSON line per file per call. We alternate A/B each round, median across
// rounds, then emit a self-contained HTML graph + a console table.
//
// Run: node benchmark/run-jxl-ab-flipflop.mjs [rounds] [effort]
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const ROUNDS = parseInt(process.argv[2] || "6", 10);
const EFFORT = parseInt(process.argv[3] || "3", 10);
const RGB_DIR = String.raw`C:\Tmp\rcw-rgb`;
const SIDES = [
  { tag: "0112", label: "libjxl 0.11.2", exe: String.raw`C:\temp\jxl_ab_0112.exe`, color: "#c0653a" },
  { tag: "012",  label: "libjxl 012 (fork)", exe: String.raw`C:\temp\jxl_ab_012.exe`, color: "#3a7bc0" },
];

function runOnce(side) {
  const out = execFileSync(side.exe, [RGB_DIR], {
    env: { ...process.env, EFFORT: String(EFFORT), ROUNDS: "1", TAG: side.tag },
    maxBuffer: 64 * 1024 * 1024, encoding: "utf8",
  });
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const s = line.trim();
    if (s.startsWith("{") && s.endsWith("}")) { try { rows.push(JSON.parse(s)); } catch {} }
  }
  return rows;
}

// acc[file][tag] = { enc:[], dec:[], bytes, butter, w, h, mp }
const acc = {};
function stash(side, rows) {
  for (const r of rows) {
    (acc[r.file] ??= {});
    const a = (acc[r.file][side.tag] ??= { enc: [], dec: [], bytes: 0, butter: 0, w: r.w, h: r.h, mp: r.mp });
    a.enc.push(r.enc_ms); a.dec.push(r.dec_ms); a.bytes = r.bytes; a.butter = r.butter;
  }
}

console.log(`flipflop: ${ROUNDS} rounds, effort ${EFFORT}, interleaved A/B\n`);
for (let r = 0; r < ROUNDS; r++) {
  // alternate which side leads each round to further decorrelate thermal drift
  const order = r % 2 === 0 ? SIDES : [...SIDES].reverse();
  for (const side of order) stash(side, runOnce(side));
  process.stdout.write(`  round ${r + 1}/${ROUNDS} done\r`);
}
console.log("\n");

const med = (v) => { if (!v.length) return 0; const a = v.slice().sort((x, y) => x - y); return a[a.length >> 1]; };

// Build per-file comparison rows
const files = Object.keys(acc).sort((a, b) => (acc[a]["012"]?.mp || 0) - (acc[b]["012"]?.mp || 0));
const results = [];
for (const f of files) {
  const A = acc[f]["0112"], B = acc[f]["012"];
  if (!A || !B) continue;
  const encA = med(A.enc), encB = med(B.enc), decA = med(A.dec), decB = med(B.dec);
  results.push({
    file: f, mp: B.mp, w: B.w, h: B.h,
    enc_0112: encA, enc_012: encB, enc_spd: encA / Math.max(1e-9, encB),
    dec_0112: decA, dec_012: decB, dec_spd: decA / Math.max(1e-9, decB),
    bytes_0112: A.bytes, bytes_012: B.bytes, size_ratio: B.bytes / Math.max(1, A.bytes),
    butter_0112: A.butter, butter_012: B.butter,
  });
}

// --- console table ---
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);
console.log(pad("file", 30) + padl("MP", 6) + padl("enc11.2", 9) + padl("enc012", 8) + padl("x", 6) + padl("dec11.2", 9) + padl("dec012", 8) + padl("x", 6) + padl("KB11.2", 9) + padl("KB012", 8));
let encGeoA = 1, encGeoB = 1, decGeoA = 1, decGeoB = 1, n = 0;
for (const r of results) {
  console.log(
    pad(r.file.slice(0, 29), 30) + padl(r.mp.toFixed(1), 6) +
    padl(r.enc_0112.toFixed(0), 9) + padl(r.enc_012.toFixed(0), 8) + padl(r.enc_spd.toFixed(2) + "x", 6) +
    padl(r.dec_0112.toFixed(0), 9) + padl(r.dec_012.toFixed(0), 8) + padl(r.dec_spd.toFixed(2) + "x", 6) +
    padl((r.bytes_0112 / 1024).toFixed(0), 9) + padl((r.bytes_012 / 1024).toFixed(0), 8)
  );
  encGeoA *= r.enc_0112; encGeoB *= r.enc_012; decGeoA *= r.dec_0112; decGeoB *= r.dec_012; n++;
}
const g = (p, m) => Math.pow(p, 1 / m);
const encSpdGeo = g(encGeoA, n) / g(encGeoB, n);
const decSpdGeo = g(decGeoA, n) / g(decGeoB, n);
const sizeGeo = (() => { let p = 1; for (const r of results) p *= r.size_ratio; return Math.pow(p, 1 / results.length); })();
console.log(`\ngeomean: encode ${encSpdGeo.toFixed(3)}x  decode ${decSpdGeo.toFixed(3)}x  size(012/11.2) ${sizeGeo.toFixed(3)}x   (>1 = 012 faster / smaller)`);

// --- self-contained SVG graph ---
function barChart(title, unit, rows, valA, valB, fmtVal) {
  const W = 920, rowH = 34, top = 54, left = 250, maxBarW = 560;
  const H = top + rows.length * rowH + 30;
  const maxV = Math.max(...rows.flatMap(r => [valA(r), valB(r)])) || 1;
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="background:#fff;font-family:Segoe UI,system-ui,sans-serif">`;
  s += `<text x="${left}" y="26" font-size="18" font-weight="600" fill="#222">${title}</text>`;
  s += `<text x="${left}" y="44" font-size="12" fill="#888">${unit} — top bar 0.11.2, bottom bar 012; shorter = faster</text>`;
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const a = valA(r), b = valB(r);
    const wa = (a / maxV) * maxBarW, wb = (b / maxV) * maxBarW;
    s += `<text x="${left - 8}" y="${y + 15}" font-size="11" text-anchor="end" fill="#444">${r.file.slice(0, 32)} <tspan fill="#aaa">${r.mp.toFixed(1)}MP</tspan></text>`;
    s += `<rect x="${left}" y="${y + 2}" width="${wa.toFixed(1)}" height="11" fill="#c0653a"/>`;
    s += `<text x="${left + wa + 5}" y="${y + 12}" font-size="10" fill="#c0653a">${fmtVal(a)}</text>`;
    s += `<rect x="${left}" y="${y + 15}" width="${wb.toFixed(1)}" height="11" fill="#3a7bc0"/>`;
    s += `<text x="${left + wb + 5}" y="${y + 25}" font-size="10" fill="#3a7bc0">${fmtVal(b)}</text>`;
    const spd = a / Math.max(1e-9, b);
    s += `<text x="${W - 8}" y="${y + 18}" font-size="11" text-anchor="end" fill="${spd >= 1 ? '#2a8' : '#c33'}">${spd.toFixed(2)}x</text>`;
  });
  s += `</svg>`;
  return s;
}

const stamp = process.env.RUN_STAMP || "";
const html = `<!doctype html><html><head><meta charset="utf8"><title>libjxl 0.11.2 vs 012 — full-res RAW JXL enc/dec</title>
<style>body{font-family:Segoe UI,system-ui,sans-serif;margin:24px;color:#222;background:#fafafa}
h1{font-size:22px}.legend span{display:inline-block;margin-right:16px;font-size:13px}
.sw{display:inline-block;width:12px;height:12px;border-radius:2px;vertical-align:middle;margin-right:4px}
table{border-collapse:collapse;margin-top:16px;font-size:12px}td,th{border:1px solid #ddd;padding:4px 8px;text-align:right}
th:first-child,td:first-child{text-align:left}.g{color:#2a8}.r{color:#c33}.sec{margin:28px 0}</style></head><body>
<h1>libjxl 0.11.2 vs 012 (fork) — full-resolution RAW → JXL encode + decode</h1>
<p style="color:#666">effort ${EFFORT}, distance 1.0, ${ROUNDS}-round interleaved flipflop median, single-thread. ${stamp}</p>
<div class="legend"><span><span class="sw" style="background:#c0653a"></span>libjxl 0.11.2</span><span><span class="sw" style="background:#3a7bc0"></span>libjxl 012 (fork)</span><span>right number = 0.11.2/012 speedup (&gt;1 green = 012 faster)</span></div>
<div class="sec">${barChart("Encode time", "ms", results, r => r.enc_0112, r => r.enc_012, v => v.toFixed(0) + "ms")}</div>
<div class="sec">${barChart("Decode time", "ms", results, r => r.dec_0112, r => r.dec_012, v => v.toFixed(0) + "ms")}</div>
<div class="sec">${barChart("Encoded size", "KB", results, r => r.bytes_0112 / 1024, r => r.bytes_012 / 1024, v => v.toFixed(0) + "KB")}</div>
<h3>Geomean: encode <b class="${encSpdGeo>=1?'g':'r'}">${encSpdGeo.toFixed(3)}x</b> · decode <b class="${decSpdGeo>=1?'g':'r'}">${decSpdGeo.toFixed(3)}x</b> · size 012/11.2 <b class="${sizeGeo<=1?'g':'r'}">${sizeGeo.toFixed(3)}x</b></h3>
<table><tr><th>file</th><th>MP</th><th>enc 11.2</th><th>enc 012</th><th>x</th><th>dec 11.2</th><th>dec 012</th><th>x</th><th>KB 11.2</th><th>KB 012</th><th>butter 11.2</th><th>butter 012</th></tr>
${results.map(r => `<tr><td>${r.file}</td><td>${r.mp.toFixed(1)}</td><td>${r.enc_0112.toFixed(0)}</td><td>${r.enc_012.toFixed(0)}</td><td class="${r.enc_spd>=1?'g':'r'}">${r.enc_spd.toFixed(2)}</td><td>${r.dec_0112.toFixed(0)}</td><td>${r.dec_012.toFixed(0)}</td><td class="${r.dec_spd>=1?'g':'r'}">${r.dec_spd.toFixed(2)}</td><td>${(r.bytes_0112/1024).toFixed(0)}</td><td>${(r.bytes_012/1024).toFixed(0)}</td><td>${r.butter_0112.toFixed(4)}</td><td>${r.butter_012.toFixed(4)}</td></tr>`).join("\n")}
</table></body></html>`;

const outDir = String.raw`C:\Foo\raw-converter-wasm\docs\outputs\timing tests`;
const htmlPath = `${outDir}\\jxl-0112-vs-012-e${EFFORT}.html`;
const jsonPath = `${outDir}\\jxl-0112-vs-012-e${EFFORT}.json`;
writeFileSync(htmlPath, html);
writeFileSync(jsonPath, JSON.stringify({ rounds: ROUNDS, effort: EFFORT, encSpdGeo, decSpdGeo, sizeGeo, results }, null, 2));
console.log(`\ngraph -> ${htmlPath}\njson  -> ${jsonPath}`);
