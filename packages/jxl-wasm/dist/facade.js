function normalizeDecoderOptions(options) {
    return {
        ...options,
        region: options.region ?? null,
        downsample: options.downsample ?? 1,
        targetWidth: options.targetWidth ?? null,
        targetHeight: options.targetHeight ?? null,
        fitMode: options.fitMode ?? null,
    };
}
function resolveEncoderBridgeSettings(options) {
    if (!options.progressive) {
        return { progressiveDc: 0, progressiveAc: 0, qProgressiveAc: 0, buffering: options.chunked ? 2 : 0 };
    }
    const acEnabled = options.progressiveFlavor === "ac" || (options.progressiveFlavor !== "dc" && options.previewFirst);
    return {
        progressiveDc: 1,
        progressiveAc: acEnabled ? 1 : 0,
        qProgressiveAc: acEnabled ? 1 : 0,
        buffering: options.chunked ? 2 : 0,
    };
}
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
    if (_cachedDetectedTier !== undefined)
        return _cachedDetectedTier;
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
    _cachedDetectedTier = tier;
    return tier;
}
/**
 * Returns a sensible default effort level for the current WASM tier.
 * Scalar workers get a lower effort to avoid blocking the thread; SIMD-MT
 * workers get full effort since they can use parallel libjxl codepaths.
 */
export function recommendedEffort() {
    const tier = detectTier();
    if (tier === "scalar")
        return 4;
    if (tier === "simd")
        return 6;
    return 7; // simd-mt, relaxed-simd-mt
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
let _cachedDetectedTier;
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
    return new LibjxlDecoder(normalizeDecoderOptions(options));
}
export function createEncoder(options) {
    return new LibjxlEncoder(options);
}
/**
 * Losslessly transcode a JPEG file to JXL without pixel expansion.
 * The resulting JXL embeds the original JPEG bitstream for round-trip fidelity.
 * Requires a WASM build that includes the #15 bridge (jxl_wasm_transcode_jpeg_to_jxl).
 */
