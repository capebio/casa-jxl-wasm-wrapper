// Demosaic SIMD flip-flop harness (Lens 22).
// Runs the real wasm128 build in Node: correctness pin (SIMD output == scalar output, checked inside
// wasm) + A/B timing (median, timed in the JS host since wasm32 has no wall clock).
//
// Build first (from repo root):
//   $env:RUSTFLAGS="-C target-feature=+simd128"
//   wasm-pack build --target nodejs --out-dir pkg-bench --release
//   node tools/demosaic-flipflop.mjs
import { performance } from "node:perf_hooks";

const wasmMod = await import("../pkg-bench/raw_converter_wasm.js");
const wasm = wasmMod.default ?? wasmMod;
const { demosaic_bench_prepare, demosaic_bench_scalar, demosaic_bench_simd, demosaic_bench_equal } = wasm;

function median(a) { a.sort((x, y) => x - y); return a[a.length >> 1]; }
function bench(fn, iters) {
  const t = [];
  for (let i = 0; i < iters; i++) { const s = performance.now(); fn(); t.push(performance.now() - s); }
  return median(t);
}

const sizes = [[5000, 4000, "20MP"], [1800, 1200, "lightbox"], [640, 480, "thumb"]];
console.log("=== DEMOSAIC SIMD FLIP-FLOP (wasm128, single-thread, Node) ===");
console.log("context\tequal\tscalar_ms\tsimd_ms\tspeedup");
let ok = true;
for (const [w, h, label] of sizes) {
  demosaic_bench_prepare(w, h);
  const eq = demosaic_bench_equal();               // correctness pin (full Vec equality inside wasm)
  if (!eq) { ok = false; }
  for (let i = 0; i < 5; i++) { demosaic_bench_scalar(); demosaic_bench_simd(); } // warm
  const iters = w >= 5000 ? 20 : 80;
  const sc = bench(demosaic_bench_scalar, iters);
  const sd = bench(demosaic_bench_simd, iters);
  console.log(`${label}\t${eq}\t${sc.toFixed(3)}\t${sd.toFixed(3)}\t${(sc / sd).toFixed(2)}x`);
}
if (!ok) { console.error("CORRECTNESS FAIL: wasm128 SIMD demosaic != scalar"); process.exitCode = 1; }
