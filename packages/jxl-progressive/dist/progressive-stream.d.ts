import { type RangeNegotiation } from "@casabio/jxl-stream";
import type { DecodeSession, DecodeFrameEvent } from "@casabio/jxl-session";
import type { ManifestTier } from "./progressive-manifest.js";
export type { RangeNegotiation };
export interface TierFetchOptions {
    headers?: HeadersInit;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    onRangeNegotiated?: (info: RangeNegotiation) => void;
}
export declare class HttpError extends Error {
    readonly status: number;
    readonly statusText: string;
    constructor(status: number, statusText: string, url: string);
}
export declare class RangeNotSupportedError extends Error {
    constructor(url: string);
}
/**
 * Fetch bytes 0..tier.byteEnd of `url` via HTTP Range and push into `session`.
 * All tiers are cumulative from byte 0 (per spec §Byte Range Semantics).
 * Calls session.close() on success.
 */
export declare function fetchTier(url: string, tier: ManifestTier, session: DecodeSession, opts?: TierFetchOptions): Promise<void>;
/**
 * Async iterator over frames from an active DecodeSession.
 * Yields every DecodeFrameEvent until the session closes or is cancelled.
 */
export declare function streamTierFrames(session: DecodeSession): AsyncGenerator<DecodeFrameEvent>;
/**
 * Fetch the full resource (no Range header) and push into `session`.
 * Used as fallback when no manifest is available.
 */
export declare function fetchFull(url: string, session: DecodeSession, opts?: TierFetchOptions): Promise<void>;
/**
 * Fetch the delta for `tier` after a known `prefix` (already pushed into session by caller).
 * Issues Range: bytes=${prefixLength}-${tier.byteEnd-1}.
 * Validates 206 + Content-Range start exactly matches prefixLength (defends against
 * misbehaving proxies/CDNs that normalize/shift ranges). On mismatch or !206, cancel
 * session + throw RangeNotSupportedError so scheduler can fallback to plain fetchTier
 * (fresh session from byte 0).
 *
 * prefix may be Uint8Array | ArrayBuffer (content ignored, only length used) *or* a bare number
 * for the known prefix byte length. This allows callers that track length (e.g. from prior tier
 * persist or accum) to avoid materializing/concatenating the full prefix bytes solely for this call.
 */
export declare function fetchTierWithPrefix(url: string, tier: ManifestTier, prefix: Uint8Array | ArrayBuffer | number, session: DecodeSession, opts?: TierFetchOptions): Promise<void>;
//# sourceMappingURL=progressive-stream.d.ts.map