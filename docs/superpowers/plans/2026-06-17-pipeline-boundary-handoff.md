# Pipeline Boundary Optimization — Implementation Handoff

**Date**: 2026-06-17  
**Completed**: 8 docs + 4 timing probes  
**Next**: Ranked implementation tasks  

---

## Phase Completed: Documentation & Instrumentation

✅ Static analysis (6 docs):
- `docs/Boundaries and Pipelines/pipeline-map.md` — decode/encode node graph
- `docs/Boundaries and Pipelines/buffer-lifecycle.md` — copy/transfer map
- `docs/Boundaries and Pipelines/allocation-report.md` — WASM allocations
- `docs/Boundaries and Pipelines/traversal-report.md` — hot buffer scans
- `docs/Boundaries and Pipelines/boundary-report.md` — JS↔WASM cost analysis
- `docs/Boundaries and Pipelines/optimization-index.md` — 8 ranked opportunities

✅ Timing instrumentation (2 docs + 4 probes):
- `docs/Boundaries and Pipelines/boundary-timings/decode-timing-probes.md`
- `docs/Boundaries and Pipelines/boundary-timings/encode-timing-probes.md`
- Probes: `malloc_grow_ms`, `heap_set_ms`, `take_frame_ms`, `enc_heap_set_ms` (facade.ts)

---

## Next Phase: Implementation Tasks

### Ready Now (No Data Blocking)

**Rank #6: Pre-allocate chunkBufPtr**
- **Impact**: LOW-MEDIUM (baseline memory ↑, first-batch latency ↓)
- **Effort**: LOW
- **Scope**: Add optional `expectedBytes` param to `LibjxlDecoder` constructor; allocate upfront if provided
- **Files**: `packages/jxl-wasm/src/facade.ts` (~20 lines)
- **Status**: Ready to implement
- **Agent**: LOW-effort; can dispatch simple implementation agent

**Rank #7: Frame Batching Before IPC**
- **Impact**: LOW (negligible ROI; postMessage not measured bottleneck)
- **Effort**: LOW
- **Scope**: Buffer multiple frames in worker; batch-send to main thread
- **Status**: Deprioritized (marginal ROI)
- **Agent**: Deploy if user wants; otherwise skip

---

### Waiting for Telemetry Data

**Rank #2: Zero-Copy Pixel Transfer (Deferred Release)**
- **Impact**: HIGH (eliminates 1 copy per frame)
- **Effort**: MEDIUM (lifetime API change)
- **Blocker**: Proof that `take_frame_ms` > 5% of frame time
- **When**: Run tests with new probes; collect metrics for 1–2 weeks
- **Action**: Revisit once telemetry shows frame copy is bottleneck

**Rank #3: C++ Region Crop (Progressive)**
- **Impact**: HIGH (for region queries; ~20–30% faster)
- **Effort**: MEDIUM (bridge.cpp change, libjxl capability query)
- **Blocker**: Usage data (region % of workload unknown)
- **When**: Instrument `region_crop_ms` (split from `prog_frame_prep_ms`); measure
- **Action**: If region_crop_ms > 10% AND region decodes > 10% of traffic → pursue

**Rank #4: WASM Bilinear Resize**
- **Impact**: MEDIUM (resize queries 10–30% faster)
- **Effort**: MEDIUM (new bridge function + WASM kernel)
- **Blocker**: Usage data (resize % of workload unknown)
- **When**: Instrument `target_resize_ms` (split from `prog_frame_prep_ms`); measure
- **Action**: If target_resize_ms > 10% AND resizes > 5% of traffic → pursue

**Rank #5: SAB Ring-Buffer (MT Tier)**
- **Impact**: HIGH (MT-only; 5–10% speedup if SAB copy is bottleneck)
- **Effort**: HIGH (complex state machine, threading coordination)
- **Blocker**: Proof that SAB copy > 5% of MT frame time
- **When**: Instrument SAB copy cost (per-tier metrics); measure on MT tier
- **Action**: Only pursue if MT-tier SAB copy is measured bottleneck

---

### Out of Scope

**Rank #1: Auto-Select simd-mt Tier**
- Deployment task (COOP/COEP headers)
- Not a code change; requires ops/infrastructure
- Action: Document in deployment guide (already done in optimization-index)

**Rank #8: One-Shot `.slice()` Copy**
- Already optimal; no change needed

---

## Implementation Priority

