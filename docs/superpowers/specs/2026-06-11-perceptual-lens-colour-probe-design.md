# Design Spec — Perceptual Lens + Colour Probe (v1)

**Date:** 2026-06-11
**Status:** approved design, pre-implementation
**Theory grounding:** `docs/Non-Riemannian Fable Max Overview.md` §3.1 (Perceptual Constancy),
§3.3 (diagnostic colour), Appendix C.1 (Carnot/opponent colour-difference reading). Honesty rules:
`feedback-highlight-preservation` (never raise global exposure), `feedback-colour-pipeline` (trust
camera WB), `feedback-claim-fixed-only-after-user-tests` (report numbers; user confirms in viewer).

---

## 1. Goal & scope

A lightbox tool with two coupled features that share one forward colour transform:

1. **Perceptual Lens** — a toggle + strength slider that *homogenises vegetation/flowers under
   changing light* (cancels the illuminant cast, then compresses chroma and lightness *spread*), so a
   leaf or petal reads consistently across sun / shade / cloud.
2. **Colour Probe** — once the Lens tool is active, *click a pixel* to read its illumination-normalised
   diagnostic colour (hue, raw chroma, damped saturation, lightness) in a small readout.

**Display-layer only.** Operates on the lightbox display buffer; never mutates the decode cache or raw
pixels. **Off by default.**

**In scope (v1):** the JS transform; the Lens UI (toggle, strength, lightness-compression checkbox);
click-probe readout; the **global colour-range selector** (click → select that colour *everywhere* in
the image, Ctrl+click to accumulate/coalesce, traced border + opacity overlay, tolerance control,
coverage readout, clear); unit tests.
**Out of scope (v1, deferred):** categorical "grain" metric + Zenodo LUT; WASM `LookRenderer` port;
magic wand; multispectral / base-extension; Fréchet-mean probe; exporting diagnostics to sidecars;
"hard" hue-map mode (Overview §4.1 — a one-line future toggle that replaces L with a constant).

**Future directions captured from review (next slices, built on the same operators):**
- **Interactive colour-space histogram.** A 2-D `a*b*` cloud (plus a 1-D `L*` strip) that visualises the
  selected colour region and lets it be **bounded and extended by dragging** within it — the widget that
  follows the v1 selector (which uses a numeric tolerance for now).
- **"Revive" mode** (faded herbarium specimens): white-normalise to the paper + **chroma *expansion***
  (the *inverse* of constancy damping) to restore legibility/vibrancy — a trivial Φ variant.
- **Two-image registration/alignment** (homography) to overlay same-scene different-light pairs for a
  pixel-level convergence diff; the overlap view shrinks slightly. Separate CV feature.

**Deliberate divergence from the Overview doc's phased plan (§6).** The doc orders metric-core-in-Rust →
colormaps → diagnostic → wand → constancy-*last*. v1 instead builds **constancy + probe first, as a JS
display prototype** — chosen for a fast visible win to explore images now. The Rust/WASM port (the doc's
real home, `colour_geometry.rs` + `LookRenderer`) follows, made drop-in by the five-operator API (§3.2).
The v1 patch-mean probe is a deliberate simplification of the doc's Fréchet-mean (negligible bias on a
3–5 px patch); Fréchet is flagged for the diagnostic slice.

---

## 2. Architecture

**Module split (design-for-isolation):**

- **`web/perceptual-color.js`** — pure, DOM-free ESM. All maths and operators. Unit-testable in
  Node/bun with no browser. Stable function signatures so the same contract ports to the Rust/WASM
  `LookRenderer` later.
- **`web/main.js`** — thin integration: lens state, a single `applyPerceptualLens()` orchestrator
  wired to the existing canvas-snapshot seam, the click-probe handler, and UI event wiring.
- **`web/index.html` (+ existing stylesheet)** — the small control group and readout element.

*Rejected alternatives:* inline maths in `main.js` (couples maths to UI, untestable, bloats a large
file); Web Worker offload (premature — debounce + a future LUT suffice).

**Integration seam.** The same point the Straighten tool uses (`applyStraightenToLightboxCanvas` /
`setCleanCanvas`): after the decode/look draw produces `lightboxCanvas` and the **clean-canvas snapshot**
(pristine post-look pixels), `applyPerceptualLens()` runs as a post-process. It **reads the clean
snapshot, writes only the display canvas, and never overwrites the snapshot** — so toggling the Lens off
redraws the clean image with zero re-decode. Zoom/pan reuse the transformed canvas (no per-frame cost).
Re-runs only on: toggle flip, strength/lightness change, new look (`lightbox_live`), or new decode.

---

## 3. The forward transform (`perceptual-color.js`)

