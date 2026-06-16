# Encode Session / Types / Encode Session Test — Lens Review & Handoffs
## 19-lens review: encode-session.ts / types.ts / encode-session.test.ts

**Date:** 2026-06-11
**Companion doc:** `docs/EncodehandlerFacadeEncodestart.md` (encode-handler/facade/encode_start.json review, same series — cross-referenced below).
**Scope (exclusive):**
1. `packages/jxl-session/src/encode-session.ts`
2. `packages/jxl-core/src/types.ts`
3. `packages/jxl-session/test/encode-session.test.ts`

**Method:** 19-lens in-memory review (strategic, API surface, pipeline stages, state machinery, data structures, hot kernels, boundaries, support code, owl, reversal, astronomy, ML-recognition, gaming, photogrammetry, butteraugli, AR, non-Riemannian colour, gap analysis, bird's-eye). Findings amalgamated and de-duplicated; each handoff targets exactly one file.

**Layer invariants honoured (CLAUDE.md):** no backpressure/drain callbacks in the session, no batching in the session, budget stays session-level, no pixel pools, dedupe stays in scheduler. None of the items below violate the rejection log.

**types.ts spec constraint:** the file header says *"Do not add fields not present in the spec."* Every type addition in Agent 3's handoff is therefore a **spec amendment proposal** — implement only together with a dated `// SPEC AMENDMENT` note (or reject and log).

---

## Strategic overview (Lens 1)

```
caller ── EncodeOptions ──► encode-session.ts (EncodeSessionImpl)
                               │ maps EncodeOptions → MsgEncodeStart   ← the lossy hop (C1)
                               │ owns lifecycle FSM: live → finished → terminated
                               ▼
                            jxl-scheduler ── encode_start/pixels/finish ──► worker encode-handler
                               ▲
            chunks()/done()/getStats() ◄── encode_chunk/encode_done/metric/encode_error
```

types.ts is the contract both ends compile against; encode-session is the only translator. The companion review found the worker handler **reads** `progressiveFlavor`, `progressiveAc`, `qProgressiveAc` (among 12 fields) from `MsgEncodeStart` — this review finds the session **never sends** them. The two halves of the same wire are each correct in isolation and broken as a pair: options documented in types.ts, consumed by the handler, and dropped in the middle.

---

## Consolidated findings

### P0 — Bugs

**B1. `getStats()` computes wrong `originalBytes` for `"rgb8"`** (encode-session.ts:182).
The ternary ladder `format === "rgba8" ? 4 : format === "rgba16" ? 8 : 16` sends `"rgb8"` (3 channels × 1 byte) into the `rgbaf32` arm (16). `originalBytes` is 5.33× too large and `ratio` correspondingly wrong for the one format that exists specifically to skip the RGBA round-trip.

**B2. Completion metrics swallowed after `encode_done`** (encode-session.ts:211–248).
`handleMessage` begins with `if (this.terminated) return;`. `complete()` sets `terminated = true` when `encode_done` arrives. Any `metric` message the worker posts *after* `encode_done` (`time_to_final_ms`, `output_bytes`, `peak_memory_bytes` are naturally end-of-encode metrics) is silently dropped, so `onMetric` consumers (benchmarks, parity harnesses) under-report. The `metric` case must be evaluated before the terminated guard.

**B3. Pre-aborted signal still acquires a worker slot** (encode-session.ts:99–126).
The constructor calls `scheduler.acquireSlot(...)` at line 99 and only checks `signal.aborted` at line 122. A signal already aborted before construction spins up scheduler/pool work (possibly a worker prewarm) and then immediately cancels it. Check `opts.signal?.aborted` *before* `acquireSlot` and short-circuit to a terminated session without ever touching the scheduler.

### P1 — Contract gaps

**C1. ~15 documented `EncodeOptions` fields silently dropped** (encode-session.ts:63–91).
Never forwarded to `MsgEncodeStart`: `modular`, `brotliEffort`, `decodingSpeed`, `photonNoiseIso`, `progressiveFlavor`, `progressiveAc`, `qProgressiveAc`, `buffering`, `advancedControls`, `jpegReconstruction`, `alreadyDownsampled`, `upsamplingMode`, `ecResampling`, `frameIndexing`, `allowExpertOptions`. Confirmed consumer-side for three of them: the worker encode-handler reads `progressiveFlavor`/`progressiveAc`/`qProgressiveAc` off `MsgEncodeStart` (companion review, Lens 1 cross-file finding) — so for at least those, a caller setting the option gets default behaviour with no error and the handler code is dead. For each field: if the protocol already carries it, forward conditionally; if not, either extend the protocol type (documented closely-related edit) or throw `ConfigError("option X not supported")`. Silent dropping is the only forbidden outcome.

**C2. `centerX`/`centerY` mutual-exclusion validation missing** (encode-session.ts:87–88).
types.ts:180 documents "mutual-exclusion validation (error/warn if set without groupOrder=1)". The session forwards them unconditionally. Throw `ConfigError` in the constructor when `centerX != null || centerY != null` and `opts.groupOrder !== 1`.

**C3. No range validation on quality knobs** (constructor).
`distance < 0` or `> 25`, `quality` outside 0–100, `effort` 10/11 without `allowExpertOptions`, non-ascending or non-positive `sidecarSizes` — all pass through and surface later as opaque worker errors. Validate in the constructor, throw `ConfigError` synchronously (nothing acquired yet once B3 lands).

**C4. `pushPixels()` after terminal error resolves silently** (encode-session.ts:141,143).
After the awaits, `if (this.terminated || this.finished) return;` makes a push into a dead session look successful. A producer pumping RAW-decoded pixel bands keeps decoding and pushing — wasted upstream work (RAW decode is the cost centre, ~2475 ms). Store the terminal `JxlError` in `terminate()` and reject post-terminal pushes with it (post-`finished` silent return stays — benign). Contract tightening: note in `EncodeSession.pushPixels` JSDoc.

**C5. Encode has no `budgetMs`** (types.ts `EncodeOptions`).
Decode has session-level `budgetMs`; encode has none, so a runaway effort-9 encode on a background tab can never be time-bounded. Propose `budgetMs?: number` with **identical semantics to decode**: elapsed from session construction, single budget, no per-stage reset (standing rejection DH-5/DH6-5). Worker-side enforcement out of scope; type + forwarding in scope.

### P2 — Type hygiene (types.ts)

**T1. Inline `buffering` duplicates `BufferingControls`** (types.ts:196–202 vs 134–140). Field-for-field identical. Replace the inline literal with `buffering?: BufferingControls;`.

**T2. Two competing surfaces for the same knobs.** `advancedControls.groupOrder` (`GroupOrderControls`, `mode: "scanline" | "center"` + centerX/Y) vs top-level `groupOrder: 0 | 1` + `centerX`/`centerY`; `advancedControls.buffering` vs top-level `buffering`. Precedence undefined; the session forwards neither (C1). Document in JSDoc: **top-level wins; `advancedControls` is the escape hatch, ignored where a top-level equivalent is set.**

**T3. `effort?: 1|…|9` contradicts `allowExpertOptions`** (types.ts:154 vs 297–300, which documents "effort validation 1-11 only when true"). Widen to `1|…|11` with JSDoc "10–11 require `allowExpertOptions: true` (ConfigError otherwise)" — pairs with C3.

**T4. Quality/distance precedence documented only in a session comment** (encode-session.ts:55–57) where no API consumer sees it. Copy into JSDoc on `distance`/`quality`: "If both set, distance wins, quality ignored. If neither, distance defaults to 1.0."

**T5. `pushPixels` input asymmetry.** `DecodeSession.push` accepts `ArrayBuffer | Uint8Array`; `EncodeSession.pushPixels` accepts only `ArrayBuffer` and transfers (detaches) it without saying so. Widen to `ArrayBuffer | Uint8Array`, document the detach: "buffer is transferred to the worker and unusable afterwards; pass a copy to retain."

**T6. `"rgb8"` is encode-only but `DecodeOptions.format: PixelFormat` admits it.** Minimal non-breaking fix: JSDoc on `DecodeOptions.format` — `"rgb8" is encode-input only; decode requests yield ConfigError`. (Note: companion review's facade Agent proposes `EncodePixelFormat = PixelFormat | "rgb8"` at the facade layer — do not duplicate that split here; keep types.ts's `PixelFormat` as-is, doc-only.)

**T7. `DecodeFrameEvent.pixelStride` names a row stride.** Comment says "bytes per row"; name reads per-pixel. Renaming is breaking; strengthen the comment: `// row stride in BYTES (not pixels); may exceed width * channels * bpc/8 due to alignment`.

### P2 — Code hygiene (encode-session.ts)

**H1. `as any` casts unnecessary** (lines 83–84). With `!= null` guards TS narrows `opts.progressiveDc` to `0|1|2`; under `exactOptionalPropertyTypes` the conditional assignment type-checks without the cast (neighbouring `sidecarSizes`/`orientation` lines prove the pattern). Remove both; if they don't compile, the protocol type is missing the fields — fix the protocol type, not the cast.

**H2. Per-case `sessionId` checks** in `handleMessage`. Every case begins `if (msg.sessionId !== this.id) return;`. Hoist one check above the `switch` (covers `metric` too, simplifying B2's fix).

**H3. Misleading hidden-class comment** (lines 145–147). `...(region !== undefined ? { region } : {})` produces **two** object shapes, so the "single hidden class" claim is false. Fix the comment ("two stable shapes") or drop the spread; do not assign `region: undefined` (breaks exactOptionalPropertyTypes).

### Features (saliency / progressive — lenses 11–17)

**F1. `autoCenterFromExif?: boolean` on `EncodeOptions`.**
Biodiversity images put the specimen at the autofocus point. EXIF already travels through the session (`opts.exif`). When set with `groupOrder === 1` and no explicit centre, the worker derives `centerX/centerY` from the EXIF AF-point (falls back to image centre). In-scope work: one optional field in types.ts (spec amendment), one conditional forward in encode-session.ts. Worker-side EXIF parsing is a follow-up — forward, don't implement, here. Cheapest real saliency win: center-out ordering aimed at the subject means early progressive bytes contain the organism — exactly what AR live-ID and vision-model classification on partial downloads need.

**F2. `convergedByteEnd?: number` on `EncodeStats`.**
Ties into the ratified convergedByteEnd design (offline visual-saturation cutoff → manifest → stream-layer early abort, ~50% network savings; WASM measures only). The companion review's `ProgressiveConvergenceMeter` (facade Agent 5) produces the measurement; this side gives it a home: when `encode_done` carries a saturation offset, capture it next to `sidecarOffsets` and expose via `getStats()`. types.ts gains the optional field; encode-session gains a one-line capture mirroring the `sidecarOffsets` pattern.

**F3. Butteraugli cost note (lens 15).**
The expensive knobs already exist in these files (`disablePerceptualHeuristics`, `effort`, `decodingSpeed`); nothing structural to add. One doc item: JSDoc on `disablePerceptualHeuristics` should state the perf consequence ("skips butteraugli/XYB psychovisual pass; large encode-time win for tiny sidecar thumbnails where perceptual tuning is invisible").

**F4. Orientation / intrinsicSize round-trip (lens 14, photogrammetry).**
Encode can set `orientation` and `intrinsicSize`, but `ImageInfo` (decode side) exposes neither — a digital-twin pipeline cannot verify sensor-orientation passthrough. Spec amendment: `orientation?: 1|…|8` and `intrinsicSize?: { width; height }` on `ImageInfo`. Type-only here; decode-handler population is a follow-up.

### Explicitly rejected during this review (do not re-propose)

- Output-side chunk backpressure in the session — backpressure lives at the scheduler/worker boundary (CLAUDE.md invariant; AsyncEventStream buffering is out of scope).
- Per-stage budget for encode — standing rejection DH-5/DH6-5; C5 deliberately specifies session-level semantics.
- done()-watchdog/timeout in the session — worker-death detection is scheduler territory (`WorkerCrashed`).
- Saliency-map-driven per-region quality — libjxl has no per-region distance API; center-out group order (F1) is the honest version.
- Pixel buffer pool for pushPixels — transferred ArrayBuffers detach (R1-2/R2-2/DH-2).

### Gap analysis (lens 18) — the three unlit rooms

Not in scope for the agents below; next review targets:
1. **`MsgEncodeStart` in jxl-core protocol** — C1's resolution depends on its actual field inventory; the protocol file is the authority and was outside this scope.
2. **`AsyncEventStream` buffering semantics** — unbounded output queue behaviour under slow consumers was assumed, not verified.
3. **Worker `encode-handler` honouring of forwarded options** — partially illuminated by the companion review (it reads 12 fields), but the full set C1 forwards remains unverified end-to-end.

---

## Agent handoffs

Each agent touches **one file only**. If an item forces a change in a closely-related file (e.g. the protocol type for C1), make the minimal edit and document it in the PR description — do not expand beyond that. Five agents; Agents 1/2 share a file (run Agent 1 first), as do Agents 4/5.

---

### Agent 1 — `packages/jxl-session/src/encode-session.ts` (bugs + hygiene)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**Items: B1, B2, B3, H1, H2, H3.**

**B1 — fix bpp ladder in `getStats()`:**
```ts
const BPP: Record<PixelFormat, number> = { rgba8: 4, rgb8: 3, rgba16: 8, rgbaf32: 16 };
const originalBytes = this.opts.width * this.opts.height * BPP[this.opts.format];
```
(Hoist `BPP` to module scope; import the `PixelFormat` type.)

**B2 — let metrics through after termination.** Combined with H2:
```ts
private handleMessage(msg: WorkerToMainMessage): void {
  if (msg.sessionId !== this.id) return;
  if (msg.type === "metric") {
    // Deliberately NOT gated on this.terminated: completion metrics
    // (time_to_final_ms, output_bytes) arrive after encode_done.
    this.opts.onMetric?.(msg.metric);
    return;
  }
  if (this.terminated) return;
  switch (msg.type) { /* remaining cases, per-case sessionId checks removed */ }
}
```
Check whether every `WorkerToMainMessage` variant carries `sessionId`; if broadcast metrics make it optional, keep a narrowed guard for that case.

**B3 — short-circuit pre-aborted signal before `acquireSlot`.** Evaluate `opts.signal?.aborted` right after building `startMsg`; if aborted: set `terminated`, fail the stream, reject done() with `Cancelled`, set `acquirePromise = Promise.resolve()`, skip `onMessage` registration and `acquireSlot` entirely. Non-aborted listener path unchanged.

**H1** — delete both `(startMsg as any)` casts, use plain conditional assignment. If the compiler rejects it, the protocol type lacks the fields — add the optional fields to `MsgEncodeStart` (minimal documented closely-related edit) rather than restoring the cast.

**H3** — replace the comment on the `encode_pixels` spread with an accurate one (two stable shapes), or simplify to two explicit `send` calls. No behavioural change.

Verify: package tests in `packages/jxl-session` pass; B1/B2 gain failing-first tests from Agents 4–5.

---

### Agent 2 — `packages/jxl-session/src/encode-session.ts` (forwarding + validation; run after Agent 1)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**Items: C1, C2, C3, C4, C5-forwarding, F1-forwarding, F2-capture.**

**C1 — forward the dropped options.** First read `MsgEncodeStart` in jxl-core's protocol file. For each of `modular`, `brotliEffort`, `decodingSpeed`, `photonNoiseIso`, `progressiveFlavor`, `progressiveAc`, `qProgressiveAc`, `buffering`, `advancedControls`, `jpegReconstruction`, `alreadyDownsampled`, `upsamplingMode`, `ecResampling`, `frameIndexing`, `allowExpertOptions`:
- protocol has the field → conditional forward, same pattern as `orientation`:
  ```ts
  if (opts.modular != null) startMsg.modular = opts.modular;
  ```
- protocol lacks the field → add it as optional to `MsgEncodeStart` (documented closely-related edit) *if* the worker encode-handler consumes it (it does for `progressiveFlavor`/`progressiveAc`/`qProgressiveAc` — confirmed); otherwise throw `ConfigError` naming the unsupported option. Silent dropping is the only forbidden outcome.
- Also extend `encode_start.json` schema if you add protocol fields (the companion review's Agent 1 is already adding the progressive/saliency set — coordinate, don't duplicate).

**C2 — centre validation (constructor, before anything else):**
```ts
if ((opts.centerX != null || opts.centerY != null) && opts.groupOrder !== 1) {
  throw new JxlError("ConfigError", "centerX/centerY require groupOrder=1", { sessionId: this.id });
}
```

**C3 — range validation (constructor):** `distance` ∈ [0, 25]; `quality` ∈ [0, 100]; `effort` 10–11 only with `allowExpertOptions === true`; `sidecarSizes` strictly ascending positive integers. Throw `ConfigError` with the offending value in the message.

**C4 — reject post-terminal pushes.** In `terminate(err)`, store `this.terminalError = err`. In `pushPixels`, at both post-await re-checks: if `this.terminated && this.terminalError` → `throw this.terminalError`; the `finished` path keeps its silent return. Update method JSDoc.

**C5 — forward `budgetMs`** (after Agent 3 adds the type): `if (opts.budgetMs != null) startMsg.budgetMs = opts.budgetMs;` plus protocol optional field. Session-level semantics only.

**F1 — forward `autoCenterFromExif`** (after Agent 3): `if (opts.autoCenterFromExif === true) startMsg.autoCenterFromExif = true;` plus protocol optional field. Validation: requires `groupOrder === 1`; ConfigError otherwise (mirrors C2).

**F2 — capture convergedByteEnd:** in the `encode_done` case, next to `sidecarOffsets`:
```ts
if (msg.convergedByteEnd !== undefined) this.convergedByteEnd = msg.convergedByteEnd;
```
and spread into `getStats()` exactly like `sidecarOffsets`. If `encode_done` in the protocol lacks the field, add it as optional (documented).

---

### Agent 3 — `packages/jxl-core/src/types.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**Items: T1–T7, C5, F1, F2, F3-doc, F4.** All field additions are spec amendments — the file header forbids fields not in the spec, so place a `// SPEC AMENDMENT 2026-06-11: <one-line rationale>` comment above each addition.

**T1:**
```ts
buffering?: BufferingControls;
```
replacing the inline literal at lines 196–202 (keep the existing JSDoc).

**T2:** JSDoc on `advancedControls`: "Escape hatch. Where a top-level equivalent exists (`groupOrder`, `centerX/Y`, `buffering`), the top-level value wins and the `advancedControls` copy is ignored."

**T3:** `effort?: 1|2|3|4|5|6|7|8|9|10|11;` + JSDoc "10–11 require allowExpertOptions: true (ConfigError otherwise)".

**T4:** copy the precedence rule into JSDoc on `distance` and `quality`: "If both are set, `distance` wins and `quality` is ignored. If neither is set, distance defaults to 1.0."

**T5:** `pushPixels(chunk: ArrayBuffer | Uint8Array, region?: Region): Promise<void>;` + JSDoc documenting the transfer/detach. (encode-session already routes through `toTransferableBuffer`; verify it handles views — if not, note it for Agent 2.)

**T6:** JSDoc on `DecodeOptions.format`: `"rgb8" is encode-input only; decode requests yield ConfigError.`

**T7:** `pixelStride` comment → `// row stride in BYTES (not pixels); may exceed width * channels * bpc/8 due to alignment`.

**C5:** on `EncodeOptions`:
```ts
/**
 * Session-level encode budget in ms, elapsed from session construction —
 * identical semantics to DecodeOptions.budgetMs. Single budget; never
 * per-stage (see rejected optimizations DH-5).
 */
budgetMs?: number;
```

**F1:** on `EncodeOptions`:
```ts
/**
 * Derive centerX/centerY for center-out group ordering from the EXIF
 * autofocus point in `exif`. Requires groupOrder=1. Explicit centerX/centerY
 * take precedence. Falls back to image centre when no AF point is present.
 */
autoCenterFromExif?: boolean;
```

**F2:** on `EncodeStats`:
```ts
/**
 * Byte offset at which progressive refinement is visually saturated
 * (measured at encode time, e.g. via ProgressiveConvergenceMeter).
 * Clients may stop fetching here (~50% savings). Omitted when the build
 * does not measure convergence.
 */
convergedByteEnd?: number;
```

**F3:** extend the `disablePerceptualHeuristics` JSDoc with the perf note (skips butteraugli/XYB psychovisual pass; biggest win on small sidecar thumbnails).

**F4:** on `ImageInfo`:
```ts
orientation?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;  // EXIF orientation signalled in basic info
intrinsicSize?: { width: number; height: number }; // display-size override when signalled
```

Verify: `tsc` across packages importing jxl-core compiles (all additions optional → non-breaking).

---

### Agent 4 — `packages/jxl-session/test/encode-session.test.ts` (stats, errors, routing)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Add tests (follow existing `makeScheduler`/`waitForWorker`/`tick` patterns):

1. **getStats before done → null**; after `encode_done(totalBytes: 4096)` → `originalBytes === 64*48*4`, `compressedBytes === 4096`, correct `ratio`, no `sidecarOffsets` key.
2. **getStats rgb8 bpp** (catches B1): `format: "rgb8"` → `originalBytes === 64*48*3`. MUST fail against pre-Agent-1 code; if it passes before the fix, the test is wrong.
3. **sidecarOffsets passthrough:** `encode_done` with `sidecarOffsets: [100, 250]` → `getStats().sidecarOffsets` deep-equals `[100, 250]`.
4. **Both quality and distance given → distance wins:** `{ distance: 2.0, quality: 90 }` → `start.distance === 2.0 && start.quality === null`.
5. **Unknown error code normalizes to Internal:** `encode_error` with `code: "BananaError"` → `done()` rejects with `err.code === "Internal"`.
6. **Wrong-sessionId messages ignored:** emit `encode_done` with `sessionId: "other"` → `done()` still pending (assert via `Promise.race` with a tick), then emit the real one → resolves.
7. **encode_cancelled from worker:** → `done()` rejects `Cancelled`, `chunks()` iteration rejects.
8. **Acquire failure:** scheduler whose `acquireSlot` rejects → `done()` rejects with `code === "Internal"` and message containing "Failed to acquire worker". (Extend `test/helpers.ts` minimally if needed — documented closely-related edit.)
9. **Metric after encode_done still delivered** (catches B2): emit `encode_done`, then `metric { name: "time_to_final_ms" }` → appears in `seen`. MUST fail pre-Agent-1.

---

### Agent 5 — `packages/jxl-session/test/encode-session.test.ts` (abort, lifecycle, shape; run after Agent 4)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Add tests:

1. **Pre-aborted signal:** construct with an already-aborted `AbortController().signal` → `done()` rejects `Cancelled`; assert `acquireSlot` was never called (catches B3; needs a call-recording flag in helpers — documented closely-related edit).
2. **Abort mid-session:** abort after `waitForWorker` → `done()` rejects `Cancelled`, scheduler `cancelSession` called exactly once.
3. **cancel() after finish() is a no-op:** `finish()` → `cancel()` → emit `encode_chunk` + `encode_done` → chunks still iterate and `done()` resolves (pins the 007-logic-e5f6a7b8 behaviour).
4. **pushPixels transfers (detaches) the buffer:** after `await session.pushPixels(buf)`, `buf.byteLength === 0`.
5. **Optional-field shape on encode_start:** with no optional opts, assert `"orientation" in start === false`, same for `centerX`, `sidecarSizes`, `intrinsicSize`, `codestreamLevel`, `progressiveDc`, `groupOrder` (exactOptionalPropertyTypes shape guarantee). With `orientation: 6, groupOrder: 1, centerX: 10, centerY: 20, sidecarSizes: [256], intrinsicSize: {width: 32, height: 24}, codestreamLevel: 10, disablePerceptualHeuristics: true` → all present with exact values.
6. **centerX without groupOrder=1 → ConfigError** (after Agent 2's C2): constructor throws synchronously.
7. **Validation:** `distance: -1` → ConfigError; `quality: 150` → ConfigError; `sidecarSizes: [512, 256]` (descending) → ConfigError (after Agent 2's C3).
8. **pushPixels after terminal error rejects with that error** (after Agent 2's C4): emit `encode_error`, then `await assert.rejects(session.pushPixels(...), { code: "OutOfMemory" })`.

Tests 6–8 depend on Agent 2; if running before Agent 2 lands, mark them `it.todo`.

---

## What implementing this achieves

The two P0 bugs directly corrupt the project's measurement layer: every `rgb8` encode currently reports a compression ratio 5.3× better than reality, and every end-of-encode metric is silently discarded — meaning the benchmark and parity harnesses this repo leans on (effort sweeps, queue-wait parity with Tauri) have been partially blind on the encode side. Fixing B1/B2 plus the validation set (C2/C3) converts a class of "encode silently did the wrong thing" failures into immediate, named `ConfigError`s at the construction site, and C1 closes the larger credibility gap: roughly half of the documented `EncodeOptions` surface is currently decorative, including three progressive-control fields the worker handler demonstrably reads and never receives. After Agent 2, an option either works or refuses loudly — the property every downstream tool (pyramid ingest, sidecar ladders, JPEG transcode) implicitly assumes today.

The feature set is deliberately narrow and converges on progressive saliency. `autoCenterFromExif` aims libjxl's existing center-out group ordering at the autofocus point — for a biodiversity corpus, that is the specimen — so the first kilobytes of every progressive stream contain the organism rather than the top-left corner of background. Combined with `convergedByteEnd` surfacing in `EncodeStats` (the contract half of the companion review's `ProgressiveConvergenceMeter`, feeding the manifest-driven early-abort project) and the sidecar-offset machinery already in place, the platform gets a complete early-bytes story: thumbnails first, subject-centred refinement next, and a measured point at which the client stops pulling bytes entirely. That same property is precisely what real-time AR identification and vision-model classification over partial downloads need — useful pixels earliest, at no decode-side cost, using encoder capabilities that already exist.

Finally, the test additions (17 new cases) move encode-session from lifecycle-only coverage to contract coverage: stats correctness, abort paths, message-routing isolation, transfer semantics, and option-shape guarantees under `exactOptionalPropertyTypes`. Two of the new tests are designed to fail against today's code, which both proves the bugs and pins the fixes. The three unlit rooms named in the gap analysis — `MsgEncodeStart`'s actual field inventory, `AsyncEventStream`'s buffering bounds, and end-to-end option honouring in the worker handler — are the natural targets for the next lens pass, since every forwarding fix made here is only as real as the handler on the other end.
