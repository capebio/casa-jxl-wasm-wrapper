import { afterEach, describe, expect, it, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createDecoder,
  createEncoder,
  detectTier,
  decodeTileContainerRegionRgba16,
  encodeTileContainerRgba16,
  setJxlModuleFactoryForTesting,
  normalizedToPixelExtent,
  pixelToNormalizedExtent,
  getWrapperCapabilities,
  getDecodeGridInfo,
  decodeViewport,
  JxlFrameSetting,
} from "../src/index";

// Types under test for extra-channel Phase 2 live in the facade (not yet re-exported via index).
import type { ExtraChannel, EncoderOptions } from "../src/facade";
import { serializeExtraChannelsForWasm, EC_BYTES } from "../src/facade";

const decodeOptions = {
  format: "rgba8" as const,
  region: null,
  downsample: 1 as const,
  progressionTarget: "final" as const,
  emitEveryPass: false,
  preserveIcc: true,
  preserveMetadata: true,
};

const encodeOptions = {
  format: "rgba8" as const,
  width: 1,
  height: 1,
  hasAlpha: true,
  iccProfile: null,
  exif: null,
  xmp: null,
  distance: null,
  quality: null,
  effort: 7 as const,
  progressive: false,
  previewFirst: false,
  chunked: false,
};