export async function transcodeJpegToJxl(jpeg) {
    const module = await loadLibjxlModule();
    if (!getCapabilities(module).jpegTranscode) {
        throw new CapabilityMissing("JPEG→JXL transcode requires a rebuilt WASM with transcode bridge");
    }
    const view = copyOrBorrowInput(jpeg, false);
    const ptr = module._malloc(view.byteLength);
    try {
        module.HEAPU8.set(view, ptr);
        const handle = module._jxl_wasm_transcode_jpeg_to_jxl(ptr, view.byteLength);
        return takeBuffer(module, handle, "transcode").data;
    }
    finally {
        module._free(ptr);
    }
}
/** Start loading the WASM module immediately. Call during app startup to hide cold-start latency. */
export function preloadJxlModule() {
    void loadLibjxlModule();
}
export function getWrapperCapabilities() {
    return {
        regionDecode: true,
        exactSizeDecode: true,
        progressiveRegionDecode: false,
        tileAlignedRegionDecode: false,
        arbitraryRegionDecode: true,
        availableDownsampleFactors: [1, 2, 4, 8],
    };
}
export function getDecodeGridInfo() {
    return {};
}
export function decodeViewport(options) {
    return createDecoder({
        format: options.format,
        region: options.region ?? null,
        downsample: pickDownsample(options),
        progressionTarget: options.progressionTarget ?? "final",
        emitEveryPass: options.emitEveryPass ?? false,
        preserveIcc: options.preserveIcc ?? true,
        preserveMetadata: options.preserveMetadata ?? false,
        targetWidth: options.targetWidth ?? null,
        targetHeight: options.targetHeight ?? null,
        fitMode: options.fitMode ?? null,
    });
}
export function decodeRegionLod(options) {
    return createDecoder({
        format: options.format,
        region: options.region ?? null,
        downsample: 1,
        progressionTarget: "final",
        emitEveryPass: false,
        preserveIcc: false,
        preserveMetadata: false,
        targetWidth: options.targetLongEdge,
        targetHeight: options.targetLongEdge,
        fitMode: "contain",
    });
}
export function normalizedToPixelExtent(norm, imageWidth, imageHeight) {
    return {
        x: Math.round(norm.x * imageWidth),
        y: Math.round(norm.y * imageHeight),
        w: Math.max(1, Math.round(norm.w * imageWidth)),
        h: Math.max(1, Math.round(norm.h * imageHeight)),
    };
}
export function pixelToNormalizedExtent(region, imageWidth, imageHeight) {
    return {
        x: region.x / imageWidth,
        y: region.y / imageHeight,
        w: region.w / imageWidth,
        h: region.h / imageHeight,
    };
}
// Shared zero-length sentinel used to null out pixelChunks slots during progressive WASM copy.
const EMPTY_U8 = new Uint8Array(0);
class LibjxlDecoder {
    options;
    // null sentinel = input closed
    chunkQueue = [];
    readIndex = 0;
    queuedBytes = 0;
    wakeResolve = null;
    cancelled = false;
    closed = false;
    eventsStarted = false;
    constructor(options) {
        this.options = options;
    }
    push(chunk) {
        if (this.cancelled || this.closed)
            return;
        // ArrayBuffer callers (primary path: worker receives transferred chunks via postMessage)
        // are always zero-copy — new Uint8Array(ab) is a view, not a copy. Uint8Array callers
        // may reuse the underlying buffer, so we copy unless copyInput=false.
        const view = copyOrBorrowInput(chunk, this.options.copyInput !== false);
        this.queuedBytes += view.byteLength;
        this.chunkQueue.push(view);
        this.wake();
    }
    close() {
        if (this.cancelled || this.closed)
            return;
        this.closed = true;
        this.chunkQueue.push(null);
        this.wake();
    }
    wake() {
        const resolve = this.wakeResolve;
        if (resolve !== null) {
            this.wakeResolve = null;
            resolve();
        }
    }
    waitForQueueItem() {
        if (this.chunkQueue.length > this.readIndex)
            return Promise.resolve();
        return new Promise((resolve) => { this.wakeResolve = resolve; });
    }
    compactQueue() {
        if (this.readIndex > 64 && this.readIndex * 2 > this.chunkQueue.length) {
            this.chunkQueue = this.chunkQueue.slice(this.readIndex);
            this.readIndex = 0;
        }
    }
    async *events() {
        if (this.eventsStarted) {
            yield { type: "error", code: "InvalidState", message: "Decoder events() may only be consumed once." };
            return;
        }
        this.eventsStarted = true;
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
            if (getCapabilities(module).progressiveDecode) {
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
        finally {
            this.chunkQueue = [];
            this.readIndex = 0;
            this.queuedBytes = 0;
        }
    }
    async *eventsProgressive(module) {
        const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : 0;
        const wantProgressive = (this.options.progressionTarget !== "final" || this.options.emitEveryPass) ? 1 : 0;
        const dec = module._jxl_wasm_dec_create(fmtIndex, wantProgressive);
        if (dec === 0)
            throw new Error("JXL progressive decoder creation failed");
        // Cache bridge fn refs once — avoids repeated property lookup on module per iteration.
        const decPush = module._jxl_wasm_dec_push;
        const decWidth = module._jxl_wasm_dec_width;
        const decHeight = module._jxl_wasm_dec_height;
        const decError = module._jxl_wasm_dec_error;
        const decTakeFlushed = module._jxl_wasm_dec_take_flushed;
        const decTakeFinal = module._jxl_wasm_dec_take_final;
        const decCloseInput = module._jxl_wasm_dec_close_input;
        const decFree = module._jxl_wasm_dec_free;
        let chunkBufPtr = 0;
        let chunkBufCap = 0;
        try {
            let headerEmitted = false;
            let info;
            let gotRealFlush = false;
            let done = false;
            // Count flushed intermediate frames: first flush is the DC pass,
            // subsequent flushes are AC refinement passes.
            let flushCount = 0;
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
                const buf = takeBuffer(module, handle, "decode");
                const pixels = applyRegionAndDownsample(buf.data, buf.width, buf.height, this.options.region ?? null, this.options.downsample ?? 1, bpc);
                // When ROI/downsample crops the frame, pixels.width/height differ from full image dims.
                // buildInfo memoizes on first call (full dims from header), so we must not pass it
                // cropped dims — it would return the already-memoized full-dim object regardless.
                // Instead, derive evInfo from the base info with actual pixel dimensions.
                const baseInfo = buildInfo(buf.width, buf.height);
                const evInfo = (pixels.width !== buf.width || pixels.height !== buf.height)
                    ? { ...baseInfo, width: pixels.width, height: pixels.height }
                    : baseInfo;
                return { pixels, evInfo };
            };
            const hasRegion = this.options.region != null;
            const onMetric = this.options.onMetric;
            let fallbackMetricEmitted = false;
            // IMPROVEMENT-7: Batch all queued data chunks into one WASM write per tick.
            // IMPROVEMENT-9: Guard dec_width/dec_height calls behind !headerEmitted — skip 2 WASM
            // FFI calls per chunk once the header has been emitted.
            while (!done && !this.cancelled) {
                if (this.chunkQueue.length <= this.readIndex) {
                    await this.waitForQueueItem();
                    if (this.cancelled)
                        return;
                }
                // Pending byte count maintained incrementally — no scan needed.
                const batchBytes = this.queuedBytes;
                if (batchBytes > 0) {
                    if (batchBytes > chunkBufCap) {
                        if (chunkBufPtr !== 0)
                            module._free(chunkBufPtr);
                        chunkBufPtr = module._malloc(batchBytes);
                        chunkBufCap = batchBytes;
                    }
                    let woff = 0;
                    while (this.chunkQueue.length > this.readIndex && this.chunkQueue[this.readIndex] !== null) {
                        const chunk = this.chunkQueue[this.readIndex];
                        // Null slot immediately so GC can reclaim the Uint8Array after the HEAPU8.set copy.
                        this.chunkQueue[this.readIndex++] = null;
                        this.queuedBytes -= chunk.byteLength;
                        module.HEAPU8.set(chunk, chunkBufPtr + woff);
                        woff += chunk.byteLength;
                    }
                    this.compactQueue();
                    const result = decPush(dec, chunkBufPtr, batchBytes);
                    if (result < 0)
                        throw new Error(`JXL decode error: ${decError(dec)}`);
                    if (!headerEmitted) {
                        const w = decWidth(dec);
                        const h = decHeight(dec);
                        if (w > 0 && h > 0) {
                            headerEmitted = true;
                            yield { type: "header", info: buildInfo(w, h) };
                            if (this.options.progressionTarget === "header")
                                return;
                        }
                    }
                    if (result === 1) {
                        gotRealFlush = true;
                        flushCount++;
                        const stage = flushCount === 1 ? "dc" : "pass";
                        const wrapped = takeAndWrap(decTakeFlushed(dec));
                        if (wrapped !== null) {
                            const { pixels: rawPixels, evInfo } = wrapped;
                            // P4: emit region_fallback_full_frame metric once when progressive + region active.
                            if (hasRegion && !fallbackMetricEmitted && onMetric) {
                                onMetric("region_fallback_full_frame", 1);
                                fallbackMetricEmitted = true;
                            }
                            // P1: apply bilinear resize if target dims set.
                            const targetW = this.options.targetWidth;
                            const targetH = this.options.targetHeight;
                            const fitMode = this.options.fitMode ?? "contain";
                            let outPixels = rawPixels;
                            if (targetW != null && targetH != null && targetW > 0 && targetH > 0) {
                                const resized = applyTargetResize(rawPixels.data, rawPixels.width, rawPixels.height, targetW, targetH, fitMode, bpc);
                                outPixels = { data: resized.data, width: resized.width, height: resized.height, ...(rawPixels.region !== undefined ? { region: rawPixels.region } : {}) };
                            }
                            const outInfo = (outPixels.width !== evInfo.width || outPixels.height !== evInfo.height)
                                ? { ...evInfo, width: outPixels.width, height: outPixels.height }
                                : evInfo;
                            const ev = {
                                type: "progress",
                                stage,
                                info: outInfo,
                                pixels: outPixels.data,
                                format: fmt,
                                pixelStride,
                                sourceScale: this.options.downsample ?? 1,
                                progressiveRegion: false,
                            };
                            if (hasRegion)
                                ev.regionFallback = "full-frame-then-crop";
                            if (outPixels.region !== undefined)
                                ev.region = outPixels.region;
                            yield ev;
                            if (this.options.progressionTarget !== "final" && !this.options.emitEveryPass)
                                return;
                        }
                    }
                    else if (result === 2) {
                        done = true;
                    }
                }
                else if (this.chunkQueue.length > this.readIndex && this.chunkQueue[this.readIndex] === null) {
                    // Close sentinel — flush remaining decoder state
                    this.readIndex++;
                    this.compactQueue();
                    decCloseInput(dec);
                    const result = decPush(dec, 0, 0);
                    // result < 0 means libjxl signalled an error (e.g. truncated stream).
                    // Without this throw, the generator returns silently with no terminal
                    // event, leaving the decode session permanently unresolved on the main thread.
                    if (result < 0)
                        throw new Error(`JXL decode error: ${decError(dec)}`);
                    done = result === 2;
                    break;
                }
            }
            if (done) {
                const wrapped = takeAndWrap(decTakeFinal(dec));
                if (wrapped !== null) {
                    const { pixels: rawPixels, evInfo } = wrapped;
                    // P5: emit decode metrics on final frame.
                    if (onMetric) {
                        onMetric("decode_scale_used", this.options.downsample ?? 1);
                        // info is memoized full-frame dims from buildInfo; fall back to rawPixels if header not yet seen.
                        const fullW = info?.width ?? rawPixels.width;
                        const fullH = info?.height ?? rawPixels.height;
                        onMetric("source_pixels_decoded", fullW * fullH);
                        if (hasRegion && this.options.region != null) {
                            onMetric("decode_region_area", this.options.region.w * this.options.region.h);
                        }
                    }
                    // P1: apply bilinear resize if target dims set.
                    const targetW = this.options.targetWidth;
                    const targetH = this.options.targetHeight;
                    const fitMode = this.options.fitMode ?? "contain";
                    let outPixels = rawPixels;
                    if (targetW != null && targetH != null && targetW > 0 && targetH > 0) {
                        const resized = applyTargetResize(rawPixels.data, rawPixels.width, rawPixels.height, targetW, targetH, fitMode, bpc);
                        outPixels = { data: resized.data, width: resized.width, height: resized.height, ...(rawPixels.region !== undefined ? { region: rawPixels.region } : {}) };
                    }
                    const outInfo = (outPixels.width !== evInfo.width || outPixels.height !== evInfo.height)
                        ? { ...evInfo, width: outPixels.width, height: outPixels.height }
                        : evInfo;
                    if (!gotRealFlush && (this.options.emitEveryPass || this.options.progressionTarget === "dc" || this.options.progressionTarget === "pass")) {
                        const stage = this.options.progressionTarget === "dc" ? "dc" : "pass";
                        const ev = {
                            type: "progress",
                            stage,
                            info: outInfo,
                            pixels: this.options.progressionTarget !== "final" ? outPixels.data : outPixels.data.slice(),
                            format: fmt,
                            pixelStride,
                            sourceScale: this.options.downsample ?? 1,
                            progressiveRegion: false,
                        };
                        if (hasRegion)
                            ev.regionFallback = "full-frame-then-crop";
                        if (outPixels.region !== undefined)
                            ev.region = outPixels.region;
                        yield ev;
                        if (this.options.progressionTarget !== "final")
                            return;
                    }
                    const ev = {
                        type: "final",
                        info: outInfo,
                        pixels: outPixels.data,
                        format: fmt,
                        pixelStride,
                        sourceScale: this.options.downsample ?? 1,
                        progressiveRegion: false,
                    };
                    if (hasRegion)
                        ev.regionFallback = "full-frame-then-crop";
                    if (outPixels.region !== undefined)
                        ev.region = outPixels.region;
                    yield ev;
                }
            }
        }
        finally {
            if (chunkBufPtr !== 0)
                module._free(chunkBufPtr);
            decFree(dec);
        }
    }
    async *eventsOneShot(module) {
        // Drain all chunks until input closed
        const allChunks = [];
        while (!this.cancelled) {
            await this.waitForQueueItem();
            if (this.cancelled)
                return;
            const item = this.chunkQueue[this.readIndex++];
            this.compactQueue();
            if (item === null || item === undefined)
                break;
            this.queuedBytes -= item.byteLength;
            allChunks.push(item);
        }
        if (this.cancelled)
            return;
        const fmt = this.options.format;
        const bpc = fmt === "rgbaf32" ? 4 : fmt === "rgba16" ? 2 : 1;
        const pixelStride = 4 * bpc;
        // Write all chunks directly into a single WASM heap buffer — no intermediate JS allocation.
        const totalSize = allChunks.reduce((s, c) => s + c.byteLength, 0);
        const inputPtr = module._malloc(totalSize);
        let decodedHandle = 0;
        try {
            let woff = 0;
            for (const chunk of allChunks) {
                module.HEAPU8.set(chunk, inputPtr + woff);
                woff += chunk.byteLength;
            }
            allChunks.length = 0;
            // #10: pass region to callDecodeFromPtr — if C++ region bridge present it crops in WASM,
            // avoiding shipping full-image pixels to JS. JS fallback still works via applyRegionAndDownsample.
            const regionForDecode = this.options.region;
            const cppDidCrop = regionForDecode !== null && ((fmt === "rgba8" && !!module._jxl_wasm_decode_rgba8_region) ||
                (fmt === "rgba16" && !!module._jxl_wasm_decode_rgba16_region) ||
                (fmt === "rgbaf32" && !!module._jxl_wasm_decode_rgbaf32_region));
            const decoded = callDecodeFromPtr(module, inputPtr, totalSize, this.options.downsample ?? 1, fmt, cppDidCrop ? regionForDecode : null);
            decodedHandle = decoded.handle;
            // If C++ did the crop, decoded.width/height already reflect the region; no further JS crop.
            // Otherwise, scale region into downsampled coords and apply in JS.
            const ds = this.options.downsample ?? 1;
            const scaledRegion = (!cppDidCrop && regionForDecode != null) ? {
                x: Math.trunc(regionForDecode.x / ds),
                y: Math.trunc(regionForDecode.y / ds),
                w: Math.ceil(regionForDecode.w / ds),
                h: Math.ceil(regionForDecode.h / ds),
            } : null;
            const pixels = applyRegionAndDownsample(decoded.data, decoded.width, decoded.height, scaledRegion, 1, bpc);
            // C++ crop path skips applyRegionAndDownsample's region-setter; restore it to match JS path.
            if (cppDidCrop)
                pixels.region = { x: 0, y: 0, w: pixels.width, h: pixels.height };
            // P1: apply bilinear resize to exact target size if requested.
            const targetW = this.options.targetWidth;
            const targetH = this.options.targetHeight;
            const fitMode = this.options.fitMode ?? "contain";
            let outPixels = pixels;
            if (targetW != null && targetH != null && targetW > 0 && targetH > 0) {
                const resized = applyTargetResize(pixels.data, pixels.width, pixels.height, targetW, targetH, fitMode, bpc);
                outPixels = { data: resized.data, width: resized.width, height: resized.height, ...(pixels.region !== undefined ? { region: pixels.region } : {}) };
            }
            const info = {
                width: outPixels.width,
                height: outPixels.height,
                bitsPerSample: decoded.bitsPerSample,
                hasAlpha: decoded.hasAlpha,
                hasAnimation: false,
                jpegReconstructionAvailable: false,
            };
            // P5: emit decode metrics via onMetric callback.
            const actualScale = this.options.downsample ?? 1;
            const onMetric = this.options.onMetric;
            if (onMetric) {
                onMetric("decode_scale_used", actualScale);
                onMetric("source_pixels_decoded", decoded.width * decoded.height);
                if (this.options.region != null) {
                    onMetric("decode_region_area", this.options.region.w * this.options.region.h);
                }
            }
            yield { type: "header", info };
            if (this.options.progressionTarget === "header")
                return;
            if (this.options.emitEveryPass || this.options.progressionTarget === "dc" || this.options.progressionTarget === "pass") {
                const ev = {
                    type: "progress",
                    stage: this.options.progressionTarget === "dc" ? "dc" : "pass",
                    info,
                    pixels: this.options.progressionTarget !== "final" ? outPixels.data : outPixels.data.slice(),
                    format: fmt,
                    pixelStride,
                    sourceScale: actualScale,
                    progressiveRegion: false,
                };
                if (outPixels.region !== undefined)
                    ev.region = outPixels.region;
                yield ev;
                if (this.options.progressionTarget !== "final")
                    return;
            }
            const ev = {
                type: "final",
                info,
                pixels: outPixels.data,
                format: fmt,
                pixelStride,
                sourceScale: actualScale,
                progressiveRegion: false,
            };
            if (outPixels.region !== undefined)
                ev.region = outPixels.region;
            yield ev;
        }
        finally {
            module._free(inputPtr);
            if (decodedHandle !== 0)
                module._jxl_wasm_buffer_free(decodedHandle);
        }
    }
    cancel(_reason) {
        this.cancelled = true;
        this.wake();
    }
    dispose() {
        this.chunkQueue = [];
        this.readIndex = 0;
        this.queuedBytes = 0;
        this.cancelled = true;
        this.wake();
    }
}
class LibjxlEncoder {
    options;
    // Buffered path fallback (used when streaming input not available or sidecars active)
    pixelChunks = [];
    finished = false;
    cancelled = false;
    finishResolve = null;
    sortedSidecarSizes;
    encodeStats = null;
    chunksStarted = false;
    queuedPixelBytes = 0;
    pixelByteTotal;
    // #16: Streaming input — module loaded on first pushPixels, state allocated immediately.
    // JS never accumulates pixelChunks[] when this path is active.
    wasmModule = null;
    wasmEncState = 0;
    streamingInputActive = false;
    moduleInitPromise = null;
    pendingPushPromise = Promise.resolve();
    pendingPushError = null;
    constructor(options) {
        this.options = options;
        this.sortedSidecarSizes = options.sidecarSizes ? [...options.sidecarSizes].sort((a, b) => a - b) : [];
        this.pixelByteTotal = expectedPixelBytes(options.width, options.height, options.format);
    }
    async pushPixels(chunk, region) {
        if (this.cancelled || this.finished)
            return;
        if (region !== undefined) {
            throw new CapabilityMissing("libjxl WASM facade does not support chunked region encode yet");
        }
        const view = copyOrBorrowInput(chunk, this.options.copyInput !== false);
        if (this.queuedPixelBytes + view.byteLength > this.pixelByteTotal) {
            throw new Error(`JXL encode received too many pixel bytes: expected ${this.pixelByteTotal}, got at least ${this.queuedPixelBytes + view.byteLength}`);
        }
        this.queuedPixelBytes += view.byteLength;
        const pushTask = this.pendingPushPromise.then(async () => {
            const module = await this.ensureModule();
            if (this.cancelled)
                return;
            if (this.streamingInputActive) {
                // #16: copy chunk into WASM pixel buffer; JS ref can be discarded immediately after.
                const ptr = module._malloc(view.byteLength);
                try {
                    module.HEAPU8.set(view, ptr);
                    const rc = module._jxl_wasm_enc_push_chunk(this.wasmEncState, ptr, view.byteLength);
                    if (rc !== 0)
                        throw new Error(`JXL streaming pixel push failed (${rc})`);
                }
                finally {
                    module._free(ptr);
                }
            }
            else {
                this.pixelChunks.push(view);
            }
        });
        this.pendingPushPromise = pushTask.catch((error) => {
            this.pendingPushError = error;
        });
        await pushTask;
    }
    ensureModule() {
        this.moduleInitPromise ??= this.initModule();
        return this.moduleInitPromise;
    }
    async initModule() {
        const module = await loadLibjxlModule();
        this.wasmModule = module;
        if (this.cancelled)
            return module;
        const caps = getCapabilities(module);
        // Use streaming input only when sidecars are not requested — sidecar path takes
        // a complete RGBA8 pixel pointer and cannot be fed incrementally.
        // Also skip streaming input when metadata (ICC/EXIF/XMP) is present: the
        // streaming input path calls enc_finish → EncodeRgba which has no metadata
        // parameter. Fall back to the buffered path which routes through
        // encode_rgba8_with_metadata so metadata is preserved for all pixel formats.
        const wantSidecars = this.sortedSidecarSizes.length > 0 && caps.sidecars;
        const hasMetadataOpts = this.options.iccProfile !== null || this.options.exif !== null || this.options.xmp !== null;
        if (!wantSidecars && !hasMetadataOpts && caps.streamingInput) {
            const distance = this.options.distance ?? distanceFromQuality(this.options.quality);
            const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : 0;
            const { progressiveDc, progressiveAc, qProgressiveAc, buffering } = resolveEncoderBridgeSettings(this.options);
            this.wasmEncState = module._jxl_wasm_enc_create_image(this.options.width, this.options.height, distance, this.options.effort, fmtIndex, this.options.hasAlpha ? 1 : 0, progressiveDc, progressiveAc, qProgressiveAc, buffering);
            if (this.wasmEncState === 0)
                throw new Error("JXL streaming encoder: pixel buffer allocation failed");
            this.streamingInputActive = true;
        }
        return module;
    }
    finish() {
        this.finished = true;
        this.finishResolve?.();
        this.finishResolve = null;
    }
    async *chunks() {
        if (this.chunksStarted) {
            throw new Error("Encoder chunks() may only be consumed once.");
        }
        this.chunksStarted = true;
        await this.waitUntilFinished();
        if (this.cancelled)
            return;
        await this.pendingPushPromise;
        if (this.pendingPushError !== null)
            throw this.pendingPushError;
        // Module may not be loaded yet if no pixels were pushed (zero-byte edge case).
        const module = this.wasmModule ?? await loadLibjxlModule();
        if (this.options.format === "rgba16" || this.options.format === "rgbaf32") {
            const encFn = this.options.format === "rgba16" ? "_jxl_wasm_encode_rgba16" : "_jxl_wasm_encode_rgbaf32";
            if (typeof module[encFn] !== "function") {
                throw new CapabilityMissing(`${this.options.format} encode requires a rebuilt WASM with multi-format bridge`);
            }
        }
        if (this.queuedPixelBytes !== this.pixelByteTotal) {
            throw new Error(`JXL encode expected ${this.pixelByteTotal} bytes for ${this.options.format}, got ${this.queuedPixelBytes}`);
        }
        let compressedBytes = 0;
        if (this.streamingInputActive && this.wasmEncState !== 0) {
            // #16: Streaming input path — pixels already in WASM pixel buffer.
            // enc_finish runs the encode; enc_take_chunk drains the output.
            try {
                const rc = module._jxl_wasm_enc_finish(this.wasmEncState);
                if (rc !== 0)
                    throw new Error(`JXL streaming encode finish failed (${rc})`);
                let chunkHandle;
                while ((chunkHandle = module._jxl_wasm_enc_take_chunk(this.wasmEncState)) !== 0) {
                    const chunk = takeBuffer(module, chunkHandle, "encode");
                    compressedBytes += chunk.data.byteLength;
                    yield chunk.data;
                }
            }
            finally {
                module._jxl_wasm_enc_free(this.wasmEncState);
                this.wasmEncState = 0;
            }
        }
        else {
            // Buffered path — accumulate pixelChunks in JS, copy to WASM, then encode.
            // Write pixel chunks directly into WASM heap — no concatBytes allocation.
            // Release each JS chunk reference immediately after copying to reduce peak JS heap overlap.
            const ptr = module._malloc(this.pixelByteTotal);
            try {
                let offset = 0;
                for (let i = 0; i < this.pixelChunks.length; i++) {
                    const ch = this.pixelChunks[i];
                    module.HEAPU8.set(ch, ptr + offset);
                    offset += ch.byteLength;
                    this.pixelChunks[i] = EMPTY_U8;
                }
                this.pixelChunks = [];
                this.queuedPixelBytes = 0;
                const distance = this.options.distance ?? distanceFromQuality(this.options.quality);
                const hasAlpha = this.options.hasAlpha ? 1 : 0;
                const caps = getCapabilities(module);
                const { progressiveDc, progressiveAc, qProgressiveAc, buffering } = resolveEncoderBridgeSettings(this.options);
                // Sidecar thumbnails — yield smallest first for faster first-paint.
                if (this.sortedSidecarSizes.length > 0 && caps.sidecars) {
                    const sortedSizes = this.sortedSidecarSizes;
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
                            // Capture next pointer before takeBuffer frees handle.
                            const next = module._jxl_wasm_buffer_next(handle);
                            try {
                                const buf = takeBuffer(module, handle, "encode");
                                compressedBytes += buf.data.byteLength;
                                yield buf.data;
                            }
                            catch (err) {
                                // takeBuffer already freed handle; free remaining chain, then rethrow.
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
                else if (caps.streamingEncode) {
                    // #11: streaming encoder — yields 256 KB chunks, reducing peak JS heap usage.
                    const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : 0;
                    const encState = module._jxl_wasm_enc_create();
                    try {
                        const rc = module._jxl_wasm_enc_push_pixels(encState, ptr, this.options.width, this.options.height, distance, this.options.effort, fmtIndex, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering);
                        if (rc !== 0)
                            throw new Error(`JXL streaming encode failed (${rc})`);
                        let chunkHandle;
                        while ((chunkHandle = module._jxl_wasm_enc_take_chunk(encState)) !== 0) {
                            const chunk = takeBuffer(module, chunkHandle, "encode");
                            compressedBytes += chunk.data.byteLength;
                            yield chunk.data;
                        }
                    }
                    finally {
                        module._jxl_wasm_enc_free(encState);
                    }
                }
                else {
                    // Standard single-image encode path
                    let handle;
                    // Use metadata path if any metadata is present.
                    // fmt: 0=rgba8, 1=rgba16, 2=rgbaf32 — matches bridge parameter order.
                    const fmt = this.options.format === "rgba16" ? 1 : this.options.format === "rgbaf32" ? 2 : 0;
                    const hasMetadata = this.options.iccProfile !== null || this.options.exif !== null || this.options.xmp !== null;
                    if (hasMetadata && module._jxl_wasm_encode_rgba8_with_metadata) {
                        const iccView = this.options.iccProfile ? copyOrBorrowInput(this.options.iccProfile, false) : new Uint8Array(0);
                        const exifView = this.options.exif ? copyOrBorrowInput(this.options.exif, false) : new Uint8Array(0);
                        const xmpView = this.options.xmp ? copyOrBorrowInput(this.options.xmp, false) : new Uint8Array(0);
                        const iccPtr = iccView.byteLength > 0 ? module._malloc(iccView.byteLength) : 0;
                        const exifPtr = exifView.byteLength > 0 ? module._malloc(exifView.byteLength) : 0;
                        const xmpPtr = xmpView.byteLength > 0 ? module._malloc(xmpView.byteLength) : 0;
                        try {
                            if (iccPtr !== 0)
                                module.HEAPU8.set(iccView, iccPtr);
                            if (exifPtr !== 0)
                                module.HEAPU8.set(exifView, exifPtr);
                            if (xmpPtr !== 0)
                                module.HEAPU8.set(xmpView, xmpPtr);
                            handle = module._jxl_wasm_encode_rgba8_with_metadata(ptr, this.options.width, this.options.height, distance, this.options.effort, fmt, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, iccPtr, iccView.byteLength, exifPtr, exifView.byteLength, xmpPtr, xmpView.byteLength);
                        }
                        finally {
                            if (iccPtr !== 0)
                                module._free(iccPtr);
                            if (exifPtr !== 0)
                                module._free(exifPtr);
                            if (xmpPtr !== 0)
                                module._free(xmpPtr);
                        }
                    }
                    else {
                        // Fallback: plain encode (no metadata) used when bridge fn absent
                        // or when no metadata was provided.
                        if (this.options.format === "rgba16" && module._jxl_wasm_encode_rgba16) {
                            handle = module._jxl_wasm_encode_rgba16(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering);
                        }
                        else if (this.options.format === "rgbaf32" && module._jxl_wasm_encode_rgbaf32) {
                            handle = module._jxl_wasm_encode_rgbaf32(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering);
                        }
                        else {
                            handle = module._jxl_wasm_encode_rgba8(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering);
                        }
                    }
                    const encoded = takeBuffer(module, handle, "encode");
                    compressedBytes += encoded.data.byteLength;
                    yield encoded.data;
                }
            }
            finally {
                module._free(ptr);
                this.pixelChunks = [];
                this.queuedPixelBytes = 0;
            }
        }
        this.encodeStats = { originalBytes: this.pixelByteTotal, compressedBytes, ratio: this.pixelByteTotal > 0 ? compressedBytes / this.pixelByteTotal : 0 };
    }
    getStats() { return this.encodeStats; }
    cancel(_reason) {
        this.cancelled = true;
        this.freeWasmState();
        this.finishResolve?.();
        this.finishResolve = null;
    }
    dispose() {
        this.pixelChunks = [];
        this.queuedPixelBytes = 0;
        this.cancelled = true;
        this.freeWasmState();
        this.finishResolve?.();
        this.finishResolve = null;
    }
    freeWasmState() {
        if (this.wasmEncState !== 0 && this.wasmModule !== null) {
            this.wasmModule._jxl_wasm_enc_free(this.wasmEncState);
            this.wasmEncState = 0;
        }
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
const capabilityCache = new WeakMap();
function getCapabilities(module) {
    let caps = capabilityCache.get(module);
    if (caps !== undefined)
        return caps;
    caps = {
        progressiveDecode: typeof module._jxl_wasm_dec_create === "function",
        streamingEncode: typeof module._jxl_wasm_enc_create === "function" &&
            typeof module._jxl_wasm_enc_push_pixels === "function" &&
            typeof module._jxl_wasm_enc_take_chunk === "function" &&
            typeof module._jxl_wasm_enc_free === "function",
        streamingInput: typeof module._jxl_wasm_enc_create_image === "function" &&
            typeof module._jxl_wasm_enc_push_chunk === "function" &&
            typeof module._jxl_wasm_enc_finish === "function" &&
            typeof module._jxl_wasm_enc_take_chunk === "function" &&
            typeof module._jxl_wasm_enc_free === "function",
        sidecars: typeof module._jxl_wasm_encode_rgba8_with_sidecars === "function" &&
            typeof module._jxl_wasm_buffer_next === "function",
        jpegTranscode: typeof module._jxl_wasm_transcode_jpeg_to_jxl === "function",
    };
    capabilityCache.set(module, caps);
    return caps;
}
function callDecodeFromPtr(module, ptr, size, downsample, format, region) {
    let handle = 0;
    try {
        // #10: use C++ region crop when available — avoids shipping full-image pixels to JS.
        if (region != null) {
            if (format === "rgba16" && module._jxl_wasm_decode_rgba16_region) {
                handle = module._jxl_wasm_decode_rgba16_region(ptr, size, region.x, region.y, region.w, region.h, downsample);
            }
            else if (format === "rgbaf32" && module._jxl_wasm_decode_rgbaf32_region) {
                handle = module._jxl_wasm_decode_rgbaf32_region(ptr, size, region.x, region.y, region.w, region.h, downsample);
            }
            else if (module._jxl_wasm_decode_rgba8_region) {
                handle = module._jxl_wasm_decode_rgba8_region(ptr, size, region.x, region.y, region.w, region.h, downsample);
            }
            else {
                handle = callDecodeNoRegion(module, ptr, size, downsample, format);
            }
        }
        else {
            handle = callDecodeNoRegion(module, ptr, size, downsample, format);
        }
        return readBufferView(module, handle, "decode");
    }
    catch (err) {
        // readBufferView does not free on error — we own handle here.
        if (handle !== 0)
            module._jxl_wasm_buffer_free(handle);
        throw err;
    }
}
function callDecodeNoRegion(module, ptr, size, downsample, format) {
    if (format === "rgba16" && module._jxl_wasm_decode_rgba16) {
        return module._jxl_wasm_decode_rgba16(ptr, size, downsample);
    }
    else if (format === "rgbaf32" && module._jxl_wasm_decode_rgbaf32) {
        return module._jxl_wasm_decode_rgbaf32(ptr, size, downsample);
    }
    return module._jxl_wasm_decode_rgba8(ptr, size, downsample);
}
// Read buffer metadata without freeing handle. Caller is responsible for freeing.
function readBufferView(module, handle, operation) {
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
// Read buffer and always free handle (in finally), whether success or failure.
function takeBuffer(module, handle, operation) {
    try {
        return readBufferView(module, handle, operation);
    }
    finally {
        if (handle !== 0)
            module._jxl_wasm_buffer_free(handle);
    }
}
function normalizeBitsPerSample(value) {
    if (value === 16 || value === 32)
        return value;
    return 8;
}
function bytesPerChannelForFormat(format) {
    return format === "rgbaf32" ? 4 : format === "rgba16" ? 2 : 1;
}
const MAX_PIXEL_BYTES = 1024 * 1024 * 1024; // 1 GiB hard limit before WASM malloc
function expectedPixelBytes(width, height, format, maxBytes = MAX_PIXEL_BYTES) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error(`Invalid image dimensions: ${width} × ${height}`);
    }
    const bpc = bytesPerChannelForFormat(format);
    const bytes = width * height * 4 * bpc;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
        throw new Error(`Pixel byte size overflow for ${width} × ${height} ${format}`);
    }
    if (bytes > maxBytes) {
        throw new Error(`Image too large for WASM encode: ${bytes} bytes exceeds limit ${maxBytes}`);
    }
    return bytes;
}
function distanceFromQuality(quality) {
    if (quality === null)
        return 1;
    if (!Number.isFinite(quality))
        throw new Error(`Invalid JXL quality: ${quality}`);
    const q = Math.max(0, Math.min(100, quality));
    return ((100 - q) * 15) / 100;
}
// Borrow or copy input depending on caller's ownership. ArrayBuffer is always zero-copy (view only).
function copyOrBorrowInput(value, copy) {
    if (value instanceof ArrayBuffer)
        return new Uint8Array(value);
    return copy ? value.slice() : value;
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
    if (downsample === 1) {
        // Crop-only: copy whole rows at once — much faster than per-pixel copy.
        for (let y = 0; y < outHeight; y++) {
            const srcStart = ((sourceRegion.y + y) * width + sourceRegion.x) * stride;
            out.set(data.subarray(srcStart, srcStart + outWidth * stride), y * outWidth * stride);
        }
    }
    else if (stride === 4) {
        // rgba8 downsample — direct element assignment; sy hoisted out of inner loop.
        for (let y = 0; y < outHeight; y++) {
            const srcRowBase = (sourceRegion.y + Math.min(sourceRegion.h - 1, y * downsample)) * width * 4;
            const dstRowBase = y * outWidth * 4;
            for (let x = 0; x < outWidth; x++) {
                const src = srcRowBase + (sourceRegion.x + Math.min(sourceRegion.w - 1, x * downsample)) * 4;
                const dst = dstRowBase + x * 4;
                out[dst] = data[src];
                out[dst + 1] = data[src + 1];
                out[dst + 2] = data[src + 2];
                out[dst + 3] = data[src + 3];
            }
        }
    }
    else {
        // General path (rgba16 / rgbaf32 downsample) — sy hoisted out of inner loop.
        for (let y = 0; y < outHeight; y++) {
            const srcRowBase = (sourceRegion.y + Math.min(sourceRegion.h - 1, y * downsample)) * width * stride;
            const dstRowBase = y * outWidth * stride;
            for (let x = 0; x < outWidth; x++) {
                const src = srcRowBase + (sourceRegion.x + Math.min(sourceRegion.w - 1, x * downsample)) * stride;
                const dst = dstRowBase + x * stride;
                out.set(data.subarray(src, src + stride), dst);
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
function bilinearResize(src, srcW, srcH, dstW, dstH, stride) {
    const dst = new Uint8Array(dstW * dstH * stride);
    if (stride === 4) {
        for (let dy = 0; dy < dstH; dy++) {
            const fy = (dy + 0.5) * (srcH / dstH) - 0.5;
            const y0 = Math.max(0, Math.floor(fy));
            const y1 = Math.min(srcH - 1, y0 + 1);
            const yt = fy - y0;
            for (let dx = 0; dx < dstW; dx++) {
                const fx = (dx + 0.5) * (srcW / dstW) - 0.5;
                const x0 = Math.max(0, Math.floor(fx));
                const x1 = Math.min(srcW - 1, x0 + 1);
                const xt = fx - x0;
                const dstOff = (dy * dstW + dx) * 4;
                for (let c = 0; c < 4; c++) {
                    const tl = src[(y0 * srcW + x0) * 4 + c];
                    const tr = src[(y0 * srcW + x1) * 4 + c];
                    const bl = src[(y1 * srcW + x0) * 4 + c];
                    const br = src[(y1 * srcW + x1) * 4 + c];
                    dst[dstOff + c] = Math.round(tl * (1 - xt) * (1 - yt) + tr * xt * (1 - yt) + bl * (1 - xt) * yt + br * xt * yt);
                }
            }
        }
    }
    else if (stride === 8) {
        const srcView = new DataView(src.buffer, src.byteOffset, src.byteLength);
        const dstView = new DataView(dst.buffer);
        for (let dy = 0; dy < dstH; dy++) {
            const fy = (dy + 0.5) * (srcH / dstH) - 0.5;
            const y0 = Math.max(0, Math.floor(fy));
            const y1 = Math.min(srcH - 1, y0 + 1);
            const yt = fy - y0;
            for (let dx = 0; dx < dstW; dx++) {
                const fx = (dx + 0.5) * (srcW / dstW) - 0.5;
                const x0 = Math.max(0, Math.floor(fx));
                const x1 = Math.min(srcW - 1, x0 + 1);
                const xt = fx - x0;
                const dstOff = (dy * dstW + dx) * 8;
                for (let c = 0; c < 4; c++) {
                    const bo = c * 2;
                    const tl = srcView.getUint16((y0 * srcW + x0) * 8 + bo, true);
                    const tr = srcView.getUint16((y0 * srcW + x1) * 8 + bo, true);
                    const bl = srcView.getUint16((y1 * srcW + x0) * 8 + bo, true);
                    const br = srcView.getUint16((y1 * srcW + x1) * 8 + bo, true);
                    const val = Math.round(tl * (1 - xt) * (1 - yt) + tr * xt * (1 - yt) + bl * (1 - xt) * yt + br * xt * yt);
                    dstView.setUint16(dstOff + bo, Math.max(0, Math.min(65535, val)), true);
                }
            }
        }
    }
    else {
        // rgbaf32
        const srcView = new DataView(src.buffer, src.byteOffset, src.byteLength);
        const dstView = new DataView(dst.buffer);
        for (let dy = 0; dy < dstH; dy++) {
            const fy = (dy + 0.5) * (srcH / dstH) - 0.5;
            const y0 = Math.max(0, Math.floor(fy));
            const y1 = Math.min(srcH - 1, y0 + 1);
            const yt = fy - y0;
            for (let dx = 0; dx < dstW; dx++) {
                const fx = (dx + 0.5) * (srcW / dstW) - 0.5;
                const x0 = Math.max(0, Math.floor(fx));
                const x1 = Math.min(srcW - 1, x0 + 1);
                const xt = fx - x0;
                const dstOff = (dy * dstW + dx) * 16;
                for (let c = 0; c < 4; c++) {
                    const bo = c * 4;
                    const tl = srcView.getFloat32((y0 * srcW + x0) * 16 + bo, true);
                    const tr = srcView.getFloat32((y0 * srcW + x1) * 16 + bo, true);
                    const bl = srcView.getFloat32((y1 * srcW + x0) * 16 + bo, true);
                    const br = srcView.getFloat32((y1 * srcW + x1) * 16 + bo, true);
                    dstView.setFloat32(dstOff + bo, tl * (1 - xt) * (1 - yt) + tr * xt * (1 - yt) + bl * (1 - xt) * yt + br * xt * yt, true);
                }
            }
        }
    }
    return dst;
}
function applyTargetResize(src, srcW, srcH, targetW, targetH, fitMode, bpc) {
    const stride = 4 * bpc;
    if (fitMode === "stretch") {
        return { data: bilinearResize(src, srcW, srcH, targetW, targetH, stride), width: targetW, height: targetH };
    }
    if (fitMode === "contain") {
        const scale = Math.min(targetW / srcW, targetH / srcH);
        const dstW = Math.max(1, Math.round(srcW * scale));
        const dstH = Math.max(1, Math.round(srcH * scale));
        return { data: bilinearResize(src, srcW, srcH, dstW, dstH, stride), width: dstW, height: dstH };
    }
    // cover: scale up so both dims >= target, then center-crop
    const scale = Math.max(targetW / srcW, targetH / srcH);
    const scaledW = Math.max(targetW, Math.round(srcW * scale));
    const scaledH = Math.max(targetH, Math.round(srcH * scale));
    const scaled = bilinearResize(src, srcW, srcH, scaledW, scaledH, stride);
    const cropX = Math.floor((scaledW - targetW) / 2);
    const cropY = Math.floor((scaledH - targetH) / 2);
    const cropped = applyRegionAndDownsample(scaled, scaledW, scaledH, { x: cropX, y: cropY, w: targetW, h: targetH }, 1, bpc);
    return { data: cropped.data, width: targetW, height: targetH };
}
function pickDownsample(_options) {
    // Source dims unknown at call time — resize post-decode handles scale-to-target.
    return 1;
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
//# sourceMappingURL=facade.js.map