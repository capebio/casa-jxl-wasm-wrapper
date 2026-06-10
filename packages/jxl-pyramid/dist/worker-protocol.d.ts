/**
 * Versioned worker protocol for jxl-pyramid tiled decode (Grok 2).
 * Shared types between main-thread pool and web/lightbox/tiled-decode-worker.js.
 * The worker references these via JSDoc @typedef imports.
 */
import type { ImageRegion } from "./tiling.js";
export type { ImageRegion } from "./tiling.js";
export type WorkerRequest = {
    v: 1;
    type: 'load';
    bytesId: number;
    bytes: Uint8Array;
} | {
    v: 1;
    type: 'decode';
    id: number;
    bytesId: number;
    region: ImageRegion;
    format: 'rgba8' | 'rgba16';
    deadlineMs?: number;
} | {
    v: 1;
    type: 'cancel';
    id: number;
};
export type WorkerReply = {
    v: 1;
    type: 'ready';
} | {
    v: 1;
    type: 'decode-reply';
    id: number;
    ok: true;
    pixels: Uint8Array;
    w: number;
    h: number;
} | {
    v: 1;
    type: 'decode-reply';
    id: number;
    ok: false;
    error: {
        code: WorkerErrorCode;
        message: string;
        stack?: string;
    };
};
export type WorkerErrorCode = 'JXTC_PARSE' | 'BAD_REGION' | 'OOM' | 'INTERNAL' | 'TIMEOUT' | 'UNKNOWN_BYTES_ID';
//# sourceMappingURL=worker-protocol.d.ts.map