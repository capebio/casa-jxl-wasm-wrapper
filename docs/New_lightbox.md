# New Lightbox

## Goal

Build new shared lightbox for:

- this repo
- Casabio platform
- lab/test pages

UI stays in JS/TS. Heavy image work moves behind worker-backed wrapper APIs and WASM where useful.

Primary goals:

- instant open from preview
- smooth zoom/pan
- predictive predecode before visible threshold hit
- adjacent preload
- expandable Exif
- crop + subject/extents
- virtual derivative refs instead of forced raster exports
- use JXL selective decode capabilities where possible

## Old Lightbox Features To Carry Forward

Keep:

- overlay open/close
- prev/next navigation
- zoom in/out/reset
- fit-to-screen and 100% toggle
- wheel zoom
- drag pan
- pinch zoom
- keyboard shortcuts
- source badge / loading badge
- source switching where host supports it
- Exif/info panel with collapse state
- adjacent preload
- crop tool
- subject boxes / focal extents
- crop aspect presets
- crop save/cancel/apply flow
- optional analysis/filter/profile panels

Do not carry forward old structure:

- monolithic `web/main.js`
- gallery-card state coupled to lightbox state
- page-specific globals on `window`
- Tauri/browser assumptions inside UI core

## Package Shape

Recommended reusable package split:

- `packages/lightbox-core`
  - headless state machine
  - navigation state
  - zoom/pan math
  - source ladder policy
  - preload policy
  - crop/virtual-derivative model
  - Exif model
- `packages/lightbox-browser`
  - DOM overlay
  - pointer/keyboard/touch handling
  - canvas/ImageBitmap presentation
  - expandable Exif panel
  - toolbar and shell UI
- `packages/lightbox-worker`
  - worker-side image pipeline
  - decode/preload scheduling
  - cache tiers
  - wrapper integration
- optional `packages/lightbox-wasm`
  - only if shared math/pixel helpers justify extraction

## Core Model

Each item should be represented as logical asset plus source ladder:

1. thumbnail / first preview
2. large preview / medium render
3. viewport-fit render
4. full source
5. region/tile decode for deep zoom

Each item may also expose:

- Exif
- sidecar state
- saved crop refs
- saved subject refs
- derived virtual children referencing parent source + extent

## Performance Model

### Open

- open immediately from fastest available preview
- never block modal on full decode if preview exists
- schedule next better source in background

### Zoom

- current bitmap keeps scaling immediately
- crossing quality thresholds requests better source
- source swaps preserve zoom intent and pan center

### Predictive Predecode

Do not wait for hard threshold crossing only.

Track:

- zoom velocity
- zoom direction
- recent wheel/pinch deltas
- viewport center stability

If crossing time to next threshold is likely soon, start decode early.

Suggested policy:

- low confidence: warm metadata / queue next source low priority
- medium confidence: start medium render
- high confidence: start full or region/tile decode

### Pan

At deep zoom, pan should not require whole-image decode.

Prefer:

- viewport region decode
- overscan beyond visible bounds
- directional prefetch based on pan velocity

### Preload

Always preload adjacent items on separate lanes:

- metadata lane
- preview lane
- medium/full lane when idle

Priority:

- current item highest
- immediate neighbors medium
- second neighbors low

### Cache

Byte-budgeted LRU tiers:

- metadata
- preview bitmap
- medium render
- full render
- tile cache later

## Crop / Virtual Derivatives

Need two related features:

1. crop overlay on viewed image
2. “crop to separate file” as virtual derivative, not forced pixel export

Virtual derivative object should store:

- parent asset id
- normalized extent `{x,y,w,h}`
- optional display name
- optional sidecar metadata
- optional subject semantics

Host can later choose:

- render virtual child in grids
- export cropped raster
- persist as sidecar only

## Exif

Exif should be first-class, expandable, grouped, and host-extensible.

Base groups:

- capture
- lens
- exposure
- white balance / colour
- dimensions / orientation
- file/source

## Wrapper Capability Check: Current State

Current wrapper already supports part of needed deep-zoom path:

- region decode API
- decode-time downsample API

Evidence in current code:

- `DecodeOptions.region` and `DecodeOptions.downsample` exist in `packages/jxl-core/dist/types.d.ts`
- worker protocol carries `region` and `downsample` in `packages/jxl-core/dist/protocol.d.ts`
- browser worker passes both into decoder in `packages/jxl-worker-browser/src/decode-handler.ts`
- one-shot decode can call `_jxl_wasm_decode_*_region` in `packages/jxl-wasm/src/facade.ts`

Current limits:

- no arbitrary exact output size decode like exact `640x480`
- downsample limited to `1 | 2 | 4 | 8`
- progressive path still applies crop/downsample after decode output rather than true region-progressive viewport decode
- region fallback metric appears in types/spec but is not currently emitted by worker