Opponent space for v1 = **CIELAB** (D65): unambiguous, exact, perceptually-uniform-ish, easy to test.
Exposed behind `toOpponent()/fromOpponent()` so **XYB drops in later** without touching callers (the
documented JXL-aligned target; swapping is a one-function change). Chromatic adaptation is done in
**LMS** (Bradford matrix) before Lab, standard CIECAM-style.

Per pixel, on the displayed buffer, with strength `σ ∈ [0,1]`:

1. **sRGB → linear** (standard sRGB EOTF).
2. **linear sRGB → XYZ → LMS** (Bradford; XYZ is the shared hub).
3. **Illuminant cancel (von Kries):** `LMS' = LMS · (canonicalWhiteLMS / sceneWhiteLMS)`, interpolated
   by `σ`. `sceneWhiteLMS` estimated **once per image** (see §3.1). Cancels warm-sun / blue-shade cast.
4. **LMS → XYZ → Lab.** Opponent `(a*, b*)`, lightness `L*`,
   `chroma = √(a*²+b*²)`, `hue = atan2(b*, a*)`.
5. **Non-Riemannian chroma damping (core):** `c_out = (1−σ)·c + σ·Φ(c)`, hue preserved (scale `a*,b*`
   by `c_out/c`). `Φ` concave, monotonic, `Φ(0)=0`, `Φ'(0)=1` (small differences untouched), saturating
   for large `c`. Default `Φ(c) = c_knee · ln(1 + c/c_knee)` (Bujack's log best-fit), `c_knee ≈ 30`
   (Lab chroma units, tunable). Compresses chroma *spread* → sunlit vs shaded leaf converge.
6. **Lightness spread-compression (shoulder-aware):** pull `L*` toward the image's robust mid-lightness
   `L_mid`, scaled by `σ`, with a **shoulder that protects the top band so no highlight is brightened**:
   `L_out = L − σ·k·(L − L_mid)·shoulder(L)`, `shoulder(L) → 0` for `L` above ~the 85th percentile,
   `k ≤ 0.3`. **Never increases L near the top; never a global gain.** (Included in v1 per decision;
   toggle-able via the lightness checkbox.)
7. **Lab → XYZ → linear sRGB → sRGB**, write to display, clamp to gamut.

### 3.1 Per-image stats (computed once per image / look-change from the clean snapshot)
- **Scene white (von Kries):** blend of **gray-world** mean LMS and the mean LMS of the **brightest
  non-clipped ~2%** by luminance; clamp each channel away from zero to avoid divide blow-ups. Explicitly
  a heuristic — flagged in UI copy and the doc.
- **Lightness stats:** robust mid-lightness `L_mid` (median `L*`) and the shoulder threshold (~85th
  percentile `L*`) for step 6. `applyLens` computes both before the per-pixel loop.

### 3.2 Module API

**Public — the five canonical operators** (the Overview doc's engine; trivial in Lab for v1, but named
so the future XYB/geodesic and Rust `colour_geometry` ports are drop-in replacements):
```
neutralOf(lab)      -> [L,0,0]                 // equal-lightness gray (Lab neutral axis)
hueClassOf(lab)     -> hueDeg = atan2(b,a)
saturationOf(lab)   -> Phi( sqrt(a*a+b*b) )    // damped distance to neutral
lightnessOf(lab)    -> L
phiDampedDistance(labA,labB) -> concave-Φ-damped Lab distance  // the v1 perceptual metric (renamed from the doc's generic `distance`)
```
**Consumers (thin) & selection (pure, typed-array in/out):**
```
applyLens(rgbaU8, w, h, opts) -> rgbaU8                 // Lens render; orchestrates steps 1–7; new buffer
normalizedLabBuffer(cleanRgbaU8, w, h, sceneWhiteLms) -> Float32Array   // §4.1, cached per image
probe(labBuf, w, h, x, y, radius) -> { hueDeg, chroma, dampedSaturation, lightness }   // patch mean → operators
selectByColour(labBuf, w, h, seedLab, tolerance) -> Uint8Array          // global phiDampedDistance threshold
unionMask(maskA, maskB) -> Uint8Array
maskBorder(mask, w, h) -> Uint8Array                   // boundary pixels (selected with an unselected 4-neighbour)
maskCoverage(mask) -> { fraction, regionCount }
```
**Internals (helpers):**
```
srgbToLinear/linearToSrgb · linearRgbToXyz/xyzToLinearRgb · xyzToLab/labToXyz
xyzToLms/lmsToXyz (Bradford) · estimateSceneWhiteLms · estimateLightnessStats
vonKriesAdapt(lms, sceneWhiteLms, sigma) · dampChroma · compressLightness
```
The lens and probe are **thin consumers of the five operators**, matching the Overview doc's
"everything is a consumer of the operators" architecture — so swapping Lab→XYB or JS→Rust later changes
only the internals.

---

## 4. Click tools — Colour Probe & Global Selector

Active only when the Lens tool is on. Both read the **clean, pre-lens** pixels through one shared,
illumination-normalised representation. **One gesture drives both:** a click probes *and* selects that
colour; Ctrl+click adds to the selection.

### 4.1 Shared: the normalised-Lab buffer (`labBuf`, computed once per image)
On tool activation / first click — invalidated on new decode, look change, or scene-white change — build
`labBuf`: a `Float32Array` of length `3·w·h` holding, per pixel, **von-Kries-normalised → Lab**
`(L*,a*,b*)`. This is each pixel's *intrinsic* (illumination-factored) colour. Both tools operate on
`labBuf`, so per-click cost is just a threshold pass — and selection/readout are robust to a flower's own
sun/shade (the whole point).

### 4.2 Colour Probe — read one colour
On click, map client→canvas px (zoom/pan/rotation aware), average a small patch (radius ~3–5 px) of
`labBuf`, and report `{ hueDeg = hueClassOf, chroma = √(a²+b²), dampedSaturation = saturationOf (full Φ,
σ-independent), lightness = lightnessOf }` — the swatch-free, illumination-factored "true" colour.
(Arithmetic patch mean for v1; Fréchet mean flagged later — negligible bias at this patch size.)

### 4.3 Global Colour-Range Selector — find that colour everywhere
- **Click (set):** the patch-mean Lab is the **seed**; build a mask of *all* pixels with
  `phiDampedDistance(labBuf[i], seed) ≤ tolerance` — **global, not connected** (unlike a magic wand).
- **Ctrl+click (add):** union the new colour's matches into the mask and **coalesce** (recompute the
  border over the union). Seeds accumulate in a list; the readout lists them.
