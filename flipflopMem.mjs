// flipflopMem.mjs — memory-focused CLI sister to flipflop.mjs
//
// Same test contract as flipflop; prints delta_rss_mb / delta_heap_mb / delta_wasm_mb
// and auto-classifies the architecture from what it observes.
//
// Usage:
//   node --expose-gc flipflopMem.mjs <test-file> [same options as flipflop.mjs]
//
// Test hook (optional — enables WASM linear-memory tracking):
//   export function wasmMemory() { return module.memory.buffer.byteLength; }
//
// Columns:
//   med_Δrss   — median net OS-RSS change per flip (MB); includes V8 + WASM + native
//   max_Δrss   — worst-case RSS delta across all flips (MB); peak transient pressure
//   med_Δheap  — median net V8-heap change per flip (MB)
//   med_Δwasm  — median WASM linear-memory page growth per flip (MB); 0 = no new pages needed
//
// Architecture signals (auto-classified):
//   [gc]       — gc() ran before every before-snapshot; deltas reflect clean baseline
//   [no-gc ⚠] — gc() skipped; before-snapshot includes prior-round garbage; noisy deltas
//   delta_rss >> delta_heap  → allocation pressure outside V8 (WASM linear mem / native buffers)
//   delta_rss < 0 on flips   → OS returned pages during flip; peak was higher than reported
//   delta_wasm_mb = n/a      → wasmMemory() hook absent; WASM heap not tracked

import { runTest } from './flipflop.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const DEFAULT_JOURNAL = 'docs/outputs/timing tests/flipflop/flipflopjournal.toon';

