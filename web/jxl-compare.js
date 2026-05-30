import initRaw, { process_orf, rgb_to_rgba, downscale_rgb } from '../pkg/raw_converter_wasm.js';
import { getContext } from './jxl-browser-context.js';

// ── DOM refs ──────────────────────────────────────────────────────
const runBtn      = document.getElementById('run-btn');
const resetBtn    = document.getElementById('reset-btn');
const statusEl    = document.getElementById('compare-status');
const sourceMetaEl = document.getElementById('source-meta');
const resultsEl   = document.getElementById('compare-results');
const lightbox    = document.getElementById('lightbox');
const lightboxClose = document.getElementById('lightbox-close');
const lightboxTitle = document.getElementById('lightbox-title');
const lightboxTrio  = document.getElementById('lightbox-trio');

// ── state ─────────────────────────────────────────────────────────
let cachedSource   = null;
let runId          = 0;
let activeLightbox = null; // { sizeLabel, results }

// ── quality tier map ──────────────────────────────────────────────
const TIER = {
    high:   { jxlQ: 90, jpegQ: 0.90, webpQ: 0.90 },
    medium: { jxlQ: 80, jpegQ: 0.80, webpQ: 0.80 },
    low:    { jxlQ: 70, jpegQ: 0.70, webpQ: 0.70 },
};

const FORMAT_META = {
    jxl:  { label: 'JXL',  mimeType: 'image/jxl',  badgeClass: 'jxl',  encColor: '#f59e0b', decColor: '#fbbf24' },
    jpeg: { label: 'JPEG', mimeType: 'image/jpeg', badgeClass: 'jpeg', encColor: '#7dd3fc', decColor: '#38bdf8' },
    webp: { label: 'WebP', mimeType: 'image/webp', badgeClass: 'webp', encColor: '#34d399', decColor: '#10b981' },
};

// ── helpers ───────────────────────────────────────────────────────
function fmtMs(ms)    { return ms == null ? '—' : `${ms.toFixed(0)} ms`; }
function fmtBytes(n)  {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const u = ['B','KB','MB','GB']; let v = n, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }

function rgbaToCanvas(rgba, width, height) {
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    c.getContext('2d').putImageData(
        new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height), 0, 0);
    return c;
}

function sizeForLongEdge(width, height, longEdge) {
    if (!longEdge || Math.max(width, height) <= longEdge) return { width, height };
    const long = Math.max(width, height);
    return {
        width:  Math.max(1, Math.round(width  * longEdge / long)),
        height: Math.max(1, Math.round(height * longEdge / long)),
    };
}

function scaledPreviewCanvas(srcCanvas, maxLong = 1200) {
    const long = Math.max(srcCanvas.width, srcCanvas.height);
    if (long <= maxLong) return srcCanvas;
    const scale = maxLong / long;
    const w = Math.round(srcCanvas.width  * scale);
    const h = Math.round(srcCanvas.height * scale);
    const dst = document.createElement('canvas');
    dst.width = w; dst.height = h;
    const ctx = dst.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcCanvas, 0, 0, w, h);
    return dst;
}

// ── source loading ────────────────────────────────────────────────
async function loadRandomSource() {
    setStatus('Fetching random ORF…');
    const resp = await fetch('/api/random-gobabeb', { cache: 'no-store' });
    if (!resp.ok) throw new Error(`random ORF request failed: ${resp.status}`);
    const raw = new Uint8Array(await resp.arrayBuffer());
    const name = resp.headers.get('x-file-name') || 'random.orf';
    await initRaw();
    const result = process_orf(raw, 0,0,0,0,0,0,0,0,0,0, NaN,NaN, 0,0);
    try {
        const rgb  = result.take_rgb();
        const rgba = rgb_to_rgba(rgb);
        return {
            kind: 'orf', raw, rgb, rgba,
            width:  result.width,
            height: result.height,
            label:  `${name} | ${result.width}×${result.height}`,
            meta:   `${resp.headers.get('x-source-folder') || ''} · ${fmtBytes(raw.byteLength)}`,
        };
    } finally { result.free(); }
}

