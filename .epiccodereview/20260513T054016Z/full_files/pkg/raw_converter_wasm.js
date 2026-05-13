/* @ts-self-types="./raw_converter_wasm.d.ts" */

/**
 * Result of processing an ORF: RGB8 buffer + dims (post-orientation).
 */
export class ProcessResult {
    static __wrap(ptr) {
        const obj = Object.create(ProcessResult.prototype);
        obj.__wbg_ptr = ptr;
        ProcessResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProcessResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_processresult_free(ptr, 0);
    }
    /**
     * @returns {boolean}
     */
    get color_matrix_from_mn() {
        const ret = wasm.__wbg_get_processresult_color_matrix_from_mn(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    get decompress_ms() {
        const ret = wasm.__wbg_get_processresult_decompress_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get demosaic_ms() {
        const ret = wasm.__wbg_get_processresult_demosaic_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get exposure_den() {
        const ret = wasm.__wbg_get_processresult_exposure_den(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get exposure_num() {
        const ret = wasm.__wbg_get_processresult_exposure_num(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get fnumber_den() {
        const ret = wasm.__wbg_get_processresult_fnumber_den(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get fnumber_num() {
        const ret = wasm.__wbg_get_processresult_fnumber_num(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get focal_length_35() {
        const ret = wasm.__wbg_get_processresult_focal_length_35(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get focal_length_den() {
        const ret = wasm.__wbg_get_processresult_focal_length_den(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get focal_length_num() {
        const ret = wasm.__wbg_get_processresult_focal_length_num(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get gps_alt() {
        const ret = wasm.__wbg_get_processresult_gps_alt(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get gps_lat() {
        const ret = wasm.__wbg_get_processresult_gps_lat(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get gps_lon() {
        const ret = wasm.__wbg_get_processresult_gps_lon(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    get has_gps() {
        const ret = wasm.__wbg_get_processresult_has_gps(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.__wbg_get_processresult_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get iso() {
        const ret = wasm.__wbg_get_processresult_iso(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get lb_h() {
        const ret = wasm.__wbg_get_processresult_lb_h(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get lb_w() {
        const ret = wasm.__wbg_get_processresult_lb_w(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get orient_ms() {
        const ret = wasm.__wbg_get_processresult_orient_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get orientation() {
        const ret = wasm.__wbg_get_processresult_orientation(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get quality() {
        const ret = wasm.__wbg_get_processresult_quality(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get thumb_h() {
        const ret = wasm.__wbg_get_processresult_thumb_h(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get thumb_w() {
        const ret = wasm.__wbg_get_processresult_thumb_w(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get tonemap_ms() {
        const ret = wasm.__wbg_get_processresult_tonemap_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get wb_b_used() {
        const ret = wasm.__wbg_get_processresult_wb_b_used(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    get wb_from_camera() {
        const ret = wasm.__wbg_get_processresult_wb_from_camera(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    get wb_mode() {
        const ret = wasm.__wbg_get_processresult_wb_mode(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get wb_r_used() {
        const ret = wasm.__wbg_get_processresult_wb_r_used(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get width() {
        const ret = wasm.__wbg_get_processresult_width(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Return the color matrix used (9 floats, row-major).
     * @returns {Float32Array}
     */
    color_matrix_used() {
        const ret = wasm.processresult_color_matrix_used(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {string}
     */
    get datetime() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.processresult_datetime(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get lens() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.processresult_lens(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get make() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.processresult_make(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get model() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.processresult_model(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Borrow the RGB buffer; copies into a fresh JS `Uint8Array`.
     * @returns {Uint8Array}
     */
    rgb() {
        const ret = wasm.processresult_rgb(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Move the RGB buffer out as a `Uint8Array`.  Caller owns the bytes.
     * @returns {Uint8Array}
     */
    take_rgb() {
        const ret = wasm.processresult_take_rgb(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Move the lightbox-sized packed u16 LE buffer out.  Caller owns the bytes.
     * @returns {Uint8Array}
     */
    take_rgb16_lb() {
        const ret = wasm.processresult_take_rgb16_lb(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Move the thumb-sized packed u16 LE buffer out.  Caller owns the bytes.
     * @returns {Uint8Array}
     */
    take_rgb16_thumb() {
        const ret = wasm.processresult_take_rgb16_thumb(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) ProcessResult.prototype[Symbol.dispose] = ProcessResult.prototype.free;

/**
 * Re-apply tonemap + orientation to a cached lightbox-sized rgb16 buffer.
 *
 * `rgb16_bytes` is packed u16 LE (6 bytes per pixel).
 * `color_matrix_flat` is 9 f32s row-major; pass a slice of len != 9 to use the
 * built-in fallback.
 * @param {Uint8Array} rgb16_bytes
 * @param {number} width
 * @param {number} height
 * @param {number} orientation
 * @param {number} wb_r
 * @param {number} wb_b
 * @param {Float32Array} color_matrix_flat
 * @param {number} exposure_ev
 * @param {number} contrast
 * @param {number} highlights
 * @param {number} shadows
 * @param {number} whites
 * @param {number} blacks
 * @param {number} saturation
 * @param {number} vibrance
 * @param {number} temp
 * @param {number} tint
 * @param {number} texture
 * @param {number} clarity
 * @returns {Uint8Array}
 */
export function apply_look(rgb16_bytes, width, height, orientation, wb_r, wb_b, color_matrix_flat, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, texture, clarity) {
    const ptr0 = passArray8ToWasm0(rgb16_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(color_matrix_flat, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.apply_look(ptr0, len0, width, height, orientation, wb_r, wb_b, ptr1, len1, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, texture, clarity);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * Box-filter downscale an RGB8 buffer.  Useful for thumbnail generation.
 * @param {Uint8Array} src
 * @param {number} src_w
 * @param {number} src_h
 * @param {number} dst_w
 * @param {number} dst_h
 * @returns {Uint8Array}
 */
export function downscale_rgb(src, src_w, src_h, dst_w, dst_h) {
    const ptr0 = passArray8ToWasm0(src, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.downscale_rgb(ptr0, len0, src_w, src_h, dst_w, dst_h);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Parse + decode an ORF file blob.  Returns an error string on failure.
 *
 * All look params are LR-style, zero-centred (-1..+1 normalised), except
 * `exposure_ev` which is in stops.  `wb_r_override` / `wb_b_override`:
 * pass NaN (or ≤0) to use MakerNote / defaults.
 * @param {Uint8Array} data
 * @param {number} exposure_ev
 * @param {number} contrast
 * @param {number} highlights
 * @param {number} shadows
 * @param {number} whites
 * @param {number} blacks
 * @param {number} saturation
 * @param {number} vibrance
 * @param {number} temp
 * @param {number} tint
 * @param {number} wb_r_override
 * @param {number} wb_b_override
 * @param {number} texture
 * @param {number} clarity
 * @returns {ProcessResult}
 */
export function process_orf(data, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, wb_r_override, wb_b_override, texture, clarity) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.process_orf(ptr0, len0, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, wb_r_override, wb_b_override, texture, clarity);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ProcessResult.__wrap(ret[0]);
}

/**
 * Convert interleaved RGB8 → RGBA8 (alpha = 255).  HTML canvas wants RGBA.
 * @param {Uint8Array} rgb
 * @returns {Uint8Array}
 */
export function rgb_to_rgba(rgb) {
    const ptr0 = passArray8ToWasm0(rgb, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgb_to_rgba(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_bce6d499ff0a4aff: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_is_undefined_35bb9f4c7fd651d5: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_throw_9c31b086c2b26051: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_instanceof_Window_faa5cf994f49cca7: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Window;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_WorkerGlobalScope_a93ee1765e6a23bf: function(arg0) {
            let result;
            try {
                result = arg0 instanceof WorkerGlobalScope;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_now_3cd905700d21a70b: function(arg0) {
            const ret = arg0.now();
            return ret;
        },
        __wbg_performance_a22a4e2bf3e69855: function(arg0) {
            const ret = arg0.performance;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_performance_ddd4e7eeef6254f3: function(arg0) {
            const ret = arg0.performance;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_02344c9b09eb08a9: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_ac6d4ac874d5cd54: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_9b2406c23aeb2023: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_b34d2126934e16ba: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./raw_converter_wasm_bg.js": import0,
    };
}

const ProcessResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_processresult_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('raw_converter_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
