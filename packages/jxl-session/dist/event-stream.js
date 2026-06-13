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
// ES-4: module-level singletons for terminal iterator results (zero per-completion allocation).
const DONE = Object.freeze({ value: undefined, done: true });
const DONE_PROMISE = Promise.resolve(DONE);
export class AsyncEventStream {
    buffer = [];
    // Head-index cursor: O(1) amortised reads instead of O(n) Array.shift()
    // (task 007-performance-c9d0e1f2).
    _head = 0;
    // ES-3: single waiter slot (was array). Single-consumer contract guarantees
    // at most one outstanding waiter at any time.
    waiter = null;
    ended = false;
    failure = null;
    hasFailure = false;
    // ES-2: set by return(); causes subsequent push() to drop (no buffering after consumer broke).
    returned = false;
    // ES-5: explicit clear for return() and compaction hygiene.
    clear() { this.buffer.length = 0; this._head = 0; }
    // Emit an item to the next waiting consumer, or buffer it.
    push(item) {
        if (this.ended || this.returned)
            return; // ES-2: drop post-return pushes
        const w = this.waiter;
        if (w !== null) {
            this.waiter = null;
            w.resolve({ value: item, done: false });
        }
        else
            this.buffer.push(item);
    }
    // Signal normal completion. Pending consumers receive { done: true }.
    // Idempotent; uses the single slot (not a queue).
    end() {
        if (this.ended)
            return;
        this.ended = true;
        const w = this.waiter;
        if (w !== null) {
            this.waiter = null;
            w.resolve(DONE);
        }
        // Buffered items (if any) are still delivered by next() warm path before done.
    }
    // Signal an error. Pending consumers reject with it; later consumers too.
    // The buffer is cleared immediately: fail() means "no partial data" —
    // use end() (after pushing the partial frame) for graceful budget-exceeded.
    // Idempotent; keeps clearing buffer; uses the single slot.
    fail(err) {
        if (this.ended)
            return;
        this.ended = true;
        this.hasFailure = true;
        this.failure = err;
        // Drop buffered items to release any held references (e.g. pixel ArrayBuffers).
        this.buffer.length = 0;
        this._head = 0;
        const w = this.waiter;
        if (w !== null) {
            this.waiter = null;
            w.reject(err);
        }
    }
    [Symbol.asyncIterator]() {
        return {
            next: () => {
                // ES-2: after return(), further next() must not observe state or buffer.
                if (this.returned) {
                    return DONE_PROMISE;
                }
                // Warm paths: avoid allocating a Promise when we can resolve synchronously
                // (task 007-performance-e5f6a7b8).
                if (this._head < this.buffer.length) {
                    // O(1) read via head-index cursor (task 007-performance-c9d0e1f2).
                    // ES-1: release the slot's reference immediately so large objects
                    // (e.g. transferred pixel ArrayBuffers) are not rooted until compaction.
                    const value = this.buffer[this._head];
                    this.buffer[this._head] = undefined; // assigning undefined keeps PACKED_ELEMENTS, no hole
                    this._head++;
                    // Compact when head is beyond 64 entries AND more than half the array
                    // is consumed, keeping memory bounded without per-item allocation.
                    // (Do not lower the 64 threshold — ratified.)
                    if (this._head > 64 && this._head > this.buffer.length >> 1) {
                        this.buffer.copyWithin(0, this._head);
                        this.buffer.length -= this._head;
                        this._head = 0;
                    }
                    return Promise.resolve({ value, done: false });
                }
                if (this.hasFailure) {
                    return Promise.reject(this.failure);
                }
                if (this.ended) {
                    return DONE_PROMISE;
                }
                // Cold path: no item ready — suspend and wait.
                return new Promise((resolve, reject) => {
                    this.waiter = { resolve, reject };
                });
            },
            // Called when a for-await-of loop exits early (break/return/throw in
            // the loop body). Resolve the pending waiter as done so it does not
            // leak until the session's own end()/fail() eventually drains it.
            //
            // SINGLE-CONSUMER ASSUMPTION: Because of the single-consumer contract
            // (each iterator calls next() once at a time), the (at most one) waiter
            // slot holds the outstanding waiter when return() is called
            // (task 007-logic-c9d0e1f2 / 007-concurrency-e1f2a3b4).
            // Multi-consumer usage would require keying waiters by iterator identity.
            return: () => {
                this.returned = true;
                this.clear(); // ES-5 + drop any unconsumed refs
                const w = this.waiter;
                if (w !== null) {
                    this.waiter = null;
                    w.resolve(DONE);
                }
                return DONE_PROMISE;
            },
        };
    }
}
//# sourceMappingURL=event-stream.js.map