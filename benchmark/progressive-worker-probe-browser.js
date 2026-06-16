import { createBrowserContext } from "@casabio/jxl-session";
import { createDecoder } from "@casabio/jxl-wasm";

const FIRST_PAINT_CHUNK_RAMP = [1 * 1024, 2 * 1024, 4 * 1024, 8 * 1024, 16 * 1024];
const STEADY_DECODE_CHUNK_BYTES = 32 * 1024;
const PROGRESSIVE_DETAIL = "passes";

function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getHeapSize = () => (performance.memory ? performance.memory.usedJSHeapSize : null);

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function computeSortedStats(sorted) {
  if (sorted.length === 0) {
    return { min: 0, max: 0, median: 0, p95: 0 };
  }
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  
  let medianVal;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    medianVal = (sorted[mid - 1] + sorted[mid]) / 2;
  } else {
    medianVal = sorted[mid];
  }
  
  const p95Idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  const p95 = sorted[p95Idx];
  
  return { min, max, median: medianVal, p95 };
}

async function feed32k(target, bytes, feedState) {
  let offset = 0;
  let rampIdx = 0;
  let feedStallMs = 0;
  let isFirstPush = true;
  while (offset < bytes.byteLength) {
    let chunkBytes;
    if ((feedState.passCount ?? 0) > 0) {
      chunkBytes = STEADY_DECODE_CHUNK_BYTES;
    } else {
      chunkBytes = FIRST_PAINT_CHUNK_RAMP[Math.min(rampIdx, FIRST_PAINT_CHUNK_RAMP.length - 1)];
      rampIdx++;
    }
    const end = Math.min(bytes.byteLength, offset + chunkBytes);
    const chunk = exactBuffer(bytes.subarray(offset, end));

    if (isFirstPush) {
      feedState.pushStartMs = performance.now() - feedState.startTime;
      isFirstPush = false;
    }

    const tStart = performance.now();
    await target.push(chunk);
    feedStallMs += performance.now() - tStart;

    offset = end;
    feedState.bytesFed = offset;
    if (offset < bytes.byteLength) await sleep(0);
  }
  await target.close();
  return feedStallMs;
}

async function oneShotDecode(bytes, format = "rgba8") {
  const decoder = createDecoder({
    format,
    region: null,
    downsample: 1,
    progressionTarget: "final",
    emitEveryPass: false,
    progressiveDetail: PROGRESSIVE_DETAIL,
    preserveIcc: false,
    preserveMetadata: false,
  });
  const start = performance.now();
  let finalMs = null;
  const evTask = (async () => {
    for await (const ev of decoder.events()) {
      if (ev.type === "final") finalMs = performance.now() - start;
      else if (ev.type === "error") throw new Error(`${ev.code}: ${ev.message}`);
    }
  })();
  try {
    // P-3: bytes.slice().buffer to avoid poisoning
    await decoder.push(bytes.slice().buffer);
    await decoder.close();
    await evTask;
  } finally {
    await decoder.dispose();
  }
  return finalMs;
}

