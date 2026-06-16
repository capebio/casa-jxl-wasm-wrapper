# DecodeHandler.md — 26-Lens Review of `packages/jxl-worker-browser/src/decode-handler.ts`

Single-file deep review (decode session state machine: owns one libjxl decoder per
session, drives `feedDecoder`/`readDecoderEvents`, adaptive HWM backpressure, budget,
pause/resume, metric emission). File is rated 5/5 in CLAUDE.md and has been through many
passes, so the lenses below are filtered hard against the "Recurring False Claims" table
and against findings that are actually scoped to *this* file.

Each chapter is one implementation layer. A worker may own one chapter end-to-end.

Lens method: lenses 1–8 (structure/pipeline/state/data/kernels/boundaries/support),
9–21 (owl / reverse-film / astronomy / LLM-recog / gaming / photogrammetry / Butteraugli /
AR / non-Riemannian colour / gaps / pointer-tricks / defocus), 22–26 (SIMD / iterator
overhead / data-crossing duplication / intrinsics / math). Most of 11–17 are pixel-math /
colour lenses that land in `pipeline.rs`/`LookRenderer`, **not** this transport layer —
noted and dismissed in Chapter 5 rather than padded into fake findings.

---

## Chapter 1 — Queue state: collapse the mirror fields (single source of truth)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**Lenses 4, 5, 9, 21, 24.** `ChunkRing` already authoritatively tracks `size` and `bytes`.
The handler keeps two *parallel* mirror fields, `queueDepth` and `queuedBytes`, hand-updated
in `onChunk`, `takeNextChunk`, and `clearInputQueue`, and re-synced from `chunkQueue.bytes`
on every push/shift anyway:

```ts
this.queueDepth++;                       // onChunk
this.queuedBytes = this.chunkQueue.bytes;
...
this.queueDepth--;                       // takeNextChunk
this.queuedBytes = this.chunkQueue.bytes;
```

Two sources of truth for one quantity = a latent divergence bug for zero benefit. The
mirrors are read only in `onChunk` (overflow guard), `maybePostDrain`, and the `_drainMsg`
payload — all of which can read the ring directly.

**Fix:** delete both fields; read `this.chunkQueue.size` / `this.chunkQueue.bytes` at the
use sites. Removes 4 writes per chunk on the hottest ingestion path and eliminates the
divergence surface.

```ts
// onChunk overflow guard
if (this.chunkQueue.bytes + chunk.byteLength > MAX_QUEUED_BYTES) { ... }
this.chunkQueue.push(chunk);
this.wake();

// maybePostDrain
const drainAllowed =
  this.chunkQueue.size < hwm && this.chunkQueue.bytes < BYTE_DRAIN_HWM;
...
this._drainMsg.queueDepth  = this.chunkQueue.size;
this._drainMsg.queuedBytes = this.chunkQueue.bytes;

// clearInputQueue → just this.chunkQueue.clear();
// takeNextChunk   → just return this.chunkQueue.shift();
```

Getters are plain property returns; identical values, fewer writes, no divergence.

---

## Chapter 2 — ChunkRing: power-of-two index arithmetic

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**Lenses 6, 22, 26.** `ChunkRing` capacity is always a power of two (default 16, `grow()`
doubles). `push`/`shift`/`grow` advance the cursor with `% this.items.length`. On the
"many small chunks" path (CLAUDE.md test gap) this runs once per chunk — thousands of
integer modulo ops. With a guaranteed power-of-two capacity, `& mask` is exact and cheaper.

**Fix:** maintain a `mask = capacity - 1` field, updated in constructor and `grow()`:

```ts
private mask: number;
constructor(initialCapacity = 16) {       // invariant: power of two
  this.items = new Array(initialCapacity);
  this.mask = initialCapacity - 1;
}
push(chunk) { ...; this.tail = (this.tail + 1) & this.mask; ... }
shift()     { ...; this.head = (this.head + 1) & this.mask; ... }
private grow() {
  const cap = this.items.length * 2;
  const next = new Array(cap);
  for (let i = 0; i < this.length; i++) next[i] = this.items[(this.head + i) & this.mask];
  this.items = next; this.head = 0; this.tail = this.length; this.mask = cap - 1;
}
```

Marginal in absolute terms (dwarfed by `decoder.push()` WASM time) but free and correct.

