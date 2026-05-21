import type { DecodeStage, ImageInfo, PixelFormat, Region } from "@casabio/jxl-core/types";
export type BrowserDecodeEvent = {
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
    partialPixels?: ArrayBuffer | Uint8Array;
    partialInfo?: ImageInfo;
};
export interface BrowserDecoder {
    push(chunk: ArrayBuffer): void | Promise<void>;
    close(): void | Promise<void>;
    events(): AsyncIterable<BrowserDecodeEvent>;
    cancel(reason?: string): void | Promise<void>;
    dispose(): void | Promise<void>;
}
export interface BrowserEncoder {
    pushPixels(chunk: ArrayBuffer, region?: Region): void | Promise<void>;
    finish(): void | Promise<void>;
    chunks(): AsyncIterable<ArrayBuffer | Uint8Array>;
    cancel(reason?: string): void | Promise<void>;
    dispose(): void | Promise<void>;
}
export interface JxlModule {
    createDecoder(options: {
        format: PixelFormat;
        region: Region | null;
        downsample: 1 | 2 | 4 | 8;
        progressionTarget: "header" | "dc" | "pass" | "final";
        emitEveryPass: boolean;
        preserveIcc: boolean;
        preserveMetadata: boolean;
    }): BrowserDecoder;
    createEncoder(options: {
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
    }): BrowserEncoder;
}
export interface WasmLoaderOptions {
    fetchImpl?: typeof fetch;
    importWasm?: () => Promise<unknown>;
}
export declare function loadWasmModule(wasmUrl: string, options?: WasmLoaderOptions): Promise<JxlModule>;
//# sourceMappingURL=wasm-loader.d.ts.map