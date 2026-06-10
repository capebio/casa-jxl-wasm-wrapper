import { createDecoder } from "@casabio/jxl-wasm";
import type { ImageRegion } from "./tiling.js";
import type { LevelSource } from "./level-source.js";
import {
  WHOLE_DECODE_OPTS,
  type RegionDecoder,
  type DecodedLevel,
  PyramidError,
  type DecodeOptions,
} from "./decode-core.js";
import { prepareDecodePlan } from "./plan.js";
import { getLevelId } from "./cache.js";

export type { DecodedLevel, RegionDecoder, DecodeOptions, PyramidError } from "./decode-core.js";

/**
 * Decode a rectangular viewport from a tiled JXTC level.
 * Uses per-tile parallel decode when workers + COOP/COEP are available; otherwise one WASM call.
 */
export async function decodeTiledViewport(
  source: Extract<LevelSource, { kind: "tiled" }>,
  region: ImageRegion,
  options?: DecodeOptions,
): Promise<DecodedLevel> {
  const signal = options?.signal;
  if (signal?.aborted) throw new PyramidError('ABORTED', 'decode aborted before start');
  if (!Number.isFinite(region.x) || !Number.isFinite(region.y) || !Number.isFinite(region.w) || !Number.isFinite(region.h)) {
    throw new RangeError("region must have finite x,y,w,h");
  }
  const plan = prepareDecodePlan(source, region);
  const decodeRegion = options?.decodeRegion ?? plan.decodeRegion;
  const vp = plan.viewport;
  const bpp = plan.bpp;
  const need = vp.w * vp.h * bpp;

  // Cache + outBuffer + onTile for direct (non-pooled) path.
  const cache = options?.cache;
  if (cache) {
    const key = `${getLevelId(source)}-${vp.x}-${vp.y}-${vp.w}-${vp.h}-${plan.format}-preview`;
    const cached = cache.get(key);
    if (cached) {
      if (options?.outBuffer) {
        const ob = options.outBuffer;
        if (ob.length < need) throw new RangeError(`outBuffer too small (${ob.length} < ${need})`);
        ob.set(cached);
        return { pixels: ob, width: vp.w, height: vp.h };
      }
      return { pixels: cached, width: vp.w, height: vp.h };
    }
  }

  let target: Uint8Array;
  if (options?.outBuffer) {
    if (options.outBuffer.length < need) throw new RangeError(`outBuffer too small (${options.outBuffer.length} < ${need})`);
    target = options.outBuffer;
  } else {
    target = new Uint8Array(need);
  }
  const onTile = options?.onTile;

  // Non-pooled: direct (libjxl ROI handles tiles internally). Signal checked at entry; in-flight best-effort (WASM not cancellable mid-call).
  // For fanout coroutine pattern see pooled path (decodeTilesParallel).
  const p = decodeRegion(source.bytes, vp);
  let direct: DecodedLevel;
  if (signal) {
    if (signal.aborted) throw new PyramidError('ABORTED', 'decode aborted before start');
    const ac = new AbortController();
    signal.addEventListener('abort', () => ac.abort(), { once: true });
    direct = await Promise.race([
      p,
      new Promise<DecodedLevel>((_, rej) => {
        ac.signal.addEventListener('abort', () => rej(new PyramidError('ABORTED', 'decode aborted')), { once: true });
      })
    ]);
  } else {
    direct = await p;
  }

  target.set(direct.pixels);
  const result: DecodedLevel = { pixels: target, width: vp.w, height: vp.h };
  if (cache) {
    const key = `${getLevelId(source)}-${vp.x}-${vp.y}-${vp.w}-${vp.h}-${plan.format}-preview`;
    cache.set(key, new Uint8Array(target));
  }
  onTile?.(vp, 1);
  return result;
}

/** Decode a pyramid level: whole-frame in one shot, or a viewport slice from JXTC. */
export async function decodeLevel(
  source: LevelSource,
  region?: ImageRegion,
  options?: DecodeOptions,
): Promise<DecodedLevel> {
  const signal = options?.signal;
  if (signal?.aborted) throw new PyramidError('ABORTED', 'decode aborted before start');
  // Hoist bitsPerSample read once (Grok4).
  const bits = source.bitsPerSample;
  if (source.kind === "whole") {
    if (region !== undefined) {
      throw new Error("region decode requires a tiled level source");
    }
    return decodeWhole(source.bytes, bits);
  }
  if (region === undefined) {
    throw new Error("tiled level decode requires explicit region (use decodeLevel(source, region) or full viewport region)");
  }
  if (!Number.isFinite(region.x) || !Number.isFinite(region.y) || !Number.isFinite(region.w) || !Number.isFinite(region.h)) {
    throw new RangeError("region must have finite x,y,w,h");
  }
  return decodeTiledViewport(source, region, options);
}

async function decodeWhole(bytes: Uint8Array, bits: 8 | 16): Promise<DecodedLevel> {
  const format = bits === 16 ? "rgba16" : "rgba8";
  const decoder = createDecoder({ ...WHOLE_DECODE_OPTS, format } as any);
  // Capture drain at IIFE start (Grok1). Use .catch to consume to avoid unhandled rejection escape on error path.
  let drainError: unknown = null;
  const drainPromise = (async () => {
    for await (const ev of decoder.events()) {
      if (ev.type === "final") {
        const px = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
        return { pixels: px, width: ev.info.width, height: ev.info.height };
      } else if (ev.type === "error") {
        const err = new Error(`decode ${ev.code}: ${ev.message}`);
        drainError = err;
        throw err;
      }
    }
    throw new Error("whole-frame decode produced no final frame");
  })().catch((e) => {
    drainError = e;
    throw e;
  });
  try {
    await decoder.push(bytes);
    await decoder.close();
    const res = await drainPromise;
    if (drainError) throw drainError;
    return res;
  } finally {
    await Promise.resolve(decoder.dispose()).catch(() => {});
  }
}
