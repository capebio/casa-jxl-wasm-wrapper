import initRaw, * as rawWasm from './pkg/raw_converter_wasm.js';
import { createDecoder, createEncoder } from '@casabio/jxl-wasm';
import { createBrowserContext } from '@casabio/jxl-session';
import { initDebugConsole, dbgLog } from './jxl-debug-console.js';
import { createSneyersPreset } from './jxl-progressive-best-preset.js';
import { computePsnrVsFinal } from './jxl-progressive-quality.js';
import { analyzeProgressiveFrame, formatFrameStatsCompact } from './jxl-progressive-frame-stats.js';

const { process_orf, rgb_to_rgba } = rawWasm;
const PROGRESSIVE_DETAIL = 'passes';
const FIRST_PAINT_CHUNK_RAMP = [1 * 1024, 2 * 1024, 4 * 1024, 8 * 1024, 16 * 1024];
const STEADY_DECODE_CHUNK_BYTES = 32 * 1024;
const BLOCK_BORDER_TILE_SIZE = 256;
const BLOCK_BORDER_SIZE = 2;
const BLOCK_BORDER_COLOR = '#ff2d2d';

const PERCEPTUAL_CUTOFF_PSNR_DELTA_DB = 0.5;
const PERCEPTUAL_CUTOFF_LOW_KBPS = 1.0;

// Size presets define output long-edge in pixels. "original" preserves source dims.
const SIZE_PRESETS = {
    'tiny':       { label: 'Tiny',       longEdge: 160 },
    'small':      { label: 'Small',      longEdge: 320 },
    'medium':     { label: 'Medium',     longEdge: 640 },
    'large':      { label: 'Large',      longEdge: 1080 },
    'display':    { label: 'Display',    longEdge: 1920 },
    'very-large': { label: 'Very Large', longEdge: 2160 },
    'original':   { label: 'Original',   longEdge: 'source' },
};

let _sessionCtx = null;
let _statsWorker = null;
let _statsWorkerDisabled = false;
let _statsId = 0;
const _statsPending = new Map();

function getSessionCtx() {
    if (_sessionCtx === null) _sessionCtx = createBrowserContext();
    return _sessionCtx;
}

function rejectPendingStats(error) {
    for (const pending of _statsPending.values()) {
        pending.reject(error);
    }
    _statsPending.clear();
}

function disableStatsWorker(error) {
    _statsWorkerDisabled = true;
    if (_statsWorker) {
        _statsWorker.terminate();
        _statsWorker = null;
    }
    rejectPendingStats(error);
}

function getStatsWorker() {
    if (_statsWorkerDisabled) {
        throw new Error('stats worker disabled');
    }
    if (_statsWorker === null) {
        _statsWorker = new Worker(new URL('./jxl-frame-stats-worker.js', import.meta.url), { type: 'module' });
        _statsWorker.onmessage = (event) => {
            const { id, ok, stats, pixels, error } = event.data ?? {};
            const pending = _statsPending.get(id);
            if (pending === undefined) return;
            _statsPending.delete(id);
            const returnedPixels = pixels ? new Uint8Array(pixels) : null;
            if (ok) pending.resolve({ stats, pixels: returnedPixels });
            else pending.reject(new Error(error ?? 'stats worker error'));
        };
        _statsWorker.onerror = (event) => {
            console.warn('[stats-worker] disabling after error', event);
            disableStatsWorker(new Error(event?.message ?? 'stats worker error'));
        };
    }
    return _statsWorker;
}

async function analyzeFrameInWorker(pixels, width, height) {
    const id = ++_statsId;
    const worker = getStatsWorker();
    const buffer = pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength);
    return new Promise((resolve, reject) => {
        _statsPending.set(id, { resolve, reject });
        worker.postMessage({ id, pixels: buffer, width, height }, [buffer]);
    });
}
const DEFAULT_SIZE_PRESET = 'display';

// Quality presets define libjxl distance (and quality number for display). kbPerMp is a
// rough heuristic for the "Estimate" readout — actual file size depends on content.
const QUALITY_PRESETS = {
    'very-low':  { label: 'Very Low',  quality: 75,  kbPerMp: 80 },
    'low':       { label: 'Low',       quality: 80,  kbPerMp: 110 },
    'medium':    { label: 'Medium',    quality: 85,  kbPerMp: 150 },
    'high':      { label: 'High',      quality: 90,  kbPerMp: 220 },
    'very-high': { label: 'Very High', quality: 95,  kbPerMp: 400 },
    'lossless':  { label: 'Lossless',  quality: 100, distance: 0, kbPerMp: 3000 },
};
const DEFAULT_QUALITY_PRESET = 'very-high';
const GROUP_ORDER_LABELS = {
    0: 'scanline',
    1: 'center-out',
};

const retrieveBtn = document.getElementById('retrieve-run');
const runBtn = document.getElementById('run-rerun');
const statusEl = document.getElementById('single-status');
const canvas = document.getElementById('progressive-canvas');
const viewerTitle = document.getElementById('viewer-title');
const viewerMeta = document.getElementById('viewer-meta');
const passStrip = document.getElementById('pass-strip');
const lightbox = document.getElementById('pass-lightbox');
const lightboxTitle = document.getElementById('pass-lightbox-title');
const lightboxSubtitle = document.getElementById('pass-lightbox-subtitle');
const lightboxCanvas = document.getElementById('pass-lightbox-canvas');
const lightboxCanvasWrap = document.querySelector('.lightbox-canvas-wrap');
const lightboxStats = document.getElementById('pass-lightbox-stats');
const lightboxClose = document.getElementById('pass-lightbox-close');
const lightboxZoomOut = document.getElementById('lightbox-zoom-out');
const lightboxZoomIn = document.getElementById('lightbox-zoom-in');
const lightboxZoomReset = document.getElementById('lightbox-zoom-reset');
const lightboxZoomLevel = document.getElementById('lightbox-zoom-level');
const consoleBtn = document.getElementById('dbg-console-btn');
const consoleMount = document.getElementById('dbg-console-mount');
const exportCsvBtn = document.getElementById('export-csv-btn');
const exportJsonBtn = document.getElementById('export-json-btn');
const exportToonBtn = document.getElementById('export-toon-btn');
const copyMeasurementsMdBtn = document.getElementById('copy-measurements-md');
const clearMeasurementsBtn = document.getElementById('clear-measurements-btn');
const showBlockBordersEl = document.getElementById('show-block-borders');

const runMeasurements = [];
let rawReady = false;
let running = false;
let currentPasses = [];
let lightboxIndex = -1;
let loadedSource = null;
const lightboxZoomState = { scale: 1, x: 0, y: 0 };
let lightboxPanStart = null;

initDebugConsole(consoleBtn, consoleMount);
console.log('%c[Single progressive] loaded', 'color:#7de0b0;font-weight:600', {
    page: 'Single progressive',
    url: location.href,
    t: new Date().toISOString(),
});

initRaw().then(() => {
    rawReady = true;
    setStatus('Ready. Settings first, then retrieve raw file.');
    dbgLog('RAW WASM initialized', '', 'success');
}).catch((error) => {
    setStatus(`RAW WASM failed: ${error?.message ?? error}`);
    dbgLog('RAW WASM failed', error?.message ?? String(error), 'error');
});

retrieveBtn?.addEventListener('click', () => {
    void retrieveAndRun();
});
runBtn?.addEventListener('click', () => {
    void rerunLoadedSource();
});
if (exportCsvBtn) exportCsvBtn.addEventListener('click', exportMeasurementsCSV);
if (exportJsonBtn) exportJsonBtn.addEventListener('click', exportMeasurementsJSON);
if (exportToonBtn) exportToonBtn.addEventListener('click', exportMeasurementsTOON);
if (copyMeasurementsMdBtn) copyMeasurementsMdBtn.addEventListener('click', copyMeasurementsMarkdown);
if (clearMeasurementsBtn) clearMeasurementsBtn.addEventListener('click', clearMeasurements);
showBlockBordersEl?.addEventListener('change', redrawCurrentPassView);
lightboxClose?.addEventListener('click', closePassLightbox);
lightboxZoomOut?.addEventListener('click', () => zoomLightboxAt(1 / 1.25));
lightboxZoomIn?.addEventListener('click', () => zoomLightboxAt(1.25));
lightboxZoomReset?.addEventListener('click', resetLightboxZoom);
lightboxCanvasWrap?.addEventListener('wheel', (event) => {
    if (!lightbox || lightbox.hidden) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.18 : 1 / 1.18;
    zoomLightboxAt(factor, event);
}, { passive: false });
lightboxCanvasWrap?.addEventListener('pointerdown', (event) => {
    if (!lightbox || lightbox.hidden || event.button !== 0) return;
    event.preventDefault();
    lightboxPanStart = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        stateX: lightboxZoomState.x,
        stateY: lightboxZoomState.y,
    };
    lightboxCanvasWrap.setPointerCapture?.(event.pointerId);
    lightboxCanvasWrap.classList.add('is-panning');
});
lightboxCanvasWrap?.addEventListener('pointermove', (event) => {
    if (!lightboxPanStart || event.pointerId !== lightboxPanStart.pointerId) return;
    panLightboxBy(
        lightboxPanStart.stateX + event.clientX - lightboxPanStart.x,
        lightboxPanStart.stateY + event.clientY - lightboxPanStart.y,
        true
    );
});
lightboxCanvasWrap?.addEventListener('pointerup', endLightboxPan);
lightboxCanvasWrap?.addEventListener('pointercancel', endLightboxPan);
lightboxCanvasWrap?.addEventListener('dblclick', resetLightboxZoom);
lightbox?.addEventListener('click', (event) => {
    if (event.target === lightbox) closePassLightbox();
});
window.addEventListener('keydown', (event) => {
    if (!lightbox || lightbox.hidden) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        closePassLightbox();
    } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        showPassInLightbox(lightboxIndex + 1);
    } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        showPassInLightbox(lightboxIndex - 1);
    } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomLightboxAt(1.25);
    } else if (event.key === '-') {
        event.preventDefault();
        zoomLightboxAt(1 / 1.25);
    } else if (event.key === '0') {
        event.preventDefault();
        resetLightboxZoom();
    }
});
window.addEventListener('beforeunload', () => {
    if (_statsWorker) _statsWorker.terminate();
});

