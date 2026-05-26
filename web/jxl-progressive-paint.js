import initRaw, * as rawWasm from '../pkg/raw_converter_wasm.js';
import { createDecoder, createEncoder } from '@casabio/jxl-wasm';
import { initDebugConsole, dbgLog } from './jxl-debug-console.js';

const { process_orf, rgb_to_rgba } = rawWasm;

let selectedSource = null;
let wasmReady = false;

// ─── WASM init ────────────────────────────────────────────────────────────────

initRaw().then(() => {
    wasmReady = true;
    dbgLog('WASM module initialized');
}).catch(err => {
    dbgLog('Failed to init WASM: ' + err.message, '', 'error');
});

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const sourceInput = document.getElementById('source-input');
const sourceDrop = document.getElementById('source-drop');
const loadRandomBtn = document.getElementById('load-random');
const runProgressiveBtn = document.getElementById('run-progressive');
const dbgConsoleBtn = document.getElementById('dbg-console-btn');

if (dbgConsoleBtn) initDebugConsole(dbgConsoleBtn);

// ─── Utilities ────────────────────────────────────────────────────────────────

function resizeRgba(rgba, width, height, targetWidth) {
    if (targetWidth === 'fullsize') return { rgba, width, height };
    const scale = targetWidth / width;
    const targetHeight = Math.round(height * scale);
    const resizeRgbaImpl = rawWasm.downscale_rgba ?? downscaleRgbaCanvas;
    return { rgba: resizeRgbaImpl(rgba, width, height, targetWidth, targetHeight), width: targetWidth, height: targetHeight };
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

function exactBuffer(view) {
    if (view instanceof ArrayBuffer) return view;
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function concatChunks(chunks) {
    const views = chunks.map(c => c instanceof Uint8Array ? c : new Uint8Array(c));
    if (views.length === 1) return views[0];
    const total = views.reduce((sum, c) => sum + c.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of views) { out.set(c, offset); offset += c.byteLength; }
    return out;
}

// ─── File loading ─────────────────────────────────────────────────────────────

async function processImageFile(file, arrayBuffer) {
    const name = file.name.toLowerCase();
    const type = file.type;
    try {
        if (name.match(/\.(orf|raw)$/i)) {
            if (!wasmReady) { dbgLog('WASM not ready'); return null; }
            const result = process_orf(new Uint8Array(arrayBuffer), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
            try {
                const rgb = result.take_rgb();
                const rgba = rgb_to_rgba(rgb);
                return { rgba: new Uint8Array(rgba), width: result.width, height: result.height };
            } finally {
                result.free();
            }
        } else if (type.startsWith('image/') || name.match(/\.(jpg|jpeg|png|webp|jxl)$/i)) {
            const blob = new Blob([arrayBuffer], { type: type || 'application/octet-stream' });
            const bitmap = await createImageBitmap(blob);
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0);
            const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
            return { rgba: new Uint8Array(imageData.data.buffer), width: bitmap.width, height: bitmap.height };
        } else {
            dbgLog(`Unknown file type: ${name} (${type})`, '', 'warn');
        }
    } catch (err) {
        dbgLog(`Process error: ${err.message}`, '', 'error');
    }
    return null;
}

async function loadFile(file) {
    setProgStatus(`Loading ${file.name}…`);
    try {
        const arrayBuffer = await file.arrayBuffer();
        const result = await processImageFile(file, arrayBuffer);
        if (result) {
            selectedSource = { file: file.name, ...result };
            setProgStatus(`${file.name} (${result.width}×${result.height}) — click Run progressive paint.`);
            dbgLog(`✓ ${file.name}`, `${result.width}×${result.height}`);
        } else {
            selectedSource = null;
            setProgStatus(`Failed to load ${file.name}.`);
        }
    } catch (err) {
        selectedSource = null;
        setProgStatus(`Error: ${err.message}`);
        dbgLog(`✗ ${file.name}: ${err.message}`, '', 'error');
    }
    updateUI();
}

async function loadRandomImage() {
    if (!wasmReady) { setProgStatus('WASM not ready — wait a moment.'); return; }
    loadRandomBtn.disabled = true;
    loadRandomBtn.textContent = 'Loading…';
    setProgStatus('Fetching random Gobabeb image…');
    try {
        const resp = await fetch('/api/random-gobabeb');
        if (!resp.ok) throw new Error(`API error ${resp.status}`);
        const arrayBuffer = await resp.arrayBuffer();
        const fileName = resp.headers.get('X-File-Name') || 'random.orf';
        const file = { name: fileName, type: 'application/octet-stream' };
        const result = await processImageFile(file, arrayBuffer);
        if (result) {
            selectedSource = { file: fileName, ...result };
            setProgStatus(`${fileName} (${result.width}×${result.height}) — click Run progressive paint.`);
            dbgLog(`✓ ${fileName}`, `${result.width}×${result.height}`);
        } else {
            selectedSource = null;
            setProgStatus('Failed to process random image.');
        }
    } catch (err) {
        selectedSource = null;
        setProgStatus(`Error: ${err.message}`);
        dbgLog(`✗ Random load: ${err.message}`, '', 'error');
    } finally {
        loadRandomBtn.disabled = false;
        loadRandomBtn.textContent = 'Random Gobabeb';
    }
    updateUI();
}

function updateUI() {
    const ready = !!selectedSource;
    runProgressiveBtn.disabled = !ready;
    runProgressiveBtn.title = ready ? '' : 'Load a file first';
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

if (sourceInput) {
    sourceInput.addEventListener('change', e => {
        const file = e.target.files?.[0];
        if (file) loadFile(file);
    });
}

if (sourceDrop) {
    sourceDrop.addEventListener('drop', e => {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (file) loadFile(file);
    });
    sourceDrop.addEventListener('dragover', e => e.preventDefault());
}

if (loadRandomBtn) {
    loadRandomBtn.addEventListener('click', () => loadRandomImage());
}

if (runProgressiveBtn) {
    runProgressiveBtn.addEventListener('click', () => runProgressivePaintTest());
}

// ─── Progressive paint ────────────────────────────────────────────────────────

function getProgSize() {
    const radio = document.querySelector('input[name="prog-size"]:checked');
    if (!radio) return 1080;
    return radio.value === 'fullsize' ? 'fullsize' : Number(radio.value);
}

function getProgQuality() {
    const radio = document.querySelector('input[name="prog-quality"]:checked');
    return radio ? Number(radio.value) : 85;
}

function setProgStatus(text) {
    const el = document.getElementById('prog-status');
    if (el) el.textContent = text;
}

function clearViewports() {
    for (const id of ['vp-overview', 'vp-pixel', 'vp-zoom']) {
        const canvas = document.getElementById(id);
        if (!canvas) continue;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(0,0,0,0.04)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    for (const id of ['vp-overview-info', 'vp-pixel-info', 'vp-zoom-info']) {
        const el = document.getElementById(id);
        if (el) el.textContent = '—';
    }
}

function clearPassTimeline() {
    const el = document.getElementById('pass-timeline');
    if (el) el.innerHTML = '';
}

function renderPassToViewports(pixels, width, height) {
    const arr = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels);
    const imgData = new ImageData(new Uint8ClampedArray(arr.buffer, arr.byteOffset, arr.byteLength), width, height);
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = width;
    srcCanvas.height = height;
    srcCanvas.getContext('2d').putImageData(imgData, 0, 0);

    const ovCanvas = document.getElementById('vp-overview');
    if (ovCanvas) {
        const ctx = ovCanvas.getContext('2d');
        const scale = Math.min(ovCanvas.width / width, ovCanvas.height / height);
        const dw = Math.round(width * scale), dh = Math.round(height * scale);
        ctx.clearRect(0, 0, ovCanvas.width, ovCanvas.height);
        ctx.drawImage(srcCanvas, Math.round((ovCanvas.width - dw) / 2), Math.round((ovCanvas.height - dh) / 2), dw, dh);
    }

    const pxCanvas = document.getElementById('vp-pixel');
    if (pxCanvas) {
        const cw = Math.min(pxCanvas.width, width), ch = Math.min(pxCanvas.height, height);
        const sx = Math.floor((width - cw) / 2), sy = Math.floor((height - ch) / 2);
        const ctx = pxCanvas.getContext('2d');
        ctx.clearRect(0, 0, pxCanvas.width, pxCanvas.height);
        ctx.drawImage(srcCanvas, sx, sy, cw, ch, 0, 0, cw, ch);
    }

    const zmCanvas = document.getElementById('vp-zoom');
    if (zmCanvas) {
        const srcW = Math.max(1, Math.floor(zmCanvas.width / 4));
        const srcH = Math.max(1, Math.floor(zmCanvas.height / 4));
        const sx = Math.max(0, Math.floor((width - srcW) / 2));
        const sy = Math.max(0, Math.floor((height - srcH) / 2));
        const ctx = zmCanvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, zmCanvas.width, zmCanvas.height);
        ctx.drawImage(srcCanvas, sx, sy, Math.min(srcW, width - sx), Math.min(srcH, height - sy), 0, 0, zmCanvas.width, zmCanvas.height);
    }

    return srcCanvas;
}

function addPassToTimeline(srcCanvas, passIdx, t, isFinal) {
    const timeline = document.getElementById('pass-timeline');
    if (!timeline) return;
    const TW = 80, TH = 50;
    const thumb = document.createElement('canvas');
    thumb.width = TW;
    thumb.height = TH;
    const ctx = thumb.getContext('2d');
    const scale = Math.min(TW / srcCanvas.width, TH / srcCanvas.height);
    const dw = Math.round(srcCanvas.width * scale), dh = Math.round(srcCanvas.height * scale);
    ctx.drawImage(srcCanvas, Math.round((TW - dw) / 2), Math.round((TH - dh) / 2), dw, dh);
    const wrap = document.createElement('div');
    wrap.className = 'pass-thumb' + (isFinal ? ' is-final' : '');
    wrap.title = `Pass ${passIdx + 1} · ${t.toFixed(1)} ms${isFinal ? ' · final' : ''}`;
    const label = document.createElement('div');
    label.className = 'pass-thumb-label';
    label.textContent = isFinal ? `${t.toFixed(0)}ms ✓` : `${t.toFixed(0)}ms`;
    wrap.appendChild(thumb);
    wrap.appendChild(label);
    timeline.appendChild(wrap);
}

function updateViewportInfo(passIdx, t, isFinal) {
    const text = `Pass ${passIdx + 1} · ${t.toFixed(1)} ms${isFinal ? ' · final' : ' · partial'}`;
    for (const id of ['vp-overview-info', 'vp-pixel-info', 'vp-zoom-info']) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }
}

function renderProgressiveComparison({ passCount, progressiveFirstMs, progressiveFinalMs, oneShotFinalMs, fileSizeKB, encodeMs, previewFirst }) {
    const body = document.getElementById('prog-comparison-body');
    if (!body) return;
    const speedup = (oneShotFinalMs && progressiveFirstMs)
        ? `${(oneShotFinalMs / progressiveFirstMs).toFixed(1)}×`
        : '—';
    body.innerHTML = `
        <tr>
            <td><strong>Progressive (emitEveryPass)</strong></td>
            <td>${passCount}</td>
            <td><strong>${progressiveFirstMs != null ? progressiveFirstMs.toFixed(1) + ' ms' : '—'}</strong></td>
            <td>${progressiveFinalMs != null ? progressiveFinalMs.toFixed(1) + ' ms' : '—'}</td>
            <td>${speedup} faster 1st frame</td>
        </tr>
        <tr>
            <td>One-shot (final only)</td>
            <td>1</td>
            <td>—</td>
            <td>${oneShotFinalMs != null ? oneShotFinalMs.toFixed(1) + ' ms' : '—'}</td>
            <td>baseline</td>
        </tr>
        <tr>
            <td colspan="5" style="font-size:11px;color:var(--muted);padding:6px 12px;">
                Encoded ${fileSizeKB.toFixed(1)} KB in ${encodeMs.toFixed(1)} ms · progressive=true previewFirst=${previewFirst}
            </td>
        </tr>
    `;
}

async function runProgressivePaintTest() {
    if (!selectedSource) { setProgStatus('Load a file first.'); return; }
    if (!wasmReady) { setProgStatus('WASM not ready.'); return; }

    runProgressiveBtn.disabled = true;
    runProgressiveBtn.textContent = 'Running…';
    clearViewports();
    clearPassTimeline();

    try {
        const size = getProgSize();
        const quality = getProgQuality();
        const previewFirst = !!(document.getElementById('prog-preview-first')?.checked);

        setProgStatus(`Resizing to ${size === 'fullsize' ? 'full' : size + 'px'}…`);
        const resized = resizeRgba(selectedSource.rgba, selectedSource.width, selectedSource.height, size);

        setProgStatus(`Encoding ${resized.width}×${resized.height} Q${quality} progressive…`);

        const encoder = createEncoder({
            format: 'rgba8',
            width: resized.width,
            height: resized.height,
            hasAlpha: true,
            quality,
            effort: 3,
            progressive: true,
            previewFirst,
            chunked: false,
            modular: false,
            brotliEffort: 9,
            copyInput: true,
        });
        const encChunks = [];
        const chunkTask = (async () => { for await (const c of encoder.chunks()) encChunks.push(c); })();
        const encStart = performance.now();
        await encoder.pushPixels(exactBuffer(resized.rgba));
        await encoder.finish();
        await chunkTask;
        const encodeMs = performance.now() - encStart;
        await encoder.dispose();
        const jxlBytes = concatChunks(encChunks);

        setProgStatus(`Encoded ${(jxlBytes.length / 1024).toFixed(1)} KB in ${encodeMs.toFixed(1)} ms · decoding progressively…`);
        dbgLog('Encoded', `${(jxlBytes.length / 1024).toFixed(1)} KB in ${encodeMs.toFixed(1)} ms`, 'info');

        const decoder = createDecoder({
            format: 'rgba8',
            region: null,
            downsample: 1,
            progressionTarget: 'final',
            emitEveryPass: true,
            preserveIcc: false,
            preserveMetadata: false,
        });
        decoder.push(jxlBytes);
        decoder.close();

        const decStart = performance.now();
        const passes = [];
        let passIdx = 0;

        for await (const ev of decoder.events()) {
            if (ev.type === 'progress' || ev.type === 'final') {
                const t = performance.now() - decStart;
                const isFinal = ev.type === 'final';
                const srcCanvas = renderPassToViewports(ev.pixels, ev.info.width, ev.info.height);
                addPassToTimeline(srcCanvas, passIdx, t, isFinal);
                updateViewportInfo(passIdx, t, isFinal);
                passes.push({ passIdx, t, isFinal });
                dbgLog(`  pass ${passIdx + 1}${isFinal ? ' (final)' : ''}`, `${t.toFixed(1)} ms`, 'info');
                passIdx++;
            } else if (ev.type === 'error') {
                throw new Error(ev.message);
            }
        }
        decoder.dispose();

        const progressiveFirstMs = passes.length ? passes[0].t : null;
        const progressiveFinalMs = passes.length ? passes[passes.length - 1].t : null;

        setProgStatus('Running one-shot decode for comparison…');
        const decoder2 = createDecoder({
            format: 'rgba8',
            region: null,
            downsample: 1,
            progressionTarget: 'final',
            emitEveryPass: false,
            preserveIcc: false,
            preserveMetadata: false,
        });
        decoder2.push(jxlBytes.slice());
        decoder2.close();
        const oneShotStart = performance.now();
        let oneShotFinalMs = null;
        for await (const ev of decoder2.events()) {
            if (ev.type === 'final') oneShotFinalMs = performance.now() - oneShotStart;
            else if (ev.type === 'error') throw new Error(ev.message);
        }
        decoder2.dispose();

        renderProgressiveComparison({ passCount: passes.length, progressiveFirstMs, progressiveFinalMs, oneShotFinalMs, fileSizeKB: jxlBytes.length / 1024, encodeMs, previewFirst });

        const summary = `${passes.length} passes · first ${progressiveFirstMs?.toFixed(1)} ms · final ${progressiveFinalMs?.toFixed(1)} ms · one-shot ${oneShotFinalMs?.toFixed(1)} ms`;
        setProgStatus(`Done. ${summary}`);
        dbgLog('Progressive paint done', summary, 'success');

    } catch (err) {
        setProgStatus(`Error: ${err.message}`);
        dbgLog('Progressive paint error', err.message, 'error');
    } finally {
        runProgressiveBtn.textContent = 'Run progressive paint';
        runProgressiveBtn.disabled = !selectedSource;
    }
}

dbgLog('Progressive paint initialized');
