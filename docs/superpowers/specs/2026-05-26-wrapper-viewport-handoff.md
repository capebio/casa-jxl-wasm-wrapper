# Wrapper Viewport API — Agent Handoff

**Branch:** `Facade-Round1`  
**Spec source:** `docs/New_lightbox.md` — section "Wrapper Capability Check: Current State" onward  
**Scope:** Pure TS/JS — no WASM rebuild required. All changes stay in the wrapper layer.

---

## What Already Exists (do not re-implement)

| Capability | Where |
|---|---|
| `DecodeOptions.region` + `.downsample` (1/2/4/8) | `jxl-core/src/types.ts` |
| Protocol carries `region` + `downsample` | `jxl-core/src/protocol.ts` → `MsgDecodeStart` |
| Worker passes both to decoder | `jxl-worker-browser/src/decode-handler.ts` → `run()` |
| C++ region crop in one-shot path | `jxl-wasm/src/facade.ts` → `callDecodeFromPtr` |
| Metrics: `time_to_header_ms`, `time_to_first_pixel_ms`, `time_to_final_ms`, `output_bytes`, `peak_memory_bytes`, `format_downcast`, `region_fallback_full_frame` (typed but not all emitted) | `jxl-core/src/types.ts` → `CodecMetric` |
| `Capabilities` (runtime WASM feature flags) | `jxl-core/src/types.ts` |

---

## Work Required — 8 Priorities

### P1 · Exact-size decode (most important)

**Goal:** caller requests output dimensions; wrapper picks best downsample and resizes in JS.

**New fields on `DecodeOptions` (jxl-core/src/types.ts):**
```ts
targetWidth?: number;
targetHeight?: number;
fitMode?: "contain" | "cover" | "stretch";
```

**New fields on `MsgDecodeStart` (jxl-core/src/protocol.ts):**
```ts
targetWidth: number | null;
targetHeight: number | null;
fitMode: "contain" | "cover" | "stretch" | null;
```

**Logic in `jxl-wasm/src/facade.ts`:**
- After decode, if `targetWidth`/`targetHeight` set: apply bilinear resize before yielding pixels.
- Pick `downsample` automatically: smallest power-of-two where `floor(nativeDim / ds) >= targetDim`. Expose chosen scale as metric `decode_scale_used`.
- Resize must handle rgba8 / rgba16 / rgbaf32 (stride-aware).
- Caller never needs a JS-side resize fallback.

**Thread-through in `jxl-session/src/decode-session.ts`:**
- Map `opts.targetWidth/targetHeight/fitMode` → `startMsg` fields.

**Thread-through in `jxl-worker-browser/src/decode-handler.ts`:**
- Pass `targetWidth/targetHeight/fitMode` from `opts` → `createDecoder(...)` options (or apply post-decode in handler — your call, but facade is the right layer per CLAUDE.md).

---

### P2 · ViewportResult type

Add to `jxl-core/src/types.ts`:
```ts
export interface ViewportResult {
  pixels: ArrayBuffer;
  width: number;
  height: number;
  sourceRegion: Region;
  sourceScale: number;
}
```

`DecodeFrameEvent` already has `region?: Region`. Add optional `sourceScale?: number` field so callers can read it from frame events without needing the new high-level API.

---

### P3 · DecodeGridInfo type

Add to `jxl-core/src/types.ts`:
```ts
export interface DecodeGridInfo {
  tileWidth?: number;
  tileHeight?: number;
  preferredRegionAlign?: number;
  lodLevels?: number[];
}
```

Export `getDecodeGridInfo(): DecodeGridInfo` from `jxl-wasm/src/facade.ts`. Current libjxl WASM bridge has no tile metadata, so return empty object `{}`. Honest placeholder — lightbox scheduler will check for defined fields before using.

---

### P4 · Progressive region behavior — honest flags

Add to `DecodeFrameEvent` (jxl-core/src/types.ts):
```ts
progressiveRegion?: boolean;
regionFallback?: "full-frame-then-crop";
```

In `jxl-wasm/src/facade.ts` progressive path (`eventsProgressive`):
- Region + progressive together today = full-frame decode, then `applyRegionAndDownsample` crops. Set `progressiveRegion: false` and `regionFallback: "full-frame-then-crop"` on emitted events when `region != null`.
- One-shot path with C++ region crop: set `progressiveRegion: false`, no `regionFallback` (crop is native).

Do not hide the fallback. Do not claim native progressive region when it isn't.

---

### P5 · Metrics — fill gaps