- **Render (overlay, cache-pure):** the mask draws onto a **separate overlay canvas** stacked over the
  lightbox canvas under the same zoom/pan transform — never touching the decode cache or the lens display
  buffer. Two layers: a semi-transparent **tint** over selected pixels, and a 1–2 px **border** along the
  mask boundary (selected pixel with an unselected 4-neighbour). Redrawn only when the mask or viewport
  changes.
- **Controls & readout:** a **tolerance** slider (`phiDampedDistance` units), a **clear** button, and a
  readout of the seed colour(s)' diagnostics plus **coverage** ("12.3% of image, N regions").
- **Performance:** `labBuf` precompute is the only O(N) Lab conversion (once per image, ~50–150 ms at
  1800 px); each click is an O(N) threshold; overlay render is O(N) per mask change — all fine at click
  cadence, never per-frame. **No JXL re-decode is triggered** (cache purity).

---

## 5. UI

A compact "Perceptual Lens" control group in the lightbox controls:
- **Tool toggle** (on/off, off by default) — enables the lens render *and* the click tools.
- **Strength** slider 0–100% (`σ`).
- **Lightness compression** checkbox (on by default).
- **Tolerance** slider — selection breadth in `phiDampedDistance` units.
- **Clear selection** button.
- **Readout** box: seed colour(s)' diagnostics (hue°, chroma, saturation, lightness) + **coverage**
  ("12.3% of image, N regions"); hint ("click a colour") when active and empty.

**Gesture (unified):** click = probe *and* set-selection to that colour; **Ctrl+click** = add the colour
to the selection (accumulate/coalesce). A **selection overlay canvas** sits over the lightbox canvas
(tint + border), sharing its zoom/pan transform.

Matches existing slider/control styling. New DOM in `index.html`; minimal CSS reuse.

### 5.1 main.js wiring
- **Lens state:** `perceptualLens = { on:false, strength:1.0, lightness:true, sceneWhiteLms:null, dirty:true }`.
- **Selection state:** `colourSelect = { seeds:[], mask:null, tolerance:T0, labBuf:null }`; `labBuf` and
  `mask` invalidated whenever `dirty`.
- `applyPerceptualLens()`: if `!on` → redraw clean snapshot; else (re)compute `sceneWhiteLms` if dirty,
  `applyLens` on the clean snapshot → `putImageData` to `lightboxCanvas`. Never overwrites the clean
  snapshot.
- `refreshSelectionOverlay()`: build `labBuf` via `normalizedLabBuffer` if dirty; draw mask tint+border
  into the overlay canvas under the current zoom/pan. Called on mask change and viewport change.
- Hook both at the end of the draw / `lightbox_live` path (after `setCleanCanvas`) and on
  toggle/slider/checkbox/tolerance change (debounced ~80 ms). New look / new decode → `dirty=true`.
