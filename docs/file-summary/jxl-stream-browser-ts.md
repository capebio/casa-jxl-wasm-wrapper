# Working Notes: packages/jxl-stream/src/browser.ts
> I/O stream adapters — ReadableStream → DecodeSession, EncodeSession → ReadableStream
> Feature covered: #2 (Advanced Scheduling & Flow Control)

---

## Index of Exports

| Symbol | Kind | Purpose |
|--------|------|---------|
| `fromReadableStream(stream, session, signal?)` | fn | Pipes ReadableStream chunks into a DecodeSession with backpressure and one-ahead prefetch |
| `fromResponse(response, session, signal?)` | fn | Thin wrapper: extracts `response.body` and calls `fromReadableStream` |
| `fromBlob(blob, session, signal?)` | fn | Wraps `blob.stream()` and calls `fromReadableStream` |
| `toReadableStream(session, signal?)` | fn | Wraps EncodeSession.chunks() as a ReadableStream |

---

## Feature #2 Coverage

| Feature | Status | Location |
|---------|--------|---------|
| Pipelined I/O Prefetch | ✅ Full | `fromReadableStream`: `let pending = reader.read()` starts next read BEFORE awaiting push — overlaps I/O with push dispatch |
| Integrated Backpressure | ✅ Full | `await session.push(value)` — respects DecodeSession's internal backpressure gate |
| Stream Abort Hardening | ✅ Full | `onAbort` handler cancels both session and reader; `{ once: true }` prevents double-fire; signal removed in `finally` |
| Pre-Aborted Signal Handling | ✅ Full | `if (signal?.aborted)` checked before entering loop AND within loop at each iteration |
| `fromResponse()` Helper | ✅ Full | One-liner that routes Response.body through the same backpressure-aware path |
| `toReadableStream` Abort | ✅ Full | abort → `session.cancel()` + `controller.error()` |
| `toReadableStream` iterator.return() | ✅ Full | Called on stream cancel to allow EncodeSession cleanup |

---

## Bottlenecks & Issues

### 🟡 B1 — One-ahead prefetch only (not multi-ahead)
`fromReadableStream` prefetches exactly one chunk ahead (`pending = reader.read()` after receiving chunk N, before `await session.push(value)`). This eliminates the "wait for push to complete then start the next read" serial dependency but only pipelines one level deep. For high-latency streams (satellite link, slow CDN), multi-chunk prefetch could improve throughput.
**Impact:** Minimal for typical connections. ReadableStream backpressure would throttle anyway.

### 🟡 B2 — `fromReadableStream` uses `throw new DOMException('Aborted', 'AbortError')` for abort path
On abort inside the while loop, the caught exception calls `cancelBoth(reason)` then `throw e`. This means session AND reader are cancelled, and the exception propagates to the caller. This is correct but callers must handle the re-thrown DOMException.

### 🟢 B3 — `cancelBoth` uses `Promise.allSettled` semantics
`cancelBoth` calls `Promise.allSettled([session.cancel(), reader.cancel()])` — one failure doesn't prevent the other from running. Robust against partial cancellations. ✅

---

## Key Invariants

- `reader.releaseLock()` always called in `finally` — no reader leak on error or abort.
- `signal.removeEventListener('abort', onAbort)` always called in `finally` — no handler leak.
- Backpressure chain: `session.push()` awaits `scheduler.waitForDrain()` inside; stream adapter just awaits `push()` — no double-backpressure gating.
- `fromResponse` does not set `Accept-Ranges` or handle range requests — full response body is piped.
