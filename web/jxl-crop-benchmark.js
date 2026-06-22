import initRaw, * as rawWasm from './pkg/raw_converter_wasm.js';
import {
    createDecoder,
    createEncoder,
} from '@casabio/jxl-wasm';
import { createFilePicker } from './jxl-file-picker.js';

// Lazy-load the advanced tiled/ROI exports (these are Phase 3 features that
// may not be present in every build of the jxl-wasm package).
let _tiledFns = null;

// Console page header — always shows which page this console belongs to (dev productivity across many open lab/benchmark tabs)
console.log('%c[Crop Benchmark] jxl-crop-benchmark.js loaded — tiled / JXTC region decode benchmark', 'color:#f59e0b;font-weight:600', { page: 'Crop Benchmark', url: location.href, t: new Date().toISOString(), ua: navigator.userAgent.slice(0, 120) });

async function getTiledFns() {
    if (_tiledFns) return _tiledFns;
    try {
        const mod = await import('@casabio/jxl-wasm');
        _tiledFns = {
            encodeTiledRgba8: mod.encodeTiledRgba8,
            decodeTiledRegionRgba8: mod.decodeTiledRegionRgba8,
            encodeTileContainerRgba8: mod.encodeTileContainerRgba8,
            decodeTileContainerRegionRgba8: mod.decodeTileContainerRegionRgba8,
        };
    } catch (e) {
        console.warn('[crop-benchmark] Failed to load tiled functions from jxl-wasm:', e);
        _tiledFns = {};
    }
    return _tiledFns;
}

// Log-scaled display width for each crop size (120px–400px range).
function logDisplayWidth(px) {
    const lo = Math.log2(128), hi = Math.log2(2048);
    const t = (Math.log2(px) - lo) / (hi - lo);
    return Math.round(120 + t * 280);
}

function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// --- State ---

let orfFiles   = [];
let wasmReady  = false;
let running    = false;
let abortController = null;
let lastCropRun = null;

// Lightweight collector for the new decode pixel handoff metrics from the Boundary Cost Audit instrumentation
const decodePixelMetrics = {
  decode_buffer_extract_ms: [],
  decode_region_downsample_ms: [],
  decode_toarraybuffer_ms: [],
};

function logDecodePixelMetric(name, value) {
  if (name in decodePixelMetrics) {
    decodePixelMetrics[name].push(value);
    // Log individual values for visibility during runs
    console.log(`[crop] ${name}=${value.toFixed(2)} ms`);
  }
}

function resetDecodePixelMetrics() {
  Object.keys(decodePixelMetrics).forEach(k => decodePixelMetrics[k] = []);
}

// Average the currently-accumulated decode pixel metrics into a plain snapshot
// object. Used to separate the tile-region and JXTC-region samples (which both
// log into the shared decodePixelMetrics arrays) so a snapshot does not blend
// two codecs under one "region" label.
function snapshotDecodePixelMetrics() {
  const avg = (vals) => vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  return {
    decode_buffer_extract_ms: avg(decodePixelMetrics.decode_buffer_extract_ms),
    decode_region_downsample_ms: avg(decodePixelMetrics.decode_region_downsample_ms),
    decode_toarraybuffer_ms: avg(decodePixelMetrics.decode_toarraybuffer_ms),
  };
}

function summarizeDecodePixelMetrics(label = '') {
  const summary = {};
  Object.keys(decodePixelMetrics).forEach(key => {
    const vals = decodePixelMetrics[key];
    if (vals.length > 0) {
      const sum = vals.reduce((a, b) => a + b, 0);
      summary[key] = {
        count: vals.length,
        avg: sum / vals.length,
        min: Math.min(...vals),
        max: Math.max(...vals),
        total: sum
      };
    }
  });
  if (Object.keys(summary).length > 0) {
    console.log(`[crop] Decode Pixel Handoff Metrics ${label}:`, summary);
  }
  return summary;
} // { timestamp, config: {effort, distance, tileSize, sizes, compareFull}, records: [{file, size, tileMs, jxtcMs?, fullMs?}] }

// --- DOM refs ---

const orfFileInput        = document.getElementById('orf-file-input');
const btnRun              = document.getElementById('btn-run');
const btnClear            = document.getElementById('btn-clear');
const btnConsole          = document.getElementById('btn-console');
const btnConsoleClear     = document.getElementById('btn-console-clear');
const fileCountInput      = document.getElementById('file-count');
const encodeEffortInput   = document.getElementById('encode-effort');
const encodeDistanceInput = document.getElementById('encode-distance');
const tileSizeInput       = document.getElementById('tile-size');
const compareFullInput    = document.getElementById('compare-full');
const wasmStatusEl        = document.getElementById('wasm-status');
const statusFolder        = document.getElementById('status-folder');
const statusProgress      = document.getElementById('status-progress');
const statusFile          = document.getElementById('status-file');
const statusStage         = document.getElementById('status-stage');
const resultsEl           = document.getElementById('crop-results');
const consolePanelEl      = document.getElementById('console-panel');
const consoleOutputEl     = document.getElementById('console-output');
const btnConsoleCopy      = document.getElementById('btn-console-copy');
const cropCopyMdBtn       = document.getElementById('crop-copy-md');
const cropExportJsonBtn   = document.getElementById('crop-export-json');
if (cropExportJsonBtn) cropExportJsonBtn.disabled = true;
const tilePxLabel         = document.getElementById('tile-px-label');

