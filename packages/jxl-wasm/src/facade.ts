export type PixelFormat = "rgba8" | "rgba16" | "rgbaf32";
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

  /**
   * Upsampling mode for the encoder (pixel-art-downsampling design note).
   * 0 = nearest neighbor (non-negotiable for crisp pixel art and retro/UI content).
   * Other values follow libjxl kernel semantics (see cjxl --upsampling_mode).
   * Recommended with resampling > 1 for intentional pixel art workflows.
   * Using 0 with photographic content is usually a mistake — the lab emits a warning badge.
   */
  upsamplingMode?: number;

  /**
   * The input image has already been downsampled by the resampling factor.
   * Tells the encoder to skip its own downsampling step.
   */
  alreadyDownsampled?: boolean;

  /**
   * JPEG reconstruction controls (when the source was JPEG) — jpeg-recompression-polish design note.
   * Only has effect on JPEG-derived encode paths (transcodeJpegToJxl family or when sidecar JPEG data is supplied).
   * CFL (ID 30) can also ride advanced pairs for broad reach on other paths.
   */
  jpegReconstruction?: {
    /** Enable chroma-from-luma during JPEG reconstruction (ID 30). */
    cfl?: boolean;
    /** Compress the reconstruction metadata boxes with Brotli. */
    compressBoxes?: boolean;
    /** Request reconstruction warnings / hints from the encoder. */
    emitWarnings?: boolean;
    /** Force calling JxlEncoderStoreJPEGMetadata as a distinct step (instead of implicit). */
    storeJPEGMetadata?: boolean;
  };

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
  /** When present, encode as a multi-frame animation. ticksPerSecond and loopCount control the animation header. */
  animation?: AnimationOptions;
  /**
   * Frame data for animation encode. When set, replaces the single-image pushPixels path.
   * Requires rebuilt WASM with animation bridge (_jxl_wasm_encode_animation).
   */
  frames?: readonly AnimationFrame[];
  /** Fine-grained Modular mode sub-settings (group size, predictor, palette, MA tree % etc.).
   * Requires WASM bridge rebuild with advanced support (currently native-only parity; see handoff 2026-05-29).
   * References: cjxl_main.cc ProcessFlags, jpegxl-rs set_frame_option, designs/core-modular-controls.md
   */
  modularOptions?: ModularOptions;
  /**
   * Raw escape hatch for advanced/experimental JXL_ENC_FRAME_SETTING_* values (patches=8, splines=9,
   * modular predictor via id 33, etc.). Applied after named settings. Full support requires bridge.cpp
   * extension + Emscripten rebuild. Matches @casabio/jxl-native for API parity with references.
   *
   * For the promoted first-class controls (GROUP_ORDER, filters, buffering, etc.), prefer
   * `advancedControls` (see designs/first-class-advanced-encoder-controls.md). Raw entries here
   * are still supported and applied last (they win on conflicts).
   */
  advancedFrameSettings?: readonly AdvancedFrameSetting[];

  /**
   * First-class advanced encoder controls (post-audit promotion).
   * Use this for DOTS/PATCHES/EPF/GABORISH (filters), GROUP_ORDER + centers, BUFFERING modes,
   * DISABLE_PERCEPTUAL_HEURISTICS, etc. as they are promoted slice by slice.
   * Raw `advancedFrameSettings` remains the stable power-user escape hatch.
   */
  advancedControls?: AdvancedEncoderControls;
}

/** Options for attaching an HDR gain map (ISO 21496-1 / JXL jhgm box). */
export interface GainMapOptions {
  /** Pre-encoded JXL codestream for the gain map image. */
  data: Uint8Array | ArrayBuffer;
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

/** Sub-settings for Modular encoding mode (matches @casabio/jxl-native exactly for cross-path parity).
 * These provide fine-grained control over libjxl Modular mode behavior, as exposed in production
 * by cjxl_main.cc (--modular_*) and the jpegxl-rs escape hatch. See REFERENCE_INDEX.md #3 and
 * designs/core-modular-controls.md. Full wiring to bridge.cpp pending (see native.cc:1188 for model).
 */
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

/** Raw JXL_ENC_FRAME_SETTING_* escape hatch (id + value pairs).
 * Enables patches (e.g. 8), splines (9), and any future/undocumented modular or coding tool settings.
 * Applied after all named options; later entries override. Matches native API.
 * See cjxl_main.cc and libjxl encode.h for the numeric ids.
 */
export type AdvancedFrameSetting = { id: number; value: number };

/**
 * First-class advanced encoder controls (Phase 1+ of the post-audit work).
 * These are the high-ROI settings promoted from the raw escape hatch based on
 * cjxl_main.cc usage + the June 2026 REFERENCE_CODE_AUDIT Master Gap List.
 *
 * Preferred over raw `advancedFrameSettings` for the documented controls.
 * Raw advancedFrameSettings entries are still applied last (can override).
 *
 * See designs/first-class-advanced-encoder-controls.md for the full rationale,
 * ID mappings, validation rules, and phasing.
 */
export interface AdvancedEncoderControls {
  /**
   * Advanced coding tools and filters (content-dependent compression wins).
   * DOTS (id 7), PATCHES (id 8), EPF (id 9, -1..3), GABORISH (id 10).
   * These were previously only reachable via the raw escape hatch.
   */
  filters?: FiltersControls;

  /**
   * Group storage order (high value for progressive, ROI, and tiling workflows).
   * From cjxl --group_order and --center_x / --center_y with mutual-exclusion validation.
   * IDs: 13 (GROUP_ORDER), 14 (CENTER_X), 15 (CENTER_Y).
   */
  groupOrder?: GroupOrderControls;

  /**
   * Buffering strategy (rich documented tradeoffs in cjxl for memory vs density vs streaming).
   * ID 34. Currently the internal `chunked` flag only exercises a subset.
   * This is the first-class surface for what was previously opaque.
   */
  buffering?: BufferingControls;
}

/** Buffering / streaming strategy controls. */
export interface BufferingControls {
  /** -1 = libjxl default, 0 = emit immediately, 1-3 = increasing buffering. */
  strategy?: -1 | 0 | 1 | 2 | 3;
  /** Hint for streaming input path (often used with buffering=3). */
  streamingInput?: boolean;
  /** Hint for streaming output path. */
  streamingOutput?: boolean;

  /**
   * Low-memory mode hint (production-chunked-paths design note).
   * Signals desire for minimal peak RAM on very large images (maps to high buffering + streaming paths where available).
   */
  lowMemoryMode?: boolean;

