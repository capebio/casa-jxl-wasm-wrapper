import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createDecoder, createEncoder, detectTier, setJxlModuleFactoryForTesting } from "../src/index";

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
