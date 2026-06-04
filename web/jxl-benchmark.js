import initRaw, * as rawWasm from './pkg/raw_converter_wasm.js';
import { createDecoder, createEncoder, detectTier, setForcedTier } from '@casabio/jxl-wasm';
import { bindRangeLabel } from './jxl-dashboard-ui.js';
import { initDebugConsole, dbgLog } from './jxl-debug-console.js';
import {
    formatBenchmarkFileStatus,
    formatBenchmarkProgress,
    formatLoadFileStatus,
    formatLoadProgress,
} from './jxl-benchmark-progress.js';
import { createFilePicker } from './jxl-file-picker.js';

// Console page header — always shows which page this console belongs to (dev productivity across many open lab/benchmark tabs)
console.log('%c[Benchmark] jxl-benchmark.js loaded — JXL Benchmark page (performance batch runs)', 'color:#3b82f6;font-weight:600', { page: 'Benchmark', url: location.href, t: new Date().toISOString(), ua: navigator.userAgent.slice(0, 120) });

const { process_orf } = rawWasm;

const ALL_SIZES = [128, 256, 512, 1080, 1920, 'fullsize'];
const DEFAULT_SIZES = [128, 512, 1080];
const QUALITIES = [85, 95];
const EFFORT = 3;
const STATUS_UPDATE_INTERVAL_MS = 120;
const PERM_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#f97316', '#06b6d4', '#ec4899'];

function getSystemInfo() {
    const ua = navigator.userAgent;
    let browser = 'Unknown';
    let browserVersion = 'Unknown';

    if (ua.includes('Chrome') && !ua.includes('Edg')) {
        browser = 'Chrome';
        const match = ua.match(/Chrome\/(\d+)/);
        if (match) browserVersion = match[1];
    } else if (ua.includes('Firefox')) {
        browser = 'Firefox';
        const match = ua.match(/Firefox\/(\d+)/);
        if (match) browserVersion = match[1];
    } else if (ua.includes('Safari') && !ua.includes('Chrome')) {
        browser = 'Safari';
        const match = ua.match(/Version\/(\d+)/);
        if (match) browserVersion = match[1];
    } else if (ua.includes('Edg')) {
        browser = 'Edge';
        const match = ua.match(/Edg\/(\d+)/);
        if (match) browserVersion = match[1];
    }

    const cpuCores = navigator.hardwareConcurrency || 'Unknown';
    const deviceMemory = navigator.deviceMemory || 'Unknown';
    const platform = navigator.platform || 'Unknown';
    const screen = window.screen ? `${window.screen.width}×${window.screen.height}` : 'Unknown';

    return {
        browser,
        browserVersion,
        cpuCores,
        deviceMemory,
        platform,
        screen,
    };
}

function getMemoryInfo() {
    if (!performance.memory) return null;
    return {
        usedJSHeapSize: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024),
        totalJSHeapSize: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024),
        jsHeapSizeLimit: Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024),
    };
}

function detectThermalDegradation(timingHistory) {
    if (timingHistory.length < 3) return null;
    const first3 = timingHistory.slice(0, 3);
    const last3 = timingHistory.slice(-3);
    const avgFirst = first3.reduce((a, b) => a + b) / first3.length;
    const avgLast = last3.reduce((a, b) => a + b) / last3.length;
    const degradation = ((avgLast - avgFirst) / avgFirst * 100).toFixed(1);
    return parseFloat(degradation);
}

function getSettings() {
    const sizes = Array.from(document.querySelectorAll('input[name="benchmark-size"]:checked')).map(cb => cb.value);
    const qualities = Array.from(document.querySelectorAll('input[name="quality"]:checked')).map(cb => cb.value);
    const efforts = Array.from(document.querySelectorAll('input[name="effort"]:checked')).map(cb => cb.value);
    const iterations = iterationsInput.value;
    const maxFiles = maxFilesInput.value;
    const advOpts = getAdvancedOptions();

    return {
        sizes,
        qualities,
        efforts,
        iterations,
        maxFiles,
        options: advOpts,
    };
}

