# Non-Riemannian Colour Mathematics in the CasaBio Pipeline

**Exploration + implementation plan.** Status: design doc, nothing implemented yet.
Companion to the earlier thin draft `Non-Riemannian-Color-Space-Applications.md`,
which leaned on terms that do **not** appear in any source paper ("Molchanov
anisotropy", "Harvard HPCS", a "sensor-sharpening matrix B"; see §9 *Reject on
sight*). This document is the grounded version: every claim is tied to a paper in
`C:\Foo\Papers\Non-Riemannian` and every build step to a real repo file.

Audience: an ecologist building a biodiversity imaging platform, plus the engineers
who own the RAW→JXL pipeline. Maths kept honest, engineering mapped to files.

---

## 0. The one-paragraph version

Human colour vision is **non-Riemannian**: a big colour difference is perceived as
*less* than the sum of the small steps that make it up ("diminishing returns").
Bujack et al. proved this rules out the 100-year-old assumption that perceived
colour is a Riemannian space, and then — crucially for us — showed you can still
model it efficiently as an ordinary Riemannian metric **plus a scalar damping
function applied to distance**. From that metric you can derive hue, saturation and
lightness *geometrically* (the Geometry-of-Colour paper) instead of from the crude
HSL cylinder. For a field biodiversity platform this buys the three things the user
asked for: (1) a viewer mode where a leaf or petal keeps the **same perceived hue**
in sun or cloud; (2) a **magic-wand** that sticks to a flower instead of breaking
across its own shadows and highlights; (3) a **swatch-free diagnostic colour value**
you can pull from a specimen and report. The rest explains why that works, where it
stops working, and how to build it.

---

## 1. What the papers actually say (grounded primer)

### 1.1 Diminishing returns ⇒ colour space is not Riemannian
**Bujack, Teti, Miller, Caffrey, Turton — "The non-Riemannian nature of perceptual
color space", PNAS 119(18), 2022.**

- In a Riemannian space, distances are *additive along a geodesic*: if `B` lies on
  the shortest path `A→C`, then `d(A,B) + d(B,C) = d(A,C)`.
- Human perception instead obeys **diminishing returns**:
  `d(A,B) + d(B,C) > d(A,C)` — even along the geodesic. Large differences feel
  *smaller* than the sum of their parts.
- A 2-alternative-forced-choice crowd study (320 triads on the neutral axis, ≥250
  judges each) measured a concave scaling function `f`, confirming the inequality is
  strict. One violation anywhere proves the whole space is non-Riemannian.
- Consequence: ΔE2000 and every CIE metric are valid only for *small* differences.
  This is why naive Euclidean ΔE over-counts large within-object swings (sun vs.
  shade on one petal).

### 1.2 You can still compute with it: induced-Riemannian + damping
**Bujack, Stark, Turton, Miller, Rogers — "The Geometry of Color in the Light of a
Non-Riemannian Space", Computer Graphics Forum 44(3), 2025.**

- Formalises Schrödinger's idea that **hue, saturation and lightness derive from the
  perceptual metric alone** — no external white point:
  - **Lightness** constant along the geodesic from a colour to the neutral axis.
  - **Hue** = equivalence class of colours sharing a geodesic to the neutral axis
    within an equal-lightness surface.
  - **Saturation** = (relative) distance from the neutral axis.
  - **Neutral axis** = the colour in each equal-lightness surface *closest to black*
    — a definition only coherent in a non-Riemannian setting.
- **The result we exploit most:** the geodesics of the true non-Riemannian metric
  and of its *induced* Riemannian metric **coincide** (Theorem 1; their experiments
  found no evidence against it). The non-Riemannian behaviour lives entirely in a
  **monotone scalar damping `f` applied to arc length**. So we get Riemannian
  geodesic-solving efficiency and need only a 1-D LUT for `f` to recover true
  perceived distance. This is the bridge from "interesting psychophysics" to "ships
  in a WASM hot loop".