---

## Chapter 3 — Worker→main metric chatter on the per-frame fast path

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**Lenses 2, 7, 18.** Every progress/final frame fires 2 extra `postMessage` calls for
`copy_to_transfer_ms` and `copied_bytes`. In the dominant **zero-copy** case
(`toTransferablePixels` returns `copied:false`) these report `0` and `~0` — two structured
clones + two worker→main hops per pass, for no information. On a 20-pass progressive decode
that is ~40 useless cross-thread messages.

`_metricMsg` reuse already removes the *alloc*; it cannot remove the clone+hop, which is the
real cost.

**Fix (self-contained, no protocol change):** keep updating `copyLatencyEma` always (it
feeds `adaptiveHwm`), but only *post* the two copy metrics when a copy actually happened:

```ts
const transfer = toTransferablePixels(event.pixels);
const tToArray = performance.now() - t0;
this.copyLatencyEma = HWM_EMA_ALPHA * tToArray + (1 - HWM_EMA_ALPHA) * this.copyLatencyEma;
if (transfer.copied) {
  this.postMetric("copy_to_transfer_ms", tToArray);
  this.postMetric("copied_bytes", transfer.buffer.byteLength);
}
```

Apply in the `progress`, `final`, and `budget_exceeded` event arms. Telemetry that sums
`copied_bytes` is unaffected (a missing sample == 0 copied). Absence of a metric on the
zero-copy path is the correct signal.

**Deferred (needs connected files — protocol + main-thread consumer):** fold the remaining
per-frame metrics directly into `MsgDecodeProgress`/`MsgDecodeFinal` as optional numeric
fields, deleting the separate metric messages entirely. Eliminates *all* per-frame metric
hops, but requires editing `@casabio/jxl-core/protocol` and the main-thread metric
aggregator. Higher blast radius — leave to a protocol-owning pass; do **not** bundle with
the self-contained fix above.

---

## Chapter 4 — Budget-exceeded must deliver the partial frame, not an empty buffer

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**Lenses 3, 4, 10.** Critical contract (CLAUDE.md): *"decode_budget_exceeded: frame stream
ends gracefully so consumers receive the partial frame."* The `progress` and `final` arms
violate this on the **first** budget check. They check budget *before* copying and, if over,
send `new ArrayBuffer(0)` — discarding `event.pixels`, which already holds a usable partial:

```ts
if (this.checkBudget()) {
  this.postMetric("dropped_due_to_budget", 1);
  this.postBudgetExceeded(event.stage, event.info, new ArrayBuffer(0), ...); // ← empty!
  return;
}
const transfer = toTransferablePixels(event.pixels);
...
if (this.checkBudget()) { /* second check, this one sends real pixels */ }
```

So if the session crosses its budget exactly when a progress event arrives (a common race —
the budget is wall-clock from construction), the consumer gets **zero pixels** instead of
the partial it is contractually promised. The second check exists only to handle "budget
crossed *during* the copy"; the two-check structure also costs a redundant `checkBudget()`
and a throwaway `new ArrayBuffer(0)` allocation.

**Fix:** copy first, then a *single* budget check that ships the real `transfer.buffer`.
The copy is never wasted — if over budget, those pixels are delivered as the partial.

```ts
case "progress": {
  this.state = "progressive";
  const t0 = performance.now();
  const transfer = toTransferablePixels(event.pixels);
  const tToArray = performance.now() - t0;
  this.copyLatencyEma = HWM_EMA_ALPHA * tToArray + (1 - HWM_EMA_ALPHA) * this.copyLatencyEma;
  if (transfer.copied) {
    this.postMetric("copy_to_transfer_ms", tToArray);
    this.postMetric("copied_bytes", transfer.buffer.byteLength);
  }
  if (this.checkBudget()) {
    this.postMetric("dropped_due_to_budget", 1);
    this.postBudgetExceeded(event.stage, event.info, transfer.buffer,
      event.format, event.pixelStride, event.region);
    return;
  }
  const msg: MsgDecodeProgress = { ...pixels: transfer.buffer... };
  ...
  self.postMessage(msg, [transfer.buffer]);
  this.postFirstPixelMetric();
  if (this.opts.progressionTarget !== "final" && !this.opts.emitEveryPass) {
    this.finishSession("final"); return;
  }
  break;
}
```

