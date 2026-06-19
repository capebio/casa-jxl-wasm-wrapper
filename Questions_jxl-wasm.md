# QUESTIONS — jxl-wasm (FFI/ABI layer, facade.ts + bridge.cpp)

**Source:** EpicCodeReview 20260617T202430Z (Section 014 jxl-wasm) + 20260619T124908Z (facade fixes)

## Scope
This file consolidates findings for **WASM FFI/ABI bridge**:
- `packages/jxl-wasm/src/facade.ts` — TypeScript FFI wrapper, heap management, WASM entry points
- `packages/jxl-wasm/src/bridge.cpp` — C++ FFI glue, libjxl integration, encoder/decoder bindings
- Build & testing: WASM only (cannot build in this environment; requires emsdk Docker/Emscripten)

## CRITICAL CONSTRAINT
**Environment limit:** WASM build is Docker/Emscripten-gated; CANNOT be built or behaviorally tested here. Only **tsc type-checks** facade.ts. ALL bridge.cpp changes and ABI-coupled fixes **MUST be verified with a real WASM build + facade.test/vitest suite** — un-built FFI/heap changes silently corrupt encodes or WASM heap.

## Handoff Strategy
**Subagent type:** General (ABI reasoning, security audit)  
**Model:** Opus (FFI correctness + overflow reasoning)  
**Effort:** Very High (all fixes deferred pending rebuild; requires WASM build cycle to verify)

---

## CATEGORY A: Applied This Pass (facade.ts, tsc-gated only)

**Status:** Already committed.

### A0 — Baseline tsc errors
- Baseline: 1 error → After fixes: 0 errors
- All fixes: additive, can't-make-worse

### A1 — Added `onMetric` to `EncoderOptions` (facade.ts:1942)
**Fix:** Added missing field to match LibjxlEncoder reader.  
**Type-safe:** Yes (tsc validates).

### A2 — OOM guards on 4 `_malloc` sites (facade.ts)
**Locations:** transcodeJpegToJxl, back-compat streaming push, buffered-encode pixels, sidecar dims.

**Pattern:** `if (ptr === 0) throw` (matching existing guards at L902/944/1095/1152).  
**Type-safe:** Yes.

---

## CATEGORY B: facade.ts ABI/Contract Bugs (Deferred — WASM rebuild required)

**All findings:** Fix surface is TS but **UNTESTABLE here** (require rebuild + round-trip tests).

### B1 — HIGH — `encode_rgba8_with_metadata` arg-shift (facade.ts:~340 vs bridge.cpp:2456)
**Finding:** Bridge inserts `group_order` + `resampling` after `buffering`; facade omits both → ALL ICC/EXIF/XMP pointer args shift by 2 → metadata corruption on buffered-metadata encode.

**Current state:** Not yet fixed in facade.ts.

**Suggested patch:**
1. Add `group_order` and `resampling` args to facade call in correct ABI position.
2. Rebuild WASM.
3. Round-trip test with real ICC + EXIF profiles.

**Severity:** HIGH (metadata silently corruption).

**Effort:** 0.5h fix + rebuild + test.

### B2 — HIGH — 6 encoder options not forwarded (facade.ts:137 vs bridge.cpp:3019+)
**Missing fields:** `orientation`, `intrinsicSize`, `disablePerceptualHeuristics`, `codestreamLevel`, `centerX`, `centerY`.

**Finding:** EncoderOptions declares none; caller forwards them; bridge has setters → silent no-ops.

**Suggested patch:**
1. Add 6 fields to `EncoderOptions` in facade.ts.
2. Call corresponding setter on `LibjxlEncoder` for each (match pattern at bridge.cpp:3019+).
3. Rebuild + test.

**Severity:** HIGH (features silently disabled).

**Effort:** 1h fix + rebuild + test.

### B3 — MED — ExtraChannel struct stride mismatch (facade.ts vs bridge.cpp)
**Finding:** TS serializer 72-byte stride vs 20-byte C++ `WasmExtraChannel`.

**Current state:** Latent (no call site yet). Will corrupt `num_ec >= 2` encodes once wired.

**Suggested patch:**
1. Audit C++ struct size (bridge.cpp).
2. Sync TS struct padding/layout to match (or use correctly-sized typed array).
3. Add unit test for multi-extra-channel round-trip (e.g., alpha + depth).

**Severity:** MED (latent; not yet triggered).

**Effort:** 1h + rebuild + test.

