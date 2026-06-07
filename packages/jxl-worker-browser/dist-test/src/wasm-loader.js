// jxl-worker-browser/src/wasm-loader.ts
// Loads the WASM codec facade. T-WASM-BUILD supplies the generated libjxl
// adapter behind this facade.
let cachedDetectedTier;
export function detectTier() {
    if (cachedDetectedTier !== undefined)
        return cachedDetectedTier;
    let tier;
    if (typeof WebAssembly === "undefined") {
        tier = "scalar";
    }
    else {
        const hasSimd = probeSimd();
        if (!hasSimd) {
            tier = "scalar";
        }
        else {
            const hasSab = typeof SharedArrayBuffer !== "undefined";
            const hasRelaxedSimd = probeRelaxedSimd();
            if (hasSab && hasRelaxedSimd)
                tier = "relaxed-simd-mt";
            else if (hasSab)
                tier = "simd-mt";
            else
                tier = "simd";
        }
    }
    cachedDetectedTier = tier;
    return tier;
}
function probeSimd() {
    try {
        return WebAssembly.validate(new Uint8Array([
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
            0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
            0x03, 0x02, 0x01, 0x00,
            0x0a, 0x08, 0x01, 0x06, 0x00,
            0x41, 0x00, 0xfd, 0x0f, 0x0b,
        ]));
    }
    catch {
        return false;
    }
}
function probeRelaxedSimd() {
    try {
        return WebAssembly.validate(new Uint8Array([
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
            0x01, 0x07, 0x01, 0x60, 0x02, 0x7b, 0x7b, 0x01, 0x7b,
            0x03, 0x02, 0x01, 0x00,
            0x0a, 0x0b, 0x01, 0x09, 0x00,
            0x20, 0x00, 0x20, 0x01, 0xfd, 0x80, 0x02, 0x0b,
        ]));
    }
    catch {
        return false;
    }
}
export async function loadWasmModule(wasmUrl, options = {}) {
    const imported = await (options.importWasm ?? defaultImportWasm)();
    forceWorkerSafeTier(imported);
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
function forceWorkerSafeTier(value) {
    const tier = readWorkerTierOverride();
    if (tier === "auto")
        return;
    const target = isRecord(value) && isRecord(value["default"]) ? value["default"] : value;
    if (!isRecord(target))
        return;
    const setForcedTier = target["setForcedTier"];
    if (typeof setForcedTier === "function") {
        setForcedTier(tier);
    }
}
function readWorkerTierOverride() {
    const search = readWorkerLocationSearch();
    if (search === "")
        return "simd";
    const tier = new URLSearchParams(search).get("jxlWorkerTier");
    if (tier === "auto" || tier === "relaxed-simd-mt" || tier === "simd-mt" || tier === "simd" || tier === "scalar") {
        return tier;
    }
    return "simd";
}
function readWorkerLocationSearch() {
    const globalSelf = globalThis;
    const search = globalSelf.self?.location?.search;
    return typeof search === "string" ? search : "";
}
function isJxlModule(value) {
    return isRecord(value) && typeof value["createDecoder"] === "function" && typeof value["createEncoder"] === "function";
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
//# sourceMappingURL=wasm-loader.js.map