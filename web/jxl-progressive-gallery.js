// web/jxl-progressive-gallery.js
// Progressive JXL gallery — local file picker, direct DecodeSession decode.
// Works entirely with local .jxl files; no HTTP server required.
// Feed each file in chunks with emitEveryPass=true to show dc → pass → full.

import { createBrowserContext } from '../packages/jxl-session/dist/index.js';
import { createEncoder } from '@casabio/jxl-wasm';
import { initDebugConsole, dbgLog } from './jxl-debug-console.js';
import { createGalleryCoordinator } from './jxl-progressive-gallery-coordinator.js';
import { createGalleryLightbox } from './jxl-progressive-gallery-lightbox.js';

// Console page header — always shows which page this console belongs to (dev productivity across many open lab/benchmark tabs)
console.log('%c[Progressive Gallery] jxl-progressive-gallery.js loaded — multi-frame progressive gallery + lightbox', 'color:#06b6d4;font-weight:600', { page: 'Progressive Gallery', url: location.href, t: new Date().toISOString(), ua: navigator.userAgent.slice(0, 120) });

// ── DOM refs ──────────────────────────────────────────────────────────────────

const sourceInput   = document.getElementById('source-input');
const pickerStatus  = document.getElementById('picker-status');
const concurrentEl  = document.getElementById('concurrent');
const concurrentVal = document.getElementById('concurrent-val');
const galleryRowsEl  = document.querySelector('[data-gallery-rows]');
const lightboxRoot   = document.querySelector('[data-lightbox-root]');
const logEl         = document.getElementById('log');
const dbgConsoleBtn = document.getElementById('dbg-console-btn');
const pushModeButtons = [...document.querySelectorAll('[data-push-mode]')];

// ── State ─────────────────────────────────────────────────────────────────────

let ctx = null;
let pushMode = 'all-chunks';
let activeKeyHandler = null;  // cleaned up on each startGallery() call

const CHUNK_SIZE = 65536; // 64 KiB per chunk
// Keep this comfortably above the scheduler drain HWM so the worker can
// actually consume enough bytes to emit drain on large codestreams.
const WINDOW_SIZE = 32;

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  try {
    ctx = createBrowserContext();
    log('JXL context ready');
    dbgLog('JXL context ready');
  } catch (e) {
    log(`Init error: ${e.message}`, 'error');
    dbgLog('Init error', e.message, 'error');
  }
})();

if (dbgConsoleBtn) initDebugConsole(dbgConsoleBtn);
wirePushModeControls();

// ── Controls ──────────────────────────────────────────────────────────────────

concurrentEl.addEventListener('input', () => {
  concurrentVal.textContent = concurrentEl.value;
});

function getGalleryProgressiveDetail() {
  const sel = document.getElementById('gallery-prog-detail');
  // Default to 'passes' so that when testing multi-layer encodes (Dc=2 + groupOrder from paint/gallery onfly)
  // the benchmark actually shows the earlier + more passes the user asked for.
  return sel ? sel.value : 'passes';
}

function getGalleryEncodeOptions() {
  return {
    previewFirst: !!(document.getElementById('gallery-preview-first')?.checked),
    progressiveDc: Number(document.getElementById('gallery-prog-dc')?.value ?? 2),
    groupOrder: document.getElementById('gallery-group-order')?.checked ? 1 : 0,
  };
}

sourceInput.addEventListener('change', () => {
  const allFiles = [...sourceInput.files];
  const jxlFiles = allFiles.filter(f => /\.jxl$/i.test(f.name));
  const rawFiles = allFiles.filter(f => /\.(png|jpe?g|webp)$/i.test(f.name));

  const filesToUse = jxlFiles.length > 0 ? jxlFiles : rawFiles;

  if (filesToUse.length === 0) {
    pickerStatus.textContent = 'Pick .jxl files (or PNG/JPG for on-the-fly encode demo)';
    return;
  }

  pickerStatus.textContent = `${filesToUse.length} file${filesToUse.length > 1 ? 's' : ''} selected${rawFiles.length > 0 && jxlFiles.length === 0 ? ' (will encode with new options)' : ''}`;
  galleryRowsEl.innerHTML = '';

  log(`Starting round-robin gallery for ${filesToUse.length} file${filesToUse.length > 1 ? 's' : ''}`);
  dbgLog('Gallery start', `${filesToUse.length} files`, 'info');
  startGallery(filesToUse, { encodeOnTheFly: rawFiles.length > 0 && jxlFiles.length === 0 }).catch(e => log(`Gallery error: ${e.message}`, 'error'));
});

