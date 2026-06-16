# Perceptual Lens + Colour Probe + Global Selector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightbox "Perceptual Lens" that homogenises vegetation under changing light, a click colour-probe that reads a pixel's illumination-normalised diagnostic colour, and a global colour-range selector that highlights that colour everywhere (Ctrl+click to accumulate).

**Architecture:** All colour maths lives in a pure, DOM-free ESM module `web/perceptual-color.js` (unit-tested with `node --test`). The lightbox (`web/main.js`, `web/index.html`) is a thin consumer: a display-only post-process on the canvas (never touches the decode cache, like the Straighten tool), plus a selection overlay canvas. Opponent space is CIELAB for v1, behind operator functions so XYB/Rust can swap in later.

**Tech Stack:** Vanilla JS (ES modules), Canvas 2D, `node --test` (or `bun test`) for unit tests. No new runtime deps.

**Spec:** `docs/superpowers/specs/2026-06-11-perceptual-lens-colour-probe-design.md`. Honesty rules: never raise global exposure; off by default; report numbers and let the user confirm in the viewer.

---

## File structure

| File | Responsibility |
|---|---|
| `web/perceptual-color.js` (new) | Pure maths: colour-space conversions, von Kries, Φ damping, the five operators, lightness compression, `applyLens`, selection functions, `probe`. No DOM. |
| `web/perceptual-color.test.mjs` (new) | `node --test` unit tests for every pure function. |
| `web/main.js` (modify) | Lens + selection state; `applyPerceptualLens()`; `refreshSelectionOverlay()`; unified click/Ctrl-click handler; hooks into the existing draw path. |
| `web/index.html` (modify) | Lens control group, readout, selection overlay `<canvas>`. |
| existing lightbox stylesheet (modify) | Minimal styles for the control group + overlay. |

Tasks 1–6 build and fully unit-test the pure core. Tasks 7–9 wire it into the lightbox (canvas/DOM — verified manually in-app, with exact code given). Task 10 is the validation checklist.

**Convention for tests:** `node --test web/perceptual-color.test.mjs` (Node 18+). If node errors with `Unexpected token 'export'` / `Cannot use import statement`, the repo's `package.json` lacks `"type":"module"` for a `.js` under `web/` — use **`bun test web/perceptual-color.test.mjs`** (bun handles ESM `.js` natively; `bun.lock` is present), or rename the module to `web/perceptual-color.mjs` and update the `import` in `main.js`. Float comparisons use a helper `close(a,b,eps)`.

---

## Task 0: Branch

**Files:** none (git).

- [ ] **Step 1: Create a feature branch off main**

```bash
git checkout main
git pull --ff-only
git checkout -b perceptual-colour-lens
```

Expected: now on `perceptual-colour-lens`. (If `main` is not the integration base in this repo, branch off the agreed base instead.)

---

## Task 1: Colour-space conversions (sRGB ↔ linear ↔ XYZ ↔ Lab ↔ LMS)

**Files:**
- Create: `web/perceptual-color.js`
- Test: `web/perceptual-color.test.mjs`

- [ ] **Step 1: Write the failing round-trip tests**

```js
// web/perceptual-color.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  srgbToLinear, linearToSrgb,
  linearRgbToXyz, xyzToLinearRgb,
  xyzToLab, labToXyz,
  xyzToLms, lmsToXyz,
} from './perceptual-color.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const vclose = (A, B, eps = 1e-6) => A.every((x, i) => close(x, B[i], eps));

test('srgb<->linear round-trips', () => {
  for (const c of [0, 0.02, 0.04045, 0.2, 0.5, 1]) {
    assert.ok(close(linearToSrgb(srgbToLinear(c)), c, 1e-6), `c=${c}`);
  }
});

test('linearRgb<->xyz round-trips', () => {
  const rgb = [0.2, 0.6, 0.4];
  assert.ok(vclose(xyzToLinearRgb(linearRgbToXyz(rgb)), rgb, 1e-6));
});

test('xyz<->lab round-trips', () => {
  const xyz = linearRgbToXyz([0.3, 0.5, 0.7]);
  assert.ok(vclose(labToXyz(xyzToLab(xyz)), xyz, 1e-6));
});

test('xyz<->lms (bradford) round-trips', () => {
  const xyz = linearRgbToXyz([0.3, 0.5, 0.7]);
  assert.ok(vclose(lmsToXyz(xyzToLms(xyz)), xyz, 1e-6));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test web/perceptual-color.test.mjs`
Expected: FAIL — cannot find module `./perceptual-color.js` / exports undefined.

- [ ] **Step 3: Implement the conversions**

