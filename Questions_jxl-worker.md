# QUESTIONS — jxl-worker (decode-handler, encode-handler, scheduler pool)

**Source:** EpicCodeReview 20260617T202430Z (Section 008 jxl-scheduler, Section 015 decode/encode-handler)

## Scope
This file consolidates deferred findings for **worker lifecycle and scheduling**:
- `packages/jxl-worker-browser/src/decode-handler.ts` — JxlDecoder state machine, frame flow, metrics folding
- `packages/jxl-worker-browser/src/encode-handler.ts` — JxlEncoder queue, pixel buffering, drain signals
- `packages/jxl-worker-browser/src/worker.ts` — Message routing, cold-start buffering, lifecycle
- `packages/jxl-scheduler/src/scheduler.ts` — Session/worker pool, backpressure, dedup
- `packages/jxl-scheduler/src/dedupe.ts` — Dedup registry invariants
- `packages/jxl-scheduler/src/pool.ts` — Worker pool lifecycle
- `packages/jxl-scheduler/src/budget.ts` — Core budget, waiter queue

## Handoff Strategy
**Subagent type:** General (state-machine reasoning + concurrency)  
**Model:** Opus (complex async/concurrency patterns)  
**Effort:** High (verifier disagreement on some items; needs architecture decisions)

---

## CATEGORY A: Scheduler Invariants & Dedup (jxl-scheduler)

### A1 — No runtime assertion of one-primary-per-sourceKey invariant (dedupe.ts:26–47)
**Finding:** `register()` silently overwrites existing `keyToSession` entry if called twice for same `sourceKey`. No DEBUG assertion → callers that miss `complete()` silently orphan the original session's worker.

**Current state:** Not yet wired.

**Suggested patch:**
1. Add `if (this.keyToSession.has(sourceKey)) { /* assert or error */ }` before overwrite.
2. Gate behind `DEBUG` flag or package-level `strictMode` option.
3. Log or throw in dev; no-op in prod.
4. Audit `scheduler.ts` to confirm `dedupe.register()` only called after `findPrimary` returned `null`.

**Effort:** 1h (assertion + audit).

**ADR draft:** `sections/002/adr_draft/numeric-invariant-checking-convention.md` (proposes shared `assertInvariant` pattern).

### A2 — CoreBudget.acquire() unbounded waiter queue (budget.ts)
**Finding:** No upper bound on pending waiters; in practice bounded by `sum(pool.maxSize)`, but if multiple JxlContext instances share `globalCoreBudget`, total could grow unbounded.

**Question:** Is `globalCoreBudget` intended to be shared across open-ended number of JxlContext/pool instances, or is the total a fixed constant (2–3 pools per context, 1 context per page)?

**Option 1: Bounded by construction (current)**
- Document that sharing is bounded (e.g., "1 pool per page").
- Close as won't-fix.

**Option 2: Unbounded sharing + cap**
- Add `maxWaiters?: number` to constructor.
- Reject (throw) in `acquire()` when `this.pendingCount >= maxWaiters`.
- Value needs design input (e.g., `capacity * 4` as sentinel).

**Decision needed:** User/architecture call.

**Effort:** 1h (if Option 2 chosen).

### A3 — signalDrain double-decrement (scheduler.ts:686,695)
**Verifier verdict:** DISAGREED — one confirmed over-decrement, two could not prove defect because worker coalesces `worker_drain` (decode-handler.ts:152). Strict 1:1 push↔drain invariant assumed by finding does not hold; per-waiter decrement at L695 defensible under "depth = pushes still counted toward HWM" model.

**Direction:** Do NOT change without runtime trace establishing intended invariant. If confirmed, fix = drop second `bp.queueDepth = Math.max(0, bp.queueDepth - 1)` at L695.

**Action:** Defer pending trace evidence or product clarification of the intended HWM accounting model.

### A4 — Promotion subscriber→primary counter fragility (scheduler.ts:556–562)
**Verifier verdict:** Currently-correct-but-fragile. Worker-transfer branch never sets `promotedRecord.state='running'`, but subscribers always created with `state:'running'`, so dispatch coincidentally lands correct. Not a live bug.

**Direction:** Hardening (not critical). Add explicit invariant assertion (DEV-only) or normalize `promotedRecord.state` before counter dispatch. Overlaps broader counter-reconciliation ADR.