Same collapse for the `final` arm. Net: one budget check instead of two, no
`new ArrayBuffer(0)` allocation, and the contractually-required partial frame actually
reaches the consumer. `postBudgetExceeded` already reads `pixels.byteLength` (for
`output_bytes`) before transferring, so it reports the real partial size.

> Note: do **not** try to share a single module-level `EMPTY_BUFFER` for the old empty path
> — `postMessage(msg,[pixels])` *detaches* it (same class as the rejected pixel-pool); this
> fix removes the empty path entirely instead.

---

## Chapter 5 — Deferred / dismissed (record decisions, don't churn)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- **Redundant `cancelled` boolean (Lens 4).** Read only in the `onCancel` re-entry guard;
  `onCancel` runs synchronously through `finishSession()` (which sets `ended`) with no await
  before it, so `this.ended` alone guards re-entry. Removable, but zero perf value and a
  nonzero "did I miss a reader" risk — leave it; documented here so it isn't re-flagged.
- **Pass/byte telemetry for `convergedByteEnd`/qualityCurve (Lens 14, project memory).**
  A `passOrdinal`/per-pass-bytes metric would help the offline quality-curve work, but it's
  additive telemetry touching consumers — out of scope for a surgical pass.
- **Test gaps (Lens 8, CLAUDE.md).** Add under `packages/jxl-worker-browser/test/`: cancel
  while paused; cancel during active `push()`; budget exceeded before first progress →
  partial (now non-empty, see Ch.4); `budgetMs == null`; many small chunks → coalesced
  `worker_drain` under `BYTE_DRAIN_HWM`; `DRAIN_MIN_INTERVAL_MS` anti-spam. Separate files,
  not this one.
- **Colour/SIMD/Butteraugli/AR/photogrammetry lenses (11–17, 22, 25).** This file carries no
  pixel loops — the single "loop" is one `decoder.push()` WASM call per chunk. SIMD,
  intrinsics, non-Riemannian colour and Butteraugli all belong to `pipeline.rs` /
  `LookRenderer` / the perceptual kernel, not the transport layer. No work here.
- **Drain callback / pixel pool / per-stage budget reset / batch in handler** — all in the
  "Reject on Sight" table (R1-1/2, DH-2/4/5/6). Not proposed.

---

## Overview — what implementing Chapters 1–4 achieves

The four implemented chapters are deliberately the subset that is **self-contained to this
file and net-positive with no protocol blast radius**. Chapter 4 is the only behavioural
change, and it moves behaviour *toward* the documented contract rather than away from it:
under a budget race the consumer now receives the partial frame it is promised instead of a
silently-empty buffer — directly relevant to the progressive/pyramid lightbox and to any
ML/AR consumer that wants "best available pixels by deadline T."

Chapters 1–3 are pure efficiency and robustness. Collapsing the mirror queue fields removes
a whole class of "the two counters drifted" bugs and trims four writes from every ingested
chunk; the power-of-two index arithmetic removes a modulo from each enqueue/dequeue; and
gating the copy metrics removes two cross-thread `postMessage` hops per frame on the
dominant zero-copy path — on a deep progressive decode that is tens of saved structured
clones and thread hops, money straight back into the paint budget the byte-benchmark
measures.

None of this touches the scheduler/worker backpressure boundary, the dedupe registry, or
the budget *semantics* (still session-level wall-clock from construction). The deferred
items (fold metrics into the frame protocol; pass-level telemetry; the test matrix) are
listed so a protocol-owning or test-owning pass can pick them up with full context, without
contaminating this surgical change.

---

## Implemented

Surgical pass on `packages/jxl-worker-browser/src/decode-handler.ts` (2026-06-14). No
connected files needed editing — every implemented item is self-contained to this file.
Package typecheck (`tsc --noEmit -p tsconfig.json`) clean; `StandardMultifileTest.mjs` ran
to completion with no regression (that test drives the Node RAW pipeline, not this browser
worker, so its timings are the unchanged baseline — used here only as a no-collateral-damage
gate).

