#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const corpusManifestPath = join(packageRoot, "..", "jxl-test-corpus", "pgo-manifest.json");

export function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function compareEncodeBenchmarks({ baselineMs, candidateMs }) {
  const baselineMeanMs = mean(baselineMs);
  const candidateMeanMs = mean(candidateMs);
  const relativeGain = baselineMeanMs > 0 ? (baselineMeanMs - candidateMeanMs) / baselineMeanMs : 0;
  return {
    baselineMeanMs,
    candidateMeanMs,
    relativeGain,
    meetsDefaultThreshold: relativeGain >= 0.02
  };
}

export async function runComparisonBenchmarks({ baselineJs, baselineWasm, candidateJs, candidateWasm, scenarios, reps = 3 }) {
  const baseline = [];
  const candidate = [];

  baseline.push(...await benchmarkModule({ moduleJs: baselineJs, moduleWasm: baselineWasm, scenarios, reps }));
  candidate.push(...await benchmarkModule({ moduleJs: candidateJs, moduleWasm: candidateWasm, scenarios, reps }));

  candidate.push(...await benchmarkModule({ moduleJs: candidateJs, moduleWasm: candidateWasm, scenarios, reps }));
  baseline.push(...await benchmarkModule({ moduleJs: baselineJs, moduleWasm: baselineWasm, scenarios, reps }));

  return {
    comparison: compareEncodeBenchmarks({
      baselineMs: baseline.map((sample) => sample.ms),
      candidateMs: candidate.map((sample) => sample.ms)
    }),
    baseline,
    candidate
  };
}

export async function loadPgoScenarios(manifestPath = corpusManifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(manifest.scenarios)) {
    throw new Error(`Scenario manifest required at ${manifestPath}`);
  }
  return manifest.scenarios;
}

export async function benchmarkModule({ moduleJs, moduleWasm, scenarios, reps = 3 }) {
  const imported = await import(pathToFileURL(moduleJs).href);
  const createJxlModule = imported.default;
  if (typeof createJxlModule !== "function") {
    throw new Error(`Module ${moduleJs} missing default Emscripten factory`);
  }
  const wasmBinary = await readFile(moduleWasm);
  const module = await createJxlModule({
    wasmBinary,
    locateFile: () => moduleWasm
  });

  const samples = [];
  let warmed = false;
  for (const scenario of scenarios) {
    if (!Array.isArray(scenario.files) || scenario.files.length === 0) continue;
    for (const file of scenario.files) {
      const ppm = await readPortablePixmap(file);
      if (!warmed) {
        await runScenario(module, scenario, ppm, -1);
        warmed = true;
      }
      for (let rep = 0; rep < reps; rep++) {
        const started = performance.now();
        await runScenario(module, scenario, ppm, rep);
        samples.push({
          scenario: scenario.name,
          file,
          rep,
          ms: performance.now() - started
        });
      }
    }
  }
  return samples;
}

async function runScenario(module, scenario, ppm, rep) {
  switch (scenario.op) {
    case "encode-tiles":
      return encodeTileContainer(module, ppm, scenario.effort ?? 3);
    case "encode-pyramid":
      return encodePyramid(module, ppm, scenario.effort ?? 3, scenario.levels ?? 5);
    case "encode-container":
      return encodeWithMetadata(module, ppm, scenario.effort ?? 3, `${scenario.name}:${rep}`);
    case "encode":
    default:
      return encodeRgba8(module, ppm, scenario.effort ?? 3);
  }
}

async function encodePyramid(module, ppm, effort, levels) {
  let cur = ppm;
  for (let i = 0; i < levels; i++) {
    await encodeTileContainer(module, cur, effort);
    if (i !== levels - 1) cur = downscaleHalf(cur);
  }
}

async function encodeWithMetadata(module, ppm, effort, seed) {
  const payload = new TextEncoder().encode(`pgo:${seed}`);
  return encodeRgba8(module, ppm, effort, payload);
}

async function encodeTileContainer(module, ppm, effort) {
  const ptr = module._malloc(ppm.rgba.byteLength);
  if (ptr === 0) throw new Error("tile container malloc failed");
  try {
    module.HEAPU8.set(ppm.rgba, ptr);
    const handle = module._jxl_wasm_encode_tile_container_rgba8(ptr, ppm.width, ppm.height, 256, 1, effort, 0);
    consumeHandle(module, handle, "tile-container");
  } finally {
    module._free(ptr);
  }
}

