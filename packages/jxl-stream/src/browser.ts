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

const ABORT_REASON = 'AbortSignal triggered';

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
export async function fromReadableStream(
  stream: ReadableStream<Uint8Array>,
  session: DecodeSession,
  signalOrOpts?: AbortSignal | PipeOptions,
): Promise<number> {
  const opts: PipeOptions = signalOrOpts instanceof AbortSignal ? { signal: signalOrOpts } : (signalOrOpts ?? {});
  const signal = opts.signal;
  const maxBytes = opts.maxBytes;

  if (maxBytes !== undefined) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new RangeError('[jxl-stream] maxBytes must be a positive finite number');
    }
  }

  // SB-8: wrap getReader; cancel session on throw then rethrow.
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch (e) {
    await session.cancel(String(e));
    throw e;
  }

  const cancelBoth = (reason: string) => {
    // SB-2: ensure string (defensive)
    const r = typeof reason === 'string' ? reason : String(reason);
    return Promise.allSettled([session.cancel(r), reader.cancel(r)]);
  };

  const onAbort = () => { void cancelBoth(ABORT_REASON); };

  if (signal?.aborted) {
    await cancelBoth(ABORT_REASON);
    return 0;
  }

  signal?.addEventListener('abort', onAbort, { once: true });

  let delivered = 0;

  try {
    // SB-3 / maxBytes: no type anno on let (prevents cycle through ReadResult.value); cast only the null branch on reassign.
    let pending = reader.read();

    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      if (pending === null) {
        if (maxBytes != null) void reader.cancel('maxBytes satisfied');
        break;
      }

      const { done, value } = await pending;
      if (done) break;

      const remaining = maxBytes != null ? maxBytes - delivered : Infinity;
      if (remaining <= 0) {
        void reader.cancel('maxBytes satisfied');
        break;
      }

      pending = remaining > value.byteLength ? reader.read() : (null as any);

      const chunk = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      delivered += chunk.byteLength;

      await session.push(chunk);

      if (maxBytes != null && delivered >= maxBytes) {
        void reader.cancel('maxBytes satisfied');
        break;
      }
    }

    if (signal?.aborted) {
      await session.cancel(ABORT_REASON);
      return delivered;
    }

    await session.close();
    return delivered;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await cancelBoth(reason);
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch { /* already released by cancel() on some platforms */ }
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

      // SB-2: coerce non-string / undefined cancel reason to string for session.
      const r = typeof reason === 'string' ? reason : reason === undefined ? 'stream cancelled' : String(reason);
      try {
        if (typeof iterator.return === 'function') {
          await iterator.return();
        }
      } finally {
        await session.cancel(r);
      }
    },
  });
}

/**
 * Helper to pipe a fetch Response body into a DecodeSession.
 * Accepts signal or PipeOptions (maxBytes forwarded); returns bytes delivered.
 */
export async function fromResponse(
  response: Response,
  session: DecodeSession,
  signalOrOpts?: AbortSignal | PipeOptions,
): Promise<number> {
  if (!response.body) throw new Error('[jxl-stream] Response has no body');
  return fromReadableStream(response.body, session, signalOrOpts);
}

/**
 * Helper to turn a Blob into a stream and pipe it to a session.
 * Accepts signal or PipeOptions (maxBytes forwarded); returns bytes delivered.
 */
