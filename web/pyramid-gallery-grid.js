// web/pyramid-gallery-grid.js
// Pyramid Gallery Grid (M1) — index.json seed + L0 first + monotonic DPR upgrades.
// Uses pyramid-ingest output layout (index.json, images/<id>/manifest.json, levels/<contenthash>.jxl).
// One-shot DecodeSession via scheduler (sourceKey=contenthash for dedupe), priority lanes, preemption, cancel-before-start.
// Reuses ctx.decode(), existing scheduler/dedupe/OPFS cache (jxl-cache) exactly. No ad-hoc queue, no new scheduler/cache layer, 8-bit only.
// Aspect layout reserves space (no shift on upgrade). Crossfade on level paint. Viewport + prefetch ring.
// Matches progressive gallery style and invariants.
//
// NOTE: sourceKey wiring (jxl-core types + decode-session) + this file are source. Demo pages import *dist*, so full deduped one-shot behavior and type visibility require package rebuild (tools/run-workspaces or equivalent) before runtime test. Per handoff gates.

import { createBrowserContext } from '../packages/jxl-session/dist/index.js';
import { packFramePixels } from './jxl-progressive-gallery-frame.js';
import { createFilterEngine, LightboxPreset, APPROVED_LIGHTBOX_PRESETS, ADJUSTMENT_PARAMS } from './lightbox/filter-engine.js';
import { createPyramidLightbox } from './lightbox/pyramid-lightbox.js';

console.log('%c[Pyramid Grid] pyramid-gallery-grid.js loaded — L0 seed + scheduler one-shot upgrades keyed by contenthash', 'color:#22c55e;font-weight:600');



// (old duplicate M2 lightbox code removed - see extracted pyramid-lightbox.js)

function changeZoom(factor) {
  const oldZoom = lbZoom;
  lbZoom = Math.max(0.1, Math.min(8, lbZoom * factor));
  // keep center on pan adjust rough
  const cx = lbViewW/2, cy = lbViewH/2;
  lbPanX = (lbPanX - cx) * (lbZoom / oldZoom) + cx;
  lbPanY = (lbPanY - cy) * (lbZoom / oldZoom) + cy;
  clampPan();
  updateZoomReadout();
  redrawLightboxView();
  // auto ladder upgrade if zoom demands larger level
  maybeAutoUpgradeLevel();
}

function clampPan() {
  if (!lbLevelInfo || lbZoom <= 0) return;
  const imgW = (lbLevelInfo.w || lbViewW) * lbZoom;
  const imgH = (lbLevelInfo.h || lbViewH) * lbZoom;
  const slack = 80;
  const maxX = Math.max(0, (imgW - lbViewW) / 2 + slack);
  const maxY = Math.max(0, (imgH - lbViewH) / 2 + slack);
  lbPanX = Math.max(-maxX, Math.min(maxX, lbPanX));
  lbPanY = Math.max(-maxY, Math.min(maxY, lbPanY));
}

async function maybeAutoUpgradeLevel() {
  if (!lightboxItem || !lightboxItem.levels || !lbLevelInfo) return;
  const needed = Math.max(lbViewW, lbViewH) * lbZoom * (window.devicePixelRatio || 1);
  const up = chooseLevelForTarget(lightboxItem.levels, lbLevelInfo.size || lbLevelInfo.w || 0, needed);
  if (up && (up.contenthash !== lbLevelInfo.contenthash)) {
    await loadLightboxLevel(up);
  }
}