```js
// web/perceptual-color.js
// Pure, DOM-free colour maths. Opponent space = CIELAB (D65) for v1.

// --- sRGB transfer function (component in [0,1]) ---
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(l) {
  const v = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return Math.min(1, Math.max(0, v));
}

// --- linear sRGB <-> XYZ (D65) ---
export function linearRgbToXyz([r, g, b]) {
  return [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
    0.0193339 * r + 0.1191920 * g + 0.9503041 * b,
  ];
}
export function xyzToLinearRgb([x, y, z]) {
  return [
     3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.9692660 * x + 1.8760108 * y + 0.0415560 * z,
     0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
}

// --- XYZ <-> CIELAB (D65 white) ---
export const D65_XYZ = [0.95047, 1.0, 1.08883];
const DELTA = 6 / 29;
const fLab = (t) => (t > DELTA ** 3 ? Math.cbrt(t) : t / (3 * DELTA * DELTA) + 4 / 29);
const fLabInv = (t) => (t > DELTA ? t ** 3 : 3 * DELTA * DELTA * (t - 4 / 29));

export function xyzToLab([x, y, z]) {
  const fx = fLab(x / D65_XYZ[0]), fy = fLab(y / D65_XYZ[1]), fz = fLab(z / D65_XYZ[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function labToXyz([L, a, b]) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  return [D65_XYZ[0] * fLabInv(fx), D65_XYZ[1] * fLabInv(fy), D65_XYZ[2] * fLabInv(fz)];
}

// --- XYZ <-> LMS (Bradford cone response, for chromatic adaptation) ---
export function xyzToLms([x, y, z]) {
  return [
     0.8951 * x + 0.2664 * y - 0.1614 * z,
    -0.7502 * x + 1.7135 * y + 0.0367 * z,
     0.0389 * x - 0.0685 * y + 1.0296 * z,
  ];
}
export function lmsToXyz([l, m, s]) {
  return [
     0.9869929 * l - 0.1470543 * m + 0.1599627 * s,
     0.4323053 * l + 0.5183603 * m + 0.0492912 * s,
    -0.0085287 * l + 0.0400428 * m + 0.9684867 * s,
  ];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test web/perceptual-color.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/perceptual-color.js web/perceptual-color.test.mjs
git commit -m "feat(perceptual-color): sRGB/XYZ/Lab/LMS conversions + round-trip tests"
```

---

## Task 2: von Kries adaptation + scene-white estimate

**Files:**
- Modify: `web/perceptual-color.js`
- Test: `web/perceptual-color.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
// append to web/perceptual-color.test.mjs
import { vonKriesAdapt, estimateSceneWhiteLms, CANONICAL_WHITE_LMS, srgbU8ToLinear } from './perceptual-color.js';

test('vonKriesAdapt sigma=0 is identity', () => {
  const lms = [0.4, 0.5, 0.6];
  assert.ok(vclose(vonKriesAdapt(lms, [0.3, 0.5, 0.9], 0), lms, 1e-9));
});

test('vonKriesAdapt neutralises a cast (sigma=1 maps scene white to canonical)', () => {
  const sceneWhite = [0.6, 0.5, 0.3]; // warm cast
  const adaptedWhite = vonKriesAdapt(sceneWhite, sceneWhite, 1);
  assert.ok(vclose(adaptedWhite, CANONICAL_WHITE_LMS, 1e-9));
});

test('estimateSceneWhiteLms on a flat grey image ~ that grey in LMS', () => {
  const w = 4, h = 4, rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i*4]=180; rgba[i*4+1]=180; rgba[i*4+2]=180; rgba[i*4+3]=255; }
  const white = estimateSceneWhiteLms(rgba, w, h);
  const g = srgbU8ToLinear(180);
  const expect = xyzToLms(linearRgbToXyz([g, g, g]));
  assert.ok(vclose(white, expect, 1e-3));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test web/perceptual-color.test.mjs`
Expected: FAIL — `vonKriesAdapt` / `estimateSceneWhiteLms` not exported.

- [ ] **Step 3: Implement**

```js
// append to web/perceptual-color.js
export const CANONICAL_WHITE_LMS = xyzToLms(D65_XYZ);
export const srgbU8ToLinear = (u8) => srgbToLinear(u8 / 255);

// LMS' = LMS * lerp(1, canonical/scene, sigma)  (von Kries diagonal adaptation)
export function vonKriesAdapt(lms, sceneWhiteLms, sigma) {
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const g = CANONICAL_WHITE_LMS[i] / Math.max(sceneWhiteLms[i], 1e-6);
    out[i] = lms[i] * ((1 - sigma) + sigma * g);
  }
  return out;
}

// Scene white = blend of gray-world mean LMS and the mean LMS of the brightest non-clipped ~2%.
export function estimateSceneWhiteLms(rgbaU8, w, h) {
  const n = w * h;
  const lumas = new Float32Array(n);
  let meanX = 0, meanY = 0, meanZ = 0, count = 0;
  const xyzs = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = srgbU8ToLinear(rgbaU8[i*4]), g = srgbU8ToLinear(rgbaU8[i*4+1]), b = srgbU8ToLinear(rgbaU8[i*4+2]);
    const [X, Y, Z] = linearRgbToXyz([r, g, b]);
    xyzs[i*3] = X; xyzs[i*3+1] = Y; xyzs[i*3+2] = Z; lumas[i] = Y;
    const clipped = rgbaU8[i*4] >= 254 || rgbaU8[i*4+1] >= 254 || rgbaU8[i*4+2] >= 254;
    if (!clipped) { meanX += X; meanY += Y; meanZ += Z; count++; }
  }
  count = Math.max(count, 1);
  const grayWorld = [meanX / count, meanY / count, meanZ / count];

  // brightest non-clipped ~2% by luminance
  const idx = Array.from({ length: n }, (_, i) => i)
    .filter((i) => !(rgbaU8[i*4] >= 254 || rgbaU8[i*4+1] >= 254 || rgbaU8[i*4+2] >= 254))
    .sort((a, b) => lumas[b] - lumas[a]);
  const topN = Math.max(1, Math.floor(idx.length * 0.02));
  let bX = 0, bY = 0, bZ = 0;
  for (let k = 0; k < topN; k++) { const i = idx[k]; bX += xyzs[i*3]; bY += xyzs[i*3+1]; bZ += xyzs[i*3+2]; }
  const bright = [bX / topN, bY / topN, bZ / topN];

  const blendXyz = [0.5*grayWorld[0]+0.5*bright[0], 0.5*grayWorld[1]+0.5*bright[1], 0.5*grayWorld[2]+0.5*bright[2]];
  return xyzToLms(blendXyz).map((v) => Math.max(v, 1e-4));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test web/perceptual-color.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/perceptual-color.js web/perceptual-color.test.mjs
git commit -m "feat(perceptual-color): von Kries adaptation + scene-white estimate"
```

