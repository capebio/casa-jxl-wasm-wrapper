export type Tier = "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar";
export declare function canUseThreadedWasm(sharedArrayBuffer: boolean, crossOriginIsolated: boolean): boolean;
export declare function detectTier(): Tier;
export declare function recommendedEffort(): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export interface Capabilities {
    /**
     * WebAssembly support (WebAssembly.compile present).
     * Note (C-9): under a strict CSP without 'wasm-unsafe-eval', validate/compile may succeed
     * while instantiate still fails at runtime. We document the limitation rather than add
     * a costly async instantiate probe (cost > benefit).
     */
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
    webgpu: boolean;
    webnn: boolean;
    hardwareConcurrency: number;
    deviceMemory: number | null;
}
export declare function getCapabilities(): Promise<Capabilities>;
