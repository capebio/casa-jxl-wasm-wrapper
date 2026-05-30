import initRaw, * as rawWasm from '../pkg/raw_converter_wasm.js';
import { createDecoder, createEncoder, getWrapperCapabilities } from '@casabio/jxl-wasm';
import { getContext, resetContext } from './jxl-browser-context.js';
import { getCapabilities } from '@casabio/jxl-capabilities';
import {
    clamp,
    setCssVar,
} from './jxl-dashboard-ui.js';
import { initDebugConsole, dbgLog } from './jxl-debug-console.js';

const { process_orf, process_cr2, rgb_to_rgba } = rawWasm;

const MAX_BATCH_LIMIT = 100;
const RANDOM_LOAD_CONCURRENCY = 4;
const RACE_CARD_SIZE = 100;
const WRAPPER_FILE_LOAD_CONCURRENCY = 4;
const STATUS_UPDATE_INTERVAL_MS = 120;
const TILE_CANVAS_MAX_EDGE = 256;
const SESSION_STAGE_TIMEOUT_MS = 1000;
const SESSION_COMPLETION_TIMEOUT_MS = 5000;

const modeButtons = [...document.querySelectorAll('button[data-mode]')];
const sourceInput = document.getElementById('source-input');
const sourceDrop = document.getElementById('source-drop');
const loadRandomBtn = document.getElementById('load-random');
const runBatchBtn = document.getElementById('run-batch');
const clearBatchBtn = document.getElementById('clear-batch');
const batchLimitInput = document.getElementById('batch-limit');
const batchConcurrencyInput = document.getElementById('batch-concurrency');
const batchQualityInput = document.getElementById('batch-quality');
const batchEffortInput = document.getElementById('batch-effort');
const batchDecodeSpeedInput = document.getElementById('batch-decode-speed');
const batchPhotonNoiseIsoInput = document.getElementById('batch-photon-noise-iso');
const batchResamplingInputs = [...document.querySelectorAll('input[name="batch-resampling"]')];
const batchModularInputs = [...document.querySelectorAll('input[name="batch-modular"]')];
const batchBrotliEffortInput = document.getElementById('batch-brotli-effort');

/** Phase 1 first-class advanced filters controls (populated after DOM ready). */
let batchAdvancedFilters = null;
const batchAlphaDistanceInput = document.getElementById('batch-alpha-distance');
const alphaDistanceUnavail = document.getElementById('alpha-distance-unavail');
const batchLosslessInput = document.getElementById('batch-lossless');
const batchCompressBoxesInput = document.getElementById('batch-compress-boxes');
const batchForceContainerInput = document.getElementById('batch-force-container');
const batchRawCodestreamInput = document.getElementById('batch-raw-codestream');
const batchThumbSizeInputs = [...document.querySelectorAll('input[name="batch-thumb-size"]')];
const batchLimitValue = document.getElementById('batch-limit-value');
const batchConcurrencyValue = document.getElementById('batch-concurrency-value');
const batchQualityValue = document.getElementById('batch-quality-value');
const batchEffortValue = document.getElementById('batch-effort-value');
const selectionStatus = document.getElementById('selection-status');
const modeStatus = document.getElementById('mode-status');
const batchStatus = document.getElementById('batch-status');
const timingStatus = document.getElementById('timing-status');
const loadedCount = document.getElementById('loaded-count');
const queuedCount = document.getElementById('queued-count');
const doneCount = document.getElementById('done-count');
const errorCount = document.getElementById('error-count');
const statsExistingTotal = document.getElementById('stats-existing-total');
const statsWrapperTotal = document.getElementById('stats-wrapper-total');
const statsTotalDelta = document.getElementById('stats-total-delta');
const statsWrapperFaster = document.getElementById('stats-wrapper-faster');
const batchGrid = document.getElementById('batch-grid');
const dbgConsoleBtn = document.getElementById('dbg-console-btn');

let existingContext = getContext();
const paintScratchCanvas = document.createElement('canvas');
const sourceCache = new Map();
const chartInstances = {};

let nativeJxlDecoder = false;

let currentMode = 'existing';
let selectedSources = [];
let activeRunId = 0;
let activeLoadId = 0;
let batchThumbSize = batchThumbSizeInputs.find((input) => input.checked)?.value || '256';
let lastProgressStatusAt = 0;
let sessionBackendBroken = false;

function setMode(mode) {
    currentMode = mode;
    document.body.dataset.mode = mode;
    for (const button of modeButtons) {
        const active = button.dataset.mode === mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    if (modeStatus) modeStatus.textContent =
        mode === 'existing'
            ? 'Session worker'
            : mode === 'wrapper'
                ? 'Direct wrapper'
                : mode === 'race'
                    ? 'Drag race mode.'
                    : 'Compare mode';
}

const startRaceBtn = document.getElementById('start-race');
const raceTrack = document.getElementById('race-track');
const previousRuns = document.getElementById('previous-runs');
const raceFormats = () => [...document.querySelectorAll('input[name="race-format"]:checked')].map(i => i.value);
const raceSize = () => document.querySelector('input[name="race-size"]:checked')?.value || '256';

let raceHistory = [];
let maxRaceTimeSoFar = 1000; // ms

async function encodeToJpeg(rgba, width, height, quality) {
    const started = performance.now();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height), 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality / 100));
    const encodeMs = performance.now() - started;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), encodeMs };
}

async function decodeFromBlob(blob) {
    const started = performance.now();
    const bitmap = await createImageBitmap(blob);
    const decodeMs = performance.now() - started;
    return { bitmap, decodeMs };
}

async function decodeJxlNative(bytes) {
    const started = performance.now();
    const blob = new Blob([bytes], { type: 'image/jxl' });
    const bitmap = await createImageBitmap(blob);
    const decodeMs = performance.now() - started;
    return { bitmap, decodeMs };
}

async function encodeToWebp(rgba, width, height, quality) {
    const started = performance.now();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height), 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality / 100));
    const encodeMs = performance.now() - started;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), encodeMs };
}

function resizeRgba(rgba, width, height, targetWidth) {
    if (targetWidth === 'fullsize') return { rgba, width, height };
    const scale = targetWidth / width;
    const targetHeight = Math.round(height * scale);
    const resizeRgbaImpl = rawWasm.downscale_rgba ?? downscaleRgbaCanvas;
    return {
        rgba: resizeRgbaImpl(rgba, width, height, targetWidth, targetHeight),
        width: targetWidth,
        height: targetHeight
    };
}

function downscaleRgbaCanvas(rgba, width, height, targetWidth, targetHeight) {
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = width;
    srcCanvas.height = height;
    const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
    srcCtx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);

    const dstCanvas = document.createElement('canvas');
    dstCanvas.width = targetWidth;
    dstCanvas.height = targetHeight;
    const dstCtx = dstCanvas.getContext('2d', { willReadFrequently: true });
    dstCtx.drawImage(srcCanvas, 0, 0, targetWidth, targetHeight);
    return new Uint8Array(dstCtx.getImageData(0, 0, targetWidth, targetHeight).data.buffer);
}

function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function updateRaceCardTimingBars(raceCards) {
    const runTotalBudget = Math.max(...raceCards.map(raceCard => raceCard.elapsed), 1);
    for (const raceCard of raceCards) {
        raceCard.meta.textContent = `${raceCard.format.toUpperCase()} ${fmtMs(raceCard.totalMs)} · ${fmtMs(raceCard.elapsed)}`;
        raceCard.bar.style.width = `${(raceCard.elapsed / runTotalBudget) * 100}%`;
    }
}