function setWasmStatus(text)     { wasmStatusEl.textContent   = text; }
function setStatusProgress(text) { statusProgress.textContent = text; }
function setStatusFile(text)     { statusFile.textContent     = text; }
function setStatusStage(text)    { statusStage.textContent    = text; }
function setStatusFolder(text)   { statusFolder.textContent   = text; }

function recordCropTiming(fileName, size, tileMs, jxtcMs = null, fullMs = null, decodeMetrics = {}) {
    if (!lastCropRun) return;
    const region = decodeMetrics.region || {};
    const jxtc = decodeMetrics.jxtc || {};
    const fullM = decodeMetrics.full || {};
    lastCropRun.records.push({
        file: fileName,
        size,
        tileMs,
        jxtcMs,
        fullMs,
        // Tile-region decode handoff (the "region" path) — kept separate from JXTC.
        decode_buffer_extract_ms: region.decode_buffer_extract_ms ?? fullM.decode_buffer_extract_ms ?? null,
        decode_region_downsample_ms: region.decode_region_downsample_ms ?? fullM.decode_region_downsample_ms ?? null,
        decode_toarraybuffer_ms: region.decode_toarraybuffer_ms ?? fullM.decode_toarraybuffer_ms ?? null,
        // JXTC-region decode handoff, recorded under its own keys so it is not
        // conflated with the tile-region numbers above.
        jxtc_decode_buffer_extract_ms: jxtc.decode_buffer_extract_ms ?? null,
        jxtc_decode_region_downsample_ms: jxtc.decode_region_downsample_ms ?? null,
        jxtc_decode_toarraybuffer_ms: jxtc.decode_toarraybuffer_ms ?? null,
    });
}

function updateWorkflowState() {
    const hasFiles = orfFiles && orfFiles.length > 0;
    if (btnRun) {
        btnRun.disabled = !hasFiles || !wasmReady;
        btnRun.title = !hasFiles 
            ? 'Pick ORF files first (step 1)' 
            : (wasmReady ? 'Run region decode benchmark' : 'Waiting for WASM...');
    }
    if (btnClear) {
        btnClear.disabled = !hasFiles;
        btnClear.title = hasFiles ? 'Clear selected files' : 'No files loaded';
    }
}

// --- Console panel ---

let consolePanelOpen = false;

function logToPanel(level, args) {
    const line = document.createElement('div');
    line.className = 'console-line console-line--' + level;
    line.textContent = args.map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    consoleOutputEl.appendChild(line);
    consoleOutputEl.scrollTop = consoleOutputEl.scrollHeight;
}

const _log   = console.log.bind(console);
const _warn  = console.warn.bind(console);
const _error = console.error.bind(console);
const _group = console.group.bind(console);
const _groupEnd = console.groupEnd.bind(console);

console.log   = (...a) => { _log(...a);   logToPanel('log',   a); };
console.warn  = (...a) => { _warn(...a);  logToPanel('warn',  a); };
console.error = (...a) => { _error(...a); logToPanel('error', a); };
console.group = (...a) => {
    _group(...a);
    const line = document.createElement('div');
    line.className = 'console-line console-line--group';
    line.textContent = '▶ ' + a.join(' ');
    consoleOutputEl.appendChild(line);
    consoleOutputEl.scrollTop = consoleOutputEl.scrollHeight;
};
console.groupEnd = (...a) => { _groupEnd(...a); };

btnConsole.addEventListener('click', () => {
    consolePanelOpen = !consolePanelOpen;
    consolePanelEl.hidden = !consolePanelOpen;
    btnConsole.classList.toggle('is-active', consolePanelOpen);
});

btnConsoleCopy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(consoleOutputEl.textContent);
    btnConsoleCopy.textContent = 'Copied!';
    setTimeout(() => { btnConsoleCopy.textContent = 'Copy all'; }, 2000);
});

btnConsoleClear.addEventListener('click', () => {
    consoleOutputEl.textContent = '';
});