  /**
   * On Tauri/native builds, prefer the full modern chunked path (JxlEncoderAddChunkedFrame + custom JxlChunkedFrameInputSource)
   * over the buffered AddImageFrame path. Matches libvips production recommendation for large images.
   * Browser path remains strong via existing streaming entrypoints (no behavioral change).
   */
  preferChunkedAPI?: boolean;
}

/** Group order controls (promoted in current slice). */
export interface GroupOrderControls {
  /** 'scanline' (default) or 'center' (better for progressive / viewport decodes). */
  mode: 'scanline' | 'center';
  /** Center coordinates when mode === 'center'. cjxl requires these when using center mode. */
  centerX?: number;
  centerY?: number;
}

/** Filters / advanced coding tools promoted in the first slice. */
export interface FiltersControls {
  /** Enable synthetic dot generation (halftone-like content). ID 7. */
  dots?: boolean;
  /** Enable dictionary-based patches (repeated content modeling). ID 8. */
  patches?: boolean;
  /**
   * Edge-preserving filter strength.
   * -1 = libjxl default/auto, 0 = disabled, 1–3 = increasing strength.
   * One of the most valuable production controls per the audit. ID 9.
   */
  epf?: -1 | 0 | 1 | 2 | 3;
  /** Enable Gaborish filter. ID 10. */
  gaborish?: boolean;
}

/**
 * Lightweight client-side validation for first-class advanced controls.
 * Mirrors the spirit of cjxl pre-validation (range checks + mutual exclusion warnings)
 * without trying to replicate the full libjxl validator.
 *
 * Returns an array of warning messages (empty array = no issues found).
 * These are intended for console.warn / UI feedback, not hard errors.
 */
export function validateAdvancedControls(controls?: AdvancedEncoderControls): string[] {
  const warnings: string[] = [];
  if (!controls) return warnings;

  // Filters validation
  const f = controls.filters;
  if (f?.epf !== undefined) {
    if (f.epf < -1 || f.epf > 3) {
      warnings.push(`EPF value ${f.epf} is out of range (-1..3). Clamped or ignored by libjxl.`);
    }
  }

  // Group order validation (high value per audit + cjxl mutual exclusion)
  const g = controls.groupOrder;
  if (g) {
    if (g.mode === 'center') {
      if (g.centerX === undefined || g.centerY === undefined) {
        warnings.push('groupOrder mode="center" without centerX/centerY. cjxl requires centers for center-first ordering.');
      }
    } else {
      if (g.centerX !== undefined || g.centerY !== undefined) {
        warnings.push('groupOrder centerX/centerY provided but mode is not "center". Values will be ignored.');
      }
    }
  }

  // Buffering validation
  const b = controls.buffering;
  if (b?.strategy !== undefined) {
    if (b.strategy < -1 || b.strategy > 3) {
      warnings.push(`buffering.strategy ${b.strategy} is out of range (-1..3).`);
    }
  }
  // lowMemoryMode + preferChunkedAPI are boolean hints (production-chunked-paths note); no range validation needed.

  // Future groups (expert, etc.) can be added here as they are promoted.

  return warnings;
}

/** Descriptor for a custom metadata box to embed in the JXL container. */
export interface MetadataBoxSpec {
  /** 4-character JXL box type (e.g. "uuid", "xml "). Padded with spaces if shorter. */
  type: string;
  data: Uint8Array;
  /** Compress this box with Brotli. Default false. */
  compress?: boolean;
}

/** JUMBF box (C2PA / content provenance / archival). The payload is opaque; the wrapper emits it as a "jumb" container box. */
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
   * Seek to a specific frame index (0-based) and re-emit decode events from that frame.
   * Works today as a software fallback (decodes all frames, discards those before frameIndex).
   * After WASM rebuild: uses _jxl_wasm_dec_seek_to_frame to skip at the C++ level (faster).
   * Must be called instead of events(), not after it. Call after all data is pushed + close().
   */
  seekToFrame?(frameIndex: number): AsyncIterable<DecodeEvent>;
  /**
   * Seek to a frame by timestamp in milliseconds (relative to animation start).
   * Computes frame index from animTicksPerSecond on the first decoded event.
   * Falls back to frame 0 for non-animation files. Same constraints as seekToFrame.
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
  /** Returns any warnings from lightweight client-side validation of first-class advanced controls (e.g. EPF range, groupOrder mutual exclusion). */
  getValidationWarnings(): readonly string[];
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
  _jxl_wasm_encode_rgba8(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, resampling: number): number;
  _jxl_wasm_encode_rgba16?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, resampling: number): number;
  _jxl_wasm_encode_rgbaf32?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, resampling: number): number;
  _jxl_wasm_encode_rgba8_with_metadata?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number): number;
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
  _jxl_wasm_enc_push_pixels?(state: number, pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, resampling: number): number;
  _jxl_wasm_enc_take_chunk?(state: number): number;
  _jxl_wasm_enc_error?(state: number): number;
  _jxl_wasm_enc_free?(state: number): void;
  // #15: Lossless JPEG → JXL transcode
  _jxl_wasm_transcode_jpeg_to_jxl?(jpegPtr: number, jpegSize: number): number;
  // #16: Streaming input encoder — pre-allocate pixel buffer in WASM, push chunks, finish
  _jxl_wasm_enc_create_image?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, resampling: number): number;
  _jxl_wasm_encode_rgba8_with_sidecars_x?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, sidecarDimsPtr: number, numSidecars: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, modGroupSize: number, modPredictor: number, modNbPrev: number, modPaletteColors: number, modLossyPalette: number, modMaTreePercent: number, advPtr: number, advCount: number): number;
  _jxl_wasm_encode_rgba8_x?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, modGroupSize: number, modPredictor: number, modNbPrev: number, modPaletteColors: number, modLossyPalette: number, modMaTreePercent: number, advPtr: number, advCount: number): number;
  _jxl_wasm_encode_rgba16_x?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, modGroupSize: number, modPredictor: number, modNbPrev: number, modPaletteColors: number, modLossyPalette: number, modMaTreePercent: number, advPtr: number, advCount: number): number;
  _jxl_wasm_encode_rgbaf32_x?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, modGroupSize: number, modPredictor: number, modNbPrev: number, modPaletteColors: number, modLossyPalette: number, modMaTreePercent: number, advPtr: number, advCount: number): number;
  _jxl_wasm_encode_rgba8_with_metadata_x?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, modGroupSize: number, modPredictor: number, modNbPrev: number, modPaletteColors: number, modLossyPalette: number, modMaTreePercent: number, advPtr: number, advCount: number): number;
  // Extra-channel encode: per-channel distance + optional separate plane buffers.
  _jxl_wasm_encode_rgba8_with_metadata_ec?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, alphaDistance: number, ecPtr: number, numEc: number, modGroupSize: number, modPredictor: number, modNbPrev: number, modPaletteColors: number, modLossyPalette: number, modMaTreePercent: number, advPtr: number, advCount: number): number;
  // v2: extends _x / _ec with WasmBoxOpts (container control, box compression, custom boxes).
  _jxl_wasm_encode_rgba8_with_metadata_v2?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, boxOptsPtr: number, modGroupSize: number, modPredictor: number, modNbPrev: number, modPaletteColors: number, modLossyPalette: number, modMaTreePercent: number, advPtr: number, advCount: number): number;
  _jxl_wasm_encode_rgba8_with_metadata_ec_v2?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, alphaDistance: number, ecPtr: number, numEc: number, boxOptsPtr: number, modGroupSize: number, modPredictor: number, modNbPrev: number, modPaletteColors: number, modLossyPalette: number, modMaTreePercent: number, advPtr: number, advCount: number): number;
  _jxl_wasm_transcode_jpeg_to_jxl_v2?(jpegPtr: number, jpegSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, boxOptsPtr: number): number;
  // #15c: JPEG transcode v3 with explicit reconstruction controls (jpeg-recompression-polish)
  _jxl_wasm_transcode_jpeg_to_jxl_v3?(jpegPtr: number, jpegSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, boxOptsPtr: number, cfl: number, storeMeta: number): number;
  _jxl_wasm_enc_push_pixels_x?(state: number, pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, modGroupSize: number, modPredictor: number, modNbPrev: number, modPaletteColors: number, modLossyPalette: number, modMaTreePercent: number, advPtr: number, advCount: number): number;
  _jxl_wasm_enc_create_image_x?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, modGroupSize: number, modPredictor: number, modNbPrev: number, modPaletteColors: number, modLossyPalette: number, modMaTreePercent: number, advPtr: number, advCount: number): number;
  _jxl_wasm_enc_pixels_ptr?(state: number, size: number): number;
  _jxl_wasm_enc_advance_written?(state: number, size: number): number;
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
  _jxl_wasm_encode_with_gain_map?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, gainMapPtr: number, gainMapSize: number, modGroupSize: number, modPredictor: number, modNbPrev: number, modPaletteColors: number, modLossyPalette: number, modMaTreePercent: number, advPtr: number, advCount: number): number;
  _jxl_wasm_dec_has_gain_map?(state: number): number;
  _jxl_wasm_dec_take_gain_map?(state: number): number;
  // Animation encode — present after WASM rebuild with animation bridge
  _jxl_wasm_encode_animation?(framesPtr: number, numFrames: number, distance: number, effort: number, fmt: number, hasAlpha: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, boxOptsPtr: number, animOptsPtr: number, modGroupSize: number, modPredictor: number, modNbPrev: number, modPaletteColors: number, modLossyPalette: number, modMaTreePercent: number, advPtr: number, advCount: number): number;
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
    default:          return 15; // JXL_CHANNEL_OPTIONAL
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

