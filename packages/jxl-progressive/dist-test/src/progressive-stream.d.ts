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
//# sourceMappingURL=progressive-stream.d.ts.map