// ── encode helpers ────────────────────────────────────────────────
async function encodeAsJxl(rgba, width, height, quality, effort) {
    const ctx = getContext();
    const t0  = performance.now();
    const session = ctx.encode({
        format: 'rgba8', width, height, hasAlpha: true,
        quality, effort,
        progressive: false, previewFirst: false, chunked: false,
        priority: 'visible',
    });
    const buf = rgba instanceof ArrayBuffer ? rgba : rgba.buffer;
    const parts = [];
    const chunkTask = (async () => {
        for await (const chunk of session.chunks()) {
            parts.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        }
    })();
    await session.pushPixels(buf);
    await session.finish();
    await chunkTask;
    const total = parts.reduce((n, a) => n + a.byteLength, 0);
    const jxl = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { jxl.set(p, off); off += p.byteLength; }
    return { bytes: jxl, encodeMs: performance.now() - t0 };
}

function encodeViaToBlob(rgba, width, height, mimeType, quality) {
    const src = rgbaToCanvas(rgba, width, height);
    return new Promise((resolve, reject) => {
        const t0 = performance.now();
        src.toBlob(async (blob) => {
            if (!blob) return reject(new Error(`toBlob returned null for ${mimeType}`));
            const encodeMs = performance.now() - t0;
            const bytes = new Uint8Array(await blob.arrayBuffer());
            resolve({ bytes, encodeMs });
        }, mimeType, quality);
    });
}

