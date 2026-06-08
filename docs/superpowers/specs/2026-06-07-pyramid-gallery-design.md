# Pyramid Gallery Pipeline — Design Spec

**Date:** 2026-06-07
**Branch:** feat/fast-jpeg
**Status:** M0-M4 COMPLETE in browser/WASM (feat/fast-jpeg). M3 live WebGL integration + 16 export; M4 grid massive + panning decodes + tiled client done. See checklists. Core pipeline + ingest + lightbox + grid integrated. (2026-06 handoff closed)

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

## Milestones & Plan Map

Build in dependency order; each milestone is independently shippable and testable. The
lightbox (§7) is deliberately split so the grid ships without waiting on the 16-bit WebGL
path or massive-scan tiling.

| Milestone | Scope | Plan |
|-----------|-------|------|
| **M0** | WASM bridge primitives: per-level-distance sidecar pyramid (no floor) + 16-bit area-box downscale | Plan A — `2026-06-07-pyramid-wasm-primitives.md` |
| **M1** | Node ingest CLI → content-addressed **8-bit** levels + manifest/index + proxy mode; **gallery grid** seed + upgrade | Plan B (ingest) + Plan C (grid) |
| **M2** | Lightbox 8-bit: zoom ladder, pan, FilterEngine preset/slider parity, live histogram | Plan D1 |
| **M3** | 16-bit RAW path: **ingest emits 16-bit `{2048, full}` levels** (`src/lib.rs` exposes RGB16) + client decode16 → WebGL float adjust → Floyd-Steinberg dither; ROI crop export | Plan D2 |
| **M4** | Massive scans (>40 MP): JXTC tiled top level + parallel ROI decode | Plan E (built last; §8/§15) |

Sections §6 → M1, §7 viewing/adjustments → M2, §7 16-bit toggle + ROI → M3, §8 → M4.

## 3. Constraints & Grounded Facts

- **RAW decode ≈ 2.5 s/image** (`process_dng`); JXL decode of prebuilt full ≈ 302 ms;
  prebuilt L0 256px ≈ 19 ms. Warm JXL decode is ~linear in requested pixels
  (~19 / 56 / 217 / 302 ms for 256 / 1024 / 2048 / full).
- **Sidecar encoder floors small-level quality only.** `encode_rgba8_with_sidecars`
  clamps each sidecar to distance ≥ 1.5 (≈ q87) at `bridge.cpp:2658`; the full image
  (`2668`) is un-floored. The floor bites only levels we want above ~q87 — i.e. the 2048
  sidecar at q95. Small levels {256,512,1024}=q85 ≈ distance 1.5 sit AT the floor,
  unharmed. → Parameterize the floor to **per-level distances**; then ONE sidecar call
  (cascade downscale + per-level encode, already in C++ at `2630-2681`) builds the ladder.
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

**Inputs:** ORF, DNG, CR2 (`process_orf` / `process_dng` / `process_cr2`), and JPG.
- RAW → decode to full-resolution RGBA8 (`ProcessResult.take_rgba()`). (16-bit big levels deferred to M3 — see Bit depth.)
- JPG → lossless `transcodeJpegToJxl` (`bridge.cpp:3082`) IS the full level: no re-encode
  loss, native JXL, smaller. Decode that JXL once → RGBA for the smaller levels. No direct
  JPEG decoder needed (none exists — `1140` routes JPEG to transcode), no wasted step.

**Pyramid levels:** sizes `[256, 512, 1024, 2048]` + full. Each size = long-edge target.
(The `timings/fastest` bench used `[256, 1024, 2048]`; that script is a non-normative
exploration artifact — this spec is the authority and adds 512 for a finer upgrade step.)
Skip any level whose long edge ≥ the master's long edge (no upscaling).