- **Click handler** on `lightboxCanvas`, gated on `perceptualLens.on`: map client→canvas px;
  `probe(labBuf,…)` → readout; `selectByColour(labBuf,…,seed,tolerance)`; if Ctrl held → `unionMask` into
  existing + push seed, else seeds=[seed]; recompute coverage; `refreshSelectionOverlay()`.
- Expose `window.perceptualLensRefresh()` for external triggers (crop/straighten redraw, viewport change).

---

## 6. Testing (TDD — write tests first)

Pure-function unit tests on `web/perceptual-color.js` (Node/bun, no DOM):

1. `srgbToLinear`∘`linearToSrgb` round-trip < 1e-6.
2. `linearRgbToLab`∘`labToLinearRgb` round-trip < 1e-3 on random in-gamut colours.
3. `linearRgbToXyz`∘`xyzToLinearRgb` and `xyzToLms`∘`lmsToXyz` (Bradford) round-trips < 1e-6.
4. `dampChroma`: `σ=0` ⇒ identity; output chroma monotonic increasing in input; **concave** (increment
   at large c < increment at small c); hue (`atan2(b,a)`) preserved.
5. `compressLightness`: `σ=0` ⇒ identity; for `L` in the top shoulder, `L_out ≤ L` (no brightening);
   reduces variance of a spread set of `L`s.
6. `vonKriesAdapt`: synthetic uniformly-cast image → post-adapt gray-world residual near canonical
   white; `σ=0` ⇒ identity.
7. `applyLens` with `σ=0` ⇒ output equals input within rounding (the no-op guarantee).
8. Convergence: synthetic "same Lab hue, two lightness+cast variants" → hue spread after lens < before.
9. `phiDampedDistance`: 0 for identical; symmetric; >0 for different; grows **sub-linearly** with Lab gap
   (diminishing returns); >0 for equal-`L`/equal-chroma but different hue.
10. `normalizedLabBuffer`: length `3·w·h`; on a uniformly-cast synthetic image the white region maps near
    neutral `(a,b)≈0`.
11. `selectByColour`: planted-colour patch → mask matches at suitable tolerance; tolerance↑ ⇒ mask grows
    monotonically; a **two-illuminant** version of the seed colour both select (illumination robustness).
12. `unionMask` correct union; `maskBorder` on a solid square = its perimeter; `maskCoverage.fraction`
    correct on a known mask.

---

## 7. Honesty guardrails (baked in)

- Off by default; **display-only / cache-pure** (verified by: toggling/sliding triggers no re-decode).
- **Never raises global exposure** — lightness step is shoulder-protected spread-compression only.
- Scene-white estimate and off-axis `Φ` are **heuristics**; UI copy says so; the probe **reports
  numbers**, and success is confirmed by the user in the real viewer before any "it works" claim.

---

## 8. Success criteria

- Lens visibly homogenises a multi-illuminant leaf/flower set; vegetation hue spread shrinks.
- Probe returns stable illumination-normalised coordinates across the same specimen under different light
  (variance reported; user confirms usefulness).
- Selector finds a colour across the **whole frame** including its own sun/shade; Ctrl+click accumulates;
  border+tint overlay is **cache-pure** (overlay only, no re-decode).
- `σ=0` is a provable no-op; toggle/slider/tolerance cause **no** JXL re-decode (cache purity).
- All §6 unit tests green.

## 9. Files

- **New:** `web/perceptual-color.js` (transform + operators + selection fns), `web/perceptual-color.test.mjs`.
- **Edit:** `web/main.js` (lens + selection state, `applyPerceptualLens`, `refreshSelectionOverlay`,
  unified click/Ctrl-click handler, refresh hook), `web/index.html` (control group + readout + selection
  **overlay canvas**), existing stylesheet (minimal).

## 10. Validation set (user-supplied ORFs)

Loaded **in-app** for visual confirmation — *not* read by the build; unit tests use synthetic colours.
Under `c:\995\2026-02-20 Gobabeb To Windhoek\`:
- `Gobabeb Herbarium\P2200469.ORF` — herbarium specimen. Tests illuminant-cancel → paper toward neutral
  + diagnostic probe; motivates the "revive" (chroma-expand) mode.
- `P2200617.ORF` + `P2200616.ORF` — same scene, two brightnesses (cloud-cover surrogate). Tests
  constancy convergence; registration deferred.
- `P2200686.ORF` — portrait in shadow (dark). Tests blue open-shade cast removal + gentle shadow-lift;
  skin as a probe target.
- `P2200700.ORF` — landscape. Headline vegetation constancy.

Hyperspectral deferred to the multispectral slice.
