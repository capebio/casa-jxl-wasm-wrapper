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
console.log('%c[Crop Benchmark] jxl-crop-benchmark.js loaded — tiled / JXTC region decode benchmark', 'color:#f59e0b;font-weight:600');

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
const tilePxLabel         = document.getElementById('tile-px-label');

function setWasmStatus(text)     { wasmStatusEl.textContent   = text; }
function setStatusProgress(text) { statusProgress.textContent = text; }
function setStatusFile(text)     { statusFile.textContent     = text; }
function setStatusStage(text)    { statusStage.textContent    = text; }
function setStatusFolder(text)   { statusFolder.textContent   = text; }

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
            updateWorkflowState();
        }
    }
});
});

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
async function decodeFullThenCrop(jxlBytes, sourceWidth, sourceHeight, targetSize) {
    const half = Math.floor(targetSize / 2);
    const cx   = Math.floor(sourceWidth  / 2);
    const cy   = Math.floor(sourceHeight / 2);
    const x    = Math.max(0, cx - half);
    const y    = Math.max(0, cy - half);
    const w    = Math.min(targetSize, sourceWidth  - x);
    const h    = Math.min(targetSize, sourceHeight - y);

    const decoder = createDecoder({
        format: 'rgba8',
        region: { x, y, w, h },
        downsample: 1,
        progressionTarget: 'final',
        emitEveryPass: false,
        preserveIcc: false,
        preserveMetadata: false,
    });
    await decoder.push(jxlBytes);
    await decoder.close();
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
    await decoder.dispose();
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
                rgba      = new Uint8Array(rawWasm.rgb_to_rgba(result.take_rgb()));
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

        for (const size of sizes) {
            if (signal.aborted) break;

            if (size >= imgWidth && size >= imgHeight) {
                console.log(`  ${size}px: skipped (≥ full image)`);
                markSkipped(cards[size], '≥ full image');
                continue;
            }

            setStatusStage(`Tile region ${size}px…`);

            const t0 = performance.now();
            let decoded;
            const metrics = {};
            try {
                decoded = await decodeTileRegion(tiledBytes, tileSize, imgWidth, imgHeight, size, (name, value) => {
                    metrics[name] = value;
                });
            } catch (err) {
                console.error(`  ${size}px tile region ERROR:`, err.message || err);
                markSkipped(cards[size], `error: ${err.message?.split('\n')[0] || String(err).slice(0,20)}`);
                continue;
            }
            const tileMs = performance.now() - t0;

            paintCrop(cards[size], decoded.pixels, decoded.width, decoded.height, tileMs, size, size);

            // JXTC container ROI decode comparison
            let jxtcMs = null;
            if (jxtcBytes) {
                setStatusStage(`JXTC region ${size}px…`);
                const tJ = performance.now();
                try {
                    await decodeContainerRegion(jxtcBytes, imgWidth, imgHeight, size, () => {});
                    jxtcMs = performance.now() - tJ;
                } catch (err) {
                    console.warn(`  ${size}px JXTC region failed:`, err.message || err);
                }
            }

            // Update timing display to show both tile and jxtc
            if (jxtcMs !== null) {
                cards[size].timing.textContent = `tile ${tileMs.toFixed(0)}ms · jxtc ${jxtcMs.toFixed(0)}ms (${(tileMs/jxtcMs).toFixed(1)}×)`;
                if (jxtcMs < 200) cards[size].timing.className = 'crop-timing is-fast';
            }

            // Comparison: full decode of standard JXL + JS crop
            if (compareFull && standardBytes) {
                setStatusStage(`Full decode ${size}px (compare)…`);
                const t1 = performance.now();
                try {
                    await decodeFullThenCrop(standardBytes, imgWidth, imgHeight, size);
                    const fullMs = performance.now() - t1;
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

            await new Promise(r => setTimeout(r, 0));
        }

        console.groupEnd();
    }

    setStatusStage('Done');
    setStatusProgress('Complete');
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
}

// --- Events ---

btnRun.addEventListener('click',   () => running ? abortController?.abort() : runBenchmark());
btnClear.addEventListener('click', clearResults);

// --- Init ---

(async () => {
    setWasmStatus('Initialising WASM…');
    try {
        await initRaw();
        wasmReady = true;
        setWasmStatus('Ready');
    } catch (err) {
        setWasmStatus('WASM error');
        console.error('WASM init:', err);
    }
})();