function parseArgs(argv) {
  const o = { rounds: undefined, minSampleMs: 2, samplerMs: 500, journal: DEFAULT_JOURNAL, noMetrics: false, dry: false };
  let testFile = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--inputs') o.inputs = next();
    else if (a === '--rounds') {
      const r = next();
      o.rounds = r.includes(':')
        ? Object.fromEntries(r.split(',').map((s) => s.split(':').map((x, k) => k ? +x : x.trim())))
        : +r;
    }
    else if (a === '--sizes') o.sizes = next().split(',').map((x) => +x);
    else if (a === '--types') o.types = next().split(',');
    else if (a === '--min-sample-ms') o.minSampleMs = +next();
    else if (a === '--sampler-ms') o.samplerMs = +next();
    else if (a === '--journal') o.journal = next();
    else if (a === '--no-metrics') o.noMetrics = true;
    else if (a === '--dry') { o.dry = true; o.rounds = o.rounds ?? 1; }
    else if (a === '--help' || a === '-h') o.help = true;
    else if (!a.startsWith('--')) testFile = a;
  }
  return { o, testFile };
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function buildMemRows(flips) {
  const map = new Map();
  for (const f of flips) {
    if (f.failed) continue;
    const k = `${f.input}\0${f.variant}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(f);
  }
  const rows = [];
  for (const [key, fs] of map) {
    const [input, variant] = key.split('\0');
    const nums = (col) => fs.map((f) => f[col]).filter((v) => typeof v === 'number');
    const rss  = nums('delta_rss_mb');
    const heap = nums('delta_heap_mb');
    const wasm = nums('delta_wasm_mb');
    const fmt  = (v) => v == null ? 'n/a' : v.toFixed(1);
    const maxRss = rss.length ? Math.max(...rss) : null;
    rows.push({
      variant,
      input,
      med_Δrss:  fmt(median(rss)),
      max_Δrss:  fmt(maxRss),
      med_Δheap: fmt(median(heap)),
      med_Δwasm: wasm.length ? fmt(median(wasm)) : 'n/a',
    });
  }
  return rows;
}

// Auto-classify architecture signals from the flip data.
// Returns array of { level: 'warn'|'info', msg } objects.
function classify(flips) {
  const signals = [];

  if (!globalThis.gc) {
    signals.push({ level: 'warn', msg: '--expose-gc not set — gc() skipped before each snapshot; before-baseline includes prior-round garbage; Δ values are noisy' });
  }

  const live = flips.filter((f) => !f.failed);
  if (!live.length) return signals;

  const allWasmNA = live.every((f) => f.delta_wasm_mb === 'n/a');
  if (allWasmNA) {
    signals.push({ level: 'info', msg: 'delta_wasm_mb = n/a — add to test:  export function wasmMemory() { return module.memory.buffer.byteLength; }' });
  }

  // off-V8-heap pressure: rss delta significantly exceeds heap delta on many flips
  const numeric = live.filter((f) => typeof f.delta_rss_mb === 'number' && typeof f.delta_heap_mb === 'number');
  const offHeap = numeric.filter((f) => f.delta_rss_mb > 0 && f.delta_rss_mb > f.delta_heap_mb * 2 + 1);
  if (numeric.length && offHeap.length / numeric.length > 0.4) {
    signals.push({ level: 'info', msg: `delta_rss >> delta_heap on ${offHeap.length}/${numeric.length} flips — allocation pressure outside V8 (WASM linear memory or native buffers)` });
  }

  // OS returned pages mid-flip: negative rss delta means peak was higher than reported
  const rssFlips = live.filter((f) => typeof f.delta_rss_mb === 'number');
  const negRss = rssFlips.filter((f) => f.delta_rss_mb < -2);
  if (negRss.length > 0) {
    signals.push({ level: 'info', msg: `delta_rss < 0 on ${negRss.length} flip(s) — OS reclaimed pages during flip; actual peak was higher than med_Δrss; use max_Δrss for worst-case` });
  }

  // Warm flips show 0 WASM growth — healthy sign for pre-allocated paths
  if (!allWasmNA) {
    const wasmFlips = live.filter((f) => typeof f.delta_wasm_mb === 'number');
    const warmZero = wasmFlips.filter((f) => !f.first_paint && f.delta_wasm_mb === 0);
    if (wasmFlips.length && warmZero.length / wasmFlips.length > 0.8) {
      signals.push({ level: 'info', msg: 'delta_wasm_mb = 0 on warm flips — WASM linear memory stable after first allocation; no repeated page growth' });
    }
  }

  return signals;
}

function printMemSummary(rec) {
  const gcTag = globalThis.gc ? '[gc]' : '[no-gc ⚠]';
  console.log(`\nflipflopMem: ${rec.name} [${rec.config.timing_mode}] ${gcTag} — ${rec.verdict}\n`);  // intentional alias kept for display

  const cols = ['variant', 'input', 'med_Δrss', 'max_Δrss', 'med_Δheap', 'med_Δwasm'];
  const rows = buildMemRows(rec.flips);
  console.log(cols.join('\t'));
  for (const r of rows) console.log(cols.map((c) => r[c]).join('\t'));

  const signals = classify(rec.flips);
  if (signals.length) {
    console.log();
    for (const s of signals) {
      const tag = s.level === 'warn' ? 'WARN' : 'INFO';
      console.log(`[${tag}] ${s.msg}`);
    }
  }
}

async function main() {
  const { o, testFile } = parseArgs(process.argv.slice(2));
  if (o.help || !testFile) {
    console.log('Usage: node --expose-gc flipflopMem.mjs <test-file> [--rounds n] [--sizes a,b] [--types a,b] [--inputs glob] [--dry] [--journal path] [--no-metrics]');
    console.log('Prints: med_Δrss / max_Δrss / med_Δheap / med_Δwasm per variant per input.');
    console.log('WASM hook: export function wasmMemory() { return module.memory.buffer.byteLength; }');
    if (!testFile && !o.help) process.exitCode = 1;
    return;
  }
  const mod = await import(pathToFileURL(resolve(testFile)).href);
  const rec = await runTest(mod, o);
  printMemSummary(rec);
  if (!o.dry) console.log(`\nflipflopMem: appended to ${o.journal}`);
}

main().catch((e) => { console.error('flipflopMem error:', e.message); process.exitCode = 1; });