/** True when box-options v2 features are needed (compress, container control, custom boxes, or jumbfBoxes). */
function needsBoxOptsV2(options: EncoderOptions): boolean {
  const m = options.metadata;
  const hasCustom = (options.customBoxes != null && options.customBoxes.length > 0);
  const hasJumbf = (options.jumbfBoxes != null && options.jumbfBoxes.length > 0);
  return !!(m?.compressBoxes || m?.forceContainer || m?.rawCodestream) || hasCustom || hasJumbf;
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

/** Expand jumbfBoxes into internal MetadataBoxSpec entries (type "jumb", compress default true). Pure TS sugar. */
function expandJumbfToCustomBoxes(jumbf?: readonly JUMBFBox[]): MetadataBoxSpec[] {
  if (!jumbf || jumbf.length === 0) return [];
  return jumbf.map(j => ({
    type: "jumb",
    data: j.data instanceof ArrayBuffer ? new Uint8Array(j.data) : j.data,
    compress: true, // JUMBF claims are often large; default to compression (caller can still override via customBoxes if needed)
  }));
}

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
  const customBoxes = [
    ...(options.customBoxes ?? []),
    ...expandJumbfToCustomBoxes(options.jumbfBoxes),
  ];
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
      const typeStr = (cb.type + "    ").slice(0, 4);
      for (let j = 0; j < 4; j++) cbBuf[base + j] = typeStr.charCodeAt(j) & 0xff;
      const cbData = cb.data instanceof ArrayBuffer ? new Uint8Array(cb.data) : cb.data;
      let cbDataPtr = 0;
      if (cbData.byteLength > 0) {
        cbDataPtr = module._malloc(cbData.byteLength);
        if (cbDataPtr !== 0) { module.HEAPU8.set(cbData, cbDataPtr); freePtrs.push(cbDataPtr); }
      }
      dv.setUint32(base + 4, cbDataPtr, true);
      dv.setUint32(base + 8, cbData.byteLength, true);
      dv.setUint32(base + 12, cb.compress ? 1 : 0, true);
    }
    customBoxesArrayPtr = module._malloc(cbBuf.byteLength);
    if (customBoxesArrayPtr !== 0) { module.HEAPU8.set(cbBuf, customBoxesArrayPtr); freePtrs.push(customBoxesArrayPtr); }
  }

  // Build WasmBoxOpts.
  const boBuf = new Uint8Array(WASM_BOX_OPTS_BYTES);
  const boDv = new DataView(boBuf.buffer);
  boDv.setUint32(0,  m?.compressBoxes  ? 1 : 0, true);
  boDv.setUint32(4,  (!m?.rawCodestream && m?.forceContainer) ? 1 : 0, true);
  boDv.setUint32(8,  m?.rawCodestream  ? 1 : 0, true);
  boDv.setUint32(12, customBoxesArrayPtr, true);
  boDv.setUint32(16, customBoxes.length, true);

  const ptr = module._malloc(WASM_BOX_OPTS_BYTES);
  if (ptr !== 0) module.HEAPU8.set(boBuf, ptr);
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
const WASM_ANIMATION_FRAME_BYTES = 28;

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
    let pixelsPtr = 0;
    if (pixelData.byteLength > 0) {
      pixelsPtr = module._malloc(pixelData.byteLength);
      if (pixelsPtr !== 0) { module.HEAPU8.set(pixelData, pixelsPtr); freePtrs.push(pixelsPtr); }
    }
    framesDv.setUint32(base,      pixelsPtr,            true);
    framesDv.setUint32(base +  4, pixelData.byteLength, true);
    framesDv.setUint32(base +  8, f.width,              true);
    framesDv.setUint32(base + 12, f.height,             true);
    framesDv.setUint32(base + 16, f.duration,           true);
    let namePtr = 0;
    let nameSize = 0;
    if (f.name != null && f.name.length > 0) {
      const nameBytes = new TextEncoder().encode(f.name);
      namePtr = module._malloc(nameBytes.byteLength);
      if (namePtr !== 0) { module.HEAPU8.set(nameBytes, namePtr); freePtrs.push(namePtr); nameSize = nameBytes.byteLength; }
    }
    framesDv.setUint32(base + 20, namePtr,  true);
    framesDv.setUint32(base + 24, nameSize, true);
  }

  const framesPtr = module._malloc(framesBuf.byteLength);
  if (framesPtr !== 0) { module.HEAPU8.set(framesBuf, framesPtr); freePtrs.push(framesPtr); }

  const animBuf = new Uint8Array(WASM_ANIMATION_OPTS_BYTES);
  const animDv = new DataView(animBuf.buffer);
  animDv.setUint32(0, animOpts?.ticksPerSecond ?? 1000, true);
  animDv.setUint32(4, animOpts?.loopCount      ?? 0,    true);
  const animOptsPtr = module._malloc(WASM_ANIMATION_OPTS_BYTES);
  if (animOptsPtr !== 0) { module.HEAPU8.set(animBuf, animOptsPtr); freePtrs.push(animOptsPtr); }

  return { framesPtr, animOptsPtr, freePtrs };
}

