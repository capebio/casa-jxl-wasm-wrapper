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
} | {
    type: "final";
    info: ImageInfo;
    pixels: ArrayBuffer | Uint8Array;
    format: PixelFormat;
    region?: Region;
    pixelStride: number;
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
    previewFirst: boolean;
    chunked: boolean;
}
export interface NativeDecoder {
    push(chunk: ArrayBuffer | Uint8Array): void | Promise<void>;
    close(): void | Promise<void>;
    events(): AsyncIterable<DecodeEvent>;
    cancel(reason?: string): void | Promise<void>;
    dispose(): void | Promise<void>;
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