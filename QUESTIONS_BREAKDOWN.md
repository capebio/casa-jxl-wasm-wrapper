# QUESTIONS Breakdown & Handoff Structure

**Created from:** QUESTIONS.md (932 lines, 5 EpicCodeReview runs, ~150 deferred findings)

**Consolidated into:** 5 files + this index

---

## Files Overview

### 1. Questions_raw-pipeline.md
**Focus:** Raw decode path (pixel-level correctness & performance)

**Scope:**
- `crates/raw-pipeline/src/cr2.rs` — CR2 metadata, colour matrix, black/white inference
- `crates/raw-pipeline/src/dng.rs` — DNG parsing, demosaic, CFA alignment
- `crates/raw-pipeline/src/tiff.rs` — TIFF/IFD parser (ORF/DNG/CR2 preview)
- `src/demosaic.rs src/frame_stats.rs src/lib.rs` — Pixel decode, histogram, WASM exports
- `src/perceptual/*` — Butteraugli/SSIM/PSNR metrics + SIMD backends

**Key Issues:**
- **A (5 items):** Public API / output-contract changes (NO AUTO-FIX). Expose flags, exposure-time sentinel, colour matrix intent, per-camera colour matrix, black/white level inference.
- **B (5 items):** Colour/demosaic output changes (NEED REAL FILE VALIDATION). Grbg/Bggr alignment, AsShotNeutral validation, per-channel black levels, ORF color_matrix dtype gate, demosaic degenerate handling.
- **C (10 items):** Performance opportunities (≥5% gate required). Demosaic MHC specialization +22% (MEASURED), DNG tile endian −3.8% (REJECTED), pack_rgb16 redundancy, downscale optimization, LookRenderer clone overhead.
- **D (7 items):** Structural refactors (ADR-worthy). TIFF/IFD reader consolidation, RawError enum, scene-referred RawImageMeta, EXIF orientation implementation.
- **E (7 items):** Perceptual module (f32 vs f64 accumulator, empty-buffer sentinels, PSNR alpha channel, fused kernel).

**Agents:** 4 (colour validation, perf measurements, perceptual audit, structural backlog)  
**Effort:** 20–30h (high variability based on measurement results + user validation)

**Output files:**
- Questions_raw-pipeline_colour-decision.md (colour validation)
- Questions_timings.md (perf results)
- Questions_perceptual-unification.md (metric audit)

---

### 2. Questions_jxl-core-protocol.md
**Focus:** Contract & protocol layer (types, error codes, cross-package debt)

**Scope:**
- `packages/jxl-core/src/types.ts` — EncodeOptions, DecodeOptions
- `packages/jxl-core/src/protocol.ts` — Message schemas (MsgEncodeStart, error codes, metadata)
- `packages/jxl-core/src/errors.ts` — Error hierarchy, JxlError
- Cross-consumers: jxl-session, jxl-worker-browser/node

**Key Issues:**
- **A (7 items, cross-package):** ~15 EncodeOptions fields dropped (no wire field), error codes outside JxlErrorCode, worker crash not attributable (no sessionId), DecodeFrameMeta fields dropped, budget_exceeded metadata gaps, unsanitized error messages, optional-field invariants.
- **B (2 items):** Product intent decisions. expert effort 10/11 representability, SSIM_CONVERGED calibration.
- **C (3 items):** Validation & error handling. Unused schemas, runtime validation guards, protocol version handshake.
- **D (3 items):** Inspected & intentionally not changed (low-value, opportunistic).

**Agents:** 2 (verification + cross-package coordination)  
**Effort:** 8–12h (high coordination cost; spans 4+ packages)

**Output files:**
- Questions_jxl-core_verification.md (status check + intent decisions)
- Incremental fixes to protocol.ts, encode-session.ts, worker handlers

**Critical path:** Verify recent fixes (S1/S2/S3 jxl-scheduler, W-1/W-2 worker-node, makeFrame/assignFrameMeta in decode-session). Some items may already be DONE.

---

### 3. Questions_jxl-worker.md
**Focus:** Worker lifecycle & scheduling (decode/encode handlers, pool, scheduler, dedup, budget)

**Scope:**
- `packages/jxl-worker-browser/src/decode-handler.ts` — Decoder state machine, metrics folding, budget
- `packages/jxl-worker-browser/src/encode-handler.ts` — Encoder queue, pixel buffering, drain signals
- `packages/jxl-worker-browser/src/worker.ts` — Message routing, lifecycle
- `packages/jxl-scheduler/src/scheduler.ts` — Session/worker pool, backpressure, dedup
- `packages/jxl-scheduler/src/budget.ts` `pool.ts` `dedupe.ts`

