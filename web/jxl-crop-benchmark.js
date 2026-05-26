import initRaw, * as rawWasm from '../pkg/raw_converter_wasm.js';
import { createDecoder, createEncoder } from '@casabio/jxl-wasm';

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

let orfFiles = [];  // File objects from folder input
let wasmReady = false;
let running = false;
let abortController = null;

// --- DOM refs ---

const folderInput        = document.getElementById('folder-input');
const btnRun             = document.getElementById('btn-run');
const btnClear           = document.getElementById('btn-clear');
const folderLabel        = document.getElementById('folder-label');
const fileCountInput     = document.getElementById('file-count');
const encodeEffortInput  = document.getElementById('encode-effort');
const encodeDistanceInput = document.getElementById('encode-distance');
const wasmStatusEl       = document.getElementById('wasm-status');
const statusFolder       = document.getElementById('status-folder');
const statusProgress     = document.getElementById('status-progress');
const statusFile         = document.getElementById('status-file');
const statusStage        = document.getElementById('status-stage');
const resultsEl          = document.getElementById('crop-results');

// --- Status helpers ---

function setWasmStatus(text) { wasmStatusEl.textContent = text; }
function setStatusProgress(text) { statusProgress.textContent = text; }
function setStatusFile(text) { statusFile.textContent = text; }
function setStatusStage(text) { statusStage.textContent = text; }
function setStatusFolder(text) { statusFolder.textContent = text; }

// --- Folder input ---

folderInput.addEventListener('change', () => {
    const all = Array.from(folderInput.files);
    orfFiles = all.filter(f => /\.orf$/i.test(f.name));
    if (!orfFiles.length) {
        folderLabel.textContent = 'No ORF files found in folder';
        setStatusFolder('—');
        btnRun.disabled = true;
        return;
    }
    const folderName = orfFiles[0].webkitRelativePath.split('/')[0] || 'selected folder';
    folderLabel.textContent = `${folderName}  (${orfFiles.length} ORF files)`;
    setStatusFolder(folderName);
    btnRun.disabled = !wasmReady;
});

// --- WASM encode/decode helpers ---

function concatChunks(chunks) {
    const views = chunks.map(c => c instanceof Uint8Array ? c : new Uint8Array(c));
    if (views.length === 1) return views[0];
    const total = views.reduce((s, v) => s + v.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const v of views) { out.set(v, off); off += v.byteLength; }
    return out;
}

async function encodeToJxl(rgba, width, height, effort, distance) {
    const encoder = createEncoder({
        format: 'rgba8',
        width,
        height,
        hasAlpha: true,
        iccProfile: null,
        exif: null,
        xmp: null,
        distance,
        quality: null,
        effort,
        progressive: false,
        previewFirst: false,
        chunked: false,
    });
    const chunks = [];
    const chunkTask = (async () => {
        for await (const chunk of encoder.chunks()) chunks.push(chunk);
    })();
    // Ownership-transfer: extract exact ArrayBuffer slice from Uint8Array.
    const buf = rgba.buffer.byteLength === rgba.byteLength
        ? rgba.buffer
        : rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength);
    await encoder.pushPixels(buf);
    await encoder.finish();
    await chunkTask;
    await encoder.dispose();
    return concatChunks(chunks);
}

async function decodeCrop(jxlBytes, x, y, w, h) {
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
            throw new Error(`decode error: ${event.message}`);
        }
    }
    await decoder.dispose();
    if (!result) throw new Error('no final frame emitted');
    return result;
}

// --- UI: result rows ---

function getSelectedSizes() {
    return Array.from(document.querySelectorAll('input[name="crop-size"]:checked'))
        .map(cb => Number(cb.value))
        .sort((a, b) => a - b);
}

function createFileRow(fileName, imgWidth, imgHeight, sizes) {
    const row = document.createElement('div');
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
        const displayW = logDisplayWidth(size);
        const card = document.createElement('div');
        card.className = 'crop-card';
        card.style.width = displayW + 'px';

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

        strip.appendChild(card);
        cards[size] = { wrap, placeholder, timing };
    }

    resultsEl.insertBefore(row, resultsEl.firstChild);
    return { row, cards, meta };
}

function paintCrop(cardSlot, pixels, width, height, decodeMs, reqW, reqH) {
    const { wrap, placeholder, timing } = cardSlot;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const raw = pixels instanceof ArrayBuffer
        ? new Uint8Array(pixels)
        : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    ctx.putImageData(
        new ImageData(new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength), width, height),
        0, 0,
    );

    placeholder.remove();
    wrap.appendChild(canvas);

    timing.textContent = `${decodeMs.toFixed(1)} ms`;
    timing.className = decodeMs < 80 ? 'crop-timing is-fast' : decodeMs > 400 ? 'crop-timing is-slow' : 'crop-timing';

    if (reqW !== width || reqH !== height) {
        const note = document.createElement('div');
        note.className = 'crop-timing-encode';
        note.textContent = `(clamped to ${width}×${height})`;
        timing.after(note);
    }
}

