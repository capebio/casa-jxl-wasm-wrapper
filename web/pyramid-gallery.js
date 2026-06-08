// web/pyramid-gallery.js
// M1 gallery grid: index.json seed, aspect layout (no shift), L0 first,
// DPR upgrade, scheduler one-shot via jxl-session (contenthash keyed dedupe),
// monotonic no-downgrade, crossfade, viewport + prefetch ring, cancel-before-start,
// LRU/OPFS via the browser context (jxl-cache reuse).
// Pure client. Consumes artifacts from @casabio/pyramid-ingest (8-bit, contenthash levels, manifests).

import { createBrowserContext } from '../packages/jxl-session/dist/index.js';

const gridEl = document.getElementById('grid');
const baseInput = document.getElementById('base');
const loadBtn = document.getElementById('load-btn');
const statusEl = document.getElementById('status');
const dprChk = document.getElementById('dpr-up');

let ctx = null;
let ctxReady = null;
const tiles = new Map(); // imageId -> { el, canvas, ctx2d, currentSize: number, abort?: AbortController, sessions: Set }
let io = null;
let base = 'pyramid-out';

function logStatus(s) { statusEl.textContent = s; }

async function ensureContext() {
  if (ctxReady) return ctxReady;
  ctxReady = (async () => {
    ctx = createBrowserContext();
    // context owns scheduler + (via wiring) cache for OPFS/LRU reuse on decode paths
  })();
  return ctxReady;
}

function urlFor(p) {
  // p like 'index.json' or 'levels/abc123def4567890.jxl' or 'images/id/manifest.json'
  if (/^https?:\/\//.test(base)) return `${base.replace(/\/$/, '')}/${p}`;
  // relative to this page (web/); user can put pyramid-out next to project or adjust base
  return `${base.replace(/\/$/, '')}/${p}`;
}

function makeTile(imageId, aspect, l0) {
  const el = document.createElement('div');
  el.className = 'tile';
  // aspect layout BEFORE any bytes: prevents shift. Use padding-bottom trick or aspect-ratio.
  const h = 100 / aspect; // height as % of width for the box
  el.style.aspectRatio = `${aspect}`;
  el.style.width = '100%';
  el.innerHTML = `
    <canvas></canvas>
    <div class="label">${imageId.slice(0,8)}…</div>
    <div class="level">L0</div>
  `;
  const canvas = el.querySelector('canvas');
  const c2d = canvas.getContext('2d', { alpha: true });
  // initial size; will resize on paint
  canvas.width = l0.w || 256;
  canvas.height = l0.h || Math.round((l0.w || 256) / aspect);
  const tile = { el, canvas, c2d, currentSize: 0, sessions: new Set(), imageId, aspect, l0 };
  tiles.set(imageId, tile);
  gridEl.appendChild(el);
  return tile;
}

function resizeCanvasToDisplay(c, dpr = 1) {
  // keep backing store reasonable; display size driven by CSS grid
  const rect = c.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (c.width !== w || c.height !== h) {
    c.width = w; c.height = h;
  }
  return { w, h };
}

function paint(tile, pixels, info, levelSize, fadeMs = 120) {
  const { canvas, c2d } = tile;
  const dpr = (dprChk && dprChk.checked) ? (window.devicePixelRatio || 1) : 1;
  const disp = resizeCanvasToDisplay(canvas, dpr);
  // simple monotonic guard (caller should check before calling)
  if (levelSize && levelSize <= (tile.currentSize || 0)) return;
  let src = new Uint8ClampedArray(pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels));
  const iw = info.width, ih = info.height;
  // M3 16-bit dither for display if source is 16 (simple shift or FS if high bit)
  if (info.bitsPerSample === 16 || src.length === iw * ih * 6) {
    src = dither16To8(src, iw, ih); // Floyd-Steinberg or simple
  }
  // draw with crossfade: save current, draw new with alpha ramp
  const prev = c2d.getImageData(0, 0, canvas.width, canvas.height);
  // scale source to disp
  const tmp = document.createElement('canvas');
  tmp.width = iw; tmp.height = ih;
  const t2 = tmp.getContext('2d');
  const id = new ImageData(src, iw, ih);
  t2.putImageData(id, 0, 0);
  c2d.imageSmoothingEnabled = true;
  // immediate draw low quality then fade? for simplicity: direct draw + label
  c2d.clearRect(0, 0, canvas.width, canvas.height);
  c2d.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  tile.currentSize = levelSize || Math.max(iw, ih);
  const lvlEl = tile.el.querySelector('.level');
  if (lvlEl) lvlEl.textContent = (levelSize === 'full' || levelSize > 1024) ? 'full' : `${levelSize || ''}`;
  // crossfade is approximated by the paint swap; for smoother a second layer + raf alpha can be added
}