const sizePresetEl = document.getElementById('size-preset');
const qualityPresetEl = document.getElementById('quality-preset');
const sizeEstimateEl = document.getElementById('size-estimate');
let lastLoadedSourceDims = null;

if (sizePresetEl) sizePresetEl.addEventListener('change', updateSizeEstimateDisplay);
if (qualityPresetEl) qualityPresetEl.addEventListener('change', updateSizeEstimateDisplay);
updateSizeEstimateDisplay();

function updateSizeEstimateDisplay() {
    if (!sizeEstimateEl) return;
    const settings = readSettings();
    // Until a RAW is loaded, show estimate per 1 MP at chosen long-edge.
    const sourceDims = lastLoadedSourceDims;
    const sourceLong = sourceDims ? Math.max(sourceDims.width, sourceDims.height) : null;
    const longEdge = settings.longEdgeRequest === 'source'
        ? (sourceLong ?? 'source')
        : Math.min(settings.longEdgeRequest, sourceLong ?? settings.longEdgeRequest);
    if (sourceDims) {
        const target = resolveTarget(sourceDims, settings.longEdgeRequest);
        const kb = estimateTargetKb(target.width, target.height, settings.qualityPreset);
        sizeEstimateEl.textContent = `${target.width}x${target.height} · ~${kb} KB`;
    } else {
        const fallbackLong = typeof longEdge === 'number' ? longEdge : 1080;
        const fallbackKb = estimateTargetKb(fallbackLong, Math.round(fallbackLong * 0.75), settings.qualityPreset);
        sizeEstimateEl.textContent = settings.lossless
            ? `~${fallbackKb} KB · lossless`
            : `~${fallbackKb} KB · q${settings.qualityNumber}`;
    }
}

async function retrieveAndRun() {
    if (running) return;
    if (!rawReady) {
        setStatus('RAW WASM not ready yet.');
        return;
    }

    running = true;
    retrieveBtn.disabled = true;
    clearRunView();
    const settings = readSettings();

    try {
        dbgLog('Run start', JSON.stringify(settings), 'info');
        setStatus('Retrieving random Gobabeb RAW...');
        const source = await loadRandomAndCacheSource();
        await runSourceWithSettings(source, settings);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(`Run failed: ${message}`);
        dbgLog('Run failed', message, 'error');
        console.error('[Single progressive] run failed', error);
    } finally {
        running = false;
        retrieveBtn.disabled = false;
        updateRunButtonState();
    }
}

async function rerunLoadedSource() {
    if (running || !loadedSource) return;
    if (!rawReady) {
        setStatus('RAW WASM not ready yet.');
        return;
    }
    running = true;
    retrieveBtn.disabled = true;
    updateRunButtonState();
    try {
        const settings = readSettings();
        dbgLog('Run start', JSON.stringify(settings), 'info');
        await runSourceWithSettings(loadedSource, settings);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(`Run failed: ${message}`);
        dbgLog('Run failed', message, 'error');
        console.error('[Single progressive] run failed', error);
    } finally {
        running = false;
        retrieveBtn.disabled = false;
        updateRunButtonState();
    }
}

async function loadRandomAndCacheSource() {
    const source = await loadRandomRaw();
    loadedSource = source;
    renderSourceShell(source);
    updateRunButtonState();
    return source;
}

async function runSourceWithSettings(source, settings) {
    renderSourceShell(source);
    setStatus(`Preparing ${source.file} at ${settings.sizePresetLabel} (${settings.longEdgeRequest === 'source' ? 'source dims' : `${settings.longEdgeRequest} px`})...`);
    dbgLog('Progressive ordering', `${settings.groupOrderLabel} (groupOrder=${settings.groupOrder}) · progressiveDc=${settings.progressiveDc}`, 'info');
    const target = resolveTarget(source, settings.longEdgeRequest);
    const targetRgba = resizeRgba(source.rgba, source.width, source.height, target.width, target.height);

    const estimateKb = estimateTargetKb(target.width, target.height, settings.qualityPreset);
    setStatus(`Encoding Sneyers at ${settings.qualityPresetLabel} (q=${settings.qualityNumber}${settings.lossless ? ', lossless' : ''})... estimate ${estimateKb} KB`);
    const encodeStart = performance.now();
    const useSidecar = document.getElementById('emit-sidecar-thumb')?.checked === true;
    let encodeBytes;
    let thumbBytes = null;
    if (useSidecar) {
        const result = await encodeWithSidecarThumbnail({
            rgba: targetRgba,
            width: target.width,
            height: target.height,
            quality: settings.qualityNumber,
            lossless: settings.lossless,
            progressiveDc: settings.progressiveDc,
            progressiveAc: settings.progressiveAc,
            qProgressiveAc: settings.qProgressiveAc,
            decodingSpeed: settings.decodingSpeed,
            groupOrder: settings.groupOrder,
        });
        encodeBytes = result.full;
        thumbBytes = result.thumb;
    } else {
        encodeBytes = await encodeSneyersDirect({
            rgba: targetRgba,
            width: target.width,
            height: target.height,
            quality: settings.qualityNumber,
            lossless: settings.lossless,
            progressiveDc: settings.progressiveDc,
            progressiveAc: settings.progressiveAc,
            qProgressiveAc: settings.qProgressiveAc,
            decodingSpeed: settings.decodingSpeed,
            groupOrder: settings.groupOrder,
        });
    }
    const encodeTotalMs = performance.now() - encodeStart;
    const selected = {
        quality: settings.qualityNumber,
        bytes: encodeBytes,
        encodeMs: encodeTotalMs,
        attempts: [{
            quality: settings.qualityNumber,
            byteLength: encodeBytes.byteLength,
            encodeMs: encodeTotalMs,
            errorPct: estimateKb ? ((encodeBytes.byteLength - estimateKb * 1024) / (estimateKb * 1024)) * 100 : 0,
        }],
    };
    dbgLog('Encoded', `q=${selected.quality} size=${formatBytes(encodeBytes.byteLength)} estimate=${estimateKb} KB`, 'success');

    const useWorker = document.getElementById('decode-in-worker')?.checked === true;
    setStatus(`${useWorker ? 'Worker d' : 'D'}ecoding ${formatBytes(encodeBytes.byteLength)} JXL with ${formatThrottle(settings.throttleKbPerSec)} throttle...`);
    const decodeArgs = {
        jxlBytes: encodeBytes,
        width: target.width,
        height: target.height,
        throttleKbPerSec: settings.throttleKbPerSec,
        targetRgba,  // for perceptual cutoff PSNR trigger (only after full AC per E)
    };
    const decode = await (useWorker
        ? decodeProgressivelyViaWorker(decodeArgs)
        : decodeProgressively(decodeArgs));
    setStatus('Running one-shot decode comparison...');
    const oneShotMs = await decodeOneShotFinal(encodeBytes);

    let thumbDecodeMs = null;
    let thumbSize = null;
    if (thumbBytes) {
        const t0 = performance.now();
        await decodeOneShotFinal(thumbBytes);
        thumbDecodeMs = Number((performance.now() - t0).toFixed(2));
        thumbSize = thumbBytes.byteLength;
    }

    const finalFrame = decode.passes.find(p => p.isFinal) ?? decode.passes.at(-1);
    const finalPsnr = finalFrame?.pixels?.byteLength === targetRgba.byteLength
        ? computePsnrVsFinal(targetRgba, finalFrame.pixels)
        : null;
    const metrics = buildMeasurement({
        source,
        target,
        targetKb: estimateKb,
        throttleKbPerSec: settings.throttleKbPerSec,
        selected,
        encodeTotalMs,
        decode,
        oneShotMs,
        finalPsnr,
        sizePreset: settings.sizePreset,
        qualityPreset: settings.qualityPreset,
        progressiveDc: settings.progressiveDc,
        progressiveAc: settings.progressiveAc,
        qProgressiveAc: settings.qProgressiveAc,
        decodingSpeed: settings.decodingSpeed,
        groupOrder: settings.groupOrder,
        groupOrderLabel: settings.groupOrderLabel,
    });
    if (thumbDecodeMs != null) {
        metrics.thumbDecodeMs = thumbDecodeMs;
        metrics.thumbBytes = thumbSize;
    }
    runMeasurements.push(metrics);
    renderMetrics(metrics);
    drawPsnrChart(decode.passes, targetRgba);
    updateExportButtons();
    const cutoffFired = !decode.passes.some(p => p.isFinal);
    const finalLine = cutoffFired
        ? `Stopped early at pass ${decode.passes.length} (perceptual cutoff) · avg ${formatTransferSpeed(metrics.avgTransferKbPerSec)}.`
        : `Done. ${metrics.passCount} passes, ${metrics.visibleProgressFrames} visible progress frames, final ${metrics.final_ms ?? '--'} ms · avg ${formatTransferSpeed(metrics.avgTransferKbPerSec)}.`;
    setStatus(finalLine);
    dbgLog('Run transfer average', `${formatTransferSpeed(metrics.avgTransferKbPerSec)} over ${formatBytes(selected.bytes.byteLength)} · final ${metrics.final_ms ?? '--'} ms${cutoffFired ? ' (cutoff)' : ''}`, 'info');
}

