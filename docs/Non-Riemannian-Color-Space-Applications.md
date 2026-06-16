# Non-Riemannian Perceptual Color Space: Theoretical Foundations and Engineering Applications

This document provides a rigorous, comprehensive blueprint for integrating a unified, non-Riemannian perceptual color science engine into our RAW-to-JXL pipeline, JS-based lightbox, and downstream image analysis tools (such as "Magic Wand" selection and diagnostic color extraction). 

---

## 1. Theoretical Foundations: The Death of the Riemannian Paradigm

For over a century, color science operated on the Helmholtz-Schrödinger paradigm: the assumption that perceived color space can be modeled as a three-dimensional Riemannian manifold. In this paradigm, the perceptual distance between two colors is defined as the length of the shortest path (geodesic) connecting them, satisfying the property of **additivity**:

$$D(A, C) = D(A, B) + D(B, C)$$

for any intermediate color $B$ lying on the geodesic between $A$ and $C$.

### 1.1 The Principle of Diminishing Returns (Bujack et al., 2022)
Through rigorous two-alternative forced-choice (2AFC) triad experiments conducted along the neutral axis, **Bujack et al. (2022)** mathematically disproved this additivity. Large color differences are systematically underestimated by human observers, meaning they are perceived as *less* than the sum of their small constituent parts:

$$D(A, C) < D(A, B) + D(B, C)$$

Because this strict inequality holds even along geodesics, **perceptual color space is fundamentally non-Riemannian**. This phenomenon is a consequence of a natural contrast-enhancement filter built into the human visual system, operating as a **second-order Weber-Fechner law** where perceived differences are compressed as the total distance increases. Consequently, standard metrics like CIEDE2000 are mathematically valid *only* for small differences (e.g., just-noticeable differences, or JNDs) and fail to model large transitions.

### 1.2 Geodesics and the Bezold-Brücke Effect (Bujack et al., 2025)
Schrödinger’s classic model defined "stimulus quality" (hue and saturation) as constant along straight lines connecting a color to the black apex. However, the **Bezold-Brücke effect** shows that changing physical intensity alters perceived hue (e.g., as light intensity decreases, hues drift toward pure red, blue, or green). 

To resolve this, **Bujack et al. (2025)** formalize Schrödinger's definitions of hue, saturation, and lightness by replacing straight lines with curved **geodesics originating at the absolute black apex ($O$)**. 
- **Lightness ($\sim_l$)**: Formulated as an equivalence relation where a color $F$ is equivalent to $F'$ if $F'$ is the perceptually closest point to $F$ along its line of constant stimulus quality.
- **Hue ($\sim_h$)**: Redefined such that colors of equal hue lie on the curved geodesic within the equal-lightness surface heading toward the neutral axis.
- **The Neutral Axis**: Geometrically defined as the path of closest proximity to black ($O$) within each equal-lightness surface. This elegant geometric definition is *only* mathematically consistent in a non-Riemannian framework.

---

## 2. Advanced Phenomena and Algorithmic Modeling

### 2.1 Hue Superimportance (Zeyen et al., Los Alamos / Kaiserslautern)
A primary driver of non-Euclidean behavior is **hue superimportance**—the psychophysical fact that changes in hue are perceived much more strongly than changes in saturation. For instance, an isoluminant circle of constant saturation centered on gray has an estimated circumference of approximately $4\pi \times r$ (where $r$ is the radial saturation), which is geometrically impossible to embed in a flat Euclidean plane.

### 2.2 Shortest-Path Discrete Interpolation
To interpolate colors across this non-Euclidean space, **Zeyen et al.** proposed a graph-theoretical approach now integrated into VTK and ParaView:
1. **Grid Discretization**: Discretize the RGB cube into a uniform $16^3$ or $32^3$ node grid to guarantee display-gamut safety.
2. **Edge Weighting**: Assign weights to edges using a non-Euclidean JND formula (such as CIEDE2000).
3. **Dijkstra’s Pathfinding**: Compute the shortest path on the graph dynamically to find the perceptually smoothest transition.

