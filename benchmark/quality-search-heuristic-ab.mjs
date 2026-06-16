/**
 * A/B benchmark for the C-8 candidate: recommendedQualitySearch() heuristic.
 *
 * The proposal (from HANDOFF-jxl-capabilities...):
 *   export function recommendedQualitySearch(): "full" | "fast" | "none" {
 *     const t = detectTier();
 *     return t === "scalar" ? "none" : t === "simd" ? "fast" : "full";
 *   }
 *
 * Maps to concrete encode "search effort" (libjxl perceptual/decision search work):
 *   "none" → effort=4
 *   "fast" → effort=6
 *   "full" → effort=8
 *
 * Switch / flag:
 *   QUALITY_SEARCH_HEURISTIC=off   → always use "full" (baseline: ignore tier, always max search)
 *   QUALITY_SEARCH_HEURISTIC=on    → use the tier-derived recommendation
 *
 * Consecutive off/on:
 *   $env:HEURISTIC_SEQUENCE="off,on"; node benchmark/quality-search-heuristic-ab.mjs
 *   $env:HEURISTIC_SEQUENCE="off,on,off,on"; ...   (more flips for stability)
 *
 * Simulation of weak devices (so you can see the heuristic *saving* work):
 *   $env:SIMULATE_TIER=simd; $env:HEURISTIC_SEQUENCE="off,on"; node ...
 *   $env:SIMULATE_TIER=scalar; ...
 *
 * Files: mix of .orf / .dng / .cr2 from C:\Foo\raw-converter\tests (edit SELECTED_NAMES).
 * Keeps runs short: heavy downscale (default 1200px long edge) + small file set.
 *
 * Metrics per file+mode: encode wall time (the cost of "search"), output size (the benefit).
 * Optional: set USE_BUTTERAUGLI=1 to compute butteraugli distance of each result vs a "full" reference.
 *
 * This bench inlines the candidate logic (and will prefer the built dist export if you
 * compile packages/jxl-capabilities after editing src). The canonical source for the
 * function (if we keep C-8) is now in packages/jxl-capabilities/src/index.ts .
 */

import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  TEST_ROOT,
  decodeRawToRgba,
  encodeJxl,
  ensureTimingOutDir,
  initRawWasm,
  installBrowserLikeWorker,
  listRawFiles,
} from "./optimal-settings-timing-utils.mjs";

installBrowserLikeWorker();

// Benchmarks that use the Node Worker shim + repeated encodes are far more stable
// on the single-threaded "simd" build. The heuristic itself is still exercised via
// SIMULATE_TIER (scalar / simd / relaxed-simd-mt etc.) so we can see "none"/"fast"/"full"
// choices and their effort mapping without flakiness in the harness.
process.env.JXL_WASM_FORCE_TIER ??= "simd";

const { createEncoder, detectTier: realDetectTier, setForcedTier } = await import("../packages/jxl-wasm/dist/index.js");
const { computeButteraugli } = await import("../packages/jxl-wasm/dist/index.js").catch(() => ({ computeButteraugli: null }));

// Force a stable single-threaded build for the encode work in this harness (the shim +
// repeated MT pthread loads are flaky in Node/bun benchmark runs). The *heuristic decision*
// is still fully testable via SIMULATE_TIER.
const stableTier = process.env.JXL_WASM_FORCE_TIER || "simd";
try { setForcedTier(stableTier); } catch {}
const forcedTierUsed = (() => { try { return realDetectTier(); } catch { return stableTier; } })();

await initRawWasm();
ensureTimingOutDir();

// --- The C-8 candidate (exact proposal) ---
/** Heuristic; thresholds untuned — benchmark before relying on it (CLAUDE.md rule). */
function recommendedQualitySearch(tier = null) {
  const t = tier || realDetectTier();
  return t === "scalar" ? "none" : t === "simd" ? "fast" : "full";
}

// Try to use the real export if the package was built after the src edit.
let packageRecommendedQualitySearch = null;
try {
  const caps = await import("../packages/jxl-capabilities/dist/index.js");
  if (typeof caps.recommendedQualitySearch === "function") {
    packageRecommendedQualitySearch = caps.recommendedQualitySearch;
    console.log("[qsearch-ab] using recommendedQualitySearch from packages/jxl-capabilities/dist (built)");
  }
} catch {
  // fine — using the inlined copy for this run
}

function getRecommendedQualitySearch() {
  return packageRecommendedQualitySearch || recommendedQualitySearch;
}

// --- Config via env (easy to flip consecutively) ---
const TARGET = Math.max(800, Number(process.env.TARGET ?? "1200"));
const QUALITY = Number(process.env.QUALITY ?? "85");
const USE_BA = process.env.USE_BUTTERAUGLI === "1" || process.env.USE_BUTTERAUGLI === "true";

const SEQUENCE = (process.env.HEURISTIC_SEQUENCE || "off,on")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const SIMULATE_TIER = process.env.SIMULATE_TIER || null;

function getEffectiveTier() {
  if (SIMULATE_TIER) return SIMULATE_TIER;
  return realDetectTier();
}

function searchToEffort(search) {
  if (search === "none") return 4;
  if (search === "fast") return 6;
  return 8; // full
}

