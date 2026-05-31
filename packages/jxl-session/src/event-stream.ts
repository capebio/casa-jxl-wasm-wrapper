// jxl-session/src/event-stream.ts
// Push-driven AsyncIterable. The session pushes events as worker messages
// arrive; callers consume via for-await. Backpressure on the consumer side
// is naturally applied — push() buffers when no consumer is waiting.
//
// SINGLE-CONSUMER CONTRACT: AsyncEventStream is designed for exactly one
// active iterator at a time. The waiting queue and return() logic are not
// safe with multiple concurrent for-await consumers. The public
// [Symbol.asyncIterator]() is unrestricted by the AsyncIterable<T> type,
// but callers must not open a second loop while the first is still running
// (task 007-contracts-7s8t9u).

export class AsyncEventStream<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  // Head-index cursor: O(1) amortised reads instead of O(n) Array.shift()
  // (task 007-performance-c9d0e1f2).
  private _head = 0;

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
  // The buffer is cleared immediately: fail() means "no partial data" —
  // use end() (after pushing the partial frame) for graceful budget-exceeded.
  fail(err: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.hasFailure = true;
    this.failure = err;
    // Drop buffered items to release any held references (e.g. pixel ArrayBuffers).
    this.buffer.length = 0;
    this._head = 0;
    while (this.waiting.length > 0) {
      const w = this.waiting.shift()!;
      w.reject(err);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        // Warm paths: avoid allocating a Promise when we can resolve synchronously
        // (task 007-performance-e5f6a7b8).
        if (this._head < this.buffer.length) {
          // O(1) read via head-index cursor (task 007-performance-c9d0e1f2).
          const value = this.buffer[this._head++]!;
          // Compact when head is beyond 64 entries AND more than half the array
          // is consumed, keeping memory bounded without per-item allocation.
          if (this._head > 64 && this._head > this.buffer.length >> 1) {
            this.buffer.splice(0, this._head);
            this._head = 0;
          }
          return Promise.resolve({ value, done: false });
        }
        if (this.hasFailure) {
          return Promise.reject(this.failure);
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        // Cold path: no item ready — suspend and wait.
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiting.push({ resolve, reject });
        });
      },
      // Called when a for-await-of loop exits early (break/return/throw in
      // the loop body). Resolve the pending waiter as done so it does not
      // leak until the session's own end()/fail() eventually drains it.
      //
      // SINGLE-CONSUMER ASSUMPTION: Because we use a FIFO queue and each
      // iterator calls next() once at a time, the outstanding waiter for
      // this iterator is always waiting[0] when return() is called
      // (task 007-logic-c9d0e1f2 / 007-concurrency-e1f2a3b4).
      // Multi-consumer usage would require keying waiters by iterator identity.
      return: (): Promise<IteratorResult<T>> => {
        const w = this.waiting.shift();
        if (w !== undefined) {
          w.resolve({ value: undefined as never, done: true });
        }
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}
