import initRaw, { process_orf, rgb_to_rgba, downscale_rgb } from './pkg/raw_converter_wasm.js';
import { createDecoder, createEncoder } from '@casabio/jxl-wasm';
import { buildByteCutoffPlan, formatByteCutoffLabel } from './jxl-byte-cutoff-probe.js';
import { createProgressiveWebPreset, createSidecarTargetPlan } from './jxl-progressive-best-preset.js';
import { classifyByteCutoffFrame, summarizeByteCutoffResults, buildSeries } from './jxl-progressive-byte-metrics.js';  // R1 for buildSeries wire (connectedness)
import {
  buildBenchmarkExport,
  streamDecodeCutoffs as streamDecodeCutoffsCore,
} from './jxl-progressive-byte-benchmark-core.js';

const runBtn = document.getElementById('run-byte-benchmark');
const exportBtn = document.getElementById('export-json');
const statusEl = document.getElementById('bytebench-status');
const resultsEl = document.getElementById('bytebench-results');
const lightbox = document.getElementById('progressive-lightbox');
const lightboxTitle = document.getElementById('lightbox-title');
const lightboxCanvas = document.getElementById('lightbox-canvas');
const lightboxClose = document.getElementById('lightbox-close');

const state = {
  rawReady: false,
  running: false,
  results: [],
};

initRaw().then(() => {
  state.rawReady = true;
  setStatus('Ready. Gobabeb endpoint and RAW WASM are available.');
}).catch((error) => {
  setStatus(`RAW WASM failed: ${error?.message ?? error}`);
});

runBtn?.addEventListener('click', () => {
  void runBenchmark();
});

