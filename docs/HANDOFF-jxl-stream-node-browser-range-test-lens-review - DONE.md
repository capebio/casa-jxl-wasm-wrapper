# HANDOFF — jxl-stream 22-Lens Review: `src/node.ts`, `src/browser.ts`, `test/range.test.ts`

Scope: `packages/jxl-stream/src/node.ts`, `packages/jxl-stream/src/browser.ts`, `packages/jxl-stream/test/range.test.ts`.
Five agents (A–E), one file per agent (A/B → browser.ts, C/D → node.ts, E → range.test.ts). **Execution order: A → B → C → D → E** (E's tests lock in A/C behavior; C and D both touch node.ts, C owns `fromNodeReadable`/`toNodeReadable`, D owns `BufferedReader` only — no overlap).

Layer-invariant compliance checked against CLAUDE.md: no format/magic-byte validation added (HTTP status/header checks are transport-level, not codestream validation); no backpressure, batching, or dedupe added to this layer; no session-protocol knowledge leaks in. Range coalescing and origin-capability memos are listed as deferred, not implemented, pending the "tunables need benchmarks" rule.

---

## Consolidated findings (amalgamated across all 22 lenses)

### P0 — correctness bugs

| ID | File | Finding |
|----|------|---------|
| **P0-1** | browser.ts | `createByteRangeResumeState` sets `start: previous.delivered`, ignoring `originalStart`. For any tile/window fetch with `originalStart > 0`, resume re-requests the wrong absolute byte window → silently corrupted stitched stream. Fix: `start: originalStart + previous.delivered`. |
| **P0-2** | browser.ts | `If-Range` semantics misunderstood. RFC 9110: on ETag mismatch the server ignores Range and returns **200 with the full (new) resource** — not 412 as the comment claims. The 200-fallback skip logic then skips `start` bytes of the *new version* and delivers them into a session whose caller stitches them onto *old-version* bytes → mixed-version corruption. Also: clients MUST NOT send weak ETags (`W/"..."`) in `If-Range`. Fix: strip weak ETags; add `expectEtag` option that fails fast (cancel + throw) on 200 + ETag mismatch. |
| **P0-3** | node.ts | `toNodeReadable` returns `Readable.from(session.chunks())` — objectMode `true` by default, chunks are `ArrayBuffer`. Piping to any byte sink (`fs.createWriteStream`, sockets) throws `ERR_INVALID_ARG_TYPE`. Also never calls `session.cancel()` on consumer destroy/abort (browser `toReadableStream` does). Fix: wrap in generator yielding `Buffer.from(chunk)` (zero-copy view), `objectMode: false`, cancel in generator `finally`. |
| **P0-4** | browser.ts | `fullSize` fallback to `Content-Length` is wrong on 206: there, Content-Length is the **part** size, not the full resource. Only fall back on 200. (Current happy-path test masks this because Content-Range total wins.) |

### P1 — hardening / spec compliance

| ID | File | Finding |
|----|------|---------|
| P1-1 | browser.ts | Prefetched `reader.read()` promise can reject unobserved: if `session.push()` throws while a prefetch is in flight and the stream errors concurrently, the pending read rejects with no awaiter → unhandled promise rejection. Fix: `read()` wrapper that attaches a no-op `.catch` (marks handled; later `await` still surfaces the rejection). Applies to both pump loops. |
| P1-2 | browser.ts | 206 responses are trusted to start at `start`. A misbehaving proxy/CDN returning a shifted `Content-Range` start silently corrupts. Parse the full `Content-Range` (start–end/total) and throw on start mismatch. |
| P1-3 | browser.ts | `resumeFromByteRange` on a *completed* transfer (`start === endExclusive` after P0-1 fix) throws RangeError. Should be a clean no-op: `close()` session, return `{requested: 0, honored: true, delivered: 0}`. |
| P1-4 | browser.ts | Stale doc: `onRangeNegotiated` comment says "fired once after fetch headers arrive"; implementation fires from `finally` after the whole transfer (and never fires for fetch-level errors like 416/503). Fix comment; optionally add `onHeaders` callback for early 200-fallback detection so callers can abort large wasteful skips via their signal. |
| P1-5 | node.ts | `fromNodeReadable` pushes string chunks unchecked if the caller did `readable.setEncoding()` → silent downstream corruption. Throw `TypeError` on string chunk. |
| P1-6 | node.ts | Pre-aborted-signal path fires `session.cancel()` un-awaited (floating promise) via `onAbort()`. Await it in the pre-abort branch. |
| P1-7 | range.test.ts | 416 test doesn't assert `session.cancelled !== null` (the code does cancel before throwing — untested). |

### P2 — performance

| ID | File | Finding |
|----|------|---------|
| P2-1 | node.ts | `BufferedReader` is O(n²): every `append` copies the whole accumulated buffer; every `take` copies head **and** tail. For N chunks total cost ~O(N²·c). Rewrite as chunk-deque with head offset: O(1) append, O(taken) take. |
| P2-2 | node.ts | `fromNodeReadable` has no I/O prefetch pipelining (browser `fromReadableStream` prefetches read N+1 during push N). Manual async-iterator pipelining gives the same overlap of disk/network I/O with WASM push dispatch. |
| P2-3 | browser.ts | Zero-length chunks are pushed across the session boundary (wasted worker round-trip, possible edge cases). Skip them in both pump loops. |
| P2-4 | browser.ts | `!resp.ok && resp.status !== 206` — 206 is inside `ok` (200–299); the second clause is dead. Trivial cleanup. |

### P3 — features (lens 11–16 derived)

| ID | File | Finding |
|----|------|---------|
| P3-1 | browser.ts | **`fromBlobRange`** — `blob.slice(start, end).stream()` is a zero-copy reference slice. Gives OPFS-cached pyramids (jxl-cache) the same range-window API as HTTP, for free. Critical for the field/offline botanical workflow: cached sidecar pyramids get tile-window reads with no network and no full-file decode. |
| P3-2 | browser.ts | Fetch `priority` pass-through (`RequestPriority`) in `RangePrefixOptions` — lets the scheduler mark speculative pyramid-level prefetches `'low'` and on-screen tiles `'high'`. One line + a cast. |
| P3-3 | browser.ts | Timing telemetry on `RangeNegotiation`: `ttfbMs` (fetch → headers) and `transferMs` (headers → finally). Pure measurement, no heuristics — feeds future adaptive ladder selection (AR/realtime level choice by observed bandwidth) without violating the "no tunables without benchmarks" rule. |
| P3-4 | node.ts | `fromNodeReadable` parity with browser: accept `AbortSignal | PipeOptions`, support `maxBytes` (convergedByteEnd cutoff currently browser-only), return delivered byte count. |

### Deferred (list-only — do NOT implement; record here for future evaluation)

- **Pump-loop fusion**: `fromReadableStream` and `fromByteRange` share ~80% of their pump loop (prefetch/trim/cancel). A shared `pumpReader(reader, session, {skip, limit, signal})` would halve the hardening surface. Deferred: the two loops differ in skip logic and info plumbing; fuse only with full test coverage in place (after Agent E).
- **Per-origin Range-capability memo**: cache `origin → honored` so repeated tile fetches against a non-Range server stop paying the skip penalty (switch to full-fetch + local slicing). Needs eviction/staleness policy → benchmark-gated.
- **Multi-range coalescing** (`fromByteRanges(url, windows[])`): coalesce near-adjacent tile windows into one request, skipping gap bytes — telescope-mosaic pattern for pyramid tile bursts. I/O-layer concern (not scheduler batching), but needs gap-threshold tuning → benchmark-gated.
- **`fromResponse` ok-check**: `fromResponse` pushes 404 HTML bodies into the decoder (libjxl errors out per layer invariants, so correct-but-slow). Adding `if (!response.ok) throw` is a behavior change for callers passing pre-validated responses. Decide with API owners.
- BYOB readers for `fromReadableStream`: rejected here pre-emptively — buffer reuse conflicts with sessions that transfer/copy into WASM heap (same class as the rejected pixel-buffer-pool items R1-2/R2-2).

### Lens notes with no actionable items in these files

- Lens 15 (Butteraugli): encode-side concern; this layer already contributes via `maxBytes`/convergedByteEnd (fewer bytes decoded). Nothing further here.
- Lens 17 (non-Riemannian colour): stream layer is colour-agnostic by design; LUT work lives in `crates/raw-pipeline`. Correctly nothing here — keep it that way.
- Lens 12 (LLM/recognition): served by P3-1/P3-3 (fast partial fetches for embedding-sized previews); no separate item.

---

## Agent A — `packages/jxl-stream/src/browser.ts` (correctness)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

**File: `packages/jxl-stream/src/browser.ts` only.** Context: this module pipes ReadableStreams/fetch Responses/Blobs into `DecodeSession.push()` (which forwards to jxl-scheduler → worker → WASM). `fromByteRange` does HTTP Range with a 200-fallback that skips leading bytes; `resumeFromByteRange` + `createByteRangeResumeState` implement resumable fetches for unreliable field networks. Sessions' `cancel()` is idempotent; `session.push()` honors backpressure.

### A1 (P0-1): fix resume start offset

`createByteRangeResumeState` — `start` must be absolute:

```ts
return {
  url,
  start: originalStart + previous.delivered,   // was: previous.delivered
  endExclusive: originalStart + previous.requested,
  etag: previous.etag,
  fullSize: previous.fullSize,
};
```

Note `endExclusive` was already computed off `originalStart`; only `start` was wrong. Update the `ByteRangeResumeState.start` doc comment ("next byte to request" → "next absolute byte offset to request").

### A2 (P0-2): If-Range semantics — weak ETags + version-change detection

1. Add to `RangePrefixOptions`:

```ts
/**
 * If set and the server responds 200 (Range ignored) with a *different* ETag,
 * cancel the session and throw — the resource changed; previously delivered
 * bytes belong to an older version and must not be stitched. Set automatically
 * by resumeFromByteRange.
 */
expectEtag?: string;
```

2. In `fromByteRange`, after `etagFromResponse` is set and after `cancelBoth` is defined (before the abort-listener registration):

```ts
if (opts.expectEtag && !honored && etagFromResponse && etagFromResponse !== opts.expectEtag) {
  const err = new Error('[jxl-stream] resource changed during resume (ETag mismatch); restart from byte 0');
  await cancelBoth(err.message);
  throw err;
}
```

3. In `resumeFromByteRange`, only use strong ETags and set `expectEtag`:

```ts
const strongEtag = state.etag && !state.etag.startsWith('W/') ? state.etag : undefined;
if (strongEtag) {
  const merged = new Headers(opts.headers);
  merged.set('If-Range', strongEtag);
  resumeOpts.headers = merged;
  resumeOpts.expectEtag = strongEtag;
}
```

4. Fix the comment "(server will 412 if the resource changed)" → "(on ETag mismatch the server ignores Range and returns 200 with the full new resource; expectEtag detects this and fails fast)". RFC 9110 §13.1.5: clients MUST NOT generate If-Range with a weak validator.

### A3 (P1-2 + P0-4): full Content-Range parse, start validation, 206 fullSize fix

Replace `parseContentRangeTotal` with a full parser (keep `parseNonNegativeInt`):

```ts
interface ParsedContentRange { start?: number; end?: number; total?: number }

/** Parse `Content-Range: bytes start-end/total` (or `bytes */total`). */
function parseContentRange(header: string | null): ParsedContentRange {
  if (header === null) return {};
  const m = /^\s*bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+|\*)\s*$/i.exec(header);
  if (m === null) return {};
  return {
    start: m[1] !== undefined ? parseNonNegativeInt(m[1]) : undefined,
    end: m[2] !== undefined ? parseNonNegativeInt(m[2]) : undefined,
    total: m[3] !== '*' ? parseNonNegativeInt(m[3]) : undefined,
  };
}
```

In `fromByteRange`:

```ts
const cr = parseContentRange(resp.headers.get('Content-Range'));
// P0-4: on 206, Content-Length is the PART size, not the full resource — only fall back on 200.
fullSize = cr.total ?? (!honored ? parseNonNegativeInt(resp.headers.get('Content-Length')) : undefined);
```

And after `cancelBoth` is defined, before the pump:

```ts
// P1-2: a 206 whose Content-Range start differs from what we asked would silently corrupt.
if (honored && cr.start !== undefined && cr.start !== start) {
  const err = new Error(`[jxl-stream] server returned mismatched range start ${cr.start}, expected ${start}: ${url}`);
  await cancelBoth(err.message);
  throw err;
}
```

(Missing Content-Range on a 206 is tolerated — assume compliant start.)

### A4 (P1-1): observed prefetch rejections

In **both** `fromReadableStream` and `fromByteRange`, replace direct `reader.read()` calls in the pump with:

```ts
// Mark prefetch rejections as handled; the loop still awaits and surfaces them.
const read = () => {
  const p = reader.read();
  void p.catch(() => {});
  return p;
};
let pending = read();
// ... and every `pending = ... ? reader.read() : (null as any)` becomes `read()`
```

Preserves the SB-3 inference trick (no type annotation on `pending`).

### A5 (P1-3): resume no-op guard

At the top of `resumeFromByteRange` (before the RangeError validation):

```ts
if (state.start === state.endExclusive) {
  // Previous transfer completed; nothing to fetch.
  await session.close();
  return { requested: 0, honored: true, delivered: 0, fullSize: state.fullSize, etag: state.etag };
}
```

Keep the RangeError for `start > endExclusive` / non-finite.

### A6 (P1-4): onRangeNegotiated doc fix (+ optional onHeaders)

Fix the `RangePrefixOptions.onRangeNegotiated` comment: it fires once from `finally` after the transfer completes or fails mid-body (with final `delivered`); it does **not** fire for pre-body failures (416, non-ok status, fetch rejection). Optionally add:

```ts
/** Fired once as soon as response headers arrive, before any bytes are pumped.
 *  `delivered` is 0 at this point. Lets callers abort wasteful 200-fallback skips early via their signal. */
onHeaders?: (info: RangeNegotiation) => void;
```

fired right after the A3 validation with `makeInfo(0)`. Note `makeInfo` memoizes — onHeaders and onRangeNegotiated then share one object whose `delivered` mutates; if that sharing is judged confusing, build a fresh snapshot for onHeaders instead.

### A7 (P2-3 + P2-4): zero-length chunk skip; dead condition

In both pump loops, after `if (done) break;`:

```ts
if (value.byteLength === 0) { pending = read(); continue; }
```

(For `fromByteRange`, place before the skip logic.) Also `!resp.ok && resp.status !== 206`: 206 is within `ok`; drop the dead clause (keep `!resp.ok`).

**Verification:** `node --test packages/jxl-stream/test/` must stay green (existing 14 tests). TypeScript must compile (`tsc -p packages/jxl-stream` or the package's build script). Agent E adds tests that lock A1–A5 in.

---

## Agent B — `packages/jxl-stream/src/browser.ts` (performance & features)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

**File: `packages/jxl-stream/src/browser.ts` only. Run after Agent A** (A's edits land first; rebase on them).

### B1 (P3-1): `fromBlobRange` — local zero-copy range windows

`Blob.slice(start, end)` is a constant-time reference, not a copy. This gives OPFS-cached pyramid files (via jxl-cache, which hands back Blobs/Files) the exact same window API as HTTP Range — same call shape as `fromByteRange`, no network, no server. Place next to `fromBlob`:

```ts
/**
 * Pipe the byte window [start, endExclusive) of a Blob into a session.
 * Blob.slice is a zero-copy reference — ideal for OPFS-cached pyramid files
 * where the manifest supplies exact per-level/tile offsets (local analogue of fromByteRange).
 * Window is clamped to blob.size; start at/after the end delivers 0 bytes and closes cleanly.
 */
export async function fromBlobRange(
  blob: Blob,
  start: number,
  endExclusive: number,
  session: DecodeSession,
  signalOrOpts?: AbortSignal | PipeOptions,
): Promise<number> {
  if (!Number.isFinite(start) || !Number.isFinite(endExclusive) || start < 0 || start >= endExclusive) {
    throw new RangeError('[jxl-stream] start and endExclusive must satisfy 0 <= start < endExclusive and be finite');
  }
  const slice = blob.slice(start, Math.min(endExclusive, blob.size));
  return fromReadableStream(slice.stream() as ReadableStream<Uint8Array>, session, signalOrOpts);
}
```

This is a strong candidate for `docs/Headline Features.md`: offline field kit — cached pyramids become range-addressable with zero copies, so tile-level progressive paint works with airplane-mode parity to the network path.

### B2 (P3-2): fetch priority pass-through

```ts
// RangePrefixOptions:
/** Forwarded to fetch() as RequestInit.priority where supported ('high' | 'low' | 'auto').
 *  Lets callers mark speculative pyramid prefetches 'low' and on-screen tiles 'high'. */
priority?: 'high' | 'low' | 'auto';
```

In `fromByteRange`'s fetch call:

```ts
resp = await fetchImpl(url, { headers: mergedHeaders, signal, priority: opts.priority } as RequestInit);
```

(Cast needed if the project's TS lib predates `RequestInit.priority`; unsupported runtimes ignore the field.)

### B3 (P3-3): timing telemetry on RangeNegotiation

Pure measurement — no heuristics, no tunables (CLAUDE.md compliant). Add optional fields:

```ts
// RangeNegotiation:
/** Milliseconds from fetch dispatch to response headers (TTFB). */
ttfbMs?: number;
/** Milliseconds from headers to transfer end (success or failure). */
transferMs?: number;
```

In `fromByteRange`: `const t0 = performance.now();` before fetch; after headers `const tHeaders = performance.now();` and set `info.ttfbMs = tHeaders - t0` inside `makeInfo` construction (capture via closure variables, same pattern as `fullSize`/`etagFromResponse`); in `finally`, `info.transferMs = performance.now() - tHeaders` before firing `onRangeNegotiated`. `performance` is global in browsers and Node ≥16. Downstream consumers (pyramid level selection, AR bandwidth adaptation) can build on this later — measurement now, policy later with benchmarks.

### B4 — deferred items: record, do not implement

Append a short "considered, deferred" note (one line each) to your handoff result for: pump-loop fusion, per-origin Range-capability memo, multi-range coalescing, `fromResponse` ok-check, BYOB readers (conflicts with transfer-into-WASM, same class as rejected pixel pools). If you judge any actively harmful, log it in `docs/rejected optimizations.md` instead.

**Verification:** existing tests green; `tsc` clean. fromBlobRange gets tests from Agent E.

---

## Agent C — `packages/jxl-stream/src/node.ts` (correctness & parity)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

**File: `packages/jxl-stream/src/node.ts` only.** Context: thin Node adapters over the platform-neutral `browser.ts` (`DecodeSession`/`EncodeSession`/`PipeOptions` are defined there; import `PipeOptions` too). Browser `fromReadableStream` recently gained `maxBytes` (the client-side convergedByteEnd cutoff — manifest tells the client where visual saturation occurs; client aborts download there, ~50% network savings) and I/O prefetch; node.ts got neither. Do not touch `BufferedReader` — Agent D owns it.

### C1 (P0-3): fix `toNodeReadable` — byte mode + cancel-on-destroy

Current code returns object-mode ArrayBuffer chunks (`Readable.from` default) → `ERR_INVALID_ARG_TYPE` when piped to `fs.createWriteStream`/sockets, and never cancels the session when the consumer destroys the stream or the signal aborts. Replace:

```ts
/**
 * Turns an EncodeSession's output chunks into a byte-mode Node.js Readable.
 * Buffer.from(ArrayBuffer) is a zero-copy view. Consumer destroy / signal abort
 * cancels the session (Readable.from calls iterator.return(), which runs `finally`).
 */
export function toNodeReadable(
  session: EncodeSession,
  signal?: AbortSignal
): Readable {
  let finished = false;
  async function* buffers(): AsyncGenerator<Buffer> {
    try {
      for await (const chunk of session.chunks()) yield Buffer.from(chunk);
      finished = true;
    } finally {
      if (!finished) void session.cancel('stream destroyed');
    }
  }
  return Readable.from(buffers(), { signal, objectMode: false });
}
```

(If `session.chunks()` itself throws, the encode already failed; the extra `cancel` is idempotent and harmless.)

### C2 (P3-4 + P2-2 + P1-5 + P1-6): rewrite `fromNodeReadable` — PipeOptions/maxBytes parity, prefetch, guards

Backward compatible: `AbortSignal` still accepted positionally; `void → number` return widening is safe for existing awaiters. Mirrors the browser pump (prefetch read N+1 while push N dispatches):

```ts
import { Readable } from 'node:stream';
import type { DecodeSession, EncodeSession, PipeOptions } from './browser.js';

/**
 * Pipes a Node.js Readable into a DecodeSession.
 * Honours backpressure (awaits session.push); prefetches the next chunk during push dispatch.
 * Accepts AbortSignal (back-compat) or PipeOptions {signal?, maxBytes?}.
 * maxBytes is the client-side convergedByteEnd cutoff: last chunk trimmed via subarray,
 * readable destroyed (intentional cutoff), session closed gracefully. Returns bytes delivered.
 */
export async function fromNodeReadable(
  readable: Readable,
  session: DecodeSession,
  signalOrOpts?: AbortSignal | PipeOptions,
): Promise<number> {
  const opts: PipeOptions = signalOrOpts instanceof AbortSignal ? { signal: signalOrOpts } : (signalOrOpts ?? {});
  const { signal, maxBytes } = opts;
  if (maxBytes !== undefined && (!Number.isFinite(maxBytes) || maxBytes <= 0)) {
    throw new RangeError('[jxl-stream] maxBytes must be a positive finite number');
  }

  const onAbort = () => {
    void session.cancel('AbortSignal triggered');
    readable.destroy(new Error('Aborted'));
  };

  if (signal?.aborted) {
    readable.destroy(new Error('Aborted'));
    await session.cancel('AbortSignal triggered');   // P1-6: awaited, no floating promise
    return 0;
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  let delivered = 0;
  try {
    const it = readable[Symbol.asyncIterator]();
    let pending = it.next();
    while (true) {
      const { done, value } = await pending;
      if (done) break;
      if (signal?.aborted) break;
      if (typeof value === 'string') {
        throw new TypeError('[jxl-stream] fromNodeReadable requires a binary stream (do not call setEncoding)');
      }
      let chunk: Uint8Array = value;
      if (chunk.byteLength === 0) { pending = it.next(); continue; }

      const remaining = maxBytes != null ? maxBytes - delivered : Infinity;
      const cutoff = chunk.byteLength >= remaining;
      pending = cutoff ? Promise.resolve({ done: true as const, value: undefined }) : it.next();

      if (chunk.byteLength > remaining) chunk = chunk.subarray(0, remaining);
      delivered += chunk.byteLength;
      await session.push(chunk);

      if (cutoff) { readable.destroy(); break; }
    }
    if (signal?.aborted) {
      await session.cancel('AbortSignal triggered');
    } else {
      await session.close();
    }
    return delivered;
  } catch (e) {
    await session.cancel(e instanceof Error ? e.message : String(e));
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
```

Notes: prefetching `it.next()` before `await session.push()` overlaps file/socket I/O with worker dispatch — the same one-ahead pattern the browser side uses. On the cutoff path don't prefetch a real read (no point pulling bytes past convergedByteEnd); `readable.destroy()` without an error emits 'close', not 'error'. Session `cancel()` is idempotent — the abort path may double-cancel (onAbort + post-loop); that matches existing behavior.

**Verification:** `tsc` clean. Ask Agent E (or include in your end-of-task requests) for a `node.test.ts` covering: pipe-to-`fs.createWriteStream` round-trip, consumer-destroy → session.cancel, maxBytes trim/exact-boundary, string-chunk TypeError, pre-aborted signal.

---

## Agent D — `packages/jxl-stream/src/node.ts` (`BufferedReader` performance)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

**File: `packages/jxl-stream/src/node.ts`, `BufferedReader` class only. Run after Agent C** (C rewrites other functions in this file; do not touch them).

### D1 (P2-1): chunk-deque rewrite — O(1) append, O(taken) take

Current implementation copies the entire accumulated buffer on every `append` (and twice on every `take`): accumulating N chunks costs O(N²·chunkSize) memory traffic. Replace with a chunk list + head offset. Contract preserved exactly: `take`/`takeAll` return **copies** (callers may transfer or mutate), `take` returns `null` when short, `length` getter unchanged.

```ts
/**
 * bufferedReader helper: accumulates byte ranges for callers that prefer
 * to push by byte range rather than by chunk.
 * Chunk-deque internals: append is O(1) (no re-copy of accumulated bytes);
 * take copies only the bytes returned. Returned arrays are fresh copies.
 */
export class BufferedReader {
  private chunks: Uint8Array[] = [];
  private head = 0;     // read offset into chunks[0]
  private total = 0;

  append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.total += chunk.length;
  }

  /**
   * Returns and removes `size` bytes from the head.
   * Returns null if not enough bytes.
   */
  take(size: number): Uint8Array | null {
    if (size < 0) return null;
    if (this.total < size) return null;
    if (size === 0) return new Uint8Array(0);

    const first = this.chunks[0];
    // Fast path: satisfied within the first chunk (copy preserves old slice() contract).
    if (first.length - this.head >= size) {
      const out = first.slice(this.head, this.head + size);
      this.head += size;
      this.total -= size;
      if (this.head === first.length) { this.chunks.shift(); this.head = 0; }
      return out;
    }
    // Spanning path: coalesce across chunks.
    const out = new Uint8Array(size);
    let copied = 0;
    while (copied < size) {
      const c = this.chunks[0];
      const n = Math.min(c.length - this.head, size - copied);
      out.set(c.subarray(this.head, this.head + n), copied);
      copied += n;
      this.head += n;
      this.total -= n;
      if (this.head === c.length) { this.chunks.shift(); this.head = 0; }
    }
    return out;
  }

  /**
   * Returns all remaining bytes.
   */
  takeAll(): Uint8Array {
    return this.take(this.total) ?? new Uint8Array(0);
  }

  get length(): number {
    return this.total;
  }
}
```

Behavioural caveat to verify before landing: the old `append` defensively *copied* incoming chunks (by rebuilding the buffer); the new one retains a **reference** — a caller that mutates a chunk after `append` would now see corruption. Search the repo for `BufferedReader` usage (`rg "BufferedReader"`); if any call site reuses/mutates pushed chunks, copy on append (`this.chunks.push(chunk.slice())`) — still O(chunk), still removes the O(total) re-copy. Note `shift()` is O(#chunks); chunk counts here are small (network-chunk scale), so this is fine — do not add an index-pointer micro-optimization without a benchmark (CLAUDE.md rule).

**Verification:** `tsc` clean; if Agent E's node tests exist by then, run them. A quick inline sanity (append 3 chunks, take spanning boundary, take exact, take short → null, takeAll, length accounting) in the test file is part of Agent E's remit — coordinate rather than duplicate.

---

## Agent E — `packages/jxl-stream/test/range.test.ts` (tests)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

**File: `packages/jxl-stream/test/range.test.ts`. Run last** (tests target post-A/B/C/D behavior). `range.test.ts` is the only test file in the package — `fromByteRange` with `start > 0`, the resume API, `fromReadableStream`'s `maxBytes`, `toReadableStream`, and all of `node.ts` currently have **zero** coverage. Reuse the existing helpers (`makeSession`, `streamFromChunks`, `fakeFetch`). Existing 14 tests must keep passing.

Add to `range.test.ts` (new `describe` blocks):

**`fromByteRange` (start > 0)** — the most intricate untested code:
1. 206 window `[1000, 2000)`: Range header is `bytes=1000-1999`, delivers exactly 1000 bytes, closed.
2. 206 Content-Range start mismatch (server says `bytes 0-999/5000` when asked for 1000–1999): rejects, session cancelled (locks A3).
3. 200 fallback skip: body 5000 bytes in 400-byte chunks, window `[1000, 1600)`: skips full chunks, subarray on the boundary chunk (skip lands mid-chunk at 1000 = 2×400 + 200), delivers 600 bytes with correct first byte value, never pushes skipped bytes.
4. 200 fallback where skip and trim hit the *same* chunk (window `[100, 300)`, single 5000-byte body chunk): delivers exactly 200 bytes.
5. 206 `fullSize`: Content-Range `bytes 1000-1999/*` + Content-Length `1000` → `fullSize === undefined` (locks A3/P0-4 — part-length must not leak into fullSize on 206).
6. Zero-length chunk in body stream: ignored, not pushed (locks A7).
7. `signal` is forwarded to `fetchImpl` (spy asserts `init.signal === controller.signal`).
8. `onRangeNegotiated` fires on mid-body network error with partial `delivered` (SB-5 behavior, currently untested).

**Resume API** (locks A1/A2/A5):
9. `createByteRangeResumeState` with `originalStart = 1000`, `requested = 1000`, `delivered = 400` → `start === 1400`, `endExclusive === 2000` (regression test for P0-1).
10. `resumeFromByteRange` sets `If-Range` header from a strong ETag (spy on headers); weak ETag `W/"abc"` → no If-Range header.
11. Resume + 200 response + different ETag → rejects with /resource changed/, session cancelled (expectEtag path).
12. Completed state (`start === endExclusive`) → resolves `{requested: 0, delivered: 0}`, session closed, no fetch call.

**Existing-test hardening:**
13. 416 test: add `assert.notEqual(session.cancelled, null)` (code cancels before throwing — currently unasserted).

**`fromReadableStream` maxBytes** (browser.ts, nothing covers it):
14. maxBytes mid-chunk trim: chunks 400+400+400, maxBytes 1000 → delivered 1000, third push is 200 bytes, session closed (not cancelled), returns 1000.
15. maxBytes exact chunk boundary (800 over 400+400) → no fourth read issued, closed.
16. maxBytes ≥ total stream → delivers all, returns total.
17. Invalid maxBytes (0, -1, NaN, Infinity) → RangeError.

**`fromBlobRange`** (added by Agent B): window `[2, 5)` of an 8-byte Blob delivers bytes 2–4; window past `blob.size` clamps; invalid range throws RangeError. (Node ≥18 has `Blob` global.)

**Deferred — request approval at the end:** a new file `packages/jxl-stream/test/node.test.ts` covering node.ts (Agent C/D changes): `toNodeReadable` piped into a byte sink (e.g. collect via `stream.pipeline` into Buffer.concat — asserts byte-mode Buffers, not object-mode ArrayBuffers), consumer `destroy()` → `session.cancel` called, `fromNodeReadable` maxBytes trim + return count, string chunk → TypeError, pre-aborted signal, and `BufferedReader` (append/take spanning chunks, take exact boundary, take short → null, takeAll, length accounting, zero-size take). New file = outside ambit, hence approval-gated.

**Verification:** `node --test packages/jxl-stream/test/` fully green; if a test exposes a divergence from an agent's implementation, report it rather than weakening the assertion.

---

## What implementing this achieves

The headline outcome is that the resumable byte-range machinery becomes actually safe to ship to the field. Today it carries two silent-corruption paths: resuming any window that didn't start at byte zero recomputes the wrong absolute offset (P0-1), and a resource that changes on the server between sessions gets stitched across versions because the If-Range contract was misread (P0-2). For a biodiversity platform whose stated environment is unreliable rural connectivity — interrupted tile downloads, app restarts mid-specimen, CDNs of varying competence — resumability is not a convenience feature, it is the difference between a usable offline workflow and quietly corrupted herbarium imagery. With the Content-Range validation and 206 fullSize fix on top, the stream layer stops trusting servers it has no reason to trust.

The second thread is platform parity. The Node adapters were a sketch while the browser path matured: `toNodeReadable` cannot actually be piped to a file today (object-mode ArrayBuffers), `fromNodeReadable` lacks the convergedByteEnd cutoff that already saves ~50% of network bytes in the browser, and `BufferedReader` does quadratic memory traffic on exactly the workload it exists for. After C and D, ingest behaves identically whether bytes arrive from fetch, a Blob, an OPFS file, or a Node socket — one mental model, one set of behavioral contracts, prefetch pipelining everywhere.

Third, the additions are deliberately small but open doors: `fromBlobRange` makes locally cached pyramids range-addressable with zero-copy slices (the offline mirror of HTTP Range — the AR and field-identification stories run on this), fetch `priority` lets the scheduler express speculative-versus-urgent tile fetches to the network stack, and the TTFB/transfer timing fields put real measurements in place so that future adaptive level selection can be argued from data rather than guessed — in keeping with the repo's "no tunables without benchmarks" rule.

Finally, the test work converts this from "reviewed once" to "guarded continuously". The single existing test file exercises only the prefix-fetch happy paths; the skip pump, the resume path, maxBytes, and the entire Node surface had zero coverage — which is precisely where both P0 bugs were hiding. The new suite locks each fix behind a regression test and puts the most intricate loop in the package (the 200-fallback skip/trim pump) under explicit multi-chunk, boundary, and same-chunk scrutiny. Net effect: a small, already-good I/O layer becomes a trustworthy one, with its growth points (coalescing, capability memos, adaptive selection) documented and benchmark-gated rather than speculatively implemented.
