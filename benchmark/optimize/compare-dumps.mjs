// Compare Phase-0 baseline dump vs after-dump per metric. Emits a markdown table + per-metric verdict.
import { readFileSync } from 'node:fs';

const [, , basePath, afterPath] = process.argv;
const base = JSON.parse(readFileSync(basePath, 'utf8'));
const after = JSON.parse(readFileSync(afterPath, 'utf8'));

const METRICS = ['prog_enc_ms', 'shot_dec_ms', 'photon_prog_enc_ms', 'mod_prog_enc_ms', 'mt_prog_enc_ms', 'mt_shot_dec_ms'];
const RAW = ['decompress_ms', 'demosaic_ms', 'tonemap_ms', 'orient_ms'];

const byFileA = new Map(after.files.map(f => [f.file, f]));

function pct(b, a) { return b > 0 ? ((b - a) / b) * 100 : 0; } // +ve = faster

// Aggregate sums + per-file rows.
const sums = {};
for (const m of [...METRICS]) sums[m] = { base: 0, after: 0 };
let rawBase = 0, rawAfter = 0;

const rows = [];
for (const bf of base.files) {
  const af = byFileA.get(bf.file) || { metrics: {}, raw: {} };
  const rB = RAW.reduce((s, k) => s + (bf.raw?.[k] ?? 0), 0);
  const rA = RAW.reduce((s, k) => s + (af.raw?.[k] ?? 0), 0);
  rawBase += rB; rawAfter += rA;
  const cells = METRICS.map(m => {
    const b = bf.metrics?.[m] ?? 0, a = af.metrics?.[m] ?? 0;
    sums[m].base += b; sums[m].after += a;
    return `${b}→${a} (${pct(b, a) >= 0 ? '+' : ''}${pct(b, a).toFixed(1)}%)`;
  });
  rows.push(`| ${bf.file} | ${rB}→${rA} (${pct(rB, rA) >= 0 ? '+' : ''}${pct(rB, rA).toFixed(1)}%) | ${cells.join(' | ')} |`);
}

console.log('## Per-file ms (baseline→after, +% = faster)\n');
console.log(`| file | raw_decode | ${METRICS.join(' | ')} |`);
console.log(`|------|${'---|'.repeat(METRICS.length + 1)}`);
console.log(rows.join('\n'));

console.log('\n## Aggregate (sum across files)\n');
console.log('| metric | base ms | after ms | Δ% (+faster) |');
console.log('|--------|---------|----------|--------------|');
console.log(`| raw_decode | ${rawBase} | ${rawAfter} | ${pct(rawBase, rawAfter) >= 0 ? '+' : ''}${pct(rawBase, rawAfter).toFixed(1)}% |`);
for (const m of METRICS) {
  const s = sums[m];
  console.log(`| ${m} | ${s.base} | ${s.after} | ${pct(s.base, s.after) >= 0 ? '+' : ''}${pct(s.base, s.after).toFixed(1)}% |`);
}

console.log('\n## Telemetry\n');
console.log(`| field | baseline | after |`);
console.log('|-------|----------|-------|');
for (const k of ['cpuLoadPct', 'cpuThrottlingPct', 'cpuThrottlingState', 'memoryFreeGb']) {
  console.log(`| ${k} | ${base.telemetry?.[k]} | ${after.telemetry?.[k]} |`);
}
