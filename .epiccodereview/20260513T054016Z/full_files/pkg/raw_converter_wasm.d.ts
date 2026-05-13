/* tslint:disable */
/* eslint-disable */

/**
 * Result of processing an ORF: RGB8 buffer + dims (post-orientation).
 */
export class ProcessResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Return the color matrix used (9 floats, row-major).
     */
    color_matrix_used(): Float32Array;
    /**
     * Borrow the RGB buffer; copies into a fresh JS `Uint8Array`.
     */
    rgb(): Uint8Array;
    /**
     * Move the RGB buffer out as a `Uint8Array`.  Caller owns the bytes.
     */
    take_rgb(): Uint8Array;
    /**
     * Move the lightbox-sized packed u16 LE buffer out.  Caller owns the bytes.
     */
    take_rgb16_lb(): Uint8Array;
    /**
     * Move the thumb-sized packed u16 LE buffer out.  Caller owns the bytes.
     */
    take_rgb16_thumb(): Uint8Array;
    readonly color_matrix_from_mn: boolean;
    readonly decompress_ms: number;
    readonly demosaic_ms: number;
    readonly exposure_den: number;
    readonly exposure_num: number;
    readonly fnumber_den: number;
    readonly fnumber_num: number;
    readonly focal_length_35: number;
    readonly focal_length_den: number;
    readonly focal_length_num: number;
    readonly gps_alt: number;
    readonly gps_lat: number;
    readonly gps_lon: number;
    readonly has_gps: boolean;
    readonly height: number;
    readonly iso: number;
    readonly lb_h: number;
    readonly lb_w: number;
    readonly orient_ms: number;
    readonly orientation: number;
    readonly quality: number;
    readonly thumb_h: number;
    readonly thumb_w: number;
    readonly tonemap_ms: number;
    readonly wb_b_used: number;
    readonly wb_from_camera: boolean;
    readonly wb_mode: number;
    readonly wb_r_used: number;
    readonly width: number;
    readonly datetime: string;
    readonly lens: string;
    readonly make: string;
    readonly model: string;
}

/**
 * Re-apply tonemap + orientation to a cached lightbox-sized rgb16 buffer.
 *
 * `rgb16_bytes` is packed u16 LE (6 bytes per pixel).
 * `color_matrix_flat` is 9 f32s row-major; pass a slice of len != 9 to use the
 * built-in fallback.
 */
export function apply_look(rgb16_bytes: Uint8Array, width: number, height: number, orientation: number, wb_r: number, wb_b: number, color_matrix_flat: Float32Array, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, texture: number, clarity: number): Uint8Array;

/**
 * Box-filter downscale an RGB8 buffer.  Useful for thumbnail generation.
 */
export function downscale_rgb(src: Uint8Array, src_w: number, src_h: number, dst_w: number, dst_h: number): Uint8Array;

/**
 * Parse + decode an ORF file blob.  Returns an error string on failure.
 *
 * All look params are LR-style, zero-centred (-1..+1 normalised), except
 * `exposure_ev` which is in stops.  `wb_r_override` / `wb_b_override`:
 * pass NaN (or ≤0) to use MakerNote / defaults.
 */
export function process_orf(data: Uint8Array, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, wb_r_override: number, wb_b_override: number, texture: number, clarity: number): ProcessResult;

/**
 * Convert interleaved RGB8 → RGBA8 (alpha = 255).  HTML canvas wants RGBA.
 */
export function rgb_to_rgba(rgb: Uint8Array): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_get_processresult_color_matrix_from_mn: (a: number) => number;
    readonly __wbg_get_processresult_decompress_ms: (a: number) => number;
    readonly __wbg_get_processresult_demosaic_ms: (a: number) => number;
    readonly __wbg_get_processresult_exposure_den: (a: number) => number;
    readonly __wbg_get_processresult_exposure_num: (a: number) => number;
    readonly __wbg_get_processresult_fnumber_den: (a: number) => number;
    readonly __wbg_get_processresult_fnumber_num: (a: number) => number;
    readonly __wbg_get_processresult_focal_length_35: (a: number) => number;
    readonly __wbg_get_processresult_focal_length_den: (a: number) => number;
    readonly __wbg_get_processresult_focal_length_num: (a: number) => number;
    readonly __wbg_get_processresult_gps_alt: (a: number) => number;
    readonly __wbg_get_processresult_gps_lat: (a: number) => number;
    readonly __wbg_get_processresult_gps_lon: (a: number) => number;
    readonly __wbg_get_processresult_has_gps: (a: number) => number;
    readonly __wbg_get_processresult_height: (a: number) => number;
    readonly __wbg_get_processresult_iso: (a: number) => number;
    readonly __wbg_get_processresult_lb_h: (a: number) => number;
    readonly __wbg_get_processresult_lb_w: (a: number) => number;
    readonly __wbg_get_processresult_orient_ms: (a: number) => number;
    readonly __wbg_get_processresult_orientation: (a: number) => number;
    readonly __wbg_get_processresult_quality: (a: number) => number;
    readonly __wbg_get_processresult_thumb_h: (a: number) => number;
    readonly __wbg_get_processresult_thumb_w: (a: number) => number;
    readonly __wbg_get_processresult_tonemap_ms: (a: number) => number;
    readonly __wbg_get_processresult_wb_b_used: (a: number) => number;
    readonly __wbg_get_processresult_wb_from_camera: (a: number) => number;
    readonly __wbg_get_processresult_wb_mode: (a: number) => number;
    readonly __wbg_get_processresult_wb_r_used: (a: number) => number;
    readonly __wbg_get_processresult_width: (a: number) => number;
    readonly __wbg_processresult_free: (a: number, b: number) => void;
    readonly apply_look: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number) => [number, number, number, number];
    readonly downscale_rgb: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly process_orf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => [number, number, number];
    readonly processresult_color_matrix_used: (a: number) => [number, number];
    readonly processresult_datetime: (a: number) => [number, number];
    readonly processresult_lens: (a: number) => [number, number];
    readonly processresult_make: (a: number) => [number, number];
    readonly processresult_model: (a: number) => [number, number];
    readonly processresult_rgb: (a: number) => [number, number];
    readonly processresult_take_rgb: (a: number) => [number, number];
    readonly processresult_take_rgb16_lb: (a: number) => [number, number];
    readonly processresult_take_rgb16_thumb: (a: number) => [number, number];
    readonly rgb_to_rgba: (a: number, b: number) => [number, number];
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
