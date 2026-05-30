// packages/jxl-progressive/src/progressive-stream.ts
import { fromRangePrefix, fromResponse } from "@casabio/jxl-stream";
/**
 * Fetch bytes 0..tier.byteEnd of `url` via HTTP Range and push into `session`.
 * All tiers are cumulative from byte 0 (per spec §Byte Range Semantics).
 * Calls session.close() on success.
 */
export async function fetchTier(url, tier, session, opts = {}) {
    const { signal } = opts;
    if (signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
    await fromRangePrefix(url, tier.byteEnd, session, opts);
    if (signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
}
/**
 * Async iterator over frames from an active DecodeSession.
 * Yields every DecodeFrameEvent until the session closes or is cancelled.
 */
export async function* streamTierFrames(session) {
    for await (const frame of session.frames()) {
        yield frame;
    }
}
/**
 * Fetch the full resource (no Range header) and push into `session`.
 * Used as fallback when no manifest is available.
 */
export async function fetchFull(url, session, opts = {}) {
    const { signal, headers, fetchImpl = globalThis.fetch } = opts;
    const mergedHeaders = new Headers(headers);
    const resp = await fetchImpl(url, { headers: mergedHeaders, ...(signal !== undefined && { signal }) });
    if (!resp.ok) {
        throw new Error(`[progressive-stream] HTTP ${resp.status} ${resp.statusText}: ${url}`);
    }
    await fromResponse(resp, session, signal);
}
//# sourceMappingURL=progressive-stream.js.map