import initRaw, * as rawWasm from '../pkg/raw_converter_wasm.js';
import { createDecoder, createEncoder } from '@casabio/jxl-wasm';

const CROP_SIZES = [128, 256, 512, 1024, 2048];

// Log-scaled display width for each crop size (120px–400px range).
// Keeps all 5 cards visible side-by-side without large crops dominating.
function logDisplayWidth(px) {
    const lo = Math.log2(128), hi = Math.log2(2048);
    const t = (Math.log2(px) - lo) / (hi - lo);
    return Math.round(120 + t * 280);
}

// --- IndexedDB helpers for folder handle persistence ---

let idb = null;
const IDB_NAME = 'jxl-crop-bench';
const IDB_STORE = 'state';

async function openIdb() {
    if (idb) return idb;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
        req.onsuccess = () => { idb = req.result; resolve(idb); };
        req.onerror = () => reject(req.error);
    });
}

async function idbGet(key) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
    });
}

async function idbSet(key, value) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const req = tx.objectStore(IDB_STORE).put(value, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

// --- State ---

let dirHandle = null;
let wasmReady = false;
let running = false;
let abortController = null;

// --- DOM refs ---

const btnPickFolder   = document.getElementById('btn-pick-folder');
const btnRun          = document.getElementById('btn-run');
const btnClear        = document.getElementById('btn-clear');
const folderLabel     = document.getElementById('folder-label');
const fileCountInput  = document.getElementById('file-count');
const encodeEffortInput  = document.getElementById('encode-effort');
const encodeDistanceInput = document.getElementById('encode-distance');
const wasmStatusEl    = document.getElementById('wasm-status');
const statusFolder    = document.getElementById('status-folder');
const statusProgress  = document.getElementById('status-progress');
const statusFile      = document.getElementById('status-file');
const statusStage     = document.getElementById('status-stage');
const resultsEl       = document.getElementById('crop-results');

// --- Status helpers ---

function setWasmStatus(text) { wasmStatusEl.textContent = text; }
function setStatusProgress(text) { statusProgress.textContent = text; }
function setStatusFile(text) { statusFile.textContent = text; }
function setStatusStage(text) { statusStage.textContent = text; }
function setStatusFolder(text) { statusFolder.textContent = text; }

function updateFolderUI() {
    if (dirHandle) {
        folderLabel.textContent = dirHandle.name;
        setStatusFolder(dirHandle.name);
        btnRun.disabled = !wasmReady;
    } else {
        folderLabel.textContent = 'No folder selected';
        setStatusFolder('—');
        btnRun.disabled = true;
    }
}

// --- Folder picker ---

async function pickFolder() {
    try {
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        dirHandle = handle;
        await idbSet('folder', handle);
        updateFolderUI();
    } catch (err) {
        if (err.name !== 'AbortError') console.error('showDirectoryPicker error:', err);
    }
}

async function restoreFolderHandle() {
    try {
        const handle = await idbGet('folder');
        if (!handle) return;
        const perm = await handle.queryPermission({ mode: 'read' });
        if (perm === 'granted') {
            dirHandle = handle;
            updateFolderUI();
        } else {
            // Permission not yet granted for this session — store the handle
            // but don't set dirHandle until the user clicks Pick folder
            // (browsers won't re-grant silently; user gesture required).
        }
    } catch {
        // IDB or permission API error — ignore silently.
    }
}

// --- ORF files from directory ---

async function collectOrfHandles(handle) {
    const result = [];
    for await (const [, entry] of handle.entries()) {
        if (entry.kind === 'file' && /\.(orf)$/i.test(entry.name)) {
            result.push(entry);
        }
    }
    return result;
}

function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

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
    // Pass ArrayBuffer (ownership transfer — avoids a copy in standard mode).
    const buf = rgba instanceof ArrayBuffer ? rgba : (rgba.buffer.byteLength === rgba.byteLength ? rgba.buffer : rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength));
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

        const label = document.createElement('div');
        label.className = 'crop-card-label';
        label.textContent = `${size} px`;
        card.appendChild(label);

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

function paintCrop(cardSlot, pixels, width, height, decodeMs, clampedW, clampedH) {
    const { wrap, placeholder, timing } = cardSlot;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const raw = pixels instanceof ArrayBuffer ? new Uint8Array(pixels) : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength), width, height), 0, 0);

    placeholder.remove();
    wrap.appendChild(canvas);

    timing.textContent = `${decodeMs.toFixed(1)} ms`;
    if (decodeMs < 80) timing.className = 'crop-timing is-fast';
    else if (decodeMs > 400) timing.className = 'crop-timing is-slow';
    else timing.className = 'crop-timing';

    // Show actual decoded dims if clamped (image smaller than crop size).
    if (clampedW !== width || clampedH !== height) {
        const note = document.createElement('div');
        note.className = 'crop-timing-encode';
        note.textContent = `(clamped to ${width}×${height})`;
        wrap.after(note);
    }
}

