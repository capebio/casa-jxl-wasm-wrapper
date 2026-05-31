import initRaw, * as rawWasm from './pkg/raw_converter_wasm.js';
import { createDecoder, createEncoder } from '@casabio/jxl-wasm';
import { initDebugConsole, dbgLog } from './jxl-debug-console.js';
import { createFilePicker } from './jxl-file-picker.js';

const { process_orf, rgb_to_rgba } = rawWasm;

let selectedSource = null;
let wasmReady = false;

// Last successful progressive run artifacts (for export)
let lastJxlBytes = null;
let lastJxlFileName = null;
let lastPassCount = 0;
let lastSettings = null; // {quality, passes, detail, size, previewFirst, ...}

// Structured measurement history (one entry per "Run Progressive Paint")
const runMeasurements = [];

// No-op: this page has no workflow state UI (unlike wrapper-lab / crop-benchmark)
function updateWorkflowState() {}

// Console page header — always shows which page this console belongs to (dev productivity across many open lab/benchmark tabs)
console.log('%c[Progressive Paint] jxl-progressive-paint.js loaded — progressive paint / live decode UI', 'color:#ec4899;font-weight:600', { page: 'Progressive Paint', url: location.href, t: new Date().toISOString(), ua: navigator.userAgent.slice(0, 120) });

// ─── WASM init ────────────────────────────────────────────────────────────────

initRaw().then(() => {
    wasmReady = true;
    dbgLog('WASM module initialized');
    updateWorkflowState?.();
}).catch(err => {
    dbgLog('Failed to init WASM: ' + err.message, '', 'error');
});

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const sourceInput = document.getElementById('source-input');
const sourceDrop = document.getElementById('source-drop');
const loadRandomBtn = document.getElementById('load-random');
const runProgressiveBtn = document.getElementById('run-progressive');
const dbgConsoleBtn = document.getElementById('dbg-console-btn');
const pickFileBtn = document.getElementById('pick-file-btn');
const currentSourceEl = document.getElementById('current-source');
const exportGalleryBtn = document.getElementById('export-gallery-btn');
const exportFolderBtn = document.getElementById('export-folder-btn');
const exportCsvBtn = document.getElementById('export-csv-btn');
const exportJsonBtn = document.getElementById('export-json-btn');
const exportToonBtn = document.getElementById('export-toon-btn');
const clearMeasurementsBtn = document.getElementById('clear-measurements-btn');

if (dbgConsoleBtn) initDebugConsole(dbgConsoleBtn);
if (pickFileBtn) pickFileBtn.addEventListener('click', () => sourceInput?.click());

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

// ─── Synced zoom + identical reticule across Compare A/B/C ────────────────────
let zoomLevel = 1;
let panX = 0;   // source-pixel offset from center (positive = image moves left under reticule)
let panY = 0;
let zoomArmed = false;
let viewPreset = 'fit'; // 'fit' | '100' | '400' — drives the 3-way toggle button

function updateZoomReadout() {
    const el = document.getElementById('zoom-readout');
    if (el) el.textContent = `${zoomLevel.toFixed(2)}×`;
}

function resetZoom(silent = false) {
    zoomLevel = 1;
    panX = 0;
    panY = 0;
    zoomArmed = false;
    viewPreset = 'fit';
    updateZoomReadout();
    updatePresetButton();
    const btn = document.getElementById('zoom-btn');
    if (btn) btn.classList.remove('is-armed');
    if (!silent) renderAllZoomedViews();
}

function cycleViewPreset() {
    if (viewPreset === 'fit') {
        viewPreset = '100';
        zoomLevel = 1;
        panX = 0;
        panY = 0;
    } else if (viewPreset === '100') {
        viewPreset = '400';
        zoomLevel = 4;
        panX = 0;
        panY = 0;
    } else {
        viewPreset = 'fit';
        zoomLevel = 1;
        panX = 0;
        panY = 0;
    }
    updatePresetButton();
    renderAllZoomedViews();
}

