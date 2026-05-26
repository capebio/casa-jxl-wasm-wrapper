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
      sourceScale?: number;
      progressiveRegion?: boolean;
      regionFallback?: "full-frame-then-crop";
    }
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
  region?: Region | null;
  downsample?: 1 | 2 | 4 | 8;
  progressionTarget: "header" | "dc" | "pass" | "final";
  emitEveryPass: boolean;
  preserveIcc: boolean;
  preserveMetadata: boolean;
  /** When false, skip the defensive .slice() copy on push() — caller must not mutate the buffer after push returns. Default true. */
  copyInput?: boolean;
  targetWidth?: number | null;
  targetHeight?: number | null;
  fitMode?: "contain" | "cover" | "stretch" | null;
  onMetric?: (name: string, value: number) => void;
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
  progressiveFlavor?: "dc" | "ac";
  previewFirst: boolean;
  chunked: boolean;
  /** Max dimensions (px) of sidecar thumbnails to yield before the full image. Sorted ascending. */
  sidecarSizes?: readonly number[];
  /** When false, skip the defensive .slice() copy on pushPixels() — caller must not mutate the buffer after push returns. Default true. */
  copyInput?: boolean;
}

export interface JxlDecoder {
  push(chunk: ArrayBuffer | Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
  events(): AsyncIterable<DecodeEvent>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface EncodeStats {
  /** Raw pixel bytes: width × height × 4 × bytesPerChannel. */
  originalBytes: number;
  /** Total JXL bytes yielded across all chunks and sidecars. */
  compressedBytes: number;
  /** compressedBytes / originalBytes. Values below 1.0 indicate net compression. */
  ratio: number;
}

export interface JxlEncoder {
  pushPixels(chunk: ArrayBuffer | Uint8Array, region?: Region): void | Promise<void>;
  finish(): void | Promise<void>;
  chunks(): AsyncIterable<ArrayBuffer | Uint8Array>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
  /** Populated after chunks() completes normally. Null before or on error. */
  getStats(): EncodeStats | null;
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
  _jxl_wasm_encode_rgba8(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number): number;
  _jxl_wasm_encode_rgba16?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number): number;
  _jxl_wasm_encode_rgbaf32?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number): number;
  _jxl_wasm_encode_rgba8_with_metadata?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number): number;
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
  // #10: C++ region crop decode — avoids shipping full-image pixels to JS
  _jxl_wasm_decode_rgba8_region?(inputPtr: number, inputSize: number, cx: number, cy: number, cw: number, ch: number, downsample: number): number;
  _jxl_wasm_decode_rgba16_region?(inputPtr: number, inputSize: number, cx: number, cy: number, cw: number, ch: number, downsample: number): number;
  _jxl_wasm_decode_rgbaf32_region?(inputPtr: number, inputSize: number, cx: number, cy: number, cw: number, ch: number, downsample: number): number;
  // #11: Streaming encoder — yields 64 KB chunks
  _jxl_wasm_enc_create?(): number;
  _jxl_wasm_enc_push_pixels?(state: number, pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number): number;
  _jxl_wasm_enc_take_chunk?(state: number): number;
  _jxl_wasm_enc_error?(state: number): number;
  _jxl_wasm_enc_free?(state: number): void;
  // #15: Lossless JPEG → JXL transcode
  _jxl_wasm_transcode_jpeg_to_jxl?(jpegPtr: number, jpegSize: number): number;
  // #16: Streaming input encoder — pre-allocate pixel buffer in WASM, push chunks, finish
  _jxl_wasm_enc_create_image?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number): number;
  _jxl_wasm_enc_push_chunk?(state: number, dataPtr: number, size: number): number;
  _jxl_wasm_enc_finish?(state: number): number;
}

type JxlModuleFactory = () => Promise<LibjxlWasmModule>;

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

function resolveEncoderBridgeSettings(options: EncoderOptions) {
  if (!options.progressive) {
    return { progressiveDc: 0, progressiveAc: 0, qProgressiveAc: 0, buffering: options.chunked ? 2 : 0 };
  }
  const acEnabled = options.progressiveFlavor === "ac" || (options.progressiveFlavor !== "dc" && options.previewFirst);
  return {
    progressiveDc: 1,
    progressiveAc: acEnabled ? 1 : 0,
    qProgressiveAc: acEnabled ? 1 : 0,
    buffering: options.chunked ? 2 : 0,
  };
}

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
  if (_cachedDetectedTier !== undefined) return _cachedDetectedTier;
  let tier: Tier;
  if (typeof WebAssembly === "undefined") {
    tier = "scalar";
  } else {
    const hasSimd = probeSimd();
    if (!hasSimd) {
      tier = "scalar";
    } else {
      const hasSab = typeof SharedArrayBuffer !== "undefined";
      const hasRelaxedSimd = probeRelaxedSimd();
      if (hasSab && hasRelaxedSimd) tier = "relaxed-simd-mt";
      else if (hasSab) tier = "simd-mt";
      else tier = "simd";
    }
  }
  _cachedDetectedTier = tier;
  return tier;
}

/**
 * Returns a sensible default effort level for the current WASM tier.
 * Scalar workers get a lower effort to avoid blocking the thread; SIMD-MT
 * workers get full effort since they can use parallel libjxl codepaths.
 */
