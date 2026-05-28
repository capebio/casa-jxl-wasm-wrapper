// packages/jxl-progressive/test/stream.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchTier, fetchFull, streamTierFrames, } from "../src/progressive-stream.js";
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
        async push(chunk) {
            session.pushes.push(chunk instanceof ArrayBuffer ? chunk.byteLength : chunk.byteLength);
        },
        async close() { session.closed = true; },
        async cancel() { session.cancelled = true; },
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
        }), (e) => e instanceof Error && /503/.test(e.message));
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
//# sourceMappingURL=stream.test.js.map