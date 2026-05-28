import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createDecoder,
  createEncoder,
  detectTier,
  setJxlModuleFactoryForTesting,
  normalizedToPixelExtent,
  pixelToNormalizedExtent,
  getWrapperCapabilities,
  getDecodeGridInfo,
  decodeViewport,
} from "../src/index";

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

  test("forwards photonNoiseIso into the extended WASM encode bridge", async () => {
    const module = createFakeLibjxlModule() as ReturnType<typeof createFakeLibjxlModule> & {
      __encodeArgs?: number[];
      _jxl_wasm_encode_rgba8_x: (...args: number[]) => number;
    };
    module._jxl_wasm_encode_rgba8_x = (...args: number[]) => {
      module.__encodeArgs = args;
      return module._jxl_wasm_encode_rgba8(args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, args[5]!, args[6]!, args[7]!, args[8]!, args[9]!, args[14]!);
    };
    setJxlModuleFactoryForTesting(async () => module);

    const encoder = createEncoder({ ...encodeOptions, quality: 90, photonNoiseIso: 1600 });
    await encoder.pushPixels(new Uint8Array([255, 255, 255, 255]));
    await encoder.finish();
    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();

    expect(encoded.done).toBe(false);
    expect(module.__encodeArgs?.[13]).toBe(1600);
    await encoder.dispose();
  });

  test("bridge and native encoders set the libjxl photon noise frame option", () => {
    const bridge = readFileSync(new URL("../src/bridge.cpp", import.meta.url), "utf8");
    const native = readFileSync(new URL("../../jxl-native/src/native.cc", import.meta.url), "utf8");

    expect(bridge).toContain("JXL_ENC_FRAME_SETTING_PHOTON_NOISE");
    expect(native).toContain("JXL_ENC_FRAME_SETTING_PHOTON_NOISE");
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

  test("returns scalar in Node/Bun (no cross-origin isolation)", () => {
    const tier = detectTier();
    expect(tier).toBe("scalar");
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

describe("resampling encoder option", () => {
  afterEach(() => {
    setJxlModuleFactoryForTesting(null);
  });

  function makeModuleCapturingEncodeArgs() {
    const base = createFakeLibjxlModule();
    const calls: number[][] = [];
    const module = {
      ...base,
      _jxl_wasm_encode_rgba8: (...args: number[]) => {
        calls.push(args);
        return base._jxl_wasm_encode_rgba8(args[0], args[1], args[2], args[3], args[4]);
      },
    };
    return { module, calls };
  }

  test("resampling:4 forwards as 11th arg to encode bridge (index 10)", async () => {
    const { module, calls } = makeModuleCapturingEncodeArgs();
    setJxlModuleFactoryForTesting(async () => module as never);
    const encoder = createEncoder({ ...encodeOptions, resampling: 4 });
    encoder.pushPixels(new Uint8Array(4));
    encoder.finish();
    for await (const _ of encoder.chunks()) { /* drain */ }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][10]).toBe(4);
  });

  test("invalid resampling resolves to 1", async () => {
    const { module, calls } = makeModuleCapturingEncodeArgs();
    setJxlModuleFactoryForTesting(async () => module as never);
    const encoder = createEncoder({ ...encodeOptions, resampling: 3 });
    encoder.pushPixels(new Uint8Array(4));
    encoder.finish();
    for await (const _ of encoder.chunks()) { /* drain */ }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][10]).toBe(1);
  });
});

describe("decodingSpeed encoder option", () => {
  afterEach(() => {
    setJxlModuleFactoryForTesting(null);
  });

  function makeModuleCapturingXArgs() {
    const base = createFakeLibjxlModule();
    const calls: number[][] = [];
    const module = {
      ...base,
      _jxl_wasm_encode_rgba8_x: (...args: number[]) => {
        calls.push(args);
        return base._jxl_wasm_encode_rgba8(args[0], args[1], args[2], args[3], args[4]);
      },
    };
    return { module, calls };
  }

  test("decodingSpeed:2 forwards as 13th arg to _x bridge (index 12)", async () => {
    const { module, calls } = makeModuleCapturingXArgs();
    setJxlModuleFactoryForTesting(async () => module as never);
    const encoder = createEncoder({ ...encodeOptions, quality: 90, decodingSpeed: 2 });
    encoder.pushPixels(new Uint8Array(4));
    encoder.finish();
    for await (const _ of encoder.chunks()) { /* drain */ }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][12]).toBe(2);
    await encoder.dispose();
  });

  test("decodingSpeed omitted resolves to -1", async () => {
    const { module, calls } = makeModuleCapturingXArgs();
    setJxlModuleFactoryForTesting(async () => module as never);
    const encoder = createEncoder({ ...encodeOptions, quality: 90 });
    encoder.pushPixels(new Uint8Array(4));
    encoder.finish();
    for await (const _ of encoder.chunks()) { /* drain */ }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][12]).toBe(-1);
    await encoder.dispose();
  });

  test("decodingSpeed:0 resolves to 0 (explicit minimum tier)", async () => {
    const { module, calls } = makeModuleCapturingXArgs();
    setJxlModuleFactoryForTesting(async () => module as never);
    const encoder = createEncoder({ ...encodeOptions, quality: 90, decodingSpeed: 0 });
    encoder.pushPixels(new Uint8Array(4));
    encoder.finish();
    for await (const _ of encoder.chunks()) { /* drain */ }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][12]).toBe(0);
    await encoder.dispose();
  });

  test("decodingSpeed:5 clamps to 4", async () => {
    const { module, calls } = makeModuleCapturingXArgs();
    setJxlModuleFactoryForTesting(async () => module as never);
    const encoder = createEncoder({ ...encodeOptions, quality: 90, decodingSpeed: 5 });
    encoder.pushPixels(new Uint8Array(4));
    encoder.finish();
    for await (const _ of encoder.chunks()) { /* drain */ }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][12]).toBe(4);
    await encoder.dispose();
  });

  test("decodingSpeed:-1 clamps to 0", async () => {
    const { module, calls } = makeModuleCapturingXArgs();
    setJxlModuleFactoryForTesting(async () => module as never);
    const encoder = createEncoder({ ...encodeOptions, quality: 90, decodingSpeed: -1 });
    encoder.pushPixels(new Uint8Array(4));
    encoder.finish();
    for await (const _ of encoder.chunks()) { /* drain */ }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][12]).toBe(0);
    await encoder.dispose();
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
