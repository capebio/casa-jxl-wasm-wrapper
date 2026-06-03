export type PixelFormat = "rgba8" | "rgba16" | "rgbaf32" | "rgb8";
export type DecodeStage = "header" | "dc" | "pass" | "final";
export type Region = {
    x: number;
    y: number;
    w: number;
    h: number;
};
export type ProgressiveDetail = "dc" | "lastPasses" | "passes" | "dcProgressive";
export type ResamplingFactor = 1 | 2 | 4 | 8;
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
    /** Zero-based index of this frame in the animation sequence. */
    frameIndex?: number;
    /** Duration of this frame in ticks (see animTicksPerSecond). Undefined for non-animation files. */
    frameDuration?: number;
    /** Human-readable frame name embedded in the JXL bitstream, if any. */
    frameName?: string;
    /** True if this is the last frame of the animation. */
    isLastFrame?: boolean;
    /** Ticks per second for the animation (from JxlAnimationHeader). */
    animTicksPerSecond?: number;
    /** Total animation loop count (0 = infinite). */
    animLoopCount?: number;
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
    gainMap?: {
        data: Uint8Array;
    };
    /** Zero-based index of this frame in the animation sequence. */
    frameIndex?: number;
    /** Duration of this frame in ticks (see animTicksPerSecond). Undefined for non-animation files. */
    frameDuration?: number;
    /** Human-readable frame name embedded in the JXL bitstream, if any. */
    frameName?: string;
    /** True if this is the last frame of the animation. */
    isLastFrame?: boolean;
    /** Ticks per second for the animation (from JxlAnimationHeader). */
    animTicksPerSecond?: number;
    /** Total animation loop count (0 = infinite). */
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
};
export interface DecoderOptions {
    format: PixelFormat;
    region?: Region | null;
    downsample?: 1 | 2 | 4 | 8;
    progressionTarget: "header" | "dc" | "pass" | "final";
    emitEveryPass: boolean;
    progressiveDetail?: ProgressiveDetail;
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
    /**
     * Number of progressive DC layers for early low-frequency previews.
     * 0 = off, 1 = basic (default for progressive), 2 = more granular DC stages for more intermediate passes.
     * Higher values + groupOrder=1 give best "early recognizable" progressive behavior.
     * Requires the file to be viewed with progressiveDetail that requests the layers (e.g. 'passes' or 'dcProgressive').
     */
    progressiveDc?: 0 | 1 | 2;
    /**
     * Group order for scan vs center-out (ROI + progressive friendly).
     * 0 = scanline (default), 1 = center-out (recommended for progressive and thumbnails; makes early bytes look better).
     */
    groupOrder?: 0 | 1;
    chunked: boolean;
    /** Max dimensions (px) of sidecar thumbnails to yield before the full image. Sorted ascending. */
    sidecarSizes?: readonly number[];
    /** When false, skip the defensive .slice() copy on pushPixels() — caller must not mutate the buffer after push returns. Default true. */
    copyInput?: boolean;
    /** -1 = libjxl auto (default), 0 = VarDCT (lossy), 1 = Modular. */
    modular?: -1 | 0 | 1;
    /** Brotli effort for metadata/entropy coding. -1 = libjxl default, 0-11. */
    brotliEffort?: number;
    /** Decoder speed tier hint (0-4). */
    decodingSpeed?: number;
    /** Target ISO for libjxl synthetic photon noise. 0 or omitted disables it. */
    photonNoiseIso?: number;
    /** Encoder-native downsampling factor before JXL transform/coding. */
    resampling?: ResamplingFactor;
    /** Edge-preserving filter level. -1 = libjxl auto, 0 = off, 1–3 = increasing strength. Requires WASM rebuild with _y bridge. */
    epf?: -1 | 0 | 1 | 2 | 3;
    /** Gaborish pre-sharpening. -1 = libjxl auto, 0 = off, 1 = on. Requires WASM rebuild with _y bridge. */
    gaborish?: -1 | 0 | 1;
    /** Dots detection/synthesis. -1 = libjxl auto, 0 = off, 1 = on. VarDCT only. Requires WASM rebuild with _y bridge. */
    dots?: -1 | 0 | 1;
    /** Color transform. -1 = libjxl auto, 0 = XYB, 1 = none (identity), 2 = YCbCr. Requires WASM rebuild with _y bridge. */
    colorTransform?: -1 | 0 | 1 | 2;
    /**
     * Convenience: per-channel distance for the alpha channel (if hasAlpha is true).
     * 0 = lossless alpha; omit to inherit main distance.
     * Requires rebuilt WASM with extra-channel bridge (_ec suffix).
     */
    alphaDistance?: number;
    /**
     * Extra channels beyond alpha (e.g. depth, selection mask, spot color).
     * Parallel to extraChannelPlanes — index N in this array corresponds to index N in extraChannelPlanes.
     * Requires rebuilt WASM with extra-channel bridge (_ec suffix).
     */
    extraChannels?: readonly ExtraChannel[];
    /**
     * Pixel data for each extra channel declared in extraChannels.
     * Each entry is a single-channel buffer (width x height x bytesPerSample).
     * May be shorter than extraChannels — missing entries leave the channel uninitialized.
     */
    extraChannelPlanes?: readonly (ArrayBuffer | Uint8Array)[];
    /** Container format and per-box options. */
    metadata?: MetadataOptions;
    /** Additional custom metadata boxes to embed. Requires WASM with v2 metadata bridge. */
    customBoxes?: readonly MetadataBoxSpec[];
    /** JUMBF boxes (C2PA content credentials, archival provenance, etc.). Each becomes a "jumb" box. Pure TS sugar over customBoxes; no new FFI. */
    jumbfBoxes?: readonly JUMBFBox[];
    /** HDR gain map to embed as a jhgm box. Requires WASM with gain map bridge. */
    gainMap?: GainMapOptions | null;
    /**
     * HDR static metadata (mastering display color volume + content light levels).
     * First-class surface for professional/archival HDR masters (see additional-hdr-signaling.md).
     * Complements intensityTarget/premultiply/preferCICPForHDR (Phase 3 color priority).
     * Currently accepted for discoverability + lab dumps; full emission after small bridge extension.
     */
    hdrMetadata?: HDRMetadata | null;
    /** Intensity target in nits (for tone mapping / viewing conditions). Part of HDR signaling surface. */
    intensityTarget?: number;
    /** Premultiply alpha before encoding (-1=libjxl default, 0=no, 1=yes). HDR color fidelity knob. */
    premultiply?: -1 | 0 | 1;
    /** Prefer CICP (transfer + matrix) over ICC for HDR content when both present. */
    preferCICPForHDR?: boolean;
    /** When present, encode as a multi-frame animation. ticksPerSecond and loopCount control the animation header. */
    animation?: AnimationOptions;
    /**
     * EXIF orientation tag (1..8) to record in the JXL basic info.
     * 1 = identity, 3 = 180°, 6 = 90° CW, 8 = 90° CCW (matches EXIF semantics).
     * When set to >1, pixels stay in sensor orientation; decoders apply the
     * rotation as metadata — no CPU rotate at encode time.
     * Requires WASM with _z / _v3 bridge; otherwise silently ignored (caller
     * must rotate pixels themselves in that fallback case).
     */
    orientation?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
    /**
     * Frame data for animation encode. When set, replaces the single-image pushPixels path.
     * Requires rebuilt WASM with animation bridge (_jxl_wasm_encode_animation).
     */
    frames?: readonly AnimationFrame[];
}
/** Options for attaching an HDR gain map (ISO 21496-1 / JXL jhgm box). */
export interface GainMapOptions {
    /** Pre-encoded JXL codestream for the gain map image. */
    data: Uint8Array | ArrayBuffer;
}
/**
 * Mastering Display Color Volume (MDCV / mdcv box) per SMPTE ST 2086 / ITU-T H.273.
 * Values are in CIE 1931 xy for chromaticities (0-1 range typical) and nits for luminance.
 */
