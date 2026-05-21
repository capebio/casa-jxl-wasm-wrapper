export type PixelFormat = "rgba8" | "rgba16" | "rgbaf32";
export type DecodeStage = "header" | "dc" | "pass" | "final";
export type Region = { x: number; y: number; w: number; h: number };

export interface ImageInfo {
  width: number;
  height: number;
  bitsPerSample: 8 | 16 | 32;
  hasAlpha: boolean;
  hasAnimation: boolean;
  jpegReconstructionAvailable: boolean;
}

export type DecodeEvent =
  | { type: "header"; info: ImageInfo }
  | {
      type: "progress";
      stage: DecodeStage;
      info: ImageInfo;
      pixels: ArrayBuffer | Uint8Array;
      format: PixelFormat;
      region?: Region;
      pixelStride: number;
    }
  | {
      type: "final";
      info: ImageInfo;
      pixels: ArrayBuffer | Uint8Array;
      format: PixelFormat;
      region?: Region;
      pixelStride: number;
    }
  | {
      type: "budget_exceeded";
      stage: DecodeStage;
      info: ImageInfo;
      pixels: ArrayBuffer | Uint8Array;
      format: PixelFormat;
      pixelStride: number;
    }
  | {
      type: "error";
      code: string;
      message: string;
      partialPixels?: ArrayBuffer | Uint8Array;
      partialInfo?: ImageInfo;
    };

export interface DecoderOptions {
  format: PixelFormat;
  region: Region | null;
  downsample: 1 | 2 | 4 | 8;
  progressionTarget: "header" | "dc" | "pass" | "final";
  emitEveryPass: boolean;
  preserveIcc: boolean;
  preserveMetadata: boolean;
}

export interface EncoderOptions {
  format: PixelFormat;
  width: number;
  height: number;
  hasAlpha: boolean;
  iccProfile: ArrayBuffer | null;
  exif: ArrayBuffer | null;
  xmp: ArrayBuffer | null;
  distance: number | null;
  quality: number | null;
  effort: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  progressive: boolean;
  previewFirst: boolean;
  chunked: boolean;
}

