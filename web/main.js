// Main thread.  Builds a Worker pool, dispatches each ORF to a free worker,
// streams events back (thumb → lightbox-preview → JXL bytes), and renders
// thumbnails + a clickable lightbox grid.
//
// Worker code lives in ./worker.js — one wasm instance + jSquash JXL
// encoder per worker, single-threaded inside.  Pool size scales with
// `navigator.hardwareConcurrency` so a batch saturates all cores.

const POOL_SIZE = Math.min(navigator.hardwareConcurrency || 4, 12);

// Build tag the page reports — lets you tell at a glance whether the
// browser is on the latest version after a refresh.
const BUILD_TAG = '2026-05-13c / fast-preview + orientation';

// Visible build badge — top-left corner, always present.
{
    const badge = document.createElement('div');
    badge.id = 'build-badge';
    badge.textContent = BUILD_TAG;
    document.body.appendChild(badge);
}

// Info popover
{
    const btn = document.getElementById('info-btn');
    const pop = document.getElementById('info-popover');
    document.getElementById('info-build-tag').textContent = BUILD_TAG;
    document.getElementById('info-pool-size').textContent = POOL_SIZE;
    document.getElementById('info-hw-cores').textContent = navigator.hardwareConcurrency || '?';
    btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; });
    pop.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => { pop.hidden = true; });
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const grid = document.getElementById('grid');
const drop = document.getElementById('drop');
const pick = document.getElementById('pick');
const fileInput = document.getElementById('file-input');
const statusBar = document.getElementById('status');
const progressEl = document.getElementById('progress');
const statusText = document.getElementById('status-text');

const lightbox = document.getElementById('lightbox');
const lightboxCanvas = document.getElementById('lightbox-canvas');
const lightboxInfo = lightbox.querySelector('.lightbox-info');
const lightboxClose = lightbox.querySelector('.lightbox-close');
const lightboxPrev = lightbox.querySelector('.lightbox-prev');
const lightboxNext = lightbox.querySelector('.lightbox-next');
const lbViewport = lightbox.querySelector('.lightbox-viewport');
const lbZoomLabel = lightbox.querySelector('.lb-zoom-label');
const lbZoomIn = lightbox.querySelector('.lb-zoom-in');
const lbZoomOut = lightbox.querySelector('.lb-zoom-out');
const lbZoomReset = lightbox.querySelector('.lb-zoom-reset');
const lbDownloadBtn = lightbox.querySelector('.lb-download-btn');
const lbPreviewBadge = lightbox.querySelector('.lb-preview-badge');
const lbLoadingBadge = lightbox.querySelector('.lb-loading-badge');

const qualityRange = document.getElementById('quality-range');
const qualityLabel = document.getElementById('quality-label');
const effortSelect = document.getElementById('effort-select');
const losslessToggle = document.getElementById('lossless-toggle');

const reprocessBtn = document.getElementById('reprocess-btn');
const applyLookBtn = document.getElementById('apply-look');
const resetLookBtn = document.getElementById('reset-look');
const contrastBoostEl = document.getElementById('contrast-boost');
const presetBtns = [...document.querySelectorAll('[data-preset]')];

// LR-style controls are declared as <input data-look="<name>"> in the
// markup; we discover them at runtime so the JS doesn't need to know every
// slider by id.  Each control reports a [-100, 100] integer except
// exposureEv which is [-3, +3] EV.  Internally the pipeline takes ±1
// normalised values, so we divide the integer by 100 before forwarding.
const lookInputs = [...document.querySelectorAll('[data-look]')];
const lookLabels = new Map(
    [...document.querySelectorAll('[data-label]')].map((el) => [el.dataset.label, el]),
);

function lookValueFor(name) {
    const el = lookInputs.find((i) => i.dataset.look === name);
    if (!el) return 0;
    const raw = Number(el.value);
    if (name === 'exposureEv') return raw;          // already in stops
    return raw / 100;                                // -100..+100 → -1..+1
}

function lookDisplay(name) {
    const el = lookInputs.find((i) => i.dataset.look === name);
    if (!el) return '0';
    const v = Number(el.value);
    if (name === 'exposureEv') return v.toFixed(2);
    return String(v | 0);
}

function refreshLookLabels() {
    for (const [name, el] of lookLabels) el.textContent = lookDisplay(name);
}

function looksTouched() {
    return lookInputs.some((el) => Number(el.value) !== 0);
}

const statsLog = document.getElementById('stats-log');
const copyStatsBtn = document.getElementById('copy-stats');
const clearStatsBtn = document.getElementById('clear-stats');

// Seed the stats log with build / env info so the paste-back is self-describing.
const statsLines = [];
function pushStat(line) {
    statsLines.push(line);
    statsLog.textContent = statsLines.join('\n');
    statsLog.scrollTop = statsLog.scrollHeight;
}
pushStat(`build:        ${BUILD_TAG}`);
pushStat(`pool size:    ${POOL_SIZE}`);
pushStat(`hw cores:     ${navigator.hardwareConcurrency || '?'}`);
pushStat(`UA:           ${navigator.userAgent}`);
pushStat('');

copyStatsBtn.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(statsLog.textContent);
        copyStatsBtn.textContent = 'copied';
        setTimeout(() => (copyStatsBtn.textContent = 'Copy'), 1200);
    } catch (e) {
        copyStatsBtn.textContent = 'copy failed';
    }
});
clearStatsBtn.addEventListener('click', () => {
    statsLines.length = 0;
    pushStat(`build:        ${BUILD_TAG}`);
    pushStat(`pool size:    ${POOL_SIZE}`);
    pushStat(`hw cores:     ${navigator.hardwareConcurrency || '?'}`);
    pushStat(`UA:           ${navigator.userAgent}`);
    pushStat('');
});

function fmtMs(v) { return (v ?? 0).toFixed(0).padStart(5, ' ') + ' ms'; }
function fmtKb(v) { return (v / 1024).toFixed(0).padStart(5, ' ') + ' KB'; }

let statSeq = 0;

// ---------------------------------------------------------------------------
// Look slider state persistence
// ---------------------------------------------------------------------------
const LOOK_STATE_KEY = 'orf-look-state';

function saveLookState() {
    const state = {};
    for (const el of lookInputs) state[el.dataset.look] = el.value;
    state['contrast-boost'] = contrastBoostEl.checked;
    try { localStorage.setItem(LOOK_STATE_KEY, JSON.stringify(state)); } catch {}
}

function restoreLookState() {
    try {
        const state = JSON.parse(localStorage.getItem(LOOK_STATE_KEY));
        if (!state) return;
        for (const el of lookInputs) {
            if (state[el.dataset.look] !== undefined) el.value = state[el.dataset.look];
        }
        if (state['contrast-boost'] !== undefined) contrastBoostEl.checked = !!state['contrast-boost'];
        refreshLookLabels();
    } catch {}
}
restoreLookState();

