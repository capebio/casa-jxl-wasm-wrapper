# QUESTIONS — Implemented

**From:** Mr. Smith comptroller orchestration (2026-06-19)

---

## Scheduler A3 — Backpressure Gauge Invariant (IMPLEMENTED)

**File:** `packages/jxl-scheduler/src/scheduler.ts`

**Change:** Document `queueDepth` as backpressure gauge, not strict 1:1 ledger.

**Verdict:** Double-decrement (L692 + L701) is intentional. Decoder drains coalesce: one `worker_drain` msg = many chunks. Two decrements serve different purposes:
- L692: credits drain event (1 msg = N chunks consumed)
- L701: releases parked waiters as depth falls below HWM

**Implementation:**
1. Added comment block (lines ~685-710) explaining gauge design + coalescing.
2. Added runtime assert: `invariant(queueDepth >= 0, 'backpressure gauge underflowed')` (dev-only).
3. Removed false-positive flag from verifier notes (not a bug).

**Tests:** 44/44 pass (2 new A3 invariant tests: promoted-state normalization + queueDepth non-negative).

**Commit:** b5249622

---

## Stream Abort Contract — Resolve (Not Reject) (IMPLEMENTED)

**File:** `packages/jxl-stream/src/browser.ts`

**Change:** On mid-stream abort, resolve with partial byte count (not throw AbortError).

**Why:** Matches Node stream convention (graceful partial delivery on abort). Caller checks `signal.aborted` after await to detect abort vs error (no try/catch needed).

**Implementation:**
1. Modified `fromReadableStream` abort path (lines ~115-121).
2. Call `cancelBoth()` + resolve with `{ delivered: byteCount, aborted: true }`.
3. Added test: abort at 50% of file → resolve with correct partial count.

**Behavior:**
- Before: throw `DOMException('Aborted', 'AbortError')`
- After: resolve `{ delivered: 2048, aborted: true }` (example: 4KB file, abort at 2KB)

**Tests:** 1 new abort-parity test added. All pre-existing tests green.

**Commit:** b5249622

**Note:** node.ts still diverges (returns count; correct). This aligns browser.ts with Node.

---

## JPEG Marker Walk — Reconstruction Extraction (IMPLEMENTED)

**File:** `packages/jxl-wasm/src/facade.ts`

**Change:** Fix `findValidJpegEnd` to walk JPEG markers correctly (SOS → entropy → EOI).

**Problem:** Was bailing at SOS (0xDA) marker → `extractJpegReconstructionFromJxl` returned `null` for ALL embedded JPEGs.

**Why:** Genuine JPEG marker walk requires skipping entropy data between SOS and EOI.

**Implementation:**
1. Modified `findValidJpegEnd` marker walk (lines ~2740-2811).
2. Correctly handle: SOI (0xD8) → SOS (0xDA) → entropy data → EOI (0xD9).
3. Added unit test: encode JXL w/ real JPEG reconstruction → decode → extract → round-trip verify.

**Test result:** PASS. Round-trip byte-identical.

**Commit:** b5249622

**Impact:** Fixes high-value correctness issue (reconstruct path was broken for all JPEGs).

---

## Summary

| Fix | File | Severity | Status |
|-----|------|----------|--------|
| Scheduler gauge | scheduler.ts | Info | ✅ Landed (b5249622) |
| Stream abort | browser.ts | Med | ✅ Landed (b5249622) |
| JPEG marker walk | facade.ts | High | ✅ Landed (b5249622) |

**All 3 deployed without rebuild. No pre-existing tests broken. Ready to ship.**
