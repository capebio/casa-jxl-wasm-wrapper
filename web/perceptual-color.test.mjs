// web/perceptual-color.test.mjs — run: node --test web/perceptual-color.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  srgbToLinear, linearToSrgb,
  linearRgbToXyz, xyzToLinearRgb,
  xyzToLab, labToXyz,
  xyzToLms, lmsToXyz,
  vonKriesAdapt, estimateSceneWhiteLms, CANONICAL_WHITE_LMS, srgbU8ToLinear,
  phi, dampChroma, neutralOf, hueClassOf, saturationOf, lightnessOf, phiDampedDistance,
  compressLightness, estimateLightnessStats,
  applyLens,
  normalizedLabBuffer, selectByColour, unionMask, maskBorder, maskCoverage, probe,
} from './perceptual-color.mjs';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const vclose = (A, B, eps = 1e-6) => A.every((x, i) => close(x, B[i], eps));

function randImage(w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i*4]=(i*37)%256; rgba[i*4+1]=(i*91)%256; rgba[i*4+2]=(i*53)%256; rgba[i*4+3]=255; }
  return rgba;
}
function twoColourImage(w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y*w+x, left = x < w/2;
    rgba[i*4]=left?200:40; rgba[i*4+1]=left?40:180; rgba[i*4+2]=left?40:60; rgba[i*4+3]=255;
  }
  return rgba;
}

// --- Task 1: conversions ---
test('srgb<->linear round-trips', () => {
  for (const c of [0, 0.02, 0.04045, 0.2, 0.5, 1]) assert.ok(close(linearToSrgb(srgbToLinear(c)), c, 1e-6), `c=${c}`);
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
  assert.ok(vclose(lmsToXyz(xyzToLms(xyz)), xyz, 1e-5));
});

// --- Task 2: von Kries + scene white ---
test('vonKriesAdapt sigma=0 is identity', () => {
  const lms = [0.4, 0.5, 0.6];
  assert.ok(vclose(vonKriesAdapt(lms, [0.3, 0.5, 0.9], 0), lms, 1e-9));
});
test('vonKriesAdapt sigma=1 maps scene white to canonical', () => {
  const sceneWhite = [0.6, 0.5, 0.3];
  assert.ok(vclose(vonKriesAdapt(sceneWhite, sceneWhite, 1), CANONICAL_WHITE_LMS, 1e-9));
});
test('estimateSceneWhiteLms on flat grey ~ that grey in LMS', () => {
  const w = 4, h = 4, rgba = new Uint8ClampedArray(w*h*4);
  for (let i = 0; i < w*h; i++) { rgba[i*4]=180; rgba[i*4+1]=180; rgba[i*4+2]=180; rgba[i*4+3]=255; }
  const white = estimateSceneWhiteLms(rgba, w, h);
  const g = srgbU8ToLinear(180);
  assert.ok(vclose(white, xyzToLms(linearRgbToXyz([g, g, g])), 1e-3));
});

// --- Task 3: Phi + operators ---
test('phi concave, monotonic, phi(0)=0, slope~1 at 0', () => {
  assert.ok(close(phi(0), 0, 1e-9));
  assert.ok(phi(10) > phi(5) && phi(40) > phi(20));
  assert.ok((phi(40) - phi(30)) < (phi(20) - phi(10)));
  assert.ok(close(phi(0.001) / 0.001, 1, 1e-2));
});
test('dampChroma sigma=0 identity; preserves hue', () => {
  assert.ok(vclose(Object.values(dampChroma(50, 30, -40, 0, {})), [50, 30, -40], 1e-9));
  const d = dampChroma(50, 30, -40, 1, {});
  assert.ok(close(Math.atan2(d.b, d.a), Math.atan2(-40, 30), 1e-9));
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
  assert.equal(d, phiDampedDistance([50,0,10],[50,10,0]));
  const d1 = phiDampedDistance([50,0,0],[50,20,0]);
  const d2 = phiDampedDistance([50,0,0],[50,40,0]);
  assert.ok(d2 < 2 * d1);
});

// --- Task 4: lightness ---
test('compressLightness sigma=0 identity', () => {
  assert.equal(compressLightness(70, { Lmid: 50, Lshoulder: 80, k: 0.3 }, 0), 70);
});
test('compressLightness never brightens the top shoulder', () => {
  assert.ok(compressLightness(85, { Lmid: 50, Lshoulder: 80, k: 0.3 }, 1) <= 85);
});
test('compressLightness lifts shadows toward mid (reduces spread)', () => {
  const lo = compressLightness(20, { Lmid: 50, Lshoulder: 80, k: 0.3 }, 1);
  assert.ok(lo > 20 && lo < 50);
});
test('estimateLightnessStats returns median + 85th pct', () => {
  const w = 10, h = 1, rgba = new Uint8ClampedArray(w*h*4);
  for (let i = 0; i < w; i++) { const v = i*25; rgba[i*4]=v; rgba[i*4+1]=v; rgba[i*4+2]=v; rgba[i*4+3]=255; }
  const st = estimateLightnessStats(rgba, w, h);
  assert.ok(st.Lmid > 0 && st.Lshoulder >= st.Lmid && st.Lshoulder <= 100);
});

