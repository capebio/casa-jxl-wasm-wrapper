export type Denom = 1 | 2 | 4 | 8;
export interface JpegDecodeResult {
    data: Uint8Array;
    width: number;
    height: number;
}
export declare class JpegDecodeError extends Error {
    readonly code: 'decode_failed';
    readonly cause: unknown;
    constructor(cause: unknown);
}
/** Decode JPEG → RGBA8 with DCT-domain downscale. denom: 1=full, 2=half, 4=quarter, 8=eighth. */
export declare function decodeJpegScaled(jpeg: Uint8Array, denom?: Denom): JpegDecodeResult;
