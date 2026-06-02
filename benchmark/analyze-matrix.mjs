// Analyze jxl matrix CSV: where does modular=1 beat modular=0 (VarDCT)?
// Groups by (effort, quality, lossless, resampling, progressive) and compares
// median encodeMs across modular variants. Surfaces conditions where Modular wins.

import { readFileSync } from "node:fs";
import { argv } from "node:process";

const CSV = argv[2] || String.raw`C:\Foo\raw-converter-wasm\docs\Benchmark results\jxl-matrix-1780350537860.csv`;

const raw = readFileSync(CSV, "utf8");
const lines = raw.split(/\r?\n/).filter(l => l.length);
const header = lines.shift().split(",");
const idx = Object.fromEntries(header.map((h, i) => [h, i]));

function parseRow(line) {
  // simple CSV parse (no embedded commas in this file beyond quoted strings)
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

const rows = [];
for (const line of lines) {
  const f = parseRow(line);
  if (f[idx.status] !== "ok") continue;
  rows.push({
    variant: f[idx.wasmVariant],
    effort: +f[idx.effort],
    quality: +f[idx.quality],
    lossless: +f[idx.lossless],
    modular: +f[idx.modular],
    progressive: +f[idx.progressive],
    brotliEffort: +f[idx.brotliEffort],
    decodingSpeed: +f[idx.decodingSpeed],
    resampling: +f[idx.resampling],
    encodeMs: +f[idx.encodeMs],
    bytes: +f[idx.bytes],
  });
}
console.log(`parsed ${rows.length} ok rows`);

const median = a => { const s = [...a].sort((x,y)=>x-y); const m = Math.floor(s.length/2); return s.length%2 ? s[m] : (s[m-1]+s[m])/2; };

// Group by (effort, quality, lossless, resampling, progressive). Inside each group
// compute median encodeMs + bytes per modular value, then compute speedup of
// modular=1 vs modular=0 (and vs modular=-1).
const groups = new Map();
for (const r of rows) {
  const k = `${r.effort}|${r.quality}|${r.lossless}|${r.resampling}|${r.progressive}`;
  let g = groups.get(k);
  if (!g) { g = { e: r.effort, q: r.quality, ll: r.lossless, rs: r.resampling, prog: r.progressive, mod: {} }; groups.set(k, g); }
  (g.mod[r.modular] ??= []).push(r);
}

const comparisons = [];
for (const g of groups.values()) {
  const mAuto = g.mod[-1] ?? [];
  const mVarDCT = g.mod[0] ?? [];
  const mModular = g.mod[1] ?? [];
  if (!mModular.length || !mVarDCT.length) continue;
  const msMod = median(mModular.map(r => r.encodeMs));
  const msVar = median(mVarDCT.map(r => r.encodeMs));
  const msAuto = mAuto.length ? median(mAuto.map(r => r.encodeMs)) : null;
  const bMod = median(mModular.map(r => r.bytes));
  const bVar = median(mVarDCT.map(r => r.bytes));
  comparisons.push({
    effort: g.e, quality: g.q, lossless: g.ll, resampling: g.rs, progressive: g.prog,
    ms_modular: msMod, ms_vardct: msVar, ms_auto: msAuto,
    speedup_mod_over_var: msVar / msMod,
    bytes_modular: bMod, bytes_vardct: bVar,
    size_delta_pct: ((bMod - bVar) / bVar) * 100,
    n_mod: mModular.length, n_var: mVarDCT.length,
  });
}
console.log(`compared ${comparisons.length} (effort,quality,lossless,resampling,progressive) groups`);

const wins = comparisons.filter(c => c.speedup_mod_over_var > 1.0);
const losses = comparisons.filter(c => c.speedup_mod_over_var <= 1.0);
console.log(`\nModular FASTER than VarDCT in ${wins.length}/${comparisons.length} groups (${(wins.length/comparisons.length*100).toFixed(1)}%)`);

console.log(`\n── Top 20 Modular wins (speedup desc) ─────────────────────────────`);
wins.sort((a,b)=>b.speedup_mod_over_var - a.speedup_mod_over_var).slice(0,20).forEach(c =>
  console.log(`  e=${c.effort} q=${c.quality} ll=${c.lossless} rs=${c.resampling} prog=${c.progressive}  ${c.speedup_mod_over_var.toFixed(2)}x  (var=${c.ms_vardct.toFixed(1)}ms mod=${c.ms_modular.toFixed(1)}ms)  Δsize=${c.size_delta_pct.toFixed(1)}%`));

console.log(`\n── Top 10 Modular LOSSES (worst slowdown) ─────────────────────────`);
losses.sort((a,b)=>a.speedup_mod_over_var - b.speedup_mod_over_var).slice(0,10).forEach(c =>
  console.log(`  e=${c.effort} q=${c.quality} ll=${c.lossless} rs=${c.resampling} prog=${c.progressive}  ${c.speedup_mod_over_var.toFixed(2)}x  (var=${c.ms_vardct.toFixed(1)}ms mod=${c.ms_modular.toFixed(1)}ms)  Δsize=${c.size_delta_pct.toFixed(1)}%`));

// Slice by single axis: mean speedup per effort, per quality, per lossless, per resampling
function meanBy(arr, keyFn) {
  const m = new Map();
  for (const c of arr) {
    const k = keyFn(c);
    let v = m.get(k); if (!v) { v = { sum: 0, n: 0, wins: 0 }; m.set(k, v); }
    v.sum += c.speedup_mod_over_var; v.n++; if (c.speedup_mod_over_var > 1) v.wins++;
  }
  return [...m.entries()].map(([k, v]) => ({ key: k, mean_speedup: v.sum/v.n, win_rate: v.wins/v.n, n: v.n })).sort((a,b)=>a.key-b.key);
}

console.log(`\n── Mean modular/vardct speedup BY EFFORT ─────────────────────────`);
meanBy(comparisons, c => c.effort).forEach(r => console.log(`  effort=${r.key}: mean=${r.mean_speedup.toFixed(2)}x  win_rate=${(r.win_rate*100).toFixed(0)}%  n=${r.n}`));

console.log(`\n── Mean modular/vardct speedup BY QUALITY ────────────────────────`);
meanBy(comparisons, c => c.quality).forEach(r => console.log(`  quality=${r.key}: mean=${r.mean_speedup.toFixed(2)}x  win_rate=${(r.win_rate*100).toFixed(0)}%  n=${r.n}`));

console.log(`\n── Mean modular/vardct speedup BY LOSSLESS ───────────────────────`);
meanBy(comparisons, c => c.lossless).forEach(r => console.log(`  lossless=${r.key}: mean=${r.mean_speedup.toFixed(2)}x  win_rate=${(r.win_rate*100).toFixed(0)}%  n=${r.n}`));

console.log(`\n── Mean modular/vardct speedup BY RESAMPLING ─────────────────────`);
meanBy(comparisons, c => c.resampling).forEach(r => console.log(`  resampling=${r.key}: mean=${r.mean_speedup.toFixed(2)}x  win_rate=${(r.win_rate*100).toFixed(0)}%  n=${r.n}`));

console.log(`\n── Mean modular/vardct speedup BY PROGRESSIVE ────────────────────`);
meanBy(comparisons, c => c.progressive).forEach(r => console.log(`  progressive=${r.key}: mean=${r.mean_speedup.toFixed(2)}x  win_rate=${(r.win_rate*100).toFixed(0)}%  n=${r.n}`));

// 2D crosstab: effort x lossless
console.log(`\n── Crosstab effort × lossless (mean speedup) ─────────────────────`);
const ct = new Map();
for (const c of comparisons) {
  const k = `${c.effort}|${c.lossless}`;
  let v = ct.get(k); if (!v) { v = { sum: 0, n: 0 }; ct.set(k, v); }
  v.sum += c.speedup_mod_over_var; v.n++;
}
const efforts = [...new Set(comparisons.map(c=>c.effort))].sort((a,b)=>a-b);
console.log(`  effort | lossless=0       lossless=1`);
for (const e of efforts) {
  const v0 = ct.get(`${e}|0`); const v1 = ct.get(`${e}|1`);
  const s0 = v0 ? `${(v0.sum/v0.n).toFixed(2)}x (n=${v0.n})` : "—";
  const s1 = v1 ? `${(v1.sum/v1.n).toFixed(2)}x (n=${v1.n})` : "—";
  console.log(`  ${String(e).padStart(6)} | ${s0.padEnd(16)} ${s1}`);
}