exportBtn?.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(buildBenchmarkExport(state.results), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `progressive-byte-benchmark-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

lightboxClose?.addEventListener('click', closeLightbox);
lightbox?.addEventListener('click', (event) => {
  if (event.target === lightbox) closeLightbox();
});

async function runBenchmark() {
  if (state.running) return;
  if (!state.rawReady) {
    setStatus('Waiting for RAW WASM.');
    return;
  }

  state.running = true;
  state.results = [];
  resultsEl.innerHTML = '';
  exportBtn.disabled = true;
  runBtn.disabled = true;

  const runCount = clampInt(inputValue('run-count', 3), 1, 12);
  const targetLongEdge = document.getElementById('target-long-edge')?.value ?? '800';
  const quality = clampInt(inputValue('quality', 85), 1, 100);
  const progressiveDetail = document.getElementById('progressive-detail')?.value ?? 'passes';
  const transportProfile = document.getElementById('transport-profile')?.value ?? 'lte';
  const ssimulacra2Value = document.getElementById('ssimulacra2-target')?.value;
  const ssimulacra2Target = ssimulacra2Value === '' ? null : Number(ssimulacra2Value);

  try {
    for (let i = 0; i < runCount; i++) {
      setStatus(`Loading Gobabeb ORF ${i + 1}/${runCount}...`);
      const source = await loadGobabebSource();
      const card = createResultCard(source, i + 1);
      resultsEl.append(card.el);

      const variantTargets = createSidecarTargetPlan(targetLongEdge === 'full' ? 'full' : Number(targetLongEdge));
      const variants = [];
      for (const variantTarget of variantTargets) {
        const isSidecar = variantTargets.length > 1 && variantTarget !== variantTargets.at(-1);
        const label = isSidecar ? `sidecar ${variantTarget}` : `target ${variantTarget}`;
        const preset = createProgressiveWebPreset({
          width: source.width,
          height: source.height,
          targetLongEdge: variantTarget,
          quality,
          ssimulacra2Target,
          progressiveDetail,
        });

        setStatus(`Preparing ${source.name} ${label} at ${preset.target.width}x${preset.target.height}...`);
        const targetRgba = makeTargetRgba(source, preset.target.width, preset.target.height);

        setStatus(`Encoding ${source.name} ${label} with progressive web preset...`);
        const encodeStart = performance.now();
        const jxlBytes = await encodeTarget(targetRgba, preset.encode);
        const encodeMs = performance.now() - encodeStart;

        card.meta.textContent = `${source.name} | ${fmtBytes(source.rawBytes)} raw | latest ${label}: ${preset.target.width}x${preset.target.height} | ${fmtBytes(jxlBytes.byteLength)} JXL`;
        card.policy.textContent = preset.qualityPolicy.ssimulacra2.message;
        renderVariantHeading(card.ladder, `${label} | ${preset.target.width}x${preset.target.height} | ${fmtBytes(jxlBytes.byteLength)} | encode ${encodeMs.toFixed(0)} ms`);

        const plan = buildByteCutoffPlan(jxlBytes.byteLength, preset.byteCutoffs);
        const streamed = await streamDecodeCutoffs(jxlBytes, plan, preset.decode, (entry) => {
          setStatus(`${source.name} ${label}: streaming through ${formatByteCutoffLabel(entry)}...`);
        }, { transportProfile, selfStability: true });  // expose for byte runs (R1 self-stability)
        // R1 wire buildSeries (connectedness from byte-metrics)
        const cutoffPixels = [];
        const byteSizes = [];
        for (const cutoff of streamed.cutoffs) {
          if (cutoff.frame && cutoff.frame.pixels) {
            const p = cutoff.frame.pixels instanceof Uint8Array ? cutoff.frame.pixels : new Uint8Array(cutoff.frame.pixels);
            cutoffPixels.push(p);
            byteSizes.push(cutoff.bytes);
          }
        }
        const builtSeries = (cutoffPixels.length > 0 && typeof buildSeries === 'function') ? buildSeries(targetRgba, cutoffPixels, byteSizes, preset.target.width, preset.target.height) : null;
        const cutoffResults = streamed.cutoffs.map((cutoff) => classifyByteCutoffFrame(cutoff));
        const frag = document.createDocumentFragment();
        for (const cutoff of streamed.cutoffs) {
          renderCutoffTile(frag, `${source.name} | ${label}`, cutoff.entry, cutoff);
        }
        card.ladder.appendChild(frag);
        await nextPaint();

        const summary = summarizeByteCutoffResults(cutoffResults, jxlBytes.byteLength);
        variants.push({
          label,
          sidecar: isSidecar,
          target: preset.target,
          encode: preset.encode,
          encodeMs,
          jxlBytes: jxlBytes.byteLength,
          transportProfile: streamed.transportProfile,
          firstPaintMs: streamed.firstPaintMs,
          previewMs: streamed.previewMs,
          finalMs: streamed.finalMs,
          stallCount: streamed.stallCount,
          avgPaintGapMs: streamed.avgPaintGapMs,
          summary,
          cutoffs: cutoffResults,
          builtSeries,  // R1
        });
      }
      const targetVariant = variants.at(-1);
      const firstVisible = variants.find((variant) => variant.summary.firstPaintBytes != null) ?? targetVariant;
      const sidecarFirst = variants.find((variant) => variant.sidecar && variant.summary.firstPaintBytes != null) ?? null;
      const record = {
        source: source.name,
        rawBytes: source.rawBytes,
        transportProfile,
        variants,
        target: targetVariant?.target ?? null,
        summary: targetVariant?.summary ?? null,
        targetUsefulEarlyPaint: targetVariant?.summary.usefulEarlyPaint ?? false,
        sidecarFirstVisibleBytes: sidecarFirst?.summary.firstPaintBytes ?? null,
        firstVisibleBytes: firstVisible?.summary.firstPaintBytes ?? null,
        ssimulacra2: resolveRecordSsimulacra2(variants, ssimulacra2Target),
      };
      state.results.push(record);
      renderSummaryTable(card.table, record);
      updateStats();
    }
    setStatus(`Finished ${state.results.length} Gobabeb progressive byte runs.`);
    exportBtn.disabled = state.results.length === 0;
  } catch (error) {
    setStatus(`Benchmark failed: ${error?.message ?? error}`);
  } finally {
    state.running = false;
    runBtn.disabled = false;
  }
}

async function loadGobabebSource() {
  const response = await fetch('/api/random-gobabeb', { cache: 'no-store' });
  if (!response.ok) throw new Error(`/api/random-gobabeb returned ${response.status}`);
  const raw = new Uint8Array(await response.arrayBuffer());
  const name = response.headers.get('x-file-name') ?? 'Gobabeb ORF';
  const result = process_orf(raw, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
  try {
    const rgb = result.take_rgb();
    const rgba = rgb_to_rgba(rgb);
    return {
      name,
      rawBytes: raw.byteLength,
      width: result.width,
      height: result.height,
      rgb,
      rgba,
    };
  } finally {
    result.free();
  }
}

function makeTargetRgba(source, width, height) {
  if (source.width === width && source.height === height) return exactBuffer(source.rgba);
  const rgb = downscale_rgb(source.rgb, source.width, source.height, width, height);
  return exactBuffer(rgb_to_rgba(rgb));
}

async function encodeTarget(rgba, encodeOptions) {
  const encoder = createEncoder(encodeOptions);
  const chunks = [];
  const chunkTask = (async () => {
    for await (const chunk of encoder.chunks()) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
  })();
  await encoder.pushPixels(exactBuffer(rgba));
  await encoder.finish();
  await chunkTask;
  await encoder.dispose();
  return concatChunks(chunks);
}

async function streamDecodeCutoffs(jxlBytes, plan, decodeOptions, onStep = () => {}, context = {}) {
  return streamDecodeCutoffsCore(jxlBytes, plan, decodeOptions, onStep, context);
}

function createResultCard(source, index) {
  const el = document.createElement('article');
  el.className = 'bytebench-card';
  const header = document.createElement('header');
  const titleWrap = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = `Run ${index}`;
  const meta = document.createElement('p');
  meta.textContent = `${source.name} | ${source.width}x${source.height}`;
  const policy = document.createElement('p');
  policy.textContent = '';
  titleWrap.append(title, meta, policy);
  header.append(titleWrap);

  const ladder = document.createElement('div');
  ladder.className = 'bytebench-ladder';
  const table = document.createElement('div');
  el.append(header, ladder, table);
  return { el, meta, policy, ladder, table };
}

function renderCutoffTile(parent, sourceName, entry, decoded) {
  const tile = document.createElement('button');
  tile.className = `bytebench-tile${decoded.frame ? '' : ' is-empty'}`;
  tile.type = 'button';

  if (decoded.frame) {
    const canvas = frameToCanvas(decoded.frame);
    const meta = document.createElement('div');
    meta.className = 'bytebench-tile-meta';
    meta.textContent = `${formatByteCutoffLabel(entry)} | ${decoded.frame.type}`;
    tile.append(canvas, meta);
    tile.addEventListener('click', () => openLightbox(`${sourceName} | ${formatByteCutoffLabel(entry)} | ${decoded.frame.type}`, canvas));
  } else {
    const meta = document.createElement('div');
    meta.className = 'bytebench-tile-meta';
    meta.textContent = `${formatByteCutoffLabel(entry)} | no paint${decoded.error ? ` | ${decoded.error}` : ''}`;
    tile.append(meta);
  }

  parent.appendChild(tile);
}

function renderVariantHeading(container, text) {
  const heading = document.createElement('div');
  heading.className = 'bytebench-tile-meta';
  heading.style.gridColumn = '1 / -1';
  heading.textContent = text;
  container.append(heading);
}

function renderSummaryTable(container, record) {
  const rows = record.variants.map((variant) => `
    <tr>
      <td>${variant.label}</td>
      <td>${fmtMaybeBytes(variant.summary.firstPaintBytes)} (${fmtMaybePercent(variant.summary.firstPaintPercent)})</td>
      <td>${fmtMaybeBytes(variant.summary.firstPerceptuallyGoodBytes)} (${fmtMaybePercent(variant.summary.firstPerceptuallyGoodPercent)})</td>
      <td>${fmtMaybeBytes(variant.summary.previewBytes)} (${fmtMaybePercent(variant.summary.previewPercent)})</td>
      <td>${fmtMaybeBytes(variant.summary.finalBytes)} (${fmtMaybePercent(variant.summary.finalPercent)})</td>
      <td>${variant.summary.usefulEarlyPaint ? 'yes' : 'no'}</td>
      <td>${variant.summary.butterMonotone ? 'yes' : 'no'}</td>
      <td>${variant.summary.paintedCutoffs}</td>
      <td>${variant.summary.maxFrameCount}</td>
    </tr>
  `).join('');
  container.innerHTML = `
    <table class="bytebench-table">
      <thead>
        <tr><th>Variant</th><th>First paint</th><th>Percept. good (R1)</th><th>Preview</th><th>Final</th><th>Early?</th><th>Butter monotone</th><th>Painted cutoffs</th><th>Frames</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function updateStats() {
  document.getElementById('stat-files').textContent = String(state.results.length);
  document.getElementById('stat-first').textContent = fmtMaybeBytes(median(state.results.map((r) => r.firstVisibleBytes).filter(Number.isFinite)));
  document.getElementById('stat-preview').textContent = fmtMaybeBytes(median(state.results.map((r) => r.summary?.previewBytes).filter(Number.isFinite)));
  document.getElementById('stat-final').textContent = fmtMaybeBytes(median(state.results.map((r) => r.summary?.finalBytes).filter(Number.isFinite)));
  const requested = state.results.some((r) => r.ssimulacra2.requested);
  document.getElementById('stat-ssimulacra2').textContent = requested ? 'unavailable' : 'not requested';
}

function resolveRecordSsimulacra2(_variants, requestedTarget) {
  const requested = Number.isFinite(Number(requestedTarget));
  return {
    requested,
    available: false,
    target: requested ? Number(requestedTarget) : null,
  };
}

function openLightbox(title, sourceCanvas) {
  lightboxTitle.textContent = title;
  lightboxCanvas.width = sourceCanvas.width;
  lightboxCanvas.height = sourceCanvas.height;
  const ctx = lightboxCanvas.getContext('2d');
  ctx.clearRect(0, 0, lightboxCanvas.width, lightboxCanvas.height);
  ctx.drawImage(sourceCanvas, 0, 0);
  lightbox.hidden = false;
}

function closeLightbox() {
  lightbox.hidden = true;
}

function frameToCanvas(frame) {
  const info = frame.info ?? {};
  const width = info.width ?? frame.width ?? frame.w;
  const height = info.height ?? frame.height ?? frame.h;
  const pixels = toUint8Array(frame.pixels ?? frame.rgba);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height), 0, 0);
  return canvas;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function inputValue(id, fallback) {
  const value = Number(document.getElementById(id)?.value);
  return Number.isFinite(value) ? value : fallback;
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

function concatChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '--';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function fmtMaybeBytes(value) {
  return Number.isFinite(value) ? fmtBytes(value) : '--';
}

function fmtMaybePercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : '--';
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

