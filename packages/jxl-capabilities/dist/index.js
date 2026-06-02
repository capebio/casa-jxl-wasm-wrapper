let _cachedTier;
export function canUseThreadedWasm(wasmThreads, sharedArrayBuffer, crossOriginIsolated) {
    return wasmThreads && sharedArrayBuffer && crossOriginIsolated;
}
function _probeSimd() {
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
function _probeWasmThreads() {
    try {
        return WebAssembly.validate(new Uint8Array([
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
            0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
            0x03, 0x02, 0x01, 0x00,
            0x05, 0x03, 0x01, 0x03, 0x01,
            0x0a, 0x0b, 0x01, 0x09, 0x00,
            0x41, 0x00, 0xfe, 0x10, 0x02, 0x00, 0x1a, 0x0b,
        ]));
    }
    catch {
        return false;
    }
}
function _probeRelaxedSimd() {
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
export function detectTier() {
    if (_cachedTier !== undefined)
        return _cachedTier;
    let tier;
    if (typeof WebAssembly === "undefined") {
        tier = "scalar";
    }
    else {
        const hasSimd = _probeSimd();
        if (!hasSimd) {
            tier = "scalar";
        }
        else {
            const hasSab = typeof SharedArrayBuffer !== "undefined";
            const crossOriginIsolated = typeof self !== "undefined" && !!self.crossOriginIsolated;
            const canDoMT = canUseThreadedWasm(_probeWasmThreads(), hasSab, crossOriginIsolated);
            const hasRelaxedSimd = _probeRelaxedSimd();
            if (canDoMT && hasRelaxedSimd)
                tier = "relaxed-simd-mt";
            else if (canDoMT)
                tier = "simd-mt";
            else
                tier = "simd";
        }
    }
    _cachedTier = tier;
    return tier;
}
export function recommendedEffort() {
    const tier = detectTier();
    if (tier === "scalar")
        return 4;
    if (tier === "simd")
        return 6;
    return 7;
}
/**
 * Probe for Relaxed SIMD support via a small runtime instruction.
 */
async function probeRelaxedSimd() {
    try {
        // Relaxed SIMD instruction: i8x16.relaxed_swizzle (0xfd 0x100)
        // Minimal module that uses it.
        const bytes = new Uint8Array([
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
            0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
            0x03, 0x02, 0x01, 0x00,
            0x0a, 0x0f, 0x01, 0x0d, 0x00, 0x41, 0x00, 0xfd, 0x0c, 0x41, 0x00, 0xfd, 0x0c, 0xfd, 0x80, 0x02, 0x0b
        ]);
        await WebAssembly.instantiate(bytes);
        return true;
    }
    catch {
        return false;
    }
}
async function probeWasmSimd() {
    try {
        await WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 11]));
        return true;
    }
    catch {
        return false;
    }
}
async function probeWasmThreads() {
    return _probeWasmThreads();
}
function selectWasmBuild(wasm, wasmSimd, wasmThreads, sharedArrayBuffer, crossOriginIsolated, wasmRelaxedSimd) {
    if (!wasm)
        return "none";
    const canDoMT = canUseThreadedWasm(wasmThreads, sharedArrayBuffer, crossOriginIsolated);
    if (canDoMT && wasmRelaxedSimd)
        return "relaxed-simd-mt";
    if (canDoMT && wasmSimd)
        return "simd-mt";
    if (wasmSimd)
        return "simd";
    return "scalar";
}
/**
 * Probe for native JXL decoder support in the browser.
 */
async function probeNativeJxl() {
    // Real minimal 1x1 JXL (standard container/codestream)
    const minimalJxl = new Uint8Array([
        0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a,
        0x00, 0x00, 0x00, 0x14, 0x4a, 0x58, 0x4c, 0x49, 0x10, 0x47, 0x47, 0x22,
        0xc5, 0x05, 0x21, 0x49, 0xaa, 0x16, 0xd4, 0x1a, 0x02, 0x5a, 0x33, 0x39,
        0x00, 0x00, 0x00, 0x2d, 0x4a, 0x58, 0x4c, 0x43, 0xff, 0x0a, 0x04, 0x00,
        0x60, 0x02, 0x20, 0x00, 0x00, 0x38, 0x10, 0x11, 0x04, 0x44, 0x06, 0x10,
        0x12, 0x10, 0x44, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x01,
        0x00, 0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x46, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00
    ]);
    if (typeof createImageBitmap !== 'undefined' && typeof Blob !== 'undefined') {
        try {
            const blob = new Blob([minimalJxl], { type: 'image/jxl' });
            const bm = await createImageBitmap(blob);
            bm.close();
            return true;
        }
        catch {
            return false;
        }
    }
    return false;
}
export async function getCapabilities() {
    const isBrowser = typeof window !== 'undefined' || typeof self !== 'undefined';
    const proc = globalThis.process;
    const isNode = !!proc?.versions?.node;
    let wasm = false;
    try {
        wasm = typeof WebAssembly !== 'undefined' && !!WebAssembly.compile;
    }
    catch { }
    const [wasmSimd, wasmThreads] = wasm
        ? await Promise.all([probeWasmSimd(), probeWasmThreads()])
        : [false, false];
    const wasmRelaxedSimd = wasmSimd && await probeRelaxedSimd();
    const crossOriginIsolated = typeof self !== 'undefined' && !!self.crossOriginIsolated;
    const sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
    const offscreenCanvas = typeof OffscreenCanvas !== 'undefined';
    const imageBitmap = typeof createImageBitmap !== 'undefined';
    let nativeJxlDecoder = false;
    if (isBrowser) {
        nativeJxlDecoder = await probeNativeJxl();
    }
    else if (isNode) {
        try {
            // @ts-ignore
            await import('jxl-native');
            nativeJxlDecoder = true;
        }
        catch {
            nativeJxlDecoder = false;
        }
    }
    const selectedWasmBuild = selectWasmBuild(wasm, wasmSimd, wasmThreads, sharedArrayBuffer, crossOriginIsolated, wasmRelaxedSimd);
    return {
        wasm,
        wasmSimd,
        wasmRelaxedSimd,
        wasmThreads,
        crossOriginIsolated,
        sharedArrayBuffer,
        offscreenCanvas,
        imageBitmap,
        nativeJxlDecoder,
        selectedWasmBuild,
        libjxlVersion: "0.10.2" // Placeholder, should be provided by build manifest ideally
    };
}