function updatePresetButton() {
    const btn = document.getElementById('zoom-reset');
    if (!btn) return;
    if (viewPreset === 'fit') btn.textContent = 'Fit';
    else if (viewPreset === '100') btn.textContent = '100%';
    else btn.textContent = '400%';
    btn.title = `View preset: ${btn.textContent} (click to cycle Fit → 100% actual pixels → 400%)`;
}

function getZoomViewRect(srcW, srcH) {
    if (zoomLevel <= 1.0001) {
        return { sx: 0, sy: 0, sw: srcW, sh: srcH };
    }
    const viewW = srcW / zoomLevel;
    const viewH = srcH / zoomLevel;
    const cx = srcW / 2 + panX;
    const cy = srcH / 2 + panY;
    const sx = Math.max(0, Math.min(srcW - viewW, cx - viewW / 2));
    const sy = Math.max(0, Math.min(srcH - viewH, cy - viewH / 2));
    return { sx, sy, sw: viewW, sh: viewH };
}

function drawReticule(ctx, w, h) {
    const cx = w / 2, cy = h / 2;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.25;
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 2;

    // Center cross (identical on all three viewers)
    const arm = Math.min(w, h) * 0.13;
    ctx.beginPath();
    ctx.moveTo(cx - arm, cy); ctx.lineTo(cx + arm, cy);
    ctx.moveTo(cx, cy - arm); ctx.lineTo(cx, cy + arm);
    ctx.stroke();

    // Small centering box
    const box = 6;
    ctx.fillRect(cx - box / 2, cy - box / 2, box, box);
    ctx.strokeRect(cx - box / 2, cy - box / 2, box, box);

    ctx.restore();
}

function renderAllZoomedViews() {
    for (const slot of compareSlots) {
        if (slot.currentSrc && slot.canvas) {
            paintCanvasIntoSlot(slot.currentSrc, slot.canvas, true);
        }
    }
    updateZoomReadout();
}

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
    // New photo selected — clear previous run's viewers + timeline + export so results don't mix across files
    clearCompareSlots();
    clearPassTimeline();
    updateTimelineVisibility(0);
    const rsLine = document.getElementById('run-status-line');
    if (rsLine) rsLine.hidden = true;
    clearLastExport();
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
    // New photo selected — clear previous run's viewers + timeline + export so results don't mix across files
    clearCompareSlots();
    clearPassTimeline();
    updateTimelineVisibility(0);
    const rsLine = document.getElementById('run-status-line');
    if (rsLine) rsLine.hidden = true;
    clearLastExport();
    updateUI();
}

