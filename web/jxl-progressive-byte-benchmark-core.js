import { createDecoder } from '@casabio/jxl-wasm';
import { buildByteCutoffPlan } from './jxl-byte-cutoff-probe.js';
import { createProgressiveWebPreset, createSidecarTargetPlan } from './jxl-progressive-best-preset.js';
import { classifyByteCutoffFrame, summarizeByteCutoffResults, buildSeries } from './jxl-progressive-byte-metrics.js';  // R1 for unified series (connectedness)

export const TRANSPORT_PROFILES = Object.freeze({
  '3g': Object.freeze({ name: '3g', chunkBytes: 8 * 1024, chunkDelayMs: 220, jitterMs: 60 }),
  lte: Object.freeze({ name: 'lte', chunkBytes: 16 * 1024, chunkDelayMs: 80, jitterMs: 20 }),
  wifi: Object.freeze({ name: 'wifi', chunkBytes: 64 * 1024, chunkDelayMs: 20, jitterMs: 5 }),
  'diagnostic-passes': Object.freeze({ name: 'diagnostic-passes', chunkBytes: 4 * 1024, chunkDelayMs: 0, jitterMs: 0 }),
});

export function buildBenchmarkExport(results, exportedAt = new Date().toISOString()) {
  return { exportedAt, results };
}

export async function runBenchmarkSession({
  state,
  runCount = 1,
  targetLongEdge = 800,
  quality = 85,
  progressiveDetail = 'passes',
  ssimulacra2Target = null,
  transportProfile = 'lte',
  onStatus = () => {},
  onRecord = () => {},
  loadSource,
  createSidecarTargetPlan: createVariantPlan = createSidecarTargetPlan,
  createPreset = createProgressiveWebPreset,
  makeTargetRgba,
  encodeTarget,
  buildByteCutoffPlan: buildPlan = buildByteCutoffPlan,
  streamDecodeCutoffs: streamCutoffs = streamDecodeCutoffs,
  classifyByteCutoffFrame: classifyCutoff = classifyByteCutoffFrame,
  summarizeByteCutoffResults: summarizeCutoffs = summarizeByteCutoffResults,
  driveRealSession = false,  // Layer 1: for fidelity vs synthetic; when true, forces 0-delay transport + cursor-based chunking for "real arrival" simulation in flip-flops
} = {}) {
  if (!state || state.running) return state?.results ?? [];
  if (!state.rawReady) {
    onStatus('Waiting for RAW WASM.');
    return [];
  }

  const resolvedTransport = resolveTransportProfile(transportProfile);
  const results = [];
  for (let i = 0; i < runCount; i++) {
    onStatus(`Loading Gobabeb ORF ${i + 1}/${runCount}...`);
    const source = await loadSource();
    const variantTargets = createVariantPlan(targetLongEdge === 'full' ? 'full' : Number(targetLongEdge));
    const variants = [];

    for (const variantTarget of variantTargets) {
      const isSidecar = variantTargets.length > 1 && variantTarget !== variantTargets.at(-1);
      const label = isSidecar ? `sidecar ${variantTarget}` : `target ${variantTarget}`;
      const preset = createPreset({
        width: source.width,
        height: source.height,
        targetLongEdge: variantTarget,
        quality,
        ssimulacra2Target,
        progressiveDetail,
      });
      const targetRgba = makeTargetRgba(source, preset.target.width, preset.target.height);
      const encodeStart = performance.now();
      const jxlBytes = await encodeTarget(targetRgba, preset.encode, variantTarget);
      const encodeMs = performance.now() - encodeStart;
      const plan = buildPlan(jxlBytes.byteLength, preset.byteCutoffs);
      const streamed = await streamCutoffs(
        jxlBytes,
        plan,
        preset.decode,
        () => {},
        { transportProfile: resolvedTransport, driveRealSession },
      );
      // connectedness R1: collect for buildSeries (unified psnr/butter/ssim series)
      const cutoffPixels = [];
      const byteSizes = [];
      for (const cutoff of streamed.cutoffs) {
        if (cutoff.frame && cutoff.frame.pixels) {
          const p = toUint8Array(cutoff.frame.pixels);
          cutoffPixels.push(p);
          byteSizes.push(cutoff.bytes);
        }
      }
      let builtSeries = null;
      if (cutoffPixels.length > 0 && typeof buildSeries === 'function') {
        builtSeries = buildSeries(targetRgba, cutoffPixels, byteSizes, preset.target.width, preset.target.height);
      }
      const cutoffResults = streamed.cutoffs.map((cutoff) => classifyCutoff(cutoff));
      const summary = summarizeCutoffs(cutoffResults, jxlBytes.byteLength);
      variants.push({
        label,
        sidecar: isSidecar,
        target: preset.target,
        encode: preset.encode,
        encodeMs,
        jxlBytes: jxlBytes.byteLength,
        transportProfile: resolvedTransport.name,
        firstPaintMs: streamed.firstPaintMs,
        previewMs: streamed.previewMs,
        finalMs: streamed.finalMs,
        stallCount: streamed.stallCount,
        avgPaintGapMs: streamed.avgPaintGapMs,
        summary,
        cutoffs: cutoffResults,
        builtSeries,  // R1 connectedness: full psnr/butter/ssim series for cutoff
        driveRealSession,  // Layer 1: for direct flip-flop use of Cursor vs legacy / real fidelity
      });
    }

    const targetVariant = variants.at(-1) ?? null;
    const firstVisible = variants.find((variant) => variant.summary.firstPaintBytes != null) ?? targetVariant;
    const sidecarFirst = variants.find((variant) => variant.sidecar && variant.summary.firstPaintBytes != null) ?? null;
    const record = {
      source: source.name,
      rawBytes: source.rawBytes,
      transportProfile: resolvedTransport.name,
      variants,
      target: targetVariant?.target ?? null,
      summary: targetVariant?.summary ?? null,
      targetUsefulEarlyPaint: targetVariant?.summary.usefulEarlyPaint ?? false,
      sidecarFirstVisibleBytes: sidecarFirst?.summary.firstPaintBytes ?? null,
      firstVisibleBytes: firstVisible?.summary.firstPaintBytes ?? null,
      ssimulacra2: resolveRecordSsimulacra2(variants, ssimulacra2Target),
      driveRealSession,  // Layer 1 wiring
    };
    results.push(record);
    onRecord(record, { source, variants });
  }

  state.results = results;
  return results;
}

