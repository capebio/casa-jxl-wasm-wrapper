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

const compareSlots = [
    {
        slotName: 'A',
        labelEl: document.getElementById('vp-overview-label'),
        canvas: document.getElementById('vp-overview'),
        infoEl: document.getElementById('vp-overview-info'),
    },
    {
        slotName: 'B',
        labelEl: document.getElementById('vp-pixel-label'),
        canvas: document.getElementById('vp-pixel'),
        infoEl: document.getElementById('vp-pixel-info'),
    },
    {
        slotName: 'C',
        labelEl: document.getElementById('vp-zoom-label'),
        canvas: document.getElementById('vp-zoom'),
        infoEl: document.getElementById('vp-zoom-info'),
    },
];

let compareSlotCursor = 0;

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

function getRequestedPassCount() {
    const radio = document.querySelector('input[name="prog-passes"]:checked');
    const count = radio ? Number(radio.value) : 2;
    return Number.isFinite(count) ? Math.max(2, Math.min(8, count)) : 2;
}

function getRequestedProgressiveDetail(stepCount) {
    if (stepCount >= 6) return 'passes';
    if (stepCount >= 4) return 'lastPasses';
    return 'dc';
}

function getRequestedProgressiveFlavor(stepCount, previewFirst) {
    return stepCount > 2 || previewFirst ? 'ac' : 'dc';
}

function setProgStatus(text) {
    const el = document.getElementById('prog-status');
    if (el) el.textContent = text;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function nextPaint() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function clearCompareSlots() {
    compareSlotCursor = 0;
    for (const slot of compareSlots) {
        if (!slot.canvas) continue;
        const ctx = slot.canvas.getContext('2d');
        ctx.clearRect(0, 0, slot.canvas.width, slot.canvas.height);
        ctx.fillStyle = 'rgba(0,0,0,0.04)';
        ctx.fillRect(0, 0, slot.canvas.width, slot.canvas.height);
        if (slot.labelEl) slot.labelEl.textContent = `Compare ${slot.slotName}`;
        if (slot.infoEl) slot.infoEl.textContent = 'Waiting for pass.';
    }
}

function clearPassTimeline() {
    const el = document.getElementById('pass-timeline');
    if (el) el.innerHTML = '';
}

function makePassCanvas(pixels, width, height) {
    const arr = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels);
    const imgData = new ImageData(new Uint8ClampedArray(arr.buffer, arr.byteOffset, arr.byteLength), width, height);
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = width;
    srcCanvas.height = height;
    srcCanvas.getContext('2d').putImageData(imgData, 0, 0);
    return srcCanvas;
}

function paintCanvasIntoSlot(srcCanvas, slotCanvas) {
    if (!slotCanvas) return;
    const ctx = slotCanvas.getContext('2d');
    const scale = Math.min(slotCanvas.width / srcCanvas.width, slotCanvas.height / srcCanvas.height);
    const dw = Math.max(1, Math.round(srcCanvas.width * scale));
    const dh = Math.max(1, Math.round(srcCanvas.height * scale));
    ctx.clearRect(0, 0, slotCanvas.width, slotCanvas.height);
    ctx.drawImage(srcCanvas, Math.round((slotCanvas.width - dw) / 2), Math.round((slotCanvas.height - dh) / 2), dw, dh);
}

function formatPassLabel(passRecord) {
    const stage = passRecord.isFinal ? 'final' : 'partial';
    return `Pass ${passRecord.passIdx + 1} · ${passRecord.t.toFixed(1)} ms · ${stage}`;
}

function assignPassToCompareSlot(passRecord, slotIndex = compareSlotCursor) {
    const slot = compareSlots[slotIndex];
    if (!slot || !slot.canvas) return;
    paintCanvasIntoSlot(passRecord.srcCanvas, slot.canvas);
    if (slot.labelEl) slot.labelEl.textContent = `Compare ${slot.slotName} · pass ${passRecord.passIdx + 1}`;
    if (slot.infoEl) slot.infoEl.textContent = formatPassLabel(passRecord);
    if (passRecord.button) passRecord.button.dataset.slot = slot.slotName;
}

function advanceCompareSlotCursor(slotIndex = compareSlotCursor) {
    compareSlotCursor = (slotIndex + 1) % compareSlots.length;
}