Because of hue superimportance, the calculated CIEDE2000 shortest paths are not straight lines; instead, they **curve dramatically toward the desaturated gray core** of the RGB cube. The human eye perceives desaturated intermediate steps as shorter "shortcuts" than wrapping around the highly saturated perimeter. 

#### Sharp Transitions and Hermite Splines
When interpolating across multiple user-defined control points, shortest-path algorithms can produce sharp, flower-like angular bends at the control points. To smooth these transitions in non-Euclidean space, we must apply **generalized Hermite curves** that adjust the local interpolation rate (sharpness $s$ and midpoint $m$) across neighboring node segments on the fly.

---

## 3. Categorical Geometry & Information Geometry (Griffin & Mylonas, 2019)

Traditional color metrics are driven by sensory discriminability (JNDs). However, human cognition groups colors into linguistic categories (e.g., "pale green", "peach"). **Griffin & Mylonas (2019)** pioneered the use of **Information Geometry** to construct a color metric based entirely on crowd-sourced naming distributions:

### 3.1 The Categorical Metric
If $P$ and $Q$ are the naming probability distributions of two nearby colors over a set of unconstrained names $O$, the distance between them is computed via the **Fisher Information Metric** (or infinitesimally generalized Jensen-Shannon Distance):

$$g_{ij}(\theta) = \sum_{w \in O} \frac{1}{P(w|\theta)} \frac{\partial P(w|\theta)}{\partial \theta^i} \frac{\partial P(w|\theta)}{\partial \theta^j}$$

Colours are considered close in this geometry if they are named similarly by a population, regardless of their physical JND spacing. 

### 3.2 The 27-Region Division
By computing the total volume of the sRGB cube under this categorical metric, the authors derived that exactly **27 categorically distinct regions** fit within our visible gamut. This corresponds closely to the $\sim 30$ color categories untrained human speakers naturally employ, providing a rigorous mathematical grid to select maximally distinct categorical color swatches.

---

## 4. Human Preference and Natural Statistics (Forni et al., iScience 2026)

### 4.1 The Ecological Underpinnings of Color Harmony
**Forni, Darmon, & Benzaquen (2026)** conducted a large-scale, quantitative study of color pairings in HSL space, cross-referencing results with hue distributions across 12,000 natural landscapes. 
1. **The Combinability Index**: Certain colors possess high global combinability (the inherent ability to pair harmoniously with almost any other color). Blue ($200^\circ - 240^\circ$) and yellow/orange ($40^\circ - 60^\circ$) have exceptionally high combinability. Greens and purples have very low, often inharmonious combinability.
2. **Natural Scene Matching**: Strikingly, the peak occurrences of hues in natural scenes (sky, sand, dead foliage) directly map to human aesthetic preferences and combinability indices. This strongly indicates that human color harmony preferences are **ecologically conditioned** by the statistical distribution of colors in our natural environments.
3. **Contrast Dominance**: Across all reference hues, human observers universally prefer paired colors separated by an angular distance of **$160^\circ$ to $220^\circ$ (complementary contrast)** on the color wheel. Equal-distance rules proposed by classical harmony theories (such as Moon & Spencer) are rejected; harmony is highly dependent on the absolute hues involved.

### 4.2 Linear Separability of Harmonious Groups
Applying Principal Component Analysis (PCA) to the symmetrized preference matrix $S_s = \frac{1}{2}(S + S^T)$ reveals that the hue wheel divides into **two complementary, linearly separable groups** when plotted on the CIE 1931 xy chromaticity diagram:
- **Group 1**: Orange to Cyan (spanning the central region of the visible spectrum).
- **Group 2**: Blue to Red/Purple (spanning the two spectral extremes and the purple line).

Hues from Group 1 combine beautifully with Group 2, but poorly with colors inside their own group.

---

## 5. System Architecture & Engineering Plan

