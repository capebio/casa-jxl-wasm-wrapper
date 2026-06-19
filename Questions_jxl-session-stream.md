# QUESTIONS — jxl-session & jxl-stream (session lifecycle, streaming I/O)

**Source:** EpicCodeReview 20260617T202430Z (Section 010 jxl-session, Section 012 jxl-stream)

## Scope
This file consolidates deferred findings for **session abstraction and streaming I/O**:
- `packages/jxl-session/src/decode-session.ts` — DecodeSession, slot acquisition, frame events, budget
- `packages/jxl-session/src/encode-session.ts` — EncodeSession, options forwarding, lifecycle
- `packages/jxl-stream/src/browser.ts` — ReadableStream wrapping, range negotiation, abort handling
- `packages/jxl-stream/src/node.ts` — Node.js fs/http readable wrapping (out-of-scope this review, but affected)
- Cross-concerns: abort signaling, backpressure, progressive decode bounds

## Handoff Strategy
**Subagent type:** General (session lifecycle + I/O protocols)  
**Model:** Sonnet (async/streaming reasoning)  
**Effort:** Medium (several cross-file coordination items; mostly deferral verification)

---

## CATEGORY A: Encode-Session Options Forwarding

### A1 — ~12 EncodeOptions fields missing wire representation (encode-session.ts + protocol.ts)
**Finding:** Same as jxl-core-protocol.md § A1 — `modular`, `brotliEffort`, `decodingSpeed`, etc. have no `MsgEncodeStart` wire field.

**Current state:** Open-coded field copy in encode-session.ts:65–96; no exhaustiveness guard.

**Suggested patch:** Coordinate with jxl-core fix (A1 in that file):
1. Add optional fields to MsgEncodeStart in jxl-core/protocol.ts.
2. Extract `buildEncodeStart(id, opts): MsgEncodeStart` mapper with exhaustiveness test.
3. Call mapper in encode-session.ts constructor.

**Effort:** Part of jxl-core coordination (1–2h for session-side changes).

**Verifier note:** This finding was flagged as 010-contracts-7a1c0e22-0002 + 010-logic-7a1c9e02-0003 (cross-package).

**ADR draft:** Shares `.epiccodereview/20260617T202430Z/sections/002/adr_draft/encode-options-normalization-utility.md` with jxl-core.

### A2 — No shared EncodeOptions→MsgEncodeStart mapper (encode-session.ts:65–96)
**Finding:** Projection is open-coded with mixed literal and ad-hoc conditional assigns; no exhaustiveness check.

**Current state:** Not yet extracted.

**Suggested patch:** Extract `buildEncodeStart(id, opts): MsgEncodeStart` with:
- One-line per forwarded field (clear coverage).
- Unit test enumerating every EncodeOptions key (catch drift).

**Effort:** 1h (extraction + test).

**Related:** A1 (needs wire fields first).

---

## CATEGORY B: Decode-Session Lifecycle & Abort Ordering

### B1 — Abort-order asymmetry: acquire before pre-aborted check (encode-session.ts:111–136)
**Status:** DEFERRED 010-logic-7a1c9e02-0005 + 010-errors-c9d0e1f2-0009

**Finding:** On sync scheduler path, `initAcquire` runs before pre-aborted check (line 135). DecodeSessionImpl checks `abortSignal.aborted` FIRST.

**Current state:** Partially fixed (if statement added to cover async path). Sync path may still race.

**Suggested patch:**
1. Reorder: abort check runs BEFORE `isPromiseLike` branch.
2. In pre-aborted case, assign `acquirePromise = Promise.resolve()`.
3. Match DecodeSessionImpl pattern (decode-session.ts:87–92).

**Effort:** 1h (reorder + careful initialization).

**Risk:** Low (guard added in "Fix 2" but scope was async only).

### B2 — makeFrame conditional-spread allocates per-field object (decode-session.ts ~222–238)
**Status:** DEFERRED DS-SPREAD-01

**Finding:** Each `...(field !== undefined ? { field } : {})` spread creates temporary object (~9 per frame).

**Current state:** Not yet optimized.

**Suggested patch:** Build base object, iterate `FRAME_META_KEYS` array, assign each key when defined.

**Effort:** 0.5h (micro-optimization).

**Note:** Frame rate is low (<30fps); negligible in profiling. Low priority.

---

## CATEGORY C: Budget & Frame Metadata

### C1 — decode_budget_exceeded missing 8/9 DecodeFrameMeta fields (protocol.ts + decode-handler.ts)
**Status:** DEFERRED DS-BUDGETEXCEEDED-META-01

