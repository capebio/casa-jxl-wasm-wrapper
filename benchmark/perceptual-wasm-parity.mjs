// Node parity + timing: JS reference vs the wasm PerceptualComparer.
// Gate: relative diff <= 1e-3 per metric per pass (the kernel is the source of
// truth; SIMD reassociation legitimately drifts past 1e-6).
//
// Requires a built pkg: `wasm-pack build --target web --out-dir pkg --release`.
// Run: node benchmark/perceptual-wasm-parity.mjs
import { pathToFileURL } from 'url';
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

const butt = await import(pathToFileURL(join(repo, 'web/jxl-butteraugli.js')).href);
const qual = await import(pathToFileURL(join(repo, 'web/jxl-progressive-quality.js')).href);

// Locate the generated wasm JS entry + its .wasm in pkg/.
const pkgDir = join(repo, 'pkg');
const entry = readdirSync(pkgDir).find((f) => f.endsWith('.js') && !f.endsWith('_bg.js'));
const wasmFile = readdirSync(pkgDir).find((f) => f.endsWith('_bg.wasm'));
const wasm = await import(pathToFileURL(join(pkgDir, entry)).href);
// --target web init: pass the wasm bytes explicitly (Node has no fetch of file URLs).
await wasm.default({ module_or_path: readFileSync(join(pkgDir, wasmFile)) });

const W = 1280, H = 800, N = W * H;
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 0xffffffff; }; }
function makeImage() {
  const r = rng(0xC0FFEE); const p = new Uint8Array(N * 4);
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const x = i % W, y = (i / W) | 0;
    p[j] = (x * 255 / W + 40 * Math.sin(y / 17) + r() * 8) & 255;
    p[j + 1] = (y * 255 / H + 40 * Math.sin(x / 23) + r() * 8) & 255;
    p[j + 2] = ((x + y) * 127 / (W + H) + 30 * Math.sin((x + 2 * y) / 31)) & 255;
    p[j + 3] = 255;
  }
  return p;
}
function makePass(ref, amp) {
  const r = rng(0xBADF00D ^ amp); const p = new Uint8Array(ref);
  if (amp > 0) for (let j = 0; j < p.length; j += 4) { for (let c = 0; c < 3; c++) p[j + c] = Math.max(0, Math.min(255, p[j + c] + (r() - 0.5) * 2 * amp)) | 0; }
  return p;
}

const ref = makeImage();
const passes = [24, 12, 5, 0].map((a) => makePass(ref, a));
const refXyb = butt.pixelsToXyb(ref, N);
const cmp = new wasm.PerceptualComparer(ref, W, H);

const rel = (a, b) => (a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-12));
let worst = 0, fails = 0, jsMs = 0, wasmMs = 0;
for (const p of passes) {
  let t = performance.now();
  const jb = butt.computeButteraugliVsFinal(refXyb, p, W, H);
  const js = qual.computeSsimVsFinal(ref, p, W, H);
  const jp = qual.computePsnrVsFinal(ref, p);
  jsMs += performance.now() - t;

  t = performance.now();
  const m = cmp.all(p);
  wasmMs += performance.now() - t;

  for (const [k, jv, wv] of [['butt', jb, m.butteraugli], ['ssim', js, m.ssim], ['psnr', jp, m.psnr]]) {
    if (!Number.isFinite(jv) && !Number.isFinite(wv)) continue; // both Inf (identical pass)
    const d = rel(jv, wv);
    worst = Math.max(worst, d);
    if (d > 1e-3) { fails++; console.error(`PARITY ${k}: js=${jv} wasm=${wv} rel=${d.toExponential(2)}`); }
  }
}
console.log(`JS ${jsMs.toFixed(1)} ms | wasm ${wasmMs.toFixed(1)} ms | speedup ${(jsMs / wasmMs).toFixed(2)}x`);
console.log(`Parity worst rel ${worst.toExponential(2)} (gate 1e-3) — ${fails === 0 ? 'PASS' : fails + ' FAIL'}`);
process.exit(fails === 0 ? 0 : 1);
