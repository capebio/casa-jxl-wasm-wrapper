// jxl-worker-browser/src/wasm-loader.ts
// Loads the WASM codec facade. T-WASM-BUILD supplies the generated libjxl
// adapter behind this facade.
export async function loadWasmModule(wasmUrl, options = {}) {
    const imported = await (options.importWasm ?? defaultImportWasm)();
    const facade = resolveJxlModule(imported);
    if (facade !== null)
        return facade;
    const fetchImpl = options.fetchImpl ?? fetch;
    const resp = await fetchImpl(wasmUrl);
    if (!resp.ok) {
        throw new Error(`[jxl-worker-browser] WASM not available at ${wasmUrl} (${resp.status}). ` +
            "T-WASM-BUILD artifact required.");
    }
    throw new Error("[jxl-worker-browser] @casabio/jxl-wasm does not expose a codec facade. " +
        "T-WASM-BUILD must export createDecoder/createEncoder.");
}
async function defaultImportWasm() {
    // Workers do not reliably inherit the page import map, so resolve the sibling
    // package by URL before falling back to the package specifier for bundled use.
    const packageUrl = new URL("../../jxl-wasm/dist/index.js", import.meta.url).href;
    return await import(packageUrl).catch(async () => {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - module may be absent until local packages are installed
        return await import("@casabio/jxl-wasm").catch(() => null);
    });
}
function resolveJxlModule(value) {
    if (isJxlModule(value))
        return value;
    if (isRecord(value) && isJxlModule(value["default"]))
        return value["default"];
    return null;
}
function isJxlModule(value) {
    return isRecord(value) && typeof value["createDecoder"] === "function" && typeof value["createEncoder"] === "function";
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
//# sourceMappingURL=wasm-loader.js.map