// ---------------------------------------------------------------------------
// Encoder option state
// ---------------------------------------------------------------------------
function currentLook() {
    return {
        exposureEv: lookValueFor('exposureEv'),
        contrast:   Math.max(-1, Math.min(1, lookValueFor('contrast') + (contrastBoostEl.checked ? 0.15 : 0.0))),
        highlights: lookValueFor('highlights'),
        shadows:    lookValueFor('shadows'),
        whites:     lookValueFor('whites'),
        blacks:     lookValueFor('blacks'),
        saturation: lookValueFor('saturation'),
        vibrance:   lookValueFor('vibrance'),
        temp:       lookValueFor('temp'),
        tint:       lookValueFor('tint'),
        texture:    lookValueFor('texture'),
        clarity:    lookValueFor('clarity'),
    };
}

function currentOptions() {
    return {
        quality: Number(qualityRange.value),
        effort: Number(effortSelect.value),
        lossless: losslessToggle.checked,
        look: currentLook(),
        // WB R/B numeric override — no longer surfaced as sliders.  Temp /
        // tint sliders give relative shifts; auto WB used as base.
        wbR: NaN,
        wbB: NaN,
    };
}

qualityRange.addEventListener('input', () => {
    qualityLabel.textContent = qualityRange.value;
});
losslessToggle.addEventListener('change', () => {
    qualityRange.disabled = losslessToggle.checked;
});

for (const el of lookInputs) {
    el.addEventListener('input', () => {
        const name = el.dataset.look;
        const lbl = lookLabels.get(name);
        if (lbl) lbl.textContent = lookDisplay(name);
        saveLookState();
        scheduleLiveUpdate();
        scheduleGalleryLiveUpdate();
    });
}

reprocessBtn.addEventListener('click', () => reprocessSelected());

applyLookBtn.addEventListener('click', () => {
    const selected = cards.filter(c => c.classList.contains('selected') && c._file);
    const targets = selected.length ? selected : cards.filter(c => c._file);
    if (!targets.length) return;
    if (!selected.length) {
        // No explicit selection — select all, then reprocess all.
        for (const c of cards) {
            if (c._file) {
                c.classList.add('selected');
                c.querySelector('.thumb-select').textContent = '✓';
            }
        }
        refreshReprocessLabel();
    }
    reprocessSelected();
});

resetLookBtn.addEventListener('click', () => {
    for (const el of lookInputs) el.value = '0';
    contrastBoostEl.checked = false;
    refreshLookLabels();
    saveLookState();
    scheduleLiveUpdate();
    scheduleGalleryLiveUpdate();
});

// ---------------------------------------------------------------------------
// Presets (1-10, stored in localStorage)
// ---------------------------------------------------------------------------
const PRESET_STORAGE_KEY = 'orf-converter-presets';
let presets = (() => {
    try { return JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY)) || new Array(10).fill(null); }
    catch { return new Array(10).fill(null); }
})();

function savePresetsToStorage() {
    try { localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets)); } catch {}
}

function applyLookValues(look) {
    for (const el of lookInputs) {
        const name = el.dataset.look;
        const v = look[name] ?? 0;
        el.value = name === 'exposureEv' ? v : v * 100;
    }
    contrastBoostEl.checked = false;
    refreshLookLabels();
    scheduleLiveUpdate();
    scheduleGalleryLiveUpdate();
}

function updatePresetButtons() {
    for (const btn of presetBtns) {
        const slot = Number(btn.dataset.preset);
        const p = presets[slot];
        btn.classList.toggle('assigned', !!p);
        btn.title = p ? p.name : `Click to assign current look to slot ${slot + 1}`;
    }
}

for (const btn of presetBtns) {
    btn.addEventListener('click', (e) => {
        const slot = Number(btn.dataset.preset);
        if (e.shiftKey || !presets[slot]) {
            // Assign current look to this slot
            const defaultName = `Preset ${slot + 1}`;
            const name = prompt('Name this preset:', defaultName);
            if (name === null) return; // cancelled
            presets[slot] = { name: name || defaultName, look: currentLook() };
            savePresetsToStorage();
            updatePresetButtons();
        } else {
            applyLookValues(presets[slot].look);
        }
    });
}
updatePresetButtons();

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------
class WorkerPool {
    constructor(size) {
        this.size = size;
        this.workers = [];
        this.free = [];
        this.queue = [];
        this.tasks = new Map(); // id → handlers
        this.nextId = 1;
        this.workerForTask = new Map(); // taskId → worker (populated on _releaseWorker)
    }

    init() {
        for (let i = 0; i < this.size; i++) {
            this._spawnWorker();
        }
    }

    _spawnWorker() {
        const w = new Worker(new URL('./worker.js', import.meta.url), {
            type: 'module',
        });
        w.addEventListener('message', (ev) => this._onMessage(w, ev));
        w.addEventListener('error', (ev) => {
            console.error('worker error:', ev);
            // Find any pending task assigned to this worker and unblock it.
            for (const [id, t] of this.tasks) {
                if (t.worker === w && !t.released) {
                    if (t.handlers.onError) {
                        t.handlers.onError({ type: 'error', error: ev.message || 'worker crashed' });
                    }
                    this.tasks.delete(id);
                    break;
                }
            }
            // Remove the dead worker — do NOT return it to free pool.
            const wi = this.workers.indexOf(w);
            if (wi !== -1) this.workers.splice(wi, 1);
            const fi = this.free.indexOf(w);
            if (fi !== -1) this.free.splice(fi, 1);
            // Dispatch any queued task with remaining workers; also shrink size
            // so subsequent submits don't wait forever.
            this.size = Math.max(1, this.size - 1);
            const next = this.queue.shift();
            if (next) this._dispatch(next);
        });
        this.workers.push(w);
        this.free.push(w);
    }

    submit(bytes, options, handlers) {
        const id = this.nextId++;
        this.tasks.set(id, { handlers, worker: null, released: false });
        this._dispatch({ id, bytes, options });
        return id;
    }

    _dispatch(task) {
        const w = this.free.pop();
        if (!w) {
            this.queue.push(task);
            return;
        }
        this.tasks.get(task.id).worker = w;
        // Transfer the ORF bytes so we don't hold a copy in the main thread.
        w.postMessage(task, [task.bytes.buffer]);
    }

