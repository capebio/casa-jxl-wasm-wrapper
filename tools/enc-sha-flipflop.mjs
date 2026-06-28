#!/usr/bin/env node
// enc-sha-flipflop — byte-exact + timing encoder validation.
// Loads OLD and NEW encoder WASM, encodes synthetic RGBA at multiple efforts,
// verifies SHA256 byte-exactness, then runs a TRUE-alternation timing bench
// (OLD, NEW, OLD, NEW ...) so background load cancels in the ratio.
//
// Usage:
//   node tools/enc-sha-flipflop.mjs [OLD_JS [NEW_JS]]
//
// Defaults:
//   OLD_JS = packages/jxl-wasm/dist/jxl-core.enc.simd.plain.OLD.js
//   NEW_JS = packages/jxl-wasm/dist/jxl-core.enc.simd.plain.js
//
// Typical workflow:
//   1. cp dist/jxl-core.enc.simd.plain.{js,wasm} dist/jxl-core.enc.simd.plain.OLD.{js,wasm}
//   2. LIBJXL_SRC_DIR=C:/Foo/rcw-huffman-cont ... build-pgo.mjs --plain
//   3. node tools/enc-sha-flipflop.mjs

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

const REPO = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1").replace(/\//g, "\\");

const [OLD_JS, NEW_JS] = [
  process.argv[2] ?? resolve(REPO, "packages/jxl-wasm/dist/jxl-core.enc.simd.plain.OLD.js"),
  process.argv[3] ?? resolve(REPO, "packages/jxl-wasm/dist/jxl-core.enc.simd.plain.js"),
];

async function loadModule(jsPath) {
  const abs = resolve(jsPath);
  const wasmPath = abs.replace(/\.js$/, ".wasm");
  const url = "file:///" + abs.replaceAll("\\", "/");
  const { default: createModule } = await import(url);
  const wasmBinary = await readFile(wasmPath);
  return createModule({ wasmBinary, locateFile: () => wasmPath });
}

// Build a synthetic RGBA gradient — non-trivial entropy, reproducible.
function makeRgba(w, h) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i    ] = (x * 255 / (w - 1)) | 0;
      rgba[i + 1] = (y * 255 / (h - 1)) | 0;
      rgba[i + 2] = (x + y) & 0xFF;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function encodeOnce(mod, rgba, w, h, effort) {
  const ptr = mod._malloc(rgba.byteLength);
  mod.HEAPU8.set(rgba, ptr);
  const handle = mod._jxl_wasm_encode_tile_container_rgba8(ptr, w, h, 256, 1.0, effort, 0);
  mod._free(ptr);
  if (!handle) return null;
  const size = mod._jxl_wasm_buffer_size(handle);
  const dataPtr = mod._jxl_wasm_buffer_data(handle);
  const bytes = mod.HEAPU8.slice(dataPtr, dataPtr + size);
  mod._jxl_wasm_buffer_free(handle);
  return bytes;
}

const min    = a => Math.min(...a);
const median = a => { const s = [...a].sort((x,y) => x-y); return s[s.length >> 1]; };

console.log(`OLD: ${OLD_JS}`);
console.log(`NEW: ${NEW_JS}\n`);

const [oldMod, newMod] = await Promise.all([loadModule(OLD_JS), loadModule(NEW_JS)]);

// ── 1. Byte-exact correctness ────────────────────────────────────────────────
const CW = 1024, CH = 768;
const cgRgba = makeRgba(CW, CH);
const EFFORTS = [3, 5, 6, 7, 9];
let allPass = true;

console.log("=== SHA256 CORRECTNESS (1024×768) ===");
for (const e of EFFORTS) {
  const ob = encodeOnce(oldMod, cgRgba, CW, CH, e);
  const nb = encodeOnce(newMod, cgRgba, CW, CH, e);
  const oSha = ob ? createHash("sha256").update(ob).digest("hex").slice(0, 16) : "ERROR";
  const nSha = nb ? createHash("sha256").update(nb).digest("hex").slice(0, 16) : "ERROR";
  const ok = ob && nb && oSha === nSha;
  if (!ok) allPass = false;
  console.log(`  e${e}: ${ok ? "PASS" : "FAIL ★"}  ${oSha} == ${nSha}  ${((nb?.byteLength ?? 0) / 1024).toFixed(1)} KB`);
}
console.log(allPass ? "  ALL PASS — byte-exact ✓\n" : "  FAIL — output diverged ★\n");

// ── 2. Timing: true alternation OLD/NEW ─────────────────────────────────────
// Smaller sizes + lower efforts for speed; more reps = tighter estimate.
// Each encode is several hundred ms, so 10 reps × 2 sides per config is practical.
const BENCH_CONFIGS = [
  { w: 256, h: 192, label: "256×192",  efforts: [3, 5], reps: 12, warmup: 3 },
  { w: 512, h: 384, label: "512×384",  efforts: [3, 5], reps:  8, warmup: 2 },
  { w: 1024, h: 768, label: "1024×768", efforts: [3, 5], reps:  5, warmup: 2 },
];

console.log("=== TIMING — true alternation OLD/NEW, ms, lower=better ===");
console.log(`  ${"config".padEnd(16)} e  old_min  new_min   ratio(min)  old_med  new_med   ratio(med)`);

for (const { w, h, label, efforts, reps, warmup } of BENCH_CONFIGS) {
  const rgba = makeRgba(w, h);
  for (const e of efforts) {
    // warmup
    for (let i = 0; i < warmup; i++) {
      encodeOnce(oldMod, rgba, w, h, e);
      encodeOnce(newMod, rgba, w, h, e);
    }
    // true alternation
    const oldMs = [], newMs = [];
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now(); encodeOnce(oldMod, rgba, w, h, e); oldMs.push(performance.now() - t0);
      const t1 = performance.now(); encodeOnce(newMod, rgba, w, h, e); newMs.push(performance.now() - t1);
    }
    const oMin = min(oldMs), nMin = min(newMs);
    const oMed = median(oldMs), nMed = median(newMs);
    const rMin = (oMin / nMin).toFixed(3);
    const rMed = (oMed / nMed).toFixed(3);
    const flag = parseFloat(rMin) > 1.005 ? " ▲" : parseFloat(rMin) < 0.995 ? " ▼" : "";
    console.log(
      `  ${label.padEnd(16)} ${e}  ${oMin.toFixed(1).padStart(7)}  ${nMin.toFixed(1).padStart(7)}   ${rMin.padStart(10)}  ${oMed.toFixed(1).padStart(7)}  ${nMed.toFixed(1).padStart(7)}   ${rMed.padStart(10)}${flag}`
    );
  }
}

process.exit(allPass ? 0 : 1);