**Downscale (internal to the encode call):** area-average box filter `BoxDownscaleRgba8`
(`bridge.cpp:2647`), cascaded smallest-from-previous inside `encode_rgba8_with_sidecars`
(full → 2048 → 1024 → 512 → 256). Integer fast path on exact 2× steps; ceiling-division
full-coverage path otherwise. Downscale work ∝ output pixels, not N×full. No JS-side
cascade. (M3's 16-bit big levels will downscale separately — see Build Deps.)

**Per-level quality** (distance set per level, NOT uniform):
- `{256, 512, 1024}` → q85 ≈ distance **1.45**
- `{2048, full}` → q95 ≈ distance **0.55** (user prefers 90–95 on big images)

Quality→distance uses libjxl's mapping `distance = 0.1 + (100 − q)·0.09` (for q ≥ 30). The
v2 sidecar call removes the old 1.5 floor that would otherwise clamp the 2048 level's 0.55
back up to ~q85. JPG full level = lossless transcode (distance 0). Proxy levels = q85 (1.45).
- effort = 3 (user's prior measurements: effort 3 best on speed + filesize)

**Encode (one call):** `encode_rgba8_with_sidecars` with **per-level distances** (floor
parameterized) → cascade downscale + per-level encode in C++, one JS↔WASM crossing
(replaces JS cascade + N standalone encodes). Per-level quality below. JPG keeps its
lossless-transcode full and uses the sidecar call only for smaller levels. **M1 encodes
every level 8-bit (RAW and JPG alike).** 16-bit RAW big levels `{2048, full}` via
`_jxl_wasm_encode_rgba16` are deferred to M3: the Rust pipeline computes a full-res RGB16
buffer internally but does not yet expose it (`src/lib.rs`), so surfacing it is an M3/Plan
D2 change. Plan A still ships the rgba16 primitives; M1 simply does not call them.

**Bit depth:**
- **M1: every level is 8-bit** for both JPG and RAW. RAW decodes to full-resolution RGBA8
  (`take_rgba()`); the whole ladder is 8-bit. Manifest records `bitsPerSample: 8` per level.
- **M3: RAW big levels `{2048, full}` become 16-bit** (the grid `{256, 512, 1024}` stays
  8-bit) once `src/lib.rs` exposes its internal RGB16 buffer. `bitsPerSample` already varies
  per level, so this needs no schema change.
- JPG inputs → always 8-bit (source is 8-bit; no recovery headroom exists).
- f32 deferred (not in v1).

**Orientation:** per image, `"baked" | "source"`. RAW = `"baked"` (the Rust pipeline applies
orientation to pixels). JPG = `"source"` (the lossless transcode preserves the JPEG's EXIF
orientation tag rather than baking it — re-encoding to bake would forfeit the lossless win).
Every level within an image shares one orientation, so the WASM-decoder path (all levels
decode through the same decoder) renders consistently; only the native `<img>.jxl` fallback
must honor a `"source"` tag.

**Color:** output sRGB, 8-bit tag; embed ICC only if the working space is wider than sRGB.

**Threshold-gated JXTC tiling:** if master long edge > ~8000 px (> ~40 MP), encode the
**top level** as a JXTC tile container (independent per-tile bitstreams + byte-offset
index) so the client can ROI-decode it in parallel. Smaller masters: whole-frame levels
only. (v1 JXTC is rgba8 only — see Build Deps.)

**Parallelism:** bounded `min(cores, memBudget / perImageRGBABytes)` (M3's 16-bit big levels
will halve the per-image budget — 2× bytes). Per-file isolation — one bad file never aborts
the batch. For safe cross-core throughput against a single WASM module, run multiple
processes via `--shard i/N` (separate modules); manifests are written atomically (temp→rename)
and sharded runs skip `index.json`, then the caller runs one `--reindex-only` pass after every
shard finishes (concurrent index writers would otherwise race).

**Resumability:** skip an image if its manifest exists and the master mtime is unchanged.

**Proxy mode (`--proxy <256|512|1024>`, default 512):** verification-only. Emit a SINGLE
small level (q85, 8-bit) + minimal manifest (`proxy: true`); skip the full pyramid and the
push. For cheap presence / locality checks at scale. 256 = recognize subject; 512 = +
coarse detail (habitat, large labels); 1024 = read fine text.

## 5. Storage & Transport (Option A)

- One `{contenthash}.jxl` file **per level** (content-addressed → dedupe + immutable).
- **Content hash:** SHA-256 of the level's JXL bytes, lowercase hex, **first 16 chars**
  (64 bits — collision-free at gallery scale). Filename `{hash16}.jxl`.
- **Path layout:** `levels/{hash16}.jxl` (flat, shared across all images → cross-image
  dedupe); `images/{imageId}/manifest.json`; `index.json` at the gallery root. `imageId` =
  SHA-256/16 of the master's absolute path (stable across re-ingest of the same file).
- `Cache-Control: public, max-age=31536000, immutable` (content-hashed names).
- HTTP/2 (many small level files multiplex cheaply).

**`manifest.json` (per image) — schema v1:**

```json
{
  "schema": 1,
  "imageId": "9f86d081884c7d65",
  "master": { "name": "P2200566.ORF", "format": "orf", "mtimeMs": 1717689600000 },
  "orientation": "baked",
  "width": 4624, "height": 3468, "aspect": 1.3333,
  "levels": [
    { "size": 256,    "w": 256,  "h": 192,  "bytes": 8192,    "bitsPerSample": 8, "contenthash": "ab12...", "tiled": false },
    { "size": 2048,   "w": 2048, "h": 1536, "bytes": 524288,  "bitsPerSample": 8, "contenthash": "cd34...", "tiled": false },
    { "size": "full", "w": 4624, "h": 3468, "bytes": 2097152, "bitsPerSample": 8, "contenthash": "ef56...", "tiled": false }
  ]
}
```

- `size` is the long-edge target (number) or the string `"full"`. `levels` is ascending by
  pixel count. **M1: every level is `bitsPerSample: 8`** (JPG and RAW alike); M3 raises RAW
  `{2048, full}` to `16` while the grid stays `8` (per-level field → no schema bump).
  `format` ∈ `orf|dng|cr2|jpg`. `orientation` ∈ `baked|source` (RAW bakes; JPG keeps the
  source EXIF tag via lossless transcode).
- **Proxy manifest:** same schema with `"proxy": true`, exactly one level, no `index.json`
  entry, no push.

**`index.json` (per gallery) — schema v1:** seeds the whole grid in one round-trip.

```json
{
  "schema": 1,
  "images": [
    { "imageId": "9f86d081884c7d65", "aspect": 1.3333, "l0": { "contenthash": "ab12...", "w": 256, "h": 192 } }
  ]
}
```

- `l0` inlines the smallest level's hash + dims so the client lays out the grid (aspect →
  no layout shift) and fetches seeds without N manifest round-trips. Full per-image detail
  loads from `manifest.json` on demand (upgrade / lightbox).
- **Bloat:** ~80 bytes/entry → a 10k-image index ≈ 0.8 MB (serve gzipped). Shard into
  `index/{shard}.json` only past ~50k images (deferred; YAGNI for v1).

## 6. Client — Gallery Grid

- Fetch `index.json` → lay out grid by per-image aspect (no layout shift; aspect known
  before any image bytes).
- **Seed:** one-shot decode L0 (256px) → paint immediately.
- **Upgrade:** pick the level matching `tileSize × devicePixelRatio`; decode → crossfade.
- **Monotonic:** never downgrade a tile that already painted a higher level (no fl/flash
  on scroll-back).
- **Lazy:** decode only viewport + a prefetch ring; cancel offscreen via scheduler.
- Reuse scheduler + in-mem LRU + OPFS cache. The one-shot decode is dispatched THROUGH the
  scheduler, which still provides dedupe (keyed by level `contenthash`), priority, and
  cancel-before-start for offscreen tiles. It does NOT add mid-decode preemption: a single
  `_jxl_wasm_decode_rgba8` call is synchronous and cannot yield mid-call (consistent with the
  CLAUDE.md preemption invariant — cancel is between queued decodes, not within one). This is
  a decode *entry point*, not a new decode stack — no fork of the streaming session pipeline.
- One-shot `_jxl_wasm_decode_rgba8` per tile (avoids ~15–20 ms streaming-decoder overhead).
  Content-addressed level URLs make `contenthash` a natural, collision-free dedupe key —
  cleaner than a source-path key (no `sourceKey` plumbing needed).

## 7. Client — Lightbox (modeled on CasaBio app)

Model: `C:\Users\User\AndroidStudioProjects\CplusplusTest\` (Kotlin + native libjxl —
already JXL-based). Port the **interaction + adjustment model**, not the Android extras.

**Portability:** that CasaBio path is a local reference only. Plan D MUST transcribe the
FilterEngine color matrices + slider→matrix mapping INTO this repo (e.g.
`web/lightbox/filter-engine.ts`) with unit tests. No agent/CI step may depend on the
external Android directory — treat it as read-once documentation, not a build input.

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

1. One-call sidecar pyramid w/ per-level distances → cascade downscale + per-level encode
   in C++, **one JS↔WASM crossing per pyramid encode** (was a JS cascade + N encodes). In M1
   every master (RAW and JPG) takes this single 8-bit path. In M3, RAW masters add separate
   16-bit calls for `{2048, full}` (see §4) — the single-crossing win still applies to the
   8-bit ladder/grid.
2. Cascade downscale internal (each level from previous) → downscale work ∝ output
   pixels, not N×full.
3. Content-addressed level files → cross-image dedupe + immutable caching.
4. `index.json` inlines aspect + L0 → one round-trip seeds the grid.
5. One-shot decode per tile → skip ~15–20 ms streaming overhead.
6. Monotonic level upgrades → never waste a decode downgrading.
7. Viewport + prefetch-ring laziness → decode only what's near-visible.
8. Scheduler preempt/dedupe → offscreen decodes cancelled, dup requests collapsed.
9. Right-sized level by `dimension × DPR` → never over-decode pixels.
10. JXTC ROI for massive levels → cost ∝ visible area, parallel workers.
11. Pan via canvas transform → re-decode only on zoom-level change.
12. Bounded ingest parallelism (mem-aware; 16-bit-aware in M3) → saturate cores without OOM.

## 11. Non-Goals

- No server-side resize or transform endpoint (server is dumb static).
- No within-image DC progressive (level ladder replaces it).
- No >100% pixel-peeping except on tiled scans.
- No animation / motion JXL.
- No CasaBio annotations / video / taxonomy / messaging.
- No gigapixel source-tiled ingest in v1 (masters must fit RAM once).
- No f32 pipeline in v1.

## 12. Build Dependencies

- `web/pkg` (Rust RAW pipeline) is current — M1 calls only the already-exported
  `process_orf_with_flags` / `process_dng_with_flags` / `process_cr2_with_flags` +
  `ProcessResult.take_rgba()` (full RGBA8). No `src/lib.rs` rebuild for M1; the RGB16
  exposure is an M3 change.
- Bridge edit (rides the rebuild): parameterize the sidecar distance floor
  (`bridge.cpp:2658`) to accept per-level distances.
- **M3 16-bit ingest deps (not M1):** RAW big levels need (a) `src/lib.rs` to expose its
  internal full-res RGB16 buffer (today it computes then drops it), and (b) a 16-bit box
  downscale (`BoxDownscaleRgba16` + `_jxl_wasm_downscale_rgba16`) — only `BoxDownscaleRgba8`
  exists today. Plan A already ships the rgba16 encode + downscale primitives; M1 does not
  call them.
- Node ingest loads two WASM modules: `web/pkg` (RAW pipeline) + `jxl-wasm` dist
  (encode/decode/sidecar/tile).
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

- **Ingest unit:** level set selection (skip-upscale), per-level quality mapping, **M1 bit
  depth (all 8-bit)**, orientation (RAW baked / JPG source), resumability skip, content-hash
  dedupe, proxy single-level. (M3 adds RAW 16-bit big-level tests.)
- **Downscale:** area-box correctness (integer fast path vs ceiling-division path parity
  on known images), aspect preservation.
- **Encode:** per-level-distance sidecar call honors each distance — 2048 at q95, NOT
  clamped to 1.5. JPG full = lossless transcode (bit-exact vs decode of source). Proxy
  mode emits one level + `proxy` manifest, no pyramid/push.
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

- **M1:** Ingest produces a correct 8-bit per-level pyramid + manifest for all master
  formats (ORF/DNG/CR2/JPG) with per-level quality. (M3 adds RAW 16-bit big levels.)
- Per-level encoded distance matches the spec — 2048 at q95 via the per-level-distance
  sidecar call, NOT clamped to 1.5; JPG full is a lossless transcode.
- Proxy mode produces a single verification level at the chosen size (default 512).
- Gallery seeds from L0 in one round-trip and upgrades to a DPR-right-sized level with a
  monotonic crossfade, decoding only near-viewport.
- Lightbox: zoom ladder + pan + full FilterEngine adjustment parity; 16-bit toggle gives
  visible highlight/shadow recovery on a RAW vs the 8-bit path; ROI crop export works.
- Massive scan (>40 MP) ingests as a tiled top level and ROI-decodes in the client.
- No server-side image logic; all level bytes immutable + content-addressed.
- Pure-WASM ingest (no `sharp`).