export interface JxlDecoder {
  push(chunk: ArrayBuffer | Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
  events(): AsyncIterable<DecodeEvent>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface JxlEncoder {
  pushPixels(chunk: ArrayBuffer | Uint8Array, region?: Region): void | Promise<void>;
  finish(): void | Promise<void>;
  chunks(): AsyncIterable<ArrayBuffer | Uint8Array>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

interface LibjxlBuffer {
  handle: number;
  data: Uint8Array;
  width: number;
  height: number;
  bitsPerSample: 8 | 16 | 32;
  hasAlpha: boolean;
}

interface LibjxlWasmModule {
  HEAPU8: Uint8Array;
  HEAPU32?: Uint32Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _jxl_wasm_decode_rgba8(inputPtr: number, inputSize: number, downsample: number): number;
  _jxl_wasm_decode_rgba16?(inputPtr: number, inputSize: number, downsample: number): number;
  _jxl_wasm_decode_rgbaf32?(inputPtr: number, inputSize: number, downsample: number): number;
  _jxl_wasm_encode_rgba8(pixelsPtr: number, width: number, height: number, distance: number, effort: number): number;
  _jxl_wasm_encode_rgba16?(pixelsPtr: number, width: number, height: number, distance: number, effort: number): number;
  _jxl_wasm_encode_rgbaf32?(pixelsPtr: number, width: number, height: number, distance: number, effort: number): number;
  _jxl_wasm_buffer_data(handle: number): number;
  _jxl_wasm_buffer_size(handle: number): number;
  _jxl_wasm_buffer_width(handle: number): number;
  _jxl_wasm_buffer_height(handle: number): number;
  _jxl_wasm_buffer_bits_per_sample(handle: number): number;
  _jxl_wasm_buffer_has_alpha(handle: number): number;
  _jxl_wasm_buffer_error?(handle: number): number;
  _jxl_wasm_buffer_free(handle: number): void;
  // Stateful progressive decoder (present after WASM rebuild with new bridge)
  _jxl_wasm_dec_create?(format: number): number;
  _jxl_wasm_dec_push?(state: number, dataPtr: number, size: number): number;
  _jxl_wasm_dec_close_input?(state: number): void;
  _jxl_wasm_dec_width?(state: number): number;
  _jxl_wasm_dec_height?(state: number): number;
  _jxl_wasm_dec_error?(state: number): number;
  _jxl_wasm_dec_take_flushed?(state: number): number;
  _jxl_wasm_dec_take_final?(state: number): number;
  _jxl_wasm_dec_free?(state: number): void;
}

type JxlModuleFactory = () => Promise<LibjxlWasmModule>;

export class CapabilityMissing extends Error {
  readonly code = "CapabilityMissing";
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CapabilityMissing";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

let modulePromise: Promise<LibjxlWasmModule> | undefined;
let testModuleFactory: JxlModuleFactory | null = null;

export function setJxlModuleFactoryForTesting(factory: JxlModuleFactory | null): void {
  testModuleFactory = factory;
  modulePromise = undefined;
}

export function createDecoder(options: DecoderOptions): JxlDecoder {
  return new LibjxlDecoder(options);
}

export function createEncoder(options: EncoderOptions): JxlEncoder {
  return new LibjxlEncoder(options);
}

class LibjxlDecoder implements JxlDecoder {
  // null sentinel = input closed
  private chunkQueue: Array<Uint8Array | null> = [];
  private wakeResolve: (() => void) | null = null;
  private cancelled = false;

  constructor(private readonly options: DecoderOptions) {}

  push(chunk: ArrayBuffer | Uint8Array): void {
    if (this.cancelled) return;
    this.chunkQueue.push(toUint8Array(chunk).slice());
    this.wakeResolve?.();
    this.wakeResolve = null;
  }

  close(): void {
    if (this.cancelled) return;
    this.chunkQueue.push(null);
    this.wakeResolve?.();
    this.wakeResolve = null;
  }

  private waitForQueueItem(): Promise<void> {
    if (this.chunkQueue.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => { this.wakeResolve = resolve; });
  }

  async *events(): AsyncIterable<DecodeEvent> {
    try {
      if (this.cancelled) return;
      const module = await loadLibjxlModule();
      if (this.options.format !== "rgba8") {
        const decFn = this.options.format === "rgba16" ? "_jxl_wasm_decode_rgba16" : "_jxl_wasm_decode_rgbaf32";
        if (typeof module[decFn] !== "function") {
          throw new CapabilityMissing(`${this.options.format} decode requires a rebuilt WASM with multi-format bridge`);
        }
      }
      if (typeof module._jxl_wasm_dec_create === "function") {
        yield* this.eventsProgressive(module);
      } else {
        yield* this.eventsOneShot(module);
      }
    } catch (error) {
      yield {
        type: "error",
        code: error instanceof CapabilityMissing ? error.code : "DecodeFailed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async *eventsProgressive(module: LibjxlWasmModule): AsyncIterable<DecodeEvent> {
    const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : 0;
    const dec = module._jxl_wasm_dec_create!(fmtIndex);
    if (dec === 0) throw new Error("JXL progressive decoder creation failed");
    try {
      let headerEmitted = false;
      let info: ImageInfo | undefined;
      let gotRealFlush = false;
      let done = false;

      const buildInfo = (w: number, h: number): ImageInfo => {
        info ??= { width: w, height: h, bitsPerSample: 8, hasAlpha: true, hasAnimation: false, jpegReconstructionAvailable: false };
        return info;
      };

      const bpc = fmtIndex === 2 ? 4 : fmtIndex === 1 ? 2 : 1;
      const pixelStride = 4 * bpc;
      const fmt = this.options.format;
      const takeAndWrap = (handle: number): { pixels: { data: Uint8Array; width: number; height: number; region?: Region }; evInfo: ImageInfo } | null => {
        if (handle === 0) return null;
        const buf = readBuffer(module, handle, "decode");
        module._jxl_wasm_buffer_free(handle);
        const pixels = applyRegionAndDownsample(buf.data, buf.width, buf.height, this.options.region, this.options.downsample, bpc);
        const evInfo = buildInfo(pixels.width, pixels.height);
        return { pixels, evInfo };
      };

      // Process chunks reactively as they arrive via chunkQueue
      while (!done && !this.cancelled) {
        await this.waitForQueueItem();
        if (this.cancelled) return;

        const item = this.chunkQueue.shift()!;

        if (item === null) {
          // Input closed — flush remaining
          module._jxl_wasm_dec_close_input!(dec);
          const result = module._jxl_wasm_dec_push!(dec, 0, 0);
          done = result === 2;
          break;
        }

        const ptr = module._malloc(item.byteLength);
        module.HEAPU8.set(item, ptr);
        const result = module._jxl_wasm_dec_push!(dec, ptr, item.byteLength);
        module._free(ptr);

        if (result < 0) throw new Error(`JXL decode error: ${module._jxl_wasm_dec_error!(dec)}`);

        const w = module._jxl_wasm_dec_width!(dec);
        const h = module._jxl_wasm_dec_height!(dec);
        if (!headerEmitted && w > 0 && h > 0) {
          headerEmitted = true;
          yield { type: "header", info: buildInfo(w, h) };
          if (this.options.progressionTarget === "header") return;
        }

        if (result === 1) {
          gotRealFlush = true;
          const wrapped = takeAndWrap(module._jxl_wasm_dec_take_flushed!(dec));
          if (wrapped !== null) {
            const { pixels, evInfo } = wrapped;
            yield { type: "progress", stage: "dc", info: evInfo, pixels: pixels.data.slice(), format: fmt, pixelStride, ...(pixels.region === undefined ? {} : { region: pixels.region }) };
            if (this.options.progressionTarget !== "final" && !this.options.emitEveryPass) return;
          }
        } else if (result === 2) {
          done = true;
        }
      }

      if (done) {
        const wrapped = takeAndWrap(module._jxl_wasm_dec_take_final!(dec));
        if (wrapped !== null) {
          const { pixels, evInfo } = wrapped;
          if (!gotRealFlush && (this.options.emitEveryPass || this.options.progressionTarget === "dc" || this.options.progressionTarget === "pass")) {
            const stage: DecodeStage = this.options.progressionTarget === "dc" ? "dc" : "pass";
            yield { type: "progress", stage, info: evInfo, pixels: pixels.data.slice(), format: fmt, pixelStride, ...(pixels.region === undefined ? {} : { region: pixels.region }) };
            if (this.options.progressionTarget !== "final") return;
          }
          yield { type: "final", info: evInfo, pixels: pixels.data, format: fmt, pixelStride, ...(pixels.region === undefined ? {} : { region: pixels.region }) };
        }
      }
    } finally {
      module._jxl_wasm_dec_free!(dec);
    }
  }

  private async *eventsOneShot(module: LibjxlWasmModule): AsyncIterable<DecodeEvent> {
    // Drain all chunks until input closed
    const allChunks: Uint8Array[] = [];
    while (!this.cancelled) {
      await this.waitForQueueItem();
      if (this.cancelled) return;
      const item = this.chunkQueue.shift()!;
      if (item === null) break;
      allChunks.push(item);
    }
    if (this.cancelled) return;

    const fmt = this.options.format;
    const bpc = fmt === "rgbaf32" ? 4 : fmt === "rgba16" ? 2 : 1;
    const pixelStride = 4 * bpc;
    const decoded = callDecode(module, concatBytes(allChunks), this.options.downsample, fmt);
    const pixels = applyRegionAndDownsample(
      decoded.data,
      decoded.width,
      decoded.height,
      this.options.region,
      this.options.downsample,
      bpc,
    );
    const info: ImageInfo = {
      width: pixels.width,
      height: pixels.height,
      bitsPerSample: decoded.bitsPerSample,
      hasAlpha: decoded.hasAlpha,
      hasAnimation: false,
      jpegReconstructionAvailable: false,
    };

    yield { type: "header", info };
    if (this.options.progressionTarget === "header") {
      module._jxl_wasm_buffer_free(decoded.handle);
      return;
    }
    if (this.options.emitEveryPass || this.options.progressionTarget === "dc" || this.options.progressionTarget === "pass") {
      yield {
        type: "progress",
        stage: this.options.progressionTarget === "dc" ? "dc" : "pass",
        info,
        pixels: pixels.data.slice(),
        format: fmt,
        pixelStride,
        ...(pixels.region === undefined ? {} : { region: pixels.region }),
      };
      if (this.options.progressionTarget !== "final") {
        module._jxl_wasm_buffer_free(decoded.handle);
        return;
      }
    }
    yield {
      type: "final",
      info,
      pixels: pixels.data,
      format: fmt,
      pixelStride,
      ...(pixels.region === undefined ? {} : { region: pixels.region }),
    };
    module._jxl_wasm_buffer_free(decoded.handle);
  }

  cancel(_reason?: string): void {
    this.cancelled = true;
    this.wakeResolve?.();
    this.wakeResolve = null;
  }

  dispose(): void {
    this.chunkQueue = [];
    this.cancelled = true;
    this.wakeResolve?.();
    this.wakeResolve = null;
  }
}

class LibjxlEncoder implements JxlEncoder {
  private pixelChunks: Uint8Array[] = [];
  private finished = false;
  private cancelled = false;

  constructor(private readonly options: EncoderOptions) {}

  pushPixels(chunk: ArrayBuffer | Uint8Array, region?: Region): void {
    if (this.cancelled || this.finished) return;
    if (region !== undefined) {
      throw new CapabilityMissing("libjxl WASM facade does not support chunked region encode yet");
    }
    this.pixelChunks.push(toUint8Array(chunk).slice());
  }

  finish(): void {
    this.finished = true;
  }

  async *chunks(): AsyncIterable<ArrayBuffer | Uint8Array> {
    await this.waitUntilFinished();
    if (this.cancelled) return;

    if (this.options.format === "rgba16" || this.options.format === "rgbaf32") {
      const module = await loadLibjxlModule();
      const encFn = this.options.format === "rgba16" ? "_jxl_wasm_encode_rgba16" : "_jxl_wasm_encode_rgbaf32";
      if (typeof module[encFn] !== "function") {
        throw new CapabilityMissing(`${this.options.format} encode requires a rebuilt WASM with multi-format bridge`);
      }
    }

    const bytesPerChannel = this.options.format === "rgbaf32" ? 4 : this.options.format === "rgba16" ? 2 : 1;
    const pixels = concatBytes(this.pixelChunks);
    const expectedBytes = this.options.width * this.options.height * 4 * bytesPerChannel;
    if (pixels.byteLength !== expectedBytes) {
      throw new Error(`JXL encode expected ${expectedBytes} bytes for ${this.options.format}, got ${pixels.byteLength}`);
    }

    const module = await loadLibjxlModule();
    const encoded = callEncode(module, pixels, this.options);
    yield encoded.data.slice();
    module._jxl_wasm_buffer_free(encoded.handle);
  }

  cancel(_reason?: string): void {
    this.cancelled = true;
  }

  dispose(): void {
    this.pixelChunks = [];
    this.cancelled = true;
  }

  private waitUntilFinished(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.finished || this.cancelled) resolve();
        else setTimeout(check, 1);
      };
      check();
    });
  }
}

async function loadLibjxlModule(): Promise<LibjxlWasmModule> {
  modulePromise ??= (testModuleFactory ?? loadGeneratedLibjxlModule)();
  return modulePromise;
}

async function loadGeneratedLibjxlModule(): Promise<LibjxlWasmModule> {
  const modulePath = "./jxl-core.scalar.js";
  const imported = await import(modulePath) as { default?: unknown };
  const factory = imported.default;
  if (typeof factory !== "function") {
    throw new CapabilityMissing("Generated libjxl WASM module is missing default Emscripten factory");
  }
  const baseUrl = new URL("./", import.meta.url);
  const options: Record<string, unknown> = {
    locateFile: (path: string) => new URL(path, baseUrl).href,
  };
  // Emscripten web-only output lacks Node file loading; pre-read binary so it can instantiate in Bun/Node
  try {
    const fsMod = await import("node:fs/promises" as string) as { readFile: (p: URL | string) => Promise<Uint8Array> };
    const urlMod = await import("node:url" as string) as { fileURLToPath: (u: URL | string) => string };
    options["wasmBinary"] = await fsMod.readFile(urlMod.fileURLToPath(new URL("jxl-core.scalar.wasm", baseUrl)));
  } catch {
    // Not in Node/Bun, or WASM binary not found; Emscripten will load via fetch
  }
  return await (factory as (options: Record<string, unknown>) => Promise<LibjxlWasmModule>)(options);
}

function callDecode(module: LibjxlWasmModule, input: Uint8Array, downsample: number, format: PixelFormat): LibjxlBuffer {
  const ptr = module._malloc(input.byteLength);
  try {
    module.HEAPU8.set(input, ptr);
    let handle: number;
    if (format === "rgba16" && module._jxl_wasm_decode_rgba16) {
      handle = module._jxl_wasm_decode_rgba16(ptr, input.byteLength, downsample);
    } else if (format === "rgbaf32" && module._jxl_wasm_decode_rgbaf32) {
      handle = module._jxl_wasm_decode_rgbaf32(ptr, input.byteLength, downsample);
    } else {
      handle = module._jxl_wasm_decode_rgba8(ptr, input.byteLength, downsample);
    }
    return readBuffer(module, handle, "decode");
  } finally {
    module._free(ptr);
  }
}

function callEncode(module: LibjxlWasmModule, pixels: Uint8Array, options: EncoderOptions): LibjxlBuffer {
  const ptr = module._malloc(pixels.byteLength);
  try {
    module.HEAPU8.set(pixels, ptr);
    const distance = options.distance ?? distanceFromQuality(options.quality);
    let handle: number;
    if (options.format === "rgba16" && module._jxl_wasm_encode_rgba16) {
      handle = module._jxl_wasm_encode_rgba16(ptr, options.width, options.height, distance, options.effort);
    } else if (options.format === "rgbaf32" && module._jxl_wasm_encode_rgbaf32) {
      handle = module._jxl_wasm_encode_rgbaf32(ptr, options.width, options.height, distance, options.effort);
    } else {
      handle = module._jxl_wasm_encode_rgba8(ptr, options.width, options.height, distance, options.effort);
    }
    return readBuffer(module, handle, "encode");
  } finally {
    module._free(ptr);
  }
}

function readBuffer(module: LibjxlWasmModule, handle: number, operation: string): LibjxlBuffer {
  if (handle === 0) {
    throw new Error(`JXL ${operation} failed`);
  }
  const dataPtr = module._jxl_wasm_buffer_data(handle);
  const size = module._jxl_wasm_buffer_size(handle);
  if (dataPtr === 0 || size === 0) {
    const code = module._jxl_wasm_buffer_error?.(handle) ?? 0;
    module._jxl_wasm_buffer_free(handle);
    throw new Error(`JXL ${operation} failed${code === 0 ? "" : ` (${code})`}`);
  }
  return {
    handle,
    data: module.HEAPU8.slice(dataPtr, dataPtr + size),
    width: module._jxl_wasm_buffer_width(handle),
    height: module._jxl_wasm_buffer_height(handle),
    bitsPerSample: normalizeBitsPerSample(module._jxl_wasm_buffer_bits_per_sample(handle)),
    hasAlpha: module._jxl_wasm_buffer_has_alpha(handle) !== 0,
  };
}

function normalizeBitsPerSample(value: number): 8 | 16 | 32 {
  if (value === 16 || value === 32) return value;
  return 8;
}

function distanceFromQuality(quality: number | null): number {
  if (quality === null) return 1;
  return Math.max(0, Math.min(15, (100 - quality) / 6.67));
}

function applyRegionAndDownsample(
  data: Uint8Array,
  width: number,
  height: number,
  region: Region | null,
  downsample: 1 | 2 | 4 | 8,
  bytesPerChannel = 1,
): { data: Uint8Array; width: number; height: number; region?: Region } {
  const stride = 4 * bytesPerChannel;
  const sourceRegion = normalizeRegion(region, width, height);
  const outWidth = Math.max(1, Math.ceil(sourceRegion.w / downsample));
  const outHeight = Math.max(1, Math.ceil(sourceRegion.h / downsample));
  const out = new Uint8Array(outWidth * outHeight * stride);

  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const sx = sourceRegion.x + Math.min(sourceRegion.w - 1, x * downsample);
      const sy = sourceRegion.y + Math.min(sourceRegion.h - 1, y * downsample);
      const src = (sy * width + sx) * stride;
      const dst = (y * outWidth + x) * stride;
      for (let b = 0; b < stride; b++) {
        out[dst + b] = data[src + b] ?? (b === stride - 1 && bytesPerChannel === 1 ? 255 : 0);
      }
    }
  }

  const result: { data: Uint8Array; width: number; height: number; region?: Region } = {
    data: out,
    width: outWidth,
    height: outHeight,
  };
  if (region !== null) {
    result.region = { x: 0, y: 0, w: outWidth, h: outHeight };
  }
  return result;
}

function normalizeRegion(region: Region | null, width: number, height: number): Region {
  if (region === null) return { x: 0, y: 0, w: width, h: height };
  const x = Math.max(0, Math.min(width - 1, Math.trunc(region.x)));
  const y = Math.max(0, Math.min(height - 1, Math.trunc(region.y)));
  const maxW = width - x;
  const maxH = height - y;
  return {
    x,
    y,
    w: Math.max(1, Math.min(maxW, Math.trunc(region.w))),
    h: Math.max(1, Math.min(maxH, Math.trunc(region.h))),
  };
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function toUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value);
}
