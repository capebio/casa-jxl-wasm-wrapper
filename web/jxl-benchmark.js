import initRaw, { process_orf, rgb_to_rgba } from '../pkg/raw_converter_wasm.js';
import { createDecoder, createEncoder } from '@casabio/jxl-wasm';
import { bindRangeLabel } from './jxl-dashboard-ui.js';
import { initDebugConsole, dbgLog } from './jxl-debug-console.js';

const ALL_SIZES = [128, 256, 512, 1080, 1920, 'fullsize'];
const DEFAULT_SIZES = [128, 512, 1080];
const QUALITIES = [85, 95];
const EFFORT = 3;
const STATUS_UPDATE_INTERVAL_MS = 120;

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
            if (settings.options.modular !== undefined) document.getElementById('opt-modular').checked = settings.options.modular;
            if (settings.options.butteraugliTarget !== undefined) document.getElementById('butteraugli-target').value = settings.options.butteraugliTarget;
            if (settings.options.brotliEffort !== undefined) document.getElementById('brotli-effort').value = settings.options.brotliEffort;
            if (settings.options.downsample !== undefined) {
                const downsampleInput = document.querySelector(`input[name="downsample"][value="${settings.options.downsample}"]`);
                if (downsampleInput) downsampleInput.checked = true;
            }
        }

        dbgLog('Settings loaded');
    } catch (err) {
        dbgLog('Failed to load settings: ' + err.message, '', 'error');
    }
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

let selectedSources = [];
let benchmarkResults = {
    decodeMs: new Map(),
    encodeMs: new Map(),
    fileSize: new Map(),
};
let activeBenchmarkId = 0;
let lastProgressStatusAt = 0;
let wasmReady = false;

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
        modular: document.getElementById('opt-modular').checked,
        butteraugliTarget: Number(document.getElementById('butteraugli-target').value),
        brotliEffort: Number(document.getElementById('brotli-effort').value),
        downsample: downsample ? Number(downsample.value) : 1,
    };
}

// Initialize wasm
initRaw().then(() => {
    wasmReady = true;
    dbgLog('WASM module initialized');
}).catch(err => {
    dbgLog('Failed to init WASM:', err.message);
});

// UI Setup
if (sourceInput) {
    sourceInput.addEventListener('change', e => {
        console.log('File input changed, files:', e.target.files.length);
        handleFileSelect(e);
    });
} else console.error('sourceInput missing');

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

