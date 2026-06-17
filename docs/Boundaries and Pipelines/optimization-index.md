# Optimization Index — Ranked Opportunities

Comprehensive ranked list of optimizations for the JXL encode/decode pipeline, from highest to lowest priority. Based on impact, effort, and current implementation status.

---

## Priority 1: Tier Selection (HIGH Impact, LOW Effort)

**Opportunity**: Always use `relaxed-simd-mt` or `simd-mt` tier when COOP/COEP headers available.

**Current Status**: Auto-detection logic exists in `jxl-capabilities`, but not always active in production. Tier defaults to `simd` even when MT available.

**Impact**: 
- SIMD math: 2–3× faster libjxl decode/encode
- Parallelism: Additional 2–4× speedup for multi-frame or long-duration encodes
- **Net**: 60–70% total speedup for MT-aware applications

**Effort**: Low
- Capabilities probe already implemented (`probeTier()`)
- Tier selection already wired in worker spawn
- Action: Ensure COOP/COEP headers in deployment; validate `crossOriginIsolated` is true at startup

**Why Not Done**: Deployment-side; not code-driven. Requires HTTP headers (not in WASM or JS library scope).

**Next**: No code change required; operations/deployment concern.

---

## Priority 2: Zero-Copy Pixel Transfer via Deferred Release (HIGH Impact, MEDIUM Effort)

**Opportunity**: Delay `buffer_free()` on decoded frame output until after `postMessage` completes, enabling zero-copy ArrayBuffer transfer instead of `.slice()` copy.

**Current Status**: Frame output is copied via `new Uint8Array(...)` to detach from WASM heap before transfer. Necessary because heap can be reallocated.

**Problem**: The `.slice()` copy is inescapable given current lifetime contract (WASM heap reallocatable, JS backing must be stable).

**Proposed Fix**: 
1. Keep decoded frame as WASM heap view (subarray)
2. Post to main thread with transfer
3. Free WASM heap only after transfer complete (via Atomics or callback)

**Impact**: Eliminates 1 copy per frame (significant for high-fps, large-resolution content)

**Effort**: Medium
- Requires API redesign (session.onFrame must become async-safe or support callback)
- Requires hand-off protocol between worker and main (Atomics or postMessage back)
- Risk: Complexity; potential for off-by-one release bugs

**Why Not Done**: Architectural change that affects public API contracts. Deferred pending measured evidence that copy is bottleneck.

**Next**: Implement `take_frame_ms` probe (Phase 4); if > 5% of frame time, revisit.

---

## Priority 3: C++ Region Crop (HIGH Impact, MEDIUM Effort)

**Opportunity**: Move `applyRegionAndDownsample` from JS to C++ (bridge.cpp), matching one-shot decode path.

**Current Status**: 
- One-shot decode: Uses `cppDidCrop` flag to signal libjxl handled region internally
- Progressive decode: No region crop in C++; falls back to JS O(W×H) traversal

**Problem**: JS traversal for region crops is O(W×H) but lacks SIMD benefit.

**Proposed Fix**:
1. Add `cppDidCrop` support to progressive path (query libjxl for output region)
2. Add bridge function for region crop if libjxl doesn't expose it
3. Fallback to JS only if C++ unavailable

**Impact**: Region queries 20–30% faster (avoids JS traversal; uses SIMD in C++)

**Effort**: Medium
- Requires bridge.cpp extension or libjxl capability query
- Requires testing on scalar/SIMD/MT tiers
- Risk: Low (one-shot already proven)

**Why Not Done**: Unclear if region decodes are common in production. No usage telemetry.

**Next**: Implement `region_crop_ms` instrumentation (split from `prog_frame_prep_ms`); gather data before deciding.

---

## Priority 4: WASM Bilinear Resize (MEDIUM Impact, MEDIUM Effort)

**Opportunity**: Move `applyTargetResize` from JS to WASM kernel, replacing O(W×H) JS bilinear with C++ SIMD.

**Current Status**: JS-only bilinear resampling in facade.ts. Triggered when output dims ≠ requested dims.

**Problem**: JS traversal lacks SIMD; full 2-pass scan per resize.

**Proposed Fix**:
1. Add `resize_kernel` to bridge (C++ bilinear or similar)
2. Call from facade when resize needed
3. Fallback to JS if WASM unavailable

**Impact**: Resize-heavy queries 10–30% faster (depends on resize frequency and ratio)

