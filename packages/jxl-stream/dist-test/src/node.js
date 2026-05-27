import { Readable } from 'node:stream';
/**
 * Pipes a Node.js Readable stream into a DecodeSession.
 */
export async function fromNodeReadable(readable, session, signal) {
    const onAbort = () => {
        session.cancel('AbortSignal triggered');
        readable.destroy(new Error('Aborted'));
    };
    if (signal?.aborted) {
        onAbort();
        return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        for await (const chunk of readable) {
            if (signal?.aborted)
                break;
            await session.push(chunk);
        }
        if (signal?.aborted) {
            await session.cancel('AbortSignal triggered');
        }
        else {
            await session.close();
        }
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
 * Turns an EncodeSession's output chunks into a Node.js Readable stream.
 */
export function toNodeReadable(session, signal) {
    return Readable.from(session.chunks(), { signal });
}
/**
 * bufferedReader helper: accumulates byte ranges for callers that prefer
 * to push by byte range rather than by chunk.
 */
export class BufferedReader {
    buffer = new Uint8Array(0);
    append(chunk) {
        const newBuffer = new Uint8Array(this.buffer.length + chunk.length);
        newBuffer.set(this.buffer);
        newBuffer.set(chunk, this.buffer.length);
        this.buffer = newBuffer;
    }
    /**
     * Returns and removes `size` bytes from the head.
     * Returns null if not enough bytes.
     */
    take(size) {
        if (this.buffer.length < size)
            return null;
        const chunk = this.buffer.slice(0, size);
        this.buffer = this.buffer.slice(size);
        return chunk;
    }
    /**
     * Returns all remaining bytes.
     */
    takeAll() {
        const chunk = this.buffer;
        this.buffer = new Uint8Array(0);
        return chunk;
    }
    get length() {
        return this.buffer.length;
    }
}
