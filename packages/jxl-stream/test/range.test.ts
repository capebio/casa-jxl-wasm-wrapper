// jxl-stream/test/range.test.ts
// Tests for fromRangePrefix: byte-range HTTP fetch piped into a DecodeSession.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fromRangePrefix, type RangeNegotiation } from "../src/browser.js";

interface RecordedSession {
  pushes: Uint8Array[];
  closed: boolean;
  cancelled: string | null;
  push(chunk: ArrayBuffer | Uint8Array): Promise<void>;
  close(): Promise<void>;
  cancel(reason?: string): Promise<void>;
}

function makeSession(): RecordedSession {
  const s: RecordedSession = {
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

function totalDelivered(s: RecordedSession): number {
  return s.pushes.reduce((n, c) => n + c.byteLength, 0);
}

/** Build a ReadableStream that emits the supplied chunks one by one. */
function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) { controller.close(); return; }
      controller.enqueue(chunks[i++]);
    },
  });
}

/** Build a fake `fetch` that returns the given Response for any URL. */
function fakeFetch(resp: Response): typeof fetch {
  return (async () => resp) as typeof fetch;
}

describe("fromRangePrefix", () => {
  it("happy path: 206 Partial Content delivers exactly requested bytes", async () => {
    const session = makeSession();
    const body = new Uint8Array(1000).fill(0xAB);

    let info: RangeNegotiation | undefined;
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

    let info: RangeNegotiation | undefined;
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

    let info: RangeNegotiation | undefined;
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

    await assert.rejects(
      fromRangePrefix("https://example.com/img.jxl", 1000, session, {
        fetchImpl: fakeFetch(new Response(null, { status: 416, statusText: "Range Not Satisfiable" })),
      }),
      (err: unknown) => err instanceof RangeError && /416/.test((err as Error).message),
    );

    assert.equal(session.closed, false);
  });

  it("503 server error: throws with status, session not closed", async () => {
    const session = makeSession();

    await assert.rejects(
      fromRangePrefix("https://example.com/img.jxl", 1000, session, {
        fetchImpl: fakeFetch(new Response(null, { status: 503, statusText: "Service Unavailable" })),
      }),
      (err: unknown) => err instanceof Error && /503/.test((err as Error).message),
    );

    assert.equal(session.closed, false);
  });

  it("pre-aborted signal: cancels session, no fetch", async () => {
    const session = makeSession();
    const controller = new AbortController();
    controller.abort();

    let fetchCalled = false;
    const fetchSpy: typeof fetch = (async () => {
      fetchCalled = true;
      return new Response(null);
    }) as typeof fetch;

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
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        c.enqueue(new Uint8Array(400).fill(0x77));
        // Trigger abort after first chunk is delivered.
        queueMicrotask(() => controller.abort());
        await new Promise<void>((_, reject) => {
          const onAbort = () => {
            controller.signal.removeEventListener("abort", onAbort);
            reject(new Error("AbortError"));
          };
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    });

    await assert.rejects(
      fromRangePrefix("https://example.com/img.jxl", 1000, session, {
        fetchImpl: fakeFetch(new Response(body, {
          status: 206,
          headers: { "Content-Range": "bytes 0-999/5000" },
        })),
        signal: controller.signal,
      }),
      (err: unknown) => err instanceof Error && /Abort/i.test((err as Error).message),
    );

    assert.equal(session.cancelled !== null, true);
    assert.equal(session.closed, false);
  });

  it("byteCount <= 0 throws RangeError", async () => {
    const session = makeSession();
    await assert.rejects(
      fromRangePrefix("https://example.com/img.jxl", 0, session, { fetchImpl: fakeFetch(new Response(null)) }),
      (err: unknown) => err instanceof RangeError,
    );
    await assert.rejects(
      fromRangePrefix("https://example.com/img.jxl", -1, session, { fetchImpl: fakeFetch(new Response(null)) }),
      (err: unknown) => err instanceof RangeError,
    );
  });

  it("byteCount NaN/Infinity throws RangeError", async () => {
    const session = makeSession();
    await assert.rejects(
      fromRangePrefix("https://example.com/img.jxl", Number.NaN, session, { fetchImpl: fakeFetch(new Response(null)) }),
      (err: unknown) => err instanceof RangeError,
    );
    await assert.rejects(
      fromRangePrefix("https://example.com/img.jxl", Number.POSITIVE_INFINITY, session, { fetchImpl: fakeFetch(new Response(null)) }),
      (err: unknown) => err instanceof RangeError,
    );
  });

  it("merges caller-supplied headers with Range", async () => {
    const session = makeSession();
    let seenAuth: string | null = null;
    let seenRange: string | null = null;

    const spy: typeof fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seenAuth = h.get("Authorization");
      seenRange = h.get("Range");
      return new Response(streamFromChunks([new Uint8Array(100)]), {
        status: 206,
        headers: { "Content-Range": "bytes 0-99/1000" },
      });
    }) as typeof fetch;

    await fromRangePrefix("https://example.com/img.jxl", 100, session, {
      fetchImpl: spy,
      headers: { Authorization: "Bearer secret" },
    });

    assert.equal(seenAuth, "Bearer secret");
    assert.equal(seenRange, "bytes=0-99");
  });

  it("Content-Range with `*` total: fullSize undefined", async () => {
    const session = makeSession();
    let info: RangeNegotiation | undefined;

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

    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error("connection reset"));
      },
    });

    await assert.rejects(
      fromRangePrefix("https://example.com/img.jxl", 1000, session, {
        fetchImpl: fakeFetch(new Response(body, {
          status: 206,
          headers: { "Content-Range": "bytes 0-999/5000" },
        })),
      }),
      (err: unknown) => err instanceof Error && /connection reset/.test((err as Error).message),
    );

    assert.equal(session.cancelled !== null, true);
    assert.equal(session.closed, false);
  });
});