function updateUI() {
    const ready = !!selectedSource;
    runProgressiveBtn.disabled = !ready;
    updateWorkflowState?.();
    runProgressiveBtn.title = ready ? '' : 'Load a file first';

    if (currentSourceEl) {
        currentSourceEl.textContent = selectedSource ? selectedSource.file : '';
    }
    // Exports only make sense after a successful run that produced a JXL
    const hasExport = !!lastJxlBytes;
    if (exportGalleryBtn) exportGalleryBtn.disabled = !hasExport;
    if (exportFolderBtn) exportFolderBtn.disabled = !hasExport;

    // Measurement exports (CSV/JSON) are enabled once we have any structured runs
    const hasMeasurements = runMeasurements.length > 0;
    if (exportCsvBtn) exportCsvBtn.disabled = !hasMeasurements;
    if (exportJsonBtn) exportJsonBtn.disabled = !hasMeasurements;
    if (exportToonBtn) exportToonBtn.disabled = !hasMeasurements;
    if (clearMeasurementsBtn) clearMeasurementsBtn.disabled = !hasMeasurements;
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

// Unified picker with memory (dropZone omitted — we use explicit Pick button + the hidden input)
const filePicker = createFilePicker({
    input: sourceInput,
    dropZone: null,
    multiple: false,
    accept: '.orf,.ORF,.jpg,.jpeg,.png,.tif,.tiff,.jxl,image/*',
    persistKey: 'jxl-progressive-paint-last-file',
    onFiles: (files) => {
        if (files[0]) loadFile(files[0]);
        updateWorkflowState();
    }
});

filePicker?.loadLastPersisted?.().then(f => f?.[0] && loadFile(f[0]));

if (loadRandomBtn) {
    loadRandomBtn.addEventListener('click', () => loadRandomImage());
}

if (runProgressiveBtn) {
    runProgressiveBtn.addEventListener('click', () => runProgressivePaintTest());
}

// ─── Synced zoom controls wiring ──────────────────────────────────────────────
const zoomBtn = document.getElementById('zoom-btn');
const zoomResetBtn = document.getElementById('zoom-reset');
const viewportTrio = document.getElementById('viewport-trio');

if (zoomBtn) {
    zoomBtn.addEventListener('click', () => {
        zoomArmed = !zoomArmed;
        zoomBtn.classList.toggle('is-armed', zoomArmed);
        if (zoomArmed && zoomLevel <= 1.0001) {
            // Give the user something immediate to scroll
            zoomLevel = 2.0;
            updateZoomReadout();
            renderAllZoomedViews();
        }
    });
}
if (zoomResetBtn) {
    zoomResetBtn.addEventListener('click', () => cycleViewPreset());
    // Initialize label
    updatePresetButton();
}

// Wheel zoom + drag pan. Only interferes with page scroll when armed or already zoomed in.
if (viewportTrio) {
    viewportTrio.addEventListener('wheel', (e) => {
        if (!zoomArmed && zoomLevel <= 1.0001) return;
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.13 : (1 / 1.13);
        zoomLevel = Math.max(0.4, Math.min(10, zoomLevel * factor));
        updateZoomReadout();
        renderAllZoomedViews();
    }, { passive: false });

    // Drag to pan (only meaningful when zoomed)
    let dragStart = null;
    viewportTrio.addEventListener('mousedown', (e) => {
        if (zoomLevel <= 1.0001) return;
        dragStart = { x: e.clientX, y: e.clientY, panX, panY };
    });
    window.addEventListener('mousemove', (e) => {
        if (!dragStart) return;
        const scale = 1.8 / zoomLevel; // faster panning at higher zoom
        panX = dragStart.panX - (e.clientX - dragStart.x) * scale;
        panY = dragStart.panY - (e.clientY - dragStart.y) * scale;
        renderAllZoomedViews();
    });
    window.addEventListener('mouseup', () => { dragStart = null; });

    // Double-click the viewer area resets zoom (convenient)
    viewportTrio.addEventListener('dblclick', () => {
        if (zoomLevel > 1) resetZoom();
    });
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

    // Also mirror into the results-area live status (so "current status and progress"
    // lives to the right of the Done summary line as requested).
    const live = document.getElementById('run-live-status');
    if (live) live.textContent = text;
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
        if (slot.labelEl) slot.labelEl.textContent = `Pass ${compareSlots.indexOf(slot) + 1}`;
        if (slot.infoEl) slot.infoEl.textContent = 'Waiting for pass.';
        slot.currentPass = null;
        slot.currentSrc = null;
    }
}

function clearPassTimeline() {
    const el = document.getElementById('pass-timeline');
    if (el) el.innerHTML = '';
}

function updateTimelineVisibility(passCount) {
    const timeline = document.getElementById('pass-timeline');
    if (!timeline) return;
    timeline.style.display = (passCount > 1) ? '' : 'none';
}

