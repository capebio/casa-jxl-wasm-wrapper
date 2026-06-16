# Non-Riemannian Colour for a Biodiversity Imaging Platform — Fable Max Overview

> **What this document is.** A grounded concept-and-plan paper for bringing non-Riemannian
> perceptual colour mathematics into the lightbox, the (new) magic-wand selector, diagnostic
> colour extraction, and swatch reduction — with a deliberate focus on **how the maths threads
> through JPEG XL**. It is written for an ecology/biodiversity workflow: specimens photographed in
> the field under clouds, dappled canopy, and direct sun, where we want vegetation and flowers to
> read *the same* regardless of the light that fell on them.
>
> **Relationship to the other two docs.** There are now three:
> - `docs/Non-Riemannian-Color-Space-Applications.md` — the **earliest draft**. Leans on terms that
>   appear in **no** source paper ("Molchanov anisotropy", "Harvard HPCS", a "sensor-sharpening matrix
>   B", "log-transform cancels illumination"). **Superseded**; see the *Reject on sight* notes.
> - `docs/Non-Riemannian-Colour-Mathematics-Exploration.md` — a **grounded sibling** (prior session).
>   Strong on the shared engine, the geodesic algorithm, and a broad list of uses. Still valid; this
>   document **consolidates** its load-bearing engineering into one place and adds the deeper JPEG XL
>   integration. Where it goes wider on collection-scale uses, this doc points to it rather than
>   repeating.
> - **This doc** is the consolidated, JXL-centred overview. Where any two disagree, trust this one and
>   the honesty boxes below.

---

## 0. The one-paragraph version

Human colour vision underestimates *large* colour differences (the "diminishing returns" effect),
which means perceptual colour space is **not Riemannian**: you cannot get a big colour difference by
adding up small just-noticeable steps along a path (Bujack et al., 2022). The good news for
engineering is that a 2025 follow-up shows you can still **model** it as the familiar Riemannised
ΔE2000 metric with a single concave *damping function* layered on top — the exotic geometry collapses
to "ΔE2000, then squash the magnitude." That same body of work gives purely geometric definitions of
**lightness, hue, saturation, and the neutral (gray) axis** derived from the metric alone. We can use
those definitions to (a) factor illumination out of a specimen's colour so flowers look invariant
under changing light, (b) make a magic-wand selector that *sticks to a flower* across shadow and
sun, and (c) extract a **swatch-free diagnostic colour** for a species. JPEG XL is unusually well
suited as the substrate because its native internal space, **XYB**, is already a cone-derived
*opponent* space (the same red–green / blue–yellow structure these definitions need), because JXL
**extra channels** let us bake an illumination-invariant or diagnostic-colour layer directly into the
image file so it travels offline with the specimen, and because the perceptual metric can sharpen
JXL's own **bit-allocation / convergence cutoff** (§2.6).

---

## 1. The science, stated precisely (and honestly)

Five papers in `Papers/Non-Riemannian/` carry the load. Read in this order:

| Paper | What it establishes | File |
|---|---|---|
| Bujack et al. 2022, *PNAS* | Diminishing returns ⇒ colour space is non-Riemannian | `bujack-et-al-2022-…color-space.pdf` / `The non-Riemannian nature of perceptual color space.md` |
| Bujack et al. 2025, *CGF* | Geometric hue/sat/lightness + neutral axis; the practical reprieve | `Computer Graphics Forum - 2025 - Bujack…pdf` / `The Geometry.md` |
| Griffin & Mylonas 2019, *PLOS ONE* | Categorical (colour-naming) metric; downloadable tensor field | `Categorical colour geometry.md` |
| Zeyen et al. | Shortest-path interpolation in non-Euclidean colour; coarse-path pitfall | `Color Interpolation for Non-Euclidean Color Spaces…md` |
| Burambekova & Shamoi 2024 | Survey of colour models vs perception; justifies not doing wand maths in RGB/HSL | `Comparative Analysis.md` |

### 1.1 Diminishing returns ⇒ non-Riemannian (Bujack 2022)

For a space to be Riemannian, distances must be **additive along a geodesic**: if `B` lies on the
shortest path between `A` and `C`, then `D(A,C) = D(A,B) + D(B,C)`. Bujack et al. ran a
two-alternative-forced-choice triad study (320 triads, ≥250 observers each, on the neutral gray
axis) and showed the strict inequality instead:

$$D(A,C) \;<\; D(A,B) + D(B,C)$$

i.e. a large difference is perceived as **less** than the sum of its small parts. This is *stronger*
than the triangle inequality (it holds even along the geodesic), and it is fatal to the
century-old Riemannian paradigm. A concrete measured datapoint: a neutral-axis spacing of
ΔL = 15 was perceived as ≈ 1.36 units; doubling the physical spacing to ΔL = 30 was perceived as only
≈ 2.06 — a 1.5× perceptual gain for a 2× physical change. The best-fit difference-scaling function is
**concave and approximately logarithmic**, which the authors read as a hint at a *second-order
Weber–Fechner law* (the brain compresses differences the way it already compresses absolute
intensity). They illustrate the practical sting with the **intrinsic mean of a photograph**: under a
non-additive metric the "average grey" of an image is **not** the arithmetic mean — a fact we reuse
for ROI colour extraction (§3.3).

**Direct engineering consequence:** ΔE2000 / CIEDE2000 are valid **only for small differences**.
Concatenating them across a whole flower-vs-background span over-states the difference. Any tool that
thresholds large colour distances (magic wand, palette spacing, encode cutoff) needs the damping.

### 1.2 The practical reprieve (Bujack 2025)

The 2025 CGF paper is the one that makes this *buildable*. Three results matter to us:

1. **Geometric colour attributes.** Following Helmholtz/Schrödinger, hue, saturation and lightness
   can be defined from the perceptual metric alone — no external white reference:
   - *Lightness*: a colour `F` has the lightness of the closest gray reachable along its
     stimulus-quality path to black.
   - *Hue*: colours sharing the shortest path (within an equal-lightness surface) to the neutral
     axis.
   - *Neutral axis*: within each equal-lightness surface, **the colour closest to black**. (This
     definition is *only* coherent in a non-Riemannian space — in a Riemannian one every point on the
     surface is equidistant from black, so no unique "gray" exists.)

2. **Bezold–Brücke fix.** Perceived hue drifts as intensity changes (a colour darkens toward pure
   red/green/blue). So "constant hue" is **not** a straight line from black; it is a *geodesic* from
   the black apex. Equal-hue surfaces embedded in CIE RGB are visibly curved (their Fig. 2).

3. **The reprieve itself.** Their experiments could **not** reject the hypothesis that shortest paths
   in the true non-Riemannian metric coincide with shortest paths in its *induced* Riemannian metric
   (Theorem 1 proves point-to-point paths coincide; the experiments fail to find a difference for the
   point-to-set "closest gray" case once response bias is removed). Their words: this "would justify
   modeling the non-Riemannian metric as it has been done in the past as a Riemannian metric **but
   with a dampening scaling function on top**."

> **This is the single most useful sentence in the whole literature for us.** The implementation is
> not exotic differential geometry. It is: compute a Riemannised ΔE2000 (or work in CIELAB / XYB),
> then apply one monotone concave scalar `f(·)` to the chroma magnitude / arc length. The
> non-Riemannian behaviour falls out of that scalar. And because the two geodesics coincide, we can
> solve the *smooth geodesic ODE* on the metric instead of a graph search (§3.0).

### 1.3 Categorical geometry (Griffin & Mylonas 2019)

A *different* metric, built not from discriminability but from **what people call colours**. 1,000
subjects gave 20,000 unconstrained names to 600 chips; via Information Geometry (Fisher / Bhattacharya
on the name-distribution) they computed a Riemannian metric over the whole RGB cube. Two colours are
"close" if a population *names them the same way*, regardless of JND spacing. Key facts we can use:

- The natural unit is a **"grain"** (separation between two name-distributions with nothing in
  common). About **27 categorically-distinct regions** fit in the sRGB cube — matching the ~30
  colours untrained speakers name. That is a principled basis for a *maximally-distinct swatch set*.
- The metric is demonstrably **not** CIEDE2000 (95% of local distortions between them span
  60–168%). It runs **fast near the achromatic axis** and **faster for saturation than hue** changes.
- **The tensor field is published as a downloadable 3-D grid** (Zenodo `10.5281/zenodo.2595963`,
  spacing Δ/2 ≈ 5 CIELAB units). We do **not** have to recompute it — it ships as a small LUT asset.

### 1.4 Interpolation & the coarse-path pitfall (Zeyen et al.)

Zeyen et al. generalise linear interpolation to "walk the shortest path under an arbitrary distance
measure": build a graph on an RGB grid (26-neighbourhood), weight edges by ΔE2000, run Dijkstra. A
16³ grid with neighbourhood 1 was the speed/quality sweet spot (~0.1 s); finer grids barely move the
path. **Their crucial caveat:** because of diminishing returns, *graph path length gives a false
advantage to coarse paths* — summing a few long hops under-counts versus many short ones. Measure path
length by a **supremum over fine samples**, not by summing coarse hops. This directly governs how we
aggregate ROI colour (§3.3): do not average naively.

### 1.5 Honesty box — what is *not* established

> - **The damping shape is measured only on the gray axis.** Bujack's `f` was fit on the neutral
>   axis. Applying it to a *saturated* flower's chroma is an **extrapolation**. Treat any
>   chroma-compression curve off-axis as a tunable hypothesis and calibrate against real specimens —
>   `f` is *data, not a constant*. (Cf. `feedback-claim-fixed-only-after-user-tests`.)
> - **Non-Riemannian maths does not, by itself, cancel illumination.** A logarithm/cube-root is a
>   *first-order* Weber–Fechner compression; it does **not** remove a change of light source. The
>   earliest draft's "log-transform flattens geodesics and cancels illumination" conflates two
>   separate things. Illumination invariance is **chromatic adaptation** (a white-point shift in
>   cone/LMS space, i.e. von Kries) *plus* lightness-class normalisation (Schrödinger lightness) —
>   see §3.1. The non-Riemannian part's job is to make whatever chroma *remains* perceptually
>   homogeneous.
> - **ΔE2000 is not strictly a metric** — it can violate the triangle inequality (Sharma et al.).
>   For anything that assumes metric axioms (geodesics, means), use the **Riemannised** ΔE2000, not
>   the raw formula.
> - **No named "Molchanov tensor / Akleman sub-millisecond AR / Harvard HPCS" pipeline is in these
>   papers.** Those appear in the earliest draft without a source in this folder. Omitted here.
>   (Akleman's illumination/shading *split* is at most a loose architectural analogy, not a colour
>   metric.) We build only on what the papers above actually support.
> - **The non-Riemannian claim itself is contested.** Berthier & Provenzi (2023, in this folder)
>   argue Bujack's inference is unsound — the experiment conflates two different distances and `L*` is
>   a poor achromatic coordinate — so a suitable *Riemannian* metric is not ruled out. Their
>   alternative is no less exotic: colour as **quantum states on a hyperbolic chromaticity plane**
>   (Appendix A). Treat "non-Riemannian" as a strong, useful *modelling stance*, not settled fact; the
>   exotic toolkit in Appendix A is what *both* camps use, so we build on the common substrate.
> - **Independent corroboration, with two caveats (Brainard 2022).** David Brainard's PNAS commentary
>   *Proximity matters* — written about the Bujack paper — accepts the core result (the non-Riemannian
>   MLE model beats the Riemannian one; large differences *saturate* relative to the Riemannian
>   prediction = diminishing returns) and concludes that Euclidean/Riemannian colour spaces "need to be
>   regarded as approximations." But he flags two limits we adopt: (1) Bujack *assumes* the achromatic
>   (neutral) axis is a geodesic — "not empirically established" (the 2025 neutral-axis experiments only
>   partly shore this up); and (2) the data is **aggregated across online observers**, so the
>   *aggregate* could be non-Riemannian even if each individual observer is Riemannian. Both reinforce:
>   build on the metric as an approximation, validate per-context, never as ground truth.

---

## 2. Why JPEG XL is the right substrate

This is the heart of the request: *the relationship and integration between non-Riemannian colour
mathematics and JPEG XL.*

### 2.1 XYB is already the opponent space the maths wants

JXL's native lossy space is **XYB**, derived from the human **LMS cone responses**: linear RGB → LMS
→ add bias and take a **cube-root** nonlinearity (the opsin/gamma step) → form opponent channels:

- **X** ≈ (L′ − M′) — a **red–green** opponent axis,
- **Y** ≈ (L′ + M′) — luminance,
- **B** ≈ S′ — a **blue–yellow**-leaning axis.

Two things follow that no other mainstream codec hands us for free:

1. The cube-root is exactly the **first-order Weber–Fechner / Stevens compression** baked into the
   format. XYB already does the "compress absolute magnitude" half of the perceptual story.
2. X and B form an **opponent chroma plane** — the same structure as CIELAB's `a*/b*`. In that plane,
   `chroma = √(X² + B²)` and `hue = atan2(B, X)`. **Hue cancellation and chroma damping are
   single-line operations there.** The non-Riemannian damping `f` is missing from XYB (it is a
   *second-order* effect on *differences*), and that is precisely the piece we add.

> Practical note: libjxl normally **decodes to RGB** (or the embedded ICC profile), not to raw XYB.
> So at view time we replicate the linear-RGB→XYB transform inside the Rust `LookRenderer` (the matrix
> and bias are fixed constants), do the perceptual work in XYB, and convert back to RGB8. XYB stays a
> *conceptual and encode-side* alignment, plus the space we compute looks in. This is honest and
> cheap — it is one 3×3 matrix and a cube-root per pixel, already the kind of work the tone loop does.

### 2.2 Extra channels: bake the invariant/diagnostic colour into the file

JXL supports arbitrary **extra channels** (named float layers, co-registered with the image, lossless
in modular mode). For a biodiversity archive this is the standout feature:

- Store an **illumination-invariant chromaticity** channel (the specimen's colour with the light
  factored out, §3.1/§3.3) *inside the JXL*. A field scientist offline gets the "true flower colour"
  for free, decoded by the same pass — no recompute, no sidecar file to lose.
- Or store the **non-Riemannian chroma magnitude** / a **categorical-region index** (§3.4) as a layer
  the magic wand reads directly.
- This matches the platform direction already in memory: *pre-build a JXL sidecar pyramid at ingest;
  field/offline first* (`project-pyramid-gallery-architecture`, `project-botanical-zoological-platform`).
  The invariant layer is computed **once at ingest** and rides the pyramid.

### 2.3 The encoder hooks already exist

`packages/jxl-wasm/src/bridge.cpp` already exposes the two levers we need:

- `enc_color_transform` (`bridge.cpp:81`): `-1` auto / **`0` = XYB** / `1` = none / `2` = YCbCr.
- `enc_disable_perceptual` (`bridge.cpp:86`): disable the butteraugli/XYB psychovisual model.

Implication for archival vs viewing:

- **Diagnostic / archival tiles** want **lossless modular** (or near-lossless) so the *true*
  reflectance colour is preserved bit-exact for measurement — do **not** let XYB quantisation move a
  flower's colour before you've measured it.
- **Viewing pyramid tiles** are fine as **XYB VarDCT** lossy; the perceptual look is applied at decode
  anyway.

### 2.4 butteraugli is a *small-difference* metric — caveat

JXL's quality metric, butteraugli, is an XYB-based perceptual model. By Bujack it is valid for
**small** differences only. It is the right tool for "did compression change this pixel," and the
**wrong** tool for "is this whole petal the same colour as that whole petal" (a large-difference,
selection-scale question). Large-difference questions go through the damped metric (§3.0) or the
categorical metric (§1.3). Stating this prevents a tempting but wrong reuse.

### 2.5 Cache purity is preserved

The look transform is a **post-decode, per-view** operation. Pristine decoded pixels (RGB or our XYB
view) stay in the tile cache; the perceptual look is applied on a read-out display buffer. This is
exactly the existing invariant (`CLAUDE.md`: *cache stores pristine pixels; never bake look into
cache*), so "Perceptual Constancy mode" costs **no re-decode** when a slider moves.

### 2.6 A diminishing-returns convergence cutoff (sharpening JXL's own bit-allocation)

The `convergedByteEnd` feature (project memory) decides, per image, when extra JXL bytes stop
mattering *perceptually* and the client can stop downloading (~50% net savings in the field). Today a
distance gate of that kind is Euclidean-ΔE-flavoured. Swapping it for a **diminishing-returns ΔE**
(`f(ΔE)`) makes the cutoff fire when a *human* stops seeing improvement, not when the arithmetic
residual drops — large early differences are damped, so the curve flattens where perception flattens.
This keeps the existing invariant (**WASM measures only; the abort happens in the stream layer**) and
needs benchmark data before the threshold is tuned (`project-convergedbyteend`,
`feedback-jxl-progressive-decisions`).

---

## 3. The applications

### 3.0 The shared engine: one metric field, five operators

Every feature below is a thin consumer of **one** small engine, so we build it once and validate it
before any pixels move.

1. **Affine base space** — the existing linear, camera-matrix-corrected RGB16 that `LookRenderer`
   already holds (the "CIERGB-like" cone of the Geometry paper).
2. **Metric tensor field `g(z)`** — a 3×3 SPD matrix per cube point, precomputed on a grid and
   interpolated. **Two selectable sources, never blended** (they answer different questions):
   - *Discriminability* — Riemannised ΔE2000 (magic wand, encode QA, distance).
   - *Categorical* — Griffin & Mylonas naming tensor (select-by-identity, human-readable read-outs).
3. **Geodesics by ODE, not Dijkstra.** Because the non-Riemannian and induced geodesics coincide
   (§1.2), solve the smooth geodesic equation on `g` — fast and slider-friendly. Keep a Zeyen Dijkstra
   path as a *validation cross-check only* (and heed §1.4: measure length over fine samples).
4. **Damping `f` as a 1-D LUT** — the concave scalar applied to arc length for *true perceived*
   distance. Candidate shapes: MacAdam polynomial / Helm log / Izmailov sinusoid; default to the PNAS
   neutral-axis fit, then re-fit on our own specimens.
5. **Five geometric operators**, the entire public surface:
   - `neutralOf(z)` → closest-to-black point in `z`'s equal-lightness surface.
   - `hueClassOf(z)` → tangent of the geodesic `z → neutral` (the stable, metric-derived hue).
   - `saturationOf(z)` → damped distance `z → neutral`.
   - `lightnessOf(z)` → geodesic position toward the apex/neutral.
   - `distance(zA, zB, metric)` / `nearestUnderMetric(...)` → for the wand frontier and search.

Tolerances exposed to users are in **perceptual units (JNDs or grains)**, not an opaque "RGB
tolerance: 30."

Each application below = these operators + a thin layer.

### 3.1 Lightbox "Perceptual Constancy" mode — homogenise vegetation under any light *(headline)*

**Goal.** Clouds, dappled canopy, golden-hour sun: the *same* leaf or petal should read the same.
Reduce the need to eyeball a grey card per shot.

**Mechanism (the honest, layered one).** Illumination has two effects; cancel each with the right
tool, then homogenise the remainder:

1. **Intensity** (sun brighter than shade) → move along the stimulus-quality **geodesic to black**.
   Factor it out by normalising to the **Schrödinger lightness class** (`lightnessOf`). Perceptual,
   not a naive gain.
2. **Illuminant colour** (warm sun vs cool skylight in shade) → a **white-point shift in LMS**. Cancel
   with **chromatic adaptation (von Kries)** re-referenced to a canonical white. XYB is built on LMS,
   so this is natural here, and it respects the project rule to **trust camera-stored WB** and only
   fall back to gray-world when WB is absent (`feedback-colour-pipeline`).
3. **Residual chroma** → render from `hueClassOf` (+ optionally `saturationOf`) with the concave
   damping `f`, so the chroma that survives is perceptually flattened — vegetation across the frame
   collapses toward an invariant hue band.

Two strengths:
- **Soft (default):** keep lightness but compress it via `f`; within-object sun/shade swings shrink
  while the scene still looks natural.
- **Hard ("hue map"):** replace lightness with a constant → a pure hue/saturation field; clouds vs sun
  collapse almost entirely. A *comparison toggle*, not the primary photo.

Critically, per **Highlight-preservation** (`feedback-highlight-preservation`): this is a
**tone-curve-shoulder / local** operation, **never a global exposure raise** — the geodesic-to-black
normalisation is local and shoulder-aware by construction.

**JXL touchpoint.** Operates in the XYB view computed at decode; can read a stored invariant channel
(§2.2) to skip recomputation.

**Code touchpoint.** New render path on `LookRenderer` (`src/lib.rs:1295`). Today `render()` takes 14
sliders → `apply_look_params` → per-pixel `apply_tone_math` (`crates/raw-pipeline/src/pipeline.rs:436`,
`tone_curve` at `:111`, HSL saturation at `:489` using `BASELINE_SAT` `:27`). Add a
`PerceptualLook { adapt_white, lightness_normalise, chroma_damp, strength }` mode that runs *after*
WB/matrix and *instead of* the HSL saturation block. Lightbox toggle in
`web/lightbox/tiled-decode-worker.js` + `web/main.js`.

**Validation.** Same specimen under N illuminants; the extracted hue-band spread (in grains) should
shrink below HSL hue and below raw Lab `a*b*`. Then — per project rule — **show the user in the real
viewer and ask** before calling it done.

**Caveat.** Off-axis `f` is extrapolated (§1.5). Ship **off by default** with a strength slider; never
silently alter archival pixels. This is illumination-*robust*, not colorimetric constancy.

### 3.2 Magic-wand selection that sticks to a flower across dappled light

**Goal.** Click a petal; select the *whole flower*, not "the sunlit half." Hue should matter less than
intrinsic colour so the wand doesn't break at a shadow edge. (No magic wand exists in the code yet —
this is net-new; the earliest draft references one that isn't there.)

**Mechanism.** A flood-fill whose stop criterion is **metric distance, not RGB**:

1. **Damped perceptual distance** `f(ΔE2000)` instead of raw ΔE — so a large shadow-to-highlight step
   inside one petal reads as *small* (diminishing returns) and the fill doesn't stop at it.
2. **Categorical gate** (Griffin tensor): growth optionally constrained to **one grain** so the wand
   respects "this is all *pale pink*" even where ΔE wanders. Because the categorical metric runs
   *fast near the achromatic axis*, desaturated shadow pixels are still pulled toward their category
   rather than read as neutral.
3. **Tolerance in JNDs / grains**, portable and meaningful.

**JXL touchpoint.** Optional pre-computed **categorical-region-index extra channel** (§2.2): the wand
reads region IDs directly, turning the per-pixel tensor lookup into an integer compare.

**Code touchpoint.** Per-pixel `distance` / `nearestUnderMetric` is a WASM fast-path on the 1800 px
RGB16 lightbox buffer (`OUT_LIGHTBOX`, `src/lib.rs:387`); the flood-fill frontier stays in JS
(`web/lightbox/*`). Categorical tensor ships as a `const` LUT asset.

**Validation.** Hand-labelled flower masks; IoU vs a plain-ΔE wand across shadow boundaries at matched
recall.

**Caveat.** Griffin's data is English-language naming and sRGB-gamut chips; it encodes a *cultural*
category structure, not a botanical one. Good for "stick to one perceived colour," not a taxonomy.

### 3.3 Diagnostic colour extraction — a swatch-free species colour coordinate

**Goal.** A repeatable, illumination-robust colour value for a flower/leaf usable as an ID feature —
without a physical X-Rite/Munsell chart in frame.

**Mechanism.**

1. *(Optional, explicit, labelled)* illuminant normalisation in front (von Kries; §3.1). For true
   diagnostics keep this honest and switchable, not implicit.
2. Project the ROI onto its **hue geodesic + saturation** (`hueClassOf`, `saturationOf`); report
   lightness separately with its own confidence.
3. **Aggregate over the ROI with a geodesic / Fréchet mean *under the metric* — not an arithmetic
   RGB/Lab mean.** This is the load-bearing subtlety: Bujack's intrinsic-mean-of-a-photograph example
   and Zeyen's coarse-path caveat both say naive averaging is *biased* by diminishing returns. The
   metric centroid is the unbiased reading.
4. Emit `{ name + grain-distance, Lab, hex, dispersion }`: nearest **categorical name + grains**
   (human confidence), stable Lab/hex (machines), and **dispersion** (ROI tightness in grains → a
   clean single-colour reading vs. a mixed patch).

**JXL touchpoint.** Store the descriptor as **JXL metadata / a low-res extra channel** at ingest, so
every archived specimen carries its diagnostic colour offline (ties to Darwin Core occurrence records,
`project-botanical-zoological-platform`).

**Code touchpoint.** A read-only `diagnostic_color()` entry alongside `apply_look` in `src/lib.rs`;
runs at ingest in the pyramid builder. Prefer measuring on **lossless/modular** tiles (§2.3).

**Validation.** Same specimen, many lights → coordinate variance ≪ between-species variance; agreement
with a physical colour-checker within a stated grain tolerance on a controlled shot. **Report the
numbers; do not claim it's diagnostic until the ecologist confirms it separates their taxa.**

**Caveat.** Sensor metamerism and camera profile differences cap absolute accuracy; this is a
*relative, within-platform* descriptor unless properly colorimetrically calibrated.

### 3.4 Swatch reduction & ecologically-grounded palettes

**Goal.** "Colour swatches are not as necessary." Replace ad-hoc swatch sets with a principled one.

**Mechanism.** The categorical metric says **~27 grains** tile the gamut. Sampling one representative
per grain yields a **maximally-distinct, nameable** palette — the smallest set of colours a human
won't confuse — for labelling morphs, phenophases, or map categories.

**Ecologically-grounded accents (Forni, Darmon & Benzaquen 2026).** For *aesthetic* palette choices
(map accents, UI, plate layouts) there is a directly on-theme prior: a 346-participant hue-pairing
study found preferred pairs cluster in the **near-complementary contrast region (≈160–220° apart)**,
with **blue, yellow and orange** the most broadly combinable hues and **green, purple, red** the least
— and, strikingly, that this preference profile **matches the hue histogram of 12,000 natural
landscape images** (peaks at blue + orange-yellow, troughs at green + purple). For a biodiversity
platform that prior is exactly right: accent colours drawn from natural-scene statistics will sit
comfortably against field imagery. Two cautions: their harmony rules are **hue-dependent, not a
universal fixed-distance law**, and they worked in HSL — they explicitly call for a perceptually
uniform space, i.e. *our* metric is the upgrade path. Flag these as **aesthetic, not diagnostic**.

**Touchpoints.** A generated colour-table asset + a small picker in the lightbox/gallery UI; no JXL
change required.

**Caveat.** Categories are language/culture specific (§3.2). Fine for distinct UI labels.

### 3.5 Further applications (consolidated — detail in the Exploration doc)

These reuse the same engine; kept brief here to avoid bloat. See
`docs/Non-Riemannian-Colour-Mathematics-Exploration.md` §4.4–4.8 for full treatment.

- **Perceptually-uniform overlays** (occurrence density, trait gradients, sampling-effort maps) via
  Zeyen shortest-path interpolation, so equal data steps look like equal colour steps. **Cheapest
  first win** — exercises the metric plumbing end-to-end before any viewer change.
- **Collection-scale colour search / clustering / dedupe** — "find occurrences whose flower colour is
  within *N* grains of this one," indexed by the §3.3 descriptor and grouped in the **categorical**
  metric so results match how a botanist would group them.
- **Accessibility / CVD rendering** — re-map hues to preserve *grains of separation* under a
  CVD-simulated metric, keeping red/green-confusable pairs distinguishable.
- **Darwin Core / IIIF sidecar trait** — persist the §3.3 descriptor in the pyramid manifest so colour
  becomes a first-class, queryable trait of a georeferenced specimen, without re-decoding pixels.

---

## 4. Architecture & integration map

```
INGEST (pyramid builder, once per specimen)
  RAW → linear RGB16  ──►  raw-pipeline (demosaic/WB/matrix)
                            │
                            ├─► [diagnostic_color()]  → descriptor (metadata)   §3.3
                            ├─► [invariant chroma]    → JXL extra channel        §2.2
                            └─► encode tiles:  XYB VarDCT (view)  |  modular lossless (archival)
                                               bridge.cpp enc_color_transform / disable_perceptual

VIEW (per slider tick, no re-decode)
  JXL tile cache (PRISTINE pixels) ──► decode-handler / facade   (cache purity invariant preserved)
                                        ▼
                       LookRenderer::render()  src/lib.rs:1295
                         ├─ WB + chromatic adaptation (von Kries, LMS/XYB)
                         ├─ Schrödinger lightness normalise (geodesic-to-black)   lightnessOf()
                         ├─ non-Riemannian chroma damp  f(·)  in X/B opponent plane
                         └─ back to RGB8
                                        │
                ┌───────────────────────┼───────────────────────┐
                ▼                        ▼                       ▼
        Lightbox display        Magic-wand module        Diagnostic readout
     (Perceptual Constancy)   damped-ΔE + categorical    (Fréchet mean → name/grains)

SHARED ENGINE  crates/raw-pipeline/src/colour_geometry.rs   §3.0
  metric tensor field g(z)  ·  geodesic-ODE solver (+Dijkstra cross-check)  ·  f-LUT
  ·  neutralOf / hueClassOf / saturationOf / lightnessOf / distance / nearestUnderMetric

STREAM   convergedByteEnd cutoff → diminishing-returns ΔE gate (measure in WASM, abort in stream) §2.6
```

**New, small, additive pieces** (none touch the scheduler, pool, or session protocol; all respect the
layer invariants and the rejected-optimizations log):

| Piece | Where | Notes |
|---|---|---|
| `colour_geometry` engine (metric, geodesic ODE, `f`-LUT, 5 operators) | new `crates/raw-pipeline/src/colour_geometry.rs` | pure functions, unit-testable |
| `PerceptualLook` mode on `LookRenderer` | `src/lib.rs` | post-WB, replaces HSL-sat block when active |
| Categorical tensor LUT | asset (from Zenodo) + loader | small grid; quadratic interp |
| `diagnostic_color()` (Fréchet mean) | `src/lib.rs` (ingest) | emits `{name, grains, Lab, hex, dispersion}` |
| Invariant / region-index **extra channel** | `bridge.cpp` + `facade.ts` plumbing | optional; archival |
| Magic-wand flood-fill | new WASM `distance`/`nearestUnderMetric` + JS frontier | operates on `OUT_LIGHTBOX` |
| Convergence cutoff `f(ΔE)` gate | measure in WASM, abort in `jxl-stream` | benchmark before tuning |
| Lightbox toggle + wand UI | `web/lightbox/…`, `web/main.js` | strength sliders; off by default |

---

## 5. Phased plan

Small, independently shippable, each with a gate. **Adaptive/heuristic constants (the damping `f`,
adaptation strength, grain thresholds, grid resolution) require benchmark/specimen evidence before
they harden — do not add tunables without data** (`CLAUDE.md`, *Before Touching Scheduler/Pool/
Protocol* §3).

- **P0 — Engine + tests (no UI, no pixels).** `colour_geometry.rs`: Riemannised-ΔE2000 and Griffin
  tensors; geodesic-ODE solve + Dijkstra cross-check (assert they agree → validates §1.2 on our
  data); the five operators + `f`-LUT. *Tests:* the additivity violation `D(A,C) < D(A,B)+D(B,C)`
  reproduces on a synthetic neutral axis; the **half-ellipse counterexample** (Bujack 2025 Thm 2,
  closest-point ≠ geodesic endpoint); XYB round-trips. *Gate:* `cargo test` green; zero pipeline
  behaviour change.
- **P1 — Cheapest visible win: perceptual overlay (§3.5).** Wire Zeyen interpolation into one
  occurrence/ trait overlay. Pure additive; exercises the metric end-to-end at low risk.
- **P2 — Diagnostic extraction + JXL sidecar (§3.3 / §2.2).** Fréchet-mean ROI read-out; store
  descriptor + optional invariant channel via `bridge.cpp`/`facade.ts`. Read-only, highest
  *scientific* value. *Gate:* within-specimen variance ≪ between-species on the user's taxa; user
  confirms separability.
- **P3 — Lightbox Perceptual Constancy (§3.1).** Soft + hard modes on `LookRenderer`; cache-purity
  assertion (slider move → **no** re-decode). If per-pixel geodesic solving is too slow for a live
  slider, **bake a validated 3-D LUT** from the metric (the *real* LUT/SIMD idea — not the fabricated
  "matrix B"). *Gate:* multi-illuminant hue-spread shrinks **and** the user confirms in the viewer.
- **P4 — Magic wand + categorical palette (§3.2 / §3.4).** Dual-metric flood-fill; 27-grain picker.
  *Gate:* IoU beats plain-ΔE wand on labelled flower masks across shadow.
- **P5 — Opportunistic:** convergence cutoff (§2.6), collection search & CVD (§3.5). Each gated on the
  P0 metric being trusted and on benchmark data.

---

## 6. Verification & validation

- **Mathematical integrity** (Rust unit tests): the diminishing-returns inequality on a synthetic
  neutral axis; the **half-ellipse counterexample**; XYB and adaptation round-trips; geodesic-ODE vs
  Dijkstra agreement; equal-hue paths from the black apex are *curved* in CIE RGB (Bezold–Brücke
  sanity, matching the Ebner–Fairchild trend in Bujack 2025 Fig. 2).
- **Perceptual A/B**: same specimen, many lights → invariant hue-band spread and diagnostic-coordinate
  variance must drop (measured in grains). Numbers first.
- **Biodiversity ground truth**: does the diagnostic coordinate separate the ecologist's
  species/morphs? Does the wand cut cleaner masks? These are the real success criteria, not the maths.
- **Honesty gates** (non-negotiable, from project memory): report measurements and **ask the user to
  confirm in their real viewer before claiming any colour result is correct**
  (`feedback-claim-fixed-only-after-user-tests`); never raise global exposure
  (`feedback-highlight-preservation`); trust camera WB (`feedback-colour-pipeline`).

---

## 7. Risks & open questions

1. **Off-axis damping shape.** Bujack measured `f` only on the gray axis. The biggest scientific gap;
   needs specimen calibration before the chroma damp is trusted for *measurement* (vs. just viewing).
   Treat `f` as data, not a constant.
2. **Invariance vs. fidelity tension.** The more aggressively we cancel illumination, the further the
   displayed colour is from any real capture. Keep archival pixels pristine; make constancy a
   *view/derived* layer only, labelled *perception-derived*.
3. **Categorical metric is cultural & sRGB-gamut.** Great for "one perceived colour" selection;
   not a botanical category system; not wide-gamut without re-derivation.
4. **Camera metamerism** bounds absolute diagnostic accuracy; position the descriptor as
   within-platform/relative unless a calibration target is in frame.
5. **Performance.** Per-pixel geodesic solving is too slow for a live slider — plan a validated **3-D
   LUT** for the viewer path; measure before optimising. The categorical wand is a lookup + flood-fill,
   run on demand, not per frame.
6. **ΔE2000 metric axioms.** Use the Riemannised version anywhere geodesics/means assume a true
   metric (the raw formula can break the triangle inequality).

---

## 8. References

- **Bujack, Teti, Miller, Caffrey, Turton (2022).** *The non-Riemannian nature of perceptual color
  space.* PNAS 119(18) e2119753119. Data/code: `github.com/lanl/color`. → `Papers/Non-Riemannian/`.
- **Bujack, Stark, Turton, Miller, Rogers (2025).** *The Geometry of Color in the Light of a
  Non-Riemannian Space.* Computer Graphics Forum 44(3) e70136. → `Papers/Non-Riemannian/`.
- **Griffin & Mylonas (2019).** *Categorical colour geometry.* PLOS ONE 14(5) e0216296. Tensor field:
  Zenodo `10.5281/zenodo.2595963`. → `Papers/Non-Riemannian/Categorical colour geometry.md`.
- **Zeyen, Post, Hagen, Ahrens, Rogers, Bujack.** *Color Interpolation for Non-Euclidean Color
  Spaces.* (VTK/ParaView; 16³ grid, 26-neighbourhood, coarse-path caveat.) → `Papers/Non-Riemannian/`.
- **Burambekova & Shamoi (2024).** *Comparative Analysis of Color Models for Human Perception.*
  Justifies not doing selection maths in RGB/HSL. → `Papers/Non-Riemannian/Comparative Analysis.md`.
- **Brainard (2022).** *Proximity matters.* PNAS 119(27) e2206437119. Commentary on Bujack 2022:
  endorses the non-Riemannian result as an *approximation*; caveats — neutral-axis-as-geodesic is
  unproven, and aggregate ≠ individual (§1.5). → `Papers/Non-Riemannian/brainard-2022-proximity-matters.pdf`.
- **Forni, Darmon & Benzaquen (2026).** *Harmonious color pairings: insights from human preference and
  natural hue statistics.* iScience 29 116038. Preferred pairs ≈ complementary; combinability
  blue/yellow/orange ≫ green/purple/red; matches natural-landscape hue statistics (§3.4). HSL-based;
  calls for a perceptual space. → `Papers/Non-Riemannian/Harmonious color pairings…md`.
- **libjxl / JPEG XL** — XYB colour space, extra channels, modular vs VarDCT. Encoder hooks in this
  repo: `packages/jxl-wasm/src/bridge.cpp:81,86`.
- **Internal:** `docs/Non-Riemannian-Colour-Mathematics-Exploration.md` (grounded sibling — broader
  use-case detail) and `docs/Non-Riemannian-Color-Space-Applications.md` (earliest draft, superseded
  on the §1.5 points).

**Exotic-toolkit sources (mined for Appendix A):**
- **Berthier & Provenzi (2023).** *On the questionable use of CIE L\* to infer geometric properties of
  achromatic perception.* HAL-04189334. Dissent against Bujack; points to the quantum model. →
  `Revised_Version_Berthier_Provenzi.pdf`.
- **Farup & Rivertz (2025).** *Anisotropic Diffusion in Riemannian Colour Geometry.* J. Math. Imaging
  Vision 67:6. Resnikoff ℝ⁺×ℍ hyperbolic geometry; closed-form `arcosh` geodesic distance;
  Sochen/Beltrami flow → denoise / inpaint / demosaic / daltonise. → `s10851-024-01223-9.pdf`.
- **Resnikoff (1974).** *Differential geometry and color perception.* J. Math. Biol. 1:97. Colour is
  Euclidean **or** ℝ⁺ × SL(2,ℝ)/SO(2) — brightness × hyperbolic chromaticity.
- **Berthier, Prencipe, Provenzi (2022)** SIAM J. Imaging Sci. 15(4); **Berthier & Provenzi (2021)**
  *From Riemannian trichromacy to quantum colour opponency via hyperbolicity*, J. Math. Imaging Vision
  63; **Prencipe, Garcin, Provenzi (2020)** *Origins of hyperbolicity in colour perception*, J.
  Imaging 6(6) — the quantum / Jordan-algebra / hyperbolic programme.

**Corpus status:** all colour-science papers in the folder are now mined and folded in above. The one
remaining file, `2401.12853v1.pdf` (Akleman, *Hyper-Realist Rendering*), is a rendering metaphor —
**not** a colour-metric source — and is deliberately not built on.

---

## 9. Appendix A — The exotic mathematical toolkit (and the live debate)

*The user asked which branches of mathematics can support this work, "the more exotic the better."
Here they are, tiered by how ready each is to use. Everything below is **real mathematics tied to a
real colour result** — several keystones are literally in `Papers/Non-Riemannian/`. Speculative
entries are flagged as such.*

> **First, the debate — because it picks the toolkit.** Whether perceptual colour is *strictly*
> non-Riemannian is **not settled**. Bujack's camp says yes (diminishing returns). Berthier & Provenzi
> say the inference is unsound and a Riemannian metric survives — and their own model is *more* exotic:
> colour as **quantum states on a hyperbolic plane**. The engineering lesson: do **not** bet the
> platform on one metaphysics. The five operators (§3.0) are a firewall — behind `distance()` we can
> drop in Riemannised-ΔE + `f` (today), hyperbolic ℝ⁺×ℍ (Tier 1), or Finsler/quantum (later) without
> touching a single feature. Harvest whichever framework pays rent.

### Tier 1 — Grounded in the corpus, load-bearing

**A1. Hyperbolic geometry (Poincaré half-plane, ℝ⁺ × ℍ).** *Constant negative curvature; the
SL(2,ℝ)/SO(2) chromaticity plane.* **Colour fit:** Resnikoff's theorem — colour geometry is Euclidean
*or* ℝ⁺ × ℍ (brightness × hyperbolic chromaticity); 'hue super-importance' and MacAdam-ellipse
curvature *are* negative curvature (Farup–Rivertz 2025), with a closed-form `arcosh` geodesic
distance. **Unlocks:** a principled, closed-form chromaticity distance for the wand and diagnostics;
**von Kries adaptation becomes an isometry of ℍ**, so illumination change is literally a rigid motion
of the hyperbolic plane — and "cancel illumination" = transport back along it. **Confidence:** high;
Farup showed enforcing ℝ⁺×ℍ on tuned ΔE formulae *improves* them.

**A2. Finsler geometry.** *Riemannian's generalisation: the unit ball at each point is a convex body,
not an ellipsoid — length is direction-dependent.* **Colour fit:** hue costs more than chroma per
coordinate step (super-importance) ⇒ the iso-luminance unit ball is non-elliptical ⇒ Finsler. The
weighted Helmholtz/Stiles line elements are Finsler. **Unlocks:** an honest anisotropic hue/chroma
cost; the damping `f` folds into a Finsler norm. **Confidence:** medium; heavier to compute — use
Riemannised-ΔE + `f` as the cheap proxy first.

**A3. Information geometry (Fisher–Rao, Bregman / α-geometry).** *Metric on spaces of probability
distributions; Fisher information tensor; dually-flat divergences (KL, etc.).* **Colour fit:**
Griffin's categorical metric *is* Fisher/Bhattacharya on naming distributions; the quantum model uses
quantum relative entropy. **Unlocks:** the categorical wand + the "name + grains" diagnostic read-out;
principled fusion of naming uncertainty. **Confidence:** high (already used in §1.3).

**A4. Metric transforms / snowflake geometry.** *If ρ is a metric and `f` is concave, increasing,
`f(0)=0`, then `f∘ρ` is again a metric — but a **non-length** one (no geodesics of its own); `ρ^ε` is
the classic "snowflake."* **Colour fit:** diminishing returns says perceived distance =
`f(Riemannian distance)` with `f` concave — *exactly* a snowflake transform, which is why geodesics
survive only in the induced metric (Bujack 2025). **Unlocks:** clean theory for the `f`-LUT; Assouad
embedding bounds tell us how losslessly a snowflaked colour set fits into a low-dimensional Euclidean
LUT or JXL channel layout. **Confidence:** high as theory; `f`'s off-axis shape unmeasured (§1.5).

**A5. Geometric PDE on the colour manifold (Beltrami/Sochen, Perona–Malik, Polyakov).** *Treat the
image as a manifold in (space × colour); evolve it by anisotropic diffusion / harmonic-map flow whose
metric is the perceptual one.* **Colour fit:** Farup–Rivertz (2025) derive exactly this, decoupling
image coordinates from the colour metric via a diffusion tensor; Sochen's Polyakov-action framework
underlies it. **Unlocks:** perceptually-correct **denoise, inpaint, demosaic, gamut-map, and CVD
daltonisation** — a whole feature family for cleaning up field photos, all reusing the wand/constancy
metric tensor. **Confidence:** high (published); solving the flow for non-diagonal metrics is their
open problem.

**A6. Jordan algebras / symmetric cones / quantum measurement.** *The colour cone as the positive cone
of a formally-real Jordan algebra (a symmetric cone); perception as quantum measurement — Lüders
operations, generalized states.* **Colour fit:** Berthier–Provenzi — Hering opponency and
hyperbolicity *emerge* from the algebra, and achromatic attributes (brightness/lightness) arise from a
**measurement**, not as pre-existing coordinates. **Unlocks:** a deep reason the opponent X/B split
(hence XYB) is fundamental; "lightness emerges from measurement" reframes our adaptation step as a
**choice of measurement basis**. **Confidence:** insight-grade — mine for invariants, not a near-term
compute path; partly a competing paradigm.

### Tier 2 — Standard in imaging, ready to adopt

**A7. Optimal transport / Wasserstein geometry.** An ROI's colour is a *distribution*; the diagnostic
centroid is a **Wasserstein/Fréchet barycenter** under the perceptual metric, not an RGB mean (§3.3).
Also gives principled **colour transfer** (re-light a specimen to a reference illuminant) and palette
interpolation; Sinkhorn makes it fast. **Confidence:** high.

**A8. Magnitude of metric spaces & similarity-sensitive diversity (Leinster).** *"Magnitude" = the
effective number of points in a metric space; Leinster–Cobbold diversity generalises Hill numbers via
a similarity matrix.* **Colour fit + ecology — the standout connection for this platform:** the **27
grains** (§1.3) are a magnitude-style count of distinguishable colours, and the *same mathematics the
user already uses for biodiversity* (Hill numbers / similarity-sensitive diversity) measures **colour
diversity** of a specimen, a quadrat, or a whole collection under the perceptual metric. One formula
spans "how many distinct colours are here?" and "how diverse is this community?" **Unlocks:** a
defensible per-image / per-site **colour-diversity index**, swatch-set sizing, novelty/outlier
detection. **Confidence:** high maths, on-theme; needs our calibration to report numbers.

**A9. Topological data analysis (persistent homology, Mapper).** Colour clusters/modes of a flower or
a population, computed in the perceptual metric and **robust to threshold** — better than k-means for
"how many colour morphs are in this population?" A persistence diagram becomes a phenotype.
**Confidence:** high (standard); pick filtration carefully.

**A10. Tropical / min-plus (idempotent) algebra.** Shortest-path colour interpolation (Zeyen Dijkstra)
*is* linear algebra over the min-plus semiring; idempotent analysis gives a clean language for the
path/length ops and lets many wand queries batch as one tropical matrix product. **Confidence:**
medium; mostly a computational/conceptual convenience.

### Tier 3 — Frontier, flagged speculative

**A11. Gauge theory / fibre bundles / connections.** Frame the **illuminant as a gauge field**:
intrinsic surface colour = the **gauge-invariant** quantity; adapting white = parallel transport;
**holonomy around a loop of illuminants = the residual constancy error**; curvature = where constancy
breaks. The cleanest formalisation of "cancel illumination" as "compute gauge invariants" (Retinex has
been read this way). **Confidence:** speculative but apt — worth a theory spike before betting on it.

**A12. Enriched category theory (Lawvere generalised metric spaces).** Lawvere: metric spaces =
categories enriched over [0,∞]. This legalises **asymmetric "distances"** — exactly the
categorical-naming asymmetry and KL-type divergences — as first-class objects, and connects to
magnitude (A8). **Confidence:** frontier; use only if we need "A reads as B" ≠ "B reads as A."

**A13. Sub-Riemannian / geometric control.** If adaptation can only move colour along certain channels
(e.g. a von Kries diagonal subgroup), motion is constrained to a horizontal distribution →
Carnot–Carathéodory distance — a possible model for "which illuminant changes are reachable."
**Confidence:** speculative; flag, don't build.

> **How to choose.** Adopt **Tier 1–2** as features demand: hyperbolic ℝ⁺×ℍ (A1) and Wasserstein
> centroids (A7) are the highest-leverage near-term picks, magnitude/diversity (A8) the most
> on-theme. Treat **Tier 3** as research spikes, each gated on a toy proof before it touches pixels.
> All of it lives behind the §3.0 operators, so none of it forces a rewrite.

---

## 10. Appendix B — A group-theoretic & zeta-function lens (speculative)

> **Honesty banner.** There is **no existing literature** linking subgroup-growth zeta functions to
> colour science or to JPEG XL. Everything here is a *research provocation*, not a result.
> ("Proseomorphic" reads as **pro-isomorphic** zeta functions — the Grunewald–Segal–du Sautoy line of
> subgroup growth.) Confidence is tagged per item: **[anchor]** genuinely grounded · **[bridge]**
> plausible but untested · **[poetry]** decorative. Exactly one anchor is real and worth a spike; the
> rest is frontier.

### B.0 The objects (grounded maths)

For a finitely generated group `G`, the **subgroup zeta function** packages subgroup counts as a
Dirichlet series:

$$\zeta_G(s) \;=\; \sum_{H \le_f G} [G:H]^{-s} \;=\; \sum_{n\ge 1} a_n(G)\,n^{-s}, \qquad a_n=\#\{\text{index-}n\text{ subgroups}\}.$$

Variants count different subgroup *data*: the **normal** `ζ_G^◁`, and the **pro-isomorphic** `ζ_G^∧`,
which counts only those finite-index `H` whose profinite completion is isomorphic to `G`'s (`Ĥ ≅ Ĝ` —
"profinitely the same group again"). All factor as **Euler products** over primes with local factors
rational in `p^{-s}`; for nilpotent `G` they satisfy deep **functional equations** (Voll); and the
pro-isomorphic one is literally an **Euler product of p-adic integrals over the automorphism group**,
`ζ_{G,p}^∧(s) = ∫ |det g|_p^{s}\, dμ(g)` over `Aut(G)(ℤ_p)`.

