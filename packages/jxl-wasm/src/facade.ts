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
  /** Max dimensions (px) of sidecar thumbnails to yield before the full image. Sorted ascending. */
  sidecarSizes?: readonly number[];
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
  _jxl_wasm_encode_rgba8(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number): number;
  _jxl_wasm_encode_rgba16?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number): number;
  _jxl_wasm_encode_rgbaf32?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number): number;
  _jxl_wasm_buffer_data(handle: number): number;
  _jxl_wasm_buffer_size(handle: number): number;
  _jxl_wasm_buffer_width(handle: number): number;
  _jxl_wasm_buffer_height(handle: number): number;
  _jxl_wasm_buffer_bits_per_sample(handle: number): number;
  _jxl_wasm_buffer_has_alpha(handle: number): number;
  _jxl_wasm_buffer_error?(handle: number): number;
  _jxl_wasm_buffer_free(handle: number): void;
  // Stateful progressive decoder (present after WASM rebuild with new bridge)
  _jxl_wasm_dec_create?(format: number, wantProgressive: number): number;
  _jxl_wasm_dec_push?(state: number, dataPtr: number, size: number): number;
  _jxl_wasm_dec_close_input?(state: number): void;
  _jxl_wasm_dec_width?(state: number): number;
  _jxl_wasm_dec_height?(state: number): number;
  _jxl_wasm_dec_error?(state: number): number;
  _jxl_wasm_dec_take_flushed?(state: number): number;
  _jxl_wasm_dec_take_final?(state: number): number;
  _jxl_wasm_dec_free?(state: number): void;
  // Sidecar thumbnail encode (present after WASM rebuild with sidecar bridge)
  _jxl_wasm_encode_rgba8_with_sidecars?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, sidecarDimsPtr: number, numSidecars: number): number;
  _jxl_wasm_buffer_next?(handle: number): number;
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

export type Tier = "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar";

export function detectTier(): Tier {
  if (typeof process !== "undefined" && !!process.versions?.node) return "scalar";
  if (typeof WebAssembly === "undefined") return "scalar";
  const hasSimd = probeSimd();
  if (!hasSimd) return "scalar";
  const hasSab = typeof SharedArrayBuffer !== "undefined";
  const hasRelaxedSimd = probeRelaxedSimd();
  if (hasSab && hasRelaxedSimd) return "relaxed-simd-mt";
  if (hasSab) return "simd-mt";
  return "simd";
}

function probeSimd(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
      0x03, 0x02, 0x01, 0x00,
      0x0a, 0x08, 0x01, 0x06, 0x00,
      0x41, 0x00, 0xfd, 0x0f, 0x0b,
    ]));
  } catch {
    return false;
  }
}