async function encodeRgba8(module, ppm, effort, metadataBytes = null) {
  const ptr = module._malloc(ppm.rgba.byteLength);
  if (ptr === 0) throw new Error("encode malloc failed");
  let metaPtr = 0;
  try {
    module.HEAPU8.set(ppm.rgba, ptr);
    let handle = 0;
    if (metadataBytes && typeof module._jxl_wasm_encode_rgba8_with_metadata === "function") {
      metaPtr = module._malloc(metadataBytes.byteLength);
      if (metaPtr === 0 && metadataBytes.byteLength > 0) throw new Error("metadata malloc failed");
      module.HEAPU8.set(metadataBytes, metaPtr);
      handle = module._jxl_wasm_encode_rgba8_with_metadata(
        ptr, ppm.width, ppm.height, 1, effort, 0, 0, 2, 1, 1, 1,
        metaPtr, metadataBytes.byteLength,
        metaPtr, metadataBytes.byteLength,
        metaPtr, metadataBytes.byteLength
      );
    } else {
      handle = module._jxl_wasm_encode_rgba8(ptr, ppm.width, ppm.height, 1, effort, 0, 2, 1, 1, 1);
    }
    consumeHandle(module, handle, "encode");
  } finally {
    if (metaPtr) module._free(metaPtr);
    module._free(ptr);
  }
}

function consumeHandle(module, handle, label) {
  if (!handle) throw new Error(`${label} failed`);
  const error = module._jxl_wasm_buffer_error?.(handle) ?? 0;
  if (error !== 0) {
    module._jxl_wasm_buffer_free?.(handle);
    throw new Error(`${label} error ${error}`);
  }
  module._jxl_wasm_buffer_free?.(handle);
}

async function readPortablePixmap(path) {
  const bytes = new Uint8Array(await readFile(path));
  const header = parsePpmHeader(bytes);
  const rgb = bytes.subarray(header.offset, header.offset + header.width * header.height * 3);
  const rgba = new Uint8Array(header.width * header.height * 4);
  for (let i = 0, j = 0; i < rgb.byteLength; i += 3, j += 4) {
    rgba[j] = rgb[i];
    rgba[j + 1] = rgb[i + 1];
    rgba[j + 2] = rgb[i + 2];
    rgba[j + 3] = 255;
  }
  return { width: header.width, height: header.height, rgba };
}

function parsePpmHeader(bytes) {
  let i = 0;
  const tokens = [];
  while (tokens.length < 4) {
    while (i < bytes.length && isWhitespace(bytes[i])) i++;
    if (bytes[i] === 0x23) {
      while (i < bytes.length && bytes[i] !== 0x0a) i++;
      continue;
    }
    const start = i;
    while (i < bytes.length && !isWhitespace(bytes[i])) i++;
    tokens.push(new TextDecoder().decode(bytes.subarray(start, i)));
  }
  while (i < bytes.length && isWhitespace(bytes[i])) i++;
  return {
    width: Number(tokens[1]),
    height: Number(tokens[2]),
    offset: i
  };
}

function isWhitespace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function downscaleHalf(ppm) {
  const width = Math.max(1, Math.floor(ppm.width / 2));
  const height = Math.max(1, Math.floor(ppm.height / 2));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcX = Math.min(ppm.width - 1, x * 2);
      const srcY = Math.min(ppm.height - 1, y * 2);
      const src = (srcY * ppm.width + srcX) * 4;
      const dst = (y * width + x) * 4;
      rgba[dst] = ppm.rgba[src];
      rgba[dst + 1] = ppm.rgba[src + 1];
      rgba[dst + 2] = ppm.rgba[src + 2];
      rgba[dst + 3] = 255;
    }
  }
  return { width, height, rgba };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    out[arg.slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baselineJs = args["baseline-js"];
  const baselineWasm = args["baseline-wasm"];
  const candidateJs = args["candidate-js"];
  const candidateWasm = args["candidate-wasm"];
  const reps = Math.max(1, Number(args["reps"] ?? 3));
  const scenarioFilter = args["scenario"] ?? null;
  if (!baselineJs || !baselineWasm || !candidateJs || !candidateWasm) {
    throw new Error("Usage: node scripts/benchmark-pgo.mjs --baseline-js <js> --baseline-wasm <wasm> --candidate-js <js> --candidate-wasm <wasm>");
  }
  const scenarios = await loadResolvedScenarios(scenarioFilter);
  const result = await runComparisonBenchmarks({ baselineJs, baselineWasm, candidateJs, candidateWasm, scenarios, reps });
  console.log(JSON.stringify(result, null, 2));
}

async function loadResolvedScenarios(filter = null) {
  const manifest = await loadPgoScenarios();
  const picked = filter ? manifest.filter((scenario) => scenario.name === filter) : manifest;
  return await Promise.all(picked.map(async (scenario) => ({
    ...scenario,
    files: (await Promise.all(scenario.files.map((pattern) => expandKnownPattern(pattern)))).flat()
  })));
}

async function expandKnownPattern(pattern) {
  let dir = null;
  if (pattern === "tiles/256/*.ppm") dir = join(packageRoot, "..", "jxl-test-corpus", "tiles", "256");
  if (pattern === "full/*.ppm") dir = join(packageRoot, "..", "jxl-test-corpus", "full");
  if (pattern === "full/withmeta/*.ppm") dir = join(packageRoot, "..", "jxl-test-corpus", "full", "withmeta");
  if (!dir) return [];
  return (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ppm"))
    .map((entry) => join(dir, entry.name));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