---

## Task 3: Φ chroma damping + the five operators

**Files:**
- Modify: `web/perceptual-color.js`
- Test: `web/perceptual-color.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
// append to web/perceptual-color.test.mjs
import { phi, dampChroma, neutralOf, hueClassOf, saturationOf, lightnessOf, phiDampedDistance } from './perceptual-color.js';

test('phi is concave, monotonic, phi(0)=0, slope~1 at 0', () => {
  assert.ok(close(phi(0), 0, 1e-9));
  assert.ok(phi(10) > phi(5) && phi(40) > phi(20));         // monotonic
  assert.ok((phi(40) - phi(30)) < (phi(20) - phi(10)));     // concave (diminishing)
  assert.ok(close(phi(0.001) / 0.001, 1, 1e-2));            // slope ~1 near 0
});

test('dampChroma sigma=0 identity; preserves hue', () => {
  const lab = [50, 30, -40];
  assert.ok(vclose(Object.values(dampChroma(...lab, 0, {})), lab, 1e-9));
  const d = dampChroma(50, 30, -40, 1, {});
  assert.ok(close(Math.atan2(d.b, d.a), Math.atan2(-40, 30), 1e-9)); // hue angle unchanged
});

test('operators', () => {
  assert.deepEqual(neutralOf([50, 30, -40]), [50, 0, 0]);
  assert.ok(close(hueClassOf([50, 30, -40]), Math.atan2(-40, 30) * 180 / Math.PI, 1e-9));
  assert.ok(close(saturationOf([50, 30, -40]), phi(Math.hypot(30, -40)), 1e-9));
  assert.equal(lightnessOf([50, 30, -40]), 50);
});

test('phiDampedDistance: identity 0, symmetric, sub-linear, hue-sensitive', () => {
  assert.ok(close(phiDampedDistance([50,0,0],[50,0,0]), 0, 1e-9));
  const d = phiDampedDistance([50,10,0],[50,0,10]);
  assert.ok(d > 0);
  assert.equal(d, phiDampedDistance([50,0,10],[50,10,0]));   // symmetric
  // sub-linear: distance for 2x gap < 2x distance for 1x gap
  const d1 = phiDampedDistance([50,0,0],[50,20,0]);
  const d2 = phiDampedDistance([50,0,0],[50,40,0]);
  assert.ok(d2 < 2 * d1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test web/perceptual-color.test.mjs`
Expected: FAIL — operators not exported.

- [ ] **Step 3: Implement**

```js
// append to web/perceptual-color.js
export const C_KNEE = 30; // Lab chroma units where compression bites (tunable)

// concave diminishing-returns curve: phi(0)=0, phi'(0)=1, saturating
export function phi(c, cKnee = C_KNEE) { return cKnee * Math.log(1 + c / cKnee); }

// dampChroma: c' = lerp(c, phi(c), sigma); scale (a,b) to new chroma, hue preserved
export function dampChroma(L, a, b, sigma, { cKnee = C_KNEE } = {}) {
  const c = Math.hypot(a, b);
  if (c < 1e-9) return { L, a, b };
  const cOut = (1 - sigma) * c + sigma * phi(c, cKnee);
  const k = cOut / c;
  return { L, a: a * k, b: b * k };
}

// --- the five canonical operators (Lab implementation for v1) ---
export const neutralOf = ([L]) => [L, 0, 0];
export const hueClassOf = ([, a, b]) => Math.atan2(b, a) * 180 / Math.PI;
export const saturationOf = ([, a, b]) => phi(Math.hypot(a, b));
export const lightnessOf = ([L]) => L;
export function phiDampedDistance(labA, labB) {
  const d = Math.hypot(labA[0]-labB[0], labA[1]-labB[1], labA[2]-labB[2]);
  return phi(d);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test web/perceptual-color.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/perceptual-color.js web/perceptual-color.test.mjs
git commit -m "feat(perceptual-color): Phi damping + five canonical operators"
```

---

## Task 4: Shoulder-aware lightness compression + lightness stats