class ByteIntervalCursor {
  // Tiny mathematical abstraction over the byte interval [0, total) partitioned into fixed-size quanta.
  // Encapsulates the partition (via createChunkFeeder) and the advancing cursor (cIdx, cOff).
  // The hot loop only asks "cover the next 'need' bytes" and gets back the exact buffer to push + how far we advanced.
  // This makes the discrete covering math, remainder handling, and pre-paid copy explicit and reusable
  // (e.g. for different partitioning strategies or flip-flop experiments).
  constructor(jxlBytes, chunkBytes) {
    const { chunks } = createChunkFeeder(jxlBytes, chunkBytes);
    this.chunks = chunks;
    this.cIdx = 0;
    this.cOff = 0;
  }

  // Returns { buffer: ArrayBuffer to push, advanced: bytes covered } or {buffer: null, advanced: 0} when exhausted.
  // For full quanta we return the pre-owned AB (no copy). For partial tails only the needed sub-slice is copied.
  nextFor(need) {
    if (this.cIdx >= this.chunks.length || need <= 0) {
      return { buffer: null, advanced: 0 };
    }
    const pre = this.chunks[this.cIdx];
    const remain = pre.byteLength - this.cOff;
    const take = Math.min(need, remain);
    if (take <= 0) return { buffer: null, advanced: 0 };

    let buf;
    if (this.cOff === 0 && take === pre.byteLength) {
      buf = pre; // identity hand-off of owned AB
    } else {
      buf = pre.slice(this.cOff, this.cOff + take);
    }
    this.cOff += take;
    if (this.cOff >= pre.byteLength) {
      this.cIdx++;
      this.cOff = 0;
    }
    return { buffer: buf, advanced: take };
  }
}

