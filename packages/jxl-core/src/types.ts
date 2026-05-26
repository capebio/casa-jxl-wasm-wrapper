// jxl-core/src/types.ts
// Contract: Section 5 of casabio-jxl-wrapper-construction-spec-v2.md
// Do not add fields not present in the spec.

export type PixelFormat =
  | "rgba8"     // 4 channels, 8-bit, premultiplied alpha = false
  | "rgba16"    // 4 channels, 16-bit
  | "rgbaf32";  // 4 channels, 32-bit float (linear)

export interface ImageInfo {
  width: number;
  height: number;
  bitsPerSample: 8 | 16 | 32;
  hasAlpha: boolean;
  hasAnimation: boolean;
  iccProfile?: Uint8Array;          // present when the file carries one
  colorSpace?: ColorSpaceHint;      // hint derived when no ICC is present
  exif?: Uint8Array;                // raw EXIF box
  xmp?: Uint8Array;                 // raw XMP box
  jpegReconstructionAvailable: boolean;
}

export type ColorSpaceHint =
  | "srgb" | "display-p3" | "rec2020-pq" | "rec2020-hlg" | "linear-srgb" | "unknown";

export type DecodeStage =
  | "header"       // ImageInfo available
  | "dc"           // first useful low-frequency preview
  | "pass"         // intermediate progressive refinement
  | "final";       // full image complete

export interface DecodeFrameEvent {
  stage: DecodeStage;
  info: ImageInfo;
  pixels: ArrayBuffer;              // transferred
  format: PixelFormat;
  region?: Region;                  // present for tile/region decodes
  pixelStride: number;              // bytes per row (may exceed width * channels * bpc/8)
  sourceScale?: number;
  progressiveRegion?: boolean;
  regionFallback?: "full-frame-then-crop";
}

export interface Region {
  x: number; y: number; w: number; h: number;
}

export interface DecodeOptions {
  // What the caller wants out
  format: PixelFormat;              // requested output format
  preserveIcc?: boolean;            // default true
  preserveMetadata?: boolean;       // default true (EXIF + XMP)
  region?: Region;                  // crop decode
  downsample?: 1 | 2 | 4 | 8;       // request power-of-two downsample if codestream supports
  targetWidth?: number;
  targetHeight?: number;
  fitMode?: "contain" | "cover" | "stretch";
  // Progression
  progressionTarget?: "header" | "dc" | "pass" | "final"; // earliest stage to stop
  emitEveryPass?: boolean;          // default true for viewer, false for thumbnail
  // Scheduling
  priority?: "visible" | "near" | "background";
  budgetMs?: number;
  signal?: AbortSignal;
  // Telemetry
  onMetric?: (m: CodecMetric) => void;
}

export interface DecodeSession {
  readonly id: string;
  // Stream the bytes in; resolves when worker has accepted the chunk
  push(chunk: ArrayBuffer | Uint8Array): Promise<void>;
  // Signal end of input
  close(): Promise<void>;
  // Iterate frames as they emit
  frames(): AsyncIterable<DecodeFrameEvent>;
  // Await final completion; rejects on error or abort
  done(): Promise<ImageInfo>;
  // Cancel and release codec resources
  cancel(reason?: string): Promise<void>;
}

export interface EncodeStats {
  /** Raw pixel bytes: width × height × channels × bytesPerChannel. */
  originalBytes: number;
  /** Total JXL bytes written across all chunks (including sidecars). */
  compressedBytes: number;
  /** compressedBytes / originalBytes. Values below 1.0 indicate net compression. */
  ratio: number;
  /**
   * Cumulative byte offsets at sidecar boundaries. Length === sidecarSizes.length.
   * Entry i = number of bytes emitted after the i-th sidecar chunk; equivalently
   * the byte offset where the (i+1)-th chunk begins. The final main-image
   * codestream starts at sidecarOffsets[sidecarOffsets.length - 1] and ends at
   * compressedBytes. Omitted when no sidecars were requested or produced.
   *
   * Use with jxl-stream `fromRangePrefix` to fetch only the smallest sidecar:
   *   const firstSidecar = sidecarOffsets[0];
   *   stream.fromRangePrefix(url, { byteCount: firstSidecar });
   */
  sidecarOffsets?: readonly number[];
}