**Files:**
- Modify: `web/perceptual-color.js`
- Test: `web/perceptual-color.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
// append to web/perceptual-color.test.mjs
import { compressLightness, estimateLightnessStats } from './perceptual-color.js';

test('compressLightness sigma=0 identity', () => {
  assert.equal(compressLightness(70, { Lmid: 50, Lshoulder: 80, k: 0.3 }, 0), 70);
});

test('compressLightness never brightens the top shoulder', () => {
  // L above Lmid but in shoulder -> pulled DOWN toward mid, never up
  const out = compressLightness(85, { Lmid: 50, Lshoulder: 80, k: 0.3 }, 1);
  assert.ok(out <= 85);
});

test('compressLightness reduces spread (shadows lifted toward mid)', () => {
  const st = { Lmid: 50, Lshoulder: 80, k: 0.3 };
  const lo = compressLightness(20, st, 1);
  assert.ok(lo > 20 && lo < 50); // lifted toward mid, not past it
});

test('estimateLightnessStats returns median + 85th pct', () => {
  const w = 10, h = 1, rgba = new Uint8ClampedArray(w*h*4);
  for (let i=0;i<w;i++){ const v=i*25; rgba[i*4]=v; rgba[i*4+1]=v; rgba[i*4+2]=v; rgba[i*4+3]=255; }
  const st = estimateLightnessStats(rgba, w, h);
  assert.ok(st.Lmid > 0 && st.Lshoulder >= st.Lmid && st.Lshoulder <= 100);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test web/perceptual-color.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

```js
// append to web/perceptual-color.js
// shoulder -> 1 below Lshoulder (compress), -> 0 toward white (protect highlights)
function shoulder(L, Lshoulder) {
  if (L <= Lshoulder) return 1;
  return Math.max(0, 1 - (L - Lshoulder) / (100 - Lshoulder + 1e-6));
}
// pull L toward Lmid by k*sigma, weighted by shoulder. Highlights only ever move DOWN.
export function compressLightness(L, { Lmid, Lshoulder, k = 0.3 }, sigma) {
  return L - sigma * k * (L - Lmid) * shoulder(L, Lshoulder);
}

export function estimateLightnessStats(rgbaU8, w, h) {
  const n = w * h, Ls = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = srgbU8ToLinear(rgbaU8[i*4]), g = srgbU8ToLinear(rgbaU8[i*4+1]), b = srgbU8ToLinear(rgbaU8[i*4+2]);
    Ls[i] = xyzToLab(linearRgbToXyz([r, g, b]))[0];
  }
  const sorted = Array.from(Ls).sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(n - 1, Math.floor(p * n))];
  return { Lmid: pct(0.5), Lshoulder: pct(0.85), k: 0.3 };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test web/perceptual-color.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/perceptual-color.js web/perceptual-color.test.mjs
git commit -m "feat(perceptual-color): shoulder-aware lightness compression"
```

---

## Task 5: `applyLens` orchestrator (with σ=0 no-op guarantee)

**Files:**
- Modify: `web/perceptual-color.js`
- Test: `web/perceptual-color.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
// append to web/perceptual-color.test.mjs
import { applyLens } from './perceptual-color.js';

function randImage(w, h) {
  const rgba = new Uint8ClampedArray(w*h*4);
  for (let i=0;i<w*h;i++){ rgba[i*4]=(i*37)%256; rgba[i*4+1]=(i*91)%256; rgba[i*4+2]=(i*53)%256; rgba[i*4+3]=255; }
  return rgba;
}

test('applyLens sigma=0 is a no-op (within rounding)', () => {
  const w=8,h=8,src=randImage(w,h);
  const out=applyLens(src,w,h,{strength:0,lightness:true});
  for (let i=0;i<src.length;i++) assert.ok(Math.abs(out[i]-src[i])<=1, `i=${i}`);
});