// Download a single JXL Uint8Array as a file.
function triggerJxlDownload(bytes, filename) {
    const blob = new Blob([bytes], { type: 'image/jxl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Collect all encoded bytes matching a key prefix (e.g. ':fullsize' or any config key).
function collectEncodedSet(keyFilter) {
    const results = []; // { filename, bytes }
    if (!benchmarkResults.encodedBytes) return results;
    for (const [mapKey, bytes] of benchmarkResults.encodedBytes.entries()) {
        if (!keyFilter || mapKey.includes(keyFilter)) {
            // mapKey = "${source.file}:${size}x${quality}xe${effort}"
            const colonIdx = mapKey.indexOf(':');
            const sourceName = mapKey.slice(0, colonIdx);
            const configPart = mapKey.slice(colonIdx + 1); // e.g. "fullsizex85xe5"
            // Parse config for suffix: size, quality, effort
            const m = configPart.match(/^([^x]+)x(\d+)xe(\d+)$/);
            const sizeSuffix = m ? (m[1] === 'fullsize' ? 'full' : `${m[1]}px`) : configPart;
            const qSuffix   = m ? `_q${m[2]}` : '';
            const eSuffix   = m ? `_e${m[3]}` : '';
            const baseName  = sourceName.replace(/\.[^.]+$/, '');
            const filename  = `${baseName}_${sizeSuffix}${qSuffix}${eSuffix}.jxl`;
            results.push({ filename, bytes });
        }
    }
    return results;
}

// Save a set of JXL files to a chosen folder (File System Access API) or fall back to downloads.
async function saveSetToFolder(entries, labelForLog) {
    if (!entries.length) {
        dbgLog(`No encoded JXL bytes for ${labelForLog}`, '', 'warn');
        return;
    }

    if (typeof showDirectoryPicker === 'function') {
        let dirHandle;
        try {
            dirHandle = await showDirectoryPicker({ mode: 'readwrite' });
        } catch (e) {
            if (e.name === 'AbortError') return; // user cancelled
            dbgLog(`Folder picker failed: ${e.message}`, '', 'error');
            return;
        }
        let saved = 0;
        for (const { filename, bytes } of entries) {
            try {
                const fh = await dirHandle.getFileHandle(filename, { create: true });
                const writable = await fh.createWritable();
                await writable.write(bytes);
                await writable.close();
                saved++;
            } catch (e) {
                dbgLog(`Failed to write ${filename}: ${e.message}`, '', 'error');
            }
        }
        dbgLog(`Saved ${saved}/${entries.length} JXL files to folder`, '', 'success');
    } else {
        // Fallback: sequential <a download> — browser may block multiple rapid downloads
        dbgLog(`showDirectoryPicker not available — triggering ${entries.length} individual downloads`, '', 'warn');
        for (const { filename, bytes } of entries) {
            triggerJxlDownload(bytes, filename);
            await new Promise(r => setTimeout(r, 120)); // slight delay to avoid browser throttle
        }
    }
}

// Button: save encoded JXL files to a chosen folder.
// Prefers fullsize; falls back to all available sizes if fullsize was not benchmarked.
async function saveFullFiles() {
    const fullEntries = collectEncodedSet(':fullsize');
    if (fullEntries.length > 0) {
        await saveSetToFolder(fullEntries, 'fullsize');
    } else {
        // No fullsize benchmarked — offer all available encoded bytes
        const allEntries = collectEncodedSet(null);
        await saveSetToFolder(allEntries, 'all sizes');
    }
}

function saveSettings() {
    const settings = getSettings();
    const json = JSON.stringify(settings, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jxl-benchmark-settings-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    dbgLog('Settings saved');
}

function loadSettings(settings) {
    try {
        // Load sizes
        if (settings.sizes && Array.isArray(settings.sizes)) {
            document.querySelectorAll('input[name="benchmark-size"]').forEach(cb => {
                cb.checked = settings.sizes.includes(cb.value);
            });
        }

        // Load qualities
        if (settings.qualities && Array.isArray(settings.qualities)) {
            document.querySelectorAll('input[name="quality"]').forEach(cb => {
                cb.checked = settings.qualities.includes(cb.value);
            });
        }

        // Load efforts
        if (settings.efforts && Array.isArray(settings.efforts)) {
            document.querySelectorAll('input[name="effort"]').forEach(cb => {
                cb.checked = settings.efforts.includes(cb.value);
            });
        }

        // Load iterations and maxFiles
        if (settings.iterations) iterationsInput.value = settings.iterations;
        if (settings.maxFiles) maxFilesInput.value = settings.maxFiles;

        // Load options
        if (settings.options) {
            if (settings.options.simd !== undefined) document.getElementById('opt-simd').checked = settings.options.simd;
            if (settings.options.threading !== undefined) document.getElementById('opt-threading').checked = settings.options.threading;
            if (settings.options.progressive !== undefined) document.getElementById('opt-progressive').checked = settings.options.progressive;
            if (settings.options.preserveIcc !== undefined) document.getElementById('opt-preserve-icc').checked = settings.options.preserveIcc;
            if (settings.options.preserveMetadata !== undefined) document.getElementById('opt-preserve-metadata').checked = settings.options.preserveMetadata;
            if (settings.options.chunked !== undefined) document.getElementById('opt-chunked').checked = settings.options.chunked;
            if (settings.options.lossless !== undefined) document.getElementById('opt-lossless').checked = settings.options.lossless;
            if (settings.options.previewFirst !== undefined) document.getElementById('opt-preview-first').checked = settings.options.previewFirst;
            if (settings.options.skipCopy !== undefined) document.getElementById('opt-skip-copy').checked = settings.options.skipCopy;
            if (settings.options.modular !== undefined) document.getElementById('opt-modular').checked = settings.options.modular;
            if (settings.options.butteraugliTarget !== undefined) document.getElementById('butteraugli-target').value = settings.options.butteraugliTarget;
            if (settings.options.brotliEffort !== undefined) document.getElementById('brotli-effort').value = settings.options.brotliEffort;
            if (settings.options.downsample !== undefined) {
                const downsampleInput = document.querySelector(`input[name="downsample"][value="${settings.options.downsample}"]`);
                if (downsampleInput) downsampleInput.checked = true;
            }
        }

        updateTierFromToggles();
        dbgLog('Settings loaded');
    } catch (err) {
        dbgLog('Failed to load settings: ' + err.message, '', 'error');
    }
}

function exportFullResultsJson() {
    if (!benchmarkResults || (benchmarkResults.decodeMs.size === 0 && permutations.length === 0)) {
        dbgLog('No benchmark results to export', '', 'warn');
        return;
    }
    const payload = {
        exportedAt: new Date().toISOString(),
        system: getSystemInfo(),
        memory: getMemoryInfo(),
        settings: getSettings(),
        sources: selectedSources.map(s => ({ file: s.file, width: s.width, height: s.height })),
        sourceCount: selectedSources.length,
        results: {
            // Convert Maps to plain objects for JSON
            decodeMs: Object.fromEntries(Array.from(benchmarkResults.decodeMs.entries())),
            encodeMs: Object.fromEntries(Array.from(benchmarkResults.encodeMs.entries())),
            resizeMs: Object.fromEntries(Array.from(benchmarkResults.resizeMs.entries())),
            firstChunkMs: Object.fromEntries(Array.from(benchmarkResults.firstChunkMs.entries())),
            totalMs: Object.fromEntries(Array.from(benchmarkResults.totalMs.entries())),
            fileSize: Object.fromEntries(Array.from(benchmarkResults.fileSize.entries())),
            // Note: encodedBytes are heavy Uint8Arrays — omitted from JSON export to keep size reasonable; use "Save full files" for binaries
        },
        permutations: permutations.map(p => ({
            id: p.id,
            label: p.label,
            color: p.color,
            visible: p.visible,
            // Snapshot of results at time of perm capture (already plain-ish from snapshotResults)
            results: p.results ? {
                decodeMs: Object.fromEntries(Array.from(p.results.decodeMs.entries())),
                encodeMs: Object.fromEntries(Array.from(p.results.encodeMs.entries())),
                resizeMs: Object.fromEntries(Array.from(p.results.resizeMs.entries())),
                firstChunkMs: Object.fromEntries(Array.from(p.results.firstChunkMs.entries())),
                totalMs: Object.fromEntries(Array.from(p.results.totalMs.entries())),
                fileSize: Object.fromEntries(Array.from(p.results.fileSize.entries())),
            } : null,
        })),
        note: 'encodedBytes omitted (use Save full files button for .jxl binaries). Import this JSON into analysis scripts or the option-matrix tools.'
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jxl-bench-results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    dbgLog(`Exported full results JSON (${(json.length / 1024).toFixed(1)} KB)`, '', 'success');
}

const sourceInput = document.getElementById('source-input');
const sourceDrop = document.getElementById('source-drop');
const loadRandomBtn = document.getElementById('load-random');
const startBenchmarkBtn = document.getElementById('start-benchmark');
const clearResultsBtn = document.getElementById('clear-results');
const iterationsInput = document.getElementById('iterations');
const maxFilesInput = document.getElementById('max-files');
const selectionStatus = document.getElementById('selection-status');
const progressStatus = document.getElementById('progress-status');
const fileStatus = document.getElementById('file-status');
const timingStatus = document.getElementById('timing-status');
const dbgConsoleBtn = document.getElementById('dbg-console-btn');
const cancelBenchmarkBtn = document.getElementById('cancel-benchmark');
const exportResultsJsonBtn = document.getElementById('export-results-json');
if (exportResultsJsonBtn) exportResultsJsonBtn.disabled = true;

let selectedSources = [];
let benchmarkResults = {
    decodeMs: new Map(),
    encodeMs: new Map(),
    resizeMs: new Map(),
    firstChunkMs: new Map(),
    totalMs: new Map(),
    fileSize: new Map(),
};
let permutations = [];      // { id, label, color, visible, results }
let addPermutationMode = false;
let activeBenchmarkId = 0;
let lastProgressStatusAt = 0;
let wasmReady = false;
let isRunning = false;

function makePermLabel(opts, id) {
    const tags = [];
    if (opts.simd) tags.push('SIMD');
    if (opts.threading) tags.push('MT');
    if (opts.lossless) tags.push('LL');
    if (opts.modular) tags.push('Mod');
    if (opts.skipCopy) tags.push('ZC');
    if (!opts.progressive) tags.push('1shot');
    return `Run ${id}` + (tags.length ? ` · ${tags.join('+')}` : '');
}

function snapshotResults() {
    return {
        decodeMs: new Map(benchmarkResults.decodeMs),
        encodeMs: new Map(benchmarkResults.encodeMs),
        resizeMs: new Map(benchmarkResults.resizeMs),
        firstChunkMs: new Map(benchmarkResults.firstChunkMs),
        totalMs: new Map(benchmarkResults.totalMs),
        fileSize: new Map(benchmarkResults.fileSize),
    };
}

function addPermutation() {
    const opts = getAdvancedOptions();
    const id = permutations.length + 1;
    permutations.push({
        id,
        label: makePermLabel(opts, id),
        color: PERM_COLORS[(id - 1) % PERM_COLORS.length],
        visible: true,
        results: snapshotResults(),
    });
    addPermutationMode = true;
    renderPermutationSelector();
    drawGraphs();
    const btn = document.getElementById('add-permutation');
    if (btn) btn.disabled = true;
    if (exportResultsJsonBtn) exportResultsJsonBtn.disabled = false;
    updateButtonStates();
}

// Verify DOM elements exist
if (!sourceInput || !loadRandomBtn || !startBenchmarkBtn) {
    console.error('Missing DOM elements:', { sourceInput, loadRandomBtn, startBenchmarkBtn });
} else {
    console.log('DOM elements found');
}

if (dbgConsoleBtn) {
    initDebugConsole(dbgConsoleBtn);
    dbgLog('Console initialized');
} else {
    console.error('dbgConsoleBtn not found');
}

// Wire tier toggles
const optSimd = document.getElementById('opt-simd');
const optThreading = document.getElementById('opt-threading');
if (optSimd) optSimd.addEventListener('change', updateTierFromToggles);
if (optThreading) optThreading.addEventListener('change', updateTierFromToggles);
// Reflect auto-detected tier immediately
updateTierFromToggles();

// Initialize sizes checkboxes
DEFAULT_SIZES.forEach(size => {
    const checkbox = document.querySelector(`input[name="benchmark-size"][value="${size}"]`);
    if (checkbox) checkbox.checked = true;
});

function getSelectedSizes() {
    const selected = Array.from(document.querySelectorAll('input[name="benchmark-size"]:checked'))
        .map(cb => {
            const val = cb.value;
            return val === 'fullsize' ? val : Number(val);
        })
        .sort((a, b) => {
            if (a === 'fullsize') return 1;
            if (b === 'fullsize') return -1;
            return a - b;
        });
    return selected.length ? selected : DEFAULT_SIZES;
}

function getSelectedQualities() {
    const selected = Array.from(document.querySelectorAll('input[name="quality"]:checked'))
        .map(cb => Number(cb.value))
        .sort((a, b) => a - b);
    return selected.length ? selected : [85];
}

function getSelectedEfforts() {
    const selected = Array.from(document.querySelectorAll('input[name="effort"]:checked'))
        .map(cb => Number(cb.value))
        .sort((a, b) => a - b);
    return selected.length ? selected : [3];
}

function getAdvancedOptions() {
    const downsample = document.querySelector('input[name="downsample"]:checked');
    return {
        simd: document.getElementById('opt-simd').checked,
        threading: document.getElementById('opt-threading').checked,
        progressive: document.getElementById('opt-progressive').checked,
        preserveIcc: document.getElementById('opt-preserve-icc').checked,
        preserveMetadata: document.getElementById('opt-preserve-metadata').checked,
        chunked: document.getElementById('opt-chunked').checked,
        lossless: document.getElementById('opt-lossless').checked,
        previewFirst: document.getElementById('opt-preview-first').checked,
        skipCopy: document.getElementById('opt-skip-copy').checked,
        modular: document.getElementById('opt-modular').checked,
        butteraugliTarget: Number(document.getElementById('butteraugli-target').value),
        brotliEffort: Number(document.getElementById('brotli-effort').value),
        downsample: downsample ? Number(downsample.value) : 1,
    };
}

function resolvedTierLabel(simd, threading) {
    if (!simd) return 'scalar';
    if (!threading) return 'simd';
    return detectTier(); // auto — use best available
}

function updateTierFromToggles() {
    const simd = document.getElementById('opt-simd').checked;
    const threading = document.getElementById('opt-threading').checked;
    const tier = !simd ? 'scalar' : !threading ? 'simd' : null; // null = auto
    setForcedTier(tier);
    const label = resolvedTierLabel(simd, threading);
    const el = document.getElementById('tier-display');
    if (el) el.textContent = label;
}

// Initialize wasm
initRaw().then(async () => {
    if (typeof rawWasm.initThreadPool === 'function') {
        await rawWasm.initThreadPool(navigator.hardwareConcurrency);
    }
    wasmReady = true;
    dbgLog('WASM module initialized');
}).catch(err => {
    dbgLog('Failed to init WASM:', err.message);
});

// UI Setup
// Use unified file picker with memory
const filePicker = createFilePicker({
    input: sourceInput,
    dropZone: sourceDrop,
    multiple: true,
    accept: '.orf,.ORF,.jpg,.jpeg,.png,.tif,.tiff,.jxl,image/*',
    persistKey: 'jxl-benchmark-last-files',
    onFiles: (files) => {
        loadFiles(files);
        updateButtonStates();
    }
});

// Try to restore last session files
filePicker?.loadLastPersisted?.().then(files => {
    if (files?.length) {
        loadFiles(files);
        updateButtonStates();
    }
}).catch(() => {});

if (sourceDrop) {
    sourceDrop.addEventListener('drop', handleFileDrop);
    sourceDrop.addEventListener('dragover', e => e.preventDefault());
    sourceDrop.addEventListener('dragend', e => e.preventDefault());
} else console.error('sourceDrop missing');

if (loadRandomBtn) {
    loadRandomBtn.addEventListener('click', e => {
        console.log('Random button clicked');
        loadRandomImages();
    });
} else console.error('loadRandomBtn missing');

if (startBenchmarkBtn) {
    startBenchmarkBtn.addEventListener('click', e => {
        console.log('Benchmark button clicked');
        runBenchmark();
    });
} else console.error('startBenchmarkBtn missing');

if (clearResultsBtn) {
    clearResultsBtn.addEventListener('click', e => {
        console.log('Clear button clicked');
        clearResults();
    });
} else console.error('clearResultsBtn missing');

const addPermBtn = document.getElementById('add-permutation');
if (addPermBtn) {
    addPermBtn.addEventListener('click', () => addPermutation());
} else console.error('add-permutation btn missing');

const optimizeBtn = document.getElementById('optimize-btn');
if (optimizeBtn) {
    optimizeBtn.addEventListener('click', () => runOptimizer());
}

const saveFullBtn = document.getElementById('save-full-btn');
if (saveFullBtn) {
    saveFullBtn.addEventListener('click', () => saveFullFiles());
}

const saveSettingsBtn = document.getElementById('save-settings');
const loadSettingsInput = document.getElementById('load-settings-input');

if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', e => {
        console.log('Save settings clicked');
        saveSettings();
    });
}

if (loadSettingsInput) {
    loadSettingsInput.addEventListener('change', e => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const settings = JSON.parse(ev.target.result);
                    loadSettings(settings);
                } catch (err) {
                    console.error('Failed to parse settings file:', err);
                    dbgLog('Failed to parse settings file', '', 'error');
                }
            };
            reader.readAsText(file);
        }
    });
}

