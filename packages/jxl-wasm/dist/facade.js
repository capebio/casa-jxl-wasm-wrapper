function normalizeDecoderOptions(options) {
    return {
        ...options,
        region: options.region ?? null,
        downsample: options.downsample ?? pickDownsample(options),
        ...(options.progressiveDetail !== undefined ? { progressiveDetail: options.progressiveDetail } : {}),
        targetWidth: options.targetWidth ?? null,
        targetHeight: options.targetHeight ?? null,
        fitMode: options.fitMode ?? null,
    };
}
function resolveDecoderProgressiveDetail(options) {
    if (options.progressionTarget === "header")
        return 0;
    if (!(options.progressionTarget !== "final" || options.emitEveryPass))
        return 0;
    const detail = options.progressiveDetail
        ?? (options.emitEveryPass || options.progressionTarget === "pass" ? "passes" : "dc");
    switch (detail) {
        case "dc":
            return 1;
        case "lastPasses":
            return 2;
        case "passes":
            return 3;
        case "dcProgressive":
            return 4;
        default:
            return 1;
    }
}
function encodeExtraChannelType(type) {
    switch (type) {
        case "alpha": return 0; // JXL_CHANNEL_ALPHA
        case "depth": return 1; // JXL_CHANNEL_DEPTH
        case "spot": return 2; // JXL_CHANNEL_SPOT_COLOR
        case "selection": return 3; // JXL_CHANNEL_SELECTION_MASK
        case "black": return 4; // JXL_CHANNEL_BLACK (CMYK K; Level 10 + modular + CMYK ICC)
        case "cfa": return 5; // JXL_CHANNEL_CFA (Bayer raw sensor)
        case "thermal": return 6; // JXL_CHANNEL_THERMAL
        default: return 15; // JXL_CHANNEL_OPTIONAL
    }
}
function encodeBlendMode(mode) {
    switch (mode) {
        case "add": return 1; // JXL_BLEND_ADD
        case "blend": return 2; // JXL_BLEND_BLEND
        case "muladd": return 3; // JXL_BLEND_MULADD
        case "mul": return 4; // JXL_BLEND_MUL
        default: return 0; // JXL_BLEND_REPLACE
    }
}
/** Returns effective ICC/EXIF/XMP blobs after applying MetadataOptions include flags. */
function resolveEffectiveMetadata(options) {
    const m = options.metadata;
    return {
        iccProfile: m?.includeICC !== false ? options.iccProfile : null,
        exif: m?.includeExif !== false ? options.exif : null,
        xmp: m?.includeXMP !== false ? options.xmp : null,
    };
}
/** True when box-options v2 features are needed (compress, container control, custom boxes). */
function needsBoxOptsV2(options) {
    const m = options.metadata;
    const hasJumbf = options.jumbfBoxes != null && options.jumbfBoxes.length > 0;
    return !!(m?.compressBoxes || m?.forceContainer || m?.rawCodestream) ||
        (options.customBoxes != null && options.customBoxes.length > 0) ||
        hasJumbf;
}
const _textEncoder = new TextEncoder();
const _textDecoder = new TextDecoder();
function applyAnimFrameMetadata(ev, module, dec) {
    const frameIndex = module._jxl_wasm_dec_frame_index?.(dec) ?? undefined;
    const frameDuration = module._jxl_wasm_dec_frame_duration(dec);
    const isLastFrame = module._jxl_wasm_dec_is_last_frame
        ? (module._jxl_wasm_dec_is_last_frame(dec) !== 0)
        : undefined;
    const animTicksPerSecond = module._jxl_wasm_dec_anim_ticks_per_second?.(dec) ?? undefined;
    const animLoopCount = module._jxl_wasm_dec_anim_loop_count?.(dec) ?? undefined;
    const namePtr = module._jxl_wasm_dec_frame_name_ptr?.(dec) ?? 0;
    if (frameIndex !== undefined)
        ev.frameIndex = frameIndex;
    if (frameDuration !== undefined)
        ev.frameDuration = frameDuration;
    if (namePtr !== 0) {
        let end = namePtr;
        while (module.HEAPU8[end] !== 0 && end < namePtr + 256)
            end++;
        ev.frameName = _textDecoder.decode(module.HEAPU8.subarray(namePtr, end));
    }
    if (isLastFrame !== undefined)
        ev.isLastFrame = isLastFrame;
    if (animTicksPerSecond !== undefined)
        ev.animTicksPerSecond = animTicksPerSecond;
    if (animLoopCount !== undefined)
        ev.animLoopCount = animLoopCount;
}
/** Expands jumbfBoxes into MetadataBoxSpec entries (type "jumb", compress true by default). */
function expandJumbfBoxes(options) {
    if (!options.jumbfBoxes?.length)
        return [];
    const out = [];
    for (const j of options.jumbfBoxes) {
        const data = j.data instanceof ArrayBuffer ? new Uint8Array(j.data) : j.data;
        out.push({ type: "jumb", data, compress: true });
    }
    return out;
}
// WasmBoxOpts layout (20 bytes, little-endian uint32):
//   offset  0: compress_boxes
//   offset  4: force_container
//   offset  8: raw_codestream
//   offset 12: custom_boxes_ptr  (WASM heap ptr)
//   offset 16: num_custom_boxes
const WASM_BOX_OPTS_BYTES = 20;
// WasmCustomBox layout (16 bytes):
//   offset  0: box_type[4] (char)
//   offset  4: data_ptr    (uint32)
//   offset  8: data_size   (uint32)
//   offset 12: compress    (uint32)
const WASM_CUSTOM_BOX_BYTES = 16;
/**
 * Allocates WasmBoxOpts + WasmCustomBox[] on the WASM heap.
 * Returns ptr to WasmBoxOpts and an array of all heap allocations to free.
 * Returns ptr=0 if nothing was marshaled (no-op path).
 */
function marshalBoxOpts(module, options) {
    const m = options.metadata;
    if (!m && !(options.customBoxes?.length) && !(options.jumbfBoxes?.length)) {
        return { ptr: 0, freePtrs: [] };
    }
    const jumbfCustom = expandJumbfBoxes(options);
    const customBoxes = [...(options.customBoxes ?? []), ...jumbfCustom];
    if (!m && customBoxes.length === 0)
        return { ptr: 0, freePtrs: [] };
    const freePtrs = [];
    // Build WasmCustomBox array.
    let customBoxesArrayPtr = 0;
    if (customBoxes.length > 0) {
        const cbBuf = new Uint8Array(customBoxes.length * WASM_CUSTOM_BOX_BYTES);
        const dv = new DataView(cbBuf.buffer);
        for (let i = 0; i < customBoxes.length; i++) {
            const cb = customBoxes[i];
            const base = i * WASM_CUSTOM_BOX_BYTES;
            // Direct 4-byte type write (avoids string concat + slice + charCodeAt per box).
            const t = cb.type;
            cbBuf[base] = (t.charCodeAt(0) || 0x20) & 0xff;
            cbBuf[base + 1] = (t.charCodeAt(1) || 0x20) & 0xff;
            cbBuf[base + 2] = (t.charCodeAt(2) || 0x20) & 0xff;
            cbBuf[base + 3] = (t.charCodeAt(3) || 0x20) & 0xff;
            const cbData = cb.data instanceof ArrayBuffer ? new Uint8Array(cb.data) : cb.data;
            const cbDataPtr = mallocAndCopy(module, cbData, freePtrs);
            dv.setUint32(base + 4, cbDataPtr, true);
            dv.setUint32(base + 8, cbData.byteLength, true);
            dv.setUint32(base + 12, cb.compress ? 1 : 0, true);
        }
        customBoxesArrayPtr = mallocAndCopy(module, cbBuf, freePtrs);
    }
    // Build WasmBoxOpts.
    const boBuf = new Uint8Array(WASM_BOX_OPTS_BYTES);
    const boDv = new DataView(boBuf.buffer);
    boDv.setUint32(0, m?.compressBoxes ? 1 : 0, true);
    boDv.setUint32(4, (!m?.rawCodestream && m?.forceContainer) ? 1 : 0, true);
    boDv.setUint32(8, m?.rawCodestream ? 1 : 0, true);
    boDv.setUint32(12, customBoxesArrayPtr, true);
    boDv.setUint32(16, customBoxes.length, true);
    const ptr = mallocAndCopy(module, boBuf, freePtrs);
    return { ptr, freePtrs };
}
// WasmAnimationFrame layout (28 bytes, 4-byte aligned uint32):
//   offset  0: pixels_ptr  — WASM heap ptr to RGBA pixel data
//   offset  4: pixels_size — byte length of pixel buffer
//   offset  8: width       — frame width in px
//   offset 12: height      — frame height in px
//   offset 16: duration    — frame duration in ticks
//   offset 20: name_ptr    — WASM heap ptr to UTF-8 name string (0 if absent)
//   offset 24: name_size   — byte length of name string
//   offset 28: blend_mode  — JxlBlendMode value (0=replace, 1=add, 2=blend, 3=muladd, 4=mul)
const WASM_ANIMATION_FRAME_BYTES = 32;
// WasmAnimationOpts layout (8 bytes):
//   offset 0: ticks_per_second (uint32)
//   offset 4: loop_count       (uint32)
const WASM_ANIMATION_OPTS_BYTES = 8;
/**
 * Allocates WasmAnimationFrame[] + WasmAnimationOpts on the WASM heap.
 * Returns ptr to the frame array, ptr to the animation options struct,
 * and an array of all heap allocations to free.
 * `framesPtr` and `animOptsPtr` can be 0 if `_malloc` fails (same semantics as marshalBoxOpts).
 */