function readSettings() {
    const sizeKey = document.getElementById('size-preset')?.value ?? DEFAULT_SIZE_PRESET;
    const qualityKey = document.getElementById('quality-preset')?.value ?? DEFAULT_QUALITY_PRESET;
    const sizePreset = SIZE_PRESETS[sizeKey] ?? SIZE_PRESETS[DEFAULT_SIZE_PRESET];
    const qualityPreset = QUALITY_PRESETS[qualityKey] ?? QUALITY_PRESETS[DEFAULT_QUALITY_PRESET];
    const dcRaw = document.getElementById('progressive-dc')?.value ?? '0';
    const progressiveDc = Math.max(0, Math.min(2, Number(dcRaw) || 0));
    const groupOrderRaw = document.getElementById('group-order')?.value ?? '1';
    const groupOrder = Number(groupOrderRaw) === 0 ? 0 : 1;
    const acRaw = document.getElementById('progressive-ac')?.value ?? '1';
    const progressiveAc = Math.max(0, Math.min(2, Number(acRaw) || 0));
    const qacRaw = document.getElementById('qprogressive-ac')?.value ?? '1';
    const qProgressiveAc = Math.max(0, Math.min(2, Number(qacRaw) || 0));
    const dsRaw = document.getElementById('decoding-speed')?.value ?? '0';
    const decodingSpeed = Math.max(0, Math.min(4, Number(dsRaw) || 0));
    return {
        sizePreset: sizeKey,
        sizePresetLabel: sizePreset.label,
        longEdgeRequest: sizePreset.longEdge,
        qualityPreset: qualityKey,
        qualityPresetLabel: qualityPreset.label,
        qualityNumber: qualityPreset.quality,
        lossless: qualityPreset.distance === 0,
        throttleKbPerSec: Math.max(0, Number(document.getElementById('throttle-rate')?.value) || 0),
        progressiveDc,
        groupOrder,
        groupOrderLabel: GROUP_ORDER_LABELS[groupOrder],
        progressiveDetail: PROGRESSIVE_DETAIL,
        progressiveAc,
        qProgressiveAc,
        decodingSpeed,
    };
}

function estimateTargetKb(width, height, qualityKey) {
    const preset = QUALITY_PRESETS[qualityKey] ?? QUALITY_PRESETS[DEFAULT_QUALITY_PRESET];
    const megapixels = (width * height) / 1_000_000;
    return Math.max(1, Math.round(megapixels * preset.kbPerMp));
}

async function loadRandomRaw() {
    const response = await fetch('/api/random-gobabeb', { cache: 'no-store' });
    if (!response.ok) throw new Error(`/api/random-gobabeb returned ${response.status}`);
    const file = response.headers.get('X-File-Name') || response.headers.get('x-file-name') || 'random-gobabeb.orf';
    const rawBytes = new Uint8Array(await response.arrayBuffer());
    dbgLog('RAW loaded', `${file} | ${formatBytes(rawBytes.byteLength)}`, 'info');
    const result = process_orf(rawBytes, 0.3, 0.1, 0, 0, 0, 0, 0.15, 0.1, 0, 0, NaN, NaN, 0, 0);
    try {
        const rgba = rgb_to_rgba(result.take_rgb());
        dbgLog('RAW processed', `${result.width}x${result.height} rgba=${formatBytes(rgba.byteLength)}`, 'info');
        return {
            file,
            rawBytes: rawBytes.byteLength,
            rgba,
            width: result.width,
            height: result.height,
        };
    } finally {
        result.free();
    }
}

function resolveTarget(source, longEdgeRequest) {
    const sourceLong = Math.max(source.width, source.height);
    const requested = (longEdgeRequest === 'source' || longEdgeRequest === 'full')
        ? sourceLong
        : Math.max(1, Number(longEdgeRequest) || 1080);
    const longEdge = Math.min(sourceLong, requested);
    const scale = longEdge / sourceLong;
    return {
        width: Math.max(1, Math.round(source.width * scale)),
        height: Math.max(1, Math.round(source.height * scale)),
        longEdge,
    };
}

function resizeRgba(rgba, width, height, targetWidth, targetHeight) {
    if (width === targetWidth && height === targetHeight) return exactView(rgba);
    if (rawWasm.downscale_rgba) {
        return exactView(rawWasm.downscale_rgba(rgba, width, height, targetWidth, targetHeight));
    }
    const src = document.createElement('canvas');
    src.width = width;
    src.height = height;
    src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height), 0, 0);
    const dst = document.createElement('canvas');
    dst.width = targetWidth;
    dst.height = targetHeight;
    const ctx = dst.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, targetWidth, targetHeight);
    const data = ctx.getImageData(0, 0, targetWidth, targetHeight).data;
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

const SIDECAR_THUMB_LONG_EDGE = 320;
const SIDECAR_THUMB_QUALITY = 75; // kept for plan surface / future separate path; native sidecar uses internal caps (distance >=1.5, effort<=5)

