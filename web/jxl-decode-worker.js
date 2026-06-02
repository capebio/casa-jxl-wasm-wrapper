// Dedicated JXL decode worker — kept separate from jxl-worker.js (encoder) so
// that a long Emscripten-pthread encode cannot block lightbox decode requests.
import decode from './vendor/jsquash-jxl/decode.js';
import { createDecoder } from '../packages/jxl-wasm/dist/index.js';

// Fire-and-forget preload (same pattern as jxl-worker.js)
import('../packages/jxl-wasm/dist/index.js')
  .then(({ preloadJxlModule }) => preloadJxlModule?.())
  .catch(() => {});

// Extract embedded JPEG bitstream(s) from a JXL container (for JXTC/recon cases).
// Same strategy as RAW/TIFF: scan for SOI (FF D8 FF), take up to next or EOI.
// Used only when jpegReconstructionAvailable to provide fast native-JPEG first paint
// for container-derived JXL sources. Pure JXLs (no recon) never hit this.
function extractEmbeddedJpegs(bytes) {
    const sois = [];
    for (let i = 0; i < bytes.length - 2; i++) {
        if (bytes[i] === 0xFF && bytes[i + 1] === 0xD8 && bytes[i + 2] === 0xFF) {
            sois.push(i);
            i += 2;
        }
    }
    const blobs = [];
    for (let n = 0; n < sois.length; n++) {
        const start = sois[n];
        const end = n + 1 < sois.length ? sois[n + 1] : bytes.length;
        let eoi = -1;
        for (let j = end - 2; j >= start + 2; j--) {
            if (bytes[j] === 0xFF && bytes[j + 1] === 0xD9) { eoi = j; break; }
        }
        if (eoi !== -1) blobs.push(bytes.slice(start, eoi + 2));
    }
    return blobs;
}

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

    // P3.3 JXTC / container preview extraction: for JXLs that were produced from JPEG with
    // reconstruction (jpegReconstructionAvailable), the original JPEG bitstream is stored
    // in the container. Extract it here (pure JS scan, no extra decode cost) and post early
    // so the lightbox can paint a full-quality preview *instantly* using the browser's native
    // JPEG decoder (createImageBitmap / drawImage), before or instead of any JXL DC progressive
    // RGBA work.
    // This path is *only* taken for container-derived JXL sources. Pure JXL encodings (no recon
    // flag) never extract or use JPEG bytes — they go through the normal previewFirst DC or
    // progressive JXL RGBA path. This respects the design preference for optimized JXL while
    // providing the fast "embedded preview" experience for JXTC-wrapped cases.
    try {
      const bytes = new Uint8Array(buf);
      const reconBlobs = extractEmbeddedJpegs(bytes);
      if (reconBlobs.length > 0) {
        const reconJpeg = reconBlobs[0]; // primary embedded JPEG
        self.postMessage(
          { type: 'jxl_recon_jpeg', decodeId, jpeg: reconJpeg, frameIndex: data.frameIndex ?? 0 },
          [reconJpeg.buffer]
        );
      }
    } catch (e) {
      // Non-fatal; fall through to normal JXL progressive preview.
    }

    // P3.3: first try quick DC preview (container/embedded preview style) if previewFirst
    // Quick full low-res (downsampled) 'dc' decode first → emit jxl_preview + header → dispose → main (ROI/ds/detail) decode.
    if (data.previewFirst) {
      let previewDec = null;
      try {
        const prevDs = 2; // P3.3: fixed quick recognizable overview for container preview (dc); main uses the (possibly higher) requested ds for detail. Faster than matching ultra-low ROI ds.
        previewDec = createDecoder({
          format: 'rgba8',
          region: null, // preview is always full low-res; main decoder may apply region/ds
          downsample: prevDs,
          progressionTarget: 'final',
          emitEveryPass: false,
          progressiveDetail: 'dc',
          frameIndex: data.frameIndex ?? 0,
          preserveIcc: true,
          preserveMetadata: true,
        });
        await previewDec.push(buf);
        await previewDec.close();
        let psw = 0, psh = 0;
        for await (const ev of previewDec.events()) {
          if (ev.type === 'header') {
            psw = ev.info.width || 0;
            psh = ev.info.height || 0;
            self.postMessage({ type: 'jxl_header', decodeId, w: psw, h: psh, hasAnimation: !!ev.info.hasAnimation, jpegReconstructionAvailable: !!ev.info.jpegReconstructionAvailable });
          } else if (ev.type === 'progress' || ev.type === 'final') {
            let pixelsArray = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
            if (pixelsArray.byteOffset !== 0 || pixelsArray.byteLength !== pixelsArray.buffer.byteLength) {
              pixelsArray = new Uint8Array(pixelsArray);
            }
            // P3.3: include hasAnimation (and any frame meta) on preview too for early strategy / animated detection
            const previewAnim = {
              hasAnimation: !!ev.info.hasAnimation,
              ...(ev.frameDuration !== undefined ? { frameDuration: ev.frameDuration } : {}),
              ...(ev.animTicksPerSecond !== undefined ? { animTicksPerSecond: ev.animTicksPerSecond } : {}),
            };
            const previewJxtc = {
              jpegReconstructionAvailable: !!ev.info.jpegReconstructionAvailable,
            };
            self.postMessage(
              {
                type: 'jxl_preview',
                decodeId,
                rgba: pixelsArray,
                w: ev.info.width,
                h: ev.info.height,
                isFinal: true,
                frameIndex: data.frameIndex ?? 0,
                sourceW: psw,
                sourceH: psh,
                region: null,
                downsample: prevDs,
                progressiveDetail: 'dc',
                ...previewAnim,
                ...previewJxtc
              },
              [pixelsArray.buffer]
            );
          }
        }
      } catch (e) {
        console.warn('P3.3 preview decode failed for', decodeId, e);
      } finally {
        if (previewDec) {
          try { previewDec.dispose(); } catch (_) {}
        }
      }
    }

    const decoder = createDecoder({
      format: 'rgba8',
      region: data.region ?? null,
      downsample: data.downsample ?? 1,
      progressionTarget: 'final',
      emitEveryPass: true,
      progressiveDetail: data.progressiveDetail ?? 'lastPasses',
      frameIndex: data.frameIndex ?? 0,
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
        // P3.3: forward hasAnimation + jpegReconstructionAvailable (JXTC/container flag) for accurate badges and JXTC extraction / fast ROI path detection
        self.postMessage({ type: 'jxl_header', decodeId, w: sourceW, h: sourceH, hasAnimation: !!ev.info.hasAnimation, jpegReconstructionAvailable: !!ev.info.jpegReconstructionAvailable });
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
          // P3.3: forward animation/frame meta (when present on ev from facade) + hasAnimation for strategy badges (full dynamic multi-frame nav in primary lightbox is follow-up)
          const animMeta = {
            hasAnimation: !!info.hasAnimation,
            ...(ev.frameDuration !== undefined ? { frameDuration: ev.frameDuration } : {}),
            ...(ev.animTicksPerSecond !== undefined ? { animTicksPerSecond: ev.animTicksPerSecond } : {}),
            ...(ev.isLastFrame !== undefined ? { isLastFrame: ev.isLastFrame } : {}),
          };
          const jxtcMeta = {
            jpegReconstructionAvailable: !!info.jpegReconstructionAvailable,
          };
          const base = { decodeId, w: info.width, h: info.height, sourceW, sourceH, progressiveDetail: data.progressiveDetail ?? 'lastPasses', frameIndex: data.frameIndex ?? 0, stage: ev.stage, ...animMeta, ...jxtcMeta };
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
          const animMeta = {
            hasAnimation: !!info.hasAnimation,
            ...(ev.frameDuration !== undefined ? { frameDuration: ev.frameDuration } : {}),
            ...(ev.animTicksPerSecond !== undefined ? { animTicksPerSecond: ev.animTicksPerSecond } : {}),
            ...(ev.isLastFrame !== undefined ? { isLastFrame: ev.isLastFrame } : {}),
          };
          const jxtcMeta = {
            jpegReconstructionAvailable: !!info.jpegReconstructionAvailable,
          };
          const base = { decodeId, w: info.width, h: info.height, sourceW, sourceH, progressiveDetail: data.progressiveDetail ?? 'lastPasses', frameIndex: data.frameIndex ?? 0, stage: ev.stage, ...animMeta, ...jxtcMeta };
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