function copyCropResultsMd() {
    if (!lastCropRun || !lastCropRun.records || lastCropRun.records.length === 0) {
        console.warn('[crop-benchmark] No results to copy');
        return;
    }
    const { config, records, timestamp } = lastCropRun;
    const sizes = [...new Set(records.map(r => r.size))].sort((a,b)=>a-b);

    // Build per-size aggregates
    const lines = [];
    lines.push(`# JXL Crop Benchmark — ${timestamp}`);
    lines.push('');
    lines.push(`**Config:** effort=${config.effort}, distance=${config.distance}, tile=${config.tileSize}px, compareFull=${config.compareFull}`);
    lines.push(`**Sizes:** ${config.sizes.join(', ')} px`);
    lines.push('');
    lines.push('## Per-size averages (ms)');
    lines.push('');
    lines.push('| Size | Tile avg | JXTC avg | Full avg | Tile vs Full | #samples |');
    lines.push('|------|----------|----------|----------|--------------|----------|');

    for (const sz of sizes) {
        const szRecs = records.filter(r => r.size === sz);
        const tileVals = szRecs.map(r => r.tileMs).filter(Number.isFinite);
        const jxtcVals = szRecs.map(r => r.jxtcMs).filter(v => v != null && Number.isFinite(v));
        const fullVals = szRecs.map(r => r.fullMs).filter(v => v != null && Number.isFinite(v));
        const tAvg = tileVals.length ? (tileVals.reduce((a,b)=>a+b,0)/tileVals.length).toFixed(1) : '—';
        const jAvg = jxtcVals.length ? (jxtcVals.reduce((a,b)=>a+b,0)/jxtcVals.length).toFixed(1) : '—';
        const fAvg = fullVals.length ? (fullVals.reduce((a,b)=>a+b,0)/fullVals.length).toFixed(1) : '—';
        const speedup = (fullVals.length && tileVals.length) ? (fullVals.reduce((a,b)=>a+b,0)/fullVals.length / (tileVals.reduce((a,b)=>a+b,0)/tileVals.length)).toFixed(2) + '×' : '—';
        lines.push(`| ${sz}px | ${tAvg} | ${jAvg} | ${fAvg} | ${speedup} | ${szRecs.length} |`);
    }

    lines.push('');
    lines.push('## Decode Pixel Handoff Metrics (per-size averages, ms)');
    lines.push('');
    lines.push('| Size | buffer_extract avg | region_downsample avg | toarraybuffer avg | #samples |');
    lines.push('|------|--------------------|-----------------------|-------------------|----------|');

    for (const sz of sizes) {
        const szRecs = records.filter(r => r.size === sz);
        const beVals = szRecs.map(r => r.decode_buffer_extract_ms).filter(v => v != null && Number.isFinite(v));
        const rdVals = szRecs.map(r => r.decode_region_downsample_ms).filter(v => v != null && Number.isFinite(v));
        const taVals = szRecs.map(r => r.decode_toarraybuffer_ms).filter(v => v != null && Number.isFinite(v));
        const beAvg = beVals.length ? (beVals.reduce((a,b)=>a+b,0)/beVals.length).toFixed(1) : '—';
        const rdAvg = rdVals.length ? (rdVals.reduce((a,b)=>a+b,0)/rdVals.length).toFixed(1) : '—';
        const taAvg = taVals.length ? (taVals.reduce((a,b)=>a+b,0)/taVals.length).toFixed(1) : '—';
        lines.push(`| ${sz}px | ${beAvg} | ${rdAvg} | ${taAvg} | ${szRecs.length} |`);
    }

    // Also include overall decode pixel handoff summary for the run
    const allBe = records.map(r => r.decode_buffer_extract_ms).filter(v => v != null && Number.isFinite(v));
    const allRd = records.map(r => r.decode_region_downsample_ms).filter(v => v != null && Number.isFinite(v));
    const allTa = records.map(r => r.decode_toarraybuffer_ms).filter(v => v != null && Number.isFinite(v));
    if (allBe.length || allRd.length || allTa.length) {
        lines.push('');
        lines.push('**Overall Decode Pixel Handoff (across all samples):**');
        if (allBe.length) lines.push(`- buffer_extract: avg=${(allBe.reduce((a,b)=>a+b,0)/allBe.length).toFixed(1)} ms over ${allBe.length} samples`);
        if (allRd.length) lines.push(`- region_downsample: avg=${(allRd.reduce((a,b)=>a+b,0)/allRd.length).toFixed(1)} ms over ${allRd.length} samples`);
        if (allTa.length) lines.push(`- toarraybuffer: avg=${(allTa.reduce((a,b)=>a+b,0)/allTa.length).toFixed(1)} ms over ${allTa.length} samples`);
    }

    lines.push('');
    lines.push('## Per-file details');
    lines.push('');
    lines.push('| File | Size | Tile (ms) | JXTC (ms) | Full (ms) | buf_extract | region_ds | toarr |');
    lines.push('|------|------|-----------|-----------|-----------|-------------|-----------|-------|');
    for (const r of records) {
        const be = r.decode_buffer_extract_ms != null ? r.decode_buffer_extract_ms.toFixed(1) : '—';
        const rd = r.decode_region_downsample_ms != null ? r.decode_region_downsample_ms.toFixed(1) : '—';
        const ta = r.decode_toarraybuffer_ms != null ? r.decode_toarraybuffer_ms.toFixed(1) : '—';
        lines.push(`| ${r.file} | ${r.size}px | ${r.tileMs.toFixed(1)} | ${r.jxtcMs != null ? r.jxtcMs.toFixed(1) : '—'} | ${r.fullMs != null ? r.fullMs.toFixed(1) : '—'} | ${be} | ${rd} | ${ta} |`);
    }
    lines.push('');
    lines.push('_Generated by jxl-crop-benchmark.html_');

    const md = lines.join('\n');
    navigator.clipboard.writeText(md).then(() => {
        const orig = cropCopyMdBtn.textContent;
        cropCopyMdBtn.textContent = 'Copied!';
        setTimeout(() => { cropCopyMdBtn.textContent = orig || 'Copy MD'; }, 1600);
    }).catch(() => {
        // Fallback: log it
        console.log('[crop-benchmark] MD (clipboard blocked):\n' + md);
    });
}