async function workerProgressiveDecode(bytes, ctx, format = "rgba8") {
  const t0 = performance.now(); // P-8: Record t0 before ctx.decode()
  const session = ctx.decode({
    format,
    region: null,
    downsample: 1,
    progressionTarget: "final",
    emitEveryPass: true,
    progressiveDetail: PROGRESSIVE_DETAIL,
    preserveIcc: false,
    preserveMetadata: false,
    priority: "visible",
  });

  const feedState = {
    bytesFed: 0,
    totalBytes: bytes.byteLength,
    passCount: 0,
    startTime: t0,
    pushStartMs: null,
    sessionToFirstFrameMs: null,
    pushToFirstFrameMs: null,
  };
  const passes = [];

  const frameTask = (async () => {
    for await (const frame of session.frames()) {
      const t = performance.now() - t0;
      const prev = passes.at(-1);
      passes.push({
        index: passes.length + 1,
        t_ms: Number(t.toFixed(1)),
        deltaMs: Number((prev ? t - prev.t_ms : t).toFixed(1)),
        bytesFed: feedState.bytesFed,
        isFinal: frame.stage === "final" || frame.isFinal === true,
      });
      feedState.passCount = passes.length;

      // P-8: Record cold-start split
      if (passes.length === 1) {
        feedState.sessionToFirstFrameMs = t;
        if (feedState.pushStartMs !== null) {
          feedState.pushToFirstFrameMs = t - feedState.pushStartMs;
        }
      }
    }
  })();

  let feedStallMs = 0;
  try {
    // P-4: Concurrent feed and frame tasks with Promise.allSettled
    const feedTask = feed32k(session, bytes, feedState);
    const results = await Promise.allSettled([feedTask, frameTask]);
    await session.done();
    const failure = results.find((r) => r.status === "rejected");
    if (failure) throw failure.reason;

    if (results[0].status === "fulfilled") {
      feedStallMs = results[0].value;
    }
  } finally {
    await session.close().catch(() => {});
  }

  const totalMs = performance.now() - t0;
  const finalMs = passes.find((p) => p.isFinal)?.t_ms ?? passes.at(-1)?.t_ms ?? null;

  const perPass = passes.map((p) => p.deltaMs);
  const sorted = [...perPass].sort((a, b) => a - b);
  // P-9: Stats in one pass
  const stats = computeSortedStats(sorted);

  // P-5: Richer pass stats
  const hitchCount = perPass.filter((d) => d > 2 * stats.median).length;
  const passesUnder33msPct = perPass.length
    ? Number(((perPass.filter((d) => d <= 33).length / perPass.length) * 100).toFixed(1))
    : 0;

  return {
    passes,
    totalMs: Number(totalMs.toFixed(1)),
    finalMs,
    passCount: passes.length,
    firstPassMs: passes[0] ? passes[0].t_ms : null,
    medianMs: Number(stats.median.toFixed(1)),
    p95Ms: Number(stats.p95.toFixed(1)),
    hitchCount,
    passesUnder33msPct,
    feedStallMs: Number(feedStallMs.toFixed(1)),
    sessionToFirstFrameMs: feedState.sessionToFirstFrameMs ? Number(feedState.sessionToFirstFrameMs.toFixed(1)) : null,
    pushToFirstFrameMs: feedState.pushToFirstFrameMs ? Number(feedState.pushToFirstFrameMs.toFixed(1)) : null,
    spawnInclusive: true, // P-8
  };
}