    _onMessage(worker, ev) {
        const { id, type } = ev.data;
        if (type === 'lightbox_live' || type === 'error_live') {
            if (this._liveHandler) this._liveHandler(ev.data);
            return;
        }
        if (type === 'thumb_live') {
            if (this._thumbLiveHandler) this._thumbLiveHandler(ev.data);
            return;
        }
        const t = this.tasks.get(id);
        if (!t) return;
        const handlers = t.handlers;
        if (type === 'thumb' && handlers.onThumb) handlers.onThumb(ev.data);
        else if (type === 'lightbox' && handlers.onLightbox) {
            handlers.onLightbox(ev.data);
            // Release worker immediately — JXL encode continues async in the worker
            // (the async handler yields at await encode_jxl, so a new ORF message
            // can be picked up concurrently without state collision).
            this._releaseWorker(worker, id);
        }
        else if (type === 'done') {
            if (handlers.onDone) handlers.onDone(ev.data);
            this.tasks.delete(id);  // Worker already freed on lightbox
            this.workerForTask.delete(id);
        } else if (type === 'error') {
            if (handlers.onError) handlers.onError(ev.data);
            // Error may arrive before or after lightbox — only release worker if not yet done.
            if (!t.released) this._releaseWorker(worker, id);
            this.tasks.delete(id);
            this.workerForTask.delete(id);
        }
    }

    // Release the worker slot for the next queued ORF without deleting the task
    // (task stays alive until 'done' or 'error' arrives with the JXL result).
    _releaseWorker(worker, id) {
        const t = this.tasks.get(id);
        if (t) t.released = true;
        // Track which worker owns this taskId so reprocessLive can find it.
        this.workerForTask.set(id, worker);
        if (!worker._taskIds) worker._taskIds = new Set();
        worker._taskIds.add(id);
        this.free.push(worker);
        const next = this.queue.shift();
        if (next) this._dispatch(next);
    }

    // Full release (error before lightbox, or legacy callers).
    _release(worker, id) {
        this.tasks.delete(id);
        this._releaseWorker(worker, id);
    }

    setLiveHandler(fn) { this._liveHandler = fn; }
    setThumbLiveHandler(fn) { this._thumbLiveHandler = fn; }

    reprocessLive(taskId, look) {
        const worker = this.workerForTask.get(taskId);
        if (!worker) return false;
        worker.postMessage({ id: taskId, type: 'reprocess_live', look });
        return true;
    }

    reprocessAllLive(taskIds, look) {
        if (!taskIds.length) return;
        const wanted = new Set(taskIds);
        for (const w of this.workers) {
            if (!w._taskIds) continue;
            const mine = [...w._taskIds].filter(id => wanted.has(id));
            if (mine.length) w.postMessage({ type: 'reprocess_thumb_live', taskIds: mine, look });
        }
    }
}

const pool = new WorkerPool(POOL_SIZE);
pool.init();

// ---------------------------------------------------------------------------
// Live lightbox re-render (debounced, in-flight gating)
// ---------------------------------------------------------------------------
let liveDebounceTimer = null;
let liveInFlight = false;
let livePendingLook = null;

function scheduleLiveUpdate() {
    if (lightboxIndex < 0) return;
    clearTimeout(liveDebounceTimer);
    liveDebounceTimer = setTimeout(() => {
        if (liveInFlight) {
            livePendingLook = currentLook();
            return;
        }
        triggerLiveUpdate(currentLook());
    }, 80);
}

function triggerLiveUpdate(look) {
    const card = cards[lightboxIndex];
    if (!card || !card._taskId) return;
    if (!pool.reprocessLive(card._taskId, look)) return;
    liveInFlight = true;
}

pool.setLiveHandler((msg) => {
    if (msg.type === 'error_live') {
        console.warn('live reprocess error:', msg.error);
        liveInFlight = false;
        if (livePendingLook) {
            const pending = livePendingLook;
            livePendingLook = null;
            triggerLiveUpdate(pending);
        }
        return;
    }
    liveInFlight = false;
    if (lightboxIndex >= 0) {
        const card = cards[lightboxIndex];
        if (msg.type === 'lightbox_live' && card && msg.id === card._taskId) {
            // Update pixels without resetting zoom
            const ctx = lightboxCanvas.getContext('2d');
            const rgba = rgbToRgba(msg.rgb, msg.w, msg.h);
            ctx.putImageData(new ImageData(rgba, msg.w, msg.h), 0, 0);
        }
    }
    if (livePendingLook) {
        const pending = livePendingLook;
        livePendingLook = null;
        triggerLiveUpdate(pending);
    }
});

contrastBoostEl.addEventListener('change', () => { saveLookState(); scheduleLiveUpdate(); scheduleGalleryLiveUpdate(); });

// ---------------------------------------------------------------------------
// Gallery live thumb re-render (debounced, fans out to all selected cards)
// ---------------------------------------------------------------------------
const cardByTaskId = new Map();
let galleryDebounceTimer = null;

function scheduleGalleryLiveUpdate() {
    clearTimeout(galleryDebounceTimer);
    galleryDebounceTimer = setTimeout(() => triggerGalleryLiveUpdate(currentLook()), 80);
}

function triggerGalleryLiveUpdate(look) {
    const taskIds = cards
        .filter(c => c.classList.contains('selected') && c._taskId)
        .map(c => c._taskId);
    pool.reprocessAllLive(taskIds, look);
}

pool.setThumbLiveHandler((msg) => {
    const card = cardByTaskId.get(msg.id);
    if (card) drawCanvas(card.querySelector('canvas'), msg.w, msg.h, msg.rgb);
});

// ---------------------------------------------------------------------------
// Card grid + per-file state
// ---------------------------------------------------------------------------
const cards = []; // ordered list of card elements for lightbox prev/next

function makeCard(name) {
    const card = document.createElement('div');
    card.className = 'thumb busy';
    card.innerHTML = `
        <canvas></canvas>
        <div class="thumb-select" title="Select for re-process">·</div>
        <a class="download" hidden></a>
        <button class="thumb-dl-btn" hidden title="Download JPEG">⬇ JPEG</button>
        <div class="meta">
            <span class="name"></span>
            <span class="time"></span>
            <span class="size"></span>
        </div>
    `;
    card.querySelector('.name').textContent = name.replace(/\.orf$/i, '');
    card.querySelector('.download').addEventListener('click', (e) => e.stopPropagation());
    card.querySelector('.thumb-select').addEventListener('click', (e) => {
        e.stopPropagation();
        card.classList.toggle('selected');
        card.querySelector('.thumb-select').textContent =
            card.classList.contains('selected') ? '✓' : '·';
        refreshReprocessLabel();
    });
    card.querySelector('.thumb-dl-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const stem = (card._file?.name || 'image').replace(/\.orf$/i, '');
        const cv = card.querySelector('canvas');
        cv.toBlob((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = stem + '.jpg'; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        }, 'image/jpeg', 0.95);
    });
    card.addEventListener('click', () => openLightbox(card));
    return card;
}

function refreshReprocessLabel() {
    const n = document.querySelectorAll('.thumb.selected').length;
    reprocessBtn.textContent = n ? `Re-process ${n} selected` : 'Re-process all';
}

// ---------------------------------------------------------------------------
// Gallery view mode (rect / square / natural) — persisted
// ---------------------------------------------------------------------------
const VIEW_MODE_KEY = 'orf-view-mode';
const viewBtns = [...document.querySelectorAll('.view-btn')];

