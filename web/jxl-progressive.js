import initRaw, { process_orf, rgb_to_rgba, downscale_rgb } from '../pkg/raw_converter_wasm.js';
import { createProgressiveSession } from './jxl-progressive-session.js';
import { encodeBackendForTarget } from './jxl-progressive-policy.js';
import { createProgressiveDecodeRequest } from './jxl-progressive-decode.js';

const runBtn = document.getElementById('run-btn');
const replayBtn = document.getElementById('replay-btn');
const resetBtn = document.getElementById('reset-btn');
const modeButtons = [...document.querySelectorAll('[data-decode-mode]')];
const encodeBackendButtons = [...document.querySelectorAll('[data-encode-backend]')];
const decodeBackendButtons = [...document.querySelectorAll('[data-decode-backend]')];
const previewModeButtons = [...document.querySelectorAll('[data-preview-mode]')];
const thumbBenchRunBtn = document.getElementById('thumb-bench-run');
const thumbBenchConcurrencyInput = document.getElementById('thumb-bench-concurrency');
const thumbBenchConcurrencyValue = document.getElementById('thumb-bench-concurrency-value');
const thumbBenchStatus = document.getElementById('thumb-bench-status');
const thumbBenchSettings = document.getElementById('thumb-bench-settings');
const thumbBenchSizeButtons = [...document.querySelectorAll('[data-thumb-size]')];
const thumbBenchProgressiveButtons = [...document.querySelectorAll('[data-thumb-progressive]')];
const thumbBenchDetailButtons = [...document.querySelectorAll('[data-thumb-detail]')];
const thumbBenchCards = [...document.querySelectorAll('[data-thumb-bench-card]')].map((card) => ({
    el: card,
    size: Number(card.dataset.thumbBenchCard),
    grid: card.querySelector('[data-thumb-grid]'),
    log: card.querySelector('[data-thumb-log]'),
}));
const progressiveStepsInput = document.getElementById('progressive-steps');
const progressiveStepsValue = document.getElementById('progressive-steps-value');
const statusText = document.getElementById('status-text');
const sourceMeta = document.getElementById('source-meta');
const cards = [...document.querySelectorAll('.card')].map((card) => ({
    el: card,
    slot: card.dataset.slot,
    canvas: card.querySelector('canvas'),
    fill: card.querySelector('.fill'),
    bytes: card.querySelector('.bytes'),
    encode: card.querySelector('.encode'),
    timings: card.querySelector('.timings'),
    notes: card.querySelector('.notes'),
    badge: card.querySelector('.badge'),
    defaultBadge: card.querySelector('.badge').textContent,
}));

const TARGETS = [
    { slot: 'thumb', label: '300 long', longEdge: 300, badge: 'small thumb' },
    { slot: 'mid', label: '800 long', longEdge: 800, badge: 'large thumb' },
    { slot: 'full', label: 'Full size', longEdge: null, badge: 'reference' },
];

let activeRunId = 0;
let decodeMode = 'final';
let previewMode = 'source';
let thumbBenchRunId = 0;
let thumbBenchConcurrency = Number(thumbBenchConcurrencyInput?.value) || 4;
let thumbBenchProgressive = true;
let thumbBenchProgressiveDetail = 'dc';
let thumbBenchSizes = new Set([300, 800]);
const session = createProgressiveSession({
    initialEncodeBackend: 'jsquash',
    initialDecodeBackend: 'jsquash',
    loadSource: loadRandomSource,
});

const encodeWorkers = new Map();
const decodeWorkers = new Map();
let workerId = 1;

function getWorkerScript(type, backend) {
    if (type === 'decode' && backend === 'libjxl') return './jxl-worker.js';
    if (backend === 'libjxl') return './icodec-jxl-worker.js';
    return type === 'encode' ? './jxl-worker.js' : './jxl-decode-worker.js';
}

function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = n;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function setStatus(text) {
    statusText.textContent = text;
}

function setSourceMeta(text) {
    sourceMeta.textContent = text;
}

function setThumbBenchStatus(text) {
    if (thumbBenchStatus) thumbBenchStatus.textContent = text;
}

function setThumbBenchSettings(text) {
    if (thumbBenchSettings) thumbBenchSettings.textContent = text;
}

function resetCard(card, note = 'Waiting for source.') {
    card.el.dataset.state = 'idle';
    card.fill.style.width = '0%';
    card.bytes.textContent = '0 / 0';
    card.encode.textContent = 'encode: --';
    card.timings.textContent = '1/3: -- · 2/3: -- · end: --';
    card.notes.textContent = note;
    card.badge.textContent = card.defaultBadge;
    card._jxlBytes = null;
    card._source = null;
    card._targetDims = null;
    card._previewFrames = null;
    card._previewStep = -1;
    card.encodeMs = null;
    card.decodeMs = null;
    card.countdown = null;
    stopPreviewPlayback(card);
    const ctx = card.canvas.getContext('2d');
    card.canvas.width = 16;
    card.canvas.height = 16;
    ctx.clearRect(0, 0, card.canvas.width, card.canvas.height);
}