### 1.3 How to interpolate / measure paths in such a space
**Zeyen, Post, Hagen, Ahrens, Rogers, Bujack — "Color Interpolation for
Non-Euclidean Color Spaces" (VTK/ParaView).**

- Generalises linear interpolation to "walk the shortest path under an arbitrary
  distance measure": build a graph on an RGB grid (26-neighbourhood), weight edges
  by ΔE2000, run Dijkstra. Resolution 16³, neighbourhood 1 was the speed/quality
  sweet spot (~0.1 s); higher resolutions barely change the path.
- Caveat they flag: **graph-theoretic path length gives a false advantage to coarse
  paths** *because* of diminishing returns. Measure path length by supremum over
  fine samples, not by summing coarse hops. (Directly relevant to the Fréchet-mean
  colour extraction in §4.3 — do not average naively.)

### 1.4 Colour as *categories*, not just discriminability
**Griffin & Mylonas — "Categorical colour geometry", PLoS ONE 14(5), 2019.**

- Builds a Riemannian metric from **colour-naming data** (1000 subjects, 20k names,
  600 chips) via Information Geometry: two colours are close if the population
  *names them the same way*. Distance = change in the naming distribution
  (Fisher / Bhattacharyya).
- Defines a natural unit, the **grain** (separation between two disjoint naming
  distributions); ~27 categorically-distinct regions fit the RGB cube, matching the
  ~30 colours people name unaided.
- A *different* geometry from discriminability (ΔE), and the right tool for "select
  the flower by its colour *identity*" and for read-outs a human describes in words
  ("pale mauve", "sulphur yellow").

### 1.5 Supporting / contextual
- **Burambekova & Shamoi — "Comparative Analysis of Color Models for Human
  Perception…", 2024.** Survey of RGB/HSV/HSL/XYZ/CIELAB/CIELUV vs. perception;
  confirms ΔE2000's limits and the non-Riemannian trend. Justification for *not*
  doing magic-wand maths in RGB/HSL.
- **Akleman — "Hyper-Realist Rendering", 2024.** Uses "non-Riemannian" as a
  rendering metaphor (impossible shapes, decoupled illumination + shading). Not a
  colour-metric source, but its **illumination/shading split** is a useful
  architectural analogy for the constancy mode (§4.1).
- PDFs present but **not yet mined** (titles only — do not cite specifics until
  read): Berthier & Provenzi (quantum / Jordan-algebra colour), Brainard "proximity
  matters", JMIV `s10851-024-01223-9`, the harmonious-pairings preference paper.
  Listed in §10.

---

## 2. The honest caveat: non-Riemannian ≠ illumination invariance

The user's goal — "cancel out hue such that clouds or sunlight make the vegetation
look relatively invariant" — conflates two different problems. Saying so up front
saves a wasted build.

| Problem | What it is | What solves it |
|---|---|---|
| **Perceptual *distance*** | How big is the difference between two colours? | Non-Riemannian metric + damping `f` (Bujack). Fixes magic-wand "breaking". |
| **Colour *constancy*** | What is the surface's *intrinsic* colour, independent of the illuminant? | A separate illuminant-estimation / reflectance step. The papers do **not** deliver this. |

**The real connection** (load-bearing, and it *is* grounded): the Geometry paper's
decomposition gives a **hue equivalence class** and a **saturation** coordinate
derived from perception, not from a lighting assumption. Empirically a cloud→sun
change mostly moves a surface colour along **lightness** (and somewhat saturation),
while its **hue geodesic to the neutral axis is comparatively stable**. So:

> Projecting every pixel onto *which hue-geodesic it lives on* (and optionally its
> saturation), while normalising or discarding lightness, yields an
> illumination-*robust* descriptor — not a physically exact constancy solution, but
> a principled, perception-derived one, far better than HSL hue.

