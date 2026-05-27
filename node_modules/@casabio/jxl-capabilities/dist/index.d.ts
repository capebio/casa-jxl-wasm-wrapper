export type Tier = "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar";
export declare function detectTier(): Tier;
export declare function recommendedEffort(): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
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
export declare function getCapabilities(): Promise<Capabilities>;
