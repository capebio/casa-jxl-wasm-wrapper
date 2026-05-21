export interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (err: unknown) => void;
    settled: boolean;
}
export declare function deferred<T>(): Deferred<T>;
export declare function toTransferableBuffer(chunk: ArrayBuffer | Uint8Array): ArrayBuffer;
export declare function newSessionId(): string;
//# sourceMappingURL=util.d.ts.map