function autoAssignPass(passRecord) {
    const slotIndex = Math.min(passRecord.passIdx, compareSlots.length - 1);
    assignPassToCompareSlot(passRecord, slotIndex);
    advanceCompareSlotCursor(slotIndex);
}

function addPassToTimeline(passRecord) {
    const timeline = document.getElementById('pass-timeline');
    if (!timeline) return;
    const TW = 80, TH = 50;
    const thumb = document.createElement('canvas');
    thumb.width = TW;
    thumb.height = TH;
    const ctx = thumb.getContext('2d');
    const scale = Math.min(TW / passRecord.srcCanvas.width, TH / passRecord.srcCanvas.height);
    const dw = Math.round(passRecord.srcCanvas.width * scale), dh = Math.round(passRecord.srcCanvas.height * scale);
    ctx.drawImage(passRecord.srcCanvas, Math.round((TW - dw) / 2), Math.round((TH - dh) / 2), dw, dh);
    const wrap = document.createElement('button');
    wrap.type = 'button';
    wrap.className = 'pass-thumb' + (passRecord.isFinal ? ' is-final' : '');
    wrap.title = `${formatPassLabel(passRecord)} · click to pin into compare slots`;
    const label = document.createElement('div');
    label.className = 'pass-thumb-label';
    label.textContent = passRecord.isFinal ? `${passRecord.t.toFixed(0)}ms ✓` : `${passRecord.t.toFixed(0)}ms`;
    wrap.appendChild(thumb);
    wrap.appendChild(label);
    wrap.addEventListener('click', () => {
        assignPassToCompareSlot(passRecord);
        advanceCompareSlotCursor();
    });
    passRecord.button = wrap;
    timeline.appendChild(wrap);
}

function splitEncodedBytesIntoSteps(bytes, stepCount) {
    if (stepCount <= 1 || bytes.byteLength <= 1) return [bytes];
    const steps = [];
    let offset = 0;
    for (let i = 0; i < stepCount; i++) {
        const remaining = bytes.byteLength - offset;
        const remainingSteps = stepCount - i;
        const size = i === stepCount - 1 ? remaining : Math.max(1, Math.ceil(remaining / remainingSteps));
        const end = Math.min(bytes.byteLength, offset + size);
        steps.push(bytes.subarray(offset, end));
        offset = end;
    }
    return steps.filter(step => step.byteLength > 0);
}

async function streamIntoDecoder(decoder, jxlBytes, stepCount) {
    const streamSteps = splitEncodedBytesIntoSteps(jxlBytes, stepCount);
    for (let i = 0; i < streamSteps.length; i++) {
        const stepChunk = streamSteps[i];
        dbgLog(`  stream ${i + 1}/${streamSteps.length}`, `${(stepChunk.byteLength / 1024).toFixed(1)} KB`, 'info');
        await decoder.push(exactBuffer(stepChunk));
        if (i < streamSteps.length - 1) {
            setProgStatus(`Streaming step ${i + 1}/${streamSteps.length}… waiting for next progressive paint.`);
            await nextPaint();
            await sleep(32);
        }
    }
    await decoder.close();
    return streamSteps.length;
}

function renderProgressiveComparison({ requestedPassCount, passCount, progressiveFirstMs, progressiveFinalMs, oneShotFinalMs, fileSizeKB, encodeMs, previewFirst, progressiveDetail }) {
    const body = document.getElementById('prog-comparison-body');
    if (!body) return;
    const speedup = (oneShotFinalMs && progressiveFirstMs)
        ? `${(oneShotFinalMs / progressiveFirstMs).toFixed(1)}×`
        : '—';
    body.innerHTML = `
        <tr>
            <td><strong>Progressive stream (${requestedPassCount} steps)</strong></td>
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
                Encoded ${fileSizeKB.toFixed(1)} KB in ${encodeMs.toFixed(1)} ms · progressive=true previewFirst=${previewFirst} · detail=${progressiveDetail}
            </td>
        </tr>
    `;
}