| Task | Ready? | Difficulty | Status |
|------|--------|-----------|--------|
| Rank #6 (pre-alloc chunkBufPtr) | ✅ Yes | LOW | ✅ **DONE** (2026-06-17) |
| Rank #7 (frame batching) | ✅ Yes | LOW | Deprioritized (LOW impact) |
| Rank #2 (zero-copy) | ⏳ Waiting | MEDIUM | Blocked: `take_frame_ms` data needed |
| Rank #3 (region crop) | ⏳ Waiting | MEDIUM | Blocked: `region_crop_ms` data needed |
| Rank #4 (WASM resize) | ⏳ Waiting | MEDIUM | Blocked: `target_resize_ms` data needed |
| Rank #5 (SAB ring-buffer) | ⏳ Waiting | HIGH | Blocked: SAB copy measurements needed |

---

## Recommended Next Steps

**Immediate** (today):
1. Deploy agent for Rank #6 (pre-allocate chunkBufPtr) — LOW effort, quick win
2. **Optional**: Deploy agent for Rank #7 (frame batching) — deprioritized; skip unless user wants

**Short-term** (1–2 weeks):
1. Deploy tests with new probes enabled
2. Collect metrics on `take_frame_ms`, `heap_set_ms`, `malloc_grow_ms`, `enc_heap_set_ms`
3. Measure region/resize activity (instrument optional probes if data needed)
4. Analyze telemetry; decide on Rank #2–5 based on measured impact

**Medium-term** (based on data):
1. If Rank #2 (zero-copy) justified → Plan + implement API redesign
2. If Rank #3 (region crop) justified → Plan + implement C++ bridge change
3. If Rank #4 (WASM resize) justified → Plan + implement WASM kernel
4. If Rank #5 (SAB) justified → Plan + implement ring-buffer state machine

---

## Files Affected (Rank #6)

Implementation scope for pre-allocate chunkBufPtr:

| File | Changes |
|------|---------|
| `packages/jxl-wasm/src/facade.ts` | Add optional `expectedBytes` to `DecoderOptions`; allocate in `eventsProgressive` constructor |
| `packages/jxl-wasm/src/index.ts` (if exported) | Update type exports for `DecoderOptions` |

**Estimated LOC**: ~20 additions (optional param + conditional alloc)

---

## Rank #6 Implementation — DONE

**Completed**: 2026-06-17

**Changes**:
- Added `expectedBytes?: number` field to `DecoderOptions` (line 131-132)
- Pre-allocation logic in `eventsProgressive` (lines 1390-1399):
  - Check if `expectedBytes` provided; if so, allocate upfront
  - Emit `malloc_prealloc_ms` metric for monitoring
  - Preserve fallback: lazy-alloc if param not provided
- Backward-compatible; zero breaking changes

**Impact**:
- First-batch latency reduced (skip malloc when file size known)
- Useful for low-latency applications; optional (no cost if unused)
- ~20 LOC added

**Next**: Rank #7 (frame batching) deprioritized. Remaining tasks (#2–5) waiting for telemetry.

---

## Path Forward: Telemetry-Driven Optimization

**Immediate** (done):
- ✅ 8 docs + 4 baseline probes (`malloc_grow_ms`, `heap_set_ms`, `take_frame_ms`, `enc_heap_set_ms`)
- ✅ Rank #6 pre-allocation implemented

**Short-term** (1–2 weeks):
1. Deploy with new probes enabled
2. Collect metrics on high-priority boundaries:
   - `take_frame_ms` — is frame detach/region/resize > 5% of frame time?
   - `heap_set_ms` — is input copy > 2 ms per batch?
   - `malloc_grow_ms` — does it fire frequently (> 1× per session)?
3. Optionally instrument `region_crop_ms`, `target_resize_ms` (split from `prog_frame_prep_ms`) if region/resize activity unclear

**Medium-term** (based on data):
- If `take_frame_ms` > 5% → Rank #2 (zero-copy, MEDIUM effort)
- If region crops > 10% of traffic AND `region_crop_ms` > 10% frame time → Rank #3 (C++ crop, MEDIUM effort)
- If resizes > 5% of traffic AND `target_resize_ms` > 10% frame time → Rank #4 (WASM resize, MEDIUM effort)
- If MT tier SAB copy > 5% of frame time → Rank #5 (ring-buffer, HIGH effort)

All remaining tasks require decision gates backed by production telemetry. Probes are in place; collect data first, prioritize second.