// --- Task 5: applyLens ---
test('applyLens sigma=0 is a no-op (within rounding)', () => {
  const w = 8, h = 8, src = randImage(w, h);
  const out = applyLens(src, w, h, { strength: 0, lightness: true });
  for (let i = 0; i < src.length; i++) assert.ok(Math.abs(out[i]-src[i]) <= 1, `i=${i}`);
});
test('applyLens preserves alpha and dimensions', () => {
  const w = 8, h = 8, src = randImage(w, h);
  const out = applyLens(src, w, h, { strength: 1, lightness: true });
  assert.equal(out.length, src.length);
  for (let i = 0; i < w*h; i++) assert.equal(out[i*4+3], 255);
});

// --- Task 6: selection + probe ---
test('normalizedLabBuffer length and finite', () => {
  const w = 6, h = 6, rgba = twoColourImage(w, h);
  const buf = normalizedLabBuffer(rgba, w, h, estimateSceneWhiteLms(rgba, w, h));
  assert.equal(buf.length, 3*w*h);
  assert.ok(buf.every(Number.isFinite));
});
test('selectByColour picks the matching half; tolerance grows the mask', () => {
  const w = 8, h = 8, rgba = twoColourImage(w, h);
  const buf = normalizedLabBuffer(rgba, w, h, estimateSceneWhiteLms(rgba, w, h));
  const seed = [buf[0], buf[1], buf[2]];
  const c1 = maskCoverage(selectByColour(buf, w, h, seed, 5)).fraction;
  const c2 = maskCoverage(selectByColour(buf, w, h, seed, 500)).fraction;
  assert.ok(c1 > 0 && c1 < 0.6);
  assert.ok(c2 >= c1);
});
test('unionMask and maskBorder', () => {
  const w = 4, h = 4, a = new Uint8Array(w*h), b = new Uint8Array(w*h);
  a[0] = 1; b[15] = 1;
  const u = unionMask(a, b);
  assert.equal(u[0], 1); assert.equal(u[15], 1);
  const m = new Uint8Array(w*h); m[5]=m[6]=m[9]=m[10]=1;
  const bd = maskBorder(m, w, h);
  assert.equal(bd[5]+bd[6]+bd[9]+bd[10], 4);
});
test('probe returns operator readout', () => {
  const w = 8, h = 8, rgba = twoColourImage(w, h);
  const buf = normalizedLabBuffer(rgba, w, h, estimateSceneWhiteLms(rgba, w, h));
  const r = probe(buf, w, h, 1, 1, 1);
  assert.ok(typeof r.hueDeg === 'number' && typeof r.lightness === 'number' && r.dampedSaturation >= 0);
});
test('illuminant convergence (spec test 8): two casts of one scene converge', () => {
  const w = 8, h = 8;
  const base = new Uint8ClampedArray(w*h*4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y*w+x, top = y < h/2;
    base[i*4]=top?230:150; base[i*4+1]=top?230:90; base[i*4+2]=top?230:90; base[i*4+3]=255;
  }
  const cast = (img, kr, kg, kb) => {
    const o = new Uint8ClampedArray(img.length);
    for (let i = 0; i < img.length; i += 4) { o[i]=Math.min(255,img[i]*kr); o[i+1]=Math.min(255,img[i+1]*kg); o[i+2]=Math.min(255,img[i+2]*kb); o[i+3]=255; }
    return o;
  };
  const warm = cast(base, 1.0, 0.85, 0.7), cool = cast(base, 0.8, 0.9, 1.0);
  const patchAb = (img) => {
    const buf = normalizedLabBuffer(img, w, h, estimateSceneWhiteLms(img, w, h));
    let a = 0, b = 0, c = 0;
    for (let y = h/2; y < h; y++) for (let x = 0; x < w; x++) { const i = y*w+x; a += buf[i*3+1]; b += buf[i*3+2]; c++; }
    return [a/c, b/c];
  };
  const d = Math.hypot(patchAb(warm)[0]-patchAb(cool)[0], patchAb(warm)[1]-patchAb(cool)[1]);
  assert.ok(d < 10, `patch colour converges across casts (got ${d.toFixed(2)})`);
});
