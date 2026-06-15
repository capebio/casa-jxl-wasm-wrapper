/* tslint:disable */
/* eslint-disable */

/**
 * Timing results for the decompress + demosaic stages only.
 * Skips tonemap, downscale, and orientation — isolates raw decode cost.
 */
export class DecodeBench {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly decompress_ms: number;
    readonly demosaic_ms: number;
    readonly height: number;
    readonly width: number;
}

/**
 * WASM-resident rendering state for a single image (lightbox or thumbnail).
 *
 * Owns the pre-tonemapped RGB16 buffer.  Slider changes call `render()` without
 * transferring pixel data between JS and WASM — the JS→WASM transfer happens once
 * at construction; every subsequent edit stays inside WASM.
 *
 * When `texture` and `clarity` are both zero (the common case), `render` reads the
 * internal buffer without cloning.  When either is nonzero, a clone is made before
 * in-place sharpening so the cached buffer is never mutated.
 */
export class LookRenderer {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Construct from a packed u16-LE buffer (6 bytes per pixel, as returned by
     * `take_rgb16_lb` / `take_rgb16_thumb`), dims, EXIF orientation, and a
     * 9-element row-major colour matrix.  Pass a slice of length != 9 to use
     * the built-in `CAM_TO_SRGB` fallback.
     */
    constructor(rgb16_bytes: Uint8Array, width: number, height: number, orientation: number, color_matrix_flat: Float32Array);
    /**
     * Variant of `new` that lets the caller opt out of CPU rotation in
     * `render()`. When `apply_rotation` is `false`, `render()` returns
     * sensor-orientation RGB8 (same dims as `rgb16` source) and the JS side
     * must apply the EXIF rotation at display time (canvas/CSS transform).
     * Saves a full-buffer transpose per slider tick for non-identity orientations.
     */
    static new_with_options(rgb16_bytes: Uint8Array, width: number, height: number, orientation: number, color_matrix_flat: Float32Array, apply_rotation: boolean): LookRenderer;
    /**
     * Apply look parameters and return an RGB8 buffer (post-orientation).
     * Only the output RGB8 crosses the WASM boundary on each call.
     */
    render(wb_r: number, wb_b: number, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, texture: number, clarity: number): Uint8Array;
    readonly native_height: number;
    /**
     * Source-buffer dimensions (sensor orientation, pre-rotation).
     */
    readonly native_width: number;
    /**
     * EXIF orientation tag (1..8) stored at construction. Consumers using
     * `apply_rotation=false` read this to drive display-time rotation.
     */
    readonly orientation: number;
}

/**
 * EXIF metadata extracted without demosaic/tonemap.  Use for gallery thumbnails,
 * batch preflight, and sort-by-date/lens/GPS without a full decode.
 */
export class OrfMetadata {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly gps_lat: number;
    readonly gps_lon: number;
    readonly has_gps: boolean;
    readonly height: number;
    readonly iso: number;
    readonly orientation: number;
    readonly width: number;
    readonly datetime: string;
    readonly lens: string;
    readonly make: string;
    readonly model: string;
}

export class PerceptualComparer {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Copying convenience path: pass RGBA, get {butteraugli, ssim, psnr} as a JS object.
     */
    all(test_rgba: Uint8Array): any;
    /**
     * Compute all three metrics over the `len` bytes previously written into the
     * staging buffer via `input_ptr`.
     */
    all_at(len: number): any;
    butteraugli(test_rgba: Uint8Array): number;
    /**
     * Zero-copy: returns a pointer into the wasm heap staging buffer of `len`
     * bytes. JS writes the test RGBA straight here (no ArrayBuffer copy across
     * the boundary), then calls `all_at(len)`. Grows the buffer if needed; the
     * returned pointer is valid until the next `input_ptr` call.
     */
    input_ptr(len: number): number;
    constructor(ref_rgba: Uint8Array, width: number, height: number);
    psnr(test_rgba: Uint8Array): number;
    ssim(test_rgba: Uint8Array): number;
}