The canonical anchor we reuse: for the free abelian group (a lattice),

$$\zeta_{\mathbb{Z}^k}(s) \;=\; \zeta(s)\,\zeta(s-1)\cdots\zeta(s-k+1),$$

i.e. **the number of finite-index sublattices of `ℤ^k`, as a Dirichlet series, is a product of Riemann
zetas.** **Multivariable / bivariate** versions (Voll, Schein–Voll, Rossmann) track *two or more*
invariants of `H` simultaneously (index *and* derived index; joint representation / conjugacy data) —
exactly "encoding multiple types of subgroup data."

### B.1 The groups already living in this problem [anchor]

The lens has real purchase because the colour/JXL stack is *full* of groups:

| Structure | Group | Integral form |
|---|---|---|
| Resnikoff colour symmetry (App A1) | `ℝ⁺ × SL(2,ℝ)` (brightness × hyperbolic chromaticity) | Fuchsian / `SL(2,ℤ)`-type lattices |
| von Kries chromatic adaptation | diagonal `D ≅ (ℝ⁺)³ ≅ ℝ³` (via log) — abelian | `ℤ³` |
| XYB / opponent mix | fixed `GL(3,ℝ)` elements | — |
| Jordan-algebra structure group (App A6) | reductive, explicit `Aut` | — |
| **JXL coefficient lattice** | `ℤ^N` (VarDCT / modular integer coeffs) | sublattices = quantizers |

