export interface DecodeSession {
  push(chunk: ArrayBuffer | Uint8Array): Promise<void>;
  close(): Promise<void>;
  cancel(reason?: string): Promise<void>;
}

export interface EncodeSession {
  chunks(): AsyncIterable<ArrayBuffer>;
  cancel(reason?: string): Promise<void>;
}

const ABORT_REASON = 'AbortSignal triggered';

/**
 * Pipes a ReadableStream into a DecodeSession.
 * Honours backpressure: awaits session.push() before reading next chunk.
 * Prefetches chunk N+1 immediately after chunk N arrives to pipeline I/O with push dispatch.
 */
export async function fromReadableStream(
  stream: ReadableStream<Uint8Array>,
  session: DecodeSession,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();

  const cancelBoth = (reason: string) =>
    Promise.allSettled([session.cancel(reason), reader.cancel(reason)]);

  const onAbort = () => { void cancelBoth(ABORT_REASON); };

  if (signal?.aborted) {
    await cancelBoth(ABORT_REASON);
    return;
  }

  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    let pending = reader.read();

    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const { done, value } = await pending;
      if (done) break;

      pending = reader.read();

      await session.push(value);
    }

    if (signal?.aborted) {
      await session.cancel(ABORT_REASON);
      return;
    }

    await session.close();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await cancelBoth(reason);
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/**
 * Turns an EncodeSession's output chunks into a ReadableStream.
 */
export function toReadableStream(
  session: EncodeSession,
  signal?: AbortSignal,
): ReadableStream<ArrayBuffer> {
  const iterator = session.chunks()[Symbol.asyncIterator]();
  let abortHandler: (() => void) | null = null;

  const removeAbortHandler = () => {
    if (abortHandler !== null && signal !== undefined) {
      signal.removeEventListener('abort', abortHandler);
      abortHandler = null;
    }
  };

  return new ReadableStream<ArrayBuffer>({
    start(controller) {
      if (signal === undefined) return;

      abortHandler = () => {
        void session.cancel(ABORT_REASON);
        controller.error(new DOMException('Aborted', 'AbortError'));
      };

      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener('abort', abortHandler, { once: true });
      }
    },

    async pull(controller) {
      if (signal?.aborted) {
        controller.error(new DOMException('Aborted', 'AbortError'));
        return;
      }

      try {
        const { done, value } = await iterator.next();

        if (signal?.aborted) {
          controller.error(new DOMException('Aborted', 'AbortError'));
          return;
        }

        if (done) {
          removeAbortHandler();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (e) {
        removeAbortHandler();
        if (!signal?.aborted) controller.error(e);
      }
    },

    async cancel(reason) {
      removeAbortHandler();

      if (typeof iterator.return === 'function') {
        await iterator.return();
      }

      await session.cancel(reason);
    },
  });
}

/**
 * Helper to pipe a fetch Response body into a DecodeSession.
 */
export async function fromResponse(
  response: Response,
  session: DecodeSession,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) throw new Error('[jxl-stream] Response has no body');
  return fromReadableStream(response.body, session, signal);
}

/**
 * Helper to turn a Blob into a stream and pipe it to a session.
 */
export async function fromBlob(
  blob: Blob,
  session: DecodeSession,
  signal?: AbortSignal,
): Promise<void> {
  return fromReadableStream(blob.stream() as ReadableStream<Uint8Array>, session, signal);
}

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
 * Fetch the first `byteCount` bytes of `url` via an HTTP Range request and pipe into `session`.
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
export async function fromRangePrefix(
  url: string,
  byteCount: number,
  session: DecodeSession,
  opts: RangePrefixOptions = {},
): Promise<void> {
  if (!Number.isFinite(byteCount) || byteCount <= 0) {
    throw new RangeError('[jxl-stream] byteCount must be a positive finite number');
  }

  const { signal, headers, fetchImpl = globalThis.fetch, onRangeNegotiated } = opts;

  if (signal?.aborted) {
    await session.cancel(ABORT_REASON);
    return;
  }

  const mergedHeaders = new Headers(headers);
  mergedHeaders.set('Range', `bytes=0-${byteCount - 1}`);

  const resp = await fetchImpl(url, { headers: mergedHeaders, signal });

  if (resp.status === 416) {
    throw new RangeError(`[jxl-stream] 416 Range Not Satisfiable: ${url}`);
  }
  if (!resp.ok && resp.status !== 206) {
    throw new Error(`[jxl-stream] HTTP ${resp.status} ${resp.statusText}: ${url}`);
  }
  if (!resp.body) {
    throw new Error('[jxl-stream] Response has no body');
  }

  const honored = resp.status === 206;
  const fullSize =
    parseContentRangeTotal(resp.headers.get('Content-Range')) ??
    parseNonNegativeInt(resp.headers.get('Content-Length'));

  let negotiationPosted = false;
  const postNegotiation = (delivered: number) => {
    if (negotiationPosted || onRangeNegotiated === undefined) return;
    negotiationPosted = true;
    const info: RangeNegotiation = { requested: byteCount, honored, delivered };
    if (fullSize !== undefined) info.fullSize = fullSize;
    onRangeNegotiated(info);
  };

  const reader = resp.body.getReader();
  let delivered = 0;

  const cancelBoth = (reason: string) =>
    Promise.allSettled([session.cancel(reason), reader.cancel(reason)]);

  const onAbort = () => { void cancelBoth(ABORT_REASON); };

  if (signal?.aborted) {
    await cancelBoth(ABORT_REASON);
    return;
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    let pending = reader.read();

    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const { done, value } = await pending;
      if (done) break;

      const remaining = byteCount - delivered;
      if (remaining <= 0) {
        void reader.cancel('range satisfied');
        break;
      }

      // Pipeline next read with current push (matches fromReadableStream pattern).
      pending = remaining > value.byteLength ? reader.read() : Promise.resolve({ done: true, value: undefined as unknown as Uint8Array });

      const chunk = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      delivered += chunk.byteLength;

      await session.push(chunk);

      if (delivered >= byteCount) {
        void reader.cancel('range satisfied');
        break;
      }
    }

    postNegotiation(delivered);

    if (signal?.aborted) {
      await session.cancel(ABORT_REASON);
      return;
    }
    await session.close();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await cancelBoth(reason);
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch { /* already released by cancel() */ }
  }
}

/**
 * Parse the `total` component of a `Content-Range: bytes start-end/total` header.
 * Returns undefined for missing header or `*` (unknown total).
 */
function parseContentRangeTotal(header: string | null): number | undefined {
  if (header === null) return undefined;
  const match = /\/(\d+)\s*$/.exec(header);
  if (match === null) return undefined;
  return parseNonNegativeInt(match[1]);
}

function parseNonNegativeInt(s: string | null | undefined): number | undefined {
  if (s === null || s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}
