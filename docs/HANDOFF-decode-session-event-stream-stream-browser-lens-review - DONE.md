# HANDOFF — jxl-session (decode-session.ts, event-stream.ts) + jxl-stream (browser.ts) Lens Review

Date: 2026-06-10. Method: 22-lens review (strategic, API, pipeline, state, data structures, hot kernels, boundaries, support, owl, reversal, astronomy, ML, gaming, photogrammetry, butteraugli, AR, perceptual-colour, pure math, hacker, re-perspective ×2, gaps, birds-eye).

Files (ONLY these may be edited without approval):
1. `packages/jxl-session/src/decode-session.ts`
2. `packages/jxl-session/src/event-stream.ts`
3. `packages/jxl-stream/src/browser.ts`

## Strategic map (Lens 1)

`browser.ts` is the ingestion edge: network/Blob → `Uint8Array` chunks → `session.push()` with one-ahead I/O prefetch; it owns abort wiring and Range negotiation. `decode-session.ts` is the protocol adapter: serializes `DecodeOptions` into `decode_start`, routes worker messages into typed `DecodeFrameEvent`s, owns the terminal state machine (`finish` / `finishWithError` / `fail`). `event-stream.ts` is the hand-rolled async channel between worker-message cadence and consumer `for-await` cadence; it buffers frame events whose payloads are multi-megabyte pixel `ArrayBuffer`s — so its reference hygiene dominates the memory profile of the whole session layer. Data crossing: chunks flow down (transferable, zero-copy when view spans buffer), frames flow up (transferred pixels, buffered in `AsyncEventStream`), errors flow both ways (signal → cancel down; JxlError ← decode_error up).

Unilluminated rooms (Lens 21): encode path has only type stubs in browser.ts (no `toEncodeSession` helpers); no Node twin for browser.ts noted; no protocol version negotiation anywhere. Out of scope here — recorded for future passes.

## Findings (amalgamated)

### event-stream.ts (ES)

- **ES-1 (HIGH, memory — Lenses 5/9/19):** Consumed buffer slots retain references until compaction (head > 64 AND head > length/2). Each slot holds a `DecodeFrameEvent` with full-frame pixels — up to 64+ frames (hundreds of MB) pinned after consumption. Null the slot on read. Does NOT touch the ratified ≥64 compaction threshold (rejected item "compactQueue threshold < 64" stays respected).
- **ES-2 (HIGH, memory — Lens 10 reversal):** Early `break` in for-await calls `return()`, but stream keeps accepting/buffering subsequent pushes (session still emits passes + final) with no consumer ever draining them; on `end()` they are retained forever. Single-consumer contract means `return()` ⇒ nobody will read again: mark returned, drop buffer, drop future pushes.
- **ES-3 (MED, simplify/perf — Lens 18):** Single-consumer invariant ⇒ `waiting` queue length is always ≤ 1. Replace array with one nullable waiter slot; removes shift() churn and makes `return()`'s "waiting[0] is mine" reasoning structural.
- **ES-4 (LOW, perf — Lens 19):** Every post-end `next()` and every `return()` allocates a fresh `{value, done:true}` + Promise. Hoist module-level frozen `DONE` result and shared `DONE_PROMISE`.
- **ES-5 (LOW, API):** Add `clear()` (drop buffer, reset head) so decode-session can discard unconsumed frames on the success path (DS-2) without faking a failure.

### decode-session.ts (DS)

