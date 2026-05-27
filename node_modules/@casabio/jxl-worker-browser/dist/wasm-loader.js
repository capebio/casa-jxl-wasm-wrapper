// jxl-worker-browser/src/wasm-loader.ts
// Loads the WASM codec facade. T-WASM-BUILD supplies the generated libjxl
// adapter behind this facade.
export { detectTier } from "@casabio/jxl-wasm";
export async function loadWasmModule(wasmUrl, options = {}) {
    const imported = await (options.importWasm ?? defaultImportWasm)();
    const facade = resolveJxlModule(imported);
    if (facade !== null)
        return facade;
    // The dynamic import returned null or a module without the expected exports.
    // Probe the WASM URL to give a more actionable diagnostic (missing build
    // artifact vs. module that loaded but lacks createDecoder/createEncoder).
    // Only attempt the probe when a custom fetchImpl is provided or fetch is
    // available in this context; the result is used for the error message only.
    let probeStatus = null;
    try {
        const fetchImpl = options.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : null);
        if (fetchImpl !== null) {
            const resp = await fetchImpl(wasmUrl);
            probeStatus = resp.status;
            // Drain the body to avoid keeping a connection open.
            await resp.body?.cancel();
        }
    }
    catch {
        // Probe failure is non-fatal; we still throw the primary error below.
    }
    if (probeStatus !== null && probeStatus !== 200) {
        throw new Error(`[jxl-worker-browser] WASM not available at ${wasmUrl} (${probeStatus}). ` +
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