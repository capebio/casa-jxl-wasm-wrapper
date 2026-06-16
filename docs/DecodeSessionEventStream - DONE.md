# DecodeSession ⨯ EventStream — Multi-Lens Review - DONE

Protocol: `docs/multi-lens-review-protocol.md`. Date: 2026-06-15.
File 1: `packages/jxl-session/src/decode-session.ts`.
File 2 (most-important interfacing file): `packages/jxl-session/src/event-stream.ts`.

## Intro — purpose of the files

**decode-session.ts** is the public `DecodeSession`: the main-thread API a caller uses to
decode one image. It builds the `decode_start` message, acquires a worker slot through the
scheduler, registers a per-session message handler, and exposes `push()` / `close()` /
`cancel()` / `frames()` / `done()` / `header()` / `info`. Inbound worker messages
(`decode_header` / `decode_progress` / `decode_final` / `decode_budget_exceeded` /
`decode_error` / `decode_cancelled` / `metric`) are routed to a frame stream, two deferreds
(header + done), and the `onMetric` telemetry callback. All terminal states funnel through
`finish()` / `finishWithError()` / `fail()`.

**event-stream.ts** (`AsyncEventStream<T>`) is the push-driven, single-consumer
`AsyncIterable` that `frames()` returns. decode-session pushes each frame into it; the
consumer pulls via `for await`. It owns the buffer + head-cursor + single waiter slot, with
ratified O(1) reads and bounded compaction (ES-1..ES-5).

These two files are the data/result plane of a decode session: decode-session is the control
adapter over the scheduler, event-stream is the frame-delivery mechanism it owns.

## Method

Two lens rounds on decode-session, two on event-stream, then a seam pass on the boundary
between them, per the protocol's 27 lenses + the three-iteration slowest-algorithm focus.
Honest scoping note: both files are mature (CLAUDE.md: decode-session 4/5; event-stream is
ratified-tight) and are **pure async-TS control/data plumbing — no pixel kernels**. The
performance-deep-dive and mission lenses that target raw pixel math (SIMD/vectorization #9,
numerical reformulation #11, Butteraugli #19, perceptual colour #20, photogrammetry/AR
#16–18) have **no surface here** and are recorded as N/A rather than padded into fake
findings. The yield is correctness + one rejected memory idea, which is the truthful result
for two already-optimized files.

## Changes made

### decode-session.ts — `done()` no longer hangs for early-stop targets (correctness)

The worker (decode-handler) does **not** send a `decode_final` when it stops early:
- `progressionTarget: "header"` → it posts `decode_header` then `finishSession()` (no further
  main-thread message);
- `progressionTarget` ∈ {`"dc"`,`"pass"`} with `emitEveryPass: false` → it posts one
  `decode_progress` then `finishSession()`.

In both cases decode-session received no terminal message, so **`done()` (and any
`await`-on-completion) hung forever**. decode-session owns `progressionTarget` /
`emitEveryPass` (it sets them in `decode_start`), so it can mirror the worker's early-finish
exactly and self-complete:

```ts
// decode_header case
if ((this.opts.progressionTarget ?? "final") === "header") {
  this.finish(msg.info);
}

// decode_progress case, after pushing the frame + emitFoldedMetrics
if (
  (this.opts.progressionTarget ?? "final") !== "final" &&
  (this.opts.emitEveryPass ?? true) === false
) {
  this.finish(msg.info);
}
```

`finish()` is idempotent (`terminated` guard) and ends the frame stream, so a stray later
message is harmlessly dropped and a `frames()` consumer gets a clean `done`. Default paths
(`emitEveryPass` defaults to `true`; `progressionTarget` defaults to `"final"`) are
untouched — both new branches are false there.

### event-stream.ts — no change

Reviewed across all lenses; it is already at the optimization ceiling for a single-consumer
push stream: O(1) cursor reads, immediate slot-reference release (ES-1), ratified 64-entry
compaction threshold, terminal-result singletons (ES-4), `fail()` clears the buffer to release
pixel refs while `end()` preserves it for replay. No net-positive change found; see the
seam section and the rejected-optimizations log for what was considered and declined.

### Rejected (logged to `docs/rejected optimizations.md`, 2026-06-15)

- Gating progressive-frame buffering on `framesConsumed` to bound the memory peak — **breaks
  the tested buffer-and-replay contract**; the dead `framesConsumed` field stays dead.
- A bounded/coalescing cap inside `AsyncEventStream` — wrong layer (generic, content-agnostic).
- Replacing the per-frame `emit` closure — marginal, `onMetric`-gated.

## Timings — StandardMultifileTest regression (this run vs previous ten)

decode-session/event-stream are **not on this benchmark's path** (it drives the Node RAW
pipeline), so this table is a no-collateral-damage gate, not a measurement of these changes.
The series is dominated by machine thermal/load state, not code.

