let _cachedTier;
let _gpuAdapterPromise;
let _resetGen = 0;
export function _resetCache() {
    _resetGen++;
    _cachedTier = undefined;
    _capsPromise = undefined;
    // Clear GPU promise only when no call is pending; concurrent GPU probes are harmless but wasteful.
    // Incrementing _resetGen ensures any in-flight computeCapabilities discards its result.
    _gpuAdapterPromise = undefined;
}
function _isNode() {
    const proc = globalThis.process;
    return !!proc?.versions?.node;
}
function _coi() {
    return typeof self !== "undefined" && !!self.crossOriginIsolated;
}
export function canUseThreadedWasm(sharedArrayBuffer, crossOriginIsolated) {
    return sharedArrayBuffer && crossOriginIsolated;
}
// Hoisted probe byte arrays (C-5): avoid re-allocation on repeated calls (even though now memoized at getCapabilities).
const PROBE_SIMD_BYTES = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
    0x03, 0x02, 0x01, 0x00,
    0x0a, 0x08, 0x01, 0x06, 0x00,
    0x41, 0x00, 0xfd, 0x0f, 0x0b,
]);
const PROBE_THREADS_BYTES = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x05, 0x03, 0x01, 0x03, 0x01,
    0x0a, 0x0b, 0x01, 0x09, 0x00,
    0x41, 0x00, 0xfe, 0x10, 0x02, 0x00, 0x1a, 0x0b,
]);
const PROBE_RELAXED_BYTES = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x07, 0x01, 0x60, 0x02, 0x7b, 0x7b, 0x01, 0x7b,
    0x03, 0x02, 0x01, 0x00,
    0x0a, 0x0b, 0x01, 0x09, 0x00,
    0x20, 0x00, 0x20, 0x01, 0xfd, 0x80, 0x02, 0x0b,
]);
// Legacy Wasm-EH (try/catch_all): () -> () body = try(void) catch_all end end (CAP-8)
const PROBE_EH_BYTES = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x0a, 0x08, 0x01, 0x06, 0x00,
    0x06, 0x40, 0x19, 0x0b, 0x0b,
]);
function _probeSimd() {
    try {
        return WebAssembly.validate(PROBE_SIMD_BYTES);
    }
    catch {
        return false;
    }
}
function _probeWasmThreads() {
    try {
        return WebAssembly.validate(PROBE_THREADS_BYTES);
    }
    catch {
        return false;
    }
}
function _probeRelaxedSimd() {
    try {
        return WebAssembly.validate(PROBE_RELAXED_BYTES);
    }
    catch {
        return false;
    }
}
function _probeWasmExceptions() {
    try {
        return WebAssembly.validate(PROBE_EH_BYTES);
    }
    catch {
        return false;
    }
}
/**
 * Detect the WebAssembly tier supported by the environment.
 * Note: Returns "scalar" both when WebAssembly lacks SIMD and when WebAssembly is entirely absent;
 * consumers that must distinguish should use getCapabilities().selectedWasmBuild ("none" when no WASM).
 */
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
            const crossOriginIsolated = _coi();
            // Match jxl-wasm / worker tier pick: COI + SAB enable threaded builds; do not
            // require the wasm-threads validate probe (false on some Chrome builds that still run MT WASM).
            // Node has SAB unconditionally and no COI concept; browsers need COI for SAB to be usable. (CAP-2)
            const isBrowser = typeof window !== "undefined" || typeof self !== "undefined";
            const canDoMT = hasSab && (crossOriginIsolated || !isBrowser);
            if (canDoMT) {
                tier = _probeRelaxedSimd() ? "relaxed-simd-mt" : "simd-mt"; // (CAP-3 lazy check)
            }
            else {
                tier = "simd";
            }
        }
    }
    _cachedTier = tier;
    return tier;
}
/** Heuristic; thresholds untuned — benchmark before relying on it (CLAUDE.md rule). */
export function recommendedEffort(hwConcurrency) {
    const tier = detectTier();
    if (tier === "scalar")
        return 4;
    if (tier === "simd")
        return 6;
    const hwc = hwConcurrency ?? (typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? 0 : 0);
    // hwc===0 means unknown (hardwareConcurrency unavailable) — treat conservatively like low-core (CAP-7)
    return hwc > 0 && hwc > 2 ? 7 : 6;
}
/** Heuristic; thresholds untuned — benchmark before relying on it (CLAUDE.md rule). */
export function recommendedQualitySearch(hwConcurrency) {
    const t = detectTier();
    if (t === "scalar")
        return "none";
    const hwc = hwConcurrency ?? (typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? 0 : 0);
    // hwc===0 means unknown (hardwareConcurrency unavailable) — treat conservatively like low-core
    if (t === "simd" || hwc === 0 || hwc <= 2)
        return "fast";
    return "full";
}
/**
 * Race a promise against a timeout, resolving to `fallback` if `ms` elapses first.
 * Used to bound async capability probes so a single stalled probe cannot permanently
 * block the memoized getCapabilities() result (errors-2 / errors-8).
 */