/**
 * Marshals modularOptions (6 scalars with native sentinels) + advancedFrameSettings (flat i32 pairs)
 * for the extended latest encode entrypoints.
 * Only the newest _x / _v2 / ec_v2 / animation / gain / sidecars_x paths accept these.
 * Returns the 6 subs (in native order), advPtr/Count, and a free list.
 * When no advanced options are present, returns neutral sentinels (no malloc).
 *
 * `advancedControls` (the new first-class promoted surface) is converted into additional
 * raw pairs here and merged before the user-supplied advancedFrameSettings (so named
 * controls win unless the user explicitly overrides via the escape hatch).
 */
function marshalAdvancedAndModular(
  module: LibjxlWasmModule,
  modularOptions: ModularOptions | undefined,
  advanced: readonly AdvancedFrameSetting[] | undefined,
  advancedControls?: AdvancedEncoderControls,
  upsamplingMode: number = 0,
  alreadyDownsampled: boolean = false,
): { modSubs: number[]; advPtr: number; advCount: number; freePtrs: number[] } {
  const freePtrs: number[] = [];
  // Order matches native.cc EncoderData + Apply: group, predictor, nbPrev, paletteColors, lossyPalette, maTree
  const paletteSentinel = (1 << 31); // INT32_MIN equivalent for "not set"
  const modSubs: number[] = [
    modularOptions?.groupSize ?? -1,
    modularOptions?.predictor ?? -1,
    modularOptions?.nbPrevChannels ?? -1,
    modularOptions?.paletteColors ?? paletteSentinel,
    modularOptions?.lossyPalette ? 1 : -1,
    modularOptions?.maTreeLearningPercent ?? -1,
  ];

  // Build the effective list of advanced settings.
  // 1. Convert first-class advancedControls into raw pairs (named controls win for promoted IDs).
  // 2. Append user-supplied advancedFrameSettings last (they can still override).
  const effectiveAdvanced: AdvancedFrameSetting[] = [];

  // Phase 1 concrete win: Filters group (DOTS=7, PATCHES=8, EPF=9, GABORISH=10)
  const f = advancedControls?.filters;
  if (f) {
    if (f.dots !== undefined)      effectiveAdvanced.push({ id: 7,  value: f.dots ? 1 : 0 });
    if (f.patches !== undefined)   effectiveAdvanced.push({ id: 8,  value: f.patches ? 1 : 0 });
    if (f.epf !== undefined)       effectiveAdvanced.push({ id: 9,  value: f.epf });
    if (f.gaborish !== undefined)  effectiveAdvanced.push({ id: 10, value: f.gaborish ? 1 : 0 });
  }

  // Next high-ROI item: GROUP_ORDER family (13, 14, 15)
  const g = advancedControls?.groupOrder;
  if (g) {
    const modeVal = g.mode === 'center' ? 1 : 0;
    effectiveAdvanced.push({ id: 13, value: modeVal });
    if (g.mode === 'center') {
      if (g.centerX !== undefined) effectiveAdvanced.push({ id: 14, value: g.centerX });
      if (g.centerY !== undefined) effectiveAdvanced.push({ id: 15, value: g.centerY });
    }
  }

  // Buffering modes (ID 34) — strong candidate from the audit
  const b = advancedControls?.buffering;
  if (b) {
    if (b.strategy !== undefined) {
      effectiveAdvanced.push({ id: 34, value: b.strategy });
    }
    // Note: streamingInput / streamingOutput are hints that often interact with buffering=3
    // and JxlOutputProcessor on the C side. For now we expose them; full low-memory streaming
    // paths may require additional bridge work in future slices.
    if (b.streamingInput) {
      // Many references force buffering=3 when using streaming input.
      // We surface the flag; caller can also set strategy: 3 explicitly.
    }
    if (b.streamingOutput) {
      effectiveAdvanced.push({ id: 34, value: 3 }); // common pattern
    }
    // Production low-memory (production-chunked-paths note): lowMemoryMode promotes to high buffering strategy
    // without requiring caller to know the magic number. preferChunkedAPI is a native-only policy flag (no-op here).
    if (b.lowMemoryMode && b.strategy === undefined) {
      effectiveAdvanced.push({ id: 34, value: 3 });
    }
  }

  if (advanced && advanced.length > 0) {
    effectiveAdvanced.push(...advanced);
  }

  // Pixel art & advanced downsampling (from pixel-art-downsampling design note).
  // Routed via the advanced pairs mechanism for automatic reach on all paths that call ApplyAdvancedFrameSettings.
  // ID 55 = UPSAMPLING_MODE (0 = nearest for pixel art); ID 56 = ALREADY_DOWNSAMPLED.
  // This is the sustainable smart-wiring pattern (see HDR scalars and buffering).
  if (upsamplingMode >= 0) {
    effectiveAdvanced.push({ id: 55, value: upsamplingMode });
  }
  if (alreadyDownsampled) {
    effectiveAdvanced.push({ id: 56, value: 1 });
  }

  // JPEG recon CFL (ID 30) intentionally omitted here (broken scope in prior pass).
  // Dedicated handling lives in the v3 transcode path (jpeg-recompression-polish note).
  // General encodes can use advancedFrameSettings escape or advancedControls for ID 30 if needed.
  // (The sustainable pairs injection for CFL remains available for a future minimal follow-up.)

  let advPtr = 0;
  let advCount = 0;
  if (effectiveAdvanced.length > 0) {
    const bytes = effectiveAdvanced.length * 8; // int32 id + int32 value, little-endian
    const buf = new Uint8Array(bytes);
    const dv = new DataView(buf.buffer);
    for (let i = 0; i < effectiveAdvanced.length; i++) {
      const a = effectiveAdvanced[i]!;
      dv.setInt32(i * 8 + 0, (a.id | 0), true);
      dv.setInt32(i * 8 + 4, (a.value | 0), true);
    }
    advPtr = module._malloc(bytes);
    if (advPtr !== 0) {
      module.HEAPU8.set(buf, advPtr);
      freePtrs.push(advPtr);
    }
    advCount = effectiveAdvanced.length;
  }
  return { modSubs, advPtr, advCount, freePtrs };
}

