import initRaw, * as rawWasm from './pkg/raw_converter_wasm.js';
import { createDecoder, createEncoder, detectTier } from '@casabio/jxl-wasm';
import { createBrowserContext } from '@casabio/jxl-session';
import { getCapabilities } from '@casabio/jxl-capabilities';
import { initDebugConsole, dbgLog } from './jxl-debug-console.js';
import { createSneyersPreset } from './jxl-progressive-best-preset.js';
import { computePsnrVsFinal, computeSsimVsFinal, detectMonotone } from './jxl-progressive-quality.js';
import { computeButteraugliVsFinal, createButteraugliComparer } from './jxl-butteraugli.js';
import { buildSeries } from './jxl-progressive-byte-metrics.js';  // connectedness for unified series in cutoff (R1)
import { analyzeProgressiveFrame, formatFrameStatsCompact } from './jxl-progressive-frame-stats.js';

const { process_orf, rgb_to_rgba } = rawWasm;
const DEFAULT_PROGRESSIVE_DETAIL = 'lastPasses';
const SNEYERS_PROGRESSIVE_DETAIL = 'passes';
const PROGRESSIVE_DETAILS = new Set(['dc', 'lastPasses', 'passes']);

// Match jxl-decode-worker.js: emit flushed progressive frames for lastPasses/passes;
// DC-only mode suppresses intermediate AC passes (preview + final only).
function emitEveryPassForDetail(progressiveDetail) {
    return progressiveDetail !== 'dc';
}

const SETTING_IMPACT_CLASS = {
    mild: 'setting-impact-mild',
    slow: 'setting-impact-slow',
    severe: 'setting-impact-severe',
};

const SETTING_IMPACT_RANK = { mild: 1, slow: 2, severe: 3 };

const SETTING_IMPACT_BASE_HINTS = {
    'size-preset': 'Output long edge. Original / very large multiply decode + paint cost.',
    'quality-preset': 'Encode quality. Lossless is much slower and larger.',
    'throttle-rate': 'Simulated network throughput. Lower = longer wall time.',
    'progressive-dc': 'DC layers in encode. 0 skips early coarse previews — fewer visible passes before full AC (default 2).',
    'progressive-ac': 'AC band split. Higher values add encode/decode passes.',
    'qprogressive-ac': 'AC quantization tiers. Higher values add refinement passes.',
    'progressive-detail': 'Decode granularity. All passes chunk-feeds every flush — lab mode only at large sizes.',
    'decoding-speed': 'Decoder effort in the bitstream. 0 = slowest decode.',
    'group-order': 'Coefficient group order in encode (center-out vs scanline).',
    'decode-in-worker': 'Worker decode frees the main thread for paint. Off blocks UI during decode.',
    'show-block-borders': 'Tile diff overlay per pass. Costly above ~4 MP — turn off for timing sweeps.',
    'perceptual-cutoff': 'Stop decode early when passes plateau (opt-in).',
    'charts-enabled': 'PSNR / SSIM / Butteraugli charts in a stats worker (diagnostic).',
    'suppress-dup-progress': 'Experimental hash dedup — can hide intermediate flushes.',
    'emit-sidecar-thumb': 'Extra 320px sidecar encode + decode measurement.',
};

const SETTING_IMPACT_WATCH_IDS = [
    'size-preset',
    'quality-preset',
    'throttle-rate',
    'progressive-dc',
    'progressive-ac',
    'qprogressive-ac',
    'progressive-detail',
    'decoding-speed',
    'group-order',
    'decode-in-worker',
    'show-block-borders',
    'perceptual-cutoff',
    'charts-enabled',
    'suppress-dup-progress',
    'emit-sidecar-thumb',
];

function resolveSettingImpact(id, snapshot) {
    switch (id) {
        case 'size-preset':
            if (snapshot.sizePreset === 'original') return { level: 'slow', note: 'Source resolution — heaviest decode and paint.' };
            if (snapshot.sizePreset === 'very-large') return { level: 'mild', note: '2160 px long edge — moderately heavy.' };
            return null;
        case 'quality-preset':
            if (snapshot.lossless) return { level: 'slow', note: 'Lossless encode/decode is much slower.' };
            if (snapshot.qualityPreset === 'high') return { level: 'mild', note: 'Higher quality — slightly slower encode.' };
            return null;
        case 'throttle-rate':
            if (snapshot.throttleKbPerSec > 0 && snapshot.throttleKbPerSec <= 100) {
                return { level: 'slow', note: 'Very slow simulated download.' };
            }
            if (snapshot.throttleKbPerSec > 0 && snapshot.throttleKbPerSec <= 500) {
                return { level: 'mild', note: 'Throttled byte feed stretches wall time.' };
            }
            return null;
        case 'progressive-dc':
            if (snapshot.progressiveDc === 0) {
                return { level: 'slow', note: 'No DC progressive — fewer early preview passes.' };
            }
            return null;
        case 'progressive-ac':
            if (snapshot.progressiveAc === 2) return { level: 'mild', note: 'Multi-band AC — more refinement passes.' };
            return null;
        case 'qprogressive-ac':
            if (snapshot.qProgressiveAc === 2) return { level: 'mild', note: 'Multi-tier AC quantization — more passes.' };
            return null;
        case 'progressive-detail':
            if (snapshot.progressiveDetail === 'passes') {
                return { level: 'severe', note: 'Diagnostic chunk-feed — many passes; very slow at large sizes.' };
            }
            if (snapshot.progressiveDetail === 'dc') return { level: 'mild', note: 'DC preview + final only.' };
            return null;
        case 'decoding-speed':
            if (snapshot.decodingSpeed === 0) return { level: 'mild', note: 'Slowest decoder effort in bitstream.' };
            if (snapshot.decodingSpeed === 4) return { level: 'mild', note: 'Fastest decode — lower decoder quality.' };
            return null;
        case 'group-order':
            return null;
        case 'decode-in-worker':
            if (!snapshot.decodeInWorker) return { level: 'slow', note: 'Main-thread decode competes with paint.' };
            return null;
        case 'show-block-borders':
            if (snapshot.showBlockBorders && (snapshot.sizePreset === 'original' || snapshot.sizePreset === 'very-large')) {
                return { level: 'slow', note: 'Block borders on a large frame — expensive tile diff each pass.' };
            }
            if (snapshot.showBlockBorders) return { level: 'mild', note: 'Per-pass tile diff overlay.' };
            return null;
        case 'perceptual-cutoff':
            return null;
        case 'charts-enabled':
            if (snapshot.chartsEnabled) return { level: 'mild', note: 'Extra stats-worker work after decode.' };
            return null;
        case 'suppress-dup-progress':
            if (snapshot.suppressDuplicateProgress) {
                return { level: 'severe', note: 'May suppress visible intermediate flushes.' };
            }
            return null;
        case 'emit-sidecar-thumb':
            if (snapshot.emitSidecarThumb) return { level: 'mild', note: 'Extra sidecar encode + one-shot decode.' };
            return null;
        default:
            return null;
    }
}

