// Pipeline section bench runner — two modes:
//   relative  : current build vs the LAST persisted run (moving-forward regression detector)
//   absolute  : current build vs the libjxl 0.11.2 anchor (interleaved A/B, thermal-cancelled)
//
// Sections: raw_parse, demosaic, tone, encode, decode_full, ttfp, load_e2e, ttfp_e2e.
// 5-rep median. Emits a per-section grouped-bar HTML graph + console table + JSON history.
//
// Run: node benchmark/run-section-bench.mjs <relative|absolute> [reps] [effort]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const MODE = (process.argv[2] || "relative").toLowerCase();
const REPS = parseInt(process.argv[3] || "5", 10);
const EFFORT = parseInt(process.argv[4] || "3", 10);

const FILES = [
  String.raw`C:\Foo\raw-converter\tests\PXL_20260501_093507165.RAW-02.ORIGINAL.dng`,
  String.raw`C:\Foo\raw-converter\tests\ADH 1248.CR2`,
  String.raw`C:\Foo\raw-converter\tests\P1110226.ORF`,
];
const CURRENT_EXE = String.raw`C:\temp\psbench_main.exe`;   // built against current submodule main
const ANCHOR_EXE  = String.raw`C:\temp\psbench_0112.exe`;   // built against libjxl 0.11.2
const OUT_DIR     = String.raw`C:\Foo\raw-converter-wasm\docs\outputs\timing tests`;
const HIST_DIR    = String.raw`C:\Foo\raw-converter-wasm\docs\outputs\timing tests\section-history`;
const SECTIONS = ["raw_parse_ms","demosaic_ms","tone_ms","encode_ms","decode_full_ms","ttfp_ms","load_e2e_ms","ttfp_e2e_ms"];
const LABELS   = { raw_parse_ms:"raw parse", demosaic_ms:"demosaic", tone_ms:"tone", encode_ms:"encode", decode_full_ms:"decode full", ttfp_ms:"ttfp (decode)", load_e2e_ms:"LOAD e2e", ttfp_e2e_ms:"ttfp e2e" };
mkdirSync(OUT_DIR, { recursive: true }); mkdirSync(HIST_DIR, { recursive: true });

function runOnce(exe, tag) {
  const out = execFileSync(exe, FILES, { env: { ...process.env, EFFORT: String(EFFORT), ROUNDS: "1", TAG: tag }, maxBuffer: 64 << 20, encoding: "utf8" });
  const rows = [];
  for (const ln of out.split(/\r?\n/)) { const s = ln.trim(); if (s.startsWith("{") && s.endsWith("}")) { try { rows.push(JSON.parse(s)); } catch {} } }
  return rows;
}
const med = (v) => { if (!v.length) return 0; const a = v.slice().sort((x,y)=>x-y); return a[a.length>>1]; };

// Accumulate REPS into per-file per-section sample arrays for a given exe.
function measure(exe, tag) {
  const acc = {}; // file -> {fmt,mp, sec -> [samples]}
  for (let r = 0; r < REPS; r++) for (const row of runOnce(exe, tag)) {
    const a = (acc[row.file] ??= { fmt: row.fmt, mp: row.mp, bytes: row.bytes, s: {} });
    for (const k of SECTIONS) (a.s[k] ??= []).push(row[k]);
  }
  const out = {};
  for (const [file, a] of Object.entries(acc)) { out[file] = { fmt: a.fmt, mp: a.mp, bytes: a.bytes, s: {} }; for (const k of SECTIONS) out[file].s[k] = med(a.s[k]); }
  return out;
}

if (!existsSync(CURRENT_EXE)) { console.error(`missing ${CURRENT_EXE} — build pipeline_section_bench against current main first`); process.exit(1); }

console.log(`section-bench [${MODE}]  reps=${REPS} effort=${EFFORT}\n`);
const current = measure(CURRENT_EXE, "current");

let baseline, baseLabel, curLabel = "current";
if (MODE === "absolute") {
  if (!existsSync(ANCHOR_EXE)) { console.error(`missing ${ANCHOR_EXE} — build pipeline_section_bench against libjxl 0.11.2 (worktree C:\\Tmp\\libjxl-0112)`); process.exit(1); }
  // interleave the anchor in the same wall window for thermal fairness
  baseline = measure(ANCHOR_EXE, "anchor"); baseLabel = "0.11.2";
} else {
  const lastPath = `${HIST_DIR}\\section-bench-last.json`;
  if (!existsSync(lastPath)) { console.log("no previous run — saving this as the baseline. Re-run to see deltas."); writeFileSync(lastPath, JSON.stringify(current, null, 2)); process.exit(0); }
  baseline = JSON.parse(readFileSync(lastPath, "utf8")); baseLabel = "last run";
}