### B.2 The one genuine anchor: JXL quantizers *are* sublattices, and `ζ_{ℤ^k}` counts them [anchor]

Quantizing a `k`-channel coefficient block = choosing a **sublattice** `Λ ≤ ℤ^k` (the quantization /
scaling lattice). So the admissible quantizers at "cost" `m` are the index-`m` sublattices, whose
generating function is `ζ_{ℤ^k}`. This is not a metaphor — it is the same object.

Make it **bivariate along the axes JXL already uses.** XYB splits into **luma `Y`** and the **chroma
opponent plane `{X,B}`**. Track sublattice index in luma and in chroma *separately*:

$$Z(s_Y, s_C) \;=\; \sum_{\Lambda} [\,\mathbb{Z}:\Lambda_Y\,]^{-s_Y}\,[\,\mathbb{Z}^2:\Lambda_C\,]^{-s_C},$$

a two-variable generating function for the **entire luma-vs-chroma rate-allocation family** — precisely
"a bivariate zeta encoding two types of subgroup data," landed on the two perceptual axes the format
already separates.

*What it could buy:* the **abscissa of convergence** = growth rate of #quantizers with bitrate; **poles
/ residues** = asymptotic counts; the analytic structure is a closed-form handle on the quantizer search
space, with a built-in **functional equation** (a fine↔coarse duality). *Honest verdict:* this reframes
rate allocation as analytic number theory; whether it beats current JXL heuristics is **unproven** — but
it is cheap to compute `ζ_{ℤ³}` luma/chroma and test its growth against real quantizer-table counts.