The following multi-layered implementation plan translates these papers' findings directly into our RAW converter codebase.

```
                  [ RAW Input (16-bit linear RGB) ]
                                 │
                                 ▼
                     [ 1. SENSOR SHARPENING ]
                   (Matrix B: Input Characterization)
                                 │
                                 ▼
                    [ 2. PERCEPTUAL DECOUPLING ]
                  (Log-Transform: Flattening Geodesics)
                                 │
                                 ▼
                    [ 3. LOOKRENDERER PIPELINE ] ────► [ Dynamic LUT (SIMD) ]
                    (apply_tone_math Hot Loop)
                                 │
                                 ▼
             ┌───────────────────┴───────────────────┐
             ▼                                       ▼
     [ LIGHTBOX UI ]                       [ COMPUTER VISION TOOLKIT ]
  Perceptual Constancy Mode                ┌─────────┴─────────┐
  - Hue-Stable Geodesic Exposure           ▼                   ▼
  - Natural Pairing Harmonization    [ MAGIC WAND ]     [ DIAGNOSTIC EXTRACT ]
                                     Categorical + JND  Invariant Specimen
                                     Metric Selection   Color Coordinates
```

### Layer 1: Rust/WASM Core - The Non-Riemannian Perceptual Color Engine
*Located in: `crates/raw-pipeline/src/pipeline.rs` under the hot per-pixel `apply_tone_math` loop.*

1. **Input Characterization (Matrix $B$ & Log-Transform)**:
   - Apply a sensor-sharpening matrix $B$ to the 16-bit linear RGB input to align the camera sensors with the primary color receptors.
   - Perform a component-wise logarithmic transform to flatten Schrödinger's curved, hue-stable geodesics into a flat 3D Euclidean space. This resolves the Flatness Paradox and allows linear adjustments (exposure, contrast) to behave in a perceptually uniform, illumination-invariant manner.
2. **Molchanov Metric Tensor LUT**:
   - Construct a precomputed 3D Lookup Table (LUT) in Rust to handle local defects and the Bezold-Brücke effect.
   - This LUT will adaptively discretize the metric tensor grid, concentrating grid density around neutral grays and saturated greens using Molchanov's parallelogram law residuals.
3. **Hybrid Correction near Grays**:
   - Near the neutral axis, apply a hybrid correction blending Riemannian geodesic steps with direct non-Riemannian $\Delta E_{2000}$ corrections, acting as a "spring force" to stabilize coordinates and prevent coordinate drift.

### Layer 2: JavaScript / Decode API Bridge - Cache Purity and `lookParams`
*Located in: `packages/jxl-scheduler/` and `src/decode-core.ts`*

1. **Dynamic `lookParams` Forwarding**:
   - Thread an opaque `lookParams` parameter through the decode facade. When active, WASM will execute the fused decode-and-look transform in a single heap pass before copy-out.
2. **The Cache-Purity Rule (Crucial Guardrail)**:
   - To prevent slider adjustment latency and stale-render hits, the decoded JXL tile cache must store **pristine, un-transformed pixels only**.
   - When Perceptual Constancy Mode is active, maintain a lazy, temporary shadow buffer. Copy the raw decoded tile into the shadow buffer, write the pristine tile to the cache, and then apply the perceptual look transform in-place on the display buffer.

### Layer 3: Downstream Applications and Interactive Tools

#### Application A: The Lightbox "Perceptual Constancy Mode"
- **Illumination Invariance**: By executing the log-transformed geodesic exposure math, clouds, shadows, and sunlight cast over vegetation/landscapes will be mathematically cancelled out. The vegetation maintains a stable, homogenous hue.
- **Harmonious Palette Suggestion**: Integrate the **iScience 2026** findings to suggest harmonious natural color swatches. When editing a landscape, the UI can automatically extract the dominant hue and offer high-combinability complementary accents (such as highly combinable blues and oranges/yellows) that are statistically validated by nature's own palette.

