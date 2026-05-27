/// <reference types="node" resolution-mode="require"/>
import { Readable } from 'node:stream';
import { DecodeSession, EncodeSession } from './browser.js';
/**
 * Pipes a Node.js Readable stream into a DecodeSession.
 */
export declare function fromNodeReadable(readable: Readable, session: DecodeSession, signal?: AbortSignal): Promise<void>;
/**
 * Turns an EncodeSession's output chunks into a Node.js Readable stream.
 */
export declare function toNodeReadable(session: EncodeSession, signal?: AbortSignal): Readable;
/**
 * bufferedReader helper: accumulates byte ranges for callers that prefer
 * to push by byte range rather than by chunk.
 */
export declare class BufferedReader {
    private buffer;
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
