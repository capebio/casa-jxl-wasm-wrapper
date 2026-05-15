// Main thread.  Builds a Worker pool, dispatches each ORF to a free worker,
// streams events back (thumb → lightbox-preview → JXL bytes), and renders
// thumbnails + a clickable lightbox grid.
//
// Worker code lives in ./worker.js — one wasm instance + jSquash JXL
// encoder per worker, single-threaded inside.  Pool size scales with
// `navigator.hardwareConcurrency` so a batch saturates all cores.

const IS_TAURI = typeof window !== 'undefined' && !!window.__TAURI__;
window.IS_TAURI = IS_TAURI;
const { invoke } = IS_TAURI ? window.__TAURI__.core : {};
const { listen } = IS_TAURI ? window.__TAURI__.event : {};

const POOL_SIZE     = Math.min(navigator.hardwareConcurrency || 4, 12);
const JXL_POOL_SIZE = Math.max(2, Math.min(4, Math.ceil((navigator.hardwareConcurrency || 4) / 4)));

// Build tag the page reports — lets you tell at a glance whether the
// browser is on the latest version after a refresh.
const BUILD_TAG = '2026-05-13j / live-lightbox + toggle fixes';

// Visible build badge — top-left corner, always present.
{
    const badge = document.createElement('div');
    badge.id = 'build-badge';
    badge.textContent = BUILD_TAG;
    document.body.appendChild(badge);
}

// Info + effort popovers
{
    const allPopovers = () => [
        document.getElementById('info-popover'),
        document.getElementById('effort-popover'),
    ];
    function closeAllPopovers() { allPopovers().forEach(p => { if (p) p.hidden = true; }); }
    function togglePopover(id, e) {
        e.stopPropagation();
        const target = document.getElementById(id);
        const wasHidden = target.hidden;
        closeAllPopovers();
        target.hidden = !wasHidden;
    }

    const infoPop = document.getElementById('info-popover');
    document.getElementById('info-build-tag').textContent = BUILD_TAG;
    document.getElementById('info-pool-size').textContent = POOL_SIZE;
    document.getElementById('info-hw-cores').textContent = navigator.hardwareConcurrency || '?';
    document.getElementById('info-btn').addEventListener('click', (e) => togglePopover('info-popover', e));
    infoPop.addEventListener('click', (e) => e.stopPropagation());

    document.getElementById('effort-info-btn').addEventListener('click', (e) => togglePopover('effort-popover', e));
    document.getElementById('effort-popover').addEventListener('click', (e) => e.stopPropagation());

    document.addEventListener('click', closeAllPopovers);
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
const lbToggleJpegBtn = lightbox.querySelector('.lb-toggle-jpeg');
const lbSourceBanner  = lightbox.querySelector('#lb-source-banner');
const lbSourceLabelEl = document.getElementById('lb-source-label');

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

// Control visibility on adjust
{
    const controlsEl = document.querySelector('.controls');
    const headerEl = document.querySelector('body > header');
    const lookColumns = [...document.querySelectorAll('.look-column')];
    let adjustTimer = null;

    function getColumnForInput(input) {
        for (const col of lookColumns) {
            if (col.contains(input)) return col;
        }
        return null;
    }

    function startAdjusting(input) {
        const col = getColumnForInput(input);
        if (!col) return;

        clearTimeout(adjustTimer);
        controlsEl.classList.add('adjusting');
        headerEl.classList.add('adjusting-control');
        lookColumns.forEach(c => c.classList.remove('active'));
        col.classList.add('active');

        // Hide all labels in column, show only the one for this input
        const allLabels = col.querySelectorAll('.lr');
        allLabels.forEach(label => {
            if (label.contains(input)) {
                label.classList.add('active-control');
            } else {
                label.classList.remove('active-control');
            }
        });
    }

    function stopAdjusting() {
        clearTimeout(adjustTimer);
        adjustTimer = setTimeout(() => {
            controlsEl.classList.remove('adjusting');
            headerEl.classList.remove('adjusting-control');
            lookColumns.forEach(c => c.classList.remove('active'));
            lookInputs.forEach(input => {
                const label = input.closest('.lr');
                if (label) label.classList.remove('active-control');
            });
        }, 200);
    }

    for (const input of lookInputs) {
        input.addEventListener('pointerdown', () => startAdjusting(input));
        input.addEventListener('touchstart', () => startAdjusting(input));
    }

    document.addEventListener('pointerup', stopAdjusting);
    document.addEventListener('touchend', stopAdjusting);
}

const statsLog = document.getElementById('stats-log');
const copyStatsBtn = document.getElementById('copy-stats');
const clearStatsBtn = document.getElementById('clear-stats');

// Seed the stats log with build / env info so the paste-back is self-describing.
const statsLines = [];
const statsKeyIdx = new Map();   // key → index into statsLines for mutable rows
function pushStat(line) {
    statsLines.push(line);
    statsLog.textContent = statsLines.join('\n');
    statsLog.scrollTop = statsLog.scrollHeight;
}
// Mutable row that overwrites in place when the same key is pushed again.
// Used to collapse "N files share this signature" rollups (jpeg sizes,
// wb/matrix groups, etc) into one line that updates as the batch progresses.
function updateStat(key, line) {
    let idx = statsKeyIdx.get(key);
    if (idx === undefined) {
        idx = statsLines.length;
        statsKeyIdx.set(key, idx);
        statsLines.push(line);
    } else {
        statsLines[idx] = line;
    }
    statsLog.textContent = statsLines.join('\n');
    statsLog.scrollTop = statsLog.scrollHeight;
}
function resetStatKeys() { statsKeyIdx.clear(); }
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
    resetStatKeys();
    jpegSignatureCounts.clear();
    wbMatrixCounts.clear();
    pushStat(`build:        ${BUILD_TAG}`);
    pushStat(`pool size:    ${POOL_SIZE}`);
    pushStat(`hw cores:     ${navigator.hardwareConcurrency || '?'}`);
    pushStat(`UA:           ${navigator.userAgent}`);
    pushStat('');
});
// Rolling counters for collapsed stat rows.
const jpegSignatureCounts = new Map();  // "WxH oriN + WxH oriN" → count
const wbMatrixCounts      = new Map();  // "wb R… B… | matrix" → count
function bumpJpegSignature(sig) {
    const n = (jpegSignatureCounts.get(sig) || 0) + 1;
    jpegSignatureCounts.set(sig, n);
    updateStat(`jpeg:${sig}`, `[jpeg] ${String(n).padStart(3,' ')} files  ${sig}`);
}
function bumpWbMatrix(wbStr, matrixStr) {
    const sig = `${wbStr} | ${matrixStr || '—'}`;
    const n = (wbMatrixCounts.get(sig) || 0) + 1;
    wbMatrixCounts.set(sig, n);
    updateStat(`wb:${sig}`, `[wb ] ${String(n).padStart(3,' ')} files  ${sig}`);
}

function fmtMs(v) { return (v ?? 0).toFixed(0).padStart(5, ' ') + ' ms'; }
function fmtKb(v) { return (v / 1024).toFixed(0).padStart(5, ' ') + ' KB'; }

let statSeq = 0;

// ---------------------------------------------------------------------------
// Look slider helpers
// ---------------------------------------------------------------------------
function resetLookSliders() {
    for (const el of lookInputs) el.value = '0';
    contrastBoostEl.checked = false;
    refreshLookLabels();
}

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
window.currentLook = currentLook;

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

let focusedFieldset = null;
for (const el of lookInputs) {
    el.addEventListener('pointerdown', () => {
        const fieldset = el.closest('fieldset');
        if (fieldset && fieldset !== focusedFieldset) {
            if (focusedFieldset) focusedFieldset.classList.remove('focused-control');
            focusedFieldset = fieldset;
            fieldset.classList.add('focused-control');
            document.body.classList.add('control-focus-mode');
        }
    });
    el.addEventListener('input', () => {
        const name = el.dataset.look;
        const lbl = lookLabels.get(name);
        if (lbl) lbl.textContent = lookDisplay(name);
        scheduleLiveUpdate();
        scheduleGalleryLiveUpdate();
    });
}
document.addEventListener('pointerup', () => {
    if (focusedFieldset) {
        focusedFieldset.classList.remove('focused-control');
        focusedFieldset = null;
        document.body.classList.remove('control-focus-mode');
    }
});

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
    resetLookSliders();
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
window.applyLookValues = applyLookValues;

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
        this._jxlWorkers = [];
        this._jxlRR      = 0;
        this._jxlDecodeCallbacks = new Map(); // decodeId → { cb, url }
        this._jxlNextDecodeId    = 1;
        this._jxlDecodeQueue = [];           // { decodeId, url, priority }
        this._jxlDecodeBusy  = false;
        this._jxlPendingByUrl = new Map();   // url → decodeId (dedupe)
    }

    _jxlPriorityRank(p) { return p === 'high' ? 0 : p === 'low' ? 2 : 1; }
    _sortJxlQueue() {
        const rank = this._jxlPriorityRank.bind(this);
        this._jxlDecodeQueue.sort((a, b) => rank(a.priority) - rank(b.priority));
    }
    _pumpJxlQueue() {
        if (this._jxlDecodeBusy) return;
        const next = this._jxlDecodeQueue.shift();
        if (!next) return;
        this._jxlDecodeBusy = true;
        (this._jxlDecodeWorker ?? this._jxlWorkers[0]).postMessage({
            type: 'decode_jxl', decodeId: next.decodeId, url: next.url,
        });
    }
    _onJxlDecodeResponse(data) {
        const entry = this._jxlDecodeCallbacks.get(data.decodeId);
        if (entry) {
            this._jxlDecodeCallbacks.delete(data.decodeId);
            this._jxlPendingByUrl.delete(entry.url);
            entry.cb(data);
        }
        this._jxlDecodeBusy = false;
        this._pumpJxlQueue();
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

    submit(bytes, options, handlers, priority = 'normal') {
        const id = this.nextId++;
        this.tasks.set(id, { handlers, worker: null, released: false, priority });
        this._dispatch({ id, bytes, options, priority });
        return id;
    }

    _rawPriorityRank(p) { return p === 'high' ? 0 : p === 'medium' ? 1 : p === 'low' ? 3 : 2; }
    _sortQueue() {
        const rank = this._rawPriorityRank.bind(this);
        this.queue.sort((a, b) => rank(a.priority) - rank(b.priority));
    }

    setPriority(taskId, priority) {
        const t = this.tasks.get(taskId);
        if (t) t.priority = priority;
        const q = this.queue.find(x => x.id === taskId);
        if (q) {
            q.priority = priority;
            this._sortQueue();
        }
    }

    _dispatch(task) {
        const w = this.free.pop();
        if (!w) {
            this.queue.push(task);
            this._sortQueue();
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
        // RAW worker finished pipeline; forward RGBA to the next JXL encode worker (round-robin).
        if (type === 'encode_request') {
            if (this._jxlWorkers.length) {
                const jw = this._jxlWorkers[this._jxlRR % this._jxlWorkers.length];
                this._jxlRR++;
                jw.postMessage(ev.data, [ev.data.rgba]);
            }
            return;
        }
        const t = this.tasks.get(id);
        if (!t) return;
        const handlers = t.handlers;
        if (type === 'thumb' && handlers.onThumb) handlers.onThumb(ev.data);
        else if (type === 'lightbox' && handlers.onLightbox) {
            handlers.onLightbox(ev.data);
            // Release worker after lightbox — JXL encode is now handled by
            // jxl-worker.js, so the RAW worker is free for the next file.
            this._releaseWorker(worker, id);
        }
        else if (type === 'done') {
            if (handlers.onDone) handlers.onDone(ev.data);
            this.tasks.delete(id);  // Worker already freed on lightbox
            // KEEP workerForTask[id] alive — the owning worker still holds
            // liveStateMap[id], so reprocess_live for the lightbox needs to
            // know which worker to message even long after JXL is done.
            // Mapping is overwritten if the same card is re-submitted (new
            // taskId issued), so it doesn't leak.
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

    addJxlWorker(w) {
        this._jxlWorkers.push(w);
        w.addEventListener('message', ({ data }) => {
            // Decode responses use decodeId, not task id.
            if (data.type === 'jxl_decoded' || data.type === 'decode_error') {
                this._onJxlDecodeResponse(data);
                return;
            }
            // Encode responses use task id.
            const t = this.tasks.get(data.id);
            if (!t) return;
            if (data.type === 'done') {
                if (t.handlers.onDone) t.handlers.onDone(data);
            } else {
                if (t.handlers.onError) t.handlers.onError({ type: 'error', error: data.error });
            }
            this.tasks.delete(data.id);
            // KEEP workerForTask[id] alive — the RAW worker still holds the
            // cached rgb16 for live re-render via reprocess_live.  The mapping
            // is overwritten when the same card is re-submitted under a new
            // taskId, so it doesn't accumulate beyond one entry per card.
        });
        w.addEventListener('error', (ev) => {
            console.error('jxl-worker error:', ev.message);
        });
    }

    setLiveHandler(fn) { this._liveHandler = fn; }
    setThumbLiveHandler(fn) { this._thumbLiveHandler = fn; }

    setJxlDecodeWorker(w) {
        this._jxlDecodeWorker = w;
        w.addEventListener('message', ({ data }) => this._onJxlDecodeResponse(data));
        w.addEventListener('error', (ev) => console.error('jxl-decode-worker error:', ev.message));
    }

    decodeJxl(url, callback, priority = 'normal') {
        // Dedupe — if same URL already pending, chain callback + promote priority.
        const existingId = this._jxlPendingByUrl.get(url);
        if (existingId != null) {
            const entry = this._jxlDecodeCallbacks.get(existingId);
            if (entry) {
                const prevCb = entry.cb;
                entry.cb = (msg) => { prevCb(msg); callback(msg); };
            }
            // Promote priority if higher
            const newRank = this._jxlPriorityRank(priority);
            for (const q of this._jxlDecodeQueue) {
                if (q.decodeId === existingId) {
                    if (newRank < this._jxlPriorityRank(q.priority)) q.priority = priority;
                    break;
                }
            }
            this._sortJxlQueue();
            return;
        }
        const decodeId = this._jxlNextDecodeId++;
        this._jxlDecodeCallbacks.set(decodeId, { cb: callback, url });
        this._jxlPendingByUrl.set(url, decodeId);
        this._jxlDecodeQueue.push({ decodeId, url, priority });
        this._sortJxlQueue();
        this._pumpJxlQueue();
    }

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

    // Drop the cached rgb16 live/thumb state for a task that is being
    // re-submitted. Without this, re-processing the same file N times leaks
    // ~15 MB per reprocess inside the worker's liveStateMap.
    releaseState(taskId) {
        const worker = this.workerForTask.get(taskId);
        if (!worker) return;
        worker.postMessage({ type: 'release_state', id: taskId });
        this.workerForTask.delete(taskId);
        if (worker._taskIds) worker._taskIds.delete(taskId);
    }
}

const pool = new WorkerPool(POOL_SIZE);
pool.init();

// Spawn JXL encode worker from the page's main thread.  Emscripten Pthreads
// require SharedArrayBuffer (COOP + COEP) and cannot bootstrap correctly when
// the caller is itself a Web Worker — so this must live here, not in worker.js.
for (let i = 0; i < JXL_POOL_SIZE; i++) {
    pool.addJxlWorker(new Worker(new URL('./jxl-worker.js', import.meta.url), { type: 'module' }));
}
pool.setJxlDecodeWorker(new Worker(new URL('./jxl-decode-worker.js', import.meta.url), { type: 'module' }));

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
            livePendingLook = typeof mergedLook === 'function' ? mergedLook(currentLook()) : currentLook();
            return;
        }
        triggerLiveUpdate(typeof mergedLook === 'function' ? mergedLook(currentLook()) : currentLook());
    }, 80);
}
window.scheduleLiveUpdate = scheduleLiveUpdate;

