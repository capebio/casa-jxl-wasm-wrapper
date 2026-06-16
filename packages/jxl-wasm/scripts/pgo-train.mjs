#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename } from "node:path";

const moduleJs = process.env.JXL_PGO_MODULE_JS;
const moduleWasm = process.env.JXL_PGO_MODULE_WASM;
const lockPath = process.env.JXL_PGO_LOCK_PATH;

if (!moduleJs || !moduleWasm || !lockPath) {
  throw new Error("PGO trainer requires JXL_PGO_MODULE_JS, JXL_PGO_MODULE_WASM, and JXL_PGO_LOCK_PATH");
}

const imported = await import(pathToFileUrl(moduleJs));
const createJxlModule = imported.default;
if (typeof createJxlModule !== "function") {
  throw new Error(`Instrumented module missing default factory: ${moduleJs}`);
}

const wasmBinary = await readFile(moduleWasm);
const module = await createJxlModule({
  wasmBinary,
  locateFile: () => moduleWasm
});
const lock = JSON.parse(await readFile(lockPath, "utf8"));

for (const scenario of lock.scenarios ?? []) {
  const reps = repsFromWeight(scenario.weight);
  for (let rep = 0; rep < reps; rep++) {
    for (const file of scenario.files ?? []) {
      const ppm = await readPortablePixmap(file);
      await runScenario(module, scenario, ppm, rep);
    }
  }
}

function repsFromWeight(weight) {
  return Math.max(1, Math.round(Number(weight || 0) * 12));
}

async function runScenario(module, scenario, ppm, rep) {
  switch (scenario.op) {
    case "encode-tiles":
      await encodeTileContainer(module, ppm, { tileSize: 256, effort: scenario.effort ?? 3, distance: 1 });
      break;
    case "encode-pyramid":
      await encodePyramid(module, ppm, { levels: scenario.levels ?? 5, effort: scenario.effort ?? 3, rep });
      break;
    case "encode-container":
      await encodeWithMetadata(module, ppm, { effort: scenario.effort ?? 3, seed: `${scenario.name}:${rep}:${basename(ppm.path)}` });
      break;
    case "encode":
    default:
      await encodeRgba8(module, ppm, { effort: scenario.effort ?? 3, distance: 1 });
      break;
  }
}

async function encodePyramid(module, ppm, options) {
  let cur = ppm;
  const levels = Math.max(1, options.levels);
  for (let level = 0; level < levels; level++) {
    await encodeTileContainer(module, cur, { tileSize: 256, effort: options.effort, distance: 1 });
    if (level !== levels - 1) {
      cur = downscaleHalf(cur);
    }
  }
}

async function encodeWithMetadata(module, ppm, options) {
  const metadata = makeMetadataTriplet(options.seed);
  await encodeRgba8(module, ppm, { effort: options.effort, distance: 1, metadata });
}

async function encodeTileContainer(module, ppm, options) {
  const ptr = module._malloc(ppm.rgba.byteLength);
  if (ptr === 0) throw new Error("PGO tile-container encode malloc failed");
  try {
    module.HEAPU8.set(ppm.rgba, ptr);
    const handle = module._jxl_wasm_encode_tile_container_rgba8?.(
      ptr,
      ppm.width,
      ppm.height,
      options.tileSize,
      options.distance,
      options.effort,
      0
    );
    consumeHandle(module, handle, "tile container encode");
  } finally {
    module._free(ptr);
  }
}

