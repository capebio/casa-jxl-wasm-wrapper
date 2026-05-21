import { Readable, Writable } from 'node:stream';
import { DecodeSession, EncodeSession } from './browser.js';

/**
 * Pipes a Node.js Readable stream into a DecodeSession.
 */
export async function fromNodeReadable(
  readable: Readable,
  session: DecodeSession,
  signal?: AbortSignal
): Promise<void> {
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
      if (signal?.aborted) break;
      await session.push(chunk);
    }
    if (!signal?.aborted) {
      await session.close();
    }
  } catch (e) {
    await session.cancel(e instanceof Error ? e.message : String(e));
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Turns an EncodeSession's output chunks into a Node.js Readable stream.
 */
export function toNodeReadable(
  session: EncodeSession,
  signal?: AbortSignal
): Readable {
  return Readable.from(session.chunks(), { signal });
}

/**
 * bufferedReader helper: accumulates byte ranges for callers that prefer 
 * to push by byte range rather than by chunk.
 */
export class BufferedReader {
  private buffer = new Uint8Array(0);

  append(chunk: Uint8Array): void {
    const newBuffer = new Uint8Array(this.buffer.length + chunk.length);
    newBuffer.set(this.buffer);
    newBuffer.set(chunk, this.buffer.length);
    this.buffer = newBuffer;
  }

  /**
   * Returns and removes `size` bytes from the head.
   * Returns null if not enough bytes.
   */
  take(size: number): Uint8Array | null {
    if (this.buffer.length < size) return null;
    const chunk = this.buffer.slice(0, size);
    this.buffer = this.buffer.slice(size);
    return chunk;
  }

  /**
   * Returns all remaining bytes.
   */
  takeAll(): Uint8Array {
    const chunk = this.buffer;
    this.buffer = new Uint8Array(0);
    return chunk;
  }

  get length(): number {
    return this.buffer.length;
  }
}
