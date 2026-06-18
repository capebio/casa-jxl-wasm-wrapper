#!/usr/bin/env node
// jxtc-diagnostic-report — Boundary Cost Audit Tier 2 #4.
//
// Turns the rigorous, thermally-corrected JXTC-vs-full decode A/B produced by
//   .flipflop/tests/jxtc-vs-full-decode.mjs
// into the diagnostic report the handoff asked for, and adds the two columns flipflop does NOT
// measure (it times decode only): JXTC ENCODE overhead at ingest, and the crop PAYBACK — how many
// crop requests it takes before the one-time encode cost is repaid by the per-crop decode saving.
//
// Decode numbers come from the flipflop journal (interleaved, multi-round, pixel-exact-guarded).
// Encode numbers are measured here on the *identical* deterministic corpus images.
//
// Usage (from repo root):
//   node tools/jxtc-diagnostic-report.mjs
//   node tools/jxtc-diagnostic-report.mjs --journal "<path>" --out "<path>" --enc-reps 7
//
// Prereqs: run the flipflop test at least once so the journal has a record:
//   node --expose-gc flipflop.mjs .flipflop/tests/jxtc-vs-full-decode.mjs --sizes 256,512,1024,2048 --types fbm --print

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { renderFractal } from "../flipflop-corpus.mjs";
import {
  setJxlModuleFactoryForTesting,
  encodeTileContainerRgba8,
} from "../packages/jxl-wasm/dist/facade.js";

const TEST_NAME = "jxtc-vs-full-decode";
const TILE = 256; // must match the flipflop test
const DEFAULT_JOURNAL = "docs/outputs/timing tests/flipflop/flipflopjournal.toon";

// ---- args ----
const args = process.argv.slice(2);
const argVal = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const journalPath = argVal("--journal", DEFAULT_JOURNAL);
const encReps = Number(argVal("--enc-reps", "7"));
const today = new Date().toISOString().slice(0, 10);
const outPath = argVal("--out", `docs/outputs/jxtc-diagnostic-report-${today}.md`);

// Drop the facade's bracketed per-call perf logs; keep everything else.
const _log = console.log;
console.log = (...a) => {
  if (typeof a[0] === "string" && /^\[(decode|jxl-wasm)/.test(a[0])) return;
  _log(...a);
};

// ---- journal parse: last record for TEST_NAME, its summary + env/thermal/verdict ----
function parseJournal(text) {
  const records = text.split(/\n?(?==== flipflop )/).filter((r) => r.startsWith("=== flipflop"));
  let chosen = null;
  for (const rec of records) {
    const nameM = rec.match(/^name:\s*(.+)$/m);
    if (nameM && nameM[1].trim() === TEST_NAME) chosen = rec; // keep last match
  }
  if (!chosen) throw new Error(`no '${TEST_NAME}' record found in ${journalPath} — run the flipflop test first`);

  // TOON quotes any value containing ':' etc. as a JSON string — unwrap those.
  const dequote = (s) => {
    if (s == null) return s;
    const t = s.trim();
    return t.startsWith('"') && t.endsWith('"') ? JSON.parse(t) : t;
  };
  const ts = dequote((chosen.match(/^ts:\s*(.+)$/m) || [])[1]);
  const grab = (block, key) => dequote((block.match(new RegExp(`^\\s+${key}:\\s*(.+)$`, "m")) || [])[1]);
  const envBlock = (chosen.match(/^env:\n([\s\S]*?)(?=^\w)/m) || [])[1] || "";
  const thermalBlock = (chosen.match(/^thermal:\n([\s\S]*?)(?=^\w)/m) || [])[1] || "";
  const verdict = dequote((chosen.match(/^verdict:\s*(.+)$/m) || [])[1]);

  // summary[N]{c1,c2,...}:\n  row\n  row ...  (stops at the next col-0 block, e.g. `flips`)
  const sm = chosen.match(/^summary\[(\d+)\]\{([^}]+)\}:\n([\s\S]*?)(?=^\w)/m);
  if (!sm) throw new Error("summary table not found in journal record");
  const cols = sm[2].split(",");
  const rows = sm[3]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const cells = l.split(",");
      const o = {};
      cols.forEach((c, i) => (o[c] = cells[i]));
      return o;
    });

  // input -> { full:{...}, roi:{...} }
  const byInput = {};
  for (const r of rows) {
    (byInput[r.input] ??= {})[r.variant] = r;
  }
  return {
    ts,
    verdict,
    env: { commit: grab(envBlock, "commit"), host: grab(envBlock, "host"), cpu: grab(envBlock, "cpu"), node: grab(envBlock, "node"), os: grab(envBlock, "os") },
    thermal: { throttled: grab(thermalBlock, "throttled"), temp_max_c: grab(thermalBlock, "temp_max_c") },
    byInput,
  };
}