function clearLastExport() {
    lastJxlBytes = null;
    lastJxlFileName = null;
    lastPassCount = 0;
    lastSettings = null;
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

function paintCanvasIntoSlot(srcCanvas, slotCanvas, forceZoom = false) {
    if (!slotCanvas || !srcCanvas) return;
    const ctx = slotCanvas.getContext('2d');
    ctx.clearRect(0, 0, slotCanvas.width, slotCanvas.height);

    const sw = srcCanvas.width, sh = srcCanvas.height;
    const cw = slotCanvas.width, ch = slotCanvas.height;
    const useZoom = (viewPreset !== 'fit') || forceZoom || zoomLevel > 1.0001;

    if (!useZoom) {
        // Original letterbox-fit behavior (no reticule)
        const scale = Math.min(cw / sw, ch / sh);
        const dw = Math.max(1, Math.round(sw * scale));
        const dh = Math.max(1, Math.round(sh * scale));
        ctx.drawImage(srcCanvas, Math.round((cw - dw) / 2), Math.round((ch - dh) / 2), dw, dh);
        return;
    }

    // Zoomed / pixel mode: sample a sub-rect of the source and draw it magnified to fill the slot
    const view = getZoomViewRect(sw, sh);
    const isPixelMode = (viewPreset === '100' || viewPreset === '400');
    ctx.imageSmoothingEnabled = !isPixelMode;
    ctx.drawImage(
        srcCanvas,
        view.sx, view.sy, view.sw, view.sh,
        0, 0, cw, ch
    );
    ctx.imageSmoothingEnabled = true; // restore
    drawReticule(ctx, cw, ch);
}

function formatPassLabel(passRecord) {
    const stage = passRecord.isFinal ? 'final' : 'partial';
    return `Pass ${passRecord.passIdx + 1} · ${passRecord.t.toFixed(1)} ms · ${stage}`;
}

function assignPassToCompareSlot(passRecord, slotIndex = compareSlotCursor) {
    const slot = compareSlots[slotIndex];
    if (!slot || !slot.canvas) return;
    paintCanvasIntoSlot(passRecord.srcCanvas, slot.canvas);
    if (slot.labelEl) {
        const n = passRecord.passIdx + 1;
        const stage = passRecord.isFinal ? ' (final)' : '';
        slot.labelEl.textContent = `Pass ${n}${stage}`;
    }
    if (slot.infoEl) slot.infoEl.textContent = formatPassLabel(passRecord);
    if (passRecord.button) passRecord.button.dataset.slot = slot.slotName;
    slot.currentPass = passRecord;
    slot.currentSrc = passRecord.srcCanvas;
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
        // Choose a target slot that doesn't already show this exact pass.
        // Start at the current cursor and scan forward to avoid obvious duplicates.
        let target = compareSlotCursor;
        for (let i = 0; i < compareSlots.length; i++) {
            const s = compareSlots[target];
            if (!s || !s.currentPass || s.currentPass !== passRecord) {
                break;
            }
            target = (target + 1) % compareSlots.length;
        }
        assignPassToCompareSlot(passRecord, target);
        advanceCompareSlotCursor(target);
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
    resetZoom(true); // silent reset so every run starts at 1×
    clearCompareSlots();
    clearPassTimeline();

    // Reset bottom results status line for the new run
    const lineEl = document.getElementById('run-status-line');
    if (lineEl) lineEl.hidden = true;
    const doneEl = document.getElementById('run-done-summary');
    if (doneEl) doneEl.textContent = '';
    const liveEl = document.getElementById('run-live-status');
    if (liveEl) liveEl.textContent = '';

    try {
        const size = getProgSize();
        const quality = getProgQuality();
        const requestedPassCount = getRequestedPassCount();
        console.log('%c[Progressive Paint] run start', 'color:#ec4899;font-weight:600', { t: new Date().toISOString(), source: selectedSource?.name ?? selectedSource?.label ?? '?', size, quality, passCount: requestedPassCount });
        const detailChoice = document.querySelector('input[name="prog-detail"]:checked')?.value ?? 'auto';
        const progressiveDetail = detailChoice === 'auto'
            ? getRequestedProgressiveDetail(requestedPassCount)
            : detailChoice;
        const previewFirst = !!(document.getElementById('prog-preview-first')?.checked);
        const progressiveFlavor = (detailChoice !== 'auto' && detailChoice !== 'dc')
            ? 'ac'
            : getRequestedProgressiveFlavor(requestedPassCount, previewFirst);

        setProgStatus(`Resizing to ${size === 'fullsize' ? 'full' : size + 'px'}…`);
        const resized = resizeRgba(selectedSource.rgba, selectedSource.width, selectedSource.height, size);

        setProgStatus(`Encoding ${resized.width}×${resized.height} Q${quality} progressive with ${requestedPassCount} stream steps…`);
        dbgLog('Encoder config', `progressive=true, progressiveFlavor=${progressiveFlavor}, previewFirst=${previewFirst}, quality=${quality}, effort=3`, 'info');

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

        // Capture for export buttons (Progressive gallery / Folder)
        lastJxlBytes = jxlBytes;
        lastJxlFileName = `${(selectedSource?.file || 'source').replace(/\.[^.]+$/, '')}-prog-p${requestedPassCount}-q${quality}.jxl`;
        lastSettings = { size, quality, requestedPassCount, progressiveDetail, previewFirst };

        setProgStatus(`Encoded ${(jxlBytes.length / 1024).toFixed(1)} KB in ${encodeMs.toFixed(1)} ms · streaming into decoder…`);
        dbgLog('Encoded', `${(jxlBytes.length / 1024).toFixed(1)} KB in ${encodeMs.toFixed(1)} ms`, 'info');

        dbgLog('Creating decoder…', `format=rgba8, progressionTarget=final, emitEveryPass=true, progressiveDetail=${progressiveDetail}`, 'info');
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
        dbgLog('Decoder created', 'Starting event iteration…', 'info');

        const decStart = performance.now();
        const passes = [];
        let passIdx = 0;
        const eventTask = (async () => {
            dbgLog('Event loop started', 'Awaiting decoder.events()…', 'info');
            try {
                for await (const ev of decoder.events()) {
                    dbgLog(`Event: ${ev.type}`, ev.type, 'info');
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
                    dbgLog('Decoder error event', `code=${ev.code}, msg=${ev.message}`, 'error');
                    throw new Error(`Decoder error (${ev.code}): ${ev.message}`);
                }
            }
            } catch (evErr) {
                dbgLog('Event loop error', evErr instanceof Error ? evErr.message : String(evErr), 'error');
                throw evErr;
            }
        })();
        dbgLog('Pushing all bytes…', `${jxlBytes.length} bytes total`, 'info');
        await decoder.push(exactBuffer(jxlBytes));
        await decoder.close();
        dbgLog('All bytes pushed and closed', 'Waiting for event task…', 'info');
        await eventTask;
        dbgLog('Event task complete', `${passes.length} passes received`, 'info');
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

        // Capture structured measurement for CSV/JSON export (now that oneShotFinalMs is known)
        const measurement = {
            ts: new Date().toISOString(),
            source: selectedSource?.file || 'unknown',
            settings: lastSettings ? { ...lastSettings } : null,
            passesRequested: requestedPassCount,
            passesReceived: passes.length,
            perPass: passes.map(p => ({
                pass: p.passIdx + 1,
                t_ms: Number(p.t.toFixed(2)),
                isFinal: !!p.isFinal
            })),
            first_ms: progressiveFirstMs != null ? Number(progressiveFirstMs.toFixed(2)) : null,
            final_ms: progressiveFinalMs != null ? Number(progressiveFinalMs.toFixed(2)) : null,
            oneShot_ms: oneShotFinalMs != null ? Number(oneShotFinalMs.toFixed(2)) : null,
            encode_ms: Number(encodeMs.toFixed(2)),
            fileSizeKB: Number((jxlBytes.length / 1024).toFixed(1)),
            speedup: (oneShotFinalMs && progressiveFirstMs)
                ? Number((oneShotFinalMs / progressiveFirstMs).toFixed(2))
                : null
        };
        runMeasurements.push(measurement);

        renderProgressiveComparison({
            requestedPassCount,
            passCount: passes.length,
            progressiveFirstMs,
            progressiveFinalMs,
            oneShotFinalMs,
            fileSizeKB: jxlBytes.length / 1024,
            encodeMs,
            previewFirst,
            progressiveDetail,
        });

        const summary = `${passes.length} paints · first ${progressiveFirstMs?.toFixed(1)} ms · final ${progressiveFinalMs?.toFixed(1)} ms · one-shot ${oneShotFinalMs?.toFixed(1)} ms`;
        const doneText = `Done. ${summary}`;

        // Put the prominent "Done..." summary in the results area (left side of the new status line).
        const doneEl = document.getElementById('run-done-summary');
        const lineEl = document.getElementById('run-status-line');
        if (doneEl) doneEl.textContent = doneText;
        if (lineEl) lineEl.hidden = false;

        // This also feeds the .run-live-status to the right of it via the updated setProgStatus.
        setProgStatus(doneText);
        dbgLog('Progressive paint done', summary, 'success');

        // Only show the strip of small thumbnails if we actually got >1 pass for this photo
        updateTimelineVisibility(passes.length);
        lastPassCount = passes.length;
        updateUI(); // enable export buttons now that we have lastJxlBytes

    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errStack = err instanceof Error ? err.stack : '';
        setProgStatus(`Error: ${errMsg}`);
        dbgLog('Progressive paint error', errMsg, 'error');
        dbgLog('Error stack', errStack, 'error');
        console.error('Full error:', err);
    } finally {
        runProgressiveBtn.textContent = 'Run progressive paint';
        runProgressiveBtn.disabled = !selectedSource;
    }
}

