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
    let encodeMs = null;
    let bytes = null;

    try {
      const { createEncoder } = await ensureJxl();

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
    } catch (e) {
      status = 'error';
      // Don't spam the console from every worker on every error during sweeps
    }

    // Send result back (no need to transfer anything heavy)
    self.postMessage({
      type: 'result',
      payload: { id, encodeMs, bytes, status }
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
