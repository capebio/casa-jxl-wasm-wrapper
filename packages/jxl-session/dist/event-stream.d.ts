export declare class AsyncEventStream<T> implements AsyncIterable<T> {
    private readonly buffer;
    private _head;
    private waiter;
    private ended;
    private failure;
    private hasFailure;
    private returned;
    clear(): void;
    push(item: T): void;
    end(): void;
    fail(err: unknown): void;
    [Symbol.asyncIterator](): AsyncIterator<T>;
}
//# sourceMappingURL=event-stream.d.ts.map