async function runRace() {
    const runId = ++activeRunId;
    const sources = buildBatchSources();
    if (!sources.length) {
        setStatus('Load files or random ORFs first.');
        return;
    }

    const formats = raceFormats();
    const targetSize = raceSize();
    const quality = getQuality();
    const effort = getEffort();
    const started = performance.now();
    const totalCards = formats.length * sources.length;

    raceTrack.innerHTML = '<div class="track-line"></div>';
    setStatus(`Racing ${sources.length} images in ${formats.join(', ')} @ ${targetSize}...`);

    const currentRunResults = [];
    const raceCards = [];
    const availableTrack = Math.max(0, raceTrack.clientWidth - RACE_CARD_SIZE);
    const slotSpacing = totalCards > 1 ? availableTrack / (totalCards - 1) : 0;

    for (const format of formats) {
        for (let i = 0; i < sources.length; i++) {
            if (runId !== activeRunId) return;
            const source = sources[i];
            const targetWidth = targetSize === 'fullsize' ? 'fullsize' : Number(targetSize);

            // 1. Resize
            const resized = await resizeRgba(source.rgba, source.width, source.height, targetWidth);

            let bytes, encodeMs, decodeMs, bitmap;

            if (format === 'jxl') {
                const enc = await encodeWithWrapper({ ...resized, rgba: resized.rgba });
                bytes = enc.bytes;
                encodeMs = enc.encodeMs;
                if (nativeJxlDecoder) {
                    const dec = await decodeJxlNative(bytes);
                    decodeMs = dec.decodeMs;
                    bitmap = dec.bitmap;
                } else {
                    const decodeStart = performance.now();
                    const dec = await decodeWithWrapper(bytes);
                    decodeMs = performance.now() - decodeStart;
                    const canvas = document.createElement('canvas');
                    canvas.width = resized.width;
                    canvas.height = resized.height;
                    rgbaToCanvas(canvas, toU8(dec.final.pixels), resized.width, resized.height);
                    bitmap = canvas;
                }
            } else if (format === 'jpeg') {
                const enc = await encodeToJpeg(resized.rgba, resized.width, resized.height, quality);
                bytes = enc.bytes;
                encodeMs = enc.encodeMs;
                const dec = await decodeFromBlob(new Blob([bytes], { type: 'image/jpeg' }));
                decodeMs = dec.decodeMs;
                bitmap = dec.bitmap;
            } else if (format === 'webp') {
                const enc = await encodeToWebp(resized.rgba, resized.width, resized.height, quality);
                bytes = enc.bytes;
                encodeMs = enc.encodeMs;
                const dec = await decodeFromBlob(new Blob([bytes], { type: 'image/webp' }));
                decodeMs = dec.decodeMs;
                bitmap = dec.bitmap;
            }

            const totalMs = encodeMs + decodeMs;
            const elapsed = performance.now() - started;

            const result = {
                format,
                index: i,
                encodeMs,
                decodeMs,
                totalMs,
                elapsed,
                size: bytes.byteLength
            };
            currentRunResults.push(result);

            // Add card to track
            const card = document.createElement('div');
            card.className = 'race-card';
            card.style.zIndex = i;
            const slotIndex = currentRunResults.length - 1;
            card.style.left = `${slotIndex * slotSpacing}px`;

            const canvas = document.createElement('canvas');
            canvas.width = RACE_CARD_SIZE;
            canvas.height = RACE_CARD_SIZE;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0, RACE_CARD_SIZE, RACE_CARD_SIZE);
            card.appendChild(canvas);

            const meta = document.createElement('div');
            meta.className = 'race-card-meta';
            card.appendChild(meta);

            const barWrap = document.createElement('div');
            barWrap.className = 'race-card-bar-wrap';
            const bar = document.createElement('div');
            bar.className = 'race-card-bar';
            barWrap.appendChild(bar);
            card.appendChild(barWrap);

            raceTrack.appendChild(card);
            raceCards.push({ card, meta, bar, format, totalMs, elapsed });
            updateRaceCardTimingBars(raceCards);

            dbgLog(
                `  race ${format} [${i + 1}/${sources.length}]`,
                `orig ${source.width}×${source.height} → work ${resized.width}×${resized.height} · ${fmtBytes(bytes.byteLength)} · enc ${fmtMs(encodeMs)} · dec ${fmtMs(decodeMs)} · total ${fmtMs(totalMs)} · elapsed ${fmtMs(elapsed)}`,
                'info'
            );

            await nextFrame();

            updateProgressStatus({ started, jobs: sources, done: currentRunResults.length, errors: 0 });
        }
    }

    const runTotalMs = performance.now() - started;
    const runLabel = `${formats.join('+')} @ ${targetSize === 'fullsize' ? 'fullsize' : `${targetSize}px`} · ${fmtMs(runTotalMs)}`;
    raceHistory.push({ label: runLabel, totalMs: runTotalMs });
    updateRaceHistory();
    setStatus('Race finished.', `${runLabel} elapsed`);
}

function updateRaceHistory() {
    previousRuns.innerHTML = '';
    const maxTime = Math.max(...raceHistory.map(r => r.totalMs), 1);
    for (const run of raceHistory) {
        const bar = document.createElement('div');
        bar.className = 'run-progress-bar';
        const fill = document.createElement('div');
        fill.className = 'run-fill';
        fill.style.width = `${(run.totalMs / maxTime) * 100}%`;
        const label = document.createElement('div');
        label.className = 'run-label';
        label.textContent = run.label;
        bar.appendChild(fill);
        bar.appendChild(label);
        previousRuns.appendChild(bar);
    }
}


function syncSettingLabels() {
    if (batchLimitValue) batchLimitValue.textContent = String(getBatchLimit());
    if (batchConcurrencyValue) batchConcurrencyValue.textContent = String(getConcurrency());
    if (batchQualityValue) batchQualityValue.textContent = String(getQuality());
    if (batchEffortValue) batchEffortValue.textContent = String(getEffort());
    loadRandomBtn.textContent = `Load ${getBatchLimit()} random Gobabeb file${getBatchLimit() === 1 ? '' : 's'}`;
}

function getBatchLimit() {
    return clamp(Number(batchLimitInput.value) || MAX_BATCH_LIMIT, 1, MAX_BATCH_LIMIT);
}

function getConcurrency() {
    return clamp(Number(batchConcurrencyInput.value) || 1, 1, 16);
}

function getQuality() {
    return clamp(Number(batchQualityInput.value) || 90, 50, 100);
}

function getEffort() {
    return clamp(Number(batchEffortInput.value) || 3, 1, 9);
}

function getDecodeSpeed() {
    if (!batchDecodeSpeedInput) return undefined;
    const v = clamp(Math.round(Number(batchDecodeSpeedInput.value) || 0), 0, 4);
    return v > 0 ? v : undefined;
}

function getPhotonNoiseIso() {
    if (!batchPhotonNoiseIsoInput) return 0;
    return clamp(Math.round(Number(batchPhotonNoiseIsoInput.value) || 0), 0, 51200);
}

function getResampling() {
    const value = Number(batchResamplingInputs.find((input) => input.checked)?.value || 1);
    return value === 2 || value === 4 || value === 8 ? value : 1;
}

function getModular() {
    const v = Number(batchModularInputs.find(i => i.checked)?.value ?? -1);
    return (v === -1 || v === 0 || v === 1) ? v : -1;
}

function getBrotliEffort() {
    if (!batchBrotliEffortInput) return -1;
    const v = Math.round(Number(batchBrotliEffortInput.value) || -1);
    return Math.max(-1, Math.min(11, v));
}

/** Phase 1: first-class advanced filters (DOTS/PATCHES/EPF/GABORISH) via the new advancedControls surface. */
function getAdvancedFilters() {
    if (!batchAdvancedFilters) return undefined;
    const f = {};
    if (batchAdvancedFilters.dots && batchAdvancedFilters.dots.checked) f.dots = true;
    if (batchAdvancedFilters.patches && batchAdvancedFilters.patches.checked) f.patches = true;
    if (batchAdvancedFilters.epf) {
        const v = Number(batchAdvancedFilters.epf.value);
        if (!Number.isNaN(v)) f.epf = v;
    }
    if (batchAdvancedFilters.gaborish && batchAdvancedFilters.gaborish.checked) f.gaborish = true;
    return Object.keys(f).length > 0 ? { filters: f } : undefined;
}