**Key Issues:**
- **A (5 items):** Scheduler invariants. One-primary-per-sourceKey assertion (unimplemented), unbounded waiter queue (policy decision), signalDrain double-decrement (unresolved verifier disagreement), promotion counter fragility, bufferedChunks unbounded overflow.
- **B (4 items):** Decode-handler. MAX_OUTPUT_BYTES_GUARD conservative (policy), output_bytes vs copied_bytes inconsistency, pre-existing TS errors (out-of-scope for this section), test gaps.
- **C (3 items):** Encode-handler perf (all low-priority, low ROI).
- **D (2 items):** Architecture decisions. Decoder pooling (DONE per MEMORY.md), early-complete session cancellation (deferred scheduler change).
- **E (2 items):** Verifier-uncertain (lifetime contracts, unconfirmed bugs).

**Agents:** 4 (scheduler decisions, decode-handler metrics, encode-handler perf, architecture)  
**Effort:** 8–12h (verifier disagreement on A3; requires arbitration or trace evidence)

**Output files:**
- Questions_scheduler_decisions.md (policies + hardening)
- decode-handler.test.ts additions
- encode-handler perf flipflop results (Questions_timings.md)

---

### 4. Questions_jxl-session-stream.md
**Focus:** Session management & streaming I/O (session lifecycle, stream abort, backpressure)

**Scope:**
- `packages/jxl-session/src/decode-session.ts` — Slot acquisition, frame events, budget, lifecycle
- `packages/jxl-session/src/encode-session.ts` — Options forwarding, lifecycle
- `packages/jxl-stream/src/browser.ts` — ReadableStream wrapping, range negotiation, abort handling
- `packages/jxl-stream/src/node.ts` — Node.js readable wrapping (referenced, out-of-scope this review)

**Key Issues:**
- **A (2 items):** Encode-session options. 12 fields missing wire (cross-jxl-core issue), no exhaustiveness mapper (open-coded).
- **B (2 items):** Decode-session lifecycle. Abort-order race, makeFrame spread allocation micro-opt.
- **C (1 item):** Budget metadata. decode_budget_exceeded missing 8/9 DecodeFrameMeta fields (cross-jxl-core).
- **D (6 items):** Stream abort contract (HIGH priority). Node vs browser abort behavior divergence (DECIDE), 4 missing regression tests, 1 TS workaround.
- **E (1 item):** Node.js (out-of-scope, referenced).
- **F (1 item):** Early-complete session cancellation (scheduler-side fix, deferred).
- **G (2 items):** Verifier notes (uncertain, low-value).

**Agents:** 4 (options+metadata coordination, abort contract decision, stream parity tests, lifecycle safety)  
**Effort:** 10–14h (abort contract is a major decision; test suite depends on it)

**Output files:**
- encode-session.ts + protocol.ts changes (coordinate with jxl-core)
- Unified abort contract + comprehensive parity test suite
- Questions_timings.md (streaming I/O profile, if applicable)

---

### 5. Questions_jxl-wasm.md
**Focus:** FFI/ABI layer (facade.ts + bridge.cpp, WASM rebuild required)

**Scope:**
- `packages/jxl-wasm/src/facade.ts` — TypeScript FFI wrapper, heap management, WASM entries
- `packages/jxl-wasm/src/bridge.cpp` — C++ FFI glue, libjxl integration
- Build: Docker/Emscripten-gated (CANNOT build here; only tsc type-check facade.ts)

**Key Issues:**
- **A (2 items, applied):** OOM guards on malloc, onMetric field (already committed).
- **B (7 items, deferred — WASM rebuild required):** encode_rgba8_with_metadata arg-shift (HIGH), 6 missing encoder options (HIGH), ExtraChannel struct stride mismatch (MED), perceptualConstancyApplyBulk scalar fallback (MED), leaks on throw (MED), rgb8 progressive stride (MED), console.log spam (LOW).
- **C (7 items, deferred — bridge.cpp, rebuild required):** JXTC overflow (HIGH/security, partially patched), unvalidated FFI lengths (MED/security), gain-map overflow (MED), signed crop cast (LOW), unhandled status (LOW), console.log (LOW), Butteraugli ref deep-copy (HIGH/perf, 5–10% win).
- **D (4 items):** ADR drafts (FFI contract test, overflow helpers, error mapping RAII, channel stride).
- **E (2 items):** Flipflop candidates (low expected value, skip).
- **F (1 item):** Correctness (JPEG-end scanner, HIGH, TS-only fix, no rebuild needed).
- **G (2 items):** Policy (SSIM calibration, deferredRelease cap).
- **H (2 items):** Uncertain (lifetime contracts, debug-only checks).

