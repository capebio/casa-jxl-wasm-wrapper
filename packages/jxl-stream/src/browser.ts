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

export const ABORT_REASON = 'AbortSignal triggered';

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

  // Idempotent teardown: onAbort and the catch/abort exit paths may both request a
  // cancel; cancel the session at most once so a second cancel can't hit torn-down state.
  let cancelled = false;
  const cancelBoth = (reason: string): Promise<unknown> => {
    if (cancelled) return Promise.resolve();
    cancelled = true;
    // SB-2: ensure string (defensive)
    const r = typeof reason === 'string' ? reason : String(reason);
    return Promise.allSettled([session.cancel(r), reader.cancel(r)]);
  };
  // Supervised reader-only cancel for intentional, non-error cutoffs (maxBytes).
  // The returned promise is awaited on exit so close() never races an unsettled cancel.
  let readerCancel: Promise<unknown> | null = null;
  const cancelReader = (reason: string): void => {
    if (readerCancel !== null) return;
    readerCancel = reader.cancel(reason);
    void (readerCancel as Promise<unknown>).catch(() => {});
  };

  const onAbort = () => { void cancelBoth(ABORT_REASON); };

  if (signal?.aborted) {
    await cancelBoth(ABORT_REASON);
    return 0;
  }

  signal?.addEventListener('abort', onAbort, { once: true });

  let delivered = 0;
  // Mirror of the in-flight prefetched read, typed loosely so the finally can settle it
  // without inducing the 'value' self-reference cycle that an annotated `pending` causes.
  let inflight: Promise<unknown> | null = null;

  try {
    // Mark prefetch rejections as handled; the loop still awaits and surfaces them.
    const read = () => {
      const p = reader.read();
      void p.catch(() => {});
      inflight = p;
      return p;
    };
    // SB-3 / maxBytes: no type anno on let (prevents cycle through ReadResult.value); cast only the null branch on reassign.
    let pending = read();

    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      if (pending === null) {
        if (maxBytes != null) cancelReader('maxBytes satisfied');
        break;
      }

      const { done, value } = await pending;
      inflight = null;
      if (done) break;

      if (value.byteLength === 0) {
        pending = read();
        continue;
      }

      const remaining = maxBytes != null ? maxBytes - delivered : Infinity;
      if (remaining <= 0) {
        cancelReader('maxBytes satisfied');
        break;
      }

      pending = remaining > value.byteLength ? read() : (null as any);

      const chunk = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      delivered += chunk.byteLength;

      await session.push(chunk);

      if (maxBytes != null && delivered >= maxBytes) {
        cancelReader('maxBytes satisfied');
        break;
      }
    }

    if (signal?.aborted) {
      await cancelBoth(ABORT_REASON);
      return delivered;
    }

    await session.close();
    return delivered;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await cancelBoth(reason);
    // Mid-stream abort: resolve (not reject) so callers need no try/catch.
    // The caller distinguishes abort from error via signal.aborted.
    if (signal?.aborted) return delivered;
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Settle the in-flight prefetched read (and any supervised reader cancel) before
    // releasing the lock, so teardown ordering is deterministic on every exit path.
    if (inflight !== null) { try { await inflight; } catch { /* swallowed; loop already handled/surfaced */ } }
    if (readerCancel !== null) { try { await readerCancel; } catch { /* unsupervised cancel rejection */ } }
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

  // Idempotent: the abort handler and the underlying-source cancel() can both fire
  // (near-simultaneous signal-abort + stream-cancel); cancel the session at most once.
  let sessionCancelled = false;
  const cancelSession = (reason: string): Promise<unknown> => {
    if (sessionCancelled) return Promise.resolve();
    sessionCancelled = true;
    return Promise.resolve(session.cancel(reason));
  };

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
        void cancelSession(ABORT_REASON);
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
        await cancelSession(r);
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

/**
 * Pipe the byte window [start, endExclusive) of a Blob into a session.
 * Blob.slice is a zero-copy reference — ideal for OPFS-cached pyramid files
 * where the manifest supplies exact per-level/tile offsets (local analogue of fromByteRange).
 * Window is clamped to blob.size; start at/after the end delivers 0 bytes and closes cleanly.
 */
