export interface JxlWasmManifest {
    buildId: string;
    wasmSha: string;
    wasmUrl?: string;
}
export interface LoaderOptions {
    fetchImpl?: typeof fetch;
    idbFactory?: IDBFactory;
    nodeFs?: typeof import("node:fs/promises");
    cacheDbName?: string;
    wasmUrl?: string;
}
export declare function loadJxlModule(manifest: JxlWasmManifest, options?: LoaderOptions): Promise<WebAssembly.Module>;
//# sourceMappingURL=loader.d.ts.map