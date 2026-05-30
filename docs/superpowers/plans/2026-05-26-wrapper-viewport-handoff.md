# Wrapper Viewport API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement P1–P8 of the viewport handoff spec — exact-size decode, type additions, progressive region flags, metric emission, static capability functions, viewport API helpers, and coordinate converters — with no WASM rebuild required.

**Architecture:** Pure TS/JS changes confined to jxl-core (types/protocol), jxl-wasm/facade, jxl-session, and jxl-worker-browser. Bilinear resize runs in JS post-decode in facade.ts. Metrics flow from facade through decode-handler's existing postMetric path. Dist files in jxl-core and jxl-wasm are hand-updated to match src.

**Tech Stack:** TypeScript, Bun (test runner), existing WASM bridge (no rebuild)

---

## File Map

| File | Changes |
|------|---------|
| `packages/jxl-core/src/types.ts` | Add `targetWidth/targetHeight/fitMode` to `DecodeOptions`; add `sourceScale/progressiveRegion/regionFallback` to `DecodeFrameEvent`; add `ViewportResult`, `DecodeGridInfo`, `WrapperCapabilities`; extend `CodecMetric` union |
| `packages/jxl-core/src/protocol.ts` | Add `targetWidth/targetHeight/fitMode` to `MsgDecodeStart` |
| `packages/jxl-core/dist/types.d.ts` | Mirror src/types.ts changes |
| `packages/jxl-core/dist/protocol.d.ts` | Mirror src/protocol.ts changes |
| `packages/jxl-wasm/src/facade.ts` | Add `targetWidth/targetHeight/fitMode/onMetric` to `DecoderOptions`; add `progressiveRegion/regionFallback/sourceScale` to `DecodeEvent`; add `bilinearResize`, `applyTargetResize`, `pickDownsample` (internal); modify `eventsOneShot`/`eventsProgressive` for resize + metrics; add `getWrapperCapabilities`, `getDecodeGridInfo`, `decodeViewport`, `decodeRegionLod`, `normalizedToPixelExtent`, `pixelToNormalizedExtent` (exported) |
| `packages/jxl-wasm/dist/facade.d.ts` | Add declarations for all new exports |
| `packages/jxl-wasm/dist/facade.js` | Add compiled JS for all new exports |
| `packages/jxl-session/src/decode-session.ts` | Map `targetWidth/targetHeight/fitMode` from `opts` into `startMsg` |
| `packages/jxl-worker-browser/src/decode-handler.ts` | Pass `targetWidth/targetHeight/fitMode/onMetric` to `createDecoder`; emit `output_bytes` on final/budget_exceeded |
| `packages/jxl-wasm/test/facade.test.ts` | Tests for bilinearResize, resize integration, metrics, static fns, coord helpers |

---

## Task 1: jxl-core types additions

**Files:**
- Modify: `packages/jxl-core/src/types.ts`

- [ ] **Step 1: Add new fields to `DecodeOptions`**

In `packages/jxl-core/src/types.ts`, inside `DecodeOptions` after `downsample?`, add:

```ts
  targetWidth?: number;
  targetHeight?: number;
  fitMode?: "contain" | "cover" | "stretch";
```

- [ ] **Step 2: Add new fields to `DecodeFrameEvent`**

In `packages/jxl-core/src/types.ts`, inside `DecodeFrameEvent` after `pixelStride`, add:

```ts
  sourceScale?: number;
  progressiveRegion?: boolean;
  regionFallback?: "full-frame-then-crop";
```

- [ ] **Step 3: Add new interfaces and extend CodecMetric**

After the `CacheOptions` interface at the bottom of `packages/jxl-core/src/types.ts`, add:

```ts
export interface ViewportResult {
  pixels: ArrayBuffer;
  width: number;
  height: number;
  sourceRegion: Region;
  sourceScale: number;
}

export interface DecodeGridInfo {
  tileWidth?: number;
  tileHeight?: number;
  preferredRegionAlign?: number;
  lodLevels?: number[];
}

export interface WrapperCapabilities {
  regionDecode: boolean;
  exactSizeDecode: boolean;
  progressiveRegionDecode: boolean;
  tileAlignedRegionDecode: boolean;
  arbitraryRegionDecode: boolean;
  availableDownsampleFactors: number[];
}
```

- [ ] **Step 4: Extend CodecMetric union**

In `packages/jxl-core/src/types.ts`, find the `CodecMetric` type and append three new discriminants:

```ts
  | { name: "decode_scale_used"; value: number }
  | { name: "decode_region_area"; value: number }
  | { name: "source_pixels_decoded"; value: number };
```

The final union should end with:
```ts
  | { name: "region_fallback_full_frame"; value: 1 }
  | { name: "decode_scale_used"; value: number }
  | { name: "decode_region_area"; value: number }
  | { name: "source_pixels_decoded"; value: number };
```

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-core/src/types.ts
git commit -m "feat(jxl-core): add viewport types, DecodeOptions target fields, CodecMetric extensions"
```

---

## Task 2: jxl-core protocol addition

**Files:**
- Modify: `packages/jxl-core/src/protocol.ts`

- [ ] **Step 1: Add new fields to `MsgDecodeStart`**

In `packages/jxl-core/src/protocol.ts`, inside `MsgDecodeStart` after `budgetMs: number | null;`, add:

```ts
  targetWidth: number | null;
  targetHeight: number | null;
  fitMode: "contain" | "cover" | "stretch" | null;