### B4 — MED — `perceptualConstancyApplyBulk` scalar fallback broken (facade.ts:~3152)
**Finding:** Copies input→output, reports success, never applies transform. Also passes JS Float32Array where C symbol wants `float*`.

**Related:** MEMORY.md notes "c-perceptual link-fails wasm" — `_perceptual_apply_full` not linked in default build.

**Suggested patch:**
1. Fix the link error first (bridge build).
2. Implement scalar fallback: `perceptual_apply_full` → transform + return actual output.
3. Validate FS/C type compatibility (likely needs malloc + libjxl::Image3F conversion).
4. Rebuild + test with real image.

**Severity:** MED (unused today; breaks when enabled).

**Effort:** 2h + rebuild + test.

### B5 — MED — Leaks on throw (facade.ts:1377, 2074)
**Finding:**
- Progressive decoder handle (facade.ts:1377) leaks if malloc/alloc throws before try/finally.
- `wasmEncState` (facade.ts:2074) leaks if malloc throws before owning try/finally.

**Suggested patch:**
1. Hoist mallocs into scope before try block.
2. Ensure finally always runs (even if malloc throws).
3. Test with memory pressure (simulate OOM).

**Severity:** MED (rare, but leak under OOM).

**Effort:** 0.5h fix + rebuild + test.

### B6 — MED — rgb8 progressive pixelStride (facade.ts:~1435)
**Finding:** `eventsProgressive` uses 4-byte stride for rgb8 (3-channel) → byte-total mismatch.

**Related:** Long-rumored "rgb8 stats issue" — located here.

**Suggested patch:**
1. Compute stride correctly: rgb8 = 3 bytes/pixel, rgb16 = 6 bytes/pixel (or use proper layout helper).
2. Add ADR: `adr-shared-channel-stride-helper` (one source of truth for pixel layout).
3. Rebuild + test 24-bit vs 48-bit progressive stats.

**Severity:** MED (stats misaligned; may affect quality curves).

**Effort:** 1h + rebuild + test.

### B7 — LOW — Hot-path console.log spam (facade.ts:968/1171/2289)
**Finding:** Redundant with `onMetric` callback.

**Suggested patch:** Remove or gate behind DEBUG flag.

**Severity:** LOW (not a correctness issue, just noise).

**Effort:** 0.5h.

---

## CATEGORY C: bridge.cpp — C++, CANNOT build here, ALL DEFERRED

**All deferred for user to apply WITH a real WASM build + test cycle.**

### C1 — HIGH/security — JXTC encode integer overflow (bridge.cpp:1611/1618)
**Finding:** `tile_count = tiles_x*tiles_y` 32-bit multiply wraps; loop writes `tile_bytes[idx]` at un-wrapped index → heap overflow.

**Current state:** PARTIALLY PATCHED in source (per MEMORY.md commit this branch):
- Compute `tiles_x*tiles_y` in 64-bit.
- Reject when 0 or `> JXTC_MAX_TILES` (2^24).
- Narrow to uint32 only once safe.

**Status:** **NOT yet build-verified** — rebuild WASM + run jxl-wasm suite to confirm.

**Severity:** HIGH (security: heap overflow on attacker-controlled image).

**Effort:** 0h fix (already in source) + rebuild + security test.

**Note:** JXTC *decode* counterpart (bridge.cpp:1713) was FALSE POSITIVE (has `idx >= tile_count` guard + size bounds).

### C2 — MED/security — Unvalidated FFI lengths (bridge.cpp)
**Findings:**
- Extra-channel `plane_ptr`/`size` (1022) — no bounds.
- Custom-box `data_ptr`/`size` (356) — no bounds.
- RGB16 planar planes (2404) — no bounds.
- Butteraugli/PSNR/SSIM direct pointers (3377) — no bounds.
- EncodeAnimation `wf.width*wf.height` (1884) + unbounded `name_size` memcpy (1906).

**Suggested patch:** Add bounds checks for each (OOB read risk):
1. `if (plane_size > WASM_HEAP_SIZE / num_channels) throw`.
2. Same for custom-box data.
3. Same for animation frame dims.
4. Clamp `name_size` memcpy to available buffer.

**Severity:** MED (external attacker data; OOB read/info leak).

**Effort:** 2h + rebuild + fuzzing.

### C3 — MED — gain-map `gm_capacity*2u` overflow (bridge.cpp:2311)
**Finding:** Doubling has no guard (sibling `input_buf` IS guarded).

**Suggested patch:** Add `checked_mul` (see ADR below).

