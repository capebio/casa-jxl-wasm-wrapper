// web/jxl-progressive-gallery.js
// Progressive JXL gallery — local file picker, direct DecodeSession decode.
// Works entirely with local .jxl files; no HTTP server required.
// Feed each file in chunks with emitEveryPass=true to show dc → pass → full.

import { createBrowserContext } from '../packages/jxl-session/dist/index.js';
import { initDebugConsole, dbgLog } from './jxl-debug-console.js';

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
  const files = [...sourceInput.files].filter(f =>
    /\.jxl$/i.test(f.name)
  );

  if (files.length === 0) {
    pickerStatus.textContent = 'No JXL files in selection';
    return;
  }

  pickerStatus.textContent = `${files.length} JXL file${files.length > 1 ? 's' : ''} selected`;

  // Clear gallery and queue
  if (galleryEl) galleryEl.innerHTML = '';
  queue.length = 0;

  for (const file of files) {
    createSlot(file);
    queue.push(file);
  }

  log(`Queued ${files.length} files`);
  dbgLog('Queued files', `${files.length} JXL file${files.length > 1 ? 's' : ''} selected`);
  drain();
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