test('applyLens preserves alpha and dimensions', () => {
  const w=8,h=8,src=randImage(w,h);
  const out=applyLens(src,w,h,{strength:1,lightness:true});
  assert.equal(out.length, src.length);
  for (let i=0;i<w*h;i++) assert.equal(out[i*4+3], 255);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test web/perceptual-color.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

```js
// append to web/perceptual-color.js
// Lens render: sRGB -> linear -> XYZ -> LMS -> von Kries -> Lab -> damp chroma + compress L -> sRGB.
export function applyLens(rgbaU8, w, h, { strength = 1, lightness = true, cKnee = C_KNEE } = {}) {
  const sigma = strength;
  const out = new Uint8ClampedArray(rgbaU8.length);
  const sceneWhite = estimateSceneWhiteLms(rgbaU8, w, h);
  const Lstats = estimateLightnessStats(rgbaU8, w, h);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const r = srgbU8ToLinear(rgbaU8[i*4]), g = srgbU8ToLinear(rgbaU8[i*4+1]), b = srgbU8ToLinear(rgbaU8[i*4+2]);
    const lms = vonKriesAdapt(xyzToLms(linearRgbToXyz([r, g, b])), sceneWhite, sigma);
    let lab = xyzToLab(lmsToXyz(lms));
    const dc = dampChroma(lab[0], lab[1], lab[2], sigma, { cKnee });
    let L = lightness ? compressLightness(dc.L, Lstats, sigma) : dc.L;
    const [R, G, B] = xyzToLinearRgb(labToXyz([L, dc.a, dc.b]));
    out[i*4]   = Math.round(linearToSrgb(R) * 255);
    out[i*4+1] = Math.round(linearToSrgb(G) * 255);
    out[i*4+2] = Math.round(linearToSrgb(B) * 255);
    out[i*4+3] = rgbaU8[i*4+3];
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test web/perceptual-color.test.mjs`
Expected: PASS. (σ=0 no-op tolerance ≤1 absorbs round-trip rounding.)

- [ ] **Step 5: Commit**

```bash
git add web/perceptual-color.js web/perceptual-color.test.mjs
git commit -m "feat(perceptual-color): applyLens orchestrator with sigma=0 no-op"
```

---

## Task 6: Selection core + probe (`normalizedLabBuffer`, `selectByColour`, `unionMask`, `maskBorder`, `maskCoverage`, `probe`)

**Files:**
- Modify: `web/perceptual-color.js`
- Test: `web/perceptual-color.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
// append to web/perceptual-color.test.mjs
import { normalizedLabBuffer, selectByColour, unionMask, maskBorder, maskCoverage, probe } from './perceptual-color.js';

function twoColourImage(w, h) {
  // left half colour A, right half colour B
  const rgba = new Uint8ClampedArray(w*h*4);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){ const i=y*w+x; const left=x<w/2;
    rgba[i*4]=left?200:40; rgba[i*4+1]=left?40:180; rgba[i*4+2]=left?40:60; rgba[i*4+3]=255; }
  return rgba;
}

test('normalizedLabBuffer length and finite', () => {
  const w=6,h=6,rgba=twoColourImage(w,h);
  const white=estimateSceneWhiteLms(rgba,w,h);
  const buf=normalizedLabBuffer(rgba,w,h,white);
  assert.equal(buf.length, 3*w*h);
  assert.ok(buf.every(Number.isFinite));
});

test('selectByColour picks the matching half; tolerance grows the mask', () => {
  const w=8,h=8,rgba=twoColourImage(w,h);
  const white=estimateSceneWhiteLms(rgba,w,h);
  const buf=normalizedLabBuffer(rgba,w,h,white);
  const seed=[buf[0],buf[1],buf[2]]; // colour A (top-left)
  const m1=selectByColour(buf,w,h,seed,5);
  const m2=selectByColour(buf,w,h,seed,500);
  const c1=maskCoverage(m1).fraction, c2=maskCoverage(m2).fraction;
  assert.ok(c1 > 0 && c1 < 0.6);       // ~the A half, not everything
  assert.ok(c2 >= c1);                  // tolerance up -> mask grows
});

test('unionMask and maskBorder', () => {
  const w=4,h=4; const a=new Uint8Array(w*h), b=new Uint8Array(w*h);
  a[0]=1; b[15]=1;
  const u=unionMask(a,b); assert.equal(u[0],1); assert.equal(u[15],1);
  // solid 2x2 block border = all 4 cells (each touches an empty neighbour)
  const m=new Uint8Array(w*h); m[5]=m[6]=m[9]=m[10]=1;
  const bd=maskBorder(m,w,h);
  assert.equal(bd[5]+bd[6]+bd[9]+bd[10], 4);
});

test('probe returns operator readout', () => {
  const w=8,h=8,rgba=twoColourImage(w,h);
  const white=estimateSceneWhiteLms(rgba,w,h);
  const buf=normalizedLabBuffer(rgba,w,h,white);
  const r=probe(buf,w,h,1,1,1);
  assert.ok(typeof r.hueDeg==='number' && typeof r.lightness==='number' && r.dampedSaturation>=0);
});

test('illuminant convergence (spec test 8): two casts of one scene converge after normalisation', () => {
  const w=8,h=8;
  // scene = white reference (top half) + coloured patch (bottom half)
  const base=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x;const top=y<h/2;
    base[i*4]=top?230:150; base[i*4+1]=top?230:90; base[i*4+2]=top?230:90; base[i*4+3]=255;}
  const cast=(img,kr,kg,kb)=>{const o=new Uint8ClampedArray(img.length);
    for(let i=0;i<img.length;i+=4){o[i]=Math.min(255,img[i]*kr);o[i+1]=Math.min(255,img[i+1]*kg);o[i+2]=Math.min(255,img[i+2]*kb);o[i+3]=255;}return o;};
  const warm=cast(base,1.0,0.85,0.7), cool=cast(base,0.8,0.9,1.0);
  const patchAb=(img)=>{ const white=estimateSceneWhiteLms(img,w,h); const buf=normalizedLabBuffer(img,w,h,white);
    let a=0,b=0,c=0; for(let y=h/2;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x;a+=buf[i*3+1];b+=buf[i*3+2];c++;} return [a/c,b/c];};
  const d=Math.hypot(patchAb(warm)[0]-patchAb(cool)[0], patchAb(warm)[1]-patchAb(cool)[1]);
  assert.ok(d < 10, `patch colour converges across casts after von-Kries normalisation (got ${d.toFixed(2)})`);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test web/perceptual-color.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

```js
// append to web/perceptual-color.js
// per-pixel von-Kries-normalised Lab (the intrinsic colour buffer both tools share)
export function normalizedLabBuffer(rgbaU8, w, h, sceneWhiteLms) {
  const n = w * h, buf = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = srgbU8ToLinear(rgbaU8[i*4]), g = srgbU8ToLinear(rgbaU8[i*4+1]), b = srgbU8ToLinear(rgbaU8[i*4+2]);
    const lms = vonKriesAdapt(xyzToLms(linearRgbToXyz([r, g, b])), sceneWhiteLms, 1);
    const lab = xyzToLab(lmsToXyz(lms));
    buf[i*3] = lab[0]; buf[i*3+1] = lab[1]; buf[i*3+2] = lab[2];
  }
  return buf;
}

export function selectByColour(labBuf, w, h, seedLab, tolerance) {
  const n = w * h, mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const lab = [labBuf[i*3], labBuf[i*3+1], labBuf[i*3+2]];
    if (phiDampedDistance(lab, seedLab) <= tolerance) mask[i] = 1;
  }
  return mask;
}

