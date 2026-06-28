// SHA byte-exact + timing compare for the dec_xyb XybToRgb specializations.
// Loads two plain encoder wasm modules (OLD baseline, NEW with the opts),
// encodes the same RGBA8 image, hashes the output, and compares.
//
// OpsinToLinear (XYB->linear) runs on the whole-frame encode path, so the
// EqualBias specialization (default opsin transform) is exercised here.
//
// Usage: node tools/decxyb-sha-compare.mjs <old.plain.js> <new.plain.js> <img.ppm> [effort] [reps]

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const [, , oldJs, newJs, imgPath, effortArg, repsArg] = process.argv;
const effort = Number(effortArg ?? 5);
const reps = Number(repsArg ?? 30);

function parsePpmHeader(bytes) {
  let o = 0;
  const tok = () => {
    while (o < bytes.length && /\s/.test(String.fromCharCode(bytes[o]))) o++;
    let s = "";
    while (o < bytes.length && !/\s/.test(String.fromCharCode(bytes[o])))
      s += String.fromCharCode(bytes[o++]);
    return s;
  };
  const magic = tok();
  if (magic !== "P6") throw new Error("expected P6 PPM");
  const width = Number(tok());
  const height = Number(tok());
  tok(); // maxval
  o++; // single whitespace after maxval
  return { width, height, offset: o };
}

async function loadPpm(path) {
  const bytes = new Uint8Array(await readFile(path));
  const h = parsePpmHeader(bytes);
  const rgb = bytes.subarray(h.offset, h.offset + h.width * h.height * 3);
  const rgba = new Uint8Array(h.width * h.height * 4);
  for (let i = 0, j = 0; i < rgb.byteLength; i += 3, j += 4) {
    rgba[j] = rgb[i];
    rgba[j + 1] = rgb[i + 1];
    rgba[j + 2] = rgb[i + 2];
    rgba[j + 3] = 255;
  }
  return { width: h.width, height: h.height, rgba };
}

async function loadModule(jsPath) {
  const wasmPath = jsPath.replace(/\.js$/, ".wasm");
  const imported = await import("file://" + jsPath.replace(/\\/g, "/"));
  const wasmBinary = await readFile(wasmPath);
  return imported.default({ wasmBinary });
}

function encodeOnce(module, ppm, effort) {
  const ptr = module._malloc(ppm.rgba.byteLength);
  if (!ptr) throw new Error("malloc failed");
  try {
    module.HEAPU8.set(ppm.rgba, ptr);
    const handle = module._jxl_wasm_encode_rgba8(
      ptr, ppm.width, ppm.height, 1, effort, 0, 2, 1, 1, 1);
    if (!handle) throw new Error("encode failed (null handle)");
    const err = module._jxl_wasm_buffer_error?.(handle) ?? 0;
    if (err !== 0) {
      module._jxl_wasm_buffer_free?.(handle);
      throw new Error("encode error " + err);
    }
    const dataPtr = module._jxl_wasm_buffer_data(handle);
    const size = module._jxl_wasm_buffer_size(handle);
    const out = module.HEAPU8.slice(dataPtr, dataPtr + size);
    module._jxl_wasm_buffer_free?.(handle);
    return out;
  } finally {
    module._free(ptr);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function measure(jsPath, label, ppm) {
  const module = await loadModule(jsPath);
  const out = encodeOnce(module, ppm, effort); // warm + capture bytes
  const hash = sha256(out);
  const times = [];
  for (let r = 0; r < reps; r++) {
    const t0 = process.hrtime.bigint();
    encodeOnce(module, ppm, effort);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const median = times[times.length >> 1];
  console.log(`  ${label}: ${out.byteLength} B, sha ${hash.slice(0, 16)}…, median ${median.toFixed(2)} ms`);
  return { hash, median, size: out.byteLength };
}

const ppm = await loadPpm(imgPath);
console.log(`image ${ppm.width}x${ppm.height}, effort ${effort}, reps ${reps}\n`);
const a = await measure(oldJs, "OLD", ppm);
const b = await measure(newJs, "NEW", ppm);
console.log("");
console.log(`byte-exact: ${a.hash === b.hash ? "YES (sha identical)" : "NO — DIFFER"}`);
console.log(`delta: ${(((b.median - a.median) / a.median) * 100).toFixed(2)}% (neg = NEW faster)`);
