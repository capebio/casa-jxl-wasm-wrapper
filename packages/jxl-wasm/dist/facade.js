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
export function detectTier() {
    if (typeof process !== "undefined" && !!process.versions?.node)
        return "scalar";
    if (typeof WebAssembly === "undefined")
        return "scalar";
    const hasSimd = probeSimd();
    if (!hasSimd)
        return "scalar";
    const hasSab = typeof SharedArrayBuffer !== "undefined";
    const hasRelaxedSimd = probeRelaxedSimd();
    if (hasSab && hasRelaxedSimd)
        return "relaxed-simd-mt";
    if (hasSab)
        return "simd-mt";
    return "simd";
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
let modulePromise;
let testModuleFactory = null;
let _forcedTier = null;
export function setJxlModuleFactoryForTesting(factory) {
    testModuleFactory = factory;
    modulePromise = undefined;
}
/**
 * Override the WASM tier used on the next module load.
 * Pass null to restore auto-detection via detectTier().
 * Resets the cached module so the next encode/decode reloads with the new tier.
 */
export function setForcedTier(tier) {
    _forcedTier = tier;
    modulePromise = undefined;
}
export function getForcedTier() {
    return _forcedTier;
}
export function createDecoder(options) {
    return new LibjxlDecoder(options);
}
export function createEncoder(options) {
    return new LibjxlEncoder(options);
}
/** Start loading the WASM module immediately. Call during app startup to hide cold-start latency. */
export function preloadJxlModule() {
    void loadLibjxlModule();
}
class LibjxlDecoder {
    options;
    // null sentinel = input closed
    chunkQueue = [];
    wakeResolve = null;
    cancelled = false;
    constructor(options) {
        this.options = options;
    }
    push(chunk) {
        if (this.cancelled)
            return;
        // ArrayBuffer callers transfer ownership — no copy needed. Uint8Array callers may
        // reuse the underlying buffer, so we must copy.
        this.chunkQueue.push(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : toUint8Array(chunk).slice());
        this.wakeResolve?.();
        this.wakeResolve = null;
    }
    close() {
        if (this.cancelled)
            return;
        this.chunkQueue.push(null);
        this.wakeResolve?.();
        this.wakeResolve = null;
    }
    waitForQueueItem() {
        if (this.chunkQueue.length > 0)
            return Promise.resolve();
        return new Promise((resolve) => { this.wakeResolve = resolve; });
    }
    async *events() {
        try {
            if (this.cancelled)
                return;
            const module = await loadLibjxlModule();
            if (this.options.format !== "rgba8") {
                const decFn = this.options.format === "rgba16" ? "_jxl_wasm_decode_rgba16" : "_jxl_wasm_decode_rgbaf32";
                if (typeof module[decFn] !== "function") {
                    throw new CapabilityMissing(`${this.options.format} decode requires a rebuilt WASM with multi-format bridge`);
                }
            }
            if (typeof module._jxl_wasm_dec_create === "function") {
                yield* this.eventsProgressive(module);
            }
            else {
                yield* this.eventsOneShot(module);
            }
        }
        catch (error) {
            yield {
                type: "error",
                code: error instanceof CapabilityMissing ? error.code : "DecodeFailed",
                message: error instanceof Error ? error.message : String(error),
            };
        }
    }
    async *eventsProgressive(module) {
        const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : 0;
        const wantProgressive = (this.options.progressionTarget !== "final" || this.options.emitEveryPass) ? 1 : 0;
        const dec = module._jxl_wasm_dec_create(fmtIndex, wantProgressive);
        if (dec === 0)
            throw new Error("JXL progressive decoder creation failed");
        let chunkBufPtr = 0;
        let chunkBufCap = 0;
        try {
            let headerEmitted = false;
            let info;
            let gotRealFlush = false;
            let done = false;
            const buildInfo = (w, h) => {
                info ??= { width: w, height: h, bitsPerSample: 8, hasAlpha: true, hasAnimation: false, jpegReconstructionAvailable: false };
                return info;
            };
            const bpc = fmtIndex === 2 ? 4 : fmtIndex === 1 ? 2 : 1;
            const pixelStride = 4 * bpc;
            const fmt = this.options.format;
            const takeAndWrap = (handle) => {
                if (handle === 0)
                    return null;
                const buf = readBuffer(module, handle, "decode");
                module._jxl_wasm_buffer_free(handle);
                const pixels = applyRegionAndDownsample(buf.data, buf.width, buf.height, this.options.region, this.options.downsample, bpc);
                const evInfo = buildInfo(pixels.width, pixels.height);
                return { pixels, evInfo };
            };
            // IMPROVEMENT-7: Batch all queued data chunks into one WASM write per tick.
            // IMPROVEMENT-9: Guard dec_width/dec_height calls behind !headerEmitted — skip 2 WASM
            // FFI calls per chunk once the header has been emitted.
            while (!done && !this.cancelled) {
                if (this.chunkQueue.length === 0) {
                    await this.waitForQueueItem();
                    if (this.cancelled)
                        return;
                }
                // Collect pending byte count up to first close sentinel
                let batchBytes = 0;
                for (const it of this.chunkQueue) {
                    if (it === null)
                        break;
                    batchBytes += it.byteLength;
                }
                if (batchBytes > 0) {
                    if (batchBytes > chunkBufCap) {
                        if (chunkBufPtr !== 0)
                            module._free(chunkBufPtr);
                        chunkBufPtr = module._malloc(batchBytes);
                        chunkBufCap = batchBytes;
                    }
                    let woff = 0;
                    while (this.chunkQueue.length > 0 && this.chunkQueue[0] !== null) {
                        const chunk = this.chunkQueue.shift();
                        module.HEAPU8.set(chunk, chunkBufPtr + woff);
                        woff += chunk.byteLength;
                    }
                    const result = module._jxl_wasm_dec_push(dec, chunkBufPtr, batchBytes);
                    if (result < 0)
                        throw new Error(`JXL decode error: ${module._jxl_wasm_dec_error(dec)}`);
                    if (!headerEmitted) {
                        const w = module._jxl_wasm_dec_width(dec);
                        const h = module._jxl_wasm_dec_height(dec);
                        if (w > 0 && h > 0) {
                            headerEmitted = true;
                            yield { type: "header", info: buildInfo(w, h) };
                            if (this.options.progressionTarget === "header")
                                return;
                        }
                    }
                    if (result === 1) {
                        gotRealFlush = true;
                        const wrapped = takeAndWrap(module._jxl_wasm_dec_take_flushed(dec));
                        if (wrapped !== null) {
                            const { pixels, evInfo } = wrapped;
                            yield { type: "progress", stage: "dc", info: evInfo, pixels: pixels.data, format: fmt, pixelStride, ...(pixels.region === undefined ? {} : { region: pixels.region }) };
                            if (this.options.progressionTarget !== "final" && !this.options.emitEveryPass)
                                return;
                        }
                    }
                    else if (result === 2) {
                        done = true;
                    }
                }
                else if (this.chunkQueue.length > 0 && this.chunkQueue[0] === null) {
                    // Close sentinel — flush remaining decoder state
                    this.chunkQueue.shift();
                    module._jxl_wasm_dec_close_input(dec);
                    const result = module._jxl_wasm_dec_push(dec, 0, 0);
                    done = result === 2;
                    break;
                }
            }
            if (done) {
                const wrapped = takeAndWrap(module._jxl_wasm_dec_take_final(dec));
                if (wrapped !== null) {
                    const { pixels, evInfo } = wrapped;
                    if (!gotRealFlush && (this.options.emitEveryPass || this.options.progressionTarget === "dc" || this.options.progressionTarget === "pass")) {
                        const stage = this.options.progressionTarget === "dc" ? "dc" : "pass";
                        yield { type: "progress", stage, info: evInfo, pixels: pixels.data.slice(), format: fmt, pixelStride, ...(pixels.region === undefined ? {} : { region: pixels.region }) };
                        if (this.options.progressionTarget !== "final")
                            return;
                    }
                    yield { type: "final", info: evInfo, pixels: pixels.data, format: fmt, pixelStride, ...(pixels.region === undefined ? {} : { region: pixels.region }) };
                }
            }
        }
        finally {
            if (chunkBufPtr !== 0)
                module._free(chunkBufPtr);
            module._jxl_wasm_dec_free(dec);
        }
    }
    async *eventsOneShot(module) {
        // Drain all chunks until input closed
        const allChunks = [];
        while (!this.cancelled) {
            await this.waitForQueueItem();
            if (this.cancelled)
                return;
            const item = this.chunkQueue.shift();
            if (item === null)
                break;
            allChunks.push(item);
        }
        if (this.cancelled)
            return;
        const fmt = this.options.format;
        const bpc = fmt === "rgbaf32" ? 4 : fmt === "rgba16" ? 2 : 1;
        const pixelStride = 4 * bpc;
        const input = concatBytes(allChunks);
        allChunks.length = 0;
        const decoded = callDecode(module, input, this.options.downsample, fmt);
        // C++ already applied downsampling; decoded.width/height are the actual output dimensions.
        // Scale any region crop into the downsampled coordinate space and pass downsample=1.
        const ds = this.options.downsample;
        const scaledRegion = this.options.region !== null ? {
            x: Math.trunc(this.options.region.x / ds),
            y: Math.trunc(this.options.region.y / ds),
            w: Math.ceil(this.options.region.w / ds),
            h: Math.ceil(this.options.region.h / ds),
        } : null;
        const pixels = applyRegionAndDownsample(decoded.data, decoded.width, decoded.height, scaledRegion, 1, bpc);
        const info = {
            width: pixels.width,
            height: pixels.height,
            bitsPerSample: decoded.bitsPerSample,
            hasAlpha: decoded.hasAlpha,
            hasAnimation: false,
            jpegReconstructionAvailable: false,
        };
        yield { type: "header", info };
        if (this.options.progressionTarget === "header") {
            module._jxl_wasm_buffer_free(decoded.handle);
            return;
        }
        if (this.options.emitEveryPass || this.options.progressionTarget === "dc" || this.options.progressionTarget === "pass") {
            yield {
                type: "progress",
                stage: this.options.progressionTarget === "dc" ? "dc" : "pass",
                info,
                pixels: pixels.data.slice(),
                format: fmt,
                pixelStride,
                ...(pixels.region === undefined ? {} : { region: pixels.region }),
            };
            if (this.options.progressionTarget !== "final") {
                module._jxl_wasm_buffer_free(decoded.handle);
                return;
            }
        }
        yield {
            type: "final",
            info,
            pixels: pixels.data,
            format: fmt,
            pixelStride,
            ...(pixels.region === undefined ? {} : { region: pixels.region }),
        };
        module._jxl_wasm_buffer_free(decoded.handle);
    }
    cancel(_reason) {
        this.cancelled = true;
        this.wakeResolve?.();
        this.wakeResolve = null;
    }
    dispose() {
        this.chunkQueue = [];
        this.cancelled = true;
        this.wakeResolve?.();
        this.wakeResolve = null;
    }
}
class LibjxlEncoder {
    options;
    pixelChunks = [];
    finished = false;
    cancelled = false;
    finishResolve = null;
    constructor(options) {
        this.options = options;
    }
    pushPixels(chunk, region) {
        if (this.cancelled || this.finished)
            return;
        if (region !== undefined) {
            throw new CapabilityMissing("libjxl WASM facade does not support chunked region encode yet");
        }
        this.pixelChunks.push(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : toUint8Array(chunk).slice());
    }
    finish() {
        this.finished = true;
        this.finishResolve?.();
        this.finishResolve = null;
    }
    async *chunks() {
        await this.waitUntilFinished();
        if (this.cancelled)
            return;
        const module = await loadLibjxlModule();
        if (this.options.format === "rgba16" || this.options.format === "rgbaf32") {
            const encFn = this.options.format === "rgba16" ? "_jxl_wasm_encode_rgba16" : "_jxl_wasm_encode_rgbaf32";
            if (typeof module[encFn] !== "function") {
                throw new CapabilityMissing(`${this.options.format} encode requires a rebuilt WASM with multi-format bridge`);
            }
        }
        const bytesPerChannel = this.options.format === "rgbaf32" ? 4 : this.options.format === "rgba16" ? 2 : 1;
        const expectedBytes = this.options.width * this.options.height * 4 * bytesPerChannel;
        const totalBytes = this.pixelChunks.reduce((s, c) => s + c.byteLength, 0);
        if (totalBytes !== expectedBytes) {
            throw new Error(`JXL encode expected ${expectedBytes} bytes for ${this.options.format}, got ${totalBytes}`);
        }
        // IMPROVEMENT-6: Write pixel chunks directly into WASM heap — no concatBytes allocation.
        const ptr = module._malloc(totalBytes);
        try {
            let offset = 0;
            for (const chunk of this.pixelChunks) {
                module.HEAPU8.set(chunk, ptr + offset);
                offset += chunk.byteLength;
            }
            this.pixelChunks = [];
            const distance = this.options.distance ?? distanceFromQuality(this.options.quality);
            const hasAlpha = this.options.hasAlpha ? 1 : 0;
            // IMPROVEMENT-5: Sidecar thumbnails — yield smallest first for faster first-paint.
            if (this.options.sidecarSizes && this.options.sidecarSizes.length > 0
                && module._jxl_wasm_encode_rgba8_with_sidecars
                && module._jxl_wasm_buffer_next) {
                const sortedSizes = [...this.options.sidecarSizes].sort((a, b) => a - b);
                const dimsPtr = module._malloc(sortedSizes.length * 4);
                try {
                    // Write uint32[] into WASM heap (HEAPU32 if available, byte-by-byte otherwise)
                    if (module.HEAPU32) {
                        const base32 = dimsPtr >>> 2;
                        for (let i = 0; i < sortedSizes.length; i++)
                            module.HEAPU32[base32 + i] = (sortedSizes[i] ?? 0) >>> 0;
                    }
                    else {
                        for (let i = 0; i < sortedSizes.length; i++) {
                            const v = (sortedSizes[i] ?? 0) >>> 0;
                            module.HEAPU8[dimsPtr + i * 4] = v & 0xff;
                            module.HEAPU8[dimsPtr + i * 4 + 1] = (v >>> 8) & 0xff;
                            module.HEAPU8[dimsPtr + i * 4 + 2] = (v >>> 16) & 0xff;
                            module.HEAPU8[dimsPtr + i * 4 + 3] = (v >>> 24) & 0xff;
                        }
                    }
                    let handle = module._jxl_wasm_encode_rgba8_with_sidecars(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, dimsPtr, sortedSizes.length);
                    while (handle !== 0) {
                        // Read next BEFORE readBuffer — it may free `handle` on error.
                        const next = module._jxl_wasm_buffer_next(handle);
                        try {
                            const buf = readBuffer(module, handle, "encode");
                            // IMPROVEMENT-10: buf.data is already a copy (HEAPU8.slice in readBuffer).
                            yield buf.data;
                            module._jxl_wasm_buffer_free(handle);
                        }
                        catch (err) {
                            // handle was freed inside readBuffer; free remaining chain, then rethrow.
                            let cur = next;
                            while (cur !== 0) {
                                const nxt = module._jxl_wasm_buffer_next(cur);
                                module._jxl_wasm_buffer_free(cur);
                                cur = nxt;
                            }
                            throw err;
                        }
                        handle = next;
                    }
                }
                finally {
                    module._free(dimsPtr);
                }
            }
            else {
                // Standard single-image encode path
                let handle;
                if (this.options.format === "rgba16" && module._jxl_wasm_encode_rgba16) {
                    handle = module._jxl_wasm_encode_rgba16(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha);
                }
                else if (this.options.format === "rgbaf32" && module._jxl_wasm_encode_rgbaf32) {
                    handle = module._jxl_wasm_encode_rgbaf32(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha);
                }
                else {
                    handle = module._jxl_wasm_encode_rgba8(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha);
                }
                const encoded = readBuffer(module, handle, "encode");
                yield encoded.data; // IMPROVEMENT-10: already a copy from readBuffer — no .slice() needed
                module._jxl_wasm_buffer_free(encoded.handle);
            }
        }
        finally {
            module._free(ptr);
        }
    }
    cancel(_reason) {
        this.cancelled = true;
        this.finishResolve?.();
        this.finishResolve = null;
    }
    dispose() {
        this.pixelChunks = [];
        this.cancelled = true;
        this.finishResolve?.();
        this.finishResolve = null;
    }
    waitUntilFinished() {
        if (this.finished || this.cancelled)
            return Promise.resolve();
        return new Promise((resolve) => { this.finishResolve = resolve; });
    }
}
async function loadLibjxlModule() {
    modulePromise ??= (testModuleFactory ?? loadGeneratedLibjxlModule)();
    return modulePromise;
}
async function loadGeneratedLibjxlModule() {
    const tier = _forcedTier ?? detectTier();
    const modulePath = `./jxl-core.${tier}.js`;
    const imported = await import(modulePath);
    const factory = imported.default;
    if (typeof factory !== "function") {
        throw new CapabilityMissing("Generated libjxl WASM module is missing default Emscripten factory");
    }
    const baseUrl = new URL("./", import.meta.url);
    const options = {
        locateFile: (path) => new URL(path, baseUrl).href,
    };
    // Emscripten web output can fetch the .wasm in the browser. Pre-read the
    // binary only in Node/Bun so the same bundle works in both environments.
    if (typeof process !== "undefined" && !!process.versions?.node) {
        try {
            const fsMod = await import("node:fs/promises");
            const urlMod = await import("node:url");
            options["wasmBinary"] = await fsMod.readFile(urlMod.fileURLToPath(new URL(`jxl-core.${tier}.wasm`, baseUrl)));
        }
        catch {
            // Node/Bun but binary unavailable; let Emscripten resolve it another way.
        }
    }
    return await factory(options);
}
function callDecode(module, input, downsample, format) {
    const ptr = module._malloc(input.byteLength);
    try {
        module.HEAPU8.set(input, ptr);
        let handle;
        if (format === "rgba16" && module._jxl_wasm_decode_rgba16) {
            handle = module._jxl_wasm_decode_rgba16(ptr, input.byteLength, downsample);
        }
        else if (format === "rgbaf32" && module._jxl_wasm_decode_rgbaf32) {
            handle = module._jxl_wasm_decode_rgbaf32(ptr, input.byteLength, downsample);
        }
        else {
            handle = module._jxl_wasm_decode_rgba8(ptr, input.byteLength, downsample);
        }
        return readBuffer(module, handle, "decode");
    }
    finally {
        module._free(ptr);
    }
}
function callEncode(module, pixels, options) {
    const ptr = module._malloc(pixels.byteLength);
    try {
        module.HEAPU8.set(pixels, ptr);
        const distance = options.distance ?? distanceFromQuality(options.quality);
        const hasAlpha = options.hasAlpha ? 1 : 0;
        let handle;
        if (options.format === "rgba16" && module._jxl_wasm_encode_rgba16) {
            handle = module._jxl_wasm_encode_rgba16(ptr, options.width, options.height, distance, options.effort, hasAlpha);
        }
        else if (options.format === "rgbaf32" && module._jxl_wasm_encode_rgbaf32) {
            handle = module._jxl_wasm_encode_rgbaf32(ptr, options.width, options.height, distance, options.effort, hasAlpha);
        }
        else {
            handle = module._jxl_wasm_encode_rgba8(ptr, options.width, options.height, distance, options.effort, hasAlpha);
        }
        return readBuffer(module, handle, "encode");
    }
    finally {
        module._free(ptr);
    }
}
function readBuffer(module, handle, operation) {
    if (handle === 0)
        throw new Error(`JXL ${operation} failed`);
    // JxlWasmBuffer (WASM32): all fields are 4 bytes — data*, size_t, width, height, bits, has_alpha, error.
    // Read the entire struct in one contiguous HEAPU32 window instead of 6 separate FFI calls.
    let dataPtr, size, width, height, bitsVal, alphaVal, errorCode;
    const h32 = module.HEAPU32;
    // Only use the HEAPU32 direct-read fast path when `handle` looks like a real WASM heap
    // address: 4-byte aligned and above the minimum reserved region. Test fake modules use
    // sequential integers (1, 2, 3…) that would read garbage at the wrong HEAPU32 index.
    if (h32 && (handle & 3) === 0 && handle >= 16) {
        const b = handle >>> 2;
        dataPtr = h32[b] ?? 0;
        size = h32[b + 1] ?? 0;
        width = h32[b + 2] ?? 0;
        height = h32[b + 3] ?? 0;
        bitsVal = h32[b + 4] ?? 0;
        alphaVal = h32[b + 5] ?? 0;
        errorCode = h32[b + 6] ?? 0;
    }
    else {
        dataPtr = module._jxl_wasm_buffer_data(handle);
        size = module._jxl_wasm_buffer_size(handle);
        width = module._jxl_wasm_buffer_width(handle);
        height = module._jxl_wasm_buffer_height(handle);
        bitsVal = module._jxl_wasm_buffer_bits_per_sample(handle);
        alphaVal = module._jxl_wasm_buffer_has_alpha(handle);
        errorCode = module._jxl_wasm_buffer_error?.(handle) ?? 0;
    }
    if (dataPtr === 0 || size === 0) {
        module._jxl_wasm_buffer_free(handle);
        throw new Error(`JXL ${operation} failed${errorCode === 0 ? "" : ` (${errorCode})`}`);
    }
    return {
        handle,
        data: module.HEAPU8.slice(dataPtr, dataPtr + size),
        width,
        height,
        bitsPerSample: normalizeBitsPerSample(bitsVal),
        hasAlpha: alphaVal !== 0,
    };
}
function normalizeBitsPerSample(value) {
    if (value === 16 || value === 32)
        return value;
    return 8;
}
function distanceFromQuality(quality) {
    if (quality === null)
        return 1;
    return Math.max(0, Math.min(15, (100 - quality) / 6.67));
}
function applyRegionAndDownsample(data, width, height, region, downsample, bytesPerChannel = 1) {
    // IMPROVEMENT-8: Hottest path — no crop, no downsample — skip normalizeRegion entirely.
    if (downsample === 1 && region === null)
        return { data, width, height };
    const stride = 4 * bytesPerChannel;
    const sourceRegion = normalizeRegion(region, width, height);
    // Secondary fast path: region present but maps to full image after clamping
    if (downsample === 1 && sourceRegion.x === 0 && sourceRegion.y === 0 && sourceRegion.w === width && sourceRegion.h === height) {
        const result = { data, width, height };
        if (region !== null)
            result.region = { x: 0, y: 0, w: width, h: height };
        return result;
    }
    const outWidth = Math.max(1, Math.ceil(sourceRegion.w / downsample));
    const outHeight = Math.max(1, Math.ceil(sourceRegion.h / downsample));
    const out = new Uint8Array(outWidth * outHeight * stride);
    for (let y = 0; y < outHeight; y++) {
        for (let x = 0; x < outWidth; x++) {
            const sx = sourceRegion.x + Math.min(sourceRegion.w - 1, x * downsample);
            const sy = sourceRegion.y + Math.min(sourceRegion.h - 1, y * downsample);
            const src = (sy * width + sx) * stride;
            const dst = (y * outWidth + x) * stride;
            out.set(data.subarray(src, src + stride), dst);
        }
    }
    const result = {
        data: out,
        width: outWidth,
        height: outHeight,
    };
    if (region !== null) {
        result.region = { x: 0, y: 0, w: outWidth, h: outHeight };
    }
    return result;
}
function normalizeRegion(region, width, height) {
    if (region === null)
        return { x: 0, y: 0, w: width, h: height };
    const x = Math.max(0, Math.min(width - 1, Math.trunc(region.x)));
    const y = Math.max(0, Math.min(height - 1, Math.trunc(region.y)));
    const maxW = width - x;
    const maxH = height - y;
    return {
        x,
        y,
        w: Math.max(1, Math.min(maxW, Math.trunc(region.w))),
        h: Math.max(1, Math.min(maxH, Math.trunc(region.h))),
    };
}
function concatBytes(chunks) {
    if (chunks.length === 1)
        return chunks[0];
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}
function toUint8Array(value) {
    if (value instanceof Uint8Array)
        return value;
    return new Uint8Array(value);
}
//# sourceMappingURL=facade.js.map