export interface Backend {
    type: "native" | "wasm";
    module: CodecModule;
}
export interface CodecModule {
    createDecoder: (...args: never[]) => unknown;
    createEncoder: (...args: never[]) => unknown;
}
export interface BackendSelectorOptions {
    env?: Record<string, string | undefined>;
    importNative?: () => Promise<unknown>;
    importWasm?: () => Promise<unknown>;
}
export declare function selectBackend(options?: BackendSelectorOptions): Promise<Backend>;
//# sourceMappingURL=backend-selector.d.ts.map