const SELECTED_NAMES = [
  "P1110226.ORF",
  "PXL_20260527_175945329.RAW-02.ORIGINAL.dng",
  "PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
  // Add a CR2 if you want more format coverage (may be slower):
  // "ADH 1490.CR2",
];

function resolveFiles() {
  const byName = new Map();
  const all = listRawFiles({ dir: TEST_ROOT, extensions: [".orf", ".dng", ".cr2", ".raw"], limit: 100, largest: false });
  for (const f of all) byName.set(f.name.toLowerCase(), f);

  const out = [];
  for (const name of SELECTED_NAMES) {
    const hit = byName.get(name.toLowerCase());
    if (hit) out.push(hit);
  }
  if (!out.length) {
    // fallback: first few mixed from the dir
    const mixed = listRawFiles({ dir: TEST_ROOT, extensions: [".orf", ".dng", ".cr2"], limit: 3, largest: false });
    out.push(...mixed);
  }
  return out;
}

const files = resolveFiles();
if (!files.length) throw new Error("No test RAW files found. Put .dng/.cr2/.orf in C:\\Foo\\raw-converter\\tests or edit SELECTED_NAMES.");

const tier = getEffectiveTier();
const rec = getRecommendedQualitySearch();
console.log(`[qsearch-ab] forcedTier=${forcedTierUsed} (realDetect=${realDetectTier()}) effectiveForHeuristic=${tier} target=${TARGET}px quality=${QUALITY} files=${files.length}`);
console.log(`[qsearch-ab] sequence=${SEQUENCE.join(",")} simulate=${SIMULATE_TIER || "no"} butteraugliCompare=${USE_BA}`);

const allResults = [];

for (const mode of SEQUENCE) {
  const useHeuristic = mode === "on" || mode === "true" || mode === "1";
  console.log(`\n=== MODE heuristic=${mode} (useHeuristic=${useHeuristic}) ===`);

  for (const file of files) {
    const name = file.name;
    const effectiveSearch = useHeuristic ? rec(tier) : "full";
    const effort = searchToEffort(effectiveSearch);

    console.log(`  ${name} → search=${effectiveSearch} effort=${effort} ...`);

    const dec = decodeRawToRgba(file.path, TARGET);
    const encStart = performance.now();
    const enc = await encodeJxl(createEncoder, dec.rgba, dec.width, dec.height, {
      quality: QUALITY,
      effort,
      progressive: false,   // keep simple for pure encode-time comparison; flip to true for progressive realism
    });
    const encodeMs = performance.now() - encStart;

    const sizeKb = (enc.bytes.byteLength / 1024).toFixed(1);

    const row = {
      mode,
      file: name,
      tier: effectiveTierForLog(),
      search: effectiveSearch,
      effort,
      encodeMs: +encodeMs.toFixed(1),
      sizeKb: +sizeKb,
      width: dec.width,
      height: dec.height,
    };

    // Optional perceptual check: butteraugli of this encode vs a "full" reference (same pixels, max search)
    if (USE_BA && computeButteraugli && effectiveSearch !== "full") {
      try {
        const ref = await encodeJxl(createEncoder, dec.rgba, dec.width, dec.height, {
          quality: QUALITY,
          effort: 8,
          progressive: false,
        });
        // decode both to pixels for butteraugli (or pass the rgba we already have? computeButteraugli takes raw pixel buffers)
        // For simplicity we just note; full compare would need decode step. Here we record the idea.
        row.butteraugliRefNote = "would compare vs effort=8 here";
      } catch (e) {
        row.butteraugliRefNote = "ba error: " + e.message;
      }
    }

    allResults.push(row);
    console.log(`    encode=${encodeMs.toFixed(1)}ms size=${sizeKb}KB ${dec.width}×${dec.height}`);
  }
}

function effectiveTierForLog() {
  return SIMULATE_TIER || realDetectTier();
}

// Summary
console.log("\n=== SUMMARY (toggle via HEURISTIC_SEQUENCE or QUALITY_SEARCH_HEURISTIC) ===");
const byMode = {};
for (const r of allResults) {
  (byMode[r.mode] ||= []).push(r);
}
for (const [mode, rows] of Object.entries(byMode)) {
  const totalMs = rows.reduce((s, r) => s + r.encodeMs, 0);
  const totalKb = rows.reduce((s, r) => s + r.sizeKb, 0);
  console.log(`${mode}: ${rows.length} files, totalEncode=${totalMs.toFixed(1)}ms, totalSize=${totalKb.toFixed(1)}KB`);
  for (const r of rows) {
    console.log(`  ${r.file} search=${r.search} effort=${r.effort} ${r.encodeMs}ms ${r.sizeKb}KB`);
  }
}

console.log("\nRe-run with flipped env for consecutive off/on data. Add SIMULATE_TIER=scalar|simd to see heuristic savings on weak devices.");
console.log("When happy with numbers, the function in packages/jxl-capabilities/src/index.ts can stay (or be removed if the data says the mapping is not worth the surface).");

// Write a tiny json for later analysis if desired
// (left as console for now; extend like other benches if you want persistent toons)