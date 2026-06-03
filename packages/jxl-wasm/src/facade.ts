export type PixelFormat = "rgba8" | "rgba16" | "rgbaf32" | "rgb8";
export type DecodeStage = "header" | "dc" | "pass" | "final";
export type Region = { x: number; y: number; w: number; h: number };
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
      gainMap?: { data: Uint8Array };
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
  /** Explicit VarDCT spectral AC progression override. Omit to use progressiveFlavor/previewFirst defaults. */
  progressiveAc?: 0 | 1;
  /** Explicit VarDCT quantized AC progression override. Omit to use progressiveFlavor/previewFirst defaults. */
  qProgressiveAc?: 0 | 1;
  /**
   * Group order for scan vs center-out (ROI + progressive friendly).
   * 0 = scanline (default), 1 = center-out (recommended for progressive and thumbnails; makes early bytes look better).
   * Matches cjxl --group_order (ID 13).
   */
  groupOrder?: 0 | 1;
  /**
   * Center X (pixels) for center-first group order. -1 or omit = auto middle.
   * Only effective with groupOrder=1. Matches cjxl --center_x (ID 14) + validation.
   */
  centerX?: number;
  /**
   * Center Y (pixels) for center-first group order. -1 or omit = auto middle.
   * Only effective with groupOrder=1. Matches cjxl --center_y (ID 15).
   */
  centerY?: number;

  /**
   * Buffering / streaming strategy (cjxl --buffering + streaming flags).
   * strategy: -1=encoder chooses, 0=buffer all (max mem/best density), 1/2=stream input+buffer out (large imgs),
   * 3=stream both (min mem/worst density). See cjxl --help for tradeoffs.
   * lowMemoryMode + preferChunkedAPI are hints (promote to 3 when unset).
   */
  buffering?: {
    strategy?: -1 | 0 | 1 | 2 | 3;
    streamingInput?: boolean;
    streamingOutput?: boolean;
    lowMemoryMode?: boolean;
    preferChunkedAPI?: boolean;
  };

  chunked: boolean;
  /** Max dimensions (px) of sidecar thumbnails to yield before the full image. Sorted ascending. */
  sidecarSizes?: readonly number[];
  /** When false, skip the defensive .slice() copy on pushPixels() — caller must not mutate the buffer after push returns. Default true. */
  copyInput?: boolean;
  /**
   * Intrinsic (display) size override. When set, JXL signals a different display
   * resolution from the encoded pixel dimensions — useful for Retina/HiDPI (@2×)
   * assets where encoded pixels are 2× the logical size (e.g. intrinsicSize 512×512
   * for a 1024×1024 encoded image). Maps to JxlBasicInfo.have_intrinsic_size.
   * Requires WASM rebuild with enc_set_intrinsic_size bridge.
   */
  intrinsicSize?: { width: number; height: number };
  /**
   * Disable libjxl perceptual quality heuristics (butteraugli/XYB psychovisual model).
   * Useful for fair benchmarking against other codecs without perceptual optimisation.
   * Maps to JXL_ENC_FRAME_SETTING_DISABLE_PERCEPTUAL_HEURISTICS (ID 39).
   * Requires WASM rebuild with enc_set_frame_flags bridge.
   */
  disablePerceptualHeuristics?: boolean;
  /**
   * Force the JPEG XL codestream level. -1/omitted = libjxl automatic,
   * 5 = Level 5, 10 = Level 10 for features such as CMYK/black-channel workflows.
   * Requires WASM rebuild with enc_set_codestream_level bridge.
   */
  codestreamLevel?: -1 | 5 | 10;

  /**
   * JPEG reconstruction controls (when input is JPEG for lossless transcode).
   * Full dec-hints (color_space, icc_pathname, strip=*) per cjxl row 12 audit.
   * Strip + warnings from row 7.
   */
  jpegReconstruction?: {
    cfl?: boolean;
    compressBoxes?: boolean;
    emitWarnings?: boolean;
    storeJPEGMetadata?: boolean;
    /** 0=strip, 1=keep (default). ID 35 JXL_ENC_FRAME_SETTING_JPEG_KEEP_EXIF. Only for AddJPEGFrame paths. */
    keepExif?: 0 | 1;
    /** 0=strip, 1=keep (default). ID 36. */
    keepXmp?: 0 | 1;
    /** 0=strip, 1=keep (default). ID 37. */
    keepJumbf?: 0 | 1;
    /** color_space from -x dec-hints (for raw color or recon). */
    colorSpace?: string;
    /** icc_pathname bytes equivalent. */
    icc?: Uint8Array;
  };

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
  /**
   * Row 8 (cjxl audit): input already downsampled by the resampling factor (decoder will upsample).
   * Matches --already_downsampled. Usually used with resampling>1.
   */
  alreadyDownsampled?: boolean;
  /**
   * Row 8 (cjxl): upsampling mode (0=nearest for pixel art). Matches --upsampling_mode + JxlEncoderSetUpsamplingMode.
   * -1=default (non-separable), 0=nearest.
   */
  upsamplingMode?: -1 | 0 | 1;
  /**
   * Row 8 (cjxl): separate resampling for extra channels (alpha etc). ID 3.
   * -1 or 1/2/4/8. Independent control.
   */
  ecResampling?: -1 | 1 | 2 | 4 | 8;

  /**
   * Row 9 (cjxl): frame indexing string ^(0*|1[01]*)$ for ID 31 JXL_ENC_FRAME_INDEX_BOX.
   * Validation (regex + first-frame rule) per cjxl ProcessFlags; '1' marks frame for index.
   */
  frameIndexing?: string;

  /**
   * Row 10 (cjxl): allow effort=11 expert (extreme cost denser lossless).
   * Gate per cjxl; when true effort 1-11, else 1-10. Validation in resolve.
   */
  allowExpertOptions?: boolean;
  /** Edge-preserving filter level. -1 = libjxl auto, 0 = off, 1–3 = increasing strength. Requires WASM rebuild with _y bridge. */
  epf?: -1 | 0 | 1 | 2 | 3;
  /** Gaborish pre-sharpening. -1 = libjxl auto, 0 = off, 1 = on. Requires WASM rebuild with _y bridge. */
  gaborish?: -1 | 0 | 1;
  /** Dots detection/synthesis. -1 = libjxl auto, 0 = off, 1 = on. VarDCT only. Requires WASM rebuild with _y bridge. */
  dots?: -1 | 0 | 1;
  /** Patches generation (dictionary modeling for repeated content). -1=auto, 0=off, 1=on. Explicitly called out in escape-hatch docs as primary use case. Matches cjxl --patches (ID 8). */
  patches?: -1 | 0 | 1;
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
  onMetric?: (name: string, value: number) => void;
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
  /**
   * Channel type.
   * - 'black' → JXL_CHANNEL_BLACK (4): CMYK K component; requires modular:1 and CMYK ICC profile (Level 10 feature).
   * - 'cfa'   → JXL_CHANNEL_CFA (5): Bayer CFA raw sensor channel.
   * - 'thermal' → JXL_CHANNEL_THERMAL (6): thermal/infrared sensor channel.
   * - 'other' → JXL_CHANNEL_OPTIONAL (15): generic optional channel.
   */
  type: "alpha" | "depth" | "spot" | "selection" | "black" | "cfa" | "thermal" | "other";
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
  /**
   * Frame blend mode (JxlBlendMode). Controls how this frame composites onto the canvas.
   * - 'replace' (default): replace all pixels (JXL_BLEND_REPLACE = 0)
   * - 'add':      additive blend — adds pixel values (JXL_BLEND_ADD = 1)
   * - 'blend':    alpha-blend using the alpha channel (JXL_BLEND_BLEND = 2)
   * - 'muladd':   multiply-add blend (JXL_BLEND_MULADD = 3)
   * - 'mul':      multiplicative blend (JXL_BLEND_MUL = 4)
   * Requires WASM rebuild with extended WasmAnimationFrame struct (32 bytes).
   */
  blendMode?: "replace" | "add" | "blend" | "muladd" | "mul";
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
  _jxl_wasm_encode_rgba8(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number, centerX?: number, centerY?: number): number;
  _jxl_wasm_encode_rgba16?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number, centerX?: number, centerY?: number): number;
  _jxl_wasm_encode_rgbaf32?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number, centerX?: number, centerY?: number): number;
  _jxl_wasm_encode_rgba8_with_metadata?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, centerX?: number, centerY?: number): number;
  _jxl_wasm_buffer_data(handle: number): number;
  _jxl_wasm_buffer_size(handle: number): number;
  _jxl_wasm_buffer_width(handle: number): number;
  _jxl_wasm_buffer_height(handle: number): number;
  _jxl_wasm_buffer_bits_per_sample(handle: number): number;
  _jxl_wasm_buffer_has_alpha(handle: number): number;
  _jxl_wasm_buffer_error?(handle: number): number;
  _jxl_wasm_buffer_free(handle: number): void;
  // Stateful progressive decoder (present after WASM rebuild with new bridge)
  _jxl_wasm_dec_create?(format: number, progressiveDetail: number): number;
  _jxl_wasm_dec_push?(state: number, dataPtr: number, size: number): number;
  _jxl_wasm_dec_close_input?(state: number): void;
  _jxl_wasm_dec_width?(state: number): number;
  _jxl_wasm_dec_height?(state: number): number;
  _jxl_wasm_dec_error?(state: number): number;
  _jxl_wasm_dec_take_flushed?(state: number): number;
  _jxl_wasm_dec_take_final?(state: number): number;
  _jxl_wasm_dec_free?(state: number): void;
  // Sidecar thumbnail encode (present after WASM rebuild with sidecar bridge)
  _jxl_wasm_encode_rgba8_with_sidecars?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, sidecarDimsPtr: number, numSidecars: number, resampling: number): number;
  _jxl_wasm_buffer_next?(handle: number): number;
  // #10: C++ region crop decode — avoids shipping full-image pixels to JS
  _jxl_wasm_decode_rgba8_region?(inputPtr: number, inputSize: number, cx: number, cy: number, cw: number, ch: number, downsample: number): number;
  _jxl_wasm_decode_rgba16_region?(inputPtr: number, inputSize: number, cx: number, cy: number, cw: number, ch: number, downsample: number): number;
  _jxl_wasm_decode_rgbaf32_region?(inputPtr: number, inputSize: number, cx: number, cy: number, cw: number, ch: number, downsample: number): number;
  // #11: Streaming encoder — yields 64 KB chunks
  _jxl_wasm_enc_create?(): number;
  _jxl_wasm_enc_push_pixels?(state: number, pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number): number;
  _jxl_wasm_enc_take_chunk?(state: number): number;
  _jxl_wasm_enc_error?(state: number): number;
  _jxl_wasm_enc_free?(state: number): void;
  // #15: Lossless JPEG → JXL transcode
  _jxl_wasm_transcode_jpeg_to_jxl?(jpegPtr: number, jpegSize: number): number;
  // #16: Streaming input encoder — pre-allocate pixel buffer in WASM, push chunks, finish
  _jxl_wasm_enc_create_image?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number): number;
  _jxl_wasm_encode_rgba8_with_sidecars_x?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, sidecarDimsPtr: number, numSidecars: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number): number;
  _jxl_wasm_encode_rgba8_x?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number): number;
  _jxl_wasm_encode_rgba16_x?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number): number;
  _jxl_wasm_encode_rgbaf32_x?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number): number;
  _jxl_wasm_encode_rgba8_with_metadata_x?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number): number;
  // Extra-channel encode: per-channel distance + optional separate plane buffers.
  _jxl_wasm_encode_rgba8_with_metadata_ec?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, alphaDistance: number, ecPtr: number, numEc: number): number;
  // v2: extends _x / _ec with WasmBoxOpts (container control, box compression, custom boxes).
  _jxl_wasm_encode_rgba8_with_metadata_v2?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, boxOptsPtr: number): number;
  _jxl_wasm_encode_rgba8_with_metadata_ec_v2?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, alphaDistance: number, ecPtr: number, numEc: number, boxOptsPtr: number): number;
  _jxl_wasm_transcode_jpeg_to_jxl_v2?(jpegPtr: number, jpegSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, boxOptsPtr: number): number;
  _jxl_wasm_transcode_jpeg_to_jxl_v3?(jpegPtr: number, jpegSize: number, store: number, keepExif: number, keepXmp: number, keepJumbf: number): number;
  _jxl_wasm_enc_push_pixels_x?(state: number, pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, centerX?: number, centerY?: number): number;
  _jxl_wasm_enc_create_image_x?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, jpegKeepExif?: number, jpegKeepXmp?: number, jpegKeepJumbf?: number, alreadyDownsampled?: number, upsamplingMode?: number, ecResampling?: number): number;
  _jxl_wasm_enc_create_image_y?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, epf: number, gaborish: number, dots: number, patches: number, colorTransform: number, jpegKeepExif?: number, jpegKeepXmp?: number, jpegKeepJumbf?: number, alreadyDownsampled?: number, upsamplingMode?: number, ecResampling?: number): number;
  // _z: _y + orientation (1..8, EXIF semantics). Records rotation in JXL basic info instead of rotating pixels.
  _jxl_wasm_enc_create_image_z?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, epf: number, gaborish: number, dots: number, patches: number, colorTransform: number, orientation: number, jpegKeepExif?: number, jpegKeepXmp?: number, jpegKeepJumbf?: number, alreadyDownsampled?: number, upsamplingMode?: number, ecResampling?: number): number;
  // v3: v2 + orientation
  _jxl_wasm_encode_rgba8_with_metadata_v3?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, boxOptsPtr: number, orientation: number): number;
  _jxl_wasm_enc_pixels_ptr?(state: number, size: number): number;
  _jxl_wasm_enc_advance_written?(state: number, size: number): number;
  _jxl_wasm_enc_set_metadata?(state: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number): number;
  _jxl_wasm_enc_set_codestream_level?(state: number, level: number): number;
  _jxl_wasm_enc_set_alpha_premultiply?(state: number, premultiply: number): number;
  _jxl_wasm_enc_push_chunk?(state: number, dataPtr: number, size: number): number;
  _jxl_wasm_enc_finish?(state: number): number;
  // Tiled multi-frame ROI: encode an image as N JXL frames each carrying
  // layer_info.have_crop = JXL_TRUE. Pair with decode_region_tiled_rgba8 to
  // decode only the tiles overlapping a target region (true partial decode
  // via SkipFrames + SetCoalescing(false)).
  _jxl_wasm_encode_tiled_rgba8?(pixelsPtr: number, width: number, height: number, tileSize: number, distance: number, effort: number, hasAlpha: number): number;
  _jxl_wasm_decode_region_tiled_rgba8?(inputPtr: number, inputSize: number, tileSize: number, regionX: number, regionY: number, regionW: number, regionH: number): number;
  // JXTC tile container: per-tile independent JXL bitstreams + byte-offset index.
  // Avoids libjxl frame-walk overhead entirely — fresh decoder per tile.
  _jxl_wasm_encode_tile_container_rgba8?(pixelsPtr: number, width: number, height: number, tileSize: number, distance: number, effort: number, hasAlpha: number): number;
  _jxl_wasm_decode_tile_container_region_rgba8?(inputPtr: number, inputSize: number, regionX: number, regionY: number, regionW: number, regionH: number): number;
  // Gain map encode/decode — present after WASM rebuild with gain map bridge
  _jxl_wasm_encode_with_gain_map?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, gainMapPtr: number, gainMapSize: number): number;
  _jxl_wasm_dec_has_gain_map?(state: number): number;
  _jxl_wasm_dec_take_gain_map?(state: number): number;
  // Animation encode — present after WASM rebuild with animation bridge
  _jxl_wasm_encode_animation?(framesPtr: number, numFrames: number, distance: number, effort: number, fmt: number, hasAlpha: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, boxOptsPtr: number, animOptsPtr: number): number;
  // Animation decode frame metadata accessors — present after WASM rebuild with animation bridge
  _jxl_wasm_dec_frame_index?(state: number): number;
  _jxl_wasm_dec_frame_duration?(state: number): number;
  _jxl_wasm_dec_frame_name_ptr?(state: number): number;
  _jxl_wasm_dec_is_last_frame?(state: number): number;
  _jxl_wasm_dec_anim_ticks_per_second?(state: number): number;
  _jxl_wasm_dec_anim_loop_count?(state: number): number;
  // Animation seek — present after WASM rebuild with seek bridge
  _jxl_wasm_dec_seek_to_frame?(state: number, targetFrame: number): number;
}