if (cropCopyMdBtn) {
    cropCopyMdBtn.addEventListener('click', () => copyCropResultsMd());
} else {
    console.warn('[crop-benchmark] crop-copy-md button not found in DOM');
}

function exportCropResultsJson() {
    if (!lastCropRun || !lastCropRun.records || lastCropRun.records.length === 0) {
        console.warn('[crop-benchmark] No results to export');
        return;
    }
    const payload = {
        exportedAt: new Date().toISOString(),
        config: lastCropRun.config,
        records: lastCropRun.records,
        sourceCount: new Set(lastCropRun.records.map(r => r.file)).size,
        note: 'Crop region decode timings from jxl-crop-benchmark. Includes decode pixel handoff metrics (decode_buffer_extract_ms, decode_region_downsample_ms, decode_toarraybuffer_ms) from Boundary Cost Audit. Use with main benchmark JSONs for correlation analysis.'
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jxl-crop-results-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log('[crop-benchmark] Exported crop results JSON');
}

if (cropExportJsonBtn) {
    cropExportJsonBtn.addEventListener('click', () => exportCropResultsJson());
    // Enable when we have data (will be re-enabled at end of runs too)
    if (lastCropRun && lastCropRun.records && lastCropRun.records.length) cropExportJsonBtn.disabled = false;
} else {
    console.warn('[crop-benchmark] crop-export-json button not found');
}

// --- File picker ---

// Unified picker with memory + workflow guidance
const filePicker = createFilePicker({
    input: orfFileInput,
    dropZone: document.querySelector('label[for="orf-file-input"]'),
    multiple: true,
    accept: '.orf,.ORF',
    persistKey: 'jxl-crop-benchmark-last-files',
    onFiles: (files) => {
        orfFiles = files.filter(f => /\.orf$/i.test(f.name));
        if (!orfFiles.length) {
            setStatusFolder('No ORF files in selection');
            btnRun.disabled = true;
            updateWorkflowState();
            return;
        }
        setStatusFolder(`${orfFiles.length} ORF file${orfFiles.length !== 1 ? 's' : ''} selected`);
        btnRun.disabled = !wasmReady;
        updateWorkflowState();
    }
});

filePicker?.loadLastPersisted?.().then(f => {
    if (f?.length) {
        orfFiles = f.filter(x => /\.orf$/i.test(x.name));
        if (orfFiles.length) {
            setStatusFolder(`${orfFiles.length} ORF file(s) restored from last session`);
            btnRun.disabled = !wasmReady;
            updateWorkflowState();
        }
    }
}).catch(() => {});

// --- WASM encode/decode ---

function concatChunks(chunks) {
    const views = chunks.map(c => c instanceof Uint8Array ? c : new Uint8Array(c));
    if (views.length === 1) return views[0];
    const total = views.reduce((s, v) => s + v.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const v of views) { out.set(v, off); off += v.byteLength; }
    return out;
}

/**
 * Non-tiled (standard) JXL encode — for comparison decode timings.
 */
async function encodeStandard(rgba, width, height, effort, distance) {
    const encoder = createEncoder({
        format: 'rgba8', width, height, hasAlpha: true,
        iccProfile: null, exif: null, xmp: null,
        distance, quality: null, effort,
        progressive: false, previewFirst: false, chunked: false,
    });
    const chunks = [];
    const chunkTask = (async () => {
        for await (const chunk of encoder.chunks()) chunks.push(chunk);
    })();
    const buf = rgba.buffer.byteLength === rgba.byteLength
        ? rgba.buffer
        : rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength);
    await encoder.pushPixels(buf);
    await encoder.finish();
    await chunkTask;
    await encoder.dispose();
    return concatChunks(chunks);
}

/**
 * Full-image decode + JS crop — the slow baseline for comparison.
 * Decodes the entire JXL, then memcpys the requested region.
 */
