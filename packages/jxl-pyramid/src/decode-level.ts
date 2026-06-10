import { createDecoder } from "@casabio/jxl-wasm";
import type { ImageRegion } from "./tiling.js";
import { extractTileBitstream } from "./tiling.js";
import type { LevelSource } from "./level-source.js";
import {
  WHOLE_DECODE_OPTS,
  stitch,
  type RegionDecoder,
  type DecodedLevel,
  PyramidError,
  type DecodeOptions,
} from "./decode-core.js";
import { prepareDecodePlan } from "./plan.js";
import { getLevelId } from "./cache.js";

export type { DecodedLevel, RegionDecoder, DecodeOptions, PyramidError, ProgressiveMode } from "./decode-core.js";

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
        if (ob.byteLength < need) throw new PyramidError('INVALID_BUFFER_SIZE', `outBuffer too small (${ob.byteLength} < ${need})`);
        ob.set(cached);
        return { pixels: ob, width: vp.w, height: vp.h };
      }
      return { pixels: cached, width: vp.w, height: vp.h };
    }
  }

  let target: Uint8Array;
  if (options?.outBuffer) {
    if (options.outBuffer.byteLength < need) throw new PyramidError('INVALID_BUFFER_SIZE', `outBuffer too small (${options.outBuffer.byteLength} < ${need})`);
    target = options.outBuffer;
  } else {
    target = new Uint8Array(need);
  }
  const onTile = options?.onTile;
  const progressive = options?.progressive;

  // Progressive DC-then-final (F1): bypass one-shot ROI for per-tile two-pass using extract + createDecoder.
  // Delivers onTile twice per sub-tile (DC first, then final) at same level/region. Stream-stitch friendly.
  // Only when no custom decodeRegion (tests use mocks for the one-shot path).
  if (progressive === 'dc-then-final' && !options?.decodeRegion) {
    let completed = 0;
    for (const t of plan.tiles) {
      if (signal?.aborted) throw new PyramidError('ABORTED', 'decode aborted');
      const tileBytes = extractTileBitstream(source.bytes, t, plan.header as any);
      // DC stage (first paint)
      const dcPixels = await decodeTileBytesProgressive(tileBytes, plan.format, 'dc');
      const dcLevel: DecodedLevel = { pixels: dcPixels, width: t.w, height: t.h };
      stitch(target, vp, t, dcLevel, plan.bpp);
      completed += 1;
      onTile?.(t, completed);
      // Final stage (refine)
      const finalPixels = await decodeTileBytesProgressive(tileBytes, plan.format, 'final');
      const finLevel: DecodedLevel = { pixels: finalPixels, width: t.w, height: t.h };
      stitch(target, vp, t, finLevel, plan.bpp);
      completed += 1;
      onTile?.(t, completed);
    }
    const result: DecodedLevel = { pixels: target, width: vp.w, height: vp.h };
    if (cache) {
      const key = `${getLevelId(source)}-${vp.x}-${vp.y}-${vp.w}-${vp.h}-${plan.format}-preview`;
      cache.set(key, new Uint8Array(target));
    }
    return result;
  }

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

/** Small helper: drive createDecoder on a standalone tile bitstream (from JXTC extract) for one stage. */
async function decodeTileBytesProgressive(
  tileBytes: Uint8Array,
  format: 'rgba8' | 'rgba16',
  stage: 'dc' | 'final',
): Promise<Uint8Array> {
  const decoder = createDecoder({
    format: format === 'rgba16' ? 'rgba16' : 'rgba8',
    progressionTarget: stage === 'dc' ? 'dc' : 'final',
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
  } as any);
  let drainErr: unknown = null;
  const drain = (async () => {
    for await (const ev of decoder.events()) {
      if (ev.type === 'final' || ev.type === 'progress' || (ev as any).type === 'preview') {
        const p = (ev as any).pixels;
        if (p) {
          const px = p instanceof Uint8Array ? p : new Uint8Array(p);
          // For dc target we accept first progress with pixels; for final the final event.
          if (stage === 'final' && ev.type === 'final') return px;
          if (stage === 'dc') return px;
        }
      }
      if (ev.type === 'error') {
        drainErr = new Error(`tile progressive ${stage}: ${ev.message}`);
        throw drainErr;
      }
    }
    throw new Error(`tile progressive ${stage} produced no pixels`);
  })().catch((e) => { drainErr = e; throw e; });
  try {
    await decoder.push(tileBytes);
    await decoder.close();
    const px = await drain;
    if (drainErr) throw drainErr;
    return px;
  } finally {
    await Promise.resolve(decoder.dispose()).catch(() => {});
  }
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