**Effort**: Medium
- Requires new bridge function (estimate: 50–100 lines C++)
- Requires testing on all tiers
- Risk: Medium (custom kernel needs validation vs. libjxl's internal resize)

**Why Not Done**: Unclear if resizing is a common operation path. No measured bottleneck.

**Next**: Add `target_resize_ms` probe (split from `prog_frame_prep_ms`); measure before investing.

---

## Priority 5: SAB Ring-Buffer Zero-Copy (HIGH Impact, HIGH Effort)

**Opportunity**: Use Atomics.waitAsync + ring buffer to share decoded pixels between WASM and main thread without `.slice()` copy (MT tier only).

**Current Status**: MT tier (simd-mt / relaxed-simd-mt) forces `.slice()` copy on every frame because SharedArrayBuffer cannot be transferred.

**Problem**: SAB `.slice()` adds 0.5–1ms per 1080p frame on MT tier.

**Proposed Fix**:
1. Allocate SAB ring buffer in WASM heap
2. WASM writes decoded frame to ring slot
3. Main thread waits via `Atomics.wait()` or `Atomics.waitAsync()` for signal
4. Main thread reads from ring; signals completion
5. WASM recycles ring slot

**Impact**: MT tier eliminates redundant copy (5–10% speedup for MT-heavy workloads)

**Effort**: High
- Complex state machine (ring pointer management, wait/notify coordination)
- Requires careful lifetime management (frame lifetime extends to main thread)
- Testing: MT-specific; easy to deadlock
- Risk: High (threading bugs; performance regressions if contention)

**Why Not Done**: Complexity; ROI unclear (SAB copy already small vs. total frame time). Only worth it for dedicated MT tier.

**Next**: Measure SAB copy impact with instrumentation; only pursue if > 5% of MT frame time.

---

## Priority 6: Pre-Allocate chunkBufPtr (LOW-MEDIUM Impact, LOW Effort)

**Opportunity**: Pre-allocate `chunkBufPtr` at session start to expected file size, avoiding mid-stream realloc.

**Current Status**: Lazy allocation on first batch; grow-only if batches exceed capacity.

**Benefit**: 
- Eliminates realloc overhead if file size known upfront
- Reduces GC pressure (one alloc vs. multiple)

**Cost**:
- Baseline memory usage increases (pre-allocates even if file is small)
- Estimate: +100 KB to +4 MB per session depending on file size

**Impact**: 
- P99 latency ↓ (eliminate realloc pause)
- Baseline memory ↑ (trade-off)

**Effort**: Low
- Add optional `expectedBytes` parameter to session constructor
- Allocate upfront if provided
- Fallback to lazy alloc if not

**Why Not Done**: Trade-off not clearly beneficial for all workloads. Lazy alloc is better for small/variable-size files.

**Next**: No action needed; use only in low-latency applications that know file size upfront.

---

## Priority 7: Frame Batching Before IPC (LOW Impact, LOW Effort)

**Opportunity**: Batch multiple decoded frames before `postMessage` to reduce postMessage overhead.

**Current Status**: One frame per postMessage call.

**Benefit**: 
- Amortize postMessage overhead across multiple frames
- Reduce CPU wake-ups in main thread

**Cost**:
- Introduces latency (wait for batch)
- Adds buffering complexity

**Impact**: Negligible (postMessage overhead already amortized by frame size; 1–2% speedup at best)

**Effort**: Low (straightforward buffering)

**Why Not Done**: Marginal ROI; postMessage not a measured bottleneck.

**Next**: No action; deprioritize.

---

## Priority 8: readBufferView One-Shot Copy (Already Optimal)

**Opportunity**: (None — already optimal)

**Status**: One-shot decode uses `HEAPU8.slice()` to detach output from heap. This is correct and necessary.

**Why**: Frame output must be stable for consumer; WASM heap can grow. Slice is the right choice.

**Next**: No change.

---

## Summary Table

| Rank | Opportunity | Impact | Effort | Status | Blocker |
|------|-------------|--------|--------|--------|---------|
| 1 | Auto-select simd-mt tier | HIGH | Low | Deployment-dependent | COOP/COEP headers |
| 2 | Zero-copy pixel transfer (deferred release) | HIGH | Medium | Deferred | Proof via `take_frame_ms` probe |
| 3 | C++ region crop (progressive) | HIGH (region-only) | Medium | Deferred | Usage data (region % of workload) |
| 4 | WASM bilinear resize | MEDIUM | Medium | Deferred | Usage data (resize % of workload) |
| 5 | SAB ring-buffer (MT only) | HIGH (MT-only) | High | Deferred | Proof via SAB copy instrumentation |
| 6 | Pre-allocate chunkBufPtr | LOW-MEDIUM | Low | Optional | Depends on workload (low-latency?) |
| 7 | Frame batching before IPC | LOW | Low | Deprioritized | Negligible ROI |
| 8 | One-shot `.slice()` copy | — | — | Optimal | None |

---

## Next Steps

1. **Phase 4 (this plan)**: Add timing probes (`heap_set_ms`, `malloc_grow_ms`, `take_frame_ms`, `enc_heap_set_ms`, and optionally `region_crop_ms`, `target_resize_ms`).
2. **Phase 5**: Gather production telemetry on boundary costs (which probes fire? how often? how long?).
3. **Decision gates**: 
   - If `take_frame_ms` > 5% of frame time → pursue Rank #2 (deferred release)
   - If `region_crop_ms` > 10% and region decodes > 10% of workload → pursue Rank #3
   - If SAB copy > 5% of MT frame time → pursue Rank #5
   - Otherwise: Rank #1 (tier selection) is the only quick win requiring no code changes.