async function loadLightboxLevel(levelEntry) {
  if (!levelEntry || !lightboxItem) return;
  log(`lb load level ${levelEntry.size || levelEntry.w} ch=${levelEntry.contenthash.slice(0,8)}`);
  const bytes = await getLevelBytes(levelEntry.contenthash);
  if (!ctx) await ensureCtx();
  const session = ctx.decode({
    format: 'rgba8',
    sourceKey: levelEntry.contenthash,
    priority: 'visible',
    emitEveryPass: false,
    progressionTarget: 'final'
  });
  await session.push(bytes);
  await session.close();
  let last = null;
  for await (const f of session.frames()) if (f && f.pixels) last = f;
  if (!last) return;

  const raw = packFramePixels(last);
  lbLevelPixels = raw;
  lbLevelInfo = { contenthash: levelEntry.contenthash, w: last.info?.width || levelEntry.w, h: last.info?.height || levelEntry.h, size: levelEntry.size || Math.max(levelEntry.w, levelEntry.h) };

  // create offscreen for this level
  lbOffscreen = document.createElement('canvas');
  lbOffscreen.width = lbLevelInfo.w;
  lbOffscreen.height = lbLevelInfo.h;
  // initial filter apply
  reapplyFilterToOffscreen();

  // crossfade on upgrade (rAF animated)
  lbCrossfade = 1.0;
  const start = performance.now();
  const dur = 180;
  const fade = () => {
    const t = Math.min(1, (performance.now() - start) / dur);
    lbCrossfade = 1 - t;
    redrawLightboxView();
    if (lbCrossfade > 0.01) requestAnimationFrame(fade);
    else { lbCrossfade = 0; redrawLightboxView(); }
  };
  requestAnimationFrame(fade);

  // adjust pan/zoom if needed for new res
  if (lbZoom > 1) {
    // keep centered roughly
  }
  redrawLightboxView();
  updateZoomReadout();
}

function reapplyFilterToOffscreen() {
  if (!lbOffscreen || !lbLevelPixels || !lightboxEng) return;
  const srcData = new ImageData(new Uint8ClampedArray(lbLevelPixels), lbOffscreen.width, lbOffscreen.height);
  const adj = lightboxEng.applyToImageData(srcData);
  const octx = lbOffscreen.getContext('2d');
  octx.putImageData(adj, 0, 0);
}

function reapplyFilterAndRedraw() {
  reapplyFilterToOffscreen();
  redrawLightboxView();
}

function redrawLightboxView() {
  if (!lightboxCanvas || !lightboxEng || !histCanvas) return;
  const c2d = lightboxCanvas.getContext('2d', {alpha:true});
  c2d.fillStyle = '#111';
  c2d.fillRect(0,0,lbViewW, lbViewH);

  if (lbOffscreen && lbLevelPixels) {
    c2d.save();
    c2d.translate(lbPanX, lbPanY);
    c2d.scale(lbZoom, lbZoom);
    if (lbCrossfade > 0 && lbOffscreen) {
      c2d.globalAlpha = 1 - lbCrossfade;
    }
    c2d.drawImage(lbOffscreen, 0, 0);
    c2d.restore();
  } else if (lightboxBasePixels) {
    // fallback old path
    const srcData = new ImageData(new Uint8ClampedArray(lightboxBasePixels), lbViewW, lbViewH);
    const adj = lightboxEng.applyToImageData(srcData);
    c2d.putImageData(adj, 0, 0);
  }

  // live histogram of *visible screen pixels* (readback from viewport after transform draw)
  const hctx = histCanvas.getContext('2d');
  hctx.fillStyle = '#111'; hctx.fillRect(0,0,256,70);
  try {
    const viewId = c2d.getImageData(0, 0, lbViewW, lbViewH);
    const hist = lightboxEng.computeHistogram(viewId.data);
    const maxv = Math.max(1, ...hist.l);
    hctx.strokeStyle = '#0f0'; hctx.beginPath();
    for (let x=0; x<256; x++) {
      const y = (hist.l[x] / maxv) * 68;
      if (x===0) hctx.moveTo(x, 69-y); else hctx.lineTo(x, 69-y);
    }
    hctx.stroke();
  } catch (e) {
    // fallback full level
    if (lbOffscreen) {
      const octx = lbOffscreen.getContext('2d');
      const id = octx.getImageData(0,0,lbOffscreen.width, lbOffscreen.height);
      const hist = lightboxEng.computeHistogram(id.data);
      const maxv = Math.max(1, ...hist.l);
      hctx.strokeStyle = '#0f0'; hctx.beginPath();
      for (let x=0; x<256; x++) {
        const y = (hist.l[x] / maxv) * 68;
        if (x===0) hctx.moveTo(x, 69-y); else hctx.lineTo(x, 69-y);
      }
      hctx.stroke();
    }
  }

  updateZoomReadout();
}

