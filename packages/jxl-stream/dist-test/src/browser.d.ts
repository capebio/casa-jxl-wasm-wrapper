export interface DecodeSession {
    push(chunk: ArrayBuffer | Uint8Array): Promise<void>;
    close(): Promise<void>;
    cancel(reason?: string): Promise<void>;
}
export interface EncodeSession {
    chunks(): AsyncIterable<ArrayBuffer>;
    cancel(reason?: string): Promise<void>;
}
export interface PipeOptions {
    signal?: AbortSignal;
    maxBytes?: number;
}
export declare const ABORT_REASON = "AbortSignal triggered";
/**
 * Pipes a ReadableStream into a DecodeSession.
 * Honours backpressure: awaits session.push() before reading next chunk.
 * Prefetches chunk N+1 immediately after chunk N arrives to pipeline I/O with push dispatch.
 *
 * Overload: signalOrOpts accepts AbortSignal (backward compat) or PipeOptions {signal?, maxBytes?}.
 * Returns bytes delivered (was void; number return is compatible for existing awaiters that ignore it).
 * When maxBytes reached: trim last chunk via subarray, reader.cancel('maxBytes satisfied'), session.close()
 * (intentional cutoff, not error cancel). maxBytes is the client-side convergedByteEnd cutoff.
 */
export declare function fromReadableStream(stream: ReadableStream<Uint8Array>, session: DecodeSession, signalOrOpts?: AbortSignal | PipeOptions): Promise<number>;
/**
 * Turns an EncodeSession's output chunks into a ReadableStream.
 */
export declare function toReadableStream(session: EncodeSession, signal?: AbortSignal): ReadableStream<ArrayBuffer>;
/**
 * Helper to pipe a fetch Response body into a DecodeSession.
 * Accepts signal or PipeOptions (maxBytes forwarded); returns bytes delivered.
 */
export declare function fromResponse(response: Response, session: DecodeSession, signalOrOpts?: AbortSignal | PipeOptions): Promise<number>;
/**
 * Helper to turn a Blob into a stream and pipe it to a session.
 * Accepts signal or PipeOptions (maxBytes forwarded); returns bytes delivered.
 */
export declare function fromBlob(blob: Blob, session: DecodeSession, signalOrOpts?: AbortSignal | PipeOptions): Promise<number>;
/**
 * Pipe the byte window [start, endExclusive) of a Blob into a session.
 * Blob.slice is a zero-copy reference — ideal for OPFS-cached pyramid files
 * where the manifest supplies exact per-level/tile offsets (local analogue of fromByteRange).
 * Window is clamped to blob.size; start at/after the end delivers 0 bytes and closes cleanly.
 */
export declare function fromBlobRange(blob: Blob, start: number, endExclusive: number, session: DecodeSession, signalOrOpts?: AbortSignal | PipeOptions): Promise<number>;
export interface RangeNegotiation {
    /** Bytes the caller asked for. */
    requested: number;
    /** True if server returned 206 Partial Content. */
    honored: boolean;
    /** Bytes actually pushed into the session (capped to `requested` even on 200). */
    delivered: number;
    /** Content-Length of full resource if server reported it (parsed from Content-Range or Content-Length). */
    fullSize?: number;
    /** ETag from the response, if present. Useful for safe resumable Range with If-Range. */
    etag?: string;
    /** Milliseconds from fetch dispatch to response headers (TTFB). */
    ttfbMs?: number;
    /** Milliseconds from headers to transfer end (success or failure). */
    transferMs?: number;
}
export interface RangePrefixOptions {
    /** Extra request headers (Authorization, custom auth tokens, etc). */
    headers?: HeadersInit;
    /** AbortSignal forwarded to fetch and session.cancel(). */
    signal?: AbortSignal;
    /**
     * Override fetch implementation (testing or polyfill).
     * Default: globalThis.fetch (browser, Node 18+, Deno, Bun).
     */
    fetchImpl?: typeof fetch;
    /**
     * Diagnostic callback fired once from finally after the transfer completes
     * or fails mid-body (with final delivered byte count). It does not fire for
     * pre-body failures (like 416, non-ok status, or initial fetch rejection).
     */
    onRangeNegotiated?: (info: RangeNegotiation) => void;
    /** Fired once as soon as response headers arrive, before any bytes are pumped.
     *  `delivered` is 0 at this point. Lets callers abort wasteful 200-fallback skips early via their signal. */
    onHeaders?: (info: RangeNegotiation) => void;
    /** Forwarded to fetch() as RequestInit.priority where supported ('high' | 'low' | 'auto').
     *  Lets callers mark speculative pyramid prefetches 'low' and on-screen tiles 'high'. */
    priority?: 'high' | 'low' | 'auto';
    /**
     * If set and the server responds 200 (Range ignored) with a *different* ETag,
     * cancel the session and throw — the resource changed; previously delivered
     * bytes belong to an older version and must not be stitched. Set automatically
     * by resumeFromByteRange.
     */
    expectEtag?: string;
}
/**
 * Serializable state for resuming a previous byte-range fetch.
 * Persist this (e.g. with jxl-cache or your own storage) across reconnects or app restarts.
 * Use with resumeFromByteRange() to continue from where you left off,
 * automatically using If-Range when an etag is available for safety.
 */