- **DS-1 (MED, bug-risk — Lenses 4/7):** Two un-awaited concurrent `push()` calls both await `acquirePromise` then `scheduler.waitForDrain()`. Chunk ordering — codestream correctness — silently depends on `waitForDrain` resolving FIFO. Verify scheduler guarantee; if absent, serialize pushes through an internal promise chain. (In-repo caller `fromReadableStream` awaits each push, so currently latent.)
- **DS-2 (HIGH, memory — Lens 10):** `finish()` (success path) does not check `framesConsumed` — a done()-only consumer leaves ALL progressive frames + final buffered in the stream indefinitely. `finishWithError()` already established the discard precedent. Before changing: grep repo for any "frames() after done() resolves" replay usage; if none, discard via ES-5 `clear()` when `!framesConsumed`.
- **DS-3 (MED, perf — Lens 9):** Already-aborted signal still performs full `acquireSlot()` then `cancelSession()` round trip. Hoist the aborted check above acquire; fail immediately, set `acquirePromise = Promise.resolve()`.
- **DS-4 (LOW, type-safety):** `KNOWN_JXL_ERROR_CODES: ReadonlySet<string>` — typos vs `JxlErrorCode` union pass silently and drift from jxl-core. Type as `ReadonlySet<JxlErrorCode>` (or import a runtime list from `@casabio/jxl-core/errors` if one exists).
- **DS-5 (LOW, robustness — Lens 8):** `opts.onMetric` user callback throws propagate into scheduler dispatch. Wrap in try/catch (dev-log swallow).
- **DS-6 (LOW, clarity/perf):** Every case repeats `if (msg.sessionId !== this.id) return;`. Scheduler already routes by id via `onMessage(this.id, …)`. Hoist single check to top of `handleMessage` (verify all `WorkerToMainMessage` variants carry `sessionId` first).
- **DS-7 (MED, DX — Lens 4):** `push()` after worker error throws generic `ConfigError("push() after close/cancel/error")` — real cause hidden in done(). Store `terminalError` in `fail()`/`finishWithError()`; rethrow it from `push()`. Semantics shift (Cancelled/TruncatedStream instead of ConfigError) — agent judgment.
- **DS-8 (MED, feature — Lenses 12/14/16):** `lastInfo` is written 4× and never read — dead store today. Expose it: `get info(): ImageInfo | null` plus optional `header(): Promise<ImageInfo>` (deferred resolved on `decode_header`). Early dims/ICC/bit-depth unlock canvas pre-allocation, AR overlay layout, and ML pre-classification before first pixels.
- **DS-9 (FEATURE — Lenses 12/13/16):** `firstFrame(session, {stage?})` helper: iterate `frames()`, on first event (or first ≥ requested stage) call `cancel('first frame satisfied')` and return it. DC-pass is sufficient for ML species-ID / AR recognition; saves the full decode. Pairs with ES-2 so post-cancel pushes don't pin memory. Export from decode-session.ts; index.ts re-export is a deferred edit needing approval.
- **DS-10 (LOW, protocol note — deferred):** `decode_error` partial frame uses `this.opts.format` while live frames use `msg.format`; protocol lacks `partialFormat`. If worker can downgrade format, partial is mislabeled. Protocol change = other-file edit, defer + request approval.
- **DS-11 (INVESTIGATE ONLY):** `cancel()` after `close()` is a silent no-op (task 007-logic-a1b2c3d4) — user cannot abort an in-flight completion after closing input. Re-read that task's rationale before proposing any change; do not change blind.

### jxl-stream/browser.ts (SB)