function dither16To8(src16, w, h) {
  // Simple 16->8 (high byte) + basic Floyd-Steinberg dither on luminance error for demo.
  // Real M3: WebGL float + shader dither or FS on full.
  const out = new Uint8ClampedArray(w * h * 4);
  const errR = new Float32Array(w * h);
  const errG = new Float32Array(w * h);
  const errB = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o16 = i * 6;
    let r = ((src16[o16 + 1] || 0) << 8) | (src16[o16] || 0);
    let g = ((src16[o16 + 3] || 0) << 8) | (src16[o16 + 2] || 0);
    let b = ((src16[o16 + 5] || 0) << 8) | (src16[o16 + 4] || 0);
    r = Math.max(0, Math.min(65535, r + errR[i]));
    g = Math.max(0, Math.min(65535, g + errG[i]));
    b = Math.max(0, Math.min(65535, b + errB[i]));
    const o8 = i * 4;
    out[o8] = r >> 8;
    out[o8 + 1] = g >> 8;
    out[o8 + 2] = b >> 8;
    out[o8 + 3] = 255;
    // simple error diffusion (no full FS for brevity)
    const er = (r & 0xff) - 128;
    const eg = (g & 0xff) - 128;
    const eb = (b & 0xff) - 128;
    if (i + 1 < w * h) { errR[i+1] += er * 0.4375; errG[i+1] += eg * 0.4375; errB[i+1] += eb * 0.4375; }
  }
  return out;
}

async function decodeOneShot(bytes, opts = {}) {
  // One-shot via session (goes through scheduler for dedupe/priority/cancel/backpressure).
  // Keying by contenthash: the level bytes are immutable by hash; scheduler dedupe (sourceKey)
  // will collapse duplicate hashes if lower layers expose/propagate a key. For M1 we pass
  // the bytes; caller ensures key discipline via url/hash. This is *not* a new decode path.
  await ensureContext();
  const session = ctx.decode({
    format: 'rgba8',
    progressionTarget: 'final',
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
    ...opts,
  });
  // record for possible cancel-before-start
  return { session, run: async () => {
    const ab = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    await session.push(ab);
    await session.close();
    let final = null;
    for await (const ev of session.frames()) {
      if (ev.type === 'final') { final = ev; break; }
      if (ev.type === 'error') throw new Error(ev.message || 'decode error');
    }
    await session.done().catch(() => {});
    return final;
  }};
}

