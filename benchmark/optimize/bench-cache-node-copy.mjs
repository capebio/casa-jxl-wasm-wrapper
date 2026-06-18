// Microbench: jxl-cache/src/node.ts copy-path candidates
// Finding 1 (20%): get() L71 — mem.slice(0) on every memory-cache hit
// Finding 2 (15%): getPersistent() L106-107 — double-copy on Node readFile path
//
// Run: node benchmark/optimize/bench-cache-node-copy.mjs

import { performance } from 'node:perf_hooks';

const REPS = 5000;
const SIZE = 512 * 1024; // 512 KB — realistic JXL cache entry

function bench(label, fn) {
  // warmup
  for (let i = 0; i < 50; i++) fn();
  // measure
  const t0 = performance.now();
  for (let i = 0; i < REPS; i++) fn();
  const ms = (performance.now() - t0) / REPS;
  return { label, ms };
}

// ---- Finding 2: getPersistent() double-copy ----
// Node.js fs.readFile returns a Buffer backed by a shared slab with byteOffset > 0
const slab = new ArrayBuffer(SIZE + 128);
const buffer = { buffer: slab, byteOffset: 64, byteLength: SIZE };

const base_getPersistent = bench('getPersistent baseline (double-copy)', () => {
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const master = arrayBuffer.slice(0); // <-- redundant second allocation
  return master;
});

const cand_getPersistent = bench('getPersistent candidate (single-copy)', () => {
  const master = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return master;
});

// ---- Finding 1: get() mem.slice(0) on hot-path cache hit ----
// ArrayBuffer already in memoryCache — caller calls get(), gets a defensive copy
const cached = new ArrayBuffer(SIZE);
new Uint8Array(cached).fill(0xAB);

const base_get = bench('get() baseline (slice(0) on every hit)', () => {
  return cached.slice(0);
});

const cand_get = bench('get() candidate (return direct, no copy)', () => {
  return cached; // NOTE: safe only if callers never mutate — see comptroller verdict
});

// ---- Report ----
function savedPct(base, cand) {
  return ((1 - cand.ms / base.ms) * 100).toFixed(1);
}

console.log('\n=== jxl-cache/src/node.ts — copy-path microbench ===\n');
console.log(`SIZE: ${SIZE / 1024} KB  REPS: ${REPS}\n`);

console.log('Finding 2 — getPersistent() double-copy:');
console.log(`  baseline  ${base_getPersistent.ms.toFixed(4)} ms/op`);
console.log(`  candidate ${cand_getPersistent.ms.toFixed(4)} ms/op`);
console.log(`  saved_pct ${savedPct(base_getPersistent, cand_getPersistent)}%\n`);

console.log('Finding 1 — get() mem.slice(0) on cache hit:');
console.log(`  baseline  ${base_get.ms.toFixed(4)} ms/op`);
console.log(`  candidate ${cand_get.ms.toFixed(4)} ms/op`);
console.log(`  saved_pct ${savedPct(base_get, cand_get)}%`);
console.log('\n  ⚠ Finding 1 candidate skips copy — safe only if callers never mutate returned buffer.');
console.log('  Comptroller rejected it for this reason. Measure only; do not apply without caller audit.\n');
