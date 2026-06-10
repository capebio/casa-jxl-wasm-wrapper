import { createDecoder } from "@casabio/jxl-wasm";
import type { ImageRegion, JxtcHeader as TilingJxtcHeader } from "./tiling.js";
import { extractTileBitstream } from "./tiling.js";
import type { LevelSource } from "./level-source.js";
import {
  WHOLE_DECODE_OPTS,
  stitch,
  type RegionDecoder,
  type DecodedLevel,
  PyramidError,
  type DecodeOptions,
  stitchCropped,
  assertFiniteRegion,
  snapRegionToIntegers,
  type DecoderInit,
  type PixelFormat,
  formatFromBits,
  bppOfFormat,
  viewportCacheKey,
  tileIdOf,
  tileKey,
  tileKeyPacked,
  type TileProgress,
  validateDecodedOutput,
  type TileId,
  raceWithAbort,
} from "./decode-core.js";
import { prepareDecodePlan } from "./plan.js";
import { getLevelId } from "./cache.js";

export type { DecodedLevel, RegionDecoder, DecodeOptions, ProgressiveMode, WorkerLike, DecoderInit, PixelFormat, TileProgress } from "./decode-core.js";
export { PyramidError, formatFromBits, bppOfFormat, viewportCacheKey, tileIdOf, tileKey, tileKeyPacked } from "./decode-core.js";

const buffersInFlight = new WeakSet<Uint8Array>();

function stitchTileIntoViewport(
  outBuffer: Uint8Array,
  viewport: ImageRegion,
  tile: ImageRegion,
  decodedPixels: Uint8Array,
  source: Extract<LevelSource, { kind: "tiled" }>,
  bpp: 4 | 8,
): void {
  const tileSize = source.tileSize;
  const tx = Math.floor(tile.x / tileSize);
  const ty = Math.floor(tile.y / tileSize);
  const srcOriginX = tx * tileSize;
  const srcOriginY = ty * tileSize;
  const decodedW = Math.min(tileSize, source.width - srcOriginX);
  const decodedH = Math.min(tileSize, source.height - srcOriginY);

  stitchCropped(
    outBuffer,
    viewport,
    tile,
    decodedPixels,
    decodedW,
    decodedH,
    srcOriginX,
    srcOriginY,
    bpp,
  );
}