**Agents:** 5 (TS fixes, TS ABI, security audit, perf, ADRs)  
**Effort:** 8–15h + WASM rebuild cycle (rebuild blocks landing changes)

**Output files:**
- facade.ts changes (3 phases: TS-only, ABI, perf).
- bridge.cpp patches (security + perf).
- ADR ratification docs.
- Questions_timings.md (Butteraugli perf, if C7 landed).

**CRITICAL:** All bridge.cpp changes **MUST** be verified with real WASM build + facade.test/vitest suite. No un-tested FFI changes land.

---

### 6. Questions_progressive-encode.md
**Focus:** Progressive JXL encode architecture (scheduler, profile, casabio_encode)

**Scope:**
- `packages/jxl-progressive/src/progressive-scheduler.ts` — Job scheduling, scoring, prefetch, retry
- `packages/jxl-progressive/src/progressive-profile.ts` — Tier profiling (DC/AC/full), byte offsets
- `crates/raw-pipeline/src/casabio_encode.rs` — RGB16 encode variants (full/preview/thumb)
- `crates/casaencoder/src/lib.rs` — User-facing encode API

**Key Issues:**
- **FLAGSHIP ADR:** One-pass progressive encode (instead of 3 independent passes) → −50% encode CPU if quality holds. **Highest-leverage win.** Measurement-gated by `.flipflop/tests/photon-qprogac.mjs`.
- **A (4 items):** Architecture decisions. Remove 3-way parallelism (after flagship), decide WASM encode bridge location, memory budget for prefixAccum, fuse/defer SHA-256.
- **B (3 items):** Cross-file issues. Dead byteStart field, manifest double-fetch race, DC byteEnd exceeds file size (test failure).
- **C (4 items):** Performance. tick() dirty-flag (73% sort, 5–10% overall if gate met), retry timer incremental (not worth it), tee buffering (measure tier sizes first), fused SHA (tier-dependent).
- **D (2 items):** Quality & correctness. Per-tier Butteraugli parity (flagship gate), pre-existing test failure now exposed (quick fix).
- **E (5 items):** Vision (backlog). LOD metadata, timeoutMs, typed perceptual, ML dispatch, per-frame offsets.
- **F (2 items):** Test gaps. Profile test failure (B3 fixes it), TS workaround cleanup.

**Agents:** 5 (quality validation, flagship prototype, perf measurements, architecture, vision backlog)  
**Effort:** 15–25h (flagship is 8–12h alone; measurement + decision gate is critical path)

**Output files:**
- Flagship ADR + prototype (feature branch).
- Flipflop quality validation.
- Flipflop perf results (C1, C3, C4).
- Vision ADR drafts (backlog).

**Critical path:** Validate quality gate (2h) → user decision → prototype (8–12h). Everything else is secondary.

---

## Coordination Map

### Cross-File Dependencies

| Dep | Files | Issue | Coordination |
|-----|-------|-------|--------------|
| EncodeOptions wire | jxl-core, jxl-session | A1 in both → one mapper | Solve in jxl-core; consume in jxl-session |
| DecodeFrameMeta fields | jxl-core, decode-handler, decode-session | A4/C1 → extended protocol | Extend protocol → emit in handler → consume in session |
| Error codes | jxl-core, worker-handler, session | A2 → unified enum | Define in jxl-core; consume in handlers + session |
| Abort contract | jxl-stream/browser.ts, node.ts, session | D1 → decide canonical | Decide in jxl-stream review; apply to node.ts separately |
| Scheduler early-cancel | jxl-scheduler, decode-session | F1 → new scheduler method | Implement in scheduler; call from session |
| Butteraugli deep-copy | jxl-wasm, raw-pipeline | C7 → complement flagship | Bridge fix (5–10%) + flagship (50%) = 55–60% total |

### Timing Critical Path

