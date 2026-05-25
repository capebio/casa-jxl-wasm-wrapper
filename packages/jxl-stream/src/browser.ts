export interface DecodeSession {
  push(chunk: ArrayBuffer | Uint8Array): Promise<void>;
  close(): Promise<void>;
  cancel(reason?: string): Promise<void>;
}

export interface EncodeSession {
  chunks(): AsyncIterable<ArrayBuffer | Uint8Array>;
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

      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

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
): ReadableStream<ArrayBuffer | Uint8Array> {
  const iterator = session.chunks()[Symbol.asyncIterator]();
  let abortHandler: (() => void) | null = null;

  const removeAbortHandler = () => {
    if (abortHandler !== null && signal !== undefined) {
      signal.removeEventListener('abort', abortHandler);
      abortHandler = null;
    }
  };

  return new ReadableStream<ArrayBuffer | Uint8Array>({
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
      if (signal?.aborted) return;

      try {
        const { done, value } = await iterator.next();

        if (signal?.aborted) return;

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
