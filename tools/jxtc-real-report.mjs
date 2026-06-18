#!/usr/bin/env node
// jxtc-real-report — diagnostic report for the REAL-camera-file JXTC runs.
//
// Joins the two flipflop journal records produced by running the JXTC tests against real files:
//   jxtc-vs-full-decode  (full-image-decode+crop vs ROI decode)  → speedup
//   jxtc-encode          (e3-d0/d1/d2 encode time + compressed KB) → ingest cost + payback
// and decodes each file once to report its megapixels / tile count. Emits a markdown table.
//
// Prereqs (run both against the same folder, then this):
//   JXTC_REAL="<dir>" JXTC_PER_TYPE=3 JXTC_ROUNDS=4 node --expose-gc flipflop.mjs .flipflop/tests/jxtc-vs-full-decode.mjs --print
//   JXTC_REAL="<dir>" JXTC_PER_TYPE=1 JXTC_ROUNDS=3 node --expose-gc flipflop.mjs .flipflop/tests/jxtc-encode.mjs --print
//   node tools/jxtc-real-report.mjs --raw-dir "<dir>"
//
// Usage: node tools/jxtc-real-report.mjs --raw-dir "C:\Foo\raw-converter\tests" [--journal <path>] [--out <path>]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodeFileToRgba } from "../.flipflop/lib/raw-corpus.mjs";

const TILE = 256;
const DEFAULT_JOURNAL = "docs/outputs/timing tests/flipflop/flipflopjournal.toon";
const args = process.argv.slice(2);
const argVal = (f, d) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const rawDir = argVal("--raw-dir", "C:/Foo/raw-converter/tests");
const journalPath = argVal("--journal", DEFAULT_JOURNAL);
const today = new Date().toISOString().slice(0, 10);
const outPath = argVal("--out", `docs/outputs/jxtc-real-files-report-${today}.md`);

// Parse the LAST record for a given test name → { ts, env, byInput: {name:{variant:{...cols}}} }.
function parseRecord(text, testName) {
  const dequote = (s) => { if (s == null) return s; const t = s.trim(); return t.startsWith('"') && t.endsWith('"') ? JSON.parse(t) : t; };
  const recs = text.split(/\n?(?==== flipflop )/).filter((r) => r.startsWith("=== flipflop"));
  let chosen = null;
  for (const r of recs) { const m = r.match(/^name:\s*(.+)$/m); if (m && m[1].trim() === testName) chosen = r; }
  if (!chosen) return null;
  const ts = dequote((chosen.match(/^ts:\s*(.+)$/m) || [])[1]);
  const grab = (blk, k) => dequote((blk.match(new RegExp(`^\\s+${k}:\\s*(.+)$`, "m")) || [])[1]);
  const envBlk = (chosen.match(/^env:\n([\s\S]*?)(?=^\w)/m) || [])[1] || "";
  const sm = chosen.match(/^summary\[(\d+)\]\{([^}]+)\}:\n([\s\S]*?)(?=^\w)/m);
  const byInput = {};
  if (sm) {
    const cols = sm[2].split(",");
    for (const line of sm[3].split("\n").map((l) => l.trim()).filter(Boolean)) {
      const cells = line.split(",");
      const o = {}; cols.forEach((c, i) => (o[c] = cells[i]));
      (byInput[o.input] ??= {})[o.variant] = o;
    }
  }
  return { ts, env: { commit: grab(envBlk, "commit"), host: grab(envBlk, "host"), cpu: grab(envBlk, "cpu"), node: grab(envBlk, "node") }, byInput };
}

const text = readFileSync(journalPath, "utf8");
const dec = parseRecord(text, "jxtc-vs-full-decode");
const encR = parseRecord(text, "jxtc-encode");
if (!dec) throw new Error("no jxtc-vs-full-decode record in journal — run the decode test on real files first");

// Real-file rows = those whose name has no '@' (fractal inputs are like fbm@512).
const files = Object.keys(dec.byInput).filter((n) => !n.includes("@"));
if (!files.length) throw new Error("no real-file rows in the latest jxtc-vs-full-decode record (was it run with JXTC_REAL?)");