async function encodeWithSidecarThumbnail({ rgba, width, height, quality, lossless, progressiveDc, progressiveAc, qProgressiveAc, decodingSpeed, groupOrder }) {
    const longEdge = Math.max(width, height);
    if (longEdge <= SIDECAR_THUMB_LONG_EDGE) {
        const full = await encodeSneyersDirect({
            rgba, width, height, quality, lossless,
            progressiveDc, progressiveAc, qProgressiveAc, decodingSpeed, groupOrder,
        });
        return { full, thumb: null };
    }
    const preset = createSneyersPreset({
        width,
        height,
        targetLongEdge: 'full',
        quality,
        hasAlpha: true,
        progressiveDetail: PROGRESSIVE_DETAIL,
    });
    const encoder = createEncoder({
        ...preset.encode,
        width,
        height,
        quality,
        ...(lossless ? { distance: 0 } : {}),
        ...(progressiveDc != null ? { progressiveDc } : {}),
        ...(progressiveAc != null ? { progressiveAc } : {}),
        ...(qProgressiveAc != null ? { qProgressiveAc } : {}),
        ...(decodingSpeed != null ? { decodingSpeed } : {}),
        ...(groupOrder != null ? { groupOrder } : {}),
        progressiveDetail: undefined,
        buffering: { strategy: 0 },
        chunked: false,
        sidecarSizes: [SIDECAR_THUMB_LONG_EDGE],
    });
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
    let thumb = null;
    let full;
    if (chunks.length >= 2) {
        // Native sidecar: leading chunks are standalone thumb JXLs (smallest first), last is full.
        thumb = chunks[0];
        full = chunks[chunks.length - 1];
    } else {
        full = chunks[0] || new Uint8Array(0);
    }
    return { full, thumb };
}
async function encodeSneyersDirect({ rgba, width, height, quality, lossless, progressiveDc, progressiveAc, qProgressiveAc, decodingSpeed, groupOrder }) {
    const preset = createSneyersPreset({
        width,
        height,
        targetLongEdge: 'full',
        quality,
        hasAlpha: true,
        progressiveDetail: PROGRESSIVE_DETAIL,
    });
    const encoder = createEncoder({
        ...preset.encode,
        width,
        height,
        quality,
        // distance=0 triggers libjxl lossless path (overrides quality-derived distance).
        ...(lossless ? { distance: 0 } : {}),
        // Override Sneyers preset's progressiveDc=2 with user choice. 1 = single 1:8 DC
        // (earlier first paint than 2). 0 = no DC progressive.
        ...(progressiveDc != null ? { progressiveDc } : {}),
        ...(progressiveAc != null ? { progressiveAc } : {}),
        ...(qProgressiveAc != null ? { qProgressiveAc } : {}),
        ...(decodingSpeed != null ? { decodingSpeed } : {}),
        ...(groupOrder != null ? { groupOrder } : {}),
        progressiveDetail: undefined,
        buffering: { strategy: 0 },
        chunked: false,
    });
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

async function decodeProgressively({ jxlBytes, width, height, throttleKbPerSec, targetRgba = null }) {
    const decoder = createDecoder({
        format: 'rgba8',
        region: null,
        downsample: 1,
        progressionTarget: 'final',
        emitEveryPass: true,
        progressiveDetail: PROGRESSIVE_DETAIL,
        preserveIcc: false,
        preserveMetadata: false,
    });
    const passes = [];
    const decStart = performance.now();
    const feedState = { bytesFed: 0, totalBytes: jxlBytes.byteLength, passCount: 0 };
    const eventTask = (async () => {
        for await (const event of decoder.events()) {
            if (event.type === 'header') {
                dbgLog('Decoder header', `${event.info.width}x${event.info.height}`, 'info');
            } else if (event.type === 'progress' || event.type === 'final') {
                const t = performance.now() - decStart;
                const bytesFed = Math.min(feedState.totalBytes, feedState.bytesFed);
                const percentFed = feedState.totalBytes ? (bytesFed / feedState.totalBytes) * 100 : 100;
                const transferKbPerSec = computeTransferKbPerSec(bytesFed, t);
                const previousPass = passes.at(-1);
                const deltaMs = previousPass ? t - previousPass.t_ms : t;
                const deltaBytes = Math.max(0, bytesFed - (previousPass?.bytesFed ?? 0));
                const deltaKbPerSec = computeTransferKbPerSec(deltaBytes, deltaMs);
                const pass = makePassRecord(event, passes.length, t, width, height);
                pass.bytesFed = bytesFed;
                pass.percentFed = Number(percentFed.toFixed(2));
                pass.transferKbPerSec = transferKbPerSec;
                pass.deltaMs = Number(deltaMs.toFixed(2));
                pass.deltaBytes = deltaBytes;
                pass.deltaKbPerSec = deltaKbPerSec;
                annotatePassTelemetry(pass, event);
                passes.push(pass);
                feedState.passCount = passes.length;
                currentPasses = passes;
                const paintStart = performance.now();
                renderProgressivePass(pass);
                pass.paintMs = Number((performance.now() - paintStart).toFixed(2));
                pass.decodeMs = Number(Math.max(0, deltaMs - pass.paintMs).toFixed(2));
                setStatus(`Decoding ${formatBytes(bytesFed)}/${formatBytes(feedState.totalBytes)} (${pass.percentFed}%) · paint ${pass.paintMs} ms · decode ${pass.decodeMs} ms · pass ${pass.pass} ${pass.ratioLabel ?? '--'}${pass.isFinal ? ' final' : ''}`);
                dbgLog(
                    `Pass ${pass.pass} ${pass.ratioLabel ?? '--'}${pass.isFinal ? ' final' : ''}`,
                    `${pass.t_ms} ms (+${pass.deltaMs} ms = ${pass.decodeMs} decode + ${pass.paintMs} paint) · ${formatBytes(bytesFed)}/${formatBytes(feedState.totalBytes)} (+${formatBytes(deltaBytes)}) · ${formatTransferSpeed(deltaKbPerSec)} delta`,
                    'info'
                );
                await sleep(0);

                // Perceptual cutoff check (opt-in). After non-final pass recorded.
                // Eager stats for hash trigger only when enabled (avoids paying analyze cost on diagnostic default-OFF runs; makes hash-equal viable despite post-F lazy precompute).
                const cutoffEnabled = document.getElementById('perceptual-cutoff')?.checked === true;
                if (cutoffEnabled && !pass.isFinal && passes.length >= 2) {
                    computeAndCachePassStats(passes.at(-1));
                    computeAndCachePassStats(passes.at(-2));
                }
                if (cutoffEnabled && !pass.isFinal) {
                    const verdict = shouldStopAtPass(passes, targetRgba);
                    if (verdict) {
                        setStatus(`Perceptual cutoff: ${verdict.reason} after pass ${pass.pass}. Cancelling.`);
                        dbgLog('Perceptual cutoff', JSON.stringify(verdict), 'info');
                        await decoder.cancel?.();
                        return; // end event consumption gracefully; feed will harmlessly no-op remaining pushes (facade guards), post-steps below still run for stats/metrics
                    }
                }
            } else if (event.type === 'error') {
                throw new Error(`${event.code}: ${event.message}`);
            }
        }
    })();

    try {
        await feedThrottled(decoder, jxlBytes, throttleKbPerSec, feedState);
        await eventTask;
    } finally {
        await decoder.dispose();
    }
    const finalMs = passes.find(pass => pass.isFinal)?.t_ms ?? passes.at(-1)?.t_ms ?? null;
    const avgTransferKbPerSec = computeTransferKbPerSec(jxlBytes.byteLength, finalMs);
    dbgLog('Decode transfer summary', `${formatBytes(jxlBytes.byteLength)} in ${finalMs ?? '--'} ms · avg ${formatTransferSpeed(avgTransferKbPerSec)} · requested ${formatThrottle(throttleKbPerSec)}`, 'info');
    await precomputePassStatsInWorker(passes);
    thinRetainedPassPixels(passes);
    return { passes, avgTransferKbPerSec };
}

async function decodeProgressivelyViaWorker({ jxlBytes, width, height, throttleKbPerSec, targetRgba = null }) {
    const ctx = getSessionCtx();
    const session = ctx.decode({
        format: 'rgba8',
        region: null,
        downsample: 1,
        progressionTarget: 'final',
        emitEveryPass: true,
        progressiveDetail: PROGRESSIVE_DETAIL,
        preserveIcc: false,
        preserveMetadata: false,
        priority: 'visible',
    });
    const passes = [];
    const decStart = performance.now();
    const feedState = { bytesFed: 0, totalBytes: jxlBytes.byteLength, passCount: 0 };
    let stoppedEarlyReason = null;

    const frameTask = (async () => {
        for await (const frame of session.frames()) {
            const t = performance.now() - decStart;
            const bytesFed = Math.min(feedState.totalBytes, feedState.bytesFed);
            const percentFed = feedState.totalBytes ? (bytesFed / feedState.totalBytes) * 100 : 100;
            const transferKbPerSec = computeTransferKbPerSec(bytesFed, t);
            const previousPass = passes.at(-1);
            const deltaMs = previousPass ? t - previousPass.t_ms : t;
            const deltaBytes = Math.max(0, bytesFed - (previousPass?.bytesFed ?? 0));
            const deltaKbPerSec = computeTransferKbPerSec(deltaBytes, deltaMs);
            const pseudoEvent = {
                type: frame.stage === 'final' || frame.isFinal ? 'final' : 'progress',
                info: frame.info,
                pixels: frame.pixels instanceof Uint8Array ? frame.pixels : new Uint8Array(frame.pixels),
            };
            const pass = makePassRecord(pseudoEvent, passes.length, t, width, height);
            pass.bytesFed = bytesFed;
            pass.percentFed = Number(percentFed.toFixed(2));
            pass.transferKbPerSec = transferKbPerSec;
                pass.deltaMs = Number(deltaMs.toFixed(2));
                pass.deltaBytes = deltaBytes;
                pass.deltaKbPerSec = deltaKbPerSec;
                annotatePassTelemetry(pass, frame);
                passes.push(pass);
            feedState.passCount = passes.length;
            currentPasses = passes;
            const paintStart = performance.now();
            renderProgressivePass(pass);
            pass.paintMs = Number((performance.now() - paintStart).toFixed(2));
            pass.decodeMs = Number(Math.max(0, deltaMs - pass.paintMs).toFixed(2));
            setStatus(`[worker] ${formatBytes(bytesFed)}/${formatBytes(feedState.totalBytes)} · paint ${pass.paintMs} ms · decode ${pass.decodeMs} ms · pass ${pass.pass} ${pass.ratioLabel ?? '--'}${pass.isFinal ? ' final' : ''}`);
            await sleep(0);

            // Perceptual cutoff check (opt-in). After non-final pass recorded.
            // Use session.cancel() (not close) for early abort semantics; close would be "end of source" and risks marking this pass isFinal.
            // Eager stats for hash (only under toggle; see main decode path comment).
            const cutoffEnabled = document.getElementById('perceptual-cutoff')?.checked === true;
            if (cutoffEnabled && !(frame.stage === 'final' || frame.isFinal) && passes.length >= 2) {
                computeAndCachePassStats(passes.at(-1));
                computeAndCachePassStats(passes.at(-2));
            }
            if (cutoffEnabled && !(frame.stage === 'final' || frame.isFinal)) {
                const verdict = shouldStopAtPass(passes, targetRgba);
                if (verdict) {
                    stoppedEarlyReason = verdict.reason;
                    setStatus(`Perceptual cutoff: ${verdict.reason} after pass ${pass.pass}. Cancelling.`);
                    dbgLog('Perceptual cutoff', JSON.stringify(verdict), 'info');
                    await session.cancel?.(verdict.reason);
                    return; // end frame consumption; feed+done awaits below will catch the resulting Cancelled as expected path
                }
            }
        }
    })();

    try {
        await feedThrottled(session, jxlBytes, throttleKbPerSec, feedState).catch((e) => {
            if (stoppedEarlyReason || /cancel|Cancel|closed/i.test(String(e && (e.message || e)))) {
                return; // expected: cutoff caused cancel mid-feed; subsequent pushes after cancel would throw, we swallow
            }
            throw e;
        });
        await frameTask.catch((e) => {
            if (stoppedEarlyReason || /cancel|Cancel|closed/i.test(String(e && (e.message || e)))) {
                return;
            }
            throw e;
        });
        if (!stoppedEarlyReason) {
            await session.done().catch((e) => {
                if (/cancel|Cancel|closed/i.test(String(e && (e.message || e)))) return;
                throw e;
            });
        }
    } finally {
        await session.close().catch(() => {});
    }
    const finalMs = passes.find(pass => pass.isFinal)?.t_ms ?? passes.at(-1)?.t_ms ?? null;
    const avgTransferKbPerSec = computeTransferKbPerSec(jxlBytes.byteLength, finalMs);
    dbgLog('Worker decode transfer summary', `${formatBytes(jxlBytes.byteLength)} in ${finalMs ?? '--'} ms · avg ${formatTransferSpeed(avgTransferKbPerSec)} · requested ${formatThrottle(throttleKbPerSec)}`, 'info');
    await precomputePassStatsInWorker(passes);
    thinRetainedPassPixels(passes);
    return { passes, avgTransferKbPerSec };
}

async function decodeOneShotFinal(jxlBytes) {
    const decoder = createDecoder({
        format: 'rgba8',
        region: null,
        downsample: 1,
        progressionTarget: 'final',
        emitEveryPass: false,
        progressiveDetail: PROGRESSIVE_DETAIL,
        preserveIcc: false,
        preserveMetadata: false,
    });
    const start = performance.now();
    let finalMs = null;
    const eventTask = (async () => {
        for await (const event of decoder.events()) {
            if (event.type === 'final') finalMs = performance.now() - start;
            else if (event.type === 'error') throw new Error(`${event.code}: ${event.message}`);
        }
    })();
    try {
        await decoder.push(exactBuffer(jxlBytes));
        await decoder.close();
        await eventTask;
    } finally {
        await decoder.dispose();
    }
    const ms = finalMs == null ? null : Number(finalMs.toFixed(2));
    dbgLog('One-shot decode', ms == null ? 'no final event' : `${ms} ms`, ms == null ? 'warn' : 'info');
    return ms;
}

function makePassRecord(event, index, t, width, height) {
    const pixels = event.pixels instanceof Uint8Array
        ? event.pixels
        : new Uint8Array(event.pixels);
    return {
        pass: index + 1,
        t_ms: Number(t.toFixed(2)),
        isFinal: event.type === 'final',
        width: event.info?.width ?? width,
        height: event.info?.height ?? height,
        pixels,
        stats: null,
    };
}

function computeAndCachePassStats(pass) {
    if (pass.stats) return pass.stats;
    if (!pass.pixels) {
        pass.stats = { alphaMin: 0, alphaMax: 0, alphaZeroPct: 0, rgbNonzeroCount: 0, lumaVariance: 0, frameHash: '--', pixelCount: 0, byteLength: 0 };
        return pass.stats;
    }
    pass.stats = analyzeProgressiveFrame(pass.pixels, pass.width, pass.height);
    return pass.stats;
}

function shouldStopAtPass(passes, targetRgba) {
    if (passes.length < 3) return false;
    const last = passes.at(-1);
    const prev = passes.at(-2);
    if (!last || !prev) return false;

    // Trigger 1: hash equality.
    if (last.stats && prev.stats && last.stats.frameHash === prev.stats.frameHash && last.stats.frameHash !== '--') {
        return { reason: 'hash-equal', last: last.pass };
    }

    // Trigger 2: low byte rate two passes running.
    if (Number.isFinite(last.deltaKbPerSec) && Number.isFinite(prev.deltaKbPerSec)
        && last.deltaKbPerSec < PERCEPTUAL_CUTOFF_LOW_KBPS
        && prev.deltaKbPerSec < PERCEPTUAL_CUTOFF_LOW_KBPS) {
        return { reason: 'low-byterate', last: last.pass };
    }

    // Trigger 3: PSNR plateau, but only once we've reached full-resolution AC.
    if ((last.intendedRatio ?? 8) <= 1 && (prev.intendedRatio ?? 8) <= 1 && targetRgba) {
        if (last.pixels?.byteLength === targetRgba.byteLength && prev.pixels?.byteLength === targetRgba.byteLength) {
            const psnrLast = computePsnrVsFinal(targetRgba, last.pixels);
            const psnrPrev = computePsnrVsFinal(targetRgba, prev.pixels);
            if (Number.isFinite(psnrLast) && Number.isFinite(psnrPrev)
                && Math.abs(psnrLast - psnrPrev) < PERCEPTUAL_CUTOFF_PSNR_DELTA_DB) {
                return { reason: 'psnr-plateau', last: last.pass, deltaDb: Math.abs(psnrLast - psnrPrev) };
            }
        }
    }

    return false;
}

async function precomputePassStatsInWorker(passes) {
    for (const pass of passes) {
        if (pass.stats || !pass.pixels) continue;
        try {
            const { stats, pixels } = await analyzeFrameInWorker(pass.pixels, pass.width, pass.height);
            if (!pass.stats) pass.stats = stats;
            if (pixels) pass.pixels = pixels;
        } catch (error) {
            console.warn('[stats] worker failed; falling back to main thread', error);
            pass.stats = computeAndCachePassStats(pass);
        }
    }
}

function labelIntendedRatio(ratio) {
    const value = Number(ratio);
    if (!Number.isFinite(value) || value <= 0) return '--';
    if (value >= 8) return '1:8 DC';
    if (value >= 4) return '1:4 coarse-AC';
    if (value >= 2) return '1:2 mid-AC';
    return 'full AC';
}

function annotatePassTelemetry(pass, event) {
    const ratio = event?.intendedDownsamplingRatio ?? event?.sourceScale ?? 1;
    pass.intendedRatio = ratio;
    pass.ratioLabel = labelIntendedRatio(ratio);
    pass.isLastFlag = event?.isLastFrame === true;
}

const RETAINED_PASS_BYTES_BUDGET = 64 * 1024 * 1024;

function thinRetainedPassPixels(passes) {
    if (passes.length <= 3) return;
    let totalBytes = 0;
    for (const p of passes) totalBytes += p.pixels?.byteLength ?? 0;
    if (totalBytes <= RETAINED_PASS_BYTES_BUDGET) return;

    const lastIdx = passes.length - 1;
    const intermediateCount = passes.length - 2;
    const keepEveryN = Math.max(1, Math.ceil(intermediateCount / 6));
    for (let i = 1; i < lastIdx; i++) {
        if ((i - 1) % keepEveryN !== 0) {
            // Materialize stats before releasing pixels so that buildMeasurement (visibleProgressFrames, uniqueFrameHashes)
            // and exports (CSV/JSON/TOON/MD) retain correct per-pass frameHash/stats for dropped intermediates.
            // This ensures "tuning sessions still get all passes via the CSV/JSON exports" as stated in the plan.
            computeAndCachePassStats(passes[i]);
            passes[i].pixels = null;
        }
    }
}

async function feedThrottled(decoder, jxlBytes, throttleKbPerSec, feedState) {
    let offset = 0;
    let preFirstPaintChunkIndex = 0;
    while (offset < jxlBytes.byteLength) {
        let chunkBytes;
        if ((feedState?.passCount ?? 0) > 0) {
            chunkBytes = STEADY_DECODE_CHUNK_BYTES;
        } else {
            const rampIdx = Math.min(preFirstPaintChunkIndex, FIRST_PAINT_CHUNK_RAMP.length - 1);
            chunkBytes = FIRST_PAINT_CHUNK_RAMP[rampIdx];
            preFirstPaintChunkIndex++;
        }
        const start = offset;
        const end = Math.min(jxlBytes.byteLength, offset + chunkBytes);
        await decoder.push(exactBuffer(jxlBytes.subarray(offset, end)));
        offset = end;
        if (feedState) feedState.bytesFed = offset;
        const delayMs = throttleKbPerSec > 0 ? ((end - start) / 1024) * (1000 / throttleKbPerSec) : 0;
        if (delayMs > 0 && offset < jxlBytes.byteLength) await sleep(delayMs);
        else if (offset < jxlBytes.byteLength) await sleep(0);
    }
    await decoder.close();
}

const TILE_LONG_EDGE_PX = 192; // 2x typical CSS render size for crisp HiDPI tiles

function renderProgressivePass(pass) {
    const previousPass = currentPasses[pass.pass - 2] ?? null;
    drawPassWithOverlay(canvas, pass, previousPass);
    viewerMeta.textContent = `pass ${pass.pass} (${pass.ratioLabel ?? '--'})${pass.isFinal ? ' final' : ''} | ${formatBytes(pass.bytesFed ?? 0)} streamed | +${pass.deltaMs ?? '--'} ms`;
    const tile = document.createElement('button');
    tile.className = 'pass-tile';
    tile.type = 'button';
    const tileCanvas = document.createElement('canvas');
    const tileScale = Math.min(1, TILE_LONG_EDGE_PX / Math.max(pass.width, pass.height));
    tileCanvas.width = Math.max(1, Math.round(pass.width * tileScale));
    tileCanvas.height = Math.max(1, Math.round(pass.height * tileScale));
    const tileCtx = tileCanvas.getContext('2d');
    tileCtx.imageSmoothingEnabled = true;
    tileCtx.imageSmoothingQuality = 'medium';
    tileCtx.drawImage(canvas, 0, 0, tileCanvas.width, tileCanvas.height);
    const label = document.createElement('span');
    label.textContent = `Pass ${pass.pass} ${pass.ratioLabel ?? ''}${pass.isFinal ? ' final' : ''} | ${formatBytes(pass.bytesFed ?? 0)} | +${pass.deltaMs ?? '--'} ms`;
    tile.append(tileCanvas, label);
    tile.addEventListener('click', () => {
        showPassInLightbox(pass.pass - 1);
    });
    passStrip.append(tile);
}

function showPassInLightbox(index) {
    if (!currentPasses.length || !lightbox || !lightboxCanvas || !lightboxStats) return;
    lightboxIndex = ((index % currentPasses.length) + currentPasses.length) % currentPasses.length;
    const pass = currentPasses[lightboxIndex];
    const previousPass = currentPasses[lightboxIndex - 1] ?? null;
    if (!pass.pixels) {
        lightboxStats.innerHTML = '<div><span>Status</span><strong>pixels released to free memory</strong></div>';
        return;
    }
    drawPassWithOverlay(lightboxCanvas, pass, previousPass);
    applyLightboxZoom();
    drawPassWithOverlay(canvas, pass, previousPass);
    viewerMeta.textContent = `pinned pass ${pass.pass} (${pass.ratioLabel ?? '--'}) | ${formatBytes(pass.bytesFed ?? 0)} streamed | ${formatFrameStatsCompact(computeAndCachePassStats(pass))}`;
    if (lightboxTitle) lightboxTitle.textContent = `Pass ${pass.pass}${pass.isFinal ? ' final' : ''}`;
    if (lightboxSubtitle) {
        lightboxSubtitle.textContent = `${lightboxIndex + 1}/${currentPasses.length} | ArrowLeft/ArrowRight to compare passes`;
    }
    lightboxStats.innerHTML = '';
    for (const [label, value] of passLightboxStats(pass)) {
        const row = document.createElement('div');
        const name = document.createElement('span');
        const metric = document.createElement('strong');
        name.textContent = label;
        metric.textContent = value;
        row.append(name, metric);
        lightboxStats.append(row);
    }
    lightbox.hidden = false;
    applyLightboxZoom();
}

function closePassLightbox() {
    if (lightbox) lightbox.hidden = true;
    lightboxIndex = -1;
}

function zoomLightboxAt(factor, event = null) {
    if (!lightboxCanvas) return;
    const oldScale = lightboxZoomState.scale;
    const nextScale = clamp(oldScale * factor, 1, 16);
    if (nextScale === oldScale) return;

    if (event && lightboxCanvasWrap) {
        const rect = lightboxCanvasWrap.getBoundingClientRect();
        const anchorX = event.clientX - rect.left;
        const anchorY = event.clientY - rect.top;
        lightboxZoomState.x = anchorX - ((anchorX - lightboxZoomState.x) * nextScale / oldScale);
        lightboxZoomState.y = anchorY - ((anchorY - lightboxZoomState.y) * nextScale / oldScale);
    }
    lightboxZoomState.scale = nextScale;
    clampLightboxPan();
    applyLightboxZoom();
}

function panLightboxBy(x, y, absolute = false) {
    if (absolute) {
        lightboxZoomState.x = x;
        lightboxZoomState.y = y;
    } else {
        lightboxZoomState.x += x;
        lightboxZoomState.y += y;
    }
    clampLightboxPan();
    applyLightboxZoom();
}

function resetLightboxZoom() {
    lightboxZoomState.scale = 1;
    lightboxZoomState.x = 0;
    lightboxZoomState.y = 0;
    applyLightboxZoom();
}

function endLightboxPan(event) {
    if (!lightboxPanStart || event.pointerId !== lightboxPanStart.pointerId) return;
    lightboxCanvasWrap?.releasePointerCapture?.(event.pointerId);
    lightboxCanvasWrap?.classList.remove('is-panning');
    lightboxPanStart = null;
}

function applyLightboxZoom() {
    if (!lightboxCanvas) return;
    clampLightboxPan();
    lightboxCanvas.style.transform = `translate(${lightboxZoomState.x}px, ${lightboxZoomState.y}px) scale(${lightboxZoomState.scale})`;
    if (lightboxZoomLevel) {
        const label = `${Math.round(lightboxZoomState.scale * 100)}%`;
        lightboxZoomLevel.value = label;
        lightboxZoomLevel.textContent = label;
    }
}

function clampLightboxPan() {
    if (!lightboxCanvasWrap || !lightboxCanvas) return;
    if (lightboxZoomState.scale <= 1) {
        lightboxZoomState.x = 0;
        lightboxZoomState.y = 0;
        return;
    }
    const wrapRect = lightboxCanvasWrap.getBoundingClientRect();
    const canvasRect = lightboxCanvas.getBoundingClientRect();
    const baseWidth = canvasRect.width / lightboxZoomState.scale;
    const baseHeight = canvasRect.height / lightboxZoomState.scale;
    const maxX = Math.max(0, (baseWidth * lightboxZoomState.scale - wrapRect.width) / 2);
    const maxY = Math.max(0, (baseHeight * lightboxZoomState.scale - wrapRect.height) / 2);
    lightboxZoomState.x = clamp(lightboxZoomState.x, -maxX, maxX);
    lightboxZoomState.y = clamp(lightboxZoomState.y, -maxY, maxY);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function redrawCurrentPassView() {
    if (!currentPasses.length) return;
    if (lightbox && !lightbox.hidden && lightboxIndex >= 0) {
        showPassInLightbox(lightboxIndex);
        return;
    }
    const pass = currentPasses.at(-1);
    const previousPass = currentPasses.at(-2) ?? null;
    drawPassWithOverlay(canvas, pass, previousPass);
}

function passLightboxStats(pass) {
    const s = computeAndCachePassStats(pass);
    return [
        ['Pass', `${pass.pass}${pass.isFinal ? ' final' : ''}`],
        ['Stage', `${pass.ratioLabel ?? '--'} | ratio ${pass.intendedRatio ?? '--'}`],
        ['Streamed', `${formatBytes(pass.bytesFed ?? 0)} (${pass.percentFed ?? 0}%)`],
        ['Time', `${pass.t_ms} ms`],
        ['Delta', `${pass.deltaMs ?? '--'} ms, ${formatBytes(pass.deltaBytes ?? 0)}`],
        ['Delta transfer', formatTransferSpeed(pass.deltaKbPerSec)],
        ['Dimensions', `${pass.width}x${pass.height}`],
        ['Hash', s.frameHash],
        ['Alpha', `${s.alphaMin}-${s.alphaMax}, zero ${s.alphaZeroPct.toFixed(2)}%`],
        ['RGB nonzero', String(s.rgbNonzeroCount)],
        ['Luma variance', s.lumaVariance.toFixed(2)],
    ];
}

function drawPixels(targetCanvas, pixels, width, height) {
    if (targetCanvas.width !== width) targetCanvas.width = width;
    if (targetCanvas.height !== height) targetCanvas.height = height;
    const ctx = targetCanvas.getContext('2d');
    const data = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    ctx.putImageData(new ImageData(data, width, height), 0, 0);
}

function drawPassWithOverlay(targetCanvas, pass, previousPass) {
    drawPixels(targetCanvas, pass.pixels, pass.width, pass.height);
    if (!shouldShowBlockBorders()) return;
    const blocks = computeChangedBlocks(pass, previousPass);
    drawBlockBorders(targetCanvas, blocks);
}

function shouldShowBlockBorders() {
    return showBlockBordersEl ? showBlockBordersEl.checked : true;
}

function computeChangedBlocks(pass, previousPass) {
    if (!pass?.pixels?.length) return [];
    if (!previousPass?.pixels?.length || previousPass.width !== pass.width || previousPass.height !== pass.height) {
        return [{ x: 0, y: 0, width: pass.width, height: pass.height }];
    }

    const tileSize = BLOCK_BORDER_TILE_SIZE;
    const cols = Math.ceil(pass.width / tileSize);
    const rows = Math.ceil(pass.height / tileSize);
    const changed = new Uint8Array(cols * rows);
    const current = pass.pixels;
    const previous = previousPass.pixels;
    const length = Math.min(current.length, previous.length);
    for (let i = 0; i < length; i += 4) {
        if (
            current[i] !== previous[i]
            || current[i + 1] !== previous[i + 1]
            || current[i + 2] !== previous[i + 2]
            || current[i + 3] !== previous[i + 3]
        ) {
            const pixel = i >> 2;
            const x = pixel % pass.width;
            const y = Math.floor(pixel / pass.width);
            const col = Math.floor(x / tileSize);
            const row = Math.floor(y / tileSize);
            changed[row * cols + col] = 1;
        }
    }

    const blocks = [];
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            if (!changed[row * cols + col]) continue;
            const x = col * tileSize;
            const y = row * tileSize;
            blocks.push({
                x,
                y,
                width: Math.min(tileSize, pass.width - x),
                height: Math.min(tileSize, pass.height - y),
            });
        }
    }
    return blocks;
}