type JxlModuleFactory = () => Promise<LibjxlWasmModule>;

function normalizeDecoderOptions(options: DecoderOptions): DecoderOptions {
  return {
    ...options,
    region: options.region ?? null,
    downsample: options.downsample ?? pickDownsample(options),
    ...(options.progressiveDetail !== undefined ? { progressiveDetail: options.progressiveDetail } : {}),
    targetWidth: options.targetWidth ?? null,
    targetHeight: options.targetHeight ?? null,
    fitMode: options.fitMode ?? null,
  };
}

function resolveDecoderProgressiveDetail(options: DecoderOptions): 0 | 1 | 2 | 3 | 4 {
  if (options.progressionTarget === "header") return 0;
  if (!(options.progressionTarget !== "final" || options.emitEveryPass)) return 0;
  const detail = options.progressiveDetail
    ?? (options.emitEveryPass || options.progressionTarget === "pass" ? "passes" : "dc");
  switch (detail) {
    case "dc":
      return 1;
    case "lastPasses":
      return 2;
    case "passes":
      return 3;
    case "dcProgressive":
      return 4;
    default:
      return 1;
  }
}

function encodeExtraChannelType(type: ExtraChannel["type"]): number {
  switch (type) {
    case "alpha":     return 0;  // JXL_CHANNEL_ALPHA
    case "depth":     return 1;  // JXL_CHANNEL_DEPTH
    case "spot":      return 2;  // JXL_CHANNEL_SPOT_COLOR
    case "selection": return 3;  // JXL_CHANNEL_SELECTION_MASK
    case "black":     return 4;  // JXL_CHANNEL_BLACK (CMYK K; Level 10 + modular + CMYK ICC)
    case "cfa":       return 5;  // JXL_CHANNEL_CFA (Bayer raw sensor)
    case "thermal":   return 6;  // JXL_CHANNEL_THERMAL
    default:          return 15; // JXL_CHANNEL_OPTIONAL
  }
}

function encodeBlendMode(mode: AnimationFrame["blendMode"]): number {
  switch (mode) {
    case "add":    return 1; // JXL_BLEND_ADD
    case "blend":  return 2; // JXL_BLEND_BLEND
    case "muladd": return 3; // JXL_BLEND_MULADD
    case "mul":    return 4; // JXL_BLEND_MUL
    default:       return 0; // JXL_BLEND_REPLACE
  }
}

/** Returns effective ICC/EXIF/XMP blobs after applying MetadataOptions include flags. */
function resolveEffectiveMetadata(options: EncoderOptions): {
  iccProfile: ArrayBuffer | null;
  exif: ArrayBuffer | null;
  xmp: ArrayBuffer | null;
} {
  const m = options.metadata;
  return {
    iccProfile: m?.includeICC !== false ? options.iccProfile : null,
    exif: m?.includeExif !== false ? options.exif : null,
    xmp: m?.includeXMP !== false ? options.xmp : null,
  };
}

/** True when box-options v2 features are needed (compress, container control, custom boxes). */
function needsBoxOptsV2(options: EncoderOptions): boolean {
  const m = options.metadata;
  const hasJumbf = options.jumbfBoxes != null && options.jumbfBoxes.length > 0;
  return !!(m?.compressBoxes || m?.forceContainer || m?.rawCodestream) ||
    (options.customBoxes != null && options.customBoxes.length > 0) ||
    hasJumbf;
}

const _textEncoder = new TextEncoder();
const _textDecoder = new TextDecoder();

function applyAnimFrameMetadata(ev: Record<string, unknown>, module: LibjxlWasmModule, dec: number): void {
  const frameIndex = module._jxl_wasm_dec_frame_index?.(dec) ?? undefined;
  const frameDuration = module._jxl_wasm_dec_frame_duration!(dec);
  const isLastFrame = module._jxl_wasm_dec_is_last_frame
    ? (module._jxl_wasm_dec_is_last_frame(dec) !== 0)
    : undefined;
  const animTicksPerSecond = module._jxl_wasm_dec_anim_ticks_per_second?.(dec) ?? undefined;
  const animLoopCount = module._jxl_wasm_dec_anim_loop_count?.(dec) ?? undefined;
  const namePtr = module._jxl_wasm_dec_frame_name_ptr?.(dec) ?? 0;
  if (frameIndex !== undefined) ev.frameIndex = frameIndex;
  if (frameDuration !== undefined) ev.frameDuration = frameDuration;
  if (namePtr !== 0) {
    let end = namePtr;
    while (module.HEAPU8[end] !== 0 && end < namePtr + 256) end++;
    ev.frameName = _textDecoder.decode(module.HEAPU8.subarray(namePtr, end));
  }
  if (isLastFrame !== undefined) ev.isLastFrame = isLastFrame;
  if (animTicksPerSecond !== undefined) ev.animTicksPerSecond = animTicksPerSecond;
  if (animLoopCount !== undefined) ev.animLoopCount = animLoopCount;
}

/** Expands jumbfBoxes into MetadataBoxSpec entries (type "jumb", compress true by default). */
function expandJumbfBoxes(options: EncoderOptions): MetadataBoxSpec[] {
  if (!options.jumbfBoxes?.length) return [];
  const out: MetadataBoxSpec[] = [];
  for (const j of options.jumbfBoxes) {
    const data = j.data instanceof ArrayBuffer ? new Uint8Array(j.data) : j.data;
    out.push({ type: "jumb", data, compress: true });
  }
  return out;
}

// WasmBoxOpts layout (20 bytes, little-endian uint32):
//   offset  0: compress_boxes
//   offset  4: force_container
//   offset  8: raw_codestream
//   offset 12: custom_boxes_ptr  (WASM heap ptr)
//   offset 16: num_custom_boxes
const WASM_BOX_OPTS_BYTES = 20;

// WasmCustomBox layout (16 bytes):
//   offset  0: box_type[4] (char)
//   offset  4: data_ptr    (uint32)
//   offset  8: data_size   (uint32)
//   offset 12: compress    (uint32)
const WASM_CUSTOM_BOX_BYTES = 16;

/**
 * Allocates WasmBoxOpts + WasmCustomBox[] on the WASM heap.
 * Returns ptr to WasmBoxOpts and an array of all heap allocations to free.
 * Returns ptr=0 if nothing was marshaled (no-op path).
 */
function marshalBoxOpts(
  module: LibjxlWasmModule,
  options: EncoderOptions,
): { ptr: number; freePtrs: number[] } {
  const m = options.metadata;
  if (!m && !(options.customBoxes?.length) && !(options.jumbfBoxes?.length)) {
    return { ptr: 0, freePtrs: [] };
  }
  const jumbfCustom = expandJumbfBoxes(options);
  const customBoxes = [...(options.customBoxes ?? []), ...jumbfCustom];
  if (!m && customBoxes.length === 0) return { ptr: 0, freePtrs: [] };

  const freePtrs: number[] = [];

  // Build WasmCustomBox array.
  let customBoxesArrayPtr = 0;
  if (customBoxes.length > 0) {
    const cbBuf = new Uint8Array(customBoxes.length * WASM_CUSTOM_BOX_BYTES);
    const dv = new DataView(cbBuf.buffer);
    for (let i = 0; i < customBoxes.length; i++) {
      const cb = customBoxes[i]!;
      const base = i * WASM_CUSTOM_BOX_BYTES;
      // Direct 4-byte type write (avoids string concat + slice + charCodeAt per box).
      const t = cb.type;
      cbBuf[base]     = (t.charCodeAt(0) || 0x20) & 0xff;
      cbBuf[base + 1] = (t.charCodeAt(1) || 0x20) & 0xff;
      cbBuf[base + 2] = (t.charCodeAt(2) || 0x20) & 0xff;
      cbBuf[base + 3] = (t.charCodeAt(3) || 0x20) & 0xff;
      const cbData: Uint8Array = cb.data instanceof ArrayBuffer ? new Uint8Array(cb.data) : cb.data;
      const cbDataPtr = mallocAndCopy(module, cbData, freePtrs);
      dv.setUint32(base + 4, cbDataPtr, true);
      dv.setUint32(base + 8, cbData.byteLength, true);
      dv.setUint32(base + 12, cb.compress ? 1 : 0, true);
    }
    customBoxesArrayPtr = mallocAndCopy(module, cbBuf, freePtrs);
  }

  // Build WasmBoxOpts.
  const boBuf = new Uint8Array(WASM_BOX_OPTS_BYTES);
  const boDv = new DataView(boBuf.buffer);
  boDv.setUint32(0,  m?.compressBoxes  ? 1 : 0, true);
  boDv.setUint32(4,  (!m?.rawCodestream && m?.forceContainer) ? 1 : 0, true);
  boDv.setUint32(8,  m?.rawCodestream  ? 1 : 0, true);
  boDv.setUint32(12, customBoxesArrayPtr, true);
  boDv.setUint32(16, customBoxes.length, true);

  const ptr = mallocAndCopy(module, boBuf, freePtrs);
  return { ptr, freePtrs };
}

// WasmAnimationFrame layout (28 bytes, 4-byte aligned uint32):
//   offset  0: pixels_ptr  — WASM heap ptr to RGBA pixel data
//   offset  4: pixels_size — byte length of pixel buffer
//   offset  8: width       — frame width in px
//   offset 12: height      — frame height in px
//   offset 16: duration    — frame duration in ticks
//   offset 20: name_ptr    — WASM heap ptr to UTF-8 name string (0 if absent)
//   offset 24: name_size   — byte length of name string
//   offset 28: blend_mode  — JxlBlendMode value (0=replace, 1=add, 2=blend, 3=muladd, 4=mul)
const WASM_ANIMATION_FRAME_BYTES = 32;

// WasmAnimationOpts layout (8 bytes):
//   offset 0: ticks_per_second (uint32)
//   offset 4: loop_count       (uint32)
const WASM_ANIMATION_OPTS_BYTES = 8;

/**
 * Allocates WasmAnimationFrame[] + WasmAnimationOpts on the WASM heap.
 * Returns ptr to the frame array, ptr to the animation options struct,
 * and an array of all heap allocations to free.
 * `framesPtr` and `animOptsPtr` can be 0 if `_malloc` fails (same semantics as marshalBoxOpts).
 */
function marshalAnimationFrames(
  module: LibjxlWasmModule,
  frames: readonly AnimationFrame[],
  animOpts: AnimationOptions | undefined,
): { framesPtr: number; animOptsPtr: number; freePtrs: number[] } {
  const freePtrs: number[] = [];

  const framesBuf = new Uint8Array(frames.length * WASM_ANIMATION_FRAME_BYTES);
  const framesDv = new DataView(framesBuf.buffer);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    const base = i * WASM_ANIMATION_FRAME_BYTES;
    const pixelData = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data;
    const pixelsPtr = mallocAndCopy(module, pixelData, freePtrs);
    framesDv.setUint32(base,      pixelsPtr,            true);
    framesDv.setUint32(base +  4, pixelData.byteLength, true);
    framesDv.setUint32(base +  8, f.width,              true);
    framesDv.setUint32(base + 12, f.height,             true);
    framesDv.setUint32(base + 16, f.duration,           true);
    let namePtr = 0;
    let nameSize = 0;
    if (f.name != null && f.name.length > 0) {
      const nameBytes = _textEncoder.encode(f.name);
      namePtr = mallocAndCopy(module, nameBytes, freePtrs);
      nameSize = nameBytes.byteLength;
    }
    framesDv.setUint32(base + 20, namePtr,  true);
    framesDv.setUint32(base + 24, nameSize, true);
    const blendMode = encodeBlendMode(f.blendMode);
    framesDv.setUint32(base + 28, blendMode, true);
  }

  const framesPtr = mallocAndCopy(module, framesBuf, freePtrs);

  const animBuf = new Uint8Array(WASM_ANIMATION_OPTS_BYTES);
  const animDv = new DataView(animBuf.buffer);
  animDv.setUint32(0, animOpts?.ticksPerSecond ?? 1000, true);
  animDv.setUint32(4, animOpts?.loopCount      ?? 0,    true);
  const animOptsPtr = mallocAndCopy(module, animBuf, freePtrs);

  return { framesPtr, animOptsPtr, freePtrs };
}

