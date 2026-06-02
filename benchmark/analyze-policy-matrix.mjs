// Analyze policy-matrix CSV: per (effort, quality|LL, progressive, resampling),
// compare modular -1/0/1 by encodeMs + bytes. Surface which conditions favor each.
import { readFileSync } from "node:fs";
import { argv } from "node:process";

const CSV = argv[2];
if (!CSV) { console.error("usage: node analyze-policy-matrix.mjs <csv>"); process.exit(1); }

const raw = readFileSync(CSV, "utf8");
const lines = raw.split(/\r?\n/).filter(l => l.length);
const header = lines.shift().split(",");
const idx = Object.fromEntries(header.map((h, i) => [h, i]));

const rows = [];
for (const line of lines) {
  const f = line.split(",");
  if (f[idx.status] !== "ok") continue;
  rows.push({
    effort: +f[idx.effort], quality: +f[idx.quality], lossless: +f[idx.lossless],
    progressive: +f[idx.progressive], modular: +f[idx.modular], resampling: +f[idx.resampling],
    encodeMs: +f[idx.encodeMs], bytes: +f[idx.bytes],
  });
}
console.log(`parsed ${rows.length} ok rows`);

// Build (effort, qLabel, progressive, resampling) → {mod[-1|0|1]: {ms, bytes}}
const groups = new Map();
const qLabel = r => r.lossless ? "LL" : `q${r.quality}`;
for (const r of rows) {
  const k = `e${r.effort}|${qLabel(r)}|prog${r.progressive}|rs${r.resampling}`;
  let g = groups.get(k);
  if (!g) { g = { key: k, e: r.effort, qLabel: qLabel(r), prog: r.progressive, rs: r.resampling, mod: {} }; groups.set(k, g); }
  g.mod[r.modular] = { ms: r.encodeMs, bytes: r.bytes };
}

// Best-modular per group + speedup-vs-auto
const enriched = [];
for (const g of groups.values()) {
  const m = g.mod;
  if (!(m[-1] && m[0] && m[1])) continue;
  const best = [-1, 0, 1].reduce((a, b) => m[a].ms < m[b].ms ? a : b);
  const worst = [-1, 0, 1].reduce((a, b) => m[a].ms > m[b].ms ? a : b);
  enriched.push({
    ...g, best, worst,
    ms: m,
    auto_vs_modular: m[-1].ms / m[1].ms,   // <1 means auto faster than modular
    auto_vs_vardct:  m[-1].ms / m[0].ms,
    bytes_mod_vs_auto: m[1].bytes / m[-1].bytes,
    bytes_var_vs_auto: m[0].bytes / m[-1].bytes,
  });
}

console.log(`\n${enriched.length} comparison groups`);

// Tally best-modular by condition
const bestCounts = { "-1": 0, "0": 0, "1": 0 };
for (const e of enriched) bestCounts[e.best]++;
console.log(`\nBEST modular tally: auto(-1)=${bestCounts["-1"]}  VarDCT(0)=${bestCounts["0"]}  Modular(1)=${bestCounts["1"]}`);

// Where Modular(1) is best
const modWins = enriched.filter(e => e.best === 1);
console.log(`\n── Conditions where Modular(1) wins on speed (${modWins.length}) ─────────────`);
console.log(`  cond                            mod_ms   auto_ms  var_ms   Δsize_mod_vs_auto`);
for (const e of modWins.sort((a,b)=>b.auto_vs_modular - a.auto_vs_modular)) {
  console.log(`  ${e.key.padEnd(32)} ${e.ms[1].ms.toFixed(0).padStart(6)}  ${e.ms[-1].ms.toFixed(0).padStart(7)}  ${e.ms[0].ms.toFixed(0).padStart(6)}  ${((e.bytes_mod_vs_auto-1)*100).toFixed(0).padStart(5)}%`);
}

// Where VarDCT(0) explicit beats auto
const vardctWins = enriched.filter(e => e.best === 0);
console.log(`\n── Conditions where explicit VarDCT(0) beats auto (${vardctWins.length}) ─────`);
for (const e of vardctWins.sort((a,b)=>b.auto_vs_vardct - a.auto_vs_vardct).slice(0,15)) {
  console.log(`  ${e.key.padEnd(32)} var=${e.ms[0].ms.toFixed(0).padStart(5)}ms auto=${e.ms[-1].ms.toFixed(0).padStart(5)}ms  ratio=${e.auto_vs_vardct.toFixed(2)}x`);
}

// Mean speedup of modular-1 vs auto, by single axis
function summaryBy(arr, keyFn, label) {
  const m = new Map();
  for (const e of arr) {
    const k = keyFn(e);
    let v = m.get(k); if (!v) { v = { sum: 0, n: 0, wins: 0, sizeSum: 0 }; m.set(k, v); }
    v.sum += e.auto_vs_modular; v.n++;
    if (e.best === 1) v.wins++;
    v.sizeSum += (e.bytes_mod_vs_auto - 1) * 100;
  }
  console.log(`\n── ${label}: speedup of Modular(1) over auto, win-rate, mean size penalty ─`);
  [...m.entries()].sort(([a],[b])=>String(a).localeCompare(String(b))).forEach(([k,v]) =>
    console.log(`  ${String(k).padEnd(12)} mean=${(v.sum/v.n).toFixed(2)}x  modular-wins=${v.wins}/${v.n}  Δsize=${(v.sizeSum/v.n).toFixed(0)}%`));
}
summaryBy(enriched, e => `e${e.e}`, "BY EFFORT");
summaryBy(enriched, e => e.qLabel, "BY QUALITY");
summaryBy(enriched, e => `prog${e.prog}`, "BY PROGRESSIVE");
summaryBy(enriched, e => `rs${e.rs}`, "BY RESAMPLING");

// Crosstab: which conditions to switch viewer preset to modular?
console.log(`\n── Recommended preset rule sketches ──────────────────────────────`);
// Rule: lossless + rs=1 → modular fastest?
const llRs1 = enriched.filter(e => e.qLabel === "LL" && e.rs === 1);
console.log(`Lossless full-res (LL, rs=1): ${llRs1.length} groups, best modular tally: ${["-1","0","1"].map(k=>`${k}=${llRs1.filter(x=>String(x.best)===k).length}`).join("  ")}`);
const lossy = enriched.filter(e => e.qLabel !== "LL");
console.log(`Lossy (any q): ${lossy.length} groups, best modular tally: ${["-1","0","1"].map(k=>`${k}=${lossy.filter(x=>String(x.best)===k).length}`).join("  ")}`);
const rs2 = enriched.filter(e => e.rs === 2);
console.log(`Resampling=2: ${rs2.length} groups, best modular tally: ${["-1","0","1"].map(k=>`${k}=${rs2.filter(x=>String(x.best)===k).length}`).join("  ")}`);
const rs4 = enriched.filter(e => e.rs === 4);
console.log(`Resampling=4: ${rs4.length} groups, best modular tally: ${["-1","0","1"].map(k=>`${k}=${rs4.filter(x=>String(x.best)===k).length}`).join("  ")}`);