const fmt = (n, d = 1) => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(d) : "n/a");
const rows = [];
for (const name of files) {
  const full = dec.byInput[name]["full-decode-crop"];
  const roi = dec.byInput[name]["jxtc-roi"];
  if (!full || !roi) continue;
  const fullMs = Number(full.median_warm_ms);
  const roiMs = Number(roi.median_warm_ms);

  // dims (decode once) → MP + tile count
  let mp = NaN, tiles = NaN;
  try {
    const { width, height } = decodeFileToRgba(join(rawDir, name));
    mp = (width * height) / 1e6;
    tiles = Math.ceil(width / TILE) * Math.ceil(height / TILE);
  } catch { /* leave n/a */ }

  // encode (if flipflopenc was run on this file): d0 size, d1 time+size
  const e = encR?.byInput[name] || {};
  const encD0Kb = e["e3-d0"] ? Number(e["e3-d0"].quality) : NaN; // baseline size n/a in journal (engine skips baseline quality)
  const encD1Ms = e["e3-d1"] ? Number(e["e3-d1"].median_warm_ms) : NaN;
  const encD1Kb = e["e3-d1"] ? Number(e["e3-d1"].quality) : NaN;
  const decSaved = fullMs - roiMs;
  const paybackD1 = Number.isFinite(encD1Ms) && decSaved > 0.5 ? Math.ceil(encD1Ms / decSaved) : NaN;

  rows.push({
    name, mp, tiles, fullMs, roiMs,
    speedup: roiMs > 0 ? fullMs / roiMs : NaN,
    trust: full.trust === "high" && roi.trust === "high" ? "high" : `full:${full.trust}/roi:${roi.trust}`,
    encD1Ms, encD1Kb, paybackD1,
  });
}
rows.sort((a, b) => b.speedup - a.speedup);

const L = [];
L.push(`# JXTC on Real Camera Files — Diagnostic Report`);
L.push("");
L.push(`**Generated**: ${today} · source: \`${rawDir}\` · Boundary Cost Audit Tier 2 #4`);
L.push("");
L.push(`Decode A/B from the \`jxtc-vs-full-decode\` flipflop journal (\`${dec.ts}\`): interleaved, multi-round \`median_warm\` (round 0 excluded), pixel-exact \`equal()\` guard, scalar WASM tier. Both arms decode the same JXTC container, so the only variable is "decode every tile + JS-crop" vs "decode one ROI tile". Camera files decoded to RGBA via the raw pkg (CR2/DNG/ORF; neutral tone, camera WB). Encode columns from the \`jxtc-encode\` (flipflopenc) journal where available.`);
L.push("");
L.push(`Env: ${dec.env.host} · ${dec.env.cpu} · node ${dec.env.node} · commit \`${dec.env.commit}\``);
L.push("");
L.push(`| file | MP | tiles | full decode + crop (ms) | JXTC ROI decode (ms) | **speedup** | trust | JXTC d1 encode (ms) | d1 size (KB) | payback @d1 (crops) |`);
L.push(`|---|--:|--:|--:|--:|--:|---|--:|--:|--:|`);
for (const r of rows) {
  const speedup = Number.isFinite(r.speedup) ? `**${fmt(r.speedup, 0)}×**` : "—";
  L.push(`| ${r.name} | ${fmt(r.mp, 1)} | ${Number.isFinite(r.tiles) ? r.tiles : "n/a"} | ${fmt(r.fullMs, 0)} | ${fmt(r.roiMs, 1)} | ${speedup} | ${r.trust} | ${fmt(r.encD1Ms, 0)} | ${fmt(r.encD1Kb, 0)} | ${Number.isFinite(r.paybackD1) ? r.paybackD1 : "—"} |`);
}
L.push("");
L.push(`## Reading it`);
L.push("");
L.push(`- **Speedup is the realized crop win** on real photos: decoding one 256px tile vs decoding the whole 12–24 MP image then cropping. Full decode scales with megapixels; ROI decode is ~flat (one tile), so bigger files win harder.`);
L.push(`- **In wall-clock terms** this is **multi-second freeze → tens of milliseconds** per crop/thumbnail/zoom — the difference between a janky and an instant gallery.`);
L.push(`- **payback @d1** = encode time (effort 3, distance 1, visually lossless) ÷ per-crop decode saving. It's tiny (single-digit crops) because each avoided full decode saves seconds — the one-time ingest encode is repaid almost immediately.`);
L.push(`- **Conservative**: all numbers are the slowest **scalar** WASM tier. Production SIMD/SIMD-MT shrinks both the absolute decode times and the encode cost; the ratio (speedup) is tier-independent.`);
L.push(`- **Where it does NOT help**: full-resolution display (you need every pixel), assets without a JXTC pre-produced at ingest, and the RAW→RGBA decode itself (a separate cost center).`);
L.push("");
const md = L.join("\n") + "\n";
if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, md);
console.log(md);
console.log(`\nwrote ${outPath}`);
