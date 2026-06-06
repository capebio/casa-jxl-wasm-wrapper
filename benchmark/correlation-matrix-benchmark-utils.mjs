import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { concatChunks, exactBuffer } from "./optimal-settings-timing-utils.mjs";

const moduleCache = new Map();

export async function loadJxlCoreModule(tier) {
  if (moduleCache.has(tier)) return moduleCache.get(tier);
  const factory = (await import(`../packages/jxl-wasm/dist/jxl-core.${tier}.js`)).default;
  const base = new URL("../packages/jxl-wasm/dist/", import.meta.url);
  const wasmBinary = readFileSync(new URL(`jxl-core.${tier}.wasm`, base));
  const module = await factory({
    wasmBinary,
    locateFile: (path) => new URL(path, base).href,
  });
  moduleCache.set(tier, module);
  return module;
}

export async function encodeJxlMatrix(module, rgba, width, height, options) {
  const distance = options.distance ?? distanceFromQuality(options.quality ?? 85);
  const fmt = 0;
  const hasAlpha = options.hasAlpha ? 1 : 0;
  const progressive = options.progressive !== false;
  const progressiveDc = progressive ? 1 : 0;
  const progressiveAc = progressive ? 1 : 0;
  const qProgressiveAc = progressive ? 1 : 0;
  const buffering = options.chunked === false ? 0 : 2;
  const groupOrder = progressive ? 1 : 0;
  const state = module._jxl_wasm_enc_create_image_y(
    width,
    height,
    distance,
    options.effort ?? 3,
    fmt,
    hasAlpha,
    progressiveDc,
    progressiveAc,
    qProgressiveAc,
    buffering,
    groupOrder,
    options.modular ?? -1,
    -1,
    -1,
    options.photonNoiseIso ?? 0,
    1,
    -1,
    -1,
    options.dots ?? -1,
    -1,
    options.colorTransform ?? -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
  );
  if (state === 0) throw new Error("JXL matrix encoder creation failed");

  const chunks = [];
  const started = performance.now();
  try {
    const view = new Uint8Array(exactBuffer(rgba));
    const ptr = module._jxl_wasm_enc_pixels_ptr(state, view.byteLength);
    if (ptr === 0) throw new Error("JXL matrix pixel buffer allocation failed");
    module.HEAPU8.set(view, ptr);
    const advance = module._jxl_wasm_enc_advance_written(state, view.byteLength);
    if (advance !== 0) throw new Error(`JXL matrix pixel push failed (${advance})`);
    const finish = module._jxl_wasm_enc_finish(state);
    if (finish !== 0) throw new Error(`JXL matrix encode failed (${finish})`);

    let handle = 0;
    while ((handle = module._jxl_wasm_enc_take_chunk(state)) !== 0) {
      chunks.push(takeBuffer(module, handle));
    }
    return { bytes: concatChunks(chunks), ms: performance.now() - started };
  } finally {
    module._jxl_wasm_enc_free(state);
  }
}

function takeBuffer(module, handle) {
  const error = typeof module._jxl_wasm_buffer_error === "function"
    ? module._jxl_wasm_buffer_error(handle)
    : 0;
  if (error) {
    module._jxl_wasm_buffer_free(handle);
    throw new Error(`JXL matrix buffer error (${error})`);
  }
  const ptr = module._jxl_wasm_buffer_data(handle);
  const size = module._jxl_wasm_buffer_size(handle);
  const out = new Uint8Array(module.HEAPU8.subarray(ptr, ptr + size));
  module._jxl_wasm_buffer_free(handle);
  return out;
}

function distanceFromQuality(quality) {
  if (quality == null) return 1;
  if (!Number.isFinite(quality)) throw new Error(`Invalid JXL quality: ${quality}`);
  const q = Math.max(0, Math.min(100, quality));
  return ((100 - q) * 15) / 100;
}