export interface MasteringDisplay {
    /** CIE 1931 xy chromaticity of red, green, blue primaries (x,y order for each). */
    primaries: [number, number, number, number, number, number];
    /** CIE 1931 xy chromaticity of the white point. */
    whitePoint: [number, number];
    /** [max, min] luminance of the mastering display in nits (cd/m²). */
    luminance: [number, number];
}
/** Content Light Level Information (CLLI / clli box). */
export interface ContentLightLevel {
    /** Maximum Content Light Level (MaxCLL) in cd/m². Typical range 0–65535. */
    maxCLL: number;
    /** Maximum Frame-Average Light Level (MaxFALL) in cd/m². */
    maxFALL: number;
}
/**
 * Additional static HDR metadata (Mastering Display + Content Light Levels).
 * Complements intensityTarget / CICP policy from prior HDR signaling work.
 * Pure TS surface in current slice (per additional-hdr-signaling.md); full codestream
 * emission via JxlEncoderSetHDRMetadata (or equivalent) is the explicit rebuild follow-up.
 */
export interface HDRMetadata {
    masteringDisplay?: MasteringDisplay;
    contentLight?: ContentLightLevel;
}
/** Descriptor for one extra channel beyond the main color channels. */
export interface ExtraChannel {
    /** Channel type. 'other' maps to JXL_CHANNEL_OPTIONAL. */
    type: "alpha" | "depth" | "spot" | "selection" | "other";
    /** Bits per sample for this channel (typically 8, 16, or 32). */
    bitsPerSample: number;
    /**
     * Per-channel encode distance. 0 = lossless; omit to inherit main distance.
     */
    distance?: number;
    /** Optional human-readable label (informational only). */
    name?: string;
    /**
     * Per-extra-channel Modular hints (future-proof surface per granular-extra-channel-modular.md).
     * In the current vendored libjxl (no dedicated per-EC modular setters on JxlExtraChannelInfo or frame settings),
     * these are accepted for discoverability and forward compatibility but most fields remain global-only (via modularOptions
     * or advancedFrameSettings). Global `modularOptions` on EncoderOptions is the primary mechanism today.
     * Mirrors the shape of ModularOptions for ergonomic consistency.
     */
    modular?: {
        predictor?: number;
        groupSize?: number;
        paletteColors?: number;
        nbPrevChannels?: number;
        lossyPalette?: boolean;
        maTreeLearningPercent?: number;
    };
}
/** Descriptor for one frame in an animation sequence. */
export interface AnimationFrame {
    /** RGBA pixel data for this frame (must match EncoderOptions format). */
    data: Uint8Array | ArrayBuffer;
    width: number;
    height: number;
    /** Duration in ticks (see AnimationOptions.ticksPerSecond). */
    duration: number;
    /** Optional human-readable frame name (informational; embedded in the JXL bitstream). */
    name?: string;
}
/** Animation header options written to JxlAnimationHeader. */
export interface AnimationOptions {
    /** Ticks per second for frame duration values. Default 1000 (millisecond units). */
    ticksPerSecond?: number;
    /** Number of animation loops. 0 = infinite (default). */
    loopCount?: number;
}
/** Descriptor for a custom metadata box to embed in the JXL container. */
export interface MetadataBoxSpec {
    /** 4-character JXL box type (e.g. "uuid", "xml "). Padded with spaces if shorter. */
    type: string;
    data: Uint8Array;
    /** Compress this box with Brotli. Default false. */
    compress?: boolean;
}
/** JUMBF box (C2PA / content provenance / archival). The payload is opaque; the wrapper emits it as a "jumb" container box. Pure-TS ergonomic sugar over customBoxes (type "jumb"). */
export interface JUMBFBox {
    /** Raw JUMBF superbox bytes (including the JUMBF box header). */
    data: Uint8Array | ArrayBuffer;
}
/** Per-encode control over which metadata boxes are included and how the container is written. */
export interface MetadataOptions {
    /** Include ICC profile (default true when iccProfile is non-null). */
    includeICC?: boolean;
    /** Include EXIF box (default true when exif is non-null). */
    includeExif?: boolean;
    /** Include XMP box (default true when xmp is non-null). */
    includeXMP?: boolean;
    /** Compress all metadata boxes with Brotli. Default false. */
    compressBoxes?: boolean;
    /** Force JXL container format even when no metadata boxes are present. */
    forceContainer?: boolean;
    /** Emit raw codestream only — no container, no boxes. Overrides forceContainer. */
    rawCodestream?: boolean;
}
export interface JxlDecoder {
    push(chunk: ArrayBuffer | Uint8Array): void | Promise<void>;
    close(): void | Promise<void>;
    events(): AsyncIterable<DecodeEvent>;
    cancel(reason?: string): void | Promise<void>;
    dispose(): void | Promise<void>;
    /**
     * Seek to a specific animation frame index (0-based) and yield events from that point onward.
     *
     * **Current behavior (always works):** Software fallback — the decoder replays the stream
     * internally and filters out frames before the target. No WASM rebuild required.
     *
     * **Future (after rebuild):** Will use the native _jxl_wasm_dec_seek_to_frame fast path when
     * available. The method itself will remain available regardless of rebuild status.
     *
     * Must be called *instead of* events(), never after. Call only after push + close().
     */
    seekToFrame?(frameIndex: number): AsyncIterable<DecodeEvent>;
    /**
     * Convenience wrapper over seekToFrame that accepts time in milliseconds.
     * Computes the target frame using the first event that carries animTicksPerSecond.
     * Falls back to frame 0 for non-animated content.
     *
     * Same guarantees as seekToFrame: works today via software fallback.
     */
    seekToTime?(timeMs: number): AsyncIterable<DecodeEvent>;
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
    _jxl_wasm_encode_rgba8(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number): number;
    _jxl_wasm_encode_rgba16?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number): number;
    _jxl_wasm_encode_rgbaf32?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number): number;
    _jxl_wasm_encode_rgba8_with_metadata?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number): number;
    _jxl_wasm_buffer_data(handle: number): number;
    _jxl_wasm_buffer_size(handle: number): number;
    _jxl_wasm_buffer_width(handle: number): number;
    _jxl_wasm_buffer_height(handle: number): number;
    _jxl_wasm_buffer_bits_per_sample(handle: number): number;
    _jxl_wasm_buffer_has_alpha(handle: number): number;
    _jxl_wasm_buffer_error?(handle: number): number;
    _jxl_wasm_buffer_free(handle: number): void;
    _jxl_wasm_dec_create?(format: number, progressiveDetail: number): number;
    _jxl_wasm_dec_push?(state: number, dataPtr: number, size: number): number;
    _jxl_wasm_dec_close_input?(state: number): void;
    _jxl_wasm_dec_width?(state: number): number;
    _jxl_wasm_dec_height?(state: number): number;
    _jxl_wasm_dec_error?(state: number): number;
    _jxl_wasm_dec_take_flushed?(state: number): number;
    _jxl_wasm_dec_take_final?(state: number): number;
    _jxl_wasm_dec_free?(state: number): void;
    _jxl_wasm_encode_rgba8_with_sidecars?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, sidecarDimsPtr: number, numSidecars: number, resampling: number): number;
    _jxl_wasm_buffer_next?(handle: number): number;
    _jxl_wasm_decode_rgba8_region?(inputPtr: number, inputSize: number, cx: number, cy: number, cw: number, ch: number, downsample: number): number;
    _jxl_wasm_decode_rgba16_region?(inputPtr: number, inputSize: number, cx: number, cy: number, cw: number, ch: number, downsample: number): number;
    _jxl_wasm_decode_rgbaf32_region?(inputPtr: number, inputSize: number, cx: number, cy: number, cw: number, ch: number, downsample: number): number;
    _jxl_wasm_enc_create?(): number;
    _jxl_wasm_enc_push_pixels?(state: number, pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number): number;
    _jxl_wasm_enc_take_chunk?(state: number): number;
    _jxl_wasm_enc_error?(state: number): number;
    _jxl_wasm_enc_free?(state: number): void;
    _jxl_wasm_transcode_jpeg_to_jxl?(jpegPtr: number, jpegSize: number): number;
    _jxl_wasm_enc_create_image?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number): number;
    _jxl_wasm_encode_rgba8_with_sidecars_x?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, sidecarDimsPtr: number, numSidecars: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number): number;
    _jxl_wasm_encode_rgba8_x?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number): number;
    _jxl_wasm_encode_rgba16_x?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number): number;
    _jxl_wasm_encode_rgbaf32_x?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number): number;
    _jxl_wasm_encode_rgba8_with_metadata_x?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number): number;
    _jxl_wasm_encode_rgba8_with_metadata_ec?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, alphaDistance: number, ecPtr: number, numEc: number): number;
    _jxl_wasm_encode_rgba8_with_metadata_v2?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, boxOptsPtr: number): number;
    _jxl_wasm_encode_rgba8_with_metadata_ec_v2?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, alphaDistance: number, ecPtr: number, numEc: number, boxOptsPtr: number): number;
    _jxl_wasm_transcode_jpeg_to_jxl_v2?(jpegPtr: number, jpegSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, boxOptsPtr: number): number;
    _jxl_wasm_enc_push_pixels_x?(state: number, pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number): number;
    _jxl_wasm_enc_create_image_x?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number): number;
    _jxl_wasm_enc_create_image_y?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, epf: number, gaborish: number, dots: number, colorTransform: number): number;
    _jxl_wasm_enc_create_image_z?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, epf: number, gaborish: number, dots: number, colorTransform: number, orientation: number): number;
    _jxl_wasm_encode_rgba8_with_metadata_v3?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, boxOptsPtr: number, orientation: number): number;
    _jxl_wasm_enc_pixels_ptr?(state: number, size: number): number;
    _jxl_wasm_enc_advance_written?(state: number, size: number): number;
    _jxl_wasm_enc_set_metadata?(state: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number): number;
    _jxl_wasm_enc_push_chunk?(state: number, dataPtr: number, size: number): number;
    _jxl_wasm_enc_finish?(state: number): number;
    _jxl_wasm_encode_tiled_rgba8?(pixelsPtr: number, width: number, height: number, tileSize: number, distance: number, effort: number, hasAlpha: number): number;
    _jxl_wasm_decode_region_tiled_rgba8?(inputPtr: number, inputSize: number, tileSize: number, regionX: number, regionY: number, regionW: number, regionH: number): number;
    _jxl_wasm_encode_tile_container_rgba8?(pixelsPtr: number, width: number, height: number, tileSize: number, distance: number, effort: number, hasAlpha: number): number;
    _jxl_wasm_decode_tile_container_region_rgba8?(inputPtr: number, inputSize: number, regionX: number, regionY: number, regionW: number, regionH: number): number;
    _jxl_wasm_encode_with_gain_map?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, gainMapPtr: number, gainMapSize: number): number;
    _jxl_wasm_dec_has_gain_map?(state: number): number;
    _jxl_wasm_dec_take_gain_map?(state: number): number;
    _jxl_wasm_encode_animation?(framesPtr: number, numFrames: number, distance: number, effort: number, fmt: number, hasAlpha: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, boxOptsPtr: number, animOptsPtr: number): number;
    _jxl_wasm_dec_frame_index?(state: number): number;
    _jxl_wasm_dec_frame_duration?(state: number): number;
    _jxl_wasm_dec_frame_name_ptr?(state: number): number;
    _jxl_wasm_dec_is_last_frame?(state: number): number;
    _jxl_wasm_dec_anim_ticks_per_second?(state: number): number;
    _jxl_wasm_dec_anim_loop_count?(state: number): number;
    _jxl_wasm_dec_seek_to_frame?(state: number, targetFrame: number): number;
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
    /**
     * Whether the *optimized native* seek path is available.
     * - `true` only after a WASM rebuild that includes `_jxl_wasm_dec_seek_to_frame`.
     * - `false` on current binaries (seek still works via the software fallback in seekToFrame/seekToTime).
     *
     * Use this flag if you want to know whether you are getting the fast C++ skip path.
     * The seek methods themselves are always present and functional.
     */
    animationSeek: boolean;
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
/**
 * Encode an RGBA8 image as a tiled multi-frame JXL.
 * Each tile becomes one JXL frame with layer_info.have_crop = JXL_TRUE.
 * Decode with decodeTiledRegionRgba8 to retrieve any rectangular region
 * without decoding the whole image — true partial decode in libjxl 0.11.x.
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
 * Decode a rectangular region from a tiled JXL produced by encodeTiledRgba8.
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
/** Start loading the WASM module immediately. Call during app startup to hide cold-start latency. */
export declare function preloadJxlModule(): void;
export declare function getWrapperCapabilities(): WrapperCapabilities;
export declare function getDecodeGridInfo(): DecodeGridInfo;
export interface DecodeViewportOptions {
    format: PixelFormat;
    region?: Region | null;
    /** Full image dimensions — used to pick a downsample factor when no region is specified. */
    imageWidth?: number;
    imageHeight?: number;
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