function updateSelectionStatus() {
    const ready = selectedSources.length > 0;
    selectionStatus.textContent = ready
        ? `${selectedSources.length} file${selectedSources.length !== 1 ? 's' : ''} ready.`
        : 'No files.';
    startBenchmarkBtn.disabled = !ready;
    if (ready) {
        startBenchmarkBtn.title = '';
    } else {
        startBenchmarkBtn.title = 'Press Random Gobabeb first';
    }
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
    dbgLog(`Loading ${limited.length} files...`);

    for (const file of limited) {
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
    }

    updateSelectionStatus();
    setProgress(selectedSources.length ? 'Files loaded.' : 'No files loaded.');
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
                const rgb = result.take_rgb();
                const rgba = rgb_to_rgba(rgb);
                console.log(`Converted: ${result.width}×${result.height}`);
                return {
                    rgba: new Uint8Array(rgba),
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
            const rgba = new Uint8Array(imageData.data.buffer);
            return {
                rgba,
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
    setProgress('Loading random Gobabeb images...');
    dbgLog('Loading random images...');

    for (let i = 0; i < maxFiles; i++) {
        try {
            const fetchStart = performance.now();
            const resp = await fetch('/api/random-gobabeb');
            const fetchMs = performance.now() - fetchStart;

            if (!resp.ok) {
                dbgLog(`✗ API error: ${resp.status}`);
                break;
            }
            const arrayBuffer = await resp.arrayBuffer();
            const fileName = resp.headers.get('X-File-Name') || `random-${i}.orf`;
            const fileSizeKB = (arrayBuffer.byteLength / 1024).toFixed(1);

            const processStart = performance.now();
            const rgba = await processImageFile({ name: fileName, type: 'application/octet-stream' }, arrayBuffer);
            const processMs = performance.now() - processStart;

            if (rgba) {
                selectedSources.push({ file: fileName, ...rgba });
                dbgLog(`✓ ${fileName}`, `${rgba.width}×${rgba.height} | fetch ${fetchMs.toFixed(1)}ms + decode ${processMs.toFixed(1)}ms | ${fileSizeKB} KB`);
            } else {
                dbgLog(`✗ ${fileName} - processing failed`);
            }
        } catch (err) {
            dbgLog(`✗ Error: ${err.message}`);
            break;
        }
    }

    updateSelectionStatus();
    setProgress(selectedSources.length ? 'Random files loaded.' : 'No files loaded.');
    dbgLog(`Loaded ${selectedSources.length} random files`);
}

async function resizeRgba(rgba, width, height, targetWidth) {
    // Handle fullsize - use original dimensions
    if (targetWidth === 'fullsize') {
        return { rgba, width, height };
    }

    const scale = targetWidth / width;
    const targetHeight = Math.round(height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height), 0, 0);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = targetWidth;
    outCanvas.height = targetHeight;
    const outCtx = outCanvas.getContext('2d');
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = 'high';
    outCtx.drawImage(canvas, 0, 0, width, height, 0, 0, targetWidth, targetHeight);
    return {
        rgba: new Uint8Array(outCtx.getImageData(0, 0, targetWidth, targetHeight).data.buffer),
        width: targetWidth,
        height: targetHeight
    };
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

async function encodeJxl(rgba, width, height, quality, effort = null) {
    const started = performance.now();
    try {
        const opts = getAdvancedOptions();
        const encoderConfig = {
            format: 'rgba8',
            width,
            height,
            hasAlpha: true,
            distance: opts.lossless ? 0 : (opts.butteraugliTarget > 0 ? opts.butteraugliTarget : null),
            quality: opts.lossless ? null : quality,
            effort: effort !== null ? effort : 3,
            progressive: opts.progressive,
            previewFirst: opts.previewFirst,
            chunked: opts.chunked,
            modular: opts.modular,
            brotliEffort: opts.brotliEffort,
        };
        const encoder = createEncoder(encoderConfig);
        const chunks = [];
        const chunkTask = (async () => {
            for await (const chunk of encoder.chunks()) {
                chunks.push(chunk);
            }
        })();
        await encoder.pushPixels(exactBuffer(rgba));
        await encoder.finish();
        await chunkTask;
        const bytes = concatChunks(chunks);
        const encodeMs = performance.now() - started;
        await encoder.dispose();
        return { bytes, encodeMs };
    } catch (err) {
        console.error('Encode error:', err);
        throw new Error(`Encode failed: ${err.message}`);
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
            progressionTarget: opts.progressive ? 'all' : 'final',
            emitEveryPass: opts.progressive,
            preserveIcc: opts.preserveIcc,
            preserveMetadata: opts.preserveMetadata,
        });
        await decoder.push(exactBuffer(bytes));
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

async function runBenchmark() {
    const benchmarkId = ++activeBenchmarkId;
    if (!selectedSources.length) {
        setProgress('Load files first.');
        return;
    }

    const iterations = Number(iterationsInput.value);
    const selectedSizes = getSelectedSizes();
    const selectedQualities = getSelectedQualities();
    const selectedEfforts = getSelectedEfforts();

    benchmarkResults = {
        decodeMs: new Map(),
        encodeMs: new Map(),
        fileSize: new Map(),
    };

    const totalSteps = selectedSources.length * selectedSizes.length * selectedQualities.length * selectedEfforts.length * iterations;
    let completedSteps = 0;
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
    dbgLog(`═══════════════════════════════════════`, '', 'info');
    dbgLog(`BENCHMARK START`, `${selectedSources.length} files × ${selectedSizes.length} sizes × ${selectedQualities.length} qualities × ${selectedEfforts.length} efforts × ${iterations} iter = ${totalSteps} ops`, 'info');
    dbgLog(`Sizes: ${selectedSizes.join(', ')} px`, `Qualities: ${selectedQualities.join(', ')}`, 'info');
    dbgLog(`Efforts: ${selectedEfforts.join(', ')}`, '', 'info');
    dbgLog(`═══════════════════════════════════════`, '', 'info');

    for (let fileIdx = 0; fileIdx < selectedSources.length; fileIdx++) {
        if (benchmarkId !== activeBenchmarkId) return;

        const source = selectedSources[fileIdx];
        const fileStart = performance.now();
        setFileStatus(`${fileIdx + 1}/${selectedSources.length}: ${source.file}`);
        dbgLog(`\n📄 FILE ${fileIdx + 1}/${selectedSources.length}`, source.file, 'info');

        for (const size of selectedSizes) {
            for (const quality of selectedQualities) {
                for (const effort of selectedEfforts) {
                    for (let iter = 0; iter < iterations; iter++) {
                        if (benchmarkId !== activeBenchmarkId) {
                            dbgLog('❌ BENCHMARK CANCELLED');
                            return;
                        }

                        const opStart = performance.now();
                        const key = `${size}x${quality}xe${effort}`;

                    try {
                        // Resize
                        const resizeStart = performance.now();
                        const resized = await resizeRgba(source.rgba, source.width, source.height, size);
                        const resizeMs = performance.now() - resizeStart;

                        // Encode
                        const encStart = performance.now();
                        const encResult = await encodeJxl(resized.rgba, resized.width, resized.height, quality, effort);
                        const encMs = encResult.encodeMs;

                        if (!benchmarkResults.encodeMs.has(key)) {
                            benchmarkResults.encodeMs.set(key, []);
                        }
                        benchmarkResults.encodeMs.get(key).push(encMs);
                        benchmarkResults.fileSize.set(key, encResult.bytes.length);

                        // Decode
                        const decStart = performance.now();
                        const decResult = await decodeJxl(encResult.bytes);
                        const decMs = decResult.decodeMs;

                        if (decResult.success) {
                            if (!benchmarkResults.decodeMs.has(key)) {
                                benchmarkResults.decodeMs.set(key, []);
                            }
                            benchmarkResults.decodeMs.get(key).push(decMs);
                        } else {
                            throw new Error('Decode failed');
                        }

                        completedSteps++;
                        const percent = Math.round((completedSteps / totalSteps) * 100);
                        const fileSizeKB = (encResult.bytes.length / 1024).toFixed(1);

                        dbgLog(
                            `  ${size}px Q${quality} E${effort} i${iter + 1}`,
                            `resize ${resizeMs.toFixed(1)}ms | enc ${encMs.toFixed(1)}ms | dec ${decMs.toFixed(1)}ms | file ${fileSizeKB}KB | ${percent}%`,
                            'success'
                        );

                        if (performance.now() - lastProgressStatusAt > STATUS_UPDATE_INTERVAL_MS) {
                            setProgress(`${percent}% - ${size}px q=${quality} e=${effort} (file ${fileIdx + 1}/${selectedSources.length})`);
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

        const fileElapsed = ((performance.now() - fileStart) / 1000).toFixed(1);
        dbgLog(`  ✓ File done in ${fileElapsed}s`, '', 'success');
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
    displayResults();
}

function getAverageTiming(timings) {
    if (!timings || !timings.length) return 0;
    const sum = timings.reduce((a, b) => a + b, 0);
    return (sum / timings.length).toFixed(2);
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
                const note = size === 128 || size === 256 ? 'Thumb' : size === 512 ? 'Med' : size === 1080 ? 'Preview' : '';

                row.innerHTML = `
                    <td>${size}px Q${quality} E${effort}</td>
                    <td>${decodeMs} ms</td>
                    <td>—</td>
                    <td>—</td>
                    <td>${note}</td>
                `;
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

                row.innerHTML = `
                    <td>${size}px Q${quality} E${effort}</td>
                    <td>${encodeMs} ms</td>
                    <td>—</td>
                    <td>—</td>
                    <td></td>
                `;
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

                row.innerHTML = `
                    <td>${size}px Q${quality} E${effort}</td>
                    <td>${sizeKB}</td>
                    <td>—</td>
                    <td>—</td>
                    <td></td>
                `;
                fileSize.appendChild(row);
            }
        }
    }

    const encodeDetailBody = document.getElementById('encode-detail-body');
    encodeDetailBody.innerHTML = '';

    for (const size of selectedSizes) {
        for (const quality of selectedQualities) {
            for (const effort of selectedEfforts) {
                const card = document.createElement('div');
                card.className = 'detail-card';
                const key = `${size}x${quality}xe${effort}`;
                const encodeMs = getAverageTiming(benchmarkResults.encodeMs.get(key));

                card.innerHTML = `
                    <h3>${size}px Q${quality} E${effort}</h3>
                    <div class="detail-rows">
                        <div class="detail-row">
                            <span class="detail-row-label">Encode:</span>
                            <span class="detail-row-value">${encodeMs} ms</span>
                        </div>
                    </div>
                `;
                encodeDetailBody.appendChild(card);
            }
        }
    }

    const decodeDetailBody = document.getElementById('decode-detail-body');
    decodeDetailBody.innerHTML = '';

    for (const size of selectedSizes) {
        for (const quality of selectedQualities) {
            for (const effort of selectedEfforts) {
                const card = document.createElement('div');
                card.className = 'detail-card';
                const key = `${size}x${quality}xe${effort}`;
                const decodeMs = getAverageTiming(benchmarkResults.decodeMs.get(key));

                card.innerHTML = `
                    <h3>${size}px Q${quality} E${effort}</h3>
                    <div class="detail-rows">
                        <div class="detail-row">
                            <span class="detail-row-label">Decode:</span>
                            <span class="detail-row-value">${decodeMs} ms</span>
                        </div>
                    </div>
                `;
                decodeDetailBody.appendChild(card);
            }
        }
    }

    // Detect thermal degradation (use first quality and effort combination at fullsize)
    const selectedQualities = getSelectedQualities();
    const selectedEfforts = getSelectedEfforts();
    if (selectedQualities.length > 0 && selectedEfforts.length > 0) {
        const fullsizeKey = `fullsizex${selectedQualities[0]}xe${selectedEfforts[0]}`;
        const fullsizeDecodeMs = benchmarkResults.decodeMs.get(fullsizeKey) || [];
        const degradation = detectThermalDegradation(fullsizeDecodeMs);
        if (degradation !== null && Math.abs(degradation) > 5) {
            const trend = degradation > 0 ? '⚠️ Slowdown detected' : '✓ Speed improved';
            dbgLog(`${trend}: ${degradation}% change in decode time (thermal throttling likely)`, '', degradation > 0 ? 'warn' : 'success');
        }
    }

    drawGraphs();
}

function clearResults() {
    benchmarkResults = {
        decodeMs: new Map(),
        encodeMs: new Map(),
        fileSize: new Map(),
    };
    selectedSources = [];
    updateSelectionStatus();
    setProgress('Idle.');
    setFileStatus('—');
    setTiming('Ready.');

    document.getElementById('decode-summary-body').innerHTML = '<tr><td colspan="5" class="empty-state">Run benchmark.</td></tr>';
    document.getElementById('encode-summary-body').innerHTML = '<tr><td colspan="5" class="empty-state">Run benchmark.</td></tr>';
    document.getElementById('file-size-body').innerHTML = '<tr><td colspan="5" class="empty-state">Run benchmark.</td></tr>';
    document.getElementById('decode-detail-body').innerHTML = '<div class="empty-state">Run benchmark.</div>';

    dbgLog('Cleared');
}

const chartInstances = {
    'decode-latency': null,
    'encode-latency': null,
    'decode-distribution': null,
    'filesize': null,
};

function drawGraphs() {
    const selectedSizes = getSelectedSizes();
    const selectedQualities = getSelectedQualities();
    const selectedEfforts = getSelectedEfforts();
    if (!selectedSizes.length) return;

    // Update graph caption
    const advOpts = getAdvancedOptions();
    const caption = `Enc: Lossless=${advOpts.lossless} Modular=${advOpts.modular} Progressive=${advOpts.progressive} Chunked=${advOpts.chunked} PreviewFirst=${advOpts.previewFirst} Butteraugli=${advOpts.butteraugliTarget} BrotliEffort=${advOpts.brotliEffort} | Dec: ICC=${advOpts.preserveIcc} Metadata=${advOpts.preserveMetadata} Downsample=${advOpts.downsample}× | Platform: SIMD=${advOpts.simd} Threading=${advOpts.threading}`;
    document.getElementById('graph-caption').textContent = caption;

    drawDecodeLatencyGraph(selectedSizes, selectedQualities, selectedEfforts);
    drawEncodeLatencyGraph(selectedSizes, selectedQualities, selectedEfforts);
    drawDecodeDistributionGraph(selectedSizes, selectedQualities, selectedEfforts);
    drawFileSizeGraph(selectedSizes, selectedQualities, selectedEfforts);
}

function drawDecodeLatencyGraph(selectedSizes, selectedQualities, selectedEfforts) {
    const canvas = document.getElementById('graph-decode-latency');
    if (!canvas) return;

    if (chartInstances['decode-latency']) {
        chartInstances['decode-latency'].destroy();
    }

    const sizeLabels = selectedSizes.map(s => s === 'fullsize' ? 'Full' : `${s}px`);
    const datasets = [];
    const colors = ['#0f766e', '#16a34a', '#ea580c', '#ca8a04'];
    let colorIdx = 0;

    for (const quality of selectedQualities) {
        for (const effort of selectedEfforts) {
            const data = selectedSizes.map(s => Number(getAverageTiming(benchmarkResults.decodeMs.get(`${s}x${quality}xe${effort}`))));
            datasets.push({
                label: `Q${quality} E${effort}`,
                data: data,
                borderColor: colors[colorIdx % colors.length],
                backgroundColor: colors[colorIdx % colors.length] + '20',
                tension: 0.3,
                fill: false,
                pointRadius: 4,
                pointHoverRadius: 6,
            });
            colorIdx++;
        }
    }

    chartInstances['decode-latency'] = new Chart(canvas, {
        type: 'line',
        data: {
            labels: sizeLabels,
            datasets: datasets,
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return context.dataset.label + ': ' + context.parsed.y.toFixed(1) + 'ms';
                        }
                    }
                }
            },
            scales: {
                y: {
                    title: {
                        display: true,
                        text: 'Time (ms)'
                    },
                    beginAtZero: true,
                }
            }
        }
    });
}

function drawEncodeLatencyGraph(selectedSizes, selectedQualities, selectedEfforts) {
    const canvas = document.getElementById('graph-encode-latency');
    if (!canvas) return;

    if (chartInstances['encode-latency']) {
        chartInstances['encode-latency'].destroy();
    }

    const sizeLabels = selectedSizes.map(s => s === 'fullsize' ? 'Full' : `${s}px`);
    const datasets = [];
    const colors = ['#ca8a04', '#f97316', '#0f766e', '#16a34a'];
    let colorIdx = 0;

    for (const quality of selectedQualities) {
        for (const effort of selectedEfforts) {
            const data = selectedSizes.map(s => Number(getAverageTiming(benchmarkResults.encodeMs.get(`${s}x${quality}xe${effort}`))));
            datasets.push({
                label: `Q${quality} E${effort}`,
                data: data,
                borderColor: colors[colorIdx % colors.length],
                backgroundColor: colors[colorIdx % colors.length] + '20',
                tension: 0.3,
                fill: false,
                pointRadius: 4,
                pointHoverRadius: 6,
            });
            colorIdx++;
        }
    }

    chartInstances['encode-latency'] = new Chart(canvas, {
        type: 'line',
        data: {
            labels: sizeLabels,
            datasets: datasets,
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return context.dataset.label + ': ' + context.parsed.y.toFixed(1) + 'ms';
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                }
            }
        }
    });
}