export async function streamDecodeCutoffs(...args) {
  const {
    decoder,
    decodeOptions,
    jxlBytes,
    plan,
    onStep = () => {},
    transportProfile = 'lte',
    waitForTurn = defaultWaitForTurn,
    sleep = defaultSleep,
    now = () => performance.now(),
    random = Math.random,
    selfStability = false,
    pixels: withPixels = true,
    onProgressiveFrame,
    driveRealSession = false,
  } = normalizeStreamArgs(args);
  let resolvedTransport = resolveTransportProfile(transportProfile);
  if (driveRealSession) {
    // Layer 1 wiring: driveRealSession forces immediate (0-delay) "arrival" to simulate real
    // session/worker path without synthetic jitter, while still using byte cutoffs + Cursor for measurement.
    // Useful for fidelity comparison in flip-flop tests vs full transport sim.
    resolvedTransport = { ...resolvedTransport, chunkDelayMs: 0, jitterMs: 0, name: resolvedTransport.name + '-real' };
  }
  const activeDecoder = decoder ?? createDecoder(decodeOptions);
  const cutoffs = plan.map((entry) => ({ entry, bytes: entry.bytes, events: [], frame: null, error: null }));
  const byBytes = new Map(cutoffs.map((cutoff) => [cutoff.bytes, cutoff]));
  // Parallel arrays for the raw time series (primitives + original event objects).
  // Avoids per-event object spread + allocation in the hot concurrent eventTask.
  // Materialization of augmented {..., tMs} objects is deferred until cutoff snapshot time (rare).
  const eventLog = { tMs: [], types: [], data: [] };
  let seenEvents = 0;
  let offset = 0;
  let streamError = null;
  const startMs = now();

  try {
    const eventTask = (async () => {
      for await (const event of activeDecoder.events()) {
        if (event.type === 'error') throw new Error(`${event.code}: ${event.message}`);
        if (event.type === 'progress' || event.type === 'final') {
          eventLog.tMs.push(now() - startMs);
          eventLog.types.push(event.type);
          eventLog.data.push(event); // keep original event object, no spread here
        }
      }
    })();

    // Use the mathematical cursor over the pre-partitioned byte interval.
    const tChunk = resolvedTransport.chunkBytes;
    const cursor = new ByteIntervalCursor(jxlBytes, tChunk);

    for (const entry of plan) {
      if (entry.bytes <= offset) continue;
      onStep(entry);
      while (offset < entry.bytes) {
        const need = entry.bytes - offset;
        let took = 0;
        while (need > took) {
          const { buffer, advanced } = cursor.nextFor(need - took);
          if (!buffer || advanced <= 0) break;
          await activeDecoder.push(buffer);
          took += advanced;
          offset += advanced;
        }
        if (took === 0) {
          // rare misalignment fallback (keeps original observable behavior)
          const nextOffset = Math.min(entry.bytes, offset + tChunk);
          await activeDecoder.push(exactBuffer(jxlBytes.subarray(offset, nextOffset)));
          offset = nextOffset;
        }
        await waitForTurn();
        if (offset < entry.bytes) {
          await sleep(applyJitter(resolvedTransport, random));
        }
      }
      await drainDecoderTurns(waitForTurn, 2);

      // Snapshot only at cutoff boundaries (materialize the small slice of augmented events here).
      const cutoff = byBytes.get(entry.bytes);
      if (cutoff) {
        const startIdx = seenEvents;
        const endIdx = eventLog.tMs.length;
        const newEvents = [];
        for (let i = startIdx; i < endIdx; i++) {
          const orig = eventLog.data[i];
          newEvents.push({
            ...orig,
            tMs: eventLog.tMs[i],
            type: eventLog.types[i]
          });
        }
        cutoff.events.push(...newEvents);
        const lastEv = newEvents.length > 0 ? newEvents[newEvents.length - 1] : cutoff.frame;
        if (withPixels && lastEv && lastEv.pixels) {
          cutoff.frame = { ...lastEv, pixels: toUint8Array(lastEv.pixels) };
        } else if (lastEv) {
          cutoff.frame = lastEv;
        }
        seenEvents = endIdx;
        if (typeof onProgressiveFrame === 'function') {
          onProgressiveFrame({ entry, bytes: entry.bytes, frame: cutoff.frame, tMs: lastEv?.tMs ?? null });
        }
      }
    }

    await activeDecoder.close();
    await eventTask;
  } catch (error) {
    streamError = error instanceof Error ? error.message : String(error);
  } finally {
    await activeDecoder.dispose();
  }

  if (streamError) {
    for (const cutoff of cutoffs) {
      if (!cutoff.frame) cutoff.error = streamError;
    }
  }

  const timeline = summarizeTimeline(cutoffs);
  return {
    cutoffs,
    error: streamError,
    transportProfile: resolvedTransport.name,
    ...timeline,
    selfStability: selfStability || null,
    withPixels,
  };
}

export function resolveRecordSsimulacra2(_variants, requestedTarget) {
  const requested = Number.isFinite(Number(requestedTarget));
  return {
    requested,
    available: false,
    target: requested ? Number(requestedTarget) : null,
  };
}

function normalizeStreamArgs(args) {
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && 'plan' in args[0]) {
    return args[0];
  }
  const [jxlBytes, plan, decodeOptions, onStep, context = {}] = args;
  return { jxlBytes, plan, decodeOptions, onStep, ...context };
}

function resolveTransportProfile(profile) {
  if (typeof profile === 'string') {
    return TRANSPORT_PROFILES[profile] ?? TRANSPORT_PROFILES.lte;
  }
  if (profile && Number.isFinite(Number(profile.chunkBytes))) {
    return {
      name: profile.name ?? 'custom',
      chunkBytes: Math.max(1024, Math.floor(Number(profile.chunkBytes))),
      chunkDelayMs: Math.max(0, Number(profile.chunkDelayMs) || 0),
      jitterMs: Math.max(0, Number(profile.jitterMs) || 0),
    };
  }
  return TRANSPORT_PROFILES.lte;
}

function summarizeTimeline(cutoffs) {
  // Online / single-pass aggregates over the time series.
  // Events are appended in emission order (monotonic tMs from successive pushes + now()).
  // We maintain running milestone state + gap statistics without materializing a paints list
  // or sorting. This is O(E) time and O(1) extra space (E = total progress+final events).
  let firstPaint = null;
  let preview = null;
  let final = null;
  let prevT = null;
  let gapSum = 0;
  let gapCount = 0;
  let stallCount = 0;

  for (const cutoff of cutoffs) {
    for (const ev of cutoff.events) {
      if (!ev || !Number.isFinite(ev.tMs)) continue;
      const t = ev.tMs;
      if (firstPaint === null) firstPaint = ev;
      if (preview === null && ev.type === 'progress') preview = ev;
      final = ev; // last seen wins (later events have higher t)
      if (prevT !== null) {
        const g = t - prevT;
        gapSum += g;
        gapCount++;
        if (g > 250) stallCount++;
      }
      prevT = t;
    }
  }
  const usePreview = preview || firstPaint;
  return {
    firstPaintMs: firstPaint?.tMs ?? null,
    previewMs: usePreview?.tMs ?? null,
    finalMs: final?.tMs ?? null,
    stallCount,
    avgPaintGapMs: gapCount ? gapSum / gapCount : 0,
  };
}

async function drainDecoderTurns(waitForTurn, turns) {
  for (let i = 0; i < turns; i++) {
    await waitForTurn();
  }
}

function applyJitter(profile, random) {
  if (!profile.jitterMs) return profile.chunkDelayMs;
  // Integer delta keeps the simulated arrival times on a discrete ms lattice.
  // Better for reproducibility in diagnostic-passes mode and for flip-flop A/B timing experiments.
  const delta = Math.round((random() * 2 - 1) * profile.jitterMs);
  return Math.max(0, profile.chunkDelayMs + delta);
}

function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
    ? view.buffer
    : view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('frame pixels must be ArrayBuffer or ArrayBufferView');
}

async function defaultWaitForTurn() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function defaultSleep(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createChunkFeeder(jxlBytes, chunkBytes) {
  // Pure discrete partition of the byte range [0, length) into fixed-size quanta (last may be smaller).
  // Returns owned small ArrayBuffers so callers can advance a cursor without re-deriving slices
  // from the master on every step. Useful for flip-flop timing experiments and external harnesses.
  const jb = exactBuffer(jxlBytes);
  const chunks = [];
  for (let o = 0; o < jb.byteLength; o += chunkBytes) {
    const e = Math.min(o + chunkBytes, jb.byteLength);
    chunks.push(jb.slice(o, e));
  }
  return { chunks, totalBytes: jb.byteLength };
}

export { exactBuffer, toUint8Array, createChunkFeeder, ByteIntervalCursor };
