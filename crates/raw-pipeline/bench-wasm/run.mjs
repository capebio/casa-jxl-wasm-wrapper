// Node A/B harness for the wasm PSNR (SSD) kernel.
//   node run.mjs [megapixels=24] [iters=20] [rounds=8]
// Parity: SIMD SSD must equal scalar SSD exactly. Perf: interleaved SIMD/scalar
// rounds (cancels thermal drift), reports median per-iter ms and the speedup; the
// SpeedCodeReview perf gate wants SIMD >= 5% faster.
import { ssd_simd_once, ssd_scalar_once, bench } from './pkg/perceptual_bench_wasm.js';

const MP = Number(process.argv[2] ?? 24);
const ITERS = Number(process.argv[3] ?? 20);
const ROUNDS = Number(process.argv[4] ?? 8);
const N = Math.round(MP * 1_000_000) * 4; // RGBA bytes

// Deterministic, non-trivial buffers (varied diffs so the squared-error path is real).
const a = new Uint8Array(N);
const b = new Uint8Array(N);
let s = 0x9e3779b9 >>> 0;
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) >>> 24);
for (let i = 0; i < N; i++) { a[i] = rnd(); b[i] = (a[i] + rnd() - 128) & 0xff; }

// --- Parity (exact) ---
const simd1 = ssd_simd_once(a, b);
const scal1 = ssd_scalar_once(a, b);
const parity = simd1 === scal1;
console.log(`parity: ${parity ? 'PASS' : 'FAIL'}  simd=${simd1}  scalar=${scal1}`);
if (!parity) { console.error('PARITY FAILED — aborting perf'); process.exit(1); }

// warm up (JIT + thermal)
bench(a, b, 3, true); bench(a, b, 3, false);

const median = (xs) => xs.slice().sort((x, y) => x - y)[xs.length >> 1];
const simdMs = [], scalMs = [];
for (let r = 0; r < ROUNDS; r++) {
  // interleave order to cancel drift
  const [first, second] = r % 2 ? ['scalar', 'simd'] : ['simd', 'scalar'];
  for (const which of [first, second]) {
    const t0 = performance.now();
    bench(a, b, ITERS, which === 'simd');
    const dt = (performance.now() - t0) / ITERS;
    (which === 'simd' ? simdMs : scalMs).push(dt);
  }
}

const sM = median(simdMs), cM = median(scalMs);
const speedup = cM / sM;
const pct = (speedup - 1) * 100;
console.log(`buffer: ${MP}MP RGBA (${(N / 1e6).toFixed(0)} MB)  iters/round=${ITERS}  rounds=${ROUNDS}`);
console.log(`scalar median: ${cM.toFixed(3)} ms/iter`);
console.log(`simd   median: ${sM.toFixed(3)} ms/iter`);
console.log(`speedup: ${speedup.toFixed(2)}x  (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`);
console.log(`gate (>=5% faster): ${pct >= 5 ? 'PASS' : 'FAIL'}`);