function getGroupOrderControls() {
    const modeInputs = document.querySelectorAll('input[name="batch-group-order-mode"]');
    const mode = [...modeInputs].find(i => i.checked)?.value || 'scanline';
    const cxEl = document.getElementById('batch-group-center-x');
    const cyEl = document.getElementById('batch-group-center-y');
    const cx = cxEl ? Number(cxEl.value) : NaN;
    const cy = cyEl ? Number(cyEl.value) : NaN;

    const go = { mode };
    if (!Number.isNaN(cx)) go.centerX = Math.floor(cx);
    if (!Number.isNaN(cy)) go.centerY = Math.floor(cy);
    return (mode === 'center' || go.centerX !== undefined || go.centerY !== undefined) ? { groupOrder: go } : undefined;
}

/** Gain map (HDR) transport — mandatory benchmark wiring per gain-maps.md.
 * Returns { data: Uint8Array | ArrayBuffer } when demo checked or a file is selected.
 * Demo uses a tiny placeholder to exercise the full jhgm box encode/decode path (content is irrelevant for transport test).
 */
let currentGainMapBytes = null; // Uint8Array | null
const DEMO_GAIN_MAP_BYTES = new Uint8Array([0xff, 0x0a, 0x00, 0x10, 0x4a, 0x58, 0x4c, 0x20, 0x67, 0x61, 0x69, 0x6e, 0x20, 0x64, 0x65, 0x6d, 0x6f]); // placeholder (validates transport; replace with real for perceptual use)

function getGainMap() {
    const useDemo = document.getElementById('batch-gainmap-use-demo');
    const fileInput = document.getElementById('batch-gainmap-file');
    if (useDemo && useDemo.checked) {
        return { data: DEMO_GAIN_MAP_BYTES };
    }
    if (currentGainMapBytes && currentGainMapBytes.byteLength > 0) {
        return { data: currentGainMapBytes };
    }
    return undefined;
}

function getAlphaDistance() {
    if (!batchAlphaDistanceInput) return undefined;
    const raw = batchAlphaDistanceInput.value.trim();
    if (raw === '') return undefined;
    const v = parseFloat(raw);
    return isNaN(v) ? undefined : Math.max(0, Math.min(2, v));
}

function getLossless() {
    return Boolean(batchLosslessInput.checked);
}

function getCompressBoxes() {
    return Boolean(batchCompressBoxesInput?.checked);
}

function getForceContainer() {
    return Boolean(batchForceContainerInput?.checked);
}

function getRawCodestream() {
    return Boolean(batchRawCodestreamInput?.checked);
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

function fmtMs(ms) {
    if (!Number.isFinite(ms)) return '--';
    return `${ms.toFixed(0)} ms`;
}

function fmtTiming(ms) {
    return ms == null ? '--' : `${ms.toFixed(0)} ms`;
}

function summarizeTiming(rows, key) {
    if (!rows.length) return null;
    const values = rows.map((row) => row[key]).filter((value) => Number.isFinite(value));
    if (!values.length) return null;
    const sum = values.reduce((total, value) => total + value, 0);
    return sum / values.length;
}

function timingsForCurrentMode(entries) {
    return entries
        .flatMap((entry) => {
            if (currentMode === 'existing') return entry.existing ? [entry.existing] : [];
            if (currentMode === 'wrapper') return entry.wrapper ? [entry.wrapper] : [];
            return [entry.existing, entry.wrapper].filter(Boolean);
        });
}

function formatRunSummary(entries) {
    const rows = timingsForCurrentMode(entries);
    if (!rows.length) return 'no timing data';
    return [
        `load avg ${fmtTiming(summarizeTiming(rows, 'loadMs'))}`,
        `enc avg ${fmtTiming(summarizeTiming(rows, 'encodeMs'))}`,
        `first piece avg ${fmtTiming(summarizeTiming(rows, 'firstPieceMs'))}`,
        `dec avg ${fmtTiming(summarizeTiming(rows, 'decodeMs'))}`,
        `first paint avg ${fmtTiming(summarizeTiming(rows, 'firstPaintMs'))}`,
    ].join(' · ');
}

function resetCompareStats() {
    if (statsExistingTotal) statsExistingTotal.textContent = '--';
    if (statsWrapperTotal) statsWrapperTotal.textContent = '--';
    if (statsTotalDelta) statsTotalDelta.textContent = '--';
    if (statsWrapperFaster) statsWrapperFaster.textContent = '--';
}

function updateCompareStats(entries) {
    if (!statsExistingTotal && !statsWrapperTotal && !statsTotalDelta && !statsWrapperFaster) return;
    const pairs = entries.filter((entry) => entry?.existing && entry?.wrapper);
    if (!pairs.length) {
        resetCompareStats();
        return;
    }
    const existingTotals = pairs.map((entry) => entry.existing.totalMs).filter(Number.isFinite);
    const wrapperTotals = pairs.map((entry) => entry.wrapper.totalMs).filter(Number.isFinite);
    const deltas = pairs
        .map((entry) => Number.isFinite(entry.existing.totalMs) && Number.isFinite(entry.wrapper.totalMs)
            ? entry.wrapper.totalMs - entry.existing.totalMs
            : null)
        .filter((value) => Number.isFinite(value));
    const wrapperFaster = deltas.filter((value) => value < 0).length;
    const avg = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

    if (statsExistingTotal) statsExistingTotal.textContent = fmtTiming(avg(existingTotals));
    if (statsWrapperTotal) statsWrapperTotal.textContent = fmtTiming(avg(wrapperTotals));
    if (statsTotalDelta) {
        const avgDelta = avg(deltas);
        statsTotalDelta.textContent = avgDelta == null ? '--' : `${avgDelta >= 0 ? '+' : ''}${avgDelta.toFixed(0)} ms`;
    }
    if (statsWrapperFaster) statsWrapperFaster.textContent = `${wrapperFaster}/${pairs.length}`;
}

function toU8(value) {
    if (value instanceof Uint8Array) return value;
    return new Uint8Array(value);
}

function exactBuffer(view) {
    if (view instanceof ArrayBuffer) return view;
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function transferableBuffer(view) {
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer !== null) clearTimeout(timer);
    });
}

function resultByteLength(result) {
    return result.byteLength ?? result.bytes?.byteLength ?? 0;
}

function concatChunks(chunks) {
    const views = chunks.map(toU8);
    if (views.length === 1) return views[0];
    const total = views.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of views) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

function sizeForMaxEdge(width, height, maxEdge = TILE_CANVAS_MAX_EDGE) {
    const largest = Math.max(width, height);
    if (!Number.isFinite(largest) || largest <= 0) return { width: 1, height: 1 };
    if (largest <= maxEdge) return { width, height };
    const scale = maxEdge / largest;
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

function rgbaToCanvas(canvas, rgba, width, height) {
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height), 0, 0);
}

function paintDecodedToTileCanvas(canvas, decoded) {
    if (decoded instanceof ImageBitmap) {
        const target = sizeForMaxEdge(decoded.width, decoded.height);
        if (canvas.width !== target.width) canvas.width = target.width;
        if (canvas.height !== target.height) canvas.height = target.height;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'medium';
        ctx.clearRect(0, 0, target.width, target.height);
        ctx.drawImage(decoded, 0, 0, target.width, target.height);
        return;
    }
    const width = decoded.info.width;
    const height = decoded.info.height;
    const target = sizeForMaxEdge(width, height);
    rgbaToCanvas(paintScratchCanvas, toU8(decoded.pixels), width, height);
    if (canvas.width !== target.width) canvas.width = target.width;
    if (canvas.height !== target.height) canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(paintScratchCanvas, 0, 0, width, height, 0, 0, target.width, target.height);
}