**Severity:** MED (less likely than C2; duplicate checks).

**Effort:** 0.5h + rebuild.

### C4 — LOW — Tiled-decode signed crop cast (bridge.cpp:1403)
**Finding:** `crop_x0`/`y0` cast to uint32 → OOB read on crafted JXL.

**Suggested patch:** Clamp to 0 or validate range first.

**Severity:** LOW (crafted JXL only; info leak).

**Effort:** 0.5h.

### C5 — LOW — Unhandled JxlDecoderStatus (bridge.cpp:2143)
**Finding:** No default branch → spin; `BOX_NEED_MORE_OUTPUT` bare continue (2311).

**Suggested patch:** Add default → error + fix continue to proper state.

**Severity:** LOW (edge case handling).

**Effort:** 0.5h.

### C6 — LOW/perf — EM_ASM console.log per chunk (bridge.cpp:2918, 3102)
**Finding:** Logs on every encode chunk / `enc_finish`.

**Suggested patch:** Gate behind DEBUG flag or remove.

**Severity:** LOW (performance noise).

**Effort:** 0.5h.

### C7 — HIGH/perf — Butteraugli ref deep-copy (bridge.cpp:3509–3519)
**Finding:** `ButteraugliInterface(...InPlace)` consumes args → full 3-plane memcpy of ref every pass.

**Suggested:** Use non-consuming `ButteraugliInterface(const Image3F&)` (butteraugli.h:80).

**Measurement:** HIGH perf impact (per run 20260619T124908Z). **Bundle into Phase-6 decode-resident rebuild?**

**Effort:** 1h + rebuild + flipflop (potential 5–10% encode speedup).

### C8 — MED/perf — ssim_block_luma two-pass (bridge.cpp:3571)
**Finding:** Computes mean + variance in separate passes.

**Suggested:** Fuse to one pass (mean + variance in parallel).

**Measurement:** Estimated 3–5% SSIM compute win.

**Effort:** 1h + rebuild + test.

---

## CATEGORY D: ADR Drafts (Awaiting Ratification)

**All stored in `.epiccodereview/20260617T202430Z/sections/014/adr_draft/`**

### D1 — adr-ffi-abi-contract-test.md
**Scope:** CI smoke test — every facade-called symbol exists with right arity; single source of truth for FFI layout.

**Goal:** Catch mismatches like B1 (arg-shift) at build time.

**Effort:** 2h (test harness + bridge symbol audit).

### D2 — adr-overflow-checked-size-helpers.md
**Scope:** `checked_size_mul` (bridge.cpp) + `assertHeapWrite` (facade.ts).

**Goal:** Centralize overflow guards (fixes C1/C2/C3 systematically).

**Effort:** 1h + rebuild.

### D3 — adr-structured-libjxl-error-mapping-raii.md
**Scope:** JxlDecoderStatus → typed-error map + RAII C++ cleanup + missing default.

**Goal:** Fix C5 + improve error handling.

**Effort:** 1h + rebuild.

### D4 — adr-shared-channel-stride-helper.md
**Scope:** Single `pixelLayout(format)` helper (fixes B6).

**Goal:** No more "magic strides" (4 vs 3 vs 6 bytes/pixel scattered).

**Effort:** 0.5h + rebuild.

---

## CATEGORY E: Flipflop Candidates (TS perf, low expected value)

**Measurement note:** Buffer-copy axis measured = noise (no >5% wins expected).

### E1 — ButteraugliComparator.compare per-call malloc (facade.ts:748)
**Issue:** Allocates constant-size candidate per call → grow-only slot.

**Measurement:** Negligible (<1% overall).

### E2 — No `SsimComparator`; re-malloc+copy ref (facade.ts:689/816)
**Issue:** `computeSsimWasm` / PSNR re-allocate fixed ref every pass.

**Measurement:** Negligible (<1% overall).

**Verdict:** Both low-value; skip unless profiling shows otherwise.

---

## CATEGORY F: Correctness (Testable, not yet fixed)

### F1 — JPEG-end scanner rejects real JPEGs (facade.ts:2740)
**Finding:** `findValidJpegEnd` bails at SOS (0xDA) → `extractJpegReconstructionFromJxl` returns null for all embedded JPEGs.

**Suggested patch:**
1. Fix marker walk: SOS → entropy → EOI (correct JPEG structure).
2. Add unit test.

**Severity:** HIGH (reconstruct path broken for all JPEGs).

**Effort:** 1h (no rebuild; TS-only fix).

