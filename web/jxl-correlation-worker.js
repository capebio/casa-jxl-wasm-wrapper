// jxl-correlation-worker.js
// Dedicated Web Worker for running individual JXL encode combos off the main thread.
// This allows the correlation matrix sweep (thousands of permutations) to continue
// making progress even when the tab is backgrounded.
//
// Main thread coordinates the job queue + UI.
// Workers do the actual CPU-heavy createEncoder + encode work.

/// <reference lib="webworker" />

let refPixels = null;
let refWidth = 0;
let refHeight = 0;
let jxlModule = null;
let workerTier = null;

// exactBuffer: return a detachable ArrayBuffer view for decoder.push (matches predator-progressive-metrics + paint)
function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/**
 * Prefix-probe helper (browser/worker version of the one added to predator-progressive-metrics.mjs).
 * Builds full codestream buffer from chunks, then probes increasing % prefixes with fresh
 * 'passes' decoders until a progress/final event surfaces. Returns the smallest cutoff bytes.
 * This gives the earliest codestream position for "bytes to first recognizable layer",
 * independent of the natural chunk boundaries used for the main firstProgressBytes collection.
 * Addresses the 2026-06 ref run observation that chunk-feed firstBytes often == total on real photos.
 */
async function probeMinBytesToFirstProgress(chunks, createDecoder) {
  if (!chunks || !chunks.length || typeof createDecoder !== 'function') return { minBytes: 0 };
  // concat
  let total = 0;
  const bufs = chunks.map(c => (c instanceof Uint8Array ? c : new Uint8Array(c)));
  for (const b of bufs) total += b.byteLength || 0;
  if (total === 0) return { minBytes: 0 };
  const full = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) {
    if (b.byteLength) { full.set(b, off); off += b.byteLength; }
  }
  const steps = 50; // 2% steps; fast for ref sizes
  let minBytes = total;
  for (let s = 1; s <= steps; s++) {
    const cut = Math.max(1, Math.ceil((total * s) / steps));
    if (cut >= minBytes) break;
    try {
      const decoder = createDecoder({
        format: 'rgba8',
        region: null,
        downsample: 1,
        progressionTarget: 'final',
        emitEveryPass: true,
        progressiveDetail: 'passes',
        preserveIcc: false,
        preserveMetadata: false,
      });
      let sawLayer = false;
      const drainP = (async () => {
        for await (const ev of decoder.events()) {
          if (ev.type === 'progress' || ev.type === 'final') {
            sawLayer = true;
          }
        }
      })();
      await decoder.push(exactBuffer(full.subarray(0, cut)));
      await decoder.close();
      await drainP;
      if (sawLayer) {
        minBytes = cut;
        break;
      }
    } catch (e) {
      // continue probing
    }
  }
  return { minBytes };
}

async function ensureJxl() {
  if (jxlModule) return jxlModule;
  // importmap is not inherited by workers — use direct path.
  jxlModule = await import('../packages/jxl-wasm/dist/index.js');
  if (workerTier != null) jxlModule.setForcedTier(workerTier);
  return jxlModule;
}

