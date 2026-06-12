export type Tier = "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar";
export declare function _resetCache(): void;
export declare function canUseThreadedWasm(sharedArrayBuffer: boolean, crossOriginIsolated: boolean): boolean;
/**
 * Detect the WebAssembly tier supported by the environment.
 * Note: Returns "scalar" both when WebAssembly lacks SIMD and when WebAssembly is entirely absent;
 * consumers that must distinguish should use getCapabilities().selectedWasmBuild ("none" when no WASM).
 */
export declare function detectTier(): Tier;
/** Heuristic; thresholds untuned — benchmark before relying on it (CLAUDE.md rule). */
export declare function recommendedEffort(hwConcurrency?: number): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
/** Heuristic; thresholds untuned — benchmark before relying on it (CLAUDE.md rule). */
export declare function recommendedQualitySearch(hwConcurrency?: number): "full" | "fast" | "none";
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
    selectedWasmBuild: Tier | "none";
    libjxlVersion: string;
    webgpu: boolean;
    webnn: boolean;
    hardwareConcurrency: number;
    deviceMemory: number | null;
    imageDecoder: boolean;
    wasmExceptions: boolean;
}
export declare function getCapabilities(): Promise<Capabilities>;
/** Lazy: navigator.gpu presence (caps.webgpu) ≠ usable adapter. Memoized. */
export declare function probeWebGpuAdapter(): Promise<boolean>;