// Cancel button wiring
if (cancelBenchmarkBtn) {
    cancelBenchmarkBtn.addEventListener('click', () => {
        if (!isRunning) return;
        // Force cancel by advancing the id — existing run loop checks this on every iter
        activeBenchmarkId++;
        setRunningState(false);
        setProgress('Cancelled by user.');
        dbgLog('⏹ Benchmark cancelled by user', '', 'warn');
    });
} else {
    console.error('cancel-benchmark btn missing');
}

// Export full results JSON
if (exportResultsJsonBtn) {
    exportResultsJsonBtn.addEventListener('click', () => {
        exportFullResultsJson();
    });
}

let optimizerRunning = false;

function hasAnyEncodedBytes() {
    return !!(benchmarkResults.encodedBytes && benchmarkResults.encodedBytes.size > 0);
}

function hasFullsizeBytes() {
    if (!benchmarkResults.encodedBytes) return false;
    for (const key of benchmarkResults.encodedBytes.keys()) {
        if (key.includes(':fullsize')) return true;
    }
    return false;
}

function updateSaveFullBtn() {
    const btn = document.getElementById('save-full-btn');
    if (!btn) return;
    const hasAny = hasAnyEncodedBytes();
    const hasFull = hasFullsizeBytes();
    btn.disabled = !hasAny;
    if (!hasAny) {
        btn.title = 'Run benchmark first to encode JXL files';
    } else if (hasFull) {
        btn.title = 'Save all fullsize encoded JXL files to a folder';
    } else {
        btn.title = 'Save encoded JXL files to a folder (no fullsize benchmarked — saves all available sizes)';
    }
}

function updateSelectionStatus() {
    const ready = selectedSources.length > 0;
    selectionStatus.textContent = ready
        ? `${selectedSources.length} file${selectedSources.length !== 1 ? 's' : ''} ready.`
        : 'No files.';
    startBenchmarkBtn.disabled = !ready || isRunning;
    startBenchmarkBtn.title = ready ? '' : 'Press Random Gobabeb first';
    clearResultsBtn.disabled = !ready || isRunning;
    clearResultsBtn.title = ready ? '' : 'Load files first';
    const optBtn = document.getElementById('optimize-btn');
    if (optBtn && !optimizerRunning) {
        optBtn.disabled = !ready || isRunning;
        optBtn.title = ready ? 'Auto-optimize codec toggles for this device' : 'Load files first, then optimize codec toggles for this device';
    }
    updateSaveFullBtn();
}

function setRunningState(running) {
    isRunning = running;
    if (cancelBenchmarkBtn) {
        cancelBenchmarkBtn.style.display = running ? '' : 'none';
        cancelBenchmarkBtn.disabled = !running;
    }
    // Lock primary controls while running
    if (startBenchmarkBtn) startBenchmarkBtn.disabled = running || (selectedSources.length === 0);
    if (loadRandomBtn) loadRandomBtn.disabled = running;
    if (clearResultsBtn) clearResultsBtn.disabled = running || (selectedSources.length === 0);
    const addBtn = document.getElementById('add-permutation');
    if (addBtn) addBtn.disabled = running || (benchmarkResults.decodeMs.size === 0 && permutations.length === 0);
    const optBtn = document.getElementById('optimize-btn');
    if (optBtn) optBtn.disabled = running || (selectedSources.length === 0);
    updateSaveFullBtn();
}

// Back-compat shim for existing calls (file picker, addPerm) — prevents silent runtime errors on button state updates
function updateButtonStates() {
    updateSelectionStatus();
}

function setProgress(text) {
    progressStatus.textContent = text;
}

function setFileStatus(text) {
    fileStatus.textContent = text;
}

function setTiming(text) {
    timingStatus.textContent = text;
}

/** Yield to the browser event loop so status text in the header actually paints before the next heavy WASM batch. */
async function yieldForPaint() {
    await new Promise(r => requestAnimationFrame(r));
}

function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);
    loadFiles(files);
}

function handleFileDrop(e) {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files || []);
    loadFiles(files);
}

async function loadFiles(files) {
    const maxFiles = Number(maxFilesInput.value);
    const limited = files.slice(0, maxFiles);
    selectedSources = [];
    setProgress('Loading files...');
    setFileStatus('—');
    setTiming('Loading…');
    updateSelectionStatus();
    dbgLog(`Loading ${limited.length} files...`);

    for (let fileIdx = 0; fileIdx < limited.length; fileIdx++) {
        const file = limited[fileIdx];
        setFileStatus(formatLoadFileStatus({
            currentIndex: fileIdx + 1,
            totalCount: limited.length,
            fileName: file.name,
        }));
        try {
            const fileLoadStart = performance.now();
            const arrayBuffer = await file.arrayBuffer();
            const fileLoadMs = performance.now() - fileLoadStart;

            const processStart = performance.now();
            const rgba = await processImageFile(file, arrayBuffer);
            const processMs = performance.now() - processStart;

            if (rgba) {
                selectedSources.push({ file: file.name, ...rgba });
                const fileSizeKB = (file.size / 1024).toFixed(1);
                dbgLog(`✓ ${file.name}`, `${rgba.width}×${rgba.height} | load ${fileLoadMs.toFixed(1)}ms + decode ${processMs.toFixed(1)}ms | ${fileSizeKB} KB`);
            } else {
                dbgLog(`✗ Failed to process: ${file.name}`);
            }
        } catch (err) {
            dbgLog(`✗ Error loading ${file.name}: ${err.message}`);
        }

        updateSelectionStatus();
        setProgress(formatLoadProgress({
            loadedCount: selectedSources.length,
            totalCount: limited.length,
        }));
    }

    updateSelectionStatus();
    setProgress(selectedSources.length ? 'Files loaded.' : 'No files loaded.');
    setFileStatus(selectedSources.length ? `Loaded ${selectedSources.length}/${limited.length} files.` : '—');
    setTiming('Ready.');
    dbgLog(`Loaded ${selectedSources.length}/${limited.length} images`);
}

async function processImageFile(file, arrayBuffer) {
    const name = file.name.toLowerCase();
    const type = file.type;

    try {
        if (name.match(/\.(orf|raw)$/i)) {
            if (!wasmReady) {
                dbgLog('WASM not ready');
                console.error('WASM not ready');
                return null;
            }
            console.log('Processing ORF:', name, 'bytes:', arrayBuffer.byteLength);
            const result = process_orf(new Uint8Array(arrayBuffer), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
            try {
                const pixels = result.take_rgb();
                console.log(`Converted: ${result.width}×${result.height}`);
                return {
                    pixels,
                    format: 'rgb8',
                    width: result.width,
                    height: result.height,
                };
            } finally {
                result.free();
            }
        } else if (type.startsWith('image/') || name.match(/\.(jpg|jpeg|png|webp|jxl)$/i)) {
            console.log('Processing as image:', name, type);
            const blob = new Blob([arrayBuffer], { type: type || 'application/octet-stream' });
            const bitmap = await createImageBitmap(blob);
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0);
            const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
            const d = imageData.data;
            const pixels = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
            return {
                pixels,
                format: 'rgba8',
                width: bitmap.width,
                height: bitmap.height,
            };
        } else {
            dbgLog(`✗ Unknown file type: ${name} (${type})`);
            console.error('Unknown file type:', name, type);
        }
    } catch (err) {
        dbgLog(`✗ Process: ${err.message}`);
        console.error('processImageFile error:', err);
    }
    return null;
}