Diminishing returns helps too: the large luminance gap between a sunlit and a
shadowed part of the same leaf is **perceptually compressed** by `f`, so under the
proper metric those pixels are already much closer than Euclidean ΔE says. That is
exactly the "relatively invariant" behaviour the user wants, and it falls out of the
metric for free.

What this is **not**: it will not fully correct a strong colour cast (blue skylight
in open shade, golden-hour warmth). For *diagnostic* extraction (§4.3) that residual
cast still matters, so we keep an optional, *explicit* white-balance / illuminant
step in front of the geometry — separate layer, separate switch. (This matches the
project rule: trust camera-stored WB unconditionally; gray-world only when WB is
absent.)

---

## 3. The unifying model we will adopt

One model, reused by every feature below.

1. **Affine base space.** Work in the existing linear, camera-matrix-corrected
   RGB16 that `LookRenderer` already holds (`src/lib.rs`). Our "CIERGB-like" affine
   cone (cf. Geometry paper §3).
2. **Metric tensor field `g(z)`.** A 3×3 symmetric positive-definite matrix at each
   cube point, precomputed on a grid and interpolated. Two interchangeable sources:
   - **Discriminability metric** — Riemannised ΔE2000 (Pant & Farup style; the
     Geometry paper calls this "Riemannized ΔE2000"). For the magic wand and encode QA.
   - **Categorical metric** — Griffin & Mylonas's naming-derived tensor (downloadable
     grid, Zenodo `10.5281/zenodo.2595963`). For "select by colour identity" and
     human-readable read-outs.
   The two are *selectable*, not blended — they answer different questions.
3. **Geodesics by ODE, not Dijkstra.** Because the non-Riemannian and induced
   geodesics coincide (§1.2), solve the geodesic equation on `g` (fast, smooth)
   instead of graph Dijkstra. Keep a Dijkstra fallback (Zeyen) for validation only.
4. **Damping `f` as a 1-D LUT.** Apply the concave scaling `f` to arc length for
   *true perceived* distance. `f` is one monotone curve (MacAdam polynomial / Helm
   log / Izmailov sinusoid are the candidate shapes — fit our own data later;
   default to the PNAS neutral-axis fit).
5. **Geometric H/S/L operators** from `g`:
   - `neutralOf(z)` → closest-to-black point in `z`'s equal-lightness surface.
   - `hueClassOf(z)` → tangent direction of the geodesic `z → neutral`.
   - `saturationOf(z)` → damped distance `z → neutral`.
   - `lightnessOf(z)` → geodesic position toward the apex/neutral.

Everything in §4 is a thin consumer of these five operators plus the metric.

---

## 4. The myriad uses

### 4.1 Illumination-robust "Perceptual Constancy" lightbox view *(headline)*
**Goal:** a leaf/petal keeps its perceived hue across sun/cloud; reduces need for
in-frame swatches when *comparing* specimens by eye.

**Mechanism:** render from `hueClassOf` + (optionally) `saturationOf`, with lightness
flattened toward a reference. Two strengths:
- *Soft* (default): keep lightness but compress it via `f`, so within-object
  sun/shade swings shrink while the scene still looks natural.
- *Hard* ("hue map"): replace lightness with a constant; the image becomes a pure
  hue/saturation field — clouds vs. sun collapse almost entirely. A comparison
  toggle, not the primary photo.

**Why it beats HSL:** HSL hue is a naive angle in a non-perceptual cylinder; it
drifts under saturation/lightness changes (the Abney / Bezold-Brücke effects the
Geometry paper handles by using *geodesics from the apex*, not straight lines). Our
hue class is metric-derived and stable.

**Layer:** a *look*, so it belongs in `LookRenderer::render` (`src/lib.rs`) as a new
mode, on RGB16 before copy-out. Cache stays pristine (CLAUDE.md cache-purity rule);
the transform applies to the shadow buffer per render, like the existing tone
sliders.