**Finding:** `MsgDecodeBudgetExceeded` only carries `region?`; missing `sourceScale`, `progressiveSequence`, `passOrdinal`, `frameIndex`, `frameDuration`, `frameName`, `animTicksPerSecond`, `progressiveRegion`, `regionFallback`.

**Current state:** Not yet extended.

**Related:** jxl-core-protocol.md § A4 (DecodeFrameMeta fields dropped).

**Suggested patch:**
1. Change `MsgDecodeBudgetExceeded` to extend `DecodeFrameMeta` in protocol.ts.
2. Update decode-handler.ts `postBudgetExceeded()` to call `assignFrameMeta(msg, state)` (same pattern as decode_progress/decode_final).

**Effort:** 1h (cross-package: protocol + handler).

---

## CATEGORY D: Stream Lifecycle & Abort Contracts

### D1 — fromNodeReadable vs fromReadableStream abort contract divergence (node.ts vs browser.ts)
**Status:** DEFERRED 012-contracts-abort (HIGH priority, needs product decision)

**Finding:**
- **Node:** On mid-stream abort, exits loop, then falls through to abort check and **returns** byte count (partial delivery).
- **Browser:** Throws `DOMException('Aborted', 'AbortError')` → caller receives rejection.

**Question:** Which is canonical?

**Option 1: Reject with AbortError (matches web convention)**
- Browser `fromReadableStream` behavior.
- Callers must catch to read partial `delivered`.
- Partial count is lost unless surfaced via error property.

**Option 2: Resolve with partial count (Node-friendly)**
- Current Node behavior.
- Callers check `signal.aborted` after await.
- Partial bytes visible in return value.

**Current state:** Divergent; mechanical teardown bugs (racy onAbort, inconsistent abort-check position) fixed in Section 012. Contract decision still pending.

**Decision needed:** Product/architecture call. Once decided:
1. Implement consistent behavior in both `fromNodeReadable` and `fromReadableStream`.
2. Update CLAUDE.md stream-layer contract docs.
3. Add parity test asserting identical outcomes (see D2 below).

**Effort:** 2–3h (depends on choice).

**ADR draft:** Implicit in verifier notes (see `012-contracts-abort` in QUESTIONS.md).

### D2 — No cross-impl parity test (test/node.test.ts)
**Status:** DEFERRED 012-contracts-c4517f9a (test-file edit)

**Finding:** No parity table asserting identical `(delivered, pushes[], closed, cancelled, resolve-vs-reject)` outcomes across `fromNodeReadable` and `fromReadableStream`.

**Suggested patch:** Add comprehensive test after deciding the abort contract (D1).

**Effort:** 2h (once contract is decided).

### D3 — prefetch-overlap regression test (test/node.test.ts)
**Status:** DEFERRED 012-performance-3c1a9d42 (test-file edit)

**Finding:** No test for one-ahead prefetch-overlap invariant (whether `reader.read()`/`it.next()` is already dispatched while `push()` is blocked).

**Suggested patch:** Use a session whose `push()` defers; flag records whether next `read()` was already dispatched.

**Effort:** 1.5h (once contract is decided).

### D4 — 200-fallback-short-resource test (test/range.test.ts)
**Status:** DEFERRED 012-contracts-9f2a1b6d (test-file edit)

**Finding:** No test for 200 response whose body ends DURING skip phase (resource shorter than `start`).

**Suggested patch:** Assert `RangeNegotiation.underDelivered === true` and `delivered === 0`.

**Effort:** 1h.

### D5 — Round-trip resume-window invariant test (test/range.test.ts)
**Status:** DEFERRED 012-logic-e81b3f57 (test-file edit)

**Finding:** No property test for `createByteRangeResumeState` + resume reconstructing exactly `[start+delivered, endExclusive)` with no gap/overlap.

**Suggested patch:** Generative test including DEFAULT path (originalStart omitted, absoluteStart threaded).

**Effort:** 2h.

### D6 — Resume-200-no-ETag failure test (test/range.test.ts)
**Status:** DEFERRED 012-logic-4a7d2c81 (test-file edit)

**Finding:** No test: resume + 200 fallback + NO ETag header must fail (version-skew guard hole).

**Suggested patch:** Assert any 200 fallback while resuming rejects with `/resource changed/`.

**Effort:** 0.5h.

---

## CATEGORY E: Node.js Implementation (out-of-scope this review; cross-ref only)

