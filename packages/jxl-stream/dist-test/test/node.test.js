// jxl-stream/test/node.test.ts
// Tests for Node.js-specific stream helpers and optimized BufferedReader.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { fromNodeReadable, toNodeReadable, BufferedReader } from "../src/node.js";
function makeDecodeSession() {
    const s = {
        pushes: [],
        closed: false,
        cancelled: null,
        async push(chunk) {
            s.pushes.push(new Uint8Array(chunk));
        },
        async close() { s.closed = true; },
        async cancel(reason) { s.cancelled = reason ?? "cancelled"; }
    };
    return s;
}
function makeEncodeSession(chunks) {
    const s = {
        chunksList: chunks,
        cancelled: null,
        async *chunks() {
            for (const c of s.chunksList)
                yield c;
        },
        async cancel(reason) { s.cancelled = reason ?? "cancelled"; }
    };
    return s;
}
describe("toNodeReadable", () => {
    it("emits byte-mode Buffers and handles successful end of stream", async () => {
        const chunk1 = new Uint8Array([1, 2, 3]).buffer;
        const chunk2 = new Uint8Array([4, 5]).buffer;
        const session = makeEncodeSession([chunk1, chunk2]);
        const readable = toNodeReadable(session);
        assert.equal(readable.readableObjectMode, false, "must not be in objectMode");
        const emitted = [];
        for await (const chunk of readable) {
            emitted.push(chunk);
            assert.ok(chunk instanceof Buffer, "emitted chunks must be Buffers");
        }
        const fullBuffer = Buffer.concat(emitted);
        assert.deepEqual(fullBuffer, Buffer.from([1, 2, 3, 4, 5]));
        assert.equal(session.cancelled, null, "should not be cancelled on clean completion");
    });
    it("calls session.cancel on consumer destroy", async () => {
        const chunk1 = new Uint8Array([1, 2, 3]).buffer;
        const chunk2 = new Uint8Array([4, 5]).buffer;
        const session = makeEncodeSession([chunk1, chunk2]);
        const readable = toNodeReadable(session);
        // Read one chunk then destroy the stream
        const it = readable[Symbol.asyncIterator]();
        const first = await it.next();
        assert.ok(!first.done);
        assert.deepEqual(first.value, Buffer.from([1, 2, 3]));
        await new Promise((resolve) => {
            readable.on("close", resolve);
            readable.destroy();
        });
        // Check that session cancel was triggered
        assert.equal(session.cancelled, "stream destroyed");
    });
});
describe("fromNodeReadable", () => {
    it("pipes chunks to session, prefetches, handles completion", async () => {
        const session = makeDecodeSession();
        const source = Readable.from([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
        const delivered = await fromNodeReadable(source, session);
        assert.equal(delivered, 4);
        assert.equal(session.closed, true);
        assert.deepEqual(session.pushes, [new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    });
    it("supports maxBytes trim at exact boundary and stops reading", async () => {
        const session = makeDecodeSession();
        let pulledThird = false;
        let readCount = 0;
        const source = new Readable({
            highWaterMark: 0,
            read() {
                readCount++;
                if (readCount === 1) {
                    this.push(new Uint8Array([1, 2, 3, 4]));
                }
                else if (readCount === 2) {
                    this.push(new Uint8Array([5, 6, 7, 8]));
                }
                else if (readCount === 3) {
                    pulledThird = true;
                    this.push(new Uint8Array([9, 10]));
                }
                else {
                    this.push(null);
                }
            }
        });
        const delivered = await fromNodeReadable(source, session, { maxBytes: 8 });
        assert.equal(delivered, 8);
        assert.equal(session.closed, true);
        assert.equal(session.pushes.length, 2);
        assert.equal(pulledThird, false, "third chunk must not be pulled");
        assert.deepEqual(session.pushes, [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8])]);
    });
    it("supports maxBytes mid-chunk trim", async () => {
        const session = makeDecodeSession();
        const source = Readable.from([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8])]);
        const delivered = await fromNodeReadable(source, session, { maxBytes: 6 });
        assert.equal(delivered, 6);
        assert.equal(session.closed, true);
        assert.equal(session.pushes.length, 2);
        assert.deepEqual(session.pushes[0], new Uint8Array([1, 2, 3, 4]));
        assert.deepEqual(session.pushes[1], new Uint8Array([5, 6]));
    });
    it("throws TypeError on string chunk (do not call setEncoding)", async () => {
        const session = makeDecodeSession();
        const source = Readable.from(["not a binary stream"]);
        await assert.rejects(fromNodeReadable(source, session), (err) => err instanceof TypeError && /requires a binary stream/.test(err.message));
        assert.notEqual(session.cancelled, null);
    });
    it("handles pre-aborted signal correctly", async () => {
        const session = makeDecodeSession();
        const source = Readable.from([new Uint8Array([1, 2])]);
        source.on("error", () => { });
        const controller = new AbortController();
        controller.abort();
        const delivered = await fromNodeReadable(source, session, { signal: controller.signal });
        assert.equal(delivered, 0);
        assert.notEqual(session.cancelled, null);
    });
});
describe("BufferedReader (deque optimized)", () => {
    it("basic append, take, takeAll and length accounting", () => {
        const reader = new BufferedReader();
        assert.equal(reader.length, 0);
        reader.append(new Uint8Array([1, 2]));
        assert.equal(reader.length, 2);
        // take short -> returns null
        assert.equal(reader.take(5), null);
        assert.equal(reader.length, 2);
        // take exact from first chunk
        const t1 = reader.take(2);
        assert.deepEqual(t1, new Uint8Array([1, 2]));
        assert.equal(reader.length, 0);
        // append multiple chunks
        reader.append(new Uint8Array([3, 4, 5]));
        reader.append(new Uint8Array([6, 7]));
        reader.append(new Uint8Array([8]));
        assert.equal(reader.length, 6);
        // take within first chunk
        const t2 = reader.take(2);
        assert.deepEqual(t2, new Uint8Array([3, 4]));
        assert.equal(reader.length, 4);
        // take spanning multiple chunks (remaining of chunk 1: [5], chunk 2: [6, 7] -> total 3 bytes)
        const t3 = reader.take(3);
        assert.deepEqual(t3, new Uint8Array([5, 6, 7]));
        assert.equal(reader.length, 1);
        // take zero-size
        assert.deepEqual(reader.take(0), new Uint8Array(0));
        // takeAll
        const tAll = reader.takeAll();
        assert.deepEqual(tAll, new Uint8Array([8]));
        assert.equal(reader.length, 0);
        // append and takeAll on empty
        assert.deepEqual(reader.takeAll(), new Uint8Array(0));
    });
    it("ignored empty appends", () => {
        const reader = new BufferedReader();
        reader.append(new Uint8Array(0));
        assert.equal(reader.length, 0);
    });
});