**Effort:** 1h (if hardening pursued).

### A5 — Per-session bufferedChunks queue unbounded under worker starvation (scheduler.ts:417–421 send, 465–466)
**Finding:** Queue is unbounded for a queued session; when cap is hit, scheduler must either drop chunks (silent data loss) or fail/error the queued session (breaking contract).

**Verifier verdict:** Hard cap is behavioral policy decision, not mechanical fix. Correct layer/semantics needs contract decision with jxl-session owner.

**Direction:** Decide overflow policy:
- Drop chunks silently (data loss).
- Fail/error the session (breaks `send()` fire-and-forget contract that jxl-session relies on).
- Apply waitForDrain-style blocking to queued sessions (architectural change).

**Decision needed:** User/product call.

**Effort:** 3–5h (depends on decision; may require session/scheduler co-design).

---

## CATEGORY B: Decode-Handler State & Metrics (jxl-worker-browser)

### B1 — MAX_OUTPUT_BYTES_GUARD ceiling is conservative default, not validated policy (decode-handler.ts)
**Finding:** 1 GiB ceiling (≈1 billion pixels) was chosen as clearly-generous, not actual max. If platform legitimately needs larger images, constant must be raised.

**Suggested patch:** Document intended max decode resolution in CLAUDE.md. Set `MAX_OUTPUT_BYTES_GUARD = maxWidth * maxHeight * maxBytesPerPixel`.

**Decision needed:** Max resolution policy (e.g., 32K×32K, or platform-dependent).

**Effort:** 1h (documentation + potential constant change).

### B2 — output_bytes vs copied_bytes metric semantics inconsistent (decode-handler.ts, budget paths)
**Finding:** Progress/final budget-check-2 arms post `copied_bytes` (only when `transfer.copied`). Budget-exceeded arm posts `output_bytes`. Consumer can't tell which is canonical for buffer size.

**Suggested patch:**
1. Unify to single `output_bytes` metric posted by `postBudgetExceeded()` on all paths.
2. Remove `copied_bytes` from check-2 arms.
3. OR document the semantics difference explicitly (with JSDoc).

**Effort:** 1–2h.

### B3 — Pre-existing TS errors in encode-handler.ts and worker.ts (jxl-worker-browser)
**Status:** Mentioned but out-of-scope for decode-handler review (section 015).

**Details:**
- `encode-handler.ts:365` — `finishPromise.catch()` on `void | Promise<void>`.
- `worker.ts:588` — `Location` type not found.

**Action:** Must be resolved in encode-handler/worker review (Section 015), not here.