async function runWorkerSample(bytes, tier, format, concurrency) {
  const workerUrl = new URL("../packages/jxl-worker-browser/dist/worker.js", import.meta.url);
  workerUrl.searchParams.set("jxlWorkerTier", tier);

  const ctx = createBrowserContext({
    pushHwm: 64,
    poolSize: concurrency,
    wasmUrl: workerUrl.href,
  });

  let results;
  let effectiveTier = "none";
  let memAfterWorker = null;
  let memAfterDispose = null;

  try {
    const promises = [];
    for (let i = 0; i < concurrency; i++) {
      promises.push(workerProgressiveDecode(bytes, ctx, format));
    }
    results = await Promise.all(promises);

    // P-1: effectiveTier is ctx.capabilities().selectedWasmBuild after decode is done
    effectiveTier = ctx.capabilities().selectedWasmBuild || "none";
    memAfterWorker = getHeapSize();
  } finally {
    await ctx.shutdown().catch(() => {});
    memAfterDispose = getHeapSize();
  }

  // Aggregate results (P-6)
  const maxTotalMs = Math.max(...results.map((r) => r.totalMs));
  const throughput = ((bytes.byteLength * concurrency) / 1024 / 1024) / (maxTotalMs / 1000);

  const firstPassMs = results.map((r) => r.firstPassMs).filter((x) => x !== null);
  const finalMs = results.map((r) => r.finalMs).filter((x) => x !== null);
  const passCount = results.map((r) => r.passCount);
  const feedStallMs = results.map((r) => r.feedStallMs);
  const sessionToFirstFrameMs = results.map((r) => r.sessionToFirstFrameMs).filter((x) => x !== null);
  const pushToFirstFrameMs = results.map((r) => r.pushToFirstFrameMs).filter((x) => x !== null);
  const medianMs = results.map((r) => r.medianMs);
  const p95Ms = results.map((r) => r.p95Ms);
  const hitchCount = results.map((r) => r.hitchCount);
  const passesUnder33msPct = results.map((r) => r.passesUnder33msPct);

  const sortedDeltas = results[0].passes.map((p) => p.deltaMs).sort((a, b) => a - b);
  const stats = computeSortedStats(sortedDeltas);

  return {
    passes: results[0].passes,
    totalMs: Number(maxTotalMs.toFixed(1)),
    throughput: Number(throughput.toFixed(2)),
    firstPassMs: firstPassMs.length ? Number(median(firstPassMs).toFixed(1)) : null,
    finalMs: finalMs.length ? Number(median(finalMs).toFixed(1)) : null,
    passCount: Number(median(passCount).toFixed(1)),
    feedStallMs: Number(median(feedStallMs).toFixed(1)),
    sessionToFirstFrameMs: sessionToFirstFrameMs.length ? Number(median(sessionToFirstFrameMs).toFixed(1)) : null,
    pushToFirstFrameMs: pushToFirstFrameMs.length ? Number(median(pushToFirstFrameMs).toFixed(1)) : null,
    medianMs: Number(median(medianMs).toFixed(1)),
    p95Ms: Number(median(p95Ms).toFixed(1)),
    hitchCount: Number(median(hitchCount).toFixed(1)),
    passesUnder33msPct: Number(median(passesUnder33msPct).toFixed(1)),
    perPassMaxMs: stats.max,
    perPassMinMs: stats.min,
    spawnInclusive: true,
    effectiveTier,
    memAfterWorker,
    memAfterDispose,
  };
}

// P-10: Re-entrancy guard
let running = false;