### 4.2 Magic-wand / region-growing that sticks to flowers and shapes
**Goal:** flood-select a petal/leaf without leaking across its own highlights and
shadows, or bleeding into a differently-named neighbour.

**Mechanism:** region grow where the **stop criterion is metric distance, not RGB**:
- **Discriminability metric with damping** so a large *luminance* step inside one
  object (specular highlight, cast shadow) is compressed and stays *inside* the
  region.
- Optionally constrain growth to **one categorical grain** (Griffin) so the wand
  respects "this is all *green*" even where ΔE wanders — great for "select the whole
  flower".
- Expose tolerance in **perceptual units** (JNDs or grains) — meaningful and
  portable, unlike an RGB "tolerance: 30".

**Layer:** per-pixel distance query is a WASM fast-path; flood-fill frontier logic
stays in JS (`web/lightbox/*`). New methods `distance(zA, zB, metric)` and a batched
`nearestUnderMetric` for the frontier.

### 4.3 Swatch-free diagnostic colour extraction
**Goal:** pull a defensible, reportable colour value from a specimen ROI without a
MacBeth / colour-checker in frame.

**Mechanism:**
1. (Optional, explicit) illuminant normalisation in front — see §2. For true
   diagnostics keep this honest and labelled.
2. Project the ROI onto its **hue geodesic + saturation**; report lightness
   separately with its own confidence.
3. Aggregate over the ROI with a **geodesic / Fréchet mean under the metric**, *not*
   an arithmetic RGB mean. Zeyen's warning applies: diminishing returns biases naive
   averaging; the metric mean is the unbiased centroid.
4. Report `{name + grain-distance, lab, hex, dispersion}`: nearest **categorical
   name + grains** (human confidence), stable Lab/hex (machines), and **dispersion**
   (ROI tightness in grains → clean reading vs. mixed patch).

**Layer:** a new read-only analysis endpoint; no pipeline mutation.

### 4.4 Perceptually-uniform colormaps & overlays (occurrence density, indices)
Use Zeyen shortest-path interpolation (ΔE2000, 16³ grid) for any continuous overlay
the platform paints — occurrence heatmaps, trait gradients, sampling-effort maps —
so equal data steps look like equal colour steps. Already-shipping VTK/ParaView
technique; cheapest first win and a way to validate the metric plumbing before
touching the viewer.

### 4.5 Colour-based clustering, search and dedupe across the collection
"Find all occurrences whose flower colour is within *N* grains of this one." Index
each image/occurrence by its §4.3 descriptor; search/cluster in the **categorical
metric** so results align with how a botanist would group them. The whole-system
("woods, not trees") view of a collection's colour structure.

### 4.6 Better perceptual bit-allocation & convergence cutoff in the JXL encode
The `convergedByteEnd` / visual-saturation work (see project memory) decides when
extra bytes stop mattering perceptually. Replace any Euclidean ΔE gate with a
**diminishing-returns ΔE**: large early differences are damped, so the cutoff better
matches when a *human* stops seeing improvement. Measurement-only in WASM, abort in
the stream layer (existing invariant). Needs benchmark data before tuning.

### 4.7 Accessibility / colour-vision-deficient rendering
The same operators can **maximise categorical separation** for CVD viewers: re-map
hues to preserve *grains of separation* under a CVD-simulated metric, so a red/green-
confusable pair stays distinguishable. Optional viewer mode.

### 4.8 Sidecar metadata for occurrences (IIIF / Darwin Core friendly)
Persist the invariant colour descriptor (§4.3) as occurrence metadata in the JXL
sidecar / pyramid manifest, so colour becomes a **first-class, queryable trait** of
a georeferenced specimen — feeding species-ID and sampling tools without re-decoding
pixels.

---

## 5. Architecture & layer placement

Respect the existing layer map and invariants (CLAUDE.md).

