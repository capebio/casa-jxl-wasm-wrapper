export type PixelFormat = "rgba8" | "rgba16" | "rgbaf32";
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
    progressionTarget?: "header" | "dc" | "pass" | "final";
    emitEveryPass?: boolean;
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
    progressive?: boolean;
    previewFirst?: boolean;
    chunked?: boolean;
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
//# sourceMappingURL=types.d.ts.map