async function loadRandomImages() {
    const maxFiles = Number(maxFilesInput.value);
    selectedSources = [];

    if (!wasmReady) {
        setProgress('WASM not ready — wait a moment and try again.');
        dbgLog('✗ loadRandomImages: WASM not ready');
        return;
    }

    loadRandomBtn.disabled = true;
    loadRandomBtn.textContent = 'Loading…';
    setProgress('Loading random Gobabeb images...');
    dbgLog('Loading random images...');

    let lastError = null;

    try {
        for (let i = 0; i < maxFiles; i++) {
            const tentativeName = `random-${i}.orf`;
            setFileStatus(formatLoadFileStatus({
                currentIndex: i + 1,
                totalCount: maxFiles,
                fileName: tentativeName,
            }));
            try {
                const fetchStart = performance.now();
                const resp = await fetch('/api/random-gobabeb');
                const fetchMs = performance.now() - fetchStart;

                if (!resp.ok) {
                    const msg = `API error ${resp.status} (${resp.statusText})`;
                    dbgLog(`✗ ${msg}`);
                    lastError = msg;
                    break;
                }
                const arrayBuffer = await resp.arrayBuffer();
                const fileName = resp.headers.get('X-File-Name') || tentativeName;
                const fileSizeKB = (arrayBuffer.byteLength / 1024).toFixed(1);

                setFileStatus(formatLoadFileStatus({
                    currentIndex: i + 1,
                    totalCount: maxFiles,
                    fileName,
                }));

                const processStart = performance.now();
                const rgba = await processImageFile({ name: fileName, type: 'application/octet-stream' }, arrayBuffer);
                const processMs = performance.now() - processStart;

                if (rgba) {
                    selectedSources.push({ file: fileName, ...rgba });
                    updateSelectionStatus();
                    setProgress(formatLoadProgress({
                        loadedCount: selectedSources.length,
                        totalCount: maxFiles,
                    }));
                    dbgLog(`✓ ${fileName}`, `${rgba.width}×${rgba.height} | fetch ${fetchMs.toFixed(1)}ms + decode ${processMs.toFixed(1)}ms | ${fileSizeKB} KB`);
                } else {
                    lastError = `Processing failed for ${fileName}`;
                    dbgLog(`✗ ${lastError}`);
                }
            } catch (err) {
                lastError = err.message;
                dbgLog(`✗ Error: ${err.message}`);
                console.error('loadRandomImages error:', err);
                break;
            }
        }
    } finally {
        loadRandomBtn.disabled = false;
        loadRandomBtn.textContent = 'Random Gobabeb';
    }

    updateSelectionStatus();
    if (selectedSources.length) {
        setProgress(`Loaded ${selectedSources.length} random file${selectedSources.length !== 1 ? 's' : ''}.`);
    } else {
        setProgress(lastError ? `No files loaded — ${lastError}` : 'No files loaded.');
    }
    dbgLog(`Loaded ${selectedSources.length} random files`);
}

function resizePixels(pixels, width, height, targetWidth, format) {
    if (targetWidth === 'fullsize') return { pixels, width, height };
    const scale = targetWidth / width;
    const targetHeight = Math.round(height * scale);
    if (format === 'rgb8') {
        const fn = rawWasm.downscale_rgb ?? downscaleRgbCanvas;
        return { pixels: fn(pixels, width, height, targetWidth, targetHeight), width: targetWidth, height: targetHeight };
    }
    const fn = rawWasm.downscale_rgba ?? downscaleRgbaCanvas;
    return { pixels: fn(pixels, width, height, targetWidth, targetHeight), width: targetWidth, height: targetHeight };
}

function downscaleRgbCanvas(rgb, width, height, targetWidth, targetHeight) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
        rgba[j] = rgb[i]; rgba[j+1] = rgb[i+1]; rgba[j+2] = rgb[i+2]; rgba[j+3] = 255;
    }
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = width; srcCanvas.height = height;
    srcCanvas.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(rgba, width, height), 0, 0);
    const dstCanvas = document.createElement('canvas');
    dstCanvas.width = targetWidth; dstCanvas.height = targetHeight;
    dstCanvas.getContext('2d', { willReadFrequently: true }).drawImage(srcCanvas, 0, 0, targetWidth, targetHeight);
    const outData = dstCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, targetWidth, targetHeight).data;
    const out = new Uint8Array(targetWidth * targetHeight * 3);
    for (let i = 0, j = 0; i < outData.length; i += 4, j += 3) {
        out[j] = outData[i]; out[j+1] = outData[i+1]; out[j+2] = outData[i+2];
    }
    return out;
}

function downscaleRgbaCanvas(rgba, width, height, targetWidth, targetHeight) {
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = width;
    srcCanvas.height = height;
    const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
    const srcClamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    srcCtx.putImageData(new ImageData(srcClamped, width, height), 0, 0);

    const dstCanvas = document.createElement('canvas');
    dstCanvas.width = targetWidth;
    dstCanvas.height = targetHeight;
    const dstCtx = dstCanvas.getContext('2d', { willReadFrequently: true });
    dstCtx.drawImage(srcCanvas, 0, 0, targetWidth, targetHeight);
    const dstData = dstCtx.getImageData(0, 0, targetWidth, targetHeight).data;
    return new Uint8Array(dstData.buffer, dstData.byteOffset, dstData.byteLength);
}

