// web/lightbox/tiled-decode-worker.js
// Tiled-decode worker for the jxl-pyramid pool. Speaks the versioned v:1 protocol
// (see packages/jxl-pyramid/src/worker-protocol.ts).
//
// Protocol:
//   ← {v:1,type:'ready'}                                       (posted on startup)
//   → {v:1,type:'load',bytesId,bytes}                          store bytes, no reply
//   → {v:1,type:'load',bytesId,sab,byteLength}                 store bytes from SAB, no reply
//   → {v:1,type:'decode',id,bytesId,region:{x,y,w,h},format}   decode a region
//   ← {v:1,type:'decode-reply',id,ok:true,pixels,w,h}          transfer [pixels.buffer]
//   ← {v:1,type:'decode-reply',id,ok:false,error:{code,message,stack}}
//   → {v:1,type:'cancel',id}                                   best-effort no-op
//
// Bytes are stored once per bytesId and reused across many decode requests.

import { decodeTileContainerRegionRgba8, decodeTileContainerRegionRgba16, preloadJxlModule } from '../../packages/jxl-wasm/dist/index.js';

try { preloadJxlModule(); } catch { /* optional warm-up */ }

/** @type {Map<number, Uint8Array>} */
const byteStore = new Map();

self.postMessage({ v: 1, type: 'ready' });

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (!msg || msg.v !== 1) return;

  if (msg.type === 'load') {
    if (msg.sab !== undefined) {
      // Copy out of the SharedArrayBuffer so later writes to the SAB cannot mutate our view.
      byteStore.set(msg.bytesId, new Uint8Array(msg.sab, 0, msg.byteLength).slice());
    } else {
      byteStore.set(msg.bytesId, msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes));
    }
    return; // no reply for load
  }

  if (msg.type === 'cancel') {
    // decoder.push() is synchronous; cancellation between requests is implicit. No-op.
    return;
  }

  if (msg.type === 'decode') {
    const { id, bytesId, region, format } = msg;
    const bytes = byteStore.get(bytesId);
    if (!bytes) {
      self.postMessage({
        v: 1, type: 'decode-reply', id, ok: false,
        error: { code: 'UNKNOWN_BYTES_ID', message: `no bytes for bytesId ${bytesId}` },
      });
      return;
    }
    try {
      const fn = format === 'rgba16' ? decodeTileContainerRegionRgba16 : decodeTileContainerRegionRgba8;
      const out = await fn(bytes, { x: region.x, y: region.y, w: region.w, h: region.h });
      self.postMessage(
        { v: 1, type: 'decode-reply', id, ok: true, pixels: out.pixels, w: out.width, h: out.height },
        [out.pixels.buffer],
      );
    } catch (err) {
      self.postMessage({
        v: 1, type: 'decode-reply', id, ok: false,
        error: {
          code: classifyError(err),
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
      });
    }
    return;
  }
};

function classifyError(err) {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (m.includes('region') || m.includes('bounds')) return 'BAD_REGION';
  if (m.includes('parse') || m.includes('jxtc') || m.includes('container') || m.includes('magic')) return 'JXTC_PARSE';
  if (m.includes('memory') || m.includes('alloc') || m.includes('oom')) return 'OOM';
  return 'INTERNAL';
}