/** Zero a rectangular sub-region inside the viewport outBuffer (used for skip-tile error policy). */
function zeroFillRect(
  outBuffer: Uint8Array,
  viewport: ImageRegion,
  rect: ImageRegion,
  bpp: 4 | 8,
): void {
  const dx = rect.x - viewport.x;
  const dy = rect.y - viewport.y;
  if (dx < 0 || dy < 0 || dx + rect.w > viewport.w || dy + rect.h > viewport.h) return; // defensive
  const stride = viewport.w * bpp;
  const rowBytes = rect.w * bpp;
  let off = (dy * viewport.w + dx) * bpp;
  for (let r = 0; r < rect.h; r++) {
    outBuffer.fill(0, off, off + rowBytes);
    off += stride;
  }
}

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
  // L18-2: hand-built tiled sources (bypassing createLevelSource/parseJxtcHeader) must still be sane.
  if (!Number.isInteger(source.tileSize) || source.tileSize <= 0 ||
      !Number.isInteger(source.width) || source.width <= 0 ||
      !Number.isInteger(source.height) || source.height <= 0) {
    throw new PyramidError('BAD_MANIFEST', 'tiled source tileSize/width/height must be positive integers');
  }
  assertFiniteRegion(region);
  const snappedRegion = snapRegionToIntegers(region);
  let plan: ReturnType<typeof prepareDecodePlan>;
  try {
    plan = prepareDecodePlan(source, snappedRegion);
  } catch (e) {
    if (e instanceof PyramidError) throw e;
    throw new PyramidError('BAD_REGION', 'degenerate region after prepare', e);
  }
  const decodeRegion = options?.decodeRegion ?? plan.decodeRegion;
  const vp = plan.viewport;
  const bpp = plan.bpp;
  const need = vp.w * vp.h * bpp;

  // Cache + outBuffer + onTile for direct (non-pooled) path.
  const cache = options?.cache;
  const outBuf = options?.outBuffer;
  const zeroCopyHits = !!options?.zeroCopyCacheHits;

  if (outBuf) {
    if (outBuf.byteLength < need) throw new PyramidError('INVALID_BUFFER_SIZE', `outBuffer too small (${outBuf.byteLength} < ${need})`);
    if (buffersInFlight.has(outBuf)) throw new PyramidError('BUFFER_IN_USE', 'outBuffer is already in use by another decode');
    // L5-2: 16-bit (bpp=8) requires even offset for safe Uint16Array(underlying, byteOffset) views downstream.
    if (plan.bpp === 8 && (outBuf.byteOffset % 2) !== 0) {
      throw new PyramidError('INVALID_BUFFER_ALIGNMENT', 'outBuffer.byteOffset must be even for 16-bit (bpp=8) pixels');
    }
    buffersInFlight.add(outBuf);
  }

  try {
    const cacheKeyFinal = cache ? viewportCacheKey(getLevelId(source), vp, plan.format, 'final') : undefined;
    if (cache && cacheKeyFinal) {
      const cached = cache.get(cacheKeyFinal);
      if (cached) {
        if (outBuf) {
          outBuf.set(cached);
          const pixels = outBuf.byteLength === need ? outBuf : outBuf.subarray(0, need);
          return { pixels, width: vp.w, height: vp.h, format: plan.format };
        }
        const pixels = zeroCopyHits ? cached : new Uint8Array(cached);
        return { pixels, width: vp.w, height: vp.h, format: plan.format };
      }
    }

    const onTile = options?.onTile;
    const progressive = options?.progressive;

    // L20-1/L20-2/L4-4: policy, budget, resume support (scoped to progressive per-tile direct path).
    const errorPolicy = options?.errorPolicy ?? 'fail-fast';
    const budgetMs = options?.budgetMs;
    const skipTiles = options?.skipTiles;
    const startMs = budgetMs != null ? performance.now() : 0;
    const deadline = budgetMs != null ? startMs + budgetMs : null;
    let failedTiles: TileId[] = [];

    let target: Uint8Array | undefined;
    // Progressive DC-then-final (F1 + L3-1): Phase 1 all DC, Phase 2 all final.
    // Delivers onTile twice per tile (DC first for full coarse paint, then final). Stream-stitch friendly.
    // Only when no custom decodeRegion (tests use mocks for the one-shot path).
    if (progressive === 'dc-then-final' && !options?.decodeRegion) {
      target = outBuf ? outBuf : new Uint8Array(need);
    let completed = 0;
    const tilesX = Math.ceil(source.width / source.tileSize);
    const tilesY = Math.ceil(source.height / source.tileSize);
    const exHeader: TilingJxtcHeader = {
      imageW: source.width,
      imageH: source.height,
      tileSize: source.tileSize,
      tilesX,
      tilesY,
      hasAlpha: true,
      bitsPerSample: source.bitsPerSample,
    };
    const n = plan.tiles.length;
    const total = n * 2;
    // Pre-extract for efficiency (L3-1).
    const tileBytesList: Uint8Array[] = plan.tiles.map((t) => extractTileBitstream(source.bytes, t, exHeader));
    // Phase 1: all DC (coarse first paint for entire viewport)
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) throw new PyramidError('ABORTED', 'decode aborted');
      if (deadline != null && performance.now() > deadline) {
        if (errorPolicy === 'skip-tile') { break; }
        throw new PyramidError('TIMEOUT', 'budgetMs deadline exceeded during progressive decode');
      }
      const t = plan.tiles[i]!;
      const id = tileIdOf(t, source.tileSize, 0);
      const key = tileKey(id);
      if (skipTiles?.has(key)) {
        completed += 1;
        const prog: TileProgress = { id, key, stage: 'dc', completed, total };
        onTile?.(t, completed, prog);
        continue;
      }
      try {
        const dcPixels = await decodeTileBytesProgressive(tileBytesList[i]!, plan.format, 'dc');
        stitchTileIntoViewport(target!, vp, t, dcPixels, source, plan.bpp);
        completed += 1;
        const prog: TileProgress = { id, key, stage: 'dc', completed, total };
        onTile?.(t, completed, prog);
      } catch (e) {
        if (errorPolicy === 'skip-tile') {
          zeroFillRect(target!, vp, t, plan.bpp);
          failedTiles.push(id);
          completed += 1;
          const prog: TileProgress = { id, key, stage: 'dc', completed, total };
          onTile?.(t, completed, prog);
          continue;
        }
        throw e;
      }
    }
    // Phase 2: all final (refine)
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) throw new PyramidError('ABORTED', 'decode aborted');
      if (deadline != null && performance.now() > deadline) {
        if (errorPolicy === 'skip-tile') { break; }
        throw new PyramidError('TIMEOUT', 'budgetMs deadline exceeded during progressive decode');
      }
      const t = plan.tiles[i]!;
      const id = tileIdOf(t, source.tileSize, 0);
      const key = tileKey(id);
      if (skipTiles?.has(key)) {
        completed += 1;
        const prog: TileProgress = { id, key, stage: 'final', completed, total };
        onTile?.(t, completed, prog);
        continue;
      }
      try {
        const finalPixels = await decodeTileBytesProgressive(tileBytesList[i]!, plan.format, 'final');
        stitchTileIntoViewport(target!, vp, t, finalPixels, source, plan.bpp);
        completed += 1;
        const prog: TileProgress = { id, key, stage: 'final', completed, total };
        onTile?.(t, completed, prog);
      } catch (e) {
        if (errorPolicy === 'skip-tile') {
          zeroFillRect(target!, vp, t, plan.bpp);
          failedTiles.push(id);
          completed += 1;
          const prog: TileProgress = { id, key, stage: 'final', completed, total };
          onTile?.(t, completed, prog);
          continue;
        }
        throw e;
      }
    }
    const pixels = target!.byteLength === need ? target! : target!.subarray(0, need);
    const result: DecodedLevel = { pixels, width: vp.w, height: vp.h, format: plan.format };
    if (failedTiles.length > 0) {
      // dedup by key (a tile may error in both phases)
      const seen = new Set<string>();
      const uniq: TileId[] = [];
      for (const id of failedTiles) {
        const k = tileKey(id);
        if (!seen.has(k)) { seen.add(k); uniq.push(id); }
      }
      result.failedTiles = uniq;
    }
    if (cache && cacheKeyFinal && failedTiles.length === 0) {
      const cap = (cache as any).capacityBytes as number | undefined;
      if (cap === undefined || need <= cap) {
        cache.set(cacheKeyFinal, target!.slice(0, need));
      }
    }
    return result;
  }

  // Non-pooled direct (libjxl ROI handles tiles internally). L3-3 zero-copy when no outBuffer.
  // Signal checked at entry; in-flight best-effort (WASM not cancellable mid-call).
  // For fanout coroutine pattern see pooled path (decodeTilesParallel).
  const p = decodeRegion(source.bytes, vp);
  const direct: DecodedLevel = signal
    ? await raceWithAbort(p, signal)
    : await p;

  // L10-R4: reverse trust — decoder must have returned exactly the requested viewport region.
  validateDecodedOutput(direct, vp, bpp);
  let pixels: Uint8Array;
  if (outBuf) {
    outBuf.set(direct.pixels);
    pixels = outBuf.byteLength === need ? outBuf : outBuf.subarray(0, need);
  } else {
    pixels = direct.pixels; // zero-copy handoff (L3-3)
  }
  const result: DecodedLevel = { pixels, width: vp.w, height: vp.h, format: plan.format };
  if (cache && cacheKeyFinal) {
    const cap = (cache as any).capacityBytes as number | undefined;
    if (cap === undefined || need <= cap) {
      cache.set(cacheKeyFinal, new Uint8Array(pixels.subarray(0, need)));
    }
  }
  const dirId = tileIdOf(vp, source.tileSize, 0);
  const dirKey = tileKey(dirId);
  const dirProg: TileProgress = { id: dirId, key: dirKey, stage: 'final', completed: 1, total: 1 };
  onTile?.(vp, 1, dirProg);
  return result;
} finally {
  if (outBuf) buffersInFlight.delete(outBuf);
}
}

