/* tslint:disable */
/* eslint-disable */

export class DecodeResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Consuming accessor — moves the pixel buffer out without cloning.
     * Prefer this over `data` when you only need the pixels once.
     */
    take_data(): Uint8Array;
    readonly data: Uint8Array;
    readonly height: number;
    readonly width: number;
}

/**
 * Decode a JPEG buffer to RGBA, with DCT-domain downscale.
 * `denom`: 1 (full), 2 (half), 4 (quarter), 8 (eighth). Other values clamp to 1.
 */
export function decode_scaled(jpeg: Uint8Array, denom: number): DecodeResult;