function makeTile(index) {
    const tile = document.createElement('article');
    tile.className = 'tile';
    tile.dataset.state = 'idle';
    tile.innerHTML = `
        <header>
            <div>
                <p class="slot">Tile ${String(index + 1).padStart(2, '0')}</p>
                <h3>Waiting for source</h3>
            </div>
            <div class="chip" data-kind="compare">Idle</div>
        </header>
        <canvas width="96" height="96"></canvas>
        <div class="tile-meta">
            <div class="metric-line" data-kind="existing"><span>Existing</span><strong>--</strong></div>
            <div class="metric-line" data-kind="wrapper"><span>Wrapper</span><strong>--</strong></div>
            <div class="metric-line" data-kind="timing"><span>Timing</span><strong>--</strong></div>
            <div class="metric-line" data-kind="compare"><span>Compare</span><strong>--</strong></div>
        </div>
        <div class="error-detail">
            <pre class="error-text"></pre>
            <button class="error-copy-btn" type="button">Copy</button>
        </div>
    `;
    return {
        el: tile,
        title: tile.querySelector('h3'),
        chip: tile.querySelector('.chip'),
        canvas: tile.querySelector('canvas'),
        existing: tile.querySelector('.metric-line[data-kind="existing"] strong'),
        wrapper: tile.querySelector('.metric-line[data-kind="wrapper"] strong'),
        timing: tile.querySelector('.metric-line[data-kind="timing"] strong'),
        compare: tile.querySelector('.metric-line[data-kind="compare"] strong'),
        errorDetail: tile.querySelector('.error-detail'),
        errorText: tile.querySelector('.error-text'),
        errorCopyBtn: tile.querySelector('.error-copy-btn'),
    };
}

const tiles = Array.from({ length: MAX_BATCH_LIMIT }, (_, index) => makeTile(index));
for (const tile of tiles) {
    batchGrid.appendChild(tile.el);
    tile.chip.addEventListener('click', () => {
        if (tile.el.dataset.state !== 'error') return;
        tile.errorDetail.classList.toggle('is-open');
    });
    tile.errorCopyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(tile.errorText.textContent).then(() => {
            tile.errorCopyBtn.textContent = 'Copied!';
            tile.errorCopyBtn.classList.add('copied');
            setTimeout(() => {
                tile.errorCopyBtn.textContent = 'Copy';
                tile.errorCopyBtn.classList.remove('copied');
            }, 2000);
        });
    });
}

function resetTile(tile, label = 'Waiting for source') {
    tile.el.dataset.state = 'idle';
    tile.title.textContent = label;
    tile.chip.textContent = 'Idle';
    tile.existing.textContent = '--';
    tile.wrapper.textContent = '--';
    tile.timing.textContent = '--';
    tile.compare.textContent = '--';
    tile.errorDetail.classList.remove('is-open');
    tile.errorText.textContent = '';
    tile._timings = null;
    const ctx = tile.canvas.getContext('2d');
    tile.canvas.width = 96;
    tile.canvas.height = 96;
    ctx.clearRect(0, 0, tile.canvas.width, tile.canvas.height);
}

function resetGrid() {
    for (const tile of tiles) resetTile(tile);
    resetCompareStats();
}

function setCounters({ loaded = selectedSources.length, queued = 0, done = 0, errors = 0 } = {}) {
    loadedCount.textContent = String(loaded);
    queuedCount.textContent = String(queued);
    doneCount.textContent = String(done);
    errorCount.textContent = String(errors);
}

function setStatus(text, timing = 'Ready.') {
    batchStatus.textContent = text;
    timingStatus.textContent = timing;
}

function updateProgressStatus({ started, jobs, done, errors, force = false }) {
    const now = performance.now();
    if (!force && now - lastProgressStatusAt < STATUS_UPDATE_INTERVAL_MS) return;
    lastProgressStatusAt = now;
    setCounters({ loaded: selectedSources.length, queued: jobs.length, done, errors });
    timingStatus.textContent = `${fmtMs(now - started)} elapsed`;
}

function syncBatchThumbSize() {
    const selected = batchThumbSizeInputs.find((input) => input.checked)?.value || '256';
    batchThumbSize = selected;
    const gridSize = selected === 'fullsize' ? 320 : clamp(Number(selected) || 256, 128, 2048);
    setCssVar('--batch-thumb-size', `${Math.min(gridSize, 320)}px`);
}

async function loadRandomFileSource() {
    const started = performance.now();
    const resp = await fetch('/api/random-gobabeb', { cache: 'no-store' });
    if (!resp.ok) throw new Error(`random Gobabeb request failed: ${resp.status}`);
    const raw = new Uint8Array(await resp.arrayBuffer());
    const name = resp.headers.get('x-file-name') || 'random.orf';
    const folder = resp.headers.get('x-source-folder') || 'source folder';
    const source = await loadBytesSourceByName(raw, name, folder, resp.headers.get('x-file-size') || '');
    source.loadMs = performance.now() - started;
    return source;
}

async function loadFileSource(file) {
    const started = performance.now();
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'orf') {
        const raw = new Uint8Array(await file.arrayBuffer());
        const source = loadBytesAsSource(raw, file.name, '', `${fmtBytes(file.size)}`);
        source.loadMs = performance.now() - started;
        return source;
    }

    if (ext === 'cr2') {
        const raw = new Uint8Array(await file.arrayBuffer());
        const source = loadBytesAsCr2Source(raw, file.name, '', `${fmtBytes(file.size)}`);
        source.loadMs = performance.now() - started;
        return source;
    }

    if (ext === 'jxl') {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const source = await decodeBytesToSource(bytes, `${file.name} · JXL · ${fmtBytes(file.size)}`);
        source.loadMs = performance.now() - started;
        return source;
    }

    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    bitmap.close?.();
    return {
        name: file.name,
        label: `${file.name} · ${canvas.width}×${canvas.height}`,
        meta: fmtBytes(file.size),
        width: canvas.width,
        height: canvas.height,
        rgba: new Uint8Array(pixels.buffer.slice(0)),
        loadMs: performance.now() - started,
    };
}

function fileCacheKey(file) {
    return `${file.name}:${file.size}:${file.lastModified}`;
}

async function loadFilesConcurrently(files) {
    const loaded = Array(files.length);
    let nextIndex = 0;
    let completed = 0;
    const workers = Array.from({ length: Math.min(WRAPPER_FILE_LOAD_CONCURRENCY, files.length) }, async () => {
        while (nextIndex < files.length) {
            const index = nextIndex++;
            const file = files[index];
            const key = fileCacheKey(file);
            let source = sourceCache.get(key);
            if (!source) {
                source = await loadFileSource(file);
                sourceCache.set(key, source);
            }
            loaded[index] = source;
            completed++;
            batchStatus.textContent = `Loading ${files.length} file(s) ${completed}/${files.length}...`;
            selectionStatus.textContent = `Loaded ${completed}/${files.length} file(s).`;
            setCounters({ loaded: completed });
        }
    });
    await Promise.all(workers);
    return loaded;
}