function withTimeout(p, ms, fallback) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
/**
 * Probe for native JXL decoder support in the browser.
 */
async function probeNativeJxl() {
    // CAP-6: WebCodecs ImageDecoder fast path check
    const ID = globalThis.ImageDecoder;
    if (typeof ID?.isTypeSupported === "function") {
        try {
            if (await ID.isTypeSupported("image/jxl"))
                return true;
        }
        catch { /* fall through */ }
    }
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
            // errors-2: bound the probe — some environments may never resolve createImageBitmap for an
            // unrecognised MIME type. A single hung probe would otherwise permanently block _capsPromise.
            const bm = await withTimeout(createImageBitmap(blob), 500, null);
            if (!bm)
                return false;
            const ok = bm.width === 1 && bm.height === 1; // CAP-5: reject decoders that return garbage for 1x1
            bm.close();
            return ok;
        }
        catch {
            return false;
        }
    }
    return false;
}
let _capsPromise;
export function getCapabilities() {
    return (_capsPromise ??= computeCapabilities(_resetGen));
}
async function computeCapabilities(gen) {
    const isBrowser = typeof window !== 'undefined' || typeof self !== 'undefined';
    const isNode = _isNode();
    let wasm = false;
    try {
        wasm = typeof WebAssembly !== 'undefined' && !!WebAssembly.compile;
    }
    catch (e) {
        // Silently treat as no-wasm; this is expected under strict CSP (C-9).
        // Unexpected errors (SecurityError, TypeError) are indistinguishable here — see errors-7 for a
        // future diagnostic channel proposal.
    }
    // C-3/performance-1: call detectTier() first so it caches _cachedTier before the individual probes below.
    // This prevents _probeSimd()/_probeRelaxedSimd() from running twice when wasm=true.
    const selectedWasmBuild = wasm ? detectTier() : "none";
    let wasmSimd = false;
    let wasmThreads = false;
    let wasmRelaxedSimd = false;
    let wasmExceptions = false;
    if (wasm) {
        // C-5: call the direct _probe* sync functions (wrappers deleted).
        // detectTier() already ran these; results are synchronous constants so re-calling is safe and cheap.
        wasmSimd = _probeSimd();
        wasmThreads = _probeWasmThreads();
        wasmRelaxedSimd = wasmSimd && _probeRelaxedSimd();
        wasmExceptions = _probeWasmExceptions();
    }
    const crossOriginIsolated = _coi();
    const sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
    const offscreenCanvas = typeof OffscreenCanvas !== 'undefined';
    const imageBitmap = typeof createImageBitmap !== 'undefined';
    const imageDecoder = typeof globalThis.ImageDecoder !== "undefined";
    // C-7: cheap additive platform probes; every navigator access guarded
    const webgpu = typeof navigator !== "undefined" && !!navigator?.gpu;
    const webnn = typeof navigator !== "undefined" && !!navigator?.ml;
    const hardwareConcurrency = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 0) : 0;
    const deviceMemory = typeof navigator !== "undefined" ? (navigator.deviceMemory ?? null) : null;
    let nativeJxlDecoder = false;
    if (isNode) {
        try {
            // C-1: real name from packages/jxl-native/package.json
            // @ts-ignore
            await import('@casabio/jxl-native');
            nativeJxlDecoder = true;
        }
        catch (e) {
            // Only swallow "package not installed" errors. Other failures (SyntaxError, ABI mismatch, I/O)
            // indicate a broken installation and should surface — re-throw them.
            const code = e?.code ?? "";
            if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND")
                throw e;
            /* fall through to browser probe if also browser-ish */
        }
    }
    if (!nativeJxlDecoder && isBrowser) {
        nativeJxlDecoder = await probeNativeJxl();
    }
    // concurrency-1: if _resetCache() was called while we were awaiting, our result is stale.
    // Discard it so the next getCapabilities() call starts a fresh computation.
    if (gen !== _resetGen) {
        _capsPromise = undefined;
        return getCapabilities();
    }
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
        libjxlVersion: null, // TODO(packages/jxl-wasm/scripts/build.mjs): emit consumable libjxl version const (build-manifest has commit/tag but no generated version.ts / export; C-6 requires build-script edit + approval)
        webgpu,
        webnn,
        hardwareConcurrency,
        deviceMemory,
        imageDecoder,
        wasmExceptions
    };
}
/** Lazy: navigator.gpu presence (caps.webgpu) ≠ usable adapter. Memoized. */
export function probeWebGpuAdapter() {
    return (_gpuAdapterPromise ??= (async () => {
        try {
            const gpu = navigator?.gpu;
            if (!gpu)
                return false;
            return (await gpu.requestAdapter()) !== null;
        }
        catch {
            return false;
        }
    })());
}