export async function fromBlob(
  blob: Blob,
  session: DecodeSession,
  signalOrOpts?: AbortSignal | PipeOptions,
): Promise<number> {
  return fromReadableStream(blob.stream() as ReadableStream<Uint8Array>, session, signalOrOpts);
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
  /** ETag from the response, if present. Useful for safe resumable Range with If-Range. */
  etag?: string;
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
 * Serializable state for resuming a previous byte-range fetch.
 * Persist this (e.g. with jxl-cache or your own storage) across reconnects or app restarts.
 * Use with resumeFromByteRange() to continue from where you left off,
 * automatically using If-Range when an etag is available for safety.
 */
export interface ByteRangeResumeState {
  url: string;
  start: number;          // next byte to request (usually previous delivered)
  endExclusive: number;
  etag?: string;          // from the first successful RangeNegotiation
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
export function createByteRangeResumeState(
  url: string,
  previous: RangeNegotiation,
  originalStart: number = 0
): ByteRangeResumeState {
  const originalEnd = originalStart + previous.requested;
  return {
    url,
    start: previous.delivered,
    endExclusive: originalEnd,
    etag: previous.etag,
    fullSize: previous.fullSize,
  };
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
export async function fromByteRange(
  url: string,
  start: number,
  endExclusive: number,
  session: DecodeSession,
  opts: RangePrefixOptions = {},
): Promise<RangeNegotiation> {
  if (!Number.isFinite(start) || !Number.isFinite(endExclusive) || start < 0 || start >= endExclusive) {
    throw new RangeError('[jxl-stream] start and endExclusive must satisfy 0 <= start < endExclusive and be finite');
  }

  const { signal, headers, fetchImpl = globalThis.fetch, onRangeNegotiated } = opts;
  const requested = endExclusive - start;

  let delivered = 0;
  let honored = false;
  let fullSize: number | undefined;
  let etagFromResponse: string | undefined;
  let info: RangeNegotiation | undefined;

  const makeInfo = (d: number): RangeNegotiation => {
    if (!info) {
      info = { requested, honored, delivered: d };
      if (fullSize !== undefined) info.fullSize = fullSize;
      if (etagFromResponse) info.etag = etagFromResponse;
    }
    info.delivered = d;
    return info;
  };

  if (signal?.aborted) {
    await session.cancel(ABORT_REASON);
    return makeInfo(0);
  }

  // SB-1 guard adapted for general range (fetch + reader).
  let resp: Response;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    const mergedHeaders = new Headers(headers);
    mergedHeaders.set('Range', `bytes=${start}-${endExclusive - 1}`);
    resp = await fetchImpl(url, { headers: mergedHeaders, signal });
    if (resp.status === 416) throw new RangeError(`[jxl-stream] 416 Range Not Satisfiable: ${url}`);
    if (!resp.ok && resp.status !== 206) throw new Error(`[jxl-stream] HTTP ${resp.status} ${resp.statusText}: ${url}`);
    if (!resp.body) throw new Error('[jxl-stream] Response has no body');
    reader = resp.body.getReader();
  } catch (e) {
    await session.cancel(e instanceof Error ? e.message : String(e));
    throw e;
  }

  honored = resp.status === 206;
  fullSize =
    parseContentRangeTotal(resp.headers.get('Content-Range')) ??
    parseNonNegativeInt(resp.headers.get('Content-Length'));
  etagFromResponse = resp.headers.get('ETag') || undefined;

  const cancelBoth = (reason: string) => {
    // SB-2: ensure string (defensive)
    const r = typeof reason === 'string' ? reason : String(reason);
    return Promise.allSettled([session.cancel(r), reader.cancel(r)]);
  };

  const onAbort = () => { void cancelBoth(ABORT_REASON); };

  if (signal?.aborted) {
    await cancelBoth(ABORT_REASON);
    return makeInfo(0);
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    // SB-3: no type anno on let (lets inference from read() init); cast only null branch. Avoids 'value' cycle in reassign.
    let pending = reader.read();
    let skipped = 0;
    const target = endExclusive - start;

    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      if (pending === null) {
        void reader.cancel('range satisfied');
        break;
      }

      const { done, value } = await pending;
      if (done) break;

      let current: Uint8Array = value;

      // 200 fallback: skip leading bytes before delivering window content.
      if (!honored && skipped < start) {
        const need = start - skipped;
        if (current.byteLength <= need) {
          skipped += current.byteLength;
          pending = reader.read();
          continue;
        }
        current = current.subarray(need);
        skipped = start;
      }

      const remaining = target - delivered;
      if (remaining <= 0) {
        void reader.cancel('range satisfied');
        break;
      }

      pending = remaining > current.byteLength ? reader.read() : (null as any);

      const chunk = current.byteLength <= remaining ? current : current.subarray(0, remaining);
      delivered += chunk.byteLength;

      await session.push(chunk);

      if (delivered >= target) {
        void reader.cancel('range satisfied');
        break;
      }
    }

    if (signal?.aborted) {
      await session.cancel(ABORT_REASON);
      return makeInfo(delivered);
    }
    await session.close();
    return makeInfo(delivered);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await cancelBoth(reason);
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch { /* already released by cancel() */ }
    // SB-5: fire onRangeNegotiated from finally (error paths report delivered too); build info once.
    onRangeNegotiated?.(makeInfo(delivered));
  }
}

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
export async function fromRangePrefix(
  url: string,
  byteCount: number,
  session: DecodeSession,
  opts: RangePrefixOptions = {},
): Promise<RangeNegotiation> {
  if (!Number.isFinite(byteCount) || byteCount <= 0) {
    throw new RangeError('[jxl-stream] byteCount must be a positive finite number');
  }
  return fromByteRange(url, 0, byteCount, session, opts);
}

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
export async function resumeFromByteRange(
  state: ByteRangeResumeState,
  session: DecodeSession,
  opts: RangePrefixOptions = {}
): Promise<RangeNegotiation> {
  if (!Number.isFinite(state.start) || !Number.isFinite(state.endExclusive) ||
      state.start < 0 || state.start >= state.endExclusive) {
    throw new RangeError('[jxl-stream] resume state has invalid start/endExclusive');
  }

  const resumeOpts: RangePrefixOptions = { ...opts };

  if (state.etag) {
    const merged = new Headers(opts.headers);
    // If-Range tells the server: only honor the Range if the etag still matches,
    // otherwise send the full resource (or 412). Our skip logic will still do the right thing.
    merged.set('If-Range', state.etag);
    resumeOpts.headers = merged;
  }

  return fromByteRange(state.url, state.start, state.endExclusive, session, resumeOpts);
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
  // SB-4: strict digits only; reject "123abc", "1e3", etc before Number coercion.
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}