function setViewMode(mode) {
    grid.classList.remove('view-square', 'view-natural');
    if (mode === 'square')  grid.classList.add('view-square');
    if (mode === 'natural') grid.classList.add('view-natural');
    for (const btn of viewBtns) btn.classList.toggle('active', btn.dataset.view === mode);
    try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch {}
}

for (const btn of viewBtns) {
    btn.addEventListener('click', () => setViewMode(btn.dataset.view));
}

// Restore persisted mode (default: rect).
setViewMode((() => { try { return localStorage.getItem(VIEW_MODE_KEY) || 'rect'; } catch { return 'rect'; } })());

function rgbToRgba(rgb, w, h) {
    const n = w * h;
    const buf = new ArrayBuffer(n * 4);
    const rgba = new Uint8ClampedArray(buf);
    const u32 = new Uint32Array(buf);
    // Pack RGBA as little-endian 0xFFBBGGRR using Uint32 writes (~4x fewer stores).
    for (let i = 0, p = 0; i < n; i++, p += 3) {
        u32[i] = (rgb[p]) | (rgb[p + 1] << 8) | (rgb[p + 2] << 16) | 0xFF000000;
    }
    return rgba;
}

function drawCanvas(canvas, w, h, rgb) {
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    // If worker already sent RGBA (byteLength === w*h*4) use it directly.
    const rgba = (rgb.byteLength === w * h * 4)
        ? (rgb instanceof Uint8ClampedArray ? rgb : new Uint8ClampedArray(rgb.buffer))
        : rgbToRgba(rgb, w, h);
    ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
}

let totalSubmitted = 0;
let totalDone = 0;

// ---------------------------------------------------------------------------
// Embedded JPEG thumbnail extraction + orientation (pure JS, before WASM)
// ---------------------------------------------------------------------------
function sized(srcW, srcH, longEdge) {
    if (srcW >= srcH) {
        const w = Math.min(longEdge, srcW);
        return { w, h: Math.max(1, Math.round((srcH * w) / srcW)) };
    }
    const h = Math.min(longEdge, srcH);
    return { w: Math.max(1, Math.round((srcW * h) / srcH)), h };
}

// Extract all JPEG bitstreams embedded in a RAW/TIFF container.
// Strategy: find every SOI (FF D8 FF). For each, take the LAST FF D9 before
// the next SOI — this avoids truncation by entropy-coded FF D9 runs.
// Returns an array of Uint8Array blobs (unvalidated; createImageBitmap filters).
function extractEmbeddedJpegs(bytes) {
    const sois = [];
    for (let i = 0; i < bytes.length - 2; i++) {
        if (bytes[i] === 0xFF && bytes[i + 1] === 0xD8 && bytes[i + 2] === 0xFF) {
            sois.push(i);
            i += 2;
        }
    }
    const blobs = [];
    for (let n = 0; n < sois.length; n++) {
        const start = sois[n];
        const end = n + 1 < sois.length ? sois[n + 1] : bytes.length;
        let eoi = -1;
        for (let j = end - 2; j >= start + 2; j--) {
            if (bytes[j] === 0xFF && bytes[j + 1] === 0xD9) { eoi = j; break; }
        }
        if (eoi !== -1) blobs.push(bytes.slice(start, eoi + 2));
    }
    return blobs;
}

// Parse EXIF orientation (tag 0x0112) from a JPEG byte array.
// Returns 1 (normal) when absent or unreadable.
function readJpegOrientation(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return 1;
    let i = 2;
    while (i + 4 <= bytes.length) {
        if (bytes[i] !== 0xFF) break;
        const marker = bytes[i + 1];
        const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
        if (marker === 0xE1 && i + 10 <= bytes.length &&
            bytes[i+4]===0x45&&bytes[i+5]===0x78&&bytes[i+6]===0x69&&
            bytes[i+7]===0x66&&bytes[i+8]===0x00&&bytes[i+9]===0x00) {
            const t = i + 10; // TIFF header base
            const le = bytes[t] === 0x49;
            const r16 = o => le ? (bytes[t+o] | bytes[t+o+1]<<8)
                                : (bytes[t+o]<<8 | bytes[t+o+1]);
            const r32 = o => le
                ? ((bytes[t+o] | bytes[t+o+1]<<8 | bytes[t+o+2]<<16 | bytes[t+o+3]<<24) >>> 0)
                : ((bytes[t+o]<<24 | bytes[t+o+1]<<16 | bytes[t+o+2]<<8 | bytes[t+o+3]) >>> 0);
            const ifd0 = r32(4);
            if (t + ifd0 + 2 > bytes.length) break;
            const nEntries = r16(ifd0);
            for (let e = 0; e < nEntries; e++) {
                const off = ifd0 + 2 + e * 12;
                if (t + off + 12 > bytes.length) break;
                if (r16(off) === 0x0112) return r16(off + 8); // SHORT inline value
            }
            break;
        }
        if (marker === 0xDA || segLen < 2) break; // SOS — no more metadata
        i += 2 + segLen;
    }
    return 1;
}

// Draw a bitmap into canvas at thumbnail size, applying EXIF orientation via
// canvas transform (scaled to fit longEdge). Orientations 5-8 swap axes.
// Transform derivation: scaled version of the standard EXIF canvas transforms.
function drawOrientedThumb(canvas, bmp, orientation, longEdge) {
    const o = (orientation >= 1 && orientation <= 8) ? orientation : 1;
    const swap = o >= 5;
    const srcW = bmp.width, srcH = bmp.height;
    const dispW = swap ? srcH : srcW;
    const dispH = swap ? srcW : srcH;
    const { w: tw, h: th } = sized(dispW, dispH, longEdge);
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    if (o === 1) { ctx.drawImage(bmp, 0, 0, tw, th); return; }
    const sx = tw / dispW, sy = th / dispH;
    ctx.save();
    // Each case is the full-size EXIF transform with (srcW,srcH) replaced by
    // (tw/sx, th/sy) = (dispW, dispH) and translation scaled accordingly.
    switch (o) {
        case 2: ctx.transform(-sx,  0,   0,  sy,  tw,  0); break;
        case 3: ctx.transform(-sx,  0,   0, -sy,  tw, th); break;
        case 4: ctx.transform( sx,  0,   0, -sy,   0, th); break;
        case 5: ctx.transform(  0, sx,  sy,   0,   0,  0); break;
        case 6: ctx.transform(  0, sx, -sy,   0,  tw,  0); break;
        case 7: ctx.transform(  0,-sx, -sy,   0,  tw, th); break;
        case 8: ctx.transform(  0,-sx,  sy,   0,   0, th); break;
    }
    ctx.drawImage(bmp, 0, 0, srcW, srcH);
    ctx.restore();
}