function exactBuffer(view) {
    if (view instanceof ArrayBuffer) return view;
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function toU8(value) {
    if (value instanceof Uint8Array) return value;
    return new Uint8Array(value);
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

async function encodeJxl(pixels, width, height, quality, effort = null, format = 'rgba8') {
    const started = performance.now();
    let encoder = null;
    try {
        const opts = getAdvancedOptions();
        const encoderConfig = {
            format,
            width,
            height,
            hasAlpha: format !== 'rgb8',
            distance: opts.lossless ? 0 : (opts.butteraugliTarget > 0 ? opts.butteraugliTarget : null),
            quality: opts.lossless ? null : quality,
            effort: effort !== null ? effort : 3,
            progressive: opts.progressive,
            previewFirst: opts.previewFirst,
            chunked: opts.chunked,
            modular: opts.modular,
            brotliEffort: opts.brotliEffort,
            copyInput: !opts.skipCopy,
        };
        encoder = createEncoder(encoderConfig);
        const chunks = [];
        let firstChunkMs = null;
        const chunkTask = (async () => {
            for await (const chunk of encoder.chunks()) {
                if (firstChunkMs === null) firstChunkMs = performance.now() - started;
                chunks.push(chunk);
            }
        })();
        // Zero-copy mode: pass Uint8Array so the copyInput=false path is exercised.
        // Standard mode: pass ArrayBuffer (ownership transfer — no copy either way).
        await encoder.pushPixels(opts.skipCopy ? toU8(pixels) : exactBuffer(pixels));
        await encoder.finish();
        await chunkTask;
        const bytes = concatChunks(chunks);
        const encodeMs = performance.now() - started;
        return { bytes, encodeMs, firstChunkMs: firstChunkMs ?? encodeMs };
    } catch (err) {
        console.error('Encode error:', err);
        throw new Error(`Encode failed: ${err.message}`);
    } finally {
        if (encoder) await encoder.dispose();
    }
}

async function decodeJxl(bytes) {
    const started = performance.now();
    try {
        const opts = getAdvancedOptions();
        const decoder = createDecoder({
            format: 'rgba8',
            region: null,
            downsample: opts.downsample,
            progressionTarget: 'final',
            emitEveryPass: false,
            preserveIcc: opts.preserveIcc,
            preserveMetadata: opts.preserveMetadata,
            copyInput: !opts.skipCopy,
        });
        await decoder.push(opts.skipCopy ? toU8(bytes) : exactBuffer(bytes));
        await decoder.close();
        let final = null;
        for await (const ev of decoder.events()) {
            if (ev.type === 'final') final = ev;
        }
        await decoder.dispose();
        const decodeMs = performance.now() - started;
        if (!final) throw new Error('no final frame');
        return { result: final, decodeMs, success: true };
    } catch (err) {
        console.error('Decode error:', err);
        throw new Error(`Decode failed: ${err.message}`);
    }
}

async function runOptimizer() {
    if (optimizerRunning) return;
    if (!selectedSources.length) { setProgress('Optimizer: load files first.'); return; }
    if (!wasmReady) { setProgress('Optimizer: WASM not ready.'); return; }

    const WARMUP = 2, REPS = 3;
    const OPT_SIZE = 512, OPT_QUALITY = 85, OPT_EFFORT = 3;

    optimizerRunning = true;
    const optBtn = document.getElementById('optimize-btn');
    if (optBtn) { optBtn.disabled = true; optBtn.textContent = 'Optimizing…'; }
    startBenchmarkBtn.disabled = true;

    dbgLog('═══ AUTO-OPTIMIZER START ═══', `${OPT_SIZE}px Q${OPT_QUALITY} E${OPT_EFFORT} × ${WARMUP}warm+${REPS}reps`, 'info');

    try {
        const src = selectedSources[0];
        const resized = await resizePixels(src.pixels, src.width, src.height, OPT_SIZE, src.format);

        // Runs one encode+decode cycle with current toggle state; returns total ms.
        async function oneCycle() {
            const enc = await encodeJxl(resized.pixels, resized.width, resized.height, OPT_QUALITY, OPT_EFFORT, src.format);
            const dec = await decodeJxl(enc.bytes);
            return enc.encodeMs + dec.decodeMs;
        }

        // Sets all four toggles, runs warmup then REPS measured cycles, returns median ms.
        async function probe(simd, threading, progressive, skipCopy) {
            document.getElementById('opt-simd').checked = simd;
            document.getElementById('opt-threading').checked = threading;
            document.getElementById('opt-progressive').checked = progressive;
            document.getElementById('opt-skip-copy').checked = skipCopy;
            updateTierFromToggles();
            for (let i = 0; i < WARMUP; i++) { try { await oneCycle(); } catch { /* absorb module load + errors */ } }
            const times = [];
            for (let i = 0; i < REPS; i++) times.push(await oneCycle());
            times.sort((a, b) => a - b);
            return times[Math.floor(times.length / 2)]; // median
        }

        // Capture current toggle state as baseline
        const cur = {
            simd: document.getElementById('opt-simd').checked,
            threading: document.getElementById('opt-threading').checked,
            progressive: document.getElementById('opt-progressive').checked,
            skipCopy: document.getElementById('opt-skip-copy').checked,
        };

        // Phase 1: tier — test scalar / simd / simd-mt
        setProgress('Optimizer: probing tiers…');
        const tierCombos = [
            { simd: false, threading: false, label: 'scalar' },
            { simd: true,  threading: false, label: 'simd' },
            { simd: true,  threading: true,  label: 'simd-mt' },
        ];
        const tierTimes = {};
        for (const c of tierCombos) {
            try {
                const t = await probe(c.simd, c.threading, cur.progressive, cur.skipCopy);
                tierTimes[c.label] = t;
                dbgLog(`  tier ${c.label}: ${t.toFixed(1)}ms`, '', 'info');
            } catch (err) {
                dbgLog(`  tier ${c.label}: unavailable`, err.message, 'warn');
            }
        }
        let bestTier = tierCombos[0];
        let bestTierMs = Infinity;
        for (const c of tierCombos) {
            if (tierTimes[c.label] !== undefined && tierTimes[c.label] < bestTierMs) {
                bestTierMs = tierTimes[c.label];
                bestTier = c;
            }
        }
        dbgLog(`  → best tier: ${bestTier.label} (${bestTierMs.toFixed(1)}ms)`, '', 'success');

        // Phase 2: progressive — test on/off at best tier
        setProgress('Optimizer: probing progressive…');
        const tProgOff = await probe(bestTier.simd, bestTier.threading, false, cur.skipCopy);
        const tProgOn  = await probe(bestTier.simd, bestTier.threading, true,  cur.skipCopy);
        const bestProg = tProgOn < tProgOff;
        dbgLog(`  progressive: off=${tProgOff.toFixed(1)}ms on=${tProgOn.toFixed(1)}ms → ${bestProg ? 'ON' : 'OFF'}`, '', 'info');

        // Phase 3: zero-copy — test on/off at best tier + best progressive
        setProgress('Optimizer: probing zero-copy…');
        const tCopyOff = await probe(bestTier.simd, bestTier.threading, bestProg, false);
        const tCopyOn  = await probe(bestTier.simd, bestTier.threading, bestProg, true);
        const bestSkipCopy = tCopyOn < tCopyOff;
        dbgLog(`  zero-copy: off=${tCopyOff.toFixed(1)}ms on=${tCopyOn.toFixed(1)}ms → ${bestSkipCopy ? 'ON' : 'OFF'}`, '', 'info');

        // Apply best settings
        document.getElementById('opt-simd').checked = bestTier.simd;
        document.getElementById('opt-threading').checked = bestTier.threading;
        document.getElementById('opt-progressive').checked = bestProg;
        document.getElementById('opt-skip-copy').checked = bestSkipCopy;
        updateTierFromToggles();

        dbgLog('═══ AUTO-OPTIMIZER DONE ═══', `tier=${bestTier.label} progressive=${bestProg} zero-copy=${bestSkipCopy}`, 'success');
        setProgress(`Optimizer done — ${bestTier.label}, progressive ${bestProg ? 'on' : 'off'}, zero-copy ${bestSkipCopy ? 'on' : 'off'}.`);

    } catch (err) {
        dbgLog('✗ Optimizer failed', err.message, 'error');
        setProgress(`Optimizer failed: ${err.message}`);
    } finally {
        optimizerRunning = false;
        if (optBtn) { optBtn.disabled = false; optBtn.textContent = 'Optimize'; }
        updateSelectionStatus();
    }
}

async function runBenchmark() {
    const benchmarkId = ++activeBenchmarkId;
    if (!selectedSources.length) {
        setProgress('Load files first — use Random Gobabeb or Pick Files.');
        return;
    }

    setRunningState(true);
    updateTierFromToggles();
    const iterations = Number(iterationsInput.value);
    const selectedSizes = getSelectedSizes();
    const selectedQualities = getSelectedQualities();
    const selectedEfforts = getSelectedEfforts();
    console.log('%c[Benchmark] run start', 'color:#3b82f6;font-weight:600', { t: new Date().toISOString(), sources: selectedSources.map(s => s.name ?? s.label ?? '?'), iterations, sizes: selectedSizes, qualities: selectedQualities, efforts: selectedEfforts });

    benchmarkResults = {
        decodeMs: new Map(),
        encodeMs: new Map(),
        resizeMs: new Map(),
        firstChunkMs: new Map(),
        totalMs: new Map(),
        fileSize: new Map(),
        encodedBytes: new Map(), // key: `${filename}:${size}x${quality}xe${effort}` → Uint8Array
    };

    const totalSteps = selectedSources.length * selectedSizes.length * selectedQualities.length * selectedEfforts.length * iterations;
    let completedSteps = 0;
    let completedFiles = 0;
    const benchmarkStart = performance.now();

    // Capture system info
    const sysInfo = getSystemInfo();
    const memBefore = getMemoryInfo();
    const advOpts = getAdvancedOptions();

    setProgress('Running benchmark...');
    dbgLog(`═══════════════════════════════════════`, '', 'info');
    dbgLog(`SYSTEM INFO`, '', 'info');
    dbgLog(`  Browser: ${sysInfo.browser} ${sysInfo.browserVersion}`, `Platform: ${sysInfo.platform}`, 'info');
    dbgLog(`  CPU cores: ${sysInfo.cpuCores}`, `Device memory: ${sysInfo.deviceMemory} GB`, 'info');
    dbgLog(`  Screen: ${sysInfo.screen}`, '', 'info');
    if (memBefore) {
        dbgLog(`  Heap before: ${memBefore.usedJSHeapSize} MB / ${memBefore.totalJSHeapSize} MB`, `Limit: ${memBefore.jsHeapSizeLimit} MB`, 'info');
    }
    dbgLog(`ENCODER OPTIONS`, '', 'info');
    dbgLog(`  Lossless: ${advOpts.lossless}`, `Modular: ${advOpts.modular}`, 'info');
    dbgLog(`  Progressive: ${advOpts.progressive}`, `Chunked: ${advOpts.chunked}`, 'info');
    dbgLog(`  Preview 1st: ${advOpts.previewFirst}`, `Butteraugli: ${advOpts.butteraugliTarget}`, 'info');
    dbgLog(`  Brotli effort: ${advOpts.brotliEffort}`, '', 'info');
    dbgLog(`DECODER OPTIONS`, '', 'info');
    dbgLog(`  Preserve ICC: ${advOpts.preserveIcc}`, `Preserve Metadata: ${advOpts.preserveMetadata}`, 'info');
    dbgLog(`  Downsampling: ${advOpts.downsample}×`, '', 'info');
    dbgLog(`OPTIMIZATION TOGGLES`, '', 'info');
    dbgLog(`  SIMD: ${advOpts.simd}`, `Threading: ${advOpts.threading}`, 'info');
    dbgLog(`  Progressive: ${advOpts.progressive}`, `Zero-copy: ${advOpts.skipCopy}`, 'info');
    dbgLog(`═══════════════════════════════════════`, '', 'info');
    dbgLog(`BENCHMARK START`, `${selectedSources.length} files × ${selectedSizes.length} sizes × ${selectedQualities.length} qualities × ${selectedEfforts.length} efforts × ${iterations} iter = ${totalSteps} ops`, 'info');
    dbgLog(`Sizes: ${selectedSizes.join(', ')} px`, `Qualities: ${selectedQualities.join(', ')}`, 'info');
    dbgLog(`Efforts: ${selectedEfforts.join(', ')}`, '', 'info');
    dbgLog(`═══════════════════════════════════════`, '', 'info');

    for (let fileIdx = 0; fileIdx < selectedSources.length; fileIdx++) {
        if (benchmarkId !== activeBenchmarkId) {
            setRunningState(false);
            return;
        }

        const source = selectedSources[fileIdx];
        const fileStart = performance.now();
        setFileStatus(formatBenchmarkFileStatus({
            completedFiles,
            totalFiles: selectedSources.length,
            fileName: source.file,
        }));
        // Force a main progress line update at the *start* of each new image so the UI visibly advances "between images"
        const startPercent = Math.round((completedSteps / totalSteps) * 100);
        setProgress(formatBenchmarkProgress({
            percent: startPercent,
            size: selectedSizes[0] ?? 512,
            quality: selectedQualities[0] ?? 85,
            effort: selectedEfforts[0] ?? 3,
            completedFiles,
            totalFiles: selectedSources.length,
        }));
        await yieldForPaint();
        dbgLog(`\n📄 FILE ${fileIdx + 1}/${selectedSources.length}`, source.file, 'info');

        for (const size of selectedSizes) {
            for (const quality of selectedQualities) {
                for (const effort of selectedEfforts) {
                    for (let iter = 0; iter < iterations; iter++) {
                        if (benchmarkId !== activeBenchmarkId) {
                            dbgLog('❌ BENCHMARK CANCELLED');
                            setRunningState(false);
                            return;
                        }

                        const opStart = performance.now();
                        const key = `${size}x${quality}xe${effort}`;

                    try {
                        // Resize
                        const resizeStart = performance.now();
                        const resized = await resizePixels(source.pixels, source.width, source.height, size, source.format);
                        const resizeMs = performance.now() - resizeStart;

                        // Encode
                        const encStart = performance.now();
                        const encResult = await encodeJxl(resized.pixels, resized.width, resized.height, quality, effort, source.format);
                        const encMs = encResult.encodeMs;

                        recordTiming(benchmarkResults.resizeMs, key, resizeMs);
                        recordTiming(benchmarkResults.encodeMs, key, encMs);
                        recordTiming(benchmarkResults.firstChunkMs, key, encResult.firstChunkMs);
                        benchmarkResults.fileSize.set(key, encResult.bytes.length);
                        // Store encoded bytes for download (last iteration per file/config wins)
                        benchmarkResults.encodedBytes.set(`${source.file}:${key}`, encResult.bytes);

                        // Decode
                        const decResult = await decodeJxl(encResult.bytes);
                        const decMs = decResult.decodeMs;

                        if (decResult.success) {
                            recordTiming(benchmarkResults.decodeMs, key, decMs);
                        } else {
                            throw new Error('Decode failed');
                        }
                        const totalMs = resizeMs + encMs + decMs;
                        recordTiming(benchmarkResults.totalMs, key, totalMs);

                        completedSteps++;
                        const percent = Math.round((completedSteps / totalSteps) * 100);
                        const fileSizeKB = (encResult.bytes.length / 1024).toFixed(1);

                        dbgLog(
                            `  ${size}px Q${quality} E${effort} i${iter + 1}`,
                            `resize ${resizeMs.toFixed(1)}ms | enc ${encMs.toFixed(1)}ms | first ${encResult.firstChunkMs.toFixed(1)}ms | dec ${decMs.toFixed(1)}ms | total ${totalMs.toFixed(1)}ms | file ${fileSizeKB}KB | ${percent}%`,
                            'success'
                        );

                        if (performance.now() - lastProgressStatusAt > STATUS_UPDATE_INTERVAL_MS) {
                            setProgress(formatBenchmarkProgress({
                                percent,
                                size,
                                quality,
                                effort,
                                completedFiles,
                                totalFiles: selectedSources.length,
                            }));
                            setTiming(`resize ${resizeMs.toFixed(1)} ms · enc ${encMs.toFixed(1)} ms · first ${encResult.firstChunkMs.toFixed(1)} ms · dec ${decMs.toFixed(1)} ms · total ${totalMs.toFixed(1)} ms`);
                            lastProgressStatusAt = performance.now();
                        }
                    } catch (err) {
                        dbgLog(
                            `  ❌ ${size}px Q${quality} E${effort} i${iter + 1}`,
                            `ERROR: ${err.message}`,
                            'error'
                        );
                    }
                }
            }
            }
        }

        completedFiles++;
        setFileStatus(formatBenchmarkFileStatus({
            completedFiles,
            totalFiles: selectedSources.length,
            fileName: source.file,
        }));
        const fileElapsed = ((performance.now() - fileStart) / 1000).toFixed(1);
        dbgLog(`  ✓ File done in ${fileElapsed}s`, '', 'success');

        // Unconditionally update the main progress header when a whole image finishes.
        // This guarantees visible progress "between images" even if the inner 120ms throttle never fired
        // for this file's last steps. Then yield so the browser paints before starting the next image.
        const fileDonePercent = Math.round((completedSteps / totalSteps) * 100);
        setProgress(formatBenchmarkProgress({
            percent: fileDonePercent,
            size: selectedSizes[0] ?? 512,
            quality: selectedQualities[0] ?? 85,
            effort: selectedEfforts[0] ?? 3,
            completedFiles,
            totalFiles: selectedSources.length,
        }));
        setTiming(`File ${completedFiles}/${selectedSources.length} done in ${fileElapsed}s`);
        await yieldForPaint();
    }

    const totalTime = ((performance.now() - benchmarkStart) / 1000).toFixed(1);
    const memAfter = getMemoryInfo();

    setProgress('Benchmark complete.');
    setTiming(`${totalTime}s`);
    dbgLog(`═══════════════════════════════════════`, '', 'info');
    dbgLog(`✓ BENCHMARK COMPLETE`, `Total: ${totalTime}s`, 'success');
    if (memBefore && memAfter) {
        const heapDelta = memAfter.usedJSHeapSize - memBefore.usedJSHeapSize;
        const deltaSym = heapDelta > 0 ? '+' : '';
        dbgLog(`  Heap after: ${memAfter.usedJSHeapSize} MB / ${memAfter.totalJSHeapSize} MB`, `Δ ${deltaSym}${heapDelta} MB`, heapDelta > 50 ? 'warn' : 'info');
    }
    dbgLog(`═══════════════════════════════════════`, '', 'info');

    if (addPermutationMode) {
        const opts = getAdvancedOptions();
        const id = permutations.length + 1;
        permutations.push({
            id,
            label: makePermLabel(opts, id),
            color: PERM_COLORS[(id - 1) % PERM_COLORS.length],
            visible: true,
            results: snapshotResults(),
        });
        renderPermutationSelector();
        const btn = document.getElementById('add-permutation');
        if (btn) btn.disabled = true;
    } else {
        const btn = document.getElementById('add-permutation');
        if (btn) btn.disabled = false;
    }

    updateSaveFullBtn(); // call here too — displayResults/drawGraphs may throw
    displayResults();
    setRunningState(false);
}

function getAverageTiming(timings) {
    if (!timings || !timings.length) return 0;
    const sum = timings.reduce((a, b) => a + b, 0);
    return (sum / timings.length).toFixed(2);
}

function recordTiming(map, key, value) {
    if (!Number.isFinite(value)) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
}

function detailTimingLine(label, values) {
    return `<span class="detail-inline-label">${label}:</span> <span class="detail-inline-value">${values.join(' · ')}</span>`;
}

function displayResults() {
    const selectedSizes = getSelectedSizes();
    const selectedQualities = getSelectedQualities();
    const selectedEfforts = getSelectedEfforts();
    const decodeSummary = document.getElementById('decode-summary-body');
    decodeSummary.innerHTML = '';

    for (const size of selectedSizes) {
        for (const quality of selectedQualities) {
            for (const effort of selectedEfforts) {
                const row = document.createElement('tr');
                const key = `${size}x${quality}xe${effort}`;
                const decodeMs = getAverageTiming(benchmarkResults.decodeMs.get(key));
                const resizeMs = getAverageTiming(benchmarkResults.resizeMs.get(key));
                const totalMs = getAverageTiming(benchmarkResults.totalMs.get(key));
                const note = size === 128 || size === 256 ? 'Thumb' : size === 512 ? 'Med' : size === 1080 ? 'Preview' : '';
                row.innerHTML = `<td>${size === 'fullsize' ? 'Full' : size + 'px'} Q${quality} E${effort}</td><td>${decodeMs} ms</td><td>${resizeMs} ms</td><td>${totalMs} ms</td><td>${note}</td>`;
                decodeSummary.appendChild(row);
            }
        }
    }

    const encodeSummary = document.getElementById('encode-summary-body');
    encodeSummary.innerHTML = '';

    for (const size of selectedSizes) {
        for (const quality of selectedQualities) {
            for (const effort of selectedEfforts) {
                const row = document.createElement('tr');
                const key = `${size}x${quality}xe${effort}`;
                const encodeMs = getAverageTiming(benchmarkResults.encodeMs.get(key));
                const firstChunkMs = getAverageTiming(benchmarkResults.firstChunkMs.get(key));
                const totalMs = getAverageTiming(benchmarkResults.totalMs.get(key));
                row.innerHTML = `<td>${size === 'fullsize' ? 'Full' : size + 'px'} Q${quality} E${effort}</td><td>${encodeMs} ms</td><td>${firstChunkMs} ms</td><td>${totalMs} ms</td><td></td>`;
                encodeSummary.appendChild(row);
            }
        }
    }

    const fileSize = document.getElementById('file-size-body');
    fileSize.innerHTML = '';

    for (const size of selectedSizes) {
        for (const quality of selectedQualities) {
            for (const effort of selectedEfforts) {
                const row = document.createElement('tr');
                const key = `${size}x${quality}xe${effort}`;
                const fileSizeBytes = benchmarkResults.fileSize.get(key) || 0;
                const sizeKB = (fileSizeBytes / 1024).toFixed(1);
                const configLabel = `${size === 'fullsize' ? 'Full' : size + 'px'} Q${quality} E${effort}`;

                // Build per-source download links for this config
                const dlCell = document.createElement('td');
                const configKey = key; // capture for closure

                // "Download set" button — saves all files for this config to a folder
                const dlSetBtn = document.createElement('button');
                dlSetBtn.type = 'button';
                dlSetBtn.className = 'ghost-btn';
                dlSetBtn.style.cssText = 'display:block;font-size:11px;margin-bottom:4px;';
                dlSetBtn.textContent = '⬇ Download set';
                dlSetBtn.addEventListener('click', () => {
                    const entries = collectEncodedSet(`:${configKey}`);
                    saveSetToFolder(entries, configKey);
                });
                dlCell.appendChild(dlSetBtn);

                let hasAny = false;
                for (const src of selectedSources) {
                    const bytes = benchmarkResults.encodedBytes?.get(`${src.file}:${key}`);
                    if (bytes) {
                        hasAny = true;
                        const baseName = String(src.file).replace(/\.[^.]+$/, '');
                        const sizeSuffix = size === 'fullsize' ? 'full' : `${size}px`;
                        const filename = `${baseName}_${sizeSuffix}_q${quality}_e${effort}.jxl`;
                        const a = document.createElement('a');
                        a.href = '#';
                        a.textContent = String(src.file);
                        a.style.cssText = 'display:block;font-size:11px;';
                        a.addEventListener('click', e => {
                            e.preventDefault();
                            triggerJxlDownload(bytes, filename);
                        });
                        dlCell.appendChild(a);
                    }
                }
                if (!hasAny) {
                    dlSetBtn.remove();
                    dlCell.textContent = '—';
                }

                const td0 = document.createElement('td');
                td0.textContent = configLabel;
                const td1 = document.createElement('td');
                td1.textContent = sizeKB;
                row.appendChild(td0);
                row.appendChild(td1);
                row.appendChild(dlCell);
                fileSize.appendChild(row);
            }
        }
    }

    // Clear stale download list (no separate panel needed — links are inline above)
    const dlList = document.getElementById('jxl-download-list');
    if (dlList) dlList.innerHTML = '';

    const encodeDetailBody = document.getElementById('encode-detail-body');
    encodeDetailBody.innerHTML = '';

    for (const size of selectedSizes) {
        for (const quality of selectedQualities) {
            for (const effort of selectedEfforts) {
                const row = document.createElement('div');
                row.className = 'detail-inline-row';
                const key = `${size}x${quality}xe${effort}`;
                const encodeMs = getAverageTiming(benchmarkResults.encodeMs.get(key));
                const firstChunkMs = getAverageTiming(benchmarkResults.firstChunkMs.get(key));
                const totalMs = getAverageTiming(benchmarkResults.totalMs.get(key));
                row.innerHTML = `<span class="detail-inline-key">${size}px Q${quality} E${effort}</span> ${detailTimingLine('Encode', [`avg ${encodeMs} ms`, `first chunk ${firstChunkMs} ms`, `total ${totalMs} ms`])}`;
                encodeDetailBody.appendChild(row);
            }
        }
    }

    const decodeDetailBody = document.getElementById('decode-detail-body');
    decodeDetailBody.innerHTML = '';

    for (const size of selectedSizes) {
        for (const quality of selectedQualities) {
            for (const effort of selectedEfforts) {
                const row = document.createElement('div');
                row.className = 'detail-inline-row';
                const key = `${size}x${quality}xe${effort}`;
                const decodeMs = getAverageTiming(benchmarkResults.decodeMs.get(key));
                const resizeMs = getAverageTiming(benchmarkResults.resizeMs.get(key));
                const totalMs = getAverageTiming(benchmarkResults.totalMs.get(key));
                row.innerHTML = `<span class="detail-inline-key">${size}px Q${quality} E${effort}</span> ${detailTimingLine('Decode', [`avg ${decodeMs} ms`, `resize ${resizeMs} ms`, `total ${totalMs} ms`])}`;
                decodeDetailBody.appendChild(row);
            }
        }
    }

    // Detect thermal degradation (use first quality and effort combination at fullsize)
    if (selectedQualities.length > 0 && selectedEfforts.length > 0) {
        const fullsizeKey = `fullsizex${selectedQualities[0]}xe${selectedEfforts[0]}`;
        const fullsizeDecodeMs = benchmarkResults.decodeMs.get(fullsizeKey) || [];
        const degradation = detectThermalDegradation(fullsizeDecodeMs);
        if (degradation !== null && Math.abs(degradation) > 5) {
            const trend = degradation > 0 ? '⚠️ Slowdown detected' : '✓ Speed improved';
            dbgLog(`${trend}: ${degradation}% change in decode time (thermal throttling likely)`, '', degradation > 0 ? 'warn' : 'success');
        }
    }

    updateSaveFullBtn(); // must be before drawGraphs() — if charts throw, button still updates
    if (exportResultsJsonBtn) exportResultsJsonBtn.disabled = false;
    drawGraphs();
}

function renderPermutationSelector() {
    const bar = document.getElementById('perm-selector-bar');
    if (!bar) return;
    if (permutations.length === 0) {
        bar.hidden = true;
        return;
    }
    bar.hidden = false;
    bar.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'perm-bar-label';
    label.textContent = 'Permutations:';
    bar.appendChild(label);
    for (const perm of permutations) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'perm-pill' + (perm.visible ? ' is-active' : '');
        pill.style.setProperty('--perm-color', perm.color);
        pill.innerHTML = `<span class="perm-pill-dot"></span><span class="perm-pill-label">${perm.label}</span><span class="perm-pill-x" data-id="${perm.id}" title="Remove">×</span>`;
        pill.addEventListener('click', e => {
            if (e.target.classList.contains('perm-pill-x')) {
                permutations = permutations.filter(p => p.id !== perm.id);
                if (permutations.length === 0) { addPermutationMode = false; }
                renderPermutationSelector();
                drawGraphs();
                return;
            }
            perm.visible = !perm.visible;
            renderPermutationSelector();
            drawGraphs();
        });
        bar.appendChild(pill);
    }
}

function clearResults() {
    benchmarkResults = {
        decodeMs: new Map(),
        encodeMs: new Map(),
        resizeMs: new Map(),
        firstChunkMs: new Map(),
        totalMs: new Map(),
        fileSize: new Map(),
        encodedBytes: new Map(),
    };
    permutations = [];
    addPermutationMode = false;
    selectedSources = [];
    resetCharts();
    setGraphExportsEnabled(false);
    setRunningState(false);
    updateSelectionStatus();
    setProgress('Idle.');
    setFileStatus('—');
    setTiming('Ready.');
    renderPermutationSelector();
    if (exportResultsJsonBtn) exportResultsJsonBtn.disabled = true;
    const gc = document.getElementById('graph-caption'); if (gc) gc.textContent = '';
    const addBtn = document.getElementById('add-permutation');
    if (addBtn) addBtn.disabled = true;

    const esb = document.getElementById('encode-summary-body'); if (esb) esb.innerHTML = '<tr><td colspan="5" class="empty-state">Run benchmark.</td></tr>';
    const dsb = document.getElementById('decode-summary-body'); if (dsb) dsb.innerHTML = '<tr><td colspan="5" class="empty-state">Run benchmark.</td></tr>';
    const fsb = document.getElementById('file-size-body'); if (fsb) fsb.innerHTML = '<tr><td colspan="3" class="empty-state">Run benchmark.</td></tr>';
    const edb = document.getElementById('encode-detail-body'); if (edb) edb.innerHTML = '<div class="empty-state">Run benchmark.</div>';
    const ddb = document.getElementById('decode-detail-body'); if (ddb) ddb.innerHTML = '<div class="empty-state">Run benchmark.</div>';
    const dlList = document.getElementById('jxl-download-list');
    if (dlList) dlList.innerHTML = '';

    dbgLog('Cleared');
}

const chartInstances = {
    'decode-latency': null,
    'encode-latency': null,
    'decode-distribution': null,
    'filesize': null,
};

function resetCharts() {
    for (const [chartId, chart] of Object.entries(chartInstances)) {
        chart?.destroy();
        chartInstances[chartId] = null;
        const canvas = document.getElementById(`graph-${chartId}`);
        if (!canvas) continue;
        const ctx = canvas.getContext('2d');
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
}

function hasGraphData(results) {
    return results.decodeMs.size > 0 || results.encodeMs.size > 0 || results.fileSize.size > 0;
}

function setGraphExportsEnabled(enabled) {
    document.querySelectorAll('.export-webp, .export-csv').forEach(btn => {
        btn.disabled = !enabled;
        if (!enabled) {
            btn.title = 'Run benchmark first';
        } else if (btn.classList.contains('export-webp')) {
            btn.title = 'Export as WebP';
        } else {
            btn.title = 'Export as CSV';
        }
    });
}

function getPermSources() {
    const visible = permutations.filter(p => p.visible);
    if (visible.length > 0) return visible;
    return [{ label: null, color: null, results: benchmarkResults }];
}

function drawGraphs() {
    const selectedSizes = getSelectedSizes();
    const selectedQualities = getSelectedQualities();
    const selectedEfforts = getSelectedEfforts();
    if (!selectedSizes.length) return;

    const captionEl = document.getElementById('graph-caption');
    const sources = getPermSources();
    const hasData = sources.some(src => hasGraphData(src.results));
    setGraphExportsEnabled(hasData);
    if (!hasData) {
        resetCharts();
        captionEl.textContent = '';
        return;
    }

    if (permutations.length > 0) {
        captionEl.textContent = permutations.map(p => `${p.label}: ${p.visible ? 'visible' : 'hidden'}`).join(' | ');
    } else {
        const advOpts = getAdvancedOptions();
        captionEl.textContent = `Enc: Lossless=${advOpts.lossless} Modular=${advOpts.modular} Progressive=${advOpts.progressive} Chunked=${advOpts.chunked} PreviewFirst=${advOpts.previewFirst} Butteraugli=${advOpts.butteraugliTarget} BrotliEffort=${advOpts.brotliEffort} | Dec: ICC=${advOpts.preserveIcc} Metadata=${advOpts.preserveMetadata} Downsample=${advOpts.downsample}× | Platform: SIMD=${advOpts.simd} Threading=${advOpts.threading}`;
    }

    drawEncodeLatencyGraph(selectedSizes, selectedQualities, selectedEfforts);
    drawDecodeLatencyGraph(selectedSizes, selectedQualities, selectedEfforts);
    drawDecodeDistributionGraph(selectedSizes, selectedQualities, selectedEfforts);
    drawFileSizeGraph(selectedSizes, selectedQualities, selectedEfforts);
}

function drawDecodeLatencyGraph(selectedSizes, selectedQualities, selectedEfforts) {
    const canvas = document.getElementById('graph-decode-latency');
    if (!canvas) return;
    if (chartInstances['decode-latency']) chartInstances['decode-latency'].destroy();

    const sizeLabels = selectedSizes.map(s => s === 'fullsize' ? 'Full' : `${s}px`);
    const sources = getPermSources();
    const multiPerm = sources.length > 1 || sources[0].label !== null;
    const datasets = [];
    const dashPatterns = [[],[5,3],[2,3],[8,3,2,3]];
    let dsIdx = 0;

    for (const src of sources) {
        for (const quality of selectedQualities) {
            for (const effort of selectedEfforts) {
                const color = src.color || '#0f766e';
                const data = selectedSizes.map(s => Number(getAverageTiming(src.results.decodeMs.get(`${s}x${quality}xe${effort}`))));
                const suffix = selectedQualities.length > 1 || selectedEfforts.length > 1 ? ` Q${quality} E${effort}` : '';
                datasets.push({
                    label: multiPerm ? `${src.label}${suffix}` : `Q${quality} E${effort}`,
                    data,
                    borderColor: color,
                    backgroundColor: color + '20',
                    borderDash: dashPatterns[dsIdx % dashPatterns.length],
                    tension: 0.3,
                    fill: false,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                });
                dsIdx++;
            }
        }
    }

    chartInstances['decode-latency'] = new Chart(canvas, {
        type: 'line',
        data: { labels: sizeLabels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' },
                tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(1) + 'ms' } }
            },
            scales: {
                y: { title: { display: true, text: 'Decode time (ms)' }, beginAtZero: true }
            }
        }
    });
}