```
LookRenderer (src/lib.rs)            ← constancy view (§4.1) renders here, RGB16, pre-copyout
  └─ pipeline (crates/raw-pipeline)  ← metric tensor field, geodesic solver, f-LUT, H/S/L ops
                                        new module: colour_geometry.rs
WASM facade methods                  ← distance(), nearestUnderMetric(), extractDiagnostic()
  └─ web/lightbox/*                  ← magic-wand frontier logic (JS), constancy toggle UI
  └─ web analysis endpoint           ← diagnostic read-out (§4.3), search index (§4.5)
jxl-stream / convergence             ← diminishing-returns ΔE gate (§4.6)
```

Rules carried over:
- **Cache purity:** decoded tiles stay un-transformed; colour-geometry effects apply
  to a shadow buffer at read time (sliders/toggles stay fluid).
- **Backpressure / dedupe / budget** untouched — this is a colour layer, not a
  scheduler change.
- **No new tunables without benchmark data** (the `f` shape, grain thresholds, grid
  resolution all need our own measurements before hardening).

---

## 6. Implementation plan (phased)

**Phase 0 — Spike & validate the metric (no UI).**
- Port Griffin's tensor grid (Zenodo) and a Riemannised-ΔE2000 tensor into a Rust
  `colour_geometry` module. Implement geodesic-ODE solve + Dijkstra fallback; assert
  they agree on test pairs (validates the §1.2 coincidence on our data).
- Implement the five operators (§3) and the `f`-LUT. Unit-test against the
  half-ellipse counterexample in the Geometry paper (closest-point ≠ geodesic
  endpoint).
- Deliverable: `cargo test` proving operators + a CLI printing hue-class / saturation
  / grains for sample colours. *No pixels touched.*

**Phase 1 — Cheapest visible win: perceptual colormaps (§4.4).**
- Wire Zeyen shortest-path interpolation into one overlay. Pure additive; exercises
  the metric end-to-end at low risk.

**Phase 2 — Diagnostic extraction (§4.3) + sidecar (§4.8).**
- ROI → Fréchet mean → `{name, grains, lab, hex, dispersion}` endpoint. Read-only,
  highest *scientific* value. Get numbers in front of the user to confirm against
  their viewer before live rendering (standing rule: *report numbers, ask the user
  to confirm — never claim colour fixed until they test in their own viewer*).

**Phase 3 — Magic wand (§4.2).**
- WASM `distance` / `nearestUnderMetric`; JS frontier flood-fill in the lightbox;
  tolerance UI in JNDs / grains.

**Phase 4 — Perceptual Constancy view (§4.1).**
- New `LookRenderer::render` mode (soft + hard), behind a toggle. Benchmark per-tick
  cost; if per-pixel geodesic solving is too slow, bake a **3-D LUT** from the
  validated metric (the *real* LUT/SIMD idea — not the fabricated "matrix B").

**Phase 5 — Encode gate (§4.6), accessibility (§4.7), collection search (§4.5).**
- Opportunistic; each gated on Phase 0 metric being trusted and on benchmark data.

Each phase is independently shippable and reversible.

---

## 7. Success criteria

- **Constancy:** for hand-labelled leaf/petal patches shot under sun *and* cloud, the
  §4.3 hue-class descriptor varies less across lighting than HSL hue and than raw Lab
  `a*b*` (measure: spread in grains). Target: materially tighter; number TBD from data.
- **Magic wand:** on dappled-light flower images, metric-grow selects the flower with
  fewer leaks across its own shadow/highlight than an RGB-tolerance wand at matched
  recall.
- **Diagnostics:** §4.3 read-out agrees with a physical colour-checker within a stated
  grain tolerance on a controlled test shot.
- **No regressions:** cache purity, scheduler invariants, slider latency unchanged.

All three perceptual claims require **user confirmation in the user's own viewer**
before we call them done.

## 8. Risks & open caveats

- **Constancy is approximate, not physical** (§2). Label any "invariant" read-out as
  *perception-derived*, not colorimetric ground truth, unless a real white-balance
  step is engaged.
