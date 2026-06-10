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
export async function fromReadableStream(stream, session, signalOrOpts) {
    const opts = signalOrOpts instanceof AbortSignal ? { signal: signalOrOpts } : (signalOrOpts ?? {});
    const signal = opts.signal;
    const maxBytes = opts.maxBytes;
    if (maxBytes !== undefined) {
        if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
            throw new RangeError('[jxl-stream] maxBytes must be a positive finite number');
        }
    }
    // SB-8: wrap getReader; cancel session on throw then rethrow.
    let reader;
    try {
        reader = stream.getReader();
    }
    catch (e) {
        await session.cancel(String(e));
        throw e;
    }
    const cancelBoth = (reason) => {
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
            if (signal?.aborted)
                throw new DOMException('Aborted', 'AbortError');
            if (pending === null) {
                if (maxBytes != null)
                    void reader.cancel('maxBytes satisfied');
                break;
            }
            const { done, value } = await pending;
            if (done)
                break;
            const remaining = maxBytes != null ? maxBytes - delivered : Infinity;
            if (remaining <= 0) {
                void reader.cancel('maxBytes satisfied');
                break;
            }
            pending = remaining > value.byteLength ? reader.read() : null;
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
    }
    catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        await cancelBoth(reason);
        throw e;
    }
    finally {
        signal?.removeEventListener('abort', onAbort);
        try {
            reader.releaseLock();
        }
        catch { /* already released by cancel() on some platforms */ }
    }
}
/**
 * Turns an EncodeSession's output chunks into a ReadableStream.
 */
export function toReadableStream(session, signal) {
    const iterator = session.chunks()[Symbol.asyncIterator]();
    let abortHandler = null;
    const removeAbortHandler = () => {
        if (abortHandler !== null && signal !== undefined) {
            signal.removeEventListener('abort', abortHandler);
            abortHandler = null;
        }
    };
    return new ReadableStream({
        start(controller) {
            if (signal === undefined)
                return;
            abortHandler = () => {
                void session.cancel(ABORT_REASON);
                controller.error(new DOMException('Aborted', 'AbortError'));
            };
            if (signal.aborted) {
                abortHandler();
            }
            else {
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
                }
                else {
                    controller.enqueue(value);
                }
            }
            catch (e) {
                removeAbortHandler();
                if (!signal?.aborted)
                    controller.error(e);
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
            }
            finally {
                await session.cancel(r);
            }
        },
    });
}
/**
 * Helper to pipe a fetch Response body into a DecodeSession.
 * Accepts signal or PipeOptions (maxBytes forwarded); returns bytes delivered.
 */
export async function fromResponse(response, session, signalOrOpts) {
    if (!response.body)
        throw new Error('[jxl-stream] Response has no body');
    return fromReadableStream(response.body, session, signalOrOpts);
}
/**
 * Helper to turn a Blob into a stream and pipe it to a session.
 * Accepts signal or PipeOptions (maxBytes forwarded); returns bytes delivered.
 */
export async function fromBlob(blob, session, signalOrOpts) {
    return fromReadableStream(blob.stream(), session, signalOrOpts);
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
export async function fromByteRange(url, start, endExclusive, session, opts = {}) {
    if (!Number.isFinite(start) || !Number.isFinite(endExclusive) || start < 0 || start >= endExclusive) {
        throw new RangeError('[jxl-stream] start and endExclusive must satisfy 0 <= start < endExclusive and be finite');
    }
    const { signal, headers, fetchImpl = globalThis.fetch, onRangeNegotiated } = opts;
    const requested = endExclusive - start;
    let delivered = 0;
    let honored = false;
    let fullSize;
    let info;
    const makeInfo = (d) => {
        if (!info) {
            info = { requested, honored, delivered: d };
            if (fullSize !== undefined)
                info.fullSize = fullSize;
        }
        info.delivered = d;
        return info;
    };
    if (signal?.aborted) {
        await session.cancel(ABORT_REASON);
        return makeInfo(0);
    }
    // SB-1 guard adapted for general range (fetch + reader).
    let resp;
    let reader;
    try {
        const mergedHeaders = new Headers(headers);
        mergedHeaders.set('Range', `bytes=${start}-${endExclusive - 1}`);
        resp = await fetchImpl(url, { headers: mergedHeaders, signal });
        if (resp.status === 416)
            throw new RangeError(`[jxl-stream] 416 Range Not Satisfiable: ${url}`);
        if (!resp.ok && resp.status !== 206)
            throw new Error(`[jxl-stream] HTTP ${resp.status} ${resp.statusText}: ${url}`);
        if (!resp.body)
            throw new Error('[jxl-stream] Response has no body');
        reader = resp.body.getReader();
    }
    catch (e) {
        await session.cancel(e instanceof Error ? e.message : String(e));
        throw e;
    }
    honored = resp.status === 206;
    fullSize =
        parseContentRangeTotal(resp.headers.get('Content-Range')) ??
            parseNonNegativeInt(resp.headers.get('Content-Length'));
    const cancelBoth = (reason) => {
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
            if (signal?.aborted)
                throw new DOMException('Aborted', 'AbortError');
            if (pending === null) {
                void reader.cancel('range satisfied');
                break;
            }
            const { done, value } = await pending;
            if (done)
                break;
            let current = value;
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
            pending = remaining > current.byteLength ? reader.read() : null;
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
    }
    catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        await cancelBoth(reason);
        throw e;
    }
    finally {
        signal?.removeEventListener('abort', onAbort);
        try {
            reader.releaseLock();
        }
        catch { /* already released by cancel() */ }
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
export async function fromRangePrefix(url, byteCount, session, opts = {}) {
    if (!Number.isFinite(byteCount) || byteCount <= 0) {
        throw new RangeError('[jxl-stream] byteCount must be a positive finite number');
    }
    return fromByteRange(url, 0, byteCount, session, opts);
}
/**
 * Parse the `total` component of a `Content-Range: bytes start-end/total` header.
 * Returns undefined for missing header or `*` (unknown total).
 */
function parseContentRangeTotal(header) {
    if (header === null)
        return undefined;
    const match = /\/(\d+)\s*$/.exec(header);
    if (match === null)
        return undefined;
    return parseNonNegativeInt(match[1]);
}
function parseNonNegativeInt(s) {
    if (s === null || s === undefined)
        return undefined;
    // SB-4: strict digits only; reject "123abc", "1e3", etc before Number coercion.
    if (!/^\d+$/.test(s))
        return undefined;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0)
        return undefined;
    return n;
}