```

- [ ] **Step 2: Commit**

```bash
git add packages/jxl-core/src/protocol.ts
git commit -m "feat(jxl-core): add targetWidth/targetHeight/fitMode to MsgDecodeStart"
```

---

## Task 3: bilinearResize internal helper + tests

**Files:**
- Modify: `packages/jxl-wasm/src/facade.ts`
- Modify: `packages/jxl-wasm/test/facade.test.ts`

- [ ] **Step 1: Write failing tests for bilinearResize**

Add this describe block to `packages/jxl-wasm/test/facade.test.ts`, at the bottom before the helper functions but inside the file. Import `bilinearResizeForTesting` (we'll export it for testing only):

```ts
// --- add this import at the top of the test file ---
import {
  createDecoder,
  createEncoder,
  detectTier,
  setJxlModuleFactoryForTesting,
  normalizedToPixelExtent,
  pixelToNormalizedExtent,
  getWrapperCapabilities,
  getDecodeGridInfo,
} from "../src/index";
```

Then add at the bottom of the test file:

```ts
describe("bilinearResize via decodeViewport integration", () => {
  test("contain fit: 2x1 image → targetWidth:1 targetHeight:1 returns 1x1 pixels", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
    // encode a 2x1 rgba8 image
    const rgba = new Uint8Array([255, 0, 0, 255,  0, 255, 0, 255]); // 2px wide, 1px tall
    const encoder = createEncoder({ ...encodeOptions, width: 2, height: 1 });
    encoder.pushPixels(rgba);
    encoder.finish();
    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();

    const decoder = createDecoder({
      ...decodeOptions,
      targetWidth: 1,
      targetHeight: 1,
      fitMode: "stretch",
    });
    decoder.push(encoded.value);
    decoder.close();

    const events = [];
    for await (const event of decoder.events()) events.push(event);

    const final = events.find((e) => e.type === "final");
    expect(final).toBeDefined();
    if (final?.type === "final") {
      expect(final.info.width).toBe(1);
      expect(final.info.height).toBe(1);
      expect(final.pixels.byteLength).toBe(4); // 1x1 rgba8
    }
    await decoder.dispose();
    await encoder.dispose();
  });

  test("no resize when targetWidth/targetHeight absent", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);
    const encoder = createEncoder({ ...encodeOptions, width: 2, height: 2 });
    encoder.pushPixels(rgba);
    encoder.finish();
    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();

    const decoder = createDecoder(decodeOptions);
    decoder.push(encoded.value);
    decoder.close();
    const events = [];
    for await (const event of decoder.events()) events.push(event);
    const final = events.find((e) => e.type === "final");
    if (final?.type === "final") {
      expect(final.info.width).toBe(2);
      expect(final.info.height).toBe(2);
    }
    await decoder.dispose();
    await encoder.dispose();
  });
});