async function upgradeLightboxLevel() {
  if (!lightboxItem || !lightboxItem.levels || lightboxItem.levels.length===0 || !lbLevelInfo) return;
  const needed = Math.max(lbViewW, lbViewH) * lbZoom * (window.devicePixelRatio || 1) * 1.1;
  const up = chooseLevelForTarget(lightboxItem.levels, lbLevelInfo.size || lbLevelInfo.w || 0, needed);
  if (up && up.contenthash !== lbLevelInfo.contenthash) {
    await loadLightboxLevel(up);
  }
}

function openLightbox(allItems, startIdx) {
  ensureLightboxDOM();
  // support both single item (legacy) and (items[], idx)
  let itemsList, idx;
  if (Array.isArray(allItems)) {
    itemsList = allItems;
    idx = startIdx | 0;
  } else {
    itemsList = [allItems];
    idx = 0;
  }
  const item = itemsList[idx];
  if (!item) return;

  lightboxItem = item;
  lightboxItemsList = itemsList;
  lightboxCurrentIdx = idx;

  lightboxEng = createFilterEngine(LightboxPreset.NONE);
  lbZoom = 1; lbPanX=0; lbPanY=0; lbCrossfade=0; lbLevelPixels=null; lbOffscreen=null; lbLevelInfo=null;

  lightboxModal.style.display = 'flex';
  updateLightboxTitle();

  // force manifest for full ladder
  (async () => {
    if ((!item.levels || item.levels.length < 2) && item.id) {
      try {
        const m = await getManifest(item.id);
        item.levels = m.levels || item.levels || [];
      } catch(e){}
    }

    // adaptive initial level
    let initLevel = null;
    const dpr = window.devicePixelRatio || 1;
    const tgt = Math.max(lbViewW, lbViewH) * dpr;

    if (item.levels && item.levels.length) {
      initLevel = chooseLevelForTarget(item.levels, 0, tgt) || item.levels[0];
    } else if (item.l0) {
      initLevel = {contenthash: item.l0.contenthash, w: item.l0.w, h: item.l0.h, size: Math.max(item.l0.w, item.l0.h)};
    }

    let seeded = false;
    // seed from LRU if exact level cached
    if (initLevel) {
      const hit = lbLRUGet(initLevel.contenthash);
      if (hit) {
        lbLevelPixels = new Uint8ClampedArray(hit.pixels);
        lbLevelInfo = {...initLevel, w: hit.w, h: hit.h};
        lbOffscreen = document.createElement('canvas');
        lbOffscreen.width = hit.w; lbOffscreen.height = hit.h;
        reapplyFilterToOffscreen();
        seeded = true;
      }
    }

    // seed from grid's painted canvas (the "already-cached L0/L1 grid thumbnail")
    if (!seeded) {
      const srcC = item.c1 || (item.card && item.card.querySelector('canvas'));
      if (srcC && initLevel) {
        const c2d = srcC.getContext('2d');
        const data = c2d.getImageData(0, 0, srcC.width, srcC.height).data;
        lbLevelPixels = new Uint8ClampedArray(data);
        lbLevelInfo = initLevel;
        lbOffscreen = document.createElement('canvas');
        lbOffscreen.width = srcC.width; lbOffscreen.height = srcC.height;
        reapplyFilterToOffscreen();
        seeded = true;
      }
    }

    if (initLevel && !seeded) {
      await loadLightboxLevel(initLevel);
    } else if (!initLevel) {
      lbLevelPixels = new Uint8ClampedArray(lbViewW * lbViewH * 4);
      lbLevelInfo = {w: lbViewW, h: lbViewH, size: Math.max(lbViewW, lbViewH), contenthash: 'fallback'};
      reapplyFilterToOffscreen();
    }

    redrawLightboxView();
    updateZoomReadout();

    // dual dispatcher: prefetch neighbors at lower priority (background/near)
    prefetchNeighbors(itemsList, idx);
  })();
}