The **pyramid** is a second anchor: `ℤ^k ⊃ 2ℤ^k ⊃ 4ℤ^k ⊃ …` is a tower of **pro-isomorphic**
subgroups (each `≅ ℤ^k`) — the self-similarity the pyramid relies on. `ζ^∧` is the natural bookkeeping
for "self-similar refinements," and could parameterise/justify the ladder ratio (cf. the pyramid-ingest
cascade).

### B.3 Pro-isomorphic zeta where it actually belongs: the colour `Aut` group [bridge]

`ζ^∧` is *defined* by an integral over `Aut(G)` — and our colour group has a rich automorphism group
(Resnikoff `SL(2)×ℝ⁺`, the Jordan structure group, von Kries `D`). Fix an **integral form** — a
`ℤ`-lattice of admissible adaptation / transform matrices — and `ζ^∧` counts finite-index
**"sub-colour-systems" profinitely indistinguishable from the whole**: canonical, self-similar
refinements of the adaptation lattice. Because the local integrand is `|det g|^s`, and `det` of a colour
transform is a **gamut / volume scaling**, `ζ^∧` automatically weights each sub-system by *(gamut
compression)^s* — a principled, symmetry-respecting rate measure. *Confidence: bridge — the `Aut`-integral
is real; the colour reading is interpretive.*