function labelForSettingControl(id) {
    const el = document.getElementById(id);
    return el?.closest('label') ?? null;
}

function applySettingImpactClass(label, level) {
    if (!label) return;
    label.classList.remove(SETTING_IMPACT_CLASS.mild, SETTING_IMPACT_CLASS.slow, SETTING_IMPACT_CLASS.severe);
    if (level) label.classList.add(SETTING_IMPACT_CLASS[level]);
}

function composeSettingTitle(id, impact) {
    const base = SETTING_IMPACT_BASE_HINTS[id] ?? '';
    if (!impact?.note) return base || null;
    return base ? `${base} ${impact.note}` : impact.note;
}

function readSettingImpactSnapshot() {
    const settings = readSettings();
    return {
        ...settings,
        decodeInWorker: document.getElementById('decode-in-worker')?.checked === true,
        showBlockBorders: document.getElementById('show-block-borders')?.checked === true,
        chartsEnabled: document.getElementById('charts-enabled')?.checked === true,
        suppressDuplicateProgress: document.getElementById('suppress-dup-progress')?.checked === true,
        emitSidecarThumb: document.getElementById('emit-sidecar-thumb')?.checked === true,
    };
}

function refreshSettingImpactHints() {
    const snapshot = readSettingImpactSnapshot();
    for (const id of SETTING_IMPACT_WATCH_IDS) {
        const label = labelForSettingControl(id);
        const impact = resolveSettingImpact(id, snapshot);
        applySettingImpactClass(label, impact?.level ?? null);
        const title = composeSettingTitle(id, impact);
        if (label && title) label.title = title;
    }
}

function initSettingImpactHints() {
    refreshSettingImpactHints();
    for (const id of SETTING_IMPACT_WATCH_IDS) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.addEventListener('change', refreshSettingImpactHints);
    }
}

const FIRST_PAINT_CHUNK_RAMP = [1 * 1024, 2 * 1024, 4 * 1024, 8 * 1024, 16 * 1024];
const STEADY_DECODE_CHUNK_BYTES = 32 * 1024;
const BLOCK_BORDER_TILE_SIZE = 256;
const BBOX_STRIDE = 10;
const BLOCK_BORDER_SIZE = 2;
const BLOCK_BORDER_COLOR = '#ff2d2d';
const BLOCK_BORDERS_STRICT = new URLSearchParams(location.search).get('bordersStrict') === '1';
const WORKER_DECODE_TIMEOUT_MS = 90_000;
const DEFAULT_WORKER_PUSH_HWM = 64;
const DEFAULT_WORKER_POOL_SIZE = 1;
const DEFAULT_WORKER_TIER = 'auto';
const WORKER_TIERS = new Set(['auto', 'relaxed-simd-mt', 'simd-mt', 'simd', 'scalar']);

const PERCEPTUAL_CUTOFF_PSNR_DELTA_DB = 0.5;
const PERCEPTUAL_CUTOFF_LOW_KBPS = 1.0;
const CHART_MAX_PIXELS = 1_000_000;    // cap quality-metric computation at ~1 MP; keeps Butteraugli sub-second/pass even at Display/Original res
const PASS_BORDER_RES_MAX = 4_000_000; // skip block-border overlay above this pixel count (meaningless at hi-res)

function downsamplePixelsForChart(pixels, width, height) {
    const n = width * height;
    if (n <= CHART_MAX_PIXELS) return { pixels, width, height };
    const scale = Math.sqrt(CHART_MAX_PIXELS / n);
    const dw = Math.max(1, Math.round(width * scale));
    const dh = Math.max(1, Math.round(height * scale));
    const src = document.createElement('canvas');
    src.width = width;
    src.height = height;
    src.getContext('2d').putImageData(
        new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height),
        0, 0
    );
    const dst = document.createElement('canvas');
    dst.width = dw;
    dst.height = dh;
    const dstCtx = dst.getContext('2d');
    dstCtx.imageSmoothingEnabled = true;
    dstCtx.imageSmoothingQuality = 'high';
    dstCtx.drawImage(src, 0, 0, dw, dh);
    const out = dstCtx.getImageData(0, 0, dw, dh).data;
    return { pixels: new Uint8Array(out.buffer, out.byteOffset, out.byteLength), width: dw, height: dh };
}

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
let _statsId = 0;
const _statsPending = new Map();

function getSessionCtx() {
    if (_sessionCtx === null) {
        const workerConfig = readWorkerExperimentConfig();
        const contextOptions = {
            pushHwm: workerConfig.pushHwm,
            wasmUrl: workerConfig.workerUrl,
            ...(workerConfig.poolSize === null ? {} : { poolSize: workerConfig.poolSize }),
        };
        _sessionCtx = createBrowserContext(contextOptions);
        dbgLog('Worker decode config', JSON.stringify({
            poolSize: workerConfig.poolSize ?? 'default',
            pushHwm: workerConfig.pushHwm,
            workerTier: workerConfig.workerTier,
        }), 'info');
    }
    return _sessionCtx;
}

function readWorkerExperimentConfig() {
    const params = new URLSearchParams(location.search);
    const pushHwm = readBoundedIntParam(params, 'workerPushHwm', DEFAULT_WORKER_PUSH_HWM, 1, 256);
    const poolRaw = params.get('workerPool');
    const poolSize = poolRaw === 'default'
        ? null
        : readBoundedIntParam(params, 'workerPool', DEFAULT_WORKER_POOL_SIZE, 1, 4);
    const tierRaw = params.get('workerTier');
    const workerTier = WORKER_TIERS.has(tierRaw) ? tierRaw : DEFAULT_WORKER_TIER;
    const workerUrl = new URL('../packages/jxl-worker-browser/dist/worker.js', import.meta.url);
    workerUrl.searchParams.set('jxlWorkerTier', workerTier);
    return { pushHwm, poolSize, workerTier, workerUrl: workerUrl.href };
}

function readBoundedIntParam(params, name, fallback, min, max) {
    const raw = params.get(name);
    if (raw === null || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(value)));
}

function readBoolParam(name, fallback) {
    const raw = new URLSearchParams(location.search).get(name);
    if (raw === null || raw === '') return fallback;
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    return fallback;
}

function rejectPendingStats(error) {
    for (const pending of _statsPending.values()) {
        pending.reject(error);
    }
    _statsPending.clear();
}

