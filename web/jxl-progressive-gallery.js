// web/jxl-progressive-gallery.js
// Progressive JXL gallery — local file picker, direct DecodeSession decode.
// Works entirely with local .jxl files; no HTTP server required.
// Feed each file in chunks with emitEveryPass=true to show dc → pass → full.

import { createBrowserContext } from '../packages/jxl-session/dist/index.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────

const sourceInput   = document.getElementById('source-input');
const pickerStatus  = document.getElementById('picker-status');
const concurrentEl  = document.getElementById('concurrent');
const concurrentVal = document.getElementById('concurrent-val');
const galleryEl     = document.getElementById('gallery');
const logEl         = document.getElementById('log');

// ── State ─────────────────────────────────────────────────────────────────────

let ctx = null;
let activeDecoders = 0;
const queue = []; // Array<File>

const CHUNK_SIZE = 65536; // 64 KiB per push — small enough for visible progression

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  try {
    ctx = createBrowserContext();
    log('JXL context ready');
  } catch (e) {
    log(`Init error: ${e.message}`, 'error');
  }
})();

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
  galleryEl.innerHTML = '';
  queue.length = 0;

  for (const file of files) {
    createSlot(file);
    queue.push(file);
  }

  log(`Queued ${files.length} files`);
  drain();
});

// ── Queue drain ───────────────────────────────────────────────────────────────

function drain() {
  const max = parseInt(concurrentEl.value, 10);
  while (queue.length > 0 && activeDecoders < max) {
    const file = queue.shift();
    activeDecoders++;
    decodeFile(file).finally(() => {
      activeDecoders--;
      drain();
    });
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
  galleryEl.appendChild(slotEl);

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
  const pixels = frame.pixels instanceof ArrayBuffer
    ? frame.pixels
    : frame.pixels.buffer;

  const imageData = new ImageData(
    new Uint8ClampedArray(pixels),
    width,
    height,
  );
  ctx2d.putImageData(imageData, 0, 0);
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

  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (e) {
    setBadge(slotEl, 'error', 'read err');
    log(`${file.name}: read error — ${e.message}`, 'error');
    return;
  }

  setBadge(slotEl, 'wait', 'decoding…');

  const session = ctx.decode({
    format: 'rgba8',
    emitEveryPass: true,
    progressiveDetail: 'dcProgressive', // DC then progressive AC passes
  });

  let frameCount = 0;

  // Push bytes and collect frames concurrently (mirrors profileJxl pattern).
  const pushTask = (async () => {
    const total = buffer.byteLength;
    for (let offset = 0; offset < total; offset += CHUNK_SIZE) {
      await session.push(buffer.slice(offset, Math.min(offset + CHUNK_SIZE, total)));
    }
    await session.close();
  })();

  const framesTask = (async () => {
    for await (const frame of session.frames()) {
      frameCount++;
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
    } else {
      setBadge(slotEl, 'full', 'full');
      log(`${file.name}: done (${frameCount} frame${frameCount > 1 ? 's' : ''})`);
    }
  } catch (e) {
    setBadge(slotEl, 'error', 'error');
    log(`${file.name}: ${e.message}`, 'error');
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