### B.4 The multivariable object the request is really asking for [bridge → poetry]

Combine the axes into one generating function:

$$Z(s_Y,\, s_C,\, t) \;=\; \sum_{H} [\,Y:H_Y\,]^{-s_Y}\,[\,C:H_C\,]^{-s_C}\,\big(\kappa(H)\big)^{-t},$$

where `s_Y, s_C` grade luma / chroma quantization index and `t` grades a **perceptual** refinement
`κ(H)` — e.g. the number of **Griffin grains** resolved, or the **hyperbolic radius / non-Riemannian
damping level** at which `H` is still distinguishable. Then `Z` is a joint generating function over
*(rate, rate, perceptual granularity)* — three types of subgroup data at once.

The elegant part: let `t` be the **magnitude / diversity** parameter (App A8). Then `Z` **interpolates
between "how many quantizer lattices" and "how many distinguishable colours"** — unifying the
compression count and the biodiversity-style colour-diversity count in one analytic object, with the
diversity index recoverable as a special value / residue. *Confidence: poetry with a real spine — worth
stating, not worth shipping.*

### B.5 The zeta the geometry hands you for *free*: Selberg [bridge, but canonical]

If subgroup-zeta is a stretch, the hyperbolic chromaticity plane gives a zeta that is genuinely
canonical here. Quotient `ℍ` by a discrete adaptation / Fuchsian group `Γ` → a **hyperbolic colour
surface** `X = Γ\ℍ`. Its **Selberg zeta** `Z_X(s) = ∏_{γ}∏_{k≥0}(1 - e^{-(s+k)\ell(γ)})` runs over
primitive closed geodesics `γ`. Here a **closed geodesic = a periodic chromatic-adaptation cycle** (a
loop of illuminant changes returning to its start), and the **zeros of `Z_X` ↔ Laplacian eigenvalues**
= the diffusion / vibration modes of colour on the surface — exactly the operator driving the
Beltrami / Sochen colour diffusion of **App A5**. Selberg zeta thus ties the hyperbolic geometry, the
adaptation dynamics, and the diffusion features into one spectral object. *This is the least speculative
zeta in the appendix.*