// ── decode helpers ────────────────────────────────────────────────
async function decodeJxl(bytes, priority = 'visible') {
    const ctx     = getContext();
    const t0      = performance.now();
    const session = ctx.decode({ format: 'rgba8', priority });
    const buf     = bytes instanceof ArrayBuffer
        ? bytes
        : (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer
            : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    await session.push(buf);
    await session.close();
    let lastFrame = null;
    for await (const ev of session.frames()) {
        if (ev.stage === 'final') { lastFrame = ev; break; }
    }
    if (!lastFrame) throw new Error('JXL decode produced no frame');
    const rgba = lastFrame.pixels instanceof Uint8Array ? lastFrame.pixels : new Uint8Array(lastFrame.pixels);
    const canvas = rgbaToCanvas(rgba, lastFrame.info.width, lastFrame.info.height);
    return { canvas, decodeMs: performance.now() - t0 };
}

async function decodeNative(bytes, mimeType) {
    const blob = new Blob([bytes], { type: mimeType });
    const t0   = performance.now();
    const bmp  = await createImageBitmap(blob);
    const decodeMs = performance.now() - t0;
    const canvas   = document.createElement('canvas');
    canvas.width   = bmp.width;
    canvas.height  = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    return { canvas, decodeMs };
}

// ── race per size ─────────────────────────────────────────────────
async function runFormatRaceAtSize(source, longEdge, tier, effort, thisRunId) {
    const dims = longEdge === 'full'
        ? { width: source.width, height: source.height }
        : sizeForLongEdge(source.width, source.height, Number(longEdge));

    // Prepare RGBA at target size
    let rgba;
    if (dims.width === source.width && dims.height === source.height) {
        rgba = source.rgba.slice();
    } else {
        const downRgb = downscale_rgb(source.rgb, source.width, source.height, dims.width, dims.height);
        rgba = rgb_to_rgba(downRgb);
    }

    const { jxlQ, jpegQ, webpQ } = TIER[tier];
    const results = {};

    // JXL
    setStatus(`Encoding JXL at ${longEdge === 'full' ? 'full' : longEdge + 'px'}…`);
    const jxlEnc = await encodeAsJxl(new Uint8Array(rgba.buffer.slice(0)), dims.width, dims.height, jxlQ, effort);
    if (thisRunId !== runId) return null;
    const jxlDec = await decodeJxl(jxlEnc.bytes);
    if (thisRunId !== runId) return null;
    results.jxl = { ...jxlEnc, ...jxlDec, totalMs: jxlEnc.encodeMs + jxlDec.decodeMs };

    // JPEG
    setStatus(`Encoding JPEG at ${longEdge === 'full' ? 'full' : longEdge + 'px'}…`);
    const jpegEnc = await encodeViaToBlob(rgba, dims.width, dims.height, 'image/jpeg', jpegQ);
    if (thisRunId !== runId) return null;
    const jpegDec = await decodeNative(jpegEnc.bytes, 'image/jpeg');
    if (thisRunId !== runId) return null;
    results.jpeg = { ...jpegEnc, ...jpegDec, totalMs: jpegEnc.encodeMs + jpegDec.decodeMs };

    // WebP
    setStatus(`Encoding WebP at ${longEdge === 'full' ? 'full' : longEdge + 'px'}…`);
    const webpEnc = await encodeViaToBlob(rgba, dims.width, dims.height, 'image/webp', webpQ);
    if (thisRunId !== runId) return null;
    const webpDec = await decodeNative(webpEnc.bytes, 'image/webp');
    if (thisRunId !== runId) return null;
    results.webp = { ...webpEnc, ...webpDec, totalMs: webpEnc.encodeMs + webpDec.decodeMs };

    return { longEdge, dims, results };
}

// ── read controls ─────────────────────────────────────────────────
function getTier()   { return document.querySelector('[name=quality-tier]:checked')?.value || 'high'; }
function getEffort() { return Number(document.querySelector('[name=effort]:checked')?.value || 3); }
function getSizes()  {
    return [...document.querySelectorAll('.size-check:checked')].map((el) => el.value);
}

// ── main race ─────────────────────────────────────────────────────
async function runRace() {
    runBtn.disabled = true;
    runId++;
    const thisRunId = runId;
    resultsEl.innerHTML = '<div class="compare-empty">Running…</div>';

    try {
        if (!cachedSource) {
            cachedSource = await loadRandomSource();
        }
        if (thisRunId !== runId) return;
        if (sourceMetaEl) sourceMetaEl.textContent = cachedSource.label;

        const tier   = getTier();
        const effort = getEffort();
        const sizes  = getSizes();
        if (!sizes.length) { setStatus('Select at least one size.'); return; }

        const allRows = [];
        for (const size of sizes) {
            if (thisRunId !== runId) return;
            const row = await runFormatRaceAtSize(cachedSource, size, tier, effort, thisRunId);
            if (!row) return;
            allRows.push(row);
        }

        if (thisRunId !== runId) return;
        renderResults(allRows, tier, effort);
        setStatus(`Done — ${allRows.length} size${allRows.length > 1 ? 's' : ''} compared at ${tier} quality.`);
    } catch (err) {
        if (thisRunId !== runId) return;
        setStatus(`Failed: ${err?.message || err}`);
        resultsEl.innerHTML = `<div class="compare-empty" style="color:#f87171">Error: ${err?.message || err}</div>`;
    } finally {
        if (thisRunId === runId) runBtn.disabled = false;
    }
}

// ── rendering ─────────────────────────────────────────────────────
function renderResults(rows, tier, effort) {
    resultsEl.innerHTML = '';

    for (const row of rows) {
        const { longEdge, dims, results } = row;
        const sizeLabel = longEdge === 'full' ? 'Full size' : `${longEdge} long`;
        const dimsStr   = `${dims.width}×${dims.height}`;

        // Winner analysis
        const formats = ['jxl', 'jpeg', 'webp'];
        const smallestSize = Math.min(...formats.map((f) => results[f].bytes.byteLength));
        const fastestEnc   = Math.min(...formats.map((f) => results[f].encodeMs));
        const fastestDec   = Math.min(...formats.map((f) => results[f].decodeMs));

        const maxEnc  = Math.max(...formats.map((f) => results[f].encodeMs), 1);
        const maxDec  = Math.max(...formats.map((f) => results[f].decodeMs), 1);
        const maxSize = Math.max(...formats.map((f) => results[f].bytes.byteLength), 1);

        const sizeRowEl = document.createElement('div');
        sizeRowEl.className = 'size-row';

        const headerEl = document.createElement('div');
        headerEl.className = 'size-row-header';
        headerEl.innerHTML = `
            <div class="size-row-title">
                <span class="slot-label">Size</span>
                <h3>${sizeLabel}</h3>
                <span class="size-row-dims">${dimsStr}</span>
            </div>
            <button class="lightbox-open-btn" type="button">View quality ▶</button>
        `;
        headerEl.querySelector('.lightbox-open-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            openLightbox(sizeLabel, dimsStr, results, tier, effort);
        });
        headerEl.addEventListener('click', () => openLightbox(sizeLabel, dimsStr, results, tier, effort));

        const colsEl = document.createElement('div');
        colsEl.className = 'format-cols';

        for (const fmt of formats) {
            const r    = results[fmt];
            const meta = FORMAT_META[fmt];
            const isSmallest   = r.bytes.byteLength === smallestSize;
            const isFastestEnc = Math.abs(r.encodeMs - fastestEnc) < 1;
            const isFastestDec = Math.abs(r.decodeMs - fastestDec) < 1;

            const encPct  = (r.encodeMs / maxEnc * 100).toFixed(1);
            const decPct  = (r.decodeMs / maxDec * 100).toFixed(1);
            const sizePct = (r.bytes.byteLength / maxSize * 100).toFixed(1);

            const cell = document.createElement('div');
            cell.className = 'format-cell';

            // Small thumbnail-style preview
            const previewCanvas = document.createElement('canvas');
            previewCanvas.className = 'format-preview';
            const displayCanvas = scaledPreviewCanvas(r.canvas, 600);
            previewCanvas.width  = displayCanvas.width;
            previewCanvas.height = displayCanvas.height;
            previewCanvas.getContext('2d').drawImage(displayCanvas, 0, 0);

            cell.innerHTML = `
                <div class="format-cell-head">
                    <span class="format-badge ${meta.badgeClass}">${meta.label}</span>
                    <span class="format-cell-state">${dims.width}×${dims.height}</span>
                </div>
            `;
            cell.appendChild(previewCanvas);
            cell.insertAdjacentHTML('beforeend', `
                <div class="format-bars">
                    <div class="format-bar-row">
                        <span class="format-bar-label">enc</span>
                        <div class="format-bar-track">
                            <div class="format-bar-fill" style="--w:${encPct}%;--bar-color:${meta.encColor}">
                                <span class="format-bar-fill-label">${r.encodeMs.toFixed(0)}</span>
                            </div>
                        </div>
                        <span class="format-bar-ms">${fmtMs(r.encodeMs)}</span>
                    </div>
                    <div class="format-bar-row">
                        <span class="format-bar-label">dec</span>
                        <div class="format-bar-track">
                            <div class="format-bar-fill" style="--w:${decPct}%;--bar-color:${meta.decColor}">
                                <span class="format-bar-fill-label">${r.decodeMs.toFixed(0)}</span>
                            </div>
                        </div>
                        <span class="format-bar-ms">${fmtMs(r.decodeMs)}</span>
                    </div>
                    <div class="format-bar-row">
                        <span class="format-bar-label">size</span>
                        <div class="format-bar-track">
                            <div class="format-bar-fill" style="--w:${sizePct}%;--bar-color:#a78bfa">
                                <span class="format-bar-fill-label">${fmtBytes(r.bytes.byteLength)}</span>
                            </div>
                        </div>
                        <span class="format-bar-ms">${fmtBytes(r.bytes.byteLength)}</span>
                    </div>
                </div>
                <div class="format-stats">
                    <div class="format-stat">
                        <span class="format-stat-label">total</span>
                        <span class="format-stat-val">${fmtMs(r.totalMs)}</span>
                    </div>
                    <div class="format-stat">
                        <span class="format-stat-label">enc</span>
                        <span class="format-stat-val ${isFastestEnc ? 'is-best' : ''}">${fmtMs(r.encodeMs)}</span>
                    </div>
                    <div class="format-stat">
                        <span class="format-stat-label">dec</span>
                        <span class="format-stat-val ${isFastestDec ? 'is-best' : ''}">${fmtMs(r.decodeMs)}</span>
                    </div>
                    <div class="format-stat">
                        <span class="format-stat-label">size</span>
                        <span class="format-stat-val ${isSmallest ? 'is-best' : ''}">${fmtBytes(r.bytes.byteLength)}</span>
                    </div>
                    ${isSmallest   ? '<span class="format-winner-chip smallest">✓ smallest</span>'      : ''}
                    ${isFastestEnc ? '<span class="format-winner-chip fastest-enc">✓ fastest enc</span>' : ''}
                    ${isFastestDec ? '<span class="format-winner-chip fastest-dec">✓ fastest dec</span>' : ''}
                </div>
            `);
            colsEl.appendChild(cell);
        }

        sizeRowEl.appendChild(headerEl);
        sizeRowEl.appendChild(colsEl);
        resultsEl.appendChild(sizeRowEl);
    }
}

