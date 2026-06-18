// packages/jxl-progressive/test/stream.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchTier, fetchFull, fetchTierWithPrefix, streamTierFrames, HttpError, RangeNotSupportedError, } from "../src/progressive-stream.js";
const fakeInfo = {
    width: 100, height: 100, bitsPerSample: 8, hasAlpha: false,
    hasAnimation: false, jpegReconstructionAvailable: false,
};
function makeFakeSession(frames = []) {
    const session = {
        id: "test",
        pushes: [],
        closed: false,
        cancelled: false,
        cancelReason: undefined,
        async push(chunk) {
            session.pushes.push(chunk instanceof ArrayBuffer ? chunk.byteLength : chunk.byteLength);
        },
        async close() { session.closed = true; },
        async cancel(reason) { session.cancelled = true; session.cancelReason = reason; },
        async done() { return fakeInfo; },
        async *frames() { yield* frames; },
    };
    return session;
}
function makeBody(byteLength, status = 206) {
    const data = new Uint8Array(byteLength).fill(0xab);
    return new Response(new ReadableStream({
        pull(c) { c.enqueue(data); c.close(); },
    }), {
        status,
        headers: status === 206
            ? { "Content-Range": `bytes 0-${byteLength - 1}/${byteLength * 10}` }
            : { "Content-Length": String(byteLength) },
    });
}
const dcTier = {
    name: "dc",
    byteStart: 0,
    byteEnd: 1000,
    progressionIndex: 1,
    intendedUse: "thumbnail",
};
describe("fetchTier", () => {
    it("fetches exactly byteEnd bytes via range request", async () => {
        const session = makeFakeSession();
        await fetchTier("https://example.com/img.jxl", dcTier, session, {
            fetchImpl: async () => makeBody(1000),
        });
        const total = session.pushes.reduce((s, n) => s + n, 0);
        assert.equal(total, 1000);
        assert.equal(session.closed, true);
    });
    it("does not overshoot when server returns more bytes (200 OK fallback)", async () => {
        const session = makeFakeSession();
        await fetchTier("https://example.com/img.jxl", dcTier, session, {
            fetchImpl: async () => makeBody(5000, 200), // server ignores range, returns more
        });
        const total = session.pushes.reduce((s, n) => s + n, 0);
        assert.equal(total, 1000, "must cap at tier.byteEnd");
        assert.equal(session.closed, true);
    });
    it("propagates AbortSignal: session cancelled when signal fires", async () => {
        const ctrl = new AbortController();
        const session = makeFakeSession();
        const slowFetch = () => new Promise((resolve) => {
            setTimeout(() => resolve(makeBody(1000)), 500);
        });
        const p = fetchTier("https://example.com/img.jxl", dcTier, session, {
            fetchImpl: slowFetch,
            signal: ctrl.signal,
        });
        ctrl.abort();
        await assert.rejects(p);
    });
});
describe("fetchFull", () => {
    it("fetches and pushes entire response body", async () => {
        const session = makeFakeSession();
        await fetchFull("https://example.com/img.jxl", session, {
            fetchImpl: async () => makeBody(5000, 200),
        });
        const total = session.pushes.reduce((s, n) => s + n, 0);
        assert.equal(total, 5000);
        assert.equal(session.closed, true);
    });
    it("throws on HTTP error", async () => {
        const session = makeFakeSession();
        await assert.rejects(fetchFull("https://example.com/img.jxl", session, {
            fetchImpl: async () => new Response(null, { status: 503, statusText: "Service Unavailable" }),
        }), (e) => e instanceof HttpError && e.status === 503 && /503/.test(e.message));
    });
});
describe("streamTierFrames", () => {
    it("yields all frames from session.frames()", async () => {
        const fakeFrames = [
            { stage: "dc", info: fakeInfo, pixels: new ArrayBuffer(4), format: "rgba8", pixelStride: 4 },
            { stage: "pass", info: fakeInfo, pixels: new ArrayBuffer(4), format: "rgba8", pixelStride: 4 },
        ];
        const session = makeFakeSession(fakeFrames);
        const collected = [];
        for await (const f of streamTierFrames(session)) {
            collected.push(f);
        }
        assert.equal(collected.length, 2);
        assert.equal(collected[0]?.stage, "dc");
        assert.equal(collected[1]?.stage, "pass");
    });
    it("yields nothing from an empty session", async () => {
        const session = makeFakeSession([]);
        const collected = [];
        for await (const f of streamTierFrames(session)) {
            collected.push(f);
        }
        assert.equal(collected.length, 0);
    });
});
function makeDeltaBody(start, deltaLen, total) {
    const data = new Uint8Array(deltaLen).fill(0xcd);
    return new Response(new ReadableStream({
        pull(c) { c.enqueue(data); c.close(); },
    }), {
        status: 206,
        headers: { "Content-Range": `bytes ${start}-${start + deltaLen - 1}/${total}` },
    });
}
describe("fetchTierWithPrefix", () => {
    const higherTier = {
        ...dcTier,
        byteEnd: 5000,
    };
    it("closes immediately when prefix.length >= tier.byteEnd (no fetch)", async () => {
        const session = makeFakeSession();
        const prefix = new Uint8Array(6000); // covers
        await fetchTierWithPrefix("https://example.com/img.jxl", higherTier, prefix, session);
        assert.equal(session.closed, true);
        assert.equal(session.cancelled, false);
        assert.equal(session.pushes.length, 0);
    });
    it("fetches delta only, validates matching Content-Range start, pushes delta, closes", async () => {
        const session = makeFakeSession();
        const prefix = new Uint8Array(1000);
        const delta = 4000;
        await fetchTierWithPrefix("https://example.com/img.jxl", higherTier, prefix, session, {
            fetchImpl: async (_u, init) => {
                // verify Range header was sent for the delta
                const h = new Headers(init?.headers);
                assert.equal(h.get("Range"), "bytes=1000-4999");
                return makeDeltaBody(1000, delta, 10000);
            },
        });
        const totalPushed = session.pushes.reduce((s, n) => s + n, 0);
        assert.equal(totalPushed, delta);
        assert.equal(session.closed, true);
        assert.equal(session.cancelled, false);
    });
    it("cancels and throws RangeNotSupportedError on Content-Range start mismatch", async () => {
        const session = makeFakeSession();
        const prefix = new Uint8Array(1000);
        await assert.rejects(fetchTierWithPrefix("https://example.com/img.jxl", higherTier, prefix, session, {
            fetchImpl: async () => makeDeltaBody(0, 4000, 10000), // lies, claims start 0
        }), (e) => e instanceof RangeNotSupportedError);
        assert.equal(session.cancelled, true);
        assert.match(session.cancelReason || "", /Content-Range mismatch/);
    });
    it("cancels and throws RangeNotSupportedError when server returns non-206 (e.g. 200)", async () => {
        const session = makeFakeSession();
        const prefix = new Uint8Array(1000);
        await assert.rejects(fetchTierWithPrefix("https://example.com/img.jxl", higherTier, prefix, session, {
            fetchImpl: async () => makeBody(5000, 200), // ignores Range
        }), (e) => e instanceof RangeNotSupportedError);
        assert.equal(session.cancelled, true);
        assert.match(session.cancelReason || "", /not supported/);
    });
    it("propagates AbortSignal before and during (prefix cover and fetch paths)", async () => {
        const ctrl = new AbortController();
        const session = makeFakeSession();
        // cover path abort
        const prefixCover = new Uint8Array(6000);
        ctrl.abort();
        await assert.rejects(fetchTierWithPrefix("https://example.com/img.jxl", higherTier, prefixCover, session, { signal: ctrl.signal }));
        // reset for fetch path
        const ctrl2 = new AbortController();
        const slowFetch = () => new Promise((resolve) => setTimeout(() => resolve(makeDeltaBody(1000, 100, 10000)), 50));
        const p = fetchTierWithPrefix("https://example.com/img.jxl", higherTier, new Uint8Array(1000), session, {
            fetchImpl: slowFetch,
            signal: ctrl2.signal,
        });
        ctrl2.abort();
        await assert.rejects(p);
    });
});
//# sourceMappingURL=stream.test.js.map