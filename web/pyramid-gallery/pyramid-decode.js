/**
 * One-shot pyramid level decode through jxl-session + scheduler.
 * sourceKey = contenthash for dedupe. Skips streaming progressive overhead.
 * format rgba16 returns packed Uint8Array (byteLength = w*h*8) for webgl float + export.
 */

/**
 * @param {import('@casabio/jxl-session').JxlContext} ctx
 * @param {Uint8Array} bytes
 * @param {{ contenthash: string; format?: 'rgba8'|'rgba16'; priority?: 'visible'|'near'|'background'; signal?: AbortSignal; tiled?: boolean; region?: {x:number;y:number;w:number;h:number} }} opts
 */
export async function decodePyramidLevel(ctx, bytes, opts) {
  if (opts.tiled) {
    if (!opts.region) throw new Error('tiled decode requires a viewport region');
    const { decodeTiledViewportPooled } = await import('../../packages/jxl-pyramid/dist/tiled-decode-pool.js');
    return decodeTiledViewportPooled(bytes, opts.region, {
      parallel: true,
      workerFactory: () => new Worker(
        new URL('../lightbox/tiled-decode-worker.js', import.meta.url),
        { type: 'module' },
      ),
    });
  }

  const session = ctx.decode({
    format: opts.format ?? 'rgba8',
    region: opts.region ?? undefined,
    progressionTarget: 'final',
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
    priority: opts.priority ?? 'visible',
    sourceKey: opts.contenthash,
    signal: opts.signal ?? undefined,
  });

  const view = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  await session.push(view);
  await session.close();

  let rgba = null;
  let width = 0;
  let height = 0;
  for await (const ev of session.frames()) {
    if (ev.type === 'final') {
      // Preserve packed bytes for rgba16 (len = w*h*8); Uint8Array container passed through to webgl-pipeline / export.
      rgba = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
      width = ev.info.width;
      height = ev.info.height;
    } else if (ev.type === 'error') {
      throw new Error(`${ev.code}: ${ev.message}`);
    }
  }
  await session.done();
  if (!rgba) throw new Error('decode produced no final frame');
  return { pixels: rgba, width, height };
}

/**
 * ROI export decode via decodeRegionLod (region + optional long-edge fit).
 * Used for high-precision crop export without decoding the full frame.
 *
 * @param {Uint8Array} bytes
 * @param {{ format?: 'rgba8'|'rgba16'; region: {x:number;y:number;w:number;h:number}; targetLongEdge?: number }} opts
 */
export async function decodePyramidRegion(bytes, opts) {
  const { createDecoder } = await import('@casabio/jxl-wasm');
  const format = opts.format ?? 'rgba8';
  const decoder = createDecoder({
    format,
    region: opts.region,
    progressionTarget: 'final',
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
    ...(opts.targetLongEdge
      ? { targetWidth: opts.targetLongEdge, targetHeight: opts.targetLongEdge, fitMode: 'contain' }
      : {}),
  });

  const view = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  let pixels = null;
  let width = 0;
  let height = 0;
  const drain = (async () => {
    for await (const ev of decoder.events()) {
      if (ev.type === 'final') {
        // Preserve packed byte buffer (Uint8Array stride-8 for rgba16); callers (webgl/export) consume via format.
        pixels = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
        width = ev.info.width;
        height = ev.info.height;
      } else if (ev.type === 'error') {
        throw new Error(`${ev.code}: ${ev.message}`);
      }
    }
  })();

  await decoder.push(view);
  await decoder.close();
  await drain;
  await decoder.dispose();
  if (!pixels) throw new Error('region decode produced no final frame');
  return { pixels, width, height };
}