**Recommended:** This is a high-priority quick win (no rebuild needed).

---

## CATEGORY G: Policy / Calibration (Human decision)

### G1 — SSIM_CONVERGED calibration (backends.ts:216)
**Finding:** Calibrated to ssim.js; loaded build may use WASM SSIM (~1–2% off) → `convergedByteEnd` shifts.

**Question:** Recalibrate to WASM scale, or keep ssim.js for the gate?

**Decision needed:** User/product call.

**Effort:** 1–2h (if recalibrate chosen).

### G2 — deferredRelease 1080p hard cap + transfer-detach footgun (facade.ts:1411–1447)
**Finding:** Opt-in, no prod caller. Grow + document no-transfer, or leave until a caller needs it?

**Decision needed:** User/product call.

**Effort:** 1h (if decision is to harden).

---

## CATEGORY H: Uncertain (Could not confirm from in-scope code)

### H1 — take_flushed borrowed-view lifetime (bridge.cpp:2361)
**Issue:** Caller copies before yield — safe today, contract comment-only.

### H2 — Decoder cancel/dispose leak (facade.ts:1876)
**Issue:** Leak only if consumer abandons iterator undrained.

**Action:** Code audit of all decode loop callers.

---

## Build & Test Checklist

**Before landing ANY bridge.cpp fix:**

1. [ ] Rebuild WASM via `node packages/jxl-wasm/scripts/build.mjs --host-toolchain` (or Docker).
2. [ ] Run `packages/jxl-wasm/test` suite (vitest).
3. [ ] Run round-trip smoke tests:
   - Encode-decode identity (lossless, if supported).
   - Metadata preservation (ICC, EXIF, XMP).
   - Multi-extra-channel (alpha, depth).
   - Budget/cancel paths.
   - Progressive decode frame-by-frame.
4. [ ] Run security fuzzing (if C2/C3 changes touch bounds).
5. [ ] Run flipflop (C7/C8 perf changes).

---

## Timing & Sequencing

**Phase 1 (TS fixes, no rebuild — ASAP):**
- A2 (OOM guards already done).
- F1 (JPEG-end scanner fix; high-value, no rebuild).
- B7 (console.log cleanup).

**Phase 2 (TS ABI fixes — requires rebuild):**
- B1 (arg-shift).
- B2 (6 missing encoder options).
- B5 (leak hoisting).
- B6 (rgb8 stride).

**Phase 3 (bridge.cpp — requires rebuild + security audit):**
- C1 (verify overflow patch already in source).
- C2 (bounds checks).
- C7 (Butteraugli ref deep-copy — high perf).
- C8 (SSIM two-pass fusion).

**Phase 4 (ADR + optional hardening — after C fixes verify):**
- D1–D4 (ADRs).
- G1–G2 (policy decisions).

---

## Agents / Workstreams

**Agent 1: TS fixes (no rebuild)**
- Scope: F1 (JPEG scanner), B7 (console.log)
- Model: Haiku (straightforward)
- Effort: 1h
- Output: facade.ts PR

**Agent 2: TS ABI fixes (requires rebuild)**
- Scope: B1–B6
- Model: Opus (FFI/ABI reasoning)
- Effort: 3h fix + 2h rebuild+test
- Output: facade.ts changes + rebuild checklist

**Agent 3: bridge.cpp security audit**
- Scope: C1 (verify), C2 (bounds checks), C3 (overflow)
- Model: Opus (security reasoning)
- Effort: 2h fix + rebuild+fuzzing
- Output: Patched bridge.cpp + security test

**Agent 4: bridge.cpp perf (optional)**
- Scope: C7 (Butteraugli), C8 (SSIM)
- Model: Sonnet (perf reasoning)
- Effort: 2h fix + flipflop
- Output: Optimized bridge.cpp + timing report (Questions_timings.md)

**Agent 5: ADR drafting**
- Scope: D1–D4
- Model: Haiku (template patterns)
- Effort: 2h
- Output: ADR ratification doc

---

## Next Steps

1. **Immediate (TS-only):** Deploy F1 + B7 to main branch (no rebuild, high confidence).
2. **Coordination:** Schedule WASM rebuild cycle for B1–B6 + C1–C8.
3. **Security:** Include C1/C2 bounds checks in rebuild + fuzzing pass.
4. **Perf:** Gate C7/C8 on flipflop results (estimate 5–10% encode speedup if both land).
5. **ADRs:** Ratify D1–D4 before next rebuild to ensure patterns are consistent.
