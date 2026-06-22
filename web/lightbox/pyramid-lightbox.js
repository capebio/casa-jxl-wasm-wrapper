// web/lightbox/pyramid-lightbox.js
// Extracted M2 8-bit lightbox component for the pyramid gallery.
// Satisfies the M2 checklist (zoom ladder, canvas pan w/ transform only, adaptive level,
// live zoom readout, monotonic LRU, dual-prio via scheduler, FilterEngine parity, live visible hist).
// 
// IMPORTANT (per design §7 and M2 checklist):
// - This is the **8-bit** lightbox path.
// - FilterEngine runs on 8-bit for live canvas color-matrix preview (fast, no re-decode).
// - The 16-bit toggle (decode16 → WebGL float texture + shader FilterEngine adjust (headroom) → WebGL shader dither (Bayer/FS approx) → 8-bit display)
//   is M3. The stub is now wired with full WebGL implementation (when supported) for viable 16-bit in the demo lightbox. JS fallback if no WebGL2/float.
// - Seeding must use already-cached grid tile pixels when possible (zero extra decode).
// - All decodes go through the caller's ctx.decode with sourceKey (scheduler reuse, no ad-hoc layer).
// - No dependency on the external Android CplusplusTest path.

import { createFilterEngine, LightboxPreset, APPROVED_LIGHTBOX_PRESETS, ADJUSTMENT_PARAMS } from './filter-engine.js';