// Predator push support: if paint page "pushed" a JXL via localStorage (or ?autopush), auto-ingest it as a .jxl
// so you can immediately see multi-layer progressive decode without manual pick. Clears after use.
function consumePendingProgressivePush() {
  try {
    const raw = localStorage.getItem('__progGalleryPush');
    if (!raw) return null;
    const { name, b64, ts } = JSON.parse(raw);
    if (!b64 || Date.now() - (ts || 0) > 5 * 60 * 1000) { localStorage.removeItem('__progGalleryPush'); return null; }
    // decode base64 to Uint8Array
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    localStorage.removeItem('__progGalleryPush');
    return { filename: name || 'pushed-from-paint.jxl', bytes };
  } catch (e) {
    console.warn('[gallery] consume push failed', e);
    localStorage.removeItem('__progGalleryPush');
    return null;
  }
}

(function autoIngestPushIfPresent() {
  const urlHasAuto = /[?&]autopush=1/.test(location.search);
  const pending = consumePendingProgressivePush();
  if (pending) {
    pickerStatus.textContent = `Auto-pushed from progressive-paint: ${pending.filename} (testing multi-layer progressive)`;
    // Feed it directly as if picked (as JXL)
    setTimeout(() => {
      galleryRowsEl.innerHTML = '';
      log(`Auto-ingesting pushed progressive JXL: ${pending.filename}`);
      startGallery([new File([pending.bytes], pending.filename, { type: 'image/jxl' })], { encodeOnTheFly: false })
        .catch(e => log(`Auto-push gallery error: ${e.message}`, 'error'));
    }, 50);
  } else if (urlHasAuto) {
    pickerStatus.textContent = 'Opened for autopush — generate in paint page and click its "Export to progressive gallery" to push a test file here.';
  }
})();

function wirePushModeControls() {
  for (const button of pushModeButtons) {
    button.addEventListener('click', () => {
      const next = button.dataset.pushMode;
      if (!next || next === pushMode) return;
      pushMode = next;
      syncPushModeButtons();
      dbgLog('Push mode', next, 'info');
    });
  }
  syncPushModeButtons();
}