self.onmessage = async (event) => {
  const { type, payload } = event.data || {};

  if (type === 'init') {
    try {
      refPixels = payload.pixels; // Uint8Array transferred in
      refWidth = payload.width;
      refHeight = payload.height;
      workerTier = payload.tier ?? null;

      await ensureJxl();

      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', payload: { message: String(err?.message || err) } });
    }
    return;
  }

  if (type === 'run') {
    const { id, combo } = payload;

    const start = performance.now();
    let status = 'ok';
    let errorMessage = null;
    let encodeMs = null;
    let bytes = null;
    let progressEvents = null;
    let firstProgressMs = null;
    let firstProgressBytes = null;
    let minBytesToFirstProgress = null;

    try {
      const { createEncoder, createDecoder } = await ensureJxl();

      const isLossless = combo.lossless === 1;
      const encoder = createEncoder({
        format: 'rgba8',
        width: refWidth,
        height: refHeight,
        hasAlpha: true,
        quality: isLossless ? 100 : (combo.quality ?? 85),
        effort: combo.effort ?? 5,
        modular: isLossless ? 1 : (combo.modular !== undefined && combo.modular !== -1 ? combo.modular : undefined),
        progressive: !!combo.progressive,
        // Predator progressive continuation: forward Dc layers + center-out group order so matrix sweeps
        // can quantify the early recognizable passes (Dc=2 + group=1) vs baselines.
        progressiveDc: combo.progressive && combo.progressiveDc != null ? combo.progressiveDc : (combo.progressive ? 1 : 0),
        groupOrder: combo.progressive && combo.groupOrder != null ? combo.groupOrder : (combo.progressive ? 1 : 0),
        brotliEffort: combo.brotliEffort != null && combo.brotliEffort >= 0 ? combo.brotliEffort : undefined,
        decodingSpeed: combo.decodingSpeed,
        resampling: combo.resampling,
        photonNoiseIso: combo.photonNoiseIso > 0 ? combo.photonNoiseIso : undefined,
        epf: combo.epf != null ? combo.epf : undefined,
        gaborish: combo.gaborish != null ? combo.gaborish : undefined,
        dots: combo.dots != null ? combo.dots : undefined,
        colorTransform: combo.colorTransform != null ? combo.colorTransform : undefined,
      });

      const chunks = [];
      const chunkTask = (async () => {
        for await (const ch of encoder.chunks()) {
          chunks.push(ch);
        }
      })();

      // Note: refPixels is a view we keep alive in this worker
      await encoder.pushPixels(refPixels);
      await encoder.finish();
      await chunkTask;

      encodeMs = performance.now() - start;
      bytes = chunks.reduce((s, c) => s + (c.byteLength || c.length), 0);

      await encoder.dispose?.();

      // Predator decode-side layer metrics (per HANDOFF-predator-continuation + predator-progressive-metrics.mjs):
      // After encode, for progressive combos: create 'passes' decoder, incrementally feed the *natural chunks*
      // (accumulating fed bytes), drain events(), capture count of (progress+final), and fed-bytes + elapsed at
      // first such event. Non-destructive (encode result always returned). Matches paint-style decoder opts.
      // Observation from 2026-06 small-ref run: on real 300x225 photo some settings surface first progress only
      // at/near full codestream bytes (unlike noise tests); prefix-probe would give earlier byte position.
      if (combo.progressive && chunks.length > 0) {
        try {
          const decStart = performance.now();
          const decoder = createDecoder({
            format: 'rgba8',
            region: null,
            downsample: 1,
            progressionTarget: 'final',
            emitEveryPass: true,
            progressiveDetail: 'passes',
            preserveIcc: false,
            preserveMetadata: false,
          });
          let fed = 0;
          let localFirstMs = null;
          let localFirstBytes = null;
          let localCount = 0;
          const drain = (async () => {
            for await (const ev of decoder.events()) {
              if (ev.type === 'progress' || ev.type === 'final') {
                localCount++;
                if (localFirstMs === null) {
                  localFirstMs = performance.now() - decStart;
                  localFirstBytes = fed;
                }
              }
            }
          })();
          for (const ch of chunks) {
            const len = ch.byteLength || ch.length || 0;
            await decoder.push(exactBuffer(ch));
            // Count bytes AFTER the push that consumed them: incrementing before
            // push over-counted firstProgressBytes by one chunk when the very
            // first progress event surfaced from this push.
            fed += len;
          }
          await decoder.close();
          await drain;
          if (localFirstBytes === null) localFirstBytes = bytes;
          progressEvents = localCount;
          firstProgressBytes = localFirstBytes;
          firstProgressMs = localFirstMs != null ? Math.round(localFirstMs * 10) / 10 : null;
        } catch (de) {
          // leave metrics null; do not fail the encode cell
        }
      }

      // Prefix probe for min bytes (headroom from 2026-06 measurement): run after chunk collection
      // so we always have the natural chunks. This populates minBytesToFirstProgress for the
      // matrix "early bytes" heatmaps/CSV when progressive + Dc/group are swept.
      if (combo.progressive && chunks.length > 0 && typeof createDecoder === 'function') {
        try {
          const probe = await probeMinBytesToFirstProgress(chunks, createDecoder);
          if (probe && probe.minBytes > 0) {
            minBytesToFirstProgress = probe.minBytes;
          } else {
            minBytesToFirstProgress = bytes;
          }
        } catch (pe) {
          minBytesToFirstProgress = bytes; // fallback
        }
      } else if (combo.progressive) {
        minBytesToFirstProgress = bytes;
      }
    } catch (e) {
      status = 'error';
      errorMessage = String(e?.message || e);
      // Don't spam the console from every worker on every error during sweeps
    }

    // Send result back (no need to transfer anything heavy)
    self.postMessage({
      type: 'result',
      payload: { id, encodeMs, bytes, status, errorMessage, progressEvents, firstProgressMs, firstProgressBytes, minBytesToFirstProgress }
    });
    return;
  }

  if (type === 'shutdown') {
    // Optional cleanup
    refPixels = null;
    jxlModule = null;
    self.close();
  }
};

// Signal that the worker script has loaded and is ready to receive init
self.postMessage({ type: 'worker-loaded' });
