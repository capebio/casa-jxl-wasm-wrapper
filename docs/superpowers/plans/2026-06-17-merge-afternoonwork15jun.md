# Merge AfternoonWork15Jun → LateNight16June Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge AfternoonWork15Jun into LateNight16June, recovering StandardMultifileTest.mjs and 50+ other commits, resolving the single true file conflict in web/jxl-butteraugli.js.

**Architecture:** One true text conflict (web/jxl-butteraugli.js). The rest of ~300 files from AfternoonWork15Jun auto-merge (they don't exist on LateNight16June, or only changed on one side). The conflict is deep: two incompatible designs for scaleErr signature and ref-pyramid caching must be unified into a single correct file.

**Tech Stack:** Git merge (no rebase — branch is published), Node.js tests, TypeScript, plain JS.

---

## Conflict Analysis

### Why web/jxl-butteraugli.js conflicts

Both branches independently evolved from the same base (commit 5c641410):

| Feature | LateNight16June (ours) | AfternoonWork15Jun (theirs) |
|---|---|---|
| scaleErr signature | `scaleErr(rX,rY,rB,tX,tY,tB,w,h,scratch)` — computes blur internally | `scaleErr(mask,rX,rY,rB,tX,tY,tB,w,h,k?)` — takes precomputed mask |
| Ref caching | None | `prepRef()` WeakMap cache (computes once per refXyb identity) |
| Batch comparer | None | `createButteraugliComparer()` factory |
| Fast approx | None | `computeButteraugliApproxVsFinal()` |
| Region scoring | `computeButteraugliRegion()` ✓ | None |
| Saliency field | `computeSaliencyField()` ✓ | None |
| Tile ranking | `rankTiles()` ✓ | None |
| Backend abstraction | `_backend` + `registerBackend()` ✓ | None |
| Scratch pool | `createButteraugliScratch()` + `ensureScratch()` | None |
| Alloc-free variants | `pixelsToXybInto()`, `boxBlurInto()`, `dn2Into()` | Optional params on `pixelsToXyb()` |

### Bug in LateNight16June computeButteraugliVsFinal

LateNight's pointer-swap scratch trick aliases rX/tX to the same scratch buffer:
```js
dn2Into(rX, scratch.a, w, h);
rX = scratch.a;           // rX now = scratch.a
dn2Into(tX, scratch.a, w, h);  // OVERWRITES scratch.a that rX points to!
tX = scratch.a;
// next scaleErr call: rX and tX both = downsampled test data. Ref data is lost.
```
AfternoonWork's `prepRef()` is the correct solution — it precomputes the ref pyramid into separate arrays during init.

### Merge Resolution Strategy

1. **scaleErr signature**: adopt AfternoonWork's `scaleErr(mask, ...)` — precomputed mask is strictly better (ref mask constant across passes against same ref)
2. **pixelsToXyb**: merged — keep `pixelsToXybInto()` from LateNight as the zero-alloc primitive; `pixelsToXyb()` delegates to it AND accepts optional output buffers (from AfternoonWork, needed by `createButteraugliComparer`)
3. **boxBlur/dn2**: keep LateNight's `boxBlurInto()`/`dn2Into()` (needed by region scoring and as primitives for `boxBlur`/`dn2`)
4. **prepRef**: keep from AfternoonWork; fixes the aliasing bug in `computeButteraugliVsFinal`
5. **createButteraugliComparer**: keep from AfternoonWork
6. **computeButteraugliVsFinal**: merged — add `_backend.score` check at top (LateNight); use `prepRef()` for ref pyramid (AfternoonWork, fixes aliasing bug); drop scratch param (bug removed)
7. **_multiScaleScore**: update to use new `scaleErr(mask, ...)` signature; compute mask with `boxBlur()` per scale
8. **computeButteraugliRegion**: update to use new `scaleErr(mask, ...)` signature; replace `maskScratch` with direct `boxBlur()` call
9. **Drop**: `createButteraugliScratch()` and `ensureScratch()` — no longer needed after fixing the aliasing bug

---

## File Structure

- Modify: `web/jxl-butteraugli.js` — manual merge (the only conflict)
- All other files: auto-merged by git, spot-checked

---

## Pre-Merge Baseline

- [ ] **Record current test status**

  ```powershell
  npm test 2>&1 | Select-String "(pass|fail|error TS)" | Select-Object -First 20
  ```

  Expected: 30/30 jxl-scheduler tests pass; `jxl-worker-browser` fails with pre-existing `worker.ts(274,15): error TS2339` — this is pre-existing and NOT our problem.

---

## Task 1: Start the Merge

- [ ] **Step 1: Start merge with --no-commit to inspect before finalizing**

  ```powershell
  git merge --no-commit AfternoonWork15Jun
  ```

  Expected: Git will say "Automatic merge failed; fix conflicts and then commit the result." or if it succeeds without conflicts it'll say "Automatic merge went well; stopped before committing as requested."

- [ ] **Step 2: Check merge status**

  ```powershell
  git status
  ```

  Expected: See `both modified: web/jxl-butteraugli.js` and `modified: .claude/scheduled_tasks.lock`. Everything else should be "new file" or cleanly auto-merged.

  If you see unexpected conflicts beyond these two files, STOP and report before proceeding.

---

## Task 2: Resolve .claude/scheduled_tasks.lock

This file is a runtime lock (session ID + PID). Neither version has semantic meaning post-session.

- [ ] **Step 1: Keep ours (LateNight16June)**

  ```powershell
  git checkout --ours .claude/scheduled_tasks.lock
  git add .claude/scheduled_tasks.lock
  ```

---

## Task 3: Resolve web/jxl-butteraugli.js

This is the complete merged file. Replace the conflict-marked file entirely.

- [ ] **Step 1: Write the merged file**

  Write the following content to `web/jxl-butteraugli.js` (replacing everything including conflict markers):

  ```js
  // Butteraugli-inspired perceptual image distance (JS approximation)
  // Not bit-exact with libjxl. Score: lower = better; 0 = identical; ~1.0 = visible.
  //
  // Algorithm:
  //  1. sRGB → linear → XYB (opponent-color space used by Butteraugli/JXL)
  //  2. Multi-scale spatial masking via box blur of Y channel
  //  3. Weighted per-channel error with p-norm (p=3) at 3 octaves
  //  4. Combine scales: full (×4) + half (×2) + quarter (×1) / 7
  
  // Precomputed table: sqrt(sRGB_decode(i/255)) — avoids per-pixel gamma + sqrt calls
  const _sqrtLin = (() => {
      const t = new Float32Array(256);
      for (let i = 0; i < 256; i++) {
          const v = i / 255;
          const lin = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          t[i] = Math.sqrt(lin);
      }
      return t;
  })();
  
  // Convert RGBA uint8 pixels → XYB float32 channels (allocation-free variant).
  // outX, outY, outB must be pre-allocated Float32Arrays of size n.
  export function pixelsToXybInto(pixels, n, outX, outY, outB) {
      for (let i = 0, j = 0; i < n; i++, j += 4) {
          const r = _sqrtLin[pixels[j]];
          const g = _sqrtLin[pixels[j + 1]];
          const b = _sqrtLin[pixels[j + 2]];
          outX[i] = (r - b) * 0.5;        // red–blue opponent
          outY[i] = (r + b) * 0.5 + g;   // luminance proxy
          outB[i] = b;                     // blue channel
      }
  }
  
  // Convert RGBA uint8 pixels → XYB float32 channels.
  // Exported so callers can precompute reference once and reuse across passes.
  // pixels: Uint8Array RGBA (stride 4, alpha ignored). For batch reuse see createButteraugliComparer.
  // Approx only; not bit-exact libjxl.
  // Optional outX/outY/outB for zero-alloc in hot batch paths.
  export function pixelsToXyb(pixels, n, outX, outY, outB) {
      const X = outX || new Float32Array(n);
      const Y = outY || new Float32Array(n);
      const B = outB || new Float32Array(n);
      pixelsToXybInto(pixels, n, X, Y, B);
      return [X, Y, B];
  }
  
  // O(n) separable box blur into pre-allocated buffers (allocation-free variant).
  // tmp and dst must be pre-allocated Float32Arrays of size w*h.
  function boxBlurInto(src, dst, tmp, w, h, r) {
      const inv = 1.0 / (2 * r + 1);
  
      // Horizontal pass — sliding window
      for (let y = 0; y < h; y++) {
          const base = y * w;
          let sum = src[base] * (r + 1);
          for (let k = 1; k <= r; k++) sum += src[base + k];
          for (let x = 0; x < w; x++) {
              tmp[base + x] = sum * inv;
              sum += src[base + Math.min(x + r + 1, w - 1)]
                   - src[base + Math.max(x - r, 0)];
          }
      }
  
      // Vertical pass — sliding window
      for (let x = 0; x < w; x++) {
          let sum = tmp[x] * (r + 1);
          for (let k = 1; k <= r; k++) sum += tmp[k * w + x];
          for (let y = 0; y < h; y++) {
              dst[y * w + x] = sum * inv;
              sum += tmp[Math.min(y + r + 1, h - 1) * w + x]
                   - tmp[Math.max(y - r, 0) * w + x];
          }
      }
  
      return dst;
  }
  
  // O(n) separable box blur, clamp-to-edge boundary — allocates buffers.
  function boxBlur(src, w, h, r) {
      const n = w * h;
      const tmp = new Float32Array(n);
      const dst = new Float32Array(n);
      return boxBlurInto(src, dst, tmp, w, h, r);
  }
  
  // 2× area downsample into pre-allocated buffer (allocation-free variant).
  // dst must be a pre-allocated Float32Array of size Math.max(1,w>>1) × Math.max(1,h>>1).
  function dn2Into(src, dst, w, h) {
      const dw = Math.max(1, w >> 1);
      const dh = Math.max(1, h >> 1);
      for (let y = 0; y < dh; y++) {
          const sy0 = y << 1;
          const sy1 = Math.min(sy0 + 1, h - 1);
          for (let x = 0; x < dw; x++) {
              const sx0 = x << 1;
              const sx1 = Math.min(sx0 + 1, w - 1);
              dst[y * dw + x] = (
                  src[sy0 * w + sx0] + src[sy0 * w + sx1] +
                  src[sy1 * w + sx0] + src[sy1 * w + sx1]
              ) * 0.25;
          }
      }
      return [dst, dw, dh];
  }
  
  // 2× area downsample (box filter) — allocates new buffer. Returns [dst, dw, dh].
  function dn2(src, w, h) {
      const dw = Math.max(1, w >> 1);
      const dh = Math.max(1, h >> 1);
      const dst = new Float32Array(dw * dh);
      return dn2Into(src, dst, w, h);
  }
  
  // Reference-side work is identical for every pass compared against the same
  // reference: the 3-scale downsampled pyramid of the ref channels and the masking
  // blur of ref Y. Charts evaluate many passes per reference, so precompute once,
  // keyed on the refXyb array identity (WeakMap — GC-safe, zero API change).
  const _refPrep = new WeakMap();
  
  function prepRef(refXyb, width, height) {
      const cached = _refPrep.get(refXyb);
      if (cached && cached.width === width && cached.height === height) return cached;
      let [X, Y, B] = refXyb;
      let w = width, h = height;
      const levels = [];
      for (let s = 0; s < 3; s++) {
          const prev = levels[levels.length - 1];
          if (prev && prev.X === X) {
              levels.push(prev);  // degenerate 1px dims: scale not downsampled, reuse level
          } else {
              const blurR = Math.max(1, Math.min(8, w >> 6));  // ~w/64, clamped 1–8
              levels.push({ X, Y, B, mask: boxBlur(Y, w, h, blurR) });
          }
          if (s < 2 && w > 1 && h > 1) {
              X = dn2(X, w, h)[0];
              Y = dn2(Y, w, h)[0];
              B = dn2(B, w, h)[0];
              w = Math.max(1, w >> 1);
              h = Math.max(1, h >> 1);
          }
      }
      const prep = { width, height, levels };
      _refPrep.set(refXyb, prep);
      return prep;
  }
  
  // Perceptual error at one spatial scale.
  // mask: precomputed box blur of the reference Y channel (brighter/higher-contrast
  // areas tolerate more error) — constant per reference, see prepRef().
  // k: optional per-channel weight overrides {kX, kY, kB}; defaults: kX=24 kY=12 kB=4.
  function scaleErr(mask, rX, rY, rB, tX, tY, tB, w, h, k = null) {
      const n = w * h;
      const kX = (k && k.kX) || 24, kY = (k && k.kY) || 12, kB = (k && k.kB) || 4;
      let sum = 0;
      for (let i = 0; i < n; i++) {
          const m = Math.max(0.15, mask[i] * 2.0 + 0.15);
          const ex = (rX[i] - tX[i]) / m;
          const ey = (rY[i] - tY[i]) / m;
          const eb = (rB[i] - tB[i]) / m;
          const e2 = kX * ex * ex + kY * ey * ey + kB * eb * eb;
          sum += e2 * Math.sqrt(e2 + 1e-12);  // branchless e2^1.5 (p=3)
      }
      return (sum / n) ** (1 / 3);
  }
  
  // createButteraugliComparer: factory with pre-allocated test buffers.
  // Cuts alloc/GC for repeated cutoff evals vs same ref. Keeps old compute* API unchanged.
  // opts: {weights?, k? {kX,kY,kB}, includeGradient?} for lens15/17/14 tuning.
  export function createButteraugliComparer(refPixels, width, height, opts = {}) {
      const n = width * height;
      if (!n || refPixels.length !== n * 4) return () => NaN;
      const refXyb = pixelsToXyb(refPixels, n);
      const prep = prepRef(refXyb, width, height);
      const maxN = n;
      let tX = new Float32Array(maxN), tY = new Float32Array(maxN), tB = new Float32Array(maxN);
      let dX = new Float32Array(maxN), dY = new Float32Array(maxN), dB = new Float32Array(maxN);
      const weights = opts.weights || [4, 2, 1];
      const k = opts.k || null;
      const includeGradient = !!opts.includeGradient;
      return function computeVsFinal(testPixels) {
          if (testPixels.length !== n * 4) return NaN;
          pixelsToXyb(testPixels, n, tX, tY, tB);
  
          let w = width, h = height, total = 0;
          for (let s = 0; s < 3; s++) {
              const L = prep.levels[s];
              let e = scaleErr(L.mask, L.X, L.Y, L.B, tX, tY, tB, w, h, k) * weights[s];
              if (includeGradient) {
                  // stub: sobel/gradient term on Y for photogram feature stability (lens14)
                  e *= 1.0;
              }
              total += e;
              if (s < 2 && w > 1 && h > 1) {
                  const dw = Math.max(1, w >> 1), dh = Math.max(1, h >> 1), dn = dw * dh;
                  for (let y = 0; y < dh; y++) {
                      const sy0 = y << 1, sy1 = Math.min(sy0 + 1, h - 1);
                      for (let x = 0; x < dw; x++) {
                          const sx0 = x << 1, sx1 = Math.min(sx0 + 1, w - 1);
                          const idx = y * dw + x;
                          const bo0 = sy0 * w + sx0, bo1 = sy0 * w + sx1, b10 = sy1 * w + sx0, b11 = sy1 * w + sx1;
                          dX[idx] = (tX[bo0] + tX[bo1] + tX[b10] + tX[b11]) * 0.25;
                          dY[idx] = (tY[bo0] + tY[bo1] + tY[b10] + tY[b11]) * 0.25;
                          dB[idx] = (tB[bo0] + tB[bo1] + tB[b10] + tB[b11]) * 0.25;
                      }
                  }
                  tX.set(dX.subarray(0, dn));
                  tY.set(dY.subarray(0, dn));
                  tB.set(dB.subarray(0, dn));
                  w = dw; h = dh;
              }
          }
          return total / 7;
      };
  }
  
  // =============================================================================
  // Backend abstraction — routes hot kernels through WASM when registered.
  //
  // Buffer ownership rule: no copy loops WASM→JS→WASM. Pass Uint8Array views
  // into WASM heap memory (pointer + length) for zero-copy access.
  //
  // Required Rust exports (batch APIs only — no per-pixel FFI):
  //   rgba_to_xyb(pixels: *const u8, n: usize) -> *mut [f32; 3]
  //   downsample_xyb(ch: *mut f32, w: u32, h: u32) -> *mut f32
  //   blur_y(y: *const f32, w: u32, h: u32, r: u32) -> *mut f32
  //   butteraugli_score(ref_xyb: *const f32, test_xyb: *const f32, w: u32, h: u32) -> f32
  //   saliency_field(ref_xyb: *const f32, test_xyb: *const f32, n: usize, out: *mut f32)
  let _backend = { score: null, convert: null, saliency: null };
  
  export function registerBackend(b) {
      _backend = b;
  }
  
  // Bermanian extension point — future Rust information-theoretic saliency.
  // Do NOT implement mathematics here; this is a seam for the Rust crate only.
  let _informationBackend = null;
  
  export function registerInformationBackend(backend) {
      _informationBackend = backend;
  }
  
  export function computeInformationField(image, width, height) {
      if (_informationBackend) {
          return _informationBackend.compute(image, width, height);
      }
      return null;
  }
  
  // Compute Butteraugli-inspired score.
  //
  // refXyb: result of pixelsToXyb(refPixels, n) — precompute once, reuse per pass.
  // testPixels: Uint8Array of RGBA bytes for the pass being compared.
  //
  // Returns a non-negative float; 0 = identical, ~0.5 = excellent, >1.5 = visible.
  // For batch/repeated use (zero-alloc, config) use createButteraugliComparer instead.
  export function computeButteraugliVsFinal(refXyb, testPixels, width, height) {
      if (_backend.score) {
          return _backend.score(refXyb, testPixels, width, height);
      }
      const n = width * height;
      if (!n || testPixels.length !== n * 4) return NaN;
  
      const ref = prepRef(refXyb, width, height);
      let [tX, tY, tB] = pixelsToXyb(testPixels, n);
      let w = width, h = height;
  
      const weights = [4, 2, 1];
      let total = 0;
  
      for (let s = 0; s < 3; s++) {
          const L = ref.levels[s];
          total += scaleErr(L.mask, L.X, L.Y, L.B, tX, tY, tB, w, h) * weights[s];
          if (s < 2 && w > 1 && h > 1) {
              tX = dn2(tX, w, h)[0];
              tY = dn2(tY, w, h)[0];
              tB = dn2(tB, w, h)[0];
              w = Math.max(1, w >> 1);
              h = Math.max(1, h >> 1);
          }
      }
  
      return total / 7;
  }
  
  // 1-scale fast approx (full weight only). For coarse param sweeps / early reject in profiling.
  // Still uses ref prep cache. For config use the comparer path.
  export function computeButteraugliApproxVsFinal(refXyb, testPixels, width, height) {
      const n = width * height;
      if (!n || testPixels.length !== n * 4) return NaN;
      const ref = prepRef(refXyb, width, height);
      const L = ref.levels[0];
      const [tX, tY, tB] = pixelsToXyb(testPixels, n);
      return scaleErr(L.mask, L.X, L.Y, L.B, tX, tY, tB, width, height) * 4 / 7;
  }
  
  // Future (Lens17/12/16/14): Rust LookRenderer PerceptualConstancy (schrodinger geodesic + molchanov + losalamos)
  // will allow illum-invariant sat/wb/exposure in progressive paints. Call these metrics (or comparer)
  // on post-adjust RGBA during cutoff evals to validate early "recognizable" under varying illum.
  // For LLM/plantID/AR: pass external model score series to byte-metrics for task-aware cutoff (not pixel fidelity).
  // Photogram/digital-twin: consider adding gradient term to scaleErr for feature stability.
  
  // Multi-scale score on pre-converted XYB channel arrays.
  // Used by computeButteraugliRegion (operating on extracted sub-region arrays, no WeakMap cache).
  function _multiScaleScore(rX, rY, rB, tX, tY, tB, w, h) {
      const weights = [4, 2, 1];
      let total = 0;
      for (let s = 0; s < 3; s++) {
          const blurR = Math.max(1, Math.min(8, w >> 6));
          const mask = boxBlur(rY, w, h, blurR);
          total += scaleErr(mask, rX, rY, rB, tX, tY, tB, w, h) * weights[s];
          if (s < 2 && w > 1 && h > 1) {
              let nw, nh;
              [rX, nw, nh] = dn2(rX, w, h);
              [rY] = dn2(rY, w, h);
              [rB] = dn2(rB, w, h);
              [tX] = dn2(tX, w, h);
              [tY] = dn2(tY, w, h);
              [tB] = dn2(tB, w, h);
              w = nw; h = nh;
          }
      }
      return total / 7;
  }
  
  // Score a sub-region of the image without scanning pixels outside it.
  //
  // refXyb: full-image result of pixelsToXyb() (stride = imageWidth).
  // pixels: full-image RGBA Uint8Array (stride = imageWidth * 4).
  // x, y, width, height: region bounds (pixels, 0-indexed).
  // imageWidth: full-image pixel width (stride for both arrays).
  //
  // Returns { score, maxError, location: { x, y } } where location is the
  // image-coordinate of the pixel with the highest masked error at full scale.
  export function computeButteraugliRegion(refXyb, pixels, x, y, width, height, imageWidth) {
      const n = width * height;
      if (!n) return { score: 0, maxError: 0, location: { x, y } };
  
      const [fullRX, fullRY, fullRB] = refXyb;
  
      const rX = new Float32Array(n);
      const rY = new Float32Array(n);
      const rB = new Float32Array(n);
      const tX = new Float32Array(n);
      const tY = new Float32Array(n);
      const tB = new Float32Array(n);
  
      for (let py = 0; py < height; py++) {
          const srcRow = (y + py) * imageWidth;
          const dstRow = py * width;
          for (let px = 0; px < width; px++) {
              const si = srcRow + (x + px);
              const di = dstRow + px;
              rX[di] = fullRX[si];
              rY[di] = fullRY[si];
              rB[di] = fullRB[si];
  
              const pi = si * 4;
              const r = _sqrtLin[pixels[pi]];
              const g = _sqrtLin[pixels[pi + 1]];
              const b = _sqrtLin[pixels[pi + 2]];
              tX[di] = (r - b) * 0.5;
              tY[di] = (r + b) * 0.5 + g;
              tB[di] = b;
          }
      }
  
      // Compute mask from reference Y at full scale for max-error pixel location.
      const blurR = Math.max(1, Math.min(8, width >> 6));
      const mask = boxBlur(rY, width, height, blurR);
  
      // Find max per-pixel error at full resolution so callers can locate hotspots.
      const kX = 24, kY = 12, kB = 4;
      let maxError = 0, maxPy = 0, maxPx = 0;
      for (let i = 0; i < n; i++) {
          const m = Math.max(0.15, mask[i] * 2.0 + 0.15);
          const ex = (rX[i] - tX[i]) / m;
          const ey = (rY[i] - tY[i]) / m;
          const eb = (rB[i] - tB[i]) / m;
          const e2 = kX * ex * ex + kY * ey * ey + kB * eb * eb;
          const err = e2 > 1e-9 ? e2 * Math.sqrt(e2) : 0;
          if (err > maxError) {
              maxError = err;
              maxPy = Math.floor(i / width);
              maxPx = i % width;
          }
      }
  
      const score = _multiScaleScore(rX, rY, rB, tX, tY, tB, width, height);
      return { score, maxError, location: { x: x + maxPx, y: y + maxPy } };
  }
  
  // Per-pixel perceptual saliency: how much each pixel differs from the reference.
  //
  // refXyb: result of pixelsToXyb(refPixels, n) — precompute once, reuse across passes.
  // testPixels: Uint8Array of RGBA bytes for the pass being compared.
  //
  // Returns Float32Array of length width*height, values normalized 0 (same) → 1 (max change).
  // Formula: 24*dx² + 12*dy² + 4*db² per pixel, then normalize by max.
  export function computeSaliencyField(refXyb, testPixels, width, height) {
      if (_backend.saliency) {
          return _backend.saliency(refXyb, testPixels, width, height);
      }
  
      const n = width * height;
      const [rX, rY, rB] = refXyb;
      const [tX, tY, tB] = pixelsToXyb(testPixels, n);
  
      const out = new Float32Array(n);
      let maxVal = 0;
  
      for (let i = 0; i < n; i++) {
          const dx = rX[i] - tX[i];
          const dy = rY[i] - tY[i];
          const db = rB[i] - tB[i];
          const v = 24 * dx * dx + 12 * dy * dy + 4 * db * db;
          out[i] = v;
          if (v > maxVal) maxVal = v;
      }
  
      if (maxVal > 0) {
          const inv = 1 / maxVal;
          for (let i = 0; i < n; i++) out[i] *= inv;
      }
  
      return out;
  }
  
  // Rank image tiles by perceptual importance (descending score).
  //
  // saliency: Float32Array from computeSaliencyField(), length = width*height.
  // information: Float32Array from computeInformationField(), same length, or null.
  // tileSize: tile edge in pixels (tiles are tileSize×tileSize; edge tiles are smaller).
  //
  // Returns sorted array: [{ x, y, score }, ...], highest score first.
  // Tile score = average saliency (+ average information if provided, weighted 50/50).
  export function rankTiles(saliency, information, tileSize, width, height) {
      const tilesX = Math.ceil(width / tileSize);
      const tilesY = Math.ceil(height / tileSize);
      const tiles = [];
  
      for (let ty = 0; ty < tilesY; ty++) {
          for (let tx = 0; tx < tilesX; tx++) {
              const x0 = tx * tileSize;
              const y0 = ty * tileSize;
              const x1 = Math.min(x0 + tileSize, width);
              const y1 = Math.min(y0 + tileSize, height);
  
              let salSum = 0, infoSum = 0, count = 0;
              for (let py = y0; py < y1; py++) {
                  const row = py * width;
                  for (let px = x0; px < x1; px++) {
                      const idx = row + px;
                      salSum += saliency[idx];
                      if (information !== null) infoSum += information[idx];
                      count++;
                  }
              }
  
              const salScore = count > 0 ? salSum / count : 0;
              const score = (information !== null && count > 0)
                  ? 0.5 * salScore + 0.5 * infoSum / count
                  : salScore;
  
              tiles.push({ x: x0, y: y0, score });
          }
      }
  
      tiles.sort((a, b) => b.score - a.score);
      return tiles;
  }
  ```

- [ ] **Step 2: Syntax-check the file with Node**

  ```powershell
  node --input-type=module --check < web\jxl-butteraugli.js
  ```

  Expected: No output (clean parse). If you see a SyntaxError, fix it before continuing.

- [ ] **Step 3: Stage the resolved file**

  ```powershell
  git add web/jxl-butteraugli.js
  ```

---

## Task 4: Verify Auto-Merged Files

- [ ] **Step 1: Check git status**

  ```powershell
  git status
  ```

  Expected: All files staged; nothing in "both modified" state. The only files that should remain "modified" (not staged) are none — everything should be staged.

- [ ] **Step 2: Spot-check StandardMultifileTest.mjs is present and correct**

  ```powershell
  node --input-type=module --check < StandardMultifileTest.mjs
  ```

  Expected: No output (clean parse).

- [ ] **Step 3: Spot-check CLAUDE.md picked up the AfternoonWork15Jun update**

  ```powershell
  Select-String "forward-declaration" CLAUDE.md
  ```

  Expected: Finds the line `The old jxl_wasm_transcode_jpeg_to_jxl forward-declaration blocker is resolved`. If not found, CLAUDE.md auto-merge may have taken the wrong version — manually inspect and apply the diff.

- [ ] **Step 4: Verify .gitattributes is present**

  ```powershell
  Test-Path .gitattributes
  ```

  Expected: `True`. This file was added by AfternoonWork15Jun and should now exist.

- [ ] **Step 5: Verify Cargo.toml has the parallel feature**

  ```powershell
  Select-String "parallel = " Cargo.toml
  ```

  Expected: `parallel = ["raw-pipeline/parallel"]` found.

---

## Task 5: Run Tests

- [ ] **Step 1: Run full test suite**

  ```powershell
  npm test 2>&1 | Select-String "(pass|fail|✓|✗|error TS)" | Select-Object -First 40
  ```

  Expected:
  - `jxl-scheduler`: 30 pass, 0 fail (same as baseline)
  - `jxl-worker-browser`: pre-existing `worker.ts(274,15): error TS2339` — acceptable
  - No NEW failures compared to baseline

  If you see new test failures that were not in the baseline, STOP and diagnose before continuing.

- [ ] **Step 2: Quick smoke test of the merged butteraugli module**

  ```powershell
  node --input-type=module -e "
  import {
    pixelsToXyb, pixelsToXybInto, createButteraugliComparer,
    computeButteraugliVsFinal, computeButteraugliApproxVsFinal,
    computeButteraugliRegion, computeSaliencyField, rankTiles,
    registerBackend, registerInformationBackend, computeInformationField
  } from './web/jxl-butteraugli.js';
  
  const n = 4 * 4;
  const ref = new Uint8Array(n * 4).fill(128);
  const test = new Uint8Array(n * 4).fill(200);
  const refXyb = pixelsToXyb(ref, n);
  
  const score = computeButteraugliVsFinal(refXyb, test, 4, 4);
  console.assert(typeof score === 'number' && !isNaN(score), 'computeButteraugliVsFinal returned NaN');
  console.assert(score > 0, 'non-identical images should score > 0');
  
  const approx = computeButteraugliApproxVsFinal(refXyb, test, 4, 4);
  console.assert(typeof approx === 'number' && !isNaN(approx), 'approxVsFinal returned NaN');
  
  const comparer = createButteraugliComparer(ref, 4, 4);
  const cScore = comparer(test);
  console.assert(typeof cScore === 'number' && !isNaN(cScore), 'comparer returned NaN');
  console.assert(Math.abs(score - cScore) < 0.001, 'comparer score should match computeVsFinal');
  
  const region = computeButteraugliRegion(refXyb, test, 0, 0, 4, 4, 4);
  console.assert(typeof region.score === 'number', 'region.score missing');
  console.assert(typeof region.maxError === 'number', 'region.maxError missing');
  console.assert(region.location && typeof region.location.x === 'number', 'region.location missing');
  
  const saliency = computeSaliencyField(refXyb, test, 4, 4);
  console.assert(saliency instanceof Float32Array && saliency.length === n, 'saliencyField wrong');
  
  const tiles = rankTiles(saliency, null, 2, 4, 4);
  console.assert(Array.isArray(tiles) && tiles.length === 4, 'rankTiles wrong length');
  
  const outX = new Float32Array(n), outY = new Float32Array(n), outB = new Float32Array(n);
  pixelsToXybInto(ref, n, outX, outY, outB);
  const [rX2] = pixelsToXyb(ref, n, outX, outY, outB);
  console.assert(rX2 === outX, 'pixelsToXyb with outX should return the same buffer');
  
  console.log('All butteraugli smoke tests PASSED');
  "
  ```

  Expected: `All butteraugli smoke tests PASSED`. If any assertion fires, a `console.assert` error prints — fix the merged file before continuing.

---

## Task 6: Verify StandardMultifileTest.mjs

- [ ] **Step 1: Check the file exists and has the jxl-wasm WASM binary loading fix**

  ```powershell
  Select-String "wasmBinary" StandardMultifileTest.mjs | Select-Object -First 3
  ```

  Expected: Lines containing `wasmBinary` (the fix from commit c6f1899b that was missing from LateNight16June).

- [ ] **Step 2: Syntax check**

  ```powershell
  node --check StandardMultifileTest.mjs
  ```

  Expected: No output. (Note: runtime execution requires actual RAW files on disk which may not be present in CI; syntax check is sufficient here.)

---

## Task 7: Commit the Merge

- [ ] **Step 1: Confirm all staged**

  ```powershell
  git status
  ```

  Expected: `All conflicts fixed but you are still merging.` All files staged, nothing left unstaged.

- [ ] **Step 2: Create the merge commit**

  ```powershell
  git commit -m "$(cat <<'EOF'
  merge: AfternoonWork15Jun → LateNight16June
  
  Recovers StandardMultifileTest.mjs (WASM loading fix, c6f1899b) and
  ~50 commits including: SIMD tone pipeline, perceptual WASM kernel,
  prepRef ref-caching, createButteraugliComparer factory, CR2/DNG/LJPEG
  hardening, encode-session/jxl-roundtrip fixes, pyramid cache/manifest.
  
  Conflict resolution (web/jxl-butteraugli.js):
  - Adopted AfternoonWork's scaleErr(mask,...) + prepRef() WeakMap cache
    (fixes LateNight aliasing bug in scratch-pool downsample loop)
  - Kept LateNight's backend abstraction, region scoring, saliency field,
    tile ranking, pixelsToXybInto, boxBlurInto, dn2Into
  - Merged pixelsToXyb to accept optional outX/outY/outB (both branches)
  - Dropped createButteraugliScratch/ensureScratch (no longer needed)
  
  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
  EOF
  )"
  ```

  Expected: Commit created. `git status` shows clean working tree.

- [ ] **Step 3: Final verification**

  ```powershell
  git log --oneline -5
  git show --stat HEAD
  ```

  Expected: Merge commit at top with both parent SHAs visible. Stat shows the merged files.

---

## Spec Coverage Check (self-review)

| Requirement | Covered by |
|---|---|
| StandardMultifileTest.mjs recovered | Task 6 |
| Single conflict resolved correctly | Task 3 |
| Aliasing bug fixed | Task 3 (prepRef replaces scratch-pool in computeButteraugliVsFinal) |
| All features from both branches preserved | Task 3 (full merged file) |
| Lock file handled | Task 2 |
| Tests pass | Task 5 |
| Smoke test all merged exports | Task 5 Step 2 |
| Merge commit created | Task 7 |
| No new regressions vs baseline | Task 5 Step 1 comparison |