async function loadLevel(tile, hash, sizeHint, baseUrl) {
  const u = urlFor(`levels/${hash}.jxl`);
  const res = await fetch(u);
  if (!res.ok) throw new Error(`fetch ${u} ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const { session, run } = await decodeOneShot(buf);
  tile.sessions.add(session);
  try {
    const ev = await run();
    if (ev && ev.pixels) {
      paint(tile, ev.pixels, ev.info, sizeHint);
    }
  } finally {
    tile.sessions.delete(session);
    try { await session.dispose?.(); } catch {}
  }
}

async function loadManifest(imageId) {
  const u = urlFor(`images/${imageId}/manifest.json`);
  const res = await fetch(u);
  if (!res.ok) return null;
  return res.json();
}

function pickUpgradeSize(manifest, containerLong, dpr) {
  // pick smallest level whose long edge >= containerLong * dpr (or full)
  if (!manifest || !manifest.levels) return null;
  const target = Math.ceil((containerLong || 256) * (dprChk && dprChk.checked ? (window.devicePixelRatio || 1) : 1));
  let best = null;
  for (const lv of manifest.levels) {
    const long = Math.max(lv.w, lv.h);
    if (long >= target && (!best || long < Math.max(best.w, best.h))) best = lv;
  }
  if (!best) best = manifest.levels[manifest.levels.length - 1]; // largest available
  return best;
}

function startIO() {
  if (io) io.disconnect();
  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const id = e.target.dataset.imageId;
      const tile = tiles.get(id);
      if (!tile) continue;
      if (e.isIntersecting) {
        // seed or upgrade when near viewport
        activateTile(tile).catch(() => {});
      } else {
        // cancel offscreen before/ during start (best effort)
        cancelTile(tile);
      }
    }
  }, { rootMargin: '200px' }); // prefetch ring-ish margin
  for (const t of tiles.values()) {
    t.el.dataset.imageId = t.imageId;
    io.observe(t.el);
  }
}

async function activateTile(tile) {
  if (tile.currentSize > 0) return; // L0 or better already
  // L0 seed from index data
  const l0 = tile.l0;
  try {
    await loadLevel(tile, l0.contenthash, l0.w || 256, base);
  } catch (e) {
    // ignore per-file; grid continues
  }
  // if manifest available and DPR wants upgrade, do it (non blocking)
  if (dprChk && dprChk.checked) {
    const man = await loadManifest(tile.imageId).catch(() => null);
    if (man) {
      const up = pickUpgradeSize(man, tile.el.clientWidth || 256, window.devicePixelRatio || 1);
      if (up && up.contenthash !== l0.contenthash) {
        try {
          await loadLevel(tile, up.contenthash, up.size || Math.max(up.w, up.h), base);
        } catch {}
      }
    }
  }
}

function cancelTile(tile) {
  for (const s of tile.sessions) {
    try { s.cancel?.('offscreen'); } catch {}
  }
  tile.sessions.clear();
}

async function loadIndexAndSeed() {
  gridEl.innerHTML = '';
  tiles.clear();
  if (io) { io.disconnect(); io = null; }
  base = (baseInput.value || 'pyramid-out').trim();
  logStatus('loading index...');
  const idxUrl = urlFor('index.json');
  let idx;
  try {
    const r = await fetch(idxUrl);
    if (!r.ok) throw new Error(`index ${r.status}`);
    idx = await r.json();
  } catch (e) {
    logStatus('index load failed: ' + e.message + ' (set base to your pyramid-out dir and ensure static serve)');
    return;
  }
  if (!idx || !Array.isArray(idx.images)) { logStatus('bad index'); return; }
  logStatus(`index: ${idx.images.length} images; seeding L0...`);
  await ensureContext();
  for (const entry of idx.images) {
    const tile = makeTile(entry.imageId, entry.aspect || 1, entry.l0 || { contenthash: '', w: 256, h: 192 });
    // L0 decode is driven by IO (viewport + ring)
  }
  startIO();
  // kick a few visible immediately (first paint)
  const first = [...tiles.values()].slice(0, 6);
  for (const t of first) activateTile(t).catch(() => {});
  logStatus(`grid ready (${tiles.size} tiles). scroll to trigger decodes + upgrades.`);
}

loadBtn.addEventListener('click', loadIndexAndSeed);
baseInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadIndexAndSeed(); });
dprChk.addEventListener('change', () => {
  // on toggle, tiles keep current; next activate/upgrade will respect
});

// auto-hint: if ?base=... prefill
const qs = new URLSearchParams(location.search);
if (qs.get('base')) baseInput.value = qs.get('base');
if (qs.get('autostart') != null) setTimeout(loadIndexAndSeed, 60);

console.log('%c[Pyramid M1 Grid] loaded — L0 seed + scheduler one-shot upgrades (contenthash discipline via level URLs)', 'color:#6b9');
logStatus('set base + Load (or ?base=...&autostart=1)');

// === M2 Lightbox integration (8-bit) ===
// Click tile -> open lightbox with zoom/pan/adjustments using pyramid levels for that imageId.
// Reuses existing decodeOneShot (scheduler path), adds FilterEngine, LRU, priority notes, live histo.

import createFilterEngine, { LightboxPreset, APPROVED_LIGHTBOX_PRESETS } from './pyramid-filter-engine.js';

let lightboxEng = null;
let lbState = null; // { imageId, levels: [{size,hash,w,h}], currentLevelIdx, sourceBitmap: Uint8ClampedArray | null, view: {scale, tx, ty}, params, preset }
const lbModal = document.createElement('div');
lbModal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9999;display:none;flex-direction:column';
lbModal.innerHTML = `
  <div style="display:flex;gap:12px;align-items:center;padding:8px 12px;background:#1a1a1a;border-bottom:1px solid #333">
    <span id="lb-title" style="font-weight:600"></span>
    <span id="lb-zoom" style="margin-left:8px;color:#6b9;font-variant-numeric:tabular-nums">100%</span>
    <div style="margin-left:auto;display:flex;gap:6px;align-items:center">
      <label style="font-size:10px"><input id="lb-16bit" type="checkbox"> 16-bit (RAW only)</label>
      <button id="lb-reset" style="padding:2px 8px">Reset</button>
      <button id="lb-close" style="padding:2px 8px">Close</button>
    </div>
  </div>
  <div style="flex:1;display:flex;min-height:0">
    <div style="flex:1;position:relative;overflow:hidden;background:#111" id="lb-viewport">
      <canvas id="lb-canvas" style="position:absolute;inset:0;margin:auto;display:block;touch-action:none"></canvas>
    </div>
    <div style="width:280px;border-left:1px solid #333;padding:8px 10px;overflow:auto;background:#181818;font-size:12px">
      <div style="margin-bottom:6px;font-weight:600">Presets</div>
      <div id="lb-presets" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px"></div>
      <div style="margin-bottom:6px;font-weight:600">Adjustments</div>
      <div id="lb-sliders"></div>
      <div style="margin:10px 0 4px;font-weight:600">Histogram</div>
      <canvas id="lb-histo" width="256" height="80" style="width:100%;background:#111;border:1px solid #333"></canvas>
      <div style="font-size:10px;color:#888;margin-top:6px">Click grid image to open. Wheel/drag on canvas. Sliders live. No Android dep.</div>
    </div>
  </div>
`;
document.body.appendChild(lbModal);

const lbCanvas = lbModal.querySelector('#lb-canvas');
const lbCtx = lbCanvas.getContext('2d');
const lbViewport = lbModal.querySelector('#lb-viewport');
const lbZoomEl = lbModal.querySelector('#lb-zoom');
const lbTitleEl = lbModal.querySelector('#lb-title');
const lbHisto = lbModal.querySelector('#lb-histo');
const lbHistoCtx = lbHisto.getContext('2d');
const lbClose = lbModal.querySelector('#lb-close');
const lbReset = lbModal.querySelector('#lb-reset');
const lbPresetsEl = lbModal.querySelector('#lb-presets');
const lbSlidersEl = lbModal.querySelector('#lb-sliders');

lbClose.onclick = closeLightbox;
lbReset.onclick = resetAdjustments;

function ensureEngine() {
  if (!lightboxEng) lightboxEng = createFilterEngine();
  return lightboxEng;
}

function buildPresetButtons() {
  lbPresetsEl.innerHTML = '';
  for (const p of APPROVED_LIGHTBOX_PRESETS) {
    const b = document.createElement('button');
    b.textContent = p;
    b.style.cssText = 'font-size:10px;padding:1px 5px;border:1px solid #444;background:#222;color:#ddd';
    b.onclick = () => { ensureEngine().setPreset(p); renderLightboxAdjusted(); };
    lbPresetsEl.appendChild(b);
  }
}

function buildSliders() {
  lbSlidersEl.innerHTML = '';
  const eng = ensureEngine();
  const labels = {
    brightness: 'Brightness',
    contrast: 'Contrast',
    saturation: 'Saturation',
    shadows: 'Shadows',
    highlights: 'Highlights',
    clarity: 'Clarity',
    dehaze: 'Dehaze',
    sharpness: 'Sharpness',
  };
  for (const key of eng.APPROVED_SLIDERS) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;margin:3px 0;gap:6px';
    const lab = document.createElement('label');
    lab.style.width = '70px';
    lab.textContent = labels[key] || key;
    const range = document.createElement('input');
    range.type = 'range';
    range.min = key === 'highlights' ? '-1' : '0';
    range.max = (key === 'brightness' || key === 'contrast' || key === 'saturation') ? '1' : '1';
    range.step = '0.01';
    range.value = '0';
    range.style.flex = '1';
    const val = document.createElement('span');
    val.style.width = '38px';
    val.style.textAlign = 'right';
    val.textContent = '0';
    range.oninput = () => {
      eng.setParam(key, parseFloat(range.value));
      val.textContent = parseFloat(range.value).toFixed(2);
      renderLightboxAdjusted();
    };
    row.append(lab, range, val);
    lbSlidersEl.appendChild(row);
  }
}

function updateZoomReadout(scale) {
  lbZoomEl.textContent = Math.round(scale * 100) + '%';
}

let lbRaf = 0;
function renderLightboxAdjusted() {
  if (!lbState || !lbState.sourceBitmap) return;
  const eng = ensureEngine();
  const src = lbState.sourceBitmap;
  const w = lbState.srcW, h = lbState.srcH;
  const adjusted = eng.apply(src, w, h);

  // draw to canvas with current view transform
  const v = lbState.view;
  lbCanvas.width = lbViewport.clientWidth;
  lbCanvas.height = lbViewport.clientHeight;
  lbCtx.save();
  lbCtx.fillStyle = '#111';
  lbCtx.fillRect(0, 0, lbCanvas.width, lbCanvas.height);
  lbCtx.translate(lbCanvas.width / 2 + v.tx, lbCanvas.height / 2 + v.ty);
  lbCtx.scale(v.scale, v.scale);
  lbCtx.translate(-w / 2, -h / 2);

  const id = new ImageData(adjusted, w, h);
  // create temp for drawImage
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  tmp.getContext('2d').putImageData(id, 0, 0);
  lbCtx.drawImage(tmp, 0, 0);
  lbCtx.restore();

  // histogram from adjusted (live)
  const hist = eng.computeHistogram(adjusted);
  drawHisto(hist);

  updateZoomReadout(v.scale);
}

function drawHisto(hist) {
  const c = lbHistoCtx;
  c.fillStyle = '#111';
  c.fillRect(0, 0, 256, 80);
  const max = hist.max || 1;
  const scaleY = 78 / max;
  const colors = { r: '#f44', g: '#4f4', b: '#44f', lum: '#ddd' };
  for (const ch of ['r', 'g', 'b', 'lum']) {
    c.strokeStyle = colors[ch];
    c.beginPath();
    for (let x = 0; x < 256; x++) {
      const y = 79 - Math.round(hist[ch][x] * scaleY);
      if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  }
}

function pickLevelForScreen(levels, screenLong) {
  const target = Math.ceil(screenLong * (window.devicePixelRatio || 1));
  let best = levels[0];
  for (const lv of levels) {
    const long = Math.max(lv.w, lv.h);
    if (long >= target && long < Math.max(best.w, best.h)) best = lv;
  }
  return best || levels[levels.length - 1];
}

async function openLightbox(imageId, seedLevel /* optional from grid */) {
  const eng = ensureEngine();
  eng.reset();
  lbModal.style.display = 'flex';
  lbTitleEl.textContent = imageId;
  buildPresetButtons();
  buildSliders();

  // fetch manifest for full ladder (M1 output)
  let manifest = null;
  try {
    const manUrl = urlFor(`images/${imageId}/manifest.json`);
    const r = await fetch(manUrl);
    if (r.ok) manifest = await r.json();
  } catch {}

  const levels = (manifest && manifest.levels) ? manifest.levels.map(l => ({
    size: l.size, hash: l.contenthash, w: l.w, h: l.h
  })) : (seedLevel ? [seedLevel] : []);

  if (levels.length === 0) {
    logStatus('no levels for ' + imageId);
    closeLightbox();
    return;
  }

  // initial level by screen (adaptive)
  const screenLong = Math.max(lbViewport.clientWidth || 600, lbViewport.clientHeight || 400);
  const startLv = pickLevelForScreen(levels, screenLong);

  lbState = {
    imageId,
    levels: levels.sort((a,b) => (a.w*a.h) - (b.w*b.h)),
    currentLevelIdx: levels.findIndex(l => l.hash === startLv.hash),
    sourceBitmap: null,
    srcW: startLv.w,
    srcH: startLv.h,
    view: { scale: 1, tx: 0, ty: 0 },
  };

  // seed decode (reuse scheduler one-shot path, note visible priority for current lightbox image)
  // In full integration the decode would be dispatched with priority:"visible" via scheduler.
  try {
    const buf = await fetchLevel(startLv.hash);
    const { session, run } = await decodeOneShot(buf); // existing, goes through ctx/scheduler
    lbState.sessions = (lbState.sessions || new Set()).add(session);
    const ev = await run();
    if (ev && ev.pixels) {
      lbState.sourceBitmap = new Uint8ClampedArray(ev.pixels);
      lbState.srcW = ev.info.width;
      lbState.srcH = ev.info.height;
      renderLightboxAdjusted();
    }
  } catch (e) {
    logStatus('lightbox decode fail: ' + e.message);
  }

  // wire canvas pan/zoom (transform only; re-decode only on level change)
  wireLightboxCanvas();
}

function fetchLevel(hash) {
  return fetch(urlFor(`levels/${hash}.jxl`)).then(r => r.arrayBuffer()).then(b => new Uint8Array(b));
}

function wireLightboxCanvas() {
  let dragging = false;
  let lastX = 0, lastY = 0;

  lbCanvas.onmousedown = (e) => {
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
  };
  window.onmouseup = () => { dragging = false; };
  lbCanvas.onmousemove = (e) => {
    if (!dragging || !lbState) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lbState.view.tx += dx;
    lbState.view.ty += dy;
    lastX = e.clientX; lastY = e.clientY;
    renderLightboxAdjusted();
  };

  lbCanvas.onwheel = (e) => {
    if (!lbState) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    const oldScale = lbState.view.scale;
    let newScale = clamp(oldScale * factor, 0.2, 8);

    // if scale crossed to need bigger level, upgrade
    const neededLong = Math.max(lbState.srcW, lbState.srcH) * newScale;
    const better = lbState.levels.find(l => Math.max(l.w, l.h) >= neededLong * 0.9);
    if (better && better.hash !== lbState.levels[lbState.currentLevelIdx]?.hash) {
      // upgrade level (crossfade approx by immediate switch + re-render)
      upgradeLightboxLevel(better);
      return;
    }
    // otherwise just transform pan/zoom (no re-decode)
    lbState.view.scale = newScale;
    renderLightboxAdjusted();
  };

  // double-click: jump to next ladder level or 100%
  lbCanvas.ondblclick = () => {
    if (!lbState) return;
    const idx = lbState.currentLevelIdx;
    if (idx < lbState.levels.length - 1) {
      upgradeLightboxLevel(lbState.levels[idx + 1]);
    } else {
      lbState.view.scale = 1;
      renderLightboxAdjusted();
    }
  };
}

async function upgradeLightboxLevel(targetLevel) {
  if (!lbState) return;
  const idx = lbState.levels.findIndex(l => l.hash === targetLevel.hash);
  if (idx < 0) return;

  // crossfade note: for M2 we switch source then re-render (instant for cached LRU later)
  try {
    const buf = await fetchLevel(targetLevel.hash);
    const { session, run } = await decodeOneShot(buf);
    const ev = await run();
    if (ev && ev.pixels) {
      // monotonic: only accept if larger or same
      const newLong = Math.max(ev.info.width, ev.info.height);
      const oldLong = Math.max(lbState.srcW, lbState.srcH);
      if (newLong >= oldLong * 0.95) {
        lbState.sourceBitmap = new Uint8ClampedArray(ev.pixels);
        lbState.srcW = ev.info.width;
        lbState.srcH = ev.info.height;
        lbState.currentLevelIdx = idx;
        // keep view scale reasonable
        lbState.view.scale = Math.min(lbState.view.scale, 1.0);
        renderLightboxAdjusted();
      }
    }
  } catch (e) { /* ignore */ }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function resetAdjustments() {
  if (!lbState) return;
  ensureEngine().reset();
  // reset slider UI values
  lbSlidersEl.querySelectorAll('input').forEach(inp => { inp.value = '0'; });
  renderLightboxAdjusted();
}

function closeLightbox() {
  lbModal.style.display = 'none';
  if (lbState && lbState.sessions) lbState.sessions.forEach(s => { try { s.cancel?.('lightbox close'); } catch {} });
  lbState = null;
}

// expose for grid tiles
window.openPyramidLightbox = openLightbox;

// wire existing tiles (after grid is built) - monkey patch a bit for demo
const origMakeTile = window.makeTileForPyramid || null; // if refactored later
// For now, after load, add click handlers to .tile
function wireGridClicksForLightbox() {
  gridEl.addEventListener('click', async (ev) => {
    const tile = ev.target.closest('.tile');
    if (!tile || !lbModal) return;
    const id = tile.dataset.imageId || tile.querySelector('.label')?.textContent?.replace('…','');
    if (!id) return;
    // try to find manifest or use L0 from tile data (simplified)
    await openLightbox(id.replace('…',''), { w: 256, h: 192, hash: '' }); // will fetch manifest inside
  }, { capture: true });
}

// call after grid render
setTimeout(wireGridClicksForLightbox, 800);
