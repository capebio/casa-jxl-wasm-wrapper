// web/jxl-progressive-gallery.js
// Demo: wires ProgressiveGallery to a canvas grid.
// Import jxl-progressive from built dist. Adjust path to match your setup.
// Requires a JxlContext to be available (from jxl-session).

import {
  ProgressiveCache,
  ProgressiveGallery,
} from '../packages/jxl-progressive/dist/index.js';
import { createBrowserContext } from '../packages/jxl-session/dist/index.js';
import { createJxlCache } from '../packages/jxl-cache/dist/index.js';

const galleryEl = document.getElementById('gallery');
const logEl = document.getElementById('log');
const jxlUrlInput = document.getElementById('jxl-url');
const countInput = document.getElementById('count');
const loadBtn = document.getElementById('load-btn');
const pauseBtn = document.getElementById('pause-btn');
const resetBtn = document.getElementById('reset-btn');

let ctx = null;
let currentGallery = null;
const slots = new Map(); // id → { canvas, badgeEl }

function log(msg) {
  const line = document.createElement('div');
  line.textContent = `${new Date().toISOString().slice(11, 23)} ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

async function init() {
  ctx = await createBrowserContext();
  log('JXL context ready');
}

function sessionFactory() {
  return ctx.decode({
    format: 'rgba8',
    emitEveryPass: true,
    progressionTarget: 'final',
  });
}

function buildGrid(count) {
  galleryEl.innerHTML = '';
  slots.clear();
  for (let i = 0; i < count; i++) {
    const id = `slot-${i}`;
    const slotEl = document.createElement('div');
    slotEl.className = 'slot';
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 300;
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = 'none';
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    spinner.textContent = '⏳';
    slotEl.appendChild(canvas);
    slotEl.appendChild(badge);
    slotEl.appendChild(spinner);
    galleryEl.appendChild(slotEl);
    slots.set(id, { canvas, badgeEl: badge, spinnerEl: spinner, slotEl });
  }
}

function renderFrame(id, frame) {
  const slot = slots.get(id);
  if (!slot) return;
  const { canvas, spinnerEl } = slot;
  spinnerEl.style.display = 'none';
  const ctx2d = canvas.getContext('2d');
  const { width, height, pixels } = frame.info
    ? { ...frame, width: frame.info.width, height: frame.info.height }
    : { width: canvas.width, height: canvas.height, pixels: frame.pixels };
  canvas.width = width;
  canvas.height = height;
  const imageData = new ImageData(
    new Uint8ClampedArray(pixels instanceof ArrayBuffer ? pixels : frame.pixels),
    width,
    height,
  );
  ctx2d.putImageData(imageData, 0, 0);
}

function onTier(id, tier) {
  const slot = slots.get(id);
  if (!slot) return;
  slot.badgeEl.textContent = tier;
  log(`${id}: reached tier ${tier}`);
}

function onError(id, err) {
  log(`${id}: ERROR ${err.message}`);
}

async function loadGallery() {
  if (currentGallery) {
    currentGallery.destroy();
    currentGallery = null;
  }

  const baseUrl = jxlUrlInput.value.trim();
  const count = parseInt(countInput.value, 10) || 6;
  buildGrid(count);

  const innerCache = createJxlCache({ memoryLimit: 128 * 1024 * 1024, persistentLimit: 512 * 1024 * 1024, persistent: true });
  const cache = new ProgressiveCache(innerCache);

  const gallery = new ProgressiveGallery(cache, sessionFactory, {
    maxActiveDecoders: 4,
    onFrame: renderFrame,
    onTier,
    onError,
  });

  currentGallery = gallery;

  for (let i = 0; i < count; i++) {
    const id = `slot-${i}`;
    const slot = slots.get(id);
    const jxlUrl = `${baseUrl}${i}.jxl`;
    gallery.observe(slot.slotEl, id, jxlUrl);
    log(`observe ${id} → ${jxlUrl}`);
  }
}

let paused = false;
pauseBtn.addEventListener('click', () => {
  paused = !paused;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  log(paused ? 'Paused' : 'Resumed');
});

resetBtn.addEventListener('click', () => {
  if (currentGallery) { currentGallery.destroy(); currentGallery = null; }
  galleryEl.innerHTML = '';
  slots.clear();
  log('Reset');
});

loadBtn.addEventListener('click', loadGallery);

// Double-click a slot to select (lightbox)
galleryEl.addEventListener('dblclick', (e) => {
  if (!currentGallery) return;
  const slotEl = e.target.closest('.slot');
  if (!slotEl) return;
  for (const [id, slot] of slots.entries()) {
    if (slot.slotEl === slotEl) {
      currentGallery.select(id);
      slot.badgeEl.style.color = '#ff0';
      log(`${id}: selected (full quality)`);
      break;
    }
  }
});

init().catch(err => log(`Init error: ${err.message}`));