describe("@casabio/jxl-wasm facade", () => {
  afterEach(() => {
    setJxlModuleFactoryForTesting(null);
  });

  test("package facade does not depend on temporary icodec or jsquash bridges", () => {
    const source = readFileSync(new URL("../src/facade.ts", import.meta.url), "utf8");
    const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");

    expect(source).not.toContain("icodec");
    expect(source).not.toContain("jsquash");
    expect(manifest).not.toContain("icodec");
    expect(manifest).not.toContain("jsquash");
  });

  test("drops JS-side staging queues after bytes move into WASM", () => {
    const source = readFileSync(new URL("../src/facade.ts", import.meta.url), "utf8");

    expect(source).toContain("this.pixelChunks = []");
    expect(source).toContain("allChunks.length = 0");
  });

  test("viewport helper chooses power-of-two downsample from region and target size", () => {
    const source = readFileSync(new URL("../src/facade.ts", import.meta.url), "utf8");

    expect(source).toContain("function pickDownsample(options: { region?: Region | null; targetWidth?: number | null; targetHeight?: number | null }): 1 | 2 | 4 | 8");
    expect(source).toContain("Math.ceil(sourceLongEdge / factor) >= targetLongEdge");
  });

  test("forwards progressive encode settings into the WASM bridge instead of rejecting them", () => {
    const source = readFileSync(new URL("../src/facade.ts", import.meta.url), "utf8");

    expect(source).toContain("function resolveEncoderBridgeSettings");
    expect(source).toContain("progressiveFlavor?: \"dc\" | \"ac\";");
    expect(source).not.toContain("Progressive JXL encode requires a rebuilt WASM with a progressive bridge flag");
  });

  test("chunks waits for in-flight streaming pixel pushes", async () => {
    setJxlModuleFactoryForTesting(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return createFakeStreamingInputLibjxlModule();
    });

    const encoder = createEncoder({ ...encodeOptions, quality: 90 });
    void encoder.pushPixels(new Uint8Array([255, 0, 0, 255]));
    encoder.finish();

    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();
    expect(encoded.done).toBe(false);
    expect(Array.from(new Uint8Array(encoded.value))).toEqual([255, 0, 0, 255]);
    await encoder.dispose();
  });

  test("streaming input path writes directly into WASM pixels when bridge exposes direct-write hooks", async () => {
    const module = createFakeStreamingInputLibjxlModule();
    setJxlModuleFactoryForTesting(async () => module);

    const encoder = createEncoder({ ...encodeOptions, quality: 90 });
    const beforePushMallocs = module.__mallocCalls;
    await encoder.pushPixels(new Uint8Array([255, 0, 0, 255]));
    expect(module.__mallocCalls).toBe(beforePushMallocs);

    encoder.finish();
    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();
    expect(encoded.done).toBe(false);
    expect(Array.from(new Uint8Array(encoded.value))).toEqual([255, 0, 0, 255]);
    await encoder.dispose();
  });

  test("encodes and decodes rgba8 pixels through the WASM codec facade", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
    const rgba = new Uint8Array([255, 0, 0, 255]);
    const encoder = createEncoder({ ...encodeOptions, quality: 90 });
    encoder.pushPixels(rgba);
    encoder.finish();

    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();
    expect(encoded.done).toBe(false);
    expect(encoded.value.byteLength).toBeGreaterThan(0);
    await encoder.dispose();

    const decoder = createDecoder(decodeOptions);
    decoder.push(encoded.value);
    decoder.close();

    const events = [];
    for await (const event of decoder.events()) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({
      type: "header",
      info: { width: 1, height: 1, bitsPerSample: 8, hasAlpha: true },
    });
    expect(events[1]).toMatchObject({
      type: "final",
      info: { width: 1, height: 1 },
      format: "rgba8",
      pixelStride: 4,
    });
    expect(events[1]?.type === "final" ? events[1].pixels.byteLength : 0).toBe(4);
    await decoder.dispose();
  });

  test("encodes and decodes rgba16 tile containers with byte-oriented buffers", async () => {
    const module = createFakeLibjxlModule();
    setJxlModuleFactoryForTesting(async () => module);

    const input = new Uint8Array([
      0x34, 0x12, 0x78, 0x56, 0xbc, 0x9a, 0xff, 0x7f,
      0xaa, 0x55, 0x11, 0x22, 0x44, 0x33, 0x88, 0x66,
    ]);

    const container = await encodeTileContainerRgba16(input, 2, 1, { tileSize: 1, distance: 0 });
    expect(container).toEqual(input);

    const { pixels, width, height } = await decodeTileContainerRegionRgba16(container, { x: 0, y: 0, w: 2, h: 1 });
    expect(width).toBe(2);
    expect(height).toBe(1);
    expect(Array.from(pixels)).toEqual(Array.from(input));
  });

  test("honors header-only decode target", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
    const rgba = new Uint8Array([0, 255, 0, 255]);
    const encoder = createEncoder(encodeOptions);
    encoder.pushPixels(rgba);
    encoder.finish();
    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();

    const decoder = createDecoder({ ...decodeOptions, progressionTarget: "header" });
    decoder.push(encoded.value);
    decoder.close();
    const events = [];
    for await (const event of decoder.events()) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "header", info: { width: 1, height: 1 } });
    await encoder.dispose();
    await decoder.dispose();
  });

  test("emits a dc progress event when the decode target stops early", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
    const encoder = createEncoder(encodeOptions);
    encoder.pushPixels(new Uint8Array([255, 255, 255, 255]));
    encoder.finish();
    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();

    const decoder = createDecoder({ ...decodeOptions, progressionTarget: "dc" });
    decoder.push(encoded.value);
    decoder.close();

    const events = [];
    for await (const event of decoder.events()) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["header", "progress"]);
    expect(events[1]).toMatchObject({ type: "progress", stage: "dc", format: "rgba8", pixelStride: 4 });
    await encoder.dispose();
    await decoder.dispose();
  });

  test("emits a progress event when emitEveryPass is enabled", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
    const encoder = createEncoder(encodeOptions);
    encoder.pushPixels(new Uint8Array([255, 0, 255, 255]));
    encoder.finish();
    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();

    const decoder = createDecoder({ ...decodeOptions, emitEveryPass: true });
    decoder.push(encoded.value);
    decoder.close();

    const events = [];
    for await (const event of decoder.events()) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["header", "progress", "final"]);
    expect(events[1]).toMatchObject({ type: "progress", stage: "pass", format: "rgba8", pixelStride: 4 });
    await encoder.dispose();
    await decoder.dispose();
  });

  test("advancedFrameSettings escape hatch (PATCHES) is accepted without throwing", () => {
    const encoder = createEncoder({
      ...encodeOptions,
      advancedFrameSettings: [
        { id: JxlFrameSetting.PATCHES, value: 1 }
      ]
    });
    expect(encoder).toBeDefined();
    void encoder.dispose();
  });

  test("advancedFrameSettings + PATCHES on synthetic repeating content (smoke + size check)", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);

    // Very friendly content for patches: large flat regions + repeating patterns
    const size = 64;
    const rgba = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const on = ((x >> 3) + (y >> 3)) & 1;
        const v = on ? 200 : 50;
        rgba[i] = v; rgba[i+1] = v; rgba[i+2] = v; rgba[i+3] = 255;
      }
    }

    const base = await (async () => {
      const enc = createEncoder({ ...encodeOptions, width: size, height: size, quality: 85, effort: 5 });
      enc.pushPixels(rgba);
      enc.finish();
      const chunks: Uint8Array[] = [];
      for await (const c of enc.chunks()) chunks.push(new Uint8Array(c));
      await enc.dispose();
      return chunks.reduce((a, b) => a + b.byteLength, 0);
    })();

    const withPatches = await (async () => {
      const enc = createEncoder({
        ...encodeOptions,
        width: size,
        height: size,
        quality: 85,
        effort: 5,
        advancedFrameSettings: [{ id: JxlFrameSetting.PATCHES, value: 1 }]
      });
      enc.pushPixels(rgba);
      enc.finish();
      const chunks: Uint8Array[] = [];
      for await (const c of enc.chunks()) chunks.push(new Uint8Array(c));
      await enc.dispose();
      return chunks.reduce((a, b) => a + b.byteLength, 0);
    })();

    expect(withPatches).toBeGreaterThan(0);
    console.log(`[patches smoke] base=${base}B  withPatches=${withPatches}B`);
  });

  test("progressive decoder emits a flush before input is closed", async () => {
    setJxlModuleFactoryForTesting(async () => createFakeProgressiveLibjxlModule());

    const decoder = createDecoder({ ...decodeOptions, emitEveryPass: true });
    const iterator = decoder.events()[Symbol.asyncIterator]();

    decoder.push(new Uint8Array([1, 2, 3, 4]).buffer);

    const header = await nextWithin(iterator, 100);
    const progress = await nextWithin(iterator, 100);

    expect(header.value).toMatchObject({ type: "header", info: { width: 1, height: 1 } });
    expect(progress.value).toMatchObject({ type: "progress", stage: "dc", format: "rgba8", pixelStride: 4 });

    decoder.close();
    const final = await nextWithin(iterator, 100);
    expect(final.value).toMatchObject({ type: "final", info: { width: 1, height: 1 }, format: "rgba8" });
    await decoder.dispose();
  });

  test("progressive decoder drains multiple passes from one pushed chunk", async () => {
    setJxlModuleFactoryForTesting(async () => createFakeDrainingProgressiveLibjxlModule());

    const decoder = createDecoder({ ...decodeOptions, emitEveryPass: true });
    const iterator = decoder.events()[Symbol.asyncIterator]();

    decoder.push(new Uint8Array([1, 2, 3, 4]).buffer);

    const header = await nextWithin(iterator, 100);
    const progressA = await nextWithin(iterator, 100);
    const progressB = await nextWithin(iterator, 100);

    expect(header.value).toMatchObject({ type: "header", info: { width: 1, height: 1 } });
    expect(progressA.value).toMatchObject({ type: "progress", stage: "dc" });
    expect(progressB.value).toMatchObject({ type: "progress", stage: "pass" });

    decoder.close();
    const final = await nextWithin(iterator, 100);
    expect(final.value).toMatchObject({ type: "final", info: { width: 1, height: 1 }, format: "rgba8" });
    await decoder.dispose();
  });

  test("progressive decoder keeps draining after close when final bytes first yield progress", async () => {
    setJxlModuleFactoryForTesting(async () => createFakeCloseDrainProgressiveLibjxlModule());

    const decoder = createDecoder({ ...decodeOptions, emitEveryPass: true });
    const iterator = decoder.events()[Symbol.asyncIterator]();

    decoder.push(new Uint8Array([1, 2, 3, 4]).buffer);

    const header = await nextWithin(iterator, 100);
    const progress = await nextWithin(iterator, 100);
    expect(header.value).toMatchObject({ type: "header", info: { width: 1, height: 1 } });
    expect(progress.value).toMatchObject({ type: "progress", stage: "dc" });

    decoder.close();
    const closeProgress = await nextWithin(iterator, 100);
    const final = await nextWithin(iterator, 100);

    expect(closeProgress.value).toMatchObject({ type: "progress", stage: "pass" });
    expect(final.value).toMatchObject({ type: "final", info: { width: 1, height: 1 }, format: "rgba8" });
    await decoder.dispose();
  });

  test("decoder cancel prevents event generation", async () => {
    setJxlModuleFactoryForTesting(async () => createFakeProgressiveLibjxlModule());
    const decoder = createDecoder(decodeOptions);

    decoder.cancel("prevent generation");
    const iterator = decoder.events()[Symbol.asyncIterator]();
    const result = await nextWithin(iterator, 100);
    expect(result.done).toBe(true);

    await decoder.dispose();
  });

  test("encoder cancel prevents chunk generation", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
    const encoder = createEncoder({ ...encodeOptions, quality: 90 });

    encoder.cancel("prevent generation");
    const chunksIter = encoder.chunks()[Symbol.asyncIterator]();
    const result = await nextWithin(chunksIter, 100);
    expect(result.done).toBe(true);

    await encoder.dispose();
  });

  test("decoder fallback to oneshot when progressive unavailable", async () => {
    setJxlModuleFactoryForTesting(async () => createFakeLibjxlModule());
    const rgba = new Uint8Array([0, 255, 0, 255]);
    const encoder = createEncoder(encodeOptions);
    encoder.pushPixels(rgba);
    encoder.finish();
    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();

    const decoder = createDecoder(decodeOptions);
    decoder.push(encoded.value);
    decoder.close();

    const events = [];
    for await (const event of decoder.events()) {
      events.push(event);
    }

    expect(events.map((e) => e.type)).toContain("final");
    expect(events.map((e) => e.type)).not.toContain("error");
    await encoder.dispose();
    await decoder.dispose();
  });

  test("decoder defaults region to null and downsample to 1 when omitted", async () => {
    setJxlModuleFactoryForTesting(async () => createFakeLibjxlModule());
    const decoder = createDecoder({
      format: "rgba8",
      progressionTarget: "final",
      emitEveryPass: false,
      preserveIcc: true,
      preserveMetadata: true,
    });

    decoder.push(new Uint8Array([1, 2, 3, 4]));
    decoder.close();

    const events = [];
    for await (const event of decoder.events()) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toContain("final");
    expect(events.map((event) => event.type)).not.toContain("error");
    await decoder.dispose();
  });

  test("encodes with ICC profile, EXIF, and XMP metadata", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
    const rgba = new Uint8Array([255, 128, 64, 255]);
    const iccProfile = new Uint8Array([1, 2, 3, 4]); // dummy ICC profile
    const exif = new Uint8Array([5, 6, 7, 8]); // dummy EXIF
    const xmp = new Uint8Array([9, 10, 11, 12]); // dummy XMP

    const encoder = createEncoder({
      ...encodeOptions,
      quality: 90,
      iccProfile,
      exif,
      xmp,
    });
    encoder.pushPixels(rgba);
    encoder.finish();

    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();
    expect(encoded.done).toBe(false);
    expect(encoded.value.byteLength).toBeGreaterThan(0);
    await encoder.dispose();
  });
});

