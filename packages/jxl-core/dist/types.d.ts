export type PixelFormat = "rgba8" | "rgba16" | "rgbaf32" | "rgb8";
export interface ImageInfo {
    width: number;
    height: number;
    bitsPerSample: 8 | 16 | 32;
    hasAlpha: boolean;
    hasAnimation: boolean;
    iccProfile?: Uint8Array;
    colorSpace?: ColorSpaceHint;
    exif?: Uint8Array;
    xmp?: Uint8Array;
    jpegReconstructionAvailable: boolean;
}
export type ColorSpaceHint = "srgb" | "display-p3" | "rec2020-pq" | "rec2020-hlg" | "linear-srgb" | "unknown";
export type DecodeStage = "header" | "dc" | "pass" | "final";
export interface DecodeFrameEvent {
    stage: DecodeStage;
    info: ImageInfo;
    pixels: ArrayBuffer;
    format: PixelFormat;
    region?: Region;
    pixelStride: number;
    sourceScale?: number;
    progressiveRegion?: boolean;
    regionFallback?: "full-frame-then-crop";
}
export interface Region {
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface DecodeOptions {
    format: PixelFormat;
    preserveIcc?: boolean;
    preserveMetadata?: boolean;
    region?: Region;
    downsample?: 1 | 2 | 4 | 8;
    targetWidth?: number;
    targetHeight?: number;
    fitMode?: "contain" | "cover" | "stretch";
    progressionTarget?: "header" | "dc" | "pass" | "final";
    emitEveryPass?: boolean;
    /**
     * libjxl progressive detail level. Mapped to JxlProgressiveDetail in the WASM bridge:
     *   "dc"            → kDC: single DC-only preview
     *   "lastPasses"    → kLastPasses: emit only the final refinement passes (skip early noise)
     *   "passes"        → kPasses: emit every refinement pass (default when emitEveryPass)
     *   "dcProgressive" → kDCProgressive: DC followed by progressive AC passes
     * When unset, the facade picks "passes" if emitEveryPass is true or progressionTarget is "pass",
     * otherwise "dc". Ignored when progressionTarget="final" and emitEveryPass=false (no subscription).
     */
    progressiveDetail?: "dc" | "lastPasses" | "passes" | "dcProgressive";
    priority?: "visible" | "near" | "background";
    budgetMs?: number;
    signal?: AbortSignal;
    onMetric?: (m: CodecMetric) => void;
}
export interface DecodeSession {
    readonly id: string;
    push(chunk: ArrayBuffer | Uint8Array): Promise<void>;
    close(): Promise<void>;
    frames(): AsyncIterable<DecodeFrameEvent>;
    done(): Promise<ImageInfo>;
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
    iccProfile?: Uint8Array;
    exif?: Uint8Array;
    xmp?: Uint8Array;
    distance?: number;
    quality?: number;
    effort?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
    modular?: -1 | 0 | 1;
    brotliEffort?: number;
    decodingSpeed?: number;
    photonNoiseIso?: number;
    progressive?: boolean;
    progressiveFlavor?: "dc" | "ac";
    previewFirst?: boolean;
    /**
     * Progressive DC layers (0/1/2). 2 gives more granular early DC stages for visibly distinct passes.
     * Works with groupOrder and progressive decode detail='passes'.
     */
    progressiveDc?: 0 | 1 | 2;
    /**
     * 0=scanline, 1=center-out group order. Strongly recommended for useful early progressive bytes.
     */
    groupOrder?: 0 | 1;
    chunked?: boolean;
    /**
     * Max dimension (px, long edge) of sidecar thumbnail(s) to yield BEFORE the
     * main image chunks. Sorted ascending so the smallest preview arrives first.
     * Requires a WASM build with the sidecar bridge (_jxl_wasm_encode_rgba8_with_sidecars).
     * Falls back to plain encode when the bridge is absent.
     * The leading `sidecarSizes.length` chunks from `chunks()` are the thumbnails.
     */
    sidecarSizes?: readonly number[];
    priority?: "visible" | "near" | "background";
    signal?: AbortSignal;
    onMetric?: (m: CodecMetric) => void;
}
export interface EncodeSession {
    readonly id: string;
    pushPixels(chunk: ArrayBuffer, region?: Region): Promise<void>;
    finish(): Promise<void>;
    chunks(): AsyncIterable<ArrayBuffer>;
    done(): Promise<number>;
    getStats(): EncodeStats | null;
    cancel(reason?: string): Promise<void>;
}
export type CodecMetric = {
    name: "time_to_header_ms";
    value: number;
} | {
    name: "time_to_first_pixel_ms";
    value: number;
} | {
    name: "time_to_final_ms";
    value: number;
} | {
    name: "time_to_first_byte_ms";
    value: number;
} | {
    name: "input_bytes";
    value: number;
} | {
    name: "output_bytes";
    value: number;
} | {
    name: "peak_memory_bytes";
    value: number;
} | {
    name: "format_downcast";
    value: number;
} | {
    name: "region_fallback_full_frame";
    value: 1;
} | {
    name: "decode_scale_used";
    value: number;
} | {
    name: "decode_region_area";
    value: number;
} | {
    name: "source_pixels_decoded";
    value: number;
} | {
    name: "scheduler_queue_wait_ms";
    value: number;
};
export interface Capabilities {
    wasm: boolean;
    wasmSimd: boolean;
    wasmRelaxedSimd: boolean;
    wasmThreads: boolean;
    crossOriginIsolated: boolean;
    sharedArrayBuffer: boolean;
    offscreenCanvas: boolean;
    imageBitmap: boolean;
    nativeJxlDecoder: boolean;
    selectedWasmBuild: "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar" | "none";
    libjxlVersion: string;
}
export interface ContextOptions {
    poolSize?: number;
    memoryCapBytes?: number;
    idleTimeoutMs?: number;
    wasmUrl?: string;
    cache?: CacheOptions;
}
export interface CacheOptions {
    persistent?: boolean;
    hotMaxBytes?: number;
    persistentMaxBytes?: number;
    persistentPath?: string;
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
    lodLevels?: readonly number[];
}
export interface WrapperCapabilities {
    regionDecode: boolean;
    exactSizeDecode: boolean;
    progressiveRegionDecode: boolean;
    tileAlignedRegionDecode: boolean;
    arbitraryRegionDecode: boolean;
    availableDownsampleFactors: readonly number[];
}
//# sourceMappingURL=types.d.ts.map