export interface Backend {
    type: "native" | "wasm";
    module: unknown;
}
export declare function selectBackend(): Promise<Backend>;
//# sourceMappingURL=backend-selector.d.ts.map