// ─── Export handlers (Progressive gallery + Folder) ───────────────────────────

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

async function exportToGallery() {
    if (!lastJxlBytes) return;
    const name = lastJxlFileName || 'progressive-paint.jxl';
    triggerJxlDownload(lastJxlBytes, name);
    dbgLog('Exported JXL for gallery', name, 'success');
    // Open the gallery in a new tab. User can then use its "Pick file" to load the just-downloaded .jxl.
    window.open('./jxl-progressive-gallery.html', '_blank');
    dbgLog('Progressive gallery opened in new tab — use its file picker to load the downloaded JXL for multi-image progressive viewing.', '', 'info');
}

async function exportToFolder() {
    if (!lastJxlBytes || !lastJxlFileName) return;

    const entries = [{ filename: lastJxlFileName, bytes: lastJxlBytes }];

    if (typeof showDirectoryPicker === 'function') {
        let dirHandle;
        try {
            dirHandle = await showDirectoryPicker({ mode: 'readwrite' });
        } catch (e) {
            if (e.name === 'AbortError') return;
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
        dbgLog(`Saved ${saved}/${entries.length} JXL to folder`, lastJxlFileName, 'success');
    } else {
        dbgLog('showDirectoryPicker not available — falling back to download', '', 'warn');
        triggerJxlDownload(lastJxlBytes, lastJxlFileName);
    }
}

// Wire export buttons (already got refs earlier)
if (exportGalleryBtn) exportGalleryBtn.addEventListener('click', exportToGallery);
if (exportFolderBtn) exportFolderBtn.addEventListener('click', exportToFolder);

// ─── Structured measurements export (CSV + JSON) ──────────────────────────────

function downloadText(filename, text, mime = 'text/plain') {
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

function exportMeasurementsCSV() {
    if (!runMeasurements.length) return;

    const headers = [
        'ts', 'source', 'size', 'quality', 'passes_requested', 'passes_received',
        'first_ms', 'final_ms', 'oneShot_ms', 'speedup_x', 'encode_ms', 'file_kb',
        'pass_timings'
    ];

    const rows = runMeasurements.map(m => {
        const s = m.settings || {};
        const passTimings = (m.perPass || [])
            .map(p => `${p.pass}:${p.t_ms}${p.isFinal ? 'f' : ''}`)
            .join(';');

        return [
            m.ts,
            m.source,
            s.size ?? '',
            s.quality ?? '',
            m.passesRequested ?? '',
            m.passesReceived ?? '',
            m.first_ms ?? '',
            m.final_ms ?? '',
            m.oneShot_ms ?? '',
            m.speedup ?? '',
            m.encode_ms ?? '',
            m.fileSizeKB ?? '',
            passTimings
        ].map(v => {
            const str = String(v ?? '');
            // CSV escape
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                return '"' + str.replace(/"/g, '""') + '"';
            }
            return str;
        }).join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    downloadText(`progressive-paint-measurements-${ts}.csv`, csv, 'text/csv');
    dbgLog('Exported measurements', `${runMeasurements.length} runs → CSV`, 'success');
}

function exportMeasurementsJSON() {
    if (!runMeasurements.length) return;
    const json = JSON.stringify(runMeasurements, null, 2);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    downloadText(`progressive-paint-measurements-${ts}.json`, json, 'application/json');
    dbgLog('Exported measurements', `${runMeasurements.length} runs → JSON`, 'success');
}

function exportMeasurementsTOON() {
    if (!runMeasurements.length) return;

    const now = new Date().toISOString();

    // Richer shape: measurements array + meta object at root
    let out = `measurements[${runMeasurements.length}]:\n`;

    for (const m of runMeasurements) {
        const s = m.settings || {};
        out += `- ts: ${m.ts}\n`;
        out += `  source: ${quoteIfNeeded(m.source)}\n`;
        out += `  settings:\n`;
        out += `    size: ${s.size ?? ''}\n`;
        out += `    quality: ${s.quality ?? ''}\n`;
        out += `    passesRequested: ${m.passesRequested}\n`;
        out += `    detail: ${quoteIfNeeded(s.progressiveDetail ?? '')}\n`;
        if (m.first_ms != null) out += `  first_ms: ${m.first_ms}\n`;
        if (m.final_ms != null) out += `  final_ms: ${m.final_ms}\n`;
        if (m.oneShot_ms != null) out += `  oneShot_ms: ${m.oneShot_ms}\n`;
        if (m.speedup != null) out += `  speedup: ${m.speedup}\n`;
        out += `  encode_ms: ${m.encode_ms}\n`;
        out += `  fileSizeKB: ${m.fileSizeKB}\n`;

        // perPass as compact tabular array (TOON strength)
        if (m.perPass && m.perPass.length) {
            out += `  perPass[${m.perPass.length}]{pass,t_ms,isFinal}:\n`;
            for (const p of m.perPass) {
                const isFinal = p.isFinal ? 'true' : 'false';
                out += `    ${p.pass},${p.t_ms},${isFinal}\n`;
            }
        }
    }

    // Richer metadata at root level
    out += `meta:\n`;
    out += `  exportedAt: ${now}\n`;
    out += `  generator: jxl-progressive-paint\n`;
    out += `  count: ${runMeasurements.length}\n`;
    out += `  format: progressive-paint-measurements-v1\n`;

    const ts = now.replace(/[:.]/g, '-');
    downloadText(`progressive-paint-measurements-${ts}.toon`, out, 'text/toon');
    dbgLog('Exported measurements', `${runMeasurements.length} runs → TOON`, 'success');
}

function quoteIfNeeded(str) {
    if (!str) return '';
    const needsQuotes = /[\s,:[\]{}"\\]/.test(str) || str === 'true' || str === 'false' || str === 'null';
    if (needsQuotes) {
        return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }
    return str;
}

function clearMeasurements() {
    runMeasurements.length = 0;
    dbgLog('Measurement history cleared', '', 'warn');
    updateUI();
}

if (exportCsvBtn) exportCsvBtn.addEventListener('click', exportMeasurementsCSV);
if (exportJsonBtn) exportJsonBtn.addEventListener('click', exportMeasurementsJSON);
if (exportToonBtn) exportToonBtn.addEventListener('click', exportMeasurementsTOON);
if (clearMeasurementsBtn) clearMeasurementsBtn.addEventListener('click', clearMeasurements);

dbgLog('Progressive paint initialized');
