export interface JxlWasmManifest {
    buildId: string;
    wasmSha: string;
    wasmUrl?: string;
}
export interface LoaderOptions {
    fetchImpl?: typeof fetch;
    idbFactory?: IDBFactory;
    nodeFs?: {
        readFile(path: string | URL): Promise<Uint8Array>;
    };
    cacheDbName?: string;
    wasmUrl?: string;
}
export declare function loadJxlModule(manifest: JxlWasmManifest, options?: LoaderOptions): Promise<WebAssembly.Module>;
//# sourceMappingURL=loader.d.ts.map