export class PerceptualEngine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Convenience copying path: pass RGBA directly.
     */
    compare(test_rgba: Uint8Array): number;
    /**
     * Compare test image written into staging buf via `input_ptr` against reference.
     * Returns perceptual distance (0 = identical, >1 = visible difference).
     */
    compare_from_buf(): number;
    /**
     * Per-scale scores and early-exit flag as a JS object.
     */
    get_metrics(): any;
    /**
     * Return pointer to the internal RGBA staging buffer (width*height*4 bytes).
     * JS: `new Uint8Array(wasm.memory.buffer, engine.input_ptr(), n * 4).set(rgba)`
     */
    input_ptr(): number;
    /**
     * Create engine for images of `width × height` pixels.
     */
    constructor(width: number, height: number);
    /**
     * Set reference image from a JS-provided RGBA slice.
     */
    set_reference(ref_rgba: Uint8Array): void;
    /**
     * Set reference from the staging buffer (populated via `input_ptr`).
     */
    set_reference_from_buf(): void;
}

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
     * Borrow the RGBA8 buffer (copies).
     */
    rgba(): Uint8Array;
    /**
     * Move the RGB buffer out as a `Uint8Array`.  Caller owns the bytes.
     */
    take_rgb(): Uint8Array;
    /**
     * Move the full-resolution packed u16 LE buffer out (M3 16-bit path). Caller owns the bytes.
     * Packed 6 bytes per pixel LE (r g b u16). Only non-empty if OUT_FULL_16 was requested.
     */
    take_rgb16_full(): Uint8Array;
    /**
     * Move the lightbox-sized packed u16 LE buffer out.  Caller owns the bytes.
     */
    take_rgb16_lb(): Uint8Array;
    /**
     * Move the thumb-sized packed u16 LE buffer out.  Caller owns the bytes.
     */
    take_rgb16_thumb(): Uint8Array;
    /**
     * Move the RGBA8 buffer out. Caller owns the bytes.
     * Performs RGB→RGBA conversion inside WASM using the same tight loop as the
     * JS-facing rgb_to_rgba, then transfers ownership. This still avoids the
     * JS-side 3x buffer allocation that the old take_rgb + rgb_to_rgba pattern
     * required for "encode only" paths.
     */
    take_rgba(): Uint8Array;
    readonly color_matrix_from_mn: boolean;
    readonly decompress_ms: number;
    readonly demosaic_ms: number;
    readonly exposure_den: number;
    readonly exposure_num: number;
    readonly fast_preview: boolean;
    readonly fnumber_den: number;
    readonly fnumber_num: number;
    readonly focal_length_35: number;
    readonly focal_length_den: number;
    readonly focal_length_num: number;
    readonly full16_h: number;
    readonly full16_w: number;
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
    readonly preview_demosaic_ms: number;
    readonly preview_downscale_ms: number;
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
 * Rotated RGB8 buffer with updated dimensions.
 */
export class RotateResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    take_rgb(): Uint8Array;
    readonly height: number;
    readonly width: number;
}

/**
 * Re-apply tonemap + orientation to a cached lightbox-sized rgb16 buffer.
 *
 * `rgb16_src` is flat RGB16 (3 u16 per pixel, interleaved).  For repeated slider
 * edits prefer `LookRenderer`, which owns the buffer inside WASM and avoids the
 * JS→WASM transfer on each call.
 * `color_matrix_flat` is 9 f32s row-major; pass a slice of len != 9 to use the
 * built-in fallback.
 */
export function apply_look(rgb16_src: Uint16Array, width: number, height: number, orientation: number, wb_r: number, wb_b: number, color_matrix_flat: Float32Array, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, texture: number, clarity: number): Uint8Array;

/**
 * Benchmark ORF decompress + demosaic without tonemap/downscale/orientation.
 * Use to measure decoder cost in isolation when tuning WASM flags or algorithms.
 */
export function bench_decode_orf(data: Uint8Array): DecodeBench;

export function demosaic_bench_equal(): boolean;

export function demosaic_bench_first_diff(): number;

export function demosaic_bench_planar_equal(): boolean;

export function demosaic_bench_planar_first_diff(): number;

export function demosaic_bench_planar_scalar(): number;

export function demosaic_bench_planar_simd(): number;

export function demosaic_bench_prepare(w: number, h: number): void;

export function demosaic_bench_scalar(): number;

export function demosaic_bench_shuffle_equal(): boolean;

export function demosaic_bench_shuffle_first_diff(): number;

export function demosaic_bench_shuffle_simd(): number;

export function demosaic_bench_simd(): number;

/**
 * Box-filter downscale an RGB8 buffer.  Useful for thumbnail generation.
 *
 * Fast path: when src dims are exact integer multiple of dst (common for 1/2, 1/4, 1/8 thumbs),
 * uses a much faster integer stepping loop with no f32 math or edge cases.
 */