export async function fromBlobRange(
  blob: Blob,
  start: number,
  endExclusive: number,
  session: DecodeSession,
  signalOrOpts?: AbortSignal | PipeOptions,
): Promise<number> {
  if (!Number.isFinite(start) || !Number.isFinite(endExclusive) || start < 0 || start >= endExclusive) {
    throw new RangeError('[jxl-stream] start and endExclusive must satisfy 0 <= start < endExclusive and be finite');
  }
  const slice = blob.slice(start, Math.min(endExclusive, blob.size));
  return fromReadableStream(slice.stream() as ReadableStream<Uint8Array>, session, signalOrOpts);
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
  /**
   * Last-Modified from the response, if present. Used as an If-Range validator
   * when no (strong) ETag is available, so a resume can still pin the version.
   */
  lastModified?: string;
  /**
   * The absolute byte offset the window started at in *this* request
   * (the `start` passed to fromByteRange; 0 for prefix fetches). Lets
   * createByteRangeResumeState reconstruct the absolute resume cursor without
   * the caller re-supplying it.
   */
  absoluteStart?: number;
  /**
   * True if the transfer ended before the expected window was fully delivered
   * (delivered < requested) AND that shortfall is not explained by reaching the
   * known end of the resource. A truncated transfer the caller should not treat
   * as a complete window. (A legitimately short resource — body ends at fullSize —
   * is NOT flagged.)
   */
  underDelivered?: boolean;
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
  /**
   * Marks this fetch as a *resume continuation* (the session already holds bytes
   * from an earlier request for the same window). Set automatically by
   * resumeFromByteRange. When true, a 200 fallback (the server ignored Range and
   * is sending the whole — possibly changed — resource) is treated as a hard
   * failure regardless of whether a validator was present: splicing offset-skipped
   * bytes of an unverified body onto an old prefix would silently corrupt the
   * stitched result. Also makes a 206 re-validate the response ETag against
   * expectEtag (a misbehaving cache may 206 a newer object).
   */
  resuming?: boolean;
}

/**
 * Serializable state for resuming a previous byte-range fetch.
 * Persist this (e.g. with jxl-cache or your own storage) across reconnects or app restarts.
 * Use with resumeFromByteRange() to continue from where you left off,
 * automatically using If-Range when an etag is available for safety.
 */
export interface ByteRangeResumeState {
  url: string;
  start: number;          // next absolute byte offset to request
  endExclusive: number;
  etag?: string;          // from the first successful RangeNegotiation
  lastModified?: string;  // fallback If-Range validator when no strong ETag
  fullSize?: number;
}

/**
 * Create a resume state from a previous negotiation (typically the one returned
 * by fromByteRange or fromRangePrefix).
 *
 * originalStart: the absolute `start` you used in the *first* fromByteRange call
 *   (usually 0 for prefix/tile fetches). If omitted, it is recovered from
 *   `previous.absoluteStart` (threaded through by fromByteRange), so callers no
 *   longer have to re-supply it for non-zero-based tile/window fetches. An
 *   explicit argument always wins (back-compat).
 *
 * The resume window end is bounded by the known resource size (`fullSize`) when
 * available, so resuming a short/truncated transfer never requests bytes past
 * EOF (which would 416 / RangeError).
 */