describe("normalizedToPixelExtent / pixelToNormalizedExtent", () => {
  test("full image normalized → full pixel rect", () => {
    const r = normalizedToPixelExtent({ x: 0, y: 0, w: 1, h: 1 }, 1920, 1080);
    expect(r).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  test("half image", () => {
    const r = normalizedToPixelExtent({ x: 0.25, y: 0, w: 0.5, h: 1 }, 1000, 500);
    expect(r).toEqual({ x: 250, y: 0, w: 500, h: 500 });
  });

  test("round-trip", () => {
    const region = { x: 100, y: 50, w: 200, h: 150 };
    const norm = pixelToNormalizedExtent(region, 1000, 500);
    const back = normalizedToPixelExtent(norm, 1000, 500);
    expect(back).toEqual(region);
  });

  test("w/h minimum is 1", () => {
    const r = normalizedToPixelExtent({ x: 0, y: 0, w: 0.0001, h: 0.0001 }, 10, 10);
    expect(r.w).toBeGreaterThanOrEqual(1);
    expect(r.h).toBeGreaterThanOrEqual(1);
  });
});

describe("getWrapperCapabilities", () => {
  test("returns synchronously with expected shape", () => {
    const caps = getWrapperCapabilities();
    expect(caps.regionDecode).toBe(true);
    expect(caps.exactSizeDecode).toBe(true);
    expect(caps.progressiveRegionDecode).toBe(false);
    expect(caps.tileAlignedRegionDecode).toBe(false);
    expect(caps.arbitraryRegionDecode).toBe(true);
    expect(caps.availableDownsampleFactors).toEqual([1, 2, 4, 8]);
  });
});

describe("getDecodeGridInfo", () => {
  test("returns empty object", () => {
    const info = getDecodeGridInfo();
    expect(info).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd packages/jxl-wasm && bun test test/facade.test.ts 2>&1 | head -40
```

Expected: errors like `normalizedToPixelExtent is not exported`, `getWrapperCapabilities is not a function`.

- [ ] **Step 3: Add `bilinearResize` and `applyTargetResize` to facade.ts**

In `packages/jxl-wasm/src/facade.ts`, add these functions after the `applyRegionAndDownsample` function (around line 1155):

```ts
function bilinearResize(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  stride: number, // 4=rgba8, 8=rgba16, 16=rgbaf32
): Uint8Array {
  const dst = new Uint8Array(dstW * dstH * stride);
  if (stride === 4) {
    for (let dy = 0; dy < dstH; dy++) {
      const fy = (dy + 0.5) * (srcH / dstH) - 0.5;
      const y0 = Math.max(0, Math.floor(fy));
      const y1 = Math.min(srcH - 1, y0 + 1);
      const yt = fy - y0;
      for (let dx = 0; dx < dstW; dx++) {
        const fx = (dx + 0.5) * (srcW / dstW) - 0.5;
        const x0 = Math.max(0, Math.floor(fx));
        const x1 = Math.min(srcW - 1, x0 + 1);
        const xt = fx - x0;
        const dstOff = (dy * dstW + dx) * 4;
        for (let c = 0; c < 4; c++) {
          const tl = src[(y0 * srcW + x0) * 4 + c]!;
          const tr = src[(y0 * srcW + x1) * 4 + c]!;
          const bl = src[(y1 * srcW + x0) * 4 + c]!;
          const br = src[(y1 * srcW + x1) * 4 + c]!;
          dst[dstOff + c] = Math.round(tl * (1 - xt) * (1 - yt) + tr * xt * (1 - yt) + bl * (1 - xt) * yt + br * xt * yt);
        }
      }
    }
  } else if (stride === 8) {
    const srcView = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const dstView = new DataView(dst.buffer);
    for (let dy = 0; dy < dstH; dy++) {
      const fy = (dy + 0.5) * (srcH / dstH) - 0.5;
      const y0 = Math.max(0, Math.floor(fy));
      const y1 = Math.min(srcH - 1, y0 + 1);
      const yt = fy - y0;
      for (let dx = 0; dx < dstW; dx++) {
        const fx = (dx + 0.5) * (srcW / dstW) - 0.5;
        const x0 = Math.max(0, Math.floor(fx));
        const x1 = Math.min(srcW - 1, x0 + 1);
        const xt = fx - x0;
        const dstOff = (dy * dstW + dx) * 8;
        for (let c = 0; c < 4; c++) {
          const bo = c * 2;
          const tl = srcView.getUint16((y0 * srcW + x0) * 8 + bo, true);
          const tr = srcView.getUint16((y0 * srcW + x1) * 8 + bo, true);
          const bl = srcView.getUint16((y1 * srcW + x0) * 8 + bo, true);
          const br = srcView.getUint16((y1 * srcW + x1) * 8 + bo, true);
          const val = Math.round(tl * (1 - xt) * (1 - yt) + tr * xt * (1 - yt) + bl * (1 - xt) * yt + br * xt * yt);
          dstView.setUint16(dstOff + bo, Math.max(0, Math.min(65535, val)), true);
        }
      }
    }
  } else {
    // rgbaf32
    const srcView = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const dstView = new DataView(dst.buffer);
    for (let dy = 0; dy < dstH; dy++) {
      const fy = (dy + 0.5) * (srcH / dstH) - 0.5;
      const y0 = Math.max(0, Math.floor(fy));
      const y1 = Math.min(srcH - 1, y0 + 1);
      const yt = fy - y0;
      for (let dx = 0; dx < dstW; dx++) {
        const fx = (dx + 0.5) * (srcW / dstW) - 0.5;
        const x0 = Math.max(0, Math.floor(fx));
        const x1 = Math.min(srcW - 1, x0 + 1);
        const xt = fx - x0;
        const dstOff = (dy * dstW + dx) * 16;
        for (let c = 0; c < 4; c++) {
          const bo = c * 4;
          const tl = srcView.getFloat32((y0 * srcW + x0) * 16 + bo, true);
          const tr = srcView.getFloat32((y0 * srcW + x1) * 16 + bo, true);
          const bl = srcView.getFloat32((y1 * srcW + x0) * 16 + bo, true);
          const br = srcView.getFloat32((y1 * srcW + x1) * 16 + bo, true);
          dstView.setFloat32(dstOff + bo, tl * (1 - xt) * (1 - yt) + tr * xt * (1 - yt) + bl * (1 - xt) * yt + br * xt * yt, true);
        }
      }
    }
  }
  return dst;
}

function applyTargetResize(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
  fitMode: "contain" | "cover" | "stretch",
  bpc: 1 | 2 | 4,
): { data: Uint8Array; width: number; height: number } {
  const stride = 4 * bpc;
  if (fitMode === "stretch") {
    return { data: bilinearResize(src, srcW, srcH, targetW, targetH, stride), width: targetW, height: targetH };
  }
  if (fitMode === "contain") {
    const scale = Math.min(targetW / srcW, targetH / srcH);
    const dstW = Math.max(1, Math.round(srcW * scale));
    const dstH = Math.max(1, Math.round(srcH * scale));
    return { data: bilinearResize(src, srcW, srcH, dstW, dstH, stride), width: dstW, height: dstH };
  }
  // cover
  const scale = Math.max(targetW / srcW, targetH / srcH);
  const scaledW = Math.max(targetW, Math.round(srcW * scale));
  const scaledH = Math.max(targetH, Math.round(srcH * scale));
  const scaled = bilinearResize(src, srcW, srcH, scaledW, scaledH, stride);
  const cropX = Math.floor((scaledW - targetW) / 2);
  const cropY = Math.floor((scaledH - targetH) / 2);
  const cropped = applyRegionAndDownsample(scaled, scaledW, scaledH, { x: cropX, y: cropY, w: targetW, h: targetH }, 1, bpc);
  return { data: cropped.data, width: targetW, height: targetH };
}
```

- [ ] **Step 4: Add `pickDownsample` internal helper**

Add after `applyTargetResize`:

```ts
function pickDownsample(_options: { targetWidth?: number | null; targetHeight?: number | null }): 1 | 2 | 4 | 8 {
  // Source dims unknown at call time — resize post-decode handles scale-to-target.
  return 1;
}
```

- [ ] **Step 5: Commit helpers (tests still failing — exports not added yet)**

```bash
git add packages/jxl-wasm/src/facade.ts
git commit -m "feat(jxl-wasm): add bilinearResize, applyTargetResize, pickDownsample helpers"
```

---

## Task 4: Add new fields to DecoderOptions + DecodeEvent in facade.ts

**Files:**
- Modify: `packages/jxl-wasm/src/facade.ts`

- [ ] **Step 1: Extend `DecoderOptions` with new fields**

In `packages/jxl-wasm/src/facade.ts`, find `interface DecoderOptions` and add after `copyInput?`:

```ts
  targetWidth?: number | null;
  targetHeight?: number | null;
  fitMode?: "contain" | "cover" | "stretch" | null;
  onMetric?: (name: string, value: number) => void;
```

- [ ] **Step 2: Extend `DecodeEvent` union with new optional fields**

In `packages/jxl-wasm/src/facade.ts`, find `export type DecodeEvent`. Add `sourceScale`, `progressiveRegion`, `regionFallback` to the `progress` and `final` discriminants. The `progress` entry becomes:

```ts
  | {
      type: "progress";
      stage: DecodeStage;
      info: ImageInfo;
      pixels: ArrayBuffer | Uint8Array;
      format: PixelFormat;
      region?: Region;
      pixelStride: number;
      sourceScale?: number;
      progressiveRegion?: boolean;
      regionFallback?: "full-frame-then-crop";
    }
```

The `final` entry becomes:

```ts
  | {
      type: "final";
      info: ImageInfo;
      pixels: ArrayBuffer | Uint8Array;
      format: PixelFormat;
      region?: Region;
      pixelStride: number;
      sourceScale?: number;
      progressiveRegion?: boolean;
      regionFallback?: "full-frame-then-crop";
    }
```

- [ ] **Step 3: Update `normalizeDecoderOptions` to pass through new fields**

In `packages/jxl-wasm/src/facade.ts`, find `normalizeDecoderOptions` and update:

```ts
function normalizeDecoderOptions(options: DecoderOptions): DecoderOptions {
  return {
    ...options,
    region: options.region ?? null,
    downsample: options.downsample ?? 1,
    targetWidth: options.targetWidth ?? null,
    targetHeight: options.targetHeight ?? null,
    fitMode: options.fitMode ?? null,
  };
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/jxl-wasm/src/facade.ts
git commit -m "feat(jxl-wasm): extend DecoderOptions and DecodeEvent with viewport/metric fields"
```

---

## Task 5: P1 exact resize + P5 metrics in eventsOneShot

**Files:**
- Modify: `packages/jxl-wasm/src/facade.ts`

- [ ] **Step 1: Apply resize and emit metrics in eventsOneShot**

In `packages/jxl-wasm/src/facade.ts`, find `eventsOneShot`. After the block where `pixels` is computed from `applyRegionAndDownsample` (around line 600-611), add the resize and metric emission. Replace the section from `const info: ImageInfo = {` through the end of final yield with:

```ts
      // Apply bilinear resize to exact target size (P1).
      const targetW = this.options.targetWidth;
      const targetH = this.options.targetHeight;
      const fitMode = this.options.fitMode ?? "contain";
      let outPixels = pixels;
      if (targetW != null && targetH != null && targetW > 0 && targetH > 0) {
        const resized = applyTargetResize(pixels.data, pixels.width, pixels.height, targetW, targetH, fitMode, bpc);
        outPixels = { data: resized.data, width: resized.width, height: resized.height, region: pixels.region };
      }

      const info: ImageInfo = {
        width: outPixels.width,
        height: outPixels.height,
        bitsPerSample: decoded.bitsPerSample,
        hasAlpha: decoded.hasAlpha,
        hasAnimation: false,
        jpegReconstructionAvailable: false,
      };

      const actualScale = this.options.downsample;
      const onMetric = this.options.onMetric;
      if (onMetric) {
        onMetric("decode_scale_used", actualScale);
        onMetric("source_pixels_decoded", decoded.width * decoded.height);
        if (this.options.region != null) {
          const r = this.options.region;
          onMetric("decode_region_area", r.w * r.h);
        }
      }

      yield { type: "header", info };
      if (this.options.progressionTarget === "header") return;
      if (this.options.emitEveryPass || this.options.progressionTarget === "dc" || this.options.progressionTarget === "pass") {
        const ev: Extract<DecodeEvent, { type: "progress" }> = {
          type: "progress",
          stage: this.options.progressionTarget === "dc" ? "dc" : "pass",
          info,
          pixels: this.options.progressionTarget !== "final" ? outPixels.data : outPixels.data.slice(),
          format: fmt,
          pixelStride: 4 * bpc,
          sourceScale: actualScale,
          progressiveRegion: false,
        };
        if (outPixels.region !== undefined) ev.region = outPixels.region;
        yield ev;
        if (this.options.progressionTarget !== "final") return;
      }
      const ev: Extract<DecodeEvent, { type: "final" }> = {
        type: "final",
        info,
        pixels: outPixels.data,
        format: fmt,
        pixelStride: 4 * bpc,
        sourceScale: actualScale,
        progressiveRegion: false,
      };
      if (outPixels.region !== undefined) ev.region = outPixels.region;
      yield ev;
```

Note: The original `pixelStride` variable assignment (`const pixelStride = 4 * bpc`) can be removed since we inline it. Make sure no remaining reference to the old `info` block exists. The original code from `const info: ImageInfo = {` to `yield ev` (the final yield) should be fully replaced by the block above.

- [ ] **Step 2: Run the resize integration tests**

```bash
cd packages/jxl-wasm && bun test test/facade.test.ts --grep "contain fit" 2>&1
```

Expected: PASS (or close — the test depends on real WASM). If WASM not available it uses fake and may skip some assertions. Confirm no crash.

- [ ] **Step 3: Commit**

```bash
git add packages/jxl-wasm/src/facade.ts
git commit -m "feat(jxl-wasm): P1 bilinear resize in eventsOneShot + decode_scale_used/region_area/source_pixels metrics"
```

---

## Task 6: P4 progressive region flags + P5 metrics in eventsProgressive

**Files:**
- Modify: `packages/jxl-wasm/src/facade.ts`

- [ ] **Step 1: Emit `region_fallback_full_frame` metric and set flags in eventsProgressive**

In `packages/jxl-wasm/src/facade.ts`, inside `eventsProgressive`:

Find the `takeAndWrap` helper function definition (which calls `applyRegionAndDownsample`). After it is defined but before the main while loop, add a flag to track whether we already emitted the fallback metric:

```ts
      const hasRegion = this.options.region != null;
      const onMetric = this.options.onMetric;
      let fallbackMetricEmitted = false;
```

Then, in the block where a flushed frame is yielded (inside `if (result === 1)`), after the `wrapped` is obtained, update the event construction to include the new flags and apply resize:

Replace the existing progress yield block inside `if (result === 1)`:

```ts
          if (wrapped !== null) {
            const { pixels: rawPixels, evInfo } = wrapped;

            // P4: progressive + region = JS-side full-frame-then-crop fallback
            if (hasRegion && !fallbackMetricEmitted && onMetric) {
              onMetric("region_fallback_full_frame", 1);
              fallbackMetricEmitted = true;
            }

            // P1: apply bilinear resize if target dims set
            const targetW = this.options.targetWidth;
            const targetH = this.options.targetHeight;
            const fitMode = this.options.fitMode ?? "contain";
            let outPixels = rawPixels;
            if (targetW != null && targetH != null && targetW > 0 && targetH > 0) {
              const resized = applyTargetResize(rawPixels.data, rawPixels.width, rawPixels.height, targetW, targetH, fitMode, bpc as 1 | 2 | 4);
              outPixels = { data: resized.data, width: resized.width, height: resized.height, region: rawPixels.region };
            }

            const outInfo: ImageInfo = (outPixels.width !== evInfo.width || outPixels.height !== evInfo.height)
              ? { ...evInfo, width: outPixels.width, height: outPixels.height }
              : evInfo;

            const ev: Extract<DecodeEvent, { type: "progress" }> = {
              type: "progress",
              stage,
              info: outInfo,
              pixels: outPixels.data,
              format: fmt,
              pixelStride,
              sourceScale: this.options.downsample,
              progressiveRegion: false,
            };
            if (hasRegion) ev.regionFallback = "full-frame-then-crop";
            if (outPixels.region !== undefined) ev.region = outPixels.region;
            yield ev;
            if (this.options.progressionTarget !== "final" && !this.options.emitEveryPass) return;
          }
```

- [ ] **Step 2: Apply same flags/resize to the `done` block (final from progressive)**

In the `if (done)` block at the end of `eventsProgressive`, after `takeAndWrap(decTakeFinal(dec))`, update the progress and final yields to include `sourceScale`, `progressiveRegion`, `regionFallback`, and apply resize. Replace the existing `if (done)` block with:

```ts
      if (done) {
        const wrapped = takeAndWrap(decTakeFinal(dec));
        if (wrapped !== null) {
          const { pixels: rawPixels, evInfo } = wrapped;

          // Emit metrics on first final frame from progressive path
          if (onMetric) {
            onMetric("decode_scale_used", this.options.downsample);
            onMetric("source_pixels_decoded", info?.width != null && info?.height != null ? info.width * info.height : rawPixels.width * rawPixels.height);
            if (hasRegion) onMetric("decode_region_area", (this.options.region!.w) * (this.options.region!.h));
          }

          const targetW = this.options.targetWidth;
          const targetH = this.options.targetHeight;
          const fitMode = this.options.fitMode ?? "contain";
          let outPixels = rawPixels;
          if (targetW != null && targetH != null && targetW > 0 && targetH > 0) {
            const resized = applyTargetResize(rawPixels.data, rawPixels.width, rawPixels.height, targetW, targetH, fitMode, bpc as 1 | 2 | 4);
            outPixels = { data: resized.data, width: resized.width, height: resized.height, region: rawPixels.region };
          }

          const outInfo: ImageInfo = (outPixels.width !== evInfo.width || outPixels.height !== evInfo.height)
            ? { ...evInfo, width: outPixels.width, height: outPixels.height }
            : evInfo;

          if (!gotRealFlush && (this.options.emitEveryPass || this.options.progressionTarget === "dc" || this.options.progressionTarget === "pass")) {
            const stage: DecodeStage = this.options.progressionTarget === "dc" ? "dc" : "pass";
            const ev: Extract<DecodeEvent, { type: "progress" }> = {
              type: "progress",
              stage,
              info: outInfo,
              pixels: this.options.progressionTarget !== "final" ? outPixels.data : outPixels.data.slice(),
              format: fmt,
              pixelStride,
              sourceScale: this.options.downsample,
              progressiveRegion: false,
            };
            if (hasRegion) ev.regionFallback = "full-frame-then-crop";
            if (outPixels.region !== undefined) ev.region = outPixels.region;
            yield ev;
            if (this.options.progressionTarget !== "final") return;
          }

          const ev: Extract<DecodeEvent, { type: "final" }> = {
            type: "final",
            info: outInfo,
            pixels: outPixels.data,
            format: fmt,
            pixelStride,
            sourceScale: this.options.downsample,
            progressiveRegion: false,
          };
          if (hasRegion) ev.regionFallback = "full-frame-then-crop";
          if (outPixels.region !== undefined) ev.region = outPixels.region;
          yield ev;
        }
      }
```

Note: The original `evInfo` used in the `done` block was computed inside `takeAndWrap`. The updated version uses `outInfo` which accounts for resize. Also note that `info` refers to the memoized `ImageInfo` from the `buildInfo` helper — which holds the native full-frame dims and is used for `source_pixels_decoded`.

- [ ] **Step 3: Commit**

```bash
git add packages/jxl-wasm/src/facade.ts
git commit -m "feat(jxl-wasm): P4 progressive region flags, P5 region_fallback/scale metrics in eventsProgressive"
```

---

## Task 7: P6 WrapperCapabilities + P3 DecodeGridInfo + static exports

**Files:**
- Modify: `packages/jxl-wasm/src/facade.ts`

- [ ] **Step 1: Add WrapperCapabilities and DecodeGridInfo interfaces to facade.ts**

At the top of `packages/jxl-wasm/src/facade.ts`, after the existing `export type Tier = ...` line, add:

```ts
export interface WrapperCapabilities {
  regionDecode: boolean;
  exactSizeDecode: boolean;
  progressiveRegionDecode: boolean;
  tileAlignedRegionDecode: boolean;
  arbitraryRegionDecode: boolean;
  availableDownsampleFactors: number[];
}

export interface DecodeGridInfo {
  tileWidth?: number;
  tileHeight?: number;
  preferredRegionAlign?: number;
  lodLevels?: number[];
}
```

- [ ] **Step 2: Add exported functions after `transcodeJpegToJxl`**

In `packages/jxl-wasm/src/facade.ts`, after the `preloadJxlModule` function, add:

```ts
export function getWrapperCapabilities(): WrapperCapabilities {
  return {
    regionDecode: true,
    exactSizeDecode: true,
    progressiveRegionDecode: false,
    tileAlignedRegionDecode: false,
    arbitraryRegionDecode: true,
    availableDownsampleFactors: [1, 2, 4, 8],
  };
}

export function getDecodeGridInfo(): DecodeGridInfo {
  return {};
}
```

- [ ] **Step 3: Run static function tests**

```bash
cd packages/jxl-wasm && bun test test/facade.test.ts --grep "getWrapperCapabilities|getDecodeGridInfo" 2>&1
```

Expected: both tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/jxl-wasm/src/facade.ts
git commit -m "feat(jxl-wasm): P6 getWrapperCapabilities, P3 getDecodeGridInfo"
```

---

## Task 8: P7 viewport API + P8 coordinate helpers

**Files:**
- Modify: `packages/jxl-wasm/src/facade.ts`

- [ ] **Step 1: Add viewport API interfaces and functions**

In `packages/jxl-wasm/src/facade.ts`, after `getDecodeGridInfo`, add:

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
    downsample: pickDownsample(options),
    progressionTarget: options.progressionTarget ?? "final",
    emitEveryPass: options.emitEveryPass ?? false,
    preserveIcc: options.preserveIcc ?? true,
    preserveMetadata: options.preserveMetadata ?? false,
    targetWidth: options.targetWidth ?? null,
    targetHeight: options.targetHeight ?? null,
    fitMode: options.fitMode ?? null,
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
    downsample: 1,
    progressionTarget: "final",
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
    targetWidth: options.targetLongEdge,
    targetHeight: options.targetLongEdge,
    fitMode: "contain",
  });
}
```

- [ ] **Step 2: Add P8 coordinate helpers**

After `decodeRegionLod`, add:

```ts
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

- [ ] **Step 3: Run coordinate helper tests**

```bash
cd packages/jxl-wasm && bun test test/facade.test.ts --grep "normalizedToPixelExtent|pixelToNormalizedExtent" 2>&1
```

Expected: all 4 coordinate tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/jxl-wasm/src/facade.ts
git commit -m "feat(jxl-wasm): P7 decodeViewport/decodeRegionLod, P8 coordinate helpers"
```

---

## Task 9: Thread through decode-session + decode-handler

**Files:**
- Modify: `packages/jxl-session/src/decode-session.ts`
- Modify: `packages/jxl-worker-browser/src/decode-handler.ts`

- [ ] **Step 1: Add new fields to startMsg in decode-session.ts**

In `packages/jxl-session/src/decode-session.ts`, find the `startMsg` construction inside the constructor. Add three new fields after `budgetMs`:

```ts
      budgetMs: opts.budgetMs ?? null,
      targetWidth: opts.targetWidth ?? null,
      targetHeight: opts.targetHeight ?? null,
      fitMode: opts.fitMode ?? null,
```

- [ ] **Step 2: Pass new fields and onMetric to createDecoder in decode-handler.ts**

In `packages/jxl-worker-browser/src/decode-handler.ts`, find the `run()` method's `this.wasm.createDecoder({...})` call. Add the new fields:

```ts
    const decoder = this.wasm.createDecoder({
      format: this.opts.format,
      region: this.opts.region,
      downsample: this.opts.downsample,
      progressionTarget: this.opts.progressionTarget,
      emitEveryPass: this.opts.emitEveryPass,
      preserveIcc: this.opts.preserveIcc,
      preserveMetadata: this.opts.preserveMetadata,
      targetWidth: this.opts.targetWidth,
      targetHeight: this.opts.targetHeight,
      fitMode: this.opts.fitMode,
      onMetric: (name, value) => this.postMetric(name, value),
    });
```

- [ ] **Step 3: Emit `output_bytes` metric on final and budget_exceeded events**

In `packages/jxl-worker-browser/src/decode-handler.ts`, find the `case "final":` block inside `readDecoderEvents`. After the `self.postMessage(msg, [pixels])` call for the final case (just before `this.postFirstPixelMetric()`), add:

```ts
          this.postMetric("output_bytes", pixels.byteLength);
```

Also add the same after the `self.postMessage(msg, [pixels])` in `postBudgetExceeded`, before `this.finishSession("budget_exceeded")`:

In `postBudgetExceeded`, after `self.postMessage(msg, [pixels])`:

```ts
    this.postMetric("output_bytes", pixels.byteLength);
```

Note: `postBudgetExceeded` transfers `pixels` via `self.postMessage(msg, [pixels])` — so we must read `pixels.byteLength` BEFORE the postMessage call. Looking at the existing code, the message is sent then `this.finishSession` is called. Add the metric call BEFORE `self.postMessage` to be safe (the metric message is sent first, then the pixel buffer is transferred):

Actually, reading the spec: "Emit on final/budget_exceeded using `pixels.byteLength`". The bytes are available before transfer. Add `this.postMetric("output_bytes", pixels.byteLength)` BEFORE `self.postMessage(msg, [pixels])` in both locations to capture the byte count before detach.

In `readDecoderEvents` case "final":
```ts
          this.postMetric("output_bytes", pixels.byteLength);
          self.postMessage(msg, [pixels]);
```

In `postBudgetExceeded`:
```ts
    this.postMetric("output_bytes", pixels.byteLength);
    self.postMessage(msg, [pixels]);
    this.finishSession("budget_exceeded");
```

- [ ] **Step 4: Commit**

```bash
git add packages/jxl-session/src/decode-session.ts packages/jxl-worker-browser/src/decode-handler.ts
git commit -m "feat(session/handler): thread targetWidth/Height/fitMode; emit output_bytes metric"
```

---

## Task 10: Update dist files

**Files:**
- Modify: `packages/jxl-core/dist/types.d.ts`
- Modify: `packages/jxl-core/dist/protocol.d.ts`
- Modify: `packages/jxl-wasm/dist/facade.d.ts`
- Modify: `packages/jxl-wasm/dist/facade.js`

- [ ] **Step 1: Update `jxl-core/dist/types.d.ts`**

In `packages/jxl-core/dist/types.d.ts`:

1. Inside `DecodeFrameEvent`, add after `pixelStride: number;`:
```ts
    sourceScale?: number;
    progressiveRegion?: boolean;
    regionFallback?: "full-frame-then-crop";
```

2. Inside `DecodeOptions`, add after `downsample?`:
```ts
    targetWidth?: number;
    targetHeight?: number;
    fitMode?: "contain" | "cover" | "stretch";
```

3. In the `CodecMetric` type, append before the final `;`:
```ts
} | {
    name: "decode_scale_used";
    value: number;
} | {
    name: "decode_region_area";
    value: number;
} | {
    name: "source_pixels_decoded";
    value: number;
};
```

4. Before the `//# sourceMappingURL` comment at the bottom, add:
```ts
export interface ViewportResult {
    pixels: ArrayBuffer;
    width: number;
    height: number;
    sourceRegion: Region;
    sourceScale: number;
}
export interface DecodeGridInfo {
    tileWidth?: number;
    tileHeight?: number;
    preferredRegionAlign?: number;
    lodLevels?: number[];
}
export interface WrapperCapabilities {
    regionDecode: boolean;
    exactSizeDecode: boolean;
    progressiveRegionDecode: boolean;
    tileAlignedRegionDecode: boolean;
    arbitraryRegionDecode: boolean;
    availableDownsampleFactors: number[];
}
```

- [ ] **Step 2: Update `jxl-core/dist/protocol.d.ts`**

In `packages/jxl-core/dist/protocol.d.ts`, inside `MsgDecodeStart`, add after `budgetMs: number | null;`:
```ts
    targetWidth: number | null;
    targetHeight: number | null;
    fitMode: "contain" | "cover" | "stretch" | null;
```

- [ ] **Step 3: Update `jxl-wasm/dist/facade.d.ts`**

In `packages/jxl-wasm/dist/facade.d.ts`, update `DecoderOptions` to add new optional fields after `copyInput?`:
```ts
    targetWidth?: number | null;
    targetHeight?: number | null;
    fitMode?: "contain" | "cover" | "stretch" | null;
    onMetric?: (name: string, value: number) => void;
```

Update the `DecodeEvent` `progress` and `final` discriminants to add:
```ts
    sourceScale?: number;
    progressiveRegion?: boolean;
    regionFallback?: "full-frame-then-crop";
```

After the existing `export declare function preloadJxlModule(): void;` line, add:
```ts
export interface WrapperCapabilities {
    regionDecode: boolean;
    exactSizeDecode: boolean;
    progressiveRegionDecode: boolean;
    tileAlignedRegionDecode: boolean;
    arbitraryRegionDecode: boolean;
    availableDownsampleFactors: number[];
}
export interface DecodeGridInfo {
    tileWidth?: number;
    tileHeight?: number;
    preferredRegionAlign?: number;
    lodLevels?: number[];
}
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
export interface DecodeRegionLodOptions {
    format: PixelFormat;
    region?: Region | null;
    targetLongEdge: number;
}
export declare function getWrapperCapabilities(): WrapperCapabilities;
export declare function getDecodeGridInfo(): DecodeGridInfo;
export declare function decodeViewport(options: DecodeViewportOptions): JxlDecoder;
export declare function decodeRegionLod(options: DecodeRegionLodOptions): JxlDecoder;
export declare function normalizedToPixelExtent(norm: { x: number; y: number; w: number; h: number }, imageWidth: number, imageHeight: number): Region;
export declare function pixelToNormalizedExtent(region: Region, imageWidth: number, imageHeight: number): { x: number; y: number; w: number; h: number };
```

- [ ] **Step 4: Update `jxl-wasm/dist/facade.js`**

In `packages/jxl-wasm/dist/facade.js`, append before the final line (if any) the compiled JS for all new exports. Add after the existing exports:

```js
export function getWrapperCapabilities() {
    return {
        regionDecode: true,
        exactSizeDecode: true,
        progressiveRegionDecode: false,
        tileAlignedRegionDecode: false,
        arbitraryRegionDecode: true,
        availableDownsampleFactors: [1, 2, 4, 8],
    };
}
export function getDecodeGridInfo() {
    return {};
}
export function decodeViewport(options) {
    return createDecoder({
        format: options.format,
        region: options.region ?? null,
        downsample: 1,
        progressionTarget: options.progressionTarget ?? "final",
        emitEveryPass: options.emitEveryPass ?? false,
        preserveIcc: options.preserveIcc ?? true,
        preserveMetadata: options.preserveMetadata ?? false,
        targetWidth: options.targetWidth ?? null,
        targetHeight: options.targetHeight ?? null,
        fitMode: options.fitMode ?? null,
    });
}
export function decodeRegionLod(options) {
    return createDecoder({
        format: options.format,
        region: options.region ?? null,
        downsample: 1,
        progressionTarget: "final",
        emitEveryPass: false,
        preserveIcc: false,
        preserveMetadata: false,
        targetWidth: options.targetLongEdge,
        targetHeight: options.targetLongEdge,
        fitMode: "contain",
    });
}
export function normalizedToPixelExtent(norm, imageWidth, imageHeight) {
    return {
        x: Math.round(norm.x * imageWidth),
        y: Math.round(norm.y * imageHeight),
        w: Math.max(1, Math.round(norm.w * imageWidth)),
        h: Math.max(1, Math.round(norm.h * imageHeight)),
    };
}
export function pixelToNormalizedExtent(region, imageWidth, imageHeight) {
    return {
        x: region.x / imageWidth,
        y: region.y / imageHeight,
        w: region.w / imageWidth,
        h: region.h / imageHeight,
    };
}
```

Also update the existing functions in `facade.js` to pass through `targetWidth/targetHeight/fitMode/onMetric` in `normalizeDecoderOptions` equivalent and in the decode logic. The `normalizeDecoderOptions` compiled form (look for the spread pattern in facade.js) needs `targetWidth: options.targetWidth ?? null, targetHeight: options.targetHeight ?? null, fitMode: options.fitMode ?? null`.

The `bilinearResize`, `applyTargetResize`, `pickDownsample`, `applyTargetResize` functions also need to be added to facade.js. These are internal (not exported), so add them as plain function declarations. Copy the TypeScript implementations, removing type annotations:

```js
function bilinearResize(src, srcW, srcH, dstW, dstH, stride) {
    const dst = new Uint8Array(dstW * dstH * stride);
    if (stride === 4) {
        for (let dy = 0; dy < dstH; dy++) {
            const fy = (dy + 0.5) * (srcH / dstH) - 0.5;
            const y0 = Math.max(0, Math.floor(fy));
            const y1 = Math.min(srcH - 1, y0 + 1);
            const yt = fy - y0;
            for (let dx = 0; dx < dstW; dx++) {
                const fx = (dx + 0.5) * (srcW / dstW) - 0.5;
                const x0 = Math.max(0, Math.floor(fx));
                const x1 = Math.min(srcW - 1, x0 + 1);
                const xt = fx - x0;
                const dstOff = (dy * dstW + dx) * 4;
                for (let c = 0; c < 4; c++) {
                    const tl = src[(y0 * srcW + x0) * 4 + c];
                    const tr = src[(y0 * srcW + x1) * 4 + c];
                    const bl = src[(y1 * srcW + x0) * 4 + c];
                    const br = src[(y1 * srcW + x1) * 4 + c];
                    dst[dstOff + c] = Math.round(tl * (1 - xt) * (1 - yt) + tr * xt * (1 - yt) + bl * (1 - xt) * yt + br * xt * yt);
                }
            }
        }
    } else if (stride === 8) {
        const srcView = new DataView(src.buffer, src.byteOffset, src.byteLength);
        const dstView = new DataView(dst.buffer);
        for (let dy = 0; dy < dstH; dy++) {
            const fy = (dy + 0.5) * (srcH / dstH) - 0.5;
            const y0 = Math.max(0, Math.floor(fy));
            const y1 = Math.min(srcH - 1, y0 + 1);
            const yt = fy - y0;
            for (let dx = 0; dx < dstW; dx++) {
                const fx = (dx + 0.5) * (srcW / dstW) - 0.5;
                const x0 = Math.max(0, Math.floor(fx));
                const x1 = Math.min(srcW - 1, x0 + 1);
                const xt = fx - x0;
                const dstOff = (dy * dstW + dx) * 8;
                for (let c = 0; c < 4; c++) {
                    const bo = c * 2;
                    const tl = srcView.getUint16((y0 * srcW + x0) * 8 + bo, true);
                    const tr = srcView.getUint16((y0 * srcW + x1) * 8 + bo, true);
                    const bl = srcView.getUint16((y1 * srcW + x0) * 8 + bo, true);
                    const br = srcView.getUint16((y1 * srcW + x1) * 8 + bo, true);
                    const val = Math.round(tl * (1 - xt) * (1 - yt) + tr * xt * (1 - yt) + bl * (1 - xt) * yt + br * xt * yt);
                    dstView.setUint16(dstOff + bo, Math.max(0, Math.min(65535, val)), true);
                }
            }
        }
    } else {
        const srcView = new DataView(src.buffer, src.byteOffset, src.byteLength);
        const dstView = new DataView(dst.buffer);
        for (let dy = 0; dy < dstH; dy++) {
            const fy = (dy + 0.5) * (srcH / dstH) - 0.5;
            const y0 = Math.max(0, Math.floor(fy));
            const y1 = Math.min(srcH - 1, y0 + 1);
            const yt = fy - y0;
            for (let dx = 0; dx < dstW; dx++) {
                const fx = (dx + 0.5) * (srcW / dstW) - 0.5;
                const x0 = Math.max(0, Math.floor(fx));
                const x1 = Math.min(srcW - 1, x0 + 1);
                const xt = fx - x0;
                const dstOff = (dy * dstW + dx) * 16;
                for (let c = 0; c < 4; c++) {
                    const bo = c * 4;
                    const tl = srcView.getFloat32((y0 * srcW + x0) * 16 + bo, true);
                    const tr = srcView.getFloat32((y0 * srcW + x1) * 16 + bo, true);
                    const bl = srcView.getFloat32((y1 * srcW + x0) * 16 + bo, true);
                    const br = srcView.getFloat32((y1 * srcW + x1) * 16 + bo, true);
                    dstView.setFloat32(dstOff + bo, tl * (1 - xt) * (1 - yt) + tr * xt * (1 - yt) + bl * (1 - xt) * yt + br * xt * yt, true);
                }
            }
        }
    }
    return dst;
}

function applyTargetResize(src, srcW, srcH, targetW, targetH, fitMode, bpc) {
    const stride = 4 * bpc;
    if (fitMode === "stretch") {
        return { data: bilinearResize(src, srcW, srcH, targetW, targetH, stride), width: targetW, height: targetH };
    }
    if (fitMode === "contain") {
        const scale = Math.min(targetW / srcW, targetH / srcH);
        const dstW = Math.max(1, Math.round(srcW * scale));
        const dstH = Math.max(1, Math.round(srcH * scale));
        return { data: bilinearResize(src, srcW, srcH, dstW, dstH, stride), width: dstW, height: dstH };
    }
    const scale = Math.max(targetW / srcW, targetH / srcH);
    const scaledW = Math.max(targetW, Math.round(srcW * scale));
    const scaledH = Math.max(targetH, Math.round(srcH * scale));
    const scaled = bilinearResize(src, srcW, srcH, scaledW, scaledH, stride);
    const cropX = Math.floor((scaledW - targetW) / 2);
    const cropY = Math.floor((scaledH - targetH) / 2);
    const cropped = applyRegionAndDownsample(scaled, scaledW, scaledH, { x: cropX, y: cropY, w: targetW, h: targetH }, 1, bpc);
    return { data: cropped.data, width: targetW, height: targetH };
}

function pickDownsample(_options) {
    return 1;
}
```

- [ ] **Step 5: Commit dist updates**

```bash
git add packages/jxl-core/dist/types.d.ts packages/jxl-core/dist/protocol.d.ts packages/jxl-wasm/dist/facade.d.ts packages/jxl-wasm/dist/facade.js
git commit -m "chore(dist): update jxl-core and jxl-wasm dist files to match src"
```

---

## Task 11: Run all tests + verify success criteria

**Files:** none (read-only)

- [ ] **Step 1: Run facade tests**

```bash
cd packages/jxl-wasm && bun test 2>&1
```

Expected: all existing tests PASS, all new tests PASS.

- [ ] **Step 2: Run session tests**

```bash
cd packages/jxl-session && bun test 2>&1
```

Expected: all tests PASS.

- [ ] **Step 3: Run worker-browser tests**

```bash
cd packages/jxl-worker-browser && bun test 2>&1
```

Expected: all tests PASS.

- [ ] **Step 4: Verify success criteria**

Check each criterion manually:
- `decodeViewport({ format: "rgba8", targetWidth: 640, targetHeight: 480 })` — test via Step 1 resize tests
- `getWrapperCapabilities()` synchronous — verified by Step 1 static tests
- `region_fallback_full_frame` fires on progressive + region — covered by progressive path changes
- `decode_scale_used`, `decode_region_area`, `source_pixels_decoded` — emitted via onMetric in eventsOneShot
- `output_bytes` emitted on final — decode-handler.ts change
- `progressiveRegion: false`, `regionFallback` on progress events — eventsProgressive change
- `normalizedToPixelExtent` / `pixelToNormalizedExtent` round-trip — round-trip test
- All existing tests pass — Steps 1–3

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "test(jxl-wasm): add viewport resize, coordinate helper, and static capability tests"
```

---

## Self-Review Against Spec

**Spec coverage check:**

| Spec Item | Task |
|-----------|------|
| P1 targetWidth/targetHeight/fitMode on DecodeOptions | Task 1 |
| P1 targetWidth/targetHeight/fitMode on MsgDecodeStart | Task 2 |
| P1 bilinear resize in facade + eventsOneShot | Tasks 3, 5 |
| P1 pickDownsample helper | Task 3 |
| P1 decode_scale_used metric | Task 5 |
| P2 ViewportResult type | Task 1 |
| P2 sourceScale on DecodeFrameEvent | Tasks 1, 5, 6 |
| P3 DecodeGridInfo + getDecodeGridInfo | Tasks 1, 7 |
| P4 progressiveRegion + regionFallback flags | Task 6 |
| P4 set on progress events in eventsProgressive | Task 6 |
| P5 region_fallback_full_frame emitted | Task 6 |
| P5 decode_scale_used emitted | Task 5 |
| P5 decode_region_area emitted | Task 5 |
| P5 source_pixels_decoded emitted | Task 5 |
| P5 output_bytes emitted on final/budget_exceeded | Task 9 |
| P6 WrapperCapabilities + getWrapperCapabilities | Tasks 1, 7 |
| P7 decodeViewport + decodeRegionLod | Task 8 |
| P8 normalizedToPixelExtent + pixelToNormalizedExtent | Task 8 |
| Thread through decode-session | Task 9 |
| Thread through decode-handler | Task 9 |
| Dist file updates | Task 10 |

**Type consistency check:**
- `fitMode: "contain" | "cover" | "stretch"` used consistently across DecodeOptions, MsgDecodeStart, DecoderOptions, DecodeViewportOptions
- `targetWidth: number | null` in MsgDecodeStart; `targetWidth?: number | null` in DecoderOptions; `targetWidth?: number` in DecodeOptions — correct (session maps `opts.targetWidth ?? null`)
- `bpc` as `1 | 2 | 4` passed to `applyTargetResize` — caller computes from format and TypeScript casts appropriately
- `sourceScale` field name matches in DecodeFrameEvent (jxl-core) and DecodeEvent (facade)

**Placeholder check:** None found.
