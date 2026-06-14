#!/usr/bin/env node
/** Count progressive events: lastPasses vs passes, single push vs chunked feed. */
import { createDecoder, createEncoder, setJxlModuleFactoryForTesting } from '../packages/jxl-wasm/dist/index.js';

async function loadModule() {
  const m = await import('../packages/jxl-wasm/dist/jxl-core.scalar.js');
  return m.default();
}

function makeNoise(w, h) {
  const out = new Uint8Array(w * h * 4);
  let s = 0x9e3779b9 >>> 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      s = (s * 1664525 + 1013904223) >>> 0;
      const n = (s >>> 24) & 0xff;
      out[i] = (x * 3 + n) & 0xff;
      out[i + 1] = (y * 5 + (n >>> 1)) & 0xff;
      out[i + 2] = ((x ^ y) * 7 + (n >>> 2)) & 0xff;
      out[i + 3] = 0xff;
    }
  }
  return out;
}

async function encodeSneyers(w, h) {
  const enc = createEncoder({
    format: 'rgba8', width: w, height: h, hasAlpha: true,
    quality: 85, effort: 3, progressive: true, progressiveFlavor: 'ac',
    progressiveDc: 2, progressiveAc: 1, qProgressiveAc: 1, groupOrder: 1, chunked: false,
  });
  enc.pushPixels(makeNoise(w, h));
  enc.finish();
  const chunks = [];
  for await (const c of enc.chunks()) chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c));
  await enc.dispose();
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

async function countEvents(jxl, opts, feed) {
  const dec = createDecoder({ format: 'rgba8', region: null, downsample: 1, progressionTarget: 'final', preserveIcc: false, preserveMetadata: false, ...opts });
  let progress = 0, final = 0;
  const task = (async () => {
    for await (const ev of dec.events()) {
      if (ev.type === 'progress') progress++;
      if (ev.type === 'final') final++;
    }
  })();
  await feed(dec, jxl);
  await task;
  await dec.dispose();
  return { progress, final, total: progress + final };
}

async function main() {
  setJxlModuleFactoryForTesting(loadModule);
  const sizes = [[1024, 768], [2560, 1920]];
  for (const [w, h] of sizes) {
  await runSize(w, h);
  }
}

async function runSize(w, h) {
  console.log(`Encoding ${w}x${h} Sneyers...`);
  const jxl = await encodeSneyers(w, h);
  console.log(`JXL size: ${(jxl.byteLength / 1024).toFixed(1)} KB\n`);

  const configs = [
    { label: 'lastPasses emitEveryPass=false single-push', opts: { progressiveDetail: 'lastPasses', emitEveryPass: false },
      feed: async (d, b) => { d.push(b); d.close(); } },
    { label: 'lastPasses emitEveryPass=true single-push', opts: { progressiveDetail: 'lastPasses', emitEveryPass: true },
      feed: async (d, b) => { d.push(b); d.close(); } },
    { label: 'passes emitEveryPass=true single-push', opts: { progressiveDetail: 'passes', emitEveryPass: true },
      feed: async (d, b) => { d.push(b); d.close(); } },
    { label: 'lastPasses emitEveryPass=false chunked 32KB', opts: { progressiveDetail: 'lastPasses', emitEveryPass: false },
      feed: async (d, b) => { for (let o = 0; o < b.byteLength; o += 32 * 1024) { d.push(b.subarray(o, Math.min(b.byteLength, o + 32 * 1024))); await new Promise(r => setTimeout(r, 0)); } d.close(); } },
  ];

  for (const c of configs) {
    const r = await countEvents(jxl, c.opts, c.feed);
    console.log(`${c.label}: progress=${r.progress} final=${r.final} total=${r.total}`);
  }
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });