export type PixelFormat = "rgba8" | "rgba16" | "rgbaf32";
export type DecodeStage = "header" | "dc" | "pass" | "final";
export type Region = {
    x: number;
    y: number;
    w: number;
    h: number;
};
export type ProgressiveDetail = "dc" | "lastPasses" | "passes" | "dcProgressive";
export type CachePolicy = "onFirst" | "onFinal" | "onProgress" | "disabled";
export declare const DOWNSAMPLE_THUMBNAILS = 2;
export declare const DOWNSAMPLE_GRID = 4;
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
    frameIndex?: number;
    frameDuration?: number;
    frameName?: string;
    animTicksPerSecond?: number;
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
    frameIndex?: number;
    frameDuration?: number;
    frameName?: string;
    isLastFrame?: boolean;
    animTicksPerSecond?: number;
    animLoopCount?: number;
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
} | {
    type: "preview";
    info: ImageInfo;
    pixels: ArrayBuffer | Uint8Array;
    format: PixelFormat;
    pixelStride: number;
    isFinal?: boolean;
};
export interface DecoderOptions {
    format: PixelFormat;
    region?: Region | null;
    downsample?: 1 | 2 | 4 | 8;
    progressionTarget: "header" | "dc" | "pass" | "final";
    emitEveryPass: boolean;
    progressiveDetail?: ProgressiveDetail;
    /**
     * Strip ICC profile from decoded output.
     * @note **WASM no-op.** `_jxl_wasm_dec_create` has no ICC-strip parameter.
     * ICC is always preserved in the WASM decoder path. Honoured by jxl-native.
     */
    preserveIcc: boolean;
    /**
     * Extract and emit EXIF/XMP metadata alongside decoded frames.
     * @note **WASM no-op.** `_jxl_wasm_dec_create` has no metadata parameter.
     * Metadata is never extracted in the WASM decoder path. Honoured by jxl-native.
     */
    preserveMetadata: boolean;
    /**
     * Zero-based frame index for multi-frame JXL animations. Default 0 (first frame).
     * @note **WASM no-op.** The WASM decoder always decodes the full stream; frame
     * selection is not supported. Honoured by jxl-native.
     */
    frameIndex?: number;
    /**
     * Emit early DC-only preview before full progressive decode.
     * @note **WASM no-op** in the decoder path — preview emission is controlled by
     * `progressiveDetail` and the encode-side `previewFirst` option. This field is
     * read by higher-level layers only.
     */
    previewFirst?: boolean;
    /** Experimental: suppress duplicate progressive snapshots by sampled hash. Default false. */
    suppressDuplicateProgress?: boolean;
    /**
     * Cache policy: when to store decoded frames. Default "onFinal".
     * @note Handled at the jxl-cache / jxl-session layer. The WASM facade ignores it.
     */
    cachePolicy?: CachePolicy;
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
    progressiveAc?: 0 | 1 | 2;
    qProgressiveAc?: 0 | 1 | 2;
    groupOrder?: 0 | 1;
    /** Encoder-side downsampling factor. -1/1 = no downsampling; 2/4/8 = halve/quarter/eighth the frame before entropy coding. */
    resampling?: -1 | 1 | 2 | 4 | 8;
    /** Number of DC layers to include (0 = none, 1 = one DC layer, 2 = two). Only meaningful when progressive=true. */
    progressiveDc?: 0 | 1 | 2;
    /** Modular encoding mode. -1=auto, 0=VarDCT, 1=Modular. */
    modular?: -1 | 0 | 1;
    /** Brotli compression effort for entropy coding (0–11). -1 = encoder default. */
    brotliEffort?: -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
    /** Trade encode work for faster decode (0–4). Higher = faster decode, larger file. */
    decodingSpeed?: 0 | 1 | 2 | 3 | 4;
    /** Simulate photon noise at this ISO equivalent. 0 = disabled. */
    photonNoiseIso?: number;
    /** Edge-preserving filter strength (0=off, 1–3=increasing). -1=encoder default. */
    epf?: -1 | 0 | 1 | 2 | 3;
    /** Gabor-like unsharpening pre-pass (0=off, 1=on). -1=encoder default. */
    gaborish?: -1 | 0 | 1;
    /** Dots/grain detection and preservation (0=off, 1=on). -1=encoder default. */
    dots?: -1 | 0 | 1;
    /** Color transform (0=XYB, 1=None, 2=YCbCr). -1=encoder default. */
    colorTransform?: -1 | 0 | 1 | 2;
    previewFirst: boolean;
    chunked: boolean;
    /** Max dimensions (px) of sidecar thumbnails to yield before the full image. Sorted ascending. */
    sidecarSizes?: readonly number[];
    /** When false, skip the defensive .slice() copy on pushPixels() — caller must not mutate the buffer after push returns. Default true. */
    copyInput?: boolean;
    /**
     * Escape hatch for advanced/experimental libjxl frame settings (patches, future tools, etc.).
     *
     * Use the named constants in `JxlFrameSetting`.
     *
     * @note **WASM no-op.** `_jxl_wasm_enc_create_image_adv` is not implemented in
     * `bridge.cpp` and is not present in the compiled WASM binary. All entries are
     * silently dropped in the WASM path. Use first-class options (`epf`, `gaborish`,
     * `dots`, `decodingSpeed`, etc.) for settings that have named equivalents.
     * Honoured by jxl-native (which calls `JxlEncoderFrameSettingsSetOption` directly).
     *
     * @example
     * createEncoder({
     *   ...baseOptions,
     *   advancedFrameSettings: [
     *     { id: JxlFrameSetting.PATCHES, value: 1 }   // enable dictionary patches
     *   ]
     * });
     */
    advancedFrameSettings?: Array<{
        id: number;
        value: number;
    }>;
    /**
     * Extra channels to encode alongside the main image (Phase 2 full support).
     * Each descriptor's pixel data is supplied out-of-band for the low-level path
     * (or future high-level Encoder extension). The 72-byte packed descriptor form
     * (matching WasmExtraChannel in bridge.cpp) is used for the WASM FFI.
     * (serializeExtraChannelsForWasm + post-malloc plane_ptr writes by caller.)
     */
    extraChannels?: ExtraChannel[];
}
/**
 * Named constants for common JXL_ENC_FRAME_SETTING_* values.
 * Use with the `advancedFrameSettings` escape hatch for experimental/advanced features
 * (patches, future spline controls, etc.).
 *
 * These are intentionally minimal — the escape hatch exists precisely so we do not
 * need to expose every possible libjxl knob as a first-class option.
 */
export declare const JxlFrameSetting: {
    /** Enables or disables patches generation. -1 default, 0 disable, 1 enable. */
    readonly PATCHES: 8;
};
/**
 * Supported extra channel types per the JXL Extra Channel extension.
 * 'spot' may carry SpotColorInfo. 'reservedN' and 'unknown' exist for forward compat and
 * custom/legacy payloads.
 */
export type ExtraChannelType = 'alpha' | 'depth' | 'selection' | 'spot' | 'thermal' | 'reserved0' | 'reserved1' | 'reserved2' | 'reserved3' | 'reserved4' | 'reserved5' | 'reserved6' | 'reserved7' | 'unknown';
/** ICC-relative or display-referred spot color for a spot extra channel (0..1 range). */
export interface SpotColorInfo {
    red: number;
    green: number;
    blue: number;
    solidity: number;
}
/**
 * Descriptor for an extra channel to be encoded with the main image.
 * Only a subset of fields are meaningful for any given `type`.
 */
export interface ExtraChannel {
    type: ExtraChannelType;
    bitsPerSample: number;
    /** Optional. Used for certain channel types (e.g. subsampling control). */
    dimShift?: number;
    /** Human-readable or ICC-aware name. Recommended for all non-alpha channels. */
    name?: string;
    /** Per-channel distance (Phase 1 / encode). 0 = lossless for the channel. */
    distance?: number;
    /** Only used when type === 'spot'. */
    spotColor?: SpotColorInfo;
    /** Optional custom resampling factor for this channel. */
    resampling?: 1 | 2 | 4 | 8;
}
/**
 * Metadata for an extra channel present after decoding (symmetric to ExtraChannel).
 * Encode-only hints (distance, resampling) are omitted; the type is readonly.
 */
export type DecodedExtraChannel = Readonly<Omit<ExtraChannel, 'distance' | 'resampling'>>;
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
    HEAP32: Int32Array;
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
    _jxl_wasm_encode_rgba8_with_metadata_adv?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, idsPtr: number, valuesPtr: number, count: number): number;
    _jxl_wasm_buffer_data(handle: number): number;
    _jxl_wasm_buffer_size(handle: number): number;
    _jxl_wasm_buffer_width(handle: number): number;
    _jxl_wasm_buffer_height(handle: number): number;
    _jxl_wasm_buffer_bits_per_sample(handle: number): number;
    _jxl_wasm_buffer_has_alpha(handle: number): number;
    _jxl_wasm_buffer_error?(handle: number): number;
    _jxl_wasm_buffer_free(handle: number): void;
    _jxl_wasm_dec_create?(format: number, progressiveDetail: number): number;
    _jxl_wasm_dec_create_x?(format: number, progressiveDetail: number, flags: number): number;
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
    _jxl_wasm_enc_create_image?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number): number;
    _jxl_wasm_enc_create_image_x?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, jpegKeepExif: number, jpegKeepXmp: number, jpegKeepJumbf: number, alreadyDownsampled: number, upsamplingMode: number, ecResampling: number): number;
    _jxl_wasm_enc_create_image_y?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, epf: number, gaborish: number, dots: number, patches: number, colorTransform: number, centerX: number, centerY: number, jpegKeepExif: number, jpegKeepXmp: number, jpegKeepJumbf: number, alreadyDownsampled: number, upsamplingMode: number, ecResampling: number): number;
    _jxl_wasm_enc_create_image_adv?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, idsPtr: number, valuesPtr: number, count: number): number;
    _jxl_wasm_enc_pixels_ptr?(state: number, size: number): number;
    _jxl_wasm_enc_advance_written?(state: number, size: number): number;
    _jxl_wasm_enc_push_chunk?(state: number, dataPtr: number, size: number): number;
    _jxl_wasm_enc_finish?(state: number): number;
    _jxl_wasm_encode_tiled_rgba8?(pixelsPtr: number, width: number, height: number, tileSize: number, distance: number, effort: number, hasAlpha: number): number;
    _jxl_wasm_decode_region_tiled_rgba8?(inputPtr: number, inputSize: number, tileSize: number, regionX: number, regionY: number, regionW: number, regionH: number): number;
    _jxl_wasm_encode_tile_container_rgba8?(pixelsPtr: number, width: number, height: number, tileSize: number, distance: number, effort: number, hasAlpha: number): number;
    _jxl_wasm_encode_tile_container_rgba16?(pixelsPtr: number, width: number, height: number, tileSize: number, distance: number, effort: number, hasAlpha: number): number;
    _jxl_wasm_decode_tile_container_region_rgba8?(inputPtr: number, inputSize: number, regionX: number, regionY: number, regionW: number, regionH: number): number;
    _jxl_wasm_decode_tile_container_region_rgba16?(inputPtr: number, inputSize: number, regionX: number, regionY: number, regionW: number, regionH: number): number;
    _jxl_wasm_encode_rgba8_with_extra_channels?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, ecDescPtr: number, numEc: number): number;
    _jxl_wasm_get_extra_channels?(inputPtr: number, inputSize: number): number;
    _jxl_wasm_butteraugli_compare?(ptr1: number, ptr2: number, width: number, height: number): number;
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
export declare const EC_BYTES = 72;
/**
 * Serializes ExtraChannel[] to a 72*N byte ArrayBuffer for the EC encode FFI.
 * Names UTF-8 truncated to 31 bytes, zero-padded. plane_ptr/plane_size left as 0 (filled by caller after malloc).
 * Returns { buffer, view } for direct DataView writes of pointers/sizes by caller.
 * Offsets match bridge.cpp WasmExtraChannel exactly (critical for num_ec > 0; prior 56B caused overlap).
 */
export declare function serializeExtraChannelsForWasm(channels: ExtraChannel[]): {
    buffer: ArrayBuffer;
    view: DataView;
};
export declare function createEncoder(options: EncoderOptions): JxlEncoder;
/**
 * Losslessly transcode a JPEG file to JXL without pixel expansion.
 * The resulting JXL embeds the original JPEG bitstream for round-trip fidelity.
 * Requires a WASM build that includes the #15 bridge (jxl_wasm_transcode_jpeg_to_jxl).
 */
export declare function transcodeJpegToJxl(jpeg: ArrayBuffer | Uint8Array): Promise<Uint8Array>;
/**
 * Compute Butteraugli perceptual distance between two RGBA8 images.
 * Both pixel buffers must represent the same width×height image in RGBA8 format.
 * Returns the p3 Butteraugli distance (0 = identical, ~1.0 = imperceptible, >2.0 = noticeable).
 * Requires a WASM build with the butteraugli bridge (jxl_wasm_butteraugli_compare).
 */
export declare function computeButteraugli(pixels1: ArrayBuffer | Uint8Array, pixels2: ArrayBuffer | Uint8Array, width: number, height: number): Promise<number>;
/**
 * Extract embedded JPEG reconstruction from JXL container (if present).
 * Container JXLs (created with encodeTileContainerRgba8/JXTC) may embed
 * the original JPEG bitstream for fast native preview. Scans container
 * header for jbrd (JPEG Reconstruction) box.
 * Returns null if no embedded JPEG or not a container JXL.
 */
export declare function extractJpegReconstructionFromJxl(jxlData: ArrayBuffer | Uint8Array): Uint8Array | null;
/**
 * Legacy tiled multi-frame JXL encode.
 * Each tile becomes one JXL frame with layer_info.have_crop = JXL_TRUE.
 * Keep this only for compatibility with older callers. Prefer the JXTC tile
 * container path (`encodeTileContainerRgba8` / `decodeTileContainerRegionRgba8`)
 * for new work; it avoids the frame-walk overhead in libjxl and is much faster
 * for crop/ROI benchmarks.
 *
 * Requires a WASM build that includes the tile bridge
 * (jxl_wasm_encode_tiled_rgba8).
 *
 * @param tileSize must match the value passed to decodeTiledRegionRgba8.
 */
export declare function encodeTiledRgba8(pixels: ArrayBuffer | Uint8Array, width: number, height: number, options: {
    tileSize: number;
    distance?: number;
    effort?: number;
    hasAlpha?: boolean;
}): Promise<Uint8Array>;
/**
 * Legacy ROI decode for tiled multi-frame JXL produced by encodeTiledRgba8.
 * Prefer decodeTileContainerRegionRgba8 for new code; the JXTC container
 * avoids the frame-header walk that makes the tiled path significantly slower.
 * Only the JXL frames whose layer bounds overlap the region are decompressed;
 * other frames are skipped via JxlDecoderSkipFrames (header-only walk).
 *
 * Returns clamped region dimensions — caller should pre-clamp if exact size
 * is required.
 */
export declare function decodeTiledRegionRgba8(jxlBytes: ArrayBuffer | Uint8Array, options: {
    tileSize: number;
    x: number;
    y: number;
    w: number;
    h: number;
    onMetric?: (name: string, value: number) => void;
}): Promise<{
    pixels: Uint8Array;
    width: number;
    height: number;
}>;
/**
 * Encode RGBA8 as a JXTC tile container — N independent standalone JXL bitstreams
 * plus a byte-offset index. Decode with decodeTileContainerRegionRgba8 to retrieve
 * any rectangular region with zero frame-walk overhead.
 *
 * Compared to encodeTiledRgba8 (multi-frame JXL):
 *   - Same tile granularity
 *   - Slightly larger output (~5-10% overhead from per-tile JXL headers)
 *   - Vastly faster ROI decode in libjxl ≤0.11.x where SkipFrames doesn't skip work
 *
 * Output is NOT a standard JXL — it's a custom container format. Magic 'JXTC'.
 */
export declare function encodeTileContainerRgba8(pixels: ArrayBuffer | Uint8Array, width: number, height: number, options: {
    tileSize: number;
    distance?: number;
    effort?: number;
    hasAlpha?: boolean;
}): Promise<Uint8Array>;
/**
 * Encode RGBA16 as a JXTC tile container — N independent standalone JXL bitstreams
 * plus a byte-offset index. Decode with decodeTileContainerRegionRgba16 to retrieve
 * any rectangular region with zero frame-walk overhead.
 */
export declare function encodeTileContainerRgba16(pixels: ArrayBuffer | Uint8Array, width: number, height: number, options: {
    tileSize: number;
    distance?: number;
    effort?: number;
    hasAlpha?: boolean;
}): Promise<Uint8Array>;
/**
 * Decode a rectangular region from a JXTC tile container produced by
 * encodeTileContainerRgba8. Each overlapping tile is decoded as a standalone
 * JXL bitstream — zero frame-walk overhead. Performance is linear in number
 * of overlapping tiles, regardless of total image size.
 */
export declare function decodeTileContainerRegionRgba8(containerBytes: ArrayBuffer | Uint8Array, options: {
    x: number;
    y: number;
    w: number;
    h: number;
    onMetric?: (name: string, value: number) => void;
}): Promise<{
    pixels: Uint8Array;
    width: number;
    height: number;
}>;
/**
 * Decode a rectangular region from a JXTC tile container produced by
 * encodeTileContainerRgba16. Each overlapping tile is decoded as a standalone
 * JXL bitstream — zero frame-walk overhead. Performance is linear in number
 * of overlapping tiles, regardless of total image size.
 */
export declare function decodeTileContainerRegionRgba16(containerBytes: ArrayBuffer | Uint8Array, options: {
    x: number;
    y: number;
    w: number;
    h: number;
    onMetric?: (name: string, value: number) => void;
}): Promise<{
    pixels: Uint8Array;
    width: number;
    height: number;
}>;
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
    progressiveDetail?: ProgressiveDetail;
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