function drawBlockBorders(targetCanvas, blocks) {
    if (!blocks.length) return;
    const ctx = targetCanvas.getContext('2d');
    ctx.save();
    ctx.strokeStyle = BLOCK_BORDER_COLOR;
    ctx.lineWidth = BLOCK_BORDER_SIZE;
    ctx.setLineDash([]);
    const inset = BLOCK_BORDER_SIZE / 2;
    for (const block of blocks) {
        ctx.strokeRect(
            block.x + inset,
            block.y + inset,
            Math.max(0, block.width - BLOCK_BORDER_SIZE),
            Math.max(0, block.height - BLOCK_BORDER_SIZE)
        );
    }
    ctx.restore();
}

function buildMeasurement({ source, target, targetKb, throttleKbPerSec, selected, encodeTotalMs, decode, oneShotMs, finalPsnr, sizePreset, qualityPreset, progressiveDc, progressiveAc, qProgressiveAc, decodingSpeed, groupOrder, groupOrderLabel }) {
    const perPass = decode.passes.map(pass => {
        const stats = computeAndCachePassStats(pass);
        return {
            pass: pass.pass,
            t_ms: pass.t_ms,
            isFinal: pass.isFinal,
            bytesFed: pass.bytesFed ?? null,
            percentFed: pass.percentFed ?? null,
            transferKbPerSec: pass.transferKbPerSec ?? null,
            delta_ms: pass.deltaMs ?? null,
            delta_bytes: pass.deltaBytes ?? null,
            delta_kb_per_sec: pass.deltaKbPerSec ?? null,
            deltaKbPerSec: pass.deltaKbPerSec ?? null,
            paint_ms: pass.paintMs ?? null,
            decode_ms: pass.decodeMs ?? null,
            intended_ratio: pass.intendedRatio ?? null,
            ratio_label: pass.ratioLabel ?? null,
            stats: normalizeFrameStatsForExport(stats),
        };
    });
    const visibleProgressFrames = perPass
        .filter(p => !p.isFinal && isVisibleFrame(p.stats))
        .map(p => p.stats.frameHash)
        .filter((hash, index, list) => list.indexOf(hash) === index)
        .length;
    const uniqueFrameHashes = new Set(perPass.map(p => p.stats.frameHash)).size;
    const first = perPass[0] ?? null;
    const final = perPass.find(p => p.isFinal) ?? perPass.at(-1) ?? null;
    const actualKb = selected.bytes.byteLength / 1024;
    return {
        ts: new Date().toISOString(),
        source: source.file,
        sourceWidth: source.width,
        sourceHeight: source.height,
        rawBytes: source.rawBytes,
        targetWidth: target.width,
        targetHeight: target.height,
        sizePreset: sizePreset ?? null,
        qualityPreset: qualityPreset ?? null,
        estimateKb: targetKb,
        actualKb: Number(actualKb.toFixed(1)),
        sizeErrorPct: targetKb ? Number((((actualKb - targetKb) / targetKb) * 100).toFixed(2)) : null,
        quality: selected.quality,
        encode_ms: Number(selected.encodeMs.toFixed(2)),
        encode_total_ms: Number(encodeTotalMs.toFixed(2)),
        encodeAttempts: selected.attempts.map(a => ({
            quality: a.quality,
            kb: Number((a.byteLength / 1024).toFixed(1)),
            encode_ms: Number(a.encodeMs.toFixed(2)),
            errorPct: Number(a.errorPct.toFixed(2)),
        })),
        throttleKbPerSec,
        progressiveDc,
        progressive_dc: progressiveDc,
        progressiveAc,
        qProgressiveAc,
        decodingSpeed,
        progressive_ac: progressiveAc,
        qprogressive_ac: qProgressiveAc,
        decoding_speed: decodingSpeed,
        groupOrder,
        group_order: groupOrder,
        groupOrderLabel: groupOrderLabel ?? GROUP_ORDER_LABELS[groupOrder] ?? null,
        group_order_label: groupOrderLabel ?? GROUP_ORDER_LABELS[groupOrder] ?? null,
        progressiveDetail: PROGRESSIVE_DETAIL,
        passCount: perPass.length,
        visibleProgressFrames,
        uniqueFrameHashes,
        first_ms: first?.t_ms ?? null,
        final_ms: final?.t_ms ?? null,
        oneShot_ms: oneShotMs,
        speedup: oneShotMs && first?.t_ms ? Number((oneShotMs / first.t_ms).toFixed(2)) : null,
        avgTransferKbPerSec: decode.avgTransferKbPerSec == null ? null : Number(decode.avgTransferKbPerSec.toFixed(2)),
        final_psnr_vs_source: Number.isFinite(finalPsnr) ? Number(finalPsnr.toFixed(2)) : finalPsnr,
        perPass,
    };
}

