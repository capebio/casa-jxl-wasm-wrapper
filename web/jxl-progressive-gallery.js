// web/jxl-progressive-gallery.js
// Progressive JXL gallery — local file picker, direct DecodeSession decode.
// Works entirely with local .jxl files; no HTTP server required.
// Feed each file in chunks with emitEveryPass=true to show dc → pass → full.

import { createBrowserContext } from '../packages/jxl-session/dist/index.js';
import { initDebugConsole, dbgLog } from './jxl-debug-console.js';
import { createGalleryCoordinator } from './jxl-progressive-gallery-coordinator.js';
import { createGalleryLightbox } from './jxl-progressive-gallery-lightbox.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────

const sourceInput   = document.getElementById('source-input');
const pickerStatus  = document.getElementById('picker-status');
const concurrentEl  = document.getElementById('concurrent');
const concurrentVal = document.getElementById('concurrent-val');
const galleryEl     = document.getElementById('gallery'); // TODO(Task4): remove — replaced by galleryRowsEl
const galleryRowsEl  = document.querySelector('[data-gallery-rows]');
const lightboxRoot   = document.querySelector('[data-lightbox-root]');
const logEl         = document.getElementById('log');
const dbgConsoleBtn = document.getElementById('dbg-console-btn');
const pushModeButtons = [...document.querySelectorAll('[data-push-mode]')];

// ── State ─────────────────────────────────────────────────────────────────────

let ctx = null;
let activeDecoders = 0;
const queue = []; // Array<File>
let pushMode = 'all-chunks';

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
  drain();
});

sourceInput.addEventListener('change', () => {
  const files = [...sourceInput.files].filter(f => /\.jxl$/i.test(f.name));

  if (files.length === 0) {
    pickerStatus.textContent = 'No JXL files in selection';
    return;
  }

  pickerStatus.textContent = `${files.length} JXL file${files.length > 1 ? 's' : ''} selected`;
  galleryRowsEl.innerHTML = '';
  queue.length = 0;

  log(`Starting round-robin gallery for ${files.length} file${files.length > 1 ? 's' : ''}`);
  dbgLog('Gallery start', `${files.length} files`, 'info');
  startGallery(files).catch(e => log(`Gallery error: ${e.message}`, 'error'));
});

// ── Queue drain ───────────────────────────────────────────────────────────────

function drain() {
  const max = parseInt(concurrentEl.value, 10);
  while (queue.length > 0 && activeDecoders < max) {
    const file = queue.shift();
    activeDecoders++;
    dbgLog('Decode start', file.name, 'info');
    decodeFile(file).finally(() => {
      activeDecoders--;
      drain();
    });
  }
}

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

function createSlot(file) {
  const slotEl = document.createElement('div');
  slotEl.className = 'slot';
  slotEl.id = slotId(file);

  const canvas = document.createElement('canvas');

  const badge  = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = 'queued';

  const spinner = document.createElement('div');
  spinner.className = 'spinner';
  spinner.textContent = '⏳';

  const filename = document.createElement('div');
  filename.className = 'filename';
  filename.textContent = file.name;

  slotEl.append(canvas, badge, spinner, filename);
  if (galleryEl) galleryEl.appendChild(slotEl);

  return slotEl;
}

function getSlot(file) {
  return document.getElementById(slotId(file));
}

function setBadge(slotEl, tier, label) {
  const badge = slotEl.querySelector('.badge');
  badge.className = `badge tier-${tier}`;
  badge.textContent = label ?? tier;
}

function hideSpinner(slotEl) {
  const spinner = slotEl.querySelector('.spinner');
  if (spinner) spinner.style.display = 'none';
}