#### Application B: The "Magic Wand" Selection Tool
- **Dual-Metric Engine**: Traditional selection tools fail across lighting boundaries. Our Magic Wand will operate on a dual-metric threshold:
  1. **Sensory Metric ($D_{JND}$)**: Uses the local Molchanov distance structure tensor $A_{tensor}$ to determine precise, edge-preserving physical boundaries.
  2. **Categorical Metric ($D_{Cat}$)**: Implements **Griffin's Information Geometry Metric**. Selections evaluate name-distribution similarity. If a user clicks on a petal, the wand evaluates if neighboring pixels fall into the same categorical bucket (e.g., "pale pink" vs "magenta"), allowing the tool to cleanly "stick" to the flower boundaries, disregarding shadow gradients and dappled sunlight.

#### Application C: Diagnostic Color Extraction
- **Zero-Swatch Absolute Calibration**: For botanical diagnostics or agricultural monitoring, we require the absolute, intrinsic color of a specimen (e.g., a flower or leaf) without physical MacBeth charts.
- **Geodesic Neutral Axis Query**: By calculating the shortest path from the target color to the geometric neutral axis (formalized under the non-Riemannian framework as the closest point to black on the equal-lightness surface), we can isolate and remove the illumination vector. 
- Apply the **second-order Weber-Fechner compression curve** to extract a highly stable, repeatable, and standardized color coordinate representing the plant's true diagnostic state.

#### Application D: Real-Time AR Rendering (Akleman's Hyper-Realist Framework)
To enable real-time visualization of these color models on mobile or head-mounted AR devices, we adopt **Akleman’s theoretical framework**:
1. **Decompose Illumination and Shading**: Move shading entirely to the compositing/post-processing stage. By operating on algebraically complete color structures, we can execute the non-Riemannian color transforms as a fast post-process shader.
2. **Statistic-Based Shading**: Reconstruct proxy scene geometry, light positions, and intensities from the camera's image-based lighting on the fly. Instead of implementing slow, physically-based global illumination, we run statistical-based shading kernels inside the WASM-resident `LookRenderer` to generate highly believable, hyper-realistic shadows and reflections on virtual objects at sub-millisecond speeds.

---

## 6. Verification and Validation Strategy

### 6.1 Mathematical Integrity Tests
- **Additivity Violation Verification**: Implement unit tests in Rust to confirm that the precomputed non-Riemannian metric model successfully yields $D(A, C) < D(A, B) + D(B, C)$ along the simulated neutral axis.
- **Bezold-Brücke Geodesic Verification**: Test that rendering a color strip with decreasing luminance under constant stimulus quality yields curved paths in CIERGB that match the empirical Ebner and Fairchild datasets, rather than straight lines to the origin.

### 6.2 Performance Benchmarking
- **Sub-Millisecond LUT Search**: Benchmark the WASM LUT lookup. The dynamic 3D Dijkstra pathfinding (or interpolated approximation) must resolve within **0.5ms** per tile to satisfy the 11ms frame-rate budget (90Hz) required for fluid AR and real-time lightbox sliders.
- **Cache Invariance Test**: Assert that shifting the exposure slider in the Lightbox does *not* trigger re-decodes of JXL tiles, validating that the pristine cache remains untouched and only the post-read shadow buffer is mutated.

---

## 7. Strategic Impact

Implementing this unified non-Riemannian architecture achieves three primary goals:
1. **Scientific Parity**: It places our software at the cutting edge of visual cognition research, making us the first commercial-grade engine to fully implement the Los Alamos and UCL non-Riemannian formulations.
2. **Tool Revolution**: It transforms the "Magic Wand" and "Color Picker" from simple pixel-difference algorithms into sophisticated, cognitive tools that select and extract color based on human categorizations and illumination-invariant physics.
3. **Immersive Real-Time Performance**: By combining shortest-path discrete graphs with hyper-realistic rendering frameworks, it allows complex global illumination and perceptual transformations to execute in real-time, bridging the gap between high-fidelity RAW development and responsive, fluid user experiences.