function resolveEncoderBridgeSettings(options: EncoderOptions) {
  const modular = options.modular ?? -1;
  const brotliEffort = options.brotliEffort != null ? Math.max(-1, Math.min(11, Math.round(options.brotliEffort))) : -1;
  const decodingSpeed = options.decodingSpeed != null ? Math.max(0, Math.min(4, Math.round(options.decodingSpeed))) : -1;
  const photonNoiseIso = options.photonNoiseIso != null ? Math.max(0, Math.round(options.photonNoiseIso)) : 0;
  const resampling = resolveResampling(options.resampling);
  const alreadyDownsampled = !!options.alreadyDownsampled;
  const upsamplingMode = options.upsamplingMode != null ? Math.max(-1, Math.min(1, Math.round(options.upsamplingMode))) : -1;
  const ecResampling = options.ecResampling != null ? resolveResampling(options.ecResampling) : -1;
  let epf = options.epf != null ? Math.round(options.epf) : -1;
  if (epf < -1 || epf > 3) {
    // eslint-disable-next-line no-console
    console.warn('[jxl-wasm] epf out of range (-1..3 per cjxl ProcessFlag); clamped.');
    epf = Math.max(-1, Math.min(3, epf));
  }
  const gaborish = options.gaborish != null ? (options.gaborish <= 0 ? 0 : 1) : -1;
  const dots = options.dots != null ? (options.dots <= 0 ? 0 : 1) : -1;
  const patches = options.patches != null ? (options.patches <= 0 ? 0 : 1) : -1;
  const colorTransform = options.colorTransform != null ? Math.max(-1, Math.min(2, Math.round(options.colorTransform))) : -1;
  // JPEG strip controls (cjxl row 7 / dec-hints strip=exif|xmp|jumbf + enum 35-37). Default 1=keep. Extract from jpegReconstruction (or advancedControls for lab). Warnings emitted at transcode use sites (exact cjxl text).
  // Row 12: full dec-hints also carries colorSpace / icc for color override (raw or recon).
  let jpegKeepExif = 1, jpegKeepXmp = 1, jpegKeepJumbf = 1;
  let jpegColorSpace: string | undefined;
  let jpegIcc: Uint8Array | undefined;
  const jr = (options as any).jpegReconstruction || options.jpegReconstruction;
  if (jr) {
    if (jr.keepExif !== undefined) jpegKeepExif = (jr.keepExif ? 1 : 0);
    if (jr.keepXmp !== undefined) jpegKeepXmp = (jr.keepXmp ? 1 : 0);
    if (jr.keepJumbf !== undefined) jpegKeepJumbf = (jr.keepJumbf ? 1 : 0);
    if (jr.colorSpace) jpegColorSpace = jr.colorSpace;
    if (jr.icc) jpegIcc = jr.icc;
  }
  const acJr = (options as any).advancedControls && (options as any).advancedControls.jpegReconstruction;
  if (acJr) {
    if (acJr.keepExif !== undefined) jpegKeepExif = (acJr.keepExif ? 1 : 0);
    if (acJr.keepXmp !== undefined) jpegKeepXmp = (acJr.keepXmp ? 1 : 0);
    if (acJr.keepJumbf !== undefined) jpegKeepJumbf = (acJr.keepJumbf ? 1 : 0);
    if (acJr.colorSpace) jpegColorSpace = acJr.colorSpace;
    if (acJr.icc) jpegIcc = acJr.icc;
  }

  // Row 9: frameIndexing validation (exact regex + first-char rule from cjxl ProcessFlags).
  let frameIndexing = options.frameIndexing || '';
  if (frameIndexing) {
    let must_be_all_zeros = frameIndexing[0] !== '1';
    for (let c of frameIndexing) {
      if (c === '1') {
        if (must_be_all_zeros) {
          // eslint-disable-next-line no-console
          console.warn('[jxl-wasm] Invalid --frame_indexing (starts with 0 but has 1); per cjxl must all 0 if first 0. Ignoring.');
          frameIndexing = '';
          break;
        }
      } else if (c !== '0') {
        // eslint-disable-next-line no-console
        console.warn('[jxl-wasm] Invalid frameIndexing; must match ^(0*|1[01]*)$ per cjxl. Ignoring.');
        frameIndexing = '';
        break;
      }
    }
  }

  const allowExpertOptions = !!options.allowExpertOptions;
  const disablePerceptualHeuristics = !!options.disablePerceptualHeuristics;
  // First-class GROUP_ORDER + centers (cjxl row 1 / enum 13-15). Light validation mirroring cjxl ProcessFlags mutual-exclusion.
  let groupOrder = options.groupOrder != null ? (options.groupOrder ? 1 : 0) : 0;
  let centerX = options.centerX != null ? Math.floor(options.centerX) : -1;
  let centerY = options.centerY != null ? Math.floor(options.centerY) : -1;
  // Support nested advancedControls.groupOrder (lab emits it; native parity; design note shape).
  const acGo = (options as any).advancedControls?.groupOrder;
  if (acGo) {
    if (acGo.mode === 'center') groupOrder = 1;
    if (acGo.centerX != null) centerX = Math.floor(acGo.centerX);
    if (acGo.centerY != null) centerY = Math.floor(acGo.centerY);
  }
  if ((centerX !== -1 || centerY !== -1) && groupOrder !== 1) {
    // eslint-disable-next-line no-console
    console.warn('[jxl-wasm] centerX/centerY set without groupOrder=1; cjxl requires --group_order=1. Ignoring centers (per cjxl validation).');
    centerX = -1; centerY = -1;
  }

  // Buffering / streaming (cjxl row 6 / ID 34). Full first-class: strategy + streaming* + lowmem hints.
  // Priority: explicit strategy > lowMemoryMode (promote to 3) > streaming flags (force 3) > chunked legacy > 0.
  let buffering = 0;
  const b = options.buffering || (options as any).advancedControls?.buffering;
  if (b) {
    if (b.strategy !== undefined) {
      buffering = b.strategy;
    } else if (b.lowMemoryMode) {
      buffering = 3;  // promote per phase3 / design
    } else if (b.streamingInput || b.streamingOutput) {
      buffering = 3;
    }
  } else if (options.chunked) {
    buffering = 2;
  }
  if ((b?.streamingInput || b?.streamingOutput) && buffering < 3) {
    buffering = 3;  // cjxl forces 3 for streaming_input
  }

  if (!options.progressive) {
    return { progressiveDc: 0, progressiveAc: 0, qProgressiveAc: 0, buffering, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, alreadyDownsampled, upsamplingMode, ecResampling, frameIndexing, allowExpertOptions, disablePerceptualHeuristics, epf, gaborish, dots, colorTransform, groupOrder, centerX, centerY, jpegKeepExif, jpegKeepXmp, jpegKeepJumbf };
  }
  // Single rollback boolean — flip to false to revert to legacy previewFirst defaults.
  const USE_SNEYERS_DEFAULT = true;
  // SNEYERS_PRESET defaults: applied when progressive+previewFirst are set and the
  // caller has NOT explicitly overridden the relevant flags. Locked recipe from
  // docs/Benchmark results/truly-progressive-2026-06-03.md.
  if (USE_SNEYERS_DEFAULT && options.previewFirst) {
    const dc = options.progressiveDc != null
      ? Math.max(0, Math.min(2, options.progressiveDc | 0))
      : 2;
    const ac = options.progressiveAc != null ? (options.progressiveAc ? 1 : 0) : 1;
    const qac = options.qProgressiveAc != null ? (options.qProgressiveAc ? 1 : 0) : 1;
    groupOrder = options.groupOrder != null ? (options.groupOrder ? 1 : 0) : 1;
    centerX = options.centerX != null ? Math.floor(options.centerX) : -1;
    centerY = options.centerY != null ? Math.floor(options.centerY) : -1;
    const acGo2 = (options as any).advancedControls?.groupOrder;
    if (acGo2) {
      if (acGo2.mode === 'center') groupOrder = 1;
      if (acGo2.centerX != null) centerX = Math.floor(acGo2.centerX);
      if (acGo2.centerY != null) centerY = Math.floor(acGo2.centerY);
    }
    if ((centerX !== -1 || centerY !== -1) && groupOrder !== 1) {
      // eslint-disable-next-line no-console
      console.warn('[jxl-wasm] centerX/centerY without groupOrder=1 (cjxl requires it); centers ignored.');
      centerX = -1; centerY = -1;
    }
    return {
      progressiveDc: dc,
      progressiveAc: ac,
      qProgressiveAc: qac,
      buffering,
      modular,
      brotliEffort,
      decodingSpeed: decodingSpeed >= 0 ? decodingSpeed : 0,
      photonNoiseIso,
      resampling,
      alreadyDownsampled,
      upsamplingMode,
      ecResampling,
      frameIndexing,
      allowExpertOptions,
      disablePerceptualHeuristics,
      epf,
      gaborish,
      dots,
      patches,
      colorTransform,
      groupOrder,
      centerX,
      centerY,
      jpegKeepExif,
      jpegKeepXmp,
      jpegKeepJumbf,
    };
  }
  const acEnabled = options.progressiveFlavor === "ac" || (options.progressiveFlavor !== "dc" && options.previewFirst);
  const progressiveDc = options.progressiveDc != null
    ? Math.max(0, Math.min(2, options.progressiveDc | 0))
    : (options.previewFirst ? 1 : 1);
  groupOrder = options.groupOrder != null ? (options.groupOrder ? 1 : 0) : (options.previewFirst ? 1 : 0);
  centerX = options.centerX != null ? Math.floor(options.centerX) : -1;
  centerY = options.centerY != null ? Math.floor(options.centerY) : -1;
  const acGo3 = (options as any).advancedControls?.groupOrder;
  if (acGo3) {
    if (acGo3.mode === 'center') groupOrder = 1;
    if (acGo3.centerX != null) centerX = Math.floor(acGo3.centerX);
    if (acGo3.centerY != null) centerY = Math.floor(acGo3.centerY);
  }
  if ((centerX !== -1 || centerY !== -1) && groupOrder !== 1) {
    // eslint-disable-next-line no-console
    console.warn('[jxl-wasm] centerX/centerY without groupOrder=1 (cjxl requires it); centers ignored.');
    centerX = -1; centerY = -1;
  }
  return {
    progressiveDc,
    progressiveAc: options.progressiveAc != null ? (options.progressiveAc ? 1 : 0) : (acEnabled ? 1 : 0),
    qProgressiveAc: options.qProgressiveAc != null ? (options.qProgressiveAc ? 1 : 0) : (acEnabled ? 1 : 0),
    buffering,
    modular,
    brotliEffort,
    decodingSpeed,
    photonNoiseIso,
    resampling,
    alreadyDownsampled,
    upsamplingMode,
    ecResampling,
    frameIndexing,
    allowExpertOptions,
    disablePerceptualHeuristics,
    epf,
    gaborish,
    dots,
    colorTransform,
    groupOrder,
    centerX,
    centerY,
    jpegKeepExif,
    jpegKeepXmp,
    jpegKeepJumbf,
  };
}

function resolveResampling(value: unknown): ResamplingFactor {
  return value === 2 || value === 4 || value === 8 ? value : 1;
}