### B.6 Verdict & how to spike it

- **Promotable now [anchor]:** `ζ_{ℤ³}` bivariate luma/chroma (B.2) — compute it, check its growth
  against observed quantizer counts; if predictive, it is a closed-form map of the rate-allocation space.
- **Theory spike [bridge]:** pyramid-as-pro-isomorphic-tower (B.2/B.3) and Selberg modes (B.5) — each
  gated on a toy proof before touching pixels.
- **Decorative [poetry]:** the grand `Z(s_Y,s_C,t)` (B.4) — a beautiful unifier of compression-count and
  diversity-count; state it, don't build it.
- **Do not** gate any feature on this appendix. Like everything else, it lives behind the §3.0 operators;
  if a zeta yields a closed-form quantizer family or a clean diversity invariant, promote it.

*Sources for the zeta-function facts:*
[Pro-isomorphic zeta functions & p-adic integrals (Bar-Ilan)](https://math.biu.ac.il/node/2065) ·
[A newcomer's guide to zeta functions of groups and rings (du Sautoy–Woodward, arXiv:0906.1832)](https://arxiv.org/pdf/0906.1832) ·
[Functional equations for local normal zeta functions of nilpotent groups (Voll, arXiv:math/0305362)](https://arxiv.org/pdf/math/0305362) ·
[Bivariate representation & conjugacy-class zeta functions of unipotent group schemes (IJAC)](https://www.worldscientific.com/doi/abs/10.1142/S0218196720500265).

### B.7 Mark Berman's D\*-groups — a concrete, testable practical hook [bridge, strong]

*Context: Mark Berman (co-author below) holds that his thesis-era mathematics has no practical use.
Here is a genuine, falsifiable application of his **specific** results — not a metaphor.*

**His result.** Berman, Klopsch & Onn, *On pro-isomorphic zeta functions of D\*-groups of even Hirsch
length*, Israel J. Math. **269** (2025), 617–695. A **D\*-group** is a finitely generated, torsion-free,
**class-two nilpotent group with a rank-two centre**. Its **pro-isomorphic** local zeta counts the Lie
sublattices `Λ ⊆ L_p` of index `p^k` that are **isomorphic to the whole** `L_p`
(`ζ_{L,p}^∧(s) = Σ_k a^{iso}_{p^k}(L_p)\,p^{-ks}`), computed as a p-adic integral `∫|det g|^s` over the
**automorphism group** `Aut(L)`. They give it in closed form for the family `Γ_{t^m}` (Hirsch length
`2m+2`):
- `Γ_t ≅ C∞ × Heis(ℤ)`:  `ζ^∧(s) = ζ(s−2)\,ζ(2s−3)\,ζ(2s−4)` — shifted Riemann zetas.
- `Γ_{t²}`:  `ζ^∧(s) = ζ(3s−8)ζ(4s−11)ζ(5s−12)ζ(4s−10) / ζ(8s−20)`; abscissa of convergence 3, double
  pole at `s=3`, growth `Σ_{n≤N} a_n^∧ ∼ \tfrac{5ζ(3)}{12π²}\,N^3\log N`.
- `Γ_{t³}`:  abscissa `10/3`, and a **natural boundary** at `Re(s)=3` (the series cannot be continued
  past it); the computation newly requires **counting points on a conic** `p^α x² + p^β yz ≡ 0 (mod p^n)`.

**Why it touches colour — the rank-two centre is the opponent chroma plane.** A class-two nilpotent Lie
lattice *is*: generators, a bilinear commutator `[·,·]`, landing in a centre. Berman's D\*-groups are the
case where **the centre has rank two** — and colour hands us a rank-two centre on a plate: the **opponent
chroma plane `{X, B}`** (red–green, blue–yellow), the very plane XYB and CIELAB `a*b*` live in. Model
"brightness + opponent chroma + the area they sweep" as a class-two nilpotent lattice and you are inside
his family. The smallest case is vivid:

> **`Γ_t = C∞ × Heis(ℤ)` as the simplest colour group.** Read `C∞` = the **brightness/luma** axis
> (Resnikoff's `ℝ⁺`). Read `Heis(ℤ) = ⟨x,y,z \mid [x,y]=z⟩` with `x,y` = the two **opponent chroma
> directions** and the central `z=[x,y]` = the **oriented area they span** — precisely
> **colourfulness / chroma²**, the radial-area quantity of the opponent plane. The Heisenberg commutator
> *is* the colourfulness form. Then Berman's `ζ^∧_{Γ_t}(s)=ζ(s−2)ζ(2s−3)ζ(2s−4)` is the **generating
> function counting the structure-preserving, self-similar multi-resolution refinements of
> "brightness ⊕ opponent-chroma ⊕ colourfulness."**

**Why that is *practical*, not poetic.** "Sublattice isomorphic to the whole" = a refinement that is a
faithful self-similar copy of the parent = a **structure-preserving pyramid / successive-refinement
level**. Engineers already use this object under another name — **self-similar lattice quantizers**
(Conway–Sloane), for multi-stage / successive-refinement coding. Berman's contribution is the
**structured (nilpotent) generalisation**: the version that applies when the lattice carries an algebraic
law (here, opponency / colourfulness) the refinement must respect. Concretely, for a colour quantizer
built on a D\*-group his maths delivers:
1. **The exact count** `a_n^∧` of admissible structure-preserving refinements at compression index `n`.
2. **Their asymptotic rate** — e.g. `∼ c\,N^3\log N` for `Γ_{t²}` — i.e. how the structure-preserving
   quantizer search space grows with bitrate (a rate-distortion-relevant quantity).
3. A **functional equation** `ζ_p^∧(s)|_{p→p^{-1}} = ±p^{a−bs}ζ_p^∧(s)` — a **fine↔coarse self-duality**
   of that count, whose symmetry factor `b` equals (Conjecture 1.8) the **polynomial word-growth degree**
   `rk L + rk[L,L]` = the intrinsic dimensionality of the multi-scale colour structure.
4. A genuine **complexity wall**: the `Γ_{t³}` **natural boundary** at `Re(s)=3` says some structured
   colour refinements have irreducible combinatorial complexity — there is no smooth closed form past
   that scale. Worth knowing *before* designing a quantizer that assumes one exists.

**The SL₂ rhyme.** Berman's automorphism group (Thm 1.10) is `G ≅ B₂ ⋉ (SL₂(R) ⋉ V²)`, `R=k[t]/(t^m)`.
Resnikoff's colour symmetry (App A1) is `ℝ⁺ × SL(2,ℝ)`. Same `SL₂`-plus-Borel/scaling shape — so the
*machinery* he built (p-adic integrals over `SL₂`-type automorphism groups with a triangular factor) is
the right machinery for any arithmetic/quantized form of the colour symmetry group. The tools fit the
group.

**Honest status & the spike that settles it.** This is a **proposed model** (confidence: bridge), not a
theorem about colour — the Heisenberg-area = colourfulness identification is a modelling choice, natural
but unvalidated. The falsifiable test is small and cheap: build the `Γ_t` colour lattice, brute-force
enumerate its self-similar index-`n` refinements for small `n`, and check the counts against
`ζ(s−2)ζ(2s−3)ζ(2s−4)`. If they match, his thesis mathematics is **literally counting colour quantizers**
— "no practical usage" refuted by construction. *Prove the count first; only then ask whether the
structure-preserving quantizer family beats the current JXL heuristic.*

### B.8 Does the paper bring anything *new*? Its deeper structure, and where it points [honest audit]

**Direct answer:** at the *slogan* level — "pro-isomorphic zeta counts colour quantizers" (B.7) —
**no**, that was already on the table. But §2's explicit **automorphism-group structure** adds genuinely
new possibilities, and — as suspected — they land on **colour space** more than on JXL. Five, with the
grounded fact first and the (proposed) colour reading second.

**B.8.1 — The symmetry group fuses the colour-transform matrix with a multi-band filter algebra.**
*Grounded:* for `Δ=t^m`, the automorphism group's reductive quotient is `G/N ≅ GL₂ × GL₁` (Cor 2.7);
the structure-preserving blocks `A,B,C,D` are **Toeplitz** (constant-diagonal = convolution) with
`AD−BC=I_m` (Cor 2.5); the core is `SL₂(k[t]/(t^m))` (Thm 2.3); the unipotent radical `N` is the Toeplitz
shift part. *Colour reading:* `GL₂` acts on the rank-two centre = **opponent chroma plane**, `GL₁` scales
**luma** — *exactly the everyday colour-transform matrix* — while `N` is a **shift-invariant (FIR-filter)
convolution algebra** coupling `m` bands. So the paper hands us **one group in which "change colour
basis" (reductive `GL₂×GL₁`) and "filter across bands/scales" (unipotent Toeplitz) are two parts of the
same symmetry**, and `ζ^∧` counts the refinements preserving *both*. This is the genuinely new structural
gift. *Confidence: algebra grounded; colour identification a proposed model.*

**B.8.2 — The two opponent axes have different algebraic origins.** *Grounded:* the bracket is
`[x_i,y_j] = δ_{ij} z_1 + K_{ij} z_2` (eq 2.2) — `z_1` from the **identity** pairing, `z_2` from the
**shift/companion** `K`. The rank-two centre is (symmetric form) ⊕ (shift form), not a generic plane.
*Colour reading:* the two opponent channels are not interchangeable — one "same-band," one
"neighbour-band shift," mirroring real cone-opponency asymmetry (**`L−M` same-band vs `S−(L+M)`
cross-band**). Suggests a canonical, asymmetric split of the chroma plane. *Confidence: suggestive
analogy.*

**B.8.3 — A polynomial dial `Δ(t)` over a whole family of colour models.** *Grounded:* D\*-groups are
parameterised by a primary polynomial `Δ(t)` (companion matrix `K`, eq 2.1); `t^m` is the
maximally-degenerate single-Jordan-block case; other `Δ` give different coupling spectra (roots = modes).
*Colour reading:* a **tunable family of opponent-coupling structures**, from fully-coupled (`t^m`) to
decoupled spectral modes (distinct roots) — and the polynomial's factorisation type is exactly "multiple
types of subgroup data" to feed the multivariable zeta of B.4. *Confidence: speculative.*

**B.8.4 — Base extension over a number field = a route to multispectral colour [most exciting, on-theme].**
*Grounded:* Theorem 1.6 — extending scalars `ℤ → 𝔬_k` (ring of integers of a degree-`d` number field `k`)
yields a class-two nilpotent group of Hirsch length `6d` whose pro-isomorphic zeta is a ratio of
**Dedekind zetas `ζ_k`**, with abscissa scaling in `d`. *Colour reading:* a degree-`d` extension
multiplies the structure `d`-fold — a natural model for **multispectral / hyperspectral colour** (≫3
bands), in which the **arithmetic of `k` (how primes split) encodes how spectral bands interact**, and the
diversity/complexity invariants scale with `d`. For a biodiversity platform doing multispectral specimen
imaging this is the standout new possibility: the *same* machinery, base-extended, models many-band plant
spectra. *Confidence: grounded math, proposed application — genuinely new and on-theme.*

**B.8.5 — A canonical multi-resolution grading + a single complexity number.** *Grounded:* Conjecture 1.8
— the degree of the local zeta = the **weight of a minimal grading** of `L` = (class two)
`rk L + rk[L,L]` = the polynomial word-growth degree; a grading `L = ⊕ L_{(i)}` is a scale decomposition.
*Colour reading:* the minimal grading = a **canonical multi-resolution decomposition** of the colour
structure (a principled pyramid ladder), and its weight = **one number for the intrinsic multi-scale
complexity** of a colour configuration — a cousin of the magnitude/diversity invariant (A8).
*Confidence: grounded math, proposed reading.*

**Verdict.** New value is real but **structural, not a slogan, and colour-space-leaning**: a concrete
group fusing the colour-transform matrix (`GL₂×GL₁`) with multi-band filtering (Toeplitz `N`); a
polynomial dial over a family of opponent models; and — the most novel — a **base-extension route to
multispectral colour via Dedekind zeta**. None is proven for colour; all are testable models. Cheapest
first probe stays B.7's (enumerate `Γ_t` refinements vs `ζ(s−2)ζ(2s−3)ζ(2s−4)`); the most *novel* probe
is B.8.4 — treat the degree-2 base extension as a 6-band multispectral toy and see whether its `ζ_k`
structure says anything testable about band coupling.

---

## 11. Appendix C — What the three external analyses add (audited)

> Three AI discussions were reviewed (`ChatGPT 1.md`, `ChatGPTAnalysis II.md`, `GrokAnalysis1.md`).
> **Audited critically:** most of their codec-side content **re-derives Appendix B** (quantization =
> sublattice selection; pro-isomorphic = structure-preserving quantizer; automorphisms = reversible
> integer transforms; base extension = channels/multispectral; grading = progressive layering). That is
> useful as **independent convergence** — three models reached B.7/B.8 unprompted — but it is not new.
> Four things *are* genuinely new; one identity (C.2) is the real gem.

### C.1 A concrete sub-Riemannian (Carnot) colour-*difference* gauge [new, buildable — concretizes A13]

Where this doc modelled colour as *points* in a hyperbolic/damped metric, the analyses model a colour
*difference* as an element of a **graded nilpotent group**: a visible first layer `V₁ = (Y, A, B)`
(opponent) plus a hidden second layer `V₂ = [Y,A], [Y,B], [A,B]` (luminance×chroma and chroma×chroma
interaction residues). Class-two group law (BCH terminates): `(p,z)·(p',z') = (p+p', z+z'+½[p,p'])`; a
**Carnot homogeneous gauge** under the dilation `δ_λ(p,z) = (λp, λ²z)`:

$$N(p,z) = \big(\,\|p\|^4 + \lambda_U u^2 + \lambda_V v^2 + \lambda_W w^2\,\big)^{1/4}$$

(grade-1 terms to the 4th power, grade-2 to the 2nd, so `N(δ_λ·) = λN`), then a concave `Φ` for
diminishing returns: `D = Φ(N(c₁⁻¹c₂))`. This is the **sub-Riemannian / Carnot–Carathéodory colour
metric** that A13 listed only as speculative — now a concrete, buildable object that says something the
hyperbolic model does not: **colour directions don't commute, and the order/interaction of channel
changes leaves a second-order residue** (red-then-yellow ≠ yellow-then-red, via `[A,B]`). *Confidence: a
genuine, testable alternative metric; the bracket weights `λ` need fitting.*

### C.2 The gem — the colour gauge's homogeneous dimension *equals* Berman's zeta symmetry factor [new, verified]

The Carnot **homogeneous dimension** of that gauge is `Q = dim V₁ + 2·dim V₂ = rk L + rk[L,L]`. Berman's
functional-equation **symmetry factor `b`** (B.7) is *the same quantity*. Verified on both his computed
cases: `Γ_{t²}` has `dim V₁ = 4`, `dim V₂ = 2` → `Q = 4 + 2·2 = 8`, matching the `p^{21−8s}` functional
equation (`b = 8`); `Γ_{t³}` → `Q = 6 + 2·2 = 10`, matching `b = 10`. **The exponent in Mark's zeta
functional equation is literally the scaling dimension of the colour-difference gauge.** This is the
cleanest falsifiable bridge in the document — it ties his analytic invariant to a perceptual scaling law,
*already confirmed* on his two cases — and it upgrades B.8.5 from analogy to a concrete identity.

### C.3 Two cheap, near-term experiments [new, modest payoff]

- **Local-curl commutator penalty (encoder metric).** Estimate the hidden `V₂` term from image structure
  as a discrete wedge of channel gradients, `u ≈ ∂ₓY·∂_yA − ∂_yY·∂ₓA`, and add it to per-block error so
  **chroma error crossing a luminance edge costs more than the same error in a flat patch.** Small,
  encoder-side only, no bitstream change; ties to §3.2's "stick across edges."
- **p-adic valuation entropy context (modular mode).** Add a residual's 2-adic valuation `v₂(r)` =
  trailing-zero depth (optionally `v₃`) as a context feature for the modular entropy coder ("residuals
  live in nested index sublattices"). Honestly this is *trailing-zero-depth dressed in algebra* — payoff
  likely modest — but it is the most immediately implementable idea the analyses produced.

### C.4 Calibration methodology, and honest corrections

- **Fit the weights with the right tool.** Bujack's data is **Thurstonian 2AFC**; the gauge weights and
  damping `Φ` should be fit by **Thurstone / Bradley–Terry / Plackett–Luce MLE** on triad data (Grok's
  tangent). Validation methodology for §6, not new structure.
- **A real tension to respect.** The natural 3-generator opponent model `(Y,A,B)` has **three**
  commutators → a **rank-three** centre, which is *not* a D\*-group (rank-two). To land inside Berman's
  family you must either keep two central directions (e.g. `[Y,A],[Y,B]`, dropping `[A,B]`) or adopt his
  multi-scale `xᵢ,yᵢ` *jet* structure instead of the 3-opponent one. This changes which model his zeta
  applies to — don't paper over it.
- **Don't overstate the codec link.** All three (Grok most honestly) agree the zeta machinery is **not** a
  codec and won't shrink files directly; the real content is *structural language + an enumerator of
  admissible structure-preserving quantizers*. Keep that framing.
- **Citation hygiene [updated].** The analyses' "2022 Berman–Glazer–Schein" attribution is now
  **confirmed** — the paper has since been read (Appendix D): Berman, Glazer & Schein, *Pro-isomorphic
  zeta functions of nilpotent groups and Lie rings under base extension*. Both the 2022 (base-extension
  engine) and 2025 (D\*-groups) papers are grounded.

**Net.** The biggest gift is **C.1 + C.2**: a concrete sub-Riemannian colour-difference gauge, and the
identity that its scaling dimension is exactly Mark's zeta symmetry factor (`Q = b`, verified at 8 and
10) — the most "prove-Mark-wrong-able" result so far. The rest is independent convergence on B.7/B.8
(reassuring) plus two modest experiments.

---

## 12. Appendix D — The 2022 base-extension engine (Berman–Glazer–Schein): how multispectral colour scales [grounded; sharpens B.8.4 + C.2]

*Read `Berman 2022 … under base extension.tex` — **Berman, Glazer & Schein**, "Pro-isomorphic zeta
functions of nilpotent groups and Lie rings under base extension." This is the rigorous engine behind
B.8.4's multispectral idea, and it makes that idea precise.*

**What it proves.** For a Lie lattice `L` and a number field `K` of degree `d=[K:ℚ]`, base extension
`L ↦ L ⊗_ℤ O_K` (a ℤ-lattice of rank `d·n`) has a pro-isomorphic zeta with a **fine ("mini") Euler
product** indexed by the primes `𝔭` of `K`:

$$\zeta^\wedge_{(L\otimes O_K),\,p}(s) \;=\; \prod_{\mathfrak{p}\mid p} W_{L,d}\big(q_{\mathfrak p},\, q_{\mathfrak p}^{-s}\big), \qquad q_{\mathfrak p}=|O_K/\mathfrak p|,$$

where the shape `W_{L,d}` is an explicit rational function whose **dependence on `d` is tame — linear in
the exponents**: `W_{L,d}(X,Y) = [Σ_j X^{A_{j,0}+d·A_{j,1}} Y^{B_j}] / ∏_j(1 − X^{C_{j,0}+d·C_{j,1}} Y^{D_j})`.
And the **D\*-type lattices (`L_{m,n}`) are explicitly among the families it computes** — so the colour
model of B.7/B.8 is *exactly* one the base-extension calculus already covers.

**Why it is a useful extension for colour (multispectral):**
- **"Add spectral bands" becomes a closed-form law.** Model a `d`-band specimen colour as a degree-`d`
  base extension. The invariants don't blow up — they follow `W_{L,d}` with exponents **linear in `d`**;
  the `d`-band zeta is predictable from the 3-band one.
- **Band coupling = prime splitting.** The local factor depends only on the **decomposition type `(e,f)`**
  of `p` in `K` (`pO_K = ∏ 𝔭_i^{e_i}`, residue degrees `f_i`), via `W_{L,e,f}(X,Y)=∏_i W_{L,d}(X^{f_i},Y^{f_i})`.
  So *how spectral bands interact* is governed by *how primes split* — and there are only **finitely many
  regimes** (finite uniformity). This is the rigorous form of the analyses' hand-waved "scales robustly."
- **It scales the C.2 gem linearly.** Base extension multiplies the minimal grading weight:
  `wt(L⊗O_K) = d·wt(L)`. Since `b = wt` (symmetry factor) and `b = Q` (C.2, the Carnot homogeneous
  dimension of the colour gauge), **`Q_{d-band} = d·Q_{base}`** — a falsifiable prediction: the scaling
  dimension of a `d`-band colour-difference gauge is exactly `d×` the 3-band one (`8 → 8d`, `10 → 10d`,
  matching the 2025 paper's `8d=6d+2d`, `10d=8d+2d`).
- **Rigidity is the enabling condition.** The machine runs when `L_p` is **`Z(L_p)`-rigid** (its
  automorphisms over any extension are the three "obvious" types: scalar-linear, central, Galois). For the
  D\* family this holds at *all* primes — so multispectral colour sits in the good case.

**Honest limits.** Still pure arithmetic geometry: no codec, no perceptual fit. The "extension" is to the
*scaffolding* — how the colour-model invariants scale with bands — not to JXL plumbing; the `d`-linearity
is in the rational-function exponents, not a compression gain. But for the biodiversity multispectral
goal it is the right backbone: the algebra **scales predictably and uniformly** from RGB to many-band
specimen spectra, with band interaction read off the prime-splitting type.

**Net:** yes, a useful extension. It upgrades B.8.4 from "a route exists" to "a closed-form,
finitely-uniform scaling law, already computed for the D\* colour lattices," and makes C.2's `Q=b` scale
as `Q = d·Q_base` under multispectral extension.

---

*Scope note: this is a concept-and-plan document. No pipeline behaviour is changed by writing it.
Implementation starts at P0 only on your go-ahead, and every colour claim downstream is gated on your
confirmation in the real viewer.*