// ---- console table + collect for graph ----
const files = Object.keys(current);
for (const f of files) {
  const c = current[f], b = baseline[f]; if (!b) continue;
  console.log(`\n${f}  [${c.fmt}, ${c.mp.toFixed(1)} MP]`);
  console.log(`  ${"section".padEnd(14)}${baseLabel.padStart(10)}${curLabel.padStart(10)}${"x".padStart(8)}`);
  for (const k of SECTIONS) {
    const bv = b.s[k] ?? 0, cv = c.s[k] ?? 0, x = cv > 0 ? bv / cv : 0;
    const flag = (k === "load_e2e_ms") ? " <=" : "";
    console.log(`  ${LABELS[k].padEnd(14)}${bv.toFixed(1).padStart(10)}${cv.toFixed(1).padStart(10)}${(x.toFixed(2)+"x").padStart(8)}${flag}`);
  }
}

// ---- per-section grouped-bar SVG (one panel per file) ----
function panel(file) {
  const c = current[file], b = baseline[file];
  const W = 900, rowH = 30, top = 56, left = 130, maxBar = 560;
  const H = top + SECTIONS.length * rowH + 20;
  const maxV = Math.max(...SECTIONS.flatMap(k => [b.s[k] ?? 0, c.s[k] ?? 0])) || 1;
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="background:#fff;font-family:Segoe UI,system-ui,sans-serif">`;
  s += `<text x="${left}" y="24" font-size="16" font-weight="600" fill="#222">${file.split("\\").pop()} <tspan fill="#999">${c.fmt} ${c.mp.toFixed(1)}MP</tspan></text>`;
  s += `<text x="${left}" y="44" font-size="11" fill="#888">top bar ${baseLabel}, bottom bar current; shorter = faster; right = ${baseLabel}/current</text>`;
  SECTIONS.forEach((k, i) => {
    const y = top + i * rowH, bv = b.s[k] ?? 0, cv = c.s[k] ?? 0;
    const wb = (bv / maxV) * maxBar, wc = (cv / maxV) * maxBar, x = cv > 0 ? bv / cv : 0;
    const hl = k === "load_e2e_ms" || k === "ttfp_ms";
    s += `<text x="${left-6}" y="${y+13}" font-size="11" text-anchor="end" fill="${hl?'#222':'#555'}" font-weight="${hl?'700':'400'}">${LABELS[k]}</text>`;
    s += `<rect x="${left}" y="${y+1}" width="${wb.toFixed(1)}" height="9" fill="#c0653a"/><text x="${left+wb+4}" y="${y+9}" font-size="9" fill="#c0653a">${bv.toFixed(0)}</text>`;
    s += `<rect x="${left}" y="${y+12}" width="${wc.toFixed(1)}" height="9" fill="#3a7bc0"/><text x="${left+wc+4}" y="${y+20}" font-size="9" fill="#3a7bc0">${cv.toFixed(0)}</text>`;
    s += `<text x="${W-8}" y="${y+15}" font-size="11" text-anchor="end" fill="${x>=1?'#2a8':'#c33'}">${x.toFixed(2)}x</text>`;
  });
  return s + `</svg>`;
}
const stampTag = MODE === "absolute" ? "e"+EFFORT+"-vs-0112" : "e"+EFFORT+"-vs-last";
const html = `<!doctype html><html><head><meta charset="utf8"><title>section bench ${MODE}</title>
<style>body{font-family:Segoe UI,system-ui,sans-serif;margin:24px;background:#fafafa;color:#222}h1{font-size:20px}
.legend span{margin-right:16px;font-size:13px}.sw{display:inline-block;width:12px;height:12px;border-radius:2px;vertical-align:middle;margin-right:4px}.sec{margin:22px 0}</style></head><body>
<h1>Pipeline section bench — ${MODE} (current vs ${baseLabel})</h1>
<p style="color:#666">effort ${EFFORT}, ${REPS}-rep median${MODE==="absolute"?", interleaved A/B":""}. Sections attribute where a change landed; <b>LOAD e2e</b> = RAW→full image in lightbox; <b>ttfp</b> = first paint.</p>
<div class="legend"><span><span class="sw" style="background:#c0653a"></span>${baseLabel}</span><span><span class="sw" style="background:#3a7bc0"></span>current</span><span>right number = ${baseLabel}/current (&gt;1 green = current faster)</span></div>
${files.filter(f=>baseline[f]).map(f=>`<div class="sec">${panel(f)}</div>`).join("\n")}
</body></html>`;
writeFileSync(`${OUT_DIR}\\section-bench-${stampTag}.html`, html);
writeFileSync(`${OUT_DIR}\\section-bench-${stampTag}.json`, JSON.stringify({ mode: MODE, reps: REPS, effort: EFFORT, baseLabel, current, baseline }, null, 2));
if (MODE === "relative") writeFileSync(`${HIST_DIR}\\section-bench-last.json`, JSON.stringify(current, null, 2));
console.log(`\ngraph -> ${OUT_DIR}\\section-bench-${stampTag}.html`);
console.log(`json  -> ${OUT_DIR}\\section-bench-${stampTag}.json`);
if (MODE === "relative") console.log(`history updated -> ${HIST_DIR}\\section-bench-last.json`);
