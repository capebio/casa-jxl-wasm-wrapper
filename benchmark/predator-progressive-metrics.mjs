#!/usr/bin/env node
/**
 * predator-progressive-metrics.mjs
 *
 * Focused measurement run for the predator progressive campaign (Dc + groupOrder).
 * Runs a small cartesian matrix on the reference small image (or synthetic),
 * performs encode with progressiveDc/groupOrder, then progressive decode collection
 * (mimics the correlation worker decode-side logic we added for layer metrics).
 *
 * Produces JSON + CSV + console table with:
 *   - encodeMs, bytes
 *   - progressEvents (count of progress+final from 'passes' decode)
 *   - firstProgressBytes (codestream bytes fed to first progress event via natural chunks)
 *   - firstProgressMs (decode time to first progress)
 *   - minBytesToFirstProgress (from % prefix probe — the real early bytes headroom)
 *
 * Usage (from repo root):
 *   node benchmark/predator-progressive-metrics.mjs --image "c:\Foo\raw-converter\tests\small_file.jpg"
 *   node benchmark/predator-progressive-metrics.mjs --synthetic
 *
 * Outputs land in docs/outputs/reference-small/predator-progressive-*.json|csv
 * Then you can feed the numbers into HANDOFF / suggested-settings / boundary-cost-audit.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { createEncoder, createDecoder, setForcedTier, detectTier } from '../packages/jxl-wasm/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const args = parseArgs(process.argv.slice(2));
const USE_SYNTHETIC = !!args.synthetic;
let IMAGE_PATH = USE_SYNTHETIC ? null : resolve(args.image || 'c:\\Foo\\raw-converter\\tests\\small_file.jpg');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--image' || a === '-i') out.image = argv[++i];
    else if (a === '--synthetic') out.synthetic = true;
    else if (!a.startsWith('-')) out.image = a;
  }
  return out;
}

function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/**
 * Prefix-probe for true min-bytes-to-first-progress (headroom from 2026-06 ref run).
 * Concats chunks, then tries increasing % prefixes (fresh decoder each) until a
 * 'progress' or 'final' (beyond header) surfaces. Returns the cutoff bytes at first hit,
 * or total if none before end. This is independent of natural chunk boundaries and
 * gives the earliest codestream position where a layer becomes observable.
 * Complements (does not replace) the full-chunk collection for event count.
 */
async function probeMinBytesToFirstProgress(fullChunks, createDecoder) {
  // concat once
  let total = 0;
  const bufs = fullChunks.map(c => c instanceof Uint8Array ? c : new Uint8Array(c));
  for (const b of bufs) total += b.byteLength;
  if (total === 0) return { minBytes: 0, eventsSeen: 0 };
  const full = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) { full.set(b, off); off += b.byteLength; }

  const steps = 50; // 2% granularity; cheap for small refs
  let minBytes = total;
  let eventsSeen = 0;
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
            eventsSeen = Math.max(eventsSeen, 1); // at least one
          }
        }
      })();
      await decoder.push(exactBuffer(full.subarray(0, cut)));
      await decoder.close();
      await drainP;
      if (sawLayer) {
        minBytes = cut;
        break; // first hit; can early exit for min
      }
    } catch {}
  }
  return { minBytes, eventsSeen: eventsSeen || 0 };
}

async function loadRgba() {
  if (USE_SYNTHETIC || !IMAGE_PATH) {
    const W = 128, H = 128; // matches test noise size in original handoff
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = (x * 7 + y * 3) % 256;
        rgba[i + 1] = (x * 11 + y * 5) % 256;
        rgba[i + 2] = (x * 13 + y * 17) % 256;
        rgba[i + 3] = 255;
      }
    }
    console.log(`Using synthetic ${W}×${H} test pattern (noise-like)`);
    return { rgba, width: W, height: H };
  }
  try {
    const sharpOut = await sharp(IMAGE_PATH)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const meta = sharpOut.info;
    const rgba = new Uint8Array(sharpOut.data.buffer, sharpOut.data.byteOffset, sharpOut.data.byteLength);
    console.log(`Loaded ref: ${meta.width}×${meta.height}`);
    return { rgba, width: meta.width, height: meta.height };
  } catch (e) {
    console.error('Failed to load image:', IMAGE_PATH, e.message);
    console.error('Falling back to synthetic 128x128.');
    const W = 128, H = 128;
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      rgba[i] = (x * 7 + y * 3) % 256; rgba[i+1]=(x*11+y*5)%256; rgba[i+2]=(x*13+y*17)%256; rgba[i+3]=255;
    }
    return { rgba, width: W, height: H };
  }
}

