import { createDecoder } from '@casabio/jxl-wasm';
import { buildByteCutoffPlan } from './jxl-byte-cutoff-probe.js';
import { createProgressiveWebPreset, createSidecarTargetPlan } from './jxl-progressive-best-preset.js';
import { classifyByteCutoffFrame, summarizeByteCutoffResults, buildSeries } from './jxl-progressive-byte-metrics.js';  // R1 for unified series (connectedness)
import {
  TRANSPORT_PROFILES,
  resolveTransportProfile,
  exactBuffer,
  toUint8Array,
  createChunkFeeder,
  ByteIntervalCursor,
  LazyByteIntervalCursor,
} from './jxl-byte-utils.js';

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
        if (cutoff.pixels) {
          cutoffPixels.push(cutoff.pixels);
          byteSizes.push(cutoff.bytes);
        }
      }
      let builtSeries = null;
      if (cutoffPixels.length > 0 && typeof buildSeries === 'function') {
        builtSeries = buildSeries(targetRgba, cutoffPixels, byteSizes, preset.target.width, preset.target.height);
      }
      const cutoffResults = streamed.cutoffs.map((cutoff) => classifyCutoff(cutoff));
      // Seam fix: feed the computed series into the summary so the (expensive) perceptual work isn't
      // discarded — without this, firstRecognizable/perceptuallyGood/ssimMonotone/finalPsnr stay null.
      const summary = summarizeCutoffs(
        cutoffResults,
        jxlBytes.byteLength,
        builtSeries
          ? { qualitySeries: builtSeries.qualitySeries, butterSeries: builtSeries.butterSeries, ssimSeries: builtSeries.ssimSeries }
          : undefined,
      );
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
    driveWithCursor = true,  // expanded for real use per L1
    drainTurns = 2,  // configurable decoder drain turns per cutoff boundary
  } = normalizeStreamArgs(args);
  let resolvedTransport = resolveTransportProfile(transportProfile);
  if (driveRealSession) {
    // Layer 1 wiring: driveRealSession forces immediate (0-delay) "arrival" to simulate real
    // session/worker path without synthetic jitter, while still using byte cutoffs + Cursor for measurement.
    // Useful for fidelity comparison in flip-flop tests vs full transport sim.
    resolvedTransport = { ...resolvedTransport, chunkDelayMs: 0, jitterMs: 0, name: resolvedTransport.name + '-real' };
  }
  const activeDecoder = decoder ?? createDecoder(decodeOptions);
  const cutoffs = plan.map((entry) => ({ entry, bytes: entry.bytes, events: [], frame: null, pixels: null, error: null }));
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

    if (driveWithCursor) {
      // Cursor-driven strategy: pre-partition the byte range into fixed quanta and advance a cursor.
      // Enables measurement without synthetic transport sim and supports flip-flop A/B testing.
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
        await drainDecoderTurns(waitForTurn, drainTurns);
        snapshotCutoff(entry, byBytes, seenEvents, eventLog, withPixels, onProgressiveFrame);
        seenEvents = eventLog.tMs.length;
      }
    } else {
      // Legacy non-cursor strategy: direct byte chunking without pre-partition.
      const tChunk = resolvedTransport.chunkBytes;

      for (const entry of plan) {
        if (entry.bytes <= offset) continue;
        onStep(entry);
        while (offset < entry.bytes) {
          const nextOffset = Math.min(entry.bytes, offset + tChunk);
          await activeDecoder.push(exactBuffer(jxlBytes.subarray(offset, nextOffset)));
          offset = nextOffset;
          await waitForTurn();
          if (offset < entry.bytes) {
            await sleep(applyJitter(resolvedTransport, random));
          }
        }
        await drainDecoderTurns(waitForTurn, drainTurns);
        snapshotCutoff(entry, byBytes, seenEvents, eventLog, withPixels, onProgressiveFrame);
        seenEvents = eventLog.tMs.length;
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

export function resolveRecordSsimulacra2(variants, requestedTarget) {
  const requested = Number.isFinite(Number(requestedTarget));
  if (!requested || !Array.isArray(variants) || variants.length === 0) {
    return {
      requested: false,
      available: false,
      target: null,
      score: null,
    };
  }

  // Use the target variant (last in list) to extract SSIM series
  const targetVariant = variants.at(-1);
  if (!targetVariant?.builtSeries?.ssimSeries || targetVariant.builtSeries.ssimSeries.length === 0) {
    return {
      requested,
      available: false,
      target: Number(requestedTarget),
      score: null,
    };
  }

  // Find SSIM value closest to the requested target byte cutoff
  const ssimSeries = targetVariant.builtSeries.ssimSeries;
  let closestEntry = null;
  let closestDist = Infinity;

  for (const entry of ssimSeries) {
    const dist = Math.abs(entry.bytes - requestedTarget);
    if (dist < closestDist) {
      closestDist = dist;
      closestEntry = entry;
    }
  }

  return {
    requested,
    available: closestEntry != null,
    target: Number(requestedTarget),
    score: closestEntry?.ssim ?? null,
    achievedAt: closestEntry?.bytes ?? null,
  };
}

function normalizeStreamArgs(args) {
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && 'plan' in args[0]) {
    return args[0];
  }
  const [jxlBytes, plan, decodeOptions, onStep, context = {}] = args;
  return { jxlBytes, plan, decodeOptions, onStep, ...context };
}


function snapshotCutoff(entry, byBytes, startSeenEvents, eventLog, withPixels, onProgressiveFrame) {
  // Materialize augmented event objects for this cutoff boundary.
  const cutoff = byBytes.get(entry.bytes);
  if (cutoff) {
    const startIdx = startSeenEvents;
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
      cutoff.frame = lastEv;
      cutoff.pixels = toUint8Array(lastEv.pixels);
    } else if (lastEv) {
      cutoff.frame = lastEv;
    }
    if (typeof onProgressiveFrame === 'function') {
      onProgressiveFrame({ entry, bytes: entry.bytes, frame: cutoff.frame, tMs: lastEv?.tMs ?? null });
    }
  }
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



async function defaultWaitForTurn() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function defaultSleep(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}


export { TRANSPORT_PROFILES, resolveTransportProfile, exactBuffer, toUint8Array, createChunkFeeder, ByteIntervalCursor, LazyByteIntervalCursor };