function drawEncodeLatencyGraph(selectedSizes, selectedQualities, selectedEfforts) {
    const canvas = document.getElementById('graph-encode-latency');
    if (!canvas) return;
    if (chartInstances['encode-latency']) chartInstances['encode-latency'].destroy();

    const sizeLabels = selectedSizes.map(s => s === 'fullsize' ? 'Full' : `${s}px`);
    const sources = getPermSources();
    const multiPerm = sources.length > 1 || sources[0].label !== null;
    const datasets = [];
    const dashPatterns = [[],[5,3],[2,3],[8,3,2,3]];
    let dsIdx = 0;

    for (const src of sources) {
        for (const quality of selectedQualities) {
            for (const effort of selectedEfforts) {
                const color = src.color || '#ca8a04';
                const data = selectedSizes.map(s => Number(getAverageTiming(src.results.encodeMs.get(`${s}x${quality}xe${effort}`))));
                const suffix = selectedQualities.length > 1 || selectedEfforts.length > 1 ? ` Q${quality} E${effort}` : '';
                datasets.push({
                    label: multiPerm ? `${src.label}${suffix}` : `Q${quality} E${effort}`,
                    data,
                    borderColor: color,
                    backgroundColor: color + '20',
                    borderDash: dashPatterns[dsIdx % dashPatterns.length],
                    tension: 0.3,
                    fill: false,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                });
                dsIdx++;
            }
        }
    }

    chartInstances['encode-latency'] = new Chart(canvas, {
        type: 'line',
        data: { labels: sizeLabels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' },
                tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(1) + 'ms' } }
            },
            scales: {
                y: { title: { display: true, text: 'Encode time (ms)' }, beginAtZero: true }
            }
        }
    });
}