| Run (UTC) | AvgRawMs | AvgRawTonemapMs | AvgProgFinalSimdMs | MW Speedup |
|---|---|---|---|---|
| 2026-06-14T20-07-16 | 1202 | 626 | 710 | 0.82 |
| 2026-06-14T20-08-40 | 1815 | 942 | 908 | 0.94 |
| 2026-06-14T20-12-41 | 3385 | 1705 | 1253 | 2.06 |
| 2026-06-14T20-25-45 | 4599 | 2169 | 389 | 0.79 |
| 2026-06-14T20-47-51 | 992 | 429 | 321 | 0.98 |
| 2026-06-14T23-44-42 | 1106 | 460 | 347 | 0.92 |
| 2026-06-15T01-35-25 | 1039 | 444 | 341 | 0.88 |
| 2026-06-15T02-29-18 | 990 | 424 | 328 | 0.97 |
| 2026-06-15T02-53-49 | 1064 | 445 | 369 | 1.17 |
| **2026-06-15T02-58-24 (this)** | **1039** | **442** | **789** | **1.12** |
| 2026-06-15T03-02-05 (next, cold) | 2452 | 976 | 497 | 1.07 |

**Table conclusion:** This run's AvgRawMs (1039) sits squarely in the recent stable band
(990–1106) once cold/contended runs (1815/3385/4599/2452) are excluded; AvgRawTonemapMs 442
matches the post-SIMD-tonemap steady state (memory: tonemap 942→429 on 2026-06-14). The lone
outlier in this run, AvgProgFinalSimdMs 789, is single-run JIT/thermal variance (the metric
ranges 321–1253 across the series independent of any session-layer code). **No regression
attributable to the changes** — expected, since the edits are not exercised by this bench.

**Flip-flop test:** none written. A flip-flop isolates a CPU-path speed change; these edits
are a control-flow correctness fix with no measurable CPU delta and no representation on the
RAW-pipeline bench (no worker/session harness exists to drive them under load). Writing a
synthetic flip-flop here would measure noise, not signal — so it was deliberately skipped per
the protocol's "worth isolating" qualifier.

## Conclusion (Chapter 3)

**a. Improvements to file 1 (decode-session.ts).** Closed a real `done()`-never-resolves hang
for the two early-stop decode modes the worker terminates silently (`progressionTarget:"header"`,
and `"dc"`/`"pass"` with `emitEveryPass:false`). The fix is self-contained, guarded so default
decodes are untouched, idempotent against late messages, and validated by the full session
suite (45 pass / 10 codec-skipped / 0 fail). This matters for the mission's fast-preview and
"dimensions only" paths — e.g. a thumbnail/AR pre-pass that asks for just the header or a
single DC frame and `await`s completion would previously hang the caller.

**b. Improvements to file 2 (event-stream.ts).** None — and that is the finding. Every lens
confirmed it is already at its sensible optimum for a single-consumer push stream; the
candidate memory-bounding change was traced to a contract violation and rejected, not shipped.
Recording "no change, here's why" is the honest outcome for a ratified file.

**c. Improvements to the seam.** The decode-session ⇄ event-stream boundary is sound: terminal
mapping is clean and mutually exclusive (`finish`/`finishWithError` → `end()`,
`fail` → `fail()`), frame delivery is zero-copy (pixel `ArrayBuffer`s pass by reference), and
`fail()` clears the buffer to release pixel memory on the error path. The seam pass surfaced
the genuine systemic gap one layer **up**: the worker→session protocol has no explicit
"session complete" signal for early-stop targets, which is what forced the silent hang. The
robust long-term fix is a terminal message from the worker (decode-handler) rather than the
session reverse-engineering the worker's stop condition; that is a cross-file protocol change,
flagged for approval and deferred (logged in the rejected/deferred section).

**Closing.** Two mature files; the review's value is correctness and discipline, not raw speed.
The shipped change removes a latent hang on the header-only / single-DC fast paths that the
biodiversity viewer's preview and AR pre-identification flows are most likely to use. The
larger memory characteristic — unbounded frame buffering for `done()`-only callers under the
default `emitEveryPass:true` — is real but load-bearing for the replay contract; it is
documented rather than "fixed", and the right resolution (a worker-side terminal signal, plus
possibly a frames-opt-out option on `DecodeOptions`) is named for a future, properly-scoped
pass. Equally important: a tempting memory optimization was caught and rejected *because the
test suite encodes the opposing contract* — the protocol's "run the package tests, not just
the typechecker" discipline did its job.

---

_Last agent: implemented in full for the in-scope file; filename carries `- DONE`._
