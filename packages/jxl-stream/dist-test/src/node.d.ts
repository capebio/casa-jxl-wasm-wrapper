import { Readable } from 'node:stream';
import { type DecodeSession, type EncodeSession, type PipeOptions } from './browser.js';
/**
 * Pipes a Node.js Readable into a DecodeSession.
 * Honours backpressure (awaits session.push); prefetches the next chunk during push dispatch.
 * Accepts AbortSignal (back-compat) or PipeOptions {signal?, maxBytes?}.
 * maxBytes is the client-side convergedByteEnd cutoff: last chunk trimmed via subarray,
 * readable destroyed (intentional cutoff), session closed gracefully. Returns bytes delivered.
 */
export declare function fromNodeReadable(readable: Readable, session: DecodeSession, signalOrOpts?: AbortSignal | PipeOptions): Promise<number>;
/**
 * Turns an EncodeSession's output chunks into a byte-mode Node.js Readable.
 * Buffer.from(ArrayBuffer) is a zero-copy view. Consumer destroy / signal abort
 * cancels the session (Readable.from calls iterator.return(), which runs `finally`).
 */
export declare function toNodeReadable(session: EncodeSession, signal?: AbortSignal): Readable;
/**
 * bufferedReader helper: accumulates byte ranges for callers that prefer
 * to push by byte range rather than by chunk.
 * Chunk-deque internals: append is O(1) (no re-copy of accumulated bytes);
 * take copies only the bytes returned. Returned arrays are fresh copies.
 */
export declare class BufferedReader {
    private chunks;
    private head;
    private total;
    append(chunk: Uint8Array): void;
    /**
     * Returns and removes `size` bytes from the head.
     * Returns null if not enough bytes.
     */
    take(size: number): Uint8Array | null;
    /**
     * Returns all remaining bytes.
     */
    takeAll(): Uint8Array;
    get length(): number;
}