- **Metric provenance.** Griffin's metric is English-naming, 2008–15, sRGB-display
  population — culturally and gamut-bounded. Fine for relative grouping; flag for
  cross-cultural / scientific naming.
- **Performance.** Per-pixel geodesic solving is too slow for a live slider; plan on
  a validated 3-D LUT for the viewer path. Measure before optimising.
- **`f` is not yet ours.** Borrowing the PNAS neutral-axis fit. Our cameras / display
  / specimens may want a re-fit; treat `f` as data, not a constant.
- **Triangle-inequality violations in ΔE2000** (Sharma et al.; Zeyen §2) — the raw
  formula isn't strictly a metric. Use the *Riemannised* version for anything that
  assumes metric axioms.

## 9. Reject on sight (fabrications from the earlier draft)

| Claim | Why rejected |
|---|---|
| "Molchanov anisotropy / structure tensor `A_tensor`" | Not in any source paper. Fabricated. |
| "Harvard perception-based colour space (HPCS)" | No such cited space. Fabricated. |
| "Sensor-sharpening matrix `B` flattens geodesics by log-transform" | Hand-wave; the real flattening is *induced-Riemannian geodesics + scalar `f`* (§1.2). |
| "Blend the discriminability and categorical metrics" | They answer different questions; no justification. Select, don't mix (§3). |
| "Average ROI colour as arithmetic RGB/Lab mean" | Diminishing returns biases it; use the Fréchet mean under the metric (Zeyen §1.3). |
| "Non-Riemannian maths gives true colour constancy" | It gives robustness, not constancy; constancy is a separate illuminant step (§2). |

## 10. Source corpus & follow-up reading

Read & incorporated:
- Bujack et al., *The non-Riemannian nature of perceptual color space*, PNAS 2022.
- Bujack et al., *The Geometry of Color in the Light of a Non-Riemannian Space*, CGF 2025.
- Zeyen et al., *Color Interpolation for Non-Euclidean Color Spaces* (VTK/ParaView).
- Griffin & Mylonas, *Categorical colour geometry*, PLoS ONE 2019. Metric grid:
  Zenodo `10.5281/zenodo.2595963`.
- Burambekova & Shamoi, *Comparative Analysis of Color Models…*, 2024.
- Akleman, *Hyper-Realist Rendering*, 2024 (illumination/shading-split analogy only).

Now mined — full treatment lives in the authoritative
`docs/Non-Riemannian Fable Max Overview.md` (Appendix A + §1.5 + §3.4):
- Berthier & Provenzi (`Revised_Version_Berthier_Provenzi.pdf`) — quantum / Jordan-
  algebra / hyperbolic colour; **contests** Bujack's non-Riemannian inference.
- Farup & Rivertz, JMIV `s10851-024-01223-9.pdf` — Resnikoff ℝ⁺×ℍ hyperbolic
  geometry, closed-form `arcosh` geodesics, Sochen/Beltrami flows.
- Brainard, *Proximity matters* (`brainard-2022-proximity-matters.pdf`) — PNAS
  commentary; endorses non-Riemannian as an *approximation*, two caveats (neutral-
  axis-as-geodesic unproven; aggregate ≠ individual).
- *Harmonious color pairings* (Forni et al. 2026) — preferred pairs ≈ complementary;
  combinability tracks natural-landscape hue statistics; palette prior (§3.4).

The authoritative `Fable Max Overview` doc supersedes this sibling on the science;
this file keeps the broader per-use-case engineering detail (§4.4–4.8).

## 11. Immediate next step

Phase 0 spike: stand up `crates/raw-pipeline/src/colour_geometry.rs` with the two
metric tensors, the geodesic solver + Dijkstra cross-check, the five operators, and
`cargo test` against the Geometry paper's half-ellipse counterexample. No pixels, no
UI — prove the maths on our toolchain first, then build outward per §6.