async function measureCell(rgba, width, height, opts) {
  const t0 = performance.now();
  const encoder = createEncoder(opts);
  const chunks = [];
  const chunkTask = (async () => {
    for await (const ch of encoder.chunks()) {
      chunks.push(ch instanceof Uint8Array ? ch : new Uint8Array(ch));
    }
  })();
  await encoder.pushPixels(rgba);
  await encoder.finish();
  await chunkTask;
  const encodeMs = performance.now() - t0;
  const bytes = chunks.reduce((s, c) => s + (c.byteLength || 0), 0);
  await encoder.dispose?.();

  let progressEvents = 0;
  let firstProgressMs = null;
  let firstProgressBytes = null;

  if (opts.progressive) {
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
      const drain = (async () => {
        for await (const ev of decoder.events()) {
          if (ev.type === 'progress' || ev.type === 'final') {
            progressEvents++;
            if (firstProgressMs === null) {
              firstProgressMs = performance.now() - decStart;
              firstProgressBytes = fed;
            }
          }
        }
      })();
      for (const ch of chunks) {
        const len = ch.byteLength || ch.length || 0;
        fed += len;
        await decoder.push(exactBuffer(ch));
      }
      await decoder.close();
      await drain;
      if (firstProgressBytes === null) firstProgressBytes = bytes;
    } catch (e) {
      // leave metrics at 0/null
    }
  }

  // Prefix probe (new headroom from this handoff's observations): gives the earliest codestream
  // byte position at which a progress/final event can surface, using % prefixes (fresh decoders).
  // For the 2026-06 small ref this often yields << total where chunk-feed first==total.
  let minBytesToFirstProgress = bytes;
  if (opts.progressive && chunks.length > 0 && createDecoder) {
    try {
      const probe = await probeMinBytesToFirstProgress(chunks, createDecoder);
      if (probe.minBytes > 0 && probe.minBytes < minBytesToFirstProgress) minBytesToFirstProgress = probe.minBytes;
    } catch {}
  }

  return {
    encodeMs: Math.round(encodeMs * 10) / 10,
    bytes,
    progressEvents,
    firstProgressBytes,
    firstProgressMs: firstProgressMs != null ? Math.round(firstProgressMs * 10) / 10 : null,
    minBytesToFirstProgress,
  };
}

function makeTable(rows, keys) {
  const header = keys.join(' | ');
  const sep = keys.map(() => '---').join(' | ');
  const body = rows.map(r => keys.map(k => {
    const v = r[k];
    if (v == null) return '—';
    if (typeof v === 'number' && k.toLowerCase().includes('ms')) return v.toFixed(1);
    if (typeof v === 'number' && (k.toLowerCase().includes('byte') || k === 'bytes' || k === 'minBytesToFirstProgress')) return (v / 1024).toFixed(1) + 'k';
    return String(v);
  }).join(' | ')).join('\n');
  return [header, sep, body].join('\n');
}