// ── lightbox ──────────────────────────────────────────────────────
function openLightbox(sizeLabel, dimsStr, results, tier, effort) {
    lightboxTitle.textContent = `${sizeLabel} · ${dimsStr} · ${tier} quality`;
    lightboxTrio.innerHTML = '';

    const formats = ['jxl', 'jpeg', 'webp'];
    const { jxlQ, jpegQ, webpQ } = TIER[tier];
    const qualMap = { jxl: `q=${jxlQ} effort=${effort}`, jpeg: `q=${Math.round(jpegQ * 100)}`, webp: `q=${Math.round(webpQ * 100)}` };

    for (const fmt of formats) {
        const r    = results[fmt];
        const meta = FORMAT_META[fmt];

        const col  = document.createElement('div');
        col.className = 'lightbox-col';

        const displayCanvas = scaledPreviewCanvas(r.canvas, 1200);

        col.innerHTML = `
            <div class="lightbox-col-head">
                <span class="format-badge ${meta.badgeClass}">${meta.label}</span>
                <span style="font-size:10px;color:var(--muted);font-family:monospace">${qualMap[fmt]}</span>
            </div>
            <div class="lightbox-col-stats">
                <span class="lightbox-col-stat"><span class="k">enc </span><span class="v">${fmtMs(r.encodeMs)}</span></span>
                <span class="lightbox-col-stat"><span class="k">dec </span><span class="v">${fmtMs(r.decodeMs)}</span></span>
                <span class="lightbox-col-stat"><span class="k">size </span><span class="v">${fmtBytes(r.bytes.byteLength)}</span></span>
                <span class="lightbox-col-stat"><span class="k">total </span><span class="v">${fmtMs(r.totalMs)}</span></span>
            </div>
            <div class="lightbox-canvas-wrap"></div>
        `;
        const wrap = col.querySelector('.lightbox-canvas-wrap');
        displayCanvas.className = 'lightbox-canvas';
        wrap.appendChild(displayCanvas);
        lightboxTrio.appendChild(col);
    }

    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
}

function closeLightbox() {
    lightbox.hidden = true;
    document.body.style.overflow = '';
}

// ── wiring ────────────────────────────────────────────────────────
runBtn.addEventListener('click', () => runRace());

resetBtn.addEventListener('click', () => {
    cachedSource = null;
    runId++;
    resultsEl.innerHTML = '<div class="compare-empty">Run the race to see results here.</div>';
    if (sourceMetaEl) sourceMetaEl.textContent = '';
    setStatus('Source cleared — click "Load & run race".');
    runBtn.disabled = false;
});

lightboxClose.addEventListener('click', closeLightbox);
lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
