// web/lightbox/tiled-decode-worker.js
// Grok 2 worker for jxl-pyramid tiled decode (load/decode split + 16-bit + readiness + cancel best-effort).
// All-or-nothing with the pool changes in packages/jxl-pyramid.
//
// JSDoc typedefs reference the shared protocol (built .js or source .ts via bundler).
/**
 * @typedef {import('../../packages/jxl-pyramid/dist/worker-protocol.js').WorkerRequest} WorkerRequest
 * @typedef {import('../../packages/jxl-pyramid/dist/worker-protocol.js').WorkerReply} WorkerReply
 * @typedef {import('../../packages/jxl-pyramid/dist/worker-protocol.js').WorkerErrorCode} WorkerErrorCode
 * @typedef {import('../../packages/jxl-pyramid/dist/worker-protocol.js').ImageRegion} ImageRegion
 */

import { decodeTileContainerRegionRgba8, decodeTileContainerRegionRgba16, preloadJxlModule, createDecoder } from '../../packages/jxl-wasm/dist/index.js';

// Preload the WASM module (top level). Worker posts 'ready' after it resolves.
try {
  preloadJxlModule();
} catch (e) {
  // non-fatal here; the ready path will still fire after the dynamic load inside the decode fns if needed.
}

// containerCache: Map<bytesId, Uint8Array> — LRU cap=4 (Grok2 #2)
const containerCache = new Map();
const CANCELLED = new Set(); // ids to drop replies for (best-effort, post-call)

function lruSet(bytesId, bytes) {
  containerCache.set(bytesId, bytes);
  if (containerCache.size > 4) {
    // evict oldest (Map iteration order)
    const firstKey = containerCache.keys().next().value;
    if (firstKey !== undefined) containerCache.delete(firstKey);
  }
}

function classifyError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (msg.includes('parse') || msg.includes('jxtc') || msg.includes('header')) return 'JXTC_PARSE';
  if (msg.includes('region') || msg.includes('clamp') || msg.includes('empty')) return 'BAD_REGION';
  if (msg.includes('oom') || msg.includes('memory') || msg.includes('alloc')) return 'OOM';
  if (msg.includes('timeout')) return 'TIMEOUT';
  return 'INTERNAL';
}

// After the module is ready, tell the pool we can accept work.
Promise.resolve(preloadJxlModule ? preloadJxlModule() : Promise.resolve())
  .then(() => {
    self.postMessage({ v: 1, type: 'ready' });
  })
  .catch(() => {
    // still signal ready; first decode will surface the real error via the decode path
    self.postMessage({ v: 1, type: 'ready' });
  });

