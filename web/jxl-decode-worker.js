// Dedicated JXL decode worker — kept separate from jxl-worker.js (encoder) so
// that a long Emscripten-pthread encode cannot block lightbox decode requests.
import decode from './vendor/jsquash-jxl/decode.js';
import { createDecoder } from '../packages/jxl-wasm/dist/index.js';

// Fire-and-forget preload (same pattern as jxl-worker.js)
import('../packages/jxl-wasm/dist/index.js')
  .then(({ preloadJxlModule }) => preloadJxlModule?.())
  .catch(() => {});

async function handleJxlDecode(data) {
  const { decodeId, url } = data;
  try {
    const resp = await fetch(url);
    const buf = await resp.arrayBuffer();
    const img = await decode(buf);
    self.postMessage(
      { type: 'jxl_decoded', decodeId, rgba: img.data, w: img.width, h: img.height },
      [img.data.buffer],
    );
  } catch (err) {
    self.postMessage({ type: 'decode_error', decodeId, error: String(err?.message ?? err) });
  }
}

async function handleProgressiveDecode(data) {
  const { decodeId, url } = data;
  try {
    const resp = await fetch(url);
    const buf = await resp.arrayBuffer();
    const decoder = createDecoder({
      format: 'rgba8',
      region: data.region ?? null,
      downsample: data.downsample ?? 1,
      progressionTarget: 'final',
      emitEveryPass: true,
      progressiveDetail: data.progressiveDetail ?? 'lastPasses',
      preserveIcc: true,
      preserveMetadata: true,
    });
    await decoder.push(buf);
    await decoder.close();
    let sourceW = 0, sourceH = 0;
    for await (const ev of decoder.events()) {
      if (ev.type === 'header') {
        sourceW = ev.info.width || 0;
        sourceH = ev.info.height || 0;
        // Header gives full source dims even for region decodes (P3.2b)
        self.postMessage({ type: 'jxl_header', decodeId, w: sourceW, h: sourceH });
      } else if (ev.type === 'progress' || ev.type === 'final') {
        const isFinal = ev.type === 'final';
        const info = ev.info;
        let pixelsArray = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
        // Ensure we own the buffer exclusively for structured clone transfer (handles views/subarrays)
        if (pixelsArray.byteOffset !== 0 || pixelsArray.byteLength !== pixelsArray.buffer.byteLength) {
          pixelsArray = new Uint8Array(pixelsArray);
        }
        if (isFinal) {
          // Copy for legacy jxl_decoded BEFORE transferring the primary buffer.
          const legacyPixels = new Uint8Array(pixelsArray);
          const base = { decodeId, w: info.width, h: info.height, sourceW, sourceH };
          const req = (data.region != null || data.downsample != null) ? { region: data.region ?? null, downsample: data.downsample ?? 1 } : {};
          self.postMessage(
            { type: 'jxl_progress', ...base, ...req, rgba: pixelsArray, isFinal },
            [pixelsArray.buffer],
          );
          self.postMessage(
            { type: 'jxl_decoded', ...base, ...req, rgba: legacyPixels },
            [legacyPixels.buffer],
          );
        } else {
          const base = { decodeId, w: info.width, h: info.height, sourceW, sourceH };
          const req = (data.region != null || data.downsample != null) ? { region: data.region ?? null, downsample: data.downsample ?? 1 } : {};
          self.postMessage(
            { type: 'jxl_progress', ...base, ...req, rgba: pixelsArray, isFinal },
            [pixelsArray.buffer],
          );
        }
      } else if (ev.type === 'error') {
        self.postMessage({
          type: 'decode_error',
          decodeId,
          error: `${ev.code}: ${ev.message}`,
        });
      }
    }
    decoder.dispose();
  } catch (err) {
    console.warn('Progressive JXL decode failed in jxl-decode-worker, falling back to jsquash one-shot for decodeId', decodeId, err);
    // Note: jsquash one-shot (handleJxlDecode) does not support region/downsample; falls back to full frame.
    await handleJxlDecode(data);
  }
}

self.onmessage = async ({ data }) => {
  if (data && data.progressive) {
    await handleProgressiveDecode(data);
  } else {
    await handleJxlDecode(data);
  }
};