function isVisibleFrame(stats) {
    return stats
        && stats.rgbNonzeroCount > 0
        && stats.alphaZeroPct < 95
        && stats.lumaVariance > 1;
}

function normalizeFrameStatsForExport(stats) {
    if (!stats) return { alphaMin: 0, alphaMax: 0, alphaZeroPct: 0, rgbNonzeroCount: 0, lumaVariance: 0, frameHash: '--', pixelCount: 0, byteLength: 0 };
    return {
        alphaMin: stats.alphaMin,
        alphaMax: stats.alphaMax,
        alphaZeroPct: Number(stats.alphaZeroPct.toFixed(2)),
        rgbNonzeroCount: stats.rgbNonzeroCount,
        lumaVariance: Number(stats.lumaVariance.toFixed(2)),
        frameHash: stats.frameHash,
        pixelCount: stats.pixelCount,
        byteLength: stats.byteLength,
    };
}

function renderSourceShell(source) {
    viewerTitle.textContent = source.file;
    viewerMeta.textContent = `${source.width}x${source.height} RAW processed. Waiting for progressive decode.`;
    lastLoadedSourceDims = { width: source.width, height: source.height };
    updateSizeEstimateDisplay();
    updateRunButtonState();
}

function renderMetrics(m) {
    setMetric('m-source', `${m.sourceWidth}x${m.sourceHeight}`);
    setMetric('m-dims', `${m.targetWidth}x${m.targetHeight}`);
    const qualityLabel = m.qualityPreset === 'lossless' ? 'lossless' : `q${m.quality}`;
    setMetric('m-quality', m.qualityPreset ? `${qualityLabel} (${m.qualityPreset})` : qualityLabel);
    setMetric('m-size', `${m.actualKb} KB`);
    setMetric('m-size-error', m.sizeErrorPct == null ? '--' : `est ${m.estimateKb} KB / actual diff ${m.sizeErrorPct}%`);
    setMetric('m-encode', `${m.encode_total_ms} ms`);
    setMetric('m-first', m.first_ms == null ? '--' : `${m.first_ms} ms`);
    setMetric('m-final', m.final_ms == null ? '--' : `${m.final_ms} ms`);
    setMetric('m-oneshot', m.oneShot_ms == null ? '--' : `${m.oneShot_ms} ms`);
    setMetric('m-speedup', m.speedup == null ? '--' : `${m.speedup}x`);
    setMetric('m-passes', `${m.passCount} (${m.uniqueFrameHashes} unique)`);
    setMetric('m-visible', `${m.visibleProgressFrames}`);
    setMetric('m-psnr', m.final_psnr_vs_source === Infinity ? 'Infinity' : `${m.final_psnr_vs_source ?? '--'} dB`);
    setMetric('m-throttle', formatThrottle(m.throttleKbPerSec));
    setMetric('m-transfer', formatTransferSpeed(m.avgTransferKbPerSec));
    setMetric('m-group-order', `${m.groupOrderLabel ?? '--'}${m.groupOrder == null ? '' : ` (${m.groupOrder})`}`);
    setMetric('m-progressive-dc', m.progressiveDc == null ? '--' : String(m.progressiveDc));
    setMetric('m-thumb-decode', m.thumbDecodeMs == null ? '--' : `${m.thumbDecodeMs} ms`);
    setMetric('m-thumb-size', m.thumbBytes == null ? '--' : formatBytes(m.thumbBytes));
    const attemptsEl = document.getElementById('encode-attempts');
    if (attemptsEl) {
        attemptsEl.textContent = `Encode attempts: ${m.encodeAttempts.map(a => `q${a.quality}=${a.kb}KB (${a.errorPct}%)`).join(' | ')}`;
    }
}