let lightboxItemsList = [];
let lightboxCurrentIdx = 0;

function updateLightboxTitle() {
  if (!lightboxModal || !lightboxItem) return;
  const t = lightboxModal.querySelector('#lb-title');
  const l = lightboxModal.querySelector('#lb-level');
  if (t) t.textContent = `${(lightboxItem.id || '').slice(0,12)} (${lightboxCurrentIdx+1}/${lightboxItemsList.length})`;
  if (l && lbLevelInfo) {
    const s = lbLevelInfo.size || Math.max(lbLevelInfo.w||0, lbLevelInfo.h||0);
    l.textContent = `L${s}`;
  }
}

function navigateLightbox(delta) {
  if (!lightboxItemsList.length) return;
  const newIdx = (lightboxCurrentIdx + delta + lightboxItemsList.length) % lightboxItemsList.length;
  if (newIdx === lightboxCurrentIdx) return;
  // close current modal state but keep DOM
  lbLevelPixels = null;
  lbOffscreen = null;
  lbLevelInfo = null;
  openLightbox(lightboxItemsList, newIdx);
}

function prefetchNeighbors(itemsList, currentIdx) {
  if (!itemsList || !ctx) return;
  const prio = 'near';
  [-1, 1].forEach(d => {
    const ni = (currentIdx + d + itemsList.length) % itemsList.length;
    const nitem = itemsList[ni];
    if (!nitem || ni === currentIdx) return;
    // prefetch a small level (L0 or first) at low prio if not cached
    (async () => {
      let level = null;
      if (nitem.l0) level = {contenthash: nitem.l0.contenthash, w: nitem.l0.w, h: nitem.l0.h, size: Math.max(nitem.l0.w, nitem.l0.h)};
      else if (nitem.levels && nitem.levels[0]) level = nitem.levels[0];
      if (!level) return;
      if (lbLRUGet(level.contenthash)) return; // already have
      try {
        const bytes = await getLevelBytes(level.contenthash);
        const session = ctx.decode({format:'rgba8', sourceKey: level.contenthash, priority: prio, emitEveryPass:false, progressionTarget:'final'});
        await session.push(bytes); await session.close();
        let last = null;
        for await (const f of session.frames()) if (f?.pixels) last = f;
        if (last) {
          const px = packFramePixels(last);
          lbLRUSet(level.contenthash, px, last.info?.width || level.w, last.info?.height || level.h, level.size || Math.max(level.w, level.h));
        }
      } catch(e){}
    })();
  });
}

function closeLightbox() {
  if (lightboxModal) lightboxModal.style.display = 'none';
  lbLevelPixels = null;
  lbOffscreen = null;
  lightboxItem = null;
}

// wire clicks (after populate) - use extracted M2 lightbox
const origLoadLb = loadIndexAndSeed;
loadIndexAndSeed = async function() {
  await origLoadLb.apply(this, arguments);
  const lb = getPyramidLightbox();
  for (const [id, it] of items) {
    if (it.card && !it.card._lbWired) {
      it.card._lbWired = true;
      it.card.style.cursor = 'pointer';
      it.card.title = 'Click for M2 8-bit lightbox (FilterEngine + ladder + pan + LRU)';
      it.card.addEventListener('click', () => {
        const list = orderedIds.map(k => items.get(k));
        const i = orderedIds.indexOf(id);
        if (lb) lb.open(list, i);
      });
    }
  }
};