import initRaw, * as rawWasm from '../pkg/raw_converter_wasm.js';
import { createEncoder, createDecoder } from '@casabio/jxl-wasm';

// === IDB ===

const IDB_NAME = 'jxl-preset-bench';
const IDB_STORE = 'sources';
let idbAvailable = true;
let _db = null;

async function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE);
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

async function getDb() {
    if (_db) return _db;
    _db = await openDb();
    return _db;
}

async function idbPut(slot, record) {
    if (!idbAvailable) return;
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(record, slot);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}

async function idbGet(slot) {
    if (!idbAvailable) return null;
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(slot);
        req.onsuccess = (e) => resolve(e.target.result ?? null);
        req.onerror = (e) => reject(e.target.error);
    });
}

// === File intake ===

const SLOTS = [
    { id: 'orf',   label: 'ORF',   accept: '.orf,.ORF',         colorClass: 'slot-orf'  },
    { id: 'dng',   label: 'DNG',   accept: '.dng,.DNG',         colorClass: 'slot-dng'  },
    { id: 'cr2',   label: 'CR2',   accept: '.cr2,.CR2',         colorClass: 'slot-cr2'  },
    { id: 'jpeg',  label: 'JPEG',  accept: '.jpg,.jpeg,.png',   colorClass: 'slot-jpeg' },
    { id: 'other', label: 'OTHER', accept: '*',                 colorClass: 'slot-other'},
];

// Exported: consumed by Task 6 sweep engine and Task 9 UI
export const loadedSources = {};

// DOM refs keyed by slot.id
const slotFilenameEls = {};
const slotCardEls = {};

function buildFileIntake() {
    const container = document.getElementById('file-slots');
    if (!container) return;

    for (const slot of SLOTS) {
        const card = document.createElement('div');
        card.className = `slot-card ${slot.colorClass}`;
        card.dataset.slotId = slot.id;

        const label = document.createElement('div');
        label.className = 'slot-label';
        label.textContent = slot.label;

        const filenameBadge = document.createElement('div');
        filenameBadge.className = 'slot-name';
        filenameBadge.textContent = 'drop or click';

        const metaBadge = document.createElement('div');
        metaBadge.className = 'slot-meta';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = slot.accept;
        fileInput.style.display = 'none';
        fileInput.setAttribute('aria-label', `Pick ${slot.label} file`);

        card.appendChild(label);
        card.appendChild(filenameBadge);
        card.appendChild(metaBadge);
        card.appendChild(fileInput);
        container.appendChild(card);

        slotFilenameEls[slot.id] = filenameBadge;
        slotCardEls[slot.id] = card;

        // Click → open file picker
        card.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('click', (e) => e.stopPropagation());

        // Drag-and-drop
        card.addEventListener('dragover', (e) => {
            e.preventDefault();
            card.style.background = 'rgba(255,255,255,0.08)';
        });
        card.addEventListener('dragleave', () => {
            card.style.background = '';
        });
        card.addEventListener('drop', async (e) => {
            e.preventDefault();
            card.style.background = '';
            const file = e.dataTransfer?.files?.[0];
            if (file) await handleFile(slot, file);
        });

        // File picker selection
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (file) {
                await handleFile(slot, file);
                fileInput.value = '';
            }
        });
    }
}

function setSlotFilename(slotId, name) {
    const el = slotFilenameEls[slotId];
    if (el) el.textContent = name;
}

function setSlotError(slotId, msg) {
    const card = slotCardEls[slotId];
    if (card) card.style.borderColor = 'var(--danger)';
    const el = slotFilenameEls[slotId];
    if (el) el.textContent = msg ?? 'decode error';
}

function clearSlotError(slotId) {
    const card = slotCardEls[slotId];
    if (card) card.style.borderColor = '';
}

async function handleFile(slot, file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = file.name.split('.').pop() ?? '';
    clearSlotError(slot.id);
    try {
        const result = await decodeSource(bytes, ext);
        loadedSources[slot.id] = { name: file.name, ...result };
        if (idbAvailable) {
            try {
                await idbPut(slot.id, { name: file.name, bytes, ext });
            } catch (err) {
                console.warn('[preset-bench] IDB write failed:', err);
            }
        }
        setSlotFilename(slot.id, file.name);
    } catch (err) {
        console.error(`[preset-bench] Decode failed for slot ${slot.id}:`, err);
        loadedSources[slot.id] = null;
        setSlotError(slot.id, 'decode error');
    }
}

// === Decode ===

