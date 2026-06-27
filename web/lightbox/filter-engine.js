// web/lightbox/filter-engine.js
// FilterEngine for M2 8-bit lightbox.
// Transcribed per pyramid-gallery-design.md and m2-checklist.md from CasaBio FilterEngine model.
// Self-contained, no external Android dep. Color matrix live preview for 8-bit canvas.
// Presets + sliders compose to final 3x4 matrix (r' = rr*r + rg*g + rb*b + ro, etc).
// For M2: global matrix sufficient for live 60fps preview (clarity/sharp/dehaze approximated or global).
// Full 16-bit + WebGL (float texture + shader) + local ops in M3. applyFloat provided for the 16-bit lightbox path.

export const ADJUSTMENT_PARAMS = [
  "brightness", "contrast", "saturation", "shadows", "highlights", "clarity", "dehaze", "sharpness"
];

export const LightboxPreset = {
  BW: "BW",
  BW_HIGH: "BW_HIGH",
  BW_SOFT: "BW_SOFT",
  SEPIA: "SEPIA",
  INVERT: "INVERT",
  BOTANICAL: "BOTANICAL",
  WARM: "WARM",
  COOL: "COOL",
  DEHAZE: "DEHAZE",
  BLUEPRINT: "BLUEPRINT",
  CHLOROPHYLL: "CHLOROPHYLL",
  NONE: "NONE",
};

export const APPROVED_LIGHTBOX_PRESETS = Object.values(LightboxPreset);

const PRESET_BASE = {
  [LightboxPreset.NONE]:       [1,0,0,0, 0,1,0,0, 0,0,1,0],
  [LightboxPreset.BW]:         [0.299,0.587,0.114,0, 0.299,0.587,0.114,0, 0.299,0.587,0.114,0],
  [LightboxPreset.BW_HIGH]:    [0.4,0.5,0.1,0, 0.4,0.5,0.1,0, 0.4,0.5,0.1,0], // crushed
  [LightboxPreset.BW_SOFT]:    [0.25,0.6,0.15,0, 0.25,0.6,0.15,0, 0.25,0.6,0.15,0],
  [LightboxPreset.SEPIA]:      [0.393,0.769,0.189,0, 0.349,0.686,0.168,0, 0.272,0.534,0.131,0],
  [LightboxPreset.INVERT]:     [-1,0,0,1, 0,-1,0,1, 0,0,-1,1],
  [LightboxPreset.BOTANICAL]:  [0.7,0.2,0.1,0, 0.1,1.1,0.1,0, 0.1,0.3,0.8,0], // green/yellow boost
  [LightboxPreset.WARM]:       [1.05,0.02,0.0,0, 0.02,0.95,0.0,0, 0.0,0.0,0.9,0],
  [LightboxPreset.COOL]:       [0.9,0.0,0.05,0, 0.0,0.95,0.05,0, 0.05,0.05,1.05,0],
  [LightboxPreset.DEHAZE]:     [1.1, -0.05, -0.05,0.02, -0.05,1.1,-0.05,0.02, -0.05,-0.05,1.1,0.02], // contrasty mid
  [LightboxPreset.BLUEPRINT]:  [0.1,0.2,0.7,0, 0.1,0.2,0.7,0, 0.3,0.4,0.9,0], // blue mono
  [LightboxPreset.CHLOROPHYLL]:[0.1,0.2,0.05,0, 0.2,1.3,0.1,0, 0.05,0.3,0.6,0], // extreme green
};

function clamp(v, lo=0, hi=1) { return Math.max(lo, Math.min(hi, v)); }

function compose(m1, m2) {
  // m1 post * m2 (row vector style, 3x4)
  const o = new Array(12);
  for (let r=0; r<3; r++) {
    for (let c=0; c<3; c++) {
      o[r*4 + c] = m1[r*4+0]*m2[0*4+c] + m1[r*4+1]*m2[1*4+c] + m1[r*4+2]*m2[2*4+c];
    }
    o[r*4 + 3] = m1[r*4+0]*m2[0*4+3] + m1[r*4+1]*m2[1*4+3] + m1[r*4+2]*m2[2*4+3] + m1[r*4+3];
  }
  return o;
}

function scaleContrast(m, factor) {
  const o = m.slice();
  const off = 0.5 * (1 - factor);
  for (let r=0; r<3; r++) {
    for (let c=0; c<3; c++) o[r*4+c] *= factor;
    o[r*4+3] = o[r*4+3] * factor + off;
  }
  return o;
}