function markSkipped(cardSlot, reason) {
    const { placeholder, timing } = cardSlot;
    placeholder.textContent = reason;
    timing.className = 'crop-timing-skip';
    timing.textContent = 'skipped';
}

// --- Main benchmark loop ---

async function runBenchmark() {
    if (!dirHandle || !wasmReady) return;

    running = true;
    abortController = new AbortController();
    const { signal } = abortController;

    btnRun.textContent = 'Stop';
    btnClear.disabled = true;
    setStatusProgress('Collecting files…');
    setStatusFile('—');
    setStatusStage('—');

    const fileCount = Math.max(1, Math.min(20, Number(fileCountInput.value) || 3));
    const effort   = Math.max(1, Math.min(9, Number(encodeEffortInput.value) || 3));
    const distance = Math.max(0, Math.min(25, Number(encodeDistanceInput.value) || 1.0));
    const sizes    = getSelectedSizes();

    if (!sizes.length) {
        setStatusProgress('No crop sizes selected.');
        endRun();
        return;
    }

    let handles;
    try {
        handles = shuffled(await collectOrfHandles(dirHandle)).slice(0, fileCount);
    } catch (err) {
        setStatusProgress(`Error reading folder: ${err.message}`);
        endRun();
        return;
    }

    if (!handles.length) {
        setStatusProgress('No ORF files found in folder.');
        endRun();
        return;
    }

    setStatusProgress(`0 / ${handles.length} files`);

    for (let i = 0; i < handles.length; i++) {
        if (signal.aborted) break;

        const fileHandle = handles[i];
        const name = fileHandle.name;
        setStatusFile(name);
        setStatusStage('Reading…');
        setStatusProgress(`${i + 1} / ${handles.length}`);

        let arrayBuffer;
        try {
            const file = await fileHandle.getFile();
            arrayBuffer = await file.arrayBuffer();
        } catch (err) {
            console.error('Read error:', name, err);
            continue;
        }

        // ORF → RGBA via raw WASM pipeline
        setStatusStage('Decoding RAW…');
        let rgba, imgWidth, imgHeight;
        try {
            const result = rawWasm.process_orf(new Uint8Array(arrayBuffer), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
            try {
                const rgb = result.take_rgb();
                const rgbaData = rawWasm.rgb_to_rgba(rgb);
                rgba = new Uint8Array(rgbaData);
                imgWidth  = result.width;
                imgHeight = result.height;
            } finally {
                result.free();
            }
        } catch (err) {
            console.error('RAW decode error:', name, err);
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
            console.error('Encode error:', name, err);
            setStatusStage(`Encode error: ${err.message}`);
            continue;
        }
        const encodeMs = performance.now() - encodeStart;

        // Create result row (inserted at top so latest is first)
        const { cards, meta } = createFileRow(name, imgWidth, imgHeight, sizes);
        meta.textContent = `${imgWidth} × ${imgHeight} px  ·  encode ${encodeMs.toFixed(0)} ms  ·  ${(jxlBytes.byteLength / 1024).toFixed(0)} KB JXL`;

        console.group(`Crop benchmark: ${name}`);
        console.log(`Image: ${imgWidth}×${imgHeight}  Encode: ${encodeMs.toFixed(1)} ms  JXL size: ${(jxlBytes.byteLength / 1024).toFixed(0)} KB`);

        // Decode each crop size
        for (const size of sizes) {
            if (signal.aborted) break;

            const x = Math.max(0, Math.floor((imgWidth  - size) / 2));
            const y = Math.max(0, Math.floor((imgHeight - size) / 2));
            const w = Math.min(size, imgWidth  - x);
            const h = Math.min(size, imgHeight - y);

            setStatusStage(`Crop ${size} px…`);

            if (w <= 0 || h <= 0) {
                markSkipped(cards[size], 'too large');
                console.log(`  ${size}px: skipped (image too small)`);
                continue;
            }

            const t0 = performance.now();
            let decoded;
            try {
                decoded = await decodeCrop(jxlBytes, x, y, w, h);
            } catch (err) {
                console.error(`  ${size}px decode error:`, err);
                markSkipped(cards[size], 'error');
                continue;
            }
            const decodeMs = performance.now() - t0;

            paintCrop(cards[size], decoded.pixels, decoded.width, decoded.height, decodeMs, w, h);
            console.log(`  ${size}px crop (${w}×${h} → ${decoded.width}×${decoded.height}): ${decodeMs.toFixed(1)} ms`);

            // Yield to paint before next crop
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

function stopRun() {
    if (abortController) abortController.abort();
}

function clearResults() {
    resultsEl.innerHTML = '<div class="crop-empty-state">Pick a folder of ORF files and press Run.</div>';
    btnClear.disabled = true;
    setStatusProgress('Idle');
    setStatusFile('—');
    setStatusStage('—');
}

// --- Event listeners ---

btnPickFolder.addEventListener('click', pickFolder);

btnRun.addEventListener('click', () => {
    if (running) stopRun();
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
        updateFolderUI();
    } catch (err) {
        setWasmStatus('WASM error');
        console.error('WASM init error:', err);
    }
    await restoreFolderHandle();
}

init();
