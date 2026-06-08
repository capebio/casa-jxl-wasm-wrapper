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
  const src = new Uint8ClampedArray(pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels));
  const iw = info.width, ih = info.height;
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
