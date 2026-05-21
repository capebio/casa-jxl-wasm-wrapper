// jxl-session/src/util.ts
// Small shared helpers for the session facade.

// Deferred — a promise with externally accessible resolve/reject.
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
  settled: boolean;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const d: Partial<Deferred<T>> = { settled: false };
  d.promise = new Promise<T>((res, rej) => {
    resolve = (v) => { d.settled = true; res(v); };
    reject = (e) => { d.settled = true; rej(e); };
  });
  d.resolve = resolve;
  d.reject = reject;
  return d as Deferred<T>;
}

// Normalize a chunk to a standalone ArrayBuffer suitable for transfer.
// An exact-span Uint8Array transfers its buffer directly; a partial view
// is copied so the transfer does not detach memory the caller still holds.
export function toTransferableBuffer(chunk: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (chunk instanceof ArrayBuffer) return chunk;
  if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) {
    return chunk.buffer;
  }
  return chunk.slice().buffer;
}

// Generate a session id. crypto.randomUUID is available in browsers and Node >= 19.
export function newSessionId(): string {
  return `jxl-${crypto.randomUUID()}`;
}