function drawPsnrChart(passes, targetRgba) {
    const chartCanvas = document.getElementById('psnr-chart');
    const legend = document.getElementById('psnr-chart-legend');
    if (!chartCanvas) return;

    const ctx = chartCanvas.getContext('2d');
    const w = chartCanvas.width;
    const h = chartCanvas.height;
    ctx.fillStyle = '#0a0f11';
    ctx.fillRect(0, 0, w, h);

    if (!passes?.length) {
        if (legend) legend.textContent = '--';
        return;
    }

    const finalPass = passes.find(p => p.isFinal) ?? passes.at(-1);
    const reference = targetRgba ?? finalPass?.pixels ?? null;
    if (!reference) {
        if (legend) legend.textContent = 'final pixels released';
        return;
    }

    const psnrs = passes.map(pass => {
        if (!pass.pixels || pass.pixels.byteLength !== reference.byteLength) return null;
        return computePsnrVsFinal(reference, pass.pixels);
    });
    const finite = psnrs.filter(value => Number.isFinite(value));
    if (!finite.length) {
        if (legend) legend.textContent = 'no comparable passes';
        return;
    }

    const padL = 30;
    const padR = 8;
    const padT = 8;
    const padB = 18;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const minY = Math.max(10, Math.min(...finite) - 2);
    const maxY = Math.min(80, Math.max(...finite) + 2);
    const rangeY = Math.max(0.01, maxY - minY);

    ctx.strokeStyle = '#2c4249';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();

    ctx.fillStyle = '#9fb6b0';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${maxY.toFixed(0)}`, padL - 4, padT + 8);
    ctx.fillText(`${minY.toFixed(0)}`, padL - 4, padT + plotH);
    ctx.textAlign = 'left';
    ctx.fillText('dB', 2, padT + 8);

    ctx.strokeStyle = '#7de0b0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let drewFirst = false;
    psnrs.forEach((psnr, index) => {
        if (!Number.isFinite(psnr)) return;
        const x = padL + (index / Math.max(1, passes.length - 1)) * plotW;
        const y = padT + plotH - ((psnr - minY) / rangeY) * plotH;
        if (drewFirst) ctx.lineTo(x, y);
        else {
            ctx.moveTo(x, y);
            drewFirst = true;
        }
    });
    ctx.stroke();

    psnrs.forEach((psnr, index) => {
        if (!Number.isFinite(psnr)) return;
        const x = padL + (index / Math.max(1, passes.length - 1)) * plotW;
        const y = padT + plotH - ((psnr - minY) / rangeY) * plotH;
        ctx.fillStyle = passes[index].isFinal ? '#f0c86a' : '#7de0b0';
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
    });

    const lastFinite = finite.at(-1);
    if (legend) legend.textContent = `${finite.length} of ${passes.length} passes plotted · ${lastFinite.toFixed(1)} dB final`;
}

function setMetric(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function clearRunView() {
    passStrip.innerHTML = '';
    currentPasses = [];
    closePassLightbox();
    viewerTitle.textContent = 'Progressive image';
    viewerMeta.textContent = 'Loading...';
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawPsnrChart([], null);
}

function exportMeasurementsCSV() {
    if (!runMeasurements.length) return;
    const headers = [
        'ts', 'source', 'source_width', 'source_height', 'target_width', 'target_height',
        'size_preset', 'quality_preset', 'progressive_dc', 'progressive_ac', 'qprogressive_ac', 'decoding_speed', 'group_order', 'group_order_label', 'estimate_kb', 'actual_kb', 'size_error_pct',
        'quality', 'encode_ms', 'encode_total_ms',
        'throttle_kb_per_sec', 'avg_transfer_kb_per_sec', 'passes', 'visible_progress_frames', 'unique_frame_hashes',
        'first_ms', 'final_ms', 'oneShot_ms', 'speedup_x', 'final_psnr_vs_source', 'pass_bytes', 'pass_delta_ms', 'pass_delta_bytes', 'pass_delta_kb_per_sec', 'pass_paint_ms', 'pass_decode_ms', 'pass_intended_ratio', 'pass_ratio_label', 'pass_stats'
    ];
    const rows = runMeasurements.map(m => [
        m.ts,
        m.source,
        m.sourceWidth,
        m.sourceHeight,
        m.targetWidth,
        m.targetHeight,
        m.sizePreset,
        m.qualityPreset,
        m.progressiveDc ?? '',
        m.progressiveAc ?? '',
        m.qProgressiveAc ?? '',
        m.decodingSpeed ?? '',
        m.groupOrder ?? '',
        m.groupOrderLabel ?? '',
        m.estimateKb,
        m.actualKb,
        m.sizeErrorPct,
        m.quality,
        m.encode_ms,
        m.encode_total_ms,
        m.throttleKbPerSec,
        m.avgTransferKbPerSec ?? '',
        m.passCount,
        m.visibleProgressFrames,
        m.uniqueFrameHashes,
        m.first_ms ?? '',
        m.final_ms ?? '',
        m.oneShot_ms ?? '',
        m.speedup ?? '',
        m.final_psnr_vs_source ?? '',
        (m.perPass || []).map(p => `${p.pass}:${p.bytesFed ?? ''}:${p.percentFed ?? ''}%`).join(';'),
        (m.perPass || []).map(p => `${p.pass}:${p.delta_ms ?? ''}`).join(';'),
        (m.perPass || []).map(p => `${p.pass}:${p.delta_bytes ?? ''}`).join(';'),
        (m.perPass || []).map(p => `${p.pass}:${p.delta_kb_per_sec ?? ''}`).join(';'),
        (m.perPass || []).map(p => `${p.pass}:${p.paint_ms ?? ''}`).join(';'),
        (m.perPass || []).map(p => `${p.pass}:${p.decode_ms ?? ''}`).join(';'),
        (m.perPass || []).map(p => `${p.pass}:${p.intended_ratio ?? ''}`).join(';'),
        (m.perPass || []).map(p => `${p.pass}:${p.ratio_label ?? ''}`).join(';'),
        (m.perPass || []).map(p => `${p.pass}:${formatFrameStatsCompact(p.stats)}`).join(';')
    ].map(csvCell).join(','));
    downloadText(`single-progressive-${timestamp()}.csv`, [headers.join(','), ...rows].join('\n'), 'text/csv');
    dbgLog('Exported CSV', `${runMeasurements.length} measurement(s)`, 'success');
}

function exportMeasurementsJSON() {
    if (!runMeasurements.length) return;
    downloadText(`single-progressive-${timestamp()}.json`, JSON.stringify(runMeasurements, null, 2), 'application/json');
    dbgLog('Exported JSON', `${runMeasurements.length} measurement(s)`, 'success');
}

function exportMeasurementsTOON() {
    if (!runMeasurements.length) return;
    let out = `measurements[${runMeasurements.length}]:\n`;
    for (const m of runMeasurements) {
        out += `- ts: ${m.ts}\n`;
        out += `  source: ${quoteIfNeeded(m.source)}\n`;
        out += `  target: ${m.targetWidth}x${m.targetHeight}\n`;
        if (m.sizePreset) out += `  sizePreset: ${m.sizePreset}\n`;
        if (m.qualityPreset) out += `  qualityPreset: ${m.qualityPreset}\n`;
        if (m.progressiveDc != null) out += `  progressive_dc: ${m.progressiveDc}\n`;
        if (m.progressiveAc != null) out += `  progressive_ac: ${m.progressiveAc}\n`;
        if (m.qProgressiveAc != null) out += `  qprogressive_ac: ${m.qProgressiveAc}\n`;
        if (m.decodingSpeed != null) out += `  decoding_speed: ${m.decodingSpeed}\n`;
        if (m.groupOrder != null) out += `  group_order: ${m.groupOrder}\n`;
        if (m.groupOrderLabel) out += `  group_order_label: ${m.groupOrderLabel}\n`;
        out += `  estimateKb: ${m.estimateKb}\n`;
        out += `  actualKb: ${m.actualKb}\n`;
        if (m.sizeErrorPct != null) out += `  sizeErrorPct: ${m.sizeErrorPct}\n`;
        out += `  quality: ${m.quality}\n`;
        out += `  encodeTotalMs: ${m.encode_total_ms}\n`;
        out += `  throttleKbPerSec: ${m.throttleKbPerSec}\n`;
        if (m.avgTransferKbPerSec != null) out += `  avgTransferKbPerSec: ${m.avgTransferKbPerSec}\n`;
        out += `  passCount: ${m.passCount}\n`;
        out += `  visibleProgressFrames: ${m.visibleProgressFrames}\n`;
        out += `  uniqueFrameHashes: ${m.uniqueFrameHashes}\n`;
        if (m.first_ms != null) out += `  first_ms: ${m.first_ms}\n`;
        if (m.final_ms != null) out += `  final_ms: ${m.final_ms}\n`;
        if (m.oneShot_ms != null) out += `  oneShot_ms: ${m.oneShot_ms}\n`;
        if (m.speedup != null) out += `  speedup: ${m.speedup}\n`;
        if (m.final_psnr_vs_source != null) out += `  final_psnr_vs_source: ${m.final_psnr_vs_source}\n`;
        out += `  perPass[${m.perPass.length}]{pass,t_ms,isFinal,bytesFed,percentFed,transferKbPerSec,delta_ms,delta_bytes,delta_kb_per_sec,paint_ms,decode_ms,intended_ratio,ratio_label,alphaMin,alphaMax,alphaZeroPct,rgbNonzeroCount,lumaVariance,frameHash}:\n`;
        for (const p of m.perPass) {
            out += [
                `    ${p.pass}`,
                p.t_ms,
                p.isFinal ? 'true' : 'false',
                p.bytesFed ?? '',
                p.percentFed ?? '',
                p.transferKbPerSec ?? '',
                p.delta_ms ?? '',
                p.delta_bytes ?? '',
                p.delta_kb_per_sec ?? '',
                p.paint_ms ?? '',
                p.decode_ms ?? '',
                p.intended_ratio ?? '',
                quoteIfNeeded(p.ratio_label ?? ''),
                p.stats.alphaMin,
                p.stats.alphaMax,
                p.stats.alphaZeroPct,
                p.stats.rgbNonzeroCount,
                p.stats.lumaVariance,
                p.stats.frameHash
            ].join(',') + '\n';
        }
    }
    out += `meta:\n  exportedAt: ${new Date().toISOString()}\n  generator: single-progressive\n`;
    downloadText(`single-progressive-${timestamp()}.toon`, out, 'text/toon');
    dbgLog('Exported TOON', `${runMeasurements.length} measurement(s)`, 'success');
}

async function copyMeasurementsMarkdown() {
    if (!runMeasurements.length) return;
    const text = buildMeasurementsMarkdown();
    try {
        await navigator.clipboard.writeText(text);
        dbgLog('Copied measurements Markdown', `${runMeasurements.length} measurement(s)`, 'success');
    } catch (error) {
        downloadText(`single-progressive-${timestamp()}.md`, text, 'text/markdown');
        dbgLog('Clipboard blocked; downloaded Markdown', error?.message ?? String(error), 'warn');
    }
}

function buildMeasurementsMarkdown() {
    let out = '# Single progressive measurements\n\n';
    out += '| Source | Target | Size preset | Quality preset | Progressive DC | Progressive AC | qProgressive AC | Decoding speed | Group order | Estimate KB | Actual KB | Quality | Passes | Visible progress | Avg transfer | First ms | Final ms | One-shot ms | Speedup | PSNR |\n';
    out += '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
    for (const m of runMeasurements) {
        out += [
            mdCell(m.source),
            `${m.targetWidth}x${m.targetHeight}`,
            m.sizePreset ?? '',
            m.qualityPreset ?? '',
            m.progressiveDc ?? '',
            m.progressiveAc ?? '',
            m.qProgressiveAc ?? '',
            m.decodingSpeed ?? '',
            m.groupOrderLabel ?? m.groupOrder ?? '',
            m.estimateKb,
            m.actualKb,
            m.quality,
            m.passCount,
            m.visibleProgressFrames,
            m.avgTransferKbPerSec ?? '',
            m.first_ms ?? '',
            m.final_ms ?? '',
            m.oneShot_ms ?? '',
            m.speedup ?? '',
            m.final_psnr_vs_source ?? '',
        ].join(' | ') + '\n';
    }
    for (const m of runMeasurements) {
        out += `\n## ${mdCell(m.source)}\n\n`;
        out += '| Pass | Stage | Ratio | KB streamed | Streamed % | Transfer KB/s | Delta ms | Delta KB | Delta KB/s | Paint ms | Decode ms | t ms | Final | alphaMin | alphaMax | alphaZeroPct | rgbNonzeroCount | lumaVariance | frameHash |\n';
        out += '|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---|\n';
        for (const p of m.perPass) {
            out += [
                p.pass,
                mdCell(p.ratio_label ?? ''),
                p.intended_ratio ?? '',
                p.bytesFed == null ? '' : Number((p.bytesFed / 1024).toFixed(1)),
                p.percentFed ?? '',
                p.transferKbPerSec ?? '',
                p.delta_ms ?? '',
                p.delta_bytes == null ? '' : Number((p.delta_bytes / 1024).toFixed(1)),
                p.delta_kb_per_sec ?? '',
                p.paint_ms ?? '',
                p.decode_ms ?? '',
                p.t_ms,
                p.isFinal ? 'true' : 'false',
                p.stats.alphaMin,
                p.stats.alphaMax,
                p.stats.alphaZeroPct,
                p.stats.rgbNonzeroCount,
                p.stats.lumaVariance,
                mdCell(p.stats.frameHash),
            ].join(' | ') + '\n';
        }
    }
    return out;
}