export interface ByteRangeResumeState {
    url: string;
    start: number;
    endExclusive: number;
    etag?: string;
    fullSize?: number;
}
/**
 * Create a resume state from a previous negotiation (typically the one returned
 * by fromByteRange or fromRangePrefix).
 *
 * originalStart: the `start` you used in the *first* fromByteRange call
 *   (usually 0 for prefix/tile fetches). This lets us correctly compute the
 *   original endExclusive for the resume request.
 */
export declare function createByteRangeResumeState(url: string, previous: RangeNegotiation, originalStart?: number): ByteRangeResumeState;
/**
 * Fetch an arbitrary byte window [start, endExclusive) via HTTP Range and pipe into session.
 *
 * 206: server honors; deliver up to (endExclusive-start) bytes (cap if overread).
 * 200 fallback (ignored Range): skip first `start` bytes (drop full chunks, subarray on boundary),
 *   then deliver up to window size from the remaining stream.
 * Validates 0 <= start < endExclusive, finite.
 *
 * Returns RangeNegotiation (with delivered even on some error paths via finally).
 * onRangeNegotiated (if supplied) is fired from finally (builds info object once) per SB-5.
 *
 * Replaces the old prefix-only API; pyramid manifests supply exact per-level/tile offsets.
 */
export declare function fromByteRange(url: string, start: number, endExclusive: number, session: DecodeSession, opts?: RangePrefixOptions): Promise<RangeNegotiation>;
/**
 * Fetch the first `byteCount` bytes of `url` via an HTTP Range request and pipe into `session`.
 *
 * (Reimplemented as fromByteRange(url, 0, byteCount, session, opts) per SB-7.)
 *
 * Intended use: progressive / sidecar-ladder JXL workflows where the caller knows that the
 * desired output (e.g. a small embedded sidecar JXL, or a DC-frame prefix of a `cjxl -p`
 * encoded image) lives in the first N bytes of the resource.
 *
 * Behaviour:
 * - Sends `Range: bytes=0-{byteCount-1}`.
 * - 206 Partial Content: pipes body up to `byteCount` (cancels reader if server over-reads to chunk boundary).
 * - 200 OK (server ignored Range): pipes first `byteCount` bytes, cancels reader; bandwidth wasted but result correct.
 *   Detect via `onRangeNegotiated({ honored: false, ... })`.
 * - 416 Range Not Satisfiable: throws RangeError.
 * - Resource shorter than requested: pipes whatever exists, returns cleanly.
 *
 * Returns Promise<RangeNegotiation> (SB-5); void->value backward-compatible.
 * onRangeNegotiated fires from finally (error paths report delivered too).
 *
 * Truncation tolerance:
 * - The stream layer always calls `session.close()` after delivering bytes. If the byte prefix
 *   ends mid-codestream and the session/worker layer does not opt into truncated-EOF handling,
 *   the decode will surface as an error (with `partialPixels` still attached). Callers using
 *   this with mid-codestream truncation must enable graceful EOF at the session layer.
 * - For sidecar / boundary-aligned ladder use (recommended), each prefix ends exactly at a
 *   complete JXL boundary and no special truncation handling is needed.
 *
 * CORS note: the `Range` header is a non-simple header — browser requests trigger a CORS
 * preflight. The server must respond with `Access-Control-Allow-Headers: Range` and
 * (typically) `Access-Control-Expose-Headers: Content-Range, Accept-Ranges` for full
 * functionality.
 *
 * No artificial cap on `byteCount`. The caller is responsible for sizing; values above
 * the full resource size are valid (server responds 200 or short 206).
 */
export declare function fromRangePrefix(url: string, byteCount: number, session: DecodeSession, opts?: RangePrefixOptions): Promise<RangeNegotiation>;
/**
 * Resume a previous byte-range fetch using a ByteRangeResumeState (created via
 * createByteRangeResumeState from an earlier RangeNegotiation).
 *
 * This is the ergonomic entry point for SB-10 resumable Range.
 * - If the state has an etag, automatically adds `If-Range: <etag>` for safe resume
 *   (server will 412 if the resource changed).
 * - Still supports all the normal RangePrefixOptions (extra headers are merged,
 *   signal, custom fetchImpl, onRangeNegotiated).
 * - The underlying fromByteRange skip/206/200 logic handles the continuation.
 *
 * Typical usage for unreliable/field/offline:
 *   const neg1 = await fromByteRange(url, 0, wantedEnd, session1, { onRangeNegotiated: saveState });
 *   const resumeState = createByteRangeResumeState(url, neg1);
 *   // ... network drop, app restart, persist resumeState + any partial bytes via jxl-cache ...
 *   const neg2 = await resumeFromByteRange(resumeState, session2);
 */
export declare function resumeFromByteRange(state: ByteRangeResumeState, session: DecodeSession, opts?: RangePrefixOptions): Promise<RangeNegotiation>;
