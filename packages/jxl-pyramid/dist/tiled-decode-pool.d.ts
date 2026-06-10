import { type ImageRegion } from "./tiling.js";
import type { LevelSource } from "./level-source.js";
import { type RegionDecoder, type DecodedLevel } from "./decode-core.js";
import type { WorkerRequest } from "./worker-protocol.js";
export declare enum PoolState {
    Created = "created",
    Prewarming = "prewarming",
    Active = "active",
    Draining = "draining",
    Destroyed = "destroyed"
}
export declare enum HandleState {
    WarmFloor = "warm-floor",
    WarmReapable = "warm-reapable",
    Active = "active",
    Bad = "bad",
    Terminated = "terminated"
}
type WorkerLike = {
    addEventListener(type: "message" | "error" | "messageerror", listener: (ev: {
        data?: any;
    }) => void): void;
    removeEventListener(type: "message" | "error" | "messageerror", listener: (ev: {
        data?: any;
    }) => void): void;
    postMessage(data: WorkerRequest, transfer?: any[]): void;
    terminate(): void;
};
/** Hoisted predicate (Grok4). */
export declare function shouldUseParallel(opts: {
    parallel?: boolean;
    workerFactory?: any;
    pool?: any;
} | undefined, numTiles: number, envCanParallel: boolean): boolean;
export declare function disposeDefaultPool(): Promise<void>;
/**
 * Decode a tiled viewport with optional parallel per-tile workers (Grok2 protocol).
 * Uses bytesId + load/decode split. 16-bit now wired at root via format.
 */
export declare function decodeTiledViewportPooled(containerBytes: Uint8Array, region: ImageRegion, options?: {
    parallel?: boolean;
    decodeRegion?: RegionDecoder;
    workerFactory?: () => WorkerLike;
    signal?: AbortSignal;
    /** Opt-in SAB zero-copy for the load message when crossOriginIsolated. */
    useSAB?: boolean;
}): Promise<DecodedLevel>;
export declare function decodeTiledViewportPooled(source: Extract<LevelSource, {
    kind: "tiled";
}>, region: ImageRegion, options?: {
    parallel?: boolean;
    decodeRegion?: RegionDecoder;
    workerFactory?: () => WorkerLike;
    signal?: AbortSignal;
    useSAB?: boolean;
}): Promise<DecodedLevel>;
export {};
//# sourceMappingURL=tiled-decode-pool.d.ts.map