- **Ch.1 — queue mirror fields collapsed (DONE).** Deleted `queueDepth` and `queuedBytes`
  fields. `onChunk` overflow guard, `maybePostDrain`, `clearInputQueue`, `takeNextChunk`,
  and `_drainMsg` payload now read `chunkQueue.size` / `chunkQueue.bytes` directly. Single
  source of truth; four fewer writes per ingested chunk; divergence bug class removed.
  `_drainMsg.queueDepth/.queuedBytes` (the protocol message fields) are unchanged — they are
  now sourced from the ring.
- **Ch.2 — ChunkRing power-of-two index arithmetic (DONE).** Added `mask` field (maintained
  in constructor and `grow()`); `push`/`shift`/`grow` use `& this.mask` instead of
  `% this.items.length`. Documented the power-of-two capacity invariant.
- **Ch.3 — copy-metric gating (DONE).** `copy_to_transfer_ms` and `copied_bytes` are now
  posted only when `transfer.copied` is true, in the `progress`, `final`, and
  `budget_exceeded` arms. `copyLatencyEma` still updates unconditionally (it feeds
  `adaptiveHwm`). Removes two worker→main `postMessage` hops per frame on the dominant
  zero-copy path.
- **Ch.4 — budget-exceeded delivers the partial frame (DONE).** `progress` and `final` arms
  now copy first, then do a single budget check that ships the real `transfer.buffer` via
  `postBudgetExceeded`. Removed the early `new ArrayBuffer(0)` path (which silently dropped
  an available partial under a budget race), a redundant second `checkBudget()`, and the
  throwaway empty-buffer allocation. Now satisfies the `decode_budget_exceeded` contract on
  the first-check race.
- **Ch.5 — deferred as planned.** `cancelled`-flag removal, pass-level telemetry, the
  protocol-folding of per-frame metrics, and the test matrix were intentionally NOT done in
  this surgical pass (out of scope / blast radius / separate files). Nothing rejected to
  `rejected optimizations.md` this round — no proposed item was found net-negative.

---

## Round 2 — deeper pass (Opus xhigh, re-run of all 26 lenses on post-round-1 state)

Second pass over the *current* file. Re-audited the async core (wake/wakeResume,
`waitForChunk` lost-wakeup window, `Promise.all([feedDecoder, readDecoderEvents])` settle/
hang ordering, pause↔terminal interleavings, queue-clear vs `takeNextChunk` racing) — all
correct; the single-threaded "sync between awaits" invariant holds, no lost-wakeup, no hang.
Round-1 wins re-verified; Ch.4's copy-before-budget delivers the partial and the copy is
never wasted.

### Ch.6 — SharedArrayBuffer transfer crash in `toTransferablePixels` (IMPLEMENTED)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**Lenses 7, 10, 24 + project memory (warm pool / 16-bit parallel / SIMD-MT builds use SAB).**
The zero-copy path returned `value.buffer` for a full-view `Uint8Array`. On threaded WASM
builds the pixel view can sit over a **SharedArrayBuffer**; `self.postMessage(msg, [buffer])`
then throws (`SharedArrayBuffer cannot be transferred`) → `failSession("Internal")` on what
should be a successful decode. Latent because no browser/worker test exercises this file
(StandardMultifileTest drives the Node RAW pipeline, not this handler), so it would only
surface on a real COOP/COEP threaded deployment.

**Fix (implemented):** detect a SAB-backed view and copy its bytes into a fresh, transferable
`ArrayBuffer` via `value.slice()` (which allocates a non-shared buffer):

```ts
const buf = value.buffer;
if (typeof SharedArrayBuffer !== "undefined" && buf instanceof SharedArrayBuffer) {
  return { buffer: value.slice().buffer as ArrayBuffer, copied: true };
}
```

Covers `toTransferablePixels` and `toArrayBuffer` (error-arm partials, which delegate). Cost:
one extra `instanceof` on the slow (non-`ArrayBuffer`) path; zero cost when SAB is unused.

### Round-2 observations (recorded, NOT implemented — judgment calls for owners)

- **Trailing frames after `decode_paused` (Lens 4, 13).** `readDecoderEvents` checks only
  `isTerminal()`, not `paused`. A `push()` already in flight when `onPause` arrives runs to
  completion (WASM is synchronous), and its buffered progressive events are posted *after* the
  `decode_paused` ack. Mirrors the sibling node-worker P0 ("pause ignored mid-drain"). Two
  valid readings: (a) intended — pause stops *feeding*, already-produced output flushes; (b)
  bug — emission should hold while paused. Holding means dropping (data loss) or buffering
  (memory + complexity), both changing the "no soft-yield" contract, so NOT changed here.
  **Scheduler owner should confirm which semantics it relies on.**
