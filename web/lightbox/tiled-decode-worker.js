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

import { decodeTileContainerRegionRgba8, decodeTileContainerRegionRgba16, preloadJxlModule } from '../../packages/jxl-wasm/dist/index.js';

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
    const { id, bytesId, region, format, deadlineMs } = msg;

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
      const fn = (format === 'rgba16') ? decodeTileContainerRegionRgba16 : decodeTileContainerRegionRgba8;
      const out = await fn(bytes, { x: region.x, y: region.y, w: region.w, h: region.h });

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