1. **Phase 1 (0–2 days):** Verification + quick fixes
   - jxl-core: Verify A1–A5 status (may be done per MEMORY.md)
   - jxl-wasm: F1 (JPEG scanner) — TS-only, no rebuild, high-value quick win
   - progressive-encode: B3 (dcTierByteEnd cap) — fixes test failure

2. **Phase 2 (1–3 days):** Measurement gates
   - progressive-encode: `.flipflop/tests/photon-qprogac.mjs` → quality validation for flagship
   - raw-pipeline: Flipflop perf candidates (demosaic +22%, downscale, etc.)
   - jxl-worker: Flipflop encode-handler perf (C1–C3)

3. **Phase 3 (3–5 days):** Architecture decisions
   - progressive-encode: Flagship ADR (user approval)
   - jxl-stream: Abort contract (product decision)
   - jxl-wasm: WASM build cycle (bridge.cpp changes)

4. **Phase 4 (5–10 days):** Implementation
   - Flagship prototype (if approved)
   - Cross-package fixes (options/metadata wiring)
   - WASM rebuild + testing
   - Stream parity test suite

---

## Output Files

### Immediate (Submit to Questions_*)
1. **Questions_falsified.md** — Findings ruled out (with reasoning). Example: "C2 DNG tile endian rejected; measured −3.8%, below 5% gate."
2. **Questions_implemented.md** — Fixes landed (already done or deployed this session).
3. **Questions_deferred.md** — Items requiring future work, with dependencies and sequencing (this is largely the 5 breakdown files themselves).
4. **Questions_timings.md** — Flipflop results (demosaic +22%, encode-handler perf, butteraugli ref-copy, etc.).
5. **Questions_[TOPIC]_Summary.md** — Per-topic synthesis (e.g., "Raw-Pipeline Summary", "Progressive Encode Summary").

### Submitted per Workstream
- Questions_raw-pipeline_colour-decision.md (colour validation + user sign-off)
- Questions_jxl-core_verification.md (cross-package status)
- Questions_scheduler_decisions.md (policy arbitration)
- Questions_progressive-encode_flagship-prototype.md (if approved)

---

## Effort Summary

| File | Category | Est. Effort | Gate | Dependency |
|------|----------|------------|------|------------|
| raw-pipeline | Correctness + perf | 20–30h | Measurement + real files | User colour validation |
| jxl-core | Contract coordination | 8–12h | Cross-package wiring | jxl-session + worker |
| jxl-worker | Lifecycle + scheduler | 8–12h | Verifier arbitration (A3) | Scheduler review |
| jxl-session-stream | Session + abort | 10–14h | Abort contract decision | Product call |
| jxl-wasm | FFI/ABI + security | 8–15h | WASM rebuild cycle | Build gate |
| progressive-encode | Encode architecture | 15–25h | Quality gate (flagship) | Measurement + user approval |
| **TOTAL** | — | **70–110h** | — | **User + measurement gates** |

**Critical path (~40h):** Verification (2h) + measurements (8h) + approval (async) + flagship prototype (12h) + WASM rebuild (8h) + cross-package wiring (10h).

---

## Agent Roles

### Primary Roles
1. **Colour & output-validation expert** — raw-pipeline, real camera files
2. **Cross-package architect** — jxl-core, jxl-session, worker coordination
3. **Concurrency specialist** — jxl-worker scheduler, async/dedup reasoning
4. **Streaming I/O expert** — jxl-stream abort contract, range negotiation
5. **FFI/security auditor** — jxl-wasm bridge.cpp, overflow guards, ABI
6. **Encode architecture expert** — progressive-encode, flagship ADR design

### Capability Mapping
| Skill | Files | Effort |
|-------|-------|--------|
| Opus (complex architecture) | jxl-core, jxl-worker, jxl-session-stream, jxl-wasm | 30h |
| Sonnet (design + reasoning) | raw-pipeline, progressive-encode, ADRs | 25h |
| Haiku (measurement + tooling) | Flipflop runs, test coordination | 10–15h |
| Explore (discovery) | raw-pipeline (if architecture unknown), perf investigation | 5h |

---

## Next Action

**Immediately:** Dispatch parallel agents for:
1. **Verification** (jxl-core, jxl-worker, jxl-session) — 2h, find what's already done
2. **Quick wins** (jxl-wasm F1, progressive-encode B3) — 1h, deploy ASAP
3. **Measurement gates** (flipflop) — 8h, parallel execution
4. **Flagship prototype prep** (progressive-encode design) — 4h, parallel

**Then:** Consolidate findings + user decision gates → proceed to implementation phases.
