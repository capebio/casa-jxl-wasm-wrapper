import type { SessionFactory } from "./types.js";
import { type ProgressiveManifest } from "./progressive-manifest.js";
export type { SessionFactory };
export interface ProfileOptions {
    /** Bytes to feed per push. Default 4096 (4 KiB). */
    chunkSize?: number;
    encoderName?: string;
    libjxlVersion?: string;
    encoderFlags?: string[];
    saliency?: ProgressiveManifest["saliency"];
    /** Called after each chunk push with (byteOffset, totalBytes). */
    onProgress?: (byteOffset: number, total: number) => void;
    signal?: AbortSignal;
}
/**
 * Drive a throw-away DecodeSession in small byte increments,
 * record progression events, and return a ProgressiveManifest.
 *
 * Works in both Node.js and browser environments — accepts pre-loaded bytes,
 * performs no I/O internally.
 */
export declare function profileJxl(jxlBytes: ArrayBuffer, sessionFactory: SessionFactory, source: {
    width: number;
    height: number;
    hasAlpha: boolean;
    orientation?: number;
}, opts?: ProfileOptions): Promise<ProgressiveManifest>;
/**
 * Node.js helper: read a .jxl file, profile it, and optionally write
 * the manifest as `${path}.json` beside the original file.
 */
export declare function profileJxlFile(path: string, sessionFactory: SessionFactory, source: {
    width: number;
    height: number;
    hasAlpha: boolean;
    orientation?: number;
}, opts?: ProfileOptions & {
    writeManifest?: boolean;
}): Promise<ProgressiveManifest>;
//# sourceMappingURL=progressive-profile.d.ts.map