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
const BUILD_TAG = '2026-05-11g / wb-subifd + colormatrix + texture-clarity';

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

const qualityRange = document.getElementById('quality-range');
const qualityLabel = document.getElementById('quality-label');
const effortSelect = document.getElementById('effort-select');
const losslessToggle = document.getElementById('lossless-toggle');

const reprocessBtn = document.getElementById('reprocess-btn');
const resetLookBtn = document.getElementById('reset-look');

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
// Encoder option state
// ---------------------------------------------------------------------------
function currentOptions() {
    return {
        quality: Number(qualityRange.value),
        effort: Number(effortSelect.value),
        lossless: losslessToggle.checked,
        look: {
            exposureEv: lookValueFor('exposureEv'),
            contrast:   lookValueFor('contrast'),
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
        },
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
    });
}

reprocessBtn.addEventListener('click', () => reprocessSelected());
resetLookBtn.addEventListener('click', () => {
    for (const el of lookInputs) el.value = el.dataset.look === 'exposureEv' ? '0' : '0';
    refreshLookLabels();
});

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
    }

    init() {
        for (let i = 0; i < this.size; i++) {
            const w = new Worker(new URL('./worker.js', import.meta.url), {
                type: 'module',
            });
            w.addEventListener('message', (ev) => this._onMessage(w, ev));
            w.addEventListener('error', (ev) => console.error('worker error:', ev));
            this.workers.push(w);
            this.free.push(w);
        }
    }

    submit(bytes, options, handlers) {
        const id = this.nextId++;
        this.tasks.set(id, { handlers, worker: null });
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
        const t = this.tasks.get(id);
        if (!t) return;
        const handlers = t.handlers;
        if (type === 'thumb' && handlers.onThumb) handlers.onThumb(ev.data);
        else if (type === 'lightbox' && handlers.onLightbox) handlers.onLightbox(ev.data);
        else if (type === 'done') {
            if (handlers.onDone) handlers.onDone(ev.data);
            this._release(worker, id);
        } else if (type === 'error') {
            if (handlers.onError) handlers.onError(ev.data);
            this._release(worker, id);
        }
    }

    _release(worker, id) {
        this.tasks.delete(id);
        this.free.push(worker);
        const next = this.queue.shift();
        if (next) this._dispatch(next);
    }
}

const pool = new WorkerPool(POOL_SIZE);
pool.init();

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
        <div class="meta">
            <span class="name"></span>
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
    return card;
}

function refreshReprocessLabel() {
    const n = document.querySelectorAll('.thumb.selected').length;
    reprocessBtn.textContent = n ? `Re-process ${n} selected` : 'Re-process all';
}

function drawCanvas(canvas, w, h, rgb) {
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
        rgba[j] = rgb[i];
        rgba[j + 1] = rgb[i + 1];
        rgba[j + 2] = rgb[i + 2];
        rgba[j + 3] = 255;
    }
    ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
}

let totalSubmitted = 0;
let totalDone = 0;

function startConvert(file, existingCard) {
    const card = existingCard || makeCard(file.name);
    if (!existingCard) {
        cards.push(card);
        grid.appendChild(card);
    } else {
        // Re-processing: clear prior download link + reset state classes.
        card.classList.remove('encoding', 'error');
        card.classList.add('busy');
        const link = card.querySelector('.download');
        link.hidden = true;
        link.removeAttribute('href');
        card._lightbox = null;
    }
    totalSubmitted++;
    card._file = file;
    refreshStatus();

    file.arrayBuffer()
        .then((buf) => {
            pool.submit(new Uint8Array(buf), currentOptions(), {
                onThumb(msg) {
                    drawCanvas(card.querySelector('canvas'), msg.w, msg.h, msg.rgb);
                    card._pipelineMs = msg.pipelineMs;
                    card._phaseMs = msg.phaseMs;
                    // Show thumb immediately — JXL still encoding in background.
                    card.classList.remove('busy');
                    card.classList.add('encoding');
                },
                onLightbox(msg) {
                    card._lightbox = { rgb: msg.rgb, w: msg.w, h: msg.h };
                },
                onDone(msg) {
                    card.classList.remove('encoding');
                    const blob = new Blob([msg.jxl], { type: 'image/jxl' });
                    const url = URL.createObjectURL(blob);
                    const link = card.querySelector('.download');
                    link.href = url;
                    link.download = file.name.replace(/\.orf$/i, '.jxl');
                    link.textContent = `JXL ${(msg.jxl.byteLength / 1024).toFixed(0)} KB`;
                    link.hidden = false;
                    card.querySelector('.size').textContent =
                        `${(msg.jxl.byteLength / 1024).toFixed(0)} KB`;
                    card._meta =
                        `${msg.w}×${msg.h} • pipeline ${card._pipelineMs.toFixed(0)} ms • JXL ${msg.jxlMs.toFixed(0)} ms`;
                    card.addEventListener('click', () => openLightbox(card));

                    // Stats line — keeps everything one image needs on one row.
                    statSeq++;
                    const p = card._phaseMs || {};
                    const name = file.name.padEnd(18, ' ').slice(0, 18);
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
// Lightbox
// ---------------------------------------------------------------------------
let lightboxIndex = -1;

function openLightbox(card) {
    lightboxIndex = cards.indexOf(card);
    drawLightbox();
    lightbox.hidden = false;
}

function drawLightbox() {
    const card = cards[lightboxIndex];
    if (!card || !card._lightbox) return;
    const { rgb, w, h } = card._lightbox;
    drawCanvas(lightboxCanvas, w, h, rgb);
    lightboxInfo.textContent = card._meta || '';
}

function closeLightbox() {
    lightbox.hidden = true;
    lightboxIndex = -1;
}

function nextInLightbox(dir) {
    if (lightboxIndex < 0) return;
    let i = lightboxIndex;
    // Skip cards that haven't finished pipeline yet (no _lightbox data).
    for (let step = 0; step < cards.length; step++) {
        i = (i + dir + cards.length) % cards.length;
        if (cards[i]._lightbox) {
            lightboxIndex = i;
            drawLightbox();
            return;
        }
    }
}

lightboxClose.addEventListener('click', closeLightbox);
lightboxPrev.addEventListener('click', () => nextInLightbox(-1));
lightboxNext.addEventListener('click', () => nextInLightbox(1));
lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) closeLightbox();
});

document.addEventListener('keydown', (e) => {
    if (lightbox.hidden) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowRight') nextInLightbox(1);
    else if (e.key === 'ArrowLeft') nextInLightbox(-1);
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