function clearMeasurements() {
    runMeasurements.length = 0;
    updateExportButtons();
    dbgLog('Measurements cleared', '', 'warn');
}

function updateExportButtons() {
    const enabled = runMeasurements.length > 0;
    for (const btn of [exportCsvBtn, exportJsonBtn, exportToonBtn, copyMeasurementsMdBtn, clearMeasurementsBtn]) {
        if (btn) btn.disabled = !enabled;
    }
}

function updateRunButtonState() {
    if (runBtn) runBtn.disabled = !loadedSource || running;
}

function exactBuffer(view) {
    if (view instanceof ArrayBuffer) return view;
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function exactView(view) {
    return view instanceof Uint8Array ? new Uint8Array(view) : new Uint8Array(view);
}

function concatChunks(chunks) {
    const views = chunks.map(chunk => chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    const total = views.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of views) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function csvCell(value) {
    const text = String(value ?? '');
    if (text.includes(',') || text.includes('"') || text.includes('\n')) return `"${text.replace(/"/g, '""')}"`;
    return text;
}

function quoteIfNeeded(str) {
    const text = String(str ?? '');
    return /[\s,:[\]{}"\\]/.test(text) ? `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : text;
}

function mdCell(value) {
    return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
}

function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatThrottle(kbPerSec) {
    return kbPerSec > 0 ? `${kbPerSec} KB/s` : 'unthrottled';
}

function computeTransferKbPerSec(bytes, elapsedMs) {
    if (!Number.isFinite(bytes) || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
    return Number(((bytes / 1024) / (elapsedMs / 1000)).toFixed(2));
}

function formatTransferSpeed(kbPerSec) {
    if (!Number.isFinite(kbPerSec) || kbPerSec == null) return '-- KB/s';
    if (kbPerSec >= 1024) return `${(kbPerSec / 1024).toFixed(2)} MB/s`;
    return `${kbPerSec.toFixed(1)} KB/s`;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function nextPaint() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}
