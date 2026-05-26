export type PixelFormat = "rgba8" | "rgba16" | "rgbaf32";
export type DecodeStage = "header" | "dc" | "pass" | "final";
export type Region = {
    x: number;
    y: number;
    w: number;
    h: number;
};
export interface ImageInfo {
    width: number;
    height: number;
    bitsPerSample: 8 | 16 | 32;
    hasAlpha: boolean;
    hasAnimation: boolean;
    jpegReconstructionAvailable: boolean;
}
export type DecodeEvent = {
    type: "header";
    info: ImageInfo;
} | {
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
} | {
    type: "final";
    info: ImageInfo;
    pixels: ArrayBuffer | Uint8Array;
    format: PixelFormat;
    region?: Region;
    pixelStride: number;
    sourceScale?: number;
    progressiveRegion?: boolean;
    regionFallback?: "full-frame-then-crop";
} | {
    type: "budget_exceeded";
    stage: DecodeStage;
    info: ImageInfo;
    pixels: ArrayBuffer | Uint8Array;
    format: PixelFormat;
    pixelStride: number;
} | {
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
    _jxl_wasm_dec_create?(format: number, wantProgressive: number): number;
    _jxl_wasm_dec_push?(state: number, dataPtr: number, size: number): number;
    _jxl_wasm_dec_close_input?(state: number): void;
    _jxl_wasm_dec_width?(state: number): number;
    _jxl_wasm_dec_height?(state: number): number;
    _jxl_wasm_dec_error?(state: number): number;
    _jxl_wasm_dec_take_flushed?(state: number): number;
    _jxl_wasm_dec_take_final?(state: number): number;
    _jxl_wasm_dec_free?(state: number): void;
    _jxl_wasm_encode_rgba8_with_sidecars?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, sidecarDimsPtr: number, numSidecars: number): number;
    _jxl_wasm_buffer_next?(handle: number): number;
    _jxl_wasm_decode_rgba8_region?(inputPtr: number, inputSize: number, cx: number, cy: number, cw: number, ch: number, downsample: number): number;
    _jxl_wasm_decode_rgba16_region?(inputPtr: number, inputSize: number, cx: number, cy: number, cw: number, ch: number, downsample: number): number;
    _jxl_wasm_decode_rgbaf32_region?(inputPtr: number, inputSize: number, cx: number, cy: number, cw: number, ch: number, downsample: number): number;
    _jxl_wasm_enc_create?(): number;
    _jxl_wasm_enc_push_pixels?(state: number, pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number): number;
    _jxl_wasm_enc_take_chunk?(state: number): number;
    _jxl_wasm_enc_error?(state: number): number;
    _jxl_wasm_enc_free?(state: number): void;
    _jxl_wasm_transcode_jpeg_to_jxl?(jpegPtr: number, jpegSize: number): number;
    _jxl_wasm_enc_create_image?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number): number;
    _jxl_wasm_enc_push_chunk?(state: number, dataPtr: number, size: number): number;
    _jxl_wasm_enc_finish?(state: number): number;
}
type JxlModuleFactory = () => Promise<LibjxlWasmModule>;
export declare class CapabilityMissing extends Error {
    readonly code = "CapabilityMissing";
    readonly cause?: unknown;
    constructor(message: string, cause?: unknown);
}
export type Tier = "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar";
export interface WrapperCapabilities {
    regionDecode: boolean;
    exactSizeDecode: boolean;
    progressiveRegionDecode: boolean;
    tileAlignedRegionDecode: boolean;
    arbitraryRegionDecode: boolean;
    availableDownsampleFactors: readonly number[];
}
export interface DecodeGridInfo {
    tileWidth?: number;
    tileHeight?: number;
    preferredRegionAlign?: number;
    lodLevels?: readonly number[];
}
export declare function detectTier(): Tier;
/**
 * Returns a sensible default effort level for the current WASM tier.
 * Scalar workers get a lower effort to avoid blocking the thread; SIMD-MT
 * workers get full effort since they can use parallel libjxl codepaths.
 */
export declare function recommendedEffort(): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export declare function setJxlModuleFactoryForTesting(factory: JxlModuleFactory | null): void;
/**
 * Override the WASM tier used on the next module load.
 * Pass null to restore auto-detection via detectTier().
 * Resets the cached module so the next encode/decode reloads with the new tier.
 */
export declare function setForcedTier(tier: Tier | null): void;
export declare function getForcedTier(): Tier | null;
export declare function createDecoder(options: DecoderOptions): JxlDecoder;
export declare function createEncoder(options: EncoderOptions): JxlEncoder;
/**
 * Losslessly transcode a JPEG file to JXL without pixel expansion.
 * The resulting JXL embeds the original JPEG bitstream for round-trip fidelity.
 * Requires a WASM build that includes the #15 bridge (jxl_wasm_transcode_jpeg_to_jxl).
 */
export declare function transcodeJpegToJxl(jpeg: ArrayBuffer | Uint8Array): Promise<Uint8Array>;
/** Start loading the WASM module immediately. Call during app startup to hide cold-start latency. */
export declare function preloadJxlModule(): void;
export declare function getWrapperCapabilities(): WrapperCapabilities;
export declare function getDecodeGridInfo(): DecodeGridInfo;
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
export declare function decodeViewport(options: DecodeViewportOptions): JxlDecoder;
export interface DecodeRegionLodOptions {
    format: PixelFormat;
    region?: Region | null;
    targetLongEdge: number;
}
export declare function decodeRegionLod(options: DecodeRegionLodOptions): JxlDecoder;
export declare function normalizedToPixelExtent(norm: {
    x: number;
    y: number;
    w: number;
    h: number;
}, imageWidth: number, imageHeight: number): Region;
export declare function pixelToNormalizedExtent(region: Region, imageWidth: number, imageHeight: number): {
    x: number;
    y: number;
    w: number;
    h: number;
};
export {};
//# sourceMappingURL=facade.d.ts.map