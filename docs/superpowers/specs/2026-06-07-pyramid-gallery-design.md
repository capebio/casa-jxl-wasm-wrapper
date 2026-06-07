# Pyramid Gallery Pipeline — Design Spec

**Date:** 2026-06-07
**Branch:** Opus4.8MaxInvestigationImplementation
**Status:** Approved design, pre-implementation

---

## 1. Goal

Serve approximately-right-sized JPEG XL images for a web/mobile gallery (iPhone-Photos
feel) from full-size RAW (ORF/DNG/CR2) or JPG masters. Three experiences:

1. **Gallery grid** — fast seed at low resolution, then upgrade to a right-sized level.
2. **Zoom/pan** — seamless level upgrades on zoom, ROI for massive scans.
3. **Lightbox** — feature-rich viewer with live photo adjustments, including true
   16-bit highlight/shadow recovery on RAW masters.

Progressiveness comes from a **resolution level ladder over the wire**, NOT from
within-image DC preview. (Benchmark: DC preview loses to a pyramid level for
local/in-memory bytes — time-to-DC ≈ 373 ms vs pyramid L0 256px ≈ 19 ms.)

## 2. Topology — Hybrid

```
[on-device]                      [dumb host]              [browser]
Node CLI ingest                  static / CDN             web client
  RAW/JPG master                   *.jxl per level          fetch right-sized level
  → build JXL pyramid     push→    manifest.json     get→    render level ladder
  → write manifests                index.json               lightbox + adjustments
```

- **Server holds ZERO image logic.** No server-side resize, no transform endpoint.
  It serves immutable static bytes. Any static host or CDN works.
- **On-device ingest** does all RAW decode + pyramid encode once, at ingest time.
- **Client** fetches the level it needs and paints to canvas via the WASM decoder.

**Why:** RAW decode is the cost center (~2475 ms/image for DNG 3628×2731 → RGBA8).
It must happen once at ingest and be cached forever; per-view must never touch the RAW.

## 3. Constraints & Grounded Facts

- **RAW decode ≈ 2.5 s/image** (`process_dng`); JXL decode of prebuilt full ≈ 302 ms;
  prebuilt L0 256px ≈ 19 ms. Warm JXL decode is ~linear in requested pixels
  (~19 / 56 / 217 / 302 ms for 256 / 1024 / 2048 / full).
- **Sidecar encoder floors quality.** `encode_rgba8_with_sidecars` clamps every
  sidecar to distance ≥ 1.5 (≈ q87 ceiling) at `bridge.cpp:2658`. It CANNOT give the
  2048 level q90/95. → Ingest uses **standalone per-level encode**, not the sidecar call.
- **2D canvas is 8-bit sRGB.** True >8-bit display requires a WebGL float texture.
  16→8 downconvert for the 2D path uses Floyd-Steinberg dithering.
- **Native browser JXL is unreliable in 2026** (Chrome behind flag, Safari renders but
  no progressive, Firefox 152). → WASM-canvas is primary; native `<img>.jxl` is a
  static fallback only.
- **MT WASM requires COOP/COEP** (`Cross-Origin-Opener-Policy: same-origin` +
  `Cross-Origin-Embedder-Policy: require-corp`). Production host must send these.
- **Built WASM exports** (verified `exports.txt`): decode/encode rgba8/16/f32,
  rgba8/16/f32 region decode, tile-container encode/decode **rgba8 only**. No rgba16/f32
  tile-container export yet.

## 4. Ingest — Node CLI

Batch CLI, run on-device. Pure-WASM (no `sharp` native dependency).

**Inputs:** ORF, DNG, CR2 (`process_orf` / `process_dng` / `process_cr2`), and JPG
(`transcodeJpegToJxl` → `_jxl_wasm_decode_rgba8` to get RGBA, then encode pyramid).

**Pyramid levels:** sizes `[256, 512, 1024, 2048]` + full. Each size = long-edge target.
Skip any level whose long edge ≥ the master's long edge (no upscaling).

**Downscale:** area-average box filter via `downscale_rgba` (Rust) / `BoxDownscaleRgba8`.
Cascade smallest-from-previous: full → 2048 → 1024 → 512 → 256. Integer fast path on
exact 2× steps; ceiling-division full-coverage path otherwise. (512/640 intermediate is
cheap because it is one more cascade step, not a re-downscale from source.)