- **`progress`/`final` arm duplication (Lens 8, 18).** The ~10-line optional-frame-field copy
  block and the copy+EMA+budget preamble are near-identical across the two arms — the exact
  duplication that forced Ch.4 to be applied twice. A shared `assignFrameMeta(msg, event)`
  helper would remove the drift hazard. Left out: pure refactor (no bug/perf) and typing one
  helper across the progress/final event union adds friction. Flagged for a dedicated pass.
- **Pause does not gate `onChunk` (Lens 5).** Chunks keep enqueuing while paused (to the
  128 MiB `MAX_QUEUED_BYTES` cap). Safe in practice (the scheduler that paused also stops
  sending) and the cap bounds buggy callers. No change.

### Implemented (Round 2 addendum)

- **Ch.6 SAB transfer guard — DONE.** `toTransferablePixels` copies SharedArrayBuffer-backed
  views into a transferable `ArrayBuffer`. Package typecheck clean; no StandardMultifileTest
  regression (out of that test's path; run only as a no-collateral-damage gate).

---

## Round 3 — metric fold + protocol seam pass (decode-handler.ts ⨯ jxl-core/protocol.ts)

Scope widened on request to the decode-handler ⇄ protocol interchange (plus the two
connected consumers the fold crosses: `jxl-session/src/decode-session.ts` and the handler's
own unit test). Three lens passes were run: (1) decode-handler post-fold, (2) a second
decode-handler pass, (3) a combined decode-handler ⨯ protocol pass focused on seams /
interchanges. Validated end-to-end: worker-browser **28/28**, jxl-session **45 pass / 10
codec-skipped**, jxl-scheduler **40/40**.

### Ch.7 — Fold per-frame metrics onto the frame (IMPLEMENTED)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**Lenses 2, 7 (boundary IPC).** On the copy path (sub-view / tiled-ROI decodes,
`copied=true`) every progress/final frame fired 2–3 extra `postMessage` metric IPCs
(`copy_to_transfer_ms`, `copied_bytes`, first-pixel). Each is a structured clone + worker→
main hop carrying one number. Protocol already established the fold pattern on
`MsgDecodeFinal` (`outputBytes`/`timeToFinalMs`/`timeToFirstPixelMs`, "avoids a separate
metric IPC") — so this extends it rather than inventing it.

Implemented across four files:
- **protocol.ts** — added folded fields `copyMs` / `copiedBytes` / `timeToFirstPixelMs` to
  `MsgDecodeProgress`, and `copyMs` / `copiedBytes` to `MsgDecodeFinal`; documented the
  field→CodecMetric name mapping on both.
- **decode-handler.ts** — normal progress/final paths now set `msg.copyMs` / `msg.copiedBytes`
  (when copied) and `msg.timeToFirstPixelMs` (first frame) instead of posting separate metric
  messages; removed the now-dead `postFirstPixelMetric()` method. Copy-path progress dropped
  from ~4 `postMessage`s/frame to **1**.
- **decode-session.ts** — new `emitFoldedMetrics()` re-emits each present folded field through
  `onMetric` as the matching `CodecMetric`, so telemetry consumers are unchanged. Additive and
  guarded (`!== undefined`) → a Node worker that still posts separate metrics, or a zero-copy
  frame, emits nothing extra.
- **handlers.test.ts** — the transfer-copy test now asserts the folded `copyMs`/`copiedBytes`
  frame fields instead of separate metric messages.

### Ch.8 — Dead-fold seam fix: `output_bytes` / `time_to_final_ms` never reached `onMetric` (IMPLEMENTED)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**Lenses 18, 24 (combined seam).** `MsgDecodeFinal` already carried `outputBytes` and
`timeToFinalMs` (and a folded `timeToFirstPixelMs`), but `decode-session`'s `decode_final`
handler read only pixels/info/format/stride/region — it **never re-emitted them**. The
facade emits none of these (verified: it only emits region/scale/area metrics), so they were
simply dropped at the session boundary. `emitFoldedMetrics()` (Ch.7) now re-emits them →
`output_bytes` and `time_to_final_ms` reach `onMetric` on the normal final path for the first
time, matching the budget path which always emitted `output_bytes`. Net telemetry is *more*
complete with *fewer* IPCs. Cross-worker double-count ruled out: the Node handler posts
`time_to_final_ms` as a separate metric and sets no folded fields, so the guarded re-emit
never fires for it.

### Ch.9 — Shared `DecodeFrameMeta` base + `assignFrameMeta` helper (IMPLEMENTED)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**Lenses 5, 8, 18 (combined seam).** `MsgDecodeProgress` and `MsgDecodeFinal` duplicated the
same 10 frame-metadata optionals (`region`…`animTicksPerSecond`) — the type-level twin of the
handler's two identical assignment blocks, the exact duplication that let the budget bug
(below) land in one arm and need fixing in both. Extracted `DecodeFrameMeta` in protocol.ts;
both messages now `extends` it (structural typing → all consumers unaffected, confirmed by
the three green suites). decode-handler.ts gains an `assignFrameMeta(msg, src)` helper
(source typed `?: T | undefined` to accept the decoder event under
`exactOptionalPropertyTypes`); both arms collapsed from 10 lines to one call.

### Ch.4 CORRECTION — reverted the round-1 budget change (it was wrong)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Round 1 "fixed" the budget check by collapsing the two checks into one copy-first check,
claiming the empty-buffer path dropped a usable partial. **That was a regression.** The unit
test `decode handler checks budget before touching progress pixels` models `event.pixels` as a
throwing getter and asserts an *empty* `decode_budget_exceeded` payload: the original design
deliberately uses a **lazy first check** — if budget is already blown when a progress/final
event arrives, exit *without materializing pixels* (the getter/copy can be costly), emitting an
empty marker; the consumer keeps its last in-budget frame. The second check (after the copy)
sends the already-copied pixels only when budget is crossed *during* the copy, so that work is
never wasted. Round 1 never ran the handler unit tests (only `tsc` + StandardMultifileTest,
which doesn't exercise this file), so the break went unnoticed. Both arms are now restored to
the intentional two-check pattern, with this round's fold applied on the normal path. Lesson
recorded: run `npm test` for the package, not just `tsc`.

### Round-3 observations (recorded, not implemented)

- **`time_to_header_ms` still a separate metric.** Could fold into `MsgDecodeHeader`, but it's
  once-per-session (not per-frame), the protocol has no header timing field, and a unit test
  asserts it as a metric. Out of the per-frame scope; low value.
- **Browser/Node fold asymmetry.** Browser folds; Node still posts separate metrics. Both
  deliver identical `CodecMetric`s to `onMetric` (Node just with more IPCs). Folding the Node
  handler is a clean follow-up in its own package — deliberately not touched here.
- **`emitFoldedMetrics` allocates one closure/frame** — only when `onMetric` is set (absent in
  production; present in benchmarks/parity). Dwarfed by the pixel structured-clone. Left for
  clarity.

### Implemented (Round 3 addendum)

- **Ch.7 metric fold — DONE** (protocol.ts, decode-handler.ts, decode-session.ts,
  handlers.test.ts). Copy-path progress: ~4 → 1 `postMessage`/frame.
- **Ch.8 dead-fold seam — DONE.** `output_bytes` / `time_to_final_ms` / folded
  `time_to_first_pixel_ms` now re-emitted to `onMetric` by the session.
- **Ch.9 `DecodeFrameMeta` base + `assignFrameMeta` — DONE.** Protocol and handler de-duped.
- **Ch.4 reverted — DONE.** Lazy two-check budget restored; the breaking unit test passes.
- Round-1 (queue consolidation, ChunkRing bitmask) and Round-2 (SAB transfer guard) changes
  remain in place and re-verified.
- Tests: worker-browser 28/28, jxl-session 45 pass / 10 skipped, jxl-scheduler 40/40. jxl-core
  rebuilt so consumers see the new protocol fields.

**Final agent:** implemented in full for the in-scope chapters (rounds 1–3) across
decode-handler.ts + jxl-core/protocol.ts and the two connected consumers (decode-session.ts,
handlers.test.ts); the document filename already carries the `-DONE` suffix.