// Draw a bitmap at full display size with EXIF orientation (for lightbox).
function drawBitmapOriented(canvas, bmp, orientation) {
    const o = (orientation >= 1 && orientation <= 8) ? orientation : 1;
    const swap = o >= 5;
    const srcW = bmp.width, srcH = bmp.height;
    const dW = swap ? srcH : srcW, dH = swap ? srcW : srcH;
    canvas.width = dW; canvas.height = dH;
    const ctx = canvas.getContext('2d');
    if (o === 1) { ctx.drawImage(bmp, 0, 0); return; }
    ctx.save();
    switch (o) {
        case 2: ctx.transform(-1, 0,  0,  1,  dW,  0); break;
        case 3: ctx.transform(-1, 0,  0, -1,  dW, dH); break;
        case 4: ctx.transform( 1, 0,  0, -1,   0, dH); break;
        case 5: ctx.transform( 0, 1,  1,  0,   0,  0); break;
        case 6: ctx.transform( 0, 1, -1,  0,  dW,  0); break;
        case 7: ctx.transform( 0,-1, -1,  0,  dW, dH); break;
        case 8: ctx.transform( 0,-1,  1,  0,   0, dH); break;
    }
    ctx.drawImage(bmp, 0, 0, srcW, srcH);
    ctx.restore();
}

// How many bytes to read upfront for embedded JPEG extraction.
// Olympus ORF stores the embedded preview within the first ~1–2 MB; 3 MB is safe.
const PREVIEW_SLICE = 3 * 1024 * 1024;

function startConvert(file, existingCard) {
    const card = existingCard || makeCard(file.name);
    if (!existingCard) {
        cards.push(card);
        grid.appendChild(card);
    } else {
        // Re-processing: clear prior download link + reset state classes.
        card.classList.remove('encoding', 'error', 'embedded-thumb');
        card.classList.add('busy');
        const link = card.querySelector('.download');
        link.hidden = true;
        link.removeAttribute('href');
        card._lightbox = null;
        if (card._embeddedPreview) { card._embeddedPreview.bmp.close(); card._embeddedPreview = null; }
    }
    totalSubmitted++;
    card._file = file;
    refreshStatus();

    // Phase A — fast: read only the first PREVIEW_SLICE bytes to extract the
    // embedded JPEG preview and show an oriented thumbnail immediately.
    // Runs concurrently with the full read below; failure is non-fatal.
    file.slice(0, PREVIEW_SLICE).arrayBuffer().then(sliceBuf => {
        const bytes = new Uint8Array(sliceBuf);
        const candidates = extractEmbeddedJpegs(bytes);
        if (!candidates.length) return;
        Promise.allSettled(
            candidates.map(c => {
                const orientation = readJpegOrientation(c);
                return createImageBitmap(new Blob([c], { type: 'image/jpeg' }))
                    .then(bmp => ({ bmp, pixels: bmp.width * bmp.height,
                                    w: bmp.width, h: bmp.height, orientation }));
            })
        ).then(results => {
            const valid = results
                .filter(r => r.status === 'fulfilled')
                .map(r => r.value)
                .sort((a, b) => a.pixels - b.pixels);
            if (!valid.length) { pushStat('[jpeg] 0 valid'); return; }

            pushStat('[jpeg] ' + valid.map(v => `${v.w}×${v.h} ori${v.orientation}`).join(' + '));

            const largest = valid[valid.length - 1];

            if (card.classList.contains('busy') || card.classList.contains('embedded-thumb')) {
                drawOrientedThumb(card.querySelector('canvas'), largest.bmp, largest.orientation, 360);
                card.classList.remove('busy');
                card.classList.add('embedded-thumb');
            }

            card._embeddedPreview = { bmp: largest.bmp, w: largest.w, h: largest.h,
                                      orientation: largest.orientation };
            if (lightboxIndex >= 0 && cards[lightboxIndex] === card && !card._lightbox) {
                drawLightboxForCard(card);
                resetLbZoom();
            }

            for (let vi = 0; vi < valid.length - 1; vi++) valid[vi].bmp.close();
        });
    }).catch(() => {}); // preview failure is non-fatal

    // Phase B+C — full file read for WASM pipeline + JXL encode.
    file.arrayBuffer()
        .then((buf) => {
            const bytes = new Uint8Array(buf);
            const taskId = pool.submit(bytes, currentOptions(), {
                onThumb(msg) {
                    drawCanvas(card.querySelector('canvas'), msg.w, msg.h, msg.rgb);
                    card._pipelineMs = msg.pipelineMs;
                    card._phaseMs = msg.phaseMs;
                    card._wb = { r: msg.wbR, b: msg.wbB };
                    card._colorMatrixFromMn = msg.colorMatrixFromMn;
                    card._camera = [msg.make, msg.model].filter(Boolean).join(' ') || '?';
                    card._exif = msg.exif || null;
                    card.querySelector('.thumb-dl-btn').hidden = false;
                    card.classList.remove('busy', 'embedded-thumb');
                    card.classList.add('encoding');
                },
                onLightbox(msg) {
                    card._lightbox = { rgb: msg.rgb, w: msg.w, h: msg.h };
                    // Free embedded preview bitmap — no longer needed.
                    if (card._embeddedPreview) {
                        card._embeddedPreview.bmp.close();
                        card._embeddedPreview = null;
                    }
                    if (lightboxIndex >= 0 && cards[lightboxIndex] === card) {
                        drawLightboxForCard(card);
                    }
                },
                onDone(msg) {
                    card.classList.remove('encoding');
                    const blob = new Blob([msg.jxl], { type: 'image/jxl' });
                    // Revoke any previous blob URL for this card before creating a new one.
                    if (card._blobUrl) URL.revokeObjectURL(card._blobUrl);
                    const url = URL.createObjectURL(blob);
                    card._blobUrl = url;
                    const link = card.querySelector('.download');
                    link.href = url;
                    link.download = file.name.replace(/\.orf$/i, '.jxl');
                    link.textContent = `JXL ${(msg.jxl.byteLength / 1024).toFixed(0)} KB`;
                    link.hidden = false;
                    card.querySelector('.size').textContent =
                        `${(msg.jxl.byteLength / 1024).toFixed(0)} KB`;
                    const totalMs = card._pipelineMs + msg.jxlMs;
                    card.querySelector('.time').textContent =
                        totalMs >= 60000
                            ? `${Math.floor(totalMs / 60000)}m ${((totalMs % 60000) / 1000).toFixed(0)}s`
                            : `${(totalMs / 1000).toFixed(1)}s`;
                    card._meta =
                        `${msg.w}×${msg.h} • pipeline ${card._pipelineMs.toFixed(0)} ms • JXL ${msg.jxlMs.toFixed(0)} ms`;

                    // Stats line — keeps everything one image needs on one row.
                    statSeq++;
                    const p = card._phaseMs || {};
                    const wb = card._wb || {};
                    const name = file.name.padEnd(18, ' ').slice(0, 18);
                    const wbStr = wb.r != null
                        ? `wb R${wb.r.toFixed(3)} B${wb.b.toFixed(3)}`
                        : 'wb ?';
                    const matrixStr = card._colorMatrixFromMn === true ? 'mn-matrix'
                                    : card._colorMatrixFromMn === false ? 'fallback-matrix'
                                    : '';
                    pushStat(
                        `[${String(statSeq).padStart(3, ' ')}] ${name} ${msg.w}×${msg.h}  ` +
                        `${wbStr}  ${matrixStr}  ` +
                        `dec ${fmtMs(p.decompress)}  ` +
                        `dem ${fmtMs(p.demosaic)}  ` +
                        `tone ${fmtMs(p.tonemap)}  ` +
                        `ori ${fmtMs(p.orient)}  ` +
                        `pipe ${fmtMs(card._pipelineMs)}  ` +
                        `jxl ${fmtMs(msg.jxlMs)}  ` +
                        `out ${fmtKb(msg.jxl.byteLength)}`,
                    );

                    totalDone++;
                    refreshStatus();
                },
                onError(msg) {
                    card.classList.remove('busy', 'encoding');
                    card.classList.add('error');
                    card.dataset.error = msg.error;
                    statSeq++;
                    pushStat(`[${String(statSeq).padStart(3, ' ')}] ${file.name.padEnd(18,' ').slice(0,18)} ERROR: ${msg.error}`);
                    totalDone++;
                    refreshStatus();
                },
            });
            card._taskId = taskId;
            cardByTaskId.set(taskId, card);
        })
        .catch((e) => {
            card.classList.add('error');
            card.dataset.error = e.message || String(e);
            totalDone++;
            refreshStatus();
        });
}

