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

// Exported: consumed by Task 6 sweep engine
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