function resolveEncoderBridgeSettings(options: EncoderOptions) {
  const modular = options.modular ?? -1;
  const brotliEffort = options.brotliEffort != null ? Math.max(-1, Math.min(11, Math.round(options.brotliEffort))) : -1;
  const decodingSpeed = options.decodingSpeed != null ? Math.max(0, Math.min(4, Math.round(options.decodingSpeed))) : -1;
  const photonNoiseIso = options.photonNoiseIso != null ? Math.max(0, Math.round(options.photonNoiseIso)) : 0;
  const resampling = resolveResampling(options.resampling);
  const upsamplingMode = options.upsamplingMode ?? 0;
  const alreadyDownsampled = !!options.alreadyDownsampled;
  // Advanced modular + escape + the new first-class advancedControls surface.
  // Named advancedControls are converted to raw pairs inside marshalAdvancedAndModular
  // and win over user raw advancedFrameSettings for the promoted IDs.
  const modularOptions = options.modularOptions;
  const advancedFrameSettings = options.advancedFrameSettings;
  const advancedControls = options.advancedControls;
  if (!options.progressive) {
    return { progressiveDc: 0, progressiveAc: 0, qProgressiveAc: 0, buffering: options.chunked ? 2 : 0, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, upsamplingMode, alreadyDownsampled, modularOptions, advancedFrameSettings, advancedControls };
  }
  const acEnabled = options.progressiveFlavor === "ac" || (options.progressiveFlavor !== "dc" && options.previewFirst);
  return {
    progressiveDc: 1,
    progressiveAc: acEnabled ? 1 : 0,
    qProgressiveAc: acEnabled ? 1 : 0,
    buffering: options.chunked ? 2 : 0,
    modular,
    brotliEffort,
    decodingSpeed,
    photonNoiseIso,
    resampling,
    upsamplingMode,
    alreadyDownsampled,
    modularOptions,
    advancedFrameSettings,
    advancedControls,
  };
}

function resolveResampling(value: unknown): ResamplingFactor {
  return value === 2 || value === 4 || value === 8 ? value : 1;
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
  animationSeek: boolean;
}

export interface DecodeGridInfo {
  tileWidth?: number;
  tileHeight?: number;
  preferredRegionAlign?: number;
  lodLevels?: readonly number[];
}

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
export interface JpegReconstructionOptions {
  cfl?: boolean;
  compressBoxes?: boolean;
  emitWarnings?: boolean;
  storeJPEGMetadata?: boolean;
}