async function encodeRgba8(module, ppm, options) {
  const ptr = module._malloc(ppm.rgba.byteLength);
  if (ptr === 0) throw new Error("PGO encode malloc failed");
  let iccPtr = 0;
  let exifPtr = 0;
  let xmpPtr = 0;
  try {
    module.HEAPU8.set(ppm.rgba, ptr);
    let handle = 0;
    if (options.metadata && typeof module._jxl_wasm_encode_rgba8_with_metadata === "function") {
      ({ ptr: iccPtr } = copyBytes(module, options.metadata.icc));
      ({ ptr: exifPtr } = copyBytes(module, options.metadata.exif));
      ({ ptr: xmpPtr } = copyBytes(module, options.metadata.xmp));
      handle = module._jxl_wasm_encode_rgba8_with_metadata(
        ptr,
        ppm.width,
        ppm.height,
        options.distance,
        options.effort,
        0,
        0,
        2,
        1,
        1,
        1,
        iccPtr,
        options.metadata.icc.byteLength,
        exifPtr,
        options.metadata.exif.byteLength,
        xmpPtr,
        options.metadata.xmp.byteLength
      );
    } else {
      handle = module._jxl_wasm_encode_rgba8(
        ptr,
        ppm.width,
        ppm.height,
        options.distance,
        options.effort,
        0,
        2,
        1,
        1,
        1
      );
    }
    consumeHandle(module, handle, "encode");
  } finally {
    if (iccPtr) module._free(iccPtr);
    if (exifPtr) module._free(exifPtr);
    if (xmpPtr) module._free(xmpPtr);
    module._free(ptr);
  }
}

function copyBytes(module, bytes) {
  const ptr = module._malloc(bytes.byteLength);
  if (ptr === 0 && bytes.byteLength > 0) throw new Error("PGO metadata malloc failed");
  module.HEAPU8.set(bytes, ptr);
  return { ptr };
}

function consumeHandle(module, handle, label) {
  if (!handle) throw new Error(`PGO ${label} failed`);
  const error = module._jxl_wasm_buffer_error?.(handle) ?? 0;
  if (error !== 0) {
    module._jxl_wasm_buffer_free?.(handle);
    throw new Error(`PGO ${label} returned error ${error}`);
  }
  module._jxl_wasm_buffer_free?.(handle);
}

function makeMetadataTriplet(seed) {
  const payload = new TextEncoder().encode(`pgo:${seed}`);
  return {
    icc: payload,
    exif: payload,
    xmp: payload
  };
}

async function readPortablePixmap(path) {
  const bytes = new Uint8Array(await readFile(path));
  const header = parsePpmHeader(bytes);
  if (header.magic !== "P6") {
    throw new Error(`Unsupported PPM magic ${header.magic} in ${path}; expected binary P6`);
  }
  if (header.maxValue !== 255) {
    throw new Error(`Unsupported PPM max value ${header.maxValue} in ${path}; expected 255`);
  }
  const rgb = bytes.subarray(header.offset, header.offset + header.width * header.height * 3);
  if (rgb.byteLength !== header.width * header.height * 3) {
    throw new Error(`PPM pixel payload truncated in ${path}`);
  }
  const rgba = new Uint8Array(header.width * header.height * 4);
  for (let i = 0, j = 0; i < rgb.byteLength; i += 3, j += 4) {
    rgba[j] = rgb[i];
    rgba[j + 1] = rgb[i + 1];
    rgba[j + 2] = rgb[i + 2];
    rgba[j + 3] = 255;
  }
  return { path, width: header.width, height: header.height, rgba };
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
    magic: tokens[0],
    width: Number(tokens[1]),
    height: Number(tokens[2]),
    maxValue: Number(tokens[3]),
    offset: i
  };
}

function isWhitespace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function downscaleHalf(ppm) {
  const nextWidth = Math.max(1, Math.floor(ppm.width / 2));
  const nextHeight = Math.max(1, Math.floor(ppm.height / 2));
  const next = new Uint8Array(nextWidth * nextHeight * 4);
  for (let y = 0; y < nextHeight; y++) {
    for (let x = 0; x < nextWidth; x++) {
      const srcX = Math.min(ppm.width - 1, x * 2);
      const srcY = Math.min(ppm.height - 1, y * 2);
      const src = (srcY * ppm.width + srcX) * 4;
      const dst = (y * nextWidth + x) * 4;
      next[dst] = ppm.rgba[src];
      next[dst + 1] = ppm.rgba[src + 1];
      next[dst + 2] = ppm.rgba[src + 2];
      next[dst + 3] = 255;
    }
  }
  return { path: ppm.path, width: nextWidth, height: nextHeight, rgba: next };
}

function pathToFileUrl(path) {
  const normalized = path.replaceAll("\\", "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}
