// Focused probe: confirm encode sub-timers emit and quantify marshal vs libjxl
// core-compress share. Exercises the instrumented encodeTileContainerRgba8 path
// (facade.encodeTileContainer) with a synthetic 1920x1440 RGBA frame — same
// target size the StandardMultifileTest uses, so the split is representative.
import { performance } from "node:perf_hooks";

const { encodeTileContainerRgba8 } = await import("../packages/jxl-wasm/dist/index.js");

const W = 1920, H = 1440;
const rgba = new Uint8Array(W * H * 4);
// Fill with a non-trivial gradient (constant buffers compress unrealistically fast).
for (let y = 0, i = 0; y < H; y++) {
  for (let x = 0; x < W; x++, i += 4) {
    rgba[i] = (x ^ y) & 0xff;
    rgba[i + 1] = (x + y) & 0xff;
    rgba[i + 2] = (x * 3 + y) & 0xff;
    rgba[i + 3] = 0xff;
  }
}

const ROUNDS = 5;
const acc = Object.create(null);
let total = 0;
for (let r = 0; r < ROUNDS; r++) {
  const m = Object.create(null);
  const t0 = performance.now();
  await encodeTileContainerRgba8(rgba.slice(), W, H, {
    tileSize: 256, distance: 1.0, effort: 3, hasAlpha: false,
    onMetric: (name, val) => { m[name] = val; },
  });
  const wall = performance.now() - t0;
  if (r === 0) continue; // drop warm-up
  total += wall;
  for (const k of Object.keys(m)) acc[k] = (acc[k] || 0) + m[k];
}
const n = ROUNDS - 1;
const phases = ["enc_input_prep", "enc_malloc", "enc_heap_set", "enc_wasm_encode", "enc_buffer_read", "enc_free"];
const sum = phases.reduce((s, k) => s + (acc[k] || 0) / n, 0);
console.log(`\nEncode sub-timer split (${W}x${H} RGBA, avg of ${n} rounds):`);
for (const k of phases) {
  const ms = (acc[k] || 0) / n;
  console.log(`  ${k.padEnd(16)} ${ms.toFixed(2).padStart(8)} ms  ${(100 * ms / sum).toFixed(1).padStart(5)}%`);
}
console.log(`  ${"sum(phases)".padEnd(16)} ${sum.toFixed(2).padStart(8)} ms`);
console.log(`  ${"wall".padEnd(16)} ${(total / n).toFixed(2).padStart(8)} ms`);
console.log(`\n  core-compress share = ${(100 * (acc.enc_wasm_encode / n) / sum).toFixed(1)}% (claim was ~90%)`);
console.log(`  marshal share       = ${(100 * (sum - acc.enc_wasm_encode / n) / sum).toFixed(1)}%`);
