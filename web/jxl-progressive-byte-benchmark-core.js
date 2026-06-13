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
        { transportProfile: resolvedTransport },
      );
      // connectedness R1: collect for buildSeries (unified psnr/butter/ssim series)
      const cutoffPixels = [];
      const byteSizes = [];
      for (const cutoff of streamed.cutoffs) {
        if (cutoff.frame && cutoff.frame.pixels) {
          const p = cutoff.frame.pixels instanceof Uint8Array ? cutoff.frame.pixels : new Uint8Array(cutoff.frame.pixels.buffer || cutoff.frame.pixels);
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
  } = normalizeStreamArgs(args);
  const resolvedTransport = resolveTransportProfile(transportProfile);
  const activeDecoder = decoder ?? createDecoder(decodeOptions);
  const cutoffs = plan.map((entry) => ({ entry, bytes: entry.bytes, events: [], frame: null, error: null }));
  const byBytes = new Map(cutoffs.map((cutoff) => [cutoff.bytes, cutoff]));
  const eventLog = [];
  let seenEvents = 0;
  let offset = 0;
  let streamError = null;
  const startMs = now();

  try {
    const eventTask = (async () => {
      for await (const event of activeDecoder.events()) {
        if (event.type === 'error') throw new Error(`${event.code}: ${event.message}`);
        if (event.type === 'progress' || event.type === 'final') {
          eventLog.push({ ...event, tMs: now() - startMs });
        }
      }
    })();

    for (const entry of plan) {
      if (entry.bytes <= offset) continue;
      onStep(entry);
      while (offset < entry.bytes) {
        const nextOffset = Math.min(entry.bytes, offset + resolvedTransport.chunkBytes);
        await activeDecoder.push(exactBuffer(jxlBytes.subarray(offset, nextOffset)));
        offset = nextOffset;
        await waitForTurn();
        if (offset < entry.bytes) {
          await sleep(applyJitter(resolvedTransport, random));
        }
      }
      await drainDecoderTurns(waitForTurn, 2);
      const cutoff = byBytes.get(entry.bytes);
      if (cutoff) {
        cutoff.events.push(...eventLog.slice(seenEvents));
        cutoff.frame = cutoff.events.at(-1) ?? cutoff.frame;
        seenEvents = eventLog.length;
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
    selfStability: context.selfStability || null,  // option for no-ref early stop (lens18/20)
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
  const paints = cutoffs
    .flatMap((cutoff) => cutoff.events)
    .filter((event) => event && Number.isFinite(event.tMs))
    .sort((a, b) => a.tMs - b.tMs);
  const firstPaint = paints[0] ?? null;
  const preview = paints.find((event) => event.type === 'progress') ?? firstPaint;
  const final = paints.find((event) => event.type === 'final') ?? paints.at(-1) ?? null;
  const gaps = [];
  for (let i = 1; i < paints.length; i++) {
    gaps.push(paints[i].tMs - paints[i - 1].tMs);
  }
  return {
    firstPaintMs: firstPaint?.tMs ?? null,
    previewMs: preview?.tMs ?? null,
    finalMs: final?.tMs ?? null,
    stallCount: gaps.filter((gap) => gap > 250).length,
    avgPaintGapMs: gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : 0,
  };
}

async function drainDecoderTurns(waitForTurn, turns) {
  for (let i = 0; i < turns; i++) {
    await waitForTurn();
  }
}

function applyJitter(profile, random) {
  if (!profile.jitterMs) return profile.chunkDelayMs;
  const delta = (random() * 2 - 1) * profile.jitterMs;
  return Math.max(0, profile.chunkDelayMs + delta);
}

function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
    ? view.buffer
    : view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

async function defaultWaitForTurn() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function defaultSleep(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