window.runProbe = async ({
  jxlUrl,
  tier,
  iterations = 1,
  warmup = false,
  order = "oneshot-first",
  format = "rgba8",
  concurrency = 1,
}) => {
  if (running) throw new Error("already running");
  running = true;

  try {
    const memBeforeFetch = getHeapSize();

    const resp = await fetch(jxlUrl);
    if (!resp.ok) throw new Error(`fetch ${jxlUrl}: ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());

    // P-2: Implement warmup
    if (warmup) {
      try {
        await oneShotDecode(bytes, format);
      } catch (e) {
        // absorb
      }
      try {
        await runWorkerSample(bytes, tier, format, concurrency);
      } catch (e) {
        // absorb
      }
    }

    const samples = [];

    // P-2: Implement iterations & order
    if (order === "oneshot-first") {
      const oneShotResults = [];
      for (let i = 0; i < iterations; i++) {
        const oneShotMs = Number((await oneShotDecode(bytes, format)).toFixed(1));
        const memAfterOneShot = getHeapSize();
        oneShotResults.push({ oneShotMs, memAfterOneShot });
      }

      for (let i = 0; i < iterations; i++) {
        const workerRes = await runWorkerSample(bytes, tier, format, concurrency);
        samples.push({
          oneShotMs: oneShotResults[i].oneShotMs,
          memAfterOneShot: oneShotResults[i].memAfterOneShot,
          ...workerRes,
        });
      }
    } else {
      // "interleaved" or any other value
      for (let i = 0; i < iterations; i++) {
        const oneShotMs = Number((await oneShotDecode(bytes, format)).toFixed(1));
        const memAfterOneShot = getHeapSize();
        const workerRes = await runWorkerSample(bytes, tier, format, concurrency);
        samples.push({
          oneShotMs,
          memAfterOneShot,
          ...workerRes,
        });
      }
    }

    // P-2: Aggregate properties computing the medians over all iterations
    const medianOneShotMs = Number(median(samples.map((s) => s.oneShotMs)).toFixed(1));
    const validFirstPass = samples.map((s) => s.firstPassMs).filter((x) => x !== null);
    const medianFirstPassMs = validFirstPass.length ? Number(median(validFirstPass).toFixed(1)) : null;
    const validFinal = samples.map((s) => s.finalMs).filter((x) => x !== null);
    const medianFinalMs = validFinal.length ? Number(median(validFinal).toFixed(1)) : null;
    const medianTotalMs = Number(median(samples.map((s) => s.totalMs)).toFixed(1));
    const medianPassCount = Number(median(samples.map((s) => s.passCount)).toFixed(1));
    const medianFeedStallMs = Number(median(samples.map((s) => s.feedStallMs)).toFixed(1));
    const validSessionToFirst = samples.map((s) => s.sessionToFirstFrameMs).filter((x) => x !== null);
    const medianSessionToFirstFrameMs = validSessionToFirst.length
      ? Number(median(validSessionToFirst).toFixed(1))
      : null;
    const validPushToFirst = samples.map((s) => s.pushToFirstFrameMs).filter((x) => x !== null);
    const medianPushToFirstFrameMs = validPushToFirst.length ? Number(median(validPushToFirst).toFixed(1)) : null;
    const medianMedianMs = Number(median(samples.map((s) => s.medianMs)).toFixed(1));
    const medianP95Ms = Number(median(samples.map((s) => s.p95Ms)).toFixed(1));
    const medianHitchCount = Number(median(samples.map((s) => s.hitchCount)).toFixed(1));
    const medianPassesUnder33msPct = Number(median(samples.map((s) => s.passesUnder33msPct)).toFixed(1));
    const validThroughput = samples.map((s) => s.throughput).filter((x) => x !== undefined && x !== null);
    const medianThroughput = validThroughput.length ? Number(median(validThroughput).toFixed(2)) : null;

    const lastSample = samples[samples.length - 1];

    // P-1: Environment variables & metadata
    return {
      tier,
      requestedTier: tier,
      effectiveTier: lastSample.effectiveTier,
      crossOriginIsolated: typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : false,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory ?? null,
      userAgent: navigator.userAgent,
      schemaVersion: 1,

      encodedBytes: bytes.byteLength,
      oneShotMs: medianOneShotMs,
      firstPassMs: medianFirstPassMs,
      passCount: medianPassCount,
      finalMs: medianFinalMs,
      totalMs: medianTotalMs,
      feedStallMs: medianFeedStallMs,
      sessionToFirstFrameMs: medianSessionToFirstFrameMs,
      pushToFirstFrameMs: medianPushToFirstFrameMs,
      perPassMeanMs: medianMedianMs, // keep field name consistent with dashboard expectation if any
      perPassMedianMs: medianMedianMs,
      perPassP95Ms: medianP95Ms,
      hitchCount: medianHitchCount,
      passesUnder33msPct: medianPassesUnder33msPct,
      throughput: medianThroughput,

      perPassMaxMs: lastSample.perPassMaxMs,
      perPassMinMs: lastSample.perPassMinMs,
      passes: lastSample.passes,

      samples,
      // P-7: memory sampling
      memory: {
        beforeFetch: memBeforeFetch,
        afterOneShot: lastSample.memAfterOneShot,
        afterWorker: lastSample.memAfterWorker,
        afterDispose: lastSample.memAfterDispose,
      },
    };
  } finally {
    running = false;
  }
};

document.getElementById("status").textContent = "progressive-worker-probe loaded";