export function recommendedEffort(): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
  const tier = detectTier();
  if (tier === "scalar") return 4;
  if (tier === "simd") return 6;
  return 7; // simd-mt, relaxed-simd-mt
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
let _forcedTier: Tier | null = null;
let _cachedDetectedTier: Tier | undefined;

export function setJxlModuleFactoryForTesting(factory: JxlModuleFactory | null): void {
  testModuleFactory = factory;
  modulePromise = undefined;
}

/**
 * Override the WASM tier used on the next module load.
 * Pass null to restore auto-detection via detectTier().
 * Resets the cached module so the next encode/decode reloads with the new tier.
 */
export function setForcedTier(tier: Tier | null): void {
  _forcedTier = tier;
  modulePromise = undefined;
}

export function getForcedTier(): Tier | null {
  return _forcedTier;
}

export function createDecoder(options: DecoderOptions): JxlDecoder {
  return new LibjxlDecoder(normalizeDecoderOptions(options));
}

export function createEncoder(options: EncoderOptions): JxlEncoder {
  return new LibjxlEncoder(options);
}

/**
 * Losslessly transcode a JPEG file to JXL without pixel expansion.
 * The resulting JXL embeds the original JPEG bitstream for round-trip fidelity.
 * Requires a WASM build that includes the #15 bridge (jxl_wasm_transcode_jpeg_to_jxl).
 */
export async function transcodeJpegToJxl(jpeg: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const module = await loadLibjxlModule();
  if (!getCapabilities(module).jpegTranscode) {
    throw new CapabilityMissing("JPEG→JXL transcode requires a rebuilt WASM with transcode bridge");
  }
  const view = copyOrBorrowInput(jpeg, false);
  const ptr = module._malloc(view.byteLength);
  try {
    module.HEAPU8.set(view, ptr);
    const handle = module._jxl_wasm_transcode_jpeg_to_jxl!(ptr, view.byteLength);
    return takeBuffer(module, handle, "transcode").data;
  } finally {
    module._free(ptr);
  }
}

/** Start loading the WASM module immediately. Call during app startup to hide cold-start latency. */
export function preloadJxlModule(): void {
  void loadLibjxlModule();
}

// Shared zero-length sentinel used to null out pixelChunks slots during progressive WASM copy.
const EMPTY_U8 = new Uint8Array(0);

class LibjxlDecoder implements JxlDecoder {
  // null sentinel = input closed
  private chunkQueue: Array<Uint8Array | null> = [];
  private readIndex = 0;
  private queuedBytes = 0;
  private wakeResolve: (() => void) | null = null;
  private cancelled = false;
  private closed = false;
  private eventsStarted = false;

  constructor(private readonly options: DecoderOptions) {}

  push(chunk: ArrayBuffer | Uint8Array): void {
    if (this.cancelled || this.closed) return;
    // ArrayBuffer callers (primary path: worker receives transferred chunks via postMessage)
    // are always zero-copy — new Uint8Array(ab) is a view, not a copy. Uint8Array callers
    // may reuse the underlying buffer, so we copy unless copyInput=false.
    const view = copyOrBorrowInput(chunk, this.options.copyInput !== false);
    this.queuedBytes += view.byteLength;
    this.chunkQueue.push(view);
    this.wake();
  }

  close(): void {
    if (this.cancelled || this.closed) return;
    this.closed = true;
    this.chunkQueue.push(null);
    this.wake();
  }

  private wake(): void {
    const resolve = this.wakeResolve;
    if (resolve !== null) {
      this.wakeResolve = null;
      resolve();
    }
  }

  private waitForQueueItem(): Promise<void> {
    if (this.chunkQueue.length > this.readIndex) return Promise.resolve();
    return new Promise<void>((resolve) => { this.wakeResolve = resolve; });
  }

  private compactQueue(): void {
    if (this.readIndex > 64 && this.readIndex * 2 > this.chunkQueue.length) {
      this.chunkQueue = this.chunkQueue.slice(this.readIndex);
      this.readIndex = 0;
    }
  }