function triggerLiveUpdate(look) {
    if (IS_TAURI) { triggerLiveUpdateTauri(look); return; }
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
            // Histogram panel reads back canvas pixels — only runs when panel is open (guard inside)
            if (typeof setCleanCanvas === 'function' && lightboxCanvas.width > 0) {
                setCleanCanvas(ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height));
            }
        }
    }
    if (livePendingLook) {
        const pending = livePendingLook;
        livePendingLook = null;
        triggerLiveUpdate(pending);
    }
});

contrastBoostEl.addEventListener('change', () => { scheduleLiveUpdate(); scheduleGalleryLiveUpdate(); });

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
    if (card) {
        card._thumbRgb = msg.rgb;
        card._thumbW   = msg.w;
        card._thumbH   = msg.h;
        redrawThumbRotated(card);
    }
});

// ---------------------------------------------------------------------------
// Card grid + per-file state
// ---------------------------------------------------------------------------
const cards = []; // ordered list of card elements for lightbox prev/next

const MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB hard limit before WASM
const seenFiles = new Set(); // "name|size|lastModified" — prevents duplicate-drop cards

function fileKey(f) { return `${f.name}|${f.size}|${f.lastModified}`; }

function makeCard(name) {
    const card = document.createElement('div');
    card.className = 'thumb busy';
    card.innerHTML = `
        <canvas></canvas>
        <div class="thumb-select" title="Select for re-process">·</div>
        <button class="thumb-rot-cw"  title="Rotate 90° CW">↻</button>
        <button class="thumb-rot-ccw" title="Rotate 90° CCW">↺</button>
        <button class="thumb-toggle-jpeg" hidden title="Toggle camera JPEG view">JXL</button>
        <button class="thumb-dl-btn" hidden title="Download JPEG">⬇ JPEG</button>
        <div class="meta">
            <span class="name"></span>
            <span class="time"></span>
            <span class="size"></span>
        </div>
    `;
    card.querySelector('.name').textContent = name.replace(/\.orf$/i, '');
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
    card.querySelector('.thumb-rot-cw').addEventListener('click', (e) => { e.stopPropagation(); rotateCard(card, 90); });
    card.querySelector('.thumb-rot-ccw').addEventListener('click', (e) => { e.stopPropagation(); rotateCard(card, -90); });
    card.querySelector('.thumb-toggle-jpeg').addEventListener('click', (e) => {
        e.stopPropagation();
        cycleSourceForCard(card, 1);
    });
    card.addEventListener('click', () => openLightbox(card));

    if (IS_TAURI) {
        const uploadBtn = document.createElement('button');
        uploadBtn.className = 'tauri-upload-btn';
        uploadBtn.title = 'Upload to planner';
        uploadBtn.textContent = '↑';
        uploadBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!card._tauriResult) return;
            uploadBtn.disabled = true; uploadBtn.textContent = '…';
            try {
                const [settings, token] = await Promise.all([invoke('get_settings'), invoke('get_token')]);
                const { jxl, exif } = card._tauriResult;
                const jxl_b64 = btoa(String.fromCharCode(...new Uint8Array(jxl)));
                const result = await invoke('push_to_planner', {
                    payload: { filename: name, jxl_b64, exif, planner_url: settings.planner_url, token: token ?? '' },
                });
                uploadBtn.textContent = result.ok ? '✓' : '✗';
                uploadBtn.title = result.error ?? 'Uploaded';
            } catch (err) {
                uploadBtn.textContent = '✗'; uploadBtn.title = String(err);
            }
        });
        card.style.position = 'relative';
        card.appendChild(uploadBtn);
    }

    return card;
}

// Cycle the display source for a card: raw → jxl → jpeg → raw (dir=+1) or reverse (dir=-1).
function cycleSourceForCard(card, dir = 1) {
    const order = ['raw', 'jxl', 'jpeg'];
    const available = order.filter(m => {
        if (m === 'raw')  return !!card._lightbox;
        if (m === 'jxl')  return !!card._blobUrl;
        if (m === 'jpeg') return !!card._embeddedPreview;
        return false;
    });
    if (available.length < 2) return;
    const cur = available.indexOf(card._sourceMode ?? 'raw');
    const next = available[(cur + dir + available.length) % available.length];
    card._sourceMode = next;
    const labels = { raw: 'RAW', jxl: 'JXL', jpeg: 'JPEG' };
    refreshThumbToggleButton(card);
    if (lightboxIndex >= 0 && cards[lightboxIndex] === card) {
        liveInFlight = false;
        livePendingLook = null;
        drawLightboxForCard(card);
        flashSourceBanner();
        showSourceLabel(labels[next]);
        if (next === 'raw') scheduleLiveUpdate();
    }
    redrawThumbRotated(card);
}