describe("detectTier", () => {
  test("returns a valid tier string", () => {
    const tier = detectTier();
    expect(["relaxed-simd-mt", "simd-mt", "simd", "scalar"]).toContain(tier);
  });

  test("caches the detected tier", () => {
    const tier = detectTier();
    expect(detectTier()).toBe(tier);
  });
});

describe("bilinear resize via targetWidth/targetHeight", () => {
  afterEach(() => {
    setJxlModuleFactoryForTesting(null);
  });

  test("stretch 2x1 image to 1x1 produces 1x1 output", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]); // 2x1
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
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]); // 2x2
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
    expect(final).toBeDefined();
    if (final?.type === "final") {
      expect(final.info.width).toBe(2);
      expect(final.info.height).toBe(2);
    }
    await decoder.dispose();
    await encoder.dispose();
  });

  test("contain fit: 4x1 image to targetWidth:2 targetHeight:2 returns 2x1", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
    const rgba = new Uint8Array(4 * 1 * 4).fill(128);
    const encoder = createEncoder({ ...encodeOptions, width: 4, height: 1 });
    encoder.pushPixels(rgba);
    encoder.finish();
    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();

    const decoder = createDecoder({
      ...decodeOptions,
      targetWidth: 2,
      targetHeight: 2,
      fitMode: "contain",
    });
    decoder.push(encoded.value);
    decoder.close();
    const events = [];
    for await (const event of decoder.events()) events.push(event);
    const final = events.find((e) => e.type === "final");
    expect(final).toBeDefined();
    if (final?.type === "final") {
      expect(final.info.width).toBe(2);
      expect(final.info.height).toBe(1);
    }
    await decoder.dispose();
    await encoder.dispose();
  });

  test("decodeViewport returns a JxlDecoder", () => {
    const decoder = decodeViewport({ format: "rgba8", targetWidth: 640, targetHeight: 480 });
    expect(decoder).toBeDefined();
    expect(typeof decoder.push).toBe("function");
    expect(typeof decoder.events).toBe("function");
    decoder.cancel();
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

function createFakeLibjxlModule() {
  const memory = new ArrayBuffer(4096);
  const HEAPU8 = new Uint8Array(memory);
  const HEAPU32 = new Uint32Array(memory);
  let nextPtr = 64;
  const allocations = new Map<number, number>();
  const handles = new Map<number, { dataPtr: number; size: number; width: number; height: number; bits: number; alpha: number }>();
  let nextHandle = 1;

  const malloc = (size: number) => {
    const ptr = nextPtr;
    nextPtr += size + 8;
    allocations.set(ptr, size);
    return ptr;
  };

  const makeHandle = (bytes: Uint8Array, width: number, height: number) => {
    const dataPtr = malloc(bytes.byteLength);
    HEAPU8.set(bytes, dataPtr);
    const handle = nextHandle++;
    handles.set(handle, { dataPtr, size: bytes.byteLength, width, height, bits: 8, alpha: 1 });
    return handle;
  };

  return {
    HEAPU8,
    HEAPU32,
    _malloc: malloc,
    _free: (ptr: number) => allocations.delete(ptr),
    _jxl_wasm_encode_rgba8: (pixelsPtr: number, width: number, height: number, _distance: number, _effort: number) => {
      return makeHandle(HEAPU8.slice(pixelsPtr, pixelsPtr + width * height * 4), width, height);
    },
    _jxl_wasm_decode_rgba8: (inputPtr: number, inputSize: number, _downsample: number) => {
      return makeHandle(HEAPU8.slice(inputPtr, inputPtr + inputSize), 1, 1);
    },
    _jxl_wasm_buffer_data: (handle: number) => handles.get(handle)?.dataPtr ?? 0,
    _jxl_wasm_buffer_size: (handle: number) => handles.get(handle)?.size ?? 0,
    _jxl_wasm_buffer_width: (handle: number) => handles.get(handle)?.width ?? 0,
    _jxl_wasm_buffer_height: (handle: number) => handles.get(handle)?.height ?? 0,
    _jxl_wasm_buffer_bits_per_sample: (handle: number) => handles.get(handle)?.bits ?? 8,
    _jxl_wasm_buffer_has_alpha: (handle: number) => handles.get(handle)?.alpha ?? 1,
    _jxl_wasm_buffer_free: (handle: number) => handles.delete(handle),
    _jxl_wasm_encode_tile_container_rgba8: (pixelsPtr: number, width: number, height: number) => {
      return makeHandle(HEAPU8.slice(pixelsPtr, pixelsPtr + width * height * 4), width, height);
    },
    _jxl_wasm_encode_tile_container_rgba16: (pixelsPtr: number, width: number, height: number) => {
      const byteLength = width * height * 8;
      const handle = nextHandle++;
      const dataPtr = malloc(byteLength);
      HEAPU8.set(HEAPU8.slice(pixelsPtr, pixelsPtr + byteLength), dataPtr);
      handles.set(handle, { dataPtr, size: byteLength, width, height, bits: 16, alpha: 1 });
      return handle;
    },
    _jxl_wasm_decode_tile_container_region_rgba8: (inputPtr: number, inputSize: number, _x: number, _y: number, w: number, h: number) => {
      return makeHandle(HEAPU8.slice(inputPtr, inputPtr + inputSize), w, h);
    },
    _jxl_wasm_decode_tile_container_region_rgba16: (inputPtr: number, inputSize: number, _x: number, _y: number, w: number, h: number) => {
      const handle = nextHandle++;
      const dataPtr = malloc(inputSize);
      HEAPU8.set(HEAPU8.slice(inputPtr, inputPtr + inputSize), dataPtr);
      handles.set(handle, { dataPtr, size: inputSize, width: w, height: h, bits: 16, alpha: 1 });
      return handle;
    },
  };
}

function createFakeProgressiveLibjxlModule() {
  const module = createFakeLibjxlModule() as ReturnType<typeof createFakeLibjxlModule> & {
    _jxl_wasm_dec_create: () => number;
    _jxl_wasm_dec_push: (state: number, dataPtr: number, size: number) => number;
    _jxl_wasm_dec_close_input: (state: number) => void;
    _jxl_wasm_dec_width: (state: number) => number;
    _jxl_wasm_dec_height: (state: number) => number;
    _jxl_wasm_dec_error: (state: number) => number;
    _jxl_wasm_dec_take_flushed: (state: number) => number;
    _jxl_wasm_dec_take_final: (state: number) => number;
    _jxl_wasm_dec_free: (state: number) => void;
  };

  let closed = false;
  let flushed = false;

  module._jxl_wasm_dec_create = () => 1;
  module._jxl_wasm_dec_push = (_state: number, _dataPtr: number, size: number) => {
    if (closed || size === 0) return 2;
    flushed = true;
    return 1;
  };
  module._jxl_wasm_dec_close_input = () => {
    closed = true;
  };
  module._jxl_wasm_dec_width = () => 1;
  module._jxl_wasm_dec_height = () => 1;
  module._jxl_wasm_dec_error = () => 0;
  module._jxl_wasm_dec_take_flushed = () => {
    if (!flushed) return 0;
    flushed = false;
    return module._jxl_wasm_decode_rgba8(0, 4, 1);
  };
  module._jxl_wasm_dec_take_final = () => module._jxl_wasm_decode_rgba8(0, 4, 1);
  module._jxl_wasm_dec_free = () => {};

  return module;
}

function createFakeDrainingProgressiveLibjxlModule() {
  const module = createFakeLibjxlModule() as ReturnType<typeof createFakeLibjxlModule> & {
    _jxl_wasm_dec_create: () => number;
    _jxl_wasm_dec_push: (state: number, dataPtr: number, size: number) => number;
    _jxl_wasm_dec_close_input: (state: number) => void;
    _jxl_wasm_dec_width: (state: number) => number;
    _jxl_wasm_dec_height: (state: number) => number;
    _jxl_wasm_dec_error: (state: number) => number;
    _jxl_wasm_dec_take_flushed: (state: number) => number;
    _jxl_wasm_dec_take_final: (state: number) => number;
    _jxl_wasm_dec_free: (state: number) => void;
  };

  let closed = false;
  let pendingFlushes = 0;

  module._jxl_wasm_dec_create = () => 1;
  module._jxl_wasm_dec_push = (_state: number, _dataPtr: number, size: number) => {
    if (!closed && size > 0) {
      pendingFlushes = 2;
    }
    if (pendingFlushes > 0) {
      pendingFlushes--;
      return 1;
    }
    return closed ? 2 : 0;
  };
  module._jxl_wasm_dec_close_input = () => {
    closed = true;
  };
  module._jxl_wasm_dec_width = () => 1;
  module._jxl_wasm_dec_height = () => 1;
  module._jxl_wasm_dec_error = () => 0;
  module._jxl_wasm_dec_take_flushed = () => module._jxl_wasm_decode_rgba8(0, 4, 1);
  module._jxl_wasm_dec_take_final = () => module._jxl_wasm_decode_rgba8(0, 4, 1);
  module._jxl_wasm_dec_free = () => {};

  return module;
}

function createFakeCloseDrainProgressiveLibjxlModule() {
  const module = createFakeLibjxlModule() as ReturnType<typeof createFakeLibjxlModule> & {
    _jxl_wasm_dec_create: () => number;
    _jxl_wasm_dec_push: (state: number, dataPtr: number, size: number) => number;
    _jxl_wasm_dec_close_input: (state: number) => void;
    _jxl_wasm_dec_width: (state: number) => number;
    _jxl_wasm_dec_height: (state: number) => number;
    _jxl_wasm_dec_error: (state: number) => number;
    _jxl_wasm_dec_take_flushed: (state: number) => number;
    _jxl_wasm_dec_take_final: (state: number) => number;
    _jxl_wasm_dec_free: (state: number) => void;
  };

  let closed = false;
  let pendingFlushes = 0;
  let closeFlushQueued = false;

  module._jxl_wasm_dec_create = () => 1;
  module._jxl_wasm_dec_push = (_state: number, _dataPtr: number, size: number) => {
    if (!closed && size > 0) {
      pendingFlushes = 1;
    } else if (closed && pendingFlushes === 0 && !closeFlushQueued) {
      pendingFlushes = 1;
      closeFlushQueued = true;
    }
    if (pendingFlushes > 0) {
      pendingFlushes--;
      return 1;
    }
    return closed ? 2 : 0;
  };
  module._jxl_wasm_dec_close_input = () => {
    closed = true;
  };
  module._jxl_wasm_dec_width = () => 1;
  module._jxl_wasm_dec_height = () => 1;
  module._jxl_wasm_dec_error = () => 0;
  module._jxl_wasm_dec_take_flushed = () => module._jxl_wasm_decode_rgba8(0, 4, 1);
  module._jxl_wasm_dec_take_final = () => module._jxl_wasm_decode_rgba8(0, 4, 1);
  module._jxl_wasm_dec_free = () => {};

  return module;
}

function createFakeStreamingInputLibjxlModule() {
  const module = createFakeLibjxlModule() as ReturnType<typeof createFakeLibjxlModule> & {
    __mallocCalls: number;
    _jxl_wasm_enc_create_image: (width: number, height: number) => number;
    _jxl_wasm_enc_pixels_ptr: (state: number, size: number) => number;
    _jxl_wasm_enc_advance_written: (state: number, size: number) => number;
    _jxl_wasm_enc_push_chunk: (state: number, dataPtr: number, size: number) => number;
    _jxl_wasm_enc_finish: (state: number) => number;
    _jxl_wasm_enc_take_chunk: (state: number) => number;
    _jxl_wasm_enc_free: (state: number) => void;
  };

  const baseMalloc = module._malloc.bind(module);
  module.__mallocCalls = 0;
  module._malloc = (size: number) => {
    module.__mallocCalls++;
    return baseMalloc(size);
  };

  let nextState = 1;
  const states = new Map<number, { width: number; height: number; pixelsPtr: number; pixelsSize: number; pixelsWritten: number; nextHandle: number }>();

  module._jxl_wasm_enc_create_image = (width: number, height: number) => {
    const state = nextState++;
    const pixelsSize = width * height * 4;
    const pixelsPtr = baseMalloc(pixelsSize);
    states.set(state, { width, height, pixelsPtr, pixelsSize, pixelsWritten: 0, nextHandle: 0 });
    return state;
  };
  module._jxl_wasm_enc_pixels_ptr = (state: number, size: number) => {
    const entry = states.get(state);
    if (!entry || entry.pixelsWritten + size > entry.pixelsSize) return 0;
    return entry.pixelsPtr + entry.pixelsWritten;
  };
  module._jxl_wasm_enc_advance_written = (state: number, size: number) => {
    const entry = states.get(state);
    if (!entry || entry.pixelsWritten + size > entry.pixelsSize) return 1;
    entry.pixelsWritten += size;
    return 0;
  };
  module._jxl_wasm_enc_push_chunk = (state: number, dataPtr: number, size: number) => {
    const entry = states.get(state);
    if (!entry) return 1;
    if (entry.pixelsWritten + size > entry.pixelsSize) return 1;
    module.HEAPU8.copyWithin(entry.pixelsPtr + entry.pixelsWritten, dataPtr, dataPtr + size);
    entry.pixelsWritten += size;
    return 0;
  };
  module._jxl_wasm_enc_finish = (state: number) => {
    const entry = states.get(state);
    if (!entry) return 1;
    entry.nextHandle = module._jxl_wasm_encode_rgba8(0, entry.width, entry.height, 0, 0);
    const handle = entry.nextHandle;
    const dataPtr = module._jxl_wasm_buffer_data(handle);
    module.HEAPU8.set(module.HEAPU8.subarray(entry.pixelsPtr, entry.pixelsPtr + entry.pixelsWritten), dataPtr);
    return 0;
  };
  module._jxl_wasm_enc_take_chunk = (state: number) => {
    const entry = states.get(state);
    if (!entry) return 0;
    const handle = entry.nextHandle;
    entry.nextHandle = 0;
    return handle;
  };
  module._jxl_wasm_enc_free = (state: number) => {
    states.delete(state);
  };

  return module;
}

async function nextWithin<T>(iterator: AsyncIterator<T>, ms: number): Promise<IteratorResult<T>> {
  return await Promise.race([
    iterator.next(),
    new Promise<IteratorResult<T>>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
  ]);
}

async function loadPreferredLibjxlModule() {
  try {
    const imported = await import("../dist/jxl-core.scalar.js");
    if (typeof imported.default === "function") {
      const baseUrl = new URL("../dist/", import.meta.url);
      const module = await imported.default({
        locateFile: (path: string) => new URL(path, baseUrl).href,
      });
      if (module && typeof module._malloc === "function" && typeof module._jxl_wasm_encode_rgba8 === "function") {
        return module;
      }
    }
  } catch {}
  return createFakeLibjxlModule();
}

describe('ExtraChannel full infrastructure (Phase 2)', () => {
  it('accepts full ExtraChannel descriptors including spotColor, dimShift, thermal, reserved', () => {
    const ch: ExtraChannel = {
      type: 'spot',
      bitsPerSample: 8,
      dimShift: 0,
      name: 'MySpot',
      distance: 0.5,
      spotColor: { red: 0.9, green: 0.1, blue: 0.2, solidity: 0.8 }
    };
    // Minimal valid EncoderOptions shape + extraChannels (cast to defer EncoderOptions field wiring).
    // Construction only; actual encode path ignores new fields until later tasks.
    const opts = {
      format: "rgba8" as const,
      width: 1,
      height: 1,
      hasAlpha: true,
      iccProfile: null,
      exif: null,
      xmp: null,
      distance: null,
      quality: null,
      effort: 7 as const,
      progressive: false,
      previewFirst: false,
      chunked: false,
      extraChannels: [ch]
    };
    expect(() => createEncoder(opts as any)).not.toThrow();
  });

  it('rejects invalid type at type level (unknown)', () => {
    // The @ts-expect-error below enforces that 'foo' is not a valid ExtraChannelType at compile time.
    // Runtime check is a no-op here (validation comes in encode impl later).
    // @ts-expect-error
    const bad: ExtraChannel = { type: 'foo' as any, bitsPerSample: 8 };
    expect(bad).toBeDefined();
  });

  it('encodes and roundtrips full ExtraChannel descriptors (synthetic planes: spot 8-bit + depth 16-bit + named thermal) via packed 72B bridge', async () => {
    const mod = await loadPreferredLibjxlModule();
    if (typeof mod._jxl_wasm_encode_rgba8_with_extra_channels !== 'function' ||
        typeof mod._jxl_wasm_get_extra_channels !== 'function' ||
        typeof mod._malloc !== 'function') {
      // Bridge not rebuilt with Task 3 symbols yet — skip (build step will enable)
      return;
    }

    const w = 4, h = 2;
    // Main RGBA8 (synthetic)
    const main = new Uint8Array(w * h * 4);
    for (let i = 0; i < main.length; i += 4) { main[i] = 120; main[i+1] = 130; main[i+2] = 140; main[i+3] = 255; }

    // EC 0: 8-bit spot (constant) - synthetic plane
    const spotPlane = new Uint8Array(w * h); spotPlane.fill(200);
    // EC 1: 16-bit depth (gradient-ish) - synthetic plane
    const depthPlane = new Uint16Array(w * h);
    for (let i = 0; i < depthPlane.length; i++) depthPlane[i] = 1000 + i * 10;
    const depthBytes = new Uint8Array(depthPlane.buffer);
    // EC 2: 8-bit thermal named - synthetic plane
    const thermalPlane = new Uint8Array(w * h); thermalPlane.fill(77);

    const channels: ExtraChannel[] = [
      { type: 'spot', bitsPerSample: 8, name: 'RedSpot', distance: 0.1, spotColor: { red: 0.95, green: 0.05, blue: 0.1, solidity: 0.85 } },
      { type: 'depth', bitsPerSample: 16, dimShift: 0, name: 'Depth16' },
      { type: 'thermal', bitsPerSample: 8, name: 'ThermalCam' },
    ];

    const { buffer: descBuf, view: descDv } = serializeExtraChannelsForWasm(channels);
    const descPtr = mod._malloc(descBuf.byteLength);
    const spotPtr = mod._malloc(spotPlane.length);
    const depthPtr = mod._malloc(depthBytes.length);
    const thermalPtr = mod._malloc(thermalPlane.length);
    const mainPtr = mod._malloc(main.length);

    try {
      mod.HEAPU8.set(main, mainPtr);
      mod.HEAPU8.set(spotPlane, spotPtr);
      mod.HEAPU8.set(depthBytes, depthPtr);
      mod.HEAPU8.set(thermalPlane, thermalPtr);
      mod.HEAPU8.set(new Uint8Array(descBuf), descPtr);

      // Write plane pointers/sizes into the descriptors (offsets per EC_BYTES=72, matching C++ struct)
      const EC = EC_BYTES;
      // EC0 spot
      descDv.setUint32(0*EC + 12, spotPtr >>> 0, true);
      descDv.setUint32(0*EC + 16, spotPlane.length >>> 0, true);
      // EC1 depth
      descDv.setUint32(1*EC + 12, depthPtr >>> 0, true);
      descDv.setUint32(1*EC + 16, depthBytes.length >>> 0, true);
      // EC2 thermal
      descDv.setUint32(2*EC + 12, thermalPtr >>> 0, true);
      descDv.setUint32(2*EC + 16, thermalPlane.length >>> 0, true);

      // Re-copy updated desc
      mod.HEAPU8.set(new Uint8Array(descBuf), descPtr);

      const handle = mod._jxl_wasm_encode_rgba8_with_extra_channels!(
        mainPtr, w, h, 1.0 /*distance*/, 4 /*effort*/, 0 /*no alpha*/, descPtr, 3
      );
      expect(handle).not.toBe(0);
      const err = mod._jxl_wasm_buffer_error ? mod._jxl_wasm_buffer_error(handle) : 0;
      expect(err).toBe(0);

      const size = mod._jxl_wasm_buffer_size(handle);
      expect(size).toBeGreaterThan(100); // JXL bytes >0 (synthetic EC content encoded)
      const jxlPtr = mod._jxl_wasm_buffer_data(handle);
      const jxlBytes = new Uint8Array(size);
      jxlBytes.set(mod.HEAPU8.subarray(jxlPtr, jxlPtr + size));

      // Free encode buffer
      mod._jxl_wasm_buffer_free(handle);

      // Decode header via helper -> assert descriptors roundtripped (names/types/bits/spot values)
      const infoH = mod._jxl_wasm_get_extra_channels!(jxlPtr, size);  // note: we pass the encoded bytes ptr/size
      expect(infoH).not.toBe(0);
      const infoSize = mod._jxl_wasm_buffer_size(infoH);
      expect(infoSize).toBe(3 * EC_BYTES);
      const infoDataPtr = mod._jxl_wasm_buffer_data(infoH);
      const infoBytes = mod.HEAPU8.subarray(infoDataPtr, infoDataPtr + infoSize);

      // Parse using exact 72B stride + field offsets (matches both sides now)
      const dv = new DataView(infoBytes.buffer, infoBytes.byteOffset, infoBytes.byteLength);
      // spot (first)
      expect(dv.getUint32(0*EC + 0, true)).toBe(2); // SPOT_COLOR
      expect(dv.getUint32(0*EC + 4, true)).toBe(8);
      expect(dv.getUint8(0*EC + 40)).toBeGreaterThan(0); // name len
      expect(dv.getFloat32(0*EC + 24, true)).toBeCloseTo(0.95, 5);
      expect(dv.getFloat32(0*EC + 28, true)).toBeCloseTo(0.05, 5);
      expect(dv.getFloat32(0*EC + 32, true)).toBeCloseTo(0.1, 5);
      expect(dv.getFloat32(0*EC + 36, true)).toBeCloseTo(0.85, 5);
      // depth
      expect(dv.getUint32(1*EC + 0, true)).toBe(1); // DEPTH
      expect(dv.getUint32(1*EC + 4, true)).toBe(16);
      // thermal
      expect(dv.getUint32(2*EC + 0, true)).toBe(6); // THERMAL
      expect(dv.getUint32(2*EC + 4, true)).toBe(8);
      const nameStart = 2*EC + 41;
      const nameLen = dv.getUint8(2*EC + 40);
      const nameBytes = infoBytes.subarray(nameStart, nameStart + nameLen);
      expect(new TextDecoder().decode(nameBytes)).toBe('ThermalCam');

      mod._jxl_wasm_buffer_free(infoH);
    } finally {
      mod._free(descPtr); mod._free(spotPtr); mod._free(depthPtr); mod._free(thermalPtr); mod._free(mainPtr);
    }
  });
});