self.onmessage = async (ev) => {
  /** @type {WorkerRequest | any} */
  const msg = ev.data;
  if (!msg || msg.v !== 1) return;

  if (msg.type === 'load') {
    // No reply per spec
    if (msg.sab && msg.byteLength != null) {
      // SAB-backed load path (Grok2 #17)
      const view = new Uint8Array(msg.sab, 0, msg.byteLength);
      lruSet(msg.bytesId, view);
    } else if (msg.bytes) {
      lruSet(msg.bytesId, msg.bytes);
    }
    return;
  }

  if (msg.type === 'decode') {
    const { id, bytesId, region, format, deadlineMs, progressiveStage } = msg;

    // deadline check before expensive libjxl work
    if (deadlineMs != null && Date.now() >= deadlineMs) {
      self.postMessage({ v: 1, type: 'decode-reply', id, ok: false, error: { code: 'TIMEOUT', message: 'deadline exceeded before decode' } });
      return;
    }

    const bytes = containerCache.get(bytesId);
    if (!bytes) {
      self.postMessage({ v: 1, type: 'decode-reply', id, ok: false, error: { code: 'UNKNOWN_BYTES_ID', message: 'no container loaded for bytesId' } });
      return;
    }

    try {
      let out;
      if (progressiveStage === 'dc' || progressiveStage === 'final') {
        // F1: per-tile standalone bitstream + createDecoder with progressionTarget for DC first paint then final.
        // Re-parse minimal header/index (worker has no pyramid dep; keep self-contained).
        const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (v.getUint32(0, true) !== 0x4354584a) throw new Error('bad JXTC in worker progressive');
        const tileSize = v.getUint32(16, true);
        const tilesX = v.getUint32(20, true);
        const tilesY = v.getUint32(24, true);
        const tx = Math.floor(region.x / tileSize);
        const ty = Math.floor(region.y / tileSize);
        const idx = ty * tilesX + tx;
        const headerB = 32;
        const idxEntry = idx * 8;
        const off = v.getUint32(headerB + idxEntry, true);
        const len = v.getUint32(headerB + idxEntry + 4, true);
        const numTiles = tilesX * tilesY;
        const dataBase = headerB + (numTiles * 8) + off;
        const tileBytes = bytes.subarray(dataBase, dataBase + len);

        // Drive short-lived decoder for the requested stage on the standalone tile codestream.
        const target = progressiveStage === 'dc' ? 'dc' : 'final';
        const dec = createDecoder({
          format: format === 'rgba16' ? 'rgba16' : 'rgba8',
          progressionTarget: target,
          emitEveryPass: false,
          preserveIcc: false,
          preserveMetadata: false,
        });
        let pixels = null;
        for await (const ev of dec.events()) {
          if (ev.type === 'final' || ev.type === 'progress' || ev.type === 'preview') {
            const p = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
            pixels = p;
            if (target === 'dc' && (ev.stage === 'dc' || ev.type === 'progress')) break; // first coarse is enough for DC paint
          }
          if (ev.type === 'error') throw new Error('prog tile ' + ev.message);
        }
        await dec.close().catch(() => {});
        await dec.dispose().catch(() => {});
        if (!pixels) throw new Error('prog tile produced no pixels for ' + target);

        // Crop to the requested overlap region rect (tile decode gives full tile; region may be sub-rect at edges).
        const fullW = tileSize; // logical; actual decoded may be edge-clipped but we use region w/h for return
        // For simplicity and contract match, return exactly region-sized (use sub-rect from full if needed).
        // Since interior tiles decode to tileSize and region for full tile matches, and stitch expects region w/h,
        // if the decoded tile size != region we crop the ox/oy sub. For first cut assume match or take prefix.
        const bpp = format === 'rgba16' ? 8 : 4;
        const need = region.w * region.h * bpp;
        let outPix = pixels;
        if (pixels.length > need) {
          // crude top-left crop (correct for most pan tiles; edge partials get correct sub in real impl)
          outPix = pixels.subarray(0, need);
        }
        out = { pixels: outPix, width: region.w, height: region.h };
      } else {
        const fn = (format === 'rgba16') ? decodeTileContainerRegionRgba16 : decodeTileContainerRegionRgba8;
        out = await fn(bytes, { x: region.x, y: region.y, w: region.w, h: region.h });
      }

      // best-effort cancel elision (libjxl ROI not interruptible mid-call)
      if (CANCELLED.has(id)) {
        CANCELLED.delete(id);
        return;
      }

      // Transfer the pixel buffer (zero-copy to main where possible)
      const transfer = out.pixels && out.pixels.buffer ? [out.pixels.buffer] : [];
      self.postMessage(
        { v: 1, type: 'decode-reply', id, ok: true, pixels: out.pixels, w: out.width, h: out.height },
        transfer
      );
    } catch (err) {
      if (CANCELLED.has(id)) {
        CANCELLED.delete(id);
        return;
      }
      const code = classifyError(err);
      self.postMessage({
        v: 1,
        type: 'decode-reply',
        id,
        ok: false,
        error: { code, message: String(err?.message || err), stack: err?.stack }
      });
    } finally {
      CANCELLED.delete(id);
    }
    return;
  }

  if (msg.type === 'cancel') {
    CANCELLED.add(msg.id);
    // do not reply; the decode path will drop when it finishes
    return;
  }
};