function resetAllCards() {
    for (const card of cards) resetCard(card);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function getProgressiveStepCount() {
    return clamp(Number(progressiveStepsInput.value) || 4, 2, 8);
}

function syncProgressiveStepLabel() {
    progressiveStepsValue.textContent = String(getProgressiveStepCount());
}

function setDecodeMode(mode) {
    decodeMode = mode;
    for (const button of modeButtons) {
        const active = button.dataset.decodeMode === mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    const stepControl = progressiveStepsInput.closest('.step-control');
    progressiveStepsInput.disabled = mode !== 'progressive';
    stepControl.dataset.active = mode;
    stepControl.classList.toggle('is-disabled', mode !== 'progressive');
    stepControl.querySelector('strong').textContent = String(getProgressiveStepCount());
}

function setPreviewMode(mode) {
    previewMode = mode;
    for (const button of previewModeButtons) {
        const active = button.dataset.previewMode === mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
}

function setThumbBenchConcurrency(value) {
    thumbBenchConcurrency = clamp(Number(value) || 1, 1, 8);
    if (thumbBenchConcurrencyInput) thumbBenchConcurrencyInput.value = String(thumbBenchConcurrency);
    if (thumbBenchConcurrencyValue) thumbBenchConcurrencyValue.textContent = String(thumbBenchConcurrency);
}

function setThumbBenchProgressive(enabled) {
    thumbBenchProgressive = Boolean(enabled);
    for (const button of thumbBenchProgressiveButtons) {
        const active = button.dataset.thumbProgressive === (thumbBenchProgressive ? 'on' : 'off');
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
}

function setThumbBenchDetail(detail) {
    thumbBenchProgressiveDetail = detail === 'ac' ? 'ac' : 'dc';
    for (const button of thumbBenchDetailButtons) {
        const active = button.dataset.thumbDetail === thumbBenchProgressiveDetail;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
}

function setThumbBenchSize(size, enabled) {
    const n = Number(size);
    if (!Number.isFinite(n)) return;
    if (enabled) thumbBenchSizes.add(n);
    else thumbBenchSizes.delete(n);
    for (const button of thumbBenchSizeButtons) {
        const active = thumbBenchSizes.has(Number(button.dataset.thumbSize));
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    if (!thumbBenchSizes.size) {
        thumbBenchSizes = new Set([300, 800]);
        for (const button of thumbBenchSizeButtons) {
            const active = thumbBenchSizes.has(Number(button.dataset.thumbSize));
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        }
    }
}

function stopPreviewPlayback(card) {
    if (card._previewPlayback) {
        clearInterval(card._previewPlayback);
        card._previewPlayback = null;
    }
}

function startPreviewPlayback(card, source, targetDims, stepCount, runId) {
    stopPreviewPlayback(card);
    card._previewFrames = buildProgressiveFrames(source, targetDims, stepCount);
    card._previewStep = -1;
    if (!card._previewFrames.length) return;
    const stepMs = Math.max(250, Math.round(8000 / card._previewFrames.length));
    const started = performance.now();
    const paintAtElapsed = () => {
        if (runId !== activeRunId) {
            stopPreviewPlayback(card);
            return;
        }
        const elapsed = performance.now() - started;
        const stepIndex = clamp(Math.floor(elapsed / stepMs), 0, card._previewFrames.length - 1);
        if (stepIndex !== card._previewStep) {
            card._previewStep = stepIndex;
            paintFrame(card, card._previewFrames[stepIndex], targetDims);
            card.notes.textContent = `Source playback ${card._previewFrames[stepIndex].label} · waiting for JXL encode.`;
        }
    };
    paintAtElapsed();
    card._previewPlayback = setInterval(paintAtElapsed, Math.min(250, stepMs));
}

function setEncodeBackend(mode) {
    session.setEncodeBackend(mode);
    for (const button of encodeBackendButtons) {
        const active = button.dataset.encodeBackend === mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    setStatus(`Encode backend set to ${mode}. Re-running the same source file.`);
}

function setDecodeBackend(mode) {
    session.setDecodeBackend(mode);
    for (const button of decodeBackendButtons) {
        const active = button.dataset.decodeBackend === mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    setStatus(`Decode backend set to ${mode}. Re-running the same source file.`);
}

function rgbaToCanvasEl(rgba, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height), 0, 0);
    return canvas;
}

function buildProgressiveFrames(source, targetDims, stepCount) {
    if (source.kind !== 'orf') return [];
    const frames = [];
    const longEdge = Math.max(targetDims.width, targetDims.height);
    for (let i = 1; i <= stepCount; i++) {
        const ratio = i / stepCount;
        const isFinal = i === stepCount;
        const frameDims = isFinal
            ? targetDims
            : {
                width: Math.max(1, Math.round(targetDims.width * ratio)),
                height: Math.max(1, Math.round(targetDims.height * ratio)),
            };
        let rgba;
        if (frameDims.width === source.width && frameDims.height === source.height) {
            rgba = source.rgba.slice();
        } else {
            const downRgb = downscale_rgb(source.rgb, source.width, source.height, frameDims.width, frameDims.height);
            rgba = rgb_to_rgba(downRgb);
        }
        const canvas = rgbaToCanvasEl(rgba, frameDims.width, frameDims.height);
        frames.push({
            canvas,
            label: `${i}/${stepCount}`,
            longEdge,
        });
    }
    return frames;
}

function paintFrame(card, frame, targetDims) {
    scaleImageDataToCanvas(frame.canvas, card.canvas, targetDims.width, targetDims.height);
}

function makeWorker(type, backend) {
    const worker = new Worker(new URL(getWorkerScript(type, backend), import.meta.url), { type: 'module' });
    worker._nextId = workerId++;
    worker._supportsProgressiveDecode = type === 'decode' && backend === 'libjxl';
    return worker;
}

function getWorker(type, backend, slot) {
    const key = `${type}:${backend}:${slot}`;
    const map = type === 'encode' ? encodeWorkers : decodeWorkers;
    if (!map.has(key)) map.set(key, makeWorker(type, backend));
    return map.get(key);
}

function destroyWorkers() {
    for (const worker of encodeWorkers.values()) worker.terminate();
    for (const worker of decodeWorkers.values()) worker.terminate();
    encodeWorkers.clear();
    decodeWorkers.clear();
}

function rgbaToCanvas(card, rgba, width, height) {
    card.canvas.width = width;
    card.canvas.height = height;
    const ctx = card.canvas.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height), 0, 0);
}

function scaleImageDataToCanvas(srcCanvas, dstCanvas, dstW, dstH) {
    dstCanvas.width = dstW;
    dstCanvas.height = dstH;
    const ctx = dstCanvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcCanvas, 0, 0, dstW, dstH);
}

function sizeForLongEdge(width, height, longEdge) {
    if (!longEdge || Math.max(width, height) <= longEdge) return { width, height };
    const long = Math.max(width, height);
    return {
        width: Math.max(1, Math.round(width * longEdge / long)),
        height: Math.max(1, Math.round(height * longEdge / long)),
    };
}

function updateCardProgress(card, loaded, total, note) {
    const pct = total > 0 ? Math.max(0, Math.min(100, loaded / total * 100)) : 0;
    card.fill.style.width = `${pct}%`;
    card.bytes.textContent = `${fmtBytes(loaded)} / ${fmtBytes(total)}`;
    if (note) card.notes.textContent = note;
}

function encodeJxl(worker, rgba, width, height, quality = 90, effort = 3, extra = {}) {
    return new Promise((resolve, reject) => {
        const id = worker._nextId++;
        const onMessage = ({ data }) => {
            if (data.id !== id) return;
            worker.removeEventListener('message', onMessage);
            if (data.type === 'done') resolve(data);
            else reject(new Error(data.error || 'JXL encode failed'));
        };
        worker.addEventListener('message', onMessage);
        worker.postMessage({
            id,
            type: 'encode_request',
            rgba: rgba.buffer,
            width,
            height,
            quality,
            effort,
            lossless: false,
            progressive: true,
            ...extra,
        }, [rgba.buffer]);
    });
}

function decodeJxlFallback(worker, url) {
    return new Promise((resolve, reject) => {
        const id = worker._nextId++;
        const onMessage = ({ data }) => {
            if (data.decodeId !== id) return;
            worker.removeEventListener('message', onMessage);
            if (data.type === 'jxl_decoded') resolve(data);
            else reject(new Error(data.error || 'JXL decode failed'));
        };
        worker.addEventListener('message', onMessage);
        worker.postMessage({ type: 'decode_jxl', decodeId: id, url });
    });
}

async function decodeJxlBlob(worker, bytes) {
    const blob = new Blob([bytes], { type: 'image/jxl' });
    const url = URL.createObjectURL(blob);
    try {
        return await decodeJxlFallback(worker, url);
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function decodeJxlFinal(worker, bytes) {
    if (!worker._supportsProgressiveDecode) {
        return decodeJxlBlob(worker, bytes);
    }

    const id = worker._nextId++;
    const request = createProgressiveDecodeRequest({
        worker,
        sessionId: `decode-${id}`,
    });
    request.start();
    try {
        request.push(bytes.slice());
        request.close();
        return await request.done;
    } catch (error) {
        request.cancel(String(error?.message ?? error));
        throw error;
    }
}

async function streamDecodeJxl(worker, bytes, { onChunk, onFrame } = {}, pacingMs = 8) {
    const id = worker._nextId++;
    const request = createProgressiveDecodeRequest({
        worker,
        sessionId: `decode-${id}`,
        onProgress: onFrame,
    });
    let cancelled = false;
    request.start();
    try {
        const streamedResult = await streamBytes(bytes, async (loaded, total, times, chunk) => {
            const shouldContinue = await onChunk?.(loaded, total, times);
            if (shouldContinue === false) {
                cancelled = true;
                request.cancel('decode superseded');
                throw new Error('decode superseded');
            }
            request.push(chunk);
        }, pacingMs);
        request.close();
        const decoded = await request.done;
        return { decoded, streamedResult };
    } catch (error) {
        if (!cancelled) request.cancel(String(error?.message ?? error));
        throw error;
    }
}

async function streamBytes(bytes, onProgress, pacingMs = 8) {
    const total = bytes.byteLength;
    const chunkSize = Math.max(32 * 1024, Math.floor(total / 20));
    let loaded = 0;
    const started = performance.now();
    const marks = [total / 3, (total * 2) / 3, total];
    const times = [null, null, null];
    while (loaded < total) {
        const next = Math.min(total, loaded + chunkSize);
        const chunk = bytes.slice(loaded, next);
        loaded = next;
        const elapsed = performance.now() - started;
        for (let i = 0; i < marks.length; i++) {
            if (times[i] == null && loaded >= marks[i]) times[i] = elapsed;
        }
        await onProgress(loaded, total, times.slice(), chunk);
        await new Promise((resolve) => setTimeout(resolve, pacingMs));
    }
    return { bytes, times };
}

async function loadRandomSource() {
    const resp = await fetch('/api/random-orf', { cache: 'no-store' });
    if (!resp.ok) throw new Error(`random ORF request failed: ${resp.status}`);
    const raw = new Uint8Array(await resp.arrayBuffer());
    const name = resp.headers.get('x-file-name') || 'random.orf';
    const folder = resp.headers.get('x-source-folder') || 'source folder';
    const result = process_orf(raw, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
    try {
        const rgb = result.take_rgb();
        const rgba = rgb_to_rgba(rgb);
        return {
            kind: 'orf',
            raw,
            width: result.width,
            height: result.height,
            rgb,
            rgba,
            label: `${name} · ORF · ${result.width}×${result.height}`,
            meta: `${folder} · ${fmtBytes(raw.byteLength)}`,
        };
    } finally {
        result.free();
    }
}

function clearThumbBenchCard(card) {
    card.grid.innerHTML = '';
    card.log.textContent = 'Waiting for run.';
}

function makeThumbCanvas(size = 20) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    return canvas;
}

function paintContainedCanvas(srcCanvas, dstCanvas) {
    const dst = dstCanvas.width;
    const ctx = dstCanvas.getContext('2d');
    ctx.clearRect(0, 0, dstCanvas.width, dstCanvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const scale = Math.min(dst / srcCanvas.width, dst / srcCanvas.height);
    const drawW = Math.max(1, Math.round(srcCanvas.width * scale));
    const drawH = Math.max(1, Math.round(srcCanvas.height * scale));
    const dx = Math.floor((dst - drawW) / 2);
    const dy = Math.floor((dst - drawH) / 2);
    ctx.drawImage(srcCanvas, dx, dy, drawW, drawH);
}

function makeErrorThumbCanvas(message) {
    const canvas = makeThumbCanvas();
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#3a1010';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#ff7b7b';
    ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
    ctx.fillStyle = '#ffd0d0';
    ctx.font = 'bold 8px Cascadia Mono, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', 10, 10);
    canvas.title = message;
    return canvas;
}

function makeThumbTile(rgba, width, height) {
    const src = rgbaToCanvasEl(rgba, width, height);
    const dst = makeThumbCanvas();
    paintContainedCanvas(src, dst);
    return dst;
}

function makeStandaloneWorker(type, backend) {
    const worker = new Worker(new URL(getWorkerScript(type, backend), import.meta.url), { type: 'module' });
    worker._nextId = workerId++;
    return worker;
}

function makeWorkerLane(encodeBackend, decodeBackend) {
    return {
        encode: makeStandaloneWorker('encode', encodeBackend),
        decode: makeStandaloneWorker('decode', decodeBackend),
        encodeId: 1,
        decodeId: 1,
    };
}

function destroyWorkerLane(lane) {
    lane.encode.terminate();
    lane.decode.terminate();
}

async function loadRandomDistinctSources(count) {
    const wanted = Math.max(1, count | 0);
    const byName = new Map();
    const attempts = wanted * 20;
    let tries = 0;
    while (byName.size < wanted && tries < attempts) {
        tries++;
        const source = await loadRandomSource();
        if (!byName.has(source.label)) byName.set(source.label, source);
    }
    if (byName.size < wanted) {
        throw new Error(`Could only gather ${byName.size}/${wanted} distinct ORFs from random source endpoint`);
    }
    return [...byName.values()].slice(0, wanted);
}

function formatThumbBenchMs(ms) {
    return Number.isFinite(ms) ? `${ms.toFixed(0)} ms` : '--';
}

function escapeMdCell(value) {
    return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function shuffleInPlace(items) {
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
}

function prepareBenchVariant(source, longEdge) {
    const targetDims = sizeForLongEdge(source.width, source.height, longEdge);
    let rgba;
    if (targetDims.width === source.width && targetDims.height === source.height) {
        rgba = source.rgba.slice();
    } else {
        const downRgb = downscale_rgb(source.rgb, source.width, source.height, targetDims.width, targetDims.height);
        rgba = rgb_to_rgba(downRgb);
    }
    return {
        source,
        longEdge,
        targetDims,
        rgba,
    };
}

function buildThumbBenchEncodeOptions(width, height, encodeBackend) {
    if (!thumbBenchProgressive) {
        return { progressive: false };
    }
    const progressiveFlavor = thumbBenchProgressiveDetail;
    if (encodeBackend !== 'libjxl') {
        return { progressive: true };
    }
    return {
        progressive: true,
        progressiveFlavor,
        width,
        height,
    };
}

function appendThumbBenchTile(card, canvas, title) {
    canvas.title = title;
    card.grid.appendChild(canvas);
}

function paintThumbBenchTile(decoded) {
    const srcCanvas = rgbaToCanvasEl(decoded.rgba, decoded.w, decoded.h);
    const tile = makeThumbCanvas(20);
    paintContainedCanvas(srcCanvas, tile);
    return tile;
}

function makeThumbBenchReportLine(label, row) {
    return `| ${escapeMdCell(label)} | ${escapeMdCell(row.source)} | ${row.repeat + 1} | ${row.encodeMs.toFixed(0)} | ${row.decodeMs.toFixed(0)} | ${row.paintMs.toFixed(0)} | ${row.totalMs.toFixed(0)} | ${escapeMdCell(row.note)} |`;
}

function summarizeThumbBenchBlock(rows) {
    const sum = (key) => rows.reduce((acc, row) => acc + (Number.isFinite(row[key]) ? row[key] : 0), 0);
    const count = rows.length || 1;
    return {
        encodeAvg: sum('encodeMs') / count,
        decodeAvg: sum('decodeMs') / count,
        paintAvg: sum('paintMs') / count,
        totalAvg: sum('totalMs') / count,
    };
}

function buildThumbBenchMarkdown({ encodeBackend, decodeBackend, concurrency, detail, progressive, sources, runs }) {
    const startedAt = new Date().toISOString();
    const lines = [];
    lines.push(`# Browser Thumb Bench`);
    lines.push('');
    lines.push(`- started: ${startedAt}`);
    lines.push(`- encode backend: ${encodeBackend}`);
    lines.push(`- decode backend: ${decodeBackend}`);
    lines.push(`- worker concurrency: ${concurrency}`);
    lines.push(`- progressive: ${progressive ? 'on' : 'off'}`);
    lines.push(`- progressive detail: ${progressive ? detail.toUpperCase() : 'n/a'}`);
    lines.push(`- source count: ${sources.length}`);
    lines.push(`- repeats per source: 20`);
    lines.push(`- thumbnail display size: 20px`);
    lines.push(`- encode quality: 90`);
    lines.push(`- encode effort: 3`);
    lines.push('');
    lines.push('## Sources');
    for (const source of sources) {
        lines.push(`- ${escapeMdCell(source.label)} (${fmtBytes(source.raw.byteLength)})`);
    }
    lines.push('');

    for (const sizeRun of runs) {
        lines.push(`## ${sizeRun.longEdge} long`);
        lines.push('');
        lines.push('| # | source | repeat | encode | decode | paint | total | note |');
        lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');
        for (const row of sizeRun.rows) {
            lines.push(makeThumbBenchReportLine(String(row.sequence), row));
        }
        lines.push('');
        lines.push('### Checkpoints');
        lines.push('| images | wall | encode avg | decode avg | paint avg | total avg |');
        lines.push('| ---: | ---: | ---: | ---: | ---: | ---: |');
        for (const checkpoint of sizeRun.checkpoints) {
            lines.push(`| ${checkpoint.done} | ${checkpoint.wallMs.toFixed(0)} | ${checkpoint.encodeAvg.toFixed(0)} | ${checkpoint.decodeAvg.toFixed(0)} | ${checkpoint.paintAvg.toFixed(0)} | ${checkpoint.totalAvg.toFixed(0)} |`);
        }
        lines.push('');
        lines.push(`- size wall: ${sizeRun.wallMs.toFixed(0)} ms`);
        lines.push(`- errors: ${sizeRun.errors}`);
        lines.push('');
    }

    return lines.join('\n');
}

async function writeThumbBenchReport(filename, markdown) {
    const resp = await fetch('/api/timings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename, markdown }),
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`timings write failed: ${resp.status} ${text}`.trim());
    }
    return resp.json();
}

async function runThumbBenchSize(size, sources, runId, encodeBackend, decodeBackend) {
    const card = thumbBenchCards.find((entry) => entry.size === size);
    if (!card) throw new Error(`missing thumb bench card for ${size}`);
    clearThumbBenchCard(card);

    const preparedSources = sources.map((source) => prepareBenchVariant(source, size));
    const jobs = [];
    for (let repeat = 0; repeat < 20; repeat++) {
        for (let sourceIndex = 0; sourceIndex < preparedSources.length; sourceIndex++) {
            jobs.push({ sourceIndex, repeat });
        }
    }
    shuffleInPlace(jobs);

    const concurrency = Math.max(1, thumbBenchConcurrency | 0);
    const pool = Array.from({ length: concurrency }, () => makeWorkerLane(encodeBackend, decodeBackend));
    const rows = [];
    const checkpoints = [];
    let errors = 0;
    let completed = 0;
    let blockRows = [];
    const sizeStarted = performance.now();
    let nextJob = 0;

    const formatSourceLine = () => preparedSources.map((s) => s.source.label).join(' · ');

    const runLane = async (laneIndex) => {
        const lane = pool[laneIndex];
        while (true) {
            if (runId !== thumbBenchRunId) return;
            const jobIndex = nextJob++;
            if (jobIndex >= jobs.length) return;
            const job = jobs[jobIndex];
            const prepared = preparedSources[job.sourceIndex];
            const rowStart = performance.now();
            const label = `${size} long · ${prepared.source.label} · rep ${job.repeat + 1}`;
            let row;
            try {
                const encodeStart = performance.now();
                const encoded = await encodeJxl(
                    lane.encode,
                    prepared.rgba.slice(),
                    prepared.targetDims.width,
                    prepared.targetDims.height,
                    90,
                    3,
                    buildThumbBenchEncodeOptions(prepared.targetDims.width, prepared.targetDims.height, encodeBackend),
                );
                const encodeMs = performance.now() - encodeStart;

                const decodeStart = performance.now();
                const decoded = await decodeJxlFinal(lane.decode, encoded.jxl);
                const decodeMs = performance.now() - decodeStart;

                const paintStart = performance.now();
                const tile = paintThumbBenchTile(decoded);
                const paintMs = performance.now() - paintStart;

                const totalMs = performance.now() - rowStart;
                const title = `${prepared.source.label} · ${size} long · rep ${job.repeat + 1} · enc ${encodeMs.toFixed(0)} ms · dec ${decodeMs.toFixed(0)} ms · paint ${paintMs.toFixed(0)} ms`;
                appendThumbBenchTile(card, tile, title);
                row = {
                    sequence: rows.length + 1,
                    index: jobIndex,
                    source: prepared.source.label,
                    repeat: job.repeat,
                    encodeMs,
                    decodeMs,
                    paintMs,
                    totalMs,
                    note: 'ok',
                };
            } catch (error) {
                errors++;
                const totalMs = performance.now() - rowStart;
                const message = error?.message || String(error);
                const tile = makeErrorThumbCanvas(message);
                appendThumbBenchTile(card, tile, `${label} · error: ${message}`);
                row = {
                    sequence: rows.length + 1,
                    index: jobIndex,
                    source: prepared.source.label,
                    repeat: job.repeat,
                    encodeMs: 0,
                    decodeMs: 0,
                    paintMs: 0,
                    totalMs,
                    note: message,
                };
            }

            rows.push(row);
            blockRows.push(row);
            completed++;
            if (completed % 10 === 0 || completed === jobs.length) {
                const block = summarizeThumbBenchBlock(blockRows);
                const wallMs = performance.now() - sizeStarted;
                checkpoints.push({
                    done: completed,
                    wallMs,
                    encodeAvg: block.encodeAvg,
                    decodeAvg: block.decodeAvg,
                    paintAvg: block.paintAvg,
                    totalAvg: block.totalAvg,
                });
                card.log.textContent = [
                    `source: ${size} long`,
                    `files: ${formatSourceLine()}`,
                    `done: ${completed}/${jobs.length}`,
                    `wall: ${wallMs.toFixed(0)} ms`,
                    `block avg encode: ${block.encodeAvg.toFixed(0)} ms`,
                    `block avg decode: ${block.decodeAvg.toFixed(0)} ms`,
                    `block avg paint: ${block.paintAvg.toFixed(0)} ms`,
                    `errors: ${errors}`,
                    '',
                    ...checkpoints.map((cp) => `${cp.done}/${jobs.length} | wall ${cp.wallMs.toFixed(0)} ms | enc ${cp.encodeAvg.toFixed(0)} | dec ${cp.decodeAvg.toFixed(0)} | paint ${cp.paintAvg.toFixed(0)} | total ${cp.totalAvg.toFixed(0)}`),
                ].join('\n');
                blockRows = [];
            }
        }
    };

    thumbBenchStatus.textContent = `Running ${size} long with ${concurrency} workers.`;
    thumbBenchSettings.textContent = `${encodeBackend} → ${decodeBackend} · progressive ${thumbBenchProgressive ? 'on' : 'off'} ${thumbBenchProgressive ? `· ${thumbBenchProgressiveDetail.toUpperCase()}` : ''}`;
    await Promise.all(pool.map((_, laneIndex) => runLane(laneIndex)));
    const wallMs = performance.now() - sizeStarted;
    for (const lane of pool) destroyWorkerLane(lane);
    card.log.textContent = [
        `source: ${size} long`,
        `files: ${formatSourceLine()}`,
        `done: ${completed}/${jobs.length}`,
        `wall: ${wallMs.toFixed(0)} ms`,
        `errors: ${errors}`,
        '',
        ...checkpoints.map((cp) => `${cp.done}/${jobs.length} | wall ${cp.wallMs.toFixed(0)} ms | enc ${cp.encodeAvg.toFixed(0)} | dec ${cp.decodeAvg.toFixed(0)} | paint ${cp.paintAvg.toFixed(0)} | total ${cp.totalAvg.toFixed(0)}`),
    ].join('\n');

    return {
        longEdge: size,
        rows,
        checkpoints,
        wallMs,
        errors,
    };
}

async function runThumbBench() {
    if (thumbBenchRunBtn) thumbBenchRunBtn.disabled = true;
    const runId = ++thumbBenchRunId;
    const sizes = [...thumbBenchSizes].sort((a, b) => a - b);
    const encodeBackend = session.encodeBackend;
    const decodeBackend = session.decodeBackend;
    if (!sizes.length) {
        setThumbBenchSize(300, true);
        setThumbBenchSize(800, true);
    }

    thumbBenchStatus.textContent = 'Loading 5 random ORFs.';
    thumbBenchSettings.textContent = `${encodeBackend} → ${decodeBackend} · progressive ${thumbBenchProgressive ? 'on' : 'off'} ${thumbBenchProgressive ? `· ${thumbBenchProgressiveDetail.toUpperCase()}` : ''} · concurrency ${thumbBenchConcurrency}`;

    try {
        await initRaw();
        const sources = await loadRandomDistinctSources(5);
        if (runId !== thumbBenchRunId) return;

        const runs = [];
        for (const size of sizes) {
            if (runId !== thumbBenchRunId) return;
            const result = await runThumbBenchSize(size, sources, runId, encodeBackend, decodeBackend);
            runs.push(result);
        }

        if (runId !== thumbBenchRunId) return;
        const markdown = buildThumbBenchMarkdown({
            encodeBackend,
            decodeBackend,
            concurrency: thumbBenchConcurrency,
            detail: thumbBenchProgressiveDetail,
            progressive: thumbBenchProgressive,
            sources,
            runs,
        });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safeEncode = encodeBackend.replace(/[^a-z0-9_-]+/gi, '-');
        const safeDecode = decodeBackend.replace(/[^a-z0-9_-]+/gi, '-');
        const safeDetail = thumbBenchProgressive ? thumbBenchProgressiveDetail : 'off';
        const filename = `${stamp.slice(0, 10)}-browser-thumbbench-300-800-${safeEncode}-${safeDecode}-c${thumbBenchConcurrency}-${safeDetail}.md`;
        const writeResult = await writeThumbBenchReport(filename, markdown);
        if (runId !== thumbBenchRunId) return;
        thumbBenchStatus.textContent = `Done. Saved ${writeResult.path || filename}.`;
        thumbBenchSettings.textContent = `${encodeBackend} → ${decodeBackend} · progressive ${thumbBenchProgressive ? 'on' : 'off'} ${thumbBenchProgressive ? `· ${thumbBenchProgressiveDetail.toUpperCase()}` : ''} · concurrency ${thumbBenchConcurrency}`;
        setStatus(`Thumb bench done. Saved ${writeResult.path || filename}.`);
    } catch (error) {
        if (runId !== thumbBenchRunId) return;
        const message = error?.message || String(error);
        thumbBenchStatus.textContent = `Failed: ${message}`;
        setStatus(`Thumb bench failed: ${message}`);
    } finally {
        if (thumbBenchRunBtn) thumbBenchRunBtn.disabled = false;
    }
}

async function runVariant(source, target, runId) {
    const mode = decodeMode;
    const progressivePreview = previewMode;
    const encodeBackend = session.encodeBackend;
    const decodeBackend = session.decodeBackend;
    const stepCount = getProgressiveStepCount();
    const card = cards.find((entry) => entry.slot === target.slot);
    const targetDims = target.longEdge ? sizeForLongEdge(source.width, source.height, target.longEdge) : { width: source.width, height: source.height };
    const actualEncodeBackend = encodeBackendForTarget(encodeBackend, targetDims.width, targetDims.height);
    const worker = getWorker('encode', actualEncodeBackend, target.slot);
    const decodeWorker = getWorker('decode', decodeBackend, target.slot);

    card.el.dataset.state = 'working';
    const encodeLabel = actualEncodeBackend === encodeBackend ? encodeBackend : `${encodeBackend}→${actualEncodeBackend}`;
    card.badge.textContent = `${target.badge} · enc ${encodeLabel} · dec ${decodeBackend}`;
    card.notes.textContent = `Preparing ${target.label} with enc ${encodeLabel} / dec ${decodeBackend}.`;
    card.fill.style.width = '0%';
    card.bytes.textContent = '0 / 0';
    card.timings.textContent = '1/3: -- · 2/3: -- · end: --';

    let rgba;
    if (source.kind === 'orf') {
        if (targetDims.width === source.width && targetDims.height === source.height) {
            rgba = source.rgba.slice();
        } else {
            const downRgb = downscale_rgb(source.rgb, source.width, source.height, targetDims.width, targetDims.height);
            rgba = rgb_to_rgba(downRgb);
        }
    } else {
        const srcCanvas = source.canvas || document.createElement('canvas');
        if (!source.canvas) {
            srcCanvas.width = source.width;
            srcCanvas.height = source.height;
            const ctx = srcCanvas.getContext('2d');
            ctx.putImageData(new ImageData(new Uint8ClampedArray(source.rgba.buffer.slice(0)), source.width, source.height), 0, 0);
        }
        const workCanvas = document.createElement('canvas');
        scaleImageDataToCanvas(srcCanvas, workCanvas, targetDims.width, targetDims.height);
        const data = workCanvas.getContext('2d').getImageData(0, 0, workCanvas.width, workCanvas.height).data;
        rgba = new Uint8Array(data.buffer.slice(0));
    }

    if (runId !== activeRunId) return;
    const srcLong = Math.max(source.width, source.height);
    card.notes.textContent = `Encoding ${target.label} from ${srcLong} px source edge.`;
    const showSourcePlayback = mode === 'progressive' && (progressivePreview === 'source' || decodeBackend === 'jsquash');
    if (showSourcePlayback) {
        startPreviewPlayback(card, source, targetDims, stepCount, runId);
    } else {
        stopPreviewPlayback(card);
        card._previewFrames = null;
        card._previewStep = -1;
    }
    const encodeResult = await encodeJxl(worker, new Uint8Array(rgba.buffer.slice(0)), targetDims.width, targetDims.height, 90, 3);
    if (runId !== activeRunId) return;
    card._source = source;
    card._targetDims = targetDims;
    const jxlBytes = encodeResult.jxl;
    card._jxlBytes = new Uint8Array(jxlBytes.buffer.slice(0));
    card.encodeMs = encodeResult.jxlMs;
    card.encode.textContent = `encode: ${encodeResult.jxlMs.toFixed(0)} ms`;

    card.el.dataset.state = 'streaming';
    card.notes.textContent = `Streaming JXL bytes for ${target.label}.`;
    const decodeStart = performance.now();
    const pacingMs = target.slot === 'full' ? 12 : 8;
    const updateStreamProgress = (loaded, total, times) => {
        if (runId !== activeRunId) return false;
        updateCardProgress(card, loaded, total, `Loaded ${fmtBytes(loaded)} of ${fmtBytes(total)}.`);
        const formatMs = (ms) => (ms == null ? '--' : `${ms.toFixed(0)} ms`);
        card.timings.textContent = `1/3: ${formatMs(times[0])} · 2/3: ${formatMs(times[1])} · end: ${formatMs(times[2])}`;
        return true;
    };

    if (mode === 'progressive' && decodeBackend === 'libjxl' && progressivePreview === 'stream') {
        const { decoded, streamedResult } = await streamDecodeJxl(decodeWorker, jxlBytes, {
            onChunk: updateStreamProgress,
            onFrame: (frame) => {
                if (runId !== activeRunId) return;
                rgbaToCanvas(card, frame.rgba, frame.w, frame.h);
                card.notes.textContent = `libjxl preview ${frame.w}×${frame.h}.`;
            },
        }, pacingMs);
        if (runId !== activeRunId) return;
        stopPreviewPlayback(card);
        rgbaToCanvas(card, decoded.rgba, decoded.w, decoded.h);
        card.el.dataset.state = 'done';
        card.fill.style.width = '100%';
        card.bytes.textContent = `${fmtBytes(jxlBytes.byteLength)} / ${fmtBytes(jxlBytes.byteLength)}`;
        card.timings.textContent = `1/3: ${streamedResult.times[0] == null ? '--' : `${streamedResult.times[0].toFixed(0)} ms`} · 2/3: ${streamedResult.times[1] == null ? '--' : `${streamedResult.times[1].toFixed(0)} ms`} · end: ${streamedResult.times[2] == null ? '--' : `${streamedResult.times[2].toFixed(0)} ms`}`;
        card.notes.textContent = `Decoded ${decoded.w}×${decoded.h} in ${(performance.now() - decodeStart).toFixed(0)} ms.`;
        return;
    }

    const streamedResult = await streamBytes(jxlBytes, updateStreamProgress, pacingMs);
    const streamed = streamedResult.bytes;

    if (runId !== activeRunId) return;
    card.el.dataset.state = 'decoding';
    card.notes.textContent = `Decoding ${target.label} from JXL.`;
    stopPreviewPlayback(card);
    const decoded = await decodeJxlFinal(decodeWorker, streamed);
    if (runId !== activeRunId) return;
    rgbaToCanvas(card, decoded.rgba, decoded.w, decoded.h);
    card.el.dataset.state = 'done';
    card.fill.style.width = '100%';
    card.bytes.textContent = `${fmtBytes(streamed.byteLength)} / ${fmtBytes(streamed.byteLength)}`;
    card.timings.textContent = `1/3: ${streamedResult.times[0] == null ? '--' : `${streamedResult.times[0].toFixed(0)} ms`} · 2/3: ${streamedResult.times[1] == null ? '--' : `${streamedResult.times[1].toFixed(0)} ms`} · end: ${streamedResult.times[2] == null ? '--' : `${streamedResult.times[2].toFixed(0)} ms`}`;
    card.notes.textContent = `Decoded ${decoded.w}×${decoded.h} in ${(performance.now() - decodeStart).toFixed(0)} ms.`;
}

async function replayDecodeCard(card, runId) {
    const mode = decodeMode;
    const progressivePreview = previewMode;
    const decodeBackend = session.decodeBackend;
    if (!card._jxlBytes?.byteLength) return;
    const targetDims = card._targetDims || { width: card.canvas.width, height: card.canvas.height };
    const canShowSourcePlayback = mode === 'progressive' && card._source && (progressivePreview === 'source' || decodeBackend === 'jsquash');
    if (canShowSourcePlayback) {
        startPreviewPlayback(card, card._source, targetDims, getProgressiveStepCount(), runId);
    } else {
        stopPreviewPlayback(card);
        card._previewFrames = null;
        card._previewStep = -1;
    }
    const decodeWorker = getWorker('decode', decodeBackend, card.slot);
    card.el.dataset.state = 'decoding';
    card.fill.style.width = '0%';
    card.bytes.textContent = `0 / ${fmtBytes(card._jxlBytes.byteLength)}`;
    card.timings.textContent = '1/3: -- · 2/3: -- · end: --';
    card.notes.classList.add('replay-countdown');
    card.notes.textContent = '1000 ms';
    const ctx = card.canvas.getContext('2d');
    ctx.clearRect(0, 0, card.canvas.width, card.canvas.height);

    const blankStarted = performance.now();
    while (true) {
        const elapsed = performance.now() - blankStarted;
        const remaining = Math.max(0, 1000 - elapsed);
        card.notes.textContent = `${remaining.toFixed(0)} ms`;
        if (remaining <= 0) break;
        await sleep(50);
        if (runId !== activeRunId) return;
    }
    card.notes.classList.remove('replay-countdown');

    const decodeStart = performance.now();
    if (mode === 'progressive' && canShowSourcePlayback) {
        card.notes.textContent = `Progressive preview enabled (${card._previewFrames.length} steps).`;
    }
    const pacingMs = card.slot === 'full' ? 12 : 8;
    const updateStreamProgress = (loaded, total, times) => {
        if (runId !== activeRunId) return false;
        updateCardProgress(card, loaded, total, `Loaded ${fmtBytes(loaded)} of ${fmtBytes(total)}.`);
        const formatMs = (ms) => (ms == null ? '--' : `${ms.toFixed(0)} ms`);
        card.timings.textContent = `1/3: ${formatMs(times[0])} · 2/3: ${formatMs(times[1])} · end: ${formatMs(times[2])}`;
        return true;
    };

    if (mode === 'progressive' && decodeBackend === 'libjxl' && progressivePreview === 'stream') {
        const { decoded, streamedResult } = await streamDecodeJxl(decodeWorker, card._jxlBytes, {
            onChunk: updateStreamProgress,
            onFrame: (frame) => {
                if (runId !== activeRunId) return;
                rgbaToCanvas(card, frame.rgba, frame.w, frame.h);
                card.notes.textContent = `libjxl preview ${frame.w}×${frame.h}.`;
            },
        }, pacingMs);
        if (runId !== activeRunId) return;

        stopPreviewPlayback(card);
        rgbaToCanvas(card, decoded.rgba, decoded.w, decoded.h);
        card.el.dataset.state = 'done';
        card.fill.style.width = '100%';
        card.bytes.textContent = `${fmtBytes(card._jxlBytes.byteLength)} / ${fmtBytes(card._jxlBytes.byteLength)}`;
        card.timings.textContent = `1/3: ${streamedResult.times[0] == null ? '--' : `${streamedResult.times[0].toFixed(0)} ms`} · 2/3: ${streamedResult.times[1] == null ? '--' : `${streamedResult.times[1].toFixed(0)} ms`} · end: ${streamedResult.times[2] == null ? '--' : `${streamedResult.times[2].toFixed(0)} ms`}`;
        card.notes.textContent = `Replay decode: ${decoded.w}×${decoded.h} in ${(performance.now() - decodeStart).toFixed(0)} ms.`;
        return;
    }

    const streamedResult = await streamBytes(card._jxlBytes, updateStreamProgress, pacingMs);
    if (runId !== activeRunId) return;

    stopPreviewPlayback(card);
    const decoded = await decodeJxlFinal(decodeWorker, streamedResult.bytes);
    if (runId !== activeRunId) return;
    rgbaToCanvas(card, decoded.rgba, decoded.w, decoded.h);
    card.el.dataset.state = 'done';
    card.fill.style.width = '100%';
    card.bytes.textContent = `${fmtBytes(streamedResult.bytes.byteLength)} / ${fmtBytes(streamedResult.bytes.byteLength)}`;
    card.notes.textContent = `Replay decode: ${decoded.w}×${decoded.h} in ${(performance.now() - decodeStart).toFixed(0)} ms.`;
}

function wireModeControls() {
    syncProgressiveStepLabel();
    setDecodeMode('final');
    for (const button of modeButtons) {
        button.addEventListener('click', () => {
            setDecodeMode(button.dataset.decodeMode);
        });
    }
    progressiveStepsInput.addEventListener('input', () => {
        syncProgressiveStepLabel();
    });
}

function wirePreviewControls() {
    setPreviewMode('source');
    for (const button of previewModeButtons) {
        button.addEventListener('click', () => {
            const next = button.dataset.previewMode;
            if (next === previewMode) return;
            setPreviewMode(next);
            setStatus(`Progressive preview set to ${next}. Re-running the same source file.`);
            if (session.source) {
                runLadder().catch((error) => {
                    setStatus(`Failed: ${error?.message || error}`);
                });
            }
        });
    }
}

function wireThumbBenchControls() {
    setThumbBenchConcurrency(thumbBenchConcurrency);
    setThumbBenchProgressive(true);
    setThumbBenchDetail('dc');
    setThumbBenchSize(300, true);
    setThumbBenchSize(800, true);

    if (thumbBenchConcurrencyInput) {
        thumbBenchConcurrencyInput.addEventListener('input', () => {
            setThumbBenchConcurrency(thumbBenchConcurrencyInput.value);
        });
    }

    for (const button of thumbBenchSizeButtons) {
        button.addEventListener('click', () => {
            const size = Number(button.dataset.thumbSize);
            setThumbBenchSize(size, !thumbBenchSizes.has(size));
        });
    }

    for (const button of thumbBenchProgressiveButtons) {
        button.addEventListener('click', () => {
            setThumbBenchProgressive(button.dataset.thumbProgressive === 'on');
        });
    }

    for (const button of thumbBenchDetailButtons) {
        button.addEventListener('click', () => {
            setThumbBenchDetail(button.dataset.thumbDetail);
        });
    }

    if (thumbBenchRunBtn) {
        thumbBenchRunBtn.addEventListener('click', () => {
            runThumbBench().catch((error) => {
                setThumbBenchStatus(`Failed: ${error?.message || error}`);
            });
        });
    }
}

function wireBackendControls() {
    setEncodeBackend(session.encodeBackend);
    setDecodeBackend(session.decodeBackend);
    for (const button of encodeBackendButtons) {
        button.addEventListener('click', () => {
            const next = button.dataset.encodeBackend;
            if (next === session.encodeBackend) return;
            setEncodeBackend(next);
            if (session.source) {
                runLadder().catch((error) => {
                    setStatus(`Failed: ${error?.message || error}`);
                });
            }
        });
    }
    for (const button of decodeBackendButtons) {
        button.addEventListener('click', () => {
            const next = button.dataset.decodeBackend;
            if (next === session.decodeBackend) return;
            setDecodeBackend(next);
            if (session.source) {
                runLadder().catch((error) => {
                    setStatus(`Failed: ${error?.message || error}`);
                });
            }
        });
    }
}

async function runLadder() {
    activeRunId++;
    const runId = activeRunId;
    resetAllCards();
    setStatus(session.source ? 'Reusing cached ORF.' : 'Loading random ORF.');
    replayBtn.disabled = true;

    try {
        await initRaw();
        const source = await session.ensureSource();
        if (runId !== activeRunId) return;
        setSourceMeta(source.meta);
        setStatus(`Source ready. Building three JXL variants with enc ${session.encodeBackend} / dec ${session.decodeBackend}.`);
        for (const card of cards) {
            card.notes.textContent = `${source.label}`;
            const ctx = card.canvas.getContext('2d');
            ctx.clearRect(0, 0, card.canvas.width, card.canvas.height);
        }
        const tasks = TARGETS.map((target) => runVariant(source, target, runId).catch((error) => {
            if (runId !== activeRunId) return;
            const card = cards.find((entry) => entry.slot === target.slot);
            card.el.dataset.state = 'error';
            card.notes.textContent = error?.message || String(error);
            card.badge.textContent = 'error';
        }));
        await Promise.all(tasks);
        if (runId !== activeRunId) return;
        setStatus('Done. Smaller variants should establish the subject first.');
        replayBtn.disabled = false;
    } catch (error) {
        if (runId !== activeRunId) return;
        setStatus(`Failed: ${error?.message || error}`);
    }
}

runBtn.addEventListener('click', () => {
    runBtn.disabled = true;
    runLadder().finally(() => {
        runBtn.disabled = false;
    });
});

replayBtn.addEventListener('click', () => {
    if (!cards.some((card) => card._jxlBytes?.byteLength)) return;
    activeRunId++;
    const runId = activeRunId;
    replayBtn.disabled = true;
    setStatus('Replaying decode only.');
    Promise.all(cards.map((card) => replayDecodeCard(card, runId).catch((error) => {
        if (runId !== activeRunId) return;
        card.el.dataset.state = 'error';
        card.notes.textContent = error?.message || String(error);
    }))).then(() => {
        if (runId !== activeRunId) return;
        setStatus('Replay complete.');
    }).finally(() => {
        replayBtn.disabled = false;
    });
});

document.addEventListener('keydown', (event) => {
    if (event.repeat) return;
    if (event.key === 'r' || event.key === 'R') {
        if (!replayBtn.disabled) replayBtn.click();
    }
});

resetBtn.addEventListener('click', async () => {
    activeRunId++;
    resetAllCards();
    setStatus('Loading random ORF.');
    destroyWorkers();
    await session.reloadSource();
    runLadder().catch((error) => {
        setStatus(`Failed: ${error?.message || error}`);
    });
});

resetAllCards();
setSourceMeta('Ready to load a random ORF.');
setStatus('Loading random ORF.');
wireModeControls();
wireBackendControls();
wirePreviewControls();
wireThumbBenchControls();
setThumbBenchStatus('Idle.');
setThumbBenchSettings(`encode ${session.encodeBackend} · decode ${session.decodeBackend} · progressive ${thumbBenchProgressive ? 'on' : 'off'} · concurrency ${thumbBenchConcurrency}`);
runLadder().catch((error) => {
    setStatus(`Failed: ${error?.message || error}`);
});