function refreshStatus() {
    if (totalSubmitted === 0) {
        statusBar.hidden = true;
        return;
    }
    statusBar.hidden = false;
    progressEl.max = totalSubmitted;
    progressEl.value = totalDone;
    if (totalDone < totalSubmitted) {
        statusText.textContent = `${totalDone} / ${totalSubmitted} done`;
    } else {
        statusText.textContent = `done — ${totalSubmitted} file${totalSubmitted === 1 ? '' : 's'}`;
    }
}

// ---------------------------------------------------------------------------
// File / folder ingest
// ---------------------------------------------------------------------------
async function handleFileList(fileList) {
    const orfs = [...fileList].filter(isOrf);
    for (const f of orfs) startConvert(f);
}

function isOrf(file) {
    return /\.orf$/i.test(file.name);
}

// Walk a DataTransfer entry tree (only available on `drop` via
// `dataTransfer.items[*].webkitGetAsEntry()`).  Returns all ORF files
// found at any depth.
async function gatherFromItems(items) {
    const entries = [];
    for (const item of items) {
        if (typeof item.webkitGetAsEntry === 'function') {
            const entry = item.webkitGetAsEntry();
            if (entry) entries.push(entry);
        }
    }
    const out = [];
    async function walk(entry) {
        if (entry.isFile) {
            await new Promise((res, rej) => entry.file((f) => { if (isOrf(f)) out.push(f); res(); }, rej));
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            let batch;
            do {
                batch = await new Promise((res, rej) => reader.readEntries(res, rej));
                for (const child of batch) await walk(child);
            } while (batch.length);
        }
    }
    for (const e of entries) await walk(e);
    return out;
}

pick.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFileList(e.target.files));

// Window-level catch keeps the browser from saving a dropped file as a
// download when the user misses the drop zone.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('dragging');
});
drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
    let files = [];
    if (e.dataTransfer.items && e.dataTransfer.items.length) {
        files = await gatherFromItems(e.dataTransfer.items);
    }
    if (!files.length) files = [...e.dataTransfer.files].filter(isOrf);
    handleFileList(files);
});

// ---------------------------------------------------------------------------
// Lightbox — zoom / pan / download
// ---------------------------------------------------------------------------
let lightboxIndex = -1;

// Zoom / pan / rotation state
const LB_ZOOM_MIN = 0.05;
const LB_ZOOM_MAX = 8.0;
const LB_ZOOM_STEP = 1.25;
let lbZoom = 1;
let lbPanX = 0;
let lbPanY = 0;
let lbRotation = 0; // 0 | 90 | 180 | 270

const LB_ROTATION_KEY = 'orf-lb-rotations';
let lbRotations = (() => {
    try { return JSON.parse(localStorage.getItem(LB_ROTATION_KEY)) || {}; }
    catch { return {}; }
})();

function applyLbTransform() {
    lightboxCanvas.style.transform =
        `translate(${lbPanX}px, ${lbPanY}px) scale(${lbZoom}) rotate(${lbRotation}deg)`;
    lbZoomLabel.textContent = Math.round(lbZoom * 100) + '%';
}

function resetLbZoom() {
    const vp = lbViewport.getBoundingClientRect();
    const cw = lightboxCanvas.width;
    const ch = lightboxCanvas.height;
    // For 90°/270° the rendered image is sideways — swap fit dimensions.
    const rotated = lbRotation === 90 || lbRotation === 270;
    const fitW = rotated ? ch : cw;
    const fitH = rotated ? cw : ch;
    lbZoom = (fitW > 0 && fitH > 0) ? Math.min(vp.width / fitW, vp.height / fitH, 1) : 1;
    lbPanX = 0;
    lbPanY = 0;
    applyLbTransform();
}

function rotateBy(delta) {
    lbRotation = ((lbRotation + delta) % 360 + 360) % 360;
    const card = cards[lightboxIndex];
    if (card?._file?.name) {
        lbRotations[card._file.name] = lbRotation;
        try { localStorage.setItem(LB_ROTATION_KEY, JSON.stringify(lbRotations)); } catch {}
    }
    resetLbZoom(); // recalculates fit with new rotation
}

function zoomAtPoint(clientX, clientY, factor) {
    const vp = lbViewport.getBoundingClientRect();
    const mx = clientX - (vp.left + vp.width / 2);
    const my = clientY - (vp.top + vp.height / 2);
    const newZoom = Math.max(LB_ZOOM_MIN, Math.min(LB_ZOOM_MAX, lbZoom * factor));
    const af = newZoom / lbZoom;
    lbPanX = lbPanX * af + mx * (1 - af);
    lbPanY = lbPanY * af + my * (1 - af);
    lbZoom = newZoom;
    applyLbTransform();
}

function drawLightboxForCard(card) {
    if (card._lightbox) {
        const { rgb, w, h } = card._lightbox;
        drawCanvas(lightboxCanvas, w, h, rgb);
        lbPreviewBadge.hidden = true;
        lbLoadingBadge.hidden = true;
    } else if (card._embeddedPreview) {
        const { bmp, orientation } = card._embeddedPreview;
        drawBitmapOriented(lightboxCanvas, bmp, orientation || 1);
        lbPreviewBadge.hidden = false;
        lbLoadingBadge.hidden = true;
    } else {
        // Nothing ready yet — blank canvas + loading indicator.
        lightboxCanvas.width = 1;
        lightboxCanvas.height = 1;
        lbPreviewBadge.hidden = true;
        lbLoadingBadge.hidden = false;
    }
}