function addBrightness(m, amt) {
  const o = m.slice();
  o[3] += amt; o[7] += amt; o[11] += amt;
  return o;
}

function adjustSaturation(m, factor) {
  // standard sat matrix around luma
  const l = [0.299, 0.587, 0.114];
  const o = new Array(12).fill(0);
  for (let r=0; r<3; r++) {
    for (let c=0; c<3; c++) {
      const s = (r === c ? factor : 0);
      o[r*4 + c] = s + (1 - factor) * l[c];
    }
    o[r*4 + 3] = 0; // pure linear sat; compose(m,o) carries m's bias through exactly once
  }
  return compose(m, o); // or direct
  // simpler: post compose sat on current
}

export function createFilterEngine(initialPreset = LightboxPreset.NONE) {
  let preset = initialPreset;
  const params = {
    brightness: 0, contrast: 0, saturation: 0,
    shadows: 0, highlights: 0, clarity: 0, dehaze: 0, sharpness: 0
  };

  function getBaseMatrix() {
    if (!APPROVED_LIGHTBOX_PRESETS.includes(preset)) {
      throw new Error(`Unsupported preset: ${preset}`);
    }
    return (PRESET_BASE[preset] || PRESET_BASE[LightboxPreset.NONE]).slice();
  }

  function getMatrix() {
    let m = getBaseMatrix();

    // brightness (global offset, matrix friendly)
    m = addBrightness(m, params.brightness / 100);

    // contrast (global scale around 0.5)
    const cf = 1 + params.contrast / 100;
    m = scaleContrast(m, cf);

    // saturation (color only)
    const sf = 1 + params.saturation / 100;
    m = adjustSaturation(m, sf);

    // clarity/dehaze/sharp - global contrast-ish for M2 8-bit preview (matrix)
    // (real local ops deferred or approximated; M3 16-bit/WebGL can do better)
    const cl = 1 + (params.clarity + params.dehaze) / 200;
    m = scaleContrast(m, cl);

    const sh2 = 1 + params.sharpness / 300;
    m = scaleContrast(m, sh2);

    return m;
  }

  function applyToImageData(srcData, dstData = null) {
    const m = getMatrix();
    const s = srcData.data;
    const w = srcData.width, h = srcData.height;
    const d = new Uint8ClampedArray(s.length);

    // shadows (0..+100%): lift darks (non-linear, more in shadows)
    const sh = Math.max(0, params.shadows / 100);
    // highlights (-100..0%): compress brights (non-linear, more in highlights)
    const hi = Math.min(0, params.highlights / 100); // negative or 0

    for (let i = 0; i < s.length; i += 4) {
      let r = s[i] / 255, g = s[i+1]/255, b = s[i+2]/255;

      // color matrix first (presets + sat + brightness/contrast/clarity approx)
      let nr = m[0]*r + m[1]*g + m[2]*b + m[3];
      let ng = m[4]*r + m[5]*g + m[6]*b + m[7];
      let nb = m[8]*r + m[9]*g + m[10]*b + m[11];

      // tone ops (shadows/highlights) - per-pixel for better 8-bit preview
      // luma for masking
      const l = 0.299 * nr + 0.587 * ng + 0.114 * nb;

      // shadows lift: add more to dark areas
      if (sh > 0) {
        const lift = sh * (1 - l); // stronger in shadows
        nr += lift; ng += lift; nb += lift;
      }

      // highlights compress: pull down bright areas (hi is <=0)
      if (hi < 0) {
        const comp = hi * l; // stronger pull on brights (hi negative)
        nr += comp; ng += comp; nb += comp;
      }

      d[i]   = clamp(nr * 255, 0, 255) | 0;
      d[i+1] = clamp(ng * 255, 0, 255) | 0;
      d[i+2] = clamp(nb * 255, 0, 255) | 0;
      d[i+3] = s[i+3];
    }
    return new ImageData(d, w, h);
  }

  function computeHistogram(pixels /* Uint8Clamped or ImageData.data */) {
    const hist = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256) };
    for (let i=0; i<pixels.length; i+=4) {
      const r = pixels[i]|0, g=pixels[i+1]|0, b=pixels[i+2]|0;
      hist.r[r]++; hist.g[g]++; hist.b[b]++;
      const l = (0.299*r + 0.587*g + 0.114*b) | 0;
      hist.l[l]++;
    }
    return hist;
  }

  // Float version for 16-bit (M3) path / demo. Input/output Float32 0-1 (premultiplied alpha ignored for simplicity).
  function applyFloat(srcF, w, h) {
    const m = getMatrix();
    const out = new Float32Array(srcF.length);
    const sh = Math.max(0, params.shadows / 100);
    const hi = Math.min(0, params.highlights / 100);
    for (let i = 0; i < srcF.length; i += 4) {
      let r = srcF[i], g = srcF[i+1], b = srcF[i+2];
      let nr = m[0]*r + m[1]*g + m[2]*b + m[3];
      let ng = m[4]*r + m[5]*g + m[6]*b + m[7];
      let nb = m[8]*r + m[9]*g + m[10]*b + m[11];
      const l = 0.299 * nr + 0.587 * ng + 0.114 * nb;
      if (sh > 0) {
        const lift = sh * (1 - l);
        nr += lift; ng += lift; nb += lift;
      }
      if (hi < 0) {
        const comp = hi * l;
        nr += comp; ng += comp; nb += comp;
      }
      out[i] = nr; out[i+1] = ng; out[i+2] = nb; out[i+3] = srcF[i+3] ?? 1;
    }
    return out;
  }

  return {
    setPreset(p) {
      if (!APPROVED_LIGHTBOX_PRESETS.includes(p)) throw new Error(`Unsupported preset: ${p}`);
      preset = p;
    },
    getPreset() { return preset; },
    setParam(k, v) {
      if (!ADJUSTMENT_PARAMS.includes(k)) throw new Error(`bad param ${k}`);
      // clamp per spec ranges (normalized -1..1 or 0..1 but we use % -100..100)
      params[k] = Math.max(-100, Math.min(100, v));
    },
    getParams() { return {...params}; },
    getMatrix,
    applyToImageData,
    applyFloat,
    computeHistogram,
    reset() {
      preset = LightboxPreset.NONE;
      for (const k of ADJUSTMENT_PARAMS) params[k] = 0;
    }
  };
}