export interface EncodeOptions {
  format: PixelFormat;
  width: number;
  height: number;
  hasAlpha: boolean;
  // Color and metadata
  iccProfile?: Uint8Array;          // attach to output
  exif?: Uint8Array;
  xmp?: Uint8Array;
  // Quality knobs
  distance?: number;                // libjxl distance; 0 = lossless
  quality?: number;                 // 0-100, mapped via JxlEncoderDistanceFromQuality
  effort?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  // Progressive / streaming
  progressive?: boolean;            // enable progressive frames
  progressiveFlavor?: "dc" | "ac";  // DC-only or DC+AC refinement progression
  previewFirst?: boolean;           // bias for early bytes over compression
  chunked?: boolean;                // use JxlEncoderAddChunkedFrame for large inputs
  /**
   * Max dimension (px, long edge) of sidecar thumbnail(s) to yield BEFORE the
   * main image chunks. Sorted ascending so the smallest preview arrives first.
   * Requires a WASM build with the sidecar bridge (_jxl_wasm_encode_rgba8_with_sidecars).
   * Falls back to plain encode when the bridge is absent.
   * The leading `sidecarSizes.length` chunks from `chunks()` are the thumbnails.
   */
  sidecarSizes?: readonly number[];
  // Scheduling
  priority?: "visible" | "near" | "background";
  signal?: AbortSignal;
  onMetric?: (m: CodecMetric) => void;
}

export interface EncodeSession {
  readonly id: string;
  // Push pixels (one or many chunks for chunked encodes)
  pushPixels(chunk: ArrayBuffer, region?: Region): Promise<void>;
  // Signal end of pixel input
  finish(): Promise<void>;
  // Iterate output byte chunks as they emit.
  // If sidecarSizes was specified, the first sidecarSizes.length chunks are thumbnail JXLs.
  chunks(): AsyncIterable<ArrayBuffer>;
  // Await completion; resolves with total bytes written
  done(): Promise<number>;
  // Available after done() resolves. Null before completion or on error.
  getStats(): EncodeStats | null;
  cancel(reason?: string): Promise<void>;
}

export type CodecMetric =
  | { name: "time_to_header_ms"; value: number }
  | { name: "time_to_first_pixel_ms"; value: number }
  | { name: "time_to_final_ms"; value: number }
  | { name: "time_to_first_byte_ms"; value: number }
  | { name: "input_bytes"; value: number }
  | { name: "output_bytes"; value: number }
  | { name: "peak_memory_bytes"; value: number }
  | { name: "format_downcast"; value: number }      // emitted when output bpc < source bpc
  | { name: "region_fallback_full_frame"; value: 1 } // emitted when region decode falls back
  | { name: "decode_scale_used"; value: number }
  | { name: "decode_region_area"; value: number }
  | { name: "source_pixels_decoded"; value: number };

// Capabilities shape (spec Section 17)
export interface Capabilities {
  wasm: boolean;
  wasmSimd: boolean;
  wasmRelaxedSimd: boolean;    // requires wasmSimd
  wasmThreads: boolean;        // requires SAB + crossOriginIsolated
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  offscreenCanvas: boolean;
  imageBitmap: boolean;
  nativeJxlDecoder: boolean;
  selectedWasmBuild: "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar" | "none";
  libjxlVersion: string;
}

// Context options (spec Section 5 prose)
export interface ContextOptions {
  poolSize?: number;
  memoryCapBytes?: number;
  idleTimeoutMs?: number;
  wasmUrl?: string;
  cache?: CacheOptions;
}

export interface CacheOptions {
  persistent?: boolean;
  hotMaxBytes?: number;           // in-memory LRU cap; default 128 MiB browser
  persistentMaxBytes?: number;    // OPFS/fs cap; default 1 GiB
  persistentPath?: string;        // node: filesystem path
}

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
