import { APPROVED_LIGHTBOX_PRESETS, ADJUSTMENT_PARAMS } from '../../packages/jxl-pyramid/dist/constants.js';

const PRESET_SET = new Set(APPROVED_LIGHTBOX_PRESETS);

/** @typedef {{ brightness?: number; contrast?: number; saturation?: number; shadows?: number; highlights?: number; clarity?: number; dehaze?: number; sharpness?: number }} Adjustments */

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

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function clampAdjustments(raw = {}) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const key of ADJUSTMENT_PARAMS) {
    const [min, max] = RANGES[key];
    const v = raw[key] ?? 0;
    out[key] = clamp(v, min, max);
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
  if (!PRESET_SET.has(preset)) {
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
    rgba[o] = clamp(r * matrix[0] + g * matrix[1] + b * matrix[2] + matrix[4], 0, 255);
    rgba[o + 1] = clamp(r * matrix[5] + g * matrix[6] + b * matrix[7] + matrix[9], 0, 255);
    rgba[o + 2] = clamp(r * matrix[10] + g * matrix[11] + b * matrix[12] + matrix[14], 0, 255);
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
      rgba[o + c] = clamp(v, 0, 255);
    }
  }
}

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