function resolveCodestreamLevel(value: unknown): -1 | 5 | 10 {
  return value === 5 || value === 10 ? value : -1;
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

export function detectTier(): Tier {
  const envTier = getEnvForcedTier();
  if (envTier) return envTier;
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

function getEnvForcedTier(): Tier | null {
  const env = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const tier = env?.JXL_WASM_FORCE_TIER;
  return tier === "relaxed-simd-mt" || tier === "simd-mt" || tier === "simd" || tier === "scalar" ? tier : null;
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
let cachedModule: LibjxlWasmModule | undefined;
let testModuleFactory: JxlModuleFactory | null = null;
let _forcedTier: Tier | null = null;
let _cachedDetectedTier: Tier | undefined;

export function setJxlModuleFactoryForTesting(factory: JxlModuleFactory | null): void {
  testModuleFactory = factory;
  modulePromise = undefined;
  cachedModule = undefined;
}

/**
 * Override the WASM tier used on the next module load.
 * Pass null to restore auto-detection via detectTier().
 * Resets the cached module so the next encode/decode reloads with the new tier.
 */
export function setForcedTier(tier: Tier | null): void {
  _forcedTier = tier;
  modulePromise = undefined;
  cachedModule = undefined;
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
export async function transcodeJpegToJxl(jpeg: ArrayBuffer | Uint8Array, recon?: { cfl?: boolean; compressBoxes?: boolean; emitWarnings?: boolean; storeJPEGMetadata?: boolean; keepExif?: 0|1; keepXmp?: 0|1; keepJumbf?: 0|1; colorSpace?: string; icc?: Uint8Array; }): Promise<Uint8Array> {
  const module = await loadLibjxlModule();
  if (!getCapabilities(module).jpegTranscode) {
    throw new CapabilityMissing("JPEG→JXL transcode requires a rebuilt WASM with transcode bridge");
  }
  // Row 7: reconstruction warnings (exact text pattern from cjxl ProcessFlags color_hints_proxy + allow_jpeg_recon checks).
  const kx = recon?.keepExif ?? 1;
  const km = recon?.keepXmp ?? 1;
  const store = recon?.storeJPEGMetadata ?? true;
  if (kx === 0) {
    // eslint-disable-next-line no-console
    console.warn("Cannot strip exif metadata, try setting --allow_jpeg_reconstruction=0 (storeJPEGMetadata:false). Note that with that setting byte exact reconstruction of the JPEG file won't be possible.");
  }
  if (km === 0) {
    // eslint-disable-next-line no-console
    console.warn("Cannot strip xmp metadata, try setting --allow_jpeg_reconstruction=0 (storeJPEGMetadata:false). Note that with that setting byte exact reconstruction of the JPEG file won't be possible.");
  }
  // jumbf strip never warns per cjxl.
  const view = copyOrBorrowInput(jpeg, false);
  const ptr = module._malloc(view.byteLength);
  try {
    module.HEAPU8.set(view, ptr);
    const storeFlag = store ? 1 : 0;
    if (module._jxl_wasm_transcode_jpeg_to_jxl_v3) {
      const handle = module._jxl_wasm_transcode_jpeg_to_jxl_v3!(ptr, view.byteLength, storeFlag, kx, km, recon?.keepJumbf ?? 1);
      return takeBuffer(module, handle, "transcode").data;
    }
    const handle = module._jxl_wasm_transcode_jpeg_to_jxl!(ptr, view.byteLength);
    return takeBuffer(module, handle, "transcode").data;
  } finally {
    module._free(ptr);
  }
}

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
export async function encodeTiledRgba8(
  pixels: ArrayBuffer | Uint8Array,
  width: number,
  height: number,
  options: { tileSize: number; distance?: number; effort?: number; hasAlpha?: boolean },
): Promise<Uint8Array> {
  const module = await loadLibjxlModule();
  if (!module._jxl_wasm_encode_tiled_rgba8) {
    throw new CapabilityMissing("Tiled encode requires a rebuilt WASM with tile bridge");
  }
  const tileSize = options.tileSize;
  if (!Number.isInteger(tileSize) || tileSize < 16) {
    throw new Error(`tileSize must be an integer ≥ 16, got ${tileSize}`);
  }
  const distance = options.distance ?? 1.0;
  const effort   = options.effort ?? 3;
  const hasAlpha = options.hasAlpha !== false;

  const view = copyOrBorrowInput(pixels, false);
  const expectedBytes = width * height * 4;
  if (view.byteLength < expectedBytes) {
    throw new Error(`Pixel buffer too small: ${view.byteLength} < ${expectedBytes}`);
  }

  const ptr = module._malloc(view.byteLength);
  if (ptr === 0) throw new Error("WASM malloc failed for tiled encode input");
  try {
    module.HEAPU8.set(view, ptr);
    const handle = module._jxl_wasm_encode_tiled_rgba8(
      ptr, width, height, tileSize, distance, effort, hasAlpha ? 1 : 0,
    );
    return takeBuffer(module, handle, "tiled encode").data;
  } finally {
    module._free(ptr);
  }
}

/**
 * Decode a rectangular region from a tiled JXL produced by encodeTiledRgba8.
 * Only the JXL frames whose layer bounds overlap the region are decompressed;
 * other frames are skipped via JxlDecoderSkipFrames (header-only walk).
 *
 * Returns clamped region dimensions — caller should pre-clamp if exact size
 * is required.
 */
export async function decodeTiledRegionRgba8(
  jxlBytes: ArrayBuffer | Uint8Array,
  options: { tileSize: number; x: number; y: number; w: number; h: number; onMetric?: (name: string, value: number) => void },
): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  const module = await loadLibjxlModule();
  if (!module._jxl_wasm_decode_region_tiled_rgba8) {
    throw new CapabilityMissing("Tiled region decode requires a rebuilt WASM with tile bridge");
  }
  const { tileSize, x, y, w, h, onMetric } = options;
  if (!Number.isInteger(tileSize) || tileSize < 16) {
    throw new Error(`tileSize must be an integer ≥ 16, got ${tileSize}`);
  }

  const tStart = performance.now();
  const view = copyOrBorrowInput(jxlBytes, false);
  const t1 = performance.now();
  onMetric?.("tiled_region_input_prep", t1 - tStart);

  const t2 = performance.now();
  const ptr = module._malloc(view.byteLength);
  if (ptr === 0) throw new Error("WASM malloc failed for tiled decode input");
  const tMalloc = performance.now() - t2;
  onMetric?.("tiled_region_malloc", tMalloc);

  try {
    const t3 = performance.now();
    module.HEAPU8.set(view, ptr);
    const tHeapSet = performance.now() - t3;
    onMetric?.("tiled_region_heap_set", tHeapSet);

    const t4 = performance.now();
    const handle = module._jxl_wasm_decode_region_tiled_rgba8(
      ptr, view.byteLength, tileSize, x, y, w, h,
    );
    const tWasmDecode = performance.now() - t4;
    onMetric?.("tiled_region_wasm_decode", tWasmDecode);

    const t5 = performance.now();
    const buf = takeBuffer(module, handle, "tiled region decode");
    const tBufferRead = performance.now() - t5;
    onMetric?.("tiled_region_buffer_read", tBufferRead);

    const tTotal = performance.now() - tStart;
    onMetric?.("tiled_region_total", tTotal);

    return { pixels: buf.data, width: buf.width, height: buf.height };
  } finally {
    module._free(ptr);
  }
}

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
export async function encodeTileContainerRgba8(
  pixels: ArrayBuffer | Uint8Array,
  width: number,
  height: number,
  options: { tileSize: number; distance?: number; effort?: number; hasAlpha?: boolean },
): Promise<Uint8Array> {
  const module = await loadLibjxlModule();
  if (!module._jxl_wasm_encode_tile_container_rgba8) {
    throw new CapabilityMissing("Tile container encode requires a rebuilt WASM with JXTC bridge");
  }
  const tileSize = options.tileSize;
  if (!Number.isInteger(tileSize) || tileSize < 16) {
    throw new Error(`tileSize must be an integer ≥ 16, got ${tileSize}`);
  }
  const distance = options.distance ?? 1.0;
  const effort   = options.effort ?? 3;
  const hasAlpha = options.hasAlpha !== false;

  const view = copyOrBorrowInput(pixels, false);
  const expectedBytes = width * height * 4;
  if (view.byteLength < expectedBytes) {
    throw new Error(`Pixel buffer too small: ${view.byteLength} < ${expectedBytes}`);
  }

  const ptr = module._malloc(view.byteLength);
  if (ptr === 0) throw new Error("WASM malloc failed for tile container encode");
  try {
    module.HEAPU8.set(view, ptr);
    const handle = module._jxl_wasm_encode_tile_container_rgba8(
      ptr, width, height, tileSize, distance, effort, hasAlpha ? 1 : 0,
    );
    return takeBuffer(module, handle, "tile container encode").data;
  } finally {
    module._free(ptr);
  }
}

/**
 * Decode a rectangular region from a JXTC tile container produced by
 * encodeTileContainerRgba8. Each overlapping tile is decoded as a standalone
 * JXL bitstream — zero frame-walk overhead. Performance is linear in number
 * of overlapping tiles, regardless of total image size.
 */
export async function decodeTileContainerRegionRgba8(
  containerBytes: ArrayBuffer | Uint8Array,
  options: { x: number; y: number; w: number; h: number; onMetric?: (name: string, value: number) => void },
): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  const module = await loadLibjxlModule();
  if (!module._jxl_wasm_decode_tile_container_region_rgba8) {
    throw new CapabilityMissing("Tile container decode requires a rebuilt WASM with JXTC bridge");
  }
  const { x, y, w, h, onMetric } = options;

  const tStart = performance.now();
  const view = copyOrBorrowInput(containerBytes, false);
  const t1 = performance.now();
  onMetric?.("jxtc_input_prep", t1 - tStart);

  const t2 = performance.now();
  const ptr = module._malloc(view.byteLength);
  if (ptr === 0) throw new Error("WASM malloc failed for tile container decode");
  const tMalloc = performance.now() - t2;
  onMetric?.("jxtc_malloc", tMalloc);

  try {
    const t3 = performance.now();
    module.HEAPU8.set(view, ptr);
    const tHeapSet = performance.now() - t3;
    onMetric?.("jxtc_heap_set", tHeapSet);

    const t4 = performance.now();
    const handle = module._jxl_wasm_decode_tile_container_region_rgba8(
      ptr, view.byteLength, x, y, w, h,
    );
    const tWasmDecode = performance.now() - t4;
    onMetric?.("jxtc_wasm_decode", tWasmDecode);

    const t5 = performance.now();
    const buf = takeBuffer(module, handle, "tile container region decode");
    const tBufferRead = performance.now() - t5;
    onMetric?.("jxtc_buffer_read", tBufferRead);

    const tTotal = performance.now() - tStart;
    onMetric?.("jxtc_total", tTotal);

    return { pixels: buf.data, width: buf.width, height: buf.height };
  } finally {
    module._free(ptr);
  }
}

/** Start loading the WASM module immediately. Call during app startup to hide cold-start latency. */
export function preloadJxlModule(): void {
  void loadLibjxlModule();
}

export function getWrapperCapabilities(): WrapperCapabilities {
  return {
    regionDecode: true,
    exactSizeDecode: true,
    progressiveRegionDecode: false,
    tileAlignedRegionDecode: false,
    arbitraryRegionDecode: true,
    availableDownsampleFactors: [1, 2, 4, 8],
    animationSeek: cachedModule != null && typeof cachedModule._jxl_wasm_dec_seek_to_frame === "function",
  };
}

export function getDecodeGridInfo(): DecodeGridInfo {
  return {};
}

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

export function decodeViewport(options: DecodeViewportOptions): JxlDecoder {
  return createDecoder({
    format: options.format,
    region: options.region ?? null,
    downsample: pickDownsample({ ...options, imageWidth: options.imageWidth ?? null, imageHeight: options.imageHeight ?? null }),
    progressionTarget: options.progressionTarget ?? "final",
    emitEveryPass: options.emitEveryPass ?? false,
    preserveIcc: options.preserveIcc ?? true,
    preserveMetadata: options.preserveMetadata ?? false,
    targetWidth: options.targetWidth ?? null,
    targetHeight: options.targetHeight ?? null,
    fitMode: options.fitMode ?? null,
    ...(options.progressiveDetail !== undefined ? { progressiveDetail: options.progressiveDetail } : {}),
  });
}

export interface DecodeRegionLodOptions {
  format: PixelFormat;
  region?: Region | null;
  targetLongEdge: number;
}

export function decodeRegionLod(options: DecodeRegionLodOptions): JxlDecoder {
  return createDecoder({
    format: options.format,
    region: options.region ?? null,
    downsample: 1,
    progressionTarget: "final",
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
    targetWidth: options.targetLongEdge,
    targetHeight: options.targetLongEdge,
    fitMode: "contain",
  });
}

export function normalizedToPixelExtent(
  norm: { x: number; y: number; w: number; h: number },
  imageWidth: number,
  imageHeight: number,
): Region {
  return {
    x: Math.round(norm.x * imageWidth),
    y: Math.round(norm.y * imageHeight),
    w: Math.max(1, Math.round(norm.w * imageWidth)),
    h: Math.max(1, Math.round(norm.h * imageHeight)),
  };
}

export function pixelToNormalizedExtent(
  region: Region,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: region.x / imageWidth,
    y: region.y / imageHeight,
    w: region.w / imageWidth,
    h: region.h / imageHeight,
  };
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
    if (this.readIndex >= this.chunkQueue.length) {
      this.chunkQueue.length = 0;
      this.readIndex = 0;
    } else if (this.readIndex > 64 && this.readIndex * 2 > this.chunkQueue.length) {
      this.chunkQueue.copyWithin(0, this.readIndex);
      this.chunkQueue.length -= this.readIndex;
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
    const progressiveDetail = resolveDecoderProgressiveDetail(this.options);
    const dec = module._jxl_wasm_dec_create!(fmtIndex, progressiveDetail);
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

      const infoBitsPerSample: 8 | 16 | 32 = fmtIndex === 2 ? 32 : fmtIndex === 1 ? 16 : 8;
      // buildInfo memoizes on first call from pixel data (hasAlpha from buffer).
      // The header event calls makeHeaderInfo directly to avoid locking in a wrong hasAlpha.
      const makeHeaderInfo = (w: number, h: number): ImageInfo =>
        ({ width: w, height: h, bitsPerSample: infoBitsPerSample, hasAlpha: false, hasAnimation: false, jpegReconstructionAvailable: false });
      const buildInfo = (w: number, h: number, hasAlpha: boolean): ImageInfo => {
        info ??= { width: w, height: h, bitsPerSample: infoBitsPerSample, hasAlpha, hasAnimation: false, jpegReconstructionAvailable: false };
        return info;
      };

      const bpc = fmtIndex === 2 ? 4 : fmtIndex === 1 ? 2 : 1;
      const pixelStride = 4 * bpc;
      const fmt = this.options.format;
      const takeAndWrap = (handle: number): { pixels: { data: Uint8Array; width: number; height: number; region?: Region }; evInfo: ImageInfo } | null => {
        if (handle === 0) return null;
        const tBufStart = performance.now();
        const buf = takeBuffer(module, handle, "decode");
        const tBuf = performance.now() - tBufStart;
        onMetric?.("decode_buffer_extract_ms", tBuf);

        const tRegionStart = performance.now();
        const pixels = applyRegionAndDownsample(buf.data, buf.width, buf.height, this.options.region ?? null, this.options.downsample ?? 1, bpc);
        const tRegion = performance.now() - tRegionStart;
        onMetric?.("decode_region_downsample_ms", tRegion);

        // When ROI/downsample crops the frame, pixels.width/height differ from full image dims.
        // buildInfo memoizes on first call (full dims from header), so we must not pass it
        // cropped dims — it would return the already-memoized full-dim object regardless.
        // Instead, derive evInfo from the base info with actual pixel dimensions.
        const baseInfo = buildInfo(buf.width, buf.height, buf.hasAlpha);
        const evInfo: ImageInfo = (pixels.width !== buf.width || pixels.height !== buf.height)
          ? { ...baseInfo, width: pixels.width, height: pixels.height }
          : baseInfo;
        return { pixels, evInfo };
      };

      const hasRegion = this.options.region != null;
      const onMetric = this.options.onMetric;
      let fallbackMetricEmitted = false;
      let drainPending = false;
      let inputClosed = false;
      let pushWasmMs = 0;
      let pushCopyMs = 0;
      let pushInputWasmMs = 0;
      let pushFlushWasmMs = 0;
      let headerProbeMs = 0;
      let takeFlushedMs = 0;
      let takeFinalMs = 0;

      // IMPROVEMENT-7: Batch all queued data chunks into one WASM write per tick.
      // IMPROVEMENT-9: Guard dec_width/dec_height calls behind !headerEmitted — skip 2 WASM
      // FFI calls per chunk once the header has been emitted.
      while (!done && !this.cancelled) {
        if (!drainPending && this.chunkQueue.length <= this.readIndex) {
          await this.waitForQueueItem();
          if (this.cancelled) return;
        }

        let result = 0;

        if (drainPending) {
          const tPushStart = performance.now();
          result = decPush(dec, 0, 0);
          const tPushMs = performance.now() - tPushStart;
          pushWasmMs += tPushMs;
          pushFlushWasmMs += tPushMs;
          if (result < 0) throw new Error(`JXL decode error: ${decError(dec)}`);
        } else if (this.chunkQueue.length > this.readIndex && this.chunkQueue[this.readIndex] === null) {
          // Close sentinel — flush remaining decoder state, then keep draining until done.
          this.readIndex++;
          this.compactQueue();
          decCloseInput(dec);
          inputClosed = true;
          const tPushStart = performance.now();
          result = decPush(dec, 0, 0);
          const tPushMs = performance.now() - tPushStart;
          pushWasmMs += tPushMs;
          pushFlushWasmMs += tPushMs;
          if (result < 0) throw new Error(`JXL decode error: ${decError(dec)}`);
        } else {
          // Pending byte count maintained incrementally — no scan needed.
          const batchBytes = this.queuedBytes;
          if (batchBytes <= 0) continue;
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
          const tCopyStart = performance.now();
          pushCopyMs += performance.now() - tCopyStart;
          const tPushStart = performance.now();
          result = decPush(dec, chunkBufPtr, batchBytes);
          const tPushMs = performance.now() - tPushStart;
          pushWasmMs += tPushMs;
          pushInputWasmMs += tPushMs;
          if (result < 0) throw new Error(`JXL decode error: ${decError(dec)}`);
        }

        if (!headerEmitted) {
          const tHeaderProbeStart = performance.now();
          const w = decWidth(dec);
          const h = decHeight(dec);
          headerProbeMs += performance.now() - tHeaderProbeStart;
          if (w > 0 && h > 0) {
            headerEmitted = true;
            yield { type: "header", info: makeHeaderInfo(w, h) };
            if (this.options.progressionTarget === "header") return;
          }
        }

        if (result === 1) {
          drainPending = true;
          gotRealFlush = true;
          flushCount++;
          const stage: DecodeStage = flushCount === 1 ? "dc" : "pass";
          const tTakeStart = performance.now();
          const wrapped = takeAndWrap(decTakeFlushed(dec));
          takeFlushedMs += performance.now() - tTakeStart;
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
              outPixels = { data: resized.data, width: resized.width, height: resized.height, ...(rawPixels.region !== undefined ? { region: rawPixels.region } : {}) };
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
              sourceScale: this.options.downsample ?? 1,
              progressiveRegion: false,
              ...(hasRegion ? { regionFallback: "full-frame-then-crop" as const } : {}),
              ...(outPixels.region !== undefined ? { region: outPixels.region } : {}),
            };
            if (module._jxl_wasm_dec_frame_duration) {
              applyAnimFrameMetadata(ev as unknown as Record<string, unknown>, module, dec);
            }
            yield ev;
            if (this.options.progressionTarget !== "final" && !this.options.emitEveryPass) return;
          }
          continue;
        }

        drainPending = false;
        if (result === 2) {
          done = true;
        } else if (inputClosed) {
          throw new Error(`JXL decode error: ${decError(dec)}`);
        }
      }

      if (done) {
        const tTakeFinalStart = performance.now();
        const wrapped = takeAndWrap(decTakeFinal(dec));
        takeFinalMs += performance.now() - tTakeFinalStart;
        if (wrapped !== null) {
          const { pixels: rawPixels, evInfo } = wrapped;

          // P5: emit decode metrics on final frame.
          if (onMetric) {
            onMetric("decode_scale_used", this.options.downsample ?? 1);
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
            outPixels = { data: resized.data, width: resized.width, height: resized.height, ...(rawPixels.region !== undefined ? { region: rawPixels.region } : {}) };
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
              sourceScale: this.options.downsample ?? 1,
              progressiveRegion: false,
              ...(hasRegion ? { regionFallback: "full-frame-then-crop" as const } : {}),
              ...(outPixels.region !== undefined ? { region: outPixels.region } : {}),
            };
            if (module._jxl_wasm_dec_frame_duration) {
              applyAnimFrameMetadata(ev as unknown as Record<string, unknown>, module, dec);
            }
            yield ev;
            if (this.options.progressionTarget !== "final") return;
          }

          const ev: Extract<DecodeEvent, { type: "final" }> = {
            type: "final",
            info: outInfo,
            pixels: outPixels.data,
            format: fmt,
            pixelStride,
            sourceScale: this.options.downsample ?? 1,
            progressiveRegion: false,
            ...(hasRegion ? { regionFallback: "full-frame-then-crop" as const } : {}),
            ...(outPixels.region !== undefined ? { region: outPixels.region } : {}),
          };
          if (module._jxl_wasm_dec_has_gain_map?.(dec) === 1 && module._jxl_wasm_dec_take_gain_map) {
            const gmHandle = module._jxl_wasm_dec_take_gain_map(dec);
            if (gmHandle !== 0) {
              try {
                const gmDataPtr = module._jxl_wasm_buffer_data(gmHandle);
                const gmSize = module._jxl_wasm_buffer_size(gmHandle);
                if (gmDataPtr !== 0 && gmSize > 0) {
                  // Direct subarray + set instead of slice for the gain map data copy.
                  // Consistent with other zero-alloc/copy patterns on hot decode paths.
                  const gm = new Uint8Array(gmSize);
                  gm.set(module.HEAPU8.subarray(gmDataPtr, gmDataPtr + gmSize));
                  ev.gainMap = { data: gm };
                }
              } finally {
                module._jxl_wasm_buffer_free(gmHandle);
              }
            }
          }
          // Populate animation per-frame metadata when bridge accessors are present.
          if (module._jxl_wasm_dec_frame_duration) {
            applyAnimFrameMetadata(ev as unknown as Record<string, unknown>, module, dec);
          }
          yield ev;
        }
      }
      if (onMetric) {
        onMetric("progressive_decoder_push_wasm_ms", pushWasmMs);
        onMetric("progressive_decoder_push_copy_ms", pushCopyMs);
        onMetric("progressive_decoder_push_input_wasm_ms", pushInputWasmMs);
        onMetric("progressive_decoder_push_flush_wasm_ms", pushFlushWasmMs);
        onMetric("progressive_decoder_header_probe_ms", headerProbeMs);
        onMetric("progressive_decoder_take_flushed_ms", takeFlushedMs);
        onMetric("progressive_decoder_take_final_ms", takeFinalMs);
      }
    } finally {
      if (chunkBufPtr !== 0) module._free(chunkBufPtr);
      decFree(dec);
    }
  }

  private async *eventsOneShot(module: LibjxlWasmModule): AsyncIterable<DecodeEvent> {
    // Drain all chunks until input closed
    const allChunks: Uint8Array[] = [];
    let totalSize = 0;
    while (!this.cancelled) {
      await this.waitForQueueItem();
      if (this.cancelled) return;
      const item = this.chunkQueue[this.readIndex++];
      this.compactQueue();
      if (item === null || item === undefined) break;
      this.queuedBytes -= item.byteLength;
      totalSize += item.byteLength;
      allChunks.push(item);
    }
    if (this.cancelled) return;

    const fmt = this.options.format;
    const bpc = fmt === "rgbaf32" ? 4 : fmt === "rgba16" ? 2 : 1;
    const pixelStride = 4 * bpc;
    // Write all chunks directly into a single WASM heap buffer — no intermediate JS allocation.
    const inputPtr = module._malloc(totalSize);
    let decodedHandle = 0;
    const onMetric = this.options.onMetric;
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
      const tDecodeWasmStart = performance.now();
      const decoded = callDecodeFromPtr(module, inputPtr, totalSize, this.options.downsample ?? 1, fmt, cppDidCrop ? regionForDecode : null);
      onMetric?.("full_decoder_wasm_ms", performance.now() - tDecodeWasmStart);
      decodedHandle = decoded.handle;
      // If C++ did the crop, decoded.width/height already reflect the region; no further JS crop.
      // Otherwise, scale region into downsampled coords and apply in JS.
      const ds = this.options.downsample ?? 1;
      const scaledRegion = (!cppDidCrop && regionForDecode != null) ? {
        x: Math.trunc(regionForDecode.x / ds),
        y: Math.trunc(regionForDecode.y / ds),
        w: Math.ceil(regionForDecode.w / ds),
        h: Math.ceil(regionForDecode.h / ds),
      } : null;
      const tRegionStart = performance.now();
      const pixels = applyRegionAndDownsample(
        decoded.data,
        decoded.width,
        decoded.height,
        scaledRegion,
        1,
        bpc,
      );
      onMetric?.("full_decoder_region_downsample_ms", performance.now() - tRegionStart);
      // C++ crop path skips applyRegionAndDownsample's region-setter; restore it to match JS path.
      if (cppDidCrop) pixels.region = { x: 0, y: 0, w: pixels.width, h: pixels.height };
      // P1: apply bilinear resize to exact target size if requested.
      const targetW = this.options.targetWidth;
      const targetH = this.options.targetHeight;
      const fitMode = this.options.fitMode ?? "contain";
      let outPixels = pixels;
      if (targetW != null && targetH != null && targetW > 0 && targetH > 0) {
        const tResizeStart = performance.now();
        const resized = applyTargetResize(pixels.data, pixels.width, pixels.height, targetW, targetH, fitMode, bpc);
        onMetric?.("full_decoder_resize_ms", performance.now() - tResizeStart);
        outPixels = { data: resized.data, width: resized.width, height: resized.height, ...(pixels.region !== undefined ? { region: pixels.region } : {}) };
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
      const actualScale = this.options.downsample ?? 1;
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

  async *seekToFrame(frameIndex: number): AsyncIterable<DecodeEvent> {
    if (this.eventsStarted) {
      yield { type: "error", code: "InvalidState", message: "seekToFrame cannot be called after events() has been consumed." };
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
      // Software fallback: decode all frames, emit only those at frameIndex and beyond.
      // Post-rebuild: replace inner loop with _jxl_wasm_dec_seek_to_frame(dec, frameIndex)
      // before entering the event loop to skip at the C++ level.
      const source = getCapabilities(module).progressiveDecode
        ? this.eventsProgressive(module)
        : this.eventsOneShot(module);
      for await (const ev of source) {
        if (ev.type === "header" || ev.type === "error" || ev.type === "budget_exceeded") {
          yield ev;
        } else if (ev.type === "progress" || ev.type === "final") {
          if ((ev.frameIndex ?? 0) >= frameIndex) yield ev;
        }
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

  async *seekToTime(timeMs: number): AsyncIterable<DecodeEvent> {
    if (this.eventsStarted) {
      yield { type: "error", code: "InvalidState", message: "seekToTime cannot be called after events() has been consumed." };
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
      const source = getCapabilities(module).progressiveDecode
        ? this.eventsProgressive(module)
        : this.eventsOneShot(module);
      // targetFrame computed lazily from first event carrying animTicksPerSecond.
      // Falls back to 0 for non-animation files (yield all events).
      let targetFrame = -1;
      for await (const ev of source) {
        if (ev.type === "header" || ev.type === "error" || ev.type === "budget_exceeded") {
          yield ev;
        } else if (ev.type === "progress" || ev.type === "final") {
          if (targetFrame === -1) {
            targetFrame = ev.animTicksPerSecond != null
              ? Math.floor(timeMs * ev.animTicksPerSecond / 1000)
              : 0;
          }
          if ((ev.frameIndex ?? 0) >= targetFrame) yield ev;
        }
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
  private readonly onMetric?: (name: string, value: number) => void;

  constructor(private readonly options: EncoderOptions) {
    this.sortedSidecarSizes = options.sidecarSizes ? [...options.sidecarSizes].sort((a, b) => a - b) : [];
    this.pixelByteTotal = expectedPixelBytes(options.width, options.height, options.format);
    if (options.onMetric !== undefined) this.onMetric = options.onMetric;
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
        const tWasmPushStart = performance.now();
        if (module._jxl_wasm_enc_pixels_ptr && module._jxl_wasm_enc_advance_written) {
          const ptr = module._jxl_wasm_enc_pixels_ptr(this.wasmEncState, view.byteLength);
          if (ptr === 0) throw new Error("JXL streaming pixel push failed (0)");
          module.HEAPU8.set(view, ptr);
          const rc = module._jxl_wasm_enc_advance_written(this.wasmEncState, view.byteLength);
          if (rc !== 0) throw new Error(`JXL streaming pixel push failed (${rc})`);
        } else {
          // Back-compat with older WASM bridge: temp copy into WASM, then bridge memcpy.
          const ptr = module._malloc(view.byteLength);
          try {
            module.HEAPU8.set(view, ptr);
            const rc = module._jxl_wasm_enc_push_chunk!(this.wasmEncState, ptr, view.byteLength);
            if (rc !== 0) throw new Error(`JXL streaming pixel push failed (${rc})`);
          } finally {
            module._free(ptr);
          }
        }
        this.onMetric?.("enc_push_pixels_ms", performance.now() - tWasmPushStart);
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
    const tLoadStart = performance.now();
    const module = await loadLibjxlModule();
    this.onMetric?.("enc_module_load_ms", performance.now() - tLoadStart);
    this.wasmModule = module;
    if (this.cancelled) return module;

    const caps = getCapabilities(module);
    // Use streaming input for all non-sidecar, non-gainMap paths.
    // B3: ICC/EXIF/XMP metadata is passed via jxl_wasm_enc_set_metadata so the streaming
    // path no longer falls back to the buffered encode for metadata-bearing RAW images.
    // boxOpts (compress, forceContainer) and gain map still require the buffered path.
    const wantSidecars = this.sortedSidecarSizes.length > 0 && caps.sidecars;
    const { iccProfile: effIcc, exif: effExif, xmp: effXmp } = resolveEffectiveMetadata(this.options);
    const needsBufferedPath = wantSidecars || needsBoxOptsV2(this.options) || this.options.gainMap != null;
    if (!needsBufferedPath && caps.streamingInput) {
      const distance = this.options.distance ?? distanceFromQuality(this.options.quality);
      // A3: rgb8 maps to fmtIndex 3; rgba16→1, rgbaf32→2, rgba8→0
      const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : this.options.format === "rgb8" ? 3 : 0;
      const { progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, centerX, centerY, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, alreadyDownsampled, upsamplingMode, ecResampling, frameIndexing, allowExpertOptions, disablePerceptualHeuristics, epf, gaborish, dots, colorTransform, jpegKeepExif, jpegKeepXmp, jpegKeepJumbf } = resolveEncoderBridgeSettings(this.options);
      const orientation = this.options.orientation ?? 1;
      if (orientation !== 1 && !caps.orientation) {
        // Bridge lacks the _z / _v3 entrypoints. Pixels are still encoded but
        // JXL stores orientation = identity — viewers will display the sensor
        // orientation (rotated wrong for portrait shots). Rebuild jxl-wasm to
        // pick up the orientation bridge for correct output.
        // eslint-disable-next-line no-console
        console.warn(
          `[jxl-wasm] orientation=${orientation} requested but WASM bridge lacks _z/_v3 support. ` +
            "Rebuild packages/jxl-wasm to enable JXL's orientation-tag fast path.",
        );
      }
      const tCreateStart = performance.now();
      if (caps.extOptions && orientation !== 1 && module._jxl_wasm_enc_create_image_z) {
        // JXL "free rotation": record orientation in basic info, pixels stay sensor-native.
        this.wasmEncState = module._jxl_wasm_enc_create_image_z(
          this.options.width, this.options.height,
          distance, this.options.effort,
          fmtIndex, this.options.hasAlpha ? 1 : 0,
          progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder,
          modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling,
          epf, gaborish, dots, patches, colorTransform,
          orientation,
          centerX ?? -1, centerY ?? -1,
          jpegKeepExif, jpegKeepXmp, jpegKeepJumbf,
          alreadyDownsampled ? 1 : 0, upsamplingMode, ecResampling,
        );
      } else if (caps.extOptions && module._jxl_wasm_enc_create_image_y) {
        this.wasmEncState = module._jxl_wasm_enc_create_image_y(
          this.options.width, this.options.height,
          distance, this.options.effort,
          fmtIndex, this.options.hasAlpha ? 1 : 0,
          progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder,
          modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling,
          epf, gaborish, dots, patches, colorTransform,
          centerX ?? -1, centerY ?? -1,
          jpegKeepExif, jpegKeepXmp, jpegKeepJumbf,
          alreadyDownsampled ? 1 : 0, upsamplingMode, ecResampling,
        );
      } else if (caps.extOptions && module._jxl_wasm_enc_create_image_x) {
        this.wasmEncState = module._jxl_wasm_enc_create_image_x(
          this.options.width, this.options.height,
          distance, this.options.effort,
          fmtIndex, this.options.hasAlpha ? 1 : 0,
          progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder,
          modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling,
          jpegKeepExif, jpegKeepXmp, jpegKeepJumbf,
          alreadyDownsampled ? 1 : 0, upsamplingMode, ecResampling,
        );
      } else {
        this.wasmEncState = module._jxl_wasm_enc_create_image!(
          this.options.width, this.options.height,
          distance, this.options.effort,
          fmtIndex, this.options.hasAlpha ? 1 : 0,
          progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling,
          centerX ?? -1, centerY ?? -1,
        );
      }
      this.onMetric?.("enc_create_image_ms", performance.now() - tCreateStart);
      if (this.wasmEncState === 0) throw new Error("JXL streaming encoder: pixel buffer allocation failed");
      if (this.cancelled) {
        this.freeWasmState();
        return module;
      }
      // B3: push ICC/EXIF/XMP into WASM before pixels arrive
      if (module._jxl_wasm_enc_set_metadata && (effIcc !== null || effExif !== null || effXmp !== null)) {
        const tMetaStart = performance.now();
        const iccV = effIcc ? new Uint8Array(effIcc) : new Uint8Array(0);
        const exifV = effExif ? new Uint8Array(effExif) : new Uint8Array(0);
        const xmpV = effXmp ? new Uint8Array(effXmp) : new Uint8Array(0);
        const iccPtr = iccV.byteLength > 0 ? module._malloc(iccV.byteLength) : 0;
        const exifPtr = exifV.byteLength > 0 ? module._malloc(exifV.byteLength) : 0;
        const xmpPtr = xmpV.byteLength > 0 ? module._malloc(xmpV.byteLength) : 0;
        if (iccPtr) module.HEAPU8.set(iccV, iccPtr);
        if (exifPtr) module.HEAPU8.set(exifV, exifPtr);
        if (xmpPtr) module.HEAPU8.set(xmpV, xmpPtr);
        module._jxl_wasm_enc_set_metadata(this.wasmEncState, iccPtr, iccV.byteLength, exifPtr, exifV.byteLength, xmpPtr, xmpV.byteLength);
        if (iccPtr) module._free(iccPtr);
        if (exifPtr) module._free(exifPtr);
        if (xmpPtr) module._free(xmpPtr);
        this.onMetric?.("enc_set_metadata_ms", performance.now() - tMetaStart);
      }
      // intrinsicSize: signal display dimensions separate from encoded pixels (Retina @2×, etc.)
      if (this.options.intrinsicSize != null && typeof (module as unknown as Record<string, unknown>)._jxl_wasm_enc_set_intrinsic_size === "function") {
        (module as unknown as { _jxl_wasm_enc_set_intrinsic_size: (s: number, w: number, h: number) => void })
          ._jxl_wasm_enc_set_intrinsic_size(this.wasmEncState, this.options.intrinsicSize.width, this.options.intrinsicSize.height);
      }
      // disablePerceptualHeuristics: bypass butteraugli/XYB psychovisual model for fair benchmarking
      if (this.options.disablePerceptualHeuristics === true && typeof (module as unknown as Record<string, unknown>)._jxl_wasm_enc_set_frame_flags === "function") {
        (module as unknown as { _jxl_wasm_enc_set_frame_flags: (s: number, disablePerceptual: number) => void })
          ._jxl_wasm_enc_set_frame_flags(this.wasmEncState, 1);
      }
      const codestreamLevel = resolveCodestreamLevel(this.options.codestreamLevel);
      if (codestreamLevel !== -1 && typeof module._jxl_wasm_enc_set_codestream_level === "function") {
        module._jxl_wasm_enc_set_codestream_level(this.wasmEncState, codestreamLevel);
      }
      if (this.options.premultiply !== undefined && typeof module._jxl_wasm_enc_set_alpha_premultiply === "function") {
        module._jxl_wasm_enc_set_alpha_premultiply(this.wasmEncState, this.options.premultiply > 0 ? 1 : 0);
      }
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
      const extFn = this.options.format === "rgba16" ? "_jxl_wasm_encode_rgba16_x" : "_jxl_wasm_encode_rgbaf32_x";
      if (typeof module[encFn] !== "function" && typeof module[extFn] !== "function") {
        throw new CapabilityMissing(`${this.options.format} encode requires a rebuilt WASM with multi-format bridge`);
      }
    }

    // Animation encode path: multi-frame encode bypasses the single-image pixel buffer entirely.
    // Must be checked before the queuedPixelBytes guard (no pushPixels needed for animation).
    const frames = this.options.frames;
    if (frames != null && frames.length > 0) {
      const caps = getCapabilities(module);
      if (caps.animationEncode && typeof module._jxl_wasm_encode_animation === "function") {
        const distance = this.options.distance ?? distanceFromQuality(this.options.quality);
        const hasAlpha = this.options.hasAlpha ? 1 : 0;
        const fmt = this.options.format === "rgba16" ? 1 : this.options.format === "rgbaf32" ? 2 : 0;
        const { modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, alreadyDownsampled, upsamplingMode, ecResampling, frameIndexing, allowExpertOptions, disablePerceptualHeuristics, jpegKeepExif, jpegKeepXmp, jpegKeepJumbf } = resolveEncoderBridgeSettings(this.options);
        const { iccProfile: effIcc, exif: effExif, xmp: effXmp } = resolveEffectiveMetadata(this.options);
        const iccView = effIcc ? copyOrBorrowInput(effIcc, false) : new Uint8Array(0);
        const exifView = effExif ? copyOrBorrowInput(effExif, false) : new Uint8Array(0);
        const xmpView = effXmp ? copyOrBorrowInput(effXmp, false) : new Uint8Array(0);
        const iccPtr = iccView.byteLength > 0 ? module._malloc(iccView.byteLength) : 0;
        const exifPtr = exifView.byteLength > 0 ? module._malloc(exifView.byteLength) : 0;
        const xmpPtr = xmpView.byteLength > 0 ? module._malloc(xmpView.byteLength) : 0;
        if (iccPtr !== 0) module.HEAPU8.set(iccView, iccPtr);
        if (exifPtr !== 0) module.HEAPU8.set(exifView, exifPtr);
        if (xmpPtr !== 0) module.HEAPU8.set(xmpView, xmpPtr);
        const { ptr: boxOptsPtr, freePtrs: boxOptsPtrs } = marshalBoxOpts(module, this.options);
        const { framesPtr, animOptsPtr, freePtrs: animFreePtrs } = marshalAnimationFrames(module, frames, this.options.animation);
        try {
          const handle = module._jxl_wasm_encode_animation(
            framesPtr, frames.length,
            distance, this.options.effort, fmt, hasAlpha,
            modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling,
            iccPtr, iccView.byteLength,
            exifPtr, exifView.byteLength,
            xmpPtr, xmpView.byteLength,
            boxOptsPtr, animOptsPtr,
          );
          const encoded = takeBuffer(module, handle, "animation encode");
          const compressedBytes = encoded.data.byteLength;
          yield encoded.data;
          this.encodeStats = { originalBytes: this.pixelByteTotal, compressedBytes, ratio: this.pixelByteTotal > 0 ? compressedBytes / this.pixelByteTotal : 0 };
        } finally {
          for (const p of animFreePtrs) module._free(p);
          for (const p of boxOptsPtrs) module._free(p);
          if (boxOptsPtr !== 0) module._free(boxOptsPtr);
          if (iccPtr !== 0) module._free(iccPtr);
          if (exifPtr !== 0) module._free(exifPtr);
          if (xmpPtr !== 0) module._free(xmpPtr);
        }
        return;
      }
      // Capability absent — fall through to single-frame encode (graceful degradation).
    }

    if (this.queuedPixelBytes !== this.pixelByteTotal) {
      throw new Error(`JXL encode expected ${this.pixelByteTotal} bytes for ${this.options.format}, got ${this.queuedPixelBytes}`);
    }

    let compressedBytes = 0;

    if (this.streamingInputActive && this.wasmEncState !== 0) {
      // #16: Streaming input path — pixels already in WASM pixel buffer.
      // enc_finish runs the encode; enc_take_chunk drains the output.
      try {
        const tFinishStart = performance.now();
        const rc = module._jxl_wasm_enc_finish!(this.wasmEncState);
        if (rc !== 0) throw new Error(`JXL streaming encode finish failed (${rc})`);
        this.onMetric?.("enc_finish_wasm_ms", performance.now() - tFinishStart);
        const tDrainStart = performance.now();
        let takeChunkMs = 0;
        let chunkHandle: number;
        while ((chunkHandle = module._jxl_wasm_enc_take_chunk!(this.wasmEncState)) !== 0) {
          const tTakeStart = performance.now();
          const chunk = takeBuffer(module, chunkHandle, "encode");
          takeChunkMs += performance.now() - tTakeStart;
          compressedBytes += chunk.data.byteLength;
          yield chunk.data;
        }
        this.onMetric?.("enc_take_chunk_ms", takeChunkMs);
        this.onMetric?.("enc_drain_ms", performance.now() - tDrainStart);
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
        const { progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, alreadyDownsampled, upsamplingMode, ecResampling, frameIndexing, allowExpertOptions, disablePerceptualHeuristics, jpegKeepExif, jpegKeepXmp, jpegKeepJumbf } = resolveEncoderBridgeSettings(this.options);

        // Gain map encode path: embeds pre-encoded JXL codestream as jhgm box.
        const wantGainMap = this.options.gainMap != null && caps.gainMapEncode &&
          typeof module._jxl_wasm_encode_with_gain_map === "function";
        if (wantGainMap) {
          const fmt = this.options.format === "rgba16" ? 1 : this.options.format === "rgbaf32" ? 2 : 0;
          const { iccProfile: effIcc4, exif: effExif4, xmp: effXmp4 } = resolveEffectiveMetadata(this.options);
          const iccView4 = effIcc4 ? copyOrBorrowInput(effIcc4, false) : new Uint8Array(0);
          const exifView4 = effExif4 ? copyOrBorrowInput(effExif4, false) : new Uint8Array(0);
          const xmpView4 = effXmp4 ? copyOrBorrowInput(effXmp4, false) : new Uint8Array(0);
          const gmRaw = this.options.gainMap!.data;
          const gmView = gmRaw instanceof ArrayBuffer ? new Uint8Array(gmRaw) : gmRaw;

          const iccPtr4 = iccView4.byteLength > 0 ? module._malloc(iccView4.byteLength) : 0;
          const exifPtr4 = exifView4.byteLength > 0 ? module._malloc(exifView4.byteLength) : 0;
          const xmpPtr4 = xmpView4.byteLength > 0 ? module._malloc(xmpView4.byteLength) : 0;
          const gmPtr = gmView.byteLength > 0 ? module._malloc(gmView.byteLength) : 0;
          try {
            if (iccPtr4 !== 0) module.HEAPU8.set(iccView4, iccPtr4);
            if (exifPtr4 !== 0) module.HEAPU8.set(exifView4, exifPtr4);
            if (xmpPtr4 !== 0) module.HEAPU8.set(xmpView4, xmpPtr4);
            if (gmPtr !== 0) module.HEAPU8.set(gmView, gmPtr);
            const handle = module._jxl_wasm_encode_with_gain_map!(
              ptr, this.options.width, this.options.height,
              distance, this.options.effort, fmt, hasAlpha,
              progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder,
              modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling,
              iccPtr4, iccView4.byteLength,
              exifPtr4, exifView4.byteLength,
              xmpPtr4, xmpView4.byteLength,
              gmPtr, gmView.byteLength,
            );
            const encoded = takeBuffer(module, handle, "encode (gain map)");
            compressedBytes += encoded.data.byteLength;
            yield encoded.data;
          } finally {
            if (iccPtr4 !== 0) module._free(iccPtr4);
            if (exifPtr4 !== 0) module._free(exifPtr4);
            if (xmpPtr4 !== 0) module._free(xmpPtr4);
            if (gmPtr !== 0) module._free(gmPtr);
          }
        } else

        // Extra-channel encode path: per-channel alpha/extra distance or separate plane buffers.
        if (caps.extraChannelEncode && (
          this.options.alphaDistance != null ||
          (this.options.extraChannels != null && this.options.extraChannels.length > 0)
        )) {
          const fmt = this.options.format === "rgba16" ? 1 : this.options.format === "rgbaf32" ? 2 : 0;
          const alphaDistance = this.options.alphaDistance ?? -1;
          const extraChannels = this.options.extraChannels ?? [];
          const extraChannelPlanes = this.options.extraChannelPlanes ?? [];

          const { iccProfile: effIcc2, exif: effExif2, xmp: effXmp2 } = resolveEffectiveMetadata(this.options);
          const iccView = effIcc2 ? copyOrBorrowInput(effIcc2, false) : new Uint8Array(0);
          const exifView = effExif2 ? copyOrBorrowInput(effExif2, false) : new Uint8Array(0);
          const xmpView = effXmp2 ? copyOrBorrowInput(effXmp2, false) : new Uint8Array(0);

          const iccPtr = iccView.byteLength > 0 ? module._malloc(iccView.byteLength) : 0;
          const exifPtr = exifView.byteLength > 0 ? module._malloc(exifView.byteLength) : 0;
          const xmpPtr = xmpView.byteLength > 0 ? module._malloc(xmpView.byteLength) : 0;
          if (iccPtr !== 0) module.HEAPU8.set(iccView, iccPtr);
          if (exifPtr !== 0) module.HEAPU8.set(exifView, exifPtr);
          if (xmpPtr !== 0) module.HEAPU8.set(xmpView, xmpPtr);

          // Build packed WasmExtraChannel[n] descriptor array (20 bytes per entry).
          // Layout: type(u32) | bits(u32) | distance(f32) | plane_ptr(u32) | plane_size(u32)
          const EC_BYTES = 20;
          const ecDescBuf = extraChannels.length > 0 ? new Uint8Array(extraChannels.length * EC_BYTES) : null;
          const allocatedPlanePtrs: number[] = [];
          let ecDescPtr = 0;
          const useBoxV2 = needsBoxOptsV2(this.options) && caps.metadataBoxesV2 &&
            typeof module._jxl_wasm_encode_rgba8_with_metadata_ec_v2 === "function";
          const { ptr: boxOptsPtr, freePtrs: boxOptsPtrs } = useBoxV2
            ? marshalBoxOpts(module, this.options)
            : { ptr: 0, freePtrs: [] };
          try {
            if (ecDescBuf !== null) {
              const dv = new DataView(ecDescBuf.buffer);
              for (let i = 0; i < extraChannels.length; i++) {
                const ec = extraChannels[i]!;
                const plane = extraChannelPlanes[i];
                const base = i * EC_BYTES;

                let planePtrWasm = 0;
                let planeSizeWasm = 0;
                if (plane != null && (plane instanceof ArrayBuffer ? plane.byteLength : plane.byteLength) > 0) {
                  const planeView = plane instanceof ArrayBuffer ? new Uint8Array(plane) : plane;
                  planePtrWasm = module._malloc(planeView.byteLength);
                  if (planePtrWasm !== 0) {
                    allocatedPlanePtrs.push(planePtrWasm);
                    module.HEAPU8.set(planeView, planePtrWasm);
                    planeSizeWasm = planeView.byteLength;
                  }
                }

                dv.setUint32(base,      encodeExtraChannelType(ec.type), true);
                dv.setUint32(base + 4,  ec.bitsPerSample, true);
                dv.setFloat32(base + 8, ec.distance ?? -1, true);
                dv.setUint32(base + 12, planePtrWasm, true);
                dv.setUint32(base + 16, planeSizeWasm, true);
              }
              ecDescPtr = module._malloc(ecDescBuf.byteLength);
              if (ecDescPtr !== 0) module.HEAPU8.set(ecDescBuf, ecDescPtr);
            }

            const handle = useBoxV2
              ? module._jxl_wasm_encode_rgba8_with_metadata_ec_v2!(
                  ptr, this.options.width, this.options.height,
                  distance, this.options.effort, fmt, hasAlpha,
                  progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder,
                  modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling,
                  iccPtr, iccView.byteLength,
                  exifPtr, exifView.byteLength,
                  xmpPtr, xmpView.byteLength,
                  alphaDistance,
                  ecDescPtr, extraChannels.length,
                  boxOptsPtr,
                )
              : module._jxl_wasm_encode_rgba8_with_metadata_ec!(
                  ptr, this.options.width, this.options.height,
                  distance, this.options.effort, fmt, hasAlpha,
                  progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder,
                  modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling,
                  iccPtr, iccView.byteLength,
                  exifPtr, exifView.byteLength,
                  xmpPtr, xmpView.byteLength,
                  alphaDistance,
                  ecDescPtr, extraChannels.length,
                );
            const encoded = takeBuffer(module, handle, "encode (extra channels)");
            compressedBytes += encoded.data.byteLength;
            yield encoded.data;
          } finally {
            if (ecDescPtr !== 0) module._free(ecDescPtr);
            for (const p of allocatedPlanePtrs) module._free(p);
            if (iccPtr !== 0) module._free(iccPtr);
            if (exifPtr !== 0) module._free(exifPtr);
            if (xmpPtr !== 0) module._free(xmpPtr);
            boxOptsPtrs.forEach(p => module._free(p));
            if (boxOptsPtr !== 0) module._free(boxOptsPtr);
          }
        } else

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
            let handle = caps.extOptions && module._jxl_wasm_encode_rgba8_with_sidecars_x
              ? module._jxl_wasm_encode_rgba8_with_sidecars_x(
                  ptr, this.options.width, this.options.height,
                  distance, this.options.effort, hasAlpha,
                  dimsPtr, sortedSizes.length,
                  modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling,
                )
              : module._jxl_wasm_encode_rgba8_with_sidecars!(
                  ptr, this.options.width, this.options.height,
                  distance, this.options.effort, hasAlpha,
                  dimsPtr, sortedSizes.length, resampling,
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
          const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : this.options.format === "rgb8" ? 3 : 0;
            const encState = module._jxl_wasm_enc_create!();
            try {
            const rc = caps.extOptions && module._jxl_wasm_enc_push_pixels_x
              ? module._jxl_wasm_enc_push_pixels_x(encState, ptr, this.options.width, this.options.height, distance, this.options.effort, fmtIndex, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, centerX ?? -1, centerY ?? -1)
              : module._jxl_wasm_enc_push_pixels!(encState, ptr, this.options.width, this.options.height, distance, this.options.effort, fmtIndex, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling, centerX ?? -1, centerY ?? -1);
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

          // Use metadata path if any metadata is present or box opts are needed.
          // fmt: 0=rgba8, 1=rgba16, 2=rgbaf32, 3=rgb8 — matches bridge parameter order.
          const fmt = this.options.format === "rgba16" ? 1 : this.options.format === "rgbaf32" ? 2 : this.options.format === "rgb8" ? 3 : 0;
          const { iccProfile: effIcc3, exif: effExif3, xmp: effXmp3 } = resolveEffectiveMetadata(this.options);
          const hasMetadata = effIcc3 !== null || effExif3 !== null || effXmp3 !== null || needsBoxOptsV2(this.options);
          if (hasMetadata && module._jxl_wasm_encode_rgba8_with_metadata) {
            const iccView = effIcc3 ? copyOrBorrowInput(effIcc3, false) : new Uint8Array(0);
            const exifView = effExif3 ? copyOrBorrowInput(effExif3, false) : new Uint8Array(0);
            const xmpView = effXmp3 ? copyOrBorrowInput(effXmp3, false) : new Uint8Array(0);

            const iccPtr = iccView.byteLength > 0 ? module._malloc(iccView.byteLength) : 0;
            const exifPtr = exifView.byteLength > 0 ? module._malloc(exifView.byteLength) : 0;
            const xmpPtr = xmpView.byteLength > 0 ? module._malloc(xmpView.byteLength) : 0;

            const orientationStd = this.options.orientation ?? 1;
            const useV3Std = orientationStd !== 1 &&
              typeof module._jxl_wasm_encode_rgba8_with_metadata_v3 === "function";
            const useBoxV2Std = !useV3Std && needsBoxOptsV2(this.options) && caps.metadataBoxesV2 &&
              typeof module._jxl_wasm_encode_rgba8_with_metadata_v2 === "function";
            const { ptr: boxOptsPtr2, freePtrs: boxOptsPtrs2 } = (useV3Std || useBoxV2Std)
              ? marshalBoxOpts(module, this.options)
              : { ptr: 0, freePtrs: [] };

            try {
              if (iccPtr !== 0) module.HEAPU8.set(iccView, iccPtr);
              if (exifPtr !== 0) module.HEAPU8.set(exifView, exifPtr);
              if (xmpPtr !== 0) module.HEAPU8.set(xmpView, xmpPtr);

              if (useV3Std) {
                handle = module._jxl_wasm_encode_rgba8_with_metadata_v3!(
                  ptr, this.options.width, this.options.height,
                  distance, this.options.effort, fmt, hasAlpha,
                  progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder,
                  modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling,
                  iccPtr, iccView.byteLength,
                  exifPtr, exifView.byteLength,
                  xmpPtr, xmpView.byteLength,
                  boxOptsPtr2,
                  orientationStd,
                );
              } else if (useBoxV2Std) {
                handle = module._jxl_wasm_encode_rgba8_with_metadata_v2!(
                  ptr, this.options.width, this.options.height,
                  distance, this.options.effort, fmt, hasAlpha,
                  progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder,
                  modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling,
                  iccPtr, iccView.byteLength,
                  exifPtr, exifView.byteLength,
                  xmpPtr, xmpView.byteLength,
                  boxOptsPtr2,
                );
              } else {
                handle = caps.extOptions && module._jxl_wasm_encode_rgba8_with_metadata_x
                  ? module._jxl_wasm_encode_rgba8_with_metadata_x(
                      ptr, this.options.width, this.options.height,
                      distance, this.options.effort, fmt, hasAlpha,
                      progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder,
                      modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling,
                      iccPtr, iccView.byteLength,
                      exifPtr, exifView.byteLength,
                      xmpPtr, xmpView.byteLength,
                    )
                  : module._jxl_wasm_encode_rgba8_with_metadata(
                      ptr, this.options.width, this.options.height,
                      distance, this.options.effort, fmt, hasAlpha,
                      progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling,
                      iccPtr, iccView.byteLength,
                      exifPtr, exifView.byteLength,
                      xmpPtr, xmpView.byteLength
                    );
              }
            } finally {
              if (iccPtr !== 0) module._free(iccPtr);
              if (exifPtr !== 0) module._free(exifPtr);
              if (xmpPtr !== 0) module._free(xmpPtr);
              boxOptsPtrs2.forEach(p => module._free(p));
              if (boxOptsPtr2 !== 0) module._free(boxOptsPtr2);
            }
          } else {
            // Fallback: plain encode (no metadata) used when bridge fn absent
            // or when no metadata was provided.
            if (this.options.format === "rgba16") {
              handle = caps.extOptions && module._jxl_wasm_encode_rgba16_x
                ? module._jxl_wasm_encode_rgba16_x(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling)
                : module._jxl_wasm_encode_rgba16
                  ? module._jxl_wasm_encode_rgba16(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling)
                  : module._jxl_wasm_encode_rgba8(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling);
            } else if (this.options.format === "rgbaf32") {
              handle = caps.extOptions && module._jxl_wasm_encode_rgbaf32_x
                ? module._jxl_wasm_encode_rgbaf32_x(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling)
                : module._jxl_wasm_encode_rgbaf32
                  ? module._jxl_wasm_encode_rgbaf32(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling)
                  : module._jxl_wasm_encode_rgba8(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling);
            } else {
              handle = caps.extOptions && module._jxl_wasm_encode_rgba8_x
                ? module._jxl_wasm_encode_rgba8_x(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling)
                : module._jxl_wasm_encode_rgba8(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling);
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
  const awaitedPromise = modulePromise;
  const mod = await awaitedPromise;
  // Only write to cachedModule if the promise has not been invalidated by a
  // concurrent setForcedTier() / setJxlModuleFactoryForTesting() call.
  if (modulePromise === awaitedPromise) cachedModule = mod;
  return mod;
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
  if (isBunRuntime() && tier.endsWith("-mt")) {
    options.mainScriptUrlOrBlob = makeBunPthreadBootstrap(new URL(`jxl-core.${tier}.js`, baseUrl).href);
  }
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
  const load = () => (factory as (options: Record<string, unknown>) => Promise<LibjxlWasmModule>)(options);
  return isBunRuntime() && tier.endsWith("-mt") ? await withBunPthreadWorkerUnref(load) : await load();
}

function isBunRuntime(): boolean {
  return typeof globalThis !== "undefined" && "Bun" in globalThis;
}

function makeBunPthreadBootstrap(moduleUrl: string): Blob {
  return new Blob([
    [
      'globalThis.WorkerGlobalScope ??= function WorkerGlobalScope() {};',
      'try {',
      '  Object.defineProperty(globalThis.self, "name", { value: "em-pthread", configurable: true });',
      '} catch {',
      '  globalThis.self.name = "em-pthread";',
      '}',
      `await import(${JSON.stringify(moduleUrl)});`,
    ].join("\n"),
  ], { type: "text/javascript" });
}

async function withBunPthreadWorkerUnref<T>(load: () => Promise<T>): Promise<T> {
  const global = globalThis as any;
  const OriginalWorker = global.Worker;
  if (typeof OriginalWorker !== "function") return await load();

  global.Worker = class BunUnrefPthreadWorker extends OriginalWorker {
    constructor(...args: any[]) {
      super(...args);
      const options = args[1] as { name?: string } | undefined;
      const worker = this as unknown as { unref?: () => void };
      if (options?.name === "em-pthread" && typeof worker.unref === "function") {
        worker.unref();
      }
    }
  };

  try {
    return await load();
  } finally {
    global.Worker = OriginalWorker;
  }
}

interface JxlCapabilities {
  progressiveDecode: boolean;
  streamingEncode: boolean;
  streamingInput: boolean;
  sidecars: boolean;
  jpegTranscode: boolean;
  extOptions: boolean;
  extraChannelEncode: boolean;
  metadataBoxesV2: boolean;
  /** WASM exports the _z / _v3 bridges that record EXIF orientation in JXL basic info. */
  orientation: boolean;
  gainMapEncode: boolean;
  animationEncode: boolean;

  /**
   * Internal: presence of the native C seek function.
   * Exposed publicly as WrapperCapabilities.animationSeek.
   */
  animationSeek: boolean;
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
    extOptions: typeof module._jxl_wasm_encode_rgba8_x === "function",
    extraChannelEncode: typeof module._jxl_wasm_encode_rgba8_with_metadata_ec === "function",
    metadataBoxesV2: typeof module._jxl_wasm_encode_rgba8_with_metadata_v2 === "function",
    orientation:
      typeof module._jxl_wasm_enc_create_image_z === "function" ||
      typeof module._jxl_wasm_encode_rgba8_with_metadata_v3 === "function",
    gainMapEncode: typeof module._jxl_wasm_encode_with_gain_map === "function",
    animationEncode: typeof module._jxl_wasm_encode_animation === "function",
    animationSeek: typeof module._jxl_wasm_dec_seek_to_frame === "function",
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
  const channels = format === "rgb8" ? 3 : 4;
  const bytes = width * height * channels * bpc;
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
// Uint8Array with copy=false is the zero-copy fast path used by the worker when it has exclusive ownership
// of the transferred buffer.
function copyOrBorrowInput(value: ArrayBuffer | Uint8Array, copy: boolean): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (!copy) return value;
  // Only pay for the copy when the caller explicitly asked for safety or is reusing the buffer.
  return value.slice();
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
      const dstStart = y * outWidth * stride;
      if (stride === 4) {
        // Direct byte copy for common rgba8 crop (no subarray object).
        for (let i = 0; i < outWidth * 4; i++) {
          out[dstStart + i] = data[srcStart + i]!;
        }
      } else {
        out.set(data.subarray(srcStart, srcStart + outWidth * stride), dstStart);
      }
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
      if (stride === 8) {
        // Zero-alloc direct copy for common rgba16 downsample case.
        for (let x = 0; x < outWidth; x++) {
          const s = srcRowBase + (sourceRegion.x + Math.min(sourceRegion.w - 1, x * downsample)) * 8;
          const d = dstRowBase + x * 8;
          out[d] = data[s]!; out[d+1] = data[s+1]!; out[d+2] = data[s+2]!; out[d+3] = data[s+3]!;
          out[d+4] = data[s+4]!; out[d+5] = data[s+5]!; out[d+6] = data[s+6]!; out[d+7] = data[s+7]!;
        }
      } else {
        for (let x = 0; x < outWidth; x++) {
          const src = srcRowBase + (sourceRegion.x + Math.min(sourceRegion.w - 1, x * downsample)) * stride;
          const dst = dstRowBase + x * stride;
          if (stride === 16) {
            // Direct for f32 downsample (rare but matches style).
            out[dst]      = data[src]!;     out[dst+1]  = data[src+1]!;
            out[dst+4]    = data[src+4]!;   out[dst+5]  = data[src+5]!;
            out[dst+8]    = data[src+8]!;   out[dst+9]  = data[src+9]!;
            out[dst+12]   = data[src+12]!;  out[dst+13] = data[src+13]!;
          } else {
            out.set(data.subarray(src, src + stride), dst);
          }
        }
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

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Allocate WASM heap, copy the view, track the pointer for later free. Returns the ptr (0 on failure). */
function mallocAndCopy(module: LibjxlWasmModule, view: Uint8Array, freePtrs: number[]): number {
  if (view.byteLength === 0) return 0;
  const ptr = module._malloc(view.byteLength);
  if (ptr !== 0) {
    module.HEAPU8.set(view, ptr);
    freePtrs.push(ptr);
  }
  return ptr;
}

function buildResizeAxis(srcSize: number, dstSize: number): { i0: Int32Array; i1: Int32Array; t: Float32Array } {
  const i0 = new Int32Array(dstSize);
  const i1 = new Int32Array(dstSize);
  const t = new Float32Array(dstSize);
  const scale = srcSize / dstSize;
  for (let d = 0; d < dstSize; d++) {
    const f = (d + 0.5) * scale - 0.5;
    const base = Math.max(0, Math.floor(f));
    i0[d] = base;
    i1[d] = Math.min(srcSize - 1, base + 1);
    t[d] = f - base;
  }
  return { i0, i1, t };
}

function bilinearResize(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  stride: number, // 4=rgba8, 8=rgba16, 16=rgbaf32
): Uint8Array {
  if (srcW === dstW && srcH === dstH) return src;

  // Similar big-brain fast path as the Rust downscalers:
  // When the scale is exact integer (very common for target sizes), skip the
  // expensive axis table allocation + f32 lerp and use direct stepping.
  if (srcW % dstW === 0 && srcH % dstH === 0) {
    const xstep = srcW / dstW;
    const ystep = srcH / dstH;
    const dst = new Uint8Array(dstW * dstH * stride);
    for (let dy = 0; dy < dstH; dy++) {
      const sy = dy * ystep;
      const srcRow = sy * srcW * stride;
      const dstRow = dy * dstW * stride;
      if (stride === 4) {
        // Zero-alloc fast path for the dominant rgba8 case.
        for (let dx = 0; dx < dstW; dx++) {
          const s = srcRow + dx * xstep * 4;
          const d = dstRow + dx * 4;
          dst[d] = src[s]!; dst[d + 1] = src[s + 1]!; dst[d + 2] = src[s + 2]!; dst[d + 3] = src[s + 3]!;
        }
      } else if (stride === 8) {
        // Zero-alloc for rgba16 exact-integer resize (lightbox 16-bit flows).
        for (let dx = 0; dx < dstW; dx++) {
          const s = srcRow + dx * xstep * 8;
          const d = dstRow + dx * 8;
          dst[d] = src[s]!; dst[d+1] = src[s+1]!; dst[d+2] = src[s+2]!; dst[d+3] = src[s+3]!;
          dst[d+4] = src[s+4]!; dst[d+5] = src[s+5]!; dst[d+6] = src[s+6]!; dst[d+7] = src[s+7]!;
        }
      } else {
        for (let dx = 0; dx < dstW; dx++) {
          const sx = dx * xstep;
          const s = srcRow + sx * stride;
          const d = dstRow + dx * stride;
          if (stride === 16) {
            // Direct for f32 (rgbaf32) exact resize – rare but consistent style.
            dst[d]      = src[s]!;     dst[d+1]  = src[s+1]!;
            dst[d+4]    = src[s+4]!;   dst[d+5]  = src[s+5]!;
            dst[d+8]    = src[s+8]!;   dst[d+9]  = src[s+9]!;
            dst[d+12]   = src[s+12]!;  dst[d+13] = src[s+13]!;
          } else {
            dst.set(src.subarray(s, s + stride), d);
          }
        }
      }
    }
    return dst;
  }
  const dst = new Uint8Array(dstW * dstH * stride);
  const xAxis = buildResizeAxis(srcW, dstW);
  const yAxis = buildResizeAxis(srcH, dstH);
  if (stride === 4) {
    for (let dy = 0; dy < dstH; dy++) {
      const y0 = yAxis.i0[dy]!;
      const y1 = yAxis.i1[dy]!;
      const yt = yAxis.t[dy]!;
      const row00 = y0 * srcW * 4;
      const row10 = y1 * srcW * 4;
      for (let dx = 0; dx < dstW; dx++) {
        const x0 = xAxis.i0[dx]!;
        const x1 = xAxis.i1[dx]!;
        const xt = xAxis.t[dx]!;
        const topLeft = row00 + x0 * 4;
        const topRight = row00 + x1 * 4;
        const bottomLeft = row10 + x0 * 4;
        const bottomRight = row10 + x1 * 4;
        const dstOff = (dy * dstW + dx) * 4;
        for (let c = 0; c < 4; c++) {
          const tl = src[topLeft + c]!;
          const tr = src[topRight + c]!;
          const bl = src[bottomLeft + c]!;
          const br = src[bottomRight + c]!;
          dst[dstOff + c] = Math.round(tl * (1 - xt) * (1 - yt) + tr * xt * (1 - yt) + bl * (1 - xt) * yt + br * xt * yt);
        }
      }
    }
  } else if (stride === 8) {
    if (IS_LITTLE_ENDIAN) {
      const srcView = new Uint16Array(src.buffer, src.byteOffset, src.byteLength >> 1);
      const dstView = new Uint16Array(dst.buffer);
      for (let dy = 0; dy < dstH; dy++) {
        const y0 = yAxis.i0[dy]!;
        const y1 = yAxis.i1[dy]!;
        const yt = yAxis.t[dy]!;
        const row00 = y0 * srcW * 4;
        const row10 = y1 * srcW * 4;
        for (let dx = 0; dx < dstW; dx++) {
          const x0 = xAxis.i0[dx]!;
          const x1 = xAxis.i1[dx]!;
          const xt = xAxis.t[dx]!;
          const topLeft = row00 + x0 * 4;
          const topRight = row00 + x1 * 4;
          const bottomLeft = row10 + x0 * 4;
          const bottomRight = row10 + x1 * 4;
          const dstOff = (dy * dstW + dx) * 4;
          for (let c = 0; c < 4; c++) {
            const tl = srcView[topLeft + c]!;
            const tr = srcView[topRight + c]!;
            const bl = srcView[bottomLeft + c]!;
            const br = srcView[bottomRight + c]!;
            dstView[dstOff + c] = Math.max(0, Math.min(65535, Math.round(tl * (1 - xt) * (1 - yt) + tr * xt * (1 - yt) + bl * (1 - xt) * yt + br * xt * yt)));
          }
        }
      }
    } else {
      const srcView = new DataView(src.buffer, src.byteOffset, src.byteLength);
      const dstView = new DataView(dst.buffer);
      for (let dy = 0; dy < dstH; dy++) {
        const y0 = yAxis.i0[dy]!;
        const y1 = yAxis.i1[dy]!;
        const yt = yAxis.t[dy]!;
        for (let dx = 0; dx < dstW; dx++) {
          const x0 = xAxis.i0[dx]!;
          const x1 = xAxis.i1[dx]!;
          const xt = xAxis.t[dx]!;
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
    }
  } else {
    if (IS_LITTLE_ENDIAN) {
      const srcView = new Float32Array(src.buffer, src.byteOffset, src.byteLength >> 2);
      const dstView = new Float32Array(dst.buffer);
      for (let dy = 0; dy < dstH; dy++) {
        const y0 = yAxis.i0[dy]!;
        const y1 = yAxis.i1[dy]!;
        const yt = yAxis.t[dy]!;
        const row00 = y0 * srcW * 4;
        const row10 = y1 * srcW * 4;
        for (let dx = 0; dx < dstW; dx++) {
          const x0 = xAxis.i0[dx]!;
          const x1 = xAxis.i1[dx]!;
          const xt = xAxis.t[dx]!;
          const topLeft = row00 + x0 * 4;
          const topRight = row00 + x1 * 4;
          const bottomLeft = row10 + x0 * 4;
          const bottomRight = row10 + x1 * 4;
          const dstOff = (dy * dstW + dx) * 4;
          for (let c = 0; c < 4; c++) {
            const tl = srcView[topLeft + c]!;
            const tr = srcView[topRight + c]!;
            const bl = srcView[bottomLeft + c]!;
            const br = srcView[bottomRight + c]!;
            dstView[dstOff + c] = tl * (1 - xt) * (1 - yt) + tr * xt * (1 - yt) + bl * (1 - xt) * yt + br * xt * yt;
          }
        }
      }
    } else {
      const srcView = new DataView(src.buffer, src.byteOffset, src.byteLength);
      const dstView = new DataView(dst.buffer);
      for (let dy = 0; dy < dstH; dy++) {
        const y0 = yAxis.i0[dy]!;
        const y1 = yAxis.i1[dy]!;
        const yt = yAxis.t[dy]!;
        for (let dx = 0; dx < dstW; dx++) {
          const x0 = xAxis.i0[dx]!;
          const x1 = xAxis.i1[dx]!;
          const xt = xAxis.t[dx]!;
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
  if (srcW === targetW && srcH === targetH) {
    return { data: src, width: srcW, height: srcH };
  }
  const stride = 4 * bpc;
  if (fitMode === "stretch") {
    return { data: bilinearResize(src, srcW, srcH, targetW, targetH, stride), width: targetW, height: targetH };
  }
  if (fitMode === "contain") {
    const scale = Math.min(targetW / srcW, targetH / srcH);
    const dstW = Math.max(1, Math.round(srcW * scale));
    const dstH = Math.max(1, Math.round(srcH * scale));
    if (dstW === srcW && dstH === srcH) return { data: src, width: srcW, height: srcH };
    return { data: bilinearResize(src, srcW, srcH, dstW, dstH, stride), width: dstW, height: dstH };
  }
  // cover: scale up so both dims >= target, then center-crop
  const scale = Math.max(targetW / srcW, targetH / srcH);
  const scaledW = Math.max(targetW, Math.round(srcW * scale));
  const scaledH = Math.max(targetH, Math.round(srcH * scale));
  const scaled = (scaledW === srcW && scaledH === srcH) ? src : bilinearResize(src, srcW, srcH, scaledW, scaledH, stride);
  const cropX = Math.floor((scaledW - targetW) / 2);
  const cropY = Math.floor((scaledH - targetH) / 2);
  const cropped = applyRegionAndDownsample(scaled, scaledW, scaledH, { x: cropX, y: cropY, w: targetW, h: targetH }, 1, bpc);
  return { data: cropped.data, width: targetW, height: targetH };
}

function pickDownsample(options: { region?: Region | null; imageWidth?: number | null; imageHeight?: number | null; targetWidth?: number | null; targetHeight?: number | null }): 1 | 2 | 4 | 8 {
  const region = options.region ?? null;
  const targetWidth = options.targetWidth ?? null;
  const targetHeight = options.targetHeight ?? null;
  if (targetWidth == null || targetHeight == null || targetWidth <= 0 || targetHeight <= 0) {
    return 1;
  }
  const sourceW = region !== null ? region.w : (options.imageWidth ?? null);
  const sourceH = region !== null ? region.h : (options.imageHeight ?? null);
  if (sourceW == null || sourceH == null) return 1;
  const sourceLongEdge = Math.max(sourceW, sourceH);
  const targetLongEdge = Math.max(targetWidth, targetHeight);
  for (const factor of [8, 4, 2] as const) {
    if (Math.ceil(sourceLongEdge / factor) >= targetLongEdge) return factor;
  }
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