function markSkipped(cardSlot, reason) {
    cardSlot.placeholder.textContent = reason;
    cardSlot.timing.className = 'crop-timing-skip';
    cardSlot.timing.textContent = 'skipped';
}

// --- Main benchmark loop ---

async function runBenchmark() {
    if (!orfFiles.length || !wasmReady) return;

    running = true;
    abortController = new AbortController();
    const { signal } = abortController;

    btnRun.textContent = 'Stop';
    btnClear.disabled = true;

    const fileCount = Math.max(1, Math.min(20, Number(fileCountInput.value) || 3));
    const effort    = Math.max(1, Math.min(9,  Number(encodeEffortInput.value) || 3));
    const distance  = Math.max(0, Math.min(25, Number(encodeDistanceInput.value) || 1.0));
    const sizes     = getSelectedSizes();

    if (!sizes.length) {
        setStatusProgress('No crop sizes selected.');
        endRun();
        return;
    }

    const files = shuffled(orfFiles).slice(0, fileCount);
    setStatusProgress(`0 / ${files.length}`);
    setStatusFile('—');
    setStatusStage('—');

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

        // ORF → RGBA
        setStatusStage('Decoding RAW…');
        let rgba, imgWidth, imgHeight;
        try {
            const result = rawWasm.process_orf(new Uint8Array(arrayBuffer), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
            try {
                const rgb = result.take_rgb();
                const rgbaData = rawWasm.rgb_to_rgba(rgb);
                rgba      = new Uint8Array(rgbaData);
                imgWidth  = result.width;
                imgHeight = result.height;
            } finally {
                result.free();
            }
        } catch (err) {
            console.error('RAW decode error:', file.name, err);
            setStatusStage(`RAW error: ${err.message}`);
            continue;
        }

        // RGBA → JXL
        setStatusStage('Encoding JXL…');
        const encodeStart = performance.now();
        let jxlBytes;
        try {
            jxlBytes = await encodeToJxl(rgba, imgWidth, imgHeight, effort, distance);
        } catch (err) {
            console.error('Encode error:', file.name, err);
            setStatusStage(`Encode error: ${err.message}`);
            continue;
        }
        const encodeMs = performance.now() - encodeStart;

        const { cards, meta } = createFileRow(file.name, imgWidth, imgHeight, sizes);
        meta.textContent = `${imgWidth} × ${imgHeight} px  ·  encode ${encodeMs.toFixed(0)} ms  ·  ${(jxlBytes.byteLength / 1024).toFixed(0)} KB`;

        console.group(`Crop benchmark: ${file.name}`);
        console.log(`${imgWidth}×${imgHeight}  encode ${encodeMs.toFixed(1)} ms  JXL ${(jxlBytes.byteLength / 1024).toFixed(0)} KB`);

        for (const size of sizes) {
            if (signal.aborted) break;

            const x = Math.max(0, Math.floor((imgWidth  - size) / 2));
            const y = Math.max(0, Math.floor((imgHeight - size) / 2));
            const w = Math.min(size, imgWidth  - x);
            const h = Math.min(size, imgHeight - y);

            setStatusStage(`Crop ${size} px…`);

            if (w <= 0 || h <= 0) {
                markSkipped(cards[size], 'too large');
                continue;
            }

            const t0 = performance.now();
            let decoded;
            try {
                decoded = await decodeCrop(jxlBytes, x, y, w, h);
            } catch (err) {
                console.error(`${size}px decode error:`, err);
                markSkipped(cards[size], 'error');
                continue;
            }
            const decodeMs = performance.now() - t0;

            paintCrop(cards[size], decoded.pixels, decoded.width, decoded.height, decodeMs, w, h);
            console.log(`  ${size}px (${w}×${h} → ${decoded.width}×${decoded.height}): ${decodeMs.toFixed(1)} ms`);

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
    btnClear.disabled = false;
}

function clearResults() {
    resultsEl.innerHTML = '<div class="crop-empty-state">Pick a folder of ORF files and press Run.</div>';
    btnClear.disabled = true;
    setStatusProgress('Idle');
    setStatusFile('—');
    setStatusStage('—');
}

// --- Event listeners ---

btnRun.addEventListener('click', () => {
    if (running) abortController?.abort();
    else runBenchmark();
});

btnClear.addEventListener('click', clearResults);

// --- Init ---

async function init() {
    setWasmStatus('Initialising WASM…');
    try {
        await initRaw();
        wasmReady = true;
        setWasmStatus('Ready');
    } catch (err) {
        setWasmStatus('WASM error');
        console.error('WASM init error:', err);
    }
}

init();