export function createPyramidLightbox(deps) {
  const {
    ctx,                    // jxl context from createBrowserContext
    getLevelBytes,          // from grid (supports baseUrl or fileMap)
    chooseLevelForTarget,   // pure helper
    getManifest,            // for per-image full levels list
    packFramePixels,        // helper
    log = console.log,      // optional
  } = deps;

  if (!ctx || !getLevelBytes || !chooseLevelForTarget) {
    throw new Error('pyramid-lightbox requires ctx, getLevelBytes, chooseLevelForTarget');
  }

  let eng = null;
  let modal = null;
  let canvas = null;
  let histC = null;
  let itemsList = [];
  let currentIdx = 0;
  let item = null;

  const VIEW_W = 600;
  const VIEW_H = 400;

  let zoom = 1.0;
  let panX = 0;
  let panY = 0;
  let levelInfo = null;      // {contenthash, w, h, size}
  let levelPixels = null;    // raw Uint8Clamped
  let offscreen = null;      // adjusted level canvas
  let isPanning = false;
  let lastMouse = {x:0, y:0};
  let crossfade = 0;
  let is16bitMode = false;

  // LRU (monotonic)
  const LRU = new Map();
  const LRU_MAX = 8;
  function lruGet(ch) {
    const h = LRU.get(ch);
    if (h) { h.lastUsed = performance.now(); return h; }
    return null;
  }
  function lruSet(ch, pixels, w, h, sz) {
    if (LRU.has(ch)) LRU.delete(ch);
    LRU.set(ch, {pixels, w, h, lastUsed: performance.now(), size: sz});
    if (LRU.size > LRU_MAX) {
      let oldK = null, oldT = Infinity;
      for (const [k,v] of LRU) if (v.lastUsed < oldT) { oldT = v.lastUsed; oldK = k; }
      if (oldK) LRU.delete(oldK);
    }
  }

  // WebGL for 16-bit float texture + shader FilterEngine + dither (M3 path)
  let gl = null;
  let glProgram = null;
  let glPosBuffer = null;
  let glTex = null;
  let glCurrentW = 0, glCurrentH = 0;
  let glLocs = {};

  const glVS = `#version 300 es
in vec4 a_position;
void main() {
  gl_Position = a_position;
}
`;

  const glFS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_levelSize;
uniform vec2 u_pan;
uniform float u_zoom;
uniform vec4 u_color0;
uniform vec4 u_color1;
uniform vec4 u_color2;
uniform float u_shadows;
uniform float u_highlights;
out vec4 fragColor;

float bayer4x4(int x, int y) {
  float m[16];
  m[0]=0.; m[1]=8.; m[2]=2.; m[3]=10.;
  m[4]=12.; m[5]=4.; m[6]=14.; m[7]=6.;
  m[8]=3.; m[9]=11.; m[10]=1.; m[11]=9.;
  m[12]=15.; m[13]=7.; m[14]=13.; m[15]=5.;
  return m[x + y*4] / 16.0;
}

void main() {
  vec2 pixel = gl_FragCoord.xy;
  vec2 src = (pixel - u_pan) / u_zoom;
  vec2 uv = src / u_levelSize;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0);
    return;
  }
  vec3 c = texture(u_tex, uv).rgb;

  // color matrix
  vec3 ac = vec3(
    dot(u_color0.xyz, c) + u_color0.w,
    dot(u_color1.xyz, c) + u_color1.w,
    dot(u_color2.xyz, c) + u_color2.w
  );

  float l = dot(ac, vec3(0.299, 0.587, 0.114));

  // shadows / highlights (per pixel tone, matching JS applyFloat)
  if (u_shadows > 0.0) {
    float lift = u_shadows * (1.0 - l);
    ac += lift;
  }
  if (u_highlights < 0.0) {
    float comp = u_highlights * l;
    ac += comp;
  }

  // Bayer ordered dither (WebGL shader approx to FS for single pass; real sequential FS in wgpu/compute)
  vec2 dpos = mod(gl_FragCoord.xy, 4.0);
  int di = int(dpos.x) + int(dpos.y) * 4;
  float thresh = bayer4x4(int(dpos.x), int(dpos.y));
  vec3 q = floor(ac * 255.0 + thresh) / 255.0;
  fragColor = vec4(q, 1.0);
}
`;

  function createShader(type, source) {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      log('GL shader error: ' + gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  function createProgram(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      log('GL program error: ' + gl.getProgramInfoLog(p));
      return null;
    }
    return p;
  }

  function initWebGL() {
    if (gl && glProgram) return true;
    if (!gl) {
      gl = canvas.getContext('webgl2', { alpha: true, antialias: false, preserveDrawingBuffer: false });
    }
    if (!gl) {
      log('WebGL2 not available for 16-bit path, using JS fallback');
      return false;
    }
    const vs = createShader(gl.VERTEX_SHADER, glVS);
    const fs = createShader(gl.FRAGMENT_SHADER, glFS);
    if (!vs || !fs) return false;
    glProgram = createProgram(vs, fs);
    if (!glProgram) return false;

    // full screen quad
    const pos = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
    glPosBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glPosBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(glProgram, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    glLocs.tex = gl.getUniformLocation(glProgram, 'u_tex');
    glLocs.levelSize = gl.getUniformLocation(glProgram, 'u_levelSize');
    glLocs.pan = gl.getUniformLocation(glProgram, 'u_pan');
    glLocs.zoom = gl.getUniformLocation(glProgram, 'u_zoom');
    glLocs.color0 = gl.getUniformLocation(glProgram, 'u_color0');
    glLocs.color1 = gl.getUniformLocation(glProgram, 'u_color1');
    glLocs.color2 = gl.getUniformLocation(glProgram, 'u_color2');
    glLocs.shadows = gl.getUniformLocation(glProgram, 'u_shadows');
    glLocs.highlights = gl.getUniformLocation(glProgram, 'u_highlights');

    gl.useProgram(glProgram);
    gl.uniform1i(glLocs.tex, 0);

    glTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return true;
  }

  function uploadGLTexture(data, w, h, isFloat) {
    if (!gl) return;
    gl.bindTexture(gl.TEXTURE_2D, glTex);
    const intFmt = isFloat ? gl.RGBA32F : gl.RGBA;
    const type = isFloat ? gl.FLOAT : gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, intFmt, w, h, 0, gl.RGBA, type, data);
    glCurrentW = w;
    glCurrentH = h;
  }

  function renderGL() {
    if (!gl || !glProgram || !levelPixels || !levelInfo) return false;
    initWebGL();
    if (!gl) return false;

    const isFloat = !!(levelPixels && levelPixels.BYTES_PER_ELEMENT === 4); // Float32Array
    if (glCurrentW !== levelInfo.w || glCurrentH !== levelInfo.h) {
      uploadGLTexture(levelPixels, levelInfo.w, levelInfo.h, isFloat);
    }

    gl.useProgram(glProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glTex);

    gl.uniform2f(glLocs.levelSize, levelInfo.w, levelInfo.h);
    gl.uniform2f(glLocs.pan, panX, panY);
    gl.uniform1f(glLocs.zoom, zoom);

    const m = eng.getMatrix();
    gl.uniform4f(glLocs.color0, m[0], m[1], m[2], m[3]);
    gl.uniform4f(glLocs.color1, m[4], m[5], m[6], m[7]);
    gl.uniform4f(glLocs.color2, m[8], m[9], m[10], m[11]);

    const p = eng.getParams();
    gl.uniform1f(glLocs.shadows, p.shadows / 100);
    gl.uniform1f(glLocs.highlights, p.highlights / 100);

    gl.viewport(0, 0, VIEW_W, VIEW_H);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // read dithered u8 for display/hist (small size, acceptable for demo)
    const u8 = new Uint8Array(VIEW_W * VIEW_H * 4);
    gl.readPixels(0, 0, VIEW_W, VIEW_H, gl.RGBA, gl.UNSIGNED_BYTE, u8);

    // put to the (WebGL) canvas is already done by the draw; the canvas is the WebGL one now.
    // but to keep the 2D hist and compatibility, we can put to a 2D if needed, but since context is WebGL, the draw is on canvas.
    // For hist, use the u8.
    const hctx = histC.getContext('2d');
    hctx.fillStyle = '#111'; hctx.fillRect(0,0,256,70);
    const hst = eng.computeHistogram ? eng.computeHistogram(u8) : {l: new Uint32Array(256)};
    // simple draw hist
    const maxv = Math.max(1, ...hst.l);
    hctx.strokeStyle = '#0f0';
    hctx.beginPath();
    for (let x=0; x<256; x++) {
      const y = (hst.l[x] / maxv) * 68;
      if (x===0) hctx.moveTo(x, 69-y); else hctx.lineTo(x, 69-y);
    }
    hctx.stroke();

    updateReadouts();
    return true;
  }

  function ensureDOM() {
    if (modal) return;
    modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:9999;display:none;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div style="background:#111;color:#ddd;padding:8px;border-radius:4px;max-width:96vw;max-height:96vh;overflow:auto;">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;font:12px monospace;">
          <button id="plb-close">Close</button>
          <button id="plb-prev">‹</button>
          <span id="plb-title"></span>
          <span id="plb-level"></span>
          <span id="plb-zoom" style="margin-left:auto;">100%</span>
          <button id="plb-zoom-out">-</button>
          <button id="plb-zoom-in">+</button>
          <button id="plb-reset-zoom">1:1</button>
          <button id="plb-next">›</button>
          <label style="margin-left:12px;font-size:10px;opacity:0.7;" title="16-bit (M3): decode 16-bit level → WebGL float texture + shader FilterEngine (matrix + tone for shadows/highlights headroom) → FS dither shader → 8-bit. Toggle for effect (JS fallback slow; WebGL fast). Source 16-bit data untouched.">
            <input id="plb-16bit" type="checkbox"> 16-bit (M3)
          </label>
        </div>
        <canvas id="plb-canvas" width="${VIEW_W}" height="${VIEW_H}" style="border:1px solid #333;image-rendering:pixelated;cursor:grab;"></canvas>
        <canvas id="plb-hist" width="256" height="70" style="border:1px solid #333;display:block;margin-top:4px;"></canvas>
        <div id="plb-presets" style="display:flex;flex-wrap:wrap;gap:2px;margin:4px 0;"></div>
        <div id="plb-sliders"></div>
        <div style="margin-top:4px;">
          <button id="plb-upgrade">Upgrade level (ladder)</button>
          <button id="plb-reset">Reset adjustments</button>
        </div>
      </div>`;

    document.body.appendChild(modal);

    canvas = modal.querySelector('#plb-canvas');
    histC = modal.querySelector('#plb-hist');

    // WebGL2 for 16-bit (M3) float + shader dither path. Falls back to JS if unavailable.
    gl = canvas.getContext('webgl2', { alpha: true, antialias: false });
    if (!gl) {
      log('WebGL2 not available; 16-bit uses slow JS path');
    }

    modal.querySelector('#plb-close').onclick = close;
    modal.onclick = (e) => { if (e.target === modal) close(); };

    // zoom
    modal.querySelector('#plb-zoom-in').onclick = () => changeZoom(1.25);
    modal.querySelector('#plb-zoom-out').onclick = () => changeZoom(0.8);
    modal.querySelector('#plb-reset-zoom').onclick = () => { zoom=1; panX=0; panY=0; redraw(); updateReadouts(); };

    // nav
    const prev = modal.querySelector('#plb-prev');
    const next = modal.querySelector('#plb-next');
    if (prev) prev.onclick = () => navigate(-1);
    if (next) next.onclick = () => navigate(1);

    // 16-bit path (M3, wired for demo even if slower)
    const sixteen = modal.querySelector('#plb-16bit');
    if (sixteen) {
      sixteen.disabled = false;
      sixteen.title = '16-bit decode (rgba16) + float adjust (JS for demo) + dither to 8-bit canvas. Slower than 8-bit matrix path. Shows full headroom for shadows/highlights on high-DR RAW. 16-bit source data integrity preserved (M2 never mutates the pyramid levels).';
      sixteen.onchange = () => {
        is16bitMode = sixteen.checked;
        reloadCurrentLevelForMode().catch(e => console.error('16bit reload', e));
      };
    }

    // pan
    const cvs = canvas;
    cvs.addEventListener('mousedown', (e) => { isPanning=true; lastMouse={x:e.clientX,y:e.clientY}; cvs.style.cursor='grabbing'; });
    window.addEventListener('mouseup', () => { isPanning=false; if (cvs) cvs.style.cursor='grab'; });
    window.addEventListener('mousemove', (e) => {
      if (!isPanning || !modal || modal.style.display==='none') return;
      const dx = e.clientX - lastMouse.x;
      const dy = e.clientY - lastMouse.y;
      panX += dx / zoom;
      panY += dy / zoom;
      lastMouse = {x:e.clientX, y:e.clientY};
      clampPan();
      redraw();
    });
    cvs.addEventListener('dblclick', () => changeZoom(1.5));
    cvs.addEventListener('wheel', (e) => { e.preventDefault(); changeZoom(e.deltaY < 0 ? 1.15 : 1/1.15); }, {passive:false});

    // presets
    const pdiv = modal.querySelector('#plb-presets');
    for (const p of APPROVED_LIGHTBOX_PRESETS) {
      const b = document.createElement('button');
      b.textContent = p; b.style.fontSize = '10px';
      b.onclick = () => { eng.setPreset(p); reapplyAndRedraw(); };
      pdiv.appendChild(b);
    }

    // sliders
    const sdiv = modal.querySelector('#plb-sliders');
    for (const k of ADJUSTMENT_PARAMS) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:4px;font:11px monospace;';
      row.innerHTML = `<label style="width:70px;">${k}</label><input type="range" min="-100" max="100" step="1" value="0"><span style="width:30px;text-align:right;">0</span>`;
      const inp = row.querySelector('input');
      const val = row.querySelector('span');
      inp.oninput = () => { val.textContent = inp.value; eng.setParam(k, +inp.value); reapplyAndRedraw(); };
      sdiv.appendChild(row);
    }

    modal.querySelector('#plb-reset').onclick = () => {
      eng.reset();
      sdiv.querySelectorAll('input').forEach(i => { i.value=0; i.nextElementSibling.textContent='0'; });
      reapplyAndRedraw();
    };
    modal.querySelector('#plb-upgrade').onclick = upgradeLevel;

    // keyboard (global while open)
    document.addEventListener('keydown', (e) => {
      if (!modal || modal.style.display === 'none') return;
      if (e.key === 'Escape') close();
      if (e.key === '+' || e.key === '=') changeZoom(1.2);
      if (e.key === '-') changeZoom(1/1.2);
      if (e.key === 'ArrowLeft') { e.preventDefault(); navigate(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); navigate(1); }
      if (zoom > 1) {
        if (e.key === 'ArrowUp') { panY += 20 / zoom; redraw(); }
        if (e.key === 'ArrowDown') { panY -= 20 / zoom; redraw(); }
      }
    });
  }

  function updateReadouts() {
    if (!modal) return;
    const z = modal.querySelector('#plb-zoom');
    if (z) z.textContent = Math.round(zoom * 100) + '%';
    const l = modal.querySelector('#plb-level');
    if (l && levelInfo) {
      const s = levelInfo.size || Math.max(levelInfo.w || 0, levelInfo.h || 0);
      l.textContent = `L${s}`;
    }
    const t = modal.querySelector('#plb-title');
    if (t) t.textContent = `${(item?.id || '').slice(0,12)} (${currentIdx+1}/${itemsList.length})`;
  }

  async function reloadCurrentLevelForMode() {
    if (!item || !levelInfo) return;
    // re-pick a level for current display size, preferring the mode's bit depth
    const dpr = window.devicePixelRatio || 1;
    const needed = Math.max(VIEW_W, VIEW_H) * zoom * dpr;
    let cands = item.levels || [];
    if (is16bitMode) {
      const has16 = cands.some(l => l.bitsPerSample === 16);
      if (has16) cands = cands.filter(l => l.bitsPerSample === 16 || !l.bitsPerSample);
    } else {
      cands = cands.filter(l => (l.bitsPerSample || 8) === 8);
    }
    const targetLevel = chooseLevelForTarget(cands, 0, needed) || cands[0] || levelInfo;
    if (targetLevel) {
      await loadLevel(targetLevel);
    }
  }

  function clampPan() {
    if (!levelInfo || zoom <= 0) return;
    const imgW = (levelInfo.w || VIEW_W) * zoom;
    const imgH = (levelInfo.h || VIEW_H) * zoom;
    const slack = 80;
    const maxX = Math.max(0, (imgW - VIEW_W)/2 + slack);
    const maxY = Math.max(0, (imgH - VIEW_H)/2 + slack);
    panX = Math.max(-maxX, Math.min(maxX, panX));
    panY = Math.max(-maxY, Math.min(maxY, panY));
  }

  // Basic dither for demo 16-bit path (real M3 uses better FS/WebGL).
  // Direct quant for speed; artifacts possible but sufficient to see headroom effect.
  function ditherFloatToU8(f, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < f.length; i += 4) {
      out[i]   = clamp(Math.round(f[i] * 255), 0, 255);
      out[i+1] = clamp(Math.round(f[i+1] * 255), 0, 255);
      out[i+2] = clamp(Math.round(f[i+2] * 255), 0, 255);
      out[i+3] = 255;
    }
    return out;
  }

  function changeZoom(f) {
    const old = zoom;
    zoom = Math.max(0.1, Math.min(8, zoom * f));
    const cx = VIEW_W/2, cy = VIEW_H/2;
    panX = (panX - cx) * (zoom / old) + cx;
    panY = (panY - cy) * (zoom / old) + cy;
    clampPan();
    updateReadouts();
    redraw();
    maybeAutoUpgrade();
  }

  function maybeAutoUpgrade() {
    if (!item?.levels || !levelInfo) return;
    const needed = Math.max(VIEW_W, VIEW_H) * zoom * (window.devicePixelRatio || 1);
    let cands = item.levels || [];
    if (is16bitMode) {
      const has16 = cands.some(l => l.bitsPerSample === 16);
      if (has16) cands = cands.filter(l => l.bitsPerSample === 16);
    } else {
      cands = cands.filter(l => (l.bitsPerSample || 8) === 8);
    }
    if (cands.length === 0) cands = item.levels || [];
    const up = chooseLevelForTarget(cands, levelInfo.size || levelInfo.w || 0, needed);
    if (up && up.contenthash !== levelInfo.contenthash) {
      loadLevel(up).catch(()=>{});
    }
  }

  async function loadLevel(entry) {
    if (!entry || !item) return;
    const use16 = is16bitMode;
    log?.(`plb load ${entry.size || entry.w} ch=${entry.contenthash.slice(0,8)} ${use16 ? '16bit' : '8bit'}`);

    const bytes = await getLevelBytes(entry.contenthash);
    if (!ctx) throw new Error('no ctx for decode');

    const format = use16 ? 'rgbaf32' : 'rgba8';
    const session = ctx.decode({
      format,
      sourceKey: entry.contenthash,   // scheduler dedupe / monotonic
      priority: 'visible',
      emitEveryPass: false,
      progressionTarget: 'final'
    });
    await session.push(bytes);
    await session.close();

    let last = null;
    for await (const f of session.frames()) if (f?.pixels) last = f;
    if (!last) return;

    let raw;
    let bits = 8;
    if (use16) {
      raw = last.pixels; // Float32Array 0-1 from rgbaf32
      bits = 16;
    } else {
      raw = packFramePixels(last);
    }
    levelPixels = raw;
    levelInfo = {
      contenthash: entry.contenthash,
      w: last.info?.width || entry.w,
      h: last.info?.height || entry.h,
      size: entry.size || Math.max(entry.w, entry.h),
      bitsPerSample: bits
    };

    offscreen = document.createElement('canvas');
    offscreen.width = levelInfo.w;
    offscreen.height = levelInfo.h;
    reapplyToOffscreen();

    // crossfade
    crossfade = 1.0;
    const st = performance.now();
    const d = 180;
    const step = () => {
      const t = Math.min(1, (performance.now() - st) / d);
      crossfade = 1 - t;
      redraw();
      if (crossfade > 0.01) requestAnimationFrame(step);
      else { crossfade = 0; redraw(); }
    };
    requestAnimationFrame(step);

    if (zoom > 1) { /* keep center */ }
    redraw();
    updateReadouts();

    if (!use16) {
      lruSet(entry.contenthash, raw, levelInfo.w, levelInfo.h, levelInfo.size);
    }
  }

  function reapplyToOffscreen() {
    if (!offscreen || !levelPixels || !eng) return;
    if (gl && levelInfo && levelInfo.bitsPerSample === 16) {
      // WebGL path handles adjust + dither on redraw using levelPixels texture; no CPU offscreen needed
      return;
    }
    if (levelInfo && levelInfo.bitsPerSample === 16) {
      // JS fallback 16-bit
      const f = new Float32Array(levelPixels.length);
      for (let i = 0; i < levelPixels.length; i++) f[i] = levelPixels[i] / 65535.0;
      const adjF = eng.applyFloat(f, levelInfo.w, levelInfo.h);
      const u8 = ditherFloatToU8(adjF, levelInfo.w, levelInfo.h);
      offscreen.getContext('2d').putImageData(new ImageData(u8, levelInfo.w, levelInfo.h), 0, 0);
    } else {
      const src = new ImageData(new Uint8ClampedArray(levelPixels), offscreen.width, offscreen.height);
      const adj = eng.applyToImageData(src);
      offscreen.getContext('2d').putImageData(adj, 0, 0);
    }
  }

  function reapplyAndRedraw() {
    reapplyToOffscreen();
    redraw();
  }

  function redraw() {
    if (!canvas || !eng || !histC) return;

    // Prefer WebGL for 16-bit (and 8-bit when available): float texture + shader adjust + shader dither
    if (gl && levelInfo && levelPixels) {
      if (renderGL()) {
        return;
      }
    }

    // 2D fallback (no gl)
    const c2 = canvas.getContext('2d', {alpha: true});
    if (!c2) return;
    c2.fillStyle = '#111';
    c2.fillRect(0, 0, VIEW_W, VIEW_H);

    if (offscreen && levelPixels) {
      c2.save();
      c2.translate(panX, panY);
      c2.scale(zoom, zoom);
      if (crossfade > 0) c2.globalAlpha = 1 - crossfade;
      c2.drawImage(offscreen, 0, 0);
      c2.restore();
    } else if (levelPixels) {
      const src = new ImageData(new Uint8ClampedArray(levelPixels), VIEW_W, VIEW_H);
      const adj = eng.applyToImageData(src);
      c2.putImageData(adj, 0, 0);
    }

    // visible screen histogram (readback)
    const h2 = histC.getContext('2d');
    h2.fillStyle = '#111'; h2.fillRect(0,0,256,70);
    try {
      const vid = c2.getImageData(0, 0, VIEW_W, VIEW_H);
      const hst = eng.computeHistogram(vid.data);
      const mv = Math.max(1, ...hst.l);
      h2.strokeStyle = '#0f0'; h2.beginPath();
      for (let x=0; x<256; x++) {
        const y = (hst.l[x] / mv) * 68;
        if (x===0) h2.moveTo(x, 69-y); else h2.lineTo(x, 69-y);
      }
      h2.stroke();
    } catch (e) {
      if (offscreen) {
        const o2 = offscreen.getContext('2d');
        const id = o2.getImageData(0,0,offscreen.width, offscreen.height);
        const hst = eng.computeHistogram(id.data);
        const mv = Math.max(1, ...hst.l);
        h2.strokeStyle = '#0f0'; h2.beginPath();
        for (let x=0; x<256; x++) {
          const y = (hst.l[x] / mv) * 68;
          if (x===0) h2.moveTo(x, 69-y); else h2.lineTo(x, 69-y);
        }
        h2.stroke();
      }
    }

    updateReadouts();
  }


  async function upgradeLevel() {
    if (!item?.levels?.length || !levelInfo) return;
    const need = Math.max(VIEW_W, VIEW_H) * zoom * (window.devicePixelRatio || 1) * 1.1;
    const up = chooseLevelForTarget(item.levels, levelInfo.size || levelInfo.w || 0, need);
    if (up && up.contenthash !== levelInfo.contenthash) {
      await loadLevel(up);
    }
  }

  function navigate(d) {
    if (!itemsList.length) return;
    const ni = (currentIdx + d + itemsList.length) % itemsList.length;
    if (ni === currentIdx) return;
    levelPixels = null; offscreen = null; levelInfo = null;
    open(itemsList, ni);
  }

  async function prefetchNeighbors(list, cidx) {
    if (!list || !ctx) return;
    [-1,1].forEach(dd => {
      const ni = (cidx + dd + list.length) % list.length;
      const niItem = list[ni];
      if (!niItem || ni === cidx) return;
      (async () => {
        let lv = niItem.l0 ? {contenthash: niItem.l0.contenthash, w:niItem.l0.w, h:niItem.l0.h, size: Math.max(niItem.l0.w,niItem.l0.h)} : (niItem.levels && niItem.levels[0]);
        if (!lv || lruGet(lv.contenthash)) return;
        try {
          const b = await getLevelBytes(lv.contenthash);
          const s = ctx.decode({format:'rgba8', sourceKey:lv.contenthash, priority:'near', emitEveryPass:false, progressionTarget:'final'});
          await s.push(b); await s.close();
          let last = null;
          for await (const f of s.frames()) if (f?.pixels) last = f;
          if (last) {
            const px = packFramePixels(last);
            lruSet(lv.contenthash, px, last.info?.width||lv.w, last.info?.height||lv.h, lv.size||Math.max(lv.w,lv.h));
          }
        } catch(e){}
      })();
    });
  }

  function updateTitle() {
    if (!modal) return;
    const t = modal.querySelector('#plb-title');
    const l = modal.querySelector('#plb-level');
    if (t) t.textContent = `${(item?.id || '').slice(0,12)} (${currentIdx+1}/${itemsList.length})`;
    if (l && levelInfo) {
      const s = levelInfo.size || Math.max(levelInfo.w||0, levelInfo.h||0);
      l.textContent = `L${s}`;
    }
  }

  async function open(allItems, startIdx = 0) {
    ensureDOM();
    itemsList = Array.isArray(allItems) ? allItems : [allItems];
    currentIdx = startIdx | 0;
    item = itemsList[currentIdx];
    if (!item) return;

    eng = createFilterEngine(LightboxPreset.NONE);
    zoom = 1; panX = 0; panY = 0; crossfade = 0; levelPixels = null; offscreen = null; levelInfo = null;

    modal.style.display = 'flex';
    updateTitle();
    const sixteen = modal ? modal.querySelector('#plb-16bit') : null;
    if (sixteen) sixteen.checked = is16bitMode;

    // force manifest
    if ((!item.levels || item.levels.length < 2) && item.id && getManifest) {
      try {
        const m = await getManifest(item.id);
        item.levels = m.levels || item.levels || [];
      } catch (e) {}
    }

    const dpr = window.devicePixelRatio || 1;
    const tgt = Math.max(VIEW_W, VIEW_H) * dpr;

    let init = null;
    if (item.levels?.length) {
      init = chooseLevelForTarget(item.levels, 0, tgt) || item.levels[0];
    } else if (item.l0) {
      init = {contenthash: item.l0.contenthash, w: item.l0.w, h: item.l0.h, size: Math.max(item.l0.w, item.l0.h)};
    }

    let seeded = false;

    // LRU first
    if (init) {
      const hit = lruGet(init.contenthash);
      if (hit) {
        levelPixels = new Uint8ClampedArray(hit.pixels);
        levelInfo = {contenthash: init.contenthash, w: hit.w, h: hit.h, size: hit.size};
        offscreen = document.createElement('canvas');
        offscreen.width = hit.w; offscreen.height = hit.h;
        reapplyToOffscreen();
        seeded = true;
      }
    }

    // Seed from the grid card's currently painted canvas (the cached thumbnail)
    if (!seeded) {
      const srcC = item.c1 || (item.card && item.card.querySelector('canvas'));
      if (srcC && init) {
        const c2d = srcC.getContext('2d');
        const data = c2d.getImageData(0,0,srcC.width, srcC.height).data;
        levelPixels = new Uint8ClampedArray(data);
        levelInfo = init;
        offscreen = document.createElement('canvas');
        offscreen.width = srcC.width; offscreen.height = srcC.height;
        reapplyToOffscreen();
        seeded = true;
      }
    }

    if (init && !seeded) {
      await loadLevel(init);
    } else if (!seeded) {
      levelPixels = new Uint8ClampedArray(VIEW_W * VIEW_H * 4);
      levelInfo = {w: VIEW_W, h: VIEW_H, size: Math.max(VIEW_W, VIEW_H), contenthash: 'fallback'};
      offscreen = document.createElement('canvas');
      offscreen.width = VIEW_W; offscreen.height = VIEW_H;
      reapplyToOffscreen();
    }

    redraw();
    updateTitle();

    // prefetch neighbors (dual priority)
    prefetchNeighbors(itemsList, currentIdx);
  }

  function close() {
    if (modal) modal.style.display = 'none';
    // keep LRU and last state for monotonicity on re-open
  }

  // expose minimal API
  return {
    open,
    close,
    // for grid wiring if needed
    _internal: { /* for debug only */ }
  };
}