// Tear down the current worker and reject in-flight requests, but do NOT permanently
// disable. The next getStatsWorker() spins up a fresh worker, so one transient failure
// can't poison the rest of the session — neither charts nor the frame-stats (cutoff) path,
// which share this worker.
function resetStatsWorker(error) {
    if (_statsWorker) {
        _statsWorker.terminate();
        _statsWorker = null;
    }
    rejectPendingStats(error);
}

function getStatsWorker() {
    if (_statsWorker === null) {
        _statsWorker = new Worker(new URL('./jxl-frame-stats-worker.js', import.meta.url), { type: 'module' });
        _statsWorker.onmessage = (event) => {
            const { id, ok, type, stats, pixels, values, error } = event.data ?? {};
            const pending = _statsPending.get(id);
            if (pending === undefined) return;
            _statsPending.delete(id);
            if (ok) {
                if (type === 'chart') pending.resolve({ values });
                else {
                    const returnedPixels = pixels ? new Uint8Array(pixels) : null;
                    pending.resolve({ stats, pixels: returnedPixels });
                }
            } else {
                pending.reject(new Error(error ?? 'stats worker error'));
            }
        };
        _statsWorker.onerror = (event) => {
            console.warn('[stats-worker] resetting after error', event);
            resetStatsWorker(new Error(event?.message ?? 'stats worker error'));
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

async function computeChartsInWorker(passes, reference, pw, ph) {
    const { pixels: refDs, width: dsW, height: dsH } = downsamplePixelsForChart(reference, pw, ph);
    const needsDs = dsW !== pw;
    const refBuf = refDs.buffer.slice(refDs.byteOffset, refDs.byteOffset + refDs.byteLength);
    const passEntries = passes.map((pass, i) => {
        if (!pass.pixels || pass.pixels.byteLength !== reference.byteLength) return null;
        const px = needsDs ? downsamplePixelsForChart(pass.pixels, pw, ph).pixels : pass.pixels;
        return { index: i, buf: px.buffer.slice(px.byteOffset, px.byteOffset + px.byteLength) };
    });
    const id = ++_statsId;
    const worker = getStatsWorker();
    const transfers = [refBuf, ...passEntries.filter(Boolean).map(e => e.buf)];
    return new Promise((resolve, reject) => {
        _statsPending.set(id, { resolve, reject });
        worker.postMessage({ type: 'chart', id, ref: refBuf, refWidth: dsW, refHeight: dsH, passes: passEntries }, transfers);
    });
}

async function computeAndDrawChartsAsync(passes, targetRgba) {
    if (!passes?.length) return;
    const pw = passes[0]?.width ?? 1;
    const ph = passes[0]?.height ?? 1;
    const finalPass = passes.find(p => p.isFinal) ?? passes.at(-1);
    const reference = targetRgba ?? finalPass?.pixels ?? null;
    if (!reference) return;
    try {
        const { values } = await computeChartsInWorker(passes, reference, pw, ph);
        const psnrVals = values.map(v => v?.psnr ?? null);
        const ssimVals = values.map(v => v?.ssim ?? null);
        const buttVals = values.map(v => v?.butt ?? null);
        drawQualityChart('psnr-chart', 'psnr-chart-legend', passes, psnrVals, {
            yPad: 2, yClampMin: 10, yClampMax: 80,
            yLabel: 'dB', yFormat: v => v.toFixed(1),
        });
        drawQualityChart('ssim-chart', 'ssim-chart-legend', passes, ssimVals, {
            yPad: 0.002, yClampMin: 0, yClampMax: 1,
            yLabel: 'SSIM', yFormat: v => v.toFixed(3),
            lineColor: '#f0c86a', finalColor: '#7de0b0',
        });
        drawQualityChart('butt-chart', 'butt-chart-legend', passes, buttVals, {
            yPad: 0.05, yClampMin: 0,
            yLabel: 'Butt', yFormat: v => v.toFixed(3),
            lineColor: '#ff8c7d', finalColor: '#7de0b0',
        });
    } catch (error) {
        // No main-thread SSIM/Butteraugli fallback — that synchronous batch is the UI freeze.
        // Draw empty charts instead. The per-pass frame-stats path keeps its own fallback
        // (one pass at a time, needed for the perceptual cutoff).
        console.warn('[charts] worker failed; charts skipped (no main-thread fallback)', error);
        drawEmptyCharts('charts unavailable');
    }
}

// Charts (PSNR/SSIM/Butteraugli) are a diagnostic surface gated behind the Graphs toggle.
// Off (default): the per-pass perceptual pathway is skipped entirely — no worker round-trip,
// no metric compute. The last run's passes + reference are stashed so toggling on recomputes
// without a re-decode. Frame-stats (hash/luma for cutoff) are separate and always run.
function chartsEnabled() {
    return chartsEnabledEl?.checked === true;
}

function drawEmptyCharts(legendText) {
    drawQualityChart('psnr-chart', 'psnr-chart-legend', [], [], { yLabel: 'dB', yFormat: v => v.toFixed(1) });
    drawQualityChart('ssim-chart', 'ssim-chart-legend', [], [], { yLabel: 'SSIM', yFormat: v => v.toFixed(3) });
    drawQualityChart('butt-chart', 'butt-chart-legend', [], [], { yLabel: 'Butt', yFormat: v => v.toFixed(3) });
    if (!legendText) return;
    for (const id of ['psnr-chart-legend', 'ssim-chart-legend', 'butt-chart-legend']) {
        const el = document.getElementById(id);
        if (el) el.textContent = legendText;
    }
}

function setChartsDisabledLabels() {
    drawEmptyCharts('graphs off');
}

function refreshCharts() {
    if (!chartsEnabled()) {
        setChartsDisabledLabels();
        return;
    }
    if (lastChartPasses?.length) {
        void computeAndDrawChartsAsync(lastChartPasses, lastChartReference);
    }
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
const DEFAULT_QUALITY_PRESET = 'medium';
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
const chartsEnabledEl = document.getElementById('charts-enabled');
const timingBordersOverride = readBoolParam('borders', null);
const bordersOverride = new URLSearchParams(location.search).get('borders') === '0';

const runMeasurements = [];
let rawReady = false;
let running = false;
let currentPasses = [];
let lastChartPasses = null;
let lastChartReference = null;
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

logWasmBaseline();

initRaw().then(() => {
    rawReady = true;
    setStatus('Ready. Settings first, then retrieve raw file.');
    dbgLog('RAW WASM initialized', '', 'success');
}).catch((error) => {
    setStatus(`RAW WASM failed: ${error?.message ?? error}`);
    dbgLog('RAW WASM failed', error?.message ?? String(error), 'error');
});

async function logWasmBaseline() {
    try {
        const caps = await getCapabilities();
        const workerTier = detectTier();
        const summary = {
            crossOriginIsolated: caps.crossOriginIsolated,
            sharedArrayBuffer: caps.sharedArrayBuffer,
            wasmThreads: caps.wasmThreads,
            selectedWasmBuild: caps.selectedWasmBuild,
            workerTier,
        };
        dbgLog('WASM baseline', JSON.stringify(summary), workerTier?.includes('-mt') ? 'success' : 'warn');
        console.log('[Single progressive] WASM baseline', summary);
    } catch (error) {
        dbgLog('WASM baseline probe failed', error?.message ?? String(error), 'warn');
    }
}

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
if (bordersOverride && showBlockBordersEl) showBlockBordersEl.checked = false;
showBlockBordersEl?.addEventListener('change', redrawCurrentPassView);
chartsEnabledEl?.addEventListener('change', refreshCharts);
refreshCharts();
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
initSettingImpactHints();

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
        await withTimingBlockBordersOverride(async () => {
            const source = await loadRandomAndCacheSource();
            await runSourceWithSettings(source, settings);
        });
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
        await withTimingBlockBordersOverride(() => runSourceWithSettings(loadedSource, settings));
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

async function withTimingBlockBordersOverride(task) {
    if (timingBordersOverride !== false || !showBlockBordersEl) {
        return task();
    }
    const previousChecked = showBlockBordersEl.checked;
    showBlockBordersEl.checked = false;
    try {
        return await task();
    } finally {
        showBlockBordersEl.checked = previousChecked;
        redrawCurrentPassView();
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
        progressiveDetail: settings.progressiveDetail,
        suppressDuplicateProgress: settings.suppressDuplicateProgress,
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

    const uiStartMs = performance.now();

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
        progressiveDetail: settings.progressiveDetail,
    });
    if (thumbDecodeMs != null) {
        metrics.thumbDecodeMs = thumbDecodeMs;
        metrics.thumbBytes = thumbSize;
    }
    runMeasurements.push(metrics);
    renderMetrics(metrics);
    lastChartPasses = decode.passes;
    lastChartReference = targetRgba;
    if (chartsEnabled()) void computeAndDrawChartsAsync(decode.passes, targetRgba);
    else setChartsDisabledLabels();
    metrics.uiDelayMs = Number((performance.now() - uiStartMs).toFixed(2));
    
    updateExportButtons();
    const cutoffFired = !decode.passes.some(p => p.isFinal);
    const finalLine = cutoffFired
        ? `Stopped early at pass ${decode.passes.length} (perceptual cutoff) · avg ${formatTransferSpeed(metrics.avgTransferKbPerSec)}.`
        : `Done. ${metrics.passCount} passes, ${metrics.visibleProgressFrames} visible progress frames, final ${metrics.final_ms ?? '--'} ms · avg ${formatTransferSpeed(metrics.avgTransferKbPerSec)} · UI delay ${metrics.uiDelayMs} ms.`;
    setStatus(finalLine);
    dbgLog('Run transfer average', `${formatTransferSpeed(metrics.avgTransferKbPerSec)} over ${formatBytes(selected.bytes.byteLength)} · final ${metrics.final_ms ?? '--'} ms${cutoffFired ? ' (cutoff)' : ''}`, 'info');
    dbgLog('UI rendering delay', `${metrics.uiDelayMs} ms`, 'warn');
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
    const detailRaw = document.getElementById('progressive-detail')?.value ?? DEFAULT_PROGRESSIVE_DETAIL;
    const progressiveDetail = PROGRESSIVE_DETAILS.has(detailRaw) ? detailRaw : DEFAULT_PROGRESSIVE_DETAIL;
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
        progressiveDetail,
        progressiveAc,
        qProgressiveAc,
        decodingSpeed,
        suppressDuplicateProgress: document.getElementById('suppress-dup-progress')?.checked === true,
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
        progressiveDetail: SNEYERS_PROGRESSIVE_DETAIL,
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
        progressiveDetail: SNEYERS_PROGRESSIVE_DETAIL,
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

async function decodeProgressively({ jxlBytes, width, height, throttleKbPerSec, progressiveDetail, suppressDuplicateProgress = false, targetRgba = null }) {
    const decoder = createDecoder({
        format: 'rgba8',
        region: null,
        downsample: 1,
        progressionTarget: 'final',
        emitEveryPass: emitEveryPassForDetail(progressiveDetail),
        progressiveDetail,
        suppressDuplicateProgress,
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
                await renderProgressivePass(pass);
                pass.paintMs = Number((performance.now() - paintStart).toFixed(2));
                pass.gapMinusPaintMs = Number(Math.max(0, deltaMs - pass.paintMs).toFixed(2));
                setStatus(`Decoding ${formatBytes(bytesFed)}/${formatBytes(feedState.totalBytes)} (${pass.percentFed}%) · paint ${pass.paintMs} ms · gap-paint ${pass.gapMinusPaintMs} ms · pass ${pass.pass} ${pass.ratioLabel ?? '--'}${pass.isFinal ? ' final' : ''}`);
                dbgLog(
                    `Pass ${pass.pass} ${pass.ratioLabel ?? '--'}${pass.isFinal ? ' final' : ''}`,
                    `${pass.t_ms} ms (+${pass.deltaMs} ms = ${pass.gapMinusPaintMs} gap-paint + ${pass.paintMs} paint) · ${formatBytes(bytesFed)}/${formatBytes(feedState.totalBytes)} (+${formatBytes(deltaBytes)}) · ${formatTransferSpeed(deltaKbPerSec)} delta`,
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
        await feedThrottled(decoder, jxlBytes, throttleKbPerSec, feedState, { progressiveDetail });
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

async function decodeProgressivelyViaWorker({ jxlBytes, width, height, throttleKbPerSec, progressiveDetail, suppressDuplicateProgress = false, targetRgba = null }) {
    const ctx = getSessionCtx();
    const session = ctx.decode({
        format: 'rgba8',
        region: null,
        downsample: 1,
        progressionTarget: 'final',
        emitEveryPass: emitEveryPassForDetail(progressiveDetail),
        progressiveDetail,
        suppressDuplicateProgress,
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
            await renderProgressivePass(pass);
            pass.paintMs = Number((performance.now() - paintStart).toFixed(2));
            pass.gapMinusPaintMs = Number(Math.max(0, deltaMs - pass.paintMs).toFixed(2));
            setStatus(`[worker] ${formatBytes(bytesFed)}/${formatBytes(feedState.totalBytes)} · paint ${pass.paintMs} ms · gap-paint ${pass.gapMinusPaintMs} ms · pass ${pass.pass} ${pass.ratioLabel ?? '--'}${pass.isFinal ? ' final' : ''}`);
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

    const decodeTask = (async () => {
        try {
            await feedThrottled(session, jxlBytes, throttleKbPerSec, feedState, { copyChunks: true, progressiveDetail }).catch((e) => {
                if (stoppedEarlyReason || /cancel|Cancel|closed/i.test(String(e && (e.message || e)))) {
                    return; // expected: cutoff/timeout caused cancel mid-feed; subsequent pushes after cancel would throw, we swallow
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
    })();

    await withTimeout(decodeTask, WORKER_DECODE_TIMEOUT_MS, 'Worker decode', () => {
        stoppedEarlyReason = 'timeout';
        dbgLog('Worker decode timeout', `No completion within ${Math.round(WORKER_DECODE_TIMEOUT_MS / 1000)}s; cancelling session`, 'error');
        void session.cancel?.('timeout');
    });

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
        progressiveDetail: DEFAULT_PROGRESSIVE_DETAIL,
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

    // Trigger 3: extended plateau (psnr + butter for structure; connectedness to R1 buildSeries/monotone for lens17/12/16).
    // Now uses butterSeries/monotone instead of psnr-only (robust to color/illum via future constancy).
    if ((last.intendedRatio ?? 8) <= 1 && (prev.intendedRatio ?? 8) <= 1 && targetRgba) {
        if (last.pixels?.byteLength === targetRgba.byteLength && prev.pixels?.byteLength === targetRgba.byteLength) {
            const psnrLast = computePsnrVsFinal(targetRgba, last.pixels);
            const psnrPrev = computePsnrVsFinal(targetRgba, prev.pixels);
            const cmp = createButteraugliComparer(targetRgba, last.width ?? 0, last.height ?? 0);
            const buttLast = cmp(last.pixels);
            const buttPrev = cmp(prev.pixels);
            const smallSeries = [
                { bytes: 0, psnr: psnrPrev, butter: buttPrev },
                { bytes: 1, psnr: psnrLast, butter: buttLast },
            ];
            const monoPsnr = detectMonotone(smallSeries);
            const monoButter = detectMonotone(smallSeries, 0.05, { valueKey: 'butter', lowerIsBetter: true });
            if ((Number.isFinite(psnrLast) && Number.isFinite(psnrPrev) && Math.abs(psnrLast - psnrPrev) < PERCEPTUAL_CUTOFF_PSNR_DELTA_DB)
                || monoButter.monotone) {
                return { reason: 'psnr-butter-plateau', last: last.pass, deltaDb: Math.abs(psnrLast - psnrPrev), buttDelta: Math.abs(buttLast - buttPrev) };
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

function pushDecodeChunk(decoder, chunk, copyChunk) {
    // DONOTCHANGE(worker-transfer): jxl-session push() transfers the underlying ArrayBuffer.
    // copyChunk=true copies before push so encodeBytes/jxlBytes stay valid for one-shot compare + exports.
    if (copyChunk) {
        const view = exactView(chunk);
        return decoder.push(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    }
    return decoder.push(exactBuffer(chunk));
}

async function feedThrottled(decoder, jxlBytes, throttleKbPerSec, feedState, { copyChunks = false, progressiveDetail = DEFAULT_PROGRESSIVE_DETAIL } = {}) {
    // DONOTCHANGE(progressive-checkpoints): When progressiveDetail === 'passes' (diagnostic) or throttle > 0,
    // we MUST chunk-feed and yield (sleep(0) when unthrottled). A single push gives the WASM bridge only one
    // input_generation, so opportunistic flush (bridge.cpp NEED_MORE_INPUT gate) surfaces at most one non-final
    // checkpoint → two frames total. See web/README.md § Single progressive feed invariants.
    // Product path (lastPasses/dc) at throttle 0 may use one push — libjxl last-pass boundaries are enough there.
    const chunkFeed = throttleKbPerSec > 0 || progressiveDetail === 'passes';
    if (!chunkFeed) {
        await pushDecodeChunk(decoder, jxlBytes, copyChunks);
        if (feedState) feedState.bytesFed = jxlBytes.byteLength;
        await decoder.close();
        return;
    }
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
        await pushDecodeChunk(decoder, jxlBytes.subarray(offset, end), copyChunks);
        offset = end;
        if (feedState) feedState.bytesFed = offset;
        if (offset < jxlBytes.byteLength) {
            const delayMs = throttleKbPerSec > 0
                ? ((end - start) / 1024) * (1000 / throttleKbPerSec)
                : 0;
            if (delayMs > 0) await sleep(delayMs);
            else await sleep(0);
        }
    }
    await decoder.close();
}

const TILE_LONG_EDGE_PX = 192; // 2x typical CSS render size for crisp HiDPI tiles

async function renderProgressivePass(pass) {
    const previousPass = currentPasses[pass.pass - 2] ?? null;
    await drawPassWithOverlay(canvas, pass, previousPass, { displayScaleIntermediate: !pass.isFinal });
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

async function showPassInLightbox(index) {
    if (!currentPasses.length || !lightbox || !lightboxCanvas || !lightboxStats) return;
    lightboxIndex = ((index % currentPasses.length) + currentPasses.length) % currentPasses.length;
    const pass = currentPasses[lightboxIndex];
    const previousPass = currentPasses[lightboxIndex - 1] ?? null;
    if (!pass.pixels) {
        lightboxStats.innerHTML = '<div><span>Status</span><strong>pixels released to free memory</strong></div>';
        return;
    }
    await drawPassWithOverlay(lightboxCanvas, pass, previousPass);
    applyLightboxZoom();
    await drawPassWithOverlay(canvas, pass, previousPass);
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

async function redrawCurrentPassView() {
    if (!currentPasses.length) return;
    if (lightbox && !lightbox.hidden && lightboxIndex >= 0) {
        void showPassInLightbox(lightboxIndex);
        return;
    }
    const pass = currentPasses.at(-1);
    const previousPass = currentPasses.at(-2) ?? null;
    await drawPassWithOverlay(canvas, pass, previousPass, { displayScaleIntermediate: !pass.isFinal });
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

async function drawPixels(targetCanvas, pixels, width, height, options = {}) {
    const paintSize = options.displayScaleIntermediate
        ? displayPaintSize(targetCanvas, width, height)
        : { width, height };
    if (targetCanvas.width !== paintSize.width) targetCanvas.width = paintSize.width;
    if (targetCanvas.height !== paintSize.height) targetCanvas.height = paintSize.height;
    const source = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    const data = (paintSize.width === width && paintSize.height === height)
        ? source
        : downsampleRgbaNearest(source, width, height, paintSize.width, paintSize.height);
    const bitmap = await createImageBitmap(new ImageData(data, paintSize.width, paintSize.height));
    targetCanvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    return { scaleX: paintSize.width / width, scaleY: paintSize.height / height };
}

async function drawPassWithOverlay(targetCanvas, pass, previousPass, options = {}) {
    const scale = await drawPixels(targetCanvas, pass.pixels, pass.width, pass.height, options);
    if (!shouldShowBlockBorders()) return;
    if (pass.width * pass.height > PASS_BORDER_RES_MAX) return;
    const blocks = computeChangedBlocks(pass, previousPass);
    drawBlockBorders(targetCanvas, blocks, scale);
}

function displayPaintSize(targetCanvas, width, height) {
    const wrap = targetCanvas.parentElement;
    const maxWidth = Math.max(1, Math.floor(wrap?.clientWidth || targetCanvas.clientWidth || width));
    const maxHeightFromWrap = Math.max(1, Math.floor(wrap?.clientHeight || targetCanvas.clientHeight || height));
    const viewportMaxHeight = Math.max(1, Math.floor((window.innerHeight || maxHeightFromWrap) * 0.78));
    const maxHeight = Math.min(maxHeightFromWrap, viewportMaxHeight);
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

function downsampleRgbaNearest(source, width, height, targetWidth, targetHeight) {
    const out = new Uint8ClampedArray(targetWidth * targetHeight * 4);
    const xScale = width / targetWidth;
    const yScale = height / targetHeight;
    for (let y = 0; y < targetHeight; y++) {
        const sy = Math.min(height - 1, Math.floor((y + 0.5) * yScale));
        const srcRow = sy * width * 4;
        const dstRow = y * targetWidth * 4;
        for (let x = 0; x < targetWidth; x++) {
            const sx = Math.min(width - 1, Math.floor((x + 0.5) * xScale));
            const srcIdx = srcRow + sx * 4;
            const dstIdx = dstRow + x * 4;
            out[dstIdx] = source[srcIdx];
            out[dstIdx + 1] = source[srcIdx + 1];
            out[dstIdx + 2] = source[srcIdx + 2];
            out[dstIdx + 3] = source[srcIdx + 3];
        }
    }
    return out;
}

function shouldShowBlockBorders() {
    if (bordersOverride) return false;
    return showBlockBordersEl ? showBlockBordersEl.checked : true;
}

function computeChangedBlocks(pass, previousPass) {
    if (!pass?.pixels?.length) return [];
    if (!previousPass?.pixels?.length || previousPass.width !== pass.width || previousPass.height !== pass.height) {
        return [{ x: 0, y: 0, width: pass.width, height: pass.height }];
    }

    const cacheKey = readChangedBlocksCacheKey(pass, previousPass);
    if (pass._changedBlocksKey === cacheKey && Array.isArray(pass._changedBlocks)) {
        return pass._changedBlocks;
    }

    const tileSize = BLOCK_BORDER_TILE_SIZE;
    const cols = Math.ceil(pass.width / tileSize);
    const rows = Math.ceil(pass.height / tileSize);
    const current32 = toUint32View(pass.pixels);
    const previous32 = toUint32View(previousPass.pixels);
    const changed = scanChangedTileGrid(current32, previous32, pass.width, pass.height, cols, rows);

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
    pass._changedBlocksKey = cacheKey;
    pass._changedBlocks = blocks;
    return blocks;
}

function toUint32View(u8arr) {
    if (u8arr.byteOffset % 4 === 0) {
        return new Uint32Array(u8arr.buffer, u8arr.byteOffset, u8arr.byteLength >>> 2);
    }
    const copy = new Uint8Array(u8arr.byteLength);
    copy.set(u8arr);
    return new Uint32Array(copy.buffer);
}

function readChangedBlocksCacheKey(pass, previousPass) {
    const currentId = pass.stats?.frameHash && pass.stats.frameHash !== '--'
        ? pass.stats.frameHash
        : `pass:${pass.pass ?? ''}`;
    const previousId = previousPass?.stats?.frameHash && previousPass.stats.frameHash !== '--'
        ? previousPass.stats.frameHash
        : `pass:${previousPass?.pass ?? ''}`;
    return `${pass.width}x${pass.height}:${currentId}:${previousId}`;
}

function scanChangedTileGrid(current32, previous32, width, height, cols, rows) {
    const changed = new Uint8Array(cols * rows);
    const tileSize = BLOCK_BORDER_TILE_SIZE;
    let rowStart = 0;
    let rowEnd = rows - 1;
    let colStart = 0;
    let colEnd = cols - 1;

    if (!BLOCK_BORDERS_STRICT) {
        rowStart = rows;
        rowEnd = -1;
        colStart = cols;
        colEnd = -1;
        for (let y = 0; y < height; y += BBOX_STRIDE) {
            const rowBase = y * width;
            for (let x = 0; x < width; x += BBOX_STRIDE) {
                if (current32[rowBase + x] === previous32[rowBase + x]) continue;
                const row = Math.floor(y / tileSize);
                const col = Math.floor(x / tileSize);
                rowStart = Math.min(rowStart, row);
                rowEnd = Math.max(rowEnd, row);
                colStart = Math.min(colStart, col);
                colEnd = Math.max(colEnd, col);
            }
        }
        if (rowEnd < rowStart || colEnd < colStart) return changed;
    }

    for (let row = rowStart; row <= rowEnd; row++) {
        const y0 = row * tileSize;
        const y1 = Math.min(height, y0 + tileSize);
        for (let col = colStart; col <= colEnd; col++) {
            const tileIndex = row * cols + col;
            if (changed[tileIndex]) continue;
            const x0 = col * tileSize;
            const x1 = Math.min(width, x0 + tileSize);
            scanTile:
            for (let y = y0; y < y1; y++) {
                const rowBase = y * width;
                for (let x = x0; x < x1; x++) {
                    if (current32[rowBase + x] === previous32[rowBase + x]) continue;
                    changed[tileIndex] = 1;
                    break scanTile;
                }
            }
        }
    }

    return changed;
}

function drawBlockBorders(targetCanvas, blocks, scale = { scaleX: 1, scaleY: 1 }) {
    if (!blocks.length) return;
    const ctx = targetCanvas.getContext('2d');
    ctx.save();
    ctx.strokeStyle = BLOCK_BORDER_COLOR;
    ctx.lineWidth = BLOCK_BORDER_SIZE;
    ctx.setLineDash([]);
    const inset = BLOCK_BORDER_SIZE / 2;
    for (const block of blocks) {
        ctx.strokeRect(
            block.x * scale.scaleX + inset,
            block.y * scale.scaleY + inset,
            Math.max(0, block.width * scale.scaleX - BLOCK_BORDER_SIZE),
            Math.max(0, block.height * scale.scaleY - BLOCK_BORDER_SIZE)
        );
    }
    ctx.restore();
}

function buildMeasurement({ source, target, targetKb, throttleKbPerSec, selected, encodeTotalMs, decode, oneShotMs, finalPsnr, sizePreset, qualityPreset, progressiveDc, progressiveAc, qProgressiveAc, decodingSpeed, groupOrder, groupOrderLabel, progressiveDetail }) {
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
            gap_minus_paint_ms: pass.gapMinusPaintMs ?? null,
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
        progressiveDetail,
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

function drawQualityChart(canvasId, legendId, passes, values, {
    yPad = 2, yClampMin = null, yClampMax = null,
    yLabel = '', yFormat = v => v.toFixed(2),
    lineColor = '#7de0b0', finalColor = '#f0c86a',
} = {}) {
    const chartCanvas = document.getElementById(canvasId);
    const legend = legendId ? document.getElementById(legendId) : null;
    if (!chartCanvas) return;

    const ctx = chartCanvas.getContext('2d');
    const w = chartCanvas.width;
    const h = chartCanvas.height;
    ctx.fillStyle = '#0a0f11';
    ctx.fillRect(0, 0, w, h);

    const finite = (values ?? []).filter(v => Number.isFinite(v));
    if (!passes?.length || !finite.length) {
        if (legend) legend.textContent = passes?.length ? 'no comparable passes' : '--';
        return;
    }

    const padL = 30;
    const padR = 8;
    const padT = 8;
    const padB = 18;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    let minY = Math.min(...finite) - yPad;
    let maxY = Math.max(...finite) + yPad;
    if (yClampMin !== null) minY = Math.max(yClampMin, minY);
    if (yClampMax !== null) maxY = Math.min(yClampMax, maxY);
    const rangeY = Math.max(0.001, maxY - minY);

    const maxTime = Math.max(1, passes.at(-1)?.t_ms ?? 1);
    const toX = t => padL + (t / maxTime) * plotW;
    const toY = v => padT + plotH - ((v - minY) / rangeY) * plotH;

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
    ctx.fillText(yFormat(maxY), padL - 4, padT + 8);
    ctx.fillText(yFormat(minY), padL - 4, padT + plotH);
    ctx.textAlign = 'left';
    ctx.fillText(yLabel, 2, padT + 8);
    ctx.fillText('0', padL, padT + plotH + 12);
    ctx.textAlign = 'right';
    const maxLabel = maxTime < 1000 ? `${maxTime.toFixed(0)}ms` : `${(maxTime / 1000).toFixed(1)}s`;
    ctx.fillText(maxLabel, padL + plotW, padT + plotH + 12);

    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let drewFirst = false;
    values.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        const x = toX(passes[i].t_ms);
        const y = toY(v);
        if (drewFirst) ctx.lineTo(x, y);
        else { ctx.moveTo(x, y); drewFirst = true; }
    });
    ctx.stroke();

    values.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        const x = toX(passes[i].t_ms);
        const y = toY(v);
        ctx.fillStyle = passes[i].isFinal ? finalColor : lineColor;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
    });

    if (legend) legend.textContent = `${finite.length} of ${passes.length} passes · ${yFormat(finite.at(-1))} final`;
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
    drawEmptyCharts();
}

function exportMeasurementsCSV() {
    if (!runMeasurements.length) return;
    const headers = [
        'ts', 'source', 'source_width', 'source_height', 'target_width', 'target_height',
        'size_preset', 'quality_preset', 'progressive_dc', 'progressive_ac', 'qprogressive_ac', 'decoding_speed', 'group_order', 'group_order_label', 'estimate_kb', 'actual_kb', 'size_error_pct',
        'quality', 'encode_ms', 'encode_total_ms',
        'throttle_kb_per_sec', 'avg_transfer_kb_per_sec', 'passes', 'visible_progress_frames', 'unique_frame_hashes',
        'first_ms', 'final_ms', 'oneShot_ms', 'speedup_x', 'final_psnr_vs_source', 'pass_bytes', 'pass_delta_ms', 'pass_delta_bytes', 'pass_delta_kb_per_sec', 'pass_paint_ms', 'pass_gap_minus_paint_ms', 'pass_intended_ratio', 'pass_ratio_label', 'pass_stats'
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
        (m.perPass || []).map(p => `${p.pass}:${p.gap_minus_paint_ms ?? ''}`).join(';'),
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

async function exportMeasurementsTOON() {
    if (!runMeasurements.length) return;

    const dict = {
        'ti': 'tiny',
        'sm': 'small',
        'me': 'medium',
        'la': 'large',
        'di': 'display',
        'vl': 'very-large',
        'or': 'original',
        'co': 'center-out',
        'tb': 'top-bottom'
    };
    const reverseDict = Object.fromEntries(Object.entries(dict).map(([k,v]) => [v,k]));
    const mapVal = (v) => reverseDict[v] || v;

    let out = `Dict: ${Object.entries(dict).map(([k,v]) => `${k}=${v}`).join(', ')}\n`;
    out += `meta:\n`;
    out += `  exportedAt: ${new Date().toISOString()}\n`;
    out += `  generator: single-progressive\n`;
    out += `  rowCount: ${runMeasurements.length}\n`;
    out += `  sources[${[...new Set(runMeasurements.map(m => m.source))].length}]:\n`;
    for (const src of [...new Set(runMeasurements.map(m => m.source))]) {
        out += `    - name: ${quoteIfNeeded(src)}\n`;
    }

    // Create the runs array and flatten perPass rows into it, identical to how parse_log2.py works
    let rowCount = 0;
    for (const m of runMeasurements) {
        if (m.perPass && m.perPass.length) rowCount += m.perPass.length;
        else rowCount += 1;
    }

    out += `\n---\n`;
    out += `runs[${rowCount}]{source|target|size|qual|pdc|pac|qpac|ds|go|encMs|throttle|totalKB|uiDelay|pass|t_ms|isFinal|paintMs|gapMinusPaintMs|delta|oneshotMs}:\n`;

    let lastSource = '';
    let lastTarget = '';
    let lastSize = '';
    let lastQual = '';
    let lastPdc = '';
    let lastPac = '';
    let lastQpac = '';
    let lastDs = '';
    let lastGo = '';
    let lastEncMs = '';
    let lastThrottle = '';
    let lastTotalKB = '';
    let lastOneshot = '';
    let lastUiDelay = '';
    let lastDelta = '';

    for (const m of runMeasurements) {
        const source = quoteIfNeeded(m.source);
        const target = `${m.targetWidth}x${m.targetHeight}`;
        const sizePreset = mapVal(m.sizePreset ?? '');
        const qual = m.qualityPreset ?? '';
        const pdc = m.progressiveDc ?? '';
        const pac = m.progressiveAc ?? '';
        const qpac = m.qProgressiveAc ?? '';
        const ds = m.decodingSpeed ?? '';
        const go = mapVal(m.groupOrderLabel ?? m.groupOrder ?? '');
        const encMs = m.encode_total_ms != null ? m.encode_total_ms.toFixed(1) : '';
        const throttle = m.throttleKbPerSec || 0;
        const totalKB = m.actualKb != null ? m.actualKb.toFixed(1) : '';
        const oneshotMs = m.oneShot_ms != null ? m.oneShot_ms.toFixed(1) : '';
        const uiDelay = m.uiDelayMs != null ? m.uiDelayMs.toFixed(1) : '';

        if (!m.perPass || !m.perPass.length) {
            const outSource = source === lastSource ? '~' : source;
            const outTarget = target === lastTarget ? '~' : target;
            const outSize = sizePreset === lastSize ? '~' : sizePreset;
            const outQual = qual === lastQual ? '~' : qual;
            const outPdc = String(pdc) === String(lastPdc) ? '~' : pdc;
            const outPac = String(pac) === String(lastPac) ? '~' : pac;
            const outQpac = String(qpac) === String(lastQpac) ? '~' : qpac;
            const outDs = String(ds) === String(lastDs) ? '~' : ds;
            const outGo = String(go) === String(lastGo) ? '~' : go;
            const outEnc = String(encMs) === String(lastEncMs) ? '~' : encMs;
            const outThrot = String(throttle) === String(lastThrottle) ? '~' : throttle;
            const outTotKB = String(totalKB) === String(lastTotalKB) ? '~' : totalKB;
            const outUiDelay = String(uiDelay) === String(lastUiDelay) ? '~' : uiDelay;
            const outOneShot = String(oneshotMs) === String(lastOneshot) ? '~' : oneshotMs;

            out += `  ${outSource} | ${outTarget} | ${outSize} | ${outQual} | ${outPdc} | ${outPac} | ${outQpac} | ${outDs} | ${outGo} | ${outEnc} | ${outThrot} | ${outTotKB} | ${outUiDelay} | - | - | - | - | - | - | ${outOneShot}\n`;

            lastSource = source; lastTarget = target; lastSize = sizePreset; lastQual = qual;
            lastPdc = pdc; lastPac = pac; lastQpac = qpac; lastDs = ds; lastGo = go;
            lastEncMs = encMs; lastThrottle = throttle; lastTotalKB = totalKB; lastOneshot = oneshotMs; lastUiDelay = uiDelay;
            lastDelta = '';
        } else {
            for (const p of m.perPass) {
                const pass = p.pass;
                const t_ms = p.t_ms != null ? p.t_ms.toFixed(1) : '';
                const isFinal = p.isFinal ? 'T' : 'F';
                const paintMs = p.paint_ms != null ? p.paint_ms.toFixed(1) : '';
                const gapMinusPaintMs = p.gap_minus_paint_ms != null ? p.gap_minus_paint_ms.toFixed(1) : '';
                const deltaBytes = p.delta_bytes != null ? (p.delta_bytes / 1024).toFixed(1) + 'KB' : '';
                const delta = deltaBytes ? '+' + deltaBytes : '';

                const outSource = source === lastSource ? '~' : source;
                const outTarget = target === lastTarget ? '~' : target;
                const outSize = sizePreset === lastSize ? '~' : sizePreset;
                const outQual = qual === lastQual ? '~' : qual;
                const outPdc = String(pdc) === String(lastPdc) ? '~' : pdc;
                const outPac = String(pac) === String(lastPac) ? '~' : pac;
                const outQpac = String(qpac) === String(lastQpac) ? '~' : qpac;
                const outDs = String(ds) === String(lastDs) ? '~' : ds;
                const outGo = String(go) === String(lastGo) ? '~' : go;
                const outEnc = String(encMs) === String(lastEncMs) ? '~' : encMs;
                const outThrot = String(throttle) === String(lastThrottle) ? '~' : throttle;
                const outTotKB = String(totalKB) === String(lastTotalKB) ? '~' : totalKB;
                const outUiDelay = String(uiDelay) === String(lastUiDelay) ? '~' : uiDelay;
                const outOneShot = String(oneshotMs) === String(lastOneshot) ? '~' : oneshotMs;
                const outDelta = delta === lastDelta && lastDelta !== '' ? '~' : delta;

                out += `  ${outSource} | ${outTarget} | ${outSize} | ${outQual} | ${outPdc} | ${outPac} | ${outQpac} | ${outDs} | ${outGo} | ${outEnc} | ${outThrot} | ${outTotKB} | ${outUiDelay} | ${pass} | ${t_ms} | ${isFinal} | ${paintMs} | ${gapMinusPaintMs} | ${outDelta} | ${outOneShot}\n`;

                lastSource = source; lastTarget = target; lastSize = sizePreset; lastQual = qual;
                lastPdc = pdc; lastPac = pac; lastQpac = qpac; lastDs = ds; lastGo = go;
                lastEncMs = encMs; lastThrottle = throttle; lastTotalKB = totalKB; lastOneshot = oneshotMs; lastUiDelay = uiDelay;
                lastDelta = delta;
            }
        }
    }

    // Custom prompt logic for "Copy Only"
    // Using simple browser confirm and prompt since it's hard to build a whole DOM dialog inline cleanly, 
    // but a prompt allows 3 choices by checking string.
    let userChoice = prompt("Type 'C' to Copy Only, 'S' to Copy & Save, or hit Cancel.", "S");

    if (userChoice !== null) {
        userChoice = userChoice.toUpperCase().trim();
        if (userChoice === 'C' || userChoice === 'S') {
            try {
                await navigator.clipboard.writeText(out);
                dbgLog('Copied TOON to clipboard', `${rowCount} rows`);
            } catch (err) {
                dbgLog('Clipboard blocked', String(err), 'warn');
            }
        }
        if (userChoice === 'S') {
            downloadText(`single-progressive-${timestamp()}.toon`, out, 'text/toon');
            dbgLog('Exported TOON', `${rowCount} rows`, 'success');
        }
    }
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
        out += '| Pass | Stage | Ratio | KB streamed | Streamed % | Transfer KB/s | Delta ms | Delta KB | Delta KB/s | Paint ms | Gap minus paint ms | t ms | Final | alphaMin | alphaMax | alphaZeroPct | rgbNonzeroCount | lumaVariance | frameHash |\n';
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
                p.gap_minus_paint_ms ?? '',
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

function withTimeout(promise, ms, label, onTimeout) {
    let timeoutId = null;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            try { onTimeout?.(); } catch {}
            reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timeoutId !== null) clearTimeout(timeoutId);
    });
}

function nextPaint() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}