function probeRelaxedSimd(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x07, 0x01, 0x60, 0x02, 0x7b, 0x7b, 0x01, 0x7b,
      0x03, 0x02, 0x01, 0x00,
      0x0a, 0x0b, 0x01, 0x09, 0x00,
      0x20, 0x00, 0x20, 0x01, 0xfd, 0x80, 0x02, 0x0b,
    ]));
  } catch {
    return false;
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

/** Start loading the WASM module immediately. Call during app startup to hide cold-start latency. */
export function preloadJxlModule(): void {
  void loadLibjxlModule();
}

class LibjxlDecoder implements JxlDecoder {
  // null sentinel = input closed
  private chunkQueue: Array<Uint8Array | null> = [];
  private wakeResolve: (() => void) | null = null;
  private cancelled = false;

  constructor(private readonly options: DecoderOptions) {}

  push(chunk: ArrayBuffer | Uint8Array): void {
    if (this.cancelled) return;
    // ArrayBuffer callers transfer ownership — no copy needed. Uint8Array callers may
    // reuse the underlying buffer, so we must copy.
    this.chunkQueue.push(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : toUint8Array(chunk).slice());
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
    const wantProgressive = (this.options.progressionTarget !== "final" || this.options.emitEveryPass) ? 1 : 0;
    const dec = module._jxl_wasm_dec_create!(fmtIndex, wantProgressive);
    if (dec === 0) throw new Error("JXL progressive decoder creation failed");
    let chunkBufPtr = 0;
    let chunkBufCap = 0;
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

      // IMPROVEMENT-7: Batch all queued data chunks into one WASM write per tick.
      // IMPROVEMENT-9: Guard dec_width/dec_height calls behind !headerEmitted — skip 2 WASM
      // FFI calls per chunk once the header has been emitted.
      while (!done && !this.cancelled) {
        if (this.chunkQueue.length === 0) {
          await this.waitForQueueItem();
          if (this.cancelled) return;
        }

        // Collect pending byte count up to first close sentinel
        let batchBytes = 0;
        for (const it of this.chunkQueue) {
          if (it === null) break;
          batchBytes += it.byteLength;
        }

        if (batchBytes > 0) {
          if (batchBytes > chunkBufCap) {
            if (chunkBufPtr !== 0) module._free(chunkBufPtr);
            chunkBufPtr = module._malloc(batchBytes);
            chunkBufCap = batchBytes;
          }
          let woff = 0;
          while (this.chunkQueue.length > 0 && this.chunkQueue[0] !== null) {
            const chunk = this.chunkQueue.shift() as Uint8Array;
            module.HEAPU8.set(chunk, chunkBufPtr + woff);
            woff += chunk.byteLength;
          }
          const result = module._jxl_wasm_dec_push!(dec, chunkBufPtr, batchBytes);
          if (result < 0) throw new Error(`JXL decode error: ${module._jxl_wasm_dec_error!(dec)}`);

          if (!headerEmitted) {
            const w = module._jxl_wasm_dec_width!(dec);
            const h = module._jxl_wasm_dec_height!(dec);
            if (w > 0 && h > 0) {
              headerEmitted = true;
              yield { type: "header", info: buildInfo(w, h) };
              if (this.options.progressionTarget === "header") return;
            }
          }

          if (result === 1) {
            gotRealFlush = true;
            const wrapped = takeAndWrap(module._jxl_wasm_dec_take_flushed!(dec));
            if (wrapped !== null) {
              const { pixels, evInfo } = wrapped;
              yield { type: "progress", stage: "dc", info: evInfo, pixels: pixels.data, format: fmt, pixelStride, ...(pixels.region === undefined ? {} : { region: pixels.region }) };
              if (this.options.progressionTarget !== "final" && !this.options.emitEveryPass) return;
            }
          } else if (result === 2) {
            done = true;
          }
        } else if (this.chunkQueue.length > 0 && this.chunkQueue[0] === null) {
          // Close sentinel — flush remaining decoder state
          this.chunkQueue.shift();
          module._jxl_wasm_dec_close_input!(dec);
          const result = module._jxl_wasm_dec_push!(dec, 0, 0);
          done = result === 2;
          break;
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
      if (chunkBufPtr !== 0) module._free(chunkBufPtr);
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
    const input = concatBytes(allChunks);
    allChunks.length = 0;
    const decoded = callDecode(module, input, this.options.downsample, fmt);
    // C++ already applied downsampling; decoded.width/height are the actual output dimensions.
    // Scale any region crop into the downsampled coordinate space and pass downsample=1.
    const ds = this.options.downsample;
    const scaledRegion = this.options.region !== null ? {
      x: Math.trunc(this.options.region.x / ds),
      y: Math.trunc(this.options.region.y / ds),
      w: Math.ceil(this.options.region.w / ds),
      h: Math.ceil(this.options.region.h / ds),
    } : null;
    const pixels = applyRegionAndDownsample(
      decoded.data,
      decoded.width,
      decoded.height,
      scaledRegion,
      1,
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
  private finishResolve: (() => void) | null = null;

  constructor(private readonly options: EncoderOptions) {}

  pushPixels(chunk: ArrayBuffer | Uint8Array, region?: Region): void {
    if (this.cancelled || this.finished) return;
    if (region !== undefined) {
      throw new CapabilityMissing("libjxl WASM facade does not support chunked region encode yet");
    }
    this.pixelChunks.push(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : toUint8Array(chunk).slice());
  }

  finish(): void {
    this.finished = true;
    this.finishResolve?.();
    this.finishResolve = null;
  }

  async *chunks(): AsyncIterable<ArrayBuffer | Uint8Array> {
    await this.waitUntilFinished();
    if (this.cancelled) return;

    const module = await loadLibjxlModule();
    if (this.options.format === "rgba16" || this.options.format === "rgbaf32") {
      const encFn = this.options.format === "rgba16" ? "_jxl_wasm_encode_rgba16" : "_jxl_wasm_encode_rgbaf32";
      if (typeof module[encFn] !== "function") {
        throw new CapabilityMissing(`${this.options.format} encode requires a rebuilt WASM with multi-format bridge`);
      }
    }

    const bytesPerChannel = this.options.format === "rgbaf32" ? 4 : this.options.format === "rgba16" ? 2 : 1;
    const expectedBytes = this.options.width * this.options.height * 4 * bytesPerChannel;
    const totalBytes = this.pixelChunks.reduce((s, c) => s + c.byteLength, 0);
    if (totalBytes !== expectedBytes) {
      throw new Error(`JXL encode expected ${expectedBytes} bytes for ${this.options.format}, got ${totalBytes}`);
    }

    // IMPROVEMENT-6: Write pixel chunks directly into WASM heap — no concatBytes allocation.
    const ptr = module._malloc(totalBytes);
    try {
      let offset = 0;
      for (const chunk of this.pixelChunks) {
        module.HEAPU8.set(chunk, ptr + offset);
        offset += chunk.byteLength;
      }
      this.pixelChunks = [];
      const distance = this.options.distance ?? distanceFromQuality(this.options.quality);
      const hasAlpha = this.options.hasAlpha ? 1 : 0;

      // IMPROVEMENT-5: Sidecar thumbnails — yield smallest first for faster first-paint.
      if (this.options.sidecarSizes && this.options.sidecarSizes.length > 0
          && module._jxl_wasm_encode_rgba8_with_sidecars
          && module._jxl_wasm_buffer_next) {
        const sortedSizes = [...this.options.sidecarSizes].sort((a, b) => a - b);
        const dimsPtr = module._malloc(sortedSizes.length * 4);
        try {
          // Write uint32[] into WASM heap (HEAPU32 if available, byte-by-byte otherwise)
          if (module.HEAPU32) {
            const base32 = dimsPtr >>> 2;
            for (let i = 0; i < sortedSizes.length; i++) module.HEAPU32[base32 + i] = (sortedSizes[i] ?? 0) >>> 0;
          } else {
            for (let i = 0; i < sortedSizes.length; i++) {
              const v = (sortedSizes[i] ?? 0) >>> 0;
              module.HEAPU8[dimsPtr + i * 4]     =  v         & 0xff;
              module.HEAPU8[dimsPtr + i * 4 + 1] = (v >>>  8) & 0xff;
              module.HEAPU8[dimsPtr + i * 4 + 2] = (v >>> 16) & 0xff;
              module.HEAPU8[dimsPtr + i * 4 + 3] = (v >>> 24) & 0xff;
            }
          }
          let handle = module._jxl_wasm_encode_rgba8_with_sidecars(
            ptr, this.options.width, this.options.height,
            distance, this.options.effort, hasAlpha,
            dimsPtr, sortedSizes.length,
          );
          while (handle !== 0) {
            // Read next BEFORE readBuffer — it may free `handle` on error.
            const next = module._jxl_wasm_buffer_next(handle);
            try {
              const buf = readBuffer(module, handle, "encode");
              // IMPROVEMENT-10: buf.data is already a copy (HEAPU8.slice in readBuffer).
              yield buf.data;
              module._jxl_wasm_buffer_free(handle);
            } catch (err) {
              // handle was freed inside readBuffer; free remaining chain, then rethrow.
              let cur = next;
              while (cur !== 0) {
                const nxt = module._jxl_wasm_buffer_next(cur);
                module._jxl_wasm_buffer_free(cur);
                cur = nxt;
              }
              throw err;
            }
            handle = next;
          }
        } finally {
          module._free(dimsPtr);
        }
      } else {
        // Standard single-image encode path
        let handle: number;
        if (this.options.format === "rgba16" && module._jxl_wasm_encode_rgba16) {
          handle = module._jxl_wasm_encode_rgba16(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha);
        } else if (this.options.format === "rgbaf32" && module._jxl_wasm_encode_rgbaf32) {
          handle = module._jxl_wasm_encode_rgbaf32(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha);
        } else {
          handle = module._jxl_wasm_encode_rgba8(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha);
        }
        const encoded = readBuffer(module, handle, "encode");
        yield encoded.data;  // IMPROVEMENT-10: already a copy from readBuffer — no .slice() needed
        module._jxl_wasm_buffer_free(encoded.handle);
      }
    } finally {
      module._free(ptr);
    }
  }

  cancel(_reason?: string): void {
    this.cancelled = true;
    this.finishResolve?.();
    this.finishResolve = null;
  }

  dispose(): void {
    this.pixelChunks = [];
    this.cancelled = true;
    this.finishResolve?.();
    this.finishResolve = null;
  }

  private waitUntilFinished(): Promise<void> {
    if (this.finished || this.cancelled) return Promise.resolve();
    return new Promise<void>((resolve) => { this.finishResolve = resolve; });
  }
}

async function loadLibjxlModule(): Promise<LibjxlWasmModule> {
  modulePromise ??= (testModuleFactory ?? loadGeneratedLibjxlModule)();
  return modulePromise;
}

async function loadGeneratedLibjxlModule(): Promise<LibjxlWasmModule> {
  const tier = detectTier();
  const modulePath = `./jxl-core.${tier}.js`;
  const imported = await import(modulePath) as { default?: unknown };
  const factory = imported.default;
  if (typeof factory !== "function") {
    throw new CapabilityMissing("Generated libjxl WASM module is missing default Emscripten factory");
  }
  const baseUrl = new URL("./", import.meta.url);
  const options: Record<string, unknown> = {
    locateFile: (path: string) => new URL(path, baseUrl).href,
  };
  // Emscripten web output can fetch the .wasm in the browser. Pre-read the
  // binary only in Node/Bun so the same bundle works in both environments.
  if (typeof process !== "undefined" && !!process.versions?.node) {
    try {
      const fsMod = await import("node:fs/promises") as { readFile: (p: URL | string) => Promise<Uint8Array> };
      const urlMod = await import("node:url") as { fileURLToPath: (u: URL | string) => string };
      options["wasmBinary"] = await fsMod.readFile(urlMod.fileURLToPath(new URL(`jxl-core.${tier}.wasm`, baseUrl)));
    } catch {
      // Node/Bun but binary unavailable; let Emscripten resolve it another way.
    }
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
    const hasAlpha = options.hasAlpha ? 1 : 0;
    let handle: number;
    if (options.format === "rgba16" && module._jxl_wasm_encode_rgba16) {
      handle = module._jxl_wasm_encode_rgba16(ptr, options.width, options.height, distance, options.effort, hasAlpha);
    } else if (options.format === "rgbaf32" && module._jxl_wasm_encode_rgbaf32) {
      handle = module._jxl_wasm_encode_rgbaf32(ptr, options.width, options.height, distance, options.effort, hasAlpha);
    } else {
      handle = module._jxl_wasm_encode_rgba8(ptr, options.width, options.height, distance, options.effort, hasAlpha);
    }
    return readBuffer(module, handle, "encode");
  } finally {
    module._free(ptr);
  }
}

function readBuffer(module: LibjxlWasmModule, handle: number, operation: string): LibjxlBuffer {
  if (handle === 0) throw new Error(`JXL ${operation} failed`);

  // JxlWasmBuffer (WASM32): all fields are 4 bytes — data*, size_t, width, height, bits, has_alpha, error.
  // Read the entire struct in one contiguous HEAPU32 window instead of 6 separate FFI calls.
  let dataPtr: number, size: number, width: number, height: number, bitsVal: number, alphaVal: number, errorCode: number;
  const h32 = module.HEAPU32;
  // Only use the HEAPU32 direct-read fast path when `handle` looks like a real WASM heap
  // address: 4-byte aligned and above the minimum reserved region. Test fake modules use
  // sequential integers (1, 2, 3…) that would read garbage at the wrong HEAPU32 index.
  if (h32 && (handle & 3) === 0 && handle >= 16) {
    const b = handle >>> 2;
    dataPtr   = h32[b] ?? 0;
    size      = h32[b + 1] ?? 0;
    width     = h32[b + 2] ?? 0;
    height    = h32[b + 3] ?? 0;
    bitsVal   = h32[b + 4] ?? 0;
    alphaVal  = h32[b + 5] ?? 0;
    errorCode = h32[b + 6] ?? 0;
  } else {
    dataPtr   = module._jxl_wasm_buffer_data(handle);
    size      = module._jxl_wasm_buffer_size(handle);
    width     = module._jxl_wasm_buffer_width(handle);
    height    = module._jxl_wasm_buffer_height(handle);
    bitsVal   = module._jxl_wasm_buffer_bits_per_sample(handle);
    alphaVal  = module._jxl_wasm_buffer_has_alpha(handle);
    errorCode = module._jxl_wasm_buffer_error?.(handle) ?? 0;
  }

  if (dataPtr === 0 || size === 0) {
    module._jxl_wasm_buffer_free(handle);
    throw new Error(`JXL ${operation} failed${errorCode === 0 ? "" : ` (${errorCode})`}`);
  }
  return {
    handle,
    data: module.HEAPU8.slice(dataPtr, dataPtr + size),
    width,
    height,
    bitsPerSample: normalizeBitsPerSample(bitsVal),
    hasAlpha: alphaVal !== 0,
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
  // IMPROVEMENT-8: Hottest path — no crop, no downsample — skip normalizeRegion entirely.
  if (downsample === 1 && region === null) return { data, width, height };

  const stride = 4 * bytesPerChannel;
  const sourceRegion = normalizeRegion(region, width, height);

  // Secondary fast path: region present but maps to full image after clamping
  if (downsample === 1 && sourceRegion.x === 0 && sourceRegion.y === 0 && sourceRegion.w === width && sourceRegion.h === height) {
    const result: { data: Uint8Array; width: number; height: number; region?: Region } = { data, width, height };
    if (region !== null) result.region = { x: 0, y: 0, w: width, h: height };
    return result;
  }

  const outWidth = Math.max(1, Math.ceil(sourceRegion.w / downsample));
  const outHeight = Math.max(1, Math.ceil(sourceRegion.h / downsample));
  const out = new Uint8Array(outWidth * outHeight * stride);

  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const sx = sourceRegion.x + Math.min(sourceRegion.w - 1, x * downsample);
      const sy = sourceRegion.y + Math.min(sourceRegion.h - 1, y * downsample);
      const src = (sy * width + sx) * stride;
      const dst = (y * outWidth + x) * stride;
      out.set(data.subarray(src, src + stride), dst);
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
  if (chunks.length === 1) return chunks[0]!;
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