function drawDecodeDistributionGraph(selectedSizes, selectedQualities, selectedEfforts) {
    const canvas = document.getElementById('graph-decode-distribution');
    if (!canvas) return;

    if (chartInstances['decode-distribution']) {
        chartInstances['decode-distribution'].destroy();
    }

    const sizeLabels = selectedSizes.map(s => s === 'fullsize' ? 'Full' : `${s}px`);
    const datasets = [];
    const colors = ['#0f766e', '#16a34a', '#ea580c', '#ca8a04'];
    let colorIdx = 0;

    // For distribution, show box plots by quality/effort at each size
    for (const quality of selectedQualities) {
        for (const effort of selectedEfforts) {
            const data = selectedSizes.map(s => benchmarkResults.decodeMs.get(`${s}x${quality}xe${effort}`) || []);
            datasets.push({
                label: `Q${quality} E${effort}`,
                data: data.map(v => ({x: sizeLabels[selectedSizes.indexOf(selectedSizes[data.indexOf(v)])], y: v})),
            });
            colorIdx++;
        }
    }

    // Use a simpler bubble chart for distribution
    const allData = [];
    for (const quality of selectedQualities) {
        for (const effort of selectedEfforts) {
            for (let i = 0; i < selectedSizes.length; i++) {
                const size = selectedSizes[i];
                const timings = benchmarkResults.decodeMs.get(`${size}x${quality}xe${effort}`) || [];
                timings.forEach((val, idx) => {
                    allData.push({
                        x: i + Math.random() * 0.3 - 0.15,
                        y: val,
                        r: 3
                    });
                });
            }
        }
    }

    chartInstances['decode-distribution'] = new Chart(canvas, {
        type: 'bubble',
        data: {
            labels: sizeLabels,
            datasets: [{
                label: 'Decode distribution',
                data: allData,
                borderColor: '#0f766e',
                backgroundColor: '#0f766e40',
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return context.parsed.y.toFixed(1) + 'ms';
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    min: -0.5,
                    max: sizeLabels.length - 0.5,
                    ticks: {
                        callback: function(value) {
                            return sizeLabels[Math.round(value)] || '';
                        }
                    }
                },
                y: { beginAtZero: true }
            }
        }
    });
}

