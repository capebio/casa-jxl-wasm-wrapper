/**
 * Minimal interfaces matching Section 5 for compilation.
 */
export interface DecodeSession {
  push(chunk: ArrayBuffer | Uint8Array): Promise<void>;
  close(): Promise<void>;
  cancel(reason?: string): Promise<void>;
}

export interface EncodeSession {
  chunks(): AsyncIterable<ArrayBuffer>;
  cancel(reason?: string): Promise<void>;
}

/**
 * Pipes a ReadableStream into a DecodeSession.
 * Honours backpressure: awaits session.push() before reading next chunk.
 */
export async function fromReadableStream(
  stream: ReadableStream<Uint8Array>, 
  session: DecodeSession,
  signal?: AbortSignal
): Promise<void> {
  const reader = stream.getReader();
  
  const onAbort = () => {
    session.cancel('AbortSignal triggered');
    reader.cancel('AbortSignal triggered');
  };
  
  if (signal?.aborted) {
    onAbort();
    return;
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await session.push(value);
    }
    await session.close();
  } catch (e) {
    await session.cancel(e instanceof Error ? e.message : String(e));
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
  signal?: AbortSignal
): ReadableStream<ArrayBuffer> {
  const iterator = session.chunks()[Symbol.asyncIterator]();
  
  return new ReadableStream({
    async pull(controller) {
      if (signal?.aborted) {
        controller.error(new Error('Aborted'));
        return;
      }
      try {
        const { done, value } = await iterator.next();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel(reason) {
      await session.cancel(reason);
    }
  });
}

/**
 * Helper to turn a Blob into a stream and pipe it to a session.
 */
export async function fromBlob(
  blob: Blob,
  session: DecodeSession,
  signal?: AbortSignal
): Promise<void> {
  return fromReadableStream(blob.stream() as ReadableStream<Uint8Array>, session, signal);
}
