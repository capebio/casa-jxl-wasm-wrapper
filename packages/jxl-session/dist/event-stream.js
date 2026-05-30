// jxl-session/src/event-stream.ts
// Push-driven AsyncIterable. The session pushes events as worker messages
// arrive; callers consume via for-await. Backpressure on the consumer side
// is naturally applied — push() buffers when no consumer is waiting.
export class AsyncEventStream {
    buffer = [];
    waiting = [];
    ended = false;
    failure = null;
    hasFailure = false;
    // Emit an item to the next waiting consumer, or buffer it.
    push(item) {
        if (this.ended)
            return;
        const w = this.waiting.shift();
        if (w !== undefined) {
            w.resolve({ value: item, done: false });
        }
        else {
            this.buffer.push(item);
        }
    }
    // Signal normal completion. Pending consumers receive { done: true }.
    end() {
        if (this.ended)
            return;
        this.ended = true;
        while (this.waiting.length > 0) {
            const w = this.waiting.shift();
            w.resolve({ value: undefined, done: true });
        }
    }
    // Signal an error. Pending consumers reject with it; later consumers too.
    // The buffer is cleared immediately: fail() means "no partial data" —
    // use end() (after pushing the partial frame) for graceful budget-exceeded.
    fail(err) {
        if (this.ended)
            return;
        this.ended = true;
        this.hasFailure = true;
        this.failure = err;
        this.buffer.length = 0;
        while (this.waiting.length > 0) {
            const w = this.waiting.shift();
            w.reject(err);
        }
    }
    [Symbol.asyncIterator]() {
        return {
            next: () => new Promise((resolve, reject) => {
                // Buffered items drain first. After end() this drains remaining frames
                // (correct for finishWithError/budget-exceeded). After fail() the
                // buffer was already cleared, so this branch is never reached.
                if (this.buffer.length > 0) {
                    resolve({ value: this.buffer.shift(), done: false });
                    return;
                }
                if (this.hasFailure) {
                    reject(this.failure);
                    return;
                }
                if (this.ended) {
                    resolve({ value: undefined, done: true });
                    return;
                }
                this.waiting.push({ resolve, reject });
            }),
            // Called when a for-await-of loop exits early (break/return/throw in
            // the loop body). Resolve the pending waiter as done so it does not
            // leak until the session's own end()/fail() eventually drains it.
            return: () => {
                // Drain the pending waiter for this iterator, if any.
                // Because we use a FIFO queue and each iterator calls next() once
                // at a time, the outstanding waiter for this iterator is always
                // the first entry when return() is called.
                const w = this.waiting.shift();
                if (w !== undefined) {
                    w.resolve({ value: undefined, done: true });
                }
                return Promise.resolve({ value: undefined, done: true });
            },
        };
    }
}
//# sourceMappingURL=event-stream.js.map