### B4 — Test gaps (decode-handler.ts unit tests)
**Suggested tests to add under packages/jxl-worker-browser/test/**:
- Cancel while paused → decoder disposed, `decode_cancelled` posted.
- Cancel during active `push()` → `disposeActiveDecoder()` safely.
- Budget exceeded before first progress → `postBudgetExceeded()` with live (non-detached) pixels.
- `budgetMs == null` → no crash.
- Many small chunks → `worker_drain` coalesced, queued bytes stay below `BYTE_DRAIN_HWM`.
- `DRAIN_MIN_INTERVAL_MS` prevents drain spam during bursts.

**Effort:** 3–4h.

---

## CATEGORY C: Encode-Handler Perf Deferrals (jxl-worker-browser)

**All rated "severity=low/info" — measurement-gated before implementing.**

### C1 — onPixels allocates wrapper per inbound chunk (encode-handler.ts:113–118)
**Issue:** Array of `{chunk, region?}` with read index requires object wrapper (unlike decode's ChunkRing).

**Why deferred:** Converting to paired ring is structural refactor with behavior risk; no benchmark evidence.

**Effort:** 3h (if pursued; low ROI).

### C2 — takeNextPixels calls compactQueue on every drained chunk (encode-handler.ts:271–293)
**Issue:** Array+read-index queue compacts per chunk (vs decode's ChunkRing O(1) shift).

**Why deferred:** Same structural refactor as C1; compactQueue already uses no-alloc copyWithin (cost bounded).

**Effort:** 3h (if pursued).

### C3 — feedEncoder two performance.now() per loop (encode-handler.ts:295–328)
**Issue:** Decode reuses one post-push timestamp; encode reads its own in maybePostDrain.

**Why deferred:** Threading timestamp changes signature; micro-optimization with no benchmark.

**Effort:** 0.5h (if pursued; negligible impact).

---

## CATEGORY D: Architecture Decisions (ADR-worthy)

### D1 — Worker-side decoder pooling (MEMORY.md: Task 3)
**Status:** DONE — pool manager for reusable JxlDecoder instances (4-decoder LRU, config-based keying, 5s idle eviction).

**Current state:** Integrated into decode-handler + worker lifecycle (commit marked feat(decoder-pool)).

**Action:** Verify integration + measure 10–50ms init overhead savings on multi-image workloads.

### D2 — Early-complete session cancellation (decode-session.ts finish path)
**Finding:** DEFERRED DS-SINGLEPASS-SLOT-01 — after completeSession() removes scheduler record, worker continues decoding (never receives decode_cancel).

**Issue:** Worker burns CPU on unwanted work until natural completion (correctness OK, efficiency poor).

**Constraint:** `scheduler.send()` is fire-and-forget (safe after completeSession); but worker may be recycled → cancel would target wrong session.

**Suggested patch:** Add `Scheduler.earlyCompleteSession(sessionId)` that:
1. Sends `decode_cancel` before removing record.
2. Registers sessionId in `discardSessions` (drop late terminal ack).
3. Calls `cleanupSession()`.

**Effort:** 2h (scheduler + session coordination).

---

## CATEGORY E: Verifier-Uncertain (Unresolved)

### E1 — Decoder cancel/dispose lifetime (facade.ts:1876)
**Issue:** Leak possible if consumer abandons iterator undrained.  
**Status:** Does any current consumer do this? Unconfirmed.

**Action:** Code audit of all decode loop callers (browser session, Node backend, test harness).

### E2 — Take_flushed borrowed-view lifetime (bridge.cpp:2361)
**Issue:** Caller copies before yield — safe today, contract comment-only.  
**Status:** Unconfirmed if contract is enforced/documented.

**Action:** Document invariant in C++ comments + add safety guard if no copy exists.

---

## Timing Items (Measurement Candidates)

| Item | File | Type | Expected Impact | Effort |
|------|------|------|-----------------|--------|
| A1 (dedup assert) | dedupe.ts | safety | None (debug-only) | 1h |
| B2 (metric unify) | decode-handler.ts | clarity | None (no perf) | 1–2h |
| C1–C3 (encode perf) | encode-handler.ts | perf | ~3% est (low) | 3h each |
| D2 (early-cancel) | scheduler + session | efficiency | 5–10ms per decode (low) | 2h |

---

## Next Steps

**Phase 1 (Decisions — 1h):**
- A2: Decide unbounded-waiter policy (doc, cap, or status-quo).
- A5: Decide bufferedChunks overflow semantics.
- B1: Document max-resolution policy.

**Phase 2 (Safety hardening — 3h):**
- A1: Dedup assertion + audit.
- A4: Promotion counter normalization (if pursued).
- B2: Metric semantics unification.
- B4: Add missing unit tests.

**Phase 3 (Efficiency (optional) — 5h+):**
- C1–C3: Measure encode-handler perf; if >5% gate met, implement structural refactor.
- D2: Early-complete session cancellation.

**Phase 4 (Verification — ongoing):**
- E1–E2: Audit callsites for lifetime guarantees.

---

## Agents / Workstreams

**Agent 1: Scheduler invariants & decisions**
- Scope: A1–A5, decide policies
- Model: Opus (concurrency)
- Effort: 3h (decisions + hardening)
- Output: Questions_scheduler_decisions.md

**Agent 2: Decode-handler metrics & tests**
- Scope: B1–B4
- Model: Sonnet (state machine)
- Effort: 4–5h (metric audit + unit tests)
- Output: decode-handler.test.ts additions + metric doc

**Agent 3: Encode-handler perf**
- Scope: C1–C3
- Model: Haiku (benchmark coordination)
- Effort: 2–3h (flipflop tests + analysis)
- Output: Questions_timings.md (encode-handler section)

**Agent 4: Architecture coordination**
- Scope: D1 (verify), D2 (implement if approved)
- Model: Sonnet
- Effort: 2–3h
- Output: Code changes + test updates