**Per-level quality** (distance set per level, NOT uniform):
- `{256, 512, 1024}` → q85
- `{2048, full}` → q95 (user prefers 90–95 on big images)
- effort = 3 (user's prior measurements: effort 3 best on speed + filesize)

**Encode:** standalone per-level `_jxl_wasm_encode_rgba{8,16}` (exact per-level
quality + bit depth). NOT the sidecar call.

**Bit depth:**
- JPG inputs → all levels 8-bit (source is 8-bit; no recovery headroom exists).
- RAW inputs → 16-bit for big levels `{2048, full}`; 8-bit for the grid `{256, 512,
  1024}`. Manifest records `bitsPerSample` per level.
- f32 deferred (not in v1).

**Orientation:** baked into pixels at ingest (no EXIF-orientation reliance downstream).

**Color:** output sRGB, 8-bit tag; embed ICC only if the working space is wider than sRGB.

**Threshold-gated JXTC tiling:** if master long edge > ~8000 px (> ~40 MP), encode the
**top level** as a JXTC tile container (independent per-tile bitstreams + byte-offset
index) so the client can ROI-decode it in parallel. Smaller masters: whole-frame levels
only. (v1 JXTC is rgba8 only — see Build Deps.)

**Parallelism:** bounded `min(cores, memBudget / perImageRGBABytes)`; 16-bit halves the
per-image budget (2× bytes). Per-file isolation — one bad file never aborts the batch.

**Resumability:** skip an image if its manifest exists and the master mtime is unchanged.

## 5. Storage & Transport (Option A)

- One `{contenthash}.jxl` file **per level** (content-addressed → dedupe + immutable).
- Per-image `manifest.json`: levels array, each `{ size, w, h, bytes, bitsPerSample,
  contenthash, tiled? }`, plus orientation-baked dimensions and aspect.
- Gallery `index.json`: per-image aspect + L0 reference inlined (one round-trip seeds the
  whole grid layout without N manifest fetches).
- `Cache-Control: public, max-age=31536000, immutable` (content-hashed names).
- HTTP/2 (many small level files multiplex cheaply).

## 6. Client — Gallery Grid

- Fetch `index.json` → lay out grid by per-image aspect (no layout shift; aspect known
  before any image bytes).
- **Seed:** one-shot decode L0 (256px) → paint immediately.
- **Upgrade:** pick the level matching `tileSize × devicePixelRatio`; decode → crossfade.
- **Monotonic:** never downgrade a tile that already painted a higher level (no fl/flash
  on scroll-back).
- **Lazy:** decode only viewport + a prefetch ring; cancel offscreen via scheduler.
- Reuse scheduler (preempt/dedupe/backpressure), in-mem LRU + OPFS cache.
- One-shot `_jxl_wasm_decode_rgba8` per tile (avoids ~15–20 ms streaming-decoder overhead).

## 7. Client — Lightbox (modeled on CasaBio app)

Model: `C:\Users\User\AndroidStudioProjects\CplusplusTest\` (Kotlin + native libjxl —
already JXL-based). Port the **interaction + adjustment model**, not the Android extras.

**Viewing:**
- Pick level by `screenLongEdge × DPR`.
- Zoom ladder: L1 → L2 → full, crossfade on each step. Cap at full, OR JXTC ROI decode
  for a tiled top level (cost ∝ visible area).
- Pan = canvas transform (no re-decode until zoom level changes).
- Live zoom-% readout (mirrors CasaBio `txtZoomPct`).
- Current-page vs prefetch decode priority via scheduler (mirrors CasaBio dual
  dispatchers); screen-bitmap LRU.

**Adjustments (mirror `FilterEngine.kt`):**
- Presets: BW / BW_HIGH / BW_SOFT / SEPIA / INVERT / BOTANICAL / WARM / COOL / DEHAZE /
  BLUEPRINT / CHLOROPHYLL / NONE.
- Params: brightness, contrast, saturation, shadows (lift), highlights (compress),
  clarity, dehaze, sharpness; live histogram.
- Live preview via canvas/WebGL color-matrix (8-bit path), same math as CasaBio's
  `ColorMatrixColorFilter` live preview.

**16-bit toggle (RAW only):** off by default (user is happy seeing 8-bit normally).
When on: decode the 16-bit level → WebGL float-texture adjust (real highlight/shadow
recovery headroom — the CasaBio sliders currently run on clipped 8-bit) → Floyd-Steinberg
dither → 8-bit canvas for display. Export retains 16-bit.

**Crop-to-feature ROI export:** select a window (position, size, resolution) of the
original → `decodeRegionLod` / `decodeTileContainerRegionRgba8` → export. Used for
features needing their own identification.

**Fallback:** WASM-canvas primary; `<img>.jxl` static fallback.

**NOT porting from CasaBio:** annotations, video, taxonomy, messaging.

## 8. ROI / Massive Images

- **LevelSource abstraction:** a level is either whole-frame (one-shot decode) or tiled
  (parallel ROI decode). Threshold-gated at ingest (§4). Client treats both uniformly via
  the LevelSource interface.
- Use cases that justify tiling (not YAGNI): herbarium specimen scans (massive), and
  crop-to-feature identification (window of the original).
- **Caveats:** built JXTC is rgba8 only (16-bit tiling needs a rebuild — deferred). True
  gigapixel **source-tiled ingest** (master too big for RAM) is a later phase; v1 targets
  masters that fit RAM once (~≤150–200 MP).

## 9. Reuse (existing 5/5-optimized pipeline)

`jxl-scheduler` (preempt/dedupe/backpressure), `pool` (prewarm/idle-reap), `jxl-worker`,
`jxl-cache` (OPFS + LRU), `jxl-stream`, `facade`. No new backpressure/dedupe/batch layers
(see CLAUDE.md layer invariants + rejected-optimizations log).

## 10. Optimization Levers

1. Standalone per-level encode → exact per-level quality (beats sidecar floor).
2. Cascade downscale (each level from the previous) → no repeated source re-sampling.
3. Content-addressed level files → cross-image dedupe + immutable caching.
4. `index.json` inlines aspect + L0 → one round-trip seeds the grid.
5. One-shot decode per tile → skip ~15–20 ms streaming overhead.
6. Monotonic level upgrades → never waste a decode downgrading.
7. Viewport + prefetch-ring laziness → decode only what's near-visible.
8. Scheduler preempt/dedupe → offscreen decodes cancelled, dup requests collapsed.
9. Right-sized level by `dimension × DPR` → never over-decode pixels.
10. JXTC ROI for massive levels → cost ∝ visible area, parallel workers.
11. Pan via canvas transform → re-decode only on zoom-level change.
12. Bounded ingest parallelism (mem-aware, 16-bit-aware) → saturate cores without OOM.

## 11. Non-Goals

- No server-side resize or transform endpoint (server is dumb static).
- No within-image DC progressive (level ladder replaces it).
- No >100% pixel-peeping except on tiled scans.
- No animation / motion JXL.
- No CasaBio annotations / video / taxonomy / messaging.
- No gigapixel source-tiled ingest in v1 (masters must fit RAM once).
- No f32 pipeline in v1.

## 12. Build Dependencies

- `web/pkg` may need a rebuild if stale, to export `process_cr2` + `downscale_rgba`.
- Node ingest loads two WASM modules: `web/pkg` (RAW pipeline) + `jxl-wasm` dist
  (encode/decode/downscale/tile).
- 16-bit JXTC needs a WASM rebuild (rgba16 tile-container export missing) — deferred.
- Production host must send COOP/COEP for MT.
- Build chain (per CLAUDE.md): clang/lld/cmake, `wasm32-unknown-unknown`,
  `wasm-bindgen-cli`, Emscripten (`docker.io/emscripten/emsdk`); `node scripts/build.mjs`
  from `packages/jxl-wasm`.

## 13. Edge Cases

- Master long edge < 256 → single full level, no pyramid.
- Master long edge between two grid sizes → skip levels ≥ master; full is the master size.
- Non-sRGB working space → embed ICC; client honors it.
- Corrupt/unsupported master → per-file isolation skips it, logs, batch continues.
- 16-bit level requested on a JPG-sourced image → none exists; client falls back to 8-bit.
- Tiled top level on a non-MT (no COOP/COEP) client → sequential tile decode still works.
- Manifest exists but master changed (mtime) → re-ingest that image.

## 14. Testing

- **Ingest unit:** level set selection (skip-upscale), per-level quality mapping, bit
  depth mapping (JPG→8, RAW→16 big / 8 grid), orientation baking, resumability skip.
- **Downscale:** area-box correctness (integer fast path vs ceiling-division path parity
  on known images), aspect preservation.
- **Encode:** standalone per-level distance honored (NOT floored to 1.5).
- **Manifest/index:** schema, contenthash stability, aspect/L0 inlining.
- **Client:** monotonic upgrade (no downgrade), right-size level pick by DPR, crossfade,
  prefetch-ring cancel on scroll.
- **Lightbox:** zoom ladder crossfade, pan transform (no re-decode), color-matrix parity
  with FilterEngine presets, 16-bit toggle path (decode16 → adjust → FS dither → 8-bit),
  ROI export window.
- **Fixtures (user-supplied):**
  - `c:\Foo\raw-converter\tests\_MG_1750.CR2`
  - `c:\Foo\raw-converter\tests\ADH 1248.CR2`
  - `P1110226 windows.jpg`
  - `c:\Foo\raw-converter\tests\PXL_20260527_180319603.RAW-02.ORIGINAL.dng`
  - `c:\Foo\raw-converter\tests\PXL_20260527_145756882.RAW-02.ORIGINAL.dng`
  - `c:\995\2026-02-20 Gobabeb To Windhoek\P2200566 Adenolobus pechuelii.ORF`
  - `c:\995\2026-02-20 Gobabeb To Windhoek\P2200571.ORF`
  - `c:\995\2026-02-20 Gobabeb To Windhoek\P2200476 Pogonospermum cleomoides.ORF`

## 15. Success Criteria

- Ingest produces correct per-level pyramid + manifest for all 5 formats (ORF/DNG/CR2/JPG)
  with per-level quality and RAW 16-bit big levels.
- Per-level encoded distance matches the spec (2048/full NOT floored to 1.5).
- Gallery seeds from L0 in one round-trip and upgrades to a DPR-right-sized level with a
  monotonic crossfade, decoding only near-viewport.
- Lightbox: zoom ladder + pan + full FilterEngine adjustment parity; 16-bit toggle gives
  visible highlight/shadow recovery on a RAW vs the 8-bit path; ROI crop export works.
- Massive scan (>40 MP) ingests as a tiled top level and ROI-decodes in the client.
- No server-side image logic; all level bytes immutable + content-addressed.
- Pure-WASM ingest (no `sharp`).