async function decodeViaWasm(bytes, wasmFn) {
    const result = wasmFn(bytes, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
    try {
        const rgb = result.take_rgb();
        const rgba = new Uint8ClampedArray(rawWasm.rgb_to_rgba(rgb).buffer);
        return { rgba, width: result.width, height: result.height };
    } finally {
        result.free();
    }
}

async function decodeViaImageBitmap(bytes, ext) {
    const blob = new Blob([bytes]);
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const imgData = ctx.getImageData(0, 0, width, height);
    bitmap.close();
    return { rgba: imgData.data, width, height };
}

async function decodeSource(bytes, ext) {
    const ext_lower = ext.toLowerCase();
    if (ext_lower === 'orf')  return decodeViaWasm(bytes, rawWasm.process_orf);
    if (ext_lower === 'dng')  return decodeViaWasm(bytes, rawWasm.process_dng);
    if (ext_lower === 'cr2')  return decodeViaWasm(bytes, rawWasm.process_cr2);
    // jpeg/png/other
    return decodeViaImageBitmap(bytes, ext);
}

// === Init ===

try {
    const db = await getDb();
    void db; // ensure open succeeds
} catch (err) {
    console.warn('[preset-bench] IndexedDB unavailable, running memory-only:', err);
    idbAvailable = false;
}

await initRaw();

buildFileIntake();

// Restore previously stored files from IDB
for (const slot of SLOTS) {
    let record = null;
    try {
        record = await idbGet(slot.id);
    } catch (err) {
        console.warn(`[preset-bench] IDB read failed for slot ${slot.id}:`, err);
    }
    if (!record) continue;
    try {
        const result = await decodeSource(record.bytes, record.ext);
        loadedSources[slot.id] = { name: record.name, ...result };
        setSlotFilename(slot.id, record.name);
    } catch (err) {
        console.error(`[preset-bench] Restore decode failed for slot ${slot.id}:`, err);
        loadedSources[slot.id] = null;
        setSlotError(slot.id, 'decode error');
    }
}

// =============================================================================
// Sweep engine — Task 6
// =============================================================================

// --- Constants ---------------------------------------------------------------

const TIERS = [
    { id: 'low',      label: 'Low',      quality: 72,  lossless: false },
    { id: 'medium',   label: 'Medium',   quality: 85,  lossless: false },
    { id: 'high',     label: 'High',     quality: 92,  lossless: false },
    { id: 'lossless', label: 'Lossless', quality: 100, lossless: true  },
];
const SIZES    = [128, 512, 1920, 'full'];
const EFFORTS  = [1, 2, 3, 4, 5, 6];
const DEC_SPEEDS  = [0, 1, 2, 3, 4];
const MODULAR_VALS = [-1, 0, 1];
const BROTLI_VALS  = [-1, 0, 4, 9];
const RESAMP_VALS  = [1, 2, 4];

// --- Result storage ----------------------------------------------------------

export const sweepRows   = [];
export let sweepAborted  = false;
export let sweepRunning  = false;

// --- UI stubs (wired in Task 9) ----------------------------------------------

export function updatePhaseStatus(phaseNum, status) {
    // status: 'pending' | 'active' | 'done' | null
    console.log(`[sweep] phase ${phaseNum} → ${status}`);
}

export function updateLiveStatus(msg) {
    console.log(`[sweep] ${msg}`);
}

// --- Helpers -----------------------------------------------------------------

function _exactBuf(view) {
    if (view instanceof ArrayBuffer) return view;
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function _concatChunks(chunks) {
    const views = chunks.map(c => c instanceof Uint8Array ? c : new Uint8Array(c));
    if (views.length === 1) return views[0];
    const total = views.reduce((s, v) => s + v.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const v of views) { out.set(v, offset); offset += v.byteLength; }
    return out;
}

function resizeRgba(source, targetPx) {
    if (targetPx === 'full') return { rgba: source.rgba, width: source.width, height: source.height };
    const scale = targetPx / Math.max(source.width, source.height);
    if (scale >= 1) return { rgba: source.rgba, width: source.width, height: source.height };
    const w = Math.round(source.width * scale);
    const h = Math.round(source.height * scale);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const srcCanvas = new OffscreenCanvas(source.width, source.height);
    const srcCtx = srcCanvas.getContext('2d');
    srcCtx.putImageData(new ImageData(source.rgba, source.width, source.height), 0, 0);
    ctx.drawImage(srcCanvas, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    return { rgba: data, width: w, height: h };
}

async function encodeOnce(rgbaResized, width, height, opts) {
    // opts: { quality, lossless, effort, decodingSpeed, modular, brotliEffort, resampling }
    const t0 = performance.now();
    const encOpts = {
        format: 'rgba8',
        width,
        height,
        hasAlpha: true,
        quality: opts.lossless ? null : opts.quality,
        distance: opts.lossless ? 0 : null,
        effort: opts.effort,
        progressive: false,
        previewFirst: false,
        chunked: false,
        decodingSpeed: opts.decodingSpeed > 0 ? opts.decodingSpeed : undefined,
        resampling: opts.resampling !== 1 ? opts.resampling : undefined,
        modular: opts.modular !== -1 ? opts.modular : undefined,
        brotliEffort: opts.brotliEffort >= 0 ? opts.brotliEffort : undefined,
    };
    const encoder = createEncoder(encOpts);
    const chunks = [];
    try {
        const chunkTask = (async () => {
            for await (const chunk of encoder.chunks()) chunks.push(chunk);
        })();
        await encoder.pushPixels(_exactBuf(rgbaResized));
        await encoder.finish();
        await chunkTask;
        const jxlBytes = _concatChunks(chunks);
        return { jxlBytes, encMs: performance.now() - t0 };
    } finally {
        await encoder.dispose();
    }
}

async function decodeOnce(jxlBytes) {
    const t0 = performance.now();
    const decoder = createDecoder({
        format: 'rgba8',
        region: null,
        downsample: 1,
        progressionTarget: 'final',
        emitEveryPass: false,
        preserveIcc: false,
        preserveMetadata: false,
    });
    try {
        await decoder.push(_exactBuf(jxlBytes));
        await decoder.close();
        let info = null;
        for await (const ev of decoder.events()) {
            if (ev.type === 'final') { info = ev.info; break; }
        }
        return { decMs: performance.now() - t0, width: info?.width ?? 0, height: info?.height ?? 0 };
    } finally {
        await decoder.dispose();
    }
}

async function median(fn, n) {
    // Run fn() n times; return median of results
    const results = [];
    for (let i = 0; i < n; i++) results.push(await fn());
    results.sort((a, b) => a.encMs - b.encMs);
    return results[Math.floor(n / 2)];
}

function _medianOf(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

// --- Score computation -------------------------------------------------------

function computeScores(rows) {
    if (!rows.length) return;
    const minSize = Math.min(...rows.map(r => r.sizeBytes));
    const minEnc  = Math.min(...rows.map(r => r.encMs));
    const minDec  = Math.min(...rows.map(r => r.decMs));
    for (const r of rows) {
        const sizeEff  = minSize / r.sizeBytes;
        const encSpeed = minEnc  / r.encMs;
        const decSpeed = minDec  / r.decMs;
        r.score = Math.round((sizeEff * 0.4 + encSpeed * 0.4 + decSpeed * 0.2) * 100);
    }
}

// --- Knee-point algorithm ----------------------------------------------------

function kneePoint(efforts, sizes, times) {
    for (let i = 1; i < efforts.length; i++) {
        const sizeReduction = (sizes[i - 1] - sizes[i]) / sizes[i - 1];
        const timeCost      = (times[i] - times[i - 1]) / times[i - 1];
        if (timeCost > 3 * sizeReduction) return efforts[i - 1];
    }
    // No knee: return effort with minimum size
    let minIdx = 0;
    for (let i = 1; i < sizes.length; i++) if (sizes[i] < sizes[minIdx]) minIdx = i;
    return efforts[minIdx];
}

// --- Phase-2 best decode speed selector -------------------------------------

function bestDecSpeedFor(rows, baselineEncMs) {
    const valid = rows.filter(r => r.encMs <= 2 * baselineEncMs);
    if (!valid.length) return 0;
    return valid.reduce((best, r) => r.decMs < best.decMs ? r : best).decSpeed;
}

// --- Abort / yield -----------------------------------------------------------

async function nextFrame() {
    return new Promise(r => requestAnimationFrame(r));
}

// --- Main sweep orchestrator -------------------------------------------------

export async function runSweep(options = {}) {
    const {
        tiers: tierFilter   = TIERS.map(t => t.id),
        sizes: sizeFilter   = SIZES,
        runsPerConfig       = 3,
    } = options;

    sweepRunning = true;
    sweepAborted = false;
    sweepRows.length = 0;

    const activeTiers = TIERS.filter(t => tierFilter.includes(t.id));
    const activeSizes = SIZES.filter(s => sizeFilter.includes(s));
    const activeFiles = SLOTS.filter(s => loadedSources[s.id]);

    const bestEffort   = {}; // [tier.id][file][sizePx]
    const bestDecSpeed = {}; // [tier.id][file][sizePx]
    const bestModular  = {}; // [tier.id]
    const bestBrotli   = {}; // [tier.id]
    const bestResamp   = {}; // [tier.id][file][sizePx]

    try {
        // =====================================================================
        // Phase 1: Effort sweep
        // =====================================================================
        updatePhaseStatus(1, 'active');
        const phase1Rows = [];

        for (const tier of activeTiers) {
            bestEffort[tier.id] ??= {};
            for (const fileSlot of activeFiles) {
                bestEffort[tier.id][fileSlot.id] ??= {};
                const src = loadedSources[fileSlot.id];
                for (const sizePx of activeSizes) {
                    const { rgba, width, height } = resizeRgba(src, sizePx);
                    const effortRows = [];

                    for (const effort of EFFORTS) {
                        if (sweepAborted) return;
                        updateLiveStatus(`P1 ${tier.label} · ${fileSlot.label} · ${sizePx}px · effort ${effort}`);

                        const encMsVals = [], decMsVals = [], sizeVals = [];
                        for (let run = 0; run < runsPerConfig; run++) {
                            const enc = await encodeOnce(rgba, width, height, {
                                quality: tier.quality,
                                lossless: tier.lossless,
                                effort,
                                decodingSpeed: 0,
                                modular: -1,
                                brotliEffort: -1,
                                resampling: 1,
                            });
                            const dec = await decodeOnce(enc.jxlBytes);
                            encMsVals.push(enc.encMs);
                            decMsVals.push(dec.decMs);
                            sizeVals.push(enc.jxlBytes.byteLength);
                        }

                        const row = {
                            file: fileSlot.id,
                            sizePx,
                            tier: tier.id,
                            phase: 1,
                            effort,
                            decSpeed: 0,
                            modular: -1,
                            brotli: -1,
                            resamp: 1,
                            encMs:     _medianOf(encMsVals),
                            decMs:     _medianOf(decMsVals),
                            sizeBytes: _medianOf(sizeVals),
                            score: 0,
                        };
                        effortRows.push(row);
                        sweepRows.push(row);
                        phase1Rows.push(row);

                        await nextFrame();
                        if (sweepAborted) return;
                    }

                    // Knee-point to pick best effort
                    const efforts = effortRows.map(r => r.effort);
                    const sizes   = effortRows.map(r => r.sizeBytes);
                    const times   = effortRows.map(r => r.encMs);
                    bestEffort[tier.id][fileSlot.id][sizePx] = kneePoint(efforts, sizes, times);
                }
            }
        }

        for (const tier of activeTiers) {
            computeScores(phase1Rows.filter(r => r.tier === tier.id));
        }
        updatePhaseStatus(1, 'done');
        if (sweepAborted) return;

        // =====================================================================
        // Phase 2: Decode speed sweep
        // =====================================================================
        updatePhaseStatus(2, 'active');
        const phase2Rows = [];

        for (const tier of activeTiers) {
            bestDecSpeed[tier.id] ??= {};
            for (const fileSlot of activeFiles) {
                bestDecSpeed[tier.id][fileSlot.id] ??= {};
                const src = loadedSources[fileSlot.id];
                for (const sizePx of activeSizes) {
                    const { rgba, width, height } = resizeRgba(src, sizePx);
                    const effort = bestEffort[tier.id]?.[fileSlot.id]?.[sizePx] ?? 4;
                    const decRows = [];

                    // Baseline: decodingSpeed=0
                    let baselineEncMs = null;

                    for (const decSpeed of DEC_SPEEDS) {
                        if (sweepAborted) return;
                        updateLiveStatus(`P2 ${tier.label} · ${fileSlot.label} · ${sizePx}px · decSpeed ${decSpeed}`);

                        const encMsVals = [], decMsVals = [], sizeVals = [];
                        for (let run = 0; run < runsPerConfig; run++) {
                            const enc = await encodeOnce(rgba, width, height, {
                                quality: tier.quality,
                                lossless: tier.lossless,
                                effort,
                                decodingSpeed: decSpeed,
                                modular: -1,
                                brotliEffort: -1,
                                resampling: 1,
                            });
                            const dec = await decodeOnce(enc.jxlBytes);
                            encMsVals.push(enc.encMs);
                            decMsVals.push(dec.decMs);
                            sizeVals.push(enc.jxlBytes.byteLength);
                        }

                        const row = {
                            file: fileSlot.id,
                            sizePx,
                            tier: tier.id,
                            phase: 2,
                            effort,
                            decSpeed,
                            modular: -1,
                            brotli: -1,
                            resamp: 1,
                            encMs:     _medianOf(encMsVals),
                            decMs:     _medianOf(decMsVals),
                            sizeBytes: _medianOf(sizeVals),
                            score: 0,
                        };

                        if (decSpeed === 0) baselineEncMs = row.encMs;
                        decRows.push(row);
                        sweepRows.push(row);
                        phase2Rows.push(row);

                        await nextFrame();
                        if (sweepAborted) return;
                    }

                    bestDecSpeed[tier.id][fileSlot.id][sizePx] =
                        bestDecSpeedFor(decRows, baselineEncMs ?? decRows[0].encMs);
                }
            }
        }

        for (const tier of activeTiers) {
            computeScores(phase2Rows.filter(r => r.tier === tier.id));
        }
        updatePhaseStatus(2, 'done');
        if (sweepAborted) return;

        // =====================================================================
        // Phase 3: Modular × Brotli (512px only)
        // =====================================================================
        updatePhaseStatus(3, 'active');
        const phase3Rows = [];

        for (const tier of activeTiers) {
            const comboRows = [];

            for (const fileSlot of activeFiles) {
                const src = loadedSources[fileSlot.id];
                const sizePx = 512;
                const { rgba, width, height } = resizeRgba(src, sizePx);
                const effort   = bestEffort[tier.id]?.[fileSlot.id]?.[sizePx] ??
                                 bestEffort[tier.id]?.[fileSlot.id]?.[activeSizes[0]] ?? 4;
                const decSpeed = bestDecSpeed[tier.id]?.[fileSlot.id]?.[sizePx] ??
                                 bestDecSpeed[tier.id]?.[fileSlot.id]?.[activeSizes[0]] ?? 0;

                for (const modular of MODULAR_VALS) {
                    for (const brotli of BROTLI_VALS) {
                        if (sweepAborted) return;
                        updateLiveStatus(`P3 ${tier.label} · ${fileSlot.label} · mod ${modular} brotli ${brotli}`);

                        const encMsVals = [], decMsVals = [], sizeVals = [];
                        for (let run = 0; run < runsPerConfig; run++) {
                            const enc = await encodeOnce(rgba, width, height, {
                                quality: tier.quality,
                                lossless: tier.lossless,
                                effort,
                                decodingSpeed: decSpeed,
                                modular,
                                brotliEffort: brotli,
                                resampling: 1,
                            });
                            const dec = await decodeOnce(enc.jxlBytes);
                            encMsVals.push(enc.encMs);
                            decMsVals.push(dec.decMs);
                            sizeVals.push(enc.jxlBytes.byteLength);
                        }

                        const row = {
                            file: fileSlot.id,
                            sizePx,
                            tier: tier.id,
                            phase: 3,
                            effort,
                            decSpeed,
                            modular,
                            brotli,
                            resamp: 1,
                            encMs:     _medianOf(encMsVals),
                            decMs:     _medianOf(decMsVals),
                            sizeBytes: _medianOf(sizeVals),
                            score: 0,
                        };
                        comboRows.push(row);
                        sweepRows.push(row);
                        phase3Rows.push(row);

                        await nextFrame();
                        if (sweepAborted) return;
                    }
                }
            }

            // Best modular+brotli: minimise encMs (primary), sizeBytes (secondary)
            if (comboRows.length) {
                const best = comboRows.reduce((b, r) => {
                    if (r.encMs < b.encMs) return r;
                    if (r.encMs === b.encMs && r.sizeBytes < b.sizeBytes) return r;
                    return b;
                });
                bestModular[tier.id] = best.modular;
                bestBrotli[tier.id]  = best.brotli;
            }
        }

        for (const tier of activeTiers) {
            computeScores(phase3Rows.filter(r => r.tier === tier.id));
        }
        updatePhaseStatus(3, 'done');
        if (sweepAborted) return;

        // =====================================================================
        // Phase 4: Resampling sweep
        // =====================================================================
        updatePhaseStatus(4, 'active');
        const phase4Rows = [];

        for (const tier of activeTiers) {
            bestResamp[tier.id] ??= {};
            for (const fileSlot of activeFiles) {
                bestResamp[tier.id][fileSlot.id] ??= {};
                const src = loadedSources[fileSlot.id];
                for (const sizePx of activeSizes) {
                    const { rgba, width, height } = resizeRgba(src, sizePx);
                    const effort   = bestEffort[tier.id]?.[fileSlot.id]?.[sizePx] ?? 4;
                    const decSpeed = bestDecSpeed[tier.id]?.[fileSlot.id]?.[sizePx] ?? 0;
                    const modular  = bestModular[tier.id] ?? -1;
                    const brotli   = bestBrotli[tier.id]  ?? -1;
                    const resampRows = [];

                    for (const resamp of RESAMP_VALS) {
                        if (sweepAborted) return;
                        updateLiveStatus(`P4 ${tier.label} · ${fileSlot.label} · ${sizePx}px · resamp ${resamp}`);

                        const encMsVals = [], decMsVals = [], sizeVals = [];
                        for (let run = 0; run < runsPerConfig; run++) {
                            const enc = await encodeOnce(rgba, width, height, {
                                quality: tier.quality,
                                lossless: tier.lossless,
                                effort,
                                decodingSpeed: decSpeed,
                                modular,
                                brotliEffort: brotli,
                                resampling: resamp,
                            });
                            const dec = await decodeOnce(enc.jxlBytes);
                            encMsVals.push(enc.encMs);
                            decMsVals.push(dec.decMs);
                            sizeVals.push(enc.jxlBytes.byteLength);
                        }

                        const row = {
                            file: fileSlot.id,
                            sizePx,
                            tier: tier.id,
                            phase: 4,
                            effort,
                            decSpeed,
                            modular,
                            brotli,
                            resamp,
                            encMs:     _medianOf(encMsVals),
                            decMs:     _medianOf(decMsVals),
                            sizeBytes: _medianOf(sizeVals),
                            score: 0,
                        };
                        resampRows.push(row);
                        sweepRows.push(row);
                        phase4Rows.push(row);

                        await nextFrame();
                        if (sweepAborted) return;
                    }

                    // Best resampling: minimum sizeBytes
                    if (resampRows.length) {
                        bestResamp[tier.id][fileSlot.id][sizePx] =
                            resampRows.reduce((b, r) => r.sizeBytes < b.sizeBytes ? r : b).resamp;
                    }
                }
            }
        }

        for (const tier of activeTiers) {
            computeScores(phase4Rows.filter(r => r.tier === tier.id));
        }
        updatePhaseStatus(4, 'done');

    } finally {
        sweepRunning = false;
        if (!sweepAborted) updatePhaseStatus(null, null); // all phases done
    }
}

export function abortSweep() {
    if (sweepRunning) sweepAborted = true;
}

// =============================================================================
// Chart.js graphs — Task 7
// =============================================================================

const SIZE_COLORS = ['#4ade80', '#60a5fa', '#f97316', '#a78bfa'];

// { p1a, p1b, p2, p3 } — Chart instances
let charts = {};

/**
 * Average rows matching sizePx and a single parameter value, returning the
 * given metric. Returns null when no matching rows exist.
 * @param {object[]} rows
 * @param {number|string} sizePx
 * @param {number|string} paramVal  value of paramKey to filter on
 * @param {string} paramKey         row property name (e.g. 'effort', 'decSpeed')
 * @param {string} metric           row property to average ('encMs'|'decMs'|'sizeBytes')
 * @returns {number|null}
 */
function avgFor(rows, sizePx, paramVal, paramKey, metric) {
    const matching = rows.filter(r => r.sizePx === sizePx && r[paramKey] === paramVal);
    if (!matching.length) return null;
    return matching.reduce((s, r) => s + r[metric], 0) / matching.length;
}

/**
 * Find the knee-point effort for a given sizePx within phase-1 rows.
 * Returns the effort value, or null if there are no rows.
 */
function kneeEffortFor(rows, sizePx) {
    const effortRows = EFFORTS
        .map(e => {
            const matching = rows.filter(r => r.sizePx === sizePx && r.effort === e);
            if (!matching.length) return null;
            const avgSize = matching.reduce((s, r) => s + r.sizeBytes, 0) / matching.length;
            const avgTime = matching.reduce((s, r) => s + r.encMs,    0) / matching.length;
            return { effort: e, avgSize, avgTime };
        })
        .filter(Boolean);

    if (!effortRows.length) return null;

    for (let i = 1; i < effortRows.length; i++) {
        const sizeReduction = (effortRows[i - 1].avgSize - effortRows[i].avgSize) / effortRows[i - 1].avgSize;
        const timeCost      = (effortRows[i].avgTime - effortRows[i - 1].avgTime) / effortRows[i - 1].avgTime;
        if (timeCost > 3 * sizeReduction) return effortRows[i - 1].effort;
    }
    // No knee — return effort with minimum size
    return effortRows.reduce((best, r) => r.avgSize < best.avgSize ? r : best).effort;
}

/** Inject the four canvas cards into #phase-graphs-body (idempotent). */
function buildGraphsSection() {
    const body = document.getElementById('phase-graphs-body');
    if (!body) return;
    body.innerHTML = `
        <div class="graph-grid">
            <div class="graph-card">
                <h3>Phase 1a — Encode time vs Effort</h3>
                <canvas id="chart-p1a"></canvas>
            </div>
            <div class="graph-card">
                <h3>Phase 1b — File size vs Effort</h3>
                <canvas id="chart-p1b"></canvas>
            </div>
            <div class="graph-card">
                <h3>Phase 2 — Decode time vs Decode speed tier</h3>
                <canvas id="chart-p2"></canvas>
            </div>
            <div class="graph-card">
                <h3>Phase 3 — Modular × Brotli</h3>
                <canvas id="chart-p3"></canvas>
            </div>
        </div>
    `;
}

/** Render (or re-render) Phase 1a and 1b charts from phase-1 sweep rows. */
export function renderPhase1Charts(rows) {
    const sizes = SIZES; // [128, 512, 1920, 'full']

    // --- Phase 1a: Encode ms vs Effort ---
    if (charts.p1a) { charts.p1a.destroy(); charts.p1a = null; }
    const canvas1a = document.getElementById('chart-p1a');
    if (canvas1a) {
        charts.p1a = new Chart(canvas1a, {
            type: 'line',
            data: {
                labels: EFFORTS,
                datasets: sizes.map((sz, i) => ({
                    label: sz === 'full' ? 'Full' : `${sz}px`,
                    data: EFFORTS.map(e => avgFor(rows, sz, e, 'effort', 'encMs')),
                    borderColor: SIZE_COLORS[i],
                    backgroundColor: SIZE_COLORS[i] + '22',
                    tension: 0.3,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                })),
            },
            options: {
                responsive: true,
                plugins: { legend: { position: 'bottom' } },
                scales: {
                    x: { title: { display: true, text: 'Effort' } },
                    y: { title: { display: true, text: 'Encode ms' }, beginAtZero: true },
                },
            },
        });
    }

    // --- Phase 1b: File size (KB) vs Effort, with knee-point scatter ---
    if (charts.p1b) { charts.p1b.destroy(); charts.p1b = null; }
    const canvas1b = document.getElementById('chart-p1b');
    if (canvas1b) {
        const lineDatasets = sizes.map((sz, i) => ({
            label: sz === 'full' ? 'Full' : `${sz}px`,
            data: EFFORTS.map(e => {
                const bytes = avgFor(rows, sz, e, 'effort', 'sizeBytes');
                return bytes !== null ? bytes / 1024 : null;
            }),
            borderColor: SIZE_COLORS[i],
            backgroundColor: SIZE_COLORS[i] + '22',
            tension: 0.3,
            pointRadius: 4,
            pointHoverRadius: 6,
            type: 'line',
        }));

        // One scatter dataset per size to mark the knee effort
        const kneeDatasets = sizes.map((sz, i) => {
            const kneeEffort = kneeEffortFor(rows, sz);
            if (kneeEffort === null) return null;
            const bytes = avgFor(rows, sz, kneeEffort, 'effort', 'sizeBytes');
            const sizeKB = bytes !== null ? bytes / 1024 : null;
            return {
                label: `Knee ${sz === 'full' ? 'Full' : sz + 'px'}`,
                data: sizeKB !== null ? [{ x: kneeEffort, y: sizeKB }] : [],
                type: 'scatter',
                borderColor: SIZE_COLORS[i],
                backgroundColor: SIZE_COLORS[i],
                pointStyle: 'rectRot',
                pointRadius: 8,
                showLine: false,
            };
        }).filter(Boolean);

        charts.p1b = new Chart(canvas1b, {
            type: 'line',
            data: {
                labels: EFFORTS,
                datasets: [...lineDatasets, ...kneeDatasets],
            },
            options: {
                responsive: true,
                plugins: { legend: { position: 'bottom' } },
                scales: {
                    x: { title: { display: true, text: 'Effort' } },
                    y: { title: { display: true, text: 'Size KB' }, beginAtZero: true },
                },
            },
        });
    }
}

/** Render (or re-render) Phase 2 chart from phase-2 sweep rows. */
export function renderPhase2Chart(rows) {
    if (charts.p2) { charts.p2.destroy(); charts.p2 = null; }
    const canvas = document.getElementById('chart-p2');
    if (!canvas) return;

    const sizes = SIZES;
    charts.p2 = new Chart(canvas, {
        type: 'line',
        data: {
            labels: DEC_SPEEDS,
            datasets: sizes.map((sz, i) => ({
                label: sz === 'full' ? 'Full' : `${sz}px`,
                data: DEC_SPEEDS.map(ds => avgFor(rows, sz, ds, 'decSpeed', 'decMs')),
                borderColor: SIZE_COLORS[i],
                backgroundColor: SIZE_COLORS[i] + '22',
                tension: 0.3,
                pointRadius: 4,
                pointHoverRadius: 6,
            })),
        },
        options: {
            responsive: true,
            plugins: { legend: { position: 'bottom' } },
            scales: {
                x: { title: { display: true, text: 'Decode speed tier' } },
                y: { title: { display: true, text: 'Decode ms' }, beginAtZero: true },
            },
        },
    });
}

/** Render (or re-render) Phase 3 chart from phase-3 sweep rows. */
export function renderPhase3Chart(rows) {
    if (charts.p3) { charts.p3.destroy(); charts.p3 = null; }
    const canvas = document.getElementById('chart-p3');
    if (!canvas) return;

    const modularLabels = { '-1': 'Auto', '0': 'VarDCT', '1': 'Modular' };

    // Build combo labels and one dataset per modular mode
    const combos = [];
    for (const modular of MODULAR_VALS) {
        for (const brotli of BROTLI_VALS) {
            combos.push({ modular, brotli, label: `${modularLabels[modular]}/${brotli}` });
        }
    }
    const comboLabels = combos.map(c => c.label);

    const datasets = MODULAR_VALS.map((modular, i) => {
        const data = BROTLI_VALS.map(brotli => {
            const matching = rows.filter(r => r.modular === modular && r.brotli === brotli);
            if (!matching.length) return null;
            return matching.reduce((s, r) => s + r.encMs, 0) / matching.length;
        });
        return {
            label: modularLabels[modular],
            data,
            backgroundColor: SIZE_COLORS[i] + 'aa',
            borderColor: SIZE_COLORS[i],
            borderWidth: 1,
        };
    });

    // X axis labels are brotli values; group by modular using separate datasets
    charts.p3 = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: comboLabels,
            datasets,
        },
        options: {
            responsive: true,
            plugins: { legend: { position: 'bottom' } },
            scales: {
                x: { title: { display: true, text: 'Modular mode / Brotli effort' } },
                y: { title: { display: true, text: 'Encode ms' }, beginAtZero: true },
            },
        },
    });
}

// Build the graph section DOM immediately on module init so canvases exist.
buildGraphsSection();

// =============================================================================
// Results table — Task 8
// =============================================================================

let sortCol = 'score';
let sortDir = 'desc';

const MODULAR_LABELS = { '-1': 'Auto', '0': 'VarDCT', '1': 'Modular' };

const TABLE_COLS = [
    { key: 'file',      label: 'File'    },
    { key: 'sizePx',    label: 'Size'    },
    { key: 'tier',      label: 'Tier'    },
    { key: 'phase',     label: 'Phase'   },
    { key: 'effort',    label: 'Effort'  },
    { key: 'decSpeed',  label: 'DecSpd'  },
    { key: 'modular',   label: 'Modular' },
    { key: 'brotli',    label: 'Brotli'  },
    { key: 'resamp',    label: 'Resamp'  },
    { key: 'encMs',     label: 'Enc ms'  },
    { key: 'decMs',     label: 'Dec ms'  },
    { key: 'sizeBytes', label: 'KB'      },
    { key: 'score',     label: 'Score'   },
];

/** Compute best-row set: for each (file, tier, sizePx) group, the row with the highest score. */
function computeBestRows(rows) {
    const best = new Map();
    for (const r of rows) {
        const k = `${r.file}|${r.tier}|${r.sizePx}`;
        const prev = best.get(k);
        if (!prev || r.score > prev.score) best.set(k, r);
    }
    return new Set(best.values());
}

/** Format a cell value for display. */
function fmtCell(col, row) {
    switch (col.key) {
        case 'sizePx':    return row.sizePx === 'full' ? 'Full' : row.sizePx + 'px';
        case 'sizeBytes': return (row.sizeBytes / 1024).toFixed(1);
        case 'encMs':     return row.encMs.toFixed(1);
        case 'decMs':     return row.decMs.toFixed(1);
        case 'modular':   return MODULAR_LABELS[String(row.modular)] ?? row.modular;
        default:          return row[col.key];
    }
}

/** Inject or update the results table inside #results-table. */
export function buildResultsTable(rows) {
    const section = document.getElementById('results-table');
    if (!section) return;

    // Persist to localStorage whenever called
    try {
        localStorage.setItem(LS_KEY, JSON.stringify({
            timestamp: Date.now(),
            rows,
            presets: null, // presets written separately by saveResults
        }));
    } catch (e) {
        console.warn('[preset-bench] localStorage write failed in buildResultsTable:', e);
    }

    const bestSet = computeBestRows(rows);

    // Sort rows
    const sorted = [...rows].sort((a, b) => {
        const av = a[sortCol];
        const bv = b[sortCol];
        if (av < bv) return sortDir === 'asc' ? -1 : 1;
        if (av > bv) return sortDir === 'asc' ? 1 : -1;
        return 0;
    });

    // Build or reuse table element
    let table = section.querySelector('table.results-table');
    if (!table) {
        table = document.createElement('table');
        table.className = 'results-table';

        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        for (const col of TABLE_COLS) {
            const th = document.createElement('th');
            th.dataset.col = col.key;
            th.textContent = col.label + (col.key === sortCol ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
            th.style.cursor = 'pointer';
            th.addEventListener('click', () => {
                if (sortCol === col.key) {
                    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    sortCol = col.key;
                    sortDir = 'asc';
                }
                buildResultsTable(rows);
            });
            headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);
        table.appendChild(document.createElement('tbody'));
        section.innerHTML = '';
        section.appendChild(table);
    } else {
        // Update header sort indicators
        for (const th of table.querySelectorAll('thead th')) {
            const col = TABLE_COLS.find(c => c.key === th.dataset.col);
            if (!col) continue;
            th.textContent = col.label + (col.key === sortCol ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
        }
    }

    // Rebuild tbody
    const tbody = table.querySelector('tbody');
    tbody.innerHTML = '';
    for (const row of sorted) {
        const tr = document.createElement('tr');
        const isBest = bestSet.has(row);
        if (isBest) tr.classList.add('best-row');

        for (const col of TABLE_COLS) {
            const td = document.createElement('td');
            let text = fmtCell(col, row);
            if (col.key === 'score' && isBest) text = '★ ' + text;
            td.textContent = text;
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
}

// =============================================================================
// Preset derivation — Task 8
// =============================================================================

function mode(arr) {
    if (!arr.length) return undefined;
    const counts = {};
    for (const v of arr) counts[v] = (counts[v] || 0) + 1;
    return Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
}

function avg(arr) {
    if (!arr.length) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
}

export function derivePresets(rows) {
    return TIERS.map(tier => {
        const tierRows = rows.filter(r => r.tier === tier.id);
        if (!tierRows.length) return null;

        const effort = mode(tierRows.filter(r => r.phase === 1).map(r => r.effort));
        const decodingSpeed = mode(tierRows.filter(r => r.phase === 2).map(r => r.decSpeed));
        const p3Best = tierRows
            .filter(r => r.phase === 3)
            .sort((a, b) => b.score - a.score)[0];
        const modular = p3Best?.modular ?? -1;
        const brotliEffort = p3Best?.brotli ?? -1;
        const resampling = mode(tierRows.filter(r => r.phase === 4).map(r => r.resamp));

        const benchStats = {};
        for (const sz of SIZES) {
            const szRows = tierRows.filter(r => r.sizePx === sz);
            if (!szRows.length) continue;
            const key = sz === 'full' ? 'full' : `${sz}px`;
            benchStats[key] = {
                avgEncMs: Math.round(avg(szRows.map(r => r.encMs))),
                avgDecMs: Math.round(avg(szRows.map(r => r.decMs))),
                avgSizeKb: Math.round(avg(szRows.map(r => r.sizeBytes)) / 1024),
            };
        }

        return {
            tier: tier.id,
            quality: tier.quality,
            lossless: tier.lossless,
            effort,
            decodingSpeed,
            modular,
            brotliEffort,
            resampling,
            benchStats,
        };
    }).filter(Boolean);
}

// =============================================================================
// Preset cards UI — Task 8
// =============================================================================

const TIER_COLORS = { low: '#f87171', medium: '#fbbf24', high: '#4ade80', lossless: '#818cf8' };

function buildPresetCard(preset) {
    const color = TIER_COLORS[preset.tier] || '#94a3b8';
    const card = document.createElement('div');
    card.className = 'preset-card';
    card.style.setProperty('--preset-color', color);

    const params = [
        `quality: ${preset.quality}`,
        `lossless: ${preset.lossless}`,
        `effort: ${preset.effort}`,
        `decodingSpeed: ${preset.decodingSpeed}`,
        `modular: ${preset.modular}`,
        `brotliEffort: ${preset.brotliEffort}`,
        `resampling: ${preset.resampling}`,
    ].join('<br>');

    const s128  = preset.benchStats['128px'];
    const s1920 = preset.benchStats['1920px'];
    const timingHtml = [
        s128  ? `128px  enc ${s128.avgEncMs}ms / dec ${s128.avgDecMs}ms`  : '',
        s1920 ? `1920px enc ${s1920.avgEncMs}ms / dec ${s1920.avgDecMs}ms` : '',
    ].filter(Boolean).join('<br>');

    card.innerHTML = `
        <div class="preset-card-title">${preset.tier.toUpperCase()}</div>
        <div class="preset-card-params">${params}</div>
        <div class="preset-card-timing">${timingHtml}</div>
        <button class="copy-json-btn" type="button">Copy JSON</button>
    `;

    card.querySelector('.copy-json-btn').addEventListener('click', () => {
        navigator.clipboard.writeText(JSON.stringify(preset, null, 2));
    });

    return card;
}

export function buildPresetCards(presets) {
    const section = document.getElementById('preset-cards');
    if (!section) return;
    const grid = document.createElement('div');
    grid.className = 'preset-cards-grid';
    for (const preset of presets) {
        grid.appendChild(buildPresetCard(preset));
    }
    section.innerHTML = '';
    section.appendChild(grid);
}

// =============================================================================
// localStorage persistence — Task 8
// =============================================================================

const LS_KEY = 'jxl-preset-bench-results';

export function saveResults(rows, presets) {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify({
            timestamp: Date.now(),
            rows,
            presets,
        }));
    } catch (e) {
        console.warn('Could not save results to localStorage:', e);
    }
}

export function loadSavedResults() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

// =============================================================================
// CSV export — Task 8
// =============================================================================

export function exportCsv(rows) {
    const header = ['file','sizePx','tier','phase','effort','decSpeed','modular','brotli','resamp','encMs','decMs','sizeKB','score'];
    const csvRows = [header.join(',')];
    for (const r of rows) {
        csvRows.push([
            r.file, r.sizePx, r.tier, r.phase, r.effort, r.decSpeed,
            r.modular, r.brotli, r.resamp,
            r.encMs.toFixed(1), r.decMs.toFixed(1),
            (r.sizeBytes / 1024).toFixed(1), r.score,
        ].join(','));
    }
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'preset-benchmark.csv';
    a.click();
    URL.revokeObjectURL(url);
}
