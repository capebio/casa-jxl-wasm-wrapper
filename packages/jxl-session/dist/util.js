// jxl-session/src/util.ts
// Small shared helpers for the session facade.
export function deferred() {
    let resolve;
    let reject;
    const d = { settled: false };
    d.promise = new Promise((res, rej) => {
        resolve = (v) => { d.settled = true; res(v); };
        reject = (e) => { d.settled = true; rej(e); };
    });
    d.resolve = resolve;
    d.reject = reject;
    return d;
}
// Normalize a chunk to a standalone ArrayBuffer suitable for transfer.
// An exact-span Uint8Array transfers its buffer directly; a partial view
// is copied so the transfer does not detach memory the caller still holds.
export function toTransferableBuffer(chunk) {
    if (chunk instanceof ArrayBuffer)
        return chunk;
    if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) {
        return chunk.buffer;
    }
    return chunk.slice().buffer;
}
// Generate a session id. crypto.randomUUID is available in browsers and Node >= 19.
export function newSessionId() {
    return `jxl-${crypto.randomUUID()}`;
}
//# sourceMappingURL=util.js.map