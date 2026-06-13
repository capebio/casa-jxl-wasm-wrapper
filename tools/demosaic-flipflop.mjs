// Demosaic SIMD flip-flop harness (Lens 22).
// Real wasm128 build in Node: correctness pin (SIMD==scalar, checked inside wasm) + A/B timing.
// TRUE alternation (scalar,simd,scalar,simd…) so time-varying background load (e.g. a concurrent
// compile) cancels in the ratio. Reports MIN (least-contended run, contention-robust) AND median.
//
// Build first (from repo root):
//   $env:RUSTFLAGS="-C target-feature=+simd128"
//   wasm-pack build --target nodejs --out-dir pkg-bench --release
//   node tools/demosaic-flipflop.mjs
import { performance } from "node:perf_hooks";

const wasmMod = await import("../pkg-bench/raw_converter_wasm.js");
const wasm = wasmMod.default ?? wasmMod;
const { demosaic_bench_prepare, demosaic_bench_scalar, demosaic_bench_simd, demosaic_bench_equal } = wasm;

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const min = (a) => Math.min(...a);
const p90 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.9)]; };
const t1 = (fn) => { const s = performance.now(); fn(); return performance.now() - s; };

const sizes = [[5000, 4000, "20MP"], [1800, 1200, "lightbox"], [640, 480, "thumb"]];
console.log("=== DEMOSAIC SIMD FLIP-FLOP (wasm128, single-thread, Node) — alternating, min+median ===");
console.log("context\tequal\tsc_min\tsd_min\tspd(min)\tsc_med\tsd_med\tspd(med)\tsc_p90\tsd_p90");
let ok = true;
for (const [w, h, label] of sizes) {
  demosaic_bench_prepare(w, h);
  if (!demosaic_bench_equal()) ok = false;                       // correctness pin
  for (let i = 0; i < 8; i++) { demosaic_bench_scalar(); demosaic_bench_simd(); } // warm
  const iters = w >= 5000 ? 40 : 150;
  const sc = [], sd = [];
  for (let i = 0; i < iters; i++) {                              // TRUE alternation
    sc.push(t1(demosaic_bench_scalar));
    sd.push(t1(demosaic_bench_simd));
  }
  const scMin = min(sc), sdMin = min(sd), scMed = median(sc), sdMed = median(sd);
  console.log(
    `${label}\t${demosaic_bench_equal()}\t${scMin.toFixed(2)}\t${sdMin.toFixed(2)}\t${(scMin / sdMin).toFixed(3)}` +
    `\t${scMed.toFixed(2)}\t${sdMed.toFixed(2)}\t${(scMed / sdMed).toFixed(3)}\t${p90(sc).toFixed(2)}\t${p90(sd).toFixed(2)}`);
}
if (!ok) { console.error("CORRECTNESS FAIL: wasm128 SIMD demosaic != scalar"); process.exitCode = 1; }
