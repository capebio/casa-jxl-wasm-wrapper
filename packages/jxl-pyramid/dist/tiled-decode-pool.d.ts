import { type ImageRegion } from "./tiling.js";
import type { DecodedLevel } from "./decode-level.js";
type WorkerLike = {
    addEventListener(type: "message", listener: (ev: {
        data: WorkerReply;
    }) => void): void;
    removeEventListener(type: "message", listener: (ev: {
        data: WorkerReply;
    }) => void): void;
    postMessage(data: {
        id: number;
        bytes: Uint8Array;
        region: ImageRegion;
    }): void;
    terminate(): void;
};
export type TileRegionDecoder = (bytes: Uint8Array, region: ImageRegion) => Promise<DecodedLevel>;
type WorkerReply = {
    id: number;
    ok: true;
    pixels: ArrayBuffer;
    width: number;
    height: number;
} | {
    id: number;
    ok: false;
    error: string;
};
/**
 * Decode a tiled viewport with optional parallel per-tile workers.
 * Falls back to a single WASM ROI decode when workers unavailable.
 */
export declare function decodeTiledViewportPooled(containerBytes: Uint8Array, region: ImageRegion, options?: {
    parallel?: boolean;
    decodeRegion?: TileRegionDecoder;
    workerFactory?: () => WorkerLike;
}): Promise<DecodedLevel>;
export {};
//# sourceMappingURL=tiled-decode-pool.d.ts.map