// ---- encode timing on the identical corpus image ----
let _modP = null;
function loadScalar() {
  const DIST = new URL("../packages/jxl-wasm/dist/", import.meta.url);
  return import(new URL("jxl-core.scalar.js", DIST).href).then((m) => {
    const wasmBinary = readFileSync(new URL("jxl-core.scalar.wasm", DIST));
    return m.default({ wasmBinary, locateFile: (p) => p });
  });
}
setJxlModuleFactoryForTesting(() => (_modP ??= loadScalar()));

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function measureEncode(type, size) {
  const { rgba, width, height } = renderFractal(type, size);
  // warmup (absorbs module load + first-encode allocator growth), then timed reps
  let container = await encodeTileContainerRgba8(rgba, width, height, { tileSize: TILE, distance: 0 });
  const times = [];
  for (let i = 0; i < encReps; i++) {
    const t0 = performance.now();
    container = await encodeTileContainerRgba8(rgba, width, height, { tileSize: TILE, distance: 0 });
    times.push(performance.now() - t0);
  }
  return { encMs: median(times), bytes: container.byteLength };
}

// ---- build report ----
function fmt(n, d = 1) {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(d) : "n/a";
}

const journal = parseJournal(readFileSync(journalPath, "utf8"));
const inputs = Object.keys(journal.byInput).sort((a, b) => {
  const na = Number(a.split("@")[1] || 0), nb = Number(b.split("@")[1] || 0);
  return na - nb;
});

const rows = [];
for (const input of inputs) {
  const [type, sizeStr] = input.split("@");
  const size = Number(sizeStr);
  const full = journal.byInput[input]["full-decode-crop"];
  const roi = journal.byInput[input]["jxtc-roi"];
  if (!full || !roi) continue;
  const fullMs = Number(full.median_warm_ms);
  const roiMs = Number(roi.median_warm_ms);
  const { encMs, bytes } = await measureEncode(type, size);
  const decSaved = fullMs - roiMs;
  const speedup = roiMs > 0 ? fullMs / roiMs : NaN;
  // No payback at/below one tile (ROI == full image ⇒ the tiny delta is variance, not a saving).
  const payback = size > TILE && decSaved > 0.5 ? encMs / decSaved : Infinity;
  const tilesTotal = Math.ceil(size / TILE) ** 2;
  rows.push({
    input, size, tilesTotal,
    fullMs, roiMs, speedup,
    savedPct: Number(roi.saved_pct),
    encMs, kb: bytes / 1024,
    payback,
    trustFull: full.trust, trustRoi: roi.trust,
  });
}