export function unionMask(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] || b[i]) ? 1 : 0;
  return out;
}

export function maskBorder(mask, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y*w + x;
    if (!mask[i]) continue;
    const up = y>0 && mask[i-w], dn = y<h-1 && mask[i+w], lf = x>0 && mask[i-1], rt = x<w-1 && mask[i+1];
    if (!(up && dn && lf && rt)) out[i] = 1; // touches an unselected/edge neighbour
  }
  return out;
}

export function maskCoverage(mask) {
  let count = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) count++;
  return { fraction: count / Math.max(mask.length, 1), regionCount: count }; // regionCount = pixel count (v1)
}

// patch-mean probe over labBuf -> operator readout
export function probe(labBuf, w, h, x, y, radius = 3) {
  let L=0,a=0,b=0,c=0;
  for (let dy=-radius; dy<=radius; dy++) for (let dx=-radius; dx<=radius; dx++) {
    const px=x+dx, py=y+dy; if (px<0||py<0||px>=w||py>=h) continue;
    const i=py*w+px; L+=labBuf[i*3]; a+=labBuf[i*3+1]; b+=labBuf[i*3+2]; c++;
  }
  const lab=[L/c, a/c, b/c];
  return { hueDeg: hueClassOf(lab), chroma: Math.hypot(lab[1],lab[2]), dampedSaturation: saturationOf(lab), lightness: lightnessOf(lab) };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test web/perceptual-color.test.mjs`
Expected: PASS (all tests across Tasks 1–6).

- [ ] **Step 5: Commit**

```bash
git add web/perceptual-color.js web/perceptual-color.test.mjs
git commit -m "feat(perceptual-color): selection core (labBuf, select, union, border, coverage) + probe"
```

---

## Task 7: Lightbox UI — control group + readout + overlay canvas

**Files:**
- Modify: `web/index.html`
- Modify: existing lightbox stylesheet (the CSS file the lightbox uses; find via the `<link rel="stylesheet">` in `index.html`)

> Integration task — verified manually in-app. Find the lightbox controls container in `index.html` (where the existing look sliders / Straighten control live) and add the markup below inside it. Place the overlay canvas as a sibling of `lightboxCanvas`, absolutely positioned over it.

- [ ] **Step 1: Add the control group markup**

```html
<!-- Perceptual Lens controls — place alongside existing lightbox look controls -->
<div id="pl-controls" class="pl-controls" hidden>
  <label class="pl-row"><input type="checkbox" id="pl-toggle"> Perceptual Lens</label>
  <label class="pl-row">Strength <input type="range" id="pl-strength" min="0" max="100" value="100"></label>
  <label class="pl-row"><input type="checkbox" id="pl-lightness" checked> Lightness compression</label>
  <label class="pl-row">Tolerance <input type="range" id="pl-tolerance" min="1" max="60" value="12"></label>
  <button type="button" id="pl-clear">Clear selection</button>
  <div id="pl-readout" class="pl-readout">click a colour</div>
</div>
```

- [ ] **Step 2: Add the selection overlay canvas as a sibling of the lightbox canvas**

```html
<!-- immediately after the existing <canvas id="lightboxCanvas">, same stacking container -->
<canvas id="pl-overlay" class="pl-overlay" hidden></canvas>
```

- [ ] **Step 3: Add minimal CSS to the lightbox stylesheet**

```css
.pl-controls { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.pl-row { display: flex; align-items: center; gap: 6px; }
.pl-readout { font-variant-numeric: tabular-nums; opacity: 0.85; }
.pl-overlay { position: absolute; left: 0; top: 0; pointer-events: none; }
```

- [ ] **Step 4: Manual verify**

Run the web app (per the repo's existing dev command, e.g. the static server used for `web/`). Open a photo in the lightbox. Expected: the "Perceptual Lens" control group is visible (unhide `#pl-controls` temporarily for the check), the overlay canvas exists over the image. No behaviour yet.

- [ ] **Step 5: Commit**

```bash
git add web/index.html
# also the stylesheet path you edited
git commit -m "feat(lightbox): perceptual lens control group + selection overlay markup"
```

---

## Task 8: Lightbox wiring — lens render (toggle / strength / lightness)

**Files:**
- Modify: `web/main.js`

> Integration task — verified manually. Add an ES-module import at the top of `main.js` (it already loads as a module or via `<script type="module">`; if not, expose the functions on `window` from a small `<script type="module">` shim). The lens keeps its **own** pristine snapshot — it does not depend on the external `setCleanCanvas` hook.

- [ ] **Step 1: Import the pure module + add lens state**

```js
import { applyLens, estimateSceneWhiteLms } from './perceptual-color.js';

const perceptualLens = { on: false, strength: 1.0, lightness: true, dirty: true, cleanSnapshot: null };
```

- [ ] **Step 2: Add the lens post-process, capturing its own clean snapshot**

```js
// Call AFTER the decode/look draw has painted lightboxCanvas (see Step 3 for hook points).
function applyPerceptualLens() {
  if (lightboxIndex < 0 || !lightboxCanvas.width) return;
  const ctx = lightboxCanvas.getContext('2d', { willReadFrequently: true });
  // capture/refresh the pristine post-look snapshot
  if (perceptualLens.dirty || !perceptualLens.cleanSnapshot) {
    perceptualLens.cleanSnapshot = ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height);
    perceptualLens.dirty = false;
  }
  const clean = perceptualLens.cleanSnapshot;
  if (!perceptualLens.on) { ctx.putImageData(clean, 0, 0); return; }
  const out = applyLens(clean.data, clean.width, clean.height,
    { strength: perceptualLens.strength, lightness: perceptualLens.lightness });
  ctx.putImageData(new ImageData(out, clean.width, clean.height), 0, 0);
}
window.perceptualLensRefresh = applyPerceptualLens;
```

- [ ] **Step 3: Hook it into the draw paths**

Add `perceptualLens.dirty = true; applyPerceptualLens();` at the END of these existing functions (after the canvas has been painted): the `lightbox_live` worker handler (around `main.js:923` after `drawSensorWithOrientation`), `drawLightboxForCard` (around `main.js:2087`), and any decode-complete `putImageData` to `lightboxCanvas` (e.g. `main.js:2119`, `:4337`). Also set `perceptualLens.dirty = true` in `nextInLightbox` (new image).

- [ ] **Step 4: Wire the controls**

```js
const $ = (id) => document.getElementById(id);
function showPlControls(show) { $('pl-controls').hidden = !show; } // call when opening/closing lightbox
let plDebounce = null;
function plScheduleApply() { clearTimeout(plDebounce); plDebounce = setTimeout(applyPerceptualLens, 80); }

$('pl-toggle').addEventListener('change', (e) => { perceptualLens.on = e.target.checked; perceptualLens.dirty = true; applyPerceptualLens(); });
$('pl-strength').addEventListener('input', (e) => { perceptualLens.strength = e.target.value / 100; plScheduleApply(); });
$('pl-lightness').addEventListener('change', (e) => { perceptualLens.lightness = e.target.checked; plScheduleApply(); });
```

- [ ] **Step 5: Manual verify**

Open a landscape/leaf photo. Toggle the lens: vegetation should homogenise; strength slider varies the effect; at strength 0 the image is unchanged. Confirm **no re-decode** (no loading spinner / network) on toggle or slider. Toggle off → original returns.

- [ ] **Step 6: Commit**

```bash
git add web/main.js
git commit -m "feat(lightbox): perceptual lens render wiring (toggle/strength/lightness, cache-pure)"
```

---

## Task 9: Lightbox wiring — colour probe + global selector

**Files:**
- Modify: `web/main.js`

> Integration task — verified manually. Reuses the same pristine snapshot as the lens. **Coordinate mapping:** map the click from client coords to source-image pixel using the lightbox's existing viewport transform (the same math `drawLightboxForCard` uses with `lbZoom`, `lbPanX`, `lbPanY`); if a helper already exists for crop/subject hit-testing, reuse it. The `labBuf` is built from the pristine snapshot (post-look, pre-lens) so selection is illumination-normalised.

- [ ] **Step 1: Import selection functions + add selection state**

```js
import { normalizedLabBuffer, selectByColour, unionMask, maskBorder, maskCoverage, probe } from './perceptual-color.js';

const colourSelect = { seeds: [], mask: null, tolerance: 12, labBuf: null, w: 0, h: 0 };
```

- [ ] **Step 2: Build/refresh `labBuf` from the pristine snapshot**

```js
function ensureLabBuf() {
  const clean = perceptualLens.cleanSnapshot;
  if (!clean) return null;
  if (!colourSelect.labBuf || colourSelect.w !== clean.width || colourSelect.h !== clean.height || perceptualLens.dirty) {
    const white = estimateSceneWhiteLms(clean.data, clean.width, clean.height);
    colourSelect.labBuf = normalizedLabBuffer(clean.data, clean.width, clean.height, white);
    colourSelect.w = clean.width; colourSelect.h = clean.height;
  }
  return colourSelect.labBuf;
}
```

- [ ] **Step 3: Render the selection overlay (tint + border), cache-pure**

```js
function refreshSelectionOverlay() {
  const ov = document.getElementById('pl-overlay');
  if (!ov || !perceptualLens.on || !colourSelect.mask) { if (ov) ov.hidden = true; return; }
  ov.hidden = false;
  ov.width = colourSelect.w; ov.height = colourSelect.h;
  // match the overlay's on-screen box + transform to the lightbox canvas (same CSS size/transform)
  ov.style.width = lightboxCanvas.style.width || lightboxCanvas.width + 'px';
  ov.style.height = lightboxCanvas.style.height || lightboxCanvas.height + 'px';
  ov.style.transform = lightboxCanvas.style.transform || '';
  const ctx = ov.getContext('2d');
  ctx.clearRect(0, 0, ov.width, ov.height);
  const img = ctx.createImageData(ov.width, ov.height);
  const border = maskBorder(colourSelect.mask, ov.width, ov.height);
  for (let i = 0; i < colourSelect.mask.length; i++) {
    if (border[i]) { img.data[i*4]=255; img.data[i*4+1]=255; img.data[i*4+2]=0; img.data[i*4+3]=255; }      // yellow border
    else if (colourSelect.mask[i]) { img.data[i*4]=255; img.data[i*4+1]=255; img.data[i*4+2]=255; img.data[i*4+3]=90; } // tint
  }
  ctx.putImageData(img, 0, 0);
}
window.refreshSelectionOverlay = refreshSelectionOverlay;
```

- [ ] **Step 4: Click / Ctrl+click handler + readout + tolerance + clear**

```js
function plRenderReadout(r, cov) {
  document.getElementById('pl-readout').textContent =
    `hue ${r.hueDeg.toFixed(0)}°  chroma ${r.chroma.toFixed(1)}  sat ${r.dampedSaturation.toFixed(1)}  L ${r.lightness.toFixed(0)}` +
    (cov ? `  ·  ${(cov.fraction*100).toFixed(1)}% selected` : '');
}

lightboxCanvas.addEventListener('click', (e) => {
  if (!perceptualLens.on) return;
  const buf = ensureLabBuf(); if (!buf) return;
  // v1 mapping: correct at fit-to-viewport (no pan). For zoom/pan, derive the source px from
  // lbZoom/lbPanX/lbPanY using the same transform drawLightboxForCard applies (see Notes).
  const rect = lightboxCanvas.getBoundingClientRect();
  const x = Math.round((e.clientX - rect.left) / rect.width * colourSelect.w);
  const y = Math.round((e.clientY - rect.top) / rect.height * colourSelect.h);
  const r = probe(buf, colourSelect.w, colourSelect.h, x, y, 3);
  const seed = [r.lightness, Math.cos(r.hueDeg*Math.PI/180)*r.chroma, Math.sin(r.hueDeg*Math.PI/180)*r.chroma];
  const m = selectByColour(buf, colourSelect.w, colourSelect.h, seed, colourSelect.tolerance);
  if (e.ctrlKey && colourSelect.mask) { colourSelect.mask = unionMask(colourSelect.mask, m); colourSelect.seeds.push(seed); }
  else { colourSelect.mask = m; colourSelect.seeds = [seed]; }
  plRenderReadout(r, maskCoverage(colourSelect.mask));
  refreshSelectionOverlay();
});

document.getElementById('pl-tolerance').addEventListener('input', (e) => {
  colourSelect.tolerance = Number(e.target.value);
  const buf = colourSelect.labBuf; if (!buf || !colourSelect.seeds.length) return;
  let m = selectByColour(buf, colourSelect.w, colourSelect.h, colourSelect.seeds[0], colourSelect.tolerance);
  for (let k = 1; k < colourSelect.seeds.length; k++) m = unionMask(m, selectByColour(buf, colourSelect.w, colourSelect.h, colourSelect.seeds[k], colourSelect.tolerance));
  colourSelect.mask = m; refreshSelectionOverlay();
});

document.getElementById('pl-clear').addEventListener('click', () => {
  colourSelect.mask = null; colourSelect.seeds = []; refreshSelectionOverlay();
  document.getElementById('pl-readout').textContent = 'click a colour';
});
```

- [ ] **Step 5: Keep the overlay aligned on zoom/pan**

In whatever function applies zoom/pan to `lightboxCanvas` (transform/CSS update), also call `refreshSelectionOverlay()` so the overlay tracks the image.

- [ ] **Step 6: Manual verify**

Open a flower photo with the lens on. Click a flower → its colour reads out and all same-colour flowers get a yellow border + faint tint. Ctrl+click a second colour → both highlighted. Tolerance slider widens/narrows. Clear empties it. Zoom/pan keeps the overlay aligned. No re-decode at any point.

- [ ] **Step 7: Commit**

```bash
git add web/main.js
git commit -m "feat(lightbox): colour probe + global colour-range selector overlay"
```

---

## Task 10: End-to-end validation (manual, with the ORF set)

**Files:** none (manual).

- [ ] **Step 1: Run the full unit suite**

Run: `node --test web/perceptual-color.test.mjs`
Expected: all PASS.

- [ ] **Step 2: Walk the validation set** (`c:\995\2026-02-20 Gobabeb To Windhoek\`)

- `P2200700.ORF` (landscape) — lens homogenises vegetation; selector grabs a vegetation colour across sun/shade.
- `P2200617.ORF` + `P2200616.ORF` (two brightnesses) — apply the lens to each; the probe's hue/saturation readout for the same patch should be close across the two.
- `P2200686.ORF` (portrait in shadow) — lens neutralises the blue open-shade cast; skin probe reads a stable hue; shadows lift, highlights not blown.
- `Gobabeb Herbarium\P2200469.ORF` (herbarium) — lens pushes the paper toward neutral; probe reads specimen colour. (Note: vibrancy "revive" is a future mode, not this lens.)

- [ ] **Step 3: Report numbers, get user confirmation**

Record the probe readouts (esp. the two-brightness pair's convergence) and show them to the user. **Do not claim success until the user confirms in their viewer.** Note any tuning needed (`C_KNEE`, lightness `k`, tolerance default).

- [ ] **Step 4: Open a PR (when the user asks)**

```bash
git push -u origin perceptual-colour-lens
gh pr create --fill
```

---

## Notes for the implementer

- **Cache purity is the cardinal rule:** the lens and overlay only ever read the pristine snapshot and write the display/overlay canvas. Never write transformed pixels back into any decode cache.
- **Never raise global exposure:** `compressLightness` only pulls toward mid with a highlight-protecting shoulder. Do not add a brightness/gain term.
- **The five operators are the seam:** if/when XYB or a Rust port lands, only the internals of `perceptual-color.js` change; `applyLens`/`probe`/selection keep their signatures.
- **Coordinate mapping (Task 9 Step 4) is the one spot that must be wired against the real lightbox viewport math** — the `getBoundingClientRect` version is a placeholder that only works at fit-to-viewport with no pan; replace it with the `lbZoom`/`lbPanX`/`lbPanY` mapping during execution.