async function loadBytesSourceByName(bytes, name, folder = '', sizeLabel = '') {
    const started = performance.now();
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (ext === 'orf') {
        const source = loadBytesAsSource(bytes, name, folder, sizeLabel);
        source.loadMs = performance.now() - started;
        return source;
    }
    if (ext === 'cr2') {
        const source = loadBytesAsCr2Source(bytes, name, folder, sizeLabel);
        source.loadMs = performance.now() - started;
        return source;
    }
    if (ext === 'jxl') {
        const source = await decodeBytesToSource(bytes, `${name} · JXL · ${sizeLabel || fmtBytes(bytes.byteLength)}`);
        source.loadMs = performance.now() - started;
        return source;
    }
    if (['jpg', 'jpeg', 'png', 'tif', 'tiff', 'bmp', 'gif', 'webp'].includes(ext)) {
        const blob = new Blob([bytes], { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` });
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        bitmap.close?.();
        return {
            name,
            label: `${name} · ${canvas.width}×${canvas.height}`,
            meta: [folder, sizeLabel || fmtBytes(bytes.byteLength)].filter(Boolean).join(' · '),
            width: canvas.width,
            height: canvas.height,
            rgba: new Uint8Array(pixels.buffer.slice(0)),
            loadMs: performance.now() - started,
        };
    }
    return {
        name,
        label: `${name} · ${fmtBytes(bytes.byteLength)}`,
        meta: [folder, 'unsupported'].filter(Boolean).join(' · '),
        width: 1,
        height: 1,
        rgba: new Uint8Array([255, 0, 255, 255]),
        loadMs: performance.now() - started,
    };
}

function loadBytesAsSource(bytes, name, folder = '', sizeLabel = '') {
    const started = performance.now();
    const result = process_orf(bytes, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
    try {
        const rgb = result.take_rgb();
        return {
            name,
            label: `${name} · ORF · ${result.width}×${result.height}`,
            meta: [folder, sizeLabel].filter(Boolean).join(' · '),
            width: result.width,
            height: result.height,
            rgba: rgb_to_rgba(rgb),
            loadMs: performance.now() - started,
        };
    } finally {
        result.free();
    }
}

function loadBytesAsCr2Source(bytes, name, folder = '', sizeLabel = '') {
    const started = performance.now();
    const result = process_cr2(bytes, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
    try {
        const rgb = result.take_rgb();
        return {
            name,
            label: `${name} · CR2 · ${result.width}×${result.height}`,
            meta: [folder, sizeLabel].filter(Boolean).join(' · '),
            width: result.width,
            height: result.height,
            rgba: rgb_to_rgba(rgb),
            loadMs: performance.now() - started,
        };
    } finally {
        result.free();
    }
}

async function decodeBytesToSource(bytes, label) {
    const started = performance.now();
    const decoder = createDecoder({
        format: 'rgba8',
        region: null,
        downsample: 1,
        progressionTarget: 'final',
        emitEveryPass: false,
        preserveIcc: true,
        preserveMetadata: true,
    });
    try {
        await decoder.push(exactBuffer(bytes));
        await decoder.close();
        let final = null;
        for await (const ev of decoder.events()) {
            if (ev.type === 'final') final = ev;
        }
        if (!final) throw new Error('JXL decode produced no final frame');
        return {
            name: label,
            label: `${label} · JXL · ${final.info.width}×${final.info.height}`,
            meta: 'decoded by wrapper',
            width: final.info.width,
            height: final.info.height,
            rgba: toU8(final.pixels),
            loadMs: performance.now() - started,
        };
    } finally {
        await decoder.dispose();
    }
}

function buildBatchSources() {
    const limit = getBatchLimit();
    if (!selectedSources.length) return [];
    const out = [];
    for (let i = 0; i < limit; i++) {
        out.push(selectedSources[i % selectedSources.length]);
    }
    return out;
}

async function loadSourcesFromFiles(fileList) {
    const files = [...fileList].slice(0, MAX_BATCH_LIMIT);
    if (!files.length) return;
    const started = performance.now();
    batchStatus.textContent = `Loading ${files.length} file(s)...`;
    resetCompareStats();
    const loaded = await loadFilesConcurrently(files);
    selectedSources = loaded;
    const elapsed = performance.now() - started;
    selectionStatus.textContent = `${loaded.length} file(s) ready in ${fmtTiming(elapsed)}.`;
    batchStatus.textContent = `Loaded ${loaded.length} file(s) in ${fmtTiming(elapsed)}.`;
    setCounters({ loaded: loaded.length });
    updateRunButtons();
}

async function loadRandomSources(count = MAX_BATCH_LIMIT) {
    const loadId = ++activeLoadId;
    const total = clamp(count, 1, MAX_BATCH_LIMIT);
    const started = performance.now();
    loadRandomBtn.disabled = true;
    batchStatus.textContent = `Loading Gobabeb files 0/${total}...`;
    resetCompareStats();
    const loaded = Array(total);
    let nextIndex = 0;
    let completed = 0;
    const workers = Array.from({ length: Math.min(RANDOM_LOAD_CONCURRENCY, total) }, async () => {
        while (nextIndex < total && loadId === activeLoadId) {
            const index = nextIndex++;
            loaded[index] = await loadRandomFileSource();
            if (loadId !== activeLoadId) return;
            completed++;
            batchStatus.textContent = `Loading Gobabeb files ${completed}/${total}...`;
            selectionStatus.textContent = `Loaded ${completed}/${total} random Gobabeb files.`;
            setCounters({ loaded: completed });
        }
    });
    await Promise.all(workers);
    loadRandomBtn.disabled = false;
    if (loadId !== activeLoadId) return;
    selectedSources = loaded;
    const elapsed = performance.now() - started;
    selectionStatus.textContent = `${loaded.length} random Gobabeb files ready in ${fmtTiming(elapsed)}.`;
    batchStatus.textContent = `Loaded ${loaded.length}/${total} random Gobabeb files in ${fmtTiming(elapsed)}.`;
    setCounters({ loaded: loaded.length });
    updateRunButtons();
}

function makeEncoderOptions(source) {
    const lossless = getLossless();
    const compressBoxes = getCompressBoxes();
    const forceContainer = getForceContainer();
    const rawCodestream = getRawCodestream();
    const hasMetadataOpts = compressBoxes || forceContainer || rawCodestream;
    const modular = getModular();
    const brotliEffort = getBrotliEffort();
    return {
        format: 'rgba8',
        width: source.width,
        height: source.height,
        hasAlpha: true,
        distance: lossless ? 0 : null,
        quality: lossless ? null : getQuality(),
        effort: getEffort(),
        progressive: false,
        previewFirst: false,
        chunked: false,
        decodingSpeed: getDecodeSpeed(),
        photonNoiseIso: getPhotonNoiseIso() > 0 ? getPhotonNoiseIso() : undefined,
        resampling: getResampling(),
        modular: modular !== -1 ? modular : undefined,
        brotliEffort: brotliEffort >= 0 ? brotliEffort : undefined,
        metadata: hasMetadataOpts ? { compressBoxes, forceContainer, rawCodestream } : undefined,
        alphaDistance: getAlphaDistance(),
        // Gain map (HDR) transport — exercises jhgm box path when provided (mandatory per gain-maps.md)
        gainMap: getGainMap(),
        // First-class advanced controls (Phase 1 slice)
        advancedControls: (() => {
            const f = getAdvancedFilters();
            const g = getGroupOrderControls();
            const out = {};
            if (f?.filters) out.filters = f.filters;
            if (g?.groupOrder) out.groupOrder = g.groupOrder;
            return Object.keys(out).length ? out : undefined;
        })(),
    };
}

function makeDecoderOptions() {
    return {
        format: 'rgba8',
        region: null,
        downsample: 1,
        progressionTarget: 'final',
        emitEveryPass: false,
        preserveIcc: true,
        preserveMetadata: true,
    };
}

async function encodeWithWrapper(source) {
    const started = performance.now();
    const encoder = createEncoder(makeEncoderOptions(source));
    const chunks = [];
    let firstChunkMs = null;
    try {
        const chunkTask = (async () => {
            for await (const chunk of encoder.chunks()) {
                if (firstChunkMs == null) firstChunkMs = performance.now() - started;
                chunks.push(chunk);
            }
        })();
        await encoder.pushPixels(exactBuffer(source.rgba));
        await encoder.finish();
        await chunkTask;
        return { bytes: concatChunks(chunks), encodeMs: performance.now() - started, firstChunkMs };
    } finally {
        await encoder.dispose();
    }
}

async function decodeWithWrapper(bytes) {
    const decoder = createDecoder(makeDecoderOptions());
    try {
        await decoder.push(exactBuffer(bytes));
        await decoder.close();
        let final = null;
        for await (const ev of decoder.events()) {
            if (ev.type === 'final') final = ev;
        }
        if (!final) throw new Error('wrapper decode produced no final frame');
        return { final };
    } finally {
        await decoder.dispose();
    }
}

async function encodeWithSession(source) {
    const started = performance.now();
    const session = existingContext.encode(makeEncoderOptions(source));
    const chunks = [];
    let firstChunkMs = null;
    const chunkTask = (async () => {
        for await (const chunk of session.chunks()) {
            if (firstChunkMs == null) firstChunkMs = performance.now() - started;
            chunks.push(chunk);
        }
    })();
    try {
        await withTimeout(session.pushPixels(exactBuffer(source.rgba)), SESSION_STAGE_TIMEOUT_MS, 'session encode pushPixels');
        await withTimeout(session.finish(), SESSION_STAGE_TIMEOUT_MS, 'session encode finish');
        const [totalBytes] = await withTimeout(
            Promise.all([session.done(), chunkTask]).then(([doneBytes]) => [doneBytes]),
            SESSION_COMPLETION_TIMEOUT_MS,
            'session encode completion',
        );
        if (chunks.length === 0) {
            throw new Error(`session encode finished with ${totalBytes} bytes but yielded no chunks`);
        }
        return { bytes: concatChunks(chunks), encodeMs: performance.now() - started, firstChunkMs };
    } catch (error) {
        await session.cancel?.(`wrapper lab encode failed: ${error?.message || error}`).catch(() => {});
        throw error;
    }
}

async function decodeWithSession(bytes) {
    const session = existingContext.decode(makeDecoderOptions());
    try {
        await withTimeout(session.push(transferableBuffer(bytes)), SESSION_STAGE_TIMEOUT_MS, 'session decode push');
        await withTimeout(session.close(), SESSION_STAGE_TIMEOUT_MS, 'session decode close');
        let final = null;
        const doneTask = withTimeout(session.done(), SESSION_COMPLETION_TIMEOUT_MS, 'session decode completion');
        for await (const ev of session.frames()) {
            if (ev.stage === 'final') final = ev;
        }
        await doneTask;
        if (!final) throw new Error('existing session decode produced no final frame');
        return { final };
    } catch (error) {
        await session.cancel?.(`wrapper lab decode failed: ${error?.message || error}`).catch(() => {});
        throw error;
    }
}

async function runExistingSessionPipeline(source, attempt = 1) {
    const attemptSource = { ...source, rgba: source.rgba.slice() };
    if (attempt > 1) {
        dbgLog(`  session retry → attempt ${attempt}`, `${attemptSource.width}×${attemptSource.height}`);
    }
    const encodeStart = performance.now();
    const encoded = await encodeWithSession(attemptSource);
    const encodeMs = encoded.encodeMs ?? (performance.now() - encodeStart);
    // Capture byteLength before decodeWithSession transfers encoded.bytes.buffer.
    const encodedByteLength = encoded.bytes.byteLength;
    dbgLog(`  session enc ← ${fmtBytes(encodedByteLength)} jxl · enc ${fmtMs(encodeMs)} · first ${fmtMs(encoded.firstChunkMs)}`);

    dbgLog(`  session dec → ${fmtBytes(encodedByteLength)} jxl`);
    const decodeStart = performance.now();
    const decoded = await decodeWithSession(encoded.bytes);
    const decodeMs = performance.now() - decodeStart;
    dbgLog(`  session dec ← ${decoded.final?.info?.width}×${decoded.final?.info?.height} · ${fmtMs(decodeMs)}`);

    return {
        bytes: encoded.bytes,
        byteLength: encodedByteLength,
        encodeMs,
        firstPieceMs: encoded.firstChunkMs ?? null,
        decodeMs,
        final: decoded.final,
    };
}

async function runWrapperPipeline(source, label = 'wrapper') {
    dbgLog(`  ${label} enc → ${source.width}×${source.height} · q=${getQuality()} effort=${getEffort()}`);
    const encodeStart = performance.now();
    const encoded = await encodeWithWrapper(source);
    const encodeMs = encoded.encodeMs ?? (performance.now() - encodeStart);
    // Capture byteLength before decodeWithWrapper transfers encoded.bytes.buffer.
    const encodedByteLength = encoded.bytes.byteLength;
    dbgLog(`  ${label} enc ← ${fmtBytes(encodedByteLength)} jxl · enc ${fmtMs(encodeMs)} · first ${fmtMs(encoded.firstChunkMs)}`);

    dbgLog(`  ${label} dec → ${fmtBytes(encodedByteLength)} jxl`);
    let decodedFinal, decodeMs;
    if (nativeJxlDecoder) {
        const { bitmap, decodeMs: dm } = await decodeJxlNative(encoded.bytes);
        decodedFinal = bitmap;
        decodeMs = dm;
        dbgLog(`  ${label} dec ← ${bitmap.width}×${bitmap.height} [native] · ${fmtMs(decodeMs)}`);
    } else {
        const decodeStart = performance.now();
        const decoded = await decodeWithWrapper(encoded.bytes);
        decodeMs = performance.now() - decodeStart;
        decodedFinal = decoded.final;
        dbgLog(`  ${label} dec ← ${decodedFinal?.info?.width}×${decodedFinal?.info?.height} · ${fmtMs(decodeMs)}`);
    }

    return {
        bytes: encoded.bytes,
        byteLength: encodedByteLength,
        encodeMs,
        firstPieceMs: encoded.firstChunkMs ?? null,
        decodeMs,
        final: decodedFinal,
    };
}

function paintTileResult(tile, source, existingResult, wrapperResult, startedAt) {
    const canvas = tile.canvas;
    const decoded = currentMode === 'existing'
        ? existingResult?.final
        : (wrapperResult?.final || existingResult?.final);

    if (!decoded) {
        throw new Error('No decoded result to paint');
    }

    const paintStarted = performance.now();
    paintDecodedToTileCanvas(canvas, decoded);
    const paintMs = performance.now() - paintStarted;
    const firstPaintMs = performance.now() - startedAt;
    tile.el.dataset.state = 'done';
    
    let modeLabel = 'Existing';
    if (currentMode === 'compare' || currentMode === 'race') modeLabel = 'Compare';
    else if (currentMode === 'wrapper') modeLabel = 'Wrapper';
    
    tile.chip.textContent = modeLabel;
    tile.title.textContent = source.label;
    
    tile.existing.textContent = existingResult
        ? `${fmtBytes(resultByteLength(existingResult))} · total ${fmtMs(existingResult.totalMs)} · load ${fmtMs(existingResult.loadMs)} · enc ${fmtMs(existingResult.encodeMs)} · first ${fmtMs(existingResult.firstPieceMs)} · dec ${fmtMs(existingResult.decodeMs)}${existingResult.fallback ? ' · fallback' : ''}`
        : '--';
    tile.wrapper.textContent = wrapperResult
        ? `${fmtBytes(resultByteLength(wrapperResult))} · total ${fmtMs(wrapperResult.totalMs)} · load ${fmtMs(wrapperResult.loadMs)} · enc ${fmtMs(wrapperResult.encodeMs)} · first ${fmtMs(wrapperResult.firstPieceMs)} · dec ${fmtMs(wrapperResult.decodeMs)}`
        : '--';
    tile.timing.textContent = `first paint ${fmtMs(firstPaintMs)} · draw ${fmtMs(paintMs)}`;
    if (existingResult && wrapperResult) {
        const byteDelta = resultByteLength(wrapperResult) - resultByteLength(existingResult);
        const msDelta = wrapperResult.totalMs - existingResult.totalMs;
        tile.compare.textContent = `${byteDelta === 0 ? 'bytes match' : `${byteDelta > 0 ? '+' : ''}${byteDelta} B`} · total ${msDelta >= 0 ? '+' : ''}${msDelta.toFixed(0)} ms · tile ${fmtMs(firstPaintMs)}`;
    } else {
        tile.compare.textContent = '--';
    }
    const ms = performance.now() - startedAt;
    if (currentMode === 'compare' || currentMode === 'race') {
        tile.chip.textContent = 'Compare';
    }
    tile.el.title = `${source.label} · first paint ${fmtTiming(firstPaintMs)} · total ${fmtTiming(ms)}`;

    // Gain map (HDR) result badge + download action (mandatory benchmark wiring per gain-maps.md)
    const gm = decoded?.gainMap?.data;
    if (gm && (gm.byteLength || gm.length)) {
        const gmSize = gm.byteLength || gm.length;
        const gmNote = document.createElement('span');
        gmNote.style.cssText = 'margin-left:6px; font-size:10px; padding:1px 5px; border:1px solid #4a9; border-radius:3px; cursor:pointer; background:#f0f9f4; user-select:none;';
        gmNote.textContent = `GM ${fmtBytes(gmSize)} ⬇`;
        gmNote.title = 'Download extracted gain map JXL codestream (from jhgm box via official APIs)';
        gmNote.onclick = (e) => {
            e.stopPropagation();
            const blob = new Blob([gm], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${(source.label || 'image').replace(/[^\w.-]+/g, '_')}.gainmap.jxl`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
        // Append to the wrapper meta line for visibility in batch results
        if (tile.wrapper && tile.wrapper.parentNode) {
            tile.wrapper.parentNode.appendChild(gmNote);
        } else if (tile.el) {
            tile.el.appendChild(gmNote);
        }
    }

    return { paintMs, firstPaintMs, totalMs: ms };
}

async function processOneSource(source, index, runId) {
    const tile = tiles[index];
    if (!tile) return;
    tile.el.dataset.state = 'working';
    tile.title.textContent = source.label;
    tile.chip.textContent = 'Working';
    const startedAt = performance.now();

    dbgLog(`▶ [${index + 1}] ${source.label}`, `orig ${source.width}×${source.height} · ${fmtBytes(source.rgba.byteLength)} rgba`);

    const maxEdge = batchThumbSize === 'fullsize' ? 'fullsize' : (Number(batchThumbSize) || TILE_CANVAS_MAX_EDGE);
    const needsResize = maxEdge !== 'fullsize' && (source.width > maxEdge || source.height > maxEdge);
    const thumbW = needsResize
        ? (source.width >= source.height ? maxEdge : Math.round(source.width * maxEdge / source.height))
        : source.width;

    let encodeSource = source;
    if (needsResize) {
        const rt0 = performance.now();
        const resized = await resizeRgba(source.rgba, source.width, source.height, thumbW);
        encodeSource = { ...source, ...resized };
        dbgLog(`  resize → ${resized.width}×${resized.height} · ${fmtBytes(resized.rgba.byteLength)} rgba · ${fmtMs(performance.now() - rt0)}`);
    }

    let existingResult = null;
    let wrapperResult = null;

    try {
        if (currentMode === 'existing' || currentMode === 'compare' || currentMode === 'race') {
            const sessionSource = encodeSource;
            const existingStartedAt = performance.now();

            if (sessionBackendBroken && (currentMode === 'existing' || currentMode === 'race')) {
                dbgLog('  session bypass → wrapper', 'session backend marked broken for this page', 'error');
                existingResult = await runWrapperPipeline(encodeSource, 'fallback');
                existingResult.fallback = 'wrapper';
            } else {
                dbgLog(`  session enc → ${sessionSource.width}×${sessionSource.height} · q=${getQuality()} effort=${getEffort()}`);
                try {
                    existingResult = await runExistingSessionPipeline(sessionSource, 1);
                } catch (error) {
                    const msg = error?.message || String(error);
                    dbgLog(`  session stall`, msg, 'error');
                    sessionBackendBroken = true;
                    dbgLog('  session fallback → wrapper', msg, 'error');
                    existingResult = await runWrapperPipeline(encodeSource, 'fallback');
                    existingResult.fallback = 'wrapper';
                }
            }
            existingResult.totalMs = performance.now() - existingStartedAt;
            existingResult.loadMs = source.loadMs ?? null;
            existingResult.firstPaintMs = null;
        }

        if (currentMode === 'wrapper' || currentMode === 'compare' || currentMode === 'race') {
            const wrapperStartedAt = performance.now();
            wrapperResult = await runWrapperPipeline(encodeSource, 'wrapper');
            wrapperResult.totalMs = performance.now() - wrapperStartedAt;
            wrapperResult.loadMs = source.loadMs ?? null;
            wrapperResult.firstPaintMs = null;
        }

        if (runId !== activeRunId) return;
        const renderTiming = paintTileResult(tile, source, existingResult, wrapperResult, startedAt);
        tile._timings = {
            existing: existingResult,
            wrapper: wrapperResult,
            render: renderTiming,
        };
        tile.el.dataset.state = 'done';
        dbgLog(`  ✓ done · first paint ${fmtMs(renderTiming?.firstPaintMs)} · total ${fmtMs(performance.now() - startedAt)}`, '', 'ok');
        return true;
    } catch (error) {
        if (runId !== activeRunId) return;
        const msg = error?.message || String(error);
        tile.el.dataset.state = 'error';
        tile.chip.textContent = 'Error ▸';
        tile.compare.textContent = msg;
        tile.errorText.textContent = error?.stack || msg;
        tile.errorDetail.classList.remove('is-open');
        dbgLog(`  ✗ error: ${msg}`, error?.stack || '', 'error');
        return false;
    }
}

async function runBatch() {
    const runId = ++activeRunId;
    const sources = buildBatchSources();
    if (!sources.length) {
        setStatus('Load files or random ORFs first.');
        return;
    }

    const jobs = sources.slice(0, getBatchLimit());
    const concurrency = getConcurrency();
    let done = 0;
    let errors = 0;
    const started = performance.now();
    lastProgressStatusAt = 0;

    resetGrid();
    setCounters({ loaded: selectedSources.length, queued: jobs.length, done: 0, errors: 0 });
    setStatus(`Running ${jobs.length} tiles in ${currentMode} mode...`);

    const queue = jobs.map((source, index) => ({ source, index }));
    const workers = Array.from({ length: concurrency }, async () => {
        while (queue.length && runId === activeRunId) {
            const next = queue.shift();
            if (!next) break;
            try {
                const ok = await processOneSource(next.source, next.index, runId);
                if (ok) done++;
                else errors++;
            } catch {
                errors++;
            }
            updateProgressStatus({ started, jobs, done, errors });
        }
    });

    await Promise.all(workers);
    if (runId !== activeRunId) return;
    updateProgressStatus({ started, jobs, done, errors, force: true });
    const finishedTiles = tiles.slice(0, jobs.length).map((tile) => tile._timings).filter(Boolean);
    const summary = formatRunSummary(finishedTiles);
    updateCompareStats(finishedTiles);
    setStatus(errors ? `Done with ${errors} error(s).` : 'Done.', `${fmtMs(performance.now() - started)} elapsed · ${summary}`);
    drawBatchGraphs(finishedTiles);
}

function drawBatchGraphs(tiles) {
    if (!window.Chart) return;
    const shell = document.getElementById('batch-graph-shell');
    if (shell) shell.hidden = false;

    const existingDecodes = [];
    const wrapperDecodes = [];
    const existingEncodes = [];
    const wrapperEncodes = [];

    tiles.forEach((t, i) => {
        if (t.existing && typeof t.existing.decodeMs === 'number') {
            existingDecodes.push({ x: i, y: t.existing.decodeMs });
        }
        if (t.existing && typeof t.existing.encodeMs === 'number') {
            existingEncodes.push({ x: i, y: t.existing.encodeMs });
        }
        if (t.wrapper && typeof t.wrapper.decodeMs === 'number') {
            wrapperDecodes.push({ x: i, y: t.wrapper.decodeMs });
        }
        if (t.wrapper && typeof t.wrapper.encodeMs === 'number') {
            wrapperEncodes.push({ x: i, y: t.wrapper.encodeMs });
        }
    });

    const distCanvas = document.getElementById('graph-batch-distribution');
    if (distCanvas) {
        if (chartInstances['dist']) chartInstances['dist'].destroy();
        chartInstances['dist'] = new Chart(distCanvas, {
            type: 'scatter',
            data: {
                datasets: [
                    { label: 'Session Decode', data: existingDecodes, backgroundColor: '#0f766e' },
                    { label: 'Wrapper Decode', data: wrapperDecodes, backgroundColor: '#ca8a04' }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom' } },
                scales: { 
                    x: { title: { display: true, text: 'Image Index' }, min: -1 },
                    y: { title: { display: true, text: 'Decode Time (ms)' }, beginAtZero: true } 
                }
            }
        });
    }

    const avgCanvas = document.getElementById('graph-batch-averages');
    if (avgCanvas) {
        const avg = (arr) => arr.length ? arr.reduce((sum, val) => sum + val.y, 0) / arr.length : 0;
        if (chartInstances['avg']) chartInstances['avg'].destroy();
        chartInstances['avg'] = new Chart(avgCanvas, {
            type: 'bar',
            data: {
                labels: ['Encode', 'Decode'],
                datasets: [
                    { label: 'Session Worker', data: [avg(existingEncodes), avg(existingDecodes)], backgroundColor: '#0f766e' },
                    { label: 'Direct Wrapper', data: [avg(wrapperEncodes), avg(wrapperDecodes)], backgroundColor: '#ca8a04' }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom' } },
                scales: { y: { title: { display: true, text: 'Average Time (ms)' }, beginAtZero: true } }
            }
        });
    }
}

function clearBatch() {
    activeRunId++;
    selectedSources = [];
    sessionBackendBroken = false;
    sourceInput.value = '';
    selectionStatus.textContent = 'No files loaded.';
    resetGrid();
    setCounters({ loaded: 0, queued: 0, done: 0, errors: 0 });
    setStatus('Idle.', 'Ready.');
    updateRunButtons();
}

function updateRunButtons() {
    const hasFiles = selectedSources.length > 0;
    runBatchBtn.disabled = !hasFiles;
    if (clearBatchBtn) clearBatchBtn.disabled = !hasFiles;
    if (startRaceBtn) startRaceBtn.disabled = !hasFiles;
}

function wireControls() {
    syncSettingLabels();
    for (const input of batchThumbSizeInputs) {
        input.addEventListener('change', syncBatchThumbSize);
    }
    syncBatchThumbSize();
    setMode(document.body.dataset.mode || 'race');
    setStatus('Idle.', 'Ready.');
    resetGrid();
    updateRunButtons();

    startRaceBtn?.addEventListener('click', () => {
        runRace().catch((error) => {
            setStatus(`Race failed: ${error?.message || error}`);
        });
    });

    for (const button of modeButtons) {
        button.addEventListener('click', () => {
            setMode(button.dataset.mode);
        });
    }

    sourceInput.addEventListener('change', async () => {
        if (!sourceInput.files?.length) return;
        await loadSourcesFromFiles(sourceInput.files);
        setCounters({ loaded: selectedSources.length });
    });

    sourceDrop.addEventListener('dragover', (event) => {
        event.preventDefault();
        sourceDrop.classList.add('is-drop-target');
    });

    sourceDrop.addEventListener('dragleave', () => {
        sourceDrop.classList.remove('is-drop-target');
    });

    sourceDrop.addEventListener('drop', async (event) => {
        event.preventDefault();
        sourceDrop.classList.remove('is-drop-target');
        if (!event.dataTransfer?.files?.length) return;
        await loadSourcesFromFiles(event.dataTransfer.files);
        setCounters({ loaded: selectedSources.length });
    });

    loadRandomBtn.addEventListener('click', async () => {
        await loadRandomSources(getBatchLimit());
        setCounters({ loaded: selectedSources.length });
    });

    runBatchBtn.addEventListener('click', () => {
        runBatch().catch((error) => {
            setStatus(`Failed: ${error?.message || error}`);
        });
    });

    clearBatchBtn.addEventListener('click', clearBatch);

    batchLimitInput.addEventListener('input', syncSettingLabels);
    batchConcurrencyInput.addEventListener('input', syncSettingLabels);
    batchQualityInput.addEventListener('input', syncSettingLabels);
    batchEffortInput?.addEventListener('input', syncSettingLabels);
    batchDecodeSpeedInput?.addEventListener('input', syncSettingLabels);
    batchPhotonNoiseIsoInput?.addEventListener('input', syncSettingLabels);
    for (const input of batchResamplingInputs) input.addEventListener('change', syncSettingLabels);
    for (const input of batchModularInputs) input.addEventListener('change', syncSettingLabels);
    batchBrotliEffortInput?.addEventListener('input', syncSettingLabels);

    // Phase 1: advanced filters (first-class controls)
    batchAdvancedFilters = {
        dots: document.getElementById('batch-adv-dots'),
        patches: document.getElementById('batch-adv-patches'),
        epf: document.getElementById('batch-adv-epf'),
        gaborish: document.getElementById('batch-adv-gaborish'),
    };
    for (const key of ['dots', 'patches', 'gaborish']) {
        batchAdvancedFilters[key]?.addEventListener('change', syncSettingLabels);
    }
    batchAdvancedFilters.epf?.addEventListener('change', syncSettingLabels);

    // Group order controls
    document.querySelectorAll('input[name="batch-group-order-mode"]').forEach(r => r.addEventListener('change', syncSettingLabels));
    document.getElementById('batch-group-center-x')?.addEventListener('input', syncSettingLabels);
    document.getElementById('batch-group-center-y')?.addEventListener('input', syncSettingLabels);

    // Gain map (HDR) transport benchmark wiring
    const gainFile = document.getElementById('batch-gainmap-file');
    const gainDemo = document.getElementById('batch-gainmap-use-demo');
    const gainStatus = document.getElementById('batch-gainmap-status');
    function updateGainStatus() {
        if (!gainStatus) return;
        const useDemo = gainDemo && gainDemo.checked;
        if (useDemo) {
            gainStatus.textContent = 'demo (' + DEMO_GAIN_MAP_BYTES.length + 'B placeholder)';
            currentGainMapBytes = null;
        } else if (currentGainMapBytes) {
            gainStatus.textContent = currentGainMapBytes.length + 'B loaded';
        } else {
            gainStatus.textContent = '';
        }
        syncSettingLabels();
    }
    gainDemo?.addEventListener('change', updateGainStatus);
    if (gainFile) {
        gainFile.addEventListener('change', async () => {
            const f = gainFile.files?.[0];
            if (!f) { currentGainMapBytes = null; updateGainStatus(); return; }
            const buf = await f.arrayBuffer();
            currentGainMapBytes = new Uint8Array(buf);
            if (gainDemo) gainDemo.checked = false;
            updateGainStatus();
        });
    }
}


await initRaw();
nativeJxlDecoder = (await getCapabilities()).nativeJxlDecoder;
{
    const wCaps = getWrapperCapabilities();
    if (!wCaps.extraChannelEncode && alphaDistanceUnavail) {
        alphaDistanceUnavail.hidden = false;
        if (batchAlphaDistanceInput) batchAlphaDistanceInput.disabled = true;
    }
}
if (dbgConsoleBtn) initDebugConsole(dbgConsoleBtn);
void resetContext().then((ctx) => {
    existingContext = ctx;
    sessionBackendBroken = false;
}).catch(() => {});
wireControls();
setCounters({ loaded: 0, queued: 0, done: 0, errors: 0 });