function renderFrameToSlot(slotEl, frame) {
  hideSpinner(slotEl);

  const canvas = slotEl.querySelector('canvas');
  const { width, height } = frame.info;

  canvas.width  = width;
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

function renderCell(fileId, frame) {
  return {
    fileId,
    frameIndex: frame.frameIndex ?? 0,
    stage: frame.stage,
    elapsedMs: frame.elapsedMs ?? 0,
    bytesFed: frame.bytesFed ?? 0,
    percentFed: frame.percentFed ?? 0,
    info: frame.info,
    pixels: frame.pixels,
  };
}

// ── Decode pipeline ───────────────────────────────────────────────────────────

async function decodeFile(file) {
  if (!ctx) {
    log(`Skip ${file.name}: context not ready`, 'warn');
    return;
  }

  const slotEl = getSlot(file);
  if (!slotEl) return;

  setBadge(slotEl, 'wait', 'reading…');
  dbgLog('Reading file', file.name, 'info');

  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (e) {
    setBadge(slotEl, 'error', 'read err');
    log(`${file.name}: read error — ${e.message}`, 'error');
    dbgLog('Read error', `${file.name}\n${e.stack ?? e.message}`, 'error');
    return;
  }

  setBadge(slotEl, 'wait', 'decoding…');
  dbgLog('Decoding', `${file.name} · ${buffer.byteLength} bytes · mode=${pushMode}`, 'info');

  const session = ctx.decode({
    format: 'rgba8',
    progressionTarget: 'final',
    emitEveryPass: true,
  });

  let frameCount = 0;

  // Push bytes and collect frames concurrently (mirrors profileJxl pattern).
  const pushTask = (async () => {
    if (pushMode === 'full-file') {
      dbgLog('Push whole file', `${file.name} · ${buffer.byteLength} bytes`, 'info');
      await session.push(buffer);
    } else if (pushMode === 'window') {
      dbgLog('Push windowed', `${file.name} · ${buffer.byteLength} bytes · ${CHUNK_SIZE}B chunks · window=${WINDOW_SIZE}`, 'info');
      const inFlight = new Set();
      for (let offset = 0; offset < buffer.byteLength; offset += CHUNK_SIZE) {
        const end = Math.min(offset + CHUNK_SIZE, buffer.byteLength);
        dbgLog('Push chunk', `${file.name} · ${offset}..${end} / ${buffer.byteLength}`, 'info');
        const pushPromise = session.push(buffer.slice(offset, end));
        inFlight.add(pushPromise);
        pushPromise.finally(() => inFlight.delete(pushPromise));
        if (inFlight.size >= WINDOW_SIZE) {
          await Promise.race(inFlight);
        }
      }
      await Promise.all(inFlight);
    } else {
      dbgLog('Push chunks', `${file.name} · ${buffer.byteLength} bytes · ${CHUNK_SIZE}B chunks`, 'info');
      const pushes = [];
      for (let offset = 0; offset < buffer.byteLength; offset += CHUNK_SIZE) {
        const end = Math.min(offset + CHUNK_SIZE, buffer.byteLength);
        dbgLog('Push chunk', `${file.name} · ${offset}..${end} / ${buffer.byteLength}`, 'info');
        pushes.push(session.push(buffer.slice(offset, end)));
      }
      await Promise.all(pushes);
    }
    await session.close();
    dbgLog('Push complete', file.name, 'info');
  })();

  const framesTask = (async () => {
    for await (const frame of session.frames()) {
      frameCount++;
      dbgLog('Frame', `${file.name} · ${frame.stage} · ${frame.info.width}x${frame.info.height}`, 'info');
      renderFrameToSlot(slotEl, frame);

      // Badge reflects progression stage
      const stage = frame.stage ?? '';
      if (stage === 'dc') {
        setBadge(slotEl, 'dc', 'DC');
      } else if (stage === 'final') {
        setBadge(slotEl, 'full', 'full');
      } else {
        setBadge(slotEl, 'pass', `pass ${frameCount}`);
      }
    }
  })();

  try {
    await Promise.all([pushTask, framesTask]);
    if (frameCount === 0) {
      setBadge(slotEl, 'error', 'no frames');
      log(`${file.name}: decoded but emitted 0 frames`, 'warn');
      dbgLog('No frames', file.name, 'warn');
    } else {
      setBadge(slotEl, 'full', 'full');
      log(`${file.name}: done (${frameCount} frame${frameCount > 1 ? 's' : ''})`);
      dbgLog('Decode done', `${file.name} · ${frameCount} frame${frameCount > 1 ? 's' : ''}`, 'success');
    }
  } catch (e) {
    setBadge(slotEl, 'error', 'error');
    log(`${file.name}: ${e.message}`, 'error');
    dbgLog('Decode error', `${file.name}\n${e.stack ?? e.message}`, 'error');
  }
}

// ── Gallery pipeline (round-robin reveal + lightbox) ──────────────────────────

async function startGallery(selectedFiles) {
  if (!ctx) {
    log('Context not ready', 'warn');
    return;
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
    cell.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') open(); });

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
    document.removeEventListener('keydown', onKey);
  }

  // Decode all files concurrently, register frames with coordinator
  const filePromises = selectedFiles.map(async file => {
    const fileId = slotId(file);
    const startMs = Date.now();

    let buffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (e) {
      log(`${file.name}: read error — ${e.message}`, 'error');
      return;
    }

    dbgLog('Decoding', `${file.name} · ${buffer.byteLength} bytes · mode=${pushMode}`, 'info');

    const session = ctx.decode({
      format: 'rgba8',
      progressionTarget: 'final',
      emitEveryPass: true,
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
        const enriched = {
          ...frame,
          frameIndex: frameIndex++,
          elapsedMs,
          bytesFed,
          percentFed,
          totalBytes: buffer.byteLength,
        };
        framesByFile.get(fileId).push(enriched);
        coordinator.registerFrame(fileId, enriched);
        reRenderAll();
        dbgLog('Frame', `${file.name} · ${frame.stage}`, 'info');
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