function drawDecodeDistributionGraph(selectedSizes, selectedQualities, selectedEfforts) {
    const canvas = document.getElementById('graph-decode-distribution');
    if (!canvas) return;
    if (chartInstances['decode-distribution']) chartInstances['decode-distribution'].destroy();

    const sizeLabels = selectedSizes.map(s => s === 'fullsize' ? 'Full' : `${s}px`);
    const sources = getPermSources();
    const bubbleDatasets = [];

    for (const src of sources) {
        const color = src.color || '#0f766e';
        const pts = [];
        for (const quality of selectedQualities) {
            for (const effort of selectedEfforts) {
                for (let i = 0; i < selectedSizes.length; i++) {
                    const timings = src.results.decodeMs.get(`${selectedSizes[i]}x${quality}xe${effort}`) || [];
                    timings.forEach(val => pts.push({ x: i + Math.random() * 0.3 - 0.15, y: val, r: 3 }));
                }
            }
        }
        bubbleDatasets.push({
            label: src.label || 'Decode distribution',
            data: pts,
            borderColor: color,
            backgroundColor: color + '40',
        });
    }

    chartInstances['decode-distribution'] = new Chart(canvas, {
        type: 'bubble',
        data: { labels: sizeLabels, datasets: bubbleDatasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' },
                tooltip: { callbacks: { label: ctx => ctx.parsed.y.toFixed(1) + 'ms' } }
            },
            scales: {
                x: {
                    type: 'linear',
                    min: -0.5,
                    max: sizeLabels.length - 0.5,
                    ticks: { callback: value => sizeLabels[Math.round(value)] || '' }
                },
                y: { title: { display: true, text: 'Decode time (ms)' }, beginAtZero: true }
            }
        }
    });
}