function refreshThumbToggleButton(card) {
    const btn = card.querySelector('.thumb-toggle-jpeg');
    if (!btn) return;
    const available = ['raw', 'jxl', 'jpeg'].filter(m => {
        if (m === 'raw')  return !!card._lightbox;
        if (m === 'jxl')  return !!card._blobUrl;
        if (m === 'jpeg') return !!card._embeddedPreview;
    });
    btn.hidden = available.length < 2;
    if (available.length < 2) return;
    const mode   = card._sourceMode ?? 'raw';
    const labels = { raw: 'RAW', jxl: 'JXL', jpeg: 'JPEG' };
    btn.textContent = labels[mode] ?? 'RAW';
    btn.classList.toggle('showing-jpeg', mode === 'jpeg');
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

// Draw an RGB8 buffer into canvas with an arbitrary CW rotation (0/90/180/270).
function drawRotatedCanvas(canvas, rgb, w, h, degrees) {
    if (!canvas) return;
    const d = ((degrees % 360) + 360) % 360;
    const swap = d === 90 || d === 270;
    const dW = swap ? h : w, dH = swap ? w : h;
    canvas.width = dW; canvas.height = dH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rgba = rgbToRgba(rgb, w, h);
    if (d === 0) { ctx.putImageData(new ImageData(rgba, w, h), 0, 0); return; }
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext('2d');
    if (tctx) tctx.putImageData(new ImageData(rgba, w, h), 0, 0);
    ctx.save();
    ctx.translate(dW / 2, dH / 2);
    ctx.rotate(d * Math.PI / 180);
    ctx.drawImage(tmp, -w / 2, -h / 2, w, h);
    ctx.restore();
}

// Redraw a card's thumbnail applying the current userRotations entry.  Routes
// through card._sourceMode: when 'jpeg' and we have an embedded preview cached,
// the camera's JPEG is rendered at the same canvas pixel dims as the JXL/RGB
// thumb so toggling doesn't change the viewport.
function redrawThumbRotated(card) {
    const deg = card._file?.name ? (userRotations[card._file.name] || 0) : 0;
    const canvas = card.querySelector('canvas');
    if (card._sourceMode === 'jpeg' && card._embeddedPreview && card._thumbW && card._thumbH) {
        drawJpegToTargetDims(canvas, card._embeddedPreview.bmp,
                             card._embeddedPreview.orientation || 1,
                             card._thumbW, card._thumbH);
        canvas.style.transform = deg ? `rotate(${deg}deg)` : '';
        return;
    }
    if (!card._thumbRgb) return;
    drawCanvas(canvas, card._thumbW, card._thumbH, card._thumbRgb);
    canvas.style.transform = deg ? `rotate(${deg}deg)` : '';
}

// Rotate a card by delta degrees and persist + sync lightbox if open.
function rotateCard(card, delta) {
    const name = card._file?.name;
    if (!name) return;
    userRotations[name] = (((userRotations[name] || 0) + delta) % 360 + 360) % 360;
    saveUserRotations();
    redrawThumbRotated(card);
    if (lightboxIndex >= 0 && cards[lightboxIndex] === card) {
        lbRotation = userRotations[name];
        resetLbZoom();
    }
}

let totalSubmitted = 0;
let totalDone = 0;

const statusTimings = document.getElementById('status-timings');
const EMA_A = 0.25;
let emaPipeline = null; // Rust RAW pipeline (ms)
let emaEncode = null;   // JXL encode (ms)

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

// Parse orientation tag (0x0112) from an ORF/TIFF file's own IFD0.
// The embedded JPEG previews often lack EXIF APP1 entirely; the RAW TIFF
// header is always present and is the authoritative source.
// Returns 1 (normal) when absent or unreadable.
function readOrfOrientation(bytes) {
    if (bytes.length < 8) return 1;
    const le = bytes[0] === 0x49 && bytes[1] === 0x49; // 'II' = little-endian
    if (!le && !(bytes[0] === 0x4D && bytes[1] === 0x4D)) return 1;
    const r16 = o => le ? (bytes[o] | bytes[o+1]<<8) : (bytes[o]<<8 | bytes[o+1]);
    const r32 = o => le
        ? ((bytes[o] | bytes[o+1]<<8 | bytes[o+2]<<16 | bytes[o+3]<<24) >>> 0)
        : ((bytes[o]<<24 | bytes[o+1]<<16 | bytes[o+2]<<8 | bytes[o+3]) >>> 0);
    // Olympus ORF uses non-TIFF magic at bytes 2-3 (IIRO/IIRS/IIUS = 0x524F/5253/5553)
    // rather than the standard TIFF 0x002A — skip the magic check entirely.
    // IFD0 offset at bytes 4-7 is standard across all variants.
    const ifd0 = r32(4);
    if (ifd0 + 2 > bytes.length) return 1;
    const n = r16(ifd0);
    for (let i = 0; i < n; i++) {
        const off = ifd0 + 2 + i * 12;
        if (off + 12 > bytes.length) break;
        if (r16(off) === 0x0112) {
            const val = r16(off + 8); // SHORT, inline value
            return (val >= 1 && val <= 8) ? val : 1;
        }
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

// Draw an embedded-JPEG ImageBitmap into `canvas` so the resulting pixel grid
// matches the JXL/RGB render exactly: same canvas.width/height and same EXIF
// orientation applied.  The JPEG is rescaled (linear interpolation via the
// canvas drawImage path) into target dims and oriented in pixel space.  CSS
// zoom/pan/rotate transforms on the canvas then behave identically whether
// the JXL pixels or JPEG pixels are showing — that's the whole point of the
// JXL↔JPEG toggle: same viewport, just different pixel source.
//
// Implementation: instead of EXIF affine matrices on a fixed destination rect,
// we translate the origin to the canvas centre, rotate/flip, then draw the
// source bitmap centred at the pre-rotation rect.  Cleaner math, avoids the
// off-canvas drift bug the matrix form had for orientations 5-8.
function drawJpegToTargetDims(canvas, bmp, orientation, targetW, targetH) {
    const o = (orientation >= 1 && orientation <= 8) ? orientation : 1;
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (o === 1) { ctx.drawImage(bmp, 0, 0, targetW, targetH); return; }
    let rad = 0, flipX = 1, flipY = 1;
    switch (o) {
        case 2: flipX = -1; break;
        case 3: rad = Math.PI; break;
        case 4: flipY = -1; break;
        case 5: rad =  Math.PI / 2; flipX = -1; break;
        case 6: rad =  Math.PI / 2; break;
        case 7: rad = -Math.PI / 2; flipX = -1; break;
        case 8: rad = -Math.PI / 2; break;
    }
    // After rotation, the source maps onto the canvas like this: for
    // 90°/270° orientations the source's long edge aligns with the canvas's
    // long edge, so the pre-rotation dest-rect must use swapped dims.
    const swap = o >= 5;
    const dW = swap ? targetH : targetW;
    const dH = swap ? targetW : targetH;
    ctx.save();
    ctx.translate(targetW / 2, targetH / 2);
    ctx.rotate(rad);
    ctx.scale(flipX, flipY);
    ctx.drawImage(bmp, -dW / 2, -dH / 2, dW, dH);
    ctx.restore();
}

// How many bytes to read upfront for embedded JPEG extraction.
// Olympus ORF stores the embedded preview within the first ~1–2 MB; 3 MB is safe.
const PREVIEW_SLICE = 3 * 1024 * 1024;

function startConvert(file, existingCard) {
    if (!existingCard) {
        const key = fileKey(file);
        if (seenFiles.has(key)) return; // duplicate drop — same file already queued
        seenFiles.add(key);
        if (file.size > MAX_FILE_BYTES) {
            const card = makeCard(file.name);
            cards.push(card);
            grid.appendChild(card);
            card.classList.remove('busy');
            card.classList.add('error');
            card.dataset.error = `File too large (${(file.size / 1024 / 1024).toFixed(0)} MB > ${MAX_FILE_BYTES / 1024 / 1024} MB limit)`;
            totalSubmitted++; totalDone++; refreshStatus();
            return;
        }
    }
    const card = existingCard || makeCard(file.name);
    if (!existingCard) {
        cards.push(card);
        grid.appendChild(card);
    } else {
        // Re-processing: release old rgb16 state from the worker before re-submitting,
        // otherwise liveStateMap accumulates ~15 MB per reprocess of the same card.
        if (card._taskId) pool.releaseState(card._taskId);
        card.classList.remove('encoding', 'error', 'embedded-thumb');
        card.classList.add('busy');
        card._lightbox = null;
        // Keep _embeddedPreview alive across reprocess — JPEG-vs-JXL toggle needs it.
        // Force the JXL view back on so the user actually sees the result of
        // pressing Apply/Re-process; otherwise they'd be staring at the
        // (unchanged) camera JPEG and assume the action did nothing.
        card._sourceMode = 'raw';
        refreshThumbToggleButton(card);
        if (lightboxIndex >= 0 && cards[lightboxIndex] === card) {
            drawLightboxForCard(card);
        }
    }
    totalSubmitted++;
    card._file = file;
    // Check for existing sidecar dot
    if (typeof loadSidecar === 'function' && file.name) {
        loadSidecar(file.name).then(s => {
            if (s && typeof updateSidecarDot === 'function') updateSidecarDot(file.name, true);
        });
    }
    refreshStatus();

    // Phase A — fast: read only the first PREVIEW_SLICE bytes to extract the
    // embedded JPEG preview and show an oriented thumbnail immediately.
    // Runs concurrently with the full read below; failure is non-fatal.
    file.slice(0, PREVIEW_SLICE).arrayBuffer().then(sliceBuf => {
        const bytes = new Uint8Array(sliceBuf);
        // RAW TIFF orientation is authoritative — embedded JPEGs often lack EXIF.
        // Fall back to JPEG EXIF only if the RAW header is unreadable.
        const rawOrientation = readOrfOrientation(bytes);
        const candidates = extractEmbeddedJpegs(bytes);
        if (!candidates.length) return;
        Promise.allSettled(
            candidates.map(c => {
                const orientation = rawOrientation !== 1 ? rawOrientation : readJpegOrientation(c);
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

            bumpJpegSignature(valid.map(v => `${v.w}×${v.h} ori${v.orientation}`).join(' + '));

            const largest = valid[valid.length - 1];

            if (card.classList.contains('busy') || card.classList.contains('embedded-thumb')) {
                drawOrientedThumb(card.querySelector('canvas'), largest.bmp, largest.orientation, 360);
                card.classList.remove('busy');
                card.classList.add('embedded-thumb');
            }

            card._embeddedPreview = { bmp: largest.bmp, w: largest.w, h: largest.h,
                                      orientation: largest.orientation };
            refreshThumbToggleButton(card);
            if (lightboxIndex >= 0 && cards[lightboxIndex] === card) {
                if (!card._lightbox) {
                    drawLightboxForCard(card);
                    resetLbZoom();
                } else {
                    // Refresh toggle button enabled-state now that the pair is complete.
                    updateToggleButtonState(card);
                }
            }

            for (let vi = 0; vi < valid.length - 1; vi++) valid[vi].bmp.close();
        });
    }).catch(() => {}); // preview failure is non-fatal

    // Phase B+C — full file read for WASM pipeline + JXL encode.
    file.arrayBuffer()
        .then((buf) => {
            const bytes = new Uint8Array(buf);
            const opts = currentOptions();
            opts.userRotation = userRotations[file.name] || 0;
            const initialPriority = card._pendingPriority || 'normal';
            card._pendingPriority = null;
            const taskId = pool.submit(bytes, opts, {
                onThumb(msg) {
                    card._thumbRgb = msg.rgb;
                    card._thumbW   = msg.w;
                    card._thumbH   = msg.h;
                    try {
                        redrawThumbRotated(card);
                    } catch (e) {
                        console.error('redrawThumb error:', e);
                        pushStat(`[redrawThumb ERROR] ${e?.message || e} (w=${msg.w} h=${msg.h} rgb=${msg.rgb?.byteLength})`);
                        drawCanvas(card.querySelector('canvas'), msg.w, msg.h, msg.rgb);
                    }
                    refreshThumbToggleButton(card);
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
                    // Keep _embeddedPreview around — the JXL/JPEG toggle needs it.
                    refreshThumbToggleButton(card);
                    if (lightboxIndex >= 0 && cards[lightboxIndex] === card) {
                        drawLightboxForCard(card);
                        resetLbZoom();
                    }
                },
                onDone(msg) {
                    card.classList.remove('encoding');
                    const blob = new Blob([msg.jxl], { type: 'image/jxl' });
                    // Revoke any previous blob URL for this card before creating a new one.
                    if (card._blobUrl) URL.revokeObjectURL(card._blobUrl);
                    const url = URL.createObjectURL(blob);
                    card._blobUrl = url;
                    card._jxlDecoded = null;  // cache stale once bytes change
                    card.querySelector('.size').textContent =
                        `${(msg.jxl.byteLength / 1024).toFixed(0)} KB`;
                    const totalMs = card._pipelineMs + msg.jxlMs;
                    const effortNote = (msg.effortUsed && msg.effortRequested && msg.effortUsed < msg.effortRequested)
                        ? ` (effort ${msg.effortRequested}→${msg.effortUsed}: OOM)` : '';
                    card.querySelector('.time').textContent =
                        (totalMs >= 60000
                            ? `${Math.floor(totalMs / 60000)}m ${((totalMs % 60000) / 1000).toFixed(0)}s`
                            : `${(totalMs / 1000).toFixed(1)}s`) + effortNote;
                    card._meta =
                        `${msg.w}×${msg.h} • pipeline ${card._pipelineMs.toFixed(0)} ms • JXL ${msg.jxlMs.toFixed(0)} ms${effortNote}`;

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
                    bumpWbMatrix(wbStr, matrixStr);
                    pushStat(
                        `[${String(statSeq).padStart(3, ' ')}] ${name} ${msg.w}×${msg.h}  ` +
                        `dec ${fmtMs(p.decompress)}  ` +
                        `dem ${fmtMs(p.demosaic)}  ` +
                        `tone ${fmtMs(p.tonemap)}  ` +
                        `ori ${fmtMs(p.orient)}  ` +
                        `pipe ${fmtMs(card._pipelineMs)}  ` +
                        `jxl ${fmtMs(msg.jxlMs)}  ` +
                        `out ${fmtKb(msg.jxl.byteLength)}`,
                    );

                    emaPipeline = emaPipeline == null ? card._pipelineMs : EMA_A * card._pipelineMs + (1 - EMA_A) * emaPipeline;
                    emaEncode   = emaEncode   == null ? msg.jxlMs        : EMA_A * msg.jxlMs        + (1 - EMA_A) * emaEncode;
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
            }, initialPriority);
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

function fmtAvg(ms) {
    if (ms == null) return '—';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`;
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
        statusText.textContent = `${totalDone} / ${totalSubmitted}`;
    } else {
        statusText.textContent = `done — ${totalSubmitted} file${totalSubmitted === 1 ? '' : 's'}`;
    }
    if (emaPipeline != null) {
        const emaTotal = (emaPipeline ?? 0) + (emaEncode ?? 0);
        statusTimings.textContent =
            `RAW pipeline ${fmtAvg(emaPipeline)}  ·  JXL encode ${fmtAvg(emaEncode)}  ·  per file ${fmtAvg(emaTotal)}`;
    } else {
        statusTimings.textContent = '';
    }
}

// ---------------------------------------------------------------------------
// File / folder ingest
// ---------------------------------------------------------------------------
async function handleFileList(fileList) {
    const orfs = [...fileList].filter(isOrf);
    if (!orfs.length) return;

    window.dockSidebar();

    resetLookSliders();
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

// Resize handle helper
function makeResizable(handle, panel, minW, maxW) {
    let startX, startW;
    handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        startX = e.clientX;
        startW = panel.offsetWidth;
        handle.classList.add('dragging');
        handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
        if (!handle.classList.contains('dragging')) return;
        const w = Math.min(maxW, Math.max(minW, startW + (e.clientX - startX)));
        panel.style.width = w + 'px';
    });
    handle.addEventListener('pointerup', () => handle.classList.remove('dragging'));
}

// Timings sidebar — click-only, no hover
{
    const timingsSidebar = document.getElementById('timings-sidebar');
    const timingsTab = document.getElementById('timings-tab');
    const timingsClose = document.getElementById('timings-close');

    function toggleTimings(e) { e.stopPropagation(); timingsSidebar.classList.toggle('open'); }
    function closeTimings() { timingsSidebar.classList.remove('open'); }

    timingsTab.addEventListener('click', toggleTimings);
    timingsClose.addEventListener('click', closeTimings);

    makeResizable(document.getElementById('timings-resize'), document.getElementById('timings-panel'), 280, 900);
}

{
    makeResizable(document.getElementById('files-resize'), document.getElementById('sidebar-panel'), 160, 480);
}

// File sidebar open/close — runs regardless of Tauri/browser
{
    const sidebarEl = document.getElementById('file-sidebar');
    const sidebarTab = document.getElementById('sidebar-tab');

    function openSidebar() {
        if (sidebarEl.dataset.docked === '1') sidebarEl.classList.add('open');
    }
    function closeSidebar() {
        if (sidebarEl.dataset.docked === '1') sidebarEl.classList.remove('open');
    }
    function toggleSidebar() { sidebarEl.classList.toggle('open'); }

    window.dockSidebar = () => {
        sidebarEl.dataset.docked = '1';
        sidebarEl.classList.remove('open');
    };

    sidebarTab.addEventListener('click', (e) => { e.stopPropagation(); toggleSidebar(); });
    sidebarEl.addEventListener('mouseenter', openSidebar);
    sidebarEl.addEventListener('mouseleave', closeSidebar);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'l' || e.key === 'L') {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            toggleSidebar();
        }
    });
}

if (IS_TAURI) {
    pick.addEventListener('click', async () => {
        const paths = await invoke('pick_files');
        if (paths.length > 0) {
            window.dockSidebar();
            startBatchTauri(paths);
        }
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
    drop.addEventListener('dragover', (e) => e.preventDefault());
    drop.addEventListener('drop', (e) => e.preventDefault());
} else {
    pick.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => { await handleFileList(e.target.files); });

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
        await handleFileList(files);
    });
}

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

const USER_ROT_KEY    = 'orf-user-rotations';
const LB_ROTATION_KEY = 'orf-lb-rotations'; // legacy — migrated on load
let userRotations = (() => {
    try {
        const legacy = JSON.parse(localStorage.getItem(LB_ROTATION_KEY)) || {};
        const saved  = JSON.parse(localStorage.getItem(USER_ROT_KEY))    || {};
        return { ...legacy, ...saved };
    } catch { return {}; }
})();
function saveUserRotations() {
    try { localStorage.setItem(USER_ROT_KEY, JSON.stringify(userRotations)); } catch {}
}

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
        userRotations[card._file.name] = lbRotation;
        saveUserRotations();
        redrawThumbRotated(card);
    }
    resetLbZoom();
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
    if (pixelPeepActive) updatePeepBadges();
}

function drawLightboxForCard(card) {
    const mode = card._sourceMode ?? 'raw';

    if (mode === 'jpeg') {
        if (card._embeddedPreview && card._lightbox) {
            const { w, h } = card._lightbox;
            const { bmp, orientation } = card._embeddedPreview;
            drawJpegToTargetDims(lightboxCanvas, bmp, orientation || 1, w, h);
            if (typeof setCleanCanvas === 'function' && lightboxCanvas.width > 0) {
                const _ctx = lightboxCanvas.getContext('2d');
                setCleanCanvas(_ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height));
            }
            lbPreviewBadge.hidden = false;
            lbLoadingBadge.hidden = true;
            updateToggleButtonState(card);
            return;
        }
        // Fallback: lightbox not ready yet, treat as raw.
        card._sourceMode = 'raw';
    }

    if (mode === 'jxl') {
        if (!card._blobUrl) {
            // JXL not ready yet — fall back to raw.
            card._sourceMode = 'raw';
        } else if (card._jxlDecoded) {
            // Cached from prefetch — instant paint.
            const { rgba, w, h } = card._jxlDecoded;
            lightboxCanvas.width  = w;
            lightboxCanvas.height = h;
            const ctx = lightboxCanvas.getContext('2d');
            ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
            if (typeof setCleanCanvas === 'function' && lightboxCanvas.width > 0) {
                setCleanCanvas(ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height));
            }
            lbPreviewBadge.hidden = true;
            lbLoadingBadge.hidden = true;
            updateToggleButtonState(card);
            applyLbTransform();
            return;
        } else {
            lbPreviewBadge.hidden = true;
            lbLoadingBadge.hidden = false;
            updateToggleButtonState(card);
            pool.decodeJxl(card._blobUrl, (msg) => {
                if (lightboxIndex < 0 || cards[lightboxIndex] !== card) return;
                if (msg.type === 'decode_error') {
                    console.warn('JXL decode error:', msg.error);
                    lbLoadingBadge.hidden = true;
                    return;
                }
                card._jxlDecoded = { rgba: msg.rgba, w: msg.w, h: msg.h };
                lightboxCanvas.width  = msg.w;
                lightboxCanvas.height = msg.h;
                const ctx = lightboxCanvas.getContext('2d');
                ctx.putImageData(new ImageData(msg.rgba, msg.w, msg.h), 0, 0);
                if (typeof setCleanCanvas === 'function' && lightboxCanvas.width > 0) {
                    setCleanCanvas(ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height));
                }
                lbLoadingBadge.hidden = true;
                applyLbTransform();
            }, 'high');
            return;
        }
    }

    // mode === 'raw' (or fallback from unavailable mode).
    //
    // Always paint best-available source synchronously so no stale image from
    // the previous card leaks through during async fetch.  Order of preference:
    //   1. Full lightbox-sized RGB (best)
    //   2. JXL (encoded final output — equivalent quality, in-browser, fast)
    //   3. Embedded JPEG preview (placeholder, swapped when full arrives)
    //   4. 1×1 clear (nothing available yet)
    const hasFullRgb     = !!(card._lightbox && card._lightbox.rgb);
    const needsTauriFetch = !!(card._lightbox && card._lightbox.id != null
                               && !card._lightbox.rgb && IS_TAURI);
    const hasEmbedded    = !!card._embeddedPreview;

    // JXL already encoded but RAW rgb not displayable yet — promote to JXL
    // so the user sees the real encoded output (no JPEG-preview placeholder).
    if (!hasFullRgb && card._blobUrl) {
        card._sourceMode = 'jxl';
        drawLightboxForCard(card);
        return;
    }

    if (hasFullRgb) {
        const { rgb, w, h } = card._lightbox;
        drawCanvas(lightboxCanvas, w, h, rgb);
        if (typeof setCleanCanvas === 'function' && lightboxCanvas.width > 0) {
            const _ctx = lightboxCanvas.getContext('2d');
            setCleanCanvas(_ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height));
        }
        lbPreviewBadge.hidden = true;
        lbLoadingBadge.hidden = true;
    } else if (hasEmbedded) {
        const { bmp, orientation } = card._embeddedPreview;
        drawBitmapOriented(lightboxCanvas, bmp, orientation || 1);
        if (typeof setCleanCanvas === 'function' && lightboxCanvas.width > 0) {
            const _ctx = lightboxCanvas.getContext('2d');
            setCleanCanvas(_ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height));
        }
        lbPreviewBadge.hidden = false;
        lbLoadingBadge.hidden = !needsTauriFetch;
    } else {
        // Clear to known state so prior card's pixels don't bleed through.
        lightboxCanvas.width  = 1;
        lightboxCanvas.height = 1;
        lbPreviewBadge.hidden = true;
        lbLoadingBadge.hidden = !needsTauriFetch;
    }

    // Background fetch — when it lands, redraw and reset zoom to fit new dims.
    if (needsTauriFetch && !card._lightbox.fetching) {
        card._lightbox.fetching = true;
        invoke('get_lightbox', { id: card._lightbox.id })
            .then((frame) => {
                const rgbU8 =
                    (frame.data instanceof Uint8ClampedArray || frame.data instanceof Uint8Array)
                        ? frame.data : Uint8Array.from(frame.data);
                card._lightbox.rgb = rgbU8;
                card._lightbox.w   = frame.width;
                card._lightbox.h   = frame.height;
                if (lightboxIndex >= 0 && cards[lightboxIndex] === card) {
                    drawLightboxForCard(card);
                    resetLbZoom();
                }
            })
            .catch((e) => {
                console.warn('get_lightbox failed:', e);
                lbLoadingBadge.hidden = true;
            })
            .finally(() => { if (card._lightbox) card._lightbox.fetching = false; });
    }
    updateToggleButtonState(card);
}

function updateToggleButtonState(card) {
    const mode   = card?._sourceMode ?? 'raw';
    const labels = { raw: 'RAW', jxl: 'JXL', jpeg: 'JPEG' };
    const havePair = !!(card && (card._lightbox || card._embeddedPreview || card._blobUrl));
    if (lbToggleJpegBtn) {
        lbToggleJpegBtn.disabled = !havePair;
        lbToggleJpegBtn.textContent = labels[mode] ?? 'RAW';
        lbToggleJpegBtn.classList.toggle('showing-jpeg', mode === 'jpeg');
    }
    if (lbSourceBanner) {
        lbSourceBanner.textContent = labels[mode] ?? 'RAW';
        lbSourceBanner.setAttribute('data-source', mode);
        lbSourceBanner.hidden = !havePair;
    }
}

// Briefly pulse the centre banner so a toggle press is unmissable.
function flashSourceBanner() {
    if (!lbSourceBanner) return;
    lbSourceBanner.classList.remove('flash');
    // Force reflow so re-adding the class restarts the transition.
    void lbSourceBanner.offsetWidth;
    lbSourceBanner.classList.add('flash');
    clearTimeout(flashSourceBanner._t);
    flashSourceBanner._t = setTimeout(() => lbSourceBanner.classList.remove('flash'), 1200);
}

let _sourceLabelKey = 0;
function showSourceLabel(text) {
    if (!lbSourceLabelEl) return;
    lbSourceLabelEl.textContent = text;
    lbSourceLabelEl.classList.remove('active');
    void lbSourceLabelEl.offsetWidth; // force reflow to restart animation
    _sourceLabelKey++;
    lbSourceLabelEl.dataset.key = _sourceLabelKey;
    lbSourceLabelEl.classList.add('active');
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

// Background JXL prefetch — keeps RAW on display but stashes decoded JXL
// pixels in card._jxlDecoded so manual toggle / zoom is instant.
const PREFETCH_NEIGHBORS = 2;
function prefetchJxl(card, priority = 'normal') {
    if (!card || !card._blobUrl) return;
    if (card._jxlDecoded) return;
    if (card._jxlPrefetching) return;
    card._jxlPrefetching = true;
    pool.decodeJxl(card._blobUrl, (msg) => {
        card._jxlPrefetching = false;
        if (msg.type === 'decode_error') return;
        card._jxlDecoded = { rgba: msg.rgba, w: msg.w, h: msg.h };
    }, priority);
}
function prefetchAroundCurrent() {
    if (lightboxIndex < 0) return;
    prefetchJxl(cards[lightboxIndex], 'high');
    for (let off = 1; off <= PREFETCH_NEIGHBORS; off++) {
        const a = (lightboxIndex + off + cards.length) % cards.length;
        const b = (lightboxIndex - off + cards.length) % cards.length;
        if (a !== lightboxIndex)             prefetchJxl(cards[a], 'low');
        if (b !== lightboxIndex && b !== a)  prefetchJxl(cards[b], 'low');
    }
}

// Promote the lightboxed card's RAW-pipeline task (and neighbours) to the
// front of the pool queue so the next freed worker picks it up.  If the task
// is already running we can't preempt; if it hasn't been submitted yet (file
// arrayBuffer still pending), stash the priority on the card so submit picks
// it up.
function promoteRawAroundCurrent() {
    if (lightboxIndex < 0) return;
    const setRawPriority = (card, prio) => {
        if (!card) return;
        if (card._taskId != null) pool.setPriority(card._taskId, prio);
        else card._pendingPriority = prio;
    };
    setRawPriority(cards[lightboxIndex], 'high');
    for (let off = 1; off <= PREFETCH_NEIGHBORS; off++) {
        const a = (lightboxIndex + off + cards.length) % cards.length;
        const b = (lightboxIndex - off + cards.length) % cards.length;
        if (a !== lightboxIndex)             setRawPriority(cards[a], 'medium');
        if (b !== lightboxIndex && b !== a)  setRawPriority(cards[b], 'medium');
    }
}

function openLightbox(card) {
    lightboxIndex = cards.indexOf(card);
    lbRotation = card._file?.name ? (userRotations[card._file.name] ?? 0) : 0;
    card._sourceMode = 'raw';
    resetLookSliders();
    // Auto-load sidecar if present
    if (typeof loadSidecar === 'function' && (card._tauriPath || card._file?.name)) {
        const sidecarPath = card._tauriPath || card._file?.name;
        loadSidecar(sidecarPath).then(sidecar => {
            if (sidecar && typeof applySidecar === 'function') applySidecar(sidecar);
        });
    }
    drawLightboxForCard(card);
    flashSourceBanner();
    const labels = { raw: 'RAW', jxl: 'JXL', jpeg: 'JPEG' };
    showSourceLabel(labels[card._sourceMode] ?? 'RAW');
    renderInfoPanel(card);
    lightbox.hidden = false;
    resetLbZoom();
    promoteRawAroundCurrent();
    prefetchAroundCurrent();
}

function drawLightbox() {
    const card = cards[lightboxIndex];
    if (!card) return;
    lbRotation = card._file?.name ? (userRotations[card._file.name] ?? 0) : 0;
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
    const card = cards[lightboxIndex];
    if (card) card._sourceMode = 'raw';
    liveInFlight = false;
    livePendingLook = null;
    resetLookSliders();
    drawLightbox();
    const labels = { raw: 'RAW', jxl: 'JXL', jpeg: 'JPEG' };
    showSourceLabel(labels[card?._sourceMode] ?? 'RAW');
    promoteRawAroundCurrent();
    prefetchAroundCurrent();
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

if (lbToggleJpegBtn) {
    lbToggleJpegBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (lightboxIndex < 0) return;
        cycleSourceForCard(cards[lightboxIndex], 1);
    });
}

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
    // Don't initiate pan when clicking inside panels (sliders, handles, chips, etc.)
    if (e.target.closest('.lb-panels')) return;
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

lightboxClose.addEventListener('click', () => pixelPeepActive ? exitPixelPeep() : closeLightbox());
lightboxPrev.addEventListener('click', () => pixelPeepActive ? peepNavPhoto(-1) : nextInLightbox(-1));
lightboxNext.addEventListener('click', () => pixelPeepActive ? peepNavPhoto(1)  : nextInLightbox(1));
lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) {
        if (pixelPeepActive) exitPixelPeep(); else closeLightbox();
    }
});

document.addEventListener('keydown', (e) => {
    // Colour profile shortcuts
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        // TODO: replace with custom dialog in Tauri (prompt() may behave differently)
        const name = prompt('Save profile as:');
        if (name && typeof saveCurrentAsProfile === 'function') saveCurrentAsProfile(name);
        return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'L') {
        if (!lightbox.hidden) {
            e.preventDefault();
            if (typeof togglePanel === 'function') togglePanel('c');
        }
        return;
    }
    const slotMatch = (e.ctrlKey || e.metaKey) && e.shiftKey && /^[0-9]$/.test(e.key);
    if (slotMatch) {
        e.preventDefault();
        const idx = e.key === '0' ? 9 : parseInt(e.key, 10) - 1;
        if (typeof loadUserProfileByIndex === 'function') loadUserProfileByIndex(idx);
        return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 's') {
        e.preventDefault();
        if (!lightbox.hidden) {
            const card = cards[lightboxIndex];
            const sidecarPath = card?._tauriPath || card?._file?.name;
            if (sidecarPath && typeof saveSidecar === 'function') saveSidecar(sidecarPath);
        }
        return;
    }

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

    // Pixel-peep mode: intercept arrows, Esc, source-toggle/rotate hotkeys.
    // Zoom keys (+/-/0) and wheel/drag pan fall through to existing handlers.
    if (pixelPeepActive) {
        if (e.key === 'Escape')     { e.preventDefault(); exitPixelPeep();      return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); peepNavPhoto(1);      return; }
        if (e.key === 'ArrowLeft')  { e.preventDefault(); peepNavPhoto(-1);     return; }
        if (e.key === 'ArrowUp')    { e.preventDefault(); peepCycleQuality(1);  return; }
        if (e.key === 'ArrowDown')  { e.preventDefault(); peepCycleQuality(-1); return; }
        // Block stale handlers from acting on no-card state.
        if (e.key === ' ' || e.code === 'Space' || /^[rRlLhHcCfF]$/.test(e.key)) {
            e.preventDefault();
            return;
        }
        // Let +/-/0 zoom keys through.
    }

    // B&W quick-select (Ctrl+1–9 / Ctrl+0, lightbox only)
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        if (e.key === '0') {
            if (typeof setActiveFilter === 'function') setActiveFilter(null);
        } else {
            const bwIdx = parseInt(e.key, 10) - 1;
            if (typeof setActiveFilter === 'function') setActiveFilter(window.BW_NAMES[bwIdx]);
        }
        return;
    }
    // Don't hijack typing in form controls (sliders, number inputs, prompts).
    const tag = (e.target && e.target.tagName) || '';
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (!isInput && (e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (typeof togglePanel === 'function') togglePanel('h');
        return;
    }
    if (!isInput && (e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (typeof togglePanel === 'function') togglePanel('c');
        return;
    }
    if (!isInput && (e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (typeof togglePanel === 'function') togglePanel('f');
        return;
    }
    if (e.key === 'Escape') closeLightbox();
    else if (!isInput && (e.key === 'r' || e.key === 'R')) rotateBy(90);
    else if (!isInput && (e.key === 'l' || e.key === 'L')) rotateBy(-90);
    else if (!isInput && (e.key === ' ' || e.code === 'Space')) {
        e.preventDefault();
        if (lightboxIndex >= 0) cycleSourceForCard(cards[lightboxIndex], 1);
    }
    else if (e.key === 'ArrowRight') nextInLightbox(1);
    else if (e.key === 'ArrowLeft') nextInLightbox(-1);
    else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (lightboxIndex >= 0) cycleSourceForCard(cards[lightboxIndex], 1);
    }
    else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (lightboxIndex >= 0) cycleSourceForCard(cards[lightboxIndex], -1);
    }
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

// ---------------------------------------------------------------------------
// Tauri native code paths
// ---------------------------------------------------------------------------
function lookToSnake(look) {
    return {
        exposure_ev: look.exposureEv,
        contrast:    look.contrast,
        highlights:  look.highlights,
        shadows:     look.shadows,
        whites:      look.whites,
        blacks:      look.blacks,
        saturation:  look.saturation,
        vibrance:    look.vibrance,
        temp:        look.temp,
        tint:        look.tint,
        texture:     look.texture,
        clarity:     look.clarity,
    };
}

function rgbToRgbaArr(rgb) {
    const rgba = new Uint8ClampedArray(rgb.length / 3 * 4);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
        rgba[j] = rgb[i]; rgba[j+1] = rgb[i+1]; rgba[j+2] = rgb[i+2]; rgba[j+3] = 255;
    }
    return rgba;
}

const cardByFilename = new Map();

function findTauriCard(path) {
    const name = path.split(/[\\/]/).pop();
    return cardByFilename.get(name);
}

let tauriStatSeq = 0;
// Batch-wide timing accumulators for the rollups the user asked for:
// "N thumbs built in Xs, avg Y ms" / "first encode at +Xs, last at +Ys, Z files/s".
let batchT0 = null;
let thumbCount = 0;
let firstEncodeT = null;
let lastEncodeT  = null;
let encodeMsSum = 0;
function resetBatchCounters() {
    batchT0 = performance.now();
    thumbCount = 0;
    firstEncodeT = null;
    lastEncodeT  = null;
    encodeMsSum = 0;
    tauriStatSeq = 0;
}
function updateBatchRollups(encodeMs) {
    const now = performance.now();
    thumbCount++;
    encodeMsSum += encodeMs || 0;
    if (firstEncodeT === null) firstEncodeT = now;
    lastEncodeT = now;
    const dt = (now - batchT0) / 1000;
    const avgThumbMs = ((now - batchT0) / thumbCount).toFixed(0);
    updateStat('rollup:thumbs',
        `[thumbs]  ${String(thumbCount).padStart(3,' ')} built  total ${dt.toFixed(1)}s  avg ${avgThumbMs} ms/file`);
    const firstDt = ((firstEncodeT - batchT0) / 1000).toFixed(1);
    const lastDt  = ((lastEncodeT  - batchT0) / 1000).toFixed(1);
    const throughput = thumbCount / Math.max(0.001, (now - batchT0) / 1000);
    const avgEnc = (encodeMsSum / thumbCount).toFixed(0);
    updateStat('rollup:encode',
        `[encode]  first +${firstDt}s  last +${lastDt}s  ` +
        `avg ${avgEnc} ms/file  throughput ${throughput.toFixed(2)} files/s`);
}

function onFileDoneTauri(filename, result) {
    const card = cardByFilename.get(filename);
    if (!card) return;
    card.classList.remove('busy');

    // Defensive paint — surface failures instead of leaving a black canvas.
    try {
        if (!result || !result.thumb) {
            throw new Error('result.thumb missing — IPC returned ' + JSON.stringify(Object.keys(result || {})));
        }
        const { data, width, height } = result.thumb;
        if (!data || !width || !height) {
            throw new Error(`thumb fields invalid: w=${width} h=${height} dataLen=${data?.length}`);
        }
        const canvas = card.querySelector('canvas');
        if (canvas) {
            canvas.width = width; canvas.height = height;
            canvas.getContext('2d').putImageData(
                new ImageData(rgbToRgbaArr(data), width, height), 0, 0);
        }
    } catch (e) {
        console.error('[tauri-thumb] paint failed for', filename, e);
        card.classList.add('error');
        const tEl = card.querySelector('.time');
        if (tEl) tEl.textContent = 'paint: ' + (e.message || e);
    }
    card._tauriResult = result;

    // Tauri-only: ship dims now, fetch pixels lazily via get_lightbox(id) on
    // first lightbox open.  Cuts per-file IPC payload by ~30 MB JSON, which
    // benchmark showed is the dominant batch-queue gap.  card._lightbox stays
    // truthy so existing _lightbox checks (havePair, raw-mode gating) work.
    if (typeof result?.lightbox_width === 'number' && result?.id != null) {
        card._lightbox = {
            rgb: null,
            w: result.lightbox_width,
            h: result.lightbox_height,
            id: result.id,
            fetching: false,
        };
    }

    // Wire JXL blob URL so toggle/decode pipeline works in Tauri mode too.
    if (result?.jxl && (result.jxl.length || result.jxl.byteLength)) {
        const jxlBytes = typeof result.jxl === 'string'
            ? Uint8Array.from(atob(result.jxl), c => c.charCodeAt(0))
            : (result.jxl instanceof Uint8Array ? result.jxl : new Uint8Array(result.jxl));
        const blob = new Blob([jxlBytes], { type: 'image/jxl' });
        if (card._blobUrl) URL.revokeObjectURL(card._blobUrl);
        card._blobUrl = URL.createObjectURL(blob);
        card._jxlDecoded = null;
        const dlBtn = card.querySelector('.thumb-dl-btn');
        if (dlBtn) dlBtn.hidden = false;
        refreshThumbToggleButton(card);
        updateToggleButtonState(card);
    }

    // If user is already viewing this card in the lightbox, kick the lazy
    // fetch + redraw now so they see the full-quality version instead of
    // staying on the embedded preview placeholder.
    if (lightboxIndex >= 0 && cards[lightboxIndex] === card) {
        drawLightboxForCard(card);
    }

    // Tauri-side per-file stat line.  `enc` (native libjxl) — distinct from
    // the WASM build's `jxl` so the source is obvious in pasted logs.
    const t = result?.timings || {};
    const exif = result?.exif || {};
    const pipeMs = (t.decompress_ms || 0) + (t.demosaic_ms || 0) + (t.tone_ms || 0);
    const totalMs = pipeMs + (t.encode_ms || 0);
    // Show the real sensor dimensions, not the downscaled lightbox.
    const imgW = exif.width  ?? result?.lightbox_width  ?? '?';
    const imgH = exif.height ?? result?.lightbox_height ?? '?';
    tauriStatSeq++;
    const name = filename.padEnd(18, ' ').slice(0, 18);
    pushStat(
        `[${String(tauriStatSeq).padStart(3, ' ')}] ${name} ${imgW}×${imgH}  ` +
        `dec ${fmtMs(t.decompress_ms)}  ` +
        `dem ${fmtMs(t.demosaic_ms)}  ` +
        `tone ${fmtMs(t.tone_ms)}  ` +
        `pipe ${fmtMs(pipeMs)}  ` +
        `enc ${fmtMs(t.encode_ms)}  ` +
        `out ${fmtKb(result?.jxl?.byteLength || result?.jxl?.length || 0)}`,
    );

    // Replace the stuck "encoding" label with the final timing.
    const tEl = card.querySelector('.time');
    if (tEl) tEl.textContent = `${(totalMs / 1000).toFixed(1)}s`;
    if (exif.wb_r != null && exif.wb_b != null) {
        bumpWbMatrix(`wb R${exif.wb_r.toFixed(3)} B${exif.wb_b.toFixed(3)}`,
                     exif.wb_from_camera ? 'mn-matrix' : 'fallback-matrix');
    }
    updateBatchRollups(t.encode_ms);
}

async function startBatchTauri(paths) {
    const opts = currentOptions();
    pushStat(`[mode]  tauri (native libjxl)  ${paths.length} files queued`);
    resetBatchCounters();
    const batchT0 = performance.now();
    let firstJxlT = null;   // time of first "encoding" event (first thumb done → JXL starts)
    let lastJxlT  = null;   // time of last  "encoding" event (last  thumb done → JXL starts)
    let thumbCount = 0;

    for (const path of paths) {
        const filename = path.split(/[\\/]/).pop();
        const card = makeCard(filename);
        card._file = { name: filename };
        card._tauriPath = path;
        cardByFilename.set(filename, card);
        cards.push(card);
        grid.appendChild(card);
        if (typeof loadSidecar === 'function') {
            loadSidecar(path).then(s => {
                if (s && typeof updateSidecarDot === 'function') updateSidecarDot(filename, true);
            });
        }
    }

    const unlisten = await listen('file_progress', ({ payload }) => {
        const card = findTauriCard(payload.path);
        if (!card) return;
        const meta = card.querySelector('.time');
        if (meta) meta.textContent = payload.stage;
        // "encoding" fires after thumbnail generation, just before JXL encode begins
        if (payload.stage === 'encoding') {
            const t = performance.now();
            if (firstJxlT === null) firstJxlT = t;
            lastJxlT = t;
            thumbCount++;
        }
    });

    // file_thumb_fast: backend emits embedded JPEG bytes immediately after parse,
    // before the ~500ms pipeline. Show camera-embedded preview so the grid fills
    // instantly, then onFileDoneTauri replaces it with the pipeline thumbnail.
    const unlistenFastThumb = await listen('file_thumb_fast', ({ payload }) => {
        const card = findTauriCard(payload.path);
        if (!card || !payload.jpeg?.length) return;
        const blob = new Blob([new Uint8Array(payload.jpeg)], { type: 'image/jpeg' });
        createImageBitmap(blob).then(bmp => {
            const orientation = payload.orientation || 1;
            if (card.classList.contains('busy') || card.classList.contains('embedded-thumb')) {
                drawOrientedThumb(card.querySelector('canvas'), bmp, orientation, 360);
                card.classList.remove('busy');
                card.classList.add('embedded-thumb');
            }
            card._embeddedPreview = { bmp, w: bmp.width, h: bmp.height, orientation };
            refreshThumbToggleButton(card);
            if (lightboxIndex >= 0 && cards[lightboxIndex] === card && !card._lightbox) {
                drawLightboxForCard(card);
                if (typeof resetLbZoom === 'function') resetLbZoom();
            }
        }).catch(() => {});
    });

    await Promise.allSettled(paths.map(async (path) => {
        const filename = path.split(/[\\/]/).pop();
        try {
            const result = await invoke('process_file', {
                path,
                options: {
                    quality: opts.quality,
                    effort: opts.effort,
                    lossless: opts.lossless,
                    look: lookToSnake(opts.look),
                    user_rotation: 0,
                    wb_r: null,
                    wb_b: null,
                },
            });
            onFileDoneTauri(filename, result);
        } catch (err) {
            const card = cardByFilename.get(filename);
            if (card) { card.classList.add('error'); card.querySelector('.time').textContent = String(err); }
        }
    }));

    unlisten();
    unlistenFastThumb();

    const batchT3 = performance.now();
    const fmt = ms => (ms / 1000).toFixed(1) + 's';
    const n = paths.length;
    console.log(
        `[Batch] ${n} file${n === 1 ? '' : 's'} | total: ${fmt(batchT3 - batchT0)}\n` +
        `  thumbnails: last ready at t+${firstJxlT !== null ? fmt(lastJxlT  - batchT0) : '?'} ` +
            `(${thumbCount}/${n} events seen)\n` +
        `  JXL start:  first at t+${firstJxlT !== null ? fmt(firstJxlT - batchT0) : '?'} | ` +
            `last at t+${lastJxlT !== null ? fmt(lastJxlT - batchT0) : '?'}\n` +
        `  JXL finish: t+${fmt(batchT3 - batchT0)} | ` +
            `JXL phase: ${lastJxlT !== null ? fmt(batchT3 - firstJxlT) : '?'}\n` +
        `  avg per file: ${fmt((batchT3 - batchT0) / n)}`
    );
}

// ─── Benchmark harness ─────────────────────────────────────────────────────
// Runs the same set of files through several configs sequentially so the
// user can A/B perf knobs on their machine.  No UI rendering — pure perf.
// c = max files in flight (Rust file-semaphore size)
// t = encoder threads per file (libjxl ThreadsRunner)
// e = JXL effort (1 = lightning … 7 = squirrel)
// peak threads during encode ≈ c × t.  12-core dev box → c × t = 12 saturates.
//
// 2-config 200-file probe.  Topology axis exhausted (c=3 t=4 wins at 3/6/20
// file scales).  Effort axis barely tested.  Two configs at champ topology
// vary only effort: e=3 Falcon vs e=2 Thunder.  Hypothesis: Thunder is either
// faster with similar size (free win) or a Lightning-style trap (bloated
// output cancels speed gain).
const BENCH_CONFIGS = [
    { label: 'c=3 t=4 e=3  Falcon (champ)',  concurrency: 3, encoder_threads: 4, effort: 3 },
    { label: 'c=3 t=4 e=2  Thunder (probe)', concurrency: 3, encoder_threads: 4, effort: 2 },
];

function _pct(arr, p) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.floor(s.length * p));
    return s[i];
}
function _stats(arr) {
    if (!arr.length) return { avg: 0, p50: 0, p95: 0, min: 0, max: 0 };
    return {
        avg: arr.reduce((s, x) => s + x, 0) / arr.length,
        p50: _pct(arr, 0.5),
        p95: _pct(arr, 0.95),
        min: arr.reduce((m, x) => Math.min(m, x), Infinity),
        max: arr.reduce((m, x) => Math.max(m, x), -Infinity),
    };
}

async function runOneConfig(paths, cfg, opts) {
    await invoke('set_concurrency', { n: cfg.concurrency });
    // Pre-size + write-by-index so completion-race doesn't shuffle drift order.
    const perFile = new Array(paths.length);
    const t0 = performance.now();
    await Promise.allSettled(paths.map(async (path, idx) => {
        const tStart = performance.now();
        try {
            const result = await invoke('process_file', {
                path,
                options: {
                    quality: opts.quality,
                    effort: cfg.effort,
                    lossless: opts.lossless,
                    look: lookToSnake(opts.look),
                    user_rotation: 0,
                    wb_r: null,
                    wb_b: null,
                    encoder_threads: cfg.encoder_threads,
                },
            });
            const tEnd = performance.now();
            const t = result?.timings || {};
            perFile[idx] = {
                path,
                wall_ms:    tEnd - tStart,
                start_ms:   tStart - t0,
                end_ms:     tEnd - t0,
                dec_ms:     t.decompress_ms || 0,
                dem_ms:     t.demosaic_ms   || 0,
                tone_ms:    t.tone_ms       || 0,
                enc_ms:     t.encode_ms     || 0,
                jxl_bytes:  result?.jxl?.length || 0,
            };
        } catch (err) {
            perFile[idx] = { error: String(err), path };
        }
    }));
    const wallMs = performance.now() - t0;
    return { cfg, wallMs, perFile };
}

function reportConfig(r) {
    const n = r.perFile.length;
    const ok = r.perFile.filter(p => !p.error);
    const errs = n - ok.length;
    const amortMs = r.wallMs / n;
    const tput = n / (r.wallMs / 1000);
    pushStat(
        `[bench] ${r.cfg.label}  total ${(r.wallMs / 1000).toFixed(2)}s  ` +
        `amort ${amortMs.toFixed(0)} ms/f  tput ${tput.toFixed(2)} f/s` +
        (errs ? `  ERRORS ${errs}` : '')
    );
    if (!ok.length) return;

    const dec   = _stats(ok.map(p => p.dec_ms));
    const dem   = _stats(ok.map(p => p.dem_ms));
    const tone  = _stats(ok.map(p => p.tone_ms));
    const enc   = _stats(ok.map(p => p.enc_ms));
    const wall  = _stats(ok.map(p => p.wall_ms));
    const sizes = _stats(ok.map(p => p.jxl_bytes / 1024));

    pushStat(`[bench]   dec   avg ${dec.avg.toFixed(0)}  p50 ${dec.p50}  p95 ${dec.p95}  max ${dec.max} ms`);
    pushStat(`[bench]   dem   avg ${dem.avg.toFixed(0)}  p50 ${dem.p50}  p95 ${dem.p95}  max ${dem.max} ms`);
    pushStat(`[bench]   tone  avg ${tone.avg.toFixed(0)}  p50 ${tone.p50}  p95 ${tone.p95}  max ${tone.max} ms`);
    pushStat(`[bench]   enc   avg ${enc.avg.toFixed(0)}  p50 ${enc.p50}  p95 ${enc.p95}  max ${enc.max} ms`);
    pushStat(`[bench]   wall  avg ${wall.avg.toFixed(0)}  p50 ${wall.p50.toFixed(0)}  p95 ${wall.p95.toFixed(0)}  max ${wall.max.toFixed(0)} ms`);
    pushStat(`[bench]   size  avg ${sizes.avg.toFixed(0)}  p50 ${sizes.p50.toFixed(0)}  p95 ${sizes.p95.toFixed(0)}  min ${sizes.min.toFixed(0)}  max ${sizes.max.toFixed(0)} KB  total ${(sizes.avg * ok.length / 1024).toFixed(1)} MB`);

    // Drift: split by dispatch index, compare first vs last half stage averages
    const half = Math.floor(ok.length / 2);
    const firstHalf = ok.slice(0, half);
    const lastHalf  = ok.slice(ok.length - half);
    const avg = (arr, k) => arr.reduce((s, p) => s + p[k], 0) / arr.length;
    const driftAmort  = (avg(lastHalf, 'wall_ms') - avg(firstHalf, 'wall_ms'));
    const driftDec    = (avg(lastHalf, 'dec_ms')  - avg(firstHalf, 'dec_ms'));
    const driftEnc    = (avg(lastHalf, 'enc_ms')  - avg(firstHalf, 'enc_ms'));
    const pct = (delta, base) => base > 0 ? `${delta >= 0 ? '+' : ''}${(100 * delta / base).toFixed(1)}%` : 'n/a';
    pushStat(
        `[bench]   drift  wall ${avg(firstHalf, 'wall_ms').toFixed(0)}→${avg(lastHalf, 'wall_ms').toFixed(0)} ms (${pct(driftAmort, avg(firstHalf, 'wall_ms'))})  ` +
        `dec ${pct(driftDec, avg(firstHalf, 'dec_ms'))}  enc ${pct(driftEnc, avg(firstHalf, 'enc_ms'))}`
    );

    // Top 3 slowest by wall_ms
    const fname = (p) => (p.split(/[\\/]/).pop() || p);
    const slowest = ok.slice().sort((a, b) => b.wall_ms - a.wall_ms).slice(0, 3);
    pushStat('[bench]   slowest 3:');
    for (const p of slowest) {
        pushStat(`[bench]     ${fname(p.path)}  wall ${p.wall_ms.toFixed(0)} ms  dec ${p.dec_ms} dem ${p.dem_ms} tone ${p.tone_ms} enc ${p.enc_ms}  ${(p.jxl_bytes/1024).toFixed(0)} KB`);
    }
    pushStat('');
}

async function runBenchmark() {
    if (!IS_TAURI) {
        pushStat('[bench] tauri-only — benchmark needs the native pipeline');
        return;
    }
    let paths;
    try {
        paths = await invoke('pick_files');
    } catch (err) {
        pushStat(`[bench] pick_files failed: ${err}`);
        return;
    }
    if (!paths?.length) { pushStat('[bench] cancelled — no files'); return; }
    const opts = currentOptions();
    pushStat(`[bench] ${paths.length} files × ${BENCH_CONFIGS.length} configs starting…`);

    const rows = [];
    for (let i = 0; i < BENCH_CONFIGS.length; i++) {
        const cfg = BENCH_CONFIGS[i];
        updateStat('bench:status', `[bench] running ${i + 1}/${BENCH_CONFIGS.length}  ${cfg.label}…`);
        const r = await runOneConfig(paths, cfg, opts);
        rows.push(r);
        reportConfig(r);
    }

    // A/B Pareto comparison (only meaningful for 2 configs).
    if (rows.length === 2) {
        pushStat('[bench] === A vs B Pareto ===');
        const a = rows[0], b = rows[1];
        const okA = a.perFile.filter(p => !p.error);
        const okB = b.perFile.filter(p => !p.error);
        const tputA = a.perFile.length / (a.wallMs / 1000);
        const tputB = b.perFile.length / (b.wallMs / 1000);
        const avgSizeA = okA.reduce((s, p) => s + p.jxl_bytes, 0) / okA.length / 1024;
        const avgSizeB = okB.reduce((s, p) => s + p.jxl_bytes, 0) / okB.length / 1024;
        const totalA = okA.reduce((s, p) => s + p.jxl_bytes, 0) / 1024 / 1024;
        const totalB = okB.reduce((s, p) => s + p.jxl_bytes, 0) / 1024 / 1024;
        const speedDelta = 100 * (tputB - tputA) / tputA;
        const sizeDelta  = 100 * (avgSizeB - avgSizeA) / avgSizeA;
        pushStat(`[bench]   A: ${a.cfg.label}`);
        pushStat(`[bench]   B: ${b.cfg.label}`);
        pushStat(`[bench]   speed  A ${tputA.toFixed(2)} f/s  →  B ${tputB.toFixed(2)} f/s  (${speedDelta >= 0 ? '+' : ''}${speedDelta.toFixed(1)}%)`);
        pushStat(`[bench]   size   A ${avgSizeA.toFixed(0)} KB/f → B ${avgSizeB.toFixed(0)} KB/f  (${sizeDelta >= 0 ? '+' : ''}${sizeDelta.toFixed(1)}%)`);
        pushStat(`[bench]   total  A ${totalA.toFixed(1)} MB    → B ${totalB.toFixed(1)} MB`);
        let verdict;
        if (speedDelta > 0 && sizeDelta <= 2) verdict = 'B WINS — faster, no size cost (replace default)';
        else if (speedDelta > 0 && sizeDelta < speedDelta) verdict = 'B Pareto-wins on speed (gains > size cost)';
        else if (speedDelta > 0)                          verdict = 'TRAP — B faster but size cost ≥ speed gain (Lightning-style)';
        else if (Math.abs(speedDelta) < 2)                verdict = 'TIE — keep A (smaller)';
        else                                              verdict = 'A holds — B slower';
        pushStat(`[bench]   ⇒ ${verdict}`);
    }

    updateStat('bench:status', `[bench] done — ${rows.length} configs, ${paths.length} files each`);

    // Restore the default concurrency for normal operation.
    await invoke('set_concurrency', { n: 3 });
}

// Wire the button at module init.
const benchBtn = document.getElementById('run-benchmark');
if (benchBtn) {
    benchBtn.addEventListener('click', () => {
        benchBtn.disabled = true;
        runBenchmark().catch(e => pushStat(`[bench] ${e?.message || e}`))
                      .finally(() => { benchBtn.disabled = false; });
    });
}

// Effort sweep: e=1..9 at fixed c=3 t=4.  Reports per-file output size so we
// can read the speed/size Pareto.  Same files run 9 times; quality + lossless
// come from current UI settings (same as Benchmark).
async function runEffortSweep() {
    if (!IS_TAURI) {
        pushStat('[sweep] tauri-only — needs the native pipeline');
        return;
    }
    let paths;
    try { paths = await invoke('pick_files'); }
    catch (err) { pushStat(`[sweep] pick_files failed: ${err}`); return; }
    if (!paths?.length) { pushStat('[sweep] cancelled — no files'); return; }
    const opts = currentOptions();
    const fname = (p) => (p.split(/[\\/]/).pop() || p);

    pushStat(`[sweep] ${paths.length} files × 9 efforts (c=3 t=4, q=${opts.quality}, lossless=${opts.lossless})`);
    pushStat('[sweep] effort key: 1 Lightning · 2 Thunder · 3 Falcon · 4 Cheetah · 5 Hare · 6 Wombat · 7 Squirrel · 8 Kitten · 9 Tortoise');

    const rows = [];
    for (let e = 1; e <= 9; e++) {
        const cfg = { label: `c=3 t=4 e=${e}`, concurrency: 3, encoder_threads: 4, effort: e };
        updateStat('bench:status', `[sweep] running e=${e}…`);
        const r = await runOneConfig(paths, cfg, opts);
        rows.push({ effort: e, ...r });
        const ok = r.perFile.filter(p => !p.error);
        const totalKB = ok.reduce((s, p) => s + p.jxl_bytes, 0) / 1024;
        const avgKB   = ok.length ? totalKB / ok.length : 0;
        const avgEnc  = ok.length ? ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length : 0;
        const sizesStr = r.perFile.map((p, i) =>
            p.error ? `${fname(paths[i])}=ERR` : `${fname(paths[i])}=${(p.jxl_bytes/1024).toFixed(0)}KB`
        ).join(' · ');
        pushStat(
            `[sweep] e=${e}  ` +
            `wall ${(r.wallMs/1000).toFixed(2)}s  ` +
            `enc ${avgEnc.toFixed(0)} ms/file  ` +
            `avg ${avgKB.toFixed(0)} KB  ` +
            `total ${totalKB.toFixed(0)} KB`
        );
        pushStat(`[sweep]   sizes: ${sizesStr}`);
    }

    pushStat('');
    pushStat('[sweep] === effort vs size table ===');
    pushStat('[sweep]  e   wall_s   enc_ms   avg_KB   total_KB');
    for (const r of rows) {
        const ok = r.perFile.filter(p => !p.error);
        const totalKB = ok.reduce((s, p) => s + p.jxl_bytes, 0) / 1024;
        const avgKB   = ok.length ? totalKB / ok.length : 0;
        const avgEnc  = ok.length ? ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length : 0;
        pushStat(
            `[sweep]  ${r.effort}` +
            `   ${(r.wallMs/1000).toFixed(2).padStart(6)}` +
            `   ${avgEnc.toFixed(0).padStart(6)}` +
            `   ${avgKB.toFixed(0).padStart(6)}` +
            `   ${totalKB.toFixed(0).padStart(8)}`
        );
    }
    updateStat('bench:status', `[sweep] done — 9 efforts × ${paths.length} files`);
    await invoke('set_concurrency', { n: 3 });
}

const sweepBtn = document.getElementById('run-effort-sweep');
if (sweepBtn) {
    sweepBtn.addEventListener('click', () => {
        sweepBtn.disabled = true;
        runEffortSweep().catch(e => pushStat(`[sweep] ${e?.message || e}`))
                        .finally(() => { sweepBtn.disabled = false; });
    });
}

// Variance × effort bench: picks 5 size-spread files from the user's
// pick, sweeps effort 3/6/7/8/9, reports size matrix + upload-quota
// economics.  Targets chosen from prior 20-file run to span ~6× output
// size range (Falcon column values: 973 → 5575 KB).
//
// Match by filename prefix so '.ORF' / ' - Copy.ORF' suffix variants
// resolve to the same logical target.
const VARIANCE_TARGETS = [
    'P1110187',  // ~973 KB Falcon — smooth scene, low entropy
    'P1100086',  // ~1866 KB
    'P1110179',  // ~3182 KB
    'P1100149',  // ~4788 KB
    'P1110202',  // ~5575 KB — high entropy
];
const VARIANCE_EFFORTS = [3, 6, 7, 8, 9];
const VARIANCE_TOPOLOGY = { concurrency: 3, encoder_threads: 4 };
// Starlink-ish assumptions for upload-time economics.  Edit as needed.
const QUOTA_GB = 50;
const UPLOAD_MBPS = 25;  // typical Starlink upload, MB-per-sec ≈ Mbps/8

async function runVarianceBench() {
    if (!IS_TAURI) { pushStat('[var] tauri-only'); return; }
    let allPaths;
    try { allPaths = await invoke('pick_files'); }
    catch (err) { pushStat(`[var] pick_files failed: ${err}`); return; }
    if (!allPaths?.length) { pushStat('[var] cancelled'); return; }

    const fname = (p) => (p.split(/[\\/]/).pop() || p);
    const baseUC = (p) => fname(p).replace(/\.[Oo][Rr][Ff]$/, '').toUpperCase();
    const selected = [];
    const missing = [];
    for (const target of VARIANCE_TARGETS) {
        const tu = target.toUpperCase();
        const hit = allPaths.find(p => baseUC(p).startsWith(tu));
        if (hit) selected.push({ target, path: hit });
        else missing.push(target);
    }
    if (missing.length) pushStat(`[var] missing: ${missing.join(', ')}`);
    if (!selected.length) { pushStat('[var] no targets found in selection'); return; }

    const opts = currentOptions();
    pushStat(`[var] ${selected.length} files × ${VARIANCE_EFFORTS.length} efforts  c=${VARIANCE_TOPOLOGY.concurrency} t=${VARIANCE_TOPOLOGY.encoder_threads} q=${opts.quality} lossless=${opts.lossless}`);
    pushStat(`[var] targets: ${selected.map(s => fname(s.path)).join(', ')}`);
    pushStat('[var] effort key: 3 Falcon · 5 Hare · 6 Wombat · 7 Squirrel · 8 Kitten · 9 Tortoise');

    const paths = selected.map(s => s.path);
    // matrix[effortIndex] = { e, perFile: [{path, enc_ms, jxl_bytes, ...}], wallMs }
    const matrix = [];
    for (let i = 0; i < VARIANCE_EFFORTS.length; i++) {
        const e = VARIANCE_EFFORTS[i];
        const cfg = { label: `e=${e}`, concurrency: VARIANCE_TOPOLOGY.concurrency, encoder_threads: VARIANCE_TOPOLOGY.encoder_threads, effort: e };
        updateStat('bench:status', `[var] ${i+1}/${VARIANCE_EFFORTS.length}  effort ${e}…`);
        const r = await runOneConfig(paths, cfg, opts);
        matrix.push({ effort: e, ...r });
        const ok = r.perFile.filter(p => !p.error);
        const totalKB = ok.reduce((s, p) => s + p.jxl_bytes, 0) / 1024;
        const avgKB   = totalKB / ok.length;
        const avgEnc  = ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length;
        pushStat(`[var] e=${e}  wall ${(r.wallMs/1000).toFixed(2)}s  enc ${avgEnc.toFixed(0)} ms/f  avg ${avgKB.toFixed(0)} KB  total ${totalKB.toFixed(0)} KB`);
    }

    // === size matrix: rows = files, columns = effort ===
    pushStat('');
    pushStat('[var] === size matrix (KB per file) ===');
    const header = 'file              ' + VARIANCE_EFFORTS.map(e => `   e=${e}`).join('  ');
    pushStat('[var] ' + header);
    for (let f = 0; f < paths.length; f++) {
        const row = VARIANCE_EFFORTS.map((_, ei) => {
            const p = matrix[ei].perFile[f];
            return p && !p.error ? (p.jxl_bytes/1024).toFixed(0).padStart(6) : '   ERR';
        }).join('  ');
        pushStat(`[var] ${fname(paths[f]).padEnd(18)}${row}`);
    }

    // === aggregate Pareto + quota economics ===
    pushStat('');
    pushStat('[var] === effort vs size + upload economics ===');
    pushStat(`[var]  quota = ${QUOTA_GB} GB/mo  upload = ${UPLOAD_MBPS} Mbps (${(UPLOAD_MBPS/8).toFixed(1)} MB/s)`);
    pushStat('[var]  e   avgKB   enc_s   vs_e3_size   vs_e3_enc   files/quota   upload_s   total_s');
    const baseE3 = matrix[0];
    const baseOk = baseE3.perFile.filter(p => !p.error);
    const baseAvgKB = baseOk.reduce((s, p) => s + p.jxl_bytes, 0) / baseOk.length / 1024;
    const baseAvgEnc = baseOk.reduce((s, p) => s + p.enc_ms, 0) / baseOk.length / 1000;
    const uploadMBps = UPLOAD_MBPS / 8;
    for (const r of matrix) {
        const ok = r.perFile.filter(p => !p.error);
        const avgKB  = ok.reduce((s, p) => s + p.jxl_bytes, 0) / ok.length / 1024;
        const avgEnc = ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length / 1000;
        const sizeDelta = 100 * (avgKB  - baseAvgKB)  / baseAvgKB;
        const encDelta  = 100 * (avgEnc - baseAvgEnc) / baseAvgEnc;
        const filesPerQuota = (QUOTA_GB * 1024 * 1024) / avgKB;
        const uploadS = (avgKB / 1024) / uploadMBps;   // KB → MB → s
        const totalS  = avgEnc + uploadS;
        const sdStr = (sizeDelta >= 0 ? '+' : '') + sizeDelta.toFixed(1) + '%';
        const edStr = (encDelta  >= 0 ? '+' : '') + encDelta.toFixed(1)  + '%';
        pushStat(
            `[var]  ${r.effort}` +
            `  ${avgKB.toFixed(0).padStart(6)}` +
            `  ${avgEnc.toFixed(2).padStart(6)}` +
            `  ${sdStr.padStart(11)}` +
            `  ${edStr.padStart(10)}` +
            `  ${filesPerQuota.toFixed(0).padStart(12)}` +
            `  ${uploadS.toFixed(2).padStart(8)}` +
            `  ${totalS.toFixed(2).padStart(8)}`
        );
    }

    // === verdict: pick the effort that minimises total time-to-upload ===
    pushStat('');
    let bestTotal = { effort: 0, totalS: Infinity };
    let bestSize  = { effort: 0, avgKB: Infinity };
    let bestQuota = { effort: 0, files: 0 };
    for (const r of matrix) {
        const ok = r.perFile.filter(p => !p.error);
        const avgKB  = ok.reduce((s, p) => s + p.jxl_bytes, 0) / ok.length / 1024;
        const avgEnc = ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length / 1000;
        const totalS = avgEnc + (avgKB / 1024) / uploadMBps;
        const files  = (QUOTA_GB * 1024 * 1024) / avgKB;
        if (totalS < bestTotal.totalS) bestTotal = { effort: r.effort, totalS };
        if (avgKB  < bestSize.avgKB)   bestSize  = { effort: r.effort, avgKB };
        if (files  > bestQuota.files)  bestQuota = { effort: r.effort, files };
    }
    pushStat(`[var] BEST encode+upload total time:  e=${bestTotal.effort}  (${bestTotal.totalS.toFixed(2)} s/file)`);
    pushStat(`[var] BEST output size:               e=${bestSize.effort}  (${bestSize.avgKB.toFixed(0)} KB/file)`);
    pushStat(`[var] BEST files per ${QUOTA_GB} GB quota:        e=${bestQuota.effort}  (${bestQuota.files.toFixed(0)} files)`);
    updateStat('bench:status', `[var] done`);
    await invoke('set_concurrency', { n: 3 });
}

const varBtn = document.getElementById('run-variance-bench');
if (varBtn) {
    varBtn.addEventListener('click', () => {
        varBtn.disabled = true;
        runVarianceBench().catch(e => pushStat(`[var] ${e?.message || e}`))
                          .finally(() => { varBtn.disabled = false; });
    });
}

// Quality sweep: q=80/85/90/95 at fixed c=3 t=4 e=3 Falcon on 10 files
// sampled with even spread across the picked folder.  Anchor size deltas at
// q=90 (current production default).  Headline metric = files-per-50GB-quota.
const QUALITY_VALUES = [80, 85, 90, 95];
const QUALITY_TOPOLOGY = { concurrency: 3, encoder_threads: 4, effort: 3 };
const QUALITY_SAMPLE_N = 10;

async function runQualitySweep() {
    if (!IS_TAURI) { pushStat('[q] tauri-only'); return; }
    let allPaths;
    try { allPaths = await invoke('pick_files'); }
    catch (err) { pushStat(`[q] pick_files failed: ${err}`); return; }
    if (!allPaths?.length) { pushStat('[q] cancelled'); return; }

    const fname = (p) => (p.split(/[\\/]/).pop() || p);
    const n = allPaths.length;
    // Even-spread sampling: pick floor(i * n / N) for i in 0..N.  Avoids
    // clustering that random sampling can produce.
    const paths = [];
    if (n <= QUALITY_SAMPLE_N) {
        paths.push(...allPaths);
    } else {
        for (let i = 0; i < QUALITY_SAMPLE_N; i++) {
            paths.push(allPaths[Math.floor(i * n / QUALITY_SAMPLE_N)]);
        }
    }

    const baseOpts = currentOptions();
    pushStat(`[q] picked ${n} files, sampling ${paths.length} with even spread`);
    pushStat(`[q] sweep q=${QUALITY_VALUES.join('/')} at c=${QUALITY_TOPOLOGY.concurrency} t=${QUALITY_TOPOLOGY.encoder_threads} e=${QUALITY_TOPOLOGY.effort} Falcon  lossless=${baseOpts.lossless}`);
    pushStat('[q] chosen files:');
    for (let i = 0; i < paths.length; i++) {
        pushStat(`[q]   ${String(i+1).padStart(2)}. ${fname(paths[i])}`);
    }

    // matrix[qIndex] = { quality, perFile, wallMs, cfg }
    const matrix = [];
    for (let i = 0; i < QUALITY_VALUES.length; i++) {
        const q = QUALITY_VALUES[i];
        const cfg = { label: `q=${q}`, ...QUALITY_TOPOLOGY };
        const opts = { ...baseOpts, quality: q };
        updateStat('bench:status', `[q] ${i+1}/${QUALITY_VALUES.length}  q=${q}…`);
        const r = await runOneConfig(paths, cfg, opts);
        matrix.push({ quality: q, ...r });
        const ok = r.perFile.filter(p => !p.error);
        const totalKB = ok.reduce((s, p) => s + p.jxl_bytes, 0) / 1024;
        const avgKB   = ok.length ? totalKB / ok.length : 0;
        const avgEnc  = ok.length ? ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length : 0;
        pushStat(`[q] q=${q}  wall ${(r.wallMs/1000).toFixed(2)}s  enc ${avgEnc.toFixed(0)} ms/f  avg ${avgKB.toFixed(0)} KB  total ${totalKB.toFixed(0)} KB`);
    }

    // === size matrix: rows = files, columns = quality ===
    pushStat('');
    pushStat('[q] === size matrix (KB per file) ===');
    const header = 'file                  ' + QUALITY_VALUES.map(q => `  q=${q}`).join('  ');
    pushStat('[q] ' + header);
    for (let f = 0; f < paths.length; f++) {
        const row = QUALITY_VALUES.map((_, qi) => {
            const p = matrix[qi].perFile[f];
            return p && !p.error ? (p.jxl_bytes/1024).toFixed(0).padStart(5) : '  ERR';
        }).join('  ');
        pushStat(`[q] ${fname(paths[f]).padEnd(22)}${row}`);
    }

    // === aggregate Pareto + quota economics, anchored at q=90 ===
    pushStat('');
    pushStat('[q] === quality vs size + upload economics ===');
    pushStat(`[q]  quota = ${QUOTA_GB} GB/mo  upload = ${UPLOAD_MBPS} Mbps (${(UPLOAD_MBPS/8).toFixed(1)} MB/s)  anchor = q=90`);
    pushStat('[q]  q    avgKB   p50KB   p95KB   enc_ms   vs_q90_size   files/quota   upload_s   total_s');
    const baseIdx = QUALITY_VALUES.indexOf(90);
    const baseRow = matrix[baseIdx];
    const baseOk = baseRow.perFile.filter(p => !p.error);
    const baseAvgKB = baseOk.reduce((s, p) => s + p.jxl_bytes, 0) / baseOk.length / 1024;
    const uploadMBps = UPLOAD_MBPS / 8;
    for (const r of matrix) {
        const ok = r.perFile.filter(p => !p.error);
        const sizesKB = ok.map(p => p.jxl_bytes / 1024);
        const sStats  = _stats(sizesKB);
        const avgKB   = sStats.avg;
        const avgEnc  = ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length;
        const sizeDelta = 100 * (avgKB - baseAvgKB) / baseAvgKB;
        const filesPerQuota = (QUOTA_GB * 1024 * 1024) / avgKB;
        const uploadS = (avgKB / 1024) / uploadMBps;
        const totalS  = (avgEnc / 1000) + uploadS;
        const sdStr = (sizeDelta >= 0 ? '+' : '') + sizeDelta.toFixed(1) + '%';
        pushStat(
            `[q]  ${r.quality}` +
            `  ${avgKB.toFixed(0).padStart(6)}` +
            `  ${sStats.p50.toFixed(0).padStart(6)}` +
            `  ${sStats.p95.toFixed(0).padStart(6)}` +
            `  ${avgEnc.toFixed(0).padStart(7)}` +
            `  ${sdStr.padStart(12)}` +
            `  ${filesPerQuota.toFixed(0).padStart(12)}` +
            `  ${uploadS.toFixed(2).padStart(8)}` +
            `  ${totalS.toFixed(2).padStart(8)}`
        );
    }

    // === verdicts ===
    pushStat('');
    let bestTotal = { quality: 0, totalS: Infinity };
    let bestSize  = { quality: 0, avgKB: Infinity };
    let bestQuota = { quality: 0, files: 0 };
    for (const r of matrix) {
        const ok = r.perFile.filter(p => !p.error);
        const avgKB  = ok.reduce((s, p) => s + p.jxl_bytes, 0) / ok.length / 1024;
        const avgEnc = ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length / 1000;
        const totalS = avgEnc + (avgKB / 1024) / uploadMBps;
        const files  = (QUOTA_GB * 1024 * 1024) / avgKB;
        if (totalS < bestTotal.totalS) bestTotal = { quality: r.quality, totalS };
        if (avgKB  < bestSize.avgKB)   bestSize  = { quality: r.quality, avgKB };
        if (files  > bestQuota.files)  bestQuota = { quality: r.quality, files };
    }
    pushStat(`[q] BEST encode+upload total time:  q=${bestTotal.quality}  (${bestTotal.totalS.toFixed(2)} s/file)`);
    pushStat(`[q] BEST output size:               q=${bestSize.quality}  (${bestSize.avgKB.toFixed(0)} KB/file)`);
    pushStat(`[q] BEST files per ${QUOTA_GB} GB quota:        q=${bestQuota.quality}  (${bestQuota.files.toFixed(0)} files)`);
    updateStat('bench:status', `[q] done`);
    await invoke('set_concurrency', { n: 3 });
}

const qBtn = document.getElementById('run-quality-sweep');
if (qBtn) {
    qBtn.addEventListener('click', () => {
        qBtn.disabled = true;
        runQualitySweep().catch(e => pushStat(`[q] ${e?.message || e}`))
                         .finally(() => { qBtn.disabled = false; });
    });
}

// ============================================================================
// Pixel-peep quality compare mode
// ----------------------------------------------------------------------------
// Pick N photos.  Queue encodes globally in priority order — q=80 for every
// photo first (so all show up viewable fastest), then q=75/85, then 70/90/95.
// Each photo: decode all available qualities; paint the current peepQuality
// or fallback to nearest-decoded quality so something is always on screen.
// Lightbox opens at 100% pixels (no fit-to-screen).  Up/Down cycle quality;
// Left/Right switch photo preserving zoom+pan (tripod compare).  Esc exits.
// ============================================================================
// Full ladder: q=50..95 in steps of 5, then lossless JXL (bit-exact for RGB,
// i.e. visually identical to uncompressed source — just much smaller bytes).
const PEEP_QUALITIES = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 'lossless'];
// Encode order: sweet-spot + anchors first so the most informative variants
// are viewable early.  Tauri semaphore drains the rest in submission order.
const PEEP_PRIORITY  = [80, 95, 'lossless', 70, 90, 60, 85, 50, 75, 65, 55];
const PEEP_INITIAL_Q = 80;
const fmtPeepQ = (q) => typeof q === 'number' ? `q=${q}` : q;
const PEEP_EFFORT = 3;
const PEEP_ENCODER_THREADS = 4;
const PEEP_CONCURRENCY = 3;

let pixelPeepActive = false;
let peepPaths = [];
let peepIdx = 0;
let peepQuality = PEEP_INITIAL_Q;
// peepCache: Map<photoIdx, { jxlBytes:{q:Uint8Array}, decoded:{q:{rgba,w,h}}, encodeMs:{q:number}, sizeBytes:{q:number}, doneCount:number }>
const peepCache = new Map();

async function runPixelPeep() {
    if (!IS_TAURI) { pushStat('[peep] tauri-only'); return; }
    let paths;
    try { paths = await invoke('pick_files'); }
    catch (err) { pushStat(`[peep] pick_files failed: ${err}`); return; }
    if (!paths?.length) { pushStat('[peep] cancelled'); return; }

    pixelPeepActive = true;
    peepPaths = paths;
    peepIdx = 0;
    peepQuality = PEEP_INITIAL_Q;
    peepCache.clear();
    // Seed cache entries so .then() callbacks can locate their photo idx.
    for (let i = 0; i < paths.length; i++) {
        peepCache.set(i, { jxlBytes: {}, decoded: {}, encodeMs: {}, sizeBytes: {}, doneCount: 0 });
    }

    await invoke('set_concurrency', { n: PEEP_CONCURRENCY });
    pushStat(`[peep] ${paths.length} photos  ladder=${PEEP_QUALITIES.join('/')}  e=${PEEP_EFFORT} Falcon`);
    pushStat(`[peep] queue order: ${PEEP_PRIORITY.join(' → ')}  (all photos per step)`);
    pushStat(`[peep] note: 'raw' aliases 'lossless' decode (lossless JXL is bit-exact); size shown as uncompressed RGB bytes`);
    pushStat('[peep] keys: ↑/↓ quality · ←/→ photo · Esc exit · wheel zoom · drag pan');

    openPeepLightbox();
    queuePeepEncodes();
}

function openPeepLightbox() {
    // Fresh canvas — pixel-peep starts blank until first decode arrives.
    lightboxCanvas.width = 1;
    lightboxCanvas.height = 1;
    lbZoom = 1.0;   // 100% pixels, NOT fit-to-screen
    lbPanX = 0;
    lbPanY = 0;
    lbRotation = 0;
    applyLbTransform();
    lbPreviewBadge.hidden = true;
    lbLoadingBadge.hidden = false;
    lightbox.hidden = false;
    lightbox.classList.add('peep-mode');
    // Clear stale lightbox state from any prior normal-mode open.
    lightboxIndex = -1;
    if (lightboxInfo) lightboxInfo.innerHTML = '';
    // Source indicators repurposed: show current peep quality, not RAW/JXL/JPEG.
    if (lbSourceBanner) {
        lbSourceBanner.hidden = false;
        lbSourceBanner.setAttribute('data-source', 'peep');
        lbSourceBanner.textContent = fmtPeepQ(peepQuality);
    }
    if (lbToggleJpegBtn) {
        lbToggleJpegBtn.disabled = true;
    }
    updatePeepBadges();
    pushStat(`[peep] open: lightbox.hidden=${lightbox.hidden} canvas=${lightboxCanvas.width}x${lightboxCanvas.height} zoom=${lbZoom}`);
}

function _fmtMB(bytes) {
    if (bytes == null) return '—';
    const mb = bytes / (1024 * 1024);
    return mb >= 10 ? `${mb.toFixed(1)} MB` : `${mb.toFixed(2)} MB`;
}

// Persistent HUD: current quality + compressed JXL bytes + uncompressed RGB
// bytes (raw reference) + zoom %.  Replaces the old centred fade label.
function updatePeepBadges() {
    if (!lbSourceBanner) return;
    const entry = peepCache.get(peepIdx);
    const compBytes = entry?.sizeBytes?.[peepQuality];
    // Raw RGB bytes from any decoded variant for this photo — dims are the
    // same for every quality.
    let rawBytes = null;
    if (entry?.decoded) {
        for (const k in entry.decoded) {
            const d = entry.decoded[k];
            if (d?.w && d?.h) { rawBytes = d.w * d.h * 3; break; }
        }
    }
    const compStr = compBytes != null ? _fmtMB(compBytes) : 'loading';
    const rawStr  = rawBytes  != null ? _fmtMB(rawBytes)  : '—';
    const zoomStr = `${Math.round(lbZoom * 100)}%`;
    const photoStr = peepPaths.length > 1 ? `  ${peepIdx + 1}/${peepPaths.length}` : '';
    lbSourceBanner.textContent =
        `${fmtPeepQ(peepQuality)}   ${compStr} / raw ${rawStr}   ${zoomStr}${photoStr}`;
    if (lbToggleJpegBtn) lbToggleJpegBtn.textContent = fmtPeepQ(peepQuality);
}

// Fire all N×6 encodes in priority order.  Tauri's set_concurrency semaphore
// queues excess work — order of submission decides what completes first.
function queuePeepEncodes() {
    for (const q of PEEP_PRIORITY) {
        for (let idx = 0; idx < peepPaths.length; idx++) {
            kickPeepEncode(idx, q);
        }
    }
}

function kickPeepEncode(idx, q) {
    const path = peepPaths[idx];
    const baseOpts = currentOptions();
    const isLossless = q === 'lossless';
    const t0 = performance.now();
    invoke('process_file', {
        path,
        options: {
            // Tauri side accepts quality even when lossless=true; libjxl ignores it.
            quality: isLossless ? 100 : q,
            effort: PEEP_EFFORT,
            lossless: isLossless,
            look: lookToSnake(baseOpts.look),
            user_rotation: 0,
            wb_r: null,
            wb_b: null,
            encoder_threads: PEEP_ENCODER_THREADS,
        },
    }).then((result) => {
        if (!pixelPeepActive || !peepCache.has(idx)) return;
        const e = peepCache.get(idx);
        const bytes = new Uint8Array(result.jxl);
        e.jxlBytes[q] = bytes;
        e.encodeMs[q] = performance.now() - t0;
        e.sizeBytes[q] = bytes.byteLength;
        e.doneCount++;
        pushStat(`[peep]   photo ${idx+1} ${fmtPeepQ(q)} ready  ${(e.encodeMs[q]/1000).toFixed(2)}s  ${(bytes.byteLength/1024).toFixed(0)} KB`);
        decodePeepQuality(idx, q);
        if (idx === peepIdx) updatePeepBadges();
    }).catch((err) => {
        if (!peepCache.has(idx)) return;
        const e = peepCache.get(idx);
        e.encodeMs[q] = -1;
        e.doneCount++;
        pushStat(`[peep]   photo ${idx+1} ${fmtPeepQ(q)} FAILED: ${err}`);
    });
}

function decodePeepQuality(idx, q) {
    const entry = peepCache.get(idx);
    if (!entry || !entry.jxlBytes[q] || entry.decoded[q]) return;
    const blob = new Blob([entry.jxlBytes[q]], { type: 'image/jxl' });
    const url = URL.createObjectURL(blob);
    pool.decodeJxl(url, (msg) => {
        URL.revokeObjectURL(url);
        if (!pixelPeepActive) return;
        if (!peepCache.has(idx)) return;
        if (msg.type === 'decode_error') {
            pushStat(`[peep]   photo ${idx+1} q=${q} decode error: ${msg.error}`);
            return;
        }
        const e = peepCache.get(idx);
        e.decoded[q] = { rgba: msg.rgba, w: msg.w, h: msg.h };
        pushStat(`[peep]   photo ${idx+1} ${fmtPeepQ(q)} decoded  ${msg.w}×${msg.h}`);
        if (idx === peepIdx) { paintPeepCurrent(); updatePeepBadges(); }
    });
}

// Walk outward from peepQuality to find the nearest decoded variant.
function pickNearestDecoded(entry, want) {
    if (entry.decoded[want]) return { dec: entry.decoded[want], q: want, fallback: false };
    const idx = PEEP_QUALITIES.indexOf(want);
    for (let d = 1; d < PEEP_QUALITIES.length; d++) {
        const lo = idx - d, hi = idx + d;
        if (hi < PEEP_QUALITIES.length) {
            const q = PEEP_QUALITIES[hi];
            if (entry.decoded[q]) return { dec: entry.decoded[q], q, fallback: true };
        }
        if (lo >= 0) {
            const q = PEEP_QUALITIES[lo];
            if (entry.decoded[q]) return { dec: entry.decoded[q], q, fallback: true };
        }
    }
    return null;
}

function paintPeepCurrent() {
    const entry = peepCache.get(peepIdx);
    if (!entry) { lbLoadingBadge.hidden = false; return; }
    const pick = pickNearestDecoded(entry, peepQuality);
    if (!pick) {
        if (entry.jxlBytes[peepQuality]) decodePeepQuality(peepIdx, peepQuality);
        lbLoadingBadge.hidden = false;
        return;
    }
    const { dec, q: paintedQ, fallback } = pick;
    try {
        lightboxCanvas.width = dec.w;
        lightboxCanvas.height = dec.h;
        const ctx = lightboxCanvas.getContext('2d');
        // Force fresh ImageData even if rgba is plain Uint8Array (not Clamped).
        const rgba = dec.rgba instanceof Uint8ClampedArray
            ? dec.rgba
            : new Uint8ClampedArray(dec.rgba.buffer, dec.rgba.byteOffset, dec.rgba.byteLength);
        ctx.putImageData(new ImageData(rgba, dec.w, dec.h), 0, 0);
        if (typeof setCleanCanvas === 'function' && lightboxCanvas.width > 0) {
            setCleanCanvas(ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height));
        }
        pushStat(`[peep] painted photo ${peepIdx+1} ${fmtPeepQ(paintedQ)}  ${dec.w}×${dec.h}`);
    } catch (err) {
        pushStat(`[peep] PAINT FAILED photo ${peepIdx+1} ${fmtPeepQ(paintedQ)}: ${err?.message || err}`);
        console.error('paintPeepCurrent error', err, dec);
        return;
    }
    lbLoadingBadge.hidden = !fallback;
    applyLbTransform();
    updatePeepBadges();
}

function peepNavPhoto(delta) {
    const n = peepPaths.length;
    if (n <= 1) return;
    peepIdx = (peepIdx + delta + n) % n;
    paintPeepCurrent();
    updatePeepBadges();
}

function peepCycleQuality(delta) {
    const i = PEEP_QUALITIES.indexOf(peepQuality);
    const ni = (i + delta + PEEP_QUALITIES.length) % PEEP_QUALITIES.length;
    peepQuality = PEEP_QUALITIES[ni];
    const entry = peepCache.get(peepIdx);
    if (entry && !entry.decoded[peepQuality] && entry.jxlBytes[peepQuality]) {
        decodePeepQuality(peepIdx, peepQuality);
    }
    paintPeepCurrent();
    updatePeepBadges();
}

function exitPixelPeep() {
    pixelPeepActive = false;
    peepCache.clear();
    peepPaths = [];
    lightbox.hidden = true;
    lightbox.classList.remove('peep-mode');
    lbLoadingBadge.hidden = true;
    pushStat('[peep] exited');
}

const peepBtn = document.getElementById('run-pixel-peep');
if (peepBtn) {
    peepBtn.addEventListener('click', () => {
        peepBtn.disabled = true;
        runPixelPeep().catch(e => pushStat(`[peep] ${e?.message || e}`))
                      .finally(() => { peepBtn.disabled = false; });
    });
}

// Tauri live-look: invoked from triggerLiveUpdate when IS_TAURI
let tauriLiveInFlight = false;
let tauriLivePending = null;

async function triggerLiveUpdateTauri(look) {
    const card = cards[lightboxIndex];
    if (!card || !card._tauriResult) return;
    if (tauriLiveInFlight) { tauriLivePending = look; return; }
    tauriLiveInFlight = true;
    try {
        const frame = await invoke('apply_look', {
            id: card._tauriResult.id,
            look: lookToSnake(look),
        });
        const ctx = lightboxCanvas.getContext('2d');
        ctx.putImageData(new ImageData(rgbToRgbaArr(frame.data), frame.width, frame.height), 0, 0);
        if (typeof setCleanCanvas === 'function' && lightboxCanvas.width > 0) {
            setCleanCanvas(ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height));
        }
    } catch (e) {
        console.warn('apply_look error:', e);
    }
    tauriLiveInFlight = false;
    if (tauriLivePending) { const p = tauriLivePending; tauriLivePending = null; triggerLiveUpdateTauri(p); }
}

// Settings modal (Tauri only)
if (IS_TAURI) {
    const settingsHtml = `
        <dialog id="tauri-settings-dialog" style="padding:1.5rem;border-radius:8px;border:1px solid #444;background:#1a1a1a;color:#eee;min-width:320px">
          <form method="dialog">
            <h3 style="margin-top:0">Planner Settings</h3>
            <label style="display:block;margin-bottom:0.75rem">Bearer token
              <input id="tauri-token-input" type="password" autocomplete="off" style="display:block;width:100%;margin-top:4px;padding:4px;background:#2a2a2a;color:#eee;border:1px solid #555">
            </label>
            <label style="display:block;margin-bottom:1rem">Planner URL
              <input id="tauri-url-input" type="url" value="http://localhost:3001" style="display:block;width:100%;margin-top:4px;padding:4px;background:#2a2a2a;color:#eee;border:1px solid #555">
            </label>
            <button type="submit" style="padding:4px 12px">Save</button>
            <button type="button" onclick="document.getElementById('tauri-settings-dialog').close()" style="padding:4px 12px;margin-left:8px">Cancel</button>
          </form>
        </dialog>`;
    document.body.insertAdjacentHTML('beforeend', settingsHtml);

    const settingsBtn = document.createElement('button');
    settingsBtn.id = 'tauri-settings-btn';
    settingsBtn.title = 'Planner Settings';
    settingsBtn.textContent = '⚙';
    settingsBtn.style.cssText = 'position:fixed;top:8px;right:8px;z-index:9999;padding:4px 8px;background:#2a2a2a;color:#eee;border:1px solid #555;border-radius:4px;cursor:pointer;display:none';
    // document.body.appendChild(settingsBtn);

    settingsBtn.addEventListener('click', async () => {
        const dialog = document.getElementById('tauri-settings-dialog');
        const [settings, token] = await Promise.all([invoke('get_settings'), invoke('get_token')]);
        document.getElementById('tauri-url-input').value = settings.planner_url;
        document.getElementById('tauri-token-input').value = token ? '••••••••' : '';
        dialog.showModal();
    });

    document.getElementById('tauri-settings-dialog').addEventListener('close', async (e) => {
        const dialog = e.target;
        const tokenInput = document.getElementById('tauri-token-input');
        const urlInput = document.getElementById('tauri-url-input');
        if (tokenInput.value && !tokenInput.value.startsWith('•')) {
            await invoke('set_token', { token: tokenInput.value });
        }
        await invoke('set_settings', { settings: { planner_url: urlInput.value } });
    });
}