export function createByteRangeResumeState(
  url: string,
  previous: RangeNegotiation,
  originalStart?: number
): ByteRangeResumeState {
  // Prefer the absolute start the request actually used; fall back to an
  // explicit caller value, else 0 (legacy zero-based default).
  const absStart = originalStart ?? previous.absoluteStart ?? 0;
  let originalEnd = absStart + previous.requested;
  // Bound the window end by the known EOF: a short resource means the window
  // really ended at fullSize, so never resume for bytes that do not exist.
  if (previous.fullSize !== undefined && originalEnd > previous.fullSize) {
    originalEnd = previous.fullSize;
  }
  const resumeStart = absStart + previous.delivered;
  return {
    url,
    // Clamp so start never exceeds end (a fully-delivered short window collapses
    // to start === endExclusive, which resumeFromByteRange treats as complete).
    start: resumeStart > originalEnd ? originalEnd : resumeStart,
    endExclusive: originalEnd,
    etag: previous.etag,
    lastModified: previous.lastModified,
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

  const { signal, headers, fetchImpl = globalThis.fetch, onRangeNegotiated, onHeaders, priority } = opts;
  const requested = endExclusive - start;

  let delivered = 0;
  let honored = false;
  let fullSize: number | undefined;
  let etagFromResponse: string | undefined;
  let lastModifiedFromResponse: string | undefined;
  let info: RangeNegotiation | undefined;

  let t0: number | undefined = undefined;
  let tHeaders: number | undefined = undefined;

  const makeInfo = (d: number): RangeNegotiation => {
    if (!info) {
      info = { requested, honored, delivered: d, absoluteStart: start };
      if (fullSize !== undefined) info.fullSize = fullSize;
      if (etagFromResponse) info.etag = etagFromResponse;
      if (lastModifiedFromResponse) info.lastModified = lastModifiedFromResponse;
      if (t0 !== undefined && tHeaders !== undefined) {
        info.ttfbMs = tHeaders - t0;
      }
    }
    info.delivered = d;
    return info;
  };

  if (signal?.aborted) {
    await session.cancel(ABORT_REASON);
    return makeInfo(0);
  }

  t0 = performance.now();
  let resp: Response;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    const mergedHeaders = new Headers(headers);
    mergedHeaders.set('Range', `bytes=${start}-${endExclusive - 1}`);
    resp = await fetchImpl(url, { headers: mergedHeaders, signal, priority } as RequestInit);
    if (resp.status === 416) throw new RangeError(`[jxl-stream] 416 Range Not Satisfiable: ${url}`);
    if (!resp.ok) throw new Error(`[jxl-stream] HTTP ${resp.status} ${resp.statusText}: ${url}`);
    if (!resp.body) throw new Error('[jxl-stream] Response has no body');
    reader = resp.body.getReader();
  } catch (e) {
    await session.cancel(e instanceof Error ? e.message : String(e));
    throw e;
  }

  tHeaders = performance.now();

  honored = resp.status === 206;
  const cr = parseContentRange(resp.headers.get('Content-Range'));
  // P0-4: on 206, Content-Length is the PART size, not the full resource — only fall back on 200.
  fullSize = cr.total ?? (!honored ? parseNonNegativeInt(resp.headers.get('Content-Length')) : undefined);
  etagFromResponse = resp.headers.get('ETag') || undefined;
  lastModifiedFromResponse = resp.headers.get('Last-Modified') || undefined;

  // SB-5/abort: idempotent teardown. Both onAbort and the catch/abort exit paths
  // can request a cancel; cancel the session at most once, and supervise the
  // reader cancel rather than firing it and walking away.
  let cancelled = false;
  const cancelBoth = (reason: string): Promise<unknown> => {
    if (cancelled) return Promise.resolve();
    cancelled = true;
    // SB-2: ensure string (defensive)
    const r = typeof reason === 'string' ? reason : String(reason);
    return Promise.allSettled([session.cancel(r), reader.cancel(r)]);
  };
  // Cancel only the reader (intentional, non-error cutoffs like "range satisfied").
  // Supervised: the returned promise is awaited on exit so close() never races it.
  let readerCancel: Promise<unknown> | null = null;
  const cancelReader = (reason: string): void => {
    if (readerCancel !== null) return;
    readerCancel = reader.cancel(reason);
    void (readerCancel as Promise<unknown>).catch(() => {});
  };

  const onAbort = () => { void cancelBoth(ABORT_REASON); };

  if (signal?.aborted) {
    await cancelBoth(ABORT_REASON);
    return makeInfo(0);
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  // Resume integrity (ROOT 2): a 200 fallback means the server ignored Range and is
  // streaming the whole (possibly changed) resource. During a resume the session
  // already holds an old prefix; splicing offset-skipped new bytes onto it corrupts
  // the stitched result. Fail on ANY 200 fallback while resuming — even with no/weak
  // validator (the no-ETag hole) — rather than blindly splice.
  if ((opts.resuming || opts.expectEtag) && !honored) {
    const why = opts.expectEtag && etagFromResponse && etagFromResponse !== opts.expectEtag
      ? 'ETag mismatch'
      : 'Range ignored (200) on resume; version cannot be confirmed';
    const err = new Error(`[jxl-stream] resource changed during resume (${why}); restart from byte 0`);
    await cancelBoth(err.message);
    throw err;
  }

  // Resume integrity (ROOT 2): even an honored 206 can come from a misbehaving cache
  // serving a newer object. If we pinned a validator, re-check it on the 206 too.
  if (opts.expectEtag && honored && etagFromResponse && etagFromResponse !== opts.expectEtag) {
    const err = new Error('[jxl-stream] resource changed during resume (ETag mismatch on 206); restart from byte 0');
    await cancelBoth(err.message);
    throw err;
  }

  // P1-2: a 206 whose Content-Range start differs from what we asked would silently corrupt.
  if (honored && cr.start !== start) {
    const err = new Error(`[jxl-stream] server returned mismatched range start ${cr.start}, expected ${start}: ${url}`);
    await cancelBoth(err.message);
    throw err;
  }

  // Content-Range end validation (ROOT 3): inclusive ranges. A fully-honored window
  // [start, endExclusive) has cr.end === endExclusive-1. Two cases are tolerated and
  // NOT errors: (a) a SHORTER end because the resource ends early (short-resource), and
  // (b) a WIDER end because a server coalesced/rounded the range (RFC 7233 permits this)
  // — the body loop caps delivery to the requested window, so the byte count stays correct.
  // What IS rejected here is a structurally impossible part: an end below the start, which
  // would mean a negative-length window and a server we cannot trust to align bytes.
  if (honored && cr.end !== undefined && cr.start !== undefined && cr.end < cr.start) {
    const err = new Error(`[jxl-stream] server returned malformed Content-Range end ${cr.end} < start ${cr.start}: ${url}`);
    await cancelBoth(err.message);
    throw err;
  }

  // onHeaders may throw; if it does, tear down the reader+session and surface it
  // (otherwise the body reader stays locked and the consumer never settles).
  try {
    onHeaders?.(makeInfo(0));
  } catch (e) {
    await cancelBoth(e instanceof Error ? e.message : String(e));
    signal?.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch { /* already released by cancel() */ }
    throw e;
  }

  // Expected bytes for this window, bounded by the known EOF (short-resource aware).
  // `available` is how many of the requested bytes actually exist in the resource:
  // the full window when EOF is unknown, else the portion before fullSize (>= 0).
  const target = endExclusive - start;
  const available = fullSize !== undefined ? Math.max(0, fullSize - start) : target;
  const expected = Math.min(target, available);

  // Mirror of the in-flight prefetched read, typed loosely so the finally can settle it
  // without inducing the 'value' self-reference cycle that an annotated `pending` causes.
  let inflight: Promise<unknown> | null = null;
  try {
    // Mark prefetch rejections as handled; the loop still awaits and surfaces them.
    const read = () => {
      const p = reader.read();
      void p.catch(() => {});
      inflight = p;
      return p;
    };
    // SB-3: no type anno on let (lets inference from read() init); cast only null branch. Avoids 'value' cycle in reassign.
    let pending = read();
    let skipped = 0;

    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      if (pending === null) {
        cancelReader('range satisfied');
        break;
      }

      const { done, value } = await pending;
      inflight = null;
      if (done) break;

      if (value.byteLength === 0) {
        pending = read();
        continue;
      }

      let current: Uint8Array = value;

      // 200 fallback: skip leading bytes before delivering window content.
      if (!honored && skipped < start) {
        const need = start - skipped;
        if (current.byteLength <= need) {
          skipped += current.byteLength;
          pending = read();
          continue;
        }
        current = current.subarray(need);
        skipped = start;
      }

      const remaining = target - delivered;
      if (remaining <= 0) {
        cancelReader('range satisfied');
        break;
      }

      pending = remaining > current.byteLength ? read() : (null as any);

      const chunk = current.byteLength <= remaining ? current : current.subarray(0, remaining);
      delivered += chunk.byteLength;

      await session.push(chunk);

      if (delivered >= target) {
        cancelReader('range satisfied');
        break;
      }
    }

    if (signal?.aborted) {
      await cancelBoth(ABORT_REASON);
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
    // Settle the in-flight prefetched read (and any supervised reader cancel) before
    // releasing the lock, so teardown ordering is deterministic on every exit path.
    if (inflight !== null) { try { await inflight; } catch { /* swallowed; loop already handled/surfaced */ } }
    if (readerCancel !== null) { try { await readerCancel; } catch { /* unsupervised cancel rejection */ } }
    try { reader.releaseLock(); } catch { /* already released by cancel() */ }
    const finalInfo = makeInfo(delivered);
    if (tHeaders !== undefined) {
      finalInfo.transferMs = performance.now() - tHeaders;
    }
    // Completeness (ROOT 4): flag a transfer that did not deliver the bytes that
    // should exist, so callers distinguish truncation from a legitimately complete
    // window. Two cases: (a) fewer bytes than the EOF-bounded available portion
    // (truncated/short connection), or (b) the requested window lies entirely past
    // EOF (available === 0 but the caller asked for a non-empty window — e.g. a 200
    // fallback whose body ended before `start`). A legitimately short resource whose
    // available portion was fully delivered (delivered === expected, available > 0)
    // is NOT flagged. cancelled transfers already reject, so they are excluded.
    if (!cancelled && (delivered < expected || (available === 0 && target > 0 && fullSize !== undefined))) {
      finalInfo.underDelivered = true;
    }
    // SB-5: fire onRangeNegotiated from finally (error paths report delivered too); build info once.
    onRangeNegotiated?.(finalInfo);
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
 * - If the state has a strong ETag, adds `If-Range: <etag>`; otherwise falls back
 *   to `If-Range: <Last-Modified>` when a date validator is available, so the
 *   resume can still pin the resource version.
 * - This is always flagged as a resume continuation: a 200 fallback (server ignored
 *   Range, sending the whole — possibly changed — resource) is treated as a hard
 *   failure rather than splicing offset-skipped bytes of an unverified body onto the
 *   old prefix. This closes the no-validator / weak-validator version-skew hole.
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
  if (state.start === state.endExclusive) {
    // Previous transfer completed; nothing to fetch.
    await session.close();
    return { requested: 0, honored: true, delivered: 0, fullSize: state.fullSize, etag: state.etag };
  }

  if (!Number.isFinite(state.start) || !Number.isFinite(state.endExclusive) ||
      state.start < 0 || state.start >= state.endExclusive) {
    throw new RangeError('[jxl-stream] resume state has invalid start/endExclusive');
  }

  // Always a resume continuation: the session may already hold an earlier prefix,
  // so a 200 fallback must fail rather than splice offset-skipped new-version bytes.
  const resumeOpts: RangePrefixOptions = { ...opts, resuming: true };

  const strongEtag = state.etag && !state.etag.startsWith('W/') ? state.etag : undefined;
  // If-Range validator: prefer a strong ETag; otherwise fall back to Last-Modified
  // (an HTTP-date validator is valid in If-Range). A weak ETag is never used for
  // If-Range (RFC 7232: If-Range requires a strong validator for the ETag form).
  const ifRange = strongEtag ?? state.lastModified;
  if (ifRange) {
    const merged = new Headers(opts.headers);
    // On validator mismatch the server ignores Range and returns 200 with the full
    // new resource; expectEtag (strong) and the resuming flag both detect this and fail fast.
    merged.set('If-Range', ifRange);
    resumeOpts.headers = merged;
  }
  if (strongEtag) {
    resumeOpts.expectEtag = strongEtag;
  }

  return fromByteRange(state.url, state.start, state.endExclusive, session, resumeOpts);
}

interface ParsedContentRange { start?: number; end?: number; total?: number }

/** Parse `Content-Range: bytes start-end/total` (or `bytes * /total`). */
function parseContentRange(header: string | null): ParsedContentRange {
  if (header === null) return {};
  const m = /^\s*bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+|\*)\s*$/i.exec(header);
  if (m === null) return {};
  return {
    start: m[1] !== undefined ? parseNonNegativeInt(m[1]) : undefined,
    end: m[2] !== undefined ? parseNonNegativeInt(m[2]) : undefined,
    total: m[3] !== '*' ? parseNonNegativeInt(m[3]) : undefined,
  };
}

function parseNonNegativeInt(s: string | null | undefined): number | undefined {
  if (s === null || s === undefined) return undefined;
  // SB-4: strict digits only; reject "123abc", "1e3", etc before Number coercion.
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}
