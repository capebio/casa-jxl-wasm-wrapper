export declare class AsyncEventStream<T> implements AsyncIterable<T> {
    private readonly buffer;
    private readonly waiting;
    private ended;
    private failure;
    private hasFailure;
    push(item: T): void;
    end(): void;
    fail(err: unknown): void;
    [Symbol.asyncIterator](): AsyncIterator<T>;
}
//# sourceMappingURL=event-stream.d.ts.map