function drawFileSizeGraph(selectedSizes, selectedQualities, selectedEfforts) {
    const canvas = document.getElementById('graph-filesize');
    if (!canvas) return;

    if (chartInstances['filesize']) {
        chartInstances['filesize'].destroy();
    }

    const sizeLabels = selectedSizes.map(s => s === 'fullsize' ? 'Full' : `${s}px`);
    const datasets = [];
    const colors = ['#0f766e', '#16a34a', '#ea580c', '#ca8a04'];
    let colorIdx = 0;

    for (const quality of selectedQualities) {
        for (const effort of selectedEfforts) {
            const data = selectedSizes.map(s => (benchmarkResults.fileSize.get(`${s}x${quality}xe${effort}`) || 0) / 1024);
            datasets.push({
                label: `Q${quality} E${effort}`,
                data: data,
                backgroundColor: colors[colorIdx % colors.length] + '80',
                borderColor: colors[colorIdx % colors.length],
                borderWidth: 1,
            });
            colorIdx++;
        }
    }

    chartInstances['filesize'] = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: sizeLabels,
            datasets: datasets,
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return context.dataset.label + ': ' + context.parsed.y.toFixed(1) + ' KB';
                        }
                    }
                }
            },
            scales: {
                y: {
                    stacked: false,
                    beginAtZero: true,
                }
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
    let csv = '# JXL Benchmark Export\n';
    csv += `# Date: ${new Date().toISOString()}\n`;
    csv += `# Browser: ${sysInfo.browser} ${sysInfo.browserVersion}\n`;
    csv += `# CPU Cores: ${sysInfo.cpuCores}\n`;
    csv += `# Device Memory: ${sysInfo.deviceMemory} GB\n`;
    csv += `# SIMD: ${advOpts.simd}, Threading: ${advOpts.threading}, Progressive: ${advOpts.progressive}\n`;
    csv += `# ICC: ${advOpts.preserveIcc}, Metadata: ${advOpts.preserveMetadata}, Chunked: ${advOpts.chunked}\n`;
    csv += '\n';
    csv += 'Size,' + chart.data.datasets.map(ds => ds.label).join(',') + '\n';

    chart.data.labels.forEach((label, idx) => {
        const row = [label];
        chart.data.datasets.forEach(ds => {
            row.push(ds.data[idx] || '');
        });
        csv += row.join(',') + '\n';
    });

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jxl-benchmark-${chartId}-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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

dbgLog('Benchmark initialized');
