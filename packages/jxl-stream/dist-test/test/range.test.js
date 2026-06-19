// jxl-stream/test/range.test.ts
// Tests for fromRangePrefix: byte-range HTTP fetch piped into a DecodeSession.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fromRangePrefix, fromByteRange, resumeFromByteRange, createByteRangeResumeState, fromReadableStream, fromBlobRange } from "../src/browser.js";
function makeSession() {
    const s = {
        pushes: [],
        closed: false,
        cancelled: null,
        async push(chunk) {
            const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            s.pushes.push(new Uint8Array(buf)); // copy: caller may reuse
        },
        async close() { s.closed = true; },
        async cancel(reason) { s.cancelled = reason ?? "cancelled"; },
    };
    return s;
}
function totalDelivered(s) {
    return s.pushes.reduce((n, c) => n + c.byteLength, 0);
}
/** Build a ReadableStream that emits the supplied chunks one by one. */
function streamFromChunks(chunks) {
    let i = 0;
    return new ReadableStream({
        pull(controller) {
            if (i >= chunks.length) {
                controller.close();
                return;
            }
            controller.enqueue(chunks[i++]);
        },
    });
}
/** Build a fake `fetch` that returns the given Response for any URL. */
function fakeFetch(resp) {
    return (async () => resp);
}
describe("fromRangePrefix", () => {
    it("happy path: 206 Partial Content delivers exactly requested bytes", async () => {
        const session = makeSession();
        const body = new Uint8Array(1000).fill(0xAB);
        let info;
        await fromRangePrefix("https://example.com/img.jxl", 1000, session, {
            fetchImpl: fakeFetch(new Response(streamFromChunks([body]), {
                status: 206,
                headers: { "Content-Range": "bytes 0-999/5000", "Content-Length": "1000" },
            })),
            onRangeNegotiated: (n) => { info = n; },
        });
        assert.equal(totalDelivered(session), 1000);
        assert.equal(session.closed, true);
        assert.equal(session.cancelled, null);
        assert.equal(info?.honored, true);
        assert.equal(info?.requested, 1000);
        assert.equal(info?.delivered, 1000);
        assert.equal(info?.fullSize, 5000);
    });
    it("206 over-read: caps delivery to requested, cancels reader", async () => {
        const session = makeSession();
        // Server sent more bytes than asked (CDN rounded to a chunk boundary).
        const body = new Uint8Array(4096).fill(0xCD);
        await fromRangePrefix("https://example.com/img.jxl", 1000, session, {
            fetchImpl: fakeFetch(new Response(streamFromChunks([body]), {
                status: 206,
                headers: { "Content-Range": "bytes 0-4095/100000" },
            })),
        });
        assert.equal(totalDelivered(session), 1000, "must cap to requested byteCount");
        assert.equal(session.closed, true);
    });
    it("200 OK fallback: server ignored Range, still cap at requested", async () => {
        const session = makeSession();
        const body = new Uint8Array(5000).fill(0xEF);
        let info;
        await fromRangePrefix("https://example.com/img.jxl", 1000, session, {
            fetchImpl: fakeFetch(new Response(streamFromChunks([body]), {
                status: 200,
                headers: { "Content-Length": "5000" },
            })),
            onRangeNegotiated: (n) => { info = n; },
        });
        assert.equal(totalDelivered(session), 1000);
        assert.equal(session.closed, true);
        assert.equal(info?.honored, false);
        assert.equal(info?.fullSize, 5000);
    });
    it("short resource: delivers all available bytes, no error", async () => {
        const session = makeSession();
        const body = new Uint8Array(50).fill(0x42);
        let info;
        await fromRangePrefix("https://example.com/tiny.jxl", 1_000_000, session, {
            fetchImpl: fakeFetch(new Response(streamFromChunks([body]), {
                status: 206,
                headers: { "Content-Range": "bytes 0-49/50" },
            })),
            onRangeNegotiated: (n) => { info = n; },
        });
        assert.equal(totalDelivered(session), 50);
        assert.equal(session.closed, true);
        assert.equal(info?.delivered, 50);
        assert.equal(info?.fullSize, 50);
    });
    it("multi-chunk body: stops mid-chunk when prefix reached", async () => {
        const session = makeSession();
        const chunks = [
            new Uint8Array(400).fill(0x01),
            new Uint8Array(400).fill(0x02),
            new Uint8Array(400).fill(0x03), // crosses 1000-byte boundary at offset 200
            new Uint8Array(400).fill(0x04), // never reached
        ];
        await fromRangePrefix("https://example.com/img.jxl", 1000, session, {
            fetchImpl: fakeFetch(new Response(streamFromChunks(chunks), {
                status: 206,
                headers: { "Content-Range": "bytes 0-1599/100000" },
            })),
        });
        assert.equal(totalDelivered(session), 1000);
        assert.equal(session.pushes.length, 3, "third chunk pushed truncated; fourth not pushed");
        assert.equal(session.pushes[2].byteLength, 200);
        assert.equal(session.pushes[2][0], 0x03);
    });
    it("416 Range Not Satisfiable: throws RangeError", async () => {
        const session = makeSession();
        await assert.rejects(fromRangePrefix("https://example.com/img.jxl", 1000, session, {
            fetchImpl: fakeFetch(new Response(null, { status: 416, statusText: "Range Not Satisfiable" })),
        }), (err) => err instanceof RangeError && /416/.test(err.message));
        assert.notEqual(session.cancelled, null);
        assert.equal(session.closed, false);
    });
    it("503 server error: throws with status, session not closed", async () => {
        const session = makeSession();
        await assert.rejects(fromRangePrefix("https://example.com/img.jxl", 1000, session, {
            fetchImpl: fakeFetch(new Response(null, { status: 503, statusText: "Service Unavailable" })),
        }), (err) => err instanceof Error && /503/.test(err.message));
        assert.equal(session.closed, false);
    });
    it("pre-aborted signal: cancels session, no fetch", async () => {
        const session = makeSession();
        const controller = new AbortController();
        controller.abort();
        let fetchCalled = false;
        const fetchSpy = (async () => {
            fetchCalled = true;
            return new Response(null);
        });
        await fromRangePrefix("https://example.com/img.jxl", 1000, session, {
            fetchImpl: fetchSpy,
            signal: controller.signal,
        });
        assert.equal(fetchCalled, false);
        assert.equal(session.cancelled !== null, true);
        assert.equal(session.closed, false);
    });
    it("abort mid-read: cancels session and reader", async () => {
        const session = makeSession();
        const controller = new AbortController();
        // Stream that emits one chunk then waits forever; abort triggers during the wait.
        const body = new ReadableStream({
            async pull(c) {
                c.enqueue(new Uint8Array(400).fill(0x77));
                // Trigger abort after first chunk is delivered.
                queueMicrotask(() => controller.abort());
                await new Promise((_, reject) => {
                    const onAbort = () => {
                        controller.signal.removeEventListener("abort", onAbort);
                        reject(new Error("AbortError"));
                    };
                    controller.signal.addEventListener("abort", onAbort, { once: true });
                });
            },
        });
        await assert.rejects(fromRangePrefix("https://example.com/img.jxl", 1000, session, {
            fetchImpl: fakeFetch(new Response(body, {
                status: 206,
                headers: { "Content-Range": "bytes 0-999/5000" },
            })),
            signal: controller.signal,
        }), (err) => err instanceof Error && /Abort/i.test(err.message));
        assert.equal(session.cancelled !== null, true);
        assert.equal(session.closed, false);
    });
    it("byteCount <= 0 throws RangeError", async () => {
        const session = makeSession();
        await assert.rejects(fromRangePrefix("https://example.com/img.jxl", 0, session, { fetchImpl: fakeFetch(new Response(null)) }), (err) => err instanceof RangeError);
        await assert.rejects(fromRangePrefix("https://example.com/img.jxl", -1, session, { fetchImpl: fakeFetch(new Response(null)) }), (err) => err instanceof RangeError);
    });
    it("byteCount NaN/Infinity throws RangeError", async () => {
        const session = makeSession();
        await assert.rejects(fromRangePrefix("https://example.com/img.jxl", Number.NaN, session, { fetchImpl: fakeFetch(new Response(null)) }), (err) => err instanceof RangeError);
        await assert.rejects(fromRangePrefix("https://example.com/img.jxl", Number.POSITIVE_INFINITY, session, { fetchImpl: fakeFetch(new Response(null)) }), (err) => err instanceof RangeError);
    });
    it("merges caller-supplied headers with Range", async () => {
        const session = makeSession();
        let seenAuth = null;
        let seenRange = null;
        const spy = (async (_url, init) => {
            const h = new Headers(init?.headers);
            seenAuth = h.get("Authorization");
            seenRange = h.get("Range");
            return new Response(streamFromChunks([new Uint8Array(100)]), {
                status: 206,
                headers: { "Content-Range": "bytes 0-99/1000" },
            });
        });
        await fromRangePrefix("https://example.com/img.jxl", 100, session, {
            fetchImpl: spy,
            headers: { Authorization: "Bearer secret" },
        });
        assert.equal(seenAuth, "Bearer secret");
        assert.equal(seenRange, "bytes=0-99");
    });
    it("Content-Range with `*` total: fullSize undefined", async () => {
        const session = makeSession();
        let info;
        await fromRangePrefix("https://example.com/img.jxl", 100, session, {
            fetchImpl: fakeFetch(new Response(streamFromChunks([new Uint8Array(100)]), {
                status: 206,
                headers: { "Content-Range": "bytes 0-99/*" },
            })),
            onRangeNegotiated: (n) => { info = n; },
        });
        assert.equal(info?.fullSize, undefined);
    });
    it("network error mid-read: re-throws and cancels session", async () => {
        const session = makeSession();
        const body = new ReadableStream({
            pull(c) {
                c.error(new Error("connection reset"));
            },
        });
        await assert.rejects(fromRangePrefix("https://example.com/img.jxl", 1000, session, {
            fetchImpl: fakeFetch(new Response(body, {
                status: 206,
                headers: { "Content-Range": "bytes 0-999/5000" },
            })),
        }), (err) => err instanceof Error && /connection reset/.test(err.message));
        assert.equal(session.cancelled !== null, true);
        assert.equal(session.closed, false);
    });
});
describe("fromByteRange (start > 0)", () => {
    it("206 window [1000, 2000) requests bytes=1000-1999, delivers 1000, closes", async () => {
        const session = makeSession();
        const body = new Uint8Array(1000).fill(0x22);
        let seenRange = null;
        const fetchSpy = (async (_url, init) => {
            seenRange = new Headers(init?.headers).get("Range");
            return new Response(streamFromChunks([body]), {
                status: 206,
                headers: { "Content-Range": "bytes 1000-1999/5000" }
            });
        });
        const info = await fromByteRange("https://example.com/img.jxl", 1000, 2000, session, {
            fetchImpl: fetchSpy
        });
        assert.equal(seenRange, "bytes=1000-1999");
        assert.equal(totalDelivered(session), 1000);
        assert.equal(session.closed, true);
        assert.equal(info.honored, true);
        assert.equal(info.delivered, 1000);
    });
    it("206 Content-Range start mismatch rejects and cancels session", async () => {
        const session = makeSession();
        const body = new Uint8Array(1000).fill(0x33);
        const fetchSpy = fakeFetch(new Response(streamFromChunks([body]), {
            status: 206,
            headers: { "Content-Range": "bytes 0-999/5000" }
        }));
        await assert.rejects(fromByteRange("https://example.com/img.jxl", 1000, 2000, session, {
            fetchImpl: fetchSpy
        }), (err) => err instanceof Error && /mismatched range start/.test(err.message));
        assert.notEqual(session.cancelled, null);
        assert.equal(session.closed, false);
    });
    it("200 fallback skip skips leading bytes in multi-chunk body", async () => {
        const session = makeSession();
        // 5000 bytes in 400-byte chunks.
        // Window [1000, 1600) -> requested 600 bytes.
        // Skip 1000 bytes. First 2 chunks (800 bytes) skipped completely.
        // 3rd chunk (800-1200) contains start at 1000 (offset 200 of chunk). Subarray offset 200 to 400 (200 bytes).
        // 4th chunk (1200-1600) delivered fully (400 bytes).
        // Total delivered: 600 bytes.
        const chunks = [];
        for (let i = 0; i < 10; i++) {
            const arr = new Uint8Array(400);
            arr.fill(i); // Fill with chunk index so we can verify correct bytes are delivered.
            chunks.push(arr);
        }
        const info = await fromByteRange("https://example.com/img.jxl", 1000, 1600, session, {
            fetchImpl: fakeFetch(new Response(streamFromChunks(chunks), {
                status: 200,
                headers: { "Content-Length": "4000" }
            }))
        });
        assert.equal(info.honored, false);
        assert.equal(totalDelivered(session), 600);
        assert.equal(session.closed, true);
        assert.equal(session.pushes.length, 2, "should push exactly 2 chunks");
        // First push should be the end of the 3rd chunk (value 2, which is index 2).
        assert.equal(session.pushes[0].byteLength, 200);
        assert.equal(session.pushes[0][0], 2);
        // Second push should be the 4th chunk (value 3).
        assert.equal(session.pushes[1].byteLength, 400);
        assert.equal(session.pushes[1][0], 3);
    });
    it("200 fallback where skip and trim hit the same chunk", async () => {
        const session = makeSession();
        const body = new Uint8Array(5000);
        for (let i = 0; i < body.length; i++)
            body[i] = i % 256;
        // Window [100, 300) -> 200 bytes. Single chunk of 5000 bytes.
        await fromByteRange("https://example.com/img.jxl", 100, 300, session, {
            fetchImpl: fakeFetch(new Response(streamFromChunks([body]), {
                status: 200,
                headers: { "Content-Length": "5000" }
            }))
        });
        assert.equal(totalDelivered(session), 200);
        assert.equal(session.closed, true);
        assert.equal(session.pushes[0][0], 100);
        assert.equal(session.pushes[0][199], 299 % 256);
    });
    it("206 fullSize does not leak part-length from Content-Length", async () => {
        const session = makeSession();
        const body = new Uint8Array(1000).fill(0x11);
        const info = await fromByteRange("https://example.com/img.jxl", 1000, 2000, session, {
            fetchImpl: fakeFetch(new Response(streamFromChunks([body]), {
                status: 206,
                headers: { "Content-Range": "bytes 1000-1999/*", "Content-Length": "1000" }
            }))
        });
        assert.equal(info.fullSize, undefined);
    });
    it("Zero-length chunk in body stream is ignored", async () => {
        const session = makeSession();
        const chunks = [
            new Uint8Array(400).fill(0x05),
            new Uint8Array(0), // empty chunk
            new Uint8Array(400).fill(0x06)
        ];
        await fromByteRange("https://example.com/img.jxl", 0, 800, session, {
            fetchImpl: fakeFetch(new Response(streamFromChunks(chunks), {
                status: 206,
                headers: { "Content-Range": "bytes 0-799/800" }
            }))
        });
        assert.equal(totalDelivered(session), 800);
        assert.equal(session.pushes.length, 2, "zero-length chunk should be ignored");
    });
    it("signal is forwarded to fetchImpl", async () => {
        const session = makeSession();
        const controller = new AbortController();
        let seenSignal = null;
        const fetchSpy = (async (_url, init) => {
            seenSignal = init?.signal ?? null;
            return new Response(streamFromChunks([new Uint8Array(100)]), {
                status: 206,
                headers: { "Content-Range": "bytes 0-99/100" }
            });
        });
        await fromByteRange("https://example.com/img.jxl", 0, 100, session, {
            fetchImpl: fetchSpy,
            signal: controller.signal
        });
        assert.equal(seenSignal, controller.signal);
    });
    it("onRangeNegotiated fires on mid-body network error with partial delivered", async () => {
        const session = makeSession();
        let pulled = false;
        const body = new ReadableStream({
            pull(c) {
                if (!pulled) {
                    pulled = true;
                    c.enqueue(new Uint8Array(400).fill(0x11));
                }
                else {
                    c.error(new Error("mid-body reset"));
                }
            }
        });
        let info;
        await assert.rejects(fromByteRange("https://example.com/img.jxl", 0, 1000, session, {
            fetchImpl: fakeFetch(new Response(body, {
                status: 206,
                headers: { "Content-Range": "bytes 0-999/5000" }
            })),
            onRangeNegotiated: (n) => { info = n; }
        }), (err) => err instanceof Error && /mid-body reset/.test(err.message));
        assert.notEqual(info, undefined);
        assert.equal(info?.delivered, 400);
    });
});
describe("Resume API", () => {
    it("createByteRangeResumeState absolute start offset calculation", () => {
        const prev = {
            requested: 1000,
            honored: true,
            delivered: 400,
            fullSize: 5000,
            etag: "strong-etag"
        };
        const state = createByteRangeResumeState("https://example.com/img.jxl", prev, 1000);
        assert.equal(state.url, "https://example.com/img.jxl");
        assert.equal(state.start, 1400);
        assert.equal(state.endExclusive, 2000);
        assert.equal(state.etag, "strong-etag");
        assert.equal(state.fullSize, 5000);
    });
    it("resumeFromByteRange strong ETag and weak ETag handling", async () => {
        const session = makeSession();
        // Strong ETag -> sets If-Range
        let seenIfRange = null;
        const fetchSpy1 = (async (_url, init) => {
            seenIfRange = new Headers(init?.headers).get("If-Range");
            return new Response(streamFromChunks([new Uint8Array(100)]), {
                status: 206,
                headers: { "Content-Range": "bytes 100-199/1000" }
            });
        });
        await resumeFromByteRange({
            url: "https://example.com/img.jxl",
            start: 100,
            endExclusive: 200,
            etag: '"abcdef"',
            fullSize: 1000
        }, session, { fetchImpl: fetchSpy1 });
        assert.equal(seenIfRange, '"abcdef"');
        // Weak ETag -> no If-Range
        let seenIfRange2 = null;
        const fetchSpy2 = (async (_url, init) => {
            seenIfRange2 = new Headers(init?.headers).get("If-Range");
            return new Response(streamFromChunks([new Uint8Array(100)]), {
                status: 206,
                headers: { "Content-Range": "bytes 100-199/1000" }
            });
        });
        await resumeFromByteRange({
            url: "https://example.com/img.jxl",
            start: 100,
            endExclusive: 200,
            etag: 'W/"weak"',
            fullSize: 1000
        }, session, { fetchImpl: fetchSpy2 });
        assert.equal(seenIfRange2, null);
    });
    it("Resume + 200 response + different ETag rejects and cancels", async () => {
        const session = makeSession();
        // Server returns 200 with a different ETag (resource changed)
        const fetchSpy = fakeFetch(new Response(streamFromChunks([new Uint8Array(5000)]), {
            status: 200,
            headers: { "ETag": '"new-etag"', "Content-Length": "5000" }
        }));
        await assert.rejects(resumeFromByteRange({
            url: "https://example.com/img.jxl",
            start: 1000,
            endExclusive: 2000,
            etag: '"old-etag"',
            fullSize: 5000
        }, session, { fetchImpl: fetchSpy }), (err) => err instanceof Error && /resource changed/.test(err.message));
        assert.notEqual(session.cancelled, null);
        assert.equal(session.closed, false);
    });
    it("Completed state start === endExclusive returns 0 delivered, closes cleanly", async () => {
        const session = makeSession();
        let fetchCalled = false;
        const fetchSpy = (async () => {
            fetchCalled = true;
            return new Response(null);
        });
        const info = await resumeFromByteRange({
            url: "https://example.com/img.jxl",
            start: 2000,
            endExclusive: 2000,
            etag: '"etag"',
            fullSize: 2000
        }, session, { fetchImpl: fetchSpy });
        assert.equal(fetchCalled, false);
        assert.equal(info.requested, 0);
        assert.equal(info.delivered, 0);
        assert.equal(session.closed, true);
    });
});
describe("fromReadableStream maxBytes", () => {
    it("maxBytes mid-chunk trim", async () => {
        const session = makeSession();
        const chunks = [
            new Uint8Array(400).fill(0x01),
            new Uint8Array(400).fill(0x02),
            new Uint8Array(400).fill(0x03)
        ];
        const bytes = await fromReadableStream(streamFromChunks(chunks), session, { maxBytes: 1000 });
        assert.equal(bytes, 1000);
        assert.equal(totalDelivered(session), 1000);
        assert.equal(session.closed, true);
        assert.equal(session.pushes.length, 3);
        assert.equal(session.pushes[2].byteLength, 200);
    });
    it("maxBytes exact chunk boundary", async () => {
        const session = makeSession();
        const chunks = [
            new Uint8Array(400).fill(0x01),
            new Uint8Array(400).fill(0x02),
            new Uint8Array(400).fill(0x03) // should never be pulled/pushed
        ];
        let pulledThird = false;
        const customStream = new ReadableStream({
            pull(c) {
                if (c.desiredSize != null && c.desiredSize <= 0)
                    return;
                const i = chunks.length - (chunks.length - session.pushes.length);
                if (i >= chunks.length) {
                    c.close();
                    return;
                }
                if (i === 2)
                    pulledThird = true;
                c.enqueue(chunks[i]);
            }
        });
        const bytes = await fromReadableStream(customStream, session, { maxBytes: 800 });
        assert.equal(bytes, 800);
        assert.equal(totalDelivered(session), 800);
        assert.equal(session.closed, true);
        assert.equal(pulledThird, false);
    });
    it("maxBytes >= total stream", async () => {
        const session = makeSession();
        const chunks = [
            new Uint8Array(400).fill(0x01),
            new Uint8Array(400).fill(0x02)
        ];
        const bytes = await fromReadableStream(streamFromChunks(chunks), session, { maxBytes: 1000 });
        assert.equal(bytes, 800);
        assert.equal(totalDelivered(session), 800);
        assert.equal(session.closed, true);
    });
    it("Invalid maxBytes throws RangeError", async () => {
        const session = makeSession();
        const stream = streamFromChunks([]);
        await assert.rejects(fromReadableStream(stream, session, { maxBytes: 0 }), (err) => err instanceof RangeError);
        await assert.rejects(fromReadableStream(stream, session, { maxBytes: -1 }), (err) => err instanceof RangeError);
        await assert.rejects(fromReadableStream(stream, session, { maxBytes: Number.NaN }), (err) => err instanceof RangeError);
        await assert.rejects(fromReadableStream(stream, session, { maxBytes: Number.POSITIVE_INFINITY }), (err) => err instanceof RangeError);
    });
});
describe("fromBlobRange", () => {
    it("delivers correct bytes of a Blob window, clamps, throws on invalid range", async () => {
        const session = makeSession();
        const buf = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
        const blob = new Blob([buf]);
        const bytes = await fromBlobRange(blob, 2, 5, session);
        assert.equal(bytes, 3);
        assert.equal(totalDelivered(session), 3);
        assert.deepEqual(session.pushes[0], new Uint8Array([30, 40, 50]));
        // Clamps past blob.size
        const session2 = makeSession();
        const bytes2 = await fromBlobRange(blob, 5, 20, session2);
        assert.equal(bytes2, 3);
        assert.deepEqual(session2.pushes[0], new Uint8Array([60, 70, 80]));
        // Invalid range throws RangeError
        const session3 = makeSession();
        await assert.rejects(fromBlobRange(blob, -1, 5, session3), (err) => err instanceof RangeError);
        await assert.rejects(fromBlobRange(blob, 4, 2, session3), (err) => err instanceof RangeError);
    });
});
describe("fromReadableStream abort contract", () => {
    it("abort at 50% resolves (not rejects) with partial byte count", async () => {
        const ac = new AbortController();
        // 1000-byte file split across 10 chunks of 100 bytes each.
        // We abort after 5 chunks (500 bytes) have been pushed.
        const CHUNK_SIZE = 100;
        const TOTAL_CHUNKS = 10;
        const ABORT_AFTER = 5;
        let chunkIndex = 0;
        let sessionRef;
        const session = makeSession();
        sessionRef = session;
        // Wrap push() so we can abort mid-stream after ABORT_AFTER chunks.
        const originalPush = session.push.bind(session);
        session.push = async (chunk) => {
            await originalPush(chunk);
            if (sessionRef.pushes.length === ABORT_AFTER) {
                ac.abort();
            }
        };
        const stream = new ReadableStream({
            pull(controller) {
                if (chunkIndex >= TOTAL_CHUNKS) {
                    controller.close();
                    return;
                }
                controller.enqueue(new Uint8Array(CHUNK_SIZE).fill(chunkIndex++));
            },
        });
        // Must resolve, not reject.
        const delivered = await fromReadableStream(stream, session, { signal: ac.signal });
        // Resolved with partial byte count.
        assert.equal(delivered, ABORT_AFTER * CHUNK_SIZE, "resolved value must equal bytes delivered before abort");
        assert.equal(totalDelivered(session), ABORT_AFTER * CHUNK_SIZE, "session received correct partial bytes");
        // Signal is aborted — caller can distinguish abort from error without try/catch.
        assert.equal(ac.signal.aborted, true);
        // Session was cancelled, not closed.
        assert.equal(session.closed, false, "session must not be closed on abort");
        assert.notEqual(session.cancelled, null, "session must be cancelled on abort");
    });
});
