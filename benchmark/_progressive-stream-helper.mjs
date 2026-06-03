// Shared streaming-decode helpers for progressive bench scripts.

export function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

export function concatChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function waitForStreamEvents(waitMs = 0) {
  if (waitMs > 0) return new Promise((resolve) => setTimeout(resolve, waitMs));
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Feeds jxlBytes to a fresh decoder in cutoff-bounded slices, captures the
 * latest progress/final pixels per cutoff slot, returns {cutoffs, error}.
 * Pixels in each cutoff are a Uint8Array copy (decoder reuses internal buffers).
 */
export async function streamDecodeCutoffs(jxlBytes, plan, decodeOptions, { createDecoder, waitMs = 0 } = {}) {
  if (!createDecoder) throw new Error('streamDecodeCutoffs requires createDecoder');
  const decoder = createDecoder(decodeOptions);
  const cutoffs = plan.map((entry) => ({
    entry,
    bytes: entry.bytes,
    events: [],
    pixels: null,
    width: 0,
    height: 0,
    paintIndex: null,
    error: null,
  }));
  const byBytes = new Map(cutoffs.map((cutoff) => [cutoff.bytes, cutoff]));
  let currentEntry = plan[0] ?? null;
  let paintCounter = 0;
  let error = null;
  try {
    const eventTask = (async () => {
      for await (const event of decoder.events()) {
        if (event.type === 'progress' || event.type === 'final') {
          const cutoff = byBytes.get(currentEntry?.bytes) ?? cutoffs.at(-1);
          if (cutoff) {
            cutoff.events.push(event);
            cutoff.pixels = new Uint8Array(event.pixels);
            cutoff.width = event.info?.width ?? 0;
            cutoff.height = event.info?.height ?? 0;
            cutoff.paintIndex = paintCounter++;
          }
        }
        if (event.type === 'error') throw new Error(`${event.code}: ${event.message}`);
      }
    })();
    let offset = 0;
    for (const entry of plan) {
      if (entry.bytes <= offset) continue;
      currentEntry = entry;
      await decoder.push(exactBuffer(jxlBytes.subarray(offset, entry.bytes)));
      offset = entry.bytes;
      await waitForStreamEvents(waitMs);
    }
    await decoder.close();
    await eventTask;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await decoder.dispose();
  }
  if (error) {
    for (const cutoff of cutoffs) {
      if (cutoff.events.length === 0) cutoff.error = error;
    }
  }
  return { cutoffs, error };
}

/**
 * Computes per-cutoff PSNR vs the last (final) cutoff's pixels.
 * Returns array of {bytes, psnr, ssim} suitable for summarizeByteCutoffResults.
 */
export async function computeQualitySeries(cutoffs) {
  const finalCutoff = [...cutoffs].reverse().find((c) => c.pixels) ?? null;
  if (!finalCutoff) return [];
  const { computePsnrVsFinal, computeSsimVsFinal } = await import('../web/jxl-progressive-quality.js');
  const series = [];
  for (const cutoff of cutoffs) {
    if (!cutoff.pixels) continue;
    if (cutoff.pixels.length !== finalCutoff.pixels.length) continue;
    series.push({
      bytes: cutoff.bytes,
      psnr: computePsnrVsFinal(cutoff.pixels, finalCutoff.pixels),
      ssim: computeSsimVsFinal(cutoff.pixels, finalCutoff.pixels, finalCutoff.width, finalCutoff.height),
    });
  }
  return series;
}