**New `CodecMetric` discriminants** (jxl-core/src/types.ts — add to the union):
```ts
| { name: "decode_scale_used"; value: number }       // actual downsample factor applied
| { name: "decode_region_area"; value: number }      // source pixels in requested region (w*h)
| { name: "source_pixels_decoded"; value: number }   // total source pixels decoded (full frame or region)
```

**Emission sites:**

| Metric | Where to emit |
|---|---|
| `region_fallback_full_frame` | `jxl-wasm/src/facade.ts` — when progressive path falls back. Currently typed but **never emitted**. Fix this. |
| `decode_scale_used` | `jxl-wasm/src/facade.ts` — after downsample selection (P1 logic) |
| `decode_region_area` | `jxl-wasm/src/facade.ts` — when region != null, emit `region.w * region.h` |
| `source_pixels_decoded` | `jxl-wasm/src/facade.ts` — full image `w*h` (or region area if C++ crop used) |
| `output_bytes` | `jxl-worker-browser/src/decode-handler.ts` — already typed, **not emitted**. Emit on final/budget_exceeded using `pixels.byteLength`. |
| `peak_memory_bytes` | Not feasible without WASM bridge support. Leave unimplemented; do not fake it. |

Metrics reach the caller via the existing `MsgMetric` protocol message and `opts.onMetric` callback — no protocol changes needed.

---

### P6 · WrapperCapabilities

Add to `jxl-core/src/types.ts`:
```ts
export interface WrapperCapabilities {
  regionDecode: boolean;
  exactSizeDecode: boolean;
  progressiveRegionDecode: boolean;
  tileAlignedRegionDecode: boolean;
  arbitraryRegionDecode: boolean;
  availableDownsampleFactors: number[];
}
```

Export from `jxl-wasm/src/facade.ts`:
```ts
export function getWrapperCapabilities(): WrapperCapabilities {
  return {
    regionDecode: true,                  // C++ region bridge present
    exactSizeDecode: true,               // P1 implemented in this batch
    progressiveRegionDecode: false,      // honest: not yet
    tileAlignedRegionDecode: false,      // honest: no tile metadata from libjxl yet
    arbitraryRegionDecode: true,         // JS-level crop works for any rect
    availableDownsampleFactors: [1, 2, 4, 8],
  };
}
```

This is a static return — no WASM load needed. Lightbox scheduler calls it at init.

---

### P7 · Stable high-level viewport API

Add to `jxl-wasm/src/facade.ts` — thin wrappers over `createDecoder`:

```ts
export interface DecodeViewportOptions {
  format: PixelFormat;
  region?: Region | null;
  targetWidth?: number;
  targetHeight?: number;
  fitMode?: "contain" | "cover" | "stretch";
  preserveIcc?: boolean;
  preserveMetadata?: boolean;
  progressionTarget?: "header" | "dc" | "pass" | "final";
  emitEveryPass?: boolean;
}

export function decodeViewport(options: DecodeViewportOptions): JxlDecoder {
  return createDecoder({
    format: options.format,
    region: options.region ?? null,
    downsample: pickDownsample(options),   // internal helper
    progressionTarget: options.progressionTarget ?? "final",
    emitEveryPass: options.emitEveryPass ?? false,
    preserveIcc: options.preserveIcc ?? true,
    preserveMetadata: options.preserveMetadata ?? false,
    targetWidth: options.targetWidth,
    targetHeight: options.targetHeight,
    fitMode: options.fitMode,
  });
}

export interface DecodeRegionLodOptions {
  format: PixelFormat;
  region?: Region | null;
  targetLongEdge: number;
}

export function decodeRegionLod(options: DecodeRegionLodOptions): JxlDecoder {
  return createDecoder({
    format: options.format,
    region: options.region ?? null,
    downsample: 1,   // P1 logic will resolve actual scale from targetLongEdge
    progressionTarget: "final",
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
    targetWidth: options.targetLongEdge,   // treated as long-edge constraint in resize logic
    fitMode: "contain",
  });
}
```

`pickDownsample` is an internal helper that computes best power-of-two given target dimensions and (when known) source dimensions. When source dims unknown at call time, pass 1 and let the resize post-decode handle it.

---

### P8 · Crop/export helpers

Add to `jxl-wasm/src/facade.ts`:

```ts
// Convert normalized [0,1] extent to source pixel rect.
export function normalizedToPixelExtent(
  norm: { x: number; y: number; w: number; h: number },
  imageWidth: number,
  imageHeight: number,
): Region {
  return {
    x: Math.round(norm.x * imageWidth),
    y: Math.round(norm.y * imageHeight),
    w: Math.max(1, Math.round(norm.w * imageWidth)),
    h: Math.max(1, Math.round(norm.h * imageHeight)),
  };
}

// Inverse: pixel rect → normalized extent.
export function pixelToNormalizedExtent(
  region: Region,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: region.x / imageWidth,
    y: region.y / imageHeight,
    w: region.w / imageWidth,
    h: region.h / imageHeight,
  };
}
```

These are pure math — no WASM, no async. Lightbox virtual derivative model uses normalized extents; these bridge to the pixel-space region API.

---

## Bilinear Resize Spec (for P1)

Must be implemented in `jxl-wasm/src/facade.ts` (pure JS, no WASM bridge needed).

```
function bilinearResize(
  src: Uint8Array, srcW: number, srcH: number,
  dstW: number, dstH: number,
  stride: number   // bytes per pixel: 4=rgba8, 8=rgba16, 16=rgbaf32
): Uint8Array
```

- Standard bilinear: for each dst pixel, compute fractional src coord, sample 4 neighbors, lerp.
- rgba16: treat each pair of bytes as a uint16 (little-endian), lerp as integers, write back.
- rgbaf32: treat each group of 4 bytes as float32, lerp as floats.
- Applied **after** decode in `eventsOneShot` and **after** each flushed frame in `eventsProgressive` when `targetWidth`/`targetHeight` are set.
- When `fitMode === "contain"`: compute scale = min(dstW/srcW, dstH/srcH), resize to that, do **not** pad — return actual output dims (may be smaller than requested).
- When `fitMode === "cover"`: scale = max(dstW/srcW, dstH/srcH), center-crop to exact dstW×dstH.
- When `fitMode === "stretch"`: resize to exact dstW×dstH unconditionally.
- Default (`fitMode` absent): treat as `"contain"`.

---

## Files to Touch

| File | Changes |
|---|---|
| `packages/jxl-core/src/types.ts` | Add `targetWidth/targetHeight/fitMode` to `DecodeOptions`; add `WrapperCapabilities`, `ViewportResult`, `DecodeGridInfo`; extend `CodecMetric` union; add `sourceScale`/`progressiveRegion`/`regionFallback` to `DecodeFrameEvent` |
| `packages/jxl-core/src/protocol.ts` | Add `targetWidth/targetHeight/fitMode` to `MsgDecodeStart` |
| `packages/jxl-core/dist/*` | Rebuild from src (or hand-edit to match src) |
| `packages/jxl-wasm/src/facade.ts` | Bilinear resize; P1 downsample picker; emit missing metrics; `decodeViewport`, `decodeRegionLod`, `getWrapperCapabilities`, `getDecodeGridInfo`, `normalizedToPixelExtent`, `pixelToNormalizedExtent` |
| `packages/jxl-session/src/decode-session.ts` | Thread `targetWidth/targetHeight/fitMode` into `startMsg` |
| `packages/jxl-worker-browser/src/decode-handler.ts` | Pass new fields to `createDecoder`; emit `output_bytes` metric on final/budget_exceeded |

**Do not touch:** `jxl-scheduler`, `jxl-cache`, `jxl-stream`, `bridge.cpp`, `lib.rs`.

---

## Layer Invariants (from CLAUDE.md — do not violate)

- Resize logic belongs in **facade** (`jxl-wasm/src/facade.ts`), not in decode-handler or session.
- Backpressure and drain stay at scheduler/worker boundary — do not add drain logic.
- Dedup and caching stay in their layers — do not add cache awareness here.
- No per-stage budget resets.
- `region_fallback_full_frame` metric value must be `1` (existing type constraint).

---

## Success Criteria

- [ ] `decodeViewport({ format: "rgba8", targetWidth: 640, targetHeight: 480 })` returns pixels of exactly 640×480 (or smaller if contain-fit) without caller doing any resize.
- [ ] `getWrapperCapabilities()` returns synchronously, no WASM load.
- [ ] `region_fallback_full_frame` metric fires when progressive path uses JS crop fallback.
- [ ] `decode_scale_used`, `decode_region_area`, `source_pixels_decoded` metrics fire on every decode with a region or target size.
- [ ] `output_bytes` metric fires on every final decode event.
- [ ] `progressiveRegion: false` and `regionFallback: "full-frame-then-crop"` present on progress events when region + progressive decode active.
- [ ] `normalizedToPixelExtent` / `pixelToNormalizedExtent` round-trip correctly.
- [ ] All existing tests pass.
- [ ] dist files in `jxl-core` updated to match src.