// ---------------------------------------------------------------------------
// Lightbox EXIF info panel
// ---------------------------------------------------------------------------
const INFO_COLLAPSED_KEY = 'lb-info-collapsed';
const OLY_WB_MODE = {
    0: 'Auto', 1: 'Auto (Keep Warm Off)',
    16: '7500K Shade', 17: '6000K Cloudy', 18: '5300K Daylight',
    20: '3000K Tungsten', 21: '3600K Tungsten-like',
    22: 'Auto Setup', 23: '5500K Flash',
    33: '6600K Daylight Fluorescent', 34: '4500K Neutral Fluorescent',
    35: '4000K Cool White Fluorescent', 36: 'White Fluorescent',
    48: '3600K Tungsten-like', 67: 'Underwater',
    256: 'One Touch WB 1', 257: 'One Touch WB 2',
    258: 'One Touch WB 3', 259: 'One Touch WB 4',
    512: 'Custom WB 1', 513: 'Custom WB 2',
    514: 'Custom WB 3', 515: 'Custom WB 4',
};
const ORIENTATION_LABEL = {
    1: 'Normal', 2: 'Mirror H', 3: 'Rotate 180°',
    4: 'Mirror V', 5: 'Transpose', 6: 'Rotate 90° CW',
    7: 'Transverse', 8: 'Rotate 90° CCW',
};

