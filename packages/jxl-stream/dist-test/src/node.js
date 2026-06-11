import { Readable } from 'node:stream';
/**
 * Pipes a Node.js Readable into a DecodeSession.
 * Honours backpressure (awaits session.push); prefetches the next chunk during push dispatch.
 * Accepts AbortSignal (back-compat) or PipeOptions {signal?, maxBytes?}.
 * maxBytes is the client-side convergedByteEnd cutoff: last chunk trimmed via subarray,
 * readable destroyed (intentional cutoff), session closed gracefully. Returns bytes delivered.
 */
export async function fromNodeReadable(readable, session, signalOrOpts) {
    const opts = signalOrOpts instanceof AbortSignal ? { signal: signalOrOpts } : (signalOrOpts ?? {});
    const { signal, maxBytes } = opts;
    if (maxBytes !== undefined && (!Number.isFinite(maxBytes) || maxBytes <= 0)) {
        throw new RangeError('[jxl-stream] maxBytes must be a positive finite number');
    }
    const onAbort = () => {
        void session.cancel('AbortSignal triggered');
        readable.destroy(new Error('Aborted'));
    };
    if (signal?.aborted) {
        readable.destroy(new Error('Aborted'));
        await session.cancel('AbortSignal triggered'); // P1-6: awaited, no floating promise
        return 0;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    let delivered = 0;
    try {
        const it = readable[Symbol.asyncIterator]();
        let pending = it.next();
        while (true) {
            const { done, value } = await pending;
            if (done)
                break;
            if (signal?.aborted)
                break;
            if (typeof value === 'string') {
                throw new TypeError('[jxl-stream] fromNodeReadable requires a binary stream (do not call setEncoding)');
            }
            let chunk = value;
            if (chunk.byteLength === 0) {
                pending = it.next();
                continue;
            }
            const remaining = maxBytes != null ? maxBytes - delivered : Infinity;
            const cutoff = chunk.byteLength >= remaining;
            pending = cutoff ? Promise.resolve({ done: true, value: undefined }) : it.next();
            if (chunk.byteLength > remaining)
                chunk = chunk.subarray(0, remaining);
            delivered += chunk.byteLength;
            await session.push(chunk);
            if (cutoff) {
                readable.destroy();
                break;
            }
        }
        if (signal?.aborted) {
            await session.cancel('AbortSignal triggered');
        }
        else {
            await session.close();
        }
        return delivered;
    }
    catch (e) {
        await session.cancel(e instanceof Error ? e.message : String(e));
        throw e;
    }
    finally {
        signal?.removeEventListener('abort', onAbort);
    }
}
/**
 * Turns an EncodeSession's output chunks into a byte-mode Node.js Readable.
 * Buffer.from(ArrayBuffer) is a zero-copy view. Consumer destroy / signal abort
 * cancels the session (Readable.from calls iterator.return(), which runs `finally`).
 */
export function toNodeReadable(session, signal) {
    let finished = false;
    async function* buffers() {
        try {
            for await (const chunk of session.chunks())
                yield Buffer.from(chunk);
            finished = true;
        }
        finally {
            if (!finished)
                void session.cancel('stream destroyed');
        }
    }
    const stream = Readable.from(buffers(), { signal, objectMode: false });
    stream.on('close', () => {
        if (!finished) {
            finished = true;
            void session.cancel('stream destroyed');
        }
    });
    return stream;
}
/**
 * bufferedReader helper: accumulates byte ranges for callers that prefer
 * to push by byte range rather than by chunk.
 * Chunk-deque internals: append is O(1) (no re-copy of accumulated bytes);
 * take copies only the bytes returned. Returned arrays are fresh copies.
 */
export class BufferedReader {
    chunks = [];
    head = 0; // read offset into chunks[0]
    total = 0;
    append(chunk) {
        if (chunk.length === 0)
            return;
        this.chunks.push(chunk);
        this.total += chunk.length;
    }
    /**
     * Returns and removes `size` bytes from the head.
     * Returns null if not enough bytes.
     */
    take(size) {
        if (size < 0)
            return null;
        if (this.total < size)
            return null;
        if (size === 0)
            return new Uint8Array(0);
        const first = this.chunks[0];
        // Fast path: satisfied within the first chunk (copy preserves old slice() contract).
        if (first.length - this.head >= size) {
            const out = first.slice(this.head, this.head + size);
            this.head += size;
            this.total -= size;
            if (this.head === first.length) {
                this.chunks.shift();
                this.head = 0;
            }
            return out;
        }
        // Spanning path: coalesce across chunks.
        const out = new Uint8Array(size);
        let copied = 0;
        while (copied < size) {
            const c = this.chunks[0];
            const n = Math.min(c.length - this.head, size - copied);
            out.set(c.subarray(this.head, this.head + n), copied);
            copied += n;
            this.head += n;
            this.total -= n;
            if (this.head === c.length) {
                this.chunks.shift();
                this.head = 0;
            }
        }
        return out;
    }
    /**
     * Returns all remaining bytes.
     */
    takeAll() {
        return this.take(this.total) ?? new Uint8Array(0);
    }
    get length() {
        return this.total;
    }
}
