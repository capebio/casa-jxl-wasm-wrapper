import type { ImageRegion } from "./tiling.js";
import type { PyramidCache } from "./cache.js";
export interface DecodedLevel {
    pixels: Uint8Array;
    width: number;
    height: number;
}
export type RegionDecoder = (bytes: Uint8Array, region: ImageRegion) => Promise<DecodedLevel>;
export declare const REGION_DECODER_RGBA8: RegionDecoder;
export declare const REGION_DECODER_RGBA16: RegionDecoder;
export declare const pickRegionDecoder: (bits: 8 | 16) => RegionDecoder;
export declare const WHOLE_DECODE_OPTS: Readonly<{
    progressionTarget: "final";
    emitEveryPass: false;
    preserveIcc: false;
    preserveMetadata: false;
}>;
export declare function clampPositive(x: number, max: number): number;
/** longEdge helper (Grok4 micro-opt): ternary, no Math.max call. */
export declare function longEdge(w: number, h: number): number;
/** Central clamp (replaces 3 inlined sites: decode-level, pool, tiling). */
export declare function clampRegion(region: ImageRegion, imageW: number, imageH: number): ImageRegion;
/**
 * Write one decoded tile into outBuffer at its offset within viewport.
 * Replaces the parts[] "stitch all" signature (stream-stitch: on-arrival writes).
 * Fast-path stride-aligned kept; fallback row subarray. Indexed loops.
 */
export declare function stitch(outBuffer: Uint8Array, viewport: ImageRegion, tile: ImageRegion, decoded: DecodedLevel, bytesPerPixel: 4 | 8): void;
export type PyramidErrorCode = 'ABORTED' | 'POOL_DESTROYED' | 'FACTORY_CONFLICT' | 'TIMEOUT' | 'INVALID_REPLY' | 'EMPTY_LEVELS' | 'BAD_REGION' | 'JXTC_PARSE' | 'OOM' | 'INTERNAL' | string;
export declare class PyramidError extends Error {
    code: PyramidErrorCode;
    cause?: unknown;
    constructor(code: PyramidErrorCode, message: string, cause?: unknown);
}
export interface DecodeOptions {
    parallel?: boolean;
    decodeRegion?: RegionDecoder;
    signal?: AbortSignal;
    workerFactory?: () => any;
    pool?: any;
    /** Opt-in decoded viewport cache (keyed by level+region+format; no auto persistence). */
    cache?: PyramidCache;
    /** Caller-owned recyclable buffer for stitched result (must be >= w*h*bpp). Returned .pixels will be this buffer on use. */
    outBuffer?: Uint8Array;
    /** Called after each tile write (parallel) or once for direct (completedCount = tiles done). */
    onTile?: (region: ImageRegion, completedCount: number) => void;
}
//# sourceMappingURL=decode-core.d.ts.map