- **SB-1 (HIGH, bug — Lens 4):** In `fromRangePrefix`, `fetchImpl()`, the 416/!ok/!body throws, and `getReader()` all sit BEFORE the try block. Any failure (network error, abort during fetch, bad status) leaves the session dangling: never cancelled, `done()` never settles, worker slot logic depends on external signal sharing. Wrap fetch + status checks + reader acquisition; `session.cancel(reason)` then rethrow.
- **SB-2 (MED, bug):** `toReadableStream` `cancel(reason)` — `reason` is `any` (often an Error or undefined) passed straight into `session.cancel(reason?: string)`. Coerce: `typeof reason === 'string' ? reason : reason === undefined ? 'stream cancelled' : String(reason)`.
- **SB-3 (LOW, simplify):** The synthetic `Promise.resolve({done:true, value: undefined as unknown as Uint8Array<ArrayBuffer>})` pending sentinel is never actually awaited (loop always breaks first via `delivered >= byteCount`). Replace with `null` sentinel + `if (pending === null) break;` — removes the type laundering.
- **SB-4 (LOW, robustness):** `parseNonNegativeInt` via `Number()` accepts `"1e3"`, `"0x10"`, `"1.5"`. Gate with `/^\d+$/` before Number.
- **SB-5 (MED, API):** `fromRangePrefix` returns `Promise<void>`; delivered/honored only via callback, and `postNegotiation` never fires on error paths. Return `Promise<RangeNegotiation>` (void→value is backward-compatible) and move `postNegotiation(delivered)` into `finally`.
- **SB-6 (HIGH, feature — Lens 15 + ratified convergedByteEnd):** Add `maxBytes` to `fromReadableStream`/`fromResponse` via options overload. After `maxBytes` delivered: cancel reader, `session.close()`. This IS the convergedByteEnd client abort (manifest carries offline visual-saturation cutoff; stream layer is the designated abort point; ~50% net savings).
- **SB-7 (HIGH, feature — Lenses 11/14/16):** Generalize to `fromByteRange(url, start, endExclusive, session, opts)`; `fromRangePrefix = fromByteRange(url, 0, n, …)`. Pyramid manifests give per-level/per-tile byte offsets — arbitrary windows let viewers fetch exactly one level/tile (telescope analogy: point the aperture, don't drink the sky). 200-OK fallback must skip `start` bytes before delivering (count + subarray).
- **SB-8 (LOW, robustness):** `fromReadableStream`: `stream.getReader()` throws on locked stream before any cleanup wiring — session left dangling. Same class as SB-1; wrap or cancel-and-rethrow.
- **SB-9 (BENCHMARK-GATED — Lens 19):** Coalescing many tiny network chunks (< ~16 KiB) into one buffer before `push()` would batch JS↔worker postMessage crossings. CAUTION: adjacent to rejected R1-4 ("batch logic in session/facade") — ingestion-side coalescing is arguably the stream layer's prerogative, but CLAUDE.md forbids tunables without benchmark evidence. Implement ONLY behind a measured win; otherwise log to rejected optimizations.
- **SB-10 (NOTE ONLY, no implementation):** Resumable fetch (retry with `Range: bytes={delivered}-` continuation) would serve field/offline use. Record as future feature; do not build now.

---

## Agent handoffs

Rule for all agents: you may read any file in the repo for context, but only edit your assigned file. Edits to any other file (index.ts exports, protocol types, scheduler) must be deferred to the end and require approval. Check `docs/rejected optimizations.md` before implementing anything adjacent to scheduler/pool/protocol.

### Agent 1 — `packages/jxl-session/src/event-stream.ts` (ES-1..ES-5)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

```ts
// module level (ES-4)
const DONE: IteratorResult<never> = Object.freeze({ value: undefined as never, done: true });
const DONE_PROMISE: Promise<IteratorResult<never>> = Promise.resolve(DONE);

// ES-3: replace waiting array with single slot
private waiter: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void } | null = null;

// ES-2: returned flag
private returned = false;

push(item: T): void {
  if (this.ended || this.returned) return;          // ES-2: drop post-return pushes
  const w = this.waiter;
  if (w !== null) { this.waiter = null; w.resolve({ value: item, done: false }); }
  else this.buffer.push(item);
}

// ES-5
clear(): void { this.buffer.length = 0; this._head = 0; }

// next() warm path (ES-1): release the slot's reference immediately
const value = this.buffer[this._head]!;
this.buffer[this._head] = undefined as never;       // assigning undefined keeps PACKED_ELEMENTS, no hole
this._head++;
// keep existing ≥64 compaction exactly as-is (ratified threshold)

// return() (ES-2): single-consumer ⇒ nobody reads again
return (): Promise<IteratorResult<T>> => {
  this.returned = true;
  this.clear();
  const w = this.waiter;
  if (w !== null) { this.waiter = null; w.resolve(DONE as IteratorResult<T>); }
  return DONE_PROMISE as Promise<IteratorResult<T>>;
};
```

Constraints: keep single-consumer contract comments; `end()`/`fail()` stay idempotent and must also use the slot instead of the queue; `fail()` keeps clearing buffer. Do not lower the 64 compaction threshold. Verify existing tests in jxl-session still pass; add tests: break-early then push → buffer stays empty; consumed slot nulled.

### Agent 2 — `packages/jxl-session/src/decode-session.ts` lifecycle/memory (DS-1, DS-2, DS-3, DS-7)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- **DS-1:** Read `packages/jxl-scheduler/src/scheduler.ts` `waitForDrain` — confirm FIFO resolution for concurrent waiters of one session. If FIFO: add a comment documenting the dependency. If not:
```ts
private pushChain: Promise<void> = Promise.resolve();
async push(chunk: ArrayBuffer | Uint8Array): Promise<void> {
  if (this.terminated || this.closed) throw this.terminalError ?? new JxlError("ConfigError", "push() after close/cancel/error", { sessionId: this.id });
  const p = this.pushChain.then(() => this.pushImpl(chunk));
  this.pushChain = p.catch(() => undefined);   // chain survives rejection
  return p;
}
```
- **DS-2:** First grep repo for `done()`-then-`frames()` replay usage. If none:
```ts
private finish(info: ImageInfo): void {
  if (this.terminated) return;
  this.terminated = true;
  this.cleanup();
  if (!this.framesConsumed) this.frameStream.clear();  // requires Agent 1's clear()
  this.frameStream.end();
  if (!this.doneDeferred.settled) this.doneDeferred.resolve(info);
}
```
Document in the DecodeSession contract: call frames() before awaiting done() if you want frames.
- **DS-3:** In constructor, check `opts.signal?.aborted` BEFORE `acquireSlot`; if aborted: `this.acquirePromise = Promise.resolve(); this.fail(new JxlError("Cancelled", "Decode aborted by signal", { sessionId: this.id }));` and skip listener registration. Do not call `cancelSession` for a slot never requested — verify scheduler tolerates `cancelSession` on unknown id anyway.
- **DS-7:** `private terminalError: JxlError | null = null;` set in `fail()` and `finishWithError()`; `push()` rethrows it when terminated (see DS-1 snippet). Note semantics change in the commit message.

Coordinate with Agent 1 (clear()) — if Agent 1 rejected ES-5, fall back to `frameStream.fail(…)`-style discard only if you can preserve graceful end semantics; otherwise reject DS-2 with reasons.

### Agent 3 — `packages/jxl-session/src/decode-session.ts` API/robustness/features (DS-4, DS-5, DS-6, DS-8, DS-9, DS-10, DS-11)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Runs AFTER Agent 2 on the same file.

- **DS-4:** `const KNOWN_JXL_ERROR_CODES: ReadonlySet<JxlErrorCode> = new Set([...])` — compiler now rejects drift. Check `@casabio/jxl-core/errors` for an exported runtime code list first; prefer importing it.
- **DS-5:** wrap `this.opts.onMetric(msg.metric)` in try/catch; dev-mode console.warn on throw.
- **DS-6:** verify every `WorkerToMainMessage` variant has `sessionId` (check jxl-core types); then hoist `if (msg.sessionId !== this.id) return;` to top of `handleMessage`, delete per-case checks.
- **DS-8:**
```ts
get info(): ImageInfo | null { return this.lastInfo; }
// optional, if cheap: private headerDeferred resolved in case "decode_header";
// header(): Promise<ImageInfo> — reject on fail() with terminalError.
```
- **DS-9:** export helper (same file; index.ts re-export deferred for approval):
```ts
export async function firstFrame(
  session: Pick<DecodeSession, "frames" | "cancel">,
  opts?: { minStage?: "dc" | "pass" | "final" },
): Promise<DecodeFrameEvent> {
  for await (const f of session.frames()) {
    if (opts?.minStage === undefined || stageRank(f.stage) >= stageRank(opts.minStage)) {
      void session.cancel("first frame satisfied");
      return f;
    }
  }
  throw new JxlError("Internal", "stream ended before requested stage", {});
}
```
Verify actual stage union in jxl-core before writing `stageRank`.
- **DS-10:** do NOT edit protocol files. If you confirm the worker can emit a format different from `opts.format`, write the proposed `partialFormat` protocol addition at the end of your report and request approval.
- **DS-11:** investigate task 007-logic-a1b2c3d4 (git log / docs). Report whether cancel-after-close could safely `cancelSession + fail` when `!terminated`. Do not change code unless the original rationale is demonstrably obsolete.

### Agent 4 — `packages/jxl-stream/src/browser.ts` bugs/robustness (SB-1, SB-2, SB-3, SB-4, SB-8)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- **SB-1:**
```ts
let resp: Response;
let reader: ReadableStreamDefaultReader<Uint8Array>;
try {
  resp = await fetchImpl(url, { headers: mergedHeaders, signal });
  if (resp.status === 416) throw new RangeError(`[jxl-stream] 416 Range Not Satisfiable: ${url}`);
  if (!resp.ok && resp.status !== 206) throw new Error(`[jxl-stream] HTTP ${resp.status} ${resp.statusText}: ${url}`);
  if (!resp.body) throw new Error('[jxl-stream] Response has no body');
  reader = resp.body.getReader();
} catch (e) {
  await session.cancel(e instanceof Error ? e.message : String(e));
  throw e;
}
```
(`session.cancel` is idempotent — later double-cancel paths are safe.)
- **SB-2:** coerce cancel reason: `const r = typeof reason === 'string' ? reason : reason === undefined ? 'stream cancelled' : String(reason); await session.cancel(r);`
- **SB-3:** `let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = reader.read();` … `pending = remaining > value.byteLength ? reader.read() : null;` … top of loop after the abort check: `if (pending === null) { void reader.cancel('range satisfied'); break; }` — then await. Confirm the `delivered >= byteCount` break still covers exact-boundary; delete dead branch.
- **SB-4:** `if (!/^\d+$/.test(s)) return undefined;` before `Number(s)` in `parseNonNegativeInt`.
- **SB-8:** wrap `stream.getReader()` in `fromReadableStream`: on throw, `await session.cancel(String(e))` then rethrow.

Run jxl-stream tests; add tests for fetch-throw → session.cancel called, and non-string cancel reason.

### Agent 5 — `packages/jxl-stream/src/browser.ts` features (SB-5, SB-6, SB-7, SB-9, SB-10)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Runs AFTER Agent 4 on the same file.

- **SB-5:** change `fromRangePrefix` return type to `Promise<RangeNegotiation>`; build the info object once, fire `onRangeNegotiated` from `finally` (so error paths report `delivered` too), return it on success.
- **SB-6:** options overload, backward compatible:
```ts
export interface PipeOptions { signal?: AbortSignal; maxBytes?: number; }
export async function fromReadableStream(
  stream: ReadableStream<Uint8Array>,
  session: DecodeSession,
  signalOrOpts?: AbortSignal | PipeOptions,
): Promise<number>;  // bytes delivered (void→number is compatible for existing callers)
// detect: signalOrOpts instanceof AbortSignal ? { signal: signalOrOpts } : signalOrOpts ?? {}
```
When `delivered >= maxBytes`: trim the final chunk with `subarray`, `void reader.cancel('maxBytes satisfied')`, then `session.close()`. This is the convergedByteEnd client abort — the manifest's visual-saturation cutoff feeds `maxBytes`. Thread the same option through `fromResponse` and `fromBlob`.
- **SB-7:**
```ts
export async function fromByteRange(
  url: string, start: number, endExclusive: number,
  session: DecodeSession, opts: RangePrefixOptions = {},
): Promise<RangeNegotiation>
// Range: `bytes=${start}-${endExclusive - 1}`
// 206: pipe ≤ (endExclusive - start) bytes as today.
// 200 fallback (server ignored Range): skip `start` bytes first —
//   let skipped = 0; while (skipped < start) { read; if (chunk.byteLength <= start - skipped) skipped += len (drop) else push(chunk.subarray(start - skipped)) ... }
// then deliver up to (endExclusive - start). Validate 0 <= start < endExclusive, finite.
// Reimplement fromRangePrefix as fromByteRange(url, 0, byteCount, session, opts).
```
Motivation: pyramid manifests carry per-level/tile byte offsets; viewers fetch exactly one window.
- **SB-9:** small-chunk coalescing — ONLY with benchmark evidence (measure postMessage count + wall time on a many-small-chunks fixture vs baseline). Without a measured win, write it to rejected optimizations citing R1-4 adjacency and CLAUDE.md's no-tunables-without-evidence rule.
- **SB-10:** do not implement. Append a short "future: resumable Range continuation for field/offline" note to your report.

New exports from browser.ts only; package index re-exports are deferred edits requiring approval.

---

## What implementing this achieves

The memory findings (ES-1, ES-2, DS-2) close the session layer's last large leak class: today a consumer that breaks early, or never iterates frames at all, silently pins every progressive pass of a large image — potentially hundreds of megabytes per session — until GC happens to collect the whole session graph. After the fix, pixel ArrayBuffer references die the moment they can no longer be observed, which matters most exactly where this platform lives: long gallery sessions paging through thousands of specimen images on memory-constrained field devices. The bug fixes (SB-1, SB-2, DS-1) remove dangling-session states where `done()` never settles after a network failure — the kind of defect that surfaces as "the viewer just stops loading" on flaky field connectivity and is nearly undiagnosable from the UI.

The feature set turns the stream layer into the byte-precision instrument the pyramid architecture was designed around. `maxBytes` (SB-6) is the missing client half of the ratified convergedByteEnd design — the manifest already knows where visual saturation occurs; after this change the stream layer can actually stop downloading there, cutting roughly half the network cost of progressive paints. `fromByteRange` (SB-7) generalizes that to arbitrary windows, letting the viewer pull exactly one pyramid level or tile from a sidecar by offset, like pointing a telescope at one star instead of imaging the whole sky. `firstFrame` + early `info` access (DS-8, DS-9) give ML species-identification and AR overlays what they actually need — dimensions, ICC, and a DC-pass thumbnail — for a fraction of a full decode.

The remaining items are hygiene that compounds: typed error-code sets stop protocol drift at compile time, single-waiter simplification makes the event stream's trickiest invariant structural instead of commented, and the investigate-only items (cancel-after-close, partialFormat) are documented decision points rather than silent gaps. Nothing here touches scheduler, pool, cache, or protocol semantics; every item respects the ratified rejections (compaction threshold, no session-layer batching without benchmarks, no pixel pools), so the five agents can work their single files in parallel with low collision risk — only Agents 1→2 share a dependency (`clear()`).