function syncPushModeButtons() {
  for (const button of pushModeButtons) {
    const active = button.dataset.pushMode === pushMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

// ── Slot management ───────────────────────────────────────────────────────────

function slotId(file) {
  return `slot-${file.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

// ── Gallery pipeline (round-robin reveal + lightbox) ──────────────────────────

async function startGallery(selectedFiles, { encodeOnTheFly = false } = {}) {
  if (!ctx) {
    log('Context not ready', 'warn');
    return;
  }

  const encodeOpts = encodeOnTheFly ? getGalleryEncodeOptions() : null;

  // Remove any previous keyboard handler from prior gallery load
  if (activeKeyHandler) {
    document.removeEventListener('keydown', activeKeyHandler);
    activeKeyHandler = null;
  }

  // Build per-file row elements
  const stripEls = new Map(); // fileId → <div class="thumb-strip">
  for (const file of selectedFiles) {
    const fileId = slotId(file);
    const rowEl = document.createElement('div');
    rowEl.className = 'gallery-row';
    rowEl.dataset.fileId = fileId;

    const labelEl = document.createElement('div');
    labelEl.className = 'gallery-row-label';
    labelEl.textContent = file.name;

    const stripEl = document.createElement('div');
    stripEl.className = 'thumb-strip';

    rowEl.append(labelEl, stripEl);
    galleryRowsEl.appendChild(rowEl);
    stripEls.set(fileId, stripEl);
  }

  // round-robin coordinator controls when each frame becomes visible
  const coordinator = createGalleryCoordinator({
    files: selectedFiles.map(file => ({
      fileId: slotId(file),
      name: file.name,
      byteLength: file.size,
    })),
  });

  // framesByFile is a live Map used by the lightbox
  const framesByFile = new Map(selectedFiles.map(f => [slotId(f), []]));

  const lightbox = createGalleryLightbox({ framesByFile });

  // Keyboard handler for lightbox navigation
  function onKey(ev) {
    if (!lightboxRoot || lightboxRoot.hidden) return;  // lightbox not visible
    const cur = lightbox.current();
    if (!cur) return;
    if (ev.key === 'Escape') {
      closeLightbox();
      return;
    }
    lightbox.handleKey(ev);
    const next = lightbox.current();
    if (next) renderLightboxState(next);
  }
  activeKeyHandler = onKey;
  document.addEventListener('keydown', onKey);

  // Re-render all file strips based on current coordinator visibility
  function reRenderAll() {
    for (const [fileId, stripEl] of stripEls) {
      const visible = coordinator.visibleFrames(fileId);
      syncStrip(stripEl, fileId, visible);
    }
  }

  function syncStrip(stripEl, fileId, frames) {
    const existing = new Map(
      [...stripEl.querySelectorAll('.thumb-cell')].map(el => [+el.dataset.frameIndex, el])
    );
    for (const frame of frames) {
      if (existing.has(frame.frameIndex)) {
        updateThumbCell(existing.get(frame.frameIndex), frame);
      } else {
        const cell = createThumbCell(fileId, frame);
        stripEl.appendChild(cell);
      }
    }
  }

  function createThumbCell(fileId, frame) {
    const cell = document.createElement('div');
    cell.className = 'thumb-cell';
    cell.dataset.fileId = fileId;
    cell.dataset.frameIndex = frame.frameIndex;
    cell.setAttribute('tabindex', '0');
    cell.setAttribute('role', 'button');
    cell.setAttribute('aria-label', `Open ${frame.stage} frame in lightbox`);

    const canvas = document.createElement('canvas');
    drawFrameToCanvas(canvas, frame);

    const metaEl = document.createElement('div');
    metaEl.className = 'thumb-meta';
    metaEl.textContent = formatFrameMeta(frame);

    cell.append(canvas, metaEl);

    const open = () => {
      lightbox.open(fileId, frame.frameIndex);
      renderLightboxState({ fileId, frameIndex: frame.frameIndex });
    };
    cell.addEventListener('click', open);
    cell.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        open();
      }
    });

    return cell;
  }

  function updateThumbCell(cell, frame) {
    const canvas = cell.querySelector('canvas');
    if (canvas) drawFrameToCanvas(canvas, frame);
    const metaEl = cell.querySelector('.thumb-meta');
    if (metaEl) metaEl.textContent = formatFrameMeta(frame);
  }

  function formatFrameMeta(frame) {
    const pct = typeof frame.percentFed === 'number' ? frame.percentFed.toFixed(1) : '?';
    const bytes = typeof frame.bytesFed === 'number' ? frame.bytesFed.toLocaleString() : '?';
    const total = typeof frame.totalBytes === 'number' ? frame.totalBytes.toLocaleString() : '?';
    const ms = typeof frame.elapsedMs === 'number' ? frame.elapsedMs.toFixed(1) : '?';
    return `${frame.stage} · ${ms} ms · ${bytes} / ${total} bytes · ${pct}%`;
  }

  function renderLightboxState({ fileId, frameIndex }) {
    const frames = framesByFile.get(fileId) ?? [];
    const frame = frames[frameIndex];
    if (!frame) return;

    const canvas = document.getElementById('lightbox-canvas');
    if (canvas) drawFrameToCanvas(canvas, frame);

    const metaEl = document.getElementById('lightbox-meta');
    if (metaEl) metaEl.textContent = `${fileId.replace(/^slot-/, '')} — frame ${frameIndex} — ${formatFrameMeta(frame)}`;

    openLightboxOverlay();
  }

  function openLightboxOverlay() {
    if (!lightboxRoot) return;
    lightboxRoot.hidden = false;
    lightboxRoot.classList.add('is-open');
    if (lightboxRoot.requestFullscreen) {
      lightboxRoot.requestFullscreen().catch(() => {/* overlay fallback already works */});
    }
  }

  function closeLightbox() {
    if (!lightboxRoot) return;
    lightboxRoot.hidden = true;
    lightboxRoot.classList.remove('is-open');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  async function loadImageToRgba(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx2d = c.getContext('2d');
      ctx2d.drawImage(img, 0, 0);
      const data = ctx2d.getImageData(0, 0, c.width, c.height);
      return { rgba: new Uint8Array(data.data.buffer), width: c.width, height: c.height };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function encodeToProgressiveJxl(rgbaData, encodeOptions) {
    const { width, height, rgba } = rgbaData;
    const enc = createEncoder({
      format: 'rgba8',
      width,
      height,
      hasAlpha: true,
      quality: 82,
      effort: 4,
      progressive: true,
      previewFirst: encodeOptions.previewFirst,
      progressiveDc: encodeOptions.progressiveDc,
      groupOrder: encodeOptions.groupOrder,
      chunked: false,
    });

    const chunks = [];
    const pushTask = (async () => {
      for await (const ch of enc.chunks()) {
        chunks.push(ch instanceof Uint8Array ? ch : new Uint8Array(ch));
      }
    })();

    await enc.pushPixels(rgba);
    await enc.finish();
    await pushTask;
    await enc.dispose();

    // Concatenate
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  }

  // Decode all files concurrently, register frames with coordinator
  const filePromises = selectedFiles.map(async file => {
    const fileId = slotId(file);
    const startMs = Date.now();

    let buffer;
    try {
      if (encodeOnTheFly) {
        log(`${file.name}: encoding on the fly with progressiveDc=${encodeOpts.progressiveDc}, groupOrder=${encodeOpts.groupOrder}, previewFirst=${encodeOpts.previewFirst}...`);
        const raw = await loadImageToRgba(file);
        buffer = await encodeToProgressiveJxl(raw, encodeOpts);
        log(`${file.name}: encoded to ${(buffer.byteLength / 1024).toFixed(1)} KB progressive JXL`);
      } else {
        buffer = await file.arrayBuffer();
      }
    } catch (e) {
      log(`${file.name}: ${encodeOnTheFly ? 'encode' : 'read'} error — ${e.message}`, 'error');
      return;
    }

    dbgLog('Decoding', `${file.name} · ${buffer.byteLength} bytes · mode=${pushMode}`, 'info');

    const chosenDetail = getGalleryProgressiveDetail();
    const session = ctx.decode({
      format: 'rgba8',
      progressionTarget: 'final',
      emitEveryPass: true,
      progressiveDetail: chosenDetail === 'auto' ? null : chosenDetail,
    });

    // Push chunks — all at once (round-robin reveal works because coordinator
    // gates visibility, not because push is serialised per file)
    const pushes = [];
    for (let offset = 0; offset < buffer.byteLength; offset += CHUNK_SIZE) {
      const end = Math.min(offset + CHUNK_SIZE, buffer.byteLength);
      pushes.push(session.push(buffer.slice(offset, end)));
    }
    const pushPromise = Promise.all(pushes).then(() => session.close());

    let frameIndex = 0;
    const framesPromise = (async () => {
      for await (const frame of session.frames()) {
        const elapsedMs = Date.now() - startMs;
        const bytesFed = buffer.byteLength; // all bytes fed upfront in all-chunks mode
        const percentFed = 100;

        let stage = frame.stage;
        if (frame.type === 'preview' || stage === 'preview') {
          stage = 'preview';
        }

        const enriched = {
          ...frame,
          frameIndex: frameIndex++,
          elapsedMs,
          bytesFed,
          percentFed,
          totalBytes: buffer.byteLength,
          stage,
        };
        framesByFile.get(fileId).push(enriched);
        coordinator.registerFrame(fileId, enriched);
        reRenderAll();
        dbgLog('Frame', `${file.name} · ${stage || frame.stage}`, 'info');
      }
      coordinator.markFileClosed(fileId);
      reRenderAll();
      log(`${file.name}: done (${frameIndex} frame${frameIndex !== 1 ? 's' : ''})`);
      dbgLog('Decode done', `${file.name} · ${frameIndex} frames`, 'success');
    })();

    try {
      await Promise.all([pushPromise, framesPromise]);
    } catch (e) {
      log(`${file.name}: ${e.message}`, 'error');
      dbgLog('Decode error', `${file.name}\n${e.stack ?? e.message}`, 'error');
    }
  });

  await Promise.all(filePromises);
}

function drawFrameToCanvas(canvas, frame) {
  const { width, height } = frame.info;
  canvas.width = width;
  canvas.height = height;
  const ctx2d = canvas.getContext('2d');
  const imageData = typeof frame.getImageData === 'function'
    ? frame.getImageData()
    : new ImageData(
        new Uint8ClampedArray(frame.pixels instanceof ArrayBuffer ? frame.pixels : frame.pixels.buffer),
        width,
        height,
      );
  ctx2d.putImageData(imageData, 0, 0);
}

// ── Log ───────────────────────────────────────────────────────────────────────

function log(msg, level = 'info') {
  const line = document.createElement('div');
  const ts = new Date().toISOString().slice(11, 23);
  line.textContent = `${ts} ${msg}`;
  if (level === 'error') line.style.color = '#f66';
  if (level === 'warn')  line.style.color = '#fa0';
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}