async function main() {
  console.log('=== Predator Progressive Layer Metrics Measurement ===');
  // Force non-MT tier (plain Node/Bun has no Worker). 'simd' is safe single-threaded SIMD.
  // mt tiers require Web Worker polyfill which isn't present here.
  const current = detectTier ? detectTier() : 'unknown';
  console.log(`Current tier: ${current}; forcing 'simd' for Node/Bun compatibility (avoids Worker in mt builds)`);
  setForcedTier('simd');
  const { rgba, width, height } = await loadRgba();

  // Focused predator sweep: the core knobs that were missing before the campaign
  const base = {
    format: 'rgba8',
    width, height,
    hasAlpha: true,
    quality: 85,
    effort: 5,
    progressive: true,
    previewFirst: true, // predator rec for early recognizable (biases groupOrder too in some paths)
    resampling: 1,
  };

  const factors = {
    progressiveDc: [0, 1, 2],
    groupOrder: [0, 1],
    effort: [3, 5, 7], // a few effort points to see interaction
  };

  // cartesian
  const factorNames = Object.keys(factors);
  const combos = [];
  const counts = factorNames.map(n => factors[n].length);
  const idx = new Array(factorNames.length).fill(0);
  while (true) {
    const combo = {};
    for (let i = 0; i < factorNames.length; i++) combo[factorNames[i]] = factors[factorNames[i]][idx[i]];
    combos.push(combo);
    // increment
    let k = factorNames.length - 1;
    while (k >= 0) {
      idx[k]++;
      if (idx[k] < counts[k]) break;
      idx[k] = 0;
      k--;
    }
    if (k < 0) break;
  }

  console.log(`Sweep: ${combos.length} cells (progressiveDc × groupOrder × effort)`);
  console.log('Base: quality=85, progressive=true\n');

  const results = [];
  for (const c of combos) {
    const opts = { ...base, ...c };
    const m = await measureCell(rgba, width, height, opts);
    const row = {
      progressiveDc: c.progressiveDc,
      groupOrder: c.groupOrder,
      effort: c.effort,
      ...m,
      sizeKB: (m.bytes / 1024).toFixed(1),
    };
    results.push(row);
    console.log(
      `Dc=${c.progressiveDc} g=${c.groupOrder} e=${c.effort} | ` +
      `enc=${m.encodeMs}ms ${row.sizeKB}KB | ` +
      `events=${m.progressEvents} firstB=${m.firstProgressBytes ? (m.firstProgressBytes/1024).toFixed(1)+'k' : '—'} minB=${m.minBytesToFirstProgress ? (m.minBytesToFirstProgress/1024).toFixed(1)+'k' : '—'} firstMs=${m.firstProgressMs ?? '—'}`
    );
  }

  // Write artifacts
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = resolve(REPO_ROOT, 'docs/outputs/reference-small');
  mkdirSync(outDir, { recursive: true });

  const jsonPath = resolve(outDir, `predator-progressive-layers-${stamp}.json`);
  const csvPath = resolve(outDir, `predator-progressive-layers-${stamp}.csv`);

  const payload = {
    generatedAt: new Date().toISOString(),
    image: USE_SYNTHETIC ? 'synthetic-128' : IMAGE_PATH,
    width, height,
    base,
    factors,
    results,
  };
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

  // CSV
  const csvKeys = ['progressiveDc', 'groupOrder', 'effort', 'encodeMs', 'bytes', 'sizeKB', 'progressEvents', 'firstProgressBytes', 'firstProgressMs', 'minBytesToFirstProgress'];
  const csvRows = [
    csvKeys.join(','),
    ...results.map(r => csvKeys.map(k => JSON.stringify(r[k] ?? '')).join(','))
  ];
  writeFileSync(csvPath, csvRows.join('\n'));

  console.log(`\nWrote:\n  ${jsonPath}\n  ${csvPath}`);

  // Pretty table
  console.log('\n### Summary Table (Prog Events + first layer bytes + prefix-probe min bytes) ###\n');
  console.log(makeTable(results, ['progressiveDc', 'groupOrder', 'effort', 'encodeMs', 'sizeKB', 'progressEvents', 'firstProgressBytes', 'firstProgressMs', 'minBytesToFirstProgress']));

  // Quick insights
  const byDcGroup = {};
  for (const r of results) {
    const key = `Dc${r.progressiveDc}-g${r.groupOrder}`;
    if (!byDcGroup[key]) byDcGroup[key] = [];
    byDcGroup[key].push(r);
  }
  console.log('\n### By predator setting (median events) ###');
  for (const [k, arr] of Object.entries(byDcGroup)) {
    const meds = arr.map(x => x.progressEvents).filter(Boolean);
    const med = meds.length ? meds.reduce((a,b)=>a+b,0)/meds.length : 0;
    console.log(`${k}: median events=${med.toFixed(1)} (from ${arr.length} cells)`);
  }

  console.log('\nDone. Copy the numbers into the predator continuation handoff + suggested-settings.md + boundary-cost-audit.md');
}

main().catch(e => { console.error(e); process.exit(1); });