// For direct use
export function applyFilter(pixels, preset, params) {
  const eng = createFilterEngine(preset);
  for (const [k,v] of Object.entries(params)) eng.setParam(k, v);
  const src = pixels instanceof ImageData ? pixels : new ImageData(pixels, 1, 1); // assume data
  // caller should pass proper ImageData
  return eng.applyToImageData(src);
}

// ---------------------------------------------------------------------------
// Restored matrix API (recovered from d3d28fa5). 20-element 4x5 Android-style
// ColorMatrix (offset at 5n+4 in 0..255 scale). Consumed by webgl-pipeline.js
// (matrixUniforms reads indices 0,1,2 / 5,6,7 / 10,11,12; offsets 4,9,14; /255)
// and the tauri-parity lightbox path. Kept additive — createFilterEngine and
// its (different-signature) engine-method computeHistogram remain unchanged.
// ---------------------------------------------------------------------------

const RANGES = {
  brightness: [-100, 100],
  contrast: [-100, 100],
  saturation: [-100, 100],
  shadows: [0, 100],
  highlights: [-100, 0],
  clarity: [0, 100],
  dehaze: [0, 100],
  sharpness: [0, 100],
};

function clampRange(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function clampAdjustments(raw = {}) {
  const out = {};
  for (const key of ADJUSTMENT_PARAMS) {
    const [min, max] = RANGES[key];
    const v = raw[key] ?? 0;
    out[key] = clampRange(v, min, max);
  }
  return out;
}

function baseMatrix(preset) {
  switch (preset) {
    case 'BW':
      return [0.299, 0.587, 0.114, 0, 0, 0.299, 0.587, 0.114, 0, 0, 0.299, 0.587, 0.114, 0, 0, 0, 0, 0, 1, 0];
    case 'BW_HIGH':
      return [0.35, 0.55, 0.1, 0, -20, 0.35, 0.55, 0.1, 0, -20, 0.35, 0.55, 0.1, 0, -20, 0, 0, 0, 1, 0];
    case 'BW_SOFT':
      return [0.28, 0.59, 0.13, 0, 15, 0.28, 0.59, 0.13, 0, 15, 0.28, 0.59, 0.13, 0, 15, 0, 0, 0, 1, 0];
    case 'SEPIA':
      return [0.393, 0.769, 0.189, 0, 0, 0.349, 0.686, 0.168, 0, 0, 0.272, 0.534, 0.131, 0, 0, 0, 0, 0, 1, 0];
    case 'INVERT':
      return [-1, 0, 0, 0, 255, 0, -1, 0, 0, 255, 0, 0, -1, 0, 255, 0, 0, 0, 1, 0];
    case 'BOTANICAL':
      return [0.9, 0.1, 0, 0, 0, 0.1, 1.1, 0.1, 0, 0, 0, 0.2, 0.8, 0, 0, 0, 0, 0, 1, 0];
    case 'WARM':
      return [1.1, 0.05, 0, 0, 8, 0, 1, 0, 0, 4, 0, 0, 0.9, 0, 0, 0, 0, 0, 1, 0];
    case 'COOL':
      return [0.9, 0, 0.05, 0, 0, 0, 1, 0.05, 0, 0, 0.05, 0.1, 1.15, 0, 0, 0, 0, 0, 1, 0];
    case 'DEHAZE':
      return [1.08, 0, 0, 0, -6, 0, 1.08, 0, 0, -6, 0, 0, 1.08, 0, -6, 0, 0, 0, 1, 0];
    case 'BLUEPRINT':
      return [0.1, 0.2, 0.9, 0, 0, 0.05, 0.15, 0.85, 0, 0, 0.05, 0.15, 0.85, 0, 0, 0, 0, 0, 1, 0];
    case 'CHLOROPHYLL':
      return [0.2, 0.8, 0.2, 0, 0, 0.1, 1.2, 0.1, 0, 0, 0.1, 0.8, 0.2, 0, 0, 0, 0, 0, 1, 0];
    case 'NONE':
    default:
      return [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
  }
}

export function buildColorMatrix(preset, adjustments = {}) {
  if (!APPROVED_LIGHTBOX_PRESETS.includes(preset)) {
    throw new Error(`unsupported preset: ${preset}`);
  }
  const adj = clampAdjustments(adjustments);
  const m = [...baseMatrix(preset)];
  const bright = 1 + adj.brightness / 100;
  const contrast = 1 + adj.contrast / 100;
  const sat = 1 + adj.saturation / 100;
  for (let i = 0; i < 3; i++) {
    m[i * 5] *= contrast * sat * bright;
    m[i * 5 + 1] *= contrast * sat * bright;
    m[i * 5 + 2] *= contrast * sat * bright;
    m[i * 5 + 4] += adj.dehaze * 0.2 + adj.clarity * 0.15;
  }
  return m;
}

/** Apply 5×4 color matrix to RGBA8 buffer in place (alpha preserved). */
export function applyColorMatrixInPlace(rgba, width, height, matrix) {
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    rgba[o] = clampRange(r * matrix[0] + g * matrix[1] + b * matrix[2] + matrix[4], 0, 255);
    rgba[o + 1] = clampRange(r * matrix[5] + g * matrix[6] + b * matrix[7] + matrix[9], 0, 255);
    rgba[o + 2] = clampRange(r * matrix[10] + g * matrix[11] + b * matrix[12] + matrix[14], 0, 255);
  }
}

/** Luma-masked shadow lift + highlight compress (8-bit preview path). */
export function applyToneMapInPlace(rgba, width, height, shadows = 0, highlights = 0) {
  if (shadows === 0 && highlights === 0) return;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const luma = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
    const shadowMask = luma < 128 ? (128 - luma) / 128 : 0;
    const highlightMask = luma > 192 ? (luma - 192) / 63 : 0;
    for (let c = 0; c < 3; c++) {
      let v = rgba[o + c];
      v += shadows * 0.6 * shadowMask;
      v += highlights * 0.5 * highlightMask;
      rgba[o + c] = clampRange(v, 0, 255);
    }
  }
}

/**
 * Standalone 4-arg histogram (recovered). Distinct from the engine-method
 * computeHistogram(pixels) returned by createFilterEngine — this module-level
 * export takes (rgba, width, height, bins) and bins into `bins` buckets.
 */
export function computeHistogram(rgba, width, height, bins = 64) {
  const r = new Uint32Array(bins);
  const g = new Uint32Array(bins);
  const b = new Uint32Array(bins);
  const y = new Uint32Array(bins);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const ri = (rgba[o] * bins) >> 8;
    const gi = (rgba[o + 1] * bins) >> 8;
    const bi = (rgba[o + 2] * bins) >> 8;
    const yi = (((rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8) * bins) >> 8;
    r[ri]++;
    g[gi]++;
    b[bi]++;
    y[yi]++;
  }
  return { r, g, b, y, bins };
}