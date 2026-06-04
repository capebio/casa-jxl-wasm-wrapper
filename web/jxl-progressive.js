import initRaw, { process_orf, rgb_to_rgba, downscale_rgb } from './pkg/raw_converter_wasm.js';
import { createProgressiveSession } from './jxl-progressive-session.js';
import { encodeBackendForTarget } from './jxl-progressive-policy.js';
import { createProgressiveDecodeRequest } from './jxl-progressive-decode.js';
import { getContext } from './jxl-browser-context.js';
import {
    bindRangeLabel,
    clamp,
    setCssVar,
    setGroupDisabled,
    wireHelpPopovers,
    wireSlideoutPanel,
} from './jxl-dashboard-ui.js';
import { initDebugConsole, dbgLog } from './jxl-debug-console.js';

// Console page header — always shows which page this console belongs to (dev productivity across many open lab/benchmark tabs)
console.log('%c[Progressive] jxl-progressive.js loaded — progressive decode / paint / gallery experiments', 'color:#8b5cf6;font-weight:600', { page: 'Progressive', url: location.href, t: new Date().toISOString(), ua: navigator.userAgent.slice(0, 120) });

const runBtn = document.getElementById('run-btn');
const replayBtn = document.getElementById('replay-btn');
const resetBtn = document.getElementById('reset-btn');
const modeButtons = [...document.querySelectorAll('[data-decode-mode]')];
const encodeBackendButtons = [...document.querySelectorAll('[data-encode-backend]')];
const decodeBackendButtons = [...document.querySelectorAll('[data-decode-backend]')];
const previewModeButtons = [...document.querySelectorAll('[data-preview-mode]')];
const progressiveDetailButtons = [...document.querySelectorAll('[data-progressive-detail]')];
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
const transportChunkKbInput = document.getElementById('transport-chunk-kb');
const transportChunkKbValue = document.getElementById('transport-chunk-kb-value');
const transportIterationsInput = document.getElementById('transport-iterations');
const transportIterationsValue = document.getElementById('transport-iterations-value');
const transportPacingInput = document.getElementById('transport-pacing-ms');
const transportPacingValue = document.getElementById('transport-pacing-ms-value');
const transportNoPacingInput = document.getElementById('transport-no-pacing');
const transportPreviewFirstInput = document.getElementById('transport-preview-first');
const transportChunkedInput = document.getElementById('transport-chunked');
const thumbDisplayInput = document.getElementById('thumb-display-size');
const thumbDisplayValue = document.getElementById('thumb-display-size-value');
const progressiveDashboard = document.getElementById('progressive-dashboard');
const progressiveControlsBtn = document.getElementById('progressive-controls-btn');
const progressiveControlsClose = document.getElementById('progressive-controls-close');
const dbgConsoleBtn = document.getElementById('dbg-console-btn');
const statusText = document.getElementById('status-text');
const sourceMeta = document.getElementById('source-meta');
const raceBtn = document.getElementById('race-btn');
const raceResult = document.getElementById('race-result');

const cards = [...document.querySelectorAll('.card')].map((card) => ({
    el: card,
    slot: card.dataset.slot,
    canvas: card.querySelector('canvas'),
    fill: card.querySelector('.fill'),
    bytes: card.querySelector('.bytes'),
    encode: card.querySelector('.encode'),
    timings: card.querySelector('.timings'),
    timingSegRow: card.querySelector('[data-timing-seg-row]'),
    notes: card.querySelector('.notes'),
    badge: card.querySelector('.badge'),
    defaultBadge: card.querySelector('.badge').textContent,
    errorDetail: card.querySelector('.error-detail'),
    errorText: card.querySelector('.error-text'),
    errorCopyBtn: card.querySelector('.error-copy-btn'),
}));

for (const card of cards) {
    card.badge.addEventListener('click', () => {
        if (card.el.dataset.state !== 'error') return;
        card.errorDetail.classList.toggle('is-open');
    });
    card.errorCopyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(card.errorText.textContent).then(() => {
            card.errorCopyBtn.textContent = 'Copied!';
            card.errorCopyBtn.classList.add('copied');
            setTimeout(() => {
                card.errorCopyBtn.textContent = 'Copy';
                card.errorCopyBtn.classList.remove('copied');
            }, 2000);
        });
    });
}

const TARGETS = [
    { slot: 'thumb', label: '300 long', longEdge: 300, badge: 'small thumb' },
    { slot: 'mid', label: '800 long', longEdge: 800, badge: 'large thumb' },
    { slot: 'full', label: 'Full size', longEdge: null, badge: 'reference' },
];
const INITIAL_PREVIEW_LONG_EDGE = 1200;
const THUMB_BENCH_DECODE_PRIORITY = 'near';

let activeRunId = 0;
let decodeMode = 'progressive';
let previewMode = 'stream';
let progressiveDetail = 'dc';
let thumbBenchRunId = 0;
let thumbBenchConcurrency = Number(thumbBenchConcurrencyInput?.value) || 4;
let thumbBenchProgressive = true;
let thumbBenchProgressiveDetail = 'dc';
let thumbBenchSizes = new Set([300, 800]);
let transportChunkKb = Number(transportChunkKbInput?.value) || 32;
let transportIterations = Number(transportIterationsInput?.value) || 20;
let transportPacingMs = Number(transportPacingInput?.value) || 8;
let transportNoPacing = Boolean(transportNoPacingInput?.checked);
let transportPreviewFirst = Boolean(transportPreviewFirstInput?.checked ?? true);
let transportChunked = Boolean(transportChunkedInput?.checked ?? true);
let thumbDisplaySize = Number(thumbDisplayInput?.value) || 20;
let thumbBenchSources = null;
const session = createProgressiveSession({
    initialEncodeBackend: 'libjxl',
    initialDecodeBackend: 'libjxl',
    loadSource: loadRandomSource,
});

const encodeWorkers = new Map();
const decodeWorkers = new Map();
let workerId = 1;

