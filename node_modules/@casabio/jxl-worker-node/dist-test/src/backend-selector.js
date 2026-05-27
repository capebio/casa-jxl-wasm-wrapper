// jxl-worker-node/src/backend-selector.ts
// Selects native libjxl vs WASM at worker startup.
// Spec: Section 15.2, T-WORKER-NODE brief.
export async function selectBackend(options = {}) {
    const env = options.env ?? process.env;
    const forceWasm = env["JXL_FORCE_WASM"] === "1";
    if (!forceWasm) {
        const native = await tryNative(options);
        if (native !== null)
            return native;
    }
    const wasm = await tryWasm(options);
    if (wasm !== null)
        return wasm;
    throw new Error("[jxl-worker-node] Neither jxl-native nor jxl-wasm exposes a codec facade. " +
        "Install usable @casabio/jxl-native or @casabio/jxl-wasm artifacts.");
}
async function tryNative(options) {
    try {
        const imported = await (options.importNative ?? defaultImportNative)();
        const module = resolveCodecModule(imported);
        if (module === null)
            return null;
        return { type: "native", module };
    }
    catch {
        return null;
    }
}
async function tryWasm(options) {
    try {
        const imported = await (options.importWasm ?? defaultImportWasm)();
        const module = resolveCodecModule(imported);
        if (module === null)
            return null;
        return { type: "wasm", module };
    }
    catch {
        return null;
    }
}
async function defaultImportNative() {
    // Dynamic import keeps worker startup clean when optional package absent.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - module may be absent until local packages are installed
    return await import("@casabio/jxl-native").catch(() => null);
}
async function defaultImportWasm() {
    // Dynamic import keeps worker startup clean when optional package absent.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - module may be absent until local packages are installed
    return await import("@casabio/jxl-wasm").catch(() => null);
}
function resolveCodecModule(value) {
    if (isRecord(value) && typeof value["loadNativeBinding"] === "function") {
        try {
            const binding = value["loadNativeBinding"]();
            if (!isLoadedBinding(binding))
                return null;
            return isCodecModule(binding) ? binding : null;
        }
        catch {
            return null;
        }
    }
    if (isCodecModule(value))
        return value;
    if (isRecord(value) && isCodecModule(value["default"]))
        return value["default"];
    return null;
}
function isCodecModule(value) {
    return isRecord(value) && typeof value["createDecoder"] === "function" && typeof value["createEncoder"] === "function";
}
function isLoadedBinding(value) {
    if (!isRecord(value))
        return false;
    if (typeof value["probe"] === "function") {
        const probe = value["probe"]();
        if (!isRecord(probe) || probe["loaded"] !== true)
            return false;
    }
    return true;
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
//# sourceMappingURL=backend-selector.js.map