export function downscale_rgb(src: Uint8Array, src_w: number, src_h: number, dst_w: number, dst_h: number): Uint8Array;

/**
 * Box-filter downscale an RGBA8 buffer.  Useful for thumbnail generation.
 *
 * Fast path: when src dims are exact integer multiple of dst (common for 1/2, 1/4, 1/8 thumbs),
 * uses a much faster integer stepping loop with no f32 math or edge cases.
 */
export function downscale_rgba(src: Uint8Array, src_w: number, src_h: number, dst_w: number, dst_h: number): Uint8Array;

export function initThreadPool(num_threads: number): Promise<any>;

/**
 * Parse ORF EXIF metadata only — no decompress, no demosaic, no tonemap.
 * Returns camera, lens, exposure, GPS for batch ingest and gallery views.
 */
export function parse_orf_metadata(data: Uint8Array): OrfMetadata;

/**
 * Parse + decode a Canon CR2 file blob.
 *
 * Always generates full RGB8, 1800 px lightbox RGB16, and 360 px thumbnail RGB16.
 * Use `process_cr2_with_flags` to skip unused outputs.
 */
export function process_cr2(data: Uint8Array, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, wb_r_override: number, wb_b_override: number, texture: number, clarity: number): ProcessResult;

/**
 * Variant of `process_cr2` with explicit output flags.
 *
 * `output_flags` bitmask: 1 = full RGB8, 2 = 1800 px lightbox RGB16, 4 = 360 px thumb RGB16, 8 = full RGB16 (M3).
 * Pass `7` for classic; 15 for M3 full16 too.
 */
export function process_cr2_with_flags(data: Uint8Array, output_flags: number, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, wb_r_override: number, wb_b_override: number, texture: number, clarity: number): ProcessResult;

/**
 * Parse + decode a DNG file blob. Returns an error string on failure.
 * (Rayon when parallel-wasm feature active.) Look params: LR-style (-1..+1), except
 * exposure_ev in stops.  Pass NaN/≤0 for wb_r_override/wb_b_override to use defaults.
 *
 * Always generates full RGB8, 1800 px lightbox RGB16, and 360 px thumbnail RGB16.
 * Use `process_dng_with_flags` to skip unused outputs (e.g. batch JXL encoding
 * only needs full RGB8, not lb/thumb).
 */
export function process_dng(data: Uint8Array, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, wb_r_override: number, wb_b_override: number, texture: number, clarity: number): ProcessResult;

/**
 * Variant of `process_dng` with explicit output flags to skip unused pipeline stages.
 *
 * `output_flags` is a bitmask of:
 * - `1`: full-resolution RGB8 (needed for JXL encoding)
 * - `2`: 1800 px lightbox RGB16 cache (needed to construct a `LookRenderer`)
 * - `4`: 360 px thumbnail RGB16 cache (needed to construct a thumb `LookRenderer`)
 *
 * Absent outputs have empty buffers and zero dims in `ProcessResult`.
 * Pass `7` to match the behaviour of `process_dng`.
 */
export function process_dng_with_flags(data: Uint8Array, output_flags: number, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, wb_r_override: number, wb_b_override: number, texture: number, clarity: number): ProcessResult;

/**
 * Parse + decode an ORF file blob.  Returns an error string on failure.
 *
 * All look params are LR-style, zero-centred (-1..+1 normalised), except
 * `exposure_ev` which is in stops.  `wb_r_override` / `wb_b_override`:
 * pass NaN (or ≤0) to use MakerNote / defaults.
 *
 * Always generates full RGB8, 1800 px lightbox RGB16, and 360 px thumbnail RGB16.
 * Use `process_orf_with_flags` to skip unused outputs (e.g. batch JXL encoding
 * only needs full RGB8, not lb/thumb).
 */
export function process_orf(data: Uint8Array, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, wb_r_override: number, wb_b_override: number, texture: number, clarity: number): ProcessResult;

/**
 * Variant of `process_orf` with explicit output flags to skip unused pipeline stages.
 *
 * `output_flags` is a bitmask of:
 * - `1`: full-resolution RGB8 (needed for JXL encoding)
 * - `2`: 1800 px lightbox RGB16 cache (needed to construct a `LookRenderer`)
 * - `4`: 360 px thumbnail RGB16 cache (needed to construct a thumb `LookRenderer`)
 *
 * Absent outputs have empty buffers and zero dims in `ProcessResult`.
 * Pass `7` for classic (no full16). For M3 16-bit big levels pass e.g. 15 (7|8).
 */