function marshalAnimationFrames(module, frames, animOpts) {
    const freePtrs = [];
    const framesBuf = new Uint8Array(frames.length * WASM_ANIMATION_FRAME_BYTES);
    const framesDv = new DataView(framesBuf.buffer);
    for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const base = i * WASM_ANIMATION_FRAME_BYTES;
        const pixelData = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data;
        const pixelsPtr = mallocAndCopy(module, pixelData, freePtrs);
        framesDv.setUint32(base, pixelsPtr, true);
        framesDv.setUint32(base + 4, pixelData.byteLength, true);
        framesDv.setUint32(base + 8, f.width, true);
        framesDv.setUint32(base + 12, f.height, true);
        framesDv.setUint32(base + 16, f.duration, true);
        let namePtr = 0;
        let nameSize = 0;
        if (f.name != null && f.name.length > 0) {
            const nameBytes = _textEncoder.encode(f.name);
            namePtr = mallocAndCopy(module, nameBytes, freePtrs);
            nameSize = nameBytes.byteLength;
        }
        framesDv.setUint32(base + 20, namePtr, true);
        framesDv.setUint32(base + 24, nameSize, true);
        const blendMode = encodeBlendMode(f.blendMode);
        framesDv.setUint32(base + 28, blendMode, true);
    }
    const framesPtr = mallocAndCopy(module, framesBuf, freePtrs);
    const animBuf = new Uint8Array(WASM_ANIMATION_OPTS_BYTES);
    const animDv = new DataView(animBuf.buffer);
    animDv.setUint32(0, animOpts?.ticksPerSecond ?? 1000, true);
    animDv.setUint32(4, animOpts?.loopCount ?? 0, true);
    const animOptsPtr = mallocAndCopy(module, animBuf, freePtrs);
    return { framesPtr, animOptsPtr, freePtrs };
}
function resolveEncoderBridgeSettings(options) {
    const modular = options.modular ?? -1;
    const brotliEffort = options.brotliEffort != null ? Math.max(-1, Math.min(11, Math.round(options.brotliEffort))) : -1;
    const decodingSpeed = options.decodingSpeed != null ? Math.max(0, Math.min(4, Math.round(options.decodingSpeed))) : -1;
    const photonNoiseIso = options.photonNoiseIso != null ? Math.max(0, Math.round(options.photonNoiseIso)) : 0;
    const resampling = resolveResampling(options.resampling);
    const epf = options.epf != null ? Math.max(-1, Math.min(3, Math.round(options.epf))) : -1;
    const gaborish = options.gaborish != null ? (options.gaborish <= 0 ? 0 : 1) : -1;
    const dots = options.dots != null ? (options.dots <= 0 ? 0 : 1) : -1;
    const colorTransform = options.colorTransform != null ? Math.max(-1, Math.min(2, Math.round(options.colorTransform))) : -1;
    if (!options.progressive) {
        return { progressiveDc: 0, progressiveAc: 0, qProgressiveAc: 0, buffering: options.chunked ? 2 : 0, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, epf, gaborish, dots, colorTransform, groupOrder: 0 };
    }
    const acEnabled = options.progressiveFlavor === "ac" || (options.progressiveFlavor !== "dc" && options.previewFirst);
    // Respect explicit progressiveDc (0/1/2) for multi-layer DC progression; fall back to 1 when progressive.
    // previewFirst implies at least basic early DC.
    const progressiveDc = options.progressiveDc != null
        ? Math.max(0, Math.min(2, options.progressiveDc | 0))
        : (options.previewFirst ? 1 : 1);
    // Smart default: previewFirst or high passes bias to center-out group order (predator).
    const groupOrder = options.groupOrder != null ? (options.groupOrder ? 1 : 0) : (options.previewFirst ? 1 : 0);
    return {
        progressiveDc,
        progressiveAc: options.progressiveAc != null ? (options.progressiveAc ? 1 : 0) : (acEnabled ? 1 : 0),
        qProgressiveAc: options.qProgressiveAc != null ? (options.qProgressiveAc ? 1 : 0) : (acEnabled ? 1 : 0),
        buffering: options.chunked ? 2 : 0,
        modular,
        brotliEffort,
        decodingSpeed,
        photonNoiseIso,
        resampling,
        epf,
        gaborish,
        dots,
        colorTransform,
        groupOrder,
    };
}
function resolveResampling(value) {
    return value === 2 || value === 4 || value === 8 ? value : 1;
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
    const envTier = getEnvForcedTier();
    if (envTier)
        return envTier;
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
function getEnvForcedTier() {
    const env = globalThis.process?.env;
    const tier = env?.JXL_WASM_FORCE_TIER;
    return tier === "relaxed-simd-mt" || tier === "simd-mt" || tier === "simd" || tier === "scalar" ? tier : null;
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
let cachedModule;
let testModuleFactory = null;
let _forcedTier = null;
let _cachedDetectedTier;
export function setJxlModuleFactoryForTesting(factory) {
    testModuleFactory = factory;
    modulePromise = undefined;
    cachedModule = undefined;
}
/**
 * Override the WASM tier used on the next module load.
 * Pass null to restore auto-detection via detectTier().
 * Resets the cached module so the next encode/decode reloads with the new tier.
 */
export function setForcedTier(tier) {
    _forcedTier = tier;
    modulePromise = undefined;
    cachedModule = undefined;
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
/**
 * Encode an RGBA8 image as a tiled multi-frame JXL.
 * Each tile becomes one JXL frame with layer_info.have_crop = JXL_TRUE.
 * Decode with decodeTiledRegionRgba8 to retrieve any rectangular region
 * without decoding the whole image — true partial decode in libjxl 0.11.x.
 *
 * Requires a WASM build that includes the tile bridge
 * (jxl_wasm_encode_tiled_rgba8).
 *
 * @param tileSize must match the value passed to decodeTiledRegionRgba8.
 */
export async function encodeTiledRgba8(pixels, width, height, options) {
    const module = await loadLibjxlModule();
    if (!module._jxl_wasm_encode_tiled_rgba8) {
        throw new CapabilityMissing("Tiled encode requires a rebuilt WASM with tile bridge");
    }
    const tileSize = options.tileSize;
    if (!Number.isInteger(tileSize) || tileSize < 16) {
        throw new Error(`tileSize must be an integer ≥ 16, got ${tileSize}`);
    }
    const distance = options.distance ?? 1.0;
    const effort = options.effort ?? 3;
    const hasAlpha = options.hasAlpha !== false;
    const view = copyOrBorrowInput(pixels, false);
    const expectedBytes = width * height * 4;
    if (view.byteLength < expectedBytes) {
        throw new Error(`Pixel buffer too small: ${view.byteLength} < ${expectedBytes}`);
    }
    const ptr = module._malloc(view.byteLength);
    if (ptr === 0)
        throw new Error("WASM malloc failed for tiled encode input");
    try {
        module.HEAPU8.set(view, ptr);
        const handle = module._jxl_wasm_encode_tiled_rgba8(ptr, width, height, tileSize, distance, effort, hasAlpha ? 1 : 0);
        return takeBuffer(module, handle, "tiled encode").data;
    }
    finally {
        module._free(ptr);
    }
}
/**
 * Decode a rectangular region from a tiled JXL produced by encodeTiledRgba8.
 * Only the JXL frames whose layer bounds overlap the region are decompressed;
 * other frames are skipped via JxlDecoderSkipFrames (header-only walk).
 *
 * Returns clamped region dimensions — caller should pre-clamp if exact size
 * is required.
 */
export async function decodeTiledRegionRgba8(jxlBytes, options) {
    const module = await loadLibjxlModule();
    if (!module._jxl_wasm_decode_region_tiled_rgba8) {
        throw new CapabilityMissing("Tiled region decode requires a rebuilt WASM with tile bridge");
    }
    const { tileSize, x, y, w, h, onMetric } = options;
    if (!Number.isInteger(tileSize) || tileSize < 16) {
        throw new Error(`tileSize must be an integer ≥ 16, got ${tileSize}`);
    }
    const tStart = performance.now();
    const view = copyOrBorrowInput(jxlBytes, false);
    const t1 = performance.now();
    onMetric?.("tiled_region_input_prep", t1 - tStart);
    const t2 = performance.now();
    const ptr = module._malloc(view.byteLength);
    if (ptr === 0)
        throw new Error("WASM malloc failed for tiled decode input");
    const tMalloc = performance.now() - t2;
    onMetric?.("tiled_region_malloc", tMalloc);
    try {
        const t3 = performance.now();
        module.HEAPU8.set(view, ptr);
        const tHeapSet = performance.now() - t3;
        onMetric?.("tiled_region_heap_set", tHeapSet);
        const t4 = performance.now();
        const handle = module._jxl_wasm_decode_region_tiled_rgba8(ptr, view.byteLength, tileSize, x, y, w, h);
        const tWasmDecode = performance.now() - t4;
        onMetric?.("tiled_region_wasm_decode", tWasmDecode);
        const t5 = performance.now();
        const buf = takeBuffer(module, handle, "tiled region decode");
        const tBufferRead = performance.now() - t5;
        onMetric?.("tiled_region_buffer_read", tBufferRead);
        const tTotal = performance.now() - tStart;
        onMetric?.("tiled_region_total", tTotal);
        return { pixels: buf.data, width: buf.width, height: buf.height };
    }
    finally {
        module._free(ptr);
    }
}
/**
 * Encode RGBA8 as a JXTC tile container — N independent standalone JXL bitstreams
 * plus a byte-offset index. Decode with decodeTileContainerRegionRgba8 to retrieve
 * any rectangular region with zero frame-walk overhead.
 *
 * Compared to encodeTiledRgba8 (multi-frame JXL):
 *   - Same tile granularity
 *   - Slightly larger output (~5-10% overhead from per-tile JXL headers)
 *   - Vastly faster ROI decode in libjxl ≤0.11.x where SkipFrames doesn't skip work
 *
 * Output is NOT a standard JXL — it's a custom container format. Magic 'JXTC'.
 */
export async function encodeTileContainerRgba8(pixels, width, height, options) {
    const module = await loadLibjxlModule();
    if (!module._jxl_wasm_encode_tile_container_rgba8) {
        throw new CapabilityMissing("Tile container encode requires a rebuilt WASM with JXTC bridge");
    }
    const tileSize = options.tileSize;
    if (!Number.isInteger(tileSize) || tileSize < 16) {
        throw new Error(`tileSize must be an integer ≥ 16, got ${tileSize}`);
    }
    const distance = options.distance ?? 1.0;
    const effort = options.effort ?? 3;
    const hasAlpha = options.hasAlpha !== false;
    const view = copyOrBorrowInput(pixels, false);
    const expectedBytes = width * height * 4;
    if (view.byteLength < expectedBytes) {
        throw new Error(`Pixel buffer too small: ${view.byteLength} < ${expectedBytes}`);
    }
    const ptr = module._malloc(view.byteLength);
    if (ptr === 0)
        throw new Error("WASM malloc failed for tile container encode");
    try {
        module.HEAPU8.set(view, ptr);
        const handle = module._jxl_wasm_encode_tile_container_rgba8(ptr, width, height, tileSize, distance, effort, hasAlpha ? 1 : 0);
        return takeBuffer(module, handle, "tile container encode").data;
    }
    finally {
        module._free(ptr);
    }
}
/**
 * Decode a rectangular region from a JXTC tile container produced by
 * encodeTileContainerRgba8. Each overlapping tile is decoded as a standalone
 * JXL bitstream — zero frame-walk overhead. Performance is linear in number
 * of overlapping tiles, regardless of total image size.
 */
export async function decodeTileContainerRegionRgba8(containerBytes, options) {
    const module = await loadLibjxlModule();
    if (!module._jxl_wasm_decode_tile_container_region_rgba8) {
        throw new CapabilityMissing("Tile container decode requires a rebuilt WASM with JXTC bridge");
    }
    const { x, y, w, h, onMetric } = options;
    const tStart = performance.now();
    const view = copyOrBorrowInput(containerBytes, false);
    const t1 = performance.now();
    onMetric?.("jxtc_input_prep", t1 - tStart);
    const t2 = performance.now();
    const ptr = module._malloc(view.byteLength);
    if (ptr === 0)
        throw new Error("WASM malloc failed for tile container decode");
    const tMalloc = performance.now() - t2;
    onMetric?.("jxtc_malloc", tMalloc);
    try {
        const t3 = performance.now();
        module.HEAPU8.set(view, ptr);
        const tHeapSet = performance.now() - t3;
        onMetric?.("jxtc_heap_set", tHeapSet);
        const t4 = performance.now();
        const handle = module._jxl_wasm_decode_tile_container_region_rgba8(ptr, view.byteLength, x, y, w, h);
        const tWasmDecode = performance.now() - t4;
        onMetric?.("jxtc_wasm_decode", tWasmDecode);
        const t5 = performance.now();
        const buf = takeBuffer(module, handle, "tile container region decode");
        const tBufferRead = performance.now() - t5;
        onMetric?.("jxtc_buffer_read", tBufferRead);
        const tTotal = performance.now() - tStart;
        onMetric?.("jxtc_total", tTotal);
        return { pixels: buf.data, width: buf.width, height: buf.height };
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
        animationSeek: cachedModule != null && typeof cachedModule._jxl_wasm_dec_seek_to_frame === "function",
    };
}
export function getDecodeGridInfo() {
    return {};
}
export function decodeViewport(options) {
    return createDecoder({
        format: options.format,
        region: options.region ?? null,
        downsample: pickDownsample({ ...options, imageWidth: options.imageWidth ?? null, imageHeight: options.imageHeight ?? null }),
        progressionTarget: options.progressionTarget ?? "final",
        emitEveryPass: options.emitEveryPass ?? false,
        preserveIcc: options.preserveIcc ?? true,
        preserveMetadata: options.preserveMetadata ?? false,
        targetWidth: options.targetWidth ?? null,
        targetHeight: options.targetHeight ?? null,
        fitMode: options.fitMode ?? null,
        ...(options.progressiveDetail !== undefined ? { progressiveDetail: options.progressiveDetail } : {}),
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
        if (this.readIndex >= this.chunkQueue.length) {
            this.chunkQueue.length = 0;
            this.readIndex = 0;
        }
        else if (this.readIndex > 64 && this.readIndex * 2 > this.chunkQueue.length) {
            this.chunkQueue.copyWithin(0, this.readIndex);
            this.chunkQueue.length -= this.readIndex;
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
        const progressiveDetail = resolveDecoderProgressiveDetail(this.options);
        const dec = module._jxl_wasm_dec_create(fmtIndex, progressiveDetail);
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
            const infoBitsPerSample = fmtIndex === 2 ? 32 : fmtIndex === 1 ? 16 : 8;
            // buildInfo memoizes on first call from pixel data (hasAlpha from buffer).
            // The header event calls makeHeaderInfo directly to avoid locking in a wrong hasAlpha.
            const makeHeaderInfo = (w, h) => ({ width: w, height: h, bitsPerSample: infoBitsPerSample, hasAlpha: false, hasAnimation: false, jpegReconstructionAvailable: false });
            const buildInfo = (w, h, hasAlpha) => {
                info ??= { width: w, height: h, bitsPerSample: infoBitsPerSample, hasAlpha, hasAnimation: false, jpegReconstructionAvailable: false };
                return info;
            };
            const bpc = fmtIndex === 2 ? 4 : fmtIndex === 1 ? 2 : 1;
            const pixelStride = 4 * bpc;
            const fmt = this.options.format;
            const takeAndWrap = (handle) => {
                if (handle === 0)
                    return null;
                const tBufStart = performance.now();
                const buf = takeBuffer(module, handle, "decode");
                const tBuf = performance.now() - tBufStart;
                onMetric?.("decode_buffer_extract_ms", tBuf);
                const tRegionStart = performance.now();
                const pixels = applyRegionAndDownsample(buf.data, buf.width, buf.height, this.options.region ?? null, this.options.downsample ?? 1, bpc);
                const tRegion = performance.now() - tRegionStart;
                onMetric?.("decode_region_downsample_ms", tRegion);
                // When ROI/downsample crops the frame, pixels.width/height differ from full image dims.
                // buildInfo memoizes on first call (full dims from header), so we must not pass it
                // cropped dims — it would return the already-memoized full-dim object regardless.
                // Instead, derive evInfo from the base info with actual pixel dimensions.
                const baseInfo = buildInfo(buf.width, buf.height, buf.hasAlpha);
                const evInfo = (pixels.width !== buf.width || pixels.height !== buf.height)
                    ? { ...baseInfo, width: pixels.width, height: pixels.height }
                    : baseInfo;
                return { pixels, evInfo };
            };
            const hasRegion = this.options.region != null;
            const onMetric = this.options.onMetric;
            let fallbackMetricEmitted = false;
            let drainPending = false;
            let inputClosed = false;
            let pushWasmMs = 0;
            let pushCopyMs = 0;
            let pushInputWasmMs = 0;
            let pushFlushWasmMs = 0;
            let headerProbeMs = 0;
            let takeFlushedMs = 0;
            let takeFinalMs = 0;
            // IMPROVEMENT-7: Batch all queued data chunks into one WASM write per tick.
            // IMPROVEMENT-9: Guard dec_width/dec_height calls behind !headerEmitted — skip 2 WASM
            // FFI calls per chunk once the header has been emitted.
            while (!done && !this.cancelled) {
                if (!drainPending && this.chunkQueue.length <= this.readIndex) {
                    await this.waitForQueueItem();
                    if (this.cancelled)
                        return;
                }
                let result = 0;
                if (drainPending) {
                    const tPushStart = performance.now();
                    result = decPush(dec, 0, 0);
                    const tPushMs = performance.now() - tPushStart;
                    pushWasmMs += tPushMs;
                    pushFlushWasmMs += tPushMs;
                    if (result < 0)
                        throw new Error(`JXL decode error: ${decError(dec)}`);
                }
                else if (this.chunkQueue.length > this.readIndex && this.chunkQueue[this.readIndex] === null) {
                    // Close sentinel — flush remaining decoder state, then keep draining until done.
                    this.readIndex++;
                    this.compactQueue();
                    decCloseInput(dec);
                    inputClosed = true;
                    const tPushStart = performance.now();
                    result = decPush(dec, 0, 0);
                    const tPushMs = performance.now() - tPushStart;
                    pushWasmMs += tPushMs;
                    pushFlushWasmMs += tPushMs;
                    if (result < 0)
                        throw new Error(`JXL decode error: ${decError(dec)}`);
                }
                else {
                    // Pending byte count maintained incrementally — no scan needed.
                    const batchBytes = this.queuedBytes;
                    if (batchBytes <= 0)
                        continue;
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
                    const tCopyStart = performance.now();
                    pushCopyMs += performance.now() - tCopyStart;
                    const tPushStart = performance.now();
                    result = decPush(dec, chunkBufPtr, batchBytes);
                    const tPushMs = performance.now() - tPushStart;
                    pushWasmMs += tPushMs;
                    pushInputWasmMs += tPushMs;
                    if (result < 0)
                        throw new Error(`JXL decode error: ${decError(dec)}`);
                }
                if (!headerEmitted) {
                    const tHeaderProbeStart = performance.now();
                    const w = decWidth(dec);
                    const h = decHeight(dec);
                    headerProbeMs += performance.now() - tHeaderProbeStart;
                    if (w > 0 && h > 0) {
                        headerEmitted = true;
                        yield { type: "header", info: makeHeaderInfo(w, h) };
                        if (this.options.progressionTarget === "header")
                            return;
                    }
                }
                if (result === 1) {
                    drainPending = true;
                    gotRealFlush = true;
                    flushCount++;
                    const stage = flushCount === 1 ? "dc" : "pass";
                    const tTakeStart = performance.now();
                    const wrapped = takeAndWrap(decTakeFlushed(dec));
                    takeFlushedMs += performance.now() - tTakeStart;
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
                            ...(hasRegion ? { regionFallback: "full-frame-then-crop" } : {}),
                            ...(outPixels.region !== undefined ? { region: outPixels.region } : {}),
                        };
                        if (module._jxl_wasm_dec_frame_duration) {
                            applyAnimFrameMetadata(ev, module, dec);
                        }
                        yield ev;
                        if (this.options.progressionTarget !== "final" && !this.options.emitEveryPass)
                            return;
                    }
                    continue;
                }
                drainPending = false;
                if (result === 2) {
                    done = true;
                }
                else if (inputClosed) {
                    throw new Error(`JXL decode error: ${decError(dec)}`);
                }
            }
            if (done) {
                const tTakeFinalStart = performance.now();
                const wrapped = takeAndWrap(decTakeFinal(dec));
                takeFinalMs += performance.now() - tTakeFinalStart;
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
                            ...(hasRegion ? { regionFallback: "full-frame-then-crop" } : {}),
                            ...(outPixels.region !== undefined ? { region: outPixels.region } : {}),
                        };
                        if (module._jxl_wasm_dec_frame_duration) {
                            applyAnimFrameMetadata(ev, module, dec);
                        }
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
                        ...(hasRegion ? { regionFallback: "full-frame-then-crop" } : {}),
                        ...(outPixels.region !== undefined ? { region: outPixels.region } : {}),
                    };
                    if (module._jxl_wasm_dec_has_gain_map?.(dec) === 1 && module._jxl_wasm_dec_take_gain_map) {
                        const gmHandle = module._jxl_wasm_dec_take_gain_map(dec);
                        if (gmHandle !== 0) {
                            try {
                                const gmDataPtr = module._jxl_wasm_buffer_data(gmHandle);
                                const gmSize = module._jxl_wasm_buffer_size(gmHandle);
                                if (gmDataPtr !== 0 && gmSize > 0) {
                                    // Direct subarray + set instead of slice for the gain map data copy.
                                    // Consistent with other zero-alloc/copy patterns on hot decode paths.
                                    const gm = new Uint8Array(gmSize);
                                    gm.set(module.HEAPU8.subarray(gmDataPtr, gmDataPtr + gmSize));
                                    ev.gainMap = { data: gm };
                                }
                            }
                            finally {
                                module._jxl_wasm_buffer_free(gmHandle);
                            }
                        }
                    }
                    // Populate animation per-frame metadata when bridge accessors are present.
                    if (module._jxl_wasm_dec_frame_duration) {
                        applyAnimFrameMetadata(ev, module, dec);
                    }
                    yield ev;
                }
            }
            if (onMetric) {
                onMetric("progressive_decoder_push_wasm_ms", pushWasmMs);
                onMetric("progressive_decoder_push_copy_ms", pushCopyMs);
                onMetric("progressive_decoder_push_input_wasm_ms", pushInputWasmMs);
                onMetric("progressive_decoder_push_flush_wasm_ms", pushFlushWasmMs);
                onMetric("progressive_decoder_header_probe_ms", headerProbeMs);
                onMetric("progressive_decoder_take_flushed_ms", takeFlushedMs);
                onMetric("progressive_decoder_take_final_ms", takeFinalMs);
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
        let totalSize = 0;
        while (!this.cancelled) {
            await this.waitForQueueItem();
            if (this.cancelled)
                return;
            const item = this.chunkQueue[this.readIndex++];
            this.compactQueue();
            if (item === null || item === undefined)
                break;
            this.queuedBytes -= item.byteLength;
            totalSize += item.byteLength;
            allChunks.push(item);
        }
        if (this.cancelled)
            return;
        const fmt = this.options.format;
        const bpc = fmt === "rgbaf32" ? 4 : fmt === "rgba16" ? 2 : 1;
        const pixelStride = 4 * bpc;
        // Write all chunks directly into a single WASM heap buffer — no intermediate JS allocation.
        const inputPtr = module._malloc(totalSize);
        let decodedHandle = 0;
        const onMetric = this.options.onMetric;
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
            const tDecodeWasmStart = performance.now();
            const decoded = callDecodeFromPtr(module, inputPtr, totalSize, this.options.downsample ?? 1, fmt, cppDidCrop ? regionForDecode : null);
            onMetric?.("full_decoder_wasm_ms", performance.now() - tDecodeWasmStart);
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
            const tRegionStart = performance.now();
            const pixels = applyRegionAndDownsample(decoded.data, decoded.width, decoded.height, scaledRegion, 1, bpc);
            onMetric?.("full_decoder_region_downsample_ms", performance.now() - tRegionStart);
            // C++ crop path skips applyRegionAndDownsample's region-setter; restore it to match JS path.
            if (cppDidCrop)
                pixels.region = { x: 0, y: 0, w: pixels.width, h: pixels.height };
            // P1: apply bilinear resize to exact target size if requested.
            const targetW = this.options.targetWidth;
            const targetH = this.options.targetHeight;
            const fitMode = this.options.fitMode ?? "contain";
            let outPixels = pixels;
            if (targetW != null && targetH != null && targetW > 0 && targetH > 0) {
                const tResizeStart = performance.now();
                const resized = applyTargetResize(pixels.data, pixels.width, pixels.height, targetW, targetH, fitMode, bpc);
                onMetric?.("full_decoder_resize_ms", performance.now() - tResizeStart);
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
    async *seekToFrame(frameIndex) {
        if (this.eventsStarted) {
            yield { type: "error", code: "InvalidState", message: "seekToFrame cannot be called after events() has been consumed." };
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
            // Software fallback: decode all frames, emit only those at frameIndex and beyond.
            // Post-rebuild: replace inner loop with _jxl_wasm_dec_seek_to_frame(dec, frameIndex)
            // before entering the event loop to skip at the C++ level.
            const source = getCapabilities(module).progressiveDecode
                ? this.eventsProgressive(module)
                : this.eventsOneShot(module);
            for await (const ev of source) {
                if (ev.type === "header" || ev.type === "error" || ev.type === "budget_exceeded") {
                    yield ev;
                }
                else if (ev.type === "progress" || ev.type === "final") {
                    if ((ev.frameIndex ?? 0) >= frameIndex)
                        yield ev;
                }
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
    async *seekToTime(timeMs) {
        if (this.eventsStarted) {
            yield { type: "error", code: "InvalidState", message: "seekToTime cannot be called after events() has been consumed." };
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
            const source = getCapabilities(module).progressiveDecode
                ? this.eventsProgressive(module)
                : this.eventsOneShot(module);
            // targetFrame computed lazily from first event carrying animTicksPerSecond.
            // Falls back to 0 for non-animation files (yield all events).
            let targetFrame = -1;
            for await (const ev of source) {
                if (ev.type === "header" || ev.type === "error" || ev.type === "budget_exceeded") {
                    yield ev;
                }
                else if (ev.type === "progress" || ev.type === "final") {
                    if (targetFrame === -1) {
                        targetFrame = ev.animTicksPerSecond != null
                            ? Math.floor(timeMs * ev.animTicksPerSecond / 1000)
                            : 0;
                    }
                    if ((ev.frameIndex ?? 0) >= targetFrame)
                        yield ev;
                }
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
    onMetric;
    constructor(options) {
        this.options = options;
        this.sortedSidecarSizes = options.sidecarSizes ? [...options.sidecarSizes].sort((a, b) => a - b) : [];
        this.pixelByteTotal = expectedPixelBytes(options.width, options.height, options.format);
        if (options.onMetric !== undefined)
            this.onMetric = options.onMetric;
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
                const tWasmPushStart = performance.now();
                if (module._jxl_wasm_enc_pixels_ptr && module._jxl_wasm_enc_advance_written) {
                    const ptr = module._jxl_wasm_enc_pixels_ptr(this.wasmEncState, view.byteLength);
                    if (ptr === 0)
                        throw new Error("JXL streaming pixel push failed (0)");
                    module.HEAPU8.set(view, ptr);
                    const rc = module._jxl_wasm_enc_advance_written(this.wasmEncState, view.byteLength);
                    if (rc !== 0)
                        throw new Error(`JXL streaming pixel push failed (${rc})`);
                }
                else {
                    // Back-compat with older WASM bridge: temp copy into WASM, then bridge memcpy.
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
                this.onMetric?.("enc_push_pixels_ms", performance.now() - tWasmPushStart);
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
        const tLoadStart = performance.now();
        const module = await loadLibjxlModule();
        this.onMetric?.("enc_module_load_ms", performance.now() - tLoadStart);
        this.wasmModule = module;
        if (this.cancelled)
            return module;
        const caps = getCapabilities(module);
        // Use streaming input for all non-sidecar, non-gainMap paths.
        // B3: ICC/EXIF/XMP metadata is passed via jxl_wasm_enc_set_metadata so the streaming
        // path no longer falls back to the buffered encode for metadata-bearing RAW images.
        // boxOpts (compress, forceContainer) and gain map still require the buffered path.
        const wantSidecars = this.sortedSidecarSizes.length > 0 && caps.sidecars;
        const { iccProfile: effIcc, exif: effExif, xmp: effXmp } = resolveEffectiveMetadata(this.options);
        const needsBufferedPath = wantSidecars || needsBoxOptsV2(this.options) || this.options.gainMap != null;
        if (!needsBufferedPath && caps.streamingInput) {
            const distance = this.options.distance ?? distanceFromQuality(this.options.quality);
            // A3: rgb8 maps to fmtIndex 3; rgba16→1, rgbaf32→2, rgba8→0
            const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : this.options.format === "rgb8" ? 3 : 0;
            const { progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, epf, gaborish, dots, colorTransform } = resolveEncoderBridgeSettings(this.options);
            const orientation = this.options.orientation ?? 1;
            if (orientation !== 1 && !caps.orientation) {
                // Bridge lacks the _z / _v3 entrypoints. Pixels are still encoded but
                // JXL stores orientation = identity — viewers will display the sensor
                // orientation (rotated wrong for portrait shots). Rebuild jxl-wasm to
                // pick up the orientation bridge for correct output.
                // eslint-disable-next-line no-console
                console.warn(`[jxl-wasm] orientation=${orientation} requested but WASM bridge lacks _z/_v3 support. ` +
                    "Rebuild packages/jxl-wasm to enable JXL's orientation-tag fast path.");
            }
            const tCreateStart = performance.now();
            if (caps.extOptions && orientation !== 1 && module._jxl_wasm_enc_create_image_z) {
                // JXL "free rotation": record orientation in basic info, pixels stay sensor-native.
                this.wasmEncState = module._jxl_wasm_enc_create_image_z(this.options.width, this.options.height, distance, this.options.effort, fmtIndex, this.options.hasAlpha ? 1 : 0, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, epf, gaborish, dots, colorTransform, orientation);
            }
            else if (caps.extOptions && module._jxl_wasm_enc_create_image_y) {
                this.wasmEncState = module._jxl_wasm_enc_create_image_y(this.options.width, this.options.height, distance, this.options.effort, fmtIndex, this.options.hasAlpha ? 1 : 0, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, epf, gaborish, dots, colorTransform);
            }
            else if (caps.extOptions && module._jxl_wasm_enc_create_image_x) {
                this.wasmEncState = module._jxl_wasm_enc_create_image_x(this.options.width, this.options.height, distance, this.options.effort, fmtIndex, this.options.hasAlpha ? 1 : 0, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling);
            }
            else {
                this.wasmEncState = module._jxl_wasm_enc_create_image(this.options.width, this.options.height, distance, this.options.effort, fmtIndex, this.options.hasAlpha ? 1 : 0, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling);
            }
            this.onMetric?.("enc_create_image_ms", performance.now() - tCreateStart);
            if (this.wasmEncState === 0)
                throw new Error("JXL streaming encoder: pixel buffer allocation failed");
            if (this.cancelled) {
                this.freeWasmState();
                return module;
            }
            // B3: push ICC/EXIF/XMP into WASM before pixels arrive
            if (module._jxl_wasm_enc_set_metadata && (effIcc !== null || effExif !== null || effXmp !== null)) {
                const tMetaStart = performance.now();
                const iccV = effIcc ? new Uint8Array(effIcc) : new Uint8Array(0);
                const exifV = effExif ? new Uint8Array(effExif) : new Uint8Array(0);
                const xmpV = effXmp ? new Uint8Array(effXmp) : new Uint8Array(0);
                const iccPtr = iccV.byteLength > 0 ? module._malloc(iccV.byteLength) : 0;
                const exifPtr = exifV.byteLength > 0 ? module._malloc(exifV.byteLength) : 0;
                const xmpPtr = xmpV.byteLength > 0 ? module._malloc(xmpV.byteLength) : 0;
                if (iccPtr)
                    module.HEAPU8.set(iccV, iccPtr);
                if (exifPtr)
                    module.HEAPU8.set(exifV, exifPtr);
                if (xmpPtr)
                    module.HEAPU8.set(xmpV, xmpPtr);
                module._jxl_wasm_enc_set_metadata(this.wasmEncState, iccPtr, iccV.byteLength, exifPtr, exifV.byteLength, xmpPtr, xmpV.byteLength);
                if (iccPtr)
                    module._free(iccPtr);
                if (exifPtr)
                    module._free(exifPtr);
                if (xmpPtr)
                    module._free(xmpPtr);
                this.onMetric?.("enc_set_metadata_ms", performance.now() - tMetaStart);
            }
            // intrinsicSize: signal display dimensions separate from encoded pixels (Retina @2×, etc.)
            if (this.options.intrinsicSize != null && typeof module._jxl_wasm_enc_set_intrinsic_size === "function") {
                module
                    ._jxl_wasm_enc_set_intrinsic_size(this.wasmEncState, this.options.intrinsicSize.width, this.options.intrinsicSize.height);
            }
            // disablePerceptualHeuristics: bypass butteraugli/XYB psychovisual model for fair benchmarking
            if (this.options.disablePerceptualHeuristics === true && typeof module._jxl_wasm_enc_set_frame_flags === "function") {
                module
                    ._jxl_wasm_enc_set_frame_flags(this.wasmEncState, 1);
            }
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
            const extFn = this.options.format === "rgba16" ? "_jxl_wasm_encode_rgba16_x" : "_jxl_wasm_encode_rgbaf32_x";
            if (typeof module[encFn] !== "function" && typeof module[extFn] !== "function") {
                throw new CapabilityMissing(`${this.options.format} encode requires a rebuilt WASM with multi-format bridge`);
            }
        }
        // Animation encode path: multi-frame encode bypasses the single-image pixel buffer entirely.
        // Must be checked before the queuedPixelBytes guard (no pushPixels needed for animation).
        const frames = this.options.frames;
        if (frames != null && frames.length > 0) {
            const caps = getCapabilities(module);
            if (caps.animationEncode && typeof module._jxl_wasm_encode_animation === "function") {
                const distance = this.options.distance ?? distanceFromQuality(this.options.quality);
                const hasAlpha = this.options.hasAlpha ? 1 : 0;
                const fmt = this.options.format === "rgba16" ? 1 : this.options.format === "rgbaf32" ? 2 : 0;
                const { modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling } = resolveEncoderBridgeSettings(this.options);
                const { iccProfile: effIcc, exif: effExif, xmp: effXmp } = resolveEffectiveMetadata(this.options);
                const iccView = effIcc ? copyOrBorrowInput(effIcc, false) : new Uint8Array(0);
                const exifView = effExif ? copyOrBorrowInput(effExif, false) : new Uint8Array(0);
                const xmpView = effXmp ? copyOrBorrowInput(effXmp, false) : new Uint8Array(0);
                const iccPtr = iccView.byteLength > 0 ? module._malloc(iccView.byteLength) : 0;
                const exifPtr = exifView.byteLength > 0 ? module._malloc(exifView.byteLength) : 0;
                const xmpPtr = xmpView.byteLength > 0 ? module._malloc(xmpView.byteLength) : 0;
                if (iccPtr !== 0)
                    module.HEAPU8.set(iccView, iccPtr);
                if (exifPtr !== 0)
                    module.HEAPU8.set(exifView, exifPtr);
                if (xmpPtr !== 0)
                    module.HEAPU8.set(xmpView, xmpPtr);
                const { ptr: boxOptsPtr, freePtrs: boxOptsPtrs } = marshalBoxOpts(module, this.options);
                const { framesPtr, animOptsPtr, freePtrs: animFreePtrs } = marshalAnimationFrames(module, frames, this.options.animation);
                try {
                    const handle = module._jxl_wasm_encode_animation(framesPtr, frames.length, distance, this.options.effort, fmt, hasAlpha, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, iccPtr, iccView.byteLength, exifPtr, exifView.byteLength, xmpPtr, xmpView.byteLength, boxOptsPtr, animOptsPtr);
                    const encoded = takeBuffer(module, handle, "animation encode");
                    const compressedBytes = encoded.data.byteLength;
                    yield encoded.data;
                    this.encodeStats = { originalBytes: this.pixelByteTotal, compressedBytes, ratio: this.pixelByteTotal > 0 ? compressedBytes / this.pixelByteTotal : 0 };
                }
                finally {
                    for (const p of animFreePtrs)
                        module._free(p);
                    for (const p of boxOptsPtrs)
                        module._free(p);
                    if (boxOptsPtr !== 0)
                        module._free(boxOptsPtr);
                    if (iccPtr !== 0)
                        module._free(iccPtr);
                    if (exifPtr !== 0)
                        module._free(exifPtr);
                    if (xmpPtr !== 0)
                        module._free(xmpPtr);
                }
                return;
            }
            // Capability absent — fall through to single-frame encode (graceful degradation).
        }
        if (this.queuedPixelBytes !== this.pixelByteTotal) {
            throw new Error(`JXL encode expected ${this.pixelByteTotal} bytes for ${this.options.format}, got ${this.queuedPixelBytes}`);
        }
        let compressedBytes = 0;
        if (this.streamingInputActive && this.wasmEncState !== 0) {
            // #16: Streaming input path — pixels already in WASM pixel buffer.
            // enc_finish runs the encode; enc_take_chunk drains the output.
            try {
                const tFinishStart = performance.now();
                const rc = module._jxl_wasm_enc_finish(this.wasmEncState);
                if (rc !== 0)
                    throw new Error(`JXL streaming encode finish failed (${rc})`);
                this.onMetric?.("enc_finish_wasm_ms", performance.now() - tFinishStart);
                const tDrainStart = performance.now();
                let takeChunkMs = 0;
                let chunkHandle;
                while ((chunkHandle = module._jxl_wasm_enc_take_chunk(this.wasmEncState)) !== 0) {
                    const tTakeStart = performance.now();
                    const chunk = takeBuffer(module, chunkHandle, "encode");
                    takeChunkMs += performance.now() - tTakeStart;
                    compressedBytes += chunk.data.byteLength;
                    yield chunk.data;
                }
                this.onMetric?.("enc_take_chunk_ms", takeChunkMs);
                this.onMetric?.("enc_drain_ms", performance.now() - tDrainStart);
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
                const { progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling } = resolveEncoderBridgeSettings(this.options);
                // Gain map encode path: embeds pre-encoded JXL codestream as jhgm box.
                const wantGainMap = this.options.gainMap != null && caps.gainMapEncode &&
                    typeof module._jxl_wasm_encode_with_gain_map === "function";
                if (wantGainMap) {
                    const fmt = this.options.format === "rgba16" ? 1 : this.options.format === "rgbaf32" ? 2 : 0;
                    const { iccProfile: effIcc4, exif: effExif4, xmp: effXmp4 } = resolveEffectiveMetadata(this.options);
                    const iccView4 = effIcc4 ? copyOrBorrowInput(effIcc4, false) : new Uint8Array(0);
                    const exifView4 = effExif4 ? copyOrBorrowInput(effExif4, false) : new Uint8Array(0);
                    const xmpView4 = effXmp4 ? copyOrBorrowInput(effXmp4, false) : new Uint8Array(0);
                    const gmRaw = this.options.gainMap.data;
                    const gmView = gmRaw instanceof ArrayBuffer ? new Uint8Array(gmRaw) : gmRaw;
                    const iccPtr4 = iccView4.byteLength > 0 ? module._malloc(iccView4.byteLength) : 0;
                    const exifPtr4 = exifView4.byteLength > 0 ? module._malloc(exifView4.byteLength) : 0;
                    const xmpPtr4 = xmpView4.byteLength > 0 ? module._malloc(xmpView4.byteLength) : 0;
                    const gmPtr = gmView.byteLength > 0 ? module._malloc(gmView.byteLength) : 0;
                    try {
                        if (iccPtr4 !== 0)
                            module.HEAPU8.set(iccView4, iccPtr4);
                        if (exifPtr4 !== 0)
                            module.HEAPU8.set(exifView4, exifPtr4);
                        if (xmpPtr4 !== 0)
                            module.HEAPU8.set(xmpView4, xmpPtr4);
                        if (gmPtr !== 0)
                            module.HEAPU8.set(gmView, gmPtr);
                        const handle = module._jxl_wasm_encode_with_gain_map(ptr, this.options.width, this.options.height, distance, this.options.effort, fmt, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, iccPtr4, iccView4.byteLength, exifPtr4, exifView4.byteLength, xmpPtr4, xmpView4.byteLength, gmPtr, gmView.byteLength);
                        const encoded = takeBuffer(module, handle, "encode (gain map)");
                        compressedBytes += encoded.data.byteLength;
                        yield encoded.data;
                    }
                    finally {
                        if (iccPtr4 !== 0)
                            module._free(iccPtr4);
                        if (exifPtr4 !== 0)
                            module._free(exifPtr4);
                        if (xmpPtr4 !== 0)
                            module._free(xmpPtr4);
                        if (gmPtr !== 0)
                            module._free(gmPtr);
                    }
                }
                else 
                // Extra-channel encode path: per-channel alpha/extra distance or separate plane buffers.
                if (caps.extraChannelEncode && (this.options.alphaDistance != null ||
                    (this.options.extraChannels != null && this.options.extraChannels.length > 0))) {
                    const fmt = this.options.format === "rgba16" ? 1 : this.options.format === "rgbaf32" ? 2 : 0;
                    const alphaDistance = this.options.alphaDistance ?? -1;
                    const extraChannels = this.options.extraChannels ?? [];
                    const extraChannelPlanes = this.options.extraChannelPlanes ?? [];
                    const { iccProfile: effIcc2, exif: effExif2, xmp: effXmp2 } = resolveEffectiveMetadata(this.options);
                    const iccView = effIcc2 ? copyOrBorrowInput(effIcc2, false) : new Uint8Array(0);
                    const exifView = effExif2 ? copyOrBorrowInput(effExif2, false) : new Uint8Array(0);
                    const xmpView = effXmp2 ? copyOrBorrowInput(effXmp2, false) : new Uint8Array(0);
                    const iccPtr = iccView.byteLength > 0 ? module._malloc(iccView.byteLength) : 0;
                    const exifPtr = exifView.byteLength > 0 ? module._malloc(exifView.byteLength) : 0;
                    const xmpPtr = xmpView.byteLength > 0 ? module._malloc(xmpView.byteLength) : 0;
                    if (iccPtr !== 0)
                        module.HEAPU8.set(iccView, iccPtr);
                    if (exifPtr !== 0)
                        module.HEAPU8.set(exifView, exifPtr);
                    if (xmpPtr !== 0)
                        module.HEAPU8.set(xmpView, xmpPtr);
                    // Build packed WasmExtraChannel[n] descriptor array (20 bytes per entry).
                    // Layout: type(u32) | bits(u32) | distance(f32) | plane_ptr(u32) | plane_size(u32)
                    const EC_BYTES = 20;
                    const ecDescBuf = extraChannels.length > 0 ? new Uint8Array(extraChannels.length * EC_BYTES) : null;
                    const allocatedPlanePtrs = [];
                    let ecDescPtr = 0;
                    const useBoxV2 = needsBoxOptsV2(this.options) && caps.metadataBoxesV2 &&
                        typeof module._jxl_wasm_encode_rgba8_with_metadata_ec_v2 === "function";
                    const { ptr: boxOptsPtr, freePtrs: boxOptsPtrs } = useBoxV2
                        ? marshalBoxOpts(module, this.options)
                        : { ptr: 0, freePtrs: [] };
                    try {
                        if (ecDescBuf !== null) {
                            const dv = new DataView(ecDescBuf.buffer);
                            for (let i = 0; i < extraChannels.length; i++) {
                                const ec = extraChannels[i];
                                const plane = extraChannelPlanes[i];
                                const base = i * EC_BYTES;
                                let planePtrWasm = 0;
                                let planeSizeWasm = 0;
                                if (plane != null && (plane instanceof ArrayBuffer ? plane.byteLength : plane.byteLength) > 0) {
                                    const planeView = plane instanceof ArrayBuffer ? new Uint8Array(plane) : plane;
                                    planePtrWasm = module._malloc(planeView.byteLength);
                                    if (planePtrWasm !== 0) {
                                        allocatedPlanePtrs.push(planePtrWasm);
                                        module.HEAPU8.set(planeView, planePtrWasm);
                                        planeSizeWasm = planeView.byteLength;
                                    }
                                }
                                dv.setUint32(base, encodeExtraChannelType(ec.type), true);
                                dv.setUint32(base + 4, ec.bitsPerSample, true);
                                dv.setFloat32(base + 8, ec.distance ?? -1, true);
                                dv.setUint32(base + 12, planePtrWasm, true);
                                dv.setUint32(base + 16, planeSizeWasm, true);
                            }
                            ecDescPtr = module._malloc(ecDescBuf.byteLength);
                            if (ecDescPtr !== 0)
                                module.HEAPU8.set(ecDescBuf, ecDescPtr);
                        }
                        const handle = useBoxV2
                            ? module._jxl_wasm_encode_rgba8_with_metadata_ec_v2(ptr, this.options.width, this.options.height, distance, this.options.effort, fmt, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, iccPtr, iccView.byteLength, exifPtr, exifView.byteLength, xmpPtr, xmpView.byteLength, alphaDistance, ecDescPtr, extraChannels.length, boxOptsPtr)
                            : module._jxl_wasm_encode_rgba8_with_metadata_ec(ptr, this.options.width, this.options.height, distance, this.options.effort, fmt, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, iccPtr, iccView.byteLength, exifPtr, exifView.byteLength, xmpPtr, xmpView.byteLength, alphaDistance, ecDescPtr, extraChannels.length);
                        const encoded = takeBuffer(module, handle, "encode (extra channels)");
                        compressedBytes += encoded.data.byteLength;
                        yield encoded.data;
                    }
                    finally {
                        if (ecDescPtr !== 0)
                            module._free(ecDescPtr);
                        for (const p of allocatedPlanePtrs)
                            module._free(p);
                        if (iccPtr !== 0)
                            module._free(iccPtr);
                        if (exifPtr !== 0)
                            module._free(exifPtr);
                        if (xmpPtr !== 0)
                            module._free(xmpPtr);
                        boxOptsPtrs.forEach(p => module._free(p));
                        if (boxOptsPtr !== 0)
                            module._free(boxOptsPtr);
                    }
                }
                else 
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
                        let handle = caps.extOptions && module._jxl_wasm_encode_rgba8_with_sidecars_x
                            ? module._jxl_wasm_encode_rgba8_with_sidecars_x(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, dimsPtr, sortedSizes.length, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling)
                            : module._jxl_wasm_encode_rgba8_with_sidecars(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, dimsPtr, sortedSizes.length, resampling);
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
                    const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : this.options.format === "rgb8" ? 3 : 0;
                    const encState = module._jxl_wasm_enc_create();
                    try {
                        const rc = caps.extOptions && module._jxl_wasm_enc_push_pixels_x
                            ? module._jxl_wasm_enc_push_pixels_x(encState, ptr, this.options.width, this.options.height, distance, this.options.effort, fmtIndex, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling)
                            : module._jxl_wasm_enc_push_pixels(encState, ptr, this.options.width, this.options.height, distance, this.options.effort, fmtIndex, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling);
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
                    // Use metadata path if any metadata is present or box opts are needed.
                    // fmt: 0=rgba8, 1=rgba16, 2=rgbaf32, 3=rgb8 — matches bridge parameter order.
                    const fmt = this.options.format === "rgba16" ? 1 : this.options.format === "rgbaf32" ? 2 : this.options.format === "rgb8" ? 3 : 0;
                    const { iccProfile: effIcc3, exif: effExif3, xmp: effXmp3 } = resolveEffectiveMetadata(this.options);
                    const hasMetadata = effIcc3 !== null || effExif3 !== null || effXmp3 !== null || needsBoxOptsV2(this.options);
                    if (hasMetadata && module._jxl_wasm_encode_rgba8_with_metadata) {
                        const iccView = effIcc3 ? copyOrBorrowInput(effIcc3, false) : new Uint8Array(0);
                        const exifView = effExif3 ? copyOrBorrowInput(effExif3, false) : new Uint8Array(0);
                        const xmpView = effXmp3 ? copyOrBorrowInput(effXmp3, false) : new Uint8Array(0);
                        const iccPtr = iccView.byteLength > 0 ? module._malloc(iccView.byteLength) : 0;
                        const exifPtr = exifView.byteLength > 0 ? module._malloc(exifView.byteLength) : 0;
                        const xmpPtr = xmpView.byteLength > 0 ? module._malloc(xmpView.byteLength) : 0;
                        const orientationStd = this.options.orientation ?? 1;
                        const useV3Std = orientationStd !== 1 &&
                            typeof module._jxl_wasm_encode_rgba8_with_metadata_v3 === "function";
                        const useBoxV2Std = !useV3Std && needsBoxOptsV2(this.options) && caps.metadataBoxesV2 &&
                            typeof module._jxl_wasm_encode_rgba8_with_metadata_v2 === "function";
                        const { ptr: boxOptsPtr2, freePtrs: boxOptsPtrs2 } = (useV3Std || useBoxV2Std)
                            ? marshalBoxOpts(module, this.options)
                            : { ptr: 0, freePtrs: [] };
                        try {
                            if (iccPtr !== 0)
                                module.HEAPU8.set(iccView, iccPtr);
                            if (exifPtr !== 0)
                                module.HEAPU8.set(exifView, exifPtr);
                            if (xmpPtr !== 0)
                                module.HEAPU8.set(xmpView, xmpPtr);
                            if (useV3Std) {
                                handle = module._jxl_wasm_encode_rgba8_with_metadata_v3(ptr, this.options.width, this.options.height, distance, this.options.effort, fmt, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, iccPtr, iccView.byteLength, exifPtr, exifView.byteLength, xmpPtr, xmpView.byteLength, boxOptsPtr2, orientationStd);
                            }
                            else if (useBoxV2Std) {
                                handle = module._jxl_wasm_encode_rgba8_with_metadata_v2(ptr, this.options.width, this.options.height, distance, this.options.effort, fmt, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, iccPtr, iccView.byteLength, exifPtr, exifView.byteLength, xmpPtr, xmpView.byteLength, boxOptsPtr2);
                            }
                            else {
                                handle = caps.extOptions && module._jxl_wasm_encode_rgba8_with_metadata_x
                                    ? module._jxl_wasm_encode_rgba8_with_metadata_x(ptr, this.options.width, this.options.height, distance, this.options.effort, fmt, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling, iccPtr, iccView.byteLength, exifPtr, exifView.byteLength, xmpPtr, xmpView.byteLength)
                                    : module._jxl_wasm_encode_rgba8_with_metadata(ptr, this.options.width, this.options.height, distance, this.options.effort, fmt, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling, iccPtr, iccView.byteLength, exifPtr, exifView.byteLength, xmpPtr, xmpView.byteLength);
                            }
                        }
                        finally {
                            if (iccPtr !== 0)
                                module._free(iccPtr);
                            if (exifPtr !== 0)
                                module._free(exifPtr);
                            if (xmpPtr !== 0)
                                module._free(xmpPtr);
                            boxOptsPtrs2.forEach(p => module._free(p));
                            if (boxOptsPtr2 !== 0)
                                module._free(boxOptsPtr2);
                        }
                    }
                    else {
                        // Fallback: plain encode (no metadata) used when bridge fn absent
                        // or when no metadata was provided.
                        if (this.options.format === "rgba16") {
                            handle = caps.extOptions && module._jxl_wasm_encode_rgba16_x
                                ? module._jxl_wasm_encode_rgba16_x(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling)
                                : module._jxl_wasm_encode_rgba16
                                    ? module._jxl_wasm_encode_rgba16(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling)
                                    : module._jxl_wasm_encode_rgba8(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling);
                        }
                        else if (this.options.format === "rgbaf32") {
                            handle = caps.extOptions && module._jxl_wasm_encode_rgbaf32_x
                                ? module._jxl_wasm_encode_rgbaf32_x(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling)
                                : module._jxl_wasm_encode_rgbaf32
                                    ? module._jxl_wasm_encode_rgbaf32(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling)
                                    : module._jxl_wasm_encode_rgba8(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling);
                        }
                        else {
                            handle = caps.extOptions && module._jxl_wasm_encode_rgba8_x
                                ? module._jxl_wasm_encode_rgba8_x(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, modular, brotliEffort, decodingSpeed, photonNoiseIso, resampling)
                                : module._jxl_wasm_encode_rgba8(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling);
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
    const awaitedPromise = modulePromise;
    const mod = await awaitedPromise;
    // Only write to cachedModule if the promise has not been invalidated by a
    // concurrent setForcedTier() / setJxlModuleFactoryForTesting() call.
    if (modulePromise === awaitedPromise)
        cachedModule = mod;
    return mod;
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
    if (isBunRuntime() && tier.endsWith("-mt")) {
        options.mainScriptUrlOrBlob = makeBunPthreadBootstrap(new URL(`jxl-core.${tier}.js`, baseUrl).href);
    }
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
    const load = () => factory(options);
    return isBunRuntime() && tier.endsWith("-mt") ? await withBunPthreadWorkerUnref(load) : await load();
}
function isBunRuntime() {
    return typeof globalThis !== "undefined" && "Bun" in globalThis;
}
function makeBunPthreadBootstrap(moduleUrl) {
    return new Blob([
        [
            'globalThis.WorkerGlobalScope ??= function WorkerGlobalScope() {};',
            'try {',
            '  Object.defineProperty(globalThis.self, "name", { value: "em-pthread", configurable: true });',
            '} catch {',
            '  globalThis.self.name = "em-pthread";',
            '}',
            `await import(${JSON.stringify(moduleUrl)});`,
        ].join("\n"),
    ], { type: "text/javascript" });
}
async function withBunPthreadWorkerUnref(load) {
    const global = globalThis;
    const OriginalWorker = global.Worker;
    if (typeof OriginalWorker !== "function")
        return await load();
    global.Worker = class BunUnrefPthreadWorker extends OriginalWorker {
        constructor(...args) {
            super(...args);
            const options = args[1];
            const worker = this;
            if (options?.name === "em-pthread" && typeof worker.unref === "function") {
                worker.unref();
            }
        }
    };
    try {
        return await load();
    }
    finally {
        global.Worker = OriginalWorker;
    }
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
        extOptions: typeof module._jxl_wasm_encode_rgba8_x === "function",
        extraChannelEncode: typeof module._jxl_wasm_encode_rgba8_with_metadata_ec === "function",
        metadataBoxesV2: typeof module._jxl_wasm_encode_rgba8_with_metadata_v2 === "function",
        orientation: typeof module._jxl_wasm_enc_create_image_z === "function" ||
            typeof module._jxl_wasm_encode_rgba8_with_metadata_v3 === "function",
        gainMapEncode: typeof module._jxl_wasm_encode_with_gain_map === "function",
        animationEncode: typeof module._jxl_wasm_encode_animation === "function",
        animationSeek: typeof module._jxl_wasm_dec_seek_to_frame === "function",
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
    const channels = format === "rgb8" ? 3 : 4;
    const bytes = width * height * channels * bpc;
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
// Uint8Array with copy=false is the zero-copy fast path used by the worker when it has exclusive ownership
// of the transferred buffer.
function copyOrBorrowInput(value, copy) {
    if (value instanceof ArrayBuffer)
        return new Uint8Array(value);
    if (!copy)
        return value;
    // Only pay for the copy when the caller explicitly asked for safety or is reusing the buffer.
    return value.slice();
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
            const dstStart = y * outWidth * stride;
            if (stride === 4) {
                // Direct byte copy for common rgba8 crop (no subarray object).
                for (let i = 0; i < outWidth * 4; i++) {
                    out[dstStart + i] = data[srcStart + i];
                }
            }
            else {
                out.set(data.subarray(srcStart, srcStart + outWidth * stride), dstStart);
            }
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
            if (stride === 8) {
                // Zero-alloc direct copy for common rgba16 downsample case.
                for (let x = 0; x < outWidth; x++) {
                    const s = srcRowBase + (sourceRegion.x + Math.min(sourceRegion.w - 1, x * downsample)) * 8;
                    const d = dstRowBase + x * 8;
                    out[d] = data[s];
                    out[d + 1] = data[s + 1];
                    out[d + 2] = data[s + 2];
                    out[d + 3] = data[s + 3];
                    out[d + 4] = data[s + 4];
                    out[d + 5] = data[s + 5];
                    out[d + 6] = data[s + 6];
                    out[d + 7] = data[s + 7];
                }
            }
            else {
                for (let x = 0; x < outWidth; x++) {
                    const src = srcRowBase + (sourceRegion.x + Math.min(sourceRegion.w - 1, x * downsample)) * stride;
                    const dst = dstRowBase + x * stride;
                    if (stride === 16) {
                        // Direct for f32 downsample (rare but matches style).
                        out[dst] = data[src];
                        out[dst + 1] = data[src + 1];
                        out[dst + 4] = data[src + 4];
                        out[dst + 5] = data[src + 5];
                        out[dst + 8] = data[src + 8];
                        out[dst + 9] = data[src + 9];
                        out[dst + 12] = data[src + 12];
                        out[dst + 13] = data[src + 13];
                    }
                    else {
                        out.set(data.subarray(src, src + stride), dst);
                    }
                }
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
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
/** Allocate WASM heap, copy the view, track the pointer for later free. Returns the ptr (0 on failure). */
function mallocAndCopy(module, view, freePtrs) {
    if (view.byteLength === 0)
        return 0;
    const ptr = module._malloc(view.byteLength);
    if (ptr !== 0) {
        module.HEAPU8.set(view, ptr);
        freePtrs.push(ptr);
    }
    return ptr;
}
function buildResizeAxis(srcSize, dstSize) {
    const i0 = new Int32Array(dstSize);
    const i1 = new Int32Array(dstSize);
    const t = new Float32Array(dstSize);
    const scale = srcSize / dstSize;
    for (let d = 0; d < dstSize; d++) {
        const f = (d + 0.5) * scale - 0.5;
        const base = Math.max(0, Math.floor(f));
        i0[d] = base;
        i1[d] = Math.min(srcSize - 1, base + 1);
        t[d] = f - base;
    }
    return { i0, i1, t };
}
function bilinearResize(src, srcW, srcH, dstW, dstH, stride) {
    if (srcW === dstW && srcH === dstH)
        return src;
    // Similar big-brain fast path as the Rust downscalers:
    // When the scale is exact integer (very common for target sizes), skip the
    // expensive axis table allocation + f32 lerp and use direct stepping.
    if (srcW % dstW === 0 && srcH % dstH === 0) {
        const xstep = srcW / dstW;
        const ystep = srcH / dstH;
        const dst = new Uint8Array(dstW * dstH * stride);
        for (let dy = 0; dy < dstH; dy++) {
            const sy = dy * ystep;
            const srcRow = sy * srcW * stride;
            const dstRow = dy * dstW * stride;
            if (stride === 4) {
                // Zero-alloc fast path for the dominant rgba8 case.
                for (let dx = 0; dx < dstW; dx++) {
                    const s = srcRow + dx * xstep * 4;
                    const d = dstRow + dx * 4;
                    dst[d] = src[s];
                    dst[d + 1] = src[s + 1];
                    dst[d + 2] = src[s + 2];
                    dst[d + 3] = src[s + 3];
                }
            }
            else if (stride === 8) {
                // Zero-alloc for rgba16 exact-integer resize (lightbox 16-bit flows).
                for (let dx = 0; dx < dstW; dx++) {
                    const s = srcRow + dx * xstep * 8;
                    const d = dstRow + dx * 8;
                    dst[d] = src[s];
                    dst[d + 1] = src[s + 1];
                    dst[d + 2] = src[s + 2];
                    dst[d + 3] = src[s + 3];
                    dst[d + 4] = src[s + 4];
                    dst[d + 5] = src[s + 5];
                    dst[d + 6] = src[s + 6];
                    dst[d + 7] = src[s + 7];
                }
            }
            else {
                for (let dx = 0; dx < dstW; dx++) {
                    const sx = dx * xstep;
                    const s = srcRow + sx * stride;
                    const d = dstRow + dx * stride;
                    if (stride === 16) {
                        // Direct for f32 (rgbaf32) exact resize – rare but consistent style.
                        dst[d] = src[s];
                        dst[d + 1] = src[s + 1];
                        dst[d + 4] = src[s + 4];
                        dst[d + 5] = src[s + 5];
                        dst[d + 8] = src[s + 8];
                        dst[d + 9] = src[s + 9];
                        dst[d + 12] = src[s + 12];
                        dst[d + 13] = src[s + 13];
                    }
                    else {
                        dst.set(src.subarray(s, s + stride), d);
                    }
                }
            }
        }
        return dst;
    }
    const dst = new Uint8Array(dstW * dstH * stride);
    const xAxis = buildResizeAxis(srcW, dstW);
    const yAxis = buildResizeAxis(srcH, dstH);
    if (stride === 4) {
        for (let dy = 0; dy < dstH; dy++) {
            const y0 = yAxis.i0[dy];
            const y1 = yAxis.i1[dy];
            const yt = yAxis.t[dy];
            const row00 = y0 * srcW * 4;
            const row10 = y1 * srcW * 4;
            for (let dx = 0; dx < dstW; dx++) {
                const x0 = xAxis.i0[dx];
                const x1 = xAxis.i1[dx];
                const xt = xAxis.t[dx];
                const topLeft = row00 + x0 * 4;
                const topRight = row00 + x1 * 4;
                const bottomLeft = row10 + x0 * 4;
                const bottomRight = row10 + x1 * 4;
                const dstOff = (dy * dstW + dx) * 4;
                for (let c = 0; c < 4; c++) {
                    const tl = src[topLeft + c];
                    const tr = src[topRight + c];
                    const bl = src[bottomLeft + c];
                    const br = src[bottomRight + c];
                    dst[dstOff + c] = Math.round(tl * (1 - xt) * (1 - yt) + tr * xt * (1 - yt) + bl * (1 - xt) * yt + br * xt * yt);
                }
            }
        }
    }
    else if (stride === 8) {
        if (IS_LITTLE_ENDIAN) {
            const srcView = new Uint16Array(src.buffer, src.byteOffset, src.byteLength >> 1);
            const dstView = new Uint16Array(dst.buffer);
            for (let dy = 0; dy < dstH; dy++) {
                const y0 = yAxis.i0[dy];
                const y1 = yAxis.i1[dy];
                const yt = yAxis.t[dy];
                const row00 = y0 * srcW * 4;
                const row10 = y1 * srcW * 4;
                for (let dx = 0; dx < dstW; dx++) {
                    const x0 = xAxis.i0[dx];
                    const x1 = xAxis.i1[dx];
                    const xt = xAxis.t[dx];
                    const topLeft = row00 + x0 * 4;
                    const topRight = row00 + x1 * 4;
                    const bottomLeft = row10 + x0 * 4;
                    const bottomRight = row10 + x1 * 4;
                    const dstOff = (dy * dstW + dx) * 4;
                    for (let c = 0; c < 4; c++) {
                        const tl = srcView[topLeft + c];
                        const tr = srcView[topRight + c];
                        const bl = srcView[bottomLeft + c];
                        const br = srcView[bottomRight + c];
                        dstView[dstOff + c] = Math.max(0, Math.min(65535, Math.round(tl * (1 - xt) * (1 - yt) + tr * xt * (1 - yt) + bl * (1 - xt) * yt + br * xt * yt)));
                    }
                }
            }
        }
        else {
            const srcView = new DataView(src.buffer, src.byteOffset, src.byteLength);
            const dstView = new DataView(dst.buffer);
            for (let dy = 0; dy < dstH; dy++) {
                const y0 = yAxis.i0[dy];
                const y1 = yAxis.i1[dy];
                const yt = yAxis.t[dy];
                for (let dx = 0; dx < dstW; dx++) {
                    const x0 = xAxis.i0[dx];
                    const x1 = xAxis.i1[dx];
                    const xt = xAxis.t[dx];
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
    }
    else {
        if (IS_LITTLE_ENDIAN) {
            const srcView = new Float32Array(src.buffer, src.byteOffset, src.byteLength >> 2);
            const dstView = new Float32Array(dst.buffer);
            for (let dy = 0; dy < dstH; dy++) {
                const y0 = yAxis.i0[dy];
                const y1 = yAxis.i1[dy];
                const yt = yAxis.t[dy];
                const row00 = y0 * srcW * 4;
                const row10 = y1 * srcW * 4;
                for (let dx = 0; dx < dstW; dx++) {
                    const x0 = xAxis.i0[dx];
                    const x1 = xAxis.i1[dx];
                    const xt = xAxis.t[dx];
                    const topLeft = row00 + x0 * 4;
                    const topRight = row00 + x1 * 4;
                    const bottomLeft = row10 + x0 * 4;
                    const bottomRight = row10 + x1 * 4;
                    const dstOff = (dy * dstW + dx) * 4;
                    for (let c = 0; c < 4; c++) {
                        const tl = srcView[topLeft + c];
                        const tr = srcView[topRight + c];
                        const bl = srcView[bottomLeft + c];
                        const br = srcView[bottomRight + c];
                        dstView[dstOff + c] = tl * (1 - xt) * (1 - yt) + tr * xt * (1 - yt) + bl * (1 - xt) * yt + br * xt * yt;
                    }
                }
            }
        }
        else {
            const srcView = new DataView(src.buffer, src.byteOffset, src.byteLength);
            const dstView = new DataView(dst.buffer);
            for (let dy = 0; dy < dstH; dy++) {
                const y0 = yAxis.i0[dy];
                const y1 = yAxis.i1[dy];
                const yt = yAxis.t[dy];
                for (let dx = 0; dx < dstW; dx++) {
                    const x0 = xAxis.i0[dx];
                    const x1 = xAxis.i1[dx];
                    const xt = xAxis.t[dx];
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
    }
    return dst;
}
function applyTargetResize(src, srcW, srcH, targetW, targetH, fitMode, bpc) {
    if (srcW === targetW && srcH === targetH) {
        return { data: src, width: srcW, height: srcH };
    }
    const stride = 4 * bpc;
    if (fitMode === "stretch") {
        return { data: bilinearResize(src, srcW, srcH, targetW, targetH, stride), width: targetW, height: targetH };
    }
    if (fitMode === "contain") {
        const scale = Math.min(targetW / srcW, targetH / srcH);
        const dstW = Math.max(1, Math.round(srcW * scale));
        const dstH = Math.max(1, Math.round(srcH * scale));
        if (dstW === srcW && dstH === srcH)
            return { data: src, width: srcW, height: srcH };
        return { data: bilinearResize(src, srcW, srcH, dstW, dstH, stride), width: dstW, height: dstH };
    }
    // cover: scale up so both dims >= target, then center-crop
    const scale = Math.max(targetW / srcW, targetH / srcH);
    const scaledW = Math.max(targetW, Math.round(srcW * scale));
    const scaledH = Math.max(targetH, Math.round(srcH * scale));
    const scaled = (scaledW === srcW && scaledH === srcH) ? src : bilinearResize(src, srcW, srcH, scaledW, scaledH, stride);
    const cropX = Math.floor((scaledW - targetW) / 2);
    const cropY = Math.floor((scaledH - targetH) / 2);
    const cropped = applyRegionAndDownsample(scaled, scaledW, scaledH, { x: cropX, y: cropY, w: targetW, h: targetH }, 1, bpc);
    return { data: cropped.data, width: targetW, height: targetH };
}
function pickDownsample(options) {
    const region = options.region ?? null;
    const targetWidth = options.targetWidth ?? null;
    const targetHeight = options.targetHeight ?? null;
    if (targetWidth == null || targetHeight == null || targetWidth <= 0 || targetHeight <= 0) {
        return 1;
    }
    const sourceW = region !== null ? region.w : (options.imageWidth ?? null);
    const sourceH = region !== null ? region.h : (options.imageHeight ?? null);
    if (sourceW == null || sourceH == null)
        return 1;
    const sourceLongEdge = Math.max(sourceW, sourceH);
    const targetLongEdge = Math.max(targetWidth, targetHeight);
    for (const factor of [8, 4, 2]) {
        if (Math.ceil(sourceLongEdge / factor) >= targetLongEdge)
            return factor;
    }
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