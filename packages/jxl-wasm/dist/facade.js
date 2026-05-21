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
let modulePromise;
let testModuleFactory = null;
export function setJxlModuleFactoryForTesting(factory) {
    testModuleFactory = factory;
    modulePromise = undefined;
}
export function createDecoder(options) {
    return new LibjxlDecoder(options);
}
export function createEncoder(options) {
    return new LibjxlEncoder(options);
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
        this.chunkQueue.push(toUint8Array(chunk).slice());
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
        const dec = module._jxl_wasm_dec_create(fmtIndex);
        if (dec === 0)
            throw new Error("JXL progressive decoder creation failed");
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
            // Process chunks reactively as they arrive via chunkQueue
            while (!done && !this.cancelled) {
                await this.waitForQueueItem();
                if (this.cancelled)
                    return;
                const item = this.chunkQueue.shift();
                if (item === null) {
                    // Input closed — flush remaining
                    module._jxl_wasm_dec_close_input(dec);
                    const result = module._jxl_wasm_dec_push(dec, 0, 0);
                    done = result === 2;
                    break;
                }
                const ptr = module._malloc(item.byteLength);
                module.HEAPU8.set(item, ptr);
                const result = module._jxl_wasm_dec_push(dec, ptr, item.byteLength);
                module._free(ptr);
                if (result < 0)
                    throw new Error(`JXL decode error: ${module._jxl_wasm_dec_error(dec)}`);
                const w = module._jxl_wasm_dec_width(dec);
                const h = module._jxl_wasm_dec_height(dec);
                if (!headerEmitted && w > 0 && h > 0) {
                    headerEmitted = true;
                    yield { type: "header", info: buildInfo(w, h) };
                    if (this.options.progressionTarget === "header")
                        return;
                }
                if (result === 1) {
                    gotRealFlush = true;
                    const wrapped = takeAndWrap(module._jxl_wasm_dec_take_flushed(dec));
                    if (wrapped !== null) {
                        const { pixels, evInfo } = wrapped;
                        yield { type: "progress", stage: "dc", info: evInfo, pixels: pixels.data.slice(), format: fmt, pixelStride, ...(pixels.region === undefined ? {} : { region: pixels.region }) };
                        if (this.options.progressionTarget !== "final" && !this.options.emitEveryPass)
                            return;
                    }
                }
                else if (result === 2) {
                    done = true;
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
        const decoded = callDecode(module, concatBytes(allChunks), this.options.downsample, fmt);
        const pixels = applyRegionAndDownsample(decoded.data, decoded.width, decoded.height, this.options.region, this.options.downsample, bpc);
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
    constructor(options) {
        this.options = options;
    }
    pushPixels(chunk, region) {
        if (this.cancelled || this.finished)
            return;
        if (region !== undefined) {
            throw new CapabilityMissing("libjxl WASM facade does not support chunked region encode yet");
        }
        this.pixelChunks.push(toUint8Array(chunk).slice());
    }
    finish() {
        this.finished = true;
    }
    async *chunks() {
        await this.waitUntilFinished();
        if (this.cancelled)
            return;
        if (this.options.format === "rgba16" || this.options.format === "rgbaf32") {
            const module = await loadLibjxlModule();
            const encFn = this.options.format === "rgba16" ? "_jxl_wasm_encode_rgba16" : "_jxl_wasm_encode_rgbaf32";
            if (typeof module[encFn] !== "function") {
                throw new CapabilityMissing(`${this.options.format} encode requires a rebuilt WASM with multi-format bridge`);
            }
        }
        const bytesPerChannel = this.options.format === "rgbaf32" ? 4 : this.options.format === "rgba16" ? 2 : 1;
        const pixels = concatBytes(this.pixelChunks);
        const expectedBytes = this.options.width * this.options.height * 4 * bytesPerChannel;
        if (pixels.byteLength !== expectedBytes) {
            throw new Error(`JXL encode expected ${expectedBytes} bytes for ${this.options.format}, got ${pixels.byteLength}`);
        }
        const module = await loadLibjxlModule();
        const encoded = callEncode(module, pixels, this.options);
        yield encoded.data.slice();
        module._jxl_wasm_buffer_free(encoded.handle);
    }
    cancel(_reason) {
        this.cancelled = true;
    }
    dispose() {
        this.pixelChunks = [];
        this.cancelled = true;
    }
    waitUntilFinished() {
        return new Promise((resolve) => {
            const check = () => {
                if (this.finished || this.cancelled)
                    resolve();
                else
                    setTimeout(check, 1);
            };
            check();
        });
    }
}
async function loadLibjxlModule() {
    modulePromise ??= (testModuleFactory ?? loadGeneratedLibjxlModule)();
    return modulePromise;
}
async function loadGeneratedLibjxlModule() {
    const modulePath = "./jxl-core.scalar.js";
    const imported = await import(modulePath);
    const factory = imported.default;
    if (typeof factory !== "function") {
        throw new CapabilityMissing("Generated libjxl WASM module is missing default Emscripten factory");
    }
    const baseUrl = new URL("./", import.meta.url);
    const options = {
        locateFile: (path) => new URL(path, baseUrl).href,
    };
    // Emscripten web-only output lacks Node file loading; pre-read binary so it can instantiate in Bun/Node
    try {
        const fsMod = await import("node:fs/promises");
        const urlMod = await import("node:url");
        options["wasmBinary"] = await fsMod.readFile(urlMod.fileURLToPath(new URL("jxl-core.scalar.wasm", baseUrl)));
    }
    catch {
        // Not in Node/Bun, or WASM binary not found; Emscripten will load via fetch
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
        let handle;
        if (options.format === "rgba16" && module._jxl_wasm_encode_rgba16) {
            handle = module._jxl_wasm_encode_rgba16(ptr, options.width, options.height, distance, options.effort);
        }
        else if (options.format === "rgbaf32" && module._jxl_wasm_encode_rgbaf32) {
            handle = module._jxl_wasm_encode_rgbaf32(ptr, options.width, options.height, distance, options.effort);
        }
        else {
            handle = module._jxl_wasm_encode_rgba8(ptr, options.width, options.height, distance, options.effort);
        }
        return readBuffer(module, handle, "encode");
    }
    finally {
        module._free(ptr);
    }
}
function readBuffer(module, handle, operation) {
    if (handle === 0) {
        throw new Error(`JXL ${operation} failed`);
    }
    const dataPtr = module._jxl_wasm_buffer_data(handle);
    const size = module._jxl_wasm_buffer_size(handle);
    if (dataPtr === 0 || size === 0) {
        const code = module._jxl_wasm_buffer_error?.(handle) ?? 0;
        module._jxl_wasm_buffer_free(handle);
        throw new Error(`JXL ${operation} failed${code === 0 ? "" : ` (${code})`}`);
    }
    return {
        handle,
        data: module.HEAPU8.slice(dataPtr, dataPtr + size),
        width: module._jxl_wasm_buffer_width(handle),
        height: module._jxl_wasm_buffer_height(handle),
        bitsPerSample: normalizeBitsPerSample(module._jxl_wasm_buffer_bits_per_sample(handle)),
        hasAlpha: module._jxl_wasm_buffer_has_alpha(handle) !== 0,
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
    const stride = 4 * bytesPerChannel;
    const sourceRegion = normalizeRegion(region, width, height);
    const outWidth = Math.max(1, Math.ceil(sourceRegion.w / downsample));
    const outHeight = Math.max(1, Math.ceil(sourceRegion.h / downsample));
    const out = new Uint8Array(outWidth * outHeight * stride);
    for (let y = 0; y < outHeight; y++) {
        for (let x = 0; x < outWidth; x++) {
            const sx = sourceRegion.x + Math.min(sourceRegion.w - 1, x * downsample);
            const sy = sourceRegion.y + Math.min(sourceRegion.h - 1, y * downsample);
            const src = (sy * width + sx) * stride;
            const dst = (y * outWidth + x) * stride;
            for (let b = 0; b < stride; b++) {
                out[dst + b] = data[src + b] ?? (b === stride - 1 && bytesPerChannel === 1 ? 255 : 0);
            }
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