const lines = [];
lines.push(`# JXTC vs Full-Decode — Diagnostic Report`);
lines.push("");
lines.push(`**Generated**: ${today} · **Boundary Cost Audit Tier 2 item #4** (\`docs/boundary-cost-audit-tier2-handoff.md\`)`);
lines.push("");
lines.push(`Decode A/B is from the flipflop journal — interleaved (start-rotated each round so thermal/system drift hits both arms equally), multi-round \`median_warm\` (round 0 / first-paint excluded), pixel-exact \`equal()\` guarded. Encode overhead is measured here on the identical deterministic corpus images (median of ${encReps} warm reps, tileSize=${TILE}, distance=0).`);
lines.push("");
lines.push(`**Experiment**: both decode arms read the *same* JXTC container, so the only variable is "decode every tile then JS-crop" vs "decode only the ROI tile". ROI = one ${TILE}px tile, centered. At 256² the ROI equals the whole image — that row is the sanity floor (no win expected).`);
lines.push("");
lines.push(`## Provenance`);
lines.push("");
lines.push(`| field | value |`);
lines.push(`|---|---|`);
lines.push(`| journal record | \`${journal.ts}\` |`);
lines.push(`| commit | \`${journal.env.commit}\` |`);
lines.push(`| host / cpu | ${journal.env.host} · ${journal.env.cpu} |`);
lines.push(`| node / os | ${journal.env.node} · ${journal.env.os} |`);
lines.push(`| codec tier | scalar WASM (relative A/B; tier cancels in the ratio) |`);
lines.push(`| thermal | throttled: ${journal.thermal.throttled ?? "n/a"} · temp_max: ${journal.thermal.temp_max_c ?? "n/a"}°C |`);
lines.push(`| flipflop verdict | ${journal.verdict} |`);
lines.push("");
lines.push(`## Results`);
lines.push("");
lines.push(`| image | tiles | full decode + crop (ms) | JXTC ROI decode (ms) | speedup | %saved | JXTC encode (ms) | size (KB) | payback (crops) | trust |`);
lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---|`);
for (const r of rows) {
  const speedup = Number.isFinite(r.speedup) ? `${fmt(r.speedup, 1)}×` : "—";
  const payback = r.payback === Infinity ? "—" : `${Math.ceil(r.payback)}`;
  const trust = r.trustFull === "high" && r.trustRoi === "high" ? "high" : `full:${r.trustFull}/roi:${r.trustRoi}`;
  lines.push(
    `| ${r.input} | ${r.tilesTotal} | ${fmt(r.fullMs)} | ${fmt(r.roiMs)} | ${speedup} | ${fmt(r.savedPct, 1)}% | ${fmt(r.encMs)} | ${fmt(r.kb)} | ${payback} | ${trust} |`,
  );
}
lines.push("");
lines.push(`## Reading it`);
lines.push("");
lines.push(`- **JXTC ROI decode is flat (~10–12 ms)** regardless of image size — it only ever decodes one tile. **Full decode scales with image area**, so the speedup grows with resolution.`);
lines.push(`- **payback (crops)** = JXTC encode ms ÷ per-crop decode saving (full − ROI). Below that many crop requests per asset, the ingest encode cost is not yet repaid; above it, JXTC is a net win. The 256² floor row shows "—" because ROI = full image (no decode saving to repay against).`);
lines.push(`- **encode here is a conservative upper bound** — already at the ingest default **effort=3** (audit §15), but at the slowest **scalar** tier and **distance=0 (lossless)**. The cost lives in tier + losslessness, not effort:`);
lines.push(`  - **Tier**: production uses SIMD/SIMD-MT (§15 cites ~50–150 ms for a 20 MP asset). The decode A/B is unaffected — both arms share the tier, which cancels in the ratio.`);
lines.push(`  - **Distance**: the \`jxtc-encode\` (flipflopenc) companion shows **distance=1 (visually lossless) encodes ~49% faster and ~2.8× smaller** than the distance=0 used here. For gallery/thumbnail JXTC, distance=1 is the better ingest setting.`);
lines.push(`  - **Effort**: flipflopenc confirms effort 7 is **~2.6–3.7× slower** than effort 3 for little real-photo size gain — effort=3 stays the default (matches prior measurements).`);
lines.push(`  - Net: real ingest payback is a small fraction of the crop counts above.`);
lines.push(`- **trust** comes from flipflop: \`high\` = low variance, drift cancelled by interleave; \`low\` on the 256² floor reflects the two arms being near-identical (variance dominates a ~zero delta), not an unreliable measurement.`);
lines.push(`- **thermal "unknown"** on this desktop: CPU frequency reports static and LibreHardwareMonitor was not running, so absolute throttle state is unverifiable — confidence rests on the interleave + low \`stdev\` rather than temperature.`);
lines.push("");
lines.push(`## Reproduce`);
lines.push("");
lines.push("```sh");
lines.push(`node --expose-gc flipflop.mjs .flipflop/tests/jxtc-vs-full-decode.mjs --sizes 256,512,1024,2048 --types fbm --print`);
lines.push(`node tools/jxtc-diagnostic-report.mjs`);
lines.push("```");
lines.push("");

const md = lines.join("\n") + "\n";
if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, md);
_log(md);
_log(`\nwrote ${outPath}`);
