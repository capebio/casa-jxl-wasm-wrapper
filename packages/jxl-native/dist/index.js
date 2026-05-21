import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export class CapabilityMissing extends Error {
    code = "CapabilityMissing";
    cause;
    constructor(message, cause) {
        super(message);
        this.name = "CapabilityMissing";
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}
const require = createRequire(String(import.meta.url));
const packageRoot = dirname(fileURLToPath(String(import.meta.url)));
export function loadNativeBinding(options = {}) {
    const candidates = [
        options.prebuiltPath ?? resolvePrebuiltBinary(),
        options.sourcePath ?? resolveSourceBinary()
    ];
    let lastError;
    for (const candidate of candidates) {
        try {
            const binding = require(candidate);
            ensureBindingLoaded(binding, candidate);
            return binding;
        }
        catch (error) {
            lastError = error;
        }
    }
    throw new CapabilityMissing("jxl-native addon unavailable; falling back to WASM is required", lastError);
}
export function createNativeCodecFacade(binding) {
    if (typeof binding.createDecoder !== "function" || typeof binding.createEncoder !== "function") {
        throw new CapabilityMissing("jxl-native addon does not expose createDecoder/createEncoder");
    }
    ensureBindingLoaded(binding, "native binding");
    return {
        createDecoder(options) {
            return binding.createDecoder(options);
        },
        createEncoder(options) {
            return binding.createEncoder(options);
        },
    };
}
export function createDecoder(options) {
    return createNativeCodecFacade(loadNativeBinding()).createDecoder(options);
}
export function createEncoder(options) {
    return createNativeCodecFacade(loadNativeBinding()).createEncoder(options);
}
function resolvePrebuiltBinary() {
    const platform = process?.platform ?? "unknown";
    const arch = process?.arch ?? "unknown";
    const base = join(packageRoot, "..", "prebuilds");
    const candidate = resolve(base, `${platform}-${arch}`, "jxl-native.node");
    return candidate;
}
function resolveSourceBinary() {
    const release = resolve(packageRoot, "..", "build", "Release", "jxl_native.node");
    const debug = resolve(packageRoot, "..", "build", "Debug", "jxl_native.node");
    return fileExists(release) ? release : fileExists(debug) ? debug : release;
}
function fileExists(path) {
    try {
        require("node:fs").accessSync(path);
        return true;
    }
    catch {
        return false;
    }
}
function ensureBindingLoaded(binding, label) {
    if (typeof binding.version === "function" && binding.version().includes("scaffold")) {
        throw new CapabilityMissing(`jxl-native addon at ${label} is still the scaffold stub`);
    }
    if (typeof binding.probe !== "function")
        return;
    const probe = binding.probe();
    if (typeof probe.path === "string" && probe.path.toLowerCase().includes("stub")) {
        throw new CapabilityMissing(`jxl-native addon at ${label} is still the scaffold stub`, probe);
    }
    if (probe.loaded !== true) {
        throw new CapabilityMissing(`jxl-native addon at ${label} is present but not loaded`, probe);
    }
}
//# sourceMappingURL=index.js.map
