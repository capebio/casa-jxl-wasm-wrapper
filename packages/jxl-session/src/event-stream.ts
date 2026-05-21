// jxl-session/src/event-stream.ts
// Push-driven AsyncIterable. The session pushes events as worker messages
// arrive; callers consume via for-await. Backpressure on the consumer side
// is naturally applied — push() buffers when no consumer is waiting.

export class AsyncEventStream<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiting: Array<{
    resolve: (r: IteratorResult<T>) => void;
    reject: (e: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown = null;
  private hasFailure = false;

  // Emit an item to the next waiting consumer, or buffer it.
  push(item: T): void {
    if (this.ended) return;
    const w = this.waiting.shift();
    if (w !== undefined) {
      w.resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  // Signal normal completion. Pending consumers receive { done: true }.
  end(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiting.length > 0) {
      const w = this.waiting.shift()!;
      w.resolve({ value: undefined as never, done: true });
    }
  }

  // Signal an error. Pending consumers reject with it; later consumers too.
  fail(err: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.hasFailure = true;
    this.failure = err;
    while (this.waiting.length > 0) {
      const w = this.waiting.shift()!;
      w.reject(err);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> =>
        new Promise<IteratorResult<T>>((resolve, reject) => {
          // Buffered items drain first, even after end/fail.
          if (this.buffer.length > 0) {
            resolve({ value: this.buffer.shift()!, done: false });
            return;
          }
          if (this.hasFailure) {
            reject(this.failure);
            return;
          }
          if (this.ended) {
            resolve({ value: undefined as never, done: true });
            return;
          }
          this.waiting.push({ resolve, reject });
        }),
    };
  }
}
