#!/usr/bin/env node
// dec-initonce-flipflop — byte-exact + timing validation for the InitOnce
// per-group strategy-scan elimination (perf/dec-cache-initonce-by-area).
//
// What changed: InitOnce() no longer scans all 27 AcStrategies to compute
// max_block_area on every group call. The value is precomputed once in
// InitForAC() and passed directly. Pointers are also only reassigned when
// the arena actually grows. Expected win: small setup overhead reduction
// (~27 conditional checks × #groups × #threads per decode); primarily a
// code-quality change that removes redundant per-group scans.
//
// Usage:
//   node tools/dec-initonce-flipflop.mjs [OLD_JS [NEW_JS [FILE...]]]
//
// Defaults:
//   OLD_JS = packages/jxl-wasm/dist/jxl-core.dec.simd.OLD.js
//   NEW_JS = packages/jxl-wasm/dist/jxl-core.dec.simd.js
//   FILEs  = docs/Benchmark results/*.jxl
//
// Workflow:
//   1. Back up current WASM before rebuilding:
//      cp packages/jxl-wasm/dist/jxl-core.dec.simd.{js,OLD.js}
//      cp packages/jxl-wasm/dist/jxl-core.dec.simd.{wasm,OLD.wasm}
//   2. Rebuild WASM with libjxl-012 on branch perf/dec-cache-initonce-by-area:
//      cmd /c "call C:\Users\User\emsdk\emsdk_env.bat >nul && node packages/jxl-wasm/scripts/build.mjs --host-toolchain"
//   3. node tools/dec-initonce-flipflop.mjs

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, "..");

const userArgs = process.argv.slice(2).filter(a => !a.startsWith("-"));
const OLD_JS  = resolve(userArgs[0] ?? join(REPO, "packages/jxl-wasm/dist/jxl-core.dec.simd.OLD.js"));
const NEW_JS  = resolve(userArgs[1] ?? join(REPO, "packages/jxl-wasm/dist/jxl-core.dec.simd.js"));
const FILES   = userArgs.slice(2).length > 0
  ? userArgs.slice(2).map(f => resolve(f))
  : [
      join(REPO, "docs/Benchmark results/P2200619-prog-p6-q85.jxl"),
      join(REPO, "docs/Benchmark results/P2200674-prog-p6-q85.jxl"),
      join(REPO, "packages/jxl-test-corpus/fixtures/srgb-8bit.jxl"),
      join(REPO, "packages/jxl-test-corpus/fixtures/lossless-16bit.jxl"),
      join(REPO, "packages/jxl-test-corpus/fixtures/adobe-rgb-16bit.jxl"),
    ];

const REPS    = parseInt(process.argv.find(a => a.startsWith("--reps="))?.slice(7) ?? "30");
const WARMUP  = 5;

// ─── stats helpers ─────────────────────────────────────────────────────────
const min    = a => Math.min(...a);
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const mean   = a => a.reduce((s, v) => s + v, 0) / a.length;
const sha256 = buf => createHash("sha256").update(buf).digest("hex");

// ─── module loader ─────────────────────────────────────────────────────────
async function loadModule(jsPath) {
  const abs = resolve(jsPath);
  const wasmPath = abs.replace(/\.js$/, ".wasm");
  const url = "file:///" + abs.replaceAll("\\", "/");
  const { default: createModule } = await import(url);
  const wasmBinary = await readFile(wasmPath);
  return createModule({ wasmBinary, locateFile: () => wasmPath });
}

// ─── single decode using the one-shot helper ───────────────────────────────
function decodeRgba8(mod, jxlBytes) {
  const inPtr = mod._malloc(jxlBytes.length);
  mod.HEAPU8.set(jxlBytes, inPtr);
  const handle = mod._jxl_wasm_decode_rgba8(inPtr, jxlBytes.length, 1);
  mod._free(inPtr);
  if (!handle) return null;
  const size    = mod._jxl_wasm_buffer_size(handle);
  const dataPtr = mod._jxl_wasm_buffer_data(handle);
  const pixels  = mod.HEAPU8.slice(dataPtr, dataPtr + size);
  mod._jxl_wasm_buffer_free(handle);
  return pixels;
}

// ─── main ──────────────────────────────────────────────────────────────────
console.log(`OLD: ${OLD_JS}`);
console.log(`NEW: ${NEW_JS}\n`);

let [oldMod, newMod] = [null, null];
try {
  [oldMod, newMod] = await Promise.all([loadModule(OLD_JS), loadModule(NEW_JS)]);
} catch (e) {
  console.error(`Failed to load WASM module: ${e.message}`);
  console.error("Build the WASM and copy OLD before running. See header comment.");
  process.exit(1);
}

let anyFail = false;

for (const file of FILES) {
  let jxl;
  try { jxl = await readFile(file); }
  catch { console.warn(`[skip] ${file} — not found`); continue; }

  const label = file.replace(REPO, "").replaceAll("\\", "/");
  console.log(`\n=== ${label} (${(jxl.length / 1024).toFixed(1)} KB) ===`);

  // ── correctness ────────────────────────────────────────────────────────
  const oldPx = decodeRgba8(oldMod, jxl);
  const newPx = decodeRgba8(newMod, jxl);

  if (!oldPx || !newPx) {
    console.error(`  FAIL: decode returned null (old=${!!oldPx} new=${!!newPx})`);
    anyFail = true;
    continue;
  }

  const oldHash = sha256(oldPx);
  const newHash = sha256(newPx);
  const byteExact = oldHash === newHash;
  console.log(`  byte-exact: ${byteExact ? "PASS" : "FAIL"}`);
  if (!byteExact) {
    console.error(`    OLD: ${oldHash}`);
    console.error(`    NEW: ${newHash}`);
    anyFail = true;
  }
  console.log(`  pixels: ${oldPx.length} bytes  (${Math.round(oldPx.length / 4)} px)`);

  // ── warmup ─────────────────────────────────────────────────────────────
  for (let i = 0; i < WARMUP; i++) {
    decodeRgba8(oldMod, jxl);
    decodeRgba8(newMod, jxl);
  }

  // ── TRUE alternation A/B timing ────────────────────────────────────────
  const oldTimes = [], newTimes = [];
  for (let i = 0; i < REPS; i++) {
    const t0 = performance.now(); decodeRgba8(oldMod, jxl); oldTimes.push(performance.now() - t0);
    const t1 = performance.now(); decodeRgba8(newMod, jxl); newTimes.push(performance.now() - t1);
  }

  const oMin = min(oldTimes),   nMin = min(newTimes);
  const oMed = median(oldTimes), nMed = median(newTimes);
  const oMean = mean(oldTimes),  nMean = mean(newTimes);

  console.log(`  timing (${REPS}×, ms):`);
  console.log(`    min:    OLD=${oMin.toFixed(2)}  NEW=${nMin.toFixed(2)}  ratio=${(oMin/nMin).toFixed(3)}`);
  console.log(`    median: OLD=${oMed.toFixed(2)}  NEW=${nMed.toFixed(2)}  ratio=${(oMed/nMed).toFixed(3)}`);
  console.log(`    mean:   OLD=${oMean.toFixed(2)}  NEW=${nMean.toFixed(2)}  ratio=${(oMean/nMean).toFixed(3)}`);
  console.log(`  NOTE: expected ratio ~1.000–1.005 (setup overhead, not hot-path)`);
}

if (anyFail) {
  console.error("\nCORRECTNESS FAIL — byte-exact check failed on at least one file.");
  process.exitCode = 1;
} else {
  console.log("\nAll byte-exact checks PASS.");
}