export function process_orf_with_flags(data: Uint8Array, output_flags: number, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, wb_r_override: number, wb_b_override: number, texture: number, clarity: number): ProcessResult;

/**
 * Convert interleaved RGB8 → RGBA8 (alpha = 255).  HTML canvas wants RGBA.
 */
export function rgb_to_rgba(rgb: Uint8Array): Uint8Array;

/**
 * Rotate an RGB8 buffer clockwise by `turns` × 90°  (0=0°, 1=90°, 2=180°, 3=270°).
 * Returns the rotated buffer and new (width, height).
 */
export function rotate_rgb8(src: Uint8Array, width: number, height: number, turns: number): RotateResult;

export class wbg_rayon_PoolBuilder {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    build(): void;
    numThreads(): number;
    receiver(): number;
}

export function wbg_rayon_start_worker(receiver: number): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_decodebench_free: (a: number, b: number) => void;
    readonly __wbg_get_decodebench_decompress_ms: (a: number) => number;
    readonly __wbg_get_decodebench_demosaic_ms: (a: number) => number;
    readonly __wbg_get_decodebench_height: (a: number) => number;
    readonly __wbg_get_decodebench_width: (a: number) => number;
    readonly __wbg_get_orfmetadata_has_gps: (a: number) => number;
    readonly __wbg_get_orfmetadata_iso: (a: number) => number;
    readonly __wbg_get_orfmetadata_orientation: (a: number) => number;
    readonly __wbg_get_processresult_color_matrix_from_mn: (a: number) => number;
    readonly __wbg_get_processresult_exposure_den: (a: number) => number;
    readonly __wbg_get_processresult_exposure_num: (a: number) => number;
    readonly __wbg_get_processresult_fast_preview: (a: number) => number;
    readonly __wbg_get_processresult_fnumber_den: (a: number) => number;
    readonly __wbg_get_processresult_fnumber_num: (a: number) => number;
    readonly __wbg_get_processresult_focal_length_35: (a: number) => number;
    readonly __wbg_get_processresult_focal_length_den: (a: number) => number;
    readonly __wbg_get_processresult_focal_length_num: (a: number) => number;
    readonly __wbg_get_processresult_full16_h: (a: number) => number;
    readonly __wbg_get_processresult_full16_w: (a: number) => number;
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
    readonly __wbg_get_processresult_preview_demosaic_ms: (a: number) => number;
    readonly __wbg_get_processresult_preview_downscale_ms: (a: number) => number;
    readonly __wbg_get_processresult_quality: (a: number) => number;
    readonly __wbg_get_processresult_thumb_h: (a: number) => number;
    readonly __wbg_get_processresult_thumb_w: (a: number) => number;
    readonly __wbg_get_processresult_tonemap_ms: (a: number) => number;
    readonly __wbg_get_processresult_wb_b_used: (a: number) => number;
    readonly __wbg_get_processresult_wb_from_camera: (a: number) => number;
    readonly __wbg_get_processresult_wb_mode: (a: number) => number;
    readonly __wbg_get_processresult_wb_r_used: (a: number) => number;
    readonly __wbg_get_processresult_width: (a: number) => number;
    readonly __wbg_get_rotateresult_height: (a: number) => number;
    readonly __wbg_get_rotateresult_width: (a: number) => number;
    readonly __wbg_lookrenderer_free: (a: number, b: number) => void;
    readonly __wbg_orfmetadata_free: (a: number, b: number) => void;
    readonly __wbg_perceptualcomparer_free: (a: number, b: number) => void;
    readonly __wbg_perceptualengine_free: (a: number, b: number) => void;
    readonly __wbg_processresult_free: (a: number, b: number) => void;
    readonly __wbg_rotateresult_free: (a: number, b: number) => void;
    readonly apply_look: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number) => [number, number, number, number];
    readonly bench_decode_orf: (a: number, b: number) => [number, number, number];
    readonly demosaic_bench_equal: () => number;
    readonly demosaic_bench_first_diff: () => number;
    readonly demosaic_bench_planar_equal: () => number;
    readonly demosaic_bench_planar_first_diff: () => number;
    readonly demosaic_bench_planar_scalar: () => number;
    readonly demosaic_bench_planar_simd: () => number;
    readonly demosaic_bench_prepare: (a: number, b: number) => void;
    readonly demosaic_bench_scalar: () => number;
    readonly demosaic_bench_shuffle_equal: () => number;
    readonly demosaic_bench_shuffle_first_diff: () => number;
    readonly demosaic_bench_shuffle_simd: () => number;
    readonly demosaic_bench_simd: () => number;
    readonly downscale_rgb: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly downscale_rgba: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly lookrenderer_native_height: (a: number) => number;
    readonly lookrenderer_native_width: (a: number) => number;
    readonly lookrenderer_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly lookrenderer_new_with_options: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly lookrenderer_orientation: (a: number) => number;
    readonly lookrenderer_render: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => [number, number, number, number];
    readonly orfmetadata_datetime: (a: number) => [number, number];
    readonly orfmetadata_lens: (a: number) => [number, number];
    readonly orfmetadata_make: (a: number) => [number, number];
    readonly orfmetadata_model: (a: number) => [number, number];
    readonly parse_orf_metadata: (a: number, b: number) => [number, number, number];
    readonly perceptualcomparer_all: (a: number, b: number, c: number) => any;
    readonly perceptualcomparer_all_at: (a: number, b: number) => any;
    readonly perceptualcomparer_butteraugli: (a: number, b: number, c: number) => number;
    readonly perceptualcomparer_input_ptr: (a: number, b: number) => number;
    readonly perceptualcomparer_new: (a: number, b: number, c: number, d: number) => number;
    readonly perceptualcomparer_psnr: (a: number, b: number, c: number) => number;
    readonly perceptualcomparer_ssim: (a: number, b: number, c: number) => number;
    readonly perceptualengine_compare: (a: number, b: number, c: number) => number;
    readonly perceptualengine_compare_from_buf: (a: number) => number;
    readonly perceptualengine_get_metrics: (a: number) => any;
    readonly perceptualengine_input_ptr: (a: number) => number;
    readonly perceptualengine_new: (a: number, b: number) => number;
    readonly perceptualengine_set_reference: (a: number, b: number, c: number) => void;
    readonly perceptualengine_set_reference_from_buf: (a: number) => void;
    readonly process_cr2: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => [number, number, number];
    readonly process_cr2_with_flags: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number) => [number, number, number];
    readonly process_dng: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => [number, number, number];
    readonly process_dng_with_flags: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number) => [number, number, number];
    readonly process_orf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => [number, number, number];
    readonly process_orf_with_flags: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number) => [number, number, number];
    readonly processresult_color_matrix_used: (a: number) => [number, number];
    readonly processresult_datetime: (a: number) => [number, number];
    readonly processresult_lens: (a: number) => [number, number];
    readonly processresult_make: (a: number) => [number, number];
    readonly processresult_model: (a: number) => [number, number];
    readonly processresult_rgb: (a: number) => [number, number];
    readonly processresult_rgba: (a: number) => [number, number];
    readonly processresult_take_rgb: (a: number) => [number, number];
    readonly processresult_take_rgb16_full: (a: number) => [number, number];
    readonly processresult_take_rgb16_lb: (a: number) => [number, number];
    readonly processresult_take_rgb16_thumb: (a: number) => [number, number];
    readonly processresult_take_rgba: (a: number) => [number, number];
    readonly rgb_to_rgba: (a: number, b: number) => [number, number];
    readonly rotate_rgb8: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly rotateresult_take_rgb: (a: number) => [number, number];
    readonly __wbg_get_orfmetadata_gps_lat: (a: number) => number;
    readonly __wbg_get_orfmetadata_gps_lon: (a: number) => number;
    readonly __wbg_get_orfmetadata_height: (a: number) => number;
    readonly __wbg_get_orfmetadata_width: (a: number) => number;
    readonly __wbg_get_processresult_decompress_ms: (a: number) => number;
    readonly __wbg_get_processresult_demosaic_ms: (a: number) => number;
    readonly __wbg_wbg_rayon_poolbuilder_free: (a: number, b: number) => void;
    readonly initThreadPool: (a: number) => any;
    readonly wbg_rayon_poolbuilder_build: (a: number) => void;
    readonly wbg_rayon_poolbuilder_numThreads: (a: number) => number;
    readonly wbg_rayon_poolbuilder_receiver: (a: number) => number;
    readonly wbg_rayon_start_worker: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_exn_store: (a: number) => void;
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
