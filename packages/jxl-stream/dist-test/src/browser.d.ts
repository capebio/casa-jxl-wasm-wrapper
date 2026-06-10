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
export interface RangeNegotiation {
    /** Bytes the caller asked for. */
    requested: number;
    /** True if server returned 206 Partial Content. */
    honored: boolean;
    /** Bytes actually pushed into the session (capped to `requested` even on 200). */
    delivered: number;
    /** Content-Length of full resource if server reported it (parsed from Content-Range or Content-Length). */
    fullSize?: number;
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
     * Diagnostic callback fired once after fetch headers arrive.
     * Inspect `honored` to detect servers that ignored Range and returned 200 OK.
     */
    onRangeNegotiated?: (info: RangeNegotiation) => void;
}
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