So current wrapper is:

- good enough for coarse region + LOD work
- not yet good enough for exact-size viewport-driven decode contract

## Wrapper Handoff: Required New Functionality

This section is handoff for wrapper work to build now.

### Priority 1: exact-size decode

Need wrapper decode API to request output dimensions, not only power-of-two downsample.

Target capability:

- decode whole image or region directly to exact requested output size
- examples:
  - fit image to `640x480`
  - decode visible region to `1024x768`
  - decode crop preview to exact panel size

Suggested API shape:

```ts
type Region = { x: number; y: number; w: number; h: number };

type DecodeViewportOptions = {
  format: "rgba8" | "rgba16" | "rgbaf32";
  region?: Region | null;
  targetWidth?: number;
  targetHeight?: number;
  fitMode?: "contain" | "cover" | "stretch";
  preserveIcc?: boolean;
  preserveMetadata?: boolean;
  progressionTarget?: "header" | "dc" | "pass" | "final";
  emitEveryPass?: boolean;
};
```

Minimum acceptable behavior:

- exact target long edge or exact target width/height
- if codec/native bridge cannot do exact scaling internally, wrapper may decode nearest efficient LOD then resize in WASM before returning
- caller should not need JS resize fallback

### Priority 2: viewport region decode

Need explicit API contract for viewport-driven region decode.

Target:

- decode arbitrary source region
- decode region to exact output size
- return actual source extent represented

Suggested event/result fields:

```ts
type ViewportResult = {
  pixels: ArrayBuffer;
  width: number;
  height: number;
  sourceRegion: Region;
  sourceScale: number;
};
```

### Priority 3: selective pan/zoom support

Need support for deep zoom where only visible area plus overscan is decoded.

Target:

- repeated region requests cheap
- no forced full-frame decode on every pan
- suitable for worker tile/viewport scheduler

If tile-aligned internally, expose enough metadata so caller can schedule well:

```ts
type DecodeGridInfo = {
  tileWidth?: number;
  tileHeight?: number;
  preferredRegionAlign?: number;
  lodLevels?: number[];
};
```

### Priority 4: progressive region behavior

Need clarity whether progressive decode can emit:

- header for full image
- progressive updates for requested region only
- progressive exact-size viewport render

If not immediately feasible, expose honest fallback behavior in API:

- `progressiveRegion: false`
- `regionFallback: "full-frame-then-crop"`

Do not hide fallback.

### Priority 5: metrics

Need metrics so new lightbox scheduler can make smart choices.

Must emit:

- `time_to_header_ms`
- `time_to_first_pixel_ms`
- `time_to_final_ms`
- `output_bytes`
- `peak_memory_bytes`
- `region_fallback_full_frame`
- `format_downcast`
- ideally:
  - `decode_scale_used`
  - `decode_region_area`
  - `source_pixels_decoded`

### Priority 6: capability reporting

Need runtime capabilities for scheduler decisions.

Suggested additions:

```ts
type WrapperCapabilities = {
  regionDecode: boolean;
  exactSizeDecode: boolean;
  progressiveRegionDecode: boolean;
  tileAlignedRegionDecode: boolean;
  arbitraryRegionDecode: boolean;
  availableDownsampleFactors: number[];
};
```

### Priority 7: stable worker-facing API

New lightbox worker should not know low-level bridge names.

Need stable high-level facade, for example:

```ts
decodeViewport(bytes, {
  region,
  targetWidth,
  targetHeight,
  priority,
  progressive,
});
```

and optionally:

```ts
decodeRegionLod(bytes, {
  region,
  targetLongEdge,
});
```

### Priority 8: crop/export reference support

Wrapper does not need to own virtual derivative persistence.

But helpful additions:

- exact region render for crop preview
- exact region render for export pipeline
- deterministic extent mapping between source pixels and normalized extents

## Recommended Implementation Order For Wrapper Team

1. add exact-size decode API on top of current region/downsample paths
2. expose explicit capability flags
3. emit region fallback metrics
4. add optimized viewport-region decode path
5. improve progressive region behavior
6. later: tile/LOD metadata if native JXL bridge can expose it

## Recommended Implementation Order For Lightbox Team

1. build new reusable lightbox core/browser packages
2. integrate preview open + Exif + adjacent preload
3. integrate current wrapper region/downsample path
4. add predictive predecode
5. switch deep zoom to new exact-size viewport decode once wrapper lands
6. add optional analysis panels as plugins

## Immediate Conclusion

New lightbox should be built assuming:

- JS/TS owns UI
- worker owns scheduling
- wrapper/WASM owns heavy image work

Current wrapper is already close enough to justify viewport-oriented design, but not yet complete for ideal exact-size deep zoom. The wrapper handoff above closes that gap.