function getWorkerScript(_type, _backend) {
    // Only jsquash decode still uses a raw worker.
    return './jxl-decode-worker.js';
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

function fmtTiming(ms) {
    return ms == null ? '--' : `${ms.toFixed(0)} ms`;
}

// ── timing pipeline bar ───────────────────────────────────────────
const TIMING_PHASES = [
    { key: 'loadMs',   label: 'Load', color: '#f59e0b' },
    { key: 'encodeMs', label: 'Enc',  color: '#34d399' },
    { key: 'decodeMs', label: 'Dec',  color: '#7dd3fc' },
];

function renderTimingBar(card) {
    const row = card.timingSegRow;
    if (!row) return;

    const phases = TIMING_PHASES
        .map((p) => ({ ...p, ms: card[p.key] }))
        .filter((p) => p.ms != null && p.ms > 0);

    const sum = phases.reduce((acc, p) => acc + p.ms, 0);
    const norm = sum > 0 ? sum : 1;

    row.innerHTML = '';

    if (!phases.length) {
        const empty = document.createElement('div');
        empty.className = 'timing-seg-empty';
        empty.textContent = 'no data';
        row.appendChild(empty);
        return;
    }

    for (const phase of phases) {
        const pct = Math.max(4, (phase.ms / norm) * 100).toFixed(1);
        const el = document.createElement('div');
        el.className = 'timing-seg is-visible';
        el.style.cssText = `--pct:${pct}%; --seg-color:${phase.color}`;
        el.title = `${phase.label}: ${phase.ms.toFixed(0)} ms`;
        const label = document.createElement('span');
        label.className = 'timing-seg-label';
        label.textContent = phase.label;
        const ms = document.createElement('span');
        ms.className = 'timing-seg-ms';
        ms.textContent = `${phase.ms.toFixed(0)}`;
        el.appendChild(label);
        el.appendChild(ms);
        row.appendChild(el);
    }
}

function formatProgressiveTimings(timings = {}, live = {}) {
    const parts = [];
    parts.push(`load ${fmtTiming(timings.loadMs)}`);
    if (live.phase === 'encode' && timings.encodeMs == null && live.elapsedMs != null) {
        parts.push(`encode running ${fmtTiming(live.elapsedMs)}`);
    } else {
        parts.push(`encode ${fmtTiming(timings.encodeMs)}`);
    }
    parts.push(`first piece ${fmtTiming(timings.firstPieceMs)}`);
    parts.push(`first paint ${fmtTiming(timings.firstPaintMs)}`);
    if (live.phase === 'decode' && timings.decodeMs == null && live.elapsedMs != null) {
        parts.push(`decode running ${fmtTiming(live.elapsedMs)}`);
    } else if (timings.decodeMs != null) {
        parts.push(`decode ${fmtTiming(timings.decodeMs)}`);
    }
    if (timings.totalMs != null) parts.push(`total ${fmtTiming(timings.totalMs)}`);
    return parts.join('\n');
}

function refreshThumbBenchSummary() {
    setThumbBenchSettings(
        `${session.encodeBackend} -> ${session.decodeBackend} | progressive ${thumbBenchProgressive ? 'on' : 'off'}`
        + `${thumbBenchProgressive ? ` | ${thumbBenchProgressiveDetail.toUpperCase()}` : ''}`
        + ` | chunk ${transportChunkKb} KB`
        + ` | iterations ${transportIterations}`
        + ` | pace ${transportNoPacing ? 'none' : `${transportPacingMs} ms`}`
        + ` | preview-first ${transportPreviewFirst ? 'on' : 'off'}`
        + ` | chunked ${transportChunked ? 'on' : 'off'}`
    );
}

function resetCard(card, note = 'Waiting for source.') {
    card.el.dataset.state = 'idle';
    card.fill.style.width = '0%';
    card.bytes.textContent = '0 / 0';
    card.encode.textContent = 'encode: --';
    card._timingStartedAt = performance.now();
    card._firstPaintMs = null;
    card.loadMs = card._source?.loadMs ?? null;
    card.firstPieceMs = null;
    card.decodeMs = null;
    card.timings.textContent = formatProgressiveTimings({ loadMs: card.loadMs });
    card.notes.textContent = note;
    card.badge.textContent = card.defaultBadge;
    card.errorDetail.classList.remove('is-open');
    card.errorText.textContent = '';
    card._jxlBytes = null;
    card._source = null;
    card._targetDims = null;
    card._previewFrames = null;
    card._previewStep = -1;
    card.encodeMs = null;
    card.decodeMs = null;
    card.loadMs = null;
    card.firstPieceMs = null;
    card.firstPaintMs = null;
    card.countdown = null;
    card._encodeStartedAt = null;
    stopPreviewPlayback(card);
    const ctx = card.canvas.getContext('2d');
    card.canvas.width = 16;
    card.canvas.height = 16;
    ctx.clearRect(0, 0, card.canvas.width, card.canvas.height);
    renderTimingBar(card);
}

function resetAllCards() {
    for (const card of cards) resetCard(card);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function getProgressiveStepCount() {
    return clamp(Number(progressiveStepsInput.value) || 4, 2, 8);
}

function syncProgressiveStepLabel() {
    progressiveStepsValue.textContent = String(getProgressiveStepCount());
}

function setProgressiveDetail(detail) {
    progressiveDetail = detail === 'ac' ? 'ac' : 'dc';
    for (const button of progressiveDetailButtons) {
        const active = button.dataset.progressiveDetail === progressiveDetail;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
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
    refreshThumbBenchSummary();
}

function setThumbBenchProgressive(enabled) {
    thumbBenchProgressive = Boolean(enabled);
    for (const button of thumbBenchProgressiveButtons) {
        const active = button.dataset.thumbProgressive === (thumbBenchProgressive ? 'on' : 'off');
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    refreshThumbBenchSummary();
}

function setThumbBenchDetail(detail) {
    thumbBenchProgressiveDetail = detail === 'ac' ? 'ac' : 'dc';
    for (const button of thumbBenchDetailButtons) {
        const active = button.dataset.thumbDetail === thumbBenchProgressiveDetail;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    refreshThumbBenchSummary();
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

function syncTransportControls() {
    if (transportChunkKbInput) {
        transportChunkKb = clamp(Number(transportChunkKbInput.value) || 32, 16, 512);
        transportChunkKbInput.value = String(transportChunkKb);
        if (transportChunkKbValue) transportChunkKbValue.textContent = String(transportChunkKb);
    }
    if (transportIterationsInput) {
        transportIterations = clamp(Number(transportIterationsInput.value) || 20, 4, 60);
        transportIterationsInput.value = String(transportIterations);
        if (transportIterationsValue) transportIterationsValue.textContent = String(transportIterations);
    }
    if (transportPacingInput) {
        transportPacingMs = clamp(Number(transportPacingInput.value) || 8, 0, 80);
        transportPacingInput.value = String(transportPacingMs);
        if (transportPacingValue) transportPacingValue.textContent = String(transportPacingMs);
    }
    transportNoPacing = Boolean(transportNoPacingInput?.checked);
    if (transportNoPacing) {
        transportPacingMs = 0;
        if (transportPacingInput) transportPacingInput.value = '0';
        if (transportPacingValue) transportPacingValue.textContent = '0';
    }
    if (transportPacingInput) transportPacingInput.disabled = transportNoPacing;
    transportPacingInput?.closest('.setting')?.classList.toggle('is-disabled', transportNoPacing);
    transportPreviewFirst = Boolean(transportPreviewFirstInput?.checked ?? true);
    transportChunked = Boolean(transportChunkedInput?.checked ?? true);
    refreshThumbBenchSummary();
}

function syncDisplayControls() {
    if (thumbDisplayInput) {
        thumbDisplaySize = clamp(Number(thumbDisplayInput.value) || 20, 12, 64);
        thumbDisplayInput.value = String(thumbDisplaySize);
        if (thumbDisplayValue) thumbDisplayValue.textContent = String(thumbDisplaySize);
        setCssVar('--thumb-size', `${thumbDisplaySize}px`);
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
            markFirstPaint(card);
            card.notes.textContent = `Source playback ${card._previewFrames[stepIndex].label} | waiting for JXL encode.`;
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

function markFirstPaint(card) {
    if (card._firstPaintMs == null && card._timingStartedAt != null) {
        card._firstPaintMs = performance.now() - card._timingStartedAt;
    }
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

function paintPreparedPreview(card, source, rgba, targetDims) {
    const previewDims = sizeForLongEdge(targetDims.width, targetDims.height, INITIAL_PREVIEW_LONG_EDGE);
    if (previewDims.width === targetDims.width && previewDims.height === targetDims.height) {
        rgbaToCanvas(card, rgba, targetDims.width, targetDims.height);
        markFirstPaint(card);
        return;
    }

    if (source.kind === 'orf' && targetDims.width === source.width && targetDims.height === source.height) {
        const previewRgb = downscale_rgb(source.rgb, source.width, source.height, previewDims.width, previewDims.height);
        rgbaToCanvas(card, rgb_to_rgba(previewRgb), previewDims.width, previewDims.height);
        markFirstPaint(card);
        return;
    }

    const srcCanvas = rgbaToCanvasEl(rgba, targetDims.width, targetDims.height);
    scaleImageDataToCanvas(srcCanvas, card.canvas, previewDims.width, previewDims.height);
    markFirstPaint(card);
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
        }, { pacingMs, chunkSize: transportChunkKb * 1024, iterations: transportIterations });
        request.close();
        const decoded = await request.done;
        return { decoded, streamedResult };
    } catch (error) {
        if (!cancelled) request.cancel(String(error?.message ?? error));
        throw error;
    }
}

async function streamBytes(bytes, onProgress, { pacingMs = transportNoPacing ? 0 : transportPacingMs, chunkSize = transportChunkKb * 1024, iterations = transportIterations } = {}) {
    const total = bytes.byteLength;
    const requestedIterations = clamp(Number(iterations) || 0, 1, 120);
    const resolvedChunkSize = clamp(
        requestedIterations > 0 ? Math.ceil(total / requestedIterations) : (chunkSize || Math.max(32 * 1024, Math.floor(total / 20))),
        4 * 1024,
        Math.max(4 * 1024, total),
    );
    let loaded = 0;
    const started = performance.now();
    const marks = [total / 3, (total * 2) / 3, total];
    const times = [null, null, null];
    let firstChunkMs = null;
    while (loaded < total) {
        const next = Math.min(total, loaded + resolvedChunkSize);
        const chunk = bytes.slice(loaded, next);
        loaded = next;
        const elapsed = performance.now() - started;
        if (firstChunkMs == null) firstChunkMs = elapsed;
        for (let i = 0; i < marks.length; i++) {
            if (times[i] == null && loaded >= marks[i]) times[i] = elapsed;
        }
        await onProgress(loaded, total, times.slice(), chunk);
        if (pacingMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, pacingMs));
        }
    }
    return { bytes, times, firstChunkMs, iterations: requestedIterations, chunkSize: resolvedChunkSize };
}

function normalizeSessionFrame(ev) {
    return {
        w: ev.info.width,
        h: ev.info.height,
        rgba: ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels),
        info: ev.info,
        stage: ev.stage,
        format: ev.format,
        pixelStride: ev.pixelStride,
        region: ev.region ?? null,
    };
}

async function encodeJxlWithSession(
    rgba,
    width,
    height,
    quality = 90,
    effort = 3,
    { lossless = false, progressive = true, progressiveFlavor = progressiveDetail, previewFirst = transportPreviewFirst, chunked = transportChunked } = {},
) {
    const t0 = performance.now();
    const session = getContext().encode({
        format: 'rgba8',
        width,
        height,
        hasAlpha: true,
        distance: lossless ? 0 : null,
        quality: lossless ? null : quality,
        effort,
        progressive,
        ...(progressive ? { progressiveFlavor } : {}),
        previewFirst,
        chunked,
        priority: 'visible',
    });
    const buf = rgba instanceof ArrayBuffer ? rgba : rgba.buffer;
    let firstChunkMs = null;
    const parts = [];
    const chunkTask = (async () => {
        for await (const chunk of session.chunks()) {
            if (firstChunkMs == null) firstChunkMs = performance.now() - t0;
            parts.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        }
    })();
    await session.pushPixels(buf);
    await session.finish();
    await chunkTask;
    const total = parts.reduce((n, a) => n + a.byteLength, 0);
    const jxl = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { jxl.set(p, off); off += p.byteLength; }
    return {
        jxl,
        jxlMs: performance.now() - t0,
        firstChunkMs,
        w: width,
        h: height,
        effortUsed: effort,
        effortRequested: effort,
    };
}

async function decodeJxlFinalSession(bytes, priority = 'visible') {
    const session = getContext().decode({ format: 'rgba8', priority });
    const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer;
    await session.push(buf);
    await session.close();
    let lastFrame = null;
    for await (const ev of session.frames()) {
        lastFrame = normalizeSessionFrame(ev);
        if (ev.stage === 'final') break;
    }
    if (lastFrame === null) throw new Error('JXL decode produced no frames');
    return lastFrame;
}

async function streamDecodeJxlSession(bytes, { onChunk, onFrame } = {}, streamOptions = {}, priority = 'visible') {
    const {
        pacingMs = transportNoPacing ? 0 : transportPacingMs,
        chunkSize = transportChunkKb * 1024,
        iterations = transportIterations,
    } = streamOptions;
    // P3.3 (crop benchmark): for full loads, progressive + emitEveryPass hides the 2.5–3 s full-file
    // WASM decode latency by surfacing DC/early passes first. When region known + JXL is JXTC/tiled,
    // prefer decodeTileContainerRegionRgba8 etc. (see suggested-settings.md + audit §13).
    // DecodeSession forwards region/downsample; current callers here use full (region null).
    const session = getContext().decode({
        format: 'rgba8',
        progressionTarget: 'final',
        emitEveryPass: true,
        priority,
    });

    let cancelled = false;

    const pushTask = streamBytes(bytes, async (loaded, total, times, chunk) => {
        const shouldContinue = await onChunk?.(loaded, total, times);
        if (shouldContinue === false) {
            cancelled = true;
            await session.cancel('decode superseded').catch(() => {});
            throw new Error('decode superseded');
        }
        const buf = chunk instanceof ArrayBuffer ? chunk : chunk.buffer;
        await session.push(buf);
    }, { pacingMs, chunkSize, iterations }).then(async (streamedResult) => {
        await session.close();
        return streamedResult;
    });

    let lastFrame = null;
    const frameTask = (async () => {
        for await (const ev of session.frames()) {
            const frame = normalizeSessionFrame(ev);
            if (ev.stage !== 'final') {
                onFrame?.(frame);
            } else {
                lastFrame = frame;
            }
        }
    })();

    try {
        const [streamedResult] = await Promise.all([pushTask, frameTask]);
        if (lastFrame === null) throw new Error('JXL stream decode produced no final frame');
        return { decoded: lastFrame, streamedResult };
    } catch (error) {
        if (!cancelled) await session.cancel(String(error?.message ?? error)).catch(() => {});
        throw error;
    }
}

async function loadRandomSource() {
    const started = performance.now();
    dbgLog('▶ source load → /api/random-gobabeb');
    try {
        const resp = await fetch('/api/random-gobabeb', { cache: 'no-store' });
        if (!resp.ok) {
            const msg = `Random data unavailable (API ${resp.status}). Use file picker or local files instead.`;
            dbgLog('✗ random source failed', msg, 'error');
            throw new Error(msg);
        }
        const raw = new Uint8Array(await resp.arrayBuffer());
        const name = resp.headers.get('x-file-name') || 'random.orf';
        const folder = resp.headers.get('x-source-folder') || 'source folder';
        const result = process_orf(raw, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
        try {
            const rgb = result.take_rgb();
            const rgba = rgb_to_rgba(rgb);
            const source = {
                kind: 'orf',
                raw,
                width: result.width,
                height: result.height,
                rgb,
                rgba,
                label: `${name} | ORF | ${result.width}x${result.height}`,
                meta: `${folder} | ${fmtBytes(raw.byteLength)}`,
                loadMs: performance.now() - started,
            };
            dbgLog(`  source load ← ${name}`, `${source.width}x${source.height} · ${fmtBytes(raw.byteLength)} raw · ${fmtTiming(source.loadMs)}`);
            return source;
        } finally {
            result.free();
        }
    } catch (err) {
        const msg = err?.message || 'Random source load failed';
        dbgLog('✗ loadRandomSource error', msg, 'error');
        throw err;
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
        // Encode always goes through encodeJxlWithSession; no raw worker needed.
        encode: null,
        // libjxl decode goes through decodeJxlFinalSession; jsquash needs a raw worker.
        decode: decodeBackend !== 'libjxl' ? makeStandaloneWorker('decode', decodeBackend) : null,
        encodeId: 1,
        decodeId: 1,
    };
}

function destroyWorkerLane(lane) {
    lane.encode?.terminate();
    lane.decode?.terminate();
}

async function loadRandomDistinctSources(count) {
    const wanted = Math.max(1, count | 0);
    const byName = new Map();
    const attempts = wanted * 20;
    let tries = 0;
    while (byName.size < wanted && tries < attempts) {
        const batchSize = Math.min(5, wanted - byName.size + 2);
        const batch = await Promise.all(Array.from({ length: batchSize }, async () => {
            tries++;
            return loadRandomSource();
        }));
        for (const source of batch) {
            if (!byName.has(source.label)) byName.set(source.label, source);
        }
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
        return { progressive: false, previewFirst: false, chunked: false };
    }
    const progressiveFlavor = thumbBenchProgressiveDetail;
    if (encodeBackend !== 'libjxl') {
        return { progressive: true, previewFirst: transportPreviewFirst, chunked: transportChunked };
    }
    return {
        progressive: true,
        progressiveFlavor,
        previewFirst: transportPreviewFirst,
        chunked: transportChunked,
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
    return `| ${escapeMdCell(label)} | ${escapeMdCell(row.source)} | ${row.repeat + 1} | ${fmtTiming(row.loadMs)} | ${fmtTiming(row.encodeMs)} | ${fmtTiming(row.firstPieceMs)} | ${fmtTiming(row.decodeMs)} | ${fmtTiming(row.paintMs)} | ${fmtTiming(row.totalMs)} | ${escapeMdCell(row.note)} |`;
}

function summarizeThumbBenchBlock(rows) {
    const sum = (key) => rows.reduce((acc, row) => acc + (Number.isFinite(row[key]) ? row[key] : 0), 0);
    const count = rows.length || 1;
    return {
        loadAvg: sum('loadMs') / count,
        encodeAvg: sum('encodeMs') / count,
        firstPieceAvg: sum('firstPieceMs') / count,
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
    lines.push(`- progressive iterations: ${transportIterations}`);
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
        lines.push('| # | source | repeat | load | encode | first piece | decode | paint | total | note |');
        lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
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
    card.log.textContent = 'Starting tile run.';

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

    const formatSourceLine = () => preparedSources.map((s) => s.source.label).join(' | ');

    const runLane = async (laneIndex) => {
        const lane = pool[laneIndex];
        while (true) {
            if (runId !== thumbBenchRunId) return;
            const jobIndex = nextJob++;
            if (jobIndex >= jobs.length) return;
            const job = jobs[jobIndex];
            const prepared = preparedSources[job.sourceIndex];
            const rowStart = performance.now();
            const label = `${size} long | ${prepared.source.label} | rep ${job.repeat + 1}`;
            let row;
            try {
                const encodeStart = performance.now();
                const opts = buildThumbBenchEncodeOptions(prepared.targetDims.width, prepared.targetDims.height, encodeBackend);
                const encoded = await encodeJxlWithSession(
                    prepared.rgba.slice(),
                    prepared.targetDims.width,
                    prepared.targetDims.height,
                    90,
                    3,
                    {
                        progressive: opts.progressive ?? true,
                        previewFirst: opts.previewFirst ?? transportPreviewFirst,
                        chunked: opts.chunked ?? transportChunked,
                    },
                );
                const encodeMs = performance.now() - encodeStart;

                const decodeStart = performance.now();
                const decoded = await (decodeBackend === 'libjxl'
                    ? decodeJxlFinalSession(encoded.jxl, THUMB_BENCH_DECODE_PRIORITY)
                    : decodeJxlFinal(lane.decode, encoded.jxl));
                const decodeMs = performance.now() - decodeStart;

                const paintStart = performance.now();
                const tile = paintThumbBenchTile(decoded);
                const paintMs = performance.now() - paintStart;
                const firstPaintMs = performance.now() - rowStart;

                const totalMs = performance.now() - rowStart;
                const title = `${prepared.source.label} | ${size} long | rep ${job.repeat + 1} | load ${fmtTiming(prepared.source.loadMs)} | enc ${fmtTiming(encodeMs)} | first ${fmtTiming(encoded.firstChunkMs)} | dec ${fmtTiming(decodeMs)} | paint ${fmtTiming(paintMs)}`;
                appendThumbBenchTile(card, tile, title);
                row = {
                    sequence: rows.length + 1,
                    index: jobIndex,
                    source: prepared.source.label,
                    repeat: job.repeat,
                    loadMs: prepared.source.loadMs ?? null,
                    encodeMs,
                    firstPieceMs: encoded.firstChunkMs ?? null,
                    decodeMs,
                    paintMs,
                    firstPaintMs,
                    totalMs,
                    note: 'ok',
                };
            } catch (error) {
                errors++;
                const totalMs = performance.now() - rowStart;
                const message = error?.message || String(error);
                const tile = makeErrorThumbCanvas(message);
                appendThumbBenchTile(card, tile, `${label} | error: ${message}`);
                row = {
                    sequence: rows.length + 1,
                    index: jobIndex,
                    source: prepared.source.label,
                    repeat: job.repeat,
                    loadMs: prepared.source.loadMs ?? null,
                    encodeMs: 0,
                    firstPieceMs: null,
                    decodeMs: 0,
                    paintMs: 0,
                    firstPaintMs: totalMs,
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
                    loadAvg: block.loadAvg,
                    encodeAvg: block.encodeAvg,
                    firstPieceAvg: block.firstPieceAvg,
                    decodeAvg: block.decodeAvg,
                    paintAvg: block.paintAvg,
                    totalAvg: block.totalAvg,
                });
                card.log.textContent = [
                    `source: ${size} long`,
                    `files: ${formatSourceLine()}`,
                    `done: ${completed}/${jobs.length}`,
                    `wall: ${wallMs.toFixed(0)} ms`,
                    `last load: ${fmtTiming(prepared.source.loadMs)}`,
                    `block avg encode: ${block.encodeAvg.toFixed(0)} ms`,
                    `block avg first piece: ${block.firstPieceAvg.toFixed(0)} ms`,
                    `block avg decode: ${block.decodeAvg.toFixed(0)} ms`,
                    `block avg paint: ${block.paintAvg.toFixed(0)} ms`,
                    `errors: ${errors}`,
                    '',
                    ...checkpoints.map((cp) => `${cp.done}/${jobs.length} | wall ${cp.wallMs.toFixed(0)} ms | load ${cp.loadAvg.toFixed(0)} | enc ${cp.encodeAvg.toFixed(0)} | first ${cp.firstPieceAvg.toFixed(0)} | dec ${cp.decodeAvg.toFixed(0)} | paint ${cp.paintAvg.toFixed(0)} | total ${cp.totalAvg.toFixed(0)}`),
                ].join('\n');
                blockRows = [];
            }
        }
    };

    thumbBenchStatus.textContent = `Running ${size} long with ${concurrency} workers.`;
    thumbBenchSettings.textContent = `${encodeBackend} -> ${decodeBackend} | progressive ${thumbBenchProgressive ? 'on' : 'off'} ${thumbBenchProgressive ? `| ${thumbBenchProgressiveDetail.toUpperCase()}` : ''}`;
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
        ...checkpoints.map((cp) => `${cp.done}/${jobs.length} | wall ${cp.wallMs.toFixed(0)} ms | load ${cp.loadAvg.toFixed(0)} | enc ${cp.encodeAvg.toFixed(0)} | first ${cp.firstPieceAvg.toFixed(0)} | dec ${cp.decodeAvg.toFixed(0)} | paint ${cp.paintAvg.toFixed(0)} | total ${cp.totalAvg.toFixed(0)}`),
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
    console.log('%c[Progressive] run start', 'color:#8b5cf6;font-weight:600', { t: new Date().toISOString(), sizes, encodeBackend, decodeBackend, progressive: thumbBenchProgressive, detail: thumbBenchProgressiveDetail, concurrency: thumbBenchConcurrency });
    if (!sizes.length) {
        setThumbBenchSize(300, true);
        setThumbBenchSize(800, true);
    }

    thumbBenchStatus.textContent = 'Loading 5 random ORFs.';
    thumbBenchSettings.textContent = `${encodeBackend} -> ${decodeBackend} | progressive ${thumbBenchProgressive ? 'on' : 'off'} ${thumbBenchProgressive ? `| ${thumbBenchProgressiveDetail.toUpperCase()}` : ''} | concurrency ${thumbBenchConcurrency}`;
    for (const card of thumbBenchCards) {
        clearThumbBenchCard(card);
        card.log.textContent = 'Loading sources...';
    }
    await nextPaint();

    try {
        await initRaw();
        if (!thumbBenchSources) {
            thumbBenchSources = await loadRandomDistinctSources(5);
        }
        const sources = thumbBenchSources;
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
        thumbBenchSettings.textContent = `${encodeBackend} -> ${decodeBackend} | progressive ${thumbBenchProgressive ? 'on' : 'off'} ${thumbBenchProgressive ? `| ${thumbBenchProgressiveDetail.toUpperCase()}` : ''} | concurrency ${thumbBenchConcurrency}`;
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
    const decodeWorker = decodeBackend !== 'libjxl' ? getWorker('decode', decodeBackend, target.slot) : null;

    card.el.dataset.state = 'working';
    dbgLog(`▶ ${target.label} ${source.label}`, `${targetDims.width}x${targetDims.height} · enc ${actualEncodeBackend} · dec ${decodeBackend}`);
    const encodeLabel = actualEncodeBackend === encodeBackend ? encodeBackend : `${encodeBackend}->${actualEncodeBackend}`;
    card.badge.textContent = `${target.badge} | enc ${encodeLabel} | dec ${decodeBackend}`;
    card.notes.textContent = `Preparing ${target.label} with enc ${encodeLabel} / dec ${decodeBackend}.`;
    card.fill.style.width = '0%';
    card.bytes.textContent = '0 / 0';
    card._timingStartedAt = performance.now();
    card._firstPaintMs = null;
    card.loadMs = source.loadMs ?? null;
    card.firstPieceMs = null;
    card.encodeMs = null;
    card.decodeMs = null;
    card.timings.textContent = formatProgressiveTimings({ loadMs: card.loadMs });

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
            const srcRgba = source.rgba instanceof Uint8Array ? source.rgba : new Uint8Array(source.rgba);
            ctx.putImageData(new ImageData(new Uint8ClampedArray(srcRgba.buffer, srcRgba.byteOffset, srcRgba.byteLength), source.width, source.height), 0, 0);
        }
        const workCanvas = document.createElement('canvas');
        scaleImageDataToCanvas(srcCanvas, workCanvas, targetDims.width, targetDims.height);
        const data = workCanvas.getContext('2d').getImageData(0, 0, workCanvas.width, workCanvas.height).data;
        rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }

    if (runId !== activeRunId) return;
    card._source = source;
    card._targetDims = targetDims;
    paintPreparedPreview(card, source, rgba, targetDims);
    const srcLong = Math.max(source.width, source.height);
    card.notes.textContent = `Encoding ${target.label} (${targetDims.width}x${targetDims.height}) from ${srcLong} px source edge.`;
    const showSourcePlayback = mode === 'progressive' && (progressivePreview === 'source' || decodeBackend === 'jsquash');
    if (showSourcePlayback) {
        startPreviewPlayback(card, source, targetDims, stepCount, runId);
    } else {
        stopPreviewPlayback(card);
        card._previewFrames = null;
        card._previewStep = -1;
    }
    card._encodeStartedAt = performance.now();
    card.encode.textContent = 'encode: running…';
    card.timings.textContent = formatProgressiveTimings(
        { loadMs: card.loadMs, firstPieceMs: null, firstPaintMs: card._firstPaintMs },
        { phase: 'encode', elapsedMs: 0 },
    );
    await nextPaint();
    dbgLog(`  encode → ${target.label}`, `${targetDims.width}x${targetDims.height} · q=90 effort=3`);
    const encodeResult = await encodeJxlWithSession(new Uint8Array(rgba.buffer.slice(0)), targetDims.width, targetDims.height, 90, 3);
    if (runId !== activeRunId) return;
    const jxlBytes = encodeResult.jxl;
    dbgLog(`  encode ← ${target.label}`, `${fmtBytes(jxlBytes.byteLength)} jxl · enc ${fmtTiming(encodeResult.jxlMs)} · first ${fmtTiming(encodeResult.firstChunkMs)}`);
    card._jxlBytes = new Uint8Array(jxlBytes.buffer.slice(0));
    card.encodeMs = encodeResult.jxlMs;
    card.firstPieceMs = encodeResult.firstChunkMs ?? null;
    card.encode.textContent = `encode: ${encodeResult.jxlMs.toFixed(0)} ms`;
    card.timings.textContent = formatProgressiveTimings({
        loadMs: card.loadMs,
        encodeMs: card.encodeMs,
        firstPieceMs: card.firstPieceMs,
        firstPaintMs: card._firstPaintMs,
    });
    renderTimingBar(card);

    card.el.dataset.state = 'streaming';
    card.notes.textContent = `Streaming JXL bytes for ${target.label}.`;
    card.timings.textContent = formatProgressiveTimings(
        { loadMs: card.loadMs, encodeMs: card.encodeMs, firstPieceMs: card.firstPieceMs, firstPaintMs: card._firstPaintMs },
        { phase: 'decode', elapsedMs: 0 },
    );
    await nextPaint();
    const decodeStart = performance.now();
    const pacingMs = transportNoPacing ? 0 : transportPacingMs;
    dbgLog(`  decode → ${target.label}`, `${fmtBytes(jxlBytes.byteLength)} jxl · mode ${mode} · preview ${progressivePreview}`);
    const updateStreamProgress = (loaded, total, times) => {
        if (runId !== activeRunId) return false;
        updateCardProgress(card, loaded, total, `Loaded ${fmtBytes(loaded)} of ${fmtBytes(total)}.`);
        card.timings.textContent = `${formatProgressiveTimings({
            loadMs: card.loadMs,
            encodeMs: card.encodeMs,
            firstPieceMs: card.firstPieceMs,
            firstPaintMs: card._firstPaintMs,
        })} | stream 1/3 ${fmtTiming(times[0])} | 2/3 ${fmtTiming(times[1])} | end ${fmtTiming(times[2])}`;
        return true;
    };

    if (mode === 'progressive' && decodeBackend === 'libjxl' && progressivePreview === 'stream') {
        const { decoded, streamedResult } = await streamDecodeJxlSession(jxlBytes, {
            onChunk: updateStreamProgress,
            onFrame: (frame) => {
                if (runId !== activeRunId) return;
                rgbaToCanvas(card, frame.rgba, frame.w, frame.h);
                markFirstPaint(card);
                card.notes.textContent = `libjxl preview ${frame.w}x${frame.h}.`;
            },
        }, { pacingMs, chunkSize: transportChunkKb * 1024, iterations: transportIterations });
        if (runId !== activeRunId) return;
        stopPreviewPlayback(card);
        rgbaToCanvas(card, decoded.rgba, decoded.w, decoded.h);
        markFirstPaint(card);
        dbgLog(`  decode ← ${target.label}`, `${decoded.w}x${decoded.h} · ${fmtTiming(performance.now() - decodeStart)} · stream 1/3 ${fmtTiming(streamedResult.times[0])} · 2/3 ${fmtTiming(streamedResult.times[1])} · end ${fmtTiming(streamedResult.times[2])}`, 'ok');
        card.el.dataset.state = 'done';
        card.fill.style.width = '100%';
        card.bytes.textContent = `${fmtBytes(jxlBytes.byteLength)} / ${fmtBytes(jxlBytes.byteLength)}`;
        card.firstPieceMs = streamedResult.firstChunkMs ?? card.firstPieceMs;
        card.decodeMs = performance.now() - decodeStart;
        card.timings.textContent = `${formatProgressiveTimings({
            loadMs: card.loadMs,
            encodeMs: card.encodeMs,
            firstPieceMs: card.firstPieceMs,
            firstPaintMs: card._firstPaintMs,
            decodeMs: card.decodeMs,
            totalMs: performance.now() - card._timingStartedAt,
        })} | stream 1/3 ${fmtTiming(streamedResult.times[0])} | 2/3 ${fmtTiming(streamedResult.times[1])} | end ${fmtTiming(streamedResult.times[2])}`;
        card.notes.textContent = `Decoded ${decoded.w}x${decoded.h} in ${card.decodeMs.toFixed(0)} ms.`;
        renderTimingBar(card);
        return;
    }

    const streamedResult = await streamBytes(jxlBytes, updateStreamProgress, { pacingMs, chunkSize: transportChunkKb * 1024, iterations: transportIterations });
    const streamed = streamedResult.bytes;

    if (runId !== activeRunId) return;
    card.el.dataset.state = 'decoding';
    card.notes.textContent = `Decoding ${target.label} from JXL.`;
    card.timings.textContent = formatProgressiveTimings(
        { loadMs: card.loadMs, encodeMs: card.encodeMs, firstPieceMs: card.firstPieceMs, firstPaintMs: card._firstPaintMs },
        { phase: 'decode', elapsedMs: 0 },
    );
    await nextPaint();
    stopPreviewPlayback(card);
    const decoded = await (decodeBackend === 'libjxl'
        ? decodeJxlFinalSession(streamed, 'visible')
        : decodeJxlFinal(decodeWorker, streamed));
    if (runId !== activeRunId) return;
    rgbaToCanvas(card, decoded.rgba, decoded.w, decoded.h);
    markFirstPaint(card);
    dbgLog(`  decode ← ${target.label}`, `${decoded.w}x${decoded.h} · ${fmtTiming(performance.now() - decodeStart)} · stream 1/3 ${fmtTiming(streamedResult.times[0])} · 2/3 ${fmtTiming(streamedResult.times[1])} · end ${fmtTiming(streamedResult.times[2])}`, 'ok');
    card.el.dataset.state = 'done';
    card.fill.style.width = '100%';
    card.bytes.textContent = `${fmtBytes(streamed.byteLength)} / ${fmtBytes(streamed.byteLength)}`;
    card.firstPieceMs = streamedResult.firstChunkMs ?? card.firstPieceMs;
    card.decodeMs = performance.now() - decodeStart;
    card.timings.textContent = `${formatProgressiveTimings({
        loadMs: card.loadMs,
        encodeMs: card.encodeMs,
        firstPieceMs: card.firstPieceMs,
        firstPaintMs: card._firstPaintMs,
        decodeMs: card.decodeMs,
        totalMs: performance.now() - card._timingStartedAt,
    })} | stream 1/3 ${fmtTiming(streamedResult.times[0])} | 2/3 ${fmtTiming(streamedResult.times[1])} | end ${fmtTiming(streamedResult.times[2])}`;
    card.notes.textContent = `Decoded ${decoded.w}x${decoded.h} in ${card.decodeMs.toFixed(0)} ms.`;
    renderTimingBar(card);
}

async function replayDecodeCard(card, runId) {
    const mode = decodeMode;
    const progressivePreview = previewMode;
    const decodeBackend = session.decodeBackend;
    if (!card._jxlBytes?.byteLength) return;
    const targetDims = card._targetDims || { width: card.canvas.width, height: card.canvas.height };
    const canShowSourcePlayback = mode === 'progressive' && card._source && (progressivePreview === 'source' || decodeBackend === 'jsquash');
    dbgLog(`▶ replay ${card.slot}`, `${fmtBytes(card._jxlBytes.byteLength)} jxl · mode ${mode} · preview ${progressivePreview} · dec ${decodeBackend}`);
    stopPreviewPlayback(card);
    card._previewFrames = null;
    card._previewStep = -1;
    const decodeWorker = decodeBackend !== 'libjxl' ? getWorker('decode', decodeBackend, card.slot) : null;
    card.el.dataset.state = 'replaying';
    card.fill.style.width = '0%';
    card.bytes.textContent = `0 / ${fmtBytes(card._jxlBytes.byteLength)}`;
    card.timings.textContent = formatProgressiveTimings(
        { loadMs: card.loadMs, encodeMs: card.encodeMs, firstPieceMs: card.firstPieceMs, firstPaintMs: card._firstPaintMs },
        { phase: 'decode', elapsedMs: 0 },
    );
    card.notes.classList.add('replay-countdown');
    card.notes.textContent = '1000 ms';
    const ctx = card.canvas.getContext('2d');
    ctx.clearRect(0, 0, card.canvas.width, card.canvas.height);
    await nextPaint();

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
    card.el.dataset.state = 'decoding';

    const decodeStart = performance.now();
    if (mode === 'progressive' && canShowSourcePlayback) {
        startPreviewPlayback(card, card._source, targetDims, getProgressiveStepCount(), runId);
        card.notes.textContent = `Progressive preview enabled (${card._previewFrames.length} steps).`;
    }
    else {
        card.notes.textContent = 'Decoding JXL...';
    }
    const pacingMs = transportNoPacing ? 0 : transportPacingMs;
    const updateStreamProgress = (loaded, total, times) => {
        if (runId !== activeRunId) return false;
        updateCardProgress(card, loaded, total, `Loaded ${fmtBytes(loaded)} of ${fmtBytes(total)}.`);
        card.timings.textContent = `${formatProgressiveTimings({
            loadMs: card.loadMs,
            encodeMs: card.encodeMs,
            firstPieceMs: card.firstPieceMs,
            firstPaintMs: card._firstPaintMs,
        })} | stream 1/3 ${fmtTiming(times[0])} | 2/3 ${fmtTiming(times[1])} | end ${fmtTiming(times[2])}`;
        return true;
    };

    if (mode === 'progressive' && decodeBackend === 'libjxl' && progressivePreview === 'stream') {
        const { decoded, streamedResult } = await streamDecodeJxlSession(card._jxlBytes, {
            onChunk: updateStreamProgress,
            onFrame: (frame) => {
                if (runId !== activeRunId) return;
                rgbaToCanvas(card, frame.rgba, frame.w, frame.h);
                card.notes.textContent = `libjxl preview ${frame.w}x${frame.h}.`;
            },
        }, { pacingMs, chunkSize: transportChunkKb * 1024, iterations: transportIterations });
        if (runId !== activeRunId) return;

        stopPreviewPlayback(card);
        rgbaToCanvas(card, decoded.rgba, decoded.w, decoded.h);
        card.el.dataset.state = 'done';
        card.fill.style.width = '100%';
        card.bytes.textContent = `${fmtBytes(card._jxlBytes.byteLength)} / ${fmtBytes(card._jxlBytes.byteLength)}`;
        card.timings.textContent = `1/3: ${streamedResult.times[0] == null ? '--' : `${streamedResult.times[0].toFixed(0)} ms`} | 2/3: ${streamedResult.times[1] == null ? '--' : `${streamedResult.times[1].toFixed(0)} ms`} | end: ${streamedResult.times[2] == null ? '--' : `${streamedResult.times[2].toFixed(0)} ms`}`;
        markFirstPaint(card);
        card.firstPieceMs = streamedResult.firstChunkMs ?? card.firstPieceMs;
        card.decodeMs = performance.now() - decodeStart;
        card.timings.textContent = `${formatProgressiveTimings({
            loadMs: card.loadMs,
            encodeMs: card.encodeMs,
            firstPieceMs: card.firstPieceMs,
            firstPaintMs: card._firstPaintMs,
            decodeMs: card.decodeMs,
            totalMs: performance.now() - card._timingStartedAt,
        })} · stream 1/3 ${fmtTiming(streamedResult.times[0])} · 2/3 ${fmtTiming(streamedResult.times[1])} · end ${fmtTiming(streamedResult.times[2])}`;
        dbgLog(`  replay ← ${card.slot}`, `${decoded.w}x${decoded.h} · ${fmtTiming(card.decodeMs)} · stream 1/3 ${fmtTiming(streamedResult.times[0])} · 2/3 ${fmtTiming(streamedResult.times[1])} · end ${fmtTiming(streamedResult.times[2])}`, 'ok');
        card.notes.textContent = `Replay decode: ${decoded.w}x${decoded.h} in ${card.decodeMs.toFixed(0)} ms.`;
        renderTimingBar(card);
        return;
    }

    const streamedResult = await streamBytes(card._jxlBytes, updateStreamProgress, { pacingMs, chunkSize: transportChunkKb * 1024, iterations: transportIterations });
    if (runId !== activeRunId) return;

    stopPreviewPlayback(card);
    const decoded = await (decodeBackend === 'libjxl'
        ? decodeJxlFinalSession(streamedResult.bytes, 'visible')
        : decodeJxlFinal(decodeWorker, streamedResult.bytes));
    if (runId !== activeRunId) return;
    rgbaToCanvas(card, decoded.rgba, decoded.w, decoded.h);
    card.el.dataset.state = 'done';
    card.fill.style.width = '100%';
    card.bytes.textContent = `${fmtBytes(streamedResult.bytes.byteLength)} / ${fmtBytes(streamedResult.bytes.byteLength)}`;
    markFirstPaint(card);
    card.firstPieceMs = streamedResult.firstChunkMs ?? card.firstPieceMs;
    card.decodeMs = performance.now() - decodeStart;
    card.timings.textContent = `${formatProgressiveTimings({
        loadMs: card.loadMs,
        encodeMs: card.encodeMs,
        firstPieceMs: card.firstPieceMs,
        firstPaintMs: card._firstPaintMs,
        decodeMs: card.decodeMs,
        totalMs: performance.now() - card._timingStartedAt,
    })} · stream 1/3 ${fmtTiming(streamedResult.times[0])} · 2/3 ${fmtTiming(streamedResult.times[1])} · end ${fmtTiming(streamedResult.times[2])}`;
    dbgLog(`  replay ← ${card.slot}`, `${decoded.w}x${decoded.h} · ${fmtTiming(card.decodeMs)} · stream 1/3 ${fmtTiming(streamedResult.times[0])} · 2/3 ${fmtTiming(streamedResult.times[1])} · end ${fmtTiming(streamedResult.times[2])}`, 'ok');
    card.notes.textContent = `Replay decode: ${decoded.w}x${decoded.h} in ${card.decodeMs.toFixed(0)} ms.`;
    renderTimingBar(card);
}

// ── backend race ─────────────────────────────────────────────────
async function runBackendRace() {
    if (!session.source) return;
    if (raceBtn) raceBtn.disabled = true;
    if (raceResult) {
        raceResult.hidden = false;
        raceResult.innerHTML = '<div class="race-loading">Running decode race… encoding once with libjxl, then decoding with each backend.</div>';
    }

    const source = session.source;
    const sizes = [300, 800];
    const blocks = [];

    try {
        for (const longEdge of sizes) {
            const targetDims = sizeForLongEdge(source.width, source.height, longEdge);
            let rgba;
            if (targetDims.width === source.width && targetDims.height === source.height) {
                rgba = source.rgba.slice();
            } else {
                const downRgb = downscale_rgb(source.rgb, source.width, source.height, targetDims.width, targetDims.height);
                rgba = rgb_to_rgba(downRgb);
            }

            // Encode once (libjxl, no progressive so decode is apples-to-apples)
            const encStart = performance.now();
            const encoded = await encodeJxlWithSession(
                new Uint8Array(rgba.buffer.slice(0)),
                targetDims.width, targetDims.height,
                90, 3,
                { progressive: false, previewFirst: false, chunked: false },
            );
            const encodeMs = performance.now() - encStart;
            const fileSize = encoded.jxl.byteLength;

            // Decode with jsquash worker
            const jsquashWorker = getWorker('decode', 'jsquash', `race-jsquash-${longEdge}`);
            const decJsqStart = performance.now();
            await decodeJxlFinal(jsquashWorker, encoded.jxl.slice());
            const decodeJsqMs = performance.now() - decJsqStart;

            // Decode with libjxl session (progressive decode)
            const decLibStart = performance.now();
            await decodeJxlFinalSession(encoded.jxl.slice(), 'visible');
            const decodeLibMs = performance.now() - decLibStart;

            blocks.push({
                longEdge, dims: targetDims, encodeMs, fileSize,
                jsquash: { decodeMs: decodeJsqMs, totalMs: encodeMs + decodeJsqMs },
                libjxl:  { decodeMs: decodeLibMs, totalMs: encodeMs + decodeLibMs },
            });
        }

        renderRaceResult(blocks);
    } catch (err) {
        if (raceResult) raceResult.innerHTML = `<div class="race-loading" style="color:#f87171">Race failed: ${err?.message || err}</div>`;
    } finally {
        if (raceBtn) raceBtn.disabled = false;
    }
}

function renderRaceResult(blocks) {
    if (!raceResult) return;
    const grid = document.createElement('div');
    grid.className = 'race-grid';

    for (const block of blocks) {
        const { longEdge, dims, encodeMs, fileSize, jsquash, libjxl } = block;
        const libFaster = libjxl.decodeMs < jsquash.decodeMs;
        const jsqFaster = jsquash.decodeMs < libjxl.decodeMs;
        const maxDec = Math.max(jsquash.decodeMs, libjxl.decodeMs, 1);
        const deltaMs = jsquash.decodeMs - libjxl.decodeMs;
        const deltaPct = Math.abs(deltaMs / Math.max(jsquash.decodeMs, 1) * 100).toFixed(0);
        const deltaStr = libFaster
            ? `libjxl decodes ${deltaMs.toFixed(0)} ms faster (${deltaPct}%)`
            : jsqFaster
                ? `jsquash decodes ${(-deltaMs).toFixed(0)} ms faster (${deltaPct}%)`
                : 'identical';

        const blockEl = document.createElement('div');
        blockEl.className = 'race-block';
        blockEl.innerHTML = `
            <div class="race-block-title">${longEdge} long · ${dims.width}×${dims.height} · ${fmtBytes(fileSize)}</div>
            <div class="race-cols">
                <div class="race-col-head">Metric</div>
                <div class="race-col-head" style="text-align:right">jsquash</div>
                <div class="race-col-head" style="text-align:right">libjxl</div>

                <div class="race-metric-label">Encode (shared)</div>
                <div class="race-metric-val" style="text-align:right;color:var(--muted)">${encodeMs.toFixed(0)} ms</div>
                <div class="race-metric-val" style="text-align:right;color:var(--muted)">${encodeMs.toFixed(0)} ms</div>

                <div class="race-metric-label">Decode</div>
                <div class="race-metric-val${jsqFaster ? ' is-winner' : ''}" style="text-align:right">${jsquash.decodeMs.toFixed(0)} ms</div>
                <div class="race-metric-val${libFaster ? ' is-winner' : ''}" style="text-align:right">${libjxl.decodeMs.toFixed(0)} ms</div>

                <div class="race-metric-label">Total pipeline</div>
                <div class="race-metric-val" style="text-align:right">${jsquash.totalMs.toFixed(0)} ms</div>
                <div class="race-metric-val${libFaster ? ' is-winner' : ''}" style="text-align:right">${libjxl.totalMs.toFixed(0)} ms</div>
            </div>
            <div class="race-bars">
                <div class="race-bar-row">
                    <div class="race-bar-label">Enc</div>
                    <div class="race-bar-wrap">
                        <div class="race-bar-name">shared</div>
                        <div class="race-bar-track"><div class="race-bar-fill" style="--w:100%;--bar-color:#34d399"><span class="race-bar-fill-label">${encodeMs.toFixed(0)} ms</span></div></div>
                    </div>
                    <div></div>
                </div>
                <div class="race-bar-row">
                    <div class="race-bar-label">Dec</div>
                    <div class="race-bar-wrap">
                        <div class="race-bar-name">jsquash</div>
                        <div class="race-bar-track"><div class="race-bar-fill" style="--w:${(jsquash.decodeMs / maxDec * 100).toFixed(1)}%;--bar-color:#f59e0b"><span class="race-bar-fill-label">${jsquash.decodeMs.toFixed(0)} ms</span></div></div>
                    </div>
                    <div class="race-bar-wrap">
                        <div class="race-bar-name">libjxl</div>
                        <div class="race-bar-track"><div class="race-bar-fill" style="--w:${(libjxl.decodeMs / maxDec * 100).toFixed(1)}%;--bar-color:#7dd3fc"><span class="race-bar-fill-label">${libjxl.decodeMs.toFixed(0)} ms</span></div></div>
                    </div>
                </div>
            </div>
            <div style="margin-top:4px;font-size:10px;color:${libFaster ? 'var(--emerald)' : jsqFaster ? '#f87171' : 'var(--muted)'};font-family:monospace">${deltaStr}</div>
        `;
        grid.appendChild(blockEl);
    }

    raceResult.innerHTML = '';
    raceResult.appendChild(grid);
}

function wireRaceBtn() {
    if (!raceBtn) return;
    raceBtn.addEventListener('click', () => {
        runBackendRace().catch((err) => {
            if (raceResult) raceResult.innerHTML = `<div class="race-loading" style="color:#f87171">Race error: ${err?.message || err}</div>`;
            if (raceBtn) raceBtn.disabled = false;
        });
    });
}

function wireModeControls() {
    syncProgressiveStepLabel();
    setDecodeMode(decodeMode);
    setProgressiveDetail(progressiveDetail);
    for (const button of modeButtons) {
        button.addEventListener('click', () => {
            setDecodeMode(button.dataset.decodeMode);
        });
    }
    for (const button of progressiveDetailButtons) {
        button.addEventListener('click', () => {
            const next = button.dataset.progressiveDetail;
            if (next === progressiveDetail) return;
            setProgressiveDetail(next);
            setStatus(`Progressive detail set to ${progressiveDetail.toUpperCase()}. Re-running the same source file.`);
            if (session.source) {
                runLadder().catch((error) => {
                    setStatus(`Failed: ${error?.message || error}`);
                });
            }
        });
    }
    progressiveStepsInput.addEventListener('input', () => {
        syncProgressiveStepLabel();
    });
}

function wirePreviewControls() {
    setPreviewMode(previewMode);
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

function wireDashboardControls() {
    wireSlideoutPanel({
        panel: progressiveDashboard,
        openButton: progressiveControlsBtn,
        closeButton: progressiveControlsClose,
        defaultOpen: true,
    });
    wireHelpPopovers(progressiveDashboard);

    bindRangeLabel(transportChunkKbInput, transportChunkKbValue, (value) => String(value));
    bindRangeLabel(transportPacingInput, transportPacingValue, (value) => String(value));
    bindRangeLabel(thumbDisplayInput, thumbDisplayValue, (value) => String(value));

    setGroupDisabled(progressiveDashboard?.querySelector('[data-group="batch"]'), true, 'Batch controls live on the wrapper lab page.');
    setGroupDisabled(progressiveDashboard?.querySelector('[data-group="transport"]'), false);
    setGroupDisabled(progressiveDashboard?.querySelector('[data-group="display"]'), false);
    setGroupDisabled(progressiveDashboard?.querySelector('[data-group="source"]'), false);

    transportChunkKbInput?.addEventListener('input', syncTransportControls);
    transportPacingInput?.addEventListener('input', syncTransportControls);
    transportNoPacingInput?.addEventListener('change', syncTransportControls);
    transportPreviewFirstInput?.addEventListener('change', syncTransportControls);
    transportChunkedInput?.addEventListener('change', syncTransportControls);
    thumbDisplayInput?.addEventListener('input', syncDisplayControls);

    syncTransportControls();
    syncDisplayControls();
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
        setStatus(`Source ready. Building three JXL variants with enc ${session.encodeBackend} / dec ${session.decodeBackend} / prog ${progressiveDetail.toUpperCase()}.`);
        for (const card of cards) {
            card.notes.textContent = `${source.label}`;
            const ctx = card.canvas.getContext('2d');
            ctx.clearRect(0, 0, card.canvas.width, card.canvas.height);
        }
        const tasks = TARGETS.map((target) => runVariant(source, target, runId).catch((error) => {
            if (runId !== activeRunId) return;
            const card = cards.find((entry) => entry.slot === target.slot);
            const msg = error?.message || String(error);
            const stack = error?.stack || msg;
            card.el.dataset.state = 'error';
            card.notes.textContent = msg;
            card.badge.textContent = 'error ▸';
            card.errorText.textContent = stack;
            card.errorDetail.classList.remove('is-open');
        }));
        await Promise.all(tasks);
        if (runId !== activeRunId) return;
        setStatus('Done. Smaller variants should establish the subject first.');
        replayBtn.disabled = false;
        if (raceBtn) raceBtn.disabled = false;
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
        const msg = error?.message || String(error);
        card.el.dataset.state = 'error';
        card.notes.textContent = msg;
        card.badge.textContent = 'error ▸';
        card.errorText.textContent = error?.stack || msg;
        card.errorDetail.classList.remove('is-open');
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
if (dbgConsoleBtn) initDebugConsole(dbgConsoleBtn);
wireDashboardControls();
wireModeControls();
wireBackendControls();
wirePreviewControls();
wireThumbBenchControls();
wireRaceBtn();
setThumbBenchStatus('Idle.');
refreshThumbBenchSummary();
runLadder().catch((error) => {
    setStatus(`Failed: ${error?.message || error}`);
});