async function decodeFullThenCrop(jxlBytes, sourceWidth, sourceHeight, targetSize, onMetric) {
    const half = Math.floor(targetSize / 2);
    const cx   = Math.floor(sourceWidth  / 2);
    const cy   = Math.floor(sourceHeight / 2);
    const x    = Math.max(0, cx - half);
    const y    = Math.max(0, cy - half);
    const w    = Math.min(targetSize, sourceWidth  - x);
    const h    = Math.min(targetSize, sourceHeight - y);

    const decodeStart = performance.now();
    const tCreate = performance.now();
    const decoder = createDecoder({
        format: 'rgba8',
        region: { x, y, w, h },
        downsample: 1,
        progressionTarget: 'final',
        emitEveryPass: false,
        preserveIcc: false,
        preserveMetadata: false,
        onMetric: (name, value) => {
          if (onMetric) onMetric(name, value);
          logDecodePixelMetric(name, value);
          // Also collect some decoder internal metrics for full path breakdown
          if (name === 'source_pixels_decoded' || name === 'decode_scale_used' || name === 'decode_region_area') {
            logDecodePixelMetric('full_' + name, value);
          }
        },
    });
    const createTime = performance.now() - tCreate;
    logDecodePixelMetric('full_decoder_create_ms', createTime);
    const tPush = performance.now();
    await decoder.push(jxlBytes);
    const pushTime = performance.now() - tPush;
    logDecodePixelMetric('full_decoder_push_ms', pushTime);
    await decoder.close();
    const tEvents = performance.now();
    let result = null;
    for await (const event of decoder.events()) {
        if (event.type === 'final') {
            result = { pixels: event.pixels, width: event.info.width, height: event.info.height };
            break;
        }
        if (event.type === 'error') {
            await decoder.dispose();
            throw new Error(event.message);
        }
    }
    const eventsTime = performance.now() - tEvents;
    logDecodePixelMetric('full_decoder_events_ms', eventsTime);
    await decoder.dispose();
    const decodeTime = performance.now() - decodeStart;
    logDecodePixelMetric('decode_buffer_extract_ms', decodeTime);  // proxy for full
    logDecodePixelMetric('full_total_ms', decodeTime);
    if (!result) throw new Error('no final frame emitted');
    return result;
}

/**
 * True ROI decode using the tile bridge:
 * - jxlBytes must be a tiled JXL produced by encodeTiledRgba8
 * - decoder uses SetCoalescing(false) + SkipFrames internally
 * - only overlapping tiles are decompressed
 */
async function decodeTileRegion(jxlBytes, tileSize, sourceWidth, sourceHeight, targetSize, onMetric) {
    const half = Math.floor(targetSize / 2);
    const cx   = Math.floor(sourceWidth  / 2);
    const cy   = Math.floor(sourceHeight / 2);
    const x    = Math.max(0, cx - half);
    const y    = Math.max(0, cy - half);
    const w    = Math.min(targetSize, sourceWidth  - x);
    const h    = Math.min(targetSize, sourceHeight - y);

    const fns = await getTiledFns();
    if (!fns.decodeTiledRegionRgba8) throw new Error('Tiled decode not available in this build');
    return fns.decodeTiledRegionRgba8(jxlBytes, { tileSize, x, y, w, h, onMetric });
}

/**
 * JXTC container ROI decode:
 * - containerBytes must be a JXTC produced by encodeTileContainerRgba8
 * - decoder seeks directly to needed tile byte offsets — zero frame-walk overhead
 * - each tile decoded as standalone JXL
 */
async function decodeContainerRegion(containerBytes, sourceWidth, sourceHeight, targetSize, onMetric) {
    const half = Math.floor(targetSize / 2);
    const cx   = Math.floor(sourceWidth  / 2);
    const cy   = Math.floor(sourceHeight / 2);
    const x    = Math.max(0, cx - half);
    const y    = Math.max(0, cy - half);
    const w    = Math.min(targetSize, sourceWidth  - x);
    const h    = Math.min(targetSize, sourceHeight - y);

    const fns = await getTiledFns();
    if (!fns.decodeTileContainerRegionRgba8) throw new Error('JXTC decode not available in this build');
    return fns.decodeTileContainerRegionRgba8(containerBytes, { x, y, w, h, onMetric });
}

// --- UI result rows ---

function getSelectedSizes() {
    return Array.from(document.querySelectorAll('input[name="crop-size"]:checked'))
        .map(cb => Number(cb.value)).sort((a, b) => a - b);
}

function createFileRow(fileName, imgWidth, imgHeight, sizes) {
    const row  = document.createElement('div');
    row.className = 'crop-file-row';

    const title = document.createElement('div');
    title.className = 'crop-file-title';
    title.textContent = fileName;
    row.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'crop-file-meta';
    meta.textContent = `${imgWidth} × ${imgHeight} px`;
    row.appendChild(meta);

    const strip = document.createElement('div');
    strip.className = 'crop-strip';
    row.appendChild(strip);

    const cards = {};
    for (const size of sizes) {
        const card = document.createElement('div');
        card.className = 'crop-card';
        card.style.width = logDisplayWidth(size) + 'px';

        const lbl = document.createElement('div');
        lbl.className = 'crop-card-label';
        lbl.textContent = `${size} px`;
        card.appendChild(lbl);

        const wrap = document.createElement('div');
        wrap.className = 'crop-canvas-wrap';
        wrap.style.aspectRatio = '1';

        const placeholder = document.createElement('div');
        placeholder.className = 'crop-canvas-placeholder';
        placeholder.textContent = '…';
        wrap.appendChild(placeholder);
        card.appendChild(wrap);

        const timing = document.createElement('div');
        timing.className = 'crop-timing';
        timing.textContent = '—';
        card.appendChild(timing);

        const compareTiming = document.createElement('div');
        compareTiming.className = 'crop-timing-encode';
        compareTiming.textContent = '';
        card.appendChild(compareTiming);

        strip.appendChild(card);
        cards[size] = { wrap, placeholder, timing, compareTiming };
    }

    resultsEl.insertBefore(row, resultsEl.firstChild);
    return { cards, meta };
}