async function runProgressivePaintTest() {
    if (!selectedSource) { setProgStatus('Load a file first.'); return; }
    if (!wasmReady) { setProgStatus('WASM not ready.'); return; }

    runProgressiveBtn.disabled = true;
    runProgressiveBtn.textContent = 'Running…';
    clearCompareSlots();
    clearPassTimeline();

    try {
        const size = getProgSize();
        const quality = getProgQuality();
        const requestedPassCount = getRequestedPassCount();
        const progressiveDetail = getRequestedProgressiveDetail(requestedPassCount);
        const previewFirst = !!(document.getElementById('prog-preview-first')?.checked);
        const progressiveFlavor = getRequestedProgressiveFlavor(requestedPassCount, previewFirst);

        setProgStatus(`Resizing to ${size === 'fullsize' ? 'full' : size + 'px'}…`);
        const resized = resizeRgba(selectedSource.rgba, selectedSource.width, selectedSource.height, size);

        setProgStatus(`Encoding ${resized.width}×${resized.height} Q${quality} progressive with ${requestedPassCount} stream steps…`);

        const encoder = createEncoder({
            format: 'rgba8',
            width: resized.width,
            height: resized.height,
            hasAlpha: true,
            quality,
            effort: 3,
            progressive: true,
            progressiveFlavor,
            previewFirst,
            chunked: false,
            modular: false,
            brotliEffort: 9,
            copyInput: true,
        });
        const encChunks = [];
        const chunkTask = (async () => {
            for await (const chunk of encoder.chunks()) {
                encChunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
            }
        })();
        const encStart = performance.now();
        await encoder.pushPixels(exactBuffer(resized.rgba));
        await encoder.finish();
        await chunkTask;
        const encodeMs = performance.now() - encStart;
        await encoder.dispose();
        const jxlBytes = concatChunks(encChunks);

        setProgStatus(`Encoded ${(jxlBytes.length / 1024).toFixed(1)} KB in ${encodeMs.toFixed(1)} ms · streaming into decoder…`);
        dbgLog('Encoded', `${(jxlBytes.length / 1024).toFixed(1)} KB in ${encodeMs.toFixed(1)} ms`, 'info');

        const decoder = createDecoder({
            format: 'rgba8',
            region: null,
            downsample: 1,
            progressionTarget: 'final',
            emitEveryPass: true,
            progressiveDetail,
            preserveIcc: false,
            preserveMetadata: false,
        });

        const decStart = performance.now();
        const passes = [];
        let passIdx = 0;
        const eventTask = (async () => {
            for await (const ev of decoder.events()) {
                if (ev.type === 'header') {
                    setProgStatus(`Decoder ready for ${ev.info.width}×${ev.info.height} progressive paints…`);
                } else if (ev.type === 'progress' || ev.type === 'final') {
                    const t = performance.now() - decStart;
                    const isFinal = ev.type === 'final';
                    const passRecord = {
                        passIdx,
                        t,
                        isFinal,
                        srcCanvas: makePassCanvas(ev.pixels, ev.info.width, ev.info.height),
                    };
                    addPassToTimeline(passRecord);
                    autoAssignPass(passRecord);
                    passes.push(passRecord);
                    dbgLog(`  pass ${passIdx + 1}${isFinal ? ' (final)' : ''}`, `${t.toFixed(1)} ms`, 'info');
                    passIdx++;
                    await nextPaint();
                } else if (ev.type === 'error') {
                    throw new Error(ev.message);
                }
            }
        })();
        const streamedSteps = await streamIntoDecoder(decoder, jxlBytes, requestedPassCount);
        await eventTask;
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
        const oneShotStart = performance.now();
        await decoder2.push(jxlBytes);
        await decoder2.close();
        let oneShotFinalMs = null;
        for await (const ev of decoder2.events()) {
            if (ev.type === 'final') oneShotFinalMs = performance.now() - oneShotStart;
            else if (ev.type === 'error') throw new Error(ev.message);
        }
        decoder2.dispose();

        renderProgressiveComparison({
            requestedPassCount: streamedSteps,
            passCount: passes.length,
            progressiveFirstMs,
            progressiveFinalMs,
            oneShotFinalMs,
            fileSizeKB: jxlBytes.length / 1024,
            encodeMs,
            previewFirst,
            progressiveDetail,
        });

        const summary = `${passes.length} paints · stream ${streamedSteps} steps · first ${progressiveFirstMs?.toFixed(1)} ms · final ${progressiveFinalMs?.toFixed(1)} ms · one-shot ${oneShotFinalMs?.toFixed(1)} ms`;
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