### E1 — fromNodeReadable abort parity & teardown (node.ts)
**Status:** DEFERRED 012-contracts-7d3f1a02 + related (5 items, out-of-scope)

**Issues:**
- (a) Abort resolve vs reject divergence (tie to D1 decision).
- (b) Abort check happens AFTER await + BEFORE push (order differs from browser).
- (c) `onAbort` destroys readable + cancels session concurrently; aborted-break path cancels again (double-cancel).
- (d) `toNodeReadable` generator `finally` and `'close'` handler both fire `session.cancel()`.
- (e) `readable.destroy(new Error('Aborted'))` surfaces unhandled `'error'` event.

**Suggested:** Mirror browser fixes (idempotent single-cancel flag) + decide abort contract (D1) + use `destroy()` with no error on abort.

**Effort:** 3h (once D1 is decided).

**Note:** Out of scope for this session since node.ts was not in the review target.

---

## CATEGORY F: Architecture Decisions (ADR-worthy)

### F1 — Early-complete session cancellation (decode-session.ts)
**Status:** DEFERRED DS-SINGLEPASS-SLOT-01 (scheduler-side fix, see jxl-worker.md § D2)

**Finding:** After `completeSession()` removes scheduler record, worker continues decoding (never receives `decode_cancel`).

**Issue:** Scheduler.send() is fire-and-forget; worker may be recycled → cancelling recycled slot harms next session.

**Suggested:** Add `Scheduler.earlyCompleteSession(sessionId)` that sends `decode_cancel` before re-assigning worker.

**Effort:** Part of scheduler coordination (2h).

---

## CATEGORY G: Verifier Notes & Uncertainties

### G1 — Noted-but-deferred (verifier verdict)
- **012-errors-3f1a8c20** (missing fetch timeout) — UNCERTAIN; deliberate design (caller owns cancellation). Not implemented.
- **012-security-1d7b3e64** (SSRF surface) — UNCERTAIN; exploitability depends on untrusted-URL callers outside this layer. Not implemented.

---

## Timing Items (Test & Coordination Candidates)

| Item | File | Type | Expected Impact | Effort |
|------|------|------|-----------------|--------|
| A1 (options wire) | encode-session.ts | correctness | None (missing fields) | 1–2h |
| A2 (mapper extract) | encode-session.ts | clarity | None (perf) | 1h |
| B1 (abort order) | encode-session.ts | safety | Low | 1h |
| B2 (makeFrame spread) | decode-session.ts | perf | Negligible | 0.5h |
| C1 (budget metadata) | protocol + handler | correctness | Frames lose metadata on budget | 1h |
| D1 (abort contract) | stream/node | contract | Consumer behavior | Decided + 3h |
| D2–D6 (tests) | test/*.test.ts | coverage | None (future safety) | 6h total |

---

## Next Steps

**Phase 1 (Decision — 1h):**
- D1: Decide abort contract (reject vs resolve on abort).

**Phase 2 (Correctness fixes — 4h):**
- A1: Wire missing EncodeOptions fields (tie to jxl-core fix).
- A2: Extract mapper + exhaustiveness test.
- B1: Reorder abort check (if still needed after verification).
- C1: Extend MsgDecodeBudgetExceeded with metadata fields.

**Phase 3 (Tests & parity — 8h, post-D1 decision):**
- D2–D6: Add stream parity + regression tests.
- Tie to node.ts fixes (E1).

**Phase 4 (Minor optimizations — optional, 1h):**
- B2: Optimize makeFrame spread (low priority).

---

## Agents / Workstreams

**Agent 1: Options forwarding & metadata**
- Scope: A1–A2, C1 (coordinate with jxl-core agents)
- Model: Sonnet
- Effort: 3h (cross-package)
- Output: encode-session.ts + protocol.ts changes

**Agent 2: Abort contract decision & stream parity**
- Scope: D1 (decide), D2–D6 (implement), E1 (reference)
- Model: Opus (concurrency/async reasoning)
- Effort: 8–10h (decision + 4 test files)
- Output: Unified abort contract + parity test suite

**Agent 3: Lifecycle safety**
- Scope: B1–B2, F1 (coordinate with scheduler agent)
- Model: Sonnet
- Effort: 2–3h
- Output: Reordered init + early-cancel hook

**Agent 4: Cross-package verification**
- Scope: Verify B1 (abort already fixed?), C1 (metadata fields wired?), F1 (scheduler earlyComplete? in backlog?)
- Model: Haiku (verification only)
- Effort: 1h
- Output: Verification report + status updates