function fmtShutter(rat) {
    if (!rat || !rat.d) return null;
    const v = rat.n / rat.d;
    if (v >= 1) return `${v.toFixed(v < 10 ? 1 : 0)} s`;
    // typical fractions — show 1/N rounded to a clean denominator
    const denom = Math.round(1 / v);
    return `1/${denom} s`;
}
function fmtFNumber(rat) {
    if (!rat || !rat.d) return null;
    return `ƒ/${(rat.n / rat.d).toFixed(1)}`;
}
function fmtFocal(rat, eq35) {
    if (!rat || !rat.d) return null;
    const mm = (rat.n / rat.d).toFixed(0);
    return eq35 ? `${mm} mm (≡ ${eq35} mm @ 35mm)` : `${mm} mm`;
}
function fmtDateTime(s) {
    if (!s) return null;
    // EXIF format: "YYYY:MM:DD HH:MM:SS"
    const m = /^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}:\d{2}:\d{2})/.exec(s);
    return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}` : s;
}
function fmtCoord(v, posChar, negChar) {
    if (v == null) return null;
    const abs = Math.abs(v);
    const deg = Math.floor(abs);
    const minF = (abs - deg) * 60;
    const min = Math.floor(minF);
    const sec = ((minF - min) * 60).toFixed(2);
    return `${deg}° ${min}′ ${sec}″ ${v >= 0 ? posChar : negChar}`;
}
function fmtGps(g) {
    if (!g) return null;
    const lat = fmtCoord(g.lat, 'N', 'S');
    const lon = fmtCoord(g.lon, 'E', 'W');
    const alt = g.alt != null ? ` · ${g.alt.toFixed(0)} m` : '';
    return `${lat}, ${lon}${alt}`;
}
function fmtQuality(q) {
    return { 1: 'SQ', 2: 'HQ', 3: 'SHQ', 4: 'RAW', 5: 'RAW+JPEG', 6: 'Compressed RAW' }[q] || null;
}
function fmtWb(exif) {
    if (!exif) return null;
    const mode = exif.wbMode != null ? (OLY_WB_MODE[exif.wbMode] || `mode ${exif.wbMode}`) : null;
    const gains = (exif.wbR != null && exif.wbB != null)
        ? `R ${exif.wbR.toFixed(3)} · B ${exif.wbB.toFixed(3)}`
        : null;
    const source = exif.wbFromCamera ? 'camera' : 'gray-world (auto)';
    return [mode, gains, `via ${source}`].filter(Boolean).join(' · ');
}

function buildInfoRows(card) {
    const ex = card._exif;
    if (!ex) return [];
    const camera = [ex.make, ex.model].filter(Boolean).join(' ').trim() || '—';
    const dim = (ex.width && ex.height) ? `${ex.width} × ${ex.height}` : null;
    return [
        ['Camera',    camera],
        ['Lens',      ex.lens || null],
        ['Date',      fmtDateTime(ex.datetime)],
        ['Shutter',   fmtShutter(ex.exposure)],
        ['Aperture',  fmtFNumber(ex.fnumber)],
        ['ISO',       ex.iso != null ? String(ex.iso) : null],
        ['Focal',     fmtFocal(ex.focalLength, ex.focalLength35)],
        ['GPS',       fmtGps(ex.gps)],
        ['WB',        fmtWb(ex)],
        ['Orientation', ORIENTATION_LABEL[ex.orientation] || (ex.orientation != null ? String(ex.orientation) : null)],
        ['Dimensions', dim],
        ['Format',    'ORF (Olympus 12-bit)'],
        ['Quality',   fmtQuality(ex.quality)],
        ['Pipeline',  card._pipelineMs != null ? `${card._pipelineMs.toFixed(0)} ms` : null],
    ].filter(([_, v]) => v != null);
}

function renderInfoPanel(card) {
    lightboxInfo.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'info-panel';
    if (localStorage.getItem(INFO_COLLAPSED_KEY) === '1') panel.classList.add('collapsed');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'info-toggle';
    toggle.setAttribute('aria-label', 'Toggle EXIF info');
    const updateToggle = () => {
        const collapsed = panel.classList.contains('collapsed');
        toggle.textContent = collapsed ? '▸ info' : '▾ info';
        toggle.setAttribute('aria-expanded', String(!collapsed));
    };
    toggle.addEventListener('click', () => {
        panel.classList.toggle('collapsed');
        localStorage.setItem(INFO_COLLAPSED_KEY, panel.classList.contains('collapsed') ? '1' : '0');
        updateToggle();
    });
    panel.appendChild(toggle);

    const body = document.createElement('dl');
    body.className = 'info-body';
    for (const [label, value] of buildInfoRows(card)) {
        const dt = document.createElement('dt'); dt.textContent = label;
        const dd = document.createElement('dd'); dd.textContent = value;
        body.appendChild(dt); body.appendChild(dd);
    }
    panel.appendChild(body);
    updateToggle();
    lightboxInfo.appendChild(panel);
}

function openLightbox(card) {
    lightboxIndex = cards.indexOf(card);
    lbRotation = card._file?.name ? (lbRotations[card._file.name] ?? 0) : 0;
    drawLightboxForCard(card);
    renderInfoPanel(card);
    lightbox.hidden = false;
    resetLbZoom();
}

function drawLightbox() {
    const card = cards[lightboxIndex];
    if (!card) return;
    lbRotation = card._file?.name ? (lbRotations[card._file.name] ?? 0) : 0;
    drawLightboxForCard(card);
    renderInfoPanel(card);
    resetLbZoom();
}

function closeLightbox() {
    lightbox.hidden = true;
    lightboxIndex = -1;
    lbPreviewBadge.hidden = true;
    lbLoadingBadge.hidden = true;
}

function nextInLightbox(dir) {
    if (lightboxIndex < 0) return;
    lightboxIndex = (lightboxIndex + dir + cards.length) % cards.length;
    // Reset live-render state so the new image starts clean.
    liveInFlight = false;
    livePendingLook = null;
    drawLightbox();
}

// Toolbar buttons
lbZoomIn.addEventListener('click', () => {
    const vp = lbViewport.getBoundingClientRect();
    zoomAtPoint(vp.left + vp.width / 2, vp.top + vp.height / 2, LB_ZOOM_STEP);
});
lbZoomOut.addEventListener('click', () => {
    const vp = lbViewport.getBoundingClientRect();
    zoomAtPoint(vp.left + vp.width / 2, vp.top + vp.height / 2, 1 / LB_ZOOM_STEP);
});
lbZoomReset.addEventListener('click', resetLbZoom);

// Download full-res from lightbox canvas
lbDownloadBtn.addEventListener('click', () => {
    const card = cards[lightboxIndex];
    if (!card) return;
    const stem = (card._file?.name || 'image').replace(/\.orf$/i, '');
    lightboxCanvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = stem + '-fullres.jpg'; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }, 'image/jpeg', 0.95);
});

// Scroll-wheel / trackpad zoom — proportional to deltaY so trackpad feels
// smooth and deliberate while a mouse-wheel click still gives a meaningful step.
// deltaMode 0 = pixels (trackpad), 1 = lines (mouse wheel), 2 = pages.
lbViewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 20;   // lines → pixel-equivalent
    if (e.deltaMode === 2) dy *= 300;  // pages → pixel-equivalent
    dy = Math.max(-200, Math.min(200, dy)); // cap runaway values
    zoomAtPoint(e.clientX, e.clientY, Math.exp(-dy * 0.003));
}, { passive: false });

// Mouse drag to pan
let lbDragging = false;
let lbDragLast = { x: 0, y: 0 };
lbViewport.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    lbDragging = true;
    lbDragLast = { x: e.clientX, y: e.clientY };
    lbViewport.classList.add('dragging');
    e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
    if (!lbDragging) return;
    lbPanX += e.clientX - lbDragLast.x;
    lbPanY += e.clientY - lbDragLast.y;
    lbDragLast = { x: e.clientX, y: e.clientY };
    applyLbTransform();
});
window.addEventListener('mouseup', () => {
    if (!lbDragging) return;
    lbDragging = false;
    lbViewport.classList.remove('dragging');
});

// Pinch-to-zoom + single-finger pan (touch)
let lbTouchPan = null;
let lbPinchStart = { dist: 0, mx: 0, my: 0 };
lbViewport.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
        lbTouchPan = null;
        const t0 = e.touches[0], t1 = e.touches[1];
        lbPinchStart = {
            dist: Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY),
            mx: (t0.clientX + t1.clientX) / 2,
            my: (t0.clientY + t1.clientY) / 2,
        };
    } else if (e.touches.length === 1) {
        lbTouchPan = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    e.preventDefault();
}, { passive: false });

lbViewport.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
        const t0 = e.touches[0], t1 = e.touches[1];
        const newDist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
        const mx = (t0.clientX + t1.clientX) / 2;
        const my = (t0.clientY + t1.clientY) / 2;
        if (lbPinchStart.dist > 0) {
            zoomAtPoint(mx, my, newDist / lbPinchStart.dist);
        }
        lbPinchStart = { dist: newDist, mx, my };
    } else if (e.touches.length === 1 && lbTouchPan) {
        lbPanX += e.touches[0].clientX - lbTouchPan.x;
        lbPanY += e.touches[0].clientY - lbTouchPan.y;
        lbTouchPan = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        applyLbTransform();
    }
    e.preventDefault();
}, { passive: false });

lbViewport.addEventListener('touchend', () => { lbTouchPan = null; });

lightboxClose.addEventListener('click', closeLightbox);
lightboxPrev.addEventListener('click', () => nextInLightbox(-1));
lightboxNext.addEventListener('click', () => nextInLightbox(1));
lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) closeLightbox();
});

document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd+A — select/deselect all thumbnails (global, any state)
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        const allSelected = cards.length > 0 && cards.every(c => c.classList.contains('selected'));
        for (const card of cards) {
            card.classList.toggle('selected', !allSelected);
            card.querySelector('.thumb-select').textContent = allSelected ? '·' : '✓';
        }
        refreshReprocessLabel();
        scheduleGalleryLiveUpdate();
        return;
    }

    // Digit keys 1-9, 0 → apply preset slot 0-9 (0 = slot 9 = "10th button")
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const digit = e.key >= '1' && e.key <= '9' ? Number(e.key) - 1
                    : e.key === '0' ? 9 : -1;
        if (digit >= 0 && presets[digit]) {
            e.preventDefault();
            applyLookValues(presets[digit].look);
            return;
        }
    }

    if (lightbox.hidden) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'r' || e.key === 'R') rotateBy(90);
    else if (e.key === 'l' || e.key === 'L') rotateBy(-90);
    else if (e.key === 'ArrowRight') nextInLightbox(1);
    else if (e.key === 'ArrowLeft') nextInLightbox(-1);
    else if (e.key === '=' || e.key === '+') {
        const vp = lbViewport.getBoundingClientRect();
        zoomAtPoint(vp.left + vp.width / 2, vp.top + vp.height / 2, LB_ZOOM_STEP);
    } else if (e.key === '-') {
        const vp = lbViewport.getBoundingClientRect();
        zoomAtPoint(vp.left + vp.width / 2, vp.top + vp.height / 2, 1 / LB_ZOOM_STEP);
    } else if (e.key === '0') {
        resetLbZoom();
    }
});

// ---------------------------------------------------------------------------
// Re-process — applies current look-controls to either selected cards or all.
// ---------------------------------------------------------------------------
function reprocessSelected() {
    const selected = cards.filter((c) => c.classList.contains('selected') && c._file);
    const targets = selected.length ? selected : cards.filter((c) => c._file);
    if (!targets.length) return;
    const ls = lookInputs
        .filter((el) => Number(el.value) !== 0)
        .map((el) => `${el.dataset.look}=${el.value}`)
        .join(' ');
    pushStat(`--- reprocess (${targets.length}) ${ls || '(all zero)'} ---`);
    for (const card of targets) startConvert(card._file, card);
}