  async *events(): AsyncIterable<DecodeEvent> {
    if (this.eventsStarted) {
      yield { type: "error", code: "InvalidState", message: "Decoder events() may only be consumed once." };
      return;
    }
    this.eventsStarted = true;
    try {
      if (this.cancelled) return;
      const module = await loadLibjxlModule();
      if (this.options.format !== "rgba8") {
        const decFn = this.options.format === "rgba16" ? "_jxl_wasm_decode_rgba16" : "_jxl_wasm_decode_rgbaf32";
        if (typeof module[decFn] !== "function") {
          throw new CapabilityMissing(`${this.options.format} decode requires a rebuilt WASM with multi-format bridge`);
        }
      }
      if (getCapabilities(module).progressiveDecode) {
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
    } finally {
      this.chunkQueue = [];
      this.readIndex = 0;
      this.queuedBytes = 0;
    }
  }

  private async *eventsProgressive(module: LibjxlWasmModule): AsyncIterable<DecodeEvent> {
    const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : 0;
    const wantProgressive = (this.options.progressionTarget !== "final" || this.options.emitEveryPass) ? 1 : 0;
    const dec = module._jxl_wasm_dec_create!(fmtIndex, wantProgressive);
    if (dec === 0) throw new Error("JXL progressive decoder creation failed");
    // Cache bridge fn refs once — avoids repeated property lookup on module per iteration.
    const decPush         = module._jxl_wasm_dec_push!;
    const decWidth        = module._jxl_wasm_dec_width!;
    const decHeight       = module._jxl_wasm_dec_height!;
    const decError        = module._jxl_wasm_dec_error!;
    const decTakeFlushed  = module._jxl_wasm_dec_take_flushed!;
    const decTakeFinal    = module._jxl_wasm_dec_take_final!;
    const decCloseInput   = module._jxl_wasm_dec_close_input!;
    const decFree         = module._jxl_wasm_dec_free!;
    let chunkBufPtr = 0;
    let chunkBufCap = 0;
    try {
      let headerEmitted = false;
      let info: ImageInfo | undefined;
      let gotRealFlush = false;
      let done = false;
      // Count flushed intermediate frames: first flush is the DC pass,
      // subsequent flushes are AC refinement passes.
      let flushCount = 0;

      const buildInfo = (w: number, h: number): ImageInfo => {
        info ??= { width: w, height: h, bitsPerSample: 8, hasAlpha: true, hasAnimation: false, jpegReconstructionAvailable: false };
        return info;
      };

      const bpc = fmtIndex === 2 ? 4 : fmtIndex === 1 ? 2 : 1;
      const pixelStride = 4 * bpc;
      const fmt = this.options.format;
      const takeAndWrap = (handle: number): { pixels: { data: Uint8Array; width: number; height: number; region?: Region }; evInfo: ImageInfo } | null => {
        if (handle === 0) return null;
        const buf = takeBuffer(module, handle, "decode");
        const pixels = applyRegionAndDownsample(buf.data, buf.width, buf.height, this.options.region, this.options.downsample, bpc);
        // When ROI/downsample crops the frame, pixels.width/height differ from full image dims.
        // buildInfo memoizes on first call (full dims from header), so we must not pass it
        // cropped dims — it would return the already-memoized full-dim object regardless.
        // Instead, derive evInfo from the base info with actual pixel dimensions.
        const baseInfo = buildInfo(buf.width, buf.height);
        const evInfo: ImageInfo = (pixels.width !== buf.width || pixels.height !== buf.height)
          ? { ...baseInfo, width: pixels.width, height: pixels.height }
          : baseInfo;
        return { pixels, evInfo };
      };

      const hasRegion = this.options.region != null;
      const onMetric = this.options.onMetric;
      let fallbackMetricEmitted = false;

      // IMPROVEMENT-7: Batch all queued data chunks into one WASM write per tick.
      // IMPROVEMENT-9: Guard dec_width/dec_height calls behind !headerEmitted — skip 2 WASM
      // FFI calls per chunk once the header has been emitted.
      while (!done && !this.cancelled) {
        if (this.chunkQueue.length <= this.readIndex) {
          await this.waitForQueueItem();
          if (this.cancelled) return;
        }

        // Pending byte count maintained incrementally — no scan needed.
        const batchBytes = this.queuedBytes;

        if (batchBytes > 0) {
          if (batchBytes > chunkBufCap) {
            if (chunkBufPtr !== 0) module._free(chunkBufPtr);
            chunkBufPtr = module._malloc(batchBytes);
            chunkBufCap = batchBytes;
          }
          let woff = 0;
          while (this.chunkQueue.length > this.readIndex && this.chunkQueue[this.readIndex] !== null) {
            const chunk = this.chunkQueue[this.readIndex] as Uint8Array;
            // Null slot immediately so GC can reclaim the Uint8Array after the HEAPU8.set copy.
            this.chunkQueue[this.readIndex++] = null;
            this.queuedBytes -= chunk.byteLength;
            module.HEAPU8.set(chunk, chunkBufPtr + woff);
            woff += chunk.byteLength;
          }
          this.compactQueue();
          const result = decPush(dec, chunkBufPtr, batchBytes);
          if (result < 0) throw new Error(`JXL decode error: ${decError(dec)}`);

          if (!headerEmitted) {
            const w = decWidth(dec);
            const h = decHeight(dec);
            if (w > 0 && h > 0) {
              headerEmitted = true;
              yield { type: "header", info: buildInfo(w, h) };
              if (this.options.progressionTarget === "header") return;
            }
          }

          if (result === 1) {
            gotRealFlush = true;
            flushCount++;
            const stage: DecodeStage = flushCount === 1 ? "dc" : "pass";
            const wrapped = takeAndWrap(decTakeFlushed(dec));
            if (wrapped !== null) {
              const { pixels: rawPixels, evInfo } = wrapped;

              // P4: emit region_fallback_full_frame metric once when progressive + region active.
              if (hasRegion && !fallbackMetricEmitted && onMetric) {
                onMetric("region_fallback_full_frame", 1);
                fallbackMetricEmitted = true;
              }

              // P1: apply bilinear resize if target dims set.
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
          } else if (result === 2) {
            done = true;
          }
        } else if (this.chunkQueue.length > this.readIndex && this.chunkQueue[this.readIndex] === null) {
          // Close sentinel — flush remaining decoder state
          this.readIndex++;
          this.compactQueue();
          decCloseInput(dec);
          const result = decPush(dec, 0, 0);
          // result < 0 means libjxl signalled an error (e.g. truncated stream).
          // Without this throw, the generator returns silently with no terminal
          // event, leaving the decode session permanently unresolved on the main thread.
          if (result < 0) throw new Error(`JXL decode error: ${decError(dec)}`);
          done = result === 2;
          break;
        }
      }

      if (done) {
        const wrapped = takeAndWrap(decTakeFinal(dec));
        if (wrapped !== null) {
          const { pixels: rawPixels, evInfo } = wrapped;

          // P5: emit decode metrics on final frame.
          if (onMetric) {
            onMetric("decode_scale_used", this.options.downsample);
            // info is memoized full-frame dims from buildInfo; fall back to rawPixels if header not yet seen.
            const fullW = info?.width ?? rawPixels.width;
            const fullH = info?.height ?? rawPixels.height;
            onMetric("source_pixels_decoded", fullW * fullH);
            if (hasRegion && this.options.region != null) {
              onMetric("decode_region_area", this.options.region.w * this.options.region.h);
            }
          }

          // P1: apply bilinear resize if target dims set.
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
    } finally {
      if (chunkBufPtr !== 0) module._free(chunkBufPtr);
      decFree(dec);
    }
  }

  private async *eventsOneShot(module: LibjxlWasmModule): AsyncIterable<DecodeEvent> {
    // Drain all chunks until input closed
    const allChunks: Uint8Array[] = [];
    while (!this.cancelled) {
      await this.waitForQueueItem();
      if (this.cancelled) return;
      const item = this.chunkQueue[this.readIndex++];
      this.compactQueue();
      if (item === null || item === undefined) break;
      this.queuedBytes -= item.byteLength;
      allChunks.push(item);
    }
    if (this.cancelled) return;

    const fmt = this.options.format;
    const bpc = fmt === "rgbaf32" ? 4 : fmt === "rgba16" ? 2 : 1;
    const pixelStride = 4 * bpc;
    // Write all chunks directly into a single WASM heap buffer — no intermediate JS allocation.
    const totalSize = allChunks.reduce((s, c) => s + c.byteLength, 0);
    const inputPtr = module._malloc(totalSize);
    let decodedHandle = 0;
    try {
      let woff = 0;
      for (const chunk of allChunks) {
        module.HEAPU8.set(chunk, inputPtr + woff);
        woff += chunk.byteLength;
      }
      allChunks.length = 0;
      // #10: pass region to callDecodeFromPtr — if C++ region bridge present it crops in WASM,
      // avoiding shipping full-image pixels to JS. JS fallback still works via applyRegionAndDownsample.
      const regionForDecode = this.options.region;
      const cppDidCrop = regionForDecode !== null && (
        (fmt === "rgba8" && !!module._jxl_wasm_decode_rgba8_region) ||
        (fmt === "rgba16" && !!module._jxl_wasm_decode_rgba16_region) ||
        (fmt === "rgbaf32" && !!module._jxl_wasm_decode_rgbaf32_region)
      );
      const decoded = callDecodeFromPtr(module, inputPtr, totalSize, this.options.downsample, fmt, cppDidCrop ? regionForDecode : null);
      decodedHandle = decoded.handle;
      // If C++ did the crop, decoded.width/height already reflect the region; no further JS crop.
      // Otherwise, scale region into downsampled coords and apply in JS.
      const ds = this.options.downsample;
      const scaledRegion = (!cppDidCrop && regionForDecode !== null) ? {
        x: Math.trunc(regionForDecode.x / ds),
        y: Math.trunc(regionForDecode.y / ds),
        w: Math.ceil(regionForDecode.w / ds),
        h: Math.ceil(regionForDecode.h / ds),
      } : null;
      const pixels = applyRegionAndDownsample(
        decoded.data,
        decoded.width,
        decoded.height,
        scaledRegion,
        1,
        bpc,
      );
      // C++ crop path skips applyRegionAndDownsample's region-setter; restore it to match JS path.
      if (cppDidCrop) pixels.region = { x: 0, y: 0, w: pixels.width, h: pixels.height };
      // P1: apply bilinear resize to exact target size if requested.
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

      // P5: emit decode metrics via onMetric callback.
      const actualScale = this.options.downsample;
      const onMetric = this.options.onMetric;
      if (onMetric) {
        onMetric("decode_scale_used", actualScale);
        onMetric("source_pixels_decoded", decoded.width * decoded.height);
        if (this.options.region != null) {
          onMetric("decode_region_area", this.options.region.w * this.options.region.h);
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
          pixelStride,
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
        pixelStride,
        sourceScale: actualScale,
        progressiveRegion: false,
      };
      if (outPixels.region !== undefined) ev.region = outPixels.region;
      yield ev;
    } finally {
      module._free(inputPtr);
      if (decodedHandle !== 0) module._jxl_wasm_buffer_free(decodedHandle);
    }
  }

  cancel(_reason?: string): void {
    this.cancelled = true;
    this.wake();
  }

  dispose(): void {
    this.chunkQueue = [];
    this.readIndex = 0;
    this.queuedBytes = 0;
    this.cancelled = true;
    this.wake();
  }
}

class LibjxlEncoder implements JxlEncoder {
  // Buffered path fallback (used when streaming input not available or sidecars active)
  private pixelChunks: Uint8Array[] = [];
  private finished = false;
  private cancelled = false;
  private finishResolve: (() => void) | null = null;
  private readonly sortedSidecarSizes: readonly number[];
  private encodeStats: EncodeStats | null = null;
  private chunksStarted = false;
  private queuedPixelBytes = 0;
  private readonly pixelByteTotal: number;
  // #16: Streaming input — module loaded on first pushPixels, state allocated immediately.
  // JS never accumulates pixelChunks[] when this path is active.
  private wasmModule: LibjxlWasmModule | null = null;
  private wasmEncState = 0;
  private streamingInputActive = false;
  private moduleInitPromise: Promise<LibjxlWasmModule> | null = null;
  private pendingPushPromise: Promise<void> = Promise.resolve();
  private pendingPushError: unknown = null;

  constructor(private readonly options: EncoderOptions) {
    this.sortedSidecarSizes = options.sidecarSizes ? [...options.sidecarSizes].sort((a, b) => a - b) : [];
    this.pixelByteTotal = expectedPixelBytes(options.width, options.height, options.format);
  }

  async pushPixels(chunk: ArrayBuffer | Uint8Array, region?: Region): Promise<void> {
    if (this.cancelled || this.finished) return;
    if (region !== undefined) {
      throw new CapabilityMissing("libjxl WASM facade does not support chunked region encode yet");
    }
    const view = copyOrBorrowInput(chunk, this.options.copyInput !== false);
    if (this.queuedPixelBytes + view.byteLength > this.pixelByteTotal) {
      throw new Error(`JXL encode received too many pixel bytes: expected ${this.pixelByteTotal}, got at least ${this.queuedPixelBytes + view.byteLength}`);
    }
    this.queuedPixelBytes += view.byteLength;
    const pushTask = this.pendingPushPromise.then(async () => {
      const module = await this.ensureModule();
      if (this.cancelled) return;

      if (this.streamingInputActive) {
        // #16: copy chunk into WASM pixel buffer; JS ref can be discarded immediately after.
        const ptr = module._malloc(view.byteLength);
        try {
          module.HEAPU8.set(view, ptr);
          const rc = module._jxl_wasm_enc_push_chunk!(this.wasmEncState, ptr, view.byteLength);
          if (rc !== 0) throw new Error(`JXL streaming pixel push failed (${rc})`);
        } finally {
          module._free(ptr);
        }
      } else {
        this.pixelChunks.push(view);
      }
    });
    this.pendingPushPromise = pushTask.catch((error) => {
      this.pendingPushError = error;
    });
    await pushTask;
  }

  private ensureModule(): Promise<LibjxlWasmModule> {
    this.moduleInitPromise ??= this.initModule();
    return this.moduleInitPromise;
  }

  private async initModule(): Promise<LibjxlWasmModule> {
    const module = await loadLibjxlModule();
    this.wasmModule = module;
    if (this.cancelled) return module;

    const caps = getCapabilities(module);
    // Use streaming input only when sidecars are not requested — sidecar path takes
    // a complete RGBA8 pixel pointer and cannot be fed incrementally.
    // Also skip streaming input when metadata (ICC/EXIF/XMP) is present: the
    // streaming input path calls enc_finish → EncodeRgba which has no metadata
    // parameter. Fall back to the buffered path which routes through
    // encode_rgba8_with_metadata so metadata is preserved for all pixel formats.
    const wantSidecars = this.sortedSidecarSizes.length > 0 && caps.sidecars;
    const hasMetadataOpts = this.options.iccProfile !== null || this.options.exif !== null || this.options.xmp !== null;
    if (!wantSidecars && !hasMetadataOpts && caps.streamingInput) {
      const distance = this.options.distance ?? distanceFromQuality(this.options.quality);
      const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : 0;
      const { progressiveDc, progressiveAc, qProgressiveAc, buffering } = resolveEncoderBridgeSettings(this.options);
      this.wasmEncState = module._jxl_wasm_enc_create_image!(
        this.options.width, this.options.height,
        distance, this.options.effort,
        fmtIndex, this.options.hasAlpha ? 1 : 0,
        progressiveDc, progressiveAc, qProgressiveAc, buffering,
      );
      if (this.wasmEncState === 0) throw new Error("JXL streaming encoder: pixel buffer allocation failed");
      this.streamingInputActive = true;
    }
    return module;
  }

  finish(): void {
    this.finished = true;
    this.finishResolve?.();
    this.finishResolve = null;
  }

  async *chunks(): AsyncIterable<ArrayBuffer | Uint8Array> {
    if (this.chunksStarted) {
      throw new Error("Encoder chunks() may only be consumed once.");
    }
    this.chunksStarted = true;

    await this.waitUntilFinished();
    if (this.cancelled) return;
    await this.pendingPushPromise;
    if (this.pendingPushError !== null) throw this.pendingPushError;

    // Module may not be loaded yet if no pixels were pushed (zero-byte edge case).
    const module = this.wasmModule ?? await loadLibjxlModule();
    if (this.options.format === "rgba16" || this.options.format === "rgbaf32") {
      const encFn = this.options.format === "rgba16" ? "_jxl_wasm_encode_rgba16" : "_jxl_wasm_encode_rgbaf32";
      if (typeof module[encFn] !== "function") {
        throw new CapabilityMissing(`${this.options.format} encode requires a rebuilt WASM with multi-format bridge`);
      }
    }

    if (this.queuedPixelBytes !== this.pixelByteTotal) {
      throw new Error(`JXL encode expected ${this.pixelByteTotal} bytes for ${this.options.format}, got ${this.queuedPixelBytes}`);
    }

    let compressedBytes = 0;

    if (this.streamingInputActive && this.wasmEncState !== 0) {
      // #16: Streaming input path — pixels already in WASM pixel buffer.
      // enc_finish runs the encode; enc_take_chunk drains the output.
      try {
        const rc = module._jxl_wasm_enc_finish!(this.wasmEncState);
        if (rc !== 0) throw new Error(`JXL streaming encode finish failed (${rc})`);
        let chunkHandle: number;
        while ((chunkHandle = module._jxl_wasm_enc_take_chunk!(this.wasmEncState)) !== 0) {
          const chunk = takeBuffer(module, chunkHandle, "encode");
          compressedBytes += chunk.data.byteLength;
          yield chunk.data;
        }
      } finally {
        module._jxl_wasm_enc_free!(this.wasmEncState);
        this.wasmEncState = 0;
      }
    } else {
      // Buffered path — accumulate pixelChunks in JS, copy to WASM, then encode.
      // Write pixel chunks directly into WASM heap — no concatBytes allocation.
      // Release each JS chunk reference immediately after copying to reduce peak JS heap overlap.
      const ptr = module._malloc(this.pixelByteTotal);
      try {
        let offset = 0;
        for (let i = 0; i < this.pixelChunks.length; i++) {
          const ch = this.pixelChunks[i]!;
          module.HEAPU8.set(ch, ptr + offset);
          offset += ch.byteLength;
          this.pixelChunks[i] = EMPTY_U8;
        }
        this.pixelChunks = [];
        this.queuedPixelBytes = 0;

        const distance = this.options.distance ?? distanceFromQuality(this.options.quality);
        const hasAlpha = this.options.hasAlpha ? 1 : 0;
        const caps = getCapabilities(module);
        const { progressiveDc, progressiveAc, qProgressiveAc, buffering } = resolveEncoderBridgeSettings(this.options);

        // Sidecar thumbnails — yield smallest first for faster first-paint.
        if (this.sortedSidecarSizes.length > 0 && caps.sidecars) {
          const sortedSizes = this.sortedSidecarSizes;
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
            let handle = module._jxl_wasm_encode_rgba8_with_sidecars!(
              ptr, this.options.width, this.options.height,
              distance, this.options.effort, hasAlpha,
              dimsPtr, sortedSizes.length,
            );
            while (handle !== 0) {
              // Capture next pointer before takeBuffer frees handle.
              const next = module._jxl_wasm_buffer_next!(handle);
              try {
                const buf = takeBuffer(module, handle, "encode");
                compressedBytes += buf.data.byteLength;
                yield buf.data;
              } catch (err) {
                // takeBuffer already freed handle; free remaining chain, then rethrow.
                let cur = next;
                while (cur !== 0) {
                  const nxt = module._jxl_wasm_buffer_next!(cur);
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
        } else if (caps.streamingEncode) {
          // #11: streaming encoder — yields 256 KB chunks, reducing peak JS heap usage.
          const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : 0;
            const encState = module._jxl_wasm_enc_create!();
            try {
            const rc = module._jxl_wasm_enc_push_pixels!(encState, ptr, this.options.width, this.options.height, distance, this.options.effort, fmtIndex, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering);
            if (rc !== 0) throw new Error(`JXL streaming encode failed (${rc})`);
            let chunkHandle: number;
            while ((chunkHandle = module._jxl_wasm_enc_take_chunk!(encState)) !== 0) {
              const chunk = takeBuffer(module, chunkHandle, "encode");
              compressedBytes += chunk.data.byteLength;
              yield chunk.data;
            }
          } finally {
            module._jxl_wasm_enc_free!(encState);
          }
        } else {
          // Standard single-image encode path
          let handle: number;

          // Use metadata path if any metadata is present.
          // fmt: 0=rgba8, 1=rgba16, 2=rgbaf32 — matches bridge parameter order.
          const fmt = this.options.format === "rgba16" ? 1 : this.options.format === "rgbaf32" ? 2 : 0;
          const hasMetadata = this.options.iccProfile !== null || this.options.exif !== null || this.options.xmp !== null;
          if (hasMetadata && module._jxl_wasm_encode_rgba8_with_metadata) {
            const iccView = this.options.iccProfile ? copyOrBorrowInput(this.options.iccProfile, false) : new Uint8Array(0);
            const exifView = this.options.exif ? copyOrBorrowInput(this.options.exif, false) : new Uint8Array(0);
            const xmpView = this.options.xmp ? copyOrBorrowInput(this.options.xmp, false) : new Uint8Array(0);

            const iccPtr = iccView.byteLength > 0 ? module._malloc(iccView.byteLength) : 0;
            const exifPtr = exifView.byteLength > 0 ? module._malloc(exifView.byteLength) : 0;
            const xmpPtr = xmpView.byteLength > 0 ? module._malloc(xmpView.byteLength) : 0;

            try {
              if (iccPtr !== 0) module.HEAPU8.set(iccView, iccPtr);
              if (exifPtr !== 0) module.HEAPU8.set(exifView, exifPtr);
              if (xmpPtr !== 0) module.HEAPU8.set(xmpView, xmpPtr);

              handle = module._jxl_wasm_encode_rgba8_with_metadata(
                ptr, this.options.width, this.options.height,
                distance, this.options.effort, fmt, hasAlpha,
                progressiveDc, progressiveAc, qProgressiveAc, buffering,
                iccPtr, iccView.byteLength,
                exifPtr, exifView.byteLength,
                xmpPtr, xmpView.byteLength
              );
            } finally {
              if (iccPtr !== 0) module._free(iccPtr);
              if (exifPtr !== 0) module._free(exifPtr);
              if (xmpPtr !== 0) module._free(xmpPtr);
            }
          } else {
            // Fallback: plain encode (no metadata) used when bridge fn absent
            // or when no metadata was provided.
            if (this.options.format === "rgba16" && module._jxl_wasm_encode_rgba16) {
              handle = module._jxl_wasm_encode_rgba16(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering);
            } else if (this.options.format === "rgbaf32" && module._jxl_wasm_encode_rgbaf32) {
              handle = module._jxl_wasm_encode_rgbaf32(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering);
            } else {
              handle = module._jxl_wasm_encode_rgba8(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering);
            }
          }
          const encoded = takeBuffer(module, handle, "encode");
          compressedBytes += encoded.data.byteLength;
          yield encoded.data;
        }
      } finally {
        module._free(ptr);
        this.pixelChunks = [];
        this.queuedPixelBytes = 0;
      }
    }

    this.encodeStats = { originalBytes: this.pixelByteTotal, compressedBytes, ratio: this.pixelByteTotal > 0 ? compressedBytes / this.pixelByteTotal : 0 };
  }

  getStats(): EncodeStats | null { return this.encodeStats; }

  cancel(_reason?: string): void {
    this.cancelled = true;
    this.freeWasmState();
    this.finishResolve?.();
    this.finishResolve = null;
  }

  dispose(): void {
    this.pixelChunks = [];
    this.queuedPixelBytes = 0;
    this.cancelled = true;
    this.freeWasmState();
    this.finishResolve?.();
    this.finishResolve = null;
  }

  private freeWasmState(): void {
    if (this.wasmEncState !== 0 && this.wasmModule !== null) {
      this.wasmModule._jxl_wasm_enc_free!(this.wasmEncState);
      this.wasmEncState = 0;
    }
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
  const tier = _forcedTier ?? detectTier();
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

interface JxlCapabilities {
  progressiveDecode: boolean;
  streamingEncode: boolean;
  streamingInput: boolean;
  sidecars: boolean;
  jpegTranscode: boolean;
}

const capabilityCache = new WeakMap<LibjxlWasmModule, JxlCapabilities>();

function getCapabilities(module: LibjxlWasmModule): JxlCapabilities {
  let caps = capabilityCache.get(module);
  if (caps !== undefined) return caps;
  caps = {
    progressiveDecode: typeof module._jxl_wasm_dec_create === "function",
    streamingEncode:
      typeof module._jxl_wasm_enc_create === "function" &&
      typeof module._jxl_wasm_enc_push_pixels === "function" &&
      typeof module._jxl_wasm_enc_take_chunk === "function" &&
      typeof module._jxl_wasm_enc_free === "function",
    streamingInput:
      typeof module._jxl_wasm_enc_create_image === "function" &&
      typeof module._jxl_wasm_enc_push_chunk === "function" &&
      typeof module._jxl_wasm_enc_finish === "function" &&
      typeof module._jxl_wasm_enc_take_chunk === "function" &&
      typeof module._jxl_wasm_enc_free === "function",
    sidecars:
      typeof module._jxl_wasm_encode_rgba8_with_sidecars === "function" &&
      typeof module._jxl_wasm_buffer_next === "function",
    jpegTranscode: typeof module._jxl_wasm_transcode_jpeg_to_jxl === "function",
  };
  capabilityCache.set(module, caps);
  return caps;
}

function callDecodeFromPtr(module: LibjxlWasmModule, ptr: number, size: number, downsample: number, format: PixelFormat, region?: Region | null): LibjxlBuffer {
  let handle = 0;
  try {
    // #10: use C++ region crop when available — avoids shipping full-image pixels to JS.
    if (region != null) {
      if (format === "rgba16" && module._jxl_wasm_decode_rgba16_region) {
        handle = module._jxl_wasm_decode_rgba16_region(ptr, size, region.x, region.y, region.w, region.h, downsample);
      } else if (format === "rgbaf32" && module._jxl_wasm_decode_rgbaf32_region) {
        handle = module._jxl_wasm_decode_rgbaf32_region(ptr, size, region.x, region.y, region.w, region.h, downsample);
      } else if (module._jxl_wasm_decode_rgba8_region) {
        handle = module._jxl_wasm_decode_rgba8_region(ptr, size, region.x, region.y, region.w, region.h, downsample);
      } else {
        handle = callDecodeNoRegion(module, ptr, size, downsample, format);
      }
    } else {
      handle = callDecodeNoRegion(module, ptr, size, downsample, format);
    }
    return readBufferView(module, handle, "decode");
  } catch (err) {
    // readBufferView does not free on error — we own handle here.
    if (handle !== 0) module._jxl_wasm_buffer_free(handle);
    throw err;
  }
}

function callDecodeNoRegion(module: LibjxlWasmModule, ptr: number, size: number, downsample: number, format: PixelFormat): number {
  if (format === "rgba16" && module._jxl_wasm_decode_rgba16) {
    return module._jxl_wasm_decode_rgba16(ptr, size, downsample);
  } else if (format === "rgbaf32" && module._jxl_wasm_decode_rgbaf32) {
    return module._jxl_wasm_decode_rgbaf32(ptr, size, downsample);
  }
  return module._jxl_wasm_decode_rgba8(ptr, size, downsample);
}

// Read buffer metadata without freeing handle. Caller is responsible for freeing.
function readBufferView(module: LibjxlWasmModule, handle: number, operation: string): LibjxlBuffer {
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

// Read buffer and always free handle (in finally), whether success or failure.
function takeBuffer(module: LibjxlWasmModule, handle: number, operation: string): LibjxlBuffer {
  try {
    return readBufferView(module, handle, operation);
  } finally {
    if (handle !== 0) module._jxl_wasm_buffer_free(handle);
  }
}

function normalizeBitsPerSample(value: number): 8 | 16 | 32 {
  if (value === 16 || value === 32) return value;
  return 8;
}

function bytesPerChannelForFormat(format: PixelFormat): 1 | 2 | 4 {
  return format === "rgbaf32" ? 4 : format === "rgba16" ? 2 : 1;
}

const MAX_PIXEL_BYTES = 1024 * 1024 * 1024; // 1 GiB hard limit before WASM malloc

function expectedPixelBytes(width: number, height: number, format: PixelFormat, maxBytes = MAX_PIXEL_BYTES): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid image dimensions: ${width} × ${height}`);
  }
  const bpc = bytesPerChannelForFormat(format);
  const bytes = width * height * 4 * bpc;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`Pixel byte size overflow for ${width} × ${height} ${format}`);
  }
  if (bytes > maxBytes) {
    throw new Error(`Image too large for WASM encode: ${bytes} bytes exceeds limit ${maxBytes}`);
  }
  return bytes;
}

function distanceFromQuality(quality: number | null): number {
  if (quality === null) return 1;
  if (!Number.isFinite(quality)) throw new Error(`Invalid JXL quality: ${quality}`);
  const q = Math.max(0, Math.min(100, quality));
  return ((100 - q) * 15) / 100;
}

// Borrow or copy input depending on caller's ownership. ArrayBuffer is always zero-copy (view only).
function copyOrBorrowInput(value: ArrayBuffer | Uint8Array, copy: boolean): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return copy ? value.slice() : value;
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

  if (downsample === 1) {
    // Crop-only: copy whole rows at once — much faster than per-pixel copy.
    for (let y = 0; y < outHeight; y++) {
      const srcStart = ((sourceRegion.y + y) * width + sourceRegion.x) * stride;
      out.set(data.subarray(srcStart, srcStart + outWidth * stride), y * outWidth * stride);
    }
  } else if (stride === 4) {
    // rgba8 downsample — direct element assignment; sy hoisted out of inner loop.
    for (let y = 0; y < outHeight; y++) {
      const srcRowBase = (sourceRegion.y + Math.min(sourceRegion.h - 1, y * downsample)) * width * 4;
      const dstRowBase = y * outWidth * 4;
      for (let x = 0; x < outWidth; x++) {
        const src = srcRowBase + (sourceRegion.x + Math.min(sourceRegion.w - 1, x * downsample)) * 4;
        const dst = dstRowBase + x * 4;
        out[dst]     = data[src]!;
        out[dst + 1] = data[src + 1]!;
        out[dst + 2] = data[src + 2]!;
        out[dst + 3] = data[src + 3]!;
      }
    }
  } else {
    // General path (rgba16 / rgbaf32 downsample) — sy hoisted out of inner loop.
    for (let y = 0; y < outHeight; y++) {
      const srcRowBase = (sourceRegion.y + Math.min(sourceRegion.h - 1, y * downsample)) * width * stride;
      const dstRowBase = y * outWidth * stride;
      for (let x = 0; x < outWidth; x++) {
        const src = srcRowBase + (sourceRegion.x + Math.min(sourceRegion.w - 1, x * downsample)) * stride;
        const dst = dstRowBase + x * stride;
        out.set(data.subarray(src, src + stride), dst);
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
  // cover: scale up so both dims >= target, then center-crop
  const scale = Math.max(targetW / srcW, targetH / srcH);
  const scaledW = Math.max(targetW, Math.round(srcW * scale));
  const scaledH = Math.max(targetH, Math.round(srcH * scale));
  const scaled = bilinearResize(src, srcW, srcH, scaledW, scaledH, stride);
  const cropX = Math.floor((scaledW - targetW) / 2);
  const cropY = Math.floor((scaledH - targetH) / 2);
  const cropped = applyRegionAndDownsample(scaled, scaledW, scaledH, { x: cropX, y: cropY, w: targetW, h: targetH }, 1, bpc);
  return { data: cropped.data, width: targetW, height: targetH };
}

function pickDownsample(_options: { targetWidth?: number | null; targetHeight?: number | null }): 1 | 2 | 4 | 8 {
  // Source dims unknown at call time — resize post-decode handles scale-to-target.
  return 1;
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
