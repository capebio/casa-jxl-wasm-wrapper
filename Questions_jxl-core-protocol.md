# QUESTIONS — jxl-core & protocol (contract packages)

**Source:** EpicCodeReview 20260617T202430Z (Section 002 jxl-core + cross-package contracts)

## Scope
This file consolidates deferred findings for **packages/jxl-core/** and its cross-package contract debt:
- `src/types.ts` — EncodeOptions, DecodeOptions, error types
- `src/protocol.ts` — Message schemas (MsgEncodeStart, MsgDecodeError, MsgWorkerError, MsgDecodeBudgetExceeded, etc.)
- `src/errors.ts` — JxlError, error hierarchy
- `src/schemas/*.json` — Validation schemas (currently unconsumed)
- Cross-consumers: jxl-session, jxl-worker-browser, jxl-worker-node

## Handoff Strategy
**Subagent type:** General (contract reasoning + cross-package tracing)  
**Model:** Sonnet (types, protocols, architectural decisions)  
**Effort:** Medium–High (requires cross-package coordination; fixes span 3+ files)

---

## CATEGORY A: Cross-Package Contract Debt (Fix lives in jxl-session / jxl-worker)

**Status:** Several of these were recently fixed per MEMORY.md. **VERIFY current code before acting.**

### A1 — MsgEncodeStart drops ~15 EncodeOptions fields (jxl-core:types.ts + protocol.ts)
**Finding:** Fields with no wire field → silently dropped before reaching worker:
- `modular`, `brotliEffort`, `decodingSpeed`, `photonNoiseIso`, `buffering`, `advancedControls`, `jpegReconstruction`, `alreadyDownsampled`, `upsamplingMode`, `ecResampling`, `frameIndexing`, `allowExpertOptions`
- `progressiveFlavor`, `progressiveAc`, `qProgressiveAc` exist on `MsgEncodeStart` but `encode-session.ts` never copies them

**Current state:** Not yet wired in `jxl-core/protocol.ts` or `jxl-session/encode-session.ts`.

**Root cause:** No single typed `encodeOptionsToStartMsg()` mapper; field forwarding is open-coded with no exhaustiveness guard.

**Suggested patch:**
1. Add optional wire fields to `MsgEncodeStart` in protocol.ts: `modular?`, `brotliEffort?`, etc.
2. Extract `buildEncodeStart(id, opts): MsgEncodeStart` mapper with exhaustiveness check (or use pattern-matching guard).
3. Update `encode-session.ts` constructor to call the mapper.
4. Update worker encode-handler(s) to read and pass through to libjxl.

**Effort:** 4h (mapper + three files).  
**Risk:** Exhaustiveness test required to catch future field regressions.

**ADR draft:** `.epiccodereview/20260617T202430Z/sections/002/adr_draft/encode-options-normalization-utility.md`

### A2 — Worker error codes not in JxlErrorCode union (jxl-core:errors.ts + protocol.ts)
**Finding:** Workers emit `DuplicateSession`, `UnhandledError`, `UnhandledRejection`, `WorkerError`, `MessageDeserializeError`; not in `JxlErrorCode` enum.

**Current state:** `normalizeCode()` in both sessions collapse unknown codes to `"Internal"`, losing the real cause. Wire `code` field is typed `string`, not `JxlErrorCode`, so TS never catches divergence (e.g., `spawn.ts` emits `code:"WorkerError"`).

**Suggested patch:**
1. Decide canonical error-code set (merge worker + libjxl codes into a single `JxlErrorCode` union).
2. Widen `MsgWorkerError.code` from `string` to the union type.
3. Update runtime `KNOWN_JXL_ERROR_CODES` Set.
4. Audit all session error-normalization paths to never drop a real code.

**Effort:** 3h (types + audit).  
**Risk:** Changes public error contract (consumer error handling may need updates).

**ADR draft:** `sections/002/adr_draft/runtime-validation-at-worker-boundary.md`

### A3 — MsgWorkerError missing sessionId (jxl-core:protocol.ts ~305)
**Finding:** Top-level worker crash mid-decode is not attributable to owning session; isn't terminal message → `done()` can hang.

**Current state:** Not yet fixed in worker or scheduler routing.

**Suggested patch:**
1. Worker: set `sessionId` on `MsgWorkerError` (include in payload if crash occurs before message allocation).
2. Scheduler: route `MsgWorkerError` to the session + mark terminal (same as `decode_final`/`encode_done`).
3. Session: treat as terminal error event.

**Effort:** 2h (cross-package: worker + scheduler + session).

**Note:** jxl-worker-node "crash-as-graceful-ack" fix (from MEMORY.md) may already cover this partially; verify current state.

### A4 — DecodeFrameMeta fields dropped by session makeFrame (jxl-session:decode-session.ts)
**Finding:** Fields `sourceScale`, `progressiveSequence`, `passOrdinal`, `frameIndex`, `frameDuration`, `frameName`, `animTicksPerSecond`, `progressiveRegion`, `regionFallback` ride `decode_progress`/`decode_final` but never reach `DecodeFrameEvent` consumers.

**Current state:** PARTIALLY FIXED (MEMORY.md: makeFrame + assignFrameMeta landed). **Verify assignFrameMeta is called on all decode event paths.**

**Suggested patch (if not yet done):**
1. Add a helper `assignFrameMeta(msg: DecodeFrameMeta, out: DecodeFrameEvent)` that copies all fields.
2. Call it in makeFrame() on every path: decode_progress, decode_final, (and budget_exceeded if wired).
3. Add a test asserting all fields survive decode_progress → DecodeFrameEvent round-trip.

**Effort:** 1h (if not yet done).

**Related:** DEFERRED DS-BUDGETEXCEEDED-META-01 (budget_exceeded missing fields — see Category B2).

### A5 — decode_budget_exceeded metadata gaps (jxl-worker-browser:decode-handler.ts)
**Finding:** Carries no folded metrics; node backend drops `region` (browser keeps it) → backend-divergent shape.

**Current state:** PARTIALLY FIXED (MEMORY.md: metric-fold + assignFrameMeta). **Verify:**
- postBudgetExceeded() calls assignFrameMeta() before posting.
- Metrics are folded (output_bytes, time_to_final_ms).

**Suggested patch (if needed):**
1. Ensure `postBudgetExceeded()` runs `assignFrameMeta()` (same as decode_progress/decode_final).
2. Unify node/browser to both keep `region` in `MsgDecodeBudgetExceeded`.

**Effort:** 1h (verification + small edits).

### A6 — Unbounded/unsanitized error message strings
**Finding:** Only decode path truncates; encode/worker paths do not.

**Suggested patch:** Truncation belongs in worker handlers (out of this section scope). Defer to worker review.  
**Cross-file:** jxl-worker-browser encode-handler, jxl-worker-node encode-handler.

### A7 — MsgDecodeError partial-pixel fields independently optional (protocol.ts ~142)
**Finding:** Permits invalid "pixels present but stride absent" state → every consumer must defend.

**Suggested patch:** Required-together union (e.g., `pixels?: { buffer: ArrayBuffer; stride: number; }`) to enforce invariant.  
**Risk:** Breaks shared type (needs coordinated producer/consumer change).

**Effort:** 2h (cross-package audit).

---

## CATEGORY B: Product Intent Decisions

### B1 — effort typed `1..9` vs allowExpertOptions JSDoc claiming effort 10/11 (types.ts:160)
**Finding:** EncodeOptions.effort is Uint8 but JSDoc claims expert effort can be 10/11. MsgEncodeStart.effort also typed `1..9`.

**Question:** Should expert effort 10/11 be representable in the public API?

**Option 1: Widen both types**
- Change `effort: 1|2|3|4|5|6|7|8|9` → `effort: number` (or `Uint8`).
- Add guarded runtime check `if (effort > 11) throw RangeError`.
- Update JSDoc to specify 1–11.

**Option 2: Correct the JSDoc**
- Remove the 10/11 claim; expert effort is not exposed publicly.
- Clarify that expert options activate different *algorithms* within effort 6–9, not new effort levels.

**Decision needed:** User/product call.  
**Effort:** 1h (depends on choice).

**ADR draft:** `sections/002/adr_draft/numeric-invariant-checking-convention.md` (proposes `assertInvariant` dev-mode helper).

---

## CATEGORY C: Validation & Error Handling

### C1 — Schemas/*.json unconsumed (src/schemas/*.json)
**Finding:** JSON schemas define validation rules but no importer/verifier uses them.

**Current state:** Skipped as low-value until wired (per reviewer verdict).

**Suggested:** Fold into runtime-validation ADR (C2) if validation is desired.

### C2 — Runtime validation at worker boundary (protocol.ts, worker-handler boundary)
**ADR draft:** `sections/002/adr_draft/runtime-validation-at-worker-boundary.md`

**Scope:** Lightweight hand guards for drift-detection (boundary is first-party, not untrusted input).  
**Suggested:** Assert critical field presence + bounds (e.g., `code in KNOWN_JXL_ERROR_CODES`, `sessionId != null` on worker errors).

**Effort:** 2h (identify critical fields + add guards).

### C3 — Protocol version handshake (protocol.ts + worker_ready event)
**ADR draft:** `sections/002/adr_draft/protocol-version-handshake.md`

**Suggested:** Add `PROTOCOL_VERSION` constant + assert at worker_ready (keep fire-and-forget intact).  
**Benefit:** Catch version skew (user updates JS but old service worker running).

**Effort:** 1h.

---

## CATEGORY D: Inspected & Intentionally Not Changed

### D1 — errors.ts Object.setPrototypeOf / redundant cause field
**Status:** No concrete failure at target ES2022; only matters if consumer re-transpiles dist to ES5 (speculative).  
**Verdict:** Skipped as opportunistic.

### D2 — protocol.ts JSDoc wording on progressiveDc / groupOrder
**Status:** Cosmetic, not behavioral.  
**Verdict:** Low-value.

### D3 — Verifier-uncertain (could not confirm from available code)
See verified.json in review output for uncertainty details.

---

## Summary: Handoff Order

**Phase 1 (Verification — 2h):**
- Confirm A1–A5 are still pending (check MEMORY.md, recent commits).
- Check if jxl-scheduler S1/S2/S3, jxl-worker-node W-1/W-2 fixes closed A3/A4/A5.

**Phase 2 (Product Intent — 1h):**
- Decide B1 (expert effort 10/11).
- Decide B2 (if any) from verifier notes.

**Phase 3 (Implementation — 5–8h, cross-package coordination):**
- A1: Encode options mapper + three-file wire.
- A2: Error-code union + audit.
- A3: Worker crash routing (if not covered by S1/S2/S3 fix).
- A6/A7: Worker error truncation + optional-field union.
- C2/C3: Runtime validation ADRs + optional guards.

---

## Agents / Workstreams

**Agent 1: Contract verification & intent**
- Scope: Verify A1–A5 status + decide B1
- Model: Sonnet
- Effort: 2–3h
- Output: Questions_jxl-core_verification.md

**Agent 2: Cross-package coordination**
- Scope: Wire A1 (encode options), A2 (error codes), A3 (worker crash)
- Model: Sonnet (coordination)
- Effort: High (3–4h, spans 4 packages)
- Output: Deploy incremental fixes + test updates

**Agent 3: Validation ADRs**
- Scope: C2, C3 + runtime guard patterns
- Model: Haiku (template/patterns)
- Effort: 1–2h
- Output: ADR ratification + code skeleton