export async function transcodeJpegToJxl(jpeg: ArrayBuffer | Uint8Array, recon?: JpegReconstructionOptions): Promise<Uint8Array> {
  const module = await loadLibjxlModule();
  if (!getCapabilities(module).jpegTranscode) {
    throw new CapabilityMissing("JPEG→JXL transcode requires a rebuilt WASM with transcode bridge");
  }
  const view = copyOrBorrowInput(jpeg, false);
  const ptr = module._malloc(view.byteLength);
  try {
    module.HEAPU8.set(view, ptr);
    // Prefer v3 (with explicit recon controls) when present (requires rebuild with the new bridge symbol).
    const v3 = module._jxl_wasm_transcode_jpeg_to_jxl_v3;
    if (v3 && recon) {
      // For v3 we use the v2-style path (metadata capable). For pure no-box case fall back to v1 behavior.
      // Allocate dummy box pointers (empty) for the simple case.
      const h = v3(ptr, view.byteLength, 0, 0, 0, 0, 0, recon.cfl ? 1 : 0, recon.storeJPEGMetadata ? 1 : 0);
      return takeBuffer(module, h, "transcode").data;
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
    const estTilesX = Math.ceil((x + w) / tileSize) - Math.floor(x / tileSize);
    const estTilesY = Math.ceil((y + h) / tileSize) - Math.floor(y / tileSize);
    const estTilesNeeded = estTilesX * estTilesY;

    console.log(
      `[decodeTiledRegionRgba8] region=${x},${y} size=${w}×${h} estTiles=${estTilesNeeded} (${estTilesX}×${estTilesY}) | ` +
      `prep=${(t1-tStart).toFixed(1)}ms malloc=${tMalloc.toFixed(1)}ms heapSet=${tHeapSet.toFixed(1)}ms ` +
      `wasmDecode=${tWasmDecode.toFixed(1)}ms bufferRead=${tBufferRead.toFixed(1)}ms total=${tTotal.toFixed(1)}ms | ` +
      `output=${buf.width}×${buf.height} (${(buf.data.byteLength / 1024).toFixed(1)}KB)`
    );
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
    console.log(
      `[decodeTileContainerRegionRgba8] region=${x},${y} size=${w}×${h} | ` +
      `prep=${(t1-tStart).toFixed(1)}ms malloc=${tMalloc.toFixed(1)}ms heapSet=${tHeapSet.toFixed(1)}ms ` +
      `wasmDecode=${tWasmDecode.toFixed(1)}ms bufferRead=${tBufferRead.toFixed(1)}ms total=${tTotal.toFixed(1)}ms | ` +
      `output=${buf.width}×${buf.height} (${(buf.data.byteLength / 1024).toFixed(1)}KB)`
    );
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
    downsample: pickDownsample(options),
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
        const pixels = applyRegionAndDownsample(buf.data, buf.width, buf.height, this.options.region ?? null, this.options.downsample ?? 1, bpc);
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
      let drainPending = false;
      let inputClosed = false;

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
          result = decPush(dec, 0, 0);
          if (result < 0) throw new Error(`JXL decode error: ${decError(dec)}`);
        } else if (this.chunkQueue.length > this.readIndex && this.chunkQueue[this.readIndex] === null) {
          // Close sentinel — flush remaining decoder state, then keep draining until done.
          this.readIndex++;
          this.compactQueue();
          decCloseInput(dec);
          inputClosed = true;
          result = decPush(dec, 0, 0);
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
          result = decPush(dec, chunkBufPtr, batchBytes);
          if (result < 0) throw new Error(`JXL decode error: ${decError(dec)}`);
        }

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
          drainPending = true;
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
            };
            if (hasRegion) ev.regionFallback = "full-frame-then-crop";
            if (outPixels.region !== undefined) ev.region = outPixels.region;
            if (module._jxl_wasm_dec_frame_duration) {
              const frameIndex         = module._jxl_wasm_dec_frame_index?.(dec) ?? undefined;
              const frameDuration      = module._jxl_wasm_dec_frame_duration(dec);
              const isLastFrame        = module._jxl_wasm_dec_is_last_frame
                ? (module._jxl_wasm_dec_is_last_frame(dec) !== 0)
                : undefined;
              const animTicksPerSecond = module._jxl_wasm_dec_anim_ticks_per_second?.(dec) ?? undefined;
              const animLoopCount      = module._jxl_wasm_dec_anim_loop_count?.(dec)       ?? undefined;
              const namePtr = module._jxl_wasm_dec_frame_name_ptr?.(dec) ?? 0;
              let frameName: string | undefined;
              if (namePtr !== 0) {
                let end = namePtr;
                while (module.HEAPU8[end] !== 0 && end < namePtr + 256) end++;
                frameName = new TextDecoder().decode(module.HEAPU8.subarray(namePtr, end));
              }
              Object.assign(ev, {
                ...(frameIndex         !== undefined && { frameIndex }),
                ...(frameDuration      !== undefined && { frameDuration }),
                ...(frameName          !== undefined && { frameName }),
                ...(isLastFrame        !== undefined && { isLastFrame }),
                ...(animTicksPerSecond !== undefined && { animTicksPerSecond }),
                ...(animLoopCount      !== undefined && { animLoopCount }),
              });
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
        const wrapped = takeAndWrap(decTakeFinal(dec));
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
            };
            if (hasRegion) ev.regionFallback = "full-frame-then-crop";
            if (outPixels.region !== undefined) ev.region = outPixels.region;
            if (module._jxl_wasm_dec_frame_duration) {
              const frameIndex         = module._jxl_wasm_dec_frame_index?.(dec) ?? undefined;
              const frameDuration      = module._jxl_wasm_dec_frame_duration(dec);
              const isLastFrame        = module._jxl_wasm_dec_is_last_frame
                ? (module._jxl_wasm_dec_is_last_frame(dec) !== 0)
                : undefined;
              const animTicksPerSecond = module._jxl_wasm_dec_anim_ticks_per_second?.(dec) ?? undefined;
              const animLoopCount      = module._jxl_wasm_dec_anim_loop_count?.(dec)       ?? undefined;
              const namePtr = module._jxl_wasm_dec_frame_name_ptr?.(dec) ?? 0;
              let frameName: string | undefined;
              if (namePtr !== 0) {
                let end = namePtr;
                while (module.HEAPU8[end] !== 0 && end < namePtr + 256) end++;
                frameName = new TextDecoder().decode(module.HEAPU8.subarray(namePtr, end));
              }
              Object.assign(ev, {
                ...(frameIndex         !== undefined && { frameIndex }),
                ...(frameDuration      !== undefined && { frameDuration }),
                ...(frameName          !== undefined && { frameName }),
                ...(isLastFrame        !== undefined && { isLastFrame }),
                ...(animTicksPerSecond !== undefined && { animTicksPerSecond }),
                ...(animLoopCount      !== undefined && { animLoopCount }),
              });
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
          };
          if (hasRegion) ev.regionFallback = "full-frame-then-crop";
          if (outPixels.region !== undefined) ev.region = outPixels.region;
          if (module._jxl_wasm_dec_has_gain_map?.(dec) === 1 && module._jxl_wasm_dec_take_gain_map) {
            const gmHandle = module._jxl_wasm_dec_take_gain_map(dec);
            if (gmHandle !== 0) {
              try {
                const gmDataPtr = module._jxl_wasm_buffer_data(gmHandle);
                const gmSize = module._jxl_wasm_buffer_size(gmHandle);
                if (gmDataPtr !== 0 && gmSize > 0) {
                  ev.gainMap = { data: module.HEAPU8.slice(gmDataPtr, gmDataPtr + gmSize) };
                }
              } finally {
                module._jxl_wasm_buffer_free(gmHandle);
              }
            }
          }
          // Populate animation per-frame metadata when bridge accessors are present.
          if (module._jxl_wasm_dec_frame_duration) {
            const frameIndex         = module._jxl_wasm_dec_frame_index?.(dec) ?? undefined;
            const frameDuration      = module._jxl_wasm_dec_frame_duration(dec);
            const isLastFrame        = module._jxl_wasm_dec_is_last_frame
              ? (module._jxl_wasm_dec_is_last_frame(dec) !== 0)
              : undefined;
            const animTicksPerSecond = module._jxl_wasm_dec_anim_ticks_per_second?.(dec) ?? undefined;
            const animLoopCount      = module._jxl_wasm_dec_anim_loop_count?.(dec)       ?? undefined;
            const namePtr = module._jxl_wasm_dec_frame_name_ptr?.(dec) ?? 0;
            let frameName: string | undefined;
            if (namePtr !== 0) {
              let end = namePtr;
              while (module.HEAPU8[end] !== 0 && end < namePtr + 256) end++;
              frameName = new TextDecoder().decode(module.HEAPU8.subarray(namePtr, end));
            }
            Object.assign(ev, {
              ...(frameIndex         !== undefined && { frameIndex }),
              ...(frameDuration      !== undefined && { frameDuration }),
              ...(frameName          !== undefined && { frameName }),
              ...(isLastFrame        !== undefined && { isLastFrame }),
              ...(animTicksPerSecond !== undefined && { animTicksPerSecond }),
              ...(animLoopCount      !== undefined && { animLoopCount }),
            });
          }
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
      const decoded = callDecodeFromPtr(module, inputPtr, totalSize, this.options.downsample ?? 1, fmt, cppDidCrop ? regionForDecode : null);
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
  private readonly validationWarnings: string[] = [];

  constructor(private readonly options: EncoderOptions) {
    this.sortedSidecarSizes = options.sidecarSizes ? [...options.sidecarSizes].sort((a, b) => a - b) : [];
    this.pixelByteTotal = expectedPixelBytes(options.width, options.height, options.format);

    // Run lightweight validation on first-class advanced controls (cjxl-inspired)
    this.validationWarnings = validateAdvancedControls(options.advancedControls);
    if (this.validationWarnings.length > 0) {
      console.warn('[JxlEncoder] Advanced controls warnings:', this.validationWarnings);
    }
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
    const { iccProfile: effIcc, exif: effExif, xmp: effXmp } = resolveEffectiveMetadata(this.options);
    const hasMetadataOpts = effIcc !== null || effExif !== null || effXmp !== null || needsBoxOptsV2(this.options) || this.options.gainMap != null;
    const hasAdvanced = !!(this.options.modularOptions ||
      (this.options.advancedFrameSettings && this.options.advancedFrameSettings.length > 0) ||
      this.options.advancedControls);
    // When advanced modular/escape options are supplied, force the buffered path (which will go through
    // the extended _x / _v2 / ec_v2 entrypoints that carry the new params). This avoids touching the
    // streaming enc state machine for the first implementation.
    if (!wantSidecars && !hasMetadataOpts && !hasAdvanced && caps.streamingInput) {
      const distance = this.options.distance ?? distanceFromQuality(this.options.quality);
      const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : 0;
      const { progressiveDc, progressiveAc, qProgressiveAc, buffering, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, upsamplingMode: upCreate, alreadyDownsampled: adCreate } = resolveEncoderBridgeSettings(this.options);
      if (caps.extOptions && module._jxl_wasm_enc_create_image_x) {
        this.wasmEncState = module._jxl_wasm_enc_create_image_x(
          this.options.width, this.options.height,
          distance, this.options.effort,
          fmtIndex, this.options.hasAlpha ? 1 : 0,
          progressiveDc, progressiveAc, qProgressiveAc, buffering,
          modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling,
          -1, -1, -1, (1<<31), -1, -1, 0, 0,
        );
      } else {
        this.wasmEncState = module._jxl_wasm_enc_create_image!(
          this.options.width, this.options.height,
          distance, this.options.effort,
          fmtIndex, this.options.hasAlpha ? 1 : 0,
          progressiveDc, progressiveAc, qProgressiveAc, buffering, resampling,
        );
      }
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
        const { modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, upsamplingMode: upAnim, alreadyDownsampled: adAnim, modularOptions: modOptsAnim, advancedFrameSettings: advAnim, advancedControls: advControlsAnim } = resolveEncoderBridgeSettings(this.options);
        const { modSubs: modSubsAnim, advPtr: advPtrAnim, advCount: numAdvAnim, freePtrs: advFreeAnim } = marshalAdvancedAndModular(module, modOptsAnim, advAnim, advControlsAnim, upAnim ?? 0, !!adAnim);
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
            modSubsAnim[0], modSubsAnim[1], modSubsAnim[2], modSubsAnim[3], modSubsAnim[4], modSubsAnim[5],
            (advPtrAnim ?? 0), (numAdvAnim ?? 0),
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
          advFreeAnim.forEach(p => module._free(p));
          if (advPtrAnim !== 0) module._free(advPtrAnim);
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
        const { progressiveDc, progressiveAc, qProgressiveAc, buffering, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, upsamplingMode: upMode, alreadyDownsampled: alreadyDown, modularOptions: modOpts, advancedFrameSettings: advSettings, advancedControls: advControls } = resolveEncoderBridgeSettings(this.options);
        const { modSubs, advPtr: advSettingsPtr, advCount: numAdvSettings, freePtrs: advFreePtrs } = marshalAdvancedAndModular(module, modOpts, advSettings, advControls, upMode ?? 0, !!alreadyDown);

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
              progressiveDc, progressiveAc, qProgressiveAc, buffering,
              modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling,
              iccPtr4, iccView4.byteLength,
              exifPtr4, exifView4.byteLength,
              xmpPtr4, xmpView4.byteLength,
              gmPtr, gmView.byteLength,
              modSubs[0], modSubs[1], modSubs[2], modSubs[3], modSubs[4], modSubs[5],
              advSettingsPtr, numAdvSettings,
            );
            const encoded = takeBuffer(module, handle, "encode (gain map)");
            compressedBytes += encoded.data.byteLength;
            yield encoded.data;
          } finally {
            if (iccPtr4 !== 0) module._free(iccPtr4);
            if (exifPtr4 !== 0) module._free(exifPtr4);
            if (xmpPtr4 !== 0) module._free(xmpPtr4);
            if (gmPtr !== 0) module._free(gmPtr);
            advFreePtrs.forEach(p => module._free(p));
            if (advSettingsPtr !== 0) module._free(advSettingsPtr);
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
                  progressiveDc, progressiveAc, qProgressiveAc, buffering,
                  modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling,
                  iccPtr, iccView.byteLength,
                  exifPtr, exifView.byteLength,
                  xmpPtr, xmpView.byteLength,
                  alphaDistance,
                  ecDescPtr, extraChannels.length,
                  boxOptsPtr,
                  modSubs[0], modSubs[1], modSubs[2], modSubs[3], modSubs[4], modSubs[5],
                  advSettingsPtr ?? 0, numAdvSettings ?? 0,
                )
              : module._jxl_wasm_encode_rgba8_with_metadata_ec!(
                  ptr, this.options.width, this.options.height,
                  distance, this.options.effort, fmt, hasAlpha,
                  progressiveDc, progressiveAc, qProgressiveAc, buffering,
                  modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling,
                  iccPtr, iccView.byteLength,
                  exifPtr, exifView.byteLength,
                  xmpPtr, xmpView.byteLength,
                  alphaDistance,
                  ecDescPtr, extraChannels.length,
                  modSubs[0], modSubs[1], modSubs[2], modSubs[3], modSubs[4], modSubs[5],
                  advSettingsPtr ?? 0, numAdvSettings ?? 0,
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
            advFreePtrs.forEach(p => module._free(p));
            if (advSettingsPtr !== 0) module._free(advSettingsPtr);
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
                  modSubs[0], modSubs[1], modSubs[2], modSubs[3], modSubs[4], modSubs[5],
                  advSettingsPtr ?? 0, numAdvSettings ?? 0,
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
            advFreePtrs.forEach(p => module._free(p));
            if (advSettingsPtr !== 0) module._free(advSettingsPtr);
          }
        } else if (caps.streamingEncode) {
          // #11: streaming encoder — yields 256 KB chunks, reducing peak JS heap usage.
          const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : 0;
            const encState = module._jxl_wasm_enc_create!();
            try {
            const rc = caps.extOptions && module._jxl_wasm_enc_push_pixels_x
              ? module._jxl_wasm_enc_push_pixels_x(encState, ptr, this.options.width, this.options.height, distance, this.options.effort, fmtIndex, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, -1, -1, -1, -1, -1, -1, 0, 0)
              : module._jxl_wasm_enc_push_pixels!(encState, ptr, this.options.width, this.options.height, distance, this.options.effort, fmtIndex, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, resampling);
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
          // fmt: 0=rgba8, 1=rgba16, 2=rgbaf32 — matches bridge parameter order.
          const fmt = this.options.format === "rgba16" ? 1 : this.options.format === "rgbaf32" ? 2 : 0;
          const { iccProfile: effIcc3, exif: effExif3, xmp: effXmp3 } = resolveEffectiveMetadata(this.options);
          const hasMetadata = effIcc3 !== null || effExif3 !== null || effXmp3 !== null || needsBoxOptsV2(this.options);
          if (hasMetadata && module._jxl_wasm_encode_rgba8_with_metadata) {
            const iccView = effIcc3 ? copyOrBorrowInput(effIcc3, false) : new Uint8Array(0);
            const exifView = effExif3 ? copyOrBorrowInput(effExif3, false) : new Uint8Array(0);
            const xmpView = effXmp3 ? copyOrBorrowInput(effXmp3, false) : new Uint8Array(0);

            const iccPtr = iccView.byteLength > 0 ? module._malloc(iccView.byteLength) : 0;
            const exifPtr = exifView.byteLength > 0 ? module._malloc(exifView.byteLength) : 0;
            const xmpPtr = xmpView.byteLength > 0 ? module._malloc(xmpView.byteLength) : 0;

            const useBoxV2Std = needsBoxOptsV2(this.options) && caps.metadataBoxesV2 &&
              typeof module._jxl_wasm_encode_rgba8_with_metadata_v2 === "function";
            const { ptr: boxOptsPtr2, freePtrs: boxOptsPtrs2 } = useBoxV2Std
              ? marshalBoxOpts(module, this.options)
              : { ptr: 0, freePtrs: [] };

            try {
              if (iccPtr !== 0) module.HEAPU8.set(iccView, iccPtr);
              if (exifPtr !== 0) module.HEAPU8.set(exifView, exifPtr);
              if (xmpPtr !== 0) module.HEAPU8.set(xmpView, xmpPtr);

              if (useBoxV2Std) {
                handle = module._jxl_wasm_encode_rgba8_with_metadata_v2!(
                  ptr, this.options.width, this.options.height,
                  distance, this.options.effort, fmt, hasAlpha,
                  progressiveDc, progressiveAc, qProgressiveAc, buffering,
                  modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling,
                  iccPtr, iccView.byteLength,
                  exifPtr, exifView.byteLength,
                  xmpPtr, xmpView.byteLength,
                  boxOptsPtr2,
                  modSubs[0], modSubs[1], modSubs[2], modSubs[3], modSubs[4], modSubs[5],
                  advSettingsPtr ?? 0, numAdvSettings ?? 0,
                );
              } else {
                handle = caps.extOptions && module._jxl_wasm_encode_rgba8_with_metadata_x
                  ? module._jxl_wasm_encode_rgba8_with_metadata_x(
                      ptr, this.options.width, this.options.height,
                      distance, this.options.effort, fmt, hasAlpha,
                      progressiveDc, progressiveAc, qProgressiveAc, buffering,
                      modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling,
                      iccPtr, iccView.byteLength,
                      exifPtr, exifView.byteLength,
                      xmpPtr, xmpView.byteLength,
                      modSubs[0], modSubs[1], modSubs[2], modSubs[3], modSubs[4], modSubs[5],
                      advSettingsPtr, numAdvSettings,
                    )
                  : module._jxl_wasm_encode_rgba8_with_metadata(
                      ptr, this.options.width, this.options.height,
                      distance, this.options.effort, fmt, hasAlpha,
                      progressiveDc, progressiveAc, qProgressiveAc, buffering, resampling,
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
              advFreePtrs.forEach(p => module._free(p));
              if (advSettingsPtr !== 0) module._free(advSettingsPtr);
            }
          } else {
            // Fallback: plain encode (no metadata) used when bridge fn absent
            // or when no metadata was provided.
            if (this.options.format === "rgba16") {
              handle = caps.extOptions && module._jxl_wasm_encode_rgba16_x
                ? module._jxl_wasm_encode_rgba16_x(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, modSubs[0], modSubs[1], modSubs[2], modSubs[3], modSubs[4], modSubs[5], advSettingsPtr ?? 0, numAdvSettings ?? 0)
                : module._jxl_wasm_encode_rgba16
                  ? module._jxl_wasm_encode_rgba16(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, resampling)
                  : module._jxl_wasm_encode_rgba8(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, resampling);
            } else if (this.options.format === "rgbaf32") {
              handle = caps.extOptions && module._jxl_wasm_encode_rgbaf32_x
                ? module._jxl_wasm_encode_rgbaf32_x(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, modSubs[0], modSubs[1], modSubs[2], modSubs[3], modSubs[4], modSubs[5], advSettingsPtr ?? 0, numAdvSettings ?? 0)
                : module._jxl_wasm_encode_rgbaf32
                  ? module._jxl_wasm_encode_rgbaf32(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, resampling)
                  : module._jxl_wasm_encode_rgba8(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, resampling);
            } else {
              handle = caps.extOptions && module._jxl_wasm_encode_rgba8_x
                ? module._jxl_wasm_encode_rgba8_x(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, modSubs[0], modSubs[1], modSubs[2], modSubs[3], modSubs[4], modSubs[5], advSettingsPtr ?? 0, numAdvSettings ?? 0)
                : module._jxl_wasm_encode_rgba8(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, resampling);
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

  getValidationWarnings(): readonly string[] {
    return this.validationWarnings;
  }

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
  cachedModule = await modulePromise;
  return cachedModule;
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
  extOptions: boolean;
  extraChannelEncode: boolean;
  metadataBoxesV2: boolean;
  gainMapEncode: boolean;
  animationEncode: boolean;
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

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

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

function pickDownsample(options: { region?: Region | null; targetWidth?: number | null; targetHeight?: number | null }): 1 | 2 | 4 | 8 {
  const region = options.region ?? null;
  const targetWidth = options.targetWidth ?? null;
  const targetHeight = options.targetHeight ?? null;
  if (region === null || targetWidth == null || targetHeight == null || targetWidth <= 0 || targetHeight <= 0) {
    return 1;
  }
  const sourceLongEdge = Math.max(region.w, region.h);
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