function drawFileSizeGraph(selectedSizes, selectedQualities, selectedEfforts) {
    const canvas = document.getElementById('graph-filesize');
    if (!canvas) return;
    if (chartInstances['filesize']) chartInstances['filesize'].destroy();

    const sizeLabels = selectedSizes.map(s => s === 'fullsize' ? 'Full' : `${s}px`);
    const sources = getPermSources();
    const multiPerm = sources.length > 1 || sources[0].label !== null;
    const datasets = [];

    for (const src of sources) {
        for (const quality of selectedQualities) {
            for (const effort of selectedEfforts) {
                const color = src.color || '#0f766e';
                const data = selectedSizes.map(s => (src.results.fileSize.get(`${s}x${quality}xe${effort}`) || 0) / 1024);
                const suffix = selectedQualities.length > 1 || selectedEfforts.length > 1 ? ` Q${quality} E${effort}` : '';
                datasets.push({
                    label: multiPerm ? `${src.label}${suffix}` : `Q${quality} E${effort}`,
                    data,
                    backgroundColor: color + '80',
                    borderColor: color,
                    borderWidth: 1,
                });
            }
        }
    }

    chartInstances['filesize'] = new Chart(canvas, {
        type: 'bar',
        data: { labels: sizeLabels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' },
                tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(1) + ' KB' } }
            },
            scales: {
                y: { title: { display: true, text: 'File size (KB)' }, stacked: false, beginAtZero: true }
            }
        }
    });
}

// Export functions
function exportGraphAsWebP(chartId) {
    const container = document.getElementById(chartId + '-container');
    if (!container) return;

    html2canvas(container, {
        scale: 2,
        backgroundColor: '#ffffff'
    }).then(canvas => {
        canvas.toBlob(blob => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `jxl-benchmark-${chartId}-${new Date().toISOString().split('T')[0]}.webp`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 'image/webp', 0.8);
    });
}

function exportGraphAsCSV(chartId) {
    const chart = chartInstances[chartId];
    if (!chart) return;

    const sysInfo = getSystemInfo();
    const advOpts = getAdvancedOptions();
    const csvRows = [];
    csvRows.push('# JXL Benchmark Export');
    csvRows.push(`# Date: ${new Date().toISOString()}`);
    csvRows.push(`# Browser: ${sysInfo.browser} ${sysInfo.browserVersion}`);
    csvRows.push(`# CPU Cores: ${sysInfo.cpuCores}`);
    csvRows.push(`# Device Memory: ${sysInfo.deviceMemory} GB`);
    csvRows.push(`# SIMD: ${advOpts.simd}, Threading: ${advOpts.threading}, Progressive: ${advOpts.progressive}`);
    csvRows.push(`# ICC: ${advOpts.preserveIcc}, Metadata: ${advOpts.preserveMetadata}, Chunked: ${advOpts.chunked}`);
    csvRows.push('');
    csvRows.push('Size,' + chart.data.datasets.map(ds => ds.label).join(','));

    chart.data.labels.forEach((label, idx) => {
        const row = [label];
        chart.data.datasets.forEach(ds => {
            row.push(ds.data[idx] || '');
        });
        csvRows.push(row.join(','));
    });
    appendTimingBreakdownCsv(csvRows);

    const blob = new Blob([csvRows.join('\n') + '\n'], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jxl-benchmark-${chartId}-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function appendTimingBreakdownCsv(csvRows) {
    const selectedSizes = getSelectedSizes();
    const selectedQualities = getSelectedQualities();
    const selectedEfforts = getSelectedEfforts();
    csvRows.push('');
    csvRows.push('Detailed Timing Breakdown');
    csvRows.push('Config,Resize avg,Encode avg,First chunk avg,Decode avg,Total avg,File size KB');
    for (const size of selectedSizes) {
        for (const quality of selectedQualities) {
            for (const effort of selectedEfforts) {
                const key = `${size}x${quality}xe${effort}`;
                const label = `${size === 'fullsize' ? 'Full' : size + 'px'} Q${quality} E${effort}`;
                const fileSizeKb = ((benchmarkResults.fileSize.get(key) || 0) / 1024).toFixed(1);
                csvRows.push([
                    label,
                    getAverageTiming(benchmarkResults.resizeMs.get(key)),
                    getAverageTiming(benchmarkResults.encodeMs.get(key)),
                    getAverageTiming(benchmarkResults.firstChunkMs.get(key)),
                    getAverageTiming(benchmarkResults.decodeMs.get(key)),
                    getAverageTiming(benchmarkResults.totalMs.get(key)),
                    fileSizeKb,
                ].join(','));
            }
        }
    }
}

document.querySelectorAll('.results-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        document.querySelectorAll('.results-tab').forEach(t => t.classList.remove('is-active'));
        document.querySelectorAll('.results-panel').forEach(p => p.classList.remove('is-active'));
        tab.classList.add('is-active');
        document.getElementById(tabName)?.classList.add('is-active');
    });
});

// Export button listeners
document.querySelectorAll('.export-webp').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const chartId = btn.dataset.chart;
        exportGraphAsWebP(chartId);
    });
});

document.querySelectorAll('.export-csv').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const chartId = btn.dataset.chart;
        exportGraphAsCSV(chartId);
    });
});

// Copy active results table as Markdown (extremely useful for posting in PRs/issues)
const copyMdBtn = document.getElementById('copy-results-md');
if (copyMdBtn) {
    copyMdBtn.addEventListener('click', async () => {
        const activePanel = document.querySelector('.results-panel.is-active');
        const table = activePanel?.querySelector('table.results-table');
        if (!table) {
            dbgLog('No results table visible to copy', '', 'warn');
            return;
        }
        const md = tableToMarkdown(table);
        try {
            await navigator.clipboard.writeText(md);
            dbgLog('Copied active results table as Markdown', '', 'success');
        } catch (err) {
            // Fallback
            const ta = document.createElement('textarea');
            ta.value = md;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            dbgLog('Copied active results table as Markdown (fallback)', '', 'success');
        }
    });
}

function tableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) return '';

    const lines = [];
    rows.forEach((row, rowIdx) => {
        const cells = Array.from(row.querySelectorAll('th, td')).map(cell =>
            cell.textContent.trim().replace(/\|/g, '\\|')
        );
        lines.push('| ' + cells.join(' | ') + ' |');
        if (rowIdx === 0) {
            // separator after header
            lines.push('| ' + cells.map(() => '---').join(' | ') + ' |');
        }
    });
    return lines.join('\n');
}

setGraphExportsEnabled(false);

dbgLog('Benchmark initialized');