/** Small helper: drive createDecoder on a standalone tile bitstream (from JXTC extract) for one stage. */
async function decodeTileBytesProgressive(
  tileBytes: Uint8Array,
  format: PixelFormat,
  stage: 'dc' | 'final',
): Promise<Uint8Array> {
  const decoder = createDecoder({
    format,
    progressionTarget: stage === 'dc' ? 'dc' : 'final',
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
  } as DecoderInit);
  const drainOutcome = (async (): Promise<{ ok: true; px: Uint8Array } | { ok: false; err: unknown }> => {
    for await (const ev of decoder.events()) {
      if (ev.type === 'final' || ev.type === 'progress' || (ev as any).type === 'preview') {
        const p = (ev as any).pixels;
        if (p) {
          const px = p instanceof Uint8Array ? p : new Uint8Array(p);
          // For dc target we accept first progress with pixels; for final the final event.
          if (stage === 'final' && ev.type === 'final') return { ok: true, px };
          if (stage === 'dc') return { ok: true, px };
        }
      }
      if (ev.type === 'error') {
        return { ok: false, err: new PyramidError('JXTC_PARSE', `tile progressive ${stage}: ${ev.message}`) };
      }
    }
    return { ok: false, err: new PyramidError('INTERNAL', `tile progressive ${stage} produced no pixels`) };
  })();
  try {
    await decoder.push(tileBytes);
    await decoder.close();
    const out = await drainOutcome;
    if (!out.ok) throw out.err;
    return out.px;
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
  if (source.kind === "whole") {
    if (region !== undefined) {
      throw new PyramidError('BAD_REGION', 'region decode requires a tiled level source');
    }
    return decodeWhole(source.bytes, source.format, options, source);
  }
  if (region === undefined) {
    throw new PyramidError('BAD_REGION', 'tiled level decode requires explicit region (use decodeLevel(source, region) or full viewport region)');
  }
  return decodeTiledViewport(source, region, options);
}

async function decodeWhole(
  bytes: Uint8Array,
  format: PixelFormat,
  options?: DecodeOptions,
  nominalSource?: LevelSource & { width: number; height: number },
): Promise<DecodedLevel> {
  const signal = options?.signal;
  if (signal?.aborted) throw new PyramidError('ABORTED', 'decode aborted before start');

  const cache = options?.cache;
  const outBuf = options?.outBuffer;
  const bpp = bppOfFormat(format);

  // For whole we use nominal dims (from LevelSource) for cache key / outBuffer sizing / validation when available.
  const nomW = (nominalSource as any)?.width as number | undefined;
  const nomH = (nominalSource as any)?.height as number | undefined;
  const haveNominal = Number.isFinite(nomW) && Number.isFinite(nomH) && (nomW as number) > 0 && (nomH as number) > 0;

  if (outBuf && haveNominal) {
    const need = (nomW as number) * (nomH as number) * bpp;
    if (outBuf.byteLength < need) throw new PyramidError('INVALID_BUFFER_SIZE', `outBuffer too small (${outBuf.byteLength} < ${need})`);
  }

  // L2-4: cache hit for whole (keyed by bytes id + nominal dims + format when known).
  if (cache && haveNominal) {
    const key = `${getLevelId(bytes)}-${nomW}x${nomH}-${format}-whole`;
    const cached = cache.get(key);
    if (cached) {
      if (outBuf) {
        const need = (nomW as number) * (nomH as number) * bpp;
        outBuf.set(cached.length >= need ? cached.subarray(0, need) : cached);
        return { pixels: outBuf, width: nomW as number, height: nomH as number, format };
      }
      const pixels = cached;
      return { pixels, width: nomW as number, height: nomH as number, format };
    }
  }

  const decoder = createDecoder({ ...WHOLE_DECODE_OPTS, format } as DecoderInit);
  const drainOutcome = (async (): Promise<
    { ok: true; res: DecodedLevel } | { ok: false; err: unknown }
  > => {
    for await (const ev of decoder.events()) {
      if (ev.type === "final") {
        const px = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
        return { ok: true, res: { pixels: px, width: ev.info.width, height: ev.info.height, format } };
      } else if (ev.type === "error") {
        return { ok: false, err: new PyramidError('JXTC_PARSE', `decode ${ev.code}: ${ev.message}`) };
      }
    }
    return { ok: false, err: new PyramidError('INTERNAL', 'whole-frame decode produced no final frame') };
  })();
  try {
    await decoder.push(bytes);
    await decoder.close();
    const out = await drainOutcome;
    if (!out.ok) throw out.err;
    let res = out.res;

    // L10-R4: validate decoder output against nominal (if known) or self-reported size.
    if (haveNominal) {
      validateDecodedOutput(res, { x: 0, y: 0, w: nomW as number, h: nomH as number }, bpp);
    } else {
      const expectedBytes = res.width * res.height * bpp;
      if (res.pixels.byteLength !== expectedBytes) {
        throw new PyramidError('DECODER_OUTPUT_MISMATCH', `whole decoded bytes ${res.pixels.byteLength} != ${expectedBytes}`);
      }
    }

    // L2-4: outBuffer support (post-decode size using actual res; prefer nominal for pre-check above).
    if (outBuf) {
      const need = res.width * res.height * bpp;
      if (outBuf.byteLength < need) throw new PyramidError('INVALID_BUFFER_SIZE', `outBuffer too small (${outBuf.byteLength} < ${need})`);
      outBuf.set(res.pixels);
      res = { pixels: outBuf, width: res.width, height: res.height, format };
    }

    // L2-4: cache set (use nominal dims for key when available; clone like tiled path).
    if (cache) {
      const w = haveNominal ? (nomW as number) : res.width;
      const h = haveNominal ? (nomH as number) : res.height;
      const key = `${getLevelId(bytes)}-${w}x${h}-${format}-whole`;
      const cap = (cache as any).capacityBytes as number | undefined;
      const sz = w * h * bpp;
      if (cap === undefined || sz <= cap) {
        cache.set(key, res.pixels.byteLength >= sz ? res.pixels.slice(0, sz) : res.pixels.slice());
      }
    }

    return res;
  } finally {
    await Promise.resolve(decoder.dispose()).catch(() => {});
  }
}
