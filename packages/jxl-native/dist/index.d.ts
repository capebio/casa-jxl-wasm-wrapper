export declare class CapabilityMissing extends Error {
    readonly code = "CapabilityMissing";
    readonly cause?: unknown;
    constructor(message: string, cause?: unknown);
}
export interface NativeBinding {
    version(): string;
    probe(): {
        loaded: boolean;
        path: string;
    };
    createDecoder?: (options: DecoderOptions) => NativeDecoder;
    createEncoder?: (options: EncoderOptions) => NativeEncoder;
}
export interface NativeLoaderOptions {
    prebuiltPath?: string;
    sourcePath?: string;
}
export type PixelFormat = "rgba8" | "rgba16" | "rgbaf32";
export type DecodeStage = "header" | "dc" | "pass" | "final";
export type Region = {
    x: number;
    y: number;
    w: number;
    h: number;
};
export interface ExtraChannelDescriptor {
    readonly type: string;
    readonly bitsPerSample: number;
    readonly name: string;
}
export interface DecodedExtraChannel extends ExtraChannelDescriptor {
    readonly pixels: ArrayBuffer;
    readonly pixelFormat: PixelFormat;
}
export interface ImageInfo {
    width: number;
    height: number;
    bitsPerSample: 8 | 16 | 32;
    hasAlpha: boolean;
    hasAnimation: boolean;
    jpegReconstructionAvailable: boolean;
    extraChannels?: readonly ExtraChannelDescriptor[];
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
    frameIndex?: number;
    frameDuration?: number;
    frameName?: string;
    isLastFrame?: boolean;
    animTicksPerSecond?: number;
    animLoopCount?: number;
    extraPlanes?: readonly ArrayBuffer[];
    extraChannelDescriptors?: readonly DecodedExtraChannel[];
    gainMap?: {
        data: ArrayBuffer;
    };
} | {
    type: "final";
    info: ImageInfo;
    pixels: ArrayBuffer | Uint8Array;
    format: PixelFormat;
    region?: Region;
    pixelStride: number;
    frameIndex?: number;
    frameDuration?: number;
    frameName?: string;
    isLastFrame?: boolean;
    animTicksPerSecond?: number;
    animLoopCount?: number;
    extraPlanes?: readonly ArrayBuffer[];
    extraChannelDescriptors?: readonly DecodedExtraChannel[];
    gainMap?: {
        data: ArrayBuffer;
    };
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
export interface MetadataBoxSpec {
    /** 4-character JXL box type (e.g. "uuid", "xml "). Padded with spaces if shorter. */
    type: string;
    data: Uint8Array;
    /** Compress this box with Brotli. Default false. */
    compress?: boolean;
}
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
/** Options for attaching an HDR gain map (ISO 21496-1 / JXL jhgm box). */
export interface GainMapOptions {
    /** Pre-encoded JXL naked codestream for the gain map image. */
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
 * Native binding receives the fields after normalization (future native.cc wiring).
 */
export interface HDRMetadata {
    masteringDisplay?: MasteringDisplay;
    contentLight?: ContentLightLevel;
}
/** Sub-settings for Modular encoding mode. Applied alongside or instead of the flat `modular` flag. */
export interface ModularOptions {
    /** 0 = auto group size (libjxl default), positive = explicit group size (power-of-two). */
    groupSize?: number;
    /** Predictor selection (0–15). Major quality/speed tradeoff knob. */
    predictor?: number;
    /** Number of previous channels to use for prediction. */
    nbPrevChannels?: number;
    /** Number of palette colors. 0 = disable palette, -1 = libjxl default. */
    paletteColors?: number;
    /** Allow lossy palette. */
    lossyPalette?: boolean;
    /** Tree learning percent (0–100). -1 = libjxl default. */
    maTreeLearningPercent?: number;
}
/** Descriptor for one extra channel beyond the main color channels. */
export interface ExtraChannel {
    /** Channel type. 'other' maps to JXL_CHANNEL_UNKNOWN (15). */
    type: "alpha" | "depth" | "spot" | "selection" | "other";
    /** Bits per sample for this channel (typically 8, 16, or 32). */
    bitsPerSample: number;
    /** Per-channel encode distance. 0 = lossless; omit to inherit main distance. */
    distance?: number;
    /** Optional human-readable label embedded in the JXL bitstream. */
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
/** JUMBF box (C2PA / content provenance / archival). The payload is opaque; the wrapper emits it as a "jumb" container box. */
export interface JUMBFBox {
    /** Raw JUMBF superbox bytes (including the JUMBF box header). */
    data: Uint8Array | ArrayBuffer;
}
/**
 * First-class advanced encoder controls (parity with WASM facade).
 */
export interface AdvancedEncoderControls {
    filters?: FiltersControls;
    groupOrder?: GroupOrderControls;
    buffering?: BufferingControls;
}
export interface FiltersControls {
    dots?: boolean;
    patches?: boolean;
    epf?: -1 | 0 | 1 | 2 | 3;
    gaborish?: boolean;
}
export interface GroupOrderControls {
    mode: 'scanline' | 'center';
    centerX?: number;
    centerY?: number;
}
export interface BufferingControls {
    strategy?: -1 | 0 | 1 | 2 | 3;
    streamingInput?: boolean;
    streamingOutput?: boolean;
    lowMemoryMode?: boolean;
    preferChunkedAPI?: boolean;
}
/** Descriptor for one frame in an animation sequence. */
export interface AnimationFrame {
    data: Uint8Array | ArrayBuffer;
    width: number;
    height: number;
    /** Duration in ticks (see AnimationOptions.ticksPerSecond). */
    duration: number;
    name?: string;
}
/** Animation header options. */
export interface AnimationOptions {
    ticksPerSecond?: number;
    loopCount?: number;
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
    /** Brotli effort for aux data (metadata, ICC, EXIF, extra channels). -1 = libjxl default, 0-11 explicit. */
    brotliEffort?: number;
    /** Decoder speed tier hint (0-4). Tells the encoder to structure the codestream for faster decoding. 0 = default, 4 = fastest decode. */
    decodingSpeed?: number;
    /** Target ISO for libjxl synthetic photon noise. 0 or omitted disables it. */
    photonNoiseIso?: number;
    /** Encoder-native downsampling factor before JXL transform/coding. */
    resampling?: 1 | 2 | 4 | 8;
    /** -1 = libjxl auto (default), 0 = VarDCT (lossy), 1 = Modular. */
    modular?: -1 | 0 | 1;
    /**
     * Raw JXL_ENC_FRAME_SETTING_* escape hatch for advanced/experimental features
     * (e.g. patches=8, splines=9, modular predictor, etc.).
     * Applied after all named settings; later entries override earlier ones.
     */
    advancedFrameSettings?: readonly {
        id: number;
        value: number;
    }[];
    /** Fine-grained Modular mode sub-settings. Applied after `modular` force flag. */
    modularOptions?: ModularOptions;
    /** Attach an HDR gain map (ISO 21496-1) as a jhgm box. data is a JXL naked codestream. */
    gainMap?: GainMapOptions | null;
    /**
     * HDR static metadata (mastering display color volume + content light levels).
     * First-class surface for professional/archival HDR masters (see additional-hdr-signaling.md).
     * Complements intensityTarget/premultiply/preferCICPForHDR (Phase 3 color priority).
     * Currently accepted for discoverability + lab dumps; full emission after small bridge/native wiring.
     */
    hdrMetadata?: HDRMetadata | null;
    /** Intensity target in nits (for tone mapping / viewing conditions). Part of HDR signaling surface. */
    intensityTarget?: number;
    /** Premultiply alpha before encoding (-1=libjxl default, 0=no, 1=yes). HDR color fidelity knob. */
    premultiply?: -1 | 0 | 1;
    /** Prefer CICP (transfer + matrix) over ICC for HDR content when both present. */
    preferCICPForHDR?: boolean;
    progressive: boolean;
    previewFirst: boolean;
    chunked: boolean;
    /**
     * progressiveDc (0/1/2) and groupOrder (0/1) for multi-layer/center-out progressive encodes (predator focus, Tauri parity).
     * Mirrors WASM EncoderOptions; when set these are injected via advancedFrameSettings (id 19/13) so the existing
     * libjxl frame option path in native.cc applies them. Use with progressive:true + decode emitEveryPass + 'passes' detail.
     */
    progressiveDc?: 0 | 1 | 2;
    groupOrder?: 0 | 1;
    /** Container format and per-box options. */
    metadata?: MetadataOptions;
    /** Additional custom metadata boxes to embed. */
    customBoxes?: readonly MetadataBoxSpec[];
    /** JUMBF boxes (C2PA content credentials, archival provenance, etc.). Each becomes a "jumb" box. Pure TS sugar over customBoxes; no new native FFI. */
    jumbfBoxes?: readonly JUMBFBox[];
    /**
     * JPEG reconstruction controls (when the source was JPEG).
     * Maps to advanced pairs + special handling on the native side.
     */
    jpegReconstruction?: {
        cfl?: boolean;
        compressBoxes?: boolean;
        emitWarnings?: boolean;
        storeJPEGMetadata?: boolean;
    };
    /** The input image has already been downsampled by the resampling factor. */
    alreadyDownsampled?: boolean;
    /** Encoder upsampling mode (0 = nearest for pixel art, etc.). */
    upsamplingMode?: number;
    /**
     * First-class advanced encoder controls (post-audit).
     * Provides ergonomic access to filters, group order, buffering strategy, etc.
     */
    advancedControls?: AdvancedEncoderControls;
    /** Animation header options. */
    animation?: AnimationOptions;
    /** Frame data for animation encode. When present, replaces single-image pushPixels. */
    frames?: readonly AnimationFrame[];
    /**
     * Per-channel distance for the alpha channel. 0 = lossless; omit to inherit main distance.
     * Only applied when hasAlpha is true.
     */
    alphaDistance?: number;
    /** Extra channels beyond alpha (e.g. depth, selection mask). */
    extraChannels?: readonly ExtraChannel[];
    /**
     * Pixel data for each extra channel declared in extraChannels.
     * Each entry is a single-channel buffer (width × height × bytesPerSample).
     * May be shorter than extraChannels — missing entries leave the channel data unset.
     */
    extraChannelPlanes?: readonly (ArrayBuffer | Uint8Array)[];
}
export interface NativeDecoder {
    push(chunk: ArrayBuffer | Uint8Array): void | Promise<void>;
    close(): void | Promise<void>;
    events(): AsyncIterable<DecodeEvent>;
    cancel(reason?: string): void | Promise<void>;
    dispose(): void | Promise<void>;
    /**
     * Seek to a specific animation frame index (0-based). Software fallback: decodes all
     * frames and discards those before frameIndex. Must be called instead of events().
     */
    seekToFrame?(frameIndex: number): AsyncIterable<DecodeEvent>;
    /**
     * Seek by timestamp in milliseconds. Computes frame index from animTicksPerSecond;
     * falls back to frame 0 for non-animation files. Same constraints as seekToFrame.
     */
    seekToTime?(timeMs: number): AsyncIterable<DecodeEvent>;
}
export interface NativeEncoder {
    pushPixels(chunk: ArrayBuffer | Uint8Array, region?: Region): void | Promise<void>;
    finish(): void | Promise<void>;
    chunks(): AsyncIterable<ArrayBuffer | Uint8Array>;
    cancel(reason?: string): void | Promise<void>;
    dispose(): void | Promise<void>;
}
export interface NativeCodecFacade {
    createDecoder(options: DecoderOptions): NativeDecoder;
    createEncoder(options: EncoderOptions): NativeEncoder;
}
export declare function loadNativeBinding(options?: NativeLoaderOptions): NativeBinding;
export declare function createNativeCodecFacade(binding: NativeBinding): NativeCodecFacade;
export declare function createDecoder(options: DecoderOptions): NativeDecoder;
export declare function createEncoder(options: EncoderOptions): NativeEncoder;
//# sourceMappingURL=index.d.ts.map