function paintCrop(slot, pixels, width, height, decodeMs, reqW, reqH) {
    const canvas = document.createElement('canvas');
    canvas.width  = width;
    canvas.height = height;
    const raw = pixels instanceof ArrayBuffer
        ? new Uint8Array(pixels)
        : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    canvas.getContext('2d').putImageData(
        new ImageData(new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength), width, height), 0, 0,
    );
    slot.placeholder.remove();
    slot.wrap.appendChild(canvas);

    slot.timing.textContent  = `tile ${decodeMs.toFixed(1)} ms`;
    slot.timing.className    = decodeMs < 80 ? 'crop-timing is-fast' : decodeMs > 400 ? 'crop-timing is-slow' : 'crop-timing';
}

function showCompareTiming(slot, tileMs, fullMs) {
    const speedup = fullMs / tileMs;
    slot.compareTiming.textContent = `full ${fullMs.toFixed(1)} ms  (${speedup.toFixed(1)}× faster)`;
}

function markSkipped(slot, reason) {
    slot.placeholder.textContent = reason;
    slot.timing.className = 'crop-timing-skip';
    slot.timing.textContent = 'skipped';
}

// --- Benchmark loop ---

async function runBenchmark() {
    if (!orfFiles.length || !wasmReady) return;

    running = true;
    abortController = new AbortController();
    const { signal } = abortController;

    btnRun.textContent  = 'Stop';
    btnClear.disabled   = true;

    const fileCount   = Math.max(1, Math.min(20,   Number(fileCountInput.value)       || 3));
    const effort      = Math.max(1, Math.min(9,    Number(encodeEffortInput.value)    || 3));
    const distance    = Math.max(0, Math.min(25,   Number(encodeDistanceInput.value)  || 1.0));
    const tileSize    = Math.max(64, Math.min(2048, Number(tileSizeInput.value)        || 512));
    const compareFull = compareFullInput.checked;
    const sizes       = getSelectedSizes();

    if (!sizes.length) { setStatusProgress('No crop sizes selected.'); endRun(); return; }
    console.log('%c[Crop Benchmark] run start', 'color:#f59e0b;font-weight:600', { t: new Date().toISOString(), fileCount, effort, distance, tileSize, sizes, compareFull });

    lastCropRun = {
        timestamp: new Date().toISOString(),
        config: { effort, distance, tileSize, sizes, compareFull },
        records: [],
    };

    resetDecodePixelMetrics();

    const files = shuffled(orfFiles).slice(0, fileCount);
    setStatusProgress(`0 / ${files.length}`);

    for (let i = 0; i < files.length; i++) {
        if (signal.aborted) break;

        const file = files[i];
        setStatusFile(file.name);
        setStatusStage('Reading…');
        setStatusProgress(`${i + 1} / ${files.length}`);

        let arrayBuffer;
        try {
            arrayBuffer = await file.arrayBuffer();
        } catch (err) {
            console.error('Read error:', file.name, err);
            continue;
        }

        setStatusStage('Decoding RAW…');
        let rgba, imgWidth, imgHeight;
        try {
            const result = rawWasm.process_orf(new Uint8Array(arrayBuffer), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
            try {
                // Legacy WASM-side RGBA path removed per Boundary Cost Audit
                rgba      = rawWasm.rgb_to_rgba(result.take_rgb());
                imgWidth  = result.width;
                imgHeight = result.height;
            } finally { result.free(); }
        } catch (err) {
            console.error('RAW error:', file.name, err);
            setStatusStage(`RAW error: ${err.message}`);
            continue;
        }

        // Encode tiled JXL (ROI-decodable) + JXTC container + optional standard JXL.
        setStatusStage(`Encoding tiled JXL (${tileSize}px tiles)…`);
        const t0tiled = performance.now();
        let tiledBytes;
        try {
            const fns = await getTiledFns();
            if (!fns.encodeTiledRgba8) throw new Error('Tiled encode not available in this build');
            tiledBytes = await fns.encodeTiledRgba8(rgba, imgWidth, imgHeight, {
                tileSize, distance, effort, hasAlpha: true,
            });
        } catch (err) {
            console.error('Tiled encode error:', file.name, err);
            setStatusStage(`Tiled encode error: ${err.message}`);
            continue;
        }
        const tiledEncodeMs = performance.now() - t0tiled;

        setStatusStage(`Encoding JXTC container (${tileSize}px tiles)…`);
        const t0jxtc = performance.now();
        let jxtcBytes = null;
        try {
            const fns = await getTiledFns();
            if (!fns.encodeTileContainerRgba8) throw new Error('JXTC container encode not available in this build');
            jxtcBytes = await fns.encodeTileContainerRgba8(rgba, imgWidth, imgHeight, {
                tileSize, distance, effort, hasAlpha: true,
            });
        } catch (err) {
            console.warn('JXTC encode error (container test skipped):', err);
        }
        const jxtcEncodeMs = performance.now() - t0jxtc;

        let standardBytes = null;
        let standardEncodeMs = 0;
        if (compareFull) {
            setStatusStage('Encoding standard JXL (comparison)…');
            const t0std = performance.now();
            try {
                standardBytes = await encodeStandard(rgba, imgWidth, imgHeight, effort, distance);
            } catch (err) {
                console.warn('Standard encode error (comparison skipped):', err);
            }
            standardEncodeMs = performance.now() - t0std;
        }

        const tilesX = Math.ceil(imgWidth  / tileSize);
        const tilesY = Math.ceil(imgHeight / tileSize);
        const totalTiles = tilesX * tilesY;

        const { cards, meta } = createFileRow(file.name, imgWidth, imgHeight, sizes);
        const tiledKb = (tiledBytes.byteLength / 1024).toFixed(0);
        const jxtcKb  = jxtcBytes  ? (jxtcBytes.byteLength  / 1024).toFixed(0) : '—';
        const stdSuffix = standardBytes ? `  ·  standard ${(standardBytes.byteLength / 1024).toFixed(0)} KB / ${standardEncodeMs.toFixed(0)} ms` : '';
        const jxtcSuffix = jxtcBytes ? `  ·  jxtc ${jxtcKb} KB / ${jxtcEncodeMs.toFixed(0)} ms` : '';
        meta.textContent = `${imgWidth} × ${imgHeight} px  ·  ${tilesX}×${tilesY}=${totalTiles} tiles  ·  tiled ${tiledKb} KB / ${tiledEncodeMs.toFixed(0)} ms${jxtcSuffix}${stdSuffix}`;
        tilePxLabel.textContent = `Tile px: ${tileSize}`;

        console.group(`Crop benchmark: ${file.name}`);
        console.log(`${imgWidth}×${imgHeight}  tiles=${tilesX}×${tilesY}  tiledKB=${tiledKb}  jxtcKB=${jxtcKb}  encodeTiledMs=${tiledEncodeMs.toFixed(1)}  encodeJxtcMs=${jxtcEncodeMs.toFixed(1)}  tilePx=${tileSize}`);

        // Reset decode pixel metrics for this file so per-file numbers in the report are meaningful
        resetDecodePixelMetrics();

        for (const size of sizes) {
            if (signal.aborted) break;

            if (size >= imgWidth && size >= imgHeight) {
                console.log(`  ${size}px: skipped (≥ full image)`);
                markSkipped(cards[size], '≥ full image');
                continue;
            }

            setStatusStage(`Tile region ${size}px…`);

            resetDecodePixelMetrics();  // per-size for accurate decode handoff metrics per crop size

            const t0 = performance.now();
            let decoded;
            const metrics = {};
            try {
                decoded = await decodeTileRegion(tiledBytes, tileSize, imgWidth, imgHeight, size, (name, value) => {
                    metrics[name] = value;
                    logDecodePixelMetric(name, value);
                    if (name === 'tiled_region_buffer_read' || name.includes('buffer_read')) {
                        logDecodePixelMetric('decode_buffer_extract_ms', value);
                    }
                    if (name.includes('region') || name.includes('downsample') || name.includes('wasm_decode')) {
                        logDecodePixelMetric('decode_region_downsample_ms', value);
                    }
                });
            } catch (err) {
                console.error(`  ${size}px tile region ERROR:`, err.message || err);
                markSkipped(cards[size], `error: ${err.message?.split('\n')[0] || String(err).slice(0,20)}`);
                continue;
            }
            const tileMs = performance.now() - t0;
            // decodeTileRegion above cannot be interrupted; if Stop was pressed
            // while it ran, abandon this stale size rather than recording it.
            if (signal.aborted) break;

            paintCrop(cards[size], decoded.pixels, decoded.width, decoded.height, tileMs, size, size);

            // Snapshot the TILE region decode handoff metrics before the JXTC
            // decode runs, then reset, so the two codecs do not blend into one
            // "region" label in the shared decodePixelMetrics arrays.
            const regionDecodeMetrics = snapshotDecodePixelMetrics();
            resetDecodePixelMetrics();

            // JXTC container ROI decode comparison
            let jxtcMs = null;
            let jxtcDecodeMetrics = null;
            if (jxtcBytes) {
                setStatusStage(`JXTC region ${size}px…`);
                const tJ = performance.now();
                try {
                    await decodeContainerRegion(jxtcBytes, imgWidth, imgHeight, size, (name, value) => {
                        logDecodePixelMetric(name, value);
                        if (name === 'tiled_region_buffer_read' || name.includes('buffer_read')) {
                            logDecodePixelMetric('decode_buffer_extract_ms', value);
                        }
                        if (name.includes('region') || name.includes('downsample') || name.includes('wasm_decode')) {
                            logDecodePixelMetric('decode_region_downsample_ms', value);
                        }
                    });
                    jxtcMs = performance.now() - tJ;
                    jxtcDecodeMetrics = snapshotDecodePixelMetrics();
                } catch (err) {
                    console.warn(`  ${size}px JXTC region failed:`, err.message || err);
                }
            }
            // decodeContainerRegion above cannot be interrupted; honour Stop now.
            if (signal.aborted) break;

            // Reset for full decode baseline
            resetDecodePixelMetrics();

            // Update timing display to show both tile and jxtc
            if (jxtcMs !== null) {
                cards[size].timing.textContent = `tile ${tileMs.toFixed(0)}ms · jxtc ${jxtcMs.toFixed(0)}ms (${(tileMs/jxtcMs).toFixed(1)}×)`;
                if (jxtcMs < 200) cards[size].timing.className = 'crop-timing is-fast';
            }

            // Comparison: full decode of standard JXL + JS crop
            let fullMsForRecord = null;
            if (compareFull && standardBytes) {
                setStatusStage(`Full decode ${size}px (compare)…`);
                const t1 = performance.now();
                try {
                    await decodeFullThenCrop(standardBytes, imgWidth, imgHeight, size, () => {});
                    const fullMs = performance.now() - t1;
                    fullMsForRecord = fullMs;
                    showCompareTiming(cards[size], tileMs, fullMs);
                    const jxtcStr = jxtcMs !== null ? `  ·  jxtc ${jxtcMs.toFixed(1)} ms (${(tileMs/jxtcMs).toFixed(1)}× vs tile)` : '';
                    console.log(`  ${size}px → ${decoded.width}×${decoded.height}: tile ${tileMs.toFixed(1)} ms${jxtcStr}  ·  full ${fullMs.toFixed(1)} ms  (${(fullMs / tileMs).toFixed(1)}× vs tile)`);
                } catch (err) {
                    console.warn(`  ${size}px full-decode comparison failed:`, err);
                    console.log(`  ${size}px → ${decoded.width}×${decoded.height}: tile ${tileMs.toFixed(1)} ms`);
                }
            } else {
                const jxtcStr = jxtcMs !== null ? `  ·  jxtc ${jxtcMs.toFixed(1)} ms (${(tileMs/jxtcMs).toFixed(1)}× vs tile)` : '';
                console.log(`  ${size}px → ${decoded.width}×${decoded.height}: tile ${tileMs.toFixed(1)} ms${jxtcStr}`);
            }

            // Snapshot full decode handoff (the whole full decode time as extract cost)
            const fullDecodeMetrics = snapshotDecodePixelMetrics();

            // Record with separate region (tile), jxtc, and full handoff metrics
            recordCropTiming(file.name, size, tileMs, jxtcMs, fullMsForRecord, {
                region: regionDecodeMetrics,
                jxtc: jxtcDecodeMetrics,
                full: fullDecodeMetrics
            });

            await new Promise(r => setTimeout(r, 0));
        }

        console.groupEnd();

        // Print summary of new decode pixel handoff metrics for this file
        summarizeDecodePixelMetrics(`for ${file.name}`);

        // Also reset for next file
        resetDecodePixelMetrics();
    }

    setStatusStage('Done');
    setStatusProgress('Complete');
    if (cropExportJsonBtn) cropExportJsonBtn.disabled = false;
    endRun();
}

function endRun() {
    running = false;
    abortController = null;
    btnRun.textContent = 'Run';
    btnClear.disabled  = false;
}

function clearResults() {
    resultsEl.innerHTML = '<div class="crop-empty-state">Pick a folder of ORF files and press Run.</div>';
    btnClear.disabled = true;
    setStatusProgress('Idle');
    setStatusFile('—');
    setStatusStage('—');
    lastCropRun = null;
    if (cropExportJsonBtn) cropExportJsonBtn.disabled = true;
}

// --- Events ---

btnRun.addEventListener('click',   () => running ? abortController?.abort() : runBenchmark());
btnClear.addEventListener('click', clearResults);

// --- Init ---

(async () => {
    setWasmStatus('Initialising WASM…');
    try {
        await initRaw();
        if (typeof rawWasm.initThreadPool === 'function') {
            await rawWasm.initThreadPool(navigator.hardwareConcurrency);
        }
        wasmReady = true;
        setWasmStatus('Ready');
    } catch (err) {
        setWasmStatus('WASM error');
        console.error('WASM init:', err);
    }
})();
