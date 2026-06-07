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

async function feed32k(target, bytes, feedState) {
  let offset = 0;
  let rampIdx = 0;
  while (offset < bytes.byteLength) {
    let chunkBytes;
    if ((feedState.passCount ?? 0) > 0) {
      chunkBytes = STEADY_DECODE_CHUNK_BYTES;
    } else {
      chunkBytes = FIRST_PAINT_CHUNK_RAMP[Math.min(rampIdx, FIRST_PAINT_CHUNK_RAMP.length - 1)];
      rampIdx++;
    }
    const end = Math.min(bytes.byteLength, offset + chunkBytes);
    await target.push(exactBuffer(bytes.subarray(offset, end)));
    offset = end;
    feedState.bytesFed = offset;
    if (offset < bytes.byteLength) await sleep(0);
  }
  await target.close();
}

async function oneShotDecode(bytes) {
  const decoder = createDecoder({
    format: "rgba8",
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
    await decoder.push(exactBuffer(bytes));
    await decoder.close();
    await evTask;
  } finally {
    await decoder.dispose();
  }
  return finalMs;
}

async function workerProgressiveDecode(bytes, tier) {
  const workerUrl = new URL("../packages/jxl-worker-browser/dist/worker.js", import.meta.url);
  workerUrl.searchParams.set("jxlWorkerTier", tier);
  const ctx = createBrowserContext({ pushHwm: 64, poolSize: 1, wasmUrl: workerUrl.href });

  const session = ctx.decode({
    format: "rgba8",
    region: null,
    downsample: 1,
    progressionTarget: "final",
    emitEveryPass: true,
    progressiveDetail: PROGRESSIVE_DETAIL,
    preserveIcc: false,
    preserveMetadata: false,
    priority: "visible",
  });

  const feedState = { bytesFed: 0, totalBytes: bytes.byteLength, passCount: 0 };
  const passes = [];
  const start = performance.now();

  const frameTask = (async () => {
    for await (const frame of session.frames()) {
      const t = performance.now() - start;
      const prev = passes.at(-1);
      passes.push({
        index: passes.length + 1,
        t_ms: Number(t.toFixed(1)),
        deltaMs: Number((prev ? t - prev.t_ms : t).toFixed(1)),
        bytesFed: feedState.bytesFed,
        isFinal: frame.stage === "final" || frame.isFinal === true,
      });
      feedState.passCount = passes.length;
    }
  })();

  try {
    await feed32k(session, bytes, feedState);
    await frameTask;
    await session.done();
  } finally {
    await session.close().catch(() => {});
    await ctx.dispose?.().catch?.(() => {});
  }

  const totalMs = performance.now() - start;
  const finalMs = passes.find((p) => p.isFinal)?.t_ms ?? passes.at(-1)?.t_ms ?? null;
  return { passes, totalMs: Number(totalMs.toFixed(1)), finalMs, passCount: passes.length };
}

window.runProbe = async ({ jxlUrl, tier }) => {
  const resp = await fetch(jxlUrl);
  if (!resp.ok) throw new Error(`fetch ${jxlUrl}: ${resp.status}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());

  const oneShotMs = Number((await oneShotDecode(bytes)).toFixed(1));
  const worker = await workerProgressiveDecode(bytes, tier);

  const perPass = worker.passes.map((p) => p.deltaMs);
  const sorted = [...perPass].sort((a, b) => a - b);
  return {
    tier,
    encodedBytes: bytes.byteLength,
    oneShotMs,
    passCount: worker.passCount,
    finalMs: worker.finalMs,
    totalMs: worker.totalMs,
    perPassMeanMs: perPass.length ? Number((perPass.reduce((a, b) => a + b, 0) / perPass.length).toFixed(1)) : 0,
    perPassMaxMs: sorted.length ? sorted[sorted.length - 1] : 0,
    perPassMinMs: sorted.length ? sorted[0] : 0,
    passes: worker.passes,
  };
};

document.getElementById("status").textContent = "progressive-worker-probe loaded";
